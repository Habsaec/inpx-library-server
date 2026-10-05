import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, rebuildBooksFtsFromContentSync, setMeta } from '../src/db.js';
import {
  getSuggestions,
  listAuthors,
  listSeries,
  searchBooks,
  searchCatalog,
  searchOverview,
  findDidYouMeanSuggestions,
  listSearchGenres
} from '../src/inpx.js';
import { clearWarmSearchBooksPages, takeWarmSearchBooksPage } from '../src/search-enhance.js';

const AUTHOR_NAME = 'булычев,кир';
const SERIES_NAME = 'алиса';
const BOOK_ID = 'search-quality-b1';
const PREFIX_BOOK_ID = 'search-quality-prefix';

function seed() {
  db.exec('DELETE FROM book_series');
  db.exec('DELETE FROM book_authors');
  db.exec(`DELETE FROM books WHERE id IN ('${BOOK_ID}', '${PREFIX_BOOK_ID}')`);
  db.exec(`DELETE FROM authors WHERE name = '${AUTHOR_NAME}'`);
  db.exec(`DELETE FROM series_catalog WHERE name = '${SERIES_NAME}'`);
  db.exec('DELETE FROM sources WHERE id = 1');

  db.prepare(`
    INSERT INTO sources (id, name, type, path, enabled)
    VALUES (1, 'test-src', 'folder', '/', 1)
  `).run();

  db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, 'Кир Булычев', 'булычев кир', 'булычев кир', 1)
  `).run(AUTHOR_NAME);

  db.prepare(`
    INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count)
    VALUES (?, 'Алиса', 'алиса', 'алиса', 1)
  `).run(SERIES_NAME);

  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, 'Девочка, с которой ничего не случится', 'Кир Булычев', '', 'Алиса', '1',
      'девочка с которой ничего не случится', 'булычев кир',
      'алиса', 1, 'девочка с которой ничего не случится', 'булычев кир', 'алиса',
      '', '', ?, 'a.zip', 1, ?, 0,
      'fb2', '', 'ru', '', 0, 1
    )
  `).run(BOOK_ID, `${BOOK_ID}.fb2`, BOOK_ID);

  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, 'Префикстestкнига', 'Кир Булычев', '', '', '',
      'префикстestкнига', 'булычев кир',
      '', 0, 'префикстestкнига', 'булычев кир', '',
      '', '', ?, 'b.zip', 1, ?, 0,
      'fb2', '', 'ru', '', 0, 1
    )
  `).run(PREFIX_BOOK_ID, `${PREFIX_BOOK_ID}.fb2`, PREFIX_BOOK_ID);

  const authorId = db.prepare('SELECT id FROM authors WHERE name = ?').get(AUTHOR_NAME).id;
  const seriesId = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get(SERIES_NAME).id;
  db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)').run(BOOK_ID, authorId);
  db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)').run(PREFIX_BOOK_ID, authorId);
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run(BOOK_ID, seriesId, '1');

  rebuildBooksFtsFromContentSync();
  setMeta('books_fts_dirty', '0');
}

before(() => {
  initDb();
  seed();
});

test('searchBooks finds author + title via FTS hot path', () => {
  const result = searchBooks({ query: 'Булычев девочка', page: 1, pageSize: 24, field: 'all' });
  const ids = result.items.map((row) => row.id);
  assert.ok(ids.includes(BOOK_ID), `expected ${BOOK_ID} in ${JSON.stringify(ids)}`);
});

test('listSeries finds series and author+series; surname-only is title-match only', () => {
  const byName = listSeries({ query: 'Алиса', page: 1, pageSize: 24, sort: 'name' });
  assert.ok(byName.items.some((row) => row.name === SERIES_NAME));

  const mixed = listSeries({ query: 'Булычев Алиса', page: 1, pageSize: 24, sort: 'name' });
  assert.ok(mixed.items.some((row) => row.name === SERIES_NAME));

  const surnameOnly = listSeries({ query: 'Булычев', page: 1, pageSize: 24, sort: 'name' });
  assert.ok(
    !surnameOnly.items.some((row) => row.name === SERIES_NAME),
    'surname-only must not list author series by linkage'
  );
});

test('listAuthors finds initials query', () => {
  db.prepare(`
    INSERT OR REPLACE INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES ('роулинг,джоан,к.', 'Роулинг, Дж. К.', 'роулинг джоан к', 'роулинг джоан к', 2)
  `).run();
  const result = listAuthors({ query: 'Дж. К. Роулинг', page: 1, pageSize: 24, sort: 'count' });
  assert.ok(result.items.some((row) => row.name === 'роулинг,джоан,к.'));
});

test('default prefix does not require mid-string match', () => {
  const mid = searchBooks({ query: 'фикст', page: 1, pageSize: 24, field: 'title' });
  assert.ok(!mid.items.some((row) => row.id === PREFIX_BOOK_ID), 'mid-string must not match by default');

  const prefix = searchBooks({ query: 'префикс', page: 1, pageSize: 24, field: 'title' });
  assert.ok(prefix.items.some((row) => row.id === PREFIX_BOOK_ID), 'prefix must match');

  const contains = searchBooks({ query: '*фикст', page: 1, pageSize: 24, field: 'title' });
  assert.ok(contains.items.some((row) => row.id === PREFIX_BOOK_ID), '* operator enables contains');
});

test('empty catalog result includes recovery hints', () => {
  const emptyAuthors = searchCatalog({ query: 'Алиса', field: 'authors', page: 1, pageSize: 24 });
  assert.equal(emptyAuthors.total, 0);
  assert.ok(emptyAuthors.searchHints);
  const seriesAlt = emptyAuthors.searchHints.alternateModes.find((m) => m.field === 'series');
  assert.ok(seriesAlt && seriesAlt.total > 0, 'authors-empty should hint series');
});

test('did-you-mean suggests close author token', () => {
  const hints = findDidYouMeanSuggestions('булычов', 3);
  assert.ok(hints.some((h) => h.type === 'author' && /булычев/i.test(h.label)), `got ${JSON.stringify(hints)}`);
});

test('getSuggestions authors match listAuthors', () => {
  const listed = listAuthors({ query: 'Булычев', page: 1, pageSize: 5, sort: 'count' });
  const suggested = getSuggestions('Булычев', 5, 'authors');
  const listedNames = listed.items.map((row) => row.name).sort();
  const suggestedNames = suggested.authors.map((row) => row.name).sort();
  assert.deepEqual(suggestedNames, listedNames);
  assert.equal(suggested.books.length, 0);
  assert.equal(suggested.series.length, 0);
});

test('getSuggestions books scope returns FTS books', () => {
  const suggested = getSuggestions('девочка', 5, 'books');
  assert.ok(suggested.books.some((row) => row.id === BOOK_ID));
  const shortPrefix = getSuggestions('де', 5, 'books');
  assert.ok(shortPrefix.books.some((row) => row.id === BOOK_ID));
});

test('searchOverview returns totals for all modes', () => {
  const overview = searchOverview({ query: 'Булычев' });
  assert.equal(overview.query, 'Булычев');
  assert.ok(overview.authors.total >= 1);
  assert.equal(typeof overview.books.total, 'number');
  assert.equal(typeof overview.series.total, 'number');
  assert.equal(overview.routeField, null);
});

test('searchOverview reuses precomputed books total', () => {
  const overview = searchOverview({
    query: 'Булычев',
    booksTotal: 42,
    booksCapped: false
  });
  assert.equal(overview.books.total, 42);
  assert.equal(overview.books.capped, false);
  assert.equal(overview.routeField, null);
});

test('searchOverview warms the first books page only when it had to count books itself', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const opts = { sort: 'title', page: 1, pageSize: 24 };

  /* Прогревы предыдущих тестов ещё могут стоять в очереди setImmediate. */
  await tick();
  await tick();
  clearWarmSearchBooksPages();
  searchOverview({ query: 'Булычев', booksTotal: 42, booksCapped: false });
  await tick();
  await tick();
  assert.equal(takeWarmSearchBooksPage('Булычев', opts), null, '/catalog already has the page; no second search');

  searchOverview({ query: 'Булычев' });
  await tick();
  await tick();
  assert.ok(takeWarmSearchBooksPage('Булычев', opts), '/api/search still warms the page for the next catalog request');
});

test('listSearchGenres returns scoped genres for a book query', () => {
  const empty = listSearchGenres({ query: '' });
  assert.equal(empty.scoped, false);
  assert.equal(empty.items.length, 0);

  const scoped = listSearchGenres({ query: 'девочка' });
  assert.equal(scoped.scoped, true);
  assert.ok(Array.isArray(scoped.items));
  const labels = scoped.items.map((g) => String(g.displayName || g.name || ''));
  const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'ru', { sensitivity: 'base' }));
  assert.deepEqual(labels, sorted);
});
