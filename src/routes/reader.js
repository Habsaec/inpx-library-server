import {
  fractionToProgress,
  normalizeReadingFraction,
  progressToFraction,
  shouldIdleSteal,
} from '../../public/position-sync.js';
import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { t } from '../i18n.js';
import { asyncHandler } from '../utils/async-handler.js';
import { safePage } from '../utils/safe-int.js';
import {
  getReadingPosition, migrateReadingPositionToV4, setReadingPositionCas, setReadingPositionIdleSteal,
  getReaderBookmarks, addReaderBookmark, deleteReaderBookmark, updateReaderBookmarkTitle,
  getAllReaderBookmarksPage, getAllReaderAnnotationsPage,
  getReaderAnnotations, addReaderAnnotation, updateReaderAnnotation, deleteReaderAnnotation,
  upsertReadingHistoryEntry, deleteReadingHistoryEntry,
  getReaderBookSyncMeta, getUserReaderActivitySyncMeta, getReaderSyncIndex,
} from '../db.js';
import { invalidateUserPageCaches, clearPageDataCache } from '../services/cache.js';
import {
  isBookRead,
  getBookById,
  addReadBooksIfMissing,
  removeReadBookIfPresent,
} from '../inpx.js';

/** Файл с диска, не из каталога. Один и тот же sha256 на разных устройствах — один bookId. */
const LOCAL_READER_BOOK_ID = /^local:[a-f0-9]{64}$/;

function readerBookKnown(bookId) {
  return Boolean(getBookById(bookId)) || LOCAL_READER_BOOK_ID.test(String(bookId || ''));
}

/**
 * Reader-related API routes: position tracking, bookmarks, reading history.
 */
