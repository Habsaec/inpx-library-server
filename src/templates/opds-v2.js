/**
 * OPDS 2.0 (JSON) template functions.
 * Spec: https://drafts.opds.io/opds-2.0
 */
import { siteTitleForDisplay, t, tp, FORMAT_LABELS, downloadBookPath, apiBookPath } from './shared.js';
import { opdsBookRelated } from './opds.js';
// OPDS keeps the stored (Russian) genre names, like the genre navigation in routes/opds-v2.js.
import { formatGenreLabel } from '../genre-map.js';
import { unwrapEscapedMarkup } from '../html-sanitize.js';
import { opdsAcquisitions, loadOpdsBookMeta } from '../opds-common.js';


function baseLinks(baseUrl, selfPath) {
  return [
    { rel: 'self', href: selfPath, type: 'application/opds+json' },
    { rel: 'start', href: '/opds/v2', type: 'application/opds+json' },
    { rel: 'search', href: '/opds/v2/search{?query}', type: 'application/opds+json', templated: true }
  ];
}

export function renderOpds2Root(baseUrl, { userEntries = [], hasCollections = false } = {}) {
  const catalogNav = [
    { href: '/opds/v2/new', title: t('opds.nav.new'), type: 'application/opds+json' },
    ...(hasCollections ? [{ href: '/opds/v2/collections', title: t('opds.nav.collections'), type: 'application/opds+json' }] : []),
    { href: '/opds/v2/authors', title: t('opds.nav.authors'), type: 'application/opds+json' },
    { href: '/opds/v2/series', title: t('opds.nav.series'), type: 'application/opds+json' },
    { href: '/opds/v2/titles', title: t('opds.nav.books'), type: 'application/opds+json' },
    { href: '/opds/v2/genres', title: t('opds.nav.genres'), type: 'application/opds+json' }
  ];
  return JSON.stringify({
    metadata: { title: siteTitleForDisplay() },
    links: baseLinks(baseUrl, '/opds/v2'),
    navigation: [...userEntries, ...catalogNav]
  });
}

function navEntryImage(e) {
  return e.image || (e.coverBookId ? `${apiBookPath(e.coverBookId, 'cover')}?opds=1` : '');
}

function navEntryJson(e) {
  const image = navEntryImage(e);
  return {
    href: e.href,
    title: e.title,
    type: 'application/opds+json',
    properties: e.count !== undefined ? { numberOfItems: e.count } : undefined,
    ...(image ? { images: [{ href: image, type: 'image/jpeg' }] } : {}),
  };
}

export function renderOpds2NavigationFeed(baseUrl, { title, selfPath, entries, nextHref = null }) {
  const feed = {
    metadata: { title, numberOfItems: entries.length },
    links: baseLinks(baseUrl, selfPath),
    navigation: entries.map(navEntryJson)
  };
  if (nextHref) {
    feed.links.push({ rel: 'next', href: nextHref, type: 'application/opds+json' });
  }
  return JSON.stringify(feed);
}

