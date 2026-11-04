/**
 * Portable backup: everything that is NOT the catalog (users, settings, sources, shelves, per-book user data,
 * appearance files) as gzipped JSONL, restorable on a clean server before or after re-indexing.
 *
 * Book-bound rows carry a fingerprint (lib_id + archive + file + ext), never a trusted book id: ids differ
 * between servers (`6:857614` here can be another book there). On import such rows are written under a
 * namespaced id `restore:<stamp>:<oldId>` together with a `detached_book_refs` row (source_id NULL, never
 * expires); `reattachDetachedUserData` then moves them onto the real books — now, or when indexing creates them.
 * Merge rule: rows that already exist win (INSERT OR IGNORE / UPDATE OR IGNORE).
 *
 * Streams both ways and yields to the event loop (time-sliced), so a 700k-book server is not blocked.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { db, runWithForeignKeysOff, reattachDetachedUserData, touchUserReaderRevision } from '../db.js';
import { config } from '../config.js';

export const PORTABLE_BACKUP_FORMAT = 'inpx-portable-backup';
export const PORTABLE_BACKUP_VERSION = 1;

/** Book-bound tables (rows exported with a fingerprint). Auto-increment `id` is not kept (new ids on import). */
const BOOK_TABLES = [
  'bookmarks', 'read_books', 'book_ratings', 'reading_history', 'reading_positions',
  'reader_bookmarks', 'reader_annotations', 'reader_book_revisions', 'want_to_read'
];
const AUTO_ID_TABLES = new Set(['reader_bookmarks', 'reader_annotations']);

/** Plain user / settings tables copied column by column. */
const SIMPLE_TABLES = [
  { type: 'not_recommended', table: 'not_recommended_authors' },
  { type: 'reading_goal', table: 'reading_goals' },
  { type: 'kosync_key', table: 'kosync_keys' },
  { type: 'telegram_chat', table: 'telegram_chats' },
  { type: 'oauth_user', table: 'oauth_users' },
  { type: 'excluded_filter', table: 'excluded_filters' },
  { type: 'setting', table: 'settings' }
];

/**
 * Every table is classified: exported by this module, or skipped on purpose. `test/portable-backup.test.js`
 * fails when the schema has a table that is in neither list — a new user table must not silently drop out.
 */
export const PORTABLE_EXPORTED_TABLES = new Set([
  ...BOOK_TABLES, ...SIMPLE_TABLES.map((s) => s.table),
  'users', 'shelves', 'shelf_books', 'smart_shelves', 'favorite_authors', 'favorite_series',
  'collections', 'collection_items', 'collection_pins', 'sources'
]);
export const PORTABLE_SKIPPED_TABLES = new Set([
  // catalog / derived: rebuilt by indexing
  'books', 'authors', 'series_catalog', 'genres_catalog', 'book_authors', 'book_series', 'book_genres',
  'book_details_cache', 'book_files', 'book_reviews', 'calibre_book_state', 'catalog_lang_counts',
  'author_name_tokens', 'series_name_tokens', 'search_title_tokens', 'active_book_ids',
  'active_books_projection_state', 'library_dedup_projection', 'duplicate_scan_keys',
  'flibusta_author_portrait', 'flibusta_author_shard', 'suppressed_books',
  // restore machinery / runtime state
  'detached_book_refs', 'meta', 'scan_schedule_log', 'system_events', 'user_reader_revisions',
  // KOReader progress is keyed by a per-download document hash that maps to a book only after a download
  'kosync_documents', 'kosync_progress',
  // ephemeral tokens
  'app_pairing_tokens', 'password_reset_tokens', 'telegram_link_tokens'
]);

const UI_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const UI_FILE_MAX_BYTES = 16 * 1024 * 1024;
const SLICE_MS = 40;

const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableColumns(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}

/* ───────────────────────────── export ───────────────────────────── */

/** Keyset paging by rowid: no statement stays open across awaits. */
async function* pageRows(table, { joins = '', select = '', where = '1', pageSize = 2000 } = {}) {
  if (!tableExists(table)) return;
  const stmt = db.prepare(`
    SELECT t.rowid AS _rid, t.*${select} FROM ${table} t ${joins}
    WHERE t.rowid > ? AND (${where}) ORDER BY t.rowid LIMIT ${pageSize}
  `);
  let last = 0;
  for (;;) {
    const rows = stmt.all(last);
    if (!rows.length) return;
    last = rows[rows.length - 1]._rid;
    for (const row of rows) {
      delete row._rid;
      yield row;
    }
    await yieldLoop();
  }
}

