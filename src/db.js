import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { appendIndexDiaryLine } from './services/file-log.js';
import { hashPassword } from './auth.js';

function deriveEncKey() {
  return crypto.scryptSync(config.sessionSecret, 'smtp-enc-salt', 32);
}

export function encryptValue(plaintext) {
  if (!plaintext) return '';
  const key = deriveEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

export function decryptValue(stored) {
  if (!stored || !stored.includes(':')) return stored;
  const parts = stored.split(':');
  if (parts.length !== 3) return stored;
  try {
    const [ivHex, tagHex, encHex] = parts;
    const key = deriveEncKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
  } catch {
    console.warn('[WARN] Failed to decrypt a stored value — session secret may have changed. Re-enter the value in admin panel.');
    return '';
  }
}

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('wal_autocheckpoint = 1000');
db.pragma('cache_size = -65536');      // 64 MB page cache (default is 2 MB)
db.pragma('mmap_size = 268435456');     // 256 MB memory-mapped I/O
db.pragma('temp_store = MEMORY');       // temp tables in RAM

// Force WAL checkpoint on startup to clear stale locks from crashed processes
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore if locked briefly */ }

function ensureUsersSchema() {
  const columns = db.prepare(`PRAGMA table_info(users)`).all();
  const hasPasswordHash = columns.some((column) => column.name === 'password_hash');
  const hasRole = columns.some((column) => column.name === 'role');

  if (!hasPasswordHash) {
    db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
  }

  if (!hasRole) {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  }

  const hasEreaderEmail = columns.some((column) => column.name === 'ereader_email');
  if (!hasEreaderEmail) {
    db.exec(`ALTER TABLE users ADD COLUMN ereader_email TEXT DEFAULT ''`);
  }

  const hasSessionGen = columns.some((column) => column.name === 'session_gen');
  if (!hasSessionGen) {
    db.exec(`ALTER TABLE users ADD COLUMN session_gen INTEGER NOT NULL DEFAULT 0`);
  }

  const hasBlocked = columns.some((column) => column.name === 'blocked');
  if (!hasBlocked) {
    db.exec(`ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`);
  }
}

function ensureBooksSchema() {
  const columns = db.prepare(`PRAGMA table_info(books)`).all();
  const initialColumnNames = new Set(columns.map((column) => column.name));

  if (!initialColumnNames.has('title_sort')) {
    db.exec(`ALTER TABLE books ADD COLUMN title_sort TEXT`);
  }

  if (!initialColumnNames.has('author_sort')) {
    db.exec(`ALTER TABLE books ADD COLUMN author_sort TEXT`);
  }

  if (!initialColumnNames.has('series_sort')) {
    db.exec(`ALTER TABLE books ADD COLUMN series_sort TEXT`);
  }

  if (!initialColumnNames.has('series_index')) {
    db.exec(`ALTER TABLE books ADD COLUMN series_index INTEGER DEFAULT 0`);
  }

  if (!initialColumnNames.has('title_search')) {
    db.exec(`ALTER TABLE books ADD COLUMN title_search TEXT`);
  }

  if (!initialColumnNames.has('authors_search')) {
    db.exec(`ALTER TABLE books ADD COLUMN authors_search TEXT`);
  }

  if (!initialColumnNames.has('series_search')) {
    db.exec(`ALTER TABLE books ADD COLUMN series_search TEXT`);
  }

  if (!initialColumnNames.has('genres_search')) {
    db.exec(`ALTER TABLE books ADD COLUMN genres_search TEXT`);
  }

  if (!initialColumnNames.has('keywords_search')) {
    db.exec(`ALTER TABLE books ADD COLUMN keywords_search TEXT`);
  }

  if (!initialColumnNames.has('imported_at')) {
    db.exec(`ALTER TABLE books ADD COLUMN imported_at TEXT`);
  }

  if (!initialColumnNames.has('source_id')) {
    db.exec(`ALTER TABLE books ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE`);
  }

  const detailsCols = db.prepare(`PRAGMA table_info(book_details_cache)`).all();
  const detailsNames = new Set(detailsCols.map((c) => c.name));
  if (!detailsNames.has('annotation_is_html')) {
    db.exec(`ALTER TABLE book_details_cache ADD COLUMN annotation_is_html INTEGER NOT NULL DEFAULT 0`);
  }

  const backfillManagedColumns = [
    'title_sort',
    'author_sort',
    'series_sort',
    'series_index',
    'title_search',
    'authors_search',
    'series_search',
    'genres_search',
    'keywords_search',
    'imported_at'
  ];
  const addedManagedColumn = backfillManagedColumns.some((c) => !initialColumnNames.has(c));
  const nullProbeSql = `
    SELECT 1 FROM books WHERE
      title_sort IS NULL OR author_sort IS NULL OR series_sort IS NULL OR series_index IS NULL OR
      title_search IS NULL OR authors_search IS NULL OR series_search IS NULL OR
      genres_search IS NULL OR keywords_search IS NULL OR imported_at IS NULL
    LIMIT 1
  `;
  const hasNulls = Boolean(db.prepare(nullProbeSql).get());

  if (addedManagedColumn || hasNulls) {
    db.exec(`
      UPDATE books SET
        title_sort = COALESCE(title_sort, ''),
        author_sort = COALESCE(author_sort, ''),
        series_sort = COALESCE(series_sort, ''),
        series_index = COALESCE(series_index, 0),
        title_search = COALESCE(title_search, ''),
        authors_search = COALESCE(authors_search, ''),
        series_search = COALESCE(series_search, ''),
        genres_search = COALESCE(genres_search, ''),
        keywords_search = COALESCE(keywords_search, ''),
        imported_at = COALESCE(imported_at, created_at, CURRENT_TIMESTAMP)
      WHERE
        title_sort IS NULL OR author_sort IS NULL OR series_sort IS NULL OR series_index IS NULL OR
        title_search IS NULL OR authors_search IS NULL OR series_search IS NULL OR
        genres_search IS NULL OR keywords_search IS NULL OR imported_at IS NULL
    `);
  }
}

