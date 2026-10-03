import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import express from 'express';
import { config } from '../config.js';
import { validateNewBooksAnnounceTemplate } from '../telegram-bot-defaults.js';

function normalizeNewBooksAnnounceTemplate(template = '') {
  return String(template || '')
    .replace(/\{\{(https?:\/\/[^}]+)\}\}/gi, '{{url}}')
    .trim()
    .slice(0, 4096);
}
import { getConfiguredDownloadFormats, setDisabledDownloadFormats } from '../download-formats.js';
import { normalizeDownloadFilenameStyle, setDownloadFilenameStyle } from '../download-filename.js';
import { normalizeFb2WebpMode, setFb2WebpMode } from '../fb2-webp-images.js';
import { runWithLocaleLang, resolveLocale, t, tp, countLabel, translateKnownErrorMessage, setDefaultLocale } from '../i18n.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { requireAdminWeb, requireAdminApi, invalidateSessionUserCache } from '../middleware/auth.js';
import { getCachedPageData, clearPageDataCache } from '../services/cache.js';
import { invalidateAllRecommendations } from '../services/recommendations.js';
import { verifySmtpConnection } from '../services/email.js';
import { resolvePublicBaseUrl } from '../services/password-reset.js';
import {
  logSystemEvent, getSystemEventCategories, parseSystemEventsFilters,
  getRecentSystemEvents, retainRecentSystemEvents, clearSystemEventsTable, subscribeSystemEvents
} from '../services/system-events.js';
import { getRecentRuntimeLogs, subscribeRuntimeLogs, getRuntimeLogFilePath } from '../services/runtime-logs.js';
import { restartScanScheduler, getSchedulerIntervalHours, getScheduleConfig, getNextRunAt, parseScheduleForm } from '../services/scheduler.js';
import {
  getUpdateState, isUpdateTimedOut, readUpdateLog, appendUpdateLog,
  beginUpdate, endUpdate, runUpdateFromZip
} from '../services/self-update.js';
import { checkForUpdate, downloadUpdateAsset } from '../services/update-check.js';
import {
  getUiCustomization, saveUiAsset, removeUiAsset, saveUiSettings,
  resetUiThemeColors, resetUiThemeSliders,
  resetUiThemeShape, resetUiThemeTypography,
  saveUiShapeSettings, saveUiTypographySettings,
  refreshBgThemePaletteForAdmin, refreshBgThemePaletteFromFile,
  getPublicUiSettingsJson, getThemePreviewFromDraft, getUiAppearanceFormState
} from '../services/ui-customization.js';
import {
  setSetting, getSetting, encryptValue, decryptValue, getSources, getSourceById,
  addSource, updateSource, deleteSourceProgressive, forceDetachSourceRowUnsafe,
  getSmtpSettings, setSmtpSettings, getTelegramSettings, setTelegramSettings, resolveTelegramTokenForAdmin, syncTelegramChatsFromLinkedUsers, hasAdminUser, listUsers, countAdminUsers,
  isPasswordResetEnabled, getPublicBaseUrlSetting, setPasswordResetSettings,
  getOidcSettings, setOidcSettings,
  getUserByUsername, upsertUser, updateUser, deleteUser, blockUser, unblockUser, getUserByTelegramId, normalizeTelegramId, setUserTelegramId, setUserTelegramBotAllowed, setUserEreaderEmailAllowed, setUserEreaderEmail, getEreaderEmail,
  db, getDistinctLanguages, getDistinctGenres, rebuildActiveBooksView, refreshCatalogBookCounts,
  getSuppressedBooks, unsuppressBook, unsuppressAll, getScheduleLog, adjustCatalogCountsForBook, isBookInActiveView,
  setMeta, rebuildBooksFtsFromContent, invalidateBooksFtsHealthCache
} from '../db.js';
import {
  getBookById, getIndexStatus, getConfiguredInpxFile, setConfiguredInpxFile,
  getSourceRoot, getAuthorFlibustaSourceId, startBackgroundIndexing, startSourceIndexing,
  requestIndexPause, requestIndexResume, requestIndexStop,
  splitAuthorValues, getDuplicateGroups, softDeleteBook, autoCleanDuplicates,
  previewAutoClean, markLibraryDedupProjectionStale, invalidateDuplicatesCache,
  rebuildTitleTokenDictionary
} from '../inpx.js';
import {
  detectFlibustaSidecarLayout, resolveLibraryArchiveRelPath, resolveSidecarArchivePath,
  coverPrimaryKeysForBook, flibustaAuthorKeyCandidates,
  readFlibustaAuthorPortraitBuffer, readFlibustaBookReviewHtml,
  readFlibustaAuthorPortraitForAuthorName, readFlibustaAuthorBioHtml,
  listFlibustaIllustrationsForBook, refreshFlibustaSidecarForSource
} from '../flibusta-sidecar.js';
import { clearArchiveReadCaches } from '../archives.js';
import { clearOidcDiscoveryCache } from '../services/oidc.js';
import {
  SYSTEM_EVENTS_MAX_COUNT, SYSTEM_EVENTS_RETAIN_COUNT, SAFE_ADMIN_REDIRECTS
} from '../constants.js';
import { exportUsersBackup, importUsersBackup } from '../services/user-backup.js';

function lastFormFieldValue(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function wantsJson(req) {
  return String(req.get('accept') || '').includes('application/json');
}

function buildRegistrationInviteUrl(req, token) {
  const value = String(token || '').trim();
  if (!value) return '';
  return `${resolvePublicBaseUrl(req)}/register?invite=${encodeURIComponent(value)}`;
}

function respondRegistrationInvite(req, res, { token = '', flash, status = 200 }) {
  if (wantsJson(req)) {
    return res.status(status).json({
      ok: status < 400,
      token,
      url: buildRegistrationInviteUrl(req, token),
      flash
    });
  }
  return res.redirect('/admin/users?flash=' + encodeURIComponent(flash));
}

function isFormFlagEnabled(value) {
  const raw = lastFormFieldValue(value);
  return raw === '1' || raw === 1 || raw === true;
}

function uiAdminFlashMessage(error) {
  const msg = String(error?.message || '');
  return msg.startsWith('admin.') ? t(msg) : translateKnownErrorMessage(msg);
}

function readUiAssetOriginalName(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const uiUploadRawParser = express.raw({ type: '*/*', limit: '5mb' });

function parseUiUploadBody(req, res, next) {
  uiUploadRawParser(req, res, (err) => {
    if (err) {
      if (err.type === 'entity.too.large' || err.status === 413) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('admin.ui.errorTooLarge'));
      }
      return next(err);
    }
    next();
  });
}

// Self-update состояние и логика вынесены в services/self-update.js.
// i18n-ключи ниже используются при форматировании пользовательского лога апдейта.

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
function adminUserFieldKey(base, username) {
  return `${base}__${String(username).replace(/[^\w.-]/g, '_')}`;
}

function readAdminUserField(body, username, base) {
  const scoped = adminUserFieldKey(base, username);
  const raw = body?.[scoped] ?? body?.[base];
  if (Array.isArray(raw)) return String(raw[raw.length - 1] ?? '').trim();
  return String(raw ?? '').trim();
}

function readAdminAccountUsername(body) {
  const raw = body?.accountUsername ?? body?.username;
  if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
  return String(raw ?? '').trim();
}

