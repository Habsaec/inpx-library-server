/**
 * KOReader sync (kosync): хранилище прогресса по хешу документа.
 * Протокол совместим с koreader-sync-server; роуты — src/routes/kosync.js.
 *
 * - Ключ: отдельный пароль KOReader (профиль), в БД только sha256(md5hex) — плагин KOReader
 *   шлёт md5 пароля, а пароль аккаунта хранится как scrypt и сверить с md5 нельзя.
 * - Документ: partial MD5 файла (алгоритм KOReader `util.partialMD5`). Соответствие «хеш → книга»
 *   запоминается при скачивании (/download/:id), потому что именно эти байты получает KOReader.
 */
import crypto from 'node:crypto';
import { db } from './db.js';
import { timingSafeStringEqual } from './auth.js';

const SAMPLE_SIZE = 1024;
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const KEY_LENGTH = 14;

/** KOReader: сэмплы по 1 КБ на смещениях 0, 1024<<2i (i = 0..10) — до первого смещения за концом файла. */
export function partialMd5(buffer) {
  const hash = crypto.createHash('md5');
  for (let i = -1; i <= 10; i++) {
    const offset = i < 0 ? 0 : SAMPLE_SIZE * 4 ** i;
    if (offset >= buffer.length) break;
    hash.update(buffer.subarray(offset, offset + SAMPLE_SIZE));
  }
  return hash.digest('hex');
}

function keyHashOf(md5Key) {
  return crypto.createHash('sha256').update(String(md5Key).toLowerCase()).digest('hex');
}

/** Новый пароль KOReader (старый перестаёт работать). Возвращает пароль в открытом виде — показать один раз. */
export function createKosyncPassword(username) {
  let password = '';
  for (let i = 0; i < KEY_LENGTH; i++) password += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  const md5 = crypto.createHash('md5').update(password).digest('hex');
  db.prepare(`
    INSERT INTO kosync_keys(username, key_hash) VALUES(?, ?)
    ON CONFLICT(username) DO UPDATE SET key_hash = excluded.key_hash, created_at = datetime('now')
  `).run(username, keyHashOf(md5));
  return password;
}

export function hasKosyncPassword(username) {
  return Boolean(db.prepare('SELECT 1 FROM kosync_keys WHERE username = ?').get(username));
}

export function revokeKosyncPassword(username) {
  return db.prepare('DELETE FROM kosync_keys WHERE username = ?').run(username).changes;
}

/** `md5Key` — значение заголовка x-auth-key (md5 пароля). */
export function verifyKosyncCredentials(username, md5Key) {
  const name = String(username || '').trim();
  const key = String(md5Key || '').trim();
  if (!name || !key) return false;
  const row = db.prepare(`
    SELECT k.key_hash AS keyHash, u.blocked AS blocked
    FROM kosync_keys k JOIN users u ON u.username = k.username
    WHERE k.username = ?
  `).get(name);
  if (!row || row.blocked) return false;
  return timingSafeStringEqual(row.keyHash, keyHashOf(key));
}

export function saveKosyncProgress(username, { document, progress, percentage, device, device_id: deviceId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const pct = Number.isFinite(Number(percentage)) ? Math.min(1, Math.max(0, Number(percentage))) : 0;
  db.prepare(`
    INSERT INTO kosync_progress(username, document, progress, percentage, device, device_id, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username, document) DO UPDATE SET
      progress = excluded.progress, percentage = excluded.percentage,
      device = excluded.device, device_id = excluded.device_id, updated_at = excluded.updated_at
  `).run(username, document, String(progress ?? '').slice(0, 2000), pct, String(device ?? '').slice(0, 120), String(deviceId ?? '').slice(0, 120), timestamp);
  return timestamp;
}

export function getKosyncProgress(username, document) {
  return db.prepare(`
    SELECT document, progress, percentage, device, device_id, updated_at AS timestamp
    FROM kosync_progress WHERE username = ? AND document = ?
  `).get(username, document) || null;
}

/** Книга, которой соответствует документ KOReader (файл скачан через сервер), или ''. */
export function getKosyncDocumentBookId(document) {
  const row = db.prepare('SELECT book_id AS bookId FROM kosync_documents WHERE document = ?').get(String(document || ''));
  return row?.bookId ? String(row.bookId) : '';
}

/**
 * Прогресс KOReader по книгам пользователя → Map(bookId → percent 0–100), максимум по документам.
 * Без `bookIds` — все книги с прогрессом (у одного пользователя их немного).
 */
export function getKosyncPercentMap(username, bookIds = null) {
  const out = new Map();
  const u = String(username || '').trim();
  if (!u) return out;
  const put = (row) => {
    const pct = Math.round((Number(row.pct) || 0) * 1000) / 10;
    if (pct > 0) out.set(String(row.id), pct);
  };
  if (!bookIds) {
    for (const row of db.prepare(`
      SELECT d.book_id AS id, MAX(p.percentage) AS pct
      FROM kosync_progress p JOIN kosync_documents d ON d.document = p.document
      WHERE p.username = ? GROUP BY d.book_id
    `).all(u)) put(row);
    return out;
  }
  const ids = [...new Set(bookIds.map((id) => String(id || '')).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    for (const row of db.prepare(`
      SELECT d.book_id AS id, MAX(p.percentage) AS pct
      FROM kosync_progress p JOIN kosync_documents d ON d.document = p.document
      WHERE p.username = ? AND d.book_id IN (${part.map(() => '?').join(',')}) GROUP BY d.book_id
    `).all(u, ...part)) put(row);
  }
  return out;
}

/** Запомнить, что файл с таким содержимым — это книга bookId (вызывать при выдаче файла пользователю). */
export function rememberKosyncDocument(bookId, buffer) {
  try {
    if (!bookId || !Buffer.isBuffer(buffer) || !buffer.length) return;
    db.prepare('INSERT OR IGNORE INTO kosync_documents(document, book_id) VALUES(?, ?)')
      .run(partialMd5(buffer), String(bookId));
  } catch { /* кэш соответствия не должен ломать скачивание */ }
}
