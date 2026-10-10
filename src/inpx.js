import fs from 'node:fs';
import path from 'node:path';
import { normalizeCachedAnnotation } from './html-sanitize.js';
import unzipper from 'unzipper';
import iconv from 'iconv-lite';
import {
  db,
  getMeta,
  setMeta,
  getSetting,
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
  dropBulkImportIndexes,
  ensureBulkImportIndexes,
  ensureBulkImportIndexesAsync,
  beginExclusiveOperation,
  endExclusiveOperation,
  refreshCatalogBookCounts,
  adjustCatalogCountsForBook,
  isBookInActiveView,
  getLibraryStatsSnapshot,
  writeLibraryStatsSnapshot,
  suppressBook,
  getSuppressedBookIds,
  invalidateReadCache,
  getReadBooksCount,
  createDatabaseBackup,
  onViewRebuild,
  deleteReadingHistoryEntry,
  touchUserReaderRevision,
  isBooksFtsUsable,
  getBooksFtsStatus,
  invalidateBooksFtsHealthCache,
  ensureSearchTitleTokensTable,
  scheduleBootFtsRecoveryIfNeeded,
} from './db.js';
import { appendStemmedSearchTokens, expandSearchTokenVariants } from './search-stem.js';
import { filterSearchContentTokens, normalizeLookalikeSortKey } from './search-normalize.js';
import {
  applyDidYouMeanToQuery,
  buildOrderedTitleLikePattern,
  clearWarmSearchBooksPages,
  dedupeSearchBookItems,
  detectPreferredSearchField,
  isWeakBookSearchResult,
  rememberWarmSearchBooksPage,
  resolveSearchRouteField,
  takeWarmSearchBooksPage,
  warmupSearchFts
} from './search-enhance.js';
export { clearWarmSearchBooksPages, resolveSearchRouteField, warmupSearchFts };
import { config } from './config.js';
import { PAGE_CACHE_TTL_MS } from './constants.js';
import { formatGenreLabel, formatGenreList, capitalizeAuthorNamePart } from './genre-map.js';
import { getAvailableDownloadFormats, FORMAT_LABELS } from './download-formats.js';
import { t } from './i18n.js';
import { appendIndexDiaryLine } from './services/file-log.js';
import { logSystemEvent } from './services/system-events.js';
import { invalidateAllRecommendations } from './services/recommendations.js';
import { parseEnvTimeoutMs, promiseWithTimeout } from './utils/async-timeout.js';
import { resolveIndexImportMode } from './index-import-mode.js';
import { getBulkIndexLabelKey } from './index-stage-i18n.js';
import { resolveLibraryArchiveFile } from './flibusta-sidecar.js';

/** Уступка циклу событий между тяжёлыми синхронными участками (чтобы HTTP не «замирал»).
 *  Используем setImmediate без фиксированной задержки: на больших библиотеках setTimeout(2) давал
 *  лишние минуты только из‑за накопленных пауз. */
const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Одна «логическая» строка INPX длиннее этого — пропуск: иначе split/нормализация могут блокировать поток надолго. */
const MAX_INPX_LINE_CHARS = 256 * 1024;

/**
 * Memory-budget constants for INPX/.inp buffering.
 *
 * MAX_INP_ENTRY_BYTES (256 MB) — single .inp files larger than this are skipped.
 *   Flibusta's biggest .inp is ~60 MB; Libruks online.inp is ~103 MB.
 *   The uncompressed entry is held in RAM only while that archive is parsed.
 *
 * HEAP_WARNING_THRESHOLD_MB (600 MB) — when V8 heap exceeds this during indexing
 *   we emit a system-level warning.  For libraries with >500 000 books the Node
 *   process typically needs ≥1.5 GB RSS; if you see repeated warnings, start the
 *   server with  --max-old-space-size=2048  (or higher).
 *
 * Minimum RAM recommendation:
 *   • <100 K books  — 512 MB is usually sufficient
 *   • 100–500 K     — 1 GB
 *   • >500 K         — 1.5 GB+  (set --max-old-space-size accordingly)
 */
const MAX_INP_ENTRY_BYTES = 256 * 1024 * 1024;
const HEAP_WARNING_THRESHOLD_MB = 600;
const FACET_CACHE_TTL_MS = 120_000; // 20с → 120с: меньше запросов на страницах фасетов/серий/авторов
/** COUNT дедупа по фасету не зависит от страницы — кешируем отдельно, чтобы «далее» не гоняло тяжёлый подсчёт. */
const FACET_DEDUP_TOTAL_TTL_MS = parseEnvTimeoutMs('FACET_DEDUP_TOTAL_TTL_MS', 300_000);
/**
 * Размер фасета (книг), выше которого панели «связанные авторы/серии/жанры» не строятся.
 * Их GROUP BY по огромному жанру/языку (сотни тысяч книг) блокирует event loop на секунды.
 * 0 — ограничение отключено (старое поведение). Переопределяется FACET_SUMMARY_MAX_BOOKS.
 * 5000 — компромисс: для средних фасетов (5–15k) GROUP BY занимает сотни мс–секунды.
 */
const FACET_SUMMARY_MAX_BOOKS = Math.max(0, Number.parseInt(String(process.env.FACET_SUMMARY_MAX_BOOKS || ''), 10) || 5_000);
/** Summary (связанные панели) меняются редко — кэшируем дольше, чем страницы книг. */
const FACET_SUMMARY_CACHE_TTL_MS = 600_000;
const AUTHOR_GROUPED_CACHE_TTL_MS = 60_000; // 12с → 60с: меньше запросов на странице группировки по авторам
/** Макс. число строк на странице автора (лимит выборки из БД).
 * 50 000 → 10 000: выборка десятков тысяч строк из junction + view
 * с ORDER BY и LEFT JOIN создаёт многосекундную блокировку event loop. */
const AUTHOR_GROUPED_FETCH_CAP = 10_000;
const ARCHIVE_STEM_LOOKUP_TTL_MS = 120_000;
const BOOKS_FTS_DIRTY_META_KEY = 'books_fts_dirty';
/**
 * A healthy FTS miss is authoritative. Falling through to a multi-column LIKE
 * scan on 500k+ books blocks the Node event loop for several seconds. Keep the
 * legacy behaviour available only as an explicit emergency compatibility flag.
 */
const BOOKS_FTS_ZERO_MATCH_LIKE_FALLBACK = process.env.BOOKS_FTS_ZERO_MATCH_LIKE_FALLBACK === '1';
/**
 * Legacy empty-result recovery re-runs corrected book search plus author/series
 * scans synchronously. The search overview already supplies those section
 * totals, so keep that expensive duplicate work opt-in on large NAS catalogs.
 */
const SEARCH_SYNC_EMPTY_RECOVERY = process.env.SEARCH_SYNC_EMPTY_RECOVERY === '1';

const facetBooksCache = new Map();
const facetDedupTotalCache = new Map();
const facetSummaryCache = new Map();
// Heavy payload cache; keep intentionally tiny to avoid memory growth/GC stalls.
const authorGroupedCache = new Map();
/** Параллельные запросы к одному ключу ждут один проход БД (см. *Coalesced). */
const authorGroupedInflight = new Map();
const facetBooksInflight = new Map();
const archiveStemLookupCache = new Map();

/* ── Reset cached prepared statements when active_books VIEW is rebuilt ── */
function resetInpxPreparedStatements() {
  _stmtGetBookById = null;
  _browseTotalMemo = null;
  _authorsTotalMemo.clear();
  _recentCutoffMemo = null;
  _stmtGenresGroupedCount = null;
  _stmtGenresGroupedName = null;
  _stmtDupSummary = null;
  _dupSummaryCache = null;
  _stmtDupLibSummary = null;
  _stmtDupTitlePairSummary = null;
  _stmtDupAuthorTotal = null;
  _stmtDupAuthorPage = null;
  _stmtLibSections = null;
  _stmtContinueCount = null;
  _stmtContinueItems = null;
  _stmtHasContinue = null;
  _stmtReadSeriesCount = null;
  _stmtReadSeriesItems = null;
  _stmtReadViewCount = null;
  _stmtReadViewItems = null;
  _stmtRecordHistoryUser = null;
  _stmtRecordHistoryUpsert = null;
  _stmtGetReadHistory = null;
  _stmtGetReadHistoryActive = null;
  _stmtIsFavAuthor = null;
  _stmtIsFavSeries = null;
  _stmtIsBookmarked = null;
  _stmtIsBookRead = null;
  _stmtIsSeriesFullyRead = null;
  _stmtFacetCountLang = null;
  _stmtBookmarksBySort.clear();
  _stmtBookmarksLimitedBySort.clear();
  _stmtReadBooksBySort.clear();
  _stmtReadBooksLimitedBySort.clear();
  _stmtPreferredAuthorAlias = null;
  _stmtAuthorGroupedRowCount = null;
  _stmtAuthorGroupedTotal = null;
  _stmtAuthorAliasBookCount = null;
  _stmtAuthorFlibustaSourceId = null;
  _stmtFacetCountAuthor = null;
  _recStmtCache.clear();
  clearRuntimeQueryCaches();
}
onViewRebuild(resetInpxPreparedStatements);

function clampInt(value, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, n));
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
    /* Удаляем пачку самых старых записей (≈10% maxSize), иначе при пиковой нагрузке
       кэш постоянно держится на maxSize+1 и делает O(n) eviction на каждую вставку. */
    const evictTarget = Math.max(1, Math.floor(maxSize / 10));
    let evicted = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++evicted >= evictTarget) break;
    }
  }
}

function clearRuntimeQueryCaches() {
  facetBooksCache.clear();
  facetDedupTotalCache.clear();
  facetSummaryCache.clear();
  authorGroupedCache.clear();
  archiveStemLookupCache.clear();
  _facetStmtCache.clear();
  _distinctLangsCache = null;
  _distinctFormatsCache = null;
}

/** Раньше сбрасывала проекцию дедупа; оставлено имя для совместимости вызовов из server. */
export function rebuildLibraryDedupProjection() {
  clearRuntimeQueryCaches();
  return true;
}

export function markLibraryDedupProjectionStale() {
  clearRuntimeQueryCaches();
}

/** Сбросить кеши, связанные с дедупликацией (вызывается после soft-delete / auto-clean). */
export function invalidateDuplicatesCache() {
  facetDedupTotalCache.clear();
  facetBooksCache.clear();
  facetSummaryCache.clear();
  _dupSummaryCache = null;
  _browseTotalMemo = null;
  _authorsTotalMemo.clear();
}

/**
 * Удаляет junction-строки для отсутствующих книг (hard-deleted).
 * Серии намеренно не схлопываются: одна книга может быть в нескольких сериях
 * (авторская + издательская и т.д.) через повторные строки INP с тем же lib_id.
 */
export function repairBookJunctionLinks() {
  const removedOrphans = db.transaction(() => {
    const a = db.prepare(`
      DELETE FROM book_authors WHERE book_id NOT IN (SELECT id FROM books)
    `).run().changes;
    const s = db.prepare(`
      DELETE FROM book_series WHERE book_id NOT IN (SELECT id FROM books)
    `).run().changes;
    const g = db.prepare(`
      DELETE FROM book_genres WHERE book_id NOT IN (SELECT id FROM books)
    `).run().changes;
    return { authors: a, series: s, genres: g };
  })();

  if (removedOrphans.authors || removedOrphans.series || removedOrphans.genres) {
    console.log('[index] repairBookJunctionLinks:', removedOrphans);
    logSystemEvent('info', 'index', 'orphan book junction links removed', removedOrphans);
  }
  invalidateDuplicatesCache();
  return removedOrphans;
}

/* Короткий кеш сводки по дубликатам: один полный проход вместо двух (total + preview). */
let _dupSummaryCache = null;
const DUP_SUMMARY_TTL_MS = 60_000;
let _stmtDupSummary = null;
let _stmtDupLibSummary = null;
let _stmtDupTitlePairSummary = null;
let _stmtDupAuthorTotal = null;
let _stmtDupAuthorPage = null;

const DUP_FORMAT_RANK_SQL = `CASE lower(COALESCE(ext, ''))
  WHEN 'epub' THEN 1
  WHEN 'fb2' THEN 2
  WHEN 'mobi' THEN 3
  WHEN 'azw3' THEN 4
  WHEN 'djvu' THEN 5
  WHEN 'pdf' THEN 6
  WHEN 'doc' THEN 7
  WHEN 'docx' THEN 8
  WHEN 'rtf' THEN 9
  WHEN 'txt' THEN 10
  ELSE 99
END`;

const DUP_RANK_ORDER_SQL = `${DUP_FORMAT_RANK_SQL} ASC, COALESCE(source_id, 0) DESC, COALESCE(size, 0) DESC, id DESC`;

/**
 * Копии, которые автоочистка скроет: одинаковые title+author, тот же lib_id
 * в двух источниках на одном томе архива, либо ровно две книги с одним
 * названием из двух источников при разном авторе (Кова / Ковалькова).
 */
const DUP_LOSER_ROWS_SQL = `
  SELECT id, COALESCE(title, '') AS title, COALESCE(authors, '') AS authors,
         title_sort, COALESCE(author_sort, '') AS author_sort
  FROM (
    SELECT id, title, authors, title_sort, author_sort,
           ROW_NUMBER() OVER (
             PARTITION BY title_sort, COALESCE(author_sort, '')
             ORDER BY ${DUP_RANK_ORDER_SQL}
           ) AS rn
    FROM active_books
    WHERE title_sort IS NOT NULL AND title_sort != ''
  ) ranked
  WHERE rn > 1
  UNION
  SELECT id, COALESCE(title, '') AS title, COALESCE(authors, '') AS authors,
         title_sort, COALESCE(author_sort, '') AS author_sort
  FROM (
    SELECT b.id, b.title, b.authors, b.title_sort, b.author_sort,
           ROW_NUMBER() OVER (
             PARTITION BY b.lib_id, archive_stem(b.archive_name)
             ORDER BY ${DUP_FORMAT_RANK_SQL.replace(/\bext\b/g, 'b.ext')} ASC,
                      COALESCE(b.source_id, 0) DESC, COALESCE(b.size, 0) DESC, b.id DESC
           ) AS rn
    FROM active_books b
    JOIN (
      SELECT lib_id, archive_stem(archive_name) AS stem
      FROM active_books
      WHERE lib_id IS NOT NULL AND TRIM(lib_id) != ''
      GROUP BY lib_id, stem
      HAVING COUNT(*) > 1 AND COUNT(DISTINCT source_id) > 1
    ) k ON k.lib_id = b.lib_id
       AND k.stem = archive_stem(b.archive_name)
  ) ranked_lib
  WHERE rn > 1
  UNION
  SELECT id, COALESCE(title, '') AS title, COALESCE(authors, '') AS authors,
         title_sort, COALESCE(author_sort, '') AS author_sort
  FROM (
    SELECT b.id, b.title, b.authors, b.title_sort, b.author_sort,
           ROW_NUMBER() OVER (
             PARTITION BY b.title_sort
             ORDER BY ${DUP_FORMAT_RANK_SQL.replace(/\bext\b/g, 'b.ext')} ASC,
                      COALESCE(b.source_id, 0) DESC, COALESCE(b.size, 0) DESC, b.id DESC
           ) AS rn
    FROM active_books b
    JOIN (
      SELECT title_sort
      FROM active_books
      WHERE title_sort IS NOT NULL AND title_sort != ''
      GROUP BY title_sort
      HAVING COUNT(*) = 2
         AND COUNT(DISTINCT source_id) = 2
         AND COUNT(DISTINCT COALESCE(author_sort, '')) > 1
    ) k ON k.title_sort = b.title_sort
  ) ranked_title
  WHERE rn > 1
`;

function getDuplicatesSummary() {
  if (_dupSummaryCache && Date.now() < _dupSummaryCache.expiresAt) {
    return _dupSummaryCache.value;
  }
  _stmtDupSummary ??= db.prepare(`
    SELECT COALESCE(SUM(c), 0) AS totalBooks, COUNT(*) AS totalGroups
    FROM (
      SELECT COUNT(*) AS c FROM active_books
      WHERE title_sort IS NOT NULL AND title_sort != ''
      GROUP BY title_sort, COALESCE(author_sort, '')
      HAVING COUNT(*) > 1
    )
  `);
  const ta = _stmtDupSummary.get() || { totalBooks: 0, totalGroups: 0 };
  const enabledSources = Number(db.prepare('SELECT COUNT(*) AS c FROM sources WHERE enabled = 1').get()?.c) || 0;
  let lib = { totalBooks: 0, totalGroups: 0 };
  let pairs = { totalBooks: 0, totalGroups: 0 };
  if (enabledSources >= 2) {
    _stmtDupLibSummary ??= db.prepare(`
      SELECT COALESCE(SUM(c), 0) AS totalBooks, COUNT(*) AS totalGroups
      FROM (
        SELECT COUNT(*) AS c FROM active_books
        WHERE lib_id IS NOT NULL AND TRIM(lib_id) != ''
        GROUP BY lib_id, archive_stem(archive_name)
        HAVING COUNT(*) > 1 AND COUNT(DISTINCT source_id) > 1
      )
    `);
    _stmtDupTitlePairSummary ??= db.prepare(`
      SELECT COALESCE(SUM(c), 0) AS totalBooks, COUNT(*) AS totalGroups
      FROM (
        SELECT COUNT(*) AS c FROM active_books
        WHERE title_sort IS NOT NULL AND title_sort != ''
        GROUP BY title_sort
        HAVING COUNT(*) = 2
           AND COUNT(DISTINCT source_id) = 2
           AND COUNT(DISTINCT COALESCE(author_sort, '')) > 1
      )
    `);
    lib = _stmtDupLibSummary.get() || lib;
    pairs = _stmtDupTitlePairSummary.get() || pairs;
  }
  const totalGroups = (Number(ta.totalGroups) || 0) + (Number(lib.totalGroups) || 0) + (Number(pairs.totalGroups) || 0);
  const totalBooks = (Number(ta.totalBooks) || 0) + (Number(lib.totalBooks) || 0) + (Number(pairs.totalBooks) || 0);
  const willDelete = Math.max(0, (Number(ta.totalBooks) || 0) - (Number(ta.totalGroups) || 0))
    + Math.max(0, (Number(lib.totalBooks) || 0) - (Number(lib.totalGroups) || 0))
    + Math.max(0, (Number(pairs.totalBooks) || 0) - (Number(pairs.totalGroups) || 0));
  const value = { totalBooks, totalGroups, willDelete };
  _dupSummaryCache = { value, expiresAt: Date.now() + DUP_SUMMARY_TTL_MS };
  return value;
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
    return capitalizeAuthorNamePart(raw);
  }

  return parts.map((part) => capitalizeAuthorNamePart(part)).join(' ');
}

