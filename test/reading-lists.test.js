import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, upsertReadingHistoryEntry, getUserStats } from '../src/db.js';
import {
  parseLine, enrichBookRow, getLibraryView, recordReadingHistory,
  toggleWantToRead, isWantToRead, toggleReadBook,
  getFollowingNewBooks, getFollowingNewCount, markFollowingSeen, invalidateFollowingBadge,
  getSeriesReadingProgress, getSeriesReadCounts
} from '../src/inpx.js';

const SEP = String.fromCharCode(4);
const USER = 'lists_user';

function insertBook(fields) {
  const f = {
    authors: 'Author', genres: 'sf', title: 'Book', series: '', seriesNo: '', fileName: 'book',
    size: '100', libId: '1', deleted: '0', ext: 'fb2', date: '', lang: 'ru', libRate: '0', keywords: '',
    ...fields
  };
  const line = [f.authors, f.genres, f.title, f.series, f.seriesNo, f.fileName, f.size, f.libId,
    f.deleted, f.ext, f.date, f.lang, f.libRate, f.keywords].join(SEP);
  const row = enrichBookRow(parseLine(line, 'lists.zip'));
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

function linkSeries(bookId, seriesId, no) {
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run(bookId, seriesId, no);
}

let ids;
let seriesId;

before(() => {
  initDb();
  db.prepare("INSERT OR IGNORE INTO users(username, password_hash, role) VALUES (?, 'x', 'user')").run(USER);

  // Newest dated book defines the catalog window; «new» books are within 90 days of it.
  ids = {
    w1: insertBook({ libId: '9101', title: 'Want One', fileName: '9101', date: '2026-01-01' }),
    w2: insertBook({ libId: '9102', title: 'Want Two', fileName: '9102', date: '2026-01-01' }),
    w3: insertBook({ libId: '9103', title: 'Want Three', fileName: '9103', date: '2026-01-01' }),
    favNew: insertBook({ libId: '9201', title: 'Fav New', fileName: '9201', authors: 'Favorite,Writer,', date: '2026-10-01' }),
    favNewer: insertBook({ libId: '9202', title: 'Fav Newer', fileName: '9202', authors: 'Favorite,Writer,', date: '2026-10-10' }),
    favOld: insertBook({ libId: '9203', title: 'Fav Old', fileName: '9203', authors: 'Favorite,Writer,', date: '2025-01-01' }),
    other: insertBook({ libId: '9204', title: 'Not Favorite', fileName: '9204', authors: 'Other,Writer,', date: '2026-10-10' }),
    s1fb2: insertBook({ libId: '9301', title: 'Saga One', fileName: '9301', ext: 'fb2' }),
    s1epub: insertBook({ libId: '9302', title: 'Saga One', fileName: '9302', ext: 'epub' }),
    s2: insertBook({ libId: '9303', title: 'Saga Two', fileName: '9303' }),
    sOmni: insertBook({ libId: '9304', title: 'Saga Omnibus', fileName: '9304' }),
    s3: insertBook({ libId: '9305', title: 'Saga Three', fileName: '9305' })
  };

  db.prepare("INSERT INTO authors (name, display_name, sort_name, search_name, book_count) VALUES ('favorite,writer', 'Favorite Writer', 'favorite writer', 'favorite writer', 3)").run();
  const authorId = db.prepare("SELECT id FROM authors WHERE name = 'favorite,writer'").get().id;
  for (const id of [ids.favNew, ids.favNewer, ids.favOld]) {
    db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)').run(id, authorId);
  }
  db.prepare('INSERT INTO favorite_authors (username, author_id) VALUES (?, ?)').run(USER, authorId);

  db.prepare("INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count) VALUES ('lists saga', 'Lists Saga', 'lists saga', 'lists saga', 5)").run();
  seriesId = db.prepare("SELECT id FROM series_catalog WHERE name = 'lists saga'").get().id;
  linkSeries(ids.s1fb2, seriesId, '1');
  linkSeries(ids.s1epub, seriesId, '1');
  linkSeries(ids.s2, seriesId, '2');
  linkSeries(ids.sOmni, seriesId, '');
  linkSeries(ids.s3, seriesId, '3');
});

test('«Хочу прочитать» toggles and lists newest first', () => {
  assert.equal(toggleWantToRead(USER, ids.w1), true);
  assert.equal(toggleWantToRead(USER, ids.w2), true);
  assert.equal(isWantToRead(USER, ids.w1), true);
  const view = getLibraryView('want', { username: USER });
  assert.equal(view.total, 2);
  assert.deepEqual(new Set(view.items.map((b) => b.id)), new Set([ids.w1, ids.w2]));
  assert.equal(getUserStats(USER).wantCount, 2);
  assert.equal(toggleWantToRead(USER, ids.w2), false);
  assert.equal(getLibraryView('want', { username: USER }).total, 1);
});

test('a book leaves «Хочу прочитать» when opened (web or Android) or marked read', () => {
  // w1 is still listed from the previous test.
  toggleWantToRead(USER, ids.w2);
  toggleWantToRead(USER, ids.w3);
  assert.equal(isWantToRead(USER, ids.w1), true);
  recordReadingHistory(USER, ids.w1);
  assert.equal(isWantToRead(USER, ids.w1), false);
  upsertReadingHistoryEntry(USER, ids.w2, '', 1);
  assert.equal(isWantToRead(USER, ids.w2), false);
  toggleReadBook(USER, ids.w3);
  assert.equal(isWantToRead(USER, ids.w3), false);
  assert.equal(getLibraryView('want', { username: USER }).total, 0);
});

test('«Новое у любимых» lists recent unread books of favorite authors and counts unseen ones', () => {
  invalidateFollowingBadge(USER);
  const result = getFollowingNewBooks(USER);
  assert.deepEqual(result.items.map((b) => b.id), [ids.favNewer, ids.favNew]);
  assert.equal(getFollowingNewCount(USER), 2);

  markFollowingSeen(USER);
  assert.equal(getFollowingNewCount(USER), 0);
  assert.equal(getFollowingNewBooks(USER).total, 2, 'seen books stay in the list');

  toggleReadBook(USER, ids.favNewer);
  assert.deepEqual(getFollowingNewBooks(USER).items.map((b) => b.id), [ids.favNew]);
});

test('series progress groups editions, skips read volumes and puts unnumbered ones last', () => {
  let progress = getSeriesReadingProgress(USER, 'lists saga');
  assert.equal(progress.total, 4, 'FB2 + EPUB of volume 1 count once');
  assert.equal(progress.read, 0);
  assert.equal(progress.next.seriesNo, '1');

  toggleReadBook(USER, ids.s1epub);
  progress = getSeriesReadingProgress(USER, 'lists saga');
  assert.equal(progress.read, 1);
  assert.equal(progress.next.id, ids.s2, 'reading the EPUB edition finishes volume 1');

  toggleReadBook(USER, ids.s2);
  toggleReadBook(USER, ids.s3);
  progress = getSeriesReadingProgress(USER, 'lists saga');
  assert.equal(progress.next.id, ids.sOmni, 'the unnumbered omnibus comes after numbered volumes');

  toggleReadBook(USER, ids.sOmni);
  progress = getSeriesReadingProgress(USER, 'lists saga');
  assert.equal(progress.read, 4);
  assert.equal(progress.next, null);
  assert.equal(getSeriesReadCounts(USER).get('lists saga'), 4);
});
