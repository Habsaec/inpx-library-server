import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { brotliCompress, constants as zlibConstants } from 'node:zlib';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';

import { config } from './config.js';
import { runWithLocale, t, setDefaultLocale } from './i18n.js';
import { ApiErrorCode, apiFail } from './api-errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerBrowseApiRoutes } from './routes/browse-api.js';
import { registerProfileApiRoutes } from './routes/profile-api.js';
import { registerOpdsRoutes } from './routes/opds.js';
import { registerOpdsV2Routes } from './routes/opds-v2.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerOidcRoutes } from './routes/oidc.js';
import { registerDownloadRoutes } from './routes/download.js';
import { registerReaderRoutes } from './routes/reader.js';
import { registerUserApiRoutes } from './routes/user-api.js';
import { setDisabledDownloadFormats } from './download-formats.js';
import { setDownloadFilenameStyle } from './download-filename.js';
import { setFb2WebpMode } from './fb2-webp-images.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerLibraryRoutes, detailsCache, getDetailsFull, bookFlibustaSidecarEffective } from './routes/library.js';
import { registerLiteRoutes } from './routes/lite.js';
// --- Extracted modules ---
import { securityHeaders } from './middleware/security-headers.js';
import { browseLimiter } from './middleware/rate-limiter-browse.js';
import { bookRefUrlRewrite } from './middleware/book-ref-rewrite.js';
import {
  attachSessionUser, csrfGuard,
  requireAdminWeb
} from './middleware/auth.js';

import {
  isRateLimited, registerFailedLogin, clearLoginAttempts,
  getClientKey, pruneExpiredEntries as pruneLoginAttempts
} from './services/rate-limiter.js';
import { getOnlineUserCount, pruneOfflineUsers } from './services/online-tracker.js';
import { createPerfMetricsMiddleware, getPerfSnapshot } from './services/perf-metrics.js';
import { getCachedPageData, clearPageDataCache } from './services/cache.js';
import { getPublicUiSettingsJson, serveUiAsset } from './services/ui-customization.js';
import { logSystemEvent } from './services/system-events.js';

import { mirrorIndexingLogsToDataFile, appendIndexDiaryLine } from './services/file-log.js';
import { installRuntimeLogCapture } from './services/runtime-logs.js';
import { startScanScheduler } from './services/scheduler.js';
import { startTelegramBot, stopTelegramBot, restartTelegramBot, isTelegramBotRunning, shouldRunTelegramBotInThisProcess, registerTelegramBotRoutes, announceNewBooksInTelegram, testAnnounceNewBooksInTelegram, syncTelegramBotProfilePhoto } from './services/telegram-bot.js';
import {
  STATS_CACHE_TTL_MS, HOME_SECTIONS_CACHE_TTL_MS
} from './constants.js';
import { db, getUserByUsername, hasAdminUser, initDb, ensureSchemaIndexes, analyzeDatabaseYielding, getSmtpSettings, getUserStats, getSetting, setSetting, getSources, decryptValue, getMeta, setMeta, rebuildBooksFtsFromContent, ensureBooksFtsTriggers, rebuildActiveBooksView, refreshCatalogBookCounts, countSuppressedBooks, countIndexedDeletedBooks, getDbBreakdown, getTelegramSettings, invalidateBooksFtsHealthCache, getBooksFtsStatus, tryIdleWalTruncate, compactWalExclusive } from './db.js';
import {
  backfillCatalogSearchFields,
  getConfiguredInpxFile,
  getLibraryRoot,
  getIndexStatus,
  getLibrarySections,
  getStats,
  setConfiguredInpxFile,
  startBackgroundIndexing,
  onIndexComplete
} from './inpx.js';

import {
  renderAdminEvents,
  renderAdminDuplicates,
  renderAdminContent,
  renderAdminUsers,
  renderBook,
  renderFavorites,
  renderBrowsePage,
  renderCatalog,
  renderSearchOverview,
  renderFacetBooks,
  renderAuthorFacetPage,
  renderAuthorOutsideSeriesPage,
  renderHome,
  renderLibraryView,
  renderOperations,
  renderShelves,
  renderShelfDetail,
  renderAdminSmtp,
  renderAdminTelegram,
  renderAdminUpdate,
  renderAdminSources,
  renderAdminAppearance,
  renderReader,
  renderMaintenance,
  setSiteName,
  setAllowAnonymousDownload
} from './templates.js';

mirrorIndexingLogsToDataFile();
installRuntimeLogCapture();

const app = express();
app.set('trust proxy', config.trustProxy);
app.use(securityHeaders);
// Сбор пер-роутовых таймингов (count/avg/p95/max) — для диагностики медленных страниц.
// Монтируем максимально рано, чтобы учитывать полное время обработки запроса.
app.use(createPerfMetricsMiddleware());
const serverStartedAt = new Date();
let lastKnownIndexActive = false;
let lastIndexProgressLog = 0;
/** Редкие system-events о ходе индексации (для Live logs / «События»), без спама каждые 12 с. */
let lastKeyIndexProgressEvent = 0;
function readCgroupMemoryLimitBytes() {
  try {
    const v2 = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (v2 !== 'max') {
      const n = Number(v2);
      if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) return n;
    }
  } catch {}
  try {
    const v1 = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
    const n = Number(v1);
    if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) return n;
  } catch {}
  return null;
}

function readCgroupCpuCount() {
  try {
    const v2 = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    const parts = v2.split(/\s+/);
    if (parts.length === 2) {
      const quota = parts[0] === 'max' ? Infinity : Number(parts[0]);
      const period = Number(parts[1]);
      if (Number.isFinite(quota) && Number.isFinite(period) && period > 0 && quota > 0 && quota !== Infinity) {
        return Math.max(1, quota / period);
      }
    }
  } catch {}
  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
    if (Number.isFinite(quota) && Number.isFinite(period) && period > 0 && quota > 0) {
      return Math.max(1, quota / period);
    }
  } catch {}
  return null;
}

/** Лимит памяти для контейнера (cgroup) или fallback на os.totalmem(). */
function getSystemMemoryLimitMB() {
  const cgroup = readCgroupMemoryLimitBytes();
  if (cgroup) return Math.round(cgroup / 1024 / 1024);
  return Math.round(os.totalmem() / 1024 / 1024);
}

/** Количество CPU для контейнера (cgroup) или fallback на os.cpus().length. */
function getCpuCount() {
  return readCgroupCpuCount() ?? Math.max(1, Array.isArray(os.cpus()) ? os.cpus().length : 1);
}

const operationsState = {
  reindexRunning: false,
  repairRunning: false,
  ftsRebuildRunning: false,
  sidecarRunning: false,
  sourceDeleteRunning: false,
  dupCleanRunning: false,
  dupCleanProgress: null,
  lastReindexRequestedAt: null,
  lastFtsRebuildRequestedAt: null,
  lastSidecarRequestedAt: null,
  lastSourceDeleteRequestedAt: null,
  lastRestartRequestedAt: null,
  lastStopRequestedAt: null
};

