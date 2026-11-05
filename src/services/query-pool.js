/**
 * Main-thread side of `query-worker.js`: `queryAsync(sql, params)` → Promise of the rows.
 * Falls back to `fallback()` (the same query on the main connection) when the worker cannot be used, so a
 * failing thread never turns into an error page — only into the old, slower behaviour.
 */
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';

const WORKER_FILE = new URL('./query-worker.js', import.meta.url);
const DEFAULT_TIMEOUT_MS = 120_000;

let worker = null;
let seq = 0;
const pending = new Map();
let disabled = false;

function rejectAll(error) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
}

function ensureWorker() {
  if (worker || disabled) return worker;
  try {
    worker = new Worker(WORKER_FILE, {
      workerData: {
        dbPath: config.dbPath,
        cacheMb: Number(process.env.QUERY_WORKER_CACHE_MB) || 64,
        mmapMb: Number(process.env.QUERY_WORKER_MMAP_MB) || 0
      }
    });
  } catch {
    disabled = true;
    return null;
  }
  worker.unref?.();
  worker.on('message', (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.message || 'query failed'));
  });
  worker.on('error', (error) => {
    worker = null;
    rejectAll(error);
  });
  worker.on('exit', () => {
    worker = null;
    rejectAll(new Error('query worker exited'));
  });
  return worker;
}

/**
 * @param {string} sql
 * @param {any[]} params
 * @param {{ mode?: 'all'|'get', timeoutMs?: number, fallback?: () => any }} opts
 */
export function queryAsync(sql, params = [], { mode = 'all', timeoutMs = DEFAULT_TIMEOUT_MS, fallback = null } = {}) {
  const w = ensureWorker();
  if (!w) return Promise.resolve(fallback ? fallback() : Promise.reject(new Error('query worker unavailable')));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('query timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, sql, params, mode });
  }).catch((error) => {
    if (fallback) return fallback();
    throw error;
  });
}

export function stopQueryWorker() {
  disabled = false;
  const w = worker;
  worker = null;
  if (w) void w.terminate();
}
