import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDb,
  db,
  setSetting,
  getSetting,
  rebuildActiveBooksView,
  isActiveBooksProjectionFresh,
  ensureActiveBooksProjection,
  refreshCatalogBookCounts
} from '../src/db.js';
import { searchCatalog } from '../src/inpx.js';

const TITLE = 'скрытаякнигаязык';
const RU_ID = 'hidden-lang-ru';
const EN_ID = 'hidden-lang-en';

function insertBook(id, lang, title = TITLE) {
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, '', '', '', '',
      ?, '',
      '', 0, ?, '', '',
      '', '', ?, 'a.zip', 1, ?, 0,
      'fb2', '', ?, '', 0, NULL
    )
  `).run(id, title, title, title, `${id}.fb2`, id, lang);
}

let prevExcluded = '';

before(async () => {
  initDb();
  db.prepare('DELETE FROM books WHERE id IN (?, ?)').run(RU_ID, EN_ID);
  insertBook(RU_ID, 'ru');
  insertBook(EN_ID, 'en');
  prevExcluded = getSetting('excluded_languages') || '';
  setSetting('excluded_languages', prevExcluded ? `${prevExcluded},en` : 'en');
  await rebuildActiveBooksView();
});

after(async () => {
  db.prepare('DELETE FROM books WHERE id IN (?, ?)').run(RU_ID, EN_ID);
  setSetting('excluded_languages', prevExcluded);
  await rebuildActiveBooksView();
});

test('search total skips books in excluded languages', () => {
  const ftsHits = Number(db.prepare(`
    SELECT COUNT(*) AS c FROM books_fts WHERE books_fts MATCH ?
  `).get(`"${TITLE}"`).c) || 0;
  assert.equal(ftsHits, 2);

  const result = searchCatalog({ query: TITLE, field: 'books', page: 1, pageSize: 24 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, RU_ID);
  assert.equal(result.total, result.items.length);
});

test('plain catalog uses the fresh visibility projection', () => {
  assert.equal(isActiveBooksProjectionFresh(), true);
  const result = searchCatalog({ query: '', field: 'books', page: 1, pageSize: 24 });
  assert.ok(result.items.some((book) => book.id === RU_ID));
  assert.ok(!result.items.some((book) => book.id === EN_ID));
});

test('plain catalog falls back to the dynamic view while the projection is dirty', () => {
  const id = 'projection-dirty-ru';
  insertBook(id, 'ru', 'projection dirty fallback');
  assert.equal(isActiveBooksProjectionFresh(), false);
  const result = searchCatalog({ query: '', field: 'books', page: 1, pageSize: 24 });
  assert.ok(result.items.some((book) => book.id === id));
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
});

const visibleInProjection = (id) => Boolean(db.prepare('SELECT 1 FROM active_book_ids WHERE book_id = ?').get(id));

test('refreshCatalogBookCounts never rebuilds the projection synchronously; ensure() republishes it', async () => {
  const id = 'projection-refresh-ru';
  insertBook(id, 'ru', 'projection refresh');
  assert.equal(isActiveBooksProjectionFresh(), false);
  await refreshCatalogBookCounts();
  assert.equal(isActiveBooksProjectionFresh(), false, 'only a debounced background rebuild is scheduled');

  assert.equal(await ensureActiveBooksProjection(), true);
  assert.equal(isActiveBooksProjectionFresh(), true);
  assert.equal(visibleInProjection(id), true);
  assert.equal(visibleInProjection(EN_ID), false, 'excluded language stays hidden');
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  assert.equal(isActiveBooksProjectionFresh(), false);
  await ensureActiveBooksProjection();
  assert.equal(visibleInProjection(id), false);
});

test('a write that races with a rebuild is never published as fresh', async () => {
  const id = 'projection-race-ru';
  insertBook('projection-race-tmp', 'ru', 'projection race tmp');
  db.prepare('DELETE FROM books WHERE id = ?').run('projection-race-tmp'); // makes the projection stale
  const rebuilding = ensureActiveBooksProjection(); // first (sync) part already marked the state as "building"
  insertBook(id, 'ru', 'projection race');
  assert.equal(isActiveBooksProjectionFresh(), false);
  assert.equal(await rebuilding, true, 'a follow-up pass picks the new book up');
  assert.equal(visibleInProjection(id), true);
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  await ensureActiveBooksProjection();
});
