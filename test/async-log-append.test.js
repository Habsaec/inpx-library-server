import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendLineAsync } from '../src/utils/async-log-append.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('appendLineAsync does not write synchronously and keeps line order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-log-'));
  const file = path.join(dir, 'a.log');
  try {
    for (let i = 0; i < 200; i++) appendLineAsync(file, `line ${i}\n`);
    assert.equal(fs.existsSync(file), false, 'nothing written on the calling tick');
    for (let i = 0; i < 50 && !(fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').length > 200); i++) {
      await sleep(20);
    }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 200);
    assert.deepEqual(lines, Array.from({ length: 200 }, (_, i) => `line ${i}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendLineAsync flushes pending lines when the process exits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-log-'));
  const file = path.join(dir, 'exit.log');
  try {
    const modUrl = new URL('../src/utils/async-log-append.js', import.meta.url).href;
    const code = `import(${JSON.stringify(modUrl)}).then((m) => { m.appendLineAsync(${JSON.stringify(file)}, 'last words\\n'); process.exit(0); });`;
    const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), 'last words\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
