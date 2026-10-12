import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, db, getUserReadingStats } from '../src/db.js';
import { parseLine, enrichBookRow } from '../src/inpx.js';
import { pageShell } from '../src/templates/shared.js';
import {
  renderProfile, renderFavorites, renderMyLibrary,
  renderReaderBookmarksPage, renderReaderNotesPage
} from '../src/templates/library.js';

const SEP = String.fromCharCode(4);
const USER = 'stats_user';
const AUTHOR_A = 'Psalpha,Alpha';
const GENRE_SF = 'ps-sf';
const stats = { totalBooks: 3, totalAuthors: 2, totalSeries: 0, totalGenres: 2, totalLanguages: 2 };
const alice = { username: 'alice_reader', role: 'user' };
const userStats = {
  readingCount: 2, bookmarkCount: 3, readBooksCount: 4, favoriteAuthorsCount: 5, favoriteSeriesCount: 6,
  shelvesCount: 7, readerBookmarksCount: 8, readerAnnotationsCount: 9, createdAt: '2025-01-01 00:00:00'
};

function insertBook(libId, authors, genres) {
  const line = [authors, genres, `Book ${libId}`, '', '', libId, '100', libId, '0', 'fb2', '', 'ru', '0', ''].join(SEP);
  const row = enrichBookRow(parseLine(line, 'profile-stats.zip'));
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

function tabsOf(html) {
  const m = html.match(/<nav class="view-switcher account-nav account-nav-tabs"[\s\S]*?<\/nav>/);
  assert.ok(m, 'section tabs should be rendered');
  return m[0];
}

let dataDir;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-profile-stats-'));
  process.env.DATA_DIR = dataDir;
  initDb();
  db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?, ?, ?)').run(USER, 'x', 'user');
  // Unique names: npm test shares one library.db between test files.
  const authorA = db.prepare('INSERT INTO authors(name, display_name) VALUES (?, ?)').run(AUTHOR_A, 'Psalpha Alpha').lastInsertRowid;
  const authorB = db.prepare('INSERT INTO authors(name, display_name) VALUES (?, ?)').run('Psbeta,Beta', 'Psbeta Beta').lastInsertRowid;
  const sf = db.prepare('INSERT INTO genres_catalog(name) VALUES (?)').run(GENRE_SF).lastInsertRowid;
  const detective = db.prepare('INSERT INTO genres_catalog(name) VALUES (?)').run('ps-detective').lastInsertRowid;
  const books = [
    { id: insertBook('ps301', `${AUTHOR_A}:`, `${GENRE_SF}:`), author: authorA, genre: sf, readAt: '2025-03-01 10:00:00' },
    { id: insertBook('ps302', `${AUTHOR_A}:`, `${GENRE_SF}:`), author: authorA, genre: sf, readAt: '2025-07-01 10:00:00' },
    { id: insertBook('ps303', 'Psbeta,Beta:', 'ps-detective:'), author: authorB, genre: detective, readAt: '2026-01-02 10:00:00' }
  ];
  for (const b of books) {
    db.prepare('INSERT INTO book_authors(book_id, author_id) VALUES (?, ?)').run(b.id, b.author);
    db.prepare('INSERT INTO book_genres(book_id, genre_id) VALUES (?, ?)').run(b.id, b.genre);
    db.prepare('INSERT INTO read_books(username, book_id, created_at) VALUES (?, ?, ?)').run(USER, b.id, b.readAt);
  }
});

after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('getUserReadingStats groups read books by year, author and genre', () => {
  const rs = getUserReadingStats(USER);
  assert.deepEqual(rs.readByYear.map((y) => [y.year, y.count]), [['2026', 1], ['2025', 2]]);
  assert.equal(rs.topAuthors[0].name, AUTHOR_A);
  assert.equal(rs.topAuthors[0].count, 2);
  assert.equal(rs.topGenres[0].name, GENRE_SF);
  assert.equal(rs.topGenres[0].count, 2);
});

test('getUserReadingStats is empty for a user without read books', () => {
  const rs = getUserReadingStats('nobody_here');
  assert.deepEqual(rs, { readByYear: [], topAuthors: [], topGenres: [] });
});

test('sidebar groups personal sections for a signed-in user', () => {
  const html = pageShell({ title: 'T', content: '', user: alice, stats, currentPath: '/favorites' });
  for (const href of ['/library/continue', '/favorites', '/shelves', '/library/read', '/library/bookmarks', '/library/notes']) {
    assert.ok(html.includes(`href="${href}"`), `sidebar should link ${href}`);
  }
  assert.match(html, /<a class="active" href="\/favorites">/);
  assert.ok(!html.includes('sidebar-account'), 'profile lives in the topbar, not the sidebar');
  assert.equal((html.match(/sidenav-group-label/g) || []).length, 2);
});

