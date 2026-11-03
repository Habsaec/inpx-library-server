import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, deleteUser } from '../src/db.js';
import {
  setNotRecommendedAuthor, isNotRecommendedAuthor, getNotRecommendedAuthors,
  authorMatchKey, splitAuthorValues
} from '../src/inpx.js';

test('«Не рекомендовать»: set / toggle / list by the catalog author name', () => {
  initDb();
  db.exec('DELETE FROM not_recommended_authors');
  db.prepare("DELETE FROM authors WHERE name = 'толкин,джон рональд руэл'").run();
  const search = 'толкин джон рональд руэл';
  db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, ?)
  `).run('толкин,джон рональд руэл', 'Толкин Джон Рональд Руэл', search, search, 1);
  db.prepare("INSERT INTO users(username) VALUES('nr-user') ON CONFLICT(username) DO NOTHING").run();

  assert.equal(setNotRecommendedAuthor('nr-user', 'нет такого автора', true), null);
  assert.equal(setNotRecommendedAuthor('nr-user', 'толкин,джон рональд руэл', true), true);
  // Idempotent set, then toggle without `on`.
  assert.equal(setNotRecommendedAuthor('nr-user', 'толкин,джон рональд руэл', true), true);
  assert.equal(isNotRecommendedAuthor('nr-user', 'толкин,джон рональд руэл'), true);
  assert.deepEqual(getNotRecommendedAuthors('nr-user').map((a) => a.name), ['толкин,джон рональд руэл']);
  assert.equal(setNotRecommendedAuthor('nr-user', 'толкин,джон рональд руэл'), false);
  assert.equal(isNotRecommendedAuthor('nr-user', 'толкин,джон рональд руэл'), false);
  assert.equal(getNotRecommendedAuthors('nr-user').length, 0);

  setNotRecommendedAuthor('nr-user', 'толкин,джон рональд руэл', true);
  deleteUser('nr-user');
  assert.equal(getNotRecommendedAuthors('nr-user').length, 0, 'deleteUser clears the list');
});

test('author match key: catalog name equals the book `authors` part (INPX and folder spelling)', () => {
  const key = authorMatchKey('толкин,джон рональд руэл');
  const [inpx] = splitAuthorValues('Толкин,Джон Рональд Руэл:Другой,Автор:');
  assert.equal(authorMatchKey(inpx), key);
  assert.equal(authorMatchKey('Толкин Джон Рональд Руэл'), key);
  assert.notEqual(authorMatchKey('Другой,Автор'), key);
});
