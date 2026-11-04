import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, db, reattachDetachedUserData, encryptValue, decryptValue } from '../src/db.js';
import { initCollections } from '../src/collections.js';
import {
  writePortableBackupFile, importPortableBackup,
  PORTABLE_EXPORTED_TABLES, PORTABLE_SKIPPED_TABLES
} from '../src/services/portable-backup.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbk-'));

before(() => {
  initDb();
  try { initCollections(); } catch { /* collections optional */ }
});

function addBook(id, { lib, arc = 'a.zip', file = 'f.fb2', ext = 'fb2', title = 'T' } = {}) {
  db.prepare(`INSERT OR REPLACE INTO books(id, title, authors, lib_id, archive_name, file_name, ext, deleted, source_id)
    VALUES(?, ?, 'Ivanov,Ivan', ?, ?, ?, ?, 0, 1)`).run(id, title, lib, arc, file, ext);
}

test('every table is classified as exported or skipped', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'books_fts%'").all().map((r) => r.name);
  const unclassified = tables.filter((n) => !PORTABLE_EXPORTED_TABLES.has(n) && !PORTABLE_SKIPPED_TABLES.has(n));
  assert.deepEqual(unclassified, [], 'classify new tables in src/services/portable-backup.js');
});

test('round trip onto a server where book ids differ and an old id collides with another book', async () => {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT OR IGNORE INTO users(username, password_hash, role, email) VALUES('pb-user', 'x', 'user', 'pb@example.com')").run();
  addBook('6:100', { lib: '100' });
  addBook('6:101', { lib: '101', file: 'g.fb2' });
  db.prepare("INSERT OR IGNORE INTO read_books(username, book_id) VALUES('pb-user', '6:100')").run();
  db.prepare("INSERT OR IGNORE INTO book_ratings(username, book_id, rating) VALUES('pb-user', '6:101', 4)").run();
  db.prepare("INSERT OR IGNORE INTO reading_positions(username, book_id, position, progress) VALUES('pb-user', '6:100', 'pos', 42)").run();
  const shelfId = Number(db.prepare("INSERT INTO shelves(username, name) VALUES('pb-user', 'Моя полка')").run().lastInsertRowid);
  db.prepare('INSERT INTO shelf_books(shelf_id, book_id) VALUES(?, ?)').run(shelfId, '6:100');
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('site_name', 'Backup Lib')").run();
  db.pragma('foreign_keys = ON');

  const file = path.join(tmp, 'b.jsonl.gz');
  const counts = await writePortableBackupFile(file, { appVersion: 'test' });
  assert.ok(counts.user >= 1 && counts.read_books === 1 && counts.shelf_book === 1);

  // «new server»: same user missing, the old id '6:100' now belongs to a DIFFERENT book, the real book has a new id
  db.pragma('foreign_keys = OFF');
  for (const t of ['read_books', 'book_ratings', 'reading_positions', 'shelf_books', 'shelves', 'bookmarks']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM users WHERE username = 'pb-user'").run();
  db.prepare("DELETE FROM settings WHERE key = 'site_name'").run();
  db.prepare("DELETE FROM books WHERE id IN ('6:100', '6:101')").run();
  addBook('6:100', { lib: '999', file: 'other.fb2', title: 'Other book' });
  addBook('9:100', { lib: '100' });
  db.pragma('foreign_keys = ON');

  const dry = await importPortableBackup(file, { dryRun: true });
  assert.equal(dry.users.created, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'pb-user'").get().c, 0, 'dry run writes nothing');

  const summary = await importPortableBackup(file);
  assert.equal(summary.users.created, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM read_books WHERE book_id = '6:100'").get().c, 0, 'must not attach to the colliding book');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM read_books WHERE username = 'pb-user' AND book_id = '9:100'").get().c, 1);
  assert.equal(db.prepare("SELECT progress FROM reading_positions WHERE username = 'pb-user' AND book_id = '9:100'").get().progress, 42);
  const shelf = db.prepare("SELECT id FROM shelves WHERE username = 'pb-user' AND name = 'Моя полка'").get();
  assert.ok(shelf);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM shelf_books WHERE shelf_id = ? AND book_id = ?').get(shelf.id, '9:100').c, 1);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'site_name'").get().value, 'Backup Lib');

  // the rating belongs to a book that is not indexed yet: waits as a detached ref, then follows the book
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM book_ratings WHERE username = 'pb-user'").get().c, 1);
  assert.ok(db.prepare("SELECT 1 FROM detached_book_refs WHERE lib_id = '101' AND source_id IS NULL").get());
  db.pragma('foreign_keys = OFF');
  addBook('9:101', { lib: '101', file: 'g.fb2' });
  db.pragma('foreign_keys = ON');
  reattachDetachedUserData(null);
  assert.equal(db.prepare("SELECT rating FROM book_ratings WHERE username = 'pb-user' AND book_id = '9:101'").get().rating, 4);

  // second import changes nothing (existing rows win)
  const again = await importPortableBackup(file);
  assert.ok(again.users.kept >= 1 && again.users.created === 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM shelves WHERE username = 'pb-user'").get().c, 1);
});

test('replaceUsers overwrites an existing account', async () => {
  const file = path.join(tmp, 'c.jsonl.gz');
  db.prepare("INSERT OR IGNORE INTO users(username, password_hash, role) VALUES('pb-admin', 'hash-from-backup', 'admin')").run();
  await writePortableBackupFile(file, { appVersion: 'test' });
  db.prepare("UPDATE users SET password_hash = 'bootstrap', role = 'user' WHERE username = 'pb-admin'").run();
  const kept = await importPortableBackup(file);
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE username = 'pb-admin'").get().password_hash, 'bootstrap');
  assert.ok(kept.users.kept >= 1);
  await importPortableBackup(file, { replaceUsers: true });
  const row = db.prepare("SELECT password_hash, role FROM users WHERE username = 'pb-admin'").get();
  assert.equal(row.password_hash, 'hash-from-backup');
  assert.equal(row.role, 'admin');
});

test('rejects files that are not a portable backup', async () => {
  const bad = path.join(tmp, 'bad.gz');
  fs.writeFileSync(bad, 'not gzip at all');
  await assert.rejects(() => importPortableBackup(bad), (e) => e.code === 'INVALID_BACKUP');
});

test('encrypted secrets travel in plain text and are re-encrypted on import', async () => {
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('smtp_pass', ?)").run(encryptValue('s3cret-pass'));
  const file = path.join(tmp, 'enc.jsonl.gz');
  await writePortableBackupFile(file, { appVersion: 'test' });
  const zlib = await import('node:zlib');
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  assert.ok(text.includes('"s3cret-pass"'), 'exported decrypted');
  db.prepare("DELETE FROM settings WHERE key = 'smtp_pass'").run();
  await importPortableBackup(file);
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value;
  assert.notEqual(stored, 's3cret-pass');
  assert.equal(decryptValue(stored), 's3cret-pass');
});
