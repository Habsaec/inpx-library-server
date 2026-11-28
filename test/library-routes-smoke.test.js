/**
 * Smoke test of the browser pages registered by `src/routes/library.js` on a minimal catalog.
 *
 * The route layer was the least covered part of the server (routes/library.js ~30% lines,
 * routes/admin.js ~6%): a template error or a broken query there answers 500, which no unit
 * test sees. Every page below is rendered with the REAL templates — a stub would hide exactly
 * what this test is for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { initDb, db } from '../src/db.js';
import { registerLibraryRoutes } from '../src/routes/library.js';
import * as templates from '../src/templates.js';
import { stopQueryWorker } from '../src/services/query-pool.js';

const AUTHOR_NAME = 'пелевин,виктор,олегович';
const AUTHOR_DISPLAY = 'Пелевин Виктор Олегович';
const SERIES_NAME = 'серия';
const SERIES_DISPLAY = 'Серия';

function insertBook(id, title, authors, series = '', seriesNo = '1') {
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (?, ?, ?, 'sf', ?, ?, ?, '', '', 1, ?, '', '', '', '', ?, 'a.zip', 1000, ?, 0, 'fb2', '2026-11-01', 'ru', '', 0, 1)
  `).run(id, title, authors, series, seriesNo, title.toLowerCase(), title.toLowerCase(), `${id}.fb2`, id);
}

test('browser pages render on a minimal catalog', async (t) => {
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
    VALUES (?, ?, 'серия', 'серия', 1)
  `).run(SERIES_NAME, SERIES_DISPLAY);
  insertBook('s1:1', 'Книга в серии', AUTHOR_DISPLAY, SERIES_DISPLAY);
  insertBook('s1:2', 'Книга вне серий', AUTHOR_DISPLAY, '', '1');
  const authorId = db.prepare('SELECT id FROM authors').get().id;
  const seriesId = db.prepare('SELECT id FROM series_catalog').get().id;
  db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?), (?, ?)').run('s1:1', authorId, 's1:2', authorId);
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run('s1:1', seriesId, '1');

  const app = express();
  /* The route modules expect req.user from `attachSessionUser`, which server.js installs before
     them; here a fixed admin plays that part. */
  app.use((req, res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  registerLibraryRoutes(app, {
    getCachedStats: () => ({ totalBooks: 2, totalAuthors: 1, totalSeries: 1, totalGenres: 0, totalLanguages: 1 }),
    templates: Object.fromEntries([
      'renderHome', 'renderCatalog', 'renderLibraryView', 'renderBrowsePage', 'renderFacetBooks',
      'renderAuthorFacetPage', 'renderAuthorOutsideSeriesPage', 'renderBook', 'renderFavorites',
      'renderShelves', 'renderShelfDetail', 'renderReader', 'renderMyLibrary',
      'renderReaderBookmarksPage', 'renderReaderNotesPage'
    ].map((name) => [name, templates[name]]))
  });
  const server = await new Promise((resolve) => {
    const listener = http.createServer(app).listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => { server.close(); stopQueryWorker(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const pages = [
    '/',
    '/catalog',
    `/catalog?q=${encodeURIComponent('книга')}`,
    '/authors',
    '/series',
    '/genres',
    '/languages',
    `/facet/authors/${encodeURIComponent(AUTHOR_NAME)}`,
    `/facet/authors/${encodeURIComponent(AUTHOR_NAME)}/outside-series`,
    `/facet/series/${encodeURIComponent(SERIES_NAME)}`,
    '/library/recent',
    '/library/read',
    '/library/continue',
    '/library/want',
    '/library/rated',
    '/library/recommended',
    '/favorites',
    '/shelves',
    '/library/my',
    '/library/bookmarks',
    '/library/notes'
  ];
  for (const path of pages) {
    const res = await fetch(base + path, { redirect: 'manual' });
    const body = await res.text();
    assert.equal(res.status, 200, `${path} -> ${res.status} ${body.slice(0, 300)}`);
    assert.ok(body.length > 200, `${path}: page looks empty (${body.length} bytes)`);
    assert.doesNotMatch(body, /Cannot read propert|is not a function|SQLITE_/i, `${path}: leaked internals`);
  }

  /* assert.ok + includes instead of assert.match: a failed match dumps the whole page (14 KB of
     markup) into the report, which buries the actual message. */
  const outside = await (await fetch(`${base}/facet/authors/${encodeURIComponent(AUTHOR_NAME)}/outside-series`)).text();
  assert.ok(outside.includes('Книга вне серий'), 'the standalone book is on the outside-series page');
  assert.ok(!outside.includes('Книга в серии'), 'the series book is not');

  /* The author page lists the author's SERIES, not the books inside them. */
  const authorPage = await (await fetch(`${base}/facet/authors/${encodeURIComponent(AUTHOR_NAME)}`)).text();
  assert.ok(authorPage.includes('Серия'), 'the author page lists the series');

  const search = await (await fetch(`${base}/catalog?q=${encodeURIComponent('вне серий')}`)).text();
  assert.ok(search.includes('Книга вне серий'), 'free-text search finds the title');
});