function migrateBookReviewsLazySchema() {
  if (!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='book_reviews'`).get()) {
    return;
  }
  const cols = db.prepare(`PRAGMA table_info(book_reviews)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (names.has('review_shard')) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE book_reviews_new (
        book_id TEXT PRIMARY KEY,
        source_id INTEGER,
        body TEXT,
        review_shard TEXT,
        entry_key TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT INTO book_reviews_new (book_id, source_id, body, review_shard, entry_key, updated_at)
      SELECT book_id, source_id, body, NULL, NULL, updated_at FROM book_reviews;
    `);
    db.exec(`DROP TABLE book_reviews`);
    db.exec(`ALTER TABLE book_reviews_new RENAME TO book_reviews`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_book_reviews_source_id ON book_reviews(source_id);`);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureFlibustaSidecarSchema() {
  const srcCols = db.prepare(`PRAGMA table_info(sources)`).all();
  if (!srcCols.some((c) => c.name === 'flibusta_sidecar')) {
    db.exec(`ALTER TABLE sources ADD COLUMN flibusta_sidecar INTEGER NOT NULL DEFAULT 0`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_reviews (
      book_id TEXT PRIMARY KEY,
      source_id INTEGER,
      body TEXT,
      review_shard TEXT,
      entry_key TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_book_reviews_source_id ON book_reviews(source_id);

    CREATE TABLE IF NOT EXISTS flibusta_author_shard (
      author_key TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      shard_name TEXT NOT NULL,
      entry_path TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (author_key, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_flibusta_author_shard_source ON flibusta_author_shard(source_id);

    CREATE TABLE IF NOT EXISTS flibusta_author_portrait (
      author_key TEXT PRIMARY KEY,
      zip_name TEXT NOT NULL,
      entry_path TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  migrateBookReviewsLazySchema();

  const tbl = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='flibusta_author_bio'`).get();
  if (tbl) {
    db.exec('DROP TABLE flibusta_author_bio');
  }
}

const ALLOWED_CATALOG_TABLES = new Set(['authors', 'series_catalog', 'genres_catalog']);

function ensureCatalogSchema(tableName) {
  if (!ALLOWED_CATALOG_TABLES.has(tableName)) {
    throw new Error(`Invalid catalog table: ${tableName}`);
  }
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('display_name')) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN display_name TEXT`);
  }

  if (!columnNames.has('sort_name')) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN sort_name TEXT`);
  }

  if (!columnNames.has('search_name')) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN search_name TEXT`);
  }

  const needsBackfill = !columnNames.has('display_name') || !columnNames.has('sort_name') || !columnNames.has('search_name');
  if (needsBackfill) {
    db.exec(`UPDATE ${tableName} SET display_name = COALESCE(display_name, name) WHERE display_name IS NULL`);
    db.exec(`UPDATE ${tableName} SET sort_name = COALESCE(sort_name, LOWER(name)) WHERE sort_name IS NULL`);
    db.exec(`UPDATE ${tableName} SET search_name = COALESCE(search_name, LOWER(name)) WHERE search_name IS NULL`);
  }
}

function seedDefaultAdmin() {
  const DEFAULT_ADMIN_USERNAME = 'admin';
  const DEFAULT_ADMIN_PASSWORD = 'admin';

  const adminCount = db.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'`).get().cnt;
  if (adminCount > 0) {
    return;
  }

  const existing = db.prepare(`SELECT username, password_hash AS passwordHash, role FROM users WHERE username = ?`).get(DEFAULT_ADMIN_USERNAME);
  if (!existing) {
    db.prepare(`
      INSERT INTO users(username, password_hash, role)
      VALUES(?, ?, 'admin')
    `).run(DEFAULT_ADMIN_USERNAME, hashPassword(DEFAULT_ADMIN_PASSWORD));
    console.log(`[init] Admin user created: ${DEFAULT_ADMIN_USERNAME} / ${DEFAULT_ADMIN_PASSWORD}`);
    console.warn('[security] WARNING: Смените пароль admin в профиле после первого входа.');
    return;
  }

  if (!existing.passwordHash) {
    db.prepare(`
      UPDATE users
      SET password_hash = ?, role = 'admin'
      WHERE username = ?
    `).run(hashPassword(DEFAULT_ADMIN_PASSWORD), DEFAULT_ADMIN_USERNAME);
    console.log(`[init] Admin password reset to default.`);
    return;
  }

  if (existing.role !== 'admin') {
    db.prepare(`UPDATE users SET role = 'admin' WHERE username = ?`).run(DEFAULT_ADMIN_USERNAME);
  }
}

export function getUserByUsername(username) {
  return db.prepare(`
    SELECT username, password_hash AS passwordHash, role, created_at AS createdAt,
           COALESCE(session_gen, 0) AS sessionGen, COALESCE(blocked, 0) AS blocked
    FROM users
    WHERE username = ?
  `).get(username);
}

export function listUsers() {
  return db.prepare(`
    SELECT u.username, u.role, u.created_at AS createdAt,
      COALESCE(u.blocked, 0) AS blocked,
      (SELECT COUNT(*) FROM reading_history rh WHERE rh.username = u.username) AS readingCount,
      (SELECT MAX(rh.last_opened_at) FROM reading_history rh WHERE rh.username = u.username) AS lastReadAt
    FROM users u
    ORDER BY role DESC, username ASC
  `).all();
}

export function hasAdminUser() {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`).get();
  return Number(row?.count || 0) > 0;
}

export function countAdminUsers() {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`).get();
  return Number(row?.count || 0);
}

export function upsertUser({ username, password, role = 'user' }) {
  const normalizedUsername = String(username || '').trim();
  const normalizedRole = role === 'admin' ? 'admin' : 'user';
  if (!normalizedUsername) {
    throw new Error('Username is required');
  }
  if (normalizedUsername.length > 50) throw new Error('Логин не должен быть длиннее 50 символов');
  if (!/^[a-zA-Z0-9_.-]+$/.test(normalizedUsername)) throw new Error('Логин может содержать только латинские буквы, цифры, точку, дефис и подчёркивание');

  const normalizedPassword = String(password || '');
  validatePassword(normalizedPassword);
  const passwordHash = hashPassword(normalizedPassword);
  db.prepare(`
    INSERT INTO users(username, password_hash, role)
    VALUES(?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      password_hash = excluded.password_hash,
      role = excluded.role
  `).run(normalizedUsername, passwordHash, normalizedRole);

  return getUserByUsername(normalizedUsername);
}

export function updateUser({ username, password = '', role = 'user' }) {
  const normalizedUsername = String(username || '').trim();
  const normalizedRole = role === 'admin' ? 'admin' : 'user';
  const existing = getUserByUsername(normalizedUsername);
  if (!existing) {
    throw new Error('User not found');
  }

  if (existing.role === 'admin' && normalizedRole !== 'admin' && countAdminUsers() <= 1) {
    throw new Error('Cannot remove the last admin');
  }

  if (String(password || '')) {
    validatePassword(password);
    db.prepare(`
      UPDATE users
      SET password_hash = ?, role = ?, session_gen = COALESCE(session_gen, 0) + 1
      WHERE username = ?
    `).run(hashPassword(password), normalizedRole, normalizedUsername);
  } else {
    db.prepare(`
      UPDATE users
      SET role = ?
      WHERE username = ?
    `).run(normalizedRole, normalizedUsername);
  }

  return getUserByUsername(normalizedUsername);
}

export function deleteUser(username) {
  const normalizedUsername = String(username || '').trim();
  return db.transaction(() => {
    const existing = getUserByUsername(normalizedUsername);
    if (!existing) {
      return 0;
    }

    if (existing.role === 'admin' && countAdminUsers() <= 1) {
      throw new Error('Cannot delete the last admin');
    }

    db.prepare(`DELETE FROM reader_bookmarks WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM reading_positions WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM bookmarks WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM reading_history WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM favorite_authors WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM favorite_series WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM shelf_books WHERE shelf_id IN (SELECT id FROM shelves WHERE username = ?)`).run(normalizedUsername);
    db.prepare(`DELETE FROM shelves WHERE username = ?`).run(normalizedUsername);
    return db.prepare(`DELETE FROM users WHERE username = ?`).run(normalizedUsername).changes;
  })();
}

export function blockUser(username) {
  db.prepare(`UPDATE users SET blocked = 1 WHERE username = ?`).run(String(username || '').trim());
}

export function unblockUser(username) {
  db.prepare(`UPDATE users SET blocked = 0 WHERE username = ?`).run(String(username || '').trim());
}

/** Триггеры синхронизации fts5 (content='books') с таблицей books. */
const BOOKS_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, id, title, authors, genres, series, keywords)
    VALUES (new.rowid, new.id, new.title, new.authors, new.genres, new.series, new.keywords);
  END;
  CREATE TRIGGER IF NOT EXISTS books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, id, title, authors, genres, series, keywords)
    VALUES('delete', old.rowid, old.id, old.title, old.authors, old.genres, old.series, old.keywords);
  END;
  CREATE TRIGGER IF NOT EXISTS books_au AFTER UPDATE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, id, title, authors, genres, series, keywords)
    VALUES('delete', old.rowid, old.id, old.title, old.authors, old.genres, old.series, old.keywords);
    INSERT INTO books_fts(rowid, id, title, authors, genres, series, keywords)
    VALUES (new.rowid, new.id, new.title, new.authors, new.genres, new.series, new.keywords);
  END;
