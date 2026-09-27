/**
 * worker_threads: пересчёт book_count в authors / series_catalog / genres_catalog.
 *
 * Зачем отдельный поток: три GROUP BY по active_books на 700k+ книгах занимают
 * 20–50 с каждый. В основном потоке better-sqlite3 это блокирует event loop —
 * веб, OPDS и Android-клиент не получают ни одного ответа минуту и больше.
 *
 * Здесь тяжёлая часть (GROUP BY) — это чтение во временную таблицу; в WAL оно не
 * мешает ни читателям, ни писателю в основном потоке. Затем UPDATE идёт чанками по
 * id, чтобы write lock держался миллисекунды, а не десятки секунд.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const TARGETS = [
  { stage: 'catalog_authors', table: 'authors', link: 'book_authors', key: 'author_id' },
  { stage: 'catalog_series', table: 'series_catalog', link: 'book_series', key: 'series_id' },
  { stage: 'catalog_genres', table: 'genres_catalog', link: 'book_genres', key: 'genre_id' }
];
const CHUNK_IDS = 20000;

function recount(db, { table, link, key }) {
  db.exec('DROP TABLE IF EXISTS temp.cnt');
  db.exec('CREATE TEMP TABLE cnt (id INTEGER PRIMARY KEY, cnt INTEGER NOT NULL)');
  /* Чтение: не блокирует другие соединения в WAL. */
  db.exec(`
    INSERT INTO temp.cnt (id, cnt)
    SELECT l.${key}, COUNT(*) FROM ${link} l
    JOIN active_books b ON b.id = l.book_id
    GROUP BY l.${key}
  `);
  const range = db.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ${table}`).get();
  if (range?.lo == null) {
    db.exec('DROP TABLE temp.cnt');
    return;
  }
  const update = db.prepare(`
    UPDATE ${table}
    SET book_count = COALESCE((SELECT c.cnt FROM temp.cnt c WHERE c.id = ${table}.id), 0)
    WHERE id BETWEEN ? AND ?
      AND book_count IS NOT COALESCE((SELECT c.cnt FROM temp.cnt c WHERE c.id = ${table}.id), 0)
  `);
  for (let from = Number(range.lo); from <= Number(range.hi); from += CHUNK_IDS) {
    update.run(from, from + CHUNK_IDS - 1);
  }
  db.exec('DROP TABLE temp.cnt');
}

let db = null;
try {
  db = new Database(workerData.dbPath, { timeout: 30000 });
  db.pragma('busy_timeout = 30000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  const timings = {};
  for (const target of TARGETS) {
    parentPort.postMessage({ type: 'progress', stage: target.stage });
    const t0 = Date.now();
    recount(db, target);
    timings[target.table] = Date.now() - t0;
  }
  parentPort.postMessage({ type: 'done', timings });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err?.message || String(err) });
} finally {
  try { db?.close(); } catch {}
}
