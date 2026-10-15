/**
 * Пул worker_threads для JPEG XL → JPEG/PNG (см. jxl-worker.js).
 * Воркеры поднимаются по требованию и завершаются после простоя; при любой неудаче
 * (sharp выключен, воркер не стартовал, таймаут) decodeJxlInWorker возвращает null —
 * вызывающий откатывается на декод в главном потоке.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { parseEnvTimeoutMs } from '../utils/async-timeout.js';

const WORKER_URL = new URL('./jxl-worker.js', import.meta.url);
const IDLE_MS = 20_000;
const TASK_TIMEOUT_MS = parseEnvTimeoutMs('JXL_WORKER_TIMEOUT_MS', 60_000);

/** JXL_WORKERS=0 отключает пул (декод в главном потоке, как раньше). */
export function getJxlWorkerLimit() {
  const env = Number.parseInt(String(process.env.JXL_WORKERS ?? ''), 10);
  if (Number.isFinite(env)) return Math.max(0, Math.min(env, 16));
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(6, Math.max(1, cpus - 1));
}

const workers = new Set();
const queue = [];
let nextTaskId = 1;
let spawnFailed = false;

function settle(task, result) {
  clearTimeout(task.timer);
  task.resolve(result);
}

function finish(slot, result) {
  const { task } = slot;
  if (!task) return;
  slot.task = null;
  settle(task, result);
  slot.worker.unref(); // idle-воркер не держит процесс
  slot.idleTimer = setTimeout(() => retire(slot), IDLE_MS);
  slot.idleTimer.unref();
  pump();
}

function retire(slot) {
  if (slot.task) return;
  workers.delete(slot);
  slot.worker.terminate().catch(() => {});
}

function kill(slot, result) {
  workers.delete(slot);
  clearTimeout(slot.idleTimer);
  slot.worker.terminate().catch(() => {});
  const { task } = slot;
  slot.task = null;
  if (task) settle(task, result);
  pump();
}

function spawn() {
  const worker = new Worker(WORKER_URL);
  const slot = { worker, ready: false, task: null, idleTimer: null };
  workers.add(slot);
  worker.on('message', (msg) => {
    if (msg?.ready) {
      slot.ready = true;
      pump();
      if (!slot.task) {
        // Воркер поднят «про запас», а очередь уже разобрана: не держим процесс и закрываем по простою.
        slot.worker.unref();
        slot.idleTimer = setTimeout(() => retire(slot), IDLE_MS);
        slot.idleTimer.unref();
      }
      return;
    }
    if (!slot.task || msg?.id !== slot.task.id) return;
    finish(slot, msg.error || !msg.data ? null : { contentType: msg.contentType, data: Buffer.from(msg.data) });
  });
  worker.on('error', (err) => {
    if (!slot.ready) {
      spawnFailed = true;
      console.warn('[jxl] worker failed to start, decoding in main thread:', err?.message || err);
    }
    kill(slot, null);
  });
  worker.on('exit', () => {
    if (workers.has(slot)) kill(slot, null);
  });
}

function pump() {
  if (spawnFailed) {
    while (queue.length) settle(queue.shift(), null);
    return;
  }
  while (queue.length) {
    const slot = [...workers].find((w) => w.ready && !w.task);
    if (!slot) {
      if (workers.size < getJxlWorkerLimit()) spawn();
      return;
    }
    const task = queue.shift();
    clearTimeout(slot.idleTimer);
    slot.worker.ref();
    slot.task = task;
    task.timer = setTimeout(() => kill(slot, null), TASK_TIMEOUT_MS);
    slot.worker.postMessage({ id: task.id, bytes: task.bytes }, [task.bytes.buffer]);
  }
}

/**
 * @param {Buffer} buf JXL
 * @returns {Promise<{ contentType: string, data: Buffer } | null>}
 */
export function decodeJxlInWorker(buf) {
  if (!buf?.length || spawnFailed || !config.coverProcessingEnabled || getJxlWorkerLimit() < 1) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    // Копия: исходный Buffer может быть куском общего пула и не должен «отсоединяться».
    queue.push({ id: nextTaskId++, bytes: new Uint8Array(buf), resolve, timer: null });
    pump();
  });
}
