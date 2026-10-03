import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { normalizeLookupEmail } from './utils/email-address.js';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { appendIndexDiaryLine } from './services/file-log.js';
import { hashPassword } from './auth.js';
import { runMigrations } from './services/migrations.js';
import { IDLE_MS, sessionStatusFromActivityAt } from '../public/position-sync.js';

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

const productionDbPath = path.resolve(config.rootDir, 'data', 'library.db');
const resolvedDbPath = path.resolve(config.dbPath);
const isTestProcess = Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.includes('--test');
if (
  process.env.ALLOW_PRODUCTION_TEST_DB !== '1'
  && resolvedDbPath === productionDbPath
  && isTestProcess
) {
  throw new Error(
    '[test] Refusing to open production data/library.db. Run "npm test" (loads test/test-env.js) or set DATA_DIR to an isolated directory.'
  );
}

export const db = new Database(config.dbPath, { timeout: 30000 });
db.function('lower_unicode', { deterministic: true }, (text) => String(text || '').toLowerCase());
db.function('archive_stem', { deterministic: true }, (name) => String(name || '')
  .replace(/\\/g, '/')
  .toLowerCase()
  .split('lib.flib/').join('')
  .split('lib.rus/').join('')
  .replace(/\.zip$/i, '')
  .replace(/\.7z$/i, ''));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');
const appliedTimeout = db.pragma('busy_timeout', { simple: true });
if (appliedTimeout !== 30000) {
  throw new Error(`[db] CRITICAL: busy_timeout could not be set (requested 30000, got ${appliedTimeout})`);
}
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('wal_autocheckpoint = 1000');
const _cacheSizeKb = config.sqliteCacheSizeMb * 1024;
const _mmapSize = config.sqliteMmapSizeMb * 1024 * 1024;
db.pragma(`cache_size = -${_cacheSizeKb}`);        // configurable page cache
db.pragma(`mmap_size = ${_mmapSize}`);              // configurable memory-mapped I/O
db.pragma('temp_store = MEMORY');       // temp tables in RAM

// Enable incremental auto-vacuum so deleted pages can be reclaimed
// without a full VACUUM (which can't truncate the file while mmap is active).
{
  const av = db.pragma('auto_vacuum', { simple: true });
  if (av === 0) {
    // Switching from NONE to INCREMENTAL requires a one-time VACUUM.
    // Temporarily release mmap so the file can be truncated.
    db.pragma('mmap_size = 0');
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.pragma(`mmap_size = ${_mmapSize}`);
    console.log('[db] auto_vacuum switched to INCREMENTAL (one-time VACUUM)');
  }
}

// Force WAL checkpoint on startup to clear stale locks from crashed processes
try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* ignore if locked briefly */ }

const WAL_TRUNCATE_MIN_BYTES = 32 * 1024 * 1024;

function walFileSize() {
  try {
    return fs.statSync(`${config.dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

/**
 * Усечь WAL, если он разросся. busy_timeout короткий: не ждать HTTP-читателей
 * минутами (TRUNCATE/RESTART после удаления источника подвешивали все страницы).
 */
export function tryIdleWalTruncate() {
  const size = walFileSize();
  if (size < WAL_TRUNCATE_MIN_BYTES) {
    return { ok: true, skipped: true, size };
  }
  const prevBusy = db.pragma('busy_timeout', { simple: true });
  try {
    db.pragma('busy_timeout = 50');
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    const info = result[0] || {};
    const newSize = walFileSize();
    if (info.busy === 0) {
      console.log(`[db] WAL TRUNCATE ${size} → ${newSize} bytes`);
    }
    return { ok: info.busy === 0, size, newSize, info };
  } catch (err) {
    return { ok: false, size, error: err.message };
  } finally {
    db.pragma(`busy_timeout = ${Number(prevBusy) || 30000}`);
  }
}

/**
 * Полный checkpoint+TRUNCATE, пока нет HTTP-читателей (старт процесса).
 * После массового DELETE WAL может быть несколько ГБ; PASSIVE файл не ужимает.
 */
export function compactWalExclusive() {
  const size = walFileSize();
  if (size < WAL_TRUNCATE_MIN_BYTES) {
    return { skipped: true, size };
  }
  console.log(`[db] WAL ${(size / 1e9).toFixed(2)} GB — checkpoint TRUNCATE до запуска HTTP…`);
  const t0 = Date.now();
  const prevBusy = db.pragma('busy_timeout', { simple: true });
  db.pragma('mmap_size = 0');
  db.pragma('busy_timeout = 600000');
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    const info = result[0] || {};
    const newSize = walFileSize();
    const ms = Date.now() - t0;
    console.log(`[db] WAL TRUNCATE ${ms}ms busy=${info.busy ?? '?'} ${size} → ${newSize} bytes`);
    if (info.busy !== 0) {
      console.warn('[db] WAL TRUNCATE не завершён (busy). Файл может остаться большим.');
    }
    return { ok: info.busy === 0, size, newSize, info, ms };
  } catch (err) {
    console.warn('[db] WAL TRUNCATE failed:', err.message);
    return { ok: false, size, error: err.message, ms: Date.now() - t0 };
  } finally {
    db.pragma(`busy_timeout = ${Number(prevBusy) || 30000}`);
    db.pragma(`mmap_size = ${_mmapSize}`);
  }
}

/**
 * PRAGMA quick_check reads the whole DB file. On multi‑GB libraries with a cold
 * OS page cache this can take minutes, blocks the event loop, and used to delay
 * HTTP bind until it finished. Large DBs skip it unless DB_QUICK_CHECK=1.
 */
function runStartupIntegrityCheck() {
  try {
    const t0 = Date.now();
    const result = db.pragma('quick_check');
    const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    if (result[0]?.quick_check !== 'ok') {
      console.error('[db] DATABASE INTEGRITY WARNING:', result);
      // logSystemEvent deferred to avoid circular import at module init
      import('./services/system-events.js').then((m) =>
        m.logSystemEvent('error', 'database', 'integrity check failed at startup', { result, seconds })
      ).catch(() => {});
    } else {
      console.log(`[db] integrity check passed (${seconds}s)`);
      if (seconds >= 5) {
        import('./services/system-events.js').then((m) =>
          m.logSystemEvent('info', 'database', 'startup integrity check completed', { seconds })
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[db] integrity check error:', err.message);
  }
}

function envFlagTrue(name) {
  return ['1', 'true', 'yes'].includes(String(process.env[name] || '').trim().toLowerCase());
}

const LARGE_DB_QUICK_CHECK_MB = 256;
let dbFileSizeMb = 0;
try {
  dbFileSizeMb = fs.statSync(config.dbPath).size / (1024 * 1024);
} catch {
  dbFileSizeMb = 0;
}

if (envFlagTrue('SKIP_DB_QUICK_CHECK')) {
  console.log('[db] integrity check skipped (SKIP_DB_QUICK_CHECK)');
} else if (dbFileSizeMb >= LARGE_DB_QUICK_CHECK_MB && !envFlagTrue('DB_QUICK_CHECK')) {
  console.log(
    `[db] integrity check skipped on large DB (${dbFileSizeMb.toFixed(0)} MB). ` +
      'Set DB_QUICK_CHECK=1 to force, or SKIP_DB_QUICK_CHECK=1 to silence this message.'
  );
} else {
  // After listen: do not block port bind. Still freezes the loop for the scan duration.
  setImmediate(runStartupIntegrityCheck);
}

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

  const hasTelegramId = columns.some((column) => column.name === 'telegram_id');
  if (!hasTelegramId) {
    db.exec(`ALTER TABLE users ADD COLUMN telegram_id TEXT DEFAULT NULL`);
  }

  const hasTelegramLinkedAt = columns.some((column) => column.name === 'telegram_linked_at');
  if (!hasTelegramLinkedAt) {
    db.exec(`ALTER TABLE users ADD COLUMN telegram_linked_at TEXT DEFAULT NULL`);
  }

  const hasTelegramBotAllowed = columns.some((column) => column.name === 'telegram_bot_allowed');
  if (!hasTelegramBotAllowed) {
    db.exec(`ALTER TABLE users ADD COLUMN telegram_bot_allowed INTEGER NOT NULL DEFAULT 1`);
  }

  const hasEreaderEmailAllowed = columns.some((column) => column.name === 'ereader_email_allowed');
  if (!hasEreaderEmailAllowed) {
    db.exec(`ALTER TABLE users ADD COLUMN ereader_email_allowed INTEGER NOT NULL DEFAULT 1`);
  }

  const hasEmail = columns.some((column) => column.name === 'email');
  if (!hasEmail) {
    db.exec(`ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''`);
  }

  const hasLocalPassword = columns.some((column) => column.name === 'has_local_password');
  if (!hasLocalPassword) {
    db.exec(`ALTER TABLE users ADD COLUMN has_local_password INTEGER NOT NULL DEFAULT 1`);
  }

  const hasUiHomeView = columns.some((column) => column.name === 'ui_home_view');
  if (!hasUiHomeView) {
    db.exec(`ALTER TABLE users ADD COLUMN ui_home_view TEXT NOT NULL DEFAULT 'grid'`);
  }

  const hasUiCatalogView = columns.some((column) => column.name === 'ui_catalog_view');
  if (!hasUiCatalogView) {
    db.exec(`ALTER TABLE users ADD COLUMN ui_catalog_view TEXT NOT NULL DEFAULT 'grid'`);
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
    ON users(email)
    WHERE email IS NOT NULL AND email != ''
  `);
}

function ensureTelegramChatsSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_chats (
      chat_id TEXT PRIMARY KEY,
      chat_type TEXT NOT NULL DEFAULT 'private',
      title TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      announce_enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_chats_announce ON telegram_chats(announce_enabled);
  `);
}

function ensureTelegramLinkSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_link_tokens (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_username ON telegram_link_tokens(username);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL;
  `);
  dedupeTelegramIds();
}

function ensurePasswordResetSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_username ON password_reset_tokens(username);
  `);
}

function ensureAppPairingSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_pairing_tokens (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_app_pairing_tokens_username ON app_pairing_tokens(username);
  `);
}


function dedupeTelegramIds() {
  const duplicateIds = db.prepare(`
    SELECT telegram_id AS telegramId
    FROM users
    WHERE telegram_id IS NOT NULL
    GROUP BY telegram_id
    HAVING COUNT(*) > 1
  `).all();
  for (const row of duplicateIds) {
    const owners = db.prepare(`
      SELECT username
      FROM users
      WHERE telegram_id = ?
      ORDER BY COALESCE(telegram_linked_at, created_at) DESC, username ASC
    `).all(row.telegramId);
    for (const owner of owners.slice(1)) {
      unlinkTelegram(owner.username);
    }
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

  // Migrate books_fts to index normalized search columns
  const ftsCols = db.prepare(`PRAGMA table_info(books_fts)`).all();
  const ftsNames = new Set(ftsCols.map((c) => c.name));
  if (ftsNames.has('title') || !ftsNames.has('title_search')) {
    db.exec(`DROP TABLE IF EXISTS books_fts;`);
    db.exec(`CREATE VIRTUAL TABLE books_fts USING fts5(
      id UNINDEXED,
      title_search,
      authors_search,
      genres_search,
      series_search,
      keywords_search,
      content='books',
      content_rowid='rowid'
    );`);
    setMeta('books_fts_dirty', '1');
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

let _stmtGetUser = null;
export function getUserByUsername(username) {
  _stmtGetUser ??= db.prepare(`
    SELECT username, password_hash AS passwordHash, role, created_at AS createdAt,
           COALESCE(session_gen, 0) AS sessionGen, COALESCE(blocked, 0) AS blocked,
           telegram_id AS telegramId, telegram_linked_at AS telegramLinkedAt,
           COALESCE(telegram_bot_allowed, 1) AS telegramBotAllowed,
           COALESCE(ereader_email_allowed, 1) AS ereaderEmailAllowed,
           COALESCE(email, '') AS email,
           COALESCE(has_local_password, 1) AS hasLocalPassword
    FROM users
    WHERE username = ?
  `);
  return _stmtGetUser.get(username);
}

let _stmtGetUserByTelegramId = null;
export function getUserByTelegramId(telegramId) {
  const normalized = normalizeTelegramId(telegramId);
  if (!normalized) return null;
  _stmtGetUserByTelegramId ??= db.prepare(`
    SELECT username, password_hash AS passwordHash, role, created_at AS createdAt,
           COALESCE(session_gen, 0) AS sessionGen, COALESCE(blocked, 0) AS blocked,
           telegram_id AS telegramId, telegram_linked_at AS telegramLinkedAt,
           COALESCE(telegram_bot_allowed, 1) AS telegramBotAllowed,
           COALESCE(ereader_email_allowed, 1) AS ereaderEmailAllowed
    FROM users
    WHERE telegram_id = ?
  `);
  return _stmtGetUserByTelegramId.get(normalized);
}

export function isTelegramBotAllowedForUser(user) {
  if (!user || user.blocked) return false;
  return Number(user.telegramBotAllowed ?? 1) !== 0;
}

export function isEreaderEmailAllowedForUser(user) {
  if (!user || user.blocked) return false;
  return Number(user.ereaderEmailAllowed ?? 1) !== 0;
}

export function setUserTelegramBotAllowed(username, allowed) {
  const normalizedUsername = String(username || '').trim();
  const existing = getUserByUsername(normalizedUsername);
  if (!existing) throw new Error('User not found');
  db.prepare(`
    UPDATE users SET telegram_bot_allowed = ? WHERE username = ?
  `).run(allowed ? 1 : 0, normalizedUsername);
  return getUserByUsername(normalizedUsername);
}

export function setUserEreaderEmailAllowed(username, allowed) {
  const normalizedUsername = String(username || '').trim();
  const existing = getUserByUsername(normalizedUsername);
  if (!existing) throw new Error('User not found');
  db.prepare(`
    UPDATE users SET ereader_email_allowed = ? WHERE username = ?
  `).run(allowed ? 1 : 0, normalizedUsername);
  return getUserByUsername(normalizedUsername);
}

export function normalizeTelegramId(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{5,20}$/.test(s)) return null;
  return s;
}

const TELEGRAM_LINK_TOKEN_TTL_MS = 10 * 60_000;

function pruneExpiredTelegramLinkTokens() {
  db.prepare(`DELETE FROM telegram_link_tokens WHERE expires_at < datetime('now')`).run();
}

export function createTelegramLinkToken(username) {
  const normalizedUsername = String(username || '').trim();
  const user = getUserByUsername(normalizedUsername);
  if (!user) throw new Error('User not found');
  if (user.blocked) throw new Error('Account is blocked');
  if (!isTelegramBotAllowedForUser(user)) throw new Error('Telegram bot access denied');

  db.prepare('DELETE FROM telegram_link_tokens WHERE username = ?').run(normalizedUsername);
  pruneExpiredTelegramLinkTokens();

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + TELEGRAM_LINK_TOKEN_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO telegram_link_tokens(token, username, expires_at)
    VALUES(?, ?, ?)
  `).run(token, normalizedUsername, expiresAt);
  return { token, expiresAt };
}

const APP_PAIRING_TOKEN_TTL_MS = 10 * 60_000;

function pruneExpiredAppPairingTokens() {
  db.prepare(`DELETE FROM app_pairing_tokens WHERE expires_at < datetime('now')`).run();
}

export function createAppPairingToken(username) {
  const normalizedUsername = String(username || '').trim();
  const user = getUserByUsername(normalizedUsername);
  if (!user) throw new Error('User not found');
  if (user.blocked) throw new Error('Account is blocked');

  db.prepare('DELETE FROM app_pairing_tokens WHERE username = ?').run(normalizedUsername);
  pruneExpiredAppPairingTokens();

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + APP_PAIRING_TOKEN_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO app_pairing_tokens(token, username, expires_at)
    VALUES(?, ?, ?)
  `).run(token, normalizedUsername, expiresAt);
  return { token, expiresAt };
}

/**
 * Consume a one-time app pairing token. Returns `{ username }` or null.
 */
export function consumeAppPairingToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;

  return db.transaction(() => {
    pruneExpiredAppPairingTokens();
    const row = db.prepare(`
      SELECT token, username, expires_at AS expiresAt
      FROM app_pairing_tokens
      WHERE token = ?
    `).get(normalizedToken);
    if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
      if (row) db.prepare('DELETE FROM app_pairing_tokens WHERE token = ?').run(normalizedToken);
      return null;
    }

    const user = getUserByUsername(row.username);
    db.prepare('DELETE FROM app_pairing_tokens WHERE token = ?').run(normalizedToken);
    if (!user || user.blocked) return null;
    return { username: row.username };
  })();
}

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function pruneExpiredPasswordResetTokens() {
  db.prepare(`DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')`).run();
}

export function normalizePasswordResetEmail(raw) {
  return normalizeLookupEmail(raw);
}

export function isPasswordResetEnabled() {
  return getSetting('password_reset_enabled') === '1';
}

export function getPublicBaseUrlSetting() {
  return String(getSetting('public_base_url') || '').trim().replace(/\/+$/, '');
}

export function setPasswordResetSettings({ enabled, publicBaseUrl }) {
  setSetting('password_reset_enabled', enabled ? '1' : '0');
  setSetting('public_base_url', String(publicBaseUrl || '').trim().replace(/\/+$/, ''));
}

export function isPasswordResetConfigured() {
  if (!isPasswordResetEnabled()) return false;
  return Boolean(getSmtpSettings().host);
}

let _stmtGetUserByEreaderEmail = null;
export function getUserByEreaderEmail(email) {
  const normalized = normalizePasswordResetEmail(email);
  if (!normalized) return null;
  _stmtGetUserByEreaderEmail ??= db.prepare(`
    SELECT username, password_hash AS passwordHash, role, created_at AS createdAt,
           COALESCE(session_gen, 0) AS sessionGen, COALESCE(blocked, 0) AS blocked,
           telegram_id AS telegramId, telegram_linked_at AS telegramLinkedAt,
           COALESCE(telegram_bot_allowed, 1) AS telegramBotAllowed,
           COALESCE(ereader_email_allowed, 1) AS ereaderEmailAllowed,
           COALESCE(ereader_email, '') AS ereaderEmail
    FROM users
    WHERE TRIM(COALESCE(ereader_email, '')) != ''
      AND LOWER(TRIM(ereader_email)) = ?
      AND COALESCE(blocked, 0) = 0
    LIMIT 1
  `);
  return _stmtGetUserByEreaderEmail.get(normalized) || null;
}

