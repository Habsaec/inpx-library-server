import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { initDb, db, addSource, getSourceById } from '../src/db.js';
import { indexCalibre } from '../src/calibre-indexer.js';
import { indexFolder } from '../src/folder-indexer.js';
import { makeCalibreBookId, forgetCalibreSource } from '../src/calibre.js';
import { resetBookFilesProbe, getAvailableDownloadFormats } from '../src/download-formats.js';
import { resolveDownload } from '../src/conversion.js';
import { getOrExtractBookDetails } from '../src/fb2.js';
import { getBookById } from '../src/inpx.js';
import { renderOpdsBookDetail } from '../src/templates/opds.js';
import {
  canOpenInWebReader, isDocumentFormat, isKindleEmailAddress, isKindleEmailFormat, DOCUMENT_FORMATS
} from '../src/utils/book-format.js';
import { createCalibreLibrary } from './calibre-fixture.js';

initDb();

function cleanupSources(dir) {
  for (const { id } of db.prepare('SELECT id FROM sources WHERE path = ?').all(dir)) {
    db.prepare('DELETE FROM book_files WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(id);
    db.prepare('DELETE FROM book_details_cache WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(id);
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM books WHERE source_id = ?').run(id);
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM calibre_book_state WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    forgetCalibreSource(id);
  }
  resetBookFilesProbe();
}

test('format helpers: web reader, document formats, Kindle e-mail', () => {
  for (const ext of ['fb2', 'epub', 'mobi', 'azw3', 'cbz', 'pdf', 'fb2.zip']) assert.equal(canOpenInWebReader(ext), true, ext);
  for (const ext of ['djvu', 'cbr', 'txt', 'rtf', 'docx']) assert.equal(canOpenInWebReader(ext), false, ext);
  assert.deepEqual([...DOCUMENT_FORMATS], ['pdf', 'djvu', 'cbz', 'cbr', 'txt', 'rtf', 'docx']);
  assert.equal(isDocumentFormat('PDF'), true);
  assert.equal(isDocumentFormat('epub'), false);
  assert.equal(isKindleEmailAddress('me_42@kindle.com'), true);
  assert.equal(isKindleEmailAddress('me@free.kindle.com'), true);
  assert.equal(isKindleEmailAddress('me@pbsync.com'), false);
  for (const f of ['epub', 'epub2', 'pdf', 'docx', 'txt', 'rtf']) assert.equal(isKindleEmailFormat(f), true, f);
  for (const f of ['mobi', 'azw3', 'fb2', 'fb2zip', 'djvu', 'cbz', 'cbr', 'kfx']) assert.equal(isKindleEmailFormat(f), false, f);
});

test('Calibre books with only PDF / DJVU / CBZ / DOCX are indexed and served as is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibre-docs-'));
  const lib = createCalibreLibrary(dir);
  try {
    const pdf = lib.addBook({ title: 'Manual', authors: [['Ann Writer', 'Writer, Ann']], formats: [{ format: 'PDF' }, { format: 'DOCX' }] });
    const djvu = lib.addBook({ title: 'Old scan', authors: [['Ann Writer', 'Writer, Ann']], formats: [{ format: 'DJVU' }, { format: 'CBR' }] });
    const comic = lib.addBook({ title: 'Comic', authors: [['Ann Writer', 'Writer, Ann']], formats: [{ format: 'CBR' }, { format: 'CBZ' }] });
    const odd = lib.addBook({ title: 'Odd', authors: [['Ann Writer', 'Writer, Ann']], formats: [{ format: 'LIT' }] });
    const source = addSource({ name: 'Docs', type: 'calibre', path: dir });
    await indexCalibre(getSourceById(source.id), { incremental: false });
    resetBookFilesProbe();

    const row = (b) => db.prepare('SELECT ext FROM books WHERE id = ?').get(makeCalibreBookId(source.id, b.uuid));
    assert.equal(row(pdf).ext, 'pdf');
    assert.equal(row(djvu).ext, 'djvu');
    assert.equal(row(comic).ext, 'cbz', 'CBZ before CBR');
    assert.equal(row(odd), undefined, 'formats outside the list are still skipped');

    const book = getBookById(makeCalibreBookId(source.id, pdf.uuid));
    assert.deepEqual(getAvailableDownloadFormats(book), ['pdf', 'docx']);
    const file = await resolveDownload(book, undefined);
    assert.equal(file.mimeType, 'application/pdf');
    assert.equal(file.content.toString(), 'PDF of Manual');
    const docx = await resolveDownload(book, 'docx');
    assert.match(docx.mimeType, /wordprocessingml/);
    const xml = renderOpdsBookDetail('http://x', book);
    assert.match(xml, /type="application\/pdf" title="PDF"/);
    assert.match(xml, /format=docx" rel="http:\/\/opds-spec.org\/acquisition" type="application\/vnd.openxmlformats/);

    const details = await getOrExtractBookDetails(getBookById(makeCalibreBookId(source.id, djvu.uuid)));
    assert.equal(details.annotation, '');
  } finally {
    lib.close();
    cleanupSources(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('folder sources: loose PDF / DJVU / TXT… indexed by file name, not inside zip containers; never read for details', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-docs-'));
  try {
    fs.writeFileSync(path.join(dir, 'Ann Writer - Manual.pdf'), '%PDF-1.4 fake');
    fs.writeFileSync(path.join(dir, 'Ann Writer - Scan.djvu'), 'AT&TFORM fake');
    fs.writeFileSync(path.join(dir, 'Ann Writer - Notes.txt'), 'plain text');
    fs.writeFileSync(path.join(dir, 'skip.lit'), 'x');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(path.join(dir, 'pack.zip'));
      const zip = archiver('zip');
      out.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(out);
      zip.append('readme', { name: 'readme.txt' });
      zip.append('<FictionBook><description><title-info><book-title>Inside</book-title></title-info></description></FictionBook>', { name: 'Inside.fb2' });
      zip.finalize();
    });
    const source = addSource({ name: 'Docs folder', type: 'folder', path: dir });
    await indexFolder(getSourceById(source.id), { incremental: false });
    const rows = db.prepare('SELECT title, authors, ext, archive_name AS archiveName FROM books WHERE source_id = ? ORDER BY ext, title').all(source.id);
    assert.deepEqual(rows.map((r) => r.ext), ['djvu', 'fb2', 'pdf', 'txt'], JSON.stringify(rows));
    const pdf = rows.find((r) => r.ext === 'pdf');
    assert.equal(pdf.title, 'Manual');
    assert.ok(!rows.some((r) => r.archiveName && r.ext === 'txt'), 'readme.txt inside a zip is not a book');
  } finally {
    cleanupSources(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('send to a Kindle address: DJVU is refused with EREADER_FORMAT_UNSUPPORTED before any mail is sent', async () => {
  const { default: express } = await import('express');
  const { createUser, setEreaderEmail } = await import('../src/db.js');
  const { registerUserApiRoutes } = await import('../src/routes/user-api.js');
  const user = 'kindle_doc_user';
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(user)) createUser({ username: user, password: 'KindleDoc1!' });
  setEreaderEmail(user, 'reader_1@kindle.com');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-docs-'));
  fs.writeFileSync(path.join(dir, 'Scan.djvu'), 'AT&TFORM fake');
  const source = addSource({ name: 'Kindle docs', type: 'folder', path: dir });
  await indexFolder(getSourceById(source.id), { incremental: false });
  const bookId = db.prepare('SELECT id FROM books WHERE source_id = ?').get(source.id).id;
  const app = express();
  app.use(express.json());
  registerUserApiRoutes(app, { batchEmailLocks: new Set() });
  const server = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  try {
    const auth = `Basic ${Buffer.from(`${user}:KindleDoc1!`).toString('base64')}`;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/send-to-ereader/${encodeURIComponent(bookId)}`, {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'djvu' })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, 'EREADER_FORMAT_UNSUPPORTED');
    assert.match(body.error, /DJVU/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupSources(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
