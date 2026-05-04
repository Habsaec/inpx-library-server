import { t } from '../i18n.js';
import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { asyncHandler } from '../utils/async-handler.js';
import {
  getReadingPosition, setReadingPosition,
  getReaderBookmarks, addReaderBookmark, deleteReaderBookmark,
  upsertReadingHistoryEntry, deleteReadingHistoryEntry
} from '../db.js';
import { invalidateHomeUserSnapshot } from '../services/cache.js';
import { isBookRead, getBookById, addReadBooksIfMissing } from '../inpx.js';

/**
 * Reader-related API routes: position tracking, bookmarks, reading history.
 */
export function registerReaderRoutes(app) {
  /* ── Reading position ──────────────────────────────────────────── */

  app.get('/api/books/:id/position', requireApiAuth, asyncHandler(async (req, res) => {
    const pos = getReadingPosition(req.user.username, req.params.id);
    res.json(pos || { position: '', progress: 0 });
  }));

  app.post('/api/books/:id/position', requireApiAuth, asyncHandler(async (req, res) => {
    const { position, progress } = req.body;
    const bookId = req.params.id;
    const username = req.user.username;
    if (!getBookById(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    setReadingPosition(username, bookId, position, progress);
    // Auto-mark as read when progress reaches 95%+
    let markedRead = false;
    if (Number(progress) >= 99 && !isBookRead(username, bookId)) {
      addReadBooksIfMissing(username, [bookId]);
      markedRead = true;
    }
    res.json({ ok: true, markedRead });
  }));

  /* ── Auto-mark as read when finished ────────────────────────── */

  app.post('/api/books/:id/mark-read', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = req.params.id;
    if (isBookRead(req.user.username, bookId)) {
      return res.json({ ok: true, already: true });
    }
    if (!getBookById(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    addReadBooksIfMissing(req.user.username, [bookId]);
    res.json({ ok: true, marked: true });
  }));

  /* ── Reader bookmarks ──────────────────────────────────────────── */

  app.get('/api/books/:id/bookmarks', requireApiAuth, asyncHandler(async (req, res) => {
    res.json(getReaderBookmarks(req.user.username, req.params.id));
  }));

  app.post('/api/books/:id/bookmarks', requireApiAuth, asyncHandler(async (req, res) => {
    const { position, title } = req.body;
    if (!getBookById(req.params.id)) {
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

  /* Legacy endpoint */
  app.delete('/api/reader-bookmarks/:bmId', requireApiAuth, asyncHandler(async (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderBookmark(bmId, req.user.username);
    res.json({ ok: true });
  }));

  /* ── Reading history ───────────────────────────────────────────── */

  app.post('/api/reading-history/:bookId', requireApiAuth, asyncHandler(async (req, res) => {
    const bookId = String(req.params.bookId || '');
    if (!bookId) {
      return apiFail(res, 400, ApiErrorCode.BOOK_INVALID_ID, t('api.book.invalidId'));
    }
    if (!getBookById(bookId)) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const lastOpenedAt = String(req.body?.lastOpenedAt || '').trim();
    const openCount = req.body?.openCount;
    upsertReadingHistoryEntry(req.user.username, bookId, lastOpenedAt, openCount);
    invalidateHomeUserSnapshot(req.user.username);
    res.json({ ok: true });
  }));

  app.delete('/api/reading-history/:bookId', requireApiAuth, asyncHandler(async (req, res) => {
    deleteReadingHistoryEntry(req.user.username, String(req.params.bookId));
    invalidateHomeUserSnapshot(req.user.username);
    res.json({ ok: true });
  }));
}
