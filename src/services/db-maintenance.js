/**
 * Очередь обслуживания SQLite в отдельном потоке.
 * Поток HTTP только отправляет задание и принимает ответ.
 */
import cluster from 'node:cluster';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';

const WORKER_URL = new URL('./db-maintenance-worker.js', import.meta.url);

let worker = null;
let stopping = false;
let seq = 0;
let chain = Promise.resolve();
const pending = new Map();

/** Периодический checkpoint и прогрев статистики — в одном процессе кластера. */
export function shouldRunDbMaintenanceInThisProcess() {
  return !cluster.isWorker || cluster.worker.id === 1;
}

function failPending(err) {
  for (const [, entry] of pending) {
    entry.reject(err);
  }
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  const next = new Worker(WORKER_URL, {
    workerData: { dbPath: config.dbPath },
    execArgv: []
  });
  if (typeof next.unref === 'function') next.unref();
  next.on('message', (msg) => {
    const entry = pending.get(msg?.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(msg.error || 'db maintenance failed'));
  });
  next.on('error', (err) => {
    worker = null;
    failPending(err);
  });
  next.on('exit', (code) => {
    if (worker !== next) return;
    worker = null;
    if (stopping) return;
    failPending(new Error(`db maintenance worker exited (${code})`));
  });
  worker = next;
  return next;
}

function exec(op) {
  if (stopping) return Promise.reject(new Error('db maintenance stopped'));
  const id = ++seq;
  const current = ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    current.postMessage({ id, op });
  });
}

export function runDbMaintenance(op) {
  const run = chain.then(() => exec(op));
  chain = run.then(() => {}, () => {});
  return run;
}

export function stopDbMaintenance() {
  stopping = true;
  const current = worker;
  worker = null;
  failPending(new Error('db maintenance stopped'));
  if (current) {
    current.terminate().catch(() => {});
  }
}
