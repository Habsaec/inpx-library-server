/**
 * Scan scheduler — periodic incremental re-indexing.
 * Configured via DB setting `scan_interval_hours` (fallback: SCAN_INTERVAL_HOURS env, 0 = disabled).
 */
import { config } from '../config.js';
import { getSetting } from '../db.js';
import { logSystemEvent } from './system-events.js';

let schedulerTimer = null;
let _triggerScanFn = null;

function getSchedulerHours() {
  const dbVal = Number(getSetting('scan_interval_hours'));
  if (dbVal > 0) return dbVal;
  return config.scanIntervalHours;
}

/**
 * Start the scan scheduler. Calls `triggerScan()` every N hours.
 * @param {() => void} triggerScan — function that starts incremental indexing
 */
export function startScanScheduler(triggerScan) {
  _triggerScanFn = triggerScan;
  const hours = getSchedulerHours();
  if (!hours || hours <= 0) return;

  const intervalMs = hours * 60 * 60 * 1000;
  console.log(`[scheduler] Scan scheduled every ${hours}h (${(intervalMs / 60000).toFixed(0)} min)`);
  logSystemEvent('info', 'scheduler', `Scan scheduler started: every ${hours}h`);

  schedulerTimer = setInterval(() => {
    console.log('[scheduler] Triggering scheduled incremental scan');
    logSystemEvent('info', 'scheduler', 'Scheduled incremental scan triggered');
    try {
      triggerScan();
    } catch (err) {
      console.error('[scheduler] Scan trigger failed:', err.message);
      logSystemEvent('error', 'scheduler', 'Scheduled scan failed', { error: err.message });
    }
  }, intervalMs);
  schedulerTimer.unref();
}

export function stopScanScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/**
 * Restart scheduler with current DB/env settings.
 * Called after admin changes scan_interval_hours.
 */
export function restartScanScheduler() {
  stopScanScheduler();
  if (_triggerScanFn) {
    startScanScheduler(_triggerScanFn);
  }
}

export function getSchedulerIntervalHours() {
  return getSchedulerHours();
}
