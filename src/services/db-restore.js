/**
 * Full database restore, admin half: pick / upload a candidate, validate it in a worker, then write the
 * marker and restart; `db-restore-boot.js` does the swap before the database is opened.
 * Sources are an allow-list (data/backups/library-*.db, data/restore/upload-*.db, library.db.pre-restore-*).
 * Free space matters: a copied source needs room for a whole second database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import {
  resolveRestoreSource, listRestoreSources, RESTORE_MARKER, RESTORE_RESULT
} from '../db-restore-boot.js';

export { listRestoreSources };

const WORKER_FILE = new URL('./db-restore-validate-worker.js', import.meta.url);

export function restoreSources() {
  return listRestoreSources(config.dataDir);
}

export function restoreUploadDir() {
  return path.join(config.dataDir, 'restore');
}

export function freeBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail ?? stat.bfree) * Number(stat.bsize);
  } catch {
    return Infinity; // cannot tell — do not block
  }
}

let job = null; // { id, state: 'running'|'ok'|'failed', message, size, mtimeMs, books, users, startedAt }

export function getRestoreValidation() {
  return job ? { ...job } : null;
}

export function startRestoreValidation(id) {
  const source = resolveRestoreSource(config.dataDir, id);
  if (!source || !fs.existsSync(source.full)) {
    const err = new Error('Source not found');
    err.code = 'RESTORE_SOURCE_MISSING';
    throw err;
  }
  if (job?.state === 'running') {
    const err = new Error('A validation is already running');
    err.code = 'RESTORE_BUSY';
    throw err;
  }
  const stat = fs.statSync(source.full);
  job = { id: source.id, state: 'running', message: '', size: stat.size, mtimeMs: stat.mtimeMs, startedAt: Date.now() };
  const current = job;
  const worker = new Worker(WORKER_FILE, { workerData: { file: source.full } });
  worker.once('message', (msg) => {
    current.state = msg.ok ? 'ok' : 'failed';
    current.message = msg.message || '';
    current.books = msg.books;
    current.users = msg.users;
  });
  worker.once('error', (error) => { current.state = 'failed'; current.message = error.message; });
  worker.once('exit', () => { if (current.state === 'running') { current.state = 'failed'; current.message = 'validator stopped'; } });
  return { ...job };
}

/** Writes the marker for the boot step. Requires a fresh, successful validation of exactly this file. */
export function scheduleRestore(id) {
  const source = resolveRestoreSource(config.dataDir, id);
  if (!source || !fs.existsSync(source.full)) {
    const err = new Error('Source not found');
    err.code = 'RESTORE_SOURCE_MISSING';
    throw err;
  }
  const stat = fs.statSync(source.full);
  if (!job || job.id !== source.id || job.state !== 'ok' || job.size !== stat.size || job.mtimeMs !== stat.mtimeMs) {
    const err = new Error('Validate the file first');
    err.code = 'RESTORE_NOT_VALIDATED';
    throw err;
  }
  if (!source.move && freeBytes(config.dataDir) < stat.size * 1.1) {
    const err = new Error('Not enough free disk space for a second copy of the database');
    err.code = 'RESTORE_NO_SPACE';
    throw err;
  }
  fs.writeFileSync(
    path.join(config.dataDir, RESTORE_MARKER),
    JSON.stringify({ source: source.id, size: stat.size, requestedAt: new Date().toISOString() })
  );
  return { source: source.id, size: stat.size };
}

/** Result of the last boot-time restore, shown once on the admin page. */
export function takeRestoreResult() {
  const file = path.join(config.dataDir, RESTORE_RESULT);
  try {
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    return result;
  } catch {
    return null;
  }
}

export function deleteRestoreSource(id) {
  const source = resolveRestoreSource(config.dataDir, id);
  if (!source || source.dir === '.') return false; // pre-restore copies are cleaned automatically
  fs.rmSync(source.full, { force: true });
  return true;
}
