/**
 * Lightweight COPS-style UI at /lite/* for e-ink readers.
 */
import {
  escapeHtml,
  formatLocaleInt,
  formatLocaleDateLong,
  downloadBookPath,
  apiBookPath,
  batchScopeDownloadPath,
  canDownloadInUi,
  formatAuthorLabel,
  formatGenreLabel,
  formatLanguageLabel,
  getAvailableDownloadFormats,
  FORMAT_LABELS,
  siteTitleForDisplay,
  renderSiteLogoImg,
  STATIC_ASSET_VERSION,
  renderFaviconLinks,
  renderPagination,
  parseGenreCodes,
  csrfHiddenField,
  liteBookPagePath,
  liteReadPagePath,
  t,
  tp,
  plural
} from './shared.js';
import { getLocale } from '../i18n.js';

export const LITE_BASE = '/lite';

export function litePath(subpath = '') {
  if (!subpath || subpath === '/') return `${LITE_BASE}/`;
  const p = subpath.startsWith('/') ? subpath : `/${subpath}`;
  return `${LITE_BASE}${p}`;
}

function canOpenInReader(ext) {
  const raw = String(ext || 'fb2').toLowerCase().replace(/^\./, '');
  const e = raw.replace(/\.zip$/, '');
  if (e === 'pdf' || e === 'djvu' || e === 'djv') return true;
  return ['fb2', 'fbz', 'epub', 'mobi', 'azw3', 'kf8', 'cbz'].includes(e);
}

function liteCssHref() {
  return `/lite.css?v=${STATIC_ASSET_VERSION}`;
}

function liteLangSwitch() {
  const current = getLocale() === 'en' ? 'en' : 'ru';
  const link = (lang, label) => (lang === current
    ? `<span class="lite-lang-current" aria-current="true">${label}</span>`
    : `<a class="lite-lang-link" href="/set-lang?lang=${lang}">${label}</a>`);
  return `<span class="lite-lang">${link('ru', 'RU')}<span class="lite-lang-sep">/</span>${link('en', 'EN')}</span>`;
}

function liteFooter(user, csrfToken = '') {
  const sep = '<span class="lite-footer-sep">·</span>';
  const lang = liteLangSwitch();
  if (user) {
    const profileLink = `<a href="${litePath('profile')}">${escapeHtml(user.username)}</a>`;
    const logout = `<form class="lite-logout-form" method="post" action="${litePath('logout')}">${csrfHiddenField(csrfToken)}<button type="submit" class="lite-logout-btn">${escapeHtml(t('nav.logout'))}</button></form>`;
    return `${profileLink}${sep}${logout}${sep}${lang}`;
  }
  return `<a href="${litePath('login')}">${escapeHtml(t('nav.login'))}</a>${sep}${lang}`;
}

export function litePageShell({
  title,
  content,
  user = null,
  csrfToken = '',
  backHref = litePath('/'),
  headerSearch = true,
  headerBrand = 'title'
}) {
  const htmlLang = getLocale() === 'en' ? 'en' : 'ru';
  const siteDisplay = siteTitleForDisplay();
  const pageTitle = title !== siteDisplay ? `${siteDisplay} — ${title}` : title;
  const backLabel = escapeHtml(t('reader.back'));
  /* Кнопка «Назад»: history.back() как основной путь (мгновенно на e-ink),
     href — запасной вариант на случай прямого открытия страницы без истории. */
  const backBtn = backHref
    ? `<a class="lite-icon-btn lite-back-btn" href="${backHref}" onclick="if(window.history.length>1){window.history.back();return false}" title="${backLabel}" aria-label="${backLabel}">←</a>`
    : '';
  const searchBtn = headerSearch
    ? `<a class="lite-icon-btn" href="${litePath('catalog')}" title="${escapeHtml(t('catalog.title'))}" aria-label="${escapeHtml(t('catalog.title'))}">⌕</a>`
    : '';
  const liteLogo = headerBrand === 'logo' ? renderSiteLogoImg('lite-header-logo') : '';
  const headerCenter = liteLogo
    ? `<a class="lite-header-brand" href="${litePath('/')}" title="${escapeHtml(siteDisplay)}" aria-label="${escapeHtml(siteDisplay)}">${liteLogo}</a>`
    : `<h1 class="lite-header-title">${escapeHtml(title)}</h1>`;
  return `<!doctype html>
<html lang="${htmlLang}" data-theme="light" data-lite="1">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  ${renderFaviconLinks()}
  <link rel="stylesheet" href="${liteCssHref()}">
</head>
<body class="lite-body" data-download-allowed="${canDownloadInUi(user) ? '1' : '0'}">
  <header class="lite-header">
    <div class="lite-header-nav">
      ${backBtn}
      <a class="lite-icon-btn" href="${litePath('/')}" title="${escapeHtml(t('nav.home'))}" aria-label="${escapeHtml(t('nav.home'))}">⌂</a>
    </div>
    ${headerCenter}
    ${searchBtn}
  </header>
  <main class="lite-main">${content}</main>
  <footer class="lite-footer">${liteFooter(user, csrfToken)}</footer>
</body>
</html>`;
}

