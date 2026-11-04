import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db } from '../src/db.js';
import { getLibraryView, getBookmarksPage } from '../src/inpx.js';
import { parsePersonalCommand } from '../src/services/telegram-bot.js';

before(() => { initDb(); });

test('personal commands: want list and favorites split into books / authors / series', () => {
  assert.deepEqual(parsePersonalCommand('/want'), { kind: 'want' });
  assert.deepEqual(parsePersonalCommand('/хочу@mybot'), { kind: 'want' });
  assert.deepEqual(parsePersonalCommand('/favorites'), { kind: 'favorites' });
  assert.deepEqual(parsePersonalCommand('/fav_books'), { kind: 'favorites-section', section: 'books' });
  assert.deepEqual(parsePersonalCommand('/fav_authors'), { kind: 'favorites-section', section: 'authors' });
  assert.deepEqual(parsePersonalCommand('/fav_series'), { kind: 'favorites-section', section: 'series' });
  assert.equal(parsePersonalCommand('/search x'), null);
});

test('the data behind the bot lists: want_to_read and favorite books', () => {
  const user = 'tg-lists-user';
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT OR IGNORE INTO users(username, password_hash, role) VALUES(?, 'x', 'user')").run(user);
  const sourceId = Number(db.prepare("INSERT INTO sources(name, type, path, enabled) VALUES('tg-test', 'folder', 'tg-test-path', 1)").run().lastInsertRowid);
  db.exec(`INSERT OR REPLACE INTO books(id, title, authors, lib_id, archive_name, file_name, ext, deleted, source_id, title_sort, author_sort)
    VALUES('tg-b1', 'Want me', 'Ivanov,Ivan', '1', 'a.zip', 'f.fb2', 'fb2', 0, ${sourceId}, 'want me', 'ivanov ivan'), ('tg-b2', 'Fav me', 'Petrov,Petr', '2', 'a.zip', 'g.fb2', 'fb2', 0, ${sourceId}, 'fav me', 'petrov petr')`);
  db.prepare('INSERT OR IGNORE INTO want_to_read(username, book_id) VALUES(?, ?)').run(user, 'tg-b1');
  db.prepare('INSERT OR IGNORE INTO bookmarks(username, book_id) VALUES(?, ?)').run(user, 'tg-b2');
  db.pragma('foreign_keys = ON');
  try {
    const want = getLibraryView('want', { username: user, page: 1, pageSize: 8, sort: 'recent' });
    assert.equal(want.total, 1);
    assert.equal(want.items[0].id, 'tg-b1');
    const favs = getBookmarksPage(user, { page: 1, pageSize: 8 });
    assert.equal(favs.total, 1);
    assert.equal(favs.items[0].id, 'tg-b2');
  } finally {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM want_to_read WHERE username = ?').run(user);
    db.prepare('DELETE FROM bookmarks WHERE username = ?').run(user);
    db.prepare("DELETE FROM books WHERE id IN ('tg-b1', 'tg-b2')").run();
    db.prepare("DELETE FROM sources WHERE path = 'tg-test-path'").run();
    db.pragma('foreign_keys = ON');
  }
});
