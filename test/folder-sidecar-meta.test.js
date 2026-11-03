import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import iconv from 'iconv-lite';
import { initDb, db, addSource, getSourceById, updateSource, getMeta } from '../src/db.js';
import { indexFolder } from '../src/folder-indexer.js';
import { getOrExtractBookDetails, getBookPublishInfo } from '../src/fb2.js';
import { getBookById } from '../src/inpx.js';
import {
  cleanPdfTitle,
  decodePdfStringBytes,
  folderSeriesMetadata,
  parseComicInfo,
  parseSidecarOpf,
  pickSidecarOpfName,
  readPdfMetadata,
  splitPdfAuthors,
  volumeNumberFromName
} from '../src/folder-sidecar-meta.js';
import { TINY_JPEG } from './calibre-fixture.js';

initDb();

const CALIBRE_OPF = `<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier opf:scheme="calibre" id="calibre_id">42</dc:identifier>
    <dc:identifier opf:scheme="ISBN">978-5-17-090433-0</dc:identifier>
    <dc:title>Foundation &amp; Empire</dc:title>
    <dc:creator opf:file-as="Asimov, Isaac" opf:role="aut">Isaac Asimov</dc:creator>
    <dc:creator opf:file-as="Doe, Jane" opf:role="trl">Jane Doe</dc:creator>
    <dc:date>1952-01-01T00:00:00+00:00</dc:date>
    <dc:description>&lt;p&gt;The second book.&lt;/p&gt;</dc:description>
    <dc:publisher>Gnome Press</dc:publisher>
    <dc:language>eng</dc:language>
    <dc:subject>Science Fiction</dc:subject>
    <meta content="Robert's Foundation" name="calibre:series"/>
    <meta name="calibre:series_index" content="2.0"/>
    <meta name="calibre:timestamp" content="2024-03-01T10:00:00+00:00"/>
  </metadata>
</package>`;

const EPUB3_OPF = `<package version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Пикник на обочине</dc:title>
  <dc:creator id="c1">Аркадий Стругацкий</dc:creator>
  <meta refines="#c1" property="file-as">Стругацкий, Аркадий</meta>
  <meta refines="#c1" property="role" scheme="marc:relators">aut</meta>
  <dc:language>ru</dc:language>
  <meta property="belongs-to-collection" id="s1">Мир Полудня</meta>
  <meta refines="#s1" property="collection-type">series</meta>
  <meta refines="#s1" property="group-position">7</meta>
  <dc:identifier>urn:isbn:9785170904330</dc:identifier>
</metadata></package>`;

const COMIC_INFO = `<?xml version="1.0"?>
<ComicInfo>
  <Title></Title>
  <Series>Watchmen</Series>
  <Number>3</Number>
  <Writer>Alan Moore, Dave Gibbons</Writer>
  <Summary>Who watches the watchmen?</Summary>
  <Year>1986</Year><Month>11</Month>
  <Genre>Superhero, Drama</Genre>
  <Publisher>DC Comics</Publisher>
  <LanguageISO>en</LanguageISO>
</ComicInfo>`;

function writeZip(file, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const archive = archiver('zip', { store: true });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    for (const [name, data] of entries) archive.append(data, { name });
    archive.finalize();
  });
}