function pick(row, drop = []) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('_') || drop.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

const FP_SELECT = `, COALESCE(b.lib_id, d.lib_id) AS _lib, COALESCE(b.archive_name, d.archive_name) AS _arc,
  COALESCE(b.file_name, d.file_name) AS _file, COALESCE(b.ext, d.ext) AS _ext, (b.id IS NOT NULL OR d.old_book_id IS NOT NULL) AS _known`;
const FP_JOINS = 'LEFT JOIN books b ON b.id = t.book_id LEFT JOIN detached_book_refs d ON d.old_book_id = t.book_id';

function fingerprintOf(row) {
  return { id: row.book_id, lib: row._lib || '', arc: row._arc || '', file: row._file || '', ext: row._ext || '' };
}

/**
 * Writes the backup to `out` (any Writable). Returns { records, bytesIn } counts per type.
 */
export async function writePortableBackup(out, { appVersion = '' } = {}) {
  const gz = zlib.createGzip({ level: 6 });
  const done = pipeline(gz, out);
  const counts = {};
  let chunk = [];
  let chunkBytes = 0;
  let sliceStart = Date.now();

  const flush = async () => {
    if (!chunk.length) return;
    const data = chunk.join('');
    chunk = [];
    chunkBytes = 0;
    if (!gz.write(data)) await once(gz, 'drain');
    if (Date.now() - sliceStart > SLICE_MS) {
      await yieldLoop();
      sliceStart = Date.now();
    }
  };
  const emit = async (type, r, fp) => {
    const line = `${JSON.stringify(fp ? { t: type, r, fp } : { t: type, r })}\n`;
    chunk.push(line);
    chunkBytes += line.length;
    counts[type] = (counts[type] || 0) + 1;
    if (chunkBytes > 256 * 1024) await flush();
  };

  chunk.push(`${JSON.stringify({
    format: PORTABLE_BACKUP_FORMAT, version: PORTABLE_BACKUP_VERSION, appVersion, createdAt: new Date().toISOString()
  })}\n`);

  try {
    // accounts first: every later record is applied only for users that exist
    for await (const row of pageRows('users')) await emit('user', pick(row, ['session_gen']));
    // uploaded (non-builtin) collections with their author/title items
    if (tableExists('collections')) {
      for await (const row of pageRows('collections', { where: 't.builtin = 0' })) {
        const items = db.prepare('SELECT position, author, title, year, note FROM collection_items WHERE collection_id = ? ORDER BY position').all(row.id);
        await emit('collection', { ...pick(row, ['id', 'matched_at', 'content_hash']), items });
      }
    }
    for await (const row of pageRows('shelves')) await emit('shelf', pick(row));
    for await (const row of pageRows('shelf_books', { joins: FP_JOINS, select: FP_SELECT })) {
      if (row._known) await emit('shelf_book', pick(row, ['book_id']), fingerprintOf(row));
    }
    for await (const row of pageRows('smart_shelves')) await emit('smart_shelf', pick(row));
    for await (const row of pageRows('favorite_authors', { joins: 'JOIN authors a ON a.id = t.author_id', select: ', a.name AS _name' })) {
      await emit('fav_author', { username: row.username, name: row._name, created_at: row.created_at });
    }
    for await (const row of pageRows('favorite_series', { joins: 'JOIN series_catalog s ON s.id = t.series_id', select: ', s.name AS _name' })) {
      await emit('fav_series', { username: row.username, name: row._name, created_at: row.created_at });
    }
    if (tableExists('collection_pins') && tableExists('collections')) {
      for await (const row of pageRows('collection_pins', { joins: 'JOIN collections c ON c.id = t.collection_id', select: ', c.slug AS _slug' })) {
        await emit('collection_pin', { username: row.username, slug: row._slug, pinned_at: row.pinned_at });
      }
    }
    for (const spec of SIMPLE_TABLES) {
      for await (const row of pageRows(spec.table)) await emit(spec.type, pick(row));
    }
    for await (const row of pageRows('sources')) await emit('source', pick(row, ['id', 'last_indexed_at', 'book_count']));
    for (const table of BOOK_TABLES) {
      const drop = AUTO_ID_TABLES.has(table) ? ['book_id', 'id'] : ['book_id'];
      for await (const row of pageRows(table, { joins: FP_JOINS, select: FP_SELECT })) {
        if (row._known) await emit(table, pick(row, drop), fingerprintOf(row));
      }
    }
    // appearance files (logo, background, header, custom font)
    const uiDir = path.join(config.dataDir, 'ui');
    let uiNames = [];
    try { uiNames = await fs.promises.readdir(uiDir); } catch { /* no custom appearance */ }
    for (const name of uiNames) {
      if (!UI_FILE_RE.test(name)) continue;
      const full = path.join(uiDir, name);
      const stat = await fs.promises.stat(full).catch(() => null);
      if (!stat?.isFile() || stat.size > UI_FILE_MAX_BYTES) continue;
      await emit('ui_file', { name, b64: (await fs.promises.readFile(full)).toString('base64') });
    }
    await flush();
    gz.end();
  } catch (error) {
    gz.destroy(error);
    await done.catch(() => {});
    throw error;
  }
  await done;
  return counts;
}

