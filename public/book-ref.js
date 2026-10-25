(function bookRefGlobal() {
  function bookIdNeedsSafeUrl(id) {
    const s = String(id ?? '');
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
  }

  function encodeBookRef(id) {
    const bytes = new TextEncoder().encode(String(id));
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decodeBookRef(ref) {
    if (!ref || typeof ref !== 'string') return null;
    try {
      let b64 = ref.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const binary = atob(b64);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      return decoded.length ? decoded : null;
    } catch {
      return null;
    }
  }

  function bookSegment(prefix, id, suffix) {
    const tail = suffix ? (suffix.startsWith('/') ? suffix : `/${suffix}`) : '';
    if (bookIdNeedsSafeUrl(id)) {
      return `${prefix}/b64/${encodeBookRef(id)}${tail}`;
    }
    return `${prefix}/${encodeURIComponent(id)}${tail}`;
  }

  function bookPagePath(id, suffix) {
    return bookSegment('/book', id, suffix || '');
  }

  function readPagePath(id) {
    return bookSegment('/read', id);
  }

  function liteBookPagePath(id) {
    return bookSegment('/lite/book', id);
  }

  function liteReadPagePath(id) {
    return bookSegment('/lite/read', id);
  }

  function apiBookPath(id, suffix) {
    return bookSegment('/api/books', id, suffix || '');
  }

  function downloadBookPath(id, query) {
    const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
    return bookSegment('/download', id) + q;
  }

  function apiActionPath(prefix, id) {
    return bookIdNeedsSafeUrl(id) ? `${prefix}/b64/${encodeBookRef(id)}` : `${prefix}/${encodeURIComponent(id)}`;
  }

  function apiReadPath(id) { return apiActionPath('/api/read', id); }
  function apiBookmarkPath(id) { return apiActionPath('/api/bookmarks', id); }
  function apiWantPath(id) { return apiActionPath('/api/want', id); }
  function apiRatingPath(id) { return apiActionPath('/api/rating', id); }
  function apiReadingHistoryPath(id) { return apiActionPath('/api/reading-history', id); }
  function apiSendToEreaderPath(id) { return apiActionPath('/api/send-to-ereader', id); }
  function apiSendToTelegramPath(id) { return apiActionPath('/api/send-to-telegram', id); }

  function resolveBookRefAttr(ref) {
    if (!ref) return null;
    const decoded = decodeBookRef(ref);
    return decoded || null;
  }

  function legacyEncodedId(value) {
    if (!value || value === '1') return null;
    try {
      return decodeURIComponent(value).replace(/\uFFFD/g, '\0');
    } catch {
      return String(value).replace(/\uFFFD/g, '\0');
    }
  }

  /** ID книги из DOM-элемента (карточка, кнопка «Прочитано» и т.д.). */
  function resolveBookIdFromElement(el) {
    if (!el) return null;
    const host = el.closest('[data-book-id-ref]');
    if (host) {
      const decoded = resolveBookRefAttr(host.dataset.bookIdRef || host.getAttribute('data-book-id-ref'));
      if (decoded) return decoded;
    }
    const directRef = el.getAttribute?.('data-book-id-ref');
    if (directRef) {
      const decoded = resolveBookRefAttr(directRef);
      if (decoded) return decoded;
    }
    for (const key of ['readButton', 'bookmarkButton', 'addToShelf', 'sendToEreader']) {
      const legacy = legacyEncodedId(el.dataset?.[key]);
      if (legacy) return legacy;
    }
    const card = el.closest('[data-book-id]');
    if (card?.dataset?.bookId) return card.dataset.bookId.replace(/\uFFFD/g, '\0');
    return null;
  }

  function resolveBatchBookIdFromElement(el) {
    if (!el) return null;
    const ref = el.getAttribute('data-batch-book-id-ref');
    if (ref) {
      const decoded = resolveBookRefAttr(ref);
      if (decoded) return decoded;
    }
    const legacy = el.getAttribute('data-batch-book-id');
    if (legacy) return legacy.replace(/\uFFFD/g, '\0');
    const card = el.closest('.card');
    return card ? resolveBookIdFromElement(card) : null;
  }

  function findCardsByBookId(bookId) {
    if (!bookId) return [];
    const out = [];
    const seen = new Set();
    const ref = encodeBookRef(bookId);
    document.querySelectorAll(`.card[data-book-id-ref="${CSS.escape(ref)}"]`).forEach((c) => {
      if (!seen.has(c)) { seen.add(c); out.push(c); }
    });
    if (!bookIdNeedsSafeUrl(bookId)) {
      document.querySelectorAll(`.card[data-book-id="${CSS.escape(bookId)}"]`).forEach((c) => {
        if (!seen.has(c)) { seen.add(c); out.push(c); }
      });
    }
    return out;
  }

  const api = {
    bookIdNeedsSafeUrl, encodeBookRef, decodeBookRef, bookPagePath, readPagePath, liteBookPagePath, liteReadPagePath, apiBookPath, downloadBookPath,
    apiReadPath, apiBookmarkPath, apiWantPath, apiRatingPath, apiReadingHistoryPath, apiSendToEreaderPath, apiSendToTelegramPath,
    resolveBookIdFromElement, resolveBatchBookIdFromElement, findCardsByBookId
  };
  globalThis.bookRef = api;
  for (const [key, fn] of Object.entries(api)) {
    globalThis[key] = fn;
  }
})();
