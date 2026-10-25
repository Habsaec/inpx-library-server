import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, db, addSource, reattachMovedFolderUserData } from '../src/db.js';
import { indexFolder } from '../src/folder-indexer.js';

initDb();

const USER = 'mover';

function count(table, bookId) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE book_id = ?`).get(bookId).c;
}

function bookIdByFile(sourceId, fileName) {
  return db.prepare('SELECT id FROM books WHERE source_id = ? AND file_name = ?').get(sourceId, fileName)?.id;
}

function addUserData(bookId) {
  db.prepare('INSERT INTO read_books(username, book_id) VALUES(?, ?)').run(USER, bookId);
  db.prepare('INSERT INTO reading_positions(username, book_id, position, progress) VALUES(?, ?, ?, ?)').run(USER, bookId, 'p', 37);
}

async function withFolder(prefix, fn) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    await fn(folder);
  } finally {
    db.prepare('DELETE FROM books WHERE source_id IN (SELECT id FROM sources WHERE path = ?)').run(folder);
    db.prepare('DELETE FROM sources WHERE path = ?').run(folder);
    db.prepare('DELETE FROM read_books WHERE username = ?').run(USER);
    db.prepare('DELETE FROM reading_positions WHERE username = ?').run(USER);
    db.prepare('DELETE FROM detached_book_refs').run();
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test('renamed and moved files keep read mark and position (incremental folder index)', () => withFolder('folder-move-', async (folder) => {
  fs.writeFileSync(path.join(folder, 'Айзек Азимов - Основание.fb2'), 'x'.repeat(101));
  fs.writeFileSync(path.join(folder, 'Станислав Лем - Солярис.fb2'), 'y'.repeat(202));
  const source = addSource({ name: 'Move', type: 'folder', path: folder, fastScan: true });
  await indexFolder(source, { incremental: false });
  const renamedOld = bookIdByFile(source.id, 'Айзек Азимов - Основание');
  const movedOld = bookIdByFile(source.id, 'Станислав Лем - Солярис');
  addUserData(renamedOld);
  addUserData(movedOld);

  fs.renameSync(path.join(folder, 'Айзек Азимов - Основание.fb2'), path.join(folder, 'Isaac Asimov - Foundation.fb2'));
  fs.mkdirSync(path.join(folder, 'sf'));
  fs.renameSync(path.join(folder, 'Станислав Лем - Солярис.fb2'), path.join(folder, 'sf', 'Станислав Лем - Солярис.fb2'));
  await indexFolder(source, { incremental: true });

  const renamedNew = bookIdByFile(source.id, 'Isaac Asimov - Foundation');
  const movedNew = bookIdByFile(source.id, 'sf/Станислав Лем - Солярис');
  assert.ok(renamedNew && movedNew);
  for (const [oldId, newId] of [[renamedOld, renamedNew], [movedOld, movedNew]]) {
    assert.notEqual(newId, oldId);
    for (const table of ['read_books', 'reading_positions']) {
      assert.equal(count(table, oldId), 0, `${table} left the old id`);
      assert.equal(count(table, newId), 1, `${table} followed the file`);
    }
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM detached_book_refs').get().c, 0, 'refs are consumed');
}));

test('ambiguous move (two equal candidates) stays detached; expired refs are purged', () => withFolder('folder-move-ambiguous-', async (folder) => {
  fs.writeFileSync(path.join(folder, 'A - One.fb2'), 'z'.repeat(64));
  fs.writeFileSync(path.join(folder, 'B - Two.fb2'), 'w'.repeat(64));
  const source = addSource({ name: 'Ambiguous', type: 'folder', path: folder, fastScan: true });
  await indexFolder(source, { incremental: false });
  const oldId = bookIdByFile(source.id, 'A - One');
  addUserData(oldId);

  // Оба файла переименованы, размеры равны: одна старая книга с данными, две новые — не угадываем.
  fs.renameSync(path.join(folder, 'A - One.fb2'), path.join(folder, 'C - Three.fb2'));
  fs.renameSync(path.join(folder, 'B - Two.fb2'), path.join(folder, 'D - Four.fb2'));
  await indexFolder(source, { incremental: true });

  for (const name of ['C - Three', 'D - Four']) {
    const id = bookIdByFile(source.id, name);
    assert.equal(count('read_books', id), 0, `${name} got no guessed user data`);
  }
  assert.equal(count('read_books', oldId), 1, 'orphan rows are kept (hidden by active_books joins)');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM detached_book_refs WHERE old_book_id = ?').get(oldId).c, 1, 'ref stays detached');

  db.prepare("UPDATE detached_book_refs SET detached_at = datetime('now', '-31 days') WHERE old_book_id = ?").run(oldId);
  assert.equal(reattachMovedFolderUserData(source.id, []), 0);
  assert.equal(count('read_books', oldId), 0, 'expired: file treated as deleted');
  assert.equal(count('reading_positions', oldId), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM detached_book_refs').get().c, 0, 'expired ref removed');
}));