export function renderLiteLogin({ error = '', csrfToken = '' }) {
  const htmlLang = getLocale() === 'en' ? 'en' : 'ru';
  const siteDisplay = siteTitleForDisplay();
  const content = `
    <form class="lite-login" method="post" action="${litePath('login')}">
      ${csrfHiddenField(csrfToken)}
      ${error ? `<p class="lite-login-error">${escapeHtml(error)}</p>` : ''}
      <label class="lite-login-label" for="lite-username">${escapeHtml(t('login.username'))}</label>
      <input class="lite-login-input" id="lite-username" name="username" type="text" autocomplete="username">
      <label class="lite-login-label" for="lite-password">${escapeHtml(t('login.password'))}</label>
      <input class="lite-login-input" id="lite-password" name="password" type="password" autocomplete="current-password">
      <button class="lite-login-submit" type="submit">${escapeHtml(t('login.submit'))}</button>
    </form>`;
  return `<!doctype html>
<html lang="${htmlLang}" data-theme="light" data-lite="1">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(siteDisplay)} — ${escapeHtml(t('login.title'))}</title>
  ${renderFaviconLinks()}
  <link rel="stylesheet" href="${liteCssHref()}">
</head>
<body class="lite-body">
  <main class="lite-main lite-main--login">
    <h1 class="lite-login-title">${escapeHtml(t('login.title'))}</h1>
    <p class="lite-hint">${escapeHtml(t('lite.loginSubtitle'))}</p>
    ${content}
    <p class="lite-login-lang">${liteLangSwitch()}</p>
  </main>
</body>
</html>`;
}

function renderLiteEntityRow(href, name, trailing = '', { badge = true } = {}) {
  let trailingHtml = '<span class="lite-row-chevron" aria-hidden="true">›</span>';
  if (trailing) {
    trailingHtml = badge
      ? `<span class="lite-entity-badge">${trailing}</span>`
      : `<span class="lite-entity-sub">${trailing}</span>`;
  }
  return `<a class="lite-entity-row" href="${href}">
    <span class="lite-entity-name">${escapeHtml(name)}</span>
    ${trailingHtml}
  </a>`;
}

function renderLiteEntityCountRow(href, name, count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const badge = `${formatLocaleInt(n)} ${escapeHtml(plural('book', n))}`;
  return renderLiteEntityRow(href, name, badge);
}

function renderLiteMenuRow(href, label, hint) {
  return `<a class="lite-menu-row" href="${href}">
    <span class="lite-menu-body">
      <span class="lite-menu-label">${escapeHtml(label)}</span>
      <span class="lite-menu-hint">${escapeHtml(hint)}</span>
    </span>
    <span class="lite-row-chevron" aria-hidden="true">›</span>
  </a>`;
}

