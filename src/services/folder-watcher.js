/**
 * Слежение за папочными источниками: изменения книг/архивов → после «тишины» (по умолчанию 120 с)
 * запускается инкрементальная индексация этого источника. Интервальный скан остаётся запасным вариантом:
 * на сетевых дисках (SMB/NFS) события часто не приходят.
 *
 * Включение и пауза — Админка → Источники (settings `folder_watch_enabled` / `folder_watch_quiet_sec`),
 * значения по умолчанию берутся из env FOLDER_WATCH / FOLDER_WATCH_QUIET_SEC.
 *
 * Устойчивость: наблюдатель — отдельный поток (см. folder-watch-worker.js); при ошибке (например, лимит inotify)
 * перезапуск с задержкой 5 мин → 10 мин → …, после 3 подряд неудач слежение за источником отключается до рестарта.
 * Настройки и список источников сверяются раз в минуту, поэтому изменения в админке подхватываются сами.
 * Источник без завершённой первой индексации не трогаем — первую индексацию запускает пользователь.
 * Статус каждого источника публикуется в meta (`folder_watch_status`) для админки.
 */
import fs from 'node:fs';
import cluster from 'node:cluster';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { db, getEnabledSources, getSourceById, setMeta } from '../db.js';
import { startSourceIndexing, onIndexComplete } from '../inpx.js';
import { logSystemEvent } from './system-events.js';

const RECONCILE_MS = 60_000;
const MAX_FAILURES = 3;
const BASE_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
const STABLE_AFTER_MS = 10 * 60_000;

export const FOLDER_WATCH_STATUS_META_KEY = 'folder_watch_status';

/** @type {Map<number, {path:string, worker:Worker|null, timer:any, failures:number, retryAt:number, readyAt:number, gaveUp:boolean, lastError:string, dirty:boolean}>} */
const watchers = new Map();
let reconcileTimer = null;
let options = null;
let lastPublishedStatus = '';
let indexCompleteHooked = false;

// Читаем settings напрямую (минуя кэш getSetting): в кластере значение мог сохранить другой воркер.
function readRawSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

/** Админские настройки (settings) поверх env-значений по умолчанию. */
export function getFolderWatchConfig() {
  const rawEnabled = readRawSetting('folder_watch_enabled');
  const rawQuiet = Number(readRawSetting('folder_watch_quiet_sec'));
  return {
    enabled: rawEnabled === '' ? config.folderWatch : rawEnabled === '1',
    quietSec: Number.isFinite(rawQuiet) && rawQuiet >= 10 && rawQuiet <= 3600
      ? Math.trunc(rawQuiet)
      : config.folderWatchQuietSec
  };
}

/** Статус для админки: страницу может отдавать любой воркер кластера, поэтому через meta. */
function publishStatus(enabled) {
  const sources = {};
  for (const [id, state] of watchers) {
    let status = 'unavailable';
    if (state.worker) status = state.readyAt ? 'watching' : 'starting';
    else if (state.gaveUp) status = 'failed';
    else if (state.failures > 0) status = 'retry';
    sources[id] = { status, error: state.lastError || '', retryAt: status === 'retry' ? state.retryAt : 0 };
  }
  const json = JSON.stringify({ enabled, sources });
  if (json === lastPublishedStatus) return;
  lastPublishedStatus = json;
  try {
    setMeta(FOLDER_WATCH_STATUS_META_KEY, json);
  } catch {
    /* статус нужен только для показа */
  }
}

/** @param {(key:string)=>string|null} getMetaFn */
export function readFolderWatchStatus(getMetaFn) {
  try {
    const parsed = JSON.parse(getMetaFn(FOLDER_WATCH_STATUS_META_KEY) || '{}');
    return { enabled: parsed.enabled !== false, sources: parsed.sources || {} };
  } catch {
    return { enabled: true, sources: {} };
  }
}

function stopWatcher(id) {
  const state = watchers.get(id);
  if (!state) return;
  clearTimeout(state.timer);
  const { worker } = state;
  state.worker = null;
  if (worker) worker.terminate().catch(() => {});
  watchers.delete(id);
}

function failWatcher(id, state, reason) {
  const { worker } = state;
  state.worker = null;
  clearTimeout(state.timer);
  if (worker) worker.terminate().catch(() => {});
  if (state.readyAt && Date.now() - state.readyAt > STABLE_AFTER_MS) state.failures = 0;
  state.readyAt = 0;
  state.lastError = String(reason || '').slice(0, 300);
  state.failures += 1;
  if (state.failures >= MAX_FAILURES) {
    state.gaveUp = true;
    logSystemEvent('warn', 'folder-watch', 'folder watching disabled for source, scheduled scans only', {
      sourceId: id,
      path: state.path,
      reason
    });
  } else {
    const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (state.failures - 1));
    state.retryAt = Date.now() + delay;
    logSystemEvent('warn', 'folder-watch', 'folder watcher failed, will retry', {
      sourceId: id,
      path: state.path,
      reason,
      retryInSec: Math.round(delay / 1000)
    });
  }
  publishStatus(true);
}