`;

export function ensureBooksFtsTriggers() {
  db.exec(BOOKS_FTS_TRIGGERS_SQL);
}

export function dropBooksFtsTriggers() {
  db.exec('DROP TRIGGER IF EXISTS books_ai');
  db.exec('DROP TRIGGER IF EXISTS books_au');
  db.exec('DROP TRIGGER IF EXISTS books_ad');
}

let fastSqliteImportDepth = 0;
let savedSynchronousLevel = null;
let savedBusyTimeoutMs = null;

/**
 * На время массового импорта: synchronous=OFF (быстрее, при сбое питания возможна порча БД).
 * wal_autocheckpoint не трогаем: завышенное значение откладывает checkpoint в «одну огромную»
 * операцию и даёт минутные паузы; при нормальных 1000 страницах паузы короче и предсказуемее.
 * busy_timeout увеличиваем: при конкурирующих читателях (HTTP) не ронять писатель коротким 5 с.
 * Вызывать парно с endFastSqliteImport() из finally; допускается вложенность (refcount).
 */
export function beginFastSqliteImport() {
  if (fastSqliteImportDepth === 0) {
    const cur = db.pragma('synchronous', { simple: true });
    savedSynchronousLevel = typeof cur === 'number' ? cur : 1;
    db.pragma('synchronous = OFF');

    const bt = db.pragma('busy_timeout', { simple: true });
    savedBusyTimeoutMs = typeof bt === 'number' ? bt : 5000;
    db.pragma('busy_timeout = 120000');
  }
  fastSqliteImportDepth += 1;
}

export function endFastSqliteImport() {
  if (fastSqliteImportDepth <= 0) return;
  fastSqliteImportDepth -= 1;
  if (fastSqliteImportDepth === 0) {
    if (savedSynchronousLevel !== null) {
      db.pragma(`synchronous = ${savedSynchronousLevel}`);
      savedSynchronousLevel = null;
    }
    if (savedBusyTimeoutMs !== null) {
      db.pragma(`busy_timeout = ${savedBusyTimeoutMs}`);
      savedBusyTimeoutMs = null;
    }
  }
}

/**
 * Полная пересборка FTS после массового импорта без триггеров.
 * Одна команда VALUES('rebuild') блокирует event loop на минуты при сотнях тысяч книг;
 * поэтому по умолчанию: delete-all + батчи INSERT с уступкой циклу; при сбое — классический rebuild.
 */
export async function rebuildBooksFtsFromContent(options = {}) {
  const { onProgress } = options;
  const BATCH = 2000;
  try {
    await new Promise((resolve) => setImmediate(resolve));
    appendIndexDiaryLine('FTS: команда delete-all (может занять до нескольких минут на огромной БД)…');
    console.log('[index] FTS: delete-all…');
    const tDel0 = Date.now();
    db.exec(`INSERT INTO books_fts(books_fts) VALUES('delete-all')`);
    console.log(`[index] FTS: delete-all готово за ${((Date.now() - tDel0) / 1000).toFixed(1)} с`);
    appendIndexDiaryLine(`FTS: delete-all завершён за ${Date.now() - tDel0} ms`);
    const total = db.prepare('SELECT COUNT(*) AS c FROM books').get()?.c ?? 0;
    const sel = db.prepare(`
      SELECT rowid, id, title, authors, genres, series, keywords FROM books
      WHERE rowid > ? ORDER BY rowid LIMIT ?
    `);
    const ins = db.prepare(`
      INSERT INTO books_fts(rowid, id, title, authors, genres, series, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let lastRowid = 0;
    let done = 0;
    let batchNum = 0;
    for (;;) {
      const rows = sel.all(lastRowid, BATCH);
      if (!rows.length) break;
      db.transaction(() => {
        for (const r of rows) {
          ins.run(
            r.rowid,
            r.id,
            r.title ?? '',
            r.authors ?? '',
            r.genres ?? '',
            r.series ?? '',
            r.keywords ?? ''
          );
        }
      })();
      done += rows.length;
      lastRowid = rows[rows.length - 1].rowid;
      batchNum += 1;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ done: Math.min(done, total), total });
        } catch {
          /* ignore */
        }
      }
      if (batchNum === 1 || batchNum % 20 === 0 || done >= total) {
        console.log(`[index] FTS: батч ${batchNum}, в индексе ~${done}/${total} строк`);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    console.log(`[index] FTS: поэтапная сборка завершена (${done} документов)`);
  } catch (err) {
    console.warn('[index] FTS: поэтапная пересборка не удалась, одна команда rebuild:', err?.message || err);
    db.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild')`);
  }
}

