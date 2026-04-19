import { initDb } from '../src/db.js';
import { syncAllSourcesFlibustaFlag } from '../src/flibusta-sidecar.js';

const started = Date.now();
try {
  initDb();
  syncAllSourcesFlibustaFlag();
  const ms = Date.now() - started;
  if (ms > 1200) {
    console.log(`[flibusta] sidecar flags sync worker: ${ms}ms`);
  }
} catch (error) {
  console.warn('[flibusta] sidecar sync worker error:', error?.message || error);
  process.exitCode = 1;
}
