import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, db, addSource, getSourceById, getSources } from '../src/db.js';
import { indexFolder } from '../src/folder-indexer.js';
import { findInpxFiles } from '../src/inpx.js';

initDb();

test('addSource stores fastScan for folders only and exposes it in getSources', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-scan-db-'));
  const inpxPath = path.join(folder, 'lib.inpx');
  try {
    const fast = addSource({ name: 'Fast folder', type: 'folder', path: folder, fastScan: true });
    assert.equal(fast.fastScan, 1);
    assert.equal(getSourceById(fast.id).fastScan, 1);
    assert.equal(getSources().find((s) => s.id === fast.id).fastScan, 1);

    const inpx = addSource({ name: 'INPX', type: 'inpx', path: inpxPath, fastScan: true });
    assert.equal(inpx.fastScan, 0, 'fast scan is meaningless for INPX sources');

    const plain = addSource({ name: 'Plain folder', type: 'folder', path: path.join(folder, 'plain') });
    assert.equal(plain.fastScan, 0, 'default stays the full metadata scan');
  } finally {
    db.prepare('DELETE FROM sources WHERE path LIKE ?').run(`${folder}%`);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('indexFolder with fastScan takes author and title from the file name', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-scan-index-'));
  try {
    fs.writeFileSync(path.join(folder, 'Айзек Азимов - Основание.fb2'), 'not xml: a full scan could not parse this');
    const source = addSource({ name: 'Fast scan index', type: 'folder', path: folder, fastScan: true });

    const result = await indexFolder(source, { incremental: false });
    assert.equal(result.imported, 1);

    const book = db.prepare('SELECT title, authors, genres FROM books WHERE source_id = ?').get(source.id);
    assert.ok(book, 'book is indexed');
    assert.equal(book.title, 'Основание');
    assert.equal(book.authors, 'Айзек Азимов');
  } finally {
    db.prepare('DELETE FROM books WHERE source_id IN (SELECT id FROM sources WHERE path = ?)').run(folder);
    db.prepare('DELETE FROM sources WHERE path = ?').run(folder);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('findInpxFiles: case-insensitive, 2 levels deep, _local first, then shallow, then by name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'find-inpx-'));
  try {
    fs.mkdirSync(path.join(root, 'inpx', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Root.INPX'), '');
    fs.writeFileSync(path.join(root, 'inpx', 'fb2.inpx'), '');
    fs.writeFileSync(path.join(root, 'inpx', 'fb2_local.inpx'), '');
    fs.writeFileSync(path.join(root, 'inpx', 'deep', 'nested.inpx'), '');
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'too-deep.inpx'), '');
    fs.writeFileSync(path.join(root, 'notes.txt'), '');

    const names = findInpxFiles(root, { maxDepth: 2 }).map((f) => path.relative(root, f).replaceAll('\\', '/'));
    assert.deepEqual(names, ['inpx/fb2_local.inpx', 'Root.INPX', 'inpx/fb2.inpx', 'inpx/deep/nested.inpx']);

    const shallow = findInpxFiles(root, { maxDepth: 1 }).map((f) => path.relative(root, f).replaceAll('\\', '/'));
    assert.deepEqual(shallow, ['inpx/fb2_local.inpx', 'Root.INPX', 'inpx/fb2.inpx']);

    assert.deepEqual(findInpxFiles(path.join(root, 'missing')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
