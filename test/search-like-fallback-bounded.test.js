import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db } from '../src/db.js';
import { searchCatalog, listSearchGenres } from '../src/inpx.js';

/*
 * `*needle` (contains) and the dirty-FTS fallback used to run COUNT + ORDER BY with
 * LIKE over every active book: the Android app retried a zero-hit «Tolkien» as
 * «*Tolkien» and the 700k-book library stalled the event loop for 21 s.
 * Candidates now come from FTS word prefixes, the author index and a time-boxed
 * rowid scan (SEARCH_LIKE_SCAN_BUDGET_MS).
 */

const BOOKS = [
  { id: 'likefb-en', title: 'The Philosophy of Quorvexian Lore', lang: 'en' },
  { id: 'likefb-ru', title: 'Quorvexian и его мир', lang: 'ru' },
  { id: 'likefb-mid', title: 'Hyperquorvexianism', lang: 'en' }
];

function insertBook({ id, title, lang }) {
  const search = title.toLowerCase();
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
  `).run(id, title, search, search, `${id}.fb2`, id, lang);
}

const deleteBooks = () => {
  db.prepare(`DELETE FROM books WHERE id IN (${BOOKS.map(() => '?').join(',')})`).run(...BOOKS.map((b) => b.id));
};

const prevBudget = process.env.SEARCH_LIKE_SCAN_BUDGET_MS;

before(() => {
  initDb();
  deleteBooks();
  for (const book of BOOKS) insertBook(book);
});

afterEach(() => {
  if (prevBudget == null) delete process.env.SEARCH_LIKE_SCAN_BUDGET_MS;
  else process.env.SEARCH_LIKE_SCAN_BUDGET_MS = prevBudget;
});

after(() => {
  deleteBooks();
});

const ids = (result) => result.items.map((book) => book.id).sort();

test('*word finds word-prefix hits through FTS without any LIKE scan', () => {
  process.env.SEARCH_LIKE_SCAN_BUDGET_MS = '0';
  const result = searchCatalog({ query: '*Quorvexian', field: 'books', page: 1, pageSize: 24 });
  assert.deepEqual(ids(result), ['likefb-en', 'likefb-ru']);
  assert.equal(result.total, 2);
  assert.equal(result.partial, true, 'skipped scan is reported as partial');
});

test('*word keeps the profile language filter on FTS candidates', () => {
  process.env.SEARCH_LIKE_SCAN_BUDGET_MS = '0';
  const result = searchCatalog({ query: '*Quorvexian', field: 'books', page: 1, pageSize: 24, langs: ['ru'] });
  assert.deepEqual(ids(result), ['likefb-ru']);
  assert.equal(result.total, 1);
});

test('mid-word contains comes from the rowid scan within the budget', () => {
  process.env.SEARCH_LIKE_SCAN_BUDGET_MS = '5000';
  const result = searchCatalog({ query: '*quorvexian', field: 'books', page: 1, pageSize: 24 });
  assert.deepEqual(ids(result), ['likefb-en', 'likefb-mid', 'likefb-ru']);
  assert.equal(result.partial, undefined, 'full scan inside the budget is not partial');
});

test('an exhausted scan budget returns quickly instead of scanning every book', () => {
  process.env.SEARCH_LIKE_SCAN_BUDGET_MS = '0';
  const result = searchCatalog({ query: '*orvexianis', field: 'books', page: 1, pageSize: 24 });
  assert.equal(result.total, 0);
  assert.equal(result.partial, true);
});

test('genre facets for *query use the same bounded candidates', () => {
  process.env.SEARCH_LIKE_SCAN_BUDGET_MS = '0';
  assert.doesNotThrow(() => listSearchGenres({ query: '*Quorvexian' }));
});
