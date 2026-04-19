import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectFlibustaSidecarLayout } from '../src/flibusta-sidecar.js';

test('detectFlibustaSidecarLayout: covers/*.zip обнаруживает sidecar', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-sidecar-'));
  try {
    fs.mkdirSync(path.join(tmp, 'covers'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'covers', 'stub.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    assert.strictEqual(detectFlibustaSidecarLayout(tmp), true);
    assert.strictEqual(detectFlibustaSidecarLayout(tmp), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('detectFlibustaSidecarLayout: пустой каталог без sidecar', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-noside-'));
  try {
    assert.strictEqual(detectFlibustaSidecarLayout(tmp), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
