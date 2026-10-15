import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, db, addSource, updateSourceIndexedAt, setSetting, getMeta } from '../src/db.js';
import {
  startFolderWatcher, stopFolderWatcher, reconcileFolderWatchers, getFolderWatchConfig, readFolderWatchStatus
} from '../src/services/folder-watcher.js';
import { isRelevantWatchName } from '../src/services/folder-watch-worker.js';

initDb();

async function waitFor(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

test('isRelevantWatchName keeps books, archives and directories, drops temp/cover files', () => {
  for (const name of ['a.fb2', 'sub/B.EPUB', 'x.mobi', 'y.azw3', 'dump.zip', 'dump.7z', 'New folder', '', null]) {
    assert.equal(isRelevantWatchName(name), true, String(name));
  }
  for (const name of ['a.fb2.part', 'cover.jpg', 'notes.txt', '.hidden', 'Thumbs.db', 'sub/x.tmp']) {
    assert.equal(isRelevantWatchName(name), false, name);
  }
});

test('folder watcher triggers an incremental index after a book appears (indexed sources only)', async () => {
  const watched = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-indexed-'));
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-fresh-'));
  const calls = [];
  try {
    const indexed = addSource({ name: 'Watched', type: 'folder', path: watched, fastScan: true });
    updateSourceIndexedAt(indexed.id);
    const neverIndexed = addSource({ name: 'Never indexed', type: 'folder', path: fresh, fastScan: true });

    startFolderWatcher({ trigger: (id) => { calls.push(id); return true; }, quietMs: 400, reconcileMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500)); // watcher threads start

    fs.writeFileSync(path.join(watched, 'cover.jpg'), 'x');
    fs.writeFileSync(path.join(fresh, 'Автор - Книга.fb2'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.deepEqual(calls, [], 'cover images and never-indexed sources do not trigger indexing');

    fs.writeFileSync(path.join(watched, 'Автор - Книга.fb2'), 'x');
    assert.ok(await waitFor(() => calls.length > 0, 8000), 'a new book triggers indexing');
    assert.deepEqual([...new Set(calls)], [indexed.id]);
    assert.ok(!calls.includes(neverIndexed.id));
  } finally {
    stopFolderWatcher();
    db.prepare('DELETE FROM sources WHERE path IN (?, ?)').run(watched, fresh);
    fs.rmSync(watched, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test('admin settings override env defaults; turning watching off stops triggers and publishes status', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-settings-'));
  const calls = [];
  try {
    assert.deepEqual(getFolderWatchConfig(), { enabled: true, quietSec: 120 });
    setSetting('folder_watch_quiet_sec', '45');
    assert.equal(getFolderWatchConfig().quietSec, 45);
    setSetting('folder_watch_quiet_sec', '5'); // вне диапазона → значение по умолчанию
    assert.equal(getFolderWatchConfig().quietSec, 120);

    const source = addSource({ name: 'Status', type: 'folder', path: folder, fastScan: true });
    updateSourceIndexedAt(source.id);
    startFolderWatcher({ trigger: (id) => { calls.push(id); return true; }, quietMs: 300, reconcileMs: 60_000 });
    assert.ok(
      await waitFor(() => readFolderWatchStatus(getMeta).sources[source.id]?.status === 'watching', 8000),
      'status shows the source as watching'
    );

    setSetting('folder_watch_enabled', '0');
    assert.equal(getFolderWatchConfig().enabled, false);
    reconcileFolderWatchers();
    assert.equal(readFolderWatchStatus(getMeta).enabled, false);
    assert.deepEqual(readFolderWatchStatus(getMeta).sources, {});
    fs.writeFileSync(path.join(folder, 'Автор - Книга.fb2'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.deepEqual(calls, [], 'no indexing while watching is off');
  } finally {
    stopFolderWatcher();
    db.prepare("DELETE FROM settings WHERE key IN ('folder_watch_enabled', 'folder_watch_quiet_sec')").run();
    db.prepare('DELETE FROM sources WHERE path = ?').run(folder);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('folder watcher retries triggering while the indexer is busy', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-busy-'));
  let attempts = 0;
  try {
    const source = addSource({ name: 'Busy', type: 'folder', path: folder, fastScan: true });
    updateSourceIndexedAt(source.id);
    startFolderWatcher({ trigger: () => { attempts += 1; return attempts >= 2; }, quietMs: 300, reconcileMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(path.join(folder, 'Автор - Книга.epub'), 'x');
    assert.ok(await waitFor(() => attempts >= 2, 8000), 'busy indexer → trigger is retried after the next quiet period');
  } finally {
    stopFolderWatcher();
    db.prepare('DELETE FROM sources WHERE path = ?').run(folder);
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
