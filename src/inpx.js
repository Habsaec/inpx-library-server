import fs from 'node:fs';
import path from 'node:path';
import unzipper from 'unzipper';
import iconv from 'iconv-lite';
import {
  db,
  getMeta,
  setMeta,
  getEnabledSources,
  getSourceById,
  addSource,
  getSourceByPath,
  updateSourceBookCount,
  updateSourceIndexedAt,
  dropBooksFtsTriggers,
  ensureBooksFtsTriggers,
  rebuildBooksFtsFromContent,
  beginFastSqliteImport,
  endFastSqliteImport,
  refreshCatalogBookCounts,
  suppressBook,
  getSuppressedBookIds
} from './db.js';
import { invalidateReadCache } from './db.js';
import { config } from './config.js';
import { formatGenreLabel, formatGenreList } from './genre-map.js';
import { getAvailableDownloadFormats, FORMAT_LABELS } from './download-formats.js';
import { BATCH_DOWNLOAD_MAX } from './constants.js';
import { t } from './i18n.js';
import { appendIndexDiaryLine } from './services/file-log.js';
import { logSystemEvent } from './services/system-events.js';
import { parseEnvTimeoutMs, promiseWithTimeout } from './utils/async-timeout.js';
import { resolveLibraryArchiveFile } from './flibusta-sidecar.js';

/** Уступка циклу событий между тяжёлыми синхронными участками (чтобы HTTP не «замирал»).
 *  Используем setImmediate без фиксированной задержки: на больших библиотеках setTimeout(2) давал
 *  лишние минуты только из‑за накопленных пауз. */
const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Одна «логическая» строка INPX длиннее этого — пропуск: иначе split/нормализация могут блокировать поток надолго. */
const MAX_INPX_LINE_CHARS = 256 * 1024;
/** Защита от патологически больших .inp внутри INPX (память + бесконечное чтение). */
const MAX_INP_ENTRY_BYTES = 80 * 1024 * 1024;
const FACET_CACHE_TTL_MS = 120_000; // 20s → 120s:减少分面/系列/作者页面查询
/** COUNT дедупа по фасету не зависит от страницы — кешируем отдельно, чтобы «далее» не гоняло тяжёлый подсчёт. */
const FACET_DEDUP_TOTAL_TTL_MS = parseEnvTimeoutMs('FACET_DEDUP_TOTAL_TTL_MS', 300_000);
const AUTHOR_GROUPED_CACHE_TTL_MS = 60_000; // 12s → 60s:减少作者分组页查询
/** Макс. число строк на странице автора (лимит выборки из БД). */
const AUTHOR_GROUPED_FETCH_CAP = 50_000;
const ARCHIVE_STEM_LOOKUP_TTL_MS = 120_000;
const BOOKS_FTS_DIRTY_META_KEY = 'books_fts_dirty';

const facetBooksCache = new Map();
const facetDedupTotalCache = new Map();
const facetSummaryCache = new Map();
// Heavy payload cache; keep intentionally tiny to avoid memory growth/GC stalls.
const authorGroupedCache = new Map();
/** Параллельные запросы к одному ключу ждут один проход БД (см. *Coalesced). */
const authorGroupedInflight = new Map();
const facetBooksInflight = new Map();
const archiveStemLookupCache = new Map();

function isAdaptiveInpxImportEnabled() {
  const raw = String(process.env.INPX_ADAPTIVE_IMPORT || '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, n));
}

async function measureEventLoopLagMs() {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return Date.now() - started;
}

function readTimedCache(cache, key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, item);
  return item.value;
}

function writeTimedCache(cache, key, value, ttlMs, maxSize = 300) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function clearRuntimeQueryCaches() {
  facetBooksCache.clear();
  facetDedupTotalCache.clear();
  facetSummaryCache.clear();
  authorGroupedCache.clear();
  archiveStemLookupCache.clear();
}

/** Раньше сбрасывала проекцию дедупа; оставлено имя для совместимости вызовов из server. */
export function rebuildLibraryDedupProjection() {
  clearRuntimeQueryCaches();
  return true;
}

export function markLibraryDedupProjectionStale() {
  clearRuntimeQueryCaches();
}

export function invalidateDuplicatesCache() {
  clearRuntimeQueryCaches();
}

/**
 * Строки .inp без `split(/\r?\n/)` на весь файл — на миллионах записей это создаёт гигантский массив,
 * провоцирует долгий GC и выглядит как «зависание на середине».
 */
function* iterateInpTextLines(text) {
  const s = String(text || '');
  let start = 0;
  for (;;) {
    if (start >= s.length) return;
    const nl = s.indexOf('\n', start);
    if (nl === -1) {
      const tail = s.slice(start);
      if (tail) yield tail;
      return;
    }
    let end = nl;
    if (nl > start && s.charCodeAt(nl - 1) === 13) {
      end = nl - 1;
    }
    if (end > start) {
      yield s.slice(start, end);
    }
    start = nl + 1;
  }
}

function normalizeYo(value = '') {
  return String(value).replace(/ё/g, 'е').replace(/Ё/g, 'Е').replace(/ъ/g, 'ь').replace(/Ъ/g, 'Ь');
}

export function createSortKey(value = '') {
  return normalizeYo(normalizeText(value))
    .toLowerCase()
    .replace(/["'`«»()\[\]{}!?.,:;\/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSearchOperator(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return { operator: 'empty', value: '' };
  }

  const firstChar = raw[0];
  if (firstChar === '=' || firstChar === '*' || firstChar === '~') {
    return { operator: firstChar, value: raw.slice(1).trim() };
  }

  return { operator: 'prefix', value: raw };
}

function matchesSearchValue(rawValue = '', searchValue = '', { normalizedValue = '', sortKey = '' } = {}) {
  const parsed = parseSearchOperator(searchValue);
  if (parsed.operator === 'empty') {
    return true;
  }

  const sourceRaw = String(rawValue || '');
  const sourceNormalized = normalizeYo(String(normalizedValue || normalizeText(rawValue))).toLowerCase();
  const sourceSortKey = String(sortKey || createSortKey(rawValue));
  const needleNormalized = normalizeYo(normalizeText(parsed.value)).toLowerCase();
  const needleSortKey = createSortKey(parsed.value);

  if (!needleNormalized && parsed.operator !== '~') {
    return true;
  }

  if (parsed.operator === '=') {
    return sourceNormalized === needleNormalized || sourceSortKey === needleSortKey;
  }

  if (parsed.operator === '*') {
    return sourceNormalized.includes(needleNormalized) || sourceSortKey.includes(needleSortKey);
  }

  if (parsed.operator === '~') {
    if (!parsed.value) {
      return true;
    }
    if (parsed.value.length > 200) {
      return false;
    }
    if (/([+*])\)[\s]*[+*?{]|\(\?[^)]*\(/.test(parsed.value)) {
      return false;
    }
    try {
      const regex = new RegExp(parsed.value, 'i');
      const testStr = sourceRaw.slice(0, 500);
      return regex.test(testStr);
    } catch {
      return false;
    }
  }

  return sourceNormalized.startsWith(needleNormalized) || sourceSortKey.startsWith(needleSortKey);
}

export function formatSingleAuthorName(value = '') {
  const raw = normalizeAuthorToken(value);
  if (!raw) {
    return '';
  }

  const parts = raw
    .split(',')
    .map((item) => normalizeAuthorToken(item))
    .filter(Boolean);

  if (!parts.length) {
    return raw;
  }

  return parts.join(' ');
}

export function splitAuthorValues(value) {
  return normalizeText(value)
    .replace(/\s*;\s*/g, ':')
    .replace(/\s*:\s*/g, ':')
    .split(':')
    .map((item) => normalizeAuthorToken(item))
    .filter(Boolean);
}

export function authorSortKey(value = '') {
  const raw = normalizeAuthorToken(value);
  if (!raw) {
    return '';
  }

  const commaParts = raw
    .split(',')
    .map((item) => normalizeAuthorToken(item))
    .filter(Boolean);

  if (commaParts.length) {
    return commaParts.join(' ');
  }

  const spacedParts = raw.split(/\s+/).map((item) => normalizeAuthorToken(item)).filter(Boolean);
  if (spacedParts.length <= 1) {
    return raw;
  }

  const [lastName, firstName, middleName] = spacedParts;
  return [lastName, firstName, middleName].filter(Boolean).join(' ');
}

export function authorDisplayName(value = '') {
  return formatSingleAuthorName(value) || normalizeAuthorToken(value);
}

export function authorSearchName(value = '') {
  const displayName = authorDisplayName(value);
  const raw = normalizeAuthorToken(value);
  return [displayName, raw]
    .map((item) => createSortKey(item))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .join(' | ');
}

export function seriesDisplayName(value = '') {
  return normalizeText(value);
}

export function seriesSortName(value = '') {
  return createSortKey(value);
}

export function seriesSearchName(value = '') {
  return [value, seriesDisplayName(value)]
    .map((item) => createSortKey(item))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .join(' | ');
}

/**
 * Приводит строку из URL к каноническому `series_catalog.name`.
 * Учитывает ё/е, пробелы и поля search_name/sort_name (как при импорте), чтобы
 * `/facet/series/Линия%20Грез` открывала ту же серию, что «Линия грёз» в каталоге.
 */
let _seriesByName;
let _seriesBySearch;
let _seriesBySort;

function ensureSeriesStmts() {
  if (!_seriesByName) {
    _seriesByName = db.prepare('SELECT name FROM series_catalog WHERE name = ?');
    _seriesBySearch = db.prepare('SELECT name FROM series_catalog WHERE search_name = ?');
    _seriesBySort = db.prepare('SELECT name FROM series_catalog WHERE sort_name = ?');
  }
}

export function resolveSeriesCatalogName(requested) {
  const raw = normalizeText(requested);
  if (!raw) return '';
  ensureSeriesStmts();
  const direct = _seriesByName.get(raw);
  if (direct?.name) return direct.name;

  const sn = seriesSearchName(raw);
  const bySearch = _seriesBySearch.all(sn);
  if (bySearch.length === 1) return bySearch[0].name;

  const sk = seriesSortName(raw);
  const bySort = _seriesBySort.all(sk);
  if (bySort.length === 1) return bySort[0].name;

  if (bySearch.length > 1) {
    const disp = seriesDisplayName(raw);
    const hit = bySearch.find((r) => r.name === raw || seriesDisplayName(r.name) === disp);
    if (hit) return hit.name;
  }
  return raw;
}

export function genreDisplayName(value = '') {
  return formatGenreLabel(value);
}

export function genreSortName(value = '') {
  return createSortKey(genreDisplayName(value) || value);
}

export function genreSearchName(value = '') {
  return [value, genreDisplayName(value)]
    .map((item) => createSortKey(item))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index)
    .join(' | ');
}

function resolvePrimaryAuthor(value = '') {
  return splitAuthorValues(value)[0] || '';
}

/** Порции фоновой подкачки полей поиска — не блокируют весь Node (иначе сайт «висит» на большой БД). */
// Keep chunks small to avoid long event-loop stalls on large databases.
const CATALOG_BACKFILL_CHUNK = 250;
const BOOK_SEARCH_BACKFILL_CHUNK = 40;

/**
 * Одноразовая миграция: нормализация ё→е и пересчёт display/sort/search полей
 * для каталогов (авторы, серии, жанры) и книг.
 *
 * Запускается при старте только если миграция ещё не завершена (проверяет мета-флаги).
 * Также вызывается после завершения полной индексации.
 * Работает порциями через setImmediate — не блокирует HTTP.
 */
export function backfillCatalogSearchFields() {
  const catalogDone = getMeta('catalog_normalization_v1') === 'done';
  const booksDone = getMeta('yo_normalization_v1') === 'done';

  if (catalogDone && booksDone) {
    return;
  }

  /** Параллельно с индексацией — те же UPDATE по books/authors → очередь к SQLite и «подвисание». */
  if (indexState.active) {
    setTimeout(() => backfillCatalogSearchFields(), 2000);
    return;
  }

  console.log('[backfill] Запуск фоновой нормализации полей поиска…');

  const updateAuthor = db.prepare(`
    UPDATE authors
    SET display_name = ?, sort_name = ?, search_name = ?
    WHERE id = ?
  `);
  const updateSeries = db.prepare(`
    UPDATE series_catalog
    SET display_name = ?, sort_name = ?, search_name = ?
    WHERE id = ?
  `);
  const updateGenre = db.prepare(`
    UPDATE genres_catalog
    SET display_name = ?, sort_name = ?, search_name = ?
    WHERE id = ?
  `);
  const selectAuthors = db.prepare(`
    SELECT id, name, display_name AS displayName, sort_name AS sortName, search_name AS searchName
    FROM authors WHERE id > ? ORDER BY id LIMIT ?
  `);
  const selectSeries = db.prepare(`
    SELECT id, name, display_name AS displayName, sort_name AS sortName, search_name AS searchName
    FROM series_catalog WHERE id > ? ORDER BY id LIMIT ?
  `);
  const selectGenres = db.prepare(`
    SELECT id, name, display_name AS displayName, sort_name AS sortName, search_name AS searchName
    FROM genres_catalog WHERE id > ? ORDER BY id LIMIT ?
  `);

  function runAuthorsChunk(lastId, done) {
    if (indexState.active) {
      setTimeout(() => runAuthorsChunk(lastId, done), 2000);
      return;
    }
    const authorRows = selectAuthors.all(lastId, CATALOG_BACKFILL_CHUNK);
    for (const row of authorRows) {
      const displayName = authorDisplayName(row.name);
      const sortName = createSortKey(authorSortKey(row.name));
      const searchName = authorSearchName(row.name);
      if (row.displayName !== displayName || row.sortName !== sortName || row.searchName !== searchName) {
        updateAuthor.run(displayName, sortName, searchName, row.id);
      }
    }
    if (!authorRows.length) {
      done();
      return;
    }
    const next = authorRows[authorRows.length - 1].id;
    setTimeout(() => runAuthorsChunk(next, done), 8);
  }

  function runSeriesChunk(lastId, done) {
    if (indexState.active) {
      setTimeout(() => runSeriesChunk(lastId, done), 2000);
      return;
    }
    const seriesRows = selectSeries.all(lastId, CATALOG_BACKFILL_CHUNK);
    for (const row of seriesRows) {
      const displayName = seriesDisplayName(row.name);
      const sortName = seriesSortName(row.name);
      const searchName = seriesSearchName(row.name);
      if (row.displayName !== displayName || row.sortName !== sortName || row.searchName !== searchName) {
        updateSeries.run(displayName, sortName, searchName, row.id);
      }
    }
    if (!seriesRows.length) {
      done();
      return;
    }
    const next = seriesRows[seriesRows.length - 1].id;
    setTimeout(() => runSeriesChunk(next, done), 8);
  }

  function runGenresChunk(lastId, done) {
    if (indexState.active) {
      setTimeout(() => runGenresChunk(lastId, done), 2000);
      return;
    }
    const genreRows = selectGenres.all(lastId, CATALOG_BACKFILL_CHUNK);
    for (const row of genreRows) {
      const displayName = genreDisplayName(row.name);
      const sortName = genreSortName(row.name);
      const searchName = genreSearchName(row.name);
      if (row.displayName !== displayName || row.sortName !== sortName || row.searchName !== searchName) {
        updateGenre.run(displayName, sortName, searchName, row.id);
      }
    }
    if (!genreRows.length) {
      done();
      return;
    }
    const next = genreRows[genreRows.length - 1].id;
    setTimeout(() => runGenresChunk(next, done), 8);
  }

  const selectBooksChunk = db.prepare(`
    SELECT rowid, id, title, authors, genres, series, keywords,
           title_search AS titleSearch, authors_search AS authorsSearch,
           series_search AS seriesSearch, genres_search AS genresSearch,
           keywords_search AS keywordsSearch,
           title_sort AS titleSort, author_sort AS authorSort, series_sort AS seriesSort
    FROM books WHERE rowid > ? ORDER BY rowid LIMIT ?
  `);
  const updateBook = db.prepare(`
    UPDATE books
    SET title_search = ?, authors_search = ?, series_search = ?,
        genres_search = ?, keywords_search = ?,
        title_sort = ?, author_sort = ?, series_sort = ?
    WHERE id = ?
  `);

  function applyBookRow(row) {
    const newTitleSearch = createSortKey(row.title);
    const newAuthorsSearch = splitAuthorValues(row.authors).map((item) => createSortKey(formatSingleAuthorName(item) || item)).filter(Boolean).join(' | ');
    const newSeriesSearch = createSortKey(row.series);
    const genreSearchTokens = splitFacetValues(row.genres)
      .flatMap((item) => [item, formatGenreLabel(item)])
      .map((item) => createSortKey(item))
      .filter(Boolean)
      .filter((item, index, items) => items.indexOf(item) === index);
    const newGenresSearch = genreSearchTokens.join(' | ');
    const newKeywordsSearch = createSortKey(row.keywords);
    const newTitleSort = createSortKey(row.title);
    const newAuthorSort = createSortKey(authorSortKey(resolvePrimaryAuthor(row.authors)));
    const newSeriesSort = createSortKey(row.series);
    if (row.titleSearch !== newTitleSearch || row.authorsSearch !== newAuthorsSearch ||
        row.seriesSearch !== newSeriesSearch || row.genresSearch !== newGenresSearch ||
        row.keywordsSearch !== newKeywordsSearch || row.titleSort !== newTitleSort ||
        row.authorSort !== newAuthorSort || row.seriesSort !== newSeriesSort) {
      updateBook.run(newTitleSearch, newAuthorsSearch, newSeriesSearch,
        newGenresSearch, newKeywordsSearch, newTitleSort, newAuthorSort, newSeriesSort, row.id);
    }
  }

  function runYoBooksChunk(lastRowid) {
    if (indexState.active) {
      setTimeout(() => runYoBooksChunk(lastRowid), 2000);
      return;
    }
    const bookRows = selectBooksChunk.all(lastRowid, BOOK_SEARCH_BACKFILL_CHUNK);
    if (!bookRows.length) {
      setMeta('yo_normalization_v1', 'done');
      console.log('[backfill] Нормализация книг завершена.');
      return;
    }
    const tx = db.transaction(() => {
      for (const row of bookRows) {
        applyBookRow(row);
      }
    });
    tx();
    const nextRowid = bookRows[bookRows.length - 1].rowid;
    setTimeout(() => runYoBooksChunk(nextRowid), 8);
  }

  setTimeout(() => {
    if (catalogDone) {
      if (!booksDone) {
        console.log('[backfill] Нормализация книг (ё→е)…');
        setTimeout(() => runYoBooksChunk(0), 8);
      }
      return;
    }

    console.log('[backfill] Нормализация каталогов (авторы, серии, жанры)…');
    runAuthorsChunk(0, () => {
      setTimeout(() => {
        runSeriesChunk(0, () => {
          setTimeout(() => {
            runGenresChunk(0, () => {
              setMeta('catalog_normalization_v1', 'done');
              console.log('[backfill] Нормализация каталогов завершена.');
              if (booksDone) {
                return;
              }
              console.log('[backfill] Нормализация книг (ё→е)…');
              setTimeout(() => runYoBooksChunk(0), 8);
            });
          }, 8);
        });
      }, 8);
    });
  }, 8);
}

function normalizeSeriesIndex(value = '') {
  const normalized = normalizeText(value).replace(',', '.');
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return 0;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveDisplayDate(value = '') {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    return normalized.slice(0, 10);
  }

  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }

  if (/^\d{4}-\d{2}$/.test(normalized)) {
    return `${normalized}-01`;
  }

  if (/^\d{4}$/.test(normalized)) {
    return `${normalized}-01-01`;
  }

  return normalized;
}

