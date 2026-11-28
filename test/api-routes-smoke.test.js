/**
 * Smoke test of the read-only `/api/*` endpoints the Android reader and the web UI live on.
 *
 * This is the contract with a client that is not in this repository: a route that starts
 * answering 500 or drops a field is noticed by the app, not by CI. The test only reads —
 * no POST, no mutation — so it is deterministic and safe to run on every push.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { initDb, db } from '../src/db.js';
import { registerBrowseApiRoutes } from '../src/routes/browse-api.js';
import { registerUserApiRoutes } from '../src/routes/user-api.js';
import { registerNotesRoutes } from '../src/routes/notes.js';
import { registerSmartShelfRoutes } from '../src/routes/smart-shelves.js';
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

test('read-only API endpoints answer on a minimal catalog', async (t) => {
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
  insertBook('s1:2', 'Книга вне серий', AUTHOR_DISPLAY);
  const authorId = db.prepare('SELECT id FROM authors').get().id;
  const seriesId = db.prepare('SELECT id FROM series_catalog').get().id;
  db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?), (?, ?)').run('s1:1', authorId, 's1:2', authorId);
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run('s1:1', seriesId, '1');

  const app = express();
  app.use(express.json());
  const batchEmailLocks = new Set();
  registerBrowseApiRoutes(app);
  registerUserApiRoutes(app, { batchEmailLocks });
  registerNotesRoutes(app, { batchEmailLocks });
  registerSmartShelfRoutes(app);
  const server = await new Promise((resolve) => {
    const listener = http.createServer(app).listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => { server.close(); stopQueryWorker(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };
  const q = encodeURIComponent;
  const author = q(AUTHOR_NAME);
  const series = q(SERIES_NAME);

  const endpoints = [
    `/api/search?q=${q('книга')}`,
    `/api/search/suggest?q=${q('кни')}`,
    `/api/search/genres?q=${q('книга')}`,
    '/api/catalog',
    `/api/catalog?q=${q('книга')}&sort=title`,
    '/api/catalog?genre=sf&minRate=0',
    '/api/browse/index?kind=authors',
    '/api/browse/index?kind=series',
    '/api/browse/authors',
    '/api/browse/series',
    '/api/browse/genres',
    `/api/browse/authors/${author}/grouped`,
    `/api/browse/authors/${author}/grouped?lean=1`,
    `/api/facet-books?facet=authors&value=${author}`,
    '/api/facet-books?facet=genres&value=sf',
    '/api/books/s1:1/meta',
    '/api/library/recent',
    '/api/library/continue',
    '/api/library/read',
    '/api/library/want',
    '/api/library/rated',
    '/api/library/recommended',
    '/api/favorites',
    '/api/bookmarks',
    '/api/history',
    '/api/shelves',
    '/api/smart-shelves',
    `/api/series-progress?name=${series}`,
    `/api/series-info?name=${series}`,
    '/api/reading-stats',
    '/api/reading-stats/year',
    '/api/ereader-email',
    '/api/account-email',
    '/api/recommendations/excluded-authors'
  ];

  for (const path of endpoints) {
    const res = await fetch(base + path, { headers: auth });
    const body = await res.text();
    assert.equal(res.status, 200, `${path} -> ${res.status} ${body.slice(0, 240)}`);
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      assert.fail(`${path}: not JSON (${body.slice(0, 120)})`);
    }
    assert.ok(json && typeof json === 'object', `${path}: empty payload`);
    assert.ok(!json.error, `${path}: answered with an error: ${json.error}`);
    assert.match(res.headers.get('content-type') || '', /json/, `${path}: content-type is not JSON`);
  }

  const catalog = await (await fetch(`${base}/api/catalog?q=${q('вне серий')}`, { headers: auth })).json();
  assert.ok(Array.isArray(catalog.items) && catalog.items.length >= 1, 'catalog search returns the book');
  assert.ok(catalog.items.some((book) => book.title === 'Книга вне серий'), 'the right book is found');

  const meta = await (await fetch(`${base}/api/books/s1:1/meta`, { headers: auth })).json();
  assert.ok(meta.id || meta.bookId || meta.title, 'book meta carries an identity');

  const info = await (await fetch(`${base}/api/series-info?name=${series}`, { headers: auth })).json();
  assert.equal(info.name, SERIES_NAME, 'series info resolves the series');

  const unauthorized = await fetch(`${base}/api/catalog`);
  assert.equal(unauthorized.status, 401, 'without credentials the API answers 401, not 500');
});