/** Минимальный PDF с классической таблицей xref; padding — байты до и после словаря Info. */
function buildPdf(info, { padding = 0 } = {}) {
  let body = '%PDF-1.4\n';
  const offsets = [];
  const pad = (n) => `<< /Length ${n} >>\nstream\n${'x'.repeat(n)}\nendstream`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', pad(padding), info, pad(padding)];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const utf16Hex = (text) => `<FEFF${Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase()}>`;

function cleanup(folder) {
  db.prepare('DELETE FROM book_details_cache WHERE book_id IN (SELECT id FROM books WHERE source_id IN (SELECT id FROM sources WHERE path = ?))').run(folder);
  db.prepare('DELETE FROM books WHERE source_id IN (SELECT id FROM sources WHERE path = ?)').run(folder);
  db.prepare('DELETE FROM sources WHERE path = ?').run(folder);
  fs.rmSync(folder, { recursive: true, force: true });
}

test('pickSidecarOpfName: own OPF always, metadata.opf only for a single-book folder', () => {
  assert.equal(pickSidecarOpfName(['Book.epub', 'book.OPF'], 'Book.epub', ['Book.epub']), 'book.OPF');
  assert.equal(pickSidecarOpfName(['A.epub', 'A.pdf', 'metadata.opf', 'cover.jpg'], 'A.pdf', ['A.epub', 'A.pdf']), 'metadata.opf');
  assert.equal(pickSidecarOpfName(['A.epub', 'B.epub', 'metadata.opf'], 'A.epub', ['A.epub', 'B.epub']), null);
  assert.equal(pickSidecarOpfName(['A.epub', 'B.epub', 'B.opf', 'metadata.opf'], 'B.epub', ['A.epub', 'B.epub']), 'B.opf');
  assert.equal(pickSidecarOpfName(['A.epub'], 'A.epub', ['A.epub']), null);
});

test('parseSidecarOpf: Calibre OPF — file-as authors, aut only, series, entities, timestamp, ISBN', () => {
  const meta = parseSidecarOpf(CALIBRE_OPF);
  assert.equal(meta.title, 'Foundation & Empire');
  assert.equal(meta.authors, 'Asimov,Isaac', 'translator (trl) is not an author');
  assert.equal(meta.series, "Robert's Foundation", 'apostrophe and attribute order');
  assert.equal(meta.seriesNo, '2');
  assert.equal(meta.lang, 'en');
  assert.equal(meta.date, '2024-03-01', 'date added, like the Calibre source');
  assert.equal(meta.publishYear, 1952);
  assert.equal(meta.isbn, '9785170904330');
  assert.equal(meta.genres, 'Science Fiction');
  assert.equal(meta.keywords, 'Gnome Press');
  assert.equal(meta.annotation, '<p>The second book.</p>');
  assert.equal(meta.annotationIsHtml, true);
});

test('parseSidecarOpf: EPUB 3 refines and belongs-to-collection', () => {
  const meta = parseSidecarOpf(EPUB3_OPF);
  assert.equal(meta.authors, 'Стругацкий,Аркадий');
  assert.equal(meta.series, 'Мир Полудня');
  assert.equal(meta.seriesNo, '7');
  assert.equal(meta.isbn, '9785170904330');
  assert.equal(meta.date, '');
});

test('parseComicInfo: comma separated writers are separate authors, title from series + number', () => {
  const meta = parseComicInfo(COMIC_INFO);
  assert.equal(meta.authors, 'Alan Moore:Dave Gibbons');
  assert.equal(meta.title, 'Watchmen #3');
  assert.equal(meta.series, 'Watchmen');
  assert.equal(meta.seriesNo, '3');
  assert.equal(meta.date, '1986-11-01');
  assert.equal(meta.genres, 'Superhero:Drama');
  assert.equal(meta.annotation, 'Who watches the watchmen?');
  assert.equal(meta.lang, 'en');
});

test('volumeNumberFromName and folderSeriesMetadata', () => {
  assert.equal(volumeNumberFromName('Saga 001'), '1');
  assert.equal(volumeNumberFromName('One Piece v12 (2004)'), '12');
  assert.equal(volumeNumberFromName('Берсерк Том 3'), '3');
  assert.equal(volumeNumberFromName('Batman #12.5'), '12.5');
  assert.equal(volumeNumberFromName('Batman 1989 05'), '5', 'a year is not a volume number');
  assert.equal(volumeNumberFromName('Prologue'), '');
  assert.deepEqual(folderSeriesMetadata('Comics/X-Men - Dark Phoenix/X-Men 012.cbz'), {
    title: 'X-Men 012', authors: '', series: 'X-Men - Dark Phoenix', seriesNo: '12'
  });
});

test('PDF: junk titles and author lists', () => {
  assert.equal(cleanPdfTitle('Microsoft Word - thesis_final.docx'), '');
  assert.equal(cleanPdfTitle('Untitled'), '');
  assert.equal(cleanPdfTitle('C:\\work\\book.pdf'), '');
  assert.equal(cleanPdfTitle('report_v2'), '');
  assert.equal(cleanPdfTitle('scan', 'scan'), '');
  assert.equal(cleanPdfTitle('Structure and Interpretation'), 'Structure and Interpretation');
  assert.deepEqual(splitPdfAuthors('Asimov, Isaac'), ['Asimov,Isaac']);
  assert.deepEqual(splitPdfAuthors('Harold Abelson & Gerald Sussman'), ['Harold Abelson', 'Gerald Sussman']);
  assert.deepEqual(splitPdfAuthors('Administrator'), []);
});

test('readPdfMetadata: UTF-16 Info strings, octal escapes, Info found through xref in the middle of the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-meta-'));
  try {
    const small = path.join(dir, 'small.pdf');
    fs.writeFileSync(small, buildPdf(`<< /Title ${utf16Hex('Основание')} /Author (Isaac Asimov) /Subject (caf\\351) >>`));
    const meta = await readPdfMetadata(small);
    assert.equal(meta.title, 'Основание');
    assert.equal(meta.authors, 'Isaac Asimov');

    const big = path.join(dir, 'big.pdf');
    fs.writeFileSync(big, buildPdf('<< /Title (Deep \\(Info\\)) /Author (Jane Roe; John Roe) >>', { padding: 300 * 1024 }));
    const deep = await readPdfMetadata(big);
    assert.equal(deep.title, 'Deep (Info)');
    assert.equal(deep.authors, 'Jane Roe:John Roe');

    // Raw cp1251 bytes (common in Russian PDFs) are not latin1 mojibake; a Western accent stays latin1.
    const octal = [...iconv.encode('Основание', 'win1251')].map((b) => `\\${b.toString(8)}`).join('');
    const cyr = path.join(dir, 'cp1251.pdf');
    fs.writeFileSync(cyr, buildPdf(`<< /Title (${octal}) /Author (Isaac Asimov) >>`));
    assert.equal((await readPdfMetadata(cyr)).title, 'Основание');
    assert.equal(decodePdfStringBytes([...Buffer.from('Caf', 'latin1'), 0xe9]), 'Café');

    const junk = path.join(dir, 'junk.pdf');
    fs.writeFileSync(junk, buildPdf('<< /Title (Microsoft Word - doc1.docx) /Author (Owner) >>'));
    assert.equal(await readPdfMetadata(junk), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('indexFolder: OPF next to a book wins, metadata.opf is ignored in a multi-book folder, OPF edits re-read the book', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-opf-'));
  try {
    const one = path.join(folder, 'Asimov', 'Foundation and Empire');
    const many = path.join(folder, 'Mixed');
    fs.mkdirSync(one, { recursive: true });
    fs.mkdirSync(many, { recursive: true });
    fs.writeFileSync(path.join(one, 'Foundation and Empire - Isaac Asimov.pdf'), buildPdf('<< /Producer (x) >>'));
    fs.writeFileSync(path.join(one, 'metadata.opf'), CALIBRE_OPF);
    fs.writeFileSync(path.join(one, 'cover.jpg'), TINY_JPEG);
    fs.writeFileSync(path.join(many, 'Ann Author - First.txt'), 'text');
    fs.writeFileSync(path.join(many, 'Bob Writer - Second.txt'), 'text');
    fs.writeFileSync(path.join(many, 'metadata.opf'), CALIBRE_OPF);

    const source = addSource({ name: 'Sidecar OPF', type: 'folder', path: folder });
    await indexFolder(source, { incremental: false });

    const rows = db.prepare('SELECT * FROM books WHERE source_id = ? ORDER BY file_name').all(source.id);
    const pdf = rows.find((r) => r.ext === 'pdf');
    assert.equal(pdf.title, 'Foundation & Empire');
    assert.equal(pdf.authors, 'Asimov,Isaac');
    assert.equal(pdf.series, "Robert's Foundation");
    assert.equal(pdf.series_no, '2');
    assert.equal(pdf.lang, 'en');
    const txts = rows.filter((r) => r.ext === 'txt').map((r) => [r.title, r.authors]);
    assert.deepEqual(txts, [['First', 'Ann Author'], ['Second', 'Bob Writer']], 'shared metadata.opf of a mixed folder is not applied');

    const fingerprints = JSON.parse(getMeta(`folder_index_${source.id}`));
    const txtKey = Object.keys(fingerprints).find((k) => k.endsWith('First.txt'));
    assert.deepEqual(Object.keys(fingerprints[txtKey]).sort(), ['mtimeMs', 'size'], 'books without OPF keep the old fingerprint shape');
    const pdfKey = Object.keys(fingerprints).find((k) => k.endsWith('.pdf'));
    assert.ok(fingerprints[pdfKey].opf, 'OPF fingerprint is stored');

    const book = getBookById(pdf.id);
    const details = await getOrExtractBookDetails(book);
    assert.match(details.annotation, /second book/);
    assert.equal(details.annotationIsHtml, true);
    assert.equal(details.isbn, '9785170904330');
    assert.ok(details.cover?.data?.length, 'cover.jpg next to the book');
    assert.deepEqual(await getBookPublishInfo(book), { publishYear: 1952, isbn: '9785170904330' });

    // Only the OPF changes: the incremental pass re-reads the book and drops the cached details.
    const edited = CALIBRE_OPF.replace('Foundation &amp; Empire', 'Second Foundation').replace('The second book.', 'The third book.');
    fs.writeFileSync(path.join(one, 'metadata.opf'), edited);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(one, 'metadata.opf'), later, later);
    const pass = await indexFolder(getSourceById(source.id), { incremental: true });
    assert.equal(pass.processed, 1, 'only the book next to the edited OPF');
    assert.equal(db.prepare('SELECT title FROM books WHERE id = ?').get(pdf.id).title, 'Second Foundation');
    assert.match((await getOrExtractBookDetails(getBookById(pdf.id))).annotation, /third book/);
  } finally {
    cleanup(folder);
  }
});

