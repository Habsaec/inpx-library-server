/**
 * JSON API каталога и подсказок поиска (браузерный каталог).
 */
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { PAGE_CACHE_TTL_MS } from '../constants.js';
import { getCachedPageData } from '../services/cache.js';
import { safePage } from '../utils/safe-int.js';
import {
  getBooksByFacet,
  getLibraryView,
  getSuggestions,
  searchCatalog
} from '../inpx.js';
import { getRecommendedLibraryView } from '../services/recommendations.js';
import { requireBrowseAuth } from '../middleware/auth.js';
import { t } from '../i18n.js';

/**
 * @param {import('express').Application} app
 */
export function registerBrowseApiRoutes(app) {
  app.get('/api/search/suggest', requireBrowseAuth, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ books: [], authors: [], series: [] });
    res.json(getSuggestions(q, 5));
  });

  app.get('/api/library/:view(recent|continue|recommended)', requireBrowseAuth, (req, res) => {
    const view = String(req.params.view);
    const page = safePage(req.query.page);
    const pageSize = 24;
    const user = req.user || null;
    const canUseSharedCache = view === 'recent';
    const result = canUseSharedCache
      ? getCachedPageData(`library:${view}:page:${page}:size:${pageSize}`, () => getLibraryView(view, { page, pageSize }), PAGE_CACHE_TTL_MS)
      : view === 'recommended'
        ? getRecommendedLibraryView({ page, pageSize, username: user?.username || '' })
        : getLibraryView(view, { page, pageSize, username: user?.username || '' });
    res.json({ items: result.items, total: result.total, page, pageSize });
  });

  app.get('/api/catalog', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const field = String(req.query.field || 'books');
    const sort = String(req.query.sort || 'recent');
    const genre = String(req.query.genre || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const page = safePage(req.query.page);
    const pageSize = 24;
    const cacheKey = `api:catalog:${field}:${sort}:${genre}:${letter}:${query}:p${page}:s${pageSize}`;
    const result = getCachedPageData(
      cacheKey,
      () => searchCatalog({ query, page, pageSize, field, sort, genre, letter }),
      PAGE_CACHE_TTL_MS
    );
    res.json({ items: result.items, total: result.total, page, pageSize, field: result.field });
  });

  app.get('/api/facet-books', requireBrowseAuth, (req, res) => {
    const facet = String(req.query.facet || '').trim();
    const value = String(req.query.value ?? '').trim();
    const sort = String(req.query.sort || 'recent').trim();
    const page = safePage(req.query.page);
    const pageSize = 24;
    const allowed = new Set(['authors', 'series', 'genres', 'languages']);
    if (!allowed.has(facet) || !value) {
      return apiFail(res, 400, ApiErrorCode.FACET_INVALID, t('api.facet.invalid'), { items: [], total: 0, page, pageSize });
    }
    const cacheKey = `api:facet-books:${facet}:${value}:${sort}:p${page}:s${pageSize}`;
    const result = getCachedPageData(
      cacheKey,
      () => getBooksByFacet({ facet, value, page, pageSize, sort }),
      PAGE_CACHE_TTL_MS
    );
    res.json({ items: result.items, total: result.total, page, pageSize });
  });
}
