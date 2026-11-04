import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, db, setMeta } from '../src/db.js';
import { seriesCatalogKey, mergeSeriesCatalogByKey, resolveSeriesCatalogName } from '../src/inpx.js';

before(() => { initDb(); });

test('seriesCatalogKey folds case, ё/е, punctuation and spaces but keeps numbers', () => {
  const key = seriesCatalogKey('Линия грёз');
  assert.equal(key, 'линия грез');
  for (const variant of ['линия грез', 'Линия  грёз.', 'ЛИНИЯ ГРЁЗ', 'Линия-грёз', '«Линия грёз»']) {
    assert.equal(seriesCatalogKey(variant), key, variant);
  }
  assert.notEqual(seriesCatalogKey('Дюна'), seriesCatalogKey('Дюна 2'));
});

test('merge repoints books and favorites before deleting the loser row', async () => {
  const user = 'series-merge-user';
  db.prepare("INSERT INTO users(username) VALUES(?) ON CONFLICT(username) DO NOTHING").run(user);
  const ins = db.prepare('INSERT INTO series_catalog(name, display_name, sort_name, search_name, book_count) VALUES(?, ?, ?, ?, ?)');
  const winner = Number(ins.run('сплит серия-а', 'Сплит серия-а', 'x', 'сплит серия-а', 5).lastInsertRowid);
  const loser = Number(ins.run('сплит  серия а.', 'Сплит серия а.', 'x', 'сплит серия а', 1).lastInsertRowid);
  db.pragma('foreign_keys = OFF'); // fake book ids; the series FKs are what this test is about
  const link = db.prepare('INSERT INTO book_series(book_id, series_id, series_no) VALUES(?, ?, ?)');
  link.run('merge-b1', winner, '1');
  link.run('merge-b2', loser, '2');
  link.run('merge-b1', loser, '1'); // same book in both variants — must not end up linked twice
  db.pragma('foreign_keys = ON');
  db.prepare('INSERT INTO favorite_series(username, series_id) VALUES(?, ?)').run(user, loser);

  setMeta('series_key_merge_v1', '');
  await mergeSeriesCatalogByKey();

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM series_catalog WHERE id = ?').get(loser).c, 0);
  const row = db.prepare('SELECT name FROM series_catalog WHERE id = ?').get(winner);
  assert.equal(row.name, 'сплит серия а');
  const links = db.prepare('SELECT book_id FROM book_series WHERE series_id = ? ORDER BY book_id').all(winner).map((r) => r.book_id);
  assert.deepEqual(links, ['merge-b1', 'merge-b2']);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM favorite_series WHERE username = ? AND series_id = ?').get(user, winner).c, 1);
  assert.equal(resolveSeriesCatalogName('Сплит-серия, а'), 'сплит серия а');

  db.prepare('DELETE FROM book_series WHERE series_id = ?').run(winner);
  db.prepare('DELETE FROM series_catalog WHERE id = ?').run(winner);
  db.prepare('DELETE FROM users WHERE username = ?').run(user);
});
