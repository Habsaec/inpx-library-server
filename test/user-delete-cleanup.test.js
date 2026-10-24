import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, createUser, deleteUser, setMeta, getMeta } from '../src/db.js';

const USER = 'delete_cleanup_user';
const OTHER = 'delete_cleanup_other';

before(() => {
  initDb();
  db.prepare("INSERT OR IGNORE INTO books (id, title) VALUES ('1:del', 'Delete cleanup test')").run();
  for (const username of [USER, OTHER]) {
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      createUser({ username, password: 'CleanupPass1!' });
    }
  }
});

function seed(username) {
  db.prepare('INSERT OR IGNORE INTO read_books (username, book_id) VALUES (?, ?)').run(username, '1:del');
  db.prepare('INSERT OR IGNORE INTO book_ratings (username, book_id, rating) VALUES (?, ?, 4)').run(username, '1:del');
  db.prepare("INSERT INTO reader_annotations (username, book_id, cfi, text) VALUES (?, ?, 'epubcfi(/6/2)', 'note')").run(username, '1:del');
  db.prepare('INSERT OR IGNORE INTO reader_book_revisions (username, book_id) VALUES (?, ?)').run(username, '1:del');
  db.prepare('INSERT OR IGNORE INTO user_reader_revisions (username) VALUES (?)').run(username);
  setMeta(`device_token:${username}:tok1`, JSON.stringify({ user: username, tokenHash: `hash-${username}` }));
  setMeta(`device_token_hash:hash-${username}`, `${username}:tok1`);
  setMeta(`following_seen:${username}`, '2026-01-01');
}

const TABLES = ['read_books', 'book_ratings', 'reader_annotations', 'reader_book_revisions', 'user_reader_revisions'];

function countRows(username) {
  return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE username = ?`).get(username).n]));
}

test('deleteUser removes read marks, ratings, notes, sync revisions and device tokens', () => {
  seed(USER);
  seed(OTHER);
  assert.equal(deleteUser(USER), 1);
  assert.deepEqual(countRows(USER), Object.fromEntries(TABLES.map((t) => [t, 0])));
  assert.equal(getMeta(`device_token:${USER}:tok1`), null);
  assert.equal(getMeta(`device_token_hash:hash-${USER}`), null);
  assert.equal(getMeta(`following_seen:${USER}`), null);
  // Another user's data stays untouched.
  for (const [table, n] of Object.entries(countRows(OTHER))) assert.ok(n >= 1, `${table} kept for other user`);
  assert.ok(getMeta(`device_token:${OTHER}:tok1`));
  assert.ok(getMeta(`device_token_hash:hash-${OTHER}`));
});

test('a user re-created with the same name does not inherit the old device token', () => {
  createUser({ username: USER, password: 'CleanupPass1!' });
  seed(USER);
  deleteUser(USER);
  createUser({ username: USER, password: 'CleanupPass1!' });
  assert.equal(getMeta(`device_token_hash:hash-${USER}`), null);
  deleteUser(USER);
  deleteUser(OTHER);
});
