import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';
import { config } from '../config.js';
import { runWithLocaleLang, resolveLocale, t, tp, countLabel, translateKnownErrorMessage } from '../i18n.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { requireAdminWeb, requireAdminApi } from '../middleware/auth.js';
import { clearPageDataCache } from '../services/cache.js';
import { verifySmtpConnection } from '../services/email.js';
import {
  logSystemEvent, getSystemEventCategories, parseSystemEventsFilters,
  getRecentSystemEvents, retainRecentSystemEvents, clearSystemEventsTable, subscribeSystemEvents
} from '../services/system-events.js';
import { getRecentRuntimeLogs, subscribeRuntimeLogs, getRuntimeLogFilePath } from '../services/runtime-logs.js';
import { restartScanScheduler, getSchedulerIntervalHours } from '../services/scheduler.js';
import {
  setSetting, getSetting, encryptValue, decryptValue, getSources, getSourceById,
  addSource, updateSource, deleteSourceProgressive, forceDetachSourceRowUnsafe,
  getSmtpSettings, setSmtpSettings, hasAdminUser, listUsers, countAdminUsers,
  getUserByUsername, upsertUser, updateUser, deleteUser, blockUser, unblockUser,
  db, getDistinctLanguages, rebuildActiveBooksView,
  getSuppressedBooks, unsuppressBook, unsuppressAll
} from '../db.js';
import {
  getBookById, getIndexStatus, getConfiguredInpxFile, setConfiguredInpxFile,
  getSourceRoot, getAuthorFlibustaSourceId, startBackgroundIndexing, startSourceIndexing,
  requestIndexPause, requestIndexResume, requestIndexStop,
  splitAuthorValues, getDuplicateGroups, softDeleteBook, autoCleanDuplicates,
  previewAutoClean, markLibraryDedupProjectionStale
} from '../inpx.js';
import {
  detectFlibustaSidecarLayout, resolveLibraryArchiveRelPath, resolveSidecarArchivePath,
  coverPrimaryKeysForBook, flibustaAuthorKeyCandidates,
  readFlibustaAuthorPortraitBuffer, readFlibustaBookReviewHtml,
  readFlibustaAuthorPortraitForAuthorName, readFlibustaAuthorBioHtml,
  listFlibustaIllustrationsForBook, refreshFlibustaSidecarForSource
} from '../flibusta-sidecar.js';
import {
  SYSTEM_EVENTS_MAX_COUNT, SYSTEM_EVENTS_RETAIN_COUNT,
  UPDATE_TIMEOUT_MS, UPDATE_PROTECTED_DIRS, UPDATE_PROTECTED_FILES,
  MAX_UNCOMPRESSED_TOTAL, MAX_SINGLE_FILE, SAFE_ADMIN_REDIRECTS
} from '../constants.js';

// --- Update from ZIP: local state ---
const UPDATE_LOG_PATH = path.join(config.dataDir, 'update.log');
let updateRunning = false;
let updateStartedAt = 0;

