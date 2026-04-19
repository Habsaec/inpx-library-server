import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { POPULAR_VIEW_ITEMS_SQL } from '../src/library-view-queries.js';

test('POPULAR_VIEW_ITEMS_SQL: prepare и выборка без ошибки SQLite (UNION + ORDER BY)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE reading_history (book_id INTEGER NOT NULL, username TEXT NOT NULL);
    CREATE TABLE bookmarks (book_id INTEGER NOT NULL, username TEXT NOT NULL);
    CREATE TABLE active_books (
      id INTEGER PRIMARY KEY,
      title TEXT,
      authors TEXT,
      genres TEXT,
      series TEXT,
      series_no TEXT,
      ext TEXT,
      lang TEXT,
      archive_name TEXT,
      date TEXT,
      imported_at TEXT,
      title_sort TEXT
    );
    INSERT INTO reading_history (book_id, username) VALUES (1, 'alice'), (1, 'bob');
    INSERT INTO active_books (id, title, authors, genres, series, series_no, ext, lang, archive_name, date, imported_at, title_sort)
      VALUES (1, 'Book', 'Author', '', '', '', 'fb2', 'ru', 'a.7z', '', '2024-01-01', 'book');
  `);

  const stmt = db.prepare(POPULAR_VIEW_ITEMS_SQL);
  const rows = stmt.all(10, 0);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 1);
  assert.strictEqual(rows[0].title, 'Book');
  db.close();
});
