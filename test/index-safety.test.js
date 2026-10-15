import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, db, addSource } from '../src/db.js';
import { indexFolder } from '../src/folder-indexer.js';
import { checkInpxArchivesOnDisk } from '../src/inpx.js';

initDb();

function cleanupFolderSource(folder) {
  db.prepare('DELETE FROM books WHERE source_id IN (SELECT id FROM sources WHERE path = ?)').run(folder);
  db.prepare('DELETE FROM sources WHERE path = ?').run(folder);
  fs.rmSync(folder, { recursive: true, force: true });
}

test('indexFolder keeps existing books when the root turns up empty (unmounted volume)', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'index-empty-root-'));
  try {
    const book = path.join(folder, 'Айзек Азимов - Основание.fb2');
    fs.writeFileSync(book, 'x');
    const source = addSource({ name: 'Empty root guard', type: 'folder', path: folder, fastScan: true });
    await indexFolder(source, { incremental: false });
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM books WHERE source_id = ?').get(source.id).n;
    assert.equal(count(), 1);

    fs.rmSync(book);
    for (const incremental of [true, false]) {
      await assert.rejects(() => indexFolder(source, { incremental }), /пуста или недоступна/);
      assert.equal(count(), 1, `books survive an empty scan (incremental=${incremental})`);
    }

    fs.writeFileSync(book, 'x');
    await indexFolder(source, { incremental: true });
    assert.equal(count(), 1, 'indexing works again once the files are back');
  } finally {
    cleanupFolderSource(folder);
  }
});

test('indexFolder on a never-indexed empty folder is not an error', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'index-new-empty-'));
  try {
    const source = addSource({ name: 'New empty folder', type: 'folder', path: folder, fastScan: true });
    const result = await indexFolder(source, { incremental: false });
    assert.equal(result.imported, 0);
  } finally {
    cleanupFolderSource(folder);
  }
});

test('checkInpxArchivesOnDisk reports archives missing from disk (zip and 7z both count)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-archives-'));
  try {
    fs.writeFileSync(path.join(root, 'fb2-000001-000100.zip'), '');
    fs.writeFileSync(path.join(root, 'fb2-000101-000200.7z'), '');
    const entries = [
      { path: 'fb2-000001-000100.inp' },
      { path: 'fb2-000101-000200.inp' },
      { path: 'fb2-000201-000300.inp' }
    ];
    const partial = checkInpxArchivesOnDisk(root, entries);
    assert.equal(partial.checked, 3);
    assert.equal(partial.missing, 1);
    assert.match(partial.missingNames[0], /fb2-000201-000300/);

    const wrongRoot = path.join(root, 'not-mounted');
    const none = checkInpxArchivesOnDisk(wrongRoot, entries);
    assert.equal(none.missing, none.checked);

    assert.deepEqual(checkInpxArchivesOnDisk(root, []), { total: 0, checked: 0, missing: 0, missingNames: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkInpxArchivesOnDisk samples at most `sample` archives evenly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-archives-sample-'));
  try {
    const entries = Array.from({ length: 500 }, (_, i) => ({ path: `a${i}.inp` }));
    const result = checkInpxArchivesOnDisk(root, entries, { sample: 20 });
    assert.equal(result.total, 500);
    assert.ok(result.checked <= 20 && result.checked >= 10, `checked=${result.checked}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