function fire(id) {
  const state = watchers.get(id);
  if (!state || !options) return;
  const source = getSourceById(id);
  if (!source || !source.enabled || !source.lastIndexedAt) return;
  const started = options.trigger(id);
  if (started) {
    state.dirty = false;
    logSystemEvent('info', 'folder-watch', 'folder changed, incremental index started', {
      sourceId: id,
      name: source.name
    });
    return;
  }
  // Индексатор занят: изменения не теряем, но и по таймеру не долбимся — запустим после УСПЕШНОГО завершения
  // текущей индексации. Остановленная пользователем индексация сама не перезапускается.
  state.dirty = true;
}

/** Вызывается по завершении индексации: источники, у которых были изменения во время неё, ставим в очередь. */
export function notifyIndexCompleted() {
  if (!options) return;
  for (const [id, state] of watchers) {
    if (state.dirty) {
      state.dirty = false;
      schedule(id);
    }
  }
}

function schedule(id) {
  const state = watchers.get(id);
  if (!state || !options) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => fire(id), options.quietMs);
  state.timer.unref?.();
}

function startWatcher(source) {
  let state = watchers.get(source.id);
  if (!state) {
    state = {
      path: source.path, worker: null, timer: null, failures: 0, retryAt: 0, readyAt: 0, gaveUp: false, lastError: '',
      dirty: false
    };
    watchers.set(source.id, state);
  }
  if (!fs.existsSync(source.path)) {
    state.lastError = 'path not found';
    return;
  }
  state.lastError = '';
  const worker = new Worker(new URL('./folder-watch-worker.js', import.meta.url), {
    workerData: { path: source.path }
  });
  worker.unref();
  state.worker = worker;
  worker.on('message', (msg) => {
    if (state.worker !== worker) return;
    if (msg.type === 'ready') {
      state.readyAt = Date.now();
      logSystemEvent('info', 'folder-watch', 'folder watcher started', { sourceId: source.id, path: source.path });
      publishStatus(true);
    } else if (msg.type === 'event') {
      schedule(source.id);
    } else if (msg.type === 'error') {
      failWatcher(source.id, state, `${msg.code || 'ERROR'}: ${msg.message}`);
    }
  });
  worker.on('error', (err) => {
    if (state.worker === worker) failWatcher(source.id, state, err.message);
  });
  worker.on('exit', () => {
    if (state.worker === worker) failWatcher(source.id, state, 'watcher thread exited');
  });
}

export function reconcileFolderWatchers() {
  if (!options) return;
  const cfg = getFolderWatchConfig();
  if (!options.fixedQuiet) options.quietMs = cfg.quietSec * 1000;
  if (!cfg.enabled) {
    if (watchers.size) logSystemEvent('info', 'folder-watch', 'folder watching turned off');
    for (const id of [...watchers.keys()]) stopWatcher(id);
    publishStatus(false);
    return;
  }
  const desired = new Map();
  for (const source of getEnabledSources()) {
    if (source.type === 'folder' && source.path) desired.set(source.id, source);
  }
  for (const [id, state] of [...watchers]) {
    const source = desired.get(id);
    if (!source || source.path !== state.path) stopWatcher(id);
  }
  const now = Date.now();
  for (const [id, source] of desired) {
    const state = watchers.get(id);
    if (state && (state.worker || state.gaveUp || now < state.retryAt)) continue;
    try {
      startWatcher(source);
    } catch (err) {
      const current = watchers.get(id);
      if (current) failWatcher(id, current, err.message);
    }
  }
  publishStatus(true);
}

/**
 * @param {{ trigger?: (sourceId:number)=>boolean, quietMs?: number, reconcileMs?: number }} [opts]
 */
export function startFolderWatcher(opts = {}) {
  if (reconcileTimer) return;
  // В кластере наблюдает только первый воркер — как Telegram-бот.
  if (cluster.isWorker && cluster.worker.id !== 1) return;
  if (!indexCompleteHooked) {
    indexCompleteHooked = true;
    onIndexComplete(() => notifyIndexCompleted());
  }
  options = {
    trigger: opts.trigger || ((sourceId) => startSourceIndexing(sourceId, false)),
    quietMs: opts.quietMs ?? config.folderWatchQuietSec * 1000,
    fixedQuiet: opts.quietMs != null
  };
  reconcileFolderWatchers();
  reconcileTimer = setInterval(reconcileFolderWatchers, opts.reconcileMs ?? RECONCILE_MS);
  reconcileTimer.unref?.();
}

export function stopFolderWatcher() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  for (const id of [...watchers.keys()]) stopWatcher(id);
  options = null;
  lastPublishedStatus = '';
}
