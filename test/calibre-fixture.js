/**
 * Маленькая Calibre-библиотека для тестов: metadata.db с подмножеством настоящей схемы Calibre
 * (те же таблицы и столбцы, что читает src/calibre-indexer.js) + файлы книг и cover.jpg.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE books ( id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Unknown' COLLATE NOCASE, sort TEXT COLLATE NOCASE,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP, pubdate TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    series_index REAL NOT NULL DEFAULT 1.0, author_sort TEXT COLLATE NOCASE,
    isbn TEXT DEFAULT "" COLLATE NOCASE, lccn TEXT DEFAULT "" COLLATE NOCASE,
    path TEXT NOT NULL DEFAULT "", flags INTEGER NOT NULL DEFAULT 1, uuid TEXT,
    has_cover BOOL DEFAULT 0, last_modified TIMESTAMP NOT NULL DEFAULT "2000-01-01 00:00:00+00:00");
  CREATE TABLE authors ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT COLLATE NOCASE,
    link TEXT NOT NULL DEFAULT "", UNIQUE(name));
  CREATE TABLE books_authors_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, author INTEGER NOT NULL, UNIQUE(book, author));
  CREATE TABLE series ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT COLLATE NOCASE, link TEXT NOT NULL DEFAULT "", UNIQUE (name));
  CREATE TABLE books_series_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, series INTEGER NOT NULL, UNIQUE(book));
  CREATE TABLE tags ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, link TEXT NOT NULL DEFAULT "", UNIQUE (name));
  CREATE TABLE books_tags_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, tag INTEGER NOT NULL, UNIQUE(book, tag));
  CREATE TABLE ratings ( id INTEGER PRIMARY KEY, rating INTEGER CHECK(rating > -1 AND rating < 11), link TEXT NOT NULL DEFAULT "", UNIQUE (rating));
  CREATE TABLE books_ratings_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, rating INTEGER NOT NULL, UNIQUE(book, rating));
  CREATE TABLE publishers ( id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE, sort TEXT COLLATE NOCASE, link TEXT NOT NULL DEFAULT "", UNIQUE(name));
  CREATE TABLE books_publishers_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, publisher INTEGER NOT NULL, UNIQUE(book));
  CREATE TABLE languages ( id INTEGER PRIMARY KEY, lang_code TEXT NOT NULL COLLATE NOCASE, link TEXT NOT NULL DEFAULT "", UNIQUE(lang_code));
  CREATE TABLE books_languages_link ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, lang_code INTEGER NOT NULL,
    item_order INTEGER NOT NULL DEFAULT 0, UNIQUE(book, lang_code));
  CREATE TABLE comments ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, text TEXT NOT NULL COLLATE NOCASE, UNIQUE(book));
  CREATE TABLE identifiers ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, type TEXT NOT NULL DEFAULT "isbn" COLLATE NOCASE,
    val TEXT NOT NULL COLLATE NOCASE, UNIQUE(book, type));
  CREATE TABLE data ( id INTEGER PRIMARY KEY, book INTEGER NOT NULL, format TEXT NOT NULL COLLATE NOCASE,
    uncompressed_size INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(book, format));
  CREATE VIEW meta AS SELECT id, title, concat(title) AS broken FROM books;
`;

/** 1×1 JPEG. */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

const safe = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_');
let clock = Date.parse('2024-01-01T00:00:00Z');
const stamp = () => {
  clock += 60_000;
  return new Date(clock).toISOString().replace('T', ' ').replace('Z', '+00:00');
};

