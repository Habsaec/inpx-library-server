import os from 'node:os';
import cluster from 'node:cluster';

/* ── Глобальная защита от необработанных ошибок ── */
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
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
  cluster.on('exit', (worker, code, signal) => {
    console.log(`[cluster] Воркер ${worker.process.pid} завершился (code=${code}, signal=${signal}). Перезапуск...`);
    cluster.fork();
  });
} else {
  // Одиночный режим или воркер кластера
  await import('./server.js');
}
