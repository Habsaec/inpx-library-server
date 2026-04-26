/**
 * Regression: OPDS drilldown from /opds/author into a specific series.
 *
 * The author detail feed groups its series entries on raw `b.series` text. The series
 * link must round-trip through encodeURIComponent → URL → SQL (`b.series = ?`) and
 * still match the same rows. Earlier the click handler called getSeriesBooksOpds,
 * which JOINs series_catalog.name via resolveSeriesCatalogName — when the raw text
 * didn't match the canonical catalog name (whitespace, ё/е, casing, ambiguity), the
 * OPDS client showed "каталог пуст". The fix introduced getAuthorSeriesBooksOpds
 * that matches author + raw `b.series` directly.
 *
 * This test replicates the SQL/data shape on an in-memory DB so the bug can never
 * silently regress, even without a real INPX index.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE active_books (
      id INTEGER PRIMARY KEY,
      title TEXT, authors TEXT, series TEXT, series_no TEXT,
      ext TEXT, lang TEXT, genres TEXT,
      archive_name TEXT, file_name TEXT, source_id INTEGER
    );
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE book_authors (book_id INTEGER, author_id INTEGER);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, flibusta_sidecar INTEGER);
    CREATE TABLE book_details_cache (book_id INTEGER PRIMARY KEY, annotation TEXT);

    INSERT INTO authors (id, name) VALUES (1, 'Толкин Дж. Р. Р.');
    INSERT INTO active_books (id, title, authors, series, series_no, ext, lang) VALUES
      (1, 'Хоббит',          'Толкин Дж. Р. Р.', 'Властелин Колец', '0', 'fb2', 'ru'),
      (2, 'Братство Кольца',  'Толкин Дж. Р. Р.', 'Властелин Колец', '1', 'fb2', 'ru'),
      (3, 'Сильмариллион',    'Толкин Дж. Р. Р.', '',                '',  'fb2', 'ru');
    INSERT INTO book_authors VALUES (1, 1), (2, 1), (3, 1);
  `);
  return db;
}

// Mirrors the SQL of getAuthorBooksOpds (no genre branch).
function authorBooksSql(db, authorName) {
  return db.prepare(`
    SELECT b.id, b.title, b.series
    FROM active_books b
    JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id AND a.name = ?
    ORDER BY b.series, CAST(b.series_no AS INTEGER), b.title
  `).all(authorName);
}

// Mirrors the SQL of getAuthorSeriesBooksOpds (no genre branch).
function authorSeriesBooksSql(db, authorName, seriesText) {
  return db.prepare(`
    SELECT b.id, b.title, b.series
    FROM active_books b
    JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id AND a.name = ?
    WHERE b.series = ?
    GROUP BY b.id
    ORDER BY CAST(b.series_no AS INTEGER), b.title
  `).all(authorName, seriesText);
}

test('OPDS author → series drilldown returns the same books that were grouped on b.series', () => {
  const db = setupDb();
  const authorName = 'Толкин Дж. Р. Р.';

  const authorBooks = authorBooksSql(db, authorName);
  assert.strictEqual(authorBooks.length, 3, 'author should have all three books');

  // Build the seriesMap exactly like the route does.
  const seriesMap = new Map();
  for (const book of authorBooks) {
    if (book.series) seriesMap.set(book.series, (seriesMap.get(book.series) || 0) + 1);
  }
  assert.strictEqual(seriesMap.size, 1);
  const [seriesText, count] = [...seriesMap.entries()][0];
  assert.strictEqual(seriesText, 'Властелин Колец');
  assert.strictEqual(count, 2);

  // Round-trip the series link through URL encoding (the OPDS client does this).
  const url = `/opds/author?author=${encodeURIComponent(`=${authorName}`)}&series=${encodeURIComponent(seriesText)}&genre=`;
  const decoded = new URL(`http://x${url}`);
  const authorParam = decoded.searchParams.get('author');
  const seriesParam = decoded.searchParams.get('series');

  assert.ok(authorParam.startsWith('='), 'author must keep "=" prefix after decoding');
  const drillName = authorParam.slice(1);
  assert.strictEqual(drillName, authorName);
  assert.strictEqual(seriesParam, seriesText);

  const drillBooks = authorSeriesBooksSql(db, drillName, seriesParam);
  assert.strictEqual(drillBooks.length, 2, 'drilldown must not return empty (was the "каталог пуст" bug)');
  assert.deepStrictEqual(drillBooks.map((b) => b.id), [1, 2]);
  db.close();
});

test('OPDS drilldown matches even when series text contains whitespace and Cyrillic ё', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE active_books (id INTEGER PRIMARY KEY, title TEXT, series TEXT, series_no TEXT);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE book_authors (book_id INTEGER, author_id INTEGER);
    INSERT INTO authors (id, name) VALUES (1, 'Иванов И.');
    INSERT INTO active_books (id, title, series, series_no) VALUES
      (10, 'Книга 1', '  Ёжикина серия  ', '1'),
      (11, 'Книга 2', '  Ёжикина серия  ', '2');
    INSERT INTO book_authors VALUES (10, 1), (11, 1);
  `);
  const seriesText = '  Ёжикина серия  ';
  const url = `/x?series=${encodeURIComponent(seriesText)}`;
  const decoded = new URL(`http://x${url}`).searchParams.get('series');
  assert.strictEqual(decoded, seriesText, 'leading/trailing spaces and ё must round-trip');

  const rows = db.prepare(`
    SELECT b.id FROM active_books b
    JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id AND a.name = ?
    WHERE b.series = ?
  `).all('Иванов И.', decoded);
  assert.strictEqual(rows.length, 2);
  db.close();
});
