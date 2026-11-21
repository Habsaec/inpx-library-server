import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, initDb, getUserYearReview } from '../src/db.js';

function insertBook(id, title, authors) {
  db.prepare(`
    INSERT OR IGNORE INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (?, ?, ?, '', '', '', ?, ?, '', 0, ?, ?, '', '', '', ?, 'a.zip', 1, ?, 0, 'fb2', '', 'ru', '', 0, 77)
  `).run(id, title, authors, title.toLowerCase(), authors.toLowerCase(), title.toLowerCase(), authors.toLowerCase(), `${id}.fb2`, id);
}

test('year review: totals, months, first / last, favourite, other years', () => {
  initDb();
  db.prepare("INSERT OR IGNORE INTO sources (id, name, type, path, enabled) VALUES (77, 'year-src', 'folder', '/year', 1)").run();
  db.pragma('foreign_keys = OFF');
  for (const [id, title] of [['yr-1', 'Alpha'], ['yr-2', 'Beta'], ['yr-3', 'Gamma'], ['yr-old', 'Old']]) insertBook(id, title, 'Author');
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT OR IGNORE INTO users (username, password_hash) VALUES ('yr-user', 'x')").run();
  const read = db.prepare('INSERT OR REPLACE INTO read_books (username, book_id, created_at) VALUES (?, ?, ?)');
  read.run('yr-user', 'yr-1', '2025-02-10 10:00:00');
  read.run('yr-user', 'yr-2', '2025-02-20 10:00:00');
  read.run('yr-user', 'yr-3', '2025-07-01 10:00:00');
  read.run('yr-user', 'yr-old', '2023-05-01 10:00:00');
  db.prepare('INSERT OR REPLACE INTO book_ratings (username, book_id, rating) VALUES (?, ?, ?)').run('yr-user', 'yr-2', 5);

  const r = getUserYearReview('yr-user', 2025);
  assert.equal(r.total, 3);
  assert.equal(r.byMonth[1], 2);
  assert.equal(r.byMonth[6], 1);
  assert.equal(r.busiestMonth, 2);
  assert.equal(r.first.title, 'Alpha');
  assert.equal(r.last.title, 'Gamma');
  assert.equal(r.favorite.title, 'Beta');
  assert.equal(r.averageRating, 5);
  assert.deepEqual(r.years, [2025, 2023]);
  assert.equal(r.covers.length, 3);

  const all = getUserYearReview('yr-user', 'all');
  assert.equal(all.allTime, true);
  assert.equal(all.year, 'all');
  assert.equal(all.total, 4);
  assert.equal(all.byMonth, null);
  assert.deepEqual(all.byYear, [{ year: 2023, count: 1 }, { year: 2025, count: 3 }]);
  assert.equal(all.busiestYear, 2025);
  assert.equal(all.first.title, 'Old');
  assert.equal(all.goal, 0);

  const empty = getUserYearReview('yr-user', 2024);
  assert.equal(empty.total, 0);
  assert.equal(empty.first, null);
  assert.equal(empty.busiestMonth, null);
});
