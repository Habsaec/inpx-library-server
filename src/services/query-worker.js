/**
 * worker_threads: read-only SQL for heavy aggregates (COUNT / GROUP BY over hundreds of thousands of books).
 *
 * Why a thread: these queries take 0.5–6 s on a 620k-book catalog; run on the main connection they stop the
 * whole server (web, OPDS, Android) for that long. Here they run on their own read-only connection (WAL: no
 * blocking of the writer), the main thread only waits for the answer. One long-lived worker: its page cache
 * stays warm between queries.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
try {
  db.pragma(`cache_size = -${Math.max(8, Number(workerData.cacheMb) || 64) * 1024}`);
  if (Number(workerData.mmapMb) > 0) db.pragma(`mmap_size = ${Math.floor(Number(workerData.mmapMb) * 1024 * 1024)}`);
  db.pragma('busy_timeout = 30000');
} catch { /* defaults are fine */ }

const statements = new Map();

parentPort.on('message', (msg) => {
  const { id, sql, params = [], mode = 'all' } = msg;
  try {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      if (statements.size > 200) statements.clear();
      statements.set(sql, stmt);
    }
    const result = mode === 'get' ? stmt.get(...params) : stmt.all(...params);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, message: error.message });
  }
});