/** Writes a backup file atomically (`.part` → rename). */
export async function writePortableBackupFile(filePath, opts) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const part = `${filePath}.part`;
  try {
    const counts = await writePortableBackup(fs.createWriteStream(part), opts);
    await fs.promises.rename(part, filePath);
    return counts;
  } catch (error) {
    await fs.promises.unlink(part).catch(() => {});
    throw error;
  }
}

/* ───────────────────────────── import ───────────────────────────── */

class BackupFormatError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_BACKUP';
  }
}

function insertByColumns(table, row, { orIgnore = true, drop = [] } = {}) {
  const cols = tableColumns(table);
  const keys = Object.keys(row).filter((k) => cols.includes(k) && !drop.includes(k));
  if (!keys.length) return 0;
  const sql = `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map((k) => row[k])).changes;
}

function rewriteHomeLayout(raw, maps) {
  if (!raw) return raw;
  try {
    const layout = JSON.parse(raw);
    if (Array.isArray(layout?.shelfOrder)) {
      layout.shelfOrder = layout.shelfOrder.map((key) => {
        const m = /^(shelf|smart):(\d+)$/.exec(String(key));
        if (!m) return null;
        const mapped = (m[1] === 'shelf' ? maps.shelf : maps.smart).get(Number(m[2]));
        return mapped ? `${m[1]}:${mapped}` : null;
      }).filter(Boolean);
    }
    return JSON.stringify(layout);
  } catch {
    return raw;
  }
}

/**
 * Imports a portable backup file.
 * @param {string} filePath  gzipped JSONL
 * @param {{ dryRun?: boolean, replaceUsers?: boolean, includeSources?: boolean, includeSettings?: boolean }} opts
 * @returns summary with per-type counts
 */
export async function importPortableBackup(filePath, {
  dryRun = false, replaceUsers = false, includeSources = true, includeSettings = true
} = {}) {
  const input = fs.createReadStream(filePath);
  const gunzip = zlib.createGunzip();
  input.on('error', (e) => gunzip.destroy(e));
  const rl = readline.createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });

  const summary = {
    dryRun, header: null,
    users: { created: 0, replaced: 0, kept: 0, invalid: 0 },
    shelves: 0, smartShelves: 0, collections: 0,
    bookRows: 0, bookRefs: 0, favorites: 0, settings: 0, sources: 0, uiFiles: 0, skipped: 0,
    matchedNow: 0
  };
  const stamp = { value: '' };
  const maps = { shelf: new Map(), smart: new Map() };
  const touchedUsers = new Set();
  const homeRewrite = new Set();
  const userExists = new Map();
  const seenRefs = new Set();

  const hasUser = (username) => {
    if (!userExists.has(username)) userExists.set(username, Boolean(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)));
    return userExists.get(username);
  };
  const restoreId = (fp) => `restore:${stamp.value}:${fp.id}`;
  const ensureRef = (fp) => {
    const id = restoreId(fp);
    if (!seenRefs.has(id)) {
      seenRefs.add(id);
      if (!dryRun) {
        const added = db.prepare(`
          INSERT OR IGNORE INTO detached_book_refs(old_book_id, lib_id, archive_name, file_name, ext, source_id, size, title_key)
          VALUES(?, ?, ?, ?, ?, NULL, 0, '')
        `).run(id, fp.lib, fp.arc, fp.file, fp.ext).changes;
        if (added) summary.bookRefs += 1;
      } else {
        summary.bookRefs += 1;
      }
    }
    return id;
  };

  const userCols = tableColumns('users');
  const applyUser = (r) => {
    const username = String(r.username || '').trim();
    if (!username) { summary.users.invalid += 1; return; }
    const exists = hasUser(username);
    if (exists && !replaceUsers) { summary.users.kept += 1; return; }
    if (dryRun) { summary.users[exists ? 'replaced' : 'created'] += 1; userExists.set(username, true); return; }
    const keys = Object.keys(r).filter((k) => userCols.includes(k) && k !== 'username');
    const attempt = (cols) => {
      if (exists) {
        if (!cols.length) return;
        db.prepare(`UPDATE users SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE username = ?`).run(...cols.map((k) => r[k]), username);
      } else {
        db.prepare(`INSERT INTO users(username${cols.map((k) => `, ${k}`).join('')}) VALUES(?${cols.map(() => ', ?').join('')})`)
          .run(username, ...cols.map((k) => r[k]));
      }
    };
    try {
      attempt(keys);
    } catch {
      try {
        attempt(keys.filter((k) => !['email', 'telegram_id'].includes(k))); // UNIQUE clash with another account
      } catch { summary.users.invalid += 1; return; }
    }
    summary.users[exists ? 'replaced' : 'created'] += 1;
    userExists.set(username, true);
    homeRewrite.add(username);
    touchedUsers.add(username);
  };

  const apply = (rec) => {
    const { t, r, fp } = rec;
    switch (t) {
      case 'collection': {
        if (!tableExists('collections') || !r?.slug) { summary.skipped += 1; break; }
        if (db.prepare('SELECT 1 FROM collections WHERE slug = ?').get(r.slug)) { summary.skipped += 1; break; }
        summary.collections += 1;
        if (dryRun) break;
        const id = Number(db.prepare(`
          INSERT INTO collections(slug, title, description, source, source_url, display_order, builtin, enabled)
          VALUES(?, ?, ?, ?, ?, ?, 0, ?)
        `).run(r.slug, r.title || r.slug, r.description || '', r.source || '', r.source_url || '', Number(r.display_order) || 0, r.enabled === 0 ? 0 : 1).lastInsertRowid);
        const item = db.prepare('INSERT OR IGNORE INTO collection_items(collection_id, position, author, title, year, note) VALUES(?, ?, ?, ?, ?, ?)');
        for (const it of Array.isArray(r.items) ? r.items : []) item.run(id, Number(it.position) || 0, it.author || '', it.title || '', it.year ?? null, it.note || '');
        break;
      }
      case 'shelf': {
        const existing = db.prepare('SELECT id FROM shelves WHERE username = ? AND name = ?').get(r.username, r.name);
        if (existing) { maps.shelf.set(Number(r.id), existing.id); summary.skipped += 1; break; }
        if (!hasUser(r.username)) { summary.skipped += 1; break; }
        summary.shelves += 1;
        if (dryRun) { maps.shelf.set(Number(r.id), -1); break; }
        const res = db.prepare('INSERT INTO shelves(username, name, description, created_at, on_home) VALUES(?, ?, ?, ?, ?)')
          .run(r.username, r.name, r.description || '', r.created_at || null, Number(r.on_home) || 0);
        maps.shelf.set(Number(r.id), Number(res.lastInsertRowid));
        break;
      }
      case 'shelf_book': {
        const shelfId = maps.shelf.get(Number(r.shelf_id));
        if (!shelfId || !fp) { summary.skipped += 1; break; }
        const id = ensureRef(fp);
        summary.bookRows += 1;
        if (!dryRun) db.prepare('INSERT OR IGNORE INTO shelf_books(shelf_id, book_id, added_at) VALUES(?, ?, ?)').run(shelfId, id, r.added_at || null);
        break;
      }
      case 'smart_shelf': {
        if (!hasUser(r.username)) { summary.skipped += 1; break; }
        const existing = db.prepare('SELECT id FROM smart_shelves WHERE username = ? AND name = ? AND query = ?').get(r.username, r.name, r.query);
        if (existing) { maps.smart.set(Number(r.id), existing.id); summary.skipped += 1; break; }
        summary.smartShelves += 1;
        if (dryRun) { maps.smart.set(Number(r.id), -1); break; }
        const res = db.prepare('INSERT INTO smart_shelves(username, name, query, created_at, on_home) VALUES(?, ?, ?, ?, ?)')
          .run(r.username, r.name, r.query, r.created_at || null, Number(r.on_home) || 0);
        maps.smart.set(Number(r.id), Number(res.lastInsertRowid));
        break;
      }
      case 'user': applyUser(r); break;
      case 'fav_author': {
        if (!hasUser(r.username)) { summary.skipped += 1; break; }
        const row = db.prepare('SELECT id FROM authors WHERE name = ?').get(r.name);
        summary.favorites += 1;
        if (!dryRun && row) db.prepare('INSERT OR IGNORE INTO favorite_authors(username, author_id, created_at) VALUES(?, ?, ?)').run(r.username, row.id, r.created_at || null);
        break;
      }
      case 'fav_series': {
        if (!hasUser(r.username)) { summary.skipped += 1; break; }
        const row = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get(r.name);
        summary.favorites += 1;
        if (!dryRun && row) db.prepare('INSERT OR IGNORE INTO favorite_series(username, series_id, created_at) VALUES(?, ?, ?)').run(r.username, row.id, r.created_at || null);
        break;
      }
      case 'collection_pin': {
        if (!tableExists('collections') || !hasUser(r.username)) { summary.skipped += 1; break; }
        const row = db.prepare('SELECT id FROM collections WHERE slug = ?').get(r.slug);
        if (!dryRun && row) db.prepare('INSERT OR IGNORE INTO collection_pins(username, collection_id, pinned_at) VALUES(?, ?, ?)').run(r.username, row.id, r.pinned_at || null);
        break;
      }
      case 'setting': {
        if (!includeSettings || !r?.key) { summary.skipped += 1; break; }
        summary.settings += 1;
        if (!dryRun) db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(r.key, String(r.value ?? ''));
        break;
      }
      case 'source': {
        if (!includeSources || !r?.path) { summary.skipped += 1; break; }
        if (db.prepare('SELECT 1 FROM sources WHERE path = ?').get(r.path)) { summary.skipped += 1; break; }
        summary.sources += 1;
        // imported disabled: the path may not exist on this machine; the admin enables and indexes it
        if (!dryRun) insertByColumns('sources', { ...r, enabled: 0 }, { drop: ['id'] });
        break;
      }
      case 'ui_file': {
        if (!includeSettings || !UI_FILE_RE.test(String(r?.name || '')) || typeof r.b64 !== 'string') { summary.skipped += 1; break; }
        summary.uiFiles += 1;
        if (!dryRun) {
          const dir = path.join(config.dataDir, 'ui');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, r.name), Buffer.from(r.b64, 'base64'));
        }
        break;
      }
      default: {
        const simple = SIMPLE_TABLES.find((s) => s.type === t);
        if (simple && tableExists(simple.table)) {
          if (r.username && !hasUser(r.username)) { summary.skipped += 1; break; }
          if (!dryRun) insertByColumns(simple.table, r);
          break;
        }
        if (BOOK_TABLES.includes(t) && fp) {
          if (!r.username || !hasUser(r.username)) { summary.skipped += 1; break; }
          const id = ensureRef(fp);
          summary.bookRows += 1;
          if (dryRun) break;
          const row = { ...r, book_id: id };
          if (t === 'reader_book_revisions') {
            const now = new Date().toISOString();
            row.bookmarks_rev = now;
            row.annotations_rev = now;
          }
          insertByColumns(t, row);
          touchedUsers.add(r.username);
          break;
        }
        summary.skipped += 1;
      }
    }
  };

  let batch = [];
  const flushBatch = async () => {
    if (!batch.length) return;
    const current = batch;
    batch = [];
    runWithForeignKeysOff(() => db.transaction(() => { for (const rec of current) apply(rec); })());
    await yieldLoop();
  };

  let first = true;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { throw new BackupFormatError('Invalid JSON line'); }
      if (first) {
        first = false;
        if (rec?.format !== PORTABLE_BACKUP_FORMAT) throw new BackupFormatError('Not a portable backup');
        if (Number(rec.version) > PORTABLE_BACKUP_VERSION) throw new BackupFormatError('Backup is from a newer version');
        summary.header = rec;
        stamp.value = String(rec.createdAt || '').replace(/[^0-9TZ]/g, '').slice(0, 20) || 'x';
        continue;
      }
      batch.push(rec);
      if (batch.length >= 400) await flushBatch();
    }
    await flushBatch();
  } catch (error) {
    if (error instanceof BackupFormatError) throw error;
    const wrapped = new BackupFormatError(`Backup file cannot be read: ${error.message}`);
    throw wrapped;
  }
  if (first) throw new BackupFormatError('Empty file');

  if (!dryRun) {
    runWithForeignKeysOff(() => db.transaction(() => {
      for (const username of homeRewrite) {
        const row = db.prepare('SELECT home_layout FROM users WHERE username = ?').get(username);
        if (row?.home_layout) {
          db.prepare('UPDATE users SET home_layout = ? WHERE username = ?').run(rewriteHomeLayout(row.home_layout, maps), username);
        }
      }
    })());
    summary.matchedNow = runWithForeignKeysOff(() => reattachDetachedUserData(null));
    for (const username of touchedUsers) {
      touchUserReaderRevision(username, 'read_books_rev');
      touchUserReaderRevision(username, 'reading_history_rev');
    }
  }
  return summary;
}
