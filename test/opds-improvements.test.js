import test from 'node:test';
import assert from 'node:assert/strict';
import { opdsAcquisitions, opdsPaging, withPage, withParam } from '../src/opds-common.js';
import { getAvailableDownloadFormats, setDisabledDownloadFormats } from '../src/download-formats.js';
import { renderOpdsBooksFeed, renderOpdsRoot, renderOpdsSectionFeed } from '../src/templates/opds.js';
import { renderOpds2PublicationsFeed, renderOpds2Root } from '../src/templates/opds-v2.js';

const fb2 = { id: '1:5', title: 'Книга', authors: 'Автор,Имя', ext: 'fb2', lang: 'ru', genres: '' };

test('OPDS acquisitions: old FB2+ZIP / EPUB links first, then every offered format, disabled ones left out', () => {
  setDisabledDownloadFormats([]);
  const links = opdsAcquisitions(fb2);
  assert.equal(links[0].title, 'FB2+ZIP');
  assert.equal(links[1].title, 'EPUB');
  for (const format of getAvailableDownloadFormats(fb2)) {
    if (format === 'fb2zip' || format === 'epub2') continue;
    assert.ok(links.some((l) => l.href.endsWith(`&format=${format}`)), `link for ${format}`);
  }
  setDisabledDownloadFormats(['epub2', 'kepub']);
  const cut = opdsAcquisitions(fb2);
  assert.ok(!cut.some((l) => l.href.endsWith('&format=epub2')));
  assert.ok(!cut.some((l) => l.href.endsWith('&format=kepub')));
  setDisabledDownloadFormats([]);
});

test('OPDS acquisitions: a file served as is carries its size', () => {
  const [link] = opdsAcquisitions({ id: '2:7', ext: 'epub' }, { size: 123456 });
  assert.equal(link.type, 'application/epub+zip');
  assert.equal(link.length, 123456);
});

test('OPDS paging: first / previous / next / last and URL helpers', () => {
  const p = opdsPaging('/opds/series?series=%3Dx&page=2', 350, 2, 100);
  assert.equal(p.first, '/opds/series?series=%3Dx');
  assert.equal(p.previous, '/opds/series?series=%3Dx');
  assert.equal(p.next, '/opds/series?series=%3Dx&page=3');
  assert.equal(p.last, '/opds/series?series=%3Dx&page=4');
  assert.equal(opdsPaging('/opds/new', 50, 1, 100).next, '');
  assert.equal(withPage('/opds/new?sort=title&page=3', 1), '/opds/new?sort=title');
  assert.equal(withParam('/opds/new?sort=title&page=3', 'lang', 'en'), '/opds/new?sort=title&lang=en');
});

test('OPDS v1 books feed: OpenSearch totals, paging links and facets', () => {
  const xml = renderOpdsBooksFeed('http://x', {
    id: 'new', title: 'Новинки', selfPath: '/opds/new', items: [fb2],
    paging: opdsPaging('/opds/new', 250, 2, 100),
    facets: [{ group: 'Сортировка', title: 'По названию', href: '/opds/new?sort=title', active: true }],
  });
  assert.match(xml, /xmlns:opensearch="http:\/\/a9\.com\/-\/spec\/opensearch\/1\.1\/"/);
  assert.match(xml, /<opensearch:totalResults>250<\/opensearch:totalResults>/);
  assert.match(xml, /<opensearch:startIndex>101<\/opensearch:startIndex>/);
  for (const rel of ['first', 'previous', 'next', 'last']) assert.match(xml, new RegExp(`rel="${rel}"`));
  assert.match(xml, /rel="http:\/\/opds-spec\.org\/facet"[^>]*opds:facetGroup="Сортировка" opds:activeFacet="true"/);
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|#)/);
});

test('OPDS v1: root offers «Новинки» (and «Подборки» when there are any), nav entries carry a picture', () => {
  assert.match(renderOpdsRoot('http://x'), /href="\/opds\/new"/);
  assert.doesNotMatch(renderOpdsRoot('http://x'), /\/opds\/collections/);
  assert.match(renderOpdsRoot('http://x', { hasCollections: true }), /href="\/opds\/collections"/);
  const nav = renderOpdsSectionFeed('http://x', { id: 's', title: 'S', selfPath: '/opds/series', entries: [{ id: 'a', title: 'A', href: '/opds/series?series=%3Da', coverBookId: '1:5' }] });
  assert.match(nav, /rel="http:\/\/opds-spec\.org\/image\/thumbnail"/);
});

test('OPDS v2: paging, facets, root entries', () => {
  const feed = JSON.parse(renderOpds2PublicationsFeed('http://x', {
    title: 'Новинки', selfPath: '/opds/v2/new', items: [fb2],
    paging: opdsPaging('/opds/v2/new', 250, 2, 100),
    facets: [{ group: 'Язык', title: 'Все языки', href: '/opds/v2/new', active: true }, { group: 'Язык', title: 'EN', href: '/opds/v2/new?lang=en' }],
  }));
  assert.equal(feed.metadata.numberOfItems, 250);
  assert.equal(feed.metadata.currentPage, 2);
  assert.ok(feed.links.some((l) => l.rel === 'next' && l.href === '/opds/v2/new?page=3'));
  assert.ok(feed.links.some((l) => l.rel === 'first'));
  assert.equal(feed.facets[0].metadata.title, 'Язык');
  assert.equal(feed.facets[0].links[0].rel, 'self');
  assert.ok(feed.publications[0].links.length >= 2);
  const root = JSON.parse(renderOpds2Root('http://x', { hasCollections: true }));
  assert.ok(root.navigation.some((n) => n.href === '/opds/v2/new'));
  assert.ok(root.navigation.some((n) => n.href === '/opds/v2/collections'));
});
