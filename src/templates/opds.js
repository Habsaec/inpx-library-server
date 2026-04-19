/**
 * OPDS (Open Publication Distribution System) template functions.
 */
import { escapeHtml, siteTitleForDisplay, t, FORMAT_LABELS, formatGenreLabel } from './shared.js';

function renderOpdsBaseLinks(baseUrl, selfPath, { acquisition = false } = {}) {
  const selfType = acquisition
    ? 'application/atom+xml;profile=opds-catalog;kind=acquisition'
    : 'application/atom+xml;profile=opds-catalog;kind=navigation';

  return `
  <link href="/opds/opensearch" rel="search" type="application/opensearchdescription+xml"/>
  <link href="/opds/search?term={searchTerms}" rel="search" type="application/atom+xml"/>
  <link href="/opds" rel="start" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link href="${escapeHtml(selfPath)}" rel="self" type="${selfType}"/>`;
}

function renderOpdsNavigation(baseUrl, { id, title, selfPath, entries = [] }) {
  const now = new Date().toISOString().substring(0, 19) + 'Z';
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <updated>${now}</updated>
  <id>${escapeHtml(String(id))}</id>
  <title>${escapeHtml(title)}</title>
  ${renderOpdsBaseLinks(baseUrl, selfPath)}
${entries.map((entry) => `  <entry>
    <updated>${now}</updated>
    <id>${escapeHtml(String(entry.id))}</id>
    <title>${escapeHtml(entry.title)}</title>
    <link href="${escapeHtml(entry.href)}" rel="${entry.rel || 'subsection'}" type="application/atom+xml;profile=opds-catalog;kind=${entry.acquisition ? 'acquisition' : 'navigation'}"/>${entry.content ? `
    <content type="${entry.contentType || 'text'}">${escapeHtml(entry.content)}</content>` : ''}
  </entry>
`).join('')}</feed>`;
}

const OPDS_MIME_FOR_SOURCE = {
  fb2: 'application/fb2+zip',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/x-mobipocket-ebook'
};

function renderOpdsBookEntries(baseUrl, items, { includeContent = false } = {}) {
  return items.map((book) => {
    const title = `${book.seriesNo ? `${escapeHtml(String(book.seriesNo))}. ` : ''}${escapeHtml(book.title || t('opds.noTitle'))} (${escapeHtml(book.ext || 'fb2')})`;
    const authors = String(book.authors || '').split(':').map((item) => item.trim()).filter(Boolean);
    const extLower = String(book.ext || 'fb2').toLowerCase();
    const sourceMime = OPDS_MIME_FOR_SOURCE[extLower] || 'application/octet-stream';
    const dl = `/download/${encodeURIComponent(book.id)}?opds=1`;
    const links = [
      `<link href="${dl}" rel="http://opds-spec.org/acquisition" type="${sourceMime}" title="${escapeHtml(FORMAT_LABELS[extLower] || extLower.toUpperCase())}"/>`
    ];
    if (extLower === 'fb2') {
      links.push(`<link href="${dl}&format=epub2" rel="http://opds-spec.org/acquisition" type="application/epub+zip" title="EPUB"/>`);
    }
    if (book.id) {
      links.push(`<link href="/api/books/${encodeURIComponent(book.id)}/cover?opds=1" rel="http://opds-spec.org/image" type="image/jpeg"/>`);
      links.push(`<link href="/api/books/${encodeURIComponent(book.id)}/cover?opds=1" rel="http://opds-spec.org/image/thumbnail" type="image/jpeg"/>`);
    }
    return `
    <entry>
      <title>${title}</title>
      <id>${escapeHtml(book.id)}</id>
      ${authors.length ? authors.map((author) => `<author><name>${escapeHtml(author)}</name></author>`).join('') : `<author><name>${escapeHtml(t('book.authorUnknown'))}</name></author>`}
      <dc:language>${escapeHtml(book.lang || 'ru')}</dc:language>
      ${String(book.genres || '').split(':').map((genre) => genre.trim()).filter(Boolean).map((genre) => `<category term="${escapeHtml(genre)}" label="${escapeHtml(formatGenreLabel(genre))}"/>`).join('')}
      <content type="text">${escapeHtml(book.authors || t('book.authorUnknown'))}${includeContent && book.series ? ` — ${escapeHtml(book.series)}` : ''}</content>
      ${links.join('')}
    </entry>`;
  }).join('');
}

export function renderOpdsRoot(baseUrl) {
  return renderOpdsNavigation(baseUrl, {
    id: 'root',
    title: siteTitleForDisplay(),
    selfPath: '/opds',
    entries: [
      { id: 'author', title: t('opds.nav.authors'), href: '/opds/author' },
      { id: 'series', title: t('opds.nav.series'), href: '/opds/series' },
      { id: 'title', title: t('opds.nav.books'), href: '/opds/title' },
      { id: 'genre', title: t('opds.nav.genres'), href: '/opds/genre' },
      { id: 'search', title: t('opds.nav.search'), href: '/opds/search' },
      { id: 'search_help', title: t('opds.nav.searchHelp'), href: '/opds/search-help', acquisition: true }
    ]
  });
}

export function renderOpdsOpenSearch(baseUrl) {
  return `<?xml version="1.0" encoding="utf-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${escapeHtml(siteTitleForDisplay())}</ShortName>
  <Description>${escapeHtml(t('opds.searchCatalog'))}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="application/atom+xml;profile=opds-catalog;kind=navigation" template="/opds/search?term={searchTerms}"/>
</OpenSearchDescription>`;
}

export function renderOpdsSearchHelp(baseUrl) {
  const now = new Date().toISOString().substring(0, 19) + 'Z';
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <updated>${now}</updated>
  <id>search-help</id>
  <title>${escapeHtml(t('opds.searchHelpTitle'))}</title>
  ${renderOpdsBaseLinks(baseUrl, '/opds/search-help', { acquisition: true })}
  <entry>
    <updated>${now}</updated>
    <id>help</id>
    <title>${escapeHtml(t('opds.searchHelpTitle'))}</title>
    <content type="text">${escapeHtml(t('opds.searchHelpContent'))}</content>
    <link href="/book/fake-link" rel="http://opds-spec.org/acquisition" type="application/fb2+zip"/>
  </entry>
</feed>`;
}

export function renderOpdsSectionFeed(baseUrl, { id, title, selfPath, entries }) {
  return renderOpdsNavigation(baseUrl, { id, title, selfPath, entries });
}

export function renderOpdsBooksFeed(baseUrl, { id, title, selfPath, items }) {
  const now = new Date().toISOString().substring(0, 19) + 'Z';
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <updated>${now}</updated>
  <id>${escapeHtml(String(id))}</id>
  <title>${escapeHtml(title)}</title>
  ${renderOpdsBaseLinks(baseUrl, selfPath, { acquisition: true })}
  ${renderOpdsBookEntries(baseUrl, items)}
</feed>`;
}

export function renderOpdsBookDetail(baseUrl, book) {
  const title = book?.title || t('opds.noTitle');
  const now = new Date().toISOString().substring(0, 19) + 'Z';
  const selfPath = `/opds/book?uid=${encodeURIComponent(book?.id || '')}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <updated>${now}</updated>
  <id>book-${escapeHtml(book?.id || '')}</id>
  <title>${escapeHtml(title)}</title>
  ${renderOpdsBaseLinks(baseUrl, selfPath, { acquisition: true })}
  ${book ? renderOpdsBookEntries(baseUrl, [book], { includeContent: true }) : ''}
</feed>`;
}