export function createCalibreLibrary(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'metadata.db');
  const cal = new Database(file);
  cal.exec(SCHEMA);
  const idOf = (table, column, value, extra = {}) => {
    const row = cal.prepare(`SELECT id FROM ${table} WHERE ${column} = ?`).get(value);
    if (row) return row.id;
    const cols = [column, ...Object.keys(extra)];
    return cal.prepare(`INSERT INTO ${table}(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')})`)
      .run(value, ...Object.values(extra)).lastInsertRowid;
  };

  let mtimeBump = 0;
  /** Отпечаток metadata.db — mtime + size: в тестах меняем mtime явно (одна миллисекунда у двух записей). */
  const bump = () => {
    mtimeBump += 10;
    const t = new Date(Date.now() + mtimeBump * 1000);
    fs.utimesSync(file, t, t);
  };

  function writeFiles(bookId) {
    const book = cal.prepare('SELECT path, title FROM books WHERE id = ?').get(bookId);
    fs.mkdirSync(path.join(dir, book.path), { recursive: true });
    return book;
  }

  function addBook({
    title, authors = [['Unknown', 'Unknown']], series = '', seriesIndex = 1, tags = [], rating = 0, publisher = '',
    lang = '', comments = '', isbn = '', pubdate = '0101-01-01 00:00:00+00:00', formats = [{ format: 'EPUB' }], cover = null
  }) {
    const uuid = crypto.randomUUID();
    const firstAuthor = authors[0][0];
    const id = cal.prepare(`
      INSERT INTO books(title, sort, timestamp, pubdate, series_index, author_sort, path, uuid, has_cover, last_modified)
      VALUES(?, ?, ?, ?, ?, ?, '', ?, ?, ?)
    `).run(title, title, stamp(), pubdate, seriesIndex, authors[0][1], uuid, cover ? 1 : 0, stamp()).lastInsertRowid;
    const bookPath = `${safe(firstAuthor)}/${safe(title)} (${id})`;
    cal.prepare('UPDATE books SET path = ? WHERE id = ?').run(bookPath, id);
    authors.forEach(([name, sort]) => {
      cal.prepare('INSERT INTO books_authors_link(book, author) VALUES(?, ?)').run(id, idOf('authors', 'name', name, { sort }));
    });
    if (series) cal.prepare('INSERT INTO books_series_link(book, series) VALUES(?, ?)').run(id, idOf('series', 'name', series));
    for (const tag of tags) cal.prepare('INSERT INTO books_tags_link(book, tag) VALUES(?, ?)').run(id, idOf('tags', 'name', tag));
    if (rating) cal.prepare('INSERT INTO books_ratings_link(book, rating) VALUES(?, ?)').run(id, idOf('ratings', 'rating', rating));
    if (publisher) cal.prepare('INSERT INTO books_publishers_link(book, publisher) VALUES(?, ?)').run(id, idOf('publishers', 'name', publisher));
    if (lang) cal.prepare('INSERT INTO books_languages_link(book, lang_code, item_order) VALUES(?, ?, 0)').run(id, idOf('languages', 'lang_code', lang));
    if (comments) cal.prepare('INSERT INTO comments(book, text) VALUES(?, ?)').run(id, comments);
    if (isbn) cal.prepare("INSERT INTO identifiers(book, type, val) VALUES(?, 'isbn', ?)").run(id, isbn);
    writeFiles(id);
    const name = `${safe(title)} - ${safe(firstAuthor)}`;
    for (const f of formats) {
      const content = f.content ?? Buffer.from(`${f.format} of ${title}`);
      fs.writeFileSync(path.join(dir, bookPath, `${name}.${f.format.toLowerCase()}`), content);
      cal.prepare('INSERT INTO data(book, format, uncompressed_size, name) VALUES(?, ?, ?, ?)').run(id, f.format, content.length, name);
    }
    if (cover) fs.writeFileSync(path.join(dir, bookPath, 'cover.jpg'), cover);
    bump();
    return { id: Number(id), uuid, path: bookPath, name };
  }

  /** Как правка названия в Calibre: новое название, папка и файлы переименованы, last_modified обновлён. */
  function renameBook(id, newTitle) {
    const book = cal.prepare('SELECT path FROM books WHERE id = ?').get(id);
    const author = book.path.split('/')[0];
    const newPath = `${author}/${safe(newTitle)} (${id})`;
    const newName = `${safe(newTitle)} - ${author}`;
    fs.renameSync(path.join(dir, book.path), path.join(dir, newPath));
    for (const f of cal.prepare('SELECT format, name FROM data WHERE book = ?').all(id)) {
      fs.renameSync(path.join(dir, newPath, `${f.name}.${f.format.toLowerCase()}`), path.join(dir, newPath, `${newName}.${f.format.toLowerCase()}`));
    }
    cal.prepare('UPDATE data SET name = ? WHERE book = ?').run(newName, id);
    cal.prepare('UPDATE books SET title = ?, sort = ?, path = ?, last_modified = ? WHERE id = ?').run(newTitle, newTitle, newPath, stamp(), id);
    bump();
  }

  function removeBook(id) {
    const book = cal.prepare('SELECT path FROM books WHERE id = ?').get(id);
    for (const t of ['books_authors_link', 'books_series_link', 'books_tags_link', 'books_ratings_link',
      'books_publishers_link', 'books_languages_link', 'comments', 'identifiers', 'data']) {
      cal.prepare(`DELETE FROM ${t} WHERE book = ?`).run(id);
    }
    cal.prepare('DELETE FROM books WHERE id = ?').run(id);
    fs.rmSync(path.join(dir, book.path), { recursive: true, force: true });
    bump();
  }

  return { dir, file, db: cal, addBook, renameBook, removeBook, bump, close: () => cal.close() };
}
