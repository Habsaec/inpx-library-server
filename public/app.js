function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let _homeRecTimer = 0;
window.addEventListener('pagehide', () => { if (_homeRecTimer) { clearTimeout(_homeRecTimer); _homeRecTimer = 0; } });

/** Chrome rejects ViewTransition promises with AbortError when a cross-document
 *  transition is skipped (back/forward, rapid nav, timeout). Harmless — silence it. */
function silenceSkippedViewTransitions() {
  const swallow = (vt) => {
    if (!vt) return;
    Promise.resolve(vt.ready).catch(() => {});
    Promise.resolve(vt.finished).catch(() => {});
  };
  window.addEventListener('pageswap', (e) => swallow(e.viewTransition));
  window.addEventListener('pagereveal', (e) => swallow(e.viewTransition));
  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    if (err && err.name === 'AbortError' && String(err.message || '').includes('Transition was skipped')) {
      e.preventDefault();
    }
  });
}

async function loadHomeRecommendationsProgressively(attempt = 0) {
  const mount = document.querySelector('[data-home-recommendations]');
  if (!mount || mount.dataset.loaded === '1') return;
  try {
    const r = await fetch('/api/library/recommended?page=1&pageSize=24', { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    if (data.computing) {
      if (attempt < 10) {
        if (_homeRecTimer) clearTimeout(_homeRecTimer);
        _homeRecTimer = setTimeout(() => {
          _homeRecTimer = 0;
          if (document.querySelector('[data-home-recommendations]')) {
            loadHomeRecommendationsProgressively(attempt + 1);
          }
        }, 2000);
      }
      return;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) return;
    const total = Number(data?.total) || items.length;
    const heroTmp = document.createElement('div');
    heroTmp.innerHTML = renderPremiumHeroCarouselHtml(items, total);
    const heroCard = heroTmp.firstElementChild;
    if (!heroCard) return;
    mount.dataset.loaded = '1';
    heroCard.classList.add('home-reveal');
    mount.replaceWith(heroCard);
    attachCoverErrorFallback(heroCard);
    if (items.length > 1) initHeroCarousel(heroCard, items);
    else applyHeroBookAnnotation(items[0], heroCard);
    revealHomeBlock(heroCard);
  } catch { /* keep the welcome quote */ }
}

async function loadHomeContinueProgressively() {
  const section = document.querySelector('[data-home-continue]');
  if (!section || section.dataset.loaded === '1') return;
  const gridMount = section.querySelector('[data-home-continue-grid]');
  if (!gridMount) return;
  try {
    const r = await fetch('/api/library/continue?page=1&pageSize=8', { credentials: 'same-origin' });
    if (!r.ok) {
      section.remove();
      return;
    }
    const data = await r.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      section.remove();
      return;
    }
    const listMode = section.dataset.homeView === 'list';
    const tmp = document.createElement('div');
    tmp.innerHTML = listMode
      ? `<div class="author-flibusta-list catalog-book-list home-reveal"><section class="author-flibusta-group catalog-book-list-group"><ul class="author-flibusta-books catalog-book-list-ul">${items.map((b) => renderListRowHtml(b)).join('')}</ul></section></div>`
      : `<div class="grid home-reveal">${items.map((b) => renderCardHtml(b, { readActions: true })).join('')}</div>`;
    const grid = tmp.firstElementChild;
    if (!grid) return;
    gridMount.replaceWith(grid);
    attachCoverErrorFallback(grid);
    attachDownloadMenus(grid);
    if (!listMode) loadCardDetails(grid.querySelectorAll('.card'));
    revealHomeBlock(grid);
    revealHomeBlock(section);
    section.dataset.loaded = '1';
  } catch {
    section.remove();
  }
}

function revealHomeBlock(el) {
  if (!el) return;
  if (!el.classList.contains('home-reveal')) el.classList.add('home-reveal');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('home-reveal-active'));
  });
}

function initHomeWelcomeReveal() {
  const banner = document.querySelector('.welcome-hero-banner.home-reveal');
  if (banner) revealHomeBlock(banner);
}

function renderCoverRatingBadgeHtml(libRate) {
  const n = Math.max(0, Math.min(5, Math.floor(Number(libRate) || 0)));
  if (!n) return '';
  return `<span class="cover-rating-wrapper"><span class="cover-rating-badge cover-rating-${n}">${Array.from({ length: n }, () => '<span>★</span>').join('')}</span></span>`;
}

function renderHeroSlideInnerHtml(book, { eager = false, heading = 'h1', showKicker = false } = {}) {
  const title = escapeHtml(book.title || '');
  const progress = Math.max(0, Math.min(100, Math.round(Number(book.readProgress) || 0)));
  const coverSrc = apiBookPath(book.id, 'cover-thumb');
  const coverRating = renderCoverRatingBadgeHtml(book.libRate);
  const headingTag = heading === 'h1' ? 'h1' : 'h2';
  const kicker = showKicker
    ? `<div class="hero-card-kicker">${escapeHtml(uiT('home.heroKicker'))}</div>`
    : '';
  const progressHtml = progress > 0
    ? `<div class="hero-card-progress">
        <div class="hero-card-progress-bar" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div class="hero-card-progress-fill" style="width:${progress}%"></div></div>
        <span class="hero-card-progress-label">${escapeHtml(uiTp('home.heroProgress', { pct: progress }))}</span>
      </div>`
    : '';
  return `
    <div class="hero-card-cover-side">
      <a class="hero-cover-link cover" href="${bookPagePath(book.id)}">
        <img class="cover-image hero-cover-image" loading="${eager ? 'eager' : 'lazy'}" draggable="false" src="${coverSrc}" data-cover-src="${coverSrc}" alt="${title}">
        <span class="cover-fallback hero-cover-fallback" hidden>
          <img class="cover-fallback-image" draggable="false" src="/book-fallback.png" alt="">
          <span class="cover-fallback-overlay"></span>
          <span class="cover-fallback-copy"><span class="cover-fallback-title">${title}</span><span class="cover-fallback-author">${escapeHtml(book.authors || uiT('book.authorUnknown'))}</span></span>
        </span>
        ${coverRating}
      </a>
    </div>
    <div class="hero-card-info-side">
      ${kicker}
      <${headingTag} class="hero-card-title">${title}</${headingTag}>
      <div class="hero-card-author">${book.authors ? uiRenderAuthorLinks(book.authorsList, book.authors, `hero-a-${safeDomIdPart(book.id)}`) : escapeHtml(uiT('book.authorUnknown'))}</div>
      <p class="hero-card-annotation" data-hero-annotation hidden></p>
      ${progressHtml}
      <div class="hero-card-actions">
        <a class="button button-primary hero-read-btn" href="${readPagePath(book.id)}">${escapeHtml(uiT('home.heroReadBook'))}</a>
        <a class="button button-secondary hero-about-btn" href="${bookPagePath(book.id)}">${escapeHtml(uiT('home.heroAboutBook'))}</a>
      </div>
    </div>`;
}

function renderPremiumHeroCardHtml(book) {
  return `<section class="premium-hero-card">
    ${renderHeroSlideInnerHtml(book, { eager: true, heading: 'h1', showKicker: true })}
  </section>`;
}

function renderPremiumHeroCarouselHtml(books, total) {
  if (!books.length) return '';
  if (books.length === 1) return renderPremiumHeroCardHtml(books[0]);
  const slides = books.map((book, index) => `
    <article class="hero-carousel-slide" data-hero-slide="${index}" ${index === 0 ? '' : 'aria-hidden="true"'}>
      ${renderHeroSlideInnerHtml(book, { eager: index === 0, heading: 'h2' })}
    </article>`).join('');
  const dots = books.map((_, index) => `
    <button type="button" class="hero-carousel-dot${index === 0 ? ' is-active' : ''}" data-hero-dot="${index}" aria-label="${escapeHtml(uiTp('home.heroGoTo', { n: index + 1 }))}" ${index === 0 ? 'aria-current="true"' : ''}></button>`).join('');
  const more = total > books.length
    ? `<a class="hero-carousel-all" href="/library/recommended">${escapeHtml(uiT('home.showAll'))}</a>`
    : '';
  return `<section class="premium-hero-card hero-carousel" data-hero-carousel aria-roledescription="carousel" aria-label="${escapeHtml(uiT('home.shelfRecommended'))}">
    <div class="hero-carousel-head">
      <div class="hero-card-kicker">${escapeHtml(uiT('home.heroKicker'))}</div>
      <p class="hero-carousel-status" data-hero-status aria-live="polite">${escapeHtml(uiTp('home.heroSlide', { current: 1, total: books.length }))}</p>
      ${more}
    </div>
    <div class="hero-carousel-viewport" data-hero-viewport tabindex="0">
      <div class="hero-carousel-track" data-hero-track>${slides}</div>
    </div>
    <div class="hero-carousel-dots" data-hero-dots>${dots}</div>
  </section>`;
}

function formatHeroAnnotationText(raw, isHtml) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (isHtml) {
    const el = document.createElement('div');
    el.innerHTML = text;
    text = el.textContent || '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 320) text = `${text.slice(0, 317)}…`;
  return text;
}

function applyHeroBookAnnotation(book, root = document) {
  const slot = root.querySelector('[data-hero-annotation]');
  if (!slot || !book) return;
  const text = formatHeroAnnotationText(book.annotation, book.annotationIsHtml);
  if (text) {
    slot.textContent = text;
    slot.hidden = false;
    return;
  }
  void fetchHeroBookAnnotation(book.id, slot);
}

async function fetchHeroBookAnnotation(bookId, slotEl) {
  const slot = slotEl || document.querySelector('[data-hero-annotation]');
  if (!slot || !bookId) return;
  try {
    const r = await fetch(apiBookPath(bookId, 'details'), { credentials: 'same-origin' });
    if (!r.ok) return;
    const data = await r.json();
    const text = formatHeroAnnotationText(data.annotation, data.annotationIsHtml);
    if (!text) return;
    slot.textContent = text;
    slot.hidden = false;
  } catch { /* ignore */ }
}

function initHeroCarousel(root, books) {
  const track = root.querySelector('[data-hero-track]');
  const slides = [...root.querySelectorAll('[data-hero-slide]')];
  const dots = [...root.querySelectorAll('[data-hero-dot]')];
  const status = root.querySelector('[data-hero-status]');
  const viewport = root.querySelector('[data-hero-viewport]');
  if (!track || slides.length < 2) {
    applyHeroBookAnnotation(books[0], root);
    return;
  }
  let index = 0;
  let pointerStartX = 0;
  let pointerDelta = 0;
  let pointerActive = false;
  let timer = 0;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const AUTO_MS = 6500;

  const stopAuto = () => {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  };
  const startAuto = () => {
    if (reduceMotion || document.hidden || root.matches(':hover, :focus-within')) return;
    stopAuto();
    timer = window.setInterval(() => go(index + 1, { fromAuto: true }), AUTO_MS);
  };

  const go = (next, { fromAuto = false } = {}) => {
    const count = books.length;
    index = ((next % count) + count) % count;
    track.style.transform = `translateX(-${index * 100}%)`;
    slides.forEach((slide, i) => {
      if (i === index) slide.removeAttribute('aria-hidden');
      else slide.setAttribute('aria-hidden', 'true');
    });
    dots.forEach((dot, i) => {
      const on = i === index;
      dot.classList.toggle('is-active', on);
      if (on) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
    if (status) status.textContent = uiTp('home.heroSlide', { current: index + 1, total: count });
    applyHeroBookAnnotation(books[index], slides[index]);
    const neighbor = books[index + 1] || books[0];
    if (neighbor && neighbor !== books[index]) applyHeroBookAnnotation(neighbor, slides[(index + 1) % count]);
    if (!fromAuto) {
      stopAuto();
      startAuto();
    }
  };

  dots.forEach((dot) => {
    dot.addEventListener('click', () => go(Number(dot.dataset.heroDot) || 0));
  });
  viewport?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    }
  });
  viewport?.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerActive = true;
    pointerStartX = event.clientX;
    pointerDelta = 0;
    stopAuto();
  });
  viewport?.addEventListener('pointerup', (event) => {
    if (!pointerActive) return;
    pointerActive = false;
    pointerDelta = event.clientX - pointerStartX;
    if (pointerDelta > 48) go(index - 1);
    else if (pointerDelta < -48) go(index + 1);
    else startAuto();
  });
  viewport?.addEventListener('pointercancel', () => {
    pointerActive = false;
    startAuto();
  });
  root.addEventListener('mouseenter', stopAuto);
  root.addEventListener('mouseleave', startAuto);
  root.addEventListener('focusin', stopAuto);
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget)) startAuto();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAuto();
    else startAuto();
  });
  window.addEventListener('pagehide', stopAuto);
  go(0);
  startAuto();
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

function formatIndexArchiveLine(status) {
  const stage = status?.currentStage;
  if (stage?.key) {
    const params = { ...(stage.params || {}) };
    if (params.labelKey) {
      params.label = uiT(String(params.labelKey));
      delete params.labelKey;
    }
    if (params.phaseKey) {
      params.phase = uiT(String(params.phaseKey));
      delete params.phaseKey;
    }
    return uiTp(stage.key, params);
  }
  return status?.currentArchive ? String(status.currentArchive) : '';
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

function syncProfilePageCounters() {
  const root = document.querySelector('[data-profile-page-stats]');
  if (!root) return;
  const reading = Math.max(0, parseInt(root.dataset.readingTotal, 10) || 0);
  const readerBm = Math.max(0, parseInt(root.dataset.readerBmTotal, 10) || 0);
  const readerNotes = Math.max(0, parseInt(root.dataset.readerNotesTotal, 10) || 0);

  const link = document.querySelector('[data-profile-reading-all-link]');
  if (link) {
    link.textContent = uiTp('profile.readingAll', { n: formatClientInt(reading), books: uiPlural('book', reading) });
    if (reading > 0) link.removeAttribute('hidden');
    else link.setAttribute('hidden', '');
  }

  // Счётчики могут встречаться в нескольких местах (плитка + заголовок секции).
  document.querySelectorAll('[data-profile-reading-count]').forEach((el) => { el.textContent = formatClientInt(reading); });
  document.querySelectorAll('[data-profile-reader-bm-count]').forEach((el) => { el.textContent = formatClientInt(readerBm); });
  document.querySelectorAll('[data-profile-reader-notes-count]').forEach((el) => { el.textContent = formatClientInt(readerNotes); });
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

function bumpProfileReaderNotesTotal(delta) {
  const root = document.querySelector('[data-profile-page-stats]');
  if (!root) return;
  const next = Math.max(0, (parseInt(root.dataset.readerNotesTotal, 10) || 0) + delta);
  root.dataset.readerNotesTotal = String(next);
  syncProfilePageCounters();
}

async function loadBookPageReview() {
  const mount = document.querySelector('[data-book-review-mount]');
  if (!mount) return;
  const id = mount.dataset.bookReviewFor ? decodeURIComponent(mount.dataset.bookReviewFor).replace(/\uFFFD/g, '\0') : null;
  const heading = mount.dataset.reviewHeading || '';
  if (!id) {
    mount.remove();
    return;
  }
  try {
    const r = await fetch(`${apiBookPath(id, 'review')}`, { credentials: 'same-origin' });
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

const _coverFallbackPending = new Map(); // img -> { host, deadline }
let _coverFallbackTimer = 0;

function _scheduleCoverFallbackFlush() {
  if (_coverFallbackTimer) return;
  const now = performance.now();
  let nextDeadline = Infinity;
  for (const [, entry] of _coverFallbackPending) {
    nextDeadline = Math.min(nextDeadline, entry.deadline);
  }
  if (nextDeadline === Infinity) return;
  const delay = Math.max(0, nextDeadline - now);
  _coverFallbackTimer = window.setTimeout(_flushCoverFallbacks, delay);
}

function _flushCoverFallbacks() {
  _coverFallbackTimer = 0;
  const now = performance.now();
  for (const [img, entry] of _coverFallbackPending) {
    if (img.complete) {
      _coverFallbackPending.delete(img);
      if (img.naturalWidth > 0) img.classList.add('is-loaded');
      setCoverFallbackState(entry.host, !(img.naturalWidth > 0));
      continue;
    }
    if (now >= entry.deadline) {
      setCoverFallbackState(entry.host, true);
      _coverFallbackPending.delete(img);
    }
  }
  _scheduleCoverFallbackFlush();
}

/** Декоративная обложка в разметке; при error /cover-thumb (404 без обложки) и при coverAvailable=false не подменяем заглушкой с API. */
function attachCoverErrorFallback(scope = document) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const imgs = root.querySelectorAll('.cover .cover-image');
  let added = false;
  for (const img of imgs) {
    if (img.dataset.coverErrBound === '1') continue;
    img.dataset.coverErrBound = '1';
    const host = img.closest('.card, .book-detail-main, .cover');
    const removePending = () => { _coverFallbackPending.delete(img); };
    img.addEventListener('load', () => {
      removePending();
      img.classList.add('is-loaded');
      setCoverFallbackState(host, false);
    }, { once: true });
    img.addEventListener('error', () => {
      removePending();
      setCoverFallbackState(host, true);
    }, { once: true });
    if (img.complete) {
      removePending();
      if (img.naturalWidth > 0) img.classList.add('is-loaded');
      setCoverFallbackState(host, !(img.naturalWidth > 0));
    } else {
      _coverFallbackPending.set(img, { host, deadline: performance.now() + 2000 });
      added = true;
    }
  }
  if (added) _scheduleCoverFallbackFlush();
}

const CARD_DETAILS_BATCH_SIZE = 48;
const CARD_DETAILS_FLUSH_DELAY_MS = 150;
const CARD_DETAILS_CACHE_MAX = 300;
const _cardDetailsCache = new Map();
const _cardDetailsQueued = new Set();
const _cardDetailsInFlight = new Set();
let _cardDetailsFlushTimer = 0;
let _cardDetailsFlushPending = false;
let _cardDetailsObserver = null;

function stripAnnotationPreviewText(raw, isHtml) {
  let text = String(raw || '');
  if (isHtml) {
    const tmp = document.createElement('div');
    tmp.innerHTML = text;
    text = tmp.textContent || tmp.innerText || '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 220) text = `${text.slice(0, 217).trim()}…`;
  return text;
}

function applyCardDetailsForId(id, details) {
  if (!id || !details) return;
  const cards = typeof findCardsByBookId === 'function' ? findCardsByBookId(id) : document.querySelectorAll(`[data-book-id="${CSS.escape(id)}"]`);
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
    let preview = card.querySelector('[data-card-annotation]');
    const cover = card.querySelector('.cover');
    if (preview && cover && !cover.contains(preview)) {
      cover.appendChild(preview);
    }
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'card-annotation-preview';
      preview.hidden = true;
      preview.dataset.cardAnnotation = '';
      (cover || card).appendChild(preview);
    }
    const excerpt = stripAnnotationPreviewText(details.annotation, details.annotationIsHtml);
    if (excerpt) {
      preview.textContent = excerpt;
      preview.hidden = false;
      preview.removeAttribute('hidden');
      card.classList.add('has-annotation-preview');
    } else {
      preview.textContent = '';
      preview.hidden = true;
      card.classList.remove('has-annotation-preview');
    }
  }
}

const CARD_DETAILS_CACHE_TTL_MS = 5 * 60 * 1000;

function trimCardDetailsCache() {
  const now = Date.now();
  for (const [id, entry] of _cardDetailsCache) {
    if (now - entry.ts > CARD_DETAILS_CACHE_TTL_MS) {
      _cardDetailsCache.delete(id);
    }
  }
  while (_cardDetailsCache.size > CARD_DETAILS_CACHE_MAX) {
    const first = _cardDetailsCache.keys().next().value;
    if (first === undefined) break;
    _cardDetailsCache.delete(first);
  }
}

function scheduleCardDetailsFlush() {
  if (_cardDetailsFlushTimer) return;
  _cardDetailsFlushTimer = window.setTimeout(async () => {
    _cardDetailsFlushTimer = 0;
    if (_cardDetailsFlushPending) return;
    _cardDetailsFlushPending = true;
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
          _cardDetailsCache.set(id, { details, ts: Date.now() });
          trimCardDetailsCache();
          applyCardDetailsForId(id, details);
        }
      } catch (error) {
        console.error(error);
      } finally {
        ids.forEach((id) => _cardDetailsInFlight.delete(id));
      }
    }
    _cardDetailsFlushPending = false;
    if (_cardDetailsQueued.size > 0) scheduleCardDetailsFlush();
  }, CARD_DETAILS_FLUSH_DELAY_MS);
}

function queueCardDetailsById(id) {
  if (!id) return;
  if (_cardDetailsCache.has(id) || _cardDetailsInFlight.has(id) || _cardDetailsQueued.has(id)) return;
  _cardDetailsQueued.add(id);
  scheduleCardDetailsFlush();
}

function resetCardDetailsObserver() {
  if (_cardDetailsObserver) {
    _cardDetailsObserver.disconnect();
    _cardDetailsObserver = null;
  }
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
        applyCardDetailsForId(id, _cardDetailsCache.get(id).details);
      } else {
        queueCardDetailsById(id);
      }
    }
  }, {
    root: null,
    rootMargin: '100px 0px',
    threshold: 0.01
  });
  return _cardDetailsObserver;
}

