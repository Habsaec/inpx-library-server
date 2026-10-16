/**
 * Scan scheduler — periodic re-indexing + housekeeping (cover-thumb GC).
 *
 * Поддерживает 4 режима через DB-настройки:
 *   • scan_schedule_mode = 'off'      — отключено
 *   • scan_schedule_mode = 'interval' — каждые scan_schedule_hours часов
 *   • scan_schedule_mode = 'daily'    — ежедневно в scan_schedule_time (HH:MM)
 *   • scan_schedule_mode = 'weekly'   — в указанные дни недели (scan_schedule_dow, CSV 0..6)
 *                                       в scan_schedule_time (0 = воскресенье, как Date#getDay())
 *
 * scan_schedule_full = '1' → запускать полную переиндексацию, иначе инкрементальную.
 *
 * Backward compatibility: если scan_schedule_mode пустой, но legacy scan_interval_hours > 0,
 * работаем как mode='interval' с этим количеством часов и full=false (старое поведение).
 *
 * Реализация на одиночных setTimeout (а не setInterval по N часов от старта):
 * для daily/weekly это даёт стабильное «в 03:00», а не «через 24 часа от запуска сервера».
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSetting, addScheduleLog } from '../db.js';
import { logSystemEvent } from './system-events.js';

let schedulerTimer = null;
let _triggerScanFn = null;
let coverThumbGcTimer = null;
let _nextRunAt = null; // ISO string или null

const COVER_THUMB_DISK_TTL_MS = config.coverThumbDiskTtlDays * 24 * 60 * 60_000;
const COVER_THUMB_DISK_MAX_BYTES = config.coverThumbDiskCacheMb * 1024 * 1024;
const COVER_THUMB_GC_INTERVAL_MS = 24 * 60 * 60_000; // раз в сутки

export async function gcCoverThumbDiskCache() {
  const root = path.join(config.dataDir, 'cover-thumb-cache');
  let removed = 0;
  let removedBytes = 0;
  let scanned = 0;
  const live = [];
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
            removedBytes += st.size;
          } else if (st.isFile()) {
            live.push({ abs, size: st.size, mtimeMs: st.mtimeMs });
          }
        } catch {
          /* ignore */
        }
      }
    }
    let liveBytes = live.reduce((sum, item) => sum + item.size, 0);
    if (liveBytes > COVER_THUMB_DISK_MAX_BYTES) {
      live.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const item of live) {
        if (liveBytes <= COVER_THUMB_DISK_MAX_BYTES) break;
        try {
          await fs.promises.unlink(item.abs);
          liveBytes -= item.size;
          removed += 1;
          removedBytes += item.size;
        } catch {
          /* ignore */
        }
      }
    }
    if (removed > 0 || scanned > 0) {
      logSystemEvent('info', 'scheduler', 'cover-thumb disk GC', {
        scanned,
        removed,
        removedBytes,
        liveBytes,
        maxBytes: COVER_THUMB_DISK_MAX_BYTES,
        ttlDays: config.coverThumbDiskTtlDays
      });
    }
  } catch (err) {
    logSystemEvent('warn', 'scheduler', 'cover-thumb disk GC failed', { error: err.message });
  }
}

/* ── Чтение конфига из БД с учётом legacy ───────────────────────── */

const VALID_MODES = new Set(['off', 'interval', 'daily', 'weekly']);
const HH_MM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Нормализовать поля формы расписания, включая старую форму с двумя name="time". */
export function parseScheduleForm(body = {}) {
  let mode = String(body.mode || '').toLowerCase().trim();
  if (!VALID_MODES.has(mode)) mode = 'off';

  const hours = Math.max(0, Math.min(8760, Math.floor(Number(body.hours) || 0)));
  let timeField = mode === 'weekly'
    ? (body.time_weekly ?? body.time)
    : (body.time_daily ?? body.time);
  if (Array.isArray(timeField)) {
    timeField = mode === 'weekly' ? timeField.at(-1) : timeField[0];
  }
  const timeRaw = String(timeField || '').trim();
  const time = HH_MM_RE.test(timeRaw) ? timeRaw : '';

  const dowField = body.dow;
  const dowArr = Array.isArray(dowField) ? dowField : (dowField ? [dowField] : []);
  const dow = dowArr
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    .filter((n, i, values) => values.indexOf(n) === i)
    .sort((a, b) => a - b)
    .join(',');
  const full = String(body.full || '') === '1';

  if (mode === 'interval' && hours <= 0) mode = 'off';
  if ((mode === 'daily' || mode === 'weekly') && !time) mode = 'off';
  if (mode === 'weekly' && !dow) mode = 'off';

  return { mode, hours, time, dow, full };
}

