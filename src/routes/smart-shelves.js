/**
 * Умные полки: /api/smart-shelves* (клиенты) и формы веб-интерфейса /shelves/smart*.
 * Фильтр — те же параметры, что у /api/catalog (q, genre, genreMode, lang, format, year, minRate, hasSeries, sort, order).
 */
import { t, translateKnownErrorMessage } from '../i18n.js';
import { requireApiAuth, requireWebAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { safePage } from '../utils/safe-int.js';
import {
  listSmartShelves, getSmartShelf, createSmartShelf, updateSmartShelf, deleteSmartShelf, getSmartShelfBooks, setSmartShelfOnHome
} from '../smart-shelves.js';
import { getUserHomeLayout, orderShelves } from '../home-layout.js';

const PAGE_SIZE = 24;

/** @param {import('express').Application} app */
export function registerSmartShelfRoutes(app) {
  app.get('/api/smart-shelves', requireApiAuth, (req, res) => {
    const username = req.user.username;
    const list = listSmartShelves(username, { withPreview: req.query.preview === '1' });
    // In the user's order (drag in the shelves list, homeLayout.shelfOrder).
    res.json(orderShelves(list.map((s) => ({ ...s, kind: 'smart' })), getUserHomeLayout(username).shelfOrder)
      .map(({ kind, ...s }) => s));
  });

  app.post('/api/smart-shelves', requireApiAuth, (req, res) => {
    try {
      const id = createSmartShelf(req.user.username, req.body?.name, req.body?.query);
      res.json({ ok: true, id });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, translateKnownErrorMessage(error.message));
    }
  });

  app.put('/api/smart-shelves/:id', requireApiAuth, (req, res) => {
    try {
      const changed = updateSmartShelf(req.params.id, req.user.username, { name: req.body?.name, filter: req.body?.query });
      if (!changed) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
      res.json({ ok: true });
    } catch (error) {
      return apiFail(res, 400, ApiErrorCode.VALIDATION, translateKnownErrorMessage(error.message));
    }
  });

  app.delete('/api/smart-shelves/:id', requireApiAuth, (req, res) => {
    if (!deleteSmartShelf(req.params.id, req.user.username)) {
      return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    }
    res.json({ ok: true });
  });

  /* Pin to the home page (web form: POST /shelves/smart/:id/home): { on } → { ok, onHome }. */
  app.post('/api/smart-shelves/:id/home', requireApiAuth, (req, res) => {
    const on = [true, 1, '1', 'true'].includes(req.body?.on);
    if (!setSmartShelfOnHome(req.params.id, req.user.username, on)) {
      return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    }
    res.json({ ok: true, onHome: on ? 1 : 0 });
  });

  app.get('/api/smart-shelves/:id/books', requireApiAuth, (req, res) => {
    const shelf = getSmartShelf(req.params.id, req.user.username);
    if (!shelf) return apiFail(res, 404, ApiErrorCode.SHELF_NOT_FOUND, t('shelf.notFound'));
    const page = safePage(req.query.page);
    // Optional, additive: the Android app asks for whole cover rows (e.g. 20 in 5 columns).
    const pageSizeRaw = Number(req.query.pageSize);
    const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 && pageSizeRaw <= PAGE_SIZE
      ? Math.floor(pageSizeRaw)
      : PAGE_SIZE;
    const result = getSmartShelfBooks(shelf, { page, pageSize });
    res.json({ items: result.items, total: result.total, page, pageSize });
  });

  app.post('/shelves/smart', requireWebAuth, (req, res) => {
    try {
      createSmartShelf(req.user.username, req.body?.name, req.body?.query);
    } catch (error) {
      return res.status(400).type('text/plain; charset=utf-8').send(translateKnownErrorMessage(error.message));
    }
    res.redirect(303, '/shelves');
  });

  app.post('/shelves/smart/:id/home', requireWebAuth, (req, res) => {
    setSmartShelfOnHome(req.params.id, req.user.username, req.body?.on === '1');
    res.redirect(303, '/shelves');
  });

  app.post('/shelves/smart/:id/delete', requireWebAuth, (req, res) => {
    deleteSmartShelf(req.params.id, req.user.username);
    res.redirect(303, '/shelves');
  });
}
