import { t } from '../i18n.js';
import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
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

  app.get('/api/books/:id/position', requireApiAuth, (req, res) => {
    try {
      const pos = getReadingPosition(req.user.username, req.params.id);
      res.json(pos || { position: '', progress: 0 });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/books/:id/position', requireApiAuth, (req, res) => {
    try {
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
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /* ── Auto-mark as read when finished ────────────────────────── */

  app.post('/api/books/:id/mark-read', requireApiAuth, (req, res) => {
    try {
      const bookId = req.params.id;
      if (isBookRead(req.user.username, bookId)) {
        return res.json({ ok: true, already: true });
      }
      if (!getBookById(bookId)) {
        return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      }
      addReadBooksIfMissing(req.user.username, [bookId]);
      res.json({ ok: true, marked: true });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /* ── Reader bookmarks ──────────────────────────────────────────── */

  app.get('/api/books/:id/bookmarks', requireApiAuth, (req, res) => {
    try {
      res.json(getReaderBookmarks(req.user.username, req.params.id));
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.post('/api/books/:id/bookmarks', requireApiAuth, (req, res) => {
    try {
      const { position, title } = req.body;
      if (!getBookById(req.params.id)) {
        return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      }
      const id = addReaderBookmark(req.user.username, req.params.id, position, title);
      res.json({ ok: true, id: Number(id) });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.delete('/api/books/:id/bookmarks/:bmId', requireApiAuth, (req, res) => {
    try {
      const bmId = Number(req.params.bmId);
      if (!Number.isInteger(bmId) || bmId < 1) {
        return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
      }
      deleteReaderBookmark(bmId, req.user.username);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /* Legacy endpoint */
  app.delete('/api/reader-bookmarks/:bmId', requireApiAuth, (req, res) => {
    try {
      const bmId = Number(req.params.bmId);
      if (!Number.isInteger(bmId) || bmId < 1) {
        return apiFail(res, 400, ApiErrorCode.BOOKMARK_INVALID_ID, t('api.bookmark.invalidId'));
      }
      deleteReaderBookmark(bmId, req.user.username);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /* ── Reading history ───────────────────────────────────────────── */

  app.post('/api/reading-history/:bookId', requireApiAuth, (req, res) => {
    try {
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
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.delete('/api/reading-history/:bookId', requireApiAuth, (req, res) => {
    try {
      deleteReadingHistoryEntry(req.user.username, String(req.params.bookId));
      invalidateHomeUserSnapshot(req.user.username);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
