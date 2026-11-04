/**
 * worker_threads: consistent copy of library.db through its own read-only connection.
 *
 * `db.backup()` on the main connection copies pages in short cycles ON THE MAIN THREAD; on a multi-GB file
 * over slow storage (NAS / Docker volume) those cycles add up to tens of seconds without a single answered
 * request («event loop stalled 17 s … 61 s»). Here the work runs off-thread. After the first small cycle the
 * rest is one step: it holds a single read snapshot (WAL: writers are not blocked), and — unlike many small
 * cycles through a second connection — the copy is never restarted because another connection wrote in between.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

try {
  const db = new Database(workerData.src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(workerData.dest, { progress: ({ totalPages }) => Math.max(totalPages, 1) });
  } finally {
    db.close();
  }
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
