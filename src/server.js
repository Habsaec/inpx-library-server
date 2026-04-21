import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';

import { config } from './config.js';
import { runWithLocale, t } from './i18n.js';
import { ApiErrorCode, apiFail } from './api-errors.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerBrowseApiRoutes } from './routes/browse-api.js';
import { registerOpdsRoutes } from './routes/opds.js';
import { registerOpdsV2Routes } from './routes/opds-v2.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerDownloadRoutes } from './routes/download.js';
import { registerReaderRoutes } from './routes/reader.js';
import { registerUserApiRoutes } from './routes/user-api.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerLibraryRoutes, detailsCache, getDetailsFull, bookFlibustaSidecarEffective } from './routes/library.js';
// --- Extracted modules ---
import { securityHeaders } from './middleware/security-headers.js';
import { browseLimiter } from './middleware/rate-limiter-browse.js';
import {
  attachSessionUser, csrfGuard,
  requireAdminWeb
} from './middleware/auth.js';

import {
  isRateLimited, registerFailedLogin, clearLoginAttempts,
  getClientKey, pruneExpiredEntries as pruneLoginAttempts
} from './services/rate-limiter.js';
import { getOnlineUserCount, pruneOfflineUsers } from './services/online-tracker.js';
import { getCachedPageData, clearPageDataCache } from './services/cache.js';
import { logSystemEvent } from './services/system-events.js';