/** Извлечь все настройки расписания с легаси-fallback и валидацией. */
export function getScheduleConfig() {
  let mode = String(getSetting('scan_schedule_mode') || '').toLowerCase().trim();
  let hours = Math.max(0, Math.min(8760, Math.floor(Number(getSetting('scan_schedule_hours')) || 0)));
  let time = String(getSetting('scan_schedule_time') || '').trim();
  let dowRaw = String(getSetting('scan_schedule_dow') || '').trim();
  const full = String(getSetting('scan_schedule_full') || '') === '1';

  /* Legacy: если новый mode не задан, но есть scan_interval_hours — действуем как interval. */
  if (!VALID_MODES.has(mode)) {
    const legacyHours = Math.max(0, Math.min(8760, Math.floor(Number(getSetting('scan_interval_hours')) || 0)));
    if (legacyHours > 0) {
      mode = 'interval';
      hours = legacyHours;
    } else {
      mode = config.scanIntervalHours > 0 ? 'interval' : 'off';
      if (mode === 'interval') hours = config.scanIntervalHours;
    }
  }

  if (mode === 'interval' && hours <= 0) mode = 'off';
  if ((mode === 'daily' || mode === 'weekly') && !HH_MM_RE.test(time)) mode = 'off';

  /* Парсим DOW: «0,2,5» → [0,2,5]; для weekly должен быть непустым. */
  const dow = dowRaw.split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    .filter((n, i, a) => a.indexOf(n) === i)
    .sort((a, b) => a - b);
  if (mode === 'weekly' && dow.length === 0) mode = 'off';

  return { mode, hours, time, dow, full };
}

/** Посчитать следующий запуск в виде timestamp (ms) или null. now — для тестируемости. */
export function computeNextRunAt(cfg, now = Date.now()) {
  if (!cfg || cfg.mode === 'off') return null;

  if (cfg.mode === 'interval') {
    if (!cfg.hours || cfg.hours <= 0) return null;
    return now + cfg.hours * 60 * 60 * 1000;
  }

  if (cfg.mode === 'daily' || cfg.mode === 'weekly') {
    const m = HH_MM_RE.exec(cfg.time);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);

    /* Кандидат — сегодня в HH:MM в локальном времени. Используем Date(),
       поэтому DST-переходы обрабатываются корректно (Node учитывает TZ хоста). */
    const candidate = new Date(now);
    candidate.setHours(hh, mm, 0, 0);

    if (cfg.mode === 'daily') {
      if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate.getTime();
    }

    /* weekly: ищем ближайший разрешённый день недели (включая сегодня, если время ещё не прошло). */
    const allowed = new Set(cfg.dow);
    for (let i = 0; i < 8; i++) {
      const probe = new Date(candidate);
      probe.setDate(candidate.getDate() + i);
      if (i === 0 && probe.getTime() <= now) continue;
      if (allowed.has(probe.getDay())) return probe.getTime();
    }
    return null; // не должно случаться, но на всякий
  }

  return null;
}

/* ── Управление таймером ─────────────────────────────────────────── */

function clearScheduledTimer() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  _nextRunAt = null;
}

/*
 * setTimeout не любит значений > 2^31-1 (≈24.85 дня). Кроме того, раз в сутки
 * полезно «просыпаться» и проверять текущий nextRunAt — на случай корректировки
 * системных часов или если интервал длиннее суток. Поэтому длинные ожидания
 * режутся на куски по MAX_TIMEOUT.
 *
 * КРИТИЧНО: в ветке «проснулись раньше срока» НЕ пересчитываем nextAt
 * (это ломало interval > 24h — каждое пробуждение сдвигало цель вперёд),
 * а вызываем chainTimer(nextAt) с тем же таргетом.
 */
