function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeDomIdPart(value) {
  const s = String(value ?? '').trim().replace(/\s+/g, '_');
  const t = s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return t || 'field';
}

(() => {
  const el = document.getElementById('ui-i18n-json');
  try {
    window.__I18N = el && el.textContent ? JSON.parse(el.textContent) : { locale: 'ru', strings: {} };
  } catch {
    window.__I18N = { locale: 'ru', strings: {} };
  }
})();

function getUiLocale() {
  return window.__I18N?.locale === 'en' ? 'en' : 'ru';
}

function uiT(key) {
  const s = window.__I18N?.strings;
  if (!s || !Object.prototype.hasOwnProperty.call(s, key)) return key;
  const v = s[key];
  if (v === undefined || v === null) return key;
  return v;
}

function uiTp(key, vars = {}) {
  let str = uiT(key);
  for (const [k, v] of Object.entries(vars)) {
    str = str.split(`{{${k}}}`).join(String(v));
  }
  return str;
}

function uiPlural(type, n) {
  const lang = getUiLocale();
  const v = Math.floor(Math.abs(Number(n) || 0));
  if (lang === 'en') {
    return uiT(`plural.${type}.${v === 1 ? 'one' : 'other'}`);
  }
  const m10 = v % 10;
  const m100 = v % 100;
  let suf;
  if (m100 >= 11 && m100 <= 14) suf = 'many';
  else if (m10 === 1) suf = 'one';
  else if (m10 >= 2 && m10 <= 4) suf = 'few';
  else suf = 'many';
  return uiT(`plural.${type}.${suf}`);
}

function uiCountLabel(type, n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  const loc = getUiLocale() === 'en' ? 'en-US' : 'ru-RU';
  return `${v.toLocaleString(loc)} ${uiPlural(type, v)}`;
}

function formatClientInt(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toLocaleString(getUiLocale() === 'en' ? 'en-US' : 'ru-RU');
}

function getCsrfTokenFromPage() {
  const m = document.querySelector('meta[name="csrf-token"]');
  const t = m && m.getAttribute('content');
  return t && String(t).trim() ? String(t).trim() : '';
}

(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(input, init) {
    const opts = init === undefined ? {} : { ...init };
    const method = String(opts.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const token = getCsrfTokenFromPage();
      if (token) {
        const headers = new Headers(opts.headers);
        if (!headers.has('X-CSRF-Token')) {
          headers.set('X-CSRF-Token', token);
        }
        opts.headers = headers;
      }
    }
    return nativeFetch(input, opts);
  };
})();

function renderIndexStatsBlock(stats) {
  if (!stats || typeof stats !== 'object') {
    return '';
  }
  return `<div class="index-banner-stats">
    <span><strong>${uiCountLabel('book', stats.totalBooks)}</strong></span>
    <span><strong>${uiCountLabel('author', stats.totalAuthors)}</strong></span>
    <span><strong>${uiCountLabel('series', stats.totalSeries)}</strong></span>
  </div>`;
}

function attachProfileTabs() {
  const root = document.querySelector('[data-profile-root]');
  if (!root) return;
  const tabs = [...root.querySelectorAll('[data-profile-tab]')];
  const panels = [...root.querySelectorAll('[data-profile-panel]')];
  if (!tabs.length || !panels.length) return;

  const selectTab = (id) => {
    const next = id === 'settings' ? 'settings' : 'activity';
    for (const t of tabs) {
      const on = t.dataset.profileTab === next;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.classList.toggle('is-active', on);
      t.setAttribute('tabindex', on ? '0' : '-1');
    }
    for (const p of panels) {
      const on = p.dataset.profilePanel === next;
      if (on) p.removeAttribute('hidden');
      else p.setAttribute('hidden', '');
    }
    const path = `${window.location.pathname}${window.location.search}`;
    try {
      if (next === 'settings') {
        history.replaceState(null, '', `${path}#settings`);
      } else {
        history.replaceState(null, '', path);
      }
    } catch {
      /* ignore */
    }
  };

  let initial = root.dataset.profileInitialTab === 'settings' ? 'settings' : 'activity';
  const h = (window.location.hash || '').replace(/^#/, '').toLowerCase();
  if (h === 'settings') initial = 'settings';
  if (h === 'activity') initial = 'activity';

  selectTab(initial);

  for (const btn of tabs) {
    btn.addEventListener('click', () => selectTab(btn.dataset.profileTab));
    btn.addEventListener('keydown', (event) => {
      const idx = tabs.indexOf(btn);
      if (idx < 0) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const nextIdx =
          event.key === 'ArrowRight'
            ? (idx + 1) % tabs.length
            : (idx - 1 + tabs.length) % tabs.length;
        const nextBtn = tabs[nextIdx];
        if (!nextBtn) return;
        selectTab(nextBtn.dataset.profileTab);
        nextBtn.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        const first = tabs[0];
        if (!first) return;
        selectTab(first.dataset.profileTab);
        first.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        const last = tabs[tabs.length - 1];
        if (!last) return;
        selectTab(last.dataset.profileTab);
        last.focus();
      }
    });
  }
}

function syncProfilePageCounters() {
  const root = document.querySelector('[data-profile-page-stats]');
  if (!root) return;
  const reading = Math.max(0, parseInt(root.dataset.readingTotal, 10) || 0);
  const readerBm = Math.max(0, parseInt(root.dataset.readerBmTotal, 10) || 0);

  const link = document.querySelector('[data-profile-reading-all-link]');
  if (link) {
    link.textContent = uiTp('profile.readingAll', { n: formatClientInt(reading), books: uiPlural('book', reading) });
    if (reading > 0) link.removeAttribute('hidden');
    else link.setAttribute('hidden', '');
  }

  const bmSpan = document.querySelector('[data-profile-reader-bm-count]');
  if (bmSpan) bmSpan.textContent = formatClientInt(readerBm);
}

function bumpProfileReadingTotal(delta) {
  const root = document.querySelector('[data-profile-page-stats]');
  if (!root) return;
  const next = Math.max(0, (parseInt(root.dataset.readingTotal, 10) || 0) + delta);
  root.dataset.readingTotal = String(next);
  syncProfilePageCounters();
}

function bumpProfileReaderBmTotal(delta) {
  const root = document.querySelector('[data-profile-page-stats]');
  if (!root) return;
  const next = Math.max(0, (parseInt(root.dataset.readerBmTotal, 10) || 0) + delta);
  root.dataset.readerBmTotal = String(next);
  syncProfilePageCounters();
}

async function loadBookPageReview() {
  const mount = document.querySelector('[data-book-review-mount]');
  if (!mount) return;
  const id = mount.dataset.bookReviewFor;
  const heading = mount.dataset.reviewHeading || '';
  if (!id) {
    mount.remove();
    return;
  }
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(id)}/review`, { credentials: 'same-origin' });
    if (!r.ok) {
      mount.remove();
      return;
    }
    const data = await r.json();
    const html = typeof data.html === 'string' ? data.html.trim() : '';
    if (!html) {
      mount.remove();
      return;
    }
    const section = document.createElement('section');
    section.className = 'book-detail-side-block book-detail-review-block';
    const details = document.createElement('details');
    details.className = 'book-detail-disclosure book-detail-review-disclosure';
    const summary = document.createElement('summary');
    const titleSpan = document.createElement('span');
    titleSpan.className = 'book-detail-disclosure-title';
    titleSpan.textContent = heading;
    summary.appendChild(titleSpan);
    const bodyEl = document.createElement('div');
    bodyEl.className = 'book-detail-review';
    bodyEl.innerHTML = html;
    details.appendChild(summary);
    details.appendChild(bodyEl);
    section.appendChild(details);
    mount.replaceWith(section);
  } catch (e) {
    console.error(e);
    mount.remove();
  }
}

function attachRatingWidgets() {
  document.querySelectorAll('[data-rating-widget]').forEach(widget => {
    const readonly = widget.hasAttribute('data-readonly');
    const bookId = widget.dataset.bookId;
    const stars = widget.querySelectorAll('.star-btn');
    const infoEl = widget.querySelector('.rating-info');
    let currentRating = parseInt(widget.dataset.userRating, 10) || 0;

    if (readonly) return;

    // Hover preview
    stars.forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        const val = parseInt(btn.dataset.star, 10);
        stars.forEach(s => s.classList.toggle('is-hovered', parseInt(s.dataset.star, 10) <= val));
      });
      btn.addEventListener('mouseleave', () => {
        stars.forEach(s => s.classList.remove('is-hovered'));
      });
    });

    // Click to rate
    stars.forEach(btn => {
      btn.addEventListener('click', async () => {
        const val = parseInt(btn.dataset.star, 10);
        const isRemove = val === currentRating;
        try {
          const csrfMeta = document.querySelector('meta[name="csrf-token"]');
          const headers = { 'Content-Type': 'application/json' };
          if (csrfMeta) headers['x-csrf-token'] = csrfMeta.content;
          let res;
          if (isRemove) {
            res = await fetch(`/api/books/${encodeURIComponent(bookId)}/rating`, { method: 'DELETE', credentials: 'same-origin', headers });
          } else {
            res = await fetch(`/api/books/${encodeURIComponent(bookId)}/rating`, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ rating: val }) });
          }
          if (!res.ok) return;
          const data = await res.json();
          currentRating = data.userRating || 0;
          widget.dataset.userRating = String(currentRating);
          stars.forEach(s => s.classList.toggle('is-active', parseInt(s.dataset.star, 10) <= currentRating));
          if (data.count) {
            infoEl.innerHTML = `<span class="rating-avg">${data.average}</span> <span class="rating-count">(${data.count})</span>`;
          } else {
            infoEl.innerHTML = `<span class="rating-empty">${uiT('book.rating.noRatings')}</span>`;
          }
        } catch (e) { console.error('Rating error', e); }
      });
    });
  });
}

function setCoverFallbackState(rootNode, showFallback) {
  const root = rootNode instanceof Element ? rootNode : null;
  if (!root) return;
  const cover = root.matches('.cover') ? root : root.querySelector('.cover');
  if (!cover) return;
  const fallback = cover.querySelector('.cover-fallback');
  if (showFallback) {
    cover.classList.add('cover-fallback-active');
    if (fallback) {
      fallback.hidden = false;
      fallback.setAttribute('aria-hidden', 'false');
    }
  } else {
    cover.classList.remove('cover-fallback-active');
    if (fallback) {
      fallback.hidden = true;
      fallback.setAttribute('aria-hidden', 'true');
    }
  }
}

/** Декоративная обложка в разметке; при error /cover-thumb (404 без обложки) и при coverAvailable=false не подменяем заглушкой с API. */
function attachCoverErrorFallback(scope = document) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const imgs = root.querySelectorAll('.cover .cover-image');
  for (const img of imgs) {
    if (img.dataset.coverErrBound === '1') continue;
    img.dataset.coverErrBound = '1';
    const host = img.closest('.card, .book-detail-main, .cover');
    const showFallbackSoonTimer = window.setTimeout(() => {
      setCoverFallbackState(host, true);
    }, 2000);
    const clearSlowTimer = () => window.clearTimeout(showFallbackSoonTimer);
    img.addEventListener('load', () => {
      clearSlowTimer();
      setCoverFallbackState(host, false);
    }, { once: true });
    img.addEventListener('error', () => {
      clearSlowTimer();
      setCoverFallbackState(host, true);
    }, { once: true });
    if (img.complete) {
      clearSlowTimer();
      setCoverFallbackState(host, !(img.naturalWidth > 0));
    }
  }
}

const CARD_DETAILS_BATCH_SIZE = 48;
const CARD_DETAILS_FLUSH_DELAY_MS = 35;
const _cardDetailsCache = new Map();
const _cardDetailsQueued = new Set();
const _cardDetailsInFlight = new Set();
let _cardDetailsFlushTimer = 0;
let _cardDetailsObserver = null;

function applyCardDetailsForId(id, details) {
  if (!id || !details) return;
  const cards = [...document.querySelectorAll('[data-book-id]')].filter((card) => card.dataset.bookId === id);
  for (const card of cards) {
    card.dataset.coverAvailable = details.coverAvailable ? 'true' : 'false';
    const img = card.querySelector('.cover .cover-image');
    if (details.coverAvailable && img) {
      const targetSrc = String(img.dataset.coverSrc || '').trim();
      if (targetSrc && img.getAttribute('src') !== targetSrc) {
        img.setAttribute('src', targetSrc);
      }
    }
    const hasRenderedImage = Boolean(img && img.complete && img.naturalWidth > 0);
    setCoverFallbackState(card, !details.coverAvailable && !hasRenderedImage);
  }
}

function scheduleCardDetailsFlush() {
  if (_cardDetailsFlushTimer) return;
  _cardDetailsFlushTimer = window.setTimeout(async () => {
    _cardDetailsFlushTimer = 0;
    while (_cardDetailsQueued.size > 0) {
      const ids = [..._cardDetailsQueued].slice(0, CARD_DETAILS_BATCH_SIZE);
      ids.forEach((id) => {
        _cardDetailsQueued.delete(id);
        _cardDetailsInFlight.add(id);
      });
      try {
        const response = await fetch('/api/books/details-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ ids })
        });
        if (!response.ok) continue;
        const payload = await response.json();
        const items = payload && typeof payload.items === 'object' ? payload.items : {};
        for (const id of ids) {
          const details = items[id];
          if (!details) continue;
          _cardDetailsCache.set(id, details);
          applyCardDetailsForId(id, details);
        }
      } catch (error) {
        console.error(error);
      } finally {
        ids.forEach((id) => _cardDetailsInFlight.delete(id));
      }
    }
  }, CARD_DETAILS_FLUSH_DELAY_MS);
}

function queueCardDetailsById(id) {
  if (!id) return;
  if (_cardDetailsCache.has(id) || _cardDetailsInFlight.has(id) || _cardDetailsQueued.has(id)) return;
  _cardDetailsQueued.add(id);
  scheduleCardDetailsFlush();
}

function getCardDetailsObserver() {
  if (_cardDetailsObserver) return _cardDetailsObserver;
  if (typeof IntersectionObserver !== 'function') return null;
  _cardDetailsObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      _cardDetailsObserver.unobserve(card);
      const id = card?.dataset?.bookId;
      if (!id) continue;
      if (_cardDetailsCache.has(id)) {
        applyCardDetailsForId(id, _cardDetailsCache.get(id));
      } else {
        queueCardDetailsById(id);
      }
    }
  }, {
    root: null,
    rootMargin: '700px 0px',
    threshold: 0.01
  });
  return _cardDetailsObserver;
}

function loadCardDetails(cardList) {
  const cards = cardList ? [...cardList] : [...document.querySelectorAll('[data-book-id]')];
  if (!cards.length) return Promise.resolve();
  const observer = getCardDetailsObserver();
  for (const card of cards) {
    const id = card.dataset.bookId;
    if (!id) continue;
    if (_cardDetailsCache.has(id)) {
      applyCardDetailsForId(id, _cardDetailsCache.get(id));
      continue;
    }
    if (observer) {
      observer.observe(card);
    } else {
      queueCardDetailsById(id);
    }
  }
  return Promise.resolve();
}

function getCurrentFavoritesView() {
  return document.querySelector('[data-favorites-view]')?.dataset.favoritesView || '';
}

function attachThemeToggle() {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll('[data-theme-toggle]')];
  if (!buttons.length) {
    return;
  }

  const getTheme = () => root.dataset.theme === 'light' ? 'light' : 'dark';
  const getNextThemeLabel = (theme) => theme === 'light' ? uiT('app.themeDark') : uiT('app.themeLight');
  const getThemeIcon = (theme) => theme === 'light' ? '☽' : '☀';

  const render = () => {
    const theme = getTheme();
    for (const button of buttons) {
      const labelNode = button.querySelector('[data-theme-toggle-label]');
      const label = getNextThemeLabel(theme);
      if (labelNode) {
        labelNode.textContent = getThemeIcon(theme);
      }
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
  };

  render();

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const nextTheme = getTheme() === 'light' ? 'dark' : 'light';
      root.dataset.theme = nextTheme;
      try {
        localStorage.setItem('theme-preference', nextTheme);
      } catch {
        console.error('Could not persist theme preference');
      }
      render();
    });
  }
}

const _downloadMenuCloseTimers = new WeakMap();
const _downloadMenuAll = new WeakSet();

function _closeAllDownloadMenus(except = null) {
  // WeakSet не итерируется, поэтому используем живую NodeList
  for (const menu of document.querySelectorAll('.download-menu')) {
    if (menu !== except) {
      const timerId = _downloadMenuCloseTimers.get(menu);
      if (timerId) {
        window.clearTimeout(timerId);
        _downloadMenuCloseTimers.delete(menu);
      }
      menu.removeAttribute('open');
    }
  }
}

function attachDownloadMenus(scope = document) {
  const menus = [...scope.querySelectorAll('.download-menu')];
  if (!menus.length) {
    return;
  }

  for (const menu of menus) {
    if (_downloadMenuAll.has(menu)) continue;
    _downloadMenuAll.add(menu);

    const cancelScheduledClose = () => {
      const timerId = _downloadMenuCloseTimers.get(menu);
      if (timerId) {
        window.clearTimeout(timerId);
        _downloadMenuCloseTimers.delete(menu);
      }
    };

    const scheduleClose = () => {
      cancelScheduledClose();
      const timerId = window.setTimeout(() => {
        menu.removeAttribute('open');
        _downloadMenuCloseTimers.delete(menu);
      }, 180);
      _downloadMenuCloseTimers.set(menu, timerId);
    };

    menu.addEventListener('toggle', () => {
      if (menu.open) {
        cancelScheduledClose();
        _closeAllDownloadMenus(menu);
      }
    });

    menu.addEventListener('mouseenter', cancelScheduledClose);
    menu.addEventListener('mouseleave', scheduleClose);
  }

  if (!attachDownloadMenus._globalBound) {
    attachDownloadMenus._globalBound = true;
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        _closeAllDownloadMenus();
        return;
      }
      const insideMenu = target.closest('.download-menu');
      if (!insideMenu) {
        _closeAllDownloadMenus();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        _closeAllDownloadMenus();
      }
    });
  }
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function computeIndexTimeInfo(startedAt, processed, total) {
  if (!startedAt) return { elapsed: '', eta: '' };
  const start = new Date(startedAt).getTime();
  if (!start || isNaN(start)) return { elapsed: '', eta: '' };
  const elapsedMs = Date.now() - start;
  const elapsedSec = elapsedMs / 1000;
  const elapsed = formatDuration(elapsedSec);
  let eta = '';
  if (processed > 0 && total > 0 && processed < total) {
    const rate = elapsedSec / processed;
    const remaining = (total - processed) * rate;
    eta = formatDuration(remaining);
  }
  return { elapsed, eta };
}

/** Full-page spinner overlay for traditional form submissions and long operations */
function showPageSpinner() {
  // no-op: replaced by inline button feedback and progress banner
}

function showToast(message, tone = 'info', opts = {}) {
  let host = document.querySelector('[data-toast-host]');
  if (!host) {
    host = document.createElement('div');
    host.dataset.toastHost = 'true';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'true');
    document.body.appendChild(host);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${tone}`;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  if (opts.spinner) {
    const sp = document.createElement('span');
    sp.className = 'toast-spinner';
    toast.appendChild(sp);
  }
  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(span);

  if (opts.actionLabel && opts.onAction) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => { opts.onAction(); dismiss(); });
    toast.appendChild(btn);
  }

  host.appendChild(toast);
  const duration = opts.duration || 2200;
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.add('toast-hide');
    window.setTimeout(() => toast.remove(), 220);
  };
  timer = window.setTimeout(dismiss, duration);
  return { dismiss };
}