export function createPasswordResetToken(username) {
  const normalizedUsername = String(username || '').trim();
  const user = getUserByUsername(normalizedUsername);
  if (!user) throw new Error('User not found');
  if (user.blocked) throw new Error('Account is blocked');
  const ereaderEmail = getEreaderEmail(normalizedUsername);
  if (!normalizePasswordResetEmail(ereaderEmail)) throw new Error('E-reader email is not set');

  db.prepare('DELETE FROM password_reset_tokens WHERE username = ?').run(normalizedUsername);
  pruneExpiredPasswordResetTokens();

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO password_reset_tokens(token, username, expires_at)
    VALUES(?, ?, ?)
  `).run(token, normalizedUsername, expiresAt);
  return { token, expiresAt, ereaderEmail: ereaderEmail.trim() };
}

export function validatePasswordResetToken(token) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;

  pruneExpiredPasswordResetTokens();
  const row = db.prepare(`
    SELECT token, username, expires_at AS expiresAt
    FROM password_reset_tokens
    WHERE token = ?
  `).get(normalizedToken);
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
    if (row) db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(normalizedToken);
    return null;
  }

  const user = getUserByUsername(row.username);
  if (!user || user.blocked) {
    db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(normalizedToken);
    return null;
  }

  return { username: row.username };
}

export function completePasswordReset(token, newPassword) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;

  return db.transaction(() => {
    const valid = validatePasswordResetToken(normalizedToken);
    if (!valid) return null;

    changePassword(valid.username, newPassword);
    db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(normalizedToken);
    db.prepare('DELETE FROM password_reset_tokens WHERE username = ?').run(valid.username);
    return { username: valid.username };
  })();
}

export function completeTelegramLink(token, telegramId) {
  const normalizedToken = String(token || '').trim();
  const normalizedTgId = normalizeTelegramId(telegramId);
  if (!normalizedToken) throw new Error('Invalid link token');
  if (!normalizedTgId) throw new Error('Invalid Telegram ID');

  return db.transaction(() => {
    pruneExpiredTelegramLinkTokens();
    const row = db.prepare(`
      SELECT token, username, expires_at AS expiresAt
      FROM telegram_link_tokens
      WHERE token = ?
    `).get(normalizedToken);
    if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
      if (row) db.prepare('DELETE FROM telegram_link_tokens WHERE token = ?').run(normalizedToken);
      throw new Error('Link token expired or invalid');
    }

    const existingUser = getUserByTelegramId(normalizedTgId);
    if (existingUser && existingUser.username !== row.username) {
      throw new Error('This Telegram account is already linked to another user');
    }

    const target = getUserByUsername(row.username);
    if (!target || target.blocked) throw new Error('Account is blocked');
    if (!isTelegramBotAllowedForUser(target)) throw new Error('Telegram bot access denied');
    if (target.telegramId && target.telegramId !== normalizedTgId) {
      throw new Error('User already has a different Telegram account linked');
    }

    releaseTelegramIdFromOtherUsers(normalizedTgId, row.username);

    db.prepare(`
      UPDATE users
      SET telegram_id = ?, telegram_linked_at = datetime('now')
      WHERE username = ?
    `).run(normalizedTgId, row.username);
    db.prepare('DELETE FROM telegram_link_tokens WHERE username = ?').run(row.username);

    return { username: row.username, telegramId: normalizedTgId };
  })();
}

export function unlinkTelegram(username) {
  const normalizedUsername = String(username || '').trim();
  db.prepare(`
    UPDATE users SET telegram_id = NULL, telegram_linked_at = NULL WHERE username = ?
  `).run(normalizedUsername);
  db.prepare('DELETE FROM telegram_link_tokens WHERE username = ?').run(normalizedUsername);
}

export function unlinkTelegramByTelegramId(telegramId) {
  const user = getUserByTelegramId(telegramId);
  if (!user) return false;
  unlinkTelegram(user.username);
  return true;
}

function releaseTelegramIdFromOtherUsers(telegramId, exceptUsername) {
  const normalizedId = normalizeTelegramId(telegramId);
  const normalizedUsername = String(exceptUsername || '').trim();
  if (!normalizedId || !normalizedUsername) return;
  db.prepare(`
    UPDATE users
    SET telegram_id = NULL, telegram_linked_at = NULL
    WHERE telegram_id = ? AND username != ?
  `).run(normalizedId, normalizedUsername);
}

export function setUserTelegramId(username, telegramId) {
  const normalizedUsername = String(username || '').trim();
  const existing = getUserByUsername(normalizedUsername);
  if (!existing) throw new Error('User not found');

  const raw = String(telegramId ?? '').trim();
  if (!raw) {
    unlinkTelegram(normalizedUsername);
    return getUserByUsername(normalizedUsername);
  }

  const normalized = normalizeTelegramId(raw);
  if (!normalized) throw new Error('Invalid Telegram ID');

  const owner = getUserByTelegramId(normalized);
  if (owner && owner.username !== normalizedUsername) {
    throw new Error('This Telegram account is already linked to another user');
  }

  releaseTelegramIdFromOtherUsers(normalized, normalizedUsername);

  db.prepare(`
    UPDATE users
    SET telegram_id = ?, telegram_linked_at = datetime('now')
    WHERE username = ?
  `).run(normalized, normalizedUsername);
  db.prepare('DELETE FROM telegram_link_tokens WHERE username = ?').run(normalizedUsername);
  return getUserByUsername(normalizedUsername);
}

export function getTelegramBotUsername() {
  return getMeta('telegram_bot_username') || '';
}

let _stmtListUsers = null;
export function listUsers() {
  _stmtListUsers ??= db.prepare(`
    SELECT u.username, u.role, u.created_at AS createdAt,
      COALESCE(u.blocked, 0) AS blocked,
      u.telegram_id AS telegramId,
      u.telegram_linked_at AS telegramLinkedAt,
      COALESCE(u.telegram_bot_allowed, 1) AS telegramBotAllowed,
      COALESCE(u.ereader_email_allowed, 1) AS ereaderEmailAllowed,
      COALESCE(u.ereader_email, '') AS ereaderEmail,
      (SELECT COUNT(*) FROM reading_history rh WHERE rh.username = u.username) AS readingCount,
      (SELECT MAX(rh.last_opened_at) FROM reading_history rh WHERE rh.username = u.username) AS lastReadAt
    FROM users u
    ORDER BY role DESC, username ASC
  `);
  return _stmtListUsers.all();
}

let _stmtCountAdmins = null;
export function hasAdminUser() {
  _stmtCountAdmins ??= db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
  const row = _stmtCountAdmins.get();
  return Number(row?.count || 0) > 0;
}

export function countAdminUsers() {
  _stmtCountAdmins ??= db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
  const row = _stmtCountAdmins.get();
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
    db.prepare(`DELETE FROM telegram_link_tokens WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM password_reset_tokens WHERE username = ?`).run(normalizedUsername);
    db.prepare(`DELETE FROM app_pairing_tokens WHERE username = ?`).run(normalizedUsername);
    return db.prepare(`DELETE FROM users WHERE username = ?`).run(normalizedUsername).changes;
  })();
}

let _stmtBlockUser = null;
export function blockUser(username) {
  _stmtBlockUser ??= db.prepare(`UPDATE users SET blocked = 1 WHERE username = ?`);
  _stmtBlockUser.run(String(username || '').trim());
}

let _stmtUnblockUser = null;
export function unblockUser(username) {
  _stmtUnblockUser ??= db.prepare(`UPDATE users SET blocked = 0 WHERE username = ?`);
  _stmtUnblockUser.run(String(username || '').trim());
}

/** Триггеры синхронизации fts5 (content='books') с таблицей books. */
/*
 * Для fts5 с content='books' токены строятся из значений, переданных в INSERT/'delete'.
 * Вставка без колонок (INSERT INTO books_fts(rowid) VALUES (?)) создаёт строку в docsize,
 * но НЕ индексирует текст — MATCH ничего не находит, поиск молча уходит в LIKE по всей таблице.
 */
const BOOKS_FTS_COLUMNS = 'id, title_search, authors_search, genres_search, series_search, keywords_search';
const BOOKS_FTS_NEW_VALUES = 'new.id, new.title_search, new.authors_search, new.genres_search, new.series_search, new.keywords_search';
const BOOKS_FTS_OLD_VALUES = 'old.id, old.title_search, old.authors_search, old.genres_search, old.series_search, old.keywords_search';

const BOOKS_FTS_TRIGGERS_SQL = `
  CREATE TRIGGER books_ai AFTER INSERT ON books BEGIN
    INSERT INTO books_fts(rowid, ${BOOKS_FTS_COLUMNS}) VALUES (new.rowid, ${BOOKS_FTS_NEW_VALUES});
  END;
  CREATE TRIGGER books_ad AFTER DELETE ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, ${BOOKS_FTS_COLUMNS}) VALUES('delete', old.rowid, ${BOOKS_FTS_OLD_VALUES});
  END;
  CREATE TRIGGER books_au AFTER UPDATE OF ${BOOKS_FTS_COLUMNS} ON books BEGIN
    INSERT INTO books_fts(books_fts, rowid, ${BOOKS_FTS_COLUMNS}) VALUES('delete', old.rowid, ${BOOKS_FTS_OLD_VALUES});
    INSERT INTO books_fts(rowid, ${BOOKS_FTS_COLUMNS}) VALUES (new.rowid, ${BOOKS_FTS_NEW_VALUES});
  END;
`;

export function ensureBooksFtsTriggers() {
  // Старые БД содержат триггеры без значений колонок — пересоздаём, а не IF NOT EXISTS.
  dropBooksFtsTriggers();
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

/* ── Exclusive operation lock: prevents simultaneous indexing + deletion ── */
let _activeOperation = null; // 'indexing' | 'deleting' | null

export function beginExclusiveOperation(opName) {
  if (_activeOperation && _activeOperation !== opName) {
    throw new Error(`Cannot start ${opName}: ${_activeOperation} is already in progress`);
  }
  _activeOperation = opName;
}

export function endExclusiveOperation(opName) {
  if (_activeOperation === opName) {
    _activeOperation = null;
  }
}

export function getActiveOperation() {
  return _activeOperation;
}

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
    db.pragma('synchronous = NORMAL');

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

let _savedBulkImportIndexes = [];

/** Удалить все пользовательские индексы на таблицах массового импорта.
 *  Сохраняет CREATE-выражения для ensureBulkImportIndexes().
 *  Автоматические индексы (sql IS NULL) и внутренние FTS-индексы игнорируются.
 */
export function dropBulkImportIndexes() {
  _savedBulkImportIndexes = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index'
      AND tbl_name IN ('books', 'book_authors', 'book_genres', 'book_series', 'authors', 'series_catalog', 'genres_catalog')
      AND sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
  `).all();
  for (const idx of _savedBulkImportIndexes) {
    db.exec(`DROP INDEX IF EXISTS ${idx.name}`);
  }
}

/** Восстановить индексы, удалённые dropBulkImportIndexes(). */
export function ensureBulkImportIndexes() {
  for (const idx of _savedBulkImportIndexes) {
    if (idx.sql) {
      db.exec(idx.sql);
    }
  }
  _savedBulkImportIndexes = [];
}

/**
 * То же, что ensureBulkImportIndexes, но с уступкой event loop и опциональным прогрессом.
 * После FTS UI иначе «замирает» на минуты, пока синхронно создаются индексы на сотнях тысяч строк.
 */
export async function ensureBulkImportIndexesAsync(options = {}) {
  const { onProgress } = options;
  const pending = _savedBulkImportIndexes.slice();
  _savedBulkImportIndexes = [];
  const total = pending.length;
  if (!total) return;

  console.log(`[index] DB: восстановление ${total} индексов после импорта…`);
  appendIndexDiaryLine(`БД: восстановление ${total} индексов после импорта…`);
  const t0 = Date.now();
  let done = 0;

  for (const idx of pending) {
    if (!idx.sql) {
      done += 1;
      continue;
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({ done, total, name: idx.name, phase: 'building' });
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    const tIdx = Date.now();
    db.exec(idx.sql);
    done += 1;
    const idxMs = Date.now() - tIdx;
    if (idxMs > 3000) {
      console.log(`[index] DB: индекс ${idx.name} — ${(idxMs / 1000).toFixed(1)} с (${done}/${total})`);
      appendIndexDiaryLine(`БД: индекс ${idx.name} — ${(idxMs / 1000).toFixed(1)} с (${done}/${total})`);
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({ done, total, name: idx.name, phase: 'done' });
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[index] DB: индексы восстановлены за ${sec} с`);
  appendIndexDiaryLine(`БД: индексы восстановлены за ${sec} с`);
}

let _savedBooksIndexes = [];

/** Удалить пользовательские индексы только на таблице books.
 *  Оставляет junction-индексы (book_authors и т.д.) — они нужны для FK CASCADE.
 */
export function dropBooksTableIndexes() {
  _savedBooksIndexes = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'books'
      AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
  `).all();
  for (const idx of _savedBooksIndexes) {
    db.exec(`DROP INDEX IF EXISTS ${idx.name}`);
  }
}

/** Восстановить индексы таблицы books, удалённые dropBooksTableIndexes(). */
export async function ensureBooksTableIndexes() {
  for (const idx of _savedBooksIndexes) {
    if (idx.sql) {
      db.exec(idx.sql);
    }
    await new Promise((r) => setImmediate(r));
  }
  _savedBooksIndexes = [];
  /* DROP INDEX стирает строки sqlite_stat1; без них планировщик берёт индекс deleted=0
     и сортирует весь каталог в TEMP B-TREE (~800 мс на страницу вместо 1–8 мс). */
  await analyzeBooksIndexesYielding();
}

/**
 * ANALYZE по каждому индексу books отдельно (100–300 мс на 600k строк) с уступкой event loop,
 * затем сброс кэшированных prepared statements — иначе они остаются со старыми планами.
 */
export async function analyzeBooksIndexesYielding() {
  const names = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'books' ORDER BY name
  `).all().map((r) => r.name);
  const t0 = Date.now();
  for (const name of names) {
    try {
      db.exec(`ANALYZE ${sqliteQuoteIdent(name)}`);
    } catch (err) {
      console.warn(`[analyze] skip ${name}:`, err.message);
    }
    await new Promise((r) => setImmediate(r));
  }
  resetDbPreparedStatements();
  for (const cb of _viewResetCallbacks) cb();
  console.log(`[analyze] books indexes: ${names.length} in ${Date.now() - t0} ms`);
}

/** Статистика индексов books отсутствует/неполная (например, после DROP INDEX без ANALYZE). */
export function booksIndexStatsMissing() {
  const idx = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index' AND tbl_name = 'books'`).get()?.c ?? 0;
  let stats = 0;
  try {
    stats = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_stat1 WHERE tbl = 'books'`).get()?.c ?? 0;
  } catch {
    return true;
  }
  return stats < idx;
}

/**
 * Полная пересборка FTS после массового импорта без триггеров.
 * Одна команда VALUES('rebuild') блокирует event loop на минуты при сотнях тысяч книг;
 * поэтому по умолчанию: delete-all + батчи INSERT с уступкой циклу; при сбое — классический rebuild.
 */
const FTS_REBUILD_PROGRESS_KEY = 'fts_rebuild_last_rowid';

export async function rebuildBooksFtsFromContent(options = {}) {
  const { onProgress } = options;
  try {
    // Check for saved progress from a previous interrupted rebuild
    const savedProgress = db.prepare('SELECT value FROM meta WHERE key = ?').get(FTS_REBUILD_PROGRESS_KEY);
    let lastRowid = savedProgress ? Number(savedProgress.value) : 0;
    const resuming = lastRowid > 0;

    await new Promise((resolve) => setImmediate(resolve));

    if (!resuming) {
      // Fresh rebuild — delete all FTS content first
      appendIndexDiaryLine('FTS: команда delete-all (может занять до нескольких минут на огромной БД)…');
      console.log('[index] FTS: delete-all…');
      const tDel0 = Date.now();
      db.exec(`INSERT INTO books_fts(books_fts) VALUES('delete-all')`);
      console.log(`[index] FTS: delete-all готово за ${((Date.now() - tDel0) / 1000).toFixed(1)} с`);
      appendIndexDiaryLine(`FTS: delete-all завершён за ${Date.now() - tDel0} ms`);
    } else {
      console.log(`[index] FTS: resuming rebuild from rowid ${lastRowid}`);
      appendIndexDiaryLine(`FTS: resuming rebuild from rowid ${lastRowid}`);
    }

    const total = db.prepare('SELECT COUNT(*) AS c FROM books').get()?.c ?? 0;
    // Адаптивный размер батча: меньше для крупных библиотек, чтобы не блокировать HTTP
    // Каждая строка токенизируется (слабый CPU NAS: ~1000 строк = секунды блокировки) — батчи небольшие.
    const BATCH = total > 500_000 ? 300 : 500;
    const sel = db.prepare(`
      SELECT rowid FROM books
      WHERE rowid > ? ORDER BY rowid LIMIT ?
    `);
    const ins = db.prepare(`
      INSERT INTO books_fts(rowid, ${BOOKS_FTS_COLUMNS})
      SELECT rowid, ${BOOKS_FTS_COLUMNS} FROM books WHERE rowid = ?
    `);
    let done = resuming ? db.prepare('SELECT COUNT(*) AS c FROM books WHERE rowid <= ?').get(lastRowid)?.c ?? 0 : 0;
    let batchNum = 0;
    const saveProgress = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    for (;;) {
      const rows = sel.all(lastRowid, BATCH);
      if (!rows.length) break;
      lastRowid = rows[rows.length - 1].rowid;
      db.transaction(() => {
        for (const r of rows) {
          ins.run(r.rowid);
        }
        saveProgress.run(FTS_REBUILD_PROGRESS_KEY, String(lastRowid));
      })();
      done += rows.length;
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
    // Rebuild complete — remove progress marker
    db.prepare('DELETE FROM meta WHERE key = ?').run(FTS_REBUILD_PROGRESS_KEY);
    console.log(`[index] FTS: поэтапная сборка завершена (${done} документов)`);
  } catch (err) {
    console.warn('[index] FTS: поэтапная пересборка не удалась, одна команда rebuild:', err?.message || err);
    db.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild')`);
    // Clean up progress marker after fallback full rebuild
    try { db.prepare('DELETE FROM meta WHERE key = ?').run(FTS_REBUILD_PROGRESS_KEY); } catch {}
  }
}