export function enrichBookRow(row) {
  if (!row) {
    return null;
  }

  const primaryAuthor = resolvePrimaryAuthor(row.authors);
  const genreSearchTokens = splitFacetValues(row.genres)
    .flatMap((item) => [item, formatGenreLabel(item)])
    .map((item) => createSortKey(item))
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);

  return {
    ...row,
    titleSort: createSortKey(row.title),
    authorSort: createSortKey(authorSortKey(primaryAuthor)),
    seriesSort: createSortKey(row.series),
    seriesIndex: normalizeSeriesIndex(row.seriesNo),
    titleSearch: createSortKey(row.title),
    authorsSearch: splitAuthorValues(row.authors).map((item) => createSortKey(formatSingleAuthorName(item) || item)).filter(Boolean).join(' | '),
    seriesSearch: createSortKey(row.series),
    genresSearch: genreSearchTokens.join(' | '),
    keywordsSearch: createSortKey(row.keywords),
    date: resolveDisplayDate(row.date)
  };
}

const FIELD_SEPARATOR = String.fromCharCode(4);
const TEXT_ENCODING = 'win1251';
const indexState = {
  active: false,
  ready: false,
  startedAt: null,
  finishedAt: null,
  processedArchives: 0,
  totalArchives: 0,
  importedBooks: 0,
  currentArchive: '',
  error: '',
  pauseRequested: false,
  paused: false,
  cancelRequested: false,
  mode: '',
  sourceId: null
};

function resetIndexControlState() {
  indexState.pauseRequested = false;
  indexState.paused = false;
  indexState.cancelRequested = false;
  indexState.mode = '';
  indexState.sourceId = null;
}

function beginIndexControlState(mode = 'all', sourceId = null) {
  indexState.pauseRequested = false;
  indexState.paused = false;
  indexState.cancelRequested = false;
  indexState.mode = mode;
  indexState.sourceId = sourceId;
}

function throwIfIndexCancelled() {
  if (indexState.cancelRequested) {
    throw new Error('Indexing cancelled by user');
  }
}

function isIndexCancelledError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('cancelled by user');
}

async function waitIfIndexPaused() {
  if (!indexState.pauseRequested) {
    indexState.paused = false;
    return;
  }
  indexState.paused = true;
  while (indexState.pauseRequested && !indexState.cancelRequested) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  indexState.paused = false;
  throwIfIndexCancelled();
}

async function checkIndexControlPoint() {
  throwIfIndexCancelled();
  await waitIfIndexPaused();
}

export function requestIndexPause() {
  if (!indexState.active) return false;
  indexState.pauseRequested = true;
  return true;
}

export function requestIndexResume() {
  if (!indexState.active) return false;
  indexState.pauseRequested = false;
  return true;
}

export function requestIndexStop() {
  if (!indexState.active) return false;
  indexState.cancelRequested = true;
  indexState.pauseRequested = false;
  return true;
}

function repairMojibake(value) {
  const input = String(value || '');
  if (!/[ÐÑРС]/.test(input)) {
    return input;
  }

  const repaired = iconv.encode(input, 'win1251').toString('utf8');
  return repaired.includes('�') ? input : repaired;
}

function normalizeWhitespace(value = '') {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[\u00A0\u2000-\u200D\u202F\u205F\u3000]/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeText(value) {
  return normalizeWhitespace(repairMojibake(value));
}

function normalizeAuthorToken(value = '') {
  return normalizeText(value)
    .replace(/^,+|,+$/g, '')
    .replace(/^\?+$/, '')
    .trim();
}

export function splitFacetValues(value) {
  return normalizeText(value)
    .split(/[:,;]/)
    .map((item) => normalizeText(item))
    .map((item) => item.replace(/^\?+$/, '').trim())
    .filter(Boolean)
    .filter((item, index, items) => items.indexOf(item) === index);
}

let _authorByName;
let _authorByDisplaySearch;

function ensureAuthorStmts() {
  if (!_authorByName) {
    _authorByName = db.prepare('SELECT name FROM authors WHERE name = ?');
    _authorByDisplaySearch = db.prepare(`
      SELECT name
      FROM authors
      WHERE display_name = ? OR search_name = ? OR sort_name = ?
      LIMIT 1
    `);
  }
}

export function resolveAuthorName(value) {
  const normalized = normalizeText(value);
  const candidates = new Set([
    normalized,
    formatSingleAuthorName(normalized),
    ...splitAuthorValues(value),
    ...splitAuthorValues(value).map((item) => formatSingleAuthorName(item))
  ].filter(Boolean));

  ensureAuthorStmts();
  for (const candidate of candidates) {
    const author = _authorByName.get(candidate);
    if (author?.name) {
      return author.name;
    }
  }

  for (const candidate of candidates) {
    const displayMatch = _authorByDisplaySearch.get(
      authorDisplayName(candidate),
      authorSearchName(candidate),
      createSortKey(authorSortKey(candidate))
    );
    if (displayMatch?.name) {
      return displayMatch.name;
    }
  }

  return null;
}

/**
 * Default field indices for standard INPX format.
 * Matches the default structure: AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS
 * Can be overridden by structure.info inside the INPX archive.
 */
const DEFAULT_FIELD_MAP = {
  authors: 0, genres: 1, title: 2, series: 3, seriesNo: 4,
  fileName: 5, size: 6, libId: 7, deleted: 8, ext: 9,
  date: 10, lang: 11, libRate: 12, keywords: 13, insNo: -1, folder: -1
};

/**
 * Parse structure.info from INPX to determine field positions.
 * Format: one line with semicolon-separated field names like
 * AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;FOLDER
 */
function parseStructureInfo(text) {
  const nameToKey = {
    AUTHOR: 'authors', GENRE: 'genres', TITLE: 'title',
    SERIES: 'series', SERNO: 'seriesNo', FILE: 'fileName',
    SIZE: 'size', LIBID: 'libId', DEL: 'deleted', EXT: 'ext',
    DATE: 'date', LANG: 'lang', KEYWORDS: 'keywords',
    LIBRATE: 'libRate', STARS: 'libRate',
    INSNO: 'insNo', FOLDER: 'folder'
  };
  const map = {};
  for (const key of Object.values(nameToKey)) map[key] = -1;
  const lines = String(text || '').trim().split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.trim().toUpperCase().split(';');
    for (let i = 0; i < fields.length; i++) {
      const k = nameToKey[fields[i].trim()];
      if (k) map[k] = i;
    }
    break; // only first non-empty line matters
  }
  return map;
}

function parseLine(line, archiveName, sourceId = null, fieldMap = null) {
  if (!line) {
    return null;
  }
  if (line.length > MAX_INPX_LINE_CHARS) {
    console.warn(`[index] Skipped line (exceeds ${MAX_INPX_LINE_CHARS} chars): ${line.slice(0, 80)}…`);
    return null;
  }
  const parts = line.split(FIELD_SEPARATOR).map(normalizeText);
  const fm = fieldMap || DEFAULT_FIELD_MAP;
  const minFields = Math.max(6, ...(Object.values(fm).filter(v => v >= 0)));
  if (parts.length <= Math.min(5, minFields - 6)) {
    console.warn(`[index] Skipped malformed line (${parts.length} fields): ${line.slice(0, 80)}…`);
    return null;
  }
  const g = (key) => (fm[key] >= 0 && fm[key] < parts.length) ? parts[fm[key]] : '';
  const authors = g('authors');
  const genres = g('genres');
  const title = g('title');
  const series = g('series');
  const seriesNo = g('seriesNo');
  const fileName = g('fileName');
  const size = g('size');
  const libId = g('libId');
  const deleted = g('deleted');
  const ext = g('ext') || 'fb2';
  const date = g('date');
  const lang = g('lang');
  const keywords = g('keywords');
  const folder = g('folder');

  // If FOLDER field is present and non-empty, use it as archive name
  const effectiveArchive = folder
    ? (folder.match(/\.(zip|7z)$/i) ? folder : folder + '.zip')
    : archiveName;

  const rawId = String(libId || fileName || '').trim();
  if (!rawId || !title) {
    return null;
  }
  /** Несколько INPX-источников: одинаковые lib_id в разных выкладках — уникальный первичный ключ. */
  const id =
    sourceId != null && sourceId !== ''
      ? `${Number(sourceId)}:${rawId}`
      : rawId;

  return {
    id,
    title,
    authors,
    genres,
    series,
    seriesNo,
    fileName,
    archiveName: effectiveArchive,
    size: Number(size || 0),
    libId: libId || '',
    deleted: Number(deleted || 0),
    ext: ext || 'fb2',
    date: date || '',
    lang: lang || '',
    keywords
  };
}

export function getIndexStatus() {
  const indexedAt = getMeta('indexed_at');
  /** Не мутируем indexState при опросе API — иначе плывут ready/архивы и «индексация обрывается» визуально. */
  const catalogIndexedOnce = Boolean(indexedAt) && !indexState.active && !indexState.error;
  const ready = indexState.ready || catalogIndexedOnce;

  let legacyInpArchiveCount = 0;
  try {
    legacyInpArchiveCount = Object.keys(JSON.parse(getMeta('inp_sizes') || '{}')).length;
  } catch {}

  const out = {
    ...indexState,
    ready,
    indexedAt
  };

  if (
    !indexState.active &&
    indexState.processedArchives === 0 &&
    indexState.totalArchives === 0 &&
    legacyInpArchiveCount > 0
  ) {
    out.totalArchives = legacyInpArchiveCount;
    out.processedArchives = legacyInpArchiveCount;
  }

  return out;
}

export function startBackgroundIndexing(force = false, incremental = true) {
  if (indexState.active) {
    console.warn('[index] reindex skipped: already running (wait for completion or restart server)');
    logSystemEvent('warn', 'index', 'global reindex skipped: already running', {});
    return false;
  }

  indexState.active = true;
  indexState.error = '';
  indexState.startedAt = new Date().toISOString();
  indexState.finishedAt = null;
  beginIndexControlState('all', null);

  if (force) {
    setMeta('catalog_normalization_v1', '');
    setMeta('yo_normalization_v1', '');
  }

  const useIncremental = !force && incremental;
  const enabledList = getEnabledSources();
  logSystemEvent('info', 'index', 'global index started', {
    force,
    incremental: useIncremental,
    enabledSources: enabledList.length,
    sourceNames: enabledList.map((s) => s.name).slice(0, 24)
  });
  indexAllSources(force, useIncremental)
    .then(async () => {
      indexState.ready = true;
      indexState.active = false;
      indexState.finishedAt = new Date().toISOString();
      await refreshCatalogBookCounts();
      resetIndexControlState();
    })
    .catch((error) => {
      indexState.active = false;
      if (isIndexCancelledError(error)) {
        indexState.error = '';
        logSystemEvent('warn', 'index', 'global index stopped by user', {});
      } else {
        indexState.ready = false;
        indexState.error = error.message;
        logSystemEvent('error', 'index', 'global index failed', { error: error.message });
      }
      indexState.finishedAt = new Date().toISOString();
      resetIndexControlState();
      if (!isIndexCancelledError(error)) {
        console.error(error);
      }
    });
  return true;
}

export function startSourceIndexing(sourceId, force = false) {
  if (indexState.active) {
    console.warn('[index] source reindex skipped: global indexer already running');
    logSystemEvent('warn', 'index', 'source reindex skipped: global indexer already running', { sourceId });
    return false;
  }

  indexState.active = true;
  indexState.error = '';
  indexState.startedAt = new Date().toISOString();
  indexState.finishedAt = null;
  beginIndexControlState('source', Number(sourceId) || null);

  if (force) {
    setMeta('catalog_normalization_v1', '');
    setMeta('yo_normalization_v1', '');
  }

  const srcRow = getSourceById(sourceId);
  logSystemEvent('info', 'index', 'single source index started', {
    sourceId,
    force,
    name: srcRow?.name || '',
    type: srcRow?.type || ''
  });
  indexSingleSource(sourceId, force)
    .then(async () => {
      indexState.ready = true;
      indexState.active = false;
      indexState.finishedAt = new Date().toISOString();
      await refreshCatalogBookCounts();
      resetIndexControlState();
    })
    .catch((error) => {
      indexState.active = false;
      if (isIndexCancelledError(error)) {
        indexState.error = '';
        logSystemEvent('warn', 'index', 'single source index stopped by user', { sourceId, name: srcRow?.name || '' });
      } else {
        indexState.ready = false;
        indexState.error = error.message;
        logSystemEvent('error', 'index', 'single source index failed', {
          sourceId,
          name: srcRow?.name || '',
          error: error.message
        });
      }
      indexState.finishedAt = new Date().toISOString();
      resetIndexControlState();
      if (!isIndexCancelledError(error)) {
        console.error(error);
      }
    });
  return true;
}

async function indexSingleSource(sourceId, force = false) {
  await checkIndexControlPoint();
  const source = getSourceById(sourceId);
  if (!source) throw new Error(`Источник #${sourceId} не найден`);
  if (!source.enabled) throw new Error(`Источник «${source.name}» отключён`);

  if (source.type === 'inpx') {
    await ensureInpxSourceIndex(source, force);
  } else if (source.type === 'folder') {
    const { indexFolder } = await import('./folder-indexer.js');
    await indexFolder(source, {
      incremental: !force,
      control: {
        waitIfPaused: waitIfIndexPaused,
        throwIfCancelled: throwIfIndexCancelled
      },
      onProgress: ({ processed, total, imported }) => {
        indexState.processedArchives = processed;
        indexState.totalArchives = total;
        indexState.importedBooks = imported;
        indexState.currentArchive = `${source.name}: ${processed}/${total}`;
      }
    });
  }
  logSystemEvent('info', 'index', 'single source index phase completed', {
    sourceId,
    name: source.name,
    type: source.type
  });
}

async function indexAllSources(force = false, incremental = true) {
  await checkIndexControlPoint();
  const sources = getEnabledSources();

  if (!sources.length) {
    logSystemEvent('info', 'index', 'legacy INPX index (no enabled sources in DB)', { force, incremental });
    const legacyResult = await ensureIndex(force, incremental);
    if (legacyResult?.error) {
      throw new Error(legacyResult.error);
    }
    return legacyResult;
  }

  logSystemEvent('info', 'index', 'indexing enabled sources', {
    count: sources.length,
    force,
    incremental,
    order: sources.map((s) => ({ id: s.id, name: s.name, type: s.type }))
  });

  const errors = [];
  for (const source of sources) {
    try {
      await checkIndexControlPoint();
      indexState.currentArchive = source.name;
      logSystemEvent('info', 'index', 'source index phase started', {
        sourceId: source.id,
        name: source.name,
        type: source.type,
        force,
        incremental: !force && incremental
      });
      if (source.type === 'inpx') {
        await ensureInpxSourceIndex(source, force, incremental);
      } else if (source.type === 'folder') {
        const { indexFolder } = await import('./folder-indexer.js');
        const baseImported = indexState.importedBooks;
        await indexFolder(source, {
          incremental: !force && incremental,
          control: {
            waitIfPaused: waitIfIndexPaused,
            throwIfCancelled: throwIfIndexCancelled
          },
          onProgress: ({ processed, total, imported, currentArchive }) => {
            indexState.processedArchives = processed;
            indexState.totalArchives = total;
            indexState.importedBooks = baseImported + imported;
            indexState.currentArchive =
              currentArchive ?? `${source.name}: ${processed}/${total}`;
          }
        });
      }
    } catch (err) {
      if (isIndexCancelledError(err)) {
        throw err;
      }
      errors.push(`${source.name}: ${err.message}`);
      console.error(`Error indexing source ${source.name}:`, err);
      logSystemEvent('error', 'index', 'source index phase failed', {
        sourceId: source.id,
        name: source.name,
        type: source.type,
        error: err.message
      });
    }
  }

  if (errors.length) {
    indexState.error = errors.join('; ');
    logSystemEvent('error', 'index', 'global index aborted: one or more sources failed', {
      errors,
      count: errors.length
    });
    throw new Error(indexState.error);
  }

  logSystemEvent('info', 'index', 'all enabled sources indexed successfully', {
    sources: sources.length,
    importedBooks: indexState.importedBooks,
    processedArchives: indexState.processedArchives,
    totalArchives: indexState.totalArchives
  });
  setMeta('indexed_at', new Date().toISOString());
}

async function ensureInpxSourceIndex(source, force = false, incremental = true) {
  const inpxPath = source.path;
  if (!fs.existsSync(inpxPath)) {
    throw new Error(`INPX файл не найден: ${inpxPath}`);
  }

  const currentMtime = String(fs.statSync(inpxPath).mtimeMs);
  const mtimeKey = `inpx_mtime_${source.id}`;
  const previousMtime = getMeta(mtimeKey);
  const useIncremental = incremental && !force && source.lastIndexedAt;

  if (!force && !incremental && source.lastIndexedAt && previousMtime === currentMtime) {
    logSystemEvent('info', 'index', 'INPX source skipped (unchanged mtime)', {
      sourceId: source.id,
      name: source.name,
      inpx: path.basename(inpxPath)
    });
    return;
  }

  await rebuildIndex(inpxPath, useIncremental, source.id);
  setMeta(mtimeKey, currentMtime);
  updateSourceBookCount(source.id);
  updateSourceIndexedAt(source.id);
}

export function getConfiguredInpxFile() {
  const sources = getEnabledSources();
  const inpxSource = sources.find((s) => s.type === 'inpx');
  if (inpxSource) return inpxSource.path;

  const saved = String(getMeta('inpx_file') || '').trim();
  if (saved) return saved;
  if (config.inpxFile) return config.inpxFile;
  if (config.libraryRoot && fs.existsSync(config.libraryRoot)) {
    try {
      const found = fs.readdirSync(config.libraryRoot).find(f => f.endsWith('.inpx'));
      if (found) return path.join(config.libraryRoot, found);
    } catch {}
  }
  return '';
}

export function getLibraryRoot() {
  const inpx = getConfiguredInpxFile();
  if (inpx) return path.dirname(inpx);
  return config.libraryRoot;
}

export function getSourceRoot(sourceId) {
  if (!sourceId) return getLibraryRoot();
  const source = getSourceById(sourceId);
  if (!source) return getLibraryRoot();
  if (source.type === 'inpx') return path.dirname(source.path);
  return source.path;
}

/**
 * Горячий путь рендера/поиска не должен синхронно ходить по диску (особенно сетевому).
 * Поэтому здесь опираемся только на флаг источника из БД.
 * Актуализация флагов выполняется фоновым воркером и при индексации источников.
 */
export function effectiveSourceFlibustaForBook(row) {
  if (!row?.archiveName) return 0;
  return Number(row.sourceFlibusta) === 1 ? 1 : 0;
}

export function setConfiguredInpxFile(inpxFile) {
  const normalized = String(inpxFile || '').trim();
  if (!normalized) {
    throw new Error('Путь к INPX файлу не указан');
  }
  const resolved = path.resolve(normalized);

  const existing = getSourceByPath(resolved);
  if (existing) return resolved;

  try {
    addSource({ name: 'INPX Library', type: 'inpx', path: resolved });
  } catch {}

  setMeta('inpx_file', resolved);
  return resolved;
}

