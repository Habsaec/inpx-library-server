import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db } from '../src/db.js';
import { getFavoriteAuthors, getFavoriteSeries, getFollowingNewBooks, getFollowingNewCount } from '../src/inpx.js';

before(() => { initDb(); });

test('favorites lists use the catalog counters and a bounded cover pick; following works from either side', () => {
  const user = 'fav-perf-user';
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT OR IGNORE INTO users(username, password_hash, role) VALUES(?, 'x', 'user')").run(user);
  const sourceId = Number(db.prepare("INSERT INTO sources(name, type, path, enabled) VALUES('fav-perf', 'folder', 'fav-perf-path', 1)").run().lastInsertRowid);
  const authorId = Number(db.prepare("INSERT INTO authors(name, display_name, sort_name, search_name, book_count) VALUES('perf,author', 'Perf Author', 'perf author', 'perf author', 3)").run().lastInsertRowid);
  const seriesId = Number(db.prepare("INSERT INTO series_catalog(name, display_name, sort_name, search_name, book_count) VALUES('perf series', 'Perf Series', 'perf series', 'perf series', 2)").run().lastInsertRowid);
  const today = new Date().toISOString().slice(0, 10);
  const ids = ['pf1', 'pf2', 'pf3'];
  ids.forEach((id, i) => {
    db.prepare(`INSERT OR REPLACE INTO books(id, title, authors, lib_id, archive_name, file_name, ext, deleted, source_id, title_sort, author_sort, date, lib_rate)
      VALUES(?, ?, 'Perf,Author', ?, 'a.zip', ?, 'fb2', 0, ?, ?, 'perf author', ?, ?)`).run(id, `Book ${i}`, `lib${i}`, `f${i}.fb2`, sourceId, `book ${i}`, today, i);
    db.prepare('INSERT OR IGNORE INTO book_authors(book_id, author_id) VALUES(?, ?)').run(id, authorId);
  });
  db.prepare('INSERT OR IGNORE INTO book_series(book_id, series_id, series_no) VALUES(?, ?, ?)').run('pf1', seriesId, '1');
  db.prepare('INSERT OR IGNORE INTO book_series(book_id, series_id, series_no) VALUES(?, ?, ?)').run('pf2', seriesId, '2');
  db.prepare('INSERT OR IGNORE INTO favorite_authors(username, author_id) VALUES(?, ?)').run(user, authorId);
  db.prepare('INSERT OR IGNORE INTO favorite_series(username, series_id) VALUES(?, ?)').run(user, seriesId);
  db.pragma('foreign_keys = ON');
  try {
    const authors = getFavoriteAuthors(user, 10, 'name', '');
    assert.equal(authors.length, 1);
    assert.equal(authors[0].bookCount, 3, 'taken from authors.book_count');
    assert.equal(authors[0].coverBookId, 'pf3', 'best rated among the candidates');
    const series = getFavoriteSeries(user, 10, 'name', '');
    assert.equal(series[0].bookCount, 2);
    assert.deepEqual(series[0].previewBookIds.sort(), ['pf1', 'pf2']);
    // few favorites relative to the window → both query shapes must agree with each other
    const list = getFollowingNewBooks(user, { page: 1, pageSize: 10 });
    assert.equal(list.total, 3);
    assert.deepEqual(list.items.map((b) => b.id).sort(), ids);
    assert.equal(getFollowingNewCount(user, { unseenOnly: false }), 3);

    // a bigger recent window flips the planner to the favorites-driven shape: same answers
    db.pragma('foreign_keys = OFF');
    for (let i = 0; i < 60; i += 1) {
      db.prepare(`INSERT OR REPLACE INTO books(id, title, authors, lib_id, archive_name, file_name, ext, deleted, source_id, title_sort, author_sort, date)
        VALUES(?, 'Filler', 'Other,Person', ?, 'z.zip', ?, 'fb2', 0, ?, 'filler', 'other person', ?)`).run(`pfx${i}`, `fx${i}`, `x${i}.fb2`, sourceId, today);
    }
    db.pragma('foreign_keys = ON');
    const list2 = getFollowingNewBooks(user, { page: 1, pageSize: 10 });
    assert.equal(list2.total, 3);
    assert.deepEqual(list2.items.map((b) => b.id).sort(), ids);
  } finally {
    db.prepare("DELETE FROM books WHERE id LIKE 'pfx%'").run();
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM favorite_authors WHERE username = ?').run(user);
    db.prepare('DELETE FROM favorite_series WHERE username = ?').run(user);
    db.prepare("DELETE FROM book_series WHERE series_id = ?").run(seriesId);
    db.prepare("DELETE FROM book_authors WHERE author_id = ?").run(authorId);
    db.prepare("DELETE FROM books WHERE id IN ('pf1', 'pf2', 'pf3')").run();
    db.prepare('DELETE FROM series_catalog WHERE id = ?').run(seriesId);
    db.prepare('DELETE FROM authors WHERE id = ?').run(authorId);
    db.prepare("DELETE FROM sources WHERE path = 'fav-perf-path'").run();
    db.pragma('foreign_keys = ON');
  }
});