async function handleAuthRequired(response) {
  if (response.status !== 401) {
    return false;
  }
  showToast(uiT('app.loginForPersonal'), 'info');
  window.setTimeout(() => {
    window.location.href = '/login';
  }, 900);
  return true;
}

/** Кнопка «Убрать» в сетке /favorites?view=books — книга уже в избранном, нужен confirm и своя подпись. */
function isFavoriteBookListRemoveButton(button) {
  return button.classList.contains('card-remove-favorite-action');
}

/** Кнопки автор/серия в таблице на /favorites — всегда снятие с избранного. */
function isFavoriteEntityListButton(button) {
  return Boolean(button.closest('.favorites-list'));
}

function syncBookBookmarkButtonUi(button, bookmarked) {
  if (isFavoriteBookListRemoveButton(button)) {
    button.textContent = uiT('book.remove');
  } else {
    button.textContent = bookmarked ? uiT('book.inFavorite') : uiT('book.addFavorite');
  }
  button.classList.toggle('is-active', Boolean(bookmarked));
  if (bookmarked) {
    button.dataset.activeFavorite = 'true';
  } else {
    delete button.dataset.activeFavorite;
  }
}

function syncAuthorSeriesFavoriteButtonUi(button, favorite) {
  if (isFavoriteEntityListButton(button)) {
    button.textContent = uiT('book.remove');
  } else {
    button.textContent = favorite ? uiT('book.inFavorite') : uiT('book.addFavorite');
  }
  button.classList.toggle('is-active', Boolean(favorite));
  if (favorite) {
    button.dataset.activeFavorite = 'true';
  } else {
    delete button.dataset.activeFavorite;
  }
}

function attachReadBookActions() {
  document.querySelectorAll('[data-read-button]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const bookId = btn.dataset.readButton;
      try {
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const headers = {};
        if (csrfMeta) headers['x-csrf-token'] = csrfMeta.content;
        const response = await fetch(`/api/read/${encodeURIComponent(bookId)}`, {
          method: 'POST', credentials: 'same-origin', headers
        });
        if (await handleAuthRequired(response)) return;
        if (!response.ok) return;
        const { read } = await response.json();
        btn.classList.toggle('is-active', read);
        btn.textContent = read ? uiT('book.markedRead') : uiT('book.markRead');
        // sync grid badges on same page
        toggleReadBadgesForBook(bookId, read);
      } catch (err) { console.error('Read toggle error', err); }
    });
  });
}

function toggleReadBadgesForBook(bookId, isRead) {
  const set = getReadBookIdSet();
  if (isRead) set.add(bookId); else set.delete(bookId);
  document.querySelectorAll(`.card[data-book-id="${CSS.escape(bookId)}"]`).forEach((card) => {
    const cover = card.querySelector('.cover');
    if (!cover) return;
    const existing = cover.querySelector('.read-badge');
    if (isRead && !existing) {
      const span = document.createElement('span');
      span.className = 'read-badge';
      span.innerHTML = READ_BADGE_SVG;
      cover.appendChild(span);
    } else if (!isRead && existing) {
      existing.remove();
    }
  });
}

function attachCoverLongPress() {
  const LONG_PRESS_MS = 500;
  let timer = null;
  let fired = false;
  let startX = 0, startY = 0;

  function getCardBookId(el) {
    const card = el.closest('.card[data-book-id]');
    return card ? card.dataset.bookId : null;
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  async function toggleRead(bookId, cover) {
    fired = true;
    try {
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const headers = {};
      if (csrfMeta) headers['x-csrf-token'] = csrfMeta.content;
      const response = await fetch(`/api/read/${encodeURIComponent(bookId)}`, {
        method: 'POST', credentials: 'same-origin', headers
      });
      if (await handleAuthRequired(response)) return;
      if (!response.ok) return;
      const { read } = await response.json();
      toggleReadBadgesForBook(bookId, read);
      showToast(read ? uiT('book.markedRead') : uiT('book.markRead'), 'success');
    } catch (err) { console.error('Long-press read toggle error', err); }
  }

  function onStart(e) {
    const cover = e.target.closest('.cover[data-role="cover"]');
    if (!cover) return;
    const bookId = getCardBookId(cover);
    if (!bookId) return;
    fired = false;
    const point = e.touches ? e.touches[0] : e;
    startX = point.clientX;
    startY = point.clientY;
    timer = setTimeout(() => {
      timer = null;
      // haptic feedback if available
      if (navigator.vibrate) navigator.vibrate(30);
      toggleRead(bookId, cover);
    }, LONG_PRESS_MS);
  }

  function onMove(e) {
    if (!timer) return;
    const point = e.touches ? e.touches[0] : e;
    if (Math.abs(point.clientX - startX) > 10 || Math.abs(point.clientY - startY) > 10) cancel();
  }

  function onEnd(e) {
    cancel();
    if (fired) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  document.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend', onEnd);
  document.addEventListener('touchcancel', cancel);
  // prevent navigation after long-press
  document.addEventListener('click', (e) => {
    if (fired) {
      e.preventDefault();
      e.stopPropagation();
      fired = false;
    }
  }, true);
}

function attachSeriesLongPress() {
  const LONG_PRESS_MS = 500;
  let timer = null;
  let fired = false;
  let startX = 0, startY = 0;

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  async function toggleSeriesRead(seriesName, row) {
    fired = true;
    try {
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const headers = { 'Content-Type': 'application/json' };
      if (csrfMeta) headers['x-csrf-token'] = csrfMeta.content;
      const response = await fetch('/api/read/batch', {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ facet: 'series', value: seriesName })
      });
      if (await handleAuthRequired(response)) return;
      if (!response.ok) return;
      const data = await response.json();
      const badge = row.querySelector('.read-series-badge');
      if (data.action === 'removed') {
        if (badge) badge.remove();
        showToast(uiTp('facet.seriesReadRemoved', { n: data.removed }), 'success');
      } else {
        if (!badge) {
          const span = document.createElement('span');
          span.className = 'read-series-badge';
          span.innerHTML = READ_BADGE_SVG;
          const div = row.querySelector('div[style*="flex"]') || row.querySelector('div');
          if (div) div.appendChild(span);
        }
        if (data.added > 0) showToast(uiTp('facet.seriesReadAdded', { n: data.added }), 'success');
        else showToast(uiT('facet.seriesAlreadyRead'), 'info');
      }
    } catch (err) { console.error('Series long-press error', err); }
  }

  function onStart(e) {
    const row = e.target.closest('.table-row-link[href*="/facet/series/"]');
    if (!row) return;
    fired = false;
    const point = e.touches ? e.touches[0] : e;
    startX = point.clientX;
    startY = point.clientY;
    const href = row.getAttribute('href') || '';
    const m = href.match(/\/facet\/series\/(.+)$/);
    if (!m) return;
    const seriesName = decodeURIComponent(m[1]);
    timer = setTimeout(() => {
      timer = null;
      if (navigator.vibrate) navigator.vibrate(30);
      toggleSeriesRead(seriesName, row);
    }, LONG_PRESS_MS);
  }

  function onMove(e) {
    if (!timer) return;
    const point = e.touches ? e.touches[0] : e;
    if (Math.abs(point.clientX - startX) > 10 || Math.abs(point.clientY - startY) > 10) cancel();
  }

  function onEnd(e) {
    cancel();
    if (fired) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  document.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend', onEnd);
  document.addEventListener('touchcancel', cancel);
  document.addEventListener('click', (e) => {
    if (fired && e.target.closest('.table-row-link[href*="/facet/series/"]')) {
      e.preventDefault();
      e.stopPropagation();
      fired = false;
    }
  }, true);
}

function attachMarkSeriesReadActions() {
  document.querySelectorAll('[data-mark-series-read]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const seriesName = btn.dataset.markSeriesRead;
      try {
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const headers = { 'Content-Type': 'application/json' };
        if (csrfMeta) headers['x-csrf-token'] = csrfMeta.content;
        btn.disabled = true;
        const response = await fetch('/api/read/batch', {
          method: 'POST', credentials: 'same-origin', headers,
          body: JSON.stringify({ facet: 'series', value: seriesName })
        });
        if (await handleAuthRequired(response)) return;
        if (!response.ok) { btn.disabled = false; return; }
        const data = await response.json();
        btn.disabled = false;
        if (data.action === 'removed') {
          btn.classList.remove('is-active');
          btn.textContent = uiT('facet.markSeriesRead');
          showToast(uiTp('facet.seriesReadRemoved', { n: data.removed }), 'success');
        } else {
          btn.classList.add('is-active');
          btn.textContent = uiT('facet.seriesMarkedRead');
          if (data.added > 0) {
            showToast(uiTp('facet.seriesReadAdded', { n: data.added }), 'success');
          } else {
            showToast(uiT('facet.seriesAlreadyRead'), 'info');
          }
        }
      } catch (err) {
        console.error('Mark series read error', err);
        btn.disabled = false;
      }
    });
  });
}

async function attachBookmarkActions() {
  const buttons = [...document.querySelectorAll('[data-bookmark-button]')];
  for (const button of buttons) {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const bookId = button.dataset.bookmarkButton;
      const removing =
        isFavoriteBookListRemoveButton(button) ||
        button.dataset.activeFavorite === 'true' ||
        button.classList.contains('is-active');
      if (removing) {
        const card = button.closest('.card');
        const title = (card?.querySelector('h3 a')?.textContent || '').trim();
        const msg = title ? uiTp('app.removeBookFavorite', { title }) : uiT('app.removeBookFavoriteShort');
        if (!await confirmAction(msg, { danger: true })) return;
      }
      try {
        const response = await fetch(`/api/bookmarks/${encodeURIComponent(bookId)}`, {
          method: 'POST',
          credentials: 'same-origin'
        });
        if (await handleAuthRequired(response)) {
          return;
        }
        if (!response.ok) {
          showToast(uiT('app.favoriteBookError'), 'error');
          return;
        }
        const payload = await response.json();
        const favoritesView = getCurrentFavoritesView();
        syncBookBookmarkButtonUi(button, Boolean(payload.bookmarked));
        if (!payload.bookmarked && favoritesView === 'books') {
          const card = button.closest('.card');
          const row = button.closest('.table-row');
          const item = card || row;
          if (item) {
            item.style.display = 'none';
            updateFavoritesViewState('books');
            const removeTimer = window.setTimeout(() => {
              if (item.style.display === 'none') {
                item.remove();
                updateFavoritesViewState('books');
              }
            }, 5500);
            showToast(uiT('app.bookRemovedFavorite'), 'success', {
              actionLabel: uiT('app.undo'), duration: 5000,
              onAction: () => {
                window.clearTimeout(removeTimer);
                item.style.display = '';
                syncBookBookmarkButtonUi(button, true);
                updateFavoritesViewState('books');
                void (async () => {
                  try {
                    const r = await fetch(`/api/bookmarks/${encodeURIComponent(bookId)}`, { method: 'POST', credentials: 'same-origin' });
                    if (await handleAuthRequired(r)) return;
                    if (!r.ok) {
                      item.style.display = 'none';
                      updateFavoritesViewState('books');
                      showToast(uiT('app.favoriteBookUndoFail'), 'error');
                    }
                  } catch {
                    item.style.display = 'none';
                    updateFavoritesViewState('books');
                    showToast(uiT('app.networkError'), 'error');
                  }
                })();
              }
            });
            return;
          }
        }
        showToast(payload.bookmarked ? uiT('app.bookAddedFavorite') : uiT('app.bookRemovedFavorite'), 'success');
      } catch (error) {
        console.error(error);
        showToast(uiT('app.bookFavoriteNetwork'), 'error');
      }
    });
  }
}

async function attachFavoriteActions() {
  const authorButtons = [...document.querySelectorAll('[data-favorite-author]')];
  for (const button of authorButtons) {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const name = String(button.dataset.favoriteAuthor || '');
      const removing =
        isFavoriteEntityListButton(button) ||
        button.dataset.activeFavorite === 'true' ||
        button.classList.contains('is-active');
      if (removing) {
        if (!await confirmAction(uiTp('app.removeAuthorFavorite', { name }), { danger: true })) return;
      }
      try {
        const response = await fetch('/api/favorites/authors', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: button.dataset.favoriteAuthor })
        });
        if (await handleAuthRequired(response)) {
          return;
        }
        if (!response.ok) {
          showToast(uiT('app.favoriteAuthorError'), 'error');
          return;
        }
        const payload = await response.json();
        const favoritesView = getCurrentFavoritesView();
        syncAuthorSeriesFavoriteButtonUi(button, Boolean(payload.favorite));
        if (!payload.favorite && favoritesView === 'authors') {
          const row = button.closest('.table-row');
          if (row) {
            row.style.display = 'none';
            updateFavoritesViewState('authors');
            const authorName = button.dataset.favoriteAuthor;
            const removeTimer = window.setTimeout(() => {
              if (row.style.display === 'none') {
                row.remove();
                updateFavoritesViewState('authors');
              }
            }, 5500);
            showToast(uiT('app.authorRemovedFavorite'), 'success', {
              actionLabel: uiT('app.undo'), duration: 5000,
              onAction: () => {
                window.clearTimeout(removeTimer);
                row.style.display = '';
                syncAuthorSeriesFavoriteButtonUi(button, true);
                updateFavoritesViewState('authors');
                void (async () => {
                  try {
                    const r = await fetch('/api/favorites/authors', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ name: authorName })
                    });
                    if (await handleAuthRequired(r)) return;
                    if (!r.ok) {
                      row.style.display = 'none';
                      updateFavoritesViewState('authors');
                      showToast(uiT('app.authorUndoFail'), 'error');
                    }
                  } catch {
                    row.style.display = 'none';
                    updateFavoritesViewState('authors');
                    showToast(uiT('app.networkError'), 'error');
                  }
                })();
              }
            });
            return;
          }
        }
        showToast(payload.favorite ? uiT('app.authorAddedFavorite') : uiT('app.authorRemovedFavorite'), 'success');
      } catch (error) {
        console.error(error);
        showToast(uiT('app.authorFavoriteNetwork'), 'error');
      }
    });
  }

  const seriesButtons = [...document.querySelectorAll('[data-favorite-series]')];
  for (const button of seriesButtons) {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const name = String(button.dataset.favoriteSeries || '');
      const removing =
        isFavoriteEntityListButton(button) ||
        button.dataset.activeFavorite === 'true' ||
        button.classList.contains('is-active');
      if (removing) {
        if (!await confirmAction(uiTp('app.removeSeriesFavorite', { name }), { danger: true })) return;
      }
      try {
        const response = await fetch('/api/favorites/series', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: button.dataset.favoriteSeries })
        });
        if (await handleAuthRequired(response)) {
          return;
        }
        if (!response.ok) {
          showToast(uiT('app.favoriteSeriesError'), 'error');
          return;
        }
        const payload = await response.json();
        const favoritesView = getCurrentFavoritesView();
        syncAuthorSeriesFavoriteButtonUi(button, Boolean(payload.favorite));
        if (!payload.favorite && favoritesView === 'series') {
          const row = button.closest('.table-row');
          if (row) {
            row.style.display = 'none';
            updateFavoritesViewState('series');
            const seriesName = button.dataset.favoriteSeries;
            const removeTimer = window.setTimeout(() => {
              if (row.style.display === 'none') {
                row.remove();
                updateFavoritesViewState('series');
              }
            }, 5500);
            showToast(uiT('app.seriesRemovedFavorite'), 'success', {
              actionLabel: uiT('app.undo'), duration: 5000,
              onAction: () => {
                window.clearTimeout(removeTimer);
                row.style.display = '';
                syncAuthorSeriesFavoriteButtonUi(button, true);
                updateFavoritesViewState('series');
                void (async () => {
                  try {
                    const r = await fetch('/api/favorites/series', {
                      method: 'POST',
                      credentials: 'same-origin',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ name: seriesName })
                    });
                    if (await handleAuthRequired(r)) return;
                    if (!r.ok) {
                      row.style.display = 'none';
                      updateFavoritesViewState('series');
                      showToast(uiT('app.seriesUndoFail'), 'error');
                    }
                  } catch {
                    row.style.display = 'none';
                    updateFavoritesViewState('series');
                    showToast(uiT('app.networkError'), 'error');
                  }
                })();
              }
            });
            return;
          }
        }
        showToast(payload.favorite ? uiT('app.seriesAddedFavorite') : uiT('app.seriesRemovedFavorite'), 'success');
      } catch (error) {
        console.error(error);
        showToast(uiT('app.seriesFavoriteNetwork'), 'error');
      }
    });
  }
}

function updateFavoritesViewState(view) {
  const switcherLink = document.querySelector(`.favorites-switcher [href="/favorites?view=${view}"]`);
  if (!switcherLink) return;
  const countNode = switcherLink.querySelector('.favorites-switcher-count');
  if (!countNode) return;

  const sectionTitleMuted = document.querySelector('.favorites-section .section-title .muted, .favorites-section-books .section-title .muted');

  if (view === 'books') {
    const cards = [...document.querySelectorAll('.favorites-section-books .card')];
    const visibleCards = cards.filter((el) => el.style.display !== 'none');
    const hasHiddenPendingUndo = cards.some((el) => el.style.display === 'none');
    const count = visibleCards.length;
    countNode.textContent = String(count);
    if (sectionTitleMuted) sectionTitleMuted.textContent = String(count);
    const container = document.querySelector('.favorites-section-books .grid');
    if (!count && container && !hasHiddenPendingUndo) {
      const emptyState = document.createElement('div');
      emptyState.className = 'empty-state';
      emptyState.innerHTML = `<strong>${escapeHtml(uiT('favorites.emptyBooksTitle'))}</strong><span class="muted">${escapeHtml(uiT('favorites.emptyBooksText'))}</span><div class="actions"><a class="entity-link" href="/">${escapeHtml(uiT('favorites.toCatalog'))}</a></div>`;
      container.replaceWith(emptyState);
    }
    return;
  }

  const rows = [...document.querySelectorAll('.favorites-list .table-row')];
  const visibleRows = rows.filter((el) => el.style.display !== 'none');
  const hasHiddenPendingUndo = rows.some((el) => el.style.display === 'none');
  const count = visibleRows.length;
  countNode.textContent = String(count);
  if (sectionTitleMuted) sectionTitleMuted.textContent = String(count);
  const container = document.querySelector('.favorites-list');
  if (!count && container && !hasHiddenPendingUndo) {
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    if (view === 'authors') {
      emptyState.innerHTML = `<strong>${escapeHtml(uiT('favorites.emptyAuthorsTitle'))}</strong><span class="muted">${escapeHtml(uiT('favorites.emptyAuthorsText'))}</span><div class="actions"><a class="entity-link" href="/authors">${escapeHtml(uiT('favorites.openAuthors'))}</a></div>`;
    } else {
      emptyState.innerHTML = `<strong>${escapeHtml(uiT('favorites.emptySeriesTitle'))}</strong><span class="muted">${escapeHtml(uiT('favorites.emptySeriesText'))}</span><div class="actions"><a class="entity-link" href="/series">${escapeHtml(uiT('favorites.openSeries'))}</a></div>`;
    }
    container.replaceWith(emptyState);
  }
}

