import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatSingleAuthorName } = await import('../src/inpx.js');
const { formatAuthorLabel, capitalizeAuthorNamePart } = await import('../src/genre-map.js');

test('formatSingleAuthorName title-cases INPX lowercase author tokens', () => {
  assert.equal(formatSingleAuthorName('толстой,лев'), 'Толстой Лев');
  assert.equal(formatSingleAuthorName('сапковский,анджей'), 'Сапковский Анджей');
});

test('formatAuthorLabel title-cases catalog author strings', () => {
  assert.equal(formatAuthorLabel('пушкин,александр сергеевич'), 'Пушкин Александр Сергеевич');
  assert.equal(capitalizeAuthorNamePart('джон-рон'), 'Джон-Рон');
});
