import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, setSetting, getSetting, rebuildActiveBooksView } from '../src/db.js';
import { searchCatalog } from '../src/inpx.js';

const TITLE = 'скрытаякнигаязык';
const RU_ID = 'hidden-lang-ru';
const EN_ID = 'hidden-lang-en';

function insertBook(id, lang) {
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, '', '', '', '',
      ?, '',
      '', 0, ?, '', '',
      '', '', ?, 'a.zip', 1, ?, 0,
      'fb2', '', ?, '', 0, NULL
    )
  `).run(id, TITLE, TITLE, TITLE, `${id}.fb2`, id, lang);
}

let prevExcluded = '';

before(async () => {
  initDb();
  db.prepare('DELETE FROM books WHERE id IN (?, ?)').run(RU_ID, EN_ID);
  insertBook(RU_ID, 'ru');
  insertBook(EN_ID, 'en');
  prevExcluded = getSetting('excluded_languages') || '';
  setSetting('excluded_languages', prevExcluded ? `${prevExcluded},en` : 'en');
  await rebuildActiveBooksView();
});

after(async () => {
  db.prepare('DELETE FROM books WHERE id IN (?, ?)').run(RU_ID, EN_ID);
  setSetting('excluded_languages', prevExcluded);
  await rebuildActiveBooksView();
});

test('search total skips books in excluded languages', () => {
  const ftsHits = Number(db.prepare(`
    SELECT COUNT(*) AS c FROM books_fts WHERE books_fts MATCH ?
  `).get(`"${TITLE}"`).c) || 0;
  assert.equal(ftsHits, 2);

  const result = searchCatalog({ query: TITLE, field: 'books', page: 1, pageSize: 24 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, RU_ID);
  assert.equal(result.total, result.items.length);
});
