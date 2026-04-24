import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { getLibraryRoot, getSourceRoot, effectiveSourceFlibustaForBook } from './inpx.js';
import { readArchiveEntryBuffer } from './archives.js';
import {
  readFlibustaAnnotationHtml,
  readFlibustaCover,
  mergeSidecarBinariesIntoFb2Xml,
  resolveLibraryArchiveFile,
  hasCoversArchives,
  hasImagesArchives
} from './flibusta-sidecar.js';

/** Кэш по корню источника: есть ли на диске covers|images (без обхода при каждой книге). */
const coverImageMediaRootCache = new Map();

function rootHasCoverOrImageMedia(root) {
  const key = path.resolve(String(root || ''));
  if (!key) return false;
  if (coverImageMediaRootCache.has(key)) return coverImageMediaRootCache.get(key);
  let v = false;
  try {
    v = hasCoversArchives(key) || hasImagesArchives(key);
  } catch {
    v = false;
  }
  coverImageMediaRootCache.set(key, v);
  return v;
}

/**
 * Пробовать обложку из Flibusta-sidecar (covers/images), если:
 * - effective flibusta в БД, или
 * - на диске у источника реально есть covers/ или images/ (флаг в БД мог быть 0).
 */
function shouldTryFlibustaCoverPaths(book) {
  if (!book?.archiveName) return false;
  if (bookHasFlibustaSidecar(book)) return true;
  const root = getSourceRoot(book.sourceId);
  return rootHasCoverOrImageMedia(root);
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCover(xml) {
  const coverPageMatch = xml.match(/<coverpage[^>]*>([\s\S]*?)<\/coverpage>/i);
  if (!coverPageMatch) {
    return null;
  }

  const imageTagMatch = coverPageMatch[1].match(/<image\b[^>]*\b(?:l:href|xlink:href|href)\s*=\s*(['"])(.*?)\1/i);
  if (!imageTagMatch) {
    return null;
  }

  const rawCoverId = String(imageTagMatch[2] || '').trim().replace(/^#/, '');
  if (!rawCoverId) {
    return null;
  }

  const binaryPattern = new RegExp(
    `<binary\\b(?=[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(rawCoverId)}\\1)(?=[^>]*\\bcontent-type\\s*=\\s*(["'])([^"']+)\\2)[^>]*>([\\s\\S]*?)<\\/binary>`,
    'i'
  );
  const binaryMatch = xml.match(binaryPattern);
  if (!binaryMatch) {
    return null;
  }

  try {
    const data = Buffer.from(binaryMatch[4].replace(/\s+/g, ''), 'base64');
    if (!data.length) return null;
    return {
      contentType: binaryMatch[3],
      data
    };
  } catch {
    return null;
  }
}

/**
 * Flibusta range-archive fallback: archives like f.fb2-862059-866064.zip contain
 * books with numeric IDs in [start, end]. When the INPX-declared archive name
 * doesn't exist on disk (e.g. "usr-ru-ok-poetry.zip"), we scan for range archives
 * that may contain the book by its libId.
 */
const _rangeArchiveCache = new Map();
const RANGE_CACHE_TTL = 120_000;

function findRangeArchive(libraryRoot, book) {
  const libId = Number(book.libId || book.fileName || '');
  if (!Number.isFinite(libId) || libId <= 0) return null;

  const root = path.resolve(libraryRoot);
  const now = Date.now();
  let cached = _rangeArchiveCache.get(root);
  if (!cached || cached.expiresAt < now) {
    const entries = [];
    try {
      for (const f of fs.readdirSync(root)) {
        // Match patterns like: f.fb2-862059-866064.zip, f.usr-862059-866064.zip
        const m = f.match(/^(.+)-(\d+)-(\d+)\.(zip|7z)$/i);
        if (!m) continue;
        const abs = path.join(root, f);
        try { if (!fs.statSync(abs).isFile()) continue; } catch { continue; }
        entries.push({ file: f, start: Number(m[2]), end: Number(m[3]) });
      }
    } catch { /* no access */ }
    cached = { entries, expiresAt: now + RANGE_CACHE_TTL };
    _rangeArchiveCache.set(root, cached);
    // Limit cache size
    if (_rangeArchiveCache.size > 32) {
      const oldest = _rangeArchiveCache.keys().next().value;
      if (oldest !== undefined) _rangeArchiveCache.delete(oldest);
    }
  }

  for (const entry of cached.entries) {
    if (libId >= entry.start && libId <= entry.end) {
      const abs = path.join(root, entry.file);
      if (abs.startsWith(root + path.sep)) return abs;
    }
  }
  return null;
}

export async function readBookBuffer(book) {
  if (!book.archiveName) {
    return readDirectFile(book);
  }

  const libraryRoot = book.sourceId ? getSourceRoot(book.sourceId) : getLibraryRoot();
  const resolvedRoot = path.resolve(libraryRoot);
  let archivePath =
    resolveLibraryArchiveFile(libraryRoot, book.archiveName) ||
    path.resolve(libraryRoot, book.archiveName);

  // Fallback: if the declared archive doesn't exist, try Flibusta range-based archives
  if (!fs.existsSync(archivePath)) {
    const rangePath = findRangeArchive(libraryRoot, book);
    if (rangePath) archivePath = rangePath;
  }

  if (!archivePath.startsWith(resolvedRoot + path.sep) && archivePath !== resolvedRoot) {
    throw new Error('Invalid archive path');
  }
  const normalizedFileName = `${book.fileName}.${book.ext}`;
  return readArchiveEntryBuffer(archivePath, normalizedFileName);
}

async function readDirectFile(book) {
  const sourceRoot = getSourceRoot(book.sourceId);
  const filePath = path.resolve(sourceRoot, `${book.fileName}.${book.ext}`);
  const resolvedRoot = path.resolve(sourceRoot);
  if (!filePath.startsWith(resolvedRoot + path.sep) && filePath !== resolvedRoot) {
    throw new Error('Invalid file path');
  }
  const MAX_BOOK_SIZE = 100 * 1024 * 1024;
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_BOOK_SIZE) {
    throw new Error(`Book file too large: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  }
  return fs.promises.readFile(filePath);
}

export async function readBookXml(book) {
  const buffer = await readBookBuffer(book);
  return decodeFb2BufferToString(buffer);
}

function decodeFb2BufferToString(buffer) {
  const head = buffer.slice(0, 200).toString('latin1');
  const encMatch = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  const declared = (encMatch?.[1] || 'utf-8').toLowerCase().replace(/\s/g, '');
  if (declared === 'windows-1251' || declared === 'cp1251' || declared === 'win-1251') {
    return new TextDecoder('windows-1251').decode(buffer);
  }
  return buffer.toString('utf8');
}

/**
 * FB2 для выдачи в читалку / скачивание / конвертацию: для Flibusta sidecar вшивает обложку и иллюстрации из ZIP.
 */
export async function readBookBufferForDelivery(book) {
  const buffer = await readBookBuffer(book);
  const ext = String(book?.ext || 'fb2').toLowerCase();
  if (ext !== 'fb2' || !shouldTryFlibustaCoverPaths(book)) {
    return buffer;
  }
  try {
    const xml = decodeFb2BufferToString(buffer);
    const root = getSourceRoot(book.sourceId);
    const merged = await mergeSidecarBinariesIntoFb2Xml(xml, book, root);
    return Buffer.from(merged, 'utf8');
  } catch {
    return buffer;
  }
}

async function extractBookDetails(book) {
  const xml = await readBookXml(book);
  const annotationMatch = xml.match(/<annotation[^>]*>([\s\S]*?)<\/annotation>/i);
  const titleMatch = xml.match(/<book-title[^>]*>([\s\S]*?)<\/book-title>/i);
  const cover = extractCover(xml);

  let title = titleMatch ? decodeXml(titleMatch[1]) : book.title;
  if (title.includes('\uFFFD')) title = book.title;
  let annotation = annotationMatch ? decodeXml(annotationMatch[1]) : '';
  if (annotation.includes('\uFFFD')) annotation = '';

  return { title, annotation, cover };
}

/**
 * Для Flibusta sidecar обложку не храним в book_details_cache (как FLibrary — по запросу из архива).
 * При попадании в кэш без обложки подгружаем: ZIP → при отсутствии — из тела FB2.
 */
async function augmentFlibustaCoverIfMissing(cached, book) {
  if (cached.cover?.data?.length) return cached;
  const root = getSourceRoot(book.sourceId);
  try {
    const cov = await readFlibustaCover(root, book.archiveName, book);
    if (cov) return { ...cached, cover: cov };
  } catch {
    /* optional */
  }
  try {
    const xml = await readBookXml(book);
    const cover = extractCover(xml);
    if (cover) return { ...cached, cover };
  } catch {
    /* optional */
  }
  return cached;
}

let _stmtGetCachedDetails;
let _stmtGetStoredAnnotation;
let _stmtSaveCachedDetails;

function getCachedBookDetails(bookId) {
  if (!_stmtGetCachedDetails) {
    _stmtGetCachedDetails = db.prepare(`
      SELECT title, annotation, annotation_is_html AS annotationIsHtml,
             cover_content_type AS contentType, cover_data AS data
      FROM book_details_cache
      WHERE book_id = ?
    `);
  }
  const row = _stmtGetCachedDetails.get(bookId);

  if (!row) {
    return null;
  }

  return {
    title: row.title || '',
    annotation: row.annotation || '',
    annotationIsHtml: Boolean(row.annotationIsHtml),
    cover: row.data ? { contentType: row.contentType, data: row.data } : null
  };
}

/** Аннотация из book_details_cache (для OPDS и пр. — без чтения архива). */
export function getStoredBookAnnotation(bookId) {
  if (!bookId) return '';
  try {
    if (!_stmtGetStoredAnnotation) {
      _stmtGetStoredAnnotation = db.prepare(`SELECT annotation FROM book_details_cache WHERE book_id = ?`);
    }
    const row = _stmtGetStoredAnnotation.get(bookId);
    return row?.annotation || '';
  } catch { return ''; }
}

/** Обложка из book_details_cache без чтения архива (для быстрых ответов /cover). */
export function getStoredBookDetailsCover(book) {
  if (!book?.id) return null;
  try {
    const cached = getCachedBookDetails(book.id);
    const c = cached?.cover;
    if (c?.data && Buffer.isBuffer(c.data) && c.data.length) {
      return { contentType: c.contentType || 'application/octet-stream', data: c.data };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function saveCachedBookDetails(bookId, details) {
  const annHtml = details.annotationIsHtml ? 1 : 0;
  if (!_stmtSaveCachedDetails) {
    _stmtSaveCachedDetails = db.prepare(`
      INSERT INTO book_details_cache (
        book_id, title, annotation, annotation_is_html, cover_content_type, cover_data, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(book_id) DO UPDATE SET
        title = excluded.title,
        annotation = excluded.annotation,
        annotation_is_html = excluded.annotation_is_html,
        cover_content_type = excluded.cover_content_type,
        cover_data = excluded.cover_data,
        updated_at = CURRENT_TIMESTAMP
    `);
  }
  _stmtSaveCachedDetails.run(
    bookId,
    details.title || '',
    details.annotation || '',
    annHtml,
    details.cover?.contentType || null,
    details.cover?.data || null
  );
}

function bookHasFlibustaSidecar(book) {
  return effectiveSourceFlibustaForBook(book) === 1;
}

export async function getOrExtractBookDetails(book, { skipCoverAugment = false } = {}) {
  const cached = getCachedBookDetails(book.id);
  if (cached) {
    if (!skipCoverAugment && shouldTryFlibustaCoverPaths(book)) {
      return augmentFlibustaCoverIfMissing(cached, book);
    }
    return cached;
  }

  let details;
  try {
    details = await extractBookDetails(book);
  } catch {
    details = { title: book.title || '', annotation: '', cover: null };
  }
  if (details.cover && !details.cover.data?.length) details.cover = null;

  if (shouldTryFlibustaCoverPaths(book)) {
    const root = getSourceRoot(book.sourceId);
    try {
      const sideAnn = await readFlibustaAnnotationHtml(root, book.archiveName, book.fileName);
      if (sideAnn && (!details.annotation || !String(details.annotation).trim())) {
        details.annotation = sideAnn;
        details.annotationIsHtml = true;
      }
      if (!details.cover) {
        const cov = await readFlibustaCover(root, book.archiveName, book);
        if (cov) details.cover = cov;
      }
    } catch {
      /* sidecar optional */
    }
  }

  if (!details.annotationIsHtml) details.annotationIsHtml = false;
  try {
    const persist = bookHasFlibustaSidecar(book)
      ? { ...details, cover: null }
      : details;
    saveCachedBookDetails(book.id, persist);
  } catch {
    /* кэш (BLOB) может отказать при ограничениях БД — страница книги не должна падать 500 */
  }
  return details;
}
