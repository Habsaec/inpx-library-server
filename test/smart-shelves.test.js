import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initDb, db, createUser, deleteUser, getUserStats } from '../src/db.js';
import {
  parseSmartShelfFilter, serializeSmartShelfFilter, createSmartShelf, updateSmartShelf, deleteSmartShelf,
  listSmartShelves, getSmartShelf, getSmartShelfBooks, setSmartShelfOnHome
} from '../src/smart-shelves.js';
import { registerSmartShelfRoutes } from '../src/routes/smart-shelves.js';
import { registerOpdsRoutes } from '../src/routes/opds.js';
import { renderShelves, renderCatalog, renderHome } from '../src/templates/library.js';
import { getPinnedHomeShelves } from '../src/routes/library.js';

const SOURCE_ID = 9301;
const USER = 'smart_shelf_user';
const OTHER = 'smart_shelf_other';
const PASSWORD = 'SmartShelf1!';
const IDS = ['smart-sf-ru', 'smart-sf-en', 'smart-det-ru'];

let server;
let baseUrl;

before(async () => {
  initDb();
  for (const username of [USER, OTHER]) {
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) createUser({ username, password: PASSWORD });
  }
  db.exec(`DELETE FROM books WHERE source_id = ${SOURCE_ID}`);
  db.exec(`DELETE FROM sources WHERE id = ${SOURCE_ID}`);
  db.prepare(`INSERT INTO sources (id, name, type, path, enabled) VALUES (${SOURCE_ID}, 'smart-shelf-test', 'folder', '/', 1)`).run();
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id, imported_at
    ) VALUES (?, ?, 'Smart Author', ?, '', '', ?, 'smart author', '', 0, ?, 'smart author', '', '', '', ?, '', 1, ?, 0,
      'fb2', '', ?, '', 0, ${SOURCE_ID}, 0)
  `);
  const genreRow = db.prepare('INSERT OR IGNORE INTO genres_catalog (name) VALUES (?)');
  const link = db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, (SELECT id FROM genres_catalog WHERE name = ?))');
  const add = (id, title, genre, lang) => {
    insert.run(id, title, genre, title.toLowerCase(), title.toLowerCase(), `${id}.fb2`, id, lang);
    genreRow.run(genre);
    link.run(id, genre);
  };
  add(IDS[0], 'Smart Alpha', 'smartsf', 'ru');
  add(IDS[1], 'Smart Beta', 'smartsf', 'en');
  add(IDS[2], 'Smart Gamma', 'smartdet', 'ru');

  const app = express();
  app.use(express.json());
  registerSmartShelfRoutes(app);
  registerOpdsRoutes(app, { baseUrl: () => 'http://example' });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const auth = (username, extra = {}) => ({
  Authorization: `Basic ${Buffer.from(`${username}:${PASSWORD}`).toString('base64')}`,
  ...extra
});
const json = (username) => auth(username, { 'Content-Type': 'application/json' });

test('filter parsing normalizes input and rejects an empty filter', () => {
  const f = parseSmartShelfFilter('?genre=smartsf&genre=smartdet&lang=ru&year=1999&minRate=9&hasSeries=1&sort=bogus&page=3&field=authors');
  assert.deepEqual(f.genre, ['smartsf', 'smartdet']);
  assert.equal(f.lang, 'ru');
  assert.equal(f.year, 1999);
  assert.equal(f.minRate, 5);
  assert.equal(f.hasSeries, 1);
  assert.equal(f.sort, 'title');

  assert.equal(serializeSmartShelfFilter(parseSmartShelfFilter({ q: ' dune ', genre: 'a,b', genreMode: 'and' })),
    'q=dune&genre=a&genre=b&genreMode=and&sort=title');
  assert.equal(serializeSmartShelfFilter(parseSmartShelfFilter({ genre: 'a', genreMode: 'and' })), 'genre=a&sort=title',
    'genreMode only matters with several genres');
  assert.equal(parseSmartShelfFilter({ year: 1700, lang: 'ru' }).year, 0);
  assert.throws(() => parseSmartShelfFilter(''), /Фильтр умной полки пуст/);
  assert.throws(() => parseSmartShelfFilter({ sort: 'recent' }), /Фильтр умной полки пуст/);
});

test('smart shelf CRUD is per user and validates names', () => {
  const id = createSmartShelf(USER, ' Фантастика ', { genre: 'smartsf', lang: 'ru' });
  assert.deepEqual(listSmartShelves(USER).map((s) => s.name), ['Фантастика']);
  assert.equal(getSmartShelf(id, USER).catalogUrl, '/catalog?genre=smartsf&lang=ru&sort=title');
  assert.equal(getSmartShelf(id, OTHER), null);
  assert.deepEqual(listSmartShelves(OTHER), []);
  assert.equal(getUserStats(USER).smartShelvesCount, 1, 'profile / «Моя библиотека» count smart shelves');
  assert.equal(getUserStats(OTHER).smartShelvesCount, 0);

  assert.throws(() => createSmartShelf(USER, 'Фантастика', { genre: 'x' }), /уже существует/);
  assert.throws(() => createSmartShelf(USER, '  ', { genre: 'x' }), /не указано/);
  assert.throws(() => createSmartShelf(USER, 'Пустая', {}), /пуст/);

  assert.equal(updateSmartShelf(id, USER, { name: 'Sci-fi' }), 1);
  assert.equal(getSmartShelf(id, USER).query, 'genre=smartsf&lang=ru&sort=title', 'filter kept when only renamed');
  assert.equal(updateSmartShelf(id, OTHER, { name: 'steal' }), 0);
  assert.equal(deleteSmartShelf(id, OTHER), 0);
  assert.equal(deleteSmartShelf(id, USER), 1);
});

test('smart shelf picks books from the live catalog', () => {
  const id = createSmartShelf(USER, 'Live', { genre: 'smartsf' });
  const shelf = getSmartShelf(id, USER);
  assert.deepEqual(getSmartShelfBooks(shelf).items.map((b) => b.id).sort(), [IDS[1], IDS[0]]);

  updateSmartShelf(id, USER, { filter: { genre: 'smartsf', lang: 'ru' } });
  const narrowed = getSmartShelfBooks(getSmartShelf(id, USER));
  assert.deepEqual(narrowed.items.map((b) => b.id), [IDS[0]]);
  assert.equal(narrowed.total, 1);
  deleteSmartShelf(id, USER);
});

test('smart shelves API: auth, create, list, books, update, delete', async () => {
  assert.equal((await fetch(`${baseUrl}/api/smart-shelves`)).status, 401);

  const bad = await fetch(`${baseUrl}/api/smart-shelves`, { method: 'POST', headers: json(USER), body: JSON.stringify({ name: 'Empty', query: {} }) });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'VALIDATION');

  const created = await (await fetch(`${baseUrl}/api/smart-shelves`, {
    method: 'POST', headers: json(USER), body: JSON.stringify({ name: 'API shelf', query: { genre: ['smartdet'] } })
  })).json();
  assert.equal(created.ok, true);

  const list = await (await fetch(`${baseUrl}/api/smart-shelves`, { headers: auth(USER) })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].query, 'genre=smartdet&sort=title');
  assert.equal(list[0].bookCount, undefined);

  const preview = await (await fetch(`${baseUrl}/api/smart-shelves?preview=1`, { headers: auth(USER) })).json();
  assert.equal(preview[0].bookCount, 1);
  assert.deepEqual(preview[0].previewBookIds, [IDS[2]]);

  const books = await (await fetch(`${baseUrl}/api/smart-shelves/${created.id}/books`, { headers: auth(USER) })).json();
  assert.deepEqual(books.items.map((b) => b.id), [IDS[2]]);
  assert.equal(books.total, 1);
  assert.equal(books.page, 1);
  assert.equal(books.pageSize, 24);

  const rows = await (await fetch(`${baseUrl}/api/smart-shelves/${created.id}/books?pageSize=20`, { headers: auth(USER) })).json();
  assert.equal(rows.pageSize, 20);
  const capped = await (await fetch(`${baseUrl}/api/smart-shelves/${created.id}/books?pageSize=500`, { headers: auth(USER) })).json();
  assert.equal(capped.pageSize, 24);

  assert.equal((await fetch(`${baseUrl}/api/smart-shelves/${created.id}/books`, { headers: auth(OTHER) })).status, 404);

  const put = await fetch(`${baseUrl}/api/smart-shelves/${created.id}`, { method: 'PUT', headers: json(USER), body: JSON.stringify({ name: 'Renamed' }) });
  assert.equal(put.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/smart-shelves/999999`, { method: 'PUT', headers: json(USER), body: JSON.stringify({ name: 'x' }) })).status, 404);

  assert.equal((await fetch(`${baseUrl}/api/smart-shelves/${created.id}`, { method: 'DELETE', headers: auth(USER) })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/smart-shelves/${created.id}`, { method: 'DELETE', headers: auth(USER) })).status, 404);
});

test('OPDS exposes smart shelves as navigation and a books feed', async () => {
  const id = createSmartShelf(USER, 'OPDS shelf', { genre: 'smartsf', lang: 'en' });

  const user = await (await fetch(`${baseUrl}/opds/user`, { headers: auth(USER) })).text();
  assert.ok(user.includes('/opds/user/smart-shelves'));

  const nav = await (await fetch(`${baseUrl}/opds/user/smart-shelves`, { headers: auth(USER) })).text();
  assert.ok(nav.includes(`/opds/user/smart-shelves/${id}`));
  assert.ok(nav.includes('OPDS shelf'));

  const feed = await fetch(`${baseUrl}/opds/user/smart-shelves/${id}`, { headers: auth(USER) });
  assert.equal(feed.status, 200);
  const xml = await feed.text();
  assert.ok(xml.includes('Smart Beta'));
  assert.ok(!xml.includes('Smart Alpha'));

  assert.equal((await fetch(`${baseUrl}/opds/user/smart-shelves/${id}`, { headers: auth(OTHER) })).status, 404);
  deleteSmartShelf(id, USER);
});

test('shelves page lists smart shelves and deleting a user drops them', () => {
  const html = renderShelves({
    shelves: [], user: { username: USER, role: 'user' }, stats: {}, indexStatus: {}, csrfToken: 'tok',
    smartShelves: [{ id: 7, name: 'Русский sf', query: 'genre=sf&lang=ru&sort=title', catalogUrl: '/catalog?genre=sf&lang=ru&sort=title' }]
  });
  assert.ok(html.includes('data-href="/catalog?genre=sf&amp;lang=ru&amp;sort=title"'));
  assert.ok(html.includes('action="/shelves/smart/7/delete"'));
  assert.ok(html.includes('Русский sf'));

  const temp = 'smart_shelf_temp';
  createUser({ username: temp, password: PASSWORD });
  createSmartShelf(temp, 'tmp', { q: 'x' });
  deleteUser(temp);
  assert.deepEqual(listSmartShelves(temp), []);
});

test('catalog filter panel offers "save as smart shelf" only to signed-in users with an active filter', () => {
  const props = {
    items: [], total: 0, page: 1, pageSize: 24, query: 'dune', field: 'books', sort: 'title', genres: ['smartsf'], lang: 'ru',
    stats: {}, indexStatus: {}
  };
  const withUser = renderCatalog({ ...props, user: { username: USER, role: 'user' }, csrfToken: 'tok' });
  assert.ok(withUser.includes('action="/shelves/smart"'));
  const saved = new URLSearchParams(/name="query" value="([^"]*)"/.exec(withUser)[1].replace(/&amp;/g, '&'));
  assert.equal(saved.get('q'), 'dune');
  assert.equal(saved.get('lang'), 'ru');
  assert.deepEqual(saved.getAll('genre'), ['smartsf']);
  assert.equal(saved.has('field'), false);

  assert.ok(!renderCatalog({ ...props, user: null }).includes('action="/shelves/smart"'));
  assert.ok(!renderCatalog({ ...props, query: '', genres: [], lang: '', user: { username: USER, role: 'user' }, csrfToken: 'tok' })
    .includes('action="/shelves/smart"'), 'nothing to save without a query or filter');
});

test('smart shelves show cover previews like regular shelves and can be pinned to home', () => {
  const id = createSmartShelf(USER, 'Pinned', { genre: 'smartsf' });
  const [plain] = listSmartShelves(USER);
  assert.equal(plain.previewBookIds, undefined, 'previews are opt-in (API/OPDS stay cheap)');
  assert.equal(plain.onHome, 0);

  const [shelf] = listSmartShelves(USER, { withPreview: true });
  assert.equal(shelf.bookCount, 2);
  assert.deepEqual([...shelf.previewBookIds].sort(), [IDS[1], IDS[0]].sort());

  assert.equal(setSmartShelfOnHome(id, OTHER, true), 0, 'other users cannot pin');
  assert.equal(setSmartShelfOnHome(id, USER, true), 1);
  assert.equal(listSmartShelves(USER)[0].onHome, 1);

  const user = { username: USER, role: 'user' };
  const page = renderShelves({ shelves: [], smartShelves: [{ ...shelf, onHome: 1 }], user, stats: {}, indexStatus: {}, csrfToken: 'tok' });
  assert.ok(page.includes('shelf-cover-thumb'), 'smart shelf row has cover thumbs');
  assert.ok(page.includes(`action="/shelves/smart/${id}/home"`));
  assert.ok(/name="on" value="0"/.test(page), 'pinned shelf offers to unpin');

  const regular = renderShelves({
    shelves: [{ id: 5, name: 'Reg', bookCount: 0, previewBookIds: [], onHome: 0 }],
    smartShelves: [], user, stats: {}, indexStatus: {}, csrfToken: 'tok'
  });
  assert.ok(regular.includes('action="/shelves/5/home"'));
  assert.ok(/name="on" value="1"/.test(regular));

  const book = { id: IDS[0], title: 'Smart Alpha', authors: 'Smart Author', genres: 'smartsf', ext: 'fb2', lang: 'ru' };
  const homeShelves = [{ title: 'Pinned shelf title', href: '/catalog?a=1&b=2', items: [book] }];
  const home = renderHome({ user, stats: {}, indexStatus: {}, sections: { newest: [] }, homeShelves });
  assert.ok(home.includes('Pinned shelf title'));
  assert.ok(home.includes('href="/catalog?a=1&amp;b=2"'));
  assert.ok(!renderHome({ user: null, stats: {}, indexStatus: {}, sections: { newest: [] }, homeShelves }).includes('Pinned shelf title'));
  deleteSmartShelf(id, USER);
});

test('pinned home shelves (web home and /api/home/shelves) keep only pinned non-empty shelves', () => {
  const pinned = createSmartShelf(USER, 'Home pinned', { genre: 'smartsf' });
  const empty = createSmartShelf(USER, 'Home empty', { q: 'no-such-book-zzz' });
  createSmartShelf(USER, 'Home unpinned', { genre: 'smartdet' });
  setSmartShelfOnHome(pinned, USER, true);
  setSmartShelfOnHome(empty, USER, true);

  const shelves = getPinnedHomeShelves(USER, 1);
  assert.deepEqual(shelves.map((s) => [s.kind, s.id, s.title]), [['smart', pinned, 'Home pinned']]);
  assert.equal(shelves[0].items.length, 1, 'limit applies per shelf');
  assert.deepEqual(getPinnedHomeShelves(OTHER, 8), []);

  for (const shelf of listSmartShelves(USER)) deleteSmartShelf(shelf.id, USER);
});

test('smart shelf preview is cached until the catalog caches reset', async () => {
  const { markLibraryDedupProjectionStale } = await import('../src/inpx.js');
  const id = createSmartShelf(USER, 'Cached preview', { genre: 'smartdet' });
  const preview = () => listSmartShelves(USER, { withPreview: true }).find((s) => s.id === id);
  assert.equal(preview().bookCount, 1);

  db.prepare("UPDATE books SET deleted = 1 WHERE id = ?").run(IDS[2]);
  try {
    assert.equal(preview().bookCount, 1, 'repeated polls reuse the cached preview');
    markLibraryDedupProjectionStale();
    assert.equal(preview().bookCount, 0, 'a catalog cache reset refreshes it');
  } finally {
    db.prepare("UPDATE books SET deleted = 0 WHERE id = ?").run(IDS[2]);
    markLibraryDedupProjectionStale();
    deleteSmartShelf(id, USER);
  }
});