async function pollIndexStatus() {
  const banner = document.querySelector('[data-index-status]');
  if (!banner) {
    return;
  }

  const renderBanner = (content, tone = 'default', statsFromApi = null) => {
    const statsHtml =
      statsFromApi != null
        ? renderIndexStatsBlock(statsFromApi)
        : (() => {
            const statsBlock = banner.querySelector('.index-banner-stats');
            return statsBlock ? statsBlock.outerHTML : '';
          })();
    if (tone === 'error') {
      banner.style.background = 'rgba(244,63,94,0.12)';
      banner.style.borderColor = 'rgba(244,63,94,0.24)';
    } else {
      banner.style.background = '';
      banner.style.borderColor = '';
    }
    banner.innerHTML = `<div class="index-banner-row"><div>${content}</div>${statsHtml}</div>`;
  };

  const refresh = async () => {
    try {
      const response = await fetch('/api/index-status', { credentials: 'same-origin' });
      if (!response.ok) {
        return;
      }

      const status = await response.json();
      if (status.active) {
        renderBanner(`<span>${escapeHtml(uiT('app.indexUpdating'))}</span>`);
        const scheduleNext = () => {
          if (document.visibilityState === 'visible') { refresh(); } else {
            const onVis = () => { document.removeEventListener('visibilitychange', onVis); refresh(); };
            document.addEventListener('visibilitychange', onVis);
          }
        };
        window.setTimeout(scheduleNext, 3000);
        return;
      }

      if (status.error) {
        renderBanner(uiTp('app.indexError', { error: escapeHtml(status.error) }), 'error');
        return;
      }

      if (status.indexedAt) {
        banner.style.display = 'none';
      }
    } catch (error) {
      console.error(error);
    }
  };

  refresh();
}

async function pollAdminIndexControls() {
  const root = document.querySelector('[data-admin-index-controls]');
  if (!root) return;
  // On sources page, attachSourcesReindex handles indexing progress,
  // but we still need to handle deletion progress on all pages.
  const isSourcesPage = Boolean(document.querySelector('[data-reindex-btn]'));
  const currentController = String(root.dataset.progressController || '');
  if (!isSourcesPage) {
    if (currentController && currentController !== 'admin-poll') return;
    root.dataset.progressController = 'admin-poll';
  }
  const textNode = document.getElementById('sources-progress-text');
  const archiveNode = document.getElementById('sources-progress-archive');
  const barNode = document.getElementById('sources-progress-bar');
  const timeNode = document.getElementById('sources-progress-time');

  const applyStatus = (status) => {
    const active = Boolean(status?.active);
    if (!active) {
      root.style.display = 'none';
      return;
    }
    root.style.display = '';
    // Hide pause/stop buttons on non-sources pages
    const actionsRow = root.querySelector('.admin-actions-row');
    if (actionsRow) actionsRow.style.display = isSourcesPage ? '' : 'none';
    const total = Number(status?.totalArchives || 0);
    const processed = Number(status?.processedArchives || 0);
    const imported = Math.max(0, Math.floor(Number(status?.importedBooks) || 0));
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    const paused = Boolean(status?.pauseRequested || status?.paused);
    if (textNode) {
      textNode.innerHTML =
        `${escapeHtml(uiT('app.adminIndexingLabel'))} <strong>${percent}%</strong>` +
        `<span class="muted" style="margin-left:12px">${escapeHtml(uiTp('app.adminIndexFilesLine', { processed, total, imported }))}</span>`;
    }
    if (timeNode) {
      const { elapsed, eta } = computeIndexTimeInfo(status?.startedAt, processed, total);
      const parts = [];
      if (elapsed) parts.push(uiTp('app.indexElapsed', { time: elapsed }));
      if (eta) parts.push(uiTp('app.indexEta', { time: eta }));
      timeNode.textContent = parts.join('  \u00b7  ');
    }
    if (archiveNode) {
      archiveNode.textContent = status?.currentArchive ? String(status.currentArchive) : '';
    }
    if (barNode) {
      barNode.style.width = `${percent}%`;
      barNode.style.background = 'var(--accent)';
    }
    if (!isSourcesPage) {
      const pauseButtons = [...root.querySelectorAll('[data-operation-action="reindex-toggle-pause"]')];
      for (const button of pauseButtons) {
        button.disabled = false;
        button.dataset.reindexPaused = paused ? '1' : '0';
        button.dataset.operationLabel = paused ? uiT('app.adminIndexResumeLabel') : uiT('app.adminIndexPauseLabel');
        button.textContent = paused ? uiT('app.adminIndexResume') : uiT('app.adminIndexPause');
      }
      const stopButtons = [...root.querySelectorAll('[data-operation-action="reindex-stop"]')];
      for (const button of stopButtons) {
        button.disabled = false;
      }
    }
  };

  const applyDeleteStatus = (status) => {
    if (!status?.running) {
      return false;
    }
    root.style.display = '';
    const actionsRow = root.querySelector('.admin-actions-row');
    if (actionsRow) actionsRow.style.display = 'none';
    const stage = status.stage || 'prepare';
    const stageLabels = {
      prepare: uiT('app.adminDeleteStagePrepare') || '\u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043a\u0430\u2026',
      cleanup: uiT('app.adminDeleteStageCleanup') || '\u041e\u0447\u0438\u0441\u0442\u043a\u0430 \u0441\u0432\u044f\u0437\u0435\u0439\u2026',
      books: uiT('app.adminDeleteStageBooks') || '\u0423\u0434\u0430\u043b\u0435\u043d\u0438\u0435 \u043a\u043d\u0438\u0433\u2026',
      catalogs: uiT('app.adminDeleteStageCatalogs') || '\u041e\u0447\u0438\u0441\u0442\u043a\u0430 \u043a\u0430\u0442\u0430\u043b\u043e\u0433\u043e\u0432\u2026',
      fts: uiT('app.adminDeleteStageFts') || '\u041f\u0435\u0440\u0435\u0441\u0442\u0440\u043e\u0435\u043d\u0438\u0435 \u043f\u043e\u0438\u0441\u043a\u0430\u2026',
      vacuum: uiT('app.adminDeleteStageVacuum') || '\u0421\u0436\u0430\u0442\u0438\u0435 \u0431\u0430\u0437\u044b\u2026',
      done: uiT('app.adminDeleteStageDone') || '\u0413\u043e\u0442\u043e\u0432\u043e'
    };
    const label = stageLabels[stage] || stage;
    let percent = 0;
    if (stage === 'books' && status.total > 0) {
      percent = Math.round((status.deleted / status.total) * 100);
    } else if (stage === 'fts' && status.ftsTotal > 0) {
      percent = Math.round((status.ftsDone / status.ftsTotal) * 100);
    } else if (stage === 'done') {
      percent = 100;
    }
    if (textNode) {
      const detail = stage === 'books' && status.total > 0
        ? ` <span class="muted">${status.deleted} / ${status.total}</span>`
        : '';
      textNode.innerHTML = `${escapeHtml(uiT('app.adminDeleteLabel') || '\u0423\u0434\u0430\u043b\u0435\u043d\u0438\u0435 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430')} \u2014 ${escapeHtml(label)}${detail}`;
    }
    if (archiveNode) archiveNode.textContent = status.sourceName || '';
    if (barNode) {
      barNode.style.width = `${percent}%`;
      barNode.style.background = 'var(--accent)';
    }
    if (timeNode) timeNode.textContent = '';
    return true;
  };

  const refresh = async () => {
    // On sources page, attachSourceDelete handles deletion progress — skip here to avoid conflicts.
    if (!isSourcesPage) {
      try {
        // Check deletion status first (higher priority)
        const delRes = await fetch('/api/admin/sources/delete-progress', { credentials: 'same-origin' });
        if (delRes.ok) {
          const delStatus = await delRes.json();
          if (applyDeleteStatus(delStatus)) {
            window.setTimeout(scheduleRefresh, 500);
            return;
          }
        }
      } catch {}
      // Then check indexing status
      try {
        const res = await fetch('/api/index-status', { credentials: 'same-origin' });
        if (res.ok) {
          const status = await res.json();
          applyStatus(status);
        }
      } catch {}
    }
    window.setTimeout(scheduleRefresh, 3000);
  };

  const scheduleRefresh = () => {
    if (document.visibilityState === 'visible') {
      refresh();
    } else {
      const onVisible = () => {
        document.removeEventListener('visibilitychange', onVisible);
        refresh();
      };
      document.addEventListener('visibilitychange', onVisible);
    }
  };

  refresh();
}

async function attachOperationActions() {
  const buttons = [...document.querySelectorAll('[data-operation-action]')];
  for (const button of buttons) {
    button.addEventListener('click', async () => {
      const action = button.dataset.operationAction;

      if (action === 'restart') {
        if (!await confirmAction(uiT('app.confirmRestart'))) return;
      }

      if (action === 'reindex' && button.dataset.operationMode === 'full') {
        if (!await confirmAction(uiT('app.confirmFullReindex'))) return;
      }

      button.disabled = true;
      const previousText = button.textContent;
      button.textContent = '';
      button.insertAdjacentHTML('beforeend', '<span class="btn-spinner"></span>');
      button.insertAdjacentHTML('beforeend', '<span>' + escapeHtml(uiT('app.running')) + '</span>');
      try {
        if (action === 'reindex-toggle-pause' || action === 'reindex-stop') {
          const effectiveAction = action === 'reindex-toggle-pause'
            ? 'reindex-toggle-pause'
            : action;
          const response = await fetch(`/api/operations/${effectiveAction}`, {
            method: 'POST',
            credentials: 'same-origin'
          });
          if (!response.ok) {
            button.textContent = uiT('app.error');
            showToast(uiT('app.operationFailed'), 'error');
            window.setTimeout(() => {
              button.disabled = false;
              button.textContent = previousText;
            }, 1500);
            return;
          }
          button.textContent = uiT('app.started');
          showToast(uiT('app.operationStarted'), 'success');
          if (action === 'reindex-toggle-pause') {
            let nowPaused = button.dataset.reindexPaused === '1';
            try {
              const payload = await response.clone().json();
              if (payload && typeof payload === 'object' && payload.paused !== undefined) {
                nowPaused = Boolean(payload.paused);
              }
            } catch {
              // keep previous state when payload parsing fails
            }
            button.dataset.reindexPaused = nowPaused ? '1' : '0';
            button.dataset.operationLabel = nowPaused ? uiT('app.adminIndexResumeLabel') : uiT('app.adminIndexPauseLabel');
            button.textContent = nowPaused ? uiT('app.adminIndexResume') : uiT('app.adminIndexPause');
            button.disabled = false;
          } else {
            window.setTimeout(() => {
              button.disabled = false;
              button.textContent = previousText;
            }, 1000);
          }
          return;
        }

        const mode = button.dataset.operationMode || '';
        const hasMode = mode && action === 'reindex';
        const url = hasMode
          ? `/api/operations/${action}?mode=${encodeURIComponent(mode)}`
          : `/api/operations/${action}`;
        const fetchOptions = {
          method: 'POST',
          credentials: 'same-origin'
        };
        if (action === 'sidecar-rebuild') {
          fetchOptions.headers = { 'Content-Type': 'application/json' };
          fetchOptions.body = JSON.stringify({});
        }
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
          button.textContent = uiT('app.error');
          showToast(uiT('app.operationFailed'), 'error');
          window.setTimeout(() => {
            button.disabled = false;
            button.textContent = previousText;
          }, 1500);
          return;
        }

        if (action === 'restart') {
          button.textContent = uiT('app.restarting');
          showToast(uiT('app.serverRestarting'), 'success');
          const pollUntilUp = async () => {
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const r = await fetch('/api/operations', { credentials: 'same-origin' });
                if (r.ok) { window.location.reload(); return; }
              } catch {}
            }
            window.location.reload();
          };
          pollUntilUp();
          return;
        }

        if (action === 'sidecar-rebuild') {
          button.textContent = uiT('app.started');
          showToast('Sidecar rebuild started', 'success');
          window.setTimeout(() => {
            button.disabled = false;
            button.textContent = previousText;
          }, 1200);
          return;
        }

        button.textContent = uiT('app.started');
        showToast(uiT('app.operationStarted'), 'success');
        window.setTimeout(() => {
          window.location.reload();
        }, 1200);
      } catch (error) {
        console.error(error);
        if (action === 'restart') {
          button.textContent = uiT('app.restarting');
          showToast(uiT('app.serverRestarting'), 'success');
          const pollUntilUp = async () => {
            for (let i = 0; i < 30; i++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const r = await fetch('/api/operations', { credentials: 'same-origin' });
                if (r.ok) { window.location.reload(); return; }
              } catch {}
            }
            window.location.reload();
          };
          pollUntilUp();
          return;
        }
        button.textContent = uiT('app.error');
        showToast(uiT('app.operationNetworkError'), 'error');
        window.setTimeout(() => {
          button.disabled = false;
          button.textContent = previousText;
        }, 1500);
      }
    });
  }
}

function attachSidecarDiagnostics() {
  const root = document.querySelector('[data-sidecar-diagnostics]');
  if (!root) return;
  const bookInput = root.querySelector('[data-sidecar-book-id]');
  const authorInput = root.querySelector('[data-sidecar-author-name]');
  const out = root.querySelector('[data-sidecar-output]');
  const btnBook = root.querySelector('[data-sidecar-check-book]');
  const btnAuthor = root.querySelector('[data-sidecar-check-author]');
  if (!bookInput || !authorInput || !out || !btnBook || !btnAuthor) return;

  const setOut = (value) => {
    out.textContent = String(value || '');
  };

  const run = async (kind) => {
    const isBook = kind === 'book';
    const value = String(isBook ? bookInput.value : authorInput.value).trim();
    if (!value) {
      setOut(isBook ? uiT('app.sidecarCheckBookHint') : uiT('app.sidecarCheckAuthorHint'));
      return;
    }
    btnBook.disabled = true;
    btnAuthor.disabled = true;
    setOut(uiT('app.sidecarChecking'));
    try {
      const url = isBook
        ? `/api/admin/sidecar/book/${encodeURIComponent(value)}`
        : `/api/admin/sidecar/author?name=${encodeURIComponent(value)}`;
      const res = await fetch(url, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setOut(JSON.stringify({ ok: false, status: res.status, ...data }, null, 2));
        return;
      }
      setOut(JSON.stringify(data, null, 2));
    } catch (error) {
      setOut(`Ошибка запроса: ${error.message}`);
    } finally {
      btnBook.disabled = false;
      btnAuthor.disabled = false;
    }
  };

  btnBook.addEventListener('click', () => { run('book'); });
  btnAuthor.addEventListener('click', () => { run('author'); });
  bookInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run('book');
    }
  });
  authorInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run('author');
    }
  });
}

function levelBadgeCls(level) {
  return level === 'error' ? 'event-level-error' : level === 'warn' ? 'event-level-warn' : 'event-level-info';
}

