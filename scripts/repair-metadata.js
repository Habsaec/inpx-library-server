import '../src/load-env.js';
import iconv from 'iconv-lite';
import { db, initDb } from '../src/db.js';

initDb();

function repairMojibake(value) {
  const input = String(value || '');
  if (!/[ÐÑРС]/.test(input)) {
    return input;
  }

  const repaired = iconv.encode(input, 'win1251').toString('utf8');
  return repaired.includes('�') ? input : repaired;
}

function normalize(value) {
  return repairMojibake(String(value || '').replace(/\x00/g, '').trim());
}

function splitFacetValues(value) {
  return normalize(value)
    .split(/[:,;]/)
    .map((item) => normalize(item))
    .filter(Boolean);
}

function splitAuthorValues(value) {
  return normalize(value)
    .split(':')
    .map((item) => normalize(item))
    .filter(Boolean);
}

const books = db.prepare('SELECT id, title, authors, genres, series FROM books').all();
const updateBook = db.prepare('UPDATE books SET title = ?, authors = ?, genres = ?, series = ? WHERE id = ?');

const tx = db.transaction(() => {
  for (const book of books) {
    updateBook.run(
      normalize(book.title),
      normalize(book.authors),
      normalize(book.genres),
      normalize(book.series),
      book.id
    );
  }

  db.exec('DELETE FROM book_authors');
  db.exec('DELETE FROM book_series');
  db.exec('DELETE FROM book_genres');
  db.exec('DELETE FROM authors WHERE id NOT IN (SELECT author_id FROM favorite_authors)');
  db.exec('DELETE FROM series_catalog WHERE id NOT IN (SELECT series_id FROM favorite_series)');
  db.exec('DELETE FROM genres_catalog');

  const insertAuthor = db.prepare('INSERT OR IGNORE INTO authors(name) VALUES(?)');
  const insertSeries = db.prepare('INSERT OR IGNORE INTO series_catalog(name) VALUES(?)');
  const insertGenre = db.prepare('INSERT OR IGNORE INTO genres_catalog(name) VALUES(?)');
  const getAuthorId = db.prepare('SELECT id FROM authors WHERE name = ?');
  const getSeriesId = db.prepare('SELECT id FROM series_catalog WHERE name = ?');
  const getGenreId = db.prepare('SELECT id FROM genres_catalog WHERE name = ?');
  const linkAuthor = db.prepare('INSERT OR IGNORE INTO book_authors(book_id, author_id) VALUES(?, ?)');
  const linkSeries = db.prepare('INSERT OR REPLACE INTO book_series(book_id, series_id) VALUES(?, ?)');
  const linkGenre = db.prepare('INSERT OR IGNORE INTO book_genres(book_id, genre_id) VALUES(?, ?)');

  const normalizedBooks = db.prepare('SELECT id, authors, genres, series FROM books').all();
  for (const book of normalizedBooks) {
    for (const authorName of splitAuthorValues(book.authors)) {
      insertAuthor.run(authorName);
      const authorId = getAuthorId.get(authorName)?.id;
      if (authorId) {
        linkAuthor.run(book.id, authorId);
      }
    }

    if (book.series) {
      const seriesName = normalize(book.series);
      insertSeries.run(seriesName);
      const seriesId = getSeriesId.get(seriesName)?.id;
      if (seriesId) {
        linkSeries.run(book.id, seriesId);
      }
    }

    for (const genreName of splitFacetValues(book.genres)) {
      insertGenre.run(genreName);
      const genreId = getGenreId.get(genreName)?.id;
      if (genreId) {
        linkGenre.run(book.id, genreId);
      }
    }
  }
});

tx();

const sample = db.prepare('SELECT id, title, authors, series FROM books LIMIT 5').all();
console.log(JSON.stringify({ repairedBooks: books.length, sample }, null, 2));
