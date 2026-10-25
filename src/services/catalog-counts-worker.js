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

/* kind — ключ строк catalog_lang_counts (CATALOG_LANG_KIND в db.js). */
const TARGETS = [
  { stage: 'catalog_authors', table: 'authors', link: 'book_authors', key: 'author_id', kind: 1 },
  { stage: 'catalog_series', table: 'series_catalog', link: 'book_series', key: 'series_id', kind: 2 },
  { stage: 'catalog_genres', table: 'genres_catalog', link: 'book_genres', key: 'genre_id', kind: 3 }
];
const CHUNK_IDS = 20000;

function recount(db, { table, link, key, kind }) {
  db.exec('DROP TABLE IF EXISTS temp.cnt');
  db.exec('DROP TABLE IF EXISTS temp.cnt_lang');
  db.exec('CREATE TEMP TABLE cnt (id INTEGER PRIMARY KEY, cnt INTEGER NOT NULL)');
  db.exec('CREATE TEMP TABLE cnt_lang (id INTEGER NOT NULL, lang TEXT NOT NULL, cnt INTEGER NOT NULL, PRIMARY KEY (id, lang)) WITHOUT ROWID');
  /* Чтение: не блокирует другие соединения в WAL. Один проход с разбивкой по языку —
     из него же и общий book_count, и счётчики для списков с языками профиля. */
  db.exec(`
    INSERT INTO temp.cnt_lang (id, lang, cnt)
    SELECT l.${key}, COALESCE(b.lang, ''), COUNT(*) FROM ${link} l
    JOIN active_books b ON b.id = l.book_id
    GROUP BY l.${key}, COALESCE(b.lang, '')
  `);
  db.exec('INSERT INTO temp.cnt (id, cnt) SELECT id, SUM(cnt) FROM temp.cnt_lang GROUP BY id');
  const range = db.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ${table}`).get();
  if (range?.lo == null) {
    db.prepare('DELETE FROM catalog_lang_counts WHERE kind = ?').run(kind);
    db.exec('DROP TABLE temp.cnt');
    db.exec('DROP TABLE temp.cnt_lang');
    return;
  }
  const update = db.prepare(`
    UPDATE ${table}
    SET book_count = COALESCE((SELECT c.cnt FROM temp.cnt c WHERE c.id = ${table}.id), 0)
    WHERE id BETWEEN ? AND ?
      AND book_count IS NOT COALESCE((SELECT c.cnt FROM temp.cnt c WHERE c.id = ${table}.id), 0)
  `);
  const dropLang = db.prepare('DELETE FROM catalog_lang_counts WHERE kind = ? AND id BETWEEN ? AND ?');
  const fillLang = db.prepare(`
    INSERT INTO catalog_lang_counts (kind, id, lang, book_count)
    SELECT ?, id, lang, cnt FROM temp.cnt_lang WHERE id BETWEEN ? AND ?
  `);
  const replaceLangChunk = db.transaction((lo, hi) => {
    dropLang.run(kind, lo, hi);
    fillLang.run(kind, lo, hi);
  });
  for (let from = Number(range.lo); from <= Number(range.hi); from += CHUNK_IDS) {
    update.run(from, from + CHUNK_IDS - 1);
    replaceLangChunk(from, from + CHUNK_IDS - 1);
  }
  /* Строки удалённых из каталога id (вне диапазона текущей таблицы). */
  db.prepare('DELETE FROM catalog_lang_counts WHERE kind = ? AND (id < ? OR id > ?)').run(kind, Number(range.lo), Number(range.hi));
  db.exec('DROP TABLE temp.cnt');
  db.exec('DROP TABLE temp.cnt_lang');
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
  db.prepare("INSERT INTO meta (key, value) VALUES ('catalog_lang_counts_ready', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  /* Close before "done": the parent starts the stats snapshot immediately, and
     close() still holds the file. That wait has no timeout and never finishes. */
  db.close();
  db = null;
  parentPort.postMessage({ type: 'done', timings });
} catch (err) {
  try { db?.close(); } catch {}
  parentPort.postMessage({ type: 'error', message: err?.message || String(err) });
} finally {
  /* parentPort stays referenced and would keep this thread, and the parent, alive. */
  try { parentPort.close(); } catch {}
}
