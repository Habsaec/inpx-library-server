import os from 'node:os';
import cluster from 'node:cluster';

/* ── Глобальная защита от необработанных ошибок ── */
// Ленивая ссылка: устанавливается после загрузки server.js,
// чтобы корректно закрыть HTTP-сервер и БД при фатальной ошибке.
let _gracefulExit = null;

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  if (_gracefulExit) _gracefulExit(1);
  else process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  if (_gracefulExit) _gracefulExit(1);
  else process.exit(1);
});

// Important: UV_THREADPOOL_SIZE must be set before importing heavy modules
// that use fs/zlib work queues (archive extraction, conversions).
if (!process.env.UV_THREADPOOL_SIZE) {
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 4;
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  const envProfile = (process.env.PERF_PROFILE || '').trim().toLowerCase();
  const isEmbedded = envProfile === 'embedded' || (envProfile !== 'default' && totalMemMb <= 2048);
  const tuned = isEmbedded
    ? Math.max(4, cpuCount)
    : Math.max(16, Math.min(32, cpuCount * 2));
  process.env.UV_THREADPOOL_SIZE = String(tuned);
}

/* ── Cluster-режим: CLUSTER_WORKERS=N форкает N воркеров ── */
const requestedWorkers = Number(process.env.CLUSTER_WORKERS) || 0;
const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 4;
const numWorkers = requestedWorkers > 0 ? Math.min(requestedWorkers, cpuCount) : 0;

if (numWorkers > 1 && cluster.isPrimary) {
  console.log(`[cluster] Primary ${process.pid}: запуск ${numWorkers} воркеров`);
  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  const RESTART_WINDOW_MS = 60_000;
  const MAX_RESTARTS_IN_WINDOW = 5;
  let _recentRestarts = [];
  let _shuttingDown = false;

  process.on('SIGTERM', () => { _shuttingDown = true; });
  process.on('SIGINT', () => { _shuttingDown = true; });

  cluster.on('exit', (worker, code, signal) => {
    if (_shuttingDown) {
      console.log(`[cluster] Worker ${worker.process.pid} exited during shutdown, not restarting`);
      return;
    }

    const now = Date.now();
    _recentRestarts = _recentRestarts.filter(t => now - t < RESTART_WINDOW_MS);
    _recentRestarts.push(now);

    if (_recentRestarts.length > MAX_RESTARTS_IN_WINDOW) {
      console.error(`[cluster] Worker crash loop detected (${_recentRestarts.length} restarts in ${RESTART_WINDOW_MS / 1000}s), backing off`);
      const backoffMs = Math.min(30_000, 1000 * Math.pow(2, _recentRestarts.length - MAX_RESTARTS_IN_WINDOW));
      setTimeout(() => { cluster.fork(); }, backoffMs);
    } else {
      console.log(`[cluster] Воркер ${worker.process.pid} завершился (code=${code}, signal=${signal}). Перезапуск...`);
      cluster.fork();
    }
  });
} else {
  // Одиночный режим или воркер кластера
  const { gracefulExit } = await import('./server.js');
  _gracefulExit = gracefulExit;
}
