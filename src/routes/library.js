import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { getSharp } from '../services/sharp-loader.js';
import {
  acquireSharpSlot,
  releaseSharpSlot,
  ALLOWED_BOOK_IMAGE_TYPES,
  detectImageMimeFromBuffer,
  normalizeBookImageForClient,
  getCachedCoverThumb,
  setCachedCoverThumb,
  getDiskCachedCoverThumb,
  setDiskCachedCoverThumb,
  invalidateCoverThumbCaches,
  getCoverWidth,
  getCoverHeight
} from '../services/cover.js';
import { config } from '../config.js';
import { t, tp, getLocale } from '../i18n.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { requireApiAuth, requireBrowseAuth, requireBrowseOrOpds, requireWebAuth, requireAdminWeb } from '../middleware/auth.js';
import { getCachedPageData, getStaleOrSchedule, clearPageDataCache, invalidateUserPageCaches } from '../services/cache.js';
import { logSystemEvent } from '../services/system-events.js';
import { getRecommendedLibraryView, getHomeRecommendations, buildSimilarBooks, listRecommendedSectionGenres } from '../services/recommendations.js';
import { bookPagePath, apiBookPath } from '../utils/book-ref.js';
import { safePage } from '../utils/safe-int.js';
import {
  DETAILS_CACHE_MAX,
  HOME_SECTIONS_CACHE_TTL_MS,
  PAGE_CACHE_TTL_MS
} from '../constants.js';
import {
  getUserShelves, getShelfById, getShelfBooks, setShelfOnHome, getSetting, getReadBookIdSet, getFullyReadSeriesNames, getUserStats,
  getAllReaderBookmarksPage, queryReaderAnnotations, getReaderAnnotationFacets,
  getUserByUsername, resolveTelegramRuntimeConfig, isTelegramBotAllowedForUser,
  getBookRating
} from '../db.js';
import { parseNotesFilter } from '../services/reader-notes.js';
import { isListBrowseView, resolveAuthorFacetView, resolveFacetBookLayout } from '../browse-view-prefs.js';
import { effectiveContentLangs, resolveContentLangFilter, contentLangCacheKey, listEnabledContentLangs } from '../user-content-langs.js';
import { resolveHideReadUser } from '../hide-read.js';
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
  getFavoriteAuthorsLight,
  getFavoriteSeriesLight,
  getIndexStatus,
  getBookmarksPage,
  getReadBooksPage,
  getLibrarySections,
  getLibraryView,
  updateBookMetadata,
  isBookmarked,
  isBookRead,
  isWantToRead,
  markFollowingSeen,
  getFollowingNewCount,
  getFollowingNewBooks,
  getSeriesReadingProgress,
  getSeriesReadCounts,
  isSeriesFullyRead,
  isFavoriteAuthor,
  isFavoriteSeries,
  listAuthors,
  listGenres,
  listAuthorsByGenre,
  listSeriesByGenre,
  listAuthorsByLanguage,
  listSeriesByLanguage,
  listLanguages,
  listSeries,
  resolveAuthorName,
  resolveSeriesCatalogName,
  recordReadingHistory,
  searchCatalog,
  searchOverview,
  getSourceRoot,
  effectiveSourceFlibustaForBook,
  splitAuthorValues,
  listGenresGrouped,
  listSearchGenres,
  hasContinueBooks,
  listRecentSectionGenres
} from '../inpx.js';
import { getDistinctFormats, parseGenreList, parseGenreMode, parseHasSeries } from '../inpx.js';
import { listSmartShelves, getSmartShelfBooks } from '../smart-shelves.js';
import { getOrExtractBookDetails, getStoredBookDetailsCover, bookUsesSevenZipArchive } from '../fb2.js';
import { parseEnvTimeoutMs, promiseWithTimeout } from '../utils/async-timeout.js';
import {
  readFlibustaCover,
  listFlibustaIllustrationsForBook,
  readFlibustaIllustrationForBook,
  readFlibustaAuthorPortraitForAuthorName,
  readFlibustaBookReviewHtml,
  readFlibustaAuthorBioHtml
} from '../flibusta-sidecar.js';
import { formatAuthorLabel, formatGenreLabel, formatLanguageLabel, getGenreGroup } from '../genre-map.js';
import { clearCardHtmlCache } from '../templates/shared.js';

// --- Library routes ---
// "First Last" display names (home quotes) vs "Last First Middle" in the index.
const looseAuthorNameCache = new Map();

function resolveAuthorNameLoose(name) {
  const key = name.toLowerCase();
  if (looseAuthorNameCache.has(key)) return looseAuthorNameCache.get(key);
  const found = listAuthors({ query: name, page: 1, pageSize: 1, sort: 'count' }).items[0]?.name || null;
  // Misses are not cached: the author may appear once indexing finishes.
  if (!found) return null;
  if (looseAuthorNameCache.size >= 500) looseAuthorNameCache.clear();
  looseAuthorNameCache.set(key, found);
  return found;
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

const COVER_RESOLVE_MS = parseEnvTimeoutMs('COVER_RESOLVE_TIMEOUT_MS', 8_000);
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

      /* Solid .7z: извлечение FB2 ради обложки каталога занимает десятки секунд,
         держит 7z-слоты и замораживает Android (таймаут → reconnect loop). */
      if (bookUsesSevenZipArchive(book)) return { cover: null };

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
    for (; ;) {
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

function getHomeNewestDisplayCount() {
  const stored = String(getSetting('home_newest_count') || '').trim();
  if (stored) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 200) {
      return Math.trunc(parsed);
    }
  }
  return config.homeNewestCount;
}

