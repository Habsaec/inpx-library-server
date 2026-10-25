import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDb, db, setBookRating, getUserReadingStats, setReadingGoal, getReadingGoal,
  setUserHideRead, getUserHideRead, setUserDownloadFormat, getUserDownloadFormat,
  setUserTelegramDigest, getUserStats, setMeta, getMeta
} from '../src/db.js';
import {
  parseLine, enrichBookRow, getLibraryView, searchBooks, getBooksByFacet, getAuthorBooksGrouped,
  toggleReadBook, isBookRead, isWantToRead, markSeriesReadUpTo, getSeriesReadingProgress
} from '../src/inpx.js';
import { parseCsv, importReadingCsv } from '../src/services/reading-import.js';
import { resolveHideReadUser } from '../src/hide-read.js';
import { runTelegramDigest, digestWeekKey } from '../src/services/telegram-digest.js';

const SEP = String.fromCharCode(4);
const USER = 'usability_user';

function insertBook(fields) {
  const f = {
    authors: 'Writer,Usab,', genres: 'sf', title: 'Book', series: '', seriesNo: '', fileName: 'book',
    size: '100', libId: '1', deleted: '0', ext: 'fb2', date: '', lang: 'ru', libRate: '0', keywords: '',
    ...fields
  };
  const line = [f.authors, f.genres, f.title, f.series, f.seriesNo, f.fileName, f.size, f.libId,
    f.deleted, f.ext, f.date, f.lang, f.libRate, f.keywords].join(SEP);
  const row = enrichBookRow(parseLine(line, 'usability.zip'));
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

let ids;
let authorName;

before(() => {
  initDb();
  db.prepare("INSERT OR IGNORE INTO users(username, password_hash, role) VALUES (?, 'x', 'user')").run(USER);
  ids = {
    a: insertBook({ libId: '9501', title: 'Usability Alpha', fileName: '9501', date: '2026-10-01' }),
    b: insertBook({ libId: '9502', title: 'Usability Beta', fileName: '9502', date: '2026-10-02' }),
    v1: insertBook({ libId: '9601', title: 'Cycle One', fileName: '9601' }),
    v2: insertBook({ libId: '9602', title: 'Cycle Two', fileName: '9602' }),
    v3: insertBook({ libId: '9603', title: 'Cycle Three', fileName: '9603' }),
    dune: insertBook({ libId: '9701', title: 'Дюна', fileName: '9701', authors: 'Герберт,Фрэнк,' })
  };
  db.prepare("INSERT INTO authors (name, display_name, sort_name, search_name, book_count) VALUES ('writer,usab', 'Usab Writer', 'writer usab', 'writer usab', 2)").run();
  const authorId = db.prepare("SELECT id FROM authors WHERE name = 'writer,usab'").get().id;
  authorName = 'writer,usab';
  for (const id of [ids.a, ids.b]) db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)').run(id, authorId);
  db.prepare("INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count) VALUES ('usab cycle', 'Usab Cycle', 'usab cycle', 'usab cycle', 3)").run();
  const seriesId = db.prepare("SELECT id FROM series_catalog WHERE name = 'usab cycle'").get().id;
  [[ids.v1, '1'], [ids.v2, '2'], [ids.v3, '3']].forEach(([id, no]) => {
    db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run(id, seriesId, no);
  });
});

test('«Скрыть прочитанное» removes read books from search, facet and author lists', () => {
  toggleReadBook(USER, ids.a);
  const all = searchBooks({ query: 'Usability', field: 'title', totalMode: 'exact' });
  assert.ok(all.items.some((b) => b.id === ids.a));
  const hidden = searchBooks({ query: 'Usability', field: 'title', totalMode: 'exact', hideReadUser: USER });
  assert.ok(!hidden.items.some((b) => b.id === ids.a));
  assert.ok(hidden.items.some((b) => b.id === ids.b));

  const facet = getBooksByFacet({ facet: 'authors', value: authorName, hideReadUser: USER });
  assert.deepEqual(facet.items.map((b) => b.id), [ids.b]);

  const grouped = getAuthorBooksGrouped(authorName, 'title', '', { hideReadUser: USER });
  const groupedIds = [...(grouped.standaloneBooks || []), ...(grouped.series || []).flatMap((s) => s.books || [])].map((b) => b.id);
  assert.ok(!groupedIds.includes(ids.a));
});

test('hide-read preference: saved switch, query override, anonymous', () => {
  setUserHideRead(USER, true);
  assert.equal(getUserHideRead(USER), true);
  assert.equal(resolveHideReadUser({ user: { username: USER }, query: {} }), USER);
  assert.equal(resolveHideReadUser({ user: { username: USER }, query: { hideRead: '0' } }), '');
  assert.equal(resolveHideReadUser({ user: null, query: { hideRead: '1' } }), '');
  setUserHideRead(USER, false);
  assert.equal(resolveHideReadUser({ user: { username: USER }, query: {} }), '');
});

