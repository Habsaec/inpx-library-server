/**
 * Имена файлов при скачивании, ZIP, Kindle и Telegram.
 * Стиль задаётся в Админка → Контент; по умолчанию — прежнее поведение (транслит).
 */
import path from 'node:path';

export const DOWNLOAD_FILENAME_STYLES = ['translit-full', 'title', 'author-title', 'full'];
export const DEFAULT_DOWNLOAD_FILENAME_STYLE = 'translit-full';
/**
 * E-mail to an e-reader always names the attachment by the book title, whatever the admin style:
 * Kindle (Send to Kindle) shows the attachment name as the book title in its library.
 */
export const EMAIL_FILENAME_STYLE = 'title';

const TRANSLIT_MAP = {
  'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo', 'Ж': 'Zh', 'З': 'Z', 'И': 'I', 'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'Kh', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Shch', 'Ъ': '', 'Ы': 'Y', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  'І': 'I', 'і': 'i', 'Ї': 'Yi', 'ї': 'yi', 'Є': 'Ye', 'є': 'ye', 'Ґ': 'G', 'ґ': 'g'
};

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

let downloadFilenameStyle = DEFAULT_DOWNLOAD_FILENAME_STYLE;

export function normalizeDownloadFilenameStyle(raw) {
  const style = String(raw || '').trim().toLowerCase();
  return DOWNLOAD_FILENAME_STYLES.includes(style) ? style : DEFAULT_DOWNLOAD_FILENAME_STYLE;
}

export function setDownloadFilenameStyle(style) {
  downloadFilenameStyle = normalizeDownloadFilenameStyle(style);
}

export function getDownloadFilenameStyle() {
  return downloadFilenameStyle;
}

export function transliterate(value) {
  return String(value || '').replace(/[\u0400-\u04FF\u0490\u0491]/g, (ch) => TRANSLIT_MAP[ch] ?? ch);
}

function sanitizeBaseName(value = '') {
  let safe = String(value || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!safe) safe = 'book';
  if (WIN_RESERVED.test(safe)) safe = `${safe}_`;
  return safe.slice(0, 200);
}

function formatAuthorFileName(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const authors = raw
    .split(':')
    .map((author) => author.split(',').map((part) => part.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
  if (!authors.length) return raw;
  return authors.join(', ');
}

function nameParts(book, style) {
  const author = formatAuthorFileName(book?.authors);
  const title = String(book?.title || '').trim();
  const series = String(book?.series || '').trim();
  const seriesNo = String(book?.seriesNo ?? '').trim();
  if (style === 'title') return [title];
  if (style === 'author-title') return [author, title];
  return [author, title, series, seriesNo];
}

export function buildDownloadBaseName(book, style = getDownloadFilenameStyle()) {
  const normalized = normalizeDownloadFilenameStyle(style);
  const joiner = normalized === 'author-title' ? ' — ' : ' ';
  const joined = nameParts(book, normalized).filter(Boolean).join(joiner);
  const raw = sanitizeBaseName(joined || book?.fileName || book?.title || book?.id || 'book');
  return normalized === 'translit-full' ? transliterate(raw) : raw;
}

function asciiFallbackName(fileName) {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  const ascii = transliterate(base)
    .replace(/[^\w.\- ()[\]]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim() || 'book';
  return `${ascii.slice(0, 150)}${ext}`;
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Content-Disposition for downloads: ASCII filename= plus RFC 5987 filename* when needed. */
export function contentDispositionAttachment(fileName) {
  const safe = String(fileName || 'book').replace(/[\r\n"]/g, '_');
  const fallback = asciiFallbackName(safe).replace(/"/g, '');
  if (!/[^\x20-\x7E]/.test(safe)) {
    return `attachment; filename="${safe}"`;
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(safe)}`;
}
