/**
 * Подборки (curated collections): готовые списки книг «автор + название» — школьная программа,
 * классика, фантастика… Встроенные лежат в `collections/*.json`, администратор может загрузить свои
 * (Админка → Контент → Подборки). Каждую позицию один раз сопоставляем с каталогом и храним book_id;
 * пересопоставление идёт в фоне после индексации (id книг меняются при переиндексации папок и
 * повторном добавлении источника), по одной позиции за тик event loop.
 *
 * Формат файла: { slug, title, description?, source?, url?, display_order?, items: [{ author, title, year?, note? }] }
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { createSortKey, getBooksByIds } from './inpx.js';
import { getUserHomeLayout, orderCollections } from './home-layout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.join(__dirname, '..', 'collections');

export const COLLECTION_ITEMS_MAX = 1000;
export const COLLECTION_IMPORT_MAX_BYTES = 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PREVIEW_COUNT = 4;
const REMATCH_DEBOUNCE_MS = 30_000;

let schemaReady = false;

function ensureSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      content_hash TEXT NOT NULL DEFAULT '',
      matched_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS collection_items (
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      year INTEGER,
      note TEXT NOT NULL DEFAULT '',
      book_id TEXT,
      PRIMARY KEY (collection_id, position)
    );
    CREATE TABLE IF NOT EXISTS collection_pins (
      username TEXT NOT NULL,
      collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      pinned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, collection_id)
    );
  `);
  schemaReady = true;
}

/* ---------- parsing / validation ---------- */

function cleanString(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanUrl(value) {
  const url = cleanString(value, 500);
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : '';
}

/**
 * Validates a collection object (bundled file or admin upload) → normalized object.
 * Throws Error with a `code` (`COLLECTION_INVALID`) and a human message.
 */
export function parseCollection(input) {
  const fail = (message) => Object.assign(new Error(message), { code: 'COLLECTION_INVALID' });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('ожидается JSON-объект подборки');
  const slug = cleanString(input.slug, 64).toLowerCase();
  if (!SLUG_RE.test(slug)) throw fail('slug: латиница, цифры и дефис, до 64 символов');
  const title = cleanString(input.title, 200);
  if (!title) throw fail('нет названия (title)');
  if (!Array.isArray(input.items) || !input.items.length) throw fail('нет списка книг (items)');
  if (input.items.length > COLLECTION_ITEMS_MAX) throw fail(`не больше ${COLLECTION_ITEMS_MAX} книг`);
  const items = [];
  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object') continue;
    const itemTitle = cleanString(raw.title, 300);
    if (!itemTitle) continue;
    const year = Math.floor(Number(raw.year));
    items.push({
      author: cleanString(raw.author, 300),
      title: itemTitle,
      year: year >= -3000 && year <= 2200 && year !== 0 ? year : null,
      note: cleanString(raw.note, 300)
    });
  }
  if (!items.length) throw fail('в items нет ни одной книги с названием');
  const order = Math.floor(Number(input.display_order ?? input.displayOrder));
  return {
    slug,
    title,
    description: cleanString(input.description, 2000),
    source: cleanString(input.source, 300),
    sourceUrl: cleanUrl(input.url ?? input.sourceUrl),
    displayOrder: Number.isFinite(order) ? Math.max(-1000, Math.min(1000, order)) : 100,
    items
  };
}

function contentHash(collection) {
  return crypto.createHash('sha256').update(JSON.stringify(collection)).digest('hex').slice(0, 16);
}

/* ---------- storage ---------- */

