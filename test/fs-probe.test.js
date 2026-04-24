import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSyncCached, statSyncCached, invalidateFsProbe, clearFsProbeCache } from '../src/utils/fs-probe.js';

test('existsSyncCached: положительный/отрицательный кейсы', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-fsprobe-'));
  try {
    const fpath = path.join(tmp, 'hello.txt');
    assert.strictEqual(existsSyncCached(fpath), false);
    fs.writeFileSync(fpath, 'x');
    // Тот же путь в кэше — вернёт stale=false, требуем явной инвалидации
    assert.strictEqual(existsSyncCached(fpath), false);
    invalidateFsProbe(fpath);
    assert.strictEqual(existsSyncCached(fpath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    clearFsProbeCache();
  }
});

test('statSyncCached: null для несуществующего, объект для существующего', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-fsprobe2-'));
  try {
    const fpath = path.join(tmp, 'a.bin');
    assert.strictEqual(statSyncCached(fpath), null);
    fs.writeFileSync(fpath, 'data');
    invalidateFsProbe(fpath);
    const st = statSyncCached(fpath);
    assert.ok(st, 'stat результат должен быть не null');
    assert.ok(st.isFile(), 'должен быть файл');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    clearFsProbeCache();
  }
});

test('существующая запись не пересчитывается при повторных вызовах (cache hit)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-fsprobe3-'));
  try {
    const fpath = path.join(tmp, 'x.txt');
    fs.writeFileSync(fpath, '1');
    assert.strictEqual(existsSyncCached(fpath), true);
    // Удаление файла без инвалидации → кэш вернёт старое «true»
    fs.unlinkSync(fpath);
    assert.strictEqual(existsSyncCached(fpath), true);
    // После инвалидации — актуально
    invalidateFsProbe(fpath);
    assert.strictEqual(existsSyncCached(fpath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    clearFsProbeCache();
  }
});
