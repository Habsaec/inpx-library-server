/**
 * `/facet/authors/:value/outside-series` used the URL value as is, so a name pasted in its
 * display spelling («Пелевин Виктор Олегович») matched nothing: `authors.name` is the
 * lower-case INPX key and the page rendered «Книги не найдены». The route now resolves the
 * canonical name and redirects, exactly like `/facet/:facet/:value` (issue #36).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { initDb, db } from '../src/db.js';
import { registerLibraryRoutes } from '../src/routes/library.js';

const AUTHOR_NAME = 'пелевин,виктор,олегович';
const AUTHOR_DISPLAY = 'Пелевин Виктор Олегович';

function insertBook(id, title, authors, series = '') {
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (?, ?, ?, 'sf', ?, '1', ?, '', '', 1, ?, '', '', '', '', ?, 'a.zip', 1000, ?, 0, 'fb2', '2026-11-01', 'ru', '', 0, 1)
  `).run(id, title, authors, series, title.toLowerCase(), title.toLowerCase(), `${id}.fb2`, id);
}

test('outside-series resolves an author name in its display spelling (issue #36)', async (t) => {
  initDb();
  for (const table of ['book_series', 'book_authors', 'books', 'authors', 'series_catalog']) db.exec(`DELETE FROM ${table}`);
  db.exec('DELETE FROM sources WHERE id = 1');
  db.prepare(`INSERT INTO sources (id, name, type, path, enabled) VALUES (1, 'src', 'folder', '/', 1)`).run();
  db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, 'пелевин виктор олегович', 'пелевин виктор олегович', 2)
  `).run(AUTHOR_NAME, AUTHOR_DISPLAY);
  db.prepare(`
    INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count)
    VALUES ('серия', 'Серия', 'серия', 'серия', 1)
  `).run();
  insertBook('s1:1', 'В серии', AUTHOR_DISPLAY, 'Серия');
  insertBook('s1:2', 'Вне серий', AUTHOR_DISPLAY);
  const authorId = db.prepare('SELECT id FROM authors').get().id;
  const seriesId = db.prepare('SELECT id FROM series_catalog').get().id;
  db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?), (?, ?)').run('s1:1', authorId, 's1:2', authorId);
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run('s1:1', seriesId, '1');

  let rendered = null;
  const stub = () => '';
  const app = express();
  registerLibraryRoutes(app, {
    getCachedStats: () => ({}),
    templates: {
      renderHome: stub, renderCatalog: stub, renderLibraryView: stub, renderBrowsePage: stub,
      renderFacetBooks: stub, renderAuthorFacetPage: stub,
      renderAuthorOutsideSeriesPage: (options) => { rendered = options; return 'OUTSIDE-SERIES-PAGE'; },
      renderBook: stub, renderFavorites: stub, renderShelves: stub, renderShelfDetail: stub,
      renderReader: stub, renderMyLibrary: stub, renderReaderBookmarksPage: stub, renderReaderNotesPage: stub
    }
  });
  const server = await new Promise((resolve) => {
    const listener = http.createServer(app).listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };

  const displayUrl = `${base}/facet/authors/${encodeURIComponent(AUTHOR_DISPLAY)}/outside-series`;
  const redirect = await fetch(displayUrl, { headers: auth, redirect: 'manual' });
  assert.equal(redirect.status, 302, 'a display-spelling name must redirect to the canonical key');
  assert.equal(redirect.headers.get('location'), `/facet/authors/${encodeURIComponent(AUTHOR_NAME)}/outside-series`);

  const withQuery = await fetch(`${displayUrl}?sort=recent&page=2`, { headers: auth, redirect: 'manual' });
  assert.equal(withQuery.status, 302);
  assert.equal(
    withQuery.headers.get('location'),
    `/facet/authors/${encodeURIComponent(AUTHOR_NAME)}/outside-series?sort=recent&page=2`,
    'filters survive the redirect'
  );

  const canonicalUrl = `${base}/facet/authors/${encodeURIComponent(AUTHOR_NAME)}/outside-series`;
  const canonical = await fetch(canonicalUrl, { headers: auth, redirect: 'manual' });
  assert.equal(canonical.status, 200, 'the canonical spelling renders the page, not a redirect loop');
  assert.equal(await canonical.text(), 'OUTSIDE-SERIES-PAGE');
  assert.equal(rendered?.facetValue, AUTHOR_NAME);
  assert.deepEqual(rendered?.books?.map((book) => book.id), ['s1:2'], 'only the book outside the series');

  const unknown = await fetch(`${base}/facet/authors/${encodeURIComponent('никто,неизвестный,автор')}/outside-series`, {
    headers: auth, redirect: 'manual'
  });
  assert.equal(unknown.status, 200, 'an unknown author is not redirected (no loop, empty page as before)');
});