export function runIntegrityCheck() {
  try {
    const result = db.pragma('integrity_check(100)');
    return { ok: result[0]?.integrity_check === 'ok', details: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Синхронный полный rebuild — только если нужен явный fallback (тесты, скрипты). */
export function rebuildBooksFtsFromContentSync() {
  db.exec(`INSERT INTO books_fts(books_fts) VALUES('rebuild')`);
}

function migrateBookSeriesJunction() {
  const cols = db.prepare(`PRAGMA table_info(book_series)`).all();
  const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
  if (pkCols.length > 1 || !pkCols.includes('book_id') || pkCols.includes('series_id')) {
    return;
  }
  console.log('[db] Миграция book_series: смена PRIMARY KEY на (book_id, series_id)...');
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      CREATE TABLE book_series_new (
        book_id TEXT NOT NULL,
        series_id INTEGER NOT NULL,
        series_no TEXT,
        PRIMARY KEY (book_id, series_id),
        FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
        FOREIGN KEY (series_id) REFERENCES series_catalog(id) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO book_series_new SELECT book_id, series_id, series_no FROM book_series;
      DROP TABLE book_series;
      ALTER TABLE book_series_new RENAME TO book_series;
      CREATE INDEX IF NOT EXISTS idx_book_series_series_id ON book_series(series_id);
      CREATE INDEX IF NOT EXISTS idx_book_series_book_id ON book_series(book_id);
    `);
    console.log('[db] Миграция book_series завершена. Для восстановления множественных серий выполните полную переиндексацию.');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function ensureBookSeriesNoColumn() {
  const cols = db.pragma('table_info(book_series)').map((c) => c.name);
  if (!cols.includes('series_no')) {
    db.exec('ALTER TABLE book_series ADD COLUMN series_no TEXT');
    console.log('[db] Добавлена колонка series_no в book_series');
  }
}

function ensureLibRateColumn() {
  const cols = db.pragma('table_info(books)').map((c) => c.name);
  if (!cols.includes('lib_rate')) {
    db.exec('ALTER TABLE books ADD COLUMN lib_rate INTEGER');
    console.log('[db] Добавлена колонка lib_rate в books');
  }
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
      lib_rate INTEGER,
      imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(
      id UNINDEXED,
      title_search,
      authors_search,
      genres_search,
      series_search,
      keywords_search,
      content='books',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS search_title_tokens (
      token TEXT PRIMARY KEY,
      freq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      username TEXT NOT NULL,
      book_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, book_id),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS read_books (
      username TEXT NOT NULL,
      book_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (username, book_id),
      FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
    );

/* Retroactively mark books with 95%+ reading progress as read */
INSERT OR IGNORE INTO read_books(username, book_id, created_at)
SELECT rp.username, rp.book_id, rp.updated_at
FROM reading_positions rp
WHERE rp.progress >= 99
  AND NOT EXISTS (SELECT 1 FROM read_books rb WHERE rb.username = rp.username AND rb.book_id = rp.book_id);

    CREATE TABLE IF NOT EXISTS book_ratings (
      username TEXT NOT NULL,
      book_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
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
      book_id TEXT NOT NULL,
      series_id INTEGER NOT NULL,
      series_no TEXT,
      PRIMARY KEY (book_id, series_id),
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

    /* Лог запусков планировщика сканирования. Храним последние ~50 записей,
       обрезаем при вставке. Используется чисто для отображения админу. */
    CREATE TABLE IF NOT EXISTS scan_schedule_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      mode TEXT NOT NULL DEFAULT '',
      full INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'started',
      message TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_scan_schedule_log_ran ON scan_schedule_log(ran_at DESC);

    CREATE TABLE IF NOT EXISTS excluded_filters (
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (type, value)
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
  runMigrations(db);
  ensureTelegramLinkSchema();
  ensureTelegramChatsSchema();
  ensurePasswordResetSchema();
  ensureAppPairingSchema();
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
  migrateBookSeriesJunction();
  ensureBookSeriesNoColumn();
  ensureLibRateColumn();

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

  const SCHEMA_BOOT_KEY = 'schema_bootstrap_v6';
  const schemaBootDone = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SCHEMA_BOOT_KEY)?.value === '1';
  if (!schemaBootDone) {
    db.exec(`DROP VIEW IF EXISTS active_books`);
    db.exec(`CREATE VIEW active_books AS SELECT b.* FROM books b LEFT JOIN sources s ON s.id = b.source_id WHERE b.deleted = 0 AND (b.source_id IS NULL OR s.enabled = 1)`);
    db.prepare(`
      INSERT INTO meta(key, value) VALUES(?, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(SCHEMA_BOOT_KEY);
  }
  // Fast path: recreate view only if unexpectedly missing.
  const hasActiveBooksView = Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'active_books'`).get()
  );
  if (!hasActiveBooksView) {
    db.exec(`CREATE VIEW active_books AS SELECT b.* FROM books b LEFT JOIN sources s ON s.id = b.source_id WHERE b.deleted = 0 AND (b.source_id IS NULL OR s.enabled = 1)`);
  }

  ensureBooksFtsTriggers();
  ensureSearchTitleTokensTable();

  // FTS rebuild after crash can take minutes on large libraries — defer until HTTP is up.
  scheduleBootFtsRecoveryIfNeeded();

  seedDefaultAdmin();
  migrateInpxToSources();
}

export function ensureSearchTitleTokensTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_title_tokens (
      token TEXT PRIMARY KEY,
      freq INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** @returns {boolean} */
export function isBootFtsRecoveryPending() {
  return db.prepare(`SELECT value FROM meta WHERE key = 'books_fts_dirty'`).get()?.value === '1';
}

const FTS_HEALTH_TTL_MS = 60_000;
let _ftsHealthCache = { at: 0, status: null };
let _ftsRebuildScheduled = false;

function countBooksFtsDocs() {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS c FROM books_fts_docsize').get()?.c) || 0;
  } catch {
    return 0;
  }
}

/**
 * false — в docsize есть строки, но инвертированный индекс пуст (сборка без значений колонок):
 * MATCH ничего не находит, а счётчик строк выглядит «здоровым».
 */
function booksFtsHasTokens() {
  try {
    return Boolean(db.prepare('SELECT 1 FROM books_fts_idx LIMIT 1').get());
  } catch {
    return true;
  }
}

/** До этого размера восстановление FTS — один синхронный rebuild; больше — поэтапно, без блокировки HTTP. */
const FTS_SYNC_REBUILD_MAX_BOOKS = 50_000;

/**
 * FTS health for admin / search hot path.
 * status: ok | dirty | rebuilding | desynced | empty
 * @param {{ force?: boolean, recover?: boolean }} [opts]
 */
export function getBooksFtsStatus({ force = false, recover = false } = {}) {
  const now = Date.now();
  if (!force && _ftsHealthCache.status && now - _ftsHealthCache.at < FTS_HEALTH_TTL_MS) {
    return { ..._ftsHealthCache.status };
  }

  const dirty = getMeta('books_fts_dirty') === '1';
  const rebuildProgress = getMeta(FTS_REBUILD_PROGRESS_KEY);
  const booksCount = Number(db.prepare('SELECT COUNT(*) AS c FROM books').get()?.c) || 0;
  const ftsDocCount = countBooksFtsDocs();

  let status = 'ok';
  if (dirty && rebuildProgress) status = 'rebuilding';
  else if (dirty) status = 'dirty';
  else if (booksCount === 0) status = 'empty';
  else if (ftsDocCount === 0 || ftsDocCount < Math.floor(booksCount * 0.5) || !booksFtsHasTokens()) status = 'desynced';

  const snapshot = {
    status,
    dirty,
    booksCount,
    ftsDocCount,
    rebuilding: status === 'rebuilding' || Boolean(rebuildProgress)
  };
  _ftsHealthCache = { at: now, status: snapshot };

  if (recover && !_ftsRebuildScheduled) {
    if (status === 'desynced') {
      console.warn(
        `[fts] index desynced (books=${booksCount}, fts_docs=${ftsDocCount}) — marking dirty and scheduling rebuild`
      );
      setMeta('books_fts_dirty', '1');
      import('./services/system-events.js').then((m) => {
        m.logSystemEvent('warn', 'database', 'FTS index desynced — recovery scheduled', {
          booksCount,
          ftsDocCount
        });
      }).catch(() => {});
      invalidateBooksFtsHealthCache();
      scheduleBootFtsRecoveryIfNeeded();
      return getBooksFtsStatus({ force: true, recover: false });
    }
    if (status === 'dirty') {
      /* Search hot path: do not wait for next boot — rebuild in background. */
      scheduleBootFtsRecoveryIfNeeded();
    }
  }

  return { ...snapshot };
}

export function invalidateBooksFtsHealthCache() {
  _ftsHealthCache = { at: 0, status: null };
}

/** True when search may use books_fts MATCH (not dirty/desynced/rebuilding). */
export function isBooksFtsUsable() {
  const snap = getBooksFtsStatus({ recover: true });
  return snap.status === 'ok' || snap.status === 'empty';
}

/** Восстановление FTS после сбоя индексации — в фоне, не блокирует открытие порта. */
export function scheduleBootFtsRecoveryIfNeeded() {
  if (!isBootFtsRecoveryPending()) return;
  if (_ftsRebuildScheduled) return;
  _ftsRebuildScheduled = true;
  setImmediate(async () => {
    console.warn('[boot] FTS index marked dirty — rebuilding in background…');
    import('./services/system-events.js').then((m) => {
      m.logSystemEvent('info', 'database', 'FTS boot recovery started');
    }).catch(() => {});
    const t0 = Date.now();
    try {
      const booksCount = Number(db.prepare('SELECT COUNT(*) AS c FROM books').get()?.c) || 0;
      if (booksCount > FTS_SYNC_REBUILD_MAX_BOOKS) await rebuildBooksFtsFromContent();
      else rebuildBooksFtsFromContentSync();
      db.prepare(`INSERT INTO meta(key, value) VALUES('books_fts_dirty', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run();
      try { db.prepare('DELETE FROM meta WHERE key = ?').run(FTS_REBUILD_PROGRESS_KEY); } catch { /* ignore */ }
      invalidateBooksFtsHealthCache();
      const seconds = Math.round((Date.now() - t0) / 1000);
      console.log(`[boot] FTS index rebuilt in background (${seconds} s)`);
      import('./services/system-events.js').then((m) => {
        m.logSystemEvent('info', 'database', 'FTS boot recovery completed', { seconds });
      }).catch(() => {});
      import('./search-enhance.js').then((m) => {
        try { m.warmupSearchFts(); } catch { /* ignore */ }
      }).catch(() => {});
    } catch (err) {
      console.error('[boot] FTS background rebuild failed:', err.message);
      import('./services/system-events.js').then((m) => {
        m.logSystemEvent('error', 'database', 'FTS boot recovery failed', { error: err.message });
      }).catch(() => {});
    } finally {
      _ftsRebuildScheduled = false;
      invalidateBooksFtsHealthCache();
    }
  });
}

/**
 * Создаёт индексы схемы по одному с уступкой event loop — предотвращает
 * многосекундную блокировку HTTP-сервера при старте на большой БД.
 */
export function ensureSchemaIndexes() {
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_book_authors_author_id ON book_authors(author_id)',
    'CREATE INDEX IF NOT EXISTS idx_book_authors_book_id ON book_authors(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_book_genres_genre_id ON book_genres(genre_id)',
    'CREATE INDEX IF NOT EXISTS idx_book_genres_book_id ON book_genres(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_book_series_series_id ON book_series(series_id)',
    'CREATE INDEX IF NOT EXISTS idx_book_series_book_id ON book_series(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_books_title_sort ON books(title_sort)',
    'CREATE INDEX IF NOT EXISTS idx_books_title_author_sort ON books(title_sort, author_sort) WHERE deleted = 0',
    'CREATE INDEX IF NOT EXISTS idx_books_author_sort ON books(author_sort)',
    'CREATE INDEX IF NOT EXISTS idx_books_series_sort_series_index ON books(series_sort, series_index)',
    'CREATE INDEX IF NOT EXISTS idx_books_imported_at ON books(imported_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_books_date_imported_at ON books(date DESC, imported_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_books_title_search ON books(title_search)',
    'CREATE INDEX IF NOT EXISTS idx_books_authors_search ON books(authors_search)',
    'CREATE INDEX IF NOT EXISTS idx_books_series_search ON books(series_search)',
    'CREATE INDEX IF NOT EXISTS idx_books_genres_search ON books(genres_search)',
    'CREATE INDEX IF NOT EXISTS idx_books_keywords_search ON books(keywords_search)',
    'CREATE INDEX IF NOT EXISTS idx_authors_sort_name ON authors(sort_name)',
    'CREATE INDEX IF NOT EXISTS idx_authors_search_name ON authors(search_name)',
    'CREATE INDEX IF NOT EXISTS idx_series_catalog_sort_name ON series_catalog(sort_name)',
    'CREATE INDEX IF NOT EXISTS idx_series_catalog_search_name ON series_catalog(search_name)',
    'CREATE INDEX IF NOT EXISTS idx_genres_catalog_sort_name ON genres_catalog(sort_name)',
    'CREATE INDEX IF NOT EXISTS idx_genres_catalog_search_name ON genres_catalog(search_name)',
    'CREATE INDEX IF NOT EXISTS idx_reading_history_username_opened ON reading_history(username, last_opened_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_system_events_created_at ON system_events(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_books_source_id ON books(source_id)',
    'CREATE INDEX IF NOT EXISTS idx_books_lib_id ON books(lib_id) WHERE deleted = 0 AND lib_id IS NOT NULL AND TRIM(lib_id) != \'\'' ,
    'CREATE INDEX IF NOT EXISTS idx_books_deleted ON books(deleted)',
    'CREATE INDEX IF NOT EXISTS idx_books_deleted_source ON books(deleted, source_id)',
    'CREATE INDEX IF NOT EXISTS idx_books_lang ON books(lang)',
    'CREATE INDEX IF NOT EXISTS idx_books_ext ON books(ext)',
    "CREATE INDEX IF NOT EXISTS idx_books_lang_norm ON books(COALESCE(NULLIF(lang, ''), 'unknown'))",
    'CREATE INDEX IF NOT EXISTS idx_books_series_index_title ON books(series_index, title_sort, id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_bookmarks_username ON bookmarks(username)',
    'CREATE INDEX IF NOT EXISTS idx_bookmarks_book_id ON bookmarks(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_bookmarks_username_book_id ON bookmarks(username, book_id)',
    'CREATE INDEX IF NOT EXISTS idx_reading_history_book_id ON reading_history(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_reading_history_book_user_open ON reading_history(book_id, username, last_opened_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_reading_history_username_book ON reading_history(username, book_id, last_opened_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_reader_bookmarks_username ON reader_bookmarks(username)',
    'CREATE INDEX IF NOT EXISTS idx_shelf_books_book_id ON shelf_books(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_shelf_books_shelf_id ON shelf_books(shelf_id)',
    'CREATE INDEX IF NOT EXISTS idx_read_books_username ON read_books(username, book_id)',
    'CREATE INDEX IF NOT EXISTS idx_favorite_authors_username ON favorite_authors(username)',
    'CREATE INDEX IF NOT EXISTS idx_favorite_series_username ON favorite_series(username)',
    'CREATE INDEX IF NOT EXISTS idx_shelves_username ON shelves(username)',
    'CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled)',
    'CREATE INDEX IF NOT EXISTS idx_dedup_projection_sort_date ON library_dedup_projection(sort_date DESC, book_id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_dedup_projection_title ON library_dedup_projection(title_sort ASC, book_id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_dedup_projection_author_title ON library_dedup_projection(author_sort ASC, title_sort ASC, book_id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_dedup_projection_series ON library_dedup_projection(series_sort ASC, series_index ASC, title_sort ASC, book_id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_books_deleted_deleted0 ON books(deleted) WHERE deleted = 0',
    'CREATE INDEX IF NOT EXISTS idx_books_deleted_lang ON books(deleted, lang) WHERE deleted = 0',
    'CREATE INDEX IF NOT EXISTS idx_books_deleted_ext ON books(deleted, ext) WHERE deleted = 0',
    'CREATE INDEX IF NOT EXISTS idx_book_details_cache_book_id ON book_details_cache(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_authors_book_count ON authors(book_count DESC)',
    'CREATE INDEX IF NOT EXISTS idx_series_catalog_book_count ON series_catalog(book_count DESC)',
    'CREATE INDEX IF NOT EXISTS idx_genres_catalog_book_count ON genres_catalog(book_count DESC)',
    'CREATE INDEX IF NOT EXISTS idx_book_ratings_book ON book_ratings(book_id)',
    'CREATE INDEX IF NOT EXISTS idx_book_ratings_user_book ON book_ratings(username, book_id)',
    // Expression indexes для facet-запросов
    "CREATE INDEX IF NOT EXISTS idx_books_recent_sort ON books(COALESCE(NULLIF(date, ''), imported_at) DESC, imported_at DESC, id DESC)",
    // Новинки: MAX/диапазон/сортировка по SUBSTR(date,1,10) — без индекса это три полных скана по ~850 мс
    'CREATE INDEX IF NOT EXISTS idx_books_date10 ON books(SUBSTR(date, 1, 10))',
    // Каталог по названию (сортировка по умолчанию): точное совпадение с ORDER BY resolveSort('title'),
    // иначе каждая страница листания = сортировка всех книг в TEMP B-TREE
    'CREATE INDEX IF NOT EXISTS idx_books_title_nocase_id ON books(title_sort ASC, title COLLATE NOCASE ASC, id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_books_author_title_id ON books(author_sort ASC, title_sort ASC, id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_books_series_full ON books(series_sort ASC, series_index ASC, title_sort ASC, id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_books_rating ON books(lib_rate DESC, title_sort ASC, id DESC)',
    // Критические индексы для facet-запросов
    'CREATE INDEX IF NOT EXISTS idx_authors_name ON authors(name)',
    'CREATE INDEX IF NOT EXISTS idx_series_catalog_name ON series_catalog(name)',
    'CREATE INDEX IF NOT EXISTS idx_genres_catalog_name ON genres_catalog(name)',
    'CREATE INDEX IF NOT EXISTS idx_flibusta_author_shard_key ON flibusta_author_shard(author_key COLLATE NOCASE)',
  ];

  let i = 0;
  let created = 0;
  const indexCountBefore = () =>
    db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'index'`).get()?.c ?? 0;
  let beforeCount = indexCountBefore();

  function step() {
    if (i >= indexes.length) {
      // CREATE INDEX IF NOT EXISTS is cheap when present; ANALYZE on a multi‑GB DB is not.
      // Only ANALYZE when this boot actually added indexes.
      if (created > 0) {
        console.log(`[boot] Создано индексов: ${created} — запускаем ANALYZE в фоне…`);
        analyzeDatabaseYielding()
          .then(() => console.log('[boot] ANALYZE завершён после создания индексов.'))
          .catch((err) => console.warn('[boot] ANALYZE после индексов не удался:', err.message));
      } else if (booksIndexStatsMissing()) {
        console.log('[boot] Нет статистики индексов books — ANALYZE по индексам в фоне…');
        analyzeBooksIndexesYielding()
          .catch((err) => console.warn('[boot] ANALYZE индексов books не удался:', err.message));
      }
      return;
    }
    try {
      db.exec(indexes[i]);
      const afterCount = indexCountBefore();
      if (afterCount > beforeCount) {
        created += afterCount - beforeCount;
        beforeCount = afterCount;
      }
    } catch (err) {
      console.warn('[boot] skip index:', err.message);
    }
    i += 1;
    setImmediate(step);
  }
  step();
}

// --- Sources CRUD ---

let _stmtGetSources = null;
export function getSources() {
  _stmtGetSources ??= db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    ORDER BY created_at ASC
  `);
  return _stmtGetSources.all();
}

