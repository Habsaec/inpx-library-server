import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, refreshCatalogBookCounts } from '../src/db.js';
import {
  searchCatalog, warmBrowseTotal, listSearchGenres, listSearchGenresAsync, listLanguages, getBooksByFacet,
  ensureLanguageTotals, opdsQuery, listAuthorsByLanguage, listEntitiesByLanguageAsync, listEntitiesByGenreAsync,
  listAuthorsByGenre
} from '../src/inpx.js';
import { listCollections } from '../src/collections.js';
import { queryAsync, stopQueryWorker } from '../src/services/query-pool.js';
import { getStaleOrScheduleAsync } from '../src/services/cache.js';

let sourceId;
const IDS = [];

before(async () => {
  initDb();
  db.pragma('foreign_keys = OFF');
  sourceId = Number(db.prepare("INSERT INTO sources(name, type, path, enabled) VALUES('perf-paths', 'folder', 'perf-paths-path', 1)").run().lastInsertRowid);
  const genreId = Number(db.prepare("INSERT INTO genres_catalog(name, display_name, sort_name, search_name) VALUES('perf_genre', 'Perf genre', 'perf genre', 'perf genre')").run().lastInsertRowid);
  const authorA = Number(db.prepare("INSERT INTO authors(name, display_name, sort_name, search_name) VALUES('zzperf,alpha', 'Zzperf Alpha', 'zzperf alpha', 'zzperf alpha')").run().lastInsertRowid);
  const authorB = Number(db.prepare("INSERT INTO authors(name, display_name, sort_name, search_name) VALUES('zzperf,beta', 'Zzperf Beta', 'zzperf beta', 'zzperf beta')").run().lastInsertRowid);
  const insert = db.prepare(`INSERT OR REPLACE INTO books(id, title, authors, lib_id, archive_name, file_name, ext, deleted, source_id, title_sort, author_sort, title_search, lang, date, series, series_no)
    VALUES(?, ?, ?, ?, 'a.zip', ?, ?, 0, ?, ?, 'zzperf', ?, ?, '2026-01-02', ?, ?)`);
  const rows = [
    ['pp1', 'Perf one', 'Zzperf,Alpha', 'fb2', 'ru', 'Perf saga', '1'],
    ['pp2', 'Perf two', 'Zzperf,Alpha', 'epub', 'ru', 'Perf saga', '2'],
    ['pp3', 'Perf three', 'Zzperf,Beta', 'fb2', 'en', '', ''],
    ['pp4', 'Perf four', 'Zzperf,Beta', 'fb2', '', '', '']
  ];
  for (const [id, title, authors, ext, lang, series, no] of rows) {
    IDS.push(id);
    insert.run(id, title, authors, `lib-${id}`, `${id}.${ext}`, ext, sourceId, title.toLowerCase(), title.toLowerCase(), lang, series, no);
    db.prepare('INSERT OR IGNORE INTO book_authors(book_id, author_id) VALUES(?, ?)').run(id, authors.includes('Alpha') ? authorA : authorB);
    db.prepare('INSERT OR IGNORE INTO book_genres(book_id, genre_id) VALUES(?, ?)').run(id, genreId);
  }
  const serId = Number(db.prepare("INSERT INTO series_catalog(name, display_name, sort_name, search_name) VALUES('zzperf saga', 'Zzperf saga', 'zzperf saga', 'zzperf saga')").run().lastInsertRowid);
  for (const id of ['pp1', 'pp2']) db.prepare('INSERT OR IGNORE INTO book_series(book_id, series_id) VALUES(?, ?)').run(id, serId);
  db.pragma('foreign_keys = ON');
  await refreshCatalogBookCounts();
  await ensureLanguageTotals();
});

after(() => {
  db.pragma('foreign_keys = OFF');
  db.prepare("DELETE FROM book_authors WHERE book_id LIKE 'pp%'").run();
  db.prepare("DELETE FROM book_genres WHERE book_id LIKE 'pp%'").run();
  db.prepare("DELETE FROM books WHERE id LIKE 'pp%'").run();
  db.prepare("DELETE FROM book_series WHERE book_id LIKE 'pp%'").run();
  db.prepare("DELETE FROM series_catalog WHERE name = 'zzperf saga'").run();
  db.prepare("DELETE FROM authors WHERE name LIKE 'zzperf,%'").run();
  db.prepare("DELETE FROM genres_catalog WHERE name = 'perf_genre'").run();
  db.prepare("DELETE FROM sources WHERE path = 'perf-paths-path'").run();
  db.pragma('foreign_keys = ON');
  stopQueryWorker();
});

test('the query worker answers SQL and falls back when asked to', async () => {
  const rows = await queryAsync('SELECT COUNT(*) AS c FROM books WHERE id LIKE ?', ['pp%'], { mode: 'get' });
  assert.equal(rows.c, 4);
  const viaFallback = await queryAsync('SELECT * FROM table_that_does_not_exist', [], { fallback: () => 'fallback used' });
  assert.equal(viaFallback, 'fallback used');
});