function appendUpdateLog(line) {
  fs.appendFileSync(UPDATE_LOG_PATH, line + '\n', 'utf8');
}
function resetUpdateLog() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(UPDATE_LOG_PATH, '', 'utf8');
}
function isProtectedPath(relativePath) {
  const top = relativePath.split(/[/\\]/)[0];
  if (UPDATE_PROTECTED_DIRS.has(top) || UPDATE_PROTECTED_DIRS.has(relativePath)) return true;
  const normalized = relativePath.replace(/\\/g, '/');
  return UPDATE_PROTECTED_FILES.has(normalized);
}
function isSafePath(relativePath) {
  if (/\0/.test(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  if (/\.\.[/\\]/.test(relativePath)) return false;
  return true;
}

/**
 * @param {import('express').Express} app
 * @param {object} deps - local server.js state/helpers
 * @param {object} deps.operationsState
 * @param {Function} deps.getOperationsSnapshot
 * @param {Function} deps.getServiceValidation
 * @param {Function} deps.getCachedStats
 * @param {Function} deps.clearBookDetailsCache
 * @param {Function} deps.getDetailsFull
 * @param {Function} deps.buildPublicSettingsExport
 * @param {Function} deps.runRepairMetadata
 * @param {Function} deps.bookFlibustaSidecarEffective
 * @param {Function} deps.gracefulExit
 * @param {Function} deps.setAllowAnonymousDownload
 * @param {Function} deps.setSiteName
 * @param {object} deps.templates - render functions
 */
export function registerAdminRoutes(app, deps) {
  const {
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
      renderAdminEvents, renderAdminSources, renderAdminDuplicates, renderAdminLanguages
    }
  } = deps;

  // --- Settings (web form POSTs) ---

  app.post('/admin/settings/registration', requireAdminWeb, (req, res) => {
    try {
      const enabled = req.body.enabled === '1';
      setSetting('allow_registration', enabled ? '1' : '0');
      logSystemEvent('info', 'admin', enabled ? 'registration enabled' : 'registration disabled', { admin: req.user.username });
      res.redirect('/admin/users');
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/settings/anonymous-access', requireAdminWeb, (req, res) => {
    try {
      const last = (v) => Array.isArray(v) ? v[v.length - 1] : v;
      const browse = last(req.body.allow_anonymous_browse) === '1' ? '1' : '0';
      const download = last(req.body.allow_anonymous_download) === '1' ? '1' : '0';
      const opds = last(req.body.allow_anonymous_opds) === '1' ? '1' : '0';
      setSetting('allow_anonymous_browse', browse);
      setSetting('allow_anonymous_download', download);
      setSetting('allow_anonymous_opds', opds);
      setAllowAnonymousDownload(download === '1');
      clearPageDataCache();
      logSystemEvent('info', 'admin', 'anonymous access settings updated', { admin: req.user.username, browse, download, opds });
      res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.flash.anonymousSaved')));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/settings/recaptcha', requireAdminWeb, (req, res) => {
    try {
      setSetting('recaptcha_site_key', String(req.body.siteKey || '').trim());
      const newSecretKey = String(req.body.secretKey || '').trim();
      if (newSecretKey) {
        setSetting('recaptcha_secret_key', encryptValue(newSecretKey));
      }
      logSystemEvent('info', 'admin', 'recaptcha settings updated', { admin: req.user.username });
      res.redirect('/admin/users?recaptcha=saved');
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/settings/scan-interval', requireAdminWeb, (req, res) => {
    try {
      const hours = Math.max(0, Math.min(8760, Math.floor(Number(req.body.hours) || 0)));
      setSetting('scan_interval_hours', String(hours));
      restartScanScheduler();
      logSystemEvent('info', 'admin', 'scan interval updated', { admin: req.user.username, hours });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(hours ? `Scan interval: ${hours}h` : 'Scan scheduler disabled'));
    } catch (error) {
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/settings/covers', requireAdminWeb, (req, res) => {
    try {
      const width = Math.max(32, Math.min(1200, Math.floor(Number(req.body.width) || 220)));
      const height = Math.max(32, Math.min(1600, Math.floor(Number(req.body.height) || 320)));
      const quality = Math.max(1, Math.min(100, Math.floor(Number(req.body.quality) || 86)));
      setSetting('cover_max_width', String(width));
      setSetting('cover_max_height', String(height));
      setSetting('cover_quality', String(quality));
      logSystemEvent('info', 'admin', 'cover settings updated', { admin: req.user.username, width, height, quality });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(`Covers: ${width}\u00d7${height}, quality ${quality}`));
    } catch (error) {
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  // --- API Sources ---

  app.get('/api/sources', requireAdminApi, (req, res) => {
    res.json({ sources: getSources() });
  });

  app.post('/api/sources/probe', requireAdminApi, (req, res) => {
    const probePath = String(req.body.path || '').trim();
    if (!probePath) {
      return res.json({ ok: false, code: ApiErrorCode.PROBE_PATH_REQUIRED, error: t('admin.probe.pathRequired') });
    }
    const resolvedPath = path.resolve(probePath);
    try {
      if (!fs.existsSync(resolvedPath)) return res.json({ ok: true, exists: false });
      const stat = fs.statSync(resolvedPath);
      if (stat.isFile() && resolvedPath.toLowerCase().endsWith('.inpx')) {
        return res.json({ ok: true, exists: true, isFile: true, isInpx: true, inpxFiles: [path.basename(resolvedPath)] });
      }
      if (!stat.isDirectory()) {
        return res.json({ ok: false, code: ApiErrorCode.PROBE_PATH_INVALID, error: t('admin.probe.pathInvalid') });
      }
      const entries = fs.readdirSync(resolvedPath);
      const inpxNames = entries.filter((e) => e.toLowerCase().endsWith('.inpx'));
      return res.json({ ok: true, exists: true, isFile: false, isInpx: false, inpxFiles: inpxNames.map((e) => path.join(resolvedPath, e)) });
    } catch {
      return res.json({ ok: false, code: ApiErrorCode.PROBE_PATH_UNREADABLE, error: t('admin.probe.pathUnreadable') });
    }
  });

  // --- Sidecar diagnostics ---

  app.get('/api/admin/sidecar/book/:id', requireAdminApi, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return apiFail(res, 400, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const book = getBookById(id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const root = getSourceRoot(book.sourceId);
    const normalizedArchive = resolveLibraryArchiveRelPath(root, book.archiveName || '');
    const hasLayout = detectFlibustaSidecarLayout(root);
    const keys = coverPrimaryKeysForBook(book);
    const effective = bookFlibustaSidecarEffective(book) === 1;
    let cover = { ok: false, reason: 'not_checked' };
    let review = { ok: false, reason: 'not_checked' };
    let portrait = { ok: false, reason: 'no_primary_author' };
    let bio = { ok: false, reason: 'no_primary_author' };
    let illustrations = { count: 0, firstIndex: null };
    try {
      const details = await getDetailsFull(book);
      cover = details?.cover?.data?.length
        ? { ok: true, contentType: details.cover.contentType, bytes: details.cover.data.length }
        : { ok: false, reason: 'cover_not_found' };
    } catch (error) {
      cover = { ok: false, reason: 'details_error', error: error.message };
    }
    try {
      const html = await readFlibustaBookReviewHtml(book, root);
      review = html && String(html).trim()
        ? { ok: true, length: String(html).length }
        : { ok: false, reason: 'review_not_found' };
    } catch (error) {
      review = { ok: false, reason: 'review_error', error: error.message };
    }
    const primaryAuthor = book.authorsList?.[0] || splitAuthorValues(book.authors || '')[0] || '';
    if (primaryAuthor) {
      try {
        const pic = await readFlibustaAuthorPortraitForAuthorName(primaryAuthor, root);
        portrait = pic?.data?.length
          ? { ok: true, contentType: pic.contentType, bytes: pic.data.length }
          : { ok: false, reason: 'portrait_not_found' };
      } catch (error) {
        portrait = { ok: false, reason: 'portrait_error', error: error.message };
      }
      try {
        const html = await readFlibustaAuthorBioHtml(primaryAuthor, root, book.sourceId);
        bio = html && String(html).trim()
          ? { ok: true, length: String(html).length }
          : { ok: false, reason: 'bio_not_found' };
      } catch (error) {
        bio = { ok: false, reason: 'bio_error', error: error.message };
      }
    }
    try {
      const list = await listFlibustaIllustrationsForBook(root, book);
      illustrations = { count: list.length, firstIndex: list.length ? list[0].index : null };
    } catch {
      illustrations = { count: 0, firstIndex: null };
    }
    const coversArchive = resolveSidecarArchivePath(root, 'covers', normalizedArchive);
    const imagesArchive = resolveSidecarArchivePath(root, 'images', normalizedArchive);
    res.json({
      ok: true,
      source: { id: book.sourceId, root, detectedLayout: hasLayout, effectiveForBook: effective },
      book: { id: book.id, archiveName: book.archiveName, normalizedArchive, fileName: book.fileName, libId: book.libId || '', coverKeys: keys },
      sidecar: { coversArchive: coversArchive || '', imagesArchive: imagesArchive || '' },
      media: { cover, review, portrait, bio, illustrations }
    });
  });

  app.get('/api/admin/sidecar/author', requireAdminApi, async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, 'name is required');
    }
    const sourceId = getAuthorFlibustaSourceId(name);
    if (sourceId == null) {
      return res.json({ ok: true, foundInCatalog: false, name });
    }
    const root = getSourceRoot(sourceId);
    const keys = flibustaAuthorKeyCandidates(name);
    let portrait = { ok: false, reason: 'not_found' };
    let bio = { ok: false, reason: 'not_found' };
    for (const key of keys) {
      try {
        const pic = await readFlibustaAuthorPortraitBuffer(key, root);
        if (pic?.data?.length) {
          portrait = { ok: true, key, contentType: pic.contentType, bytes: pic.data.length };
          break;
        }
      } catch { /* continue */ }
    }
    try {
      const html = await readFlibustaAuthorBioHtml(name, root, sourceId);
      bio = html && String(html).trim()
        ? { ok: true, length: String(html).length }
        : { ok: false, reason: 'bio_not_found' };
    } catch (error) {
      bio = { ok: false, reason: 'bio_error', error: error.message };
    }
    res.json({
      ok: true, foundInCatalog: true, name, sourceId, root,
      detectedLayout: detectFlibustaSidecarLayout(root), md5Keys: keys, portrait, bio
    });
  });

  // --- Monitoring / Operations ---

  app.get('/monitoring/snapshot', requireAdminApi, (req, res) => {
    const indexStatus = getIndexStatus();
    const validation = getServiceValidation();
    const ready = {
      ok: !indexStatus.error && validation.ok,
      indexing: indexStatus.active,
      indexedAt: indexStatus.indexedAt,
      error: indexStatus.error || '',
      validation
    };
    res.json({
      health: { ok: true, service: 'inpx-library', time: new Date().toISOString() },
      ready, indexStatus, operations: getOperationsSnapshot(), events: getRecentSystemEvents()
    });
  });

  app.get('/api/operations', requireAdminApi, (req, res) => {
    res.json({
      indexStatus: getIndexStatus(),
      operations: getOperationsSnapshot(),
      events: getRecentSystemEvents()
    });
  });

  // --- System Events ---

  app.get('/api/admin/system-events', requireAdminApi, (req, res) => {
    const filters = parseSystemEventsFilters(req.query);
    const result = getRecentSystemEvents({
      page: 1, pageSize: SYSTEM_EVENTS_MAX_COUNT,
      level: filters.level, category: filters.category
    });
    res.json({ ok: true, events: result.items, total: result.total });
  });

  app.get('/api/admin/system-events/stream', requireAdminApi, (req, res) => {
    const filters = parseSystemEventsFilters(req.query);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const initial = getRecentSystemEvents({
      page: 1, pageSize: SYSTEM_EVENTS_MAX_COUNT,
      level: filters.level, category: filters.category
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', events: initial.items, total: initial.total })}\n\n`);
    const unsubscribe = subscribeSystemEvents((event) => {
      if (filters.level && event.level !== filters.level) return;
      if (filters.category && event.category !== filters.category) return;
      res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
    });
    const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 15000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // --- Runtime Logs ---

  app.get('/api/admin/runtime-logs', requireAdminApi, (req, res) => {
    const limit = Math.max(50, Math.min(5000, Math.floor(Number(req.query.limit) || 500)));
    res.json({ ok: true, logs: getRecentRuntimeLogs(limit) });
  });

  app.get('/api/admin/runtime-logs/stream', requireAdminApi, (req, res) => {
    const limit = Math.max(50, Math.min(5000, Math.floor(Number(req.query.limit) || 500)));
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'snapshot', logs: getRecentRuntimeLogs(limit) })}\n\n`);
    const unsubscribe = subscribeRuntimeLogs((entry) => {
      res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    });
    const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 15000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.get('/api/admin/runtime-logs/download', requireAdminApi, (req, res) => {
    try {
      const logPath = getRuntimeLogFilePath();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `runtime-logs-${stamp}.log`;
      if (!fs.existsSync(logPath)) {
        const lines = getRecentRuntimeLogs(2000)
          .map((item) => {
            let line = `[${item.createdAt}]${item.createdAtIso ? ` (${item.createdAtIso})` : ''} ${String(item.level || '').toUpperCase()} [${item.source}]${item.pid != null ? ` pid=${item.pid}` : ''}${item.hostname ? ` host=${item.hostname}` : ''} ${item.message}`;
            if (item.meta && typeof item.meta === 'object') {
              try { line += ` | ${JSON.stringify(item.meta)}`; } catch { line += ' | [meta]'; }
            }
            return line;
          })
          .join('\n');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.type('text/plain; charset=utf-8');
        return res.send(`${lines}\n`);
      }
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.type('text/plain; charset=utf-8');
      const logStream = fs.createReadStream(logPath);
      logStream.on('error', (err) => { logStream.destroy(); if (!res.headersSent) res.status(500).end(); });
      res.on('close', () => { if (!res.writableFinished) logStream.destroy(); });
      logStream.pipe(res);
    } catch (error) {
      return apiFail(res, 500, ApiErrorCode.INTERNAL, `Failed to export logs: ${error.message}`);
    }
  });

  // --- Admin pages ---

  app.get('/admin', requireAdminWeb, (req, res) => {
    const stats = getCachedStats();
    res.send(renderOperations({
      user: req.user, stats, indexStatus: getIndexStatus(),
      operations: getOperationsSnapshot(), flash: String(req.query.flash || ''),
      siteName: getSetting('site_name') || '', homeSubtitle: getSetting('home_subtitle') || '', csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/admin/users', requireAdminWeb, (req, res) => {
    const stats = getCachedStats();
    res.send(renderAdminUsers({
      user: req.user, stats, indexStatus: getIndexStatus(),
      users: listUsers(), flash: String(req.query.flash || ''),
      adminCount: countAdminUsers(),
      registrationEnabled: getSetting('allow_registration') === '1',
      recaptchaSiteKey: getSetting('recaptcha_site_key'),
      recaptchaSecretKey: decryptValue(getSetting('recaptcha_secret_key')),
      allowAnonymousBrowse: getSetting('allow_anonymous_browse') === '1',
      allowAnonymousDownload: getSetting('allow_anonymous_download') === '1',
      allowAnonymousOpds: getSetting('allow_anonymous_opds') === '1',
      csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/admin/update', requireAdminWeb, (req, res) => {
    res.send(renderAdminUpdate({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      operations: getOperationsSnapshot(), csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/admin/smtp', requireAdminWeb, (req, res) => {
    res.send(renderAdminSmtp({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      smtp: getSmtpSettings(), flash: String(req.query.flash || ''),
      csrfToken: req.csrfToken || ''
    }));
  });

  app.post('/admin/smtp', requireAdminWeb, async (req, res) => {
    const { host, port, secure, user, pass, from, test } = req.body;
    const settings = { host, port: Number(port) || 587, secure: secure === '1', user, pass, from };
    if (test) {
      setSmtpSettings(settings);
      try {
        await verifySmtpConnection();
        return res.redirect('/admin/smtp?flash=' + encodeURIComponent(t('admin.smtp.flashOk')));
      } catch (err) {
        return res.redirect('/admin/smtp?flash=' + encodeURIComponent(tp('admin.smtp.flashErr', { message: err.message })));
      }
    }
    setSmtpSettings(settings);
    res.redirect('/admin/smtp?flash=' + encodeURIComponent(t('admin.smtp.flashSaved')));
  });

  app.get('/admin/events', requireAdminWeb, (req, res) => {
    const stats = getCachedStats();
    const filters = parseSystemEventsFilters(req.query);
    const result = getRecentSystemEvents({
      page: 1, pageSize: SYSTEM_EVENTS_MAX_COUNT,
      level: filters.level, category: filters.category
    });
    res.send(renderAdminEvents({
      user: req.user, stats, indexStatus: getIndexStatus(),
      events: result.items, total: result.total,
      categories: getSystemEventCategories(), filters,
      retainCount: SYSTEM_EVENTS_RETAIN_COUNT, maxCount: SYSTEM_EVENTS_MAX_COUNT,
      flash: String(req.query.flash || ''), csrfToken: req.csrfToken || ''
    }));
  });

  app.post('/admin/settings/site-name', requireAdminWeb, (req, res) => {
    try {
      const name = String(req.body.siteName || '').trim();
      setSetting('site_name', name);
      setSiteName(name);
      const subtitle = String(req.body.homeSubtitle ?? '').trim();
      setSetting('home_subtitle', subtitle);
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'site settings updated', { actor: req.user.username, siteName: name || '(default)', homeSubtitle: subtitle || '(default)' });
      res.redirect('/admin?flash=' + encodeURIComponent(t('admin.flash.siteNameUpdated')));
    } catch (error) {
      res.redirect('/admin?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/settings/inpx', requireAdminWeb, (req, res) => {
    const rawRedirectTo = String(req.body.redirectTo || '/admin');
    const redirectTo = SAFE_ADMIN_REDIRECTS.has(rawRedirectTo) ? rawRedirectTo : '/admin';
    try {
      const inpxFile = String(req.body.inpxFile || '').trim();
      const savedPath = setConfiguredInpxFile(inpxFile);
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'inpx file updated', { actor: req.user.username, inpxFile: savedPath });
      res.redirect(`${redirectTo}?flash=` + encodeURIComponent(tp('admin.flash.inpxPathUpdated', { path: savedPath })));
    } catch (error) {
      res.redirect(`${redirectTo}?flash=` + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.get('/admin/sources', requireAdminWeb, (req, res) => {
    const stats = getCachedStats();
    const sources = getSources();
    res.send(renderAdminSources({
      user: req.user, stats, indexStatus: getIndexStatus(), sources,
      flash: String(req.query.flash || ''), csrfToken: req.csrfToken || '',
      scanIntervalHours: getSchedulerIntervalHours(),
      coverWidth: Number(getSetting('cover_max_width')) || config.coverMaxWidth,
      coverHeight: Number(getSetting('cover_max_height')) || config.coverMaxHeight,
      coverQuality: Number(getSetting('cover_quality')) || config.coverQuality
    }));
  });

  app.post('/admin/sources/add', requireAdminWeb, (req, res) => {
    const isJson = req.headers.accept?.includes('application/json');
    try {
      const name = String(req.body.name || '').trim();
      const type = req.body.type === 'inpx' ? 'inpx' : 'folder';
      const sourcePath = String(req.body.path || '').trim();
      if (!name || !sourcePath) {
        if (isJson) return apiFail(res, 400, ApiErrorCode.ADMIN_SOURCE_NAME_PATH, t('admin.sources.errorNamePath'));
        return res.redirect('/admin/sources?flash=' + encodeURIComponent(t('admin.sources.errorNamePath')));
      }
      const source = addSource({ name, type, path: sourcePath });
      clearPageDataCache();
      markLibraryDedupProjectionStale();
      logSystemEvent('info', 'settings', 'source added', { actor: req.user.username, source: source.name, type, path: sourcePath });
      if (isJson) return res.json({ ok: true, source });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(tp('admin.sources.flashAdded', { name: source.name })));
    } catch (error) {
      if (isJson) return apiFail(res, 500, ApiErrorCode.INTERNAL, translateKnownErrorMessage(error.message));
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/sources/:id/update', requireAdminWeb, (req, res) => {
    try {
      const id = Number(req.params.id);
      const name = req.body.name !== undefined ? String(req.body.name).trim() : undefined;
      const enabled = req.body.enabled !== undefined ? req.body.enabled === '1' : undefined;
      updateSource(id, { name, enabled });
      clearPageDataCache();
      markLibraryDedupProjectionStale();
      logSystemEvent('info', 'settings', 'source updated', { actor: req.user.username, sourceId: id });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(t('admin.sources.flashUpdated')));
    } catch (error) {
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/api/admin/sources/:id/delete', requireAdminApi, async (req, res) => {
    const id = Number(req.params.id);
    try {
      const status = getIndexStatus();
      if (status.active) {
        return res.status(409).json({ ok: false, error: t('admin.sources.deleteBlockedDuringIndexing') });
      }
      const source = getSourceById(id);
      if (!source) {
        return res.status(404).json({ ok: false, error: t('admin.sources.notFound') });
      }
      if (operationsState.sourceDeleteRunning) {
        return res.status(409).json({ ok: false, error: t('admin.sources.deleteInProgress') });
      }
      operationsState.sourceDeleteRunning = true;
      operationsState.sourceDeleteProgress = { deleted: 0, total: 0, stage: 'prepare', sourceId: id, sourceName: source.name };
      operationsState.lastSourceDeleteRequestedAt = new Date().toISOString();
      logSystemEvent('info', 'settings', 'source delete started', { actor: req.user.username, source: source.name, sourceId: id });
      res.json({ ok: true, started: true, sourceId: id, sourceName: source.name });

      // Run deletion in background after sending response
      try {
        await deleteSourceProgressive(id, {
          deleteSourceRow: true,
          chunkSize: 2000,
          interChunkDelayMs: 0,
          onProgress(p) { operationsState.sourceDeleteProgress = { ...p, sourceId: id, sourceName: source.name }; }
        });
        logSystemEvent('info', 'settings', 'source deleted', { actor: req.user.username, source: source.name, sourceId: id, mode: 'inline' });
      } catch (error) {
        const message = String(error?.message || error);
        if (/database disk image is malformed|SQLITE_CORRUPT|malformed/i.test(message)) {
          const detached = forceDetachSourceRowUnsafe(id);
          if (detached > 0) {
            logSystemEvent('warn', 'settings', 'source detached after delete failure', {
              actor: req.user.username, source: source.name, sourceId: id,
              mode: 'detach-only-inline', reason: message
            });
          } else {
            logSystemEvent('error', 'settings', 'source delete failed', { actor: req.user.username, source: source.name, error: message });
          }
        } else {
          logSystemEvent('error', 'settings', 'source delete failed', { actor: req.user.username, source: source.name, error: message });
        }
      } finally {
        operationsState.sourceDeleteRunning = false;
        clearPageDataCache();
        markLibraryDedupProjectionStale();
      }
    } catch (error) {
      operationsState.sourceDeleteRunning = false;
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/sources/delete-progress', requireAdminApi, (req, res) => {
    if (!operationsState.sourceDeleteRunning) {
      return res.json({ running: false, stage: 'done' });
    }
    const p = operationsState.sourceDeleteProgress || {};
    res.json({
      running: true,
      deleted: p.deleted || 0,
      total: p.total || 0,
      stage: p.stage || 'prepare',
      sourceName: p.sourceName || '',
      ftsDone: p.ftsDone || 0,
      ftsTotal: p.ftsTotal || 0
    });
  });

  app.post('/admin/sources/:id/reindex', requireAdminWeb, (req, res) => {
    try {
      const id = Number(req.params.id);
      const source = getSourceById(id);
      if (!source) {
        if (req.headers.accept?.includes('application/json')) {
          return apiFail(res, 404, ApiErrorCode.ADMIN_SOURCE_NOT_FOUND, t('admin.sources.notFound'));
        }
        return res.redirect('/admin/sources?flash=' + encodeURIComponent(t('admin.sources.notFound')));
      }
      if (operationsState.sourceDeleteRunning) {
        return res.redirect('/admin/sources?flash=' + encodeURIComponent(t('admin.sources.deleteInProgress')));
      }
      const force = req.body.mode === 'full';
      const started = startSourceIndexing(id, force);
      if (!started) {
        return res.redirect('/admin/sources?flash=' + encodeURIComponent(t('admin.reindexAlreadyRunning')));
      }
      clearPageDataCache();
      logSystemEvent('info', 'operations', `source reindex started (${force ? 'full' : 'incremental'})`, { actor: req.user.username, source: source.name });
      if (req.headers.accept?.includes('application/json')) return res.json({ ok: true, sourceId: id, mode: force ? 'full' : 'incremental' });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(tp('admin.sources.flashReindex', { name: source.name })));
    } catch (error) {
      if (req.headers.accept?.includes('application/json')) {
        return apiFail(res, 500, ApiErrorCode.INTERNAL, translateKnownErrorMessage(error.message));
      }
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  // --- User management ---

  app.post('/admin/users/create', requireAdminWeb, (req, res) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const role = req.body.role === 'admin' ? 'admin' : 'user';
      if (!username || !password) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashNeedCredentials')));
      }
      if (getUserByUsername(username)) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashExists', { username })));
      }
      upsertUser({ username, password, role });
      logSystemEvent('info', 'auth', 'user created', { actor: req.user.username, username, role });
      res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashSaved', { username })));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/users/update', requireAdminWeb, (req, res) => {
    try {
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const role = req.body.role === 'admin' ? 'admin' : 'user';
      if (!username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashUpdateMissing')));
      }
      updateUser({ username, password, role });
      logSystemEvent('info', 'auth', 'user updated', { actor: req.user.username, username, role, passwordChanged: Boolean(password) });
      res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashUpdated', { username })));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/users/delete', requireAdminWeb, (req, res) => {
    try {
      const username = String(req.body.username || '').trim();
      if (!username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashDeleteMissing')));
      }
      if (username === req.user.username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashCannotDeleteSelf')));
      }
      deleteUser(username);
      logSystemEvent('info', 'auth', 'user deleted', { actor: req.user.username, username });
      res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashDeleted', { username })));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/users/block', requireAdminWeb, (req, res) => {
    try {
      const username = String(req.body.username || '').trim();
      const action = String(req.body.action || '');
      if (!username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashBlockMissing')));
      }
      if (username === req.user.username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashCannotBlockSelf')));
      }
      if (action === 'unblock') {
        unblockUser(username);
        logSystemEvent('info', 'admin', 'user unblocked', { actor: req.user.username, username });
        res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashUnblocked', { username })));
      } else {
        blockUser(username);
        logSystemEvent('info', 'admin', 'user blocked', { actor: req.user.username, username });
        res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashBlocked', { username })));
      }
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  // --- Operations API ---

  app.get('/api/operations/backup', requireAdminApi, async (req, res, next) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `library-backup-${timestamp}.db`;
      const backupPath = path.join(config.dataDir, fileName);
      await db.backup(backupPath);
      logSystemEvent('info', 'operations', 'database backup exported', { user: req.user.username, fileName });
      const stat = fs.statSync(backupPath);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', stat.size);
      res.type('application/octet-stream');
      const stream = fs.createReadStream(backupPath);
      const cleanup = () => fs.unlink(backupPath, () => {});
      stream.on('end', cleanup);
      stream.on('error', (err) => { stream.destroy(); cleanup(); });
      res.on('close', () => { if (!res.writableFinished) stream.destroy(); });
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/operations/settings-export', requireAdminApi, (req, res) => {
    const payload = buildPublicSettingsExport();
    const wantDownload = ['1', 'true', 'yes'].includes(String(req.query.download || '').toLowerCase());
    logSystemEvent('info', 'operations', 'settings export', { user: req.user.username, download: wantDownload });
    if (wantDownload) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('Content-Disposition', `attachment; filename="inpx-library-settings-${stamp}.json"`);
      res.type('application/json; charset=utf-8');
      return res.send(`${JSON.stringify(payload, null, 2)}\n`);
    }
    res.json(payload);
  });

  app.post('/api/operations/reindex', requireAdminApi, (req, res) => {
    const mode = String(req.body?.mode || req.query?.mode || 'incremental');
    const force = mode === 'full';
    if (operationsState.sourceDeleteRunning) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, t('admin.sources.deleteInProgress'));
    }
    operationsState.lastReindexRequestedAt = new Date().toISOString();
    clearPageDataCache();
    const started = startBackgroundIndexing(force, !force);
    if (!started) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, t('admin.reindexAlreadyRunning'));
    }
    operationsState.reindexRunning = true;
    logSystemEvent('info', 'operations', `reindex requested (${mode})`, { mode, requestedAt: operationsState.lastReindexRequestedAt, user: req.user.username });
    res.json({ ok: true, started: true, mode, requestedAt: operationsState.lastReindexRequestedAt });
  });

  app.post('/api/operations/reindex-pause', requireAdminApi, (req, res) => {
    const ok = requestIndexPause();
    if (!ok) {
      return res.json({ ok: true, paused: false, skipped: true, reason: 'index_not_active', indexStatus: getIndexStatus() });
    }
    logSystemEvent('info', 'operations', 'reindex pause requested', { user: req.user.username });
    res.json({ ok: true, paused: true, indexStatus: getIndexStatus() });
  });

  app.post('/api/operations/reindex-resume', requireAdminApi, (req, res) => {
    const ok = requestIndexResume();
    if (!ok) {
      return res.json({ ok: true, paused: false, skipped: true, reason: 'index_not_active', indexStatus: getIndexStatus() });
    }
    logSystemEvent('info', 'operations', 'reindex resume requested', { user: req.user.username });
    res.json({ ok: true, paused: false, indexStatus: getIndexStatus() });
  });

  app.post('/api/operations/reindex-stop', requireAdminApi, (req, res) => {
    const ok = requestIndexStop();
    if (!ok) {
      return res.json({ ok: true, stopping: false, skipped: true, reason: 'index_not_active', indexStatus: getIndexStatus() });
    }
    logSystemEvent('warn', 'operations', 'reindex stop requested', { user: req.user.username });
    res.json({ ok: true, stopping: true, indexStatus: getIndexStatus() });
  });

  app.post('/api/operations/reindex-toggle-pause', requireAdminApi, (req, res) => {
    const status = getIndexStatus();
    if (!status.active) {
      return res.json({ ok: true, paused: false, skipped: true, reason: 'index_not_active', indexStatus: status });
    }
    const shouldResume = Boolean(status.pauseRequested || status.paused);
    const ok = shouldResume ? requestIndexResume() : requestIndexPause();
    if (!ok) {
      return res.json({ ok: true, paused: false, skipped: true, reason: 'index_not_active', indexStatus: getIndexStatus() });
    }
    logSystemEvent('info', 'operations', shouldResume ? 'reindex resume requested' : 'reindex pause requested', { user: req.user.username });
    return res.json({ ok: true, paused: !shouldResume, indexStatus: getIndexStatus() });
  });

  app.post('/api/operations/sidecar-rebuild', requireAdminApi, (req, res) => {
    if (operationsState.sidecarRunning) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, 'Sidecar rebuild already running');
    }
    const sourceIdRaw = req.body?.sourceId;
    const sourceId = sourceIdRaw == null || String(sourceIdRaw).trim() === '' ? null : Number(sourceIdRaw);
    if (sourceIdRaw != null && String(sourceIdRaw).trim() !== '' && (!Number.isFinite(sourceId) || sourceId <= 0)) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, 'sourceId must be a positive number');
    }
    const sources = sourceId
      ? [getSourceById(sourceId)].filter(Boolean)
      : getSources().filter((s) => s.enabled);
    if (!sources.length) {
      return apiFail(res, 404, ApiErrorCode.NOT_FOUND, 'No sources found');
    }
    operationsState.sidecarRunning = true;
    operationsState.lastSidecarRequestedAt = new Date().toISOString();
    logSystemEvent('info', 'operations', 'sidecar rebuild requested', {
      user: req.user.username, sourceId: sourceId || null, count: sources.length
    });
    res.json({
      ok: true, started: true, requestedAt: operationsState.lastSidecarRequestedAt,
      sources: sources.map((s) => ({ id: s.id, name: s.name, type: s.type }))
    });
    (async () => {
      const failures = [];
      try {
        for (const source of sources) {
          const root = source.type === 'inpx'
            ? path.dirname(path.resolve(String(source.path || '')))
            : path.resolve(String(source.path || ''));
          try {
            await refreshFlibustaSidecarForSource(source.id, root, { rebuildAuxiliary: true });
          } catch (error) {
            failures.push({ id: source.id, name: source.name, error: error.message });
          }
        }
      } finally {
        operationsState.sidecarRunning = false;
        if (failures.length) {
          logSystemEvent('error', 'operations', 'sidecar rebuild completed with errors', { failures });
        } else {
          logSystemEvent('info', 'operations', 'sidecar rebuild completed', { count: sources.length });
        }
      }
    })().catch((error) => {
      operationsState.sidecarRunning = false;
      logSystemEvent('error', 'operations', 'sidecar rebuild failed', { error: error.message });
    });
  });

  app.post('/api/operations/repair', requireAdminApi, (req, res) => {
    const started = runRepairMetadata();
    res.json({ ok: started, started, operations: getOperationsSnapshot() });
  });

  app.post('/api/operations/cache-clear', requireAdminApi, (req, res) => {
    const deleted = clearBookDetailsCache();
    logSystemEvent('info', 'operations', 'book details cache cleared', { user: req.user.username, deleted });
    res.json({ ok: true, deleted, operations: getOperationsSnapshot() });
  });

  app.post('/api/operations/restart', requireAdminApi, (req, res) => {
    logSystemEvent('info', 'operations', 'server restart requested', { user: req.user.username });
    res.json({ ok: true, message: t('admin.operations.restarting') });
    setTimeout(() => {
      const child = spawn(process.execPath, [path.join(config.rootDir, 'scripts', 'server-control.js'), 'restart'], {
        cwd: config.rootDir, detached: true, stdio: 'ignore'
      });
      child.unref();
      gracefulExit();
    }, 500);
  });

  // --- Update from ZIP ---

  app.get('/api/operations/update-log', requireAdminApi, (req, res) => {
    try {
      const text = fs.existsSync(UPDATE_LOG_PATH) ? fs.readFileSync(UPDATE_LOG_PATH, 'utf8') : '';
      res.json({ ok: true, log: text, running: updateRunning });
    } catch (error) {
      res.json({
        ok: false, code: ApiErrorCode.UPDATE_LOG_READ_ERROR,
        log: '', running: updateRunning, error: error.message
      });
    }
  });

  app.post('/api/operations/update', requireAdminApi, express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
    const updateLogLocale = resolveLocale(req);
    const logU = (fn) => runWithLocaleLang(updateLogLocale, () => appendUpdateLog(fn()));
    if (updateRunning) {
      if (Date.now() - updateStartedAt > UPDATE_TIMEOUT_MS) {
        updateRunning = false;
        logU(() => t('update.log.timeoutReset'));
      } else {
        return apiFail(res, 409, ApiErrorCode.UPDATE_RUNNING, t('admin.update.running'));
      }
    }
    const zipBuffer = req.body;
    if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 100) {
      return apiFail(res, 400, ApiErrorCode.UPDATE_BAD_ARCHIVE, t('admin.update.badArchive'));
    }
    updateRunning = true;
    updateStartedAt = Date.now();
    resetUpdateLog();
    logSystemEvent('info', 'operations', 'update started', { user: req.user.username, size: zipBuffer.length });
    res.json({ ok: true, message: t('admin.update.started') });
    (async () => {
      const backupDir = path.join(config.dataDir, 'update-backup');
      const tmpDir = path.join(config.dataDir, 'update-tmp-' + Date.now());
      try {
        logU(() => tp('update.log.archiveReceived', { size: (zipBuffer.length / 1024 / 1024).toFixed(1), unit: t('common.unitMB') }));
        const unzipper = await import('unzipper');
        fs.mkdirSync(tmpDir, { recursive: true });
        logU(() => t('update.log.unzipStart'));
        const directory = await unzipper.Open.buffer(zipBuffer);
        let rootPrefix = '';
        const firstEntry = directory.files.find((f) => f.type === 'File');
        if (firstEntry) {
          const parts = firstEntry.path.split(/[/\\]/);
          if (parts.length > 1) {
            const candidate = parts[0] + '/';
            const allUnderCandidate = directory.files.every((f) => f.path.startsWith(candidate) || f.path === parts[0]);
            if (allUnderCandidate) {
              rootPrefix = candidate;
              logU(() => tp('update.log.archiveRoot', { root: parts[0] }));
            }
          }
        }
        let totalUncompressed = 0;
        let extracted = 0;
        let skipped = 0;
        let blocked = 0;
        for (const entry of directory.files) {
          if (entry.type === 'Directory') continue;
          let relativePath = entry.path;
          if (rootPrefix && relativePath.startsWith(rootPrefix)) {
            relativePath = relativePath.slice(rootPrefix.length);
          }
          if (!relativePath) continue;
          if (!isSafePath(relativePath)) {
            logU(() => tp('update.log.unsafePath', { path: relativePath }));
            blocked++;
            continue;
          }
          if (isProtectedPath(relativePath)) {
            skipped++;
            continue;
          }
          const targetPath = path.join(tmpDir, relativePath);
          const resolvedTarget = path.resolve(targetPath);
          const resolvedTmp = path.resolve(tmpDir);
          const relToTmp = path.relative(resolvedTmp, resolvedTarget);
          if (relToTmp.startsWith('..') || path.isAbsolute(relToTmp)) {
            logU(() => tp('update.log.pathEscape', { path: relativePath }));
            blocked++;
            continue;
          }
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          const content = await entry.buffer();
          if (content.length > MAX_SINGLE_FILE) {
            logU(() => tp('update.log.fileTooBig', { size: (content.length / 1024 / 1024).toFixed(1), unit: t('common.unitMB'), path: relativePath }));
            blocked++;
            continue;
          }
          totalUncompressed += content.length;
          if (totalUncompressed > MAX_UNCOMPRESSED_TOTAL) {
            logU(() => tp('update.log.zipBomb', { max: (MAX_UNCOMPRESSED_TOTAL / 1024 / 1024).toFixed(0), unit: t('common.unitMB') }));
            appendUpdateLog('[update:done] error');
            logSystemEvent('error', 'operations', 'update rejected: zip bomb detected', { totalUncompressed, user: req.user.username });
            fs.rmSync(tmpDir, { recursive: true, force: true });
            updateRunning = false;
            return;
          }
          fs.writeFileSync(targetPath, content);
          extracted++;
        }
        if (blocked > 0) logU(() => tp('update.log.blockedSummary', { n: blocked }));
        logU(() => tp('update.log.extractedSummary', { extracted, skipped }));
        const newPkgPath = path.join(tmpDir, 'package.json');
        if (!fs.existsSync(newPkgPath)) {
          logU(() => t('update.log.noPackageJson'));
          appendUpdateLog('[update:done] error');
          logSystemEvent('error', 'operations', 'update rejected: no package.json', { user: req.user.username });
          fs.rmSync(tmpDir, { recursive: true, force: true });
          updateRunning = false;
          return;
        }
        let newPkg;
        try { newPkg = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')); } catch { newPkg = {}; }
        if (newPkg.name !== 'inpx-library-server') {
          logU(() => tp('update.log.wrongPackage', { name: newPkg.name || '?' }));
          appendUpdateLog('[update:done] error');
          logSystemEvent('error', 'operations', 'update rejected: wrong package name', { name: newPkg.name, user: req.user.username });
          fs.rmSync(tmpDir, { recursive: true, force: true });
          updateRunning = false;
          return;
        }
        if (!fs.existsSync(path.join(tmpDir, 'src', 'server.js'))) {
          logU(() => t('update.log.noServerJs'));
          appendUpdateLog('[update:done] error');
          logSystemEvent('error', 'operations', 'update rejected: missing src/server.js', { user: req.user.username });
          fs.rmSync(tmpDir, { recursive: true, force: true });
          updateRunning = false;
          return;
        }
        logU(() => tp('update.log.archiveValid', { name: newPkg.name, version: newPkg.version || '?' }));
        logU(() => t('update.log.backupStart'));
        fs.rmSync(backupDir, { recursive: true, force: true });
        fs.mkdirSync(backupDir, { recursive: true });
        const UPDATABLE_DIRS = ['src', 'public', 'scripts'];
        const backupItems = [...UPDATABLE_DIRS, 'package.json'];
        for (const item of backupItems) {
          const srcPath = path.join(config.rootDir, item);
          const destPath = path.join(backupDir, item);
          if (!fs.existsSync(srcPath)) continue;
          const stat = fs.statSync(srcPath);
          if (stat.isDirectory()) { fs.cpSync(srcPath, destPath, { recursive: true }); }
          else { fs.copyFileSync(srcPath, destPath); }
        }
        logU(() => t('update.log.backupDone'));
        logU(() => t('update.log.cleanOld'));
        for (const dir of UPDATABLE_DIRS) {
          const dirInTmp = path.join(tmpDir, dir);
          const dirInRoot = path.join(config.rootDir, dir);
          if (fs.existsSync(dirInTmp) && fs.existsSync(dirInRoot)) {
            fs.rmSync(dirInRoot, { recursive: true, force: true });
          }
        }
        logU(() => t('update.log.copyFiles'));
        let copied = 0;
        const copyRecursive = (srcDir, destDir) => {
          const items = fs.readdirSync(srcDir, { withFileTypes: true });
          for (const item of items) {
            const srcPath = path.join(srcDir, item.name);
            const destPath = path.join(destDir, item.name);
            if (item.isDirectory()) {
              fs.mkdirSync(destPath, { recursive: true });
              copyRecursive(srcPath, destPath);
            } else {
              fs.copyFileSync(srcPath, destPath);
              copied++;
            }
          }
        };
        copyRecursive(tmpDir, config.rootDir);
        logU(() => tp('update.log.copiedCount', { n: copied }));
        logU(() => t('update.log.cleanTmp'));
        fs.rmSync(tmpDir, { recursive: true, force: true });
        let oldDeps = {};
        try { oldDeps = JSON.parse(fs.readFileSync(path.join(backupDir, 'package.json'), 'utf8')).dependencies || {}; } catch {}
        const newDeps = newPkg.dependencies || {};
        const normalizeDeps = (deps) => {
          if (!deps || typeof deps !== 'object') return {};
          const sorted = {};
          for (const k of Object.keys(deps).sort()) sorted[k] = deps[k];
          return sorted;
        };
        const depsChanged = JSON.stringify(normalizeDeps(oldDeps)) !== JSON.stringify(normalizeDeps(newDeps));
        if (!depsChanged) {
          logU(() => t('update.log.depsUnchanged'));
        } else {
          logU(() => t('update.log.depsChanged'));
          const npmResult = await new Promise((resolve) => {
            const npmCliCandidates = [
              path.join(config.rootDir, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
              path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
              path.join(config.rootDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
            ];
            const npmCli = npmCliCandidates.find((c) => fs.existsSync(c));
            let spawnCmd, spawnArgs, spawnOpts;
            if (npmCli) {
              spawnCmd = process.execPath;
              spawnArgs = [npmCli, 'install', '--omit=dev'];
              spawnOpts = {};
            } else {
              spawnCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
              spawnArgs = ['install', '--omit=dev'];
              spawnOpts = { shell: true };
            }
            try {
              const child = spawn(spawnCmd, spawnArgs, {
                cwd: config.rootDir, stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true, ...spawnOpts,
                env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') }
              });
              let stdout = '';
              let stderr = '';
              child.stdout.on('data', (data) => { stdout += data; });
              child.stderr.on('data', (data) => { stderr += data; });
              child.on('close', (code) => resolve({ code, stdout, stderr }));
              child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
            } catch (spawnErr) {
              resolve({ code: -1, stdout: '', stderr: spawnErr.message });
            }
          });
          if (npmResult.code === 0) {
            logU(() => t('update.log.depsOk'));
          } else {
            const hint = process.platform === 'win32' ? 'install.cmd' : 'sudo ./install.sh';
            logU(() => tp('update.log.npmFail', { code: npmResult.code, hint }));
            if (npmResult.stderr) appendUpdateLog(npmResult.stderr.trim().slice(0, 500));
          }
        }
        logU(() => tp('update.log.doneVersion', { version: newPkg.version || '?' }));
        logU(() => t('update.log.restartingSoon'));
        appendUpdateLog('[update:done] restart');
        logSystemEvent('info', 'operations', 'update completed, restarting', { version: newPkg.version, user: req.user.username });
        updateRunning = false;
        setTimeout(() => {
          const child = spawn(process.execPath, [path.join(config.rootDir, 'scripts', 'server-control.js'), 'restart'], {
            cwd: config.rootDir, detached: true, stdio: 'ignore'
          });
          child.unref();
          gracefulExit();
        }, 2000);
      } catch (error) {
        logU(() => tp('update.log.errorLine', { message: error.message }));
        appendUpdateLog('[update:done] error');
        if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0) {
          logU(() => t('update.log.restoreStart'));
          try {
            const restoreRecursive = (srcDir, destDir) => {
              const items = fs.readdirSync(srcDir, { withFileTypes: true });
              for (const item of items) {
                const srcPath = path.join(srcDir, item.name);
                const destPath = path.join(destDir, item.name);
                if (item.isDirectory()) {
                  fs.mkdirSync(destPath, { recursive: true });
                  restoreRecursive(srcPath, destPath);
                } else {
                  fs.copyFileSync(srcPath, destPath);
                }
              }
            };
            restoreRecursive(backupDir, config.rootDir);
            logU(() => t('update.log.restoreOk'));
          } catch (restoreErr) {
            logU(() => tp('update.log.restoreErr', { message: restoreErr.message }));
          }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
        logSystemEvent('error', 'operations', 'update failed', { error: error.message, user: req.user.username });
        updateRunning = false;
      }
    })();
  });

  app.post('/api/operations/events-retain', requireAdminApi, (req, res) => {
    const deleted = retainRecentSystemEvents(SYSTEM_EVENTS_RETAIN_COUNT);
    logSystemEvent('info', 'operations', 'system events retained', { user: req.user.username, deleted, kept: SYSTEM_EVENTS_RETAIN_COUNT });
    res.json({ ok: true, deleted, kept: SYSTEM_EVENTS_RETAIN_COUNT, operations: getOperationsSnapshot(), events: getRecentSystemEvents() });
  });

  app.post('/admin/events/clear', requireAdminWeb, (req, res) => {
    try {
      const deleted = clearSystemEventsTable();
      logSystemEvent('info', 'operations', 'system events cleared', { user: req.user.username, deleted });
      res.redirect('/admin/events?flash=' + encodeURIComponent(`${t('admin.events.clearedFlash')} ${countLabel('record', deleted)}.`));
    } catch (error) {
      res.redirect('/admin/events?flash=' + encodeURIComponent(error.message));
    }
  });

  // --- Duplicates ---

  app.get('/admin/duplicates', requireAdminWeb, (req, res) => {
    res.send(renderAdminDuplicates({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      flash: String(req.query.flash || ''), csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/api/admin/duplicates', requireAdminApi, (req, res) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const pageSize = 50;
    const result = getDuplicateGroups({ page, pageSize });
    const preview = previewAutoClean();
    res.json({ ok: true, groups: result.groups, total: result.total, page, pageSize, preview });
  });

  app.post('/api/admin/duplicates/delete', requireAdminApi, (req, res) => {
    const bookId = String(req.body.bookId || '').trim();
    if (!bookId) return res.status(400).json({ ok: false, error: 'Missing book ID' });
    try {
      const changes = softDeleteBook(bookId);
      if (changes) {
        clearPageDataCache();
        logSystemEvent('info', 'operations', 'duplicate book soft-deleted', { actor: req.user.username, bookId });
      }
      res.json({ ok: true, message: changes ? t('admin.duplicates.flashDeleted') : t('admin.duplicates.flashNotFound') });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/admin/duplicates/auto-clean', requireAdminApi, (req, res) => {
    try {
      const result = autoCleanDuplicates();
      clearPageDataCache();
      logSystemEvent('info', 'operations', 'auto-clean duplicates', {
        actor: req.user.username, groupsCleaned: result.groupsCleaned, totalDeleted: result.totalDeleted
      });
      const msg = tp('admin.duplicates.autoCleanDone', { groups: result.groupsCleaned, deleted: result.totalDeleted });
      res.json({ ok: true, message: msg, groupsCleaned: result.groupsCleaned, totalDeleted: result.totalDeleted });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get('/api/admin/suppressed', requireAdminApi, (req, res) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const result = getSuppressedBooks({ page, pageSize: 50 });
    res.json({ ok: true, ...result, page, pageSize: 50 });
  });

  app.post('/api/admin/duplicates/unsuppress', requireAdminApi, (req, res) => {
    const bookId = String(req.body.bookId || '').trim();
    if (!bookId) return res.status(400).json({ ok: false, error: 'Missing book ID' });
    try {
      unsuppressBook(bookId);
      clearPageDataCache();
      logSystemEvent('info', 'operations', 'book unsuppressed', { actor: req.user.username, bookId });
      res.json({ ok: true, message: t('admin.duplicates.flashUnsuppressed') });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/admin/duplicates/unsuppress-all', requireAdminApi, (req, res) => {
    try {
      const count = unsuppressAll();
      clearPageDataCache();
      logSystemEvent('info', 'operations', 'all books unsuppressed', { actor: req.user.username, count });
      res.json({ ok: true, message: tp('admin.duplicates.flashUnsuppressedAll', { n: count }), count });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // --- Languages ---

  app.get('/admin/languages', requireAdminWeb, (req, res) => {
    const allLangs = getDistinctLanguages();
    const excluded = getSetting('excluded_languages');
    const excludedSet = new Set(
      excluded ? excluded.split(',').map(s => s.trim()).filter(Boolean) : []
    );
    res.send(renderAdminLanguages({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      languages: allLangs, excludedSet,
      flash: String(req.query.flash || ''), csrfToken: req.csrfToken || ''
    }));
  });

  app.post('/admin/languages', requireAdminWeb, async (req, res) => {
    try {
      const allLangs = getDistinctLanguages();
      const allCodes = allLangs.map(l => l.code);
      const raw = req.body.enabled || [];
      const enabled = new Set(Array.isArray(raw) ? raw : [raw]);
      const excluded = allCodes.filter(code => !enabled.has(code));
      setSetting('excluded_languages', excluded.join(','));
      await rebuildActiveBooksView();
      clearPageDataCache();
      logSystemEvent('info', 'admin', 'language filter updated', { admin: req.user.username, excluded: excluded.join(',') });
      res.redirect('/admin/languages?flash=' + encodeURIComponent(t('admin.languages.saved')));
    } catch (error) {
      res.redirect('/admin/languages?flash=' + encodeURIComponent(error.message));
    }
  });
}