function withAuthorDisplayNames(items) {
  if (!Array.isArray(items)) return items;
  for (const item of items) {
    if (!item) continue;
    const formatted = formatSingleAuthorName(item.displayName || item.name);
    if (formatted) item.displayName = formatted;
  }
  return items;
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
  const direct = _seriesByName.get(raw.toLowerCase());
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
  const stemsDone = getMeta('search_stems_v1') === 'done';

  if (catalogDone && booksDone && stemsDone) {
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
    const newTitleSearch = appendStemmedSearchTokens(createSortKey(row.title));
    const newAuthorsSearch = buildAuthorsSearchField(row.authors);
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
      if (getMeta('search_stems_v1') !== 'done') {
        console.log('[backfill] Добавление stem-токенов в поля поиска…');
        setTimeout(() => runStemsBooksChunk(0), 8);
      }
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

  function runStemsBooksChunk(lastRowid) {
    if (indexState.active) {
      setTimeout(() => runStemsBooksChunk(lastRowid), 2000);
      return;
    }
    const bookRows = selectBooksChunk.all(lastRowid, BOOK_SEARCH_BACKFILL_CHUNK);
    if (!bookRows.length) {
      setMeta('search_stems_v1', 'done');
      console.log('[backfill] Stem-токены в полях поиска готовы.');
      setMeta('books_fts_dirty', '1');
      invalidateBooksFtsHealthCache();
      scheduleBootFtsRecoveryIfNeeded();
      try { rebuildTitleTokenDictionary({ force: true }); } catch { /* ignore */ }
      return;
    }
    const tx = db.transaction(() => {
      for (const row of bookRows) {
        applyBookRow(row);
      }
    });
    tx();
    const nextRowid = bookRows[bookRows.length - 1].rowid;
    setTimeout(() => runStemsBooksChunk(nextRowid), 8);
  }

  setTimeout(() => {
    if (catalogDone) {
      if (!booksDone) {
        console.log('[backfill] Нормализация книг (ё→е)…');
        setTimeout(() => runYoBooksChunk(0), 8);
      } else if (!stemsDone) {
        console.log('[backfill] Добавление stem-токенов в поля поиска…');
        setTimeout(() => runStemsBooksChunk(0), 8);
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
                if (getMeta('search_stems_v1') !== 'done') {
                  console.log('[backfill] Добавление stem-токенов в поля поиска…');
                  setTimeout(() => runStemsBooksChunk(0), 8);
                }
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

function buildAuthorsSearchField(authors = '') {
  return splitAuthorValues(authors)
    .map((item) => appendStemmedSearchTokens(createSortKey(formatSingleAuthorName(item) || item)))
    .filter(Boolean)
    .join(' | ');
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
    titleSearch: appendStemmedSearchTokens(createSortKey(row.title)),
    authorsSearch: buildAuthorsSearchField(row.authors),
    seriesSearch: createSortKey(row.series),
    genresSearch: genreSearchTokens.join(' | '),
    keywordsSearch: createSortKey(row.keywords),
    date: resolveDisplayDate(row.date)
  };
}

const FIELD_SEPARATOR = String.fromCharCode(4);
const TEXT_ENCODING = 'win1251';

function buildScopedBookId({ rawId, sourceId = null, archiveName = '', fileName = '', ext = '' }) {
  const baseId = String(rawId || '').trim();
  if (!baseId) {
    return '';
  }
  if (sourceId == null || sourceId === '') {
    return baseId;
  }
  const sid = Number(sourceId);
  const archivePart = String(archiveName || '').trim().toLowerCase();
  const filePart = String(fileName || '').trim().toLowerCase();
  const extPart = String(ext || '').trim().toLowerCase();
  return `${sid}:${baseId}\u0000${archivePart}\u0000${filePart}\u0000${extPart}`;
}

const indexState = {
  active: false,
  ready: false,
  startedAt: null,
  finishedAt: null,
  processedArchives: 0,
  totalArchives: 0,
  importedBooks: 0,
  uniqueBooks: 0,
  newBooksCount: 0,
  currentArchive: '',
  currentStage: null,
  error: '',
  pauseRequested: false,
  paused: false,
  cancelRequested: false,
  mode: '',
  sourceId: null
};

function assignIndexStage(key, params = {}) {
  indexState.currentStage = { key, params };
  indexState.currentArchive = '';
}

function assignIndexArchiveRaw(text) {
  indexState.currentStage = null;
  indexState.currentArchive = String(text || '');
}

function clearIndexStageDisplay() {
  indexState.currentStage = null;
  indexState.currentArchive = '';
}

export function bumpIndexNewBooks(delta = 1) {
  const d = Math.max(0, Math.floor(Number(delta) || 0));
  if (d > 0) indexState.newBooksCount += d;
}

function persistIndexNewBooksCount() {
  try {
    setMeta('index_last_new_books_count', String(Math.max(0, indexState.newBooksCount || 0)));
  } catch { /* ignore */ }
}

const _indexCompleteListeners = [];

/** @param {(payload: { newBooksCount: number }) => void} listener */
export function onIndexComplete(listener) {
  if (typeof listener === 'function') _indexCompleteListeners.push(listener);
}

function emitIndexCompleted() {
  const newBooksCount = Math.max(0, indexState.newBooksCount || 0);
  for (const listener of _indexCompleteListeners) {
    try {
      listener({ newBooksCount });
    } catch { /* ignore */ }
  }
}

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

/* ── Cluster-safe index state (sharing через meta-таблицу) ── */

const INDEX_HEARTBEAT_INTERVAL_MS = 5_000;
const INDEX_HEARTBEAT_STALE_MS = 30_000;
let _indexHeartbeatTimer = null;

function isClusterIndexActive() {
  if (getMeta('index_active') !== '1') return false;
  const hb = getMeta('index_heartbeat');
  if (!hb) return false;
  if (Date.now() - new Date(hb).getTime() > INDEX_HEARTBEAT_STALE_MS) {
    clearClusterIndexState();
    return false;
  }
  return true;
}

function startClusterIndexHeartbeat() {
  if (_indexHeartbeatTimer) {
    clearInterval(_indexHeartbeatTimer);
    _indexHeartbeatTimer = null;
  }
  _indexHeartbeatTimer = setInterval(() => {
    try {
      setMeta('index_heartbeat', new Date().toISOString());
      writeClusterIndexProgress();
    } catch {}
  }, INDEX_HEARTBEAT_INTERVAL_MS);
  if (typeof _indexHeartbeatTimer.unref === 'function') _indexHeartbeatTimer.unref();
}

/** Атомарно захватить cluster-lock индексации (meta-таблица). */
function tryClaimClusterIndexLock() {
  const now = new Date().toISOString();
  const myPid = String(process.pid);
  const claimed = db.transaction(() => {
    if (getMeta('index_active') === '1') {
      const hb = getMeta('index_heartbeat');
      if (hb) {
        const age = Date.now() - new Date(hb).getTime();
        if (age <= INDEX_HEARTBEAT_STALE_MS) {
          const lockPid = getMeta('index_pid');
          if (lockPid && lockPid !== myPid) return false;
        }
      }
    }
    setMeta('index_active', '1');
    setMeta('index_pid', myPid);
    setMeta('index_heartbeat', now);
    setMeta('index_pause_requested', '');
    setMeta('index_cancel_requested', '');
    return true;
  })();
  if (!claimed) return false;
  startClusterIndexHeartbeat();
  return true;
}

function clearClusterIndexState() {
  if (_indexHeartbeatTimer) {
    clearInterval(_indexHeartbeatTimer);
    _indexHeartbeatTimer = null;
  }
  try {
    writeClusterIndexProgress();
    setMeta('index_active', '');
    setMeta('index_pid', '');
    setMeta('index_heartbeat', '');
    setMeta('index_pause_requested', '');
    setMeta('index_cancel_requested', '');
  } catch {}
}

function writeClusterIndexProgress() {
  try {
    setMeta('index_progress', JSON.stringify({
      processedArchives: indexState.processedArchives,
      totalArchives: indexState.totalArchives,
      importedBooks: indexState.importedBooks,
      uniqueBooks: indexState.uniqueBooks,
      newBooksCount: indexState.newBooksCount,
      currentArchive: String(indexState.currentArchive || '').slice(0, 500),
      currentStage: indexState.currentStage || null,
      startedAt: indexState.startedAt,
      mode: indexState.mode,
      sourceId: indexState.sourceId,
      paused: indexState.paused
    }));
  } catch {}
}

function readClusterIndexProgress() {
  try { return JSON.parse(getMeta('index_progress') || '{}'); } catch { return {}; }
}

function throwIfIndexCancelled() {
  if (indexState.cancelRequested || getMeta('index_cancel_requested') === '1') {
    indexState.cancelRequested = true;
    throw new Error('Indexing cancelled by user');
  }
}

function isIndexCancelledError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('cancelled by user');
}

async function waitIfIndexPaused() {
  const dbPause = getMeta('index_pause_requested') === '1';
  if (!indexState.pauseRequested && !dbPause) {
    indexState.paused = false;
    return;
  }
  indexState.paused = true;
  indexState.pauseRequested = true;
  while ((indexState.pauseRequested || getMeta('index_pause_requested') === '1')
         && !indexState.cancelRequested && getMeta('index_cancel_requested') !== '1') {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  indexState.paused = false;
  indexState.pauseRequested = false;
  throwIfIndexCancelled();
}

async function checkIndexControlPoint() {
  throwIfIndexCancelled();
  await waitIfIndexPaused();
}

export function requestIndexPause() {
  if (indexState.active) {
    indexState.pauseRequested = true;
    try { setMeta('index_pause_requested', '1'); } catch {}
    return true;
  }
  if (isClusterIndexActive()) {
    setMeta('index_pause_requested', '1');
    return true;
  }
  return false;
}

export function requestIndexResume() {
  if (indexState.active) {
    indexState.pauseRequested = false;
    try { setMeta('index_pause_requested', ''); } catch {}
    return true;
  }
  if (isClusterIndexActive()) {
    setMeta('index_pause_requested', '');
    return true;
  }
  return false;
}

export function requestIndexStop() {
  if (indexState.active) {
    indexState.cancelRequested = true;
    indexState.pauseRequested = false;
    try { setMeta('index_cancel_requested', '1'); setMeta('index_pause_requested', ''); } catch {}
    return true;
  }
  if (isClusterIndexActive()) {
    setMeta('index_cancel_requested', '1');
    setMeta('index_pause_requested', '');
    return true;
  }
  return false;
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
let _authorsBySortPrefix;
const _authorsByTokenSubsetStmtCache = new Map();

function ensureAuthorStmts() {
  if (!_authorByName) {
    _authorByName = db.prepare('SELECT name FROM authors WHERE name = ?');
    _authorByDisplaySearch = db.prepare(`
      SELECT name
      FROM authors
      WHERE display_name = ? OR search_name = ? OR sort_name = ?
      ORDER BY book_count DESC
      LIMIT 1
    `);
    _authorsBySortPrefix = db.prepare(`
      SELECT name, COALESCE(display_name, name) AS displayName, sort_name, book_count
      FROM authors
      WHERE sort_name LIKE ? AND book_count > 0
      ORDER BY book_count DESC
    `);
  }
}

function isAuthorInitialToken(token = '') {
  const raw = String(token || '').replace(/\./g, '').trim();
  if (!raw || raw.length > 2) return false;
  return /^[a-zа-яё]{1,2}$/i.test(raw);
}

function parseAuthorInitialPattern(value = '') {
  const tokens = createSortKey(value).split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const initials = [];
  const names = [];
  for (const token of tokens) {
    if (isAuthorInitialToken(token)) {
      initials.push(token.replace(/\./g, ''));
    } else {
      names.push(token);
    }
  }
  if (!initials.length || names.length !== 1) return null;
  return { surname: names[0], initials };
}

function catalogTokenMatchesInitial(token, initial) {
  const part = String(token || '').trim();
  const init = String(initial || '').replace(/\./g, '').trim();
  if (!part || !init) return false;
  if (part === init) return true;
  return part.startsWith(init);
}

function scoreAuthorInitialMatch(sortName, pattern) {
  if (!pattern?.surname || !pattern.initials?.length) return -1;
  const tokens = createSortKey(sortName).split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens[0] !== pattern.surname) return -1;

  const given = tokens.slice(1);
  if (!given.length) return -1;

  let matched = 0;
  let gi = 0;
  for (const init of pattern.initials) {
    if (gi >= given.length) break;
    if (catalogTokenMatchesInitial(given[gi], init)) {
      matched += 1;
      gi += 1;
    } else {
      break;
    }
  }
  if (!matched) return -1;

  const fullInitials = matched === pattern.initials.length ? 500 : 0;
  const exactTokenCount = given.length === matched ? 100 : 0;
  return matched * 1000 + fullInitials + exactTokenCount;
}

function findAuthorsMatchingInitialPattern(pattern) {
  if (!pattern) return [];

  ensureAuthorStmts();
  const rows = _authorsBySortPrefix.all(`${pattern.surname} %`);
  return rows
    .map((row) => ({
      name: row.name,
      displayName: row.displayName,
      sortKey: row.sort_name,
      bookCount: row.book_count,
      initialScore: scoreAuthorInitialMatch(row.sort_name || '', pattern)
    }))
    .filter((row) => row.initialScore >= 1000)
    .sort((a, b) => {
      if (b.initialScore !== a.initialScore) return b.initialScore - a.initialScore;
      const countCmp = (b.bookCount || 0) - (a.bookCount || 0);
      if (countCmp) return countCmp;
      return String(a.sortKey || '').localeCompare(String(b.sortKey || ''), 'ru');
    });
}

const AUTHOR_NAME_PARTICLES = new Set([
  'de', 'da', 'di', 'du', 'del', 'della', 'van', 'von', 'der', 'den', 'le', 'la', 'las', 'los', 'y', 'e',
  'де', 'да', 'ди', 'дель', 'ван', 'фон', 'тер', 'ten', 'op'
]);

function authorQueryTokensForSubset(value = '') {
  return createSortKey(value).split(/\s+/).filter((token) => {
    if (AUTHOR_NAME_PARTICLES.has(token)) return true;
    return token.length >= 2;
  });
}

function scoreAuthorTokenSubsetMatch(sortName, queryTokens) {
  if (!queryTokens?.length || queryTokens.length < 2) return -1;
  const key = createSortKey(sortName);
  if (!key) return -1;

  const padded = ` ${key} `;
  if (!queryTokens.every((token) => padded.includes(` ${token} `))) return -1;

  const queryPhrase = queryTokens.join(' ');
  let score = queryTokens.length * 100;
  if (key.endsWith(queryPhrase)) score += 500;
  else if (padded.includes(` ${queryPhrase} `)) score += 300;
  score -= Math.max(0, key.split(/\s+/).filter(Boolean).length - queryTokens.length) * 10;
  return score;
}

function getAuthorsByTokenSubsetStmt(tokenCount) {
  if (!_authorsByTokenSubsetStmtCache.has(tokenCount)) {
    const clauses = Array.from(
      { length: tokenCount },
      () => `(' ' || COALESCE(sort_name, '') || ' ') LIKE ?`
    );
    _authorsByTokenSubsetStmtCache.set(tokenCount, db.prepare(`
      SELECT name, COALESCE(display_name, name) AS displayName, sort_name, book_count
      FROM authors
      WHERE ${clauses.join(' AND ')} AND book_count > 0
      ORDER BY book_count DESC
      LIMIT 48
    `));
  }
  return _authorsByTokenSubsetStmtCache.get(tokenCount);
}

function findAuthorsMatchingTokenSubset(value = '', { requireBooks = true } = {}) {
  if (parseAuthorInitialPattern(value)) return [];

  const tokens = authorQueryTokensForSubset(value);
  if (tokens.length < 2) return [];

  const rows = getAuthorsByTokenSubsetStmt(tokens.length).all(
    ...tokens.map((token) => `% ${token}%`)
  );

  return rows
    .map((row) => ({
      name: row.name,
      displayName: row.displayName,
      sortKey: row.sort_name,
      bookCount: row.book_count,
      subsetScore: scoreAuthorTokenSubsetMatch(row.sort_name || '', tokens)
    }))
    .filter((row) => row.subsetScore > 0)
    .filter((row) => !requireBooks || row.bookCount > 0)
    .sort((a, b) => {
      if (b.subsetScore !== a.subsetScore) return b.subsetScore - a.subsetScore;
      const countCmp = (b.bookCount || 0) - (a.bookCount || 0);
      if (countCmp) return countCmp;
      return String(a.sortKey || '').localeCompare(String(b.sortKey || ''), 'ru');
    });
}

function paginateAuthorSearchMatches(matched, { offset, pageSize, sort, order, letterNorm, scoreKey }) {
  let rows = collapsePreferredAuthorRows(matched);
  if (letterNorm) {
    rows = rows.filter((row) => String(row.sortKey || '').startsWith(letterNorm));
  }
  rows.sort((a, b) => {
    if (sort === 'count') {
      const countCmp = (Number(a.bookCount) || 0) - (Number(b.bookCount) || 0);
      const directed = order === 'asc' ? countCmp : -countCmp;
      if (directed !== 0) return directed;
    } else {
      const scoreA = scoreKey ? (a[scoreKey] || 0) : 0;
      const scoreB = scoreKey ? (b[scoreKey] || 0) : 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
    }
    const nameCmp = String(a.sortKey || '').localeCompare(String(b.sortKey || ''), 'ru');
    return order === 'desc' && sort !== 'count' ? -nameCmp : nameCmp;
  });
  return {
    total: rows.length,
    items: rows.slice(offset, offset + pageSize).map(({ name, displayName, sortKey, bookCount }) => ({
      name,
      displayName: formatSingleAuthorName(displayName || name) || displayName,
      sortKey,
      bookCount
    }))
  };
}

function buildAuthorWhereFromMatchedNames(names = []) {
  if (!names.length) return null;
  const placeholders = names.map(() => '?').join(', ');
  const rankCases = names.map(() => 'WHEN a2.name = ? THEN 1').join(' ');
  return {
    where: `EXISTS (
      SELECT 1 FROM book_authors ba2
      JOIN authors a2 ON a2.id = ba2.author_id
      WHERE ba2.book_id = active_books.id
        AND a2.name IN (${placeholders})
    )`,
    params: names,
    authorRankSQL: `(SELECT MIN(CASE ${rankCases} ELSE 5 END) FROM book_authors ba2 JOIN authors a2 ON a2.id = ba2.author_id WHERE ba2.book_id = active_books.id)`,
    authorRankParams: names
  };
}

function findAuthorNamesForBookSearch(query = '') {
  const initialPattern = parseAuthorInitialPattern(query);
  if (initialPattern) {
    const names = findAuthorsMatchingInitialPattern(initialPattern).map((row) => row.name);
    if (names.length) return names;
  }
  if (authorQueryTokensForSubset(query).length >= 2) {
    const names = findAuthorsMatchingTokenSubset(query, { requireBooks: false }).map((row) => row.name);
    if (names.length) return names;
  }
  return [];
}

/** Next string after `prefix` in code-point order, so `col >= prefix AND col < upper` is a prefix range. */
function textPrefixUpperBound(prefix = '') {
  const chars = Array.from(String(prefix || ''));
  if (!chars.length) return '';
  const last = chars.pop();
  const next = last.codePointAt(0) + 1;
  if (next > 0x10FFFF) return '';
  return chars.join('') + String.fromCodePoint(next);
}

function authorColumnPrefixClause(column, word) {
  const upper = textPrefixUpperBound(word);
  if (!upper) return { sql: `${column} >= ?`, params: [word] };
  return { sql: `${column} >= ? AND ${column} < ?`, params: [word, upper] };
}

/** Authors whose sort_name first token equals the given surname token. */
function findAuthorsBySurnameToken(token = '') {
  const key = String(token || '').trim();
  if (!key) return [];
  /* «фамилия» или «фамилия …» — диапазон по idx_authors_sort_name, без SUBSTR по всей таблице. */
  const spaced = `${key} `;
  const upper = textPrefixUpperBound(spaced);
  const rangeSql = upper ? `OR (sort_name >= ? AND sort_name < ?)` : `OR sort_name >= ?`;
  const rangeParams = upper ? [spaced, upper] : [spaced];
  return db.prepare(`
    SELECT name, COALESCE(display_name, name) AS displayName, sort_name, book_count
    FROM authors
    WHERE book_count > 0
      AND (sort_name = ? ${rangeSql})
    ORDER BY book_count DESC
    LIMIT 24
  `).all(key, ...rangeParams);
}

function matchAuthorsFromQueryTokens(authorTokens = []) {
  if (!authorTokens.length) return [];
  if (authorTokens.length >= 2) {
    return findAuthorsMatchingTokenSubset(authorTokens.join(' '), { requireBooks: true });
  }
  return findAuthorsBySurnameToken(authorTokens[0]);
}

/** True if series_catalog has at least one hit for the series-name query. */
function seriesCatalogMatchesQuery(seriesQuery = '') {
  const search = buildCatalogSearchSql('search_name', seriesQuery);
  if (!search) return false;
  const row = db.prepare(`
    SELECT 1 AS ok FROM series_catalog
    WHERE (${search.where}) AND book_count > 0
    LIMIT 1
  `).get(...search.params);
  return Boolean(row);
}

/**
 * Split multi-token series query into author + series-name remainder(s).
 * Tries author as prefix and as suffix. Keeps only splits where both the author
 * exists and the series-name part matches a known series (so "ник ясинский"
 * is not stuck on a false author prefix "ник").
 * @returns {{ authorNames: string[], seriesQuery: string, authorLen: number }[]}
 */
function resolveAuthorSeriesQuerySplits(tokens = []) {
  if (!Array.isArray(tokens) || tokens.length < 2) return [];

  const trySplit = (authorTokens, seriesTokens) => {
    if (!authorTokens.length || !seriesTokens.length) return null;
    const matched = matchAuthorsFromQueryTokens(authorTokens);
    if (!matched.length) return null;
    const seriesQuery = seriesTokens.join(' ');
    if (!seriesCatalogMatchesQuery(seriesQuery)) return null;
    return {
      authorNames: matched.slice(0, 12).map((row) => row.name).filter(Boolean),
      seriesQuery,
      authorLen: authorTokens.length
    };
  };

  const seen = new Set();
  const splits = [];
  const pushSplit = (split) => {
    if (!split?.authorNames?.length) return;
    const key = `${split.seriesQuery}\0${split.authorNames.join('|')}`;
    if (seen.has(key)) return;
    seen.add(key);
    splits.push(split);
  };

  for (let authorLen = tokens.length - 1; authorLen >= 1; authorLen -= 1) {
    pushSplit(trySplit(tokens.slice(0, authorLen), tokens.slice(authorLen)));
  }
  for (let authorLen = tokens.length - 1; authorLen >= 1; authorLen -= 1) {
    pushSplit(trySplit(
      tokens.slice(tokens.length - authorLen),
      tokens.slice(0, tokens.length - authorLen)
    ));
  }

  splits.sort((a, b) => b.authorLen - a.authorLen);
  return splits;
}

let _stmtPreferredAuthorAlias = null;
let _stmtAuthorAliasBookCount = null;
/** Same search_name, more books — Flibusta often has a weak Cyrillic duplicate and a linked INPX row. */
function preferredAuthorAlias(name) {
  const found = String(name || '').trim();
  if (!found) return found;
  _stmtPreferredAuthorAlias ??= db.prepare(`
    SELECT a2.name AS name
    FROM authors a
    JOIN authors a2 ON (
      (a.search_name IS NOT NULL AND TRIM(a.search_name) != '' AND a2.search_name = a.search_name)
      OR (a.sort_name IS NOT NULL AND TRIM(a.sort_name) != '' AND a2.sort_name = a.sort_name)
    )
    WHERE a.name = ?
      AND a2.book_count > 0
    ORDER BY a2.book_count DESC, length(a2.name) DESC
    LIMIT 1
  `);
  return _stmtPreferredAuthorAlias.get(found)?.name || found;
}

/** This author or aliases sharing a non-empty search_name. One bound `?` = authors.name */
function authorAliasMatchSql(table = 'a') {
  return `${table}.id IN (
    SELECT a_alias.id
    FROM authors a_key
    JOIN authors a_alias ON (
      a_alias.id = a_key.id
      OR (
        a_key.search_name IS NOT NULL AND TRIM(a_key.search_name) != ''
        AND a_alias.search_name = a_key.search_name
      )
      OR (
        a_key.sort_name IS NOT NULL AND TRIM(a_key.sort_name) != ''
        AND a_alias.sort_name = a_key.sort_name
      )
    )
    WHERE a_key.name = ?
  )`;
}

/** Keep one row per search_name — the alias with more books (same order as preferredAuthorAlias). */
function preferredAuthorRowSql(table = 'a') {
  /* Сортирующий подзапрос нужен только у ~1% авторов с алиасами (одинаковый search_name);
     для остальных достаточно одного probe по idx_authors_search_name — иначе листание
     180k авторов стоило ~0.4 с на страницу (book_count > 0 гарантирует caller). */
  return `(
    ${table}.search_name IS NULL OR TRIM(${table}.search_name) = ''
    OR NOT EXISTS (
      SELECT 1 FROM authors a_other
      WHERE a_other.search_name = ${table}.search_name
        AND a_other.id != ${table}.id
        AND a_other.book_count > 0
    )
    OR ${table}.name = (
      SELECT a_pref.name
      FROM authors a_pref
      WHERE a_pref.book_count > 0
        AND (
          a_pref.id = ${table}.id
          OR a_pref.search_name = ${table}.search_name
        )
      ORDER BY a_pref.book_count DESC, length(a_pref.name) DESC
      LIMIT 1
    )
  )`;
}

function authorAliasBookCountSql(table = 'a') {
  return `CASE
    WHEN ${table}.search_name IS NOT NULL AND TRIM(${table}.search_name) != ''
    THEN COALESCE((
      SELECT SUM(a_sum.book_count) FROM authors a_sum
      WHERE a_sum.search_name = ${table}.search_name AND a_sum.book_count > 0
    ), 0)
    ELSE ${table}.book_count
  END`;
}

function collapsePreferredAuthorRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const canon = preferredAuthorAlias(row.name);
    const existing = groups.get(canon);
    if (!existing) {
      groups.set(canon, { ...row, name: canon, bookCount: row.bookCount || 0 });
      continue;
    }
    existing.bookCount += row.bookCount || 0;
    if (row.name === canon) {
      existing.displayName = row.displayName;
      existing.sortKey = row.sortKey;
    }
  }
  return [...groups.values()];
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
    const author = _authorByName.get(candidate.toLowerCase());
    if (author?.name) {
      return preferredAuthorAlias(author.name);
    }
  }

  for (const candidate of candidates) {
    const displayMatch = _authorByDisplaySearch.get(
      authorDisplayName(candidate),
      authorSearchName(candidate),
      createSortKey(authorSortKey(candidate))
    );
    if (displayMatch?.name) {
      return preferredAuthorAlias(displayMatch.name);
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

function createIndexDiagnostics() {
  return {
    totalLines: 0,
    parsedRows: 0,
    importedRows: 0,
    deletedRows: 0,
    purgedRows: 0,
    parseSkipped: 0,
    suppressedRows: 0,
    collisionScopedRows: 0,
    legacyRows: 0,
    longLineSkipped: 0,
    oversizedInpSkipped: 0,
    readErrors: 0
  };
}

function addIndexDiagnostics(target, delta) {
  if (!target || !delta) return target;
  for (const [key, value] of Object.entries(delta)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    target[key] = (target[key] || 0) + value;
  }
  return target;
}

export function parseLine(line, archiveName, sourceId = null, fieldMap = null) {
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
  const libRate = g('libRate');
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
  const id = buildScopedBookId({
    rawId,
    sourceId,
    archiveName: effectiveArchive,
    fileName,
    ext
  });

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
    libRate: Number(libRate || 0) || 0,
    keywords
  };
}

export function getIndexStatus() {
  const indexedAt = getMeta('indexed_at');
  let ftsStatus = null;
  try {
    ftsStatus = getBooksFtsStatus({ recover: false });
  } catch {
    ftsStatus = null;
  }

  /* Локальная индексация — полный прогресс */
  if (indexState.active) {
    return { ...indexState, ready: indexState.ready, indexedAt, ftsStatus };
  }

  /* Другой воркер кластера индексирует — прогресс из meta */
  if (isClusterIndexActive()) {
    const p = readClusterIndexProgress();
      return {
        active: true,
        ready: false,
        startedAt: p.startedAt || null,
        finishedAt: null,
        processedArchives: p.processedArchives || 0,
        totalArchives: p.totalArchives || 0,
        importedBooks: p.importedBooks || 0,
        uniqueBooks: p.uniqueBooks || 0,
        newBooksCount: p.newBooksCount || 0,
        currentArchive: p.currentArchive || '',
        currentStage: p.currentStage || null,
        error: '',
        pauseRequested: getMeta('index_pause_requested') === '1',
        paused: p.paused || false,
        cancelRequested: getMeta('index_cancel_requested') === '1',
        mode: p.mode || '',
        sourceId: p.sourceId ?? null,
        indexedAt,
        ftsStatus
      };

  }

  /* Не индексируется нигде */
  const catalogIndexedOnce = Boolean(indexedAt) && !indexState.error;
  const ready = indexState.ready || catalogIndexedOnce;

  const out = { ...indexState, ready, indexedAt, ftsStatus };

  /* Парсим потенциально крупный inp_sizes только в legacy-ветке (нет прогресса
     из indexState), а не на каждом рендере страницы. */
  if (indexState.processedArchives === 0 && indexState.totalArchives === 0) {
    let legacyInpArchiveCount = 0;
    try {
      legacyInpArchiveCount = Object.keys(JSON.parse(getMeta('inp_sizes') || '{}')).length;
    } catch {}
    if (legacyInpArchiveCount > 0) {
      out.totalArchives = legacyInpArchiveCount;
      out.processedArchives = legacyInpArchiveCount;
    }
  }

  return out;
}

export function startBackgroundIndexing(force = false, incremental = true) {
  if (indexState.active) {
    console.warn('[index] reindex skipped: already running (wait for completion or restart server)');
    logSystemEvent('warn', 'index', 'global reindex skipped: already running', {});
    return false;
  }
  if (!tryClaimClusterIndexLock()) {
    console.warn('[index] reindex skipped: another cluster worker is indexing');
    logSystemEvent('warn', 'index', 'reindex skipped: another cluster worker is indexing', {});
    return false;
  }

  indexState.active = true;
  indexState.error = '';
  indexState.startedAt = new Date().toISOString();
  indexState.finishedAt = null;
  indexState.newBooksCount = 0;
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
      try {
        indexState.ready = true;
        indexState.active = false;
        indexState.finishedAt = new Date().toISOString();
        persistIndexNewBooksCount();
        emitIndexCompleted();
        clearClusterIndexState();
        await refreshCatalogBookCounts();
        invalidateAllRecommendations();
        resetIndexControlState();
      } catch (err) {
        indexState.active = false;
        indexState.ready = false;
        indexState.error = err.message;
        indexState.finishedAt = new Date().toISOString();
        persistIndexNewBooksCount();
        clearClusterIndexState();
        resetIndexControlState();
        logSystemEvent('error', 'index', 'global index post-processing failed', { error: err.message });
        console.error(err);
      }
    })
    .catch((error) => {
      indexState.active = false;
      clearClusterIndexState();
      if (isIndexCancelledError(error)) {
        indexState.error = '';
        logSystemEvent('warn', 'index', 'global index stopped by user', {});
      } else {
        indexState.ready = false;
        indexState.error = error.message;
        logSystemEvent('error', 'index', 'global index failed', { error: error.message });
      }
      indexState.finishedAt = new Date().toISOString();
      persistIndexNewBooksCount();
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
  if (!tryClaimClusterIndexLock()) {
    console.warn('[index] source reindex skipped: another cluster worker is indexing');
    logSystemEvent('warn', 'index', 'source reindex skipped: another cluster worker is indexing', { sourceId });
    return false;
  }

  indexState.active = true;
  indexState.error = '';
  indexState.startedAt = new Date().toISOString();
  indexState.finishedAt = null;
  indexState.newBooksCount = 0;
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
      try {
        assignIndexStage('index.stage.catalogFull');
        writeClusterIndexProgress();
        const tCat = Date.now();
        await refreshCatalogBookCounts();
        const catSec = ((Date.now() - tCat) / 1000).toFixed(1);
        if (Number(catSec) > 3) {
          console.log(`[index] catalog book_count refresh done in ${catSec} s`);
        }
        indexState.ready = true;
        indexState.active = false;
        indexState.finishedAt = new Date().toISOString();
        clearIndexStageDisplay();
        persistIndexNewBooksCount();
        emitIndexCompleted();
        clearClusterIndexState();
        invalidateAllRecommendations();
        resetIndexControlState();
      } catch (err) {
        indexState.active = false;
        indexState.ready = false;
        indexState.error = err.message;
        indexState.finishedAt = new Date().toISOString();
        persistIndexNewBooksCount();
        clearClusterIndexState();
        resetIndexControlState();
        logSystemEvent('error', 'index', 'single source index post-processing failed', {
          sourceId, name: srcRow?.name || '', error: err.message
        });
        console.error(err);
      }
    })
    .catch((error) => {
      indexState.active = false;
      clearClusterIndexState();
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
      persistIndexNewBooksCount();
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

  // Backup database before force reindex (destructive operation)
  if (force) {
    try {
      await createDatabaseBackup('force-reindex');
    } catch (err) {
      console.warn('[inpx] Pre-reindex backup failed (proceeding anyway):', err.message);
    }
  }

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

  const currentMtime = String((await fs.promises.stat(inpxPath)).mtimeMs);
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

/** Fingerprint for incremental .inp change detection (size + zip metadata). */
export function inpEntryFingerprint(entry) {
  const u = Number(entry?.uncompressedSize) || 0;
  const c = Number(entry?.compressedSize) || 0;
  const crc = Number(entry?.crc32);
  return {
    u,
    c,
    crc: Number.isFinite(crc) ? crc : 0
  };
}

export function inpEntryChanged(entry, previous) {
  if (previous === undefined || previous === null) return true;
  if (typeof previous === 'number') {
    return previous !== (Number(entry?.uncompressedSize) || 0);
  }
  const fp = inpEntryFingerprint(entry);
  return previous.u !== fp.u || previous.c !== fp.c || previous.crc !== fp.crc;
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
    ? inpEntries.filter((entry) => inpEntryChanged(entry, previousSizes[entry.path]))
    : inpEntries;

  const skippedCount = inpEntries.length - entriesToProcess.length;

  const { ftsBulkMode, useFastSqlite, incrementalBulk } = resolveIndexImportMode({
    incremental,
    toProcess: entriesToProcess.length,
    total: inpEntries.length
  });
  let completedSuccessfully = false;

  if (entriesToProcess.length > 0) {
    console.log(
      `[index] INPX import plan: process=${entriesToProcess.length}/${inpEntries.length} skipped=${skippedCount} ftsBulk=${ftsBulkMode} fastSqlite=${useFastSqlite}`
    );
  }

  try {
  beginExclusiveOperation('indexing');
  if (useFastSqlite) {
    beginFastSqliteImport();
  }
  if (ftsBulkMode) {
    setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
    invalidateBooksFtsHealthCache();
    dropBooksFtsTriggers();
    dropBulkImportIndexes();
  }
  if (!incremental) {
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
    db.exec('VACUUM');
    await yieldEventLoop();
  }

  indexState.totalArchives = inpEntries.length;
  indexState.processedArchives = skippedCount;
  indexState.importedBooks = 0;
  indexState.uniqueBooks = 0;
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
    incrementalBulk,
    useFastSqlite,
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
  const linkSeries = db.prepare('INSERT OR IGNORE INTO book_series(book_id, series_id, series_no) VALUES(?, ?, ?)');
  const linkGenre = db.prepare('INSERT OR IGNORE INTO book_genres(book_id, genre_id) VALUES(?, ?)');
  const unlinkAuthors = db.prepare('DELETE FROM book_authors WHERE book_id = ?');
  const unlinkSeries = db.prepare('DELETE FROM book_series WHERE book_id = ?');
  const unlinkGenres = db.prepare('DELETE FROM book_genres WHERE book_id = ?');
  const deleteBookDetailsCache = db.prepare('DELETE FROM book_details_cache WHERE book_id = ?');
  const deleteBookById = sourceId != null && sourceId !== ''
    ? db.prepare('DELETE FROM books WHERE id = ? AND source_id = ?')
    : db.prepare('DELETE FROM books WHERE id = ?');
  const suppressedIds = getSuppressedBookIds();
  const legacyIdCollisions = new Set();
  const legacyIdOwners = new Map();
  const diagnosticsTotal = createIndexDiagnostics();
  const seenUniqueBookIds = new Set();
  const existingBookIds = new Set();
  if (incremental) {
    const loadExisting = sourceId != null && sourceId !== ''
      ? db.prepare('SELECT id FROM books WHERE source_id = ?')
      : db.prepare('SELECT id FROM books');
    const rows = sourceId != null && sourceId !== ''
      ? loadExisting.iterate(sourceId)
      : loadExisting.iterate();
    for (const row of rows) existingBookIds.add(row.id);
  }
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      @id, @title, @authors, @genres, @series, @seriesNo, @titleSort, @authorSort,
      @seriesSort, @seriesIndex, @titleSearch, @authorsSearch, @seriesSearch,
      @genresSearch, @keywordsSearch, @fileName, @archiveName, @size, @libId, @deleted,
      @ext, @date, @lang, @keywords, @libRate, @sourceId
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
      lib_rate = excluded.lib_rate,
      source_id = excluded.source_id
      /* imported_at: only on INSERT (DEFAULT) — never refresh on reindex/update */
  `);

  const newSizes = incremental ? { ...previousSizes } : {};
  const archiveRoot = sourceId ? getSourceRoot(sourceId) : getLibraryRoot();

  function listBookIdsForArchive(archiveName) {
    const sel = sourceId != null && sourceId !== ''
      ? db.prepare('SELECT id FROM books WHERE archive_name = ? AND source_id = ?')
      : db.prepare('SELECT id FROM books WHERE archive_name = ?');
    const rows = sourceId != null && sourceId !== ''
      ? sel.all(archiveName, sourceId)
      : sel.all(archiveName);
    return rows.map((row) => row.id);
  }

  function purgeInpxBook(bookId, diagnostics) {
    if (!bookId) return;
    deleteBookDetailsCache.run(bookId);
    unlinkAuthors.run(bookId);
    unlinkSeries.run(bookId);
    unlinkGenres.run(bookId);
    if (sourceId != null && sourceId !== '') deleteBookById.run(bookId, sourceId);
    else deleteBookById.run(bookId);
    existingBookIds.delete(bookId);
    seenUniqueBookIds.delete(bookId);
    diagnostics.purgedRows = (diagnostics.purgedRows || 0) + 1;
  }

  function purgeAllBooksInArchive(archiveName, diagnostics) {
    for (const id of listBookIdsForArchive(archiveName)) {
      purgeInpxBook(id, diagnostics);
    }
  }

  function reconcileArchiveOrphans(archiveName, seenIds, diagnostics) {
    if (!incremental) return;
    for (const id of listBookIdsForArchive(archiveName)) {
      if (!seenIds.has(id)) purgeInpxBook(id, diagnostics);
    }
  }

  if (incremental) {
    const currentPaths = new Set(inpEntries.map((entry) => entry.path));
    for (const oldPath of Object.keys(previousSizes)) {
      if (!currentPaths.has(oldPath)) {
        delete newSizes[oldPath];
        const removedArchive = resolveArchiveNameForInp(archiveRoot, oldPath);
        purgeAllBooksInArchive(removedArchive, diagnosticsTotal);
        console.log(`[index] INPX incremental: removed .inp ${oldPath} → purged ${removedArchive}`);
      }
    }
  }

  function inpxImportChunkTarget() {
    return 500;
  }
  const importChunkSize = inpxImportChunkTarget();
  const DIARY_CHUNK_LOG_EVERY = 20;
  const authorIdCache = new Map();
  const seriesIdCache = new Map();
  const genreIdCache = new Map();

  function resolveAuthorId(name) {
    let id = authorIdCache.get(name);
    if (id !== undefined) return id;
    const key = name.toLowerCase();
    insertAuthor.run(key, authorDisplayName(name), createSortKey(authorSortKey(name)), authorSearchName(name));
    id = selectAuthor.get(key)?.id || null;
    authorIdCache.set(name, id);
    return id;
  }

  function resolveSeriesId(name) {
    let id = seriesIdCache.get(name);
    if (id !== undefined) return id;
    const key = name.toLowerCase();
    insertSeries.run(key, seriesDisplayName(name), seriesSortName(name), seriesSearchName(name));
    id = selectSeries.get(key)?.id || null;
    seriesIdCache.set(name, id);
    return id;
  }

  function resolveGenreId(name) {
    let id = genreIdCache.get(name);
    if (id !== undefined) return id;
    const key = name.toLowerCase();
    insertGenre.run(key, genreDisplayName(name), genreSortName(name), genreSearchName(name));
    id = selectGenre.get(key)?.id || null;
    genreIdCache.set(name, id);
    return id;
  }

  const archiveSeenIds = new Set();

  function resolveInpxRowBookId(row, diagnostics, { respectSuppression = true } = {}) {
    const legacyId = sourceId != null && sourceId !== ''
      ? `${Number(sourceId)}:${String(row.libId || row.fileName || '').trim()}`
      : row.id;
    const rowSignature = `${String(row.archiveName || '')}\u0000${String(row.fileName || '')}\u0000${String(row.ext || '').toLowerCase()}`;
    const knownOwner = legacyIdOwners.get(legacyId);
    let usesScopedId = false;
    if (legacyIdCollisions.has(legacyId)) {
      usesScopedId = true;
      row.id = buildScopedBookId({
        rawId: row.libId || row.fileName || '',
        sourceId,
        archiveName: row.archiveName,
        fileName: row.fileName,
        ext: row.ext
      });
    } else if (knownOwner === undefined) {
      legacyIdOwners.set(legacyId, rowSignature);
      row.id = legacyId;
    } else if (knownOwner !== rowSignature) {
      legacyIdCollisions.add(legacyId);
      usesScopedId = true;
      row.id = buildScopedBookId({
        rawId: row.libId || row.fileName || '',
        sourceId,
        archiveName: row.archiveName,
        fileName: row.fileName,
        ext: row.ext
      });
    } else {
      row.id = legacyId;
    }
    if (usesScopedId) diagnostics.collisionScopedRows += 1;
    else diagnostics.legacyRows += 1;
    if (respectSuppression && (suppressedIds.has(row.id) || suppressedIds.has(legacyId))) {
      diagnostics.suppressedRows += 1;
      return null;
    }
    return row;
  }

  const processChunk = db.transaction((batch, archiveName, diagnostics) => {
    for (const line of batch) {
      diagnostics.totalLines += 1;
      const row = enrichBookRow(parseLine(line, archiveName, sourceId, fieldMap));
      if (!row) {
        diagnostics.parseSkipped += 1;
        continue;
      }
      diagnostics.parsedRows += 1;
      /* DEL=1 из INPX: оставляем в индексе с deleted=1 (как inpx-web).
         Показ в каталоге — через настройку show_deleted_books / active_books. */
      const isDeleted = Boolean(Number(row.deleted));
      if (isDeleted) diagnostics.deletedRows += 1;
      const resolved = resolveInpxRowBookId(row, diagnostics);
      if (!resolved) continue;
      resolved.sourceId = sourceId;
      resolved.deleted = isDeleted ? 1 : 0;
      insert.run(resolved);
      if (incremental && !isDeleted && !existingBookIds.has(resolved.id)) bumpIndexNewBooks();
      if (incremental) existingBookIds.add(resolved.id);
      if (!seenUniqueBookIds.has(resolved.id)) {
        seenUniqueBookIds.add(resolved.id);
        indexState.uniqueBooks += 1;
      }
      diagnostics.importedRows += 1;
      const firstInArchive = !archiveSeenIds.has(resolved.id);
      archiveSeenIds.add(resolved.id);
      // Авторы/жанры при инкременте пересобираем при первом появлении book_id в .inp.
      // Серии не сбрасываем: несколько серий на одну книгу — через повторные строки INP
      // с тем же lib_id и разным SERIES (авторская + издательская и т.п.).
      if (incremental && firstInArchive) {
        unlinkAuthors.run(resolved.id);
        unlinkGenres.run(resolved.id);
      }
      for (const authorName of splitAuthorValues(resolved.authors)) {
        const authorId = resolveAuthorId(authorName);
        if (authorId) {
          linkAuthor.run(resolved.id, authorId);
        }
      }

      if (resolved.series) {
        const seriesId = resolveSeriesId(resolved.series);
        if (seriesId) {
          linkSeries.run(resolved.id, seriesId, resolved.seriesNo || '');
        }
      }

      for (const genreName of splitFacetValues(resolved.genres)) {
        const genreId = resolveGenreId(genreName);
        if (genreId) {
          linkGenre.run(resolved.id, genreId);
        }
      }

      indexState.importedBooks += 1;
    }
  });

  for (let ei = 0; ei < entriesToProcess.length; ei++) {
    archiveSeenIds.clear();
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
      diagnosticsTotal.oversizedInpSkipped += 1;
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
      newSizes[entry.path] = inpEntryFingerprint(entry);
      indexState.processedArchives += 1;
      continue;
    }
    const bufferMs = Math.min(600_000, 90_000 + Math.floor(uc / 30_000));
    let buffer;
    try {
      buffer = await promiseWithTimeout(entry.buffer(), bufferMs, `INPX buffer ${archiveName}`);
    } catch (err) {
      diagnosticsTotal.readErrors += 1;
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
    {
      const heapMb = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));
      const bufMb = Math.round(buffer.length / (1024 * 1024));
      if (bufMb > 10) {
        console.log(`[index] .inp декодирован: ~${bufMb} МБ, heap: ${heapMb} МБ`);
      }
      if (heapMb > HEAP_WARNING_THRESHOLD_MB) {
        const warnMsg = `Высокое потребление памяти при парсинге INPX: heap ${heapMb} МБ (порог ${HEAP_WARNING_THRESHOLD_MB} МБ)`;
        console.warn(`[index] ${warnMsg}`);
        logSystemEvent('warn', 'index', warnMsg, {
          heapMb,
          thresholdMb: HEAP_WARNING_THRESHOLD_MB,
          archive: archiveName,
          suggestion: 'Consider increasing Node.js --max-old-space-size for large libraries'
        });
      }
    }
    await yieldEventLoop();

    /** Обновлять подпись в UI чаще, чем раз в 120 чанков — иначе на одном толстом .inp кажется, что индексация «застыла» на середине. */
    const UI_LINE_PROGRESS_EVERY = 20;
    const archiveDiagnostics = createIndexDiagnostics();
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
        processChunk(batch, archiveName, archiveDiagnostics);
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
        archiveDiagnostics.longLineSkipped += 1;
        if (!warnedLongLine) {
          console.warn(
            `[index] INPX: ${archiveName}: пропуск строк длиннее ${MAX_INPX_LINE_CHARS} симв.`
          );
          warnedLongLine = true;
        }
        continue;
      }
      batch.push(line);
      if (batch.length >= importChunkSize) {
        flush();
        if (chunkSeq % UI_LINE_PROGRESS_EVERY === 0) {
          indexState.currentArchive = `${archiveName} … импорт ~${lineCount} строк (чанк ${chunkSeq}, архив ${ei + 1}/${entriesToProcess.length})`;
        }
        if (chunkSeq % 120 === 0) {
          console.log(`[index] INPX: ${archiveName} … ~${lineCount} строк (чанк импорта ${chunkSeq})`);
        }
        await yieldEventLoop();
        await checkIndexControlPoint();
      }
    }
    flush();
    addIndexDiagnostics(diagnosticsTotal, archiveDiagnostics);
    reconcileArchiveOrphans(archiveName, archiveSeenIds, diagnosticsTotal);
    indexState.currentArchive = `${archiveName} … готово ${lineCount} строк (${chunkSeq} чанков)`;
    console.log(`[index] INPX: ${archiveName} готово: ${lineCount} строк, чанков импорта ${chunkSeq}`);
    console.log(`[index] INPX diagnostics ${archiveName}: ${JSON.stringify(archiveDiagnostics)}`);
    appendIndexDiaryLine(`INPX диагностика ${archiveName}: ${JSON.stringify(archiveDiagnostics)}`);
    await yieldEventLoop();
    await checkIndexControlPoint();

    newSizes[entry.path] = inpEntryFingerprint(entry);
    if (incremental) {
      setMeta(sizesKey, JSON.stringify(newSizes));
    }
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
    incremental,
    diagnostics: diagnosticsTotal
  });
  console.log(`[index] INPX diagnostics total: ${JSON.stringify(diagnosticsTotal)}`);
  appendIndexDiaryLine(`INPX диагностика итог: ${JSON.stringify(diagnosticsTotal)}`);

  if (!incremental) {
    for (const entry of inpEntries) {
      newSizes[entry.path] = inpEntryFingerprint(entry);
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

  repairBookJunctionLinks();

  completedSuccessfully = true;
  } finally {
    if (ftsBulkMode && completedSuccessfully) {
      assignIndexStage('index.stage.ftsFull');
      indexState.phase = 'fts';
      indexState.phaseDone = 0;
      indexState.phaseTotal = 0;
      const ftsT0 = Date.now();
      console.log(
        '[index] FTS: полная пересборка полнотекстового индекса (books_fts) — при больших библиотеках может занять несколько минут…'
      );
      logSystemEvent('info', 'index', 'INPX FTS full rebuild started', { sourceId });
      try {
        await rebuildBooksFtsFromContent({
          onProgress: ({ done, total }) => {
            assignIndexStage('index.stage.ftsProgress', { done, total });
            indexState.phaseDone = done;
            indexState.phaseTotal = total;
          }
        });
        indexState.phase = '';
        indexState.phaseDone = 0;
        indexState.phaseTotal = 0;
        const ftsSec = ((Date.now() - ftsT0) / 1000).toFixed(1);
        console.log(`[index] FTS: готово за ${ftsSec} с`);
        logSystemEvent('info', 'index', 'INPX FTS full rebuild completed', { sourceId, seconds: Number(ftsSec) });
      } catch (err) {
        console.error('[index] FTS rebuild failed:', err.message);
        logSystemEvent('error', 'index', 'INPX FTS full rebuild failed', { sourceId, error: err.message });
      }
      ensureBooksFtsTriggers();
      setMeta(BOOKS_FTS_DIRTY_META_KEY, '0');
      invalidateBooksFtsHealthCache();
      clearIndexStageDisplay();
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
        invalidateBooksFtsHealthCache();
      } catch (ftsErr) {
        console.error('[index] FTS rebuild after interruption failed:', ftsErr.message);
        // Leave triggers dropped and dirty flag set — boot will rebuild
        setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
        invalidateBooksFtsHealthCache();
      }
    }
    if (ftsBulkMode) {
      indexState.phase = 'indexes';
      indexState.phaseDone = 0;
      indexState.phaseTotal = 0;
      assignIndexStage('index.stage.dbRestore');
      await ensureBulkImportIndexesAsync({
        onProgress: ({ done, total, name, phase }) => {
          assignIndexStage('index.stage.dbIndexesLine', {
            done,
            total,
            labelKey: getBulkIndexLabelKey(name),
            phaseKey: phase === 'building' ? 'index.stage.dbPhaseBuilding' : 'index.stage.dbPhaseDone'
          });
          indexState.phaseDone = done;
          indexState.phaseTotal = total;
          writeClusterIndexProgress();
        }
      });
      indexState.phase = '';
      indexState.phaseDone = 0;
      indexState.phaseTotal = 0;
      assignIndexStage('index.stage.catalogShort');
      writeClusterIndexProgress();
    }
    if (useFastSqlite) {
      endFastSqliteImport();
    }
    endExclusiveOperation('indexing');
  }
}

const SORT_NATURAL_DIR = {
  recent: 'DESC',
  title: 'ASC',
  author: 'ASC',
  series: 'ASC',
  rating: 'DESC',
  date: 'DESC',
  count: 'DESC',
  name: 'ASC'
};

function applyOrder(sql, order) {
  if (order !== 'asc' && order !== 'desc') return sql;
  const firstMatch = sql.match(/\b(ASC|DESC)\b/);
  const natural = firstMatch ? firstMatch[1] : 'ASC';
  if (natural === order.toUpperCase()) return sql;
  // Инвертируем первое вхождение ASC/DESC (основное поле сортировки)
  return sql.replace(/\bASC\b/, '#ASC#').replace(/\bDESC\b/, '#DESC#')
    .replace('#ASC#', 'DESC').replace('#DESC#', 'ASC');
}

function resolveSort(sort, order = '') {
  const sortMap = {
    recent: 'COALESCE(NULLIF(date, \'\'), imported_at) DESC, imported_at DESC, id DESC',
    title: 'title_sort ASC, title COLLATE NOCASE ASC, id DESC',
    author: 'author_sort ASC, title_sort ASC, id DESC',
    /* без CAST: series_index — числовой INTEGER-столбец, а CAST ломает idx_books_series_full (полная сортировка) */
    series: 'series_sort ASC, series_index ASC, title_sort ASC, id DESC',
    rating: 'lib_rate DESC, title_sort ASC, id DESC'
  };
  return applyOrder(sortMap[sort] || sortMap.title, order);
}

function resolveBookAliasSort(sort, alias = 'b', order = '') {
  const sortMap = {
    recent: `COALESCE(NULLIF(${alias}.date, ''), ${alias}.imported_at) DESC, ${alias}.imported_at DESC, ${alias}.id DESC`,
    title: `${alias}.title_sort ASC, ${alias}.title COLLATE NOCASE ASC, ${alias}.id DESC`,
    author: `${alias}.author_sort ASC, ${alias}.title_sort ASC, ${alias}.id DESC`,
    series: `${alias}.series_sort ASC, ${alias}.series_index ASC, ${alias}.title_sort ASC, ${alias}.id DESC`,
    rating: `${alias}.lib_rate DESC, ${alias}.title_sort ASC, ${alias}.id DESC`
  };
  return applyOrder(sortMap[sort] || sortMap.title, order);
}

// INPX «0» в номере серии означает «без номера» — не показываем «#0».
function normalizeSeriesNo(value) {
  const s = String(value ?? '').trim();
  return s === '' || /^0+(\.0+)?$/.test(s) ? '' : s;
}

function mapBookListRow(row) {
  const downloadFormats = getAvailableDownloadFormats(row).map((format) => ({
    format,
    label: FORMAT_LABELS[format] || format.toUpperCase()
  }));
  return {
    ...row,
    deleted: Number(row.deleted) ? 1 : 0,
    seriesNo: normalizeSeriesNo(row.seriesNo),
    genresList: splitFacetValues(row.genres),
    genresDisplayList: formatGenreList(row.genres),
    authorsList: splitAuthorValues(row.authors),
    downloadFormats
  };
}

function attachSeriesListsToBooks(books) {
  if (!books || books.length === 0) return;
  const placeholders = books.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT bs.book_id AS bookId, sc.name, COALESCE(sc.display_name, sc.name) AS displayName, bs.series_no AS seriesNo
    FROM book_series bs
    JOIN series_catalog sc ON sc.id = bs.series_id
    WHERE bs.book_id IN (${placeholders})
    ORDER BY sc.sort_name ASC
  `).all(...books.map((b) => b.id));
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.bookId)) map.set(r.bookId, []);
    map.get(r.bookId).push({ name: r.name, displayName: r.displayName, seriesNo: normalizeSeriesNo(r.seriesNo) });
  }
  const sameSeries = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  for (const b of books) {
    b.seriesList = map.get(b.id) || [];
    // books.series и series_catalog могут расходиться регистром/пробелами — иначе серия дублируется в UI.
    if (b.series && !b.seriesList.some((s) => sameSeries(s.name, b.series) || sameSeries(s.displayName, b.series))) {
      b.seriesList.push({ name: b.series, displayName: b.series, seriesNo: normalizeSeriesNo(b.seriesNo) });
    }
    if (!b.series && b.seriesList.length > 0) {
      b.series = b.seriesList[0].name;
      b.seriesNo = b.seriesList[0].seriesNo;
    }
  }
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
  if (field === 'authors' && findAuthorNamesForBookSearch(parsed.value || query).length) {
    return null;
  }

  const needleNormalized = normalizeYo(normalizeText(parsed.value)).toLowerCase();
  const needleSortKey = createSortKey(parsed.value);
  const tokenSource = parsed.operator === '='
    ? [needleNormalized || needleSortKey]
    : createSortKey(parsed.value).split(/\s+/).filter(Boolean);
  const rawTokens = tokenSource.filter(Boolean);
  /* Drop stopwords / 1–2 letter tokens from multi-word LIKE AND (keeps phrase via full needle ranks). */
  const tokens = parsed.operator === '=' || rawTokens.length <= 1
    ? rawTokens
    : filterSearchContentTokens(rawTokens);
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

    /*
     * Default = prefix for a single token (index-friendly, matches OPDS help).
     * Multi-token queries must use contains: prefix-per-token cannot match
     * mid-title words ("Пешком над облаками" → "над%" never hits title_search),
     * and that breaks the FTS-empty → LIKE fallback path.
     */
    const param = tokens.length === 1 ? `${value}%` : `%${value}%`;
    return { sql: `LOWER(COALESCE(${column}, '')) LIKE ?`, param };
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

/** Normalize genre query: CSV string, repeated values, or array → unique non-empty codes. */
export function parseGenreList(genre = '') {
  const raw = Array.isArray(genre) ? genre : [genre];
  const parts = [];
  for (const item of raw) {
    const s = String(item || '');
    for (const piece of s.split(',')) {
      const code = normalizeText(piece);
      if (code) parts.push(code);
    }
  }
  return [...new Set(parts)];
}

function buildGenreFilterSql(genre = '') {
  const genres = parseGenreList(genre);
  if (!genres.length) return null;

  // OR: book matches if it has at least one of the selected genres
  const placeholders = genres.map(() => '?').join(',');
  return {
    where: `EXISTS (
      SELECT 1
      FROM book_genres bg
      JOIN genres_catalog g ON g.id = bg.genre_id
      WHERE bg.book_id = active_books.id AND g.name IN (${placeholders})
    )`,
    params: genres
  };
}

function buildLanguageFilterSql(lang = '') {
  if (!lang || lang.length < 2) return null;
  return { where: `active_books.lang = ?`, params: [lang.toLowerCase()] };
}

function buildFormatFilterSql(format = '') {
  if (!format) return null;
  return { where: `LOWER(active_books.ext) = ?`, params: [format.toLowerCase()] };
}

function buildYearFilterSql(year = 0) {
  const y = Number(year);
  if (!y || y < 1800 || y > 2100) return null;
  return { where: `CAST(SUBSTR(active_books.date, 1, 4) AS INTEGER) = ?`, params: [y] };
}

function buildMinRateFilterSql(minRate = 0) {
  const rate = Math.floor(Number(minRate) || 0);
  if (rate < 1 || rate > 5) return null;
  return { where: `COALESCE(active_books.lib_rate, 0) >= ?`, params: [rate] };
}

/** Parse hasSeries query: 1/true = in a series, 0/false = standalone, else no filter. */
export function parseHasSeries(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return 1;
  if (s === '0' || s === 'false' || s === 'no') return 0;
  return null;
}

function buildHasSeriesFilterSql(hasSeries = null) {
  const flag = hasSeries === 0 || hasSeries === 1 ? hasSeries : parseHasSeries(hasSeries);
  if (flag !== 0 && flag !== 1) return null;
  const exists = `EXISTS (
      SELECT 1 FROM book_series bs WHERE bs.book_id = active_books.id
    )`;
  return {
    where: flag === 1 ? exists : `NOT ${exists}`,
    params: []
  };
}

/** Collect AND-able catalog filters (lang/format/year/minRate/hasSeries). Genre is separate. */
function buildCatalogExtraFilters({ lang = '', format = '', year = 0, minRate = 0, hasSeries = null } = {}) {
  return [
    buildLanguageFilterSql(lang),
    buildFormatFilterSql(format),
    buildYearFilterSql(year),
    buildMinRateFilterSql(minRate),
    buildHasSeriesFilterSql(hasSeries)
  ].filter(Boolean);
}

const DISTINCT_CACHE_TTL = 60_000; // 60 seconds
const DISTINCT_LANGS_META = 'catalog_distinct_langs';
const DISTINCT_EXTS_META = 'catalog_distinct_exts';

function readDistinctMeta(key) {
  const raw = getMeta(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

let _stmtDistinctLangs = null;
let _distinctLangsCache = null;
let _distinctLangsCacheTime = 0;

export function getDistinctLanguages() {
  const now = Date.now();
  if (_distinctLangsCache && now - _distinctLangsCacheTime < DISTINCT_CACHE_TTL) {
    return _distinctLangsCache;
  }
  const persisted = readDistinctMeta(DISTINCT_LANGS_META);
  if (persisted) {
    _distinctLangsCache = persisted;
    _distinctLangsCacheTime = now;
    return persisted;
  }
  /* Без deleted = 0 планировщик берёт idx_books_lang. Фильтр по deleted
     заставлял читать всю таблицу books (~5–7 с на NAS при холодном кэше). */
  _stmtDistinctLangs ??= db.prepare(`SELECT DISTINCT lang FROM books WHERE lang != '' ORDER BY lang`);
  const langs = _stmtDistinctLangs.all().map((row) => row.lang);
  setMeta(DISTINCT_LANGS_META, JSON.stringify(langs));
  _distinctLangsCache = langs;
  _distinctLangsCacheTime = now;
  return langs;
}

let _stmtDistinctFormats = null;
let _distinctFormatsCache = null;
let _distinctFormatsCacheTime = 0;

export function getDistinctFormats() {
  const now = Date.now();
  if (_distinctFormatsCache && now - _distinctFormatsCacheTime < DISTINCT_CACHE_TTL) {
    return _distinctFormatsCache;
  }
  const persisted = readDistinctMeta(DISTINCT_EXTS_META);
  if (persisted) {
    _distinctFormatsCache = persisted;
    _distinctFormatsCacheTime = now;
    return persisted;
  }
  _stmtDistinctFormats ??= db.prepare(`SELECT DISTINCT ext FROM books WHERE ext != '' ORDER BY ext`);
  const exts = _stmtDistinctFormats.all().map((row) => row.ext);
  setMeta(DISTINCT_EXTS_META, JSON.stringify(exts));
  _distinctFormatsCache = exts;
  _distinctFormatsCacheTime = now;
  return exts;
}

function buildAuthorWhereForBooks(query) {
  const parsed = parseSearchOperator(query);
  const queryValue = parsed.value || query;
  const matchedNames = findAuthorNamesForBookSearch(queryValue);
  if (matchedNames.length) {
    return buildAuthorWhereFromMatchedNames(matchedNames);
  }

  const needleKey = createSortKey(queryValue);
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
    const clauses = tokens.map(() => `(' ' || COALESCE(a2.search_name, '') || ' ') LIKE ?`);
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

/** Escape a token for FTS5 quoted phrase / prefix query. */
function escapeFts5Token(token = '') {
  return String(token || '').replace(/"/g, '').trim();
}

/** Query-time lookalike fix; preserves leading search operators. */
function prepareSearchQueryInput(query = '') {
  const parsed = parseSearchOperator(query);
  if (parsed.operator === 'empty') return String(query || '');
  const fixed = normalizeLookalikeSortKey(createSortKey(parsed.value || ''));
  if (!fixed) return String(query || '').trim();
  if (parsed.operator === 'prefix') return fixed;
  return `${parsed.operator}${fixed}`;
}

/**
 * Split "Author Title Words" into author names + title remainder when confident.
 * @returns {{ authorNames: string[], titleQuery: string, fullNeedle: string } | null}
 */
function resolveAuthorTitleSplit(query = '') {
  const parsed = parseSearchOperator(query);
  if (parsed.operator !== 'prefix') return null;
  const fullNeedle = normalizeLookalikeSortKey(createSortKey(parsed.value || query));
  const tokens = fullNeedle.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  for (let i = 1; i < tokens.length; i += 1) {
    const authorPart = tokens.slice(0, i).join(' ');
    const titleQuery = tokens.slice(i).join(' ');
    if (!titleQuery) continue;
    const titleContent = filterSearchContentTokens(titleQuery.split(/\s+/));
    /* Require a real title token — no extra FTS peek (was slow on every split attempt). */
    if (!titleContent.length || !titleContent.some((tok) => tok.length >= 4)) continue;
    const names = findAuthorNamesForBookSearch(authorPart);
    if (names.length > 0 && names.length <= 12) {
      return { authorNames: names, titleQuery, fullNeedle };
    }
  }

  const bySurname = findAuthorsBySurnameToken(tokens[0]);
  if (bySurname.length > 0 && bySurname.length <= 8) {
    const titleQuery = tokens.slice(1).join(' ');
    const titleContent = filterSearchContentTokens(titleQuery.split(/\s+/));
    /* Avoid splitting title-first queries («Девочка с которой…») via surname collisions. */
    const strongAuthor = bySurname.some((row) => Number(row.book_count) >= 2);
    if (strongAuthor && titleContent.some((tok) => tok.length >= 4)) {
      return {
        authorNames: bySurname.map((row) => row.name),
        titleQuery,
        fullNeedle
      };
    }
  }
  return null;
}

/**
 * Build books_fts MATCH string.
 * Default operator → one prefix per token (`stem*` when the stem is 4+ chars);
 * `=` → exact token; `*` → signal LIKE fallback.
 * Multi-token also ORs an exact phrase MATCH for ranking/recall.
 * @returns {{ mode: 'fts', match: string } | { mode: 'like' } | null}
 */
function buildBooksFtsMatchQuery(field, query) {
  const parsed = parseSearchOperator(query);
  if (parsed.operator === 'empty' || parsed.operator === '~') return null;
  if (parsed.operator === '*') return { mode: 'like' };

  const needleKey = normalizeLookalikeSortKey(createSortKey(parsed.value || query));
  const tokens = parsed.operator === '='
    ? [needleKey].filter(Boolean)
    : needleKey.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const columnMap = {
    all: '',
    title: 'title_search',
    authors: 'authors_search',
    series: 'series_search',
    genres: 'genres_search',
    keywords: 'keywords_search'
  };
  if (!(field in columnMap)) return null;
  const col = columnMap[field];

  const prefixCol = (body) => (col ? `${col}:${body}` : body);
  const parts = [];

  if (parsed.operator === '=') {
    for (const token of tokens) {
      const safe = escapeFts5Token(token);
      if (!safe) continue;
      parts.push(prefixCol(`"${safe}"`));
    }
  } else {
    /* AND on content tokens only — «с»/«не» make FTS intersect huge posting lists. */
    const andTokens = tokens.length >= 2 ? filterSearchContentTokens(tokens) : tokens;
    const groups = expandSearchTokenVariants(andTokens);
    for (const variants of groups) {
      const bodies = [];
      for (const variant of variants) {
        const safe = escapeFts5Token(variant);
        if (!safe) continue;
        bodies.push(prefixCol(`"${safe}"*`));
      }
      if (!bodies.length) continue;
      parts.push(bodies.length === 1 ? bodies[0] : `(${bodies.join(' OR ')})`);
    }
  }

  if (!parts.length) return null;
  /* FTS5 requires explicit AND between parenthesized OR-groups; bare space fails. */
  let match = parts.join(' AND ');
  if (parsed.operator !== '=' && tokens.length >= 2) {
    /* Full phrase keeps stopwords so exact titles still MATCH. */
    const phraseSafe = tokens.map((tok) => escapeFts5Token(tok)).filter(Boolean).join(' ');
    if (phraseSafe) {
      match = `(${match}) OR ${prefixCol(`"${phraseSafe}"`)}`;
    }
  }
  return { mode: 'fts', match };
}

function appendBookFilterSql(whereParts, whereParams, genreFilter, extraFilters, { alias = 'active_books' } = {}) {
  if (genreFilter) {
    const sql = alias === 'active_books'
      ? genreFilter.where
      : genreFilter.where.replace(/active_books\./g, `${alias}.`);
    whereParts.push(sql);
    whereParams.push(...genreFilter.params);
  }
  for (const ef of extraFilters) {
    const sql = alias === 'active_books'
      ? ef.where
      : ef.where.replace(/active_books\./g, `${alias}.`);
    whereParts.push(sql);
    whereParams.push(...ef.params);
  }
}

/** Title ranking: exact / prefix / ordered-token contains (NEAR-like). */
function buildTitleBoostExpr(column, needleKey, contentTokens = []) {
  const col = String(column || 'title_search');
  if (!needleKey) return { sql: '0', params: [] };
  const ordered = buildOrderedTitleLikePattern(contentTokens);
  const parts = [
    `WHEN LOWER(COALESCE(${col}, '')) = ? THEN -2000`,
    `WHEN LOWER(COALESCE(${col}, '')) LIKE ? THEN -2000`,
    `WHEN LOWER(COALESCE(${col}, '')) LIKE ? THEN -1000`
  ];
  const params = [needleKey, `${needleKey} %`, `${needleKey}%`];
  if (ordered) {
    parts.splice(2, 0, `WHEN LOWER(COALESCE(${col}, '')) LIKE ? THEN -1500`);
    params.splice(2, 0, ordered);
  }
  return { sql: `CASE ${parts.join(' ')} ELSE 0 END`, params };
}

function finalizeSearchBookPage(items, pageSize) {
  const list = dedupeSearchBookItems(items || []);
  for (const item of list) delete item.bookDate;
  if (pageSize > 0 && list.length > pageSize) return list.slice(0, pageSize);
  return list;
}

/** FTS5 fast rank window. Deeper pages fall back to a full SQL sort. */
const FTS_RANK_WINDOW = 400;

const FTS_BOOK_PAGE_COLUMNS = `
  b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang,
  b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted,
  b.title_search AS titleSearch, b.title_sort AS titleSort, b.author_sort AS authorSort,
  b.date AS bookDate, b.imported_at AS importedAt
`;

let _stmtFtsRankWindow = null;

function ftsRankWindow(match, limit, offset = 0) {
  _stmtFtsRankWindow ??= db.prepare(`
    SELECT id, rank AS ftsRank
    FROM books_fts
    WHERE books_fts MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `);
  return _stmtFtsRankWindow.all(match, limit, offset);
}

function loadActiveBooksByIds(ids) {
  const out = [];
  const chunkSize = 400;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    if (!slice.length) continue;
    const placeholders = slice.map(() => '?').join(',');
    out.push(...db.prepare(`
      SELECT ${FTS_BOOK_PAGE_COLUMNS}
      FROM active_books b
      WHERE b.id IN (${placeholders})
    `).all(...slice));
  }
  return out;
}

function titleHasOrderedTokens(title, contentTokens) {
  const parts = (Array.isArray(contentTokens) ? contentTokens : [])
    .map((tok) => String(tok || '').trim().toLowerCase())
    .filter((tok) => tok.length >= 3);
  if (parts.length < 2) return false;
  let from = 0;
  for (const tok of parts) {
    const idx = title.indexOf(tok, from);
    if (idx < 0) return false;
    from = idx + tok.length;
  }
  return true;
}

/** Same bands as buildTitleBoostExpr: exact -2000, ordered -1500, prefix -1000. */
function titleBoostRank(titleSearch, needleKey, contentTokens) {
  const title = String(titleSearch || '').toLowerCase();
  const needle = String(needleKey || '').toLowerCase();
  if (!needle) return 0;
  if (title === needle || title.startsWith(`${needle} `)) return -2000;
  if (titleHasOrderedTokens(title, contentTokens)) return -1500;
  if (title.startsWith(needle)) return -1000;
  return 0;
}

function compareSearchTie(a, b, sort, order) {
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const text = (value) => String(value || '');
  let primary = 0;
  if (sort === 'recent') {
    const aKey = text(a.bookDate).trim() || text(a.importedAt);
    const bKey = text(b.bookDate).trim() || text(b.importedAt);
    primary = cmp(bKey, aKey);
    if (!primary) primary = cmp(text(b.importedAt), text(a.importedAt));
  } else if (sort === 'author') {
    primary = cmp(text(a.authorSort), text(b.authorSort));
  } else if (sort === 'rating') {
    primary = (Number(b.libRate) || 0) - (Number(a.libRate) || 0);
  } else {
    primary = cmp(text(a.titleSort), text(b.titleSort));
  }
  const natural = (sort === 'recent' || sort === 'rating') ? 'desc' : 'asc';
  if ((order === 'asc' || order === 'desc') && order !== natural && primary) primary = -primary;
  if (primary) return primary;
  if (sort === 'author' || sort === 'rating' || sort === 'recent') {
    const titleCmp = cmp(text(a.titleSort), text(b.titleSort));
    if (titleCmp) return titleCmp;
  } else {
    const titleCmp = cmp(text(a.title).toLowerCase(), text(b.title).toLowerCase());
    if (titleCmp) return titleCmp;
  }
  return cmp(text(b.id), text(a.id));
}

function stripSearchRankFields(row) {
  const copy = { ...row };
  delete copy.titleSearch;
  delete copy.titleSort;
  delete copy.authorSort;
  delete copy.bookDate;
  delete copy.importedAt;
  delete copy.ftsRank;
  return copy;
}

function sliceRankedFtsHits(rows, { needleKey, contentTokens, sort, order, pageSize, offset }) {
  const decorated = rows.map((row) => ({
    ...row,
    titleBoost: titleBoostRank(row.titleSearch, needleKey, contentTokens),
    ftsRank: Number.isFinite(Number(row.ftsRank)) ? Number(row.ftsRank) : 0
  }));
  decorated.sort((a, b) => {
    if (a.titleBoost !== b.titleBoost) return a.titleBoost - b.titleBoost;
    if (a.ftsRank !== b.ftsRank) return a.ftsRank - b.ftsRank;
    return compareSearchTie(a, b, sort, order);
  });
  const deduped = dedupeSearchBookItems(
    decorated.map((row) => {
      const item = mapBookListRow(stripSearchRankFields(row));
      if (row.bookDate) item.bookDate = row.bookDate;
      return item;
    })
  );
  for (const item of deduped) delete item.bookDate;
  return deduped.slice(offset, offset + pageSize);
}

function loadExactTitlePins(needleKey, filterParts, filterParams) {
  const needle = String(needleKey || '');
  if (!needle.includes(' ')) return [];
  const parts = ['(b.title_search = ? OR b.title_search LIKE ?)'];
  const params = [needle, `${needle} %`];
  if (filterParts?.length) {
    parts.push(...filterParts);
    params.push(...filterParams);
  }
  return db.prepare(`
    SELECT ${FTS_BOOK_PAGE_COLUMNS}
    FROM active_books b
    WHERE ${parts.join(' AND ')}
    LIMIT 64
  `).all(...params);
}

function mergeExactTitlePins(hits, needleKey, filterParts, filterParams) {
  const pins = loadExactTitlePins(needleKey, filterParts, filterParams);
  if (!pins.length) return hits;
  const seen = new Set(hits.map((row) => row.id));
  const merged = hits.slice();
  for (const pin of pins) {
    if (!pin?.id || seen.has(pin.id)) continue;
    seen.add(pin.id);
    merged.push({ ...pin, ftsRank: 0 });
  }
  return merged;
}

/**
 * Ranked book page for an FTS MATCH.
 * Fast path avoids sorting every hit. Returns null to keep the SQL ORDER BY.
 */
function queryFtsBookPage({
  match,
  whereSql,
  whereParams,
  needleKey,
  contentTokens,
  sort,
  order,
  pageSize,
  offset,
  authorNames = null,
  filterParts = [],
  filterParams = []
}) {
  if (!(pageSize > 0)) return [];
  const fast = tryFastFtsBookPage({
    match,
    needleKey,
    contentTokens,
    sort,
    order,
    pageSize,
    offset,
    authorNames,
    filterParts,
    filterParams
  });
  if (fast) return fast;
  return queryLegacyFtsPage({
    whereSql,
    whereParams,
    needleKey,
    contentTokens,
    sort,
    order,
    pageSize,
    offset
  });
}

function tryFastFtsBookPage({
  match,
  needleKey,
  contentTokens,
  sort,
  order,
  pageSize,
  offset,
  authorNames,
  filterParts,
  filterParams
}) {
  if (sort === 'series' || !match) return null;
  /* Author+title stays on SQL: an external-content FTS table does not honor
     `rowid = ? AND MATCH` (a miss still returns some other hit). */
  if (authorNames?.length || filterParts.length) return null;
  if (offset + pageSize > FTS_RANK_WINDOW) return null;

  /* Окно в 400 хитов, среди которых много deleted, раньше срывалось в ORDER BY bm25
     по всем совпадениям. Добираем следующие окна, пока не наберётся страница. */
  const rankById = new Map();
  const books = [];
  const seen = new Set();
  const batch = 400;
  const maxScan = 1600;
  let fetched = 0;
  while (fetched < maxScan && books.length < offset + pageSize) {
    const ranked = ftsRankWindow(match, batch, fetched);
    if (!ranked.length) break;
    const ids = [];
    for (const row of ranked) {
      rankById.set(row.id, Number(row.ftsRank));
      ids.push(row.id);
    }
    for (const book of loadActiveBooksByIds(ids)) {
      if (seen.has(book.id)) continue;
      seen.add(book.id);
      books.push(book);
    }
    fetched += ranked.length;
    if (ranked.length < batch) break;
  }
  let hits = books.map((row) => ({ ...row, ftsRank: rankById.get(row.id) }));
  hits = mergeExactTitlePins(hits, needleKey, filterParts, filterParams);
  if (!hits.length) return null;
  return sliceRankedFtsHits(hits, { needleKey, contentTokens, sort, order, pageSize, offset });
}

function queryLegacyFtsPage({
  whereSql,
  whereParams,
  needleKey,
  contentTokens,
  sort,
  order,
  pageSize,
  offset
}) {
  const boost = buildTitleBoostExpr('b.title_search', needleKey, contentTokens);
  const listOrderBy = resolveBookAliasSort(sort, 'b', order);
  const rankedOrderBy = sort === 'series'
    ? `${listOrderBy}, ${boost.sql} ASC, bm25(books_fts) ASC`
    : `${boost.sql} ASC, bm25(books_fts) ASC, ${listOrderBy}`;
  return finalizeSearchBookPage(db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang,
           b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted, b.date AS bookDate
    FROM books_fts
    JOIN active_books b ON b.id = books_fts.id
    WHERE ${whereSql}
    ORDER BY ${rankedOrderBy}
    LIMIT ? OFFSET ?
  `).all(...whereParams, ...boost.params, pageSize, offset).map(mapBookListRow), pageSize);
}

function tryTypoCorrectedSearchBooks(args) {
  if (!args?.allowTypoRetry) return null;
  /* Never on typeahead — dictionary scan is costly on Flibusta. */
  if (args.totalMode === 'omit') return null;
  const q = String(args.query || '').trim();
  if (!q || q.length < 5) return null;
  const suggestions = findDidYouMeanSuggestions(q, 1);
  for (const suggestion of suggestions) {
    if (suggestion.type !== 'title' && suggestion.type !== 'author') continue;
    const corrected = applyDidYouMeanToQuery(q, suggestion);
    if (!corrected || corrected.toLowerCase() === q.toLowerCase()) continue;
    const retried = searchBooks({
      ...args,
      query: corrected,
      allowTypoRetry: false
    });
    if ((retried.total || 0) > 0 || (retried.items || []).length) {
      return { ...retried, correctedFrom: q, correctedQuery: corrected };
    }
  }
  return null;
}

let _browseTotalMemo = null;
/** listAuthors без поиска: total по букве → { total, at } */
const _authorsTotalMemo = new Map();

function enabledSourcesHaveMixedSidecarFlag() {
  const n = db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(flibusta_sidecar, 0)) AS n FROM sources WHERE enabled = 1
  `).get()?.n;
  return Number(n) > 1;
}

export function searchBooks({
  query = '', page = 1, pageSize = 24, field = 'all', sort = 'title', order = '',
  genre = '', letter = '', lang = '', format = '', year = 0, minRate = 0, hasSeries = null,
  /** exact = full COUNT(*); capped = COUNT up to 10001 (hub); omit = skip COUNT (suggest) */
  totalMode = 'exact',
  /** Internal: prevent recursive typo-correction loops */
  allowTypoRetry = true
} = {}) {
  query = prepareSearchQueryInput(query);
  const offset = (page - 1) * pageSize;
  const orderBy = resolveSort(sort, order);
  const genreFilter = buildGenreFilterSql(genre);
  const extraFilters = buildCatalogExtraFilters({ lang, format, year, minRate, hasSeries });
  const parsedQuery = parseSearchOperator(query);
  const letterNorm = String(letter || '').trim().toLowerCase();
  const countCap = 10_001;
  const mode = ['exact', 'capped', 'omit'].includes(totalMode) ? totalMode : 'exact';

  const resolveSqlTotal = (exactSql, exactParams, sampleSql, sampleParams) => {
    if (mode === 'omit') return { total: 0, capped: false, omitted: true };
    if (mode === 'capped') {
      const n = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM (${sampleSql} LIMIT ?)
      `).get(...sampleParams, countCap).count) || 0;
      return { total: n, capped: n >= countCap, omitted: false };
    }
    const total = Number(db.prepare(exactSql).get(...exactParams).count) || 0;
    return { total, capped: false, omitted: false };
  };

  if (!query.trim()) {
    const whereParts = [];
    const whereParams = [];
    if (genreFilter) { whereParts.push(genreFilter.where.replace(/active_books\./g, 'b.')); whereParams.push(...genreFilter.params); }
    if (letterNorm) { whereParts.push('b.title_sort LIKE ?'); whereParams.push(`${letterNorm}%`); }
    for (const ef of extraFilters) { whereParts.push(ef.where.replace(/active_books\./g, 'b.')); whereParams.push(...ef.params); }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const gfParams = whereParams;
    /* Ключ по s.flibusta_sidecar живёт в присоединённой таблице — с ним индекс books бесполезен и
       каждая страница сортирует весь каталог (~1.2 с). Нужен он только если у включённых источников
       флаг различается; при одном источнике ORDER BY совпадает с idx_books_recent_sort. */
    const listOrderBy =
      sort === 'recent' && enabledSourcesHaveMixedSidecarFlag()
        ? applyOrder('COALESCE(s.flibusta_sidecar, 0) DESC, COALESCE(NULLIF(b.date, \'\'), b.imported_at) DESC, b.imported_at DESC, b.id DESC', order)
        : resolveBookAliasSort(sort, 'b', order);

    /* Без фильтров total одинаков для всех страниц листания — не считать 600k строк на каждую. */
    const memoTotal = !whereSql && mode === 'exact';
    const { total } = memoTotal && _browseTotalMemo && (Date.now() - _browseTotalMemo.at) < PAGE_CACHE_TTL_MS
      ? _browseTotalMemo
      : resolveSqlTotal(
        `SELECT COUNT(*) AS count FROM active_books b LEFT JOIN sources s ON s.id = b.source_id ${whereSql}`,
        gfParams,
        `SELECT 1 FROM active_books b LEFT JOIN sources s ON s.id = b.source_id ${whereSql}`,
        gfParams
      );
    if (memoTotal) _browseTotalMemo = { total, at: Date.now() };

    const items = db
      .prepare(
        `
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
      FROM active_books b
      LEFT JOIN sources s ON s.id = b.source_id
      ${whereSql}
      ORDER BY ${listOrderBy}
      LIMIT ? OFFSET ?
    `
      )
      .all(...gfParams, pageSize, offset)
      .map(mapBookListRow);

    attachSeriesListsToBooks(items);
    return { total: mode === 'omit' ? items.length : total, items };
  }

  if (!['all', 'title', 'authors', 'series', 'genres', 'keywords'].includes(field)) {
    return { total: 0, items: [] };
  }

  if (parsedQuery.operator === '~') {
    // Regex can't be pushed to SQLite, so we scan a limited window of rows
    // and filter in JS. 5000 is an intentional trade-off between coverage
    // and memory pressure — raising it increases peak RSS linearly.
    const REGEX_SCAN_LIMIT = 5000;
    const filterParts = [];
    const filterParams = [];
    appendBookFilterSql(filterParts, filterParams, genreFilter, extraFilters);
    const items = db.prepare(`
      SELECT id, title, authors, genres, series, series_no AS seriesNo, ext, lang,
             lib_rate AS libRate, archive_name AS archiveName, keywords,
             title_search AS titleSearch,
             authors_search AS authorsSearch,
             series_search AS seriesSearch,
             genres_search AS genresSearch,
             keywords_search AS keywordsSearch
      FROM active_books
      ${filterParts.length ? `WHERE ${filterParts.join(' AND ')}` : ''}
      ORDER BY ${orderBy}
      LIMIT ${REGEX_SCAN_LIMIT}
    `).all(...filterParams)
      .map(mapBookListRow)
      .filter((book) => matchesBookSearchField(book, field, query));

    attachSeriesListsToBooks(items);
    return { total: items.length, items: items.slice(offset, offset + pageSize) };
  }

  const authorMatch = (field === 'all' || field === 'authors') ? buildAuthorWhereForBooks(query) : null;

  /* ── Author + title split: "Садовников Пешком над облаками" ── */
  if (field === 'all' && isBooksFtsUsable()) {
    const split = resolveAuthorTitleSplit(query);
    if (split?.authorNames?.length && split.titleQuery) {
      const titlePlan = buildBooksFtsMatchQuery('title', split.titleQuery);
      const authorWhere = buildAuthorWhereFromMatchedNames(split.authorNames);
      if (titlePlan?.mode === 'fts' && titlePlan.match && authorWhere) {
        const filterParts = [];
        const filterParams = [];
        appendBookFilterSql(filterParts, filterParams, genreFilter, extraFilters, { alias: 'b' });
        const authorSql = authorWhere.where.replace(/active_books\./g, 'b.');
        const whereSql = ['books_fts MATCH ?', `(${authorSql})`, ...filterParts].join(' AND ');
        const whereParams = [titlePlan.match, ...authorWhere.params, ...filterParams];
        const titleNeedle = createSortKey(split.titleQuery);
        let ftsHit = false;
        let total = 0;
        let capped = false;
        if (mode === 'omit') {
          ftsHit = Boolean(db.prepare(`
            SELECT 1 FROM books_fts
            JOIN active_books b ON b.id = books_fts.id
            WHERE ${whereSql}
            LIMIT 1
          `).get(...whereParams));
        } else {
          const counted = resolveSqlTotal(
            `SELECT COUNT(*) AS count FROM books_fts JOIN active_books b ON b.id = books_fts.id WHERE ${whereSql}`,
            whereParams,
            `SELECT 1 FROM books_fts JOIN active_books b ON b.id = books_fts.id WHERE ${whereSql}`,
            whereParams
          );
          total = counted.total;
          capped = counted.capped;
          ftsHit = total > 0;
        }
        if (ftsHit) {
          const contentTokens = filterSearchContentTokens(String(titleNeedle || '').split(/\s+/));
          const items = queryFtsBookPage({
            match: titlePlan.match,
            whereSql,
            whereParams,
            needleKey: titleNeedle,
            contentTokens,
            sort,
            order,
            pageSize,
            offset,
            authorNames: split.authorNames,
            filterParts,
            filterParams
          });
          attachSeriesListsToBooks(items);
          const outTotal = mode === 'omit' ? items.length : total;
          return capped ? { total: outTotal, items, capped: true } : { total: outTotal, items };
        }
      }
    }
  }

  const ftsPlan = buildBooksFtsMatchQuery(field, query);
  const useFts = Boolean(ftsPlan?.mode === 'fts' && ftsPlan.match && isBooksFtsUsable());

  /* ── Hot path: FTS5 MATCH + bm25 (FTS must drive the plan — never scan all books) ── */
  if (useFts) {
    const needleKey = normalizeLookalikeSortKey(createSortKey(parsedQuery.value || query));
    const filterParts = [];
    const filterParams = [];
    appendBookFilterSql(filterParts, filterParams, genreFilter, extraFilters, { alias: 'b' });

    /* authors_search is already in books_fts; do not OR a full-table author EXISTS here. */
    const whereSql = ['books_fts MATCH ?', ...filterParts].join(' AND ');
    const whereParams = [ftsPlan.match, ...filterParams];

    // Peek / count without forcing a full MATCH materialization when possible.
    let ftsHit = true;
    let total = 0;
    let capped = false;
    if (mode === 'omit') {
      ftsHit = Boolean(db.prepare(`
        SELECT 1
        FROM books_fts
        JOIN active_books b ON b.id = books_fts.id
        WHERE ${whereSql}
        LIMIT 1
      `).get(...whereParams));
    } else {
      /* Тот же фильтр, что у выдачи: скрытые языки/жанры и удалённые не входят в «Найдено». */
      const counted = resolveSqlTotal(
        `SELECT COUNT(*) AS count
         FROM books_fts
         JOIN active_books b ON b.id = books_fts.id
         WHERE ${whereSql}`,
        whereParams,
        `SELECT 1
         FROM books_fts
         JOIN active_books b ON b.id = books_fts.id
         WHERE ${whereSql}`,
        whereParams
      );
      total = counted.total;
      capped = counted.capped;
      ftsHit = total > 0;
    }

    if (ftsHit) {
      const contentTokens = filterSearchContentTokens(String(needleKey || '').split(/\s+/));
      /* Exact/phrase/ordered title beat bm25 so multi-word titles land on page 1. */
      const items = queryFtsBookPage({
        match: ftsPlan.match,
        whereSql,
        whereParams,
        needleKey,
        contentTokens,
        sort,
        order,
        pageSize,
        offset,
        filterParts,
        filterParams
      });

      attachSeriesListsToBooks(items);
      const outTotal = mode === 'omit' ? items.length : total;
      return capped ? { total: outTotal, items, capped: true } : { total: outTotal, items };
    }

    /*
     * isBooksFtsUsable() already checks the dirty flag and probes external-content
     * desynchronisation. Treat a zero MATCH from a healthy index as a real miss:
     * the old LIKE fallback scanned every searchable column and stalled the
     * event loop for seconds on NAS-sized catalogs. `*query` still selects the
     * explicit contains/LIKE path, and an unusable FTS still falls through below.
     */
    if (!BOOKS_FTS_ZERO_MATCH_LIKE_FALLBACK) {
      return { total: 0, items: [] };
    }
  }

  /* ── Fallback: LIKE (FTS dirty/unavailable, explicit `*`, or legacy flag) ── */
  const sqlSearch = buildBookSearchSql(field, query);
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
    const searchWhere = mainWhereParts.map((p) => `(${p})`).join(' OR ');

    const fullWhereParts = [searchWhere];
    const fullWhereParams = [...mainWhereParams];
    appendBookFilterSql(fullWhereParts, fullWhereParams, genreFilter, extraFilters);
    const combinedWhere = fullWhereParts.map((p) => `(${p})`).join(' AND ');

    const counted = resolveSqlTotal(
      `SELECT COUNT(*) AS count FROM active_books WHERE ${combinedWhere}`,
      fullWhereParams,
      `SELECT 1 FROM active_books WHERE ${combinedWhere}`,
      fullWhereParams
    );
    const total = counted.total;
    const capped = counted.capped;

    const titleRankParts = [];
    const titleRankParams = [];
    if (sqlSearch && needleKey) {
      const col = field === 'all' ? 'title_search' : ({ title: 'title_search', authors: 'authors_search', series: 'series_search' }[field] || null);
      if (col) {
        titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) = ? THEN 0`);
        titleRankParams.push(needleKey);
        titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) LIKE ? THEN 0`);
        titleRankParams.push(`${needleKey} %`);
        if (needleTokens.length > 1) {
          const reversedKey = [...needleTokens].reverse().join(' ');
          titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) = ? THEN 0`);
          titleRankParams.push(reversedKey);
          titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) LIKE ? THEN 0`);
          titleRankParams.push(`${reversedKey} %`);
          const ordered = buildOrderedTitleLikePattern(filterSearchContentTokens(needleTokens));
          if (ordered) {
            titleRankParts.push(`WHEN LOWER(COALESCE(${col}, '')) LIKE ? THEN 1`);
            titleRankParams.push(ordered);
          }
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

    /* Title/author rank first (same priority as FTS titleBoost over bm25). */
    const rankedOrderBy = sort === 'series'
      ? `${orderBy}, ${rankSQL} ASC`
      : `${rankSQL} ASC, ${orderBy}`;
    const items = pageSize > 0
      ? finalizeSearchBookPage(db.prepare(`
      SELECT id, title, authors, genres, series, series_no AS seriesNo, ext, lang,
             lib_rate AS libRate, archive_name AS archiveName, date AS bookDate
      FROM active_books
      WHERE ${combinedWhere}
      ORDER BY ${rankedOrderBy}
      LIMIT ? OFFSET ?
    `).all(...fullWhereParams, ...allRankParams, pageSize, offset).map(mapBookListRow), pageSize)
      : [];

    attachSeriesListsToBooks(items);
    const outTotal = mode === 'omit' ? items.length : total;
    return capped ? { total: outTotal, items, capped: true } : { total: outTotal, items };
  }

  return { total: 0, items: [] };
}

/** Levenshtein distance for short catalog tokens (did-you-mean). */
function levenshteinDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const row = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) row[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cur = row[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[t.length];
}

const TITLE_TOKEN_DICT_LIMIT = 50_000;
const TITLE_TOKEN_META_KEY = 'search_title_tokens_built';
let _titleTokenBuildScheduled = false;

/**
 * Compact frequency dictionary of title tokens for did-you-mean (not full trigram).
 * @param {{ force?: boolean }} [opts]
 */
export function rebuildTitleTokenDictionary({ force = false } = {}) {
  ensureSearchTitleTokensTable();
  if (!force && getMeta(TITLE_TOKEN_META_KEY) === '1') {
    const n = Number(db.prepare('SELECT COUNT(*) AS c FROM search_title_tokens').get()?.c) || 0;
    if (n > 0) return { ok: true, tokens: n, skipped: true };
  }

  const freqs = new Map();
  const rows = db.prepare(`
    SELECT title_search AS titleSearch
    FROM books
    WHERE deleted = 0 AND COALESCE(title_search, '') != ''
  `).iterate();
  for (const row of rows) {
    for (const tok of String(row.titleSearch || '').split(/\s+/)) {
      if (tok.length < 4) continue;
      freqs.set(tok, (freqs.get(tok) || 0) + 1);
    }
    if (freqs.size > TITLE_TOKEN_DICT_LIMIT * 4) break;
  }

  const top = [...freqs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TITLE_TOKEN_DICT_LIMIT);

  const clear = db.prepare('DELETE FROM search_title_tokens');
  const ins = db.prepare('INSERT INTO search_title_tokens(token, freq) VALUES (?, ?)');
  db.transaction(() => {
    clear.run();
    for (const [token, freq] of top) {
      ins.run(token, freq);
    }
  })();
  setMeta(TITLE_TOKEN_META_KEY, '1');
  return { ok: true, tokens: top.length, skipped: false };
}

function ensureTitleTokenDictionaryLazy() {
  try {
    ensureSearchTitleTokensTable();
    const n = Number(db.prepare('SELECT COUNT(*) AS c FROM search_title_tokens').get()?.c) || 0;
    if (n > 0) return;
  } catch {
    /* ignore */
  }
  if (_titleTokenBuildScheduled) return;
  _titleTokenBuildScheduled = true;
  setImmediate(() => {
    try {
      rebuildTitleTokenDictionary({ force: true });
    } catch (err) {
      console.warn('[search] title token dictionary build failed:', err.message);
    } finally {
      _titleTokenBuildScheduled = false;
    }
  });
}

/**
 * Lightweight typo suggestions from authors/series catalogs + title token dictionary.
 * @returns {{ type: 'author'|'series'|'title', label: string, query: string, name: string }[]}
 */
export function findDidYouMeanSuggestions(query = '', limit = 3) {
  const tokens = normalizeLookalikeSortKey(createSortKey(query)).split(/\s+/).filter((tok) => tok.length >= 4);
  if (!tokens.length) return [];

  ensureTitleTokenDictionaryLazy();

  const scored = [];
  const seen = new Set();

  for (const token of tokens) {
    const maxDist = token.length >= 6 ? 2 : 1;
    const prefixLen = Math.max(2, token.length - maxDist);
    const prefix = `${token.slice(0, prefixLen)}%`;

    const authors = db.prepare(`
      SELECT name, COALESCE(display_name, name) AS displayName, sort_name, book_count
      FROM authors
      WHERE book_count > 0 AND COALESCE(search_name, '') LIKE ?
      ORDER BY book_count DESC
      LIMIT 48
    `).all(prefix);

    for (const row of authors) {
      for (const part of createSortKey(row.sort_name || '').split(/\s+/).filter(Boolean)) {
        const dist = levenshteinDistance(token, part);
        if (dist <= 0 || dist > maxDist) continue;
        const key = `author:${row.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scored.push({
          type: 'author',
          label: row.displayName,
          query: row.displayName,
          name: row.name,
          dist,
          bookCount: row.book_count || 0
        });
      }
    }

    const seriesRows = db.prepare(`
      SELECT name, COALESCE(display_name, name) AS displayName, sort_name, book_count
      FROM series_catalog
      WHERE book_count > 0 AND COALESCE(search_name, '') LIKE ?
      ORDER BY book_count DESC
      LIMIT 48
    `).all(prefix);

    for (const row of seriesRows) {
      for (const part of createSortKey(row.sort_name || row.name || '').split(/\s+/).filter(Boolean)) {
        const dist = levenshteinDistance(token, part);
        if (dist <= 0 || dist > maxDist) continue;
        const key = `series:${row.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scored.push({
          type: 'series',
          label: row.displayName,
          query: row.displayName,
          name: row.name,
          dist,
          bookCount: row.book_count || 0
        });
      }
    }

    try {
      const titleRows = db.prepare(`
        SELECT token, freq
        FROM search_title_tokens
        WHERE token LIKE ?
        ORDER BY freq DESC
        LIMIT 48
      `).all(prefix);
      for (const row of titleRows) {
        const part = String(row.token || '');
        /* Стем-префикс введённого слова («плам» для «пламя») — не исправление опечатки. */
        if (token.startsWith(part)) continue;
        const dist = levenshteinDistance(token, part);
        if (dist <= 0 || dist > maxDist) continue;
        const key = `title:${part}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scored.push({
          type: 'title',
          label: part,
          query: part,
          name: part,
          dist,
          bookCount: row.freq || 0
        });
      }
    } catch {
      /* table may be missing on first call */
    }
  }

  scored.sort((a, b) => {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return (b.bookCount || 0) - (a.bookCount || 0);
  });

  return scored.slice(0, limit).map(({ type, label, query: q, name }) => ({ type, label, query: q, name }));
}

/**
 * Genres present among books matching q + filters (genre filter excluded — faceted UX).
 * Used by Android/web filter sheet to offer only relevant genres.
 */
export function listSearchGenres({
  query = '',
  lang = '',
  format = '',
  year = 0,
  minRate = 0,
  hasSeries = null,
  limit = 100
} = {}) {
  const q = String(query || '').trim();
  const extraFilters = buildCatalogExtraFilters({ lang, format, year, minRate, hasSeries });
  const lim = Math.min(200, Math.max(1, Math.floor(Number(limit) || 100)));
  if (!q && !extraFilters.length) {
    return { items: [], scoped: false };
  }

  const mapRows = (rows) => (rows || []).map((row) => ({
    name: row.name,
    displayName: row.displayName || row.name,
    bookCount: Math.max(0, Math.floor(Number(row.bookCount) || 0))
  }));

  const runGrouped = (fromSql, params) => mapRows(db.prepare(`
    SELECT g.name AS name,
           COALESCE(g.display_name, g.name) AS displayName,
           COUNT(DISTINCT bg.book_id) AS bookCount
    ${fromSql}
    GROUP BY g.id
    ORDER BY bookCount DESC, displayName ASC
    LIMIT ?
  `).all(...params, lim));

  const finalize = (items) => ({
    scoped: true,
    items: [...(items || [])].sort((a, b) => {
      const la = String(a?.displayName || a?.name || '').trim();
      const lb = String(b?.displayName || b?.name || '').trim();
      return la.localeCompare(lb, 'ru', { sensitivity: 'base' });
    })
  });

  if (!q) {
    const whereParts = [];
    const whereParams = [];
    for (const ef of extraFilters) {
      whereParts.push(ef.where.replace(/active_books\./g, 'b.'));
      whereParams.push(...ef.params);
    }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    return finalize(runGrouped(`
        FROM active_books b
        JOIN book_genres bg ON bg.book_id = b.id
        JOIN genres_catalog g ON g.id = bg.genre_id
        ${whereSql}
      `, whereParams));
  }

  const field = 'all';
  const parsedQuery = parseSearchOperator(q);
  if (parsedQuery.operator === '~') {
    // Rare path: sample books then collect genres in JS.
    const filterParts = [];
    const filterParams = [];
    appendBookFilterSql(filterParts, filterParams, null, extraFilters);
    const books = db.prepare(`
      SELECT id, title, authors, genres, series, series_no AS seriesNo, ext, lang,
             lib_rate AS libRate, archive_name AS archiveName, keywords,
             title_search AS titleSearch, authors_search AS authorsSearch,
             series_search AS seriesSearch, genres_search AS genresSearch,
             keywords_search AS keywordsSearch
      FROM active_books
      ${filterParts.length ? `WHERE ${filterParts.join(' AND ')}` : ''}
      LIMIT 5000
    `).all(...filterParams)
      .map(mapBookListRow)
      .filter((book) => matchesBookSearchField(book, field, q));
    const ids = books.map((b) => b.id).filter(Boolean);
    if (!ids.length) return finalize([]);
    const placeholders = ids.map(() => '?').join(',');
    return finalize(runGrouped(`
        FROM active_books b
        JOIN book_genres bg ON bg.book_id = b.id
        JOIN genres_catalog g ON g.id = bg.genre_id
        WHERE b.id IN (${placeholders})
      `, ids));
  }

  const authorMatch = buildAuthorWhereForBooks(q);
  const ftsPlan = buildBooksFtsMatchQuery(field, q);
  const useFts = Boolean(ftsPlan?.mode === 'fts' && ftsPlan.match && isBooksFtsUsable());

  /* Cap matched books before GROUP BY — full MATCH/LIKE + genre join on Flibusta is slow. */
  const GENRE_MATCH_CAP = 2000;

  if (useFts) {
    const filterParts = [];
    const filterParams = [];
    appendBookFilterSql(filterParts, filterParams, null, extraFilters, { alias: 'b' });
    const whereSql = ['books_fts MATCH ?', ...filterParts].join(' AND ');
    const whereParams = [ftsPlan.match, ...filterParams];
    const peek = db.prepare(`
      SELECT 1
      FROM books_fts
      JOIN active_books b ON b.id = books_fts.id
      WHERE ${whereSql}
      LIMIT 1
    `).get(...whereParams);
    if (peek) {
      return finalize(runGrouped(`
          FROM (
            SELECT b.id AS id
            FROM books_fts
            JOIN active_books b ON b.id = books_fts.id
            WHERE ${whereSql}
            LIMIT ${GENRE_MATCH_CAP}
          ) matched
          JOIN book_genres bg ON bg.book_id = matched.id
          JOIN genres_catalog g ON g.id = bg.genre_id
        `, whereParams));
    }
  }

  const sqlSearch = buildBookSearchSql(field, q);
  if (!sqlSearch && !authorMatch) return finalize([]);

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
  const searchWhere = mainWhereParts.map((p) => `(${p})`).join(' OR ');
  const fullWhereParts = [searchWhere];
  const fullWhereParams = [...mainWhereParams];
  appendBookFilterSql(fullWhereParts, fullWhereParams, null, extraFilters);
  const combinedWhere = fullWhereParts.map((p) => `(${p})`).join(' AND ');

  return finalize(runGrouped(`
      FROM (
        SELECT id FROM active_books WHERE ${combinedWhere}
        LIMIT ${GENRE_MATCH_CAP}
      ) matched
      JOIN book_genres bg ON bg.book_id = matched.id
      JOIN genres_catalog g ON g.id = bg.genre_id
    `, fullWhereParams));
}

/**
 * Totals for books / authors / series (`GET /api/search`, web search chips).
 * Book totals use capped COUNT (≤10001) — full FTS COUNT on popular queries is too slow.
 * `routeField` is always null (web Enter opens books; no smart redirect).
 * Pass `booksTotal` when the books page was already loaded to skip a second COUNT.
 */
/** Лог только медленных поисковых вызовов: по строке видно, какой шаг тормозит на конкретной машине. */
const SLOW_SEARCH_LOG_MS = Number(process.env.SLOW_SEARCH_LOG_MS) || 300;
function logSlowSearchSteps(label, query, steps) {
  const total = steps.reduce((sum, [, ms]) => sum + ms, 0);
  if (total < SLOW_SEARCH_LOG_MS) return;
  const detail = steps.map(([name, ms]) => `${name}=${ms}ms`).join(' ');
  console.warn(`[perf] slow ${label} q="${String(query).slice(0, 60)}" total=${total}ms ${detail}`);
}

export function searchOverview({
  query = '',
  booksTotal: booksTotalIn = null,
  booksCapped: booksCappedIn = null
} = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return {
      query: '',
      books: { total: 0 },
      authors: { total: 0 },
      series: { total: 0 },
      preferredField: null,
      routeField: null
    };
  }
  let bookTotal;
  let booksCapped;
  const booksPrecomputed = booksTotalIn != null && Number.isFinite(Number(booksTotalIn));
  const tOverview = Date.now();
  if (booksPrecomputed) {
    bookTotal = Math.max(0, Math.floor(Number(booksTotalIn) || 0));
    booksCapped = Boolean(booksCappedIn);
  } else {
    /* Counts only — do not materialize/rank a books page here. */
    const books = searchBooks({
      query: q,
      page: 1,
      pageSize: 0,
      field: 'all',
      sort: 'title',
      totalMode: 'capped',
      allowTypoRetry: false
    });
    bookTotal = Math.max(0, Math.floor(Number(books.total) || 0));
    booksCapped = Boolean(books.capped);
  }
  const tBooks = Date.now();
  const authors = listAuthors({ query: q, page: 1, pageSize: 1, sort: 'count' });
  const tAuthors = Date.now();
  const series = listSeries({ query: q, page: 1, pageSize: 3, sort: 'count', nameOnly: true });
  logSlowSearchSteps('overview', q, [['books', tBooks - tOverview], ['authors', tAuthors - tBooks], ['series', Date.now() - tAuthors]]);
  const authorsTotal = Math.max(0, Math.floor(Number(authors.total) || 0));
  const seriesTotal = Math.max(0, Math.floor(Number(series.total) || 0));
  const preferredField = detectPreferredSearchField({
    query: q,
    booksTotal: bookTotal,
    authorsTotal,
    seriesTotal,
    seriesSamples: series.items || []
  });
  /* Прогрев первой страницы нужен только для /api/search (клиент потом откроет каталог).
     Когда книги уже посчитаны вызывающим (/catalog), это был бы повтор той же выдачи
     и второй блокирующий проход по FTS сразу после ответа. */
  if (!booksPrecomputed) {
    const warmQuery = q;
    setImmediate(() => {
      try {
        const page = searchBooks({
          query: warmQuery,
          page: 1,
          pageSize: 24,
          field: 'all',
          sort: 'title',
          totalMode: 'capped',
          allowTypoRetry: false
        });
        rememberWarmSearchBooksPage(warmQuery, 'title', { ...page, field: 'books' });
      } catch {
        /* warmup best-effort */
      }
    });
  }
  return {
    query: q,
    books: {
      total: booksCapped ? Math.min(bookTotal, 10_000) : bookTotal,
      capped: booksCapped
    },
    authors: { total: authorsTotal },
    series: { total: seriesTotal },
    preferredField,
    routeField: null
  };
}

/**
 * Cross-mode recovery when the active search mode returned nothing.
 * Additive: callers may ignore searchHints.
 */
export function buildSearchRecoveryHints({ query = '', field = 'books' } = {}) {
  const q = String(query || '').trim();
  const hints = { alternateModes: [], didYouMean: [], tip: null };
  if (!q) return hints;

  const normalizedField = ['books', 'authors', 'series'].includes(field) ? field : 'books';

  if (normalizedField !== 'authors') {
    const authors = listAuthors({ query: q, page: 1, pageSize: 3, sort: 'count' });
    if (authors.total > 0) {
      hints.alternateModes.push({
        field: 'authors',
        total: authors.total,
        samples: authors.items.slice(0, 3).map((row) => ({
          name: row.name,
          displayName: row.displayName || row.name,
          bookCount: row.bookCount
        }))
      });
      if (normalizedField === 'books') {
        hints.tip = 'try_authors';
      }
    }
  }

  if (normalizedField !== 'series') {
    const series = listSeries({ query: q, page: 1, pageSize: 3, sort: 'count' });
    if (series.total > 0) {
      hints.alternateModes.push({
        field: 'series',
        total: series.total,
        samples: series.items.slice(0, 3).map((row) => ({
          name: row.name,
          displayName: row.displayName || row.name,
          bookCount: row.bookCount
        }))
      });
      if (normalizedField === 'books' && !hints.tip) {
        hints.tip = 'try_series';
      }
    }
  }

  if (normalizedField !== 'books') {
    const books = searchBooks({ query: q, page: 1, pageSize: 3, field: 'all', sort: 'title' });
    if (books.total > 0) {
      hints.alternateModes.push({
        field: 'books',
        total: books.total,
        samples: books.items.slice(0, 3).map((row) => ({
          id: row.id,
          title: row.title,
          authors: row.authors
        }))
      });
      if (!hints.tip) hints.tip = 'try_books';
    }
  }

  hints.didYouMean = findDidYouMeanSuggestions(q, 3);
  return hints;
}

export function searchCatalog({
  query = '', page = 1, pageSize = 24, field = 'books', sort = 'title', order = '',
  genre = '', letter = '', lang = '', format = '', year = 0, minRate = 0, hasSeries = null,
  nameOnly = false,
  /** books: default capped COUNT for free-text (same as search hub) — exact COUNT on Flibusta is too slow */
  totalMode = ''
}) {
  const bookFields = new Set(['books', 'title', 'book-authors', 'book-series', 'genres', 'keywords']);
  const normalizedField = ['books', 'authors', 'series', 'title', 'book-authors', 'book-series', 'genres', 'keywords'].includes(field) ? field : 'books';
  const hasGenre = parseGenreList(genre).length > 0;
  const seriesFlag = parseHasSeries(hasSeries);
  const hasMinRate = Math.floor(Number(minRate) || 0) >= 1;
  const tCatalog = Date.now();
  let result;
  if (normalizedField === 'authors') {
    result = { ...listAuthors({ page, pageSize, query, sort: sort === 'name' ? 'name' : 'count', order, letter }), field: normalizedField };
  } else if (normalizedField === 'series') {
    /* nameOnly прокидывается дальше — для OPDS (искал по сериям, не по авторам)
       это критично для производительности на больших библиотеках. */
    result = { ...listSeries({ page, pageSize, query, sort: sort === 'name' ? 'name' : 'count', order, letter, nameOnly }), field: normalizedField };
  } else {
    const bookFieldMap = {
      books: 'all',
      title: 'title',
      'book-authors': 'authors',
      'book-series': 'series',
      genres: 'genres',
      keywords: 'keywords'
    };
    const bookTotalMode = ['exact', 'capped', 'omit'].includes(totalMode)
      ? totalMode
      : (String(query || '').trim() ? 'capped' : 'exact');
    const bookField = bookFields.has(normalizedField) ? bookFieldMap[normalizedField] : 'all';
    const warmed = (normalizedField === 'books' && bookField === 'all')
      ? takeWarmSearchBooksPage(query, {
        sort, page, pageSize, genre, letter, lang, format, year, minRate, hasSeries: seriesFlag
      })
      : null;
    const bookArgs = {
      query,
      page,
      pageSize,
      field: bookField,
      sort,
      order,
      genre,
      letter,
      lang,
      format,
      year,
      minRate,
      hasSeries: seriesFlag,
      totalMode: bookTotalMode,
      allowTypoRetry: false
    };
    result = {
      ...(warmed || searchBooks(bookArgs)),
      field: normalizedField
    };
    /* Typo retry only after a true miss — not on every searchBooks call. */
    if (
      SEARCH_SYNC_EMPTY_RECOVERY
      && !warmed
      && result.total === 0
      && String(query || '').trim()
    ) {
      const corrected = tryTypoCorrectedSearchBooks({ ...bookArgs, allowTypoRetry: true });
      if (corrected) result = { ...corrected, field: normalizedField };
    }
  }

  const q = String(query || '').trim();
  const tMain = Date.now();
  const hintField = normalizedField === 'authors' || normalizedField === 'series' ? normalizedField : 'books';
  if (q && result.total === 0) {
    result.searchHints = hintField === 'books' && !SEARCH_SYNC_EMPTY_RECOVERY
      ? {
          alternateModes: [],
          didYouMean: findDidYouMeanSuggestions(q, 3),
          tip: null,
          deferred: true
        }
      : buildSearchRecoveryHints({ query: q, field: hintField });
  } else if (
    q
    && hintField === 'books'
    && isWeakBookSearchResult({ total: result.total, items: result.items, query: q })
  ) {
    /* Cheap path: skip alternate-mode rescans; only one did-you-mean suggestion. */
    result.searchHints = {
      alternateModes: [],
      didYouMean: findDidYouMeanSuggestions(q, 1),
      tip: null,
      weak: true
    };
  }

  logSlowSearchSteps('catalog', q, [['main', tMain - tCatalog], ['hints', Date.now() - tMain]]);
  return result;
}

let _stmtGetBookById = null;

/** Заменяет replacement character (вставленный HTML-парсером вместо null byte)
    обратно на оригинальный null byte, чтобы поиск по ID работал корректно. */
function normalizeBookId(id) {
  return String(id || '').replace(/\uFFFD/g, '\0');
}

export function getBookById(id) {
  const normalizedId = normalizeBookId(id);
  _stmtGetBookById ??= db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.file_name AS fileName,
           b.archive_name AS archiveName, b.size, b.lib_id AS libId, b.ext, b.date, b.lang, b.keywords,
           b.lib_rate AS libRate, b.source_id AS sourceId, b.imported_at AS importedAt, b.deleted,
           COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta
    FROM active_books b
    LEFT JOIN sources s ON s.id = b.source_id
    WHERE b.id = ?
  `);
  const row = _stmtGetBookById.get(normalizedId);
  if (!row) return null;
  const sourceFlibusta = effectiveSourceFlibustaForBook(row);
  const book = mapBookListRow({ ...row, sourceFlibusta });
  attachSeriesListsToBooks([book]);
  return book;
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
           b.lib_rate AS libRate, b.source_id AS sourceId, b.imported_at AS importedAt, b.deleted,
           COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta
    FROM active_books b
    LEFT JOIN sources s ON s.id = b.source_id
    WHERE b.id IN (${placeholders})
  `).all(...ids);
  const books = [];
  const result = new Map();
  for (const row of rows) {
    const sourceFlibusta = effectiveSourceFlibustaForBook(row);
    const book = mapBookListRow({ ...row, sourceFlibusta });
    books.push(book);
    result.set(row.id, book);
  }
  attachSeriesListsToBooks(books);
  return result;
}

