/**
 * OPDS 2.0 (JSON) template functions.
 * Spec: https://drafts.opds.io/opds-2.0
 */
import { siteTitleForDisplay, t, FORMAT_LABELS, formatGenreLabel } from './shared.js';

const OPDS_MIME_FOR_SOURCE = {
  fb2: 'application/fb2+zip',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/x-mobipocket-ebook'
};

function baseLinks(baseUrl, selfPath) {
  return [
    { rel: 'self', href: selfPath, type: 'application/opds+json' },
    { rel: 'start', href: '/opds/v2', type: 'application/opds+json' },
    { rel: 'search', href: '/opds/v2/search{?query}', type: 'application/opds+json', templated: true }
  ];
}

export function renderOpds2Root(baseUrl) {
  return JSON.stringify({
    metadata: { title: siteTitleForDisplay() },
    links: baseLinks(baseUrl, '/opds/v2'),
    navigation: [
      { href: '/opds/v2/authors', title: t('opds.nav.authors'), type: 'application/opds+json' },
      { href: '/opds/v2/series', title: t('opds.nav.series'), type: 'application/opds+json' },
      { href: '/opds/v2/titles', title: t('opds.nav.books'), type: 'application/opds+json' },
      { href: '/opds/v2/genres', title: t('opds.nav.genres'), type: 'application/opds+json' },
      { href: '/opds/v2/search', title: t('opds.nav.search'), type: 'application/opds+json' }
    ]
  });
}

export function renderOpds2NavigationFeed(baseUrl, { title, selfPath, entries, nextHref = null }) {
  const feed = {
    metadata: { title, numberOfItems: entries.length },
    links: baseLinks(baseUrl, selfPath),
    navigation: entries.map(e => ({
      href: e.href,
      title: e.title,
      type: 'application/opds+json',
      properties: e.count !== undefined ? { numberOfItems: e.count } : undefined
    }))
  };
  if (nextHref) {
    feed.links.push({ rel: 'next', href: nextHref, type: 'application/opds+json' });
  }
  return JSON.stringify(feed);
}

function formatPublication(book) {
  const authors = String(book.authors || '').split(':').map(a => a.trim()).filter(Boolean);
  const extLower = String(book.ext || 'fb2').toLowerCase();
  const sourceMime = OPDS_MIME_FOR_SOURCE[extLower] || 'application/octet-stream';
  const dl = `/download/${encodeURIComponent(book.id)}?opds=1`;

  const links = [
    { rel: 'http://opds-spec.org/acquisition', href: dl, type: sourceMime, title: FORMAT_LABELS[extLower] || extLower.toUpperCase() }
  ];
  if (extLower === 'fb2') {
    links.push({ rel: 'http://opds-spec.org/acquisition', href: `${dl}&format=epub2`, type: 'application/epub+zip', title: 'EPUB' });
  }
  if (book.id) {
    links.push({ rel: 'http://opds-spec.org/image', href: `/api/books/${encodeURIComponent(book.id)}/cover?opds=1`, type: 'image/webp' });
  }

  const pub = {
    metadata: {
      '@type': 'http://schema.org/Book',
      title: book.title || t('opds.noTitle'),
      author: authors.length ? authors.map(a => ({ name: a })) : [{ name: t('book.authorUnknown') }],
      language: book.lang || 'ru'
    },
    links,
    images: book.id ? [{ href: `/api/books/${encodeURIComponent(book.id)}/cover?opds=1`, type: 'image/webp' }] : []
  };

  if (book.annotation) {
    pub.metadata.description = String(book.annotation).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  if (book.series) {
    pub.metadata.belongsTo = { series: [{ name: book.series, position: book.seriesNo ? Number(book.seriesNo) || undefined : undefined }] };
  }

  const genres = String(book.genres || '').split(':').map(g => g.trim()).filter(Boolean);
  if (genres.length) {
    pub.metadata.subject = genres.map(g => ({ name: formatGenreLabel(g), code: g }));
  }

  return pub;
}

export function renderOpds2PublicationsFeed(baseUrl, { title, selfPath, items, nextHref = null, total = null }) {
  const feed = {
    metadata: { title },
    links: baseLinks(baseUrl, selfPath),
    publications: items.map(formatPublication)
  };
  if (total !== null) {
    feed.metadata.numberOfItems = total;
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
  const pub = formatPublication(book);
  return JSON.stringify({
    metadata: pub.metadata,
    links: [
      { rel: 'self', href: `/opds/v2/book/${encodeURIComponent(book.id)}`, type: 'application/opds+json' },
      ...pub.links
    ],
    images: pub.images
  });
}
