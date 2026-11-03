import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, db, addSource, getSourceById, convertFolderSourceToCalibre, getMeta } from '../src/db.js';
import { indexCalibre } from '../src/calibre-indexer.js';
import { indexFolder } from '../src/folder-indexer.js';
import { makeCalibreBookId, forgetCalibreSource } from '../src/calibre.js';
import { getAvailableDownloadFormats, resetBookFilesProbe } from '../src/download-formats.js';
import { resolveDownload } from '../src/conversion.js';
import { getBookById } from '../src/inpx.js';
import { renderOpdsBookDetail } from '../src/templates/opds.js';
import { renderOpds2BookDetail } from '../src/templates/opds-v2.js';
import { createCalibreLibrary } from './calibre-fixture.js';

initDb();

const USER = 'calibre-formats-reader';

async function withLibrary(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const lib = createCalibreLibrary(dir);
  try {
    await fn(lib);
  } finally {
    lib.close();
    for (const { id } of db.prepare('SELECT id FROM sources WHERE path = ?').all(dir)) {
      db.prepare('DELETE FROM book_files WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(id);
      db.pragma('foreign_keys = OFF');
      db.prepare('DELETE FROM books WHERE source_id = ?').run(id);
      db.pragma('foreign_keys = ON');
      db.prepare('DELETE FROM calibre_book_state WHERE source_id = ?').run(id);
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      forgetCalibreSource(id);
    }
    for (const t of ['read_books', 'reading_positions', 'bookmarks', 'book_ratings']) {
      db.prepare(`DELETE FROM ${t} WHERE username = ?`).run(USER);
    }
    db.prepare('DELETE FROM detached_book_refs').run();
    resetBookFilesProbe();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const reindex = (source, incremental) => indexCalibre(getSourceById(source.id), { incremental });

test('every format of a Calibre book: book_files, download formats, stored downloads, OPDS links', () => withLibrary('calibre-formats-', async (lib) => {
  const multi = lib.addBook({
    title: 'Neuromancer', authors: [['William Gibson', 'Gibson, William']],
    formats: [{ format: 'EPUB' }, { format: 'AZW3' }, { format: 'PDF' }, { format: 'FB2' }]
  });
  const single = lib.addBook({ title: 'Count Zero', authors: [['William Gibson', 'Gibson, William']] });
  const source = addSource({ name: 'Formats', type: 'calibre', path: lib.dir });
  await reindex(source, false);
  resetBookFilesProbe();

  const id = makeCalibreBookId(source.id, multi.uuid);
  const files = db.prepare('SELECT ext, file_name AS fileName FROM book_files WHERE book_id = ? ORDER BY ext').all(id);
  assert.deepEqual(files.map((f) => f.ext), ['azw3', 'fb2', 'pdf'], 'every format except the primary EPUB');
  assert.equal(files[0].fileName, `${multi.path}/${multi.name}`);

  const book = getBookById(id);
  assert.equal(book.ext, 'epub');
  assert.deepEqual(getAvailableDownloadFormats(book), ['epub', 'azw3', 'fb2', 'pdf']);
  assert.deepEqual(getAvailableDownloadFormats(getBookById(makeCalibreBookId(source.id, single.uuid))), ['epub']);

  const pdf = await resolveDownload(book, 'pdf');
  assert.equal(pdf.format, 'pdf');
  assert.equal(pdf.mimeType, 'application/pdf');
  assert.match(pdf.fileName, /\.pdf$/);
  assert.equal(pdf.content.toString(), 'PDF of Neuromancer', 'stored file served as is');
  const azw3 = await resolveDownload(book, 'azw3');
  assert.equal(azw3.content.toString(), 'AZW3 of Neuromancer');
  const fb2 = await resolveDownload(book, 'fb2');
  assert.equal(fb2.content.toString(), 'FB2 of Neuromancer', 'fb2 code = the stored FB2, not a re-read of the EPUB');
  const epub = await resolveDownload(book, 'kfx');
  assert.equal(epub.format, 'epub', 'unknown format falls back to the primary file');

  const xml = renderOpdsBookDetail('http://x', book);
  assert.match(xml, new RegExp(`/download/${id}\\?opds=1&amp;format=pdf" rel="http://opds-spec.org/acquisition" type="application/pdf" title="PDF"`));
  assert.match(xml, /format=azw3" rel="http:\/\/opds-spec.org\/acquisition" type="application\/x-mobipocket-ebook" title="AZW3"/);
  const json = JSON.parse(renderOpds2BookDetail('http://x', book));
  const acq = (json.links || json.publication?.links || []).concat(...(json.publications || []).map((p) => p.links))
    .filter((l) => l.rel === 'http://opds-spec.org/acquisition');
  assert.ok(acq.some((l) => l.href.endsWith('format=pdf') && l.type === 'application/pdf'), JSON.stringify(acq));

  // Формат удалён в Calibre → строка book_files пропадает при инкрементальном проходе.
  lib.db.prepare("DELETE FROM data WHERE book = ? AND format = 'PDF'").run(multi.id);
  lib.bump();
  await reindex(source, true);
  assert.deepEqual(db.prepare('SELECT ext FROM book_files WHERE book_id = ? ORDER BY ext').all(id).map((r) => r.ext), ['azw3', 'fb2']);

  lib.removeBook(multi.id);
  await reindex(source, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM book_files WHERE book_id = ?').get(id).c, 0, 'cleaned with the book');
}));

test('folder source → Calibre library: user data moves to Calibre books by file path', () => withLibrary('calibre-convert-', async (lib) => {
  const a = lib.addBook({ title: 'Foundation', authors: [['Isaac Asimov', 'Asimov, Isaac']], formats: [{ format: 'EPUB' }, { format: 'MOBI' }] });
  const b = lib.addBook({ title: 'Solaris', authors: [['Stanislaw Lem', 'Lem, Stanislaw']], formats: [{ format: 'FB2' }] });
  const folder = addSource({ name: 'Was a folder', type: 'folder', path: lib.dir, fastScan: true });
  await indexFolder(folder, { incremental: false });
  const folderId = (rel) => db.prepare('SELECT id FROM books WHERE source_id = ? AND file_name = ?').get(folder.id, rel)?.id;
  const oldEpub = db.prepare("SELECT id FROM books WHERE source_id = ? AND file_name = ? AND ext = 'epub'").get(folder.id, `${a.path}/${a.name}`).id;
  const oldMobi = db.prepare("SELECT id FROM books WHERE source_id = ? AND file_name = ? AND ext = 'mobi'").get(folder.id, `${a.path}/${a.name}`).id;
  const oldFb2 = folderId(`${b.path}/${b.name}`);
  assert.ok(oldEpub && oldMobi && oldFb2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM books WHERE source_id = ?').get(folder.id).c, 3, 'folder: one book per file');

  db.prepare('INSERT INTO reading_positions(username, book_id, position, progress) VALUES(?, ?, ?, ?)').run(USER, oldEpub, 'epub-pos', 30);
  db.prepare('INSERT INTO reading_positions(username, book_id, position, progress) VALUES(?, ?, ?, ?)').run(USER, oldMobi, 'mobi-pos', 70);
  db.prepare('INSERT INTO bookmarks(username, book_id) VALUES(?, ?)').run(USER, oldMobi);
  db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run(USER, oldFb2);

  const converted = convertFolderSourceToCalibre(folder.id);
  assert.equal(converted.type, 'calibre');
  assert.equal(getMeta(`calibre_convert_${folder.id}`), '1');
  await indexCalibre(getSourceById(folder.id), { incremental: true }); // the marker forces a full pass

  const newA = makeCalibreBookId(folder.id, a.uuid);
  const newB = makeCalibreBookId(folder.id, b.uuid);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM books WHERE source_id = ?').get(folder.id).c, 2, 'one book per Calibre book');
  assert.equal(db.prepare('SELECT position FROM reading_positions WHERE username = ? AND book_id = ?').get(USER, newA)?.position, 'epub-pos',
    'the primary format wins a position conflict');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bookmarks WHERE username = ? AND book_id = ?').get(USER, newA).c, 1, 'MOBI file data → same book');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM read_books WHERE username = ? AND book_id = ?').get(USER, newB).c, 1);
  for (const oldId of [oldEpub, oldMobi, oldFb2]) {
    for (const t of ['reading_positions', 'bookmarks', 'read_books']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE book_id = ?`).get(oldId).c, 0, `${t} left on ${oldId}`);
    }
  }
  assert.equal(getMeta(`calibre_convert_${folder.id}`), null, 'marker cleared');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM detached_book_refs').get().c, 0, 'refs consumed');
}));
