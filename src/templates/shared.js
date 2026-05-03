/**
 * Shared template helpers: layout, page shell, grids, sidebars, and small UI fragments.
 * Every exported symbol here is used by one or more sibling template modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatAuthorLabel, formatGenreLabel, formatLanguageLabel, parseGenreCodes } from '../genre-map.js';
import { getAvailableDownloadFormats, FORMAT_LABELS } from '../conversion.js';
import { config } from '../config.js';
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

export { t, tp, getLocale, plural, countLabel, formatLocaleInt, formatLocaleDateShort, formatLocaleDateTimeShort, formatLocaleDateLong, serializeClientI18n };
export { formatAuthorLabel, formatGenreLabel, formatLanguageLabel, parseGenreCodes };
export { getAvailableDownloadFormats, FORMAT_LABELS };

export const STATIC_ASSET_VERSION = String(Date.now());

const APP_MIN_PATH = path.join(config.publicDir, 'app.min.js');
const CSS_MIN_PATH = path.join(config.publicDir, 'styles.min.css');
const USE_MINIFIED_ASSETS =
  String(process.env.NODE_ENV || '').toLowerCase() === 'production' &&
  fs.existsSync(APP_MIN_PATH) &&
  fs.existsSync(CSS_MIN_PATH);
const APP_ASSET_FILE = USE_MINIFIED_ASSETS ? 'app.min.js' : 'app.js';
const CSS_ASSET_FILE = USE_MINIFIED_ASSETS ? 'styles.min.css' : 'styles.css';

export const READ_CHECK_SVG = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

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

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  return `<div class="${cls}"${attrs ? ' ' + attrs : ''}><span class="alert-icon">${icon}</span><span class="alert-content">${content}</span></div>`;
}

export function renderIndexStatus(indexStatus, stats) {
  if (!indexStatus) {
    return '';
  }

  if (indexStatus.active) {
    return renderAlert('info', escapeHtml(t('index.active')), { attrs: 'data-index-status' });
  }

  if (indexStatus.error) {
    return renderAlert('error', escapeHtml(t('index.error')) + ' ' + escapeHtml(indexStatus.error), { attrs: 'data-index-status' });
  }

  return '';
}

function renderAdminIndexStatus(indexStatus) {
  if (!indexStatus) return '';
  if (indexStatus.active) {
    return renderAlert('info', escapeHtml(t('index.active')), { attrs: 'data-index-status' });
  }
  if (indexStatus.error) {
    return renderAlert('error', escapeHtml(t('index.error')) + ' ' + escapeHtml(indexStatus.error), { attrs: 'data-index-status' });
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
    detail = `<span class="muted" style="margin-left:12px">${escapeHtml(tp('app.adminIndexFilesLine', { processed, total, imported }))}</span>`;
  }
  const line = active
    ? `${title} ${indeterminate ? '' : `<strong>${percent}%</strong>`}${detail}`
    : '';
  const archive = active && indexStatus?.currentArchive ? escapeHtml(String(indexStatus.currentArchive)) : '';
  const barWidth = indeterminate ? 100 : percent;
  return `
    <div id="sources-index-progress" class="alert alert-info" data-admin-index-controls style="${active ? '' : 'display:none'}">
      <div class="index-banner-row">
        <div id="sources-progress-text">${line}</div>
      </div>
      <div class="admin-actions-row" style="margin-top:8px">
        <button type="button" data-operation-action="reindex-toggle-pause" data-operation-label="${paused ? 'Продолжить индексацию' : 'Пауза индексации'}" data-reindex-paused="${paused ? '1' : '0'}">${paused ? 'Продолжить' : 'Пауза'}</button>
        <button type="button" data-operation-action="reindex-stop" data-operation-label="Остановить индексацию" class="button-danger">Остановить</button>
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

export function renderSortControl({ action, sort, options, query = '', field = '', genre = '', extraHidden = {} }) {
  const extraFields = Object.entries(extraHidden).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
  return `
    <form class="search-form" action="${action}" method="get" style="max-width:280px;">
      ${query ? `<input type="hidden" name="q" value="${escapeHtml(query)}">` : ''}
      ${field ? `<input type="hidden" name="field" value="${escapeHtml(field)}">` : ''}
      ${genre ? `<input type="hidden" name="genre" value="${escapeHtml(genre)}">` : ''}
      ${extraFields}
      <select name="sort" onchange="this.form.submit()">
        ${options.map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === sort ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
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

export function renderSkeletonGrid(count = 8) {
  const cards = Array.from({ length: count }, () => `
    <div class="skeleton-card">
      <div class="skeleton-cover"></div>
      <div class="skeleton-line"></div>
      <div class="skeleton-line skeleton-line-short"></div>
    </div>`).join('');
  return `<div class="grid skeleton-grid" data-skeleton-grid>${cards}</div>`;
}

export function renderEmptyState({ title, text, actionHref = '', actionLabel = '' }) {
  const textLine = String(text || '').trim()
    ? `<span class="muted">${escapeHtml(text)}</span>`
    : '';
  return `
    <div class="empty-state">
      <span class="empty-state-icon"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="10" width="36" height="28" rx="4"/><path d="M6 18h36"/><circle cx="14" cy="30" r="3"/><path d="M22 28h12M22 34h8"/></svg></span>
      <strong>${escapeHtml(title)}</strong>
      ${textLine}
      ${actionHref && actionLabel ? `<div class="actions" style="justify-content:center;margin-top:12px;"><a class="button" href="${actionHref}">${escapeHtml(actionLabel)}</a></div>` : ''}
    </div>`;
}

export function renderDownloadMenu(book, { compact = false, accent = false, user = null } = {}) {
  if (!canDownloadInUi(user)) return '';
  const available = getAvailableDownloadFormats(book);
  const formats = available.map((f) => [f, FORMAT_LABELS[f] || f.toUpperCase()]);
  const triggerClass = [
    'button',
    'download-menu-trigger',
    compact ? 'download-menu-trigger-compact' : ''
  ].filter(Boolean).join(' ');
  return `
    <details class="download-menu ${compact ? 'download-menu-compact' : ''}">
      <summary class="${triggerClass}">${escapeHtml(t('download.label'))}</summary>
      <div class="download-menu-popover">
        ${formats.map(([format, label]) => `<a class="download-format-link" href="/download/${encodeURIComponent(book.id)}?format=${encodeURIComponent(format)}">${escapeHtml(label)}</a>`).join('')}
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
      <summary class="button download-menu-trigger">${escapeHtml(t('email.toEreader'))}</summary>
      <div class="download-menu-popover">${links}</div>
    </details>`;
}

function batchZipFormatPairs() {
  return config.fb2cngPath
    ? [['fb2', 'FB2'], ['epub2', 'EPUB'], ['epub3', 'EPUB3'], ['kepub', 'KEPUB'], ['kfx', 'KFX'], ['azw8', 'AZW8']]
    : [['fb2', 'FB2']];
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
  const selectedLinks = formats
    .map(
      ([format, label]) =>
        `<button type="button" class="download-format-link batch-selected-format-btn" data-batch-download-selected-format="${escapeHtml(format)}">${escapeHtml(label)}</button>`
    )
    .join('');
  const toolbar = `
    <div class="batch-download-toolbar" data-batch-download-toolbar data-batch-context="${ctxJson}">
      <span class="muted batch-selected-count" data-batch-selected-count hidden></span>
      <button type="button" class="button" data-batch-toggle-select aria-pressed="false">${escapeHtml(t('batch.selectAll'))}</button>
      <details class="download-menu">
        <summary class="button download-menu-trigger">${escapeHtml(t('download.label'))}</summary>
        <div class="download-menu-popover download-menu-popover--batch">
          <label class="batch-per-book-zip-option">
            <input type="checkbox" id="batch-per-book-zip" name="perBookZip" value="1" data-batch-per-book-zip>
            <span>${escapeHtml(t('batch.perBookZip'))}</span>
          </label>
          <div class="batch-download-format-list" role="group" aria-label="${escapeHtml(t('batch.formatAria'))}">
            ${selectedLinks}
          </div>
        </div>
      </details>
    </div>`;
  const emailHtml = user ? renderBatchEmailMenu(batchContext) : '';
  return `
    <div class="batch-download-bar">
      <div class="batch-download-cluster">${toolbar}${extraActions}${emailHtml}</div>
    </div>`;
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
      ${link('/library/recent', t('nav.recent'), true)}
      ${user ? link('/library/recommended', t('nav.recommended'), true) : ''}
      ${user ? link('/library/continue', t('nav.continue'), true) : ''}
      ${link('/authors', t('nav.authors'), true)}
      ${link('/series', t('nav.series'), true)}
      ${link('/genres', t('nav.genres'), true)}
      ${showLanguages ? link('/languages', t('nav.languages'), true) : ''}
      ${user ? link('/favorites', t('nav.favorites'), true) : ''}
      ${user ? link('/shelves', t('nav.shelves'), true) : ''}
      ${user ? link('/profile', t('nav.profile'), true) : ''}
    </div>`;
}

function renderTopbarSearch(query = '', field = 'all') {
  const normalizedField = field === 'authors' || field === 'series' ? field : 'books';
  return `
    <form class="topbar-search" data-smart-search data-catalog-loading action="/catalog" method="get" autocomplete="off">
      <div class="search-suggest-wrap">
        <input id="global-search-input" name="q" value="${escapeHtml(query)}" placeholder="${escapeHtml(t('search.placeholder'))}" data-suggest-input aria-label="${escapeHtml(t('search.placeholder'))}" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="global-search-suggest-list" role="combobox">
        <div class="search-suggest-dropdown" id="global-search-suggest-list" data-suggest-dropdown role="listbox" aria-label="${escapeHtml(t('search.submit'))}" hidden></div>
      </div>
      <select name="field" data-search-scope>
        ${[
          ['books', t('search.books')],
          ['authors', t('search.authors')],
          ['series', t('search.series')]
        ].map(([val,label]) => `<option value="${val}" ${val === normalizedField ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
      <button type="submit">${escapeHtml(t('search.submit'))}</button>
    </form>`;
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

export function renderBookGrid(items = [], { isAuthenticated = false, lazyDetails = false, batchSelect = false, user = null, hideDownloads = false, readBookIds = null } = {}) {
  const uniqueItems = uniqueBooksById(items);
  const effectiveBatch = batchSelect && !hideDownloads;
  const canDl = canDownloadInUi(user);
  // Flags string encodes rendering-affecting state for cache key
  const flags = `${effectiveBatch ? '1' : '0'}${hideDownloads ? '1' : '0'}${canDl ? '1' : '0'}`;
  const batchCb = (book) =>
    effectiveBatch
      ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} data-batch-book-id="${escapeHtml(book.id)}" aria-label="${escapeHtml(t('batch.selectAria'))}"></label>`
      : '';
  const readBadge = (book) => readBookIds && readBookIds.has(book.id) ? `<span class="read-badge">${READ_CHECK_SVG}</span>` : '';
  return `
    <div class="grid">
      ${uniqueItems.map((book) => {
        const isRead = readBookIds && readBookIds.has(book.id);
        const cacheKey = _cardCacheKey(book, `${flags}${isRead ? '1' : '0'}`);
        const cached = getCachedCardHtml(cacheKey);
        if (cached) return cached;
        const cardDl = effectiveBatch || hideDownloads ? '' : renderDownloadMenu(book, { compact: true, user });
        const html = `
        <article class="card" data-book-id="${escapeHtml(book.id)}">
          ${batchCb(book)}
          <a class="cover" href="/book/${encodeURIComponent(book.id)}" data-role="cover">
            <img class="cover-image is-loaded" loading="lazy" draggable="false" src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" data-cover-src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" alt="${escapeHtml(book.title)}">
            <span class="cover-fallback" hidden>
              <img class="cover-fallback-image" draggable="false" src="/book-fallback.png" alt="">
              <span class="cover-fallback-overlay"></span>
              <span class="cover-fallback-copy">
                <span class="cover-fallback-title">${escapeHtml(book.title)}</span>
                <span class="cover-fallback-author">${escapeHtml(formatAuthorLabel(book.authors) || t('book.authorUnknown'))}</span>
              </span>
            </span>
            ${readBadge(book)}
          </a>
          <div class="meta">
            <h3><a href="/book/${encodeURIComponent(book.id)}">${escapeHtml(book.title)}</a></h3>
            <div class="author">${book.authors ? `<a href="/facet/authors/${encodeURIComponent(book.authorsList?.[0] || firstAuthorValue(book.authors))}">${escapeHtml(formatAuthorLabel(book.authors))}</a>` : escapeHtml(t('book.authorUnknown'))}</div>
            ${book.series ? `<div class="card-series"><a href="/facet/series/${encodeURIComponent(book.series)}">${escapeHtml(book.series)}${book.seriesNo ? ` #${escapeHtml(book.seriesNo)}` : ''}</a></div>` : ''}
            ${book.readProgress > 0 ? `<div class="card-read-progress"><div class="read-progress-bar" role="progressbar" aria-valuenow="${Math.round(book.readProgress)}" aria-valuemin="0" aria-valuemax="100"><div class="read-progress-fill" style="width:${Math.round(book.readProgress)}%"></div></div><span class="read-progress-label">${Math.round(book.readProgress)}%</span></div>` : ''}
            ${cardDl ? `<div class="card-actions">${cardDl}</div>` : ''}
          </div>
        </article>`;
        setCachedCardHtml(cacheKey, html);
        return html;
      }).join('')}
    </div>`;
}

export function renderFavoriteBookGrid(items = [], { batchSelect = false, user = null, readBookIds = null } = {}) {
  const uniqueItems = uniqueBooksById(items);
  const batchCb = (book) =>
    batchSelect
      ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} data-batch-book-id="${escapeHtml(book.id)}" aria-label="${escapeHtml(t('batch.selectAria'))}"></label>`
      : '';
  const readBadge = (book) => readBookIds && readBookIds.has(book.id) ? `<span class="read-badge">${READ_CHECK_SVG}</span>` : '';
  return `
    <div class="grid">
      ${uniqueItems.map((book) => `
        <article class="card" data-book-id="${escapeHtml(book.id)}">
          ${batchCb(book)}
          <a class="cover" href="/book/${encodeURIComponent(book.id)}" data-role="cover">
            <img class="cover-image is-loaded" loading="lazy" draggable="false" src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" data-cover-src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" alt="${escapeHtml(book.title)}">
            <span class="cover-fallback" hidden>
              <img class="cover-fallback-image" draggable="false" src="/book-fallback.png" alt="">
              <span class="cover-fallback-overlay"></span>
              <span class="cover-fallback-copy">
                <span class="cover-fallback-title">${escapeHtml(book.title)}</span>
                <span class="cover-fallback-author">${escapeHtml(formatAuthorLabel(book.authors) || t('book.authorUnknown'))}</span>
              </span>
            </span>
            ${readBadge(book)}
          </a>
          <div class="meta">
            <h3><a href="/book/${encodeURIComponent(book.id)}">${escapeHtml(book.title)}</a></h3>
            <div class="author">${book.authors ? `<a href="/facet/authors/${encodeURIComponent(book.authorsList?.[0] || firstAuthorValue(book.authors))}">${escapeHtml(formatAuthorLabel(book.authors))}</a>` : escapeHtml(t('book.authorUnknown'))}</div>
            ${book.series ? `<div class="card-series"><a href="/facet/series/${encodeURIComponent(book.series)}">${escapeHtml(book.series)}${book.seriesNo ? ` #${escapeHtml(book.seriesNo)}` : ''}</a></div>` : ''}
            <div class="card-actions card-actions-favorites">
              ${batchSelect ? '' : renderDownloadMenu(book, { compact: true, user })}
              <button class="button card-remove-favorite-action" type="button" data-bookmark-button="${escapeHtml(book.id)}">${escapeHtml(t('book.remove'))}</button>
            </div>
          </div>
        </article>
      `).join('')}
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
  return `
    <div class="table-list entity-list">
      ${items.map((item) => `
        <a class="table-row table-row-link" href="${facetBasePath}/${encodeURIComponent(item.name)}">
          <div style="display:flex;align-items:center">
            <span><strong>${escapeHtml(item.displayName || item.name)}</strong><br>
            <span class="muted">${countLabel('book', item.bookCount)} ${escapeHtml(t('entity.inLibrary'))}</span></span>
            ${seriesBadge(item.name)}
          </div>
        </a>
      `).join('')}
    </div>`;
}

/** Список серий на странице автора (как в разделе «Серии», счётчик — книги этого автора в серии). */
export function renderAuthorFacetSeriesList(series = [], outsideSeries = null, readSeriesNames = null) {
  if (!series.length && !outsideSeries) {
    return '';
  }
  const seriesBadge = (name) => readSeriesNames && readSeriesNames.has(name) ? `<span class="read-series-badge">${READ_CHECK_SVG}</span>` : '';
  const outsideRow = outsideSeries && outsideSeries.href
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
        <a class="table-row table-row-link" href="/facet/series/${encodeURIComponent(s.name)}">
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
            ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} data-batch-book-id="${id}" aria-label="${escapeHtml(t('batch.selectAria'))}"></label>`
            : '';
          return `
        <div class="author-facet-standalone-row" data-book-id="${id}">
          ${batchCb}
          <a class="table-row-stack table-row-link compact-row author-facet-standalone-link" href="/book/${id}">
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
          <a class="table-row table-row-stack table-row-link compact-row" href="/book/${encodeURIComponent(item.id)}">
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

