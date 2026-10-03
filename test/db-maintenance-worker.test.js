import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

const WORKER_URL = new URL('../src/services/db-maintenance-worker.js', import.meta.url);

function request(worker, id, op) {
  return new Promise((resolve, reject) => {
    const onMessage = (msg) => {
      if (msg?.id !== id) return;
      worker.off('message', onMessage);
      if (msg.ok) resolve(msg);
      else reject(new Error(msg.error || 'maintenance failed'));
    };
    worker.on('message', onMessage);
    worker.postMessage({ id, op });
  });
}

test('maintenance worker checkpoints, analyzes and writes the stats snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpx-maint-'));
  const dbPath = path.join(dir, 'library.db');
  const setup = new Database(dbPath);
  setup.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, enabled INTEGER);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY,
      deleted INTEGER,
      source_id INTEGER,
      lang TEXT
    );
    CREATE TABLE authors (id INTEGER PRIMARY KEY);
    CREATE TABLE series_catalog (id INTEGER PRIMARY KEY);
    CREATE TABLE genres_catalog (id INTEGER PRIMARY KEY);
    INSERT INTO books (id, deleted, source_id, lang) VALUES (1, 0, NULL, 'ru'), (2, 1, NULL, 'en');
    INSERT INTO authors (id) VALUES (1);
  `);
  setup.close();

  const worker = new Worker(WORKER_URL, { workerData: { dbPath }, execArgv: [] });
  try {
    const checkpoint = await request(worker, 1, 'checkpoint');
    assert.equal(checkpoint.ok, true);
    assert.equal(typeof checkpoint.ms, 'number');

    const stats = await request(worker, 2, 'stats');
    assert.equal(stats.totalBooks, 1);
    assert.equal(stats.totalAuthors, 1);
    assert.equal(stats.totalLanguages, 1);

    const analyzed = await request(worker, 3, 'analyze');
    assert.ok(analyzed.tables >= 4);

    const optimized = await request(worker, 4, 'optimize');
    assert.equal(optimized.ok, true);

    const truncate = await request(worker, 5, 'truncate');
    assert.equal(truncate.skipped, true);

    const dbstat = await request(worker, 6, 'dbstat');
    assert.equal(dbstat.supported, true);
    assert.ok(dbstat.rows.some((row) => row.name === 'books' && row.bytes > 0));
  } finally {
    await worker.terminate();
  }

  const check = new Database(dbPath, { readonly: true });
  try {
    const raw = check.prepare(`SELECT value FROM meta WHERE key = 'library_stats_snapshot'`).get()?.value;
    const snapshot = JSON.parse(raw);
    assert.equal(snapshot.totalBooks, 1);
    assert.equal(snapshot.totalAuthors, 1);
    assert.equal(snapshot.totalGenres, 0);
  } finally {
    check.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
