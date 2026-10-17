import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const { initDb, db } = await import('../src/db.js');
const { listAuthors, resolveAuthorName } = await import('../src/inpx.js');

before(() => {
  initDb();
  db.exec('DELETE FROM book_authors');
  db.exec('DELETE FROM authors');
  const insert = db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run('роулинг,джоан,к.', 'Роулинг, Дж. К.', 'роулинг джоан к', 'роулинг джоан к', 5);
  insert.run('роулинг,джоан', 'Роулинг, Джоан', 'роулинг джоан', 'роулинг джоан', 3);
});

test('listAuthors finds all Rowling variants for initials query', () => {
  const result = listAuthors({ query: 'Дж. К. Роулинг', page: 1, pageSize: 24, sort: 'count' });
  const names = result.items.map((row) => row.name);
  assert.ok(names.includes('роулинг,джоан,к.'));
  assert.ok(names.includes('роулинг,джоан'));
  assert.equal(result.total, 2);
  assert.equal(result.items[0].name, 'роулинг,джоан,к.');
  assert.equal(result.items[0].bookCount, 5);
});

test('resolveAuthorName prefers the alias with more books', () => {
  const search = 'uolles devid foster';
  const insert = db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run('уоллес,дэвид', 'Уоллес Дэвид', search, search, 2);
  insert.run('uolles,devid foster', 'Uolles Devid Foster', search, search, 80);
  assert.equal(resolveAuthorName('уоллес,дэвид'), 'uolles,devid foster');
  assert.equal(resolveAuthorName('Уоллес Дэвид'), 'uolles,devid foster');
  const listed = listAuthors({ query: 'uolles devid foster', page: 1, pageSize: 24, sort: 'count' });
  assert.equal(listed.total, 1);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].name, 'uolles,devid foster');
  assert.equal(listed.items[0].bookCount, 82);
});

test('multi-word author search finds a patronymic without the surname', () => {
  db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    'пушкин,александр сергеевич',
    'Пушкин Александр Сергеевич',
    'пушкин александр сергеевич',
    'пушкин александр сергеевич',
    4
  );
  const tokens = db.prepare(`
    SELECT token FROM author_name_tokens t
    JOIN authors a ON a.id = t.author_id
    WHERE a.name = ?
  `).all('пушкин,александр сергеевич').map((row) => row.token);
  assert.deepEqual(tokens.sort(), ['александр', 'пушкин', 'сергеевич']);

  const listed = listAuthors({ query: 'Александр Сергеевич', page: 1, pageSize: 10, sort: 'count' });
  assert.ok(listed.items.some((row) => row.name === 'пушкин,александр сергеевич'));
  const reversed = listAuthors({ query: 'Сергеевич Пушкин', page: 1, pageSize: 10, sort: 'count' });
  assert.ok(reversed.items.some((row) => row.name === 'пушкин,александр сергеевич'));
});

test('surname prefix finds the author and a given name still matches', () => {
  const bySurname = listAuthors({ query: 'роулинг', page: 1, pageSize: 10, sort: 'count' });
  assert.ok(bySurname.items.some((row) => row.name === 'роулинг,джоан,к.'));

  const byGiven = listAuthors({ query: 'джоан', page: 1, pageSize: 10, sort: 'count' });
  assert.ok(byGiven.items.some((row) => row.name === 'роулинг,джоан'));
});

test('author search sort=count orders by book count ahead of name rank', () => {
  const insert = db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, ?)
  `);
  insert.run('тест,точный', 'Точный', 'тест точный', 'тест точный', 1);
  insert.run('тестовый,много', 'Много', 'тестовый много', 'тестовый много', 50);
  const listed = listAuthors({ query: 'тест', page: 1, pageSize: 10, sort: 'count' });
  const names = listed.items.map((row) => row.name);
  assert.ok(names.indexOf('тестовый,много') >= 0);
  assert.ok(names.indexOf('тестовый,много') < names.indexOf('тест,точный'));
});
