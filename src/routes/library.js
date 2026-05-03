import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import iconv from 'iconv-lite';
import { config } from '../config.js';
import { t, tp, getLocale } from '../i18n.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { requireBrowseAuth, requireBrowseOrOpds, requireWebAuth, requireAdminWeb } from '../middleware/auth.js';
import { getCachedPageData, getStaleOrSchedule, clearPageDataCache, invalidateHomeUserSnapshot } from '../services/cache.js';
import { logSystemEvent } from '../services/system-events.js';
import { getRecommendedLibraryView, getHomeRecommendations, buildSimilarBooks } from '../services/recommendations.js';
import { safePage } from '../utils/safe-int.js';
import {
  DETAILS_CACHE_MAX,
  HOME_SECTIONS_CACHE_TTL_MS,
  PAGE_CACHE_TTL_MS
} from '../constants.js';
import { getUserShelves, getShelfById, getShelfBooks, getSetting, setBookRating, removeBookRating, getBookRating, getBookAverageRating, getReadBookIdSet, getFullyReadSeriesNames } from '../db.js';
import {
  getBookById,
  getBooksByIds,
  getBookDuplicateCandidates,
  getAuthorBooksGroupedCoalesced,
  getAuthorFlibustaSourceId,
  getBooksByFacetCoalesced,
  getLibraryRoot,
  getFacetSummary,
  getFavoriteAuthors,
  getFavoriteSeries,
  getIndexStatus,
  getBookmarks,
  getLibrarySections,
  getLibraryView,
  updateBookMetadata,
  getReadBooks,
  isBookmarked,
  isBookRead,
  isSeriesFullyRead,
  isFavoriteAuthor,
  isFavoriteSeries,
  listAuthors,
  listGenres,
  listAuthorsByGenre,
  listSeriesByGenre,
  listLanguages,
  listSeries,
  resolveAuthorName,
  resolveSeriesCatalogName,
  recordReadingHistory,
  searchCatalog,
  getSourceRoot,
  effectiveSourceFlibustaForBook,
  splitAuthorValues,
  listGenresGrouped,
  hasContinueBooks
} from '../inpx.js';
import { getDistinctLanguages, getDistinctFormats } from '../inpx.js';
import { getOrExtractBookDetails, getStoredBookDetailsCover } from '../fb2.js';
import {
  readFlibustaCover,
  listFlibustaIllustrationsForBook,
  readFlibustaIllustrationForBook,
  readFlibustaAuthorPortraitForAuthorName,
  readFlibustaBookReviewHtml,
  readFlibustaAuthorBioHtml
} from '../flibusta-sidecar.js';
import { formatAuthorLabel, formatGenreLabel, formatLanguageLabel, getGenreGroup, getGenreGroups } from '../genre-map.js';
import { clearCardHtmlCache } from '../templates/shared.js';

// --- Sharp concurrency limiter ---

const SHARP_CONCURRENCY_LIMIT = 6;
let _sharpActiveCount = 0;
const _sharpQueue = [];

function acquireSharpSlot() {
  if (_sharpActiveCount < SHARP_CONCURRENCY_LIMIT) {
    _sharpActiveCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => _sharpQueue.push(resolve));
}

function releaseSharpSlot() {
  if (_sharpQueue.length > 0) {
    const next = _sharpQueue.shift();
    next();
  } else {
    _sharpActiveCount--;
  }
}

// --- Cover thumbnail caching ---

const ALLOWED_BOOK_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
const COVER_THUMB_WIDTH = config.coverMaxWidth;
const COVER_THUMB_HEIGHT = config.coverMaxHeight;

function getCoverWidth() {
  const db = Number(getSetting('cover_max_width'));
  return db > 0 ? db : COVER_THUMB_WIDTH;
}
function getCoverHeight() {
  const db = Number(getSetting('cover_max_height'));
  return db > 0 ? db : COVER_THUMB_HEIGHT;
}
function getCoverQuality() {
  const db = Number(getSetting('cover_quality'));
  return (db >= 1 && db <= 100) ? db : config.coverQuality;
}
const COVER_THUMB_CACHE_TTL_MS = 30 * 60_000;
const COVER_THUMB_DISK_TTL_MS = 7 * 24 * 60 * 60_000;
const COVER_THUMB_DISK_DIR = path.join(config.dataDir, 'cover-thumb-cache');
const coverThumbCache = new Map();
let coverThumbDiskReady = false;

function detectImageMimeFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0x0a) return 'image/jxl';
  if (
    buf.length >= 12 &&
    buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] === 0x0c &&
    buf[4] === 0x4a && buf[5] === 0x4c && buf[6] === 0x4c && buf[7] === 0x20 &&
    buf[8] === 0x0d && buf[9] === 0x0a && buf[10] === 0x87 && buf[11] === 0x0a
  ) {
    return 'image/jxl';
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

async function normalizeBookImageForClient(img) {
  const sourceType = detectImageMimeFromBuffer(img?.data) || String(img?.contentType || '').toLowerCase();
  if (ALLOWED_BOOK_IMAGE_TYPES.has(sourceType)) {
    return { contentType: sourceType, data: img.data };
  }
  await acquireSharpSlot();
  try {
    const converted = await sharp(img.data, { failOn: 'none' })
      .webp({ quality: getCoverQuality(), effort: 4 })
      .toBuffer();
    return { contentType: 'image/webp', data: converted };
  } catch {
    if (sourceType && sourceType.startsWith('image/')) {
      return { contentType: sourceType, data: img.data };
    }
    return null;
  } finally {
    releaseSharpSlot();
  }
}

function getCachedCoverThumb(bookId) {
  const key = String(bookId || '').trim();
  if (!key) return null;
  const item = coverThumbCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > COVER_THUMB_CACHE_TTL_MS) {
    coverThumbCache.delete(key);
    return null;
  }
  // LRU promotion: move to end of insertion order
  coverThumbCache.delete(key);
  coverThumbCache.set(key, item);
  return item;
}

