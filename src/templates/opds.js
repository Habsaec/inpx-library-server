/**
 * OPDS (Open Publication Distribution System) template functions.
 */
import { escapeHtml, sanitizeHtml, siteTitleForDisplay, t, FORMAT_LABELS, formatGenreLabel, downloadBookPath, apiBookPath } from './shared.js';
import { unwrapEscapedMarkup } from '../html-sanitize.js';

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
  const now = new Date().toISOString().substring(0, 19) + 'Z';
  return items.map((book) => {
    const title = `${book.seriesNo ? `${escapeHtml(String(book.seriesNo))}. ` : ''}${escapeHtml(book.title || t('opds.noTitle'))} (${escapeHtml(book.ext || 'fb2')})`;
    const authors = String(book.authors || '').split(':').map((item) => item.trim()).filter(Boolean);
    const extLower = String(book.ext || 'fb2').toLowerCase();
    const sourceMime = OPDS_MIME_FOR_SOURCE[extLower] || 'application/octet-stream';
    const dl = downloadBookPath(book.id, 'opds=1');
    const cover = `${apiBookPath(book.id, 'cover')}?opds=1`;

    // Download links — like inpx-web: source format + zip, and conversion to epub for fb2
    const links = [];
    if (extLower === 'fb2') {
      links.push(`<link href="${escapeHtml(dl)}" rel="http://opds-spec.org/acquisition" type="application/fb2+zip" title="FB2+ZIP"/>`);
      links.push(`<link href="${escapeHtml(`${dl}&format=epub2`)}" rel="http://opds-spec.org/acquisition" type="application/epub+zip" title="EPUB"/>`);
    } else if (extLower === 'epub') {
      links.push(`<link href="${escapeHtml(dl)}" rel="http://opds-spec.org/acquisition" type="application/epub+zip" title="EPUB"/>`);
    } else if (extLower === 'mobi') {
      links.push(`<link href="${escapeHtml(dl)}" rel="http://opds-spec.org/acquisition" type="application/x-mobipocket-ebook" title="MOBI"/>`);
    } else {
      links.push(`<link href="${escapeHtml(dl)}" rel="http://opds-spec.org/acquisition" type="${sourceMime}" title="${escapeHtml(FORMAT_LABELS[extLower] || extLower.toUpperCase())}"/>`);
    }
    if (book.id) {
      links.push(`<link href="${escapeHtml(cover)}" rel="http://opds-spec.org/image" type="image/jpeg"/>`);
      links.push(`<link href="${escapeHtml(cover)}" rel="http://opds-spec.org/image/thumbnail" type="image/jpeg"/>`);
    }

    // Series info for summary
    const seriesStr = book.seriesList?.length
      ? book.seriesList.map((s) => [s.displayName || s.name, s.seriesNo].filter(Boolean).join(' #')).join('; ')
      : book.series
        ? [book.series, book.seriesNo].filter(Boolean).join(' #')
        : '';
    const summaryParts = [book.authors || t('book.authorUnknown')];
    if (seriesStr) summaryParts.push(seriesStr);
    const summaryText = summaryParts.join(' \u2014 ');

    // Annotation: prefer HTML if it looks like it contains tags (like inpx-web)
    let contentXml;
    if (book.annotation) {
      const ann = unwrapEscapedMarkup(String(book.annotation));
      const hasHtml = /<[a-z][\s\S]*?>/i.test(ann);
      if (hasHtml) {
        contentXml = `<content type="text/html">${sanitizeHtml(ann)}</content>`;
      } else {
        contentXml = `<content type="text">${escapeHtml(ann.slice(0, 500))}${seriesStr ? ` \u2014 ${escapeHtml(seriesStr)}` : ''}</content>`;
      }
    } else {
      contentXml = `<content type="text">${escapeHtml(summaryText)}</content>`;
    }

    return `
    <entry>
      <title>${title}</title>
      <id>urn:inpx:book:${escapeHtml(String(book.id || ''))}</id>
      <updated>${now}</updated>
      ${authors.length ? authors.map((author) => `<author><name>${escapeHtml(author)}</name></author>`).join('') : `<author><name>${escapeHtml(t('book.authorUnknown'))}</name></author>`}
      <dc:language>${escapeHtml(book.lang || 'ru')}</dc:language>
      <dc:format>${escapeHtml(extLower)}</dc:format>
      ${String(book.genres || '').split(':').map((genre) => genre.trim()).filter(Boolean).map((genre) => `<category term="${escapeHtml(genre)}" label="${escapeHtml(formatGenreLabel(genre))}"/>`).join('')}
      ${contentXml}
      <summary type="text">${escapeHtml(summaryText)}</summary>
      ${links.join('')}
    </entry>`;
  }).join('');
}

export function renderOpdsRoot(baseUrl, { userEntries = [] } = {}) {
  const catalogEntries = [
    { id: 'author', title: t('opds.nav.authors'), href: '/opds/author' },
    { id: 'series', title: t('opds.nav.series'), href: '/opds/series' },
    { id: 'title', title: t('opds.nav.books'), href: '/opds/title' },
    { id: 'genre', title: t('opds.nav.genres'), href: '/opds/genre' }
  ];
  return renderOpdsNavigation(baseUrl, {
    id: 'root',
    title: siteTitleForDisplay(),
    selfPath: '/opds',
    entries: [...userEntries, ...catalogEntries]
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

export function renderOpdsSectionFeed(baseUrl, { id, title, selfPath, entries }) {
  return renderOpdsNavigation(baseUrl, { id, title, selfPath, entries });
}

function renderOpdsNavEntry(now, entry) {
  return `  <entry>
    <updated>${now}</updated>
    <id>${escapeHtml(String(entry.id))}</id>
    <title>${escapeHtml(entry.title)}</title>
    <link href="${escapeHtml(entry.href)}" rel="${entry.rel || 'subsection'}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>${entry.content ? `
    <content type="${entry.contentType || 'text'}">${escapeHtml(entry.content)}</content>` : ''}
  </entry>`;
}

export function renderOpdsBooksFeed(baseUrl, { id, title, selfPath, items, nextHref = '', navEntries = [] }) {
  const now = new Date().toISOString().substring(0, 19) + 'Z';
  const nextLink = nextHref
    ? `\n  <link href="${escapeHtml(nextHref)}" rel="next" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`
    : '';
  const navXml = navEntries.length ? navEntries.map((e) => renderOpdsNavEntry(now, e)).join('\n') + '\n' : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <updated>${now}</updated>
  <id>${escapeHtml(String(id))}</id>
  <title>${escapeHtml(title)}</title>
  ${renderOpdsBaseLinks(baseUrl, selfPath, { acquisition: true })}${nextLink}
${navXml}  ${renderOpdsBookEntries(baseUrl, items)}
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