/** Синхронный полный rebuild — только если нужен явный fallback (тесты, скрипты). */
export function rebuildBooksFtsFromContentSync() {
  db.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild')`);
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      authors TEXT,
      genres TEXT,
      series TEXT,
      series_no TEXT,
      title_sort TEXT,
      author_sort TEXT,
      series_sort TEXT,
      series_index INTEGER DEFAULT 0,
      title_search TEXT,
      authors_search TEXT,
      series_search TEXT,
      genres_search TEXT,
      keywords_search TEXT,
      file_name TEXT,
      archive_name TEXT,
      size INTEGER,
      lib_id TEXT,
      deleted INTEGER DEFAULT 0,
      ext TEXT,
      date TEXT,
      lang TEXT,
      keywords TEXT,
      imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      id UNINDEXED,
      title,
      authors,
      genres,
      series,
      keywords,
      content='books',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      username TEXT NOT NULL,
      book_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, book_id),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS book_details_cache (
      book_id TEXT PRIMARY KEY,
      title TEXT,
      annotation TEXT,
      cover_content_type TEXT,
      cover_data BLOB,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      sort_name TEXT,
      search_name TEXT
    );

    CREATE TABLE IF NOT EXISTS series_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      sort_name TEXT,
      search_name TEXT
    );

    CREATE TABLE IF NOT EXISTS genres_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      sort_name TEXT,
      search_name TEXT
    );

    CREATE TABLE IF NOT EXISTS book_authors (
      book_id TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      PRIMARY KEY (book_id, author_id),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS book_series (
      book_id TEXT PRIMARY KEY,
      series_id INTEGER NOT NULL,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      FOREIGN KEY (series_id) REFERENCES series_catalog(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS book_genres (
      book_id TEXT NOT NULL,
      genre_id INTEGER NOT NULL,
      PRIMARY KEY (book_id, genre_id),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
      FOREIGN KEY (genre_id) REFERENCES genres_catalog(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_history (
      username TEXT NOT NULL,
      book_id TEXT NOT NULL,
      last_opened_at TEXT DEFAULT CURRENT_TIMESTAMP,
      open_count INTEGER DEFAULT 1,
      PRIMARY KEY (username, book_id),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS favorite_authors (
      username TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, author_id),
      FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS favorite_series (
      username TEXT NOT NULL,
      series_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, series_id),
      FOREIGN KEY (series_id) REFERENCES series_catalog(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shelves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(username, name)
    );

    CREATE TABLE IF NOT EXISTS shelf_books (
      shelf_id INTEGER NOT NULL,
      book_id TEXT NOT NULL,
      added_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (shelf_id, book_id),
      FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS suppressed_books (
      book_id TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      authors TEXT DEFAULT '',
      reason TEXT DEFAULT 'user',
      suppressed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_indexed_at TEXT,
      book_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS oauth_users (
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      email TEXT DEFAULT '',
      display_name TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (provider, provider_user_id),
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_users_username ON oauth_users(username);
  `);

  ensureUsersSchema();
  ensureBooksSchema();
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_dedup_projection (
      dedup_key TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      title_sort TEXT,
      author_sort TEXT,
      series_sort TEXT,
      series_index REAL,
      sort_date TEXT
    );
  `);
  ensureCatalogSchema('authors');
  ensureCatalogSchema('series_catalog');
  ensureCatalogSchema('genres_catalog');
  ensureFlibustaSidecarSchema();

  // Add book_count column to catalog tables (idempotent, must run before index creation).
  for (const tbl of ['authors', 'series_catalog', 'genres_catalog']) {
    const cols = db.pragma(`table_info(${tbl})`).map(c => c.name);
    if (!cols.includes('book_count')) {
      db.exec(`ALTER TABLE ${tbl} ADD COLUMN book_count INTEGER NOT NULL DEFAULT 0`);
    }
  }

  // Add book_count column to sources table (migration for existing DBs).
  {
    const cols = db.pragma('table_info(sources)').map(c => c.name);
    if (!cols.includes('book_count')) {
      db.exec(`ALTER TABLE sources ADD COLUMN book_count INTEGER NOT NULL DEFAULT 0`);
    }
  }

  const SCHEMA_BOOT_KEY = 'schema_bootstrap_v4';
  const schemaBootDone = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SCHEMA_BOOT_KEY)?.value === '1';
  if (!schemaBootDone) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_book_authors_author_id ON book_authors(author_id);
      CREATE INDEX IF NOT EXISTS idx_book_authors_book_id ON book_authors(book_id);
      CREATE INDEX IF NOT EXISTS idx_book_genres_genre_id ON book_genres(genre_id);
      CREATE INDEX IF NOT EXISTS idx_book_genres_book_id ON book_genres(book_id);
      CREATE INDEX IF NOT EXISTS idx_book_series_series_id ON book_series(series_id);
      CREATE INDEX IF NOT EXISTS idx_book_series_book_id ON book_series(book_id);
      CREATE INDEX IF NOT EXISTS idx_books_title_sort ON books(title_sort);
      CREATE INDEX IF NOT EXISTS idx_books_author_sort ON books(author_sort);
      CREATE INDEX IF NOT EXISTS idx_books_series_sort_series_index ON books(series_sort, series_index);
      CREATE INDEX IF NOT EXISTS idx_books_imported_at ON books(imported_at DESC);
      CREATE INDEX IF NOT EXISTS idx_books_date_imported_at ON books(date DESC, imported_at DESC);
      CREATE INDEX IF NOT EXISTS idx_books_title_search ON books(title_search);
      CREATE INDEX IF NOT EXISTS idx_books_authors_search ON books(authors_search);
      CREATE INDEX IF NOT EXISTS idx_books_series_search ON books(series_search);
      CREATE INDEX IF NOT EXISTS idx_books_genres_search ON books(genres_search);
      CREATE INDEX IF NOT EXISTS idx_books_keywords_search ON books(keywords_search);
      CREATE INDEX IF NOT EXISTS idx_authors_sort_name ON authors(sort_name);
      CREATE INDEX IF NOT EXISTS idx_authors_search_name ON authors(search_name);
      CREATE INDEX IF NOT EXISTS idx_series_catalog_sort_name ON series_catalog(sort_name);
      CREATE INDEX IF NOT EXISTS idx_series_catalog_search_name ON series_catalog(search_name);
      CREATE INDEX IF NOT EXISTS idx_genres_catalog_sort_name ON genres_catalog(sort_name);
      CREATE INDEX IF NOT EXISTS idx_genres_catalog_search_name ON genres_catalog(search_name);
      CREATE INDEX IF NOT EXISTS idx_reading_history_username_opened ON reading_history(username, last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_books_source_id ON books(source_id);
      CREATE INDEX IF NOT EXISTS idx_books_deleted ON books(deleted);
      CREATE INDEX IF NOT EXISTS idx_books_deleted_source ON books(deleted, source_id);
      CREATE INDEX IF NOT EXISTS idx_books_lang ON books(lang);
      CREATE INDEX IF NOT EXISTS idx_books_lang_norm ON books(COALESCE(NULLIF(lang, ''), 'unknown'));
      CREATE INDEX IF NOT EXISTS idx_books_series_index_title ON books(series_index, title_sort, id DESC);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_username ON bookmarks(username);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON bookmarks(book_id);
      CREATE INDEX IF NOT EXISTS idx_bookmarks_username_book_id ON bookmarks(username, book_id);
      CREATE INDEX IF NOT EXISTS idx_reading_history_book_id ON reading_history(book_id);
      CREATE INDEX IF NOT EXISTS idx_reading_history_book_user_open ON reading_history(book_id, username, last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reading_history_username_book ON reading_history(username, book_id, last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS idx_reader_bookmarks_username ON reader_bookmarks(username);
      CREATE INDEX IF NOT EXISTS idx_shelf_books_book_id ON shelf_books(book_id);
      CREATE INDEX IF NOT EXISTS idx_shelf_books_shelf_id ON shelf_books(shelf_id);
      CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled);
      CREATE INDEX IF NOT EXISTS idx_dedup_projection_sort_date ON library_dedup_projection(sort_date DESC, book_id DESC);
      CREATE INDEX IF NOT EXISTS idx_dedup_projection_title ON library_dedup_projection(title_sort ASC, book_id DESC);
      CREATE INDEX IF NOT EXISTS idx_dedup_projection_author_title ON library_dedup_projection(author_sort ASC, title_sort ASC, book_id DESC);
      CREATE INDEX IF NOT EXISTS idx_dedup_projection_series ON library_dedup_projection(series_sort ASC, series_index ASC, title_sort ASC, book_id DESC);
      CREATE INDEX IF NOT EXISTS idx_books_deleted_deleted0 ON books(deleted) WHERE deleted = 0;
      CREATE INDEX IF NOT EXISTS idx_book_details_cache_book_id ON book_details_cache(book_id);
      CREATE INDEX IF NOT EXISTS idx_authors_book_count ON authors(book_count DESC);
      CREATE INDEX IF NOT EXISTS idx_series_catalog_book_count ON series_catalog(book_count DESC);
      CREATE INDEX IF NOT EXISTS idx_genres_catalog_book_count ON genres_catalog(book_count DESC);
    `);
    db.exec(`DROP VIEW IF EXISTS active_books`);
    db.exec(`CREATE VIEW active_books AS SELECT * FROM books WHERE deleted = 0 AND (source_id IS NULL OR EXISTS (SELECT 1 FROM sources WHERE sources.id = books.source_id AND sources.enabled = 1))`);
    db.prepare(`
      INSERT INTO meta(key, value) VALUES(?, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SCHEMA_BOOT_KEY);
  } else {
    // Fast path for recurring starts; recreate view only if unexpectedly missing.
    const hasActiveBooksView = Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'active_books'`).get()
    );
    if (!hasActiveBooksView) {
      db.exec(`CREATE VIEW active_books AS SELECT * FROM books WHERE deleted = 0 AND (source_id IS NULL OR EXISTS (SELECT 1 FROM sources WHERE sources.id = books.source_id AND sources.enabled = 1))`);
    }
  }

  ensureBooksFtsTriggers();

  // Recovery: if a previous indexing crashed after dropping FTS triggers,
  // the books_fts index is stale. Detect and schedule a synchronous rebuild.
  const ftsDirty = db.prepare(`SELECT value FROM meta WHERE key = 'books_fts_dirty'`).get();
  if (ftsDirty?.value === '1') {
    console.warn('[boot] FTS index marked dirty from previous crash — rebuilding synchronously…');
    try {
      rebuildBooksFtsFromContentSync();
      db.prepare(`INSERT INTO meta(key, value) VALUES('books_fts_dirty', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run();
      console.log('[boot] FTS index rebuilt successfully after crash recovery.');
    } catch (err) {
      console.error('[boot] FTS crash recovery rebuild failed:', err.message);
    }
  }

  seedDefaultAdmin();
  migrateInpxToSources();
}

// --- Sources CRUD ---

export function getSources() {
  return db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    ORDER BY created_at ASC
  `).all();
}

export function getEnabledSources() {
  return db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    WHERE enabled = 1
    ORDER BY created_at ASC
  `).all();
}

export function getSourceById(id) {
  return db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    WHERE id = ?
  `).get(id) || null;
}

export function getSourceByPath(sourcePath) {
  return db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    WHERE path = ?
  `).get(sourcePath) || null;
}

export function addSource({ name, type, path: sourcePath }) {
  const trimmedName = String(name || '').trim();
  const trimmedPath = String(sourcePath || '').trim();
  const normalizedType = type === 'inpx' ? 'inpx' : 'folder';
  if (!trimmedName) throw new Error('Название источника не указано');
  if (!trimmedPath) throw new Error('Путь к источнику не указан');
  const existing = getSourceByPath(trimmedPath);
  if (existing) throw new Error('Источник с таким путём уже существует');
  const result = db.prepare(`
    INSERT INTO sources(name, type, path) VALUES(?, ?, ?)
  `).run(trimmedName, normalizedType, trimmedPath);
  return getSourceById(result.lastInsertRowid);
}

export function updateSource(id, { name, enabled }) {
  const parts = [];
  const params = [];
  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Название источника не указано');
    parts.push('name = ?');
    params.push(trimmed);
  }
  if (enabled !== undefined) {
    parts.push('enabled = ?');
    params.push(enabled ? 1 : 0);
  }
  if (!parts.length) return getSourceById(id);
  params.push(id);
  db.prepare(`UPDATE sources SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  return getSourceById(id);
}

const DELETE_SOURCE_BOOKS_CHUNK = 300;

/**
 * Удаляет orphan-записи из authors, series_catalog, genres_catalog —
 * записи, на которые больше ни одна книга не ссылается через junction-таблицы.
 */
async function cleanupOrphanedCatalogs() {
  db.exec(`DELETE FROM authors WHERE NOT EXISTS (SELECT 1 FROM book_authors WHERE author_id = authors.id)`);
  await new Promise(r => setImmediate(r));
  db.exec(`DELETE FROM series_catalog WHERE NOT EXISTS (SELECT 1 FROM book_series WHERE series_id = series_catalog.id)`);
  await new Promise(r => setImmediate(r));
  db.exec(`DELETE FROM genres_catalog WHERE NOT EXISTS (SELECT 1 FROM book_genres WHERE genre_id = genres_catalog.id)`);
  await new Promise(r => setImmediate(r));
}

export async function deleteSourceProgressive(
  id,
  {
    chunkSize = DELETE_SOURCE_BOOKS_CHUNK,
    onProgress = null,
    deleteSourceRow = true,
    interChunkDelayMs = 0
  } = {}
) {
  const sid = Number(id);
  if (!Number.isFinite(sid)) {
    throw new Error('Некорректный id источника');
  }
  const safeChunk = Math.max(100, Math.min(2000, Math.floor(Number(chunkSize) || DELETE_SOURCE_BOOKS_CHUNK)));

  // Fast import mode: synchronous=OFF + longer busy_timeout — same as indexing.
  // Without this, each commit does fsync (synchronous=NORMAL) making deletion
  // dramatically slower than indexing and blocking the event loop for much longer.
  beginFastSqliteImport();
  try {
    onProgress?.({ deleted: 0, total: 0, stage: 'prepare' });

    const total = db.prepare('SELECT COUNT(*) AS c FROM books WHERE source_id = ?').get(sid)?.c ?? 0;

    // Cleanup related tables using source_id directly (no need to load all IDs into JS).
    onProgress?.({ deleted: 0, total, stage: 'cleanup' });
    db.prepare('DELETE FROM flibusta_author_shard WHERE source_id = ?').run(sid);
    await new Promise(r => setImmediate(r));
    db.prepare('DELETE FROM book_reviews WHERE source_id = ?').run(sid);
    await new Promise(r => setImmediate(r));
    db.exec(`DELETE FROM reading_positions WHERE book_id IN (SELECT id FROM books WHERE source_id = ${sid})`);
    await new Promise(r => setImmediate(r));
    db.exec(`DELETE FROM reader_bookmarks WHERE book_id IN (SELECT id FROM books WHERE source_id = ${sid})`);
    await new Promise(r => setImmediate(r));

    let deleted = 0;

    // Targeted FTS deletion: remove FTS entries for each chunk before deleting rows.
    // This keeps the FTS index consistent without a full rebuild.
    // FTS triggers are disabled during the loop to avoid double-processing.
    dropBooksFtsTriggers();
    try {
      const selectChunk = db.prepare(`
        SELECT rowid, id, title, authors, genres, series, keywords
        FROM books WHERE source_id = ? LIMIT ${safeChunk}
      `);
      const ftsDelete = db.prepare(`
        INSERT INTO books_fts(books_fts, rowid, id, title, authors, genres, series, keywords)
        VALUES('delete', ?, ?, ?, ?, ?, ?, ?)
      `);
      const delByRowids = db.prepare(`
        DELETE FROM books WHERE rowid IN (
          SELECT rowid FROM books WHERE source_id = ? LIMIT ${safeChunk}
        )
      `);

      for (;;) {
        const rows = selectChunk.all(sid);
        if (!rows.length) break;
        db.transaction(() => {
          for (const r of rows) {
            ftsDelete.run(r.rowid, r.id, r.title ?? '', r.authors ?? '', r.genres ?? '', r.series ?? '', r.keywords ?? '');
          }
          delByRowids.run(sid);
        })();
        deleted += rows.length;
        onProgress?.({ deleted, total, stage: 'books' });
        await new Promise(r => setImmediate(r));
        if (interChunkDelayMs > 0) {
          await new Promise(r => setTimeout(r, interChunkDelayMs));
        }
      }
    } finally {
      ensureBooksFtsTriggers();
    }

    const sourceDeleted = deleteSourceRow
      ? db.prepare('DELETE FROM sources WHERE id = ?').run(sid).changes
      : 0;

    onProgress?.({ deleted, total, stage: 'catalogs' });
    try { await cleanupOrphanedCatalogs(); } catch {}
    await new Promise(r => setImmediate(r));

    // No full FTS rebuild needed — targeted FTS deletes above kept the index consistent.

    onProgress?.({ deleted, total, stage: 'done' });
    return { sourceDeleted, deletedBooks: deleted, totalBooks: total };
  } catch (err) {
    const m = String(err?.message || err);
    if (/database disk image is malformed|SQLITE_CORRUPT|malformed/i.test(m)) {
      const hint =
        ' Остановите сервер, сохраните копию data/library.db, проверьте: sqlite3 library.db "PRAGMA integrity_check;"';
      throw new Error(`database disk image is malformed${hint}`);
    }
    throw err;
  } finally {
    endFastSqliteImport();
  }
}

export function detachSource(id) {
  const sid = Number(id);
  if (!Number.isFinite(sid)) {
    throw new Error('Некорректный id источника');
  }
  return db.prepare('DELETE FROM sources WHERE id = ?').run(sid).changes;
}

/**
 * Аварийное удаление: сначала пытаемся удалить книги-сироты, затем удаляем строку источника.
 * Если удаление книг не удаётся (повреждённый FTS/индексы) — удаляем только строку источника.
 * Книги-сироты скрыты через active_books (view проверяет существование источника).
 */
export function forceDetachSourceRowUnsafe(id) {
  const sid = Number(id);
  if (!Number.isFinite(sid)) {
    throw new Error('Некорректный id источника');
  }

  try {
    try {
      db.exec(`DELETE FROM reading_positions WHERE book_id IN (SELECT id FROM books WHERE source_id = ${sid})`);
      db.exec(`DELETE FROM reader_bookmarks WHERE book_id IN (SELECT id FROM books WHERE source_id = ${sid})`);
    } catch { /* best-effort */ }

    dropBooksFtsTriggers();
    try {
      db.prepare('DELETE FROM books WHERE source_id = ?').run(sid);
    } catch {
      // книги останутся сиротами, но будут скрыты через active_books
    } finally {
      ensureBooksFtsTriggers();
    }

    try { cleanupOrphanedCatalogs().catch(() => {}); } catch {}
  } catch {
    // при любой ошибке всё равно удаляем строку источника
  }

  const fkPrev = db.pragma('foreign_keys', { simple: true });
  try {
    db.pragma('foreign_keys = OFF');
    const result = db.prepare('DELETE FROM sources WHERE id = ?').run(sid).changes;
    try { rebuildBooksFtsFromContentSync(); } catch {}
    return result;
  } finally {
    db.pragma(`foreign_keys = ${Number(fkPrev) ? 'ON' : 'OFF'}`);
  }
}

export function updateSourceBookCount(id) {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM books WHERE source_id = ?').get(id)?.cnt || 0;
  db.prepare('UPDATE sources SET book_count = ? WHERE id = ?').run(count, id);
  return count;
}

export function updateSourceIndexedAt(id) {
  db.prepare('UPDATE sources SET last_indexed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

export function updateSourceFlibustaSidecar(id, enabled) {
  db.prepare('UPDATE sources SET flibusta_sidecar = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

/** Запись отзыва: legacy body и/или указатель на 7z (как в FLibrary). */
export function getBookReviewRecord(bookId) {
  return db.prepare(`
    SELECT body, review_shard, entry_key FROM book_reviews WHERE book_id = ?
  `).get(bookId);
}

/** Указатель на etc/reviews (заполняется при индексации sidecar). Legacy body не затираем. */
export function upsertBookReviewPointer(bookId, sourceId, reviewShard, entryKey) {
  db.prepare(`
    INSERT INTO book_reviews (book_id, source_id, body, review_shard, entry_key, updated_at)
    VALUES (?, ?, NULL, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(book_id) DO UPDATE SET
      source_id = excluded.source_id,
      review_shard = excluded.review_shard,
      entry_key = excluded.entry_key,
      body = COALESCE(book_reviews.body, excluded.body),
      updated_at = CURRENT_TIMESTAMP
  `).run(bookId, sourceId, reviewShard, entryKey);
}

/** Батчи, иначе одна транзакция на сотни тысяч строк блокирует БД и «подвешивает» HTTP на минуты. */
const SIDEcar_INDEX_DB_BATCH = 4000;

/** Книги источника для построения указателей на отзывы (листинг архивов, без тел JSON). */
export function getBookRowsForReviewPointerBuild(sourceId) {
  return db
    .prepare(
      `
    SELECT id, archive_name AS archiveName, file_name AS fileName
    FROM books
    WHERE source_id = ? AND deleted = 0
      AND archive_name IS NOT NULL AND TRIM(archive_name) != ''
      AND file_name IS NOT NULL AND TRIM(file_name) != ''
  `
    )
    .all(sourceId);
}

/**
 * @param {number} sourceId
 * @param {{ bookId: string, reviewShard: string, entryKey: string }[]} rows
 */
export async function replaceBookReviewPointersForSource(sourceId, rows) {
  const delPointersOnly = db.prepare(`
    DELETE FROM book_reviews
    WHERE source_id = ?
      AND (body IS NULL OR TRIM(COALESCE(body, '')) = '')
  `);
  const upsert = db.prepare(`
    INSERT INTO book_reviews (book_id, source_id, body, review_shard, entry_key, updated_at)
    VALUES (?, ?, NULL, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(book_id) DO UPDATE SET
      source_id = excluded.source_id,
      review_shard = excluded.review_shard,
      entry_key = excluded.entry_key,
      body = COALESCE(book_reviews.body, excluded.body),
      updated_at = CURRENT_TIMESTAMP
  `);
  delPointersOnly.run(sourceId);
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += SIDEcar_INDEX_DB_BATCH) {
    const part = list.slice(i, i + SIDEcar_INDEX_DB_BATCH);
    db.transaction(() => {
      for (const r of part) {
        upsert.run(r.bookId, sourceId, r.reviewShard, r.entryKey);
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @param {number} sourceId
 * @param {{ authorKey: string, shardName: string, entryPath: string }[]} rows
 */
export async function replaceFlibustaAuthorShardsForSource(sourceId, rows) {
  const del = db.prepare('DELETE FROM flibusta_author_shard WHERE source_id = ?');
  const ins = db.prepare(`
    INSERT INTO flibusta_author_shard (author_key, source_id, shard_name, entry_path, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  del.run(sourceId);
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += SIDEcar_INDEX_DB_BATCH) {
    const part = list.slice(i, i + SIDEcar_INDEX_DB_BATCH);
    db.transaction(() => {
      for (const r of part) {
        ins.run(r.authorKey, sourceId, r.shardName, r.entryPath);
      }
    })();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function getFlibustaAuthorShardRow(authorKey, sourceId) {
  return db.prepare(`
    SELECT shard_name, entry_path FROM flibusta_author_shard
    WHERE LOWER(author_key) = LOWER(?) AND source_id = ?
  `).get(authorKey, sourceId);
}

export function upsertFlibustaAuthorPortrait(key, zipName, entryPath) {
  db.prepare(`
    INSERT INTO flibusta_author_portrait (author_key, zip_name, entry_path, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(author_key) DO UPDATE SET
      zip_name = excluded.zip_name,
      entry_path = excluded.entry_path,
      updated_at = CURRENT_TIMESTAMP
  `).run(key, zipName, entryPath);
}

export function getFlibustaAuthorPortrait(key) {
  return db.prepare('SELECT zip_name, entry_path FROM flibusta_author_portrait WHERE author_key = ?').get(key) || null;
}

export function migrateInpxToSources() {
  const sourcesCount = db.prepare('SELECT COUNT(*) AS cnt FROM sources').get().cnt;
  if (sourcesCount > 0) return;

  const inpxPath = db.prepare("SELECT value FROM meta WHERE key = 'inpx_file'").get()?.value;
  if (!inpxPath) return;

  const trimmed = String(inpxPath).trim();
  if (!trimmed) return;

  const result = db.prepare(`
    INSERT INTO sources(name, type, path) VALUES(?, 'inpx', ?)
  `).run('INPX Library', trimmed);
  const sourceId = result.lastInsertRowid;
  db.prepare('UPDATE books SET source_id = ? WHERE source_id IS NULL').run(sourceId);
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM books WHERE source_id = ?').get(sourceId)?.cnt || 0;
  db.prepare('UPDATE sources SET book_count = ? WHERE id = ?').run(count, sourceId);
}

export function getMeta(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare(`
    INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getUserShelves(username) {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.description, s.created_at AS createdAt,
           (SELECT COUNT(*) FROM shelf_books sb WHERE sb.shelf_id = s.id) AS bookCount,
           (SELECT GROUP_CONCAT(sb2.book_id, '|') FROM (
              SELECT sb2.book_id FROM shelf_books sb2
              JOIN active_books b ON b.id = sb2.book_id
              WHERE sb2.shelf_id = s.id
              ORDER BY sb2.added_at DESC LIMIT 20
           ) sb2) AS previewBookIds
    FROM shelves s
    WHERE s.username = ?
    ORDER BY s.name COLLATE NOCASE
  `).all(username);
  for (const row of rows) {
    row.previewBookIds = row.previewBookIds ? row.previewBookIds.split('|') : [];
  }
  return rows;
}

export function getShelfById(shelfId, username) {
  return db.prepare(`
    SELECT id, username, name, description, created_at AS createdAt
    FROM shelves WHERE id = ? AND username = ?
  `).get(shelfId, username);
}

export function createShelf(username, name, description = '') {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Название полки не указано');
  const existing = db.prepare('SELECT id FROM shelves WHERE username = ? AND name = ?').get(username, trimmed);
  if (existing) throw new Error('Полка с таким названием уже существует');
  const result = db.prepare('INSERT INTO shelves(username, name, description) VALUES(?, ?, ?)').run(username, trimmed, String(description || '').trim());
  return result.lastInsertRowid;
}

export function updateShelf(shelfId, username, name, description) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Название полки не указано');
  const dup = db.prepare('SELECT id FROM shelves WHERE username = ? AND name = ? AND id != ?').get(username, trimmed, shelfId);
  if (dup) throw new Error('Полка с таким названием уже существует');
  return db.prepare('UPDATE shelves SET name = ?, description = ? WHERE id = ? AND username = ?').run(trimmed, String(description || '').trim(), shelfId, username).changes;
}

export function deleteShelf(shelfId, username) {
  return db.prepare('DELETE FROM shelves WHERE id = ? AND username = ?').run(shelfId, username).changes;
}

export function addBookToShelf(shelfId, bookId) {
  db.prepare('INSERT OR IGNORE INTO shelf_books(shelf_id, book_id) VALUES(?, ?)').run(shelfId, bookId);
}

export function removeBookFromShelf(shelfId, bookId) {
  return db.prepare('DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?').run(shelfId, bookId).changes;
}

export function getShelfBooks(shelfId, username) {
  return db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang,
           b.archive_name AS archiveName, sb.added_at AS addedAt
    FROM shelf_books sb
    JOIN active_books b ON b.id = sb.book_id
    JOIN shelves s ON s.id = sb.shelf_id AND s.username = ?
    WHERE sb.shelf_id = ?
    ORDER BY sb.added_at DESC
  `).all(username, shelfId);
}

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`);

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value || '';
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value ?? ''));
}

/**
 * Список всех уникальных языков из таблицы books (включая удалённые/отключённые),
 * чтобы админ видел полную картину.
 */
export function getDistinctLanguages() {
  return db.prepare(`
    SELECT COALESCE(NULLIF(lang, ''), 'unknown') AS code, COUNT(*) AS bookCount
    FROM books WHERE deleted = 0
    GROUP BY COALESCE(NULLIF(lang, ''), 'unknown')
    ORDER BY bookCount DESC
  `).all();
}

/**
 * Пересоздание VIEW active_books с учётом исключённых языков.
 * Вызывается при изменении настройки excluded_languages.
 */
export async function rebuildActiveBooksView() {
  const excluded = getSetting('excluded_languages');
  const langs = excluded
    ? excluded.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  let langFilter = '';
  if (langs.length > 0) {
    const placeholders = langs.map(l => `'${l.replace(/'/g, "''")}'`).join(',');
    langFilter = ` AND COALESCE(NULLIF(lang, ''), 'unknown') NOT IN (${placeholders})`;
  }

  db.exec('DROP VIEW IF EXISTS active_books');
  db.exec(`CREATE VIEW active_books AS SELECT * FROM books WHERE deleted = 0 AND (source_id IS NULL OR EXISTS (SELECT 1 FROM sources WHERE sources.id = books.source_id AND sources.enabled = 1))${langFilter}`);
  await refreshCatalogBookCounts();
}

/**
 * Пересчёт book_count в таблицах authors, series_catalog, genres_catalog
 * на основе active_books VIEW. Вызывается после индексации и при изменении
 * excluded_languages.
 */
export async function refreshCatalogBookCounts() {
  // Use efficient set-based UPDATE ... FROM (single GROUP BY pass per table)
  // instead of correlated subqueries (which are O(catalog_rows × books)).
  db.exec(`
    UPDATE authors SET book_count = 0;
    UPDATE authors SET book_count = t.cnt
    FROM (
      SELECT ba.author_id AS id, COUNT(*) AS cnt
      FROM book_authors ba
      JOIN books b ON b.id = ba.book_id AND b.deleted = 0
      WHERE b.source_id IS NULL OR EXISTS (SELECT 1 FROM sources s WHERE s.id = b.source_id AND s.enabled = 1)
      GROUP BY ba.author_id
    ) t
    WHERE authors.id = t.id;
  `);
  await new Promise(r => setImmediate(r));

  db.exec(`
    UPDATE series_catalog SET book_count = 0;
    UPDATE series_catalog SET book_count = t.cnt
    FROM (
      SELECT bs.series_id AS id, COUNT(*) AS cnt
      FROM book_series bs
      JOIN books b ON b.id = bs.book_id AND b.deleted = 0
      WHERE b.source_id IS NULL OR EXISTS (SELECT 1 FROM sources s WHERE s.id = b.source_id AND s.enabled = 1)
      GROUP BY bs.series_id
    ) t
    WHERE series_catalog.id = t.id;
  `);
  await new Promise(r => setImmediate(r));

  db.exec(`
    UPDATE genres_catalog SET book_count = 0;
    UPDATE genres_catalog SET book_count = t.cnt
    FROM (
      SELECT bg.genre_id AS id, COUNT(*) AS cnt
      FROM book_genres bg
      JOIN books b ON b.id = bg.book_id AND b.deleted = 0
      WHERE b.source_id IS NULL OR EXISTS (SELECT 1 FROM sources s WHERE s.id = b.source_id AND s.enabled = 1)
      GROUP BY bg.genre_id
    ) t
    WHERE genres_catalog.id = t.id;
  `);
}

export function getSmtpSettings() {
  return {
    host: getSetting('smtp_host'),
    port: Number(getSetting('smtp_port')) || 587,
    secure: getSetting('smtp_secure') === '1',
    user: getSetting('smtp_user'),
    pass: decryptValue(getSetting('smtp_pass')),
    from: getSetting('smtp_from')
  };
}

export function setSmtpSettings({ host, port, secure, user, pass, from }) {
  setSetting('smtp_host', host || '');
  setSetting('smtp_port', String(port || 587));
  setSetting('smtp_secure', secure ? '1' : '0');
  setSetting('smtp_user', user || '');
  setSetting('smtp_pass', pass ? encryptValue(pass) : '');
  setSetting('smtp_from', from || '');
}

db.exec(`CREATE TABLE IF NOT EXISTS reading_positions (
  username TEXT NOT NULL,
  book_id TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (username, book_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS reader_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  book_id TEXT NOT NULL,
  position TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reader_bookmarks_user_book ON reader_bookmarks(username, book_id)`);

export function getReadingPosition(username, bookId) {
  return db.prepare('SELECT position, progress FROM reading_positions WHERE username = ? AND book_id = ?').get(username, bookId) || null;
}

export function setReadingPosition(username, bookId, position, progress) {
  db.prepare(`INSERT INTO reading_positions (username, book_id, position, progress, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(username, book_id) DO UPDATE SET position = excluded.position, progress = excluded.progress, updated_at = excluded.updated_at`
  ).run(username, bookId, String(position), Number(progress) || 0);
}

export function deleteReadingHistoryEntry(username, bookId) {
  db.prepare('DELETE FROM reading_history WHERE username = ? AND book_id = ?').run(username, bookId);
}

/** Восстановление строки истории (для отмены удаления в профиле). */
export function upsertReadingHistoryEntry(username, bookId, lastOpenedAt, openCount) {
  const opened = String(lastOpenedAt || '').trim() || new Date().toISOString();
  const count = Math.max(1, Number(openCount) || 1);
  db.prepare(`
    INSERT INTO reading_history(username, book_id, last_opened_at, open_count)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(username, book_id) DO UPDATE SET
      last_opened_at = excluded.last_opened_at,
      open_count = excluded.open_count
  `).run(username, bookId, opened, count);
}

export function getReaderBookmarks(username, bookId) {
  return db.prepare('SELECT id, position, title, created_at AS createdAt FROM reader_bookmarks WHERE username = ? AND book_id = ? ORDER BY created_at').all(username, bookId);
}

export function getAllReaderBookmarks(username, limit = 10) {
  return db.prepare(`
    SELECT rb.id, rb.book_id AS bookId, rb.position, rb.title AS label, rb.created_at AS createdAt,
           b.title AS bookTitle, b.authors
    FROM reader_bookmarks rb
    JOIN active_books b ON b.id = rb.book_id
    WHERE rb.username = ?
    ORDER BY rb.created_at DESC
    LIMIT ?
  `).all(username, limit);
}

export function addReaderBookmark(username, bookId, position, title) {
  const info = db.prepare('INSERT INTO reader_bookmarks (username, book_id, position, title) VALUES (?, ?, ?, ?)').run(username, bookId, String(position), String(title || ''));
  return info.lastInsertRowid;
}

export function deleteReaderBookmark(id, username) {
  db.prepare('DELETE FROM reader_bookmarks WHERE id = ? AND username = ?').run(id, username);
}

export function getEreaderEmail(username) {
  const row = db.prepare('SELECT ereader_email FROM users WHERE username = ?').get(username);
  return row?.ereader_email || '';
}

export function setEreaderEmail(username, email) {
  db.prepare('UPDATE users SET ereader_email = ? WHERE username = ?').run(String(email || '').trim(), username);
}

export function getUserStats(username) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM reading_history rh JOIN active_books b ON b.id = rh.book_id WHERE rh.username = ?) AS readingCount,
      (SELECT COUNT(*) FROM bookmarks WHERE username = ?) AS bookmarkCount,
      (SELECT COUNT(*) FROM favorite_authors WHERE username = ?) AS favoriteAuthorsCount,
      (SELECT COUNT(*) FROM favorite_series WHERE username = ?) AS favoriteSeriesCount,
      (SELECT COUNT(*) FROM shelves WHERE username = ?) AS shelvesCount,
      (SELECT COUNT(*) FROM shelf_books sb JOIN shelves s ON s.id = sb.shelf_id WHERE s.username = ?) AS shelfBooksCount,
      (SELECT COUNT(*) FROM reader_bookmarks WHERE username = ?) AS readerBookmarksCount,
      (SELECT created_at FROM users WHERE username = ?) AS createdAt
  `).get(username, username, username, username, username, username, username, username);
  return {
    readingCount: row?.readingCount || 0,
    bookmarkCount: row?.bookmarkCount || 0,
    favoriteAuthorsCount: row?.favoriteAuthorsCount || 0,
    favoriteSeriesCount: row?.favoriteSeriesCount || 0,
    shelvesCount: row?.shelvesCount || 0,
    shelfBooksCount: row?.shelfBooksCount || 0,
    readerBookmarksCount: row?.readerBookmarksCount || 0,
    createdAt: row?.createdAt || null
  };
}

export function createUser({ username, password }) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) throw new Error('Логин обязателен');
  if (normalizedUsername.length < 5) throw new Error('Логин должен быть не менее 5 символов');
  if (normalizedUsername.length > 50) throw new Error('Логин не должен быть длиннее 50 символов');
  if (!/^[a-zA-Z0-9_.-]+$/.test(normalizedUsername)) throw new Error('Логин может содержать только латинские буквы, цифры, точку, дефис и подчёркивание');
  const normalizedPassword = String(password || '');
  validatePassword(normalizedPassword);
  const existing = getUserByUsername(normalizedUsername);
  if (existing) throw new Error('Пользователь с таким логином уже существует');
  const passwordHash = hashPassword(normalizedPassword);
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES(?, ?, ?)').run(normalizedUsername, passwordHash, 'user');
  return getUserByUsername(normalizedUsername);
}

function validatePassword(password) {
  if (password.length > 1024) throw new Error('Пароль слишком длинный (макс. 1024 символа)');
  if (password.length < 8) throw new Error('Пароль должен быть не менее 8 символов');
  if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(password)) throw new Error('Пароль может содержать только латинские буквы, цифры и спецсимволы');
  if (!/[a-z]/.test(password)) throw new Error('Пароль должен содержать хотя бы одну строчную букву');
  if (!/[A-Z]/.test(password)) throw new Error('Пароль должен содержать хотя бы одну заглавную букву');
  if (!/[0-9]/.test(password)) throw new Error('Пароль должен содержать хотя бы одну цифру');
}

export function changePassword(username, newPassword) {
  const normalizedPassword = String(newPassword || '');
  validatePassword(normalizedPassword);
  const passwordHash = hashPassword(normalizedPassword);
  const result = db.prepare('UPDATE users SET password_hash = ?, session_gen = COALESCE(session_gen, 0) + 1 WHERE username = ?').run(passwordHash, username);
  if (result.changes === 0) throw new Error('Пользователь не найден');
}

export function getBookShelves(username, bookId) {
  return db.prepare(`
    SELECT s.id, s.name,
           EXISTS(SELECT 1 FROM shelf_books sb WHERE sb.shelf_id = s.id AND sb.book_id = ?) AS hasBook
    FROM shelves s
    WHERE s.username = ?
    ORDER BY s.name COLLATE NOCASE
  `).all(bookId, username);
}

function sqliteQuoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * ANALYZE по каждой таблице с уступкой event loop между таблицами — меньше «замираний» HTTP на огромной БД,
 * чем один монолитный `ANALYZE` без аргументов.
 */
export function analyzeDatabaseYielding() {
  const rows = db
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sqlite_stat%'
    ORDER BY name
  `
    )
    .all();

  return new Promise((resolve) => {
    let i = 0;
    function step() {
      if (i >= rows.length) {
        resolve();
        return;
      }
      const name = rows[i++].name;
      try {
        db.exec(`ANALYZE ${sqliteQuoteIdent(name)}`);
      } catch (err) {
        console.warn(`[analyze] skip ${name}:`, err.message);
      }
      setImmediate(step);
    }
    setImmediate(step);
  });
}

/* ── Suppressed books ────────────────────────────────────────────── */

export function suppressBook(bookId, title = '', authors = '', reason = 'user') {
  db.prepare(`INSERT INTO suppressed_books(book_id, title, authors, reason) VALUES(?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET reason = excluded.reason, suppressed_at = CURRENT_TIMESTAMP`
  ).run(String(bookId), title, authors, reason);
}

export function unsuppressBook(bookId) {
  const id = String(bookId);
  const removed = db.prepare('DELETE FROM suppressed_books WHERE book_id = ?').run(id).changes;
  if (removed) db.prepare('UPDATE books SET deleted = 0 WHERE id = ?').run(id);
  return removed;
}

export function unsuppressAll() {
  const ids = db.prepare('SELECT book_id FROM suppressed_books').all().map(r => r.book_id);
  if (!ids.length) return 0;
  const tx = db.transaction(() => {
    const restoreStmt = db.prepare('UPDATE books SET deleted = 0 WHERE id = ?');
    for (const id of ids) restoreStmt.run(id);
    db.prepare('DELETE FROM suppressed_books').run();
  });
  tx();
  return ids.length;
}

export function isBookSuppressed(bookId) {
  return Boolean(db.prepare('SELECT 1 FROM suppressed_books WHERE book_id = ?').get(String(bookId)));
}

export function getSuppressedBooks({ page = 1, pageSize = 50 } = {}) {
  const offset = (page - 1) * pageSize;
  const total = db.prepare('SELECT COUNT(*) AS count FROM suppressed_books').get()?.count || 0;
  const rows = db.prepare('SELECT * FROM suppressed_books ORDER BY suppressed_at DESC LIMIT ? OFFSET ?').all(pageSize, offset);
  return { total, rows };
}

export function getSuppressedBookIds() {
  return new Set(db.prepare('SELECT book_id FROM suppressed_books').all().map(r => r.book_id));
}