function loadCardDetails(cardList) {
  if (!cardList) resetCardDetailsObserver();
  const cards = cardList ? [...cardList] : [...document.querySelectorAll('.card[data-book-id-ref], .card[data-book-id]')];
  if (!cards.length) return Promise.resolve();
  const observer = getCardDetailsObserver();
  for (const card of cards) {
    const id = typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(card) : card.dataset.bookId;
    if (!id) continue;
    if (_cardDetailsCache.has(id)) {
      applyCardDetailsForId(id, _cardDetailsCache.get(id).details);
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

function pulseUi(el, className = 'ui-feedback-pulse') {
  if (!el) return;
  el.classList.remove(className);
  // force reflow so repeated toggles restart the animation
  void el.offsetWidth;
  el.classList.add(className);
  window.setTimeout(() => el.classList.remove(className), 360);
}

function attachCatalogFilters() {
  const panel = document.querySelector('[data-catalog-filters]');
  if (!panel) return;
  const list = panel.querySelector('.catalog-genre-list');
  const search = panel.querySelector('[data-catalog-genre-search]');

  const bindGenreSearch = () => {
    const options = [...panel.querySelectorAll('.catalog-genre-option')];
    if (!search || !options.length) return;
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      for (const opt of options) {
        const hay = String(opt.dataset.genreSearch || '');
        opt.hidden = Boolean(q) && !hay.includes(q);
      }
    };
  };
  bindGenreSearch();

  if (panel.getAttribute('data-catalog-genres-lazy') !== '1' || !list) return;
  const params = new URLSearchParams();
  const q = panel.getAttribute('data-genres-q') || '';
  if (q) params.set('q', q);
  const lang = panel.getAttribute('data-genres-lang') || '';
  const format = panel.getAttribute('data-genres-format') || '';
  const year = panel.getAttribute('data-genres-year') || '';
  const minRate = panel.getAttribute('data-genres-min-rate') || '';
  const hasSeries = panel.getAttribute('data-genres-has-series') || '';
  if (lang) params.set('lang', lang);
  if (format) params.set('format', format);
  if (year) params.set('year', year);
  if (minRate) params.set('minRate', minRate);
  if (hasSeries !== '') params.set('hasSeries', hasSeries);
  const selected = new Set(
    [...panel.querySelectorAll('input[name="genre"]:checked')].map((el) => el.value)
  );
  fetch(`/api/search/genres?${params.toString()}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const loading = list.querySelector('[data-catalog-genres-loading]');
      if (loading) loading.remove();
      const items = Array.isArray(data?.items) ? data.items : [];
      const html = items.map((g) => {
        const name = String(g.name || '');
        if (!name || selected.has(name)) return '';
        const label = String(g.displayName || name);
        const count = Number.isFinite(Number(g.bookCount)) ? Math.max(0, Math.floor(Number(g.bookCount))) : null;
        const searchHay = `${name} ${label}`.toLowerCase();
        const countHtml = count != null
          ? `<span class="catalog-genre-count muted">${escapeHtml(String(count))}</span>`
          : '';
        return `<label class="catalog-genre-option" data-genre-search="${escapeHtml(searchHay)}"><input type="checkbox" name="genre" value="${escapeHtml(name)}"><span class="catalog-genre-label">${escapeHtml(label)}</span>${countHtml}</label>`;
      }).join('');
      if (html) list.insertAdjacentHTML('beforeend', html);
      else if (!list.querySelector('.catalog-genre-option')) {
        list.insertAdjacentHTML('beforeend', `<span class="muted">${escapeHtml(uiT('browse.empty') || '—')}</span>`);
      }
      bindGenreSearch();
    })
    .catch(() => {
      const loading = list.querySelector('[data-catalog-genres-loading]');
      if (loading) loading.textContent = uiT('catalog.filtersGenresLoading') || '…';
    });
}

function attachThemeToggle() {
  const root = document.documentElement;
  const buttons = [...document.querySelectorAll('[data-theme-toggle]')];
  if (!buttons.length) {
    return;
  }

  const getTheme = () => root.dataset.theme === 'light' ? 'light' : 'dark';
  const getNextThemeLabel = (theme) => theme === 'light' ? uiT('app.themeDark') : uiT('app.themeLight');
  const THEME_SUN_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  const THEME_MOON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  const getThemeIcon = (theme) => theme === 'light' ? THEME_MOON_SVG : THEME_SUN_SVG;

  const render = () => {
    const theme = getTheme();
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      const labelNode = button.querySelector('[data-theme-toggle-label]');
      const label = getNextThemeLabel(theme);
      if (labelNode) {
        labelNode.innerHTML = getThemeIcon(theme);
      }
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
  };

  /* Автоопределение темы: ручной выбор в localStorage важнее системной настройки */
  try {
    const saved = localStorage.getItem('theme-preference');
    if (saved === 'light' || saved === 'dark') {
      root.dataset.theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      root.dataset.theme = 'light';
    }
  } catch {
    /* ignore storage errors */
  }

  render();

  /* Следим за системной темой, пока пользователь не сделал ручной выбор.
     Удаляем старый listener перед добавлением нового — при MPA matchMedia
     глобальна, а listeners накапливаются при переходе между страницами. */
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e) => {
      try {
        if (localStorage.getItem('theme-preference')) return;
      } catch {
        return;
      }
      document.documentElement.dataset.theme = e.matches ? 'light' : 'dark';
      render();
    };
    if (attachThemeToggle._mqHandler) {
      if (mq.removeEventListener) mq.removeEventListener('change', attachThemeToggle._mqHandler);
      else if (mq.removeListener) mq.removeListener(attachThemeToggle._mqHandler);
    }
    attachThemeToggle._mqHandler = onChange;
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
    } else if (mq.addListener) {
      mq.addListener(onChange);
    }
  }

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

    if (menu.hasAttribute('data-scope-download') && menu.dataset.scopePerBookBound !== '1') {
      menu.dataset.scopePerBookBound = '1';
      const box = menu.querySelector('[data-scope-per-book-zip]');
      const sync = () => {
        const on = Boolean(box?.checked);
        for (const link of menu.querySelectorAll('[data-scope-download-format]')) {
          const href = link.getAttribute('href');
          if (!href) continue;
          const url = new URL(href, window.location.origin);
          if (on) url.searchParams.set('perBookZip', '1');
          else url.searchParams.delete('perBookZip');
          link.setAttribute('href', `${url.pathname}${url.search}`);
        }
      };
      box?.addEventListener('change', sync);
      box?.addEventListener('click', (e) => e.stopPropagation());
    }
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

const TOAST_MAX_VISIBLE = 3;

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

  const existing = [...host.children];
  if (existing.length >= TOAST_MAX_VISIBLE) {
    for (let i = 0; i <= existing.length - TOAST_MAX_VISIBLE; i++) {
      existing[i].remove();
    }
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
    if (!button.classList.contains('account-list-remove')) {
      button.textContent = uiT('profile.removeTitle');
    }
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

async function postReadToggle(bookId) {
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const headers = {};
  if (csrfMeta) headers['x-csrf-token'] = csrfMeta.content;
  const response = await fetch(apiReadPath(bookId), {
    method: 'POST', credentials: 'same-origin', headers
  });
  if (await handleAuthRequired(response)) return null;
  if (!response.ok) return null;
  return response.json();
}

function showReadToggleToast(bookId, read, syncButtons = []) {
  const message = read ? uiT('book.markReadUndo') : uiT('book.unmarkReadUndo');
  showToast(message, 'success', {
    actionLabel: uiT('app.undo'),
    duration: 5000,
    onAction: () => {
      void (async () => {
        const payload = await postReadToggle(bookId);
        if (!payload) return;
        toggleReadBadgesForBook(bookId, Boolean(payload.read));
        for (const btn of syncButtons) {
          if (!btn?.isConnected) continue;
          btn.classList.toggle('is-active', Boolean(payload.read));
          btn.textContent = payload.read ? uiT('book.markedRead') : uiT('book.markRead');
        }
        pulseReadProgressForBook(bookId);
      })();
    }
  });
}

function pulseReadProgressForBook(bookId) {
  const cards = typeof findCardsByBookId === 'function' ? findCardsByBookId(bookId) : [];
  for (const card of cards) {
    const bar = card.querySelector('.card-read-progress');
    if (bar) pulseUi(bar, 'progress-pulse');
  }
}

function attachReadBookActions() {
  document.querySelectorAll('[data-read-button]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const bookId = typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(btn) : (btn.dataset.readButton ? decodeURIComponent(btn.dataset.readButton).replace(/\uFFFD/g, '\0') : null);
      try {
        const payload = await postReadToggle(bookId);
        if (!payload) return;
        const read = Boolean(payload.read);
        btn.classList.toggle('is-active', read);
        btn.textContent = read ? uiT('book.markedRead') : uiT('book.markRead');
        pulseUi(btn);
        toggleReadBadgesForBook(bookId, read);
        pulseReadProgressForBook(bookId);
        showReadToggleToast(bookId, read, [btn]);
      } catch (err) { console.error('Read toggle error', err); }
    });
  });
}

function toggleReadBadgesForBook(bookId, isRead) {
  const set = getReadBookIdSet();
  if (isRead) set.add(bookId); else set.delete(bookId);
  const cards = typeof findCardsByBookId === 'function' ? findCardsByBookId(bookId) : [...document.querySelectorAll(`.card[data-book-id="${CSS.escape(bookId)}"]`)];
  cards.forEach((card) => {
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
  // `fired` is true between the long-press firing and touchend/mouseup.
  // `swallowNextClick` is true only briefly to swallow the synthetic click
  // that may follow touchend (so the cover link doesn't navigate).
  let fired = false;
  let swallowNextClick = false;
  let swallowTimer = null;
  let startX = 0, startY = 0;

  function getCardBookId(el) {
    const card = el.closest('.card[data-book-id-ref], .card[data-book-id]');
    if (!card) return null;
    return typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(card) : card.dataset.bookId;
  }

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function armSwallowClick() {
    swallowNextClick = true;
    if (swallowTimer) clearTimeout(swallowTimer);
    // Failsafe: Android Chrome may not synthesize a click after preventDefault
    // on touchend. Without this, swallowNextClick would stick and break the page.
    swallowTimer = setTimeout(() => { swallowNextClick = false; swallowTimer = null; }, 700);
  }

  async function toggleRead(bookId, cover) {
    fired = true;
    try {
      const payload = await postReadToggle(bookId);
      if (!payload) return;
      const read = Boolean(payload.read);
      toggleReadBadgesForBook(bookId, read);
      pulseReadProgressForBook(bookId);
      const buttons = [...document.querySelectorAll('[data-read-button]')].filter((btn) => {
        const id = typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(btn) : null;
        return id === bookId;
      });
      for (const btn of buttons) {
        btn.classList.toggle('is-active', read);
        btn.textContent = read ? uiT('book.markedRead') : uiT('book.markRead');
      }
      showReadToggleToast(bookId, read, buttons);
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
      // Visual feedback — guaranteed even when the OS swallows our vibration request.
      cover.classList.remove('cover-longpress-flash');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          cover.classList.add('cover-longpress-flash');
        });
      });
      cover.addEventListener('animationend', () => cover.classList.remove('cover-longpress-flash'), { once: true });
      // Haptic feedback (best-effort). Android often drops short single-shots; a pattern
      // increases the chance of being delivered, but it remains best-effort by spec.
      try { navigator.vibrate && navigator.vibrate([40, 30, 40]); } catch (_) { /* ignore */ }
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
      armSwallowClick();
      fired = false; // CRITICAL: never leave `fired` stuck true; otherwise every
                     // subsequent touchend on the page would be eaten until reload.
    }
  }

  document.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend', onEnd);
  document.addEventListener('touchcancel', () => { cancel(); fired = false; });
  // prevent navigation immediately after long-press
  document.addEventListener('click', (e) => {
    if (swallowNextClick) {
      e.preventDefault();
      e.stopPropagation();
      swallowNextClick = false;
      if (swallowTimer) { clearTimeout(swallowTimer); swallowTimer = null; }
    }
  }, true);
  // Suppress the native context menu on book covers — on mobile (Android Chrome) it
  // pops on long-press before our 500ms timer fires, hijacking the "mark as read" UX.
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.cover[data-role="cover"]')) e.preventDefault();
  });
}

function attachSeriesLongPress() {
  const LONG_PRESS_MS = 500;
  let timer = null;
  let fired = false;
  let swallowNextClick = false;
  let swallowTimer = null;
  let startX = 0, startY = 0;

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function armSwallowClick() {
    swallowNextClick = true;
    if (swallowTimer) clearTimeout(swallowTimer);
    swallowTimer = setTimeout(() => { swallowNextClick = false; swallowTimer = null; }, 700);
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
    const row = e.target.closest('.table-row-link');
    if (!row) return;
    const href = row.getAttribute('href') || '';
    if (!href.includes('/facet/series/')) return;
    fired = false;
    const point = e.touches ? e.touches[0] : e;
    startX = point.clientX;
    startY = point.clientY;
    const cleanHref = href.split('?')[0];
    const m = cleanHref.match(/\/facet\/series\/(.+)$/);
    if (!m) return;
    const seriesName = decodeURIComponent(m[1]);
    timer = setTimeout(() => {
      timer = null;
      try { navigator.vibrate && navigator.vibrate([40, 30, 40]); } catch (_) { /* ignore */ }
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
      armSwallowClick();
      fired = false;
    }
  }

  document.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('touchend', onEnd);
  document.addEventListener('touchcancel', () => { cancel(); fired = false; });
  document.addEventListener('click', (e) => {
    if (!swallowNextClick) return;
    const row = e.target.closest('.table-row-link');
    if (!row) return;
    const href = row.getAttribute('href') || '';
    if (!href.includes('/facet/series/')) return;
    e.preventDefault();
    e.stopPropagation();
    swallowNextClick = false;
    if (swallowTimer) { clearTimeout(swallowTimer); swallowTimer = null; }
  }, true);
  // Suppress the native context menu on series rows — on mobile it
  // pops on long-press before our 500ms timer fires, hijacking the "mark as read" UX.
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.table-row-link[href*="/facet/series/"]')) e.preventDefault();
  });
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
      const bookId = typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(button) : (button.dataset.bookmarkButton ? decodeURIComponent(button.dataset.bookmarkButton).replace(/\uFFFD/g, '\0') : null);
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
        const response = await fetch(apiBookmarkPath(bookId), {
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
        pulseUi(button);
        if (!payload.bookmarked && favoritesView === 'books') {
          const card = button.closest('.card');
          const row = button.closest('.table-row');
          const item = card || row;
          if (item) {
            item.style.display = 'none';
            const removeTimer = window.setTimeout(() => {
              if (item.style.display === 'none') {
                item.remove();
                  }
            }, 5500);
            showToast(uiT('app.bookRemovedFavorite'), 'success', {
              actionLabel: uiT('app.undo'), duration: 5000,
              onAction: () => {
                window.clearTimeout(removeTimer);
                item.style.display = '';
                syncBookBookmarkButtonUi(button, true);
                    void (async () => {
                  try {
                    const r = await fetch(apiBookmarkPath(bookId), { method: 'POST', credentials: 'same-origin' });
                    if (await handleAuthRequired(r)) return;
                    if (!r.ok) {
                      item.style.display = 'none';
                                showToast(uiT('app.favoriteBookUndoFail'), 'error');
                    }
                  } catch {
                    item.style.display = 'none';
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
            const authorName = button.dataset.favoriteAuthor;
            const removeTimer = window.setTimeout(() => {
              if (row.style.display === 'none') {
                row.remove();
                  }
            }, 5500);
            showToast(uiT('app.authorRemovedFavorite'), 'success', {
              actionLabel: uiT('app.undo'), duration: 5000,
              onAction: () => {
                window.clearTimeout(removeTimer);
                row.style.display = '';
                syncAuthorSeriesFavoriteButtonUi(button, true);
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
                                showToast(uiT('app.authorUndoFail'), 'error');
                    }
                  } catch {
                    row.style.display = 'none';
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
            const seriesName = button.dataset.favoriteSeries;
            const removeTimer = window.setTimeout(() => {
              if (row.style.display === 'none') {
                row.remove();
                  }
            }, 5500);
            showToast(uiT('app.seriesRemovedFavorite'), 'success', {
              actionLabel: uiT('app.undo'), duration: 5000,
              onAction: () => {
                window.clearTimeout(removeTimer);
                row.style.display = '';
                syncAuthorSeriesFavoriteButtonUi(button, true);
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
                                showToast(uiT('app.seriesUndoFail'), 'error');
                    }
                  } catch {
                    row.style.display = 'none';
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
  let timerId = 0;
  const clearTimer = () => { if (timerId) { clearTimeout(timerId); timerId = 0; } };
  window.addEventListener('pagehide', clearTimer, { once: true });
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
    const phase = String(status?.phase || '');
    const active = Boolean(status?.active) || phase === 'maintenance';
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
    const unique = Math.max(0, Math.floor(Number(status?.uniqueBooks) || 0));
    const phaseDone = Number(status?.phaseDone || 0);
    const phaseTotal = Number(status?.phaseTotal || 0);
    const phaseLabel = String(status?.phaseLabel || '');
    let percent = 0;
    let title = escapeHtml(uiT('app.adminIndexingLabel'));
    let detail = '';
    let indeterminate = false;
    if (phase === 'fts') {
      percent = phaseTotal > 0 ? Math.min(100, Math.round((phaseDone / phaseTotal) * 100)) : 0;
      title = escapeHtml(uiT('app.adminIndexPhaseFts'));
      detail = phaseTotal > 0 ? `<span class="muted" style="margin-left:12px">${phaseDone} / ${phaseTotal}</span>` : '';
    } else if (phase === 'maintenance') {
      indeterminate = true;
      title = escapeHtml(uiT('app.adminIndexPhaseMaintenance'));
      detail = phaseLabel ? `<span class="muted" style="margin-left:12px">${escapeHtml(phaseLabel)}</span>` : '';
    } else {
      percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
      detail = `<span class="muted" style="margin-left:12px">${escapeHtml(uiTp('app.adminIndexFilesLine', { processed, total, imported, unique }))}</span>`;
    }
    const paused = Boolean(status?.pauseRequested || status?.paused);
    if (textNode) {
      textNode.innerHTML = `${title} ${indeterminate ? '' : `<strong>${percent}%</strong>`}${detail}`;
    }
    if (timeNode) {
      // ETA only meaningful during the archives phase; suppress during fts/maintenance.
      const showEta = !phase || phase === 'archives';
      const { elapsed, eta } = computeIndexTimeInfo(status?.startedAt, processed, total);
      const parts = [];
      if (elapsed) parts.push(uiTp('app.indexElapsed', { time: elapsed }));
      if (showEta && eta) parts.push(uiTp('app.indexEta', { time: eta }));
      timeNode.textContent = parts.join('  \u00b7  ');
    }
    if (archiveNode) {
      archiveNode.textContent = formatIndexArchiveLine(status);
    }
    if (barNode) {
      const barWidth = indeterminate ? 100 : percent;
      barNode.style.width = `${barWidth}%`;
      barNode.style.background = 'var(--accent)';
      barNode.classList.toggle('progress-indeterminate', indeterminate);
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
    clearTimer();
    if (!root.isConnected) return;
    // On sources page, attachSourceDelete handles deletion progress — skip here to avoid conflicts.
    if (!isSourcesPage) {
      try {
        // Check deletion status first (higher priority)
        const delRes = await fetch('/api/admin/sources/delete-progress', { credentials: 'same-origin' });
        if (delRes.ok) {
          const delStatus = await delRes.json();
          if (applyDeleteStatus(delStatus)) {
            timerId = window.setTimeout(scheduleRefresh, 500);
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
    timerId = window.setTimeout(scheduleRefresh, 3000);
  };

  const scheduleRefresh = () => {
    clearTimer();
    if (document.visibilityState === 'visible') {
      refresh();
    } else {
      const onVisible = () => {
        document.removeEventListener('visibilitychange', onVisible);
        scheduleRefresh();
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

const _sparklineSizes = new WeakMap();
let _sparklineResizeObs = null;

function _ensureSparklineResizeObs() {
  if (_sparklineResizeObs || typeof ResizeObserver === 'undefined') return;
  _sparklineResizeObs = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const svg = entry.target;
      if (!svg) continue;
      const w = Math.round(entry.contentRect.width) || Math.round(svg.clientWidth) || 400;
      const h = Math.round(entry.contentRect.height) || Math.round(svg.clientHeight) || 48;
      _sparklineSizes.set(svg, { w, h });
    }
  });
}

async function pollOperationsDashboard() {
  const dashboard = document.querySelector('[data-operations-dashboard]');
  if (!dashboard) {
    return;
  }
  let timerId = 0;
  const clearTimer = () => { if (timerId) { clearTimeout(timerId); timerId = 0; } };
  const SPARK_HISTORY_POINTS = 30;
  const cpuHistory = new Array(SPARK_HISTORY_POINTS).fill(0);
  const memHistory = new Array(SPARK_HISTORY_POINTS).fill(0);
  const pushSparkHistory = (arr, value) => {
    if (!Number.isFinite(value)) return;
    arr.push(Math.max(0, Math.min(100, Number(value))));
    arr.shift();
  };
  const observedSvgs = new Set();
  const cleanupObserved = () => {
    for (const svg of observedSvgs) {
      if (_sparklineResizeObs) _sparklineResizeObs.unobserve(svg);
    }
    observedSvgs.clear();
  };
  const onPageHide = () => { clearTimer(); cleanupObserved(); };
  window.addEventListener('pagehide', onPageHide, { once: true });

  const renderSparkline = (field, values) => {
    const svg = document.querySelector(`[data-operations-field="${field}"]`);
    if (!svg) return;
    const LINES_COUNT = 4;
    /* Фактические размеры SVG кэшируются; ResizeObserver обновляет при resize. */
    let size = _sparklineSizes.get(svg);
    if (!size) {
      const rect = svg.getBoundingClientRect();
      size = { w: Math.round(rect.width) || 400, h: Math.round(rect.height) || 48 };
      _sparklineSizes.set(svg, size);
      _ensureSparklineResizeObs();
      if (_sparklineResizeObs) {
        _sparklineResizeObs.observe(svg);
        observedSvgs.add(svg);
      }
    }
    const H = size.h;
    const TOTAL_W = size.w;
    const PAD = 28;
    const GRAPH_W = Math.max(50, TOTAL_W - PAD);
    if (!values || values.length < 2) {
      svg.setAttribute('viewBox', `0 0 ${TOTAL_W} ${H}`);
      svg.innerHTML = '';
      return;
    }
    /* Autoscale Y: округляем max до кратного 5, минимум 10%. */
    let maxVal = values[0];
    for (let i = 1; i < values.length; i++) {
      if (values[i] > maxVal) maxVal = values[i];
    }
    const currentMaxY = Math.max(10, Math.ceil(maxVal / 5) * 5);
    /* Шкала + сетка внутри SVG: текст слева, линии справа. */
    const grid = [];
    for (let i = 0; i <= LINES_COUNT; i++) {
      const y = (H / LINES_COUNT) * i;
      const pct = Math.round(currentMaxY - (i * (currentMaxY / LINES_COUNT)));
      grid.push(`<text class="spark-label" x="${PAD - 3}" y="${y}" dy="0.35em">${pct}%</text>`);
      grid.push(`<line class="spark-grid" x1="${PAD}" y1="${y}" x2="${TOTAL_W}" y2="${y}"/>`);
    }
    /* Разделительная линия между шкалой и графиком. */
    grid.push(`<line class="spark-axis" x1="${PAD}" y1="0" x2="${PAD}" y2="${H}"/>`);
    const stepX = GRAPH_W / (SPARK_HISTORY_POINTS - 1);
    const points = values.map((v, i) => {
      const x = PAD + i * stepX;
      const y = H - (v / currentMaxY) * H;
      return `${x.toFixed(2)} ${y.toFixed(2)}`;
    });
    const linePath = `M ${points.join(' L ')}`;
    const fillPath = `${linePath} L ${TOTAL_W} ${H} L ${PAD} ${H} Z`;
    svg.setAttribute('viewBox', `0 0 ${TOTAL_W} ${H}`);
    svg.innerHTML = `${grid.join('')}<path class="spark-fill" d="${fillPath}"></path><path class="spark-line" d="${linePath}"></path>`;
  };
  /* Статистика под графиком отключена — данные видны в заголовке тайла. */
  const renderSparkStats = (field) => {
    const el = document.querySelector(`[data-operations-field="${field}"]`);
    if (el) el.innerHTML = '';
  };

  const refresh = async () => {
    clearTimer();
    if (!dashboard.isConnected) { cleanupObserved(); return; }
    try {
      const response = await fetch('/api/operations', { credentials: 'same-origin' });
      if (!response.ok) {
        timerId = window.setTimeout(scheduleRefresh, 2000);
        return;
      }

      const payload = await response.json();
      const { operations, indexStatus } = payload;
      const actionStates = {
        reindex: Boolean(operations.reindexRunning || indexStatus.active),
        'reindex-toggle-pause': !Boolean(indexStatus.active),
        'reindex-stop': !Boolean(indexStatus.active),
        repair: Boolean(operations.repairRunning),
        'fts-rebuild': Boolean(operations.ftsRebuildRunning || indexStatus.active),
        'sidecar-rebuild': Boolean(operations.sidecarRunning),
        'cache-clear': false,
        'events-retain': false
      };
      const loc = getUiLocale() === 'en' ? 'en-US' : 'ru-RU';
      const mb = (Number(operations.cacheApproxBytes) || 0) / 1024 / 1024;
      /* CPU: оба значения (% от всех ядер / % от одного ядра). */
      const cpuAll = Number(operations.cpuAll ?? operations.cpuPercent);
      const cpuSingle = Number(operations.cpuSingle);
      /* «Память приложения» = RSS (как в htop / диспетчере задач), а не V8 heap.
         Heap показывает только JS-объекты (~5% от реального потребления у нас),
         основная масса сидит в нативной памяти SQLite page cache. */
      const rssMb = Number(operations.memoryMB);
      const systemMb = Number(operations.systemMemoryMB);
      const memPct = Number.isFinite(rssMb) && Number.isFinite(systemMb) && systemMb > 0
        ? Math.max(0, Math.min(100, (rssMb / systemMb) * 100))
        : 0;
      const diskTotalMb = Number(operations.diskTotalMB);
      const diskFreeMb = Number(operations.diskFreeMB);
      /* «База данных»: размер файла + цветной стэковый бар разбивки по категориям.
         Бар — это структура (что внутри), а не «процент диска» (всегда был ~0). */
      const dbBytes = Number(operations.dbSizeBytes);
      const dbMb = Number.isFinite(dbBytes) && dbBytes > 0 ? dbBytes / 1024 / 1024 : NaN;
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
      /* Живые библиотечные счётчики наверху дашборда (книги/авторы/серии/скрытые/последняя индексация).
         Сервер кладёт их в operations.{totalBooks,totalAuthors,totalSeries,suppressedCount,lastIndexImported,lastIndexUnique} —
         без этого панель показывала бы значения, замороженные на момент server-side рендера. */
      const lastImported = Math.max(0, Math.floor(Number(operations.lastIndexImported) || 0));
      const lastUnique = Math.max(0, Math.floor(Number(operations.lastIndexUnique) || 0));
      const lastIndexText = (lastImported > 0 || lastUnique > 0)
        ? uiTp('admin.statsLastIndex', { imported: lastImported.toLocaleString(loc), unique: lastUnique.toLocaleString(loc) })
        : uiT('admin.statsLastIndexEmpty');
      const ftsSnap = operations.ftsStatus || (indexStatus && indexStatus.ftsStatus) || {};
      let ftsSt = ftsSnap.status || '';
      if (operations.ftsRebuildRunning) ftsSt = 'rebuilding';
      const ftsStatusText = ftsSt === 'ok' ? uiT('admin.ftsStatusOk')
        : ftsSt === 'dirty' ? uiT('admin.ftsStatusDirty')
          : ftsSt === 'rebuilding' ? uiT('admin.ftsStatusRebuilding')
            : ftsSt === 'desynced' ? uiT('admin.ftsStatusDesynced')
              : ftsSt === 'empty' ? uiT('admin.ftsStatusEmpty')
                : uiT('admin.ftsStatusUnknown');
      const ftsTip = uiTp('admin.ftsStatusTip', {
        books: Number(ftsSnap.booksCount) || 0,
        fts: Number(ftsSnap.ftsDocCount) || 0
      });
      const operationsFields = {
        statsBooks: uiCountLabel('book', Number(operations.totalBooks) || 0),
        statsAuthors: uiCountLabel('author', Number(operations.totalAuthors) || 0),
        statsSeries: uiCountLabel('series', Number(operations.totalSeries) || 0),
        statsSuppressed: uiTp('admin.statsSuppressed', { n: (Number(operations.suppressedCount) || 0).toLocaleString(loc) }),
        statsDeleted: uiTp('admin.statsDeleted', { n: (Number(operations.deletedCount) || 0).toLocaleString(loc) }),
        statsLastIndex: lastIndexText,
        ftsStatus: ftsStatusText,
        appVersion: 'v' + (operations.appVersion || '?'),
        lastRepairAt: `${uiT('app.lastRepair')} ${operations.lastRepairAt || uiT('common.dash')}`,
        lastRepairError: operations.lastRepairError || '',
        cacheCountInline: `${uiCountLabel('record', operations.cacheCount)} · ${mb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${uiT('app.unitMb')}`,
        /* CPU: % от одного ядра — совпадает с полоской загрузки. */
        monitorCpu: `${Number.isFinite(cpuSingle) ? cpuSingle.toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : uiT('common.dash')}%`,
        /* RSS как для тайла «Память приложения». Авто-единицы + «из X ГБ». */
        monitorMem: (() => {
          if (!Number.isFinite(rssMb)) return uiT('common.dash');
          const cur = rssMb >= 1024
            ? `${(rssMb / 1024).toLocaleString(loc, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${uiT('common.unitGB') || uiT('app.unitGb')}`
            : `${rssMb.toLocaleString(loc, { maximumFractionDigits: 0 })} ${uiT('common.unitMB')}`;
          if (!Number.isFinite(systemMb) || systemMb <= 0) return cur;
          const totalStr = systemMb >= 1024
            ? `${(systemMb / 1024).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${uiT('common.unitGB') || uiT('app.unitGb')}`
            : `${systemMb.toLocaleString(loc, { maximumFractionDigits: 0 })} ${uiT('common.unitMB')}`;
          return `${cur} ${uiTp('admin.monitor.memOfTotal', { total: totalStr })}`;
        })(),
        /* «База данных»: размер файла. При >1 ГБ показываем в ГБ. */
        monitorDb: Number.isFinite(dbMb)
          ? (dbMb >= 1024
            ? `${(dbMb / 1024).toLocaleString(loc, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${uiT('common.unitGB') || uiT('app.unitGb')}`
            : `${dbMb.toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${uiT('common.unitMB')}`)
          : uiT('common.dash'),
        /* monitorDisk теперь обновляется отдельным блоком ниже (Used/Free/Total). */
        monitorUptime: `${uiT('admin.monitor.uptime')}: ${upText}`,
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
        if (field === 'ftsStatus') {
          node.title = ftsTip;
          node.dataset.ftsStatus = ftsSt;
          node.classList.toggle('admin-chip--warn', ftsSt === 'ok' && ftsSt !== 'empty' && Boolean(ftsSt));
        }
      }

      const monitorBars = {
        /* CPU-полоска опирается на cpuSingle: 1 ядро = реальный лимит для нашей синхронной нагрузки. */
        monitorCpuBar: Number.isFinite(cpuSingle) ? Math.max(0, Math.min(100, cpuSingle)) : 0,
        monitorMemBar: memPct,
        monitorDiskBar: Number.isFinite(diskUsedMb) && Number.isFinite(diskTotalMb) && diskTotalMb > 0
          ? Math.max(0, Math.min(100, (diskUsedMb / diskTotalMb) * 100))
          : 0
      };

      /* Перестраиваем разбивку БД (стэковый бар + легенда) если данные пришли. */
      const dbBreakdown = operations.dbBreakdown;
      if (dbBreakdown && Array.isArray(dbBreakdown.segments)) {
        const fmtSize = (bytes) => {
          const n = Number(bytes) || 0;
          if (n >= 1024 * 1024 * 1024) return `${(n / (1024*1024*1024)).toLocaleString(loc, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${uiT('common.unitGB') || uiT('app.unitGb')}`;
          if (n >= 1024 * 1024) return `${(n / (1024*1024)).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${uiT('common.unitMB')}`;
          if (n >= 1024) return `${(n / 1024).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${uiT('common.unitKB') || 'KB'}`;
          return `${n} B`;
        };
        const stackEl = document.querySelector('[data-operations-field="monitorDbStack"]');
        if (stackEl) {
          stackEl.innerHTML = dbBreakdown.segments.map((s) => {
            const label = uiT('admin.monitor.dbSeg.' + s.key) || s.key;
            const size = fmtSize(s.bytes);
            return `<span class="db-seg db-seg-${escapeHtml(s.key)}" style="width:${Number(s.pct).toFixed(2)}%" title="${escapeHtml(label)}: ${escapeHtml(size)}"></span>`;
          }).join('');
        }
        const legendEl = document.querySelector('[data-operations-field="monitorDbLegend"]');
        if (legendEl) {
          legendEl.innerHTML = dbBreakdown.segments.map((s) => {
            const label = uiT('admin.monitor.dbSeg.' + s.key) || s.key;
            const size = fmtSize(s.bytes);
            return `<span class="db-legend-item"><i class="db-seg-dot db-seg-${escapeHtml(s.key)}"></i><span class="db-legend-label">${escapeHtml(label)}</span><span class="db-legend-size muted">${escapeHtml(size)}</span></span>`;
          }).join('');
        }
      }
      /* Тот же градиент severity, что и на сервере: зелёный → жёлтый (0–70%) → красный (70–100%).
         Используется и для полосок (линейная заливка), и для donut-индикатора диска (solid stroke). */
      const monitorSeverityRgb = (pct) => {
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        const c0 = { r: 63, g: 185, b: 94 };
        const c1 = { r: 226, g: 187, b: 79 };
        const c2 = { r: 217, g: 80, b: 80 };
        const lerp = (a, b, t) => Math.round(a + (b - a) * t);
        if (p <= 70) {
          const t = p / 70;
          return { r: lerp(c0.r, c1.r, t), g: lerp(c0.g, c1.g, t), b: lerp(c0.b, c1.b, t) };
        }
        const t = (p - 70) / 30;
        return { r: lerp(c1.r, c2.r, t), g: lerp(c1.g, c2.g, t), b: lerp(c1.b, c2.b, t) };
      };
      const monitorSeverityColor = (pct) => {
        const out = monitorSeverityRgb(pct);
        return `rgb(${out.r}, ${out.g}, ${out.b})`;
      };
      const monitorBarGradient = (pct) => {
        const out = monitorSeverityRgb(pct);
        return `linear-gradient(90deg, rgb(63, 185, 94) 0%, rgb(${out.r}, ${out.g}, ${out.b}) 100%)`;
      };
      for (const [field, pct] of Object.entries(monitorBars)) {
        const bar = document.querySelector(`[data-operations-field="${field}"]`);
        if (!bar) continue;
        bar.style.width = `${pct.toFixed(1)}%`;
        bar.style.background = monitorBarGradient(pct);
      }
      pushSparkHistory(cpuHistory, monitorBars.monitorCpuBar);
      pushSparkHistory(memHistory, monitorBars.monitorMemBar);
      renderSparkline('monitorCpuSpark', cpuHistory);
      renderSparkline('monitorMemSpark', memHistory);
      renderSparkStats('monitorCpuStats', cpuHistory);
      renderSparkStats('monitorMemStats', memHistory);

      /* Диск: процент справа, толстая полоса с градиентом + три статистики снизу.
         monitorDiskBar — уже занятая в monitorBars-цикле, она апдейтит .disk-bar-fill
         (width + background) автоматически по полю data-operations-field. Здесь
         только цифра процента и три текстовые статистики. */
      const diskPctVal = monitorBars.monitorDiskBar;
      const diskPctEl = document.querySelector('[data-operations-field="monitorDiskPct"]');
      if (diskPctEl) diskPctEl.textContent = `${diskPctVal.toFixed(0)}%`;
      const fmtDisk = (mb) => {
        if (!Number.isFinite(mb)) return uiT('common.dash');
        if (mb >= 1024) return `${(mb / 1024).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${uiT('common.unitGB') || uiT('app.unitGb')}`;
        return `${mb.toLocaleString(loc, { maximumFractionDigits: 0 })} ${uiT('common.unitMB')}`;
      };
      const diskStats = [
        { sel: 'monitorDiskUsed',  label: uiT('admin.monitor.diskUsedLabel'),  value: fmtDisk(diskUsedMb) },
        { sel: 'monitorDiskFree',  label: uiT('admin.monitor.diskFreeLabel'),  value: fmtDisk(diskFreeMb) },
        { sel: 'monitorDiskTotal', label: uiT('admin.monitor.diskTotalLabel'), value: fmtDisk(diskTotalMb) }
      ];
      for (const s of diskStats) {
        const el = document.querySelector(`[data-operations-field="${s.sel}"]`);
        if (!el) continue;
        el.innerHTML = `<span class="muted">${escapeHtml(s.label)}</span><strong>${escapeHtml(s.value)}</strong>`;
      }

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
        const line = indexStatus.active ? formatIndexArchiveLine(indexStatus).trim() : '';
        stageNode.textContent = line;
      }

    } catch (error) {
      console.error(error);
    }
    timerId = window.setTimeout(scheduleRefresh, 2000);
  };

  const scheduleRefresh = () => {
    clearTimer();
    if (document.visibilityState === 'visible') { refresh(); } else {
      const onVisible = () => { document.removeEventListener('visibilitychange', onVisible); scheduleRefresh(); };
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
  let _lastEventsSig = '';
  const renderEventsPayload = (events, total = null) => {
    const sig = (events[0]?.id || '') + ':' + (events.length) + ':' + (total ?? '');
    if (sig === _lastEventsSig) return;
    _lastEventsSig = sig;
    if (eventsList) {
      eventsList.innerHTML = renderEventsListInnerHtml(events || []);
    }
    if (totalEl && total != null) {
      totalEl.textContent = uiCountLabel('record', total);
    }
  };

  const startPolling = () => {
    let timerId = 0;
    const clearTimer = () => { if (timerId) { clearTimeout(timerId); timerId = 0; } };
    window.addEventListener('pagehide', clearTimer, { once: true });
    const refresh = async () => {
      clearTimer();
      if (!pageRoot.isConnected) return;
      try {
        const q = window.location.search || '';
        const response = await fetch(`/api/admin/system-events${q}`, { credentials: 'same-origin' });
        if (!response.ok) {
          timerId = window.setTimeout(scheduleRefresh, 2000);
          return;
        }
        const data = await response.json();
        latestEvents = Array.isArray(data.events) ? data.events : [];
        latestTotal = Number.isFinite(data.total) ? data.total : latestEvents.length;
        renderEventsPayload(latestEvents, latestTotal);
      } catch (error) {
        console.error(error);
      }
      timerId = window.setTimeout(scheduleRefresh, 2000);
    };

    const scheduleRefresh = () => {
      clearTimer();
      if (document.visibilityState === 'visible') {
        refresh();
      } else {
        const onVisible = () => {
          document.removeEventListener('visibilitychange', onVisible);
          scheduleRefresh();
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

const SEARCH_HISTORY_KEY = 'inpx-search-history';
const SEARCH_HISTORY_MAX = 8;

function readSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, SEARCH_HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

function writeSearchHistory(list) {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, SEARCH_HISTORY_MAX)));
  } catch { /* quota / private mode */ }
}

function addSearchHistory(query) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return;
  const next = [trimmed, ...readSearchHistory().filter((item) => item.toLowerCase() !== trimmed.toLowerCase())]
    .slice(0, SEARCH_HISTORY_MAX);
  writeSearchHistory(next);
}

function removeSearchHistory(query) {
  const needle = String(query || '').trim().toLowerCase();
  writeSearchHistory(readSearchHistory().filter((item) => item.toLowerCase() !== needle));
}

function clearSearchHistory() {
  writeSearchHistory([]);
}

function attachSearchHistory() {
  const form = document.querySelector('[data-smart-search]');
  const input = form?.querySelector('[data-suggest-input], #global-search-input, [name="q"]');
  const dropdown = form?.querySelector('[data-suggest-dropdown]');
  if (!form || !input || !dropdown) return;

  let activeIdx = -1;
  let items = [];
  let suggestTimer = 0;
  let suggestSeq = 0;
  let lastApi = { books: [], authors: [], series: [] };

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

  const filteredHistory = () => {
    const q = input.value.trim().toLowerCase();
    const all = readSearchHistory();
    if (!q) return all;
    return all.filter((item) => item.toLowerCase().includes(q));
  };

  const runHistoryQuery = (query) => {
    input.value = query;
    hide();
    addSearchHistory(query);
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
  };

  const activateSuggestItem = (el) => {
    if (!el) return;
    const href = el.getAttribute('data-suggest-href');
    const q = el.getAttribute('data-search-history-query')
      || el.getAttribute('data-suggest-query')
      || '';
    if (href) {
      if (q) addSearchHistory(q);
      hide();
      window.location.href = href;
      return;
    }
    if (q) runHistoryQuery(q);
  };

  const render = () => {
    const history = filteredHistory();
    const q = input.value.trim();
    const rows = [];
    let seq = 0;

    const pushGroup = (title, groupItems) => {
      if (!groupItems.length) return;
      rows.push(`<div class="suggest-history-header"><span class="suggest-group-title">${escapeHtml(title)}</span></div>`);
      for (const row of groupItems) rows.push(row);
    };

    if (history.length) {
      rows.push(`
        <div class="suggest-history-header">
          <span class="suggest-group-title">${escapeHtml(uiT('search.recentTitle'))}</span>
          <button type="button" class="suggest-history-clear" data-search-history-clear>${escapeHtml(uiT('search.recentClear'))}</button>
        </div>`);
      for (const query of history.slice(0, 6)) {
        const itemId = `search-history-item-${seq++}`;
        rows.push(`
          <div class="suggest-history-row">
            <button type="button" class="suggest-item" id="${itemId}" data-suggest-item data-search-history-query="${escapeHtml(query)}" role="option">
              <span class="suggest-item-title">${escapeHtml(query)}</span>
            </button>
            <button type="button" class="suggest-history-remove" data-search-history-remove="${escapeHtml(query)}" aria-label="${escapeHtml(uiT('search.recentRemove'))} ${escapeHtml(query)}">×</button>
          </div>`);
      }
    }

    if (q.length >= 2) {
      const bookRows = (lastApi.books || []).slice(0, 5).map((book) => {
        const itemId = `search-suggest-book-${seq++}`;
        const href = bookPagePath(book.id);
        return `<button type="button" class="suggest-item" id="${itemId}" data-suggest-item data-suggest-href="${escapeHtml(href)}" data-suggest-query="${escapeHtml(book.title || q)}" role="option">
          <span class="suggest-item-title">${escapeHtml(book.title || '')}</span>
          <span class="suggest-item-sub">${escapeHtml(book.authors || '')}</span>
        </button>`;
      });
      const authorRows = (lastApi.authors || []).slice(0, 4).map((row) => {
        const itemId = `search-suggest-author-${seq++}`;
        const label = row.displayName || row.name || '';
        const href = `/facet/authors/${encodeURIComponent(row.name || label)}`;
        return `<button type="button" class="suggest-item" id="${itemId}" data-suggest-item data-suggest-href="${escapeHtml(href)}" data-suggest-query="${escapeHtml(label)}" role="option">
          <span class="suggest-item-title">${escapeHtml(label)}</span>
          <span class="suggest-item-sub">${escapeHtml(String(row.bookCount || ''))}</span>
        </button>`;
      });
      const seriesRows = (lastApi.series || []).slice(0, 4).map((row) => {
        const itemId = `search-suggest-series-${seq++}`;
        const label = row.displayName || row.name || '';
        const href = `/facet/series/${encodeURIComponent(row.name || label)}`;
        return `<button type="button" class="suggest-item" id="${itemId}" data-suggest-item data-suggest-href="${escapeHtml(href)}" data-suggest-query="${escapeHtml(label)}" role="option">
          <span class="suggest-item-title">${escapeHtml(label)}</span>
          <span class="suggest-item-sub">${escapeHtml(String(row.bookCount || ''))}</span>
        </button>`;
      });
      pushGroup(uiT('search.suggestBooks'), bookRows);
      pushGroup(uiT('search.suggestAuthors'), authorRows);
      pushGroup(uiT('search.suggestSeries'), seriesRows);
    }

    if (!rows.length) {
      hide();
      return;
    }
    dropdown.innerHTML = rows.join('');
    items = [...dropdown.querySelectorAll('[data-suggest-item]')];
    activeIdx = -1;
    show();
  };

  const fetchSuggest = () => {
    const q = input.value.trim();
    if (q.length < 3) {
      lastApi = { books: [], authors: [], series: [] };
      render();
      return;
    }
    const seq = ++suggestSeq;
    fetch(`/api/search/suggest?q=${encodeURIComponent(q)}&field=books`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (seq !== suggestSeq) return;
        lastApi = {
          books: Array.isArray(data?.books) ? data.books : [],
          authors: Array.isArray(data?.authors) ? data.authors : [],
          series: Array.isArray(data?.series) ? data.series : []
        };
        if (document.activeElement === input) render();
      })
      .catch(() => {});
  };

  const setActive = (idx) => {
    items.forEach((el, i) => {
      const active = i === idx;
      el.classList.toggle('suggest-active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    activeIdx = idx;
    if (idx >= 0 && items[idx]) {
      input.setAttribute('aria-activedescendant', items[idx].id);
      items[idx].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  form.addEventListener('submit', () => {
    const q = (input.value || '').trim();
    input.value = q;
    if (q) addSearchHistory(q);
    hide();
  });

  input.addEventListener('focus', () => {
    render();
    if (input.value.trim().length >= 3) fetchSuggest();
  });

  input.addEventListener('input', () => {
    if (document.activeElement !== input) return;
    render();
    window.clearTimeout(suggestTimer);
    suggestTimer = window.setTimeout(fetchSuggest, 320);
  });

  input.addEventListener('keydown', (e) => {
    if (dropdown.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      render();
    }
    if (dropdown.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(activeIdx < items.length - 1 ? activeIdx + 1 : 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(activeIdx > 0 ? activeIdx - 1 : items.length - 1);
    } else if (e.key === 'Enter' && activeIdx >= 0 && items[activeIdx]) {
      e.preventDefault();
      activateSuggestItem(items[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });

  dropdown.addEventListener('mousedown', (e) => {
    /* Keep input focus while clicking inside dropdown. */
    e.preventDefault();
  });

  dropdown.addEventListener('click', (e) => {
    const clearBtn = e.target.closest('[data-search-history-clear]');
    if (clearBtn) {
      clearSearchHistory();
      hide();
      return;
    }
    const removeBtn = e.target.closest('[data-search-history-remove]');
    if (removeBtn) {
      removeSearchHistory(removeBtn.getAttribute('data-search-history-remove') || '');
      render();
      return;
    }
    const item = e.target.closest('[data-suggest-item]');
    if (item) activateSuggestItem(item);
  });

  document.addEventListener('click', (e) => {
    if (!form.contains(e.target)) hide();
  });

  /* Persist query already shown in the bar (results / overview page). */
  const current = (input.value || '').trim();
  if (current.length >= 2) addSearchHistory(current);
}

function attachSmartSearch() {
  const forms = [...document.querySelectorAll('[data-smart-search]')];
  if (!forms.length) return;

  // Main search submits to /catalog?q=… (no field) → unified overview hub.
  // Scoped drilldown uses /catalog?q=…&field=books|authors|series from overview links.
  for (const form of forms) {
    form.addEventListener('submit', () => {
      const queryInput = form.querySelector('[name="q"]');
      if (queryInput) queryInput.value = (queryInput.value || '').trim();
    });
  }
  attachSearchHistory();
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

const TOPBAR_COMPACT_MQ = '(max-width: 900px)';

function attachTopbarSearchToggle() {
  const topbar = document.querySelector('[data-topbar]');
  const btn = document.querySelector('[data-topbar-search-toggle]');
  if (!topbar || !btn) return;

  const input = document.getElementById('global-search-input');
  const setOpen = (open) => {
    topbar.classList.toggle('topbar-search-expanded', open);
    topbar.classList.remove('topbar-hidden');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      open ? (uiT('topbar.searchClose') || uiT('topbar.searchToggle')) : uiT('topbar.searchToggle')
    );
    btn.title = btn.getAttribute('aria-label') || '';
    if (open && input) {
      requestAnimationFrame(() => input.focus());
    }
  };

  btn.addEventListener('click', () => {
    setOpen(!topbar.classList.contains('topbar-search-expanded'));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && topbar.classList.contains('topbar-search-expanded')) {
      setOpen(false);
    }
  });
}

/** Скрывает компактный topbar при скролле вниз, показывает при скролле вверх. */
function attachTopbarAutoHide() {
  const topbar = document.querySelector('[data-topbar]');
  if (!topbar) return;

  const mq = window.matchMedia(TOPBAR_COMPACT_MQ);
  let lastY = window.scrollY;
  let ticking = false;

  const closeSearch = () => {
    if (!topbar.classList.contains('topbar-search-expanded')) return;
    topbar.classList.remove('topbar-search-expanded');
    const btn = document.querySelector('[data-topbar-search-toggle]');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', uiT('topbar.searchToggle'));
      btn.title = uiT('topbar.searchToggle');
    }
  };

  const onScroll = () => {
    if (!mq.matches) {
      topbar.classList.remove('topbar-hidden');
      return;
    }
    const y = window.scrollY;
    const dy = y - lastY;
    if (y < 56) {
      topbar.classList.remove('topbar-hidden');
    } else if (dy > 6) {
      closeSearch();
      topbar.classList.add('topbar-hidden');
    } else if (dy < -6) {
      topbar.classList.remove('topbar-hidden');
    }
    lastY = y;
  };

  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        onScroll();
        ticking = false;
      });
    },
    { passive: true }
  );

  const onMq = () => {
    if (!mq.matches) topbar.classList.remove('topbar-hidden', 'topbar-search-expanded');
    lastY = window.scrollY;
  };
  if (mq.addEventListener) mq.addEventListener('change', onMq);
  else if (mq.addListener) mq.addListener(onMq);
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
    if (form.hasAttribute('data-ajax')) continue;
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
      window.setTimeout(() => {
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || '\u0412\u044b\u043f\u043e\u043b\u043d\u044f\u0435\u0442\u0441\u044f\u2026');
      }, 0);
    });
  }
}

function isPageDownloadAllowed() {
  if (typeof document === 'undefined') return true;
  return document.body?.dataset?.downloadAllowed === '1';
}

function isPageEmailSendAllowed() {
  if (typeof document === 'undefined') return false;
  // SSR rows / batch email toolbar prove the current user may send by email.
  return Boolean(document.querySelector('[data-send-to-ereader], [data-batch-email-format]'));
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

function uiNormalizeAuthorToken(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^,+|,+$/g, '')
    .replace(/^\?+$/, '')
    .trim();
}

function uiSplitAuthorValues(value) {
  return String(value || '')
    .replace(/\s*;\s*/g, ':')
    .replace(/\s*:\s*/g, ':')
    .split(':')
    .map((item) => uiNormalizeAuthorToken(item))
    .filter(Boolean);
}

function uiFormatSingleAuthorName(value = '') {
  const raw = uiNormalizeAuthorToken(value);
  if (!raw) return '';
  const parts = raw.split(',').map((item) => uiNormalizeAuthorToken(item)).filter(Boolean);
  if (!parts.length) return raw;
  return parts.join(' ');
}

function uiRenderAuthorLinks(authorsList, bookAuthors, popoverId) {
  const list = (authorsList?.length) ? authorsList : uiSplitAuthorValues(bookAuthors);
  if (!list.length) return '';
  const visible = list.slice(0, 1);
  const rest = list.slice(1);
  const visibleHtml = visible.map((author) => {
    const name = uiFormatSingleAuthorName(author) || author;
    return `<a href="/facet/authors/${encodeURIComponent(author)}">${escapeHtml(name)}</a>`;
  }).join(', ');
  if (!rest.length) {
    return `<span class="author-visible">${visibleHtml}</span>`;
  }
  const restHtml = rest.map((author) => {
    const name = uiFormatSingleAuthorName(author) || author;
    return `<a href="/facet/authors/${encodeURIComponent(author)}">${escapeHtml(name)}</a>`;
  }).join(', ');
  const id = escapeHtml(safeDomIdPart(popoverId));
  const anchorName = `--${id}`;
  return `<span class="author-visible">${visibleHtml}</span><button type="button" class="author-popover-trigger" popovertarget="${id}" style="anchor-name:${anchorName}">+${rest.length}</button><div id="${id}" popover="auto" class="author-popover" style="position-anchor:${anchorName}"><div class="author-popover-inner">${restHtml}</div></div>`;
}

function uiRenderSeriesLinks(seriesList, popoverId, firstAuthor) {
  const list = seriesList || [];
  if (!list.length) return '';
  const visible = list.slice(0, 1);
  const rest = list.slice(1);
  const sParam = firstAuthor ? `?author=${encodeURIComponent(firstAuthor)}` : '';
  const visibleHtml = visible.map((s) => {
    return `<a href="/facet/series/${encodeURIComponent(s.name)}${sParam}">${escapeHtml(s.displayName || s.name)}${s.seriesNo ? ` #${escapeHtml(String(s.seriesNo))}` : ''}</a>`;
  }).join(', ');
  if (!rest.length) {
    return `<span class="series-visible">${visibleHtml}</span>`;
  }
  const restHtml = rest.map((s) => {
    return `<a href="/facet/series/${encodeURIComponent(s.name)}${sParam}">${escapeHtml(s.displayName || s.name)}${s.seriesNo ? ` #${escapeHtml(String(s.seriesNo))}` : ''}</a>`;
  }).join(', ');
  const id = escapeHtml(safeDomIdPart(popoverId));
  const anchorName = `--${id}`;
  return `<span class="series-visible">${visibleHtml}</span><button type="button" class="series-popover-trigger" popovertarget="${id}" style="anchor-name:${anchorName}">+${rest.length}</button><div id="${id}" popover="auto" class="series-popover" style="position-anchor:${anchorName}"><div class="series-popover-inner">${restHtml}</div></div>`;
}

function renderCardHtml(book, { batchSelect = false, seriesContext = null, readActions = false } = {}) {
  const id = escapeHtml(book.id);
  const authors = escapeHtml(book.authors || '');
  const authorKey = book.authorsList?.[0] || book.authors?.split(',')[0]?.trim() || '';
  const seriesInfo = seriesContext
    ? (book.seriesList?.find((s) => s.name === seriesContext) || null)
    : null;
  const titlePrefix = seriesInfo?.seriesNo ? `${escapeHtml(String(seriesInfo.seriesNo))}. ` : '';
  const title = titlePrefix + escapeHtml(book.title || '');
  const showSeries = !seriesContext && (book.seriesList || []).length > 0;
  const seriesList = book.seriesList || [];
  const seriesAuthorParam = authorKey ? `?author=${encodeURIComponent(authorKey)}` : '';
  const seriesHtml = showSeries
    ? seriesList.map((s) => {
        const dn = escapeHtml(s.displayName || s.name);
        const no = s.seriesNo ? ` #${escapeHtml(String(s.seriesNo))}` : '';
        return `<a href="/facet/series/${encodeURIComponent(s.name)}${seriesAuthorParam}">${dn}${no}</a>`;
      }).join(', ')
    : '';
  const sourceFormat = String(book.ext || 'fb2').toLowerCase();
  const formats =
    Array.isArray(book.downloadFormats) && book.downloadFormats.length
      ? book.downloadFormats.map((x) => [x.format, x.label])
      : sourceFormat === 'fb2'
        ? [['fb2', 'FB2'], ['epub2', 'EPUB']]
        : [[sourceFormat, sourceFormat.toUpperCase()]];
  const downloadMenu =
    isPageDownloadAllowed() && formats.length
      ? formats.length === 1
        ? `<a class="button download-menu-trigger download-menu-trigger-compact download-direct-link" href="${downloadBookPath(book.id, `format=${encodeURIComponent(formats[0][0])}`)}">${escapeHtml(uiT('download.label'))}</a>`
        : `<details class="download-menu download-menu-compact">
      <summary class="button download-menu-trigger download-menu-trigger-compact">${escapeHtml(uiT('download.label'))}</summary>
      <div class="download-menu-popover">${formats.map(([f, l]) => `<a class="download-format-link" href="${downloadBookPath(book.id, `format=${encodeURIComponent(f)}`)}">${escapeHtml(l)}</a>`).join('')}</div>
    </details>`
      : '';
  const batchCb = batchSelect
    ? `<label class="batch-select-hit" title="${escapeHtml(uiT('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" id="batch-select-${safeDomIdPart(book.id)}" name="batch-select-${safeDomIdPart(book.id)}" ${bookIdNeedsSafeUrl(book.id) ? `data-batch-book-id-ref="${escapeHtml(encodeBookRef(book.id))}"` : `data-batch-book-id="${id}"`} aria-label="${escapeHtml(uiT('batch.selectAria'))}"></label>`
    : '';
  const cardRef = encodeBookRef(book.id);
  const cardAttrs = bookIdNeedsSafeUrl(book.id)
    ? `data-book-id-ref="${escapeHtml(cardRef)}"`
    : `data-book-id-ref="${escapeHtml(cardRef)}" data-book-id="${id}"`;
  const _libRateClamped = Math.max(0, Math.min(5, Math.floor(Number(book.libRate) || 0)));
  const coverRating = _libRateClamped ? `<span class="cover-rating-wrapper"><span class="cover-rating-badge cover-rating-${_libRateClamped}">${Array.from({ length: _libRateClamped }, () => '<span>★</span>').join('')}</span></span>` : '';
  return `<article class="card" ${cardAttrs}>
    ${batchCb}
    <a class="cover" href="${bookPagePath(book.id)}" data-role="cover">
      <img class="cover-image" loading="lazy" draggable="false" src="${apiBookPath(book.id, 'cover-thumb')}" data-cover-src="${apiBookPath(book.id, 'cover-thumb')}" alt="${title}">
      <span class="cover-fallback" hidden>
        <img class="cover-fallback-image" draggable="false" src="/book-fallback.png" alt="">
        <span class="cover-fallback-overlay"></span>
        <span class="cover-fallback-copy"><span class="cover-fallback-title">${title}</span><span class="cover-fallback-author">${authors || escapeHtml(uiT('book.authorUnknown'))}</span></span>
      </span>
      ${getReadBookIdSet().has(book.id) ? `<span class="read-badge">${READ_BADGE_SVG}</span>` : ''}
      ${coverRating}
      <div class="card-annotation-preview" hidden data-card-annotation></div>
    </a>
    <div class="meta">
      <h3><a href="${bookPagePath(book.id)}">${title}</a></h3>
      <div class="author">${book.authors ? uiRenderAuthorLinks(book.authorsList, book.authors, `ajax-a-${book.id}`) : escapeHtml(uiT('book.authorUnknown'))}</div>
      ${showSeries ? `<div class="card-series">${uiRenderSeriesLinks(book.seriesList, `ajax-s-${book.id}`, authorKey)}</div>` : ''}
      ${book.readProgress > 0 ? `<div class="card-read-progress"><div class="read-progress-bar" role="progressbar" aria-valuenow="${Math.round(book.readProgress)}" aria-valuemin="0" aria-valuemax="100"><div class="read-progress-fill" style="width:${Math.round(book.readProgress)}%"></div></div><span class="read-progress-label">${Math.round(book.readProgress)}%</span></div>` : ''}
      ${readActions
        ? `<div class="card-actions card-actions-read"><a class="button button-primary download-menu-trigger-compact" href="${readPagePath(book.id)}">${escapeHtml(uiT('home.heroReadBook'))}</a></div>`
        : downloadMenu ? `<div class="card-actions">${downloadMenu}</div>` : ''}
    </div>
  </article>`;
}

function renderListRowHtml(book, { batchSelect = false } = {}) {
  const id = escapeHtml(book.id);
  const title = escapeHtml(book.title || '');
  const ext = escapeHtml(String(book.ext || 'fb2').toUpperCase());
  const rate = Math.max(0, Math.min(5, Math.floor(Number(book.libRate) || 0)));
  const rating = rate ? `<span class="author-flibusta-rating" title="${rate}">${'★'.repeat(rate)}</span>` : '';
  const authorHtml = book.authors
    ? `<span class="author-flibusta-author muted">${uiRenderAuthorLinks(book.authorsList, book.authors, `ajax-list-a-${book.id}`)}</span>`
    : `<span class="author-flibusta-author muted">${escapeHtml(uiT('book.authorUnknown'))}</span>`;
  const batchCb = batchSelect
    ? `<label class="author-flibusta-batch" title="${escapeHtml(uiT('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" id="batch-select-${safeDomIdPart(book.id)}" name="batch-select-${safeDomIdPart(book.id)}" ${bookIdNeedsSafeUrl(book.id) ? `data-batch-book-id-ref="${escapeHtml(encodeBookRef(book.id))}"` : `data-batch-book-id="${id}"`} aria-label="${escapeHtml(uiT('batch.selectAria'))}"></label>`
    : '';
  const sourceFormat = String(book.ext || 'fb2').toLowerCase();
  const formats =
    Array.isArray(book.downloadFormats) && book.downloadFormats.length
      ? book.downloadFormats.map((x) => [x.format, x.label])
      : sourceFormat === 'fb2'
        ? [['fb2', 'FB2'], ['epub2', 'EPUB']]
        : [[sourceFormat, sourceFormat.toUpperCase()]];
  const downloadMenu =
    isPageDownloadAllowed() && formats.length
      ? formats.length === 1
        ? `<a class="button download-menu-trigger download-menu-trigger-compact download-direct-link" href="${downloadBookPath(book.id, `format=${encodeURIComponent(formats[0][0])}`)}">${escapeHtml(uiT('download.label'))}</a>`
        : `<details class="download-menu download-menu-compact">
      <summary class="button download-menu-trigger download-menu-trigger-compact">${escapeHtml(uiT('download.label'))}</summary>
      <div class="download-menu-popover">${formats.map(([f, l]) => `<a class="download-format-link" href="${downloadBookPath(book.id, `format=${encodeURIComponent(f)}`)}">${escapeHtml(l)}</a>`).join('')}</div>
    </details>`
      : '';
  const dl = downloadMenu ? `<span class="author-flibusta-dl">${downloadMenu}</span>` : '';
  const cardRef = encodeBookRef(book.id);
  const bookRefAttr = bookIdNeedsSafeUrl(book.id)
    ? `data-book-id-ref="${escapeHtml(cardRef)}"`
    : `data-book-id-ref="${escapeHtml(cardRef)}" data-book-id="${id}"`;
  const readBtn = `<a class="button author-flibusta-read" href="${readPagePath(book.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(uiT('book.read'))}</a>`;
  const emailBtn = isPageEmailSendAllowed()
    ? `<button class="button author-flibusta-email" type="button" ${bookRefAttr} data-send-to-ereader="1">${escapeHtml(uiT('book.toEmail'))}</button>`
    : '';
  const actions = `<span class="author-flibusta-actions">${readBtn}${dl}${emailBtn}</span>`;
  const cardAttrs = bookRefAttr;
  return `<li class="author-flibusta-book" ${cardAttrs}>
    ${batchCb}<a class="author-flibusta-title" href="${bookPagePath(book.id)}">${title}</a>
    ${authorHtml}${rating}<span class="muted author-flibusta-meta">${ext}</span>${actions}
  </li>`;
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
  const listMode = container.dataset.loadMoreMode === 'list';
  // Определяем контекст серии из URL API для корректного рендеринга карточек
  let seriesContext = null;
  try {
    const apiUrl = new URL(api, window.location.href);
    if (apiUrl.searchParams.get('facet') === 'series') {
      seriesContext = apiUrl.searchParams.get('value') || null;
    }
  } catch (_) { /* ignore */ }

    const activeFetches = new Set();
  window.addEventListener('pagehide', () => {
    for (const ctrl of activeFetches) { try { ctrl.abort(); } catch {} }
    activeFetches.clear();
  }, { once: true });

  const skeletonHtml = Array.from({ length: 6 }, () => '<div class="skeleton-card"><div class="skeleton-cover"></div><div class="skeleton-line"></div><div class="skeleton-line skeleton-line-short"></div></div>').join('');

  trigger.addEventListener('click', async () => {
    for (const ctrl of activeFetches) { try { ctrl.abort(); } catch {} }
    activeFetches.clear();
    const activeFetch = new AbortController();
    activeFetches.add(activeFetch);
    const { signal } = activeFetch;
    page++;
    trigger.disabled = true;
    trigger.textContent = `${uiT('catalog.loadMore')}...`;
    const grid = listMode ? null : container.querySelector('.grid');
    const list = listMode ? container.querySelector('.author-flibusta-books') : null;
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
      if (listMode && list && data.items?.length) {
        const existingIds = new Set(
          [...list.querySelectorAll('.author-flibusta-book[data-book-id-ref], .author-flibusta-book[data-book-id]')]
            .map((row) => (typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(row) : row.getAttribute('data-book-id')))
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
        tmp.innerHTML = nextItems.map((b) => renderListRowHtml(b, { batchSelect })).join('');
        const newRows = [...tmp.children];
        for (const row of newRows) list.appendChild(row);
        for (const row of newRows) attachDownloadMenus(row);
        if (batchSelect) {
          const scope = container.closest('.batch-select-scope');
          updateBatchCountForScope(scope);
        }
      } else if (grid && data.items?.length) {
        const existingIds = new Set(
          [...grid.querySelectorAll('.card[data-book-id-ref], .card[data-book-id]')]
            .map((card) => (typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(card) : card.getAttribute('data-book-id')))
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
        tmp.innerHTML = nextItems.map((b) => renderCardHtml(b, { batchSelect, seriesContext })).join('');
        const newCards = [...tmp.children];
        for (const card of newCards) grid.appendChild(card);

        const MAX_VISIBLE_CARDS = 500;
        const allCards = grid.querySelectorAll('.card');
        if (allCards.length > MAX_VISIBLE_CARDS) {
          const excess = allCards.length - MAX_VISIBLE_CARDS;
          const toRemove = [...allCards].slice(0, excess);
          for (const el of toRemove) el.remove();
        }

        for (const card of newCards) attachCoverErrorFallback(card);
        for (const card of newCards) attachDownloadMenus(card);
        loadCardDetails(newCards);
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
    } finally {
      activeFetches.delete(activeFetch);
    }
  });
}

function getBatchZipMax() {
  const n = Number(document.body?.dataset?.batchZipMax);
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

function collectCheckedBatchBookIds(scope) {
  if (!scope) return [];
  return [
    ...new Set(
      [...scope.querySelectorAll('input.batch-select-cb')]
        .filter((c) => c.checked)
        .map((c) => (typeof resolveBatchBookIdFromElement === 'function' ? resolveBatchBookIdFromElement(c) : (c.getAttribute('data-batch-book-id') || c.closest('.card')?.dataset.bookId)))
        .filter(Boolean)
    )
  ];
}

function findBatchFabForScope(scopeEl) {
  if (!scopeEl) return null;
  const scopeId = scopeEl.dataset.batchScopeId;
  if (scopeId) {
    const moved = document.querySelector(`[data-batch-fab][data-batch-scope-id="${scopeId}"]`);
    if (moved) return moved;
  }
  return scopeEl.querySelector('[data-batch-fab]');
}

function ensureBatchFabOnBody(scopeEl) {
  if (!scopeEl) return null;
  let fab = scopeEl.querySelector('[data-batch-fab]');
  if (!fab) return findBatchFabForScope(scopeEl);
  if (!scopeEl.dataset.batchScopeId) {
    scopeEl.dataset.batchScopeId = `bs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }
  const scopeId = scopeEl.dataset.batchScopeId;
  fab.dataset.batchScopeId = scopeId;
  if (fab.parentElement !== document.body) {
    document.body.appendChild(fab);
  }
  return fab;
}

function updateBatchCountForScope(scopeEl) {
  if (!scopeEl) return;
  const fab = ensureBatchFabOnBody(scopeEl) || findBatchFabForScope(scopeEl);
  const countEl = (fab || scopeEl).querySelector('[data-batch-selected-count]');
  const cbs = [...scopeEl.querySelectorAll('input.batch-select-cb')];
  const n = cbs.filter((c) => c.checked).length;
  if (countEl) {
    if (n === 0) {
      countEl.textContent = '';
      countEl.hidden = true;
    } else {
      countEl.hidden = false;
      countEl.textContent = uiTp('app.batchSelected', { n });
    }
  }
  if (fab) {
    const show = n > 0;
    if (show) {
      fab.hidden = false;
      fab.classList.add('is-visible');
    } else {
      fab.classList.remove('is-visible');
      fab.hidden = true;
      for (const details of fab.querySelectorAll('details[open]')) details.removeAttribute('open');
    }
    fab.setAttribute('aria-hidden', show ? 'false' : 'true');
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
    const row = cb.closest('.card, .author-flibusta-book, .author-facet-standalone-row');
    const host = row || cb;
    return host.offsetParent !== null && host.style.display !== 'none';
  });
}

function syncAuthorFlibustaSeriesCheckboxes(scopeEl) {
  if (!scopeEl) return;
  for (const group of scopeEl.querySelectorAll('.author-flibusta-group')) {
    const seriesCb = group.querySelector('input.author-flibusta-series-cb');
    if (!seriesCb) continue;
    const bookCbs = [...group.querySelectorAll('input.batch-select-cb')];
    if (!bookCbs.length) {
      seriesCb.checked = false;
      seriesCb.indeterminate = false;
      continue;
    }
    const checked = bookCbs.filter((c) => c.checked).length;
    seriesCb.checked = checked > 0 && checked === bookCbs.length;
    seriesCb.indeterminate = checked > 0 && checked < bookCbs.length;
  }
}

function startNativeBatchZipDownload(body) {
  const params = new URLSearchParams();
  if (body.format) params.set('format', String(body.format));
  if (Array.isArray(body.ids) && body.ids.length) params.set('ids', body.ids.join(','));
  if (body.shelf != null) params.set('shelf', String(body.shelf));
  if (body.facet) params.set('facet', String(body.facet));
  if (body.value != null) params.set('value', String(body.value));
  if (body.perBookZip) params.set('perBookZip', '1');
  const qs = params.toString();
  if (qs.length <= 1800) {
    const a = document.createElement('a');
    a.href = `/download/batch?${qs}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/download/batch';
  form.style.display = 'none';
  const add = (name, value) => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = String(value);
    form.appendChild(input);
  };
  if (body.format) add('format', body.format);
  if (Array.isArray(body.ids) && body.ids.length) add('ids', body.ids.join(','));
  if (body.shelf != null) add('shelf', body.shelf);
  if (body.facet) add('facet', body.facet);
  if (body.value != null) add('value', body.value);
  if (body.perBookZip) add('perBookZip', '1');
  const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
  if (csrf) add('_csrf', csrf);
  document.body.appendChild(form);
  form.submit();
  form.remove();
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

    const scope = toolbar.closest('.batch-select-scope')
      || (toolbar.closest('[data-batch-fab]') && document.querySelector(
        `.batch-select-scope[data-batch-scope-id="${toolbar.closest('[data-batch-fab]').dataset.batchScopeId || ''}"]`
      ));
    if (scope) ensureBatchFabOnBody(scope);

    toolbar.querySelector('[data-batch-select-all]')?.addEventListener('click', () => {
      if (!scope) return;
      const visible = getVisibleBatchCheckboxesInScope(scope);
      const zipMax = getBatchZipMax();
      let k = 0;
      for (const cb of visible) {
        if (k >= zipMax) break;
        cb.checked = true;
        k++;
      }
      if (visible.length > zipMax) {
        showToast(uiTp('app.batchMarkMax', { n: zipMax }), 'info');
      }
      syncAuthorFlibustaSeriesCheckboxes(scope);
      updateBatchCountForScope(scope);
    });

    toolbar.querySelector('[data-batch-toggle-select]')?.addEventListener('click', () => {
      if (!scope) return;
      const checkedNow = [...scope.querySelectorAll('input.batch-select-cb')].filter((c) => c.checked).length;
      if (checkedNow > 0) {
        for (const cb of scope.querySelectorAll('input.batch-select-cb')) cb.checked = false;
      } else {
        for (const cb of scope.querySelectorAll('input.batch-select-cb')) cb.checked = false;
        const visible = getVisibleBatchCheckboxesInScope(scope);
        const zipMax = getBatchZipMax();
        let k = 0;
        for (const cb of visible) {
          if (k >= zipMax) break;
          cb.checked = true;
          k++;
        }
        if (visible.length > zipMax) {
          showToast(uiTp('app.batchMarkMax', { n: zipMax }), 'info');
        }
      }
      syncAuthorFlibustaSeriesCheckboxes(scope);
      updateBatchCountForScope(scope);
    });

    toolbar.querySelector('[data-batch-clear-select]')?.addEventListener('click', () => {
      if (!scope) return;
      for (const cb of scope.querySelectorAll('input.batch-select-cb')) cb.checked = false;
      syncAuthorFlibustaSeriesCheckboxes(scope);
      updateBatchCountForScope(scope);
    });

    toolbar.addEventListener('click', (e) => {
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
      const zipMax = getBatchZipMax();
      if (ids.length > zipMax) {
        showToast(uiTp('app.batchDownloadMax', { n: zipMax }), 'error');
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
      startNativeBatchZipDownload(body);
      showToast(uiT('app.batchDownloadStarted'), 'info');
      const details = btn.closest('details');
      if (details) details.removeAttribute('open');
    });

    if (scope) updateBatchCountForScope(scope);
  });

  document.addEventListener('change', (e) => {
    if (!e.target || !e.target.classList) return;
    const scope = e.target.closest('.batch-select-scope');

    if (e.target.classList.contains('author-flibusta-series-cb')) {
      const group = e.target.closest('.author-flibusta-group');
      if (!group || !scope) return;
      const bookCbs = [...group.querySelectorAll('input.batch-select-cb')];
      const selectedInGroup = bookCbs.filter((c) => c.checked).length;
      /*
       * Partial select (e.g. series over the ZIP cap) leaves the series box indeterminate.
       * A click then becomes checked=true, which used to try selecting again and
       * made it impossible to clear. Any selection in the group → clear; none → select.
       */
      const clearGroup = selectedInGroup > 0;
      e.target.indeterminate = false;
      if (clearGroup) {
        for (const cb of bookCbs) cb.checked = false;
      } else {
        let checkedInScope = [...scope.querySelectorAll('input.batch-select-cb')]
          .filter((c) => c.checked).length;
        const zipMax = getBatchZipMax();
        let marked = 0;
        for (const cb of bookCbs) {
          if (cb.checked) continue;
          if (checkedInScope >= zipMax) {
            if (marked === 0) {
              showToast(uiTp('app.batchDownloadMaxShort', { n: zipMax }), 'error');
            } else {
              showToast(uiTp('app.batchMarkMax', { n: zipMax }), 'info');
            }
            break;
          }
          cb.checked = true;
          checkedInScope += 1;
          marked += 1;
        }
      }
      syncAuthorFlibustaSeriesCheckboxes(scope);
      updateBatchCountForScope(scope);
      return;
    }

    if (!e.target.classList.contains('batch-select-cb')) return;
    if (e.target.checked && scope) {
      const checked = [...scope.querySelectorAll('input.batch-select-cb')].filter((c) => c.checked).length;
      const zipMax = getBatchZipMax();
      if (checked > zipMax) {
        e.target.checked = false;
        showToast(uiTp('app.batchDownloadMaxShort', { n: zipMax }), 'error');
      }
    }
    syncAuthorFlibustaSeriesCheckboxes(scope);
    updateBatchCountForScope(scope);
  });
}

/**
 * Страницы /facet/* часто попадают в bfcache при «назад» из книги/серии.
 * Вместо полной перезагрузки сбрасываем состояние кнопки «ещё» и переподписываем
 * обработчики — bfcache восстанавливает DOM мгновенно, а fetch-переменные
 * остаются прерванными (abort при pagehide).
 */
function attachBfCacheFacetReload() {
  window.addEventListener('pageshow', (ev) => {
    if (!ev.persisted) return;
    const p = window.location.pathname || '';
    if (p.startsWith('/facet/')) {
      const trigger = document.querySelector('[data-load-more-trigger]');
      if (trigger) {
        trigger.disabled = false;
        trigger.dataset.loadMoreBound = '';
      }
      attachLoadMore();
      loadCardDetails();
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
                <div class="modal-list-item-content">
                  <input type="checkbox" id="shelf-toggle-${safeDomIdPart(s.id)}" name="shelfToggle_${safeDomIdPart(s.id)}" value="${escapeHtml(String(s.id))}" data-shelf-toggle="${s.id}" ${s.hasBook ? 'checked' : ''}>
                  <span>${escapeHtml(s.name)}</span>
                </div>
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
        beforeClose: async () => {
          const root = document.querySelector('.modal-overlay');
          if (!root) return true;
          const dirty = [...root.querySelectorAll('[data-shelf-toggle]')].some((cb) => {
            const id = String(cb.dataset.shelfToggle);
            return cb.checked !== (initialShelfState.get(id) ?? false);
          });
          if (!dirty) return true;
          return confirmAction(uiT('app.closeWithoutSave'), { danger: false });
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
      const bookId = typeof resolveBookIdFromElement === 'function' ? resolveBookIdFromElement(btn) : (btn.dataset.addToShelf ? decodeURIComponent(btn.dataset.addToShelf).replace(/\uFFFD/g, '\0') : null);
      if (!bookId) return;
      await openAddToShelfPicker([bookId]);
    });
  }
}

function attachSendToEreader() {
  if (attachSendToEreader._bound) return;
  attachSendToEreader._bound = true;

  document.addEventListener('click', async (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-send-to-ereader]') : null;
    if (!btn) return;
    // Batch format buttons use a different handler.
    if (btn.hasAttribute('data-batch-email-format')) return;

    const bookId = typeof resolveBookIdFromElement === 'function'
      ? resolveBookIdFromElement(btn)
      : (btn.dataset.sendToEreader ? decodeURIComponent(btn.dataset.sendToEreader).replace(/\uFFFD/g, '\0') : null);
    if (!bookId) return;

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

      overlay.querySelector('[data-ereader-form]').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const format = overlay.querySelector('select[name="format"]').value;
        const submitBtn = overlay.querySelector('.modal-form-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = uiT('app.emailSending');
        try {
          const res = await fetch(apiSendToEreaderPath(bookId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ format }) });
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

    const fab = menu.closest('[data-batch-fab]');
    const scope = menu.closest('.batch-select-scope')
      || (fab?.dataset.batchScopeId
        ? document.querySelector(`.batch-select-scope[data-batch-scope-id="${fab.dataset.batchScopeId}"]`)
        : null);
    if (!scope) return;

    let ctx;
    try {
      ctx = JSON.parse(menu.dataset.batchEreaderParams || '{}');
    } catch {
      return;
    }

    const ids = [...scope.querySelectorAll('input.batch-select-cb')]
      .filter((c) => c.checked)
      .map((c) => (typeof resolveBatchBookIdFromElement === 'function' ? resolveBatchBookIdFromElement(c) : (c.getAttribute('data-batch-book-id') || c.closest('.card')?.dataset.bookId)))
      .filter(Boolean);
    if (!ids.length) {
      showToast(uiT('app.batchSelectAtLeastOne'), 'error');
      return;
    }
    const zipMax = getBatchZipMax();
    if (ids.length > zipMax) {
      showToast(uiTp('app.batchEmailMax', { n: zipMax }), 'error');
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

  async function pollUpdateLog(activeBtn = startBtn) {
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
      activeBtn.textContent = uiT('app.restarting');
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
      activeBtn.textContent = uiT('app.error');
      showToast(uiT('app.backupDoneError'), 'error');
      setTimeout(() => {
        startBtn.disabled = false;
        fileInput.disabled = false;
        startBtn.textContent = uiT('app.backupBtnUpdate');
      }, 3000);
    } else {
      activeBtn.textContent = uiT('app.restarting');
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

  // --- Проверка новой версии на GitHub + установка в один клик ---
  const checkBtn = document.getElementById('update-check-btn');
  const applyBtn = document.getElementById('update-apply-btn');
  const checkStatus = document.getElementById('update-check-status');
  let updateInfo = null;

  async function runUpdateCheck(force) {
    if (checkBtn) checkBtn.disabled = true;
    if (applyBtn) applyBtn.style.display = 'none';
    if (checkStatus) checkStatus.textContent = uiT('app.updateChecking');
    try {
      const r = await fetch('/api/operations/update-check' + (force ? '?force=1' : ''), { credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      updateInfo = data;
      if (!checkStatus) return;
      if (data.updateAvailable) {
        checkStatus.textContent = uiTp('app.updateAvailable', { v: data.latestVersion }) + ' ';
        if (data.releaseUrl) {
          const link = document.createElement('a');
          link.href = data.releaseUrl;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = uiT('app.updateNotesLink');
          checkStatus.appendChild(link);
        }
        if (applyBtn) {
          applyBtn.textContent = uiTp('app.updateInstallBtn', { v: data.latestVersion });
          applyBtn.style.display = '';
          applyBtn.disabled = false;
        }
      } else {
        checkStatus.textContent = uiTp('app.updateUpToDate', { v: data.currentVersion });
      }
    } catch (error) {
      updateInfo = null;
      if (checkStatus) checkStatus.textContent = uiT('app.updateCheckFail') + ': ' + error.message;
    } finally {
      if (checkBtn) checkBtn.disabled = false;
    }
  }

  if (checkBtn) {
    checkBtn.addEventListener('click', () => runUpdateCheck(true));
    runUpdateCheck(false);
  }

  if (applyBtn) {
    applyBtn.addEventListener('click', async () => {
      if (!updateInfo || !updateInfo.updateAvailable) return;
      if (!await confirmAction(uiTp('app.updateApplyConfirm', { v: updateInfo.latestVersion }))) return;

      applyBtn.disabled = true;
      if (checkBtn) checkBtn.disabled = true;
      startBtn.disabled = true;
      fileInput.disabled = true;
      if (progressWrap) progressWrap.style.display = 'block';
      if (progressBar) progressBar.style.width = '10%';
      if (logPre) logPre.textContent = '';

      try {
        const csrf = getCsrfTokenFromPage();
        const r = await fetch('/api/operations/update-apply', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
          body: '{}'
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
        applyBtn.textContent = uiT('app.backupBtnUpdating');
        pollUpdateLog(applyBtn);
      } catch (error) {
        showToast(uiT('app.backupStartFail') + ': ' + error.message, 'error');
        applyBtn.disabled = false;
        if (checkBtn) checkBtn.disabled = false;
        startBtn.disabled = false;
        fileInput.disabled = false;
      }
    });
  }
}

function attachUiAppearanceUpload() {
  const page = document.querySelector('[data-ui-appearance-page]');
  if (!page) return;

  async function uploadUiAsset(asset, file, statusEl) {
    if (!file) return;
    if (statusEl) statusEl.textContent = uiT('admin.ui.uploading');
    try {
      const csrf = getCsrfTokenFromPage();
      const resp = await fetch(`/api/admin/ui/upload?asset=${encodeURIComponent(asset)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(asset === 'font' && file.name ? { 'X-Ui-Asset-Name': encodeURIComponent(file.name) } : {}),
        },
        body: file,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || uiT('admin.ui.uploadFailed'));
      applyUiAssetState(asset, data.ui || {}, data.appearance);
      if (statusEl) statusEl.textContent = uiT('admin.ui.uploadAutoHint');
      showToast(uiT('admin.ui.uploadOk'), 'success');
    } catch (error) {
      if (statusEl) statusEl.textContent = uiT('admin.ui.uploadAutoHint');
      showToast(error.message || uiT('admin.ui.uploadFailed'), 'error');
    }
  }

  async function removeUiAssetClient(asset) {
    try {
      const csrf = getCsrfTokenFromPage();
      const resp = await fetch('/api/admin/ui/remove', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({ asset }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || uiT('admin.ui.uploadFailed'));
      applyUiAssetState(asset, data.ui || {}, data.appearance);
      showToast(uiT('admin.ui.flashRemoved'), 'success');
    } catch (error) {
      showToast(error.message || uiT('admin.ui.uploadFailed'), 'error');
    }
  }

  function syncBrandLogos(logoUrl) {
    const src = logoUrl || '/logo.png';
    document.querySelectorAll('.brand-logo').forEach((img) => {
      if (img instanceof HTMLImageElement) img.src = src;
    });
  }

  function syncBackgroundSections(hasBackground) {
    page.querySelector('[data-ui-bg-section]')?.toggleAttribute('hidden', !hasBackground);
    page.querySelector('[data-ui-bg-palette-wrap]')?.toggleAttribute('hidden', !hasBackground);
    const dynamic = page.querySelector('[name="dynamicThemeFromBg"]');
    if (dynamic) {
      dynamic.disabled = !hasBackground;
      if (!hasBackground) dynamic.checked = false;
    }
    syncDynamicBaseColorInputs();
  }

  function applyUiAssetState(asset, ui, appearance) {
    const block = page.querySelector(`[data-ui-upload-status="${asset}"]`)?.closest('.ui-asset-block')
      || page.querySelector(`#ui-${asset}-input`)?.closest('.admin-field-group, .ui-asset-block, .ui-font-upload-toolbar');
    const preview = block?.querySelector('.ui-asset-block-preview, .ui-font-preview-wrap');
    const removeForm = block?.querySelector('.ui-asset-remove-form');

    if (asset === 'logo') {
      if (preview) {
        preview.innerHTML = ui.logoUrl
          ? `<img src="${escapeHtml(ui.logoUrl)}" alt="" class="ui-asset-preview">`
          : `<span class="muted">${escapeHtml(uiT('admin.ui.defaultAsset'))}</span>`;
      }
      if (removeForm) removeForm.hidden = !ui.hasLogo;
      syncBrandLogos(ui.logoUrl);
      schedulePreview();
      return;
    }
    if (asset === 'favicon') {
      if (preview) {
        preview.innerHTML = ui.faviconUrl
          ? `<img src="${escapeHtml(ui.faviconUrl)}" alt="" class="ui-asset-preview ui-asset-preview--favicon">`
          : `<span class="muted">${escapeHtml(uiT('admin.ui.defaultAsset'))}</span>`;
      }
      if (removeForm) removeForm.hidden = !ui.faviconUrl;
      schedulePreview();
      return;
    }
    if (asset === 'background') {
      if (preview) {
        preview.innerHTML = ui.backgroundUrl
          ? `<img src="${escapeHtml(ui.backgroundUrl)}" alt="" class="ui-asset-preview ui-asset-preview--bg">`
          : `<span class="muted">${escapeHtml(uiT('admin.ui.noBackground'))}</span>`;
      }
      if (removeForm) removeForm.hidden = !ui.hasBackground;
      syncBackgroundSections(Boolean(ui.hasBackground));
      schedulePreview();
      return;
    }
    if (asset === 'font') {
      const fontWrap = block?.querySelector('.ui-font-upload-preview');
      if (fontWrap) {
        fontWrap.innerHTML = ui.hasCustomFont
          ? `<div class="ui-font-preview">${escapeHtml(uiT('admin.ui.fontPreviewSample'))}</div>`
          : `<span class="muted">${escapeHtml(uiT('admin.ui.fontCustomEmpty'))}</span>`;
      }
      if (removeForm) removeForm.hidden = !ui.hasCustomFont;
      const fontFamily = page.querySelector('[name="fontFamily"]');
      if (fontFamily && ui.fontFamily) fontFamily.value = ui.fontFamily;
      if (appearance) {
        applyTypographyState(appearance);
        updateResetWraps(appearance);
        patchDirtyFormBaseline('ui-main-form', 'typography');
      }
      schedulePreview();
    }
  }

  page.querySelectorAll('.ui-asset-remove-form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const asset = form.querySelector('[name="asset"]')?.value;
      if (asset) removeUiAssetClient(String(asset));
    });
  });

  page.querySelectorAll('input[data-ui-asset]').forEach((input) => {
    const asset = input.dataset.uiAsset;
    const statusEl = page.querySelector(`[data-ui-upload-status="${asset}"]`);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) uploadUiAsset(asset, file, statusEl);
    });
  });

  function previewGlassFillOpacity(hex, surfaceOpacity, isLight) {
    const opacity = Number(surfaceOpacity);
    const base = Number.isFinite(opacity) ? opacity : 88;
    if (!isLight) return base;
    return Math.max(0, base - 14);
  }

  function buildPreviewPanelBackground(hex, surfaceOpacity, isLight) {
    const panelOpacity = previewGlassFillOpacity(hex, surfaceOpacity, isLight);
    const surface = String(hex || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(surface)) {
      return `color-mix(in srgb, ${surface || '#f7f4ef'} ${panelOpacity}%, transparent)`;
    }
    return `color-mix(in srgb, ${surface} ${panelOpacity}%, transparent)`;
  }

  function derivePreviewPalette(hex, surfaceOpacity) {
    const h = String(hex || '').replace('#', '');
    if (h.length !== 6) return { text: '#ece6dc', muted: '#a89888', link: '#d4ac5c' };
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const linear = [r, g, b].map((c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const lum = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    const isDark = lum < 0.45;
    const mixHex = (aHex, bHex, weightB) => {
      const w = Math.min(1, Math.max(0, weightB));
      const ar = parseInt(aHex.slice(1, 3), 16);
      const ag = parseInt(aHex.slice(3, 5), 16);
      const ab = parseInt(aHex.slice(5, 7), 16);
      const br = parseInt(bHex.slice(1, 3), 16);
      const bg = parseInt(bHex.slice(3, 5), 16);
      const bb = parseInt(bHex.slice(5, 7), 16);
      const toHex = (v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0');
      return `#${toHex(ar * (1 - w) + br * w)}${toHex(ag * (1 - w) + bg * w)}${toHex(ab * (1 - w) + bb * w)}`;
    };
    const base = {
      text: isDark ? '#ece6dc' : '#2a2218',
      muted: isDark ? '#a89888' : '#6e5e4c',
      link: isDark ? '#d4ac5c' : '#8b5a12',
    };
    const opacity = Number(surfaceOpacity);
    if (isDark || !Number.isFinite(opacity) || opacity >= 58) return base;
    const factor = (58 - opacity) / 58;
    return {
      text: mixHex(base.text, '#000000', factor * 0.22),
      muted: mixHex(base.muted, '#000000', factor * 0.12),
      link: base.link,
    };
  }

  function readSurfaceOpacity() {
    const input = page.querySelector('#ui-surface-opacity');
    const value = Number(input?.value);
    return Number.isFinite(value) ? value : 88;
  }

  function syncGlassPreview(theme) {
    const panel = page.querySelector(`[data-ui-glass-preview-panel="${theme}"]`);
    const glassInput = page.querySelector(`[data-ui-glass-color="${theme}"]`);
    if (!panel || !glassInput) return;
    const surfaceOpacity = readSurfaceOpacity();
    const derived = derivePreviewPalette(glassInput.value, surfaceOpacity);
    panel.style.background = buildPreviewPanelBackground(glassInput.value, surfaceOpacity, theme === 'light');
    const autoFieldByRole = {
      text: theme === 'dark' ? 'glassTextAutoDark' : 'glassTextAutoLight',
      muted: theme === 'dark' ? 'glassMutedAutoDark' : 'glassMutedAutoLight',
      link: theme === 'dark' ? 'glassLinkAutoDark' : 'glassLinkAutoLight',
    };
    page.querySelectorAll(`[data-ui-glass-pick-input][data-ui-glass-pick-theme="${theme}"]`).forEach((input) => {
      const role = input.dataset.uiGlassPickInput;
      const auto = input.dataset.uiGlassAuto === '1';
      if (auto) input.value = derived[role] || input.value;
      const span = input.closest('.ui-glass-preview-pick')?.querySelector('span');
      if (role === 'text') {
        panel.style.color = input.value;
        panel.style.textShadow = '';
      } else if (span) {
        span.style.color = input.value;
      }
    });
    Object.entries(autoFieldByRole).forEach(([role, fieldName]) => {
      const input = page.querySelector(`[data-ui-glass-pick-input="${role}"][data-ui-glass-pick-theme="${theme}"]`);
      const autoEl = page.querySelector(`[name="${fieldName}"]`);
      if (autoEl && input) autoEl.value = input.dataset.uiGlassAuto === '1' ? '1' : '0';
    });
  }

  function syncGlassHex(input) {
    if (!input?.name) return;
    const hexEl = page.querySelector(`[data-ui-glass-hex="${input.name}"]`);
    if (hexEl) hexEl.textContent = input.value;
  }

  page.querySelectorAll('[data-ui-glass-color]').forEach((input) => {
    input.addEventListener('input', () => {
      syncGlassHex(input);
      syncGlassPreview(input.dataset.uiGlassColor);
      setResetWrapVisible('colors', true);
      schedulePreview();
    });
  });
  page.querySelectorAll('[data-ui-glass-pick-input]').forEach((input) => {
    input.addEventListener('input', () => {
      input.dataset.uiGlassAuto = '0';
      syncGlassPreview(input.dataset.uiGlassPickTheme);
      setResetWrapVisible('colors', true);
      schedulePreview();
    });
  });
  ['dark', 'light'].forEach((theme) => {
    syncGlassPreview(theme);
    const glassInput = page.querySelector(`[data-ui-glass-color="${theme}"]`);
    if (glassInput) syncGlassHex(glassInput);
  });

  function syncDynamicBaseColorInputs() {
    const dynamic = page.querySelector('[name="dynamicThemeFromBg"]')?.checked;
    page.querySelectorAll('[data-ui-glass-color]').forEach((input) => {
      input.disabled = Boolean(dynamic);
    });
  }

  page.querySelector('[name="dynamicThemeFromBg"]')?.addEventListener('change', () => {
    syncDynamicBaseColorInputs();
    setResetWrapVisible('colors', true);
    schedulePreview();
  });
  syncDynamicBaseColorInputs();

  // ── Live preview (apply draft to the page without saving) ──
  const mainForm = document.getElementById('ui-main-form');
  const previewBar = page.querySelector('[data-ui-preview-bar]');
  let previewStyleEl = null;
  let previewFontLink = null;
  let previewTimer = 0;
  let showPreviewBar = false;

  function ensurePreviewStyle() {
    if (!previewStyleEl) {
      previewStyleEl = document.createElement('style');
      previewStyleEl.id = 'ui-live-preview';
      document.head.appendChild(previewStyleEl);
    }
    return previewStyleEl;
  }

  function setRootAttr(name, on) {
    if (on) document.documentElement.setAttribute(name, '1');
    else document.documentElement.removeAttribute(name);
  }

  function applyPreview(data, { showBar = false } = {}) {
    if (!data || !Array.isArray(data.vars)) return;
    ensurePreviewStyle().textContent = `:root{${data.vars.join(';')}}`;
    const attrs = data.attrs || {};
    setRootAttr('data-ui-theme', attrs.theme);
    setRootAttr('data-ui-sliders', attrs.sliders);
    setRootAttr('data-ui-bg', attrs.bg);
    setRootAttr('data-ui-shape', attrs.shape);
    setRootAttr('data-ui-typography', attrs.typography);
    if (data.webfont) {
      const family = String(data.webfont).split(':')[0].replace(/\s+/g, '+');
      const href = `https://fonts.googleapis.com/css2?family=${family}:wght@400;600;700&display=swap`;
      if (!previewFontLink) {
        previewFontLink = document.createElement('link');
        previewFontLink.rel = 'stylesheet';
        previewFontLink.id = 'ui-preview-font';
        document.head.appendChild(previewFontLink);
      }
      if (previewFontLink.href !== href) previewFontLink.href = href;
    }
    if (previewBar) previewBar.hidden = !showBar;
  }

  function collectDraft() {
    const draft = {};
    if (!mainForm) return draft;
    page.querySelectorAll('[form="ui-main-form"]').forEach((el) => {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
      const name = el.name;
      if (!name) return;
      if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox') {
          draft[name] = el.checked ? (el.value || '1') : '0';
        } else if (el.type === 'radio') {
          if (el.checked) draft[name] = el.value;
        } else if (!el.disabled) {
          draft[name] = el.value;
        }
      } else if (!el.disabled) {
        draft[name] = el.value;
      }
    });
    return draft;
  }

  async function runPreview() {
    try {
      const csrf = getCsrfTokenFromPage();
      const resp = await fetch('/api/admin/ui/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify(collectDraft()),
      });
      if (!resp.ok) return;
      const data = await resp.json().catch(() => null);
      if (data && data.ok) applyPreview(data, { showBar: showPreviewBar });
    } catch { /* preview is best-effort */ }
  }

  function schedulePreview({ showBar = true } = {}) {
    if (showBar) showPreviewBar = true;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = window.setTimeout(runPreview, 120);
  }

  function setResetWrapVisible(section, visible) {
    const wrap = page.querySelector(`[data-ui-reset-wrap="${section}"]`);
    if (wrap) wrap.hidden = !visible;
  }

  // Radius scale field visibility follows the radius preset select.
  const radiusPresetSel = page.querySelector('[name="radiusPreset"]');
  const radiusScaleField = page.querySelector('[data-ui-radius-scale-field]');
  function syncRadiusScaleField() {
    if (radiusScaleField) radiusScaleField.hidden = radiusPresetSel?.value !== 'custom';
  }
  radiusPresetSel?.addEventListener('change', () => { syncRadiusScaleField(); setResetWrapVisible('shape', true); schedulePreview(); });
  syncRadiusScaleField();

  // Accent / overlay color: hex label + auto checkbox enable/disable.
  function bindAutoColor(colorSel, autoAttr, hexAttr, autoHiddenId, resetSection) {
    page.querySelectorAll(`[${colorSel}]`).forEach((input) => {
      const key = input.getAttribute(colorSel);
      const hexEl = page.querySelector(`[${hexAttr}="${key}"]`);
      input.addEventListener('input', () => {
        if (hexEl) hexEl.textContent = input.value;
        if (resetSection) setResetWrapVisible(resetSection, true);
        schedulePreview();
      });
    });
    page.querySelectorAll(`[${autoAttr}]`).forEach((chk) => {
      const key = chk.getAttribute(autoAttr);
      const colorInput = page.querySelector(`[${colorSel}="${key}"]`);
      const hidden = page.querySelector(`#${autoHiddenId}-${key}`);
      chk.addEventListener('change', () => {
        if (hidden) hidden.value = chk.checked ? '1' : '0';
        if (colorInput) colorInput.disabled = chk.checked;
        if (resetSection) setResetWrapVisible(resetSection, true);
        schedulePreview();
      });
    });
  }
  bindAutoColor('data-ui-accent', 'data-ui-accent-auto', 'data-ui-accent-hex', 'ui-accent-auto', 'colors');
  bindAutoColor('data-ui-overlay', 'data-ui-overlay-auto', 'data-ui-overlay-hex', 'ui-overlay-auto', 'sliders');

  page.querySelector('[name="shadowPreset"]')?.addEventListener('change', () => {
    setResetWrapVisible('shape', true);
    schedulePreview();
  });
  page.querySelectorAll('[name="fontFamily"], [name="fontSize"], [name="density"]').forEach((el) => {
    el.addEventListener('change', () => {
      setResetWrapVisible('typography', true);
      schedulePreview();
    });
  });

  // Theme presets: apply surface + accent to the color inputs, then preview.
  page.querySelectorAll('[data-ui-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = [
        { theme: 'dark', surface: btn.dataset.presetDark, accent: btn.dataset.presetAccentDark },
        { theme: 'light', surface: btn.dataset.presetLight, accent: btn.dataset.presetAccentLight },
      ];
      const dynamic = page.querySelector('[name="dynamicThemeFromBg"]');
      if (dynamic?.checked) { dynamic.checked = false; syncDynamicBaseColorInputs(); }
      for (const { theme, surface, accent } of map) {
        const glass = page.querySelector(`[data-ui-glass-color="${theme}"]`);
        if (glass && surface) {
          glass.disabled = false;
          glass.value = surface;
          syncGlassHex(glass);
          syncGlassPreview(theme);
        }
        const accentInput = page.querySelector(`[data-ui-accent="${theme}"]`);
        const accentAuto = page.querySelector(`[data-ui-accent-auto="${theme}"]`);
        const accentHidden = page.querySelector(`#ui-accent-auto-${theme}`);
        const accentHex = page.querySelector(`[data-ui-accent-hex="${theme}"]`);
        const hasAccent = accent && /^#[0-9a-fA-F]{6}$/.test(accent);
        if (accentInput) {
          accentInput.disabled = !hasAccent;
          if (hasAccent) accentInput.value = accent;
        }
        if (accentAuto) accentAuto.checked = !hasAccent;
        if (accentHidden) accentHidden.value = hasAccent ? '0' : '1';
        if (accentHex && hasAccent) accentHex.textContent = accent;
      }
      page.querySelectorAll('[data-ui-preset]').forEach((b) => b.classList.toggle('is-active', b === btn));
      setResetWrapVisible('colors', true);
      if (mainForm) mainForm.classList.add('is-dirty');
      schedulePreview();
    });
  });

  // All appearance controls (including those outside #ui-main-form via form=) trigger preview.
  page.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('[data-ui-appearance-page]') && target.form === mainForm) schedulePreview();
  });
  page.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.closest('[data-ui-appearance-page]') && target.form === mainForm) schedulePreview();
  });
  page.querySelector('#admin-site-name')?.addEventListener('input', schedulePreview);
  page.querySelector('#admin-home-subtitle')?.addEventListener('input', schedulePreview);

  page.querySelectorAll('input[type="range"]').forEach((input) => {
    const valueEl = page.querySelector(`[data-ui-range-value="${input.name}"]`);
    if (!valueEl) return;
    const syncDisplay = () => {
      valueEl.textContent = input.value;
      if (input.name === 'surfaceOpacity') {
        ['dark', 'light'].forEach((theme) => syncGlassPreview(theme));
      }
    };
    const sync = () => {
      syncDisplay();
      if (['bgBlur', 'bgOverlay', 'surfaceOpacity', 'surfaceBlur'].includes(input.name)) {
        setResetWrapVisible('sliders', true);
      }
      if (input.name === 'radiusScale') setResetWrapVisible('shape', true);
      if (input.name === 'headingScale') setResetWrapVisible('typography', true);
      schedulePreview();
    };
    input.addEventListener('input', sync);
    syncDisplay();
  });

  page.querySelectorAll('[name="bgSize"], [name="bgPosition"]').forEach((sel) => {
    sel.addEventListener('change', () => {
      setResetWrapVisible('sliders', true);
      schedulePreview();
    });
  });

  function setHiddenFlag(name, auto) {
    const el = page.querySelector(`[name="${name}"]`);
    if (el) el.value = auto ? '1' : '0';
  }

  function setRangeField(name, value) {
    const input = page.querySelector(`[form="ui-main-form"][name="${name}"]`);
    if (!input) return;
    input.value = value;
    page.querySelector(`[data-ui-range-value="${name}"]`)?.replaceChildren(String(value));
  }

  function setAccentOrOverlay(kind, theme, color, auto) {
    const colorSel = kind === 'accent' ? 'data-ui-accent' : 'data-ui-overlay';
    const autoSel = kind === 'accent' ? 'data-ui-accent-auto' : 'data-ui-overlay-auto';
    const hexSel = kind === 'accent' ? 'data-ui-accent-hex' : 'data-ui-overlay-hex';
    const hiddenId = kind === 'accent' ? `ui-accent-auto-${theme}` : `ui-overlay-auto-${theme}`;
    const colorInput = page.querySelector(`[${colorSel}="${theme}"]`);
    const autoChk = page.querySelector(`[${autoSel}="${theme}"]`);
    const hidden = page.querySelector(`#${hiddenId}`);
    const hexEl = page.querySelector(`[${hexSel}="${theme}"]`);
    if (autoChk) autoChk.checked = auto;
    if (hidden) hidden.value = auto ? '1' : '0';
    if (colorInput) {
      colorInput.disabled = auto;
      if (!auto && color) colorInput.value = color;
    }
    if (hexEl && !auto && color) hexEl.textContent = color;
  }

  function setGlassPick(theme, role, color, auto) {
    const input = page.querySelector(`[data-ui-glass-pick-input="${role}"][data-ui-glass-pick-theme="${theme}"]`);
    if (!input) return;
    input.value = color;
    input.dataset.uiGlassAuto = auto ? '1' : '0';
  }

  function applySlidersState(st) {
    setRangeField('bgBlur', st.blur);
    setRangeField('bgOverlay', st.bgContrast);
    setRangeField('surfaceOpacity', st.surfaceOpacity);
    setRangeField('surfaceBlur', st.surfaceBlur);
    const bgSize = page.querySelector('[name="bgSize"]');
    if (bgSize) bgSize.value = st.bgSize;
    const bgPos = page.querySelector('[name="bgPosition"]');
    if (bgPos) bgPos.value = st.bgPosition;
    ['dark', 'light'].forEach((theme) => syncGlassPreview(theme));
  }

  function applyColorsState(st) {
    page.querySelectorAll('[data-ui-preset]').forEach((b) => b.classList.remove('is-active'));
    const dynamic = page.querySelector('[name="dynamicThemeFromBg"]');
    if (dynamic) dynamic.checked = Boolean(st.dynamicThemeFromBg);
    syncDynamicBaseColorInputs();
    for (const theme of ['dark', 'light']) {
      const glass = page.querySelector(`[data-ui-glass-color="${theme}"]`);
      const surface = theme === 'dark' ? st.glassColorDark : st.glassColorLight;
      if (glass && surface) {
        glass.value = surface;
        syncGlassHex(glass);
      }
      setGlassPick(theme, 'text', theme === 'dark' ? st.glassTextDark : st.glassTextLight, theme === 'dark' ? st.glassTextAutoDark : st.glassTextAutoLight);
      setGlassPick(theme, 'muted', theme === 'dark' ? st.glassMutedDark : st.glassMutedLight, theme === 'dark' ? st.glassMutedAutoDark : st.glassMutedAutoLight);
      setGlassPick(theme, 'link', theme === 'dark' ? st.glassLinkDark : st.glassLinkLight, theme === 'dark' ? st.glassLinkAutoDark : st.glassLinkAutoLight);
      setAccentOrOverlay('accent', theme, theme === 'dark' ? st.glassAccentDark : st.glassAccentLight, theme === 'dark' ? st.glassAccentAutoDark : st.glassAccentAutoLight);
      setAccentOrOverlay('overlay', theme, theme === 'dark' ? st.overlayColorDark : st.overlayColorLight, theme === 'dark' ? st.overlayColorAutoDark : st.overlayColorAutoLight);
    }
    setHiddenFlag('glassTextAutoDark', st.glassTextAutoDark);
    setHiddenFlag('glassTextAutoLight', st.glassTextAutoLight);
    setHiddenFlag('glassMutedAutoDark', st.glassMutedAutoDark);
    setHiddenFlag('glassMutedAutoLight', st.glassMutedAutoLight);
    setHiddenFlag('glassLinkAutoDark', st.glassLinkAutoDark);
    setHiddenFlag('glassLinkAutoLight', st.glassLinkAutoLight);
    ['dark', 'light'].forEach((theme) => syncGlassPreview(theme));
  }

  function applyShapeState(st) {
    const radiusPreset = page.querySelector('[name="radiusPreset"]');
    if (radiusPreset) radiusPreset.value = st.radiusPreset;
    setRangeField('radiusScale', st.radiusScale);
    const shadow = page.querySelector('[name="shadowPreset"]');
    if (shadow) shadow.value = st.shadowPreset;
    syncRadiusScaleField();
  }

  function applyTypographyState(st) {
    const fontFamily = page.querySelector('[name="fontFamily"]');
    if (fontFamily) fontFamily.value = st.fontFamily;
    const fontSize = page.querySelector('[name="fontSize"]');
    if (fontSize) fontSize.value = String(st.fontSize);
    setRangeField('headingScale', st.headingScale);
    const density = page.querySelector('[name="density"]');
    if (density) density.value = st.density;
    page.querySelectorAll('.ui-font-upload-toolbar .ui-asset-remove-form').forEach((form) => {
      form.hidden = !st.hasCustomFont;
    });
  }

  function updateResetWraps(st) {
    setResetWrapVisible('sliders', st.hasCustomThemeSliders);
    setResetWrapVisible('colors', st.hasCustomThemeColors);
    setResetWrapVisible('shape', st.hasCustomThemeShape);
    setResetWrapVisible('typography', st.hasCustomThemeTypography);
  }

  const RESET_FLASH = {
    sliders: 'admin.ui.flashResetSliders',
    colors: 'admin.ui.flashResetColors',
    shape: 'admin.ui.flashResetShape',
    typography: 'admin.ui.flashResetTypography',
  };

  async function runAppearanceReset(section) {
    const flashKey = RESET_FLASH[section];
    if (!flashKey) return;
    const btn = page.querySelector(`[data-ui-reset="${section}"]`);
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const csrf = getCsrfTokenFromPage();
      const resp = await fetch(`/api/admin/ui/reset/${encodeURIComponent(section)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || uiT('app.errorPrefix'));
      const st = data.state;
      if (!st) throw new Error(uiT('app.errorPrefix'));
      if (section === 'sliders') applySlidersState(st);
      else if (section === 'colors') applyColorsState(st);
      else if (section === 'shape') applyShapeState(st);
      else if (section === 'typography') applyTypographyState(st);
      updateResetWraps(st);
      schedulePreview();
      patchDirtyFormBaseline('ui-main-form', section);
      showToast(uiT(flashKey), 'success');
    } catch (error) {
      showToast(error.message || uiT('app.errorPrefix'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  page.querySelectorAll('[data-ui-reset]').forEach((btn) => {
    btn.addEventListener('click', () => runAppearanceReset(btn.dataset.uiReset));
  });

  async function runRefreshBgPalette() {
    const btn = page.querySelector('[data-ui-refresh-bg-palette]');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const csrf = getCsrfTokenFromPage();
      const resp = await fetch('/api/admin/ui/refresh-bg-palette', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || uiT('app.errorPrefix'));
      const st = data.state;
      if (!st) throw new Error(uiT('app.errorPrefix'));
      applyColorsState(st);
      updateResetWraps(st);
      schedulePreview();
      patchDirtyFormBaseline('ui-main-form', 'colors');
      showToast(uiT('admin.ui.flashBgPaletteRefreshed'), 'success');
    } catch (error) {
      showToast(error.message || uiT('app.errorPrefix'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  page.querySelector('[data-ui-refresh-bg-palette]')?.addEventListener('click', () => runRefreshBgPalette());

  // Sync live preview with the current form (preserves panel glass after asset changes).
  showPreviewBar = false;
  schedulePreview({ showBar: false });
}

function attachAccountNavSelect() {
  document.querySelectorAll('[data-account-nav-select]').forEach((sel) => {
    if (sel.dataset.bound === '1') return;
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      const url = sel.value;
      if (!url) return;
      const cur = `${window.location.pathname}${window.location.search}`;
      if (url !== cur) window.location.assign(url);
    });
  });
}

function resolveBookIdFromRow(row) {
  if (!row) return '';
  if (typeof resolveBookIdFromElement === 'function') {
    const fromEl = resolveBookIdFromElement(row);
    if (fromEl) return fromEl;
  }
  return row.dataset.bookId || row.dataset.removeReading || '';
}

function attachProfileRemoveActions() {
  for (const btn of document.querySelectorAll('[data-remove-reading]')) {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.profile-list-item');
      const bookId = resolveBookIdFromRow(row);
      if (!bookId) {
        showToast(uiT('app.removeReadingFail'), 'error');
        return;
      }
      const title = (row?.querySelector('a')?.textContent || '').trim();
      const msg = title ? uiTp('app.removeReadingConfirm', { title }) : uiT('app.removeReadingConfirmShort');
      if (!await confirmAction(msg, { danger: true })) return;

      const lastOpenedAt = row?.dataset.readingLastOpened || '';
      const openCount = Math.max(1, Number(row?.dataset.readingOpenCount) || 1);

      try {
        const r = await fetch(apiReadingHistoryPath(bookId), { method: 'DELETE', credentials: 'same-origin' });
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
                const restore = await fetch(apiReadingHistoryPath(bookId), {
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
                const restore = await fetch(`${apiBookPath(bookId, 'bookmarks')}`, {
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
  for (const btn of document.querySelectorAll('[data-remove-annotation]')) {
    btn.addEventListener('click', async () => {
      const aid = btn.dataset.removeAnnotation;
      const row = btn.closest('.profile-list-item');
      const rawBookId = row?.dataset.annotationBookId || '';
      const bookId = rawBookId ? decodeURIComponent(rawBookId).replace(/\uFFFD/g, '\0') : '';
      const labelText = (row?.querySelector('a')?.textContent || '').trim();
      const msg = labelText ? uiTp('app.deleteAnnotationConfirm', { label: labelText }) : uiT('app.deleteAnnotationConfirmShort');
      if (!await confirmAction(msg, { danger: true })) return;
      if (!bookId) {
        showToast(uiT('app.annotationDeleteFail'), 'error');
        return;
      }
      try {
        const r = await fetch(`${apiBookPath(bookId, `annotations/${encodeURIComponent(aid)}`)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (await handleAuthRequired(r)) return;
        if (!r.ok) {
          showToast(uiT('app.annotationDeleteFail'), 'error');
          return;
        }
        if (row) row.remove();
        bumpProfileReaderNotesTotal(-1);
        showToast(uiT('app.annotationDeleted'), 'success');
      } catch {
        showToast(uiT('app.networkError'), 'error');
      }
    });
  }
}

function registrationInviteShareUrl(token, serverUrl) {
  const code = String(token || '').trim();
  const fromServer = String(serverUrl || '').trim();
  if (/^https?:\/\//i.test(fromServer)) return fromServer;
  if (fromServer.includes('/register?invite=')) {
    try {
      return new URL(fromServer, window.location.origin).href;
    } catch {
      /* fall through */
    }
  }
  if (!code) return '';
  return `${window.location.origin}/register?invite=${encodeURIComponent(code)}`;
}

function attachRegistrationInviteForm() {
  const form = document.getElementById('registration-invite-form');
  if (!form) return;
  const tokenInput = document.getElementById('registration-invite-token');
  const linkWrap = document.getElementById('registration-invite-link-wrap');
  const linkInput = document.getElementById('registration-invite-url');
  const copyBtn = form.querySelector('[data-copy-invite]');
  const syncInviteLink = (token, serverUrl) => {
    const url = registrationInviteShareUrl(token, serverUrl);
    if (linkInput) linkInput.value = url;
    if (copyBtn) {
      if (url) copyBtn.setAttribute('data-copy-text', url);
      else copyBtn.removeAttribute('data-copy-text');
    }
    if (linkWrap) linkWrap.style.display = url ? '' : 'none';
    return url;
  };
  copyBtn?.addEventListener('click', async () => {
    const text = registrationInviteShareUrl(tokenInput?.value, linkInput?.value || copyBtn.getAttribute('data-copy-text'));
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(copyBtn.getAttribute('data-copy-done') || uiT('admin.users.inviteCopied'), 'success');
    } catch {
      if (linkInput) {
        linkInput.focus();
        linkInput.select();
      }
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = event.submitter || form.querySelector('button[type="submit"]');
    const params = new URLSearchParams(new FormData(form));
    if (btn?.name) params.set(btn.name, btn.value);
    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const headers = { Accept: 'application/json' };
    if (csrfMeta) headers['x-csrf-token'] = csrfMeta.content;
    const prevHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || '\u0412\u044b\u043f\u043e\u043b\u043d\u044f\u0435\u0442\u0441\u044f\u2026');
    }
    const endpoint = form.getAttribute('action') || '/admin/settings/registration-invite';
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: params
      });
      const data = await response.json().catch(() => null);
      if (!data) {
        showToast(uiT('app.networkError'), 'error');
        return;
      }
      if (!data.ok) {
        showToast(data.flash || uiT('app.errorPrefix'), 'error');
        return;
      }
      if (tokenInput && typeof data.token === 'string') tokenInput.value = data.token;
      syncInviteLink(data.token, data.url);
      if (data.flash) showToast(data.flash, 'success');
    } catch {
      showToast(uiT('app.networkError'), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = prevHtml;
      }
    }
  });
}

function attachCopyButtons() {
  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-copy-from], [data-copy-text]');
    if (!btn || btn.hasAttribute('data-copy-invite')) return;
    const input = document.querySelector(btn.getAttribute('data-copy-from') || '');
    const text = String(btn.getAttribute('data-copy-text') || input?.value || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      showToast(btn.getAttribute('data-copy-done') || uiT('admin.users.inviteCopied'), 'success');
    } catch {
      input?.focus();
      input?.select();
    }
  });
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

function attachSourceEdit() {
  const editBtns = document.querySelectorAll('[data-edit-source]');
  if (!editBtns.length) return;

  for (const btn of editBtns) {
    const id = btn.dataset.editSource;
    const editRow = document.getElementById(`source-edit-${id}`);
    const nameInput = editRow?.querySelector(`[data-edit-name="${id}"]`);
    const pathInput = editRow?.querySelector(`[data-edit-path="${id}"]`);
    const hint = editRow?.querySelector(`[data-edit-hint="${id}"]`);
    const checkBtn = editRow?.querySelector(`[data-check-edit="${id}"]`);
    const saveBtn = editRow?.querySelector(`[data-save-edit="${id}"]`);
    const cancelBtn = editRow?.querySelector(`[data-cancel-edit="${id}"]`);
    const actionsDiv = document.querySelector(`[data-source-actions="${id}"]`);
    const nameText = document.querySelector(`[data-source-name="${id}"]`);
    const pathText = document.querySelector(`[data-path-status="${id}"]`);

    if (!editRow || !nameInput || !pathInput || !hint || !checkBtn || !saveBtn || !cancelBtn) continue;

    const showEditor = () => {
      editRow.style.display = '';
      if (actionsDiv) actionsDiv.style.display = 'none';
      hint.textContent = '';
      hint.style.color = '';
      nameInput.focus();
    };
    const hideEditor = () => {
      editRow.style.display = 'none';
      if (actionsDiv) actionsDiv.style.display = '';
      hint.textContent = '';
      hint.style.color = '';
    };

    btn.addEventListener('click', showEditor);
    cancelBtn.addEventListener('click', hideEditor);

    checkBtn.addEventListener('click', async () => {
      hint.textContent = uiT('app.adminProbeRunning') || 'Checking…';
      hint.style.color = '';
      try {
        const probe = await fetch('/api/sources/probe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ path: pathInput.value })
        }).then(r => r.json());
        if (probe.ok && probe.exists) {
          hint.textContent = (uiT('app.adminPathFound') || 'Path found') + (probe.isFile ? ' (INPX)' : ` (${probe.inpxFiles?.length ?? 0} INPX)`);
          hint.style.color = 'var(--success)';
        } else {
          hint.textContent = uiT('app.adminPathMissing') || 'Path not found';
          hint.style.color = 'var(--danger)';
        }
      } catch {
        hint.textContent = 'Error';
        hint.style.color = 'var(--danger)';
      }
    });

    saveBtn.addEventListener('click', async () => {
      const newName = nameInput.value.trim();
      const newPath = pathInput.value.trim();
      if (!newName || !newPath) return;
      saveBtn.disabled = true;
      try {
        const csrf = getCsrfTokenFromPage();
        const headers = { 'Content-Type': 'application/json' };
        if (csrf) headers['X-CSRF-Token'] = csrf;
        const resp = await fetch(`/api/admin/sources/${id}/edit`, {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: JSON.stringify({ name: newName, path: newPath })
        });
        const data = await resp.json().catch(() => ({}));
        if (data.ok && data.source) {
          if (nameText) nameText.textContent = data.source.name;
          if (pathText) pathText.textContent = data.source.path;
          const row = document.querySelector(`tr[data-source-id="${id}"]`);
          if (row) row.dataset.sourcePath = data.source.path;
          const delBtn = document.querySelector(`[data-delete-source="${id}"]`);
          if (delBtn) delBtn.dataset.sourceName = data.source.name;
          hideEditor();
          showToast(uiT('app.adminPathSaved') || 'Saved', 'success');
        } else {
          hint.textContent = data.error || 'Error';
          hint.style.color = 'var(--danger)';
        }
      } catch {
        hint.textContent = 'Error';
        hint.style.color = 'var(--danger)';
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  /* Автопроверка текущих путей при загрузке страницы */
  async function checkCurrentPaths() {
    for (const row of document.querySelectorAll('tr[data-source-id]')) {
      const id = row.dataset.sourceId;
      const pathText = row.querySelector(`[data-path-status="${id}"]`);
      if (!pathText || !id) continue;
      try {
        const res = await fetch(`/api/admin/sources/${id}/check-path`, { credentials: 'same-origin' });
        const data = await res.json();
        if (!data.exists) {
          pathText.style.color = 'var(--danger)';
          pathText.title = uiT('app.adminPathMissing') || 'Path not found — click Edit to fix';
        } else {
          pathText.style.color = '';
          pathText.title = '';
        }
      } catch {
        /* ignore */
      }
    }
  }
  checkCurrentPaths();
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
        const phase = String(status?.phase || '');
        const stillBusy = Boolean(status?.active) || phase === 'maintenance';
        if (stillBusy) {
          const imported = Math.max(0, Math.floor(Number(status.importedBooks) || 0));
          const unique = Math.max(0, Math.floor(Number(status.uniqueBooks) || 0));
          const phaseDone = Number(status.phaseDone || 0);
          const phaseTotal = Number(status.phaseTotal || 0);
          const phaseLabel = String(status.phaseLabel || '');
          let percent = 0;
          let title = escapeHtml(uiT('app.adminIndexingLabel'));
          let detail = '';
          let indeterminate = false;
          if (phase === 'fts') {
            percent = phaseTotal > 0 ? Math.min(100, Math.round((phaseDone / phaseTotal) * 100)) : 0;
            title = escapeHtml(uiT('app.adminIndexPhaseFts'));
            detail = phaseTotal > 0 ? `<span class="muted" style="margin-left:12px">${phaseDone} / ${phaseTotal}</span>` : '';
          } else if (phase === 'maintenance') {
            indeterminate = true;
            percent = 100;
            title = escapeHtml(uiT('app.adminIndexPhaseMaintenance'));
            detail = phaseLabel ? `<span class="muted" style="margin-left:12px">${escapeHtml(phaseLabel)}</span>` : '';
          } else {
            percent = status.totalArchives ? Math.min(100, Math.round((status.processedArchives / status.totalArchives) * 100)) : 0;
            detail = `<span class="muted" style="margin-left:12px">${escapeHtml(uiTp('app.adminIndexFilesLine', { processed: status.processedArchives || 0, total: status.totalArchives || 0, imported, unique }))}</span>`;
          }
          const showEta = !phase || phase === 'archives';
          const archiveLabel = formatIndexArchiveLine(status);
          const { elapsed, eta } = computeIndexTimeInfo(status.startedAt, status.processedArchives || 0, status.totalArchives || 0);
          const timeParts = [];
          if (elapsed) timeParts.push(uiTp('app.indexElapsed', { time: elapsed }));
          if (showEta && eta) timeParts.push(uiTp('app.indexEta', { time: eta }));
          showProgress(
            `${title} ${indeterminate ? '' : `<strong>${percent}%</strong>`}${detail}`,
            percent,
            archiveLabel,
            timeParts.join('  \u00b7  ')
          );
          if (progressBar) progressBar.classList.toggle('progress-indeterminate', indeterminate);
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
silenceSkippedViewTransitions();
attachScrollToTop();
attachSidebarToggle();
initAppPairingUi();
attachTopbarSearchToggle();
attachTopbarAutoHide();
attachThemeToggle();
attachCatalogFilters();
attachDownloadMenus();
attachCoverErrorFallback(document);
loadCardDetails();
loadBookPageReview();
attachBookmarkActions();
attachReadBookActions();

/* Кнопка «Отмена» в редакторе метаданных книги: откатывает поля формы
   к исходным значениям (form.reset()) и закрывает <details>. */
document.querySelectorAll('[data-book-edit-cancel]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const form = btn.closest('form');
    if (form && typeof form.reset === 'function') form.reset();
    const details = btn.closest('details');
    if (details) details.open = false;
  });
});
attachCoverLongPress();
attachSeriesLongPress();
attachMarkSeriesReadActions();
attachFavoriteActions();
attachOperationActions();
attachSidecarDiagnostics();
attachCatalogNavLoading();
attachSmartSearch();
attachBookIllustrationLightbox();
loadHomeRecommendationsProgressively();
loadHomeContinueProgressively();
initHomeWelcomeReveal();
attachLoadMore();
attachBatchDownloadSelection();
attachConfirmedFormSubmits();
attachFormSubmitSpinners();
attachShelfActions();
attachAddToShelfButtons();
attachSendToEreader();
attachSendBatchToEreader();
attachUpdateUpload();
attachUiAppearanceUpload();
attachProfileRemoveActions();
attachAccountNavSelect();
attachAdminRecaptchaDisclosure();
attachRegistrationInviteForm();
attachCopyButtons();
if (document.querySelector('[data-index-status]')) pollIndexStatus();
if (document.querySelector('[data-admin-index-controls]')) pollAdminIndexControls();
if (document.querySelector('[data-operations-dashboard]')) pollOperationsDashboard();
if (document.querySelector('[data-admin-events-page]')) pollAdminEventsPage();
attachSourcesReindex();
attachSourceDelete();
attachAddSourceForm();
attachSourceEdit();

const dirtyBaselineUpdaters = new Map();
const dirtyBaselinePatchers = new Map();

const UI_APPEARANCE_FIELD_GROUPS = {
  sliders: [
    'bgBlur', 'bgOverlay', 'surfaceOpacity', 'surfaceBlur', 'bgSize', 'bgPosition',
    'overlayColorDark', 'overlayColorLight', 'overlayColorAutoDark', 'overlayColorAutoLight',
  ],
  colors: [
    'dynamicThemeFromBg',
    'glassColorDark', 'glassColorLight',
    'glassTextDark', 'glassTextLight', 'glassTextAutoDark', 'glassTextAutoLight',
    'glassMutedDark', 'glassMutedLight', 'glassMutedAutoDark', 'glassMutedAutoLight',
    'glassLinkDark', 'glassLinkLight', 'glassLinkAutoDark', 'glassLinkAutoLight',
    'accentDark', 'accentLight', 'accentAutoDark', 'accentAutoLight',
  ],
  shape: ['radiusPreset', 'radiusScale', 'shadowPreset'],
  typography: ['fontSize', 'fontFamily', 'density', 'headingScale'],
};

function patchDirtyFormBaseline(formId, sectionOrFields) {
  const fields = Array.isArray(sectionOrFields)
    ? sectionOrFields
    : UI_APPEARANCE_FIELD_GROUPS[sectionOrFields] || [];
  dirtyBaselinePatchers.get(formId)?.(fields);
}

function syncDirtyFormBaseline(formId = 'ui-main-form') {
  dirtyBaselineUpdaters.get(formId)?.();
}

attachDirtyFormTracking();
attachAdminUserFormAutofillGuard();

// --- Dirty form tracking ---
function attachDirtyFormTracking() {
  document.querySelectorAll('form[data-track-dirty]').forEach(form => {
    const getState = () => {
      const fd = new FormData(form);
      const state = {};
      for (const [k, v] of fd.entries()) state[k] = v;
      form.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        if (!cb.checked) state[cb.name] = 'off';
      });
      if (form.id) {
        document.querySelectorAll(`[form="${CSS.escape(form.id)}"][type="checkbox"]`).forEach((cb) => {
          if (!cb.checked && cb.name) state[cb.name] = 'off';
        });
      }
      return JSON.stringify(state);
    };
    let baseline = getState();
    const check = () => {
      const dirty = getState() !== baseline;
      form.classList.toggle('is-dirty', dirty);
    };
    const syncBaseline = () => {
      baseline = getState();
      check();
    };
    const patchBaseline = (fields) => {
      const current = JSON.parse(getState());
      const base = JSON.parse(baseline);
      for (const key of fields) {
        if (key in current) base[key] = current[key];
        else delete base[key];
      }
      baseline = JSON.stringify(base);
      check();
    };
    if (form.id) {
      dirtyBaselineUpdaters.set(form.id, syncBaseline);
      dirtyBaselinePatchers.set(form.id, patchBaseline);
    }
    const bindDirtyEvents = (el) => {
      el.addEventListener('input', check);
      el.addEventListener('change', check);
    };
    bindDirtyEvents(form);
    if (form.id) {
      document.querySelectorAll(`[form="${CSS.escape(form.id)}"]`).forEach(bindDirtyEvents);
    }
    /* При сабмите снимаем «грязный» флаг: иначе beforeunload, который стреляет
       перед уходом на POST/redirect, увидит .is-dirty и покажет «Покинуть страницу?».
       Если сабмит провалится — сервер отдаст redirect с flash, страница перерендерится,
       initial пересчитается заново. */
    form.addEventListener('submit', () => {
      form.classList.remove('is-dirty');
    });
  });
  document.querySelectorAll('form[data-clears-dirty]').forEach((form) => {
    const targetId = form.getAttribute('data-clears-dirty');
    if (!targetId) return;
    const clearDirty = () => document.getElementById(targetId)?.classList.remove('is-dirty');
    form.addEventListener('submit', clearDirty);
    if (form.id) {
      document.querySelectorAll(`button[type="submit"][form="${CSS.escape(form.id)}"], input[type="submit"][form="${CSS.escape(form.id)}"]`).forEach((btn) => {
        btn.addEventListener('click', clearDirty, { capture: true });
      });
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (document.querySelector('form.is-dirty')) {
      e.preventDefault();
    }
  });
}

function attachAdminUserFormAutofillGuard() {
  document.querySelectorAll('.user-admin-form').forEach((form) => {
    const details = form.closest('details');
    const hydrateScopedFields = () => {
      form.querySelectorAll('[data-admin-fields-ready]').forEach((input) => {
        input.value = '1';
      });
      form.querySelectorAll('[data-initial-telegram-id]').forEach((input) => {
        if (input.dataset.hydrated === '1') return;
        input.value = input.getAttribute('data-initial-telegram-id') || '';
        input.dataset.hydrated = '1';
      });
      form.querySelectorAll('[data-initial-ereader-email]').forEach((input) => {
        if (input.dataset.hydrated === '1') return;
        input.value = input.getAttribute('data-initial-ereader-email') || '';
        input.dataset.hydrated = '1';
      });
    };
    if (details) {
      details.addEventListener('toggle', () => {
        if (details.open) hydrateScopedFields();
      });
      if (details.open) hydrateScopedFields();
    } else {
      hydrateScopedFields();
    }

    form.querySelectorAll('[data-admin-no-autofill]').forEach((input) => {
      input.setAttribute('readonly', 'readonly');
      const unlock = () => {
        input.removeAttribute('readonly');
      };
      input.addEventListener('focus', unlock, { once: true });
      input.addEventListener('mousedown', unlock, { once: true });
    });
  });
}

/* ── Форма расписания сканирования: переключение видимости полей по выбранному режиму
   и периодический поллинг /api/admin/scan-schedule, чтобы чип «Следующий запуск»
   и история запусков были живыми без перезагрузки страницы. ── */
(function initScanScheduleForm() {
  const form = document.querySelector('[data-scan-schedule-form]');
  if (!form) return;

  const modeSelect = form.querySelector('[data-scan-schedule-mode]');
  const sections = form.querySelectorAll('[data-scan-schedule-when]');
  function applyMode() {
    const mode = modeSelect ? modeSelect.value : 'off';
    sections.forEach(function(node) {
      const when = node.getAttribute('data-scan-schedule-when');
      if (when === mode) node.removeAttribute('hidden');
      else node.setAttribute('hidden', '');
    });
  }
  if (modeSelect) {
    modeSelect.addEventListener('change', applyMode);
    applyMode();
  }

  const nextRunEl = form.querySelector('[data-scan-schedule-next]');
  const logBody = form.querySelector('[data-scan-schedule-log]');
  /* fmtDateTime: используем браузерный toLocaleString — серверный formatLocaleDateTimeShort
     недоступен в клиенте, но локаль уже корректно определяется через getUiLocale(). */
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const loc = getUiLocale() === 'en' ? 'en-US' : 'ru-RU';
    try {
      return d.toLocaleString(loc, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return d.toLocaleString();
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/admin/scan-schedule', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.ok) return;

      const mode = data.schedule && data.schedule.mode;
      if (nextRunEl) {
        let line;
        if (!mode || mode === 'off' || !data.nextRunAt) {
          line = uiT('admin.schedule.nextRunNone');
        } else {
          line = uiTp('admin.schedule.nextRun', { when: fmtDateTime(data.nextRunAt) });
        }
        nextRunEl.textContent = line;
        nextRunEl.setAttribute('data-next-run-at', data.nextRunAt || '');
      }

      if (logBody && Array.isArray(data.log)) {
        if (!data.log.length) {
          logBody.innerHTML = '<tr><td colspan="3" class="muted" style="text-align:center;padding:8px">'
            + escapeHtml(uiT('admin.schedule.logEmpty')) + '</td></tr>';
        } else {
          logBody.innerHTML = data.log.map(function(row) {
            const kind = row.full ? uiT('admin.schedule.kindFull') : uiT('admin.schedule.kindIncremental');
            let status;
            if (row.status === 'error') {
              status = escapeHtml(uiT('admin.schedule.statusError')) + ': ' + escapeHtml(row.message || '');
            } else if (row.status === 'ok') {
              status = escapeHtml(uiT('admin.schedule.statusOk'));
            } else {
              status = escapeHtml(uiT('admin.schedule.statusStarted'));
            }
            return '<tr>'
              + '<td>' + escapeHtml(fmtDateTime(row.ranAt)) + '</td>'
              + '<td><span class="admin-chip" style="font-size:.85em">' + escapeHtml(kind) + '</span></td>'
              + '<td>' + status + '</td>'
              + '</tr>';
          }).join('');
        }
      }
    } catch (e) {
      /* network hiccups — silent; следующая итерация попробует снова */
    }
  }

  /* Опрос каждые 30 секунд: «Следующий запуск» обычно меняется на минутах,
     чаще — лишний шум. */
  setInterval(refresh, 30_000);
  /* Первый отложенный refresh — чтобы подтянуть свежее значение nextRunAt
     после перезагрузки страницы (а вдруг таймер сработал между рендером и DOM). */
  setTimeout(refresh, 1500);
})();

/* ── Страница дубликатов в админке ──────────────────────────────────────────
   Точки монтирования задаёт renderAdminDuplicates (src/templates/admin.js):
     #dup-filter-wrap — поле поиска,
     #dup-results     — панель автоочистки + группы дубликатов + пагинация,
     #supp-wrap       — список подавленных книг.
   Данные тянутся из /api/admin/duplicates и /api/admin/suppressed. ── */
(function initDuplicatesPage() {
  const container = document.querySelector('[data-duplicates-page]');
  if (!container) return;
  const resultsWrap = container.querySelector('#dup-results');
  const suppWrap = container.querySelector('#supp-wrap');
  const filterWrap = container.querySelector('#dup-filter-wrap');
  if (!resultsWrap || !suppWrap || !filterWrap) return;

  let currentPage = Math.max(1, parseInt(container.getAttribute('data-page'), 10) || 1);
  let currentFilter = '';
  let dupBusy = false;
  let suppPage = 1;
  let dupReqToken = 0;     // последовательность запросов дубликатов: игнорируем устаревшие ответы
  let suppReqToken = 0;    // то же для подавленных книг
  let filterTimer = 0;     // debounce живого поиска
  let firstLoadDup = true; // первая загрузка рисует крупный индикатор, далее — мягкий
  let firstLoadSupp = true;

  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* POST JSON на API, показываем спиннер на нажатой кнопке, перезагружаем данные при успехе. */
  async function dupAction(url, body, confirmMsg, danger, triggerBtn) {
    if (dupBusy) return;
    if (confirmMsg && !(await confirmAction(confirmMsg, { danger }))) return;
    dupBusy = true;
    let prevHtml = '';
    if (triggerBtn) {
      prevHtml = triggerBtn.innerHTML;
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(uiT('app.running') || '…');
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
    loadSuppressed(suppPage);
  }

  function renderAutoCleanPanel(preview) {
    if (!preview || preview.willDelete <= 0) return '';
    return '<div class="admin-card admin-dup-auto-clean" style="margin-bottom:20px;box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--accent-color, var(--accent)) 35%, transparent)">'
      + '<div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.autoCleanTitle')) + '</div>'
      + '<p style="margin:8px 0">' + escapeHtml(uiTp('admin.duplicates.autoCleanDesc', { groups: preview.totalGroups, total: preview.totalBooks, delete: preview.willDelete })) + '</p>'
      + '<p class="muted" style="font-size:.85em;margin:4px 0">' + escapeHtml(uiT('admin.duplicates.autoCleanStrategy')) + '</p>'
      + '<div style="margin-top:12px">'
      + '<button type="button" class="button-danger" data-dup-auto-clean data-n="' + preview.willDelete + '">'
      + escapeHtml(uiTp('admin.duplicates.autoCleanBtn', { n: preview.willDelete }))
      + '</button></div></div>';
  }

  /* Двухуровневая группировка: автор (заголовок <details>) → наборы дубликатов
     по названию книги (внутри). Сервер уже отдаёт строки, отсортированные по
     authors → title_sort, поэтому подгруппы формируются простым проходом. */
  function renderGroups(groups) {
    if (!groups || !groups.length) {
      return '<p class="muted" style="margin:24px 0">' + escapeHtml(uiT('admin.duplicates.empty')) + '</p>';
    }
    const thFormat = escapeHtml(uiT('admin.duplicates.thFormat'));
    const thSize = escapeHtml(uiT('admin.duplicates.thSize'));
    const thLang = escapeHtml(uiT('admin.duplicates.thLang'));
    const thFile = escapeHtml(uiT('admin.duplicates.thFile'));
    return groups.map(function(group, gi) {
      const sets = [];
      let cur = null;
      group.items.forEach(function(book) {
        const key = book.title_sort || book.title || '';
        if (!cur || cur.key !== key) {
          cur = { key: key, title: book.title || book.title_sort || '', items: [] };
          sets.push(cur);
        }
        cur.items.push(book);
      });
      const totalCopies = group.items.length;
      const setsHtml = sets.map(function(set) {
        const rows = set.items.map(function(book) {
          return '<tr>'
            + '<td data-label="' + thFormat + '"><a href="' + bookPagePath(book.id) + '" class="admin-chip admin-compact-btn">' + escapeHtml((book.ext || '').toUpperCase()) + '</a></td>'
            + '<td data-label="' + thSize + '" style="white-space:nowrap">' + escapeHtml(fmtSize(book.size)) + '</td>'
            + '<td data-label="' + thLang + '">' + escapeHtml(book.lang || '') + '</td>'
            + '<td data-label="' + thFile + '" class="muted" style="font-size:.85em;word-break:break-all">' + escapeHtml(book.archive_name || book.file_name || '') + '</td>'
            + '<td data-label=""><button type="button" class="button-danger admin-compact-btn" data-dup-delete="' + escapeHtml(book.id) + '" data-title="' + escapeHtml(book.title) + '">' + escapeHtml(uiT('admin.duplicates.delete')) + '</button></td></tr>';
        }).join('');
        return '<div class="admin-dup-set">'
          + '<div class="admin-dup-set-title"><span>' + escapeHtml(set.title) + '</span>'
          + '<span class="admin-chip" style="font-size:.78em">' + set.items.length + ' ' + escapeHtml(uiPlural('copy', set.items.length)) + '</span></div>'
          + '<table class="admin-table admin-dup-table" style="width:100%;margin:6px 0 0"><thead><tr>'
          + '<th>' + thFormat + '</th>'
          + '<th>' + thSize + '</th>'
          + '<th>' + thLang + '</th>'
          + '<th>' + thFile + '</th>'
          + '<th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      }).join('');
      return '<details class="admin-dup-group">'
        + '<summary class="admin-dup-group-summary">'
        + '<strong class="admin-dup-group-title">' + escapeHtml(group.authors || uiT('book.authorUnknown')) + '</strong>'
        + '<span class="admin-chip admin-dup-group-count">' + totalCopies + ' ' + escapeHtml(uiPlural('copy', totalCopies)) + '</span>'
        + '</summary>'
        + '<div class="admin-dup-table-wrap">' + setsHtml + '</div></details>';
    }).join('');
  }

  function pageBtn(i, page, attr) {
    if (i === page) return '<span class="page-link page-link-active" aria-current="page">' + i + '</span> ';
    return '<button type="button" class="page-link" ' + attr + '="' + i + '">' + i + '</button> ';
  }

  /* Оконная пагинация: prev/next + первая/последняя страница и окно вокруг текущей,
     чтобы список кнопок оставался коротким даже на тысячах групп. attr задаёт
     data-атрибут кнопок (data-dup-page для дубликатов, data-supp-page для подавленных). */
  function renderPagination(total, pageSize, page, attr) {
    attr = attr || 'data-dup-page';
    const totalPages = Math.ceil(total / pageSize) || 1;
    if (totalPages <= 1) return '';
    let html = '<div class="pagination" style="margin-top:16px">';
    if (page > 1) html += '<button type="button" class="page-link page-link-prev" ' + attr + '="' + (page - 1) + '" aria-label="prev">\u2039</button> ';
    const win = 2;
    const from = Math.max(1, page - win);
    const to = Math.min(totalPages, page + win);
    if (from > 1) {
      html += pageBtn(1, page, attr);
      if (from > 2) html += '<span class="muted" style="padding:0 4px">\u2026</span> ';
    }
    for (let i = from; i <= to; i++) html += pageBtn(i, page, attr);
    if (to < totalPages) {
      if (to < totalPages - 1) html += '<span class="muted" style="padding:0 4px">\u2026</span> ';
      html += pageBtn(totalPages, page, attr);
    }
    if (page < totalPages) html += '<button type="button" class="page-link page-link-next" ' + attr + '="' + (page + 1) + '" aria-label="next">\u203a</button> ';
    html += '</div>';
    return html;
  }

  function reasonLabel(reason) {
    if (reason === 'auto_clean') return uiT('admin.duplicates.reasonAutoClean');
    return uiT('admin.duplicates.reasonUser');
  }

  /* Секция подавленных книг: тоже группируется по авторам (раскрывающиеся блоки)
     и пагинируется независимо от дубликатов (data-supp-page). Фильтр общий. */
  function renderSuppressedSection(sdata) {
    const totalBooks = Number(sdata && sdata.totalBooks) || 0;
    if (!totalBooks) {
      return '<div class="admin-card" style="margin-top:20px"><div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.suppressedTitle')) + '</div><p class="muted">' + escapeHtml(uiT('admin.duplicates.suppressedEmpty')) + '</p></div>';
    }
    const thTitle = escapeHtml(uiT('admin.duplicates.thTitle'));
    const groups = [];
    let cur = null;
    (sdata.rows || []).forEach(function(s) {
      const a = s.authors || '';
      if (!cur || cur.key !== a) { cur = { key: a, author: a, items: [] }; groups.push(cur); }
      cur.items.push(s);
    });
    const groupsHtml = groups.map(function(group, gi) {
      const rows = group.items.map(function(s) {
        return '<tr>'
          + '<td data-label="' + thTitle + '">' + escapeHtml(s.title || s.book_id) + '</td>'
          + '<td data-label=""><span class="admin-chip" style="font-size:.8em">' + escapeHtml(reasonLabel(s.reason)) + '</span></td>'
          + '<td data-label="" style="text-align:right;white-space:nowrap"><button type="button" class="button admin-compact-btn" data-dup-unsuppress="' + escapeHtml(s.book_id) + '">' + escapeHtml(uiT('admin.duplicates.unsuppress')) + '</button></td></tr>';
      }).join('');
      return '<details class="admin-dup-group">'
        + '<summary class="admin-dup-group-summary">'
        + '<strong class="admin-dup-group-title">' + escapeHtml(group.author || uiT('book.authorUnknown')) + '</strong>'
        + '<span class="admin-chip admin-dup-group-count">' + group.items.length + ' ' + escapeHtml(uiPlural('copy', group.items.length)) + '</span>'
        + '</summary>'
        + '<div class="admin-dup-table-wrap"><table class="admin-table admin-dup-table" style="width:100%;margin:6px 0 0"><tbody>' + rows + '</tbody></table></div></details>';
    }).join('');
    const unsuppressAllBtn = totalBooks > 1
      ? '<button type="button" class="button-danger" data-dup-unsuppress-all data-n="' + totalBooks + '" style="font-size:.9em;padding:5px 16px;margin-top:12px">' + escapeHtml(uiT('admin.duplicates.unsuppressAll')) + '</button>'
      : '';
    return '<div class="admin-card" style="margin-top:20px">'
      + '<div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.suppressedTitle')) + '</div>'
      + '<div class="admin-card-subtitle">' + escapeHtml(uiT('admin.duplicates.suppressedHint')) + '</div>'
      + '<div class="list-context-hint" style="margin:12px 0">' + escapeHtml(uiTp('admin.duplicates.suppressedCount', { n: totalBooks })) + '</div>'
      + groupsHtml
      + renderPagination(Number(sdata.total) || 0, Number(sdata.pageSize) || 50, Number(sdata.page) || suppPage, 'data-supp-page')
      + unsuppressAllBtn
      + '</div>';
  }

  function wireDupActions() {
    resultsWrap.querySelectorAll('[data-dup-delete]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const id = btn.getAttribute('data-dup-delete');
        const title = btn.getAttribute('data-title') || id;
        dupAction('/api/admin/duplicates/delete', { bookId: id }, uiTp('admin.duplicates.deleteConfirm', { title: title }), true, btn);
      });
    });
    resultsWrap.querySelectorAll('[data-dup-auto-clean]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const n = Number(btn.getAttribute('data-n') || 0);
        dupAction('/api/admin/duplicates/auto-clean', {}, uiTp('admin.duplicates.autoCleanConfirm', { n: n }), true, btn);
      });
    });
    resultsWrap.querySelectorAll('[data-dup-page]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const p = Math.max(1, parseInt(btn.getAttribute('data-dup-page'), 10) || 1);
        loadDuplicates(p);
        resultsWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function wireSuppActions() {
    suppWrap.querySelectorAll('[data-dup-unsuppress]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        dupAction('/api/admin/duplicates/unsuppress', { bookId: btn.getAttribute('data-dup-unsuppress') }, null, false, btn);
      });
    });
    suppWrap.querySelectorAll('[data-dup-unsuppress-all]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const n = Number(btn.getAttribute('data-n') || 0);
        dupAction('/api/admin/duplicates/unsuppress-all', {}, uiTp('admin.duplicates.unsuppressAllConfirm', { n: n }), true, btn);
      });
    });
    suppWrap.querySelectorAll('[data-supp-page]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const p = Math.max(1, parseInt(btn.getAttribute('data-supp-page'), 10) || 1);
        loadSuppressed(p);
        suppWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  /* Живой поиск: фильтрация по мере ввода с debounce, без перезагрузки страницы.
     Поле ввода рендерится один раз и не пересоздаётся при обновлении данных,
     чтобы не терять фокус и позицию курсора. */
  function renderFilterBox() {
    filterWrap.innerHTML = '<div class="admin-card" style="margin-bottom:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<input type="search" data-dup-filter-input placeholder="' + escapeHtml(uiT('admin.duplicates.filterPlaceholder')) + '" value="' + escapeHtml(currentFilter) + '" style="flex:1;min-width:200px">'
      + '<span data-dup-filter-spinner class="btn-spinner" style="display:none"></span>'
      + '</div>';
    const input = filterWrap.querySelector('[data-dup-filter-input]');
    input.addEventListener('input', function() {
      const val = String(input.value || '').trim();
      if (filterTimer) clearTimeout(filterTimer);
      const delay = val.length === 0 ? 0 : 300;
      filterTimer = setTimeout(function() {
        filterTimer = 0;
        if (val === currentFilter) return;
        currentFilter = val;
        loadDuplicates(1);
        loadSuppressed(1);
      }, delay);
    });
  }

  function dim(el, on) {
    el.style.opacity = on ? '0.55' : '';
    el.style.pointerEvents = on ? 'none' : '';
  }
  function spinner(on) {
    const sp = filterWrap.querySelector('[data-dup-filter-spinner]');
    if (sp) sp.style.display = on ? 'inline-block' : 'none';
  }

  function loadDuplicates(page) {
    currentPage = Math.max(1, page || 1);
    container.setAttribute('data-page', String(currentPage));
    const token = ++dupReqToken;
    if (firstLoadDup) {
      resultsWrap.innerHTML = '<div class="admin-card"><div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.searching'))
        + '</div><p class="muted">' + escapeHtml(uiT('admin.duplicates.searchingHint')) + '</p></div>';
    } else {
      spinner(true); dim(resultsWrap, true);
    }
    const q = 'page=' + currentPage + (currentFilter ? '&filter=' + encodeURIComponent(currentFilter) : '');
    fetch('/api/admin/duplicates?' + q, { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (token !== dupReqToken) return; // устаревший ответ — игнорируем
        firstLoadDup = false;
        spinner(false); dim(resultsWrap, false);
        if (!data || !data.ok) {
          resultsWrap.innerHTML = '<div class="admin-card"><p class="muted">' + escapeHtml((data && data.error) || 'Error loading duplicates') + '</p></div>';
          return;
        }
        resultsWrap.innerHTML = renderAutoCleanPanel(data.preview)
          + '<div class="admin-card">'
          + '<div class="admin-card-title">' + escapeHtml(uiT('admin.duplicates.cardTitle')) + '</div>'
          + '<div class="admin-card-subtitle">' + escapeHtml(uiT('admin.duplicates.cardSubtitle')) + '</div>'
          + '<div class="list-context-hint" style="margin:12px 0">' + escapeHtml(uiTp('admin.duplicates.totalGroups', { n: data.total })) + '</div>'
          + renderGroups(data.groups)
          + renderPagination(data.total, data.pageSize, data.page, 'data-dup-page')
          + '</div>';
        wireDupActions();
      })
      .catch(function(err) {
        if (token !== dupReqToken) return;
        firstLoadDup = false;
        spinner(false); dim(resultsWrap, false);
        resultsWrap.innerHTML = '<div class="admin-card"><p class="muted">Error: ' + escapeHtml(String(err)) + '</p></div>';
      });
  }

  function loadSuppressed(page) {
    suppPage = Math.max(1, page || 1);
    const token = ++suppReqToken;
    if (!firstLoadSupp) dim(suppWrap, true);
    const q = 'page=' + suppPage + (currentFilter ? '&filter=' + encodeURIComponent(currentFilter) : '');
    fetch('/api/admin/suppressed?' + q, { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(sdata) {
        if (token !== suppReqToken) return;
        firstLoadSupp = false;
        dim(suppWrap, false);
        suppWrap.innerHTML = renderSuppressedSection(sdata && sdata.ok ? sdata : { totalBooks: 0, rows: [] });
        wireSuppActions();
      })
      .catch(function() {
        if (token !== suppReqToken) return;
        firstLoadSupp = false;
        dim(suppWrap, false);
        suppWrap.innerHTML = '';
      });
  }

  renderFilterBox();
  loadDuplicates(currentPage);
  loadSuppressed(suppPage);
})();

function formatAppPairCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function initAppPairingUi() {
  const roots = [...document.querySelectorAll('[data-app-pair-root]')];
  if (!roots.length) return;

  let sharedState = null;
  let sharedPromise = null;
  let tickTimer = 0;
  let modalEl = null;

  function ensureModal() {
    if (modalEl) return modalEl;
    modalEl = document.createElement('div');
    modalEl.className = 'app-pair-modal';
    modalEl.hidden = true;
    modalEl.setAttribute('role', 'dialog');
    modalEl.setAttribute('aria-modal', 'true');
    modalEl.setAttribute('aria-label', uiT('profile.appPair.title'));
    modalEl.innerHTML = `
      <div class="app-pair-modal-backdrop" data-app-pair-modal-close></div>
      <div class="app-pair-modal-card">
        <h3 class="app-pair-modal-title">${escapeHtml(uiT('profile.appPair.title'))}</h3>
        <p class="muted app-pair-hint">${escapeHtml(uiT('profile.appPair.hint'))}</p>
        <p class="app-pair-app-link"><a href="https://github.com/Habsaec/inpx-book-reader/releases/latest" target="_blank" rel="noopener noreferrer">${escapeHtml(uiT('profile.appPair.appLink'))}</a></p>
        <div class="app-pair-modal-qr" data-app-pair-modal-qr></div>
        <div class="app-pair-meta-row"><span class="muted">${escapeHtml(uiT('profile.appPair.serverUrl'))}</span> <code data-app-pair-modal-url></code></div>
        <div class="app-pair-meta-row"><span class="muted">${escapeHtml(uiT('profile.appPair.username'))}</span> <code data-app-pair-modal-user></code></div>
        <p class="muted app-pair-expires" data-app-pair-modal-expires></p>
        <p class="app-pair-error" data-app-pair-modal-error hidden></p>
        <div class="app-pair-modal-actions">
          <button type="button" class="button" data-app-pair-modal-refresh>${escapeHtml(uiT('profile.appPair.refresh'))}</button>
          <button type="button" class="button" data-app-pair-modal-close>${escapeHtml(uiT('profile.appPair.close'))}</button>
        </div>
      </div>`;
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', (event) => {
      if (event.target.closest('[data-app-pair-modal-close]')) closeModal();
    });
    modalEl.querySelector('[data-app-pair-modal-refresh]')?.addEventListener('click', () => {
      fetchPairing(true).then(() => paintAll());
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modalEl && !modalEl.hidden) {
        event.preventDefault();
        closeModal();
      }
    });
    return modalEl;
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.hidden = true;
  }

  function openModal() {
    const modal = ensureModal();
    modal.hidden = false;
    fetchPairing(false).then(() => paintAll());
  }

  async function fetchPairing(force) {
    const expiresAt = sharedState?.expiresAt ? Date.parse(sharedState.expiresAt) : 0;
    if (!force && sharedState?.svg && expiresAt > Date.now() + 15_000) {
      return sharedState;
    }
    if (sharedPromise) return sharedPromise;
    sharedPromise = (async () => {
      try {
        const res = await fetch('/api/auth/pairing', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || uiT('profile.appPair.error'));
        }
        sharedState = {
          svg: String(data.svg || ''),
          serverUrl: String(data.serverUrl || ''),
          username: String(data.username || ''),
          expiresAt: String(data.expiresAt || ''),
          error: '',
        };
        return sharedState;
      } catch (err) {
        sharedState = {
          svg: '',
          serverUrl: sharedState?.serverUrl || '',
          username: sharedState?.username || '',
          expiresAt: '',
          error: err?.message || uiT('profile.appPair.error'),
        };
        return sharedState;
      } finally {
        sharedPromise = null;
      }
    })();
    return sharedPromise;
  }

  function paintExpires(el, expiresAt) {
    if (!el) return;
    const ms = expiresAt ? Date.parse(expiresAt) - Date.now() : 0;
    if (!expiresAt) {
      el.textContent = '';
      return;
    }
    if (ms <= 0) {
      el.textContent = uiT('profile.appPair.expired');
      return;
    }
    el.textContent = uiTp('profile.appPair.expiresIn', { time: formatAppPairCountdown(ms) });
  }

  function setQr(el, svg) {
    if (!el) return;
    if (svg) {
      el.innerHTML = svg;
    } else if (!el.innerHTML) {
      el.innerHTML = `<span class="muted" style="font-size:11px">${escapeHtml(uiT('profile.appPair.loading'))}</span>`;
    }
  }

  function paintRoot(root) {
    if (!sharedState) return;
    const qr = root.querySelector('[data-app-pair-qr]');
    setQr(qr, sharedState.svg);
    const urlEl = root.querySelector('[data-app-pair-url]');
    const userEl = root.querySelector('[data-app-pair-user]');
    const expEl = root.querySelector('[data-app-pair-expires]');
    const errEl = root.querySelector('[data-app-pair-error]');
    if (urlEl) urlEl.textContent = sharedState.serverUrl || '';
    if (userEl) userEl.textContent = sharedState.username || '';
    paintExpires(expEl, sharedState.expiresAt);
    if (errEl) {
      errEl.hidden = !sharedState.error;
      errEl.textContent = sharedState.error || '';
    }
  }

  function paintModal() {
    if (!modalEl || modalEl.hidden || !sharedState) return;
    setQr(modalEl.querySelector('[data-app-pair-modal-qr]'), sharedState.svg);
    const urlEl = modalEl.querySelector('[data-app-pair-modal-url]');
    const userEl = modalEl.querySelector('[data-app-pair-modal-user]');
    const expEl = modalEl.querySelector('[data-app-pair-modal-expires]');
    const errEl = modalEl.querySelector('[data-app-pair-modal-error]');
    if (urlEl) urlEl.textContent = sharedState.serverUrl || '';
    if (userEl) userEl.textContent = sharedState.username || '';
    paintExpires(expEl, sharedState.expiresAt);
    if (errEl) {
      errEl.hidden = !sharedState.error;
      errEl.textContent = sharedState.error || '';
    }
  }

  function paintAll() {
    roots.forEach(paintRoot);
    paintModal();
  }

  function startTicker() {
    if (tickTimer) return;
    tickTimer = window.setInterval(() => {
      if (!sharedState?.expiresAt) return;
      const ms = Date.parse(sharedState.expiresAt) - Date.now();
      paintAll();
      if (ms <= 0) {
        fetchPairing(true).then(() => paintAll());
      }
    }, 1000);
  }

  roots.forEach((root) => {
    root.querySelector('[data-app-pair-refresh]')?.addEventListener('click', () => {
      fetchPairing(true).then(() => paintAll());
    });
    root.querySelector('[data-app-pair-open]')?.addEventListener('click', () => openModal());
    if (root.getAttribute('data-app-pair-autoload') === '1' || root.getAttribute('data-app-pair-variant') === 'sidebar') {
      setQr(root.querySelector('[data-app-pair-qr]'), '');
      fetchPairing(false).then(() => {
        paintAll();
        startTicker();
      });
    }
  });
}

// PWA: Service Worker registered by pageShell with versioned URL