let lastCpuSampleUsage = process.cpuUsage();
let lastCpuSampleAtMs = Date.now();

/**
 * Замер CPU: возвращает два значения.
 *   - `all`: % от общей мощности (нормирован на количество ядер). 100% = вся машина занята.
 *   - `single`: % от одного ядра (клипуется на 100%). Полезнее для нашей single-threaded
 *     архитектуры (Node + better-sqlite3 синхронно занимают одно ядро).
 */
function sampleProcessCpuPercent() {
  const nowMs = Date.now();
  const usage = process.cpuUsage();
  const elapsedMs = Math.max(1, nowMs - lastCpuSampleAtMs);
  const deltaUser = usage.user - lastCpuSampleUsage.user;
  const deltaSystem = usage.system - lastCpuSampleUsage.system;
  const cpuCount = getCpuCount();
  const totalMs = (deltaUser + deltaSystem) / 1000;
  const ratioAll = totalMs / (elapsedMs * cpuCount);
  const ratioSingle = totalMs / elapsedMs;
  const percentAll = Math.max(0, Math.min(100, ratioAll * 100));
  const percentSingle = Math.max(0, Math.min(100, ratioSingle * 100));
  lastCpuSampleUsage = usage;
  lastCpuSampleAtMs = nowMs;
  return {
    all: Number(percentAll.toFixed(1)),
    single: Number(percentSingle.toFixed(1))
  };
}

/*
 * Event-loop lag histogram — критически важная метрика для нашей синхронной архитектуры.
 * better-sqlite3 + Express всё блокируют один поток; если loop встал на сотни мс,
 * сервер «висит» для других запросов. Хистограмма раз сэмплируется на каждый
 * snapshot, потом ресетится — окно совпадает с тиком поллера (~5 сек).
 */
const loopLagHist = monitorEventLoopDelay({ resolution: 20 });
loopLagHist.enable();

/* Отдельный детектор длинных остановок: пишет в runtime.log каждую блокировку loop дольше
   порога (по умолчанию 2 с), чтобы жалобы «сервер завис» можно было сопоставить по времени
   с операцией, а не гадать. Не зависит от histogram выше (тот сбрасывается на snapshot). */
const LOOP_STALL_LOG_MS = Number(process.env.LOOP_STALL_LOG_MS) || 2000;
{
  const STALL_TICK_MS = 500;
  /* Дольше 5 минут синхронный код не блокирует loop — это сон/гибернация машины или перевод
     часов (Date.now прыгает). Логируем отдельно, чтобы не читалось как «сервер завис на 12 часов». */
  const CLOCK_JUMP_MS = 5 * 60 * 1000;
  let lastTick = Date.now();
  const stallTimer = setInterval(() => {
    const now = Date.now();
    const stall = now - lastTick - STALL_TICK_MS;
    lastTick = now;
    if (stall >= CLOCK_JUMP_MS) {
      console.warn(`[perf] clock jumped ${(stall / 1000).toFixed(0)} s (system sleep/resume or time sync, not an event-loop stall)`);
    } else if (stall >= LOOP_STALL_LOG_MS) {
      console.warn(`[perf] event loop stalled ${(stall / 1000).toFixed(1)} s (blocked main thread: heavy sync SQLite/IO); index=${getIndexStatus().active ? 'active' : 'idle'}`);
    }
  }, STALL_TICK_MS);
  stallTimer.unref();
}

function sampleEventLoopLag() {
  /* monitorEventLoopDelay возвращает наносекунды. Делим на 1e6 → миллисекунды. */
  const p50 = loopLagHist.percentile(50) / 1e6;
  const p99 = loopLagHist.percentile(99) / 1e6;
  const max = loopLagHist.max / 1e6;
  loopLagHist.reset();
  return {
    p50: Number.isFinite(p50) ? Number(p50.toFixed(1)) : 0,
    p99: Number.isFinite(p99) ? Number(p99.toFixed(1)) : 0,
    max: Number.isFinite(max) ? Number(max.toFixed(1)) : 0
  };
}

function getDiskUsageForPath(targetPath) {
  try {
    if (typeof fs.statfsSync !== 'function') {
      return null;
    }
    const stat = fs.statfsSync(path.dirname(targetPath));
    const bsize = Number(stat?.bsize || 0);
    const blocks = Number(stat?.blocks || 0);
    const bfree = Number(stat?.bfree || 0);
    if (!bsize || !blocks) {
      return null;
    }
    const totalBytes = blocks * bsize;
    const freeBytes = bfree * bsize;
    return {
      totalMB: Math.round(totalBytes / 1024 / 1024),
      freeMB: Math.round(freeBytes / 1024 / 1024)
    };
  } catch {
    return null;
  }
}

export function gracefulExit(code = 0) {
  // Allow time for streaming responses, database checkpoints, and background jobs to complete
  const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 8000;
  // Cancel pending maintenance timers to avoid DB ops after close
  if (postIndexMaintenanceTimer) {
    clearTimeout(postIndexMaintenanceTimer);
    postIndexMaintenanceTimer = null;
  }
  stopTelegramBot();
  const server = app.get('httpServer');
  const closeDb = () => {
    try { tryIdleWalTruncate(); } catch { /* ignore */ }
    try { db.close(); } catch {}
  };
  if (server) {
    server.close(() => { closeDb(); process.exit(code); });
    setTimeout(() => { closeDb(); process.exit(code); }, SHUTDOWN_TIMEOUT_MS);
  } else {
    closeDb();
    process.exit(code);
  }
}

// --- Graceful shutdown on SIGTERM/SIGINT ---
let shuttingDown = false;
let postIndexMaintenanceTimer = null;
let postIndexMaintenanceRunning = false;

/** Check if post-index maintenance (ANALYZE etc.) is currently running. */
export function isPostIndexMaintenanceRunning() {
  return postIndexMaintenanceRunning;
}

