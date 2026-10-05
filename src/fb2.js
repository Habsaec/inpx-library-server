import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { statSyncCached } from './utils/fs-probe.js';
import { getLibraryRoot, getSourceRoot, effectiveSourceFlibustaForBook } from './inpx.js';
import { readArchiveEntryBuffer } from './archives.js';
import { isSevenZipPath } from './seven-zip.js';
import { detectImageMimeFromBuffer } from './services/cover.js';
import {
  readFlibustaAnnotationHtml,
  readFlibustaCover,
  mergeSidecarBinariesIntoFb2Xml,
  resolveLibraryArchiveFile,
  hasCoversArchives,
  hasImagesArchives
} from './flibusta-sidecar.js';
import { ensureEpubZipFromBookBuffer } from './epub-seven-zip.js';
import { normalizeCachedAnnotation, unwrapEscapedMarkup } from './html-sanitize.js';

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

  const binaryTagMatch = xml.match(new RegExp(
    `<binary\\b[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(rawCoverId)}\\1[^>]*>`,
    'i'
  ));
  if (!binaryTagMatch) {
    return null;
  }

  const contentTypeMatch = binaryTagMatch[0].match(/content-type\s*=\s*(['"])([^'"]+)\1/i);
  const contentType = contentTypeMatch ? contentTypeMatch[2] : 'image/jpeg';

  const binaryContentMatch = xml.match(new RegExp(
    `<binary\\b[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(rawCoverId)}\\1[^>]*>([\\s\\S]*?)<\\/binary>`,
    'i'
  ));
  if (!binaryContentMatch) {
    return null;
  }

  try {
    const data = Buffer.from(binaryContentMatch[2].replace(/\s+/g, ''), 'base64');
    if (!data.length) return null;
    return { contentType, data };
  } catch {
    return null;
  }
}

/** Fallback-обложка из файла рядом с книгой (для книг без archiveName). */
function findNearFileCover(book) {
  if (book.archiveName) return null;
  try {
    const sourceRoot = getSourceRoot(book.sourceId);
    const bookPath = path.resolve(sourceRoot, `${book.fileName}.${book.ext}`);
    const dir = path.dirname(bookPath);
    const base = path.basename(bookPath, `.${book.ext}`);
    const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
    const candidates = [
      ...exts.map((e) => path.join(dir, base + e)),
      ...exts.flatMap((e) => [
        path.join(dir, 'cover' + e),
        path.join(dir, 'folder' + e)
      ])
    ];
    for (const p of candidates) {
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size === 0 || st.size > 10 * 1024 * 1024) continue;
        const data = fs.readFileSync(p);
        const mime = detectImageMimeFromBuffer(data);
        if (mime) return { contentType: mime, data };
      } catch {
        /* ignore missing files */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
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
        try { const st = statSyncCached(abs); if (!st || !st.isFile()) continue; } catch { continue; }
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

/** Книга лежит в .7z (в т.ч. INPX пишет .zip, а на диске — одноимённый .7z). */
export function bookUsesSevenZipArchive(book) {
  if (!book?.archiveName) return false;
  if (isSevenZipPath(book.archiveName)) return true;
  try {
    const root = book.sourceId ? getSourceRoot(book.sourceId) : getLibraryRoot();
    if (!root) return false;
    const resolved = resolveLibraryArchiveFile(root, book.archiveName);
    return resolved ? isSevenZipPath(resolved) : false;
  } catch {
    return false;
  }
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
  let buffer = await readBookBuffer(book);
  const ext = String(book?.ext || 'fb2').toLowerCase();
  if (ext === 'epub') {
    buffer = await ensureEpubZipFromBookBuffer(buffer, book, getSourceRoot(book.sourceId));
  }
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
  let cover = extractCover(xml);
  if (!cover) cover = findNearFileCover(book);

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

  const annotation = normalizeCachedAnnotation(row.annotation, row.annotationIsHtml);
  return {
    title: row.title || '',
    annotation: annotation.annotation,
    annotationIsHtml: annotation.annotationIsHtml,
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
    return unwrapEscapedMarkup(row?.annotation || '');
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

const failedExtractCache = new Map();
const FAILED_EXTRACT_TTL_MS = 600_000; // 10 минут: при постоянно битом архиве не пытаться перечитывать каждый запрос.

export async function getOrExtractBookDetails(book, { skipCoverAugment = false } = {}) {
  const cached = getCachedBookDetails(book.id);
  if (cached) {
    if (!cached.cover && !book.archiveName) {
      const nearCover = findNearFileCover(book);
      if (nearCover) return { ...cached, cover: nearCover };
    }
    if (!skipCoverAugment && shouldTryFlibustaCoverPaths(book)) {
      return augmentFlibustaCoverIfMissing(cached, book);
    }
    return cached;
  }

  // Если недавно уже падали при чтении этой книги — не повторяем, сразу возвращаем fallback.
  const failEntry = failedExtractCache.get(book.id);
  if (failEntry && Date.now() - failEntry.ts < FAILED_EXTRACT_TTL_MS) {
    return failEntry.details;
  }

  let details = {
    title: book.title || '',
    annotation: '',
    annotationIsHtml: false,
    cover: null
  };
  let extractFailed = false;

  /*
   * Flibusta: prefer sidecar annotation/cover BEFORE unzipping the book archive.
   * Book page SSR uses skipCoverAugment and only needs annotation — opening fb2.zip
   * on NAS made /book/:id multi-second even when annotations.7z already had the text.
   */
  if (shouldTryFlibustaCoverPaths(book)) {
    const root = getSourceRoot(book.sourceId);
    try {
      const sideAnn = await readFlibustaAnnotationHtml(root, book.archiveName, book.fileName);
      if (sideAnn) {
        details.annotation = sideAnn;
        details.annotationIsHtml = true;
      }
    } catch {
      /* sidecar optional */
    }
    if (!skipCoverAugment) {
      try {
        const cov = await readFlibustaCover(root, book.archiveName, book);
        if (cov) details.cover = cov;
      } catch {
        /* optional */
      }
    }
  }

  /*
   * Book page / OPDS meta (skipCoverAugment): never unzip the book archive for Flibusta.
   * Annotation comes from etc/annotations.7z; cover is served later via /cover*.
   * Opening fb2.zip on NAS was the main delay when clicking a search result.
   */
  const flibustaSsrSkipArchive = skipCoverAugment && bookHasFlibustaSidecar(book);
  const needArchiveExtract =
    !flibustaSsrSkipArchive &&
    (!String(details.annotation || '').trim() ||
      (!skipCoverAugment && !details.cover?.data?.length));

  if (needArchiveExtract) {
    try {
      const extracted = await extractBookDetails(book);
      if (!String(details.annotation || '').trim() && extracted.annotation) {
        details.annotation = extracted.annotation;
        details.annotationIsHtml = false;
      }
      if (extracted.title) details.title = extracted.title;
      if (!details.cover?.data?.length && extracted.cover?.data?.length) {
        details.cover = extracted.cover;
      }
    } catch {
      extractFailed = true;
    }
  }

  if (details.cover && !details.cover.data?.length) details.cover = null;

  if (!details.cover && !book.archiveName) {
    const nearCover = findNearFileCover(book);
    if (nearCover) details.cover = nearCover;
  }

  if (!details.annotationIsHtml) details.annotationIsHtml = false;

  // Полный провал извлечения: кэшируем FAIL in-memory на 10 минут, чтобы не гонять
  // повторные запросы к битому/отсутствующему архиву. SQLite-кэш при этом не трогаем.
  if (extractFailed && !details.cover && !details.annotation) {
    failedExtractCache.set(book.id, { ts: Date.now(), details });
    return details;
  }

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
