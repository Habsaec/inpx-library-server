import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, db, getUserStats } from '../src/db.js';
import {
  getLibraryView,
  getReadingHistory,
  hasContinueBooks,
  parseLine,
  enrichBookRow,
  recordReadingHistory
} from '../src/inpx.js';

const SEP = String.fromCharCode(4);
const USER = 'continue_user';

function makeInpLine(fields) {
  const defaults = {
    authors: 'Author',
    genres: 'sf',
    title: 'Book',
    series: '',
    seriesNo: '',
    fileName: 'book',
    size: '100',
    libId: '1',
    deleted: '0',
    ext: 'fb2',
    date: '',
    lang: 'ru',
    libRate: '0',
    keywords: ''
  };
  const merged = { ...defaults, ...fields };
  return [
    merged.authors, merged.genres, merged.title, merged.series, merged.seriesNo,
    merged.fileName, merged.size, merged.libId, merged.deleted, merged.ext,
    merged.date, merged.lang, merged.libRate, merged.keywords
  ].join(SEP);
}

function insertBook(fields) {
  const row = enrichBookRow(parseLine(makeInpLine(fields), 'test.zip'));
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      @id, @title, @authors, @genres, @series, @seriesNo, @titleSort, @authorSort,
      @seriesSort, @seriesIndex, @titleSearch, @authorsSearch, @seriesSearch,
      @genresSearch, @keywordsSearch, @fileName, @archiveName, @size, @libId, @deleted,
      @ext, @date, @lang, @keywords, @libRate, @sourceId
    )
  `).run({ ...row, sourceId: null });
  return row.id;
}

let dataDir;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-continue-read-'));
  process.env.DATA_DIR = dataDir;
  initDb();
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?, ?, ?)').run(USER, 'x', 'user');
  insertBook({ libId: '201', title: 'In Progress', fileName: '201' });
  insertBook({ libId: '202', title: 'Finished', fileName: '202' });
  recordReadingHistory(USER, '201');
  recordReadingHistory(USER, '202');
  db.prepare('INSERT INTO read_books(username, book_id) VALUES (?, ?)').run(USER, '202');
});

after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('continue view excludes books marked as read', () => {
  const { total, items } = getLibraryView('continue', { username: USER, pageSize: 24 });
  assert.equal(total, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '201');
});

test('continue view items carry lastOpenedAt/openCount so the home hero can undo a removal', () => {
  const { items } = getLibraryView('continue', { username: USER, pageSize: 24 });
  assert.ok(items[0].lastOpenedAt);
  assert.ok(items[0].openCount >= 1);
});

test('hasContinueBooks ignores finished-only history', () => {
  assert.equal(hasContinueBooks(USER), true);
  db.prepare('DELETE FROM reading_history WHERE username = ? AND book_id = ?').run(USER, '201');
  assert.equal(hasContinueBooks(USER), false);
  recordReadingHistory(USER, '201');
});

test('getReadingHistory excludes read by default and can include them', () => {
  const active = getReadingHistory(USER, 20);
  assert.deepEqual(active.map((b) => b.id), ['201']);
  const all = getReadingHistory(USER, 20, { excludeRead: false });
  assert.equal(all.length, 2);
  assert.ok(all.some((b) => b.id === '202'));
});

test('profile readingCount excludes read books', () => {
  const stats = getUserStats(USER);
  assert.equal(stats.readingCount, 1);
  assert.equal(stats.readBooksCount, 1);
});