const MAX_TIMEOUT = 24 * 60 * 60 * 1000;

function chainTimer(nextAt) {
  const delta = Math.max(1000, Math.min(MAX_TIMEOUT, nextAt - Date.now()));
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;

    if (Date.now() < nextAt) {
      /* Ещё не время — продолжаем ждать тот же таргет, не пересчитывая. */
      chainTimer(nextAt);
      return;
    }

    const liveCfg = getScheduleConfig();
    if (liveCfg.mode === 'off') {
      _nextRunAt = null;
      return;
    }

    logSystemEvent('info', 'scheduler', 'Scheduled scan triggered', {
      mode: liveCfg.mode, full: liveCfg.full
    });
    try {
      addScheduleLog({ mode: liveCfg.mode, full: liveCfg.full, status: 'started', message: '' });
    } catch (err) {
      console.warn('[scheduler] addScheduleLog failed:', err.message);
    }
    try {
      _triggerScanFn({ full: liveCfg.full });
    } catch (err) {
      logSystemEvent('error', 'scheduler', 'Scheduled scan failed', { error: err.message });
      try { addScheduleLog({ mode: liveCfg.mode, full: liveCfg.full, status: 'error', message: err.message }); } catch {}
    }

    /* После срабатывания пересчитываем — теперь это корректно: новый цикл. */
    scheduleNextRun();
  }, delta);

  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
}

function scheduleNextRun() {
  const cfg = getScheduleConfig();
  if (cfg.mode === 'off' || !_triggerScanFn) {
    _nextRunAt = null;
    return;
  }

  const nextAt = computeNextRunAt(cfg);
  if (!nextAt) {
    _nextRunAt = null;
    return;
  }

  _nextRunAt = nextAt;
  chainTimer(nextAt);
}

/**
 * Start the scan scheduler.
 * @param {(opts: { full: boolean }) => void} triggerScan
 */
export function startScanScheduler(triggerScan) {
  _triggerScanFn = triggerScan;

  /* Cover-thumb GC — независимо от расписания сканирования. */
  if (!coverThumbGcTimer) {
    coverThumbGcTimer = setInterval(() => { void gcCoverThumbDiskCache(); }, COVER_THUMB_GC_INTERVAL_MS);
    if (typeof coverThumbGcTimer.unref === 'function') coverThumbGcTimer.unref();
    setTimeout(() => { void gcCoverThumbDiskCache(); }, 5 * 60_000).unref?.();
  }

  const cfg = getScheduleConfig();
  if (cfg.mode === 'off') {
    logSystemEvent('info', 'scheduler', 'Scan scheduler disabled');
    _nextRunAt = null;
    return;
  }

  logSystemEvent('info', 'scheduler', 'Scan scheduler started', {
    mode: cfg.mode, hours: cfg.hours, time: cfg.time, dow: cfg.dow, full: cfg.full
  });
  scheduleNextRun();
}

export function stopScanScheduler() {
  clearScheduledTimer();
  if (coverThumbGcTimer) {
    clearInterval(coverThumbGcTimer);
    coverThumbGcTimer = null;
  }
}

/**
 * Restart scheduler with current DB settings.
 * Called after admin changes scan schedule settings.
 */
export function restartScanScheduler() {
  clearScheduledTimer();
  if (_triggerScanFn) {
    const cfg = getScheduleConfig();
    if (cfg.mode === 'off') {
      logSystemEvent('info', 'scheduler', 'Scan scheduler disabled');
      return;
    }
    logSystemEvent('info', 'scheduler', 'Scan scheduler restarted', {
      mode: cfg.mode, hours: cfg.hours, time: cfg.time, dow: cfg.dow, full: cfg.full
    });
    scheduleNextRun();
  }
}

/** Время следующего запуска в ISO (или null). Для дашборда и API. */
export function getNextRunAt() {
  return _nextRunAt ? new Date(_nextRunAt).toISOString() : null;
}

/** Legacy: используется в renderAdminSources/route, оставляем для совместимости. */
export function getSchedulerIntervalHours() {
  const cfg = getScheduleConfig();
  return cfg.mode === 'interval' ? cfg.hours : 0;
}