function setCachedCoverThumb(bookId, contentType, data) {
  const key = String(bookId || '').trim();
  if (!key || !data?.length) return;
  coverThumbCache.set(key, { contentType, data, ts: Date.now() });
  if (coverThumbCache.size > 4000) {
    const oldest = coverThumbCache.keys().next().value;
    coverThumbCache.delete(oldest);
  }
}

function ensureCoverThumbDiskDir() {
  if (coverThumbDiskReady) return;
  fs.mkdirSync(COVER_THUMB_DISK_DIR, { recursive: true });
  coverThumbDiskReady = true;
}

/** Hierarchical path: cover-thumb-cache/ab/abcdef....webp */
function coverThumbDiskPath(bookId) {
  const key = String(bookId || '').trim();
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  const subDir = hash.slice(0, 2);
  return path.join(COVER_THUMB_DISK_DIR, subDir, `${hash}.webp`);
}

async function getDiskCachedCoverThumb(bookId) {
  try {
    ensureCoverThumbDiskDir();
    const diskPath = coverThumbDiskPath(bookId);
    const stat = await fs.promises.stat(diskPath);
    if (Date.now() - stat.mtimeMs > COVER_THUMB_DISK_TTL_MS) {
      void fs.promises.unlink(diskPath).catch(() => {});
      return null;
    }
    const data = await fs.promises.readFile(diskPath);
    return data?.length ? { contentType: 'image/webp', data } : null;
  } catch {
    return null;
  }
}

function setDiskCachedCoverThumb(bookId, contentType, data) {
  if (!data?.length) return;
  try {
    const diskPath = coverThumbDiskPath(bookId);
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.promises.writeFile(diskPath, data).catch(() => {});
  } catch {
    /* ignore */
  }
}

function invalidateCoverThumbCaches(bookId) {
  const key = String(bookId || '').trim();
  if (!key) return;
  coverThumbCache.delete(key);
  try {
    ensureCoverThumbDiskDir();
    void fs.promises.unlink(coverThumbDiskPath(bookId)).catch(() => {});
  } catch {
    /* ignore */
  }
}

// --- Book details cache ---

const detailsCache = new Map();

async function getDetails(book) {
  const cached = detailsCache.get(book.id);
  if (cached) {
    const staleDbFlibusta =
      Number(book.sourceFlibusta) !== 1 && effectiveSourceFlibustaForBook(book) === 1;
    if (!staleDbFlibusta) {
      return cached;
    }
    detailsCache.delete(book.id);
  }
  const details = await getOrExtractBookDetails(book, { skipCoverAugment: true });
  const lite = {
    title: details.title,
    annotation: details.annotation,
    annotationIsHtml: Boolean(details.annotationIsHtml),
    cover: details.cover ? { contentType: details.cover.contentType, hasData: true } : null
  };
  if (detailsCache.size >= DETAILS_CACHE_MAX) {
    const oldest = detailsCache.keys().next().value;
    detailsCache.delete(oldest);
  }
  detailsCache.set(book.id, lite);
  return lite;
}

async function getDetailsFull(book) {
  return getOrExtractBookDetails(book);
}

function clearBookDetailsCache() {
  detailsCache.clear();
}

function bookFlibustaSidecarEffective(book) {
  return effectiveSourceFlibustaForBook(book) === 1;
}

// --- Cover resolution ---