export async function ensureIndex(force = false, incremental = false) {
  const inpxFile = getConfiguredInpxFile();
  if (!inpxFile || !fs.existsSync(inpxFile)) {
    const msg = inpxFile
      ? `INPX file not found: ${inpxFile}`
      : 'INPX file path not configured. Set it in the admin panel.';
    console.error(msg);
    logSystemEvent('error', 'index', 'legacy INPX index cannot start', { error: msg });
    return { rebuilt: false, error: msg };
  }
  const currentMtime = String(fs.statSync(inpxFile).mtimeMs);
  const previousMtime = getMeta('inpx_mtime');
  const indexed = getMeta('indexed_at');
  if (!force && !incremental && indexed && previousMtime === currentMtime) {
    indexState.ready = true;
    indexState.active = false;
    indexState.finishedAt = indexed;
    logSystemEvent('info', 'index', 'legacy INPX index skipped (unchanged mtime)', { inpxFile: path.basename(inpxFile) });
    return { rebuilt: false, indexedAt: indexed };
  }

  const useIncremental = incremental && indexed && !force;
  await rebuildIndex(inpxFile, useIncremental);
  setMeta('inpx_mtime', currentMtime);
  setMeta('indexed_at', new Date().toISOString());
  return { rebuilt: true, indexedAt: getMeta('indexed_at') };
}

/**
 * Как FLibrary `Parser::Impl::ProcessInpx` (inpx.cpp): маска — только basename(.inp) + «.*» в папке коллекции,
 * не полный путь из архива INPX (`f/foo.inp` → ищем `foo.*` в корне). Так на диске оказывается реальный `foo.7z`.
 */
function resolveArchiveNameForInp(libraryRoot, inpRelativePath) {
  const root = path.resolve(String(libraryRoot || '').trim());
  const inpPosix = String(inpRelativePath || '').replace(/\\/g, '/').trim();
  const fullStem = inpPosix.replace(/\.inp$/i, '');
  const stem = path.posix.basename(fullStem);
  const zipRel = `${fullStem}.zip`;
  const sevenRel = `${fullStem}.7z`;
  const pick = (z, s) => {
    const hz = fs.existsSync(path.join(root, z));
    const h7 = fs.existsSync(path.join(root, s));
    if (h7 && !hz) return s;
    return z;
  };

  if (stem && !stem.includes('..')) {
    const cacheKey = root.toLowerCase();
    let stemMap = readTimedCache(archiveStemLookupCache, cacheKey);
    if (!stemMap) {
      stemMap = new Map();
      try {
        for (const f of fs.readdirSync(root)) {
          if (!/\.(zip|7z)$/i.test(f)) continue;
          const abs = path.join(root, f);
          let isFile = false;
          try {
            isFile = fs.statSync(abs).isFile();
          } catch {
            isFile = false;
          }
          if (!isFile) continue;
          const base = f.replace(/\.(zip|7z)$/i, '').toLowerCase();
          if (!stemMap.has(base)) stemMap.set(base, []);
          stemMap.get(base).push(f);
        }
      } catch {
        /* нет доступа / не каталог */
      }
      writeTimedCache(archiveStemLookupCache, cacheKey, stemMap, ARCHIVE_STEM_LOOKUP_TTL_MS, 32);
    }
    const matches = [...(stemMap.get(stem.toLowerCase()) || [])];
    if (matches.length) {
      matches.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      return matches[0].replace(/\\/g, '/');
    }
  }

  if (fs.existsSync(path.join(root, zipRel)) || fs.existsSync(path.join(root, sevenRel))) {
    return pick(zipRel, sevenRel);
  }
  const zipB = path.posix.basename(zipRel);
  const sevenB = path.posix.basename(sevenRel);
  if (fs.existsSync(path.join(root, zipB)) || fs.existsSync(path.join(root, sevenB))) {
    return pick(zipB, sevenB);
  }
  const abs = resolveLibraryArchiveFile(root, sevenRel) || resolveLibraryArchiveFile(root, zipRel);
  if (abs) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..')) return rel;
  }
  return pick(zipRel, sevenRel);
}

