import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSevenZipBinary } from '../src/seven-zip.js';
import { listArchiveFiles, readArchiveEntryBuffer } from '../src/archives.js';

/* Сжатые сборки Flibusta + Librusec упакованы в ZIP методом PPMd — unzipper его не умеет. */
test('readArchiveEntryBuffer extracts PPMd-compressed ZIP entries via 7z', async (t) => {
  let bin;
  try {
    bin = getSevenZipBinary();
  } catch {
    t.skip('7z binary is not available');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-ppmd-'));
  try {
    const payload = `<?xml version="1.0" encoding="utf-8"?><FictionBook><body><p>Привет, PPMd</p></body></FictionBook>\n`.repeat(50);
    fs.writeFileSync(path.join(dir, '123456.fb2'), payload, 'utf8');
    const zipPath = path.join(dir, 'fb2-123456-123456.zip');
    const res = spawnSync(bin, ['a', '-tzip', '-mm=PPMd', zipPath, path.join(dir, '123456.fb2')], { windowsHide: true });
    assert.equal(res.status, 0, String(res.stderr || res.stdout));

    const entries = await listArchiveFiles(zipPath);
    assert.deepEqual(entries.map((e) => e.path), ['123456.fb2']);

    const buf = await readArchiveEntryBuffer(zipPath, '123456.fb2');
    assert.equal(buf.toString('utf8'), payload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
