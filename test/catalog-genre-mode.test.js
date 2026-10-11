import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db } from '../src/db.js';
import { parseGenreMode, searchCatalog } from '../src/inpx.js';

const SOURCE_ID = 9201;
const IDS = { sf: 'genre-mode-sf-only', both: 'genre-mode-both', det: 'genre-mode-det-only' };

before(() => {
  initDb();
  db.exec(`DELETE FROM books WHERE id IN ('${IDS.sf}', '${IDS.both}', '${IDS.det}')`);
  db.exec(`DELETE FROM sources WHERE id = ${SOURCE_ID}`);
  db.exec(`DELETE FROM book_genres WHERE book_id IN ('${IDS.sf}', '${IDS.both}', '${IDS.det}')`);
  db.prepare(`
    INSERT INTO sources (id, name, type, path, enabled)
    VALUES (${SOURCE_ID}, 'genre-mode-test', 'folder', '/', 1)
  `).run();

  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id, imported_at
    ) VALUES (
      ?, ?, 'Test Author', ?, '', '', ?, 'test author',
      '', 0, ?, 'test author', '',
      '', '', ?, '', 1, ?, 0,
      'fb2', '', 'ru', '', 0, ${SOURCE_ID}, ?
    )
  `);
  const genreId = db.prepare('INSERT INTO genres_catalog (name) VALUES (?)');
  const link = db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)');
  const genreIds = new Map();
  const gid = (name) => {
    if (!genreIds.has(name)) genreIds.set(name, Number(genreId.run(name).lastInsertRowid));
    return genreIds.get(name);
  };

  const addBook = (id, title, genres) => {
    insert.run(id, title, genres, title.toLowerCase(), title.toLowerCase(), `${id}.fb2`, id, 0);
    for (const g of genres.split(',')) link.run(id, gid(g));
  };
  addBook(IDS.sf, 'Alpha SF Book', 'sf');
  addBook(IDS.both, 'Beta Both Book', 'sf,det');
  addBook(IDS.det, 'Gamma Det Book', 'det');
});

test('parseGenreMode accepts only "and", defaults to "or"', () => {
  assert.equal(parseGenreMode('and'), 'and');
  assert.equal(parseGenreMode('AND'), 'and');
  assert.equal(parseGenreMode(' and '), 'and');
  assert.equal(parseGenreMode('or'), 'or');
  assert.equal(parseGenreMode(''), 'or');
  assert.equal(parseGenreMode(undefined), 'or');
  assert.equal(parseGenreMode(null), 'or');
  assert.equal(parseGenreMode('whatever'), 'or');
});

test('default genre filter matches any selected genre (OR)', () => {
  const result = searchCatalog({ query: '', field: 'books', genre: 'sf,det', sort: 'title' });
  const ids = result.items.map((b) => b.id).sort();
  assert.equal(result.total, 3);
  assert.deepEqual(ids, [IDS.det, IDS.both, IDS.sf].sort());
});

test('genreMode=and matches only books having every selected genre', () => {
  const result = searchCatalog({ query: '', field: 'books', genre: 'sf,det', genreMode: 'and', sort: 'title' });
  const ids = result.items.map((b) => b.id);
  assert.equal(result.total, 1);
  assert.deepEqual(ids, [IDS.both]);
});

test('genreMode=and with a single genre behaves like OR', () => {
  const result = searchCatalog({ query: '', field: 'books', genre: 'sf', genreMode: 'and', sort: 'title' });
  const ids = result.items.map((b) => b.id).sort();
  assert.equal(result.total, 2);
  assert.deepEqual(ids, [IDS.both, IDS.sf].sort());
});

test('genreMode=and without genres applies no genre filter', () => {
  const result = searchCatalog({ query: '', field: 'books', genre: '', genreMode: 'and', sort: 'title' });
  assert.ok(result.total >= 3);
});
