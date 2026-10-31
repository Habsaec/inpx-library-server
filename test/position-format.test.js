import test from 'node:test';
import assert from 'node:assert/strict';
import { positionForBookFormat } from '../public/position-sync.js';

const fb2Saved = { position: '', fb2Href: '0#2', fraction: 0.05, progress: 5, sectionIndex: 0, textOffset: 120, textQuote: 'abc', paginatorPage: 3 };
const epubSaved = { position: 'epubcfi(/6/4!/4/2/1:0)', fb2Href: null, fraction: 0.4, progress: 40, sectionIndex: 3, textOffset: 10, textQuote: 'x' };

test('positionForBookFormat: same format is kept as is', () => {
  assert.equal(positionForBookFormat(fb2Saved, true), fb2Saved);
  assert.equal(positionForBookFormat(epubSaved, false), epubSaved);
  assert.equal(positionForBookFormat(null, true), null);
});

test('positionForBookFormat: FB2 position in an EPUB keeps only the fraction', () => {
  const out = positionForBookFormat(fb2Saved, false);
  assert.equal(out.fraction, 0.05);
  assert.equal(out.progress, 5);
  assert.equal(out.fb2Href, null);
  assert.equal(out.sectionIndex, null);
  assert.equal(out.textOffset, null);
  assert.equal(out.paginatorPage, null);
});

test('positionForBookFormat: EPUB CFI in an FB2 keeps only the fraction', () => {
  const out = positionForBookFormat(epubSaved, true);
  assert.equal(out.position, '');
  assert.equal(out.fraction, 0.4);
  assert.equal(out.sectionIndex, null);
});
