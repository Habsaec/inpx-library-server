/**
 * Shared by OPDS v1 (Atom) and v2 (JSON): acquisition links of a book, extra book metadata for a feed page,
 * paging links / OpenSearch numbers and facets. No templates imported here (they import this module).
 */
import { db } from './db.js';
import { downloadBookPath } from './templates/shared.js';
import {
  FORMAT_LABELS,
  getAvailableDownloadFormats,
  getBookExtraAcquisitions,
  isDownloadFormatEnabled,
} from './download-formats.js';

/** MIME of a book file served as is (the source format). */
export const OPDS_MIME_FOR_SOURCE = {
  fb2: 'application/fb2+zip',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/x-mobipocket-ebook',
  pdf: 'application/pdf',
  djvu: 'image/vnd.djvu',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  txt: 'text/plain',
  rtf: 'application/rtf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

/* MIME of the formats converted from FB2. KEPUB gets its own type (Calibre-Web / KOReader use it to pick a Kobo
   file); KFX / AZW8 are Amazon's — clients that do not know the type still show the title and download it. */
const OPDS_MIME_FOR_CONVERSION = {
  epub3: 'application/epub+zip',
  kepub: 'application/kepub+zip',
  kepub3: 'application/kepub+zip',
  kfx: 'application/vnd.amazon.ebook',
  azw8: 'application/vnd.amazon.ebook',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  fb2: 'application/x-fictionbook+xml',
};

/**
 * Acquisition links of a book: [{ href, type, title, length? }]. The first two links of an FB2 book are the old
 * ones (FB2+ZIP = the default download, EPUB) so clients that remember them keep working; then every other format
 * the admin offers for FB2 (EPUB3, KEPUB, KFX, AZW8, PDF…, disabled ones left out), then stored extra files
 * (Calibre). `meta.size` (bytes) is given only for a file served as is.
 */
export function opdsAcquisitions(book, meta = null) {
  const ext = String(book?.ext || 'fb2').toLowerCase();
  const dl = downloadBookPath(book.id, 'opds=1');
  const links = [];
  if (ext === 'fb2') {
    links.push({ href: dl, type: 'application/fb2+zip', title: 'FB2+ZIP' });
    if (isDownloadFormatEnabled('epub2')) links.push({ href: `${dl}&format=epub2`, type: 'application/epub+zip', title: 'EPUB' });
    for (const format of getAvailableDownloadFormats(book)) {
      if (format === 'fb2zip' || format === 'epub2') continue;
      const type = OPDS_MIME_FOR_CONVERSION[format];
      if (!type) continue;
      links.push({ href: `${dl}&format=${format}`, type, title: FORMAT_LABELS[format] || format.toUpperCase() });
    }
  } else {
    const size = Number(meta?.size) || 0;
    links.push({
      href: dl,
      type: OPDS_MIME_FOR_SOURCE[ext] || 'application/octet-stream',
      title: FORMAT_LABELS[ext] || ext.toUpperCase(),
      ...(size > 0 ? { length: size } : {}),
    });
  }
  for (const extra of getBookExtraAcquisitions(book)) {
    links.push({ href: `${dl}&format=${extra.format}`, type: extra.mime, title: extra.label });
  }
  return links;
}

/**
 * Size, edition year and ISBN for the books of one feed page, in one query: Map id → { size, year, isbn }.
 * Year = FB2 <publish-info> year when the book details were read once (book_details_cache), else the INPX date.
 */
export function loadOpdsBookMeta(items) {
  const ids = [...new Set((items || []).map((b) => b?.id).filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT b.id, b.size, b.date, dc.publish_year AS publishYear, dc.isbn
        FROM books b LEFT JOIN book_details_cache dc ON dc.book_id = b.id
        WHERE b.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    } catch {
      rows = [];
    }
    for (const r of rows) {
      const dateYear = Number(String(r.date || '').slice(0, 4));
      const year = Number(r.publishYear) || (dateYear >= 1000 && dateYear <= 2100 ? dateYear : 0);
      out.set(String(r.id), { size: Number(r.size) || 0, year: year || null, isbn: r.isbn ? String(r.isbn) : '' });
    }
  }
  return out;
}

/** `url` with its `page` query parameter set (page 1 drops it). Relative URLs, like every OPDS href here. */
export function withPage(url, page) {
  const u = new URL(String(url || '/'), 'http://x');
  if (page > 1) u.searchParams.set('page', String(page));
  else u.searchParams.delete('page');
  return u.pathname + (u.search || '');
}

/** `url` with query parameter `name` set to `value` ('' drops it) and paging reset. */
export function withParam(url, name, value) {
  const u = new URL(String(url || '/'), 'http://x');
  if (value) u.searchParams.set(name, String(value));
  else u.searchParams.delete(name);
  u.searchParams.delete('page');
  return u.pathname + (u.search || '');
}

/** Paging of a book feed: { total, page, pageSize, first, previous, next, last } (hrefs '' when absent). */
export function opdsPaging(selfUrl, total, page, pageSize) {
  const n = Math.max(0, Number(total) || 0);
  const size = Math.max(1, Number(pageSize) || 100);
  const p = Math.max(1, Number(page) || 1);
  const lastPage = Math.max(1, Math.ceil(n / size));
  return {
    total: n,
    page: p,
    pageSize: size,
    first: p > 1 ? withPage(selfUrl, 1) : '',
    previous: p > 1 ? withPage(selfUrl, p - 1) : '',
    next: p < lastPage ? withPage(selfUrl, p + 1) : '',
    last: p < lastPage ? withPage(selfUrl, lastPage) : '',
  };
}

/** Atom <updated> of a feed: the current time rounded down to 5 minutes. A per-second stamp changed the body on
 *  every request, so the ETag never matched and clients never got a 304 (feeds are `max-age=300` anyway). */
export function opdsUpdatedStamp(now = Date.now()) {
  const step = 5 * 60_000;
  return new Date(Math.floor(now / step) * step).toISOString().substring(0, 19) + 'Z';
}