export async function rebuildIndex(inpxPath, incremental = false, sourceId = null) {
  await checkIndexControlPoint();
  clearRuntimeQueryCaches();
  const inpxOpenMs = parseEnvTimeoutMs('INPX_OPEN_TIMEOUT_MS', 180_000);
  const directory = await promiseWithTimeout(
    unzipper.Open.file(inpxPath),
    inpxOpenMs,
    'INPX Open.file'
  );
  const inpEntries = directory.files.filter((entry) => entry.path.endsWith('.inp'));

  // Read structure.info if present — defines field positions (FOLDER, custom order, etc.)
  let fieldMap = DEFAULT_FIELD_MAP;
  const structureEntry = directory.files.find((e) => /^structure\.info$/i.test(e.path));
  if (structureEntry) {
    try {
      const buf = await structureEntry.buffer();
      const parsed = parseStructureInfo(buf.toString('utf8'));
      // Only use if it has at least the essential fields
      if (parsed.title >= 0 && parsed.fileName >= 0) {
        fieldMap = parsed;
        console.log('[index] INPX structure.info parsed:', JSON.stringify(fieldMap));
      }
    } catch (err) {
      console.warn('[index] Failed to read structure.info:', err.message);
    }
  }

  // Read collection.info and version.info — store as metadata for display
  for (const infoName of ['collection.info', 'version.info']) {
    const infoEntry = directory.files.find((e) => e.path.toLowerCase() === infoName);
    if (infoEntry) {
      try {
        const buf = await infoEntry.buffer();
        const val = buf.toString('utf8').trim();
        if (val) {
          const metaKey = sourceId
            ? `${infoName.replace('.info', '')}_info_${sourceId}`
            : `${infoName.replace('.info', '')}_info`;
          setMeta(metaKey, val);
          console.log(`[index] INPX ${infoName}: ${val.slice(0, 200)}`);
        }
      } catch { /* ignore */ }
    }
  }

  const sizesKey = sourceId ? `inp_sizes_${sourceId}` : 'inp_sizes';
  let previousSizes = {};
  if (incremental) {
    try { previousSizes = JSON.parse(getMeta(sizesKey) || '{}'); } catch { previousSizes = {}; }
  }

  const entriesToProcess = incremental
    ? inpEntries.filter((entry) => {
        const prevSize = previousSizes[entry.path];
        return prevSize === undefined || prevSize !== entry.uncompressedSize;
      })
    : inpEntries;

  const skippedCount = inpEntries.length - entriesToProcess.length;

  /**
   * Полная переиндексация: без триггеров FTS, synchronous OFF, один rebuild в конце.
   * Инкремент с изменениями: триггеры FTS остаются включёнными — per-row overhead
   * незначителен по сравнению с полным rebuild всего индекса.
   * Инкремент без изменений: триггеры не трогаем, synchronous не ослабляем.
   */
  const ftsBulkMode = !incremental;
  let completedSuccessfully = false;

  try {
  if (ftsBulkMode) {
    beginFastSqliteImport();
    setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
  }
  if (!incremental) {
    dropBooksFtsTriggers();
    if (sourceId) {
      db.transaction(() => {
        db.prepare('DELETE FROM book_details_cache WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sourceId);
        db.prepare('DELETE FROM book_authors WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sourceId);
        db.prepare('DELETE FROM book_series WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sourceId);
        db.prepare('DELETE FROM book_genres WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(sourceId);
        db.prepare('DELETE FROM books WHERE source_id = ?').run(sourceId);
      })();
    } else {
      db.transaction(() => {
        db.exec('DELETE FROM book_authors');
        db.exec('DELETE FROM book_series');
        db.exec('DELETE FROM book_genres');
        db.exec('DELETE FROM authors');
        db.exec('DELETE FROM series_catalog');
        db.exec('DELETE FROM genres_catalog');
        db.exec('DELETE FROM books');
      })();
    }
    await yieldEventLoop();
  }

  indexState.totalArchives = inpEntries.length;
  indexState.processedArchives = skippedCount;
  indexState.importedBooks = 0;
  indexState.currentArchive = incremental && skippedCount > 0
    ? `(пропущено ${skippedCount} неизменённых)`
    : '';
  logSystemEvent('info', 'index', 'INPX rebuild started', {
    sourceId,
    incremental,
    totalInpArchives: inpEntries.length,
    archivesToProcess: entriesToProcess.length,
    skippedUnchanged: skippedCount,
    ftsBulkMode,
    inpxFile: path.basename(inpxPath)
  });
  const insertAuthor = db.prepare(`
    INSERT INTO authors(name, display_name, sort_name, search_name)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name = excluded.display_name,
      sort_name = excluded.sort_name,
      search_name = excluded.search_name
  `);
  const insertSeries = db.prepare(`
    INSERT INTO series_catalog(name, display_name, sort_name, search_name)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name = excluded.display_name,
      sort_name = excluded.sort_name,
      search_name = excluded.search_name
  `);
  const insertGenre = db.prepare(`
    INSERT INTO genres_catalog(name, display_name, sort_name, search_name)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name = excluded.display_name,
      sort_name = excluded.sort_name,
      search_name = excluded.search_name
  `);
  const selectAuthor = db.prepare('SELECT id FROM authors WHERE name = ?');
  const selectSeries = db.prepare('SELECT id FROM series_catalog WHERE name = ?');
  const selectGenre = db.prepare('SELECT id FROM genres_catalog WHERE name = ?');
  const linkAuthor = db.prepare('INSERT OR IGNORE INTO book_authors(book_id, author_id) VALUES(?, ?)');
  const linkSeries = db.prepare('INSERT OR REPLACE INTO book_series(book_id, series_id) VALUES(?, ?)');
  const linkGenre = db.prepare('INSERT OR IGNORE INTO book_genres(book_id, genre_id) VALUES(?, ?)');
  const unlinkAuthors = db.prepare('DELETE FROM book_authors WHERE book_id = ?');
  const unlinkSeries = db.prepare('DELETE FROM book_series WHERE book_id = ?');
  const unlinkGenres = db.prepare('DELETE FROM book_genres WHERE book_id = ?');
  const suppressedIds = getSuppressedBookIds();
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, source_id
    ) VALUES (
      @id, @title, @authors, @genres, @series, @seriesNo, @titleSort, @authorSort,
      @seriesSort, @seriesIndex, @titleSearch, @authorsSearch, @seriesSearch,
      @genresSearch, @keywordsSearch, @fileName, @archiveName, @size, @libId, @deleted,
      @ext, @date, @lang, @keywords, @sourceId
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      authors = excluded.authors,
      genres = excluded.genres,
      series = excluded.series,
      series_no = excluded.series_no,
      title_sort = excluded.title_sort,
      author_sort = excluded.author_sort,
      series_sort = excluded.series_sort,
      series_index = excluded.series_index,
      title_search = excluded.title_search,
      authors_search = excluded.authors_search,
      series_search = excluded.series_search,
      genres_search = excluded.genres_search,
      keywords_search = excluded.keywords_search,
      file_name = excluded.file_name,
      archive_name = excluded.archive_name,
      size = excluded.size,
      lib_id = excluded.lib_id,
      deleted = excluded.deleted,
      ext = excluded.ext,
      date = excluded.date,
      lang = excluded.lang,
      keywords = excluded.keywords,
      source_id = excluded.source_id,
      imported_at = CURRENT_TIMESTAMP
  `);

  const newSizes = incremental ? { ...previousSizes } : {};
  const archiveRoot = sourceId ? getSourceRoot(sourceId) : getLibraryRoot();

  /** Без FTS-триггеров: одна db.transaction() = синхронный участок. С ростом таблицы books индексы
   *  обновляются дольше — фиксированный чанк даёт «зависание на середине» на разных архивах. */
  function inpxImportChunkTarget() {
    if (!ftsBulkMode) return 120;
    const n = indexState.importedBooks;
    if (n > 450_000) return 35;
    if (n > 300_000) return 45;
    if (n > 200_000) return 60;
    if (n > 120_000) return 80;
    if (n > 60_000) return 110;
    return 150;
  }
  const adaptiveImportEnabled = isAdaptiveInpxImportEnabled();
  let adaptiveChunkTarget = inpxImportChunkTarget();
  let adaptiveYieldEveryNChunks = 1;
  const minChunkTarget = 25;
  const maxChunkTarget = 220;
  let slowChunkStreak = 0;
  let fastChunkStreak = 0;
  let highLagStreak = 0;
  let lowLagStreak = 0;
  const DIARY_CHUNK_LOG_EVERY = 20;
  const authorIdCache = new Map();
  const seriesIdCache = new Map();
  const genreIdCache = new Map();

  function resolveAuthorId(name) {
    let id = authorIdCache.get(name);
    if (id !== undefined) return id;
    insertAuthor.run(name, authorDisplayName(name), createSortKey(authorSortKey(name)), authorSearchName(name));
    id = selectAuthor.get(name)?.id || null;
    authorIdCache.set(name, id);
    return id;
  }

  function resolveSeriesId(name) {
    let id = seriesIdCache.get(name);
    if (id !== undefined) return id;
    insertSeries.run(name, seriesDisplayName(name), seriesSortName(name), seriesSearchName(name));
    id = selectSeries.get(name)?.id || null;
    seriesIdCache.set(name, id);
    return id;
  }

  function resolveGenreId(name) {
    let id = genreIdCache.get(name);
    if (id !== undefined) return id;
    insertGenre.run(name, genreDisplayName(name), genreSortName(name), genreSearchName(name));
    id = selectGenre.get(name)?.id || null;
    genreIdCache.set(name, id);
    return id;
  }

  const processChunk = db.transaction((batch, archiveName) => {
    for (const line of batch) {
      const row = enrichBookRow(parseLine(line, archiveName, sourceId, fieldMap));
      if (row && !row.deleted && !suppressedIds.has(row.id)) {
        row.sourceId = sourceId;
        insert.run(row);
        // Always unlink before re-linking: duplicate book IDs across .inp files
        // may change authors/series/genres — stale junction rows must be removed.
        unlinkAuthors.run(row.id);
        unlinkSeries.run(row.id);
        unlinkGenres.run(row.id);
        for (const authorName of splitAuthorValues(row.authors)) {
          const authorId = resolveAuthorId(authorName);
          if (authorId) {
            linkAuthor.run(row.id, authorId);
          }
        }

        if (row.series) {
          const seriesId = resolveSeriesId(row.series);
          if (seriesId) {
            linkSeries.run(row.id, seriesId);
          }
        }

        for (const genreName of splitFacetValues(row.genres)) {
          const genreId = resolveGenreId(genreName);
          if (genreId) {
            linkGenre.run(row.id, genreId);
          }
        }

        indexState.importedBooks += 1;
      }
    }
  });

  for (let ei = 0; ei < entriesToProcess.length; ei++) {
    await checkIndexControlPoint();
    const entry = entriesToProcess[ei];
    indexState.currentArchive = entry.path;

    const archiveName = resolveArchiveNameForInp(archiveRoot, entry.path);
    console.log(
      `[index] INPX: ${archiveName} (chunk ${ei + 1}/${entriesToProcess.length}${skippedCount ? `, unchanged_skipped=${skippedCount}` : ''})`
    );
    const nTot = entriesToProcess.length;
    const step = nTot <= 1 ? 1 : Math.max(1, Math.floor(nTot / 10));
    if (nTot > 0 && (ei === 0 || ei === nTot - 1 || (ei + 1) % step === 0)) {
      logSystemEvent('info', 'index', 'INPX archives progress', {
        sourceId,
        archiveIndex: ei + 1,
        archiveTotal: nTot,
        archive: path.basename(String(archiveName || '')),
        importedBooks: indexState.importedBooks
      });
    }
    await yieldEventLoop();
    await checkIndexControlPoint();
    const rawUc = Number(entry.uncompressedSize);
    const uc = Number.isFinite(rawUc) ? rawUc : 0;
    if (uc > MAX_INP_ENTRY_BYTES) {
      console.warn(
        `[index] INPX: пропуск ${entry.path}: несжатый размер ${uc} B > лимит ${MAX_INP_ENTRY_BYTES} B`
      );
      appendIndexDiaryLine(`INPX пропуск большого .inp: ${archiveName} (${uc} B)`);
      logSystemEvent('warn', 'index', 'INPX archive skipped (oversized .inp)', {
        sourceId,
        path: entry.path,
        uncompressedBytes: uc,
        limit: MAX_INP_ENTRY_BYTES
      });
      newSizes[entry.path] = entry.uncompressedSize;
      indexState.processedArchives += 1;
      continue;
    }
    const bufferMs = Math.min(600_000, 90_000 + Math.floor(uc / 30_000));
    let buffer;
    try {
      buffer = await promiseWithTimeout(entry.buffer(), bufferMs, `INPX buffer ${archiveName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[index] INPX: чтение ${entry.path} (${archiveName}): ${msg}`);
      appendIndexDiaryLine(`INPX ОШИБКА чтения .inp: ${archiveName} — ${msg}`);
      indexState.processedArchives += 1;
      continue;
    }
    await yieldEventLoop();
    await checkIndexControlPoint();
    const content = iconv.decode(buffer, TEXT_ENCODING);
    const approxMiB = (buffer.length / (1024 * 1024)).toFixed(2);
    console.log(`[index] INPX: ${archiveName} декодирован ~${approxMiB} MiB — потоковый разбор строк (без split на весь файл)`);
    await yieldEventLoop();

    /** Обновлять подпись в UI чаще, чем раз в 120 чанков — иначе на одном толстом .inp кажется, что индексация «застыла» на середине. */
    const UI_LINE_PROGRESS_EVERY = 20;
    let chunkSeq = 0;
    let lineCount = 0;
    let batch = [];
    let warnedLongLine = false;
    const flush = () => {
      if (!batch.length) return;
      const nextChunk = chunkSeq + 1;
      const shouldDiaryLogChunk = nextChunk === 1 || (nextChunk % DIARY_CHUNK_LOG_EVERY === 0);
      if (shouldDiaryLogChunk) {
        appendIndexDiaryLine(
          `INPX чанк ${nextChunk} → ${archiveName}: вставка ${batch.length} строк, ~строка файла ${lineCount}, в БД до чанка ~${indexState.importedBooks} книг`
        );
      }
      const t0 = Date.now();
      try {
        processChunk(batch, archiveName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendIndexDiaryLine(`INPX ОШИБКА чанк ${nextChunk} ${archiveName}: ${msg}`);
        throw err;
      }
      const ms = Date.now() - t0;
      if (shouldDiaryLogChunk || ms > 30_000) {
        appendIndexDiaryLine(
          `INPX чанк ${nextChunk} ✓ ${archiveName}: ${ms} ms, книг после ~${indexState.importedBooks}`
        );
      }
      if (ms > 45_000) {
        console.warn(
          `[index] INPX: медленный чанк ${nextChunk} (${archiveName}): ${ms} ms — при большой библиотеке это нормально, не обрывайте процесс`
        );
      }
      if (adaptiveImportEnabled) {
        if (ms > 3500) {
          slowChunkStreak += 1;
          fastChunkStreak = 0;
        } else if (ms < 1400) {
          fastChunkStreak += 1;
          slowChunkStreak = 0;
        } else {
          slowChunkStreak = 0;
          fastChunkStreak = 0;
        }

        if (slowChunkStreak >= 2 && adaptiveChunkTarget > minChunkTarget) {
          adaptiveChunkTarget = clampInt(Math.round(adaptiveChunkTarget * 0.82), minChunkTarget, maxChunkTarget);
          slowChunkStreak = 0;
          fastChunkStreak = 0;
          console.log(`[index] adaptive INPX chunk down -> ${adaptiveChunkTarget} (chunk ${nextChunk}, ${ms}ms)`);
        } else if (fastChunkStreak >= 3 && adaptiveChunkTarget < maxChunkTarget) {
          adaptiveChunkTarget = clampInt(Math.round(adaptiveChunkTarget * 1.12), minChunkTarget, maxChunkTarget);
          slowChunkStreak = 0;
          fastChunkStreak = 0;
          console.log(`[index] adaptive INPX chunk up -> ${adaptiveChunkTarget} (chunk ${nextChunk}, ${ms}ms)`);
        }
      }
      batch = [];
      chunkSeq = nextChunk;
    };

    for (const line of iterateInpTextLines(content)) {
      lineCount += 1;
      if (lineCount % 25_000 === 0) {
        await yieldEventLoop();
        await checkIndexControlPoint();
        if (chunkSeq % DIARY_CHUNK_LOG_EVERY === 0) {
          appendIndexDiaryLine(
            `INPX разбор строк ~${lineCount} (${archiveName}, чанков БД ${chunkSeq})`
          );
        }
      }
      if (line.length > MAX_INPX_LINE_CHARS) {
        if (!warnedLongLine) {
          console.warn(
            `[index] INPX: ${archiveName}: пропуск строк длиннее ${MAX_INPX_LINE_CHARS} симв.`
          );
          warnedLongLine = true;
        }
        continue;
      }
      batch.push(line);
      const targetChunkSize = adaptiveImportEnabled ? adaptiveChunkTarget : inpxImportChunkTarget();
      if (batch.length >= targetChunkSize) {
        flush();
        if (chunkSeq % UI_LINE_PROGRESS_EVERY === 0) {
          indexState.currentArchive = `${archiveName} … импорт ~${lineCount} строк (чанк ${chunkSeq}, архив ${ei + 1}/${entriesToProcess.length})`;
        }
        if (chunkSeq % 120 === 0) {
          console.log(`[index] INPX: ${archiveName} … ~${lineCount} строк (чанк импорта ${chunkSeq})`);
        }
        if (adaptiveImportEnabled) {
          const loopLagMs = await measureEventLoopLagMs();
          if (loopLagMs > 130) {
            highLagStreak += 1;
            lowLagStreak = 0;
          } else if (loopLagMs < 35) {
            lowLagStreak += 1;
            highLagStreak = 0;
          } else {
            highLagStreak = 0;
            lowLagStreak = 0;
          }

          if (highLagStreak >= 2) {
            adaptiveYieldEveryNChunks = clampInt(adaptiveYieldEveryNChunks + 1, 1, 3);
            highLagStreak = 0;
            lowLagStreak = 0;
          } else if (lowLagStreak >= 3) {
            adaptiveYieldEveryNChunks = clampInt(adaptiveYieldEveryNChunks - 1, 1, 3);
            highLagStreak = 0;
            lowLagStreak = 0;
          }
        }
        if (chunkSeq % adaptiveYieldEveryNChunks === 0) {
          await yieldEventLoop();
          await checkIndexControlPoint();
        }
      }
    }
    flush();
    indexState.currentArchive = `${archiveName} … готово ${lineCount} строк (${chunkSeq} чанков)`;
    console.log(`[index] INPX: ${archiveName} готово: ${lineCount} строк, чанков импорта ${chunkSeq}`);
    await yieldEventLoop();
    await checkIndexControlPoint();

    newSizes[entry.path] = entry.uncompressedSize;
    indexState.processedArchives += 1;
    authorIdCache.clear();
    seriesIdCache.clear();
    genreIdCache.clear();
  }

  logSystemEvent('info', 'index', 'INPX import pass completed', {
    sourceId,
    archivesProcessed: entriesToProcess.length,
    skippedUnchanged: skippedCount,
    importedBooks: indexState.importedBooks,
    incremental
  });

  if (!incremental) {
    for (const entry of inpEntries) {
      newSizes[entry.path] = entry.uncompressedSize;
    }
  }

  setMeta(sizesKey, JSON.stringify(newSizes));

  if (sourceId) {
    const { refreshFlibustaSidecarForSource } = await import('./flibusta-sidecar.js');
    await refreshFlibustaSidecarForSource(sourceId, archiveRoot, {
      rebuildAuxiliary: !incremental,
      onProgress: (msg) => {
        indexState.currentArchive = msg;
      }
    });
  }

  indexState.currentArchive = '';
  if (incremental) {
    console.log(`Incremental index: processed ${entriesToProcess.length}, skipped ${skippedCount} unchanged archives, imported ${indexState.importedBooks} books`);
  }
  
  // Фоновое предизвлечение обложек/аннотаций для новых книг этого источника
  if (sourceId) {
    const { warmupBookDetailsCache } = await import('./folder-indexer.js');
    setImmediate(() => warmupBookDetailsCache(sourceId, { limit: 300 }));
  }
  
  completedSuccessfully = true;
  } finally {
    if (ftsBulkMode && completedSuccessfully) {
      indexState.currentArchive = 'FTS: полная пересборка поиска…';
      const ftsT0 = Date.now();
      console.log(
        '[index] FTS: полная пересборка полнотекстового индекса (books_fts) — при больших библиотеках может занять несколько минут…'
      );
      logSystemEvent('info', 'index', 'INPX FTS full rebuild started', { sourceId });
      try {
        await rebuildBooksFtsFromContent({
          onProgress: ({ done, total }) => {
            indexState.currentArchive = `FTS: поиск ${done}/${total}…`;
          }
        });
        const ftsSec = ((Date.now() - ftsT0) / 1000).toFixed(1);
        console.log(`[index] FTS: готово за ${ftsSec} с`);
        logSystemEvent('info', 'index', 'INPX FTS full rebuild completed', { sourceId, seconds: Number(ftsSec) });
      } catch (err) {
        console.error('[index] FTS rebuild failed:', err.message);
        logSystemEvent('error', 'index', 'INPX FTS full rebuild failed', { sourceId, error: err.message });
      }
      ensureBooksFtsTriggers();
      setMeta(BOOKS_FTS_DIRTY_META_KEY, '0');
      indexState.currentArchive = '';
    } else if (ftsBulkMode) {
      // Indexing was interrupted (cancelled / error). FTS is out of sync with books table.
      // We MUST rebuild FTS before restoring triggers, otherwise any DELETE/UPDATE on
      // books will fire FTS triggers against a stale FTS index → "database disk image is malformed".
      console.log('[index] FTS: rebuilding after interrupted indexing…');
      logSystemEvent('info', 'index', 'INPX FTS rebuild after interruption', { sourceId });
      try {
        await rebuildBooksFtsFromContent();
        console.log('[index] FTS: rebuild after interruption completed');
        ensureBooksFtsTriggers();
        setMeta(BOOKS_FTS_DIRTY_META_KEY, '0');
      } catch (ftsErr) {
        console.error('[index] FTS rebuild after interruption failed:', ftsErr.message);
        // Leave triggers dropped and dirty flag set — boot will rebuild
        setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
      }
    }
    if (ftsBulkMode) {
      endFastSqliteImport();
    }
  }
}

function resolveSort(sort) {
  const sortMap = {
    recent: 'COALESCE(NULLIF(date, \'\'), imported_at) DESC, imported_at DESC, id DESC',
    title: 'title_sort ASC, title COLLATE NOCASE ASC, id DESC',
    author: 'author_sort ASC, title_sort ASC, id DESC',
    series: 'series_sort ASC, series_index ASC, title_sort ASC, id DESC'
  };
  return sortMap[sort] || sortMap.recent;
}

function resolveBookAliasSort(sort, alias = 'b') {
  const sortMap = {
    recent: `COALESCE(NULLIF(${alias}.date, ''), ${alias}.imported_at) DESC, ${alias}.imported_at DESC, ${alias}.id DESC`,
    title: `${alias}.title_sort ASC, ${alias}.title COLLATE NOCASE ASC, ${alias}.id DESC`,
    author: `${alias}.author_sort ASC, ${alias}.title_sort ASC, ${alias}.id DESC`,
    series: `${alias}.series_sort ASC, ${alias}.series_index ASC, ${alias}.title_sort ASC, ${alias}.id DESC`
  };
  return sortMap[sort] || sortMap.recent;
}

function mapBookListRow(row) {
  const downloadFormats = getAvailableDownloadFormats(row).map((format) => ({
    format,
    label: FORMAT_LABELS[format] || format.toUpperCase()
  }));
  return {
    ...row,
    seriesNo: row.seriesNo || '',
    genresList: splitFacetValues(row.genres),
    genresDisplayList: formatGenreList(row.genres),
    authorsList: splitAuthorValues(row.authors),
    downloadFormats
  };
}

function matchesBookSearchField(book, field, query) {
  const fieldMap = {
    title: {
      raw: book.title,
      normalized: book.titleSearch || normalizeText(book.title),
      sortKey: book.titleSearch || createSortKey(book.title)
    },
    authors: {
      raw: book.authors,
      normalized: book.authorsSearch || normalizeText(book.authors),
      sortKey: book.authorsSearch || createSortKey(book.authors)
    },
    series: {
      raw: book.series,
      normalized: book.seriesSearch || normalizeText(book.series),
      sortKey: book.seriesSearch || createSortKey(book.series)
    },
    genres: {
      raw: book.genres,
      normalized: book.genresSearch || normalizeText(book.genres),
      sortKey: book.genresSearch || createSortKey(book.genres)
    },
    keywords: {
      raw: book.keywords,
      normalized: book.keywordsSearch || normalizeText(book.keywords),
      sortKey: book.keywordsSearch || createSortKey(book.keywords)
    }
  };

  if (field === 'all') {
    return Object.keys(fieldMap).some((key) => matchesBookSearchField(book, key, query));
  }

  const descriptor = fieldMap[field];
  if (!descriptor) {
    return false;
  }

  return matchesSearchValue(descriptor.raw, query, {
    normalizedValue: String(descriptor.normalized || '').toLowerCase(),
    sortKey: String(descriptor.sortKey || '')
  });
}

function buildBookSearchSql(field, query) {
  const parsed = parseSearchOperator(query);
  if (parsed.operator === 'empty' || parsed.operator === '~') {
    return null;
  }

  const needleNormalized = normalizeYo(normalizeText(parsed.value)).toLowerCase();
  const needleSortKey = createSortKey(parsed.value);
  const tokenSource = parsed.operator === '=' ? [needleNormalized || needleSortKey] : createSortKey(parsed.value).split(/\s+/).filter(Boolean);
  const tokens = tokenSource.filter(Boolean);
  if (!needleNormalized && !needleSortKey && !tokens.length) {
    return null;
  }

  const columnMap = {
    title: ['title_search'],
    authors: ['authors_search'],
    series: ['series_search'],
    genres: ['genres_search'],
    keywords: ['keywords_search'],
    all: ['title_search', 'authors_search', 'series_search', 'genres_search', 'keywords_search']
  };

  const columns = columnMap[field];
  if (!columns?.length) {
    return null;
  }

  const values = parsed.operator === '='
    ? [needleNormalized, needleSortKey].filter(Boolean)
    : tokens;
  if (!values.length) {
    return null;
  }

  const makeClause = (column, value) => {
    if (parsed.operator === '=') {
      return { sql: `LOWER(COALESCE(${column}, '')) = ?`, param: value };
    }

    if (parsed.operator === '*') {
      return { sql: `LOWER(COALESCE(${column}, '')) LIKE ?`, param: `%${value}%` };
    }

    return { sql: `LOWER(COALESCE(${column}, '')) LIKE ?`, param: `%${value}%` };
  };

  const tokenClauses = [];
  const params = [];
  for (const value of values) {
    const clauses = [];
    for (const column of columns) {
      const clause = makeClause(column, value);
      clauses.push(clause.sql);
      params.push(clause.param);
    }
    tokenClauses.push(clauses.map((clause) => `(${clause})`).join(' OR '));
  }

  return {
    where: tokenClauses.map((clause) => `(${clause})`).join(' AND '),
    params
  };
}

function buildGenreFilterSql(genre = '') {
  const normalizedGenre = normalizeText(genre);
  if (!normalizedGenre) {
    return null;
  }

  return {
    where: `EXISTS (
      SELECT 1
      FROM book_genres bg
      JOIN genres_catalog g ON g.id = bg.genre_id
      WHERE bg.book_id = active_books.id AND g.name = ?
    )`,
    params: [normalizedGenre]
  };
}

function buildAuthorWhereForBooks(query) {
  const parsed = parseSearchOperator(query);
  const needleKey = createSortKey(parsed.value || query);
  const tokens = needleKey.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const params = [];
  let where;
  const surnameExpr = `SUBSTR(COALESCE(a2.sort_name, ''), 1, INSTR(COALESCE(a2.sort_name, '') || ' ', ' ') - 1)`;
  if (tokens.length === 1) {
    where = `EXISTS (
      SELECT 1 FROM book_authors ba2
      JOIN authors a2 ON a2.id = ba2.author_id
      WHERE ba2.book_id = active_books.id
        AND ${surnameExpr} = ?
    )`;
    params.push(tokens[0]);
  } else {
    const clauses = tokens.map(() => `(' ' || COALESCE(a2.sort_name, '') || ' ') LIKE ?`);
    where = `EXISTS (
      SELECT 1 FROM book_authors ba2
      JOIN authors a2 ON a2.id = ba2.author_id
      WHERE ba2.book_id = active_books.id
        AND ${clauses.join(' AND ')}
    )`;
    for (const t of tokens) params.push(`% ${t}%`);
  }

  const rankParams = [];
  const rankCases = [];
  if (tokens.length === 1) {
    rankCases.push(`WHEN ${surnameExpr} = ? THEN 1`);
    rankParams.push(tokens[0]);
    rankCases.push(`WHEN ${surnameExpr} LIKE ? THEN 2`);
    rankParams.push(`${tokens[0]}%`);
  } else {
    rankCases.push(`WHEN COALESCE(a2.sort_name, '') = ? THEN 1`);
    rankParams.push(needleKey);
    const reversed = [...tokens].reverse().join(' ');
    rankCases.push(`WHEN COALESCE(a2.sort_name, '') = ? THEN 1`);
    rankParams.push(reversed);
  }

  const authorRankSQL = `(SELECT MIN(CASE ${rankCases.join(' ')} ELSE 5 END) FROM book_authors ba2 JOIN authors a2 ON a2.id = ba2.author_id WHERE ba2.book_id = active_books.id)`;

  return { where, params, authorRankSQL, authorRankParams: rankParams };
}

function buildCatalogSearchSql(column, query, { startsWith = false } = {}) {
  const parsed = parseSearchOperator(query);
  if (parsed.operator === 'empty' || parsed.operator === '~') {
    return null;
  }

  const normalized = createSortKey(parsed.value);
  const values = parsed.operator === '='
    ? [normalized].filter(Boolean)
    : normalized.split(/\s+/).filter(Boolean);

  if (!values.length) {
    return null;
  }

  const tokenClauses = [];
  const params = [];
  for (const value of values) {
    if (parsed.operator === '=') {
      tokenClauses.push(`COALESCE(${column}, '') = ?`);
      params.push(value);
      continue;
    }

    if (parsed.operator === '*') {
      tokenClauses.push(`COALESCE(${column}, '') LIKE ?`);
      params.push(`%${value}%`);
      continue;
    }

    tokenClauses.push(`COALESCE(${column}, '') LIKE ?`);
    params.push(startsWith ? `${value}%` : `%${value}%`);
  }

  return {
    where: tokenClauses.map((clause) => `(${clause})`).join(startsWith ? ' AND ' : ' AND '),
    params
  };
}

export function searchBooks({ query = '', page = 1, pageSize = 24, field = 'all', sort = 'recent', genre = '', letter = '' }) {
  const offset = (page - 1) * pageSize;
  const orderBy = resolveSort(sort);
  const genreFilter = buildGenreFilterSql(genre);
  const parsedQuery = parseSearchOperator(query);
  const letterNorm = String(letter || '').trim().toLowerCase();
  if (!query.trim()) {
    const whereParts = [];
    const whereParams = [];
    if (genreFilter) { whereParts.push(genreFilter.where); whereParams.push(...genreFilter.params); }
    if (letterNorm) { whereParts.push('b.title_sort LIKE ?'); whereParams.push(`${letterNorm}%`); }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const gfParams = whereParams;
    const listOrderBy =
      sort === 'recent'
        ? 'COALESCE(s.flibusta_sidecar, 0) DESC, COALESCE(NULLIF(b.date, \'\'), b.imported_at) DESC, b.imported_at DESC, b.id DESC'
        : resolveBookAliasSort(sort, 'b');

    const total = db
      .prepare(
        `
      SELECT COUNT(*) AS count
      FROM active_books b
      LEFT JOIN sources s ON s.id = b.source_id
      ${whereSql}
    `
      )
      .get(...gfParams).count;

    const items = db
      .prepare(
        `
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName
      FROM active_books b
      LEFT JOIN sources s ON s.id = b.source_id
      ${whereSql}
      ORDER BY ${listOrderBy}
      LIMIT ? OFFSET ?
    `
      )
      .all(...gfParams, pageSize, offset)
      .map(mapBookListRow);

    return { total, items };
  }

  if (['all', 'title', 'authors', 'series', 'genres', 'keywords'].includes(field)) {
    const sqlSearch = buildBookSearchSql(field, query);
    const authorMatch = (field === 'all') ? buildAuthorWhereForBooks(query) : null;

    if (sqlSearch || authorMatch) {
      const needleKey = createSortKey(parsedQuery.value || query);
      const needleTokens = needleKey.split(/\s+/).filter(Boolean);

      const mainWhereParts = [];
      const mainWhereParams = [];
      if (sqlSearch) {
        mainWhereParts.push(sqlSearch.where);
        mainWhereParams.push(...sqlSearch.params);
      }
      if (authorMatch) {
        mainWhereParts.push(authorMatch.where);
        mainWhereParams.push(...authorMatch.params);
      }
      const searchWhere = mainWhereParts.map(p => `(${p})`).join(' OR ');

      const fullWhereParts = [searchWhere];
      const fullWhereParams = [...mainWhereParams];
      if (genreFilter) {
        fullWhereParts.push(genreFilter.where);
        fullWhereParams.push(...genreFilter.params);
      }
      const combinedWhere = fullWhereParts.map(p => `(${p})`).join(' AND ');

      const total = db.prepare(`
        SELECT COUNT(*) AS count FROM active_books WHERE ${combinedWhere}
      `).get(...fullWhereParams).count;

      const titleRankParts = [];
      const titleRankParams = [];
      if (sqlSearch && needleKey) {
        const col = field === 'all' ? 'title_search' : ({ title: 'title_search', authors: 'authors_search', series: 'series_search' }[field] || null);
        if (col) {
          titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) = ? THEN 0`);
          titleRankParams.push(needleKey);
          if (needleTokens.length > 1) {
            titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) = ? THEN 0`);
            titleRankParams.push([...needleTokens].reverse().join(' '));
          }
          titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) LIKE ? THEN 3`);
          titleRankParams.push(`${needleKey}%`);
        }
      }

      let rankSQL;
      const allRankParams = [];
      if (titleRankParts.length && authorMatch) {
        rankSQL = `CASE ${titleRankParts.join(' ')} ELSE COALESCE(${authorMatch.authorRankSQL}, 20) END`;
        allRankParams.push(...titleRankParams, ...authorMatch.authorRankParams);
      } else if (titleRankParts.length) {
        rankSQL = `CASE ${titleRankParts.join(' ')} ELSE 4 END`;
        allRankParams.push(...titleRankParams);
      } else if (authorMatch) {
        rankSQL = authorMatch.authorRankSQL;
        allRankParams.push(...authorMatch.authorRankParams);
      } else {
        rankSQL = '0';
      }

      const rankedOrderBy = `${rankSQL} ASC, ${orderBy}`;
      const items = db.prepare(`
        SELECT id, title, authors, genres, series, series_no AS seriesNo, ext, lang,
               archive_name AS archiveName
        FROM active_books
        WHERE ${combinedWhere}
        ORDER BY ${rankedOrderBy}
        LIMIT ? OFFSET ?
      `).all(...fullWhereParams, ...allRankParams, pageSize, offset).map(mapBookListRow);

      return { total, items };
    }

    if (parsedQuery.operator === '~') {
      const REGEX_SCAN_LIMIT = 10000;
      const items = db.prepare(`
        SELECT id, title, authors, genres, series, series_no AS seriesNo, ext, lang,
               archive_name AS archiveName, keywords,
               title_search AS titleSearch,
               authors_search AS authorsSearch,
               series_search AS seriesSearch,
               genres_search AS genresSearch,
               keywords_search AS keywordsSearch
        FROM active_books
        ${genreFilter ? `WHERE ${genreFilter.where}` : ''}
        ORDER BY ${orderBy}
        LIMIT ${REGEX_SCAN_LIMIT}
      `).all(...(genreFilter ? genreFilter.params : []))
        .map(mapBookListRow)
        .filter((book) => matchesBookSearchField(book, field, query));

      return { total: items.length, items: items.slice(offset, offset + pageSize) };
    }
  }

  const safeQuery = normalizeYo(query)
    .trim()
    .split(/\s+/)
    .map((token) => `"${token.replace(/"/g, '')}"*`)
    .filter((token) => token !== '""*')
    .join(' ');

  const columnMap = {
    all: '',
    title: 'title',
    authors: 'authors',
    series: 'series',
    genres: 'genres',
    languages: 'lang',
    keywords: 'keywords'
  };

  const prefix = columnMap[field] ? `${columnMap[field]}:` : '';
  const ftsQuery = `${prefix}${safeQuery}`;
  const ftsWhere = genreFilter
    ? `books_fts MATCH ? AND EXISTS (
        SELECT 1
        FROM book_genres bg
        JOIN genres_catalog g ON g.id = bg.genre_id
        WHERE bg.book_id = b.id AND g.name = ?
      )`
    : 'books_fts MATCH ?';
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM books_fts f
    JOIN active_books b ON b.rowid = f.rowid
    WHERE ${ftsWhere}
  `).get(...(genreFilter ? [ftsQuery, ...genreFilter.params] : [ftsQuery])).count;

  const searchOrderBy = resolveBookAliasSort(sort, 'b');
  const items = db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName
    FROM books_fts f
    JOIN active_books b ON b.rowid = f.rowid
    WHERE ${ftsWhere}
    ORDER BY ${searchOrderBy}
    LIMIT ? OFFSET ?
  `).all(...(genreFilter ? [ftsQuery, ...genreFilter.params, pageSize, offset] : [ftsQuery, pageSize, offset])).map(mapBookListRow);

  return { total, items };
}

