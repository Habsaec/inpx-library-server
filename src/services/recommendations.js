/**
 * Book recommendation engine.
 * Builds personalized recommendations based on favorites, history, and bookmarks.
 */
import {
  getBooksByFacet,
  getBooksByFacetLight,
  getReadingHistory,
  getFavoriteAuthorsLight,
  getFavoriteSeriesLight,
  getBookmarks,
  getReadBooks,
  splitAuthorValues,
  parseGenreList,
  parseGenreMode,
  parseHasSeries,
  listGenresForBookIds
} from '../inpx.js';
import { db, getReadBookIdSet, onViewRebuild } from '../db.js';
import { t } from '../i18n.js';

const RECS_CACHE_TTL_MS = 10 * 60_000;
const RECS_CACHE_MAX = 100;
const RECS_CACHE_EVICT = 10;
const recommendedViewCache = new Map();

/*
 * Глобальный кеш для лёгких фасетных выборок (жанры, серии, авторы).
 * Общий между пользователями — один и тот же жанр запрашивается один раз.
 */
const FACET_CACHE_TTL_MS = 5 * 60_000;
const facetBooksCache = new Map();
function readFacetCache(key) {
  const entry = facetBooksCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > FACET_CACHE_TTL_MS) { facetBooksCache.delete(key); return null; }
  return entry.value;
}
function writeFacetCache(key, value) {
  facetBooksCache.set(key, { value, ts: Date.now() });
  if (facetBooksCache.size > 500) {
    let evicted = 0;
    for (const k of facetBooksCache.keys()) {
      facetBooksCache.delete(k);
      if (++evicted >= 50) break;
    }
  }
}

/*
 * Фиксированные pageSize для каждого типа фасетного запроса.
 * Единый размер гарантирует попадание в мемо: один и тот же жанр/серия,
 * встретившийся у прочитанных, в истории и в закладках, запрашивается ровно один раз.
 */
const SERIES_PAGE = 8;
const GENRE_PAGE = 8;

function pickFirstAuthor(authors = '') {
  return splitAuthorValues(authors)[0] || '';
}

const STOP_GENRE_PATTERNS = ['самиздат', 'сетевая литература', 'network_literature', 'сетевое', 'библиотека', 'антология', 'сборник', 'другое'];

function isStopGenre(g) {
  const s = String(g || '').trim().toLowerCase();
  if (!s) return true;
  for (const p of STOP_GENRE_PATTERNS) {
    if (s.includes(p)) return true;
  }
  return false;
}

function firstGenreValue(value = '') {
  return String(value).split(/[:,;]/).map((s) => s.trim()).filter((g) => !isStopGenre(g)).find(Boolean) || '';
}

function extractGenres(value = '', maxPerBook = 3) {
  return String(value).split(/[:,;]/)
    .map((s) => s.trim())
    .filter((g) => g && !isStopGenre(g))
    .slice(0, maxPerBook);
}

function dedupeBooks(items, excludeIds) {
  const seen = new Set();
  const excluded = excludeIds instanceof Set || excludeIds instanceof Map ? excludeIds : new Set(excludeIds ?? []);
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
  if (store.size > RECS_CACHE_MAX) {
    /* Удаляем пачку самых старых записей (в порядке вставки) */
    let evicted = 0;
    for (const k of store.keys()) {
      store.delete(k);
      if (++evicted >= RECS_CACHE_EVICT) break;
    }
  }
}

/**
 * Извлечь доминирующие жанры из набора книг.
 * Считает частоту каждого жанра; возвращает только те, что встречаются
 * минимум у minCount книг, отсортированные по убыванию частоты.
 * Если таких нет — возвращает топ-1 по частоте (fallback).
 */