async function resolveBestCoverBook(book, { limit = 8 } = {}) {
  if (!book) return null;
  const candidates = getBookDuplicateCandidates(book.id, limit);
  const seen = new Set();
  const ordered = [];
  if (book?.id) {
    ordered.push(book);
    seen.add(String(book.id));
  }
  for (const candidate of candidates) {
    const id = String(candidate?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(candidate);
  }
  for (const candidate of ordered) {
    try {
      const details = await getDetails(candidate);
      if (details?.cover) return candidate;
    } catch {
      /* ignore broken candidate */
    }
  }
  return null;
}

async function tryFastSidecarCover(book) {
  if (!book?.archiveName || !bookFlibustaSidecarEffective(book)) return null;
  try {
    const root = getSourceRoot(book.sourceId);
    return await readFlibustaCover(root, book.archiveName, book);
  } catch {
    return null;
  }
}

const coverResolveInflight = new Map();

async function resolveBestCoverDetails(book) {
  if (!book?.id) return null;
  const id = String(book.id);
  const existing = coverResolveInflight.get(id);
  if (existing) return existing;

  const job = Promise.resolve().then(async () => {
    try {
      const sidecarCover = await tryFastSidecarCover(book);
      if (sidecarCover?.data?.length) return { cover: sidecarCover };

      const storedCover = getStoredBookDetailsCover(book);
      if (storedCover?.data?.length) {
        const mime = detectImageMimeFromBuffer(storedCover.data);
        if (mime && ALLOWED_BOOK_IMAGE_TYPES.has(mime)) return { cover: storedCover };
      }

      let details = await getDetailsFull(book);
      if (details?.cover) return details;
      const bestCoverBook = await resolveBestCoverBook(book, { limit: 4 });
      if (bestCoverBook && bestCoverBook.id !== book.id) {
        const bestSidecarCover = await tryFastSidecarCover(bestCoverBook);
        if (bestSidecarCover?.data?.length) return { cover: bestSidecarCover };
        details = await getDetailsFull(bestCoverBook);
      }
      return details;
    } finally {
      coverResolveInflight.delete(id);
    }
  });

  coverResolveInflight.set(id, job);
  return job;
}

// --- Utility ---

async function asyncMapLimit(items, limit, mapper) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  const max = Math.max(1, Math.min(24, Math.floor(Number(limit) || 1)));
  let index = 0;
  const workers = Array.from({ length: Math.min(max, arr.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= arr.length) return;
      out[i] = await mapper(arr[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function safeRecordReadingHistory(username, bookId) {
  try {
    recordReadingHistory(username, bookId);
  } catch (error) {
    if (error?.code === 'SQLITE_BUSY') {
      return;
    }
    throw error;
  }
}

// --- Exported accessors for other modules ---

export { detailsCache, getDetailsFull, clearBookDetailsCache, bookFlibustaSidecarEffective };

// --- Route registration ---

export function registerLibraryRoutes(app, deps) {
  const {
    getCachedStats,
    templates: {
      renderHome, renderCatalog, renderLibraryView, renderBrowsePage,
      renderFacetBooks, renderAuthorFacetPage, renderAuthorOutsideSeriesPage,
      renderBook, renderFavorites, renderShelves, renderShelfDetail, renderReader
    }
  } = deps;

  // --- Home ---
  app.get('/', requireBrowseAuth, (req, res) => {
    const stats = getCachedStats();
    const user = req.user || null;
    const username = user?.username || '';
    const indexStatus = getIndexStatus();
    const sections = getStaleOrSchedule('home:sections', () => getLibrarySections(), HOME_SECTIONS_CACHE_TTL_MS, { newest: [], titles: [], authors: [], series: [], genres: [], languages: [] });
    // Случайная выборка из пула — каждый рендер показывает разные книги
    const DISPLAY_COUNT = 12;
    let displayNewest = sections.newest;
    if (displayNewest.length > DISPLAY_COUNT) {
      const shuffled = displayNewest.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      displayNewest = shuffled.slice(0, DISPLAY_COUNT);
    }
    const displaySections = { ...sections, newest: displayNewest };
    const hasContinueData = username ? hasContinueBooks(username) : false;
    const canUseAnonymousHomeHtmlCache = !user && !indexStatus?.active && !indexStatus?.error;
    const csrfToken = req.csrfToken || '';
    const homeSubtitle = getSetting('home_subtitle') || '';
    const html = canUseAnonymousHomeHtmlCache
      ? getCachedPageData(`page:home:anon:${getLocale()}`, () => renderHome({ user, stats, indexStatus, sections: displaySections, homeSubtitle, csrfToken: '', hasContinueData: false }), 1000 * 60 * 2)
      : renderHome({ user, stats, indexStatus, sections: displaySections, homeSubtitle, csrfToken, hasContinueData });
    res.send(html);
    // Фоновый прогрев per-user кэшей для последующих переходов
    if (username) {
      setImmediate(() => { try { getReadBookIdSet(username); } catch {} });
    }
  });

  // --- Catalog search ---
  app.get('/catalog', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const genre = String(req.query.genre || '').trim();
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const lang = String(req.query.lang || '').trim();
    const format = String(req.query.format || '').trim();
    const year = Number(req.query.year) || 0;
    const field = ['books', 'authors', 'series'].includes(String(req.query.field || '')) ? String(req.query.field) : 'books';
    const isBookField = field === 'books';
    const sort = String(req.query.sort || (isBookField ? 'recent' : 'count'));
    const page = safePage(req.query.page);
    const pageSize = 24;
    const stats = getCachedStats();
    const cacheKey = `catalog:${field}:${sort}:${genre}:${letter}:${lang}:${format}:${year}:${query}:p${page}`;
    const result = getCachedPageData(cacheKey, () => searchCatalog({ query, field, page, pageSize, sort, genre, letter, lang, format, year }));
    const user = req.user || null;
    const readBookIds = user ? getReadBookIdSet(user.username) : null;
    const langs = getDistinctLanguages();
    const formats = getDistinctFormats();
    res.send(renderCatalog({ ...result, page, pageSize, query, field, sort, genre, letter, lang, format, year, langs, formats, user, stats, indexStatus: getIndexStatus(), csrfToken: req.csrfToken || '', readBookIds }));
  });

  // --- Library views ---
  app.get('/library/:view(recent|continue|read|recommended)', requireBrowseAuth, (req, res) => {
    const view = String(req.params.view || 'recent');
    const page = safePage(req.query.page);
    const pageSize = 24;
    const type = String(req.query.type || '').trim();
    const user = req.user || null;
    const stats = getCachedStats();
    const titles = {
      recent: t('library.title.recent'),
      continue: t('library.title.continue'),
      read: t('library.title.read'),
      recommended: t('library.title.recommended')
    };
    const subtitles = {
      recent: t('library.sub.recent'),
      continue: t('library.sub.continue'),
      read: t('library.sub.read'),
      recommended: t('library.sub.recommended')
    };
    const canUseSharedCache = view === 'recent';
    const result = canUseSharedCache
      ? getStaleOrSchedule(`library:${view}:page:${page}:size:${pageSize}`, () => getLibraryView(view, { page, pageSize }), PAGE_CACHE_TTL_MS, { total: 0, items: [] })
      : view === 'recommended'
        ? getRecommendedLibraryView({ page, pageSize, username: user?.username || '' })
        : getLibraryView(view, { page, pageSize, username: user?.username || '', type });
    const readBookIds = user ? getReadBookIdSet(user.username) : null;
    const readSeriesNames = user ? getFullyReadSeriesNames(user.username) : null;
    res.send(renderLibraryView({
      view,
      title: titles[view] || t('library.titleFallback'),
      subtitle: subtitles[view] || '',
      ...result,
      page,
      pageSize,
      type,
      user,
      stats,
      indexStatus: getIndexStatus(),
      csrfToken: req.csrfToken || '',
      readBookIds,
      readSeriesNames
    }));
  });

  // --- Browse pages ---
  app.get('/authors', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const sort = String(req.query.sort || 'name');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const startsWith = query.length <= 2;
    const stats = getCachedStats();
    const cacheKey = `browse:authors:${page}:${sort}:${letter}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listAuthors({ query, page, pageSize, sort, startsWith, letter }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderBrowsePage({
      title: t('nav.authors'),
      ...result, page, pageSize, user: req.user || null, stats, query, letter,
      path: '/authors', facetBasePath: '/facet/authors',
      indexStatus: getIndexStatus(), sort, csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/series', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const sort = String(req.query.sort || 'count');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();
    const cacheKey = `browse:series:${page}:${sort}:${letter}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listSeries({ query, page, pageSize, sort, letter }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    const username = req.user?.username || '';
    res.send(renderBrowsePage({
      title: t('nav.series'),
      ...result, page, pageSize, user: req.user || null, stats, query, letter,
      path: '/series', facetBasePath: '/facet/series',
      indexStatus: getIndexStatus(), sort, csrfToken: req.csrfToken || '',
      readSeriesNames: username ? getFullyReadSeriesNames(username) : null
    }));
  });


  app.get('/genres', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const sort = String(req.query.sort || 'count');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();

    // Grouped view when no search/letter filter and first page
    if (!query && !letter && page === 1 && sort === 'count') {
      const allGenres = getStaleOrSchedule('browse:genres:grouped', () => listGenresGrouped(), PAGE_CACHE_TTL_MS, []);
      const groups = getGenreGroups();
      const grouped = [];
      for (const [groupName, codes] of Object.entries(groups)) {
        const codesSet = new Set(codes);
        const items = allGenres.filter(g => codesSet.has(g.name));
        if (items.length) grouped.push({ groupName, items });
      }
      // Uncategorized
      const allGrouped = new Set(Object.values(groups).flat());
      const uncategorized = allGenres.filter(g => !allGrouped.has(g.name));
      if (uncategorized.length) grouped.push({ groupName: t('genre.other'), items: uncategorized });

      res.send(renderBrowsePage({
        title: t('nav.genres'),
        items: allGenres, total: allGenres.length, page, pageSize: allGenres.length,
        user: req.user || null, stats, query, letter,
        path: '/genres', facetBasePath: '/facet/genres',
        indexStatus: getIndexStatus(), sort, csrfToken: req.csrfToken || '',
        genreGroups: grouped
      }));
      return;
    }

    const cacheKey = `browse:genres:${page}:${sort}:${letter}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listGenres({ query, page, pageSize, sort, letter }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderBrowsePage({
      title: t('nav.genres'),
      ...result, page, pageSize, user: req.user || null, stats, query, letter,
      path: '/genres', facetBasePath: '/facet/genres',
      indexStatus: getIndexStatus(), sort, csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/languages', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const sort = String(req.query.sort || 'count');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();
    const cacheKey = `browse:languages:${page}:${sort}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listLanguages({ query, page, pageSize, sort }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderBrowsePage({
      title: t('nav.languages'),
      ...result, page, pageSize, user: req.user || null, stats, query,
      path: '/languages', facetBasePath: '/facet/languages',
      indexStatus: getIndexStatus(), sort, csrfToken: req.csrfToken || ''
    }));
  });

  // --- Facet pages ---
  app.get('/facet/authors/:value/outside-series', requireBrowseAuth, async (req, res, next) => {
    try {
    const sort = String(req.query.sort || 'recent');
    const stats = getCachedStats();
    const value = String(req.params.value || '');
    const displayValue = formatAuthorLabel(value);
    const username = req.user?.username || '';
    const favorite = username ? isFavoriteAuthor(username, value) : false;
    const breadcrumbs = [
      { label: t('nav.home'), href: '/' },
      { label: t('nav.authors'), href: '/authors' },
      {
        label: displayValue,
        href: `/facet/authors/${encodeURIComponent(value)}`
      },
      { label: t('authorPage.outsideSeries') }
    ];
    const p = safePage(req.query.page, 1);
    const pageSize = 48;
    const grouped = await getAuthorBooksGroupedCoalesced(value, sort, { page: p, pageSize });
    const facetPath = `/facet/authors/${encodeURIComponent(value)}/outside-series`;
    res.send(
      renderAuthorOutsideSeriesPage({
        title: t('authorPage.outsideSeries'),
        displayName: displayValue,
        books: grouped.standaloneBooks,
        total: grouped.standaloneBooks.length,
        user: req.user || null, stats,
        indexStatus: getIndexStatus(), sort, facetPath, breadcrumbs,
        favorite, facetValue: value, csrfToken: req.csrfToken || '',
        page: p, pageSize, hasMore: grouped.standaloneBooks.length >= pageSize,
        readBookIds: username ? getReadBookIdSet(username) : null
      })
    );
    } catch (error) {
      next(error);
    }
  });

  app.get('/facet/:facet/:value', requireBrowseAuth, async (req, res, next) => {
    try {
      const sort = String(req.query.sort || 'recent');
      const page = safePage(req.query.page);
      const pageSize = 24;
      const stats = getCachedStats();
      const facet = String(req.params.facet || '');
      const facetLabels = {
        authors: t('facet.facetAuthors'),
        series: t('facet.facetSeries'),
        genres: t('facet.facetGenres'),
        languages: t('facet.facetLanguages')
      };
      if (!facetLabels[facet]) {
        return res.status(404).send(t('common.notFound'));
      }
      let value = String(req.params.value || '');
      if (facet === 'series') {
        const resolved = resolveSeriesCatalogName(value);
        if (resolved !== value) {
          const qs = new URLSearchParams(req.query).toString();
          const loc = `/facet/series/${encodeURIComponent(resolved)}${qs ? `?${qs}` : ''}`;
          return res.redirect(302, loc);
        }
        value = resolved;
      }
      if (facet === 'authors') {
        const resolvedAuthor = resolveAuthorName(value);
        if (resolvedAuthor && resolvedAuthor !== value) {
          const qs = new URLSearchParams(req.query).toString();
          const loc = `/facet/authors/${encodeURIComponent(resolvedAuthor)}${qs ? `?${qs}` : ''}`;
          return res.redirect(302, loc);
        }
        if (resolvedAuthor) {
          value = resolvedAuthor;
        }
      }
      const displayValue = facet === 'authors'
        ? formatAuthorLabel(value)
        : facet === 'languages'
          ? formatLanguageLabel(value)
          : facet === 'genres'
            ? formatGenreLabel(value)
          : value;
      const username = req.user?.username || '';
      const favorite = facet === 'authors'
        ? (username ? isFavoriteAuthor(username, value) : false)
        : facet === 'series'
          ? (username ? isFavoriteSeries(username, value) : false)
          : false;
      const breadcrumbs = [
        { label: t('nav.home'), href: '/' },
        { label: facetLabels[facet] || t('facet.sectionFallback'), href: `/${facet}` },
        { label: displayValue }
      ];
      const facetPath = `/facet/${encodeURIComponent(facet)}/${encodeURIComponent(value)}`;

      if (facet === 'authors') {
        const flibSourceId = getAuthorFlibustaSourceId(value);
        const facetRoot = flibSourceId != null ? getSourceRoot(flibSourceId) : '';
        const p = safePage(req.query.page, 1);
        const pageSize = 48;

        const [grouped, fullSummary, authorPortraitUrl, authorBioHtml] = await Promise.all([
          getAuthorBooksGroupedCoalesced(value, sort, { page: p, pageSize }),
          Promise.resolve(getFacetSummary(facet, value)),
          flibSourceId != null
            ? readFlibustaAuthorPortraitForAuthorName(value, facetRoot)
                .then(pic => pic?.data?.length ? `/api/authors/portrait?name=${encodeURIComponent(value)}` : '')
                .catch(() => '')
            : Promise.resolve(''),
          flibSourceId != null
            ? readFlibustaAuthorBioHtml(value, facetRoot, flibSourceId).catch(() => '')
            : Promise.resolve('')
        ]);

        const summary = { ...fullSummary, relatedTitle: '', relatedPath: '', relatedItems: [] };
        res.send(
          renderAuthorFacetPage({
            title: tp('facet.titleWithValue', { label: facetLabels[facet] || t('facet.sectionFallback'), value: displayValue }),
            displayName: displayValue,
            series: grouped.series,
            standaloneBooks: grouped.standaloneBooks,
            total: grouped.total,
            user: req.user || null, stats, facetPath,
            indexStatus: getIndexStatus(), sort, breadcrumbs, summary,
            facetValue: value, favorite, authorPortraitUrl, authorBioHtml,
            csrfToken: req.csrfToken || '',
            page: p, pageSize, hasMore: grouped.standaloneBooks.length >= pageSize,
            readSeriesNames: username ? getFullyReadSeriesNames(username) : null
          })
        );
        return;
      }

      // Mode switcher for genre pages: ?view=authors|series groups the genre's books by entity
      // so big sub-genres (10k+ books) become navigable instead of a flat dump.
      const allowedViews = facet === 'genres' ? ['books', 'authors', 'series'] : ['books'];
      const requestedView = String(req.query.view || 'books');
      const view = allowedViews.includes(requestedView) ? requestedView : 'books';

      if (facet === 'genres' && view !== 'books') {
        const entityPageSize = 50;
        const entitySort = ['count', 'name'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'count';
        const entityResult = view === 'authors'
          ? listAuthorsByGenre({ genre: value, page, pageSize: entityPageSize, sort: entitySort })
          : listSeriesByGenre({ genre: value, page, pageSize: entityPageSize, sort: entitySort });
        const summary = getFacetSummary(facet, value);
        res.send(renderFacetBooks({
          title: tp('facet.titleWithValue', { label: facetLabels[facet] || t('facet.sectionFallback'), value: displayValue }),
          items: [], total: entityResult.total, page, pageSize: entityPageSize,
          summary,
          user: req.user || null, stats, facetPath,
          indexStatus: getIndexStatus(), sort: entitySort, facet, facetValue: value,
          favorite, seriesRead: false, breadcrumbs, csrfToken: req.csrfToken || '',
          readBookIds: null,
          view, entityItems: entityResult.items
        }));
        return;
      }

      const result = await getBooksByFacetCoalesced({ facet, value, page, pageSize, sort });
      const summary = getFacetSummary(facet, value);
      const seriesRead = facet === 'series' && username ? isSeriesFullyRead(username, value) : false;
      res.send(renderFacetBooks({
        title: tp('facet.titleWithValue', { label: facetLabels[facet] || t('facet.sectionFallback'), value: displayValue }),
        ...result, summary, page, pageSize,
        user: req.user || null, stats, facetPath,
        indexStatus: getIndexStatus(), sort, facet, facetValue: value,
        favorite, seriesRead, breadcrumbs, csrfToken: req.csrfToken || '',
        readBookIds: username ? getReadBookIdSet(username) : null,
        view
      }));
    } catch (error) {
      next(error);
    }
  });

  // --- Book detail ---
  app.get('/book/:id', requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return res.status(404).send(t('book.notFound'));
      }
      const user = req.user || null;
      const username = user?.username || '';
      const details = await getDetails(book);
      const bookmarked = username ? isBookmarked(username, book.id) : false;
      const isRead = username ? isBookRead(username, book.id) : false;
      const userRating = username ? getBookRating(username, book.id) : 0;
      const avgRating = getBookAverageRating(book.id);
      const similarBooks = buildSimilarBooks(book);

      res.send(
        renderBook({
          book, details, bookmarked, isRead, user,
          stats: getCachedStats(),
          indexStatus: getIndexStatus(),
          similarBooks, csrfToken: req.csrfToken || '',
          authorBioHtml: '', authorPortraitUrl: '',
          illustrationUrls: [],
          flash: String(req.query.flash || ''),
          userRating,
          avgRating,
          readBookIds: username ? getReadBookIdSet(username) : null
        })
      );
    } catch (error) {
      next(error);
    }
  });

  // --- Book edit (admin) ---
  app.post('/book/:id/edit', requireAdminWeb, (req, res) => {
    const bookId = req.params.id;
    const { title, authors, series, seriesNo } = req.body;
    if (!title || !String(title).trim()) {
      return res.redirect(`/book/${encodeURIComponent(bookId)}?flash=` + encodeURIComponent(t('book.edit.titleRequired')));
    }
    try {
      const ok = updateBookMetadata(bookId, {
        title: String(title).trim(),
        authors: String(authors || '').trim(),
        series: String(series || '').trim(),
        seriesNo: String(seriesNo || '').trim()
      });
      detailsCache.delete(bookId);
      clearPageDataCache();
      clearCardHtmlCache();
      logSystemEvent('info', 'operations', 'book metadata edited', { actor: req.user.username, bookId });
      const msg = ok ? t('book.edit.saved') : t('book.edit.notFound');
      res.redirect(`/book/${encodeURIComponent(bookId)}?flash=` + encodeURIComponent(msg));
    } catch (error) {
      res.redirect(`/book/${encodeURIComponent(bookId)}?flash=` + encodeURIComponent(error.message));
    }
  });

  // --- Favorites & shelves ---
  app.get('/favorites', requireWebAuth, (req, res) => {
    const stats = getCachedStats();
    const view = ['books', 'read', 'authors', 'series'].includes(String(req.query.view || '')) ? String(req.query.view) : 'books';
    const sort = ['title', 'author', 'date', 'name', 'count'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'date';
    const books = getBookmarks(req.user.username, sort);
    const readBooks = getReadBooks(req.user.username, sort);
    const authors = getFavoriteAuthors(req.user.username, 50, sort);
    const series = getFavoriteSeries(req.user.username, 50, sort);
    const readBookIds = getReadBookIdSet(req.user.username);
    const readSeriesNames = getFullyReadSeriesNames(req.user.username);
    res.send(renderFavorites({ books, readBooks, authors, series, view, sort, user: req.user, stats, indexStatus: getIndexStatus(), csrfToken: req.csrfToken || '', readBookIds, readSeriesNames }));
  });

  app.get('/shelves', requireWebAuth, (req, res) => {
    const stats = getCachedStats();
    const shelves = getUserShelves(req.user.username);
    res.send(renderShelves({ shelves, user: req.user, stats, indexStatus: getIndexStatus(), csrfToken: req.csrfToken || '' }));
  });

  app.get('/shelves/:id', requireWebAuth, (req, res) => {
    const shelf = getShelfById(Number(req.params.id), req.user.username);
    if (!shelf) return res.status(404).send(t('shelf.notFound'));
    const stats = getCachedStats();
    const books = getShelfBooks(shelf.id, req.user.username);
    res.send(renderShelfDetail({ shelf, books, user: req.user, stats, indexStatus: getIndexStatus(), csrfToken: req.csrfToken || '', readBookIds: getReadBookIdSet(req.user.username) }));
  });

  // --- Book details API ---
  app.get('/api/books/:id/details', requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      }
      const details = await getDetails(book);
      res.json({
        annotation: details.annotation,
        annotationIsHtml: Boolean(details.annotationIsHtml),
        coverAvailable: Boolean(details.cover)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/books/details-batch', requireBrowseAuth, async (req, res, next) => {
    try {
      const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const ids = [...new Set(idsRaw.map((x) => String(x || '').trim()).filter(Boolean))];
      if (!ids.length) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, 'ids must be a non-empty array');
      }
      if (ids.length > 200) {
        return apiFail(res, 400, ApiErrorCode.VALIDATION, 'too many ids (max 200)');
      }

      const booksMap = getBooksByIds(ids);
      const items = {};
      await asyncMapLimit(ids, 6, async (id) => {
        try {
          const book = booksMap.get(id);
          if (!book) return;
          const details = await getDetails(book);
          items[id] = {
            annotation: details.annotation,
            annotationIsHtml: Boolean(details.annotationIsHtml),
            coverAvailable: Boolean(details.cover)
          };
        } catch {
          /* skip broken item */
        }
      });
      res.json({ items });
    } catch (error) {
      next(error);
    }
  });

  // --- Book rating API ---
  app.post('/api/books/:id/rating', requireWebAuth, (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      const rating = parseInt(req.body.rating, 10);
      if (!rating || rating < 1 || rating > 5) return apiFail(res, 400, ApiErrorCode.VALIDATION, t('book.rating.invalid'));
      setBookRating(req.user.username, book.id, rating);
      const avg = getBookAverageRating(book.id);
      res.json({ ok: true, userRating: rating, average: avg.average, count: avg.count });
    } catch (error) { next(error); }
  });

  app.delete('/api/books/:id/rating', requireWebAuth, (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      removeBookRating(req.user.username, book.id);
      const avg = getBookAverageRating(book.id);
      res.json({ ok: true, userRating: 0, average: avg.average, count: avg.count });
    } catch (error) { next(error); }
  });

  // --- Book review ---
  app.get('/api/books/:id/review', requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      }
      let html = '';
      try {
        html = await readFlibustaBookReviewHtml(book, getSourceRoot(book.sourceId));
      } catch {
        html = '';
      }
      res.json({ html: html || '' });
    } catch (error) {
      next(error);
    }
  });

  // --- Cover routes ---
  app.get('/api/books/:id/cover', requireBrowseOrOpds, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return res.status(404).end();
      }
      const details = await resolveBestCoverDetails(book);
      const coverMime = detectImageMimeFromBuffer(details?.cover?.data);
      if (coverMime && ALLOWED_BOOK_IMAGE_TYPES.has(coverMime)) {
        res.set('Cache-Control', 'private, max-age=86400');
        res.type(coverMime);
        return res.send(details.cover.data);
      }
      invalidateCoverThumbCaches(book.id);
      return res.status(404).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/books/:id/cover-thumb', requireBrowseOrOpds, async (req, res, next) => {
    try {
      const bookId = req.params.id;

      // 1. Check in-memory cache FIRST (cheapest)
      const cached = getCachedCoverThumb(bookId);
      if (cached?.data?.length) {
        res.set('Cache-Control', 'private, max-age=86400');
        res.type(cached.contentType || 'image/webp');
        return res.send(cached.data);
      }

      // 2. Check disk cache BEFORE expensive cover resolution
      const diskCached = await getDiskCachedCoverThumb(bookId);
      if (diskCached?.data?.length) {
        setCachedCoverThumb(bookId, diskCached.contentType, diskCached.data);
        res.set('Cache-Control', 'private, max-age=86400');
        res.type(diskCached.contentType || 'image/webp');
        return res.send(diskCached.data);
      }

      // 3. Cache miss — resolve cover from archives (expensive)
      const book = getBookById(bookId);
      if (!book) {
        return res.status(404).end();
      }
      const details = await resolveBestCoverDetails(book);
      const coverMimeHead = detectImageMimeFromBuffer(details?.cover?.data);
      if (!coverMimeHead || !ALLOWED_BOOK_IMAGE_TYPES.has(coverMimeHead)) {
        invalidateCoverThumbCaches(book.id);
        return res.status(404).end();
      }

      let coverBuffer = details.cover.data;
      let coverMime = coverMimeHead;

      let outBuf = coverBuffer;
      let outType = 'image/webp';
      await acquireSharpSlot();
      try {
        outBuf = await sharp(coverBuffer, { failOn: 'none' })
          .resize({
            width: getCoverWidth(),
            height: getCoverHeight(),
            fit: 'inside',
            withoutEnlargement: true
          })
          .webp({ quality: 62, effort: 2 })
          .toBuffer();
      } catch {
        outType = coverMime;
        outBuf = coverBuffer;
      } finally {
        releaseSharpSlot();
      }

      setCachedCoverThumb(book.id, outType, outBuf);
      setDiskCachedCoverThumb(book.id, outType, outBuf);
      res.set('Cache-Control', 'private, max-age=86400');
      res.type(outType);
      return res.send(outBuf);
    } catch (error) {
      next(error);
    }
  });

  // --- Illustrations ---
  app.get('/api/books/:id/illustrations', requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book || !bookFlibustaSidecarEffective(book)) {
        return res.json({ items: [] });
      }
      const root = getSourceRoot(book.sourceId);
      const list = await listFlibustaIllustrationsForBook(root, book);
      res.json({
        items: list.map((x) => ({
          index: x.index,
          url: `/api/books/${encodeURIComponent(book.id)}/illustration/${x.index}`
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/books/:id/illustration/:idx', requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return res.status(404).end();
      }
      const idx = parseInt(req.params.idx, 10);
      if (!Number.isFinite(idx)) {
        return res.status(400).end();
      }
      if (!bookFlibustaSidecarEffective(book)) {
        return res.status(404).end();
      }
      const root = getSourceRoot(book.sourceId);
      const img = await readFlibustaIllustrationForBook(root, book, idx);
      if (!img) {
        return res.status(404).end();
      }
      const normalized = await normalizeBookImageForClient(img);
      if (!normalized) {
        return res.status(415).end();
      }
      res.type(normalized.contentType);
      res.send(normalized.data);
    } catch (error) {
      next(error);
    }
  });

  // --- Author portraits ---
  app.get('/api/books/:id/author-photo', requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return res.status(404).end();
      }
      const primaryAuthor = book.authorsList?.[0] || splitAuthorValues(book.authors || '')[0] || '';
      if (!primaryAuthor || !bookFlibustaSidecarEffective(book)) {
        return res.status(404).end();
      }
      const root = getSourceRoot(book.sourceId);
      const pic = await readFlibustaAuthorPortraitForAuthorName(primaryAuthor, root);
      if (!pic) {
        return res.status(404).end();
      }
      const normalized = await normalizeBookImageForClient(pic);
      if (!normalized) {
        return res.status(415).end();
      }
      res.type(normalized.contentType);
      res.send(normalized.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/authors/portrait', requireBrowseAuth, async (req, res, next) => {
    try {
      const name = String(req.query.name || '').trim();
      if (!name) {
        return res.status(400).end();
      }
      const sourceId = getAuthorFlibustaSourceId(name);
      if (sourceId == null) {
        return res.status(404).end();
      }
      const root = getSourceRoot(sourceId);
      const pic = await readFlibustaAuthorPortraitForAuthorName(name, root);
      if (!pic) {
        return res.status(404).end();
      }
      const normalized = await normalizeBookImageForClient(pic);
      if (!normalized) {
        return res.status(415).end();
      }
      res.type(normalized.contentType);
      res.send(normalized.data);
    } catch (error) {
      next(error);
    }
  });

  // --- Reader ---
  app.get('/read/:id', requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) return res.status(404).send(t('book.notFound'));
      const username = req.user?.username || '';
      if (username) {
        safeRecordReadingHistory(username, book.id);
        invalidateHomeUserSnapshot(username);
      }
      const details = await getDetails(book);
      res.send(renderReader({ book, details, user: req.user, csrfToken: req.csrfToken || '' }));
    } catch (error) {
      next(error);
    }
  });

  // --- Book content ---
  app.get(['/api/books/:id/content', '/api/books/:id/content/:filename'], requireBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) return apiFail(res, 404, ApiErrorCode.BOOK_NOT_FOUND, t('book.notFound'));
      const { readBookBufferForDelivery } = await import('../fb2.js');
      const buffer = await readBookBufferForDelivery(book);
      const ext = String(book.ext || 'fb2').toLowerCase();
      if (ext === 'fb2') {
        if (bookFlibustaSidecarEffective(book)) {
          res.type('application/xml; charset=utf-8');
          res.send(buffer.toString('utf8'));
        } else {
          let xml = buffer.toString('utf8');
          const encodingMatch = xml.match(/encoding=["']([^"']+)["']/i);
          const declaredEncoding = encodingMatch ? encodingMatch[1].toLowerCase() : '';
          if (declaredEncoding && declaredEncoding !== 'utf-8' && declaredEncoding !== 'utf8') {
            try {
              xml = iconv.decode(buffer, declaredEncoding);
            } catch {
              xml = buffer.toString('utf-8');
            }
            xml = xml.replace(/encoding=["'][^"']+["']/i, 'encoding="utf-8"');
          } else if (!encodingMatch && xml.includes('\uFFFD')) {
            xml = iconv.decode(buffer, 'win1251');
          }
          res.type('application/xml; charset=utf-8');
          res.send(xml);
        }
      } else if (ext === 'epub') {
        res.type('application/epub+zip');
        res.send(buffer);
      } else {
        res.type('application/octet-stream');
        res.send(buffer);
      }
    } catch (error) {
      next(error);
    }
  });
}
