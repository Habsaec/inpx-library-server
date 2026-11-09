/**
 * OPDS (Open Publication Distribution System) template functions.
 */
import { escapeHtml, sanitizeHtml, siteTitleForDisplay, t, FORMAT_LABELS, downloadBookPath, apiBookPath } from './shared.js';
// OPDS keeps the stored (Russian) genre names, like the genre navigation in routes/opds.js.
import { formatGenreLabel } from '../genre-map.js';
import { unwrapEscapedMarkup } from '../html-sanitize.js';
import { withOpdsProgress } from '../opds-progress.js';
import { tp } from './shared.js';

/** Authors / series of a book for «Все книги автора / серии» links: raw catalog names + display labels. */
export function opdsBookRelated(book) {
  const authors = String(book?.authors || '').split(':').map((a) => a.trim()).filter(Boolean)
    .slice(0, 5)
    .map((name) => ({ name, label: name.split(',').map((p) => p.trim()).filter(Boolean).join(' ') || name }));
  const seen = new Set();
  const series = [];
  const list = Array.isArray(book?.seriesList) && book.seriesList.length
    ? book.seriesList.map((s) => ({ name: s.name, label: s.displayName || s.name }))
    : (book?.series ? [{ name: book.series, label: book.series }] : []);
  for (const s of list) {
    const key = String(s.name || '').trim();
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    series.push({ name: key, label: String(s.label || key) });
  }
  return { authors, series: series.slice(0, 3) };
}
import { opdsAcquisitions, loadOpdsBookMeta, opdsUpdatedStamp } from '../opds-common.js';

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
  const now = opdsUpdatedStamp();
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
    <link href="${escapeHtml(entry.href)}" rel="${entry.rel || 'subsection'}" type="application/atom+xml;profile=opds-catalog;kind=${entry.acquisition ? 'acquisition' : 'navigation'}"/>${renderOpdsEntryImage(entry)}${entry.content ? `
    <content type="${entry.contentType || 'text'}">${escapeHtml(entry.content)}</content>` : ''}
  </entry>
`).join('')}</feed>`;
}

/** Cover of a series (first volume) / portrait of an author / cover of a collection on a navigation entry. */
function renderOpdsEntryImage(entry) {
  const href = entry.image || (entry.coverBookId ? `${apiBookPath(entry.coverBookId, 'cover')}?opds=1` : '');
  if (!href) return '';
  return `
    <link href="${escapeHtml(href)}" rel="http://opds-spec.org/image" type="image/jpeg"/>
    <link href="${escapeHtml(href)}" rel="http://opds-spec.org/image/thumbnail" type="image/jpeg"/>`;
}