function formatEventDetails(details) {
  const looksLikeTimestamp = (value) => {
    const s = String(value || '').trim();
    return Boolean(s) && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s) || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s));
  };
  const formatDetailValue = (value) => {
    if (looksLikeTimestamp(value)) {
      return formatEventCreatedAt(value);
    }
    if (value && typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };
  if (!details) return '';
  try {
    const parsed = JSON.parse(details);
    return Object.entries(parsed).map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(formatDetailValue(value))}`).join(' · ');
  } catch {
    return escapeHtml(String(details));
  }
}

function normalizeIsoUtcTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('T') && (raw.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(raw))) {
    return raw;
  }
  if (raw.includes(' ')) {
    return `${raw.replace(' ', 'T')}Z`;
  }
  return raw;
}

function formatEventCreatedAt(value) {
  const iso = normalizeIsoUtcTimestamp(value);
  if (!iso) return uiT('common.dash');
  try {
    const loc = getUiLocale() === 'en' ? 'en-US' : 'ru-RU';
    return new Date(iso).toLocaleString(loc, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return String(value || uiT('common.dash'));
  }
}

function renderEventsListInnerHtml(events) {
  const list = events || [];
  const freshestId = list[0]?.id;
  const rows = list.map((event) => {
    const err = event.level === 'error';
    const fresh = event.id === freshestId;
    return `<div class="admin-events-row table-row ${err ? 'event-error' : ''} ${fresh ? 'event-fresh' : ''}">
            <div>
              <span class="event-level-badge ${levelBadgeCls(event.level)}">${escapeHtml(String(event.level || '').toUpperCase())}</span>
              <span class="admin-event-category">${escapeHtml(String(event.category || ''))}</span>
              <span class="admin-events-message">${escapeHtml(String(event.message || ''))}</span>
              <div class="admin-event-meta">
                <span class="muted">${escapeHtml(formatEventCreatedAt(event.createdAt))}</span>
                ${event.details ? `<span class="muted">${formatEventDetails(event.details)}</span>` : ''}
              </div>
            </div>
          </div>`;
  }).join('');
  return rows || `<div class="muted admin-events-empty">${escapeHtml(uiT('admin.events.empty'))}</div>`;
}

async function pollOperationsDashboard() {
  const dashboard = document.querySelector('[data-operations-dashboard]');
  if (!dashboard) {
    return;
  }
  const SPARK_HISTORY_POINTS = 12;
  const cpuHistory = [];
  const ramHistory = [];
  const pushSparkHistory = (arr, value) => {
    if (!Number.isFinite(value)) return;
    arr.push(Math.max(0, Math.min(100, Number(value))));
    while (arr.length > SPARK_HISTORY_POINTS) arr.shift();
  };
  const renderSparkline = (field, values) => {
    const svg = document.querySelector(`[data-operations-field="${field}"]`);
    if (!svg) return;
    if (!values || values.length < 2) {
      svg.innerHTML = '';
      return;
    }
    const maxX = 100;
    const maxY = 24;
    const stepX = maxX / (values.length - 1);
    const points = values.map((v, i) => {
      const x = i * stepX;
      const y = maxY - (v / 100) * maxY;
      return `${x.toFixed(2)} ${y.toFixed(2)}`;
    });
    const linePath = `M ${points.join(' L ')}`;
    const fillPath = `${linePath} L ${maxX} ${maxY} L 0 ${maxY} Z`;
    svg.innerHTML = `<path class="spark-fill" d="${fillPath}"></path><path class="spark-line" d="${linePath}"></path>`;
  };

  const refresh = async () => {
    try {
      const response = await fetch('/api/operations', { credentials: 'same-origin' });
      if (!response.ok) {
        window.setTimeout(scheduleRefresh, 5000);
        return;
      }

      const payload = await response.json();
      const { operations, indexStatus } = payload;
      const actionStates = {
        reindex: Boolean(operations.reindexRunning || indexStatus.active),
        'reindex-toggle-pause': !Boolean(indexStatus.active),
        'reindex-stop': !Boolean(indexStatus.active),
        repair: Boolean(operations.repairRunning),
        'sidecar-rebuild': Boolean(operations.sidecarRunning),
        'cache-clear': false,
        'events-retain': false
      };
      const loc = getUiLocale() === 'en' ? 'en-US' : 'ru-RU';
      const mb = (Number(operations.cacheApproxBytes) || 0) / 1024 / 1024;
      const cpu = Number(operations.cpuPercent);
      const rssMb = Number(operations.memoryMB);
      const systemMb = Number(operations.systemMemoryMB);
      const diskTotalMb = Number(operations.diskTotalMB);
      const diskFreeMb = Number(operations.diskFreeMB);
      const diskUsedMb = Number.isFinite(diskTotalMb) && Number.isFinite(diskFreeMb)
        ? Math.max(0, diskTotalMb - diskFreeMb)
        : NaN;
      const diskTotalGb = Number.isFinite(diskTotalMb) ? diskTotalMb / 1024 : NaN;
      const diskFreeGb = Number.isFinite(diskFreeMb) ? diskFreeMb / 1024 : NaN;
      const uptimeSec = Math.max(0, Math.floor(Number(operations.uptimeSeconds) || 0));
      const upDays = Math.floor(uptimeSec / 86400);
      const upHrs = Math.floor((uptimeSec % 86400) / 3600);
      const upMin = Math.floor((uptimeSec % 3600) / 60);
      const upText = upDays
        ? `${upDays}d ${upHrs}h ${upMin}m`
        : upHrs
          ? `${upHrs}h ${upMin}m`
          : `${upMin}m`;
      const operationsFields = {
        appVersion: 'v' + (operations.appVersion || '?'),
        lastRepairAt: `${uiT('app.lastRepair')} ${operations.lastRepairAt || uiT('common.dash')}`,
        lastRepairError: operations.lastRepairError || '',
        cacheCountInline: `${uiCountLabel('record', operations.cacheCount)} · ${mb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${uiT('app.unitMb')}`,
        monitorCpu: `${uiT('admin.monitor.cpu')}: ${Number.isFinite(cpu) ? cpu.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : uiT('common.dash')}%`,
        monitorRam: `${uiT('admin.monitor.ram')}: ${Number.isFinite(rssMb) ? rssMb.toLocaleString(loc) : uiT('common.dash')} ${uiT('app.unitMb')}`,
        monitorDisk: `${uiT('admin.monitor.disk')}: ${Number.isFinite(diskFreeGb) && Number.isFinite(diskTotalGb)
          ? uiTp('admin.monitor.diskFreeOf', {
            free: diskFreeGb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
            total: diskTotalGb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
            unit: uiT('app.unitGb')
          })
          : uiT('common.dash')}`,
        monitorUptime: `${uiT('admin.monitor.uptime')}: ${upText}`,
        monitorDb: `${uiT('admin.monitor.db')}: ${operations.dbSizeBytes ? ((Number(operations.dbSizeBytes) / 1024 / 1024).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })) : uiT('common.dash')} ${uiT('app.unitMb')}`,
        monitorUsers: `${uiT('admin.monitor.users')}: ${uiTp('admin.monitor.usersFmt', {
          total: (Number(operations.totalUsers) || 0).toLocaleString(loc),
          online: (Number(operations.onlineUsers) || 0).toLocaleString(loc)
        })}`
      };

      for (const [field, value] of Object.entries(operationsFields)) {
        const node = document.querySelector(`[data-operations-field="${field}"]`);
        if (!node) {
          continue;
        }
        node.textContent = value;
        if (field === 'lastRepairError') {
          node.style.display = value ? '' : 'none';
        }
      }

      const monitorBars = {
        monitorCpuBar: Number.isFinite(cpu) ? Math.max(0, Math.min(100, cpu)) : 0,
        monitorRamBar: Number.isFinite(rssMb) && Number.isFinite(systemMb) && systemMb > 0
          ? Math.max(0, Math.min(100, (rssMb / systemMb) * 100))
          : 0,
        monitorDiskBar: Number.isFinite(diskUsedMb) && Number.isFinite(diskTotalMb) && diskTotalMb > 0
          ? Math.max(0, Math.min(100, (diskUsedMb / diskTotalMb) * 100))
          : 0,
        monitorDbBar: operations.dbSizeBytes
          ? Math.max(0, Math.min(100, (Number(operations.dbSizeBytes) / 1024 / 1024 / 2048) * 100))
          : 0
      };
      const monitorBarGradient = (pct) => {
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        const c0 = { r: 63, g: 185, b: 94 };
        const c1 = { r: 226, g: 187, b: 79 };
        const c2 = { r: 217, g: 80, b: 80 };
        const lerp = (a, b, t) => Math.round(a + (b - a) * t);
        let out;
        if (p <= 70) {
          const t = p / 70;
          out = { r: lerp(c0.r, c1.r, t), g: lerp(c0.g, c1.g, t), b: lerp(c0.b, c1.b, t) };
        } else {
          const t = (p - 70) / 30;
          out = { r: lerp(c1.r, c2.r, t), g: lerp(c1.g, c2.g, t), b: lerp(c1.b, c2.b, t) };
        }
        return `linear-gradient(90deg, rgb(${c0.r}, ${c0.g}, ${c0.b}) 0%, rgb(${out.r}, ${out.g}, ${out.b}) 100%)`;
      };
      for (const [field, pct] of Object.entries(monitorBars)) {
        const bar = document.querySelector(`[data-operations-field="${field}"]`);
        if (!bar) continue;
        bar.style.width = `${pct.toFixed(1)}%`;
        bar.style.background = monitorBarGradient(pct);
      }
      pushSparkHistory(cpuHistory, monitorBars.monitorCpuBar);
      pushSparkHistory(ramHistory, monitorBars.monitorRamBar);
      renderSparkline('monitorCpuSpark', cpuHistory);
      renderSparkline('monitorRamSpark', ramHistory);

      const operationButtons = [...document.querySelectorAll('[data-operation-action]')];
      for (const button of operationButtons) {
        const action = button.dataset.operationAction;
        const running = Boolean(actionStates[action]);
        const label = button.dataset.operationLabel || button.textContent;
        button.disabled = running;
        if (action === 'reindex-toggle-pause') {
          const paused = Boolean(indexStatus.pauseRequested || indexStatus.paused);
          button.dataset.reindexPaused = paused ? '1' : '0';
          button.dataset.operationLabel = paused ? uiT('app.adminIndexResumeLabel') : uiT('app.adminIndexPauseLabel');
          button.textContent = paused ? uiT('app.adminIndexResume') : uiT('app.adminIndexPause');
        } else if (action === 'reindex-stop') {
          button.textContent = label;
        } else {
          button.textContent = running ? uiT('app.running') : label;
        }
      }

      const activeNode = document.querySelector('[data-index-field="active"]');
      if (activeNode) activeNode.textContent = indexStatus.active ? uiT('app.indexActive') : uiT('app.indexIdle');

      document.querySelectorAll('[data-index-field="indexedAt"]').forEach((node) => {
        node.textContent = uiT('app.lastIndexedLabel') + ' ' + (indexStatus.indexedAt ? new Date(indexStatus.indexedAt).toLocaleString(loc, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : uiT('common.dash'));
      });

      const errorNode = document.querySelector('[data-index-field="error"]');
      if (errorNode) {
        if (indexStatus.error) {
          errorNode.textContent = uiT('app.errorPrefix') + ' ' + indexStatus.error;
          errorNode.style.display = '';
        } else {
          errorNode.style.display = 'none';
        }
      }

      const stageNode = document.querySelector('[data-index-field="currentArchive"]');
      if (stageNode) {
        const line = indexStatus.active && indexStatus.currentArchive ? String(indexStatus.currentArchive).trim() : '';
        stageNode.textContent = line;
      }

    } catch (error) {
      console.error(error);
    }
    window.setTimeout(scheduleRefresh, 5000);
  };

  const scheduleRefresh = () => {
    if (document.visibilityState === 'visible') { refresh(); } else {
      const onVisible = () => { document.removeEventListener('visibilitychange', onVisible); refresh(); };
      document.addEventListener('visibilitychange', onVisible);
    }
  };

  refresh();
}

async function pollAdminEventsPage() {
  const pageRoot = document.querySelector('[data-admin-events-page]');
  if (!pageRoot) {
    return;
  }

  const eventsList = document.querySelector('[data-events-list]');
  const totalEl = document.querySelector('[data-admin-events-total]');
  let latestEvents = [];
  let latestTotal = null;
  const renderEventsPayload = (events, total = null) => {
    if (eventsList) {
      eventsList.innerHTML = renderEventsListInnerHtml(events || []);
    }
    if (totalEl && total != null) {
      totalEl.textContent = uiCountLabel('record', total);
    }
  };

  const startPolling = () => {
    const refresh = async () => {
      try {
        const q = window.location.search || '';
        const response = await fetch(`/api/admin/system-events${q}`, { credentials: 'same-origin' });
        if (!response.ok) {
          window.setTimeout(scheduleRefresh, 5000);
          return;
        }
        const data = await response.json();
        latestEvents = Array.isArray(data.events) ? data.events : [];
        latestTotal = Number.isFinite(data.total) ? data.total : latestEvents.length;
        renderEventsPayload(latestEvents, latestTotal);
      } catch (error) {
        console.error(error);
      }
      window.setTimeout(scheduleRefresh, 5000);
    };

    const scheduleRefresh = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      } else {
        const onVisible = () => {
          document.removeEventListener('visibilitychange', onVisible);
          refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
      }
    };

    refresh();
  };

  if (typeof EventSource !== 'function') {
    startPolling();
    return;
  }

  let fallbackStarted = false;
  const q = window.location.search || '';
  const stream = new EventSource(`/api/admin/system-events/stream${q}`, { withCredentials: true });
  stream.onmessage = (event) => {
    let payload = null;
    try {
      payload = JSON.parse(String(event.data || '{}'));
    } catch {
      return;
    }
    if (payload.type === 'snapshot') {
      latestEvents = Array.isArray(payload.events) ? payload.events : [];
      latestTotal = Number.isFinite(payload.total) ? payload.total : latestEvents.length;
      renderEventsPayload(latestEvents, latestTotal);
      return;
    }
    if (payload.type === 'event' && payload.event) {
      latestEvents = [payload.event, ...latestEvents.filter((row) => row.id !== payload.event.id)].slice(0, 200);
      if (Number.isFinite(latestTotal)) {
        latestTotal += 1;
      }
      renderEventsPayload(latestEvents, latestTotal);
    }
  };
  stream.onerror = () => {
    if (fallbackStarted) return;
    fallbackStarted = true;
    stream.close();
    startPolling();
  };
  window.addEventListener('beforeunload', () => stream.close(), { once: true });
}

function attachCatalogNavLoading() {
  document.querySelectorAll('form[data-catalog-loading]').forEach((form) => {
    form.addEventListener('submit', () => {
      form.setAttribute('aria-busy', 'true');
      const btn = form.querySelector('button[type="submit"]');
      if (btn) {
        btn.disabled = true;
        btn.setAttribute('aria-label', uiT('app.catalogSearching'));
      }
    });
  });
}

function attachSmartSearch() {
  const forms = [...document.querySelectorAll('[data-smart-search]')];
  if (!forms.length) return;

  const scopeRoutes = {
    authors: '/authors',
    series: '/series'
  };

  for (const form of forms) {
    form.addEventListener('submit', (e) => {
      const scope = form.querySelector('[data-search-scope]');
      const queryInput = form.querySelector('[name="q"]');
      const q = (queryInput?.value || '').trim();
      const field = scope?.value || 'all';
      const route = scopeRoutes[field];

      if (!route) {
        return;
      }

      e.preventDefault();
      const browseSort = field === 'languages' ? 'count' : 'name';
      window.location.href = q ? `${route}?q=${encodeURIComponent(q)}&sort=${browseSort}` : route;
    });
  }
}

function attachSidebarToggle() {
  const toggle = document.querySelector('[data-sidebar-toggle]');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('[data-sidebar-overlay]');
  if (!toggle || !sidebar) {
    return;
  }

  const open = () => {
    sidebar.classList.add('sidebar-open');
    if (overlay) overlay.classList.add('sidebar-overlay-visible');
    toggle.setAttribute('aria-expanded', 'true');
  };

  const close = () => {
    sidebar.classList.remove('sidebar-open');
    if (overlay) overlay.classList.remove('sidebar-overlay-visible');
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', () => {
    if (sidebar.classList.contains('sidebar-open')) {
      close();
    } else {
      open();
    }
  });

  if (overlay) {
    overlay.addEventListener('click', close);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.classList.contains('sidebar-open')) {
      close();
    }
  });
}

/** Формы с data-confirm / data-confirm-danger — модальное подтверждение вместо window.confirm */
function attachConfirmedFormSubmits() {
  const forms = [...document.querySelectorAll('form[data-confirm]')];
  for (const form of forms) {
    const message = form.getAttribute('data-confirm');
    if (!message) continue;
    const danger = form.hasAttribute('data-confirm-danger');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (await confirmAction(message, { danger })) {
        const btn = form.querySelector('button[type="submit"]');
        if (btn) {
          btn.disabled = true;
          const prev = btn.innerHTML;
          btn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || 'Выполняется…');
        }
        form.submit();
      }
    });
  }
}

/** Add inline btn-spinner to all regular form submit buttons (forms without data-confirm). */
function attachFormSubmitSpinners() {
  const forms = [...document.querySelectorAll('form[action][method="post"], form[action][method="POST"]')];
  for (const form of forms) {
    if (form.hasAttribute('data-confirm') || form.hasAttribute('data-confirm-danger')) continue;
    if (form.id === 'add-source-form') continue; // handled by attachAddSourceForm
    form.addEventListener('submit', (e) => {
      const btn = e.submitter || form.querySelector('button[type="submit"]');
      if (!btn || btn.disabled) return;
      // Preserve submitter name/value before disabling (disabled buttons are excluded from form data)
      if (btn.name) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = btn.name;
        hidden.value = btn.value;
        form.appendChild(hidden);
      }
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || '\u0412\u044b\u043f\u043e\u043b\u043d\u044f\u0435\u0442\u0441\u044f\u2026');
    });
  }
}

function attachSearchSuggest() {
  const input = document.querySelector('[data-suggest-input]');
  const dropdown = document.querySelector('[data-suggest-dropdown]');
  if (!input || !dropdown) return;

  let timer = null;
  let activeIdx = -1;
  let items = [];

  const setExpanded = (open) => {
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const hide = () => {
    dropdown.hidden = true;
    activeIdx = -1;
    input.removeAttribute('aria-activedescendant');
    setExpanded(false);
  };
  const show = () => {
    dropdown.hidden = false;
    setExpanded(true);
  };

  const render = (data) => {
    const sections = [];
    let itemSeq = 0;
    if (data.books?.length) {
      sections.push(`<div class="suggest-group-title">${escapeHtml(uiT('search.books'))}</div>`);
      data.books.forEach((b) => {
        const itemId = `suggest-item-${itemSeq++}`;
        sections.push(`<a class="suggest-item" id="${itemId}" href="/book/${encodeURIComponent(b.id)}" data-suggest-item role="option"><span class="suggest-item-title">${escapeHtml(b.title)}</span><span class="suggest-item-sub">${escapeHtml(b.authors || '')}</span></a>`);
      });
    }
    if (data.authors?.length) {
      sections.push(`<div class="suggest-group-title">${escapeHtml(uiT('search.authors'))}</div>`);
      data.authors.forEach((a) => {
        const itemId = `suggest-item-${itemSeq++}`;
        sections.push(`<a class="suggest-item" id="${itemId}" href="/facet/authors/${encodeURIComponent(a.name)}" data-suggest-item role="option"><span class="suggest-item-title">${escapeHtml(a.displayName || a.name)}</span><span class="suggest-item-sub">${uiCountLabel('book', a.bookCount)}</span></a>`);
      });
    }
    if (data.series?.length) {
      sections.push(`<div class="suggest-group-title">${escapeHtml(uiT('search.series'))}</div>`);
      data.series.forEach((s) => {
        const itemId = `suggest-item-${itemSeq++}`;
        sections.push(`<a class="suggest-item" id="${itemId}" href="/facet/series/${encodeURIComponent(s.name)}" data-suggest-item role="option"><span class="suggest-item-title">${escapeHtml(s.displayName || s.name)}</span><span class="suggest-item-sub">${uiCountLabel('book', s.bookCount)}</span></a>`);
      });
    }
    if (!sections.length) {
      dropdown.innerHTML = `<div class="suggest-empty">${escapeHtml(uiT('browse.empty'))}</div>`;
      dropdown.removeAttribute('aria-busy');
    } else {
      dropdown.innerHTML = sections.join('');
      dropdown.removeAttribute('aria-busy');
    }
    items = [...dropdown.querySelectorAll('[data-suggest-item]')];
    activeIdx = -1;
    show();
  };

  const setActive = (idx) => {
    items.forEach((el, i) => {
      const active = i === idx;
      el.classList.toggle('suggest-active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    activeIdx = idx;
    if (idx >= 0 && items[idx]) {
      const activeItem = items[idx];
      input.setAttribute('aria-activedescendant', activeItem.id);
      activeItem.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    dropdown.setAttribute('aria-busy', 'true');
    timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search/suggest?q=${encodeURIComponent(q)}`);
        if (r.ok) render(await r.json());
        else hide();
      } catch {}
      finally {
        dropdown.removeAttribute('aria-busy');
      }
    }, 250);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && dropdown.hidden && items.length) {
      e.preventDefault();
      show();
      setActive(0);
      return;
    }
    if (dropdown.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); items[activeIdx].click(); }
    else if (e.key === 'Escape') { hide(); }
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== input) hide();
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2 && items.length) show();
  });
  input.addEventListener('blur', () => {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && dropdown.contains(active)) return;
      hide();
    }, 120);
  });
}

function isPageDownloadAllowed() {
  if (typeof document === 'undefined') return true;
  return document.body?.dataset?.downloadAllowed === '1';
}

const READ_BADGE_SVG = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';
let _readBookIdSet = null;
function getReadBookIdSet() {
  if (_readBookIdSet) return _readBookIdSet;
  try {
    const el = document.getElementById('ui-read-ids');
    if (el) _readBookIdSet = new Set(JSON.parse(el.textContent));
  } catch (_) { /* ignore */ }
  if (!_readBookIdSet) _readBookIdSet = new Set();
  return _readBookIdSet;
}

function renderCardHtml(book, { batchSelect = false } = {}) {
  const id = escapeHtml(book.id);
  const title = escapeHtml(book.title || '');
  const authors = escapeHtml(book.authors || '');
  const series = book.series ? escapeHtml(book.series) : '';
  const seriesNo = book.seriesNo ? escapeHtml(String(book.seriesNo)) : '';
  const authorKey = book.authorsList?.[0] || book.authors?.split(',')[0]?.trim() || '';
  const sourceFormat = String(book.ext || 'fb2').toLowerCase();
  const formats =
    Array.isArray(book.downloadFormats) && book.downloadFormats.length
      ? book.downloadFormats.map((x) => [x.format, x.label])
      : sourceFormat === 'fb2'
        ? [['fb2', 'FB2'], ['epub2', 'EPUB']]
        : [[sourceFormat, sourceFormat.toUpperCase()]];
  const downloadMenu =
    !batchSelect && isPageDownloadAllowed()
      ? `<details class="download-menu download-menu-compact">
      <summary class="button download-menu-trigger download-menu-trigger-compact">${escapeHtml(uiT('download.label'))}</summary>
      <div class="download-menu-popover">${formats.map(([f, l]) => `<a class="download-format-link" href="/download/${encodeURIComponent(book.id)}?format=${encodeURIComponent(f)}">${escapeHtml(l)}</a>`).join('')}</div>
    </details>`
      : '';
  const batchCb = batchSelect
    ? `<label class="batch-select-hit" title="${escapeHtml(uiT('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" id="batch-select-${safeDomIdPart(book.id)}" name="batch-select-${safeDomIdPart(book.id)}" data-batch-book-id="${id}" aria-label="${escapeHtml(uiT('batch.selectAria'))}"></label>`
    : '';
  return `<article class="card" data-book-id="${id}">
    ${batchCb}
    <a class="cover" href="/book/${encodeURIComponent(book.id)}" data-role="cover">
      <img class="cover-image is-loaded" loading="lazy" src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" data-cover-src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" alt="${title}">
      <span class="cover-fallback" hidden>
        <img class="cover-fallback-image" src="/book-fallback.png" alt="">
        <span class="cover-fallback-overlay"></span>
        <span class="cover-fallback-copy"><span class="cover-fallback-title">${title}</span><span class="cover-fallback-author">${authors || escapeHtml(uiT('book.authorUnknown'))}</span></span>
      </span>
      ${getReadBookIdSet().has(book.id) ? `<span class="read-badge">${READ_BADGE_SVG}</span>` : ''}
    </a>
    <div class="meta">
      <h3><a href="/book/${encodeURIComponent(book.id)}">${title}</a></h3>
      <div class="author">${authorKey ? `<a href="/facet/authors/${encodeURIComponent(authorKey)}">${authors}</a>` : escapeHtml(uiT('book.authorUnknown'))}</div>
      ${series ? `<div class="card-series"><a href="/facet/series/${encodeURIComponent(book.series)}">${series}${seriesNo ? ` #${seriesNo}` : ''}</a></div>` : ''}
      ${book.readProgress > 0 ? `<div class="card-read-progress"><div class="read-progress-bar" role="progressbar" aria-valuenow="${Math.round(book.readProgress)}" aria-valuemin="0" aria-valuemax="100"><div class="read-progress-fill" style="width:${Math.round(book.readProgress)}%"></div></div><span class="read-progress-label">${Math.round(book.readProgress)}%</span></div>` : ''}
      ${downloadMenu ? `<div class="card-actions">${downloadMenu}</div>` : ''}
    </div>
  </article>`;
}

