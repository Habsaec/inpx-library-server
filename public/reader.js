import '/foliate/view.js?v=tts-hl1';
import { Overlayer } from '/foliate/overlayer.js?v=fb2seek4';
import {
  FootnoteHandler,
  footnoteTargetFragmentFromHref,
  shouldTrySpineFootnoteClone,
} from '/foliate/footnotes.js?v=fb2seek4';
import {
  buildCrossDevicePromptLines,
  savedFraction as sharedSavedFraction,
  IDLE_MS,
  isUserPositionSaveReason,
} from '/position-sync.js';
import {
  normalizeFraction,
  fractionToProgress,
  foliateIdFromRange,
  resolveFb2Href,
  positionFromLocation as sharedPositionFromLocation,
} from '/reader-shared/reader-position.js';
import { createSuppressionCounter } from '/reader-shared/suppression-counter.js';
import {
  acceptPositionSave,
  acceptServerPosition,
  decidePositionOnOpen,
  dismissServerPosition,
  hasMeaningfulPosition,
  markPositionDirty,
  normalizeSeenContext,
  observeServerConflict,
  POSITION_VERSION,
  positionFields,
  shouldPromptLiveCrossDevice,
  shouldRetryPositionConflict,
  adoptConflictBaseRevision,
} from '/reader-shared/position-revision.js';
import {
  TAP_ZONE_IDS,
  TAP_ACTIONS,
  defaultTapZonesShort,
  defaultTapZonesLong,
  normalizeTapZones,
  resolveTapZone9,
} from '/tap-zones.js';

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
  let effectiveBookExt = bookExt;
  const READER_LITE = Boolean(window.__READER_LITE);
  const SETTINGS_STORAGE_KEY = READER_LITE ? 'reader-settings-lite' : 'reader-settings';
  const readerSessionId = (() => {
    try {
      return crypto.randomUUID();
    } catch {
      return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  })();
  let lastUserActivityAt = Date.now();

  function readerBookPagePath() {
    if (window.__READER_BOOK_PAGE_PATH) return window.__READER_BOOK_PAGE_PATH;
    return globalThis.bookPagePath ? globalThis.bookPagePath(bookId) : `/book/${encodeURIComponent(bookId)}`;
  }
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
  const btnTtsStop = $('btn-tts-stop');
  const btnTtsDockStop = $('btn-tts-dock-stop');
  const ttsDockEl = $('reader-tts-dock');
  const bookPagesEl = $('reader-book-pages');
  const bookPageLeft = $('book-page-left');
  const bookPageRight = $('book-page-right');

  const isTouch = window.matchMedia('(pointer: coarse)');

  /**
   * ===== Screen Wake Lock =====
   * Экран не гаснет во время чтения (Chrome/Android, Safari 16.4+, нужен HTTPS).
   * Во время TTS удержание экрана ОБЯЗАТЕЛЬНО: на Android Chrome останавливает
   * SpeechSynthesis на уровне платформы, как только у страницы пропадает видимое окно
   * (TtsPlatformImpl в Chromium игнорирует речь фоновых/невидимых вкладок) — никакой
   * аудио-keepalive или Media Session это не обходят. Поэтому пока идёт озвучка,
   * держим wake lock, чтобы экран не гас сам по таймауту бездействия. Против ручной
   * блокировки экрана (кнопка питания) Wake Lock API бессилен — это ограничение ОС/Chrome.
   */
  let wakeLock = null;
  async function acquireReaderWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        if (document.visibilityState === 'visible') void acquireReaderWakeLock();
      });
    } catch {
      /* Нет активного жеста пользователя, запрет ОС (энергосбережение) или API недоступен */
    }
  }
  function releaseReaderWakeLock() {
    try {
      wakeLock?.release();
    } catch { /* */ }
    wakeLock = null;
  }
  function clearTtsBackgroundMaintain() {
    if (ttsBgMaintainTimer != null) {
      clearInterval(ttsBgMaintainTimer);
      ttsBgMaintainTimer = null;
    }
  }

  /**
   * Пока страница скрыта (ручная блокировка экрана / переход в другое приложение — Wake Lock
   * это не предотвращает), синтез речи на Android всё равно не работает. Раньше здесь
   * форсировался переход к следующему сегменту по таймауту простоя — из-за этого отменённая
   * платформой фраза мгновенно дёргала onend/onerror и цепочка проматывала книгу вперёд
   * (иногда на главы), пока не находилась в невидимой вкладке. Теперь просто поддерживаем
   * keepalive/Media Session и ждём возврата видимости — сегмент, прерванный платформой,
   * не пропускается (guard на document.visibilityState в onend/onerror), а повторяется.
   */
  function maintainTtsInBackground() {
    clearTtsBackgroundMaintain();
    if (!ttsChainActive || ttsPausedByUser) return;
    const tick = () => {
      if (!ttsChainActive || ttsPausedByUser || document.visibilityState === 'visible') {
        clearTtsBackgroundMaintain();
        return;
      }
      void startTtsKeepalivePlayback();
      syncTtsMediaSessionPlayback();
    };
    tick();
    ttsBgMaintainTimer = setInterval(tick, 2000);
  }

  /** Возврат из фона/разблокировка: если платформа прервала фразу без реальной озвучки — повторяем её, а не пропускаем. */
  function resumeTtsAfterHidden() {
    if (!ttsChainActive || ttsPausedByUser) return;
    if (speechSynthesis.speaking || speechSynthesis.pending) return;
    try { ttsKickSpeak?.(); } catch (e) { console.warn('[reader TTS resume]', e); }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clearTtsBackgroundMaintain();
      void acquireReaderWakeLock();
      if (ttsChainActive && !ttsPausedByUser) {
        void startTtsKeepalivePlayback();
        try { speechSynthesis.resume(); } catch { /* */ }
        resumeTtsAfterHidden();
      }
    } else if (ttsChainActive && !ttsPausedByUser) {
      maintainTtsInBackground();
    } else {
      releaseReaderWakeLock();
    }
  });
  window.addEventListener('pagehide', () => {
    if (ttsChainActive && !ttsPausedByUser) {
      void startTtsKeepalivePlayback();
      maintainTtsInBackground();
    } else {
      releaseReaderWakeLock();
    }
  });
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
  let ttsBgMaintainTimer = null;
  let ttsKickSpeak = null;
  let lastTtsSpeechAt = 0;
  let tocData = [];
  let bookmarksData = [];
  let annotationsData = [];
  let searchSeq = 0;
  let searchDebounce = null;
  const docIndexMap = new WeakMap();
  let activeSel = null;
  let chromeVisible = false;
  let chromeTimer = null;
  let activePanelTab = 'toc';

  /**
   * Едва слышимый зацикленный WAV (Blob URL), чтобы ОС считала вкладку «воспроизводящей медиа» —
   * помогает пережить выключение экрана (Chrome/Android; на iOS не гарантировано).
   * Важно: сэмплы НЕ должны быть полной цифровой тишиной (все нули) — Chrome/Android определяют
   * «слышимость» по реальному уровню сигнала (RMS) и не выдают вкладке медиа-сессию/foreground-статус
   * для абсолютно пустого потока, из-за чего страница всё равно замораживается при блокировке экрана.
   * Поэтому пишем очень тихий низкочастотный тон (почти не воспроизводится динамиком телефона).
   */
  function createSilentWavKeepaliveUrl() {
    const sampleRate = 8000;
    const numSamples = Math.floor(sampleRate * 1);
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
    /** ~-36 dBFS, 30 Гц: заметно выше типичного порога «тишины» у браузера, но ниже слышимого баса большинства динамиков. */
    const amplitude = 500;
    const freqHz = 30;
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.round(amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
      v.setInt16(o, sample, true);
      o += 2;
    }
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function ensureTtsKeepaliveEl() {
    if (ttsKeepaliveEl) return ttsKeepaliveEl;
    if (!ttsKeepaliveUrl) ttsKeepaliveUrl = createSilentWavKeepaliveUrl();
    const a = document.createElement('audio');
    a.setAttribute('playsinline', '');
    a.setAttribute('webkit-playsinline', 'true');
    a.playsInline = true;
    a.setAttribute('aria-hidden', 'true');
    a.loop = true;
    a.volume = 0.15;
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
    return [S.font, S.fontSize, S.fontWeight, S.lineHeight, S.maxWidth, S.maxBlockSize, S.pageMargin, S.verticalMargin, S.columnGap, layoutMode(), innerWidth, innerHeight].join('|');
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
    theme: 'sepia', font: 'serif', fontSize: 18, lineHeight: 1.6,
    pageMargin: 32, verticalMargin: 32, columnGap: 7, maxWidth: 99999, maxBlockSize: 1440,
    layout: 'paginated', textColor: '', bgColor: '', linkColor: '',
    justify: true, hyphenate: true,
    usePublisherFont: false, fontWeight: 400,
    letterSpacing: 0, paragraphSpacing: 0.4, textIndent: 0,
    ttsRate: 1, ttsVoice: '', chromePinned: false,
    tapZonesShort: defaultTapZonesShort(),
    tapZonesLong: defaultTapZonesLong(),
  };
  let tapEditMode = 'short';
  let tapEditSelected = 'mm';
  const SYSTEM_FONTS = {
    serif: { label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
    palatino: { label: 'Palatino', stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
    times: { label: 'Times New Roman', stack: '"Times New Roman", Times, "Liberation Serif", "Noto Serif", serif' },
    charter: { label: 'Charter', stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif' },
    sans: { label: 'System UI', stack: '-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif' },
    verdana: { label: 'Verdana', stack: 'Verdana, Geneva, "DejaVu Sans", sans-serif' },
    arial: { label: 'Arial', stack: 'Arial, Helvetica, "Helvetica Neue", sans-serif' },
    mono: { label: 'Monospace', stack: '"Cascadia Code", "Fira Code", Consolas, "Liberation Mono", monospace' },
  };
  const GOOGLE_FONTS = {
    'gf-pt-serif': { label: 'PT Serif', family: 'PT Serif', weights: '400;700', stack: '"PT Serif", Georgia, serif' },
    'gf-pt-sans': { label: 'PT Sans', family: 'PT Sans', weights: '400;700', stack: '"PT Sans", system-ui, sans-serif' },
    'gf-literata': { label: 'Literata', family: 'Literata', weights: '400;700', stack: '"Literata", Georgia, serif' },
    'gf-merriweather': { label: 'Merriweather', family: 'Merriweather', weights: '400;700', stack: '"Merriweather", Georgia, serif' },
    'gf-noto-serif': { label: 'Noto Serif', family: 'Noto Serif', weights: '400;700', stack: '"Noto Serif", Georgia, serif' },
    'gf-eb-garamond': { label: 'EB Garamond', family: 'EB Garamond', weights: '400;700', stack: '"EB Garamond", Georgia, serif' },
    'gf-spectral': { label: 'Spectral', family: 'Spectral', weights: '400;700', stack: '"Spectral", Georgia, serif' },
    'gf-ibm-plex-serif': { label: 'IBM Plex Serif', family: 'IBM Plex Serif', weights: '400;700', stack: '"IBM Plex Serif", Georgia, serif' },
    'gf-roboto': { label: 'Roboto', family: 'Roboto', weights: '400;700', stack: '"Roboto", system-ui, sans-serif' },
    'gf-fira-sans': { label: 'Fira Sans', family: 'Fira Sans', weights: '400;700', stack: '"Fira Sans", system-ui, sans-serif' },
    'gf-ibm-plex-sans': { label: 'IBM Plex Sans', family: 'IBM Plex Sans', weights: '400;700', stack: '"IBM Plex Sans", system-ui, sans-serif' },
    'gf-commissioner': { label: 'Commissioner', family: 'Commissioner', weights: '400;700', stack: '"Commissioner", system-ui, sans-serif' },
  };
  const fontMap = Object.fromEntries([
    ...Object.entries(SYSTEM_FONTS).map(([k, v]) => [k, v.stack]),
    ...Object.entries(GOOGLE_FONTS).map(([k, v]) => [k, v.stack]),
  ]);
  const loadedGoogleFonts = new Set();
  function googleFontCssUrl(def) {
    const family = def.family.trim().replace(/\s+/g, '+');
    return `https://fonts.googleapis.com/css2?family=${family}:wght@${def.weights || '400;700'}&display=swap`;
  }
  function ensureGoogleFont(key) {
    const def = GOOGLE_FONTS[key];
    if (!def || loadedGoogleFonts.has(key)) return;
    loadedGoogleFonts.add(key);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = googleFontCssUrl(def);
    document.head.appendChild(link);
  }
  function ensureGoogleFontInDoc(doc, key) {
    const def = GOOGLE_FONTS[key];
    if (!def || !doc?.head) return Promise.resolve();
    const id = `reader-gf-${key}`;
    const existing = doc.getElementById(id);
    if (existing) {
      return existing.dataset.loaded === '1'
        ? (doc.fonts?.ready ?? Promise.resolve())
        : new Promise(resolve => {
          existing.addEventListener('load', () => resolve(doc.fonts?.ready), { once: true });
          existing.addEventListener('error', () => resolve(), { once: true });
        });
    }
    return new Promise(resolve => {
      const link = doc.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = googleFontCssUrl(def);
      link.addEventListener('load', () => {
        link.dataset.loaded = '1';
        resolve(doc.fonts?.ready);
      }, { once: true });
      link.addEventListener('error', () => resolve(), { once: true });
      doc.head.appendChild(link);
    });
  }
  function syncReaderGoogleFont(doc) {
    const key = S.font;
    if (!GOOGLE_FONTS[key]) return Promise.resolve();
    ensureGoogleFont(key);
    const bookDoc = doc || view?.renderer?.getContents?.()?.[0]?.doc;
    if (!bookDoc) return Promise.resolve();
    return ensureGoogleFontInDoc(bookDoc, key);
  }
  function populateFontSelect() {
    const sel = $('rs-font-family');
    if (!sel) return;
    const cur = S.font;
    sel.replaceChildren();
    const addGroup = (label, entries) => {
      const og = document.createElement('optgroup');
      og.label = label;
      for (const [key, def] of entries) {
        const o = document.createElement('option');
        o.value = key;
        o.textContent = def.label;
        og.appendChild(o);
      }
      sel.appendChild(og);
    };
    addGroup(rt('reader.fontSystem'), Object.entries(SYSTEM_FONTS));
    addGroup(rt('reader.fontGoogle'), Object.entries(GOOGLE_FONTS));
    if (!(cur in fontMap)) S.font = defaults.font;
    sel.value = S.font;
  }
  function readerSideMarginPx() {
    return Math.max(0, Math.min(80, Number(S.pageMargin) || 0));
  }
  function readerViewportWidth() {
    return readerBody?.clientWidth ?? innerWidth;
  }
  function readerContentWidth() {
    return Math.max(320, readerViewportWidth() - 2 * readerSideMarginPx());
  }
  function resolveMaxInlineSizePx() {
    const w = readerContentWidth();
    if (layoutMode() === 'dual') return Math.floor(w / 2);
    if (Number(S.maxWidth) >= 9000) return w;
    return Math.max(320, Math.min(Number(S.maxWidth) || 720, w));
  }
  function layoutMode() {
    if (S.layout === 'scrolled') return 'scrolled';
    if (mobileMq.matches) return 'paginated';
    return S.layout;
  }

  function applyRendererLayout() {
    if (!view?.renderer) return;
    invalidateBookPageCache();
    const side = readerSideMarginPx();
    const gapPct = Math.max(0, Math.min(20, Number(S.columnGap) || 0));
    const vert = Math.max(0, Math.min(96, Number(S.verticalMargin) || 0));
    const mode = layoutMode();
    view.style.boxSizing = 'border-box';
    view.style.paddingInline = side ? `${side}px` : '';
    view.renderer.setAttribute('margin', `${vert}px`);
    // Single-column: gap would add side padding; horizontal margins use paddingInline only.
    view.renderer.setAttribute('gap', mode === 'dual' ? `${gapPct}%` : '0%');
    view.renderer.setAttribute('max-inline-size', `${resolveMaxInlineSizePx()}px`);
    view.renderer.setAttribute('max-column-count', mode === 'dual' ? '2' : '1');
    view.renderer.setAttribute('flow', mode === 'scrolled' ? 'scrolled' : 'paginated');
    if (mode === 'scrolled') {
      view.renderer.setAttribute('max-block-size', `${Math.round(S.maxBlockSize || defaults.maxBlockSize)}px`);
    } else {
      view.renderer.removeAttribute('max-block-size');
    }
  }
  function isFullWidth() {
    return Number(S.maxWidth) >= 9000;
  }
  let S = {};
  function loadSettings() {
    try { S = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'); } catch { S = {}; }
    for (const k of Object.keys(defaults)) if (S[k] === undefined) S[k] = defaults[k];
    if (READER_LITE) {
      S.theme = 'eink';
      S.textColor = '';
      S.bgColor = '';
      if (!localStorage.getItem(SETTINGS_STORAGE_KEY)) {
        S.fontSize = 21;
        S.lineHeight = 1.7;
        S.pageMargin = 24;
        S.font = 'serif';
        S.layout = 'paginated';
        S.textColor = '';
        S.bgColor = '';
      }
    }
    if (!['paginated', 'dual', 'scrolled'].includes(S.layout)) S.layout = defaults.layout;
    if (typeof S.justify !== 'boolean') S.justify = defaults.justify;
    if (typeof S.hyphenate !== 'boolean') S.hyphenate = defaults.hyphenate;
    if (typeof S.usePublisherFont !== 'boolean') S.usePublisherFont = defaults.usePublisherFont;
    if (S.textColor && !/^#[0-9A-Fa-f]{6}$/.test(String(S.textColor).trim())) S.textColor = '';
    if (S.bgColor && !/^#[0-9A-Fa-f]{6}$/.test(String(S.bgColor).trim())) S.bgColor = '';
    if (S.linkColor && !/^#[0-9A-Fa-f]{6}$/.test(String(S.linkColor).trim())) S.linkColor = '';
    if (!(S.font in fontMap)) S.font = defaults.font;
    const pm = Number(S.pageMargin);
    S.pageMargin = Number.isFinite(pm) ? Math.min(80, Math.max(0, Math.round(pm))) : defaults.pageMargin;
    const vm = Number(S.verticalMargin);
    S.verticalMargin = Number.isFinite(vm) ? Math.min(96, Math.max(0, Math.round(vm))) : defaults.verticalMargin;
    const cg = Number(S.columnGap);
    S.columnGap = Number.isFinite(cg) ? Math.min(20, Math.max(0, Math.round(cg))) : defaults.columnGap;
    const mw = Number(S.maxWidth);
    S.maxWidth = Number.isFinite(mw) ? mw : defaults.maxWidth;
    const mbs = Number(S.maxBlockSize);
    S.maxBlockSize = Number.isFinite(mbs) ? Math.min(2400, Math.max(720, Math.round(mbs))) : defaults.maxBlockSize;
    const fw = Number(S.fontWeight);
    S.fontWeight = [400, 500, 600, 700].includes(fw) ? fw : defaults.fontWeight;
    const ls = Number(S.letterSpacing);
    S.letterSpacing = Number.isFinite(ls) ? Math.min(0.2, Math.max(-0.05, ls)) : defaults.letterSpacing;
    const ps = Number(S.paragraphSpacing);
    S.paragraphSpacing = Number.isFinite(ps) ? Math.min(1.5, Math.max(0, ps)) : defaults.paragraphSpacing;
    const ti = Number(S.textIndent);
    S.textIndent = Number.isFinite(ti) ? Math.min(3, Math.max(0, ti)) : defaults.textIndent;
    const tr = Number(S.ttsRate);
    S.ttsRate = Number.isFinite(tr) ? Math.min(2, Math.max(0.5, tr)) : defaults.ttsRate;
    if (typeof S.ttsVoice !== 'string') S.ttsVoice = defaults.ttsVoice;
    S.chromePinned = Boolean(S.chromePinned);
    S.tapZonesShort = normalizeTapZones(S.tapZonesShort, defaultTapZonesShort());
    S.tapZonesLong = normalizeTapZones(S.tapZonesLong, defaultTapZonesLong());
  }
  function saveSettings() { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(S)); }
  loadSettings();
  const themeColors = {
    dark:  { bg: '#1b1b2f', fg: '#d4cfc4', link: '#8ab4f8' },
    light: { bg: '#faf9f6', fg: '#222',    link: '#1a5fb4' },
    sepia: { bg: '#f4edd5', fg: '#3d3121', link: '#6b4226' },
    night: { bg: '#0d0d0d', fg: '#888',    link: '#5a8ab8' },
    eink:  { bg: '#ffffff', fg: '#000000', link: '#000000' },
  };
  const presets = {
    compact:  { fontSize: 16, lineHeight: 1.45, pageMargin: 20, maxWidth: 680 },
    balanced: { fontSize: 18, lineHeight: 1.6,  pageMargin: 32, maxWidth: 720 },
    relaxed:  { fontSize: 21, lineHeight: 1.8,  pageMargin: 48, maxWidth: 800 },
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

  function getEffectiveLinkColor() {
    const c = themeColors[S.theme] || themeColors.dark;
    const t = S.linkColor && String(S.linkColor).trim();
    if (t && /^#[0-9A-Fa-f]{6}$/.test(t)) return t;
    if (READER_LITE || S.theme === 'eink') return getEffectiveTextColor();
    return c.link;
  }

  function getBookCSS() {
    const fg = getEffectiveTextColor();
    const bg = getEffectiveBgColor();
    const link = getEffectiveLinkColor();
    const ff = fontMap[S.font] || fontMap.serif;
    const mono = fontMap.mono;
    const align = S.justify !== false ? 'justify' : 'start';
    const hyph = S.hyphenate !== false ? 'auto' : 'manual';
    const pubFont = S.usePublisherFont === true;
    const weight = Number(S.fontWeight) || 400;
    const ls = Number(S.letterSpacing) || 0;
    const ps = Number(S.paragraphSpacing) || 0;
    const ti = Number(S.textIndent) || 0;
    const fontFamilyRule = pubFont ? '' : `
      body, p, div, span, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd, dt, em, strong, i, b, u, a, section, article {
        font-family: ${ff} !important;
      }`;
    const text = `
      @namespace epub "http://www.idpf.org/2007/ops";
      html { color: ${fg} !important; background: ${bg} !important; }
      ${fontFamilyRule}
      body { color: ${fg} !important; background: ${bg} !important; font-size: ${S.fontSize}px !important; font-weight: ${weight} !important; letter-spacing: ${ls}em !important; }
      pre, code, kbd, samp { font-family: ${mono} !important; }
      p,li,blockquote,dd,div { line-height: ${S.lineHeight} !important; }
      p { margin-block-start: ${ps}em !important; margin-block-end: 0 !important; text-indent: ${ti}em !important; }
      p:first-child, li p:first-child, blockquote p:first-child { margin-block-start: 0 !important; }
      p,li,blockquote,dd { text-align: ${align}; hyphens: ${hyph}; -webkit-hyphens: ${hyph}; -webkit-hyphenate-limit-before: 3; -webkit-hyphenate-limit-after: 2; -webkit-hyphenate-limit-lines: 2; hanging-punctuation: allow-end last; widows: 2; }
      [align="left"]{text-align:left} [align="right"]{text-align:right} [align="center"]{text-align:center} [align="justify"]{text-align:justify}
      pre { white-space: pre-wrap !important; }
      aside[epub|type~="endnote"],aside[epub|type~="footnote"],aside[epub|type~="note"],aside[epub|type~="rearnote"] { display: none; }
      a { color: ${link} !important; }
      /* Paper-book flow: next chapter continues on the same page. */
      body:not(.notesBodyType) h1,
      body:not(.notesBodyType) section[epub|type~="chapter"],
      body:not(.notesBodyType) div[epub|type~="chapter"],
      body:not(.notesBodyType) article[epub|type~="chapter"],
      body:not(.notesBodyType) section.chapter,
      body:not(.notesBodyType) div.chapter {
        break-before: auto !important;
        -webkit-column-break-before: auto !important;
        page-break-before: auto !important;
      }
      ${READER_LITE ? 'img,svg image { filter: grayscale(100%) contrast(115%) !important; }' : ''}
    `;
    const gf = GOOGLE_FONTS[S.font];
    if (gf && !pubFont) return [`@import url("${googleFontCssUrl(gf)}");`, text];
    return text;
  }
  function applyBookStyles() {
    if (!view?.renderer) return;
    view.renderer.setStyles?.(getBookCSS());
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
    if (READER_LITE) S.theme = 'eink';
    document.documentElement.dataset.readerTheme = S.theme;
    document.body.dataset.readerTheme = S.theme;
    const bg = getEffectiveBgColor();
    document.body.style.background = bg;
    if (readerBody) readerBody.style.background = bg;
    applyChromePinnedLayout();
    saveSettings();
    if (view?.renderer) {
      applyRendererLayout();
      applyBookStyles();
      syncReaderGoogleFont().then(() => applyBookStyles());
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
    S = {
      ...defaults,
      tapZonesShort: defaultTapZonesShort(),
      tapZonesLong: defaultTapZonesLong(),
    };
    applySettings(); refreshSettingsUI(); toast(rt('readerJs.settingsReset'));
  }

  function tapActionLabel(action) {
    const key = `reader.tapAction.${action}`;
    const lab = rt(key);
    return lab === key ? action : lab;
  }

  function runTapAction(action) {
    if (!action || action === 'none') return;
    void acquireReaderWakeLock();
    switch (action) {
      case 'prevPage': view?.goLeft?.(); break;
      case 'nextPage': view?.goRight?.(); break;
      case 'toggleChrome': toggleChromeFromCenterTap(); break;
      case 'toc': openPanel('toc'); break;
      case 'search': openPanel('search'); break;
      case 'settings': openPanel('settings'); break;
      case 'bookmark': addBookmark(); break;
      case 'dayNight': toggleDayNightTheme(); break;
      case 'tts': toggleReaderTts(); break;
      case 'prevChapter': {
        const i = getTocIdx();
        if (i > 0) goTocIdx(i - 1);
        break;
      }
      case 'nextChapter': {
        const i = getTocIdx();
        if (i >= 0 && i < tocData.length - 1) goTocIdx(i + 1);
        break;
      }
      case 'goto':
        setChromeVisible(true);
        scheduleChromeHide();
        seekBar?.focus?.();
        break;
      default: break;
    }
  }

  function shortActionLabel(action) {
    const full = tapActionLabel(action);
    if (full.length <= 10) return full;
    return full.slice(0, 9) + '…';
  }

  function refreshTapZonesUi() {
    const grid = $('rs-tap-grid');
    const sel = $('rs-tap-action');
    const hint = $('rs-tap-hint');
    if (!grid) return;
    const map = tapEditMode === 'long' ? S.tapZonesLong : S.tapZonesShort;
    if (!grid.dataset.built) {
      grid.dataset.built = '1';
      grid.innerHTML = TAP_ZONE_IDS.map((id) =>
        `<button type="button" class="rs-tap-cell" data-tap-zone="${id}">` +
        `<span class="rs-tap-cell-id">${id}</span>` +
        `<span class="rs-tap-cell-label"></span></button>`
      ).join('');
      grid.addEventListener('click', (e) => {
        const cell = e.target.closest?.('[data-tap-zone]');
        if (!cell) return;
        tapEditSelected = cell.dataset.tapZone;
        refreshTapZonesUi();
        sel?.focus();
      });
    }
    grid.querySelectorAll('[data-tap-zone]').forEach((cell) => {
      const id = cell.dataset.tapZone;
      const action = map?.[id] || 'none';
      cell.classList.toggle('is-selected', id === tapEditSelected);
      const label = cell.querySelector('.rs-tap-cell-label');
      if (label) label.textContent = shortActionLabel(action);
    });
    if (sel) {
      if (!sel.dataset.built) {
        sel.dataset.built = '1';
        sel.hidden = false;
        sel.innerHTML = TAP_ACTIONS
          .map((k) => `<option value="${k}">${esc(tapActionLabel(k))}</option>`)
          .join('');
        sel.addEventListener('change', () => {
          const mapKey = tapEditMode === 'long' ? 'tapZonesLong' : 'tapZonesShort';
          S[mapKey] = { ...S[mapKey], [tapEditSelected]: sel.value };
          saveSettings();
          refreshTapZonesUi();
        });
      }
      sel.value = map?.[tapEditSelected] || 'none';
    }
    if (hint) {
      const zone = String(tapEditSelected || 'mm').toUpperCase();
      hint.textContent = rtp(
        tapEditMode === 'long' ? 'reader.tapZones.hintLong' : 'reader.tapZones.hintShort',
        { zone }
      );
    }
    document.querySelectorAll('[data-tap-edit]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tapEdit === tapEditMode);
    });
  }

  function initTapZonesSettings() {
    document.querySelectorAll('[data-tap-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tapEditMode = btn.dataset.tapEdit === 'long' ? 'long' : 'short';
        refreshTapZonesUi();
      });
    });
    $('rs-tap-reset')?.addEventListener('click', () => {
      S.tapZonesShort = defaultTapZonesShort();
      S.tapZonesLong = defaultTapZonesLong();
      saveSettings();
      refreshTapZonesUi();
      toast(rt('reader.tapZones.resetDone'));
    });
    refreshTapZonesUi();
  }

  function getActivePreset() {
    return Object.entries(presets).find(([, p]) =>
      S.fontSize === p.fontSize && Math.abs(S.lineHeight - p.lineHeight) < 0.05
    )?.[0] || '';
  }

  /* ===== Utilities ===== */
  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const base = globalThis.apiBookPath ? globalThis.apiBookPath(bookId) : `/api/books/${encodeURIComponent(bookId)}`;
    const response = await fetch(base + path, opts);
    let data = null;
    try { data = await response.json(); } catch { /* empty/non-JSON response */ }
    if (!response.ok) {
      const error = new Error(data?.message || ('HTTP ' + response.status));
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
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

  const mobileMq = window.matchMedia('(max-width: 640px)');

  function syncPanelMobileMode(tab = activePanelTab) {
    if (!panelOverlay) return;
    panelOverlay.classList.toggle('panel-mobile', mobileMq.matches);
    panelOverlay.classList.toggle('panel-settings-mode', mobileMq.matches && tab === 'settings');
  }

  function touchToPageY(clientY, doc_) {
    const iframe = doc_?.defaultView?.frameElement;
    if (!iframe) return clientY;
    return iframe.getBoundingClientRect().top + clientY;
  }

  function panelBlocksBookTap(pageY) {
    if (!panelOverlay.classList.contains('is-open')) return false;
    if (!mobileMq.matches) return false;
    const panel = panelOverlay.querySelector('.panel');
    if (!panel) return false;
    return pageY >= panel.getBoundingClientRect().top - 8;
  }

  function syncPanelChrome(tab = activePanelTab) {
    if (!panelOverlay.classList.contains('is-open')) return;
    if (mobileMq.matches) {
      setChromeVisible(false);
      return;
    }
    setChromeVisible(true);
  }

  function isChromePinned() {
    return Boolean(S.chromePinned);
  }

  function applyChromePinnedLayout({ triggerResize = false, resumeAutohide = false } = {}) {
    const pinned = isChromePinned();
    document.documentElement.dataset.chromePinned = pinned ? '1' : '0';
    document.body.classList.toggle('chrome-pinned', pinned);
    if (pinned) {
      clearTimeout(chromeTimer);
      chromeVisible = true;
      document.body.classList.remove('chrome-hidden');
    } else if (resumeAutohide) {
      setChromeVisible(true);
      scheduleChromeHide();
    }
    if (triggerResize) onViewportResize();
  }

  function setChromeVisible(show) {
    if (isChromePinned()) {
      chromeVisible = true;
      document.body.classList.remove('chrome-hidden');
      return;
    }
    chromeVisible = show;
    const panelOpen = panelOverlay.classList.contains('is-open');
    const settingsPreview = panelOpen && panelOverlay.classList.contains('panel-settings-mode');
    const hideChrome = !(show || (panelOpen && !settingsPreview));
    document.body.classList.toggle('chrome-hidden', hideChrome);
  }
  /** Сбросить таймер скрытия, не показывая панели силой (если уже скрыты — ничего не делаем). */
  function scheduleChromeHide() {
    clearTimeout(chromeTimer);
    if (isChromePinned()) return;
    if (panelOverlay.classList.contains('is-open')) return;
    if (!chromeVisible) return;
    chromeTimer = setTimeout(() => setChromeVisible(false), CHROME_AUTOHIDE_MS());
  }
  /** Тап по центру поля: скрыто → показать и снова автоскрытие; уже видно → скрыть. */
  function toggleChromeFromCenterTap() {
    if (isChromePinned()) return;
    clearTimeout(chromeTimer);
    if (panelOverlay.classList.contains('is-open')) return;
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
  let fb2FlatToc = [];

  function flattenTocForSeek(toc, out = []) {
    for (const item of toc ?? []) {
      if (item?.href != null && item.href !== '') out.push(item);
      if (item?.subitems?.length) flattenTocForSeek(item.subitems, out);
    }
    return out;
  }

  /** Flat TOC для подписи главы в диалоге: [{ href, label, startFraction }] в порядке чтения.
   *  startFraction — доля по объёму текста (как Foliate считает fraction), чтобы глава
   *  в диалоге была согласована с процентом. */
  function flatTocForPrompt() {
    const sections = view?.book?.sections || [];
    const sizes = sections.map((s) => (s?.linear === 'no' ? 0 : Math.max(0, Number(s?.size) || 0)));
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    const cumStart = [];
    let run = 0;
    for (let i = 0; i < sizes.length; i++) { cumStart[i] = run / total; run += sizes[i]; }
    const innerCount = {};
    for (const t of fb2FlatToc) {
      const [sStr, kStr] = String(t.href).split('#');
      if (kStr != null) { const s = Number(sStr); innerCount[s] = (innerCount[s] || 0) + 1; }
    }
    const sectionDocs = new Map();
    const textOffsetFor = (sectionIndex, fragmentIndex) => {
      if (fragmentIndex == null) return 0;
      try {
        let doc = sectionDocs.get(sectionIndex);
        if (!doc) {
          doc = sections[sectionIndex]?.createDocument?.();
          if (!doc) return null;
          sectionDocs.set(sectionIndex, doc);
        }
        const marker = [...doc.querySelectorAll('[data-foliate-id]')]
          .find((el) => Number(el.getAttribute('data-foliate-id')) === fragmentIndex);
        if (!marker || !doc.body) return null;
        const prefix = doc.createRange();
        prefix.setStart(doc.body, 0);
        prefix.setEndBefore(marker);
        return String(prefix.toString() || '').replace(/[\t\n\f\r ]+/g, ' ').trim().length;
      } catch {
        return null;
      }
    };
    return fb2FlatToc.map((t) => {
      const [sStr, kStr] = String(t.href).split('#');
      const s = Number(sStr);
      const k = kStr != null ? Number(kStr) : null;
      let startFraction = Number.isFinite(cumStart[s]) ? cumStart[s] : null;
      if (startFraction != null && k != null) {
        const secFrac = (sizes[s] || 0) / total;
        const n = innerCount[s] || 1;
        startFraction = cumStart[s] + secFrac * (Math.max(0, k) / n);
      }
      return {
        href: t.href,
        label: String(t.label || '').trim(),
        startFraction,
        sectionIndex: Number.isFinite(s) ? s : null,
        textOffset: Number.isFinite(s) ? textOffsetFor(s, k) : null,
        sectionStartFraction: Number.isFinite(cumStart[s]) ? cumStart[s] : null,
        sectionFraction: Number.isFinite(sizes[s]) ? sizes[s] / total : null,
        sectionTextLength: Number.isFinite(sizes[s]) ? sizes[s] : null,
      };
    });
  }

  function isFb2Active() {
    // Формат книги известен серверу (__READER_BOOK_EXT) — доверяем расширению.
    // Раньше приоритет был у view.book.isFB2; если foliate его не выставлял,
    // FB2 сохранялась как EPUB-CFI (fb2_href=null) и ломался кросс-девайс restore.
    const ext = String(effectiveBookExt || bookExt || '').toLowerCase().replace(/^\./, '').replace(/\.zip$/, '');
    if (ext === 'fb2' || ext === 'fbz') return true;
    return Boolean(view?.book?.isFB2);
  }

  function fractionFromFb2TocHref(href) {
    if (!href || fb2FlatToc.length < 2) return null;
    const idx = fb2FlatToc.findIndex((t) => t.href === href);
    if (idx < 0) return null;
    return normalizeFraction(idx / fb2FlatToc.length);
  }

  /** Доля книги для отображения и сохранения — только Foliate loc.fraction (не TOC). */
  function readingFractionFromLocation(loc) {
    return normalizeFraction(loc?.fraction ?? 0);
  }

  function displayFractionFromLocation(loc) {
    return readingFractionFromLocation(loc);
  }

  async function seekReaderToFraction(f) {
    if (!view) return;
    const frac = normalizeFraction(f);
    // Size-based (по объёму текста, как считается сам fraction). Индексный пересчёт
    // по TOC (floor(frac × N)) промахивается на неравных главах — 95% попадало бы
    // в «Приложение» вместо Части VI.
    await view.goToFraction(frac);
  }

  function updateSeekbar() {
    if (!seekBar) return;
    seekBar.style.setProperty('--seek-pct', (currentFraction * 100).toFixed(4) + '%');
  }

  function setProgress(pct, tocItem) {
    setProgressFromFraction(pct / 100, tocItem);
  }
  function setProgressFromFraction(fraction, tocItem) {
    const f = normalizeFraction(fraction);
    if (!seekBarUserActive) {
      currentFraction = f;
      const pctDisplay = String(fractionToProgress(f));
      if (seekBar) seekBar.value = f;
      updateSeekbar();
      if (pctLabel) pctLabel.textContent = pctDisplay + '%';
      if (progressText) progressText.textContent = pctDisplay + '%';
    }
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
  let seekBarUserActive = false;
  let seekNavToken = 0;

  seekBar?.addEventListener('pointerdown', () => { seekBarUserActive = true; });
  seekBar?.addEventListener('pointercancel', () => { seekBarUserActive = false; });

  seekBar?.addEventListener('input', () => {
    const f = parseFloat(seekBar.value);
    if (pctLabel) pctLabel.textContent = fractionToProgress(f) + '%';
    seekBar.style.setProperty('--seek-pct', (f * 100).toFixed(4) + '%');
    scheduleChromeHide();
    clearTimeout(seekTimer);
    const token = ++seekNavToken;
    seekTimer = setTimeout(() => {
      seekTimer = null;
      void (async () => {
        if (!view || isNaN(f)) {
          seekBarUserActive = false;
          return;
        }
        try {
          await seekReaderToFraction(f);
          await waitForLayoutSettled(800);
        } catch { /* */ }
        if (token !== seekNavToken) return;
        seekBarUserActive = false;
        const loc = view?.lastLocation;
        if (loc) {
          setProgressFromFraction(readingFractionFromLocation(loc), loc.tocItem);
        }
      })();
    }, 150);
  });

  seekBar?.addEventListener('pointerup', () => {
    window.setTimeout(() => {
      if (!seekTimer) seekBarUserActive = false;
    }, 250);
  });

  /* ===== Position sync ===== */
  let syncTimer = null;
  let positionSaveEpoch = 0;
  let positionSaveChain = Promise.resolve();
  let autoReadToastShown = false;
  const positionSaveSuppression = createSuppressionCounter();
  const pendingStyleDocs = new Set();

  async function applySectionStyles(doc) {
    if (!doc) return;
    await syncReaderGoogleFont(doc);
    applyBookStyles();
    await waitForLayoutSettled(3000);
  }

  async function flushPendingSectionStyles() {
    const docs = pendingStyleDocs.size
      ? [...pendingStyleDocs]
      : (getLoadedSectionDoc() ? [getLoadedSectionDoc()] : []);
    pendingStyleDocs.clear();
    for (const doc of docs) {
      await applySectionStyles(doc);
    }
  }

  function isFb2Href(href) {
    const h = String(href || '').trim();
    if (!h) return false;
    const hashPos = h.indexOf('#');
    const section = hashPos === -1 ? h : h.slice(0, hashPos);
    const id = hashPos === -1 ? '' : h.slice(hashPos + 1);
    if (!section || Number.isNaN(Number(section))) return false;
    if (id !== '' && Number.isNaN(Number(id))) return false;
    return true;
  }

  function isFb2Book() {
    const ext = String(effectiveBookExt || bookExt || '').toLowerCase();
    if (ext.includes('fb2') || ext === 'fbz') return true;
    return Boolean(view?.book && !view.book.resolveCFI);
  }

  function fb2ResolveHref(loc) {
    return resolveFb2Href(loc, isFb2Book());
  }

  function fb2PositionFromLocation(loc) {
    return sharedPositionFromLocation(loc, isFb2Active());
  }

  function savedFraction(saved) {
    return sharedSavedFraction(saved);
  }

  function savedFractionLocal(saved) {
    return savedFraction(saved);
  }

  function posSeenStorageKey() {
    return `inpx_reader_pos_seen_${bookId}`;
  }

  function readPosSeenCtx() {
    try {
      const raw = localStorage.getItem(posSeenStorageKey());
      const parsed = raw ? JSON.parse(raw) : null;
      const normalized = normalizeSeenContext(parsed, { isFb2: isFb2Active() });
      if (!raw || Number(parsed?.positionVersion) < POSITION_VERSION) writePosSeenCtx(normalized);
      return normalized;
    } catch {
      return normalizeSeenContext(null, { isFb2: isFb2Active() });
    }
  }

  function writePosSeenCtx(ctx) {
    try {
      localStorage.setItem(posSeenStorageKey(), JSON.stringify(
        normalizeSeenContext(ctx, { isFb2: isFb2Active() }),
      ));
    } catch { /* */ }
  }

  function buildLocalCtxForPrompt() {
    return readPosSeenCtx();
  }

  function rememberPosSeenFromServer(saved) {
    if (!saved) return;
    writePosSeenCtx(acceptServerPosition(readPosSeenCtx(), saved));
  }

  function rememberDismissedServerPosition(saved, localCtx) {
    if (!saved) return;
    writePosSeenCtx(dismissServerPosition(localCtx || readPosSeenCtx(), saved));
  }

  function savedToRestorePayload(saved) {
    if (!saved) return null;
    return {
      ...positionFields(saved),
      updatedAt: saved.updatedAt || null,
      revision: Number(saved.revision) || 0,
    };
  }

  function localCtxToRestorePayload(localCtx) {
    if (!localCtx) return null;
    return {
      ...positionFields(localCtx),
      updatedAt: localCtx.updatedAt || null,
    };
  }

  let crossDevicePromptPromise = null;
  let pendingCrossDevicePrompt = null;

  function ensureCrossDevicePromptShell() {
    let el = $('reader-cross-device-prompt');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'reader-cross-device-prompt';
    el.className = 'reader-cross-device-prompt';
    el.hidden = true;
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="reader-cross-device-backdrop" tabindex="-1"></div>' +
      '<div class="reader-cross-device-panel">' +
      `<p class="reader-cross-device-message">${esc(rt('readerJs.crossDevicePosition'))}</p>` +
      '<div class="reader-cross-device-compare">' +
      '<div class="reader-cross-device-row"><span class="reader-cross-device-label">Сейчас</span><span class="reader-cross-device-value" data-role="local-line"></span></div>' +
      '<div class="reader-cross-device-row reader-cross-device-row-server"><span class="reader-cross-device-label">На другом устройстве</span><span class="reader-cross-device-value" data-role="server-line"></span></div>' +
      '</div>' +
      '<div class="reader-cross-device-actions">' +
      `<button type="button" class="reader-cross-device-decline">${esc(rt('readerJs.crossDeviceStay'))}</button>` +
      `<button type="button" class="reader-cross-device-accept">${esc(rt('readerJs.crossDeviceGo'))}</button>` +
      '</div></div>';
    document.body.appendChild(el);
    return el;
  }

  function confirmCrossDevicePosition(lines) {
    if (crossDevicePromptPromise) return crossDevicePromptPromise;
    crossDevicePromptPromise = new Promise((resolve) => {
      const el = ensureCrossDevicePromptShell();
      const localLineEl = el.querySelector('[data-role="local-line"]');
      const serverLineEl = el.querySelector('[data-role="server-line"]');
      if (localLineEl) localLineEl.textContent = lines?.localLine || '0%';
      if (serverLineEl) serverLineEl.textContent = lines?.serverLine || '0%';
      const acceptBtn = el.querySelector('.reader-cross-device-accept');
      const declineBtn = el.querySelector('.reader-cross-device-decline');
      const backdrop = el.querySelector('.reader-cross-device-backdrop');
      if (!acceptBtn || !declineBtn) {
        crossDevicePromptPromise = null;
        resolve(null);
        return;
      }
      let settled = false;
      const finish = (accepted) => {
        if (settled) return;
        settled = true;
        el.hidden = true;
        document.body.classList.remove('reader-cross-device-open');
        acceptBtn.removeEventListener('click', onAccept);
        declineBtn.removeEventListener('click', onDecline);
        backdrop?.removeEventListener('click', onDecline);
        crossDevicePromptPromise = null;
        resolve(accepted);
      };
      const onAccept = () => finish(true);
      const onDecline = () => finish(false);
      acceptBtn.addEventListener('click', onAccept);
      declineBtn.addEventListener('click', onDecline);
      backdrop?.addEventListener('click', onDecline);
      el.hidden = false;
      document.body.classList.add('reader-cross-device-open');
      acceptBtn.focus();
    });
    return crossDevicePromptPromise;
  }

  async function maybeShowDeferredCrossDevicePrompt() {
    const pending = pendingCrossDevicePrompt;
    pendingCrossDevicePrompt = null;
    if (!pending || !view) return false;
    clearTimeout(syncTimer);
    syncTimer = null;
    try {
      const liveLocal = view.lastLocation
        ? { ...pending.localCtx, ...positionFromLocation(view.lastLocation) }
        : pending.localCtx;
      const accepted = await confirmCrossDevicePosition(
        buildCrossDevicePromptLines(liveLocal, pending.saved, flatTocForPrompt()),
      );
      if (accepted === true) {
        const serverTarget = savedToRestorePayload(pending.saved);
        const restored = serverTarget
          ? await restoreReadingPosition(serverTarget, null)
          : false;
        if (restored) {
          rememberPosSeenFromServer(pending.saved);
          return true;
        }
        writePosSeenCtx(observeServerConflict(pending.localCtx, pending.saved));
        return false;
      }
      if (accepted === false) {
        rememberDismissedServerPosition(pending.saved, pending.localCtx);
      } else {
        writePosSeenCtx(observeServerConflict(pending.localCtx, pending.saved));
      }
      return false;
    } catch (err) {
      console.warn('[reader] deferred cross-device prompt failed', err);
      writePosSeenCtx(observeServerConflict(pending.localCtx, pending.saved));
      return false;
    }
  }

  /** Куда восстанавливать при открытии (учитывает pending-диалог и отклонённую правку). */
  let crossDeviceRestoreTarget = null;

  async function resolveCrossDevicePositionOnOpen(saved, urlPos) {
    pendingCrossDevicePrompt = null;
    crossDeviceRestoreTarget = saved;
    if (urlPos || !saved) return saved;
    try {
      const localCtx = buildLocalCtxForPrompt();
      const decision = decidePositionOnOpen(localCtx, saved);
      if (decision === 'prompt') {
        writePosSeenCtx(observeServerConflict(localCtx, saved));
        pendingCrossDevicePrompt = { saved, localCtx };
        // Local-first: открываем на локальной позиции, диалог предложит серверную.
        crossDeviceRestoreTarget = localCtxToRestorePayload(localCtx);
      } else if (decision === 'server') {
        rememberPosSeenFromServer(saved);
        crossDeviceRestoreTarget = saved;
      } else {
        if (
          localCtx.positionDirty
          || hasMeaningfulPosition(localCtx)
          || (
            localCtx.dismissedServerRevision != null
            && Number(localCtx.dismissedServerRevision) === Number(saved.revision)
          )
        ) {
          crossDeviceRestoreTarget = localCtxToRestorePayload(localCtx) || saved;
        }
        if (Number(saved.revision) > Number(localCtx.serverRevision)) {
          writePosSeenCtx(observeServerConflict(localCtx, saved));
        }
      }
    } catch (err) {
      console.warn('[reader] cross-device position check failed', err);
    }
    return crossDeviceRestoreTarget;
  }

  function positionFromLocation(loc) {
    const payload = fb2PositionFromLocation(loc);
    const sectionIndex = Number(loc?.section?.current);
    const page = Number(view?.renderer?.page);
    const pages = Number(view?.renderer?.pages);
    if (Number.isFinite(sectionIndex)) payload.sectionIndex = sectionIndex;
    if (Number.isFinite(page)) payload.paginatorPage = page;
    if (Number.isFinite(pages)) payload.paginatorPages = pages;
    if (Number.isFinite(page) && Number.isFinite(pages) && pages > 2) {
      payload.sectionPageFraction = normalizeFraction((page - 1) / (pages - 2));
    }
    payload.layoutMode = layoutMode();
    return payload;
  }

  function buildPositionBody(payload) {
    const f = sharedSavedFraction(payload);
    return {
      ...positionFields({ ...payload, fraction: f, progress: fractionToProgress(f) }),
      positionVersion: POSITION_VERSION,
      sessionId: readerSessionId,
    };
  }

  function isReaderSessionIdle(nowMs = Date.now()) {
    return (nowMs - lastUserActivityAt) > IDLE_MS;
  }

  function noteUserPositionActivity(reason) {
    if (isUserPositionSaveReason(reason)) {
      lastUserActivityAt = Date.now();
    }
  }

  async function postPositionPayload(body, changedAt, baseRevision, allowRetry = true) {
    const requestBody = { ...body, baseRevision };
    try {
      const response = await api('POST', '/position', requestBody);
      writePosSeenCtx(acceptPositionSave(readPosSeenCtx(), body, response, changedAt));
      if (response?.markedRead && !autoReadToastShown) {
        autoReadToastShown = true;
        toast(rt('readerJs.autoMarkedRead'));
      }
    } catch (error) {
      if (error?.status === 409 && error?.data?.current) {
        const current = error.data.current;
        const localCtx = readPosSeenCtx();
        if (shouldPromptLiveCrossDevice(readerSessionId, localCtx, current)) {
          positionSaveEpoch += 1;
          clearTimeout(syncTimer);
          syncTimer = null;
          writePosSeenCtx(observeServerConflict(localCtx, current));
          pendingCrossDevicePrompt = { saved: current, localCtx };
          await positionSaveSuppression.run(() => maybeShowDeferredCrossDevicePrompt());
          return;
        }
        const adopted = adoptConflictBaseRevision(localCtx, current);
        writePosSeenCtx(adopted);
        if (allowRetry && shouldRetryPositionConflict(readerSessionId, current)) {
          return postPositionPayload(body, changedAt, adopted.baseRevision, false);
        }
      }
    }
  }

  function savePositionPayload(payload, reason) {
    if (positionSaveSuppression.isSuppressed()) return;
    noteUserPositionActivity(reason);
    clearTimeout(syncTimer);
    const body = buildPositionBody(payload);
    const changedAt = new Date().toISOString();
    const epoch = positionSaveEpoch;
    const dirty = markPositionDirty(readPosSeenCtx(), body, changedAt);
    writePosSeenCtx(dirty);
    if (isReaderSessionIdle()) return;
    const baseRevision = dirty.baseRevision;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      if (isReaderSessionIdle()) return;
      positionSaveChain = positionSaveChain
        .then(() => {
          if (epoch !== positionSaveEpoch) return undefined;
          return postPositionPayload(body, changedAt, baseRevision);
        })
        .catch(() => {});
    }, 1500);
  }

  async function loadSavedPosition() {
    try {
      const d = await api('GET', '/position');
      if (Number(d?.positionVersion) === POSITION_VERSION) return d;
      const pos = String(d?.position || '').trim();
      if (pos && !isAppReaderPosition(pos)) return d;
      const fb2Href = String(d?.fb2Href || '').trim();
      if (fb2Href && isFb2Href(fb2Href)) return d;
      if (savedFraction(d) > 0) return d;
      return null;
    } catch { return null; }
  }

  function isAppReaderPosition(pos) {
    return /^(?:app:)?ch\d+:p\d+$/.test(String(pos || '').trim());
  }

  function getLoadedSectionDoc() {
    const contents = view?.renderer?.getContents?.() || [];
    return contents[0]?.doc || null;
  }

  function waitForRelocateQuiet(quietMs = 400, maxMs = 3000) {
    return new Promise((resolve) => {
      let quietTimer = null;
      const deadline = setTimeout(finish, maxMs);
      function finish() {
        clearTimeout(deadline);
        clearTimeout(quietTimer);
        view?.removeEventListener('relocate', onRelocate);
        resolve();
      }
      function onRelocate() {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      }
      view?.addEventListener('relocate', onRelocate);
      quietTimer = setTimeout(finish, quietMs);
    });
  }

  async function waitForFontsReady(doc, timeoutMs = 2000) {
    if (!doc?.fonts?.ready) return;
    try {
      await Promise.race([
        doc.fonts.ready,
        new Promise((r) => setTimeout(r, timeoutMs)),
      ]);
    } catch { /* */ }
  }

  async function waitForLayoutSettled(timeoutMs = 3000) {
    const doc = getLoadedSectionDoc();
    await waitForFontsReady(doc, Math.min(2000, timeoutMs));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await waitForRelocateQuiet(Math.min(450, Math.max(200, timeoutMs / 5)), timeoutMs);
  }

  function isRestoredPositionVerified(saved) {
    if (!saved || !hasMeaningfulPosition(saved)) return true;
    const landed = view?.lastLocation;
    if (!landed) return false;
    const targetSectionIndex = Number(saved.sectionIndex);
    const targetTextOffset = Number(saved.textOffset);
    if (
      Number.isInteger(targetSectionIndex)
      && targetSectionIndex >= 0
      && Number.isInteger(targetTextOffset)
      && targetTextOffset >= 0
    ) {
      if (Number(landed?.section?.current) !== targetSectionIndex) return false;
      const targetQuote = String(saved.textQuote || '').replace(/\s+/g, ' ').trim();
      const visibleText = String(landed?.range?.toString?.() || '').replace(/\s+/g, ' ').trim();
      const probe = targetQuote.slice(0, Math.min(32, targetQuote.length));
      if (probe && visibleText.includes(probe)) return true;
      return Math.abs(Number(landed?.textOffset) - targetTextOffset) <= 8;
    }
    const targetFraction = savedFraction(saved);
    const landedFraction = savedFraction(positionFromLocation(landed));
    if (targetFraction > 0) return Math.abs(targetFraction - landedFraction) <= 0.035;
    const targetCfi = String(saved.position || '').trim();
    if (targetCfi && !isAppReaderPosition(targetCfi)) {
      return String(landed.cfi || '').trim() === targetCfi;
    }
    const targetFb2 = String(saved.fb2Href || '').trim();
    if (targetFb2) return fb2ResolveHref(landed) === targetFb2;
    if (Number.isFinite(Number(saved.sectionIndex))) {
      return Number(landed?.section?.current) === Number(saved.sectionIndex);
    }
    if (Number.isFinite(Number(saved.paginatorPage))) {
      return Math.abs(Number(view?.renderer?.page) - Number(saved.paginatorPage)) <= 1;
    }
    return false;
  }

  /** Стандартный Foliate: view.init({ lastLocation }) с CFI, href или fraction. */
  async function restoreReadingPosition(saved, urlPos) {
    if (urlPos) {
      try { await view.goTo(urlPos); } catch { await view.renderer.next(); }
      return true;
    }
    if (!saved) {
      await view.renderer.next();
      return true;
    }
    const cfi = String(saved.position || '').trim();
    const fb2Href = String(saved.fb2Href || '').trim();
    const frac = savedFraction(saved);
    const hasCfi = cfi && !isAppReaderPosition(cfi);
    try {
      if (isFb2Active()) {
        // v4 text anchor is layout-independent and exact. Fraction remains the
        // book-wide display/fallback coordinate; fb2Href is the coarsest fallback.
        const sectionIndex = Number(saved.sectionIndex);
        const textOffset = Number(saved.textOffset);
        const linearCount = (view?.book?.sections || []).filter((s) => s?.linear !== 'no').length;
        const staleExplodedSection = linearCount <= 1 && sectionIndex > 0;
        let restoredByTextAnchor = false;
        if (
          Number.isInteger(sectionIndex)
          && sectionIndex >= 0
          && Number.isInteger(textOffset)
          && textOffset >= 0
          && !staleExplodedSection
          && typeof view.goToTextAnchor === 'function'
        ) {
          try {
            await view.goToTextAnchor(sectionIndex, textOffset, String(saved.textQuote || ''));
            restoredByTextAnchor = true;
          } catch { /* fall through to fraction/href */ }
        }
        if (restoredByTextAnchor) {
          // Exact anchor restored.
        } else if (frac > 0) {
          await view.goToFraction(frac);
        } else if (fb2Href && isFb2Href(fb2Href)) {
          await view.init({ lastLocation: fb2Href });
        } else if (hasCfi) {
          await view.init({ lastLocation: cfi });
        } else {
          await view.renderer.next();
        }
      } else if (hasCfi) {
        await view.init({ lastLocation: cfi });
      } else if (fb2Href && isFb2Href(fb2Href)) {
        await view.init({ lastLocation: fb2Href });
      } else if (frac > 0) {
        await view.goToFraction(frac);
      } else {
        await view.renderer.next();
      }
    } catch {
      await view.renderer.next();
    }
    await waitForLayoutSettled(1200);
    return isRestoredPositionVerified(saved);
  }

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
    return { chapter: ch, percent: Math.round(fractionToProgress(currentFraction)) };
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

  /* ===== Book search (full-text) ===== */
  function runBookSearch(query) {
    const c = $('search-content');
    if (!c) return;
    const q = String(query || '').trim();
    if (!view?.book) return;
    if (q.length < 2) {
      try { view.clearSearch?.(); } catch { /* */ }
      c.innerHTML = '<div class="bm-empty">' + esc(q ? rt('readerJs.searchMinChars') : rt('readerJs.searchHint')) + '</div>';
      return;
    }
    const seq = ++searchSeq;
    c.innerHTML = '<div class="bm-empty">' + esc(rt('readerJs.searching')) + '</div>';
    (async () => {
      const groups = [];
      let total = 0;
      try {
        for await (const r of view.search({ query: q })) {
          if (seq !== searchSeq) return;
          if (r === 'done') break;
          if (r && r.subitems) {
            groups.push(r);
            total += r.subitems.length;
            renderSearchResults(c, groups, total, seq, false);
          }
        }
      } catch (e) {
        console.error(e);
      }
      if (seq !== searchSeq) return;
      renderSearchResults(c, groups, total, seq, true);
    })();
  }

  function renderExcerpt(ex) {
    if (!ex) return '';
    if (typeof ex === 'string') return esc(ex);
    return '<span class="search-ctx">' + esc(ex.pre || '') + '</span>' +
      '<mark>' + esc(ex.match || '') + '</mark>' +
      '<span class="search-ctx">' + esc(ex.post || '') + '</span>';
  }

  function renderSearchResults(c, groups, total, seq, done) {
    if (seq !== searchSeq || !c) return;
    if (!total) {
      c.innerHTML = '<div class="bm-empty">' + esc(done ? rt('readerJs.searchNoResults') : rt('readerJs.searching')) + '</div>';
      return;
    }
    let h = '<div class="bm-section-title">' + esc(rtp('readerJs.searchResults', { n: total, word: rPlural('result', total) })) + '</div>';
    groups.forEach(g => {
      if (g.label) h += '<div class="search-group">' + esc(g.label) + '</div>';
      (g.subitems || []).forEach(it => {
        h += '<button class="search-item" type="button" data-search-cfi="' + esc(it.cfi) + '">' + renderExcerpt(it.excerpt) + '</button>';
      });
    });
    c.innerHTML = h;
    c.querySelectorAll('[data-search-cfi]').forEach(el => el.addEventListener('click', () => {
      const cfi = el.dataset.searchCfi;
      if (view && cfi) view.goTo(cfi).catch(console.error);
      closePanel();
    }));
  }

  /* ===== Annotations (highlights & notes) ===== */
  const HL_FILL = {
    yellow: 'rgba(255,214,10,.45)',
    green: 'rgba(52,211,153,.45)',
    blue: 'rgba(96,165,250,.45)',
    pink: 'rgba(244,114,182,.5)'
  };
  function hlFill(color) { return HL_FILL[color] || HL_FILL.yellow; }
  let pendingNote = null;

  async function loadAnnotations() {
    try { const d = await api('GET', '/annotations'); annotationsData = Array.isArray(d) ? d : []; } catch { annotationsData = []; }
  }

  function drawAnnotation(a) {
    if (!view || !a?.cfi) return;
    try { view.addAnnotation({ value: a.cfi, color: a.color }); } catch { /* */ }
  }
  function applyAllAnnotations() { annotationsData.forEach(drawAnnotation); }

  function hideSelMenu() {
    const m = $('reader-sel-menu');
    if (m) { m.classList.remove('is-open'); m.setAttribute('aria-hidden', 'true'); }
  }
  function rectToPage(rect, doc) {
    const win = doc?.defaultView;
    const iframe = win?.frameElement;
    if (!iframe || !rect) return { left: rect?.left || 0, top: rect?.top || 0, right: rect?.right || 0, bottom: rect?.bottom || 0, cx: (rect?.left || 0) + (rect?.width || 0) / 2 };
    const fr = iframe.getBoundingClientRect();
    return {
      left: fr.left + rect.left, top: fr.top + rect.top,
      right: fr.left + rect.right, bottom: fr.top + rect.bottom,
      cx: fr.left + rect.left + rect.width / 2
    };
  }
  function showSelMenuAt(pageRect, isExisting) {
    const m = $('reader-sel-menu');
    if (!m) return;
    const rem = m.querySelector('#rsm-remove');
    if (rem) rem.hidden = !isExisting;
    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
    const mw = m.offsetWidth || 240;
    const mh = m.offsetHeight || 44;
    const host = readerBody?.getBoundingClientRect?.();
    const minX = (host?.left ?? 0) + 8;
    const maxX = (host?.right ?? innerWidth) - mw - 8;
    const minY = (host?.top ?? 0) + 8;
    const maxY = (host?.bottom ?? innerHeight) - mh - 8;
    let left = pageRect.cx - mw / 2;
    left = Math.max(minX, Math.min(maxX, left));
    let top = pageRect.top - mh - 10;
    if (top < minY) top = Math.min(maxY, pageRect.bottom + 10);
    m.style.left = left + 'px';
    m.style.top = top + 'px';
  }
  function maybeShowSelMenu(doc) {
    // Во время TTS фразы раньше выделялись через Selection — меню заметок всплывало само.
    if (ttsChainActive) { hideSelMenu(); return; }
    if (panelOverlay.classList.contains('is-open') || isFootnoteOverlayOpen()) { hideSelMenu(); return; }
    const sel = doc.getSelection?.();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      if (!activeSel?.existing) { hideSelMenu(); activeSel = null; }
      return;
    }
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) { hideSelMenu(); return; }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) { hideSelMenu(); return; }
    const index = docIndexMap.get(doc);
    if (index == null) { hideSelMenu(); return; }
    activeSel = { doc, index, range: range.cloneRange(), text, existing: null };
    showSelMenuAt(rectToPage(rect, doc), false);
  }
  function openSelMenuForExisting(a, range) {
    if (ttsChainActive) return;
    if (panelOverlay.classList.contains('is-open')) return;
    const doc = range?.startContainer?.ownerDocument || range?.commonAncestorContainer?.ownerDocument;
    activeSel = { doc, index: doc ? docIndexMap.get(doc) : null, range, text: a.text, existing: a };
    const rect = range?.getBoundingClientRect?.();
    if (rect) showSelMenuAt(rectToPage(rect, doc), true);
  }

  async function createHighlightFromSel(color) {
    if (!activeSel || !view) { hideSelMenu(); return; }
    if (activeSel.existing) { recolorAnnotation(activeSel.existing, color); return; }
    if (activeSel.index == null) { hideSelMenu(); return; }
    const cfi = view.getCFI(activeSel.index, activeSel.range);
    const text = activeSel.text;
    if (!cfi) { hideSelMenu(); return; }
    drawAnnotation({ cfi, color });
    hideSelMenu();
    try { view.deselect?.(); } catch { /* */ }
    try {
      const r = await api('POST', '/annotations', { cfi, text, color, note: '' });
      annotationsData.push({ id: r.id, cfi, text, color, note: '', createdAt: new Date().toISOString() });
      toast(rt('readerJs.highlightAdded'));
      if (activePanelTab === 'notes') renderNotesTab();
    } catch (e) { console.error(e); }
    activeSel = null;
  }
  async function recolorAnnotation(a, color) {
    a.color = color;
    drawAnnotation(a);
    hideSelMenu();
    activeSel = null;
    try { await api('PATCH', '/annotations/' + a.id, { color }); if (activePanelTab === 'notes') renderNotesTab(); } catch (e) { console.error(e); }
  }
  async function copySelText() {
    const text = activeSel?.text || activeSel?.existing?.text || '';
    hideSelMenu();
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast(rt('readerJs.copied')); }
    catch { toast(rt('readerJs.copyFailed')); }
  }
  async function removeActiveAnnotation() {
    const a = activeSel?.existing;
    hideSelMenu();
    activeSel = null;
    if (!a) return;
    try { view.deleteAnnotation?.({ value: a.cfi }); } catch { /* */ }
    annotationsData = annotationsData.filter(x => x.id !== a.id);
    if (activePanelTab === 'notes') renderNotesTab();
    try { await api('DELETE', '/annotations/' + a.id); } catch (e) { console.error(e); }
    toast(rt('readerJs.annotationRemoved'));
  }

  function openNoteEditor() {
    const ed = $('reader-note-editor');
    if (!ed || !activeSel) return;
    if (activeSel.existing) {
      pendingNote = { mode: 'existing', a: activeSel.existing };
      $('rne-quote').textContent = activeSel.existing.text || '';
      $('rne-text').value = activeSel.existing.note || '';
    } else {
      if (activeSel.index == null || !view) return;
      const cfi = view.getCFI(activeSel.index, activeSel.range);
      if (!cfi) return;
      pendingNote = { mode: 'new', cfi, text: activeSel.text, color: 'yellow' };
      $('rne-quote').textContent = activeSel.text || '';
      $('rne-text').value = '';
    }
    hideSelMenu();
    ed.classList.add('is-open');
    ed.setAttribute('aria-hidden', 'false');
    setTimeout(() => { try { $('rne-text').focus(); } catch { /* */ } }, 60);
  }
  function closeNoteEditor() {
    const ed = $('reader-note-editor');
    ed?.classList.remove('is-open');
    ed?.setAttribute('aria-hidden', 'true');
    pendingNote = null;
  }
  async function saveNoteEditor() {
    if (!pendingNote) { closeNoteEditor(); return; }
    const note = ($('rne-text')?.value || '').trim();
    if (pendingNote.mode === 'new') {
      const { cfi, text, color } = pendingNote;
      drawAnnotation({ cfi, color });
      try { view.deselect?.(); } catch { /* */ }
      try {
        const r = await api('POST', '/annotations', { cfi, text, color, note });
        annotationsData.push({ id: r.id, cfi, text, color, note, createdAt: new Date().toISOString() });
        toast(rt('readerJs.noteSaved'));
      } catch (e) { console.error(e); }
    } else {
      const a = pendingNote.a;
      a.note = note;
      try { await api('PATCH', '/annotations/' + a.id, { note }); toast(rt('readerJs.noteSaved')); } catch (e) { console.error(e); }
    }
    activeSel = null;
    closeNoteEditor();
    if (activePanelTab === 'notes') renderNotesTab();
  }

  function renderNotesTab() {
    const c = $('notes-content');
    if (!c) return;
    if (!annotationsData.length) {
      c.innerHTML = '<div class="bm-empty">' + esc(rt('readerJs.noNotes')) + '<div class="bm-empty-hint">' + esc(rt('readerJs.notesHint')) + '</div></div>';
      return;
    }
    const n = annotationsData.length;
    let h = '<div class="bm-section-title">' + esc(rtp('readerJs.savedNotes', { n, word: rPlural('note', n) })) + '</div>';
    annotationsData.forEach(a => {
      h += '<div class="note-item note-color-' + esc(a.color) + '">' +
        '<button class="note-item-body" type="button" data-note-go="' + a.id + '">' +
        '<div class="note-quote">' + esc(a.text || '') + '</div>' +
        (a.note ? '<div class="note-text">' + esc(a.note) + '</div>' : '') +
        '<div class="bm-item-date">' + esc(fmtDate(a.createdAt)) + '</div></button>' +
        '<button class="bm-item-del" type="button" data-note-del="' + a.id + '" title="' + esc(rt('readerJs.delete')) + '">&times;</button></div>';
    });
    c.innerHTML = h;
    c.querySelectorAll('[data-note-go]').forEach(el => el.addEventListener('click', () => {
      const a = annotationsData.find(x => x.id === Number(el.dataset.noteGo));
      if (a && view) { view.goTo(a.cfi).catch(console.error); closePanel(); }
    }));
    c.querySelectorAll('[data-note-del]').forEach(el => el.addEventListener('click', () => removeAnnotationById(Number(el.dataset.noteDel))));
  }
  async function removeAnnotationById(id) {
    const a = annotationsData.find(x => x.id === id);
    if (!a) return;
    try { view.deleteAnnotation?.({ value: a.cfi }); } catch { /* */ }
    annotationsData = annotationsData.filter(x => x.id !== id);
    renderNotesTab();
    try { await api('DELETE', '/annotations/' + id); } catch (e) { console.error(e); }
  }

  function initAnnotations() {
    const m = $('reader-sel-menu');
    m?.querySelectorAll('.rsm-color').forEach(b => b.addEventListener('click', () => createHighlightFromSel(b.dataset.color)));
    $('rsm-note')?.addEventListener('click', openNoteEditor);
    $('rsm-copy')?.addEventListener('click', copySelText);
    $('rsm-remove')?.addEventListener('click', removeActiveAnnotation);
    $('rne-cancel')?.addEventListener('click', closeNoteEditor);
    $('rne-save')?.addEventListener('click', saveNoteEditor);
    $('reader-note-editor')?.addEventListener('click', e => { if (e.target?.id === 'reader-note-editor') closeNoteEditor(); });
    document.addEventListener('pointerdown', e => {
      const sm = $('reader-sel-menu');
      if (sm && sm.classList.contains('is-open') && !sm.contains(e.target)) { hideSelMenu(); if (!activeSel?.existing) activeSel = null; }
    }, true);
  }

  function wireViewAnnotations() {
    if (!view) return;
    view.addEventListener('draw-annotation', ({ detail }) => {
      const color = detail?.annotation?.color;
      if (color === 'underline') detail.draw(Overlayer.underline, { color: '#f43f5e' });
      else detail.draw(Overlayer.highlight, { color: hlFill(color) });
    });
    view.addEventListener('show-annotation', ({ detail }) => {
      const a = annotationsData.find(x => x.cfi === detail.value);
      if (a) openSelMenuForExisting(a, detail.range);
    });
    view.addEventListener('create-overlay', () => applyAllAnnotations());
  }

  function wireSelection(doc) {
    let selTimer = null;
    doc.addEventListener('selectionchange', () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => maybeShowSelMenu(doc), 250);
    });
  }

  /* ===== TOC ===== */
  function updateTocHighlight() { document.querySelectorAll('.toc-item').forEach(el => el.classList.toggle('is-active', !!currentTocHref && el.dataset.tocHref === currentTocHref)); }
  function getTocIdx() { return tocData.findIndex(i => i.href === currentTocHref); }
  /* Докрутить оглавление к текущей главе — после того как панель стала видимой (scrollIntoView в скрытом контейнере не работает). */
  function scrollTocToCurrent() {
    const el = $('toc-content')?.querySelector('.toc-item.is-active');
    if (!el) return;
    requestAnimationFrame(() => { try { el.scrollIntoView({ block: 'center' }); } catch { /* */ } });
  }
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
    if (!q && panelOverlay.classList.contains('is-open') && activePanelTab === 'toc') scrollTocToCurrent();
  }

  /* ===== Panel ===== */
  function getPanelMeta(tab) {
    return {
      settings: { kicker: rt('readerJs.panelSettings'), title: rt('readerJs.panelSettingsTitle') },
      toc: { kicker: rt('readerJs.panelTocKicker'), title: rt('readerJs.panelTocTitle') },
      bookmarks: { kicker: rt('readerJs.panelBmKicker'), title: rt('readerJs.panelBmTitle') },
      search: { kicker: rt('readerJs.panelSearchKicker'), title: rt('readerJs.panelSearchTitle') },
      notes: { kicker: rt('readerJs.panelNotesKicker'), title: rt('readerJs.panelNotesTitle') }
    }[tab] || { kicker: '', title: '' };
  }
  const triggerMap = { settings: $('btn-settings'), toc: $('btn-toc'), search: $('btn-search') };

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
    hideSelMenu();
    if (panelOverlay.classList.contains('is-open') && activePanelTab === t) { closePanel(); return; }
    const wasOpen = panelOverlay.classList.contains('is-open');
    panelOverlay.classList.add('is-open');
    switchTab(t);
    syncPanelChrome(t);
    refreshTriggers();
    if (!wasOpen && !panelHistoryPushed) { history.pushState({ readerPanel: true }, ''); panelHistoryPushed = true; }
  }
  function closePanelDirect() {
    panelOverlay.classList.remove('is-open', 'panel-mobile', 'panel-settings-mode');
    refreshTriggers();
    clearTimeout(chromeTimer);
    setChromeVisible(false);
    if (activePanelTab === 'search') { try { view?.clearSearch?.(); } catch { /* */ } }
  }
  function closePanel() {
    if (!panelOverlay.classList.contains('is-open')) return;
    closePanelDirect();
    if (panelHistoryPushed) { panelHistoryPushed = false; history.back(); }
  }
  function switchTab(tab) {
    activePanelTab = tab;
    syncPanelMobileMode(tab);
    panelTabs.forEach(t => t.classList.toggle('is-active', t.dataset.tab === tab));
    panelBodies.forEach(b => { b.hidden = b.dataset.panelTab !== tab; });
    const pm = getPanelMeta(tab);
    if (panelKickerEl) panelKickerEl.textContent = pm.kicker;
    if (panelTitleEl) panelTitleEl.textContent = pm.title;
    refreshTriggers();
    syncPanelChrome(tab);
    if (tab === 'settings') {
      document.querySelectorAll('.panel-body input[type="range"]').forEach(guardRangeSliderTouchScroll);
      void ensureTtsVoices().then(() => {
        try {
          populateTtsVoiceList();
        } catch (e) {
          console.warn(e);
        }
      });
    }
    if (tab === 'notes') renderNotesTab();
    if (tab === 'toc') scrollTocToCurrent();
    if (tab === 'search') {
      const inp = $('book-search-input');
      if (inp) setTimeout(() => { try { inp.focus(); } catch { /* */ } }, 60);
    }
  }
  panelOverlay.addEventListener('click', e => {
    if (!mobileMq.matches && e.target === panelOverlay) closePanel();
  });
  $('panel-backdrop')?.addEventListener('click', closePanel);
  $('panel-close')?.addEventListener('click', closePanel);
  panelTabs.forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  mobileMq.addEventListener('change', () => {
    if (!panelOverlay.classList.contains('is-open')) return;
    syncPanelMobileMode();
    syncPanelChrome();
  });

  /* Back gesture / back button closes panel instead of leaving */
  window.addEventListener('popstate', () => {
    if (panelOverlay.classList.contains('is-open')) {
      panelHistoryPushed = false;
      closePanelDirect();
    }
  });

  /* ===== Settings controls ===== */
  function setRangeFromClientX(slider, clientX) {
    const rect = slider.getBoundingClientRect();
    if (!rect.width) return;
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const min = Number(slider.min);
    const max = Number(slider.max);
    const step = Number(slider.step) || 1;
    let val = min + pct * (max - min);
    val = min + Math.round((val - min) / step) * step;
    val = Math.max(min, Math.min(max, val));
    const stepText = String(step);
    const decimals = stepText.includes('.') ? (stepText.split('.')[1]?.length || 0) : 0;
    const str = decimals ? val.toFixed(decimals) : String(Math.round(val));
    if (slider.value !== str) {
      slider.value = str;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  /**
   * На таче вертикальный свайп по ползунку = прокрутка панели, не смена значения.
   * Откат value в capture ДО bubble applySettings — иначе визуально «как было»,
   * а настройка уже записана. Меняем только после явного горизонтального drag.
   */
  function guardRangeSliderTouchScroll(slider) {
    if (!isTouch.matches || slider.dataset.scrollGuardWired) return;
    slider.dataset.scrollGuardWired = '1';
    let startX = 0;
    let startY = 0;
    let startVal = '';
    let mode = 'idle'; // idle | pending | scroll | slide

    const restore = () => {
      if (slider.value !== startVal) slider.value = startVal;
    };

    slider.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startVal = slider.value;
      mode = 'pending';
      queueMicrotask(() => {
        if (mode === 'pending' || mode === 'scroll') restore();
      });
    }, { capture: true, passive: true });

    slider.addEventListener('input', () => {
      if (mode === 'pending' || mode === 'scroll') restore();
    }, { capture: true });

    slider.addEventListener('change', () => {
      if (mode === 'pending' || mode === 'scroll') restore();
    }, { capture: true });

    slider.addEventListener('touchmove', (e) => {
      if (mode !== 'pending' && mode !== 'slide') return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const adx = Math.abs(t.clientX - startX);
      const ady = Math.abs(t.clientY - startY);
      if (mode === 'pending') {
        if (ady > 6 && ady >= adx) {
          mode = 'scroll';
          restore();
          slider.style.pointerEvents = 'none';
          return;
        }
        if (adx > 12 && adx > ady * 1.25) {
          mode = 'slide';
        } else {
          return;
        }
      }
      if (mode === 'slide') setRangeFromClientX(slider, t.clientX);
    }, { passive: true });

    const end = () => {
      if (mode !== 'slide') restore();
      mode = 'idle';
      slider.style.pointerEvents = '';
    };
    slider.addEventListener('touchend', end, { capture: true, passive: true });
    slider.addEventListener('touchcancel', end, { capture: true, passive: true });
  }

  function bindSeg(sel, prop) {
    document.querySelectorAll(sel).forEach(btn => btn.addEventListener('click', () => {
      S[prop] = btn.dataset['set' + prop[0].toUpperCase() + prop.slice(1)];
      applySettings(); refreshSettingsUI();
    }));
  }
  function initSettings() {
    bindSeg('[data-set-theme]', 'theme');
    bindSeg('[data-set-layout]', 'layout');
    populateFontSelect();
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

    const linkColorInput = $('rs-link-color');
    const linkColorDefaultBtn = $('rs-link-color-default');
    if (linkColorInput) {
      linkColorInput.addEventListener('input', () => {
        S.linkColor = linkColorInput.value;
        applySettings();
      });
    }
    linkColorDefaultBtn?.addEventListener('click', () => {
      S.linkColor = '';
      applySettings();
      refreshSettingsUI();
    });

    const wire = (id, valId, prop, fmt, parse) => {
      const sl = $(id), vl = $(valId); if (!sl) return;
      sl.value = S[prop]; if (vl) vl.textContent = fmt ? fmt(S[prop]) : S[prop];
      sl.addEventListener('input', () => {
        const raw = Number(sl.value);
        S[prop] = parse ? parse(raw) : (fmt ? Number(raw.toFixed(1)) : raw);
        if (vl) vl.textContent = fmt ? fmt(S[prop]) : S[prop];
        applySettings();
      });
    };
    wire('rs-font-size', 'rs-font-size-val', 'fontSize');
    wire('rs-line-height', 'rs-line-height-val', 'lineHeight', v => Number(v).toFixed(1));
    wire('rs-page-margin', 'rs-page-margin-val', 'pageMargin', v => `${Math.round(v)} px`);
    wire('rs-vertical-margin', 'rs-vertical-margin-val', 'verticalMargin', v => `${Math.round(v)} px`);
    wire('rs-column-gap', 'rs-column-gap-val', 'columnGap', v => `${Math.round(v)}%`);
    wire('rs-column-width', 'rs-column-width-val', 'maxWidth', v => `${Math.round(v)} px`);
    wire('rs-max-block-size', 'rs-max-block-size-val', 'maxBlockSize', v => `${Math.round(v)} px`);
    wire('rs-letter-spacing', 'rs-letter-spacing-val', 'letterSpacing', v => Number(v).toFixed(2), v => Number(v.toFixed(2)));
    wire('rs-paragraph-spacing', 'rs-paragraph-spacing-val', 'paragraphSpacing', v => Number(v).toFixed(2), v => Number(v.toFixed(2)));
    wire('rs-text-indent', 'rs-text-indent-val', 'textIndent', v => `${Number(v).toFixed(1)} em`, v => Number(v.toFixed(1)));

    const fontWeightEl = $('rs-font-weight');
    if (fontWeightEl) {
      fontWeightEl.addEventListener('change', () => {
        const fw = Number(fontWeightEl.value);
        S.fontWeight = [400, 500, 600, 700].includes(fw) ? fw : 400;
        applySettings();
        refreshSettingsUI();
      });
    }

    const bindCheck = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        S[key] = el.checked;
        applySettings();
        refreshSettingsUI();
      });
    };
    bindCheck('rs-justify', 'justify');
    bindCheck('rs-hyphenate', 'hyphenate');
    bindCheck('rs-publisher-font', 'usePublisherFont');

    const fullWidthEl = $('rs-full-width');
    if (fullWidthEl) {
      fullWidthEl.addEventListener('change', () => {
        if (fullWidthEl.checked) {
          S.maxWidth = 99999;
        } else if (isFullWidth()) {
          S.maxWidth = 720;
        }
        applySettings();
        refreshSettingsUI();
      });
    }

    const chromePinnedEl = $('rs-chrome-pinned');
    if (chromePinnedEl) {
      chromePinnedEl.addEventListener('change', () => {
        S.chromePinned = chromePinnedEl.checked;
        applyChromePinnedLayout({ triggerResize: true, resumeAutohide: !S.chromePinned });
        saveSettings();
        refreshSettingsUI();
      });
    }

    initTapZonesSettings();

    const ttsRateEl = $('rs-tts-rate');
    const ttsRateVal = $('rs-tts-rate-val');
    if (ttsRateEl) {
      ttsRateEl.addEventListener('input', () => {
        setTtsRate(Number(ttsRateEl.value), { persist: true, fromSlider: true });
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

    document.querySelectorAll('.panel-body input[type="range"]').forEach(guardRangeSliderTouchScroll);
  }

  function refreshSettingsUI() {
    const toggle = (sel, attr, val) => document.querySelectorAll(sel).forEach(b => b.classList.toggle('is-active', b.dataset[attr] === val));
    toggle('[data-set-theme]', 'setTheme', S.theme);
    toggle('[data-set-layout]', 'setLayout', S.layout);
    populateFontSelect();
    const fs = $('rs-font-family');
    if (fs) {
      if (!(S.font in fontMap)) S.font = defaults.font;
      fs.value = S.font;
      fs.disabled = S.usePublisherFont === true;
    }
    const sync = (id, v) => { const el = $(id); if (el) el.value !== undefined ? el.value = v : el.textContent = v; };
    sync('rs-font-size', S.fontSize); sync('rs-font-size-val', S.fontSize);
    sync('rs-line-height', S.lineHeight); sync('rs-line-height-val', Number(S.lineHeight).toFixed(1));
    sync('rs-page-margin', S.pageMargin);
    sync('rs-page-margin-val', `${S.pageMargin} px`);
    sync('rs-vertical-margin', S.verticalMargin);
    sync('rs-vertical-margin-val', `${S.verticalMargin} px`);
    sync('rs-column-gap', S.columnGap);
    sync('rs-column-gap-val', `${S.columnGap}%`);
    sync('rs-max-block-size', S.maxBlockSize);
    sync('rs-max-block-size-val', `${Math.round(S.maxBlockSize)} px`);
    sync('rs-letter-spacing', S.letterSpacing);
    sync('rs-letter-spacing-val', Number(S.letterSpacing).toFixed(2));
    sync('rs-paragraph-spacing', S.paragraphSpacing);
    sync('rs-paragraph-spacing-val', Number(S.paragraphSpacing).toFixed(2));
    sync('rs-text-indent', S.textIndent);
    sync('rs-text-indent-val', `${Number(S.textIndent).toFixed(1)} em`);
    const fwEl = $('rs-font-weight');
    if (fwEl) fwEl.value = String(S.fontWeight || 400);
    const justifyEl = $('rs-justify');
    if (justifyEl) justifyEl.checked = S.justify !== false;
    const hyphenateEl = $('rs-hyphenate');
    if (hyphenateEl) hyphenateEl.checked = S.hyphenate !== false;
    const publisherFontEl = $('rs-publisher-font');
    if (publisherFontEl) publisherFontEl.checked = S.usePublisherFont === true;
    const cwSlider = $('rs-column-width');
    const cwVal = $('rs-column-width-val');
    const fullW = isFullWidth();
    if (cwSlider) {
      cwSlider.disabled = fullW;
      cwSlider.value = fullW ? 720 : Math.min(920, Math.max(480, Number(S.maxWidth) || 720));
    }
    if (cwVal) cwVal.textContent = fullW ? rt('reader.fullWidth') : `${Math.round(S.maxWidth)} px`;
    const fullWidthEl = $('rs-full-width');
    if (fullWidthEl) fullWidthEl.checked = fullW;
    const chromePinnedEl = $('rs-chrome-pinned');
    if (chromePinnedEl) chromePinnedEl.checked = Boolean(S.chromePinned);
    const pagGroup = $('rs-layout-paginated');
    const dualGroup = $('rs-layout-dual');
    const scrolledGroup = $('rs-layout-scrolled');
    if (pagGroup) pagGroup.hidden = S.layout !== 'paginated';
    if (dualGroup) dualGroup.hidden = S.layout !== 'dual';
    if (scrolledGroup) scrolledGroup.hidden = S.layout !== 'scrolled';
    const ap = getActivePreset();
    document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('is-active', b.dataset.preset === ap));
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
    const lcEl = $('rs-link-color');
    if (lcEl) {
      const v = getEffectiveLinkColor();
      if (lcEl.value !== v) lcEl.value = v;
    }
    refreshTapZonesUi();
    updateSeekbar();
    updateDayNightButton();
    const ttsR = $('rs-tts-rate');
    const ttsRV = $('rs-tts-rate-val');
    if (ttsR) {
      const r = Number(S.ttsRate);
      ttsR.value = String(Number.isFinite(r) ? Math.min(2, Math.max(0.5, r)) : 1);
      if (ttsRV) ttsRV.textContent = Number(ttsR.value).toFixed(2);
    }
    updateTtsDockRateUi();
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

  const TTS_RATE_MIN = 0.5;
  const TTS_RATE_MAX = 2;
  const TTS_RATE_STEP = 0.1;

  function clampTtsRate(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 1;
    return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, Math.round(n * 100) / 100));
  }

  function updateTtsDockRateUi() {
    const rate = clampTtsRate(S.ttsRate);
    const label = $('tts-dock-rate');
    if (label) label.textContent = `${rate.toFixed(2)}×`;
    const slower = $('btn-tts-dock-slower');
    const faster = $('btn-tts-dock-faster');
    if (slower) slower.disabled = rate <= TTS_RATE_MIN + 1e-9;
    if (faster) faster.disabled = rate >= TTS_RATE_MAX - 1e-9;
  }

  function setTtsRate(next, opts = {}) {
    const rate = clampTtsRate(next);
    S.ttsRate = rate;
    if (!opts.fromSlider) {
      const ttsR = $('rs-tts-rate');
      const ttsRV = $('rs-tts-rate-val');
      if (ttsR) ttsR.value = String(rate);
      if (ttsRV) ttsRV.textContent = rate.toFixed(2);
    } else {
      const ttsRV = $('rs-tts-rate-val');
      if (ttsRV) ttsRV.textContent = rate.toFixed(2);
    }
    updateTtsDockRateUi();
    if (opts.persist !== false) saveSettings();
  }

  function applyTtsUtteranceSettings(u) {
    u.rate = clampTtsRate(S.ttsRate);
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
    [btnTtsStop, btnTtsDockStop].forEach((btn) => {
      if (!btn) return;
      btn.hidden = !ttsChainActive;
    });
    if (ttsDockEl) {
      ttsDockEl.classList.toggle('is-visible', ttsChainActive);
      ttsDockEl.setAttribute('aria-hidden', ttsChainActive ? 'false' : 'true');
    }
    updateTtsDockRateUi();
    document.body.classList.toggle('reader-tts-active', ttsChainActive);
    if (!ttsChainActive) pauseTtsKeepalive();
    syncTtsMediaSessionPlayback();
    if (ttsChainActive) syncTtsMediaMetadata();
  }

  function stopReaderTts() {
    ttsSpeakToken++;
    clearTtsBackgroundMaintain();
    ttsKickSpeak = null;
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
    try { view?.tts?.clearHighlight?.(); } catch { /* */ }
    try { view?.deselect?.(); } catch { /* */ }
    hideSelMenu();
    activeSel = null;
    ttsChainActive = false;
    ttsPausedByUser = false;
    ttsAdvancingSection = false;
    releaseReaderWakeLock();
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
      ttsKickSpeak = null;
      clearTtsBackgroundMaintain();
      ttsNav.skipBack = () => {};
      ttsNav.skipForward = () => {};
      releaseReaderWakeLock();
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
      u.onstart = () => {
        lastTtsSpeechAt = Date.now();
        void startTtsKeepalivePlayback();
      };
      /**
       * Пока страница скрыта, Chrome/Android отменяет фразу без реального произнесения, и
       * onend/onerror всё равно срабатывают — если в этот момент продвинуть idx, цепочка
       * молча проматывается вперёд (иногда на главы) пока не вернётся видимость. Поэтому в
       * скрытом состоянии просто выходим без advance; resumeTtsAfterHidden() повторит этот
       * же сегмент, когда страница снова станет видимой.
       */
      u.onend = () => {
        lastTtsSpeechAt = Date.now();
        if (!ttsChainActive || token !== ttsSpeakToken) return;
        if (document.visibilityState === 'hidden') return;
        idx++;
        speakStep();
      };
      u.onerror = () => {
        lastTtsSpeechAt = Date.now();
        if (!ttsChainActive || token !== ttsSpeakToken) return;
        if (document.visibilityState === 'hidden') return;
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

    ttsKickSpeak = speakStep;
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
    lastTtsSpeechAt = Date.now();
    try { view?.deselect?.(); } catch { /* */ }
    hideSelMenu();
    activeSel = null;
    void acquireReaderWakeLock();
    setChromeVisible(true);
    updateTtsButtons();
    void startTtsKeepalivePlayback();
    if (document.visibilityState === 'hidden') maintainTtsInBackground();
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
      void acquireReaderWakeLock();
    } else {
      try {
        speechSynthesis.pause();
      } catch { /* */ }
      ttsPausedByUser = true;
      releaseReaderWakeLock();
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

  document.querySelectorAll('.js-tts-stop').forEach((btn) => {
    btn.addEventListener('click', () => {
      stopReaderTts();
      scheduleChromeHide();
    });
  });

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

  const btnTtsDockSlower = $('btn-tts-dock-slower');
  const btnTtsDockFaster = $('btn-tts-dock-faster');
  if (btnTtsDockSlower) {
    btnTtsDockSlower.addEventListener('click', () => {
      setTtsRate(clampTtsRate(S.ttsRate) - TTS_RATE_STEP);
    });
  }
  if (btnTtsDockFaster) {
    btnTtsDockFaster.addEventListener('click', () => {
      setTtsRate(clampTtsRate(S.ttsRate) + TTS_RATE_STEP);
    });
  }
  updateTtsDockRateUi();

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
  $('btn-search')?.addEventListener('click', () => openPanel('search'));
  $('btn-bookmark-add')?.addEventListener('click', addBookmark);
  tocSearchInput?.addEventListener('input', renderTocTab);
  tocPrevBtn?.addEventListener('click', () => goTocIdx(getTocIdx() - 1));
  tocNextBtn?.addEventListener('click', () => goTocIdx(getTocIdx() + 1));
  const bookSearchInput = $('book-search-input');
  if (bookSearchInput) {
    bookSearchInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => runBookSearch(bookSearchInput.value), 350);
    });
    bookSearchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(searchDebounce); runBookSearch(bookSearchInput.value); }
    });
  }
  initAnnotations();
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
    if (e.key === 'Escape') {
      const ed = $('reader-note-editor');
      if (ed && ed.classList.contains('is-open')) { closeNoteEditor(); return; }
      const sm = $('reader-sel-menu');
      if (sm && sm.classList.contains('is-open')) { hideSelMenu(); activeSel = null; return; }
      closePanel();
      return;
    }
    if (panelOverlay.classList.contains('is-open')) return;
    const k = e.key;
    if (k === 'd' || k === 'D') { toggleDayNightTheme(); return; }
    if (k === 'b' || k === 'B') { addBookmark(); return; }
    if (k === 'f' || k === 'F') { toggleFullscreen(); return; }
    if (k === 's' || k === 'S') { openPanel('settings'); return; }
    if (k === 't' || k === 'T') { openPanel('toc'); return; }
    if (k === '/') { e.preventDefault(); openPanel('search'); return; }
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
        syncReaderGoogleFont(fnView.renderer?.getContents?.()?.[0]?.doc).then(() => {
          fnView.renderer?.setStyles?.(getBookCSS());
        });
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

    /** Макс. сдвиг пальца для «тапа»; Foliate на touchmove листает при меньшем dx — см. touchmove cancel. */
    const TAP_SLOP_PX = 22;
    const TAP_MAX_MS = 700;
    const TAP_LONG_MS = 480;
    /** Любой touchmove дальше — не тап (иначе после лёгкого drag Foliate touchend + наш тап = двойной сдвиг). */
    const TAP_CANCEL_MOVE_PX = 10;
    let screenTapTrack = null;

    /**
     * Координаты тапа относительно видимого foliate-view + id зоны 3×3.
     * clientX/Y в iframe → page coords через frameElement.
     */
    function tapCoordsInHost(clientX, clientY, doc_) {
      const win = doc_?.defaultView;
      const iframe = win?.frameElement;
      const host = view?.getBoundingClientRect?.();
      if (!iframe || !host?.width) return null;
      const fr = iframe.getBoundingClientRect();
      const px = fr.left + clientX;
      const py = fr.top + clientY;
      const fx = Math.max(0, Math.min(1, (px - host.left) / Math.max(1, host.width)));
      const fy = Math.max(0, Math.min(1, (py - host.top) / Math.max(1, host.height)));
      const el = doc_?.documentElement;
      const wm = (el && win?.getComputedStyle(el).writingMode || 'horizontal-tb').toLowerCase();
      const zone = resolveTapZone9(fx, fy, { verticalWriting: wm.startsWith('vertical') });
      return { fx, fy, zone, pageX: px, pageY: py };
    }

    function clearScreenTapLongPress() {
      if (screenTapTrack?.longTimer) clearTimeout(screenTapTrack.longTimer);
      if (screenTapTrack) screenTapTrack.longTimer = null;
    }

    function armScreenTapLongPress(doc_) {
      clearScreenTapLongPress();
      if (!screenTapTrack) return;
      screenTapTrack.longTimer = setTimeout(() => {
        if (!screenTapTrack || screenTapTrack.longFired) return;
        try {
          const sel = doc_?.getSelection?.();
          if (sel && !sel.isCollapsed && String(sel).trim()) {
            clearScreenTapLongPress();
            screenTapTrack = null;
            return;
          }
        } catch { /* */ }
        screenTapTrack.longFired = true;
        const coords = tapCoordsInHost(screenTapTrack.x, screenTapTrack.y, doc_);
        const zone = coords?.zone || 'mm';
        const action = S.tapZonesLong?.[zone] || 'none';
        screenTapTrack = null;
        runTapAction(action);
      }, TAP_LONG_MS);
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
        screenTapTrack = { x: t.clientX, y: t.clientY, t: Date.now(), longFired: false, longTimer: null };
        armScreenTapLongPress(doc);
      } else {
        clearScreenTapLongPress();
        screenTapTrack = null;
      }
    }, { capture: true, passive: true });

    doc.addEventListener('touchmove', e => {
      if (!isFlowPaginated() || !screenTapTrack || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (Math.hypot(t.clientX - screenTapTrack.x, t.clientY - screenTapTrack.y) > TAP_CANCEL_MOVE_PX) {
        clearScreenTapLongPress();
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
      if (!screenTapTrack || e.changedTouches.length !== 1) return;
      if (screenTapTrack.longFired) {
        clearScreenTapLongPress();
        screenTapTrack = null;
        e.preventDefault();
        return;
      }
      const t = e.changedTouches[0];
      if (panelBlocksBookTap(touchToPageY(t.clientY, doc))) {
        clearScreenTapLongPress();
        screenTapTrack = null;
        return;
      }
      const dt = Date.now() - screenTapTrack.t;
      const adx = Math.abs(t.clientX - screenTapTrack.x);
      const ady = Math.abs(t.clientY - screenTapTrack.y);
      if (dt > TAP_MAX_MS || adx > TAP_SLOP_PX || ady > TAP_SLOP_PX) {
        clearScreenTapLongPress();
        screenTapTrack = null;
        return;
      }
      clearScreenTapLongPress();
      const zone = tapCoordsInHost(t.clientX, t.clientY, doc)?.zone || 'mm';
      const action = S.tapZonesShort?.[zone] || 'toggleChrome';
      screenTapTrack = null;
      e.preventDefault();
      runTapAction(action);
    }, { capture: true, passive: false });

    doc.addEventListener('touchcancel', () => {
      clearScreenTapLongPress();
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
    let pointerLongTrack = null;
    let pointerLongFired = false;

    function clearPointerLongPress() {
      if (pointerLongTrack?.longTimer) clearTimeout(pointerLongTrack.longTimer);
      pointerLongTrack = null;
    }

    function armPointerLongPress(doc_, x, y) {
      clearPointerLongPress();
      pointerLongFired = false;
      pointerLongTrack = { x, y, longTimer: null };
      pointerLongTrack.longTimer = setTimeout(() => {
        if (!pointerLongTrack || pointerLongFired) return;
        try {
          const sel = doc_?.getSelection?.();
          if (sel && !sel.isCollapsed && String(sel).trim()) {
            clearPointerLongPress();
            return;
          }
        } catch { /* */ }
        pointerLongFired = true;
        const zone = tapCoordsInHost(pointerLongTrack.x, pointerLongTrack.y, doc_)?.zone || 'mm';
        const action = S.tapZonesLong?.[zone] || 'none';
        clearPointerLongPress();
        runTapAction(action);
      }, TAP_LONG_MS);
    }

    doc.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      pointerDownOnLink = !!e.target.closest?.('a[href]');
      pStart = { x: e.clientX, y: e.clientY, t: Date.now() };
      pointerLongFired = false;
      if (
        isFlowPaginated()
        && (e.pointerType === 'mouse' || e.pointerType === 'pen')
        && !pointerDownOnLink
      ) {
        armPointerLongPress(doc, e.clientX, e.clientY);
      } else {
        clearPointerLongPress();
      }
    });

    doc.addEventListener('pointermove', e => {
      if (!pointerLongTrack) return;
      if (Math.hypot(e.clientX - pointerLongTrack.x, e.clientY - pointerLongTrack.y) > TAP_CANCEL_MOVE_PX) {
        clearPointerLongPress();
      }
    });

    doc.addEventListener('pointercancel', () => {
      clearPointerLongPress();
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
        clearPointerLongPress();
        return;
      }
      if (!pStart || e.button !== 0) {
        pointerDownOnLink = false;
        clearPointerLongPress();
        return;
      }
      const fromLink = pointerDownOnLink;
      pointerDownOnLink = false;
      const startX = pStart.x, startY = pStart.y, startT = pStart.t;
      const dx = e.clientX - startX, dy = e.clientY - startY, dt = Date.now() - startT;
      pStart = null;
      const longFired = pointerLongFired;
      clearPointerLongPress();
      if (longFired) return;

      const adx = Math.abs(dx), ady = Math.abs(dy);
      /* Мышь: горизонтальный свайп с любого места (как у многих десктоп-ридеров). Перо: только с края — иначе мешает выделению. */
      if (adx > 30 && adx > ady * 2 && dt < 800) {
        if (e.pointerType === 'mouse') {
          if (dx < 0) view?.goRight(); else view?.goLeft();
          void acquireReaderWakeLock();
          return;
        }
        if (e.pointerType === 'pen') {
          const zStart = tapCoordsInHost(startX, startY, doc)?.zone || '';
          if (zStart.endsWith('l') || zStart.endsWith('r')) {
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

      const zone = tapCoordsInHost(e.clientX, e.clientY, doc)?.zone || 'mm';
      runTapAction(S.tapZonesShort?.[zone] || 'toggleChrome');
    });

    /* Клик по полям foliate-view вне iframe (фон колонок) — тоже зоны 3×3. */
    view.addEventListener('click', e => {
      if (!isFlowPaginated()) return;
      if (e.defaultPrevented) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (path.some((n) => n && (n.tagName === 'IFRAME' || n.tagName === 'A' || n.tagName === 'BUTTON'
        || n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT'))) return;
      const host = view.getBoundingClientRect();
      if (!host.width) return;
      const fx = (e.clientX - host.left) / host.width;
      const fy = (e.clientY - host.top) / host.height;
      const zone = resolveTapZone9(fx, fy);
      runTapAction(S.tapZonesShort?.[zone] || 'toggleChrome');
    });

    const WHEEL_FLIP_PX = 28;
    doc.addEventListener('wheel', e => {
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
      '<a href="' + readerBookPagePath() + '" class="tb-btn" style="margin-top:12px;">' + esc(rt('readerJs.back')) + '</a></div>';
  }

  /* ===== Reader ext classifier (kept in sync with server utils/book-format.js) ===== */
  function classifyExt(ext) {
    // Strip trailing `.zip` so composite exts like `pdf.zip` / `djvu.zip`
    // (Flibusta wrapper packs) classify as their underlying format.
    const raw = String(ext || '').toLowerCase().replace(/^\./, '');
    const e = raw.replace(/\.zip$/, '');
    if (e === 'pdf') return 'pdf';
    if (e === 'djvu' || e === 'djv') return 'djvu';
    if (e === 'fb2' || e === 'fbz' || e === 'epub' || e === 'mobi' || e === 'azw3' || e === 'kf8' || e === 'cbz') return 'foliate';
    return 'unsupported';
  }

  function isZipMagic(h) {
    return h[0] === 0x50 && h[1] === 0x4b && h[2] === 0x03 && h[3] === 0x04;
  }

  function isSevenZipMagic(h) {
    return h[0] === 0x37 && h[1] === 0x7a && h[2] === 0xbc && h[3] === 0xaf;
  }

  async function inspectZipBookKind(buffer) {
    try {
      const { configure, ZipReader, BlobReader, TextWriter } = await import('/foliate/vendor/zip.js');
      configure({ useWebWorkers: false });
      const reader = new ZipReader(new BlobReader(new Blob([buffer])));
      const entries = await reader.getEntries();
      const mimeEntry = entries.find((entry) => {
        const p = String(entry.filename || '').replace(/\\/g, '/').toLowerCase();
        return p === 'mimetype' || p.endsWith('/mimetype');
      });
      if (mimeEntry) {
        const mime = String(await mimeEntry.getData(new TextWriter())).trim();
        if (mime === 'application/epub+zip') {
          await reader.close();
          return 'epub';
        }
      }
      if (entries.some((entry) => /meta-inf\/container\.xml$/i.test(String(entry.filename || '').replace(/\\/g, '/')))) {
        await reader.close();
        return 'epub';
      }
      const fb2Entry = entries.find((entry) => /\.fb2$/i.test(String(entry.filename || '')));
      if (fb2Entry) {
        await reader.close();
        return 'fb2';
      }
      await reader.close();
    } catch {
      /* fall through */
    }
    return null;
  }

  /** Определяет реальный формат по содержимому — важно, если ext в URL/профиле неверный. */
  async function sniffBookExt(buffer, fallbackExt) {
    const fb = String(fallbackExt || 'fb2').toLowerCase().replace(/^\./, '').replace(/\.zip$/, '');
    if (!buffer || buffer.byteLength < 4) return fb || 'fb2';
    const h = new Uint8Array(buffer);
    if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) return 'pdf';
    if (isSevenZipMagic(h)) {
      if (fb.includes('epub')) {
        throw new Error(
          'EPUB сохранён в формате 7z. Скачайте книгу заново — сервер перепакует файл в EPUB (ZIP).',
        );
      }
      return fb || 'fb2';
    }
    if (isZipMagic(h)) {
      const zipKind = await inspectZipBookKind(buffer);
      if (zipKind) return zipKind;
      if (fb.includes('epub')) return 'epub';
      if (fb === 'fb2' || fb === 'fbz') return 'fb2';
      if (fb.includes('mobi') || fb.includes('azw')) return fb;
      return 'epub';
    }
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, Math.min(buffer.byteLength, 512)));
    if (sample.includes('FictionBook') || /<\?xml/i.test(sample)) return 'fb2';
    return fb || 'fb2';
  }

  /**
   * PDF/DJVU are not supported by foliate-js. For PDF we fall back to the
   * browser's native PDF viewer (same-origin iframe, which Chrome/Edge/Firefox
   * render via their built-in viewer). For DJVU — no browser has a native
   * renderer, so we show a clear "download to read" banner instead of the
   * cryptic "Failed to load container file" message from foliate-js.
   */
  function showUnsupportedBanner(kind) {
    bookPagesEl?.classList.add('is-hidden');
    const downloadHref = globalThis.downloadBookPath ? globalThis.downloadBookPath(bookId) : `/download/${encodeURIComponent(bookId)}`;
    const title = kind === 'djvu' ? rt('readerJs.djvuUnsupportedTitle') : rt('readerJs.unsupportedTitle');
    const text = kind === 'djvu' ? rt('readerJs.djvuUnsupportedText') : rt('readerJs.unsupportedText');
    readerBody.innerHTML =
      '<div class="reader-error">' +
      '<div class="reader-error-title">' + esc(title) + '</div>' +
      '<div class="reader-error-text">' + esc(text) + '</div>' +
      '<div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">' +
      '<a href="' + downloadHref + '" class="tb-btn" download>' + esc(rt('readerJs.download')) + '</a>' +
      '<a href="' + readerBookPagePath() + '" class="tb-btn">' + esc(rt('readerJs.back')) + '</a>' +
      '</div></div>';
  }

  /* ===== Main ===== */
  async function loadBook() {
    stopReaderTts();
    invalidateBookPageCache();
    bookPagesEl?.classList.add('is-hidden');
    closeReaderFootnote();
    footnoteHandler = null;

    // Branch on book type: foliate-js doesn't handle PDF/DJVU. For PDF we let
    // the browser's native PDF viewer render the file; for DJVU we surface a
    // clear download prompt (no browser has a native DJVU renderer).
    const kind = classifyExt(bookExt);
    const contentSuffix = 'content/book.' + bookExt.toLowerCase();
    const url = globalThis.apiBookPath
      ? globalThis.apiBookPath(bookId, contentSuffix)
      : `/api/books/${encodeURIComponent(bookId)}/${contentSuffix}`;

    if (kind === 'pdf') {
      readerBody.innerHTML = '<iframe class="reader-pdf-frame" src="' + url + '" title="PDF"></iframe>';
      return;
    }
    if (kind === 'djvu') {
      showUnsupportedBanner('djvu');
      return;
    }
    if (kind === 'unsupported') {
      showUnsupportedBanner('generic');
      return;
    }

    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(rtp('readerJs.loadError', { status: res.status }));
    const buffer = await res.arrayBuffer();
    const effectiveExt = await sniffBookExt(buffer, bookExt);
    effectiveBookExt = effectiveExt;
    const file = new File([buffer], 'book.' + effectiveExt.toLowerCase());

    view = document.createElement('foliate-view');
    readerBody.replaceChildren(view);
    await view.open(file);

      fb2FlatToc = isFb2Active() ? flattenTocForSeek(view.book?.toc) : [];
      window.__READER_FB2_FLAT_TOC__ = flatTocForPrompt();

    view.renderer.setAttribute('flow', layoutMode() === 'scrolled' ? 'scrolled' : 'paginated');
    applyRendererLayout();
    await syncReaderGoogleFont();
    applyBookStyles();

    view.addEventListener('load', ({ detail: { doc, index } }) => {
      if (!ttsAdvancingSection) stopReaderTts();
      if (doc && index != null) docIndexMap.set(doc, index);
      void applySectionStyles(doc);
      wireDoc(doc);
      wireSelection(doc);
    });

    wireViewAnnotations();
    wireFootnotes();

    view.addEventListener('relocate', ({ detail }) => {
      const loc = view.lastLocation || detail;
      const payload = positionFromLocation(loc);
      const why = detail.reason;
      if (!seekBarUserActive) {
        setProgressFromFraction(payload.fraction, loc.tocItem ?? detail.tocItem);
      }
      updateBookPageDisplay(loc);
      if (
        !seekBarUserActive
        && (
          payload.position
          || payload.fb2Href
          || payload.fraction > 0
          || Number.isFinite(Number(payload.sectionIndex))
        )
      ) {
        savePositionPayload(payload, why);
      }
      if (why === 'snap' || why === 'page' || why === 'navigation') {
        try { view.deselect?.(); } catch { /* */ }
        hideSelMenu();
        activeSel = null;
      }
    });

    if (view.book?.toc) { tocData = []; buildToc(view.book.toc, 1); }
    renderTocTab(); updateTocBtnState();

    await positionSaveSuppression.run(async () => {
      const urlPos = new URLSearchParams(location.search).get('pos');
      const saved = await loadSavedPosition();
      const restoreTarget = await resolveCrossDevicePositionOnOpen(saved, urlPos);
      await restoreReadingPosition(restoreTarget, urlPos);
      await waitForLayoutSettled(2000);
      await maybeShowDeferredCrossDevicePrompt();
    });
    clearTimeout(chromeTimer);
    setChromeVisible(false);
    void acquireReaderWakeLock();
  }

  /* Две колонки: при ресайзе окна пересчитать ширину колонки (без лишнего saveSettings). */
  let resizeTimer = null;
  function onViewportResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      if (!view?.renderer) return;
      await positionSaveSuppression.run(async () => {
        applyRendererLayout();
        if (view.lastLocation) updateBookPageDisplay(view.lastLocation);
        await waitForLayoutSettled(1500);
      });
    }, 120);
  }
  window.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('resize', onViewportResize);

  /* ===== Boot ===== */
  applySettings();

  async function pollOpenBookPosition() {
    if (document.visibilityState === 'hidden') return;
    if (crossDevicePromptPromise || pendingCrossDevicePrompt) return;
    if (!view) return;
    try {
      const saved = await loadSavedPosition();
      if (!saved) return;
      const localCtx = readPosSeenCtx();
      if (!shouldPromptLiveCrossDevice(readerSessionId, localCtx, saved)) return;
      writePosSeenCtx(observeServerConflict(localCtx, saved));
      pendingCrossDevicePrompt = { saved, localCtx };
      await positionSaveSuppression.run(() => maybeShowDeferredCrossDevicePrompt());
    } catch {
      /* ignore poll errors */
    }
  }

  const OPEN_BOOK_POSITION_POLL_MS = 15_000;
  setInterval(() => { void pollOpenBookPosition(); }, OPEN_BOOK_POSITION_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pollOpenBookPosition();
  });
  (async () => {
    try {
      await loadBookmarks(); renderBmTab();
      await loadAnnotations();
      await loadBook();
      applyAllAnnotations();
    } catch (e) {
      console.error(e);
      showError(e.message || rt('readerJs.loadBookFail'));
    }
  })();
})();
