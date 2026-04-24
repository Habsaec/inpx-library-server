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
  getReadBooks
} from '../inpx.js';
import { t } from '../i18n.js';

const RECS_CACHE_TTL_MS = 30_000;
const recommendedViewCache = new Map();

export function invalidateRecommendationsCache(username = '') {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) {
    recommendedViewCache.clear();
    return;
  }
  recommendedViewCache.delete(normalizedUsername);
}

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

function collectWeightedRecommendations({ favoriteAuthors, favoriteSeries, history, bookmarks, readBooks = [], getFacetBooks, limit = 48 }) {
  const scored = new Map();
  const excludeIds = new Set([
    ...history.map((h) => h.id),
    ...readBooks.map((b) => b.id)
  ]);

  const addItems = (items, weight) => {
    for (const item of items) {
      if (!item?.id || excludeIds.has(item.id)) continue;
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
  for (const item of readBooks.slice(0, 12)) {
    const author = pickFirstAuthor(item.authors);
    const genre = firstGenreValue(item.genres);
    if (item.series) addItems(getFacetBooks('series', item.series, 8, 'recent'), 10);
    if (author) addItems(getFacetBooks('authors', author, 8, 'recent'), 9);
    if (genre) addItems(getFacetBooks('genres', genre, 8, 'recent'), 4);
  }

  return [...scored.values()]
    .sort((a, b) => b.score !== a.score ? b.score - a.score : String(b.item.id).localeCompare(String(a.item.id)))
    .map((e) => e.item)
    .slice(0, limit);
}

/* ── Core recommendation builder (shared by home shelf and /library/recommended) ── */

function buildRecommendations(username, limit = 48) {
  const history = getReadingHistory(username, 24);
  const favoriteAuthors = getFavoriteAuthors(username, 12);
  const favoriteSeries = getFavoriteSeries(username, 12);
  const bookmarkItems = getBookmarks(username);
  const readBooks = getReadBooks(username);
  const getFacetBooks = createFacetFetchMemo();
  const weighted = collectWeightedRecommendations({
    favoriteAuthors, favoriteSeries, history, bookmarks: bookmarkItems, readBooks, getFacetBooks, limit
  });
  const allExcludeIds = [...history.map((h) => h.id), ...readBooks.map((b) => b.id)];
  return dedupeBooks(weighted, allExcludeIds);
}

export function getRecommendedLibraryView({ username = '', page = 1, pageSize = 24 }) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return { total: 0, items: [] };
  // Cache by username only — page slicing is O(1) from the cached full list
  const cacheKey = normalizedUsername;
  let recommended = readTimedCache(recommendedViewCache, cacheKey);
  if (!recommended) {
    recommended = buildRecommendations(normalizedUsername, 72);
    writeTimedCache(recommendedViewCache, cacheKey, recommended);
  }
  const offset = (page - 1) * pageSize;
  return { total: recommended.length, items: recommended.slice(offset, offset + pageSize) };
}

export function getHomeRecommendations({ username = '' }) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return [];
  // Reuse the same full view — take top 8 from page 1
  const view = getRecommendedLibraryView({ username: normalizedUsername, page: 1, pageSize: 8 });
  return view.items;
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
