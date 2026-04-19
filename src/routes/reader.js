import { t } from '../i18n.js';
import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import {
  getReadingPosition, setReadingPosition,
  getReaderBookmarks, addReaderBookmark, deleteReaderBookmark,
  upsertReadingHistoryEntry, deleteReadingHistoryEntry
} from '../db.js';
import { invalidateHomeUserSnapshot } from '../services/cache.js';

/**
 * Reader-related API routes: position tracking, bookmarks, reading history.
 */
export function registerReaderRoutes(app) {
  /* ── Reading position ──────────────────────────────────────────── */

  app.get('/api/books/:id/position', requireApiAuth, (req, res) => {
    const pos = getReadingPosition(req.user.username, req.params.id);
    res.json(pos || { position: '', progress: 0 });
  });

  app.post('/api/books/:id/position', requireApiAuth, (req, res) => {
    const { position, progress } = req.body;
    setReadingPosition(req.user.username, req.params.id, position, progress);
    res.json({ ok: true });
  });

  /* ── Reader bookmarks ──────────────────────────────────────────── */

  app.get('/api/books/:id/bookmarks', requireApiAuth, (req, res) => {
    res.json(getReaderBookmarks(req.user.username, req.params.id));
  });

  app.post('/api/books/:id/bookmarks', requireApiAuth, (req, res) => {
    const { position, title } = req.body;
    const id = addReaderBookmark(req.user.username, req.params.id, position, title);
    res.json({ ok: true, id: Number(id) });
  });

  app.delete('/api/books/:id/bookmarks/:bmId', requireApiAuth, (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderBookmark(bmId, req.user.username);
    res.json({ ok: true });
  });

  /* Legacy endpoint */
  app.delete('/api/reader-bookmarks/:bmId', requireApiAuth, (req, res) => {
    const bmId = Number(req.params.bmId);
    if (!Number.isInteger(bmId) || bmId < 1) {
      return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
    }
    deleteReaderBookmark(bmId, req.user.username);
    res.json({ ok: true });
  });

  /* ── Reading history ───────────────────────────────────────────── */

  app.post('/api/reading-history/:bookId', requireApiAuth, (req, res) => {
    const bookId = String(req.params.bookId || '');
    if (!bookId) {
      return apiFail(res, 400, ApiErrorCode.BOOK_INVALID_ID, t('api.book.invalidId'));
    }
    const lastOpenedAt = String(req.body?.lastOpenedAt || '').trim();
    const openCount = req.body?.openCount;
    upsertReadingHistoryEntry(req.user.username, bookId, lastOpenedAt, openCount);
    invalidateHomeUserSnapshot(req.user.username);
    res.json({ ok: true });
  });

  app.delete('/api/reading-history/:bookId', requireApiAuth, (req, res) => {
    deleteReadingHistoryEntry(req.user.username, String(req.params.bookId));
    invalidateHomeUserSnapshot(req.user.username);
    res.json({ ok: true });
  });
}
