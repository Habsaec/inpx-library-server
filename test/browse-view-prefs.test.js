import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, createUser, setUserBrowseViewPrefs } from '../src/db.js';
import {
  resolveAuthorFacetView,
  resolveBrowseViewMode,
  resolveFacetBookLayout
} from '../src/browse-view-prefs.js';
import { renderAuthorFacetPage, renderCatalog, renderFacetBooks } from '../src/templates/library.js';

const USER = 'viewprefsuser';

test('explicit grid overrides a saved list preference', () => {
  initDb();
  try { createUser({ username: USER, password: 'Viewprefs1' }); } catch { /* already created */ }
  setUserBrowseViewPrefs(USER, { homeView: 'grid', catalogView: 'list' });

  assert.equal(resolveBrowseViewMode({ username: USER, queryView: '', scope: 'catalog' }), 'list');
  assert.equal(resolveBrowseViewMode({ username: USER, queryView: 'grid', scope: 'catalog' }), 'grid');
  assert.equal(resolveAuthorFacetView({ username: USER, queryView: '' }), 'list');
  assert.equal(resolveAuthorFacetView({ username: USER, queryView: 'series' }), 'series');
  assert.equal(resolveFacetBookLayout({ username: USER, queryLayout: '' }), 'list');
  assert.equal(resolveFacetBookLayout({ username: USER, queryLayout: 'grid' }), 'grid');
});

test('list view toggle links to grid, and facet pages expose the switch', () => {
  const catalog = renderCatalog({
    items: [], total: 0, page: 1, pageSize: 24,
    query: '', field: 'books', sort: 'title', view: 'list',
    user: null, stats: {}, indexStatus: {}
  });
  assert.match(catalog, /class="button view-toggle"/);
  assert.match(catalog, /view=grid/);

  const grid = renderCatalog({
    items: [], total: 0, page: 1, pageSize: 24,
    query: '', field: 'books', sort: 'title', view: '',
    user: null, stats: {}, indexStatus: {}
  });
  assert.match(grid, /view=list/);

  const signedIn = renderCatalog({
    items: [], total: 0, page: 1, pageSize: 24,
    query: 'пушкин', field: 'books', sort: 'author', view: 'list',
    user: { username: USER }, stats: {}, indexStatus: {}, csrfToken: 'tok'
  });
  assert.match(signedIn, /action="\/profile\/catalog-view"/);
  assert.match(signedIn, /name="view" value="grid"/);
  assert.match(signedIn, /name="_csrf" value="tok"/);
  assert.match(signedIn, /name="next" value="\/catalog\?field=books&amp;sort=author&amp;q=/);
  assert.doesNotMatch(signedIn, /action="\/profile\/home-view"/);

  const author = renderAuthorFacetPage({
    title: 'Author', displayName: 'Author', series: [], standaloneBooks: [], total: 0,
    user: null, stats: {}, facetPath: '/facet/authors/test', indexStatus: {},
    sort: 'series', view: 'series', breadcrumbs: [], facetValue: 'test'
  });
  assert.match(author, /class="button view-toggle"/);
  assert.match(author, /view=list/);

  const series = renderFacetBooks({
    title: 'Series', items: [], total: 0, page: 1, pageSize: 24,
    user: null, stats: {}, facetPath: '/facet/series/test', indexStatus: {},
    sort: 'recent', facet: 'series', facetValue: 'test', breadcrumbs: [],
    listView: false, layout: 'grid'
  });
  assert.match(series, /class="button view-toggle"/);
  assert.match(series, /layout=list/);
});