function attachLoadMore() {
  const trigger = document.querySelector('[data-load-more-trigger]');
  const container = document.querySelector('[data-load-more-grid]');
  if (!trigger || !container) return;
  if (trigger.dataset.loadMoreBound === '1') return;
  trigger.dataset.loadMoreBound = '1';

  trigger.disabled = false;
  trigger.textContent = uiT('catalog.loadMore');

  const api = container.dataset.loadMoreApi;
  let page = Number(container.dataset.loadMorePage) || 1;
  const total = Number(container.dataset.loadMoreTotal) || 0;
  const pageSize = Number(container.dataset.loadMorePageSize) || 24;
  const batchSelect = Boolean(container.dataset.batchContext);

  let activeFetch = null;
  window.addEventListener('pagehide', () => {
    if (activeFetch) activeFetch.abort();
  });

  const skeletonHtml = Array.from({ length: 6 }, () => '<div class="skeleton-card"><div class="skeleton-cover"></div><div class="skeleton-line"></div><div class="skeleton-line skeleton-line-short"></div></div>').join('');

  trigger.addEventListener('click', async () => {
    activeFetch?.abort();
    activeFetch = new AbortController();
    const { signal } = activeFetch;
    page++;
    trigger.disabled = true;
    trigger.textContent = `${uiT('catalog.loadMore')}...`;
    const grid = container.querySelector('.grid');
    const skeletons = [];
    if (grid) {
      const tmp = document.createElement('div');
      tmp.innerHTML = skeletonHtml;
      skeletons.push(...tmp.children);
      for (const s of skeletons) grid.appendChild(s);
    }
    try {
      const sep = api.includes('?') ? '&' : '?';
      const r = await fetch(`${api}${sep}page=${page}`, { credentials: 'same-origin', signal });
      if (!r.ok) throw new Error('fetch failed');
      const data = await r.json();
      for (const s of skeletons) s.remove();
      if (grid && data.items?.length) {
        const existingIds = new Set(
          [...grid.querySelectorAll('[data-book-id]')]
            .map((card) => card.getAttribute('data-book-id'))
            .filter(Boolean)
        );
        const nextItems = [];
        for (const item of data.items) {
          const id = String(item?.id || '');
          if (!id || existingIds.has(id)) continue;
          existingIds.add(id);
          nextItems.push(item);
        }
        const tmp = document.createElement('div');
        tmp.innerHTML = nextItems.map((b) => renderCardHtml(b, { batchSelect })).join('');
        const newCards = [...tmp.children];
        for (const card of newCards) grid.appendChild(card);
        for (const card of newCards) attachCoverErrorFallback(card);
        for (const card of newCards) attachDownloadMenus(card);
        if (batchSelect) {
          const scope = container.closest('.batch-select-scope');
          updateBatchCountForScope(scope);
        }
      }
      if (page * pageSize >= total || !data.items?.length) {
        trigger.remove();
      } else {
        trigger.disabled = false;
        trigger.textContent = uiT('catalog.loadMore');
      }
    } catch (err) {
      for (const s of skeletons) s.remove();
      if (signal.aborted || (err && err.name === 'AbortError')) {
        trigger.disabled = false;
        trigger.textContent = uiT('catalog.loadMore');
        return;
      }
      trigger.disabled = false;
      trigger.textContent = uiT('catalog.loadMore');
      showToast(uiT('app.loadFailed'), 'error');
    }
  });
}

/** Должен совпадать с BATCH_DOWNLOAD_MAX в src/constants.js */
const BATCH_DOWNLOAD_MAX = 20;

function collectCheckedBatchBookIds(scope) {
  if (!scope) return [];
  return [
    ...new Set(
      [...scope.querySelectorAll('input.batch-select-cb')]
        .filter((c) => c.checked)
        .map((c) => c.getAttribute('data-batch-book-id') || c.closest('.card')?.dataset.bookId)
        .filter(Boolean)
    )
  ];
}

function updateBatchCountForScope(scopeEl) {
  if (!scopeEl) return;
  const countEl = scopeEl.querySelector('[data-batch-selected-count]');
  const cbs = [...scopeEl.querySelectorAll('input.batch-select-cb')];
  const n = cbs.filter((c) => c.checked).length;
  if (countEl) {
    if (n === 0) {
      countEl.textContent = '';
      countEl.hidden = true;
    } else {
      countEl.hidden = false;
      countEl.textContent =
        n >= BATCH_DOWNLOAD_MAX ? uiTp('app.batchSelectedMax', { n }) : uiTp('app.batchSelected', { n });
    }
  }
  const toggleBtn = scopeEl.querySelector('[data-batch-toggle-select]');
  if (toggleBtn) {
    if (n > 0) {
      toggleBtn.textContent = uiT('app.batchDeselectAll');
      toggleBtn.setAttribute('aria-pressed', 'true');
    } else {
      toggleBtn.textContent = uiT('app.batchSelectAll');
      toggleBtn.setAttribute('aria-pressed', 'false');
    }
  }
}

function getVisibleBatchCheckboxesInScope(scopeEl) {
  const cbs = scopeEl ? [...scopeEl.querySelectorAll('input.batch-select-cb')] : [];
  return cbs.filter((cb) => {
    const card = cb.closest('.card');
    if (!card) return false;
    return card.offsetParent !== null && card.style.display !== 'none';
  });
}

function parseFilenameFromContentDisposition(header) {
  if (!header) return 'books.zip';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"+|"+$/g, ''));
    } catch {
      return 'books.zip';
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted) {
    try {
      return decodeURIComponent(quoted[1].trim());
    } catch {
      return quoted[1].trim();
    }
  }
  return 'books.zip';
}

function attachBatchDownloadSelection() {
  document.querySelectorAll('[data-batch-download-toolbar]').forEach((toolbar) => {
    if (!toolbar.dataset.batchContext) return;

    let ctx;
    try {
      ctx = JSON.parse(toolbar.dataset.batchContext);
    } catch {
      return;
    }

    const scope = toolbar.closest('.batch-select-scope');

    toolbar.querySelector('[data-batch-toggle-select]')?.addEventListener('click', () => {
      if (!scope) return;
      const checkedNow = [...scope.querySelectorAll('input.batch-select-cb')].filter((c) => c.checked).length;
      if (checkedNow > 0) {
        for (const cb of scope.querySelectorAll('input.batch-select-cb')) cb.checked = false;
      } else {
        for (const cb of scope.querySelectorAll('input.batch-select-cb')) cb.checked = false;
        const visible = getVisibleBatchCheckboxesInScope(scope);
        let k = 0;
        for (const cb of visible) {
          if (k >= BATCH_DOWNLOAD_MAX) break;
          cb.checked = true;
          k++;
        }
        if (visible.length > BATCH_DOWNLOAD_MAX) {
          showToast(uiTp('app.batchMarkMax', { n: BATCH_DOWNLOAD_MAX }), 'info');
        }
      }
      updateBatchCountForScope(scope);
    });

    toolbar.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-batch-download-selected-format]');
      if (!btn) return;
      e.preventDefault();
      if (!scope) return;
      const format = btn.getAttribute('data-batch-download-selected-format') || '';
      const ids = collectCheckedBatchBookIds(scope);
      if (!ids.length) {
        showToast(uiT('app.batchSelectAtLeastOne'), 'error');
        return;
      }
      if (ids.length > BATCH_DOWNLOAD_MAX) {
        showToast(uiTp('app.batchDownloadMax', { n: BATCH_DOWNLOAD_MAX }), 'error');
        return;
      }
      const body = { format, ids };
      if (ctx.shelf != null && Number(ctx.shelf) > 0) {
        body.shelf = Number(ctx.shelf);
      } else if (ctx.adhoc !== true) {
        body.facet = ctx.facet;
        body.value = ctx.value;
      }
      if (toolbar.querySelector('[data-batch-per-book-zip]')?.checked) {
        body.perBookZip = true;
      }
      const allFmtBtns = [...toolbar.querySelectorAll('[data-batch-download-selected-format]')];
      const preparingToast = showToast(uiT('app.batchDownloadPreparing'), 'info', { duration: 120000, spinner: true });
      try {
        allFmtBtns.forEach((b) => { b.disabled = true; });
        const params = new URLSearchParams();
        if (body.format) params.set('format', String(body.format));
        if (Array.isArray(body.ids) && body.ids.length) params.set('ids', body.ids.join(','));
        if (body.shelf != null) params.set('shelf', String(body.shelf));
        if (body.facet) params.set('facet', String(body.facet));
        if (body.value != null) params.set('value', String(body.value));
        if (body.perBookZip) params.set('perBookZip', '1');
        const url = `/download/batch?${params.toString()}`;
        const resp = await fetch(url, { credentials: 'same-origin' });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(errText || `HTTP ${resp.status}`);
        }
        const blob = await resp.blob();
        const filename = parseFilenameFromContentDisposition(resp.headers.get('Content-Disposition'));
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        preparingToast.dismiss();
        showToast(uiT('app.batchDownloadReady'), 'success');
      } catch (err) {
        preparingToast.dismiss();
        showToast(err.message || uiT('app.errorShort'), 'error');
      } finally {
        allFmtBtns.forEach((b) => { b.disabled = false; });
      }
      const details = btn.closest('details');
      if (details) details.removeAttribute('open');
    });

    if (scope) updateBatchCountForScope(scope);
  });

  document.addEventListener('change', (e) => {
    if (!e.target || !e.target.classList || !e.target.classList.contains('batch-select-cb')) return;
    const scope = e.target.closest('.batch-select-scope');
    if (e.target.checked && scope) {
      const checked = [...scope.querySelectorAll('input.batch-select-cb')].filter((c) => c.checked).length;
      if (checked > BATCH_DOWNLOAD_MAX) {
        e.target.checked = false;
        showToast(uiTp('app.batchDownloadMaxShort', { n: BATCH_DOWNLOAD_MAX }), 'error');
      }
    }
    updateBatchCountForScope(scope);
  });
}

/**
 * Страницы /facet/* часто попадают в bfcache при «назад» из книги/серии.
 * Скрипт не выполняется повторно — остаются прерванные fetch (кнопка «ещё» disabled),
 * старые слушатели. Полная перезагрузка дешевле и надёжнее, чем дублировать всю инициализацию.
 */
function attachBfCacheFacetReload() {
  window.addEventListener('pageshow', (ev) => {
    if (!ev.persisted) return;
    const p = window.location.pathname || '';
    if (p.startsWith('/facet/')) {
      window.location.reload();
    }
  });
}

function attachScrollToTop() {
  const button = document.querySelector('[data-scroll-top]');
  if (!button) {
    return;
  }

  const toggle = () => {
    button.classList.toggle('scroll-to-top-visible', window.scrollY > 400);
  };

  window.addEventListener('scroll', toggle, { passive: true });
  toggle();

  button.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function attachShelfActions() {
  const createForm = document.querySelector('[data-shelf-create]');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = createForm.querySelector('input[name="name"]');
      const name = (input?.value || '').trim();
      if (!name) return;
      try {
        const res = await fetch('/api/shelves', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || uiT('app.shelfCreateError'), 'error');
          return;
        }
        showToast(uiT('app.shelfCreated'), 'success');
        window.location.reload();
      } catch {
        showToast(uiT('app.networkError'), 'error');
      }
    });
  }

  for (const row of document.querySelectorAll('.table-row-clickable[data-href]')) {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input')) return;
      window.location.href = row.dataset.href;
    });
  }

  for (const btn of document.querySelectorAll('[data-shelf-delete]')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.shelfDelete;
      const name = btn.dataset.shelfName || '';
      const description = btn.dataset.shelfDescription || '';
      if (!await confirmAction(uiTp('app.shelfDeleteConfirm', { name }), { danger: true })) return;
      let bookIds = [];
      try {
        const booksRes = await fetch(`/api/shelves/${encodeURIComponent(id)}/books`, { credentials: 'same-origin' });
        if (await handleAuthRequired(booksRes)) return;
        if (booksRes.ok) {
          const books = await booksRes.json();
          bookIds = Array.isArray(books) ? books.map((b) => b.id) : [];
        }
      } catch { /* без списка книг отмена создаст пустую полку */ }
      try {
        const delRes = await fetch(`/api/shelves/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (await handleAuthRequired(delRes)) return;
        if (!delRes.ok) {
          showToast(uiT('app.shelfDeleteFail'), 'error');
          return;
        }
        const row = btn.closest('[data-shelf-row]');
        if (!row) {
          showToast(uiT('app.shelfDeleted'), 'success');
          return;
        }
        row.style.display = 'none';
        const removeTimer = window.setTimeout(() => {
          if (row.style.display === 'none') row.remove();
        }, 5500);
        showToast(uiT('app.shelfDeleted'), 'success', {
          actionLabel: uiT('app.undo'),
          duration: 5000,
          onAction: () => {
            window.clearTimeout(removeTimer);
            row.style.display = '';
            void (async () => {
              try {
                const createRes = await fetch('/api/shelves', {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name, description })
                });
                if (await handleAuthRequired(createRes)) return;
                if (!createRes.ok) {
                  const data = await createRes.json().catch(() => ({}));
                  row.style.display = 'none';
                  showToast(data.error || uiT('app.shelfRestoreFail'), 'error');
                  return;
                }
                const data = await createRes.json();
                const newId = data.id;
                for (const bookId of bookIds) {
                  await fetch(`/api/shelves/${newId}/books`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bookId })
                  });
                }
                row.setAttribute('data-shelf-row', String(newId));
                row.dataset.href = `/shelves/${newId}`;
                btn.dataset.shelfDelete = String(newId);
              } catch {
                row.style.display = 'none';
                showToast(uiT('app.networkError'), 'error');
              }
            })();
          }
        });
      } catch {
        showToast(uiT('app.networkError'), 'error');
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-shelf-remove-book]')) {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const bookId = btn.dataset.shelfRemoveBook;
      const shelfId = btn.dataset.shelfId;
      if (!bookId || !shelfId) return;

      const card = btn.closest('.card');
      const title = (card?.querySelector('h3 a')?.textContent || '').trim();
      const msg = title ? uiTp('app.removeFromShelfConfirm', { title }) : uiT('app.removeFromShelfConfirmShort');
      if (!await confirmAction(msg, { danger: true })) return;

      try {
        const res = await fetch(`/api/shelves/${encodeURIComponent(shelfId)}/books/${encodeURIComponent(bookId)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (await handleAuthRequired(res)) return;
        if (!res.ok) {
          showToast(uiT('app.removeFromShelfFail'), 'error');
          return;
        }
        if (card) {
          card.dataset.pendingShelfRemove = '1';
          card.style.display = 'none';
          const removeTimer = window.setTimeout(() => {
            if (card.dataset.pendingShelfRemove === '1' && card.style.display === 'none') {
              card.remove();
            }
          }, 5500);
          showToast(uiT('app.removedFromShelf'), 'success', {
            actionLabel: uiT('app.undo'),
            duration: 5000,
            onAction: () => {
              window.clearTimeout(removeTimer);
              delete card.dataset.pendingShelfRemove;
              void (async () => {
                try {
                  const r = await fetch(`/api/shelves/${encodeURIComponent(shelfId)}/books`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify({ bookId })
                  });
                  if (await handleAuthRequired(r)) return;
                  if (!r.ok) {
                    card.dataset.pendingShelfRemove = '1';
                    card.style.display = 'none';
                    showToast(uiT('app.restoreToShelfFail'), 'error');
                    return;
                  }
                  card.style.display = '';
                } catch {
                  card.dataset.pendingShelfRemove = '1';
                  card.style.display = 'none';
                  showToast(uiT('app.networkError'), 'error');
                }
              })();
            }
          });
          return;
        }
        showToast(uiT('app.removedFromShelf'), 'success');
      } catch {
        showToast(uiT('app.networkError'), 'error');
      }
    });
  }
}

function attachBookIllustrationLightbox() {
  const links = [...document.querySelectorAll('[data-illustration-link]')];
  if (!links.length) return;

  const urls = links.map((a) => a.getAttribute('href') || '').filter(Boolean);
  if (!urls.length) return;

  const openAt = (startIndex) => {
    const total = urls.length;
    let index = Math.min(Math.max(0, startIndex), total - 1);
    const html = `
      <div class="modal-header">
        <span>${escapeHtml(uiT('book.illustrations'))}</span>
        <button type="button" class="modal-close" aria-label="${escapeHtml(uiT('reader.close'))}">&times;</button>
      </div>
      <div class="illustration-lightbox-body">
        <button type="button" class="button illustration-lightbox-nav illustration-lightbox-nav-prev" data-illustration-prev aria-label="${escapeHtml(uiT('book.lightboxPrev'))}">‹</button>
        <div class="illustration-lightbox-stage">
          <img class="illustration-lightbox-image" data-illustration-image alt="">
        </div>
        <button type="button" class="button illustration-lightbox-nav illustration-lightbox-nav-next" data-illustration-next aria-label="${escapeHtml(uiT('book.lightboxNext'))}">›</button>
      </div>
      <div class="illustration-lightbox-meta">
        <span class="muted" data-illustration-counter></span>
      </div>
    `;
    const modal = openModal(html, { title: uiT('book.illustrations') });
    const panel = modal.overlay.querySelector('.modal-panel');
    if (!panel) return;
    panel.classList.add('illustration-lightbox-panel');
    const image = panel.querySelector('[data-illustration-image]');
    const counter = panel.querySelector('[data-illustration-counter]');
    const prevBtn = panel.querySelector('[data-illustration-prev]');
    const nextBtn = panel.querySelector('[data-illustration-next]');
    if (!image || !counter || !prevBtn || !nextBtn) return;

    const render = () => {
      image.setAttribute('src', urls[index]);
      counter.textContent = uiTp('book.lightboxCounter', { current: index + 1, total });
      prevBtn.disabled = total <= 1;
      nextBtn.disabled = total <= 1;
    };

    prevBtn.addEventListener('click', () => {
      index = (index - 1 + total) % total;
      render();
    });
    nextBtn.addEventListener('click', () => {
      index = (index + 1) % total;
      render();
    });

    const keyHandler = (event) => {
      if (!document.body.contains(modal.overlay)) {
        document.removeEventListener('keydown', keyHandler, true);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        index = (index - 1 + total) % total;
        render();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        index = (index + 1) % total;
        render();
      }
    };
    document.addEventListener('keydown', keyHandler, true);
    render();
  };

  links.forEach((a, idx) => {
    a.addEventListener('click', (event) => {
      event.preventDefault();
      openAt(idx);
    });
  });
}