function renderOpdsBookEntries(baseUrl, items, { includeContent = false } = {}) {
  const now = opdsUpdatedStamp();
  const metaById = loadOpdsBookMeta(items);
  return items.map((book) => {
    const title = `${book.opdsProgressIcon ? `${book.opdsProgressIcon} ` : ''}${book.seriesNo ? `${escapeHtml(String(book.seriesNo))}. ` : ''}${escapeHtml(book.title || t('opds.noTitle'))} (${escapeHtml(book.ext || 'fb2')})`;
    const authors = String(book.authors || '').split(':').map((item) => item.trim()).filter(Boolean);
    const extLower = String(book.ext || 'fb2').toLowerCase();
    const cover = `${apiBookPath(book.id, 'cover')}?opds=1`;
    const meta = metaById.get(String(book.id)) || null;

    // Download links: every format the server offers for this book (opds-common.js)
    const links = opdsAcquisitions(book, meta).map((l) =>
      `<link href="${escapeHtml(l.href)}" rel="http://opds-spec.org/acquisition" type="${escapeHtml(l.type)}" title="${escapeHtml(l.title)}"${l.length ? ` length="${l.length}"` : ''}/>`);
    const related = opdsBookRelated(book);
    for (const a of related.authors) {
      links.push(`<link href="${escapeHtml(`/opds/author?author=${encodeURIComponent('=' + a.name)}`)}" rel="related" type="application/atom+xml;profile=opds-catalog;kind=acquisition" title="${escapeHtml(tp('opds.relatedAuthor', { name: a.label }))}"/>`);
    }
    for (const s of related.series) {
      links.push(`<link href="${escapeHtml(`/opds/series?series=${encodeURIComponent('=' + s.name)}`)}" rel="related" type="application/atom+xml;profile=opds-catalog;kind=acquisition" title="${escapeHtml(tp('opds.relatedSeries', { name: s.label }))}"/>`);
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
        // Escaped, as Atom wants for HTML content: raw `<br>` / `&nbsp;` from annotations made the whole feed invalid XML.
        contentXml = `<content type="text/html">${escapeHtml(sanitizeHtml(ann))}</content>`;
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
      <dc:format>${escapeHtml(extLower)}</dc:format>${meta?.year ? `
      <dc:issued>${meta.year}</dc:issued>` : ''}${meta?.isbn ? `
      <dc:identifier>urn:isbn:${escapeHtml(meta.isbn)}</dc:identifier>` : ''}
      ${String(book.genres || '').split(':').map((genre) => genre.trim()).filter(Boolean).map((genre) => `<category term="${escapeHtml(genre)}" label="${escapeHtml(formatGenreLabel(genre))}"/>`).join('')}
      ${contentXml}
      <summary type="text">${escapeHtml(summaryText)}</summary>
      ${links.join('')}
    </entry>`;
  }).join('');
}

export function renderOpdsRoot(baseUrl, { userEntries = [], hasCollections = false } = {}) {
  const catalogEntries = [
    { id: 'new', title: t('opds.nav.new'), href: '/opds/new', acquisition: true, content: t('opds.nav.newDesc') },
    ...(hasCollections ? [{ id: 'collections', title: t('opds.nav.collections'), href: '/opds/collections', content: t('opds.nav.collectionsDesc') }] : []),
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
    <link href="${escapeHtml(entry.href)}" rel="${entry.rel || 'subsection'}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>${renderOpdsEntryImage(entry)}${entry.content ? `
    <content type="${entry.contentType || 'text'}">${escapeHtml(entry.content)}</content>` : ''}
  </entry>`;
}

const ACQ_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition';

/** first / previous / next / last links and OpenSearch totals of a paged feed (opdsPaging); falls back to nextHref. */
function renderOpdsPagingXml(paging, nextHref) {
  if (!paging) {
    return nextHref ? `\n  <link href="${escapeHtml(nextHref)}" rel="next" type="${ACQ_TYPE}"/>` : '';
  }
  const links = ['first', 'previous', 'next', 'last']
    .filter((rel) => paging[rel])
    .map((rel) => `\n  <link href="${escapeHtml(paging[rel])}" rel="${rel}" type="${ACQ_TYPE}"/>`)
    .join('');
  return `${links}
  <opensearch:totalResults>${paging.total}</opensearch:totalResults>
  <opensearch:itemsPerPage>${paging.pageSize}</opensearch:itemsPerPage>
  <opensearch:startIndex>${(paging.page - 1) * paging.pageSize + 1}</opensearch:startIndex>`;
}

/** OPDS 1.2 facets: [{ group, title, href, active }] (sort / language of a feed). */
function renderOpdsFacetsXml(facets) {
  return (facets || []).map((f) =>
    `\n  <link href="${escapeHtml(f.href)}" rel="http://opds-spec.org/facet" type="${ACQ_TYPE}" title="${escapeHtml(f.title)}" opds:facetGroup="${escapeHtml(f.group)}"${f.active ? ' opds:activeFacet="true"' : ''}/>`).join('');
}

export function renderOpdsBooksFeed(baseUrl, { id, title, selfPath, items, nextHref = '', navEntries = [], username = '', paging = null, facets = [] }) {
  const now = opdsUpdatedStamp();
  const nextLink = renderOpdsPagingXml(paging, nextHref) + renderOpdsFacetsXml(facets);
  const navXml = navEntries.length ? navEntries.map((e) => renderOpdsNavEntry(now, e)).join('\n') + '\n' : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <updated>${now}</updated>
  <id>${escapeHtml(String(id))}</id>
  <title>${escapeHtml(title)}</title>
  ${renderOpdsBaseLinks(baseUrl, selfPath, { acquisition: true })}${nextLink}
${navXml}  ${renderOpdsBookEntries(baseUrl, withOpdsProgress(items, username))}
</feed>`;
}

export function renderOpdsBookDetail(baseUrl, book, { username = '' } = {}) {
  const title = book?.title || t('opds.noTitle');
  const now = opdsUpdatedStamp();
  const selfPath = `/opds/book?uid=${encodeURIComponent(book?.id || '')}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <updated>${now}</updated>
  <id>book-${escapeHtml(book?.id || '')}</id>
  <title>${escapeHtml(title)}</title>
  ${renderOpdsBaseLinks(baseUrl, selfPath, { acquisition: true })}
  ${book ? renderOpdsBookEntries(baseUrl, withOpdsProgress([book], username), { includeContent: true }) : ''}
</feed>`;
}
