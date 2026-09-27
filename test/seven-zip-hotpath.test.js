import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSevenZipBinary, parseSevenZipListSlt } from '../src/seven-zip.js';
import { readArchiveEntryBuffer } from '../src/archives.js';
import { bookUsesSevenZipArchive } from '../src/fb2.js';

test('parseSevenZipListSlt reads Path/Size blocks', () => {
  const text = [
    'Path = D:/lib/books.7z',
    '',
    'Path = 110119.fb2',
    'Size = 663414',
    '',
    'Path = covers/',
    'Size = 0',
    '',
    'Path = covers/110119.jpg',
    'Size = 1200'
  ].join('\n');
  const files = parseSevenZipListSlt(text);
  assert.deepEqual(
    files.map((f) => [f.path, f.uncompressedSize]),
    [
      ['D:/lib/books.7z', 0],
      ['110119.fb2', 663414],
      ['covers/110119.jpg', 1200]
    ]
  );
});

test('bookUsesSevenZipArchive follows archiveName and on-disk .7z', () => {
  assert.equal(bookUsesSevenZipArchive({ archiveName: 'fb2-1-2.7z' }), true);
  assert.equal(bookUsesSevenZipArchive({ archiveName: 'fb2-1-2.zip' }), false);
  assert.equal(bookUsesSevenZipArchive({ fileName: '1' }), false);
});

test('readArchiveEntryBuffer listFallback:false does not list a 7z on miss', async (t) => {
  let bin;
  try {
    bin = getSevenZipBinary();
  } catch {
    t.skip('7z binary is not available');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-7z-hot-'));
  try {
    fs.writeFileSync(path.join(dir, 'only.fb2'), '<FictionBook/>', 'utf8');
    const sevenPath = path.join(dir, 'pack.7z');
    const res = spawnSync(bin, ['a', '-t7z', sevenPath, path.join(dir, 'only.fb2')], { windowsHide: true });
    assert.equal(res.status, 0, String(res.stderr || res.stdout));

    const ok = await readArchiveEntryBuffer(sevenPath, 'only.fb2', { listFallback: false });
    assert.equal(ok.toString('utf8'), '<FictionBook/>');

    /* 7z e -so на отсутствующий файл даёт пустой буфер и код 0 — без `7z l`. */
    const miss = await readArchiveEntryBuffer(sevenPath, 'missing.jpg', { listFallback: false });
    assert.equal(miss.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