function formatPublication(book, meta = null) {
  const authors = String(book.authors || '').split(':').map(a => a.trim()).filter(Boolean);
  const extLower = String(book.ext || 'fb2').toLowerCase();

  // Download links: every format the server offers for this book (opds-common.js)
  const links = opdsAcquisitions(book, meta).map((l) => ({
    rel: 'http://opds-spec.org/acquisition', href: l.href, type: l.type, title: l.title,
    ...(l.length ? { properties: { size: l.length } } : {}),
  }));
  if (book.id) {
    links.push({ rel: 'http://opds-spec.org/image', href: `${apiBookPath(book.id, 'cover')}?opds=1`, type: 'image/webp' });
  }

  const pub = {
    metadata: {
      '@type': 'http://schema.org/Book',
      title: book.title || t('opds.noTitle'),
      author: authors.length ? authors.map(a => ({ name: a })) : [{ name: t('book.authorUnknown') }],
      language: book.lang || 'ru',
      format: extLower,
      ...(meta?.year ? { published: String(meta.year) } : {}),
      ...(meta?.isbn ? { identifier: `urn:isbn:${meta.isbn}` } : {}),
    },
    links,
    images: book.id ? [{ href: `${apiBookPath(book.id, 'cover')}?opds=1`, type: 'image/webp' }] : []
  };

  if (book.annotation) {
    pub.metadata.description = unwrapEscapedMarkup(String(book.annotation)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  if (book.seriesList?.length) {
    pub.metadata.belongsTo = {
      series: book.seriesList.map((s) => ({
        name: s.displayName || s.name,
        position: s.seriesNo ? Number(s.seriesNo) || undefined : undefined
      }))
    };
  } else if (book.series) {
    pub.metadata.belongsTo = { series: [{ name: book.series, position: book.seriesNo ? Number(book.seriesNo) || undefined : undefined }] };
  }

  const genres = String(book.genres || '').split(':').map(g => g.trim()).filter(Boolean);
  if (genres.length) {
    pub.metadata.subject = genres.map(g => ({ name: formatGenreLabel(g), code: g }));
  }

  return pub;
}

export function renderOpds2PublicationsFeed(baseUrl, { title, selfPath, items, nextHref = null, total = null, navEntries = [], paging = null, facets = [] }) {
  const metaById = loadOpdsBookMeta(items);
  const feed = {
    metadata: { title },
    links: baseLinks(baseUrl, selfPath),
    publications: items.map((b) => formatPublication(b, metaById.get(String(b.id)) || null))
  };
  if (paging) {
    total = paging.total;
    nextHref = paging.next || null;
    feed.metadata.itemsPerPage = paging.pageSize;
    feed.metadata.currentPage = paging.page;
    for (const rel of ['first', 'previous', 'last']) {
      if (paging[rel]) feed.links.push({ rel, href: paging[rel], type: 'application/opds+json' });
    }
  }
  if (facets.length) {
    const groups = new Map();
    for (const fct of facets) {
      if (!groups.has(fct.group)) groups.set(fct.group, []);
      groups.get(fct.group).push({ href: fct.href, title: fct.title, type: 'application/opds+json', ...(fct.active ? { rel: 'self' } : {}) });
    }
    feed.facets = [...groups.entries()].map(([group, links]) => ({ metadata: { title: group }, links }));
  }
  if (total !== null) {
    feed.metadata.numberOfItems = total;
  }
  if (navEntries.length) {
    feed.navigation = navEntries.map(navEntryJson);
  }
  if (nextHref) {
    feed.links.push({ rel: 'next', href: nextHref, type: 'application/opds+json' });
  }
  return JSON.stringify(feed);
}

export function renderOpds2BookDetail(baseUrl, book) {
  if (!book) {
    return JSON.stringify({ metadata: { title: t('book.notFound') }, links: baseLinks(baseUrl, '/opds/v2') });
  }
  const pub = formatPublication(book, loadOpdsBookMeta([book]).get(String(book.id)) || null);
  const related = opdsBookRelated(book);
  return JSON.stringify({
    metadata: pub.metadata,
    links: [
      { rel: 'self', href: `/opds/v2/book/${encodeURIComponent(book.id)}`, type: 'application/opds+json' },
      ...pub.links,
      ...related.authors.map((a) => ({ rel: 'related', href: `/opds/v2/authors?prefix=${encodeURIComponent('=' + a.name)}`, type: 'application/opds+json', title: tp('opds.relatedAuthor', { name: a.label }) })),
      ...related.series.map((s) => ({ rel: 'related', href: `/opds/v2/series?prefix=${encodeURIComponent('=' + s.name)}`, type: 'application/opds+json', title: tp('opds.relatedSeries', { name: s.label }) })),
    ],
    images: pub.images
  });
}