function collectGenres(books, maxGenres = 6, minCount = 2) {
  const freq = new Map();
  for (const book of books) {
    for (const g of extractGenres(book.genres, 3)) {
      freq.set(g, (freq.get(g) || 0) + 1);
    }
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = sorted.filter(([, count]) => count >= minCount);
  /* Если ни один жанр не набрал minCount — берём самый частый как fallback */
  const result = dominant.length ? dominant : sorted.slice(0, 1);
  return result.slice(0, maxGenres).map(([genre]) => genre);
}

/** Бонус за рейтинг: книги с высоким libRate получают доп. вес */
function ratingBonus(item) {
  const rate = Number(item?.libRate) || 0;
  if (rate >= 5) return 4;
  if (rate >= 4) return 2;
  if (rate >= 3) return 1;
  return 0;
}

/* ── Core recommendation builder ── */

/** Отдать event loop другим запросам между порциями вычислений */
function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Асинхронная версия buildRecommendations: между каждым SQL-запросом
 * отдаёт event loop через setImmediate, не блокируя сервер.
 * Глобальный кеш фасетов + дедупликация уникальных жанров/серий
 * сокращают количество SQL с ~100 до ~20.
 */
async function buildRecommendationsAsync(username, limit = 48) {
  /* Для вкуса нужны и прочитанные — не фильтруем read_books. */
  const history = getReadingHistory(username, 24, { excludeRead: false });
  const favoriteAuthors = getFavoriteAuthorsLight(username, 12);
  const favoriteSeries = getFavoriteSeriesLight(username, 12);
  await yieldTick();

  const bookmarkItems = getBookmarks(username, 'date', 50);
  const readBooks = getReadBooks(username, 'date', 50);
  const readBookIds = getReadBookIdSet(username);
  await yieldTick();

  const excludeIds = new Set([
    ...readBookIds,
    ...history.map((h) => h.id),
    ...bookmarkItems.map((b) => b.id)
  ]);
  const favoriteAuthorNames = new Set(favoriteAuthors.map((a) => a.name));
  const favoriteSeriesNames = new Set(favoriteSeries.map((s) => s.name));

  const scored = new Map();

  const getFacetBooks = (facet, value, pageSize, sort) => {
    const key = `${facet}|${value}|${pageSize}|${sort}`;
    const cached = readFacetCache(key);
    if (cached) return cached;
    const items = getBooksByFacetLight(facet, value, pageSize, sort);
    writeFacetCache(key, items);
    return items;
  };

  const addItems = (items, weight) => {
    for (const item of items) {
      if (!item?.id || excludeIds.has(item.id)) continue;
      if ((Number(item?.libRate) || 0) < 3) continue;
      let bonus = ratingBonus(item);
      if (favoriteAuthorNames.has(pickFirstAuthor(item.authors))) bonus += 3;
      if (item.series && favoriteSeriesNames.has(item.series)) bonus += 2;
      const existing = scored.get(item.id);
      if (existing) { existing.score += weight + bonus; continue; }
      scored.set(item.id, { item, score: weight + bonus });
    }
  };

  /*
   * Жанровые сигналы из уже загруженных данных (0 SQL).
   * Fallback на избранных авторов/серии, если read/history/bookmarks пусты.
   */
  let signalGenres = collectGenres([
    ...readBooks.slice(0, 10),
    ...history.slice(0, 8),
    ...bookmarkItems.slice(0, 8)
  ], 12, 2);

  /* Если пользователь не оставлял следов — берём жанры из книг избранных авторов/серий */
  if (signalGenres.length === 0) {
    for (const author of favoriteAuthors.slice(0, 5)) {
      const authorBooks = getFacetBooks('authors', author.name, 3, 'rating');
      signalGenres.push(...collectGenres(authorBooks, 4, 2));
      await yieldTick();
    }
    for (const series of favoriteSeries.slice(0, 5)) {
      const seriesBooks = getFacetBooks('series', series.name, 3, 'recent');
      signalGenres.push(...collectGenres(seriesBooks, 4, 2));
      await yieldTick();
    }
    signalGenres = [...new Set(signalGenres)].slice(0, 12);
  }

  const signalGenreSet = new Set(signalGenres);

  for (const genre of signalGenres) {
    addItems(getFacetBooks('genres', genre, GENRE_PAGE, 'rating'), 7);
    await yieldTick();
  }
  await yieldTick();

  /* Книги избранных авторов — сильный персональный сигнал */
  for (const author of favoriteAuthors.slice(0, 8)) {
    addItems(getFacetBooks('authors', author.name, 4, 'rating'), 9);
    await yieldTick();
  }

  /* Книги избранных серий */
  for (const series of favoriteSeries.slice(0, 8)) {
    addItems(getFacetBooks('series', series.name, SERIES_PAGE, 'recent'), 5);
    await yieldTick();
  }
  await yieldTick();

  /* Прочитанные книги — уникальные серии/жанры/авторы (жанры только вне signalGenres) */
  const readSeriesSet = new Set();
  const readGenreSet = new Set();
  const readAuthorSet = new Set();
  for (const item of readBooks.slice(0, 15)) {
    if (item.series) readSeriesSet.add(item.series);
    const firstAuthor = pickFirstAuthor(item.authors);
    if (firstAuthor && !favoriteAuthorNames.has(firstAuthor)) readAuthorSet.add(firstAuthor);
    for (const g of extractGenres(item.genres, 2)) {
      if (!signalGenreSet.has(g)) readGenreSet.add(g);
    }
  }
  for (const series of readSeriesSet) {
    addItems(getFacetBooks('series', series, SERIES_PAGE, 'recent'), 8);
    await yieldTick();
  }
  for (const author of readAuthorSet) {
    addItems(getFacetBooks('authors', author, 4, 'rating'), 6);
    await yieldTick();
  }
  for (const genre of readGenreSet) {
    addItems(getFacetBooks('genres', genre, GENRE_PAGE, 'rating'), 5);
    await yieldTick();
  }
  await yieldTick();

  /* История — уникальные серии/жанры/авторы (жанры только вне signalGenres) */
  const histSeriesSet = new Set();
  const histGenreSet = new Set();
  const histAuthorSet = new Set();
  for (const item of history.slice(0, 12)) {
    if (item.series) histSeriesSet.add(item.series);
    const firstAuthor = pickFirstAuthor(item.authors);
    if (firstAuthor && !favoriteAuthorNames.has(firstAuthor)) histAuthorSet.add(firstAuthor);
    for (const g of extractGenres(item.genres, 2)) {
      if (!signalGenreSet.has(g)) histGenreSet.add(g);
    }
  }
  for (const series of histSeriesSet) {
    addItems(getFacetBooks('series', series, SERIES_PAGE, 'recent'), 6);
    await yieldTick();
  }
  for (const author of histAuthorSet) {
    addItems(getFacetBooks('authors', author, 4, 'rating'), 4);
    await yieldTick();
  }
  for (const genre of histGenreSet) {
    addItems(getFacetBooks('genres', genre, GENRE_PAGE, 'rating'), 3);
    await yieldTick();
  }
  await yieldTick();

  /* Закладки — уникальные серии/жанры/авторы (жанры только вне signalGenres) */
  const bmSeriesSet = new Set();
  const bmGenreSet = new Set();
  const bmAuthorSet = new Set();
  for (const item of bookmarkItems.slice(0, 12)) {
    if (item.series) bmSeriesSet.add(item.series);
    const firstAuthor = pickFirstAuthor(item.authors);
    if (firstAuthor && !favoriteAuthorNames.has(firstAuthor)) bmAuthorSet.add(firstAuthor);
    for (const g of extractGenres(item.genres, 2)) {
      if (!signalGenreSet.has(g)) bmGenreSet.add(g);
    }
  }
  for (const series of bmSeriesSet) {
    addItems(getFacetBooks('series', series, SERIES_PAGE, 'recent'), 4);
    await yieldTick();
  }
  for (const author of bmAuthorSet) {
    addItems(getFacetBooks('authors', author, 4, 'rating'), 3);
    await yieldTick();
  }
  for (const genre of bmGenreSet) {
    addItems(getFacetBooks('genres', genre, GENRE_PAGE, 'rating'), 2);
    await yieldTick();
  }

  const weighted = [...scored.values()]
    .sort((a, b) => b.score - a.score);

  /* Перемешиваем книги с одинаковым скором для разнообразия при каждом обновлении кеша */
  let wi = 0;
  while (wi < weighted.length) {
    let wj = wi;
    while (wj < weighted.length && weighted[wj].score === weighted[wi].score) wj++;
    for (let wk = wj - 1; wk > wi; wk--) {
      const wm = wi + Math.floor(Math.random() * (wk - wi + 1));
      [weighted[wk], weighted[wm]] = [weighted[wm], weighted[wk]];
    }
    wi = wj;
  }

  return dedupeBooks(weighted.map((e) => e.item).slice(0, limit), excludeIds);
}

export function invalidateRecommendationsCache(username) {
  const key = String(username || '').trim();
  if (key) recommendedViewCache.delete(key);
}

export function invalidateAllRecommendations() {
  recommendedViewCache.clear();
}

/* Сбрасываем кеши при rebuild view — active_books меняется, фасетные данные устаревают */
onViewRebuild(() => {
  recommendedViewCache.clear();
  facetBooksCache.clear();
});

/* Множество username, для которых сейчас идёт фоновое вычисление */
const _computingSet = new Set();

function scheduleRecommendationBuild(username) {
  if (_computingSet.has(username)) return;
  _computingSet.add(username);
  buildRecommendationsAsync(username, 72)
    .then((recommended) => writeTimedCache(recommendedViewCache, username, recommended))
    .catch((err) => { console.error('[recommendations] build failed for', username, err.message); })
    .finally(() => _computingSet.delete(username));
}

/** Additive catalog filters over an in-memory recommendation pool. */
function filterRecommendedPool(books, { genre = '', genreMode = 'or', lang = '', format = '', year = 0, minRate = 0, hasSeries = null } = {}) {
  if (!Array.isArray(books) || books.length === 0) return [];
  const genres = parseGenreList(genre);
  const language = String(lang || '').trim().toLowerCase();
  const fmt = String(format || '').trim().toLowerCase();
  const rate = Math.floor(Number(minRate) || 0);
  const seriesFlag = hasSeries === 0 || hasSeries === 1 ? hasSeries : parseHasSeries(hasSeries);
  const y = Number(year) || 0;
  const hasYear = y >= 1800 && y <= 2100;

  let list = books;
  if (language) {
    list = list.filter((b) => String(b?.lang || '').toLowerCase() === language);
  }
  if (rate >= 1) {
    list = list.filter((b) => (Number(b?.libRate) || 0) >= rate);
  }
  if (fmt) {
    list = list.filter((b) => String(b?.ext || '').toLowerCase() === fmt);
  }
  if (seriesFlag === 1 || seriesFlag === 0) {
    list = list.filter((b) => {
      const has = Boolean(
        (Array.isArray(b?.seriesList) && b.seriesList.length > 0) ||
        String(b?.series || '').trim()
      );
      return seriesFlag === 1 ? has : !has;
    });
  }
  if (genres.length && list.length) {
    const idPh = list.map(() => '?').join(',');
    const genrePh = genres.map(() => '?').join(',');
    const ids = list.map((b) => b.id);
    const mode = parseGenreMode(genreMode);
    const rows = mode === 'and' && genres.length > 1
      ? db.prepare(`
          SELECT bg.book_id AS id
          FROM book_genres bg
          JOIN genres_catalog g ON g.id = bg.genre_id
          WHERE bg.book_id IN (${idPh})
            AND g.name IN (${genrePh})
          GROUP BY bg.book_id
          HAVING COUNT(DISTINCT g.name) = ?
        `).all(...ids, ...genres, genres.length)
      : db.prepare(`
          SELECT DISTINCT bg.book_id AS id
          FROM book_genres bg
          JOIN genres_catalog g ON g.id = bg.genre_id
          WHERE bg.book_id IN (${idPh})
            AND g.name IN (${genrePh})
        `).all(...ids, ...genres);
    const ok = new Set(rows.map((r) => r.id));
    list = list.filter((b) => ok.has(b.id));
  }
  if (hasYear && list.length) {
    const placeholders = list.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id FROM active_books
      WHERE id IN (${placeholders})
        AND CAST(SUBSTR(date, 1, 4) AS INTEGER) = ?
    `).all(...list.map((b) => b.id), y);
    const ok = new Set(rows.map((r) => r.id));
    list = list.filter((b) => ok.has(b.id));
  }
  return list;
}

function sortRecommendedBooks(books, sort = 'relevance') {
  const mode = String(sort || 'relevance');
  if (mode === 'title') {
    return [...books].sort((a, b) =>
      String(a?.title || '').localeCompare(String(b?.title || ''), 'ru', { sensitivity: 'base' })
    );
  }
  if (mode === 'rating') {
    return [...books].sort((a, b) => {
      const rd = (Number(b?.libRate) || 0) - (Number(a?.libRate) || 0);
      if (rd !== 0) return rd;
      return String(a?.title || '').localeCompare(String(b?.title || ''), 'ru', { sensitivity: 'base' });
    });
  }
  // relevance — keep recommendation score order from the builder
  return books;
}

export function getRecommendedLibraryView({
  username = '',
  page = 1,
  pageSize = 24,
  genre = '',
  genreMode = 'or',
  lang = '',
  format = '',
  year = 0,
  minRate = 0,
  hasSeries = null,
  sort = 'relevance'
} = {}) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return { total: 0, items: [], computing: false };
  const recommended = readTimedCache(recommendedViewCache, normalizedUsername);
  if (!recommended) {
    scheduleRecommendationBuild(normalizedUsername);
    return { total: 0, items: [], computing: true };
  }
  const filtered = filterRecommendedPool(recommended, { genre, genreMode, lang, format, year, minRate, hasSeries });
  const sorted = sortRecommendedBooks(filtered, sort);
  const offset = (page - 1) * pageSize;
  return { total: sorted.length, items: sorted.slice(offset, offset + pageSize), computing: false };
}

export function listRecommendedSectionGenres({
  username = '',
  lang = '',
  format = '',
  year = 0,
  minRate = 0,
  hasSeries = null
} = {}) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return [];
  const recommended = readTimedCache(recommendedViewCache, normalizedUsername);
  if (!recommended) return [];
  const filtered = filterRecommendedPool(recommended, { lang, format, year, minRate, hasSeries });
  return listGenresForBookIds(filtered.map((book) => book.id));
}

export function getHomeRecommendations({ username = '' }) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return [];
  const view = getRecommendedLibraryView({ username: normalizedUsername, page: 1, pageSize: 8 });
  return view.items;
}

export function buildSimilarBooks(book) {
  const MAX = 8;
  const seriesName = book.seriesList?.[0]?.name || book.series || '';
  if (seriesName) {
    const seriesItems = dedupeBooks(
      getBooksByFacetLight('series', seriesName, MAX + 1, 'recent'),
      [book.id]
    ).slice(0, MAX);
    if (seriesItems.length) {
      return { title: t('book.otherInSeries'), items: seriesItems };
    }
    /* Singleton / empty series → fall through to author (e.g. only this book in series). */
  }
  const author = pickFirstAuthor(book.authors);
  if (author) {
    const items = getBooksByFacetLight('authors', author, MAX + 1, 'recent');
    return { title: t('book.otherByAuthor'), items: dedupeBooks(items, [book.id]).slice(0, MAX) };
  }
  const genre = firstGenreValue(book.genres);
  if (genre) {
    const items = getBooksByFacetLight('genres', genre, MAX + 1, 'rating');
    return { title: t('book.similar'), items: dedupeBooks(items, [book.id]).slice(0, MAX) };
  }
  return { title: t('book.similar'), items: [] };
}

export function buildFacetSummaryBooks(facet, value) {
  if (facet === 'authors') return getBooksByFacet({ facet: 'authors', value, page: 1, pageSize: 6, sort: 'title' }).items;
  if (facet === 'series') return getBooksByFacet({ facet: 'series', value, page: 1, pageSize: 6, sort: 'series' }).items;
  return [];
}