let _stmtGetEnabledSources = null;
export function getEnabledSources() {
  _stmtGetEnabledSources ??= db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    WHERE enabled = 1
    ORDER BY created_at ASC
  `);
  return _stmtGetEnabledSources.all();
}

let _stmtGetSourceById = null;
export function getSourceById(id) {
  _stmtGetSourceById ??= db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    WHERE id = ?
  `);
  return _stmtGetSourceById.get(id) || null;
}

let _stmtGetSourceByPath = null;
export function getSourceByPath(sourcePath) {
  _stmtGetSourceByPath ??= db.prepare(`
    SELECT id, name, type, path, enabled, last_indexed_at AS lastIndexedAt,
           book_count AS bookCount, created_at AS createdAt,
           flibusta_sidecar AS flibustaSidecar
    FROM sources
    WHERE path = ?
  `);
  return _stmtGetSourceByPath.get(sourcePath) || null;
}

let _stmtAddSource = null;
export function addSource({ name, type, path: sourcePath }) {
  const trimmedName = String(name || '').trim();
  const trimmedPath = String(sourcePath || '').trim();
  const normalizedType = type === 'inpx' ? 'inpx' : 'folder';
  if (!trimmedName) throw new Error('Название источника не указано');
  if (!trimmedPath) throw new Error('Путь к источнику не указан');
  const existing = getSourceByPath(trimmedPath);
  if (existing) throw new Error('Источник с таким путём уже существует');
  _stmtAddSource ??= db.prepare(`
    INSERT INTO sources(name, type, path) VALUES(?, ?, ?)
  `);
  const result = _stmtAddSource.run(trimmedName, normalizedType, trimmedPath);
  return getSourceById(result.lastInsertRowid);
}

export function updateSource(id, { name, enabled, path: sourcePath }) {
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
  if (sourcePath !== undefined) {
    const trimmed = String(sourcePath || '').trim();
    if (!trimmed) throw new Error('Путь к источнику не указан');
    const existing = getSourceByPath(trimmed);
    if (existing && existing.id !== id) throw new Error('Источник с таким путём уже существует');
    parts.push('path = ?');
    params.push(trimmed);
  }
  if (!parts.length) return getSourceById(id);
  params.push(id);
  db.prepare(`UPDATE sources SET ${parts.join(', ')} WHERE id = ?`).run(...params);
  return getSourceById(id);
}

/**
 * Удаляет orphan-записи из authors, series_catalog, genres_catalog —
 * записи, на которые больше ни одна книга не ссылается через junction-таблицы.
 */
async function cleanupOrphanedCatalogs() {
  db.transaction(() => {
    db.exec(`DELETE FROM authors WHERE NOT EXISTS (SELECT 1 FROM book_authors WHERE author_id = authors.id)`);
    db.exec(`DELETE FROM series_catalog WHERE NOT EXISTS (SELECT 1 FROM book_series WHERE series_id = series_catalog.id)`);
    db.exec(`DELETE FROM genres_catalog WHERE NOT EXISTS (SELECT 1 FROM book_genres WHERE genre_id = genres_catalog.id)`);
  })();
  await new Promise(r => setImmediate(r));  // Single yield after all cleanup
}

export async function deleteSourceProgressive(
  id,
  {
    onProgress = null,
    deleteSourceRow = true
  } = {}
) {
  // Wait for post-index maintenance (ANALYZE) to finish before modifying the DB
  try {
    const { waitForPostIndexMaintenance } = await import('./server.js');
    await waitForPostIndexMaintenance(60_000);
  } catch { /* server.js not available in worker context */ }

  const sid = Number(id);
  if (!Number.isFinite(sid)) {
    throw new Error('Некорректный id источника');
  }

  try {
    beginExclusiveOperation('deleting');
    beginFastSqliteImport();
    onProgress?.({ deleted: 0, total: 0, stage: 'prepare' });

    const total = db.prepare('SELECT COUNT(*) AS c FROM books WHERE source_id = ?').get(sid)?.c ?? 0;

    // Cleanup tables without FK CASCADE before deleting books.
    onProgress?.({ deleted: 0, total, stage: 'cleanup' });
    db.prepare('DELETE FROM flibusta_author_shard WHERE source_id = ?').run(sid);
    db.prepare('DELETE FROM book_reviews WHERE source_id = ?').run(sid);
    db.prepare('DELETE FROM book_details_cache WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sid);
    db.exec(`DELETE FROM reading_positions WHERE book_id IN (SELECT id FROM books WHERE source_id = ${sid})`);
    db.exec(`DELETE FROM reader_bookmarks WHERE book_id IN (SELECT id FROM books WHERE source_id = ${sid})`);
    await new Promise(r => setImmediate(r));

    // Drop books indexes and FTS triggers for fast bulk DELETE.
    dropBooksFtsTriggers();
    dropBooksTableIndexes();
    let deleted = 0;
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM book_authors WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sid);
        db.prepare('DELETE FROM book_series  WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sid);
        db.prepare('DELETE FROM book_genres  WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sid);
        deleted = db.prepare('DELETE FROM books WHERE source_id = ?').run(sid).changes;
      })();
      onProgress?.({ deleted, total, stage: 'books' });
    } finally {
      await ensureBooksTableIndexes();
      ensureBooksFtsTriggers();
    }

    // Rebuild FTS once instead of per-row deletes.
    try {
      await rebuildBooksFtsFromContent({
        onProgress: (p) => onProgress?.({
          deleted,
          total,
          stage: 'fts',
          ftsDone: p.done,
          ftsTotal: p.total
        })
      });
    } catch (err) {
      console.warn('[db] FTS rebuild after source delete failed:', err.message);
    }

    const sourceDeleted = deleteSourceRow
      ? db.prepare('DELETE FROM sources WHERE id = ?').run(sid).changes
      : 0;

    onProgress?.({ deleted, total, stage: 'catalogs' });
    try { await cleanupOrphanedCatalogs(); } catch {}
    await new Promise(r => setImmediate(r));
    /* book_count авторов/серий/жанров иначе остаётся с учётом удалённых книг (после удаления
       дублирующего источника счётчики были ровно вдвое больше реальных). */
    try {
      await refreshCatalogBookCounts();
    } catch (err) {
      console.warn('[db] catalog recount after source delete failed:', err.message);
    }

    // Reclaim disk space after mass deletion.
    onProgress?.({ deleted, total, stage: 'vacuum' });
    try {
      db.pragma('mmap_size = 0');
      const freed = db.pragma('freelist_count', { simple: true });
      if (freed > 0) {
        const CHUNK = 4000;
        let left = Number(freed) || 0;
        while (left > 0) {
          const n = Math.min(CHUNK, left);
          db.pragma(`incremental_vacuum(${n})`);
          left -= n;
          await new Promise((r) => setImmediate(r));
        }
        console.log(`[db] incremental_vacuum released ${freed} pages after source delete`);
      } else {
        console.log('[db] no free pages to reclaim after source delete');
      }
      /* TRUNCATE/RESTART ждут читателей HTTP и на минуты блокируют все страницы.
         Здесь только PASSIVE; усечение WAL — в idle-планировщике. */
      try {
        db.pragma('wal_checkpoint(PASSIVE)');
        console.log('[db] WAL checkpoint PASSIVE after source delete');
      } catch (err) {
        console.warn(`[db] WAL checkpoint PASSIVE failed: ${err.message}`);
      }
      const lastCkpt = db.pragma('wal_checkpoint(PASSIVE)')[0] || {};
      if (lastCkpt.busy === 0) {
        db.pragma(`mmap_size = ${_mmapSize}`);
      } else {
        console.warn(`[db] skipping mmap re-enable: ${lastCkpt.busy} busy pages remain after checkpoint`);
      }
      tryIdleWalTruncate();
    } catch (vacErr) {
      console.warn('[db] incremental_vacuum after source delete failed:', vacErr.message);
      try {
        const recoverCkpt = db.pragma('wal_checkpoint(PASSIVE)')[0] || {};
        if (recoverCkpt.busy === 0) {
          db.pragma(`mmap_size = ${_mmapSize}`);
        } else {
          console.warn(`[db] skipping mmap re-enable in recovery: ${recoverCkpt.busy} busy pages remain`);
        }
      } catch {}
    }

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
    endExclusiveOperation('deleting');
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

let _stmtGetMeta = null;
export function getMeta(key) {
  _stmtGetMeta ??= db.prepare('SELECT value FROM meta WHERE key = ?');
  const row = _stmtGetMeta.get(key);
  return row?.value ?? null;
}

let _stmtSetMeta = null;
export function setMeta(key, value) {
  _stmtSetMeta ??= db.prepare(`
    INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  _stmtSetMeta.run(key, value);
}

const LIBRARY_STATS_META_KEY = 'library_stats_snapshot';
let _stmtLibraryStats = null;

/** Дешёвые счётчики дашборда: без COUNT(DISTINCT) по VIEW на миллионах строк.
 *  Тот же SQL пишет поток обслуживания (db-maintenance-worker.js) — не дублировать врозь. */
export function writeLibraryStatsSnapshot() {
  _stmtLibraryStats ??= db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM books b
        LEFT JOIN sources s ON s.id = b.source_id
        WHERE b.deleted = 0 AND (b.source_id IS NULL OR s.enabled = 1)
      ) AS totalBooks,
      (SELECT COUNT(*) FROM authors) AS totalAuthors,
      (SELECT COUNT(*) FROM series_catalog) AS totalSeries,
      (SELECT COUNT(*) FROM genres_catalog) AS totalGenres,
      (SELECT COUNT(*) FROM (
        SELECT 1 FROM books WHERE deleted = 0 GROUP BY COALESCE(NULLIF(lang, ''), 'unknown')
      )) AS totalLanguages
  `);
  const row = _stmtLibraryStats.get();
  const snapshot = {
    totalBooks: Number(row?.totalBooks) || 0,
    totalAuthors: Number(row?.totalAuthors) || 0,
    totalSeries: Number(row?.totalSeries) || 0,
    totalGenres: Number(row?.totalGenres) || 0,
    totalLanguages: Number(row?.totalLanguages) || 0
  };
  setMeta(LIBRARY_STATS_META_KEY, JSON.stringify(snapshot));
  setMeta('catalog_distinct_langs', JSON.stringify(
    db.prepare(`SELECT DISTINCT lang FROM books WHERE lang != '' ORDER BY lang`).all().map((row) => row.lang)
  ));
  setMeta('catalog_distinct_exts', JSON.stringify(
    db.prepare(`SELECT DISTINCT ext FROM books WHERE ext != '' ORDER BY ext`).all().map((row) => row.ext)
  ));
  return snapshot;
}

/**
 * Точечная правка book_count для одной книги (delta = ±1) вместо полного пересчёта
 * (три GROUP BY по всей библиотеке). Вызывать только если книга видна в active_books
 * до скрытия / после восстановления — иначе счётчики разойдутся.
 */
export function adjustCatalogCountsForBook(bookId, delta) {
  const id = String(bookId);
  db.transaction(() => {
    db.prepare(`UPDATE authors SET book_count = MAX(0, COALESCE(book_count, 0) + ?)
      WHERE id IN (SELECT author_id FROM book_authors WHERE book_id = ?)`).run(delta, id);
    db.prepare(`UPDATE series_catalog SET book_count = MAX(0, COALESCE(book_count, 0) + ?)
      WHERE id IN (SELECT series_id FROM book_series WHERE book_id = ?)`).run(delta, id);
    db.prepare(`UPDATE genres_catalog SET book_count = MAX(0, COALESCE(book_count, 0) + ?)
      WHERE id IN (SELECT genre_id FROM book_genres WHERE book_id = ?)`).run(delta, id);
  })();
  const snapshot = getLibraryStatsSnapshot();
  if (snapshot) {
    snapshot.totalBooks = Math.max(0, snapshot.totalBooks + delta);
    setMeta(LIBRARY_STATS_META_KEY, JSON.stringify(snapshot));
  }
}

export function isBookInActiveView(bookId) {
  return Boolean(db.prepare('SELECT 1 FROM active_books WHERE id = ? LIMIT 1').get(String(bookId)));
}

export function getLibraryStatsSnapshot() {
  try {
    const raw = getMeta(LIBRARY_STATS_META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isFinite(Number(parsed.totalBooks))) return null;
    return {
      totalBooks: Number(parsed.totalBooks) || 0,
      totalAuthors: Number(parsed.totalAuthors) || 0,
      totalSeries: Number(parsed.totalSeries) || 0,
      totalGenres: Number(parsed.totalGenres) || 0,
      totalLanguages: Number(parsed.totalLanguages) || 0
    };
  } catch {
    return null;
  }
}

let _stmtGetUserShelves = null;
export function getUserShelves(username) {
  _stmtGetUserShelves ??= db.prepare(`
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
  `);
  const rows = _stmtGetUserShelves.all(username);
  for (const row of rows) {
    row.previewBookIds = row.previewBookIds ? row.previewBookIds.split('|') : [];
  }
  return rows;
}

let _stmtGetShelfById = null;
export function getShelfById(shelfId, username) {
  _stmtGetShelfById ??= db.prepare(`
    SELECT id, username, name, description, created_at AS createdAt
    FROM shelves WHERE id = ? AND username = ?
  `);
  return _stmtGetShelfById.get(shelfId, username);
}

let _stmtCreateShelfDup = null;
let _stmtCreateShelfInsert = null;
export function createShelf(username, name, description = '') {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Название полки не указано');
  _stmtCreateShelfDup ??= db.prepare('SELECT id FROM shelves WHERE username = ? AND name = ?');
  const existing = _stmtCreateShelfDup.get(username, trimmed);
  if (existing) throw new Error('Полка с таким названием уже существует');
  _stmtCreateShelfInsert ??= db.prepare('INSERT INTO shelves(username, name, description) VALUES(?, ?, ?)');
  const result = _stmtCreateShelfInsert.run(username, trimmed, String(description || '').trim());
  return result.lastInsertRowid;
}

let _stmtUpdateShelfDup = null;
let _stmtUpdateShelf = null;
export function updateShelf(shelfId, username, name, description) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Название полки не указано');
  _stmtUpdateShelfDup ??= db.prepare('SELECT id FROM shelves WHERE username = ? AND name = ? AND id != ?');
  const dup = _stmtUpdateShelfDup.get(username, trimmed, shelfId);
  if (dup) throw new Error('Полка с таким названием уже существует');
  _stmtUpdateShelf ??= db.prepare('UPDATE shelves SET name = ?, description = ? WHERE id = ? AND username = ?');
  return _stmtUpdateShelf.run(trimmed, String(description || '').trim(), shelfId, username).changes;
}

let _stmtDeleteShelf = null;
export function deleteShelf(shelfId, username) {
  _stmtDeleteShelf ??= db.prepare('DELETE FROM shelves WHERE id = ? AND username = ?');
  return _stmtDeleteShelf.run(shelfId, username).changes;
}

let _stmtAddBookToShelf = null;
export function addBookToShelf(shelfId, bookId) {
  _stmtAddBookToShelf ??= db.prepare('INSERT OR IGNORE INTO shelf_books(shelf_id, book_id) VALUES(?, ?)');
  _stmtAddBookToShelf.run(shelfId, bookId);
}

let _stmtRemoveBookFromShelf = null;
export function removeBookFromShelf(shelfId, bookId) {
  _stmtRemoveBookFromShelf ??= db.prepare('DELETE FROM shelf_books WHERE shelf_id = ? AND book_id = ?');
  return _stmtRemoveBookFromShelf.run(shelfId, bookId).changes;
}

let _stmtGetShelfBooks = null;
export function getShelfBooks(shelfId, username) {
  _stmtGetShelfBooks ??= db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang,
           b.archive_name AS archiveName, sb.added_at AS addedAt
    FROM shelf_books sb
    JOIN active_books b ON b.id = sb.book_id
    JOIN shelves s ON s.id = sb.shelf_id AND s.username = ?
    WHERE sb.shelf_id = ?
    ORDER BY sb.added_at DESC
  `);
  return _stmtGetShelfBooks.all(username, shelfId);
}

db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`);

const _settingCache = new Map();

let _stmtGetSetting = null;
export function getSetting(key) {
  const cached = _settingCache.get(key);
  if (cached !== undefined) return cached;
  _stmtGetSetting ??= db.prepare('SELECT value FROM settings WHERE key = ?');
  const row = _stmtGetSetting.get(key);
  const value = row?.value || '';
  _settingCache.set(key, value);
  return value;
}

let _stmtSetSetting = null;
export function setSetting(key, value) {
  _stmtSetSetting ??= db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  _stmtSetSetting.run(key, String(value ?? ''));
  _settingCache.delete(key);
}

/**
 * Список всех уникальных языков из таблицы books (включая удалённые/отключённые),
 * чтобы админ видел полную картину.
 */
let _stmtDistinctLanguagesDb = null;
export function getDistinctLanguages() {
  _stmtDistinctLanguagesDb ??= db.prepare(`
    SELECT COALESCE(NULLIF(lang, ''), 'unknown') AS code, COUNT(*) AS bookCount
    FROM books WHERE deleted = 0
    GROUP BY COALESCE(NULLIF(lang, ''), 'unknown')
    ORDER BY bookCount DESC
  `);
  return _stmtDistinctLanguagesDb.all();
}

/**
 * Все жанры с количеством книг (из raw books, не active_books),
 * чтобы админ видел полную картину.
 */
let _stmtDistinctGenresDb = null;
export function getDistinctGenres() {
  _stmtDistinctGenresDb ??= db.prepare(`
    SELECT g.name AS code, COALESCE(g.display_name, g.name) AS displayName,
           COUNT(bg.book_id) AS bookCount
    FROM genres_catalog g
    JOIN book_genres bg ON bg.genre_id = g.id
    JOIN books b ON b.id = bg.book_id AND b.deleted = 0
    GROUP BY g.id
    ORDER BY bookCount DESC
  `);
  return _stmtDistinctGenresDb.all();
}

/* ── Prepared statement reset (called after active_books VIEW rebuild) ── */
const _viewResetCallbacks = [];

/**
 * Register a callback to be called when the active_books VIEW is rebuilt.
 * Used by other modules (e.g. inpx.js) to reset their cached prepared statements.
 */
export function onViewRebuild(cb) { _viewResetCallbacks.push(cb); }

/**
 * Reset all cached prepared statements in db.js.
 * Must be called after DROP/CREATE VIEW active_books to avoid stale statement handles.
 */
