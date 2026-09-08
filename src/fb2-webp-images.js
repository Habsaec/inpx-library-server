/**
 * Иллюстрации WebP в FB2 (сжатые сборки Flibusta + Librusec: картинки 500px WebP).
 * Часть читалок WebP не показывает — режим задаётся в Админка → Контент:
 *   keep — отдавать как есть (минимальный размер);
 *   png  — перекодировать WebP <binary> в PNG при скачивании/конвертации.
 * Тип определяется по байтам, а не по content-type: в таких сборках встречается
 * `content-type="image/jpeg" id="cover.jpg"` с WebP внутри.
 */
import { getSharp } from './services/sharp-loader.js';
import { acquireSharpSlot, releaseSharpSlot, detectImageMimeFromBuffer } from './services/cover.js';

export const FB2_WEBP_MODES = ['keep', 'png'];
export const DEFAULT_FB2_WEBP_MODE = 'keep';

let fb2WebpMode = DEFAULT_FB2_WEBP_MODE;

export function normalizeFb2WebpMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  return FB2_WEBP_MODES.includes(mode) ? mode : DEFAULT_FB2_WEBP_MODE;
}

export function setFb2WebpMode(mode) {
  fb2WebpMode = normalizeFb2WebpMode(mode);
}

export function getFb2WebpMode() {
  return fb2WebpMode;
}

const BINARY_RE = /<binary\b([^>]*)>([\s\S]*?)<\/binary>/gi;

function isWebpBase64(b64) {
  /* 16 символов base64 = первые 12 байт: хватает для сигнатуры RIFF....WEBP */
  const head = b64.slice(0, 64).replace(/\s+/g, '').slice(0, 16);
  return detectImageMimeFromBuffer(Buffer.from(head, 'base64')) === 'image/webp';
}

function setPngContentType(attrs) {
  if (/content-type\s*=/i.test(attrs)) {
    return attrs.replace(/content-type\s*=\s*(['"])[^'"]*\1/i, 'content-type="image/png"');
  }
  return `${attrs} content-type="image/png"`;
}

/**
 * Перекодирует WebP-вложения FB2 в PNG. Работает с latin1-строкой: байты вне ASCII
 * не трогаются, поэтому кодировка файла (utf-8 / windows-1251) сохраняется байт в байт.
 * Без sharp (обработка отключена / недоступен libvips) возвращает буфер без изменений.
 */
export async function convertFb2WebpBinariesToPng(buffer) {
  const xml = buffer.toString('latin1');
  const matches = [...xml.matchAll(BINARY_RE)].filter((m) => isWebpBase64(m[2]));
  if (!matches.length) return buffer;
  const sharp = await getSharp();
  if (!sharp) return buffer;

  const parts = [];
  let cursor = 0;
  for (const m of matches) {
    parts.push(xml.slice(cursor, m.index));
    let replacement = m[0];
    await acquireSharpSlot();
    try {
      const webp = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      const png = await sharp(webp, { failOn: 'none' }).png().toBuffer();
      replacement = `<binary${setPngContentType(m[1])}>${png.toString('base64')}</binary>`;
    } catch {
      /* битая картинка — оставляем исходный блок */
    } finally {
      releaseSharpSlot();
    }
    parts.push(replacement);
    cursor = m.index + m[0].length;
  }
  parts.push(xml.slice(cursor));
  return Buffer.from(parts.join(''), 'latin1');
}