function listFocusableNodes(root) {
  if (!root) return [];
  return [...root.querySelectorAll('a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])')]
    .filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.hidden) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      return el.offsetParent !== null || el === document.activeElement;
    });
}

function openModal(html, options = {}) {
  const { beforeClose, title = uiT('app.modalConfirmTitle') } = options;
  const existing = document.querySelector('.modal-overlay');
  if (existing) existing.remove();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-panel">${html}</div>`;
  document.body.appendChild(overlay);
  const panel = overlay.querySelector('.modal-panel');
  if (panel) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const heading = panel.querySelector('.modal-header span');
    if (heading) {
      if (!heading.id) heading.id = `modal-title-${Date.now()}`;
      panel.setAttribute('aria-labelledby', heading.id);
    } else {
      panel.setAttribute('aria-label', title);
    }
    const desc = panel.querySelector('.modal-form p, .modal-shelf-hint, .modal-list-empty');
    if (desc) {
      if (!desc.id) desc.id = `modal-desc-${Date.now()}`;
      panel.setAttribute('aria-describedby', desc.id);
    }
    const closeBtn = panel.querySelector('.modal-close');
    if (closeBtn && !closeBtn.getAttribute('aria-label')) {
      closeBtn.setAttribute('aria-label', uiT('app.modalCancel'));
    }
  }

  let closed = false;
  const forceClose = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', modalKeyHandler, true);
    if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  };

  async function tryClose() {
    if (closed) return;
    if (beforeClose) {
      const ok = await Promise.resolve(beforeClose());
      if (ok === false) return;
    }
    forceClose();
  }

  function modalKeyHandler(e) {
    if (e.key === 'Escape') {
      void tryClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = listFocusableNodes(panel);
    if (!focusables.length) {
      e.preventDefault();
      panel?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  overlay.querySelector('.modal-close')?.addEventListener('click', () => { void tryClose(); });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) void tryClose();
  });
  document.addEventListener('keydown', modalKeyHandler, true);
  const focusables = listFocusableNodes(panel);
  if (focusables.length) {
    focusables[0].focus();
  } else {
    panel?.setAttribute('tabindex', '-1');
    panel?.focus();
  }

  return { overlay, close: tryClose, forceClose };
}

function confirmAction(message, { danger = false } = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector('.modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-panel">
      <div class="modal-header"><span id="confirm-modal-title">${escapeHtml(uiT('app.modalConfirmTitle'))}</span><button class="modal-close" aria-label="${escapeHtml(uiT('app.modalCancel'))}">&times;</button></div>
      <div class="modal-form"><p id="confirm-modal-desc" style="margin:0;font-size:14px;">${escapeHtml(message)}</p></div>
      <div class="confirm-modal-actions">
        <button class="button confirm-modal-cancel">${escapeHtml(uiT('app.modalCancel'))}</button>
        <button class="button ${danger ? 'confirm-modal-danger' : 'confirm-modal-ok'}">${escapeHtml(uiT('app.modalOk'))}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    const panel = overlay.querySelector('.modal-panel');
    panel?.setAttribute('role', 'dialog');
    panel?.setAttribute('aria-modal', 'true');
    panel?.setAttribute('aria-labelledby', 'confirm-modal-title');
    panel?.setAttribute('aria-describedby', 'confirm-modal-desc');
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let resolved = false;
    function keyHandler(e) {
      if (e.key === 'Escape') {
        close(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = listFocusableNodes(panel);
      if (!focusables.length) {
        e.preventDefault();
        panel?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    const close = (val) => {
      if (resolved) return;
      resolved = true;
      overlay.remove();
      document.removeEventListener('keydown', keyHandler, true);
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
      resolve(val);
    };
    overlay.querySelector('.confirm-modal-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.confirm-modal-ok, .confirm-modal-danger')?.addEventListener('click', () => close(true));
    overlay.querySelector('.modal-close').addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', keyHandler, true);
    const focusables = listFocusableNodes(panel);
    if (focusables.length) {
      focusables[0].focus();
    } else {
      panel?.setAttribute('tabindex', '-1');
      panel?.focus();
    }
  });
}

async function openAddToShelfPicker(bookIds) {
  const ids = [...new Set(bookIds.map(String).filter(Boolean))];
  if (!ids.length) return;

  try {
    let shelves;
    if (ids.length === 1) {
      const res = await fetch(`/api/book-shelves/${ids[0]}`, { credentials: 'same-origin' });
      if (!res.ok) {
        showToast(uiT('app.shelvesLoadFail'), 'error');
        return;
      }
      shelves = await res.json();
    } else {
      const res = await fetch('/api/shelves', { credentials: 'same-origin' });
      if (!res.ok) {
        showToast(uiT('app.shelvesLoadFail'), 'error');
        return;
      }
      const raw = await res.json();
      shelves = Array.isArray(raw) ? raw.map((s) => ({ id: s.id, name: s.name, hasBook: false })) : [];
    }

    const initialShelfState = new Map(shelves.map((s) => [String(s.id), Boolean(s.hasBook)]));
    const isMulti = ids.length > 1;
    const hint = isMulti
      ? `<p class="modal-shelf-hint muted">${uiTp('app.shelfModalMultiHint', { n: ids.length })}</p>`
      : `<p class="modal-shelf-hint muted">${escapeHtml(uiT('app.shelfModalHint'))}</p>`;

    const { overlay, close, forceClose } = openModal(
      `
          <div class="modal-header">
            <span>${escapeHtml(uiT('app.shelfModalTitle'))}</span>
            <button type="button" class="modal-close">&times;</button>
          </div>
          ${hint}
          <div class="modal-list">
            ${shelves.length ? shelves.map((s) => `
              <label class="modal-list-item">
                <input type="checkbox" id="shelf-toggle-${safeDomIdPart(s.id)}" name="shelfToggle_${safeDomIdPart(s.id)}" value="${escapeHtml(String(s.id))}" data-shelf-toggle="${s.id}" ${s.hasBook ? 'checked' : ''}>
                <span>${escapeHtml(s.name)}</span>
              </label>
            `).join('') : `<div class="modal-list-empty">${escapeHtml(uiT('app.shelfModalEmpty'))}</div>`}
          </div>
          <form class="modal-inline-form" data-shelf-create-inline>
            <input type="text" id="modal-new-shelf-name" name="newShelfName" placeholder="${escapeHtml(uiT('app.shelfNewPlaceholder'))}" autocomplete="off" required>
            <button type="submit">${escapeHtml(isMulti ? uiT('app.shelfCreateAndAddMulti') : uiT('app.shelfCreateAndAdd'))}</button>
          </form>
          <div class="modal-shelf-footer">
            <button type="button" class="button modal-shelf-cancel">${escapeHtml(uiT('app.modalCancel'))}</button>
            <button type="button" class="button modal-shelf-done">${escapeHtml(uiT('app.shelfModalDone'))}</button>
          </div>
        `,
      {
        beforeClose: () => {
          const root = document.querySelector('.modal-overlay');
          if (!root) return true;
          const dirty = [...root.querySelectorAll('[data-shelf-toggle]')].some((cb) => {
            const id = String(cb.dataset.shelfToggle);
            return cb.checked !== (initialShelfState.get(id) ?? false);
          });
          if (!dirty) return true;
          return window.confirm(uiT('app.closeWithoutSave'));
        }
      }
    );

    async function applyShelfPickerSelections() {
      if (isMulti) {
        const shelfIds = [...overlay.querySelectorAll('[data-shelf-toggle]:checked')].map((cb) => Number(cb.dataset.shelfToggle));
        if (!shelfIds.length) return true;
        try {
          const r = await fetch('/api/shelves/batch-add-books', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ shelfIds, bookIds: ids })
          });
          if (await handleAuthRequired(r)) return false;
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            showToast(d.error || uiT('app.saveFailed'), 'error');
            return false;
          }
          const data = await r.json().catch(() => ({}));
          showToast(typeof data.added === 'number' && data.added > 0 ? uiTp('app.addedCount', { n: data.added }) : uiT('app.noChanges'), 'success');
          return true;
        } catch {
          showToast(uiT('app.networkError'), 'error');
          return false;
        }
      }

      const bookId = ids[0];
      const ops = [];
      for (const cb of overlay.querySelectorAll('[data-shelf-toggle]')) {
        const shelfId = cb.dataset.shelfToggle;
        const want = cb.checked;
        const was = initialShelfState.get(String(shelfId)) ?? false;
        if (want === was) continue;
        if (want) {
          ops.push(
            fetch(`/api/shelves/${encodeURIComponent(shelfId)}/books`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ bookId })
            }).then(async (r) => {
              if (await handleAuthRequired(r)) return;
              if (!r.ok) throw new Error('save');
            })
          );
        } else {
          ops.push(
            fetch(`/api/shelves/${encodeURIComponent(shelfId)}/books/${encodeURIComponent(bookId)}`, { method: 'DELETE', credentials: 'same-origin' }).then(async (r) => {
              if (await handleAuthRequired(r)) return;
              if (!r.ok) throw new Error('save');
            })
          );
        }
      }
      if (!ops.length) return true;
      try {
        await Promise.all(ops);
        showToast(uiT('app.shelvesUpdated'), 'success');
        return true;
      } catch {
        showToast(uiT('app.saveFailed'), 'error');
        return false;
      }
    }

    overlay.querySelector('.modal-shelf-done').addEventListener('click', async () => {
      const ok = await applyShelfPickerSelections();
      if (ok) forceClose();
    });

    overlay.querySelector('.modal-shelf-cancel').addEventListener('click', () => {
      void close();
    });

    overlay.querySelector('[data-shelf-create-inline]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = e.target.querySelector('input');
      const name = (input?.value || '').trim();
      if (!name) return;
      const doneBtn = overlay.querySelector('.modal-shelf-done');
      const subBtn = e.target.querySelector('button[type="submit"]');
      doneBtn.disabled = true;
      subBtn.disabled = true;
      try {
        if (!(await applyShelfPickerSelections())) {
          doneBtn.disabled = false;
          subBtn.disabled = false;
          return;
        }
        const createRes = await fetch('/api/shelves', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name })
        });
        if (!createRes.ok) {
          const d = await createRes.json().catch(() => ({}));
          showToast(d.error || uiT('app.errorShort'), 'error');
          doneBtn.disabled = false;
          subBtn.disabled = false;
          return;
        }
        const data = await createRes.json();
        const addRes = isMulti
          ? await fetch('/api/shelves/batch-add-books', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ shelfIds: [data.id], bookIds: ids })
            })
          : await fetch(`/api/shelves/${data.id}/books`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ bookId: ids[0] })
            });
        if (!addRes.ok) {
          showToast(isMulti ? uiT('app.shelfCreatedAddBooksFail') : uiT('app.shelfCreatedAddBookFail'), 'error');
          forceClose();
          return;
        }
        if (isMulti) {
          const ad = await addRes.json().catch(() => ({}));
          showToast(uiTp('app.shelfAddedBooks', { name, n: ad.added ?? 0 }), 'success');
        } else {
          showToast(uiTp('app.shelfAddedBook', { name }), 'success');
        }
        forceClose();
      } catch {
        showToast(uiT('app.networkError'), 'error');
        doneBtn.disabled = false;
        subBtn.disabled = false;
      }
    });
  } catch {
    showToast(uiT('app.networkError'), 'error');
  }
}

function attachAddToShelfButtons() {
  for (const btn of document.querySelectorAll('[data-add-to-shelf]')) {
    btn.addEventListener('click', async () => {
      const bookId = btn.dataset.addToShelf;
      if (!bookId) return;
      await openAddToShelfPicker([bookId]);
    });
  }
}

