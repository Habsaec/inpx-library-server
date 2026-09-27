/**
 * Shared template helpers: layout, page shell, grids, sidebars, and small UI fragments.
 * Every exported symbol here is used by one or more sibling template modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { formatAuthorLabel, formatGenreLabel, formatLanguageLabel, parseGenreCodes } from '../genre-map.js';
import { getAvailableDownloadFormats, FORMAT_LABELS, isDownloadFormatEnabled } from '../conversion.js';
import { config } from '../config.js';
import { BATCH_ZIP_MAX } from '../constants.js';
import { bookPagePath, readPagePath, apiBookPath, downloadBookPath, liteBookPagePath, liteReadPagePath, encodeBookRef, bookIdNeedsSafeUrl } from '../utils/book-ref.js';
import { formatSingleAuthorName, splitAuthorValues } from '../inpx.js';
import {
  t,
  tp,
  getLocale,
  plural,
  countLabel,
  formatLocaleInt,
  formatLocaleDateShort,
  formatLocaleDateTimeShort,
  formatLocaleDateLong,
  serializeClientI18n
} from '../i18n.js';
import { resolveIndexStageLine } from '../index-stage-i18n.js';
import { getUiCustomization, getThemeCssVars, hasUiThemeColorsConfigured, usesPanelGlass, hasUiThemeShapeConfigured, hasUiThemeTypographyConfigured, FONT_FAMILY_WEBFONT, DISPLAY_FONT_WEBFONT } from '../services/ui-customization.js';
import { balanceHtmlFragment, stripFlibustaMediaPlaceholders } from '../html-sanitize.js';

export { t, tp, getLocale, plural, countLabel, formatLocaleInt, formatLocaleDateShort, formatLocaleDateTimeShort, formatLocaleDateLong, serializeClientI18n };
export { formatAuthorLabel, formatGenreLabel, formatLanguageLabel, parseGenreCodes };
export { getAvailableDownloadFormats, FORMAT_LABELS };
export { bookPagePath, readPagePath, apiBookPath, downloadBookPath, liteBookPagePath, liteReadPagePath };

/** data-* атрибут с ID книги (base64url), безопасен для NUL и спецсимволов в HTML. */
export function bookIdDataAttr(id) {
  return `data-book-id-ref="${escapeHtml(encodeBookRef(String(id ?? '')))}"`;
}

/** Атрибуты карточки книги: ref всегда; legacy data-book-id только для «безопасных» id. */
export function bookCardDataAttrs(id) {
  const s = String(id ?? '');
  const attrs = [bookIdDataAttr(s)];
  if (!bookIdNeedsSafeUrl(s)) attrs.push(`data-book-id="${escapeHtml(s)}"`);
  return attrs.join(' ');
}

/** batch-select checkbox: ref для id с управляющими символами. */
export function batchBookIdDataAttr(id) {
  const s = String(id ?? '');
  if (bookIdNeedsSafeUrl(s)) {
    return `data-batch-book-id-ref="${escapeHtml(encodeBookRef(s))}"`;
  }
  return `data-batch-book-id="${escapeHtml(s)}"`;
}

/** Единая кнопка «×» для строк личного кабинета (профиль, избранное, полки). */
export function renderListRemoveBtn({ extraAttrs = '', titleKey = 'profile.removeTitle' } = {}) {
  const label = t(titleKey);
  const attrs = extraAttrs ? ` ${extraAttrs}` : '';
  return `<button type="button" class="profile-remove-btn account-list-remove"${attrs} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">&times;</button>`;
}

const APP_MIN_PATH = path.join(config.publicDir, 'app.min.js');
const CSS_MIN_PATH = path.join(config.publicDir, 'styles.min.css');
const APP_SRC_PATH = path.join(config.publicDir, 'app.js');
const CSS_SRC_PATH = path.join(config.publicDir, 'styles.css');
const LITE_CSS_PATH = path.join(config.publicDir, 'lite.css');
const READER_JS_PATH = path.join(config.publicDir, 'reader.js');
const READER_CSS_PATH = path.join(config.publicDir, 'reader.css');
const TAP_ZONES_PATH = path.join(config.publicDir, 'tap-zones.js');
const POSITION_SYNC_PATH = path.join(config.publicDir, 'position-sync.js');
const READER_SHARED_DIR = path.join(config.publicDir, 'reader-shared');
const FOLIATE_DIR = path.join(config.publicDir, 'foliate');
const FOLIATE_PROGRESS_PATH = path.join(FOLIATE_DIR, 'progress.js');
const FOLIATE_VIEW_PATH = path.join(FOLIATE_DIR, 'view.js');
const FOLIATE_FB2_PATH = path.join(FOLIATE_DIR, 'fb2.js');

/**
 * Returns true only if the minified bundle is at least as new as its source.
 * Guards against a deployment where `public/app.js` was updated but someone
 * forgot to run `npm run build:assets` — otherwise the server would silently
 * serve stale minified JS/CSS and break home page "Continue reading" etc.
 */
function isMinifiedFresh(minPath, srcPath) {
  try {
    return fs.statSync(minPath).mtimeMs >= fs.statSync(srcPath).mtimeMs;
  } catch {
    return false;
  }
}

const _isProdEnv = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const _hasMinifiedFiles = fs.existsSync(APP_MIN_PATH) && fs.existsSync(CSS_MIN_PATH);
const _minifiedFresh =
  _hasMinifiedFiles &&
  isMinifiedFresh(APP_MIN_PATH, APP_SRC_PATH) &&
  isMinifiedFresh(CSS_MIN_PATH, CSS_SRC_PATH);

const USE_MINIFIED_ASSETS = _isProdEnv && _minifiedFresh;

if (_isProdEnv && _hasMinifiedFiles && !_minifiedFresh) {
  console.warn(
    '[assets] ВНИМАНИЕ: public/app.min.js или public/styles.min.css старше исходников.\n' +
    '          Сервер временно отдаёт НЕминифицированные версии, чтобы не сломать клиент.\n' +
    '          Пересоберите ассеты командой: npm run build:assets'
  );
} else if (_isProdEnv && !_hasMinifiedFiles) {
  console.warn(
    '[assets] ВНИМАНИЕ: public/app.min.js и/или public/styles.min.css отсутствуют.\n' +
    '          Сервер отдаёт НЕминифицированные версии. Запустите: npm run build:assets'
  );
}

const APP_ASSET_FILE = USE_MINIFIED_ASSETS ? 'app.min.js' : 'app.js';
const CSS_ASSET_FILE = USE_MINIFIED_ASSETS ? 'styles.min.css' : 'styles.css';

function listReaderSharedAssetPaths() {
  try {
    return fs.readdirSync(READER_SHARED_DIR)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => path.join(READER_SHARED_DIR, name));
  } catch {
    return [];
  }
}

function computeStaticAssetVersion() {
  const readerShared = listReaderSharedAssetPaths();
  const files = USE_MINIFIED_ASSETS
    ? [APP_MIN_PATH, CSS_MIN_PATH, LITE_CSS_PATH, READER_JS_PATH, READER_CSS_PATH, TAP_ZONES_PATH, POSITION_SYNC_PATH,
      ...readerShared, FOLIATE_PROGRESS_PATH, FOLIATE_VIEW_PATH, FOLIATE_FB2_PATH]
    : [APP_SRC_PATH, CSS_SRC_PATH, LITE_CSS_PATH, READER_JS_PATH, READER_CSS_PATH, TAP_ZONES_PATH, POSITION_SYNC_PATH,
      ...readerShared, FOLIATE_PROGRESS_PATH, FOLIATE_VIEW_PATH, FOLIATE_FB2_PATH];
  const hash = crypto.createHash('md5');
  for (const p of files) {
    try {
      hash.update(fs.readFileSync(p));
    } catch { /* ignore missing files */ }
  }
  return hash.digest('hex').slice(0, 8);
}

export const STATIC_ASSET_VERSION = computeStaticAssetVersion();

export const READ_CHECK_SVG = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

export function renderCover(book, { readBookIds = null } = {}) {
  const readBadge = readBookIds && readBookIds.has(book.id) ? `<span class="read-badge">${READ_CHECK_SVG}</span>` : '';
  const deletedBadge = Number(book.deleted)
    ? `<span class="deleted-badge" title="${escapeHtml(t('book.deletedHint'))}">${escapeHtml(t('book.deletedBadge'))}</span>`
    : '';
  /* Шкала рейтинга — 1..5; клампим на случай легаси-значений в БД (импорт из INPX или старый UI). */
  const _libRateClamped = Math.max(0, Math.min(5, Math.floor(Number(book.libRate) || 0)));
  const coverRating = _libRateClamped
    ? `<span class="cover-rating-wrapper"><span class="cover-rating-badge cover-rating-${_libRateClamped}">${Array.from({ length: _libRateClamped }, () => '<span>★</span>').join('')}</span></span>`
    : '';
  return `
    <a class="cover" href="${bookPagePath(book.id)}" data-role="cover">
      <span class="cover-fallback">
        <img class="cover-fallback-image" draggable="false" src="/book-fallback.png" alt="">
        <span class="cover-fallback-overlay"></span>
        <span class="cover-fallback-copy">
          <span class="cover-fallback-title">${escapeHtml(book.title)}</span>
          <span class="cover-fallback-author">${escapeHtml(formatAuthorLabel(book.authors) || t('book.authorUnknown'))}</span>
        </span>
      </span>
      <img class="cover-image" loading="lazy" draggable="false" src="${apiBookPath(book.id, 'cover-thumb')}" data-cover-src="${apiBookPath(book.id, 'cover-thumb')}" alt="${escapeHtml(book.title)}">
      ${readBadge}
      ${deletedBadge}
      ${coverRating}
      <div class="card-annotation-preview" hidden data-card-annotation></div>
    </a>`;
}

export function browseEntityPluralType(path) {
  if (path === '/authors') return 'author';
  if (path === '/series') return 'series';
  if (path === '/genres') return 'genre';
  if (path === '/languages') return 'language';
  return 'book';
}

/** Строка «Всего: N …» для списков авторов/серий/жанров/языков. */
export function browseTotalLine(path, total, query) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const num = formatLocaleInt(n);
  const ptype = browseEntityPluralType(path);
  const inner = `<strong>${num}</strong> ${plural(ptype, n)}`;
  const filterPart = query ? ` · ${t('browse.filter')}: <strong>${escapeHtml(query)}</strong>` : '';
  return `${t('browse.total')}: ${inner}${filterPart}`;
}