export function renderHomeShelf({ title, href, items, type = 'books', facetBasePath = '', isAuthenticated = false, showBatch = false, user = null, readBookIds = null } = {}) {
  const batchToolbar = '';
  const body = type === 'books'
    ? (items.length
        ? renderBookGrid(items, { isAuthenticated, batchSelect: Boolean(batchToolbar), user, readBookIds })
        : renderEmptyState({ title: t('home.shelfEmptyTitle'), text: t('home.shelfEmptyText') }))
    : renderEntityGrid(items, facetBasePath, t('home.entityEmpty'));
  const wrapped = batchToolbar ? `<div class="batch-select-scope">${batchToolbar}${body}</div>` : body;
  return `
    <section class="library-shelf">
      <div class="section-title">
        <h2>${escapeHtml(title)}</h2>
        ${href ? `<div class="actions"><a class="shelf-link" href="${href}">${escapeHtml(t('home.showAll'))}</a></div>` : ''}
      </div>
      ${wrapped}
    </section>`;
}

function renderUserSidebar({ query = '', field = 'all', stats, user = null, currentPath = '/' }) {
  return `
    <aside class="sidebar" aria-label="${escapeHtml(t('aria.sidebar'))}">
      <div class="brand">
        <a href="/" class="brand-home-link" title="${escapeHtml(t('nav.home'))}">
          <img src="/logo.png" alt="" class="brand-logo" onerror="this.style.display='none'">
          <h2>${escapeHtml(siteTitleForDisplay())}</h2>
        </a>
      </div>
      ${renderSidebarNavigation(user, currentPath, stats)}
    </aside>
    <div class="sidebar-overlay" data-sidebar-overlay></div>`;
}

