import fs from 'node:fs';
import path from 'node:path';
import { t, tp, translateKnownErrorMessage, countLabel } from '../i18n.js';
import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import {
  db, getUserShelves, getShelfById, createShelf, updateShelf, deleteShelf,
  addBookToShelf, removeBookFromShelf, getShelfBooks, getBookShelves,
  getEreaderEmail, setEreaderEmail, getSmtpSettings
} from '../db.js';
import {
  getBookById, getReadingHistory, getBookmarks, getFavoriteAuthors, getFavoriteSeries,
  isBookmarked, toggleBookmark, addBookmarksIfMissing,
  toggleFavoriteAuthor, toggleFavoriteSeries, getAllBookIdsByFacet
} from '../inpx.js';
import { resolveDownload } from '../conversion.js';
import { createSmtpTransport } from '../services/email.js';
import { invalidateHomeUserSnapshot } from '../services/cache.js';
import { logSystemEvent } from '../services/system-events.js';
import { formatAuthorLabel } from '../genre-map.js';
import { BATCH_DOWNLOAD_MAX } from '../constants.js';
import { normalizeBatchIdsParam, resolveAdhocBookIdsFromClientList, resolveBatchScopeBookIds } from './download.js';

/**
 * User-facing API routes: bookmarks, shelves, favorites, e-reader, history.
 */
