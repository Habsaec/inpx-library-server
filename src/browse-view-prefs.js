import { getUserBrowseViewPrefs } from './db.js';

/** @returns {''|'grid'|'list'} */
export function normalizeBrowseViewMode(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'list') return 'list';
  if (v === 'grid' || v === 'covers') return 'grid';
  return '';
}

/**
 * Resolve covers/list mode for home or catalog-scoped pages.
 * Explicit `?view=` overrides the logged-in preference; guests default to grid.
 * @param {{ username?: string, queryView?: string, scope?: 'home'|'catalog' }} opts
 * @returns {'grid'|'list'}
 */
export function resolveBrowseViewMode({ username = '', queryView = '', scope = 'catalog' } = {}) {
  const fromQuery = normalizeBrowseViewMode(queryView);
  if (fromQuery) return fromQuery;
  if (username) {
    const prefs = getUserBrowseViewPrefs(username);
    const mode = scope === 'home' ? prefs.homeView : prefs.catalogView;
    return mode === 'list' ? 'list' : 'grid';
  }
  return 'grid';
}

export function isListBrowseView(opts) {
  return resolveBrowseViewMode(opts) === 'list';
}

/**
 * Author page: `?view=list` is the flat list, `?view=series` (or `grid`) is the
 * series grouping. An explicit query wins over the saved catalog preference,
 * otherwise a saved "list" preference would ignore the button that leaves it.
 * @returns {'list'|'series'}
 */
export function resolveAuthorFacetView({ queryView = '', username = '' } = {}) {
  const requested = String(queryView || '');
  if (requested === 'list') return 'list';
  if (requested === 'series' || requested === 'grid') return 'series';
  return isListBrowseView({ username, queryView: '', scope: 'catalog' }) ? 'list' : 'series';
}

/**
 * Book lists on series/genre/language pages. `layout` is separate from `view`,
 * which those pages already use for books/authors/series tabs.
 * @returns {'list'|'grid'}
 */
export function resolveFacetBookLayout({ queryLayout = '', username = '' } = {}) {
  return isListBrowseView({ username, queryView: queryLayout, scope: 'catalog' }) ? 'list' : 'grid';
}
