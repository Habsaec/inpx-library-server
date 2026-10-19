import { config } from './config.js';

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

function getBookNativeDownloadFormats(book) {
  const sourceFormat = String(book?.ext || 'fb2').toLowerCase();
  if (sourceFormat === 'fb2') {
    return getConfiguredDownloadFormats();
  }
  return [sourceFormat];
}

/**
 * @param {{ ext?: string }} book
 * @returns {string[]}
 */
export function getAvailableDownloadFormats(book) {
  return getBookNativeDownloadFormats(book).filter(isDownloadFormatEnabled);
}
