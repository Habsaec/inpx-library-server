import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db } from '../src/db.js';
import { getAuthorBooksGrouped } from '../src/inpx.js';

function insertBook(id, title, seriesLabel, seriesSort) {
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, 'Test Author', '', ?, '', ?, 'test author',
      ?, 1, ?, 'test author', ?, '', '', ?, 'a.zip', 1, ?, 0,
      'fb2', '', 'ru', '', 0, 1
    )
  `).run(id, title, seriesLabel, title.toLowerCase(), seriesSort, title.toLowerCase(), seriesSort, `${id}.fb2`, id);
}

test('getAuthorBooksGrouped counts all books when author rows expand via multi-series junction', () => {
  initDb();
  db.exec('DELETE FROM book_series');
  db.exec('DELETE FROM book_authors');
  db.exec('DELETE FROM books');
  db.exec('DELETE FROM authors');
  db.exec('DELETE FROM series_catalog');
  db.exec('DELETE FROM sources WHERE id = 1');

  db.prepare(`
    INSERT INTO sources (id, name, type, path, enabled)
    VALUES (1, 'test-src', 'folder', '/', 1)
  `).run();
  db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES ('test,author', 'Test Author', 'test author', 'test author', 3)
  `).run();
  db.prepare(`
    INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count)
    VALUES ('series a', 'Series A', 'series a', 'series a', 2),
           ('series b', 'Series B', 'series b', 'series b', 2)
  `).run();

  const authorId = db.prepare('SELECT id FROM authors WHERE name = ?').get('test,author').id;
  const seriesA = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get('series a').id;
  const seriesB = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get('series b').id;

  insertBook('b1', 'Book One', 'Series A', 'series a');
  insertBook('b2', 'Book Two', 'Series A', 'series a');
  insertBook('b3', 'Book Three', 'Series B', 'series b');

  const linkAuthor = db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)');
  const linkSeries = db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)');
  for (const bookId of ['b1', 'b2', 'b3']) linkAuthor.run(bookId, authorId);
  linkSeries.run('b1', seriesA, '1');
  linkSeries.run('b1', seriesB, '1');
  linkSeries.run('b2', seriesA, '2');
  linkSeries.run('b3', seriesB, '1');

  const grouped = getAuthorBooksGrouped('test,author', 'title', '');
  const seriesAEntry = grouped.series.find((s) => s.name === 'series a');
  const seriesBEntry = grouped.series.find((s) => s.name === 'series b');
  assert.equal(seriesAEntry?.bookCount, 2, 'Series A should list both linked books');
  assert.equal(seriesBEntry?.bookCount, 2, 'Series B should list both linked books');
  assert.ok(Array.isArray(seriesAEntry?.books), 'Series entries include books for list view');
  assert.equal(seriesAEntry.books.length, 2);
  assert.ok(seriesAEntry.books.some((b) => b.id === 'b1'));
  assert.ok(seriesAEntry.books.some((b) => b.id === 'b2'));
});

test('author series list sorts by name, book count, and newest book', () => {
  initDb();
  db.exec('DELETE FROM book_series');
  db.exec('DELETE FROM book_authors');
  db.exec('DELETE FROM books');
  db.exec('DELETE FROM authors');
  db.exec('DELETE FROM series_catalog');
  db.exec('DELETE FROM sources WHERE id = 1');

  db.prepare(`
    INSERT INTO sources (id, name, type, path, enabled)
    VALUES (1, 'test-src', 'folder', '/', 1)
  `).run();
  db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES ('sort,author', 'Sort Author', 'sort author', 'sort author', 6)
  `).run();
  db.prepare(`
    INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count)
    VALUES ('alpha', 'Альфа', 'alpha', 'alpha', 1),
           ('beta', 'Бета', 'beta', 'beta', 3),
           ('gamma', 'Гамма', 'gamma', 'gamma', 2)
  `).run();

  const authorId = db.prepare('SELECT id FROM authors WHERE name = ?').get('sort,author').id;
  const seriesId = (name) => db.prepare('SELECT id FROM series_catalog WHERE name = ?').get(name).id;
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, 'Sort Author', '', ?, ?, ?, 'sort author',
      ?, ?, ?, 'sort author', ?, '', '', ?, 'a.zip', 1, ?, 0,
      'fb2', ?, 'ru', '', 0, 1
    )
  `);
  const linkAuthor = db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)');
  const linkSeries = db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)');
  const add = (id, title, seriesName, seriesNo, date) => {
    insert.run(
      id, title, seriesName, seriesNo, title.toLowerCase(), seriesName, Number(seriesNo) || 0,
      title.toLowerCase(), seriesName, `${id}.fb2`, id, date
    );
    linkAuthor.run(id, authorId);
    linkSeries.run(id, seriesId(seriesName), seriesNo);
  };
  add('a1', 'Одна', 'alpha', '1', '2020-01-01');
  add('b2', 'Вторая', 'beta', '2', '2010-01-01');
  add('b1', 'Первая', 'beta', '1', '2010-06-01');
  add('b3', 'Третья', 'beta', '3', '2011-01-01');
  add('g1', 'Новая', 'gamma', '1', '2024-05-01');
  add('g2', 'Старая', 'gamma', '2', '2001-01-01');

  const names = (sort, order = '') =>
    getAuthorBooksGrouped('sort,author', sort, order).series.map((s) => s.name);

  assert.deepEqual(names('series'), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(names('title'), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(names('count'), ['beta', 'gamma', 'alpha']);
  assert.deepEqual(names('count', 'asc'), ['alpha', 'gamma', 'beta']);
  assert.deepEqual(names('recent'), ['gamma', 'alpha', 'beta']);

  const beta = getAuthorBooksGrouped('sort,author', 'count').series.find((s) => s.name === 'beta');
  assert.deepEqual(beta.books.map((b) => b.id), ['b1', 'b2', 'b3']);
});
