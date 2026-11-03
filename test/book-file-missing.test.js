import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, db, addSource } from '../src/db.js';
import { readBookBuffer, isBookFileMissingError, BOOK_FILE_MISSING } from '../src/fb2.js';

initDb();

test('a book file or archive gone from disk throws BOOK_FILE_MISSING (404), not a raw ENOENT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-missing-'));
  try {
    const source = addSource({ name: 'Missing files', type: 'folder', path: dir, fastScan: true });
    fs.writeFileSync(path.join(dir, 'here.fb2'), '<FictionBook/>');

    const present = await readBookBuffer({ sourceId: source.id, archiveName: '', fileName: 'here', ext: 'fb2' });
    assert.equal(present.toString(), '<FictionBook/>');

    // e.g. a format deleted by hand from a Calibre book folder while metadata.db still lists it
    await assert.rejects(
      readBookBuffer({ sourceId: source.id, archiveName: '', fileName: 'Author/Gone (1)/Gone', ext: 'epub' }),
      (err) => isBookFileMissingError(err) && err.code === BOOK_FILE_MISSING
    );
    await assert.rejects(
      readBookBuffer({ sourceId: source.id, archiveName: 'missing-archive.zip', fileName: '123', ext: 'fb2' }),
      (err) => isBookFileMissingError(err)
    );
  } finally {
    db.prepare('DELETE FROM sources WHERE path = ?').run(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