/** Wait until post-index maintenance finishes (max ~60s). */
export async function waitForPostIndexMaintenance(maxMs = 60_000) {
  if (!postIndexMaintenanceRunning) return;
  const start = Date.now();
  while (postIndexMaintenanceRunning && Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 500));
  }
}
function handleShutdownSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] Received ${signal}, shutting down gracefully…`);
  logSystemEvent('info', 'server', `server stopped (${signal})`);
  gracefulExit(0);
}
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

function getCachedStats() {
  return getCachedPageData('shared:stats', () => getStats(), STATS_CACHE_TTL_MS);
}

function warmSharedPageCaches() {
  if (getIndexStatus().active) {
    return;
  }
  // Heavy COUNT(*) / home pool queries — never run inside the listen callback.
  // Stagger so the first HTTP requests are not stuck behind a multi-second freeze.
  const warm = (fn, label) => {
    try {
      fn();
    } catch (error) {
      console.error(`Failed to warm ${label} cache`, error);
    }
  };
  const statsTimer = setTimeout(() => warm(() => getCachedStats(), 'stats'), 1_500);
  const sectionsTimer = setTimeout(
    () => warm(
      () => getCachedPageData('home:sections', () => getLibrarySections(), HOME_SECTIONS_CACHE_TTL_MS),
      'sections'
    ),
    2_500
  );
  if (typeof statsTimer.unref === 'function') statsTimer.unref();
  if (typeof sectionsTimer.unref === 'function') sectionsTimer.unref();
}

/** Периодический прогрев shared-кэшей — stats и sections всегда актуальны для первого запроса. */
function schedulePeriodicCacheWarm() {
  const delayMs = 5 * 60 * 1000; // 5 минут — гарантирует прогрев до истечения stats (10 мин)
  const t = setTimeout(() => {
    warmSharedPageCaches();
    schedulePeriodicCacheWarm();
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
}

// Session, CSRF, auth middleware — imported from src/middleware/auth.js and src/services/session.js

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function clearBookDetailsCache() {
  const deleted = db.prepare('DELETE FROM book_details_cache').run().changes;
  detailsCache.clear();
  clearPageDataCache();
  return deleted;
}

function getServiceValidation() {
  const inpxFile = getConfiguredInpxFile();
  const checks = {
    libraryRootExists: fs.existsSync(getLibraryRoot()),
    inpxFileExists: fs.existsSync(inpxFile),
    dbExists: fs.existsSync(config.dbPath),
    adminUserExists: hasAdminUser(),
    sessionSecretConfigured: Boolean(String(config.sessionSecret || '').trim()),
    sessionMaxAgeValid: Number(config.sessionMaxAgeMs) > 0,
    loginRateLimitValid: Number(config.loginWindowMs) > 0 && Number(config.loginMaxAttempts) > 0
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks
  };
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.rootDir, 'package.json'), 'utf8')).version;
  } catch {
    return '?';
  }
}

/** Сводка настроек для экспорта: без паролей и секретов (только флаги «задано»). */
function buildPublicSettingsExport() {
  const smtp = getSmtpSettings();
  const recaptchaSecretStored = String(decryptValue(getSetting('recaptcha_secret_key')) || '').trim();
  const indexStatus = getIndexStatus();
  return {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: readPackageVersion(),
    note: t('settings.exportNote'),
    paths: {
      dataDir: config.dataDir,
      dbFile: path.basename(config.dbPath),
      libraryRootEnv: config.libraryRoot || '',
      inpxFile: getConfiguredInpxFile() || ''
    },
    index: {
      indexedAt: indexStatus.indexedAt || null,
      indexActive: Boolean(indexStatus.active)
    },
    settings: {
      siteName: getSetting('site_name') || '',
      allowRegistration: getSetting('allow_registration') === '1',
      allowAnonymousBrowse: getSetting('allow_anonymous_browse') === '1',
      allowAnonymousDownload: getSetting('allow_anonymous_download') === '1',
      allowAnonymousOpds: getSetting('allow_anonymous_opds') === '1',
      disabledDownloadFormats: getSetting('disabled_download_formats') || '',
      downloadFilenameStyle: getSetting('download_filename_style') || '',
      fb2WebpImages: getSetting('fb2_webp_images') || '',
      recaptchaSiteKey: getSetting('recaptcha_site_key') || '',
      recaptchaSecretConfigured: Boolean(recaptchaSecretStored)
    },
    smtp: {
      host: smtp.host || '',
      port: smtp.port,
      secure: Boolean(smtp.secure),
      user: smtp.user || '',
      from: smtp.from || '',
      passwordConfigured: Boolean(smtp.pass)
    },
    runtimeHints: {
      trustProxy: Boolean(config.trustProxy),
      sessionSecureCookie: Boolean(config.sessionSecureCookie)
    }
  };
}

let _stmtCacheStats;
let _stmtBookmarkCount;
let _stmtHistoryCount;
let _stmtTotalUsers;

let _opsCountsCache = { at: 0, value: null };
const OPS_COUNTS_TTL_MS = 30_000;

function getOperationsSnapshot() {
  const dbStats = fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath) : null;
  const inpxFile = getConfiguredInpxFile();
  if (!_stmtCacheStats) {
    /* Не SUM(LENGTH(cover_data)): чтение всех BLOB на 2с poll админки замораживает /health. */
    _stmtCacheStats = db.prepare(`SELECT COUNT(*) AS count FROM book_details_cache`);
    _stmtBookmarkCount = db.prepare('SELECT COUNT(*) AS count FROM bookmarks');
    _stmtHistoryCount = db.prepare('SELECT COUNT(*) AS count FROM reading_history');
    _stmtTotalUsers = db.prepare('SELECT COUNT(*) AS count FROM users');
  }
  const now = Date.now();
  if (!_opsCountsCache.value || now - _opsCountsCache.at >= OPS_COUNTS_TTL_MS) {
    _opsCountsCache = {
      at: now,
      value: {
        cacheCount: _stmtCacheStats.get()?.count || 0,
        bookmarkCount: _stmtBookmarkCount.get().count,
        historyCount: _stmtHistoryCount.get().count,
        totalUsers: _stmtTotalUsers.get().count,
        suppressedCount: 0,
        deletedCount: 0
      }
    };
    try { _opsCountsCache.value.suppressedCount = countSuppressedBooks(); } catch { /* ignore */ }
    try { _opsCountsCache.value.deletedCount = countIndexedDeletedBooks(); } catch { /* ignore */ }
  }
  const bookCacheStats = { count: _opsCountsCache.value.cacheCount, approx_bytes: 0 };
  const bookmarkCount = _opsCountsCache.value.bookmarkCount;
  const historyCount = _opsCountsCache.value.historyCount;
  const validation = getServiceValidation();
  const mem = process.memoryUsage();
  const disk = getDiskUsageForPath(config.dbPath);
  /*
   * Библиотечные счётчики для дашборда — через getCachedStats() (10-мин TTL).
   * Это не «несвежие данные»: все мутирующие маршруты (softDeleteBook,
   * autoCleanDuplicates, unsuppressBook, unsuppressAll, и т.п.) уже вызывают
   * clearPageDataCache() сразу после изменений → следующий polling-цикл (5 сек)
   * подхватит свежие значения. При этом избегаем 5 COUNT(*)-запросов на каждый
   * тик опроса (раз в 5 секунд × N открытых дашбордов = заметная нагрузка
   * на больших библиотеках).
   */
  let liveStats = null;
  try {
    liveStats = getCachedStats();
  } catch (err) {
    console.warn('[ops snapshot] getCachedStats failed:', err.message);
  }
  const suppressedCount = _opsCountsCache.value.suppressedCount;
  const deletedCount = _opsCountsCache.value.deletedCount;
  let dbBreakdown = null;
  try { dbBreakdown = getDbBreakdown({ compute: false }); } catch (err) {
    console.warn('[ops snapshot] getDbBreakdown failed:', err.message);
  }
  const coverSegBytes = Number((dbBreakdown?.segments || []).find((s) => s.key === 'covers')?.bytes) || 0;
  const idx = getIndexStatus();
  return {
    ...operationsState,
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    uptimeSeconds: Math.round(process.uptime()),
    serviceValidation: validation,
    dbPath: config.dbPath,
    inpxFile,
    dbSizeBytes: dbStats?.size || 0,
    dbUpdatedAt: dbStats?.mtime?.toISOString?.() || '',
    cacheCount: bookCacheStats.count,
    cacheApproxBytes: coverSegBytes || bookCacheStats.approx_bytes,
    bookmarkCount,
    historyCount,
    loginRateLimitWindowMs: config.loginWindowMs,
    loginRateLimitMaxAttempts: config.loginMaxAttempts,
    sessionMaxAgeMs: config.sessionMaxAgeMs,
    serverStartedAt: serverStartedAt.toISOString(),
    totalUsers: _opsCountsCache.value.totalUsers,
    onlineUsers: getOnlineUserCount(),
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    systemMemoryMB: getSystemMemoryLimitMB(),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    diskTotalMB: disk?.totalMB ?? null,
    diskFreeMB: disk?.freeMB ?? null,
    /* CPU: оба значения. cpuPercent оставлен для обратной совместимости
       (= cpuAll, % от общей мощности); cpuSingle — % от одного ядра. */
    ...((() => { const cpu = sampleProcessCpuPercent(); return {
      cpuPercent: cpu.all,
      cpuAll: cpu.all,
      cpuSingle: cpu.single
    }; })()),
    /* Event-loop lag (median / p99 / max в мс за последние ~5 сек): главный сигнал
       что сервер «висит». Высокий p99 при низком CPU = синхронная блокировка SQLite. */
    ...((() => { const lag = sampleEventLoopLag(); return {
      loopLagP50Ms: lag.p50,
      loopLagP99Ms: lag.p99,
      loopLagMaxMs: lag.max
    }; })()),
    appVersion: readPackageVersion(),
    sources: getSources(),
    /* Живые счётчики для верхней панели дашборда. */
    totalBooks: Number(liveStats?.totalBooks) || 0,
    totalAuthors: Number(liveStats?.totalAuthors) || 0,
    totalSeries: Number(liveStats?.totalSeries) || 0,
    suppressedCount,
    deletedCount,
    showDeletedBooks: getSetting('show_deleted_books') === '1',
    /* Разбивка содержимого БД по категориям (стэковый бар на дашборде). */
    dbBreakdown,
    /* Сводка по последней (или текущей) индексации — переживает завершение
       indexing-сессии и доступна на дашборде до следующего запуска. */
    lastIndexImported: Math.max(0, Math.floor(Number(idx?.importedBooks) || 0)),
    lastIndexUnique: Math.max(0, Math.floor(Number(idx?.uniqueBooks) || 0)),
    lastIndexArchives: Number(idx?.totalArchives) || 0,
    ftsStatus: idx?.ftsStatus || (() => {
      try { return getBooksFtsStatus({ recover: false }); } catch { return null; }
    })()
  };
}

function runRepairMetadata() {
  if (operationsState.repairRunning) {
    return false;
  }

  operationsState.repairRunning = true;
  operationsState.lastRepairError = '';
  logSystemEvent('info', 'operations', 'repair metadata started');
  const child = spawn(process.execPath, ['scripts/repair-metadata.js'], {
    cwd: config.rootDir,
    stdio: 'ignore'
  });
  child.on('exit', (code) => {
    operationsState.repairRunning = false;
    if (code === 0) {
      operationsState.lastRepairAt = new Date().toISOString();
      logSystemEvent('info', 'operations', 'repair metadata completed', { finishedAt: operationsState.lastRepairAt });
      return;
    }
    operationsState.lastRepairError = `repair exited with code ${code}`;
    logSystemEvent('error', 'operations', 'repair metadata failed', { code });
  });
  child.on('error', (error) => {
    operationsState.repairRunning = false;
    operationsState.lastRepairError = error.message;
    logSystemEvent('error', 'operations', 'repair metadata process error', { message: error.message });
  });
  return true;
}

app.use(express.urlencoded({ extended: false, limit: '100kb' }));
const json100kb = express.json({ limit: '100kb' });
const jsonUsersImport = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/operations/users-import') {
    return jsonUsersImport(req, res, next);
  }
  return json100kb(req, res, next);
});
registerTelegramBotRoutes(app);
app.use(cookieParser());
// gzip/deflate — обрабатывается пакетом compression (fallback для клиентов без Brotli).
app.use(compression({
  threshold: 1024,
  filter: (req, res) => !res._brotliApplied && compression.filter(req, res)
}));

// Brotli (br) — ~15-20 % эффективнее gzip для текстовых ответов.
// Используем встроенный zlib (Node 18+). Middleware стоит ПОСЛЕ compression:
// наш патч res.end вызывается первым; если br применён, compression видит
// Content-Encoding: br и пропускает повторное сжатие.
function brotliCompressible(ct) {
  if (!ct) return false;
  if (ct.includes('event-stream')) return false;
  return /text|json|xml|javascript|css|svg|html|atom/i.test(ct);
}
app.use(function brotli(req, res, next) {
  const accept = req.headers['accept-encoding'] || '';
  if (!accept.includes('br')) return next();

  const _end = res.end;
  res.end = function brotliEnd(chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = undefined; }
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }

    const ce = res.getHeader('content-encoding');
    const ct = String(res.getHeader('content-type') || '');
    if (ce || res.headersSent || !brotliCompressible(ct)) {
      return _end.call(res, chunk, encoding, cb);
    }

    let body = chunk;
    if (body != null && !Buffer.isBuffer(body)) {
      body = Buffer.from(String(body), encoding || 'utf8');
    }
    if (!body || body.length < 1024) {
      return _end.call(res, chunk, encoding, cb);
    }

    brotliCompress(body, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 }
    }, (err, compressed) => {
      if (err || !compressed || compressed.length >= body.length) {
        return _end.call(res, body, cb);
      }
      res._brotliApplied = true;
      res.setHeader('Content-Encoding', 'br');
      res.setHeader('Vary', 'Accept-Encoding');
      res.removeHeader('Content-Length');
      res.setHeader('Content-Length', compressed.length);
      _end.call(res, compressed, cb);
    });
  };
  next();
});
app.use((req, res, next) => runWithLocale(req, () => next()));
app.get('/set-lang', (req, res) => {
  const lang = req.query.lang === 'en' ? 'en' : 'ru';
  res.cookie('lang', lang, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: false,
    path: '/'
  });
  const ref = req.get('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      const host = req.get('host') || '';
      if (u.host === host || u.hostname === host.split(':')[0]) {
        return res.redirect(ref);
      }
    } catch { /* ignore */ }
  }
  res.redirect('/');
});
app.use(attachSessionUser);
app.use(bookRefUrlRewrite);
app.use(csrfGuard);

/**
 * HTML страницы каталога не кэшируем в дисковом/forward-кэше и не держим в bfcache (Chromium и др.):
 * иначе после «назад» и повторного входа скрипт не переинициализируется, возможны «зависшие» UI и старый DOM.
 */
function browseHtmlNoStore(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path || '';
  if (
    p === '/' ||
    p === '/catalog' ||
    p === '/authors' ||
    p === '/series' ||
    p === '/genres' ||
    p === '/languages' ||
    p === '/favorites' ||
    p === '/profile' ||
    p.startsWith('/facet/') ||
    p.startsWith('/book/') ||
    p.startsWith('/library/') ||
    p === '/shelves' ||
    p.startsWith('/shelves/') ||
    p.startsWith('/lite/')
  ) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}
app.use(browseHtmlNoStore);

// Cache-Control для API: не кэшировать на клиенте (данные персонализированы / динамичны).
app.use('/api/', (req, res, next) => {
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'private, no-cache');
  }
  next();
});
// OPDS-клиенты выигрывают от кратковременного кэша (5 мин).
app.use('/opds', (req, res, next) => {
  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'private, max-age=300');
  }
  next();
});

app.use(browseLimiter);

// Публичные диагностические маршруты — до express.static, чтобы не пересекаться с файлами из public/.
registerHealthRoutes(app, { getCachedStats, getServiceValidation, getPerfSnapshot });
registerBrowseApiRoutes(app);
registerProfileApiRoutes(app);

app.get('/custom/ui/:asset', (req, res) => {
  if (!serveUiAsset(String(req.params.asset || ''), res)) {
    res.status(404).end();
  }
});

app.get('/api/settings/ui', (req, res) => {
  res.json(getPublicUiSettingsJson());
});

app.use(express.static(config.publicDir, {
  maxAge: '365d',
  immutable: true,
  etag: false,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return;
    }
    // JS/CSS-модули (reader.js, position-sync.js, foliate/*.js …) импортируются по
    // относительным путям БЕЗ кэш-бастера `?v=`. С `immutable, max-age=365d` браузер
    // держал бы устаревшие копии год — после обновления foliate/position-sync читалка
    // ломалась бы (старый progress.js без EqualSectionProgress, старые подписи глав).
    // Отдаём их с `no-cache` → браузер ревалидирует (обычно дешёвый 304 по Last-Modified).
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

registerAuthRoutes(app, { getCachedStats });
registerOidcRoutes(app);

// ── Maintenance gate: block user-facing pages when a heavy DB operation is running ──
function isMaintenanceActive() {
  return operationsState.reindexRunning ||
    operationsState.repairRunning ||
    operationsState.sourceDeleteRunning ||
    operationsState.sidecarRunning ||
    operationsState.dupCleanRunning;
}
app.use((req, res, next) => {
  if (!isMaintenanceActive()) return next();
  // Let through: admin pages, API endpoints, static assets, auth, downloads, health, set-lang
  const p = req.path;
  if (
    p.startsWith('/admin') ||
    p.startsWith('/api/') ||
    p.startsWith('/login') ||
    p.startsWith('/register') ||
    p.startsWith('/logout') ||
    p.startsWith('/forgot-password') ||
    p.startsWith('/reset-password') ||
    p.startsWith('/download/') ||
    p.startsWith('/health') ||
    p === '/set-lang' ||
    p.startsWith('/lite') ||
    p === '/manifest.webmanifest' ||
    p === '/sw.js' ||
    p.startsWith('/custom/ui/')
  ) return next();
  // Only intercept GET/HEAD HTML requests
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const accept = req.get('accept') || '';
  if (!accept.includes('text/html')) return next();
  res.status(503).send(renderMaintenance({
    user: req.user,
    stats: getCachedStats(),
    csrfToken: req.csrfToken || ''
  }));
});

app.get('/admin/live-logs', requireAdminWeb, (req, res) => {
  const title = 'Live Logs';
  const csrf = req.csrfToken || '';
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${csrf ? `<meta name="csrf-token" content="${csrf}">` : ''}
  <title>${title}</title>
  <style>
    :root { --bg:#0f1218; --fg:#e6edf3; --muted:#9fb0c0; --border:#263140; --err:#ff6b6b; --warn:#ffcc66; --ok:#85d896; --panel:#141b24; --accent:#6cb3ff; }
    * { box-sizing:border-box; }
    body { margin:0; font:13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:var(--bg); color:var(--fg); }
    .bar { position:sticky; top:0; z-index:10; display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--border); background:var(--panel); }
    .bar a,.bar button { color:var(--fg); background:#1d2733; border:1px solid var(--border); border-radius:6px; padding:6px 10px; text-decoration:none; cursor:pointer; font:inherit; }
    .bar button:hover,.bar a:hover { background:#233142; }
    .bar label { color:var(--muted); font-size:12px; display:flex; align-items:center; gap:4px; }
    .bar select,.bar input[type="search"] { background:#0d1117; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:5px 8px; min-width:8rem; font:inherit; }
    .bar input[type="search"] { min-width:10rem; }
    .meta { margin-left:auto; color:var(--muted); font-size:12px; max-width:28rem; text-align:right; }
    #logs { padding:10px 12px 24px; }
    .line { padding:8px 0 10px; border-bottom:1px solid rgba(159,176,192,.12); }
    .line-head { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:baseline; margin-bottom:4px; }
    .line .t { color:var(--muted); font-size:12px; }
    .line .iso { color:#6e7a87; font-size:11px; margin-left:4px; }
    .badge { font-size:11px; padding:2px 7px; border-radius:4px; background:#1d2733; border:1px solid var(--border); color:var(--muted); }
    .badge.lvl-error { border-color:#8b3a3a; color:var(--err); }
    .badge.lvl-warn { border-color:#6b5a2a; color:var(--warn); }
    .badge.lvl-debug { border-color:#2d5a3a; color:var(--ok); }
    .badge.cat { border-color:#2a4a6b; color:var(--accent); }
    .msg { white-space:pre-wrap; word-break:break-word; margin:2px 0 0; }
    .line.error .msg { color:var(--err); }
    .line.warn .msg { color:var(--warn); }
    .line.debug .msg { color:var(--ok); }
    details.ctx { margin-top:6px; font-size:12px; color:var(--muted); }
    details.ctx summary { cursor:pointer; color:var(--accent); user-select:none; }
    details.ctx pre { margin:6px 0 0; padding:8px 10px; background:#0d1117; border:1px solid var(--border); border-radius:6px; overflow:auto; max-height:22rem; color:var(--fg); font-size:11px; line-height:1.4; }
  </style>
</head>
<body>
  <div class="bar">
    <a href="/admin">← Dashboard</a>
    <a href="/api/admin/runtime-logs/download" target="_blank" rel="noopener noreferrer">Download log</a>
    <label>Level <select id="levelF" aria-label="Filter by level"><option value="">all</option><option value="error">error</option><option value="warn">warn</option><option value="info">info</option><option value="debug">debug</option></select></label>
    <label>Source <input type="search" id="srcF" placeholder="substring" autocomplete="off"></label>
    <label>Message <input type="search" id="msgF" placeholder="substring" autocomplete="off"></label>
    <button id="pauseBtn" type="button">Pause autoscroll</button>
    <button id="clearBtn" type="button">Clear view</button>
    <span class="meta" id="meta">connecting…</span>
  </div>
  <div id="logs"></div>
  <script>
    const logsEl = document.getElementById('logs');
    const metaEl = document.getElementById('meta');
    const pauseBtn = document.getElementById('pauseBtn');
    const clearBtn = document.getElementById('clearBtn');
    const levelF = document.getElementById('levelF');
    const srcF = document.getElementById('srcF');
    const msgF = document.getElementById('msgF');
    let autoscroll = true;
    const maxBuffer = 5000;
    const maxDomLines = 5000;
    let buffer = [];
    let streamState = 'connecting';
    function matches(entry) {
      const lv = levelF.value;
      const ns = (srcF.value || '').trim().toLowerCase();
      const ms = (msgF.value || '').trim().toLowerCase();
      if (lv && String(entry.level || '') !== lv) return false;
      if (ns && !String(entry.source || '').toLowerCase().includes(ns)) return false;
      if (ms && !String(entry.message || '').toLowerCase().includes(ms)) return false;
      return true;
    }
    function trimDom() {
      while (logsEl.childElementCount > maxDomLines) logsEl.removeChild(logsEl.firstChild);
    }
    function appendDomLine(entry) {
      const lvl = String(entry.level || 'info');
      const row = document.createElement('div');
      row.className = 'line ' + lvl;
      const head = document.createElement('div');
      head.className = 'line-head';
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = '[' + (entry.createdAt || '') + ']';
      if (entry.createdAtIso) {
        const iso = document.createElement('span');
        iso.className = 'iso';
        iso.textContent = entry.createdAtIso;
        t.appendChild(iso);
      }
      head.appendChild(t);
      const bLvl = document.createElement('span');
      bLvl.className = 'badge lvl-' + lvl;
      bLvl.textContent = lvl.toUpperCase();
      head.appendChild(bLvl);
      const bSrc = document.createElement('span');
      bSrc.className = 'badge';
      bSrc.textContent = String(entry.source || 'app');
      head.appendChild(bSrc);
      if (entry.pid != null) {
        const bPid = document.createElement('span');
        bPid.className = 'badge';
        bPid.textContent = 'pid ' + entry.pid;
        head.appendChild(bPid);
      }
      if (entry.hostname) {
        const bH = document.createElement('span');
        bH.className = 'badge';
        bH.textContent = entry.hostname;
        head.appendChild(bH);
      }
      if (entry.uptimeSec != null) {
        const bU = document.createElement('span');
        bU.className = 'badge';
        bU.textContent = 'uptime ' + entry.uptimeSec + 's';
        head.appendChild(bU);
      }
      if (entry.meta && entry.meta.category) {
        const bC = document.createElement('span');
        bC.className = 'badge cat';
        bC.textContent = String(entry.meta.category);
        head.appendChild(bC);
      }
      row.appendChild(head);
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = String(entry.message || '');
      row.appendChild(msg);
      if (entry.meta && Object.keys(entry.meta).length) {
        let json = '';
        try { json = JSON.stringify(entry.meta, null, 2); } catch (e) { json = String(e); }
        if (json && json !== '{}') {
          const det = document.createElement('details');
          det.className = 'ctx';
          const sum = document.createElement('summary');
          sum.textContent = 'Context / structured fields';
          det.appendChild(sum);
          const pre = document.createElement('pre');
          pre.textContent = json;
          det.appendChild(pre);
          row.appendChild(det);
        }
      }
      logsEl.appendChild(row);
      trimDom();
      if (autoscroll) window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
    }
    function renderMeta() {
      let matched = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (matches(buffer[i])) matched++;
      }
      const total = buffer.length;
      const hasF = !!(levelF.value || srcF.value.trim() || msgF.value.trim());
      const cnt = hasF ? matched + ' of ' + total + ' (filter)' : matched + ' lines';
      metaEl.textContent = streamState + ' · ' + cnt;
    }
    function renderAll() {
      logsEl.innerHTML = '';
      for (let i = 0; i < buffer.length; i++) {
        if (matches(buffer[i])) appendDomLine(buffer[i]);
      }
      renderMeta();
    }
    function pushEntry(entry) {
      buffer.push(entry);
      while (buffer.length > maxBuffer) buffer.shift();
      if (matches(entry)) appendDomLine(entry);
      renderMeta();
    }
    function hydrate(list) {
      buffer = (list || []).slice(-maxBuffer);
      renderAll();
    }
    pauseBtn.addEventListener('click', () => {
      autoscroll = !autoscroll;
      pauseBtn.textContent = autoscroll ? 'Pause autoscroll' : 'Resume autoscroll';
    });
    clearBtn.addEventListener('click', () => { buffer = []; logsEl.innerHTML = ''; renderMeta(); });
    [levelF, srcF, msgF].forEach((el) => el.addEventListener('input', renderAll));
    [levelF, srcF, msgF].forEach((el) => el.addEventListener('change', renderAll));
    fetch('/api/admin/runtime-logs?limit=800', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(data => { streamState = 'snapshot'; hydrate(data.logs); })
      .catch(err => { metaEl.textContent = 'snapshot failed: ' + err.message; });
    const es = new EventSource('/api/admin/runtime-logs/stream?limit=800');
    es.onopen = () => { streamState = 'live'; renderMeta(); };
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data || '{}');
        if (payload.type === 'snapshot') hydrate(payload.logs || []);
        else if (payload.type === 'log' && payload.entry) pushEntry(payload.entry);
      } catch (err) {}
    };
    es.onerror = () => { streamState = 'reconnecting'; renderMeta(); };
  </script>
</body>
</html>`;
  res.type('text/html; charset=utf-8').send(html);
});

