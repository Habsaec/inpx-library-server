import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDb,
  db,
  rebuildBooksFtsFromContent,
  rebuildBooksFtsFromContentSync,
  ensureBooksFtsTriggers,
  getBooksFtsStatus,
  invalidateBooksFtsHealthCache
} from '../src/db.js';

const matchCount = (term) =>
  db.prepare('SELECT COUNT(*) AS c FROM books_fts WHERE books_fts MATCH ?').get(term).c;

const insertBook = (id, titleSearch, authorsSearch) => {
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (?, ?, '', '', '', '', ?, '', '', 0, ?, ?, '', '', '', 'x.fb2', 'a.zip', 1, ?, 0,
      'fb2', '', 'ru', '', 0, NULL)
  `).run(id, titleSearch, titleSearch, titleSearch, authorsSearch, id);
};

before(() => {
  initDb();
  ensureBooksFtsTriggers();
  db.prepare("DELETE FROM books WHERE id LIKE 'ftstok-%'").run();
});

test('trigger-inserted book is searchable via MATCH', () => {
  insertBook('ftstok-1', 'властелин колец', 'толкин джон');
  assert.equal(matchCount('толкин'), 1);
});

test('trigger keeps the index in sync on UPDATE and DELETE', () => {
  db.prepare("UPDATE books SET authors_search = 'роулинг джоан' WHERE id = 'ftstok-1'").run();
  assert.equal(matchCount('толкин'), 0);
  assert.equal(matchCount('роулинг'), 1);
  db.prepare("DELETE FROM books WHERE id = 'ftstok-1'").run();
  assert.equal(matchCount('роулинг'), 0);
});

test('staged rebuild indexes tokens, not just document rows', async () => {
  insertBook('ftstok-2', 'хоббит', 'толкин джон');
  await rebuildBooksFtsFromContent();
  assert.equal(matchCount('хоббит'), 1);
  assert.equal(matchCount('толкин'), 1);
  db.prepare("DELETE FROM books WHERE id = 'ftstok-2'").run();
});

test('status flags an index with documents but no tokens as desynced', () => {
  insertBook('ftstok-3', 'сильмариллион', 'толкин джон');
  // Старая сборка: строка в docsize без токенов (INSERT INTO books_fts(rowid) VALUES (?)).
  db.exec("INSERT INTO books_fts(books_fts) VALUES('delete-all')");
  db.prepare('INSERT INTO books_fts(rowid) SELECT rowid FROM books WHERE id = ?').run('ftstok-3');
  invalidateBooksFtsHealthCache();
  assert.equal(matchCount('сильмариллион'), 0);
  assert.equal(getBooksFtsStatus({ force: true, recover: false }).status, 'desynced');

  rebuildBooksFtsFromContentSync();
  invalidateBooksFtsHealthCache();
  assert.equal(matchCount('сильмариллион'), 1);
  assert.notEqual(getBooksFtsStatus({ force: true, recover: false }).status, 'desynced');
  db.prepare("DELETE FROM books WHERE id = 'ftstok-3'").run();
});
