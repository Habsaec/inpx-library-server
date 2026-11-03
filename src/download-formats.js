import { config } from './config.js';
import { db } from './db.js';

/** Formats fb2cng can produce from FB2 (when configured). */
export const FB2_CONVERTIBLE_FORMATS = ['epub2', 'epub3', 'kepub', 'kfx', 'azw8'];

/** FB2 packed into a single-entry ZIP (`.fb2.zip`); needs no converter. */
export const FB2_ZIP_FORMAT = 'fb2zip';

export const FORMAT_LABELS = {
  fb2: 'FB2',
  fb2zip: 'FB2.ZIP',
  epub2: 'EPUB',
  epub3: 'EPUB3',
  kepub: 'KEPUB',
  kfx: 'KFX',
  azw8: 'AZW8'
};

export const DOWNLOAD_FORMATS = new Set(['fb2', FB2_ZIP_FORMAT, ...FB2_CONVERTIBLE_FORMATS]);

/** Formats shown in admin and used for batch ZIP (FB2 source). */
export function getConfiguredDownloadFormats() {
  return config.fb2cngPath ? ['fb2', FB2_ZIP_FORMAT, ...FB2_CONVERTIBLE_FORMATS] : ['fb2', FB2_ZIP_FORMAT];
}

let disabledDownloadFormats = new Set();

/**
 * @param {string|string[]|Set<string>} formats Disabled format codes (comma string or list).
 */
export function setDisabledDownloadFormats(formats) {
  const raw = formats instanceof Set
    ? [...formats]
    : Array.isArray(formats)
      ? formats
      : String(formats || '').split(',');
  disabledDownloadFormats = new Set(
    raw.map((s) => String(s).trim().toLowerCase()).filter((f) => DOWNLOAD_FORMATS.has(f))
  );
}

export function getDisabledDownloadFormats() {
  return [...disabledDownloadFormats];
}

export function isDownloadFormatEnabled(format) {
  const code = String(format || '').trim().toLowerCase();
  if (!DOWNLOAD_FORMATS.has(code)) return true;
  return !disabledDownloadFormats.has(code);
}

/*
 * Stored extra files of a book (Calibre: every format besides the primary one, table book_files).
 * List pages call this per row, so the lookup is skipped while the table is empty (re-checked
 * every 30 s — a library without Calibre sources never queries it per book).
 */
let _stmtBookFiles = null;
let _stmtAnyBookFile = null;
let anyBookFilesCheckedAt = 0;
let anyBookFiles = false;

function hasAnyBookFiles() {
  const now = Date.now();
  if (now - anyBookFilesCheckedAt > 30_000) {
    anyBookFilesCheckedAt = now;
    try {
      _stmtAnyBookFile ??= db.prepare('SELECT 1 FROM book_files LIMIT 1');
      anyBookFiles = Boolean(_stmtAnyBookFile.get());
    } catch {
      anyBookFiles = false;
    }
  }
  return anyBookFiles;
}

/** Drop the 30 s memo (after an index pass wrote book_files, in tests). */
export function resetBookFilesProbe() {
  anyBookFilesCheckedAt = 0;
}

/**
 * @param {{ id?: string, ext?: string, archiveName?: string }} book
 * @returns {{ ext: string, fileName: string, size: number }[]}
 */
export function getBookExtraFiles(book) {
  if (!book?.id || book.archiveName || !hasAnyBookFiles()) return [];
  try {
    _stmtBookFiles ??= db.prepare('SELECT ext, file_name AS fileName, size FROM book_files WHERE book_id = ? ORDER BY ext');
    const primary = String(book.ext || '').toLowerCase();
    return _stmtBookFiles.all(String(book.id)).filter((f) => f.ext !== primary);
  } catch {
    return [];
  }
}

/** MIME types of stored extra files in OPDS acquisition links. */
const STORED_FILE_MIME = {
  epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/x-mobipocket-ebook',
  azw: 'application/vnd.amazon.ebook',
  pdf: 'application/pdf',
  djvu: 'image/vnd.djvu',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  txt: 'text/plain',
  rtf: 'application/rtf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

/**
 * OPDS acquisition entries for a book's stored extra files: { format, mime, label } (one link per
 * format, `/download/:id?format=<ext>`); disabled formats are left out like everywhere else.
 */
export function getBookExtraAcquisitions(book) {
  return getBookExtraFiles(book)
    .filter((f) => isDownloadFormatEnabled(f.ext))
    .map((f) => ({
      format: f.ext,
      mime: STORED_FILE_MIME[f.ext] || 'application/octet-stream',
      label: FORMAT_LABELS[f.ext] || f.ext.toUpperCase()
    }));
}

/** A stored extra file of the book for this format code, or null (then the format is a conversion). */
export function getBookExtraFile(book, format) {
  const code = String(format || '').toLowerCase();
  return getBookExtraFiles(book).find((f) => f.ext === code) || null;
}

function getBookNativeDownloadFormats(book) {
  const sourceFormat = String(book?.ext || 'fb2').toLowerCase();
  const base = sourceFormat === 'fb2' ? getConfiguredDownloadFormats() : [sourceFormat];
  const extras = getBookExtraFiles(book).map((f) => f.ext).filter((ext) => !base.includes(ext));
  return extras.length ? [...base, ...extras] : base;
}

/**
 * @param {{ ext?: string }} book
 * @returns {string[]}
 */
export function getAvailableDownloadFormats(book) {
  return getBookNativeDownloadFormats(book).filter(isDownloadFormatEnabled);
}
