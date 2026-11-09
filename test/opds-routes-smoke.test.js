/**
 * Smoke test of the OPDS routes on the isolated test DB: every feed answers 200 with well-formed output (v1 = XML
 * without stray `&`, v2 = JSON), including the feeds added later (Новинки, Подборки, Читаю / Прочитано / Мои оценки).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { initDb, db } from '../src/db.js';
import { registerOpdsRoutes } from '../src/routes/opds.js';
import { registerOpdsV2Routes } from '../src/routes/opds-v2.js';
import { stopQueryWorker } from '../src/services/query-pool.js';

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

test('OPDS v1 / v2 feeds answer 200 with well-formed output', async (t) => {
  initDb();
  for (const table of ['book_series', 'book_authors', 'books', 'authors', 'series_catalog']) db.exec(`DELETE FROM ${table}`);
  db.exec('DELETE FROM sources WHERE id = 1');
  db.prepare(`INSERT INTO sources (id, name, type, path, enabled) VALUES (1, 'src', 'folder', '/', 1)`).run();
  db.prepare(`INSERT INTO authors (name, display_name, sort_name, search_name, book_count) VALUES ('автор,имя', 'Автор Имя', 'автор имя', 'автор имя', 2)`).run();
  db.prepare(`INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count) VALUES ('серия', 'Серия', 'серия', 'серия', 1)`).run();
  insertBook('s1:1', 'Первая & книга', 'Автор,Имя', 'Серия');
  insertBook('s1:2', 'Вторая', 'Автор,Имя');
  const aid = db.prepare('SELECT id FROM authors').get().id;
  const sid = db.prepare('SELECT id FROM series_catalog').get().id;
  db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?), (?, ?)').run('s1:1', aid, 's1:2', aid);
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run('s1:1', sid, '1');

  const app = express();
  registerOpdsRoutes(app, { baseUrl: () => 'http://x' });
  registerOpdsV2Routes(app, { baseUrl: () => 'http://x' });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); stopQueryWorker(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('admin:admin').toString('base64')}` };

  const v1 = [
    '/opds', '/opds/new', '/opds/new?sort=title', '/opds/new?lang=ru', '/opds/collections', '/opds/user',
    '/opds/user/continue', '/opds/user/read', '/opds/user/rated', '/opds/user/shelves', '/opds/user/favorite-series',
    `/opds/author?author=${encodeURIComponent('=Автор,Имя')}`, `/opds/series?series=${encodeURIComponent('=серия')}`,
    '/opds/book?uid=s1:1', '/opds/genre',
  ];
  for (const path of v1) {
    const res = await fetch(base + path, { headers: auth });
    const body = await res.text();
    assert.equal(res.status, 200, `${path} → ${res.status} ${body.slice(0, 200)}`);
    assert.match(body, /^<\?xml/, path);
    assert.doesNotMatch(body, /&(?!amp;|lt;|gt;|quot;|#)/, `${path}: stray &`);
  }
  const authorFeed = await (await fetch(base + `/opds/author?author=${encodeURIComponent('=Автор,Имя')}`, { headers: auth })).text();
  assert.match(authorFeed, /Серия/);
  assert.match(authorFeed, /Вторая/);

  const v2 = ['/opds/v2', '/opds/v2/new', '/opds/v2/collections', '/opds/v2/user', '/opds/v2/user/continue',
    '/opds/v2/user/read', '/opds/v2/user/rated', `/opds/v2/series?prefix=${encodeURIComponent('=серия')}`, '/opds/v2/genres'];
  for (const path of v2) {
    const res = await fetch(base + path, { headers: auth });
    const body = await res.text();
    assert.equal(res.status, 200, `${path} → ${res.status} ${body.slice(0, 200)}`);
    assert.doesNotThrow(() => JSON.parse(body), path);
  }
  // Caching: an unchanged feed revalidates with 304 (Express weak ETag on res.send), no body sent again
  const first = await fetch(base + '/opds/collections', { headers: auth });
  const etag = first.headers.get('etag');
  assert.ok(etag, 'feed has an ETag');
  // node:http, not fetch: fetch adds Cache-Control: no-cache to a conditional request, which (rightly) disables 304
  const status = await new Promise((resolve, reject) => {
    http.get(base + '/opds/collections', { headers: { ...auth, 'If-None-Match': etag } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 304);

  const unauthorized = await fetch(base + '/opds/new');
  assert.equal(unauthorized.status, 401);
});