const _pkgDir = path.dirname(fileURLToPath(import.meta.url));
function getPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(_pkgDir, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    return String(pkg.version || '?');
  } catch {
    return '?';
  }
}

let _siteName = '';
export function setSiteName(name) { _siteName = String(name || '').trim(); }
export function getSiteName() { return _siteName; }

/** Заголовок сайта для UI: настройка или локализованный fallback. */
export function siteTitleForDisplay() {
  const n = String(_siteName || '').trim();
  return n || t('library.titleFallback');
}

/** Синхронизировать с getSetting('allow_anonymous_download') — влияет на меню «Скачать» и пакетный UI для гостей. */
let _allowAnonymousDownload = false;
export function setAllowAnonymousDownload(enabled) {
  _allowAnonymousDownload = Boolean(enabled);
}

export function canDownloadInUi(user) {
  return Boolean(user?.username) || _allowAnonymousDownload;
}

export function canSendToEmailInUi(user) {
  return Boolean(user?.username) && user.ereaderEmailAllowed !== false;
}

/** Удаляет символы, запрещённые в XML 1.0 (кроме tab/LF/CR). */
function stripXmlInvalidControls(value) {
  return String(value ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function escapeHtml(value = '') {
  return stripXmlInvalidControls(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_HTML_TAG_RE = /^(b|i|em|strong|p|br|span|div|ul|ol|li|h[1-6]|blockquote|sup|sub|a|img|table|thead|tbody|tr|td|th)$/i;

export function sanitizeHtml(html) {
  const cleaned = stripXmlInvalidControls(stripFlibustaMediaPlaceholders(html))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/javascript:/gi, 'blocked:')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/<(\/?)(\w+)([^>]*)>/g, (match, slash, tag, attrs) => {
      const lowerTag = tag.toLowerCase();
      if (!ALLOWED_HTML_TAG_RE.test(lowerTag)) return '';
      if (slash) return `</${lowerTag}>`;
      if (lowerTag === 'a') {
        const hrefMatch = attrs.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const href = (hrefMatch?.[1] || hrefMatch?.[2] || hrefMatch?.[3] || '').trim();
        if (!href || !/^(https?:\/\/|mailto:|tel:|#)/i.test(href)) return '';
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`;
      }
      if (lowerTag === 'img') {
        const srcMatch = attrs.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const src = (srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3] || '').trim();
        if (!src || !/^(https?:\/\/|data:image\/)/i.test(src)) return '';
        const altMatch = attrs.match(/\salt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const alt = escapeHtml(altMatch?.[1] || altMatch?.[2] || altMatch?.[3] || '');
        return `<img src="${escapeHtml(src)}" alt="${alt}">`;
      }
      return `<${lowerTag}>`;
    });
  return balanceHtmlFragment(stripFlibustaMediaPlaceholders(cleaned));
}

/** Фрагмент для HTML id/name (аудит DevTools: у полей формы должен быть id или name). */
export function safeDomIdPart(value = '') {
  const s = String(value).trim().replace(/\s+/g, '_');
  const t = s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return t || 'field';
}

export function batchSelectInputAttrs(bookId) {
  const safe = safeDomIdPart(bookId);
  return `id="batch-select-${safe}" name="batch-select-${safe}"`;
}

export function uniqueBooksById(items = []) {
  const seen = new Set();
  const result = [];
  for (const book of items) {
    const id = String(book?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(book);
  }
  return result;
}

export function csrfHiddenField(csrfToken = '') {
  return csrfToken ? `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">` : '';
}

const ALERT_ICONS = {
  success: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10.5l3 3 5.5-6.5"/><circle cx="10" cy="10" r="8.5"/></svg>',
  error: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><path d="M10 6.5v4"/><circle cx="10" cy="13.5" r="0.6" fill="currentColor" stroke="none"/></svg>',
  info: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><path d="M10 9v4.5"/><circle cx="10" cy="6.5" r="0.6" fill="currentColor" stroke="none"/></svg>'
};

export function renderAlert(type, content, { extraClass = '', attrs = '' } = {}) {
  const icon = ALERT_ICONS[type] || ALERT_ICONS.success;
  const cls = ['alert', type !== 'success' ? `alert-${type}` : '', extraClass].filter(Boolean).join(' ');
  return `<div class="${cls}"${attrs ? ' ' + attrs : ''}><span class="alert-icon">${icon}</span><span class="alert-content">${escapeHtml(content)}</span></div>`;
}

export function renderIndexStatus(indexStatus, stats) {
  if (!indexStatus) {
    return '';
  }

  if (indexStatus.active) {
    return renderAlert('info', t('index.active'), { attrs: 'data-index-status' });
  }

  if (indexStatus.error) {
    return renderAlert('error', t('index.error') + ' ' + indexStatus.error, { attrs: 'data-index-status' });
  }

  return '';
}

function renderAdminIndexStatus(indexStatus) {
  if (!indexStatus) return '';
  if (indexStatus.active) {
    return renderAlert('info', t('index.active'), { attrs: 'data-index-status' });
  }
  if (indexStatus.error) {
    return renderAlert('error', t('index.error') + ' ' + indexStatus.error, { attrs: 'data-index-status' });
  }
  return '';
}

function renderAdminIndexControls(indexStatus) {
  const phase = String(indexStatus?.phase || '');
  const active = Boolean(indexStatus?.active) || phase === 'maintenance';
  const paused = Boolean(indexStatus?.pauseRequested || indexStatus?.paused);
  const total = Number(indexStatus?.totalArchives || 0);
  const processed = Number(indexStatus?.processedArchives || 0);
  const imported = Math.max(0, Math.floor(Number(indexStatus?.importedBooks) || 0));
  const unique = Math.max(0, Math.floor(Number(indexStatus?.uniqueBooks) || 0));
  const phaseDone = Number(indexStatus?.phaseDone || 0);
  const phaseTotal = Number(indexStatus?.phaseTotal || 0);
  const phaseLabel = String(indexStatus?.phaseLabel || '');
  // Percent reflects the active phase: archives during import, FTS during rebuild,
  // indeterminate (animated bar) during post-index maintenance.
  let percent = 0;
  let title = escapeHtml(t('app.adminIndexingLabel'));
  let detail = '';
  let indeterminate = false;
  if (phase === 'fts') {
    percent = phaseTotal > 0 ? Math.min(100, Math.round((phaseDone / phaseTotal) * 100)) : 0;
    title = escapeHtml(t('app.adminIndexPhaseFts'));
    detail = phaseTotal > 0 ? `<span class="muted" style="margin-left:12px">${phaseDone} / ${phaseTotal}</span>` : '';
  } else if (phase === 'maintenance') {
    indeterminate = true;
    title = escapeHtml(t('app.adminIndexPhaseMaintenance'));
    detail = phaseLabel ? `<span class="muted" style="margin-left:12px">${escapeHtml(phaseLabel)}</span>` : '';
  } else {
    percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    detail = `<span class="muted" style="margin-left:12px">${escapeHtml(tp('app.adminIndexFilesLine', { processed, total, imported, unique }))}</span>`;
  }
  const line = active
    ? `${title} ${indeterminate ? '' : `<strong>${percent}%</strong>`}${detail}`
    : '';
  const archiveRaw = active
    ? (resolveIndexStageLine(indexStatus?.currentStage, t, tp) ||
      (indexStatus?.currentArchive ? String(indexStatus.currentArchive) : ''))
    : '';
  const archive = archiveRaw ? escapeHtml(archiveRaw) : '';
  const barWidth = indeterminate ? 100 : percent;
  return `
    <div id="sources-index-progress" class="alert alert-info" data-admin-index-controls style="${active ? '' : 'display:none'}">
      <div class="index-banner-row">
        <div id="sources-progress-text">${line}</div>
      </div>
      <div class="admin-actions-row" style="margin-top:8px">
        <button type="button" data-operation-action="reindex-toggle-pause" data-operation-label="${escapeHtml(paused ? t('app.adminIndexResumeLabel') : t('app.adminIndexPauseLabel'))}" data-reindex-paused="${paused ? '1' : '0'}">${escapeHtml(paused ? t('app.adminIndexResume') : t('app.adminIndexPause'))}</button>
        <button type="button" data-operation-action="reindex-stop" data-operation-label="${escapeHtml(t('app.adminIndexStopLabel'))}" class="button-danger">${escapeHtml(t('app.adminIndexStop'))}</button>
      </div>
      <div class="muted" id="sources-progress-archive" style="margin-top:6px;word-break:break-word;min-height:1.2em">${archive}</div>
      <div class="muted" id="sources-progress-time" style="margin-top:4px;font-size:12px;min-height:1.2em" data-index-started="${active && indexStatus?.startedAt ? escapeHtml(indexStatus.startedAt) : ''}"></div>
      <div style="margin-top:8px;height:4px;background:var(--border);border-radius:2px;overflow:hidden">
        <div id="sources-progress-bar" class="${indeterminate ? 'progress-indeterminate' : ''}" style="height:100%;width:${barWidth}%;background:var(--accent);transition:width .3s ease"></div>
      </div>
    </div>
  `;
}

export function renderPagination(basePath, page, pageSize, total, query = '') {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) {
    return '';
  }
  const separator = basePath.includes('?') ? '&' : '?';
  const pageHref = (p) => `${basePath}${separator}page=${p}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const pageNumbers = [];
  const windowSize = 2;
  for (let i = Math.max(1, page - windowSize); i <= Math.min(totalPages, page + windowSize); i++) {
    pageNumbers.push(i);
  }
  if (pageNumbers[0] > 1) {
    if (pageNumbers[0] > 2) pageNumbers.unshift('...');
    pageNumbers.unshift(1);
  }
  if (pageNumbers[pageNumbers.length - 1] < totalPages) {
    if (pageNumbers[pageNumbers.length - 1] < totalPages - 1) pageNumbers.push('...');
    pageNumbers.push(totalPages);
  }
  return `
    <nav class="pagination" style="margin-top:20px;" aria-label="${escapeHtml(t('pagination.label'))}">
      ${page > 1 ? `<a class="page-link page-link-prev" href="${pageHref(page - 1)}" aria-label="${escapeHtml(t('pagination.prev'))}">${escapeHtml(t('pagination.prev'))}</a>` : ''}
      ${pageNumbers.map((p) => p === '...'
    ? '<span class="page-ellipsis muted">…</span>'
    : `<a class="page-link ${p === page ? 'page-link-active' : ''}" href="${pageHref(p)}">${p}</a>`
  ).join('')}
      ${page < totalPages ? `<a class="page-link page-link-next" href="${pageHref(page + 1)}" aria-label="${escapeHtml(t('pagination.next'))}">${escapeHtml(t('pagination.next'))}</a>` : ''}
    </nav>`;
}

export function renderBreadcrumbs(items = []) {
  if (!items.length || items.length === 1) {
    return '';
  }

  return `
    <div class="breadcrumbs">
      ${items.map((item, index) => item.href ? `<a href="${item.href}">${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`).join('<span class="muted">/</span>')}
    </div>`;
}

const SORT_NATURAL_DIR = {
  recent: 'DESC', title: 'ASC', author: 'ASC', series: 'ASC',
  rating: 'DESC', date: 'DESC', count: 'DESC', name: 'ASC'
};

export function renderSortControl({ action, sort, order = '', options, query = '', field = '', genre = '', extraHidden = {} }) {
  const extraFields = Object.entries(extraHidden).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
  const natural = SORT_NATURAL_DIR[sort] || 'ASC';
  const effective = order === 'asc' ? 'ASC' : order === 'desc' ? 'DESC' : natural;
  const nextOrder = effective === 'ASC' ? 'desc' : 'asc';
  const toggleLabel = nextOrder === 'asc' ? t('sort.toggleAsc') : t('sort.toggleDesc');
  const icon = effective === 'ASC'
    ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>'
    : '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M4 9l4 4 4-4"/></svg>';
  return `
    <form class="search-form sort-control" action="${action}" method="get">
      ${query ? `<input type="hidden" name="q" value="${escapeHtml(query)}">` : ''}
      ${field ? `<input type="hidden" name="field" value="${escapeHtml(field)}">` : ''}
      ${genre ? `<input type="hidden" name="genre" value="${escapeHtml(genre)}">` : ''}
      ${extraFields}
      <select name="sort" onchange="this.form.submit()" aria-label="${escapeHtml(t('sort.label'))}">
        ${options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === sort ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
      <button type="submit" name="order" value="${nextOrder}" class="button sort-control-order" title="${escapeHtml(toggleLabel)}" aria-label="${escapeHtml(toggleLabel)}">${icon}</button>
    </form>`;
}

export function renderEventDetailsHtml(details) {
  if (!details) return '';
  const looksLikeTimestamp = (value) => {
    const s = String(value || '').trim();
    return Boolean(s) && (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s) || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s));
  };
  const toIsoUtc = (value) => {
    const s = String(value || '').trim();
    if (!s) return '';
    if (s.includes('T') && s.endsWith('Z')) return s;
    if (s.includes(' ')) return `${s.replace(' ', 'T')}Z`;
    return s;
  };
  const formatDetailValue = (value) => {
    if (looksLikeTimestamp(value)) {
      return formatLocaleDateTimeShort(toIsoUtc(value));
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
  try {
    const parsed = JSON.parse(details);
    return Object.entries(parsed)
      .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(formatDetailValue(value))}`)
      .join(' · ');
  } catch {
    return escapeHtml(String(details));
  }
}

export function firstAuthorValue(value = '') {
  return String(value || '')
    .split(':')
    .map((author) => author.trim())
    .filter(Boolean)[0] || '';
}

const WELCOME_QUOTE_NON_AUTHOR_RE = /пословица|proverb/i;

export function isWelcomeQuoteAuthorLinkable(author = '') {
  const name = String(author || '').trim();
  if (!name) return false;
  if (/^anonymous$/i.test(name)) return false;
  if (WELCOME_QUOTE_NON_AUTHOR_RE.test(name)) return false;
  return true;
}

export function renderWelcomeQuoteAuthor(author = '') {
  const name = String(author || '').trim();
  if (!name) return '';
  if (!isWelcomeQuoteAuthorLinkable(name)) {
    return escapeHtml(name);
  }
  const href = `/catalog?field=authors&q=${encodeURIComponent(name)}`;
  return `<a href="${href}">${escapeHtml(name)}</a>`;
}

export function renderAuthorLinks(authorsList = [], { limit = 1, bookAuthors = '', popoverId = '', inlineExpand = false } = {}) {
  const list = authorsList?.length ? authorsList : splitAuthorValues(bookAuthors);
  if (!list.length) return '';
  const visible = list.slice(0, limit);
  const rest = list.slice(limit);
  const visibleHtml = visible.map((author) => {
    const name = formatSingleAuthorName(author) || author;
    return `<a href="/facet/authors/${encodeURIComponent(author)}">${escapeHtml(name)}</a>`;
  }).join(', ');
  if (!rest.length) {
    return `<span class="author-visible">${visibleHtml}</span>`;
  }
  const restHtml = rest.map((author) => {
    const name = formatSingleAuthorName(author) || author;
    return `<a href="/facet/authors/${encodeURIComponent(author)}">${escapeHtml(name)}</a>`;
  }).join(', ');
  if (inlineExpand) {
    const uid = escapeHtml(safeDomIdPart(`inline-${bookAuthors}`));
    return `<span class="author-visible">${visibleHtml}</span> <label class="author-inline"><input type="checkbox" class="author-inline-check" id="${uid}"><span class="author-inline-trigger"><span class="muted">и ещё ${rest.length}</span> <span class="author-inline-arrow"></span></span><span class="author-inline-rest">${restHtml}</span></label>`;
  }
  const id = escapeHtml(safeDomIdPart(popoverId));
  const anchorName = `--${id}`;
  return `<span class="author-visible">${visibleHtml}</span><button type="button" class="author-popover-trigger" popovertarget="${id}" style="anchor-name:${anchorName}">+${rest.length}</button><div id="${id}" popover="auto" class="author-popover" style="position-anchor:${anchorName}"><div class="author-popover-inner">${restHtml}</div></div>`;
}

export function renderSeriesLinks(seriesList = [], { limit = 1, popoverId = '', firstAuthor = '' } = {}) {
  const list = seriesList || [];
  if (!list.length) return '';
  const visible = list.slice(0, limit);
  const rest = list.slice(limit);
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

/**
 * Контейнер для AJAX-секций (рекомендации, "продолжить читать" и т.п.).
 * Намеренно пустой — никаких скелетонов. Карточки рендерятся при подгрузке
 * данных и сразу показывают текстовый fallback, поверх которого затем
 * появляется настоящая картинка. Это уменьшает количество промежуточных
 * визуальных состояний с 4 (skeleton → пустота → fallback → image) до 2
 * (fallback → image).
 */
export function renderSkeletonGrid(_count = 8) {
  return `<div class="grid skeleton-grid" data-skeleton-grid></div>`;
}

export function renderEmptyState({
  title, text, actionHref = '', actionLabel = '',
  secondaryHref = '', secondaryLabel = ''
} = {}) {
  const textLine = String(text || '').trim()
    ? `<span class="muted">${escapeHtml(text)}</span>`
    : '';
  const primary = actionHref && actionLabel
    ? `<a class="button" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>`
    : '';
  const secondary = secondaryHref && secondaryLabel
    ? `<a class="button" href="${escapeHtml(secondaryHref)}">${escapeHtml(secondaryLabel)}</a>`
    : '';
  const actions = (primary || secondary)
    ? `<div class="actions empty-state-actions">${primary}${secondary}</div>`
    : '';
  return `
    <div class="empty-state">
      <span class="empty-state-icon"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="10" width="36" height="28" rx="4"/><path d="M6 18h36"/><circle cx="14" cy="30" r="3"/><path d="M22 28h12M22 34h8"/></svg></span>
      <strong>${escapeHtml(title)}</strong>
      ${textLine}
      ${actions}
    </div>`;
}

export function renderDownloadMenu(book, { compact = false, accent = false, user = null } = {}) {
  if (!canDownloadInUi(user)) return '';
  const formats = getAvailableDownloadFormats(book).map((f) => [f, FORMAT_LABELS[f] || f.toUpperCase()]);
  if (!formats.length) return '';
  const triggerClass = [
    'button',
    'download-menu-trigger',
    compact ? 'download-menu-trigger-compact' : ''
  ].filter(Boolean).join(' ');
  if (formats.length === 1) {
    const [format] = formats[0];
    return `<a class="${triggerClass} download-direct-link" href="${downloadBookPath(book.id, `format=${encodeURIComponent(format)}`)}">${escapeHtml(t('download.label'))}</a>`;
  }
  return `
    <details class="download-menu ${compact ? 'download-menu-compact' : ''}">
      <summary class="${triggerClass}">${escapeHtml(t('download.label'))}</summary>
      <div class="download-menu-popover">
        ${formats.map(([format, label]) => `<a class="download-format-link" href="${downloadBookPath(book.id, `format=${encodeURIComponent(format)}`)}">${escapeHtml(label)}</a>`).join('')}
      </div>
    </details>`;
}

/** Меню форматов для пакетной отправки на email; тот же batchContext, что и для скачивания (в т.ч. { adhoc: true }) */
function renderBatchEmailMenu(params) {
  const paramsJson = escapeHtml(JSON.stringify(params));
  const formats = batchZipFormatPairs();
  const links = formats
    .map(
      ([format, label]) =>
        `<button type="button" class="download-format-link batch-email-format-btn" data-batch-email-format="${escapeHtml(format)}">${escapeHtml(label)}</button>`
    )
    .join('');
  return `
    <details class="download-menu batch-email-menu" data-batch-ereader-params="${paramsJson}">
      <summary class="button download-menu-trigger batch-fab-btn">${escapeHtml(t('email.toEreader'))}</summary>
      <div class="download-menu-popover">${links}</div>
    </details>`;
}

function batchZipFormatPairs() {
  const pairs = config.fb2cngPath
    ? [['fb2', 'FB2'], ['epub2', 'EPUB'], ['epub3', 'EPUB3'], ['kepub', 'KEPUB'], ['kfx', 'KFX'], ['azw8', 'AZW8']]
    : [['fb2', 'FB2']];
  return pairs.filter(([format]) => isDownloadFormatEnabled(format));
}

/** batchContext: { facet, value } | { shelf } | { adhoc: true } — для чекбоксов и POST выбранных книг */
export function renderBatchDownloadToolbar(batchContext, { extraActions = '', user = null } = {}) {
  if (!canDownloadInUi(user)) return '';
  const hasShelf = batchContext && Number(batchContext.shelf) > 0;
  const hasFacet =
    batchContext &&
    (batchContext.facet === 'authors' || batchContext.facet === 'series') &&
    String(batchContext.value ?? '').length > 0;
  const hasAdhoc = batchContext && batchContext.adhoc === true;
  if (!hasShelf && !hasFacet && !hasAdhoc) {
    return '';
  }
  const ctxJson = escapeHtml(JSON.stringify(batchContext));
  const formats = batchZipFormatPairs();
  if (!formats.length) {
    return '';
  }
  const selectedLinks = formats
    .map(
      ([format, label]) =>
        `<button type="button" class="download-format-link batch-selected-format-btn" data-batch-download-selected-format="${escapeHtml(format)}">${escapeHtml(label)}</button>`
    )
    .join('');
  const emailHtml = user && canSendToEmailInUi(user) ? renderBatchEmailMenu(batchContext) : '';
  /* Floating dock — shown via JS when at least one book is checked. */
  return `
    <div class="batch-fab" data-batch-fab hidden>
      <div class="batch-fab-inner batch-download-toolbar" data-batch-download-toolbar data-batch-context="${ctxJson}">
        <span class="batch-fab-count" data-batch-selected-count hidden></span>
        <button type="button" class="button batch-fab-btn batch-fab-select-all" data-batch-select-all>${escapeHtml(t('app.batchSelectAll'))}</button>
        <button type="button" class="button batch-fab-btn batch-fab-clear" data-batch-clear-select>${escapeHtml(t('app.batchDeselectAll'))}</button>
        <details class="download-menu batch-fab-menu">
          <summary class="button batch-fab-btn batch-fab-download download-menu-trigger">${escapeHtml(t('download.label'))}</summary>
          <div class="download-menu-popover download-menu-popover--batch">
            <label class="batch-per-book-zip-option">
              <input type="checkbox" name="perBookZip" value="1" data-batch-per-book-zip>
              <span>${escapeHtml(t('batch.perBookZip'))}</span>
            </label>
            <div class="batch-download-format-list" role="group" aria-label="${escapeHtml(t('batch.formatAria'))}">
              ${selectedLinks}
            </div>
          </div>
        </details>
        ${extraActions}${emailHtml}
      </div>
    </div>`;
}

export function batchScopeDownloadPath({ facet, value, format, perBookZip = false }) {
  const params = new URLSearchParams();
  params.set('facet', String(facet || ''));
  params.set('value', String(value ?? ''));
  if (format) params.set('format', String(format));
  if (perBookZip) params.set('perBookZip', '1');
  return `/download/batch?${params.toString()}`;
}

/** One-click ZIP of every book in an author or series (no checkbox selection). */
export function renderScopeDownloadMenu(batchContext, { user = null } = {}) {
  if (!canDownloadInUi(user)) return '';
  const facet = batchContext && String(batchContext.facet || '');
  const value = batchContext ? String(batchContext.value ?? '') : '';
  if ((facet !== 'authors' && facet !== 'series') || !value) return '';
  const formats = batchZipFormatPairs();
  if (!formats.length) return '';
  const label = t('download.all');
  const title = facet === 'authors' ? t('download.allAuthor') : t('download.allSeries');
  const links = formats
    .map(
      ([format, fmtLabel]) =>
        `<a class="download-format-link" data-scope-download-format href="${escapeHtml(batchScopeDownloadPath({ facet, value, format }))}" download>${escapeHtml(fmtLabel)}</a>`
    )
    .join('');
  return `
    <details class="download-menu download-menu-compact" data-scope-download>
      <summary class="button" title="${escapeHtml(title)}">${escapeHtml(label)}</summary>
      <div class="download-menu-popover download-menu-popover--batch">
        <label class="batch-per-book-zip-option">
          <input type="checkbox" name="perBookZip" value="1" data-scope-per-book-zip>
          <span>${escapeHtml(t('batch.perBookZip'))}</span>
        </label>
        <div class="batch-download-format-list" role="group" aria-label="${escapeHtml(t('batch.formatAria'))}">
          ${links}
        </div>
      </div>
    </details>`;
}

/* Алфавитный указатель убран — есть фильтрация */

function renderSidebarNavigation(user, currentPath = '/', stats = null) {
  const link = (href, label, exact = false) => {
    if (!currentPath) {
      return `<a href="${href}">${label}</a>`;
    }
    const active = exact ? currentPath === href : currentPath === href || currentPath.startsWith(`${href}/`);
    return `<a class="${active ? 'active' : ''}" href="${href}">${label}</a>`;
  };
  const showLanguages = (stats?.totalLanguages ?? 2) > 1;

  return `
    <div class="sidenav-section">${escapeHtml(t('sidebar.section'))}</div>
    <div class="sidenav-links">
      ${link('/', t('nav.home'), true)}
      ${link('/catalog', t('nav.catalog'), true)}
      ${link('/library/recent', t('nav.recent'), true)}
      ${user ? link('/library/recommended', t('nav.recommended'), true) : ''}
      ${link('/authors', t('nav.authors'), true)}
      ${link('/series', t('nav.series'), true)}
      ${link('/genres', t('nav.genres'), true)}
      ${showLanguages ? link('/languages', t('nav.languages'), true) : ''}
      ${user ? link('/profile', t('nav.profile'), true) : ''}
    </div>`;
}

// Единая перекрёстная навигация по личным разделам. Каждый пункт — отдельная
// страница (дёшево по рендеру), но визуально это выглядит как один раздел с
// вкладками. Переиспользуем стиль .view-switcher для единообразия.
export function renderAccountNav(active = '', counts = {}) {
  const items = [
    { key: 'activity', label: t('profile.tabActivity'), href: '/profile' },
    { key: 'books', label: t('favorites.books'), href: '/favorites?view=books' },
    { key: 'series', label: t('favorites.series'), href: '/favorites?view=series' },
    { key: 'authors', label: t('favorites.authors'), href: '/favorites?view=authors' },
    { key: 'shelves', label: t('nav.shelves'), href: '/shelves' },
    { key: 'read', label: t('profile.readBooks'), href: '/library/read' },
    { key: 'settings', label: t('profile.tabSettings'), href: '/profile/settings' }
  ];
  const navLinks = items.map((it) => {
    const count = counts[it.key];
    const badge = count != null ? ` <span class="view-switcher-count">${formatLocaleInt(count)}</span>` : '';
    return `<a class="button view-switcher-link${it.key === active ? ' is-active' : ''}"${it.key === active ? ' aria-current="page"' : ''} href="${it.href}">${escapeHtml(it.label)}${badge}</a>`;
  }).join('');
  const selectOptions = items.map((it) => {
    const count = counts[it.key];
    const label = count != null ? `${it.label} (${formatLocaleInt(count)})` : it.label;
    const selected = it.key === active ? ' selected' : '';
    return `<option value="${escapeHtml(it.href)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');
  return `
    <div class="account-nav-shell">
      <select class="account-nav-select" data-account-nav-select aria-label="${escapeHtml(t('profile.tablistAria'))}">
        ${selectOptions}
      </select>
      <nav class="view-switcher account-nav account-nav-tabs" aria-label="${escapeHtml(t('profile.tablistAria'))}">
        ${navLinks}
      </nav>
    </div>`;
}

function renderTopbarSearch(query = '', field = 'all') {
  const placeholderDefault = t('search.placeholder');
  return `
    <form class="topbar-search" data-smart-search data-catalog-loading action="/catalog" method="get" autocomplete="off">
      <div class="search-suggest-wrap">
        <input id="global-search-input" name="q" value="${escapeHtml(query)}" placeholder="${escapeHtml(placeholderDefault)}" aria-label="${escapeHtml(placeholderDefault)}" data-suggest-input autocomplete="off" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="global-search-suggest-list" role="combobox">
        <div class="search-suggest-dropdown" id="global-search-suggest-list" data-suggest-dropdown role="listbox" aria-label="${escapeHtml(t('search.recentTitle'))}" hidden></div>
      </div>
      <button type="submit">${escapeHtml(t('search.submit'))}</button>
    </form>`;
}

/** Язык / тема / аккаунт — в topbar (desktop) и в сайдбаре (mobile). */
function renderChromeAccountTools({
  isAdmin = false,
  canAccessAdmin = false,
  isAuthenticated = false,
  userLabel = '',
  csrfToken = '',
  className = ''
} = {}) {
  return `
    <div class="${escapeHtml(className)}">
      <span class="topbar-lang" aria-label="${escapeHtml(t('aria.langSwitch'))}">
        <a href="/set-lang?lang=ru" class="topbar-lang-link${getLocale() === 'ru' ? ' is-active' : ''}" hreflang="ru">${escapeHtml(t('nav.langRu'))}</a>
        <span class="muted">·</span>
        <a href="/set-lang?lang=en" class="topbar-lang-link${getLocale() === 'en' ? ' is-active' : ''}" hreflang="en">${escapeHtml(t('nav.langEn'))}</a>
      </span>
      <button type="button" class="theme-toggle" data-theme-toggle aria-label="${escapeHtml(t('themeToggle'))}" title="${escapeHtml(t('themeToggle'))}"><span data-theme-toggle-label>☀</span></button>
      ${!isAdmin ? `${canAccessAdmin ? `<a class="button" href="/admin">${escapeHtml(t('nav.admin'))}</a>` : ''}` : `<a class="button" href="/">${escapeHtml(t('nav.library'))}</a>`}
      ${isAuthenticated
      ? `<a class="button" href="/profile">${escapeHtml(userLabel)}</a><form method="post" action="/logout" class="topbar-logout-form">${csrfHiddenField(csrfToken)}<button type="submit" class="button">${escapeHtml(t('nav.logout'))}</button></form>`
      : `<a class="button" href="/login">${escapeHtml(t('nav.login'))}</a>`}
    </div>`;
}

/* ── Card HTML fragment cache (M7) ── */
const _cardHtmlCache = new Map();
const CARD_CACHE_MAX = 3000;
const CARD_CACHE_TTL = 600_000; // 10 minutes

function _cardCacheKey(book, flags) {
  return `${book.id}|${flags}`;
}

function getCachedCardHtml(key) {
  const cached = _cardHtmlCache.get(key);
  if (cached && Date.now() - cached.ts < CARD_CACHE_TTL) return cached.html;
  if (cached) _cardHtmlCache.delete(key);
  return null;
}

function setCachedCardHtml(key, html) {
  if (_cardHtmlCache.size >= CARD_CACHE_MAX) {
    const firstKey = _cardHtmlCache.keys().next().value;
    if (firstKey !== undefined) _cardHtmlCache.delete(firstKey);
  }
  _cardHtmlCache.set(key, { html, ts: Date.now() });
}

/** Clear all cached card HTML fragments. Call when book metadata is edited. */
export function clearCardHtmlCache() { _cardHtmlCache.clear(); }

export function renderBookGrid(items = [], { isAuthenticated = false, lazyDetails = false, batchSelect = false, user = null, hideDownloads = false, readBookIds = null, seriesContext = null } = {}) {
  const uniqueItems = uniqueBooksById(items);
  const effectiveBatch = batchSelect && !hideDownloads;
  const canDl = canDownloadInUi(user);
  // Flags string encodes rendering-affecting state for cache key
  /* a3: per-card download stays visible alongside batch checkboxes (series / outside-series). */
  const flags = `${effectiveBatch ? '1' : '0'}${hideDownloads ? '1' : '0'}${canDl ? '1' : '0'}${seriesContext ? 's' : ''}a3`;
  const batchCb = (book) =>
    effectiveBatch
      ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} ${batchBookIdDataAttr(book.id)} aria-label="${escapeHtml(t('batch.selectAria'))}"></label>`
      : '';
  return `
    <div class="grid">
      ${uniqueItems.map((book) => {
    const isRead = readBookIds && readBookIds.has(book.id);
    /* readProgress входит в ключ кеша: иначе HTML карточки, отрендеренный
       без прогресса (на каталоге), переиспользуется на /library/continue,
       где прогресс реально присутствует — и полоска не появляется. */
    const progressKey = Math.round(Number(book.readProgress) || 0);
    const cacheKey = _cardCacheKey(book, `${flags}${isRead ? '1' : '0'}${book.libRate || 0}|p${progressKey}|d${Number(book.deleted) ? 1 : 0}`);
    const cached = getCachedCardHtml(cacheKey);
    if (cached) return cached;
    const cardDl = hideDownloads ? '' : renderDownloadMenu(book, { compact: true, user });
    const seriesInfo = seriesContext
      ? (book.seriesList?.find((s) => s.name === seriesContext) || null)
      : null;
    const titlePrefix = seriesInfo?.seriesNo ? `${escapeHtml(String(seriesInfo.seriesNo))}. ` : '';
    const showSeries = !seriesContext && book.seriesList?.length;
    const html = `
        <article class="card" ${bookCardDataAttrs(book.id)}>
          ${batchCb(book)}
          ${renderCover(book, { readBookIds })}
          <div class="meta">
            <h3><a href="${bookPagePath(book.id)}">${titlePrefix}${escapeHtml(book.title)}</a></h3>
            <div class="author">${book.authors ? renderAuthorLinks(book.authorsList, { limit: 1, bookAuthors: book.authors, popoverId: `card-a-${book.id}` }) : escapeHtml(t('book.authorUnknown'))}</div>
            ${showSeries ? `<div class="card-series">${renderSeriesLinks(book.seriesList, { limit: 1, popoverId: `card-s-${book.id}`, firstAuthor: book.authorsList?.[0] || firstAuthorValue(book.authors) })}</div>` : ''}
            ${book.readProgress > 0 ? `<div class="card-read-progress"><div class="read-progress-bar" role="progressbar" aria-valuenow="${Math.round(book.readProgress)}" aria-valuemin="0" aria-valuemax="100"><div class="read-progress-fill" style="width:${Math.round(book.readProgress)}%"></div></div><span class="read-progress-label">${Math.round(book.readProgress)}%</span></div>` : ''}
            ${cardDl ? `<div class="card-actions">${cardDl}</div>` : ''}
          </div>
        </article>`;
    setCachedCardHtml(cacheKey, html);
    return html;
  }).join('')}
    </div>`;
}

export function renderFavoriteBookGrid(items = [], { batchSelect = false, user = null, readBookIds = null, seriesContext = null } = {}) {
  const uniqueItems = uniqueBooksById(items);
  const batchCb = (book) =>
    batchSelect
      ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} ${batchBookIdDataAttr(book.id)} aria-label="${escapeHtml(t('batch.selectAria'))}"></label>`
      : '';
  return `
    <div class="grid">
      ${uniqueItems.map((book) => {
    const seriesInfo = seriesContext
      ? (book.seriesList?.find((s) => s.name === seriesContext) || null)
      : null;
    const titlePrefix = seriesInfo?.seriesNo ? `${escapeHtml(String(seriesInfo.seriesNo))}. ` : '';
    const showSeries = !seriesContext && book.seriesList?.length;
    return `
        <article class="card" ${bookCardDataAttrs(book.id)}>
          ${batchCb(book)}
          ${renderCover(book, { readBookIds })}
          <div class="meta">
            <h3><a href="${bookPagePath(book.id)}">${titlePrefix}${escapeHtml(book.title)}</a></h3>
            <div class="author">${book.authors ? renderAuthorLinks(book.authorsList, { limit: 1, bookAuthors: book.authors, popoverId: `fav-a-${book.id}` }) : escapeHtml(t('book.authorUnknown'))}</div>
            ${showSeries ? `<div class="card-series">${renderSeriesLinks(book.seriesList, { limit: 1, popoverId: `card-s-${book.id}`, firstAuthor: book.authorsList?.[0] || firstAuthorValue(book.authors) })}</div>` : ''}
            <div class="card-actions card-actions-favorites">
              ${batchSelect ? '' : renderDownloadMenu(book, { compact: true, user })}
              <button class="button card-remove-favorite-action" type="button" ${bookIdDataAttr(book.id)} data-bookmark-button="1">${escapeHtml(t('book.remove'))}</button>
            </div>
          </div>
        </article>`;
  }).join('')}
    </div>`;
}

export function renderEntityGrid(items = [], facetBasePath = '/facet/authors', emptyText = null, readSeriesNames = null) {
  const empty = emptyText ?? t('browse.empty');
  if (!items.length) {
    return renderEmptyState({
      title: empty,
      text: t('facet.emptyText')
    });
  }
  const isSeries = facetBasePath.includes('series');
  const seriesBadge = (name) => isSeries && readSeriesNames && readSeriesNames.has(name) ? `<span class="read-series-badge">${READ_CHECK_SVG}</span>` : '';
  const isAuthors = facetBasePath.includes('/authors');
  return `
    <div class="table-list entity-list">
      ${items.map((item) => {
        const rawLabel = item.displayName || item.name;
        const label = isAuthors ? (formatSingleAuthorName(rawLabel) || rawLabel) : rawLabel;
        return `
        <a class="table-row table-row-link" href="${facetBasePath}/${encodeURIComponent(item.name)}">
          <div style="display:flex;align-items:center">
            <span><strong>${escapeHtml(label)}</strong><br>
            <span class="muted">${countLabel('book', item.bookCount)} ${escapeHtml(t('entity.inLibrary'))}</span></span>
            ${seriesBadge(item.name)}
          </div>
        </a>`;
      }).join('')}
    </div>`;
}

/** Список серий на странице автора (как в разделе «Серии», счётчик — книги этого автора в серии). */
export function renderAuthorFacetSeriesList(series = [], outsideSeries = null, readSeriesNames = null, authorName = '') {
  if (!series.length && !outsideSeries) {
    return '';
  }
  const authorParam = authorName ? `?author=${encodeURIComponent(authorName)}` : '';
  const seriesBadge = (seriesName) =>
    readSeriesNames && readSeriesNames.has(seriesName)
      ? `<span class="read-series-badge">${READ_CHECK_SVG}</span>`
      : '';
  const outsideRow = outsideSeries
    ? `
        <a class="table-row table-row-link" href="${escapeHtml(outsideSeries.href)}">
          <div>
            <strong>${escapeHtml(outsideSeries.label || t('authorPage.outsideSeries'))}</strong><br>
            <span class="muted">${countLabel('book', outsideSeries.bookCount || 0)}</span>
          </div>
        </a>`
    : '';
  return `
    <div class="table-list entity-list author-facet-series-entity-list">
      ${series.map(
    (s) => `
        <a class="table-row table-row-link" href="/facet/series/${encodeURIComponent(s.name)}${authorParam}">
          <div style="display:flex;align-items:center">
            <span><strong>${escapeHtml(s.displayName || s.name)}</strong><br>
            <span class="muted">${countLabel('book', s.bookCount)}</span></span>
            ${seriesBadge(s.name)}
          </div>
        </a>`
  ).join('')}
      ${outsideRow}
    </div>`;
}

export function renderAuthorFacetStandaloneBookRows(books = [], batchSelect = false) {
  if (!books.length) {
    return '';
  }
  return `
    <div class="table-list compact-list author-facet-standalone-books">
      ${books
      .map((book) => {
        const id = escapeHtml(String(book.id));
        const title = escapeHtml(book.title || '');
        const meta = `${escapeHtml(formatLanguageLabel(book.lang || 'unknown'))} · ${escapeHtml(String(book.ext || 'fb2').toUpperCase())}`;
        const batchCb = batchSelect
          ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} ${batchBookIdDataAttr(book.id)} aria-label="${escapeHtml(t('batch.selectAria'))}"></label>`
          : '';
        return `
        <div class="author-facet-standalone-row" ${bookCardDataAttrs(book.id)}>
          ${batchCb}
          <a class="table-row-stack table-row-link compact-row author-facet-standalone-link" href="${bookPagePath(book.id)}">
            <div>
              <strong>${title}</strong><br>
              <span class="muted">${meta}</span>
            </div>
          </a>
        </div>`;
      })
      .join('')}
    </div>`;
}

function formatAuthorListSeriesNo(book) {
  const raw = book?.seriesNo ?? book?.seriesIndex ?? '';
  const s = String(raw || '').trim();
  if (!s || s === '0') return '';
  const num = parseFloat(s.replace(/[^\d.]/g, ''));
  if (Number.isFinite(num) && num > 0) return `${Number.isInteger(num) ? String(num) : String(num)}.`;
  return `${s}.`;
}

function renderAuthorListRating(book) {
  const r = Math.max(0, Math.min(5, Math.floor(Number(book?.libRate) || 0)));
  if (!r) return '';
  return `<span class="author-flibusta-rating" title="${escapeHtml(String(r))}">${'★'.repeat(r)}</span>`;
}

function renderAuthorFlibustaBookRow(book, {
  user = null, showSeriesNo = true, batchSelect = false, showAuthor = false
} = {}) {
  const no = showSeriesNo ? formatAuthorListSeriesNo(book) : '';
  const noHtml = no ? `<span class="author-flibusta-no">${escapeHtml(no)}</span>` : '';
  const ext = String(book.ext || 'fb2').toUpperCase();
  const meta = `<span class="muted author-flibusta-meta">${escapeHtml(ext)}</span>`;
  const rating = renderAuthorListRating(book);
  const authorHtml = showAuthor
    ? `<span class="author-flibusta-author muted">${book.authors
      ? renderAuthorLinks(book.authorsList, { limit: 1, bookAuthors: book.authors, popoverId: `list-a-${book.id}` })
      : escapeHtml(t('book.authorUnknown'))}</span>`
    : '';
  const batchCb = batchSelect
    ? `<label class="author-flibusta-batch" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} ${batchBookIdDataAttr(book.id)} aria-label="${escapeHtml(t('batch.selectAria'))}"></label>`
    : '';
  const readBtn = `<a class="button author-flibusta-read" href="${readPagePath(book.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('book.read'))}</a>`;
  const dl = canDownloadInUi(user)
    ? `<span class="author-flibusta-dl">${renderDownloadMenu(book, { compact: true, user })}</span>`
    : '';
  const emailBtn = canSendToEmailInUi(user)
    ? `<button class="button author-flibusta-email" type="button" ${bookIdDataAttr(book.id)} data-send-to-ereader="1">${escapeHtml(t('book.toEmail'))}</button>`
    : '';
  const actions = `<span class="author-flibusta-actions">${readBtn}${dl}${emailBtn}</span>`;
  const deletedHtml = Number(book.deleted)
    ? `<span class="deleted-badge deleted-badge--inline" title="${escapeHtml(t('book.deletedHint'))}">${escapeHtml(t('book.deletedBadge'))}</span>`
    : '';
  return `<li class="author-flibusta-book" ${bookCardDataAttrs(book.id)}>
    ${batchCb}${noHtml}<a class="author-flibusta-title" href="${bookPagePath(book.id)}">${escapeHtml(book.title || '')}</a>
    ${deletedHtml}${authorHtml}${rating}${meta}${actions}
  </li>`;
}

function seriesNoSortKey(book) {
  const raw = String(book?.seriesNo ?? book?.seriesIndex ?? '').trim();
  const num = parseFloat(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(num) ? num : Number.POSITIVE_INFINITY;
}

/**
 * Flibusta-style author bibliography: series headings + numbered book rows.
 */
export function renderAuthorFlibustaList({
  series = [],
  standaloneBooks = [],
  authorName = '',
  user = null,
  batchSelect = false
} = {}) {
  const authorParam = authorName ? `?author=${encodeURIComponent(authorName)}` : '';
  const rowOpts = { user, batchSelect };
  const groupSelect = (ariaLabel) => (batchSelect
    ? `<label class="author-flibusta-series-batch" title="${escapeHtml(ariaLabel)}"><input type="checkbox" class="author-flibusta-series-cb" aria-label="${escapeHtml(ariaLabel)}"></label>`
    : '');
  const seriesBlocks = (series || [])
    .filter((s) => Array.isArray(s.books) && s.books.length)
    .map((s) => {
      const href = `/facet/series/${encodeURIComponent(s.name)}${authorParam}`;
      const ordered = [...s.books].sort((a, b) =>
        seriesNoSortKey(a) - seriesNoSortKey(b)
        || String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true, sensitivity: 'base' })
      );
      const books = ordered.map((book) => renderAuthorFlibustaBookRow(book, { ...rowOpts, showSeriesNo: true })).join('');
      const selectLabel = tp('authorPage.selectSeries', { name: s.displayName || s.name });
      return `<section class="author-flibusta-group">
        <h3 class="author-flibusta-series-title">${groupSelect(selectLabel)}<a href="${escapeHtml(href)}">${escapeHtml(s.displayName || s.name)}</a></h3>
        <ul class="author-flibusta-books">${books}</ul>
      </section>`;
    })
    .join('');
  const standaloneBlock = standaloneBooks.length
    ? `<section class="author-flibusta-group">
        <h3 class="author-flibusta-series-title">${groupSelect(t('authorPage.selectOutsideSeries'))}<span>${escapeHtml(t('authorPage.outsideSeries'))}</span></h3>
        <ul class="author-flibusta-books">${standaloneBooks.map((book) => renderAuthorFlibustaBookRow(book, { ...rowOpts, showSeriesNo: false })).join('')}</ul>
      </section>`
    : '';
  if (!seriesBlocks && !standaloneBlock) return '';
  return `<div class="author-flibusta-list">${seriesBlocks}${standaloneBlock}</div>`;
}

/**
 * Flat Flibusta-style book list for catalog / search / novinki (title + author rows).
 */
export function renderBookFlibustaList(books = [], { user = null, batchSelect = false } = {}) {
  const uniqueItems = uniqueBooksById(books);
  if (!uniqueItems.length) return '';
  const rows = uniqueItems
    .map((book) => renderAuthorFlibustaBookRow(book, {
      user,
      showSeriesNo: false,
      batchSelect,
      showAuthor: true
    }))
    .join('');
  return `<div class="author-flibusta-list catalog-book-list">
    <section class="author-flibusta-group catalog-book-list-group">
      <ul class="author-flibusta-books catalog-book-list-ul">${rows}</ul>
    </section>
  </div>`;
}

export function renderFacetSummaryBlock(title, items = [], path = '') {
  if (!title || !items.length || !path) {
    return '';
  }

  return `
    <section class="facet-summary-block">
      <span class="facet-summary-label">${escapeHtml(title)}:</span>
      ${items.map((item) => `<a class="facet-summary-link" href="${path}/${encodeURIComponent(item.name)}">${escapeHtml(item.displayName || item.name)}</a>`).join('<span class="facet-summary-sep">,</span>')}
    </section>`;
}

export function renderStatsRibbon(stats) {
  if (!stats) {
    return '';
  }

  return `
    <div class="stats-ribbon">
      <div class="stats-chip"><strong>${countLabel('book', stats.totalBooks)}</strong></div>
      <div class="stats-chip"><strong>${countLabel('author', stats.totalAuthors)}</strong></div>
      <div class="stats-chip"><strong>${countLabel('series', stats.totalSeries)}</strong></div>
      <div class="stats-chip"><strong>${countLabel('genre', stats.totalGenres)}</strong></div>
      <div class="stats-chip"><strong>${countLabel('language', stats.totalLanguages)}</strong></div>
    </div>`;
}

export function renderFacetHero({ title, total, summary = {}, description = '' }) {
  return `
    <section class="facet-hero">
      <div>
        <div class="muted">${escapeHtml(t('stats.librarySection'))}</div>
        <h2>${escapeHtml(title)}</h2>
        ${description ? `<p>${escapeHtml(description)}</p>` : ''}
      </div>
      <div class="facet-hero-stats">
        <div class="stats-chip"><strong>${countLabel('book', total)}</strong></div>
        ${summary.relatedItems?.length ? `<div class="stats-chip"><span class="muted">${escapeHtml(t('stats.related'))}</span><strong>${formatLocaleInt(Number(summary.relatedItems.length || 0))}</strong></div>` : ''}
        ${summary.secondaryItems?.length ? `<div class="stats-chip"><span class="muted">${escapeHtml(t('stats.more'))}</span><strong>${formatLocaleInt(Number(summary.secondaryItems.length || 0))}</strong></div>` : ''}
      </div>
    </section>`;
}

export function renderSectionIntro(title, text, actions = []) {
  return `
    <section class="section-intro">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
      </div>
      ${actions.length ? `<div class="actions">${actions.map((action) => `<a class="button" href="${action.href}">${escapeHtml(action.label)}</a>`).join('')}</div>` : ''}
    </section>`;
}

export function renderBookMetaList(book, details) {
  const genreCodes = book.genres ? parseGenreCodes(book.genres) : [];
  const genreLinks = genreCodes.length
    ? genreCodes.map((code) => `<a href="/facet/genres/${encodeURIComponent(code)}">${escapeHtml(formatGenreLabel(code))}</a>`).join(', ')
    : escapeHtml(t('meta.genresNone'));
  return `
    <div class="detail-meta-list">
      <div class="detail-meta-item"><span class="muted">${escapeHtml(t('meta.language'))}</span><strong>${escapeHtml(formatLanguageLabel(book.lang || 'unknown'))}</strong></div>
      <div class="detail-meta-item"><span class="muted">${escapeHtml(t('meta.format'))}</span><strong>${escapeHtml(book.ext || 'fb2')}</strong></div>
      <div class="detail-meta-item"><span class="muted">${escapeHtml(t('meta.genres'))}</span><strong class="detail-meta-genres">${genreLinks}</strong></div>
    </div>`;
}

export function renderDiscoveryTiles(items = []) {
  return `
    <div class="discovery-grid">
      ${items.map((item) => `
        <a class="discovery-tile" href="${item.href}">
          <span class="muted">${escapeHtml(item.kicker || '')}</span>
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.text || '')}</span>
        </a>
      `).join('')}
    </div>`;
}

export function renderMiniBookList(title, items = [], emptyText = null) {
  const empty = emptyText ?? t('mini.empty');
  const body = items.length
    ? items.map((item) => `
          <a class="table-row table-row-stack table-row-link compact-row" href="${bookPagePath(item.id)}">
            <div>
              <strong>${escapeHtml(item.title)}</strong><br>
              <span class="muted">${escapeHtml(formatAuthorLabel(item.authors))}</span>
            </div>
          </a>
        `).join('')
    : `<div class="empty-state empty-state-inline"><p>${escapeHtml(empty)}</p></div>`;
  return `
    <section class="kpi">
      <div class="section-title"><h2 style="font-size:18px;">${escapeHtml(title)}</h2></div>
      <div class="table-list compact-list">
        ${body}
      </div>
    </section>`;
}

export function renderHomeShelf({ title, href, items, type = 'books', facetBasePath = '', isAuthenticated = false, showBatch = false, user = null, readBookIds = null, listView = false } = {}) {
  const batchToolbar = showBatch && items.length && canDownloadInUi(user)
    ? renderBatchDownloadToolbar({ adhoc: true }, { user })
    : '';
  const body = type === 'books'
    ? (items.length
      ? (listView
        ? renderBookFlibustaList(items, { user, batchSelect: Boolean(batchToolbar) })
        : renderBookGrid(items, { isAuthenticated, batchSelect: Boolean(batchToolbar), user, readBookIds }))
      : renderEmptyState({ title: t('home.shelfEmptyTitle'), text: t('home.shelfEmptyText') }))
    : renderEntityGrid(items, facetBasePath, t('home.entityEmpty'));
  const wrapped = batchToolbar ? `<div class="batch-select-scope">${batchToolbar}${body}</div>` : body;
  const viewAttr = type === 'books' && listView ? ' data-home-view="list"' : type === 'books' ? ' data-home-view="grid"' : '';
  return `
    <section class="library-shelf"${viewAttr}>
      <div class="section-title">
        <h2>${escapeHtml(title)}</h2>
        ${href ? `<div class="actions"><a class="shelf-link" href="${href}">${escapeHtml(t('home.showAll'))}</a></div>` : ''}
      </div>
      ${wrapped}
    </section>`;
}

export function renderSiteLogoImg(className = 'brand-logo') {
  const ui = getUiCustomization();
  const src = ui.logoUrl || '/logo.png';
  return `<img src="${escapeHtml(src)}" alt="" class="${className}" onerror="if(this.dataset.fallback!=='1'){this.dataset.fallback='1';this.src='/logo.png'}else{this.style.display='none'}">`;
}

function renderBrandLogoImg(className = 'brand-logo') {
  return renderSiteLogoImg(className);
}

export function renderFaviconLinks() {
  const ui = getUiCustomization();
  const icon = ui.faviconUrl || '/favicon.png';
  const apple = ui.faviconAppleUrl || '/favicon-192.png';
  return `<link rel="icon" href="${escapeHtml(icon)}" type="image/png">
  <link rel="apple-touch-icon" href="${escapeHtml(apple)}">`;
}

function renderWebFontLinks() {
  const ui = getUiCustomization();
  const families = [];
  const activeWebfont = FONT_FAMILY_WEBFONT[ui.fontFamily];
  if (activeWebfont) {
    families.push(activeWebfont);
  }
  if (DISPLAY_FONT_WEBFONT && !families.includes(DISPLAY_FONT_WEBFONT)) {
    families.push(DISPLAY_FONT_WEBFONT);
  }
  const familyQuery = families.map((f) => `family=${f}`).join('&');
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?${familyQuery}&display=swap" rel="stylesheet">`;
}

function renderUiFontFaceStyle() {
  const ui = getUiCustomization();
  if (ui.fontFamily !== 'custom' || !ui.customFontUrl || !ui.customFontFormat) return '';
  const name = String(ui.customFontName || 'Custom Font').replace(/["\\]/g, '').trim().slice(0, 64) || 'Custom Font';
  return `<style>@font-face{font-family:'${name}';src:url('${ui.customFontUrl}') format('${ui.customFontFormat}');font-display:swap;font-weight:400;font-style:normal;}</style>`;
}

function renderUiCustomizationStyle() {
  const vars = getThemeCssVars();
  if (!vars.length) return '';
  return `<style>:root{${vars.join(';')}}</style>`;
}

function uiHtmlRootAttrs() {
  const ui = getUiCustomization();
  let attrs = '';
  if (hasUiThemeColorsConfigured()) attrs += ' data-ui-theme="1"';
  if (usesPanelGlass()) {
    attrs += ' data-ui-sliders="1"';
  }
  if (ui.hasBackground) attrs += ' data-ui-bg="1"';
  if (hasUiThemeShapeConfigured()) attrs += ' data-ui-shape="1"';
  if (hasUiThemeTypographyConfigured()) attrs += ' data-ui-typography="1"';
  return attrs;
}

function renderThemeBootScript() {
  return `<script>
    (() => {
      try {
        const savedTheme = localStorage.getItem('theme-preference');
        const theme = savedTheme === 'light' || savedTheme === 'dark'
          ? savedTheme
          : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.dataset.theme = theme;
      } catch {
        document.documentElement.dataset.theme = 'dark';
      }
    })();
  </script>`;
}

function renderBottomNav({ user = null, currentPath = '', isAdmin = false } = {}) {
  if (isAdmin) return '';
  const path = String(currentPath || '');
  const isAuthed = Boolean(user);
  const item = (href, label, active) =>
    `<a class="bottom-nav-item${active ? ' is-active' : ''}" href="${escapeHtml(href)}"><span>${escapeHtml(label)}</span></a>`;
  const homeActive = path === '/' || path === '';
  const catalogActive = path.startsWith('/catalog');
  const favActive = path.startsWith('/favorites');
  const profileActive = path.startsWith('/profile');
  const loginActive = path.startsWith('/login');
  return `
    <nav class="bottom-nav" aria-label="${escapeHtml(t('aria.sidebar'))}" data-bottom-nav>
      ${item('/', t('nav.bottomHome'), homeActive)}
      ${item('/catalog', t('nav.bottomCatalog'), catalogActive)}
      ${isAuthed
      ? `${item('/favorites', t('nav.bottomFavorites'), favActive)}${item('/profile', t('nav.bottomProfile'), profileActive)}`
      : item('/login', t('nav.bottomLogin'), loginActive)}
    </nav>`;
}

function renderLoginLogoBlock() {
  const ui = getUiCustomization();
  if (!ui.showLogoOnLogin) return '';
  const src = ui.logoUrl || '/logo.png';
  return `<div class="login-brand-logo"><img src="${escapeHtml(src)}" alt="" class="login-logo-img" onerror="if(this.dataset.fallback!=='1'){this.dataset.fallback='1';this.src='/logo.png'}else{this.parentElement.style.display='none'}"></div>`;
}

/**
 * QR pairing widget markup (filled by public/app.js).
 * @param {'panel'|'sidebar'} variant
 */
export function renderAppPairWidget(variant = 'panel') {
  if (variant === 'sidebar') {
    return `
      <div class="sidebar-app-pair" data-app-pair-root data-app-pair-variant="sidebar">
        <button type="button" class="sidebar-app-pair-btn" data-app-pair-open aria-label="${escapeHtml(t('profile.appPair.sidebarAria'))}" title="${escapeHtml(t('profile.appPair.open'))}">
          <span class="sidebar-app-pair-qr" data-app-pair-qr aria-hidden="true"></span>
        </button>
      </div>`;
  }
  return `
    <div class="app-pair-panel" data-app-pair-root data-app-pair-variant="panel" data-app-pair-autoload="1">
      <strong>${escapeHtml(t('profile.appPair.title'))}</strong>
      <p class="muted app-pair-hint">${escapeHtml(t('profile.appPair.hint'))}</p>
      <p class="app-pair-app-link"><a href="https://github.com/Habsaec/inpx-book-reader/releases/latest" target="_blank" rel="noopener noreferrer">${escapeHtml(t('profile.appPair.appLink'))}</a></p>
      <div class="app-pair-body">
        <div class="app-pair-qr-wrap" data-app-pair-qr aria-hidden="true"></div>
        <div class="app-pair-meta">
          <div class="app-pair-meta-row"><span class="muted">${escapeHtml(t('profile.appPair.serverUrl'))}</span> <code data-app-pair-url></code></div>
          <div class="app-pair-meta-row"><span class="muted">${escapeHtml(t('profile.appPair.username'))}</span> <code data-app-pair-user></code></div>
          <p class="muted app-pair-expires" data-app-pair-expires></p>
          <p class="app-pair-error" data-app-pair-error hidden></p>
          <div class="actions">
            <button type="button" class="button" data-app-pair-refresh>${escapeHtml(t('profile.appPair.refresh'))}</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderUserSidebar({
  query = '',
  field = 'all',
  stats,
  user = null,
  currentPath = '/',
  canAccessAdmin = false,
  csrfToken = ''
}) {
  const appPairFooter = user
    ? `<div class="sidebar-footer">${renderAppPairWidget('sidebar')}</div>`
    : '';
  return `
    <aside class="sidebar sidebar-user" aria-label="${escapeHtml(t('aria.sidebar'))}">
      <div class="sidebar-user-scroll">
        <div class="brand">
          <a href="/" class="brand-home-link" title="${escapeHtml(t('nav.home'))}">
            ${renderBrandLogoImg()}
            <h2>${escapeHtml(siteTitleForDisplay())}</h2>
          </a>
        </div>
        ${renderSidebarNavigation(user, currentPath, stats)}
        ${renderChromeAccountTools({
    isAdmin: false,
    canAccessAdmin,
    isAuthenticated: Boolean(user),
    userLabel: user?.username || '',
    csrfToken,
    className: 'sidebar-tools'
  })}
      </div>
      ${appPairFooter}
    </aside>
    <div class="sidebar-overlay" data-sidebar-overlay></div>`;
}

function renderAdminSidebar(currentPath = '/admin', { user = null, csrfToken = '' } = {}) {
  const ver = getPackageVersion();
  const link = (href, label, exact = false) => {
    const active = exact ? currentPath === href : currentPath === href || currentPath.startsWith(`${href}/`);
    return `<a class="${active ? 'active' : ''}" href="${href}">${label}</a>`;
  };
  return `
    <aside class="sidebar sidebar-admin" aria-label="${escapeHtml(t('aria.sidebarAdmin'))}">
      <div class="sidebar-admin-scroll">
        <div class="brand">
          <a href="/" class="brand-home-link" title="${escapeHtml(t('nav.library'))}">
            ${renderBrandLogoImg()}
            <h2>${escapeHtml(siteTitleForDisplay())}</h2>
          </a>
          <p class="admin-sidebar-badge">${escapeHtml(t('admin.badge'))}</p>
        </div>
        <div class="sidenav-section">${escapeHtml(t('admin.section'))}</div>
        <div class="sidenav-links">
          ${link('/admin', t('admin.nav.dashboard'), true)}
          ${link('/admin/sources', t('admin.nav.sources'))}
          ${link('/admin/duplicates', t('admin.nav.duplicates'))}
          ${link('/admin/content', t('admin.nav.content'))}
          ${link('/admin/users', t('admin.nav.users'))}
          ${link('/admin/smtp', t('admin.nav.smtp'))}
          ${link('/admin/telegram', t('admin.nav.telegram'))}
          ${link('/admin/appearance', t('admin.nav.appearance'))}
          ${link('/admin/events', t('admin.nav.events'))}
          ${link('/admin/update', t('admin.nav.backup'))}
        </div>
      </div>
      <div class="admin-sidebar-footer">
        ${renderChromeAccountTools({
    isAdmin: true,
    canAccessAdmin: true,
    isAuthenticated: Boolean(user),
    userLabel: user?.username || '',
    csrfToken,
    className: 'sidebar-tools'
  })}
        <a href="https://github.com/Habsaec/inpx-library-server/releases" target="_blank" rel="noopener" class="admin-sidebar-version" data-operations-field="appVersion" style="text-decoration:none;color:inherit">v${escapeHtml(ver)}</a>
      </div>
    </aside>
    <div class="sidebar-overlay" data-sidebar-overlay></div>`;
}

export function pageShell({ title, content, user, query = '', field = 'all', stats, flash = '', indexStatus, breadcrumbs = [], mode = 'user', currentPath = '', csrfToken = '', readBookIds = null }) {
  const isAdmin = mode === 'admin';
  const isAuthenticated = Boolean(user);
  const canAccessAdmin = user?.role === 'admin';
  const userLabel = user?.username || '';
  const htmlLang = getLocale() === 'en' ? 'en' : 'ru';
  const siteDisplay = siteTitleForDisplay();
  return `<!doctype html>
<html lang="${htmlLang}"${uiHtmlRootAttrs()}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${csrfToken ? `<meta name="csrf-token" content="${escapeHtml(csrfToken)}">` : ''}
  <title>${title !== siteDisplay ? escapeHtml(siteDisplay) + ' \u2014 ' + escapeHtml(title) : escapeHtml(title)}</title>
  ${renderThemeBootScript()}
  ${renderFaviconLinks()}
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#1a1a2e">
  ${renderWebFontLinks()}
  ${renderUiFontFaceStyle()}
  <link rel="stylesheet" href="/${CSS_ASSET_FILE}?v=${STATIC_ASSET_VERSION}">
  ${renderUiCustomizationStyle()}
  <style>
    .spinner{display:block;width:36px;height:36px;border:4px solid rgba(255,255,255,.15);border-top-color:var(--accent-hover,#a1671b);border-radius:50%;animation:spin .7s linear infinite;}
    html[data-theme="light"] .spinner{border-color:rgba(0,0,0,.12);border-top-color:var(--accent-hover,#a1671b);}
    @keyframes spin{to{transform:rotate(360deg);}}
    .nav-progress{position:fixed;top:0;left:0;height:3px;width:0;background:var(--accent-hover,#a1671b);z-index:99999;opacity:0;pointer-events:none;transition:opacity .15s;}
    .nav-progress.active{opacity:1;animation:nav-grow 12s cubic-bezier(.08,.4,.2,1) forwards;}
    @keyframes nav-grow{0%{width:0}15%{width:35%}40%{width:65%}65%{width:82%}100%{width:97%}}
  </style>
</head>
<body data-download-allowed="${canDownloadInUi(user) ? '1' : '0'}" data-batch-zip-max="${BATCH_ZIP_MAX}">
  <div class="nav-progress" id="nav-progress"></div>
  <script>!function(){var b=document.getElementById('nav-progress');if(!b)return;function done(){b.classList.remove('active')}done();window.addEventListener('pageshow',done);window.addEventListener('popstate',done);document.addEventListener('click',function(e){var a=e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(!h||h.charAt(0)==='#'||a.target==='_blank'||e.ctrlKey||e.metaKey||e.shiftKey)return;b.classList.add('active')});document.addEventListener('submit',function(){b.classList.add('active')})}()</script>
  <script type="application/json" id="ui-i18n-json">${serializeClientI18n()}</script>
  ${readBookIds && readBookIds.size ? `<script type="application/json" id="ui-read-ids">${JSON.stringify([...readBookIds])}</script>` : ''}
  <a class="skip-to-content" href="#main-content">${escapeHtml(t('skipToContent'))}</a>
  <div class="shell">
    ${isAdmin
      ? renderAdminSidebar(currentPath, { user, csrfToken })
      : renderUserSidebar({ query, field, stats, user, currentPath, canAccessAdmin, csrfToken })}
    <div class="main-wrap">
      <header class="topbar ${isAdmin ? 'topbar-admin' : ''}" data-topbar>
        <button class="sidebar-toggle" type="button" aria-label="${escapeHtml(t('sidebarOpen'))}" data-sidebar-toggle aria-expanded="false">☰</button>
        <a href="${isAdmin ? '/admin' : '/'}" class="topbar-brand" title="${escapeHtml(isAdmin ? t('nav.library') : t('nav.home'))}">
          ${renderBrandLogoImg('topbar-brand-logo')}
        </a>
        ${!isAdmin ? `<div class="topbar-main">${renderTopbarSearch(query, field)}</div>` : ''}
        <div class="topbar-right">
          ${!isAdmin ? `<button type="button" class="topbar-search-toggle" data-topbar-search-toggle aria-label="${escapeHtml(t('topbar.searchToggle'))}" aria-expanded="false" aria-controls="global-search-input" title="${escapeHtml(t('topbar.searchToggle'))}">⌕</button>` : ''}
          ${renderChromeAccountTools({
        isAdmin,
        canAccessAdmin,
        isAuthenticated,
        userLabel,
        csrfToken,
        className: 'topbar-desktop-tools'
      })}
        </div>
      </header>
    ${isAdmin ? renderAdminIndexControls(indexStatus) : renderIndexStatus(indexStatus, stats)}
    ${flash ? renderAlert('success', flash) : ''}
    ${renderBreadcrumbs(breadcrumbs)}
    <div class="layout">
      <main id="main-content" class="panel">${content}</main>
    </div>
    </div>
  </div>
  ${!isAdmin ? renderBottomNav({ user, currentPath, isAdmin }) : ''}
  <button class="scroll-to-top" type="button" data-scroll-top aria-label="${escapeHtml(t('scrollTop'))}">↑</button>
  <script src="/book-ref.js?v=${STATIC_ASSET_VERSION}" defer></script>
  <script src="/${APP_ASSET_FILE}?v=${STATIC_ASSET_VERSION}" defer></script>
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  </script>
</body>
</html>`;
}

export function renderMaintenance({ user, stats, csrfToken = '' }) {
  const content = `
    <div class="empty-state" style="min-height:50vh;display:flex;flex-direction:column;align-items:center;justify-content:center">
      <div class="spinner" style="margin-bottom:24px"></div>
      <strong style="font-size:20px">${escapeHtml(t('maintenance.title'))}</strong>
      <span class="muted" style="margin-top:8px;max-width:440px;text-align:center">${escapeHtml(t('maintenance.text'))}</span>
    </div>
    <script>setTimeout(function(){location.reload()},10000)</script>`;
  return pageShell({
    title: t('maintenance.title'),
    content,
    user,
    stats,
    csrfToken,
    currentPath: '/'
  });
}

export function renderLoginScreen({
  title,
  subtitle,
  action,
  error = '',
  successMessage = '',
  extraHtml = '',
  beforeFormHtml = '',
  hideForm = false,
  submitLabel,
  passwordAutocomplete = 'current-password',
  captchaHtml = '',
  headExtra = '',
  hidePasswordField = false,
  hideUsernameField = false,
  usernameLabel,
  usernameName = 'username',
  usernameType = 'text',
  usernameAutocomplete = 'username',
  hiddenFieldsHtml = '',
  extraFieldsHtml = '',
  confirmPasswordField = false,
  passwordLabel
}) {
  const submit = submitLabel || t('login.submit');
  const userLabel = usernameLabel || t('login.username');
  const passLabel = passwordLabel || t('login.password');
  const htmlLang = getLocale() === 'en' ? 'en' : 'ru';
  const siteDisplay = siteTitleForDisplay();
  const userFieldId = usernameName === 'username' ? 'username' : 'login-field-user';
  const formFields = hideForm ? '' : `<div class="vertical-form">
        ${hideUsernameField ? '' : `<div>
          <label for="${userFieldId}">${escapeHtml(userLabel)}</label>
          <input id="${userFieldId}" name="${escapeHtml(usernameName)}" type="${escapeHtml(usernameType)}" autocomplete="${escapeHtml(usernameAutocomplete)}">
        </div>`}
        ${hidePasswordField ? '' : `<div>
          <label for="password">${escapeHtml(passLabel)}</label>
          <input id="password" type="password" name="password" autocomplete="${passwordAutocomplete}">
        </div>`}
        ${confirmPasswordField ? `<div>
          <label for="confirmPassword">${escapeHtml(t('passwordReset.confirmPassword'))}</label>
          <input id="confirmPassword" type="password" name="confirmPassword" autocomplete="new-password">
        </div>` : ''}
        ${extraFieldsHtml}
        ${hiddenFieldsHtml}
        ${captchaHtml}
        <button type="submit">${escapeHtml(submit)}</button>
      </div>`;
  return `<!doctype html>
<html lang="${htmlLang}"${uiHtmlRootAttrs()}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(siteDisplay)} \u2014 ${escapeHtml(title)}</title>
  ${renderThemeBootScript()}
  ${renderFaviconLinks()}
  ${renderWebFontLinks()}
  ${renderUiFontFaceStyle()}
  <link rel="stylesheet" href="/${CSS_ASSET_FILE}?v=${STATIC_ASSET_VERSION}">
  ${renderUiCustomizationStyle()}
  <style>
    .spinner{display:block;width:36px;height:36px;border:4px solid rgba(255,255,255,.15);border-top-color:var(--accent-hover,#a1671b);border-radius:50%;animation:spin .7s linear infinite;}
    html[data-theme="light"] .spinner{border-color:rgba(0,0,0,.12);border-top-color:var(--accent-hover,#a1671b);}
    @keyframes spin{to{transform:rotate(360deg);}}
  </style>
  ${headExtra}
</head>
<body>
  <div class="login-shell">
    <${hideForm ? 'div' : 'form'} class="login-card"${hideForm ? '' : ` method="post" action="${action}"`}>
      ${renderLoginLogoBlock()}
      <div class="brand" style="margin-bottom:20px;">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      ${error ? renderAlert('error', error) : ''}
      ${successMessage ? renderAlert('success', successMessage) : ''}
      ${beforeFormHtml}
      ${formFields}
      ${extraHtml}
      <div class="login-lang" aria-label="${escapeHtml(t('aria.langSwitch'))}">
        <a href="/set-lang?lang=ru" class="topbar-lang-link${getLocale() === 'ru' ? ' is-active' : ''}" hreflang="ru">${escapeHtml(t('nav.langRu'))}</a>
        <span class="muted">·</span>
        <a href="/set-lang?lang=en" class="topbar-lang-link${getLocale() === 'en' ? ' is-active' : ''}" hreflang="en">${escapeHtml(t('nav.langEn'))}</a>
      </div>
    </${hideForm ? 'div' : 'form'}>
  </div>
</body>
</html>`;
}