const HOME_SHELVES_MAX = 8;

/** Полки (обычные и умные), закреплённые пользователем на главной; пустые не показываем. */
export function getPinnedHomeShelves(username, limit) {
  const result = [];
  const contentLangs = effectiveContentLangs(username);
  for (const shelf of getUserShelves(username)) {
    if (!shelf.onHome) continue;
    result.push({ id: shelf.id, kind: 'shelf', title: shelf.name, href: `/shelves/${shelf.id}`, items: getShelfBooks(shelf.id, username).slice(0, limit) });
  }
  for (const shelf of listSmartShelves(username)) {
    if (!shelf.onHome) continue;
    try {
      result.push({ id: shelf.id, kind: 'smart', title: shelf.name, href: shelf.catalogUrl, items: getSmartShelfBooks(shelf, { page: 1, pageSize: limit, langs: contentLangs }).items });
    } catch { /* битый фильтр не должен ломать главную */ }
  }
  return result.filter((shelf) => shelf.items.length).slice(0, HOME_SHELVES_MAX);
}

/** `?lang=` on author / series / genre pages, narrowed by the profile languages. */
function facetLangState(username, rawLang) {
  const requested = String(rawLang || '').trim().toLowerCase();
  const lang = /^[a-z]{2,8}$/.test(requested) ? requested : '';
  const contentLangs = effectiveContentLangs(username);
  const enabled = listEnabledContentLangs();
  const filter = resolveContentLangFilter(username, lang);
  return {
    lang,
    options: contentLangs.length ? enabled.filter((code) => contentLangs.includes(code)) : enabled,
    filter,
    list: filter.lang ? [filter.lang] : filter.langs
  };
}

// --- Exported accessors for other modules ---

export { detailsCache, getDetails, getDetailsFull, clearBookDetailsCache, bookFlibustaSidecarEffective, resolveBestCoverDetails };

// --- Route registration ---

