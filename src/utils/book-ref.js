/**
 * Безопасные URL для ID книг с управляющими символами (в т.ч. NUL / %00).
 * Прокси вроде nginx отклоняют такие пути с 400; /book/b64/… проходит.
 */

export function bookIdNeedsSafeUrl(id) {
  const s = String(id ?? '');
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function encodeBookRef(id) {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

export function decodeBookRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  try {
    const decoded = Buffer.from(ref, 'base64url').toString('utf8');
    return decoded.length ? decoded : null;
  } catch {
    return null;
  }
}

function legacySegment(prefix, id, suffix = '') {
  const tail = suffix ? (suffix.startsWith('/') ? suffix : `/${suffix}`) : '';
  return `${prefix}/${encodeURIComponent(id)}${tail}`;
}

function safeSegment(prefix, id, suffix = '') {
  const tail = suffix ? (suffix.startsWith('/') ? suffix : `/${suffix}`) : '';
  return `${prefix}/b64/${encodeBookRef(id)}${tail}`;
}

function bookSegment(prefix, id, suffix = '') {
  return bookIdNeedsSafeUrl(id) ? safeSegment(prefix, id, suffix) : legacySegment(prefix, id, suffix);
}

export function bookPagePath(id, suffix = '') {
  return bookSegment('/book', id, suffix);
}

export function readPagePath(id) {
  return bookSegment('/read', id);
}

export function liteBookPagePath(id) {
  return bookSegment('/lite/book', id);
}

export function liteReadPagePath(id) {
  return bookSegment('/lite/read', id);
}

export function apiBookPath(id, suffix = '') {
  return bookSegment('/api/books', id, suffix);
}

export function downloadBookPath(id, query = '') {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return bookSegment('/download', id) + q;
}

function apiActionPath(prefix, id) {
  return bookIdNeedsSafeUrl(id) ? `${prefix}/b64/${encodeBookRef(id)}` : `${prefix}/${encodeURIComponent(id)}`;
}

export function apiReadPath(id) {
  return apiActionPath('/api/read', id);
}

export function apiBookmarkPath(id) {
  return apiActionPath('/api/bookmarks', id);
}

export function apiReadingHistoryPath(id) {
  return apiActionPath('/api/reading-history', id);
}

export function apiSendToEreaderPath(id) {
  return apiActionPath('/api/send-to-ereader', id);
}

export function apiSendToTelegramPath(id) {
  return apiActionPath('/api/send-to-telegram', id);
}