function renderAdminSidebar(currentPath = '/admin') {
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
            <img src="/logo.png" alt="" class="brand-logo" onerror="this.style.display='none'">
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
          ${link('/admin/events', t('admin.nav.events'))}
          ${link('/admin/update', t('admin.nav.backup'))}
        </div>
      </div>
      <div class="admin-sidebar-footer">
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
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${csrfToken ? `<meta name="csrf-token" content="${escapeHtml(csrfToken)}">` : ''}
  <title>${title !== siteDisplay ? escapeHtml(siteDisplay) + ' \u2014 ' + escapeHtml(title) : escapeHtml(title)}</title>
  <script>
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
  </script>
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#1a1a2e">
  <link rel="apple-touch-icon" href="/favicon-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/${CSS_ASSET_FILE}?v=${STATIC_ASSET_VERSION}">
  <style>
    .spinner{display:block;width:36px;height:36px;border:4px solid rgba(255,255,255,.15);border-top-color:var(--accent-hover,#a1671b);border-radius:50%;animation:spin .7s linear infinite;}
    html[data-theme="light"] .spinner{border-color:rgba(0,0,0,.12);border-top-color:var(--accent-hover,#a1671b);}
    @keyframes spin{to{transform:rotate(360deg);}}
    .nav-progress{position:fixed;top:0;left:0;height:3px;width:0;background:var(--accent-hover,#a1671b);z-index:99999;opacity:0;pointer-events:none;transition:opacity .15s;}
    .nav-progress.active{opacity:1;animation:nav-grow 12s cubic-bezier(.08,.4,.2,1) forwards;}
    @keyframes nav-grow{0%{width:0}15%{width:35%}40%{width:65%}65%{width:82%}100%{width:97%}}
  </style>
</head>
<body data-download-allowed="${canDownloadInUi(user) ? '1' : '0'}">
  <div class="nav-progress" id="nav-progress"></div>
  <script>!function(){var b=document.getElementById('nav-progress');document.addEventListener('click',function(e){var a=e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');if(!h||h.charAt(0)==='#'||a.target==='_blank'||e.ctrlKey||e.metaKey||e.shiftKey)return;b.classList.add('active')});document.addEventListener('submit',function(){b.classList.add('active')})}()</script>
  <script type="application/json" id="ui-i18n-json">${serializeClientI18n()}</script>
  ${readBookIds && readBookIds.size ? `<script type="application/json" id="ui-read-ids">${JSON.stringify([...readBookIds])}</script>` : ''}
  <a class="skip-to-content" href="#main-content">${escapeHtml(t('skipToContent'))}</a>
  <div class="shell">
    ${isAdmin ? renderAdminSidebar(currentPath) : renderUserSidebar({ query, field, stats, user, currentPath })}
    <div class="main-wrap">
      <header class="topbar ${isAdmin ? 'topbar-admin' : ''}">
        ${isAdmin
          ? `<button class="sidebar-toggle" type="button" aria-label="${escapeHtml(t('sidebarOpen'))}" data-sidebar-toggle>☰</button>`
          : `<button class="sidebar-toggle" type="button" aria-label="${escapeHtml(t('sidebarOpen'))}" data-sidebar-toggle>☰</button><div class="topbar-main">${renderTopbarSearch(query, field)}</div>`}
        <div class="topbar-right">
          <span class="topbar-lang" aria-label="${escapeHtml(t('aria.langSwitch'))}">
            <a href="/set-lang?lang=ru" class="topbar-lang-link${getLocale() === 'ru' ? ' is-active' : ''}" hreflang="ru">${escapeHtml(t('nav.langRu'))}</a>
            <span class="muted">·</span>
            <a href="/set-lang?lang=en" class="topbar-lang-link${getLocale() === 'en' ? ' is-active' : ''}" hreflang="en">${escapeHtml(t('nav.langEn'))}</a>
          </span>
          <button type="button" class="theme-toggle" data-theme-toggle aria-label="${escapeHtml(t('themeToggle'))}" title="${escapeHtml(t('themeToggle'))}"><span data-theme-toggle-label>☀</span></button>
          ${!isAdmin ? `${canAccessAdmin ? `<a class="button" href="/admin">${escapeHtml(t('nav.admin'))}</a>` : ''}` : `<a class="button" href="/">${escapeHtml(t('nav.library'))}</a>`}
          ${isAuthenticated ? `<a class="button" href="/profile">${escapeHtml(userLabel)}</a><form method="post" action="/logout" style="display:inline">${csrfHiddenField(csrfToken)}<button type="submit" class="button">${escapeHtml(t('nav.logout'))}</button></form>` : `<a class="button" href="/login">${escapeHtml(t('nav.login'))}</a>`}
        </div>
      </header>
    ${isAdmin ? renderAdminIndexControls(indexStatus) : renderIndexStatus(indexStatus, stats)}
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}
    ${renderBreadcrumbs(breadcrumbs)}
    <div class="layout">
      <main id="main-content" class="panel">${content}</main>
    </div>
    </div>
  </div>
  <button class="scroll-to-top" type="button" data-scroll-top aria-label="${escapeHtml(t('scrollTop'))}">↑</button>
  <script src="/${APP_ASSET_FILE}?v=${STATIC_ASSET_VERSION}" defer></script>
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

export function renderLoginScreen({ title, subtitle, action, error = '', extraHtml = '', hideForm = false, submitLabel, passwordAutocomplete = 'current-password', captchaHtml = '', headExtra = '' }) {
  const submit = submitLabel || t('login.submit');
  const htmlLang = getLocale() === 'en' ? 'en' : 'ru';
  const siteDisplay = siteTitleForDisplay();
  return `<!doctype html>
<html lang="${htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(siteDisplay)} \u2014 ${escapeHtml(title)}</title>
  <script>
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
  </script>
  <link rel="icon" href="/favicon.png" type="image/png">
  <link rel="stylesheet" href="/${CSS_ASSET_FILE}?v=${STATIC_ASSET_VERSION}">
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
      <div class="brand" style="margin-bottom:20px;">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      ${error ? renderAlert('error', escapeHtml(error)) : ''}
      ${hideForm ? '' : `<div class="vertical-form">
        <div>
          <label for="username">${escapeHtml(t('login.username'))}</label>
          <input id="username" name="username" autocomplete="username">
        </div>
        <div>
          <label for="password">${escapeHtml(t('login.password'))}</label>
          <input id="password" type="password" name="password" autocomplete="${passwordAutocomplete}">
        </div>
        ${captchaHtml}
        <button type="submit">${escapeHtml(submit)}</button>
      </div>`}
      ${extraHtml}
    </${hideForm ? 'div' : 'form'}>
  </div>
</body>
</html>`;
}
