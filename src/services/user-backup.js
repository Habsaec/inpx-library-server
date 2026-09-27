/**
 * Export / import local accounts for a clean reinstall.
 * Favorites are stored by catalog name (not author/series id — those change on reindex).
 * Existing usernames are never overwritten (password, role, blocked stay as-is).
 */
import crypto from 'node:crypto';
import {
  db,
  getUserByUsername,
  getUserByTelegramId,
  getUserByEmail,
  getUserByEreaderEmail,
  getEreaderEmail,
  normalizeTelegramId,
  setUserTelegramId,
  setUserEreaderEmail
} from '../db.js';
import { hashPassword } from '../auth.js';
import { normalizeLookupEmail } from '../utils/email-address.js';

export const USER_BACKUP_VERSION = 1;
const SCRYPT_HASH_RE = /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i;
const USERNAME_RE = /^[a-zA-Z0-9_.-]+$/;

let _stmtExportUsers = null;
let _stmtExportFavAuthors = null;
let _stmtExportFavSeries = null;
let _stmtAuthorByName = null;
let _stmtAuthorByDisplay = null;
let _stmtSeriesByName = null;
let _stmtSeriesByDisplay = null;
let _stmtInsertUser = null;
let _stmtInsertFavAuthor = null;
let _stmtInsertFavSeries = null;
let _stmtFillEmail = null;