export function resetDbPreparedStatements() {
  _stmtGetSetting = null;
  _stmtSetSetting = null;
  _stmtGetUser = null;
  _stmtCountAdmins = null;
  _stmtGetReadPos = null;
  _stmtSetReadPosCas = null;
  _stmtSetReadPosIdleSteal = null;
  _stmtMigrateReadPos = null;
  _stmtResetAndMigrateReadPos = null;
  _stmtDeleteReadPos = null;
  _stmtDeleteReadHistory = null;
  _stmtUpsertReadHistory = null;
  _stmtGetReaderBookmarks = null;
  _stmtAllReaderBm = null;
  _stmtAllReaderBmPage = null;
  _stmtAllReaderBmCount = null;
  _stmtAllReaderAnnotations = null;
  _stmtAllReaderAnnPage = null;
  _stmtAllReaderAnnCount = null;
  _stmtAddReaderBm = null;
  _stmtDelReaderBm = null;
  _stmtGetEreaderEmail = null;
  _stmtSetEreaderEmail = null;
  _stmtReadBooksCount = null;
  _stmtReadIds = null;
  _stmtReadSeries = null;
  _stmtUserStats = null;
  _stmtGetUserShelves = null;
  _stmtGetShelfBooks = null;
  _stmtCountSuppressed = null;
  _stmtCountIndexedDeleted = null;
}

/**
 * Пересоздание VIEW active_books с учётом исключённых языков/жанров и
 * настройки show_deleted_books (INPX DEL=1). Вызывается при изменении фильтров.
 */
export async function rebuildActiveBooksView() {
  const excluded = getSetting('excluded_languages');
  const langs = excluded
    ? excluded.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const excludedGenres = getSetting('excluded_genres');
  const genres = excludedGenres
    ? excludedGenres.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const showDeleted = getSetting('show_deleted_books') === '1';

  // Populate excluded_filters table with current settings (safe parameterized inserts)
  db.exec('DELETE FROM excluded_filters');
  const insertFilter = db.prepare('INSERT OR IGNORE INTO excluded_filters (type, value) VALUES (?, ?)');
  const populateFilters = db.transaction(() => {
    for (const lang of langs) insertFilter.run('lang', lang);
    for (const genre of genres) insertFilter.run('genre', genre);
  });
  populateFilters();

  // Build VIEW referencing the config table — no string interpolation in DDL
  /* Пустой язык не прячем: скан по файлам часто не заполняет lang, и «только RU»
     иначе выкидывает всю выдачу (автор/серии пропадают при живых счётчиках). */
  const langFilter = langs.length > 0
    ? ` AND (b.lang IS NULL OR TRIM(b.lang) = '' OR b.lang NOT IN (SELECT value FROM excluded_filters WHERE type = 'lang'))`
    : '';
  const genreFilter = genres.length > 0
    ? ` AND (NOT EXISTS (SELECT 1 FROM book_genres bg WHERE bg.book_id = b.id) OR EXISTS (SELECT 1 FROM book_genres bg JOIN genres_catalog gc ON gc.id = bg.genre_id WHERE bg.book_id = b.id AND gc.name NOT IN (SELECT value FROM excluded_filters WHERE type = 'genre')))`
    : '';
  /* По умолчанию скрываем deleted=1. При show_deleted_books=1 показываем INPX-удалённые,
     но не soft-delete дубликатов (они в suppressed_books). */
  const deletedFilter = showDeleted
    ? ` AND (b.deleted = 0 OR NOT EXISTS (SELECT 1 FROM suppressed_books sp WHERE sp.book_id = b.id))`
    : ` AND b.deleted = 0`;

  db.exec('DROP VIEW IF EXISTS active_books');
  db.exec(`CREATE VIEW active_books AS SELECT b.* FROM books b LEFT JOIN sources s ON s.id = b.source_id WHERE (b.source_id IS NULL OR s.enabled = 1)${deletedFilter}${langFilter}${genreFilter}`);
  resetDbPreparedStatements();
  for (const cb of _viewResetCallbacks) cb();
  await refreshCatalogBookCounts();
  setMeta('active_books_filter_fp', `v2\n${excluded || ''}\n${excludedGenres || ''}\n${showDeleted ? '1' : '0'}`);
}

/**
 * Пересчёт book_count в таблицах authors, series_catalog, genres_catalog
 * на основе active_books VIEW. Вызывается после индексации и при изменении
 * excluded_languages.
 */
const CATALOG_COUNTS_WORKER_URL = new URL('./services/catalog-counts-worker.js', import.meta.url);
const CATALOG_COUNTS_STAGE_PERCENT = { catalog_authors: 75, catalog_series: 85, catalog_genres: 95 };
let _catalogCountsInflight = null;

function runCatalogCountsWorkerOnce(onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CATALOG_COUNTS_WORKER_URL, {
      workerData: { dbPath: config.dbPath },
      execArgv: []
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.on('message', (msg) => {
      if (msg?.type === 'progress') {
        onProgress?.({ stage: msg.stage, percent: CATALOG_COUNTS_STAGE_PERCENT[msg.stage] || 75 });
      } else if (msg?.type === 'done') {
        finish(resolve, msg.timings || {});
      } else if (msg?.type === 'error') {
        finish(reject, new Error(msg.message || 'catalog counts worker failed'));
      }
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => finish(reject, new Error(`catalog counts worker exited with code ${code}`)));
  });
}

/* Один пересчёт за раз: повторные вызовы (например, view rebuild во время auto-clean) ждут и запускаются следом. */
async function runCatalogCountsWorker(onProgress) {
  while (_catalogCountsInflight) {
    await _catalogCountsInflight.catch(() => {});
  }
  _catalogCountsInflight = runCatalogCountsWorkerOnce(onProgress).finally(() => {
    _catalogCountsInflight = null;
  });
  return _catalogCountsInflight;
}

async function writeLibraryStatsSnapshotOffThread() {
  try {
    const { runDbMaintenance } = await import('./services/db-maintenance.js');
    await runDbMaintenance('stats');
  } catch (err) {
    console.warn('[index] catalog: stats worker failed:', err.message);
    try {
      writeLibraryStatsSnapshot();
    } catch (fallbackErr) {
      console.warn('[index] catalog: stats snapshot failed:', fallbackErr.message);
    }
  }
}