export function renderLiteHome({ stats, user, csrfToken = '', homeSubtitle = '' }) {
  const nAuthors = formatLocaleInt(stats?.totalAuthors || 0);
  const nSeries = formatLocaleInt(stats?.totalSeries || 0);
  const nGenres = formatLocaleInt(stats?.totalGenres || 0);
  const subtitleText = homeSubtitle === '-' ? '' : (homeSubtitle || t('home.subtitle'));
  const content = `
    <section class="lite-hero">
      <h2 class="lite-hero-title">${escapeHtml(siteTitleForDisplay())}</h2>
      ${subtitleText ? `<p class="lite-hero-subtitle">${escapeHtml(subtitleText)}</p>` : ''}
    </section>
    <nav class="lite-menu" aria-label="${escapeHtml(t('nav.home'))}">
      ${renderLiteMenuRow(litePath('authors'), t('nav.authors'), tp('lite.menuAuthors', { n: nAuthors }))}
      ${renderLiteMenuRow(litePath('series'), t('nav.series'), tp('lite.menuSeries', { n: nSeries }))}
      ${renderLiteMenuRow(litePath('genres'), t('nav.genres'), tp('lite.menuGenres', { n: nGenres }))}
      ${renderLiteMenuRow(litePath('library/recent'), t('nav.recent'), t('lite.menuRecent'))}
      ${user ? renderLiteMenuRow(litePath('profile'), t('nav.profile'), user.username) : ''}
    </nav>`;
  return litePageShell({ title: siteTitleForDisplay(), content, user, csrfToken, backHref: '', headerBrand: 'logo' });
}

function formatBookSizeKb(size) {
  const n = Number(size) || 0;
  if (n <= 0) return '';
  return `${(n / 1024).toFixed(2)} kB`;
}

function renderLiteDownloadCell(book, user) {
  if (!canDownloadInUi(user)) return '';
  const formats = getAvailableDownloadFormats(book);
  if (!formats.length) return '';
  const links = formats.slice(0, 4).map((f) => {
    const label = FORMAT_LABELS[f] || String(f).toUpperCase();
    return `<a class="lite-dl-btn" href="${downloadBookPath(book.id, `format=${encodeURIComponent(f)}`)}">${escapeHtml(label)}</a>`;
  }).join('');
  const size = formatBookSizeKb(book.size);
  return `<div class="lite-book-dl">${links}${size ? `<span class="lite-book-size">${escapeHtml(size)}</span>` : ''}</div>`;
}

export function renderLiteBookRow(book, user, { readMark = false } = {}) {
  const title = book.title || t('opds.noTitle');
  const dateSuffix = book.date ? ` (${escapeHtml(String(book.date).slice(0, 10))})` : '';
  const authors = formatAuthorLabel(book.authors) || t('book.authorUnknown');
  const genres = book.genres
    ? parseGenreCodes(book.genres).slice(0, 4).map((c) => formatGenreLabel(c)).join(', ')
    : '';
  const series = book.seriesList?.length
    ? book.seriesList.map((s) => `${s.displayName || s.name}${s.seriesNo ? ` (${s.seriesNo})` : ''}`).join(', ')
    : book.series || '';
  const bookHref = liteBookPagePath(book.id);
  return `<a class="lite-book-row" href="${bookHref}">
    <span class="lite-book-cover">
      <img src="${apiBookPath(book.id, 'cover-thumb')}" alt="" loading="lazy" width="72" height="108">
    </span>
    <span class="lite-book-body">
      <span class="lite-book-title"><strong>${escapeHtml(title)}</strong>${Number(book.deleted) ? ` <span class="deleted-badge deleted-badge--inline">${escapeHtml(t('book.deletedBadge'))}</span>` : ''}${dateSuffix}</span>
      <span class="lite-book-meta"><span class="lite-meta-k">${escapeHtml(t('lite.metaAuthors'))}</span> ${escapeHtml(authors)}</span>
      ${genres ? `<span class="lite-book-meta"><span class="lite-meta-k">${escapeHtml(t('lite.metaGenres'))}</span> ${escapeHtml(genres)}</span>` : ''}
      ${series ? `<span class="lite-book-meta"><span class="lite-meta-k">${escapeHtml(t('lite.metaSeries'))}</span> ${escapeHtml(series)}</span>` : ''}
      ${readMark ? `<span class="lite-book-meta lite-book-read">${escapeHtml(t('book.markedRead'))}</span>` : ''}
    </span>
    <span class="lite-row-chevron" aria-hidden="true">›</span>
  </a>`;
}