test('indexFolder: CBZ ComicInfo, «series = folder» and the first page as cover', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-comics-'));
  try {
    fs.mkdirSync(path.join(folder, 'Watchmen'));
    fs.mkdirSync(path.join(folder, 'X-Men'));
    await writeZip(path.join(folder, 'Watchmen', 'Watchmen 03.cbz'), [
      ['ComicInfo.xml', COMIC_INFO],
      ['002.jpg', Buffer.from('not an image')],
      ['001.jpg', TINY_JPEG]
    ]);
    await writeZip(path.join(folder, 'X-Men', 'X-Men 012.cbz'), [['p01.jpg', TINY_JPEG]]);

    const source = addSource({ name: 'Comics', type: 'folder', path: folder, folderSeries: true });
    assert.equal(getSourceById(source.id).folderSeries, 1);
    await indexFolder(source, { incremental: false });

    const watchmen = db.prepare("SELECT * FROM books WHERE source_id = ? AND file_name LIKE 'Watchmen/%'").get(source.id);
    assert.equal(watchmen.title, 'Watchmen #3');
    assert.equal(watchmen.authors, 'Alan Moore:Dave Gibbons');
    assert.equal(watchmen.series, 'Watchmen');
    assert.equal(watchmen.series_no, '3');

    const xmen = db.prepare("SELECT * FROM books WHERE source_id = ? AND file_name LIKE 'X-Men/%'").get(source.id);
    assert.equal(xmen.series, 'X-Men', 'series = the folder of the file');
    assert.equal(xmen.series_no, '12');
    assert.equal(xmen.authors, '', 'no author from the path');

    const details = await getOrExtractBookDetails(getBookById(watchmen.id));
    assert.equal(details.annotation, 'Who watches the watchmen?');
    assert.deepEqual(details.cover?.data, TINY_JPEG, 'first page by natural order');

    // Turning the mode off clears the fingerprints, so the next pass re-reads every file.
    updateSource(source.id, { folderSeries: false });
    assert.equal(getMeta(`folder_index_${source.id}`), null);
    await indexFolder(getSourceById(source.id), { incremental: true });
    const plain = db.prepare('SELECT series FROM books WHERE id = ?').get(xmen.id);
    assert.equal(plain.series, '', 'plain layout: one folder level gives no series');
  } finally {
    cleanup(folder);
  }
});