export async function refreshCatalogBookCounts({ onProgress } = {}) {
  console.log('[index] catalog: пересчёт book_count (authors, series, genres)…');
  const t0 = Date.now();

  /* Основной путь — worker_threads: event loop свободен, HTTP отвечает во время пересчёта.
     Inline-вариант ниже остаётся как fallback (например, если worker не смог открыть БД). */
  if (process.env.CATALOG_COUNTS_INLINE !== '1') {
    try {
      const timings = await runCatalogCountsWorker(onProgress);
      console.log(`[index] catalog: worker done in ${((Date.now() - t0) / 1000).toFixed(1)} s ${JSON.stringify(timings)}`);
      await writeLibraryStatsSnapshotOffThread();
      return;
    } catch (err) {
      console.warn('[index] catalog: worker failed, inline fallback:', err.message);
    }
  }

  onProgress?.({ stage: 'catalog_authors', percent: 75 });
  db.transaction(() => {
    db.exec(`
      UPDATE authors SET book_count = COALESCE((
        SELECT t.cnt FROM (
          SELECT ba.author_id AS id, COUNT(*) AS cnt
          FROM book_authors ba
          JOIN active_books b ON b.id = ba.book_id
          GROUP BY ba.author_id
        ) t WHERE t.id = authors.id
      ), 0)
    `);
  })();
  await new Promise(r => setImmediate(r));
  console.log(`[index] catalog: authors done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const t1 = Date.now();
  onProgress?.({ stage: 'catalog_series', percent: 85 });
  db.transaction(() => {
    db.exec(`
      UPDATE series_catalog SET book_count = COALESCE((
        SELECT t.cnt FROM (
          SELECT bs.series_id AS id, COUNT(*) AS cnt
          FROM book_series bs
          JOIN active_books b ON b.id = bs.book_id
          GROUP BY bs.series_id
        ) t WHERE t.id = series_catalog.id
      ), 0)
    `);
  })();
  await new Promise(r => setImmediate(r));
  console.log(`[index] catalog: series done in ${((Date.now() - t1) / 1000).toFixed(1)} s`);

  const t2 = Date.now();
  onProgress?.({ stage: 'catalog_genres', percent: 95 });
  db.transaction(() => {
    db.exec(`
      UPDATE genres_catalog SET book_count = COALESCE((
        SELECT t.cnt FROM (
          SELECT bg.genre_id AS id, COUNT(*) AS cnt
          FROM book_genres bg
          JOIN active_books b ON b.id = bg.book_id
          GROUP BY bg.genre_id
        ) t WHERE t.id = genres_catalog.id
      ), 0)
    `);
  })();
  await new Promise(r => setImmediate(r));
  console.log(`[index] catalog: genres done in ${((Date.now() - t2) / 1000).toFixed(1)} s, total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await writeLibraryStatsSnapshotOffThread();
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

let _stmtTelegramSettingExists = null;

function telegramSettingExists(key) {
  _stmtTelegramSettingExists ??= db.prepare('SELECT 1 AS ok FROM settings WHERE key = ? LIMIT 1');
  return Boolean(_stmtTelegramSettingExists.get(key));
}

/** true — настройки заданы в админке; env используется только до первого сохранения. */
function isTelegramAdminConfigured() {
  if (getSetting('telegram_configured') === '1') return true;
  return ['telegram_bot_token', 'telegram_allowed_users', 'telegram_enabled']
    .some((key) => telegramSettingExists(key));
}

const TELEGRAM_ACCESS_MODES = new Set(['open', 'linked_only', 'whitelist_or_linked']);

export function registerTelegramChat({ chatId, chatType = 'private', title = '' }) {
  const id = String(chatId ?? '').trim();
  if (!id) return;
  const type = String(chatType || 'private').trim() || 'private';
  const label = String(title || '').trim().slice(0, 255);
  db.prepare(`
    INSERT INTO telegram_chats(chat_id, chat_type, title, registered_at, last_seen_at, announce_enabled)
    VALUES(?, ?, ?, datetime('now'), datetime('now'), 1)
    ON CONFLICT(chat_id) DO UPDATE SET
      chat_type = excluded.chat_type,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE telegram_chats.title END,
      last_seen_at = datetime('now')
  `).run(id, type, label);
}

export function removeTelegramChat(chatId) {
  const id = String(chatId ?? '').trim();
  if (!id) return;
  db.prepare('DELETE FROM telegram_chats WHERE chat_id = ?').run(id);
}

export function listTelegramAnnounceChats() {
  return db.prepare(`
    SELECT chat_id AS chatId, chat_type AS chatType, title, announce_enabled AS announceEnabled
    FROM telegram_chats
    WHERE announce_enabled = 1
    ORDER BY last_seen_at DESC
  `).all();
}

export function countTelegramAnnounceChats() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM telegram_chats WHERE announce_enabled = 1').get()?.n || 0);
}

/** Регистрирует личные чаты пользователей, уже привязавших Telegram (до появления анонсов). */
export function syncTelegramChatsFromLinkedUsers() {
  const rows = db.prepare(`
    SELECT telegram_id AS telegramId, username
    FROM users
    WHERE telegram_id IS NOT NULL AND TRIM(telegram_id) != ''
  `).all();
  for (const row of rows) {
    registerTelegramChat({
      chatId: String(row.telegramId),
      chatType: 'private',
      title: String(row.username || ''),
    });
  }
}

export function getTelegramSettings() {
  const accessModeRaw = getSetting('telegram_access_mode') || 'whitelist_or_linked';
  return {
    adminConfigured: isTelegramAdminConfigured(),
    token: decryptValue(getSetting('telegram_bot_token')) || '',
    allowedUsers: getSetting('telegram_allowed_users'),
    accessMode: TELEGRAM_ACCESS_MODES.has(accessModeRaw) ? accessModeRaw : 'whitelist_or_linked',
    welcomeMessage: getSetting('telegram_welcome_message') || '',
    profileDescription: getSetting('telegram_profile_description') || '',
    profileShortDescription: getSetting('telegram_profile_short_description') || '',
    newBooksAnnounceEnabled: getSetting('telegram_new_books_announce_enabled') === '1',
    newBooksAnnounceTemplate: getSetting('telegram_new_books_announce_template') || '',
    announceChatCount: countTelegramAnnounceChats(),
    /** '0' = явно отключён; иначе считается включённым */
    enabled: getSetting('telegram_enabled') !== '0',
  };
}

export function setTelegramSettings({
  token,
  allowedUsers,
  accessMode,
  enabled,
  welcomeMessage,
  profileDescription,
  profileShortDescription,
  newBooksAnnounceEnabled,
  newBooksAnnounceTemplate,
}) {
  if (token !== undefined && String(token).trim()) {
    setSetting('telegram_bot_token', encryptValue(String(token).trim()));
  }
  if (allowedUsers !== undefined) {
    setSetting('telegram_allowed_users', String(allowedUsers ?? ''));
  }
  if (accessMode !== undefined) {
    const mode = TELEGRAM_ACCESS_MODES.has(accessMode) ? accessMode : 'whitelist_or_linked';
    setSetting('telegram_access_mode', mode);
  }
  if (welcomeMessage !== undefined) {
    setSetting('telegram_welcome_message', String(welcomeMessage ?? ''));
  }
  if (profileDescription !== undefined) {
    setSetting('telegram_profile_description', String(profileDescription ?? ''));
  }
  if (profileShortDescription !== undefined) {
    setSetting('telegram_profile_short_description', String(profileShortDescription ?? ''));
  }
  if (newBooksAnnounceEnabled !== undefined) {
    setSetting('telegram_new_books_announce_enabled', newBooksAnnounceEnabled ? '1' : '0');
  }
  if (newBooksAnnounceTemplate !== undefined) {
    setSetting('telegram_new_books_announce_template', String(newBooksAnnounceTemplate ?? '').slice(0, 4096));
  }
  if (enabled !== undefined) {
    setSetting('telegram_enabled', enabled ? '1' : '0');
  }
  setSetting('telegram_configured', '1');
}

/** Эффективная конфигурация бота: после сохранения в админке env не подменяет пустые поля. */
export function resolveTelegramRuntimeConfig() {
  const tg = getTelegramSettings();
  if (tg.adminConfigured) {
    const list = String(tg.allowedUsers || '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
      token: String(tg.token || '').trim(),
      allowedUsers: list.length ? list : null,
      accessMode: tg.accessMode,
      enabled: tg.enabled,
    };
  }
  const envToken = String(config.telegramBotToken || '').trim();
  const envUsers = config.telegramAllowedUsers.length ? config.telegramAllowedUsers : null;
  return {
    token: String(tg.token || envToken).trim(),
    allowedUsers: envUsers,
    accessMode: tg.accessMode || 'whitelist_or_linked',
    enabled: tg.enabled,
  };
}

/** Токен для проверки в админке: поле пароля может быть пустым, если токен уже сохранён. */
export function resolveTelegramTokenForAdmin(rawToken = '') {
  const trimmed = String(rawToken || '').trim();
  if (trimmed) return trimmed;
  const tg = getTelegramSettings();
  if (tg.token) return tg.token;
  if (!tg.adminConfigured) return String(config.telegramBotToken || '').trim();
  return '';
}

db.exec(`CREATE TABLE IF NOT EXISTS reading_positions (
  username TEXT NOT NULL,
  book_id TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  text_offset INTEGER,
  text_quote TEXT,
  text_section_length INTEGER,
  position_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (username, book_id)
)`);

function ensureReadingPositionsSchema() {
  const columns = db.prepare(`PRAGMA table_info(reading_positions)`).all();
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('fraction')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN fraction REAL`);
  }
  if (!names.has('fb2_href')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN fb2_href TEXT`);
  }
  if (!names.has('section_index')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN section_index INTEGER`);
  }
  if (!names.has('section_page_fraction')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN section_page_fraction REAL`);
  }
  if (!names.has('paginator_page')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN paginator_page INTEGER`);
  }
  if (!names.has('paginator_pages')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN paginator_pages INTEGER`);
  }
  if (!names.has('layout_mode')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN layout_mode TEXT`);
  }
  if (!names.has('text_offset')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN text_offset INTEGER`);
  }
  if (!names.has('text_quote')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN text_quote TEXT`);
  }
  if (!names.has('text_section_length')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN text_section_length INTEGER`);
  }
  if (!names.has('position_version')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN position_version INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has('revision')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has('holder_session_id')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN holder_session_id TEXT`);
  }
  if (!names.has('last_user_activity_at')) {
    db.exec(`ALTER TABLE reading_positions ADD COLUMN last_user_activity_at TEXT`);
  }
}
ensureReadingPositionsSchema();

db.exec(`CREATE TABLE IF NOT EXISTS reader_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  book_id TEXT NOT NULL,
  position TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reader_bookmarks_user_book ON reader_bookmarks(username, book_id)`);

db.exec(`CREATE TABLE IF NOT EXISTS reader_book_revisions (
  username TEXT NOT NULL,
  book_id TEXT NOT NULL,
  bookmarks_rev TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  annotations_rev TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  PRIMARY KEY (username, book_id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS user_reader_revisions (
  username TEXT PRIMARY KEY,
  read_books_rev TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  reading_history_rev TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
)`);

const READER_SYNC_EPOCH = '1970-01-01T00:00:00.000Z';

function touchReaderBookRevision(username, bookId, field) {
  const u = String(username || '').trim();
  const id = String(bookId ?? '');
  if (!u || !id) return;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO reader_book_revisions (username, book_id, ${field}) VALUES (?, ?, ?)
    ON CONFLICT(username, book_id) DO UPDATE SET ${field} = excluded.${field}`).run(u, id, now);
}

export function touchUserReaderRevision(username, field) {
  const u = String(username || '').trim();
  if (!u) return;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO user_reader_revisions (username, ${field}) VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET ${field} = excluded.${field}`).run(u, now);
}

export function getReaderBookSyncMeta(username, bookId) {
  const u = String(username || '').trim();
  const id = String(bookId ?? '');
  const row = db.prepare('SELECT bookmarks_rev AS bookmarksRev, annotations_rev AS annotationsRev FROM reader_book_revisions WHERE username = ? AND book_id = ?').get(u, id);
  const pos = db.prepare('SELECT updated_at AS updatedAt, progress, revision FROM reading_positions WHERE username = ? AND book_id = ?').get(u, id);
  const bmCount = db.prepare('SELECT COUNT(*) AS cnt FROM reader_bookmarks WHERE username = ? AND book_id = ?').get(u, id)?.cnt || 0;
  const annCount = db.prepare('SELECT COUNT(*) AS cnt FROM reader_annotations WHERE username = ? AND book_id = ?').get(u, id)?.cnt || 0;
  const revision = pos?.revision != null ? Math.max(0, Number(pos.revision) || 0) : 0;
  return {
    bookmarksRev: row?.bookmarksRev || READER_SYNC_EPOCH,
    annotationsRev: row?.annotationsRev || READER_SYNC_EPOCH,
    positionUpdatedAt: pos?.updatedAt || null,
    positionProgress: Number(pos?.progress) || 0,
    positionRevision: revision,
    bookmarkCount: bmCount,
    annotationCount: annCount,
  };
}

const READER_SYNC_INDEX_MAX_IDS = 200;

/**
 * Bulk dirty-check for silent background sync.
 * @param {string} username
 * @param {string[]} bookIds
 */
export function getReaderSyncIndex(username, bookIds) {
  const u = String(username || '').trim();
  const ids = [...new Set(
    (Array.isArray(bookIds) ? bookIds : [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean),
  )].slice(0, READER_SYNC_INDEX_MAX_IDS);

  const activity = getUserReaderActivitySyncMeta(u);
  if (ids.length === 0) {
    return { activity, books: [] };
  }

  const placeholders = ids.map(() => '?').join(',');
  const revRows = db.prepare(
    `SELECT book_id AS bookId, bookmarks_rev AS bookmarksRev, annotations_rev AS annotationsRev
     FROM reader_book_revisions WHERE username = ? AND book_id IN (${placeholders})`,
  ).all(u, ...ids);
  const posRows = db.prepare(
    `SELECT book_id AS bookId, updated_at AS updatedAt, progress, revision
     FROM reading_positions WHERE username = ? AND book_id IN (${placeholders})`,
  ).all(u, ...ids);
  const bmRows = db.prepare(
    `SELECT book_id AS bookId, COUNT(*) AS cnt FROM reader_bookmarks
     WHERE username = ? AND book_id IN (${placeholders}) GROUP BY book_id`,
  ).all(u, ...ids);
  const annRows = db.prepare(
    `SELECT book_id AS bookId, COUNT(*) AS cnt FROM reader_annotations
     WHERE username = ? AND book_id IN (${placeholders}) GROUP BY book_id`,
  ).all(u, ...ids);

  const revById = new Map(revRows.map((r) => [String(r.bookId), r]));
  const posById = new Map(posRows.map((r) => [String(r.bookId), r]));
  const bmById = new Map(bmRows.map((r) => [String(r.bookId), Number(r.cnt) || 0]));
  const annById = new Map(annRows.map((r) => [String(r.bookId), Number(r.cnt) || 0]));

  const books = ids.map((bookId) => {
    const rev = revById.get(bookId);
    const pos = posById.get(bookId);
    const revision = pos?.revision != null ? Math.max(0, Number(pos.revision) || 0) : 0;
    return {
      bookId,
      bookmarksRev: rev?.bookmarksRev || READER_SYNC_EPOCH,
      annotationsRev: rev?.annotationsRev || READER_SYNC_EPOCH,
      positionUpdatedAt: pos?.updatedAt || null,
      positionProgress: Number(pos?.progress) || 0,
      positionRevision: revision,
      bookmarkCount: bmById.get(bookId) || 0,
      annotationCount: annById.get(bookId) || 0,
    };
  });

  return { activity, books };
}

export function getUserReaderActivitySyncMeta(username) {
  const u = String(username || '').trim();
  const row = db.prepare('SELECT read_books_rev AS readBooksRev, reading_history_rev AS readingHistoryRev FROM user_reader_revisions WHERE username = ?').get(u);
  const readCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM read_books rb
    JOIN active_books b ON b.id = rb.book_id
    WHERE rb.username = ?
  `).get(u)?.cnt || 0;
  const histCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM reading_history rh
    JOIN active_books b ON b.id = rh.book_id
    WHERE rh.username = ?
  `).get(u)?.cnt || 0;
  return {
    readBooksRev: row?.readBooksRev || READER_SYNC_EPOCH,
    readingHistoryRev: row?.readingHistoryRev || READER_SYNC_EPOCH,
    readBookCount: readCount,
    readingHistoryCount: histCount,
  };
}

let _stmtGetReadPos = null;
function nullableFiniteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeHolderSessionId(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128) return null;
  return id;
}

export function getReadingPosition(username, bookId) {
  _stmtGetReadPos ??= db.prepare(
    `SELECT position, progress, fraction, fb2_href AS fb2Href, updated_at AS updatedAt,
            section_index AS sectionIndex, section_page_fraction AS sectionPageFraction,
            paginator_page AS paginatorPage, paginator_pages AS paginatorPages,
            layout_mode AS layoutMode, text_offset AS textOffset, text_quote AS textQuote,
            text_section_length AS textSectionLength,
            position_version AS positionVersion, revision,
            holder_session_id AS sessionId, last_user_activity_at AS lastUserActivityAt
     FROM reading_positions WHERE username = ? AND book_id = ?`,
  );
  const row = _stmtGetReadPos.get(username, bookId);
  if (!row) return null;
  const sessionId = row.sessionId ? String(row.sessionId) : null;
  const lastUserActivityAt = row.lastUserActivityAt || null;
  return {
    position: row.position || '',
    progress: Number(row.progress) || 0,
    fraction: row.fraction != null && Number.isFinite(Number(row.fraction)) ? Number(row.fraction) : null,
    fb2Href: row.fb2Href || null,
    sectionIndex: nullableFiniteNumber(row.sectionIndex),
    sectionPageFraction: nullableFiniteNumber(row.sectionPageFraction),
    paginatorPage: nullableFiniteNumber(row.paginatorPage),
    paginatorPages: nullableFiniteNumber(row.paginatorPages),
    layoutMode: typeof row.layoutMode === 'string' ? row.layoutMode : null,
    textOffset: nullableFiniteNumber(row.textOffset),
    textQuote: typeof row.textQuote === 'string' ? row.textQuote : null,
    textSectionLength: nullableFiniteNumber(row.textSectionLength),
    updatedAt: row.updatedAt || null,
    positionVersion: Number(row.positionVersion) || 1,
    revision: Math.max(1, Number(row.revision) || 1),
    sessionId,
    lastUserActivityAt,
    sessionStatus: sessionStatusFromActivityAt(lastUserActivityAt),
  };
}

let _stmtMigrateReadPos = null;
let _stmtResetAndMigrateReadPos = null;
export function migrateReadingPositionToV4(username, bookId, { reset = false } = {}) {
  const sql = reset
    ? `UPDATE reading_positions SET
         position = '',
         progress = 0,
         fraction = NULL,
         fb2_href = NULL,
         section_index = NULL,
         section_page_fraction = NULL,
         paginator_page = NULL,
         paginator_pages = NULL,
         layout_mode = NULL,
         text_offset = NULL,
         text_quote = NULL,
         text_section_length = NULL,
         position_version = 4,
         revision = revision + 1,
         updated_at = datetime('now')
       WHERE username = ? AND book_id = ? AND position_version < 4`
    : `UPDATE reading_positions SET
         progress = 0,
         fraction = NULL,
         fb2_href = NULL,
         section_index = NULL,
         section_page_fraction = NULL,
         paginator_page = NULL,
         paginator_pages = NULL,
         layout_mode = NULL,
         text_offset = NULL,
         text_quote = NULL,
         text_section_length = NULL,
         position_version = 4,
         revision = revision + 1,
         updated_at = datetime('now')
       WHERE username = ? AND book_id = ? AND position_version < 4`;
  if (reset) {
    _stmtResetAndMigrateReadPos ??= db.prepare(sql);
    _stmtResetAndMigrateReadPos.run(username, bookId);
  } else {
    _stmtMigrateReadPos ??= db.prepare(sql);
    _stmtMigrateReadPos.run(username, bookId);
  }
  return getReadingPosition(username, bookId);
}

let _stmtSetReadPosCas = null;
let _stmtSetReadPosIdleSteal = null;
const IDLE_SQL_MODIFIER = `-${Math.round(IDLE_MS / 1000)} seconds`;

function readingPositionWriteFields(position, progress, fraction, fb2Href, anchors = {}) {
  const fractionVal = Number.isFinite(Number(fraction)) ? Math.max(0, Math.min(1, Number(fraction))) : null;
  const fb2HrefVal = fb2Href != null && String(fb2Href).trim() ? String(fb2Href).trim() : null;
  const layoutMode =
    anchors?.layoutMode != null && String(anchors.layoutMode).trim()
      ? String(anchors.layoutMode).trim()
      : null;
  return {
    position: String(position),
    progress: Number(progress) || 0,
    fractionVal,
    fb2HrefVal,
    sectionIndex: nullableFiniteNumber(anchors?.sectionIndex),
    sectionPageFraction: nullableFiniteNumber(anchors?.sectionPageFraction),
    paginatorPage: nullableFiniteNumber(anchors?.paginatorPage),
    paginatorPages: nullableFiniteNumber(anchors?.paginatorPages),
    layoutMode,
    textOffset: nullableFiniteNumber(anchors?.textOffset),
    textQuote: anchors?.textQuote != null ? String(anchors.textQuote) : null,
    textSectionLength: nullableFiniteNumber(anchors?.textSectionLength),
    sessionId: normalizeHolderSessionId(anchors?.sessionId),
  };
}

export function setReadingPositionCas(
  username,
  bookId,
  baseRevision,
  position,
  progress,
  fraction = null,
  fb2Href = null,
  anchors = {},
) {
  _stmtSetReadPosCas ??= db.prepare(`INSERT INTO reading_positions (
      username, book_id, position, progress, fraction, fb2_href,
      section_index, section_page_fraction, paginator_page, paginator_pages, layout_mode,
      text_offset, text_quote, text_section_length,
      holder_session_id, last_user_activity_at,
      position_version, revision, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 4, 1, datetime('now')
    WHERE ? = 0 OR EXISTS (
      SELECT 1 FROM reading_positions
      WHERE username = ? AND book_id = ? AND revision = ?
    )
    ON CONFLICT(username, book_id) DO UPDATE SET
      position = excluded.position,
      progress = excluded.progress,
      fraction = excluded.fraction,
      fb2_href = excluded.fb2_href,
      section_index = excluded.section_index,
      section_page_fraction = excluded.section_page_fraction,
      paginator_page = excluded.paginator_page,
      paginator_pages = excluded.paginator_pages,
      layout_mode = excluded.layout_mode,
      text_offset = excluded.text_offset,
      text_quote = excluded.text_quote,
      text_section_length = excluded.text_section_length,
      holder_session_id = excluded.holder_session_id,
      last_user_activity_at = excluded.last_user_activity_at,
      position_version = 4,
      revision = reading_positions.revision + 1,
      updated_at = excluded.updated_at
    WHERE reading_positions.revision = ?
      AND (
        ? IS NULL
        OR reading_positions.holder_session_id IS NULL
        OR reading_positions.holder_session_id = ?
        OR reading_positions.last_user_activity_at IS NULL
        OR datetime(reading_positions.last_user_activity_at) <= datetime('now', ?)
      )
    RETURNING revision`);
  const fields = readingPositionWriteFields(position, progress, fraction, fb2Href, anchors);
  const normalizedBaseRevision = Number(baseRevision);
  const saved = _stmtSetReadPosCas.get(
    username,
    bookId,
    fields.position,
    fields.progress,
    fields.fractionVal,
    fields.fb2HrefVal,
    fields.sectionIndex,
    fields.sectionPageFraction,
    fields.paginatorPage,
    fields.paginatorPages,
    fields.layoutMode,
    fields.textOffset,
    fields.textQuote,
    fields.textSectionLength,
    fields.sessionId,
    normalizedBaseRevision,
    username,
    bookId,
    normalizedBaseRevision,
    normalizedBaseRevision,
    fields.sessionId,
    fields.sessionId,
    IDLE_SQL_MODIFIER,
  );
  return saved ? getReadingPosition(username, bookId) : null;
}

export function setReadingPositionIdleSteal(
  username,
  bookId,
  expectedHolderSessionId,
  position,
  progress,
  fraction = null,
  fb2Href = null,
  anchors = {},
) {
  const holder = normalizeHolderSessionId(expectedHolderSessionId);
  const incoming = normalizeHolderSessionId(anchors?.sessionId);
  if (!holder || !incoming || holder === incoming) return null;
  _stmtSetReadPosIdleSteal ??= db.prepare(`UPDATE reading_positions SET
      position = ?,
      progress = ?,
      fraction = ?,
      fb2_href = ?,
      section_index = ?,
      section_page_fraction = ?,
      paginator_page = ?,
      paginator_pages = ?,
      layout_mode = ?,
      text_offset = ?,
      text_quote = ?,
      text_section_length = ?,
      holder_session_id = ?,
      last_user_activity_at = datetime('now'),
      position_version = 4,
      revision = revision + 1,
      updated_at = datetime('now')
    WHERE username = ?
      AND book_id = ?
      AND holder_session_id = ?
      AND (
        last_user_activity_at IS NULL
        OR datetime(last_user_activity_at) <= datetime('now', ?)
      )
    RETURNING revision`);
  const fields = readingPositionWriteFields(position, progress, fraction, fb2Href, anchors);
  const saved = _stmtSetReadPosIdleSteal.get(
    fields.position,
    fields.progress,
    fields.fractionVal,
    fields.fb2HrefVal,
    fields.sectionIndex,
    fields.sectionPageFraction,
    fields.paginatorPage,
    fields.paginatorPages,
    fields.layoutMode,
    fields.textOffset,
    fields.textQuote,
    fields.textSectionLength,
    incoming,
    username,
    bookId,
    holder,
    IDLE_SQL_MODIFIER,
  );
  return saved ? getReadingPosition(username, bookId) : null;
}

let _stmtDeleteReadHistory = null;
let _stmtDeleteReadPos = null;
export function deleteReadingHistoryEntry(username, bookId) {
  const u = String(username || '').trim();
  const id = String(bookId ?? '');
  _stmtDeleteReadHistory ??= db.prepare('DELETE FROM reading_history WHERE username = ? AND book_id = ?');
  const result = _stmtDeleteReadHistory.run(u, id);
  if (result.changes > 0) {
    _stmtDeleteReadPos ??= db.prepare('DELETE FROM reading_positions WHERE username = ? AND book_id = ?');
    _stmtDeleteReadPos.run(u, id);
    touchUserReaderRevision(u, 'reading_history_rev');
  }
  return result.changes > 0;
}

/** Восстановление строки истории (для отмены удаления в профиле). */
let _stmtUpsertReadHistory = null;
export function upsertReadingHistoryEntry(username, bookId, lastOpenedAt, openCount) {
  const opened = String(lastOpenedAt || '').trim() || new Date().toISOString();
  const count = Math.max(1, Number(openCount) || 1);
  _stmtUpsertReadHistory ??= db.prepare(`
    INSERT INTO reading_history(username, book_id, last_opened_at, open_count)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(username, book_id) DO UPDATE SET
      last_opened_at = excluded.last_opened_at,
      open_count = excluded.open_count
  `);
  _stmtUpsertReadHistory.run(username, bookId, opened, count);
  touchUserReaderRevision(username, 'reading_history_rev');
}

let _stmtGetReaderBookmarks = null;
export function getReaderBookmarks(username, bookId) {
  _stmtGetReaderBookmarks ??= db.prepare('SELECT id, position, title, created_at AS createdAt FROM reader_bookmarks WHERE username = ? AND book_id = ? ORDER BY created_at');
  return _stmtGetReaderBookmarks.all(username, bookId);
}

let _stmtAllReaderBm = null;
export function getAllReaderBookmarks(username, limit = 10) {
  _stmtAllReaderBm ??= db.prepare(`
    SELECT rb.id, rb.book_id AS bookId, rb.position, rb.title AS label, rb.created_at AS createdAt,
           b.title AS bookTitle, b.authors
    FROM reader_bookmarks rb
    JOIN active_books b ON b.id = rb.book_id
    WHERE rb.username = ?
    ORDER BY rb.created_at DESC
    LIMIT ?
  `);
  return _stmtAllReaderBm.all(username, limit);
}

let _stmtAllReaderBmPage = null;
let _stmtAllReaderBmCount = null;
export function getAllReaderBookmarksPage(username, { page = 1, pageSize = 100 } = {}) {
  const safePageNum = Math.max(1, Math.floor(Number(page) || 1));
  const size = Math.min(500, Math.max(1, Math.floor(Number(pageSize) || 100)));
  const offset = (safePageNum - 1) * size;
  _stmtAllReaderBmPage ??= db.prepare(`
    SELECT rb.id, rb.book_id AS bookId, rb.position, rb.title AS label, rb.created_at AS createdAt,
           b.title AS bookTitle, b.authors, b.ext
    FROM reader_bookmarks rb
    JOIN active_books b ON b.id = rb.book_id
    WHERE rb.username = ?
    ORDER BY rb.created_at DESC
    LIMIT ? OFFSET ?
  `);
  _stmtAllReaderBmCount ??= db.prepare(`
    SELECT COUNT(*) AS n
    FROM reader_bookmarks rb
    JOIN active_books b ON b.id = rb.book_id
    WHERE rb.username = ?
  `);
  const items = _stmtAllReaderBmPage.all(username, size, offset);
  const total = _stmtAllReaderBmCount.get(username)?.n || 0;
  return { items, total, page: safePageNum, pageSize: size };
}

let _stmtAddReaderBm = null;
export function addReaderBookmark(username, bookId, position, title) {
  _stmtAddReaderBm ??= db.prepare('INSERT INTO reader_bookmarks (username, book_id, position, title) VALUES (?, ?, ?, ?)');
  const info = _stmtAddReaderBm.run(username, bookId, String(position), String(title || ''));
  touchReaderBookRevision(username, bookId, 'bookmarks_rev');
  return info.lastInsertRowid;
}

let _stmtDelReaderBm = null;
export function deleteReaderBookmark(id, username) {
  _stmtDelReaderBm ??= db.prepare('DELETE FROM reader_bookmarks WHERE id = ? AND username = ?');
  const row = db.prepare('SELECT book_id FROM reader_bookmarks WHERE id = ? AND username = ?').get(id, username);
  _stmtDelReaderBm.run(id, username);
  if (row?.book_id) touchReaderBookRevision(username, row.book_id, 'bookmarks_rev');
}

export function updateReaderBookmarkTitle(id, username, title) {
  const row = db.prepare('SELECT book_id FROM reader_bookmarks WHERE id = ? AND username = ?').get(id, username);
  if (!row) return false;
  db.prepare('UPDATE reader_bookmarks SET title = ? WHERE id = ? AND username = ?').run(String(title || ''), id, username);
  touchReaderBookRevision(username, row.book_id, 'bookmarks_rev');
  return true;
}

/* ── Аннотации читалки (выделения и заметки) ──────────────────────── */
db.exec(`CREATE TABLE IF NOT EXISTS reader_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  book_id TEXT NOT NULL,
  cfi TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'yellow',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_reader_annotations_user_book ON reader_annotations(username, book_id)`);

let _stmtGetReaderAnnotations = null;
export function getReaderAnnotations(username, bookId) {
  _stmtGetReaderAnnotations ??= db.prepare('SELECT id, cfi, text, note, color, created_at AS createdAt FROM reader_annotations WHERE username = ? AND book_id = ? ORDER BY created_at');
  return _stmtGetReaderAnnotations.all(username, bookId);
}

/** Последние аннотации пользователя по всем книгам (для страницы профиля). */
let _stmtAllReaderAnnotations = null;
export function getAllReaderAnnotations(username, limit = 10) {
  _stmtAllReaderAnnotations ??= db.prepare(`
    SELECT ra.id, ra.book_id AS bookId, ra.cfi, ra.text, ra.note, ra.color, ra.created_at AS createdAt,
           b.title AS bookTitle, b.authors
    FROM reader_annotations ra
    JOIN active_books b ON b.id = ra.book_id
    WHERE ra.username = ?
    ORDER BY ra.created_at DESC
    LIMIT ?
  `);
  return _stmtAllReaderAnnotations.all(username, limit);
}

let _stmtAllReaderAnnPage = null;
let _stmtAllReaderAnnCount = null;
export function getAllReaderAnnotationsPage(username, { page = 1, pageSize = 100 } = {}) {
  const safePageNum = Math.max(1, Math.floor(Number(page) || 1));
  const size = Math.min(500, Math.max(1, Math.floor(Number(pageSize) || 100)));
  const offset = (safePageNum - 1) * size;
  _stmtAllReaderAnnPage ??= db.prepare(`
    SELECT ra.id, ra.book_id AS bookId, ra.cfi, ra.text, ra.note, ra.color, ra.created_at AS createdAt,
           b.title AS bookTitle, b.authors, b.ext
    FROM reader_annotations ra
    JOIN active_books b ON b.id = ra.book_id
    WHERE ra.username = ?
    ORDER BY ra.created_at DESC
    LIMIT ? OFFSET ?
  `);
  _stmtAllReaderAnnCount ??= db.prepare(`
    SELECT COUNT(*) AS n
    FROM reader_annotations ra
    JOIN active_books b ON b.id = ra.book_id
    WHERE ra.username = ?
  `);
  const items = _stmtAllReaderAnnPage.all(username, size, offset);
  const total = _stmtAllReaderAnnCount.get(username)?.n || 0;
  return { items, total, page: safePageNum, pageSize: size };
}

let _stmtAddReaderAnnotation = null;
export function addReaderAnnotation(username, bookId, cfi, text, note, color) {
  _stmtAddReaderAnnotation ??= db.prepare('INSERT INTO reader_annotations (username, book_id, cfi, text, note, color) VALUES (?, ?, ?, ?, ?, ?)');
  const info = _stmtAddReaderAnnotation.run(username, bookId, String(cfi), String(text || ''), String(note || ''), String(color || 'yellow'));
  touchReaderBookRevision(username, bookId, 'annotations_rev');
  return info.lastInsertRowid;
}

let _stmtUpdReaderAnnotationNote = null;
let _stmtUpdReaderAnnotationColor = null;
let _stmtUpdReaderAnnotationBoth = null;
export function updateReaderAnnotation(id, username, { note, color } = {}) {
  const hasNote = note !== undefined;
  const hasColor = color !== undefined;
  if (hasNote && hasColor) {
    _stmtUpdReaderAnnotationBoth ??= db.prepare('UPDATE reader_annotations SET note = ?, color = ? WHERE id = ? AND username = ?');
    _stmtUpdReaderAnnotationBoth.run(String(note), String(color), id, username);
  } else if (hasNote) {
    _stmtUpdReaderAnnotationNote ??= db.prepare('UPDATE reader_annotations SET note = ? WHERE id = ? AND username = ?');
    _stmtUpdReaderAnnotationNote.run(String(note), id, username);
  } else if (hasColor) {
    _stmtUpdReaderAnnotationColor ??= db.prepare('UPDATE reader_annotations SET color = ? WHERE id = ? AND username = ?');
    _stmtUpdReaderAnnotationColor.run(String(color), id, username);
  }
}

let _stmtDelReaderAnnotation = null;
export function deleteReaderAnnotation(id, username) {
  _stmtDelReaderAnnotation ??= db.prepare('DELETE FROM reader_annotations WHERE id = ? AND username = ?');
  const row = db.prepare('SELECT book_id FROM reader_annotations WHERE id = ? AND username = ?').get(id, username);
  _stmtDelReaderAnnotation.run(id, username);
  if (row?.book_id) touchReaderBookRevision(username, row.book_id, 'annotations_rev');
}

function normalizeUiBrowseView(value) {
  return String(value || '').toLowerCase() === 'list' ? 'list' : 'grid';
}

let _stmtGetBrowseViewPrefs = null;
export function getUserBrowseViewPrefs(username) {
  _stmtGetBrowseViewPrefs ??= db.prepare(`
    SELECT COALESCE(ui_home_view, 'grid') AS homeView,
           COALESCE(ui_catalog_view, 'grid') AS catalogView
    FROM users WHERE username = ?
  `);
  const row = _stmtGetBrowseViewPrefs.get(username);
  return {
    homeView: normalizeUiBrowseView(row?.homeView),
    catalogView: normalizeUiBrowseView(row?.catalogView)
  };
}

let _stmtSetBrowseViewPrefs = null;
export function setUserBrowseViewPrefs(username, { homeView, catalogView } = {}) {
  const user = getUserByUsername(username);
  if (!user) throw new Error('User not found');
  _stmtSetBrowseViewPrefs ??= db.prepare(
    'UPDATE users SET ui_home_view = ?, ui_catalog_view = ? WHERE username = ?'
  );
  _stmtSetBrowseViewPrefs.run(
    normalizeUiBrowseView(homeView),
    normalizeUiBrowseView(catalogView),
    username
  );
}

let _stmtGetEreaderEmail = null;
export function getEreaderEmail(username) {
  _stmtGetEreaderEmail ??= db.prepare('SELECT ereader_email FROM users WHERE username = ?');
  const row = _stmtGetEreaderEmail.get(username);
  return row?.ereader_email || '';
}

let _stmtSetEreaderEmail = null;
export function setUserEreaderEmail(username, email) {
  const user = getUserByUsername(username);
  if (!user) throw new Error('User not found');
  _stmtSetEreaderEmail ??= db.prepare('UPDATE users SET ereader_email = ? WHERE username = ?');
  _stmtSetEreaderEmail.run(String(email || '').trim(), username);
}

export function setEreaderEmail(username, email) {
  const user = getUserByUsername(username);
  if (!user) throw new Error('User not found');
  if (!isEreaderEmailAllowedForUser(user)) throw new Error('E-reader email access denied');
  setUserEreaderEmail(username, email);
}

export function getReadBooks(username, sort = 'title', order = '') {
  const orderMap = {
    title: 'b.title COLLATE NOCASE ASC',
    author: `COALESCE(b.authors, '') COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC`,
    date: 'rb.created_at DESC',
    rating: 'b.lib_rate DESC, b.title_sort ASC'
  };
  let orderBy = orderMap[sort] || orderMap.title;
  if (order === 'asc' || order === 'desc') {
    const firstMatch = orderBy.match(/\b(ASC|DESC)\b/);
    const natural = firstMatch ? firstMatch[1] : 'ASC';
    if (natural !== order.toUpperCase()) {
      orderBy = orderBy.replace(/\bASC\b/, '#ASC#').replace(/\bDESC\b/, '#DESC#')
        .replace('#ASC#', 'DESC').replace('#DESC#', 'ASC');
    }
  }
  return db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
           b.ext, b.lib_rate AS libRate, b.archive_name AS archiveName
    FROM read_books rb
    JOIN active_books b ON b.id = rb.book_id
    WHERE rb.username = ?
    ORDER BY ${orderBy}
  `).all(username);
}