export function searchCatalog({ query = '', page = 1, pageSize = 24, field = 'books', sort = 'recent', genre = '', letter = '' }) {
  const bookFields = new Set(['books', 'title', 'book-authors', 'book-series', 'genres', 'keywords']);
  const normalizedField = ['books', 'authors', 'series', 'title', 'book-authors', 'book-series', 'genres', 'keywords'].includes(field) ? field : 'books';
  if (!String(query || '').trim() && !String(genre || '').trim() && !String(letter || '').trim()) {
    return { total: 0, items: [], field: normalizedField };
  }

  if (normalizedField === 'authors') {
    const result = listAuthors({ page, pageSize, query, sort: sort === 'name' ? 'name' : 'count', letter });
    return { ...result, field: normalizedField };
  }

  if (normalizedField === 'series') {
    const result = listSeries({ page, pageSize, query, sort: sort === 'name' ? 'name' : 'count', letter });
    return { ...result, field: normalizedField };
  }

  const bookFieldMap = {
    books: 'all',
    title: 'title',
    'book-authors': 'authors',
    'book-series': 'series',
    genres: 'genres',
    keywords: 'keywords'
  };

  const result = searchBooks({
    query,
    page,
    pageSize,
    field: bookFields.has(normalizedField) ? bookFieldMap[normalizedField] : 'all',
    sort,
    genre,
    letter
  });
  return { ...result, field: normalizedField };
}

export function getBookById(id) {
  const row = db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.file_name AS fileName,
           b.archive_name AS archiveName, b.size, b.lib_id AS libId, b.ext, b.date, b.lang, b.keywords,
           b.source_id AS sourceId, b.imported_at AS importedAt,
           COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta
    FROM active_books b
    LEFT JOIN sources s ON s.id = b.source_id
    WHERE b.id = ?
  `).get(id);
  if (!row) return null;
  const sourceFlibusta = effectiveSourceFlibustaForBook(row);
  return mapBookListRow({ ...row, sourceFlibusta });
}

/**
 * Batch lookup: returns a Map<id, book> for the given list of IDs.
 * Uses a single WHERE id IN (...) query instead of N separate queries.
 */
export function getBooksByIds(ids) {
  if (!ids || ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.file_name AS fileName,
           b.archive_name AS archiveName, b.size, b.lib_id AS libId, b.ext, b.date, b.lang, b.keywords,
           b.source_id AS sourceId, b.imported_at AS importedAt,
           COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta
    FROM active_books b
    LEFT JOIN sources s ON s.id = b.source_id
    WHERE b.id IN (${placeholders})
  `).all(...ids);
  const result = new Map();
  for (const row of rows) {
    const sourceFlibusta = effectiveSourceFlibustaForBook(row);
    result.set(row.id, mapBookListRow({ ...row, sourceFlibusta }));
  }
  return result;
}

/**
 * Обновление метаданных книги: title, authors, series, series_no.
 * Пересчитывает sort/search поля, обновляет junction-таблицы и кеши.
 */
export function updateBookMetadata(bookId, { title, authors, series, seriesNo }) {
  const existing = db.prepare('SELECT id FROM books WHERE id = ? AND deleted = 0').get(String(bookId));
  if (!existing) return false;

  const titleNorm = normalizeText(title || '');
  const authorsNorm = normalizeText(authors || '');
  const seriesNorm = normalizeText(series || '');
  const seriesNoNorm = String(seriesNo || '').trim();

  const primaryAuthor = splitAuthorValues(authorsNorm)[0] || '';
  const titleSortVal = createSortKey(titleNorm);
  const authorSortVal = createSortKey(authorSortKey(primaryAuthor));
  const seriesSortVal = createSortKey(seriesNorm);
  const seriesIndexVal = normalizeSeriesIndex(seriesNoNorm);
  const titleSearchVal = createSortKey(titleNorm);
  const authorsSearchVal = splitAuthorValues(authorsNorm)
    .map((item) => createSortKey(formatSingleAuthorName(item) || item))
    .filter(Boolean).join(' | ');
  const seriesSearchVal = createSortKey(seriesNorm);

  const doUpdate = db.transaction(() => {
    // 1. Update books table
    db.prepare(`
      UPDATE books SET
        title = ?, authors = ?, series = ?, series_no = ?,
        title_sort = ?, author_sort = ?, series_sort = ?, series_index = ?,
        title_search = ?, authors_search = ?, series_search = ?
      WHERE id = ?
    `).run(
      titleNorm, authorsNorm, seriesNorm, seriesNoNorm,
      titleSortVal, authorSortVal, seriesSortVal, seriesIndexVal,
      titleSearchVal, authorsSearchVal, seriesSearchVal,
      String(bookId)
    );

    // 2. Rebuild book_authors junction
    db.prepare('DELETE FROM book_authors WHERE book_id = ?').run(String(bookId));
    const authorTokens = splitAuthorValues(authorsNorm);
    const upsertAuthor = db.prepare(`
      INSERT INTO authors(name, display_name, sort_name, search_name)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        display_name = excluded.display_name,
        sort_name = excluded.sort_name,
        search_name = excluded.search_name
    `);
    const selectAuthorId = db.prepare('SELECT id FROM authors WHERE name = ?');
    const linkBookAuthor = db.prepare('INSERT OR IGNORE INTO book_authors(book_id, author_id) VALUES(?, ?)');
    for (const token of authorTokens) {
      const displayName = formatSingleAuthorName(token) || token;
      const sortName = createSortKey(authorSortKey(token));
      const searchName = createSortKey(displayName);
      upsertAuthor.run(token, displayName, sortName, searchName);
      const authorRow = selectAuthorId.get(token);
      if (authorRow) {
        linkBookAuthor.run(String(bookId), authorRow.id);
      }
    }

    // 3. Rebuild book_series junction
    db.prepare('DELETE FROM book_series WHERE book_id = ?').run(String(bookId));
    if (seriesNorm) {
      const displayName = seriesNorm;
      const sortName = createSortKey(seriesNorm);
      const searchName = createSortKey(seriesNorm);
      db.prepare(`
        INSERT INTO series_catalog(name, display_name, sort_name, search_name)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          display_name = excluded.display_name,
          sort_name = excluded.sort_name,
          search_name = excluded.search_name
      `).run(seriesNorm, displayName, sortName, searchName);
      const seriesRow = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get(seriesNorm);
      if (seriesRow) {
        db.prepare('INSERT OR REPLACE INTO book_series(book_id, series_id) VALUES(?, ?)').run(String(bookId), seriesRow.id);
      }
    }

    // 4. Invalidate book details cache
    db.prepare('DELETE FROM book_details_cache WHERE book_id = ?').run(String(bookId));

    // 5. Update dedup projection
    const dedupKey = `${titleSortVal}|${authorSortVal}`;
    db.prepare(`
      INSERT INTO library_dedup_projection(dedup_key, book_id, title_sort, author_sort, series_sort, series_index, sort_date)
      VALUES(?, ?, ?, ?, ?, ?, (SELECT date FROM books WHERE id = ?))
      ON CONFLICT(dedup_key) DO UPDATE SET
        title_sort = excluded.title_sort,
        author_sort = excluded.author_sort,
        series_sort = excluded.series_sort,
        series_index = excluded.series_index,
        sort_date = excluded.sort_date
    `).run(dedupKey, String(bookId), titleSortVal, authorSortVal, seriesSortVal, seriesIndexVal, String(bookId));
  });

  doUpdate();
  return true;
}

/** Каталог считается без дублей одной книги; кандидаты для «переноса обложки» не ищем. */
export function getBookDuplicateCandidates(_bookId, _limit = 8) {
  return [];
}

// ─── Duplicate detection ─────────────────────────────────────────
export function getDuplicateGroups({ page = 1, pageSize = 50 } = {}) {
  const offset = (page - 1) * pageSize;
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM active_books
      WHERE title_sort IS NOT NULL AND title_sort != ''
      GROUP BY title_sort, authors
      HAVING COUNT(*) > 1
    )
  `).get();
  const total = totalRow?.count || 0;

  const groups = db.prepare(`
    WITH dup_keys AS (
      SELECT title_sort, authors
      FROM active_books
      WHERE title_sort IS NOT NULL AND title_sort != ''
      GROUP BY title_sort, authors
      HAVING COUNT(*) > 1
      ORDER BY title_sort ASC
      LIMIT ? OFFSET ?
    )
    SELECT b.id, b.title, b.authors, b.ext, b.lang, b.size, b.file_name, b.archive_name,
           b.title_sort, b.source_id
    FROM active_books b
    JOIN dup_keys dk ON dk.title_sort = b.title_sort AND dk.authors = b.authors
    ORDER BY b.title_sort ASC, b.authors ASC, b.ext ASC, b.id ASC
  `).all(pageSize, offset);

  // Group into arrays by (title_sort, authors)
  const grouped = [];
  let current = null;
  for (const row of groups) {
    const key = `${row.title_sort}\0${row.authors}`;
    if (!current || current.key !== key) {
      current = { key, title: row.title, authors: row.authors, items: [] };
      grouped.push(current);
    }
    current.items.push(row);
  }
  return { total, groups: grouped };
}

export function softDeleteBook(bookId) {
  const book = db.prepare('SELECT id, title, authors FROM books WHERE id = ? AND deleted = 0').get(String(bookId));
  if (!book) return 0;
  db.prepare('UPDATE books SET deleted = 1 WHERE id = ?').run(String(bookId));
  suppressBook(bookId, book.title || '', book.authors || '', 'user');
  return 1;
}

/**
 * Автоочистка дубликатов: в каждой группе (title_sort + authors) оставляем лучшую копию,
 * остальные мягко удаляем. Ранжирование: формат (epub>fb2>mobi>djvu>pdf>doc>txt), затем размер.
 */
export function autoCleanDuplicates() {
  const FORMAT_RANK = { epub: 1, fb2: 2, mobi: 3, azw3: 4, djvu: 5, pdf: 6, doc: 7, docx: 8, rtf: 9, txt: 10 };
  const maxRank = 99;

  // Fetch ALL duplicate books in one query
  const rows = db.prepare(`
    WITH dup_keys AS (
      SELECT title_sort, authors
      FROM active_books
      WHERE title_sort IS NOT NULL AND title_sort != ''
      GROUP BY title_sort, authors
      HAVING COUNT(*) > 1
    )
    SELECT b.id, b.ext, b.size, b.title_sort, b.authors
    FROM active_books b
    JOIN dup_keys dk ON dk.title_sort = b.title_sort AND dk.authors = b.authors
    ORDER BY b.title_sort ASC, b.authors ASC
  `).all();

  // Group
  const groups = [];
  let cur = null;
  for (const r of rows) {
    const key = `${r.title_sort}\0${r.authors}`;
    if (!cur || cur.key !== key) {
      cur = { key, items: [] };
      groups.push(cur);
    }
    cur.items.push(r);
  }

  // Rank & delete in transaction
  const delStmt = db.prepare('UPDATE books SET deleted = 1 WHERE id = ? AND deleted = 0');
  const suppressStmt = db.prepare(`INSERT INTO suppressed_books(book_id, title, authors, reason) VALUES(?, ?, ?, 'auto_clean')
    ON CONFLICT(book_id) DO UPDATE SET reason = 'auto_clean', suppressed_at = CURRENT_TIMESTAMP`);
  let totalDeleted = 0;
  const doClean = db.transaction(() => {
    for (const g of groups) {
      // Sort: best first (lowest format rank, then largest size)
      g.items.sort((a, b) => {
        const fa = FORMAT_RANK[(a.ext || '').toLowerCase()] || maxRank;
        const fb = FORMAT_RANK[(b.ext || '').toLowerCase()] || maxRank;
        if (fa !== fb) return fa - fb;
        return (b.size || 0) - (a.size || 0);
      });
      // Keep first, delete rest
      for (let i = 1; i < g.items.length; i++) {
        const item = g.items[i];
        const changes = delStmt.run(item.id).changes;
        if (changes) {
          suppressStmt.run(item.id, item.title_sort || '', item.authors || '');
          totalDeleted += changes;
        }
      }
    }
  });
  doClean();
  return { groupsCleaned: groups.length, totalDeleted };
}

/** Preview: how many books would be deleted by auto-clean */
export function previewAutoClean() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS totalBooks,
      (SELECT COUNT(*) FROM (
        SELECT 1 FROM active_books
        WHERE title_sort IS NOT NULL AND title_sort != ''
        GROUP BY title_sort, authors
        HAVING COUNT(*) > 1
      )) AS totalGroups
    FROM active_books b
    WHERE EXISTS (
      SELECT 1 FROM active_books b2
      WHERE b2.title_sort = b.title_sort AND b2.authors = b.authors
        AND b2.title_sort IS NOT NULL AND b2.title_sort != ''
        AND b2.id != b.id
    )
  `).get();
  const totalGroups = row?.totalGroups || 0;
  const totalBooks = row?.totalBooks || 0;
  // Will delete totalBooks - totalGroups (one kept per group)
  return { totalGroups, totalBooks, willDelete: totalBooks - totalGroups };
}

let _stmtGetStats;