registerLibraryRoutes(app, {
  getCachedStats,
  templates: {
    renderHome, renderCatalog, renderSearchOverview, renderLibraryView, renderBrowsePage,
    renderFacetBooks, renderAuthorFacetPage, renderAuthorOutsideSeriesPage,
    renderBook, renderFavorites, renderShelves, renderShelfDetail, renderReader
  }
});

registerLiteRoutes(app, { getCachedStats });

const batchEmailLocks = new Set();
registerReaderRoutes(app);
registerUserApiRoutes(app, { batchEmailLocks });
registerAdminRoutes(app, {
  operationsState,
  getOperationsSnapshot,
  getServiceValidation,
  getCachedStats,
  clearBookDetailsCache,
  getDetailsFull,
  buildPublicSettingsExport,
  runRepairMetadata,
  bookFlibustaSidecarEffective,
  gracefulExit,
  setAllowAnonymousDownload,
  setSiteName,
  restartTelegramBot,
  isTelegramBotRunning,
  testAnnounceNewBooksInTelegram,
  syncTelegramBotProfilePhoto,
  templates: {
    renderOperations, renderAdminUsers, renderAdminUpdate, renderAdminSmtp,
    renderAdminTelegram, renderAdminEvents, renderAdminSources, renderAdminDuplicates, renderAdminContent,
    renderAdminAppearance
  }
});

