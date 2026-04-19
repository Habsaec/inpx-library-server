/**
 * Book recommendation engine.
 * Builds personalized recommendations based on favorites, history, and bookmarks.
 */
import {
  getBooksByFacet,
  getReadingHistory,
  getFavoriteAuthors,
  getFavoriteSeries,
  getBookmarks,
  searchBooks
} from '../inpx.js';
import { t } from '../i18n.js';

const RECS_CACHE_TTL_MS = 30_000;
const recommendedViewCache = new Map();
const homeRecommendationsCache = new Map();

function pickFirstAuthor(authors = '') {
  return String(authors).split(':').map((s) => s.trim()).filter(Boolean)[0] || '';
}

function firstGenreValue(value = '') {
  return String(value).split(/[:,;]/).map((s) => s.trim()).find(Boolean) || '';
}

function dedupeBooks(items, excludeIds = []) {
  const excluded = new Set(excludeIds);
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || excluded.has(item.id) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function readTimedCache(store, key) {
  const item = store.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    store.delete(key);
    return null;
  }
  return item.value;
}

function writeTimedCache(store, key, value) {
  store.set(key, { value, expiresAt: Date.now() + RECS_CACHE_TTL_MS });
  if (store.size > 80) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

function createFacetFetchMemo() {
  const memo = new Map();
  return (facet, value, pageSize = 8, sort = 'recent') => {
    const key = `${facet}|${value}|${pageSize}|${sort}`;
    if (memo.has(key)) return memo.get(key);
    const items = getBooksByFacet({ facet, value, page: 1, pageSize, sort }).items;
    memo.set(key, items);
    return items;
  };
}

function buildHomeRecommendations({ favoriteAuthors, favoriteSeries, history, getFacetBooks }) {
  if (favoriteSeries.length > 0) {
    const items = favoriteSeries.flatMap((s) => getFacetBooks('series', s.name, 4, 'recent'));
    return dedupeBooks(items, history.map((h) => h.id)).slice(0, 12);
  }
  if (favoriteAuthors.length > 0) {
    const items = favoriteAuthors.flatMap((a) => getFacetBooks('authors', a.name, 4, 'recent'));
    return dedupeBooks(items, history.map((h) => h.id)).slice(0, 12);
  }
  return searchBooks({ query: '', field: 'all', page: 1, pageSize: 12, sort: 'recent' }).items;
}

function collectWeightedRecommendations({ favoriteAuthors, favoriteSeries, history, bookmarks, getFacetBooks, limit = 48 }) {
  const scored = new Map();
  const historyIds = new Set(history.map((h) => h.id));

  const addItems = (items, weight) => {
    for (const item of items) {
      if (!item?.id || historyIds.has(item.id)) continue;
      const existing = scored.get(item.id);
      if (existing) { existing.score += weight; continue; }
      scored.set(item.id, { item, score: weight });
    }
  };

  for (const series of favoriteSeries.slice(0, 8)) {
    addItems(getFacetBooks('series', series.name, 10, 'recent'), 9);
  }
  for (const author of favoriteAuthors.slice(0, 8)) {
    addItems(getFacetBooks('authors', author.name, 10, 'recent'), 8);
  }
  for (const item of history.slice(0, 10)) {
    const author = pickFirstAuthor(item.authors);
    const genre = firstGenreValue(item.genres);
    if (item.series) addItems(getFacetBooks('series', item.series, 8, 'recent'), 7);
    if (author) addItems(getFacetBooks('authors', author, 8, 'recent'), 5);
    if (genre) addItems(getFacetBooks('genres', genre, 8, 'recent'), 3);
  }
  for (const item of bookmarks.slice(0, 10)) {
    const author = pickFirstAuthor(item.authors);
    if (item.series) addItems(getFacetBooks('series', item.series, 8, 'recent'), 6);
    if (author) addItems(getFacetBooks('authors', author, 8, 'recent'), 4);
  }

  return [...scored.values()]
    .sort((a, b) => b.score !== a.score ? b.score - a.score : String(b.item.id).localeCompare(String(a.item.id)))
    .map((e) => e.item)
    .slice(0, limit);
}

export function getRecommendedLibraryView({ username = '', page = 1, pageSize = 24 }) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return { total: 0, items: [] };
  const cacheKey = `${normalizedUsername}|${page}|${pageSize}`;
  const cached = readTimedCache(recommendedViewCache, cacheKey);
  if (cached) return cached;

  const history = getReadingHistory(normalizedUsername, 24);
  const favoriteAuthors = getFavoriteAuthors(normalizedUsername, 12);
  const favoriteSeries = getFavoriteSeries(normalizedUsername, 12);
  const bookmarkItems = getBookmarks(normalizedUsername);
  const getFacetBooks = createFacetFetchMemo();
  const baseRecs = buildHomeRecommendations({ favoriteAuthors, favoriteSeries, history, getFacetBooks });
  const weightedRecs = collectWeightedRecommendations({
    favoriteAuthors, favoriteSeries, history, bookmarks: bookmarkItems, getFacetBooks, limit: 72
  });
  const recommended = dedupeBooks([...weightedRecs, ...baseRecs], history.map((h) => h.id));
  const offset = (page - 1) * pageSize;
  const result = { total: recommended.length, items: recommended.slice(offset, offset + pageSize) };
  writeTimedCache(recommendedViewCache, cacheKey, result);
  return result;
}

export function getHomeRecommendations({ username = '', favoriteAuthors = [], favoriteSeries = [], history = [] }) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return [];
  const cacheKey = `${normalizedUsername}|${favoriteAuthors.length}|${favoriteSeries.length}|${history.length}`;
  const cached = readTimedCache(homeRecommendationsCache, cacheKey);
  if (cached) return cached;
  if (favoriteSeries.length > 0 || favoriteAuthors.length > 0 || history.length > 0) {
    const getFacetBooks = createFacetFetchMemo();
    const items = buildHomeRecommendations({ favoriteAuthors, favoriteSeries, history, getFacetBooks }).slice(0, 8);
    writeTimedCache(homeRecommendationsCache, cacheKey, items);
    return items;
  }
  return [];
}

export function buildSimilarBooks(book) {
  if (book.series) {
    const items = getBooksByFacet({ facet: 'series', value: book.series, page: 1, pageSize: 8, sort: 'recent' }).items;
    return { title: t('book.otherInSeries'), items: dedupeBooks(items, [book.id]).slice(0, 8), hideDownloads: true };
  }
  const author = pickFirstAuthor(book.authors);
  if (author) {
    const items = getBooksByFacet({ facet: 'authors', value: author, page: 1, pageSize: 8, sort: 'recent' }).items;
    return { title: t('book.otherByAuthor'), items: dedupeBooks(items, [book.id]).slice(0, 8) };
  }
  const genre = firstGenreValue(book.genres);
  if (genre) {
    const items = getBooksByFacet({ facet: 'genres', value: genre, page: 1, pageSize: 8, sort: 'recent' }).items;
    return { title: t('book.similar'), items: dedupeBooks(items, [book.id]).slice(0, 8) };
  }
  return { title: t('book.similar'), items: [] };
}

export function buildFacetSummaryBooks(facet, value) {
  if (facet === 'authors') return getBooksByFacet({ facet: 'authors', value, page: 1, pageSize: 6, sort: 'title' }).items;
  if (facet === 'series') return getBooksByFacet({ facet: 'series', value, page: 1, pageSize: 6, sort: 'series' }).items;
  return [];
}