export function getStats() {
  if (!_stmtGetStats) {
    _stmtGetStats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM active_books) AS totalBooks,
        (SELECT COUNT(*) FROM authors) AS totalAuthors,
        (SELECT COUNT(*) FROM series_catalog) AS totalSeries,
        (SELECT COUNT(*) FROM genres_catalog) AS totalGenres,
        (SELECT COUNT(DISTINCT NULLIF(lang, '')) FROM active_books) AS totalLanguages
    `);
  }
  return _stmtGetStats.get();
}

export function listAuthors({ page = 1, pageSize = 50, query = '', sort = 'count', startsWith = false, letter = '' }) {
  const offset = (page - 1) * pageSize;
  const parsed = parseSearchOperator(query);
  const needleKey = createSortKey(parsed.value || query);
  const needleTokens = needleKey.split(/\s+/).filter(Boolean);
  const letterNorm = String(letter || '').trim().toLowerCase();

  if (!needleTokens.length) {
    const orderBy = sort === 'name'
      ? 'COALESCE(a.sort_name, LOWER(a.name)) ASC'
      : 'a.book_count DESC, COALESCE(a.sort_name, LOWER(a.name)) ASC';
    const whereParts = ['a.book_count > 0'];
    const whereParams = [];
    if (letterNorm) {
      whereParts.push('COALESCE(a.sort_name, LOWER(a.name)) LIKE ?');
      whereParams.push(`${letterNorm}%`);
    }
    const whereClause = `WHERE ${whereParts.join(' AND ')}`;
    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM authors a ${whereClause}
    `).get(...whereParams).count;
    const items = db.prepare(`
      SELECT a.name AS name,
             COALESCE(a.display_name, a.name) AS displayName,
             COALESCE(a.sort_name, LOWER(a.name)) AS sortKey,
             a.book_count AS bookCount
      FROM authors a
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...whereParams, pageSize, offset);
    return { total, items };
  }

  const surnameExpr = `SUBSTR(COALESCE(a.sort_name, ''), 1, INSTR(COALESCE(a.sort_name, '') || ' ', ' ') - 1)`;
  const whereParams = [];
  const rankCases = [];
  const rankParams = [];
  let whereSQL;

  if (needleTokens.length === 1) {
    const word = needleTokens[0];
    if (parsed.operator === '=') {
      whereSQL = `COALESCE(a.search_name, '') = ?`;
      whereParams.push(word);
    } else {
      whereSQL = `COALESCE(a.search_name, '') LIKE ?`;
      whereParams.push(`%${word}%`);
    }

    rankCases.push(`WHEN ${surnameExpr} = ? THEN 0`);
    rankParams.push(word);
    rankCases.push(`WHEN COALESCE(a.search_name, '') = ? THEN 0`);
    rankParams.push(word);
    if (parsed.operator !== '=') {
      rankCases.push(`WHEN ${surnameExpr} LIKE ? THEN 1`);
      rankParams.push(`${word}%`);
    }
  } else {
    if (parsed.operator === '=') {
      whereSQL = `COALESCE(a.sort_name, '') = ?`;
      whereParams.push(needleKey);
    } else {
      const clauses = needleTokens.map(() => `(' ' || COALESCE(a.sort_name, '') || ' ') LIKE ?`);
      whereSQL = clauses.join(' AND ');
      for (const token of needleTokens) {
        whereParams.push(`% ${token}%`);
      }
    }

    rankCases.push(`WHEN COALESCE(a.sort_name, '') = ? THEN 0`);
    rankParams.push(needleKey);
    const reversedKey = [...needleTokens].reverse().join(' ');
    rankCases.push(`WHEN COALESCE(a.sort_name, '') = ? THEN 0`);
    rankParams.push(reversedKey);
  }

  const rankSQL = rankCases.length
    ? `CASE ${rankCases.join(' ')} ELSE 3 END`
    : '3';

  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM authors a
    WHERE (${whereSQL}) AND a.book_count > 0
  `).get(...whereParams).count;

  const orderBy = sort === 'name'
    ? `${rankSQL} ASC, COALESCE(a.sort_name, LOWER(a.name)) ASC`
    : `${rankSQL} ASC, a.book_count DESC, COALESCE(a.sort_name, LOWER(a.name)) ASC`;

  const items = db.prepare(`
    SELECT a.name AS name,
           COALESCE(a.display_name, a.name) AS displayName,
           COALESCE(a.sort_name, LOWER(a.name)) AS sortKey,
           a.book_count AS bookCount
    FROM authors a
    WHERE (${whereSQL}) AND a.book_count > 0
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...whereParams, ...rankParams, pageSize, offset);

  return { total, items };
}

export function listSeries({ page = 1, pageSize = 50, query = '', sort = 'count', letter = '' }) {
  const offset = (page - 1) * pageSize;
  const parsed = parseSearchOperator(query);
  const needleKey = createSortKey(parsed.value || query);
  const needleTokens = needleKey.split(/\s+/).filter(Boolean);
  const hasQuery = needleTokens.length > 0;
  const letterNorm = String(letter || '').trim().toLowerCase();

  if (!hasQuery) {
    const orderBy = sort === 'name'
      ? 'COALESCE(s.sort_name, LOWER(s.name)) ASC'
      : 's.book_count DESC, COALESCE(s.sort_name, LOWER(s.name)) ASC';
    const whereParts = ['s.book_count > 0'];
    const whereParams = [];
    if (letterNorm) {
      whereParts.push('COALESCE(s.sort_name, LOWER(s.name)) LIKE ?');
      whereParams.push(`${letterNorm}%`);
    }
    const whereClause = `WHERE ${whereParts.join(' AND ')}`;
    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM series_catalog s ${whereClause}
    `).get(...whereParams).count;
    const items = db.prepare(`
      SELECT s.name AS name,
             COALESCE(s.display_name, s.name) AS displayName,
             COALESCE(s.sort_name, LOWER(s.name)) AS sortKey,
             s.book_count AS bookCount
      FROM series_catalog s
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...whereParams, pageSize, offset);
    return { total, items };
  }

  const nameSearch = buildCatalogSearchSql('s.search_name', query);

  const authorTokens = needleTokens;
  let authorWhere, authorWhereParams = [], authorRankSQL, authorRankParams = [];
  const snExpr = `SUBSTR(COALESCE(a2.sort_name, ''), 1, INSTR(COALESCE(a2.sort_name, '') || ' ', ' ') - 1)`;
  if (authorTokens.length === 1) {
    authorWhere = `EXISTS (
      SELECT 1 FROM book_series bs2
      JOIN active_books b2 ON b2.id = bs2.book_id
      JOIN book_authors ba2 ON ba2.book_id = b2.id
      JOIN authors a2 ON a2.id = ba2.author_id
      WHERE bs2.series_id = s.id AND ${snExpr} = ?
    )`;
    authorWhereParams.push(authorTokens[0]);

    authorRankSQL = `(SELECT MIN(CASE WHEN ${snExpr} = ? THEN 1 WHEN ${snExpr} LIKE ? THEN 2 ELSE 5 END) FROM book_series bs2 JOIN active_books b2 ON b2.id = bs2.book_id JOIN book_authors ba2 ON ba2.book_id = b2.id JOIN authors a2 ON a2.id = ba2.author_id WHERE bs2.series_id = s.id)`;
    authorRankParams.push(authorTokens[0], `${authorTokens[0]}%`);
  } else {
    const aClauses = authorTokens.map(() => `(' ' || COALESCE(a2.sort_name, '') || ' ') LIKE ?`);
    authorWhere = `EXISTS (
      SELECT 1 FROM book_series bs2
      JOIN active_books b2 ON b2.id = bs2.book_id
      JOIN book_authors ba2 ON ba2.book_id = b2.id
      JOIN authors a2 ON a2.id = ba2.author_id
      WHERE bs2.series_id = s.id AND ${aClauses.join(' AND ')}
    )`;
    for (const t of authorTokens) authorWhereParams.push(`% ${t}%`);

    authorRankSQL = `(SELECT MIN(CASE WHEN COALESCE(a2.sort_name, '') = ? THEN 1 WHEN COALESCE(a2.sort_name, '') = ? THEN 1 ELSE 5 END) FROM book_series bs2 JOIN active_books b2 ON b2.id = bs2.book_id JOIN book_authors ba2 ON ba2.book_id = b2.id JOIN authors a2 ON a2.id = ba2.author_id WHERE bs2.series_id = s.id)`;
    authorRankParams.push(needleKey, [...authorTokens].reverse().join(' '));
  }

  const mainWhereParts = [];
  const mainWhereParams = [];
  if (nameSearch) {
    mainWhereParts.push(nameSearch.where);
    mainWhereParams.push(...nameSearch.params);
  }
  mainWhereParts.push(authorWhere);
  mainWhereParams.push(...authorWhereParams);
  const combinedWhere = mainWhereParts.map(p => `(${p})`).join(' OR ');

  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM series_catalog s
    WHERE (${combinedWhere}) AND s.book_count > 0
  `).get(...mainWhereParams).count;

  const nameRankParts = [];
  const nameRankParams = [];
  if (nameSearch) {
    nameRankParts.push(`WHEN COALESCE(s.sort_name, '') = ? THEN 0`);
    nameRankParams.push(needleKey);
    nameRankParts.push(`WHEN COALESCE(s.sort_name, '') LIKE ? THEN 3`);
    nameRankParams.push(`${needleKey}%`);
  }

  let rankSQL;
  const allRankParams = [];
  if (nameRankParts.length) {
    rankSQL = `CASE ${nameRankParts.join(' ')} ELSE COALESCE(${authorRankSQL}, 20) END`;
    allRankParams.push(...nameRankParams, ...authorRankParams);
  } else {
    rankSQL = authorRankSQL;
    allRankParams.push(...authorRankParams);
  }

  const orderBy = sort === 'name'
    ? `${rankSQL} ASC, COALESCE(s.sort_name, LOWER(s.name)) ASC`
    : `${rankSQL} ASC, s.book_count DESC, COALESCE(s.sort_name, LOWER(s.name)) ASC`;

  const items = db.prepare(`
    SELECT s.name AS name,
           COALESCE(s.display_name, s.name) AS displayName,
           COALESCE(s.sort_name, LOWER(s.name)) AS sortKey,
           s.book_count AS bookCount
    FROM series_catalog s
    WHERE (${combinedWhere}) AND s.book_count > 0
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...mainWhereParams, ...allRankParams, pageSize, offset);

  return { total, items };
}

export function listGenresGrouped() {
  const all = db.prepare(`
    SELECT g.name, COALESCE(g.display_name, g.name) AS displayName,
           g.book_count AS bookCount
    FROM genres_catalog g
    WHERE g.book_count > 0
    ORDER BY g.book_count DESC
  `).all();
  return all;
}

export function listGenres({ page = 1, pageSize = 50, query = '', sort = 'count', letter = '' }) {
  const offset = (page - 1) * pageSize;
  const searchSql = buildCatalogSearchSql('g.search_name', query);
  const letterNorm = String(letter || '').trim().toLowerCase();
  const orderBy = sort === 'name'
    ? 'COALESCE(g.sort_name, LOWER(g.name)) ASC'
    : 'g.book_count DESC, COALESCE(g.sort_name, LOWER(g.name)) ASC';

  const whereParts = ['g.book_count > 0'];
  const whereParams = [];
  if (searchSql) { whereParts.push(searchSql.where); whereParams.push(...searchSql.params); }
  if (letterNorm) { whereParts.push('COALESCE(g.sort_name, LOWER(g.name)) LIKE ?'); whereParams.push(`${letterNorm}%`); }
  const fullWhereClause = `WHERE ${whereParts.join(' AND ')}`;

  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM genres_catalog g
    ${fullWhereClause}
  `).get(...whereParams).count;

  const items = db.prepare(`
    SELECT g.name AS name,
           COALESCE(g.display_name, g.name) AS displayName,
           COALESCE(g.sort_name, LOWER(g.name)) AS sortKey,
           g.book_count AS bookCount
    FROM genres_catalog g
    ${fullWhereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...whereParams, pageSize, offset);

  return { total, items };
}

export function listLanguages({ page = 1, pageSize = 50, query = '', sort = 'count' }) {
  const offset = (page - 1) * pageSize;
  const normalizedQuery = normalizeText(query).toLowerCase();
  const pattern = normalizedQuery ? `%${normalizedQuery}%` : null;
  const whereClause = pattern
    ? `HAVING LOWER(name) LIKE ? OR LOWER(displayName) LIKE ?`
    : '';
  const orderBy = sort === 'name'
    ? 'displayName ASC'
    : 'bookCount DESC, displayName ASC';

  const groupedSql = `
    SELECT CASE WHEN NULLIF(lang, '') IS NULL THEN 'unknown' ELSE lang END AS name,
           COUNT(*) AS bookCount,
           CASE WHEN NULLIF(lang, '') IS NULL THEN 'Не указан' ELSE UPPER(lang) END AS displayName
    FROM active_books
    GROUP BY CASE WHEN NULLIF(lang, '') IS NULL THEN 'unknown' ELSE lang END
    ${whereClause}
  `;

  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM (${groupedSql}) grouped_languages
  `).get(...(pattern ? [pattern, pattern] : [])).count;

  const items = db.prepare(`
    ${groupedSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...(pattern ? [pattern, pattern] : []), pageSize, offset);

  return { total, items };
}

/* ── Pre-cached prepared statements for getBooksByFacet (finite set: 4 facets × 4 sorts) ── */
const _facetStmtCache = new Map();

function _getFacetStmts(facet, sort) {
  const key = `${facet}|${sort}`;
  let entry = _facetStmtCache.get(key);
  if (entry) return entry;

  const rankOrder = "COALESCE(s.flibusta_sidecar, 0) DESC, COALESCE(NULLIF(b.date, ''), b.imported_at) DESC, b.imported_at DESC, b.id DESC";
  const totalSql = {
    authors: `SELECT COUNT(DISTINCT b.id) AS count FROM book_authors ba JOIN authors a ON a.id = ba.author_id JOIN active_books b ON b.id = ba.book_id WHERE a.name = ?`,
    series: `SELECT COUNT(DISTINCT b.id) AS count FROM book_series bs JOIN series_catalog s ON s.id = bs.series_id JOIN active_books b ON b.id = bs.book_id WHERE s.name = ?`,
    genres: `SELECT COUNT(DISTINCT b.id) AS count FROM book_genres bg JOIN genres_catalog g ON g.id = bg.genre_id JOIN active_books b ON b.id = bg.book_id WHERE g.name = ?`,
    languages: `SELECT COUNT(*) AS count FROM active_books b WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?`
  };
  const itemsSql = {
    authors: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName FROM book_authors ba JOIN authors a ON a.id = ba.author_id JOIN active_books b ON b.id = ba.book_id LEFT JOIN sources s ON s.id = b.source_id WHERE a.name = ? ORDER BY ${sort === 'recent' ? rankOrder : resolveBookAliasSort(sort, 'b')} LIMIT ? OFFSET ?`,
    series: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName FROM book_series bs JOIN series_catalog sc ON sc.id = bs.series_id JOIN active_books b ON b.id = bs.book_id LEFT JOIN sources s ON s.id = b.source_id WHERE sc.name = ? ORDER BY ${sort === 'recent' ? 'b.series_index ASC, b.title_sort ASC, b.id DESC' : resolveBookAliasSort(sort, 'b')} LIMIT ? OFFSET ?`,
    genres: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName FROM book_genres bg JOIN genres_catalog g ON g.id = bg.genre_id JOIN active_books b ON b.id = bg.book_id LEFT JOIN sources s ON s.id = b.source_id WHERE g.name = ? ORDER BY ${sort === 'recent' ? rankOrder : resolveBookAliasSort(sort, 'b')} LIMIT ? OFFSET ?`,
    languages: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName FROM active_books b LEFT JOIN sources s ON s.id = b.source_id WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ? ORDER BY ${sort === 'recent' ? rankOrder : resolveBookAliasSort(sort, 'b')} LIMIT ? OFFSET ?`
  };
  entry = {
    total: db.prepare(totalSql[facet]),
    items: db.prepare(itemsSql[facet])
  };
  _facetStmtCache.set(key, entry);
  return entry;
}

export function getBooksByFacet({ facet, value, page = 1, pageSize = 24, sort = 'recent' }) {
  if (facet === 'series') {
    value = resolveSeriesCatalogName(String(value || ''));
  }
  const cacheKey = `${facet}|${value}|${sort}|${page}|${pageSize}`;
  const cached = readTimedCache(facetBooksCache, cacheKey);
  if (cached) return cached;
  const offset = (page - 1) * pageSize;

  const stmts = _getFacetStmts(facet, sort);
  if (!stmts.total) return { total: 0, items: [] };

  const totalKey = `${facet}|${value}`;
  let total = readTimedCache(facetDedupTotalCache, totalKey);
  if (total == null || !Number.isFinite(Number(total))) {
    total = stmts.total.get(value).count;
    writeTimedCache(facetDedupTotalCache, totalKey, total, FACET_DEDUP_TOTAL_TTL_MS, 400);
  }

  const items = stmts.items.all(value, pageSize, offset).map(mapBookListRow);
  const result = { total, items };
  writeTimedCache(facetBooksCache, cacheKey, result, FACET_CACHE_TTL_MS, 120);
  return result;
}

/**
 * Параллельные HTTP-запросы к одной странице фасета (двойной клик, префетч) — один тяжёлый запрос к SQLite.
 */
export async function getBooksByFacetCoalesced({ facet, value, page = 1, pageSize = 24, sort = 'recent' }) {
  let v = value;
  if (facet === 'series') {
    v = resolveSeriesCatalogName(String(value || ''));
  }
  const cacheKey = `${facet}|${v}|${sort}|${page}|${pageSize}`;
  const cached = readTimedCache(facetBooksCache, cacheKey);
  if (cached) return cached;
  let shared = facetBooksInflight.get(cacheKey);
  if (!shared) {
    shared = new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(getBooksByFacet({ facet, value: v, page, pageSize, sort }));
        } catch (err) {
          reject(err);
        } finally {
          facetBooksInflight.delete(cacheKey);
        }
      });
    });
    facetBooksInflight.set(cacheKey, shared);
  }
  const result = await shared;
  const again = readTimedCache(facetBooksCache, cacheKey);
  return again || result;
}

function mapAuthorPageBookRow(row) {
  const bookRow = {
    id: row.id,
    title: row.title,
    authors: row.authors,
    genres: row.genres,
    series: row.series,
    seriesNo: row.seriesNo,
    ext: row.ext,
    lang: row.lang,
    archiveName: row.archiveName
  };
  const book = mapBookListRow(bookRow);
  book._sortDate = row.sortDate || row.importedAt || '';
  book._seriesIndex = row.seriesIndex != null && row.seriesIndex !== '' ? row.seriesIndex : '';
  return book;
}

function applyAuthorPageBookSort(books, sort) {
  const arr = [...books];
  if (sort === 'title') {
    arr.sort((a, b) =>
      String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base', numeric: true })
    );
  } else if (sort === 'series') {
    arr.sort((a, b) => {
      const sa = String(a.series || '');
      const sb = String(b.series || '');
      if (sa !== sb) return sa.localeCompare(sb);
      const na = parseFloat(String(a.seriesNo || '').replace(/[^\d.]/g, '')) || 0;
      const nb = parseFloat(String(b.seriesNo || '').replace(/[^\d.]/g, '')) || 0;
      return (
        na - nb || String(a.title).localeCompare(String(b.title), undefined, { numeric: true })
      );
    });
  } else if (sort === 'author') {
    arr.sort((a, b) =>
      String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base', numeric: true })
    );
  } else {
    arr.sort((a, b) => {
      const da = Date.parse(String(a._sortDate || '')) || 0;
      const db = Date.parse(String(b._sortDate || '')) || 0;
      return db - da || Number(b.id) - Number(a.id);
    });
  }
  return arr;
}

function stripAuthorPageBookMeta(book) {
  const { _sortDate, _seriesIndex, ...rest } = book;
  return rest;
}

function buildAuthorSeriesGroupEntry(name, displayNameFromOrder, g, sort) {
  if (!g?.books?.length) return null;
  const sorted = applyAuthorPageBookSort(g.books, sort);
  const latestMs = Math.max(0, ...sorted.map((b) => Date.parse(String(b._sortDate || '')) || 0));
  const books = sorted.map(stripAuthorPageBookMeta);
  const displayName = displayNameFromOrder || g.displayName;
  return { name, displayName, books, _latestMs: latestMs };
}

function orderAuthorSeriesGroups(series, sort) {
  if (sort === 'title' || sort === 'author') {
    return [...series].sort((a, b) =>
      String(a.displayName || a.name).localeCompare(String(b.displayName || b.name), undefined, {
        sensitivity: 'base',
        numeric: true
      })
    );
  }
  if (sort === 'recent') {
    return [...series].sort(
      (a, b) =>
        b._latestMs - a._latestMs ||
        String(a.displayName || a.name).localeCompare(String(b.displayName || b.name), undefined, {
          numeric: true
        })
    );
  }
  return series;
}

/** Книги автора: серии (по порядку каталога) и книги вне серий. */
export function getAuthorBooksGrouped(authorName, sort = 'recent', { page = 1, pageSize = 48 } = {}) {
  void page;
  void pageSize;
  const cacheKey = `${authorName}|${sort}`;
  const cached = readTimedCache(authorGroupedCache, cacheKey);
  if (cached) return cached;
  const authorBooksFrom = `
      FROM book_authors ba
      JOIN authors a ON a.id = ba.author_id
      JOIN active_books b ON b.id = ba.book_id
      LEFT JOIN book_series bs ON bs.book_id = b.id
      LEFT JOIN series_catalog s ON s.id = bs.series_id
      LEFT JOIN sources src ON src.id = b.source_id
      WHERE a.name = ?
  `;

  const totalBooks =
    db
      .prepare(
        `
    SELECT COUNT(DISTINCT b.id) AS c
    ${authorBooksFrom}
  `
      )
      .get(authorName)?.c ?? 0;

  const fetchLimit = Math.min(AUTHOR_GROUPED_FETCH_CAP, Math.max(totalBooks, 1));

  const rows = db.prepare(`
    SELECT
      b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName,
      s.name AS seriesCatalogName,
      COALESCE(s.display_name, s.name) AS seriesDisplayName,
      b.series_index AS seriesIndex,
      b.imported_at AS importedAt,
      COALESCE(NULLIF(b.date, ''), b.imported_at) AS sortDate,
      b.series_sort AS seriesSort,
      COALESCE(s.sort_name, s.name, '') AS seriesNameSort,
      b.title_sort AS titleSort
    ${authorBooksFrom}
    ORDER BY
      CASE WHEN s.name IS NULL THEN 1 ELSE 0 END ASC,
      b.series_sort ASC,
      COALESCE(s.sort_name, s.name, '') ASC,
      b.series_index ASC,
      b.title_sort ASC,
      b.id DESC
    LIMIT ?
  `).all(authorName, fetchLimit);

  const seriesOrder = db.prepare(`
    SELECT s.name AS name, COALESCE(s.display_name, s.name) AS displayName, MIN(b.series_sort) AS seriesSortMin
    FROM book_authors ba
    JOIN authors a ON a.id = ba.author_id
    JOIN active_books b ON b.id = ba.book_id
    JOIN book_series bs ON bs.book_id = b.id
    JOIN series_catalog s ON s.id = bs.series_id
    WHERE a.name = ?
    GROUP BY s.id, s.name, s.display_name, s.sort_name
    ORDER BY seriesSortMin ASC, COALESCE(s.sort_name, s.name) ASC
    LIMIT 50
  `).all(authorName);

  const bySeries = new Map();
  const standalone = [];
  const seenStandalone = new Set();

  for (const row of rows) {
    const key = row.seriesCatalogName;
    if (!key) {
      const book = mapAuthorPageBookRow(row);
      if (!seenStandalone.has(book.id)) {
        seenStandalone.add(book.id);
        standalone.push(book);
      }
    } else {
      if (!bySeries.has(key)) {
        bySeries.set(key, { displayName: row.seriesDisplayName || key, books: [], seen: new Set() });
      }
      const g = bySeries.get(key);
      const book = mapAuthorPageBookRow(row);
      if (!g.seen.has(book.id)) {
        g.seen.add(book.id);
        g.books.push(book);
      }
    }
  }

  let series = seriesOrder
    .map(({ name, displayName }) => buildAuthorSeriesGroupEntry(name, displayName, bySeries.get(name), sort))
    .filter(Boolean);

  const orderedNames = new Set(series.map((s) => s.name));
  const extraNames = [...bySeries.keys()].filter((n) => !orderedNames.has(n)).sort();
  for (const name of extraNames) {
    const entry = buildAuthorSeriesGroupEntry(name, null, bySeries.get(name), sort);
    if (entry) series.push(entry);
  }

  series = orderAuthorSeriesGroups(series, sort);
  const seriesSummaries = series.map(({ name, displayName, books, _latestMs: _m }) => ({
    name,
    displayName,
    bookCount: books.length }));

  const standaloneBooks = applyAuthorPageBookSort(standalone, sort).map(stripAuthorPageBookMeta);
  const result = { series: seriesSummaries, standaloneBooks, total: totalBooks };
  writeTimedCache(authorGroupedCache, cacheKey, result, AUTHOR_GROUPED_CACHE_TTL_MS, 20);
  return result;
}

/**
 * То же, что getAuthorBooksGrouped, но параллельные запросы с тем же ключом ждут один расчёт.
 */
export async function getAuthorBooksGroupedCoalesced(authorName, sort = 'recent', { page = 1, pageSize = 48 } = {}) {
  void page;
  void pageSize;
  const cacheKey = `${authorName}|${sort}`;
  const cached = readTimedCache(authorGroupedCache, cacheKey);
  if (cached) return cached;
  let shared = authorGroupedInflight.get(cacheKey);
  if (!shared) {
    shared = new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(getAuthorBooksGrouped(authorName, sort, { page, pageSize }));
        } catch (err) {
          reject(err);
        } finally {
          authorGroupedInflight.delete(cacheKey);
        }
      });
    });
    authorGroupedInflight.set(cacheKey, shared);
  }
  const result = await shared;
  const again = readTimedCache(authorGroupedCache, cacheKey);
  return again || result;
}

export function getAuthorFlibustaSourceId(authorName) {
  const row = db.prepare(`
    SELECT b.source_id AS sourceId
    FROM book_authors ba
    JOIN authors a ON a.id = ba.author_id
    JOIN active_books b ON b.id = ba.book_id
    JOIN sources s ON s.id = b.source_id
    WHERE a.name = ?
    ORDER BY COALESCE(s.flibusta_sidecar, 0) DESC, b.id
    LIMIT 1
  `).get(authorName);
  return row?.sourceId != null ? row.sourceId : null;
}

export function getAllBookIdsByFacet(facet, value) {
  if (facet === 'series') {
    value = resolveSeriesCatalogName(String(value || ''));
  }
  const queries = {
    authors: `
      SELECT b.id FROM book_authors ba
      JOIN authors a ON a.id = ba.author_id
      JOIN active_books b ON b.id = ba.book_id
      WHERE a.name = ?
      ORDER BY b.series_sort ASC, b.series_index ASC, b.title_sort ASC
      LIMIT ${BATCH_DOWNLOAD_MAX}`,
    series: `
      SELECT b.id FROM book_series bs
      JOIN series_catalog s ON s.id = bs.series_id
      JOIN active_books b ON b.id = bs.book_id
      WHERE s.name = ?
      ORDER BY b.series_index ASC, b.title_sort ASC
      LIMIT ${BATCH_DOWNLOAD_MAX}`
  };
  const query = queries[facet];
  if (!query) return [];
  return db.prepare(query).all(value).map((row) => row.id);
}

export function getFacetSummary(facet, value) {
  let v = String(value || '');
  if (facet === 'series') {
    v = resolveSeriesCatalogName(String(value || ''));
  }
  const summaryKey = `${facet}|${v}`;
  const summaryHit = readTimedCache(facetSummaryCache, summaryKey);
  if (summaryHit) return summaryHit;

  if (facet === 'authors') {
    const series = db.prepare(`
      SELECT s.name AS name, COALESCE(s.display_name, s.name) AS displayName, COUNT(*) AS bookCount
      FROM book_authors ba
      JOIN authors a ON a.id = ba.author_id
      JOIN active_books b ON b.id = ba.book_id
      JOIN book_series bs ON bs.book_id = b.id
      JOIN series_catalog s ON s.id = bs.series_id
      WHERE a.name = ?
      GROUP BY s.id, s.name
      ORDER BY bookCount DESC, MIN(b.series_sort) ASC, COALESCE(s.sort_name, s.name) ASC
      LIMIT 8
    `).all(v);

    const genres = db.prepare(`
      SELECT g.name AS name, COALESCE(g.display_name, g.name) AS displayName, COUNT(*) AS bookCount
      FROM book_authors ba
      JOIN authors a ON a.id = ba.author_id
      JOIN active_books b ON b.id = ba.book_id
      JOIN book_genres bg ON bg.book_id = b.id
      JOIN genres_catalog g ON g.id = bg.genre_id
      WHERE a.name = ?
      GROUP BY g.id, g.name, g.display_name
      ORDER BY bookCount DESC, COALESCE(g.sort_name, g.name) ASC
      LIMIT 8
    `).all(v);

    const authorSummary = {
      relatedTitle: t('facet.summaryAuthorSeries'),
      relatedPath: '/facet/series',
      relatedItems: series,
      secondaryTitle: t('facet.summaryAuthorGenres'),
      secondaryPath: '/facet/genres',
      secondaryItems: genres
    };
    writeTimedCache(facetSummaryCache, summaryKey, authorSummary, FACET_CACHE_TTL_MS, 150);
    return authorSummary;
  }

  if (facet === 'series') {
    const authors = db.prepare(`
      SELECT a.name AS name, COALESCE(a.display_name, a.name) AS displayName, COUNT(*) AS bookCount
      FROM book_series bs
      JOIN series_catalog s ON s.id = bs.series_id
      JOIN active_books b ON b.id = bs.book_id
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id
      WHERE s.name = ?
      GROUP BY a.id, a.name
      ORDER BY bookCount DESC, MIN(b.author_sort) ASC, COALESCE(a.sort_name, a.name) ASC
      LIMIT 8
    `).all(v);

    const genres = db.prepare(`
      SELECT g.name AS name, COALESCE(g.display_name, g.name) AS displayName, COUNT(*) AS bookCount
      FROM book_series bs
      JOIN series_catalog s ON s.id = bs.series_id
      JOIN active_books b ON b.id = bs.book_id
      JOIN book_genres bg ON bg.book_id = b.id
      JOIN genres_catalog g ON g.id = bg.genre_id
      WHERE s.name = ?
      GROUP BY g.id, g.name, g.display_name
      ORDER BY bookCount DESC, COALESCE(g.sort_name, g.name) ASC
      LIMIT 8
    `).all(v);

    const seriesSummary = {
      relatedTitle: t('facet.summarySeriesAuthors'),
      relatedPath: '/facet/authors',
      relatedItems: authors,
      secondaryTitle: t('facet.summarySeriesGenres'),
      secondaryPath: '/facet/genres',
      secondaryItems: genres
    };
    writeTimedCache(facetSummaryCache, summaryKey, seriesSummary, FACET_CACHE_TTL_MS, 150);
    return seriesSummary;
  }

  if (facet === 'genres') {
    const authors = db.prepare(`
      SELECT a.name AS name, COALESCE(a.display_name, a.name) AS displayName, COUNT(*) AS bookCount
      FROM book_genres bg
      JOIN genres_catalog g ON g.id = bg.genre_id
      JOIN active_books b ON b.id = bg.book_id
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id
      WHERE g.name = ?
      GROUP BY a.id, a.name
      ORDER BY bookCount DESC, MIN(b.author_sort) ASC, COALESCE(a.sort_name, a.name) ASC
      LIMIT 8
    `).all(v);

    const series = db.prepare(`
      SELECT s.name AS name, COALESCE(s.display_name, s.name) AS displayName, COUNT(*) AS bookCount
      FROM book_genres bg
      JOIN genres_catalog g ON g.id = bg.genre_id
      JOIN active_books b ON b.id = bg.book_id
      JOIN book_series bs ON bs.book_id = b.id
      JOIN series_catalog s ON s.id = bs.series_id
      WHERE g.name = ?
      GROUP BY s.id, s.name
      ORDER BY bookCount DESC, MIN(b.series_sort) ASC, COALESCE(s.sort_name, s.name) ASC
      LIMIT 8
    `).all(v);

    const genreSummary = {
      relatedTitle: t('facet.summaryGenreAuthors'),
      relatedPath: '/facet/authors',
      relatedItems: authors,
      secondaryTitle: t('facet.summaryGenreSeries'),
      secondaryPath: '/facet/series',
      secondaryItems: series
    };
    writeTimedCache(facetSummaryCache, summaryKey, genreSummary, FACET_CACHE_TTL_MS, 150);
    return genreSummary;
  }

  if (facet === 'languages') {
    const genres = db.prepare(`
      SELECT g.name AS name, COALESCE(g.display_name, g.name) AS displayName, COUNT(*) AS bookCount
      FROM active_books b
      JOIN book_genres bg ON bg.book_id = b.id
      JOIN genres_catalog g ON g.id = bg.genre_id
      WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?
      GROUP BY g.id, g.name, g.display_name
      ORDER BY bookCount DESC, g.sort_name ASC
      LIMIT 8
    `).all(v);

    const authors = db.prepare(`
      SELECT a.name AS name, a.display_name AS displayName, COUNT(*) AS bookCount
      FROM active_books b
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id
      WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?
      GROUP BY a.id, a.name
      ORDER BY bookCount DESC, MIN(b.author_sort) ASC, COALESCE(a.sort_name, a.name) ASC
      LIMIT 8
    `).all(v);

    const langSummary = {
      relatedTitle: t('facet.summaryLangGenres'),
      relatedPath: '/facet/genres',
      relatedItems: genres,
      secondaryTitle: t('facet.summaryLangAuthors'),
      secondaryPath: '/facet/authors',
      secondaryItems: authors
    };
    writeTimedCache(facetSummaryCache, summaryKey, langSummary, FACET_CACHE_TTL_MS, 150);
    return langSummary;
  }

  const emptySummary = {
    relatedTitle: '',
    relatedPath: '',
    relatedItems: [],
    secondaryTitle: '',
    secondaryPath: '',
    secondaryItems: []
  };
  writeTimedCache(facetSummaryCache, summaryKey, emptySummary, FACET_CACHE_TTL_MS, 150);
  return emptySummary;
}

export function getLibrarySections() {
  const POOL_SIZE = 200;
  const DISPLAY_COUNT = 12;
  const pool = db.prepare(`
    SELECT id, title, authors, genres, series, series_no AS seriesNo, ext, lang, archive_name AS archiveName
    FROM active_books
    ORDER BY COALESCE(NULLIF(date, ''), imported_at) DESC, imported_at DESC, id DESC
    LIMIT ?
  `).all(POOL_SIZE).map(mapBookListRow);

  // Shuffle and pick DISPLAY_COUNT random items from the pool
  let newest;
  if (pool.length <= DISPLAY_COUNT) {
    newest = pool;
  } else {
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    newest = pool.slice(0, DISPLAY_COUNT);
  }

  // Для главной страницы сейчас нужен только блок «Новые поступления».
  // Не считаем тяжёлые агрегаты (authors/series/genres/languages) на первом cold-load.
  return {
    newest,
    titles: [],
    authors: [],
    series: [],
    genres: [],
    languages: []
  };
}

export function getLibraryView(view = 'recent', { page = 1, pageSize = 24, username = '' } = {}) {
  const offset = (page - 1) * pageSize;

  if (view === 'continue') {
    const normalizedUsername = String(username || '').trim();
    if (!normalizedUsername) {
      return { total: 0, items: [] };
    }

    const total = db.prepare(`
      SELECT COUNT(DISTINCT rh.book_id) AS count
      FROM reading_history rh
      JOIN active_books b ON b.id = rh.book_id
      WHERE rh.username = ?
    `).get(normalizedUsername).count;

    const items = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName,
             COALESCE(rp.progress, 0) AS readProgress
      FROM (
        SELECT rh.book_id, MAX(rh.last_opened_at) AS last_opened_at, SUM(COALESCE(rh.open_count, 0)) AS open_count
        FROM reading_history rh
        WHERE rh.username = ?
        GROUP BY rh.book_id
      ) rh
      JOIN active_books b ON b.id = rh.book_id
      LEFT JOIN reading_positions rp ON rp.book_id = b.id AND rp.username = ?
      ORDER BY rh.last_opened_at DESC, rh.open_count DESC, b.id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedUsername, normalizedUsername, pageSize, offset).map(mapBookListRow);

    return { total, items };
  }

  if (view === 'read') {
    const normalizedUsername = String(username || '').trim();
    if (!normalizedUsername) {
      return { total: 0, items: [] };
    }

    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM read_books rb
      JOIN active_books b ON b.id = rb.book_id
      WHERE rb.username = ?
    `).get(normalizedUsername).count;

    const items = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName
      FROM read_books rb
      JOIN active_books b ON b.id = rb.book_id
      WHERE rb.username = ?
      ORDER BY rb.created_at DESC
      LIMIT ? OFFSET ?
    `).all(normalizedUsername, pageSize, offset).map(mapBookListRow);

    return { total, items };
  }

  const sort = 'recent';
  return searchBooks({ query: '', page, pageSize, field: 'all', sort });
}

export function opdsQuery(facet, prefix = '', depth = 0, genre = '') {
  const tableMap = {
    authors: { table: 'authors', join: 'book_authors', joinCol: 'author_id', nameCol: 'name', displayCol: 'display_name' },
    series: { table: 'series_catalog', join: 'book_series', joinCol: 'series_id', nameCol: 'name', displayCol: 'display_name' },
    title: null
  };

  if (facet === 'title') {
    return opdsTitleQuery(prefix, depth, genre);
  }

  const conf = tableMap[facet];
  if (!conf) return [];

  const effectiveDepth = depth || (prefix.length + 1);

  let sql, params;
  if (genre) {
    sql = `SELECT LOWER(SUBSTR(c.${conf.nameCol}, 1, ?)) AS prefix_val, COUNT(DISTINCT c.id) AS cnt
           FROM ${conf.table} c
           JOIN ${conf.join} j ON j.${conf.joinCol} = c.id
           JOIN active_books b ON b.id = j.book_id
           JOIN book_genres bg ON bg.book_id = b.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           WHERE LOWER(SUBSTR(c.${conf.nameCol}, 1, ?)) >= ?
           GROUP BY prefix_val
           ORDER BY prefix_val`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = [effectiveDepth, ...genreParams, effectiveDepth, prefix.toLowerCase()];
  } else {
    sql = `SELECT LOWER(SUBSTR(c.${conf.nameCol}, 1, ?)) AS prefix_val, COUNT(DISTINCT c.id) AS cnt
           FROM ${conf.table} c
           JOIN ${conf.join} j ON j.${conf.joinCol} = c.id
           JOIN active_books b ON b.id = j.book_id
           WHERE LOWER(SUBSTR(c.${conf.nameCol}, 1, ?)) >= ?
           GROUP BY prefix_val
           ORDER BY prefix_val`;
    params = [effectiveDepth, effectiveDepth, prefix.toLowerCase()];
  }

  const rows = db.prepare(sql).all(...params);
  let totalCount = 0;
  for (const r of rows) totalCount += r.cnt;

  if (totalCount <= 50) {
    return opdsSearchFacet(facet, prefix, genre);
  }

  return rows.map(r => ({
    id: r.prefix_val,
    title: r.prefix_val.toUpperCase().replace(/ /g, '·') + '~',
    prefix: r.prefix_val,
    count: r.cnt,
    isNav: true
  }));
}

function opdsTitleQuery(prefix = '', depth = 0, genre = '') {
  const effectiveDepth = depth || (prefix.length + 1);

  let sql, params;
  if (genre) {
    sql = `SELECT LOWER(SUBSTR(b.title, 1, ?)) AS prefix_val, COUNT(*) AS cnt
           FROM active_books b
           JOIN book_genres bg ON bg.book_id = b.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           WHERE LOWER(SUBSTR(b.title, 1, ?)) >= ?
           GROUP BY prefix_val ORDER BY prefix_val`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = [effectiveDepth, ...genreParams, effectiveDepth, prefix.toLowerCase()];
  } else {
    sql = `SELECT LOWER(SUBSTR(b.title, 1, ?)) AS prefix_val, COUNT(*) AS cnt
           FROM active_books b
           WHERE LOWER(SUBSTR(b.title, 1, ?)) >= ?
           GROUP BY prefix_val ORDER BY prefix_val`;
    params = [effectiveDepth, effectiveDepth, prefix.toLowerCase()];
  }

  const rows = db.prepare(sql).all(...params);
  let totalCount = 0;
  for (const r of rows) totalCount += r.cnt;

  if (totalCount <= 50) {
    return opdsTitleSearch(prefix, genre);
  }

  return rows.map(r => ({
    id: r.prefix_val,
    title: r.prefix_val.toUpperCase().replace(/ /g, '·') + '~',
    prefix: r.prefix_val,
    count: r.cnt,
    isNav: true
  }));
}

function opdsSearchFacet(facet, prefix, genre = '') {
  const conf = {
    authors: { table: 'authors', join: 'book_authors', joinCol: 'author_id' },
    series: { table: 'series_catalog', join: 'book_series', joinCol: 'series_id' }
  }[facet];
  if (!conf) return [];

  let sql, params;
  if (genre) {
    sql = `SELECT c.name AS name, COALESCE(c.display_name, c.name) AS displayName,
             COUNT(DISTINCT j.book_id) AS bookCount
           FROM ${conf.table} c
           JOIN ${conf.join} j ON j.${conf.joinCol} = c.id
           JOIN active_books ab ON ab.id = j.book_id
           JOIN book_genres bg ON bg.book_id = ab.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           WHERE LOWER(c.name) >= ? AND LOWER(c.name) < ?
           GROUP BY c.id ORDER BY c.name LIMIT 200`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = [...genreParams, prefix.toLowerCase(), prefix.toLowerCase() + '\uffff'];
  } else {
    sql = `SELECT c.name AS name, COALESCE(c.display_name, c.name) AS displayName,
             (SELECT COUNT(*) FROM ${conf.join} j JOIN active_books ab ON ab.id = j.book_id WHERE j.${conf.joinCol} = c.id) AS bookCount
           FROM ${conf.table} c
           WHERE LOWER(c.name) >= ? AND LOWER(c.name) < ?
           ORDER BY c.name LIMIT 200`;
    params = [prefix.toLowerCase(), prefix.toLowerCase() + '\uffff'];
  }

  return db.prepare(sql).all(...params).filter(r => r.bookCount > 0).map(r => ({
    id: r.name,
    title: r.displayName || r.name,
    name: r.name,
    bookCount: r.bookCount,
    isNav: false
  }));
}

function opdsTitleSearch(prefix, genre = '') {
  let sql, params;
  if (genre) {
    sql = `SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang
           FROM active_books b
           JOIN book_genres bg ON bg.book_id = b.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           WHERE LOWER(b.title) >= ? AND LOWER(b.title) < ?
           ORDER BY b.title LIMIT 200`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = [...genreParams, prefix.toLowerCase(), prefix.toLowerCase() + '\uffff'];
  } else {
    sql = `SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang
           FROM active_books b
           WHERE LOWER(b.title) >= ? AND LOWER(b.title) < ?
           ORDER BY b.title LIMIT 200`;
    params = [prefix.toLowerCase(), prefix.toLowerCase() + '\uffff'];
  }

  return db.prepare(sql).all(...params).map(r => ({
    id: r.id,
    title: `${r.seriesNo ? `${r.seriesNo}. ` : ''}${r.title || t('opds.noTitle')} (${r.ext || 'fb2'})`,
    authors: r.authors,
    bookId: r.id,
    ext: r.ext,
    isBook: true
  }));
}

export function opdsSearchAuthors(term, { page = 1, pageSize = 100 } = {}) {
  if (!term || !term.trim()) return { total: 0, items: [] };
  const words = createSortKey(term.trim()).split(/\s+/).filter(Boolean);
  if (!words.length) return { total: 0, items: [] };
  const offset = (page - 1) * pageSize;

  const whereClauses = words.map(() => `(' ' || a.sort_name || ' ') LIKE ?`);
  const whereSQL = whereClauses.join(' AND ');
  const whereParams = words.map(w => `% ${w}%`);

  const surnameExpr = `SUBSTR(a.sort_name, 1, INSTR(a.sort_name || ' ', ' ') - 1)`;
  const fullKey = words.join(' ');
  const rankCases = [];
  const rankParams = [];

  rankCases.push(`WHEN COALESCE(a.sort_name, '') = ? THEN 0`);
  rankParams.push(fullKey);

  if (words.length > 1) {
    const reversedKey = [...words].reverse().join(' ');
    rankCases.push(`WHEN COALESCE(a.sort_name, '') = ? THEN 0`);
    rankParams.push(reversedKey);
  }

  for (const w of words) {
    rankCases.push(`WHEN ${surnameExpr} = ? THEN 1`);
    rankParams.push(w);
  }

  const rankSQL = `CASE ${rankCases.join(' ')} ELSE 2 END`;

  const items = db.prepare(`
    SELECT a.name AS name,
           COALESCE(a.display_name, a.name) AS displayName,
           COUNT(ab.id) AS bookCount,
           ${rankSQL} AS rank
    FROM authors a
    JOIN book_authors ba ON ba.author_id = a.id
    JOIN active_books ab ON ab.id = ba.book_id
    WHERE ${whereSQL}
    GROUP BY a.id, a.name, a.display_name
    ORDER BY rank ASC, bookCount DESC, a.name ASC
    LIMIT ? OFFSET ?
  `).all(...rankParams, ...whereParams, pageSize, offset);

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM authors a
    WHERE ${whereSQL}
      AND EXISTS (SELECT 1 FROM book_authors ba2 JOIN active_books ab2 ON ab2.id = ba2.book_id WHERE ba2.author_id = a.id)
  `).get(...whereParams);

  return { total: totalRow.cnt, items };
}