test('sidebar keeps the active state for paths with a query string', () => {
  const html = pageShell({ title: 'T', content: '', user: alice, stats, currentPath: '/library/read?sort=title' });
  assert.match(html, /<a class="active" href="\/library\/read">/);
});

test('sidebar hides personal sections for anonymous visitors', () => {
  const html = pageShell({ title: 'T', content: '', user: null, stats, currentPath: '/' });
  assert.ok(!html.includes('href="/library/bookmarks"'));
  assert.ok(!html.includes('href="/shelves"'));
  assert.ok(!html.includes('sidebar-account'));
  assert.equal((html.match(/sidenav-group-label/g) || []).length, 1);
});

test('bottom navigation points to the library hub instead of favorites', () => {
  const html = pageShell({ title: 'T', content: '', user: alice, stats, currentPath: '/shelves' });
  assert.match(html, /<a class="bottom-nav-item is-active" href="\/library\/my">/);
  assert.ok(!html.includes('class="bottom-nav-item" href="/favorites"'));
});

test('profile page shows statistics and settings tabs, not personal lists', () => {
  const html = renderProfile({
    user: alice, stats, indexStatus: {}, userStats,
    readingStats: {
      readByYear: [{ year: '2025', count: 2 }],
      topAuthors: [{ name: 'Ivanov,Ivan', displayName: 'Ivanov Ivan', count: 2 }],
      topGenres: [{ name: 'sf', count: 2 }]
    }
  });
  assert.ok(html.includes('profile-stat-grid'));
  assert.ok(html.includes('profile-bar-fill'));
  assert.ok(html.includes('/facet/authors/Ivanov%2CIvan'));
  assert.ok(html.includes('/facet/genres/sf'));
  assert.ok(html.includes('href="/profile/settings"'));
  assert.ok(!html.includes('data-remove-bookmark'));
  const tabs = tabsOf(html);
  assert.ok(tabs.includes('href="/profile"') && tabs.includes('href="/profile/settings"'));
  assert.ok(!tabs.includes('/favorites'), 'favorites are not a profile tab');
});

test('profile page without reading stats shows an empty hint', () => {
  const html = renderProfile({ user: alice, stats, indexStatus: {}, userStats, readingStats: { readByYear: [], topAuthors: [], topGenres: [] } });
  assert.ok(html.includes('profile-empty'));
  assert.ok(!html.includes('profile-bar-fill'));
});

test('favorites page tabs cover books, series and authors only', () => {
  const html = renderFavorites({ user: alice, stats, indexStatus: {}, userStats, view: 'series' });
  const tabs = tabsOf(html);
  assert.ok(tabs.includes('/favorites?view=books'));
  assert.ok(tabs.includes('/favorites?view=series'));
  assert.ok(tabs.includes('/favorites?view=authors'));
  assert.ok(!tabs.includes('/shelves') && !tabs.includes('/library/read'), 'shelves/read are sidebar sections, not favorites tabs');
});

test('library hub lists every personal section with counts', () => {
  const html = renderMyLibrary({ user: alice, stats, indexStatus: {}, userStats });
  for (const href of ['/library/continue', '/favorites', '/shelves', '/library/read', '/library/bookmarks', '/library/notes']) {
    assert.ok(html.includes(`href="${href}"`), `hub should link ${href}`);
  }
  assert.ok(html.includes('>14<'), 'favorites count sums books, authors and series (3+5+6)');
});

test('bookmarks page renders removable rows and notes page renders note cards', () => {
  const bookmarks = renderReaderBookmarksPage({
    items: [{ id: 5, bookId: 'b1', position: 'p', label: 'Mark', bookTitle: 'Title', authors: 'A' }],
    total: 1, page: 1, pageSize: 30, user: alice, stats, indexStatus: {}
  });
  assert.ok(bookmarks.includes('data-remove-bookmark="5"'));
  const notes = renderReaderNotesPage({
    items: [{ id: 7, bookId: 'b1', cfi: 'c', text: 'quote', note: 'my note', color: 'green', createdAt: '2026-01-02 03:04:05', bookTitle: 'Title', authors: 'A' }],
    total: 1, page: 1, pageSize: 50, user: alice, stats, indexStatus: {}
  });
  assert.ok(notes.includes('data-note-id="7"'));
  assert.ok(notes.includes('note-card-green'));
  assert.ok(notes.includes('my note'));
});