/**
 * Обновление метаданных книги: title, authors, series, series_no,
 * genres, lang, date, keywords, lib_rate.
 * Пересчитывает sort/search поля, обновляет junction-таблицы и кеши.
 */
export function updateBookMetadata(bookId, { title, authors, series, seriesNo, genres = '', lang = '', date = '', keywords = '', libRate = '' }) {
  const existing = db.prepare('SELECT id FROM books WHERE id = ? AND deleted = 0').get(String(bookId));
  if (!existing) return false;

  const titleNorm = normalizeText(title || '');
  const authorsNorm = normalizeText(authors || '');
  const seriesNorm = normalizeText(series || '');
  const seriesNoNorm = String(seriesNo || '').trim();
  const genresNorm = normalizeText(genres || '');
  const langNorm = String(lang || '').trim().toLowerCase();
  const dateNorm = String(date || '').trim();
  const keywordsNorm = normalizeText(keywords || '');
  /*
   * Шкала рейтинга — 0..5 (см. CSS-классы .cover-rating-1..5, локаль
   * 'book.rating.invalid' и UX звёзд на обложке). Раньше клампилось до 10 —
   * это позволяло сохранить «6/7/8» через прямой POST, и обложка пыталась
   * нарисовать столько же звёздочек без CSS-класса.
   */
  const libRateNum = Math.max(0, Math.min(5, Math.round(Number(libRate) || 0)));

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
  const genresSearchVal = createSortKey(genresNorm);
  const keywordsSearchVal = createSortKey(keywordsNorm);

  const doUpdate = db.transaction(() => {
    // 1. Update books table
    db.prepare(`
      UPDATE books SET
        title = ?, authors = ?, series = ?, series_no = ?,
        genres = ?, lang = ?, date = ?, keywords = ?, lib_rate = ?,
        title_sort = ?, author_sort = ?, series_sort = ?, series_index = ?,
        title_search = ?, authors_search = ?, series_search = ?, genres_search = ?, keywords_search = ?
      WHERE id = ?
    `).run(
      titleNorm, authorsNorm, seriesNorm, seriesNoNorm,
      genresNorm, langNorm, dateNorm, keywordsNorm, libRateNum,
      titleSortVal, authorSortVal, seriesSortVal, seriesIndexVal,
      titleSearchVal, authorsSearchVal, seriesSearchVal, genresSearchVal, keywordsSearchVal,
      String(bookId)
    );

    /*
     * Ключ записей в authors/series_catalog/genres_catalog — это name.toLowerCase()
     * (как делает INPX-импорт, см. resolveAuthorId/resolveSeriesId/resolveGenreId).
     * Если здесь записать с оригинальным регистром — создастся ПАРАЛЛЕЛЬНАЯ
     * запись каталога, и книга после edit «исчезнет» со страницы автора/серии
     * (junction уйдёт к новой записи, а UI ходит к старой по lowercase-имени из URL).
     * Это и есть причина бага «после изменения рейтинга книга пропадает у автора».
     */

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
      const key = token.toLowerCase();
      const displayName = authorDisplayName(token);
      const sortName = createSortKey(authorSortKey(token));
      const searchName = authorSearchName(token);
      upsertAuthor.run(key, displayName, sortName, searchName);
      const authorRow = selectAuthorId.get(key);
      if (authorRow) {
        linkBookAuthor.run(String(bookId), authorRow.id);
      }
    }

    // 3. Rebuild book_series junction
    db.prepare('DELETE FROM book_series WHERE book_id = ?').run(String(bookId));
    if (seriesNorm) {
      const seriesKey = seriesNorm.toLowerCase();
      const displayName = seriesDisplayName(seriesNorm);
      const sortName = seriesSortName(seriesNorm);
      const searchName = seriesSearchName(seriesNorm);
      db.prepare(`
        INSERT INTO series_catalog(name, display_name, sort_name, search_name)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          display_name = excluded.display_name,
          sort_name = excluded.sort_name,
          search_name = excluded.search_name
      `).run(seriesKey, displayName, sortName, searchName);
      const seriesRow = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get(seriesKey);
      if (seriesRow) {
        db.prepare('INSERT OR IGNORE INTO book_series(book_id, series_id, series_no) VALUES(?, ?, ?)').run(String(bookId), seriesRow.id, seriesNoNorm);
      }
    }

    // 4. Rebuild book_genres junction
    db.prepare('DELETE FROM book_genres WHERE book_id = ?').run(String(bookId));
    const genreTokens = splitFacetValues(genresNorm);
    const upsertGenre = db.prepare(`
      INSERT INTO genres_catalog(name, display_name, sort_name, search_name)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        display_name = excluded.display_name,
        sort_name = excluded.sort_name,
        search_name = excluded.search_name
    `);
    const selectGenreId = db.prepare('SELECT id FROM genres_catalog WHERE name = ?');
    const linkBookGenre = db.prepare('INSERT OR IGNORE INTO book_genres(book_id, genre_id) VALUES(?, ?)');
    for (const token of genreTokens) {
      const key = token.toLowerCase();
      const displayName = genreDisplayName(token);
      const sortName = genreSortName(token);
      const searchName = genreSearchName(token);
      upsertGenre.run(key, displayName, sortName, searchName);
      const genreRow = selectGenreId.get(key);
      if (genreRow) {
        linkBookGenre.run(String(bookId), genreRow.id);
      }
    }

    // 5. Invalidate book details cache
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
  /* Инвалидируем in-memory runtime-кеши (facetBooksCache, authorGroupedCache, etc.) —
     иначе админ после edit видит на странице автора/серии прежнюю выборку
     из кеша TTL=60s и думает, что edit ничего не изменил. clearPageDataCache()
     в route-обработчике сбрасывает только pageDataCache из services/cache.js,
     а runtime-кеши в этом модуле он не трогает. */
  clearRuntimeQueryCaches();
  refreshCatalogBookCounts().catch(err => console.error('[refreshCatalogBookCounts] after updateBookMetadata:', err));
  return true;
}

/** Каталог считается без дублей одной книги; кандидаты для «переноса обложки» не ищем. */
export function getBookDuplicateCandidates(_bookId, _limit = 8) {
  return [];
}

// ─── Duplicate detection ─────────────────────────────────────────

const DUP_KEYS_CTE = `
  dup_keys AS (
    SELECT title_sort, COALESCE(author_sort, '') AS author_sort
    FROM active_books
    WHERE title_sort IS NOT NULL AND title_sort != ''
    GROUP BY title_sort, COALESCE(author_sort, '')
    HAVING COUNT(*) > 1
  )`;

const DUP_AUTHOR_FILTER_SQL = `(CAST(? AS INTEGER) = 0 OR instr(dk.author_sort, ?) > 0 OR instr(dk.title_sort, ?) > 0)`;

export function getDuplicateGroups({ page = 1, pageSize = 50, filter = '' } = {}) {
  const needle = createSortKey(filter);
  const hasFilter = needle ? 1 : 0;
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safePageSize = Math.max(1, Math.min(200, Math.floor(Number(pageSize) || 50)));
  const offset = (safePage - 1) * safePageSize;

  /* Пагинация по авторам в SQL: раньше все дубликаты грузились в RAM
     (на 400k копий страница админки зависала и кнопка автоочистки не появлялась). */
  _stmtDupAuthorTotal ??= db.prepare(`
    WITH ${DUP_KEYS_CTE}
    SELECT COUNT(*) AS count FROM (
      SELECT dk.author_sort FROM dup_keys dk
      WHERE ${DUP_AUTHOR_FILTER_SQL}
      GROUP BY dk.author_sort
    )
  `);
  _stmtDupAuthorPage ??= db.prepare(`
    WITH ${DUP_KEYS_CTE},
    author_page AS (
      SELECT dk.author_sort FROM dup_keys dk
      WHERE ${DUP_AUTHOR_FILTER_SQL}
      GROUP BY dk.author_sort
      ORDER BY dk.author_sort ASC
      LIMIT ? OFFSET ?
    )
    SELECT b.id, b.title, b.authors, b.ext, b.lang, b.size, b.file_name, b.archive_name,
           b.title_sort, b.author_sort, b.source_id
    FROM active_books b
    JOIN dup_keys dk ON dk.title_sort = b.title_sort AND dk.author_sort = COALESCE(b.author_sort, '')
    JOIN author_page ap ON ap.author_sort = dk.author_sort
    ORDER BY COALESCE(b.author_sort, '') ASC, b.title_sort ASC, b.ext ASC, b.id ASC
  `);

  const total = Number(_stmtDupAuthorTotal.get(hasFilter, needle, needle)?.count) || 0;
  const rows = _stmtDupAuthorPage.all(hasFilter, needle, needle, safePageSize, offset);
  const groups = [];
  let current = null;
  for (const row of rows) {
    const key = row.author_sort || '';
    if (!current || current.key !== key) {
      const authors = row.authors || '';
      current = { key, title: authors, authors, items: [] };
      groups.push(current);
    }
    current.items.push(row);
  }
  return { total, groups };
}

export function softDeleteBook(bookId) {
  const book = db.prepare('SELECT id, title, authors FROM books WHERE id = ? AND deleted = 0').get(String(bookId));
  if (!book) return 0;
  /* Одна книга — точечный ±1 вместо полного пересчёта (минуты блокировки на большой БД). */
  const wasVisible = isBookInActiveView(bookId);
  db.prepare('UPDATE books SET deleted = 1 WHERE id = ?').run(String(bookId));
  suppressBook(bookId, book.title || '', book.authors || '', 'user');
  if (wasVisible) adjustCatalogCountsForBook(bookId, -1);
  return 1;
}

/**
 * Автоочистка дубликатов: скрываем лишние копии, оставляя лучшую.
 * Совпадения: title_sort+author_sort; тот же lib_id в разных источниках
 * на одном томе архива; ровно две книги с одним названием из двух
 * источников при разном авторе (переименование вроде Кова / Ковалькова).
 * Ранжирование: формат, затем более новый source_id, затем размер.
 *
 * Этапы репортуются через onProgress, между ними — setImmediate, чтобы
 * GET прогресса мог ответить. Сам SQL внутри этапа синхронный.
 */
export async function autoCleanDuplicates({ onProgress } = {}) {
  const t0 = Date.now();
  const report = (stage, extra = {}) => {
    onProgress?.({ stage, ...extra });
  };
  const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

  report('prepare', { percent: 2, deleted: 0, total: 0, groups: 0 });
  await yieldLoop();

  db.exec('DROP TABLE IF EXISTS dup_losers');
  try {
    report('rank', { percent: 8 });
    await yieldLoop();
    db.exec(`
      CREATE TEMP TABLE dup_losers AS
      ${DUP_LOSER_ROWS_SQL}
    `);
    const total = Number(db.prepare('SELECT COUNT(*) AS c FROM dup_losers').get()?.c) || 0;
    report('rank', { percent: 48, total, deleted: 0 });
    await yieldLoop();

    report('hide', { percent: 52, total });
    const totalDeleted = db.prepare(`
      UPDATE books SET deleted = 1
      WHERE deleted = 0 AND id IN (SELECT id FROM dup_losers)
    `).run().changes;
    report('hide', { percent: 62, total, deleted: totalDeleted });
    await yieldLoop();

    report('suppress', { percent: 65, total, deleted: totalDeleted });
    db.exec(`
      INSERT INTO suppressed_books(book_id, title, authors, reason)
      SELECT id, title, authors, 'auto_clean' FROM dup_losers
      WHERE true
      ON CONFLICT(book_id) DO UPDATE SET
        reason = 'auto_clean',
        suppressed_at = CURRENT_TIMESTAMP
    `);
    const groupsCleaned = db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT 1 FROM dup_losers GROUP BY title_sort, author_sort
      )
    `).get()?.c || 0;
    report('suppress', { percent: 72, total, deleted: totalDeleted, groups: groupsCleaned });
    await yieldLoop();

    await refreshCatalogBookCounts({
      onProgress: (p) => report(p.stage, { ...p, total, deleted: totalDeleted, groups: groupsCleaned })
    });

    console.log(`[autoCleanDuplicates] groups=${groupsCleaned} deleted=${totalDeleted} in ${Date.now() - t0}ms`);
    report('done', { percent: 100, total, deleted: totalDeleted, groups: groupsCleaned });
    return { groupsCleaned, totalDeleted };
  } finally {
    try { db.exec('DROP TABLE IF EXISTS dup_losers'); } catch { /* ignore */ }
  }
}

/** Preview: how many books would be deleted by auto-clean */
export function previewAutoClean() {
  /*
   * Раньше использовалось коррелированное EXISTS по active_books на каждую строку,
   * что давало O(N²) и подвешивало процессор на больших библиотеках.
   * Заменено на один проход GROUP BY (через общий кеш сводки).
   */
  const { totalGroups, totalBooks, willDelete } = getDuplicatesSummary();
  return { totalGroups, totalBooks, willDelete: Math.max(0, willDelete) };
}

export function getStats() {
  const cached = getLibraryStatsSnapshot();
  if (cached) return cached;
  return writeLibraryStatsSnapshot();
}

export function listAuthors({ page = 1, pageSize = 50, query = '', sort = 'name', order = '', startsWith = false, letter = '', skipTotal = false }) {
  const offset = (page - 1) * pageSize;
  const parsed = parseSearchOperator(query);
  const needleKey = createSortKey(parsed.value || query);
  const needleTokens = needleKey.split(/\s+/).filter(Boolean);
  const letterNorm = String(letter || '').trim().toLowerCase();

  if (parsed.operator !== '=') {
    const initialPattern = parseAuthorInitialPattern(parsed.value || query);
    if (initialPattern) {
      return paginateAuthorSearchMatches(
        findAuthorsMatchingInitialPattern(initialPattern),
        { offset, pageSize, sort, order, letterNorm, scoreKey: 'initialScore' }
      );
    }

    /* Typeahead must not COUNT or ORDER BY a correlated book-count sum:
       a 2–3 letter prefix walks tens of thousands of authors and blocks the loop. */
    if (skipTotal && parsed.operator !== '*') {
      return suggestAuthorPage(needleKey, pageSize);
    }

    const subsetMatches = findAuthorsMatchingTokenSubset(parsed.value || query);
    if (subsetMatches.length) {
      return paginateAuthorSearchMatches(
        subsetMatches,
        { offset, pageSize, sort, order, letterNorm, scoreKey: 'subsetScore' }
      );
    }
  }

  if (!needleTokens.length) {
    const orderBy = sort === 'name'
      ? applyOrder('COALESCE(a.sort_name, LOWER(a.name)) ASC', order)
      : applyOrder('bookCount DESC, COALESCE(a.sort_name, LOWER(a.name)) ASC', order);
    const whereParts = ['a.book_count > 0', preferredAuthorRowSql('a')];
    const whereParams = [];
    if (letterNorm) {
      whereParts.push('COALESCE(a.sort_name, LOWER(a.name)) LIKE ?');
      whereParams.push(`${letterNorm}%`);
    }
    const whereClause = `WHERE ${whereParts.join(' AND ')}`;
    /* total не зависит от страницы/сортировки — не сканировать 180k авторов на каждую страницу. */
    const memo = _authorsTotalMemo.get(letterNorm);
    const total = memo && (Date.now() - memo.at) < PAGE_CACHE_TTL_MS
      ? memo.total
      : db.prepare(`
        SELECT COUNT(*) AS count FROM authors a ${whereClause}
      `).get(...whereParams).count;
    _authorsTotalMemo.set(letterNorm, { total, at: Date.now() });
    const items = db.prepare(`
      SELECT a.name AS name,
             COALESCE(a.display_name, a.name) AS displayName,
             COALESCE(a.sort_name, LOWER(a.name)) AS sortKey,
             ${authorAliasBookCountSql('a')} AS bookCount
      FROM authors a
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(...whereParams, pageSize, offset);
    return { total, items: withAuthorDisplayNames(items) };
  }

  const surnameExpr = `SUBSTR(COALESCE(a.sort_name, ''), 1, INSTR(COALESCE(a.sort_name, '') || ' ', ' ') - 1)`;
  const whereParams = [];
  const rankCases = [];
  const rankParams = [];
  let whereSQL;
  /** Indexed surname prefix already counted; skip the second full COUNT. */
  let knownTotal = null;

  const countAuthorMatches = (sql, params) => Number(db.prepare(`
    SELECT COUNT(*) AS count FROM authors a
    WHERE (${sql}) AND a.book_count > 0 AND ${preferredAuthorRowSql('a')}
  `).get(...params).count) || 0;

  if (needleTokens.length === 1) {
    const word = needleTokens[0];
    if (parsed.operator === '=') {
      whereSQL = `COALESCE(a.search_name, '') = ?`;
      whereParams.push(word);
    } else if (parsed.operator === '*') {
      whereSQL = `COALESCE(a.search_name, '') LIKE ?`;
      whereParams.push(`%${word}%`);
    } else {
      /* Фамилия — префикс sort_name. Диапазон >= / < берёт idx_authors_sort_name.
         LIKE '%фамилия%' с параметром индекс не использует и читает всех авторов дважды. */
      const sortPrefix = authorColumnPrefixClause('a.sort_name', word);
      whereSQL = sortPrefix.sql;
      whereParams.push(...sortPrefix.params);
      const sortTotal = countAuthorMatches(whereSQL, whereParams);
      if (sortTotal > 0) {
        knownTotal = sortTotal;
      } else {
        const searchPrefix = authorColumnPrefixClause('a.search_name', word);
        const searchTotal = countAuthorMatches(searchPrefix.sql, searchPrefix.params);
        if (searchTotal > 0) {
          whereSQL = searchPrefix.sql;
          whereParams.length = 0;
          whereParams.push(...searchPrefix.params);
          knownTotal = searchTotal;
        } else {
          whereSQL = `COALESCE(a.search_name, '') LIKE ?`;
          whereParams.length = 0;
          whereParams.push(`%${word}%`);
        }
      }
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
      whereSQL = `COALESCE(a.search_name, '') = ?`;
      whereParams.push(needleKey);
    } else {
      const clauses = needleTokens.map(() => `(' ' || COALESCE(a.search_name, '') || ' ') LIKE ?`);
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

  const orderBy = sort === 'name'
    ? applyOrder(`${rankSQL} ASC, COALESCE(a.sort_name, LOWER(a.name)) ASC`, order)
    : applyOrder(`bookCount DESC, ${rankSQL} ASC, COALESCE(a.sort_name, LOWER(a.name)) ASC`, order);

  const items = db.prepare(`
    SELECT a.name AS name,
           COALESCE(a.display_name, a.name) AS displayName,
           COALESCE(a.sort_name, LOWER(a.name)) AS sortKey,
           ${authorAliasBookCountSql('a')} AS bookCount
    FROM authors a
    WHERE (${whereSQL}) AND a.book_count > 0 AND ${preferredAuthorRowSql('a')}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...whereParams, ...rankParams, pageSize, offset);

  if (skipTotal) return { total: offset + items.length, items: withAuthorDisplayNames(items) };

  const total = knownTotal != null
    ? knownTotal
    : db.prepare(`
      SELECT COUNT(*) AS count FROM authors a
      WHERE (${whereSQL}) AND a.book_count > 0 AND ${preferredAuthorRowSql('a')}
    `).get(...whereParams).count;

  return { total, items: withAuthorDisplayNames(items) };
}

/**
 * Список серий: поиск по названию серии; опционально «автор + серия».
 * @param {Object} opts
 * @param {boolean} [opts.nameOnly=false]
 *   Когда true — только название серии (без смешанного «автор + серия»).
 *   Для OPDS «поиск по сериям».
 */
export function listSeries({ page = 1, pageSize = 50, query = '', sort = 'name', order = '', letter = '', nameOnly = false, skipTotal = false } = {}) {
  const offset = (page - 1) * pageSize;
  const parsed = parseSearchOperator(query);
  const needleKey = createSortKey(parsed.value || query);
  const needleTokens = needleKey.split(/\s+/).filter(Boolean);
  const hasQuery = needleTokens.length > 0;
  const letterNorm = String(letter || '').trim().toLowerCase();

  if (!hasQuery) {
    const orderBy = sort === 'name'
      ? applyOrder('COALESCE(s.sort_name, LOWER(s.name)) ASC', order)
      : applyOrder('s.book_count DESC, COALESCE(s.sort_name, LOWER(s.name)) ASC', order);
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

  if (skipTotal && parsed.operator !== '=' && parsed.operator !== '*') {
    const items = suggestRowsByNamePrefix('series_catalog', needleKey, pageSize);
    return { total: items.length, items };
  }

  let nameSearch = null;
  let seriesKnownTotal = null;
  if (needleTokens.length === 1 && parsed.operator !== '=' && parsed.operator !== '*') {
    const word = needleTokens[0];
    const probeSeriesPrefix = (column) => {
      const clause = authorColumnPrefixClause(column, word);
      const total = Number(db.prepare(`
        SELECT COUNT(*) AS count
        FROM series_catalog s
        WHERE ${clause.sql} AND s.book_count > 0
      `).get(...clause.params).count) || 0;
      return total > 0 ? { clause, total } : null;
    };
    /* Одно слово — диапазон по idx_series_catalog_sort_name.
       LIKE '%слово%' индекс не берёт и на слабом CPU читает весь каталог серий. */
    const hit = probeSeriesPrefix('s.sort_name') || probeSeriesPrefix('s.search_name');
    if (hit) {
      nameSearch = { where: hit.clause.sql, params: hit.clause.params };
      seriesKnownTotal = hit.total;
    }
  }
  if (!nameSearch) nameSearch = buildCatalogSearchSql('s.search_name', query);

  /*
   * Режим «Серии» ищет по названию серии. Дополнительно (если !nameOnly):
   * смешанный запрос «автор + название серии» / «серия + автор»
   * («ясинский ник»). Поиск «всех серий автора» по одной фамилии отключён —
   * для этого есть режим «Авторы».
   */
  let mixedWhere = null;
  let mixedWhereParams = [];
  const mixedSeriesKeys = [];
  if (!nameOnly && needleTokens.length >= 2) {
    const mixedParts = [];
    for (const split of resolveAuthorSeriesQuerySplits(needleTokens)) {
      const seriesNameSearch = buildCatalogSearchSql('s.search_name', split.seriesQuery);
      if (!seriesNameSearch || !split.authorNames.length) continue;
      const placeholders = split.authorNames.map(() => '?').join(', ');
      mixedParts.push(`((${seriesNameSearch.where}) AND EXISTS (
        SELECT 1 FROM book_series bs2
        JOIN active_books b2 ON b2.id = bs2.book_id
        JOIN book_authors ba2 ON ba2.book_id = b2.id
        JOIN authors a2 ON a2.id = ba2.author_id
        WHERE bs2.series_id = s.id AND a2.name IN (${placeholders})
      ))`);
      mixedWhereParams.push(...seriesNameSearch.params, ...split.authorNames);
      const seriesKey = createSortKey(split.seriesQuery);
      if (seriesKey && !mixedSeriesKeys.includes(seriesKey)) mixedSeriesKeys.push(seriesKey);
    }
    if (mixedParts.length) mixedWhere = mixedParts.join(' OR ');
  }

  const mainWhereParts = [];
  const mainWhereParams = [];
  if (mixedWhere) {
    mainWhereParts.push(mixedWhere);
    mainWhereParams.push(...mixedWhereParams);
  }
  if (nameSearch) {
    mainWhereParts.push(nameSearch.where);
    mainWhereParams.push(...nameSearch.params);
  }
  if (!mainWhereParts.length) return { total: 0, items: [] };
  const combinedWhere = mainWhereParts.map(p => `(${p})`).join(' OR ');

  const nameRankParts = [];
  const nameRankParams = [];
  if (mixedSeriesKeys.length) {
    for (const mixedSeriesKey of mixedSeriesKeys) {
      nameRankParts.push(`WHEN COALESCE(s.sort_name, '') = ? THEN 0`);
      nameRankParams.push(mixedSeriesKey);
      nameRankParts.push(`WHEN COALESCE(s.sort_name, '') LIKE ? THEN 1`);
      nameRankParams.push(`${mixedSeriesKey}%`);
    }
    if (nameSearch) {
      nameRankParts.push(`WHEN COALESCE(s.sort_name, '') = ? THEN 2`);
      nameRankParams.push(needleKey);
      nameRankParts.push(`WHEN COALESCE(s.sort_name, '') LIKE ? THEN 3`);
      nameRankParams.push(`${needleKey}%`);
    }
  } else if (nameSearch) {
    nameRankParts.push(`WHEN COALESCE(s.sort_name, '') = ? THEN 0`);
    nameRankParams.push(needleKey);
    nameRankParts.push(`WHEN COALESCE(s.sort_name, '') LIKE ? THEN 3`);
    nameRankParams.push(`${needleKey}%`);
  }

  let rankSQL;
  const allRankParams = [];
  if (nameRankParts.length) {
    rankSQL = `CASE ${nameRankParts.join(' ')} ELSE 20 END`;
    allRankParams.push(...nameRankParams);
  } else {
    rankSQL = '0';
  }

  const orderBy = sort === 'name'
    ? applyOrder(`${rankSQL} ASC, COALESCE(s.sort_name, LOWER(s.name)) ASC`, order)
    : applyOrder(`s.book_count DESC, ${rankSQL} ASC, COALESCE(s.sort_name, LOWER(s.name)) ASC`, order);

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

  if (skipTotal) return { total: offset + items.length, items };

  const total = seriesKnownTotal != null
    ? seriesKnownTotal
    : db.prepare(`
      SELECT COUNT(*) AS count FROM series_catalog s
      WHERE (${combinedWhere}) AND s.book_count > 0
    `).get(...mainWhereParams).count;

  return { total, items };
}

function getExcludedGenreSet() {
  const raw = getSetting('excluded_genres');
  return new Set(raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : []);
}

let _stmtGenresGroupedCount = null;
let _stmtGenresGroupedName = null;
export function listGenresGrouped({ sort = 'count' } = {}) {
  const excludedSet = getExcludedGenreSet();
  let rows;
  if (sort === 'name') {
    _stmtGenresGroupedName ??= db.prepare(`
      SELECT g.name, COALESCE(g.display_name, g.name) AS displayName,
             g.book_count AS bookCount
      FROM genres_catalog g
      WHERE g.book_count > 0
      ORDER BY COALESCE(g.sort_name, LOWER(g.name)) ASC
    `);
    rows = _stmtGenresGroupedName.all();
  } else {
    _stmtGenresGroupedCount ??= db.prepare(`
      SELECT g.name, COALESCE(g.display_name, g.name) AS displayName,
             g.book_count AS bookCount
      FROM genres_catalog g
      WHERE g.book_count > 0
      ORDER BY g.book_count DESC
    `);
    rows = _stmtGenresGroupedCount.all();
  }
  return excludedSet.size ? rows.filter(g => !excludedSet.has(g.name)) : rows;
}

export function listGenres({ page = 1, pageSize = 50, query = '', sort = 'name', order = '', letter = '' }) {
  const offset = (page - 1) * pageSize;
  const searchSql = buildCatalogSearchSql('g.search_name', query);
  const letterNorm = String(letter || '').trim().toLowerCase();
  const orderBy = sort === 'name'
    ? applyOrder('COALESCE(g.sort_name, LOWER(g.name)) ASC', order)
    : applyOrder('g.book_count DESC, COALESCE(g.sort_name, LOWER(g.name)) ASC', order);

  const excludedSet = getExcludedGenreSet();
  const excludedArr = [...excludedSet];
  const whereParts = ['g.book_count > 0'];
  const whereParams = [];
  if (excludedArr.length) {
    whereParts.push(`g.name NOT IN (${excludedArr.map(() => '?').join(',')})`);
    whereParams.push(...excludedArr);
  }
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

/**
 * Authors that have at least one book in the given genre, paginated.
 * Used by /facet/genres/:value?view=authors so big genres don't dump 27k books in one flat list.
 */
export function listAuthorsByGenre({ genre, page = 1, pageSize = 50, sort = 'name', order = '' }) {
  const value = String(genre || '').trim();
  if (!value) return { total: 0, items: [] };
  const offset = (page - 1) * pageSize;
  const orderBy = sort === 'name'
    ? applyOrder('COALESCE(a.sort_name, LOWER(a.name)) ASC', order)
    : applyOrder('bookCount DESC, COALESCE(a.sort_name, LOWER(a.name)) ASC', order);

  const total = db.prepare(`
    SELECT COUNT(DISTINCT a.id) AS count
    FROM book_genres bg
    JOIN genres_catalog g ON g.id = bg.genre_id
    JOIN active_books b ON b.id = bg.book_id
    JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id
    WHERE g.name = ?
  `).get(value).count;

  const items = db.prepare(`
    SELECT a.name AS name,
           COALESCE(a.display_name, a.name) AS displayName,
           COUNT(DISTINCT b.id) AS bookCount
    FROM book_genres bg
    JOIN genres_catalog g ON g.id = bg.genre_id
    JOIN active_books b ON b.id = bg.book_id
    JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id
    WHERE g.name = ?
    GROUP BY a.id, a.name, a.display_name, a.sort_name
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(value, pageSize, offset);

  return { total, items };
}

/**
 * Series that have at least one book in the given genre, paginated.
 * Used by /facet/genres/:value?view=series.
 */
export function listSeriesByGenre({ genre, page = 1, pageSize = 50, sort = 'name', order = '' }) {
  const value = String(genre || '').trim();
  if (!value) return { total: 0, items: [] };
  const offset = (page - 1) * pageSize;
  const orderBy = sort === 'name'
    ? applyOrder('COALESCE(s.sort_name, LOWER(s.name)) ASC', order)
    : applyOrder('bookCount DESC, COALESCE(s.sort_name, LOWER(s.name)) ASC', order);

  const total = db.prepare(`
    SELECT COUNT(DISTINCT s.id) AS count
    FROM book_genres bg
    JOIN genres_catalog g ON g.id = bg.genre_id
    JOIN active_books b ON b.id = bg.book_id
    JOIN book_series bs ON bs.book_id = b.id
    JOIN series_catalog s ON s.id = bs.series_id
    WHERE g.name = ?
  `).get(value).count;

  const items = db.prepare(`
    SELECT s.name AS name,
           COALESCE(s.display_name, s.name) AS displayName,
           COUNT(DISTINCT b.id) AS bookCount
    FROM book_genres bg
    JOIN genres_catalog g ON g.id = bg.genre_id
    JOIN active_books b ON b.id = bg.book_id
    JOIN book_series bs ON bs.book_id = b.id
    JOIN series_catalog s ON s.id = bs.series_id
    WHERE g.name = ?
    GROUP BY s.id, s.name, s.display_name, s.sort_name
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(value, pageSize, offset);

  return { total, items };
}

/**
 * Authors that have at least one book in the given language, paginated.
 */
export function listAuthorsByLanguage({ lang, page = 1, pageSize = 50, sort = 'name', order = '' }) {
  const value = String(lang || '').trim();
  if (!value) return { total: 0, items: [] };
  const offset = (page - 1) * pageSize;
  const orderBy = sort === 'name'
    ? applyOrder('COALESCE(a.sort_name, LOWER(a.name)) ASC', order)
    : applyOrder('bookCount DESC, COALESCE(a.sort_name, LOWER(a.name)) ASC', order);

  const total = db.prepare(`
    SELECT COUNT(DISTINCT a.id) AS count
    FROM active_books b
    JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id
    WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?
  `).get(value).count;

  const items = db.prepare(`
    SELECT a.name AS name,
           COALESCE(a.display_name, a.name) AS displayName,
           COUNT(DISTINCT b.id) AS bookCount
    FROM active_books b
    JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id
    WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?
    GROUP BY a.id, a.name, a.display_name, a.sort_name
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(value, pageSize, offset);

  return { total, items };
}

/**
 * Series that have at least one book in the given language, paginated.
 */
export function listSeriesByLanguage({ lang, page = 1, pageSize = 50, sort = 'name', order = '' }) {
  const value = String(lang || '').trim();
  if (!value) return { total: 0, items: [] };
  const offset = (page - 1) * pageSize;
  const orderBy = sort === 'name'
    ? applyOrder('COALESCE(s.sort_name, LOWER(s.name)) ASC', order)
    : applyOrder('bookCount DESC, COALESCE(s.sort_name, LOWER(s.name)) ASC', order);

  const total = db.prepare(`
    SELECT COUNT(DISTINCT s.id) AS count
    FROM active_books b
    JOIN book_series bs ON bs.book_id = b.id
    JOIN series_catalog s ON s.id = bs.series_id
    WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?
  `).get(value).count;

  const items = db.prepare(`
    SELECT s.name AS name,
           COALESCE(s.display_name, s.name) AS displayName,
           COUNT(DISTINCT b.id) AS bookCount
    FROM active_books b
    JOIN book_series bs ON bs.book_id = b.id
    JOIN series_catalog s ON s.id = bs.series_id
    WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?
    GROUP BY s.id, s.name, s.display_name, s.sort_name
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(value, pageSize, offset);

  return { total, items };
}

export function listLanguages({ page = 1, pageSize = 50, query = '', sort = 'name', order = '' }) {
  const offset = (page - 1) * pageSize;
  const normalizedQuery = normalizeText(query).toLowerCase();
  const pattern = normalizedQuery ? `%${normalizedQuery}%` : null;
  const whereClause = pattern
    ? `HAVING LOWER(name) LIKE ? OR LOWER(displayName) LIKE ?`
    : '';
  const orderBy = sort === 'name'
    ? applyOrder('displayName ASC', order)
    : applyOrder('bookCount DESC, displayName ASC', order);

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
const FACET_STMT_CACHE_MAX = 200;

function _getFacetStmts(facet, sort, order = '', author = '') {
  const key = `${facet}|${sort}|${order}|${author ? 'a' : ''}`;
  let entry = _facetStmtCache.get(key);
  if (entry) return entry;

  const rankOrder = "COALESCE(s.flibusta_sidecar, 0) DESC, COALESCE(NULLIF(b.date, ''), b.imported_at) DESC, b.imported_at DESC, b.id DESC";
  const seriesJoin = author ? ' JOIN book_authors ba ON ba.book_id = b.id JOIN authors a ON a.id = ba.author_id' : '';
  const seriesWhere = author ? ` AND ${authorAliasMatchSql('a')}` : '';
  const seriesItemsOrder = sort === 'series'
    ? applyOrder(
      // Числовой номер тома; пустые/нечисловые — в конец
      `CASE WHEN TRIM(COALESCE(bs.series_no, '')) GLOB '[0-9]*' AND TRIM(bs.series_no) != '' THEN CAST(TRIM(bs.series_no) AS INTEGER) ELSE 1000000000 END ASC, TRIM(COALESCE(bs.series_no, '')) ASC, b.title_sort ASC, b.id ASC`,
      order,
    )
    : sort === 'recent' ? rankOrder : resolveBookAliasSort(sort, 'b', order);
  const totalSql = {
    authors: `SELECT COUNT(DISTINCT b.id) AS count FROM book_authors ba JOIN authors a ON a.id = ba.author_id JOIN active_books b ON b.id = ba.book_id WHERE ${authorAliasMatchSql('a')}`,
    series: `SELECT COUNT(DISTINCT b.id) AS count FROM book_series bs JOIN series_catalog s ON s.id = bs.series_id JOIN active_books b ON b.id = bs.book_id${seriesJoin} WHERE s.name = ?${seriesWhere}`,
    genres: `SELECT COUNT(*) AS count FROM book_genres bg JOIN genres_catalog g ON g.id = bg.genre_id JOIN active_books b ON b.id = bg.book_id WHERE g.name = ?`,
    languages: `SELECT COUNT(*) AS count FROM active_books b WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?`
  };
  const itemsSql = {
    authors: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted FROM book_authors ba JOIN authors a ON a.id = ba.author_id JOIN active_books b ON b.id = ba.book_id LEFT JOIN sources s ON s.id = b.source_id WHERE ${authorAliasMatchSql('a')} GROUP BY b.id ORDER BY ${sort === 'recent' ? rankOrder : resolveBookAliasSort(sort, 'b', order)} LIMIT ? OFFSET ?`,
    // seriesNo из book_series (bs) — номер в открытой серии, не primary series_no книги
    series: `SELECT b.id, b.title, b.authors, b.genres, sc.name AS series, bs.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted FROM book_series bs JOIN series_catalog sc ON sc.id = bs.series_id JOIN active_books b ON b.id = bs.book_id${seriesJoin} LEFT JOIN sources s ON s.id = b.source_id WHERE sc.name = ?${seriesWhere} ORDER BY ${seriesItemsOrder} LIMIT ? OFFSET ?`,
    genres: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted FROM book_genres bg JOIN genres_catalog g ON g.id = bg.genre_id JOIN active_books b ON b.id = bg.book_id LEFT JOIN sources s ON s.id = b.source_id WHERE g.name = ? ORDER BY ${sort === 'recent' ? rankOrder : resolveBookAliasSort(sort, 'b', order)} LIMIT ? OFFSET ?`,
    languages: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted FROM active_books b LEFT JOIN sources s ON s.id = b.source_id WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ? ORDER BY ${sort === 'recent' ? rankOrder : resolveBookAliasSort(sort, 'b', order)} LIMIT ? OFFSET ?`
  };
  entry = {
    total: db.prepare(totalSql[facet]),
    items: db.prepare(itemsSql[facet])
  };
  _facetStmtCache.set(key, entry);
  if (_facetStmtCache.size > FACET_STMT_CACHE_MAX) {
    const oldest = _facetStmtCache.keys().next().value;
    if (oldest !== undefined) _facetStmtCache.delete(oldest);
  }
  return entry;
}

/**
 * Лёгкая выборка книг по фасету для рекомендаций.
 * Один SELECT без COUNT, без attachSeriesListsToBooks, без LEFT JOIN sources.
 * Поддерживает только sort='rating' и sort='recent'.
 */
const _recStmtCache = new Map();
const REC_STMT_CACHE_MAX = 50;

export function getBooksByFacetLight(facet, value, limit = 8, sort = 'rating') {
  let resolved = String(value || '');
  if (facet === 'series') {
    resolved = resolveSeriesCatalogName(resolved);
  } else if (facet === 'authors') {
    /* book.authors is display text; authors.name is canonical (фамилия,имя,…). */
    resolved = resolveAuthorName(resolved) || resolved;
  }
  if (!resolved) return [];
  const key = `${facet}|${sort}`;
  let stmt = _recStmtCache.get(key);
  if (!stmt) {
    const ratingOrder = 'b.lib_rate DESC, b.title_sort ASC, b.id DESC';
    const recentOrder = "COALESCE(NULLIF(b.date, ''), b.imported_at) DESC, b.imported_at DESC, b.id DESC";
    const orderBy = sort === 'rating' ? ratingOrder : recentOrder;
    const sql = {
      authors: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted FROM book_authors ba JOIN authors a ON a.id = ba.author_id JOIN active_books b ON b.id = ba.book_id WHERE ${authorAliasMatchSql('a')} GROUP BY b.id ORDER BY ${orderBy} LIMIT ?`,
      series: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted FROM book_series bs JOIN series_catalog sc ON sc.id = bs.series_id JOIN active_books b ON b.id = bs.book_id WHERE sc.name = ? ORDER BY ${orderBy} LIMIT ?`,
      genres: `SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted FROM book_genres bg JOIN genres_catalog g ON g.id = bg.genre_id JOIN active_books b ON b.id = bg.book_id WHERE g.name = ? ORDER BY ${orderBy} LIMIT ?`
    };
    if (!sql[facet]) return [];
    stmt = db.prepare(sql[facet]);
    _recStmtCache.set(key, stmt);
    if (_recStmtCache.size > REC_STMT_CACHE_MAX) {
      const oldest = _recStmtCache.keys().next().value;
      if (oldest !== undefined) _recStmtCache.delete(oldest);
    }
  }
  return stmt.all(resolved, limit).map(mapBookListRow);
}

function buildFacetExtraWhere({ lang = '', format = '', year = 0, minRate = 0, hasSeries = null, genre = '' } = {}) {
  const parts = [];
  const params = [];
  for (const ef of buildCatalogExtraFilters({ lang, format, year, minRate, hasSeries })) {
    parts.push(ef.where.replace(/active_books\./g, 'b.'));
    params.push(...ef.params);
  }
  const genreFilter = buildGenreFilterSql(genre);
  if (genreFilter) {
    parts.push(genreFilter.where.replace(/active_books\./g, 'b.'));
    params.push(...genreFilter.params);
  }
  return {
    sql: parts.length ? ` AND ${parts.join(' AND ')}` : '',
    params,
    active: parts.length > 0
  };
}

function getBooksByFacetFiltered({
  facet, value, page = 1, pageSize = 24, sort = 'title', order = '', author = '',
  lang = '', format = '', year = 0, minRate = 0, hasSeries = null, genre = ''
}) {
  const offset = (page - 1) * pageSize;
  const extra = buildFacetExtraWhere({ lang, format, year, minRate, hasSeries, genre });
  const rankOrder = "COALESCE(s.flibusta_sidecar, 0) DESC, COALESCE(NULLIF(b.date, ''), b.imported_at) DESC, b.imported_at DESC, b.id DESC";
  const listOrder = sort === 'recent'
    ? rankOrder
    : facet === 'series' && sort === 'series'
      ? applyOrder(
        `CASE WHEN TRIM(COALESCE(bs.series_no, '')) GLOB '[0-9]*' AND TRIM(bs.series_no) != '' THEN CAST(TRIM(bs.series_no) AS INTEGER) ELSE 1000000000 END ASC, TRIM(COALESCE(bs.series_no, '')) ASC, b.title_sort ASC, b.id ASC`,
        order,
      )
      : resolveBookAliasSort(sort, 'b', order);

  let fromSql = '';
  const baseParams = [value];
  if (facet === 'authors') {
    fromSql = `FROM book_authors ba JOIN authors a ON a.id = ba.author_id JOIN active_books b ON b.id = ba.book_id LEFT JOIN sources s ON s.id = b.source_id WHERE ${authorAliasMatchSql('a')}`;
  } else if (facet === 'series') {
    const seriesJoin = author ? ' JOIN book_authors ba ON ba.book_id = b.id JOIN authors a ON a.id = ba.author_id' : '';
    const seriesWhere = author ? ` AND ${authorAliasMatchSql('a')}` : '';
    fromSql = `FROM book_series bs JOIN series_catalog sc ON sc.id = bs.series_id JOIN active_books b ON b.id = bs.book_id${seriesJoin} LEFT JOIN sources s ON s.id = b.source_id WHERE sc.name = ?${seriesWhere}`;
    if (author) baseParams.push(author);
  } else if (facet === 'genres') {
    fromSql = `FROM book_genres bg JOIN genres_catalog g ON g.id = bg.genre_id JOIN active_books b ON b.id = bg.book_id LEFT JOIN sources s ON s.id = b.source_id WHERE g.name = ?`;
  } else if (facet === 'languages') {
    fromSql = `FROM active_books b LEFT JOIN sources s ON s.id = b.source_id WHERE COALESCE(NULLIF(b.lang, ''), 'unknown') = ?`;
  } else {
    return { total: 0, items: [] };
  }

  const whereParams = [...baseParams, ...extra.params];
  const total = Number(db.prepare(`SELECT COUNT(DISTINCT b.id) AS count ${fromSql}${extra.sql}`).get(...whereParams).count) || 0;
  if (total === 0 || offset >= total) {
    return { total, items: [] };
  }

  const selectCols = facet === 'series'
    ? `b.id, b.title, b.authors, b.genres, sc.name AS series, bs.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted`
    : `b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted`;

  const items = db.prepare(`
    SELECT ${selectCols}
    ${fromSql}${extra.sql}
    ORDER BY ${listOrder}
    LIMIT ? OFFSET ?
  `).all(...whereParams, pageSize, offset).map(mapBookListRow);

  attachSeriesListsToBooks(items);
  if (facet === 'series') {
    for (const b of items) {
      const match = Array.isArray(b.seriesList)
        ? b.seriesList.find((s) => s.name === value)
        : null;
      if (match) {
        b.series = match.name;
        b.seriesNo = match.seriesNo || '';
      } else {
        b.series = value;
      }
    }
  }
  return { total, items };
}

export function getBooksByFacet({
  facet, value, page = 1, pageSize = 24, sort = 'title', order = '', author = '',
  lang = '', format = '', year = 0, minRate = 0, hasSeries = null, genre = ''
} = {}) {
  if (facet === 'series') {
    value = resolveSeriesCatalogName(String(value || ''));
  } else if (facet === 'authors') {
    value = resolveAuthorName(String(value || '')) || String(value || '');
  }
  const seriesFlag = hasSeries === 0 || hasSeries === 1 ? hasSeries : parseHasSeries(hasSeries);
  const genreKey = parseGenreList(genre).join(',');
  const extra = buildFacetExtraWhere({ lang, format, year, minRate, hasSeries: seriesFlag, genre: genreKey });
  const filterKey = `${lang}|${format}|${year}|${minRate}|${seriesFlag ?? ''}|${genreKey}`;
  const cacheKey = `${facet}|${value}|${sort}|${order}|${page}|${pageSize}|${author}|f:${filterKey}`;
  const cached = readTimedCache(facetBooksCache, cacheKey);
  if (cached) return cached;
  const offset = (page - 1) * pageSize;

  if (extra.active) {
    const result = getBooksByFacetFiltered({
      facet, value, page, pageSize, sort, order, author,
      lang, format, year, minRate, hasSeries: seriesFlag, genre: genreKey
    });
    writeTimedCache(facetBooksCache, cacheKey, result, FACET_CACHE_TTL_MS, 120);
    return result;
  }

  const stmts = _getFacetStmts(facet, sort, order, author);
  if (!stmts.total) return { total: 0, items: [] };

  const totalKey = `${facet}|${value}|${author}`;
  let total = readTimedCache(facetDedupTotalCache, totalKey);
  if (total == null || !Number.isFinite(Number(total))) {
    // book_count в catalog-таблицах — предрассчитанный COUNT по active_books.
    // Для authors/genres/series без доп. фильтра — мгновенный PK-lookup.
    if (!author && facet === 'authors') {
      total = stmts.total.get(value).count;
    } else if (!author && (facet === 'genres' || facet === 'series')) {
      const catalogTable = facet === 'genres' ? 'genres_catalog' : 'series_catalog';
      total = db.prepare(`SELECT book_count AS c FROM ${catalogTable} WHERE name = ?`).get(value)?.c ?? 0;
    } else {
      total = author ? stmts.total.get(value, author).count : stmts.total.get(value).count;
    }
    writeTimedCache(facetDedupTotalCache, totalKey, total, FACET_DEDUP_TOTAL_TTL_MS, 400);
  }

  const items = author
    ? stmts.items.all(value, author, pageSize, offset).map(mapBookListRow)
    : stmts.items.all(value, pageSize, offset).map(mapBookListRow);
  attachSeriesListsToBooks(items);
  if (facet === 'series') {
    for (const b of items) {
      const match = Array.isArray(b.seriesList)
        ? b.seriesList.find((s) => s.name === value)
        : null;
      if (match) {
        b.series = match.name;
        b.seriesNo = match.seriesNo || '';
      } else {
        b.series = value;
      }
    }
  }
  const result = { total, items };
  writeTimedCache(facetBooksCache, cacheKey, result, FACET_CACHE_TTL_MS, 120);
  return result;
}

/**
 * Параллельные HTTP-запросы к одной странице фасета (двойной клик, префетч) — один тяжёлый запрос к SQLite.
 */
export async function getBooksByFacetCoalesced({
  facet, value, page = 1, pageSize = 24, sort = 'title', order = '', author = '',
  lang = '', format = '', year = 0, minRate = 0, hasSeries = null, genre = ''
} = {}) {
  let v = String(value || '');
  if (facet === 'series') {
    v = resolveSeriesCatalogName(v);
  } else if (facet === 'authors') {
    v = resolveAuthorName(v) || v;
  }
  const seriesFlag = hasSeries === 0 || hasSeries === 1 ? hasSeries : parseHasSeries(hasSeries);
  const genreKey = parseGenreList(genre).join(',');
  const filterKey = `${lang}|${format}|${year}|${minRate}|${seriesFlag ?? ''}|${genreKey}`;
  const cacheKey = `${facet}|${v}|${sort}|${order}|${page}|${pageSize}|${author}|f:${filterKey}`;
  const cached = readTimedCache(facetBooksCache, cacheKey);
  if (cached) return cached;
  let shared = facetBooksInflight.get(cacheKey);
  if (!shared) {
    shared = new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(getBooksByFacet({
            facet, value: v, page, pageSize, sort, order, author,
            lang, format, year, minRate, hasSeries: seriesFlag, genre: genreKey
          }));
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
    libRate: row.libRate,
    archiveName: row.archiveName
  };
  const book = mapBookListRow(bookRow);
  book._sortDate = row.sortDate || row.importedAt || '';
  book._seriesIndex = row.seriesIndex != null && row.seriesIndex !== '' ? row.seriesIndex : '';
  return book;
}

function applyAuthorPageBookSort(books, sort, order = '') {
  const arr = [...books];
  const desc = order === 'desc';
  if (sort === 'title' || sort === 'author') {
    arr.sort((a, b) => {
      const cmp = String(a.title).localeCompare(String(b.title), undefined, { sensitivity: 'base', numeric: true });
      return desc ? -cmp : cmp;
    });
  } else if (sort === 'series') {
    arr.sort((a, b) => {
      const sa = String(a.series || '');
      const sb = String(b.series || '');
      if (sa !== sb) {
        const cmp = sa.localeCompare(sb);
        return desc ? -cmp : cmp;
      }
      const na = parseFloat(String(a.seriesNo || '').replace(/[^\d.]/g, '')) || 0;
      const nb = parseFloat(String(b.seriesNo || '').replace(/[^\d.]/g, '')) || 0;
      const cmp = na - nb || String(a.title).localeCompare(String(b.title), undefined, { numeric: true });
      return desc ? -cmp : cmp;
    });
  } else {
    arr.sort((a, b) => {
      const da = Date.parse(String(a._sortDate || '')) || 0;
      const db = Date.parse(String(b._sortDate || '')) || 0;
      const cmp = db - da || Number(b.id) - Number(a.id);
      return desc ? -cmp : cmp;
    });
  }
  return arr;
}

function stripAuthorPageBookMeta(book) {
  const { _sortDate, _seriesIndex, ...rest } = book;
  return rest;
}

function buildAuthorSeriesGroupEntry(name, displayNameFromOrder, g, sort, order = '') {
  if (!g?.books?.length) return null;
  // «По количеству» меняет порядок серий, книги внутри серии остаются по номеру тома.
  const bookSort = sort === 'count' ? 'series' : sort;
  const bookOrder = sort === 'count' ? '' : order;
  const sorted = applyAuthorPageBookSort(g.books, bookSort, bookOrder);
  const latestMs = Math.max(0, ...sorted.map((b) => Date.parse(String(b._sortDate || '')) || 0));
  const books = sorted.map(stripAuthorPageBookMeta);
  const displayName = displayNameFromOrder || g.displayName;
  return { name, displayName, books, _latestMs: latestMs };
}

let _stmtAuthorGroupedRowCount = null;
let _stmtAuthorGroupedTotal = null;
function getAuthorGroupedFetchLimit(authorName, totalBooks) {
  if (totalBooks <= 0) return 0;
  _stmtAuthorGroupedRowCount ??= db.prepare(`
    SELECT COUNT(*) AS c
    FROM book_authors ba
    JOIN authors a ON a.id = ba.author_id
    JOIN active_books b ON b.id = ba.book_id
    LEFT JOIN book_series bs ON bs.book_id = b.id
    WHERE ${authorAliasMatchSql('a')}
  `);
  const expanded = _stmtAuthorGroupedRowCount.get(authorName)?.c ?? totalBooks;
  return Math.min(AUTHOR_GROUPED_FETCH_CAP, Math.max(expanded, totalBooks, 1));
}

function authorSeriesNameCmp(a, b) {
  return String(a.displayName || a.name).localeCompare(String(b.displayName || b.name), undefined, {
    sensitivity: 'base',
    numeric: true
  });
}

function orderAuthorSeriesGroups(series, sort, order = '') {
  if (sort === 'count') {
    const dir = order === 'asc' ? 1 : -1;
    return [...series].sort(
      (a, b) => dir * ((a.books?.length || 0) - (b.books?.length || 0)) || authorSeriesNameCmp(a, b)
    );
  }
  if (sort === 'recent') {
    const dir = order === 'asc' ? 1 : -1;
    return [...series].sort(
      (a, b) => dir * (a._latestMs - b._latestMs) || authorSeriesNameCmp(a, b)
    );
  }
  const dir = order === 'desc' ? -1 : 1;
  return [...series].sort((a, b) => dir * authorSeriesNameCmp(a, b));
}

/** Книги автора: серии (по порядку каталога) и книги вне серий. */
export function getAuthorBooksGrouped(authorName, sort = 'title', order = '', { page = 1, pageSize = 48 } = {}) {
  void page;
  void pageSize;
  const cacheKey = `${authorName}|${sort}|${order}`;
  const cached = readTimedCache(authorGroupedCache, cacheKey);
  if (cached) return cached;
  _stmtAuthorGroupedTotal ??= db.prepare(`
    SELECT COUNT(DISTINCT ba.book_id) AS c
    FROM book_authors ba
    JOIN authors a ON a.id = ba.author_id
    JOIN active_books b ON b.id = ba.book_id
    WHERE ${authorAliasMatchSql('a')}
  `);
  const totalBooks = _stmtAuthorGroupedTotal.get(authorName)?.c ?? 0;
  // Guard: если у автора нет книг — не гоняем тяжёлые SQL-запросы через active_books VIEW.
  if (totalBooks === 0) {
    const empty = { series: [], standaloneBooks: [], total: 0 };
    writeTimedCache(authorGroupedCache, cacheKey, empty, AUTHOR_GROUPED_CACHE_TTL_MS, 20);
    return empty;
  }
  const authorBooksFrom = `
      FROM book_authors ba
      JOIN authors a ON a.id = ba.author_id
      JOIN active_books b ON b.id = ba.book_id
      LEFT JOIN book_series bs ON bs.book_id = b.id
      LEFT JOIN series_catalog s ON s.id = bs.series_id
      LEFT JOIN sources src ON src.id = b.source_id
      WHERE ${authorAliasMatchSql('a')}
  `;

  const fetchLimit = getAuthorGroupedFetchLimit(authorName, totalBooks);

  const rows = db.prepare(`
    SELECT
      b.id, b.title, b.authors, b.genres, b.series,
      COALESCE(NULLIF(bs.series_no, ''), b.series_no) AS seriesNo,
      b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted,
      s.name AS seriesCatalogName,
      COALESCE(s.display_name, s.name) AS seriesDisplayName,
      COALESCE(NULLIF(bs.series_no, ''), b.series_index) AS seriesIndex,
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
    WHERE ${authorAliasMatchSql('a')}
    GROUP BY s.id, s.name, s.display_name, s.sort_name
    ORDER BY seriesSortMin ASC, COALESCE(s.sort_name, s.name) ASC
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
    .map(({ name, displayName }) => buildAuthorSeriesGroupEntry(name, displayName, bySeries.get(name), sort, order))
    .filter(Boolean);

  const orderedNames = new Set(series.map((s) => s.name));
  const extraNames = [...bySeries.keys()].filter((n) => !orderedNames.has(n)).sort();
  for (const name of extraNames) {
    const entry = buildAuthorSeriesGroupEntry(name, null, bySeries.get(name), sort, order);
    if (entry) series.push(entry);
  }

  series = orderAuthorSeriesGroups(series, sort, order);
  /* Additive `books` on each series — used by Flibusta-style list view; series cards use bookCount. */
  const seriesOut = series.map(({ name, displayName, books, _latestMs: _m }) => ({
    name,
    displayName,
    bookCount: books.length,
    books
  }));

  attachSeriesListsToBooks(standalone);
  const standaloneBooks = applyAuthorPageBookSort(standalone, sort, order).map(stripAuthorPageBookMeta);
  const result = { series: seriesOut, standaloneBooks, total: totalBooks };
  writeTimedCache(authorGroupedCache, cacheKey, result, AUTHOR_GROUPED_CACHE_TTL_MS, 20);
  return result;
}

/**
 * То же, что getAuthorBooksGrouped, но параллельные запросы с тем же ключом ждут один расчёт.
 */
export async function getAuthorBooksGroupedCoalesced(authorName, sort = 'title', order = '', { page = 1, pageSize = 48 } = {}) {
  void page;
  void pageSize;
  const cacheKey = `${authorName}|${sort}|${order}`;
  const cached = readTimedCache(authorGroupedCache, cacheKey);
  if (cached) return cached;
  let shared = authorGroupedInflight.get(cacheKey);
  if (!shared) {
    shared = new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          resolve(getAuthorBooksGrouped(authorName, sort, order, { page, pageSize }));
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

let _stmtAuthorFlibustaSourceId = null;
export function getAuthorFlibustaSourceId(authorName) {
  _stmtAuthorFlibustaSourceId ??= db.prepare(`
    SELECT b.source_id AS sourceId
    FROM book_authors ba
    JOIN authors a ON a.id = ba.author_id
    JOIN active_books b ON b.id = ba.book_id
    JOIN sources s ON s.id = b.source_id
    WHERE ${authorAliasMatchSql('a')}
    ORDER BY COALESCE(s.flibusta_sidecar, 0) DESC, b.id
    LIMIT 1
  `);
  const row = _stmtAuthorFlibustaSourceId.get(authorName);
  return row?.sourceId != null ? row.sourceId : null;
}

export function getAllBookIdsByFacet(facet, value) {
  if (facet === 'series') {
    value = resolveSeriesCatalogName(String(value || ''));
  } else if (facet === 'authors') {
    value = resolveAuthorName(String(value || '')) || String(value || '');
  }
  const queries = {
    authors: `
      SELECT b.id FROM book_authors ba
      JOIN authors a ON a.id = ba.author_id
      JOIN active_books b ON b.id = ba.book_id
      WHERE ${authorAliasMatchSql('a')}
      GROUP BY b.id
      ORDER BY MIN(b.series_sort) ASC, CAST(MIN(b.series_index) AS INTEGER) ASC, MIN(b.title_sort) ASC`,
    series: `
      SELECT b.id FROM book_series bs
      JOIN series_catalog s ON s.id = bs.series_id
      JOIN active_books b ON b.id = bs.book_id
      WHERE s.name = ?
      ORDER BY CAST(bs.series_no AS INTEGER) ASC, b.title_sort ASC`
  };
  const query = queries[facet];
  if (!query) return [];
  return db.prepare(query).all(value).map((row) => row.id);
}

const EMPTY_FACET_SUMMARY = {
  relatedTitle: '',
  relatedPath: '',
  relatedItems: [],
  secondaryTitle: '',
  secondaryPath: '',
  secondaryItems: []
};

let _stmtFacetCountAuthor = null;
let _stmtFacetCountSeries = null;
let _stmtFacetCountGenre = null;
let _stmtFacetCountLang = null;
/**
 * Дешёвая оценка размера фасета (книг): из предрассчитанного book_count
 * (authors/series_catalog/genres_catalog) либо индексированного COUNT по языку.
 * Нужна, чтобы не строить тяжёлые панели «связанных» для гигантских фасетов.
 */
function facetEntityBookCount(facet, v) {
  try {
    if (facet === 'authors') {
      _stmtAuthorAliasBookCount ??= db.prepare(`
        SELECT COALESCE(SUM(a.book_count), 0) AS c
        FROM authors a
        WHERE ${authorAliasMatchSql('a')}
      `);
      return _stmtAuthorAliasBookCount.get(v)?.c ?? 0;
    }
    if (facet === 'series') {
      _stmtFacetCountSeries ??= db.prepare('SELECT book_count AS c FROM series_catalog WHERE name = ?');
      return _stmtFacetCountSeries.get(v)?.c ?? 0;
    }
    if (facet === 'genres') {
      _stmtFacetCountGenre ??= db.prepare('SELECT book_count AS c FROM genres_catalog WHERE name = ?');
      return _stmtFacetCountGenre.get(v)?.c ?? 0;
    }
    if (facet === 'languages') {
      _stmtFacetCountLang ??= db.prepare("SELECT COUNT(*) AS c FROM active_books WHERE COALESCE(NULLIF(lang, ''), 'unknown') = ?");
      return _stmtFacetCountLang.get(v)?.c ?? 0;
    }
  } catch {
    /* при недоступности счётчика не блокируем — вернём 0 (guard не сработает) */
  }
  return 0;
}

export function getFacetSummary(facet, value) {
  let v = String(value || '');
  if (facet === 'series') {
    v = resolveSeriesCatalogName(String(value || ''));
  }
  const summaryKey = `${facet}|${v}`;
  const summaryHit = readTimedCache(facetSummaryCache, summaryKey);
  if (summaryHit) return summaryHit;

  // Если у фасета 0 книг — не гоняем SQL.
  const fbc = facetEntityBookCount(facet, v);
  if (fbc === 0) {
    writeTimedCache(facetSummaryCache, summaryKey, EMPTY_FACET_SUMMARY, FACET_SUMMARY_CACHE_TTL_MS, 150);
    return EMPTY_FACET_SUMMARY;
  }
  // Для огромных фасетов (жанр/язык на сотни тысяч книг) панели «связанных»
  // строить нельзя: GROUP BY по всему фасету — секунды синхронной блокировки.
  if (FACET_SUMMARY_MAX_BOOKS > 0 && fbc > FACET_SUMMARY_MAX_BOOKS) {
    writeTimedCache(facetSummaryCache, summaryKey, EMPTY_FACET_SUMMARY, FACET_SUMMARY_CACHE_TTL_MS, 150);
    return EMPTY_FACET_SUMMARY;
  }

  if (facet === 'authors') {
    const series = db.prepare(`
      SELECT s.name AS name, COALESCE(s.display_name, s.name) AS displayName, COUNT(*) AS bookCount
      FROM book_authors ba
      JOIN authors a ON a.id = ba.author_id
      JOIN active_books b ON b.id = ba.book_id
      JOIN book_series bs ON bs.book_id = b.id
      JOIN series_catalog s ON s.id = bs.series_id
      WHERE ${authorAliasMatchSql('a')}
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
      WHERE ${authorAliasMatchSql('a')}
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
    writeTimedCache(facetSummaryCache, summaryKey, authorSummary, FACET_SUMMARY_CACHE_TTL_MS, 150);
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
    writeTimedCache(facetSummaryCache, summaryKey, seriesSummary, FACET_SUMMARY_CACHE_TTL_MS, 150);
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
    writeTimedCache(facetSummaryCache, summaryKey, genreSummary, FACET_SUMMARY_CACHE_TTL_MS, 150);
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
    writeTimedCache(facetSummaryCache, summaryKey, langSummary, FACET_SUMMARY_CACHE_TTL_MS, 150);
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
  writeTimedCache(facetSummaryCache, summaryKey, emptySummary, FACET_SUMMARY_CACHE_TTL_MS, 150);
  return emptySummary;
}

/**
 * Novinki window in days, relative to the newest INPX catalog `date` in the DB
 * (not wall-clock — offline dumps stay meaningful after import).
 */
const RECENT_ARRIVAL_WINDOW_DAYS = 30;

const ISO_DATE_PRED = (alias = '') => {
  const col = alias ? `${alias}.date` : 'date';
  return `${col} IS NOT NULL AND LENGTH(TRIM(${col})) >= 10 AND SUBSTR(${col}, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;
};

let _recentCutoffMemo = null;

/* Самая новая дата каталога меняется только при индексации; memo сбрасывается вместе
   с prepared statements (view rebuild) и по TTL — иначе это полный скан на каждую страницу новинок. */
function resolveRecentCatalogCutoff() {
  if (_recentCutoffMemo && (Date.now() - _recentCutoffMemo.at) < PAGE_CACHE_TTL_MS) return _recentCutoffMemo.bounds;
  const maxDate = db.prepare(`
    SELECT MAX(SUBSTR(date, 1, 10)) AS d
    FROM active_books
    WHERE ${ISO_DATE_PRED()}
  `).get()?.d;
  const cutoff = maxDate
    ? db.prepare(`SELECT date(?, ?) AS d`).get(maxDate, `-${RECENT_ARRIVAL_WINDOW_DAYS} days`)?.d
    : null;
  const bounds = maxDate && cutoff ? { maxDate, cutoff } : null;
  _recentCutoffMemo = { bounds, at: Date.now() };
  return bounds;
}

/**
 * Books newly added to the catalog (INPX `date`), not the full library / reindex stamp.
 * Additive catalog filters: genre (OR), lang, format, year, minRate, hasSeries.
 */
export function getRecentArrivals({
  page = 1,
  pageSize = 24,
  sort = 'recent',
  order = '',
  genre = '',
  lang = '',
  format = '',
  year = 0,
  minRate = 0,
  hasSeries = null
} = {}) {
  const offset = Math.max(0, (Math.max(1, page) - 1) * pageSize);
  const limit = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 24)));
  const bounds = resolveRecentCatalogCutoff();
  if (!bounds) {
    return { total: 0, items: [] };
  }

  const whereParts = [`${ISO_DATE_PRED('b')}`, 'SUBSTR(b.date, 1, 10) >= ?'];
  const whereParams = [bounds.cutoff];
  const genreFilter = buildGenreFilterSql(genre);
  if (genreFilter) {
    whereParts.push(genreFilter.where.replace(/active_books\./g, 'b.'));
    whereParams.push(...genreFilter.params);
  }
  for (const ef of buildCatalogExtraFilters({ lang, format, year, minRate, hasSeries })) {
    whereParts.push(ef.where.replace(/active_books\./g, 'b.'));
    whereParams.push(...ef.params);
  }
  const whereSql = whereParts.join(' AND ');

  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM active_books b WHERE ${whereSql}
  `).get(...whereParams).count) || 0;

  if (total === 0 || offset >= total) {
    return { total, items: [] };
  }

  const listOrderBy = sort === 'recent' || !sort
    ? applyOrder('SUBSTR(b.date, 1, 10) DESC, b.id DESC', order)
    : resolveBookAliasSort(sort, 'b', order);

  const items = db.prepare(`
    SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang,
           b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
    FROM active_books b
    WHERE ${whereSql}
    ORDER BY ${listOrderBy}
    LIMIT ? OFFSET ?
  `).all(...whereParams, limit, offset).map(mapBookListRow);

  attachSeriesListsToBooks(items);
  attachCachedAnnotationsToBooks(items);
  return { total, items };
}

let _stmtLibSections = null;
export function getLibrarySections() {
  const POOL_SIZE = 200;
  const bounds = resolveRecentCatalogCutoff();
  if (!bounds) {
    return { newest: [], titles: [], authors: [], series: [], genres: [], languages: [] };
  }
  _stmtLibSections ??= db.prepare(`
    SELECT id, title, authors, genres, series, series_no AS seriesNo, ext, lang, lib_rate AS libRate, archive_name AS archiveName
    FROM active_books
    WHERE ${ISO_DATE_PRED()} AND SUBSTR(date, 1, 10) >= ?
    ORDER BY SUBSTR(date, 1, 10) DESC, id DESC
    LIMIT ?
  `);
  const pool = _stmtLibSections.all(bounds.cutoff, POOL_SIZE).map(mapBookListRow);
  return {
    newest: pool,
    titles: [],
    authors: [],
    series: [],
    genres: [],
    languages: []
  };
}

let _stmtHasContinue = null;
/** Быстрая проверка наличия «продолжить чтение» без тяжёлого COUNT/JOIN.
 *  Книги со статусом «Прочитано» не считаются — для них есть отдельный раздел. */
export function hasContinueBooks(username) {
  if (!username) return false;
  _stmtHasContinue ??= db.prepare(`
    SELECT 1
    FROM reading_history rh
    JOIN active_books b ON b.id = rh.book_id
    WHERE rh.username = ?
      AND NOT EXISTS (
        SELECT 1 FROM read_books rb
        WHERE rb.username = rh.username AND rb.book_id = rh.book_id
      )
    LIMIT 1
  `);
  return !!_stmtHasContinue.get(username);
}

let _stmtContinueCount = null;
let _stmtContinueItems = null;
let _stmtReadSeriesCount = null;
let _stmtReadSeriesItems = null;
let _stmtReadViewCount = null;
let _stmtReadViewItems = null;
let _stmtCachedBookAnnotation = null;

function attachCachedAnnotationsToBooks(books) {
  if (!Array.isArray(books) || !books.length) return books;
  _stmtCachedBookAnnotation ??= db.prepare(
    `SELECT annotation, annotation_is_html AS annotationIsHtml FROM book_details_cache WHERE book_id = ?`
  );
  for (const book of books) {
    if (!book?.id || book.annotation) continue;
    try {
      const row = _stmtCachedBookAnnotation.get(String(book.id));
      if (row?.annotation) {
        const annotation = normalizeCachedAnnotation(row.annotation, row.annotationIsHtml);
        book.annotation = annotation.annotation;
        book.annotationIsHtml = annotation.annotationIsHtml;
      }
    } catch { /* ignore */ }
  }
  return books;
}

export function getLibraryView(view = 'recent', {
  page = 1,
  pageSize = 24,
  username = '',
  type = '',
  sort = 'recent',
  order = '',
  genre = '',
  lang = '',
  format = '',
  year = 0,
  minRate = 0,
  hasSeries = null
} = {}) {
  const offset = (page - 1) * pageSize;

  if (view === 'continue') {
    const normalizedUsername = String(username || '').trim();
    if (!normalizedUsername) {
      return { total: 0, items: [] };
    }

    _stmtContinueCount ??= db.prepare(`
      SELECT COUNT(DISTINCT rh.book_id) AS count
      FROM reading_history rh
      JOIN active_books b ON b.id = rh.book_id
      WHERE rh.username = ?
        AND NOT EXISTS (
          SELECT 1 FROM read_books rb
          WHERE rb.username = rh.username AND rb.book_id = rh.book_id
        )
    `);
    const total = _stmtContinueCount.get(normalizedUsername).count;

    const orderBy = sort === 'rating'
      ? applyOrder('b.lib_rate DESC, b.title_sort ASC, b.id DESC', order)
      : applyOrder('rh.last_opened_at DESC, rh.open_count DESC, b.id DESC', order);
    const items = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted,
             COALESCE(rp.progress, 0) AS readProgress
      FROM (
        SELECT rh.book_id, MAX(rh.last_opened_at) AS last_opened_at, SUM(COALESCE(rh.open_count, 0)) AS open_count
        FROM reading_history rh
        WHERE rh.username = ?
          AND NOT EXISTS (
            SELECT 1 FROM read_books rb
            WHERE rb.username = rh.username AND rb.book_id = rh.book_id
          )
        GROUP BY rh.book_id
      ) rh
      JOIN active_books b ON b.id = rh.book_id
      LEFT JOIN reading_positions rp ON rp.book_id = b.id AND rp.username = ?
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(normalizedUsername, normalizedUsername, pageSize, offset).map(mapBookListRow);
    attachSeriesListsToBooks(items);
    attachCachedAnnotationsToBooks(items);
    return { total, items };
  }

  if (view === 'read') {
    const normalizedUsername = String(username || '').trim();
    if (!normalizedUsername) {
      return { total: 0, items: [] };
    }

    if (type === 'series') {
      _stmtReadSeriesCount ??= db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT ab.series
          FROM active_books ab
          LEFT JOIN read_books rb ON rb.username = ? AND rb.book_id = ab.id
          WHERE ab.series IS NOT NULL AND ab.series != ''
          GROUP BY ab.series
          HAVING COUNT(*) = COUNT(rb.book_id)
        )
      `);
      const totalRow = _stmtReadSeriesCount.get(normalizedUsername);

      _stmtReadSeriesItems ??= db.prepare(`
        SELECT ab.series AS name, COUNT(*) AS bookCount
        FROM active_books ab
        LEFT JOIN read_books rb ON rb.username = ? AND rb.book_id = ab.id
        WHERE ab.series IS NOT NULL AND ab.series != ''
        GROUP BY ab.series
        HAVING COUNT(*) = COUNT(rb.book_id)
        ORDER BY ab.series COLLATE NOCASE
        LIMIT ? OFFSET ?
      `);
      const items = _stmtReadSeriesItems.all(normalizedUsername, pageSize, offset);

      return { total: totalRow.count, items, itemType: 'series' };
    }

    _stmtReadViewCount ??= db.prepare(`
      SELECT COUNT(*) AS count
      FROM read_books rb
      JOIN active_books b ON b.id = rb.book_id
      WHERE rb.username = ?
    `);
    const total = _stmtReadViewCount.get(normalizedUsername).count;

    const orderBy = sort === 'rating'
      ? applyOrder('b.lib_rate DESC, b.title_sort ASC, b.id DESC', order)
      : applyOrder('rb.created_at DESC', order);
    const items = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
      FROM read_books rb
      JOIN active_books b ON b.id = rb.book_id
      WHERE rb.username = ?
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `).all(normalizedUsername, pageSize, offset).map(mapBookListRow);
    attachSeriesListsToBooks(items);
    return { total, items };
  }

  // Новинки: окно по INPX date + те же additive-фильтры, что у /api/catalog.
  return getRecentArrivals({ page, pageSize, sort, order, genre, lang, format, year, minRate, hasSeries });
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

  const prefixKey = prefix ? createSortKey(prefix) : '';
  const effectiveDepth = depth || (prefixKey.length + 1);

  const prefixCond = prefixKey ? `AND c.search_name LIKE ? || '%'` : '';
  let sql, params;
  if (genre) {
    sql = `SELECT SUBSTR(c.search_name, 1, ?) AS prefix_val, COUNT(DISTINCT c.id) AS cnt
           FROM ${conf.table} c
           JOIN ${conf.join} j ON j.${conf.joinCol} = c.id
           JOIN active_books b ON b.id = j.book_id
           JOIN book_genres bg ON bg.book_id = b.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           WHERE 1=1 ${prefixCond}
           GROUP BY prefix_val
           ORDER BY prefix_val`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = prefixKey
      ? [effectiveDepth, ...genreParams, prefixKey]
      : [effectiveDepth, ...genreParams];
  } else {
    sql = `SELECT SUBSTR(c.search_name, 1, ?) AS prefix_val, COUNT(DISTINCT c.id) AS cnt
           FROM ${conf.table} c
           JOIN ${conf.join} j ON j.${conf.joinCol} = c.id
           JOIN active_books b ON b.id = j.book_id
           WHERE 1=1 ${prefixCond}
           GROUP BY prefix_val
           ORDER BY prefix_val`;
    params = prefixKey
      ? [effectiveDepth, prefixKey]
      : [effectiveDepth];
  }

  const rows = db.prepare(sql).all(...params);
  let totalCount = 0;
  for (const r of rows) totalCount += r.cnt;

  if (totalCount <= 50) {
    return opdsSearchFacet(facet, prefixKey, genre);
  }

  // Auto-deepen if too few prefixes (like inpx-web recursive depth)
  if (prefixKey && rows.length < 10 && effectiveDepth < 6) {
    return opdsQuery(facet, prefix, effectiveDepth + 1, genre);
  }

  return sortOpdsPrefixRows(rows).map(r => ({
    id: r.prefix_val,
    title: r.prefix_val.toUpperCase().replace(/ /g, '·'),
    prefix: r.prefix_val,
    count: r.cnt,
    isNav: true
  }));
}

function isCyrillicChar(c) {
  const cp = c.codePointAt(0);
  return (cp >= 0x0400 && cp <= 0x04FF) || (cp >= 0x0500 && cp <= 0x052F);
}

function isLatinChar(c) {
  const cp = c.codePointAt(0);
  return (cp >= 0x0041 && cp <= 0x005A) || (cp >= 0x0061 && cp <= 0x007A);
}

function sortOpdsPrefixRows(rows) {
  return rows.slice().sort((a, b) => {
    const ca = a.prefix_val.charAt(0);
    const cb = b.prefix_val.charAt(0);
    const cyrA = isCyrillicChar(ca);
    const cyrB = isCyrillicChar(cb);
    if (cyrA !== cyrB) return cyrA ? -1 : 1;
    const latA = !cyrA && isLatinChar(ca);
    const latB = !cyrB && isLatinChar(cb);
    if (latA !== latB) return latA ? -1 : 1;
    return a.prefix_val.localeCompare(b.prefix_val, 'ru');
  });
}

function opdsTitleQuery(prefix = '', depth = 0, genre = '') {
  const prefixKey = prefix ? createSortKey(prefix) : '';
  const effectiveDepth = depth || (prefixKey.length + 1);

  const prefixCond = prefixKey ? `AND b.title_search LIKE ? || '%'` : '';
  let sql, params;
  if (genre) {
    sql = `SELECT SUBSTR(b.title_search, 1, ?) AS prefix_val, COUNT(*) AS cnt
           FROM active_books b
           JOIN book_genres bg ON bg.book_id = b.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           WHERE 1=1 ${prefixCond}
           GROUP BY prefix_val ORDER BY prefix_val`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = prefixKey
      ? [effectiveDepth, ...genreParams, prefixKey]
      : [effectiveDepth, ...genreParams];
  } else {
    sql = `SELECT SUBSTR(b.title_search, 1, ?) AS prefix_val, COUNT(*) AS cnt
           FROM active_books b
           WHERE 1=1 ${prefixCond}
           GROUP BY prefix_val ORDER BY prefix_val`;
    params = prefixKey
      ? [effectiveDepth, prefixKey]
      : [effectiveDepth];
  }

  const rows = db.prepare(sql).all(...params);
  let totalCount = 0;
  for (const r of rows) totalCount += r.cnt;

  if (totalCount <= 50) {
    return opdsTitleSearch(prefixKey, genre);
  }

  // Auto-deepen if too few prefixes (like inpx-web recursive depth)
  if (prefixKey && rows.length < 10 && effectiveDepth < 6) {
    return opdsTitleQuery(prefix, effectiveDepth + 1, genre);
  }

  return sortOpdsPrefixRows(rows).map(r => ({
    id: r.prefix_val,
    title: r.prefix_val.toUpperCase().replace(/ /g, '·'),
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

  const prefixKey = prefix ? createSortKey(prefix) : '';
  let sql, params;
  if (genre) {
    sql = `SELECT c.name AS name, COALESCE(c.display_name, c.name) AS displayName,
             COUNT(DISTINCT j.book_id) AS bookCount
           FROM ${conf.table} c
           JOIN ${conf.join} j ON j.${conf.joinCol} = c.id
           JOIN active_books ab ON ab.id = j.book_id
           JOIN book_genres bg ON bg.book_id = ab.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           WHERE c.search_name >= ? AND c.search_name < ?
           GROUP BY c.id ORDER BY c.search_name LIMIT 200`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = [...genreParams, prefixKey, prefixKey + '\uffff'];
  } else {
    sql = `SELECT c.name AS name, COALESCE(c.display_name, c.name) AS displayName,
             (SELECT COUNT(*) FROM ${conf.join} j JOIN active_books ab ON ab.id = j.book_id WHERE j.${conf.joinCol} = c.id) AS bookCount
           FROM ${conf.table} c
           WHERE c.search_name >= ? AND c.search_name < ?
           ORDER BY c.search_name LIMIT 200`;
    params = [prefixKey, prefixKey + '\uffff'];
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
  const prefixKey = prefix ? createSortKey(prefix) : '';
  let sql, params;
  if (genre) {
    sql = `SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.genres,
                  b.archive_name AS archiveName, b.file_name AS fileName, b.source_id AS sourceId,
                  COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta,
                  dc.annotation
           FROM active_books b
           JOIN book_genres bg ON bg.book_id = b.id
           JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genre.split(',').map(() => '?').join(',')})
           LEFT JOIN sources s ON s.id = b.source_id
           LEFT JOIN book_details_cache dc ON dc.book_id = b.id
           WHERE b.title_search >= ? AND b.title_search < ?
           GROUP BY b.id
           ORDER BY b.title_search LIMIT 200`;
    const genreParams = genre.split(',').map(g => g.trim());
    params = [...genreParams, prefixKey, prefixKey + '\uffff'];
  } else {
    sql = `SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.genres,
                  b.archive_name AS archiveName, b.file_name AS fileName, b.source_id AS sourceId,
                  COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta,
                  dc.annotation
           FROM active_books b
           LEFT JOIN sources s ON s.id = b.source_id
           LEFT JOIN book_details_cache dc ON dc.book_id = b.id
           WHERE b.title_search >= ? AND b.title_search < ?
           ORDER BY b.title_search LIMIT 200`;
    params = [prefixKey, prefixKey + '\uffff'];
  }

  const books = db.prepare(sql).all(...params).map((r) => ({
    id: r.id,
    title: `${r.seriesNo ? `${r.seriesNo}. ` : ''}${r.title || t('opds.noTitle')} (${r.ext || 'fb2'})`,
    authors: r.authors,
    series: r.series || '',
    seriesNo: r.seriesNo || '',
    genres: r.genres || '',
    lang: r.lang || '',
    archiveName: r.archiveName || '',
    fileName: r.fileName || '',
    sourceId: r.sourceId,
    sourceFlibusta: r.sourceFlibusta,
    annotation: r.annotation || '',
    bookId: r.id,
    ext: r.ext,
    isBook: true
  }));
  attachSeriesListsToBooks(books);
  return books;
}

/** OPDS author search — same matcher as web/API `listAuthors`. */
export function opdsSearchAuthors(term, { page = 1, pageSize = 100 } = {}) {
  if (!term || !term.trim()) return { total: 0, items: [] };
  const result = listAuthors({
    query: term,
    page,
    pageSize,
    sort: 'count'
  });
  return {
    total: result.total,
    items: result.items.map((row) => ({
      name: row.name,
      displayName: row.displayName || row.name,
      bookCount: row.bookCount
    }))
  };
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
             COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta,
             dc.annotation
      FROM active_books b
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id AND ${authorAliasMatchSql('a')}
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
             COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta,
             dc.annotation
      FROM active_books b
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id AND ${authorAliasMatchSql('a')}
      LEFT JOIN sources s ON s.id = b.source_id
      LEFT JOIN book_details_cache dc ON dc.book_id = b.id
      ORDER BY ${rankOrder}
      LIMIT 500`;
    params = [authorName];
  }
  return db.prepare(sql).all(...params);
}

export function getAuthorSeriesBooksOpds(authorName, seriesName, genre = '') {
  const rankOrder = 'CAST(b.series_no AS INTEGER), b.title';
  let sql;
  let params;
  if (genre) {
    const genreParams = genre.split(',').map((g) => g.trim());
    sql = `
      SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.genres,
             b.archive_name AS archiveName, b.file_name AS fileName, b.source_id AS sourceId,
             COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta,
             dc.annotation
      FROM active_books b
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id AND ${authorAliasMatchSql('a')}
      JOIN book_genres bg ON bg.book_id = b.id
      JOIN genres_catalog gc ON gc.id = bg.genre_id AND gc.name IN (${genreParams.map(() => '?').join(',')})
      LEFT JOIN sources s ON s.id = b.source_id
      LEFT JOIN book_details_cache dc ON dc.book_id = b.id
      WHERE b.series = ?
      GROUP BY b.id
      ORDER BY ${rankOrder}
      LIMIT 500`;
    params = [authorName, ...genreParams, seriesName];
  } else {
    sql = `
      SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.genres,
             b.archive_name AS archiveName, b.file_name AS fileName, b.source_id AS sourceId,
             COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta,
             dc.annotation
      FROM active_books b
      JOIN book_authors ba ON ba.book_id = b.id
      JOIN authors a ON a.id = ba.author_id AND ${authorAliasMatchSql('a')}
      LEFT JOIN sources s ON s.id = b.source_id
      LEFT JOIN book_details_cache dc ON dc.book_id = b.id
      WHERE b.series = ?
      ORDER BY ${rankOrder}
      LIMIT 500`;
    params = [authorName, seriesName];
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
           COALESCE(s.flibusta_sidecar, 0) AS sourceFlibusta,
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

let _stmtRecordHistoryUser = null;
let _stmtRecordHistoryUpsert = null;
export function recordReadingHistory(username, bookId) {
  _stmtRecordHistoryUser ??= db.prepare(`
    INSERT INTO users(username) VALUES(?)
    ON CONFLICT(username) DO NOTHING
  `);
  _stmtRecordHistoryUser.run(username);

  _stmtRecordHistoryUpsert ??= db.prepare(`
    INSERT INTO reading_history(username, book_id, last_opened_at, open_count)
    VALUES(?, ?, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(username, book_id) DO UPDATE SET
      last_opened_at = CURRENT_TIMESTAMP,
      open_count = reading_history.open_count + 1
  `);
  _stmtRecordHistoryUpsert.run(username, bookId);
}

let _stmtGetReadHistory = null;
let _stmtGetReadHistoryActive = null;
/**
 * История открытий для «Читаю» / профиля.
 * @param {{ excludeRead?: boolean }} [opts] — по умолчанию скрывает «Прочитано»
 *   (для рекомендаций передайте excludeRead: false).
 */
export function getReadingHistory(username, limit = 20, { excludeRead = true } = {}) {
  if (!excludeRead) {
    _stmtGetReadHistory ??= db.prepare(`
      SELECT b.id, b.title, b.authors, b.ext, b.series, b.series_no AS seriesNo,
             b.lib_rate AS libRate,
             rh.last_opened_at AS lastOpenedAt, rh.open_count AS openCount,
             COALESCE(rp.progress, 0) AS readProgress
      FROM reading_history rh
      JOIN active_books b ON b.id = rh.book_id
      LEFT JOIN reading_positions rp ON rp.book_id = b.id AND rp.username = ?
      WHERE rh.username = ?
      ORDER BY rh.last_opened_at DESC
      LIMIT ?
    `);
    return _stmtGetReadHistory.all(username, username, limit);
  }
  _stmtGetReadHistoryActive ??= db.prepare(`
    SELECT b.id, b.title, b.authors, b.ext, b.series, b.series_no AS seriesNo,
           b.lib_rate AS libRate,
           rh.last_opened_at AS lastOpenedAt, rh.open_count AS openCount,
           COALESCE(rp.progress, 0) AS readProgress
    FROM reading_history rh
    JOIN active_books b ON b.id = rh.book_id
    LEFT JOIN reading_positions rp ON rp.book_id = b.id AND rp.username = ?
    WHERE rh.username = ?
      AND NOT EXISTS (
        SELECT 1 FROM read_books rb
        WHERE rb.username = rh.username AND rb.book_id = rh.book_id
      )
    ORDER BY rh.last_opened_at DESC
    LIMIT ?
  `);
  return _stmtGetReadHistoryActive.all(username, username, limit);
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

export function getFavoriteAuthors(username, limit = 20, sort = 'name', order = '') {
  const orderMap = {
    name: `COALESCE(a.display_name, a.name) COLLATE NOCASE ASC`,
    count: 'bookCount DESC',
    date: 'fa.created_at DESC'
  };
  let orderBy = orderMap[sort] || orderMap.name;
  if (order === 'asc' || order === 'desc') {
    const firstMatch = orderBy.match(/\b(ASC|DESC)\b/);
    const natural = firstMatch ? firstMatch[1] : 'ASC';
    if (natural !== order.toUpperCase()) {
      orderBy = orderBy.replace(/\bASC\b/, '#ASC#').replace(/\bDESC\b/, '#DESC#')
        .replace('#ASC#', 'DESC').replace('#DESC#', 'ASC');
    }
  }
  /* bookCount как коррелированный подзапрос: LEFT JOIN active_books заставлял SQLite
     материализовать всю view (полный скан books, ~1.6 с на 600k) даже для двух избранных. */
  return db.prepare(`
    SELECT a.name, COALESCE(a.display_name, a.name) AS displayName,
           (SELECT COUNT(*) FROM book_authors ba
            JOIN active_books ab ON ab.id = ba.book_id
            WHERE ba.author_id = a.id) AS bookCount,
           (SELECT ab2.id FROM book_authors ba2
            JOIN active_books ab2 ON ab2.id = ba2.book_id
            WHERE ba2.author_id = a.id
            ORDER BY ab2.lib_rate DESC, ab2.title COLLATE NOCASE ASC
            LIMIT 1) AS coverBookId
    FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    WHERE fa.username = ?
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(username, limit);
}

export function getFavoriteSeries(username, limit = 20, sort = 'name', order = '') {
  const orderMap = {
    name: `COALESCE(s.display_name, s.name) COLLATE NOCASE ASC`,
    count: 'bookCount DESC',
    date: 'fs.created_at DESC'
  };
  let orderBy = orderMap[sort] || orderMap.name;
  if (order === 'asc' || order === 'desc') {
    const firstMatch = orderBy.match(/\b(ASC|DESC)\b/);
    const natural = firstMatch ? firstMatch[1] : 'ASC';
    if (natural !== order.toUpperCase()) {
      orderBy = orderBy.replace(/\bASC\b/, '#ASC#').replace(/\bDESC\b/, '#DESC#')
        .replace('#ASC#', 'DESC').replace('#DESC#', 'ASC');
    }
  }
  const rows = db.prepare(`
    SELECT s.name, COALESCE(s.display_name, s.name) AS displayName,
           (SELECT COUNT(*) FROM book_series bs
            JOIN active_books ab ON ab.id = bs.book_id
            WHERE bs.series_id = s.id) AS bookCount,
           (SELECT GROUP_CONCAT(sb.id, '|') FROM (
              SELECT ab2.id
              FROM book_series bs2
              JOIN active_books ab2 ON ab2.id = bs2.book_id
              WHERE bs2.series_id = s.id
              ORDER BY ab2.lib_rate DESC, ab2.title COLLATE NOCASE ASC
              LIMIT 4
           ) sb) AS previewBookIds
    FROM favorite_series fs
    JOIN series_catalog s ON s.id = fs.series_id
    WHERE fs.username = ?
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(username, limit);
  for (const row of rows) {
    row.previewBookIds = row.previewBookIds ? String(row.previewBookIds).split('|').filter(Boolean) : [];
  }
  return rows;
}

/* Лёгкие версии — только имя и displayName, без подсчёта bookCount через JOIN на active_books */
let _stmtFavAuthorsLight = null;
export function getFavoriteAuthorsLight(username, limit = 20) {
  _stmtFavAuthorsLight ??= db.prepare(`
    SELECT a.name, COALESCE(a.display_name, a.name) AS displayName
    FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    WHERE fa.username = ?
    ORDER BY COALESCE(a.display_name, a.name) COLLATE NOCASE ASC
    LIMIT ?
  `);
  return _stmtFavAuthorsLight.all(username, limit);
}

let _stmtFavSeriesLight = null;
export function getFavoriteSeriesLight(username, limit = 20) {
  _stmtFavSeriesLight ??= db.prepare(`
    SELECT s.name, COALESCE(s.display_name, s.name) AS displayName
    FROM favorite_series fs
    JOIN series_catalog s ON s.id = fs.series_id
    WHERE fs.username = ?
    ORDER BY COALESCE(s.display_name, s.name) COLLATE NOCASE ASC
    LIMIT ?
  `);
  return _stmtFavSeriesLight.all(username, limit);
}

let _stmtIsFavAuthor = null;
export function isFavoriteAuthor(username, authorName) {
  const resolvedName = resolveAuthorName(authorName);
  if (!resolvedName) {
    return false;
  }

  _stmtIsFavAuthor ??= db.prepare(`
    SELECT 1
    FROM favorite_authors fa
    JOIN authors a ON a.id = fa.author_id
    WHERE fa.username = ? AND a.name = ?
  `);
  return Boolean(_stmtIsFavAuthor.get(username, resolvedName));
}

let _stmtIsFavSeries = null;
export function isFavoriteSeries(username, seriesName) {
  const resolved = resolveSeriesCatalogName(String(seriesName || ''));
  _stmtIsFavSeries ??= db.prepare(`
    SELECT 1
    FROM favorite_series fs
    JOIN series_catalog s ON s.id = fs.series_id
    WHERE fs.username = ? AND s.name = ?
  `);
  return Boolean(_stmtIsFavSeries.get(username, resolved));
}

const _bookmarksOrderMap = {
  title: 'b.title COLLATE NOCASE ASC',
  author: `COALESCE(b.authors, '') COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC`,
  date: 'bm.created_at DESC',
  rating: 'b.lib_rate DESC, b.title_sort ASC'
};

let _stmtBookmarksCount = null;
export function getBookmarksCount(username) {
  _stmtBookmarksCount ??= db.prepare(`
    SELECT COUNT(*) AS count
    FROM bookmarks bm
    JOIN active_books b ON b.id = bm.book_id
    WHERE bm.username = ?
  `);
  return Number(_stmtBookmarksCount.get(username)?.count || 0);
}

const _stmtBookmarksBySort = new Map();
const _stmtBookmarksLimitedBySort = new Map();
const _stmtBookmarksPagedBySort = new Map();

export function getBookmarksPage(username, { sort = 'date', page = 1, pageSize = 24 } = {}) {
  const orderBy = _bookmarksOrderMap[sort] || _bookmarksOrderMap.date;
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 24)));
  const offset = (safePage - 1) * safeSize;
  let stmt = _stmtBookmarksPagedBySort.get(orderBy);
  if (!stmt) {
    stmt = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
             b.ext, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
      FROM bookmarks bm
      JOIN active_books b ON b.id = bm.book_id
      WHERE bm.username = ?
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `);
    _stmtBookmarksPagedBySort.set(orderBy, stmt);
  }
  return {
    items: stmt.all(username, safeSize, offset).map(mapBookListRow),
    total: getBookmarksCount(username)
  };
}

export function getBookmarks(username, sort = 'date', limit = 0) {
  const orderBy = _bookmarksOrderMap[sort] || _bookmarksOrderMap.date;
  if (limit > 0) {
    let stmt = _stmtBookmarksLimitedBySort.get(orderBy);
    if (!stmt) {
      stmt = db.prepare(`
        SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
               b.ext, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
        FROM bookmarks bm
        JOIN active_books b ON b.id = bm.book_id
        WHERE bm.username = ?
        ORDER BY ${orderBy}
        LIMIT ?
      `);
      _stmtBookmarksLimitedBySort.set(orderBy, stmt);
    }
    return stmt.all(username, limit).map(mapBookListRow);
  }
  let stmt = _stmtBookmarksBySort.get(orderBy);
  if (!stmt) {
    stmt = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
             b.ext, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
      FROM bookmarks bm
      JOIN active_books b ON b.id = bm.book_id
      WHERE bm.username = ?
      ORDER BY ${orderBy}
    `);
    _stmtBookmarksBySort.set(orderBy, stmt);
  }
  return stmt.all(username).map(mapBookListRow);
}

let _stmtIsBookmarked = null;
export function isBookmarked(username, bookId) {
  _stmtIsBookmarked ??= db.prepare('SELECT 1 FROM bookmarks WHERE username = ? AND book_id = ?');
  return Boolean(_stmtIsBookmarked.get(username, bookId));
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
  const canonical = resolveSeriesCatalogName(String(seriesName));
  if (!_stmtIsSeriesFullyRead) {
    _stmtIsSeriesFullyRead = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM active_books ab
         JOIN book_series bs ON bs.book_id = ab.id
         JOIN series_catalog sc ON sc.id = bs.series_id
         WHERE sc.name = ?) AS total,
        (SELECT COUNT(*) FROM read_books rb
         JOIN active_books ab ON ab.id = rb.book_id
         JOIN book_series bs ON bs.book_id = ab.id
         JOIN series_catalog sc ON sc.id = bs.series_id
         WHERE rb.username = ? AND sc.name = ?) AS readCount
    `);
  }
  const row = _stmtIsSeriesFullyRead.get(canonical, username, canonical);
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
    touchUserReaderRevision(username, 'read_books_rev');
    invalidateReadCache(username);
    return false;
  }
  db.prepare('INSERT OR IGNORE INTO users(username) VALUES(?)').run(username);
  db.prepare('INSERT OR IGNORE INTO read_books(username, book_id) VALUES(?, ?)').run(username, bookId);
  deleteReadingHistoryEntry(username, bookId);
  touchUserReaderRevision(username, 'read_books_rev');
  invalidateReadCache(username);
  return true;
}

export function removeReadBookIfPresent(username, bookId) {
  const result = db.prepare(
    'DELETE FROM read_books WHERE username = ? AND book_id = ?',
  ).run(username, bookId);
  if (result.changes > 0) {
    touchUserReaderRevision(username, 'read_books_rev');
    invalidateReadCache(username);
    return true;
  }
  return false;
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
  if (added > 0) {
    touchUserReaderRevision(username, 'read_books_rev');
    invalidateReadCache(username);
  }
  return { added, already, missing };
}

const _readBooksOrderMap = {
  title: 'b.title COLLATE NOCASE ASC',
  author: `COALESCE(b.authors, '') COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC`,
  date: 'rb.created_at DESC',
  rating: 'b.lib_rate DESC, b.title_sort ASC'
};

const _stmtReadBooksBySort = new Map();
const _stmtReadBooksLimitedBySort = new Map();
const _stmtReadBooksPagedBySort = new Map();

export function getReadBooksPage(username, { sort = 'date', page = 1, pageSize = 24 } = {}) {
  const orderBy = _readBooksOrderMap[sort] || _readBooksOrderMap.date;
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 24)));
  const offset = (safePage - 1) * safeSize;
  let stmt = _stmtReadBooksPagedBySort.get(orderBy);
  if (!stmt) {
    stmt = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
             b.ext, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
      FROM read_books rb
      JOIN active_books b ON b.id = rb.book_id
      WHERE rb.username = ?
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `);
    _stmtReadBooksPagedBySort.set(orderBy, stmt);
  }
  return {
    items: stmt.all(username, safeSize, offset).map(mapBookListRow),
    total: getReadBooksCount(username)
  };
}

export function getReadBooks(username, sort = 'date', limit = 0) {
  const orderBy = _readBooksOrderMap[sort] || _readBooksOrderMap.date;
  if (limit > 0) {
    let stmt = _stmtReadBooksLimitedBySort.get(orderBy);
    if (!stmt) {
      stmt = db.prepare(`
        SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
               b.ext, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
        FROM read_books rb
        JOIN active_books b ON b.id = rb.book_id
        WHERE rb.username = ?
        ORDER BY ${orderBy}
        LIMIT ?
      `);
      _stmtReadBooksLimitedBySort.set(orderBy, stmt);
    }
    return stmt.all(username, limit).map(mapBookListRow);
  }
  let stmt = _stmtReadBooksBySort.get(orderBy);
  if (!stmt) {
    stmt = db.prepare(`
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo,
             b.ext, b.lib_rate AS libRate, b.archive_name AS archiveName, b.deleted
      FROM read_books rb
      JOIN active_books b ON b.id = rb.book_id
      WHERE rb.username = ?
      ORDER BY ${orderBy}
    `);
    _stmtReadBooksBySort.set(orderBy, stmt);
  }
  return stmt.all(username).map(mapBookListRow);
}

/** Лёгкий запрос — только ID прочитанных книг без JOIN и сортировки */
export function getReadBookIds(username) {
  return db.prepare('SELECT book_id AS id FROM read_books WHERE username = ?')
    .all(username)
    .map((r) => r.id);
}

/**
 * Typeahead suggestions — same matchers as full catalog modes.
 * @param {string} query
 * @param {number} [limit=5]
 * @param {string} [field='books'] scope: books | authors | series
 */
const _suggestPrefixStmts = new Map();

/** Indexed sort_name/search_name prefix. LIMIT stops the range; no correlated sums. */
function suggestRowsByNamePrefix(table, prefix, limit) {
  const word = String(prefix || '').trim();
  const n = Math.max(1, Math.floor(Number(limit) || 5));
  if (!word || (table !== 'authors' && table !== 'series_catalog')) return [];
  const run = (column) => {
    const clause = authorColumnPrefixClause(`${column}`, word);
    const cacheKey = `${table}:${column}:${clause.params.length}`;
    let stmt = _suggestPrefixStmts.get(cacheKey);
    if (!stmt) {
      stmt = db.prepare(`
        SELECT name,
               COALESCE(display_name, name) AS displayName,
               COALESCE(sort_name, LOWER(name)) AS sortKey,
               book_count AS bookCount
        FROM ${table}
        WHERE ${clause.sql} AND book_count > 0
        ORDER BY book_count DESC
        LIMIT ?
      `);
      _suggestPrefixStmts.set(cacheKey, stmt);
    }
    return stmt.all(...clause.params, n);
  };
  const bySort = run('sort_name');
  if (bySort.length) return bySort;
  return run('search_name');
}

function suggestAuthorPage(prefix, pageSize) {
  const n = Math.max(1, Math.floor(Number(pageSize) || 5));
  const raw = suggestRowsByNamePrefix('authors', prefix, Math.min(24, n * 4));
  const collapsed = collapsePreferredAuthorRows(raw);
  collapsed.sort((a, b) => (Number(b.bookCount) || 0) - (Number(a.bookCount) || 0));
  const items = withAuthorDisplayNames(collapsed.slice(0, n));
  return { total: items.length, items };
}

let _stmtSuggestTitlePrefix = null;

/** First titles in idx_books_title_search. Stops after `limit` rows, no FTS rank. */
function suggestBooksByTitlePrefix(prefix, limit) {
  const word = String(prefix || '').trim();
  const upper = textPrefixUpperBound(word);
  if (!word || !upper) return [];
  _stmtSuggestTitlePrefix ??= db.prepare(`
    SELECT b.id, b.title, b.authors, b.series, b.series_no AS seriesNo
    FROM books b
    WHERE b.title_search >= ? AND b.title_search < ?
      AND b.deleted = 0
      AND (b.source_id IS NULL OR EXISTS (
        SELECT 1 FROM sources s WHERE s.id = b.source_id AND s.enabled = 1
      ))
    ORDER BY b.title_search
    LIMIT ?
  `);
  return _stmtSuggestTitlePrefix.all(word, upper, limit);
}

let _stmtSuggestFtsIds = null;

function suggestBooksByFts(query, field, limit) {
  if (!isBooksFtsUsable()) return [];
  const plan = buildBooksFtsMatchQuery(field, query);
  if (plan?.mode !== 'fts' || !plan.match) return [];
  _stmtSuggestFtsIds ??= db.prepare(`
    SELECT id FROM books_fts WHERE books_fts MATCH ? LIMIT ?
  `);
  const ids = _stmtSuggestFtsIds.all(plan.match, limit).map((row) => row.id).filter(Boolean);
  if (!ids.length) return [];
  const byId = new Map(loadActiveBooksByIds(ids).map((row) => [row.id, row]));
  const out = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    out.push(row);
  }
  return out;
}

export function getSuggestions(query, limit = 5, field = 'books') {
  const raw = String(query || '').trim();
  if (!raw || raw.length < 2) return { books: [], authors: [], series: [] };
  const key = createSortKey(raw);
  if (!key) return { books: [], authors: [], series: [] };

  const scope = ['books', 'authors', 'series'].includes(field) ? field : 'books';
  const n = Math.min(12, Math.max(1, Math.floor(Number(limit) || 5)));

  let books = [];
  let authors = [];
  let seriesItems = [];
  const tStart = Date.now();
  let tAuthors = tStart;
  let tSeries = tStart;

  if (scope === 'books' || scope === 'authors') {
    authors = listAuthors({ query: raw, page: 1, pageSize: n, sort: 'count', skipTotal: true }).items
      .map((row) => ({
        name: row.name,
        displayName: row.displayName || row.name,
        bookCount: row.bookCount
      }));
    tAuthors = Date.now();
  }

  if (scope === 'books' || scope === 'series') {
    seriesItems = listSeries({ query: raw, page: 1, pageSize: n, sort: 'count', skipTotal: true }).items
      .map((row) => ({
        name: row.name,
        displayName: row.displayName || row.name,
        bookCount: row.bookCount
      }));
    tSeries = Date.now();
  }

  if (scope === 'books') {
    /* Title prefix uses idx_books_title_search and stops at `n` rows.
       FTS ORDER BY rank on a 2–3 letter prefix ("ле", "лет") ranks hundreds of
       thousands of hits and blocks the event loop for tens of seconds. */
    const seen = new Set();
    const pushBook = (row) => {
      if (!row?.id || seen.has(row.id) || books.length >= n) return;
      seen.add(row.id);
      books.push({
        id: row.id,
        title: row.title,
        authors: row.authors,
        series: row.series,
        seriesNo: row.seriesNo || ''
      });
    };
    for (const row of suggestBooksByTitlePrefix(key, n)) pushBook(row);
    const contentTokens = filterSearchContentTokens(key.split(/\s+/));
    const canFtsFill = contentTokens.length > 0 && contentTokens.every((tok) => tok.length >= 4);
    if (books.length < n && canFtsFill) {
      const bookField = contentTokens.length >= 2 ? 'title' : 'all';
      for (const row of suggestBooksByFts(raw, bookField, n)) pushBook(row);
    }
  }

  logSlowSearchSteps('suggest', raw, [
    ['authors', tAuthors - tStart],
    ['series', tSeries - tAuthors],
    ['books', Date.now() - tSeries]
  ]);
  return { books, authors, series: seriesItems };
}
