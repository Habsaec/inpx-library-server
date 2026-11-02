import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  GENRE_LABELS, getGenreGroups, formatGenreLabel, genreLabelEn, localizeGenreLabel,
  localizeGenreGroupLabel, withGenreNameEn, formatGenreListEn
} = await import('../src/genre-map.js');
const { GENRE_LABELS_EN, GENRE_GROUP_LABELS_EN } = await import('../src/genre-labels-en.js');
const { runWithLocaleLang } = await import('../src/i18n.js');

test('every known genre code and group has an English name', () => {
  assert.deepEqual(Object.keys(GENRE_LABELS).filter((code) => !GENRE_LABELS_EN[code]), []);
  assert.deepEqual(Object.keys(getGenreGroups()).filter((group) => !GENRE_GROUP_LABELS_EN[group]), []);
});

test('formatGenreLabel stays Russian (stored display_name / search), English is separate', () => {
  runWithLocaleLang('en', () => {
    assert.equal(formatGenreLabel('sf_fantasy'), 'Фэнтези');
  });
  assert.equal(genreLabelEn('sf_fantasy'), 'Fantasy');
  assert.equal(genreLabelEn('SF_FANTASY'), 'Fantasy');
  assert.equal(genreLabelEn('unknown_code'), '');
});

test('localizeGenreLabel follows the request locale and keeps unknown codes', () => {
  runWithLocaleLang('en', () => {
    assert.equal(localizeGenreLabel('love_short'), 'Short Romance');
    assert.equal(localizeGenreLabel('my_genre', 'Мой жанр'), 'Мой жанр');
    assert.equal(localizeGenreLabel('my_genre'), 'my_genre');
    assert.equal(localizeGenreGroupLabel('Детективы'), 'Detective & Thriller');
  });
  runWithLocaleLang('ru', () => {
    assert.equal(localizeGenreLabel('love_short'), 'Короткие любовные романы');
    assert.equal(localizeGenreGroupLabel('Детективы'), 'Детективы');
  });
});

test('withGenreNameEn adds displayNameEn and keeps displayName', () => {
  const rows = withGenreNameEn([
    { name: 'detective', displayName: 'Детективы', bookCount: 3 },
    { name: 'custom', displayName: 'Своё' }
  ]);
  assert.deepEqual(rows[0], { name: 'detective', displayName: 'Детективы', displayNameEn: 'Detective & Mystery', bookCount: 3 });
  assert.equal(rows[1].displayNameEn, 'Своё');
  assert.deepEqual(formatGenreListEn('sf_fantasy:my_code'), ['Fantasy', 'my_code']);
});
