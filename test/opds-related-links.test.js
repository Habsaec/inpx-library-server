import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOpdsBookDetail, opdsBookRelated } from '../src/templates/opds.js';
import { renderOpds2BookDetail } from '../src/templates/opds-v2.js';

const book = {
  id: '1:42',
  title: 'Ночной дозор',
  authors: 'Лукьяненко,Сергей,Васильевич:Васильев,Владимир,',
  series: 'Дозоры',
  seriesNo: 1,
  ext: 'fb2',
  lang: 'ru',
  genres: 'sf_fantasy',
};

test('OPDS v1 book entry links to every author and the series (rel=related)', () => {
  const xml = renderOpdsBookDetail('http://x', book);
  const related = [...xml.matchAll(/<link href="([^"]+)" rel="related"[^>]*title="([^"]+)"/g)];
  assert.equal(related.length, 3);
  assert.equal(related[0][1], `/opds/author?author=${encodeURIComponent('=Лукьяненко,Сергей,Васильевич')}`);
  assert.match(related[0][2], /Лукьяненко Сергей Васильевич/);
  assert.equal(related[2][1], `/opds/series?series=${encodeURIComponent('=Дозоры')}`);
  // href with & must stay valid XML
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|#)/);
});

test('OPDS: seriesList wins over books.series, duplicates and empty names dropped', () => {
  const r = opdsBookRelated({ authors: '', series: 'x', seriesList: [{ name: 'дозоры', displayName: 'Дозоры' }, { name: 'ДОЗОРЫ' }, { name: '' }] });
  assert.deepEqual(r.authors, []);
  assert.deepEqual(r.series, [{ name: 'дозоры', label: 'Дозоры' }]);
});

test('OPDS v2 book detail carries the same related links', () => {
  const json = JSON.parse(renderOpds2BookDetail('http://x', book));
  const related = json.links.filter((l) => l.rel === 'related');
  assert.equal(related.length, 3);
  assert.equal(related[2].href, `/opds/v2/series?prefix=${encodeURIComponent('=Дозоры')}`);
});

test('OPDS v1: an HTML annotation is escaped, so the feed stays well-formed XML', () => {
  const xml = renderOpdsBookDetail('http://x', { ...book, annotation: '<p>Охотник&nbsp;и<br>кодекс &laquo;x&raquo;</p>' });
  const content = xml.match(/<content type="text\/html">([\s\S]*?)<\/content>/)[1];
  assert.doesNotMatch(content, /<|&nbsp;|&laquo;/);
  assert.match(content, /&lt;br&gt;/);
});