test('warmBrowseTotal leaves searchCatalog with the exact filtered total', async () => {
  await warmBrowseTotal({ format: 'fb2' });
  const warmed = searchCatalog({ query: '', page: 1, pageSize: 24, sort: 'title', format: 'fb2' }).total;
  const direct = Number(db.prepare("SELECT COUNT(*) AS c FROM active_books WHERE LOWER(ext) = 'fb2'").get().c);
  assert.equal(warmed, direct);
  await warmBrowseTotal({ lang: 'ru', hasSeries: 1 });
  assert.equal(searchCatalog({ query: '', page: 1, pageSize: 24, sort: 'title', lang: 'ru', hasSeries: 1 }).total,
    Number(db.prepare("SELECT COUNT(*) AS c FROM active_books WHERE lang = 'ru' AND EXISTS (SELECT 1 FROM book_series bs WHERE bs.book_id = active_books.id)").get().c));
});

test('genre options for a language scope come from the counters and match the GROUP BY', async () => {
  const fast = listSearchGenres({ langs: ['ru'] });
  const ref = db.prepare(`SELECT g.name AS name, COUNT(DISTINCT bg.book_id) AS bookCount FROM active_books b
    JOIN book_genres bg ON bg.book_id = b.id JOIN genres_catalog g ON g.id = bg.genre_id WHERE b.lang = 'ru' GROUP BY g.id`).all();
  const a = Object.fromEntries(fast.items.map((i) => [i.name, i.bookCount]));
  const b = Object.fromEntries(ref.map((i) => [i.name, i.bookCount]));
  assert.deepEqual(a, b);
  // a non-language filter takes the worker path and still agrees with the sync answer
  const viaWorker = await listSearchGenresAsync({ format: 'fb2' });
  const sync = listSearchGenres({ format: 'fb2' });
  assert.deepEqual(viaWorker, sync);
});

test('language list and language facet use the per-language counters', () => {
  const list = listLanguages({ page: 1, pageSize: 50, sort: 'count' });
  const ref = db.prepare("SELECT CASE WHEN NULLIF(lang, '') IS NULL THEN 'unknown' ELSE lang END AS name, COUNT(*) AS c FROM active_books GROUP BY 1").all();
  const got = Object.fromEntries(list.items.map((i) => [i.name, i.bookCount]));
  for (const row of ref) assert.equal(got[row.name], row.c, row.name);
  const facet = getBooksByFacet({ facet: 'languages', value: 'ru', sort: 'title', page: 1, pageSize: 24 });
  assert.equal(facet.total, ref.find((r) => r.name === 'ru').c);
  assert.ok(facet.items.every((b) => b.lang === 'ru'));
  const unknown = getBooksByFacet({ facet: 'languages', value: 'unknown', sort: 'title', page: 1, pageSize: 24 });
  assert.equal(unknown.total, ref.find((r) => r.name === 'unknown').c);
});

test('authors by language: counters and worker agree with the GROUP BY', async () => {
  const sync = listAuthorsByLanguage({ lang: 'ru', page: 1, pageSize: 50, sort: 'count' });
  const ref = db.prepare(`SELECT a.name AS name, COUNT(DISTINCT b.id) AS bookCount FROM active_books b JOIN book_authors ba ON ba.book_id = b.id
    JOIN authors a ON a.id = ba.author_id WHERE b.lang = 'ru' GROUP BY a.id`).all();
  assert.equal(sync.total, ref.length);
  const mine = sync.items.find((i) => i.name === 'zzperf,alpha');
  assert.equal(mine.bookCount, 2);
  const viaWorker = await listEntitiesByLanguageAsync('authors', { lang: 'ru', page: 1, pageSize: 50, sort: 'count' });
  assert.deepEqual(viaWorker, sync);
  const genreSync = listAuthorsByGenre({ genre: 'perf_genre', page: 1, pageSize: 50, sort: 'count' });
  const genreWorker = await listEntitiesByGenreAsync('authors', { genre: 'perf_genre', page: 1, pageSize: 50, sort: 'count' });
  assert.deepEqual(genreWorker, genreSync);
});

test('OPDS author prefixes come from the catalog counters', () => {
  const rows = opdsQuery('authors', 'zzperf', 0, '');
  assert.ok(rows.length >= 1);
  const names = rows.map((r) => r.name || r.id);
  assert.ok(names.some((n) => String(n).startsWith('zzperf')), JSON.stringify(rows));
});

test('collections count found books with EXISTS instead of a LEFT JOIN on the catalog view', () => {
  const all = listCollections({});
  for (const c of all) {
    const found = Number(db.prepare(`SELECT COUNT(*) AS c FROM collection_items ci JOIN active_books ab ON ab.id = ci.book_id WHERE ci.collection_id = ?`).get(c.id).c);
    assert.equal(c.found, found, c.slug);
  }
});

test('getStaleOrScheduleAsync: a cold miss waits once, a hit is instant, a stale value is served while refreshing', async () => {
  let runs = 0;
  const compute = async () => { runs += 1; return { n: runs }; };
  const first = await getStaleOrScheduleAsync('perf:test:key', compute, 60_000);
  assert.deepEqual(first, { n: 1 });
  assert.deepEqual(await getStaleOrScheduleAsync('perf:test:key', compute, 60_000), { n: 1 });
  assert.equal(runs, 1);
  const stale = await getStaleOrScheduleAsync('perf:test:key', compute, 0);
  assert.deepEqual(stale, { n: 1 }, 'stale value returned at once');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(runs >= 2, 'refreshed in the background');
});
