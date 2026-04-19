#!/usr/bin/env node
/**
 * Отдельный процесс только для полной индексации (без HTTP).
 * Удобно для cron или низконагрузочного окна: не делит event loop с веб-запросами.
 *
 * Использование:
 *   node scripts/index-worker.js           # инкрементально, если уже есть indexed_at
 *   node scripts/index-worker.js --full    # полная пересборка
 *
 * Те же переменные окружения и data/, что у основного сервера.
 */
import '../src/load-env.js';
import { initDb } from '../src/db.js';
import { syncAllSourcesFlibustaFlag } from '../src/flibusta-sidecar.js';
import { startBackgroundIndexing, getIndexStatus } from '../src/inpx.js';

initDb();
try {
  syncAllSourcesFlibustaFlag();
} catch (e) {
  console.warn('[index-worker] sync sidecar flags:', e.message);
}

const force = process.argv.includes('--full');
const started = startBackgroundIndexing(force, !force);
if (!started) {
  console.error('[index-worker] indexer already running or could not start');
  process.exit(2);
}

const poll = setInterval(() => {
  const s = getIndexStatus();
  if (!s.active) {
    clearInterval(poll);
    if (s.error) {
      console.error('[index-worker] failed:', s.error);
      process.exit(1);
    }
    console.log('[index-worker] completed', s.indexedAt || s.finishedAt || '');
    process.exit(0);
  }
}, 400);
