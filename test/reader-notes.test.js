import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import express from 'express';
import { registerNotesRoutes } from '../src/routes/notes.js';
import {
  createUser, initDb, db, addReaderAnnotation, updateReaderAnnotation,
  queryReaderAnnotations, getReaderAnnotationFacets,
  deleteReaderAnnotationsBulk, setReaderAnnotationsColorBulk
} from '../src/db.js';
import { parseLine, enrichBookRow } from '../src/inpx.js';
import { buildNotesExport, parseNotesFilter } from '../src/services/reader-notes.js';
import { encodeBookRef } from '../src/utils/book-ref.js';
import { renderReaderNotesPage } from '../src/templates/library.js';

const SEP = String.fromCharCode(4);
const USER = 'notes_user';
const OTHER = 'notes_other';
const stats = { totalBooks: 2, totalAuthors: 1, totalSeries: 0, totalGenres: 1, totalLanguages: 1 };

function insertBook(libId, title) {
  const line = ['Ntauthor,Name', 'nt-genre', title, '', '', libId, '100', libId, '0', 'fb2', '', 'ru', '0', ''].join(SEP);
  const row = enrichBookRow(parseLine(line, 'notes-test.zip'));
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

let bookA;
let bookB;
const noteIds = {};

function annotationRev(bookId) {
  return db.prepare('SELECT annotations_rev AS rev FROM reader_book_revisions WHERE username = ? AND book_id = ?').get(USER, bookId)?.rev;
}

before(() => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-notes-'));
  initDb();
  for (const username of [USER, OTHER]) {
    db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?, ?, ?)').run(username, 'x', 'user');
  }
  bookA = insertBook('nt401', 'Alpha Book');
  bookB = insertBook('nt402', 'Beta Book');
  noteIds.a1 = addReaderAnnotation(USER, bookA, 'cfi-a1', 'First quote', 'Привет мир', 'yellow');
  noteIds.a2 = addReaderAnnotation(USER, bookA, 'cfi-a2', 'Second <b>quote</b>', '', 'green');
  noteIds.b1 = addReaderAnnotation(USER, bookB, 'cfi-b1', 'Beta quote', 'beta note', 'yellow');
  noteIds.o1 = addReaderAnnotation(OTHER, bookA, 'cfi-o1', 'Other user quote', '', 'pink');
  db.prepare('UPDATE reader_annotations SET created_at = ? WHERE id = ?').run('2026-01-01 10:00:00', noteIds.a1);
  db.prepare('UPDATE reader_annotations SET created_at = ? WHERE id = ?').run('2026-01-02 10:00:00', noteIds.a2);
  db.prepare('UPDATE reader_annotations SET created_at = ? WHERE id = ?').run('2026-01-03 10:00:00', noteIds.b1);
});

test('query filters by color, book and text (Unicode case-insensitive) for one user only', () => {
  assert.equal(queryReaderAnnotations(USER).total, 3);
  assert.deepEqual(queryReaderAnnotations(USER, { color: 'yellow' }).items.map((i) => i.id).sort(), [noteIds.a1, noteIds.b1].sort());
  assert.equal(queryReaderAnnotations(USER, { bookId: bookB }).total, 1);
  assert.equal(queryReaderAnnotations(USER, { q: 'ПРИВЕТ' }).items[0].id, noteIds.a1);
  assert.equal(queryReaderAnnotations(USER, { q: 'beta book' }).total, 1, 'matches book title');
  assert.equal(queryReaderAnnotations(USER, { q: '%' }).total, 0, 'LIKE wildcards are escaped');
  assert.equal(queryReaderAnnotations(USER, { ids: [noteIds.o1] }).total, 0, 'foreign ids are invisible');
  assert.equal(queryReaderAnnotations(USER, { ids: [] }).total, 0);
});

