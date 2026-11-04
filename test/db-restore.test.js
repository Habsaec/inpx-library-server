import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import {
  applyPendingDbRestore, resolveRestoreSource, RESTORE_MARKER, RESTORE_RESULT
} from '../src/db-restore-boot.js';
import { startRestoreValidation, getRestoreValidation } from '../src/services/db-restore.js';

const quiet = { log() {}, error() {} };

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dbr-'));
}
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function mark(dir, source, size) {
  fs.writeFileSync(path.join(dir, RESTORE_MARKER), JSON.stringify({ source, size }));
}

test('source ids are an allow-list, never a free path', () => {
  const dir = freshDir();
  for (const good of [
    'backups/library-2026-11-04T10-00-00-manual.db', 'restore/upload-123.db', './library.db.pre-restore-5'
  ]) {
    const r = resolveRestoreSource(dir, good);
    assert.ok(r && r.full.startsWith(dir), good);
  }
  for (const bad of [
    'backups/../library.db', '../x/upload-1.db', 'backups/evil.db', 'library.db', 'restore/../../etc',
    '/library.db.pre-restore-5', '././library.db.pre-restore-5', './library.db', 'backups/library-x.db.bak', '', null
  ]) {
    assert.equal(resolveRestoreSource(dir, bad), null, String(bad));
  }
});

test('boot swap replaces library.db together with its WAL and keeps the old one', () => {
  const dir = freshDir();
  put(path.join(dir, 'library.db'), 'OLD-DB');
  put(path.join(dir, 'library.db-wal'), 'OLD-WAL');
  put(path.join(dir, 'library.db-shm'), 'OLD-SHM');
  const src = 'backups/library-2026-11-04T10-00-00-manual.db';
  put(path.join(dir, src), 'NEW-DB-CONTENT');
  mark(dir, src, 'NEW-DB-CONTENT'.length);

  const result = applyPendingDbRestore(dir, quiet);
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.readFileSync(path.join(dir, 'library.db'), 'utf8'), 'NEW-DB-CONTENT');
  assert.equal(fs.existsSync(path.join(dir, 'library.db-wal')), false, 'stale WAL must not stay next to the new file');
  assert.equal(fs.existsSync(path.join(dir, 'library.db-shm')), false);
  const kept = fs.readdirSync(dir).filter((n) => /^library\.db\.pre-restore-\d+$/.test(n));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), 'OLD-DB');
  assert.equal(fs.existsSync(path.join(dir, src)), true, 'a backups/ source is copied, not consumed');
  assert.equal(fs.existsSync(path.join(dir, RESTORE_MARKER)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, RESTORE_RESULT), 'utf8')).ok, true);
});

test('an uploaded file is moved, and only the newest pre-restore copy is kept', () => {
  const dir = freshDir();
  put(path.join(dir, 'library.db'), 'DB-1');
  put(path.join(dir, 'library.db.pre-restore-1'), 'ANCIENT');
  put(path.join(dir, 'restore', 'upload-42.db'), 'UPLOADED');
  mark(dir, 'restore/upload-42.db', 8);
  assert.equal(applyPendingDbRestore(dir, quiet).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'library.db'), 'utf8'), 'UPLOADED');
  assert.equal(fs.existsSync(path.join(dir, 'restore', 'upload-42.db')), false);
  assert.equal(fs.existsSync(path.join(dir, 'library.db.pre-restore-1')), false);
});

test('a missing or changed source leaves the database untouched', () => {
  const dir = freshDir();
  put(path.join(dir, 'library.db'), 'KEEP-ME');
  mark(dir, 'backups/library-2026-11-04T10-00-00-manual.db', 5);
  const missing = applyPendingDbRestore(dir, quiet);
  assert.equal(missing.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'library.db'), 'utf8'), 'KEEP-ME');
  assert.equal(fs.existsSync(path.join(dir, RESTORE_MARKER)), false);

  const src = 'backups/library-2026-11-04T11-00-00-manual.db';
  put(path.join(dir, src), 'SOMETHING');
  mark(dir, src, 3); // size differs from the validated one
  assert.equal(applyPendingDbRestore(dir, quiet).ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'library.db'), 'utf8'), 'KEEP-ME');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, RESTORE_RESULT), 'utf8')).ok, false);
});

test('a boot interrupted after the rename is finished by the next boot', () => {
  const dir = freshDir();
  const src = 'backups/library-2026-11-04T12-00-00-manual.db';
  put(path.join(dir, src), 'NEW');
  put(path.join(dir, 'library.db.pre-restore-9'), 'ORIGINAL'); // already moved away, library.db is gone
  mark(dir, src, 3);
  assert.equal(applyPendingDbRestore(dir, quiet).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'library.db'), 'utf8'), 'NEW');
});

test('no marker means nothing happens', () => {
  const dir = freshDir();
  put(path.join(dir, 'library.db'), 'X');
  assert.equal(applyPendingDbRestore(dir, quiet), null);
});

test('validation: a healthy database passes, a damaged file fails', async () => {
  const good = `library-2026-11-04T13-00-00-testok.db`;
  const bad = `library-2026-11-04T13-00-01-testbad.db`;
  fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true });
  const db = new Database(path.join(config.dataDir, 'backups', good));
  for (const t of ['books', 'users', 'settings', 'meta', 'sources']) db.exec(`CREATE TABLE ${t}(id INTEGER)`);
  db.exec('INSERT INTO users VALUES(1)');
  db.close();
  fs.writeFileSync(path.join(config.dataDir, 'backups', bad), 'this is not a sqlite database at all, just text');

  const wait = async () => {
    for (let i = 0; i < 100; i += 1) {
      if (getRestoreValidation().state !== 'running') return getRestoreValidation();
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('validation did not finish');
  };
  startRestoreValidation(`backups/${good}`);
  const ok = await wait();
  assert.equal(ok.state, 'ok');
  assert.equal(ok.users, 1);
  startRestoreValidation(`backups/${bad}`);
  assert.equal((await wait()).state, 'failed');
});

test('database copy is taken off-thread and is a valid database', async () => {
  const { initDb, createDatabaseBackup, db } = await import('../src/db.js');
  initDb();
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('zz_copy_probe', 'yes')").run();
  const file = await createDatabaseBackup('offthread-test');
  const copy = new Database(file, { readonly: true });
  try {
    assert.equal(copy.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(copy.prepare("SELECT value FROM settings WHERE key = 'zz_copy_probe'").get().value, 'yes');
  } finally {
    copy.close();
  }
});
