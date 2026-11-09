import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db } from '../src/db.js';
import {
  getAuthorSeriesGroupsOpds,
  getAuthorStandaloneBooksOpds,
  getAuthorSeriesBooksOpds,
  getSeriesBooksOpds,
  countSeriesBooksOpds,
  authorAliasBookCount,
} from '../src/inpx.js';

function insertBook(id, title, authors, series = '') {
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (?, ?, ?, '', ?, '', ?, '', '', 1, ?, '', '', '', '', ?, 'a.zip', 1, ?, 0, 'fb2', '', 'ru', '', 0, 1)
  `).run(id, title, authors, series, title.toLowerCase(), title.toLowerCase(), `${id}.fb2`, id);
}

function reset() {
  initDb();
  for (const table of ['book_series', 'book_authors', 'book_genres', 'books', 'authors', 'series_catalog']) db.exec(`DELETE FROM ${table}`);
  db.exec('DELETE FROM sources WHERE id = 1');
  db.prepare(`INSERT INTO sources (id, name, type, path, enabled) VALUES (1, 'src', 'folder', '/', 1)`).run();
}

test('OPDS author feed: aliases merged, series groups match what they open, standalone books paged', () => {
  reset();
  // Two spellings of one author (same search name): the list showed one spelling's count.
  db.prepare(`INSERT INTO authors (name, display_name, sort_name, search_name, book_count) VALUES
    ('янг,роберт франклин', 'Янг Роберт Франклин', 'янг роберт франклин', 'янг роберт франклин', 2),
    ('янг,роберт,франклин', 'Янг Роберт Франклин', 'янг роберт франклин', 'янг роберт франклин', 1)`).run();
  db.prepare(`INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count) VALUES
    ('дозоры', 'Дозоры', 'дозоры', 'дозоры', 2)`).run();
  const [a1, a2] = db.prepare('SELECT id FROM authors ORDER BY id').all().map((r) => r.id);
  const sid = db.prepare('SELECT id FROM series_catalog').get().id;
  insertBook('b1', 'Alpha', 'Янг,Роберт Франклин', 'Дозоры');
  insertBook('b2', 'Beta', 'Янг,Роберт Франклин', 'ДОЗОРЫ'); // other spelling of the series text
  insertBook('b3', 'Gamma', 'Янг,Роберт,Франклин');
  const la = db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)');
  la.run('b1', a1); la.run('b2', a1); la.run('b3', a2);
  const ls = db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)');
  ls.run('b1', sid, '1'); ls.run('b2', sid, '2');

  assert.equal(authorAliasBookCount('янг,роберт франклин'), 3);

  const groups = getAuthorSeriesGroupsOpds('янг,роберт франклин');
  assert.deepEqual(groups.map((g) => [g.displayName, g.count]), [['Дозоры', 2]]);
  // the group count is exactly what the author + series feed opens
  assert.equal(getAuthorSeriesBooksOpds('янг,роберт франклин', groups[0].name).length, 2);

  const page1 = getAuthorStandaloneBooksOpds('янг,роберт франклин', '', { limit: 1, offset: 0 });
  assert.equal(page1.total, 1);
  assert.deepEqual(page1.items.map((b) => b.id), ['b3']);
});

test('OPDS series feed: count and pages beyond the old 500 cap', () => {
  reset();
  db.prepare(`INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count) VALUES ('s', 'S', 's', 's', 3)`).run();
  const sid = db.prepare('SELECT id FROM series_catalog').get().id;
  for (const n of [1, 2, 3]) {
    insertBook(`s${n}`, `Vol ${n}`, 'X,Y', 'S');
    db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run(`s${n}`, sid, String(n));
  }
  assert.equal(countSeriesBooksOpds('s'), 3);
  assert.deepEqual(getSeriesBooksOpds('s', { limit: 2, offset: 2 }).map((b) => b.id), ['s3']);
  assert.equal(getSeriesBooksOpds('s').length, 3);
});