function renderLiteSearchForm({ action, query = '', field = 'books', sort = 'recent', extraHidden = {} }) {
  const fields = [
    ['books', t('search.books')],
    ['authors', t('search.authors')],
    ['series', t('search.series')]
  ];
  const sorts = [
    ['recent', t('sort.recentFirst')],
    ['title', t('sort.byTitle')],
    ['author', t('sort.byAuthor')],
    ['series', t('sort.bySeries')],
    ['rating', t('sort.byRating')],
    ['count', t('sort.byBookCount')],
    ['name', t('sort.byName')]
  ];
  const hidden = Object.entries(extraHidden)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
    .join('');
  return `<form class="lite-search" action="${escapeHtml(action)}" method="get">
    <div class="lite-search-row">
      <input class="lite-search-input" type="search" name="q" value="${escapeHtml(query || '')}" placeholder="${escapeHtml(t('search.placeholder'))}">
      <button class="lite-search-btn" type="submit" aria-label="${escapeHtml(t('browse.submit'))}">⌕</button>
    </div>
    <div class="lite-search-filters">
      <label class="lite-filter">
        <span class="lite-filter-label">${escapeHtml(t('lite.filterField'))}</span>
        <select name="field">${fields.map(([v, l]) => `<option value="${escapeHtml(v)}"${field === v ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
      </label>
      <label class="lite-filter">
        <span class="lite-filter-label">${escapeHtml(t('lite.filterSort'))}</span>
        <select name="sort">${sorts.map(([v, l]) => `<option value="${escapeHtml(v)}"${sort === v ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
      </label>
    </div>
    ${hidden}
  </form>`;
}

function liteFacetHref(browsePath, name) {
  if (browsePath.endsWith('/authors')) return `${LITE_BASE}/facet/authors/${encodeURIComponent(name)}`;
  if (browsePath.endsWith('/series')) return `${LITE_BASE}/facet/series/${encodeURIComponent(name)}`;
  if (browsePath.endsWith('/genres')) return `${LITE_BASE}/facet/genres/${encodeURIComponent(name)}`;
  return `${LITE_BASE}/facet/authors/${encodeURIComponent(name)}`;
}

export function renderLiteCatalog({
  items, total, page, pageSize, query, field, sort, letter = '', user, readBookIds = null, csrfToken = ''
}) {
  const isBookField = field === 'books';
  const letterParam = letter ? `&letter=${encodeURIComponent(letter)}` : '';
  const paginationBase = `${litePath('catalog')}?field=${encodeURIComponent(field)}&sort=${encodeURIComponent(sort)}${letterParam}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  let body = '';
  if (!query && !letter && field === 'books') {
    body = `<p class="lite-hint">${escapeHtml(t('lite.catalogHint'))}</p>`;
  } else if (!items.length) {
    body = `<p class="lite-empty">${escapeHtml(t('catalog.emptyText'))}</p>`;
  } else if (isBookField) {
    const readSet = readBookIds || new Set();
    body = `<div class="lite-book-list">${items.map((b) => renderLiteBookRow(b, user, { readMark: readSet.has(b.id) })).join('')}</div>`;
  } else {
    const facetKind = field === 'authors' ? 'authors' : 'series';
    body = `<div class="lite-entity-list">${items.map((it) => {
      const name = it.name || it.displayName || it.title || '';
      const count = it.count ?? it.bookCount ?? 0;
      return renderLiteEntityCountRow(`${LITE_BASE}/facet/${facetKind}/${encodeURIComponent(name)}`, name, count);
    }).join('')}</div>`;
  }
  const totalLine = query || field !== 'books'
    ? `<p class="lite-hint">${escapeHtml(t('browse.total'))}: <strong>${formatLocaleInt(total)}</strong></p>`
    : '';
  const content = `
    ${renderLiteSearchForm({ action: litePath('catalog'), query, field, sort, extraHidden: letter ? { letter } : {} })}
    ${totalLine}
    ${body}
    ${renderPagination(paginationBase, page, pageSize, total, query)}`;
  return litePageShell({ title: t('catalog.title'), content, user, csrfToken, headerSearch: false });
}

export function renderLiteBrowsePage({
  title, items, total, page, pageSize, query, path, sort, user, genreGroups = null, csrfToken = ''
}) {
  const paginationBase = `${path}?sort=${encodeURIComponent(sort || 'count')}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  let list = '';
  if (genreGroups?.length) {
    const flat = genreGroups.flatMap((g) => g.items || []);
    list = `<div class="lite-entity-list">${flat.map((it) => {
      const name = it.name || it.displayName || '';
      const count = it.bookCount ?? it.count ?? 0;
      return renderLiteEntityCountRow(`${LITE_BASE}/facet/genres/${encodeURIComponent(name)}`, it.displayName || name, count);
    }).join('')}</div>`;
  } else {
    list = `<div class="lite-entity-list">${items.map((it) => {
      const name = it.name || it.displayName || '';
      const count = it.count ?? it.bookCount ?? 0;
      return renderLiteEntityCountRow(liteFacetHref(path, name), name, count);
    }).join('')}</div>`;
  }
  const content = `
    <form class="lite-search lite-search--compact" action="${path}" method="get">
      <div class="lite-search-row">
        <input class="lite-search-input" type="search" name="q" value="${escapeHtml(query || '')}" placeholder="${escapeHtml(t('browse.placeholder'))}">
        <button class="lite-search-btn" type="submit">⌕</button>
      </div>
      <input type="hidden" name="sort" value="${escapeHtml(sort || 'count')}">
    </form>
    <p class="lite-hint">${escapeHtml(browseTotalLite(path, total, query))}</p>
    ${list}
    ${genreGroups ? '' : renderPagination(paginationBase, page, pageSize, total, query)}`;
  return litePageShell({ title, content, user, csrfToken, headerSearch: false });
}

function browseTotalLite(path, total, query) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const num = formatLocaleInt(n);
  let kind = plural('book', n);
  if (path.endsWith('/authors')) kind = plural('author', n);
  else if (path.endsWith('/series')) kind = plural('series', n);
  else if (path.endsWith('/genres')) kind = plural('genre', n);
  const filter = query ? ` · ${t('browse.filter')}: ${query}` : '';
  return `${t('browse.total')}: ${num} ${kind}${filter}`;
}

function renderLiteScopeDownload(user, scope) {
  if (!scope || !canDownloadInUi(user) || !(Number(scope.total) > 0)) return '';
  const href = batchScopeDownloadPath({ facet: scope.facet, value: scope.value, format: 'fb2' });
  return `<p class="lite-hint"><a class="lite-dl-btn" href="${escapeHtml(href)}" download>${escapeHtml(t('download.all'))}</a></p>`;
}

export function renderLiteBookListPage({
  title, items, total, page, pageSize, user, paginationBase, readBookIds = null, hint = '', csrfToken = '', scopeDownload = null
}) {
  const readSet = readBookIds || new Set();
  const content = `
    ${hint ? `<p class="lite-hint">${escapeHtml(hint)}</p>` : ''}
    ${renderLiteScopeDownload(user, scopeDownload ? { ...scopeDownload, total } : null)}
    <p class="lite-hint">${escapeHtml(t('browse.total'))}: <strong>${formatLocaleInt(total)}</strong></p>
    <div class="lite-book-list">${items.map((b) => renderLiteBookRow(b, user, { readMark: readSet.has(b.id) })).join('')}</div>
    ${renderPagination(paginationBase, page, pageSize, total)}`;
  return litePageShell({ title, content, user, csrfToken });
}

export function renderLiteAuthorFacetPage({
  title, displayName, series = [], standaloneBooks = [], facetValue = '', user, csrfToken = '', total = 0
}) {
  const authorParam = facetValue ? `?author=${encodeURIComponent(facetValue)}` : '';
  const liteSeriesRows = (list) => list.map((s) => {
    const count = s.bookCount ?? s.count ?? 0;
    return renderLiteEntityCountRow(`${LITE_BASE}/facet/series/${encodeURIComponent(s.name)}${authorParam}`, s.displayName || s.name, count);
  }).join('');
  const seriesRows = liteSeriesRows(series.filter((s) => s.authorSeries !== false));
  const sharedRows = liteSeriesRows(series.filter((s) => s.authorSeries === false));
  const bookRows = standaloneBooks.map((b) => renderLiteBookRow(b, user)).join('');
  const bookTotal = Number(total) || series.reduce((n, s) => n + (Number(s.bookCount) || 0), 0) + standaloneBooks.length;
  const content = `
    ${renderLiteScopeDownload(user, facetValue ? { facet: 'authors', value: facetValue, total: bookTotal } : null)}
    ${seriesRows ? `<div class="lite-entity-list">${seriesRows}</div>` : ''}
    ${bookRows ? `<div class="lite-book-list">${bookRows}</div>` : ''}
    ${sharedRows ? `<p class="lite-hint">${escapeHtml(t('authorPage.sharedSeries'))}</p><div class="lite-entity-list">${sharedRows}</div>` : ''}
    ${!seriesRows && !bookRows && !sharedRows ? `<p class="lite-empty">${escapeHtml(t('browse.empty'))}</p>` : ''}`;
  return litePageShell({ title: displayName || title, content, user, csrfToken });
}

// Ссылка для возврата на главную страницу кабинета.
const liteProfileHome = () => litePath('profile');

// Числовая подсказка для пункта меню: «N книг», «N серий» и т.д.
function liteCountHint(n, type) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return `${formatLocaleInt(v)} ${plural(type, v)}`;
}

// Шапка кабинета: имя, роль, дата регистрации (только на главной кабинета).
function liteProfileHeader(user, userStats) {
  const roleLabel = user.role === 'admin' ? t('profile.admin') : t('profile.user');
  const memberSince = userStats?.createdAt
    ? tp('profile.memberSince', { date: formatLocaleDateLong(userStats.createdAt) })
    : '';
  return `<header class="lite-profile-identity">
    <span class="lite-profile-name">${escapeHtml(user.username)}</span>
    <span class="lite-profile-role">${escapeHtml(roleLabel)}</span>
    ${memberSince ? `<span class="lite-profile-since">${escapeHtml(memberSince)}</span>` : ''}
  </header>`;
}

// Главная кабинета — меню-список разделов (как на домашней странице), каждое ведёт в своё окно.
export function renderLiteProfileMenu({ user, userStats = {}, csrfToken = '' }) {
  const favBase = litePath('profile/favorites');
  const content = `
    ${liteProfileHeader(user, userStats)}
    <nav class="lite-menu" aria-label="${escapeHtml(t('profile.title'))}">
      ${renderLiteMenuRow(litePath('profile/activity'), t('profile.tabActivity'), liteCountHint(userStats.readingCount, 'book'))}
      ${renderLiteMenuRow(`${favBase}?view=books`, t('favorites.books'), liteCountHint(userStats.bookmarkCount, 'book'))}
      ${renderLiteMenuRow(`${favBase}?view=series`, t('favorites.series'), liteCountHint(userStats.favoriteSeriesCount, 'series'))}
      ${renderLiteMenuRow(`${favBase}?view=authors`, t('favorites.authors'), liteCountHint(userStats.favoriteAuthorsCount, 'author'))}
      ${renderLiteMenuRow(litePath('profile/shelves'), t('nav.shelves'), liteCountHint(userStats.shelvesCount, 'shelf'))}
      ${renderLiteMenuRow(litePath('profile/read'), t('profile.readBooks'), liteCountHint(userStats.readBooksCount, 'book'))}
      ${renderLiteMenuRow(litePath('profile/settings'), t('profile.tabSettings'), t('profile.ereaderEmail'))}
    </nav>`;
  return litePageShell({ title: t('profile.title'), content, user, csrfToken });
}

// Список избранных авторов/серий (lite-entity-row + ссылка на фасет).
function liteFavoriteEntityList(items, facetKind) {
  if (!items.length) return `<p class="lite-empty">${escapeHtml(t('profile.nothingYet'))}</p>`;
  const rows = items.map((it) => {
    const count = it.bookCount ?? it.count ?? 0;
    return renderLiteEntityCountRow(`${LITE_BASE}/facet/${facetKind}/${encodeURIComponent(it.name)}`, it.displayName || it.name, count);
  }).join('');
  return `<div class="lite-entity-list">${rows}</div>`;
}

function liteBookListOrEmpty(books, user, readBookIds = null, forceRead = false) {
  if (!books.length) return `<p class="lite-empty">${escapeHtml(t('profile.nothingYet'))}</p>`;
  const readSet = readBookIds || new Set();
  return `<div class="lite-book-list">${books.map((b) => renderLiteBookRow(b, user, { readMark: forceRead || readSet.has(b.id) })).join('')}</div>`;
}

export function renderLiteProfileActivity({ user, recentBooks = [], readerBookmarks = [], csrfToken = '' }) {
  const bmList = readerBookmarks.length
    ? `<div class="lite-entity-list">${readerBookmarks.map((bm) => {
        const sub = bm.bookTitle && bm.label && bm.bookTitle !== bm.label ? bm.bookTitle : '';
        return renderLiteEntityRow(
          `${liteReadPagePath(bm.bookId)}?pos=${encodeURIComponent(bm.position)}`,
          bm.label || bm.bookTitle || '',
          sub ? escapeHtml(sub) : '',
          { badge: false }
        );
      }).join('')}</div>`
    : `<p class="lite-empty">${escapeHtml(t('profile.noBookmarks'))}</p>`;
  const content = `
    <h2 class="lite-profile-heading">${escapeHtml(t('profile.reading'))}</h2>
    ${liteBookListOrEmpty(recentBooks, user)}
    <h2 class="lite-profile-heading">${escapeHtml(t('profile.readerBookmarks'))}</h2>
    ${bmList}`;
  return litePageShell({ title: t('profile.tabActivity'), content, user, csrfToken, backHref: liteProfileHome() });
}

export function renderLiteProfileFavorites({ user, view = 'books', books = [], series = [], authors = [], readBookIds = null, csrfToken = '' }) {
  let content;
  let title;
  if (view === 'series') {
    content = liteFavoriteEntityList(series, 'series');
    title = t('favorites.series');
  } else if (view === 'authors') {
    content = liteFavoriteEntityList(authors, 'authors');
    title = t('favorites.authors');
  } else {
    content = liteBookListOrEmpty(books, user, readBookIds);
    title = t('favorites.books');
  }
  return litePageShell({ title, content, user, csrfToken, backHref: liteProfileHome() });
}

export function renderLiteProfileShelves({ user, shelves = [], csrfToken = '' }) {
  const content = shelves.length
    ? `<div class="lite-entity-list">${shelves.map((s) => `
        ${renderLiteEntityCountRow(litePath(`profile/shelf/${s.id}`), s.name, s.bookCount)}`).join('')}</div>`
    : `<p class="lite-empty">${escapeHtml(t('profile.nothingYet'))}</p>`;
  return litePageShell({ title: t('nav.shelves'), content, user, csrfToken, backHref: liteProfileHome() });
}

export function renderLiteShelfDetail({ user, shelf, books = [], readBookIds = null, csrfToken = '' }) {
  const content = liteBookListOrEmpty(books, user, readBookIds);
  return litePageShell({ title: shelf.name, content, user, csrfToken, backHref: litePath('profile/shelves') });
}

export function renderLiteProfileRead({ user, books = [], csrfToken = '' }) {
  const content = liteBookListOrEmpty(books, user, null, true);
  return litePageShell({ title: t('profile.readBooks'), content, user, csrfToken, backHref: liteProfileHome() });
}

export function renderLiteProfileSettings({ user, ereaderEmail = '', ereaderEmailAllowed = true, flash = '', csrfToken = '' }) {
  const emailSection = `
    <section class="lite-profile-section">
      <h2 class="lite-profile-heading">${escapeHtml(t('profile.ereaderEmail'))}</h2>
      ${ereaderEmailAllowed
        ? `<form class="lite-login" method="post" action="${litePath('profile/email')}">
            ${csrfHiddenField(csrfToken)}
            <input class="lite-login-input" type="email" name="ereaderEmail" value="${escapeHtml(ereaderEmail)}" placeholder="kindle@kindle.com">
            <button class="lite-login-submit" type="submit">${escapeHtml(t('profile.save'))}</button>
          </form>`
        : `<p class="lite-hint">${escapeHtml(t('profile.ereaderEmail.accessDenied'))}</p>`
      }
    </section>`;

  const passwordSection = `
    <section class="lite-profile-section">
      <h2 class="lite-profile-heading">${escapeHtml(t('profile.changePassword'))}</h2>
      <p class="lite-hint">${escapeHtml(t('profile.passwordRules'))}</p>
      <form class="lite-login" method="post" action="${litePath('profile/password')}">
        ${csrfHiddenField(csrfToken)}
        <input class="lite-login-input" type="password" name="currentPassword" placeholder="${escapeHtml(t('profile.currentPassword'))}" autocomplete="current-password" required>
        <input class="lite-login-input" type="password" name="newPassword" placeholder="${escapeHtml(t('profile.newPassword'))}" autocomplete="new-password" required>
        <input class="lite-login-input" type="password" name="confirmPassword" placeholder="${escapeHtml(t('profile.confirmPassword'))}" autocomplete="new-password" required>
        <button class="lite-login-submit" type="submit">${escapeHtml(t('profile.changeBtn'))}</button>
      </form>
    </section>`;

  const content = `
    ${flash ? `<p class="lite-profile-flash">${escapeHtml(flash)}</p>` : ''}
    <div class="lite-profile-body">${emailSection}${passwordSection}</div>`;
  return litePageShell({ title: t('profile.tabSettings'), content, user, csrfToken, backHref: liteProfileHome() });
}

export function renderLiteBook({ book, details, user, isRead = false, csrfToken = '' }) {
  const title = book.title || t('opds.noTitle');
  const authors = formatAuthorLabel(book.authors) || t('book.authorUnknown');
  const genres = book.genres
    ? parseGenreCodes(book.genres).slice(0, 6).map((c) => formatGenreLabel(c)).join(', ')
    : '';
  const series = book.seriesList?.length
    ? book.seriesList.map((s) => `${s.displayName || s.name}${s.seriesNo ? ` #${s.seriesNo}` : ''}`).join(', ')
    : book.series || '';
  const lang = book.lang ? formatLanguageLabel(book.lang) : '';
  const annotation = details?.annotationIsHtml
    ? String(details.annotation || '').replace(/<[^>]+>/g, ' ').slice(0, 1200)
    : String(details?.annotation || t('book.noAnnotation')).slice(0, 1200);
  const downloads = renderLiteDownloadCell(book, user);
  const readBtn = canOpenInReader(book.ext)
    ? `<a class="lite-read-btn lite-btn lite-btn-primary" href="${liteReadPagePath(book.id)}">${escapeHtml(t('book.read'))}</a>`
    : '';
  const content = `
    <article class="lite-book-detail">
      <div class="lite-book-detail-head">
        <img class="lite-book-detail-cover" src="${apiBookPath(book.id, 'cover')}" alt="" loading="eager" width="180" height="270">
        <div>
          <h2 class="lite-book-detail-title">${escapeHtml(title)}</h2>
          <div class="lite-book-meta"><span class="lite-meta-k">${escapeHtml(t('lite.metaAuthors'))}</span> ${escapeHtml(authors)}</div>
          ${genres ? `<div class="lite-book-meta"><span class="lite-meta-k">${escapeHtml(t('lite.metaGenres'))}</span> ${escapeHtml(genres)}</div>` : ''}
          ${series ? `<div class="lite-book-meta"><span class="lite-meta-k">${escapeHtml(t('lite.metaSeries'))}</span> ${escapeHtml(series)}</div>` : ''}
          ${lang ? `<div class="lite-book-meta"><span class="lite-meta-k">${escapeHtml(t('lite.metaLang'))}</span> ${escapeHtml(lang)}</div>` : ''}
          ${isRead ? `<div class="lite-book-meta lite-book-read">${escapeHtml(t('book.markedRead'))}</div>` : ''}
        </div>
      </div>
      ${downloads || readBtn ? `<div class="lite-book-detail-actions">${readBtn}${downloads ? `<div class="lite-book-detail-dl">${downloads}</div>` : ''}</div>` : ''}
      <div class="lite-book-annotation">${escapeHtml(annotation)}</div>
    </article>`;
  return litePageShell({ title, content, user, csrfToken });
}
