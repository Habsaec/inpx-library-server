import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genreSwatchHash, renderGenreSwatch } from '../src/templates/shared.js';

test('genre swatch: same hash as the Android app, genres of one group share a tile', () => {
  assert.equal(genreSwatchHash('abc'), 193409669); // src/lib/__tests__/genrePattern.test.ts in the app
  assert.equal(renderGenreSwatch('sf_space'), renderGenreSwatch('sf_epic'), 'both are «Фантастика»');
  assert.match(renderGenreSwatch('det_classic'), /class="genre-swatch gm-[0-7]" style="--gh:\d{1,3}"/);
});
