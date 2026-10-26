/**
 * Read aloud (TTS) for the web reader (`public/reader.js`) and the Android reader
 * (`inpx-book-reader`, synced into `public/inpx-reader/reader-shared/` by `npm run sync:shared`).
 *
 * The controller owns the whole feature: the utterance chain over Foliate's `view.tts`
 * (sentence marks from the SSML), the player dock, the settings block, sentence + word
 * highlight, the sleep timer and «читать отсюда» in the selection menu. The host keeps
 * what differs between the two clients — wake lock, background keep-alive, media session /
 * Android notification — and gets `onStateChange({ active, paused })`.
 *
 * Speech goes through `window.speechSynthesis` / `window.SpeechSynthesisUtterance`, which the
 * Android bridge (`reader-native-bridge.js`) replaces with the native TextToSpeech engine; the
 * bridge reports word ranges (`onRangeStart`) as `boundary` events, the browser does it itself
 * for most local voices.
 */

export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 3;
export const TTS_PITCH_MIN = 0.5;
export const TTS_PITCH_MAX = 2;
const TTS_RATE_STEP = 0.1;

export const TTS_SETTING_DEFAULTS = Object.freeze({
  ttsRate: 1,
  ttsVoice: '',
  ttsPitch: 1,
  /** off | sentence | word (sentence + the word being spoken) */
  ttsHighlight: 'word',
  ttsHlColor: 'yellow',
  /** fill | underline */
  ttsHlStyle: 'fill',
  /** Turn pages after the voice. */
  ttsFollow: true,
  /** Do not read footnote markers like [12] or {3}. */
  ttsSkipNoteRefs: true,
  /** Pause between paragraphs: 0 none, 1 short, 2 long. */
  ttsParaPause: 0,
  /** Sleep timer restarts while the phone moves or the reader is touched; the voice fades out before it fires. */
  ttsSleepMotion: true,
  /** high | medium | low — how much movement restarts the sleep timer (TTS_MOTION_LEVELS). */
  ttsSleepMotionLevel: 'medium',
});

const HL_MODES = ['off', 'sentence', 'word'];
const HL_STYLES = ['fill', 'underline'];
export const TTS_HL_COLORS = Object.freeze({
  yellow: '#f2c230',
  green: '#59b86b',
  blue: '#4a94e0',
  pink: '#e4669c',
  gray: '#8c8c8c',
});
const PARA_PAUSE_MS = [0, 350, 900];
const SLEEP_CHOICES = [0, 15, 30, 45, 60, 90, 'chapter'];
const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const KEY_SENTENCE = 'reader-tts-sentence';
const KEY_WORD = 'reader-tts-word';
/**
 * «Телефон в руках»: the gravity vector moves away from its slow average by more than `threshold`
 * m/s² for at least `spanMs`. A phone in a hand keeps wobbling; a phone on a bed only gets short
 * jolts when someone moves next to it, which «medium» / «low» ignore.
 */
export const TTS_MOTION_LEVELS = Object.freeze({
  high: Object.freeze({ threshold: 0.3, spanMs: 0 }),
  medium: Object.freeze({ threshold: 0.8, spanMs: 700 }),
  low: Object.freeze({ threshold: 1.5, spanMs: 1500 }),
});
/** Quieter samples shorter than this do not break a movement. */
const MOTION_GAP_MS = 600;
/** Time constant of the slow average (orientation the phone rests in). */
const MOTION_BASE_TAU_MS = 1000;
/** The voice fades out over the last minute of the sleep timer. */
const SLEEP_FADE_MS = 60000;
const SLEEP_FADE_MIN_VOLUME = 0.25;
const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP_PX = 14;

const STRINGS = {
  ru: {
    bar: 'Озвучка',
    play: 'Читать вслух',
    pause: 'Пауза',
    resume: 'Продолжить',
    stop: 'Остановить озвучку',
    prev: 'Предыдущая фраза',
    next: 'Следующая фраза',
    prevPara: 'Предыдущий абзац',
    nextPara: 'Следующий абзац',
    slower: 'Медленнее',
    faster: 'Быстрее',
    rateMenu: 'Скорость чтения',
    locate: 'К читаемому месту',
    settings: 'Настройки озвучки',
    sleep: 'Таймер сна',
    sleepOff: 'Выключен',
    sleepMin: '{n} мин',
    sleepChapter: 'До конца главы',
    sleepChapterShort: 'Глава',
    sleepDone: 'Таймер сна: озвучка на паузе',
    sleepMotion: 'Таймер сна: продлевать, пока телефон в руках',
    sleepMotionHint: 'Пока телефон шевелится или вы касаетесь экрана, отсчёт начинается заново. За минуту до конца голос плавно стихает — пошевелите телефон, чтобы слушать дальше.',
    sleepMotionLevel: 'Чувствительность к движению',
    motionHigh: 'Высокая',
    motionMedium: 'Средняя',
    motionLow: 'Низкая',
    fromHere: 'Читать отсюда',
    noPrev: 'Это начало главы',
    bookEnd: 'Книга дочитана',
    fixedLayout: 'Озвучка недоступна для фиксированной вёрстки',
    unavailable: 'Озвучка недоступна в этом браузере',
    noText: 'Нет текста для озвучки',
    voice: 'Голос',
    voiceAuto: 'Авто — по языку книги',
    voiceBookLang: 'Язык книги',
    voiceOther: 'Другие языки',
    voiceNetwork: 'сеть',
    voiceDefaultMark: 'по умолчанию',
    preview: 'Прослушать',
    previewText: 'Так звучит выбранный голос. Приятного чтения!',
    rate: 'Скорость',
    pitch: 'Тон голоса',
    highlight: 'Подсветка',
    hlOff: 'Нет',
    hlSentence: 'Фраза',
    hlWord: 'Фраза и слово',
    hlColor: 'Цвет подсветки',
    hlFill: 'Заливка',
    hlUnderline: 'Подчёркивание',
    follow: 'Листать страницы за голосом',
    skipNotes: 'Не читать номера сносок',
    paraPause: 'Паузы между абзацами',
    pauseNone: 'Нет',
    pauseShort: 'Короткие',
    pauseLong: 'Длинные',
    wordHint: 'Подсветка слова работает, если голос сообщает границы слов (обычно это голоса на устройстве).',
    colors: { yellow: 'Жёлтый', green: 'Зелёный', blue: 'Синий', pink: 'Розовый', gray: 'Серый' },
  },
  en: {
    bar: 'Read aloud',
    play: 'Read aloud',
    pause: 'Pause',
    resume: 'Resume',
    stop: 'Stop reading aloud',
    prev: 'Previous sentence',
    next: 'Next sentence',
    prevPara: 'Previous paragraph',
    nextPara: 'Next paragraph',
    slower: 'Slower',
    faster: 'Faster',
    rateMenu: 'Reading speed',
    locate: 'Go to the spoken text',
    settings: 'Read aloud settings',
    sleep: 'Sleep timer',
    sleepOff: 'Off',
    sleepMin: '{n} min',
    sleepChapter: 'End of chapter',
    sleepChapterShort: 'Chapter',
    sleepDone: 'Sleep timer: reading paused',
    sleepMotion: 'Sleep timer: extend while the phone is in hand',
    sleepMotionHint: 'While the phone moves or you touch the screen, the countdown starts over. In the last minute the voice fades out — move the phone to keep listening.',
    sleepMotionLevel: 'Motion sensitivity',
    motionHigh: 'High',
    motionMedium: 'Medium',
    motionLow: 'Low',
    fromHere: 'Read from here',
    noPrev: 'This is the start of the chapter',
    bookEnd: 'End of the book',
    fixedLayout: 'Read aloud is not available for fixed-layout books',
    unavailable: 'Read aloud is not available in this browser',
    noText: 'No text to read aloud',
    voice: 'Voice',
    voiceAuto: 'Auto — book language',
    voiceBookLang: 'Book language',
    voiceOther: 'Other languages',
    voiceNetwork: 'online',
    voiceDefaultMark: 'default',
    preview: 'Preview',
    previewText: 'This is how the selected voice sounds. Enjoy your book!',
    rate: 'Speed',
    pitch: 'Pitch',
    highlight: 'Highlight',
    hlOff: 'None',
    hlSentence: 'Sentence',
    hlWord: 'Sentence and word',
    hlColor: 'Highlight color',
    hlFill: 'Fill',
    hlUnderline: 'Underline',
    follow: 'Turn pages with the voice',
    skipNotes: 'Skip footnote markers',
    paraPause: 'Pauses between paragraphs',
    pauseNone: 'None',
    pauseShort: 'Short',
    pauseLong: 'Long',
    wordHint: 'Word highlight works when the voice reports word boundaries (usually on-device voices).',
    colors: { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink', gray: 'Gray' },
  },
};

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  prev: 'M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z',
  next: 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z',
  prevPara: 'M6 5h2v14H6V5zm3.6 7L18 5v14L9.6 12z',
  nextPara: 'M18 5h2v14h-2V5zm-2.4 7L8 5v14l7.6-7z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  settings: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
  locate: 'M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 3A8.99 8.99 0 0013 3.06V1h-2v2.06A8.99 8.99 0 003.06 11H1v2h2.06A8.99 8.99 0 0011 20.94V23h2v-2.06A8.99 8.99 0 0020.94 13H23v-2h-2.06zM12 19a7 7 0 110-14 7 7 0 010 14z',
  sleep: 'M12.34 2.02C6.59 1.82 2 6.42 2 12c0 5.52 4.48 10 10 10 3.71 0 6.93-2.02 8.66-5.02-7.51-.25-12.09-8.43-8.32-14.96z',
};