/** Exported for tests: scoped TG/email fields were hydrated in the browser before submit. */
export function isAdminUserScopedFieldsReady(body, username) {
  return isFormFlagEnabled(readAdminUserField(body, username, 'accountFieldsReady'));
}

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
    restartTelegramBot,
    isTelegramBotRunning,
    testAnnounceNewBooksInTelegram,
    syncTelegramBotProfilePhoto,
    templates: {
      renderOperations, renderAdminUsers, renderAdminUpdate, renderAdminSmtp,
      renderAdminTelegram, renderAdminEvents, renderAdminSources, renderAdminDuplicates, renderAdminContent,
      renderAdminAppearance
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

  app.post('/admin/settings/registration-invite', requireAdminWeb, (req, res) => {
    try {
      const action = String(lastFormFieldValue(req.body.inviteAction ?? req.body.action) || 'save');
      if (action === 'generate') {
        const token = crypto.randomBytes(16).toString('base64url');
        setSetting('registration_invite_token', token);
        logSystemEvent('info', 'admin', 'registration invite token generated', { admin: req.user.username });
        return respondRegistrationInvite(req, res, { token, flash: t('admin.flash.inviteGenerated') });
      }
      const token = String(lastFormFieldValue(req.body.token) || '').trim();
      if (token && (token.length < 4 || token.length > 128 || /\s/.test(token))) {
        return respondRegistrationInvite(req, res, {
          token,
          flash: t('admin.users.inviteInvalid'),
          status: 400
        });
      }
      setSetting('registration_invite_token', token);
      logSystemEvent('info', 'admin', token ? 'registration invite token saved' : 'registration invite token cleared', {
        admin: req.user.username
      });
      return respondRegistrationInvite(req, res, {
        token,
        flash: token ? t('admin.flash.inviteSaved') : t('admin.flash.inviteCleared')
      });
    } catch (error) {
      return respondRegistrationInvite(req, res, {
        token: String(lastFormFieldValue(req.body.token) || '').trim(),
        flash: translateKnownErrorMessage(error.message),
        status: 400
      });
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

  /* Legacy: одиночное число часов. Оставлено для совместимости со старыми
     закладками/скриптами — внутри переводим в новую модель (mode=interval). */
  app.post('/admin/settings/scan-interval', requireAdminWeb, (req, res) => {
    try {
      const hours = Math.max(0, Math.min(8760, Math.floor(Number(req.body.hours) || 0)));
      setSetting('scan_interval_hours', String(hours));
      setSetting('scan_schedule_mode', hours > 0 ? 'interval' : 'off');
      setSetting('scan_schedule_hours', String(hours));
      restartScanScheduler();
      logSystemEvent('info', 'admin', 'scan interval updated (legacy form)', { admin: req.user.username, hours });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(hours ? `Scan interval: ${hours}h` : 'Scan scheduler disabled'));
    } catch (error) {
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  /* Новая, богатая форма расписания: режимы off/interval/daily/weekly + full/incremental. */
  app.post('/admin/settings/scan-schedule', requireAdminWeb, (req, res) => {
    try {
      const { mode, hours, time, dow, full } = parseScheduleForm(req.body);

      setSetting('scan_schedule_mode', mode);
      setSetting('scan_schedule_hours', String(hours));
      setSetting('scan_schedule_time', time);
      setSetting('scan_schedule_dow', dow);
      setSetting('scan_schedule_full', full ? '1' : '0');
      /* Сохраняем зеркало в legacy-ключе, чтобы getSchedulerIntervalHours() и
         внешние интеграции продолжали отдавать осмысленное число. */
      if (mode === 'interval') setSetting('scan_interval_hours', String(hours));
      else if (mode === 'off') setSetting('scan_interval_hours', '0');

      restartScanScheduler();
      logSystemEvent('info', 'admin', 'scan schedule updated', {
        admin: req.user.username, mode, hours, time, dow, full
      });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(t('admin.schedule.flashSaved') || 'Schedule saved'));
    } catch (error) {
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.get('/api/admin/scan-schedule', requireAdminApi, (req, res) => {
    const cfg = getScheduleConfig();
    const nextRunAt = getNextRunAt();
    res.json({
      ok: true,
      schedule: cfg,
      nextRunAt,
      log: getScheduleLog(10)
    });
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

    let unsubscribe = null;
    let heartbeat = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      if (unsubscribe !== null) unsubscribe();
    };

    res.on('error', cleanup);
    req.on('close', cleanup);

    try {
      res.write(`data: ${JSON.stringify({ type: 'snapshot', events: initial.items, total: initial.total })}\n\n`);
    } catch { cleanup(); return; }

    unsubscribe = subscribeSystemEvents((event) => {
      if (filters.level && event.level !== filters.level) return;
      if (filters.category && event.category !== filters.category) return;
      try {
        res.write(`data: ${JSON.stringify({ type: 'event', event })}\n\n`);
      } catch { cleanup(); }
    });
    heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 15000);
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

    let unsubscribe = null;
    let heartbeat = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) clearInterval(heartbeat);
      if (unsubscribe !== null) unsubscribe();
    };

    res.on('error', cleanup);
    req.on('close', cleanup);

    try {
      res.write(`data: ${JSON.stringify({ type: 'snapshot', logs: getRecentRuntimeLogs(limit) })}\n\n`);
    } catch { cleanup(); return; }

    unsubscribe = subscribeRuntimeLogs((entry) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
      } catch { cleanup(); }
    });
    heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, 15000);
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
      defaultLocale: getSetting('default_locale') || 'auto',
      csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/admin/users', requireAdminWeb, (req, res) => {
    const stats = getCachedStats();
    const registrationInviteToken = String(getSetting('registration_invite_token') || '').trim();
    const registrationInviteUrl = buildRegistrationInviteUrl(req, registrationInviteToken);
    res.send(renderAdminUsers({
      user: req.user, stats, indexStatus: getIndexStatus(),
      users: listUsers(), flash: String(req.query.flash || ''),
      adminCount: countAdminUsers(),
      registrationEnabled: getSetting('allow_registration') === '1',
      registrationInviteToken,
      recaptchaSiteKey: getSetting('recaptcha_site_key'),
      recaptchaSecretKey: decryptValue(getSetting('recaptcha_secret_key')),
      allowAnonymousBrowse: getSetting('allow_anonymous_browse') === '1',
      allowAnonymousDownload: getSetting('allow_anonymous_download') === '1',
      allowAnonymousOpds: getSetting('allow_anonymous_opds') === '1',
      passwordResetEnabled: isPasswordResetEnabled(),
      publicBaseUrl: getPublicBaseUrlSetting(),
      registrationInviteUrl,
      oidc: getOidcSettings(),
      csrfToken: req.csrfToken || ''
    }));
  });

  app.post('/admin/settings/oidc', requireAdminWeb, (req, res) => {
    try {
      const last = (v) => Array.isArray(v) ? v[v.length - 1] : v;
      const secretRaw = String(last(req.body.clientSecret) || '');
      setOidcSettings({
        enabled: isFormFlagEnabled(req.body.enabled),
        issuer: String(last(req.body.issuer) || ''),
        clientId: String(last(req.body.clientId) || ''),
        ...(secretRaw ? { clientSecret: secretRaw } : {}),
        redirectUri: String(last(req.body.redirectUri) || ''),
        scopes: String(last(req.body.scopes) || 'openid profile email'),
        adminClaim: String(last(req.body.adminClaim) || ''),
        adminValue: String(last(req.body.adminValue) || ''),
        usernameClaim: String(last(req.body.usernameClaim) || ''),
        blockLocalRegister: isFormFlagEnabled(req.body.blockLocalRegister),
        requireEmailVerified: isFormFlagEnabled(req.body.requireEmailVerified)
      });
      clearOidcDiscoveryCache();
      logSystemEvent('info', 'admin', 'oidc settings updated', { actor: req.user.username });
      res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.oidc.saved')));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
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

  app.post('/admin/settings/password-reset', requireAdminWeb, (req, res) => {
    try {
      const last = (v) => Array.isArray(v) ? v[v.length - 1] : v;
      const enabled = last(req.body.enabled) === '1';
      const publicBaseUrl = String(req.body.publicBaseUrl || '').trim().replace(/\/+$/, '');
      setPasswordResetSettings({ enabled, publicBaseUrl });
      logSystemEvent('info', 'admin', enabled ? 'password reset enabled' : 'password reset disabled', { admin: req.user.username });
      res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.smtp.passwordResetSaved')));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.get('/admin/appearance', requireAdminWeb, (req, res) => {
    res.send(renderAdminAppearance({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      ui: getUiCustomization(),
      siteName: getSetting('site_name') || '',
      homeSubtitle: getSetting('home_subtitle') || '',
      homeNewestCount: getSetting('home_newest_count') || '',
      homeNewestCountDefault: config.homeNewestCount,
      flash: String(req.query.flash || ''),
      csrfToken: req.csrfToken || ''
    }));
  });

  app.post('/admin/settings/ui', requireAdminWeb, async (req, res) => {
    try {
      const name = String(req.body.siteName || '').trim();
      setSetting('site_name', name);
      setSiteName(name);
      const subtitle = String(req.body.homeSubtitle ?? '').trim();
      setSetting('home_subtitle', subtitle);
      const rawHomeNewestCount = String(req.body.homeNewestCount ?? '').trim();
      if (!rawHomeNewestCount) {
        setSetting('home_newest_count', '');
      } else {
        const homeNewestCount = Math.max(1, Math.min(200, Math.floor(Number(rawHomeNewestCount) || config.homeNewestCount)));
        setSetting('home_newest_count', String(homeNewestCount));
      }
      const dynamicThemeFromBg = isFormFlagEnabled(req.body.dynamicThemeFromBg);
      if (dynamicThemeFromBg) {
        await refreshBgThemePaletteFromFile();
      }
      saveUiSettings({
        bgBlur: lastFormFieldValue(req.body.bgBlur),
        bgOverlay: lastFormFieldValue(req.body.bgOverlay),
        surfaceOpacity: lastFormFieldValue(req.body.surfaceOpacity),
        surfaceBlur: lastFormFieldValue(req.body.surfaceBlur),
        dynamicThemeFromBg,
        glassColorDark: lastFormFieldValue(req.body.glassColorDark),
        glassColorLight: lastFormFieldValue(req.body.glassColorLight),
        glassTextDark: lastFormFieldValue(req.body.glassTextDark),
        glassTextLight: lastFormFieldValue(req.body.glassTextLight),
        glassTextAutoDark: isFormFlagEnabled(req.body.glassTextAutoDark),
        glassTextAutoLight: isFormFlagEnabled(req.body.glassTextAutoLight),
        glassMutedDark: lastFormFieldValue(req.body.glassMutedDark),
        glassMutedLight: lastFormFieldValue(req.body.glassMutedLight),
        glassMutedAutoDark: isFormFlagEnabled(req.body.glassMutedAutoDark),
        glassMutedAutoLight: isFormFlagEnabled(req.body.glassMutedAutoLight),
        glassLinkDark: lastFormFieldValue(req.body.glassLinkDark),
        glassLinkLight: lastFormFieldValue(req.body.glassLinkLight),
        glassLinkAutoDark: isFormFlagEnabled(req.body.glassLinkAutoDark),
        glassLinkAutoLight: isFormFlagEnabled(req.body.glassLinkAutoLight),
        accentDark: lastFormFieldValue(req.body.accentDark),
        accentLight: lastFormFieldValue(req.body.accentLight),
        accentAutoDark: isFormFlagEnabled(req.body.accentAutoDark),
        accentAutoLight: isFormFlagEnabled(req.body.accentAutoLight),
        overlayColorDark: lastFormFieldValue(req.body.overlayColorDark),
        overlayColorLight: lastFormFieldValue(req.body.overlayColorLight),
        overlayColorAutoDark: isFormFlagEnabled(req.body.overlayColorAutoDark),
        overlayColorAutoLight: isFormFlagEnabled(req.body.overlayColorAutoLight),
        bgSize: lastFormFieldValue(req.body.bgSize),
        bgPosition: lastFormFieldValue(req.body.bgPosition),
        showLogoOnLogin: isFormFlagEnabled(req.body.showLogoOnLogin),
      });
      saveUiShapeSettings({
        radiusPreset: lastFormFieldValue(req.body.radiusPreset),
        radiusScale: lastFormFieldValue(req.body.radiusScale),
        shadowPreset: lastFormFieldValue(req.body.shadowPreset),
      });
      saveUiTypographySettings({
        fontSize: lastFormFieldValue(req.body.fontSize),
        headingScale: lastFormFieldValue(req.body.headingScale),
        density: lastFormFieldValue(req.body.density),
        fontFamily: lastFormFieldValue(req.body.fontFamily),
      });
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui appearance settings updated', {
        actor: req.user.username,
        siteName: name || '(default)',
        homeSubtitle: subtitle || '(default)',
      });
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(t('admin.ui.flashSaved')));
    } catch (error) {
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
  });

  app.post('/admin/settings/ui/remove', requireAdminWeb, (req, res) => {
    try {
      const asset = String(req.body.asset || '').trim();
      removeUiAsset(asset);
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui asset removed', { actor: req.user.username, asset });
      if (asset === 'logo') {
        void syncTelegramBotProfilePhoto({ force: true }).catch((err) => {
          logSystemEvent('warn', 'telegram-bot', 'аватар бота не сброшен после удаления логотипа', { error: err.message });
        });
      }
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(t('admin.ui.flashRemoved')));
    } catch (error) {
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
  });

  app.post('/admin/settings/ui/reset/sliders', requireAdminWeb, (req, res) => {
    try {
      resetUiThemeSliders();
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui theme sliders reset', { actor: req.user.username });
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(t('admin.ui.flashResetSliders')));
    } catch (error) {
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
  });

  app.post('/admin/settings/ui/reset/colors', requireAdminWeb, (req, res) => {
    try {
      resetUiThemeColors();
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui theme colors reset', { actor: req.user.username });
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(t('admin.ui.flashResetColors')));
    } catch (error) {
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
  });

  app.post('/admin/settings/ui/reset/shape', requireAdminWeb, (req, res) => {
    try {
      resetUiThemeShape();
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui theme shape reset', { actor: req.user.username });
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(t('admin.ui.flashResetShape')));
    } catch (error) {
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
  });

  app.post('/admin/settings/ui/refresh-bg-palette', requireAdminWeb, async (req, res) => {
    try {
      await refreshBgThemePaletteForAdmin();
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui background palette refreshed', { actor: req.user.username });
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(t('admin.ui.flashBgPaletteRefreshed')));
    } catch (error) {
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
  });

  app.post('/admin/settings/ui/reset/typography', requireAdminWeb, (req, res) => {
    try {
      resetUiThemeTypography();
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui theme typography reset', { actor: req.user.username });
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(t('admin.ui.flashResetTypography')));
    } catch (error) {
      res.redirect('/admin/appearance?flash=' + encodeURIComponent(uiAdminFlashMessage(error)));
    }
  });

  app.post('/api/admin/ui/upload', requireAdminApi, parseUiUploadBody, async (req, res) => {
    const asset = String(req.query.asset || req.headers['x-ui-asset'] || '').trim();
    try {
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      const originalName = readUiAssetOriginalName(req.headers['x-ui-asset-name'] || req.query.name);
      await saveUiAsset(asset, buffer, { originalName });
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui asset uploaded', { actor: req.user.username, asset, size: buffer.length });
      if (asset === 'logo') {
        void syncTelegramBotProfilePhoto({ force: true }).catch((err) => {
          logSystemEvent('warn', 'telegram-bot', 'аватар бота не обновлён после загрузки логотипа', { error: err.message });
        });
      }
      res.json({ ok: true, ui: getPublicUiSettingsJson(), appearance: getUiAppearanceFormState() });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, uiAdminFlashMessage(error));
    }
  });

  app.post('/api/admin/ui/remove', requireAdminApi, (req, res) => {
    const asset = String(req.body?.asset || '').trim();
    try {
      removeUiAsset(asset);
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui asset removed', { actor: req.user.username, asset });
      if (asset === 'logo') {
        void syncTelegramBotProfilePhoto({ force: true }).catch((err) => {
          logSystemEvent('warn', 'telegram-bot', 'аватар бота не сброшен после удаления логотипа', { error: err.message });
        });
      }
      res.json({ ok: true, ui: getPublicUiSettingsJson(), appearance: getUiAppearanceFormState() });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, uiAdminFlashMessage(error));
    }
  });

  app.post('/api/admin/ui/refresh-bg-palette', requireAdminApi, async (req, res) => {
    try {
      await refreshBgThemePaletteForAdmin();
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'ui background palette refreshed', { actor: req.user.username });
      res.json({ ok: true, state: getUiAppearanceFormState() });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, uiAdminFlashMessage(error));
    }
  });

  app.post('/api/admin/ui/preview', requireAdminApi, (req, res) => {
    try {
      const preview = getThemePreviewFromDraft(req.body || {});
      res.json({ ok: true, ...preview });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, uiAdminFlashMessage(error));
    }
  });

  const UI_APPEARANCE_RESET = {
    sliders: { fn: resetUiThemeSliders, log: 'ui theme sliders reset', flash: 'admin.ui.flashResetSliders' },
    colors: { fn: resetUiThemeColors, log: 'ui theme colors reset', flash: 'admin.ui.flashResetColors' },
    shape: { fn: resetUiThemeShape, log: 'ui theme shape reset', flash: 'admin.ui.flashResetShape' },
    typography: { fn: resetUiThemeTypography, log: 'ui theme typography reset', flash: 'admin.ui.flashResetTypography' },
  };

  app.post('/api/admin/ui/reset/:section', requireAdminApi, (req, res) => {
    const spec = UI_APPEARANCE_RESET[String(req.params.section || '')];
    if (!spec) return apiFail(res, 404, ApiErrorCode.NOT_FOUND, 'Not found');
    try {
      spec.fn();
      clearPageDataCache();
      logSystemEvent('info', 'settings', spec.log, { actor: req.user.username });
      res.json({ ok: true, state: getUiAppearanceFormState() });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, uiAdminFlashMessage(error));
    }
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

  app.get('/admin/telegram', requireAdminWeb, (req, res) => {
    res.send(renderAdminTelegram({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      tg: getTelegramSettings(), botRunning: isTelegramBotRunning(),
      flash: String(req.query.flash || ''), csrfToken: req.csrfToken || ''
    }));
  });

  async function handleTelegramTestAnnounce(req, res) {
    const rawToken = String(req.body.token ?? '').trim();
    const newBooksAnnounceTemplate = normalizeNewBooksAnnounceTemplate(
      String(req.body.newBooksAnnounceTemplate ?? '').trim()
    );
    const newBooksAnnounceTestCount = Math.max(1, Math.min(99_999, Math.floor(Number(req.body.newBooksAnnounceTestCount) || 3)));
    const token = resolveTelegramTokenForAdmin(rawToken);

    if (!token) {
      return res.redirect('/admin/telegram?flash=' + encodeURIComponent(t('admin.telegram.flashNoToken')));
    }
    const templateCheck = validateNewBooksAnnounceTemplate(newBooksAnnounceTemplate);
    if (!templateCheck.ok) {
      return res.redirect('/admin/telegram?flash=' + encodeURIComponent(templateCheck.warnings.join(' · ')));
    }
    try {
      const result = await testAnnounceNewBooksInTelegram({
        count: newBooksAnnounceTestCount,
        template: newBooksAnnounceTemplate,
        token,
      });
      if (result.reason === 'no_chats') {
        return res.redirect('/admin/telegram?flash=' + encodeURIComponent(t('admin.telegram.flashTestAnnounceNoChats')));
      }
      if (result.skipped && result.reason === 'no_token') {
        return res.redirect('/admin/telegram?flash=' + encodeURIComponent(t('admin.telegram.flashNoToken')));
      }
      if (!result.sent) {
        const apiErr = result.errors?.[0]?.description;
        const flash = apiErr
          ? tp('admin.telegram.flashTestAnnounceErr', { message: apiErr })
          : t('admin.telegram.flashTestAnnounceFailed');
        return res.redirect('/admin/telegram?flash=' + encodeURIComponent(flash));
      }
      return res.redirect('/admin/telegram?flash=' + encodeURIComponent(
        tp('admin.telegram.flashTestAnnounceOk', { sent: result.sent, total: result.totalChats })
      ));
    } catch (err) {
      return res.redirect('/admin/telegram?flash=' + encodeURIComponent(
        tp('admin.telegram.flashTestAnnounceErr', { message: err.message })
      ));
    }
  }

  app.post('/admin/telegram/test-announce', requireAdminWeb, handleTelegramTestAnnounce);

  app.post('/admin/telegram', requireAdminWeb, async (req, res) => {
    const rawToken = String(req.body.token ?? '').trim();
    const allowedUsers = String(req.body.allowedUsers ?? '').trim();
    const accessMode = String(req.body.accessMode ?? '').trim();
    const welcomeMessage = String(req.body.welcomeMessage ?? '').trim().slice(0, 4096);
    const profileDescription = String(req.body.profileDescription ?? '').trim().slice(0, 512);
    const profileShortDescription = String(req.body.profileShortDescription ?? '').trim().slice(0, 120);
    const newBooksAnnounceTemplate = String(req.body.newBooksAnnounceTemplate ?? '').trim().slice(0, 4096);
    const enabled = req.body.enabled === '1';
    const newBooksAnnounceEnabled = req.body.newBooksAnnounceEnabled === '1';
    const isTest = req.body.test === '1';

    const token = resolveTelegramTokenForAdmin(rawToken);

    if (isTest) {
      if (!token) {
        return res.redirect('/admin/telegram?flash=' + encodeURIComponent(t('admin.telegram.flashNoToken')));
      }
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = await resp.json();
        if (!data.ok) throw new Error(data.description || 'Telegram API error');
        const username = data.result?.username ?? '?';
        return res.redirect('/admin/telegram?flash=' + encodeURIComponent(tp('admin.telegram.flashTestOk', { username })));
      } catch (err) {
        return res.redirect('/admin/telegram?flash=' + encodeURIComponent(tp('admin.telegram.flashTestErr', { message: err.message })));
      }
    }

    setTelegramSettings({
      ...(rawToken ? { token: rawToken } : {}),
      allowedUsers,
      accessMode,
      welcomeMessage,
      profileDescription,
      profileShortDescription,
      newBooksAnnounceEnabled,
      newBooksAnnounceTemplate: normalizeNewBooksAnnounceTemplate(newBooksAnnounceTemplate),
      enabled,
    });
    syncTelegramChatsFromLinkedUsers();
    restartTelegramBot().catch((err) => {
      logSystemEvent('warn', 'telegram-bot', 'ошибка перезапуска из админки', { error: err.message });
    });
    res.redirect('/admin/telegram?flash=' + encodeURIComponent(t('admin.telegram.flashSaved')));
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
      /* Язык интерфейса по умолчанию для гостей без Accept-Language / lang-cookie.
         Принимает 'ru' | 'en' | 'auto'. Применяется в i18n.resolveLocale —
         критично для OPDS-клиентов вроде KOReader, которые не шлют Accept-Language. */
      const localeRaw = String(req.body.defaultLocale || '').toLowerCase().trim();
      const locale = (localeRaw === 'ru' || localeRaw === 'en') ? localeRaw : 'auto';
      setSetting('default_locale', locale);
      setDefaultLocale(locale);
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'default locale updated', { actor: req.user.username, defaultLocale: locale });
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
      scanSchedule: getScheduleConfig(),
      scanScheduleNextRunAt: getNextRunAt(),
      scanScheduleLog: getScheduleLog(10),
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

  app.post('/admin/sources/:id/update', requireAdminWeb, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const name = req.body.name !== undefined ? String(req.body.name).trim() : undefined;
      const enabled = req.body.enabled !== undefined ? req.body.enabled === '1' : undefined;
      updateSource(id, { name, enabled });
      if (enabled !== undefined) {
        await refreshCatalogBookCounts();
      }
      clearArchiveReadCaches();
      clearPageDataCache();
      markLibraryDedupProjectionStale();
      logSystemEvent('info', 'settings', 'source updated', { actor: req.user.username, sourceId: id });
      res.redirect('/admin/sources?flash=' + encodeURIComponent(t('admin.sources.flashUpdated')));
    } catch (error) {
      res.redirect('/admin/sources?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/api/admin/sources/:id/edit', requireAdminApi, (req, res) => {
    try {
      const id = Number(req.params.id);
      const name = req.body.name !== undefined ? String(req.body.name).trim() : undefined;
      const sourcePath = req.body.path !== undefined ? String(req.body.path).trim() : undefined;
      if (name === '' || sourcePath === '') {
        return apiFail(res, 400, ApiErrorCode.PROBE_PATH_REQUIRED, t('admin.probe.pathRequired'));
      }
      if (sourcePath) {
        const resolvedPath = path.resolve(sourcePath);
        if (!fs.existsSync(resolvedPath)) {
          return res.status(400).json({ ok: false, error: t('admin.probe.pathMissing') });
        }
      }
      const source = updateSource(id, { name, path: sourcePath });
      clearArchiveReadCaches();
      clearPageDataCache();
      logSystemEvent('info', 'settings', 'source edited', { actor: req.user?.username || 'admin', sourceId: id });
      res.json({ ok: true, source });
    } catch (error) {
      return apiFail(res, 500, ApiErrorCode.INTERNAL, translateKnownErrorMessage(error.message));
    }
  });

  app.get('/api/admin/sources/:id/check-path', requireAdminApi, (req, res) => {
    try {
      const id = Number(req.params.id);
      const source = getSourceById(id);
      if (!source) {
        return apiFail(res, 404, ApiErrorCode.ADMIN_SOURCE_NOT_FOUND, t('admin.sources.notFound'));
      }
      const resolvedPath = path.resolve(source.path);
      let exists = false;
      let isDirectory = false;
      let isFile = false;
      let fileCount = 0;
      try {
        if (fs.existsSync(resolvedPath)) {
          const stat = fs.statSync(resolvedPath);
          exists = true;
          isDirectory = stat.isDirectory();
          isFile = stat.isFile();
          if (isDirectory) {
            fileCount = fs.readdirSync(resolvedPath).length;
          }
        }
      } catch {
        /* ignore */
      }
      res.json({ ok: true, exists, isDirectory, isFile, fileCount, path: resolvedPath });
    } catch (error) {
      return apiFail(res, 500, ApiErrorCode.INTERNAL, translateKnownErrorMessage(error.message));
    }
  });

  app.post('/api/admin/sources/:id/delete', requireAdminApi, async (req, res) => {
    const id = Number(req.params.id);
    try {
      const status = getIndexStatus();
      if (status.active) {
        return res.status(409).json({ ok: false, error: t('admin.sources.deleteBlockedDuringIndexing') });
      }
      if (operationsState.sidecarRunning) {
        return res.status(409).json({ ok: false, error: 'Sidecar rebuild is in progress' });
      }
      if (operationsState.dupCleanRunning) {
        return res.status(409).json({ ok: false, error: t('admin.duplicates.autoCleanInProgress') });
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
        clearArchiveReadCaches();
        invalidateDuplicatesCache();
        invalidateAllRecommendations();
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
      if (operationsState.sidecarRunning) {
        return res.redirect('/admin/sources?flash=' + encodeURIComponent('Sidecar rebuild is in progress'));
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
      const username = readAdminAccountUsername(req.body);
      const password = String(req.body.newPassword || req.body.password || '');
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
      const username = readAdminAccountUsername(req.body);
      const password = readAdminUserField(req.body, username, 'newPassword') || String(req.body.password || '');
      const role = req.body.role === 'admin' ? 'admin' : 'user';
      if (!username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashUpdateMissing')));
      }
      const existing = getUserByUsername(username);
      if (!existing) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('validation.userNotFound')));
      }
      const rawTelegramId = readAdminUserField(req.body, username, 'accountTelegramId')
        || readAdminUserField(req.body, username, 'telegramId');
      const prevTelegramId = String(existing.telegramId ?? '').trim();
      const rawEreaderEmail = readAdminUserField(req.body, username, 'accountEreaderEmail')
        || readAdminUserField(req.body, username, 'ereaderEmail');
      if (rawEreaderEmail && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(rawEreaderEmail)) {
        throw new Error('Invalid email');
      }
      if (rawTelegramId !== prevTelegramId && rawTelegramId) {
        const normalizedTg = normalizeTelegramId(rawTelegramId);
        if (!normalizedTg) throw new Error('Invalid Telegram ID');
        const owner = getUserByTelegramId(normalizedTg);
        if (owner && owner.username !== username) {
          throw new Error('This Telegram account is already linked to another user');
        }
      }
      updateUser({ username, password, role });
      invalidateSessionUserCache(username);
      if (isAdminUserScopedFieldsReady(req.body, username)) {
        if (rawTelegramId !== prevTelegramId) {
          setUserTelegramId(username, rawTelegramId);
        }
        const prevEreaderEmail = String(getEreaderEmail(username) || '').trim();
        if (rawEreaderEmail !== prevEreaderEmail) {
          setUserEreaderEmail(username, rawEreaderEmail);
        }
      }
      setUserTelegramBotAllowed(username, isFormFlagEnabled(req.body.telegramBotAllowed));
      setUserEreaderEmailAllowed(username, isFormFlagEnabled(req.body.ereaderEmailAllowed));
      logSystemEvent('info', 'auth', 'user updated', {
        actor: req.user.username,
        username,
        role,
        passwordChanged: Boolean(password),
        telegramBotAllowed: isFormFlagEnabled(req.body.telegramBotAllowed),
        ereaderEmailAllowed: isFormFlagEnabled(req.body.ereaderEmailAllowed),
      });
      res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashUpdated', { username })));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/users/delete', requireAdminWeb, (req, res) => {
    try {
      const username = readAdminAccountUsername(req.body);
      if (!username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashDeleteMissing')));
      }
      if (username === req.user.username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashCannotDeleteSelf')));
      }
      deleteUser(username);
      invalidateSessionUserCache(username);
      logSystemEvent('info', 'auth', 'user deleted', { actor: req.user.username, username });
      res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashDeleted', { username })));
    } catch (error) {
      res.redirect('/admin/users?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/admin/users/block', requireAdminWeb, (req, res) => {
    try {
      const username = readAdminAccountUsername(req.body);
      const action = String(req.body.action || '');
      if (!username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashBlockMissing')));
      }
      if (username === req.user.username) {
        return res.redirect('/admin/users?flash=' + encodeURIComponent(t('admin.users.flashCannotBlockSelf')));
      }
      if (action === 'unblock') {
        unblockUser(username);
        invalidateSessionUserCache(username);
        logSystemEvent('info', 'admin', 'user unblocked', { actor: req.user.username, username });
        res.redirect('/admin/users?flash=' + encodeURIComponent(tp('admin.users.flashUnblocked', { username })));
      } else {
        blockUser(username);
        invalidateSessionUserCache(username);
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

  app.get('/api/operations/users-export', requireAdminApi, (req, res) => {
    const payload = exportUsersBackup();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    logSystemEvent('info', 'operations', 'users export', {
      user: req.user.username,
      count: payload.users.length
    });
    res.setHeader('Content-Disposition', `attachment; filename="inpx-users-${stamp}.json"`);
    res.type('application/json; charset=utf-8');
    res.send(`${JSON.stringify(payload, null, 2)}\n`);
  });

  app.post('/api/operations/users-import', requireAdminApi, (req, res) => {
    try {
      const summary = importUsersBackup(req.body);
      logSystemEvent('info', 'operations', 'users import', {
        user: req.user.username,
        created: summary.created,
        skipped: summary.skipped,
        favorites: summary.favorites,
        invalid: summary.invalid
      });
      res.json({ ok: true, ...summary });
    } catch (error) {
      if (error?.code === 'INVALID_BACKUP') {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('admin.update.importUsersInvalid'));
      }
      throw error;
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
    if (operationsState.dupCleanRunning) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, t('admin.duplicates.autoCleanInProgress'));
    }
    if (operationsState.sidecarRunning) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, 'Sidecar rebuild is in progress');
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
    if (operationsState.sourceDeleteRunning) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, t('admin.sources.deleteInProgress'));
    }
    if (operationsState.dupCleanRunning) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, t('admin.duplicates.autoCleanInProgress'));
    }
    if (getIndexStatus().active) {
      return apiFail(res, 409, ApiErrorCode.CONFLICT, 'Operation is blocked during indexing');
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
      } catch (error) {
        logSystemEvent('error', 'operations', 'sidecar rebuild failed', { error: error.message });
      } finally {
        operationsState.sidecarRunning = false;
        if (failures.length) {
          logSystemEvent('error', 'operations', 'sidecar rebuild completed with errors', { failures });
        } else {
          logSystemEvent('info', 'operations', 'sidecar rebuild completed', { count: sources.length });
        }
      }
    })().catch((error) => {
      // Absolute last-resort catch
      operationsState.sidecarRunning = false;
      console.error('[admin] sidecar rebuild unhandled:', error);
    });
  });

  app.post('/api/operations/repair', requireAdminApi, (req, res) => {
    const started = runRepairMetadata();
    res.json({ ok: started, started, operations: getOperationsSnapshot() });
  });

  app.post('/api/operations/fts-rebuild', requireAdminApi, (req, res) => {
    const indexStatus = getIndexStatus();
    if (operationsState.ftsRebuildRunning) {
      return res.status(409).json({
        ok: false,
        started: false,
        error: t('admin.ftsRebuildBusy'),
        operations: getOperationsSnapshot()
      });
    }
    if (operationsState.reindexRunning || indexStatus.active) {
      return res.status(409).json({
        ok: false,
        started: false,
        error: t('admin.ftsRebuildBlocked'),
        operations: getOperationsSnapshot()
      });
    }

    operationsState.ftsRebuildRunning = true;
    operationsState.lastFtsRebuildRequestedAt = new Date().toISOString();
    setMeta('books_fts_dirty', '1');
    invalidateBooksFtsHealthCache();
    logSystemEvent('info', 'operations', 'FTS rebuild requested', {
      user: req.user.username,
      requestedAt: operationsState.lastFtsRebuildRequestedAt
    });
    res.json({ ok: true, started: true, operations: getOperationsSnapshot() });

    setImmediate(async () => {
      const t0 = Date.now();
      try {
        await rebuildBooksFtsFromContent();
        setMeta('books_fts_dirty', '0');
        invalidateBooksFtsHealthCache();
        try {
          rebuildTitleTokenDictionary({ force: true });
        } catch (dictErr) {
          console.warn('[ops] title token dictionary rebuild failed:', dictErr.message);
        }
        const seconds = Math.round((Date.now() - t0) / 1000);
        console.log(`[ops] FTS rebuild completed (${seconds} s)`);
        logSystemEvent('info', 'operations', 'FTS rebuild completed', { seconds });
      } catch (err) {
        console.error('[ops] FTS rebuild failed:', err.message);
        logSystemEvent('error', 'operations', 'FTS rebuild failed', { error: err.message });
      } finally {
        operationsState.ftsRebuildRunning = false;
        invalidateBooksFtsHealthCache();
      }
    });
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
      // Under systemd the cgroup kills all children on exit, so spawning
      // server-control.js is pointless — just exit and let systemd restart.
      // Use exit code 1 so Restart=on-failure also triggers a restart.
      if (!process.env.INVOCATION_ID) {
        const child = spawn(process.execPath, [path.join(config.rootDir, 'scripts', 'server-control.js'), 'restart'], {
          cwd: config.rootDir, detached: true, stdio: 'ignore'
        });
        child.unref();
        gracefulExit();
      } else {
        gracefulExit(1);
      }
    }, 500);
  });

  // --- Update from ZIP --- (реализация — services/self-update.js)

  app.get('/api/operations/update-log', requireAdminApi, (req, res) => {
    try {
      res.json({ ok: true, log: readUpdateLog(), running: getUpdateState().running });
    } catch (error) {
      res.json({
        ok: false, code: ApiErrorCode.UPDATE_LOG_READ_ERROR,
        log: '', running: getUpdateState().running, error: error.message
      });
    }
  });

  /**
   * Форматируем ключи из self-update.js в локализованные сообщения.
   * Логика i18n остаётся в этом слое, сервис оперирует абстрактным «key + params».
   */
  const makeUpdateLogLine = (locale) => (key, params = {}) => {
    runWithLocaleLang(locale, () => {
      const fullKey = `update.log.${key}`;
      const line = Object.keys(params).length
        ? tp(fullKey, { ...params, unit: t('common.unitMB') })
        : t(fullKey);
      appendUpdateLog(line);
    });
  };

  /** Перезапуск после успешного обновления (общий для upload и update-apply). */
  const updateScheduleRestart = () => {
    if (!process.env.INVOCATION_ID) {
      const child = spawn(process.execPath, [path.join(config.rootDir, 'scripts', 'server-control.js'), 'restart'], {
        cwd: config.rootDir, detached: true, stdio: 'ignore'
      });
      child.unref();
      gracefulExit();
    } else {
      gracefulExit(1);
    }
  };

  app.post('/api/operations/update', requireAdminApi, express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
    const logLine = makeUpdateLogLine(resolveLocale(req));

    const prev = getUpdateState();
    const wasTimedOut = prev.running && isUpdateTimedOut();
    if (!beginUpdate()) {
      // Идёт активный апдейт, не истёкший по таймауту
      return apiFail(res, 409, ApiErrorCode.UPDATE_RUNNING, t('admin.update.running'));
    }
    if (wasTimedOut) logLine('timeoutReset');
    const zipBuffer = req.body;
    if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length < 100) {
      // Откатываем флаг, т. к. beginUpdate() его уже выставил
      endUpdate();
      return apiFail(res, 400, ApiErrorCode.UPDATE_BAD_ARCHIVE, t('admin.update.badArchive'));
    }
    logSystemEvent('info', 'operations', 'update started', { user: req.user.username, size: zipBuffer.length });
    res.json({ ok: true, message: t('admin.update.started') });

    void runUpdateFromZip(zipBuffer, {
      log: logLine,
      sysLog: (msg, meta = {}) => logSystemEvent('info', 'operations', msg, { ...meta, user: req.user.username }),
      sysLogError: (msg, meta = {}) => logSystemEvent('error', 'operations', msg, { ...meta, user: req.user.username }),
      username: req.user.username,
      scheduleRestart: updateScheduleRestart
    });
  });

  // --- Проверка новой версии на GitHub + установка в один клик ---

  app.get('/api/operations/update-check', requireAdminApi, async (req, res) => {
    try {
      const result = await checkForUpdate({ force: req.query.force === '1' });
      res.json({ ok: true, ...result });
    } catch (error) {
      apiFail(res, 502, ApiErrorCode.UPDATE_CHECK_FAILED, `${t('admin.update.checkFail')}: ${error.message}`);
    }
  });

  app.post('/api/operations/update-apply', requireAdminApi, async (req, res) => {
    let check;
    try {
      check = await checkForUpdate({ force: true });
    } catch (error) {
      return apiFail(res, 502, ApiErrorCode.UPDATE_CHECK_FAILED, `${t('admin.update.checkFail')}: ${error.message}`);
    }
    if (!check.updateAvailable || !check.assetUrl) {
      return apiFail(res, 409, ApiErrorCode.UPDATE_CHECK_FAILED, t('admin.update.noUpdate'));
    }
    const prev = getUpdateState();
    const wasTimedOut = prev.running && isUpdateTimedOut();
    if (!beginUpdate()) {
      return apiFail(res, 409, ApiErrorCode.UPDATE_RUNNING, t('admin.update.running'));
    }
    const logLine = makeUpdateLogLine(resolveLocale(req));
    if (wasTimedOut) logLine('timeoutReset');
    const username = req.user.username;
    logSystemEvent('info', 'operations', 'update-apply started', { user: username, version: check.latestVersion });
    res.json({ ok: true, message: t('admin.update.started'), version: check.latestVersion });

    setImmediate(async () => {
      let zipBuffer;
      try {
        logLine('downloadStart', { name: check.assetName });
        zipBuffer = await downloadUpdateAsset(check.assetUrl);
        logLine('downloadDone', { size: (zipBuffer.length / 1024 / 1024).toFixed(1) });
      } catch (error) {
        logLine('downloadFail', { message: error.message });
        appendUpdateLog('[update:done] error');
        logSystemEvent('error', 'operations', 'update download failed', { user: username, error: error.message });
        endUpdate();
        return;
      }
      void runUpdateFromZip(zipBuffer, {
        log: logLine,
        sysLog: (msg, meta = {}) => logSystemEvent('info', 'operations', msg, { ...meta, user: username }),
        sysLogError: (msg, meta = {}) => logSystemEvent('error', 'operations', msg, { ...meta, user: username }),
        username,
        scheduleRestart: updateScheduleRestart
      });
    });
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

  function serializeDupCleanProgress() {
    const running = Boolean(operationsState.dupCleanRunning);
    const p = operationsState.dupCleanProgress || {};
    const startedAt = Number(p.startedAt) || 0;
    return {
      running,
      stage: p.stage || (running ? 'prepare' : 'idle'),
      mode: p.mode === 'restore' ? 'restore' : 'clean',
      percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
      restored: Number(p.restored) || 0,
      deleted: Number(p.deleted) || 0,
      total: Number(p.total) || 0,
      groups: Number(p.groups) || 0,
      startedAt,
      elapsedMs: startedAt ? Math.max(0, Date.now() - startedAt) : 0,
      error: p.error || ''
    };
  }

  function dupCleanConflict(res) {
    if (!operationsState.dupCleanRunning) return false;
    res.status(409).json({
      ok: false,
      error: t('admin.duplicates.autoCleanInProgress'),
      cleanProgress: serializeDupCleanProgress()
    });
    return true;
  }

  app.get('/admin/duplicates', requireAdminWeb, (req, res) => {
    res.send(renderAdminDuplicates({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      flash: String(req.query.flash || ''), csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/api/admin/duplicates', requireAdminApi, (req, res) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const pageSize = 50;
    const filter = String(req.query.filter || '').trim();
    const cleanProgress = serializeDupCleanProgress();
    if (cleanProgress.running) {
      return res.json({
        ok: true, groups: [], total: 0, page, pageSize, filter,
        preview: { totalGroups: 0, totalBooks: 0, willDelete: 0 },
        cleanProgress
      });
    }
    const result = getDuplicateGroups({ page, pageSize, filter });
    const preview = previewAutoClean();
    res.json({ ok: true, groups: result.groups, total: result.total, page, pageSize, filter, preview, cleanProgress });
  });

  app.get('/api/admin/duplicates/auto-clean/progress', requireAdminApi, (req, res) => {
    res.json(serializeDupCleanProgress());
  });

  app.post('/api/admin/duplicates/delete', requireAdminApi, (req, res) => {
    // Запрещаем тяжёлые мутации по книгам, пока идёт индексация:
    // они конкурируют с индексатором за SQLite WAL и могут блокировать event-loop.
    if (getIndexStatus().active) {
      return res.status(409).json({ ok: false, error: t('admin.duplicates.blockedDuringIndexing') || 'Operation is blocked during indexing' });
    }
    if (dupCleanConflict(res)) return;
    const bookId = String(req.body.bookId || '').trim();
    if (!bookId) return res.status(400).json({ ok: false, error: 'Missing book ID' });
    try {
      const changes = softDeleteBook(bookId);
      if (changes) {
        invalidateDuplicatesCache();
        clearPageDataCache();
        logSystemEvent('info', 'operations', 'duplicate book soft-deleted', { actor: req.user.username, bookId });
      }
      res.json({ ok: true, message: changes ? t('admin.duplicates.flashDeleted') : t('admin.duplicates.flashNotFound') });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/admin/duplicates/auto-clean', requireAdminApi, async (req, res) => {
    if (getIndexStatus().active) {
      return res.status(409).json({ ok: false, error: t('admin.duplicates.blockedDuringIndexing') || 'Operation is blocked during indexing' });
    }
    if (operationsState.sourceDeleteRunning || operationsState.sidecarRunning) {
      return res.status(409).json({ ok: false, error: t('admin.duplicates.blockedDuringIndexing') });
    }
    if (operationsState.dupCleanRunning) {
      return res.json({ ok: true, started: true, alreadyRunning: true, cleanProgress: serializeDupCleanProgress() });
    }
    operationsState.dupCleanRunning = true;
    operationsState.dupCleanProgress = {
      stage: 'prepare', percent: 1, deleted: 0, total: 0, groups: 0,
      mode: 'clean', startedAt: Date.now(), error: ''
    };
    req.setTimeout(0);
    res.setTimeout(0);
    res.json({ ok: true, started: true, cleanProgress: serializeDupCleanProgress() });

    try {
      const result = await autoCleanDuplicates({
        onProgress(p) {
          operationsState.dupCleanProgress = { ...operationsState.dupCleanProgress, ...p, error: '' };
        }
      });
      operationsState.dupCleanProgress = {
        ...operationsState.dupCleanProgress,
        stage: 'done',
        percent: 100,
        deleted: result.totalDeleted,
        groups: result.groupsCleaned,
        error: ''
      };
      invalidateDuplicatesCache();
      clearPageDataCache();
      logSystemEvent('info', 'operations', 'auto-clean duplicates', {
        actor: req.user.username, groupsCleaned: result.groupsCleaned, totalDeleted: result.totalDeleted
      });
    } catch (error) {
      operationsState.dupCleanProgress = {
        ...operationsState.dupCleanProgress,
        stage: 'error',
        error: error.message || String(error)
      };
      logSystemEvent('error', 'operations', 'auto-clean duplicates failed', {
        actor: req.user.username, error: error.message
      });
    } finally {
      operationsState.dupCleanRunning = false;
    }
  });

  app.get('/api/admin/suppressed', requireAdminApi, (req, res) => {
    const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
    const filter = String(req.query.filter || '').trim();
    const cleanProgress = serializeDupCleanProgress();
    if (cleanProgress.running) {
      return res.json({ ok: true, total: 0, totalBooks: 0, rows: [], page, pageSize: 50, filter, cleanProgress });
    }
    const result = getSuppressedBooks({ page, pageSize: 50, filter });
    res.json({ ok: true, ...result, page, pageSize: 50, filter, cleanProgress });
  });

  app.post('/api/admin/duplicates/unsuppress', requireAdminApi, (req, res) => {
    if (getIndexStatus().active) {
      return res.status(409).json({ ok: false, error: t('admin.duplicates.blockedDuringIndexing') || 'Operation is blocked during indexing' });
    }
    if (dupCleanConflict(res)) return;
    const bookId = String(req.body.bookId || '').trim();
    if (!bookId) return res.status(400).json({ ok: false, error: 'Missing book ID' });
    try {
      const restored = unsuppressBook(bookId);
      if (restored) {
        invalidateDuplicatesCache();
        if (isBookInActiveView(bookId)) adjustCatalogCountsForBook(bookId, 1);
      }
      clearPageDataCache();
      logSystemEvent('info', 'operations', 'book unsuppressed', { actor: req.user.username, bookId });
      res.json({ ok: true, message: t('admin.duplicates.flashUnsuppressed') });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/admin/duplicates/unsuppress-all', requireAdminApi, async (req, res) => {
    if (getIndexStatus().active) {
      return res.status(409).json({ ok: false, error: t('admin.duplicates.blockedDuringIndexing') || 'Operation is blocked during indexing' });
    }
    if (operationsState.sourceDeleteRunning || operationsState.sidecarRunning) {
      return res.status(409).json({ ok: false, error: t('admin.duplicates.blockedDuringIndexing') });
    }
    if (operationsState.dupCleanRunning) {
      return res.json({ ok: true, started: true, alreadyRunning: true, cleanProgress: serializeDupCleanProgress() });
    }
    operationsState.dupCleanRunning = true;
    operationsState.dupCleanProgress = {
      mode: 'restore', stage: 'prepare', percent: 1, deleted: 0, restored: 0, total: 0, groups: 0,
      startedAt: Date.now(), error: ''
    };
    req.setTimeout(0);
    res.setTimeout(0);
    res.json({ ok: true, started: true, cleanProgress: serializeDupCleanProgress() });

    try {
      const count = await unsuppressAll({
        onProgress(p) {
          operationsState.dupCleanProgress = { ...operationsState.dupCleanProgress, ...p, mode: 'restore', error: '' };
        }
      });
      operationsState.dupCleanProgress = {
        ...operationsState.dupCleanProgress,
        mode: 'restore',
        stage: 'done',
        percent: 100,
        restored: count,
        deleted: count,
        groups: count,
        error: ''
      };
      invalidateDuplicatesCache();
      clearPageDataCache();
      logSystemEvent('info', 'operations', 'all books unsuppressed', { actor: req.user.username, count });
    } catch (error) {
      operationsState.dupCleanProgress = {
        ...operationsState.dupCleanProgress,
        mode: 'restore',
        stage: 'error',
        error: error.message || String(error)
      };
      logSystemEvent('error', 'operations', 'unsuppress-all failed', {
        actor: req.user.username, error: error.message
      });
    } finally {
      operationsState.dupCleanRunning = false;
    }
  });

  // --- Content management (languages + genres) ---

  app.get('/admin/languages', requireAdminWeb, (req, res) => res.redirect('/admin/content'));

  const CONTENT_LANG_GENRE_CACHE_TTL_MS = 60_000;

  app.get('/admin/content', requireAdminWeb, (req, res) => {
    const allLangs = getCachedPageData('admin:distinct-langs', () => getDistinctLanguages(), CONTENT_LANG_GENRE_CACHE_TTL_MS);
    const excludedLangs = getSetting('excluded_languages');
    const excludedLangSet = new Set(
      excludedLangs ? excludedLangs.split(',').map(s => s.trim()).filter(Boolean) : []
    );
    const allGenres = getCachedPageData('admin:distinct-genres', () => getDistinctGenres(), CONTENT_LANG_GENRE_CACHE_TTL_MS);
    const excludedGenres = getSetting('excluded_genres');
    const excludedGenreSet = new Set(
      excludedGenres ? excludedGenres.split(',').map(s => s.trim()).filter(Boolean) : []
    );
    const disabledDownloadFormats = getSetting('disabled_download_formats');
    const disabledDownloadFormatSet = new Set(
      disabledDownloadFormats ? disabledDownloadFormats.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : []
    );
    res.send(renderAdminContent({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      languages: allLangs, excludedLangSet,
      genres: allGenres, excludedGenreSet,
      disabledDownloadFormatSet,
      downloadFilenameStyle: normalizeDownloadFilenameStyle(getSetting('download_filename_style')),
      fb2WebpMode: normalizeFb2WebpMode(getSetting('fb2_webp_images')),
      showDeletedBooks: getSetting('show_deleted_books') === '1',
      flash: String(req.query.flash || ''), csrfToken: req.csrfToken || ''
    }));
  });

  app.post('/admin/content', requireAdminWeb, async (req, res) => {
    const allFmt = getConfiguredDownloadFormats();
    const rawFmt = req.body.enabled_download_format || [];
    const enabledFmt = new Set(Array.isArray(rawFmt) ? rawFmt : [rawFmt]);
    const disabledFmt = allFmt.filter(code => !enabledFmt.has(code));
    setSetting('disabled_download_formats', disabledFmt.join(','));
    setDisabledDownloadFormats(disabledFmt);
    const filenameStyle = normalizeDownloadFilenameStyle(req.body.download_filename_style);
    setSetting('download_filename_style', filenameStyle);
    setDownloadFilenameStyle(filenameStyle);
    const fb2WebpMode = normalizeFb2WebpMode(req.body.fb2_webp_images);
    setSetting('fb2_webp_images', fb2WebpMode);
    setFb2WebpMode(fb2WebpMode);

    // Пока идёт индексация, не трогаем excluded_* и не делаем DROP/CREATE VIEW:
    // SQLite может заблокировать или оставить active_books в полусогласованном состоянии.
    if (getIndexStatus().active) {
      clearPageDataCache();
      logSystemEvent('info', 'admin', 'download formats updated during indexing', {
        admin: req.user.username,
        disabledFormats: disabledFmt.join(','),
        downloadFilenameStyle: filenameStyle,
        fb2WebpMode
      });
      return res.redirect('/admin/content?flash=' + encodeURIComponent(
        t('admin.content.savedFormatsDuringIndexing')
      ));
    }
    // Сохраняем предыдущие значения, чтобы откатить, если rebuildActiveBooksView() упадёт.
    const prevExcludedLangs = getSetting('excluded_languages') || '';
    const prevExcludedGenres = getSetting('excluded_genres') || '';
    const prevShowDeleted = getSetting('show_deleted_books') || '0';
    let committed = false;
    try {
      // Languages
      const allLangs = getDistinctLanguages();
      const allLangCodes = allLangs.map(l => l.code);
      const rawLang = req.body.enabled_lang || [];
      const enabledLang = new Set(Array.isArray(rawLang) ? rawLang : [rawLang]);
      const excludedLang = allLangCodes.filter(code => !enabledLang.has(code));
      setSetting('excluded_languages', excludedLang.join(','));

      // Genres
      const allGenres = getDistinctGenres();
      const allGenreCodes = allGenres.map(g => g.code);
      const rawGenre = req.body.enabled_genre || [];
      const enabledGenre = new Set(Array.isArray(rawGenre) ? rawGenre : [rawGenre]);
      const excludedGenre = allGenreCodes.filter(code => !enabledGenre.has(code));
      setSetting('excluded_genres', excludedGenre.join(','));

      setSetting('show_deleted_books', req.body.show_deleted_books === '1' ? '1' : '0');

      await rebuildActiveBooksView();
      invalidateDuplicatesCache();
      committed = true;
      clearPageDataCache();
      logSystemEvent('info', 'admin', 'content filter updated', {
        admin: req.user.username,
        excludedLangs: excludedLang.join(','),
        excludedGenres: excludedGenre.join(','),
        showDeletedBooks: getSetting('show_deleted_books') === '1',
        disabledFormats: disabledFmt.join(','),
        downloadFilenameStyle: filenameStyle,
        fb2WebpMode
      });
      res.redirect('/admin/content?flash=' + encodeURIComponent(t('admin.content.saved')));
    } catch (error) {
      if (!committed) {
        // Откатываем настройки, чтобы UI и active_books снова совпали.
        try {
          setSetting('excluded_languages', prevExcludedLangs);
          setSetting('excluded_genres', prevExcludedGenres);
          setSetting('show_deleted_books', prevShowDeleted);
          // Попытка восстановить view из старых значений (best-effort).
          await rebuildActiveBooksView();
          invalidateDuplicatesCache();
        } catch (rollbackErr) {
          logSystemEvent('error', 'admin', 'content filter rollback failed', {
            admin: req.user.username, error: rollbackErr.message
          });
        }
      }
      logSystemEvent('error', 'admin', 'content filter update failed', {
        admin: req.user.username, error: error.message
      });
      res.redirect('/admin/content?flash=' + encodeURIComponent(error.message));
    }
  });
}
