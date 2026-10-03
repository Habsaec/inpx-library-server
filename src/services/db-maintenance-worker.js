/**
 * worker_threads: обслуживание SQLite вне потока HTTP.
 *
 * better-sqlite3 блокирует event loop на всё время вызова. PASSIVE checkpoint
 * большого WAL, TRUNCATE, ANALYZE и COUNT(*) снимка статистики поэтому
 * «вешают» все страницы, даже если сами по себе не держат читателей.
 * Здесь у соединения свой поток: сайт в это время отвечает.
 *
 * TRUNCATE с коротким busy_timeout не ждёт читателей. Эксклюзивная фаза
 * checkpoint больше не выполняется в потоке, который принимает HTTP.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const WAL_TRUNCATE_MIN_BYTES = 32 * 1024 * 1024;
const STATS_META_KEY = 'library_stats_snapshot';

function walFileSize(dbPath) {
  try {
    return fs.statSync(`${dbPath}-wal`).size;
  } catch {
    return 0;
  }
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function truncateWal(db, dbPath, busyMs) {
  const size = walFileSize(dbPath);
  if (size < WAL_TRUNCATE_MIN_BYTES) {
    return { skipped: true, size };
  }
  const prevBusy = db.pragma('busy_timeout', { simple: true });
  const prevMmap = db.pragma('mmap_size', { simple: true });
  try {
    db.pragma('mmap_size = 0');
    db.pragma(`busy_timeout = ${Number(busyMs) || 50}`);
    const t0 = Date.now();
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    const info = result[0] || {};
    return {
      skipped: false,
      ok: info.busy === 0,
      size,
      newSize: walFileSize(dbPath),
      busy: info.busy,
      ms: Date.now() - t0
    };
  } finally {
    db.pragma(`busy_timeout = ${Number(prevBusy) || 30000}`);
    db.pragma(`mmap_size = ${Number(prevMmap) || 0}`);
  }
}

/** Снимок счётчиков. SQL держать в паре с writeLibraryStatsSnapshot() в db.js. */
function writeStats(db) {
  const t0 = Date.now();
  const row = db.prepare(`
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
  `).get();
  const snapshot = {
    totalBooks: Number(row?.totalBooks) || 0,
    totalAuthors: Number(row?.totalAuthors) || 0,
    totalSeries: Number(row?.totalSeries) || 0,
    totalGenres: Number(row?.totalGenres) || 0,
    totalLanguages: Number(row?.totalLanguages) || 0
  };
  db.prepare(`
    INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(STATS_META_KEY, JSON.stringify(snapshot));
  const put = db.prepare(`
    INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const bookCols = new Set(db.prepare(`PRAGMA table_info(books)`).all().map((col) => col.name));
  if (bookCols.has('lang')) {
    put.run('catalog_distinct_langs', JSON.stringify(
      db.prepare(`SELECT DISTINCT lang FROM books WHERE lang != '' ORDER BY lang`).all().map((row) => row.lang)
    ));
  }
  if (bookCols.has('ext')) {
    put.run('catalog_distinct_exts', JSON.stringify(
      db.prepare(`SELECT DISTINCT ext FROM books WHERE ext != '' ORDER BY ext`).all().map((row) => row.ext)
    ));
  }
  return { ...snapshot, ms: Date.now() - t0 };
}

function analyzeAll(db) {
  const t0 = Date.now();
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sqlite_stat%'
    ORDER BY name
  `).all();
  for (const row of rows) {
    db.exec(`ANALYZE ${quoteIdent(row.name)}`);
  }
  return { tables: rows.length, ms: Date.now() - t0 };
}

function runOp(db, dbPath, op) {
  if (op === 'checkpoint') {
    const t0 = Date.now();
    const passive = db.pragma('wal_checkpoint(PASSIVE)')[0] || {};
    const truncate = truncateWal(db, dbPath, 50);
    return { ms: Date.now() - t0, passive, truncate };
  }
  if (op === 'truncate') {
    const t0 = Date.now();
    const truncate = truncateWal(db, dbPath, 600_000);
    return { ...truncate, ms: Date.now() - t0 };
  }
  if (op === 'stats') return writeStats(db);
  if (op === 'analyze') return analyzeAll(db);
  if (op === 'optimize') {
    const t0 = Date.now();
    db.pragma('optimize');
    return { ms: Date.now() - t0 };
  }
  if (op === 'dbstat') {
    const t0 = Date.now();
    try {
      const rows = db.prepare('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name').all();
      return {
        supported: true,
        ms: Date.now() - t0,
        rows: rows.map((row) => ({ name: row.name, bytes: Number(row.bytes) || 0 }))
      };
    } catch (err) {
      return { supported: false, ms: Date.now() - t0, rows: [], error: err?.message || String(err) };
    }
  }
  throw new Error(`unknown maintenance op: ${op}`);
}

const dbPath = workerData?.dbPath;
if (!dbPath || !parentPort) {
  throw new Error('db maintenance worker requires workerData.dbPath');
}

const db = new Database(dbPath, { timeout: 30000 });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');
db.pragma('temp_store = MEMORY');

parentPort.on('message', (msg) => {
  const id = msg?.id;
  try {
    parentPort.postMessage({ id, ok: true, op: msg?.op, ...runOp(db, dbPath, msg?.op) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, op: msg?.op, error: err?.message || String(err) });
  }
});
