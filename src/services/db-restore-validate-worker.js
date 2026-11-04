/**
 * Opens a candidate database read-only and checks it: quick_check + the tables the app cannot run without.
 * Runs in a worker thread — quick_check on a multi-GB file is minutes of synchronous work.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

const REQUIRED_TABLES = ['books', 'users', 'settings', 'meta', 'sources'];

try {
  const db = new Database(workerData.file, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma('quick_check');
    const verdict = Array.isArray(check) ? String(check[0]?.quick_check ?? Object.values(check[0] || {})[0] ?? '') : String(check);
    if (verdict !== 'ok') {
      parentPort.postMessage({ ok: false, message: `quick_check: ${verdict.slice(0, 200)}` });
    } else {
      const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !have.has(t));
      if (missing.length) {
        parentPort.postMessage({ ok: false, message: `missing tables: ${missing.join(', ')}` });
      } else {
        const books = db.prepare('SELECT COUNT(*) AS c FROM books').get().c;
        const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
        parentPort.postMessage({ ok: true, books, users });
      }
    }
  } finally {
    db.close();
  }
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
