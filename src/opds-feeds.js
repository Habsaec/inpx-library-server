/**
 * Data of the OPDS feeds shared by v1 and v2: «Новинки» with sort / language facets, collections, the personal
 * «Читаю» / «Прочитано» / «Мои оценки» lists, and pictures of navigation entries (first volume of a series, author
 * portrait). Routes render it (routes/opds.js, routes/opds-v2.js).
 */
import { db } from './db.js';
import { t } from './i18n.js';
import { PAGE_CACHE_TTL_MS } from './constants.js';
import { getLibraryView, listLanguages } from './inpx.js';
import { listCollections, getCollection } from './collections.js';
import { getStaleOrSchedule } from './services/cache.js';
import { effectiveContentLangs, resolveContentLangFilter, contentLangCacheKey } from './user-content-langs.js';
import { withParam } from './opds-common.js';

export const OPDS_NEW_SORTS = ['recent', 'title', 'rating'];

/** «Новинки» (INPX date, like /library/recent): a page, profile languages applied, shared cache like the API. */
export function getOpdsNewBooks(username, { page = 1, pageSize = 100, sort = 'recent', lang = '' } = {}) {
  const safeSort = OPDS_NEW_SORTS.includes(sort) ? sort : 'recent';
  const langFilter = resolveContentLangFilter(username || '', String(lang || ''));
  const key = `opds:new:v1:${safeSort}:${langFilter.lang || ''}:${contentLangCacheKey(langFilter.langs)}:p${page}:s${pageSize}`;
  return getStaleOrSchedule(key, () => getLibraryView('recent', {
    page, pageSize, sort: safeSort, lang: langFilter.lang, langs: langFilter.langs,
  }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
}

/** OPDS facets of «Новинки»: sort and language (the languages the user may see, most books first, ≤ 12). */
export function getOpdsNewFacets(selfUrl, username, { sort = 'recent', lang = '' } = {}) {
  const facets = [];
  const sortGroup = t('opds.facet.sort');
  const sortTitles = { recent: t('opds.facet.sortRecent'), title: t('opds.facet.sortTitle'), rating: t('opds.facet.sortRating') };
  for (const s of OPDS_NEW_SORTS) {
    facets.push({ group: sortGroup, title: sortTitles[s], href: withParam(selfUrl, 'sort', s === 'recent' ? '' : s), active: s === sort });
  }
  let languages = [];
  try {
    languages = listLanguages({ page: 1, pageSize: 12, sort: 'count', langs: effectiveContentLangs(username) }).items || [];
  } catch {
    languages = [];
  }
  if (languages.length > 1) {
    const langGroup = t('opds.facet.lang');
    facets.push({ group: langGroup, title: t('opds.facet.langAll'), href: withParam(selfUrl, 'lang', ''), active: !lang });
    for (const l of languages) {
      if (!l?.name || l.name === 'unknown') continue;
      facets.push({ group: langGroup, title: l.displayName || String(l.name).toUpperCase(), href: withParam(selfUrl, 'lang', l.name), active: lang === l.name });
    }
  }
  return facets;
}

/** Personal lists of the user (the same as the site): continue = «Читаю», read = «Прочитано», rated = «Мои оценки». */
export function getOpdsUserList(view, username, { page = 1, pageSize = 100 } = {}) {
  const sort = view === 'rated' ? 'rating' : 'recent';
  return getLibraryView(view, { username, page, pageSize, sort });
}

let _collectionsMemo = { at: 0, value: false };
/** Whether the catalog root should offer «Подборки» (an enabled collection with a found book); memo 5 min. */
export function opdsHasCollections() {
  if (Date.now() - _collectionsMemo.at < 5 * 60_000) return _collectionsMemo.value;
  let value = false;
  try {
    value = listCollections().some((c) => Number(c.found) > 0);
  } catch {
    value = false;
  }
  _collectionsMemo = { at: Date.now(), value };
  return value;
}

/** Collections with found books: [{ slug, title, description, found, coverBookId }]. */
export function getOpdsCollections(username) {
  return listCollections({ username: username || '' })
    .filter((c) => Number(c.found) > 0)
    .map((c) => ({
      slug: c.slug,
      title: c.title,
      description: c.description || '',
      found: Number(c.found) || 0,
      coverBookId: Array.isArray(c.previewBookIds) && c.previewBookIds.length ? c.previewBookIds[0] : null,
    }));
}

/** Found books of a collection in list order, one page: { title, total, items } or null. */
export function getOpdsCollectionBooks(slug, username, { page = 1, pageSize = 100 } = {}) {
  const c = getCollection(slug, { username: username || '' });
  if (!c) return null;
  const books = c.items.filter((i) => i.book).map((i) => i.book);
  return { title: c.title, total: books.length, items: books.slice((page - 1) * pageSize, page * pageSize) };
}

/* name → first volume id, kept 30 min: a huge publisher series sorts thousands of volumes for its picture. */
const _seriesCoverMemo = new Map();
const SERIES_COVER_MEMO_MAX = 5000;
const SERIES_COVER_TTL_MS = 30 * 60_000;

let _stmtSeriesFirstVolume = null;
/** First volume of a series (lowest number, unnumbered last) for the series picture in navigation feeds. */
export function opdsSeriesCoverBookId(seriesName) {
  _stmtSeriesFirstVolume ??= db.prepare(`
    SELECT bs.book_id AS id FROM series_catalog sc
    JOIN book_series bs ON bs.series_id = sc.id
    JOIN active_books b ON b.id = bs.book_id
    WHERE sc.name = ?
    ORDER BY (bs.series_no IS NULL OR bs.series_no = ''), CAST(bs.series_no AS INTEGER), b.title
    LIMIT 1`);
  const key = String(seriesName || '');
  const hit = _seriesCoverMemo.get(key);
  if (hit && Date.now() - hit.at < SERIES_COVER_TTL_MS) return hit.id;
  let id = null;
  try {
    id = _stmtSeriesFirstVolume.get(key)?.id || null;
  } catch {
    id = null;
  }
  if (_seriesCoverMemo.size >= SERIES_COVER_MEMO_MAX) _seriesCoverMemo.delete(_seriesCoverMemo.keys().next().value);
  _seriesCoverMemo.set(key, { id, at: Date.now() });
  return id;
}

/** Series pictures for a page of a sane size: one lookup per series (memoized), at most ~150 ms per page — the
 *  rest of a page of huge series stays without a picture until the memo has them (200 biggest series: ~1 s cold). */
export function withSeriesCovers(entries, nameOf = (e) => e.name, max = 200, budgetMs = 150) {
  if (!Array.isArray(entries) || entries.length > max) return entries;
  const started = Date.now();
  for (const e of entries) {
    if (Date.now() - started > budgetMs) break;
    const id = opdsSeriesCoverBookId(nameOf(e));
    if (id) e.coverBookId = id;
  }
  return entries;
}

let _portraitsMemo = { at: 0, value: false };
/** Author portraits come from Flibusta sidecar folders only: offer them when an enabled source has one (memo 5 min). */
export function opdsAuthorPortraitsEnabled() {
  if (Date.now() - _portraitsMemo.at < 5 * 60_000) return _portraitsMemo.value;
  let value = false;
  try {
    value = Boolean(db.prepare('SELECT 1 FROM sources WHERE enabled = 1 AND COALESCE(flibusta_sidecar, 0) = 1 LIMIT 1').get());
  } catch {
    value = false;
  }
  _portraitsMemo = { at: Date.now(), value };
  return value;
}

/** Portrait URL of an author for a navigation entry, or '' (the route answers 404 for an author without one). */
export function opdsAuthorPortrait(authorName) {
  if (!authorName || !opdsAuthorPortraitsEnabled()) return '';
  return `/api/authors/portrait?name=${encodeURIComponent(authorName)}`;
}