registerDownloadRoutes(app);

registerOpdsRoutes(app, { baseUrl });
registerOpdsV2Routes(app, { baseUrl });

app.use((error, req, res, next) => {
  console.error(error);
  logSystemEvent('error', 'server', 'unhandled request error', { message: error.message, path: req.path });
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ ok: false, code: ApiErrorCode.INTERNAL, error: t('errors.internal') });
  }
  res.status(500).send(t('errors.internal'));
});

/** После окончания индекса: задержка → checkpoint → ANALYZE по таблицам с уступкой циклу → кэш и backfill. */
function isBackfillEnabled() {
  const raw = String(process.env.ENABLE_SEARCH_BACKFILL || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function schedulePostIndexMaintenance() {
  const delayMs = config.postIndexMaintenanceDelayMs;
  postIndexMaintenanceTimer = setTimeout(() => {
    postIndexMaintenanceTimer = null;
    postIndexMaintenanceRunning = true;
    logSystemEvent('info', 'index', 'post-index maintenance started', {
      delayMs,
      walCheckpoint: 'PASSIVE'
    });
    try {
      db.pragma('wal_checkpoint(PASSIVE)');
    } catch (err) {
      console.error('[index] post-index wal_checkpoint:', err.message);
      logSystemEvent('warn', 'index', 'post-index WAL checkpoint failed', { error: err.message });
    }
    appendIndexDiaryLine('ANALYZE после индексации (по таблицам с уступкой циклу)…');
    console.log('[analyze] post-index ANALYZE (yielding)…');
    const a0 = Date.now();
    analyzeDatabaseYielding()
      .then(() => {
        postIndexMaintenanceRunning = false;
        const sec = ((Date.now() - a0) / 1000).toFixed(1);
        console.log(`[analyze] post-index готово за ${sec} с`);
        appendIndexDiaryLine(`ANALYZE готово за ${Date.now() - a0} ms`);
        logSystemEvent('info', 'index', 'post-index ANALYZE completed', { seconds: Number(sec) });
        clearPageDataCache();
        warmSharedPageCaches();
        import('./inpx.js').then((m) => {
          try { m.clearWarmSearchBooksPages?.(); } catch { /* ignore */ }
          try {
            const warm = m.warmupSearchFts?.();
            if (warm?.ok) {
              console.log(`[search] FTS warmup after index (${warm.probes} probes)`);
            }
          } catch (err) {
            console.warn('[search] FTS warmup failed:', err.message);
          }
        }).catch(() => {});
        if (isBackfillEnabled()) {
          try {
            backfillCatalogSearchFields();
            logSystemEvent('info', 'index', 'catalog search backfill ran after index');
          } catch (err) {
            console.error('[backfill] post-index error:', err.message);
            logSystemEvent('warn', 'index', 'catalog search backfill failed', { error: err.message });
          }
        }
      })
      .catch((err) => {
        postIndexMaintenanceRunning = false;
        console.error('[analyze] post-index error:', err.message);
        logSystemEvent('error', 'index', 'post-index ANALYZE failed', { error: err.message });
      });
  }, delayMs);
}

function scheduleDeferredOptimize() {
  const delayMs = 45_000;
  const t = setTimeout(() => {
    try {
      if (getIndexStatus().active) {
        scheduleDeferredOptimize();
        return;
      }
      db.pragma('optimize');
    } catch (err) {
      console.warn('[db] deferred optimize:', err.message);
    }
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
}

/** Периодический PASSIVE checkpoint; при раздутом WAL — короткий TRUNCATE без ожидания читателей. */
function schedulePeriodicWalCheckpoint() {
  const delayMs = 2 * 60 * 1000; // 2 минуты — чаще при простое, PASSIVE не блокирует
  const t = setTimeout(() => {
    try {
      if (!getIndexStatus().active) {
        db.pragma('wal_checkpoint(PASSIVE)');
        tryIdleWalTruncate();
      }
    } catch (err) {
      console.warn('[db] WAL checkpoint не удался:', err.message);
    }
    schedulePeriodicWalCheckpoint();
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
}

/* ── Express: глобальный обработчик ошибок (должен быть ПОСЛЕ всех маршрутов) ── */
app.use((err, req, res, next) => {
  console.error('[express-error]', err.stack || err);
  logSystemEvent('error', 'server', 'unhandled request error', {
    url: req.originalUrl, method: req.method, error: err.message
  });
  if (res.headersSent) return next(err);
  res.status(500).send('Internal Server Error');
});

async function bootstrap() {
  initDb();
  onIndexComplete(({ newBooksCount }) => {
    if (newBooksCount <= 0) return;
    if (!shouldRunTelegramBotInThisProcess()) return;
    announceNewBooksInTelegram(newBooksCount).catch((err) => {
      logSystemEvent('warn', 'telegram-bot', 'ошибка анонса новинок', { error: err.message, count: newBooksCount });
    });
    try { setMeta('index_last_new_books_count', ''); } catch { /* ignore */ }
  });
  // Индексы создаём в фоне — на большой БД это секунды-минуты блокировки event loop.
  setImmediate(() => ensureSchemaIndexes());
  // Run DB optimize manually/offline; in-process optimize can block HTTP loop on large datasets.
  setSiteName(getSetting('site_name'));
  setAllowAnonymousDownload(getSetting('allow_anonymous_download') === '1');
  setDisabledDownloadFormats(getSetting('disabled_download_formats') || '');
  setDownloadFilenameStyle(getSetting('download_filename_style'));
  setFb2WebpMode(getSetting('fb2_webp_images'));
  setDefaultLocale(getSetting('default_locale'));

  /* Проверка путей источников при старте — предупреждение, если не найдены */
  const libRoot = getLibraryRoot();
  if (libRoot && !fs.existsSync(libRoot)) {
    console.warn(`[WARN] Library root not found: ${libRoot}. Update the path in admin panel → Sources or set LIBRARY_ROOT / INPX_FILE.`);
    logSystemEvent('warn', 'server', 'library root not found at startup', { libraryRoot: libRoot });
  }
  try {
    const sources = getSources();
    for (const s of sources) {
      if (s.path && !fs.existsSync(s.path)) {
        console.warn(`[WARN] Source path not found: ${s.name} → ${s.path}`);
        logSystemEvent('warn', 'server', 'source path not found at startup', { sourceId: s.id, sourceName: s.name, path: s.path });
      }
    }
  } catch {
    /* ignore */
  }

  const httpServer = app.listen(config.port, () => {
    console.log(`INPX Library Server listening on http://localhost:${config.port}`);
    console.log(`Library root: ${getLibraryRoot()}`);
    logSystemEvent('info', 'server', 'server started', { port: config.port, libraryRoot: getLibraryRoot() });
    warmSharedPageCaches();
    // WAL в несколько ГБ нельзя ужимать до listen: health и логин молчат десятки минут.
    setImmediate(() => {
      try { compactWalExclusive(); } catch (err) {
        console.warn('[db] WAL TRUNCATE after listen failed:', err?.message || err);
      }
    });
  });
  httpServer.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`[FATAL] Порт ${config.port} уже занят. Остановите другой экземпляр: npm run server:stop`);
    } else {
      console.error('[FATAL] Не удалось запустить HTTP-сервер:', err?.message || err);
    }
    process.exit(1);
  });
  app.set('httpServer', httpServer);

  // --- Таймауты для защиты от утечки соединений при нагрузке ---
  const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 30_000;
  httpServer.keepAliveTimeout = 10 * 60_000; // 10 минут — предотвращает TCP-разрыв при простое
  httpServer.headersTimeout   = 11 * 60_000; // чуть больше keepAlive (обязательно)
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  if (typeof httpServer.maxRequestsPerSocket !== 'undefined') {
    httpServer.maxRequestsPerSocket = 200;
  }

  // --- Route-level extended timeouts for streaming/download routes ---
  function extendedTimeout(ms) {
    return (req, res, next) => {
      req.setTimeout(ms);
      res.setTimeout(ms);
      next();
    };
  }
  app.use('/api/book/download', extendedTimeout(300_000));  // 5 min for downloads
  app.use('/download', extendedTimeout(300_000));
  app.use('/api/batch', extendedTimeout(300_000));
  app.use('/opds', extendedTimeout(120_000));  // 2 min for OPDS

  setTimeout(async () => {
    try {
      // Full catalog recount is multi-second on huge libraries — only when filters changed.
      const fingerprint = `v2\n${getSetting('excluded_languages') || ''}\n${getSetting('excluded_genres') || ''}\n${getSetting('show_deleted_books') === '1' ? '1' : '0'}`;
      if (getMeta('active_books_filter_fp') === fingerprint) {
        return;
      }
      await rebuildActiveBooksView();
    } catch (err) {
      console.error('[startup] rebuildActiveBooksView failed:', err.message);
      // Даже если view не пересоздана, пересчитаем counts на основе текущей view
      try {
        await refreshCatalogBookCounts();
      } catch (e) {
        console.error('[startup] refreshCatalogBookCounts fallback failed:', e.message);
      }
    }
  }, 5_000);

  setTimeout(async () => {
    if (getMeta('books_fts_dirty') === '1') {
      console.log('[startup] FTS index is dirty (previous indexing was interrupted). Rebuilding…');
      logSystemEvent('warn', 'server', 'FTS dirty on startup — rebuilding');
      try {
        ensureBooksFtsTriggers();
        await rebuildBooksFtsFromContent();
        setMeta('books_fts_dirty', '0');
        invalidateBooksFtsHealthCache();
        console.log('[startup] FTS rebuild complete.');
        logSystemEvent('info', 'server', 'FTS rebuilt after dirty startup');
      } catch (err) {
        console.error('[startup] FTS rebuild failed:', err.message);
        logSystemEvent('error', 'server', 'FTS rebuild failed on startup', { error: err.message });
      }
    }

    if (isBackfillEnabled()) {
      try {
        backfillCatalogSearchFields();
      } catch (error) {
        console.error('Background init error:', error.message);
      }
    }

    if (process.argv.includes('--reindex')) {
      startBackgroundIndexing(true, false);
    }

    {
      const tgDb = getTelegramSettings();
      if (tgDb.enabled && shouldRunTelegramBotInThisProcess()) {
        startTelegramBot().catch((err) => {
          console.warn('[telegram-bot] Ошибка запуска:', err.message);
          logSystemEvent('warn', 'telegram-bot', 'ошибка запуска', { error: err.message });
        });
      }
    }

    // Start scan scheduler (if SCAN_INTERVAL_HOURS > 0)
    startScanScheduler(({ full = false } = {}) => startBackgroundIndexing(full, !full));
  }, 100);

  setInterval(() => {
    const status = getIndexStatus();
    operationsState.reindexRunning = status.active;
    if (status.active && !lastKnownIndexActive) {
      logSystemEvent('info', 'index', 'background indexing started', {
        startedAt: status.startedAt,
        totalArchives: status.totalArchives
      });
    }
    if (status.active) {
      const now = Date.now();
      if (now - lastIndexProgressLog > 12000) {
        lastIndexProgressLog = now;
        console.log(
          `[index] progress: archives ${status.processedArchives}/${status.totalArchives}, imported_total=${status.importedBooks}, current: ${status.currentArchive || '—'}`
        );
      }
      if (now - lastKeyIndexProgressEvent > 120000) {
        lastKeyIndexProgressEvent = now;
        logSystemEvent('info', 'index', 'indexing progress', {
          archives: `${status.processedArchives}/${status.totalArchives}`,
          importedBooks: status.importedBooks,
          current: String(status.currentArchive || '').slice(0, 500),
          startedAt: status.startedAt || ''
        });
      }
    }
    if (!status.active && lastKnownIndexActive) {
      lastIndexProgressLog = 0;
      lastKeyIndexProgressEvent = 0;
      if (status.error) {
        logSystemEvent('error', 'index', 'background indexing failed', { error: status.error, finishedAt: status.finishedAt });
      } else {
        logSystemEvent('info', 'index', 'background indexing completed', { finishedAt: status.finishedAt, indexedAt: status.indexedAt });
        schedulePostIndexMaintenance();
      }
    }
    lastKnownIndexActive = status.active;
  }, 3000).unref();

  // Периодический PASSIVE checkpoint — сдерживает рост WAL без блокировки читателей
  schedulePeriodicWalCheckpoint();
  schedulePeriodicCacheWarm();

  setInterval(() => {
    pruneLoginAttempts();
    pruneOfflineUsers();
  }, 15 * 60 * 1000).unref();
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
