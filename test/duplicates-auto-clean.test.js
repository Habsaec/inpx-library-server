import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, unsuppressAll } from '../src/db.js';
import {
  enrichBookRow,
  getDuplicateGroups,
  previewAutoClean,
  autoCleanDuplicates,
  invalidateDuplicatesCache
} from '../src/inpx.js';

const SOURCE_OLD = 9201;
const SOURCE_NEW = 9202;

let otherBooksSnap = [];
let otherSuppSnap = [];

function insertDupBook({
  id, title, authors, ext = 'fb2', size = 1000, sourceId, libId, archiveName = 'dup-ac.zip'
}) {
  const row = enrichBookRow({
    id,
    title,
    authors,
    genres: '',
    series: '',
    seriesNo: '',
    fileName: `${libId}.fb2`,
    archiveName,
    size,
    libId,
    deleted: 0,
    ext,
    date: '',
    lang: 'ru',
    libRate: 0,
    keywords: ''
  });
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
  `).run({ ...row, sourceId, deleted: 0 });
}

before(() => {
  initDb();
  otherBooksSnap = db.prepare(`SELECT id, deleted FROM books WHERE id NOT LIKE 'dup-ac-%'`).all();
  otherSuppSnap = db.prepare(`
    SELECT book_id, title, authors, reason FROM suppressed_books WHERE book_id NOT LIKE 'dup-ac-%'
  `).all();

  db.exec(`DELETE FROM books WHERE id LIKE 'dup-ac-%'`);
  db.exec(`DELETE FROM suppressed_books WHERE book_id LIKE 'dup-ac-%'`);
  db.exec(`DELETE FROM sources WHERE id IN (${SOURCE_OLD}, ${SOURCE_NEW})`);
  db.prepare(`
    INSERT INTO sources (id, name, type, path, enabled)
    VALUES (?, 'dup-ac-old', 'inpx', '/dup-ac-old', 1)
  `).run(SOURCE_OLD);
  db.prepare(`
    INSERT INTO sources (id, name, type, path, enabled)
    VALUES (?, 'dup-ac-new', 'inpx', '/dup-ac-new', 1)
  `).run(SOURCE_NEW);

  insertDupBook({
    id: 'dup-ac-old-fb2', title: 'Dup Ac LibFlib Overlap', authors: 'Overlapov Ivan',
    size: 5_000_000, sourceId: SOURCE_OLD, libId: '90001'
  });
  insertDupBook({
    id: 'dup-ac-new-fb2', title: 'Dup Ac LibFlib Overlap', authors: 'Overlapov Ivan',
    size: 80_000, sourceId: SOURCE_NEW, libId: '90001'
  });

  insertDupBook({
    id: 'dup-ac-old-epub', title: 'Dup Ac Format Wins', authors: 'Formatov Petr',
    ext: 'epub', size: 10_000, sourceId: SOURCE_OLD, libId: '90002'
  });
  insertDupBook({
    id: 'dup-ac-new-fb2-fmt', title: 'Dup Ac Format Wins', authors: 'Formatov Petr',
    ext: 'fb2', size: 20_000, sourceId: SOURCE_NEW, libId: '90002'
  });

  insertDupBook({
    id: 'dup-ac-punct-a', title: 'Dup Ac Punctuation Title', authors: 'Иванов, Иван',
    size: 1000, sourceId: SOURCE_OLD, libId: '90003'
  });
  insertDupBook({
    id: 'dup-ac-punct-b', title: 'Dup Ac Punctuation Title', authors: 'Иванов,Иван',
    size: 900, sourceId: SOURCE_NEW, libId: '90003'
  });

  insertDupBook({
    id: 'dup-ac-unique', title: 'Dup Ac Unique Only', authors: 'Uniqueov Unique',
    size: 1000, sourceId: SOURCE_NEW, libId: '90004'
  });

  insertDupBook({
    id: 'dup-ac-rename-old', title: 'Dup Ac Renamed Author', authors: 'Ковалькова,Юлия,:',
    size: 1000, sourceId: SOURCE_OLD, libId: '91001',
    archiveName: 'fb2-440000-449999.7z'
  });
  insertDupBook({
    id: 'dup-ac-rename-new', title: 'Dup Ac Renamed Author', authors: 'Кова,Юлия,:',
    size: 900, sourceId: SOURCE_NEW, libId: '91002',
    archiveName: 'lib.flib/fb2-582000-585999.zip'
  });

  insertDupBook({
    id: 'dup-ac-libid-old', title: 'Dup Ac LibId Stem Old', authors: 'Stemov Old',
    size: 1000, sourceId: SOURCE_OLD, libId: '91003',
    archiveName: 'fb2-091841-104214.7z'
  });
  insertDupBook({
    id: 'dup-ac-libid-new', title: 'Dup Ac LibId Stem New Title', authors: 'Stemov New',
    size: 900, sourceId: SOURCE_NEW, libId: '91003',
    archiveName: 'lib.flib/fb2-091841-104214.zip'
  });

  insertDupBook({
    id: 'dup-ac-collide-a', title: 'Dup Ac Collide Myths', authors: 'Unknown A',
    size: 1000, sourceId: SOURCE_OLD, libId: '91004',
    archiveName: 'fb2-187148-193822.7z'
  });
  insertDupBook({
    id: 'dup-ac-collide-b', title: 'Dup Ac Collide Arthur', authors: 'Unknown B',
    size: 900, sourceId: SOURCE_OLD, libId: '91004',
    archiveName: 'f.fb2-188549-190927.7z'
  });

  insertDupBook({
    id: 'dup-ac-page-a1', title: 'Dup Ac Page Alpha', authors: 'Alphaov Anna',
    size: 1000, sourceId: SOURCE_OLD, libId: '90005'
  });
  insertDupBook({
    id: 'dup-ac-page-a2', title: 'Dup Ac Page Alpha', authors: 'Alphaov Anna',
    size: 900, sourceId: SOURCE_NEW, libId: '90005'
  });
  insertDupBook({
    id: 'dup-ac-page-b1', title: 'Dup Ac Page Beta', authors: 'Betaov Boris',
    size: 1000, sourceId: SOURCE_OLD, libId: '90006'
  });
  insertDupBook({
    id: 'dup-ac-page-b2', title: 'Dup Ac Page Beta', authors: 'Betaov Boris',
    size: 900, sourceId: SOURCE_NEW, libId: '90006'
  });

  invalidateDuplicatesCache();
});

after(() => {
  db.exec(`DELETE FROM books WHERE id LIKE 'dup-ac-%'`);
  db.exec(`DELETE FROM suppressed_books WHERE book_id LIKE 'dup-ac-%'`);
  db.exec(`DELETE FROM sources WHERE id IN (${SOURCE_OLD}, ${SOURCE_NEW})`);
  const restore = db.prepare('UPDATE books SET deleted = ? WHERE id = ?');
  for (const row of otherBooksSnap) {
    restore.run(row.deleted, row.id);
  }
  db.prepare(`DELETE FROM suppressed_books WHERE book_id NOT LIKE 'dup-ac-%'`).run();
  const insSupp = db.prepare(`
    INSERT INTO suppressed_books(book_id, title, authors, reason) VALUES (?, ?, ?, ?)
  `);
  for (const row of otherSuppSnap) {
    insSupp.run(row.book_id, row.title || '', row.authors || '', row.reason || 'user');
  }
  invalidateDuplicatesCache();
});

test('getDuplicateGroups paginates by author without loading every row', () => {
  const page1 = getDuplicateGroups({ page: 1, pageSize: 1, filter: 'dup ac page' });
  assert.equal(page1.total, 2);
  assert.equal(page1.groups.length, 1);
  const page2 = getDuplicateGroups({ page: 2, pageSize: 1, filter: 'dup ac page' });
  assert.equal(page2.groups.length, 1);
  assert.notEqual(page1.groups[0].authors, page2.groups[0].authors);
});

test('previewAutoClean counts title+author, lib_id, and renamed-author pairs', () => {
  const preview = previewAutoClean();
  assert.ok(preview.willDelete >= 6);
  assert.ok(preview.totalGroups >= 6);
});

test('previewAutoClean does not count same lib_id on different archive stems', () => {
  insertDupBook({
    id: 'dup-ac-stem-x', title: 'Dup Ac Stem Volume X', authors: 'Volumov X',
    size: 1000, sourceId: SOURCE_OLD, libId: '92000',
    archiveName: 'fb2-100000-199999.7z'
  });
  insertDupBook({
    id: 'dup-ac-stem-y', title: 'Dup Ac Stem Volume Y', authors: 'Volumov Y',
    size: 900, sourceId: SOURCE_NEW, libId: '92000',
    archiveName: 'fb2-200000-299999.7z'
  });
  invalidateDuplicatesCache();
  const withPair = previewAutoClean();

  db.exec(`DELETE FROM books WHERE id IN ('dup-ac-stem-x', 'dup-ac-stem-y')`);
  invalidateDuplicatesCache();
  const withoutPair = previewAutoClean();

  assert.equal(withPair.willDelete, withoutPair.willDelete);
  assert.equal(withPair.totalGroups, withoutPair.totalGroups);
});

test('autoCleanDuplicates keeps newer source when format matches even if smaller', async () => {
  const stages = [];
  const result = await autoCleanDuplicates({
    onProgress(p) { if (p.stage) stages.push(p.stage); }
  });
  assert.ok(result.totalDeleted >= 4);
  assert.ok(result.groupsCleaned >= 4);
  assert.ok(stages.includes('rank'));
  assert.ok(stages.includes('hide'));
  assert.ok(stages.includes('done'));

  const overlapOld = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-old-fb2');
  const overlapNew = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-new-fb2');
  assert.equal(overlapNew.deleted, 0);
  assert.equal(overlapOld.deleted, 1);
  const suppressed = db.prepare('SELECT reason FROM suppressed_books WHERE book_id = ?').get('dup-ac-old-fb2');
  assert.equal(suppressed.reason, 'auto_clean');

  const epub = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-old-epub');
  const fb2 = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-new-fb2-fmt');
  assert.equal(epub.deleted, 0);
  assert.equal(fb2.deleted, 1);

  const punctOld = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-punct-a');
  const punctNew = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-punct-b');
  assert.equal(punctNew.deleted, 0);
  assert.equal(punctOld.deleted, 1);

  const unique = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-unique');
  assert.equal(unique.deleted, 0);

  const renameOld = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-rename-old');
  const renameNew = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-rename-new');
  assert.equal(renameNew.deleted, 0);
  assert.equal(renameOld.deleted, 1);

  const libidOld = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-libid-old');
  const libidNew = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-libid-new');
  assert.equal(libidNew.deleted, 0);
  assert.equal(libidOld.deleted, 1);

  const collideA = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-collide-a');
  const collideB = db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-collide-b');
  assert.equal(collideA.deleted, 0);
  assert.equal(collideB.deleted, 0);
});

test('unsuppressAll restores hidden duplicates with progress stages', async () => {
  const stages = [];
  const restored = await unsuppressAll({
    onProgress(p) { if (p.stage) stages.push(p.stage); }
  });
  assert.ok(restored >= 4);
  assert.ok(stages.includes('restore'));
  assert.ok(stages.includes('done'));
  assert.equal(db.prepare('SELECT deleted FROM books WHERE id = ?').get('dup-ac-old-fb2').deleted, 0);
  assert.equal(db.prepare('SELECT 1 AS x FROM suppressed_books WHERE book_id = ?').get('dup-ac-old-fb2'), undefined);
});