let _stmtReadBooksCount = null;
export function getReadBooksCount(username) {
  _stmtReadBooksCount ??= db.prepare('SELECT COUNT(*) AS cnt FROM read_books rb JOIN active_books b ON b.id = rb.book_id WHERE rb.username = ?');
  const row = _stmtReadBooksCount.get(username);
  return row?.cnt || 0;
}

/* ── Per-user read status cache (short TTL, invalidated on toggle) ── */
const _readCache = new Map();  // username → { ids: Set, series: Set, expiresAt }
const READ_CACHE_TTL_MS = 30 * 60_000; // 30 мин (инвалидируется invalidateReadCache при действиях юзера)
let _stmtReadIds = null;
let _stmtReadSeries = null;

function _ensureReadStmts() {
  if (!_stmtReadIds) {
    _stmtReadIds = db.prepare('SELECT rb.book_id FROM read_books rb JOIN active_books b ON b.id = rb.book_id WHERE rb.username = ?');
  }
  if (!_stmtReadSeries) {
    _stmtReadSeries = db.prepare(`
      WITH candidate_series AS (
        SELECT DISTINCT sc.id AS series_id, sc.name AS series_name
        FROM read_books rb
        JOIN book_series bs ON bs.book_id = rb.book_id
        JOIN series_catalog sc ON sc.id = bs.series_id
        WHERE rb.username = ?
      )
      SELECT cs.series_name
      FROM candidate_series cs
      WHERE NOT EXISTS (
        SELECT 1 FROM book_series bs2
        JOIN active_books ab2 ON ab2.id = bs2.book_id
        WHERE bs2.series_id = cs.series_id
          AND NOT EXISTS (
            SELECT 1 FROM read_books rb2 WHERE rb2.username = ? AND rb2.book_id = bs2.book_id
          )
      )
    `);
  }
}

function _getCachedRead(username) {
  const c = _readCache.get(username);
  if (c && Date.now() < c.expiresAt) return c;
  _readCache.delete(username);
  return null;
}

function _buildReadCache(username) {
  _ensureReadStmts();
  const rows = _stmtReadIds.all(username);
  const ids = new Set(rows.map((r) => r.book_id));
  const sRows = _stmtReadSeries.all(username, username);
  const series = new Set(sRows.map((r) => String(r.series_name || '')).filter(Boolean));
  const entry = { ids, series, expiresAt: Date.now() + READ_CACHE_TTL_MS };
  _readCache.set(username, entry);
  // Evict oldest if too many users cached
  if (_readCache.size > 200) {
    const oldest = _readCache.keys().next().value;
    if (oldest !== undefined) _readCache.delete(oldest);
  }
  return entry;
}

export function invalidateReadCache(username) {
  if (username) _readCache.delete(username);
}

export function getReadBookIdSet(username) {
  if (!username) return new Set();
  const c = _getCachedRead(username);
  return c ? c.ids : _buildReadCache(username).ids;
}

export function getFullyReadSeriesNames(username) {
  if (!username) return new Set();
  const c = _getCachedRead(username);
  return c ? c.series : _buildReadCache(username).series;
}

let _stmtUserStats = null;

function _ensureUserStatsStmt() {
  if (!_stmtUserStats) {
    _stmtUserStats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM reading_history rh
          JOIN active_books b ON b.id = rh.book_id
          WHERE rh.username = ?
            AND NOT EXISTS (
              SELECT 1 FROM read_books rb
              WHERE rb.username = rh.username AND rb.book_id = rh.book_id
            )
        ) AS readingCount,
        (SELECT COUNT(*) FROM bookmarks WHERE username = ?) AS bookmarkCount,
        (SELECT COUNT(*) FROM read_books rb2 JOIN active_books ab2 ON ab2.id = rb2.book_id WHERE rb2.username = ?) AS readBooksCount,
        (SELECT COUNT(*) FROM favorite_authors WHERE username = ?) AS favoriteAuthorsCount,
        (SELECT COUNT(*) FROM favorite_series WHERE username = ?) AS favoriteSeriesCount,
        (SELECT COUNT(*) FROM shelves WHERE username = ?) AS shelvesCount,
        (SELECT COUNT(*) FROM reader_bookmarks rbm JOIN active_books ab3 ON ab3.id = rbm.book_id WHERE rbm.username = ?) AS readerBookmarksCount,
        (SELECT COUNT(*) FROM reader_annotations ra JOIN active_books ab4 ON ab4.id = ra.book_id WHERE ra.username = ?) AS readerAnnotationsCount,
        (SELECT created_at FROM users WHERE username = ?) AS createdAt
    `);
  }
  return _stmtUserStats;
}

export function getUserStats(username) {
  const row = _ensureUserStatsStmt().get(username, username, username, username, username, username, username, username, username);
  return {
    readingCount: row?.readingCount || 0,
    bookmarkCount: row?.bookmarkCount || 0,
    readBooksCount: row?.readBooksCount || 0,
    favoriteAuthorsCount: row?.favoriteAuthorsCount || 0,
    favoriteSeriesCount: row?.favoriteSeriesCount || 0,
    shelvesCount: row?.shelvesCount || 0,
    readerBookmarksCount: row?.readerBookmarksCount || 0,
    readerAnnotationsCount: row?.readerAnnotationsCount || 0,
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
  const result = db.prepare(
    'UPDATE users SET password_hash = ?, has_local_password = 1, session_gen = COALESCE(session_gen, 0) + 1 WHERE username = ?'
  ).run(passwordHash, username);
  if (result.changes === 0) throw new Error('Пользователь не найден');
}

/* ── OIDC / OAuth helpers ───────────────────────────────────────── */

export const OIDC_PROVIDER = 'oidc';

export function getOidcSettings() {
  return {
    enabled: getSetting('oidc_enabled') === '1',
    issuer: String(getSetting('oidc_issuer') || '').trim(),
    clientId: String(getSetting('oidc_client_id') || '').trim(),
    clientSecret: decryptValue(getSetting('oidc_client_secret')) || '',
    redirectUri: String(getSetting('oidc_redirect_uri') || '').trim(),
    scopes: String(getSetting('oidc_scopes') || 'openid profile email').trim() || 'openid profile email',
    adminClaim: String(getSetting('oidc_admin_claim') || '').trim(),
    adminValue: String(getSetting('oidc_admin_value') || '').trim(),
    usernameClaim: String(getSetting('oidc_username_claim') || '').trim(),
    blockLocalRegister: getSetting('oidc_block_local_register') === '1',
    requireEmailVerified: getSetting('oidc_require_email_verified') !== '0'
  };
}

export function setOidcSettings({
  enabled,
  issuer,
  clientId,
  clientSecret,
  redirectUri,
  scopes,
  adminClaim,
  adminValue,
  usernameClaim,
  blockLocalRegister,
  requireEmailVerified
} = {}) {
  if (enabled !== undefined) setSetting('oidc_enabled', enabled ? '1' : '0');
  if (issuer !== undefined) setSetting('oidc_issuer', String(issuer || '').trim().replace(/\/+$/, ''));
  if (clientId !== undefined) setSetting('oidc_client_id', String(clientId || '').trim());
  if (clientSecret !== undefined) {
    const secret = String(clientSecret || '');
    if (secret) setSetting('oidc_client_secret', encryptValue(secret));
  }
  if (redirectUri !== undefined) setSetting('oidc_redirect_uri', String(redirectUri || '').trim());
  if (scopes !== undefined) {
    setSetting('oidc_scopes', String(scopes || 'openid profile email').trim() || 'openid profile email');
  }
  if (adminClaim !== undefined) setSetting('oidc_admin_claim', String(adminClaim || '').trim());
  if (adminValue !== undefined) setSetting('oidc_admin_value', String(adminValue || '').trim());
  if (usernameClaim !== undefined) setSetting('oidc_username_claim', String(usernameClaim || '').trim());
  if (blockLocalRegister !== undefined) {
    setSetting('oidc_block_local_register', blockLocalRegister ? '1' : '0');
  }
  if (requireEmailVerified !== undefined) {
    setSetting('oidc_require_email_verified', requireEmailVerified ? '1' : '0');
  }
}

export function isOidcRegistrationBlocked() {
  return getSetting('oidc_block_local_register') === '1';
}

let _stmtGetUserByEmail = null;
export function getUserByEmail(email) {
  const normalized = normalizeLookupEmail(email);
  if (!normalized) return null;
  _stmtGetUserByEmail ??= db.prepare(`
    SELECT username, password_hash AS passwordHash, role, created_at AS createdAt,
           COALESCE(session_gen, 0) AS sessionGen, COALESCE(blocked, 0) AS blocked,
           telegram_id AS telegramId, telegram_linked_at AS telegramLinkedAt,
           COALESCE(telegram_bot_allowed, 1) AS telegramBotAllowed,
           COALESCE(ereader_email_allowed, 1) AS ereaderEmailAllowed,
           COALESCE(email, '') AS email,
           COALESCE(has_local_password, 1) AS hasLocalPassword
    FROM users
    WHERE lower(email) = ?
    LIMIT 1
  `);
  return _stmtGetUserByEmail.get(normalized);
}

let _stmtGetOauthUser = null;
export function getOauthUser(provider, providerUserId) {
  const p = String(provider || '').trim();
  const id = String(providerUserId || '').trim();
  if (!p || !id) return null;
  _stmtGetOauthUser ??= db.prepare(`
    SELECT provider, provider_user_id AS providerUserId, username, email, display_name AS displayName
    FROM oauth_users
    WHERE provider = ? AND provider_user_id = ?
  `);
  return _stmtGetOauthUser.get(p, id);
}

export function linkOauthUser({ provider, providerUserId, username, email = '', displayName = '' }) {
  db.prepare(`
    INSERT INTO oauth_users(provider, provider_user_id, username, email, display_name)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET
      username = excluded.username,
      email = excluded.email,
      display_name = excluded.display_name
  `).run(
    String(provider),
    String(providerUserId),
    String(username),
    String(email || ''),
    String(displayName || '')
  );
}

/** Sanitize preferred_username / email local-part into a valid local username. */
export function sanitizeOidcUsername(raw, fallback = 'user') {
  let base = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
  if (base.length < 5) {
    base = `${String(fallback || 'user').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8) || 'user'}_${crypto.randomBytes(3).toString('hex')}`;
  }
  if (base.length < 5) base = `user_${crypto.randomBytes(4).toString('hex')}`;
  return base.slice(0, 50);
}

export function allocateUniqueUsername(preferred) {
  let candidate = sanitizeOidcUsername(preferred);
  if (!getUserByUsername(candidate)) return candidate;
  for (let i = 0; i < 20; i += 1) {
    const suffix = crypto.randomBytes(2).toString('hex');
    const next = sanitizeOidcUsername(`${candidate.slice(0, 40)}_${suffix}`);
    if (!getUserByUsername(next)) return next;
  }
  return `user_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Create a local user for OIDC JIT with an unusable random password and has_local_password=0.
 */
export function createOidcUser({
  preferredUsername = '',
  email = '',
  displayName = '',
  providerUserId,
  role = 'user'
} = {}) {
  const sub = String(providerUserId || '').trim();
  if (!sub) throw new Error('OIDC subject is required');
  const normalizedEmail = normalizeLookupEmail(email);
  if (normalizedEmail && getUserByEmail(normalizedEmail)) {
    throw new Error('EMAIL_EXISTS');
  }
  const username = allocateUniqueUsername(preferredUsername || normalizedEmail || `u${sub.slice(0, 8)}`);
  const randomSecret = `${crypto.randomBytes(32).toString('base64url')}Aa1!`;
  const passwordHash = hashPassword(randomSecret);
  const normalizedRole = role === 'admin' ? 'admin' : 'user';
  db.prepare(`
    INSERT INTO users(username, password_hash, role, email, has_local_password)
    VALUES(?, ?, ?, ?, 0)
  `).run(username, passwordHash, normalizedRole, normalizedEmail || '');
  linkOauthUser({
    provider: OIDC_PROVIDER,
    providerUserId: sub,
    username,
    email: normalizedEmail || '',
    displayName: String(displayName || '')
  });
  return getUserByUsername(username);
}

