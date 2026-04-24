/**
 * Scan scheduler — periodic incremental re-indexing + housekeeping (cover-thumb GC).
 * Configured via DB setting `scan_interval_hours` (fallback: SCAN_INTERVAL_HOURS env, 0 = disabled).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSetting } from '../db.js';
import { logSystemEvent } from './system-events.js';

let schedulerTimer = null;
let _triggerScanFn = null;
let coverThumbGcTimer = null;

const COVER_THUMB_DISK_TTL_MS = 7 * 24 * 60 * 60_000;
const COVER_THUMB_GC_INTERVAL_MS = 24 * 60 * 60_000; // раз в сутки

async function gcCoverThumbDiskCache() {
  const root = path.join(config.dataDir, 'cover-thumb-cache');
  let removed = 0;
  let scanned = 0;
  try {
    const subDirs = await fs.promises.readdir(root).catch(() => []);
    const now = Date.now();
    for (const sub of subDirs) {
      const subAbs = path.join(root, sub);
      let files;
      try {
        files = await fs.promises.readdir(subAbs);
      } catch {
        continue;
      }
      for (const f of files) {
        scanned += 1;
        const abs = path.join(subAbs, f);
        try {
          const st = await fs.promises.stat(abs);
          if (now - st.mtimeMs > COVER_THUMB_DISK_TTL_MS) {
            await fs.promises.unlink(abs).catch(() => {});
            removed += 1;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (removed > 0 || scanned > 0) {
      logSystemEvent('info', 'scheduler', 'cover-thumb disk GC', { scanned, removed });
    }
  } catch (err) {
    logSystemEvent('warn', 'scheduler', 'cover-thumb disk GC failed', { error: err.message });
  }
}

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

  // Housekeeping: cover-thumb GC работает независимо от включённого scan-планировщика.
  if (!coverThumbGcTimer) {
    coverThumbGcTimer = setInterval(() => { void gcCoverThumbDiskCache(); }, COVER_THUMB_GC_INTERVAL_MS);
    coverThumbGcTimer.unref();
    setTimeout(() => { void gcCoverThumbDiskCache(); }, 5 * 60_000).unref();
  }

  const hours = getSchedulerHours();
  if (!hours || hours <= 0) return;

  const intervalMs = hours * 60 * 60 * 1000;
  logSystemEvent('info', 'scheduler', `Scan scheduler started: every ${hours}h`);

  schedulerTimer = setInterval(() => {
    logSystemEvent('info', 'scheduler', 'Scheduled incremental scan triggered');
    try {
      triggerScan();
    } catch (err) {
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
  if (coverThumbGcTimer) {
    clearInterval(coverThumbGcTimer);
    coverThumbGcTimer = null;
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
