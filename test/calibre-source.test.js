import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDb, db, addSource, getSourceById, updateSource, stashUserDataRefsForSource, reattachDetachedUserData
} from '../src/db.js';
import { indexCalibre } from '../src/calibre-indexer.js';
import {
  calibreAuthorToInpx, calibreLangToIso1, formatCalibreSeriesIndex, calibreDateOnly, calibreYear,
  pickCalibrePrimaryFormat, makeCalibreBookId, probeCalibreLibrary, forgetCalibreSource
} from '../src/calibre.js';
import { getOrExtractBookDetails, readBookBuffer, getBookPublishInfo } from '../src/fb2.js';
import { getBookById } from '../src/inpx.js';
import { isRelevantCalibreWatchName } from '../src/services/folder-watch-worker.js';
import { createCalibreLibrary, TINY_JPEG } from './calibre-fixture.js';

initDb();

const USER = 'calibre-reader';

function bookRow(sourceId, uuid) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(makeCalibreBookId(sourceId, uuid));
}

function count(table, bookId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE book_id = ?`).get(bookId).c;
}

async function withLibrary(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const lib = createCalibreLibrary(dir);
  const sourceIds = [];
  try {
    await fn(lib, (opts = {}) => {
      const source = addSource({ name: `Calibre ${prefix}`, type: 'calibre', path: dir, ...opts });
      sourceIds.push(source.id);
      return source;
    });
  } finally {
    lib.close();
    for (const id of sourceIds) {
      db.prepare('DELETE FROM book_details_cache WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(id);
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM books WHERE source_id = ?').run(id);
      db.pragma('foreign_keys = ON');
      db.prepare('DELETE FROM calibre_book_state WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      forgetCalibreSource(id);
    }
    for (const t of ['read_books', 'reading_positions']) db.prepare(`DELETE FROM ${t} WHERE username = ?`).run(USER);
    db.prepare('DELETE FROM detached_book_refs').run();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Источник перечитывается из БД перед проходом — как indexSingleSource (lastIndexedAt, режим тегов). */
const reindex = (source, incremental) => indexCalibre(getSourceById(source.id), { incremental });

test('Calibre field helpers', () => {
  assert.equal(calibreAuthorToInpx('Isaac Asimov', 'Asimov, Isaac'), 'Asimov,Isaac');
  assert.equal(calibreAuthorToInpx('J. R. R. Tolkien', 'Tolkien, J. R. R.'), 'Tolkien,J. R. R.');
  assert.equal(calibreAuthorToInpx('Plato', 'Plato'), 'Plato');
  assert.equal(calibreAuthorToInpx('Smith| John', ''), 'Smith John');
  assert.equal(calibreLangToIso1('eng'), 'en');
  assert.equal(calibreLangToIso1('RUS'), 'ru');
  assert.equal(calibreLangToIso1('ger'), 'de');
  assert.equal(calibreLangToIso1('und'), '');
  assert.equal(calibreLangToIso1('xyz'), 'xyz');
  assert.equal(formatCalibreSeriesIndex(1), '1');
  assert.equal(formatCalibreSeriesIndex(2.5), '2.5');
  assert.equal(formatCalibreSeriesIndex(0), '');
  assert.equal(calibreDateOnly('2023-05-04 10:00:00+00:00'), '2023-05-04');
  assert.equal(calibreDateOnly('0101-01-01 00:00:00+00:00'), '');
  assert.equal(calibreYear('1951-06-01 00:00:00+00:00'), 1951);
  assert.equal(calibreYear('0101-01-01 00:00:00+00:00'), null);
  assert.deepEqual(pickCalibrePrimaryFormat([{ format: 'PDF', name: 'a', size: 1 }, { format: 'MOBI', name: 'a', size: 2 }, { format: 'EPUB', name: 'a', size: 3 }]), { ext: 'epub', name: 'a', size: 3 });
  assert.equal(pickCalibrePrimaryFormat([{ format: 'PDF', name: 'a', size: 1 }]), null);
  assert.equal(isRelevantCalibreWatchName('metadata.db'), true);
  assert.equal(isRelevantCalibreWatchName('metadata.db-journal'), true);
  assert.equal(isRelevantCalibreWatchName('Asimov/Foundation (1)/cover.jpg'), false);
});

test('full index reads metadata.db: fields, primary format, details, cover, file path', () => withLibrary('calibre-full-', async (lib, add) => {
  const foundation = lib.addBook({
    title: 'Foundation', authors: [['Isaac Asimov', 'Asimov, Isaac']], series: 'Foundation', seriesIndex: 1,
    tags: ['Science Fiction', 'Classics'], rating: 8, publisher: 'Gnome Press', lang: 'eng',
    comments: '<p>The <b>first</b> book.</p>', isbn: '978-0-553-29335-7', pubdate: '1951-06-01 00:00:00+00:00',
    formats: [{ format: 'PDF' }, { format: 'MOBI' }, { format: 'EPUB' }], cover: TINY_JPEG
  });
  const pdfOnly = lib.addBook({ title: 'Scanned', authors: [['Anon', 'Anon']], formats: [{ format: 'PDF' }] });
  const half = lib.addBook({ title: 'Robots', authors: [['Isaac Asimov', 'Asimov, Isaac']], series: 'Robot', seriesIndex: 2.5, formats: [{ format: 'AZW3' }] });

  assert.deepEqual(probeCalibreLibrary(lib.dir), { books: 3 });
  const source = add();
  const result = await reindex(source, false);
  assert.equal(result.imported, 2);

  const row = bookRow(source.id, foundation.uuid);
  assert.ok(row, 'book id = sha256(source:calibre:uuid)');
  assert.equal(row.title, 'Foundation');
  assert.equal(row.authors, 'Asimov,Isaac');
  assert.equal(row.series, 'Foundation');
  assert.equal(row.series_no, '1');
  assert.equal(row.genres, 'Classics:Science Fiction', 'tags sorted by name, as Calibre shows them');
  assert.equal(row.lang, 'en');
  assert.equal(row.lib_rate, 4);
  assert.equal(row.lib_id, `calibre:${foundation.uuid}`);
  assert.equal(row.ext, 'epub', 'EPUB wins over MOBI and PDF');
  assert.equal(row.file_name, `${foundation.path}/${foundation.name}`);
  assert.equal(row.archive_name, '');
  assert.match(row.keywords, /Gnome Press/);
  assert.equal(bookRow(source.id, pdfOnly.uuid), undefined, 'PDF-only books wait for the formats phase');
  assert.equal(bookRow(source.id, half.uuid).series_no, '2.5');
  assert.equal(bookRow(source.id, half.uuid).ext, 'azw3');

  const authorNames = db.prepare(`
    SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = ?
  `).all(row.id).map((r) => r.name);
  assert.deepEqual(authorNames, ['asimov,isaac']);
  const genreNames = db.prepare(`
    SELECT g.name FROM book_genres bg JOIN genres_catalog g ON g.id = bg.genre_id WHERE bg.book_id = ? ORDER BY g.name
  `).all(row.id).map((r) => r.name);
  assert.deepEqual(genreNames, ['classics', 'science fiction']);

  const book = getBookById(row.id);
  const details = await getOrExtractBookDetails(book);
  assert.equal(details.annotation, '<p>The <b>first</b> book.</p>');
  assert.equal(details.annotationIsHtml, true);
  assert.equal(details.publishYear, 1951);
  assert.equal(details.isbn, '9780553293357');
  assert.ok(details.cover?.data?.equals(TINY_JPEG), 'cover.jpg next to the files');
  assert.deepEqual(await getBookPublishInfo(book), { publishYear: 1951, isbn: '9780553293357' });
  const buf = await readBookBuffer(book);
  assert.equal(buf.toString(), 'EPUB of Foundation', 'downloads/reader read the primary file');
}));

test('incremental: unchanged db is skipped; rename keeps id and user data; delete and add are picked up', () => withLibrary('calibre-inc-', async (lib, add) => {
  const a = lib.addBook({ title: 'Solaris', authors: [['Stanisław Lem', 'Lem, Stanisław']], formats: [{ format: 'EPUB', content: Buffer.from('x'.repeat(111)) }] });
  const b = lib.addBook({ title: 'Eden', authors: [['Stanisław Lem', 'Lem, Stanisław']], formats: [{ format: 'EPUB', content: Buffer.from('y'.repeat(222)) }] });
  const source = add();
  await reindex(source, false);
  const idA = makeCalibreBookId(source.id, a.uuid);
  const idB = makeCalibreBookId(source.id, b.uuid);
  db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run(USER, idA);
  db.prepare('INSERT INTO reading_positions(username, book_id, position, progress) VALUES(?, ?, ?, ?)').run(USER, idB, 'p', 40);

  const skipped = await reindex(source, true);
  assert.equal(skipped.processed, 0, 'unchanged metadata.db → nothing read');

  lib.renameBook(a.id, 'Solaris (2nd ed)');
  lib.removeBook(b.id);
  const c = lib.addBook({ title: 'Fiasco', authors: [['Stanisław Lem', 'Lem, Stanisław']], formats: [{ format: 'FB2' }] });
  const pass = await reindex(source, true);
  assert.equal(pass.processed, 2, 'only the renamed and the new book are read');

  const renamed = db.prepare('SELECT * FROM books WHERE id = ?').get(idA);
  assert.equal(renamed.title, 'Solaris (2nd ed)', 'same id after Calibre renamed the folder and files');
  assert.equal(renamed.file_name, `Stanisław Lem/Solaris (2nd ed) (${a.id})/Solaris (2nd ed) - Stanisław Lem`);
  assert.equal(count('read_books', idA), 1, 'read mark stays on the renamed book');
  assert.equal(db.prepare('SELECT 1 FROM books WHERE id = ?').get(idB), undefined, 'deleted in Calibre');
  assert.equal(count('reading_positions', idB), 1, 'user data of a deleted book waits (delayed purge)');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM detached_book_refs WHERE old_book_id = ? AND source_id = ?').get(idB, source.id).c, 1);
  assert.ok(bookRow(source.id, c.uuid), 'new book added');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM calibre_book_state WHERE source_id = ?').get(source.id).c, 2);
}));

test('tags mode keywords: tags are searchable but not genres; changing the mode re-reads every book', () => withLibrary('calibre-tags-', async (lib, add) => {
  const a = lib.addBook({ title: 'Dune', authors: [['Frank Herbert', 'Herbert, Frank']], tags: ['To Read', 'kobo'] });
  const source = add({ calibreTags: 'keywords' });
  await reindex(source, false);
  let row = bookRow(source.id, a.uuid);
  assert.equal(row.genres, '');
  assert.match(row.keywords, /kobo To Read/);
  assert.equal(count('book_genres', row.id), 0);

  updateSource(source.id, { calibreTags: 'genres' });
  const pass = await reindex(source, true);
  assert.equal(pass.processed, 1, 'state cleared → book re-read although metadata.db is unchanged');
  row = bookRow(source.id, a.uuid);
  assert.equal(row.genres, 'kobo:To Read');
}));

test('full reindex and source re-add keep user data (calibre: lib_id rule)', () => withLibrary('calibre-readd-', async (lib, add) => {
  const a = lib.addBook({ title: 'Ubik', authors: [['Philip K. Dick', 'Dick, Philip K.']] });
  const first = add();
  await reindex(first, false);
  const oldId = makeCalibreBookId(first.id, a.uuid);
  db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run(USER, oldId);

  await reindex(first, false);
  assert.equal(count('read_books', oldId), 1, 'full reindex: same id, data kept');

  // Удаление источника (как deleteSourceProgressive), затем Calibre переименовал книгу, источник добавлен заново.
  stashUserDataRefsForSource(first.id);
  db.pragma('foreign_keys = OFF');
  db.prepare('DELETE FROM books WHERE source_id = ?').run(first.id);
  db.pragma('foreign_keys = ON');
  db.prepare('DELETE FROM calibre_book_state WHERE source_id = ?').run(first.id);
  db.prepare('DELETE FROM sources WHERE id = ?').run(first.id);
  forgetCalibreSource(first.id);
  lib.renameBook(a.id, 'Ubik (Gollancz)');

  const second = add();
  await reindex(second, false);
  const newId = makeCalibreBookId(second.id, a.uuid);
  assert.notEqual(newId, oldId);
  assert.equal(count('read_books', newId), 1, 'matched by calibre:<uuid> although path changed');
  assert.equal(reattachDetachedUserData(second.id), 0);
}));

test('missing metadata.db or an emptied library aborts without touching books', () => withLibrary('calibre-safety-', async (lib, add) => {
  const a = lib.addBook({ title: 'Kindred', authors: [['Octavia E. Butler', 'Butler, Octavia E.']] });
  const source = add();
  await reindex(source, false);
  lib.removeBook(a.id);
  await assert.rejects(reindex(source, true), /пуста/);
  assert.ok(bookRow(source.id, a.uuid), 'book kept');

  const moved = getSourceById(source.id);
  await assert.rejects(indexCalibre({ ...moved, path: path.join(lib.dir, 'missing') }, { incremental: true }), /metadata\.db/);
  assert.ok(bookRow(source.id, a.uuid), 'book kept');
}));
