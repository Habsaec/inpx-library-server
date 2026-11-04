/**
 * Database file copy that never blocks the event loop (see db-backup-worker.js).
 * Falls back to the main-thread `db.backup()` only when the worker cannot run, with a warning.
 */
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';

const WORKER_FILE = new URL('./db-backup-worker.js', import.meta.url);

function runWorker(dest) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE, { workerData: { src: config.dbPath, dest } });
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    worker.once('message', (msg) => (msg.ok ? done(resolve) : done(reject, new Error(msg.message || 'backup failed'))));
    worker.once('error', (error) => done(reject, error));
    worker.once('exit', (code) => done(reject, new Error(`backup worker exited (${code})`)));
  });
}

/**
 * @param {string} dest target file
 * @param {import('better-sqlite3').Database} fallbackDb main connection used only if the worker fails
 */
export async function backupDatabaseOffThread(dest, fallbackDb) {
  try {
    await runWorker(dest);
  } catch (error) {
    await fs.promises.unlink(dest).catch(() => {});
    if (!fallbackDb) throw error;
    console.warn(`[db] off-thread backup failed (${error.message}); using the main-thread copy`);
    await fallbackDb.backup(dest);
  }
}