/* ===== Pure helpers (unit-tested) ===== */

export function clampTtsRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, Math.round(n * 100) / 100));
}

export function clampTtsPitch(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(TTS_PITCH_MAX, Math.max(TTS_PITCH_MIN, Math.round(n * 100) / 100));
}

/** Fill in / repair the TTS fields of the reader settings object (mutates and returns it). */
export function normalizeTtsSettings(S) {
  const d = TTS_SETTING_DEFAULTS;
  S.ttsRate = Number.isFinite(Number(S.ttsRate)) ? clampTtsRate(S.ttsRate) : d.ttsRate;
  S.ttsPitch = Number.isFinite(Number(S.ttsPitch)) ? clampTtsPitch(S.ttsPitch) : d.ttsPitch;
  if (typeof S.ttsVoice !== 'string') S.ttsVoice = d.ttsVoice;
  if (!HL_MODES.includes(S.ttsHighlight)) S.ttsHighlight = d.ttsHighlight;
  if (!Object.prototype.hasOwnProperty.call(TTS_HL_COLORS, S.ttsHlColor)) S.ttsHlColor = d.ttsHlColor;
  if (!HL_STYLES.includes(S.ttsHlStyle)) S.ttsHlStyle = d.ttsHlStyle;
  S.ttsFollow = typeof S.ttsFollow === 'boolean' ? S.ttsFollow : d.ttsFollow;
  S.ttsSkipNoteRefs = typeof S.ttsSkipNoteRefs === 'boolean' ? S.ttsSkipNoteRefs : d.ttsSkipNoteRefs;
  const pp = Number(S.ttsParaPause);
  S.ttsParaPause = [0, 1, 2].includes(pp) ? pp : d.ttsParaPause;
  S.ttsSleepMotion = typeof S.ttsSleepMotion === 'boolean' ? S.ttsSleepMotion : d.ttsSleepMotion;
  if (!Object.prototype.hasOwnProperty.call(TTS_MOTION_LEVELS, S.ttsSleepMotionLevel)) S.ttsSleepMotionLevel = d.ttsSleepMotionLevel;
  return S;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, e) ? XML_ENTITIES[e] : m;
  });
}

/**
 * Split Foliate's SSML block into sentences. `<mark name="N"/>` is inserted at the START of
 * sentence N, so the mark names the text that follows it (the old parser paired it with the
 * text before it and the highlight ran one sentence ahead of the voice).
 * Tokenized without DOMParser: works in Node tests and never fails on a parser error.
 * @returns {{ mark: string|null, text: string }[]}
 */
export function parseTtsSsmlSegments(ssml) {
  if (!ssml || typeof ssml !== 'string') return [];
  const parts = [];
  let mark = null;
  let buf = '';
  const flush = () => {
    const text = buf.replace(/\s+/g, ' ').trim();
    buf = '';
    if (text) parts.push({ mark, text });
  };
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(ssml))) {
    if (m[1] != null) { buf += m[1]; continue; }
    if (m[6] != null) { buf += decodeXmlEntities(m[6]); continue; }
    if (!m[3]) continue;
    const local = m[3].includes(':') ? m[3].slice(m[3].lastIndexOf(':') + 1) : m[3];
    if (local === 'mark' && !m[2]) {
      flush();
      const nm = /\bname\s*=\s*("([^"]*)"|'([^']*)')/.exec(m[4] || '');
      mark = nm ? decodeXmlEntities(nm[2] ?? nm[3] ?? '') : null;
    } else if (local === 'break') {
      buf += ' ';
    }
  }
  flush();
  return parts;
}

/** Text actually sent to the engine. */
export function cleanTtsText(text, { skipNoteRefs = true } = {}) {
  let s = String(text || '').replace(/­/g, '');
  if (skipNoteRefs) {
    s = s
      .replace(/\[\s*\d{1,4}\s*\]/g, ' ')
      .replace(/\{\s*\d{1,4}\s*\}/g, ' ')
      .replace(/([\p{L}\p{N}.,;:!?»”")])\*{1,3}(?=[\s.,;:!?»”")]|$)/gu, '$1');
  }
  return s.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

/**
 * Map every index of the spoken text onto an index of the source (DOM) text; -1 for spaces
 * and characters the source does not have. Lenient: the source may carry extra characters
 * (soft hyphens, footnote markers we did not speak, NBSPs).
 */
export function alignSpokenText(spoken, source) {
  const map = new Int32Array(spoken.length).fill(-1);
  const src = String(source).toLowerCase();
  const sp = String(spoken).toLowerCase();
  let d = 0;
  for (let i = 0; i < sp.length; i++) {
    const c = sp[i];
    if (/\s/.test(c)) continue;
    const limit = Math.min(src.length, d + 64);
    let k = d;
    while (k < limit && src[k] !== c) k++;
    if (k < limit) {
      map[i] = k;
      d = k + 1;
    }
  }
  return map;
}

