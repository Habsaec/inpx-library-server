import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDb, db, addSource, stashUserDataRefsForSource, reattachDetachedUserData
} from '../src/db.js';
import { indexFolder } from '../src/folder-indexer.js';

initDb();

function count(table, bookId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE book_id = ?`).get(bookId).c;
}

// Тот же порядок действий, что в deleteSourceProgressive (он тянет server.js, который стартует HTTP).
function deleteSourceKeepingUserData(sourceId) {
  stashUserDataRefsForSource(sourceId);
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare('DELETE FROM books WHERE source_id = ?').run(sourceId);
  } finally {
    db.pragma('foreign_keys = ON');
  }
  db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
}

test('user data survives source delete and re-attaches after the source is added again', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-user-data-'));
  const spacer = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-user-data-spacer-'));
  try {
    fs.writeFileSync(path.join(folder, 'Айзек Азимов - Основание.fb2'), 'x');
    const first = addSource({ name: 'First', type: 'folder', path: folder, fastScan: true });
    await indexFolder(first, { incremental: false });
    const oldId = db.prepare('SELECT id FROM books WHERE source_id = ?').get(first.id).id;

    db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run('alice', oldId);
    db.prepare('INSERT INTO bookmarks(username, book_id) VALUES(?, ?)').run('alice', oldId);
    db.prepare('INSERT INTO reading_positions(username, book_id, position, progress) VALUES(?, ?, ?, ?)').run('alice', oldId, 'p', 42);
    db.prepare('INSERT INTO reader_annotations(username, book_id, cfi, text) VALUES(?, ?, ?, ?)').run('alice', oldId, 'cfi', 'quote');

    // Следующий source получит больший id, значит id книги при повторном добавлении изменится.
    addSource({ name: 'Spacer', type: 'folder', path: spacer, fastScan: true });
    deleteSourceKeepingUserData(first.id);

    for (const table of ['read_books', 'bookmarks', 'reading_positions', 'reader_annotations']) {
      assert.equal(count(table, oldId), 1, `${table} kept after source delete`);
    }

    const second = addSource({ name: 'Second', type: 'folder', path: folder, fastScan: true });
    assert.notEqual(second.id, first.id);
    await indexFolder(second, { incremental: false });
    const newId = db.prepare('SELECT id FROM books WHERE source_id = ?').get(second.id).id;
    assert.notEqual(newId, oldId);

    for (const table of ['read_books', 'bookmarks', 'reading_positions', 'reader_annotations']) {
      assert.equal(count(table, oldId), 0, `${table} moved off the old id`);
      assert.equal(count(table, newId), 1, `${table} re-attached to the new book`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM detached_book_refs WHERE old_book_id = ?').get(oldId).c, 0);
    assert.equal(reattachDetachedUserData(second.id), 0, 'second run is a no-op');
  } finally {
    db.prepare('DELETE FROM books WHERE source_id IN (SELECT id FROM sources WHERE path IN (?, ?))').run(folder, spacer);
    db.prepare('DELETE FROM sources WHERE path IN (?, ?)').run(folder, spacer);
    db.prepare("DELETE FROM read_books WHERE username = 'alice'").run();
    db.prepare("DELETE FROM bookmarks WHERE username = 'alice'").run();
    db.prepare("DELETE FROM reading_positions WHERE username = 'alice'").run();
    db.prepare("DELETE FROM reader_annotations WHERE username = 'alice'").run();
    db.prepare('DELETE FROM detached_book_refs').run();
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(spacer, { recursive: true, force: true });
  }
});

test('user data survives a full (non-incremental) reindex of a source', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-user-data-reindex-'));
  try {
    fs.writeFileSync(path.join(folder, 'Станислав Лем - Солярис.fb2'), 'x');
    const source = addSource({ name: 'Reindex', type: 'folder', path: folder, fastScan: true });
    await indexFolder(source, { incremental: false });
    const bookId = db.prepare('SELECT id FROM books WHERE source_id = ?').get(source.id).id;

    db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run('bob', bookId);
    db.prepare('INSERT INTO book_ratings(username, book_id, rating) VALUES(?, ?, ?)').run('bob', bookId, 5);
    db.prepare('INSERT INTO reading_history(username, book_id) VALUES(?, ?)').run('bob', bookId);
    db.prepare('INSERT INTO reader_bookmarks(username, book_id, position, title) VALUES(?, ?, ?, ?)').run('bob', bookId, 'p', 't');

    await indexFolder(source, { incremental: false });

    const newId = db.prepare('SELECT id FROM books WHERE source_id = ?').get(source.id).id;
    for (const table of ['read_books', 'book_ratings', 'reading_history', 'reader_bookmarks']) {
      assert.equal(count(table, newId), 1, `${table} kept after full reindex`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM detached_book_refs').get().c, 0, 'refs are consumed');
  } finally {
    db.prepare('DELETE FROM books WHERE source_id IN (SELECT id FROM sources WHERE path = ?)').run(folder);
    db.prepare('DELETE FROM sources WHERE path = ?').run(folder);
    for (const t of ['read_books', 'book_ratings', 'reading_history', 'reader_bookmarks']) {
      db.prepare(`DELETE FROM ${t} WHERE username = 'bob'`).run();
    }
    db.prepare('DELETE FROM detached_book_refs').run();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('re-attach leaves unmatched refs for a later index', () => {
  db.prepare("INSERT OR IGNORE INTO detached_book_refs(old_book_id, lib_id, archive_name, file_name, ext) VALUES('nomatch', 'l', 'a', 'f', 'fb2')").run();
  assert.equal(reattachDetachedUserData(999999), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM detached_book_refs WHERE old_book_id = 'nomatch'").get().c, 1, 'unmatched ref stays for a later index');
  db.prepare("DELETE FROM detached_book_refs WHERE old_book_id = 'nomatch'").run();
});