export function registerLibraryRoutes(app, deps) {
  const {
    getCachedStats,
    templates: {
      renderHome, renderCatalog, renderLibraryView, renderBrowsePage,
      renderFacetBooks, renderAuthorFacetPage, renderAuthorOutsideSeriesPage,
      renderBook, renderFavorites, renderShelves, renderShelfDetail, renderReader,
      renderMyLibrary, renderReaderBookmarksPage, renderReaderNotesPage
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
    const DISPLAY_COUNT = getHomeNewestDisplayCount();
    let displayNewest = sections.newest;
    if (displayNewest.length > DISPLAY_COUNT) {
      const shuffled = displayNewest.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      displayNewest = shuffled.slice(0, DISPLAY_COUNT);
    }
    const contentLangs = effectiveContentLangs(username);
    if (contentLangs.length) {
      const allowed = new Set(contentLangs);
      displayNewest = displayNewest.filter((book) => allowed.has(String(book?.lang || '').trim().toLowerCase()));
    }
    const displaySections = { ...sections, newest: displayNewest };
    const hasContinueData = username ? hasContinueBooks(username) : false;
    const readBookIds = username ? getReadBookIdSet(username) : null;
    const listView = isListBrowseView({ username, queryView: req.query.view, scope: 'home' });
    const canUseAnonymousHomeHtmlCache = !user && !listView && !indexStatus?.active && !indexStatus?.error;
    const csrfToken = req.csrfToken || '';
    const homeSubtitle = getSetting('home_subtitle') || '';
    const homeShelves = username ? getPinnedHomeShelves(username, DISPLAY_COUNT) : [];
    // «Новое у любимых» as the first shelf (web only; /api/home/shelves keeps its two kinds).
    if (username) {
      try {
        const following = getCachedPageData(
          `library:following:${username}:home:${contentLangCacheKey(contentLangs)}:${DISPLAY_COUNT}`,
          () => getFollowingNewBooks(username, { page: 1, pageSize: DISPLAY_COUNT, langs: contentLangs.length ? contentLangs : null }),
          PAGE_CACHE_TTL_MS
        );
        if (following.items.length) {
          homeShelves.unshift({ id: 'following', kind: 'following', title: t('home.followingShelf'), href: '/library/following', items: following.items });
        }
      } catch (err) {
        console.warn('[home] following shelf failed:', err.message);
      }
    }
    const html = canUseAnonymousHomeHtmlCache
      ? getCachedPageData(`page:home:anon:${getLocale()}`, () => renderHome({ user, stats, indexStatus, sections: displaySections, homeSubtitle, csrfToken: '', hasContinueData: false, listView: false }), 1000 * 60 * 2)
      : renderHome({ user, stats, indexStatus, sections: displaySections, homeSubtitle, csrfToken, hasContinueData, readBookIds, listView, homeShelves });
    res.send(html);
    // Фоновый прогрев per-user кэшей для последующих переходов
    if (username) {
      setImmediate(() => { try { getReadBookIdSet(username); } catch { } });
    }
  });

  app.get('/api/home/shelves', requireApiAuth, (req, res) => {
    res.json({ items: getPinnedHomeShelves(req.user.username, getHomeNewestDisplayCount()) });
  });

  // --- Catalog search ---
  app.get('/catalog', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const genres = parseGenreList(req.query.genre);
    const genre = genres.join(',');
    const genreMode = parseGenreMode(req.query.genreMode);
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const lang = String(req.query.lang || '').trim();
    const format = String(req.query.format || '').trim();
    const year = Number(req.query.year) || 0;
    const minRate = Math.min(5, Math.max(0, Math.floor(Number(req.query.minRate) || 0)));
    const hasSeries = parseHasSeries(req.query.hasSeries);
    const fieldRaw = String(req.query.field || '').trim();
    const hasExplicitField = ['books', 'authors', 'series'].includes(fieldRaw);
    const stats = getCachedStats();
    const user = req.user || null;
    const readBookIds = user ? getReadBookIdSet(user.username) : null;

    // Enter / free-text search → books immediately (authors & series via chips).
    const field = hasExplicitField ? fieldRaw : 'books';
    const isBookField = field === 'books';
    const bookSorts = ['recent', 'title', 'author', 'series', 'rating'];
    const entitySorts = ['name', 'count'];
    const allowedSorts = isBookField ? bookSorts : entitySorts;
    const requestedSort = String(req.query.sort || '');
    const entityDefault = String(query || '').trim() ? 'count' : 'name';
    const sort = allowedSorts.includes(requestedSort) ? requestedSort : (isBookField ? 'title' : entityDefault);
    const order = String(req.query.order || '');
    const page = safePage(req.query.page);
    const pageSize = 24;
    const username = user?.username || '';
    const contentLangs = effectiveContentLangs(username);
    const langFilter = resolveContentLangFilter(username, lang);
    const hideReadUser = resolveHideReadUser(req);
    const cacheKey = `catalog:v5:${field}:${sort}:${order}:${genre}:${genreMode}:${letter}:${lang}:${contentLangCacheKey(contentLangs)}:${format}:${year}:${minRate}:${hasSeries}:${query}:p${page}:r:${hideReadUser}`;
    const result = getCachedPageData(cacheKey, () => searchCatalog({
      query, field, page, pageSize, sort, order, genre, genreMode, letter,
      lang: langFilter.lang, langs: langFilter.langs, format, year, minRate, hasSeries, hideReadUser
    }));
    const allLangs = listEnabledContentLangs();
    const langs = contentLangs.length
      ? allLangs.filter((code) => contentLangs.includes(String(code).toLowerCase()))
      : allLangs;
    const formats = getDistinctFormats();
    const allGenreOptions = getCachedPageData('catalog:genre-options', () => listGenresGrouped({ sort: 'name' }), PAGE_CACHE_TTL_MS);
    // Faceted genres: when search/filters active, only genres present in matching books.
    const hasGenreScope = Boolean(
      query.trim()
      || lang
      || contentLangs.length
      || format
      || year
      || minRate >= 1
      || hasSeries === 0
      || hasSeries === 1
    );
    let genreOptions = allGenreOptions;
    let genreOptionsLazy = false;
    if (isBookField && hasGenreScope) {
      const byName = new Map(allGenreOptions.map((g) => [g.name, g]));
      const allowed = new Set(allGenreOptions.map((g) => g.name));
      let items = [];
      const resultTotal = Math.max(0, Math.floor(Number(result.total) || 0));
      /*
       * Free-text search: load scoped genres lazily in the browser so «Книги»
       * HTML is not blocked by a second MATCH + GROUP BY.
       * Small result sets still resolve inline from the page items.
       */
      if (
        query.trim()
        && resultTotal > 0
        && resultTotal <= pageSize
        && Array.isArray(result.items)
        && result.items.length
      ) {
        const seen = new Set();
        for (const book of result.items) {
          const genreNames = Array.isArray(book.genresList) && book.genresList.length
            ? book.genresList
            : String(book.genres || '').split(/[:;,]/).map((s) => s.trim()).filter(Boolean);
          for (const name of genreNames) {
            if (!name || seen.has(name) || !allowed.has(name)) continue;
            seen.add(name);
            const fromAll = byName.get(name);
            items.push({
              name,
              displayName: fromAll?.displayName || name
            });
          }
        }
      } else if (query.trim()) {
        genreOptionsLazy = true;
        items = [];
      } else {
        const scoped = getCachedPageData(
          `catalog:search-genres:${query.trim()}:${lang}:${contentLangCacheKey(contentLangs)}:${format}:${year}:${minRate}:${hasSeries}`,
          () => listSearchGenres({
            query: query.trim(), lang: langFilter.lang, langs: langFilter.langs, format, year, minRate, hasSeries
          }),
          PAGE_CACHE_TTL_MS
        );
        items = (scoped.items || []).filter((g) => g?.name && allowed.has(g.name));
      }
      for (const selected of genres) {
        if (!items.some((g) => g.name === selected)) {
          const fromAll = byName.get(selected);
          items = [{
            name: selected,
            displayName: fromAll?.displayName || selected
          }, ...items];
        }
      }
      if (items.length) genreOptions = items;
      else if (genreOptionsLazy) genreOptions = [];
    }
    const searchNav = query.trim()
      ? getCachedPageData(
        `catalog:search-nav:${query.trim()}`,
        () => {
          const overview = searchOverview({
            query: query.trim(),
            ...(field === 'books'
              ? { booksTotal: result.total, booksCapped: Boolean(result.capped) }
              : {})
          });
          return {
            books: overview.books,
            authors: overview.authors,
            series: overview.series
          };
        },
        PAGE_CACHE_TTL_MS
      )
      : null;
    const listView = isListBrowseView({ username: user?.username || '', queryView: req.query.view, scope: 'catalog' });
    res.send(renderCatalog({
      ...result, page, pageSize, query, field, sort, order, genre, genres, genreMode, letter, lang, format, year,
      minRate, hasSeries, langs, formats, genreOptions, genreOptionsLazy, searchNav,
      view: listView ? 'list' : '',
      user, stats,
      indexStatus: getIndexStatus(), csrfToken: req.csrfToken || '', readBookIds
    }));
  });

  // --- Library views ---
  app.get('/library/:view(recent|continue|read|recommended|want|following|rated)', requireBrowseAuth, (req, res) => {
    const view = String(req.params.view || 'recent');
    const page = safePage(req.query.page);
    const pageSize = 24;
    const type = String(req.query.type || '').trim();
    const requestedSort = String(req.query.sort || '');
    const defaultSort = view === 'recent' ? 'recent' : view === 'recommended' ? 'relevance' : view === 'rated' ? 'rating' : 'title';
    const allowedSorts = view === 'recommended'
      ? ['relevance', 'title', 'rating', 'author', 'recent']
      : ['recent', 'title', 'author', 'series', 'rating'];
    const sort = allowedSorts.includes(requestedSort) ? requestedSort : defaultSort;
    const order = String(req.query.order || '');
    const user = req.user || null;
    const listView = isListBrowseView({ username: user?.username || '', queryView: req.query.view, scope: 'catalog' });
    const stats = getCachedStats();
    const titles = {
      recent: t('library.title.recent'),
      continue: t('library.title.continue'),
      read: t('library.title.read'),
      recommended: t('library.title.recommended'),
      want: t('library.title.want'),
      following: t('library.title.following'),
      rated: t('library.title.rated')
    };
    const subtitles = {
      recent: t('library.sub.recent'),
      continue: t('library.sub.continue'),
      read: t('library.sub.read'),
      recommended: t('library.sub.recommended'),
      want: t('library.sub.want'),
      following: t('library.sub.following'),
      rated: t('library.sub.rated')
    };
    const genres = parseGenreList(req.query.genre);
    const genre = genres.join(',');
    const genreMode = parseGenreMode(req.query.genreMode);
    const lang = String(req.query.lang || '').trim();
    const format = String(req.query.format || '').trim();
    const year = Number(req.query.year) || 0;
    const minRate = Math.min(5, Math.max(0, Math.floor(Number(req.query.minRate) || 0)));
    const hasSeries = parseHasSeries(req.query.hasSeries);
    const username = user?.username || '';
    const contentLangs = effectiveContentLangs(username);
    const langFilter = resolveContentLangFilter(username, lang);
    const hideReadUser = view === 'recent' ? resolveHideReadUser(req) : '';
    const filterKey = `${genre}:${genreMode}:${lang}:${contentLangCacheKey(contentLangs)}:${format}:${year}:${minRate}:${hasSeries ?? ''}:r:${hideReadUser}`;
    const canUseSharedCache = view === 'recent';
    const libraryOpts = {
      page, pageSize, sort, order, genre, genreMode,
      lang: langFilter.lang, langs: langFilter.langs, format, year, minRate, hasSeries, hideReadUser
    };
    const result = canUseSharedCache
      ? getStaleOrSchedule(
        `library:${view}:v7:sort:${sort}:${order}:f:${filterKey}:page:${page}:size:${pageSize}`,
        () => getLibraryView(view, libraryOpts),
        PAGE_CACHE_TTL_MS,
        { total: 0, items: [] }
      )
      : view === 'recommended'
        ? getRecommendedLibraryView({
          page, pageSize, username, genre, genreMode,
          lang: langFilter.lang, langs: langFilter.langs, format, year, minRate, hasSeries, sort
        })
        : getStaleOrSchedule(
          `library:${view}:${user?.username || ''}:sort:${sort}:${order}:p${page}:s${pageSize}`,
          () => getLibraryView(view, { ...libraryOpts, username: user?.username || '', type }),
          PAGE_CACHE_TTL_MS,
          { total: 0, items: [] }
        );
    // «Мои оценки»: the cover stars show the user's own rating, not the catalog one.
    if (view === 'rated' && Array.isArray(result.items)) {
      result.items = result.items.map((item) => ({ ...item, libRate: item.myRating || item.libRate }));
    }
    // Opening «Новое у любимых» clears its sidebar badge (before the sidebar is rendered below).
    if (view === 'following' && user && page === 1) markFollowingSeen(user.username);
    const isReadSeriesList = view === 'read' && result.itemType === 'series';
    const readBookIds = user && !isReadSeriesList ? getReadBookIdSet(user.username) : null;
    const readSeriesNames = user && isReadSeriesList ? getFullyReadSeriesNames(user.username) : null;
    const showFilters = view === 'recent' || view === 'recommended';
    const allLangs = showFilters ? listEnabledContentLangs() : [];
    const langs = contentLangs.length
      ? allLangs.filter((code) => contentLangs.includes(String(code).toLowerCase()))
      : allLangs;
    const formats = showFilters ? getDistinctFormats() : [];
    const extraFilterKey = `${lang}:${contentLangCacheKey(contentLangs)}:${format}:${year}:${minRate}:${hasSeries ?? ''}`;
    const genreOptions = view === 'recent'
      ? getCachedPageData(
        `library:recent:genres:${extraFilterKey}`,
        () => listRecentSectionGenres({
          lang: langFilter.lang, langs: langFilter.langs, format, year, minRate, hasSeries
        }),
        PAGE_CACHE_TTL_MS
      )
      : view === 'recommended'
        ? listRecommendedSectionGenres({
          username: user?.username || '',
          lang, format, year, minRate, hasSeries
        })
        : [];
    res.send(renderLibraryView({
      view,
      title: titles[view] || t('library.titleFallback'),
      subtitle: subtitles[view] || '',
      ...result,
      page,
      pageSize,
      type,
      sort,
      order,
      listView,
      user,
      stats,
      indexStatus: getIndexStatus(),
      csrfToken: req.csrfToken || '',
      readBookIds,
      readSeriesNames,
      computing: Boolean(result.computing),
      genres,
      lang,
      format,
      year,
      minRate,
      hasSeries,
      genreMode,
      langs,
      formats,
      genreOptions
    }));
  });

  // --- Browse pages ---
  app.get('/authors', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const sort = String(req.query.sort || 'name');
    const order = String(req.query.order || '');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const startsWith = query.length <= 2;
    const stats = getCachedStats();
    const authorLangs = effectiveContentLangs(req.user?.username);
    const cacheKey = `browse:authors:${contentLangCacheKey(authorLangs)}:${page}:${sort}:${order}:${letter}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listAuthors({ query, page, pageSize, sort, order, startsWith, letter, langs: authorLangs }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderBrowsePage({
      title: t('nav.authors'),
      ...result, page, pageSize, user: req.user || null, stats, query, letter,
      path: '/authors', facetBasePath: '/facet/authors',
      indexStatus: getIndexStatus(), sort, order, csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/series', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const sort = String(req.query.sort || 'name');
    const order = String(req.query.order || '');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();
    const seriesLangs = effectiveContentLangs(req.user?.username);
    const cacheKey = `browse:series:${contentLangCacheKey(seriesLangs)}:${page}:${sort}:${order}:${letter}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listSeries({ query, page, pageSize, sort, order, letter, langs: seriesLangs }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    const username = req.user?.username || '';
    res.send(renderBrowsePage({
      title: t('nav.series'),
      ...result, page, pageSize, user: req.user || null, stats, query, letter,
      path: '/series', facetBasePath: '/facet/series',
      indexStatus: getIndexStatus(), sort, order, csrfToken: req.csrfToken || '',
      readSeriesNames: username ? getFullyReadSeriesNames(username) : null
    }));
  });


  app.get('/genres', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const sort = String(req.query.sort || 'name');
    const order = String(req.query.order || '');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();
    const genreLangs = effectiveContentLangs(req.user?.username);
    const cacheKey = `browse:genres:${contentLangCacheKey(genreLangs)}:${page}:${sort}:${order}:${letter}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listGenres({ query, page, pageSize, sort, order, letter, langs: genreLangs }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderBrowsePage({
      title: t('nav.genres'),
      ...result, page, pageSize, user: req.user || null, stats, query, letter,
      path: '/genres', facetBasePath: '/facet/genres',
      indexStatus: getIndexStatus(), sort, order, csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/languages', requireBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const sort = String(req.query.sort || 'name');
    const order = String(req.query.order || '');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();
    const languageLangs = effectiveContentLangs(req.user?.username);
    const cacheKey = `browse:languages:${contentLangCacheKey(languageLangs)}:${page}:${sort}:${order}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listLanguages({ query, page, pageSize, sort, order, langs: languageLangs }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderBrowsePage({
      title: t('nav.languages'),
      ...result, page, pageSize, user: req.user || null, stats, query,
      path: '/languages', facetBasePath: '/facet/languages',
      indexStatus: getIndexStatus(), sort, order, csrfToken: req.csrfToken || ''
    }));
  });

  // --- Facet pages ---
  app.get('/facet/authors/:value/outside-series', requireBrowseAuth, async (req, res, next) => {
    try {
      const requestedSort = String(req.query.sort || 'title');
      const sort = requestedSort === 'recent' ? 'recent' : 'title';
      const order = String(req.query.order || '');
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
      const bookLayout = resolveFacetBookLayout({ queryLayout: req.query.layout, username });
      const langState = facetLangState(username, req.query.lang);
      const grouped = await getAuthorBooksGroupedCoalesced(value, sort, order, {
        page: p, pageSize, langs: langState.list, hideReadUser: resolveHideReadUser(req)
      });
      const facetPath = `/facet/authors/${encodeURIComponent(value)}/outside-series`;
      res.send(
        renderAuthorOutsideSeriesPage({
          title: t('authorPage.outsideSeries'),
          displayName: displayValue,
          books: grouped.standaloneBooks,
          total: grouped.standaloneBooks.length,
          user: req.user || null, stats,
          indexStatus: getIndexStatus(), sort, order, facetPath, breadcrumbs,
          favorite, facetValue: value, csrfToken: req.csrfToken || '',
          page: p, pageSize, hasMore: grouped.standaloneBooks.length >= pageSize,
          listView: bookLayout === 'list', layout: bookLayout,
          readBookIds: username ? getReadBookIdSet(username) : null,
          lang: langState.lang, langs: langState.options
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get('/facet/:facet/:value', requireBrowseAuth, async (req, res, next) => {
    try {
      const facetType = String(req.params.facet || '');
      const sort = String(req.query.sort || (facetType === 'series' || facetType === 'authors' ? 'series' : 'title'));
      const order = String(req.query.order || '');
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
      const langState = facetLangState(username, facet === 'languages' ? '' : req.query.lang);

      if (facet === 'authors') {
        const authorSort = ['recent', 'series', 'count'].includes(sort) ? sort : 'series';
        const flibSourceId = getAuthorFlibustaSourceId(value);
        const facetRoot = flibSourceId != null ? getSourceRoot(flibSourceId) : '';
        const p = safePage(req.query.page, 1);
        const pageSize = 48;
        const authorView = resolveAuthorFacetView({ queryView: req.query.view, username });

        const [grouped, fullSummary, authorPortraitUrl, authorBioHtml] = await Promise.all([
          getAuthorBooksGroupedCoalesced(value, authorSort, order, {
            page: p, pageSize, langs: langState.list, hideReadUser: resolveHideReadUser(req)
          }),
          Promise.resolve(getFacetSummary(facet, value)),
          flibSourceId != null
            ? promiseWithTimeout(
              readFlibustaAuthorPortraitForAuthorName(value, facetRoot),
              COVER_RESOLVE_MS,
              'author portrait'
            )
              .then(pic => pic?.data?.length ? `/api/authors/portrait?name=${encodeURIComponent(value)}` : '')
              .catch(() => '')
            : Promise.resolve(''),
          flibSourceId != null
            ? promiseWithTimeout(
              readFlibustaAuthorBioHtml(value, facetRoot, flibSourceId),
              COVER_RESOLVE_MS,
              'author bio'
            ).catch(() => '')
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
            indexStatus: getIndexStatus(), sort: authorSort, order, view: authorView, breadcrumbs, summary,
            facetValue: value, favorite, authorPortraitUrl, authorBioHtml,
            csrfToken: req.csrfToken || '',
            page: p, pageSize, hasMore: grouped.standaloneBooks.length >= pageSize,
            readSeriesNames: username ? getFullyReadSeriesNames(username) : null,
            seriesReadCounts: username ? getSeriesReadCounts(username) : null,
            lang: langState.lang, langs: langState.options
          })
        );
        return;
      }

      // Mode switcher for genre/language pages: ?view=authors|series groups books by entity
      // so big sub-genres (10k+ books) become navigable instead of a flat dump.
      // Book rows vs covers use `layout`, because `view` is already that switcher.
      const bookLayout = resolveFacetBookLayout({ queryLayout: req.query.layout, username });
      const hasEntityView = facet === 'genres' || facet === 'languages';
      const allowedViews = hasEntityView ? ['books', 'authors', 'series'] : ['books'];
      const requestedView = String(req.query.view || (hasEntityView ? 'authors' : 'books'));
      const view = allowedViews.includes(requestedView) ? requestedView : 'books';

      if (hasEntityView && view !== 'books') {
        const entityPageSize = 50;
        const entitySort = ['count', 'name'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'count';
        // Агрегация авторов/серий по жанру/языку — тяжёлый GROUP BY по всему фасету.
        // Кэшируем (stale-while-revalidate), как на /authors, чтобы повторные заходы
        // на крупный жанр/язык не гоняли многосекундный синхронный подсчёт.
        const entityLangs = langState.list;
        const entityCacheKey = `facet:entity:${entityLangs.join(',')}:${facet}:${view}:${value}:${entitySort}:p${page}`;
        const entityResult = getStaleOrSchedule(entityCacheKey, () => {
          if (facet === 'genres') {
            return view === 'authors'
              ? listAuthorsByGenre({ genre: value, page, pageSize: entityPageSize, sort: entitySort, langs: entityLangs })
              : listSeriesByGenre({ genre: value, page, pageSize: entityPageSize, sort: entitySort, langs: entityLangs });
          }
          return view === 'authors'
            ? listAuthorsByLanguage({ lang: value, page, pageSize: entityPageSize, sort: entitySort, langs: entityLangs })
            : listSeriesByLanguage({ lang: value, page, pageSize: entityPageSize, sort: entitySort, langs: entityLangs });
        }, PAGE_CACHE_TTL_MS, { total: 0, items: [] });
        const summary = getFacetSummary(facet, value);
        res.send(renderFacetBooks({
          title: tp('facet.titleWithValue', { label: facetLabels[facet] || t('facet.sectionFallback'), value: displayValue }),
          items: [], total: entityResult.total, page, pageSize: entityPageSize,
          summary,
          user: req.user || null, stats, facetPath,
          indexStatus: getIndexStatus(), sort: entitySort, order, facet, facetValue: value,
          favorite, seriesRead: false, breadcrumbs, csrfToken: req.csrfToken || '',
          readBookIds: null,
          view, entityItems: entityResult.items,
          listView: bookLayout === 'list', layout: bookLayout,
          lang: langState.lang, langs: langState.options
        }));
        return;
      }

      let authorFilter = facet === 'series' ? String(req.query.author || '').trim() : '';
      if (authorFilter) {
        const canonical = resolveAuthorName(authorFilter);
        authorFilter = canonical ?? authorFilter.toLowerCase();
      }
      const result = await getBooksByFacetCoalesced({
        facet, value, page, pageSize, sort, order, author: authorFilter,
        lang: langState.filter.lang, langs: langState.filter.langs, hideReadUser: resolveHideReadUser(req)
      });
      const summary = getFacetSummary(facet, value);
      const seriesRead = facet === 'series' && username ? isSeriesFullyRead(username, value) : false;
      let seriesProgress = null;
      // Whole series even under ?author= (the usual link from author / book pages).
      if (facet === 'series' && username) {
        try {
          seriesProgress = getSeriesReadingProgress(username, value, { langs: langState.list });
        } catch (err) {
          console.warn('[series] progress failed:', err.message);
        }
      }
      res.send(renderFacetBooks({
        title: tp('facet.titleWithValue', { label: facetLabels[facet] || t('facet.sectionFallback'), value: displayValue }),
        ...result, summary, page, pageSize,
        user: req.user || null, stats, facetPath,
        indexStatus: getIndexStatus(), sort, order, facet, facetValue: value,
        favorite, seriesRead, seriesProgress, breadcrumbs, csrfToken: req.csrfToken || '',
        readBookIds: username ? getReadBookIdSet(username) : null,
        view, authorFilter,
        listView: bookLayout === 'list', layout: bookLayout,
        lang: langState.lang, langs: langState.options
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
      const wantToRead = username && !isRead ? isWantToRead(username, book.id) : false;
      const myRating = username ? getBookRating(username, book.id) : 0;
      const similarBooks = buildSimilarBooks(book);
      const tgRuntime = username ? resolveTelegramRuntimeConfig() : null;
      const telegramSendAvailable = Boolean(
        tgRuntime?.enabled && tgRuntime.token && isTelegramBotAllowedForUser(getUserByUsername(username))
      );

      res.send(
        renderBook({
          book, details, bookmarked, isRead, wantToRead, myRating, user, telegramSendAvailable,
          stats: getCachedStats(),
          indexStatus: getIndexStatus(),
          similarBooks, csrfToken: req.csrfToken || '',
          authorBioHtml: '', authorPortraitUrl: '',
          illustrationUrls: [],
          flash: String(req.query.flash || ''),
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
    const { title, authors, series, seriesNo, genres, lang, date, keywords, libRate } = req.body;
    if (!title || !String(title).trim()) {
      return res.redirect(`${bookPagePath(bookId)}?flash=` + encodeURIComponent(t('book.edit.titleRequired')));
    }
    try {
      const ok = updateBookMetadata(bookId, {
        title: String(title).trim(),
        authors: String(authors || '').trim(),
        series: String(series || '').trim(),
        seriesNo: String(seriesNo || '').trim(),
        genres: String(genres || '').trim(),
        lang: String(lang || '').trim(),
        date: String(date || '').trim(),
        keywords: String(keywords || '').trim(),
        libRate: String(libRate || '').trim()
      });
      detailsCache.delete(bookId);
      clearPageDataCache();
      clearCardHtmlCache();
      logSystemEvent('info', 'operations', 'book metadata edited', { actor: req.user.username, bookId });
      const msg = ok ? t('book.edit.saved') : t('book.edit.notFound');
      res.redirect(`${bookPagePath(bookId)}?flash=` + encodeURIComponent(msg));
    } catch (error) {
      res.redirect(`${bookPagePath(bookId)}?flash=` + encodeURIComponent(error.message));
    }
  });

  // --- Favorites & shelves ---
  app.get('/favorites', requireWebAuth, (req, res) => {
    const stats = getCachedStats();
    const view = ['books', 'read', 'authors', 'series'].includes(String(req.query.view || '')) ? String(req.query.view) : 'books';
    const sort = ['title', 'author', 'date', 'rating', 'name', 'count'].includes(String(req.query.sort || '')) ? String(req.query.sort) : 'title';
    const order = String(req.query.order || '');
    const page = safePage(req.query.page);
    const pageSize = 24;
    const username = req.user.username;
    const userStats = getUserStats(username);
    let books = [];
    let readBooks = [];
    let authors = [];
    let series = [];
    let total = 0;
    if (view === 'books') {
      const result = getBookmarksPage(username, { sort, page, pageSize });
      books = result.items;
      total = result.total;
    } else if (view === 'read') {
      const result = getReadBooksPage(username, { sort, page, pageSize });
      readBooks = result.items;
      total = result.total;
    } else if (view === 'authors') {
      const authorSort = ['name', 'count', 'date'].includes(sort) ? sort : 'name';
      authors = getFavoriteAuthors(username, 50, authorSort, order);
    } else if (view === 'series') {
      const seriesSort = ['name', 'count', 'date'].includes(sort) ? sort : 'name';
      series = getFavoriteSeries(username, 50, seriesSort, order);
    }
    const readBookIds = view === 'books' || view === 'read' ? getReadBookIdSet(username) : null;
    const readSeriesNames = view === 'series' ? getFullyReadSeriesNames(username) : null;
    res.send(renderFavorites({
      books, readBooks, authors, series, view, sort, order, page, pageSize, total,
      user: req.user, stats, indexStatus: getIndexStatus(), csrfToken: req.csrfToken || '',
      readBookIds, readSeriesNames, userStats
    }));
  });

  app.get('/shelves', requireWebAuth, (req, res) => {
    const stats = getCachedStats();
    const shelves = getUserShelves(req.user.username);
    res.send(renderShelves({ shelves, smartShelves: listSmartShelves(req.user.username, { withPreview: true }), user: req.user, stats, indexStatus: getIndexStatus(), csrfToken: req.csrfToken || '' }));
  });

  app.post('/shelves/:id/home', requireWebAuth, (req, res) => {
    setShelfOnHome(Number(req.params.id), req.user.username, req.body?.on === '1');
    res.redirect(303, '/shelves');
  });

  // --- «Моя библиотека»: хаб (нижняя навигация), закладки и заметки читалки ---
  app.get('/library/my', requireWebAuth, (req, res) => {
    res.send(renderMyLibrary({
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(),
      userStats: {
        ...getUserStats(req.user.username),
        followingNewCount: getFollowingNewCount(req.user.username, { langs: effectiveContentLangs(req.user.username) })
      },
      csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/library/bookmarks', requireWebAuth, (req, res) => {
    const page = safePage(req.query.page);
    const pageSize = 30;
    const result = getAllReaderBookmarksPage(req.user.username, { page, pageSize });
    res.send(renderReaderBookmarksPage({
      items: result.items, total: result.total, page, pageSize,
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(), csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/library/notes', requireWebAuth, (req, res) => {
    const page = safePage(req.query.page);
    const pageSize = 50;
    const filter = parseNotesFilter(req.query);
    const result = queryReaderAnnotations(req.user.username, { ...filter, page, pageSize });
    res.send(renderReaderNotesPage({
      items: result.items, total: result.total, page, pageSize, filter,
      facets: getReaderAnnotationFacets(req.user.username, { bookId: filter.bookId, q: filter.q }),
      user: req.user, stats: getCachedStats(), indexStatus: getIndexStatus(), csrfToken: req.csrfToken || ''
    }));
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
      const details = await promiseWithTimeout(
        resolveBestCoverDetails(book),
        COVER_RESOLVE_MS,
        `cover ${book.id}`
      ).catch(() => null);
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
      const details = await promiseWithTimeout(
        resolveBestCoverDetails(book),
        COVER_RESOLVE_MS,
        `cover-thumb ${bookId}`
      ).catch(() => null);
      const coverMimeHead = detectImageMimeFromBuffer(details?.cover?.data);
      if (!coverMimeHead || !ALLOWED_BOOK_IMAGE_TYPES.has(coverMimeHead)) {
        invalidateCoverThumbCaches(book.id);
        return res.status(404).end();
      }

      let coverBuffer = details.cover.data;
      let coverMime = coverMimeHead;

      let outBuf = coverBuffer;
      let outType = 'image/webp';
      const sharp = await getSharp();
      if (sharp) {
        let gotSlot = false;
        try {
          await acquireSharpSlot();
          gotSlot = true;
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
          if (gotSlot) releaseSharpSlot();
        }
      } else {
        /* Обработка отключена — отдаём оригинал без ресайза */
        outType = coverMime;
        outBuf = coverBuffer;
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
          url: `${apiBookPath(book.id, `illustration/${x.index}`)}`
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
      const pic = await promiseWithTimeout(
        readFlibustaAuthorPortraitForAuthorName(primaryAuthor, root),
        COVER_RESOLVE_MS,
        `author-photo ${book.id}`
      ).catch(() => null);
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
      let name = String(req.query.name || '').trim();
      if (!name) {
        return res.status(400).end();
      }
      const resolved = resolveAuthorName(name) || resolveAuthorNameLoose(name);
      if (resolved) name = resolved;
      const sourceId = getAuthorFlibustaSourceId(name);
      if (sourceId == null) {
        return res.status(404).end();
      }
      const root = getSourceRoot(sourceId);
      const pic = await promiseWithTimeout(
        readFlibustaAuthorPortraitForAuthorName(name, root),
        COVER_RESOLVE_MS,
        'authors/portrait'
      ).catch(() => null);
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
        invalidateUserPageCaches(username);
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