function ensureStmts() {
  _stmtExportUsers ??= db.prepare(`
    SELECT username, password_hash AS passwordHash, role, created_at AS createdAt,
      COALESCE(blocked, 0) AS blocked,
      telegram_id AS telegramId,
      telegram_linked_at AS telegramLinkedAt,
      COALESCE(telegram_bot_allowed, 1) AS telegramBotAllowed,
      COALESCE(ereader_email_allowed, 1) AS ereaderEmailAllowed,
      COALESCE(ereader_email, '') AS ereaderEmail,
      COALESCE(email, '') AS email,
      COALESCE(has_local_password, 1) AS hasLocalPassword
    FROM users
    ORDER BY username COLLATE NOCASE
  `);
  _stmtExportFavAuthors ??= db.prepare(`
    SELECT a.name AS name
    FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    WHERE fa.username = ?
    ORDER BY a.name COLLATE NOCASE
  `);
  _stmtExportFavSeries ??= db.prepare(`
    SELECT s.name AS name
    FROM favorite_series fs
    JOIN series_catalog s ON s.id = fs.series_id
    WHERE fs.username = ?
    ORDER BY s.name COLLATE NOCASE
  `);
  _stmtAuthorByName ??= db.prepare('SELECT id FROM authors WHERE name = ? COLLATE NOCASE LIMIT 1');
  _stmtAuthorByDisplay ??= db.prepare('SELECT id FROM authors WHERE display_name = ? COLLATE NOCASE LIMIT 1');
  _stmtSeriesByName ??= db.prepare('SELECT id FROM series_catalog WHERE name = ? COLLATE NOCASE LIMIT 1');
  _stmtSeriesByDisplay ??= db.prepare('SELECT id FROM series_catalog WHERE display_name = ? COLLATE NOCASE LIMIT 1');
  _stmtInsertUser ??= db.prepare(`
    INSERT INTO users(
      username, password_hash, role, created_at, email, has_local_password,
      telegram_id, telegram_linked_at, telegram_bot_allowed,
      ereader_email, ereader_email_allowed, blocked
    ) VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  _stmtInsertFavAuthor ??= db.prepare('INSERT OR IGNORE INTO favorite_authors(username, author_id) VALUES(?, ?)');
  _stmtInsertFavSeries ??= db.prepare('INSERT OR IGNORE INTO favorite_series(username, series_id) VALUES(?, ?)');
  _stmtFillEmail ??= db.prepare('UPDATE users SET email = ? WHERE username = ?');
}

function uniqueNames(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function findAuthorId(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  return _stmtAuthorByName.get(raw)?.id || _stmtAuthorByDisplay.get(raw)?.id || null;
}

function findSeriesId(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  return _stmtSeriesByName.get(raw)?.id || _stmtSeriesByDisplay.get(raw)?.id || null;
}

function restoreFavorites(username, authors, series) {
  let added = 0;
  for (const name of uniqueNames(authors)) {
    const id = findAuthorId(name);
    if (!id) continue;
    const info = _stmtInsertFavAuthor.run(username, id);
    if (info.changes) added += 1;
  }
  for (const name of uniqueNames(series)) {
    const id = findSeriesId(name);
    if (!id) continue;
    const info = _stmtInsertFavSeries.run(username, id);
    if (info.changes) added += 1;
  }
  return added;
}

function dummyUnusableHash() {
  return hashPassword(`${crypto.randomBytes(32).toString('base64url')}Aa1!`);
}

export function exportUsersBackup() {
  ensureStmts();
  const users = _stmtExportUsers.all().map((row) => ({
    username: row.username,
    passwordHash: row.passwordHash || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    createdAt: row.createdAt || '',
    blocked: Number(row.blocked) ? 1 : 0,
    telegramId: row.telegramId || '',
    telegramLinkedAt: row.telegramLinkedAt || '',
    telegramBotAllowed: Number(row.telegramBotAllowed) ? 1 : 0,
    ereaderEmail: row.ereaderEmail || '',
    ereaderEmailAllowed: Number(row.ereaderEmailAllowed) ? 1 : 0,
    email: row.email || '',
    hasLocalPassword: Number(row.hasLocalPassword) ? 1 : 0,
    favoriteAuthors: _stmtExportFavAuthors.all(row.username).map((item) => item.name).filter(Boolean),
    favoriteSeries: _stmtExportFavSeries.all(row.username).map((item) => item.name).filter(Boolean)
  }));
  return {
    version: USER_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    users
  };
}

function parseUsersPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.users)) return payload.users;
  return null;
}

function isValidUsername(username) {
  return Boolean(username) && username.length <= 50 && USERNAME_RE.test(username);
}

function tryFillTelegram(username, telegramId, telegramLinkedAt = '') {
  const normalized = normalizeTelegramId(telegramId);
  if (!normalized) return false;
  const owner = getUserByTelegramId(normalized);
  if (owner && owner.username !== username) return false;
  try {
    setUserTelegramId(username, normalized);
    const linkedAt = String(telegramLinkedAt || '').trim();
    if (linkedAt) {
      db.prepare('UPDATE users SET telegram_linked_at = ? WHERE username = ?').run(linkedAt, username);
    }
    return true;
  } catch {
    return false;
  }
}

function tryFillEmail(username, email) {
  const normalized = normalizeLookupEmail(email);
  if (!normalized) return false;
  const owner = getUserByEmail(normalized);
  if (owner && owner.username !== username) return false;
  _stmtFillEmail.run(normalized, username);
  return true;
}

function tryFillEreaderEmail(username, email) {
  const trimmed = String(email || '').trim();
  if (!trimmed) return false;
  const owner = getUserByEreaderEmail(trimmed);
  if (owner && owner.username !== username) return false;
  try {
    setUserEreaderEmail(username, trimmed);
    return true;
  } catch {
    return false;
  }
}

function insertImportedUser(entry) {
  const username = String(entry.username || '').trim();
  const role = entry.role === 'admin' ? 'admin' : 'user';
  const rawHash = String(entry.passwordHash || '');
  const hashOk = SCRYPT_HASH_RE.test(rawHash);
  const hash = hashOk ? rawHash : dummyUnusableHash();
  const hasLocalPassword = hashOk && Number(entry.hasLocalPassword) !== 0 ? 1 : 0;
  const email = normalizeLookupEmail(entry.email) || '';
  const emailOwner = email ? getUserByEmail(email) : null;
  const emailToStore = email && (!emailOwner || emailOwner.username === username) ? email : '';
  const telegramId = normalizeTelegramId(entry.telegramId);
  const telegramOwner = telegramId ? getUserByTelegramId(telegramId) : null;
  const telegramToStore = telegramId && (!telegramOwner || telegramOwner.username === username)
    ? telegramId
    : null;
  let ereader = String(entry.ereaderEmail || '').trim();
  if (ereader) {
    const owner = getUserByEreaderEmail(ereader);
    if (owner && owner.username !== username) ereader = '';
  }
  const createdAt = String(entry.createdAt || '').trim() || null;
  _stmtInsertUser.run(
    username,
    hash,
    role,
    createdAt,
    emailToStore,
    hasLocalPassword,
    telegramToStore,
    telegramToStore ? (String(entry.telegramLinkedAt || '').trim() || null) : null,
    Number(entry.telegramBotAllowed) === 0 ? 0 : 1,
    ereader,
    Number(entry.ereaderEmailAllowed) === 0 ? 0 : 1,
    Number(entry.blocked) ? 1 : 0
  );
}

export function importUsersBackup(payload) {
  ensureStmts();
  const rows = parseUsersPayload(payload);
  if (!rows) {
    const err = new Error('Invalid users backup');
    err.code = 'INVALID_BACKUP';
    throw err;
  }

  const summary = { created: 0, skipped: 0, favorites: 0, invalid: 0 };

  const run = db.transaction(() => {
    for (const entry of rows) {
      if (!entry || typeof entry !== 'object') {
        summary.invalid += 1;
        continue;
      }
      const username = String(entry.username || '').trim();
      if (!isValidUsername(username)) {
        summary.invalid += 1;
        continue;
      }

      const existing = getUserByUsername(username);
      if (existing) {
        summary.skipped += 1;
        if (!String(existing.email || '').trim()) tryFillEmail(username, entry.email);
        if (!String(existing.telegramId || '').trim()) {
          tryFillTelegram(username, entry.telegramId, entry.telegramLinkedAt);
        }
        if (!String(getEreaderEmail(username) || '').trim()) {
          tryFillEreaderEmail(username, entry.ereaderEmail);
        }
        summary.favorites += restoreFavorites(username, entry.favoriteAuthors, entry.favoriteSeries);
        continue;
      }

      insertImportedUser(entry);
      summary.created += 1;
      summary.favorites += restoreFavorites(username, entry.favoriteAuthors, entry.favoriteSeries);
    }
  });

  run();
  return summary;
}