/** Length of the word starting at `index` when the engine sends no charLength. */
export function wordLengthAt(text, index) {
  const m = /^[\p{L}\p{N}\p{M}'’‐-]+/u.exec(String(text).slice(index));
  return m ? m[0].length : 1;
}

/** Utterance volume in the last minute of the sleep timer: 1 → 0.25. */
export function sleepFadeVolume(remainingMs, fadeMs = SLEEP_FADE_MS) {
  const r = Number(remainingMs);
  if (!Number.isFinite(r) || r >= fadeMs) return 1;
  const k = Math.max(0, r) / fadeMs;
  return Math.round((SLEEP_FADE_MIN_VOLUME + (1 - SLEEP_FADE_MIN_VOLUME) * k) * 100) / 100;
}

/**
 * Motion detector over accelerometer samples (gravity included, `t` in ms): compares each sample
 * with a slow average (time-based, so 5 Hz Android and 60 Hz browser sensors behave alike) and
 * reports a movement once the difference stays above `threshold` for `spanMs`. A phone lying on
 * a table has ~0.02 m/s² of noise. Same algorithm as TtsMotionWatcher.java.
 */
export function createMotionDetector({ threshold, spanMs } = TTS_MOTION_LEVELS.medium) {
  let base = null;
  let lastT = 0;
  let runStart = 0;
  let lastHit = 0;
  return (x, y, z, t = Date.now()) => {
    const v = [Number(x) || 0, Number(y) || 0, Number(z) || 0];
    if (!base) { base = v; lastT = t; return false; }
    const d = Math.hypot(v[0] - base[0], v[1] - base[1], v[2] - base[2]);
    const alpha = 1 - Math.exp(-Math.max(1, t - lastT) / MOTION_BASE_TAU_MS);
    lastT = t;
    for (let i = 0; i < 3; i++) base[i] += (v[i] - base[i]) * alpha;
    if (d <= threshold) {
      if (runStart && t - lastHit > MOTION_GAP_MS) runStart = 0;
      return false;
    }
    if (!runStart || t - lastHit > MOTION_GAP_MS) runStart = t;
    lastHit = t;
    if (t - runStart < spanMs) return false;
    runStart = 0;
    return true;
  };
}

export function formatSleepLeft(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Android voice ids like `ru-ru-x-ruf-local` → `ru-RU · ruf`; browser voice names stay. */
export function prettyVoiceName(voice, { network = 'online', isDefault = 'default' } = {}) {
  const name = String(voice?.name || voice?.voiceURI || '');
  let m = /^([a-z]{2,3})-([a-z]{2,4})-x-([a-z0-9]+)(?:#([a-z0-9_]+))?-(local|network)$/i.exec(name);
  if (m) {
    const label = `${m[1].toLowerCase()}-${m[2].toUpperCase()} · ${m[3]}${m[4] ? ` ${m[4].replace(/_/g, ' ')}` : ''}`;
    return m[5].toLowerCase() === 'network' ? `${label} (${network})` : label;
  }
  m = /^([a-z]{2,3})-([a-z]{2,4})-language$/i.exec(name);
  if (m) return `${m[1].toLowerCase()}-${m[2].toUpperCase()} (${isDefault})`;
  return voice && voice.localService === false ? `${name} (${network})` : name;
}

/* ===== Controller ===== */

function svgIcon(path, cls = '') {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}><path${cls ? ' class="tts-main-path"' : ''} fill="currentColor" d="${path}"/></svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function drawFill(rects, { color = '#f2c230', opacity = 0.3 } = {}) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('fill', color);
  g.style.opacity = String(opacity);
  for (const { left, top, height, width } of rects) {
    const el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', left - 1);
    el.setAttribute('y', top);
    el.setAttribute('height', height);
    el.setAttribute('width', width + 2);
    el.setAttribute('rx', 2);
    g.append(el);
  }
  return g;
}

function drawUnderline(rects, { color = '#f2c230' } = {}) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('fill', color);
  for (const { left, bottom, width } of rects) {
    const el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('x', left);
    el.setAttribute('y', bottom - 1.5);
    el.setAttribute('height', 3);
    el.setAttribute('width', width);
    el.setAttribute('rx', 1.5);
    g.append(el);
  }
  return g;
}

const STYLE = `
.reader-tts-dock-inner.rtts{position:relative;gap:2px;padding:4px 8px 8px;width:min(400px,calc(100vw - 24px))}
.rtts-head{display:flex;align-items:center;gap:2px;width:100%;min-width:0}
.rtts-title{flex:1 1 auto;min-width:0;padding-left:8px;font-size:12px;line-height:1.3;opacity:.72;color:var(--r-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.reader-tts-dock .reader-tts-dock-btn.rtts-small{min-width:38px;min-height:38px;padding:7px}
.reader-tts-dock .reader-tts-dock-btn.rtts-small svg{width:20px;height:20px}
.rtts-transport{width:100%;justify-content:space-between !important}
.reader-tts-dock .reader-tts-dock-btn.rtts-main{min-width:60px;min-height:60px;background:var(--r-hover);box-shadow:inset 0 0 0 1px var(--r-border)}
.reader-tts-dock .reader-tts-dock-btn.rtts-main svg{width:32px;height:32px}
.reader-tts-dock.is-paused .rtts-main{box-shadow:inset 0 0 0 2px var(--r-accent)}
.rtts-opts{width:100%;gap:8px !important}
.rtts-rate{display:inline-flex;align-items:center;border:1px solid var(--r-border);border-radius:999px;overflow:hidden}
.rtts-rate button,.rtts-chip{background:none;border:none;color:var(--r-fg);font:inherit;cursor:pointer}
.rtts-rate button{min-width:40px;min-height:36px;font-size:20px;line-height:1}
.rtts-rate button:disabled{opacity:.35;cursor:not-allowed}
.rtts-rate .rtts-rate-val{min-width:4.2em;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;border-left:1px solid var(--r-border);border-right:1px solid var(--r-border)}
.rtts-chip{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:4px 12px;border:1px solid var(--r-border);border-radius:999px;font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap}
.rtts-chip svg{width:16px;height:16px;flex:none}
.rtts-chip.is-on{border-color:var(--r-accent);color:var(--r-accent)}
.rtts-chip.is-extended{animation:rtts-extended .6s ease-out}
@keyframes rtts-extended{0%{background:var(--r-hover);transform:scale(1.06)}100%{background:none;transform:none}}
@media (prefers-reduced-motion:reduce){.rtts-chip.is-extended{animation:none}}
.rtts-rate button:hover,.rtts-chip:hover{background:var(--r-hover)}
.rtts-menu{position:absolute;bottom:calc(100% + 6px);z-index:5;display:flex;flex-direction:column;min-width:150px;max-height:min(60vh,360px);overflow:auto;padding:4px;border:1px solid var(--r-border);border-radius:12px;background:var(--r-bg,var(--r-bar));box-shadow:var(--r-shadow,0 6px 24px rgba(0,0,0,.25));transform:translateX(-50%)}
.rtts-menu[hidden]{display:none}
.rtts-menu button{padding:10px 14px;border:none;border-radius:8px;background:none;color:var(--r-fg);font:inherit;font-size:14px;text-align:left;cursor:pointer;white-space:nowrap}
.rtts-menu button:hover{background:var(--r-hover)}
.rtts-menu button.is-active{color:var(--r-accent);font-weight:600}
.rtts-voice-row{display:flex;gap:8px;align-items:center}
.rtts-voice-row .rs-select{flex:1 1 auto;min-width:0}
.rtts-preview{flex:none;min-height:36px;padding:6px 12px;border:1px solid var(--r-border);border-radius:8px;background:none;color:var(--r-fg);font:inherit;font-size:13px;cursor:pointer}
.rtts-colors{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:4px 0 6px}
.rtts-swatch{width:30px;height:30px;padding:0;border:2px solid transparent;border-radius:50%;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.18)}
.rtts-swatch.is-active{border-color:var(--r-fg)}
.rtts-set .rs-seg{margin-bottom:6px}
.rtts-set .rs-sublabel{margin-top:10px}
html[data-eink="1"] .rtts-menu{box-shadow:none;border:2px solid #000;background:#fff}
html[data-eink="1"] .reader-tts-dock .reader-tts-dock-btn.rtts-main{background:none;box-shadow:inset 0 0 0 2px currentColor}
html[data-eink="1"] .rtts-chip.is-on{border-width:2px;color:inherit;border-color:currentColor}
`;

/**
 * @param {object} host
 * @param {() => any} host.getView                  foliate-view
 * @param {() => object} host.getSettings           reader settings object (may be replaced on reset)
 * @param {() => void} host.saveSettings
 * @param {(msg: string) => void} host.toast
 * @param {() => string} [host.locale]              'ru' | 'en'
 * @param {(state: {active: boolean, paused: boolean}) => void} [host.onStateChange]
 * @param {() => void} [host.onBeforeStart]         clear selection, show chrome …
 * @param {() => void} [host.onSpeechStart]         every utterance start (keep-alive)
 * @param {() => boolean} [host.canAdvance]         false while the platform cancels hidden speech
 * @param {() => Promise<void>} [host.ensureVoices]
 * @param {() => void} [host.openSettings]
 * @param {() => string} [host.getChapterLabel]
 * @param {() => Range|null} [host.getSelectionRange]
 * @param {() => void} [host.onReadFromSelection]   hide the selection menu before «Читать отсюда» starts
 * @param {() => void} [host.afterControl]          e.g. restart the chrome auto-hide timer
 * @param {(onMove: () => void, level: {threshold: number, spanMs: number}) => (() => void)} [host.watchMotion]  start a phone motion sensor and return its stop function (Android: native accelerometer, keeps working with the screen off; default: `devicemotion` while the page is visible)
 * @param {boolean} [host.nativePause]              pause/resume the engine (Android) instead of cancel + repeat
 * @param {string} [host.voiceHint]
 */
export function createReaderTts(host) {
  const S = () => host.getSettings();
  const lang = () => (host.locale?.() === 'en' ? 'en' : 'ru');
  const str = (key, vars) => {
    let s = STRINGS[lang()][key] ?? STRINGS.ru[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
  const synth = () => window.speechSynthesis || null;
  const view = () => host.getView?.() || null;
  const isEink = () => document.documentElement.dataset.eink === '1';

  let active = false;
  let paused = false;
  /** Invalidates utterance callbacks on skip / pause / stop. */
  let token = 0;
  /**
   * Blocks (paragraphs) of the current section, keyed by their offset from the block the reading
   * started in; Foliate's iterator is at `iterAt`. `pos` = { b, i } is the sentence being spoken
   * (or to speak next). `inflight` = utterances handed to the engine, at most the current one and
   * the next: the engine prepares the next sentence while this one plays, so there is no gap.
   */
  const blocks = new Map();
  let iterAt = 0;
  let startAt = -Infinity;
  let endAt = Infinity;
  let pos = null;
  let inflight = [];
  let advancing = false;
  let sentenceRange = null;
  let wordCache = null;
  let paraTimer = null;
  let liveTimer = null;
  let sleepMode = 0;
  let sleepDeadline = 0;
  let sleepTicker = null;
  let lastNotified = '';
  let menu = null;
  let motionOn = false;
  let motionStop = null;
  const watchedDocs = new WeakSet();

  const dockEl = document.getElementById('reader-tts-dock');
  const el = {};

  /* ----- speech ----- */

  function bookLang() {
    const v = view();
    const c = v?.renderer?.getContents?.()?.[0];
    let raw = c?.doc?.documentElement?.lang || v?.language?.canonical || v?.book?.metadata?.language || '';
    if (Array.isArray(raw)) raw = raw[0] || '';
    const code = String(raw).trim().replace(/_/g, '-');
    if (!code) return lang() === 'en' ? 'en-US' : 'ru-RU';
    if (code.length === 2) return code === 'en' ? 'en-US' : code === 'ru' ? 'ru-RU' : code;
    return code;
  }

  function voices() {
    try { return synth()?.getVoices?.() || []; } catch { return []; }
  }

  /**
   * Only an explicitly chosen voice. «Авто» sends just `lang`: the browser / the Android
   * engine then uses its own default voice for the book language.
   */
  function pickVoice() {
    const uri = String(S().ttsVoice || '').trim();
    if (!uri) return null;
    return voices().find((x) => x.voiceURI === uri || x.name === uri) || null;
  }

  function applyUtterance(u) {
    const s = S();
    u.rate = clampTtsRate(s.ttsRate);
    u.pitch = clampTtsPitch(s.ttsPitch);
    u.lang = bookLang();
    u.volume = sleepDeadline ? sleepFadeVolume(sleepDeadline - Date.now()) : 1;
    const v = pickVoice();
    if (v) {
      u.voice = v;
      if (v.lang) u.lang = v.lang;
    }
  }

  function ensureVoices() {
    if (typeof host.ensureVoices === 'function') return host.ensureVoices().catch(() => {});
    return new Promise((resolve) => {
      const s = synth();
      if (!s || voices().length) { resolve(); return; }
      try { s.addEventListener?.('voiceschanged', () => resolve(), { once: true }); } catch { /* */ }
      setTimeout(resolve, 600);
    });
  }

  function cancelSpeech() {
    try { synth()?.cancel(); } catch { /* */ }
  }

  function segmentsFromSsml(ssml) {
    const skipNoteRefs = S().ttsSkipNoteRefs !== false;
    return parseTtsSsmlSegments(ssml)
      .map((p) => ({ mark: p.mark, text: cleanTtsText(p.text, { skipNoteRefs }) }))
      .filter((p) => p.text && /[\p{L}\p{N}]/u.test(p.text));
  }

  function resetBlocks(firstSsml) {
    blocks.clear();
    blocks.set(0, segmentsFromSsml(firstSsml));
    iterAt = 0;
    startAt = -Infinity;
    endAt = Infinity;
    pos = null;
    inflight = [];
  }

  /** Sentences of block `b`, walking Foliate's iterator there; null outside the section. */
  function fetchBlock(b) {
    if (blocks.has(b)) return blocks.get(b);
    if (b >= endAt || b <= startAt) return null;
    const t = view()?.tts;
    if (!t) return null;
    while (iterAt !== b) {
      const dir = b > iterAt ? 1 : -1;
      let ssml = null;
      try { ssml = dir > 0 ? t.next() : t.prev(); } catch (e) { console.warn('[reader TTS]', e); }
      if (!ssml) {
        if (dir > 0) endAt = iterAt + 1;
        else startAt = iterAt - 1;
        return null;
      }
      iterAt += dir;
      if (!blocks.has(iterAt)) blocks.set(iterAt, segmentsFromSsml(ssml));
    }
    return blocks.get(b) ?? null;
  }

  function segAt(p) {
    return p ? fetchBlock(p.b)?.[p.i] || null : null;
  }

  /** First sentence at or after block `b` (skips empty blocks); null at the section end. */
  function firstPosFrom(b) {
    for (let guard = 0; guard < 1000; guard++, b++) {
      const segs = fetchBlock(b);
      if (!segs) return null;
      if (segs.length) return { b, i: 0 };
    }
    return null;
  }

  function nextPos(p) {
    const segs = fetchBlock(p.b);
    if (segs && p.i + 1 < segs.length) return { b: p.b, i: p.i + 1 };
    return firstPosFrom(p.b + 1);
  }

  function prevPos(p) {
    if (p.i > 0) return { b: p.b, i: p.i - 1 };
    for (let b = p.b - 1, guard = 0; guard < 1000; guard++, b--) {
      const segs = fetchBlock(b);
      if (!segs) return null;
      if (segs.length) return { b, i: segs.length - 1 };
    }
    return null;
  }

  function paraPauseMs() {
    return PARA_PAUSE_MS[S().ttsParaPause] || 0;
  }

  function speakLater(delay = 30) {
    const tk = token;
    setTimeout(() => { if (tk === token) speakStep(); }, delay);
  }

  function interrupt() {
    token++;
    clearTimeout(paraTimer);
    paraTimer = null;
    inflight = [];
    cancelSpeech();
  }

  function markSegment(seg) {
    if (seg?.mark == null) return;
    try { view()?.tts?.setMark(String(seg.mark)); } catch (e) { console.warn('[reader TTS]', e); }
  }

  /** (Re)start speaking at `pos`, with an empty engine queue. */
  function speakStep() {
    clearTimeout(paraTimer);
    paraTimer = null;
    if (!active || paused) return;
    if (!view()?.tts) { stop(); return; }
    if (sleepDeadline && Date.now() >= sleepDeadline) { fireSleep(); return; }
    if (!segAt(pos)) {
      pos = pos ? nextPos(pos) : firstPosFrom(0);
      if (!pos) { void finishSection(); return; }
    }
    inflight = [];
    markSegment(segAt(pos));
    renderTitle();
    if (enqueue(pos)) fillAhead();
  }

  /** Queue the sentence after the last queued one, unless a paragraph pause must come first. */
  function fillAhead() {
    while (inflight.length && inflight.length < 2) {
      const last = inflight[inflight.length - 1];
      const np = nextPos(last.pos);
      if (!np) return;
      if (np.b !== last.pos.b && paraPauseMs()) return;
      if (!enqueue(np)) return;
    }
  }

  function enqueue(p) {
    const seg = segAt(p);
    const s = synth();
    const U = window.SpeechSynthesisUtterance;
    if (!seg || !s || !U) { stop(); return false; }
    const u = new U(seg.text);
    applyUtterance(u);
    const tk = token;
    const item = { u, pos: p, seg };
    u.onstart = () => {
      if (tk !== token || !active) return;
      if (host.canAdvance && !host.canAdvance()) return;
      if (pos?.b !== p.b || pos?.i !== p.i) {
        pos = p;
        markSegment(seg);
        renderTitle();
      }
      host.onSpeechStart?.();
    };
    u.onboundary = (e) => {
      if (tk !== token || !active || paused) return;
      if (e?.name && e.name !== 'word') return;
      if (pos?.b !== p.b || pos?.i !== p.i) return;
      showWord(seg, Number(e?.charIndex) || 0, Number(e?.charLength) || 0);
    };
    u.onend = () => onItemDone(item, tk);
    u.onerror = () => onItemDone(item, tk);
    inflight.push(item);
    try {
      s.speak(u);
    } catch (e) {
      console.warn('[reader TTS]', e);
      host.toast?.(str('unavailable'));
      stop();
      return false;
    }
    return true;
  }

  function onItemDone(item, tk) {
    if (!active || tk !== token) return;
    // Hidden page: the platform drops speech without playing it — kick() repeats `pos` later.
    if (host.canAdvance && !host.canAdvance()) return;
    const at = inflight.indexOf(item);
    if (at < 0) return;
    inflight.splice(0, at + 1);
    const np = inflight[0]?.pos || nextPos(item.pos);
    if (!np) { inflight = []; void finishSection(); return; }
    pos = np;
    if (sleepDeadline && Date.now() >= sleepDeadline) { fireSleep(); return; }
    if (inflight.length) {
      // Already in the engine and starting now; onstart may come late on some engines.
      markSegment(inflight[0].seg);
      renderTitle();
      fillAhead();
      return;
    }
    const ms = paraPauseMs();
    if (np.b !== item.pos.b && ms && document.visibilityState === 'visible') {
      markSegment(segAt(np));
      paraTimer = setTimeout(() => {
        paraTimer = null;
        if (tk === token && active && !paused) speakStep();
      }, ms);
      return;
    }
    speakStep();
  }

  function waitForLoad(v, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(tid);
        v.removeEventListener('load', finish);
        resolve();
      };
      const tid = setTimeout(finish, ms);
      v.addEventListener('load', finish);
    });
  }

  /** End of the section: open the next one and continue there. */
  async function advanceSection() {
    for (let depth = 0; depth < 15; depth++) {
      const v = view();
      if (!active || !v) return false;
      const before = v.renderer?.getContents?.()?.[0]?.index;
      advancing = true;
      try {
        const loaded = waitForLoad(v, 1500);
        if (typeof v.renderer?.nextSection === 'function') await v.renderer.nextSection();
        else await v.goRight();
        await loaded;
      } catch (e) {
        console.warn('[reader TTS]', e);
        advancing = false;
        return false;
      }
      advancing = false;
      if (!active) return false;
      const c = v.renderer?.getContents?.()?.[0];
      if (!c?.doc?.body || c.index === before) return false;
      try {
        await v.initTTS('sentence', true);
      } catch (e) {
        console.warn('[reader TTS]', e);
        continue;
      }
      if (!v.tts) return false;
      installHighlighter(v);
      let first = null;
      try { first = v.tts.start(); } catch (e) { console.warn('[reader TTS]', e); }
      if (!first) continue;
      resetBlocks(first);
      pos = firstPosFrom(0);
      if (!pos) continue;
      return true;
    }
    return false;
  }

  async function finishSection() {
    const tk = token;
    const ok = await advanceSection();
    if (tk !== token || !active) return;
    if (!ok) {
      stop();
      host.toast?.(str('bookEnd'));
      return;
    }
    if (sleepMode === 'chapter') { fireSleep(); return; }
    speakStep();
  }

  /* ----- highlight ----- */

  function overlayerFor(range) {
    const v = view();
    const doc = range?.startContainer?.ownerDocument;
    const contents = v?.renderer?.getContents?.() || [];
    return (contents.find((c) => c.doc === doc) || contents[0])?.overlayer || null;
  }

  function hlColor() {
    if (isEink()) return '#000';
    return TTS_HL_COLORS[S().ttsHlColor] || TTS_HL_COLORS.yellow;
  }

  function clearOverlays() {
    const contents = view()?.renderer?.getContents?.() || [];
    for (const c of contents) {
      try {
        c?.overlayer?.remove(KEY_WORD);
        c?.overlayer?.remove(KEY_SENTENCE);
      } catch { /* */ }
    }
  }

  function drawSentence(range) {
    const ov = overlayerFor(range);
    if (!ov) return;
    const s = S();
    try {
      ov.remove(KEY_WORD);
      ov.remove(KEY_SENTENCE);
      if (s.ttsHighlight === 'off') return;
      const underline = s.ttsHlStyle === 'underline';
      ov.add(KEY_SENTENCE, range.cloneRange(), underline ? drawUnderline : drawFill, {
        color: hlColor(),
        opacity: isEink() ? 0.14 : s.ttsHighlight === 'word' ? 0.22 : 0.32,
      });
    } catch (e) { console.warn('[reader TTS]', e); }
  }

  function showSentence(range) {
    if (!range) return;
    sentenceRange = range.cloneRange();
    wordCache = null;
    if (S().ttsFollow !== false) {
      try { void view()?.renderer?.scrollToAnchor?.(range, false); } catch { /* */ }
    }
    drawSentence(sentenceRange);
  }

  /** Foliate calls `tts.highlight(range)` from setMark; ours draws on the overlayer with the user's style. */
  function installHighlighter(v) {
    const t = v?.tts;
    if (!t || t.__readerTts) return;
    t.__readerTts = true;
    t.highlight = (range) => showSentence(range);
    t.clearHighlight = () => clearOverlays();
  }

  function buildWordCache(seg, range) {
    try {
      const doc = range.startContainer.ownerDocument;
      const root = range.commonAncestorContainer.nodeType === 3
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      const offs = [];
      let src = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!range.intersectsNode(n)) continue;
        const s = n === range.startContainer ? range.startOffset : 0;
        const e = n === range.endContainer ? range.endOffset : n.length;
        for (let i = s; i < e; i++) {
          nodes.push(n);
          offs.push(i);
        }
        src += n.data.slice(s, e);
      }
      if (!src) return null;
      return { seg, doc, nodes, offs, map: alignSpokenText(seg.text, src) };
    } catch {
      return null;
    }
  }

  function showWord(seg, charIndex, charLength) {
    if (S().ttsHighlight !== 'word' || !sentenceRange || !seg) return;
    if (!wordCache || wordCache.seg !== seg) wordCache = buildWordCache(seg, sentenceRange);
    const c = wordCache;
    if (!c) return;
    const len = charLength > 0 ? charLength : wordLengthAt(seg.text, charIndex);
    let a = -1;
    let b = -1;
    for (let i = charIndex; i < Math.min(seg.text.length, charIndex + len); i++) {
      const k = c.map[i];
      if (k < 0) continue;
      if (a < 0) a = k;
      b = k;
    }
    if (a < 0) return;
    try {
      const r = c.doc.createRange();
      r.setStart(c.nodes[a], c.offs[a]);
      r.setEnd(c.nodes[b], c.offs[b] + 1);
      const ov = overlayerFor(r);
      ov?.remove(KEY_WORD);
      ov?.add(KEY_WORD, r, drawFill, { color: hlColor(), opacity: isEink() ? 0.35 : 0.5 });
    } catch { /* */ }
  }

  /* ----- transport ----- */

  async function start(opts = {}) {
    const v = view();
    if (!v || v.isFixedLayout) { host.toast?.(str('fixedLayout')); return false; }
    if (!synth() || !window.SpeechSynthesisUtterance) { host.toast?.(str('unavailable')); return false; }
    const doc = v.renderer?.getContents?.()?.[0]?.doc;
    if (!doc?.body) { host.toast?.(str('noText')); return false; }
    stop();
    await ensureVoices();
    try {
      await v.initTTS('sentence', true);
    } catch (e) {
      console.warn('[reader TTS]', e);
    }
    if (!v.tts) { host.toast?.(str('noText')); return false; }
    installHighlighter(v);
    if (!v.__readerTtsActivity) {
      v.__readerTtsActivity = true;
      v.addEventListener('load', (e) => watchDocActivity(e.detail?.doc));
    }
    for (const c of v.renderer?.getContents?.() || []) watchDocActivity(c.doc);
    let first = null;
    const from = opts.range?.cloneRange ? opts.range.cloneRange()
      : v.lastLocation?.range?.cloneRange ? v.lastLocation.range.cloneRange() : null;
    try {
      first = from ? v.tts.from(from) : v.tts.start();
    } catch (e) {
      console.warn('[reader TTS]', e);
    }
    if (!first) {
      try { first = v.tts.start(); } catch (e) { console.warn('[reader TTS]', e); }
    }
    if (!first) { host.toast?.(str('noText')); return false; }
    resetBlocks(first);
    pos = firstPosFrom(0);
    if (!pos) { host.toast?.(str('noText')); return false; }
    active = true;
    paused = false;
    host.onBeforeStart?.();
    render();
    speakStep();
    return true;
  }

  function stop() {
    interrupt();
    clearTimeout(liveTimer);
    try { view()?.tts?.clearHighlight?.(); } catch { /* */ }
    clearOverlays();
    active = false;
    paused = false;
    blocks.clear();
    pos = null;
    advancing = false;
    sentenceRange = null;
    wordCache = null;
    if (sleepMode) setSleep(0);
    closeMenu();
    render();
  }

  function pause({ external = false } = {}) {
    if (!active || paused) return;
    paused = true;
    clearTimeout(paraTimer);
    paraTimer = null;
    if (!external) {
      const s = synth();
      // Native pause keeps the whole engine queue (and the notification); resume plays it on.
      if (host.nativePause && s?.speaking) {
        try { s.pause(); } catch { interrupt(); }
      } else {
        interrupt();
      }
    }
    render();
  }

  function resume({ external = false } = {}) {
    if (!active) { void start(); return; }
    if (!paused) return;
    paused = false;
    if (sleepDeadline && Date.now() >= sleepDeadline) setSleep(0);
    render();
    const s = synth();
    if (host.nativePause && s?.speaking) {
      if (!external) {
        try { s.resume(); } catch { interrupt(); speakLater(); }
      }
      return;
    }
    interrupt();
    speakLater();
  }

  function toggle() {
    if (!active) void start();
    else if (paused) resume();
    else pause();
  }

  /** After the platform dropped a phrase in the background: repeat it, never skip. */
  function kick() {
    if (!active || paused || paraTimer) return;
    const s = synth();
    if (s?.speaking || s?.pending) return;
    speakLater(0);
  }

  function afterMove() {
    if (paused) {
      markSegment(segAt(pos));
      render();
    } else {
      speakLater();
    }
  }

  function nextSentence() {
    if (!active || !pos) return;
    interrupt();
    const np = nextPos(pos);
    if (!np) {
      if (!paused) void finishSection();
      return;
    }
    pos = np;
    afterMove();
  }

  function prevSentence() {
    if (!active || !pos) return;
    interrupt();
    const pp = prevPos(pos);
    if (pp) pos = pp;
    else host.toast?.(str('noPrev'));
    afterMove();
  }

  function nextParagraph() {
    if (!active || !pos) return;
    interrupt();
    const np = firstPosFrom(pos.b + 1);
    if (!np) {
      if (!paused) void finishSection();
      return;
    }
    pos = np;
    afterMove();
  }

  /** Back to the start of this paragraph; from its first sentence — to the previous one. */
  function prevParagraph() {
    if (!active || !pos) return;
    interrupt();
    if (pos.i > 0) {
      pos = { b: pos.b, i: 0 };
    } else {
      const pp = prevPos(pos);
      if (pp) pos = { b: pp.b, i: 0 };
      else host.toast?.(str('noPrev'));
    }
    afterMove();
  }

  function locate() {
    if (!sentenceRange) return;
    try { void view()?.renderer?.scrollToAnchor?.(sentenceRange, false); } catch { /* */ }
  }

  function applyLive() {
    if (!active || paused) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      if (!active || paused) return;
      interrupt();
      speakLater();
    }, 350);
  }

  /* ----- sleep timer ----- */

  function setSleep(mode) {
    sleepMode = mode || 0;
    sleepDeadline = typeof sleepMode === 'number' && sleepMode > 0 ? Date.now() + sleepMode * 60000 : 0;
    clearInterval(sleepTicker);
    sleepTicker = sleepDeadline ? setInterval(renderSleep, 1000) : null;
    renderSleep();
    syncMotionWatch();
  }

  function fireSleep() {
    setSleep(0);
    pause();
    host.toast?.(str('sleepDone'));
  }

  /** Movement or a touch: the listener is awake — start the countdown over (and undo the fade). */
  function extendSleep() {
    if (!sleepDeadline || typeof sleepMode !== 'number' || S().ttsSleepMotion === false) return;
    const full = sleepMode * 60000;
    const left = sleepDeadline - Date.now();
    if (left > full - 2000) return;
    const wasFading = left < SLEEP_FADE_MS;
    sleepDeadline = Date.now() + full;
    renderSleep();
    if (el.sleep) {
      el.sleep.classList.remove('is-extended');
      void el.sleep.offsetWidth;
      el.sleep.classList.add('is-extended');
    }
    // Back to full volume now, not after the faded sentence ends.
    if (wasFading && active && !paused) { interrupt(); speakLater(); }
  }

  function motionLevel() {
    return TTS_MOTION_LEVELS[S().ttsSleepMotionLevel] || TTS_MOTION_LEVELS.medium;
  }

  function startDeviceMotion(onMove, level) {
    const moved = createMotionDetector(level);
    const handler = (e) => {
      const a = e.accelerationIncludingGravity;
      if (a && moved(a.x, a.y, a.z)) onMove();
    };
    window.addEventListener('devicemotion', handler);
    return () => window.removeEventListener('devicemotion', handler);
  }

  /** New sensitivity: restart a running sensor with it. */
  function restartMotionWatch() {
    if (!motionOn) return;
    try { motionStop?.(); } catch { /* */ }
    motionStop = null;
    motionOn = false;
    syncMotionWatch();
  }

  /** The motion sensor runs only while a minutes sleep timer is set and «продлевать» is on. */
  function syncMotionWatch() {
    const want = Boolean(active && sleepDeadline && S().ttsSleepMotion !== false);
    if (want === motionOn) return;
    motionOn = want;
    if (want) {
      try {
        const level = motionLevel();
        motionStop = typeof host.watchMotion === 'function'
          ? host.watchMotion(extendSleep, level)
          : startDeviceMotion(extendSleep, level);
      } catch (e) {
        console.warn('[reader TTS motion]', e);
        motionStop = null;
      }
    } else {
      try { motionStop?.(); } catch { /* */ }
      motionStop = null;
    }
  }

  function onUserActivity() {
    if (sleepDeadline) extendSleep();
  }

  /** Touches inside the book iframes do not reach the reader document: listen on each section doc too. */
  function watchDocActivity(doc) {
    if (!doc || watchedDocs.has(doc)) return;
    watchedDocs.add(doc);
    doc.addEventListener('pointerdown', onUserActivity, { capture: true, passive: true });
    doc.addEventListener('keydown', onUserActivity, { capture: true });
  }

  /* ----- UI ----- */

  function injectStyle() {
    if (document.getElementById('reader-tts-style')) return;
    const st = document.createElement('style');
    st.id = 'reader-tts-style';
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  function buildDock() {
    if (!dockEl) return;
    dockEl.setAttribute('aria-label', str('bar'));
    const btn = (name, icon, label, cls = '') =>
      `<button type="button" class="reader-tts-dock-btn tb-btn ${cls}" data-rtts="${name}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${icon}</button>`;
    dockEl.innerHTML = `<div class="reader-tts-dock-inner rtts">
  <div class="rtts-head">
    <span class="rtts-title" data-rtts-el="title"></span>
    ${btn('locate', svgIcon(ICONS.locate), str('locate'), 'rtts-small')}
    ${btn('settings', svgIcon(ICONS.settings), str('settings'), 'rtts-small')}
    ${btn('stop', svgIcon(ICONS.close), str('stop'), 'rtts-small')}
  </div>
  <div class="reader-tts-dock-row rtts-transport">
    ${btn('prevPara', svgIcon(ICONS.prevPara), str('prevPara'))}
    ${btn('prev', svgIcon(ICONS.prev), str('prev'))}
    ${btn('toggle', svgIcon(ICONS.play, 'tts-main-icon'), str('play'), 'rtts-main')}
    ${btn('next', svgIcon(ICONS.next), str('next'))}
    ${btn('nextPara', svgIcon(ICONS.nextPara), str('nextPara'))}
  </div>
  <div class="reader-tts-dock-row rtts-opts">
    <div class="rtts-rate" role="group" aria-label="${escapeAttr(str('rate'))}">
      <button type="button" data-rtts="slower" title="${escapeAttr(str('slower'))}" aria-label="${escapeAttr(str('slower'))}">−</button>
      <button type="button" class="rtts-rate-val" data-rtts="rateMenu" title="${escapeAttr(str('rateMenu'))}" aria-haspopup="menu"></button>
      <button type="button" data-rtts="faster" title="${escapeAttr(str('faster'))}" aria-label="${escapeAttr(str('faster'))}">+</button>
    </div>
    <button type="button" class="rtts-chip" data-rtts="sleep" title="${escapeAttr(str('sleep'))}" aria-haspopup="menu">${svgIcon(ICONS.sleep)}<span data-rtts-el="sleep"></span></button>
  </div>
  <div class="rtts-menu" role="menu" hidden></div>
</div>`;
    for (const node of dockEl.querySelectorAll('[data-rtts]')) el[node.dataset.rtts] = node;
    for (const node of dockEl.querySelectorAll('[data-rtts-el]')) el[`${node.dataset.rttsEl}Text`] = node;
    menu = dockEl.querySelector('.rtts-menu');
    const after = () => host.afterControl?.();
    el.prevPara.addEventListener('click', () => { prevParagraph(); after(); });
    el.prev.addEventListener('click', () => { prevSentence(); after(); });
    el.next.addEventListener('click', () => { nextSentence(); after(); });
    el.nextPara.addEventListener('click', () => { nextParagraph(); after(); });
    el.stop.addEventListener('click', () => { stop(); after(); });
    el.locate.addEventListener('click', () => { locate(); after(); });
    el.settings.addEventListener('click', () => openSettings());
    el.slower.addEventListener('click', () => setRate(clampTtsRate(S().ttsRate) - TTS_RATE_STEP));
    el.faster.addEventListener('click', () => setRate(clampTtsRate(S().ttsRate) + TTS_RATE_STEP));
    el.rateMenu.addEventListener('click', () => {
      const cur = clampTtsRate(S().ttsRate);
      openMenu(el.rateMenu, RATE_PRESETS.map((r) => ({ label: `${r.toFixed(2)}×`, active: Math.abs(r - cur) < 0.001, pick: () => setRate(r) })));
    });
    el.sleep.addEventListener('click', () => {
      openMenu(el.sleep, SLEEP_CHOICES.map((m) => ({
        label: m === 0 ? str('sleepOff') : m === 'chapter' ? str('sleepChapter') : str('sleepMin', { n: m }),
        active: sleepMode === m,
        pick: () => setSleep(m),
      })));
    });
    wirePrimary(el.toggle);
  }

  function openMenu(anchor, items) {
    if (!menu) return;
    if (!menu.hidden && menu.__anchor === anchor) { closeMenu(); return; }
    menu.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', it.active ? 'true' : 'false');
      b.className = it.active ? 'is-active' : '';
      b.textContent = it.label;
      b.addEventListener('click', () => { closeMenu(); it.pick(); host.afterControl?.(); });
      menu.appendChild(b);
    }
    const box = menu.parentElement.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    menu.style.left = `${a.left - box.left + a.width / 2}px`;
    menu.__anchor = anchor;
    menu.hidden = false;
    // Keep the popup on screen on narrow phones.
    const r = menu.getBoundingClientRect();
    const shift = r.left < 8 ? 8 - r.left : r.right > innerWidth - 8 ? innerWidth - 8 - r.right : 0;
    if (shift) menu.style.left = `${a.left - box.left + a.width / 2 + shift}px`;
    menu.querySelector('.is-active, button')?.focus?.();
  }

  function closeMenu() {
    if (menu && !menu.hidden) {
      menu.hidden = true;
      menu.__anchor = null;
    }
  }

  document.addEventListener('pointerdown', (e) => {
    if (!menu || menu.hidden) return;
    if (menu.contains(e.target) || menu.__anchor?.contains(e.target)) return;
    closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu && !menu.hidden) {
      e.stopPropagation();
      closeMenu();
    }
  }, true);

  /** Tap = play / pause; long press = stop (touch); Shift+click = stop. */
  function wirePrimary(btn) {
    if (!btn) return;
    let timer = null;
    let pt = null;
    let consumeClick = false;
    const clear = () => { clearTimeout(timer); timer = null; pt = null; };
    btn.addEventListener('pointerdown', (e) => {
      if (!active || e.shiftKey) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      clear();
      pt = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = null;
        pt = null;
        consumeClick = true;
        stop();
        host.afterControl?.();
      }, LONG_PRESS_MS);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!pt || timer == null) return;
      const dx = e.clientX - pt.x;
      const dy = e.clientY - pt.y;
      if (dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX) clear();
    });
    btn.addEventListener('pointerup', clear);
    btn.addEventListener('pointercancel', clear);
    btn.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clear(); });
    btn.addEventListener('contextmenu', (e) => { if (active) e.preventDefault(); });
    btn.addEventListener('click', (e) => {
      if (consumeClick) {
        consumeClick = false;
        e.preventDefault();
        return;
      }
      if (e.shiftKey && active) stop();
      else toggle();
      host.afterControl?.();
    });
  }

  function wireToolbar() {
    wirePrimary(document.getElementById('btn-tts'));
    document.querySelectorAll('.js-tts-stop').forEach((b) => b.addEventListener('click', () => { stop(); host.afterControl?.(); }));
    document.querySelectorAll('.js-tts-prev').forEach((b) => b.addEventListener('click', () => { prevSentence(); host.afterControl?.(); }));
    document.querySelectorAll('.js-tts-next').forEach((b) => b.addEventListener('click', () => { nextSentence(); host.afterControl?.(); }));
  }

  function wireSelectionMenu() {
    const m = document.getElementById('reader-sel-menu');
    if (!m || m.querySelector('#rsm-tts')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rsm-btn';
    b.id = 'rsm-tts';
    b.textContent = str('fromHere');
    b.title = str('fromHere');
    const before = m.querySelector('#rsm-copy') || m.querySelector('#rsm-remove');
    if (before) m.insertBefore(b, before);
    else m.appendChild(b);
    b.addEventListener('click', () => {
      const r = host.getSelectionRange?.();
      host.onReadFromSelection?.();
      void start(r ? { range: r } : {});
    });
  }

  function syncMainIcon(btn, playing) {
    const path = btn?.querySelector('.tts-main-path');
    if (path) path.setAttribute('d', playing ? ICONS.pause : ICONS.play);
  }

  function renderTitle() {
    if (!el.titleText) return;
    const label = String(host.getChapterLabel?.() || '').trim();
    if (el.titleText.textContent !== label) el.titleText.textContent = label;
  }

  function renderRate() {
    const r = clampTtsRate(S().ttsRate);
    if (el.rateMenu) el.rateMenu.textContent = `${r.toFixed(2)}×`;
    if (el.slower) el.slower.disabled = r <= TTS_RATE_MIN + 1e-9;
    if (el.faster) el.faster.disabled = r >= TTS_RATE_MAX - 1e-9;
  }

  function renderSleep() {
    if (sleepDeadline && Date.now() >= sleepDeadline + 1000 && active && !paused && !synth()?.speaking) {
      // Nothing is being spoken (e.g. a paragraph pause): do not wait for the next sentence.
      fireSleep();
      return;
    }
    if (!el.sleepText) return;
    let label = str('sleep');
    if (sleepMode === 'chapter') label = str('sleepChapterShort');
    else if (sleepDeadline) label = formatSleepLeft(sleepDeadline - Date.now());
    el.sleepText.textContent = label;
    el.sleep?.classList.toggle('is-on', Boolean(sleepMode));
  }

  function render() {
    const playing = active && !paused;
    const mainLabel = playing ? str('pause') : active ? str('resume') : str('play');
    const tb = document.getElementById('btn-tts');
    if (tb) {
      tb.classList.toggle('is-active', playing);
      tb.title = mainLabel;
      tb.setAttribute('aria-label', mainLabel);
      syncMainIcon(tb, playing);
    }
    document.querySelectorAll('.js-tts-prev, .js-tts-next').forEach((b) => { b.disabled = !active; });
    document.querySelectorAll('.js-tts-stop').forEach((b) => { b.hidden = !active; });
    if (dockEl) {
      dockEl.classList.toggle('is-visible', active);
      dockEl.classList.toggle('is-paused', active && paused);
      dockEl.setAttribute('aria-hidden', active ? 'false' : 'true');
    }
    if (el.toggle) {
      el.toggle.title = mainLabel;
      el.toggle.setAttribute('aria-label', mainLabel);
      el.toggle.classList.toggle('is-active', playing);
      syncMainIcon(el.toggle, playing);
    }
    renderTitle();
    renderRate();
    renderSleep();
    if (!active) closeMenu();
    document.body.classList.toggle('reader-tts-active', active);
    syncMotionWatch();
    const key = `${active}|${paused}`;
    if (key !== lastNotified) {
      lastNotified = key;
      try { host.onStateChange?.({ active, paused }); } catch (e) { console.warn('[reader TTS]', e); }
    }
  }

  /* ----- settings block ----- */

  function settingsMount() {
    let mount = document.getElementById('rs-tts-mount');
    if (mount) return mount;
    // Older reader markup: replace the rate/voice group in place.
    const legacy = document.getElementById('rs-tts-rate')?.closest('.rs-group');
    if (!legacy) return null;
    mount = document.createElement('div');
    mount.id = 'rs-tts-mount';
    legacy.replaceWith(mount);
    return mount;
  }

  function seg(key, options) {
    return `<div class="rs-seg" data-rtts-set="${key}">${options.map(([v, label]) =>
      `<button type="button" data-v="${escapeAttr(v)}">${escapeAttr(label)}</button>`).join('')}</div>`;
  }

  function mountSettings() {
    const mount = settingsMount();
    if (!mount) return;
    mount.classList.add('rtts-set');
    const colors = Object.keys(TTS_HL_COLORS).map((c) =>
      `<button type="button" class="rtts-swatch" data-rtts-color="${c}" style="background:${TTS_HL_COLORS[c]}" title="${escapeAttr(STRINGS[lang()].colors[c])}" aria-label="${escapeAttr(STRINGS[lang()].colors[c])}"></button>`).join('');
    mount.innerHTML = `
      <div class="rs-sublabel">${str('voice')}</div>
      <div class="rtts-voice-row">
        <select id="rs-tts-voice" name="readerTtsVoice" class="rs-select" aria-label="${escapeAttr(str('voice'))}"></select>
        <button type="button" class="rtts-preview" id="rs-tts-preview">${str('preview')}</button>
      </div>
      <div class="rs-sublabel">${str('rate')}</div>
      <div class="rs-slider">
        <input type="range" id="rs-tts-rate" name="readerTtsRate" min="${TTS_RATE_MIN}" max="${TTS_RATE_MAX}" step="0.05" aria-label="${escapeAttr(str('rate'))}">
        <span class="rs-val" id="rs-tts-rate-val">1.00</span>
      </div>
      <div class="rs-sublabel">${str('pitch')}</div>
      <div class="rs-slider">
        <input type="range" id="rs-tts-pitch" name="readerTtsPitch" min="${TTS_PITCH_MIN}" max="${TTS_PITCH_MAX}" step="0.05" aria-label="${escapeAttr(str('pitch'))}">
        <span class="rs-val" id="rs-tts-pitch-val">1.00</span>
      </div>
      <div class="rs-sublabel">${str('highlight')}</div>
      ${seg('ttsHighlight', [['off', str('hlOff')], ['sentence', str('hlSentence')], ['word', str('hlWord')]])}
      <div class="rs-sublabel">${str('hlColor')}</div>
      <div class="rtts-colors" role="group" aria-label="${escapeAttr(str('hlColor'))}">${colors}</div>
      ${seg('ttsHlStyle', [['fill', str('hlFill')], ['underline', str('hlUnderline')]])}
      <label class="rs-check"><span>${str('follow')}</span><input type="checkbox" id="rs-tts-follow" name="readerTtsFollow"></label>
      <label class="rs-check"><span>${str('skipNotes')}</span><input type="checkbox" id="rs-tts-skip-notes" name="readerTtsSkipNotes"></label>
      <label class="rs-check"><span>${str('sleepMotion')}</span><input type="checkbox" id="rs-tts-sleep-motion" name="readerTtsSleepMotion"></label>
      <div class="rs-sublabel">${str('sleepMotionLevel')}</div>
      ${seg('ttsSleepMotionLevel', [['high', str('motionHigh')], ['medium', str('motionMedium')], ['low', str('motionLow')]])}
      <div class="rs-hint">${str('sleepMotionHint')}</div>
      <div class="rs-sublabel">${str('paraPause')}</div>
      ${seg('ttsParaPause', [['0', str('pauseNone')], ['1', str('pauseShort')], ['2', str('pauseLong')]])}
      <div class="rs-hint">${str('wordHint')}${host.voiceHint ? ` ${escapeAttr(host.voiceHint)}` : ''}</div>`;

    const q = (id) => document.getElementById(id);
    q('rs-tts-voice')?.addEventListener('change', (e) => {
      S().ttsVoice = e.target.value || '';
      host.saveSettings();
      applyLive();
    });
    q('rs-tts-preview')?.addEventListener('click', preview);
    q('rs-tts-rate')?.addEventListener('input', (e) => setRate(Number(e.target.value), { fromSlider: true }));
    q('rs-tts-pitch')?.addEventListener('input', (e) => {
      S().ttsPitch = clampTtsPitch(e.target.value);
      const val = q('rs-tts-pitch-val');
      if (val) val.textContent = S().ttsPitch.toFixed(2);
      host.saveSettings();
      applyLive();
    });
    for (const box of mount.querySelectorAll('[data-rtts-set]')) {
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]');
        if (!b) return;
        const key = box.dataset.rttsSet;
        S()[key] = key === 'ttsParaPause' ? Number(b.dataset.v) : b.dataset.v;
        host.saveSettings();
        refreshSettingsUi();
        if (key === 'ttsSleepMotionLevel') restartMotionWatch();
        else if (key !== 'ttsParaPause' && sentenceRange) drawSentence(sentenceRange);
      });
    }
    mount.querySelector('.rtts-colors')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rtts-color]');
      if (!b) return;
      S().ttsHlColor = b.dataset.rttsColor;
      host.saveSettings();
      refreshSettingsUi();
      if (sentenceRange) drawSentence(sentenceRange);
    });
    q('rs-tts-follow')?.addEventListener('change', (e) => {
      S().ttsFollow = e.target.checked;
      host.saveSettings();
      if (S().ttsFollow) locate();
    });
    q('rs-tts-sleep-motion')?.addEventListener('change', (e) => {
      S().ttsSleepMotion = e.target.checked;
      host.saveSettings();
      syncMotionWatch();
    });
    q('rs-tts-skip-notes')?.addEventListener('change', (e) => {
      S().ttsSkipNoteRefs = e.target.checked;
      host.saveSettings();
    });
    try {
      synth()?.addEventListener?.('voiceschanged', () => populateVoices());
    } catch { /* */ }
    // The Android bridge installs its synth later and announces voices on window.
    window.addEventListener('voiceschanged', () => populateVoices());
    populateVoices();
    refreshSettingsUi();
  }

  function populateVoices() {
    const sel = document.getElementById('rs-tts-voice');
    if (!sel) return;
    const list = voices().slice();
    const base = bookLang().toLowerCase().split(/[-_]/)[0];
    const isBook = (v) => String(v.lang || '').toLowerCase().split(/[-_]/)[0] === base;
    const byName = (a, b) => {
      if ((a.localService !== false) !== (b.localService !== false)) return a.localService !== false ? -1 : 1;
      return String(a.lang || '').localeCompare(String(b.lang || '')) || String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    };
    const opts = { network: str('voiceNetwork'), isDefault: str('voiceDefaultMark') };
    const keep = S().ttsVoice || '';
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = str('voiceAuto');
    sel.appendChild(auto);
    const groups = [[str('voiceBookLang'), list.filter(isBook).sort(byName)], [str('voiceOther'), list.filter((v) => !isBook(v)).sort(byName)]];
    for (const [label, items] of groups) {
      if (!items.length) continue;
      const g = document.createElement('optgroup');
      g.label = label;
      for (const v of items) {
        const o = document.createElement('option');
        o.value = v.voiceURI || v.name;
        const name = prettyVoiceName(v, opts);
        o.textContent = label === str('voiceOther') && v.lang && !name.toLowerCase().includes(String(v.lang).toLowerCase()) ? `${name} — ${v.lang}` : name;
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
    sel.value = keep && [...sel.options].some((o) => o.value === keep) ? keep : '';
  }

  function refreshSettingsUi() {
    const s = S();
    const q = (id) => document.getElementById(id);
    const rate = clampTtsRate(s.ttsRate);
    if (q('rs-tts-rate')) q('rs-tts-rate').value = String(rate);
    if (q('rs-tts-rate-val')) q('rs-tts-rate-val').textContent = rate.toFixed(2);
    const pitch = clampTtsPitch(s.ttsPitch);
    if (q('rs-tts-pitch')) q('rs-tts-pitch').value = String(pitch);
    if (q('rs-tts-pitch-val')) q('rs-tts-pitch-val').textContent = pitch.toFixed(2);
    const sel = q('rs-tts-voice');
    if (sel) sel.value = s.ttsVoice && [...sel.options].some((o) => o.value === s.ttsVoice) ? s.ttsVoice : '';
    document.querySelectorAll('[data-rtts-set]').forEach((box) => {
      const cur = String(s[box.dataset.rttsSet]);
      box.querySelectorAll('button[data-v]').forEach((b) => b.classList.toggle('is-active', b.dataset.v === cur));
    });
    document.querySelectorAll('[data-rtts-color]').forEach((b) => {
      const on = b.dataset.rttsColor === s.ttsHlColor;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (q('rs-tts-follow')) q('rs-tts-follow').checked = s.ttsFollow !== false;
    if (q('rs-tts-skip-notes')) q('rs-tts-skip-notes').checked = s.ttsSkipNoteRefs !== false;
    if (q('rs-tts-sleep-motion')) q('rs-tts-sleep-motion').checked = s.ttsSleepMotion !== false;
    renderRate();
  }

  function setRate(next, { fromSlider = false } = {}) {
    const r = clampTtsRate(next);
    S().ttsRate = r;
    const val = document.getElementById('rs-tts-rate-val');
    if (val) val.textContent = r.toFixed(2);
    if (!fromSlider) {
      const slider = document.getElementById('rs-tts-rate');
      if (slider) slider.value = String(r);
    }
    renderRate();
    host.saveSettings();
    applyLive();
  }

  function preview() {
    if (active) return;
    const s = synth();
    const U = window.SpeechSynthesisUtterance;
    if (!s || !U) { host.toast?.(str('unavailable')); return; }
    cancelSpeech();
    const v = pickVoice();
    const vBase = String(v?.lang || bookLang()).toLowerCase().split(/[-_]/)[0];
    const u = new U(vBase === 'en' ? STRINGS.en.previewText : vBase === 'ru' ? STRINGS.ru.previewText : str('previewText'));
    applyUtterance(u);
    try { s.speak(u); } catch (e) { console.warn('[reader TTS]', e); }
  }

  function openSettings() {
    closeMenu();
    host.openSettings?.();
    const mount = document.getElementById('rs-tts-mount');
    if (!mount) return;
    // Android settings are split into panes: switch to the one holding the TTS block.
    const pane = mount.closest('[data-rs-pane].rs-pane');
    if (pane?.hidden) document.querySelector(`.rs-nav-btn[data-rs-pane="${pane.dataset.rsPane}"]`)?.click();
    requestAnimationFrame(() => {
      const target = mount.closest('.rs-section') || mount.closest('.rs-group') || mount;
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    });
  }

  function onSettingsOpen() {
    void ensureVoices().then(() => { populateVoices(); refreshSettingsUi(); });
  }

  document.addEventListener('pointerdown', onUserActivity, { capture: true, passive: true });
  document.addEventListener('keydown', onUserActivity, { capture: true });

  injectStyle();
  buildDock();
  wireToolbar();
  mountSettings();
  wireSelectionMenu();
  render();

  return {
    start,
    stop,
    toggle,
    pause,
    resume,
    kick,
    prevSentence,
    nextSentence,
    prevParagraph,
    nextParagraph,
    locate,
    setSleep,
    refreshSettingsUi,
    populateVoices,
    onSettingsOpen,
    isActive: () => active,
    isPaused: () => paused,
    isAdvancingSection: () => advancing,
  };
}