function attachSendToEreader() {
  for (const btn of document.querySelectorAll('[data-send-to-ereader]')) {
    btn.addEventListener('click', async () => {
      const bookId = btn.dataset.sendToEreader;
      try {
        const emailRes = await fetch('/api/ereader-email', { credentials: 'same-origin' });
        if (!emailRes.ok) throw new Error('HTTP ' + emailRes.status);
        const emailData = await emailRes.json();
        const ereaderEmail = emailData.email || '';

        if (!ereaderEmail) {
          openModal(`
            <div class="modal-header">
              <span>${escapeHtml(uiT('app.emailSendTitle'))}</span>
              <button type="button" class="modal-close">&times;</button>
            </div>
            <div class="modal-form">
              <p>${escapeHtml(uiT('app.emailNotConfigured'))}</p>
              <p style="margin-top:8px;"><a href="/profile#settings" style="color:var(--accent);">${escapeHtml(uiT('app.emailProfileHint'))}</a>${escapeHtml(uiT('app.emailProfileHintSuffix'))}</p>
            </div>
          `);
          return;
        }

        const { overlay, forceClose } = openModal(`
          <div class="modal-header">
            <span>${escapeHtml(uiT('app.emailSendTitle'))}</span>
            <button type="button" class="modal-close">&times;</button>
          </div>
          <form class="modal-form" data-ereader-form>
            <div>
              <div class="modal-form-hint" style="margin-bottom:8px;">${escapeHtml(uiT('app.emailSendTo'))} <strong>${escapeHtml(ereaderEmail)}</strong></div>
            </div>
            <div>
              <label>${escapeHtml(uiT('app.emailBookFormat'))}</label>
              <select name="format">
                <option value="epub2">EPUB</option>
                <option value="epub3">EPUB3</option>
                <option value="kepub">KEPUB (Kobo)</option>
                <option value="kfx">KFX (Kindle)</option>
                <option value="azw8">AZW8 (Kindle)</option>
                <option value="fb2">FB2</option>
              </select>
            </div>
            <button type="submit" class="modal-form-submit">${escapeHtml(uiT('app.emailSendBtn'))}</button>
          </form>
        `);

        overlay.querySelector('[data-ereader-form]').addEventListener('submit', async (e) => {
          e.preventDefault();
          const format = overlay.querySelector('select[name="format"]').value;
          const submitBtn = overlay.querySelector('.modal-form-submit');
          submitBtn.disabled = true;
          submitBtn.textContent = uiT('app.emailSending');
          try {
            const res = await fetch(`/api/send-to-ereader/${encodeURIComponent(bookId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ format }) });
            const data = await res.json();
            if (res.ok) {
              showToast(data.message || uiT('app.emailSent'), 'success');
              forceClose();
            } else {
              showToast(data.error || uiT('app.emailSendError'), 'error');
              submitBtn.disabled = false;
              submitBtn.textContent = uiT('app.emailSendBtn');
            }
          } catch {
            showToast(uiT('app.networkError'), 'error');
            submitBtn.disabled = false;
            submitBtn.textContent = uiT('app.emailSendBtn');
          }
        });
      } catch { showToast(uiT('app.networkError'), 'error'); }
    });
  }
}

function attachSendBatchToEreader() {
  if (attachSendBatchToEreader._bound) return;
  attachSendBatchToEreader._bound = true;

  document.addEventListener('click', async (e) => {
    const fmtBtn = e.target.closest('[data-batch-email-format]');
    if (!fmtBtn) return;
    const menu = fmtBtn.closest('details.batch-email-menu');
    if (!menu) return;

    const format = fmtBtn.getAttribute('data-batch-email-format') || 'epub2';
    e.preventDefault();

    const scope = menu.closest('.batch-select-scope');
    if (!scope) return;

    let ctx;
    try {
      ctx = JSON.parse(menu.dataset.batchEreaderParams || '{}');
    } catch {
      return;
    }

    const ids = [...scope.querySelectorAll('input.batch-select-cb')]
      .filter((c) => c.checked)
      .map((c) => c.getAttribute('data-batch-book-id') || c.closest('.card')?.dataset.bookId)
      .filter(Boolean);
    if (!ids.length) {
      showToast(uiT('app.batchSelectAtLeastOne'), 'error');
      return;
    }
    if (ids.length > BATCH_DOWNLOAD_MAX) {
      showToast(uiTp('app.batchEmailMax', { n: BATCH_DOWNLOAD_MAX }), 'error');
      return;
    }

    const body = { format, ids };
    if (ctx.shelf != null && Number(ctx.shelf) > 0) {
      body.shelf = Number(ctx.shelf);
    } else if (ctx.adhoc !== true) {
      body.facet = ctx.facet;
      body.value = ctx.value;
    }

    try {
      const emailRes = await fetch('/api/ereader-email', { credentials: 'same-origin' });
      if (!emailRes.ok) throw new Error('HTTP ' + emailRes.status);
      const emailData = await emailRes.json();
      const ereaderEmail = emailData.email || '';

      if (!ereaderEmail) {
        openModal(`
          <div class="modal-header">
            <span>${escapeHtml(uiT('email.toEreader'))}</span>
            <button type="button" class="modal-close">&times;</button>
          </div>
          <div class="modal-form">
            <p>${escapeHtml(uiT('app.emailNotConfigured'))}</p>
            <p style="margin-top:8px;"><a href="/profile#settings" style="color:var(--accent);">${escapeHtml(uiT('app.emailProfileHint'))}</a>${escapeHtml(uiT('app.emailProfileHintSuffix'))}</p>
          </div>
        `);
        return;
      }

      fmtBtn.disabled = true;
      showToast(uiT('app.emailBatchWait'), 'info');
      menu.removeAttribute('open');

      try {
        const res = await fetch('/api/send-to-ereader/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          let msg = data.message || uiT('app.emailSent');
          if (data.partial && data.skipped > 0) {
            msg += ' ' + uiTp('app.emailPartialSkipped', { skipped: data.skipped, requested: data.requested });
          }
          showToast(msg, 'success');
        } else {
          showToast(data.error || uiT('app.emailSendError'), 'error');
        }
      } catch {
        showToast(uiT('app.networkError'), 'error');
      } finally {
        fmtBtn.disabled = false;
      }
    } catch {
      showToast(uiT('app.networkError'), 'error');
    }
  });
}

function attachUpdateUpload() {
  const fileInput = document.getElementById('update-zip-input');
  const nameSpan = document.getElementById('update-zip-name');
  const startBtn = document.getElementById('update-start-btn');
  const progressWrap = document.getElementById('update-progress');
  const progressBar = document.getElementById('update-progress-bar');
  const logPre = document.getElementById('update-log');

  if (!fileInput || !startBtn) return;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) {
      if (nameSpan) nameSpan.textContent = file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' ' + uiT('app.unitMb') + ')';
      startBtn.disabled = false;
    } else {
      if (nameSpan) nameSpan.textContent = '';
      startBtn.disabled = true;
    }
  });

  startBtn.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!await confirmAction(uiTp('app.backupConfirm', { name: file.name }))) return;

    startBtn.disabled = true;
    fileInput.disabled = true;
    startBtn.textContent = uiT('app.backupUploading');
    if (progressWrap) progressWrap.style.display = 'block';
    if (progressBar) progressBar.style.width = '0%';
    if (logPre) {
      logPre.textContent = uiT('app.backupUploadLog1');
    }

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/operations/update', true);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      const csrf = getCsrfTokenFromPage();
      if (csrf) {
        xhr.setRequestHeader('X-CSRF-Token', csrf);
      }

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 40);
          if (progressBar) progressBar.style.width = pct + '%';
          const up = Math.round((e.loaded / e.total) * 100);
          if (logPre) {
            logPre.textContent = uiTp('app.backupUploadLogPct', { p: up });
          }
        }
      });

      xhr.onload = () => {
        if (progressBar) progressBar.style.width = '40%';
        if (xhr.status < 200 || xhr.status >= 300) {
          let errMsg = uiT('app.backupStartFail');
          try {
            const j = JSON.parse(xhr.responseText || '{}');
            if (j.error) errMsg = j.error;
          } catch { /* ignore */ }
          if (logPre) logPre.textContent += `❌ ${errMsg} (HTTP ${xhr.status})\n`;
          startBtn.textContent = uiT('app.error');
          setTimeout(() => {
            startBtn.disabled = false;
            fileInput.disabled = false;
            startBtn.textContent = uiT('app.backupBtnUpdate');
          }, 3000);
          return;
        }
        startBtn.textContent = uiT('app.backupBtnUpdating');
        pollUpdateLog();
      };

      xhr.onerror = () => {
        if (logPre) logPre.textContent += uiT('app.backupNetworkErrLog');
        startBtn.textContent = uiT('app.error');
        setTimeout(() => {
          startBtn.disabled = false;
          fileInput.disabled = false;
          startBtn.textContent = uiT('app.backupBtnUpdate');
        }, 3000);
      };

      xhr.send(file);
    } catch (error) {
      if (logPre) logPre.textContent += '❌ ' + error.message + '\n';
      startBtn.disabled = false;
      fileInput.disabled = false;
      startBtn.textContent = uiT('app.backupBtnUpdate');
    }
  });

  async function pollUpdateLog() {
    let finished = false;
    for (let i = 0; i < 120; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 800));
      try {
        const r = await fetch('/api/operations/update-log', { credentials: 'same-origin' });
        if (!r.ok) continue;
        const data = await r.json();
        if (logPre) {
          logPre.textContent = data.log || '';
          logPre.scrollTop = logPre.scrollHeight;
        }

        const lines = (data.log || '').split('\n').filter(Boolean);
        const totalSteps = 6;
        const doneSteps = lines.filter((l) => l.startsWith('✅') || l.startsWith('🎉')).length;
        if (progressBar) progressBar.style.width = Math.min(40 + Math.round((doneSteps / totalSteps) * 60), 100) + '%';

        if (data.log && (data.log.includes('[update:done] restart') || data.log.includes('[update:done] error'))) {
          finished = true;
          break;
        }
      } catch {
        // server may be restarting
      }
    }

    if (finished && logPre && logPre.textContent.includes('[update:done] restart')) {
      if (progressBar) progressBar.style.width = '100%';
      startBtn.textContent = uiT('app.restarting');
      showToast(uiT('app.backupDoneRestart'), 'success');
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const r = await fetch('/api/operations', { credentials: 'same-origin' });
          if (r.ok) { window.location.reload(); return; }
        } catch {}
      }
      window.location.reload();
    } else if (finished) {
      startBtn.textContent = uiT('app.error');
      showToast(uiT('app.backupDoneError'), 'error');
      setTimeout(() => {
        startBtn.disabled = false;
        fileInput.disabled = false;
        startBtn.textContent = uiT('app.backupBtnUpdate');
      }, 3000);
    } else {
      startBtn.textContent = uiT('app.restarting');
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const r = await fetch('/api/operations', { credentials: 'same-origin' });
          if (r.ok) { window.location.reload(); return; }
        } catch {}
      }
      window.location.reload();
    }
  }
}

function attachProfileRemoveActions() {
  for (const btn of document.querySelectorAll('[data-remove-reading]')) {
    btn.addEventListener('click', async () => {
      const bookId = btn.dataset.removeReading;
      const row = btn.closest('.profile-list-item');
      const title = (row?.querySelector('a')?.textContent || '').trim();
      const msg = title ? uiTp('app.removeReadingConfirm', { title }) : uiT('app.removeReadingConfirmShort');
      if (!await confirmAction(msg, { danger: true })) return;

      const lastOpenedAt = row?.dataset.readingLastOpened || '';
      const openCount = Math.max(1, Number(row?.dataset.readingOpenCount) || 1);

      try {
        const r = await fetch(`/api/reading-history/${encodeURIComponent(bookId)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (await handleAuthRequired(r)) return;
        if (!r.ok) {
          showToast(uiT('app.removeReadingFail'), 'error');
          return;
        }
        if (!row) return;
        row.style.display = 'none';
        bumpProfileReadingTotal(-1);
        const removeTimer = window.setTimeout(() => {
          if (row.style.display === 'none') row.remove();
        }, 5500);
        showToast(uiT('app.removedFromReading'), 'success', {
          actionLabel: uiT('app.undo'),
          duration: 5000,
          onAction: () => {
            window.clearTimeout(removeTimer);
            void (async () => {
              try {
                const restore = await fetch(`/api/reading-history/${encodeURIComponent(bookId)}`, {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ lastOpenedAt, openCount })
                });
                if (await handleAuthRequired(restore)) return;
                if (!restore.ok) {
                  showToast(uiT('app.restoreReadingFail'), 'error');
                  return;
                }
                row.style.display = '';
                bumpProfileReadingTotal(1);
              } catch {
                showToast(uiT('app.networkError'), 'error');
              }
            })();
          }
        });
      } catch {
        showToast(uiT('app.networkError'), 'error');
      }
    });
  }
  for (const btn of document.querySelectorAll('[data-remove-bookmark]')) {
    btn.addEventListener('click', async () => {
      const bmId = btn.dataset.removeBookmark;
      const row = btn.closest('.profile-list-item');
      const bookId = row?.dataset.readerBmBookId;
      const position = row?.dataset.readerBmPosition ?? '';
      const bmTitle = row?.dataset.readerBmTitle ?? '';
      const link = row?.querySelector('a');
      const labelText = (link?.textContent || '').trim();
      const msg = labelText ? uiTp('app.deleteReaderBmConfirm', { label: labelText }) : uiT('app.deleteReaderBmConfirmShort');
      if (!await confirmAction(msg, { danger: true })) return;

      if (!bookId) {
        showToast(uiT('app.readerBmBookUnknown'), 'error');
        return;
      }

      try {
        const r = await fetch(`/api/reader-bookmarks/${encodeURIComponent(bmId)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (await handleAuthRequired(r)) return;
        if (!r.ok) {
          showToast(uiT('app.readerBmDeleteFail'), 'error');
          return;
        }
        if (!row) return;
        row.style.display = 'none';
        bumpProfileReaderBmTotal(-1);
        const removeTimer = window.setTimeout(() => {
          if (row.style.display === 'none') row.remove();
        }, 5500);
        showToast(uiT('app.readerBmDeleted'), 'success', {
          actionLabel: uiT('app.undo'),
          duration: 5000,
          onAction: () => {
            window.clearTimeout(removeTimer);
            void (async () => {
              try {
                const restore = await fetch(`/api/books/${encodeURIComponent(bookId)}/bookmarks`, {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ position, title: bmTitle })
                });
                if (await handleAuthRequired(restore)) return;
                if (!restore.ok) {
                  showToast(uiT('app.readerBmRestoreFail'), 'error');
                  return;
                }
                const payload = await restore.json();
                const newId = payload.id;
                if (newId != null) {
                  row.dataset.profileBookmark = String(newId);
                  btn.dataset.removeBookmark = String(newId);
                }
                row.style.display = '';
                bumpProfileReaderBmTotal(1);
              } catch {
                showToast(uiT('app.networkError'), 'error');
              }
            })();
          }
        });
      } catch {
        showToast(uiT('app.networkError'), 'error');
      }
    });
  }
}

function attachAdminRecaptchaDisclosure() {
  const details = document.querySelector('.admin-recaptcha-disclosure');
  if (!details) return;
  const form = details.querySelector('form[action="/admin/settings/recaptcha"]');

  function collapseRecaptchaDisclosure() {
    details.open = false;
    details.removeAttribute('open');
    const active = document.activeElement;
    if (active && details.contains(active) && typeof active.blur === 'function') {
      active.blur();
    }
  }

  function stripRecaptchaSavedFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('recaptcha') !== 'saved') return;
      params.delete('recaptcha');
      const q = params.toString();
      const path = `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`;
      window.history.replaceState(null, '', path);
    } catch { /* ignore */ }
  }

  function applySavedRecaptchaState() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('recaptcha') !== 'saved') return;
      collapseRecaptchaDisclosure();
      stripRecaptchaSavedFromUrl();
      requestAnimationFrame(() => {
        collapseRecaptchaDisclosure();
      });
    } catch { /* ignore */ }
  }

  applySavedRecaptchaState();
  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) applySavedRecaptchaState();
  });

  if (form) {
    form.addEventListener('submit', () => {
      collapseRecaptchaDisclosure();
    });
  }

  document.addEventListener('click', (e) => {
    if (!details.open) return;
    const t = e.target;
    if (t instanceof Node && details.contains(t)) return;
    collapseRecaptchaDisclosure();
  });
}

function attachSourcesReindex() {
  const buttons = document.querySelectorAll('[data-reindex-btn]');
  if (!buttons.length) return;
  const controlsRoot = document.querySelector('[data-admin-index-controls]');
  if (controlsRoot) {
    const currentController = String(controlsRoot.dataset.progressController || '');
    if (currentController && currentController !== 'sources-reindex') return;
    controlsRoot.dataset.progressController = 'sources-reindex';
  }

  const progress = document.getElementById('sources-index-progress');
  const progressText = document.getElementById('sources-progress-text');
  const progressArchive = document.getElementById('sources-progress-archive');
  const progressBar = document.getElementById('sources-progress-bar');
  const progressTime = document.getElementById('sources-progress-time');
  const pauseToggleButtons = [...document.querySelectorAll('[data-operation-action="reindex-toggle-pause"]')];
  const stopButtons = [...document.querySelectorAll('[data-operation-action="reindex-stop"]')];
  let polling = false;

  function showProgress(text, percent, archiveText = '', timeText = '') {
    if (progress) progress.style.display = '';
    if (progressText) progressText.innerHTML = text;
    if (progressArchive) progressArchive.textContent = archiveText ? String(archiveText) : '';
    if (progressBar) progressBar.style.width = Math.min(100, Math.max(0, percent)) + '%';
    if (progressTime) progressTime.textContent = timeText;
  }

  function hideProgress() {
    if (progress) progress.style.display = 'none';
  }

  function setButtonsDisabled(disabled) {
    buttons.forEach((b) => { b.disabled = disabled; });
  }

  function syncIndexControlButtons(status) {
    if (!pauseToggleButtons.length && !stopButtons.length) return;
    const active = Boolean(status?.active);
    const paused = Boolean(status?.pauseRequested || status?.paused);
    for (const btn of pauseToggleButtons) {
      btn.disabled = !active;
      btn.dataset.reindexPaused = paused ? '1' : '0';
      btn.dataset.operationLabel = paused ? uiT('app.adminIndexResumeLabel') : uiT('app.adminIndexPauseLabel');
      btn.textContent = paused ? uiT('app.adminIndexResume') : uiT('app.adminIndexPause');
    }
    for (const btn of stopButtons) {
      btn.disabled = !active;
    }
  }

  async function refreshSourcesTable() {
    try {
      const res = await fetch('/api/sources', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const loc = getUiLocale() === 'en' ? 'en-US' : 'ru-RU';
      const { sources } = await res.json();
      for (const s of sources) {
        const row = document.querySelector(`tr[data-source-id="${s.id}"]`);
        if (!row) continue;
        const booksCell = row.querySelector('[data-source-books]');
        if (booksCell) booksCell.textContent = Number(s.bookCount || 0).toLocaleString(loc);
        const indexedCell = row.querySelector('[data-source-indexed]');
        if (indexedCell) {
          if (s.lastIndexedAt) {
            try { indexedCell.textContent = new Date(s.lastIndexedAt).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
            catch { indexedCell.textContent = s.lastIndexedAt; }
          } else {
            indexedCell.textContent = '\u2014';
          }
        }
      }
    } catch {}
  }

  async function pollProgress() {
    if (polling) return;
    polling = true;
    setButtonsDisabled(true);

    const POLL_MS = 1500;
    const MAX_CONSECUTIVE_POLL_FAILS = 20;
    let consecutiveFails = 0;
    let stoppedWhileActiveUnknown = false;

    while (true) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      try {
        const res = await fetch('/api/index-status', { credentials: 'same-origin' });
        if (!res.ok) {
          consecutiveFails += 1;
          if (consecutiveFails >= MAX_CONSECUTIVE_POLL_FAILS) {
            stoppedWhileActiveUnknown = true;
            break;
          }
          continue;
        }
        const status = await res.json();
        consecutiveFails = 0;
        syncIndexControlButtons(status);
        if (status.active) {
          const percent = status.totalArchives ? Math.min(100, Math.round((status.processedArchives / status.totalArchives) * 100)) : 0;
          const imported = Math.max(0, Math.floor(Number(status.importedBooks) || 0));
          const label = status.currentArchive ? escapeHtml(status.currentArchive) : '';
          const { elapsed, eta } = computeIndexTimeInfo(status.startedAt, status.processedArchives || 0, status.totalArchives || 0);
          const timeParts = [];
          if (elapsed) timeParts.push(uiTp('app.indexElapsed', { time: elapsed }));
          if (eta) timeParts.push(uiTp('app.indexEta', { time: eta }));
          showProgress(
            `${escapeHtml(uiT('app.adminIndexingLabel'))} <strong>${percent}%</strong>` +
            `<span class="muted" style="margin-left:12px">${escapeHtml(uiTp('app.adminIndexFilesLine', { processed: status.processedArchives || 0, total: status.totalArchives || 0, imported }))}</span>`,
            percent,
            label,
            timeParts.join('  \u00b7  ')
          );
        } else {
          break;
        }
      } catch {
        consecutiveFails += 1;
        if (consecutiveFails >= MAX_CONSECUTIVE_POLL_FAILS) {
          stoppedWhileActiveUnknown = true;
          break;
        }
      }
    }

    try {
      const finalRes = await fetch('/api/index-status', { credentials: 'same-origin' });
      const finalStatus = finalRes.ok ? await finalRes.json() : null;
      syncIndexControlButtons(finalStatus || { active: false, paused: false, pauseRequested: false });
      if (stoppedWhileActiveUnknown) {
        showProgress(`<span style="color:var(--danger)">${escapeHtml(uiT('app.adminIndexPollLost'))}</span>`, 100);
        if (progressBar) progressBar.style.background = 'var(--danger, #f43f5e)';
        showToast(uiT('app.adminIndexPollLost'), 'error');
      } else if (finalStatus?.error) {
        showProgress(`<span style="color:var(--danger)">${escapeHtml(uiT('app.errorPrefix'))} ${escapeHtml(finalStatus.error)}</span>`, 100);
        if (progressBar) progressBar.style.background = 'var(--danger, #f43f5e)';
      } else {
        const startAttr = progressTime?.dataset?.indexStarted || '';
        const { elapsed: totalElapsed } = computeIndexTimeInfo(startAttr || finalStatus?.startedAt, 1, 1);
        const doneTime = totalElapsed ? uiTp('app.indexElapsedDone', { time: totalElapsed }) : '';
        showProgress(escapeHtml(uiT('app.adminIndexingComplete')), 100, '', doneTime);
      }
    } catch {
      if (stoppedWhileActiveUnknown) {
        showProgress(`<span style="color:var(--danger)">${escapeHtml(uiT('app.adminIndexPollLost'))}</span>`, 100);
        if (progressBar) progressBar.style.background = 'var(--danger, #f43f5e)';
      } else {
        showProgress(escapeHtml(uiT('app.adminIndexingComplete')), 100);
      }
    }
    await refreshSourcesTable();
    setButtonsDisabled(false);
    polling = false;
    if (progressBar) progressBar.style.background = '';
    setTimeout(hideProgress, 4000);
  }

  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      const sourceId = btn.dataset.sourceId;
      const mode = btn.dataset.mode || 'incremental';
      if (mode === 'full' && !(await confirmAction(uiT('app.confirmSourceFullReindex'), { danger: true }))) return;

      btn.disabled = true;
      try {
        const res = await fetch(`/admin/sources/${sourceId}/reindex`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ mode })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data.ok) {
          showToast(data.error || uiT('app.adminIndexStartError'), 'error');
          btn.disabled = false;
          return;
        }
        showProgress(escapeHtml(uiT('app.adminIndexLaunching')), 0);
        pollProgress();
      } catch (err) {
        showToast(uiT('app.errorPrefix') + ' ' + err.message, 'error');
        btn.disabled = false;
      }
    });
  }

  // If page loads while indexing is active, start polling immediately
  fetch('/api/index-status', { credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((status) => {
      syncIndexControlButtons(status);
      if (status.active) { showProgress(escapeHtml(uiT('app.adminIndexingEllipsis')), 0); pollProgress(); }
    })
    .catch(() => {});
}

function attachSourceDelete() {
  const buttons = document.querySelectorAll('[data-delete-source]');

  const stageLabels = {
    prepare: uiT('app.adminDeleteStagePrepare') || 'Подготовка…',
    cleanup: uiT('app.adminDeleteStageCleanup') || 'Очистка связей…',
    books: uiT('app.adminDeleteStageBooks') || 'Удаление книг…',
    catalogs: uiT('app.adminDeleteStageCatalogs') || 'Очистка каталогов…',
    fts: uiT('app.adminDeleteStageFts') || 'Перестроение поиска…',
    vacuum: uiT('app.adminDeleteStageVacuum') || 'Сжатие базы…',
    done: uiT('app.adminDeleteStageDone') || 'Готово'
  };

  // Reuse the same progress banner as indexing
  const banner = document.getElementById('sources-index-progress');
  const bannerText = document.getElementById('sources-progress-text');
  const bannerArchive = document.getElementById('sources-progress-archive');
  const bannerBar = document.getElementById('sources-progress-bar');
  const bannerTime = document.getElementById('sources-progress-time');

  function showDeleteProgress(label, percent, detail) {
    if (banner) {
      banner.style.display = '';
      // Hide indexing-specific buttons during deletion
      for (const b of banner.querySelectorAll('[data-operation-action]')) b.style.display = 'none';
    }
    if (bannerText) bannerText.innerHTML = label;
    if (bannerBar) {
      bannerBar.style.width = Math.min(100, Math.max(0, percent)) + '%';
      bannerBar.style.background = 'var(--accent)';
    }
    if (bannerArchive) bannerArchive.textContent = detail || '';
    if (bannerTime) bannerTime.textContent = '';
  }

  function hideDeleteProgress() {
    if (banner) {
      setTimeout(() => { banner.style.display = 'none'; }, 3000);
      // Restore indexing-specific buttons
      for (const b of banner.querySelectorAll('[data-operation-action]')) b.style.display = '';
    }
  }

  /** Poll deletion progress and update banner until done. */
  async function pollDeleteProgress() {
    for (;;) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const r = await fetch('/api/admin/sources/delete-progress', { credentials: 'same-origin' });
        const p = await r.json();
        const stage = stageLabels[p.stage] || p.stage;
        let percent = 0;
        let detail = '';
        if (p.stage === 'fts' && p.ftsTotal > 0) {
          percent = Math.round(p.ftsDone / p.ftsTotal * 100);
          detail = `${stage} ${p.ftsDone.toLocaleString()} / ${p.ftsTotal.toLocaleString()}`;
        } else if (p.stage === 'books' && p.total > 0) {
          percent = Math.round(p.deleted / p.total * 100);
          detail = `${stage} ${p.deleted.toLocaleString()} / ${p.total.toLocaleString()}`;
        } else {
          detail = stage;
        }
        const label = `${escapeHtml(uiT('app.adminDeletingSource') || 'Удаление источника')} <strong>${percent}%</strong>`;
        showDeleteProgress(label, percent, detail);
        if (!p.running) break;
      } catch { break; }
    }
    showDeleteProgress(
      escapeHtml(uiT('app.adminSourceDeleted') || 'Источник удалён'), 100, ''
    );
    showToast(uiT('app.adminSourceDeleted') || 'Источник удалён', 'success');
    hideDeleteProgress();
    window.location.reload();
  }

  // On page load: check if a deletion is already running and resume progress display.
  if (banner) {
    fetch('/api/admin/sources/delete-progress', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(p => {
        if (p.running) {
          // Disable all delete buttons while deletion is in progress
          for (const b of buttons) {
            b.disabled = true;
            b.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || 'Выполняется…');
          }
          showDeleteProgress(escapeHtml(uiT('app.adminDeletingSource') || 'Удаление источника') + ' <strong>…</strong>', 0, p.sourceName || '');
          pollDeleteProgress();
        }
      })
      .catch(() => {});
  }

  if (!buttons.length) return;

  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      const sourceId = btn.dataset.deleteSource;
      const sourceName = btn.dataset.sourceName || '';
      const confirmMsg = uiTp('app.adminDeleteSourceConfirm', { name: sourceName });
      if (!(await confirmAction(confirmMsg, { danger: true }))) return;

      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || 'Выполняется…');
      showDeleteProgress(escapeHtml(stageLabels.prepare), 0, sourceName);

      try {
        const csrf = getCsrfTokenFromPage();
        const headers = { 'Content-Type': 'application/json' };
        if (csrf) headers['X-CSRF-Token'] = csrf;
        const resp = await fetch(`/api/admin/sources/${sourceId}/delete`, {
          method: 'POST', credentials: 'same-origin', headers
        });
        const data = await resp.json().catch(() => ({}));
        if (!data.ok) {
          showToast(data.error || 'Error', 'error');
          window.location.reload();
          return;
        }

        await pollDeleteProgress();
      } catch (err) {
        showToast(err.message || 'Error', 'error');
        window.location.reload();
      }
    });
  }
}
function attachAddSourceForm() {
  const form = document.getElementById('add-source-form');
  if (!form) return;

  const nameInput = form.querySelector('#source-name');
  const pathInput = form.querySelector('#source-path');
  const submitBtn = form.querySelector('#add-source-btn');

  async function addSource(name, type, sourcePath) {
    const res = await fetch('/admin/sources/add', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ name, type, path: sourcePath })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const sourcePath = pathInput.value.trim();
    if (!name || !sourcePath) return;

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.adminProbeRunning'));

    try {
      if (sourcePath.toLowerCase().endsWith('.inpx')) {
        const result = await addSource(name, 'inpx', sourcePath);
        if (result.ok) { window.location.reload(); return; }
        showToast(result.error || uiT('app.adminAddFail'), 'error');
        return;
      }

      const probe = await fetch('/api/sources/probe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ path: sourcePath })
      }).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });

      if (!probe.ok || !probe.exists) {
        showToast(probe.error || uiT('app.adminPathMissing'), 'error');
        return;
      }

      if (probe.isFile && probe.isInpx) {
        const result = await addSource(name, 'inpx', sourcePath);
        if (result.ok) { window.location.reload(); return; }
        showToast(result.error || uiT('app.adminAddFail'), 'error');
        return;
      }

      if (probe.inpxFiles && probe.inpxFiles.length > 0) {
        showInpxChoiceModal(name, sourcePath, probe.inpxFiles);
        return;
      }

      const result = await addSource(name, 'folder', sourcePath);
      if (result.ok) { window.location.reload(); return; }
      showToast(result.error || uiT('app.adminAddFail'), 'error');
    } catch (err) {
      showToast(uiT('app.errorPrefix') + ' ' + err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = escapeHtml(uiT('app.adminAddBtn'));
    }
  });

  function showInpxChoiceModal(name, folderPath, inpxFiles) {
    const inpxList = inpxFiles.map((f) => {
      const base = f.split(/[/\\]/).pop();
      return `<li style="margin:4px 0"><code style="font-size:.9em">${escapeHtml(base)}</code></li>`;
    }).join('');

    const html = `
      <button class="modal-close" aria-label="${escapeHtml(uiT('reader.close'))}">&times;</button>
      <div style="padding:4px 0">
        <h3 style="margin:0 0 12px">${escapeHtml(uiT('app.adminInpxFoundTitle'))}</h3>
        <p style="margin:0 0 8px;color:var(--text-secondary)">
          ${escapeHtml(uiT('app.adminInpxFoundIntro'))}
        </p>
        <ul style="margin:0 0 16px;padding-left:20px">${inpxList}</ul>
        <p style="margin:0 0 16px;color:var(--text-secondary);font-size:.95em">
          ${escapeHtml(uiT('app.adminInpxChooseMethod'))}
        </p>
        <div style="display:flex;flex-direction:column;gap:12px">
          <button type="button" data-choice="inpx" style="text-align:left;padding:12px 16px">
            <strong>${escapeHtml(uiT('app.adminInpxChoiceInpxTitle'))}</strong>
            <div class="muted" style="font-size:.85em;margin-top:4px">
              ${escapeHtml(uiT('app.adminInpxChoiceInpxText'))}
            </div>
          </button>
          <button type="button" data-choice="folder" style="text-align:left;padding:12px 16px">
            <strong>${escapeHtml(uiT('app.adminInpxChoiceFolderTitle'))}</strong>
            <div class="muted" style="font-size:.85em;margin-top:4px">
              ${escapeHtml(uiT('app.adminInpxChoiceFolderText'))}
            </div>
          </button>
        </div>
      </div>
    `;

    const modal = openModal(html);
    const panel = modal.overlay.querySelector('.modal-panel');

    panel.querySelector('[data-choice="inpx"]').addEventListener('click', async () => {
      modal.forceClose();
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.adminAddingSource'));
      try {
        const result = await addSource(name, 'inpx', inpxFiles[0]);
        if (result.ok) { window.location.reload(); return; }
        showToast(result.error || uiT('app.adminAddFail'), 'error');
      } catch (err) { showToast(uiT('app.errorPrefix') + ' ' + err.message, 'error'); }
      finally { submitBtn.disabled = false; submitBtn.innerHTML = escapeHtml(uiT('app.adminAddBtn')); }
    });

    panel.querySelector('[data-choice="folder"]').addEventListener('click', async () => {
      modal.forceClose();
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.adminAddingSource'));
      try {
        const result = await addSource(name, 'folder', folderPath);
        if (result.ok) { window.location.reload(); return; }
        showToast(result.error || uiT('app.adminAddFail'), 'error');
      } catch (err) { showToast(uiT('app.errorPrefix') + ' ' + err.message, 'error'); }
      finally { submitBtn.disabled = false; submitBtn.innerHTML = escapeHtml(uiT('app.adminAddBtn')); }
    });
  }
}

attachBfCacheFacetReload();
attachScrollToTop();
attachSidebarToggle();
attachThemeToggle();
attachDownloadMenus();
attachCoverErrorFallback(document);
loadBookPageReview();
attachRatingWidgets();
attachBookmarkActions();
attachReadBookActions();
attachCoverLongPress();
attachSeriesLongPress();
attachMarkSeriesReadActions();
attachFavoriteActions();
attachOperationActions();
attachSidecarDiagnostics();
attachCatalogNavLoading();
attachSmartSearch();
attachSearchSuggest();
attachBookIllustrationLightbox();
attachLoadMore();
attachBatchDownloadSelection();
attachConfirmedFormSubmits();
attachFormSubmitSpinners();
attachShelfActions();
attachAddToShelfButtons();
attachSendToEreader();
attachSendBatchToEreader();
attachUpdateUpload();
attachProfileTabs();
attachProfileRemoveActions();
attachAdminRecaptchaDisclosure();
if (document.querySelector('[data-index-status]')) pollIndexStatus();
if (document.querySelector('[data-admin-index-controls]')) pollAdminIndexControls();
if (document.querySelector('[data-operations-dashboard]')) pollOperationsDashboard();
if (document.querySelector('[data-admin-events-page]')) pollAdminEventsPage();
attachSourcesReindex();
attachSourceDelete();
attachAddSourceForm();

// --- Duplicates page: async loading ---
(function initDuplicatesPage() {
  const container = document.querySelector('[data-duplicates-page]');
  if (!container) return;

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  let currentPage = Number(container.getAttribute('data-page') || 1);
  const params = new URLSearchParams(window.location.search);
  if (params.has('page')) currentPage = Math.max(1, parseInt(params.get('page'), 10) || 1);

  let dupBusy = false;

  /** POST JSON to API, show inline spinner on triggering button, reload data on success. */
  async function dupAction(url, body, confirmMsg, danger, triggerBtn) {
    if (dupBusy) return;
    if (confirmMsg && !(await confirmAction(confirmMsg, { danger }))) return;
    dupBusy = true;
    let prevHtml = '';
    if (triggerBtn) {
      prevHtml = triggerBtn.innerHTML;
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || 'Выполняется…');
    }
    try {
      const csrf = getCsrfTokenFromPage();
      const headers = { 'Content-Type': 'application/json' };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const resp = await fetch(url, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body || {}) });
      const data = await resp.json().catch(() => ({}));
      if (data.message) showToast(data.message, data.ok ? 'success' : 'error');
      else if (!data.ok) showToast(data.error || 'Error', 'error');
    } catch (err) {
      showToast(err.message || 'Error', 'error');
    } finally {
      dupBusy = false;
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = prevHtml;
      }
    }
    loadDuplicates(currentPage);
  }

  function renderAutoCleanPanel(preview) {
    if (!preview || preview.willDelete <= 0) return '';
    return '<div class="admin-card admin-dup-auto-clean" style="margin-bottom:20px;border-left:4px solid var(--accent-color)">'
      + '<div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.autoCleanTitle')) + '</div>'
      + '<p style="margin:8px 0">' + escapeHtml(uiTp('admin.duplicates.autoCleanDesc', { groups: preview.totalGroups, total: preview.totalBooks, delete: preview.willDelete })) + '</p>'
      + '<p class="muted" style="font-size:.85em;margin:4px 0">' + escapeHtml(uiT('admin.duplicates.autoCleanStrategy')) + '</p>'
      + '<div style="margin-top:12px">'
      + '<button type="button" class="button-danger" data-dup-auto-clean data-n="' + preview.willDelete + '">'
      + escapeHtml(uiTp('admin.duplicates.autoCleanBtn', { n: preview.willDelete }))
      + '</button></div></div>';
  }

  function renderGroups(groups) {
    if (!groups || !groups.length) {
      return '<p class="muted" style="margin:24px 0">' + escapeHtml(uiT('admin.duplicates.empty')) + '</p>';
    }
    return groups.map(function(group, gi) {
      var thTitle = escapeHtml(uiT('admin.duplicates.thTitle'));
      var thAuthors = escapeHtml(uiT('admin.duplicates.thAuthors'));
      var thFormat = escapeHtml(uiT('admin.duplicates.thFormat'));
      var thSize = escapeHtml(uiT('admin.duplicates.thSize'));
      var thLang = escapeHtml(uiT('admin.duplicates.thLang'));
      var thFile = escapeHtml(uiT('admin.duplicates.thFile'));
      var rows = group.items.map(function(book) {
        return '<tr>'
          + '<td data-label="' + thTitle + '"><a href="/book/' + encodeURIComponent(book.id) + '">' + escapeHtml(book.title) + '</a></td>'
          + '<td data-label="' + thAuthors + '">' + escapeHtml(book.authors || '') + '</td>'
          + '<td data-label="' + thFormat + '"><span class="admin-chip admin-compact-btn">' + escapeHtml((book.ext || '').toUpperCase()) + '</span></td>'
          + '<td data-label="' + thSize + '" style="white-space:nowrap">' + escapeHtml(fmtSize(book.size)) + '</td>'
          + '<td data-label="' + thLang + '">' + escapeHtml(book.lang || '') + '</td>'
          + '<td data-label="' + thFile + '" class="muted" style="font-size:.85em;word-break:break-all">' + escapeHtml(book.archive_name || book.file_name || '') + '</td>'
          + '<td data-label=""><button type="button" class="button-danger admin-compact-btn" data-dup-delete="' + escapeHtml(book.id) + '" data-title="' + escapeHtml(book.title) + '">' + escapeHtml(uiT('admin.duplicates.delete')) + '</button></td></tr>';
      }).join('');
      return '<details class="admin-dup-group" ' + (gi < 5 ? 'open' : '') + '>'
        + '<summary class="admin-dup-group-summary">'
        + '<strong class="admin-dup-group-title">' + escapeHtml(group.title) + '</strong>'
        + '<span class="muted admin-dup-group-author"> \u2014 ' + escapeHtml(group.authors || uiT('book.authorUnknown')) + '</span>'
        + '<span class="admin-chip admin-dup-group-count">' + group.items.length + ' ' + escapeHtml(uiPlural('copy', group.items.length)) + '</span>'
        + '</summary>'
        + '<div class="admin-dup-table-wrap"><table class="admin-table admin-dup-table" style="width:100%;margin:8px 0"><thead><tr>'
        + '<th>' + escapeHtml(uiT('admin.duplicates.thTitle')) + '</th>'
        + '<th>' + escapeHtml(uiT('admin.duplicates.thAuthors')) + '</th>'
        + '<th>' + escapeHtml(uiT('admin.duplicates.thFormat')) + '</th>'
        + '<th>' + escapeHtml(uiT('admin.duplicates.thSize')) + '</th>'
        + '<th>' + escapeHtml(uiT('admin.duplicates.thLang')) + '</th>'
        + '<th>' + escapeHtml(uiT('admin.duplicates.thFile')) + '</th>'
        + '<th></th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
    }).join('');
  }

  function renderPagination(total, pageSize, page) {
    var totalPages = Math.ceil(total / pageSize) || 1;
    if (totalPages <= 1) return '';
    var html = '<div class="pagination" style="margin-top:16px">';
    var maxP = Math.min(totalPages, 20);
    for (var i = 1; i <= maxP; i++) {
      if (i === page) {
        html += '<span class="pagination-current">' + i + '</span> ';
      } else {
        html += '<a href="/admin/duplicates?page=' + i + '">' + i + '</a> ';
      }
    }
    if (totalPages > 20) html += ' \u2026';
    html += '</div>';
    return html;
  }

  function reasonLabel(reason) {
    if (reason === 'auto_clean') return uiT('admin.duplicates.reasonAutoClean');
    return uiT('admin.duplicates.reasonUser');
  }

  function renderSuppressedSection(sdata) {
    if (!sdata || !sdata.total) return '<div class="admin-card" style="margin-top:20px"><div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.suppressedTitle')) + '</div><p class="muted">' + escapeHtml(uiT('admin.duplicates.suppressedEmpty')) + '</p></div>';
    var rows = sdata.rows.map(function(s) {
      return '<tr>'
        + '<td>' + escapeHtml(s.title || s.book_id) + '</td>'
        + '<td>' + escapeHtml(s.authors || '') + '</td>'
        + '<td><span class="admin-chip" style="font-size:.8em">' + escapeHtml(reasonLabel(s.reason)) + '</span></td>'
        + '<td><button type="button" class="button" data-dup-unsuppress="' + escapeHtml(s.book_id) + '" style="font-size:.8em;padding:3px 8px">' + escapeHtml(uiT('admin.duplicates.unsuppress')) + '</button></td></tr>';
    }).join('');
    var unsuppressAllBtn = sdata.total > 1
      ? '<button type="button" class="button-danger" data-dup-unsuppress-all data-n="' + sdata.total + '" style="font-size:.9em;padding:5px 16px;margin-top:12px">' + escapeHtml(uiT('admin.duplicates.unsuppressAll')) + '</button>'
      : '';
    return '<div class="admin-card" style="margin-top:20px">'
      + '<div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.suppressedTitle')) + '</div>'
      + '<div class="admin-card-subtitle">' + escapeHtml(uiT('admin.duplicates.suppressedHint')) + '</div>'
      + '<div class="list-context-hint" style="margin:12px 0">' + escapeHtml(uiTp('admin.duplicates.suppressedCount', { n: sdata.total })) + '</div>'
      + '<div style="overflow-x:auto"><table class="admin-table" style="width:100%"><thead><tr>'
      + '<th>' + escapeHtml(uiT('admin.duplicates.thTitle')) + '</th>'
      + '<th>' + escapeHtml(uiT('admin.duplicates.thAuthors')) + '</th>'
      + '<th>' + escapeHtml(uiT('admin.duplicates.thFormat')) + '</th>'
      + '<th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      + unsuppressAllBtn
      + '</div>';
  }

  function wireActions() {
    container.querySelectorAll('[data-dup-delete]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-dup-delete');
        var title = btn.getAttribute('data-title') || id;
        dupAction('/api/admin/duplicates/delete', { bookId: id }, uiTp('admin.duplicates.deleteConfirm', { title: title }), true, btn);
      });
    });
    container.querySelectorAll('[data-dup-auto-clean]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var n = Number(btn.getAttribute('data-n') || 0);
        dupAction('/api/admin/duplicates/auto-clean', {}, uiTp('admin.duplicates.autoCleanConfirm', { n: n }), true, btn);
      });
    });
    container.querySelectorAll('[data-dup-unsuppress]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        dupAction('/api/admin/duplicates/unsuppress', { bookId: btn.getAttribute('data-dup-unsuppress') }, null, false, btn);
      });
    });
    container.querySelectorAll('[data-dup-unsuppress-all]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var n = Number(btn.getAttribute('data-n') || 0);
        dupAction('/api/admin/duplicates/unsuppress-all', {}, uiTp('admin.duplicates.unsuppressAllConfirm', { n: n }), true, btn);
      });
    });
  }

  function loadDuplicates(page) {
    Promise.all([
      fetch('/api/admin/duplicates?page=' + page).then(function(r) { return r.json(); }),
      fetch('/api/admin/suppressed').then(function(r) { return r.json(); })
    ])
      .then(function(results) {
        var data = results[0];
        var sdata = results[1];
        if (!data.ok) {
          container.innerHTML = '<div class="admin-card"><p class="muted">Error loading duplicates</p></div>';
          return;
        }
        var html = renderAutoCleanPanel(data.preview)
          + '<div class="admin-card">'
          + '<div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.cardTitle')) + '</div>'
          + '<div class="admin-card-subtitle">' + escapeHtml(uiT('admin.duplicates.cardSubtitle')) + '</div>'
          + '<div class="list-context-hint" style="margin:12px 0">' + escapeHtml(uiTp('admin.duplicates.totalGroups', { n: data.total })) + '</div>'
          + renderGroups(data.groups)
          + renderPagination(data.total, data.pageSize, data.page)
          + '</div>'
          + renderSuppressedSection(sdata.ok ? sdata : { total: 0, rows: [] });
        container.innerHTML = html;
        wireActions();
      })
      .catch(function(err) {
        container.innerHTML = '<div class="admin-card"><p class="muted">Error: ' + escapeHtml(String(err)) + '</p></div>';
      });
  }

  loadDuplicates(currentPage);
})();

// PWA: register Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