test('download format preference is sanitized', () => {
  setUserDownloadFormat(USER, 'FB2ZIP');
  assert.equal(getUserDownloadFormat(USER), 'fb2zip');
  setUserDownloadFormat(USER, '');
  assert.equal(getUserDownloadFormat(USER), '');
});

test('«Мои оценки» lists rated books best first with myRating', () => {
  setBookRating(USER, ids.b, 3);
  setBookRating(USER, ids.v1, 5);
  const view = getLibraryView('rated', { username: USER, sort: 'rating' });
  assert.deepEqual(view.items.map((b) => [b.id, b.myRating]), [[ids.v1, 5], [ids.b, 3]]);
  assert.equal(getUserStats(USER).ratedCount, 2);
});

test('reading goal and this year by month', () => {
  const year = new Date().getFullYear();
  assert.equal(getReadingGoal(USER, year), 0);
  setReadingGoal(USER, year, 40);
  const stats = getUserReadingStats(USER);
  assert.equal(stats.goal, 40);
  assert.equal(stats.year, year);
  assert.equal(stats.byMonth.length, 12);
  assert.ok(stats.readThisYear >= 1, 'a book marked read today counts');
  setReadingGoal(USER, year, 0);
  assert.equal(getReadingGoal(USER, year), 0);
});

test('series: mark read up to volume N', () => {
  const before = getSeriesReadingProgress(USER, 'usab cycle');
  assert.deepEqual(before.numbers, [1, 2, 3]);
  const { added } = markSeriesReadUpTo(USER, 'usab cycle', 2);
  assert.equal(added, 2);
  assert.ok(isBookRead(USER, ids.v1) && isBookRead(USER, ids.v2));
  assert.ok(!isBookRead(USER, ids.v3));
  assert.equal(getSeriesReadingProgress(USER, 'usab cycle').next.id, ids.v3);
});

test('CSV import: Goodreads columns, series suffix, statuses, ratings, unmatched list', async () => {
  const rows = parseCsv('Title,Author,My Rating,Exclusive Shelf\n"Дюна (Хроники Дюны, #1)","Фрэнк Герберт",4,read\n"Cycle Three",Usab Writer,0,to-read\n"No Such Book",Nobody,5,read\n');
  assert.equal(rows.length, 4);
  const report = await importReadingCsv(USER, rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n'));
  assert.equal(report.rows, 3);
  assert.equal(report.matched, 2);
  assert.equal(report.read, 1);
  assert.equal(report.want, 1);
  assert.equal(report.rated, 1);
  assert.deepEqual(report.unmatched, [{ title: 'No Such Book', author: 'Nobody' }]);
  assert.ok(isBookRead(USER, ids.dune));
  assert.ok(isWantToRead(USER, ids.v3));
});

test('CSV import understands LiveLib-style «;» files with Russian headers', () => {
  const rows = parseCsv('﻿Автор;Название;Статус;Оценка\r\nФрэнк Герберт;Дюна;Прочитано;5\r\n');
  assert.deepEqual(rows[1], ['Фрэнк Герберт', 'Дюна', 'Прочитано', '5']);
});

test('Telegram digest: sends new favorite books once a week, nothing when empty', async () => {
  const digestUser = 'usability_digest';
  db.prepare("INSERT OR IGNORE INTO users(username, password_hash, role, telegram_id) VALUES (?, 'x', 'user', '777')").run(digestUser);
  setUserTelegramDigest(digestUser, true);
  const authorId = db.prepare("SELECT id FROM authors WHERE name = 'writer,usab'").get().id;
  db.prepare('INSERT OR IGNORE INTO favorite_authors (username, author_id) VALUES (?, ?)').run(digestUser, authorId);
  const sent = [];
  const send = {
    sendText: async (chatId, html) => { sent.push(['text', chatId, html]); },
    sendCard: async (chatId, bookId) => { sent.push(['card', chatId, bookId]); }
  };
  const monday = new Date(2026, 9, 26, 11, 0, 0);
  const first = await runTelegramDigest({ now: monday, send });
  assert.ok(first.users >= 1);
  assert.ok(sent.some(([kind, chat, id]) => kind === 'card' && chat === '777' && id === ids.b));
  assert.equal(JSON.parse(getMeta(`telegram_digest_sent:${digestUser}`)).week, digestWeekKey(monday));

  sent.length = 0;
  await runTelegramDigest({ now: monday, send });
  assert.equal(sent.filter(([, chat]) => chat === '777').length, 0, 'same week — nothing again');

  setMeta(`telegram_digest_sent:${digestUser}`, JSON.stringify({ week: 'old', since: '2099-01-01' }));
  await runTelegramDigest({ now: monday, send });
  assert.equal(sent.filter(([, chat]) => chat === '777').length, 0, 'nothing newer — no message');

  const tuesday = new Date(2026, 9, 27, 11, 0, 0);
  assert.deepEqual(await runTelegramDigest({ now: tuesday, send }), { users: 0, sent: 0 });
});
