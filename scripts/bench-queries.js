#!/usr/bin/env node
/**
 * DB-level benchmark on a synthetic library in a throw-away DATA_DIR (never touches data/library.db).
 *
 * Usage: node scripts/bench-queries.js [--books=300000] [--authorPool=150000] [--only=overview] [--keep]
 * Prints cold / warm timings of the hot read paths so slow spots can be ranked before optimizing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const BOOKS = Math.max(1000, Number(args.books || 300_000));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-bench-'));
process.env.DATA_DIR = dataDir;
process.env.INPX_TEST_RUN = '1';
process.env.PORT = '0';

const { initDb, db, rebuildBooksFtsFromContent, ensureActiveBooksProjection, ensureSchemaIndexes } = await import('../src/db.js');
const inpx = await import('../src/inpx.js');

initDb();
const AUTHORS = Math.max(Math.floor(BOOKS / 4), Number(args.authorPool || 0) || 0);
const SERIES = Math.floor(BOOKS / 12);
const t0 = Date.now();
console.log(`[bench] generating ${BOOKS} books / ${AUTHORS} authors / ${SERIES} series in ${dataDir}`);

db.exec(`
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${AUTHORS})
  INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
  SELECT 'Фамилия' || i || ' Имя' || (i % 300), 'Фамилия' || i || ' Имя' || (i % 300),
         lower('Фамилия' || i || ' Имя' || (i % 300)), lower('Фамилия' || i || ' Имя' || (i % 300)), 0 FROM n;
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SERIES})
  INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count)
  SELECT 'Серия ' || i, 'Серия ' || i, lower('Серия ' || i), lower('Серия ' || i), 0 FROM n;
  WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${BOOKS})
  INSERT INTO books (id, title, authors, genres, series, series_no, title_sort, author_sort, series_sort, series_index,
                     title_search, authors_search, series_search, genres_search, keywords_search, file_name, archive_name,
                     size, lib_id, deleted, ext, date, lang, keywords, lib_rate, source_id, imported_at)
  SELECT 'bench-' || i, 'Книга номер ' || i, 'Фамилия' || ((i % ${AUTHORS}) + 1) || ' Имя' || (((i % ${AUTHORS}) + 1) % 300), 'sf',
         CASE WHEN i % 3 = 0 THEN 'Серия ' || ((i % ${SERIES}) + 1) ELSE '' END, '', lower('Книга номер ' || i), 'a', '', 0,
         lower('Книга номер ' || i), lower('Фамилия' || ((i % ${AUTHORS}) + 1)), '', 'sf', '', 'bench-' || i || '.fb2', 'a' || (i % 50) || '.zip',
         1, CAST(i AS TEXT), 0, 'fb2', '2024-01-' || printf('%02d', (i % 28) + 1), CASE WHEN i % 5 = 0 THEN 'en' ELSE 'ru' END, '', 0, NULL, i FROM n;
`);
const step = (label, sql) => {
  const s = Date.now();
  db.exec(sql);
  console.log(`[bench]   ${label}: ${((Date.now() - s) / 1000).toFixed(1)} s`);
};
step('book_authors', `INSERT INTO book_authors (book_id, author_id)
  SELECT b.id, a.id FROM books b JOIN authors a ON a.name = b.authors WHERE b.id LIKE 'bench-%'`);
step('book_series', `INSERT INTO book_series (book_id, series_id)
  SELECT b.id, s.id FROM books b JOIN series_catalog s ON s.name = b.series WHERE b.series != ''`);
step('authors.book_count', `UPDATE authors SET book_count = x.c
  FROM (SELECT author_id, COUNT(*) AS c FROM book_authors GROUP BY author_id) x WHERE authors.id = x.author_id`);
step('authors.book_count leftover', `UPDATE authors SET book_count = 1 WHERE book_count = 0`);
step('series.book_count', `UPDATE series_catalog SET book_count = x.c
  FROM (SELECT series_id, COUNT(*) AS c FROM book_series GROUP BY series_id) x WHERE series_catalog.id = x.series_id`);
{
  const s = Date.now();
  await rebuildBooksFtsFromContent();
  console.log(`[bench]   fts: ${((Date.now() - s) / 1000).toFixed(1)} s`);
}
await ensureActiveBooksProjection();
{
  const s = Date.now();
  ensureSchemaIndexes({ sync: true });
  console.log(`[bench]   indexes: ${((Date.now() - s) / 1000).toFixed(1)} s`);
}
{
  const s = Date.now();
  db.exec('ANALYZE');
  console.log(`[bench]   analyze: ${((Date.now() - s) / 1000).toFixed(1)} s`);
}
console.log(`[bench] ready in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);

const CASES = [
  ['catalog browse page 1', () => inpx.searchCatalog({ query: '', field: 'books', page: 1, pageSize: 24 })],
  ['catalog browse page 500', () => inpx.searchCatalog({ query: '', field: 'books', page: 500, pageSize: 24 })],
  ['catalog browse lang=ru', () => inpx.searchCatalog({ query: '', field: 'books', page: 1, pageSize: 24, lang: 'ru' })],
  ['search books "книга номер 12"', () => inpx.searchCatalog({ query: 'книга номер 12', field: 'books', page: 1, pageSize: 24 })],
  ['overview 1 word "фамилия12"', () => inpx.searchOverview({ query: 'фамилия12' })],
  ['overview 2 words "фамилия12 имя12"', () => inpx.searchOverview({ query: 'фамилия12 имя12' })],
  ['overview 2 words reversed "имя5 фамилия500"', () => inpx.searchOverview({ query: 'имя5 фамилия500' })],
  ['authors list page 1', () => inpx.listAuthors({ page: 1, pageSize: 50 })],
  ['authors by prefix "фамилия1"', () => inpx.listAuthors({ page: 1, pageSize: 50, query: 'фамилия1' })],
  ['series list page 1', () => inpx.listSeries({ page: 1, pageSize: 50 })],
  ['library recent (home pool)', () => inpx.getLibrarySections()]
];

const RUNS = 5;
const rows = [];
const ONLY = args.only ? String(args.only) : '';
for (const [name, fn] of CASES) {
  if (ONLY && !name.includes(ONLY)) continue;
  const times = [];
  let error = '';
  console.log(`[bench] running: ${name}`);
  for (let i = 0; i < RUNS; i += 1) {
    const s = process.hrtime.bigint();
    try { fn(); } catch (err) { error = err.message; break; }
    times.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  rows.push({
    case: name,
    'cold ms': times.length ? times[0].toFixed(1) : '-',
    'warm min ms': times.length > 1 ? Math.min(...times.slice(1)).toFixed(1) : '-',
    note: error
  });
}
console.table(rows);

try { db.close(); } catch { /* connection already closed */ }
if (!args.keep) {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may keep the file locked briefly */ }
}
process.exit(0);