export function getAuthorBooksOpds(authorName, genre = '') {
  const rankOrder =
    'b.series, CAST(b.series_no AS INTEGER), b.title';
  let sql;
  let params;
  if (genre) {
    const genreParams = genre.split(',').map((g) => g.trim());
    sql = `
      SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.genres,
             b.archive_name AS archiveName, b.file_name AS fileName, b.source_id AS sourceId,
             dc.annotation
      FROM active_books b
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id AND a.name = ?
      JOIN book_genres bg ON bg.book_id = b.id
      JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genreParams.map(() => '?').join(',')})
      LEFT JOIN sources s ON s.id = b.source_id
      LEFT JOIN book_details_cache dc ON dc.book_id = b.id
      GROUP BY b.id
      ORDER BY ${rankOrder}
      LIMIT 500`;
    params = [authorName, ...genreParams];
  } else {
    sql = `
      SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.genres,
             b.archive_name AS archiveName, b.file_name AS fileName, b.source_id AS sourceId,
             dc.annotation
      FROM active_books b
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id AND a.name = ?
      LEFT JOIN sources s ON s.id = b.source_id
      LEFT JOIN book_details_cache dc ON dc.book_id = b.id
      ORDER BY ${rankOrder}
      LIMIT 500`;
    params = [authorName];
  }
  return db.prepare(sql).all(...params);
}