test('query sorting and grouping keep books and colors contiguous', () => {
  const newest = queryReaderAnnotations(USER, { sort: 'new' }).items.map((i) => i.id);
  assert.deepEqual(newest, [noteIds.b1, noteIds.a2, noteIds.a1], 'book with newest note first, newest first inside');
  const oldest = queryReaderAnnotations(USER, { sort: 'old' }).items.map((i) => i.id);
  assert.deepEqual(oldest, [noteIds.a1, noteIds.a2, noteIds.b1]);
  const byTitle = queryReaderAnnotations(USER, { sort: 'title' }).items.map((i) => i.id);
  assert.deepEqual(byTitle, [noteIds.a1, noteIds.a2, noteIds.b1]);
  const byColor = queryReaderAnnotations(USER, { group: 'color' }).items.map((i) => i.color);
  assert.deepEqual(byColor, ['yellow', 'yellow', 'green']);
  const paged = queryReaderAnnotations(USER, { page: 2, pageSize: 2 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, 3);
});

test('facets report color counts for the book/text scope and the books list', () => {
  const facets = getReaderAnnotationFacets(USER);
  assert.equal(facets.colorCounts.all, 3);
  assert.equal(facets.colorCounts.yellow, 2);
  assert.equal(facets.colorCounts.green, 1);
  assert.equal(facets.colorCounts.pink, 0);
  assert.deepEqual(facets.books.map((b) => [b.title, b.n]), [['Alpha Book', 2], ['Beta Book', 1]]);
  assert.equal(getReaderAnnotationFacets(USER, { bookId: bookA }).colorCounts.yellow, 1);
});

test('editing an annotation bumps the sync revision', () => {
  const before = annotationRev(bookB);
  updateReaderAnnotation(noteIds.b1, USER, { note: 'edited' });
  const after = annotationRev(bookB);
  assert.ok(after && after !== before, 'annotations_rev should change after PATCH');
  assert.equal(queryReaderAnnotations(USER, { ids: [noteIds.b1] }).items[0].note, 'edited');
});

test('bulk recolor and delete only touch own notes', () => {
  assert.equal(setReaderAnnotationsColorBulk(USER, [noteIds.a1, noteIds.o1], 'blue'), 1);
  assert.equal(setReaderAnnotationsColorBulk(USER, [noteIds.a1], 'nope'), 0);
  assert.equal(queryReaderAnnotations(USER, { color: 'blue' }).total, 1);
  assert.equal(queryReaderAnnotations(OTHER, { color: 'pink' }).total, 1);
  assert.equal(deleteReaderAnnotationsBulk(USER, [noteIds.a1, noteIds.o1, 'x', -1]), 1);
  assert.equal(queryReaderAnnotations(USER).total, 2);
  assert.equal(queryReaderAnnotations(OTHER).total, 1);
});

test('parseNotesFilter normalizes input and decodes the book ref', () => {
  const f = parseNotesFilter({ color: 'red', sort: 'x', group: 'color', q: '  hi  ', book: encodeBookRef('id\u0000x') });
  assert.deepEqual(f, { color: '', bookId: 'id\u0000x', q: 'hi', sort: 'new', group: 'color' });
  assert.equal(parseNotesFilter({ color: 'pink', bookId: 'raw' }).bookId, 'raw');
});

test('export builds Markdown and escaped HTML grouped by book or color', () => {
  const items = queryReaderAnnotations(USER, { sort: 'title' }).items;
  const md = buildNotesExport(items, { format: 'md', now: new Date('2026-02-03T00:00:00Z') });
  assert.equal(md.fileName, 'notes-2026-02-03.md');
  assert.match(md.mimeType, /markdown/);
  assert.ok(md.content.includes('## Alpha Book'));
  assert.ok(md.content.includes('> Second <b>quote</b>'));
  assert.ok(md.content.includes('beta') || md.content.includes('edited'));

  const html = buildNotesExport(items, { format: 'html', group: 'color' });
  assert.match(html.fileName, /\.html$/);
  assert.ok(html.content.includes('Second &lt;b&gt;quote&lt;/b&gt;'), 'HTML is escaped');
  assert.ok(!html.content.includes('<b>quote</b>'));
  assert.ok(html.content.includes('<h2>Yellow</h2>') || html.content.includes('<h2>Green</h2>'));
});

test('notes page renders filters, color chips with counts, cards and escapes the query', () => {
  const result = queryReaderAnnotations(USER, {});
  const html = renderReaderNotesPage({
    items: result.items, total: result.total, page: 1, pageSize: 50,
    filter: { color: 'yellow', bookId: '', q: '"><x', sort: 'new', group: 'book' },
    facets: getReaderAnnotationFacets(USER),
    user: { username: USER, role: 'user' }, stats, indexStatus: {}
  });
  assert.ok(html.includes('data-notes-page'));
  assert.ok(html.includes('data-note-select'));
  assert.ok(html.includes('data-notes-export="md"'));
  assert.ok(html.includes('data-notes-send="html"'));
  assert.ok(html.includes('notes-chip is-active'));
  assert.ok(html.includes('value="&quot;&gt;&lt;x"'), 'search query is escaped');
  assert.ok(!html.includes('"><x'));
  assert.ok(html.includes(`value="${encodeBookRef(bookA)}"`), 'book select uses base64 refs');

  const hidden = renderReaderNotesPage({
    items: [], total: 0, page: 1, pageSize: 50, filter: {}, facets: null,
    user: { username: USER, role: 'user', ereaderEmailAllowed: false }, stats, indexStatus: {}
  });
  assert.ok(!hidden.includes('data-notes-send'), 'send menu hidden when e-reader email is not allowed');
  assert.ok(!hidden.includes('data-notes-toolbar'), 'toolbar hidden on empty page');
});

const HTTP_USER = 'notes_http_user';
const HTTP_PASSWORD = 'NotesHttpPass1!';
let server;
let baseUrl;
const httpIds = [];

before(async () => {
  createUser({ username: HTTP_USER, password: HTTP_PASSWORD });
  httpIds.push(
    addReaderAnnotation(HTTP_USER, bookA, 'h1', 'Http quote one', 'note one', 'yellow'),
    addReaderAnnotation(HTTP_USER, bookB, 'h2', 'Http quote two', '', 'green')
  );
  const app = express();
  app.use(express.json());
  registerNotesRoutes(app, { batchEmailLocks: new Set() });
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function authHeaders(extra = {}) {
  return { Authorization: `Basic ${Buffer.from(`${HTTP_USER}:${HTTP_PASSWORD}`).toString('base64')}`, ...extra };
}

test('notes API: export honours format, selection and auth', async () => {
  assert.equal((await fetch(`${baseUrl}/api/reader-notes/export`)).status, 401);

  const md = await fetch(`${baseUrl}/api/reader-notes/export?format=md&color=yellow`, { headers: authHeaders() });
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-disposition'), /attachment; filename="notes-\d{4}-\d{2}-\d{2}\.md"/);
  const mdText = await md.text();
  assert.ok(mdText.includes('Http quote one'));
  assert.ok(!mdText.includes('Http quote two'));

  const picked = await fetch(`${baseUrl}/api/reader-notes/export?format=html&ids=${httpIds[1]}`, { headers: authHeaders() });
  const html = await picked.text();
  assert.ok(html.includes('Http quote two') && !html.includes('Http quote one'));

  assert.equal((await fetch(`${baseUrl}/api/reader-notes/export?format=pdf`, { headers: authHeaders() })).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/reader-notes/export?format=md&q=zzzz-nothing`, { headers: authHeaders() })).status, 404);
});

test('notes API: bulk recolor, validation and delete', async () => {
  const post = (body) => fetch(`${baseUrl}/api/reader-notes/bulk`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body)
  });
  assert.equal((await post({ action: 'delete', ids: [] })).status, 400);
  assert.equal((await post({ action: 'explode', ids: [1] })).status, 400);
  assert.equal((await post({ action: 'color', color: 'red', ids: httpIds })).status, 400);

  const recolor = await post({ action: 'color', color: 'blue', ids: httpIds });
  assert.deepEqual(await recolor.json(), { ok: true, updated: 2 });
  assert.equal(queryReaderAnnotations(HTTP_USER, { color: 'blue' }).total, 2);

  const del = await post({ action: 'delete', ids: [httpIds[0]] });
  assert.deepEqual(await del.json(), { ok: true, deleted: 1 });
  assert.equal(queryReaderAnnotations(HTTP_USER).total, 1);
});

test('notes API: send requires an e-reader email', async () => {
  const res = await fetch(`${baseUrl}/api/reader-notes/send`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ format: 'html' })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'EREADER_EMAIL_MISSING');
  const bad = await fetch(`${baseUrl}/api/reader-notes/send`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ format: 'pdf' })
  });
  assert.equal(bad.status, 400);
});