export function registerReaderRoutes(app) {
  /* ── Reading position ──────────────────────────────────────────── */

  app.get('/api/books/:id/position', requireApiAuth, asyncHandler(async (req, res) => {
    const username = req.user.username;
    const bookId = req.params.id;
    let pos = getReadingPosition(username, bookId);
    if (pos && pos.positionVersion < 4) {
      const ext = String(getBookById(bookId)?.ext || '').replace(/^\./, '').toLowerCase();
      pos = migrateReadingPositionToV4(username, bookId, {
        reset: ext === 'fb2' || ext === 'fbz',
      });
    }
    res.json(pos || {
      position: '',
      progress: 0,
      fraction: null,
      fb2Href: null,
      sectionIndex: null,
      sectionPageFraction: null,
      paginatorPage: null,
      paginatorPages: null,
      layoutMode: null,
      textOffset: null,
      textQuote: null,
      textSectionLength: null,
      updatedAt: null,
      positionVersion: 4,
      revision: 0,
      sessionId: null,
      lastUserActivityAt: null,
      sessionStatus: 'idle',
    });
  }));

  app.get('/api/books/:id/reader-sync-meta', requireApiAuth, asyncHandler(async (req, res) => {
    res.json(getReaderBookSyncMeta(req.user.username, req.params.id));
  }));

  app.get('/api/reader-activity-sync-meta', requireApiAuth, asyncHandler(async (req, res) => {
    res.json(getUserReaderActivitySyncMeta(req.user.username));
  }));

  /** Bulk dirty-check for silent background sync (activity + per-book revs). */
  app.get('/api/reader-sync-index', requireApiAuth, asyncHandler(async (req, res) => {
    const raw = req.query.ids;
    let ids = [];
    if (Array.isArray(raw)) {
      ids = raw.flatMap((v) => String(v || '').split(','));
    } else if (raw != null) {
      ids = String(raw).split(',');
    }
    res.json(getReaderSyncIndex(req.user.username, ids));
  }));

  app.post('/api/books/:id/position', requireApiAuth, asyncHandler(async (req, res) => {
    const {
      position,
      progress,
      fraction,
      fb2Href,
      sectionIndex,
      sectionPageFraction,
      paginatorPage,
      paginatorPages,
      layoutMode,
      textOffset,
      textQuote,
      textSectionLength,
      positionVersion,
      baseRevision,
      sessionId,
    } = req.body;
    const bookId = req.params.id;
    const username = req.user.username;
    const hasBaseRevision = Object.prototype.hasOwnProperty.call(req.body || {}, 'baseRevision');
    const normalizedBaseRevision = baseRevision === null ? 0 : baseRevision;
    if (
      positionVersion !== 4
      || !hasBaseRevision
      || !Number.isInteger(normalizedBaseRevision)
      || normalizedBaseRevision < 0
    ) {
      return apiFail(
        res,
        428,
        ApiErrorCode.POSITION_PROTOCOL_REQUIRED,
        t('api.position.protocolRequired'),
        { requiredPositionVersion: 4 },
      );
    }
    if (!readerBookKnown(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const hasExplicitFraction =
      fraction != null
      && !(typeof fraction === 'string' && fraction.trim() === '');
    const progressFromBody = Number.isFinite(Number(progress)) ? Math.max(0, Math.min(100, Number(progress))) : 0;
    const fractionNum =
      hasExplicitFraction && Number.isFinite(Number(fraction))
        ? normalizeReadingFraction(Number(fraction))
        : progressToFraction(progressFromBody);
    const progressNum = fractionToProgress(fractionNum);
    const posStr = String(position || '');
    const fb2HrefStr = fb2Href != null && String(fb2Href).trim() ? String(fb2Href).trim() : null;
    const nullableNonnegativeInteger = (value) =>
      value == null || value === ''
        ? null
        : (Number.isInteger(value) && value >= 0 ? value : undefined);
    const textOffsetValue = nullableNonnegativeInteger(textOffset);
    const textSectionLengthValue = nullableNonnegativeInteger(textSectionLength);
    const textQuoteValue = textQuote == null ? null : String(textQuote);
    if (
      textOffsetValue === undefined
      || textSectionLengthValue === undefined
      || (textQuoteValue != null && textQuoteValue.length > 256)
    ) {
      return apiFail(
        res,
        400,
        ApiErrorCode.VALIDATION,
        'Invalid text anchor',
      );
    }
    const finite = (value) => {
      if (value == null || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const anchors = {
      sectionIndex: finite(sectionIndex),
      sectionPageFraction: finite(sectionPageFraction),
      paginatorPage: finite(paginatorPage),
      paginatorPages: finite(paginatorPages),
      layoutMode: layoutMode != null ? String(layoutMode) : null,
      textOffset: textOffsetValue,
      textQuote: textQuoteValue,
      textSectionLength: textSectionLengthValue,
      sessionId,
    };
    let saved = setReadingPositionCas(
      username, bookId, normalizedBaseRevision, posStr, progressNum, fractionNum, fb2HrefStr, anchors,
    );
    if (!saved) {
      const current = getReadingPosition(username, bookId);
      if (shouldIdleSteal(current, sessionId)) {
        saved = setReadingPositionIdleSteal(
          username, bookId, current.sessionId, posStr, progressNum, fractionNum, fb2HrefStr, anchors,
        );
      }
    }
    if (!saved) {
      return apiFail(
        res,
        409,
        ApiErrorCode.POSITION_CONFLICT,
        t('api.position.conflict'),
        { current: getReadingPosition(username, bookId) },
      );
    }
    invalidateUserPageCaches(username);
    // Auto-mark as read when progress reaches 99%+
    let markedRead = false;
    let unmarkedRead = false;
    if (progressNum >= 99 && !isBookRead(username, bookId)) {
      addReadBooksIfMissing(username, [bookId]);
      markedRead = true;
    } else if (progressNum < 95 && isBookRead(username, bookId)) {
      // Starting the book again makes it an active read. Keep a small
      // hysteresis below the 99% completion threshold to avoid page-end jitter.
      unmarkedRead = removeReadBookIfPresent(username, bookId);
    }
    res.json({
      ok: true,
      markedRead,
      unmarkedRead,
      updatedAt: saved.updatedAt,
      positionVersion: saved.positionVersion,
      revision: saved.revision,
      textOffset: saved.textOffset,
      textQuote: saved.textQuote,
      textSectionLength: saved.textSectionLength,
    });
  }));

  /* ── Auto-mark as read when finished ────────────────────────── */

  app.post('/api/books/:id/mark-read', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = req.params.id;
    if (isBookRead(req.user.username, bookId)) {
      return res.json({ ok: true, already: true });
    }
    if (!readerBookKnown(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    addReadBooksIfMissing(req.user.username, [bookId]);
    res.json({ ok: true, marked: true });
  }));

  /* ── Reader bookmarks ──────────────────────────────────────────── */

  app.get('/api/reader-bookmarks', requireApiAuth, asyncHandler(async (req, res) => {
    const page = safePage(req.query.page);
    const pageSizeRaw = Number(req.query.pageSize);
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 && pageSizeRaw <= 500
      ? Math.floor(pageSizeRaw)
      : 100;
    const result = getAllReaderBookmarksPage(req.user.username, { page, pageSize });
    res.json(result);
  }));

  app.get('/api/books/:id/bookmarks', requireApiAuth, asyncHandler(async (req, res) => {
    res.json(getReaderBookmarks(req.user.username, req.params.id));
  }));

  app.post('/api/books/:id/bookmarks', requireApiAuth, asyncHandler(async (req, res) => {
    const position = String(req.body?.position ?? '');
    const title = String(req.body?.title ?? '');
    if (!position || position.length > 2000) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.bookmark.positionRequired'));
    }
    if (title.length > 500) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.bookmark.titleTooLong'));
    }
    if (!readerBookKnown(req.params.id)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const id = addReaderBookmark(req.user.username, req.params.id, position, title);
    res.json({ ok: true, id: Number(id) });
  }));

  app.delete('/api/books/:id/bookmarks/:bmId', requireApiAuth, asyncHandler(async (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderBookmark(bmId, req.user.username);
    res.json({ ok: true });
  }));

  app.patch('/api/books/:id/bookmarks/:bmId', requireApiAuth, asyncHandler(async (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    const title = String(req.body?.title ?? '');
    if (title.length > 500) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.bookmark.titleTooLong'));
    }
    if (!updateReaderBookmarkTitle(bmId, req.user.username, title)) {
      return apiFail(res, 404, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    res.json({ ok: true });
  }));

  /* Legacy endpoint */
  app.delete('/api/reader-bookmarks/:bmId', requireApiAuth, asyncHandler(async (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderBookmark(bmId, req.user.username);
    res.json({ ok: true });
  }));

  /* ── Reader annotations (выделения и заметки) ──────────────────── */

  const ANNOTATION_COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'underline']);

  app.get('/api/reader-annotations', requireApiAuth, asyncHandler(async (req, res) => {
    const page = safePage(req.query.page);
    const pageSizeRaw = Number(req.query.pageSize);
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 && pageSizeRaw <= 500
      ? Math.floor(pageSizeRaw)
      : 100;
    const result = getAllReaderAnnotationsPage(req.user.username, { page, pageSize });
    res.json(result);
  }));

  app.get('/api/books/:id/annotations', requireApiAuth, asyncHandler(async (req, res) => {
    res.json(getReaderAnnotations(req.user.username, req.params.id));
  }));

  app.post('/api/books/:id/annotations', requireApiAuth, asyncHandler(async (req, res) => {
    const cfi = String(req.body?.cfi ?? '');
    const text = String(req.body?.text ?? '');
    const note = String(req.body?.note ?? '');
    const color = String(req.body?.color ?? 'yellow');
    if (!cfi || cfi.length > 2000) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.cfiRequired'));
    }
    if (text.length > 8000 || note.length > 8000) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.textTooLong'));
    }
    if (!ANNOTATION_COLORS.has(color)) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.invalidColor'));
    }
    if (!readerBookKnown(req.params.id)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const id = addReaderAnnotation(req.user.username, req.params.id, cfi, text, note, color);
    res.json({ ok: true, id: Number(id) });
  }));

  app.patch('/api/books/:id/annotations/:aid', requireApiAuth, asyncHandler(async (req, res) => {
    const aid = Number(req.params.aid);
    if (!Number.isInteger(aid) || aid < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    const patch = {};
    if (req.body?.note !== undefined) {
      const note = String(req.body.note);
      if (note.length > 8000) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.textTooLong'));
      }
      patch.note = note;
    }
    if (req.body?.color !== undefined) {
      const color = String(req.body.color);
      if (!ANNOTATION_COLORS.has(color)) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.annotation.invalidColor'));
      }
      patch.color = color;
    }
    updateReaderAnnotation(aid, req.user.username, patch);
    res.json({ ok: true });
  }));

  app.delete('/api/books/:id/annotations/:aid', requireApiAuth, asyncHandler(async (req, res) => {
    const aid = Number(req.params.aid);
    if (!Number.isInteger(aid) || aid < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderAnnotation(aid, req.user.username);
    res.json({ ok: true });
  }));

  /* ── Reading history ───────────────────────────────────────────── */

  app.post('/api/reading-history/:bookId', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId || '');
    if (!bookId) {
      return apiFail(res, 400, ApiErrorCode.BOOK_INVALID_ID, t('api.book.invalidId'));
    }
    if (!readerBookKnown(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const lastOpenedAt = String(req.body?.lastOpenedAt || '').trim();
    const openCountRaw = req.body?.openCount;
    const openCount = Number.isFinite(Number(openCountRaw)) ? Math.max(0, Math.floor(Number(openCountRaw))) : undefined;
    upsertReadingHistoryEntry(req.user.username, bookId, lastOpenedAt, openCount);
    invalidateUserPageCaches(req.user.username);
    res.json({ ok: true });
  }));

  app.delete('/api/reading-history/:bookId', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId || '');
    if (!bookId) {
      return apiFail(res, 400, ApiErrorCode.BOOK_INVALID_ID, t('api.book.invalidId'));
    }
    const deleted = deleteReadingHistoryEntry(req.user.username, bookId);
    if (!deleted) {
      return apiFail(res, 404, ApiErrorCode.NOT_FOUND, t('app.removeReadingFail'));
    }
    invalidateUserPageCaches(req.user.username);
    clearPageDataCache();
    res.json({ ok: true });
  }));
}
