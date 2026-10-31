import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { initDb, db, createUser } from '../src/db.js';
import { createSortKey, addReadBooksIfMissing } from '../src/inpx.js';
import {
  parseCollection, importCollectionJson, matchCollectionItem, matchCollectionsNow,
  listCollections, getCollection, setCollectionEnabled, deleteCollection, syncBundledCollections, setCollectionOnHome
} from '../src/collections.js';
import { registerCollectionRoutes } from '../src/routes/collections.js';
import { getPinnedHomeShelves, getPinnedHomeCollections } from '../src/routes/library.js';
import { normalizeHomeLayout, setUserHomeLayout } from '../src/home-layout.js';
import { renderCollection, renderCollections, renderHome } from '../src/templates/library.js';

const SOURCE_ID = 9411;
const USER = 'collections_user';
const PASSWORD = 'Collections1!';

let server;
let baseUrl;

const auth = { Authorization: `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}` };

before(async () => {
  initDb();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(USER)) createUser({ username: USER, password: PASSWORD });
  db.exec(`DELETE FROM books WHERE source_id = ${SOURCE_ID}`);
  db.exec(`DELETE FROM sources WHERE id = ${SOURCE_ID}`);
  db.prepare(`INSERT INTO sources (id, name, type, path, enabled) VALUES (${SOURCE_ID}, 'collections-test', 'folder', '/', 1)`).run();
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id, imported_at
    ) VALUES (?, ?, ?, '', '', '', ?, '', '', 0, ?, '', '', '', '', ?, '', 1, ?, 0, 'fb2', '', ?, '', ?, ${SOURCE_ID}, 0)
  `);
  const add = (id, title, authors, lang = 'ru', rate = 0) =>
    insert.run(id, title, authors, title.toLowerCase(), createSortKey(title), `${id}.fb2`, id, lang, rate);
  add('col-master', 'Мастер и Маргарита', 'Булгаков,Михаил,Афанасьевич:', 'ru', 5);
  add('col-master-essay', '«Мастер и Маргарита»: гимн демонизму?', 'Кураев,Андрей,Вячеславович:');
  add('col-mashenka-wrong', 'Машенька', 'Логинов,Святослав,Владимирович:');
  add('col-mashenka', 'Машенька', 'Набоков,Владимир,Владимирович:');
  add('col-dune', 'Дюна', 'Херберт,Фрэнк,:');
  add('col-kill', 'Убить пересмешника', 'Ли,Харпер,:');
  add('col-kill-wrong', 'Убить пересмешника', 'Лившиц,Иван,:');
  add('col-chairs', 'Двенадцать стульев', 'Петров,Евгений,Петрович:Ильф,Илья,Арнольдович:');

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  registerCollectionRoutes(app, { getCachedStats: () => ({}) });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  db.exec("DELETE FROM collections WHERE slug LIKE 'test-%'");
  db.exec(`DELETE FROM books WHERE source_id = ${SOURCE_ID}`);
  db.exec(`DELETE FROM sources WHERE id = ${SOURCE_ID}`);
  await new Promise((resolve) => server.close(resolve));
});

test('parseCollection validates slug, title and items', () => {
  assert.throws(() => parseCollection({ slug: 'Bad Slug', title: 'x', items: [{ title: 'a' }] }), /slug/);
  assert.throws(() => parseCollection({ slug: 'ok', items: [{ title: 'a' }] }), /title/);
  assert.throws(() => parseCollection({ slug: 'ok', title: 'x', items: [] }), /items/);
  const parsed = parseCollection({
    slug: 'ok-list', title: '  Список ', url: 'javascript:alert(1)',
    items: [{ author: 'A', title: 'Книга', year: '1965' }, { author: 'no title' }, { title: 'Вторая', year: 0 }]
  });
  assert.equal(parsed.title, 'Список');
  assert.equal(parsed.sourceUrl, '', 'only http(s) source links');
  assert.deepEqual(parsed.items.map((i) => [i.title, i.year]), [['Книга', 1965], ['Вторая', null]]);
});

test('matchCollectionItem: exact title, surname stem, no first-name / patronymic hits', () => {
  assert.equal(matchCollectionItem('Михаил Булгаков', 'Мастер и Маргарита')?.id, 'col-master');
  assert.equal(matchCollectionItem('Владимир Набоков', 'Машенька')?.id, 'col-mashenka', 'Владимир ≠ отчество Владимирович');
  assert.equal(matchCollectionItem('Фрэнк Герберт', 'Дюна: роман')?.id, 'col-dune', 'Герберт / Херберт, «: роман» dropped');
  assert.equal(matchCollectionItem('Харпер Ли', 'Убить пересмешника')?.id, 'col-kill', 'short surname must be whole');
  assert.equal(matchCollectionItem('Илья Ильф, Евгений Петров', 'Двенадцать стульев')?.id, 'col-chairs');
  assert.equal(matchCollectionItem('Лев Толстой', 'Мастер и Маргарита'), null, 'author must match');
  assert.equal(matchCollectionItem('Кто-то', 'Нет такой книги'), null);
});

test('import → match → list / get with read counts; disable and delete', async () => {
  const json = JSON.stringify({
    slug: 'test-classics', title: 'Тест: классика', source: 'Тест', url: 'https://example.com/list', display_order: -5,
    items: [
      { author: 'Михаил Булгаков', title: 'Мастер и Маргарита', year: 1940, note: 'Роман' },
      { author: 'Владимир Набоков', title: 'Машенька' },
      { author: 'Нет Автора', title: 'Нет такой книги' }
    ]
  });
  const { id, slug, items } = importCollectionJson(json);
  assert.equal(slug, 'test-classics');
  assert.equal(items, 3);
  assert.throws(() => importCollectionJson('{not json'), /JSON/);
  await matchCollectionsNow();

  const listed = listCollections().find((c) => c.slug === 'test-classics');
  assert.equal(listed.total, 3);
  assert.equal(listed.found, 2);
  assert.equal(listed.matching, false);
  assert.deepEqual(listed.previewBookIds, ['col-master', 'col-mashenka']);

  addReadBooksIfMissing(USER, ['col-mashenka']);
  const full = getCollection('test-classics', { username: USER });
  assert.equal(full.read, 1);
  assert.deepEqual(full.items.map((i) => i.book?.id || null), ['col-master', 'col-mashenka', null]);
  assert.equal(full.items[0].note, 'Роман');

  const page = renderCollection({ collection: full, user: { username: USER }, readBookIds: new Set(['col-mashenka']) });
  assert.match(page, /class="grid"/, 'found books use the regular cover grid');
  assert.ok(page.indexOf('Мастер и Маргарита') < page.indexOf('Машенька'), 'list order kept');
  assert.match(page, /Нет такой книги/);
  assert.match(page, /href="https:\/\/example\.com\/list"/);
  assert.match(renderCollection({ collection: full, listView: true }), /catalog-book-list/, 'list view = regular book rows');
  assert.match(renderCollections({ collections: listCollections() }), /\/collections\/test-classics/);

  const apiList = await fetch(`${baseUrl}/api/collections`, { headers: auth }).then((r) => r.json());
  const entry = apiList.items.find((c) => c.slug === 'test-classics');
  assert.equal(entry.found, 2);
  assert.equal(entry.id, undefined, 'no internal id in the API');
  const apiOne = await fetch(`${baseUrl}/api/collections/test-classics`, { headers: auth }).then((r) => r.json());
  assert.equal(apiOne.items.length, 3);
  assert.equal(apiOne.items[1].read, true);
  assert.equal(apiOne.items[0].book.id, 'col-master');
  assert.equal((await fetch(`${baseUrl}/api/collections/nope`, { headers: auth })).status, 404);

  // Pin to the home page: per user, only with `collections` (old apps treat any non-smart item as a shelf id).
  assert.equal(entry.onHome, 0);
  const pin = await fetch(`${baseUrl}/api/collections/test-classics/home`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true })
  }).then((r) => r.json());
  assert.deepEqual(pin, { ok: true, onHome: 1 });
  assert.equal((await fetch(`${baseUrl}/api/collections/nope/home`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true })
  })).status, 404);
  assert.equal(getCollection('test-classics', { username: USER }).onHome, 1);
  assert.equal(getPinnedHomeShelves(USER, 10).some((s) => s.kind === 'collection'), false, 'not without opt-in');
  const homeShelf = getPinnedHomeShelves(USER, 10, { collections: true }).find((s) => s.kind === 'collection');
  assert.equal(homeShelf.slug, 'test-classics');
  assert.equal(homeShelf.href, '/collections/test-classics');
  // Own home block «Закреплённые подборки» (`collections` in homeLayout), next to «Закреплённые полки».
  assert.deepEqual(getPinnedHomeCollections(USER, 10).map((s) => s.slug), ['test-classics']);
  const home = renderHome({ user: { username: USER }, stats: {}, homeCollections: getPinnedHomeCollections(USER, 10), homeLayout: normalizeHomeLayout({ order: ['collections'] }) });
  assert.match(home, /href="\/collections\/test-classics"/);
  assert.doesNotMatch(renderHome({ user: { username: USER }, stats: {}, homeCollections: getPinnedHomeCollections(USER, 10), homeLayout: normalizeHomeLayout({ hidden: ['collections'] }) }), /\/collections\/test-classics/, 'hidden block');
  assert.deepEqual(homeShelf.items.map((b) => b.id), ['col-master', 'col-mashenka']);
  assert.equal(setCollectionOnHome(USER, 'test-classics', false), 0);
  assert.equal(getPinnedHomeShelves(USER, 10, { collections: true }).some((s) => s.kind === 'collection'), false);
  setCollectionOnHome(USER, 'test-classics', true);

  setCollectionEnabled(id, false);
  assert.equal(getPinnedHomeShelves(USER, 10, { collections: true }).some((s) => s.kind === 'collection'), false, 'disabled is not pinned');
  assert.equal(getCollection('test-classics'), null, 'disabled collection is hidden');
  assert.ok(getCollection('test-classics', { includeDisabled: true }));
  assert.equal(deleteCollection(id), true);
  assert.equal(listCollections({ includeDisabled: true }).some((c) => c.slug === 'test-classics'), false);
});

test('bundled collections are loaded once and cannot be deleted', () => {
  syncBundledCollections();
  assert.equal(syncBundledCollections(), 0, 'unchanged files are not rewritten');
  const builtin = listCollections({ includeDisabled: true }).filter((c) => c.builtin);
  assert.ok(builtin.length >= 6, 'collections/*.json');
  assert.equal(deleteCollection(builtin[0].id), false);
  // The user's drag order (homeLayout.collectionOrder) orders their list; others keep display_order.
  const last = listCollections().at(-1).slug;
  setUserHomeLayout(USER, { collectionOrder: [last] });
  assert.equal(listCollections({ username: USER })[0].slug, last);
  assert.notEqual(listCollections()[0].slug, last);
  setUserHomeLayout(USER, { collectionOrder: [] });
});
