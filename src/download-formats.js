import { config } from './config.js';

/** Formats fb2cng can produce from FB2 (when configured). */
export const FB2_CONVERTIBLE_FORMATS = ['epub2', 'epub3', 'kepub', 'kfx', 'azw8'];

export const FORMAT_LABELS = {
  fb2: 'FB2',
  epub2: 'EPUB',
  epub3: 'EPUB3',
  kepub: 'KEPUB',
  kfx: 'KFX',
  azw8: 'AZW8'
};

export const DOWNLOAD_FORMATS = new Set(['fb2', ...FB2_CONVERTIBLE_FORMATS]);

/**
 * @param {{ ext?: string }} book
 * @returns {string[]}
 */
export function getAvailableDownloadFormats(book) {
  const sourceFormat = String(book?.ext || 'fb2').toLowerCase();
  if (sourceFormat === 'fb2') {
    return config.fb2cngPath ? ['fb2', ...FB2_CONVERTIBLE_FORMATS] : ['fb2'];
  }
  return [sourceFormat];
}
