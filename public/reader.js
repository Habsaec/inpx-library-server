import '/foliate/view.js';
import {
  FootnoteHandler,
  footnoteTargetFragmentFromHref,
  shouldTrySpineFootnoteClone,
} from '/foliate/footnotes.js';

(function () {
  'use strict';

  const _nativeFetch = window.fetch.bind(window);
  function readerCsrfToken() {
    const m = document.querySelector('meta[name="csrf-token"]');
    const t = m && m.getAttribute('content');
    return t && String(t).trim() ? String(t).trim() : '';
  }
  window.fetch = function readerPatchedFetch(input, init) {
    const opts = init === undefined ? {} : { ...init };
    const method = String(opts.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const token = readerCsrfToken();
      if (token) {
        const headers = new Headers(opts.headers);
        if (!headers.has('X-CSRF-Token')) {
          headers.set('X-CSRF-Token', token);
        }
        opts.headers = headers;
      }
    }
    return _nativeFetch(input, opts);
  };

  let _readerI18n = { locale: 'ru', strings: {} };
  try {
    const el = document.getElementById('ui-i18n-json');
    if (el && el.textContent) _readerI18n = JSON.parse(el.textContent);
  } catch { /* */ }
  function rt(key) {
    const s = _readerI18n.strings;
    if (!s || !Object.prototype.hasOwnProperty.call(s, key)) return key;
    const v = s[key];
    if (v === undefined || v === null) return key;
    return v;
  }
  function rtp(key, vars = {}) {
    let str = rt(key);
    for (const [k, v] of Object.entries(vars)) str = str.split(`{{${k}}}`).join(String(v));
    return str;
  }
  function rLocale() {
    return _readerI18n.locale === 'en' ? 'en' : 'ru';
  }
  function rPlural(type, n) {
    const lang = rLocale();
    const v = Math.floor(Math.abs(Number(n) || 0));
    if (lang === 'en') {
      return rt(`plural.${type}.${v === 1 ? 'one' : 'other'}`);
    }
    const m10 = v % 10;
    const m100 = v % 100;
    let suf;
    if (m100 >= 11 && m100 <= 14) suf = 'many';
    else if (m10 === 1) suf = 'one';
    else if (m10 >= 2 && m10 <= 4) suf = 'few';
    else suf = 'many';
    return rt(`plural.${type}.${suf}`);
  }

  /* ===== Constants & DOM refs ===== */
  const bookId = window.__READER_BOOK_ID;
  const bookExt = window.__READER_BOOK_EXT;
  const $ = (s) => document.getElementById(s);
  const readerBody = $('reader-body');
  const toolbarChapter = $('toolbar-chapter');
  const progressText = $('progress-text');
  const panelKickerEl = $('panel-kicker');
  const panelTitleEl = $('panel-title');
  const seekBar = $('ft-seek');
  const pctLabel = $('ft-pct');
  const ftChapter = $('ft-chapter');
  const tocSearchInput = $('toc-search-input');
  const tocPrevBtn = $('toc-prev-chapter');
  const tocNextBtn = $('toc-next-chapter');
  const panelOverlay = $('panel-overlay');
  const panelTabs = document.querySelectorAll('.panel-tab');
  const panelBodies = document.querySelectorAll('[data-panel-tab]');
  const toastEl = $('reader-toast');
  const btnTts = $('btn-tts');
  const btnTtsDock = $('btn-tts-dock');
  const ttsDockEl = $('reader-tts-dock');
  const bookPagesEl = $('reader-book-pages');
  const bookPageLeft = $('book-page-left');
  const bookPageRight = $('book-page-right');

  const isTouch = window.matchMedia('(pointer: coarse)');

  /* ===== Screen Wake Lock: экран не гаснет во время чтения (Chrome/Android, Safari 16.4+, нужен HTTPS) ===== */
  let wakeLock = null;
  async function acquireReaderWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        /* После снятия ОС (звонок, смена фокуса) пробуем снова, пока вкладка на виду. */
        if (document.visibilityState === 'visible') void acquireReaderWakeLock();
      });
    } catch {
      /* Нет активного жеста пользователя, запрет ОС или API недоступен */
    }
  }
  function releaseReaderWakeLock() {
    try {
      wakeLock?.release();
    } catch { /* */ }
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void acquireReaderWakeLock();
      if (ttsChainActive && !ttsPausedByUser) void startTtsKeepalivePlayback();
    } else {
      releaseReaderWakeLock();
    }
  });
  window.addEventListener('pagehide', releaseReaderWakeLock);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void acquireReaderWakeLock();
  });
  /* Панель/тулбар вне iframe — первый тап даёт жест для request() на мобильных. */
  document.body.addEventListener(
    'touchstart',
    () => {
      void acquireReaderWakeLock();
    },
    { capture: true, passive: true }
  );

  let view = null;
  /** Цепочка озвучивания (Web Speech API); пауза только по кнопке. */
  let ttsChainActive = false;
  let ttsPausedByUser = false;
  /** Не вызывать stopReaderTts при load iframe — переходим к следующей секции во время TTS. */
  let ttsAdvancingSection = false;
  /** Долгое нажатие на кнопку TTS — стоп (сенсорные устройства). */
  let ttsStopLongPressTimer = null;
  let ttsStopLongPressConsumeClick = false;
  let ttsStopLongPressPt = null;
  const TTS_STOP_LONG_PRESS_MS = 550;
  const TTS_STOP_LONG_PRESS_SLOP_PX = 14;
  /** Инвалидирует callbacks utterance при пропуске / стопе */
  let ttsSpeakToken = 0;
  const ttsNav = { skipBack() {}, skipForward() {} };
  let ttsKeepaliveUrl = null;
  let ttsKeepaliveEl = null;
  let ttsMediaSessionHandlers = false;
  let tocData = [];
  let bookmarksData = [];
  let chromeVisible = false;
  let chromeTimer = null;
  let activePanelTab = 'toc';

  /** Тихий зацикленный WAV (Blob URL), чтобы ОС считала вкладку «воспроизводящей медиа» — иногда помогает при выключенном экране (Chrome/Android; на iOS не гарантировано). */
  function createSilentWavKeepaliveUrl() {
    const sampleRate = 8000;
    const numSamples = Math.floor(sampleRate * 0.2);
    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buffer);
    let o = 0;
    const wstr = (s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o++, s.charCodeAt(i));
    };
    wstr('RIFF');
    v.setUint32(o, 36 + dataSize, true);
    o += 4;
    wstr('WAVE');
    wstr('fmt ');
    v.setUint32(o, 16, true);
    o += 4;
    v.setUint16(o, 1, true);
    o += 2;
    v.setUint16(o, 1, true);
    o += 2;
    v.setUint32(o, sampleRate, true);
    o += 4;
    v.setUint32(o, sampleRate * 2, true);
    o += 4;
    v.setUint16(o, 2, true);
    o += 2;
    v.setUint16(o, 16, true);
    o += 2;
    wstr('data');
    v.setUint32(o, dataSize, true);
    o += 4;
    for (let i = 0; i < numSamples; i++) {
      v.setInt16(o, 0, true);
      o += 2;
    }
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function ensureTtsKeepaliveEl() {
    if (ttsKeepaliveEl) return ttsKeepaliveEl;
    if (!ttsKeepaliveUrl) ttsKeepaliveUrl = createSilentWavKeepaliveUrl();
    const a = document.createElement('audio');
    a.setAttribute('playsinline', '');
    a.setAttribute('aria-hidden', 'true');
    a.loop = true;
    a.volume = 0.03;
    a.src = ttsKeepaliveUrl;
    a.preload = 'auto';
    document.body.appendChild(a);
    ttsKeepaliveEl = a;
    return ttsKeepaliveEl;
  }

  function pauseTtsKeepalive() {
    try {
      ttsKeepaliveEl?.pause();
    } catch { /* */ }
  }

  async function startTtsKeepalivePlayback() {
    if (!ttsChainActive || ttsPausedByUser) return;
    try {
      const a = ensureTtsKeepaliveEl();
      await a.play();
    } catch (e) {
      console.warn('[reader TTS keepalive]', e);
    }
  }

  function syncTtsKeepaliveWithSpeech() {
    if (!ttsChainActive || ttsPausedByUser) pauseTtsKeepalive();
    else void startTtsKeepalivePlayback();
  }

  function syncTtsMediaSessionPlayback() {
    if (!('mediaSession' in navigator)) return;
    try {
      if (!ttsChainActive) {
        navigator.mediaSession.playbackState = 'none';
      } else {
        navigator.mediaSession.playbackState = ttsPausedByUser ? 'paused' : 'playing';
      }
    } catch { /* */ }
  }

  function syncTtsMediaMetadata() {
    if (!('mediaSession' in navigator) || !ttsChainActive) return;
    try {
      const title = document.querySelector('.tb-title')?.textContent?.trim() || '';
      const kicker = document.querySelector('.tb-kicker')?.textContent?.trim() || '';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || document.title || 'Read aloud',
        artist: kicker || '',
      });
    } catch { /* */ }
  }

  function initReaderMediaSessionHandlers() {
    if (ttsMediaSessionHandlers || !('mediaSession' in navigator)) return;
    ttsMediaSessionHandlers = true;
    try {
      navigator.mediaSession.setActionHandler('play', () => {
        if (ttsChainActive) {
          if (ttsPausedByUser) toggleReaderTts();
        } else {
          void startReaderTts();
        }
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        if (ttsChainActive && !ttsPausedByUser) toggleReaderTts();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        if (ttsChainActive) ttsNav.skipBack();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        if (ttsChainActive) ttsNav.skipForward();
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        stopReaderTts();
      });
    } catch (e) {
      console.warn('[reader MediaSession]', e);
    }
  }

  /** Индекс секции → число «экранов» (pages−2 у пагинатора); точные значения после прохода. */
  const sectionPaginatorPages = new Map();
  let bookPageLayoutKeyCached = '';

  function bookPageLayoutKey() {
    return [S.font, S.fontSize, S.lineHeight, S.maxWidth, S.layout, innerWidth, innerHeight].join('|');
  }

  function invalidateBookPageCache() {
    sectionPaginatorPages.clear();
    bookPageLayoutKeyCached = '';
  }

  function ensureBookPageLayoutKey() {
    const k = bookPageLayoutKey();
    if (k !== bookPageLayoutKeyCached) {
      sectionPaginatorPages.clear();
      bookPageLayoutKeyCached = k;
    }
  }

  /* ===== Settings ===== */
  const defaults = {
    theme: 'sepia', font: 'serif', fontSize: 18, lineHeight: 1.6, maxWidth: 99999, layout: 'dual', textColor: '', bgColor: '',
    ttsRate: 1, ttsVoice: ''
  };
  const fontMap = {
    serif: 'Georgia, "Times New Roman", serif',
    palatino: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
    times: '"Times New Roman", Times, "Liberation Serif", "Noto Serif", serif',
    charter: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif',
    sans: '-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif',
    verdana: 'Verdana, Geneva, "DejaVu Sans", sans-serif',
    arial: 'Arial, Helvetica, "Helvetica Neue", sans-serif',
    mono: '"Cascadia Code", "Fira Code", Consolas, "Liberation Mono", monospace',
  };
  let S = {};
  function loadSettings() {
    try { S = JSON.parse(localStorage.getItem('reader-settings') || '{}'); } catch { S = {}; }
    for (const k of Object.keys(defaults)) if (S[k] === undefined) S[k] = defaults[k];
    if (S.layout !== 'paginated' && S.layout !== 'dual') S.layout = defaults.layout;
    if (S.textColor && !/^#[0-9A-Fa-f]{6}$/.test(String(S.textColor).trim())) S.textColor = '';
    if (S.bgColor && !/^#[0-9A-Fa-f]{6}$/.test(String(S.bgColor).trim())) S.bgColor = '';
    if (!(S.font in fontMap)) S.font = defaults.font;
    const tr = Number(S.ttsRate);
    S.ttsRate = Number.isFinite(tr) ? Math.min(2, Math.max(0.5, tr)) : defaults.ttsRate;
    if (typeof S.ttsVoice !== 'string') S.ttsVoice = defaults.ttsVoice;
  }
  function saveSettings() { localStorage.setItem('reader-settings', JSON.stringify(S)); }
  loadSettings();
  const themeColors = {
    dark:  { bg: '#1b1b2f', fg: '#d4cfc4', link: '#8ab4f8' },
    light: { bg: '#faf9f6', fg: '#222',    link: '#1a5fb4' },
    sepia: { bg: '#f4edd5', fg: '#3d3121', link: '#6b4226' },
    night: { bg: '#0d0d0d', fg: '#888',    link: '#5a8ab8' },
  };
  const presets = {
    compact:  { fontSize: 16, lineHeight: 1.45, maxWidth: 99999 },
    balanced: { fontSize: 18, lineHeight: 1.6,  maxWidth: 99999 },
    relaxed:  { fontSize: 21, lineHeight: 1.8,  maxWidth: 99999 },
  };

  function getEffectiveTextColor() {
    const c = themeColors[S.theme] || themeColors.dark;
    const t = S.textColor && String(S.textColor).trim();
    if (t && /^#[0-9A-Fa-f]{6}$/.test(t)) return t;
    return c.fg;
  }

  function getEffectiveBgColor() {
    const c = themeColors[S.theme] || themeColors.dark;
    const t = S.bgColor && String(S.bgColor).trim();
    if (t && /^#[0-9A-Fa-f]{6}$/.test(t)) return t;
    return c.bg;
  }

  function getBookCSS() {
    const c = themeColors[S.theme] || themeColors.dark;
    const fg = getEffectiveTextColor();
    const bg = getEffectiveBgColor();
    const ff = fontMap[S.font] || fontMap.serif;
    return `
      @namespace epub "http://www.idpf.org/2007/ops";
      html { color: ${fg} !important; background: ${bg} !important; }
      body { color: ${fg} !important; background: ${bg} !important; font-family: ${ff} !important; font-size: ${S.fontSize}px !important; }
      p,li,blockquote,dd,div { line-height: ${S.lineHeight} !important; }
      p,li,blockquote,dd { text-align: justify; hyphens: auto; -webkit-hyphens: auto; -webkit-hyphenate-limit-before: 3; -webkit-hyphenate-limit-after: 2; -webkit-hyphenate-limit-lines: 2; hanging-punctuation: allow-end last; widows: 2; }
      [align="left"]{text-align:left} [align="right"]{text-align:right} [align="center"]{text-align:center} [align="justify"]{text-align:justify}
      pre { white-space: pre-wrap !important; }
      aside[epub|type~="endnote"],aside[epub|type~="footnote"],aside[epub|type~="note"],aside[epub|type~="rearnote"] { display: none; }
      a { color: ${c.link}; }
    `;
  }

  function isNightReaderTheme() {
    return S.theme === 'dark' || S.theme === 'night';
  }

  function toggleDayNightTheme() {
    S.theme = isNightReaderTheme() ? 'light' : 'dark';
    applySettings();
    refreshSettingsUI();
    toast(isNightReaderTheme() ? rt('readerJs.nightOn') : rt('readerJs.dayOn'));
  }

  const svgMoon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  const svgSun = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

  function updateDayNightButton() {
    const btn = $('btn-day-night');
    if (!btn) return;
    const night = isNightReaderTheme();
    btn.title = night ? rt('readerJs.dayModeBtn') : rt('readerJs.nightModeBtn');
    btn.setAttribute('aria-label', night ? rt('readerJs.enableDayMode') : rt('readerJs.enableNightMode'));
    btn.innerHTML = night ? svgSun : svgMoon;
  }

  /**
   * Номера страниц по реальным экранам пагинатора Foliate (один шаг = один «лист» в одноколоннике
   * или разворот в двухколоннике). Неоткрытые главы оцениваются по объёму текста и плотности уже известных секций.
   */
  function updateBookPageDisplay(loc) {
    if (!bookPagesEl || !bookPageLeft || !bookPageRight) return;
    if (!view || view.isFixedLayout) {
      bookPagesEl.classList.add('is-hidden');
      return;
    }
    const r = view.renderer;
    if (!r || r.localName !== 'foliate-paginator') {
      bookPagesEl.classList.add('is-hidden');
      return;
    }
    if (r.scrolled) {
      bookPagesEl.classList.add('is-hidden');
      return;
    }

    const pages = r.pages;
    const page = r.page;
    if (pages == null || page == null || pages < 2) {
      bookPagesEl.classList.add('is-hidden');
      return;
    }

    const contents = r.getContents?.();
    const index = contents?.[0]?.index ?? loc?.section?.current;
    if (index == null || index < 0) {
      bookPagesEl.classList.add('is-hidden');
      return;
    }

    ensureBookPageLayoutKey();
    const tp = Math.max(0, pages - 2);
    const prevTp = sectionPaginatorPages.get(index) ?? 0;
    sectionPaginatorPages.set(index, Math.max(prevTp, tp));

    let screenInSection;
    if (page <= 0) screenInSection = 0;
    else if (page >= pages - 1) screenInSection = tp;
    else screenInSection = Math.min(tp, page - 1);

    const secs = view.book?.sections;
    if (!secs?.length) {
      bookPagesEl.classList.add('is-hidden');
      return;
    }

    const secAt = secs[index];
    const sizeCur = secAt?.size > 0 ? secAt.size : 0;

    function charsPerScreenGuess() {
      let sz = 0;
      let pg = 0;
      for (const [idx, tpp] of sectionPaginatorPages) {
        const s = secs[idx];
        if (!s || s.linear === 'no' || tpp <= 0) continue;
        sz += s.size || 0;
        pg += tpp;
      }
      if (pg > 0 && sz > 0) return sz / pg;
      if (tp > 0 && sizeCur > 0) return sizeCur / tp;
      return 2800;
    }

    function textPagesForSection(j) {
      const s = secs[j];
      if (!s || s.linear === 'no') return 0;
      if (sectionPaginatorPages.has(j)) return sectionPaginatorPages.get(j);
      const sz = s.size || 0;
      if (sz <= 0) return 1;
      const cps = charsPerScreenGuess();
      return Math.max(1, Math.round(sz / cps));
    }

    function sumScreensUpTo(beforeIndex) {
      let sum = 0;
      for (let j = 0; j < beforeIndex; j++) sum += textPagesForSection(j);
      return sum;
    }

    function totalScreensBook() {
      let t = 0;
      for (let j = 0; j < secs.length; j++) t += textPagesForSection(j);
      return Math.max(1, t);
    }

    const globalScreen0 = sumScreensUpTo(index) + screenInSection;
    const totalScreens = totalScreensBook();

    bookPagesEl.classList.remove('is-hidden');
    const rtl = view.language?.direction === 'rtl';
    const dual = S.layout === 'dual';

    let leftText;
    let rightText;
    if (dual) {
      const totalDisp = Math.max(1, totalScreens * 2);
      const leftP = 2 * globalScreen0 + 1;
      const rightP = Math.min(totalDisp, 2 * globalScreen0 + 2);
      leftText = String(leftP);
      rightText = String(rightP);
      if (rtl) [leftText, rightText] = [rightText, leftText];
    } else {
      leftText = String(globalScreen0 + 1);
      rightText = String(totalScreens);
      if (rtl) [leftText, rightText] = [rightText, leftText];
    }
    bookPageLeft.textContent = leftText;
    bookPageRight.textContent = rightText;
  }

  function applySettings() {
    document.documentElement.dataset.readerTheme = S.theme;
    document.body.dataset.readerTheme = S.theme;
    const bg = getEffectiveBgColor();
    document.body.style.background = bg;
    if (readerBody) readerBody.style.background = bg;
    saveSettings();
    if (view?.renderer) {
      view.renderer.setStyles?.(getBookCSS());
      view.renderer.setAttribute('flow', S.layout === 'scrolled' ? 'scrolled' : 'paginated');
      view.renderer.setAttribute('max-inline-size', S.layout === 'dual' ? Math.floor(innerWidth / 2) + 'px' : S.maxWidth + 'px');
      view.renderer.setAttribute('max-column-count', S.layout === 'dual' ? '2' : '1');
    }
    updateDayNightButton();
    if (view?.lastLocation) updateBookPageDisplay(view.lastLocation);
  }

  function applyPreset(name) {
    const p = presets[name]; if (!p) return;
    Object.assign(S, p);
    applySettings(); refreshSettingsUI();
  }

  function resetSettings() {
    S = { ...defaults };
    applySettings(); refreshSettingsUI(); toast(rt('readerJs.settingsReset'));
  }

  function getActivePreset() {
    return Object.entries(presets).find(([, p]) =>
      S.fontSize === p.fontSize && Math.abs(S.lineHeight - p.lineHeight) < 0.05
    )?.[0] || '';
  }

  /* ===== Utilities ===== */
  function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/books/' + encodeURIComponent(bookId) + path, opts).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function esc(s) { const d = document.createElement('div'); d.appendChild(document.createTextNode(s)); return d.innerHTML; }
  let toastTimer = null;
  function toast(msg) { if (!toastEl) return; toastEl.textContent = msg; toastEl.classList.add('is-visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2000); }
  const bmDateFmt = new Intl.DateTimeFormat(rLocale() === 'en' ? 'en-US' : 'ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  function fmtDate(v) { if (!v) return ''; const d = new Date(String(v).replaceAll(' ', 'T') + (String(v).includes('Z') ? '' : 'Z')); return Number.isNaN(d.getTime()) ? String(v) : bmDateFmt.format(d); }

  /* ===== Chrome (toolbar/footer) visibility =====
   * Листание: края страницы; центр — переключить хром (тап мышью, пером или тачем).
   * Горячие клавиши и кнопки в toolbar тоже открывают панели.
   * scheduleChromeHide — продлевает автоскрытие, если chrome уже виден (и панель закрыта). */
  const CHROME_AUTOHIDE_MS = () => (isTouch.matches ? 14000 : 9000);

  function setChromeVisible(show) {
    chromeVisible = show;
    document.body.classList.toggle('chrome-hidden', !(show || panelOverlay.classList.contains('is-open')));
  }
  /** Сбросить таймер скрытия, не показывая панели силой (если уже скрыты — ничего не делаем). */
  function scheduleChromeHide() {
    clearTimeout(chromeTimer);
    if (panelOverlay.classList.contains('is-open')) {
      setChromeVisible(true);
      return;
    }
    if (!chromeVisible) return;
    chromeTimer = setTimeout(() => setChromeVisible(false), CHROME_AUTOHIDE_MS());
  }
  /** Тап по центру поля: скрыто → показать и снова автоскрытие; уже видно → скрыть. */
  function toggleChromeFromCenterTap() {
    clearTimeout(chromeTimer);
    if (panelOverlay.classList.contains('is-open')) {
      setChromeVisible(true);
      return;
    }
    if (document.body.classList.contains('chrome-hidden')) {
      setChromeVisible(true);
      chromeTimer = setTimeout(() => setChromeVisible(false), CHROME_AUTOHIDE_MS());
    } else {
      setChromeVisible(false);
    }
  }

  /* ===== Progress ===== */
  let currentTocHref = '';
  let currentFraction = 0;

  function updateSeekbar() {
    if (!seekBar) return;
    seekBar.style.setProperty('--seek-pct', (currentFraction * 100).toFixed(1) + '%');
  }

  function setProgress(pct, tocItem) {
    pct = Math.max(0, Math.min(100, pct));
    currentFraction = pct / 100;
    if (seekBar) seekBar.value = currentFraction;
    const txt = Math.round(pct) + '%';
    if (pctLabel) pctLabel.textContent = txt;
    if (progressText) progressText.textContent = txt;
    if (tocItem?.label) {
      if (ftChapter) ftChapter.textContent = tocItem.label;
      if (toolbarChapter) toolbarChapter.textContent = tocItem.label;
    }
    currentTocHref = tocItem?.href || currentTocHref;
    updateTocHighlight();
    updateTocBtnState();
    updateSeekbar();
    if (activePanelTab === 'bookmarks' && panelOverlay.classList.contains('is-open')) updateBmCard();
  }

  /* ===== Seekbar ===== */
  let seekTimer = null;
  seekBar?.addEventListener('input', () => {
    const f = parseFloat(seekBar.value);
    if (pctLabel) pctLabel.textContent = Math.round(f * 100) + '%';
    seekBar.style.setProperty('--seek-pct', Math.round(f * 100) + '%');
    scheduleChromeHide();
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => { if (view && !isNaN(f)) view.goToFraction(f); }, 150);
  });

  /* ===== Position sync ===== */
  let syncTimer = null;
  let autoReadToastShown = false;
  function savePosition(cfi, pct) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      api('POST', '/position', { position: String(cfi), progress: pct })
        .then(r => {
          if (r && r.markedRead && !autoReadToastShown) {
            autoReadToastShown = true;
            toast(rt('readerJs.autoMarkedRead'));
          }
        })
        .catch(() => {});
    }, 1500);
  }
  async function loadSavedPosition() { try { const d = await api('GET', '/position'); return d?.position ? d : null; } catch { return null; } }

  /* ===== Auto-mark as read when finished ===== */
  // Handled server-side in position save endpoint when progress >= 95%

  /* ===== Bookmarks ===== */
  async function loadBookmarks() {
    try { const d = await api('GET', '/bookmarks'); bookmarksData = Array.isArray(d) ? d : []; } catch { bookmarksData = []; }
  }

  function addBookmark() {
    if (!view?.lastLocation) return;
    const loc = view.lastLocation;
    const pos = loc.cfi || '';
    const title = loc.tocItem?.label || rtp('readerJs.positionPct', { n: Math.round((loc.fraction ?? 0) * 100) });
    api('POST', '/bookmarks', { position: pos, title }).then(r => {
      if (r.ok) { toast(rt('readerJs.bookmarkAdded')); loadBookmarks().then(renderBmTab); }
    }).catch(() => {});
  }

  async function removeBookmark(id) { try { await api('DELETE', '/bookmarks/' + id); await loadBookmarks(); renderBmTab(); } catch {} }

  function goToBookmark(bm) { if (!view || !bm.position) return; view.goTo(bm.position).catch(console.error); closePanel(); }

  function getSnapshot() {
    const ch = (ftChapter?.textContent || toolbarChapter?.textContent || '').trim() || rt('readerJs.currentPos');
    return { chapter: ch, percent: Math.round(currentFraction * 100) };
  }

  function updateBmCard() {
    const c = $('bookmarks-content'); if (!c) return;
    const s = getSnapshot();
    const t = c.querySelector('.bm-current-title');
    const m = c.querySelector('.bm-current-meta');
    if (t) t.textContent = s.chapter;
    if (m) m.textContent = rtp('readerJs.pctOfBook', { n: s.percent });
  }

  function renderBmTab() {
    const c = $('bookmarks-content'); if (!c) return;
    const s = getSnapshot();
    let h = '<div class="bm-current-card"><div class="bm-current-kicker">' + esc(rt('readerJs.readingNow')) + '</div>' +
      '<div class="bm-current-title">' + esc(s.chapter) + '</div>' +
      '<div class="bm-current-meta">' + esc(rtp('readerJs.pctOfBook', { n: s.percent })) + '</div>' +
      '<button class="bm-primary-btn" id="bm-add-btn" type="button">' + esc(rt('readerJs.addBmBtn')) + '</button></div>';
    if (!bookmarksData.length) { h += '<div class="bm-empty">' + esc(rt('readerJs.noBookmarks')) + '</div>'; }
    else {
      const n = bookmarksData.length;
      h += '<div class="bm-section-title">' + esc(rtp('readerJs.savedBookmarks', { n, word: rPlural('bookmark', n) })) + '</div>';
      bookmarksData.forEach(bm => {
        h += '<div class="bm-item"><button class="bm-item-body" type="button" data-bm-go="' + bm.id + '">' +
          '<div class="bm-item-title">' + esc(bm.title || rt('readerJs.bookmarkFallback')) + '</div>' +
          '<div class="bm-item-date">' + esc(fmtDate(bm.createdAt)) + '</div></button>' +
          '<button class="bm-item-del" type="button" data-bm-del="' + bm.id + '" title="' + esc(rt('readerJs.delete')) + '">&times;</button></div>';
      });
    }
    c.innerHTML = h;
    c.querySelectorAll('[data-bm-go]').forEach(el => el.addEventListener('click', () => { const bm = bookmarksData.find(b => b.id === Number(el.dataset.bmGo)); if (bm) goToBookmark(bm); }));
    c.querySelectorAll('[data-bm-del]').forEach(el => el.addEventListener('click', () => removeBookmark(Number(el.dataset.bmDel))));
    $('bm-add-btn')?.addEventListener('click', addBookmark);
  }

  /* ===== TOC ===== */
  function updateTocHighlight() { document.querySelectorAll('.toc-item').forEach(el => el.classList.toggle('is-active', !!currentTocHref && el.dataset.tocHref === currentTocHref)); }
  function getTocIdx() { return tocData.findIndex(i => i.href === currentTocHref); }
  function updateTocBtnState() { const i = getTocIdx(); if (tocPrevBtn) tocPrevBtn.disabled = i <= 0; if (tocNextBtn) tocNextBtn.disabled = i === -1 || i >= tocData.length - 1; }
  function goTocIdx(i) { const item = tocData[i]; if (!item || !view) return; view.goTo(item.href).catch(console.error); if (panelOverlay.classList.contains('is-open') && activePanelTab === 'toc') closePanel(); }

  function renderTocTab() {
    const c = $('toc-content'); if (!c) return;
    if (!tocData.length) { c.innerHTML = '<div class="bm-empty">' + esc(rt('readerJs.tocNotFound')) + '</div>'; updateTocBtnState(); return; }
    const q = (tocSearchInput?.value || '').trim().toLowerCase();
    const items = q ? tocData.filter(i => (i.label || '').toLowerCase().includes(q)) : tocData;
    if (!items.length) { c.innerHTML = '<div class="bm-empty">' + esc(rt('readerJs.tocEmpty')) + '</div>'; updateTocBtnState(); return; }
    let h = '<ul class="toc-list">';
    items.forEach(i => { h += '<li class="toc-item toc-item-depth-' + (i.depth || 1) + '" data-toc-href="' + esc(i.href) + '" tabindex="0" role="button">' + esc(i.label) + '</li>'; });
    h += '</ul>';
    c.innerHTML = h;
    c.querySelectorAll('.toc-item').forEach(el => {
      const go = () => { if (view) view.goTo(el.dataset.tocHref).catch(console.error); closePanel(); };
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    updateTocHighlight(); updateTocBtnState();
  }

  /* ===== Panel ===== */
  function getPanelMeta(tab) {
    return {
      settings: { kicker: rt('readerJs.panelSettings'), title: rt('readerJs.panelSettingsTitle') },
      toc: { kicker: rt('readerJs.panelTocKicker'), title: rt('readerJs.panelTocTitle') },
      bookmarks: { kicker: rt('readerJs.panelBmKicker'), title: rt('readerJs.panelBmTitle') }
    }[tab] || { kicker: '', title: '' };
  }
  const triggerMap = { settings: $('btn-settings'), toc: $('btn-toc') };

  function refreshTriggers() {
    Object.entries(triggerMap).forEach(([k, el]) => {
      if (!el) return;
      const on = panelOverlay.classList.contains('is-open') && activePanelTab === k;
      el.classList.toggle('is-active', on);
    });
  }
  let panelHistoryPushed = false;
  function openPanel(tab) {
    const t = tab || 'toc';
    if (panelOverlay.classList.contains('is-open') && activePanelTab === t) { closePanel(); return; }
    const wasOpen = panelOverlay.classList.contains('is-open');
    panelOverlay.classList.add('is-open'); setChromeVisible(true); switchTab(t); refreshTriggers();
    if (!wasOpen && !panelHistoryPushed) { history.pushState({ readerPanel: true }, ''); panelHistoryPushed = true; }
  }
  function closePanelDirect() {
    panelOverlay.classList.remove('is-open');
    refreshTriggers();
    clearTimeout(chromeTimer);
    setChromeVisible(false);
  }
  function closePanel() {
    if (!panelOverlay.classList.contains('is-open')) return;
    closePanelDirect();
    if (panelHistoryPushed) { panelHistoryPushed = false; history.back(); }
  }
  function switchTab(tab) {
    activePanelTab = tab;
    panelTabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab));
    panelBodies.forEach(b => { const on = b.dataset.panelTab === tab; b.style.visibility = on ? '' : 'hidden'; b.style.position = on ? '' : 'absolute'; b.style.pointerEvents = on ? '' : 'none'; });
    const pm = getPanelMeta(tab);
    if (panelKickerEl) panelKickerEl.textContent = pm.kicker;
    if (panelTitleEl) panelTitleEl.textContent = pm.title;
    refreshTriggers();
    if (tab === 'settings') {
      void ensureTtsVoices().then(() => {
        try {
          populateTtsVoiceList();
        } catch (e) {
          console.warn(e);
        }
      });
    }
  }
  panelOverlay.addEventListener('click', e => { if (e.target === panelOverlay) closePanel(); });
  $('panel-close')?.addEventListener('click', closePanel);
  panelTabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /* Back gesture / back button closes panel instead of leaving */
  window.addEventListener('popstate', () => {
    if (panelOverlay.classList.contains('is-open')) {
      panelHistoryPushed = false;
      closePanelDirect();
    }
  });

  /* ===== Settings controls ===== */
  function bindSeg(sel, prop) {
    document.querySelectorAll(sel).forEach(btn => btn.addEventListener('click', () => {
      S[prop] = btn.dataset['set' + prop[0].toUpperCase() + prop.slice(1)];
      applySettings(); refreshSettingsUI();
    }));
  }
  function initSettings() {
    bindSeg('[data-set-theme]', 'theme');
    bindSeg('[data-set-layout]', 'layout');
    const fontSel = $('rs-font-family');
    if (fontSel) {
      fontSel.addEventListener('change', () => {
        S.font = fontSel.value;
        if (!(S.font in fontMap)) S.font = defaults.font;
        applySettings();
        refreshSettingsUI();
      });
    }
    document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
    $('reader-reset-settings')?.addEventListener('click', resetSettings);

    const textColorInput = $('rs-text-color');
    const textColorDefaultBtn = $('rs-text-color-default');
    if (textColorInput) {
      textColorInput.addEventListener('input', () => {
        S.textColor = textColorInput.value;
        applySettings();
      });
    }
    textColorDefaultBtn?.addEventListener('click', () => {
      S.textColor = '';
      applySettings();
      refreshSettingsUI();
    });

    const bgColorInput = $('rs-bg-color');
    const bgColorDefaultBtn = $('rs-bg-color-default');
    if (bgColorInput) {
      bgColorInput.addEventListener('input', () => {
        S.bgColor = bgColorInput.value;
        applySettings();
      });
    }
    bgColorDefaultBtn?.addEventListener('click', () => {
      S.bgColor = '';
      applySettings();
      refreshSettingsUI();
    });

    const wire = (id, valId, prop, fmt) => {
      const sl = $(id), vl = $(valId); if (!sl) return;
      sl.value = S[prop]; if (vl) vl.textContent = fmt ? fmt(S[prop]) : S[prop];
      sl.addEventListener('input', () => { S[prop] = Number(fmt ? Number(sl.value).toFixed(1) : sl.value); if (vl) vl.textContent = fmt ? fmt(S[prop]) : S[prop]; applySettings(); });
    };
    wire('rs-font-size', 'rs-font-size-val', 'fontSize');
    wire('rs-line-height', 'rs-line-height-val', 'lineHeight', v => Number(v).toFixed(1));

    const ttsRateEl = $('rs-tts-rate');
    const ttsRateVal = $('rs-tts-rate-val');
    if (ttsRateEl) {
      ttsRateEl.addEventListener('input', () => {
        S.ttsRate = Number(ttsRateEl.value);
        if (ttsRateVal) ttsRateVal.textContent = Number(S.ttsRate).toFixed(2);
        saveSettings();
      });
    }
    const ttsVoiceEl = $('rs-tts-voice');
    if (ttsVoiceEl) {
      ttsVoiceEl.addEventListener('change', () => {
        S.ttsVoice = ttsVoiceEl.value || '';
        saveSettings();
      });
    }
    if (window.speechSynthesis) {
      speechSynthesis.addEventListener('voiceschanged', () => {
        if (activePanelTab === 'settings') {
          try {
            populateTtsVoiceList();
          } catch { /* */ }
        }
      });
    }
  }

  function refreshSettingsUI() {
    const toggle = (sel, attr, val) => document.querySelectorAll(sel).forEach(b => b.classList.toggle('is-active', b.dataset[attr] === val));
    toggle('[data-set-theme]', 'setTheme', S.theme);
    toggle('[data-set-layout]', 'setLayout', S.layout);
    const fs = $('rs-font-family');
    if (fs) {
      if (!(S.font in fontMap)) S.font = defaults.font;
      fs.value = S.font;
    }
    const ap = getActivePreset();
    document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('is-active', b.dataset.preset === ap));
    const sync = (id, v) => { const el = $(id); if (el) el.value !== undefined ? el.value = v : el.textContent = v; };
    sync('rs-font-size', S.fontSize); sync('rs-font-size-val', S.fontSize);
    sync('rs-line-height', S.lineHeight); sync('rs-line-height-val', Number(S.lineHeight).toFixed(1));
    const tcEl = $('rs-text-color');
    if (tcEl) {
      const c = themeColors[S.theme] || themeColors.dark;
      const v = (S.textColor && /^#[0-9A-Fa-f]{6}$/.test(String(S.textColor).trim())) ? S.textColor.trim() : c.fg;
      if (tcEl.value !== v) tcEl.value = v;
    }
    const bgEl = $('rs-bg-color');
    if (bgEl) {
      const c = themeColors[S.theme] || themeColors.dark;
      const v = (S.bgColor && /^#[0-9A-Fa-f]{6}$/.test(String(S.bgColor).trim())) ? S.bgColor.trim() : c.bg;
      if (bgEl.value !== v) bgEl.value = v;
    }
    updateSeekbar();
    updateDayNightButton();
    const ttsR = $('rs-tts-rate');
    const ttsRV = $('rs-tts-rate-val');
    if (ttsR) {
      const r = Number(S.ttsRate);
      ttsR.value = String(Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : 1);
      if (ttsRV) ttsRV.textContent = Number(ttsR.value).toFixed(2);
    }
    const ttsV = $('rs-tts-voice');
    if (ttsV && S.ttsVoice && [...ttsV.options].some(o => o.value === S.ttsVoice)) ttsV.value = S.ttsVoice;
    else if (ttsV) ttsV.value = '';
  }

  /* ===== TTS (read aloud) ===== */
  function ssmlToPlain(ssmlStr) {
    if (!ssmlStr || typeof ssmlStr !== 'string') return '';
    try {
      const d = new DOMParser().parseFromString(ssmlStr, 'application/xml');
      if (d.querySelector('parsererror')) throw new Error('parse');
      return (d.documentElement.textContent || '').replace(/\s+/g, ' ').trim();
    } catch {
      return String(ssmlStr).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  /** Сегменты с mark → view.tts.setMark для подсветки (смысловые единицы из foliate). */
  function parseTtsSsmlSegments(ssmlStr) {
    if (!ssmlStr || typeof ssmlStr !== 'string') return [];
    const d = new DOMParser().parseFromString(ssmlStr, 'application/xml');
    if (d.querySelector('parsererror')) {
      const plain = ssmlToPlain(ssmlStr);
      return plain ? [{ mark: null, text: plain }] : [];
    }
    const root = d.documentElement;
    if (!root) return [];
    const parts = [];
    let buf = '';
    function markName(el) {
      return el.getAttribute('name') || el.getAttributeNS('http://www.w3.org/2001/10/synthesis', 'name') || '';
    }
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) buf += child.textContent;
        else if (child.nodeType === 1) {
          if (child.localName === 'mark') {
            const name = markName(child);
            const t = buf.replace(/\s+/g, ' ').trim();
            buf = '';
            if (t) parts.push({ mark: name || null, text: t });
          } else walk(child);
        }
      }
    }
    walk(root);
    const tail = buf.replace(/\s+/g, ' ').trim();
    if (tail) parts.push({ mark: null, text: tail });
    if (!parts.length) {
      const plain = ssmlToPlain(ssmlStr);
      if (plain) return [{ mark: null, text: plain }];
    }
    return parts;
  }

  function getReaderTtsLang() {
    const c = view?.renderer?.getContents?.()?.[0];
    const fromDoc = c?.doc?.documentElement?.lang;
    const fromMeta = view?.language?.canonical;
    const raw = (fromDoc || fromMeta || (rLocale() === 'en' ? 'en' : 'ru')).trim();
    if (!raw) return rLocale() === 'en' ? 'en-US' : 'ru-RU';
    if (raw.length === 2) return raw === 'en' ? 'en-US' : raw === 'ru' ? 'ru-RU' : raw;
    return raw;
  }

  function populateTtsVoiceList() {
    const sel = $('rs-tts-voice');
    if (!sel || !window.speechSynthesis) return;
    const voices = speechSynthesis.getVoices().slice();
    const pref = getReaderTtsLang().toLowerCase().split(/[-_]/)[0] || '';
    voices.sort((a, b) => {
      const la = (a.lang || '').toLowerCase();
      const lb = (b.lang || '').toLowerCase();
      const as = la.startsWith(pref) ? 0 : 1;
      const bs = lb.startsWith(pref) ? 0 : 1;
      if (as !== bs) return as - bs;
      if (a.localService !== b.localService) return a.localService ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
    });
    const keep = S.ttsVoice || '';
    sel.innerHTML = '';
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = rt('reader.ttsVoiceDefault');
    sel.appendChild(o0);
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name} (${v.lang || ''})`;
      sel.appendChild(o);
    }
    if (keep && [...sel.options].some((x) => x.value === keep)) sel.value = keep;
    else sel.value = '';
  }

  function applyTtsUtteranceSettings(u) {
    const r = Number(S.ttsRate);
    u.rate = Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : 1;
    const uri = S.ttsVoice && String(S.ttsVoice).trim();
    if (uri && window.speechSynthesis) {
      const v = speechSynthesis.getVoices().find((x) => x.voiceURI === uri);
      if (v) u.voice = v;
    }
  }

  function ensureTtsVoices() {
    return new Promise((resolve) => {
      try {
        if (!window.speechSynthesis) {
          resolve();
          return;
        }
        if (speechSynthesis.getVoices().length) {
          resolve();
          return;
        }
        speechSynthesis.addEventListener('voiceschanged', () => resolve(), { once: true });
        setTimeout(resolve, 400);
      } catch {
        resolve();
      }
    });
  }

  const TTS_PATH_PLAY = 'M8 5v14l11-7z';
  const TTS_PATH_PAUSE = 'M6 5h4v14H6zM14 5h4v14h-4z';

  /** Одна иконка в кнопке: только смена path (плей ↔ пауза). */
  function syncTtsMainIcon(host, playing) {
    if (!host) return;
    const path = host.querySelector('.tts-main-path');
    if (!path) return;
    path.setAttribute('d', playing ? TTS_PATH_PAUSE : TTS_PATH_PLAY);
  }

  function updateTtsButtons() {
    const playing = ttsChainActive && !ttsPausedByUser;
    const mainLabel = playing ? rt('reader.ttsPause') : rt('reader.tts');
    const mainTitle = playing ? rt('reader.ttsPause') : rt('reader.ttsPlay');
    if (btnTts) {
      btnTts.classList.toggle('is-active', playing);
      btnTts.title = mainTitle;
      btnTts.setAttribute('aria-label', mainLabel);
      syncTtsMainIcon(btnTts, playing);
    }
    if (btnTtsDock) {
      btnTtsDock.classList.toggle('is-active', playing);
      btnTtsDock.title = mainTitle;
      btnTtsDock.setAttribute('aria-label', mainLabel);
      syncTtsMainIcon(btnTtsDock, playing);
    }
    document.querySelectorAll('.js-tts-prev, .js-tts-next').forEach((b) => {
      b.disabled = !ttsChainActive;
    });
    if (ttsDockEl) {
      ttsDockEl.classList.toggle('is-visible', ttsChainActive);
      ttsDockEl.setAttribute('aria-hidden', ttsChainActive ? 'false' : 'true');
    }
    if (!ttsChainActive) pauseTtsKeepalive();
    syncTtsMediaSessionPlayback();
    if (ttsChainActive) syncTtsMediaMetadata();
  }

  function stopReaderTts() {
    ttsSpeakToken++;
    ttsNav.skipBack = () => {};
    ttsNav.skipForward = () => {};
    if (ttsStopLongPressTimer != null) {
      clearTimeout(ttsStopLongPressTimer);
      ttsStopLongPressTimer = null;
    }
    ttsStopLongPressPt = null;
    try {
      window.speechSynthesis?.cancel();
    } catch { /* */ }
    ttsChainActive = false;
    ttsPausedByUser = false;
    ttsAdvancingSection = false;
    updateTtsButtons();
  }

  /**
   * После окончания текста в секции — перелистнуть и продолжить озвучку.
   * @returns {Promise<boolean>} true если цепочка продолжена
   */
  async function advanceTtsToNextSection(depth) {
    if (!ttsChainActive || !view || depth > 14) return false;
    const prevCfi = view.lastLocation?.cfi;
    ttsAdvancingSection = true;
    try {
      await view.goRight();
    } catch (e) {
      console.warn(e);
      ttsAdvancingSection = false;
      return false;
    }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(tid);
        view.removeEventListener('load', onLoad);
        resolve();
      };
      const onLoad = () => finish();
      const tid = setTimeout(finish, 650);
      view.addEventListener('load', onLoad, { once: true });
    });
    ttsAdvancingSection = false;
    if (!ttsChainActive) return false;
    if (!view.lastLocation || view.lastLocation.cfi === prevCfi) return false;
    if (!view.renderer?.getContents?.()?.[0]?.doc?.body) return false;
    try {
      await view.initTTS('sentence', true);
    } catch (e) {
      console.warn(e);
      return advanceTtsToNextSection(depth + 1);
    }
    if (!view.tts) return false;
    let first;
    try {
      first = view.tts.start();
    } catch (e) {
      console.warn(e);
      first = null;
    }
    if (!first) {
      return advanceTtsToNextSection(depth + 1);
    }
    runTtsUtteranceChain(first);
    return true;
  }

  function runTtsUtteranceChain(initialSsml) {
    let parts = [];
    let idx = 0;
    let useInitialSsml = true;

    function finishTtsChain() {
      ttsChainActive = false;
      ttsPausedByUser = false;
      ttsNav.skipBack = () => {};
      ttsNav.skipForward = () => {};
      updateTtsButtons();
    }

    function ensureParts() {
      if (idx < parts.length) return true;
      const ssml = useInitialSsml ? (useInitialSsml = false, initialSsml) : view.tts.next();
      if (!ssml) return false;
      parts = parseTtsSsmlSegments(ssml);
      idx = 0;
      return true;
    }

    function speakStep() {
      if (!ttsChainActive || !view?.tts) {
        finishTtsChain();
        return;
      }
      if (!ensureParts()) {
        if (ttsChainActive) {
          void advanceTtsToNextSection(0).then((cont) => {
            if (!cont) finishTtsChain();
          });
        } else finishTtsChain();
        return;
      }
      while (idx < parts.length && !(parts[idx].text && String(parts[idx].text).trim())) idx++;
      if (idx >= parts.length) {
        requestAnimationFrame(speakStep);
        return;
      }
      const seg = parts[idx];
      if (seg.mark != null && String(seg.mark).length) {
        try {
          view.tts.setMark(String(seg.mark));
        } catch (e) {
          console.warn(e);
        }
      }
      const u = new SpeechSynthesisUtterance(seg.text);
      u.lang = getReaderTtsLang();
      applyTtsUtteranceSettings(u);
      const token = ttsSpeakToken;
      u.onend = () => {
        if (!ttsChainActive || token !== ttsSpeakToken) return;
        idx++;
        speakStep();
      };
      u.onerror = () => {
        if (!ttsChainActive || token !== ttsSpeakToken) return;
        idx++;
        speakStep();
      };
      try {
        speechSynthesis.speak(u);
      } catch (e) {
        console.warn(e);
        idx++;
        speakStep();
      }
      updateTtsButtons();
    }

    ttsNav.skipForward = () => {
      if (!ttsChainActive) return;
      ttsSpeakToken++;
      try {
        speechSynthesis.cancel();
      } catch { /* */ }
      idx++;
      requestAnimationFrame(speakStep);
    };

    ttsNav.skipBack = () => {
      if (!ttsChainActive) return;
      ttsSpeakToken++;
      try {
        speechSynthesis.cancel();
      } catch { /* */ }
      if (idx > 0) {
        idx--;
      } else {
        let prevSsml;
        try {
          prevSsml = view.tts.prev(true);
        } catch (e) {
          console.warn(e);
          prevSsml = null;
        }
        if (!prevSsml) {
          toast(rt('reader.ttsNoPrev'));
          requestAnimationFrame(speakStep);
          return;
        }
        parts = parseTtsSsmlSegments(prevSsml);
        idx = Math.max(0, parts.length - 1);
        while (idx > 0 && !(parts[idx].text && String(parts[idx].text).trim())) idx--;
      }
      requestAnimationFrame(speakStep);
    };

    speakStep();
  }

  async function startReaderTts() {
    if (!view || view.isFixedLayout) {
      toast(rt('reader.ttsFixedLayout'));
      return;
    }
    if (!window.speechSynthesis) {
      toast(rt('reader.ttsUnavailable'));
      return;
    }
    const contents = view.renderer.getContents();
    if (!contents?.length || !contents[0]?.doc?.body) {
      toast(rt('reader.ttsNoText'));
      return;
    }
    stopReaderTts();
    await ensureTtsVoices();
    try {
      await view.initTTS('sentence', true);
    } catch (e) {
      console.warn(e);
      toast(rt('reader.ttsNoText'));
      return;
    }
    if (!view.tts) {
      toast(rt('reader.ttsNoText'));
      return;
    }
    let firstSsml;
    try {
      const loc = view.lastLocation;
      if (loc?.range?.cloneRange) {
        firstSsml = view.tts.from(loc.range.cloneRange());
      } else {
        firstSsml = view.tts.start();
      }
    } catch (e) {
      console.warn(e);
      try {
        firstSsml = view.tts.start();
      } catch (e2) {
        console.warn(e2);
        firstSsml = null;
      }
    }
    if (!firstSsml) {
      toast(rt('reader.ttsNoText'));
      return;
    }
    initReaderMediaSessionHandlers();
    ttsChainActive = true;
    ttsPausedByUser = false;
    setChromeVisible(true);
    updateTtsButtons();
    void startTtsKeepalivePlayback();
    runTtsUtteranceChain(firstSsml);
  }

  function toggleReaderTts() {
    if (!ttsChainActive) {
      void startReaderTts();
      return;
    }
    if (ttsPausedByUser) {
      try {
        speechSynthesis.resume();
      } catch { /* */ }
      ttsPausedByUser = false;
    } else {
      try {
        speechSynthesis.pause();
      } catch { /* */ }
      ttsPausedByUser = true;
    }
    syncTtsKeepaliveWithSpeech();
    updateTtsButtons();
  }

  function clearTtsStopLongPressTimer() {
    if (ttsStopLongPressTimer != null) {
      clearTimeout(ttsStopLongPressTimer);
      ttsStopLongPressTimer = null;
    }
    ttsStopLongPressPt = null;
  }

  function wireTtsPrimaryControl(el) {
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      if (!ttsChainActive || e.shiftKey) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      clearTtsStopLongPressTimer();
      ttsStopLongPressPt = { x: e.clientX, y: e.clientY };
      ttsStopLongPressTimer = window.setTimeout(() => {
        ttsStopLongPressTimer = null;
        ttsStopLongPressPt = null;
        ttsStopLongPressConsumeClick = true;
        stopReaderTts();
        scheduleChromeHide();
      }, TTS_STOP_LONG_PRESS_MS);
    });
    el.addEventListener('pointermove', (e) => {
      if (ttsStopLongPressPt == null || ttsStopLongPressTimer == null) return;
      const dx = e.clientX - ttsStopLongPressPt.x;
      const dy = e.clientY - ttsStopLongPressPt.y;
      if (dx * dx + dy * dy > TTS_STOP_LONG_PRESS_SLOP_PX * TTS_STOP_LONG_PRESS_SLOP_PX) {
        clearTtsStopLongPressTimer();
      }
    });
    el.addEventListener('pointerup', () => clearTtsStopLongPressTimer());
    el.addEventListener('pointercancel', () => clearTtsStopLongPressTimer());
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') clearTtsStopLongPressTimer();
    });
    el.addEventListener('contextmenu', (e) => {
      if (ttsChainActive) e.preventDefault();
    });
    el.addEventListener('click', (ev) => {
      if (ttsStopLongPressConsumeClick) {
        ttsStopLongPressConsumeClick = false;
        ev.preventDefault();
        return;
      }
      if (ev.shiftKey && ttsChainActive) {
        stopReaderTts();
        scheduleChromeHide();
        return;
      }
      toggleReaderTts();
      scheduleChromeHide();
    });
  }
  wireTtsPrimaryControl(btnTts);
  wireTtsPrimaryControl(btnTtsDock);

  document.querySelectorAll('.js-tts-prev').forEach((btn) => {
    btn.addEventListener('click', () => {
      ttsNav.skipBack();
      scheduleChromeHide();
    });
  });
  document.querySelectorAll('.js-tts-next').forEach((btn) => {
    btn.addEventListener('click', () => {
      ttsNav.skipForward();
      scheduleChromeHide();
    });
  });

  /* ===== Toolbar buttons ===== */
  const btnFullscreen = $('btn-fullscreen');
  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }
  function updateFullscreenIcon() {
    if (!btnFullscreen) return;
    const isFs = !!document.fullscreenElement;
    btnFullscreen.innerHTML = isFs
      ? '<svg viewBox="0 0 24 24"><path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg>';
    btnFullscreen.title = isFs ? rt('readerJs.fullscreenExit') : rt('readerJs.fullscreenEnter');
  }
  btnFullscreen?.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', updateFullscreenIcon);

  $('btn-day-night')?.addEventListener('click', () => {
    toggleDayNightTheme();
    scheduleChromeHide();
  });

  $('btn-settings')?.addEventListener('click', () => openPanel('settings'));
  $('btn-toc')?.addEventListener('click', () => openPanel('toc'));
  $('btn-bookmark-add')?.addEventListener('click', addBookmark);
  tocSearchInput?.addEventListener('input', renderTocTab);
  tocPrevBtn?.addEventListener('click', () => goTocIdx(getTocIdx() - 1));
  tocNextBtn?.addEventListener('click', () => goTocIdx(getTocIdx() + 1));
  initSettings();
  refreshSettingsUI();
  refreshTriggers();
  initReaderMediaSessionHandlers();

  /* ===== Keyboard ===== */
  function handleKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (isFootnoteOverlayOpen()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeReaderFootnote();
      }
      return;
    }
    if (e.key === 'Escape') { closePanel(); return; }
    if (panelOverlay.classList.contains('is-open')) return;
    const k = e.key;
    if (k === 'd' || k === 'D') { toggleDayNightTheme(); return; }
    if (k === 'b' || k === 'B') { addBookmark(); return; }
    if (k === 'f' || k === 'F') { toggleFullscreen(); return; }
    if (k === 's' || k === 'S') { openPanel('settings'); return; }
    if (k === 't' || k === 'T') { openPanel('toc'); return; }
    if (k === 'v' || k === 'V') {
      e.preventDefault();
      if (e.shiftKey && ttsChainActive) {
        stopReaderTts();
        scheduleChromeHide();
        return;
      }
      toggleReaderTts();
      scheduleChromeHide();
      return;
    }
    if (k === '[') {
      e.preventDefault();
      ttsNav.skipBack();
      scheduleChromeHide();
      return;
    }
    if (k === ']') {
      e.preventDefault();
      ttsNav.skipForward();
      scheduleChromeHide();
      return;
    }
    if (k === 'ArrowLeft' || k === 'h') { e.preventDefault(); view?.goLeft(); }
    if (k === 'ArrowRight' || k === 'l' || k === ' ') { e.preventDefault(); view?.goRight(); }
  }
  document.addEventListener('keydown', handleKeydown);

  /* ===== Iframe event wiring (foliate Shadow DOM) ===== */
  /* ===== Сноски / примечания (как в Foliate: foliate-js FootnoteHandler) ===== */
  let footnoteHandler = null;

  function ensureFootnoteShell() {
    let el = $('reader-footnote-overlay');
    if (el) {
      return {
        overlay: el,
        body: el.querySelector('.reader-footnote-body'),
        closeBtn: el.querySelector('.reader-footnote-close'),
      };
    }
    el = document.createElement('div');
    el.id = 'reader-footnote-overlay';
    el.className = 'reader-footnote-overlay';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', rt('readerJs.footnote'));
    el.innerHTML =
      '<div class="reader-footnote-backdrop" tabindex="-1"></div>' +
      '<div class="reader-footnote-panel">' +
      '<button type="button" class="reader-footnote-close" aria-label="' + esc(rt('readerJs.close')) + '">&times;</button>' +
      '<div class="reader-footnote-body"></div>' +
      '</div>';
    document.body.appendChild(el);
    const body = el.querySelector('.reader-footnote-body');
    const closeBtn = el.querySelector('.reader-footnote-close');
    const backdrop = el.querySelector('.reader-footnote-backdrop');
    const close = () => closeReaderFootnote();
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    return { overlay: el, body, closeBtn };
  }

  function closeReaderFootnote() {
    const el = $('reader-footnote-overlay');
    if (!el || el.hidden) return;
    const body = el.querySelector('.reader-footnote-body');
    if (body) body.replaceChildren();
    el.hidden = true;
    document.body.classList.remove('reader-footnote-open');
  }

  function isFootnoteOverlayOpen() {
    const el = $('reader-footnote-overlay');
    return el && !el.hidden;
  }

  function findFootnoteTargetEl(doc, id) {
    if (!doc || !id) return null;
    let el = doc.getElementById(id);
    if (el) return el;
    try {
      el = doc.querySelector(`[name="${CSS.escape(id)}"]`);
    } catch { /* */ }
    if (el) return el;
    try {
      el = doc.querySelector(`[xml\\:id="${CSS.escape(id)}"]`);
    } catch { /* */ }
    return el || null;
  }

  function showFootnoteClonePopup(clonedNode) {
    const shell = ensureFootnoteShell();
    shell.body.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'reader-footnote-clone';
    const fg = getEffectiveTextColor();
    const ff = fontMap[S.font] || fontMap.serif;
    wrap.style.cssText =
      `color:${fg};background:transparent;font-family:${ff};font-size:${S.fontSize}px;line-height:${S.lineHeight};word-break:break-word;`;
    wrap.appendChild(clonedNode);
    shell.body.appendChild(wrap);
    shell.overlay.hidden = false;
    document.body.classList.add('reader-footnote-open');
  }

  /**
   * Сноска в том же XHTML, что и ссылка: не трогаем spine/второй foliate-view.
   * Срабатывает на href="#id" и на href="тот_же_файл.xhtml#id" в blob-документе.
   */
  function tryOpenSameDocumentFootnote(e) {
    const book = view?.book;
    const { a, href } = e.detail || {};
    if (!book || !a?.ownerDocument) return false;
    if (book.isExternal?.(href)) return false;
    const raw = (a.getAttribute('href') || '').trim();
    if (!raw) return false;

    const doc = a.ownerDocument;
    const docUrl = doc.documentURI || '';
    let fragId = '';

    if (raw.startsWith('#')) {
      try {
        fragId = decodeURIComponent(raw.slice(1));
      } catch {
        return false;
      }
    } else if (docUrl.startsWith('blob:')) {
      try {
        const abs = new URL(raw, docUrl);
        const base = new URL(docUrl);
        if (abs.origin !== base.origin || abs.pathname !== base.pathname || !abs.hash) return false;
        fragId = decodeURIComponent(abs.hash.slice(1));
      } catch {
        return false;
      }
    } else {
      return false;
    }

    if (!fragId) return false;
    const footEl = findFootnoteTargetEl(doc, fragId);
    if (!footEl || footEl === a || footEl.contains(a)) return false;

    e.preventDefault();
    showFootnoteClonePopup(footEl.cloneNode(true));
    return true;
  }

  /**
   * FB2 / EPUB: сноска в другой секции (другой blob). Второй foliate-view часто не в DOM
   * до load — клонируем из createDocument() целевой секции (как Foliate-попап).
   */
  function tryOpenSpineFootnoteClone(e) {
    const book = view?.book;
    const { a, href } = e.detail || {};
    if (!book?.resolveHref || !book.sections?.length || book.isExternal?.(href)) return false;
    const frag = footnoteTargetFragmentFromHref(href || '');
    if (!frag || !shouldTrySpineFootnoteClone(a, href)) return false;
    const resolved = book.resolveHref(`#${frag}`);
    if (!resolved) return false;
    let doc;
    try {
      doc = book.sections[resolved.index]?.createDocument?.();
    } catch {
      return false;
    }
    if (!doc) return false;
    let el = typeof resolved.anchor === 'function' ? resolved.anchor(doc) : null;
    if (!el) el = findFootnoteTargetEl(doc, frag);
    if (!el || el === a || el.contains?.(a)) return false;
    e.preventDefault();
    showFootnoteClonePopup(el.cloneNode(true));
    return true;
  }

  function wireFootnotes() {
    if (!view?.book) return;
    footnoteHandler = new FootnoteHandler();
    footnoteHandler.addEventListener('render', ({ detail }) => {
      const fnView = detail.view;
      if (!fnView) return;
      const shell = ensureFootnoteShell();
      shell.body.replaceChildren(fnView);
      try {
        fnView.renderer?.setAttribute?.('flow', 'scrolled');
        fnView.renderer?.setStyles?.(getBookCSS());
      } catch (err) {
        console.warn('[reader] footnote styles', err);
      }
      shell.overlay.hidden = false;
      document.body.classList.add('reader-footnote-open');
    });
    view.addEventListener('link', (e) => {
      if (tryOpenSameDocumentFootnote(e)) return;
      if (tryOpenSpineFootnoteClone(e)) return;
      footnoteHandler.handle(view.book, e);
    });
  }

  const readerWiredDocs = new WeakSet();

  function wireDoc(doc) {
    if (readerWiredDocs.has(doc)) return;
    readerWiredDocs.add(doc);

    doc.addEventListener('keydown', handleKeydown);

    let pinchStartDist = 0;
    let pinchStartSize = 0;
    function touchDistPinch(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }

    /* Тап по ссылке в режиме колонок: foliate на touchmove/touchend листает страницу и
     * перебивает клик; pointerup у нас срабатывает до click и зоны листания тоже мешают.
     * Не вызывать preventDefault на touchmove — иначе WebKit часто шлёт touchcancel, touchend
     * не обрабатывает жест, а synthetic click не вызывается. */
    const LINK_TAP_SLOP = 28;
    let linkTapTouch = null;
    const isFlowPaginated = () => S.layout !== 'scrolled';

    const TAP_EDGE = 0.28;
    /** Макс. сдвиг пальца для «тапа»; Foliate на touchmove листает при меньшем dx — см. touchmove cancel. */
    const TAP_SLOP_PX = 22;
    const TAP_MAX_MS = 700;
    /** Любой touchmove дальше — не тап (иначе после лёгкого drag Foliate touchend + наш тап = двойной сдвиг). */
    const TAP_CANCEL_MOVE_PX = 10;
    let screenTapTrack = null;

    /**
     * Зоны относительно видимого foliate-view на странице (как у экранного ридера), а не innerWidth iframe.
     * В foliate-js reader.js зон на doc нет — листание делает paginator; у нас добавлены края/центр для UI.
     * clientX/Y события в iframe — в системе вьюпорта iframe; переносим в координаты страницы через frameElement.
     */
    function tapZoneHost(clientX, clientY, doc_) {
      const win = doc_?.defaultView;
      const iframe = win?.frameElement;
      const host = view?.getBoundingClientRect?.();
      if (!iframe || !host?.width) return 'center';
      const fr = iframe.getBoundingClientRect();
      const px = fr.left + clientX;
      const py = fr.top + clientY;
      const rx = (px - host.left) / Math.max(1, host.width);
      const ry = (py - host.top) / Math.max(1, host.height);
      const fx = Math.max(0, Math.min(1, rx));
      const fy = Math.max(0, Math.min(1, ry));
      const el = doc_?.documentElement;
      const wm = (el && win?.getComputedStyle(el).writingMode || 'horizontal-tb').toLowerCase();
      if (wm.startsWith('vertical')) {
        if (fy < TAP_EDGE) return 'left';
        if (fy > 1 - TAP_EDGE) return 'right';
        return 'center';
      }
      if (fx < TAP_EDGE) return 'left';
      if (fx > 1 - TAP_EDGE) return 'right';
      return 'center';
    }

    function slopOk(t) {
      return Math.hypot(t.clientX - linkTapTouch.x, t.clientY - linkTapTouch.y) <= LINK_TAP_SLOP;
    }

    /* Любое касание по тексту = пользовательский жест; листание Foliate не всегда доходит до touchend с зонами. */
    doc.addEventListener(
      'touchstart',
      () => {
        void acquireReaderWakeLock();
      },
      { capture: true, passive: true }
    );

    function finishLinkTapFromTouch(e, a) {
      linkTapTouch = null;
      pinchStartDist = 0;
      e.stopImmediatePropagation();
      e.preventDefault();
      queueMicrotask(() => {
        if (a.isConnected) a.click();
      });
    }

    doc.addEventListener('touchstart', e => {
      if (!isFlowPaginated() || e.touches.length !== 1) {
        linkTapTouch = null;
        return;
      }
      const a = e.target.closest?.('a[href]');
      if (!a) {
        linkTapTouch = null;
        return;
      }
      const t = e.touches[0];
      linkTapTouch = { el: a, x: t.clientX, y: t.clientY };
    }, { capture: true, passive: true });

    doc.addEventListener('touchstart', e => {
      if (isFlowPaginated() && e.touches.length === 1 && !e.target.closest?.('a[href]')) {
        const t = e.touches[0];
        screenTapTrack = { x: t.clientX, y: t.clientY, t: Date.now() };
      } else {
        screenTapTrack = null;
      }
    }, { capture: true, passive: true });

    doc.addEventListener('touchmove', e => {
      if (!isFlowPaginated() || !screenTapTrack || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - screenTapTrack.x, t.clientY - screenTapTrack.y) > TAP_CANCEL_MOVE_PX) {
        screenTapTrack = null;
      }
    }, { capture: true, passive: true });

    /* Короткий тап: только preventDefault — foliate-paginator #onTouchEnd всё равно вызывается и
     * должен отработать (сброс #touchScrolled); при defaultPrevented foliate не делает snap().
     * Нельзя stopImmediatePropagation — иначе #onTouchEnd не выполняется и состояние ломается. */
    doc.addEventListener('touchend', e => {
      if (linkTapTouch) return;
      if (!isFlowPaginated()) return;
      if (isFootnoteOverlayOpen()) return;
      if (panelOverlay.classList.contains('is-open')) return;
      if (!screenTapTrack || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const dt = Date.now() - screenTapTrack.t;
      const adx = Math.abs(t.clientX - screenTapTrack.x);
      const ady = Math.abs(t.clientY - screenTapTrack.y);
      if (dt > TAP_MAX_MS || adx > TAP_SLOP_PX || ady > TAP_SLOP_PX) {
        screenTapTrack = null;
        return;
      }
      const z = tapZoneHost(t.clientX, t.clientY, doc);
      screenTapTrack = null;
      e.preventDefault();
      void acquireReaderWakeLock();
      if (z === 'center') toggleChromeFromCenterTap();
      else if (z === 'left') view?.goLeft();
      else view?.goRight();
    }, { capture: true, passive: false });

    doc.addEventListener('touchcancel', () => {
      screenTapTrack = null;
    }, { capture: true, passive: true });

    doc.addEventListener('touchmove', e => {
      if (!linkTapTouch) return;
      if (e.touches.length !== 1) {
        linkTapTouch = null;
        return;
      }
      const t = e.touches[0];
      if (!slopOk(t)) {
        linkTapTouch = null;
        return;
      }
      e.stopImmediatePropagation();
    }, { capture: true, passive: false });

    doc.addEventListener('touchend', e => {
      if (!linkTapTouch) return;
      if (e.changedTouches.length !== 1) {
        linkTapTouch = null;
        return;
      }
      const t = e.changedTouches[0];
      if (!slopOk(t)) {
        linkTapTouch = null;
        return;
      }
      finishLinkTapFromTouch(e, linkTapTouch.el);
    }, { capture: true, passive: false });

    doc.addEventListener('touchcancel', e => {
      if (!linkTapTouch || e.changedTouches.length !== 1) {
        linkTapTouch = null;
        return;
      }
      const t = e.changedTouches[0];
      if (!slopOk(t)) {
        linkTapTouch = null;
        return;
      }
      finishLinkTapFromTouch(e, linkTapTouch.el);
    }, { capture: true, passive: false });

    let pStart = null;
    let pointerDownOnLink = false;

    doc.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      pointerDownOnLink = !!e.target.closest?.('a[href]');
      pStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    });

    doc.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        pinchStartDist = touchDistPinch(e.touches);
        pinchStartSize = S.fontSize;
      }
    }, { passive: true });
    doc.addEventListener('touchmove', e => {
      if (e.touches.length !== 2 || !pinchStartDist) return;
      e.preventDefault();
      const ratio = touchDistPinch(e.touches) / pinchStartDist;
      const dampened = 1 + (ratio - 1) * 0.35;
      const newSize = Math.round(Math.min(32, Math.max(12, pinchStartSize * dampened)));
      if (newSize !== S.fontSize) { S.fontSize = newSize; applySettings(); refreshSettingsUI(); }
    }, { passive: false });
    doc.addEventListener('touchend', () => { pinchStartDist = 0; }, { passive: true });

    doc.addEventListener('pointerup', e => {
      /* Тач: зоны только в capture-touchend (ниже). Иначе pointerup и touchend оба листают —
       * порядок событий между ними не гарантирован (PE + Touch Events). */
      if (e.pointerType === 'touch') {
        pStart = null;
        pointerDownOnLink = false;
        return;
      }
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
        pStart = null;
        pointerDownOnLink = false;
        return;
      }
      if (!pStart || e.button !== 0) {
        pointerDownOnLink = false;
        return;
      }
      const fromLink = pointerDownOnLink;
      pointerDownOnLink = false;
      const startX = pStart.x, startY = pStart.y, startT = pStart.t;
      const dx = e.clientX - startX, dy = e.clientY - startY, dt = Date.now() - startT;
      pStart = null;

      const adx = Math.abs(dx), ady = Math.abs(dy);
      /* Мышь: горизонтальный свайп с любого места (как у многих десктоп-ридеров). Перо: только с края — иначе мешает выделению. */
      if (adx > 30 && adx > ady * 2 && dt < 800) {
        if (e.pointerType === 'mouse') {
          if (dx < 0) view?.goRight(); else view?.goLeft();
          void acquireReaderWakeLock();
          return;
        }
        if (e.pointerType === 'pen') {
          const zStart = tapZoneHost(startX, startY, doc);
          if (zStart === 'left' || zStart === 'right') {
            if (dx < 0) view?.goRight(); else view?.goLeft();
            void acquireReaderWakeLock();
            return;
          }
        }
      }

      if (dt > TAP_MAX_MS || adx > TAP_SLOP_PX || ady > TAP_SLOP_PX) return;
      /* Не отсекаем по getSelection(): после relocate foliate может оставить несвёрнутый range —
       * короткий тап с малым сдвигом уже отфильтрован выше. */
      if (fromLink) return;

      const z = tapZoneHost(e.clientX, e.clientY, doc);
      if (z === 'left') {
        view?.goLeft();
        void acquireReaderWakeLock();
      } else if (z === 'right') {
        view?.goRight();
        void acquireReaderWakeLock();
      } else {
        toggleChromeFromCenterTap();
        void acquireReaderWakeLock();
      }
    });

    const WHEEL_FLIP_PX = 28;
    doc.addEventListener('wheel', e => {
      if (panelOverlay.classList.contains('is-open')) return;
      if (S.layout === 'scrolled') return;
      if (e.ctrlKey || e.metaKey) return;
      const dy = e.deltaY;
      const dx = e.deltaX;
      const mag = Math.hypot(dx, dy);
      if (e.deltaMode === 0 && mag < WHEEL_FLIP_PX) return;
      e.preventDefault();
      const dominant = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      if (dominant > 0) view?.goRight();
      else if (dominant < 0) view?.goLeft();
      void acquireReaderWakeLock();
    }, { passive: false });

  }

  /* ===== Build TOC ===== */
  function buildToc(toc, depth) {
    if (!toc) return;
    for (const item of toc) {
      tocData.push({ href: item.href, label: (item.label || '').trim(), depth });
      if (item.subitems?.length) buildToc(item.subitems, depth + 1);
    }
  }

  /* ===== Error ===== */
  function showError(msg) {
    bookPagesEl?.classList.add('is-hidden');
    readerBody.innerHTML = '<div class="reader-error"><div class="reader-error-title">' + esc(rt('readerJs.errorTitle')) + '</div>' +
      '<div class="reader-error-text">' + esc(msg) + '</div>' +
      '<a href="/book/' + encodeURIComponent(bookId) + '" class="tb-btn" style="margin-top:12px;">' + esc(rt('readerJs.back')) + '</a></div>';
  }

  /* ===== Main ===== */
  async function loadBook() {
    stopReaderTts();
    invalidateBookPageCache();
    bookPagesEl?.classList.add('is-hidden');
    closeReaderFootnote();
    footnoteHandler = null;

    const url = '/api/books/' + encodeURIComponent(bookId) + '/content/book.' + bookExt.toLowerCase();
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(rtp('readerJs.loadError', { status: res.status }));
    const file = new File([await res.blob()], 'book.' + bookExt.toLowerCase());

    view = document.createElement('foliate-view');
    readerBody.replaceChildren(view);
    await view.open(file);

    view.renderer.setStyles?.(getBookCSS());
    view.renderer.setAttribute('flow', S.layout === 'scrolled' ? 'scrolled' : 'paginated');
    view.renderer.setAttribute('max-inline-size', S.layout === 'dual' ? Math.floor(innerWidth / 2) + 'px' : S.maxWidth + 'px');
    view.renderer.setAttribute('max-column-count', S.layout === 'dual' ? '2' : '1');

    view.addEventListener('load', ({ detail: { doc } }) => {
      if (!ttsAdvancingSection) stopReaderTts();
      wireDoc(doc);
    });

    wireFootnotes();

    view.addEventListener('relocate', ({ detail }) => {
      const pct = (detail.fraction ?? 0) * 100;
      setProgress(pct, detail.tocItem);
      updateBookPageDisplay(detail);
      if (detail.cfi) savePosition(detail.cfi, pct);
      const why = detail.reason;
      if (why === 'snap' || why === 'page' || why === 'navigation') {
        try { view.deselect?.(); } catch { /* */ }
      }
    });

    if (view.book?.toc) { tocData = []; buildToc(view.book.toc, 1); }
    renderTocTab(); updateTocBtnState();

    const urlPos = new URLSearchParams(location.search).get('pos');
    if (urlPos) {
      try { await view.goTo(urlPos); } catch { await view.renderer.next(); }
    } else {
      const saved = await loadSavedPosition();
      if (saved?.position) {
        try { await view.goTo(saved.position); } catch { await view.renderer.next(); }
      } else { await view.renderer.next(); }
    }
    clearTimeout(chromeTimer);
    setChromeVisible(false);
    void acquireReaderWakeLock();
  }

  /* Две колонки: при ресайзе окна пересчитать ширину колонки (без лишнего saveSettings). */
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!view?.renderer) return;
      view.renderer.setAttribute(
        'max-inline-size',
        S.layout === 'dual' ? `${Math.floor(innerWidth / 2)}px` : `${S.maxWidth}px`
      );
      if (view.lastLocation) updateBookPageDisplay(view.lastLocation);
    }, 120);
  });

  /* ===== Boot ===== */
  applySettings();
  (async () => {
    try {
      await loadBookmarks(); renderBmTab();
      await loadBook();
    } catch (e) {
      console.error(e);
      showError(e.message || rt('readerJs.loadBookFail'));
    }
  })();
})();