export function promoteUserToAdmin(username) {
  const user = getUserByUsername(username);
  if (!user) return null;
  if (user.role === 'admin') return user;
  db.prepare(`UPDATE users SET role = 'admin' WHERE username = ?`).run(username);
  _stmtGetUser = null;
  return getUserByUsername(username);
}

export function oidcAdminClaimMatches(claims, claimName, claimValue) {
  const name = String(claimName || '').trim();
  const want = String(claimValue || '').trim();
  if (!name || !want || !claims || typeof claims !== 'object') return false;
  const raw = claims[name];
  if (raw == null) return false;
  if (Array.isArray(raw)) return raw.map((v) => String(v)).includes(want);
  const asString = String(raw);
  if (asString === want) return true;
  if (asString.includes(' ') || asString.includes(',')) {
    return asString.split(/[\s,]+/).filter(Boolean).includes(want);
  }
  return false;
}

/** Resolve local user from OIDC claims. Throws Error with code in message for known cases. */
export function resolveOrProvisionOidcUser(claims, { adminClaim = '', adminValue = '', usernameClaim = '', requireEmailVerified = true } = {}) {
  const sub = String(claims?.sub || '').trim();
  if (!sub) throw new Error('OIDC_MISSING_SUB');

  const emailRaw = String(claims.email || '').trim();
  const email = normalizeLookupEmail(emailRaw);
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (requireEmailVerified && email && !emailVerified) {
    throw new Error('OIDC_EMAIL_UNVERIFIED');
  }

  const existingLink = getOauthUser(OIDC_PROVIDER, sub);
  if (existingLink?.username) {
    const user = getUserByUsername(existingLink.username);
    if (!user) throw new Error('OIDC_LINK_ORPHAN');
    if (user.blocked) throw new Error('OIDC_USER_BLOCKED');
    if (oidcAdminClaimMatches(claims, adminClaim, adminValue)) {
      return promoteUserToAdmin(user.username) || user;
    }
    return user;
  }

  if (email) {
    const byEmail = getUserByEmail(email);
    if (byEmail) {
      throw new Error('OIDC_EMAIL_EXISTS');
    }
  }

  // Configured claim first; then preferred_username (Authentik), username (Synology SSO), nickname.
  const customClaim = String(usernameClaim || '').trim();
  const claimText = (key) => {
    const v = claims[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  };
  const claimUsername =
    (customClaim && claimText(customClaim))
    || claimText('preferred_username')
    || claimText('username')
    || claimText('nickname');
  const preferred = claimUsername || email || `user_${sub.slice(0, 8)}`;
  const displayName = String(claims.name || claimUsername).trim();
  const wantAdmin = oidcAdminClaimMatches(claims, adminClaim, adminValue);
  const user = createOidcUser({
    preferredUsername: preferred,
    email,
    displayName,
    providerUserId: sub,
    role: wantAdmin ? 'admin' : 'user'
  });
  return user;
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

export async function unsuppressAll({ onProgress } = {}) {
  const report = (stage, extra = {}) => {
    onProgress?.({ stage, mode: 'restore', ...extra });
  };
  const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

  report('prepare', { percent: 2, restored: 0, total: 0, deleted: 0 });
  await yieldLoop();

  const total = Number(db.prepare('SELECT COUNT(*) AS c FROM suppressed_books').get()?.c) || 0;
  report('restore', { percent: 12, restored: 0, total, deleted: 0 });
  await yieldLoop();

  /* Один UPDATE по подзапросу — без массива из 400k id в RAM и без цикла по строкам. */
  const restored = db.prepare(`
    UPDATE books SET deleted = 0
    WHERE id IN (SELECT book_id FROM suppressed_books)
  `).run().changes;
  report('restore', { percent: 55, restored, total, deleted: restored });
  await yieldLoop();

  report('clear', { percent: 65, restored, total, deleted: restored });
  db.prepare('DELETE FROM suppressed_books').run();
  await yieldLoop();

  if (total > 0) {
    await refreshCatalogBookCounts({
      onProgress: (p) => report(p.stage, { ...p, restored, total, deleted: restored })
    });
  }

  report('done', { percent: 100, restored, total, deleted: restored, groups: restored });
  return restored;
}

export function isBookSuppressed(bookId) {
  return Boolean(db.prepare('SELECT 1 FROM suppressed_books WHERE book_id = ?').get(String(bookId)));
}

export function getSuppressedBooks({ page = 1, pageSize = 50, filter = '' } = {}) {
  const offset = (page - 1) * pageSize;
  const normalizedFilter = String(filter || '').trim().toLowerCase();
  const tokens = normalizedFilter.split(/\s+/).filter(Boolean);
  const hasTokens = tokens.length > 0;

  let filterWhere, filterParams;
  if (tokens.length === 1) {
    const word = tokens[0];
    filterWhere = `WHERE (lower_unicode(title) LIKE ? OR lower_unicode(authors) LIKE ?)`;
    filterParams = [`%${word}%`, `%${word}%`];
  } else if (tokens.length > 1) {
    const titleClauses = tokens.map(() => `(' ' || lower_unicode(title) || ' ') LIKE ?`).join(' AND ');
    const authorsClauses = tokens.map(() => `(' ' || COALESCE(lower_unicode(authors), '') || ' ') LIKE ?`).join(' AND ');
    filterWhere = `WHERE (${titleClauses} OR ${authorsClauses})`;
    filterParams = [...tokens.map(t => `% ${t}%`), ...tokens.map(t => `% ${t}%`)];
  } else {
    filterWhere = '';
    filterParams = [];
  }

  const totalBooksSql = `SELECT COUNT(*) AS count FROM suppressed_books ${filterWhere}`;
  const totalBooks = db.prepare(totalBooksSql).get(...filterParams)?.count || 0;
  if (!totalBooks) {
    return { total: 0, totalBooks: 0, rows: [] };
  }

  // Пагинация по авторам среди совпадений
  const authorsSql = `
    SELECT DISTINCT COALESCE(authors, '') AS authors
    FROM suppressed_books
    ${filterWhere}
    ORDER BY authors ASC
    LIMIT ? OFFSET ?
  `;
  const authorRows = db.prepare(authorsSql).all(...filterParams, pageSize, offset);

  if (!authorRows.length) {
    const totalAuthorsSql = `SELECT COUNT(DISTINCT COALESCE(authors, '')) AS count FROM suppressed_books ${filterWhere}`;
    const total = db.prepare(totalAuthorsSql).get(...filterParams)?.count || 0;
    return { total, totalBooks: 0, rows: [] };
  }

  const authors = authorRows.map(r => r.authors);
  const placeholders = authors.map(() => '?').join(',');

  const booksSql = `
    SELECT * FROM suppressed_books
    WHERE COALESCE(authors, '') IN (${placeholders})
      ${hasTokens ? `AND ${filterWhere.replace(/^WHERE /, '')}` : ''}
    ORDER BY COALESCE(authors, '') ASC, title ASC
  `;
  const booksParams = [...authors];
  if (hasTokens) booksParams.push(...filterParams);
  const rows = db.prepare(booksSql).all(...booksParams);

  const totalAuthorsSql = `SELECT COUNT(DISTINCT COALESCE(authors, '')) AS count FROM suppressed_books ${filterWhere}`;
  const total = db.prepare(totalAuthorsSql).get(...filterParams)?.count || 0;

  return { total, totalBooks, rows };
}

let _stmtCountSuppressed;
/** Дешёвый счётчик скрытых книг — для дашборда. Готовится один раз, кешируется. */
export function countSuppressedBooks() {
  _stmtCountSuppressed ??= db.prepare('SELECT COUNT(*) AS count FROM suppressed_books');
  return _stmtCountSuppressed.get()?.count || 0;
}

let _stmtCountIndexedDeleted;
/** Книги с deleted≠0, не из suppressed (типично INPX DEL=1) — для дашборда. */
export function countIndexedDeletedBooks() {
  _stmtCountIndexedDeleted ??= db.prepare(`
    SELECT COUNT(*) AS count FROM books b
    WHERE b.deleted != 0
      AND NOT EXISTS (SELECT 1 FROM suppressed_books sp WHERE sp.book_id = b.id)
  `);
  return _stmtCountIndexedDeleted.get()?.count || 0;
}

/* ── Database size breakdown ───────────────────────────────────────
 * Группировка размеров таблиц/индексов по категориям для визуального
 * стэкового бара «что внутри БД». Использует виртуальную таблицу
 * dbstat (включена в better-sqlite3 по умолчанию). Кеш на 60 секунд —
 * dbstat сканирует структуру BTree, тяжеловато гонять каждые 5 сек.
 */

/* Маппинг: точные имена таблиц → категория. Индексы (idx_*) разносятся
   по префиксам ниже. Шадоу-таблицы FTS (books_fts_*) попадают в 'books'. */
const DB_TABLE_TO_CATEGORY = {
  books: 'books', books_fts: 'books', books_fts_data: 'books', books_fts_idx: 'books',
  books_fts_docsize: 'books', books_fts_config: 'books',
  library_dedup_projection: 'books', meta: 'books', excluded_filters: 'books',
  suppressed_books: 'books', sources: 'books', settings: 'books',
  authors: 'catalogs', series_catalog: 'catalogs', genres_catalog: 'catalogs',
  book_authors: 'catalogs', book_series: 'catalogs', book_genres: 'catalogs',
  book_details_cache: 'covers',
  book_reviews: 'sidecar', flibusta_author_shard: 'sidecar', flibusta_author_portrait: 'sidecar',
  users: 'activity', oauth_users: 'activity',
  bookmarks: 'activity', read_books: 'activity', book_ratings: 'activity',
  reading_history: 'activity', reading_positions: 'activity', reader_bookmarks: 'activity',
  favorite_authors: 'activity', favorite_series: 'activity',
  shelves: 'activity', shelf_books: 'activity',
  system_events: 'activity', scan_schedule_log: 'activity'
};

function classifyDbObject(name) {
  if (DB_TABLE_TO_CATEGORY[name]) return DB_TABLE_TO_CATEGORY[name];
  /* Индексы идут с префиксами idx_<table>_…; маппим по корню таблицы. */
  if (name.startsWith('idx_book_details_cache')) return 'covers';
  if (name.startsWith('idx_books_') || name.startsWith('idx_dedup_projection')) return 'books';
  if (name.startsWith('idx_book_authors') || name.startsWith('idx_book_series') || name.startsWith('idx_book_genres')) return 'catalogs';
  if (name.startsWith('idx_authors_') || name.startsWith('idx_series_catalog_') || name.startsWith('idx_genres_catalog_')) return 'catalogs';
  if (name.startsWith('idx_bookmarks_') || name.startsWith('idx_reading_') || name.startsWith('idx_reader_bookmarks_')) return 'activity';
  if (name.startsWith('idx_read_books_') || name.startsWith('idx_favorite_') || name.startsWith('idx_shelves_') || name.startsWith('idx_shelf_books_')) return 'activity';
  if (name.startsWith('idx_book_ratings_') || name.startsWith('idx_system_events_') || name.startsWith('idx_scan_schedule_log_')) return 'activity';
  if (name.startsWith('idx_sources_')) return 'books';
  /* sqlite_sequence, sqlite_stat*, autoindexes, неопознанные — в «прочее». */
  return 'other';
}

let _dbBreakdownCache = null;
let _stmtDbStat = null;
let _dbStatSupported = null;
const DB_BREAKDOWN_TTL_MS = 10 * 60_000;
const DB_CATEGORY_ORDER = ['books', 'catalogs', 'covers', 'sidecar', 'activity', 'other'];

/**
 * Сводка по содержимому БД: размеры по категориям. {supported, total, segments[]}.
 * dbstat сканирует все страницы файла — не вызывать на 2-секундном poll админки.
 * @param {{ compute?: boolean }} [opts] compute=false — только кэш, без скана.
 */
export function getDbBreakdown({ compute = true } = {}) {
  const now = Date.now();
  if (_dbBreakdownCache && now < _dbBreakdownCache.expiresAt) return _dbBreakdownCache.value;
  if (!compute) {
    return _dbBreakdownCache?.value || { supported: false, total: 0, segments: [] };
  }

  /* Один раз проверяем, поддерживается ли dbstat — если нет, возвращаем
     «неподдерживаемый» режим (UI покажет просто размер без разбивки). */
  if (_dbStatSupported === null) {
    try {
      db.prepare('SELECT 1 FROM dbstat LIMIT 1').get();
      _dbStatSupported = true;
    } catch (err) {
      _dbStatSupported = false;
      console.warn('[db] dbstat virtual table unavailable:', err.message);
    }
  }

  if (!_dbStatSupported) {
    return markDbBreakdownUnsupported();
  }

  try {
    _stmtDbStat ??= db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name');
    return storeDbBreakdownFromStatRows(_stmtDbStat.all());
  } catch (err) {
    console.warn('[db] getDbBreakdown failed:', err.message);
    _dbStatSupported = false;
    return markDbBreakdownUnsupported();
  }
}

export function isDbBreakdownFresh() {
  return Boolean(_dbBreakdownCache && Date.now() < _dbBreakdownCache.expiresAt);
}

export function markDbBreakdownUnsupported() {
  const value = { supported: false, total: 0, segments: [] };
  _dbBreakdownCache = { value, expiresAt: Date.now() + DB_BREAKDOWN_TTL_MS };
  return value;
}

/** Собрать полоску дашборда из строк dbstat. Вызывается после скана в отдельном потоке. */
export function storeDbBreakdownFromStatRows(rows) {
  const buckets = Object.create(null);
  let total = 0;
  for (const row of rows || []) {
    const bytes = Number(row.bytes) || 0;
    if (bytes <= 0) continue;
    const category = classifyDbObject(String(row.name || ''));
    buckets[category] = (buckets[category] || 0) + bytes;
    total += bytes;
  }
  const segments = DB_CATEGORY_ORDER
    .map((key) => ({
      key,
      bytes: buckets[key] || 0,
      pct: total > 0 ? ((buckets[key] || 0) / total) * 100 : 0
    }))
    .filter((s) => s.bytes > 0);
  const value = { supported: true, total, segments };
  _dbBreakdownCache = { value, expiresAt: Date.now() + DB_BREAKDOWN_TTL_MS };
  return value;
}

/* ── Scan schedule log ─────────────────────────────────────────── */

let _stmtScheduleLogInsert = null;
let _stmtScheduleLogTrim = null;
let _stmtScheduleLogList = null;
const SCAN_SCHEDULE_LOG_MAX = 50;

/** Добавить запись в лог расписания. status: 'started' | 'ok' | 'skipped' | 'error'. */
export function addScheduleLog({ mode = '', full = false, status = 'started', message = '' } = {}) {
  _stmtScheduleLogInsert ??= db.prepare(
    'INSERT INTO scan_schedule_log(mode, full, status, message) VALUES(?, ?, ?, ?)'
  );
  _stmtScheduleLogInsert.run(String(mode), full ? 1 : 0, String(status), String(message || ''));
  /* Обрезаем хвост, чтобы таблица не росла бесконечно — храним только последние N. */
  _stmtScheduleLogTrim ??= db.prepare(`
    DELETE FROM scan_schedule_log
    WHERE id NOT IN (SELECT id FROM scan_schedule_log ORDER BY id DESC LIMIT ?)
  `);
  _stmtScheduleLogTrim.run(SCAN_SCHEDULE_LOG_MAX);
}

export function getScheduleLog(limit = 10) {
  const n = Math.max(1, Math.min(SCAN_SCHEDULE_LOG_MAX, Math.floor(Number(limit) || 10)));
  _stmtScheduleLogList ??= db.prepare(
    'SELECT id, ran_at AS ranAt, mode, full, status, message FROM scan_schedule_log ORDER BY id DESC LIMIT ?'
  );
  return _stmtScheduleLogList.all(n);
}

export function getSuppressedBookSubquery() {
  return 'SELECT book_id FROM suppressed_books';
}

export function getSuppressedBookIds() {
  const ids = new Set();
  for (const row of db.prepare('SELECT book_id FROM suppressed_books').iterate()) {
    ids.add(row.book_id);
  }
  if (ids.size > 50000) {
    console.warn(`[db] Large suppression list: ${ids.size} entries – consider SQL subquery approach`);
  }
  return ids;
}

// ── Book Ratings ──

export function setBookRating(username, bookId, rating) {
  if (rating < 1 || rating > 5) throw new Error('Rating must be 1-5');
  db.prepare(`
    INSERT INTO book_ratings (username, book_id, rating) VALUES (?, ?, ?)
    ON CONFLICT(username, book_id) DO UPDATE SET rating = excluded.rating
  `).run(username, bookId, rating);
}

export function removeBookRating(username, bookId) {
  db.prepare('DELETE FROM book_ratings WHERE username = ? AND book_id = ?').run(username, bookId);
}

export function getBookRating(username, bookId) {
  return db.prepare('SELECT rating FROM book_ratings WHERE username = ? AND book_id = ?').get(username, bookId)?.rating || 0;
}

export function getBookAverageRating(bookId) {
  const row = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM book_ratings WHERE book_id = ?').get(bookId);
  return { average: row?.avg ? Math.round(row.avg * 10) / 10 : 0, count: row?.cnt || 0 };
}

/**
 * Атомарная резервная копия БД перед опасными операциями.
 * Использует SQLite backup API (better-sqlite3 db.backup()).
 * Ротация: хранит последние 5 бэкапов.
 * @param {string} reason - Краткая метка бэкапа (например 'delete-source', 'force-reindex')
 * @returns {Promise<string>} Путь к созданному файлу бэкапа
 */
export async function createDatabaseBackup(reason = 'manual') {
  const backupDir = path.join(config.dataDir, 'backups');
  await fs.promises.mkdir(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `library-${timestamp}-${reason}.db`;
  const destPath = path.join(backupDir, backupName);

  // db.backup() — атомарная резервная копия через SQLite backup API
  await db.backup(destPath);

  // Ротация: оставить последние 5 бэкапов
  try {
    const files = await fs.promises.readdir(backupDir);
    const backups = files.filter(f => f.startsWith('library-') && f.endsWith('.db')).sort().reverse();
    for (const old of backups.slice(5)) {
      await fs.promises.unlink(path.join(backupDir, old)).catch(() => {});
      // Удалить -wal/-shm спутники от старых бэкапов (обратная совместимость)
      await fs.promises.unlink(path.join(backupDir, old + '-wal')).catch(() => {});
      await fs.promises.unlink(path.join(backupDir, old + '-shm')).catch(() => {});
    }
  } catch (err) {
    console.warn('[db] Backup rotation failed:', err.message);
  }

  console.log(`[db] Backup created: ${destPath}`);
  return destPath;
}
