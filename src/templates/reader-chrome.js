/**
 * Reader chrome pieces shared by the web reader (renderReader) and the Android app
 * (inpx-book-reader scripts/generate-reader-html.mjs evaluates renderReader with these).
 * No imports on purpose: the app build must load it without the server (DB, config).
 */

const esc = (value = '') => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const READER_ICON_PATHS = {
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>',
  toc: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  bookmarks: '<path d="M17 19l-5-4-5 4V5a2 2 0 012-2h6a2 2 0 012 2z"/><path d="M20 9v12l-3-2.4"/>',
  notes: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  moon: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  text: '<path d="M4 20l6-16 6 16M6.5 14h7"/><path d="M17 20v-6a2.5 2.5 0 015 0v6M17 17h5"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A4.7 4.7 0 0021 9.7C21 6 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15.5" cy="8.5" r="1"/>',
  page: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  status: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 16h18M7 18.5h3M15 18.5h2"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 013 0V12M11 11.5v-2a1.5 1.5 0 013 0V12M14 10.5a1.5 1.5 0 013 0V12M17 11.5a1.5 1.5 0 013 0V16a6 6 0 01-6 6h-2a6 6 0 01-5-2.7L4.3 15a1.5 1.5 0 012.5-1.7L8 15"/>',
  tts: '<path d="M3 14v-2a9 9 0 0118 0v2"/><path d="M21 15a2 2 0 01-2 2h-1v-6h1a2 2 0 012 2zM3 15a2 2 0 002 2h1v-6H5a2 2 0 00-2 2z"/>',
  eink: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6M9 10h6M9 14h4M11 18h2"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  pdf: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  reset: '<path d="M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8"/><path d="M3 3v5h5"/>',
};

export const READER_ICONS = Object.fromEntries(Object.entries(READER_ICON_PATHS)
  .map(([k, d]) => [k, `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`]));

export const READER_THEMES = ['light', 'sepia', 'dark', 'night', 'eink'];

/* Устройства с экраном E-Ink по User-Agent (браузеры Onyx, PocketBook, Kindle…): для «Режим E-Ink: авто». */
export const READER_EINK_UA_RE = /onyx|boox|pocketbook|kindle|kobo|tolino|bigme|meebook|likebook|inkbook|remarkable|supernote|boyue|hisense a[579]/i;

/* Плитка нижнего меню читалки (тап в центр). id сохраняет старые кнопки тулбара для reader.js. */
export function readerQuickTile(id, icon, label, title = '', extraAttrs = '') {
  const tip = esc(title || label);
  return `<button class="rq-tile" type="button"${id ? ` id="${id}"` : ''} ${extraAttrs} title="${tip}" aria-label="${tip}"><span class="rq-ico">${READER_ICONS[icon]}</span><span class="rq-label">${esc(label)}</span></button>`;
}

/* Строка корневого списка настроек: раздел + текущее значение (заполняет reader.js). */
export function readerSettingsRow(page, icon, label) {
  return `<button type="button" class="rs-root-row" data-rs-open="${page}"><span class="rs-root-ico" aria-hidden="true">${READER_ICONS[icon]}</span><span class="rs-root-label">${esc(label)}</span><span class="rs-root-val" data-rs-summary="${page}"></span><span class="rs-root-chev" aria-hidden="true">&rsaquo;</span></button>`;
}