export function getSeriesBooksOpds(seriesName) {
  const name = resolveSeriesCatalogName(String(seriesName || ''));
  return db
    .prepare(
      `
    SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.genres,
           b.archive_name AS archiveName, b.file_name AS fileName, b.source_id AS sourceId,
           dc.annotation
    FROM active_books b
    JOIN book_series bs ON bs.book_id = b.id
    JOIN series_catalog sc ON sc.id = bs.series_id AND sc.name = ?
    LEFT JOIN sources s ON s.id = b.source_id
    LEFT JOIN book_details_cache dc ON dc.book_id = b.id
    ORDER BY CAST(b.series_no AS INTEGER), b.title
    LIMIT 500
  `
    )
    .all(name);
}

export function recordReadingHistory(username, bookId) {
  db.prepare(`
    INSERT INTO users(username) VALUES(?)
    ON CONFLICT(username) DO NOTHING
  `).run(username);

  db.prepare(`
    INSERT INTO reading_history(username, book_id, last_opened_at, open_count)
    VALUES(?, ?, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(username, book_id) DO UPDATE SET
      last_opened_at = CURRENT_TIMESTAMP,
      open_count = reading_history.open_count + 1
  `).run(username, bookId);
}

export function getReadingHistory(username, limit = 20) {
  return db.prepare(`
    SELECT b.id, b.title, b.authors, b.ext, b.series, b.series_no AS seriesNo,
           rh.last_opened_at AS lastOpenedAt, rh.open_count AS openCount
    FROM reading_history rh
    JOIN active_books b ON b.id = rh.book_id
    WHERE rh.username = ?
    ORDER BY rh.last_opened_at DESC
    LIMIT ?
  `).all(username, limit);
}

export function toggleFavoriteAuthor(username, authorName) {
  const resolvedName = resolveAuthorName(authorName);
  if (!resolvedName) {
    return null;
  }

  const author = db.prepare('SELECT id FROM authors WHERE name = ?').get(resolvedName);
  if (!author) {
    return null;
  }

  db.prepare(`
    INSERT INTO users(username) VALUES(?)
    ON CONFLICT(username) DO NOTHING
  `).run(username);

  const exists = db.prepare('SELECT 1 FROM favorite_authors WHERE username = ? AND author_id = ?').get(username, author.id);
  if (exists) {
    db.prepare('DELETE FROM favorite_authors WHERE username = ? AND author_id = ?').run(username, author.id);
    return false;
  }

  db.prepare('INSERT INTO favorite_authors(username, author_id) VALUES(?, ?)').run(username, author.id);
  return true;
}

export function toggleFavoriteSeries(username, seriesName) {
  const resolved = resolveSeriesCatalogName(String(seriesName || ''));
  const series = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get(resolved);
  if (!series) {
    return null;
  }

  db.prepare(`
    INSERT INTO users(username) VALUES(?)
    ON CONFLICT(username) DO NOTHING
  `).run(username);

  const exists = db.prepare('SELECT 1 FROM favorite_series WHERE username = ? AND series_id = ?').get(username, series.id);
  if (exists) {
    db.prepare('DELETE FROM favorite_series WHERE username = ? AND series_id = ?').run(username, series.id);
    return false;
  }

  db.prepare('INSERT INTO favorite_series(username, series_id) VALUES(?, ?)').run(username, series.id);
  return true;
}

export function getFavoriteAuthors(username, limit = 20, sort = 'date') {
  const orderMap = {
    name: `COALESCE(a.display_name, a.name) COLLATE NOCASE ASC`,
    count: 'bookCount DESC',
    date: 'fa.created_at DESC'
  };
  const orderBy = orderMap[sort] || orderMap.date;
  return db.prepare(`
    SELECT a.name, COALESCE(a.display_name, a.name) AS displayName, COUNT(ab.id) AS bookCount
    FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    LEFT JOIN book_authors ba ON ba.author_id = a.id
    LEFT JOIN active_books ab ON ab.id = ba.book_id
    WHERE fa.username = ?
    GROUP BY a.id, a.name, a.display_name
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(username, limit);
}

export function getFavoriteSeries(username, limit = 20, sort = 'date') {
  const orderMap = {
    name: `COALESCE(s.display_name, s.name) COLLATE NOCASE ASC`,
    count: 'bookCount DESC',
    date: 'fs.created_at DESC'
  };
  const orderBy = orderMap[sort] || orderMap.date;
  return db.prepare(`
    SELECT s.name, COALESCE(s.display_name, s.name) AS displayName, COUNT(ab.id) AS bookCount
    FROM favorite_series fs
    JOIN series_catalog s ON s.id = fs.series_id
    LEFT JOIN book_series bs ON bs.series_id = s.id
    LEFT JOIN active_books ab ON ab.id = bs.book_id
    WHERE fs.username = ?
    GROUP BY s.id, s.name, s.display_name
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(username, limit);
}

export function isFavoriteAuthor(username, authorName) {
  const resolvedName = resolveAuthorName(authorName);
  if (!resolvedName) {
    return false;
  }

  return Boolean(db.prepare(`
    SELECT 1
    FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    WHERE fa.username = ? AND a.name = ?
  `).get(username, resolvedName));
}

export function isFavoriteSeries(username, seriesName) {
  const resolved = resolveSeriesCatalogName(String(seriesName || ''));
  return Boolean(db.prepare(`
    SELECT 1
    FROM favorite_series fs
    JOIN series_catalog s ON s.id = fs.series_id
    WHERE fs.username = ? AND s.name = ?
  `).get(username, resolved));
}

export function getBookmarks(username, sort = 'date', limit = 0) {
  const orderMap = {
    title: 'b.title COLLATE NOCASE ASC',
    author: `COALESCE(b.authors, '') COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC`,
    date: 'bm.created_at DESC'
  };
  const orderBy = orderMap[sort] || orderMap.date;
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  const sql = `
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
           b.ext, b.archive_name AS archiveName
    FROM bookmarks bm
    JOIN active_books b ON b.id = bm.book_id
    WHERE bm.username = ?
    ORDER BY ${orderBy}
    ${normalizedLimit ? 'LIMIT ?' : ''}
  `;
  const rows = normalizedLimit
    ? db.prepare(sql).all(username, normalizedLimit)
    : db.prepare(sql).all(username);
  return rows.map(mapBookListRow);
}

export function isBookmarked(username, bookId) {
  return Boolean(db.prepare('SELECT 1 FROM bookmarks WHERE username = ? AND book_id = ?').get(username, bookId));
}

let _stmtIsBookRead = null;
export function isBookRead(username, bookId) {
  if (!_stmtIsBookRead) {
    _stmtIsBookRead = db.prepare('SELECT 1 FROM read_books WHERE username = ? AND book_id = ?');
  }
  return Boolean(_stmtIsBookRead.get(username, bookId));
}

let _stmtIsSeriesFullyRead = null;
export function isSeriesFullyRead(username, seriesName) {
  if (!username || !seriesName) return false;
  if (!_stmtIsSeriesFullyRead) {
    _stmtIsSeriesFullyRead = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM active_books WHERE series = ?) AS total,
        (SELECT COUNT(*) FROM read_books rb JOIN active_books b ON b.id = rb.book_id WHERE rb.username = ? AND b.series = ?) AS readCount
    `);
  }
  const row = _stmtIsSeriesFullyRead.get(seriesName, username, seriesName);
  return row && row.total > 0 && row.readCount >= row.total;
}

export function removeReadBooksForSeries(username, seriesName) {
  if (!username || !seriesName) return { removed: 0 };
  const ids = getAllBookIdsByFacet('series', seriesName);
  let removed = 0;
  for (const bookId of ids) {
    const existed = db.prepare('DELETE FROM read_books WHERE username = ? AND book_id = ?').run(username, bookId);
    if (existed.changes > 0) removed++;
  }
  invalidateReadCache(username);
  return { removed };
}

export function toggleBookmark(username, bookId) {
  const exists = isBookmarked(username, bookId);
  if (exists) {
    db.prepare('DELETE FROM bookmarks WHERE username = ? AND book_id = ?').run(username, bookId);
    return false;
  }
  db.prepare('INSERT OR IGNORE INTO users(username) VALUES(?)').run(username);
  db.prepare('INSERT OR IGNORE INTO bookmarks(username, book_id) VALUES(?, ?)').run(username, bookId);
  return true;
}

/** Добавить в избранное только отсутствующие; bookIds — в порядке запроса, дубликаты пропускаются. */
export function addBookmarksIfMissing(username, bookIds) {
  const unique = [...new Set(bookIds.map((x) => String(x || '').trim()).filter(Boolean))];
  let added = 0;
  let already = 0;
  let missing = 0;
  for (const bookId of unique) {
    if (!getBookById(bookId)) {
      missing++;
      continue;
    }
    if (isBookmarked(username, bookId)) {
      already++;
      continue;
    }
    db.prepare('INSERT OR IGNORE INTO users(username) VALUES(?)').run(username);
    db.prepare('INSERT INTO bookmarks(username, book_id) VALUES(?, ?)').run(username, bookId);
    added++;
  }
  return { added, already, missing };
}

export function toggleReadBook(username, bookId) {
  const exists = isBookRead(username, bookId);
  if (exists) {
    db.prepare('DELETE FROM read_books WHERE username = ? AND book_id = ?').run(username, bookId);
    invalidateReadCache(username);
    return false;
  }
  db.prepare('INSERT OR IGNORE INTO users(username) VALUES(?)').run(username);
  db.prepare('INSERT OR IGNORE INTO read_books(username, book_id) VALUES(?, ?)').run(username, bookId);
  invalidateReadCache(username);
  return true;
}

export function addReadBooksIfMissing(username, bookIds) {
  const unique = [...new Set(bookIds.map((x) => String(x || '').trim()).filter(Boolean))];
  let added = 0;
  let already = 0;
  let missing = 0;
  for (const bookId of unique) {
    if (!getBookById(bookId)) {
      missing++;
      continue;
    }
    if (isBookRead(username, bookId)) {
      already++;
      continue;
    }
    db.prepare('INSERT OR IGNORE INTO users(username) VALUES(?)').run(username);
    db.prepare('INSERT OR IGNORE INTO read_books(username, book_id) VALUES(?, ?)').run(username, bookId);
    added++;
  }
  if (added > 0) invalidateReadCache(username);
  return { added, already, missing };
}

export function getReadBooks(username, sort = 'date', limit = 0) {
  const orderMap = {
    title: 'b.title COLLATE NOCASE ASC',
    author: `COALESCE(b.authors, '') COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC`,
    date: 'rb.created_at DESC'
  };
  const orderBy = orderMap[sort] || orderMap.date;
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  const sql = `
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
           b.ext, b.archive_name AS archiveName
    FROM read_books rb
    JOIN active_books b ON b.id = rb.book_id
    WHERE rb.username = ?
    ORDER BY ${orderBy}
    ${normalizedLimit ? 'LIMIT ?' : ''}
  `;
  const rows = normalizedLimit
    ? db.prepare(sql).all(username, normalizedLimit)
    : db.prepare(sql).all(username);
  return rows.map(mapBookListRow);
}

export function getSuggestions(query, limit = 5) {
  const raw = String(query || '').trim();
  if (!raw || raw.length < 2) return { books: [], authors: [], series: [] };
  const key = createSortKey(raw);
  if (!key) return { books: [], authors: [], series: [] };

  const booksPrefix = db.prepare(`
    SELECT id, title, authors, series
    FROM active_books
    WHERE title_sort LIKE ? OR author_sort LIKE ?
    ORDER BY CASE WHEN title_sort LIKE ? THEN 0 ELSE 1 END, title_sort ASC
    LIMIT ?
  `).all(`${key}%`, `${key}%`, `${key}%`, limit);
  const books = booksPrefix;
  if (books.length < limit) {
    const need = limit - books.length;
    const seen = new Set(books.map((b) => String(b.id)));
    const booksContains = db.prepare(`
      SELECT id, title, authors, series
      FROM active_books
      WHERE (title_sort LIKE ? OR author_sort LIKE ?)
        AND title_sort NOT LIKE ?
        AND author_sort NOT LIKE ?
      ORDER BY CASE WHEN title_sort LIKE ? THEN 0 ELSE 1 END, title_sort ASC
      LIMIT ?
    `).all(`%${key}%`, `%${key}%`, `${key}%`, `${key}%`, `${key}%`, need * 2);
    for (const row of booksContains) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      books.push(row);
      if (books.length >= limit) break;
    }
  }

  const authorsPrefix = db.prepare(`
    SELECT a.name AS name, COALESCE(a.display_name, a.name) AS displayName,
           COUNT(ab.id) AS bookCount
    FROM authors a
    JOIN book_authors ba ON ba.author_id = a.id
    JOIN active_books ab ON ab.id = ba.book_id
    WHERE COALESCE(a.search_name, '') LIKE ?
    GROUP BY a.id ORDER BY bookCount DESC LIMIT ?
  `).all(`${key}%`, limit);
  const authors = authorsPrefix;
  if (authors.length < limit) {
    const need = limit - authors.length;
    const seen = new Set(authors.map((a) => String(a.name)));
    const authorsContains = db.prepare(`
      SELECT a.name AS name, COALESCE(a.display_name, a.name) AS displayName,
             COUNT(ab.id) AS bookCount
      FROM authors a
      JOIN book_authors ba ON ba.author_id = a.id
      JOIN active_books ab ON ab.id = ba.book_id
      WHERE COALESCE(a.search_name, '') LIKE ?
        AND COALESCE(a.search_name, '') NOT LIKE ?
      GROUP BY a.id ORDER BY bookCount DESC LIMIT ?
    `).all(`%${key}%`, `${key}%`, need * 2);
    for (const row of authorsContains) {
      const name = String(row.name);
      if (seen.has(name)) continue;
      seen.add(name);
      authors.push(row);
      if (authors.length >= limit) break;
    }
  }

  const seriesPrefix = db.prepare(`
    SELECT sc.name AS name, COALESCE(sc.display_name, sc.name) AS displayName,
           COUNT(ab.id) AS bookCount
    FROM series_catalog sc
    JOIN book_series bs ON bs.series_id = sc.id
    JOIN active_books ab ON ab.id = bs.book_id
    WHERE COALESCE(sc.search_name, '') LIKE ?
    GROUP BY sc.id ORDER BY bookCount DESC LIMIT ?
  `).all(`${key}%`, limit);
  const seriesItems = seriesPrefix;
  if (seriesItems.length < limit) {
    const need = limit - seriesItems.length;
    const seen = new Set(seriesItems.map((s) => String(s.name)));
    const seriesContains = db.prepare(`
      SELECT sc.name AS name, COALESCE(sc.display_name, sc.name) AS displayName,
             COUNT(ab.id) AS bookCount
      FROM series_catalog sc
      JOIN book_series bs ON bs.series_id = sc.id
      JOIN active_books ab ON ab.id = bs.book_id
      WHERE COALESCE(sc.search_name, '') LIKE ?
        AND COALESCE(sc.search_name, '') NOT LIKE ?
      GROUP BY sc.id ORDER BY bookCount DESC LIMIT ?
    `).all(`%${key}%`, `${key}%`, need * 2);
    for (const row of seriesContains) {
      const name = String(row.name);
      if (seen.has(name)) continue;
      seen.add(name);
      seriesItems.push(row);
      if (seriesItems.length >= limit) break;
    }
  }

  return { books: books.map(mapBookListRow), authors, series: seriesItems };
}
