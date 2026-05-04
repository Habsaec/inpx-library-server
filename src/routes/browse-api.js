/**
 * JSON API каталога и подсказок поиска (браузерный каталог).
 */
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { PAGE_CACHE_TTL_MS } from '../constants.js';
import { getCachedPageData, getStaleOrSchedule } from '../services/cache.js';
import { safePage } from '../utils/safe-int.js';
import {
  getBooksByFacetCoalesced,
  getLibraryView,
  getSuggestions,
  searchCatalog
} from '../inpx.js';
import { getRecommendedLibraryView } from '../services/recommendations.js';
import { requireBrowseAuth } from '../middleware/auth.js';
import { t } from '../i18n.js';
import { asyncHandler } from '../utils/async-handler.js';

/**
 * @param {import('express').Application} app
 */
export function registerBrowseApiRoutes(app) {
  app.get('/api/search/suggest', requireBrowseAuth, (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ books: [], authors: [], series: [] });
    res.json(getSuggestions(q, 5));
  });

  app.get('/api/library/:view(recent|continue|read|recommended)', requireBrowseAuth, (req, res) => {
    const view = String(req.params.view);
    const page = safePage(req.query.page);
    const pageSize = 24;
    const type = String(req.query.type || '').trim();
    const user = req.user || null;
    const canUseSharedCache = view === 'recent';
    const username = user?.username || '';
    const result = canUseSharedCache
      ? getStaleOrSchedule(`library:${view}:page:${page}:size:${pageSize}`, () => getLibraryView(view, { page, pageSize }), PAGE_CACHE_TTL_MS, { total: 0, items: [] })
      : view === 'recommended'
        ? getRecommendedLibraryView({ page, pageSize, username })
        : view === 'continue' || view === 'read'
          ? getStaleOrSchedule(`library:${view}:${username}:p${page}:s${pageSize}`, () => getLibraryView(view, { page, pageSize, username, type }), PAGE_CACHE_TTL_MS, { total: 0, items: [] })
          : getLibraryView(view, { page, pageSize, username, type });
    res.json({ items: result.items, total: result.total, page, pageSize });
  });

  app.get('/api/catalog', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const field = String(req.query.field || 'books');
    const sort = String(req.query.sort || 'recent');
    const genre = String(req.query.genre || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const lang = String(req.query.lang || '').trim();
    const format = String(req.query.format || '').trim();
    const year = Number(req.query.year) || 0;
    const page = safePage(req.query.page);
    const pageSize = 24;
    const cacheKey = `api:catalog:${field}:${sort}:${genre}:${letter}:${lang}:${format}:${year}:${query}:p${page}:s${pageSize}`;
    const result = getCachedPageData(
      cacheKey,
      () => searchCatalog({ query, page, pageSize, field, sort, genre, letter, lang, format, year }),
      PAGE_CACHE_TTL_MS
    );
    res.json({ items: result.items, total: result.total, page, pageSize, field: result.field });
  });

  app.get('/api/facet-books', requireBrowseAuth, asyncHandler(async (req, res) => {
    const facet = String(req.query.facet || '').trim();
    const value = String(req.query.value ?? '').trim();
    const sort = String(req.query.sort || 'recent').trim();
    const page = safePage(req.query.page);
    const pageSize = 24;
    const allowed = new Set(['authors', 'series', 'genres', 'languages']);
    if (!allowed.has(facet) || !value) {
      return apiFail(res, 400, ApiErrorCode.FACET_INVALID, t('api.facet.invalid'), { items: [], total: 0, page, pageSize });
    }
    const result = await getBooksByFacetCoalesced({ facet, value, page, pageSize, sort });
    res.json({ items: result.items, total: result.total, page, pageSize });
  }));
}
