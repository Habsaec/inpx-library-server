import { decodeBookRef } from '../utils/book-ref.js';

function rewritePath(path) {
  let m = path.match(/^\/book\/b64\/([A-Za-z0-9_-]+)(\/edit)?$/);
  if (m) {
    const id = decodeBookRef(m[1]);
    return id ? `/book/${encodeURIComponent(id)}${m[2] || ''}` : null;
  }

  m = path.match(/^\/read\/b64\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const id = decodeBookRef(m[1]);
    return id ? `/read/${encodeURIComponent(id)}` : null;
  }

  m = path.match(/^\/lite\/read\/b64\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const id = decodeBookRef(m[1]);
    return id ? `/lite/read/${encodeURIComponent(id)}` : null;
  }

  m = path.match(/^\/lite\/book\/b64\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const id = decodeBookRef(m[1]);
    return id ? `/lite/book/${encodeURIComponent(id)}` : null;
  }

  m = path.match(/^\/download\/b64\/([A-Za-z0-9_-]+)$/);
  if (m) {
    const id = decodeBookRef(m[1]);
    return id ? `/download/${encodeURIComponent(id)}` : null;
  }

  m = path.match(/^\/api\/books\/b64\/([A-Za-z0-9_-]+)(\/.*)?$/);
  if (m) {
    const id = decodeBookRef(m[1]);
    return id ? `/api/books/${encodeURIComponent(id)}${m[2] || ''}` : null;
  }

  for (const prefix of ['/api/read', '/api/bookmarks', '/api/want', '/api/reading-history', '/api/send-to-ereader', '/api/send-to-telegram']) {
    const re = new RegExp(`^${prefix.replace(/\//g, '\\/')}\\/b64\\/([A-Za-z0-9_-]+)$`);
    m = path.match(re);
    if (m) {
      const id = decodeBookRef(m[1]);
      return id ? `${prefix}/${encodeURIComponent(id)}` : null;
    }
  }

  return null;
}

/** Переписывает /…/b64/<token> в обычные маршруты с percent-encoded id для Express. */
export function bookRefUrlRewrite(req, res, next) {
  const raw = req.url || '';
  const qIdx = raw.indexOf('?');
  const pathOnly = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const query = qIdx === -1 ? '' : raw.slice(qIdx);
  const rewritten = rewritePath(pathOnly);
  if (rewritten) {
    req.url = rewritten + query;
  }
  next();
}
