import path from 'node:path';
import crypto from 'node:crypto';
import { t, tp, translateKnownErrorMessage, countLabel } from '../i18n.js';
import { requireApiAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import {
  db, getUserShelves, getShelfById, createShelf, updateShelf, deleteShelf,
  addBookToShelf, removeBookFromShelf, getShelfBooks, getBookShelves,
  getEreaderEmail, setEreaderEmail, setUserAccountEmail, getSmtpSettings, getUserByUsername, isEreaderEmailAllowedForUser,
  getMeta, setMeta, createAppPairingToken, consumeAppPairingToken,
  resolveTelegramRuntimeConfig, isTelegramBotAllowedForUser,
  getUserReadingStats, setReadingGoal, setBookRating, removeBookRating, getBookRating,
} from '../db.js';
import { resolvePublicBaseUrl } from '../services/password-reset.js';
import { isPairingRedeemRateLimited, registerPairingRedeemAttempt } from '../services/rate-limiter.js';
import QRCode from 'qrcode';
import {
  getBookById, getBooksByIds, getReadingHistory, getBookmarks, getFavoriteAuthors, getFavoriteSeries,
  getBookmarksPage,
  isBookmarked, toggleBookmark, addBookmarksIfMissing, toggleWantToRead, removeWantToRead, getSeriesReadingProgress,
  toggleFavoriteAuthor, toggleFavoriteSeries, getAllBookIdsByFacet,
  toggleReadBook, addReadBooksIfMissing, isSeriesFullyRead, removeReadBooksForSeries,
  removeReadBookIfPresent, markSeriesReadUpTo, toggleSeriesWantToRead,
} from '../inpx.js';
import { safePage } from '../utils/safe-int.js';
import { resolveDownload } from '../conversion.js';
import { createSmtpTransport } from '../services/email.js';
import { invalidateUserPageCaches } from '../services/cache.js';
import { invalidateRecommendationsCache } from '../services/recommendations.js';
import { logSystemEvent } from '../services/system-events.js';
import { effectiveContentLangs } from '../user-content-langs.js';
import { isServerBusyError } from '../services/heavy-task-limiter.js';
import { formatAuthorLabel } from '../genre-map.js';
import { BATCH_DOWNLOAD_MAX, BATCH_ZIP_MAX, TELEGRAM_BATCH_MAX } from '../constants.js';
import { normalizeBatchIdsParam, resolveAdhocBookIdsFromClientList, resolveBatchScopeBookIds } from './download.js';
import { decodeBookRef } from '../utils/book-ref.js';

/**
 * User-facing API routes: bookmarks, shelves, favorites, e-reader, history.
 */
/** «На полку» for a whole series: generous cap, series are short but some «series» are publisher lines. */
const SERIES_SHELF_MAX = 2000;

export function registerUserApiRoutes(app, deps) {
  const { batchEmailLocks } = deps;

  function denyEreaderEmailAccess(res, user) {
    const full = getUserByUsername(user.username);
    if (isEreaderEmailAllowedForUser(full)) return false;
    apiFail(res, 403, ApiErrorCode.EREADER_EMAIL_DENIED, t('profile.ereaderEmail.accessDenied'));
    return true;
  }

  /* ── History & Favorites data ─────────────────────────────────── */

  app.get('/api/history', requireApiAuth, (req, res) => {
    res.json(getReadingHistory(req.user.username, 20).map((item) => ({
      ...item,
      authorsDisplay: formatAuthorLabel(item.authors)
    })));
  });

  app.get('/api/favorites', requireApiAuth, (req, res) => {
    res.json({
      authors: getFavoriteAuthors(req.user.username, 200),
      series: getFavoriteSeries(req.user.username, 200),
    });
  });

  /* ── Bookmarks ─────────────────────────────────────────────────── */

  app.get('/api/bookmarks', requireApiAuth, (req, res) => {
    const page = safePage(req.query.page);
    const pageSizeRaw = Number(req.query.pageSize);
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 && pageSizeRaw <= 500
      ? Math.floor(pageSizeRaw)
      : 24;
    const sort = ['date', 'title', 'author'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'date';
    const result = getBookmarksPage(req.user.username, { sort, page, pageSize });
    res.json({
      items: result.items.map((b) => ({
        ...b,
        authorsDisplay: formatAuthorLabel(b.authors),
      })),
      total: result.total,
      page,
      pageSize,
    });
  });

  app.post('/api/bookmarks/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const bookmarked = toggleBookmark(req.user.username, book.id);
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
    res.json({ bookmarked });
  });

  /* ── «Хочу прочитать» ─────────────────────────────────────────────── */

  /* Series «Хочу прочитать» toggle: { name } → { want, added, removed } (web series page + Android).
     Registered before /api/want/:id so «series» is not taken for a book id. */
  app.post('/api/want/series', requireApiAuth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.error.unknown'));
    }
    const username = req.user.username;
    const result = toggleSeriesWantToRead(username, name, { langs: effectiveContentLangs(username) });
    invalidateUserPageCaches(username);
    res.json(result);
  });

  app.post('/api/want/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const want = toggleWantToRead(req.user.username, book.id);
    invalidateUserPageCaches(req.user.username);
    res.json({ want });
  });

  app.delete('/api/want/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    removeWantToRead(req.user.username, book.id);
    invalidateUserPageCaches(req.user.username);
    res.json({ want: false });
  });

  /* Personal book rating 1–5 («Мои оценки»): GET → { rating } (0 = none), POST { rating }, DELETE clears. */
  app.get('/api/rating/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    res.json({ rating: getBookRating(req.user.username, book.id) });
  });

  app.post('/api/rating/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const rating = Math.floor(Number(req.body?.rating));
    if (!(rating >= 1 && rating <= 5)) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.error.unknown'));
    }
    setBookRating(req.user.username, book.id, rating);
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
    res.json({ rating });
  });

  app.delete('/api/rating/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    removeBookRating(req.user.username, book.id);
    invalidateUserPageCaches(req.user.username);
    res.json({ rating: 0 });
  });

  /* Series progress for the Android series screen (web renders the same block server-side):
     { total, read, next: { id, title, seriesNo } | null }; editions count once, profile languages apply. */
  app.get('/api/series-progress', requireApiAuth, (req, res) => {
    const name = String(req.query.name || '').trim();
    if (!name) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.error.unknown'));
    }
    const progress = getSeriesReadingProgress(req.user.username, name, { langs: effectiveContentLangs(req.user.username) });
    res.json(progress || { total: 0, read: 0, next: null, numbers: [] });
  });

  /* «Отметить прочитанным до тома N»: { name, upTo } → { added, progress } (web series page + Android). */
  app.post('/api/series-read-up-to', requireApiAuth, (req, res) => {
    const name = String(req.body?.name || '').trim();
    const upTo = Number(req.body?.upTo);
    if (!name || !Number.isFinite(upTo) || upTo < 0) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.error.unknown'));
    }
    const username = req.user.username;
    const langs = effectiveContentLangs(username);
    const { added } = markSeriesReadUpTo(username, name, upTo, { langs });
    if (added > 0) {
      invalidateUserPageCaches(username);
      invalidateRecommendationsCache(username);
    }
    res.json({ added, progress: getSeriesReadingProgress(username, name, { langs }) });
  });

  /* Goodreads / LiveLib CSV → «Прочитано», «Хочу прочитать», «Мои оценки». Body: { csv } (≤ 2 MB). */
  const readingImportLocks = new Set();
  app.post('/api/import/reading', requireApiAuth, async (req, res) => {
    const csv = String(req.body?.csv || '');
    if (!csv.trim()) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('import.reading.empty'));
    }
    const username = req.user.username;
    if (readingImportLocks.has(username)) {
      return apiFail(res, 429, ApiErrorCode.SEND_IN_PROGRESS, t('import.reading.busy'));
    }
    readingImportLocks.add(username);
    try {
      const { importReadingCsv } = await import('../services/reading-import.js');
      const report = await importReadingCsv(username, csv);
      invalidateUserPageCaches(username);
      invalidateRecommendationsCache(username);
      logSystemEvent('info', 'profile', 'reading list imported', { user: username, rows: report.rows, matched: report.matched });
      res.json({ ok: true, ...report });
    } catch (error) {
      if (error?.code === 'IMPORT_NO_COLUMNS') {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, t('import.reading.noColumns'));
      }
      throw error;
    } finally {
      readingImportLocks.delete(username);
    }
  });

  /* Reading statistics + yearly goal (web profile renders the same data server-side). */
  app.get('/api/reading-stats', requireApiAuth, (req, res) => {
    res.json(getUserReadingStats(req.user.username));
  });

  app.post('/api/reading-goal', requireApiAuth, (req, res) => {
    const year = Number(req.body?.year) || new Date().getFullYear();
    try {
      setReadingGoal(req.user.username, year, req.body?.goal);
    } catch {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.error.unknown'));
    }
    res.json(getUserReadingStats(req.user.username));
  });

  /* ── Read books ──────────────────────────────────────────────────── */

  app.post('/api/read/batch', requireApiAuth, (req, res) => {
    const body = req.body || {};
    const facet = String(body.facet || '').trim();
    const value = String(body.value ?? '').trim();
    // Series toggle: if fully read → unmark, otherwise → mark
    if (facet === 'series' && value) {
      if (isSeriesFullyRead(req.user.username, value)) {
        const result = removeReadBooksForSeries(req.user.username, value);
        invalidateUserPageCaches(req.user.username);
        invalidateRecommendationsCache(req.user.username);
        return res.json({ ...result, action: 'removed' });
      }
      const ids = getAllBookIdsByFacet('series', value);
      if (!ids.length) {
        return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
      }
      const result = addReadBooksIfMissing(req.user.username, ids);
      invalidateUserPageCaches(req.user.username);
      invalidateRecommendationsCache(req.user.username);
      return res.json({ ...result, action: 'added' });
    }
    const raw = body.ids;
    const ids = Array.isArray(raw) ? raw.map((x) => String(x).trim()).filter(Boolean) : [];
    const unique = [...new Set(ids)];
    if (!unique.length) {
      return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
    }
    if (unique.length > BATCH_DOWNLOAD_MAX) {
      return apiFail(res, 400, ApiErrorCode.BATCH_MAX_BOOKS, tp('api.batch.maxBooks', { max: BATCH_DOWNLOAD_MAX }));
    }
    const result = addReadBooksIfMissing(req.user.username, unique);
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
    res.json({ ...result, action: 'added' });
  });

  app.post('/api/read/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    const read = toggleReadBook(req.user.username, book.id);
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
    res.json({ read });
  });

  app.delete('/api/read/:id', requireApiAuth, (req, res) => {
    const book = getBookById(req.params.id);
    if (!book) {
      return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    }
    removeReadBookIfPresent(req.user.username, book.id);
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
    res.json({ read: false });
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
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
    res.json(result);
  });

  /* ── Shelves ────────────────────────────────────────────────────── */

  app.post('/api/shelves/batch-add-books', requireApiAuth, (req, res) => {
    const body = req.body || {};
    const shelfRaw = Array.isArray(body.shelfIds) ? body.shelfIds : [];
    const bookRaw = Array.isArray(body.bookIds) ? body.bookIds : [];
    const shelfIds = [...new Set(shelfRaw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0))];
    // Additive `series`: the whole series («На полку» on the series page), resolved here — may exceed the client id cap.
    const seriesName = String(body.series || '').trim();
    const bookIds = seriesName
      ? getAllBookIdsByFacet('series', seriesName).slice(0, SERIES_SHELF_MAX).map(String)
      : [...new Set(bookRaw.map((x) => String(x).trim()).filter(Boolean))];
    if (!shelfIds.length) {
      return apiFail(res, 400, ApiErrorCode.BATCH_NO_SHELVES, t('api.batch.noShelves'));
    }
    if (!bookIds.length) {
      return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
    }
    if (!seriesName && bookIds.length > BATCH_DOWNLOAD_MAX) {
      return apiFail(res, 400, ApiErrorCode.BATCH_MAX_BOOKS, tp('api.batch.maxBooks', { max: BATCH_DOWNLOAD_MAX }));
    }
    if (shelfIds.length > BATCH_DOWNLOAD_MAX) {
      return apiFail(res, 400, ApiErrorCode.BATCH_MAX_SHELVES, tp('api.batch.maxShelves', { max: BATCH_DOWNLOAD_MAX }));
    }
    // Предварительно валидируем bookIds ОДНИМ запросом вместо N×M точечных SELECT-ов.
    const validIds = seriesName ? new Set(bookIds) : new Set(
      db.prepare(`SELECT id FROM active_books WHERE id IN (${bookIds.map(() => '?').join(',')})`).all(...bookIds).map((r) => r.id)
    );
    let added = 0;
    const addBatch = db.transaction((shelfId, ids) => {
      for (const bookId of ids) {
        // INSERT OR IGNORE идемпотентен; .changes отличает «добавили» от «уже было».
        added += addBookToShelf(shelfId, bookId);
      }
    });
    for (const shelfId of shelfIds) {
      const shelf = getShelfById(shelfId, req.user.username);
      if (!shelf) continue;
      const ids = bookIds.filter((id) => validIds.has(id));
      if (ids.length) addBatch(shelf.id, ids);
    }
    res.json({ ok: true, added });
  });

  app.post('/api/favorites/authors', requireApiAuth, (req, res) => {
    const name = String(req.body.name || '');
    const favorite = toggleFavoriteAuthor(req.user.username, name);
    if (favorite === null) {
      return apiFail(res, 404, ApiErrorCode.FACET_AUTHOR_NOT_FOUND, t('api.facet.authorNotFound'));
    }
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
    res.json({ favorite });
  });

  app.post('/api/favorites/series', requireApiAuth, (req, res) => {
    const name = String(req.body.name || '');
    const favorite = toggleFavoriteSeries(req.user.username, name);
    if (favorite === null) {
      return apiFail(res, 404, ApiErrorCode.FACET_SERIES_NOT_FOUND, t('api.facet.seriesNotFound'));
    }
    invalidateUserPageCaches(req.user.username);
    invalidateRecommendationsCache(req.user.username);
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

  app.delete('/api/shelves/:id/books/b64/:ref', requireApiAuth, (req, res) => {
    const shelf = getShelfById(Number(req.params.id), req.user.username);
    if (!shelf) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    const bookId = decodeBookRef(String(req.params.ref || ''));
    if (!bookId) return apiFail(res, 400, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
    removeBookFromShelf(shelf.id, bookId);
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
    if (denyEreaderEmailAccess(res, req.user)) return;
    const rawEmail = String(req.body.email || '').trim();
    if (rawEmail && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(rawEmail)) {
      return apiFail(res, 400, ApiErrorCode.PROFILE_INVALID_EMAIL, t('profile.invalidEmail'));
    }
    setEreaderEmail(req.user.username, rawEmail);
    res.json({ ok: true, email: getEreaderEmail(req.user.username) });
  });

  /* ── Account email (users.email; separate from the e-reader email) ─ */

  app.get('/api/account-email', requireApiAuth, (req, res) => {
    res.json({ email: getUserByUsername(req.user.username)?.email || '' });
  });

  app.post('/api/account-email', requireApiAuth, (req, res) => {
    try {
      const email = setUserAccountEmail(req.user.username, req.body?.email);
      res.json({ ok: true, email });
    } catch (error) {
      if (error.message === 'Invalid email') {
        return apiFail(res, 400, ApiErrorCode.PROFILE_INVALID_EMAIL, t('profile.invalidEmail'));
      }
      if (error.message === 'Email already in use') {
        return apiFail(res, 409, ApiErrorCode.PROFILE_EMAIL_TAKEN, t('profile.accountEmail.taken'));
      }
      throw error;
    }
  });

  /* ── Send to E-reader ──────────────────────────────────────────── */

  app.post('/api/send-to-ereader/batch', requireApiAuth, async (req, res, next) => {
    try {
      if (denyEreaderEmailAccess(res, req.user)) return;
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

      if (bookIds.length > BATCH_ZIP_MAX) {
        return apiFail(res, 400, ApiErrorCode.BATCH_MAX_SEND, tp('api.batch.maxSend', { max: BATCH_ZIP_MAX }));
      }

      const lockKey = req.user.username;
      if (batchEmailLocks.has(lockKey)) {
        return apiFail(res, 429, ApiErrorCode.SEND_IN_PROGRESS, t('api.send.inProgress'));
      }
      batchEmailLocks.add(lockKey);

      try {
        const attachments = [];
        const usedNames = new Map();
        let busySkipped = false;
        const requested = bookIds.length;
        const booksMap = getBooksByIds(bookIds);
        for (const bookId of bookIds) {
          try {
            const book = booksMap.get(bookId);
            if (!book) continue;
            const download = await resolveDownload(book, format || undefined);

            let fileName = download.fileName;
            const count = usedNames.get(fileName) || 0;
            if (count > 0) {
              const ext = path.extname(fileName);
              const base = fileName.slice(0, fileName.length - ext.length);
              fileName = `${base} (${count})${ext}`;
            }
            usedNames.set(download.fileName, count + 1);

            if (download.filePath) {
              attachments.push({ filename: fileName, path: download.filePath, contentType: download.mimeType });
            } else {
              attachments.push({ filename: fileName, content: download.content, contentType: download.mimeType });
            }
          } catch (err) {
            // skip books that fail to resolve
            if (isServerBusyError(err)) busySkipped = true;
          }
        }

        if (!attachments.length && busySkipped) {
          res.setHeader('Retry-After', '15');
          return apiFail(res, 503, ApiErrorCode.SERVICE_UNAVAILABLE, t('errors.serverBusy'));
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
      if (denyEreaderEmailAccess(res, req.user)) return;
      const ereaderEmail = getEreaderEmail(req.user.username);
      if (!ereaderEmail) {
        return apiFail(res, 400, ApiErrorCode.EREADER_EMAIL_MISSING, t('api.ereader.emailMissing'));
      }
      const book = getBookById(req.params.id);
      if (!book) {
        return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      }
      const lockKey = req.user.username;
      if (batchEmailLocks.has(lockKey)) {
        return apiFail(res, 429, ApiErrorCode.SEND_IN_PROGRESS, t('api.send.inProgress'));
      }
      batchEmailLocks.add(lockKey);
      const format = String(req.body.format || 'epub2');
      try {
        const download = await resolveDownload(book, format);
        const { transporter, senderEmail } = createSmtpTransport();
        const attachment = download.filePath
          ? { filename: download.fileName, path: download.filePath, contentType: download.mimeType }
          : { filename: download.fileName, content: download.content, contentType: download.mimeType };

        await transporter.sendMail({
          from: senderEmail,
          to: ereaderEmail,
          subject: download.fileName,
          text: `${book.title} — ${book.authors || t('book.authorUnknown')}`,
          attachments: [attachment]
        });

        logSystemEvent('info', 'ereader', 'book sent to ereader', { user: req.user.username, book: book.title, to: ereaderEmail, format });
        res.json({ ok: true, message: tp('api.email.singleSent', { email: ereaderEmail }) });
      } finally {
        batchEmailLocks.delete(lockKey);
      }
    } catch (error) {
      if (isServerBusyError(error)) {
        res.setHeader('Retry-After', '15');
        return apiFail(res, 503, ApiErrorCode.SERVICE_UNAVAILABLE, t('errors.serverBusy'));
      }
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

  /** «Отправить → В Telegram» для выбранных книг: по карточке на книгу, как с одной книгой. */
  app.post('/api/send-to-telegram/batch', requireApiAuth, async (req, res) => {
    try {
      const tgCfg = resolveTelegramRuntimeConfig();
      if (!tgCfg.enabled || !tgCfg.token) {
        return apiFail(res, 400, ApiErrorCode.TELEGRAM_DISABLED, t('telegram.botDisabled'));
      }
      const fullUser = getUserByUsername(req.user.username);
      if (!isTelegramBotAllowedForUser(fullUser)) {
        return apiFail(res, 403, ApiErrorCode.TELEGRAM_DENIED, t('profile.telegram.accessDenied'));
      }
      if (!fullUser.telegramId) {
        return apiFail(res, 400, ApiErrorCode.TELEGRAM_NOT_LINKED, t('telegram.notLinked'), { linkUrl: '/profile#settings' });
      }

      const body = req.body || {};
      const rawIds = Array.isArray(body.ids)
        ? body.ids.map((x) => String(x).trim()).filter(Boolean)
        : normalizeBatchIdsParam(body.ids);
      if (!rawIds || !rawIds.length) {
        return apiFail(res, 400, ApiErrorCode.BATCH_NO_BOOKS, t('api.batch.noBooks'));
      }
      if (rawIds.length > TELEGRAM_BATCH_MAX) {
        return apiFail(res, 400, ApiErrorCode.BATCH_MAX_SEND, tp('telegram.batchMax', { n: TELEGRAM_BATCH_MAX }));
      }
      const bookIds = resolveAdhocBookIdsFromClientList(rawIds);
      if (!bookIds.length) {
        return apiFail(res, 400, ApiErrorCode.BATCH_NO_MATCHING, t('api.batch.noMatchingBooks'));
      }

      const lockKey = `tg:${req.user.username}`;
      if (batchEmailLocks.has(lockKey)) {
        return apiFail(res, 429, ApiErrorCode.SEND_IN_PROGRESS, t('api.send.inProgress'));
      }
      batchEmailLocks.add(lockKey);
      try {
        const { sendBookCardToChat } = await import('../services/telegram-bot.js');
        let sent = 0;
        for (const bookId of bookIds) {
          try {
            await sendBookCardToChat(fullUser.telegramId, bookId);
            sent++;
          } catch {
            // skip books the bot could not send; reported as `skipped`
          }
        }
        const requested = rawIds.length;
        if (!sent) {
          return apiFail(res, 500, ApiErrorCode.TELEGRAM_SEND_FAILED, t('telegram.sendFailed'));
        }
        logSystemEvent('info', 'telegram-bot', 'book cards sent from web', { user: req.user.username, count: sent, requested });
        res.json({
          ok: true,
          message: tp('telegram.batchSent', { count: sent }),
          requested,
          sent,
          skipped: requested - sent,
          partial: sent < requested
        });
      } finally {
        batchEmailLocks.delete(lockKey);
      }
    } catch (error) {
      console.error('Batch send to telegram error:', error);
      apiFail(res, 500, ApiErrorCode.TELEGRAM_SEND_FAILED, t('telegram.sendFailed'));
    }
  });

  /** Отправка книги в Telegram пользователя (привязанный аккаунт), «В Telegram» на странице книги. */
  app.post('/api/send-to-telegram/:id', requireApiAuth, async (req, res) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      const tgCfg = resolveTelegramRuntimeConfig();
      if (!tgCfg.enabled || !tgCfg.token) {
        return apiFail(res, 400, ApiErrorCode.TELEGRAM_DISABLED, t('telegram.botDisabled'));
      }
      const fullUser = getUserByUsername(req.user.username);
      if (!isTelegramBotAllowedForUser(fullUser)) {
        return apiFail(res, 403, ApiErrorCode.TELEGRAM_DENIED, t('profile.telegram.accessDenied'));
      }
      if (!fullUser.telegramId) {
        return apiFail(res, 400, ApiErrorCode.TELEGRAM_NOT_LINKED, t('telegram.notLinked'), { linkUrl: '/profile#settings' });
      }
      const lockKey = `tg:${req.user.username}`;
      if (batchEmailLocks.has(lockKey)) {
        return apiFail(res, 429, ApiErrorCode.SEND_IN_PROGRESS, t('api.send.inProgress'));
      }
      batchEmailLocks.add(lockKey);
      try {
        const { sendBookCardToChat } = await import('../services/telegram-bot.js');
        await sendBookCardToChat(fullUser.telegramId, book.id);
        logSystemEvent('info', 'telegram-bot', 'book card sent from web', { user: req.user.username, book: book.title });
        res.json({ ok: true, message: t('telegram.sentOk') });
      } finally {
        batchEmailLocks.delete(lockKey);
      }
    } catch (error) {
      console.error('Send to telegram error:', error);
      apiFail(res, 500, ApiErrorCode.TELEGRAM_SEND_FAILED, t('telegram.sendFailed'));
    }
  });

  /* ── Device tokens (Android reader) ───────────────────────────── */

  function deviceTokenMetaKey(username, tokenId) {
    return `device_token:${username}:${tokenId}`;
  }

  function hashDeviceToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  function mintDeviceToken(username, deviceNameRaw) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenId = token.slice(0, 16);
    const deviceName = String(deviceNameRaw || 'INPX Reader').slice(0, 128);
    setMeta(deviceTokenMetaKey(username, tokenId), JSON.stringify({
      user: username,
      tokenHash: hashDeviceToken(token),
      deviceName,
      createdAt: new Date().toISOString(),
    }));
    setMeta(`device_token_hash:${hashDeviceToken(token)}`, `${username}:${tokenId}`);
    return { token, tokenId, deviceName };
  }

  app.post('/api/auth/device', requireApiAuth, (req, res) => {
    const issued = mintDeviceToken(req.user.username, req.body?.deviceName);
    res.json({ ok: true, token: issued.token, tokenId: issued.tokenId, deviceName: issued.deviceName });
  });

  app.delete('/api/auth/device/:tokenId', requireApiAuth, (req, res) => {
    const tokenId = String(req.params.tokenId || '').slice(0, 32);
    if (!tokenId) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, t('api.error.unknown'));
    }
    const metaKey = deviceTokenMetaKey(req.user.username, tokenId);
    const raw = getMeta(metaKey);
    if (raw) {
      try {
        const meta = JSON.parse(raw);
        if (meta.tokenHash) setMeta(`device_token_hash:${meta.tokenHash}`, '');
      } catch { /* ignore */ }
    }
    setMeta(metaKey, '');
    res.json({ ok: true });
  });

  app.post('/api/auth/pairing', requireApiAuth, async (req, res) => {
    try {
      const { token, expiresAt } = createAppPairingToken(req.user.username);
      const serverUrl = resolvePublicBaseUrl(req);
      if (!serverUrl) {
        return apiFail(res, 500, ApiErrorCode.INTERNAL, t('profile.appPair.errorNoServerUrl'));
      }
      const payloadObj = {
        type: 'inpx-pair',
        v: 1,
        url: serverUrl,
        code: token,
        user: req.user.username,
      };
      const payload = JSON.stringify(payloadObj);
      const svg = await QRCode.toString(payload, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        width: 256,
      });
      res.json({
        ok: true,
        serverUrl,
        username: req.user.username,
        code: token,
        expiresAt,
        payload,
        svg,
      });
    } catch (err) {
      return apiFail(res, 500, ApiErrorCode.INTERNAL, err?.message || t('api.error.unknown'));
    }
  });

  app.post('/api/auth/pairing/redeem', (req, res) => {
    if (isPairingRedeemRateLimited(req)) {
      return apiFail(res, 429, ApiErrorCode.RATE_LIMITED, t('auth.rateLimitLogin'));
    }
    const code = String(req.body?.code || '').trim();
    if (!code || code.length > 128) {
      registerPairingRedeemAttempt(req);
      return apiFail(res, 400, ApiErrorCode.PAIRING_INVALID, t('profile.appPair.errorInvalid'));
    }
    const consumed = consumeAppPairingToken(code);
    if (!consumed) {
      registerPairingRedeemAttempt(req);
      return apiFail(res, 400, ApiErrorCode.PAIRING_INVALID, t('profile.appPair.errorInvalid'));
    }
    const issued = mintDeviceToken(consumed.username, req.body?.deviceName || 'INPX Reader');
    const serverUrl = resolvePublicBaseUrl(req);
    res.json({
      ok: true,
      serverUrl,
      username: consumed.username,
      deviceToken: issued.token,
      deviceTokenId: issued.tokenId,
      deviceName: issued.deviceName,
    });
  });
}