function writeCollection(collection, { builtin }) {
  const hash = contentHash(collection);
  const existing = db.prepare('SELECT id, builtin, content_hash AS hash FROM collections WHERE slug = ?').get(collection.slug);
  if (existing && Boolean(existing.builtin) !== Boolean(builtin)) {
    throw Object.assign(new Error(`slug «${collection.slug}» уже занят ${existing.builtin ? 'встроенной' : 'загруженной'} подборкой`), { code: 'COLLECTION_SLUG_TAKEN' });
  }
  if (existing && existing.hash === hash) return { id: existing.id, changed: false };
  const tx = db.transaction(() => {
    let id = existing?.id;
    if (id) {
      db.prepare(`UPDATE collections SET title = ?, description = ?, source = ?, source_url = ?, display_order = ?,
                    content_hash = ?, matched_at = NULL WHERE id = ?`)
        .run(collection.title, collection.description, collection.source, collection.sourceUrl, collection.displayOrder, hash, id);
      db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(id);
    } else {
      id = Number(db.prepare(`INSERT INTO collections (slug, title, description, source, source_url, display_order, builtin, content_hash)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(collection.slug, collection.title, collection.description, collection.source, collection.sourceUrl,
          collection.displayOrder, builtin ? 1 : 0, hash).lastInsertRowid);
    }
    const insert = db.prepare('INSERT INTO collection_items (collection_id, position, author, title, year, note) VALUES (?, ?, ?, ?, ?, ?)');
    collection.items.forEach((item, index) => insert.run(id, index + 1, item.author, item.title, item.year, item.note));
    return id;
  });
  return { id: tx(), changed: true };
}

/** Bundled `collections/*.json` → DB (new files added, changed files replaced; admin's on/off kept). */
export function syncBundledCollections() {
  ensureSchema();
  let files = [];
  try {
    files = fs.readdirSync(BUNDLED_DIR).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch {
    return 0;
  }
  let changed = 0;
  for (const file of files) {
    try {
      const parsed = parseCollection(JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, file), 'utf8')));
      if (writeCollection(parsed, { builtin: true }).changed) changed += 1;
    } catch (err) {
      console.warn(`[collections] ${file}: ${err.message}`);
    }
  }
  return changed;
}

/** Admin upload (JSON text). → { id, slug, items } */
export function importCollectionJson(text) {
  ensureSchema();
  if (Buffer.byteLength(String(text || ''), 'utf8') > COLLECTION_IMPORT_MAX_BYTES) {
    throw Object.assign(new Error('файл больше 1 МБ'), { code: 'COLLECTION_INVALID' });
  }
  let json;
  try {
    json = JSON.parse(String(text || '').replace(/^﻿/, ''));
  } catch {
    throw Object.assign(new Error('это не JSON'), { code: 'COLLECTION_INVALID' });
  }
  const parsed = parseCollection(json);
  const { id } = writeCollection(parsed, { builtin: false });
  scheduleCollectionsMatch({ immediate: true });
  return { id, slug: parsed.slug, items: parsed.items.length };
}

export function setCollectionEnabled(id, enabled) {
  ensureSchema();
  return db.prepare('UPDATE collections SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id)).changes > 0;
}

/** Only uploaded collections can be deleted (a bundled one would come back on restart — disable it instead). */
export function deleteCollection(id) {
  ensureSchema();
  return db.prepare('DELETE FROM collections WHERE id = ? AND builtin = 0').run(Number(id)).changes > 0;
}

/* ---------- reading ---------- */

function mapCollectionRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    source: row.source,
    sourceUrl: row.sourceUrl,
    builtin: Boolean(row.builtin),
    enabled: Boolean(row.enabled),
    total: Number(row.total) || 0,
    found: Number(row.found) || 0,
    matching: !row.matchedAt
  };
}

/**
 * All collections with counts. `found` = items whose matched book is visible now (active_books).
 * → [{ id, slug, title, description, source, sourceUrl, builtin, enabled, total, found, matching, previewBookIds }]
 */
export function listCollections({ includeDisabled = false, username = '' } = {}) {
  ensureSchema();
  const pinned = username ? pinnedCollectionIds(username) : null;
  const rows = db.prepare(`
    SELECT c.id, c.slug, c.title, c.description, c.source, c.source_url AS sourceUrl, c.builtin, c.enabled,
           c.matched_at AS matchedAt,
           (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) AS total,
           /* EXISTS per item, not LEFT JOIN active_books: a LEFT JOIN on that view materialized the whole
              catalog (1.5 s on every /api/collections call). */
           (SELECT COUNT(*) FROM collection_items ci2 WHERE ci2.collection_id = c.id
              AND EXISTS (SELECT 1 FROM active_books ab WHERE ab.id = ci2.book_id)) AS found
    FROM collections c
    ${includeDisabled ? '' : 'WHERE c.enabled = 1'}
    ORDER BY c.display_order ASC, c.title COLLATE NOCASE ASC
  `).all();
  const previewStmt = db.prepare(`
    SELECT ci.book_id AS id FROM collection_items ci
    JOIN active_books ab ON ab.id = ci.book_id
    WHERE ci.collection_id = ?
    ORDER BY ci.position LIMIT ${PREVIEW_COUNT}
  `);
  const list = rows.map((row) => ({
    ...mapCollectionRow(row),
    previewBookIds: previewStmt.all(row.id).map((r) => r.id),
    ...(pinned ? { onHome: pinned.has(row.id) ? 1 : 0 } : {})
  }));
  // The user's drag order (homeLayout.collectionOrder), like shelves.
  return username ? orderCollections(list, getUserHomeLayout(username).collectionOrder) : list;
}

/* ---------- pinned to the home page (per user, like shelves' on_home) ---------- */

function pinnedCollectionIds(username) {
  return new Set(db.prepare('SELECT collection_id AS id FROM collection_pins WHERE username = ?').all(username).map((r) => r.id));
}

/** → 1|0, or null when the collection does not exist / is turned off. */
export function setCollectionOnHome(username, slug, on) {
  ensureSchema();
  const key = String(slug || '').trim().toLowerCase();
  const row = SLUG_RE.test(key) ? db.prepare('SELECT id FROM collections WHERE slug = ? AND enabled = 1').get(key) : null;
  if (!row || !username) return null;
  if (on) db.prepare('INSERT OR IGNORE INTO collection_pins (username, collection_id) VALUES (?, ?)').run(username, row.id);
  else db.prepare('DELETE FROM collection_pins WHERE username = ? AND collection_id = ?').run(username, row.id);
  return on ? 1 : 0;
}

/** Enabled collections the user pinned, in the user's collection order (then pin order): [{ id, slug, title }]. */
export function listPinnedCollections(username) {
  ensureSchema();
  if (!username) return [];
  return orderCollections(db.prepare(`
    SELECT c.id, c.slug, c.title FROM collection_pins p
    JOIN collections c ON c.id = p.collection_id AND c.enabled = 1
    WHERE p.username = ?
    ORDER BY p.pinned_at, c.display_order
  `).all(username), getUserHomeLayout(username).collectionOrder);
}

/** First `limit` books of a collection the library has, in list order (home shelf preview). */
export function getCollectionBooks(collectionId, limit = 24) {
  ensureSchema();
  const ids = db.prepare(`
    SELECT ci.book_id AS id FROM collection_items ci
    JOIN active_books ab ON ab.id = ci.book_id
    WHERE ci.collection_id = ?
    ORDER BY ci.position LIMIT ?
  `).all(Number(collectionId), Math.max(1, Math.min(200, Number(limit) || 24))).map((r) => r.id);
  const unique = [...new Set(ids)];
  const books = unique.length ? getBooksByIds(unique) : new Map();
  return unique.map((id) => books.get(id)).filter(Boolean);
}

/**
 * One collection with its items in list order; `book` is the catalog book (list shape) or null
 * when the library does not have it. `read` (with username) = found books the user marked read.
 */
export function getCollection(slug, { username = '', includeDisabled = false } = {}) {
  ensureSchema();
  const key = String(slug || '').trim().toLowerCase();
  if (!SLUG_RE.test(key)) return null;
  const row = listCollections({ includeDisabled, username }).find((c) => c.slug === key);
  if (!row) return null;
  const items = db.prepare(`
    SELECT position, author, title, year, note, book_id AS bookId
    FROM collection_items WHERE collection_id = ? ORDER BY position
  `).all(row.id);
  const ids = [...new Set(items.map((i) => i.bookId).filter(Boolean))];
  const books = ids.length ? getBooksByIds(ids) : new Map();
  let readSet = new Set();
  if (username && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    readSet = new Set(db.prepare(`SELECT book_id AS id FROM read_books WHERE username = ? AND book_id IN (${placeholders})`)
      .all(username, ...ids).map((r) => r.id));
  }
  const mapped = items.map((item) => {
    const book = item.bookId ? books.get(item.bookId) || null : null;
    return {
      position: item.position,
      author: item.author,
      title: item.title,
      year: item.year ?? null,
      note: item.note,
      book,
      read: Boolean(book && readSet.has(book.id))
    };
  });
  const { previewBookIds, ...rest } = row;
  return { ...rest, found: mapped.filter((i) => i.book).length, read: mapped.filter((i) => i.read).length, items: mapped };
}

/* ---------- matching ---------- */

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** «Мастер и Маргарита (роман)» / «Дюна: роман» → the main title. */
function cleanTitle(title) {
  return String(title || '').replace(/\s*[([][^)\]]*[)\]]\s*/g, ' ').replace(/\s*:.*$/, '').trim();
}

/** Surname-ish words of the list author: «Аркадий и Борис Стругацкие», «Ильф, Петров», «Дж. Р. Р. Толкин». */
function authorKeys(author) {
  return looseName(String(author || '').replace(/\s+(?:и|and|&)\s+/gi, ' '))
    .split(' ')
    .filter((w) => w.length >= 2)
    .map((w) => w.slice(0, 5));
}

/** Transliteration variants of one name: Герберт / Херберт, Гюго / Хьюго. */
function looseName(value) {
  return normalizeText(value).replace(/х/g, 'г');
}

/**
 * Surname words of the book authors: INPX keeps `Фамилия,Имя,Отчество:` — only the part before the
 * first comma counts, otherwise «Владимир Набоков» matched «Логинов Святослав Владимирович».
 * An author without commas (folder sources) contributes every word.
 */
function bookSurnameWords(bookAuthors) {
  const words = [];
  for (const author of String(bookAuthors || '').split(':')) {
    const surname = author.includes(',') ? author.slice(0, author.indexOf(',')) : author;
    for (const w of looseName(surname).split(' ')) if (w.length >= 2) words.push(w);
  }
  return words;
}

/** Match when a list-author word shares a 5-letter stem with a surname (Толкин / Толкиен, Стругацкие / Стругацкий). */
function authorMatches(keys, bookAuthors) {
  if (!keys.length) return true;
  const words = bookSurnameWords(bookAuthors);
  // A short word (Ли, По, Ильф) must be the whole surname, a longer one is compared by its 5-letter stem.
  return keys.some((key) => words.some((w) => (key.length >= 5 ? w.startsWith(key) : w === key)));
}

let _stmtTitlePrefix;

/**
 * Books whose `title_search` (createSortKey of the title + stems, indexed) starts with the key:
 * one index range, ~20 ms on 700k books. searchBooks (FTS ranking, ~1 s a call) would stall the
 * event loop for minutes over a few hundred list items.
 */
function findTitleCandidates(cleanedTitle) {
  const key = createSortKey(cleanedTitle);
  if (!key) return [];
  if (!_stmtTitlePrefix) {
    _stmtTitlePrefix = db.prepare(`
      SELECT id, title, authors, lang, lib_rate AS libRate, ext
      FROM active_books
      WHERE title_search >= ? AND title_search < ?
      LIMIT 300
    `);
  }
  return _stmtTitlePrefix.all(key, `${key}￿`);
}

/** The list title is cleaned («Дюна: роман» → «Дюна»), the book title is not: «Мастер и Маргарита»: статья ≠ the novel. */
function titleMatchKind(wanted, bookTitle) {
  const got = normalizeText(bookTitle);
  if (got === wanted || normalizeText(cleanTitle(bookTitle)) === wanted) return 'exact';
  return got.startsWith(`${wanted} `) ? 'prefix' : '';
}

/**
 * Best catalog book for a list item, or null. Title must match (exact or as a word-wise prefix),
 * the author must share a surname stem; an exact title wins, then a book in the list's script
 * (Cyrillic list → Russian edition), then the library rating, then FB2, then the shorter title.
 */
export function matchCollectionItem(author, title) {
  const cleaned = cleanTitle(title);
  const wanted = normalizeText(cleaned);
  if (!wanted) return null;
  let rows = [];
  try {
    rows = findTitleCandidates(cleaned);
  } catch {
    return null;
  }
  const keys = authorKeys(author);
  const pool = rows
    .map((book) => ({ book, kind: titleMatchKind(wanted, book.title) }))
    .filter(({ book, kind }) => kind && authorMatches(keys, book.authors));
  if (!pool.length) return null;
  const cyrillic = /[а-я]/i.test(cleaned);
  const score = ({ book, kind }) =>
    (kind === 'exact' ? 1000 : 0)
    + (cyrillic && /^(ru|rus)$/i.test(String(book.lang || '').trim()) ? 100 : 0)
    + (Number(book.libRate) || 0) * 10
    + (String(book.ext || '').toLowerCase() === 'fb2' ? 1 : 0)
    - Math.min(0.9, String(book.title || '').length / 1000);
  return pool.reduce((best, entry) => (score(entry) > score(best) ? entry : best), pool[0]).book;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
let matchRunning = null;
let matchAgain = false;
let matchTimer = null;

/** Re-match every item (or only collections that were never matched). Single-flight, yields per item. */
async function runCollectionsMatch({ onlyUnmatched = false } = {}) {
  ensureSchema();
  const collections = db.prepare(`SELECT id FROM collections ${onlyUnmatched ? 'WHERE matched_at IS NULL' : ''} ORDER BY display_order`).all();
  const update = db.prepare('UPDATE collection_items SET book_id = ? WHERE collection_id = ? AND position = ?');
  const done = db.prepare('UPDATE collections SET matched_at = CURRENT_TIMESTAMP WHERE id = ?');
  for (const { id } of collections) {
    const items = db.prepare('SELECT position, author, title FROM collection_items WHERE collection_id = ? ORDER BY position').all(id);
    for (const item of items) {
      await tick();
      const book = matchCollectionItem(item.author, item.title);
      try { update.run(book?.id || null, id, item.position); } catch { /* collection deleted meanwhile */ }
    }
    done.run(id);
  }
}

export function matchCollectionsNow({ onlyUnmatched = false } = {}) {
  if (matchRunning) {
    if (!onlyUnmatched) matchAgain = true;
    return matchRunning;
  }
  matchRunning = runCollectionsMatch({ onlyUnmatched })
    .catch((err) => console.warn('[collections] match failed:', err.message))
    .finally(() => {
      matchRunning = null;
      if (matchAgain) {
        matchAgain = false;
        matchCollectionsNow();
      }
    });
  return matchRunning;
}

/** Debounced background re-match (after indexing); `immediate` = only collections not matched yet. */
export function scheduleCollectionsMatch({ immediate = false } = {}) {
  if (cluster.isWorker && cluster.worker.id !== 1) return;
  if (immediate) {
    matchCollectionsNow({ onlyUnmatched: true });
    return;
  }
  if (matchTimer) clearTimeout(matchTimer);
  matchTimer = setTimeout(() => {
    matchTimer = null;
    matchCollectionsNow();
  }, REMATCH_DEBOUNCE_MS);
  matchTimer.unref?.();
}

export function isCollectionsMatchRunning() {
  return Boolean(matchRunning);
}

/** Boot: bundled files → DB, then match what was never matched (first start, new / changed lists). */
export function initCollections() {
  try {
    syncBundledCollections();
  } catch (err) {
    console.warn('[collections] init failed:', err.message);
    return;
  }
  setTimeout(() => scheduleCollectionsMatch({ immediate: true }), 5000).unref?.();
}