import { mirrorIndexingLogsToDataFile, appendIndexDiaryLine } from './services/file-log.js';
import { installRuntimeLogCapture } from './services/runtime-logs.js';
import { startScanScheduler } from './services/scheduler.js';
import {
  STATS_CACHE_TTL_MS, HOME_SECTIONS_CACHE_TTL_MS
} from './constants.js';
import { db, getUserByUsername, hasAdminUser, initDb, analyzeDatabaseYielding, getSmtpSettings, getUserStats, getSetting, setSetting, getSources, decryptValue, getMeta, setMeta, rebuildBooksFtsFromContent, ensureBooksFtsTriggers, rebuildActiveBooksView } from './db.js';
import {
  backfillCatalogSearchFields,
  getConfiguredInpxFile,
  getLibraryRoot,
  getIndexStatus,
  getLibrarySections,
  getStats,
  setConfiguredInpxFile,
  startBackgroundIndexing
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
  renderFacetBooks,
  renderAuthorFacetPage,
  renderAuthorOutsideSeriesPage,
  renderHome,
  renderLibraryView,
  renderOperations,
  renderShelves,
  renderShelfDetail,
  renderAdminSmtp,
  renderAdminUpdate,
  renderAdminSources,
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
const serverStartedAt = new Date();
let lastKnownIndexActive = false;
let lastIndexProgressLog = 0;
/** Редкие system-events о ходе индексации (для Live logs / «События»), без спама каждые 12 с. */
let lastKeyIndexProgressEvent = 0;
const operationsState = {
  reindexRunning: false,
  repairRunning: false,
  sidecarRunning: false,
  sourceDeleteRunning: false,
  lastReindexRequestedAt: null,
  lastSidecarRequestedAt: null,
  lastSourceDeleteRequestedAt: null,
  lastRestartRequestedAt: null,
  lastStopRequestedAt: null
};

let lastCpuSampleUsage = process.cpuUsage();
let lastCpuSampleAtMs = Date.now();

function sampleProcessCpuPercent() {
  const nowMs = Date.now();
  const usage = process.cpuUsage();
  const elapsedMs = Math.max(1, nowMs - lastCpuSampleAtMs);
  const deltaUser = usage.user - lastCpuSampleUsage.user;
  const deltaSystem = usage.system - lastCpuSampleUsage.system;
  const cpuCount = Math.max(1, Array.isArray(os.cpus()) ? os.cpus().length : 1);
  const ratio = ((deltaUser + deltaSystem) / 1000) / (elapsedMs * cpuCount);
  const percent = Math.max(0, Math.min(100, ratio * 100));
  lastCpuSampleUsage = usage;
  lastCpuSampleAtMs = nowMs;
  return Number(percent.toFixed(1));
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

function gracefulExit(code = 0) {
  // Cancel pending maintenance timers to avoid DB ops after close
  if (postIndexMaintenanceTimer) {
    clearTimeout(postIndexMaintenanceTimer);
    postIndexMaintenanceTimer = null;
  }
  const server = app.get('httpServer');
  const closeDb = () => { try { db.close(); } catch {} };
  if (server) {
    server.close(() => { closeDb(); process.exit(code); });
    setTimeout(() => { closeDb(); process.exit(code); }, 3000);
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
  try {
    getCachedStats();
  } catch (error) {
    console.error('Failed to warm stats cache', error);
  }
  setImmediate(() => {
    try {
      getCachedPageData('home:sections', () => getLibrarySections(), HOME_SECTIONS_CACHE_TTL_MS);
    } catch (error) {
      console.error('Failed to warm sections cache', error);
    }
  });
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

function getOperationsSnapshot() {
  const dbStats = fs.existsSync(config.dbPath) ? fs.statSync(config.dbPath) : null;
  const inpxFile = getConfiguredInpxFile();
  const bookCacheStats = db
    .prepare(
      `SELECT COUNT(*) AS count,
        IFNULL(SUM(LENGTH(COALESCE(annotation, '')) + LENGTH(COALESCE(cover_data, ''))), 0) AS approx_bytes
       FROM book_details_cache`
    )
    .get();
  const bookmarkCount = db.prepare('SELECT COUNT(*) AS count FROM bookmarks').get().count;
  const historyCount = db.prepare('SELECT COUNT(*) AS count FROM reading_history').get().count;
  const validation = getServiceValidation();
  const mem = process.memoryUsage();
  const disk = getDiskUsageForPath(config.dbPath);
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
    cacheApproxBytes: bookCacheStats.approx_bytes,
    bookmarkCount,
    historyCount,
    loginRateLimitWindowMs: config.loginWindowMs,
    loginRateLimitMaxAttempts: config.loginMaxAttempts,
    sessionMaxAgeMs: config.sessionMaxAgeMs,
    serverStartedAt: serverStartedAt.toISOString(),
    totalUsers: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    onlineUsers: getOnlineUserCount(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    systemMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    diskTotalMB: disk?.totalMB ?? null,
    diskFreeMB: disk?.freeMB ?? null,
    cpuPercent: sampleProcessCpuPercent(),
    appVersion: readPackageVersion(),
    sources: getSources()
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
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(compression({ threshold: 1024 }));
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
    p.startsWith('/shelves/')
  ) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}
app.use(browseHtmlNoStore);
app.use(browseLimiter);

// Публичные диагностические маршруты — до express.static, чтобы не пересекаться с файлами из public/.
registerHealthRoutes(app, { getCachedStats, getServiceValidation });
registerBrowseApiRoutes(app);

app.use(express.static(config.publicDir, {
  maxAge: '6h',
  etag: true
}));

registerAuthRoutes(app, { getCachedStats });

// ── Maintenance gate: block user-facing pages when a heavy DB operation is running ──
function isMaintenanceActive() {
  return operationsState.reindexRunning ||
    operationsState.repairRunning ||
    operationsState.sourceDeleteRunning ||
    operationsState.sidecarRunning;
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
    p.startsWith('/download/') ||
    p.startsWith('/health') ||
    p === '/set-lang' ||
    p === '/manifest.webmanifest' ||
    p === '/sw.js'
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
    renderHome, renderCatalog, renderLibraryView, renderBrowsePage,
    renderFacetBooks, renderAuthorFacetPage, renderAuthorOutsideSeriesPage,
    renderBook, renderFavorites, renderShelves, renderShelfDetail, renderReader
  }
});

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
  templates: {
    renderOperations, renderAdminUsers, renderAdminUpdate, renderAdminSmtp,
    renderAdminEvents, renderAdminSources, renderAdminDuplicates, renderAdminContent
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
  await rebuildActiveBooksView(); // Пересоздаём VIEW с учётом исключённых языков
  // Run DB optimize manually/offline; in-process optimize can block HTTP loop on large datasets.
  setSiteName(getSetting('site_name'));
  setAllowAnonymousDownload(getSetting('allow_anonymous_download') === '1');

  const httpServer = app.listen(config.port, () => {
    console.log(`INPX Library Server listening on http://localhost:${config.port}`);
    console.log(`Library root: ${getLibraryRoot()}`);
    logSystemEvent('info', 'server', 'server started', { port: config.port, libraryRoot: getLibraryRoot() });
  });
  app.set('httpServer', httpServer);

  // --- Таймауты для защиты от утечки соединений при нагрузке ---
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 70_000;
  httpServer.requestTimeout = 30_000;
  if (typeof httpServer.maxRequestsPerSocket !== 'undefined') {
    httpServer.maxRequestsPerSocket = 200;
  }

  setTimeout(async () => {
    if (getMeta('books_fts_dirty') === '1') {
      console.log('[startup] FTS index is dirty (previous indexing was interrupted). Rebuilding…');
      logSystemEvent('warn', 'server', 'FTS dirty on startup — rebuilding');
      try {
        ensureBooksFtsTriggers();
        await rebuildBooksFtsFromContent();
        setMeta('books_fts_dirty', '0');
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

    // Start scan scheduler (if SCAN_INTERVAL_HOURS > 0)
    startScanScheduler(() => startBackgroundIndexing(false, true));
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

  // Avoid synchronous wal_checkpoint in the main HTTP event loop:
  // under heavy write/read contention it can block responses for long periods.

  setInterval(() => {
    pruneLoginAttempts();
    pruneOfflineUsers();
  }, 15 * 60 * 1000).unref();
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