export function registerUserApiRoutes(app, deps) {
  const { batchEmailLocks } = deps;

  /* ── History & Favorites data ─────────────────────────────────── */

  app.get('/api/history', requireApiAuth, (req, res) => {
    res.json(getReadingHistory(req.user.username, 20).map((item) => ({
      ...item,
      authorsDisplay: formatAuthorLabel(item.authors)
    })));
  });

  app.get('/api/favorites', requireApiAuth, (req, res) => {
    res.json({
      authors: getFavoriteAuthors(req.user.username, 20),
      series: getFavoriteSeries(req.user.username, 20)
    });
  });

  /* ── Bookmarks ─────────────────────────────────────────────────── */

  app.post('/api/bookmarks/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const bookmarked = toggleBookmark(req.user.username, book.id);
    res.json({ bookmarked });
  });

  app.post('/api/bookmarks/batch', requireApiAuth, (req, res) => {
    const raw = req.body?.ids;
    const ids = Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter(Boolean) : [];
    const unique = [...new Set(ids)];
    if (!unique.length) {
      return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
    }
    if (unique.length > BATCH_DOWNLOAD_MAX) {
      return apiFail(res, 400, ApiErrorCode.BATCH_MAX_BOOKS, tp('api.batch.maxBooks', { max: BATCH_DOWNLOAD_MAX }));
    }
    const result = addBookmarksIfMissing(req.user.username, unique);
    res.json(result);
  });

  /* ── Shelves ────────────────────────────────────────────────────── */

  app.post('/api/shelves/batch-add-books', requireApiAuth, (req, res) => {
    const body = req.body || {};
    const shelfRaw = Array.isArray(body.shelfIds) ? body.shelfIds : [];
    const bookRaw = Array.isArray(body.bookIds) ? body.bookIds : [];
    const shelfIds = [...new Set(shelfRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
    const bookIds = [...new Set(bookRaw.map((x) => String(x).trim()).filter(Boolean))];
    if (!shelfIds.length) {
      return apiFail(res, 400, ApiErrorCode.BATCH_NO_SHELVES, t('api.batch.noShelves'));
    }
    if (!bookIds.length) {
      return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
    }
    if (bookIds.length > BATCH_DOWNLOAD_MAX) {
      return apiFail(res, 400, ApiErrorCode.BATCH_MAX_BOOKS, tp('api.batch.maxBooks', { max: BATCH_DOWNLOAD_MAX }));
    }
    if (shelfIds.length > BATCH_DOWNLOAD_MAX) {
      return apiFail(res, 400, ApiErrorCode.BATCH_MAX_SHELVES, tp('api.batch.maxShelves', { max: BATCH_DOWNLOAD_MAX }));
    }
    let added = 0;
    for (const shelfId of shelfIds) {
      const shelf = getShelfById(shelfId, req.user.username);
      if (!shelf) continue;
      for (const bookId of bookIds) {
        if (!getBookById(bookId)) continue;
        const existed = db
          .prepare('SELECT 1 FROM shelf_books WHERE shelf_id = ? AND book_id = ?')
          .get(shelf.id, bookId);
        addBookToShelf(shelf.id, bookId);
        if (!existed) added++;
      }
    }
    res.json({ ok: true, added });
  });

  app.post('/api/favorites/authors', requireApiAuth, (req, res) => {
    const name = String(req.body.name || '');
    const favorite = toggleFavoriteAuthor(req.user.username, name);
    if (favorite === null) {
      return apiFail(res, 404, ApiErrorCode.FACET_AUTHOR_NOT_FOUND, t('api.facet.authorNotFound'));
    }
    invalidateHomeUserSnapshot(req.user.username);
    res.json({ favorite });
  });

  app.post('/api/favorites/series', requireApiAuth, (req, res) => {
    const name = String(req.body.name || '');
    const favorite = toggleFavoriteSeries(req.user.username, name);
    if (favorite === null) {
      return apiFail(res, 404, ApiErrorCode.FACET_SERIES_NOT_FOUND, t('api.facet.seriesNotFound'));
    }
    invalidateHomeUserSnapshot(req.user.username);
    res.json({ favorite });
  });

  app.get('/api/shelves', requireApiAuth, (req, res) => {
    res.json(getUserShelves(req.user.username));
  });

  app.post('/api/shelves', requireApiAuth, (req, res) => {
    try {
      const id = createShelf(req.user.username, req.body.name, req.body.description);
      res.json({ ok: true, id });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, translateKnownErrorMessage(error.message));
    }
  });

  app.put('/api/shelves/:id', requireApiAuth, (req, res) => {
    const shelf = getShelfById(Number(req.params.id), req.user.username);
    if (!shelf) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    try {
      updateShelf(shelf.id, req.user.username, req.body.name, req.body.description);
      res.json({ ok: true });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, translateKnownErrorMessage(error.message));
    }
  });

  app.delete('/api/shelves/:id', requireApiAuth, (req, res) => {
    const deleted = deleteShelf(Number(req.params.id), req.user.username);
    if (!deleted) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    res.json({ ok: true });
  });

  app.get('/api/shelves/:id/books', requireApiAuth, (req, res) => {
    const shelf = getShelfById(Number(req.params.id), req.user.username);
    if (!shelf) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    res.json(getShelfBooks(shelf.id, req.user.username));
  });

  app.post('/api/shelves/:id/books', requireApiAuth, (req, res) => {
    const shelf = getShelfById(Number(req.params.id), req.user.username);
    if (!shelf) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    const book = getBookById(String(req.body.bookId || ''));
    if (!book) return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    addBookToShelf(shelf.id, book.id);
    res.json({ ok: true });
  });

  app.delete('/api/shelves/:id/books/:bookId', requireApiAuth, (req, res) => {
    const shelf = getShelfById(Number(req.params.id), req.user.username);
    if (!shelf) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    removeBookFromShelf(shelf.id, req.params.bookId);
    res.json({ ok: true });
  });

  app.get('/api/book-shelves/:bookId', requireApiAuth, (req, res) => {
    res.json(getBookShelves(req.user.username, req.params.bookId));
  });

  /* ── E-reader ──────────────────────────────────────────────────── */

  app.get('/api/ereader-email', requireApiAuth, (req, res) => {
    res.json({ email: getEreaderEmail(req.user.username) });
  });

  app.post('/api/ereader-email', requireApiAuth, (req, res) => {
    const rawEmail = String(req.body.email || '').trim();
    if (rawEmail && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(rawEmail)) {
      return apiFail(res, 400, ApiErrorCode.PROFILE_INVALID_EMAIL, t('profile.invalidEmail'));
    }
    setEreaderEmail(req.user.username, rawEmail);
    res.json({ ok: true, email: getEreaderEmail(req.user.username) });
  });

  /* ── Send to E-reader ──────────────────────────────────────────── */

  app.post('/api/send-to-ereader/batch', requireApiAuth, async (req, res, next) => {
    try {
      const ereaderEmail = getEreaderEmail(req.user.username);
      if (!ereaderEmail) {
        return apiFail(res, 400, ApiErrorCode.EREADER_EMAIL_MISSING, t('api.ereader.emailMissing'));
      }
      const smtp = getSmtpSettings();
      if (!smtp.host) {
        return apiFail(res, 400, ApiErrorCode.SMTP_NOT_CONFIGURED, t('api.ereader.smtpNotConfigured'));
      }

      const body = req.body || {};
      const format = String(body.format || 'epub2').trim().toLowerCase();
      const hasShelf = Number(body.shelf) > 0;
      const hasFacet =
        (body.facet === 'authors' || body.facet === 'series') && String(body.value ?? '').trim().length > 0;

      const rawIds = Array.isArray(body.ids)
        ? body.ids.map((x) => String(x).trim()).filter(Boolean)
        : normalizeBatchIdsParam(body.ids);

      let bookIds = [];
      let archiveName = 'books';

      if (!hasShelf && !hasFacet) {
        if (rawIds === null || !rawIds.length) {
          return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
        }
        bookIds = resolveAdhocBookIdsFromClientList(rawIds);
        if (!bookIds.length) {
          return apiFail(res, 400, ApiErrorCode.BATCH_NO_MATCHING, t('api.batch.noMatchingBooks'));
        }
      } else {
        const scope = resolveBatchScopeBookIds(req, body);
        if (scope.error) {
          return apiFail(res, scope.error, scope.code, scope.message);
        }
        bookIds = scope.bookIds;
        archiveName = scope.archiveName;
        if (rawIds !== null) {
          if (!rawIds.length) {
            return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
          }
          bookIds = resolveAdhocBookIdsFromClientList(rawIds);
          if (!bookIds.length) {
            return apiFail(res, 400, ApiErrorCode.BATCH_NO_MATCHING_IN_LIST, t('api.batch.noMatchingBooksInList'));
          }
        }
      }

      if (!bookIds.length) {
        return apiFail(res, 404, ApiErrorCode.BATCH_BOOKS_NOT_FOUND, t('api.error.booksNotFound'));
      }

      if (bookIds.length > BATCH_DOWNLOAD_MAX) {
        return apiFail(res, 400, ApiErrorCode.BATCH_MAX_SEND, tp('api.batch.maxSend', { max: BATCH_DOWNLOAD_MAX }));
      }

      const lockKey = req.user.username;
      if (batchEmailLocks.has(lockKey)) {
        return apiFail(res, 429, ApiErrorCode.SEND_IN_PROGRESS, t('api.send.inProgress'));
      }
      batchEmailLocks.add(lockKey);

      try {
        const attachments = [];
        const usedNames = new Map();
        const requested = bookIds.length;
        for (const bookId of bookIds) {
          try {
            const book = getBookById(bookId);
            if (!book) continue;
            const download = await resolveDownload(book, format || undefined);
            let content;
            if (download.filePath) {
              content = await fs.promises.readFile(download.filePath);
            } else {
              content = download.content;
            }

            let fileName = download.fileName;
            const count = usedNames.get(fileName) || 0;
            if (count > 0) {
              const ext = path.extname(fileName);
              const base = fileName.slice(0, fileName.length - ext.length);
              fileName = `${base} (${count})${ext}`;
            }
            usedNames.set(download.fileName, count + 1);

            attachments.push({ filename: fileName, content, contentType: download.mimeType });
          } catch {
            // skip books that fail to resolve
          }
        }

        if (!attachments.length) {
          return apiFail(res, 404, ApiErrorCode.SEND_NO_ATTACHMENTS, t('api.send.noAttachments'));
        }

        const { transporter, senderEmail } = createSmtpTransport();
        const safeName = String(archiveName || 'books').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 100) || 'books';

        await transporter.sendMail({
          from: senderEmail,
          to: ereaderEmail,
          subject: tp('api.email.batchSubject', { name: safeName, books: countLabel('book', attachments.length) }),
          text: tp('api.email.batchBody', { name: safeName, count: attachments.length, format: format.toUpperCase() }),
          attachments
        });

        const attached = attachments.length;
        const skipped = requested - attached;
        const partial = skipped > 0;
        logSystemEvent('info', 'ereader', 'batch sent to ereader', {
          user: req.user.username,
          collection: archiveName,
          count: attached,
          requested,
          skipped,
          to: ereaderEmail,
          format
        });
        res.json({
          ok: true,
          message: tp('api.email.batchSent', { count: attached, email: ereaderEmail }),
          requested,
          attached,
          skipped,
          partial
        });
      } finally {
        batchEmailLocks.delete(lockKey);
      }
    } catch (error) {
      batchEmailLocks.delete(req.user?.username || '');
      console.error('Batch send to ereader error:', error);
      let msg = translateKnownErrorMessage(error.message) || t('api.error.unknown');
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        msg = t('api.email.err.smtpConnect');
      } else if (msg.includes('EENVELOPE') || msg.includes('rejected')) {
        msg = t('api.email.err.smtpRejected');
      } else if (error?.code === 'FB2CNG_NOT_CONFIGURED') {
        msg = t('api.email.err.converterMissing');
      }
      const code = error?.code === 'FB2CNG_NOT_CONFIGURED' ? ApiErrorCode.CONVERTER_MISSING : ApiErrorCode.SMTP_ERROR;
      res.status(500).json({ ok: false, code, error: msg });
    }
  });

  app.post('/api/send-to-ereader/:id', requireApiAuth, async (req, res, next) => {
    try {
      const ereaderEmail = getEreaderEmail(req.user.username);
      if (!ereaderEmail) {
        return apiFail(res, 400, ApiErrorCode.EREADER_EMAIL_MISSING, t('api.ereader.emailMissing'));
      }
      const book = getBookById(req.params.id);
      if (!book) {
        return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      }
      const format = String(req.body.format || 'epub2');
      const download = await resolveDownload(book, format);
      let content;
      if (download.filePath) {
        content = await fs.promises.readFile(download.filePath);
      } else {
        content = download.content;
      }

      const { transporter, senderEmail } = createSmtpTransport();

      await transporter.sendMail({
        from: senderEmail,
        to: ereaderEmail,
        subject: download.fileName,
        text: `${book.title} — ${book.authors || t('book.authorUnknown')}`,
        attachments: [{
          filename: download.fileName,
          content,
          contentType: download.mimeType
        }]
      });

      logSystemEvent('info', 'ereader', 'book sent to ereader', { user: req.user.username, book: book.title, to: ereaderEmail, format });
      res.json({ ok: true, message: tp('api.email.singleSent', { email: ereaderEmail }) });
    } catch (error) {
      console.error('Send to ereader error:', error);
      let msg = translateKnownErrorMessage(error.message) || t('api.error.unknown');
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        msg = t('api.email.err.recipientConnect');
      } else if (msg.includes('EENVELOPE') || msg.includes('rejected')) {
        msg = t('api.email.err.smtpRejected');
      }
      res.status(500).json({ ok: false, code: ApiErrorCode.SMTP_ERROR, error: msg });
    }
  });
}
