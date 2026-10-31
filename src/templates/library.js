/**
 * Library template functions: home, catalog, browse, book detail, favorites, shelves, reader, profile.
 */
import {
  escapeHtml, sanitizeHtml, csrfHiddenField, pageShell,
  renderBookGrid, renderFavoriteBookGrid, renderEntityGrid, renderCardCover,
  renderPagination, renderSortControl, renderLangFilterControl, renderEmptyState,
  renderDownloadMenu, renderBatchDownloadToolbar, renderScopeDownloadMenu,
  renderHomeShelf, renderMiniBookList, renderDiscoveryTiles,
  renderStatsRibbon, renderBookMetaList, renderSkeletonGrid,
  renderAuthorFacetSeriesList, renderAuthorFlibustaList, renderBookFlibustaList,
  renderFacetSummaryBlock,
  renderSectionIntro, renderFacetHero, renderAlert, renderFavoritesNav, renderProfileNav, renderAppPairWidget,
  renderListRemoveBtn, bookIdDataAttr, bookCardDataAttrs, batchBookIdDataAttr,
  firstAuthorValue, uniqueBooksById, batchSelectInputAttrs, safeDomIdPart,
  browseTotalLine, canDownloadInUi, canSendToEmailInUi, renderAuthorLinks, renderSeriesLinks, renderWelcomeQuoteAuthor, isWelcomeQuoteAuthorLinkable,
  STATIC_ASSET_VERSION, siteTitleForDisplay, READ_CHECK_SVG, renderFaviconLinks,
  bookPagePath, readPagePath, apiBookPath, liteBookPagePath, liteReadPagePath,
  renderCoverFallbackImage,
  t, tp, getLocale, plural, countLabel, formatLocaleInt,
  formatLocaleDateLong, clientI18nScriptUrl,
  formatAuthorLabel, formatLanguageLabel,
  formatGenreLabel, parseGenreCodes
} from './shared.js';
import { pickHomeWelcomeQuote, getHomeWelcomeQuotePool } from '../home-welcome-quotes.js';
import { encodeBookRef } from '../utils/book-ref.js';
import { getUserHideRead } from '../db.js';
import { normalizeHomeLayout, isHomeSectionVisible, WEB_HOME_SECTION_IDS } from '../home-layout.js';
import { READER_ICONS, READER_THEMES, READER_EINK_UA_RE, readerQuickTile, readerSettingsRow } from './reader-chrome.js';

/** «Скрыть прочитанное»: account switch (also the Android filter sheet), toggled via POST /api/preferences. */
function renderHideReadToggle(user) {
  if (!user?.username) return '';
  const on = getUserHideRead(user.username);
  const label = on ? t('browse.showRead') : t('browse.hideRead');
  const icon = on
    ? '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><path d="M2.5 2.5l11 11"/></svg>'
    : '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  return `<button type="button" class="button view-toggle hide-read-toggle${on ? ' is-active' : ''}" data-hide-read-toggle="${on ? '1' : '0'}" aria-pressed="${on ? 'true' : 'false'}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
}

export function renderHome({ user, stats, indexStatus, history = [], favoriteAuthors = [], favoriteSeries = [], sections = {}, recommendations = [], homeSubtitle = '', csrfToken = '', readBookIds = null, hasContinueData = false, listView = false, homeShelves = [], followingShelf = null, homeLayout = null }) {
  const isAuthenticated = Boolean(user);
  // Profile → view «Главная страница»: order and hidden blocks (guests get the default layout).
  const layout = isAuthenticated && homeLayout ? homeLayout : normalizeHomeLayout('');
  const shown = (id) => isHomeSectionVisible(layout, id);
  const shelfOrder = layout.order.filter((id) => id !== 'continue' && WEB_HOME_SECTION_IDS.includes(id) && shown(id));
  // The grid/list toggle sits on the first shelf, whichever it is now.
  const toggleFor = (id) => (shelfOrder[0] === id ? viewToggle : '');
  const loginHint = tp('home.loginHint', { login: `<a href="/login">${escapeHtml(t('nav.login'))}</a>` });
  const welcomeQuotePool = getHomeWelcomeQuotePool(getLocale());
  const welcomeQuote = pickHomeWelcomeQuote(getLocale());
  // The quote cover is the author's "book": same link as the author name under the quote.
  const welcomeQuoteHref = isWelcomeQuoteAuthorLinkable(welcomeQuote.author)
    ? `/catalog?field=authors&q=${encodeURIComponent(welcomeQuote.author)}`
    : '';
  const welcomeQuotesJson = JSON.stringify(welcomeQuotePool.map(({ quote, author }) => ({
    quote,
    author,
    href: isWelcomeQuoteAuthorLinkable(author) ? `/catalog?field=authors&q=${encodeURIComponent(author)}` : ''
  }))).replace(/</g, '\\u003c');
  const subtitleText = homeSubtitle === '-' ? '' : (homeSubtitle || t('home.subtitle'));
  const homeViewAttr = listView ? 'list' : 'grid';
  const homeBatch = canDownloadInUi(user);
  const viewToggle = user
    ? renderViewToggle({ isListView: listView, formAction: '/profile/home-view', csrfToken })
    : renderViewToggle({ href: listView ? '/?view=grid' : '/?view=list', isListView: listView });
  const recommendationsShelf = isAuthenticated
    ? (recommendations.length
        ? renderHomeShelf({ title: t('home.shelfRecommended'), href: '/library/recommended', items: recommendations, type: 'books', isAuthenticated, batchSelect: homeBatch, user, readBookIds, listView, extraActions: toggleFor('recommended') })
        : `
    <section class="library-shelf" data-home-recommendations data-home-view="${homeViewAttr}" data-loaded="0">
      <div class="section-title">
        <h2>${escapeHtml(t('home.shelfRecommended'))}</h2>
        <div class="actions">${toggleFor('recommended')}<a class="shelf-link" href="/library/recommended">${escapeHtml(t('home.showAll'))}</a></div>
      </div>
      <div data-home-recommendations-grid>${renderSkeletonGrid(8)}</div>
    </section>`)
    : '';
  const continueAttr = isAuthenticated && hasContinueData && shown('continue') ? ' data-home-continue' : '';
  const heroHtml = `
    <section class="welcome-hero-banner home-reveal"${continueAttr}>
      <div class="welcome-hero-cover">
      <a class="welcome-hero-mark cover"${welcomeQuoteHref ? ` href="${escapeHtml(welcomeQuoteHref)}"` : ''} tabindex="-1" aria-hidden="true">
        ${welcomeQuoteHref ? `<img class="cover-image" src="/api/authors/portrait?name=${escapeHtml(encodeURIComponent(welcomeQuote.author))}" alt="" onload="this.classList.add('is-loaded')" onerror="this.remove()">` : ''}
        <span class="cover-fallback">
          ${renderCoverFallbackImage()}
          <span class="cover-fallback-overlay"></span>
          <span class="cover-fallback-copy">
            <span class="cover-fallback-title">${escapeHtml(welcomeQuote.author || t('home.quoteCoverTitle'))}</span>
          </span>
        </span>
        <span class="welcome-hero-mark-title">${escapeHtml(welcomeQuote.author)}</span>
      </a>
      </div>
      <div class="welcome-hero-content">
        <blockquote class="welcome-hero-quote">${escapeHtml(welcomeQuote.quote)}</blockquote>
        <cite class="welcome-hero-author">${renderWelcomeQuoteAuthor(welcomeQuote.author)}</cite>
      </div>
      <script type="application/json" data-home-quotes>${welcomeQuotesJson}</script>
    </section>`;
  const shelfHtml = (shelf, id) => renderHomeShelf({ title: shelf.title, href: escapeHtml(shelf.href), items: shelf.items, type: 'books', isAuthenticated, batchSelect: homeBatch, user, readBookIds, listView, extraActions: toggleFor(id) });
  const blocks = {
    novinki: () => renderHomeShelf({ title: t('home.shelfNew'), href: '/library/recent', items: sections.newest || [], type: 'books', isAuthenticated, batchSelect: homeBatch, user, readBookIds, listView, extraActions: toggleFor('novinki') }),
    recommended: () => recommendationsShelf,
    following: () => (isAuthenticated && followingShelf ? shelfHtml(followingShelf, 'following') : ''),
    shelves: () => (isAuthenticated ? homeShelves.map((shelf, i) => shelfHtml(shelf, i === 0 ? 'shelves' : '')).join('') : '')
  };
  /* The banner stays on top while «Продолжить чтение» is hidden (quote only) or first. */
  const continuePos = shown('continue') ? layout.order.filter((id) => WEB_HOME_SECTION_IDS.includes(id) && shown(id)).indexOf('continue') : 0;
  const shelvesBeforeHero = shelfOrder.slice(0, continuePos);
  const shelvesAfterHero = shelfOrder.slice(continuePos);
  const renderBlocks = (ids) => ids.map((id) => blocks[id]()).join('');
  const content = `
    <h1 class="visually-hidden">${escapeHtml(siteTitleForDisplay())}</h1>
    ${subtitleText ? `<header class="home-page-intro"><p class="home-page-subtitle">${escapeHtml(subtitleText)}</p></header>` : ''}
    ${shelvesBeforeHero.length ? '' : heroHtml}
    ${!isAuthenticated ? `<div class="home-inline-note">${loginHint}</div>` : ''}
    ${homeBatch ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}` : ''}
    ${renderBlocks(shelvesBeforeHero)}
    ${shelvesBeforeHero.length ? heroHtml : ''}
    ${renderBlocks(shelvesAfterHero)}
    ${homeBatch ? '</div>' : ''}
    `;
  return pageShell({ title: t('home.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home') }], currentPath: '/', csrfToken, readBookIds });
}

function buildCatalogQueryParams({
  query = '', field = '', sort = 'title', order = '', genres = [], letter = '',
  lang = '', format = '', year = 0, minRate = 0, hasSeries = null, genreMode = 'or', view = ''
} = {}) {
  const p = new URLSearchParams();
  if (field) p.set('field', field);
  if (sort) p.set('sort', sort);
  if (order) p.set('order', order);
  if (query) p.set('q', query);
  if (letter) p.set('letter', letter);
  if (lang) p.set('lang', lang);
  if (format) p.set('format', format);
  if (year) p.set('year', String(year));
  if (minRate >= 1) p.set('minRate', String(minRate));
  if (hasSeries === 0 || hasSeries === 1) p.set('hasSeries', String(hasSeries));
  if (genreMode === 'and') p.set('genreMode', 'and');
  if (view === 'list' || view === 'grid') p.set('view', view);
  for (const g of genres) {
    if (g) p.append('genre', g);
  }
  return p;
}

function catalogChipHref(baseParams, removeKey, removeValue = null, action = '/catalog') {
  const p = new URLSearchParams(baseParams.toString());
  if (removeKey === 'genre' && removeValue != null) {
    const kept = p.getAll('genre').filter((g) => g !== removeValue);
    p.delete('genre');
    for (const g of kept) p.append('genre', g);
  } else {
    p.delete(removeKey);
  }
  p.delete('page');
  const qs = p.toString();
  return qs ? `${action}?${qs}` : action;
}

function renderViewToggle({ href, isListView, formAction = '', csrfToken = '', returnTo = '' }) {
  const gridIcon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
  const listIcon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';
  const label = isListView ? t('browse.viewGrid') : t('browse.viewList');
  const icon = isListView ? gridIcon : listIcon;
  if (formAction) {
    const next = isListView ? 'grid' : 'list';
    const back = returnTo ? `<input type="hidden" name="next" value="${escapeHtml(returnTo)}">` : '';
    return `<form class="home-view-toggle" method="post" action="${escapeHtml(formAction)}">${csrfHiddenField(csrfToken)}${back}<input type="hidden" name="view" value="${next}"><button type="submit" class="button view-toggle" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button></form>`;
  }
  return `<a class="button view-toggle" href="${escapeHtml(href)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</a>`;
}

function renderCatalogSearchHints(searchHints, query = '') {
  const hints = searchHints && typeof searchHints === 'object' ? searchHints : null;
  if (!hints) return '';
  const modes = Array.isArray(hints.alternateModes) ? hints.alternateModes : [];
  const typos = Array.isArray(hints.didYouMean) ? hints.didYouMean : [];
  const tipKey = hints.tip === 'try_authors'
    ? 'catalog.searchTipTryAuthors'
    : hints.tip === 'try_series'
      ? 'catalog.searchTipTrySeries'
      : hints.tip === 'try_books'
        ? 'catalog.searchTipTryBooks'
        : '';
  if (!modes.length && !typos.length && !tipKey) return '';

  const fieldLabels = {
    books: t('search.books'),
    authors: t('search.authors'),
    series: t('search.series')
  };

  const modeBlocks = modes.map((mode) => {
    const field = mode.field === 'authors' || mode.field === 'series' ? mode.field : 'books';
    const href = `/catalog?${new URLSearchParams({ q: query, field }).toString()}`;
    const label = fieldLabels[field] || field;
    const total = Math.max(0, Math.floor(Number(mode.total) || 0));
    const samples = (Array.isArray(mode.samples) ? mode.samples : [])
      .slice(0, 3)
      .map((s) => escapeHtml(s.displayName || s.title || s.name || ''))
      .filter(Boolean)
      .join(', ');
    const samplePart = samples ? ` — ${samples}` : '';
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a> <span class="muted">(${formatLocaleInt(total)})${samplePart}</span></li>`;
  }).join('');

  const typoLinks = typos.map((row) => {
    const field = row.type === 'series' ? 'series' : row.type === 'author' ? 'authors' : 'books';
    const q = String(row.query || row.label || '').trim();
    if (!q) return '';
    const href = `/catalog?${new URLSearchParams({ q, field }).toString()}`;
    return `<a href="${escapeHtml(href)}">${escapeHtml(row.label || q)}</a>`;
  }).filter(Boolean).join(', ');

  return `
    <div class="catalog-search-hints" data-catalog-search-hints>
      ${tipKey ? `
        <div class="catalog-search-hints-block">
          <strong>${escapeHtml(t(tipKey))}</strong>
        </div>` : ''}
      ${modeBlocks ? `
        <div class="catalog-search-hints-block">
          <strong>${escapeHtml(t('catalog.searchHintsTitle'))}</strong>
          <ul class="catalog-search-hints-list">${modeBlocks}</ul>
        </div>` : ''}
      ${typoLinks ? `
        <div class="catalog-search-hints-block">
          <strong>${escapeHtml(t('catalog.didYouMean'))}</strong>
          <div class="catalog-search-hints-typos">${typoLinks}</div>
        </div>` : ''}
    </div>`;
}

/* One collator instead of localeCompare(…, options) per comparison (same order, far cheaper). */
const GENRE_COLLATOR = new Intl.Collator('ru', { sensitivity: 'base' });

function sortGenreOptionsAlpha(options = []) {
  return [...(Array.isArray(options) ? options : [])].sort((a, b) => {
    const la = String(a?.displayName || a?.name || '').trim();
    const lb = String(b?.displayName || b?.name || '').trim();
    return GENRE_COLLATOR.compare(la, lb);
  });
}

/*
 * The genre option list (hundreds of labels) is identical for every catalog page that
 * reuses the same cached genreOptions array, so its HTML is memoized per array
 * (WeakMap: dropped with the cached array) and per locale / form / selected genres.
 */
const _genreChecksHtmlMemo = new WeakMap();
const GENRE_CHECKS_MEMO_MAX = 32;

function memoGenreChecksHtml(genreOptions, key, build) {
  if (!Array.isArray(genreOptions) || !genreOptions.length) return build();
  let perArray = _genreChecksHtmlMemo.get(genreOptions);
  if (!perArray) {
    perArray = new Map();
    _genreChecksHtmlMemo.set(genreOptions, perArray);
  }
  let html = perArray.get(key);
  if (html === undefined) {
    html = build();
    if (perArray.size >= GENRE_CHECKS_MEMO_MAX) perArray.delete(perArray.keys().next().value);
    perArray.set(key, html);
  }
  return html;
}

function renderCatalogFilterPanel({
  query, field, sort, order, genres = [], letter, lang, format, year, minRate = 0,
  hasSeries = null, genreMode = 'or', langs = [], formats = [], genreOptions = [], genreOptionsLazy = false,
  view = '',
  action = '/catalog',
  formId = 'catalog-filters',
  showLang = true,
  showGenreMode = true,
  smartShelfCsrf = null
}) {
  const selected = new Set(genres);
  const baseParams = buildCatalogQueryParams({
    query, field, sort, order, genres, letter, lang, format, year, minRate, hasSeries, genreMode, view
  });
  const chipHref = (key, value) => catalogChipHref(baseParams, key, value, action);
  const chips = [];
  for (const g of genres) {
    chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(chipHref('genre', g))}"><span>${escapeHtml(tp('catalog.filter.genre', { value: formatGenreLabel(g) }))}</span><span aria-hidden="true">×</span></a>`);
  }
  if (showLang && lang) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(chipHref('lang'))}"><span>${escapeHtml(tp('catalog.filter.lang', { value: lang.toUpperCase() }))}</span><span aria-hidden="true">×</span></a>`);
  if (format) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(chipHref('format'))}"><span>${escapeHtml(tp('catalog.filter.format', { value: format.toUpperCase() }))}</span><span aria-hidden="true">×</span></a>`);
  if (year) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(chipHref('year'))}"><span>${escapeHtml(tp('catalog.filter.year', { value: String(year) }))}</span><span aria-hidden="true">×</span></a>`);
  if (minRate >= 1) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(chipHref('minRate'))}"><span>${escapeHtml(tp('catalog.filter.minRate', { value: String(minRate) }))}</span><span aria-hidden="true">×</span></a>`);
  if (hasSeries === 1) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(chipHref('hasSeries'))}"><span>${escapeHtml(t('catalog.filter.hasSeries'))}</span><span aria-hidden="true">×</span></a>`);
  if (hasSeries === 0) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(chipHref('hasSeries'))}"><span>${escapeHtml(t('catalog.filter.noSeries'))}</span><span aria-hidden="true">×</span></a>`);

  const selectedGenreChecks = genres.map((name) => {
    const label = formatGenreLabel(name);
    const search = `${name} ${label}`.toLowerCase();
    return `<label class="catalog-genre-option" data-genre-search="${escapeHtml(search)}"><input type="checkbox" name="genre" value="${escapeHtml(name)}" form="${escapeHtml(formId)}" checked><span class="catalog-genre-label">${escapeHtml(label)}</span></label>`;
  }).join('');
  const genreChecksKey = `${getLocale()}|${formId}|${[...selected].sort().join(',')}`;
  const genreChecks = memoGenreChecksHtml(genreOptions, genreChecksKey, () => sortGenreOptionsAlpha(genreOptions).map((g) => {
    const name = g.name || '';
    if (selected.has(name)) return '';
    const label = g.displayName || formatGenreLabel(name);
    const count = Number.isFinite(Number(g.bookCount)) ? Math.max(0, Math.floor(Number(g.bookCount))) : null;
    const search = `${name} ${label}`.toLowerCase();
    const countHtml = count != null
      ? `<span class="catalog-genre-count muted">${escapeHtml(String(count))}</span>`
      : '';
    return `<label class="catalog-genre-option" data-genre-search="${escapeHtml(search)}"><input type="checkbox" name="genre" value="${escapeHtml(name)}" form="${escapeHtml(formId)}"><span class="catalog-genre-label">${escapeHtml(label)}</span>${countHtml}</label>`;
  }).join(''));
  const lazyAttrs = genreOptionsLazy
    ? ` data-catalog-genres-lazy="1" data-genres-q="${escapeHtml(query || '')}" data-genres-lang="${escapeHtml(lang || '')}" data-genres-format="${escapeHtml(format || '')}" data-genres-year="${escapeHtml(year ? String(year) : '')}" data-genres-min-rate="${escapeHtml(minRate >= 1 ? String(minRate) : '')}" data-genres-has-series="${escapeHtml(hasSeries === 0 || hasSeries === 1 ? String(hasSeries) : '')}"`
    : '';
  const genreListHtml = genreOptionsLazy
    ? `${selectedGenreChecks}<span class="muted catalog-genres-loading" data-catalog-genres-loading>${escapeHtml(t('catalog.filtersGenresLoading'))}</span>`
    : (selectedGenreChecks + genreChecks) || `<span class="muted">${escapeHtml(t('browse.empty'))}</span>`;

  const hasActive = chips.length > 0;
  const resetParams = buildCatalogQueryParams({ query, field, sort, order, letter, view });
  const resetQs = resetParams.toString();
  const resetHref = resetQs ? `${action}?${resetQs}` : action;
  const summaryCount = hasActive ? ` (${chips.length})` : '';
  const filterFormId = formId;
  const smartSaveHtml = smartShelfCsrf !== null && (hasActive || String(query || '').trim())
    ? `<details class="catalog-smart-save">
      <summary class="button">${escapeHtml(t('smartShelves.save'))}</summary>
      <form method="post" action="/shelves/smart" class="shelf-create-form">
        ${csrfHiddenField(smartShelfCsrf)}
        <input type="hidden" name="query" value="${escapeHtml(buildCatalogQueryParams({ query, sort, order, genres, lang, format, year, minRate, hasSeries, genreMode }).toString())}">
        <input type="text" name="name" maxlength="100" placeholder="${escapeHtml(t('smartShelves.namePlaceholder'))}" required>
        <button type="submit" class="button-primary">${escapeHtml(t('smartShelves.saveBtn'))}</button>
      </form>
    </details>`
    : '';
  return `
    <form id="${filterFormId}" class="catalog-filter-panel" method="get" action="${escapeHtml(action)}" data-catalog-filters${lazyAttrs}>
      ${query ? `<input type="hidden" name="q" value="${escapeHtml(query)}">` : ''}
      ${field ? `<input type="hidden" name="field" value="${escapeHtml(field)}">` : ''}
      <input type="hidden" name="sort" value="${escapeHtml(sort || 'title')}">
      ${order ? `<input type="hidden" name="order" value="${escapeHtml(order)}">` : ''}
      ${letter ? `<input type="hidden" name="letter" value="${escapeHtml(letter)}">` : ''}
      ${(view === 'list' || view === 'grid') ? `<input type="hidden" name="view" value="${escapeHtml(view)}">` : ''}
      <div class="catalog-filter-bar">
        <details class="catalog-filter-shell">
          <summary class="button catalog-filter-summary">
            <span class="catalog-filter-summary-label">${escapeHtml(t('catalog.filtersTitle'))}${escapeHtml(summaryCount)}</span>
          </summary>
        </details>
        ${hasActive ? `<div class="catalog-filter-active"><div class="catalog-filter-chips" aria-label="${escapeHtml(t('catalog.filtersActive'))}">${chips.join('')}</div><a class="catalog-filter-reset" href="${escapeHtml(resetHref)}">${escapeHtml(t('catalog.filtersReset'))}</a></div>` : ''}
      </div>
    </form>
    ${smartSaveHtml}
    <div class="catalog-filter-body">
      <details class="catalog-filter-details"${genres.length ? ' open' : ''}>
        <summary>${escapeHtml(t('catalog.filtersGenres'))}${genres.length ? ` (${genres.length})` : ''}</summary>
        <div class="catalog-genre-panel">
          <div class="catalog-genre-search-row">
            <input type="search" class="catalog-genre-search" data-catalog-genre-search placeholder="${escapeHtml(t('catalog.filtersGenreSearch'))}" autocomplete="off">
            ${showGenreMode ? `<select class="catalog-genre-mode" name="genreMode" form="${filterFormId}" aria-label="${escapeHtml(t('catalog.filtersGenreMode'))}" title="${escapeHtml(t('catalog.filtersGenreMode'))}" onchange="this.form.submit()">
              <option value=""${genreMode === 'and' ? '' : ' selected'}>${escapeHtml(t('catalog.filtersGenreModeAny'))}</option>
              <option value="and"${genreMode === 'and' ? ' selected' : ''}>${escapeHtml(t('catalog.filtersGenreModeAll'))}</option>
            </select>` : ''}
          </div>
          <div class="catalog-genre-list" role="group" aria-label="${escapeHtml(t('catalog.filtersGenres'))}">${genreListHtml}</div>
        </div>
      </details>
      <div class="catalog-filter-row catalog-filter-row-inline">
        ${showLang ? `<label class="catalog-filter-field">
          <span class="muted">${escapeHtml(t('catalog.filtersLang'))}</span>
          <select name="lang" form="${filterFormId}" onchange="this.form.submit()">
            <option value="">${escapeHtml(t('catalog.allLanguages'))}</option>
            ${langs.map((l) => `<option value="${escapeHtml(l)}"${l === lang ? ' selected' : ''}>${escapeHtml(l.toUpperCase())}</option>`).join('')}
          </select>
        </label>` : ''}
        <label class="catalog-filter-field">
          <span class="muted">${escapeHtml(t('catalog.filtersFormat'))}</span>
          <select name="format" form="${filterFormId}" onchange="this.form.submit()">
            <option value="">${escapeHtml(t('catalog.allFormats'))}</option>
            ${formats.map((f) => `<option value="${escapeHtml(f)}"${f === format ? ' selected' : ''}>${escapeHtml(f.toUpperCase())}</option>`).join('')}
          </select>
        </label>
        <label class="catalog-filter-field catalog-filter-field-narrow">
          <span class="muted">${escapeHtml(t('catalog.year'))}</span>
          <input type="number" name="year" form="${filterFormId}" min="1800" max="2100" placeholder="${escapeHtml(t('catalog.year'))}" value="${year || ''}" onchange="this.form.submit()">
        </label>
        <label class="catalog-filter-field catalog-filter-field-narrow">
          <span class="muted">${escapeHtml(t('catalog.filtersMinRate'))}</span>
          <select name="minRate" form="${filterFormId}" onchange="this.form.submit()">
            <option value="">${escapeHtml(t('catalog.filtersAnyRate'))}</option>
            ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${minRate === n ? ' selected' : ''}>${n}+</option>`).join('')}
          </select>
        </label>
        <label class="catalog-filter-field catalog-filter-field-narrow">
          <span class="muted">${escapeHtml(t('catalog.filtersSeries'))}</span>
          <select name="hasSeries" form="${filterFormId}" onchange="this.form.submit()">
            <option value="">${escapeHtml(t('catalog.filtersSeriesAny'))}</option>
            <option value="1"${hasSeries === 1 ? ' selected' : ''}>${escapeHtml(t('catalog.filtersSeriesYes'))}</option>
            <option value="0"${hasSeries === 0 ? ' selected' : ''}>${escapeHtml(t('catalog.filtersSeriesNo'))}</option>
          </select>
        </label>
        <div class="catalog-filter-actions">
          <button type="submit" class="button button-primary" form="${filterFormId}">${escapeHtml(t('catalog.filtersApply'))}</button>
        </div>
      </div>
    </div>`;
}

export function renderSearchOverview({
  overview,
  query = '',
  user = null,
  stats = null,
  indexStatus = null,
  csrfToken = '',
  readBookIds = null
} = {}) {
  const q = String(query || overview?.query || '').trim();
  const preferred = ['books', 'authors', 'series'].includes(overview?.preferredField)
    ? overview.preferredField
    : null;
  let rows = [
    { field: 'books', label: t('search.books'), total: overview?.books?.total || 0, capped: Boolean(overview?.books?.capped) },
    { field: 'authors', label: t('search.authors'), total: overview?.authors?.total || 0, capped: false },
    { field: 'series', label: t('search.series'), total: overview?.series?.total || 0, capped: false }
  ];
  if (preferred) {
    rows = [...rows.filter((r) => r.field === preferred), ...rows.filter((r) => r.field !== preferred)];
  }
  const anyHits = rows.some((row) => row.total > 0);
  const list = rows.map((row) => {
    const href = `/catalog?${new URLSearchParams({ q, field: row.field }).toString()}`;
    const count = formatLocaleInt(row.total);
    const countLabel = row.capped ? `${count}+` : count;
    const preferredClass = preferred && row.field === preferred ? ' is-preferred' : '';
    const preferredBadge = preferred && row.field === preferred
      ? `<span class="search-overview-preferred muted">${escapeHtml(t('search.overviewPreferred'))}</span>`
      : '';
    return `<li class="search-overview-item${preferredClass}">
      <a class="search-overview-link" href="${escapeHtml(href)}">
        <span class="search-overview-label">${escapeHtml(row.label)}${preferredBadge}</span>
        <span class="search-overview-count muted">${countLabel}</span>
      </a>
    </li>`;
  }).join('');
  const content = `
    <section class="hero">
      <div class="section-title">
        <h1>${escapeHtml(t('search.overviewTitle'))}</h1>
      </div>
      <div class="list-context-hint list-context-hint-spacious">
        ${escapeHtml(tp('search.overviewQuery', { q }))}
      </div>
      ${anyHits
        ? `<ul class="search-overview-list">${list}</ul>
           <p class="list-context-hint">${escapeHtml(t('search.overviewHint'))}</p>`
        : renderEmptyState({
            title: t('search.overviewEmptyTitle'),
            text: t('search.overviewEmptyText'),
            actionHref: '/catalog',
            actionLabel: t('catalog.resetSearch')
          })}
    </section>`;
  return pageShell({
    title: t('catalog.title'),
    content,
    user,
    query: q,
    field: 'all',
    stats,
    indexStatus,
    breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('catalog.title') }],
    currentPath: '/catalog',
    csrfToken,
    readBookIds
  });
}

function renderSearchNav(searchNav, { query = '', field = 'books' } = {}) {
  const q = String(query || '').trim();
  if (!q || !searchNav) return '';
  const rows = [
    { field: 'books', label: t('search.books'), total: searchNav?.books?.total || 0, capped: Boolean(searchNav?.books?.capped) },
    { field: 'authors', label: t('search.authors'), total: searchNav?.authors?.total || 0, capped: false },
    { field: 'series', label: t('search.series'), total: searchNav?.series?.total || 0, capped: false }
  ];
  const links = rows.map((row) => {
    const href = `/catalog?${new URLSearchParams({ q, field: row.field }).toString()}`;
    const count = formatLocaleInt(row.total);
    const countLabel = row.capped ? `${count}+` : count;
    const active = field === row.field ? ' is-active' : '';
    const ariaCurrent = field === row.field ? ' aria-current="page"' : '';
    return `<a class="search-nav-link${active}" href="${escapeHtml(href)}"${ariaCurrent}>${escapeHtml(row.label)} <span class="search-nav-count muted">${countLabel}</span></a>`;
  }).join('');
  return `<nav class="search-nav" aria-label="${escapeHtml(t('search.navLabel'))}">${links}</nav>`;
}

export function renderCatalog({
  items, total, page, pageSize, query, field, sort, order = '',
  genre = '', genres = null, letter = '', lang = '', format = '', year = 0,
  minRate = 0, hasSeries = null, genreMode = 'or',
  langs = [], formats = [], genreOptions = [],
  genreOptionsLazy = false,
  searchNav = null,
  searchHints = null,
  view = '',
  user, stats, indexStatus, csrfToken = '', readBookIds = null
}) {
  const genreList = Array.isArray(genres) && genres.length
    ? genres
    : String(genre || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fieldLabels = {
    books: t('catalog.inBooks'),
    authors: t('catalog.inAuthors'),
    series: t('catalog.inSeries')
  };
  const hasFilterDims = Boolean(genreList.length || lang || format || year || minRate >= 1 || hasSeries === 0 || hasSeries === 1);
  const isBookField = ['books', 'title', 'book-authors', 'book-series', 'genres', 'keywords'].includes(field);
  const isListView = isBookField && view === 'list';
  const sortOptions = isBookField
    ? [
        { value: 'recent', label: t('sort.recentFirst') },
        { value: 'title', label: t('sort.byTitle') },
        { value: 'author', label: t('sort.byAuthor') },
        { value: 'series', label: t('sort.bySeries') },
        { value: 'rating', label: t('sort.byRating') }
      ]
    : [
        { value: 'count', label: t('sort.byBookCount') },
        { value: 'name', label: t('sort.byName') }
      ];
  const browseView = isListView ? 'list' : 'grid';
  const catalogParams = buildCatalogQueryParams({
    query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries, genreMode,
    view: browseView
  });
  const catalogPageBase = `/catalog?${catalogParams.toString()}`;
  const genreCsv = genreList.join(',');
  const filterSummary = [
    ...genreList.map((g) => formatGenreLabel(g)),
    lang ? lang.toUpperCase() : '',
    format ? format.toUpperCase() : '',
    year ? tp('catalog.filter.year', { value: String(year) }) : '',
    minRate >= 1 ? tp('catalog.filter.minRate', { value: String(minRate) }) : '',
    hasSeries === 1 ? t('catalog.filtersSeriesYes') : '',
    hasSeries === 0 ? t('catalog.filtersSeriesNo') : ''
  ].filter(Boolean).join(' · ');
  const catalogHintBlock = (() => {
    const n = Math.max(0, Math.floor(Number(total) || 0));
    const num = formatLocaleInt(n);
    let foundCore;
    if (isBookField) {
      foundCore = `<strong>${num}</strong> ${plural('book', n)}`;
    } else if (field === 'authors') {
      foundCore = `<strong>${num}</strong> ${plural('author', n)}`;
    } else if (field === 'series') {
      foundCore = `<strong>${num}</strong> ${plural('series', n)}`;
    } else {
      foundCore = `<strong>${num}</strong>`;
    }
    const queryPart = query
      ? tp('catalog.queryPhrase', { q: query, scope: fieldLabels[field] || t('catalog.inLibrary') })
      : '';
    const genrePart = filterSummary
      ? `${query ? ' · ' : ' '}${escapeHtml(filterSummary)}`
      : '';
    const line = tp('catalog.found', { what: foundCore, queryPart, genrePart });
    return `<div class="list-context-hint list-context-hint-spacious">${line}</div>`;
  })();
  const catalogEmpty = renderEmptyState({
    title: hasFilterDims ? t('catalog.emptyFiltersTitle') : t('catalog.emptyTitle'),
    text: hasFilterDims ? t('catalog.emptyFiltersText') : t('catalog.emptyText'),
    actionHref: '/catalog',
    actionLabel: hasFilterDims ? t('catalog.resetFilters') : t('catalog.resetSearch')
  });
  const recoveryHints = query && !hasFilterDims && searchHints
    ? renderCatalogSearchHints(searchHints, query)
    : '';
  const searchNavBlock = query ? renderSearchNav(searchNav, { query, field }) : '';
  const showBatch = Boolean(canDownloadInUi(user) && items.length);
  const booksList = isListView
    ? renderBookFlibustaList(items, { user, batchSelect: showBatch })
    : renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: showBatch, user, readBookIds });
  const booksMarkup = showBatch
    ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${booksList}</div>`
    : booksList;
  const resultsMarkup = items.length
    ? isBookField
      ? `${catalogHintBlock}${recoveryHints}${booksMarkup}`
      : `${catalogHintBlock}${recoveryHints}${renderEntityGrid(items, field === 'authors' ? '/facet/authors' : '/facet/series', t('browse.empty'))}`
    : `${catalogHintBlock}${catalogEmpty}${recoveryHints}`;
  const pageHeading = query ? t('catalog.resultsTitle') : t('catalog.title');
  const viewToggle = isBookField
    ? (() => {
      const nextParams = buildCatalogQueryParams({
        query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries, genreMode,
        view: isListView ? 'grid' : 'list'
      });
      if (!user) return renderViewToggle({ href: `/catalog?${nextParams.toString()}`, isListView });
      const returnParams = buildCatalogQueryParams({
        query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries, genreMode
      });
      const returnTo = returnParams.toString() ? `/catalog?${returnParams.toString()}` : '/catalog';
      return renderViewToggle({
        isListView,
        formAction: '/profile/catalog-view',
        csrfToken,
        returnTo
      });
    })()
    : '';
  const filterPanel = isBookField ? renderCatalogFilterPanel({
    query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries, genreMode, langs, formats, genreOptions, genreOptionsLazy,
    view: browseView,
    smartShelfCsrf: user ? csrfToken : null
  }) : '';
  const content = `
    <section class="page-intro catalog-page-intro">
      <div class="page-intro-copy">
        <h1>${escapeHtml(pageHeading)}</h1>
      </div>
      ${filterPanel}
      <div class="actions">
        ${isBookField ? renderHideReadToggle(user) : ''}
        ${viewToggle}
        ${renderSortControl({
          action: '/catalog',
          sort,
          order,
          query,
          field,
          genre: genreCsv,
          options: sortOptions,
          extraHidden: {
            ...(lang ? { lang } : {}),
            ...(format ? { format } : {}),
            ...(year ? { year: String(year) } : {}),
            ...(minRate >= 1 ? { minRate: String(minRate) } : {}),
            ...((hasSeries === 0 || hasSeries === 1) ? { hasSeries: String(hasSeries) } : {}),
            ...(genreMode === 'and' ? { genreMode: 'and' } : {}),
            ...(letter ? { letter } : {}),
            view: browseView
          }
        })}
      </div>
    </section>
    ${searchNavBlock}
    ${letter && !query ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(tp('catalog.letterResults', { letter: letter.toUpperCase() }))}</div>` : ''}
    ${resultsMarkup}
    ${renderPagination(catalogPageBase, page, pageSize, total)}`;
  return pageShell({ title: t('catalog.title'), content, user, query, field, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('catalog.title') }], currentPath: '/catalog', csrfToken, readBookIds });
}


export function renderLibraryView({
  view, title, subtitle = '', items, total, page, pageSize, type = '', itemType = '',
  sort = 'title', order = '', listView = false, user, stats, indexStatus, csrfToken = '',
  readBookIds = null, readSeriesNames = null, computing = false,
  genres = [], lang = '', format = '', year = 0, minRate = 0, hasSeries = null, genreMode = 'or',
  langs = [], formats = [], genreOptions = []
}) {
  const emptyStates = {
    recent: {
      title: t('library.empty.recent.title'),
      text: t('library.empty.recent.text')
    },

    recommended: {
      title: t('library.empty.recommended.title'),
      text: t('library.empty.recommended.text'),
      actionHref: '/favorites',
      actionLabel: t('library.empty.recommended.action'),
      secondaryHref: '/catalog',
      secondaryLabel: t('favorites.toCatalog')
    },
    continue: {
      title: t('library.empty.continue.title'),
      text: t('library.empty.continue.text'),
      actionHref: '/library/recent',
      actionLabel: t('library.empty.continue.action'),
      secondaryHref: '/catalog',
      secondaryLabel: t('favorites.toCatalog')
    },
    following: {
      title: t('library.empty.following.title'),
      text: t('library.empty.following.text'),
      actionHref: '/authors',
      actionLabel: t('library.empty.following.action'),
      secondaryHref: '/series',
      secondaryLabel: t('library.empty.following.secondary')
    },
    rated: {
      title: t('library.empty.rated.title'),
      text: t('library.empty.rated.text'),
      actionHref: '/library/read',
      actionLabel: t('library.title.read'),
      secondaryHref: '/catalog',
      secondaryLabel: t('favorites.toCatalog')
    },
    want: {
      title: t('library.empty.want.title'),
      text: t('library.empty.want.text'),
      actionHref: '/catalog',
      actionLabel: t('favorites.toCatalog'),
      secondaryHref: '/library/recent',
      secondaryLabel: t('library.openRecent')
    },
    read: {
      title: t('library.empty.read.title'),
      text: t('library.empty.read.text'),
      actionHref: '/library/continue',
      actionLabel: t('favorites.emptyReadAction'),
      secondaryHref: '/catalog',
      secondaryLabel: t('favorites.toCatalog')
    }
  };

  const isSeries = itemType === 'series';
  const isListView = !isSeries && listView;
  const genreList = Array.isArray(genres) ? genres.filter(Boolean) : [];
  const showFilters = !isSeries && (view === 'recent' || view === 'recommended');
  const filterAction = `/library/${view}`;
  const countHintLabel = ['continue', 'recommended', 'read', 'want', 'following', 'rated'].includes(view) ? t('library.countInSection') : t('library.countInCatalog');
  const totalN = Math.max(0, Math.floor(Number(total) || 0));
  const totalNum = formatLocaleInt(totalN);
  const totalBookWord = isSeries ? plural('series', totalN) : plural('book', totalN);
  const sortOptions = isSeries ? [] : [
    { value: 'recent', label: t('sort.recentFirst') },
    { value: 'title', label: t('sort.byTitle') },
    { value: 'author', label: t('sort.byAuthor') },
    { value: 'series', label: t('sort.bySeries') },
    { value: 'rating', label: t('sort.byRating') }
  ];
  const browseView = isListView ? 'list' : 'grid';
  const viewParams = buildCatalogQueryParams({
    sort, order, genres: genreList, lang, format, year, minRate, hasSeries, genreMode,
    view: isSeries ? '' : browseView
  });
  if (type) viewParams.set('type', type);
  const filterHidden = {
    ...(type ? { type } : {}),
    ...(lang ? { lang } : {}),
    ...(format ? { format } : {}),
    ...(year ? { year: String(year) } : {}),
    ...(minRate >= 1 ? { minRate: String(minRate) } : {}),
    ...((hasSeries === 0 || hasSeries === 1) ? { hasSeries: String(hasSeries) } : {}),
    ...(genreMode === 'and' ? { genreMode: 'and' } : {}),
    ...(isSeries ? {} : { view: browseView })
  };
  // Empty personal section (no filters to blame): nothing to sort or re-layout.
  const hideListControls = totalN === 0 && !showFilters;
  const viewToggle = isSeries || hideListControls
    ? ''
    : (() => {
      const nextParams = buildCatalogQueryParams({
        sort, order, genres: genreList, lang, format, year, minRate, hasSeries, genreMode,
        view: isListView ? 'grid' : 'list'
      });
      if (type) nextParams.set('type', type);
      const qs = nextParams.toString();
      return renderViewToggle({ href: qs ? `${filterAction}?${qs}` : filterAction, isListView });
    })();
  const filterPanel = showFilters
    ? renderCatalogFilterPanel({
      sort, order, genres: genreList, lang, format, year, minRate, hasSeries, genreMode,
      langs, formats, genreOptions,
      view: browseView,
      action: filterAction,
      formId: `library-filters-${view}`
    })
    : '';
  // «Новое у любимых» is always newest first.
  const sortControl = isSeries || hideListControls || view === 'following'
    ? ''
    : renderSortControl({
      action: filterAction,
      sort,
      order,
      options: sortOptions,
      extraHidden: filterHidden
    });
  const showBatch = Boolean(canDownloadInUi(user) && items.length);
  const removeReading = Boolean(view === 'continue' && user);
  const removeWant = Boolean(view === 'want' && user);
  const booksList = isListView
    ? renderBookFlibustaList(items, { user, batchSelect: showBatch, removeReading, removeWant })
    : renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: showBatch, user, readBookIds, removeReading, removeWant });
  const booksMarkup = showBatch
    ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${booksList}</div>`
    : booksList;
  const currentPathQs = viewParams.toString();
  const currentPath = currentPathQs ? `${filterAction}?${currentPathQs}` : filterAction;
  const pageIntro = `
    <section class="page-intro catalog-page-intro">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${filterPanel}
      ${isSeries ? '' : `<div class="actions">${view === 'recent' ? renderHideReadToggle(user) : ''}${viewToggle}${sortControl}</div>`}
    </section>`;
  if (computing) {
    const content = `
      ${pageIntro}
      <section class="library-shelf library-shelf-primary">
        ${renderSkeletonGrid(12)}
      </section>
      <script>setTimeout(function(){location.reload()},2500)</script>`;
    return pageShell({ title, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: title }], currentPath, csrfToken, readBookIds });
  }
  const content = `
    ${pageIntro}
    ${items.length
      ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(countHintLabel)}: <strong>${totalNum}</strong> ${totalBookWord}${page > 1 ? ` ${escapeHtml(t('library.pageSep'))} <strong>${formatLocaleInt(page)}</strong>` : ''}</div>
      <section class="library-shelf library-shelf-primary">
        ${isSeries
          ? `<div class="table-list entity-list">${items.map(item => `
              <a class="table-row table-row-link" href="/facet/series/${encodeURIComponent(item.name)}">
                <div style="display:flex;align-items:center"><span><strong>${escapeHtml(item.name)}</strong><br><span class="muted">${countLabel('book', item.bookCount)} ${escapeHtml(t('entity.inLibrary'))}</span></span>${readSeriesNames && readSeriesNames.has(item.name) ? `<span class="read-series-badge">${READ_CHECK_SVG}</span>` : ''}</div>
              </a>`).join('')}</div>`
          : booksMarkup}
      </section>`
      : `
    <div class="list-context-hint list-context-hint-spacious">${escapeHtml(countHintLabel)}: <strong>${totalNum}</strong> ${totalBookWord}${page > 1 ? ` ${escapeHtml(t('library.pageSep'))} <strong>${formatLocaleInt(page)}</strong>` : ''}</div>
    <section class="library-shelf library-shelf-primary">
      ${renderEmptyState({
        title: emptyStates[view]?.title || t('library.empty.genericTitle'),
        text: emptyStates[view]?.text || t('library.empty.genericText'),
        actionHref: emptyStates[view]?.actionHref || '/library/recent',
        actionLabel: emptyStates[view]?.actionLabel || t('library.openRecent'),
        secondaryHref: emptyStates[view]?.secondaryHref || '',
        secondaryLabel: emptyStates[view]?.secondaryLabel || ''
      })}
    </section>`}
    ${renderPagination(currentPath, page, pageSize, total)}
  `;

  return pageShell({
    title,
    content,
    user,
    stats,
    indexStatus,
    breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: title }],

    currentPath,
    csrfToken,
    readBookIds
  });
}


/** «Ваша оценка» under the book title: 5 stars, clicking the current one clears it (→ «Мои оценки»). */
function renderMyRating(bookId, rating = 0) {
  const value = Math.max(0, Math.min(5, Math.floor(Number(rating) || 0)));
  const stars = [1, 2, 3, 4, 5].map((n) => `<button type="button" class="my-rating-star${n <= value ? ' is-on' : ''}" data-my-rating-value="${n}" aria-pressed="${n <= value ? 'true' : 'false'}" aria-label="${escapeHtml(tp('book.rateStars', { n }))}" title="${escapeHtml(tp('book.rateStars', { n }))}">★</button>`).join('');
  return `<div class="book-my-rating" ${bookIdDataAttr(bookId)} data-my-rating="${value}" role="group" aria-label="${escapeHtml(t('book.myRating'))}">
            <span class="book-my-rating-label">${escapeHtml(t('book.myRating'))}</span>${stars}
          </div>`;
}

export function renderBook({
  book,
  details,
  bookmarked,
  isRead = false,
  wantToRead = false,
  myRating = 0,
  readProgress = 0,
  user,
  stats,
  indexStatus,
  similarBooks = null,
  csrfToken = '',
  authorBioHtml = '',
  authorPortraitUrl = '',
  illustrationUrls = [],
  flash = '',
  readBookIds = null,
  telegramSendAvailable = false
}) {
  const similar = similarBooks || { title: t('book.similar'), items: [] };
  const isAuthenticated = Boolean(user);
  const hasRealCover = Boolean(details?.cover?.data?.length || details?.cover?.hasData);
  const primaryAuthor = book.authorsList?.[0] || firstAuthorValue(book.authors);
  const genreCodesSummary = book.genres ? parseGenreCodes(book.genres).slice(0, 3) : [];
  const genreSummaryHtml = genreCodesSummary.length
    ? genreCodesSummary.map((code) => `<a href="/facet/genres/${encodeURIComponent(code)}">${escapeHtml(formatGenreLabel(code))}</a>`).join(', ')
    : '';
  const seriesList = book.seriesList || [];
  const seriesAuthorParam = primaryAuthor ? `?author=${encodeURIComponent(primaryAuthor)}` : '';
  const seriesSummaryHtml = seriesList.length
    ? seriesList.map((s) => `<a href="/facet/series/${encodeURIComponent(s.name)}${seriesAuthorParam}">${escapeHtml(s.displayName || s.name)}${s.seriesNo ? ` #${escapeHtml(s.seriesNo)}` : ''}</a>`).join(', ')
    : '';
  const primarySeries = seriesList[0] || null;
  const summaryBits = [
    seriesSummaryHtml,
    (book.lang || 'unknown') ? `<a href="/facet/languages/${encodeURIComponent(book.lang || 'unknown')}">${escapeHtml(formatLanguageLabel(book.lang || 'unknown'))}</a>` : '',
    // Source format only: INPX SIZE matches neither the archive entry nor the delivered
    // file (Flibusta sidecar images are merged back into FB2/EPUB on download).
    book.ext ? escapeHtml(String(book.ext).toUpperCase()) : '',
    genreSummaryHtml
  ].filter(Boolean);
  const parentLibraryHref = primarySeries ? `/facet/series/${encodeURIComponent(primarySeries.name)}${seriesAuthorParam}` : primaryAuthor ? `/facet/authors/${encodeURIComponent(primaryAuthor)}` : '/library/recent';
  const parentLibraryLabel = primarySeries
    ? tp('book.seriesPrefix', { name: primarySeries.displayName || primarySeries.name })
    : primaryAuthor
      ? tp('book.authorPrefix', { name: formatAuthorLabel(book.authors) })
      : t('nav.recent');
  const content = `
    <section class="book-detail-shell" style="--detail-cover:url('${escapeHtml(apiBookPath(book.id, 'cover'))}')">
      <div class="book-detail-main card-detail-panel">
        <div class="book-detail-cover book-3d" ${bookIdDataAttr(book.id)}><div class="book-3d-body">
          <div class="cover ${hasRealCover ? '' : 'cover-fallback-active'}">
            <img class="cover-image" src="${apiBookPath(book.id, 'cover')}" alt="${escapeHtml(book.title)}">
            <span class="cover-fallback" ${hasRealCover ? 'hidden' : ''} aria-hidden="${hasRealCover ? 'true' : 'false'}">
              ${renderCoverFallbackImage()}
              <span class="cover-fallback-overlay"></span>
              <span class="cover-fallback-copy">
                <span class="cover-fallback-title">${escapeHtml(book.title)}</span>
                <span class="cover-fallback-author">${escapeHtml(formatAuthorLabel(book.authors) || t('book.authorUnknown'))}</span>
              </span>
            </span>
            ${(() => { const r = Math.max(0, Math.min(5, Math.floor(Number(book.libRate) || 0))); return r ? `<span class="cover-rating-wrapper"><span class="cover-rating-badge cover-rating-${r}">${Array.from({ length: r }, () => '<span>★</span>').join('')}</span></span>` : ''; })()}
            ${isRead ? `<span class="read-badge">${READ_CHECK_SVG}</span>` : ''}
          </div>
        </div></div>
        <div class="book-detail-content">
          ${isAuthenticated ? `<div class="book-detail-corner-actions">
            ${isRead ? '' : `<button class="book-detail-icon-action book-detail-want-action ${wantToRead ? 'is-active' : ''}" type="button" ${bookIdDataAttr(book.id)} data-want-button="1" aria-pressed="${wantToRead ? 'true' : 'false'}" aria-label="${escapeHtml(wantToRead ? t('book.inWant') : t('book.addWant'))}" title="${escapeHtml(wantToRead ? t('book.inWant') : t('book.addWant'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.8h10a.8.8 0 0 1 .8.8v15.6L12 16.4l-5.8 3.8V4.6a.8.8 0 0 1 .8-.8z"/></svg></button>`}
            <button class="book-detail-icon-action book-detail-read-action ${isRead ? 'is-active' : ''}" type="button" ${bookIdDataAttr(book.id)} data-read-button="1" aria-pressed="${isRead ? 'true' : 'false'}" aria-label="${escapeHtml(isRead ? t('book.markedRead') : t('book.markRead'))}" title="${escapeHtml(isRead ? t('book.markedRead') : t('book.markRead'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 16.7 19 7"/></svg></button>
            <button class="book-detail-icon-action book-detail-bookmark-action ${bookmarked ? 'is-active' : ''}" type="button" ${bookIdDataAttr(book.id)} data-bookmark-button="1" aria-pressed="${bookmarked ? 'true' : 'false'}" aria-label="${escapeHtml(bookmarked ? t('book.inFavorite') : t('book.addFavorite'))}" title="${escapeHtml(bookmarked ? t('book.inFavorite') : t('book.addFavorite'))}" ${bookmarked ? 'data-active-favorite="true"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4s-6.8-4.2-6.8-8.8A3.8 3.8 0 0 1 12 8.1a3.8 3.8 0 0 1 6.8 3.5c0 4.6-6.8 8.8-6.8 8.8z"/></svg></button>
            <button class="book-detail-icon-action book-detail-shelf-action" type="button" ${bookIdDataAttr(book.id)} data-add-to-shelf="1" aria-label="${escapeHtml(t('book.toShelf'))}" title="${escapeHtml(t('book.toShelf'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16"/><path d="M6.5 19V8.2c0-.7.6-1.2 1.3-1.2H10V19"/><path d="M10 19V6.2c0-.7.6-1.2 1.3-1.2H14V19"/><path d="M14 19V9.2c0-.7.6-1.2 1.3-1.2H18V19"/></svg></button>
          </div>` : ''}
          <h1 class="book-detail-title">${escapeHtml(book.title)}${Number(book.deleted) ? ` <span class="deleted-badge deleted-badge--inline" title="${escapeHtml(t('book.deletedHint'))}">${escapeHtml(t('book.deletedBadge'))}</span>` : ''}</h1>
          ${Number(book.deleted) ? `<p class="muted book-deleted-note">${escapeHtml(t('book.deletedHint'))}</p>` : ''}
          <div class="author">${book.authors ? renderAuthorLinks(book.authorsList, { limit: 3, bookAuthors: book.authors, inlineExpand: true }) : escapeHtml(t('book.authorUnknown'))}</div>
          ${summaryBits.length ? `<div class="book-detail-summary">${summaryBits.join('<span class="book-detail-sep">·</span>')}</div>` : ''}
          ${isAuthenticated ? renderMyRating(book.id, myRating) : ''}
          ${readProgress > 0 && !isRead ? `<div class="book-detail-progress"><div class="read-progress-bar" role="progressbar" aria-valuenow="${Math.round(readProgress)}" aria-valuemin="0" aria-valuemax="100"><div class="read-progress-fill" style="width:${Math.round(readProgress)}%"></div></div><span class="read-progress-label">${escapeHtml(tp('book.progressLabel', { n: Math.round(readProgress) }))}</span></div>` : ''}
          ${
            details.annotationIsHtml && String(details.annotation || '').trim()
              ? `<div class="book-detail-annotation book-detail-annotation--html">${sanitizeHtml(details.annotation)}</div>`
              : String(details.annotation || '').trim()
                ? `<p class="book-detail-annotation">${escapeHtml(details.annotation)}</p>`
                : ''
          }
          <div class="book-detail-review-mount" data-book-review-mount data-book-review-for="${encodeURIComponent(String(book.id))}" data-review-heading="${escapeHtml(t('book.review'))}" hidden aria-hidden="true"></div>
          ${
            illustrationUrls.length
              ? `<section class="book-detail-side-block book-detail-illustrations"><details class="book-detail-disclosure book-detail-illustrations-disclosure"><summary><span class="book-detail-disclosure-title">${escapeHtml(t('book.illustrations'))}</span><span class="book-detail-disclosure-note">${formatLocaleInt(illustrationUrls.length)}</span></summary><div class="book-detail-illustrations-strip">${illustrationUrls.map((it, idx) => `<a href="${escapeHtml(it.url)}" data-illustration-link data-illustration-index="${idx}"><img src="${escapeHtml(it.url)}" alt="" loading="lazy"></a>`).join('')}</div></details></section>`
              : ''
          }
          <div class="actions actions-primary">
            <a href="${readPagePath(book.id)}" class="button button-primary" target="_blank" rel="noopener noreferrer"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>${escapeHtml(readProgress > 0 && !isRead ? t('home.shelfContinue') : t('home.heroReadBook'))}</a>
            ${renderDownloadMenu(book, { accent: true, user })}
            ${(() => {
              const sendItems = [
                isAuthenticated && canSendToEmailInUi(user) ? `<button type="button" class="download-format-link" ${bookIdDataAttr(book.id)} data-send-to-ereader="1">${escapeHtml(t('book.toEmail'))}</button>` : '',
                isAuthenticated && telegramSendAvailable ? `<button type="button" class="download-format-link" ${bookIdDataAttr(book.id)} data-send-to-telegram="1">${escapeHtml(t('telegram.sendToTelegram'))}</button>` : ''
              ].filter(Boolean);
              return sendItems.length
                ? `<details class="download-menu book-detail-send-menu"><summary class="button download-menu-trigger">${escapeHtml(t('book.send'))}</summary><div class="download-menu-popover">${sendItems.join('')}</div></details>`
                : '';
            })()}
          </div>
        </div>
        ${user?.role === 'admin' ? `<details class="book-edit-disclosure book-edit-disclosure--inline">
          <summary class="book-edit-summary book-edit-summary--inline book-detail-icon-action" title="${escapeHtml(t('book.edit.title'))}" aria-label="${escapeHtml(t('book.edit.title'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </summary>
        <form class="book-edit-form" action="${bookPagePath(book.id, '/edit')}" method="post">
          ${csrfHiddenField(csrfToken)}
          <div class="book-edit-grid">
            <div class="book-edit-field">
              <label for="edit-title">${escapeHtml(t('book.edit.labelTitle'))}</label>
              <input type="text" id="edit-title" name="title" value="${escapeHtml(book.title)}" required>
            </div>
            <div class="book-edit-field">
              <label for="edit-authors">${escapeHtml(t('book.edit.labelAuthors'))}</label>
              <input type="text" id="edit-authors" name="authors" value="${escapeHtml(book.authors || '')}">
              <span class="book-edit-hint">${escapeHtml(t('book.edit.authorsHint'))}</span>
            </div>
            <div class="book-edit-field">
              <label for="edit-series">${escapeHtml(t('book.edit.labelSeries'))}</label>
              <input type="text" id="edit-series" name="series" value="${escapeHtml(book.series || '')}">
            </div>
            <div class="book-edit-field">
              <label for="edit-series-no">${escapeHtml(t('book.edit.labelSeriesNo'))}</label>
              <input type="text" id="edit-series-no" name="seriesNo" value="${escapeHtml(book.seriesNo || '')}" class="book-edit-short">
            </div>
            <div class="book-edit-field">
              <label for="edit-genres">${escapeHtml(t('book.edit.labelGenres'))}</label>
              <input type="text" id="edit-genres" name="genres" value="${escapeHtml(book.genres || '')}">
            </div>
            <div class="book-edit-field">
              <label for="edit-lang">${escapeHtml(t('book.edit.labelLang'))}</label>
              <input type="text" id="edit-lang" name="lang" value="${escapeHtml(book.lang || '')}" class="book-edit-short">
            </div>
            <div class="book-edit-field">
              <label for="edit-date">${escapeHtml(t('book.edit.labelDate'))}</label>
              <input type="text" id="edit-date" name="date" value="${escapeHtml(book.date || '')}" class="book-edit-short">
            </div>
            <div class="book-edit-field">
              <label for="edit-keywords">${escapeHtml(t('book.edit.labelKeywords'))}</label>
              <input type="text" id="edit-keywords" name="keywords" value="${escapeHtml(book.keywords || '')}">
            </div>
            <div class="book-edit-field">
              <label for="edit-lib-rate">${escapeHtml(t('book.edit.labelLibRate'))}</label>
              <input type="number" id="edit-lib-rate" name="libRate" value="${escapeHtml(String(book.libRate || ''))}" min="0" max="5" step="1" class="book-edit-short">
            </div>
          </div>
          <div class="book-edit-actions">
            <button type="submit" class="button-primary">${escapeHtml(t('book.edit.save'))}</button>
            <button type="button" class="button" data-book-edit-cancel>${escapeHtml(t('common.cancel'))}</button>
          </div>
        </form>
        </details>` : ''}
      </div>
    </section>
    ${user?.role === 'admin' && flash ? `<section class="book-edit-flash">${renderAlert('success', flash)}</section>` : ''}
    <section class="library-shelf library-shelf-secondary book-detail-related-shelf">
      <div class="section-title">
        <h2>${escapeHtml(similar.title || t('book.similar'))}</h2>
      </div>
      ${similar.items?.length ? renderBookGrid(similar.items, { isAuthenticated, batchSelect: false, user, readBookIds }) : renderEmptyState({ title: t('book.similarEmptyTitle'), text: t('book.similarEmptyText') })}
    </section>`;
  return pageShell({ title: book.title, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: parentLibraryLabel, href: parentLibraryHref }, { label: book.title }], currentPath: '', csrfToken, readBookIds });
}


function favoritesPaginationBase(view, sort, order) {
  const params = new URLSearchParams({ view, sort });
  if (order) params.set('order', order);
  return `/favorites?${params.toString()}`;
}

export function renderFavorites({
  books = [], readBooks = [], authors = [], series = [],
  view = 'books', sort = 'title', order = '', page = 1, pageSize = 24, total = 0,
  user, stats, indexStatus, csrfToken = '', readBookIds = null, readSeriesNames = null, userStats = null
}) {
  const navCounts = userStats ? {
    books: userStats.bookmarkCount,
    authors: userStats.favoriteAuthorsCount,
    series: userStats.favoriteSeriesCount,
    shelves: (Number(userStats.shelvesCount) || 0) + (Number(userStats.smartShelvesCount) || 0),
    read: userStats.readBooksCount
  } : null;
  const currentView = ['books', 'read', 'authors', 'series'].includes(view) ? view : 'books';
  const totalN = Math.max(0, Math.floor(Number(total) || 0));
  const pageHint = totalN > 0 && (currentView === 'books' || currentView === 'read')
    ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(t('library.countInSection'))}: <strong>${formatLocaleInt(totalN)}</strong> ${plural('book', totalN)}${page > 1 ? ` ${escapeHtml(t('library.pageSep'))} <strong>${formatLocaleInt(page)}</strong>` : ''}</div>`
    : '';
  const booksPagination = totalN > pageSize
    ? renderPagination(favoritesPaginationBase('books', sort, order), page, pageSize, totalN)
    : '';
  const readPagination = totalN > pageSize
    ? renderPagination(favoritesPaginationBase('read', sort, order), page, pageSize, totalN)
    : '';
  const bookSortOptions = [
    { value: 'date', label: t('sort.byDateAdded') },
    { value: 'title', label: t('sort.byTitle') },
    { value: 'author', label: t('sort.byAuthor') },
    { value: 'rating', label: t('sort.byRating') }
  ];
  const entitySortOptions = [
    { value: 'date', label: t('sort.byDateAdded') },
    { value: 'name', label: t('sort.byName') },
    { value: 'count', label: t('sort.byBookCountAlt') }
  ];
  const booksSection = `
    <section class="library-shelf library-shelf-secondary favorites-section favorites-section-books">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.books'))}</h2>
        ${books.length ? `<div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: bookSortOptions, extraHidden: { view: 'books' } })}</div>` : ''}
      </div>
      ${pageHint}
      ${books.length ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderFavoriteBookGrid(books, { batchSelect: true, user, readBookIds })}</div>${booksPagination}` : renderEmptyState({ title: t('favorites.emptyBooksTitle'), text: t('favorites.emptyBooksText'), actionHref: '/catalog', actionLabel: t('favorites.toCatalog'), secondaryHref: '/library/recent', secondaryLabel: t('library.openRecent') })}
    </section>`;
  const readSection = `
    <section class="library-shelf library-shelf-secondary favorites-section favorites-section-books">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.read'))}</h2>
        ${readBooks.length ? `<div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: bookSortOptions, extraHidden: { view: 'read' } })}</div>` : ''}
      </div>
      ${pageHint}
      ${readBooks.length ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderFavoriteBookGrid(readBooks, { batchSelect: true, user, readBookIds })}</div>${readPagination}` : renderEmptyState({ title: t('favorites.emptyReadTitle'), text: t('favorites.emptyReadText'), actionHref: '/library/continue', actionLabel: t('favorites.emptyReadAction'), secondaryHref: '/catalog', secondaryLabel: t('favorites.toCatalog') })}
    </section>`;
  const authorsSection = `
    <section class="library-shelf library-shelf-secondary favorites-section">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.authors'))}</h2>
        ${authors.length ? `<div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: entitySortOptions, extraHidden: { view: 'authors' } })}</div>` : ''}
      </div>
      <div class="table-list entity-list favorites-list">
        ${authors.map((item) => {
          const label = formatAuthorLabel(item.displayName || item.name) || item.displayName || item.name;
          const initial = String(label || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase() || '?';
          const portraitSrc = `/api/authors/portrait?name=${encodeURIComponent(item.name)}`;
          const coverFallback = item.coverBookId
            ? apiBookPath(item.coverBookId, 'cover-thumb')
            : '';
          const onError = coverFallback
            ? `if(this.dataset.fallbackCover&&this.src!==this.dataset.fallbackCover){this.src=this.dataset.fallbackCover;this.removeAttribute('data-fallback-cover');return;}const p=this.parentElement;this.remove();if(p)p.classList.add('is-fallback')`
            : `const p=this.parentElement;this.remove();if(p)p.classList.add('is-fallback')`;
          return `
          <div class="table-row account-list-row favorites-row">
            <a class="account-list-row-main favorites-entity-link" href="/facet/authors/${encodeURIComponent(item.name)}">
              <span class="favorites-author-avatar" aria-hidden="true">
                <img class="favorites-author-portrait" src="${escapeHtml(portraitSrc)}"${coverFallback ? ` data-fallback-cover="${escapeHtml(coverFallback)}"` : ''} alt="" loading="lazy" onerror="${onError}">
                <span class="favorites-author-initial">${escapeHtml(initial)}</span>
              </span>
              <span class="favorites-entity-text">
                <strong>${escapeHtml(label)}</strong>
                ${item.bookCount != null ? `<span class="muted">${countLabel('book', item.bookCount)}</span>` : ''}
              </span>
            </a>
            ${renderListRemoveBtn({ extraAttrs: `data-favorite-author="${escapeHtml(item.name)}"` })}
          </div>`;
        }).join('') || renderEmptyState({ title: t('favorites.emptyAuthorsTitle'), text: t('favorites.emptyAuthorsText'), actionHref: '/authors', actionLabel: t('favorites.openAuthors') })}
      </div>
    </section>`;
  const seriesSection = `
    <section class="library-shelf library-shelf-secondary favorites-section">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.series'))}</h2>
        ${series.length ? `<div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: entitySortOptions, extraHidden: { view: 'series' } })}</div>` : ''}
      </div>
      <div class="table-list entity-list favorites-list">
        ${series.map((item) => {
          const previews = Array.isArray(item.previewBookIds) ? item.previewBookIds : [];
          return `
          <div class="table-row account-list-row favorites-row">
            <a class="account-list-row-main shelf-row-info" href="/facet/series/${encodeURIComponent(item.name)}">
              <span class="account-list-row-title">
                <strong>${escapeHtml(item.displayName || item.name)}</strong>
                ${readSeriesNames && readSeriesNames.has(item.name) ? `<span class="read-series-badge">${READ_CHECK_SVG}</span>` : ''}
              </span>
              ${item.bookCount != null ? `<br><span class="muted">${countLabel('book', item.bookCount)}</span>` : ''}
              ${previews.length ? `
                <div class="shelf-covers-preview">
                  ${previews.map((bookId) => `<img class="shelf-cover-thumb" src="${apiBookPath(bookId, 'cover-thumb')}" alt="" loading="lazy" onerror="this.style.display='none'">`).join('')}
                </div>
              ` : ''}
            </a>
            ${renderListRemoveBtn({ extraAttrs: `data-favorite-series="${escapeHtml(item.name)}"` })}
          </div>`;
        }).join('') || renderEmptyState({ title: t('favorites.emptySeriesTitle'), text: t('favorites.emptySeriesText'), actionHref: '/series', actionLabel: t('favorites.openSeries') })}
      </div>
    </section>`;
  const sectionContent = currentView === 'authors'
    ? authorsSection
    : currentView === 'series'
      ? seriesSection
      : currentView === 'read'
        ? readSection
        : booksSection;
  const content = `
    <div data-favorites-view="${escapeHtml(currentView)}">
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(t('favorites.title'))}</h1>
        <p>${escapeHtml(t('favorites.subtitle'))}</p>
      </div>
    </section>
    ${renderFavoritesNav(currentView, navCounts)}
    ${sectionContent}
    </div>`;
  return pageShell({ title: t('favorites.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('favorites.title') }], currentPath: '/favorites', csrfToken, readBookIds });
}


export function renderBrowsePage({ title, items, total, page, pageSize, user, stats, query, letter = '', path, facetBasePath, indexStatus, sort, order = '', csrfToken = '', readSeriesNames = null }) {
  const letterParam = letter ? `&letter=${encodeURIComponent(letter)}` : '';
  const paginationBase = `${path}?sort=${encodeURIComponent(sort || 'count')}${letterParam}`;
  const browseLabels = { '/authors': t('nav.authors'), '/series': t('nav.series'), '/genres': t('nav.genres'), '/languages': t('nav.languages') };
  const letterHint = letter && !query
    ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(tp('catalog.letterResults', { letter: letter.toUpperCase() }))}</div>`
    : '';
  const resetHref = `${path}?sort=${encodeURIComponent(sort || 'count')}`;
  const content = `
    <section class="page-intro catalog-page-intro">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(t('browse.intro'))}</p>
      </div>
      <form class="search-form browse-filter" action="${path}" method="get">
        <input name="q" value="${escapeHtml(query || '')}" placeholder="${escapeHtml(t('browse.placeholder'))}">
        <input type="hidden" name="sort" value="${escapeHtml(sort || 'count')}">
        ${order ? `<input type="hidden" name="order" value="${escapeHtml(order)}">` : ''}
        ${letter ? `<input type="hidden" name="letter" value="${escapeHtml(letter)}">` : ''}
        <button type="submit" class="button">${escapeHtml(t('browse.submit'))}</button>
        ${query || letter ? `<a class="button" href="${escapeHtml(resetHref)}">${escapeHtml(t('browse.reset'))}</a>` : ''}
      </form>
      <div class="actions">
        ${renderSortControl({
          action: path,
          sort,
          order,
          query,
          extraHidden: letter ? { letter } : {},
          options: [
            { value: 'count', label: t('sort.byBookCount') },
            { value: 'name', label: t('sort.byName') }
          ]
        })}
      </div>
    </section>
    ${letterHint}
    <div class="list-context-hint list-context-hint-spacious">${browseTotalLine(path, total, query)}</div>
    ${renderEntityGrid(items, facetBasePath, query || letter ? t('browse.emptyFiltered') : t('browse.empty'), readSeriesNames)}
    ${renderPagination(paginationBase, page, pageSize, total, query)}
  `;
  const alphabet = { path, sort: 'name', label: browseLabels[path] || title, activeLetter: letter };
  return pageShell({ title, content, user, stats, query, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: title }], alphabet, currentPath: path, csrfToken });
}

/** Series page icon buttons, same look and order as the book page corner (want → read → favorite → shelf). */
function renderSeriesIconActions({ name, hasBooks, favorite, seriesRead, want }) {
  const attr = escapeHtml(name);
  const btn = (cls, active, label, data, svg) => `<button class="book-detail-icon-action ${cls}${active ? ' is-active' : ''}" type="button" ${data} aria-pressed="${active ? 'true' : 'false'}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${svg}</button>`;
  return `<div class="book-detail-corner-actions series-icon-actions">
          ${hasBooks && !seriesRead ? btn('book-detail-want-action', want, want ? t('series.inWant') : t('series.addWant'), `data-series-want="${attr}"`, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.8h10a.8.8 0 0 1 .8.8v15.6L12 16.4l-5.8 3.8V4.6a.8.8 0 0 1 .8-.8z"/></svg>') : ''}
          ${hasBooks ? btn('book-detail-read-action', seriesRead, seriesRead ? t('facet.seriesMarkedRead') : t('facet.markSeriesRead'), `data-mark-series-read="${attr}"`, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 16.7 19 7"/></svg>') : ''}
          ${btn('book-detail-bookmark-action', favorite, favorite ? t('facet.inFavorite') : t('facet.addFavorite'), `data-favorite-series="${attr}"${favorite ? ' data-active-favorite="true"' : ''}`, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.4s-6.8-4.2-6.8-8.8A3.8 3.8 0 0 1 12 8.1a3.8 3.8 0 0 1 6.8 3.5c0 4.6-6.8 8.8-6.8 8.8z"/></svg>')}
          ${hasBooks ? `<button class="book-detail-icon-action book-detail-shelf-action" type="button" data-add-series-to-shelf="${attr}" aria-label="${escapeHtml(t('series.toShelf'))}" title="${escapeHtml(t('series.toShelf'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16"/><path d="M6.5 19V8.2c0-.7.6-1.2 1.3-1.2H10V19"/><path d="M10 19V6.2c0-.7.6-1.2 1.3-1.2H14V19"/><path d="M14 19V9.2c0-.7.6-1.2 1.3-1.2H18V19"/></svg></button>` : ''}
        </div>`;
}

/** «Прочитано N из M» + one «Продолжить» / «Читать следующую» button on a series page (signed-in users, 2+ volumes). */
function renderSeriesProgress(progress) {
  if (!progress || progress.total < 2) return '';
  const pct = Math.round((progress.read / progress.total) * 100);
  const label = tp('series.progress', { read: formatLocaleInt(progress.read), total: formatLocaleInt(progress.total) });
  const next = progress.next;
  const current = progress.current;
  // One button: «Продолжить» for a started volume, otherwise «Читать следующую» right after a read volume.
  const showNext = Boolean(!current && next?.prevRead);
  const nextTitle = next ? `${next.seriesNo ? `${next.seriesNo}. ` : ''}${next.title}` : '';
  const currentTitle = current ? `${current.seriesNo ? `${current.seriesNo}. ` : ''}${current.title}` : '';
  return `<div class="series-progress">
      <div class="series-progress-head">
        <span class="series-progress-label">${escapeHtml(label)}</span>
        ${next ? '' : `<span class="series-progress-done">${escapeHtml(t('series.allRead'))}</span>`}
      </div>
      <div class="series-progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(label)}"><span style="width:${pct}%"></span></div>
      ${current ? `<div class="series-progress-next">
        <a class="button button-primary" href="${readPagePath(current.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('series.continue'))}</a>
        <a class="series-progress-next-title" href="${bookPagePath(current.id)}">${escapeHtml(currentTitle)}</a>
        <span class="read-progress-label">${escapeHtml(`${Math.round(current.progress)}%`)}</span>
      </div>` : ''}
      ${showNext ? `<div class="series-progress-next">
        <a class="button button-primary" href="${readPagePath(next.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('series.readNext'))}</a>
        <a class="series-progress-next-title" href="${bookPagePath(next.id)}">${escapeHtml(nextTitle)}</a>
      </div>` : ''}
    </div>`;
}

export function renderFacetBooks({ title, items, total, page, pageSize, user, stats, facetPath, indexStatus, sort, order = '', breadcrumbs, summary = {}, facet = '', facetValue = '', favorite = false, seriesRead = false, seriesProgress = null, csrfToken = '', readBookIds = null, view = 'books', entityItems = null, authorFilter = '', listView = false, layout = '', lang = '', langs = [] }) {
  const isGenre = facet === 'genres';
  const isLang = facet === 'languages';
  const isEntityView = (isGenre || isLang) && (view === 'authors' || view === 'series');
  const facetAction = user && facet === 'authors'
    ? `<button class="button ${favorite ? 'is-active' : ''}" type="button" data-favorite-author="${escapeHtml(facetValue)}" ${favorite ? 'data-active-favorite="true"' : ''}>${favorite ? escapeHtml(t('facet.inFavorite')) : escapeHtml(t('facet.addFavorite'))}</button>`
    : '';
  // Series: the book page icon set in the same order (хочу → прочитано → избранное → полка).
  const seriesActions = user && facet === 'series' ? renderSeriesIconActions({
    name: facetValue, hasBooks: items.length > 0, favorite, seriesRead, want: Boolean(seriesProgress?.want)
  }) : '';
  const batchCtx = facet === 'series' && facetValue !== '' ? { facet: 'series', value: facetValue } : null;
  const showBatch = !isEntityView && Boolean(batchCtx && items.length && canDownloadInUi(user));
  const scopeDownload = !isEntityView && Boolean(batchCtx && total > 0)
    ? renderScopeDownloadMenu(batchCtx, { user })
    : '';

  // View switcher tabs for genre/language pages: Books | By authors | By series
  const viewTabs = (isGenre || isLang) ? (() => {
    const buildHref = (v) => {
      const params = new URLSearchParams();
      if (v !== 'books') params.set('view', v);
      if (layout === 'list' || layout === 'grid') params.set('layout', layout);
      if (lang) params.set('lang', lang);
      // Reset sort because allowed sort values differ between views
      const qs = params.toString();
      return `${facetPath}${qs ? `?${qs}` : ''}`;
    };
    const tab = (v, label) => `<a class="button${view === v ? ' is-active' : ''}" href="${escapeHtml(buildHref(v))}">${escapeHtml(label)}</a>`;
    return `<div class="facet-view-tabs">${tab('books', t('facet.viewBooks'))}${tab('authors', t('facet.viewByAuthors'))}${tab('series', t('facet.viewBySeries'))}</div>`;
  })() : '';

  // Sort options + paging base differ between book view and entity view
  const sortOptions = isEntityView
    ? [
        { value: 'count', label: t('sort.byBookCount') },
        { value: 'name', label: t('sort.byName') }
      ]
    : [
        { value: 'recent', label: t('sort.recentFirst') },
        { value: 'title', label: t('sort.byTitle') },
        { value: 'author', label: t('sort.byAuthor') },
        { value: 'series', label: t('sort.bySeries') },
        { value: 'rating', label: t('sort.byRating') }
      ];
  const bookLayout = layout === 'list' || layout === 'grid' ? layout : (listView ? 'list' : 'grid');
  const sortExtraHidden = {
    ...(isEntityView ? { view } : {}),
    ...(authorFilter ? { author: authorFilter } : {}),
    ...(!isEntityView ? { layout: bookLayout } : {}),
    ...(lang ? { lang } : {})
  };
  const paginationBaseParams = new URLSearchParams();
  if (isEntityView) {
    paginationBaseParams.set('view', view);
    paginationBaseParams.set('sort', sort || 'count');
  } else {
    paginationBaseParams.set('sort', sort || 'recent');
    if (authorFilter) paginationBaseParams.set('author', authorFilter);
    paginationBaseParams.set('layout', bookLayout);
  }
  if (order) paginationBaseParams.set('order', order);
  if (lang) paginationBaseParams.set('lang', lang);
  const paginationBase = `${facetPath}?${paginationBaseParams.toString()}`;

  // Body block: either entity grid or book grid
  const entityBasePath = view === 'authors' ? '/facet/authors' : '/facet/series';
  const bodyBlock = isEntityView
    ? (entityItems && entityItems.length
        ? renderEntityGrid(entityItems, entityBasePath, t('browse.empty'))
        : renderEmptyState({ title: t('facet.emptyTitle'), text: t('facet.emptyText'), actionHref: facetPath, actionLabel: t('facet.viewBooks') }))
    : !items.length
      ? renderEmptyState({ title: t('facet.emptyTitle'), text: t('facet.emptyText'), actionHref: '/', actionLabel: t('facet.toCatalog') })
      : (listView
        ? renderBookFlibustaList(items, { user, batchSelect: showBatch })
        : renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: showBatch, user, readBookIds, seriesContext: facet === 'series' ? facetValue : null }));

  const countLabelKey = isEntityView ? (view === 'authors' ? 'author' : 'series') : 'book';
  const layoutToggle = isEntityView
    ? ''
    : (() => {
      const params = new URLSearchParams();
      if (view && view !== 'books') params.set('view', view);
      if (sort) params.set('sort', sort);
      if (order) params.set('order', order);
      if (authorFilter) params.set('author', authorFilter);
      if (lang) params.set('lang', lang);
      params.set('layout', listView ? 'grid' : 'list');
      return renderViewToggle({ href: `${facetPath}?${params.toString()}`, isListView: listView });
    })();
  const langControl = isLang
    ? ''
    : renderLangFilterControl({
      action: facetPath,
      lang,
      langs,
      extraHidden: { ...sortExtraHidden, lang: '', sort, order }
    });

  // Series: a hero like the book page (first volume cover, corner icons, progress); controls go in a row below.
  const seriesHeroBookId = facet === 'series' && !isEntityView ? (seriesProgress?.current?.id || seriesProgress?.next?.id || items[0]?.id || '') : '';
  const seriesHero = seriesHeroBookId ? `
    <section class="book-detail-shell series-facet-hero" style="--detail-cover:url('${escapeHtml(apiBookPath(seriesHeroBookId, 'cover'))}')">
      <div class="book-detail-main card-detail-panel">
        <div class="book-detail-cover">
          <div class="cover">
            <img class="cover-image" src="${apiBookPath(seriesHeroBookId, 'cover')}" alt="${escapeHtml(title)}">
          </div>
        </div>
        <div class="book-detail-content">
          ${seriesActions}
          <h1 class="book-detail-title">${escapeHtml(title)}</h1>
          <div class="muted author-facet-count-line">${escapeHtml(t('facet.inSectionCount'))} <strong>${formatLocaleInt(Math.max(0, Math.floor(Number(total) || 0)))}</strong> ${plural('book', total)}</div>
          ${user ? renderSeriesProgress(seriesProgress) : ''}
        </div>
      </div>
    </section>` : '';
  const facetBatchInner = `
    ${seriesHero}
    <section class="page-intro page-intro-slim${seriesHero ? ' author-facet-controls' : ''}">
      ${seriesHero ? '' : `<div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
      </div>`}
      <div class="page-intro-actions">
        ${facetAction}
        ${scopeDownload}
        ${isEntityView ? '' : renderHideReadToggle(user)}
        ${layoutToggle}
        ${langControl}
        ${renderSortControl({
          action: facetPath,
          sort,
          order,
          options: sortOptions,
          extraHidden: sortExtraHidden
        })}
      </div>
    </section>
    ${viewTabs}
    ${!seriesHero && facet === 'series' && user ? renderSeriesProgress(seriesProgress) : ''}
    ${showBatch ? renderBatchDownloadToolbar(batchCtx, { user }) : ''}
    <div class="list-context-hint list-context-hint-spacious">${escapeHtml(t('facet.inSectionCount'))} <strong>${formatLocaleInt(Math.max(0, Math.floor(Number(total) || 0)))}</strong> ${plural(countLabelKey, total)}${page > 1 ? ` ${escapeHtml(t('library.pageSep'))} <strong>${formatLocaleInt(page)}</strong>` : ''}</div>
    ${bodyBlock}
    ${renderPagination(paginationBase, page, pageSize, total)}
  `;
  const content = `
    ${showBatch ? `<div class="batch-select-scope">${facetBatchInner}</div>` : facetBatchInner}
    ${(summary.relatedItems?.length || summary.secondaryItems?.length) ? `
      <div class="facet-summary-group">
        ${renderFacetSummaryBlock(summary.relatedTitle, summary.relatedItems, summary.relatedPath)}
        ${renderFacetSummaryBlock(summary.secondaryTitle, summary.secondaryItems, summary.secondaryPath)}
      </div>
    ` : ''}
  `;
  const sectionPath = breadcrumbs[1]?.href || '/catalog';
  return pageShell({ title, content, user, stats, indexStatus, breadcrumbs, currentPath: sectionPath, csrfToken, readBookIds });
}

export function renderAuthorFacetPage({
  title,
  displayName,
  series = [],
  standaloneBooks = [],
  total = 0,
  user,
  stats,
  facetPath,
  indexStatus,
  sort,
  order = '',
  view = 'series',
  breadcrumbs,
  summary = {},
  facetValue = '',
  favorite = false,
  csrfToken = '',
  authorPortraitUrl = '',
  authorBioHtml = '',
  readSeriesNames = null,
  seriesReadCounts = null,
  lang = '',
  langs = []
}) {
  const facetAction = user
    ? `<button class="button ${favorite ? 'is-active' : ''}" type="button" data-favorite-author="${escapeHtml(facetValue)}" ${favorite ? 'data-active-favorite="true"' : ''}>${favorite ? escapeHtml(t('facet.inFavorite')) : escapeHtml(t('facet.addFavorite'))}</button>`
    : '';
  const isListView = view === 'list';

  const heroPortrait = authorPortraitUrl
    ? `<img class="cover-image is-loaded author-facet-portrait" src="${escapeHtml(authorPortraitUrl)}" alt="" loading="lazy">`
    : '';
  const heroFallback = authorPortraitUrl
    ? ''
    : `<span class="cover-fallback author-facet-fallback" aria-hidden="true">
              ${renderCoverFallbackImage()}
        <span class="cover-fallback-overlay"></span>
        <span class="cover-fallback-copy">
          <span class="cover-fallback-title">${escapeHtml(displayName || title)}</span>
        </span>
      </span>`;
  const bioBlock =
    authorBioHtml && String(authorBioHtml).trim()
      ? `<section class="book-detail-side-block author-facet-bio-block"><h3>${escapeHtml(t('book.aboutAuthor'))}</h3><div class="book-detail-author-bio book-detail-author-bio--facet">${sanitizeHtml(authorBioHtml)}</div></section>`
      : '';

  // Жанры автора — чипами в hero, а не сиротским блоком под списком книг.
  const genreChips =
    summary.secondaryItems?.length && summary.secondaryPath
      ? `<div class="author-facet-genres" aria-label="${escapeHtml(summary.secondaryTitle || '')}">${
          summary.secondaryItems.slice(0, 8).map((item) => `<a class="author-facet-genre-chip" href="${summary.secondaryPath}/${encodeURIComponent(item.name)}">${escapeHtml(item.displayName || item.name)}</a>`).join('')
        }</div>`
      : '';

  const hero = `
    <section class="book-detail-shell author-facet-hero">
      <div class="book-detail-main card-detail-panel">
        <div class="book-detail-cover">
          <div class="cover ${authorPortraitUrl ? '' : 'cover-fallback-active'}">
            ${heroPortrait}
            ${heroFallback}
          </div>
        </div>
        <div class="book-detail-content">
          <h1 class="book-detail-title">${escapeHtml(displayName || title)}</h1>
          <div class="muted author-facet-count-line">${escapeHtml(t('facet.inSectionCount'))} <strong>${formatLocaleInt(Math.max(0, Math.floor(Number(total) || 0)))}</strong> ${plural('book', total)}</div>
          ${genreChips}
          ${bioBlock}
        </div>
      </div>
    </section>`;

  const authorViewQuery = (nextView) => {
    const params = new URLSearchParams();
    if (sort) params.set('sort', sort);
    if (order) params.set('order', order);
    if (lang) params.set('lang', lang);
    params.set('view', nextView);
    return `${facetPath}?${params.toString()}`;
  };
  const authorViewValue = isListView ? 'list' : 'series';
  const controls = `
    <section class="page-intro page-intro-slim author-facet-controls">
      <div class="page-intro-actions author-facet-controls-actions">
        ${facetAction}
        ${total > 0 ? renderScopeDownloadMenu({ facet: 'authors', value: facetValue }, { user }) : ''}
        ${renderHideReadToggle(user)}
        ${renderViewToggle({ href: authorViewQuery(isListView ? 'series' : 'list'), isListView })}
        ${renderLangFilterControl({ action: facetPath, lang, langs, extraHidden: { view: authorViewValue, sort, order } })}
        ${renderSortControl({
          action: facetPath,
          sort,
          order,
          options: [
            { value: 'series', label: t('sort.bySeries') },
            { value: 'count', label: t('sort.byBookCountAlt') },
            { value: 'recent', label: t('sort.recentFirst') }
          ],
          extraHidden: { view: authorViewValue, ...(lang ? { lang } : {}) }
        })}
      </div>
    </section>`;

  const anyBooks = series.some((s) => (Number(s.bookCount) || 0) > 0 || (Array.isArray(s.books) && s.books.length)) || standaloneBooks.length > 0;
  const outsideSeriesSort = sort === 'recent' ? 'recent' : 'title';
  const outsideSeriesHref = facetValue
    ? `/facet/authors/${encodeURIComponent(facetValue)}/outside-series?sort=${encodeURIComponent(outsideSeriesSort)}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`
    : '';
  const seriesListHtml = (series.length || standaloneBooks.length)
    ? `<section class="library-shelf library-shelf-secondary author-facet-series-block">${renderAuthorFacetSeriesList(series, standaloneBooks.length ? { href: outsideSeriesHref, label: t('authorPage.outsideSeries'), bookCount: standaloneBooks.length } : null, readSeriesNames, facetValue, seriesReadCounts)}</section>`
    : '';
  const listBatch = Boolean(isListView && canDownloadInUi(user) && (
    series.some((s) => Array.isArray(s.books) && s.books.length) || standaloneBooks.length
  ));
  const flibustaListHtml = renderAuthorFlibustaList({
    series,
    standaloneBooks,
    authorName: facetValue,
    user,
    batchSelect: listBatch
  });
  const listsCombined = isListView
    ? (flibustaListHtml
      ? `<section class="library-shelf library-shelf-secondary author-facet-list-block">${
          listBatch
            ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${flibustaListHtml}</div>`
            : flibustaListHtml
        }</section>`
      : '')
    : seriesListHtml;

  const booksInner = !anyBooks
    ? renderEmptyState({
        title: t('facet.emptyTitle'),
        text: t('facet.emptyText'),
        actionHref: '/',
        actionLabel: t('facet.toCatalog')
      })
    : listsCombined;

  const content = `
    ${hero}
    ${controls}
    ${booksInner}
  `;
  const sectionPath = breadcrumbs[1]?.href || '/authors';
  return pageShell({
    title,
    content,
    user,
    stats,
    indexStatus,
    breadcrumbs,

    currentPath: sectionPath,
    csrfToken,
    readSeriesNames
  });
}

export function renderAuthorOutsideSeriesPage({
  title,
  displayName,
  books = [],
  total = 0,
  user,
  stats,
  indexStatus,
  sort,
  order = '',
  facetPath,
  breadcrumbs = [],
  favorite = false,
  facetValue = '',
  csrfToken = '',
  readBookIds = null,
  listView = false,
  layout = '',
  lang = '',
  langs = []
}) {
  const facetAction = user
    ? `<button class="button ${favorite ? 'is-active' : ''}" type="button" data-favorite-author="${escapeHtml(facetValue)}" ${favorite ? 'data-active-favorite="true"' : ''}>${favorite ? escapeHtml(t('facet.inFavorite')) : escapeHtml(t('facet.addFavorite'))}</button>`
    : '';
  const outsideBatch = Boolean(books.length && canDownloadInUi(user));
  const bookLayout = layout === 'list' || layout === 'grid' ? layout : (listView ? 'list' : 'grid');
  const layoutHref = (() => {
    const params = new URLSearchParams();
    if (sort) params.set('sort', sort);
    if (order) params.set('order', order);
    if (lang) params.set('lang', lang);
    params.set('layout', listView ? 'grid' : 'list');
    return `${facetPath}?${params.toString()}`;
  })();
  const controls = `
    <section class="page-intro page-intro-slim author-facet-controls">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(displayName)}</p>
      </div>
      <div class="page-intro-actions author-facet-controls-actions">
        ${facetAction}
        ${renderHideReadToggle(user)}
        ${renderViewToggle({ href: layoutHref, isListView: listView })}
        ${renderLangFilterControl({ action: facetPath, lang, langs, extraHidden: { layout: bookLayout, sort, order } })}
        ${renderSortControl({
          action: facetPath,
          sort,
          order,
          options: [
            { value: 'recent', label: t('sort.recentFirst') },
            { value: 'title', label: t('sort.byTitle') }
          ],
          extraHidden: { layout: bookLayout, ...(lang ? { lang } : {}) }
        })}
      </div>
    </section>`;
  const booksBlock = books.length
    ? (listView
      ? renderBookFlibustaList(books, { user, batchSelect: outsideBatch })
      : renderBookGrid(books, { isAuthenticated: Boolean(user), batchSelect: outsideBatch, user, readBookIds }))
    : renderEmptyState({ title: t('facet.emptyTitle'), text: t('facet.emptyText'), actionHref: `/facet/authors/${encodeURIComponent(facetValue)}`, actionLabel: t('facet.toCatalog') });
  const outsideInner = `
    ${controls}
    ${outsideBatch ? renderBatchDownloadToolbar({ adhoc: true }, { user }) : ''}
    <div class="list-context-hint list-context-hint-spacious">${escapeHtml(t('facet.inSectionCount'))} <strong>${formatLocaleInt(Math.max(0, Math.floor(Number(total) || 0)))}</strong> ${plural('book', total)}</div>
    ${booksBlock}
  `;
  const content = outsideBatch ? `<div class="batch-select-scope">${outsideInner}</div>` : outsideInner;
  const sectionPath = breadcrumbs[1]?.href || '/authors';
  return pageShell({
    title,
    content,
    user,
    stats,
    indexStatus,
    breadcrumbs,

    currentPath: sectionPath,
    csrfToken,
    readBookIds
  });
}

function summarizeSmartShelfQuery(query) {
  const p = new URLSearchParams(String(query || ''));
  const parts = [];
  if (p.get('q')) parts.push(tp('smartShelves.filter.q', { value: p.get('q') }));
  for (const g of p.getAll('genre')) parts.push(tp('catalog.filter.genre', { value: formatGenreLabel(g) }));
  if (p.get('lang')) parts.push(tp('catalog.filter.lang', { value: p.get('lang').toUpperCase() }));
  if (p.get('format')) parts.push(tp('catalog.filter.format', { value: p.get('format').toUpperCase() }));
  if (p.get('year')) parts.push(tp('catalog.filter.year', { value: p.get('year') }));
  if (p.get('minRate')) parts.push(tp('catalog.filter.minRate', { value: p.get('minRate') }));
  if (p.get('hasSeries') === '1') parts.push(t('catalog.filter.hasSeries'));
  if (p.get('hasSeries') === '0') parts.push(t('catalog.filter.noSeries'));
  return parts.join(' · ');
}

function renderShelfHomeForm(action, onHome, csrfToken) {
  return `
    <form method="post" action="${escapeHtml(action)}" class="admin-inline-form">
      ${csrfHiddenField(csrfToken)}
      <input type="hidden" name="on" value="${onHome ? '0' : '1'}">
      <button type="submit" class="button${onHome ? ' is-active' : ''}">${escapeHtml(t(onHome ? 'shelves.home.remove' : 'shelves.home.add'))}</button>
    </form>`;
}

function renderSmartShelvesSection(smartShelves, csrfToken) {
  return `
    <section class="library-shelf">
      <div class="section-title">
        <h2>${escapeHtml(t('smartShelves.title'))}</h2>
      </div>
      <p class="muted">${escapeHtml(t('smartShelves.hint'))}</p>
      ${smartShelves.length ? `
        <div class="table-list entity-list">
          ${smartShelves.map((shelf) => `
            <div class="table-row table-row-clickable account-list-row shelf-list-row" data-href="${escapeHtml(shelf.catalogUrl)}">
              <div class="account-list-row-main shelf-row-info">
                <strong>${escapeHtml(shelf.name)}</strong>
                <br><span class="muted">${escapeHtml(summarizeSmartShelfQuery(shelf.query))}</span>
                ${shelf.bookCount != null ? `<br><span class="muted">${countLabel('book', shelf.bookCount)}</span>` : ''}
                ${shelf.previewBookIds && shelf.previewBookIds.length ? `
                  <div class="shelf-covers-preview">
                    ${shelf.previewBookIds.map((bookId) => `<img class="shelf-cover-thumb" src="${apiBookPath(bookId, 'cover')}" alt="" loading="lazy" onerror="this.style.display='none'">`).join('')}
                  </div>
                ` : ''}
              </div>
              <div class="shelf-row-actions">
                ${renderShelfHomeForm(`/shelves/smart/${shelf.id}/home`, shelf.onHome, csrfToken)}
                <form method="post" action="/shelves/smart/${shelf.id}/delete" class="admin-inline-form" data-confirm="${escapeHtml(tp('smartShelves.deleteConfirm', { name: shelf.name }))}">
                  ${csrfHiddenField(csrfToken)}
                  <button type="submit" class="button-danger">${escapeHtml(t('smartShelves.delete'))}</button>
                </form>
              </div>
            </div>
          `).join('')}
        </div>
      ` : `<p class="muted">${escapeHtml(t('smartShelves.empty'))}</p>`}
    </section>`;
}

export function renderShelves({ shelves = [], smartShelves = [], user, stats, indexStatus, csrfToken = '' }) {
  const content = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(t('shelves.title'))}</h1>
        <p>${escapeHtml(t('shelves.subtitle'))}</p>
      </div>
    </section>
    <section class="library-shelf">
      <div class="section-title">
        <h2>${escapeHtml(t('shelves.listTitle'))}</h2>
      </div>
      <form data-shelf-create>
        <button type="button" class="shelf-create-toggle" data-shelf-create-toggle aria-expanded="false" aria-label="${escapeHtml(t('shelves.create'))}" title="${escapeHtml(t('shelves.create'))}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
        <input type="text" name="name" placeholder="${escapeHtml(t('shelves.newPlaceholder'))}" aria-label="${escapeHtml(t('shelves.newPlaceholder'))}" maxlength="80" autocomplete="off" tabindex="-1" aria-hidden="true">
      </form>
      ${shelves.length ? `
        <div class="table-list entity-list">
          ${shelves.map((shelf) => `
            <div class="table-row table-row-clickable account-list-row shelf-list-row" data-shelf-row="${shelf.id}" data-href="/shelves/${shelf.id}">
              <div class="account-list-row-main shelf-row-info">
                <strong>${escapeHtml(shelf.name)}</strong>
                ${shelf.description ? `<br><span class="muted">${escapeHtml(shelf.description)}</span>` : ''}
                <br><span class="muted">${countLabel('book', shelf.bookCount)}</span>
                ${shelf.previewBookIds && shelf.previewBookIds.length ? `
                  <div class="shelf-covers-preview">
                    ${shelf.previewBookIds.map((bookId) => `<img class="shelf-cover-thumb" src="${apiBookPath(bookId, 'cover')}" alt="" loading="lazy" onerror="this.style.display='none'">`).join('')}
                  </div>
                ` : ''}
              </div>
              <div class="shelf-row-actions">
                ${renderShelfHomeForm(`/shelves/${shelf.id}/home`, shelf.onHome, csrfToken)}
                ${renderListRemoveBtn({
                  titleKey: 'shelves.delete',
                  extraAttrs: `data-shelf-delete="${shelf.id}" data-shelf-name="${escapeHtml(shelf.name)}" data-shelf-description="${escapeHtml(shelf.description || '')}"`
                })}
              </div>
            </div>
          `).join('')}
        </div>
      ` : renderEmptyState({ title: t('shelves.emptyTitle'), text: t('shelves.emptyText') })}
    </section>
    ${renderSmartShelvesSection(smartShelves, csrfToken)}`;
  return pageShell({ title: t('shelves.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('shelves.title') }], currentPath: '/shelves', csrfToken });
}

export function renderShelfDetail({ shelf, books = [], user, stats, indexStatus, csrfToken = '', readBookIds = null }) {
  const uniqueBooks = uniqueBooksById(books);
  const shelfBatch = Boolean(uniqueBooks.length && canDownloadInUi(user));
  const content = `
    ${shelfBatch ? '<div class="batch-select-scope">' : ''}
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(shelf.name)}</h1>
        ${shelf.description ? `<p>${escapeHtml(shelf.description)}</p>` : `<p class="muted">${countLabel('book', uniqueBooks.length)} ${escapeHtml(t('shelves.onShelf'))}</p>`}
      </div>
    </section>
    ${shelfBatch ? renderBatchDownloadToolbar({ shelf: shelf.id }, { user }) : ''}
    ${uniqueBooks.length ? `
      <div class="grid">
        ${uniqueBooks.map((book) => `
          <article class="card" ${bookCardDataAttrs(book.id)}>
            ${shelfBatch ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} ${batchBookIdDataAttr(book.id)} aria-label="${escapeHtml(t('batch.selectAria'))}"></label>` : ''}
            ${renderCardCover(book, { readBookIds, downloadHtml: renderDownloadMenu(book, { compact: true, user }), user })}
            <div class="meta">
              <h3><a href="${bookPagePath(book.id)}">${escapeHtml(book.title)}</a></h3>
              <div class="author">${book.authors ? renderAuthorLinks(book.authorsList, { limit: 1, bookAuthors: book.authors, popoverId: `shelf-a-${book.id}` }) : escapeHtml(t('book.authorUnknown'))}</div>
              ${book.seriesList?.length ? `<div class="card-series">${renderSeriesLinks(book.seriesList, { limit: 1, popoverId: `shelf-s-${book.id}` })}</div>` : ''}
              <div class="card-actions card-actions-favorites">
                <button class="button card-remove-favorite-action" type="button" data-shelf-remove-book="${escapeHtml(book.id)}" data-shelf-id="${shelf.id}">${escapeHtml(t('book.remove'))}</button>
              </div>
            </div>
          </article>
        `).join('')}
      </div>
    ` : renderEmptyState({ title: t('shelfDetail.emptyTitle'), text: t('shelfDetail.emptyText'), actionHref: '/catalog', actionLabel: t('favorites.toCatalog'), secondaryHref: '/shelves', secondaryLabel: t('shelves.listTitle') })}
    ${shelfBatch ? '</div>' : ''}`;
  return pageShell({ title: shelf.name, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('shelves.title'), href: '/shelves' }, { label: shelf.name }], currentPath: '/shelves', csrfToken, readBookIds });
}

export function renderReader({ book, details, user, csrfToken = '', lite = false }) {
  const ext = String(book.ext || 'fb2').toLowerCase();
  const title = details?.title || book.title || t('opds.noTitle');
  const authorLabel = formatAuthorLabel(book.authors) || '';
  const documentTitle = authorLabel ? `${title} \u2014 ${authorLabel}` : title;
  const htmlLang = getLocale() === 'en' ? 'en' : 'ru';
  const backHref = lite ? liteBookPagePath(book.id) : bookPagePath(book.id);
  const readerBackClick = lite
    ? ' onclick="event.preventDefault();if(history.length>1){history.back()}else{location.href=this.getAttribute(\'href\')}"'
    : '';
  const htmlAttrs = lite ? ' data-eink="1" data-lite="1" data-reader-theme="eink"' : '';
  const themeBoot = lite
    ? "document.documentElement.dataset.readerTheme='eink';try{var _ls=JSON.parse(localStorage.getItem('reader-settings-lite')||'{}');if(_ls.chromePinned)document.documentElement.dataset.chromePinned='1'}catch(e){}"
    : `try{var _s=JSON.parse(localStorage.getItem('reader-settings')||'{}'),_d=document.documentElement;_d.dataset.readerTheme=_s.theme||'sepia';if(_s.chromePinned)_d.dataset.chromePinned='1';var _e=_s.einkMode;if(_e==='on'||(_e!=='off'&&${READER_EINK_UA_RE}.test(navigator.userAgent)))_d.dataset.eink='1'}catch(e){document.documentElement.dataset.readerTheme='sepia'}`;
  const liteBoot = lite
    ? `<script>window.__READER_LITE=1;window.__READER_BOOK_PAGE_PATH=${JSON.stringify(backHref)}</script>`
    : '';
  const themeDots = (cls) => READER_THEMES.map((th) => `<button class="${cls}" type="button" data-set-theme="${th}" title="${escapeHtml(t(`reader.theme.${th}`))}" aria-label="${escapeHtml(t(`reader.theme.${th}`))}"><span class="rs-dot-label">${escapeHtml(t(`reader.theme.${th}`))}</span></button>`).join('');
  const quickThemes = lite ? '' : `<div class="rq-themes" role="group" aria-label="${escapeHtml(t('reader.theme'))}">${themeDots('rs-theme-dot rq-theme-dot')}</div>`;
  return `<!DOCTYPE html>
<html lang="${htmlLang}"${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${csrfToken ? `<meta name="csrf-token" content="${escapeHtml(csrfToken)}">` : ''}
<title>${escapeHtml(documentTitle)}</title>
${renderFaviconLinks()}
<link rel="stylesheet" href="/reader.css?v=${STATIC_ASSET_VERSION}">
<script>${themeBoot}</script>
</head>
<body class="chrome-hidden${lite ? ' reader-lite' : ''}">
<script src="${clientI18nScriptUrl()}" defer></script>

<div class="reader-toolbar reader-chrome" id="toolbar">
  <div class="tb-left">
    <a href="${backHref}" class="tb-btn"${readerBackClick} title="${escapeHtml(t('reader.back'))}" aria-label="${escapeHtml(t('reader.backToBook'))}"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></a>
    <div class="tb-meta">
      <span class="tb-title">${escapeHtml(title)}</span>
      <span class="tb-chapter" id="toolbar-chapter">${escapeHtml(t('reader.loading'))}</span>
    </div>
  </div>
  <div class="tb-right">
    <span class="tb-progress" id="progress-text">0%</span>
    <button class="tb-btn" type="button" id="btn-bookmark-add" title="${escapeHtml(t('reader.bookmark'))}" aria-label="${escapeHtml(t('reader.addBookmark'))}">${READER_ICONS.bookmark}</button>
  </div>
</div>

<div id="reader-body">
  <div class="reader-loading" id="reader-loading">
    <div class="reader-spinner"></div>
    <div class="reader-loading-text">${escapeHtml(t('reader.loadingBook'))}</div>
  </div>
</div>

<div class="reader-footer reader-chrome" id="reader-footer">
  <span class="ft-chapter" id="ft-chapter"></span>
  <div class="ft-seek-wrap">
    <input type="range" class="ft-seek" id="ft-seek" name="readerSeek" min="0" max="1" step="0.001" value="0">
  </div>
  <span class="ft-pct" id="ft-pct">0%</span>
</div>

<div class="reader-quick reader-chrome" id="reader-quick" role="toolbar" aria-label="${escapeHtml(t('reader.quickMenu'))}">
  <div class="rq-tiles">
    ${readerQuickTile('btn-toc', 'toc', t('reader.panelToc'), t('reader.toc'))}
    ${readerQuickTile('', 'bookmarks', t('reader.panelBookmarks'), '', 'data-quick-tab="bookmarks"')}
    ${readerQuickTile('', 'notes', t('reader.panelNotes'), '', 'data-quick-tab="notes"')}
    ${readerQuickTile('btn-search', 'search', t('reader.panelSearch'), t('reader.searchBook'))}
    <button class="rq-tile" type="button" id="btn-tts" title="${escapeHtml(t('reader.ttsPlay'))}" aria-label="${escapeHtml(t('reader.tts'))}"><svg class="tts-main-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="tts-main-path" fill="currentColor" d="M8 5v14l11-7z"/></svg><span class="rq-label">${escapeHtml(t('reader.ttsShort'))}</span></button>
    ${readerQuickTile('btn-day-night', 'moon', t('reader.dayNight'), t('reader.dayModeToggle'))}
    ${readerQuickTile('btn-fullscreen', 'fullscreen', t('reader.fullscreenShort'), t('reader.fullscreen'))}
    ${readerQuickTile('btn-settings', 'settings', t('reader.panelSettings'), t('reader.settingsReading'))}
  </div>
  <div class="rq-row">
    <div class="rq-step" role="group" aria-label="${escapeHtml(t('reader.fontSize'))}">
      <button type="button" class="rq-step-btn" id="rq-font-dec" aria-label="${escapeHtml(t('reader.fontSmaller'))}">A&minus;</button>
      <span class="rq-step-val" id="rq-font-val">18</span>
      <button type="button" class="rq-step-btn rq-step-btn-lg" id="rq-font-inc" aria-label="${escapeHtml(t('reader.fontLarger'))}">A+</button>
    </div>
    ${quickThemes}
  </div>
</div>

<div class="reader-tts-dock" id="reader-tts-dock" role="region" aria-hidden="true" aria-label="${escapeHtml(t('reader.ttsBar'))}"></div>

<div class="reader-book-pages" id="reader-book-pages" aria-hidden="true">
  <span class="book-page-num" id="book-page-left"></span>
  <span class="book-page-num" id="book-page-right"></span>
</div>

<div class="reader-sel-menu" id="reader-sel-menu" role="menu" aria-hidden="true">
  <div class="rsm-colors">
    <button type="button" class="rsm-color" data-color="yellow" title="${escapeHtml(t('readerJs.highlight'))}" aria-label="${escapeHtml(t('readerJs.highlight'))}"></button>
    <button type="button" class="rsm-color" data-color="green" title="${escapeHtml(t('readerJs.highlight'))}" aria-label="${escapeHtml(t('readerJs.highlight'))}"></button>
    <button type="button" class="rsm-color" data-color="blue" title="${escapeHtml(t('readerJs.highlight'))}" aria-label="${escapeHtml(t('readerJs.highlight'))}"></button>
    <button type="button" class="rsm-color" data-color="pink" title="${escapeHtml(t('readerJs.highlight'))}" aria-label="${escapeHtml(t('readerJs.highlight'))}"></button>
  </div>
  <span class="rsm-sep"></span>
  <button type="button" class="rsm-btn" id="rsm-note" title="${escapeHtml(t('readerJs.addNote'))}">${escapeHtml(t('readerJs.addNote'))}</button>
  <button type="button" class="rsm-btn" id="rsm-copy" title="${escapeHtml(t('readerJs.copy'))}">${escapeHtml(t('readerJs.copy'))}</button>
  <button type="button" class="rsm-btn rsm-btn-danger" id="rsm-remove" title="${escapeHtml(t('readerJs.remove'))}" hidden>${escapeHtml(t('readerJs.remove'))}</button>
</div>

<div class="reader-note-editor" id="reader-note-editor" aria-hidden="true">
  <div class="rne-card">
    <div class="rne-quote" id="rne-quote"></div>
    <textarea id="rne-text" class="rne-text" rows="4" placeholder="${escapeHtml(t('readerJs.notePlaceholder'))}"></textarea>
    <div class="rne-actions">
      <button type="button" class="rne-btn" id="rne-cancel">${escapeHtml(t('readerJs.cancel'))}</button>
      <button type="button" class="rne-btn rne-btn-primary" id="rne-save">${escapeHtml(t('readerJs.save'))}</button>
    </div>
  </div>
</div>

<div class="panel-overlay" id="panel-overlay">
  <button type="button" class="panel-backdrop" id="panel-backdrop" tabindex="-1" aria-label="${escapeHtml(t('reader.closePanel'))}"></button>
  <div class="panel">
    <div class="panel-header">
      <button type="button" class="panel-back" id="panel-back" hidden title="${escapeHtml(t('reader.back'))}" aria-label="${escapeHtml(t('reader.settingsBack'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
      <div class="panel-heading">
        <div class="panel-kicker" id="panel-kicker">${escapeHtml(t('readerJs.panelTocKicker'))}</div>
        <div class="panel-title" id="panel-title">${escapeHtml(t('readerJs.panelTocTitle'))}</div>
      </div>
      <button type="button" class="panel-close" id="panel-close" title="${escapeHtml(t('reader.close'))}" aria-label="${escapeHtml(t('reader.closePanel'))}">&times;</button>
    </div>
    <div class="panel-tabs">
      <button class="panel-tab is-active" data-tab="toc">${escapeHtml(t('reader.panelToc'))}</button>
      <button class="panel-tab" data-tab="search">${escapeHtml(t('reader.panelSearch'))}</button>
      <button class="panel-tab" data-tab="bookmarks">${escapeHtml(t('reader.panelBookmarks'))}</button>
      <button class="panel-tab" data-tab="notes">${escapeHtml(t('reader.panelNotes'))}</button>
    </div>
    <div class="panel-body" data-panel-tab="toc">
      <div class="toc-tools">
        <input type="search" id="toc-search-input" name="tocSearch" class="toc-search-input" placeholder="${escapeHtml(t('reader.findChapter'))}" autocomplete="off">
        <div class="toc-actions">
          <button type="button" class="toc-action-btn" id="toc-prev-chapter">${escapeHtml(t('reader.prevChapter'))}</button>
          <button type="button" class="toc-action-btn" id="toc-next-chapter">${escapeHtml(t('reader.nextChapter'))}</button>
        </div>
      </div>
      <div id="toc-content"><div class="bm-empty">${escapeHtml(t('reader.loading'))}</div></div>
    </div>
    <div class="panel-body" data-panel-tab="search" hidden>
      <div class="toc-tools">
        <input type="search" id="book-search-input" name="bookSearch" class="toc-search-input" placeholder="${escapeHtml(t('readerJs.searchPlaceholder'))}" autocomplete="off" enterkeyhint="search">
      </div>
      <div id="search-content"><div class="bm-empty">${escapeHtml(t('readerJs.searchHint'))}</div></div>
    </div>
    <div class="panel-body" data-panel-tab="bookmarks" hidden>
      <div id="bookmarks-content"><div class="bm-empty">${escapeHtml(t('reader.loading'))}</div></div>
    </div>
    <div class="panel-body" data-panel-tab="notes" hidden>
      <div id="notes-content"><div class="bm-empty">${escapeHtml(t('reader.loading'))}</div></div>
    </div>
    <div class="panel-body rs-body" data-panel-tab="settings" hidden>
      <nav class="rs-root" id="rs-root" aria-label="${escapeHtml(t('reader.panelSettings'))}">
        ${readerSettingsRow('text', 'text', t('reader.rs.text'))}
        ${readerSettingsRow('look', 'palette', lite ? t('reader.color') : t('reader.rs.look'))}
        ${readerSettingsRow('page', 'page', t('reader.rs.page'))}
        ${readerSettingsRow('controls', 'hand', t('reader.rs.controls'))}
        ${readerSettingsRow('tts', 'tts', t('reader.rs.tts'))}
        ${lite ? '' : readerSettingsRow('eink', 'eink', t('reader.rs.eink'))}
        <button type="button" class="rs-root-row rs-root-reset" id="reader-reset-settings"><span class="rs-root-ico" aria-hidden="true">${READER_ICONS.reset}</span><span class="rs-root-label">${escapeHtml(t('reader.reset'))}</span></button>
      </nav>

      <section class="rs-page" data-rs-page="text" data-rs-title="${escapeHtml(t('reader.rs.text'))}" hidden>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.fontSize'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-font-size" name="readerFontSize" min="12" max="32" step="1" aria-label="${escapeHtml(t('reader.fontSize'))}">
            <span class="rs-val" id="rs-font-size-val">18</span>
          </div>
        </div>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.presets'))}</div>
          <div class="rs-seg rs-preset-seg">
            <button type="button" data-preset="compact">${escapeHtml(t('reader.presetCompact'))}</button>
            <button type="button" data-preset="balanced">${escapeHtml(t('reader.presetBalanced'))}</button>
            <button type="button" data-preset="relaxed">${escapeHtml(t('reader.presetRelaxed'))}</button>
          </div>
        </div>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.font'))}</div>
          <select id="rs-font-family" name="readerFontFamily" class="rs-select" aria-label="${escapeHtml(t('reader.fontFaceAria'))}"></select>
          <label class="rs-check">
            <input type="checkbox" id="rs-publisher-font" name="readerPublisherFont">
            <span>${escapeHtml(t('reader.publisherFont'))}</span>
          </label>
        </div>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.fontWeight'))}</div>
          <select id="rs-font-weight" name="readerFontWeight" class="rs-select" aria-label="${escapeHtml(t('reader.fontWeight'))}">
            <option value="400">${escapeHtml(t('reader.fontWeight.regular'))}</option>
            <option value="500">${escapeHtml(t('reader.fontWeight.medium'))}</option>
            <option value="600">${escapeHtml(t('reader.fontWeight.semibold'))}</option>
            <option value="700">${escapeHtml(t('reader.fontWeight.bold'))}</option>
          </select>
        </div>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.lineHeight'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-line-height" name="readerLineHeight" min="1.2" max="2.4" step="0.1" aria-label="${escapeHtml(t('reader.lineHeight'))}">
            <span class="rs-val" id="rs-line-height-val">1.6</span>
          </div>
        </div>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.typography'))}</div>
          <label class="rs-check">
            <input type="checkbox" id="rs-justify" name="readerJustify" checked>
            <span>${escapeHtml(t('reader.justify'))}</span>
          </label>
          <label class="rs-check">
            <input type="checkbox" id="rs-hyphenate" name="readerHyphenate" checked>
            <span>${escapeHtml(t('reader.hyphenate'))}</span>
          </label>
        </div>
        <div class="rs-group">
          <div class="rs-sublabel">${escapeHtml(t('reader.paragraphSpacing'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-paragraph-spacing" name="readerParagraphSpacing" min="0" max="1.5" step="0.05" aria-label="${escapeHtml(t('reader.paragraphSpacing'))}">
            <span class="rs-val" id="rs-paragraph-spacing-val">0.40</span>
          </div>
          <div class="rs-sublabel">${escapeHtml(t('reader.textIndent'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-text-indent" name="readerTextIndent" min="0" max="3" step="0.1" aria-label="${escapeHtml(t('reader.textIndent'))}">
            <span class="rs-val" id="rs-text-indent-val">0.0 em</span>
          </div>
          <div class="rs-sublabel">${escapeHtml(t('reader.letterSpacing'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-letter-spacing" name="readerLetterSpacing" min="-0.05" max="0.2" step="0.01" aria-label="${escapeHtml(t('reader.letterSpacing'))}">
            <span class="rs-val" id="rs-letter-spacing-val">0.00</span>
          </div>
        </div>
      </section>

      <section class="rs-page" data-rs-page="look" data-rs-title="${escapeHtml(lite ? t('reader.color') : t('reader.rs.look'))}" hidden>
        ${lite ? '' : `<div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.theme'))}</div>
          <div class="rs-themes">${themeDots('rs-theme-dot')}</div>
        </div>`}
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.color'))}</div>
          <div class="rs-color-stack">
            <div class="rs-color-line">
              <div class="rs-color-sub">${escapeHtml(t('reader.textColor'))}</div>
              <div class="rs-color-row">
                <input type="color" id="rs-text-color" name="readerTextColor" value="#3d3121" aria-label="${escapeHtml(t('reader.textColor'))}" title="${escapeHtml(t('reader.customTextColorTitle'))}">
                <button type="button" class="rs-color-default" id="rs-text-color-default" title="${escapeHtml(t('reader.fromTheme'))}">${escapeHtml(t('reader.fromTheme'))}</button>
              </div>
            </div>
            <div class="rs-color-line">
              <div class="rs-color-sub">${escapeHtml(t('reader.bgColor'))}</div>
              <div class="rs-color-row">
                <input type="color" id="rs-bg-color" name="readerBgColor" value="#f4edd5" aria-label="${escapeHtml(t('reader.bgColor'))}" title="${escapeHtml(t('reader.customBgColorTitle'))}">
                <button type="button" class="rs-color-default" id="rs-bg-color-default" title="${escapeHtml(t('reader.fromTheme'))}">${escapeHtml(t('reader.fromTheme'))}</button>
              </div>
            </div>
            <div class="rs-color-line">
              <div class="rs-color-sub">${escapeHtml(t('reader.linkColor'))}</div>
              <div class="rs-color-row">
                <input type="color" id="rs-link-color" name="readerLinkColor" value="#6b4226" aria-label="${escapeHtml(t('reader.linkColor'))}" title="${escapeHtml(t('reader.customLinkColorTitle'))}">
                <button type="button" class="rs-color-default" id="rs-link-color-default" title="${escapeHtml(t('reader.fromTheme'))}">${escapeHtml(t('reader.fromTheme'))}</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="rs-page" data-rs-page="page" data-rs-title="${escapeHtml(t('reader.rs.page'))}" hidden>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.layoutMode'))}</div>
          <div class="rs-seg">
            <button type="button" data-set-layout="paginated">${escapeHtml(t('reader.layoutPaginated'))}</button>
            <button type="button" data-set-layout="dual" class="rs-layout-dual-btn">${escapeHtml(t('reader.layoutDual'))}</button>
            <button type="button" data-set-layout="scrolled">${escapeHtml(t('reader.layoutScrolled'))}</button>
          </div>
        </div>
        <div class="rs-group" id="rs-layout-paginated">
          <div class="rs-label">${escapeHtml(t('reader.columnWidth'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-column-width" name="readerColumnWidth" min="480" max="920" step="20" aria-label="${escapeHtml(t('reader.columnWidth'))}">
            <span class="rs-val" id="rs-column-width-val">720 px</span>
          </div>
          <label class="rs-check">
            <input type="checkbox" id="rs-full-width" name="readerFullWidth">
            <span>${escapeHtml(t('reader.fullWidth'))}</span>
          </label>
        </div>
        <div class="rs-group" id="rs-layout-dual" hidden>
          <div class="rs-label">${escapeHtml(t('reader.columnGap'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-column-gap" name="readerColumnGap" min="4" max="16" step="1" aria-label="${escapeHtml(t('reader.columnGap'))}">
            <span class="rs-val" id="rs-column-gap-val">7%</span>
          </div>
          <div class="rs-hint">${escapeHtml(t('reader.columnGapHint'))}</div>
        </div>
        <div class="rs-group" id="rs-layout-scrolled" hidden>
          <div class="rs-label">${escapeHtml(t('reader.maxBlockSize'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-max-block-size" name="readerMaxBlockSize" min="720" max="2400" step="40" aria-label="${escapeHtml(t('reader.maxBlockSize'))}">
            <span class="rs-val" id="rs-max-block-size-val">1440 px</span>
          </div>
          <div class="rs-hint">${escapeHtml(t('reader.maxBlockSizeHint'))}</div>
        </div>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.margins'))}</div>
          <div class="rs-sublabel">${escapeHtml(t('reader.pageMargin'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-page-margin" name="readerPageMargin" min="0" max="72" step="4" aria-label="${escapeHtml(t('reader.pageMargin'))}">
            <span class="rs-val" id="rs-page-margin-val">32 px</span>
          </div>
          <div class="rs-sublabel">${escapeHtml(t('reader.verticalMargin'))}</div>
          <div class="rs-slider">
            <input type="range" id="rs-vertical-margin" name="readerVerticalMargin" min="0" max="96" step="4" aria-label="${escapeHtml(t('reader.verticalMargin'))}">
            <span class="rs-val" id="rs-vertical-margin-val">32 px</span>
          </div>
          <div class="rs-hint">${escapeHtml(t('reader.pageMarginHint'))}</div>
        </div>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.chromePinned'))}</div>
          <label class="rs-check">
            <input type="checkbox" id="rs-chrome-pinned" name="readerChromePinned">
            <span>${escapeHtml(t('reader.chromePinnedLabel'))}</span>
          </label>
          <div class="rs-hint">${escapeHtml(t('reader.chromePinnedHint'))}</div>
        </div>
      </section>

      <section class="rs-page" data-rs-page="controls" data-rs-title="${escapeHtml(t('reader.rs.controls'))}" hidden>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.tapZones'))}</div>
          <div class="rs-seg rs-tap-mode-seg">
            <button type="button" data-tap-edit="short" class="is-active">${escapeHtml(t('reader.tapZones.short'))}</button>
            <button type="button" data-tap-edit="long">${escapeHtml(t('reader.tapZones.long'))}</button>
          </div>
          <div class="rs-tap-grid" id="rs-tap-grid" role="group" aria-label="${escapeHtml(t('reader.tapZones'))}"></div>
          <select id="rs-tap-action" class="rs-select" aria-label="${escapeHtml(t('reader.tapZones.action'))}" hidden></select>
          <div class="rs-hint" id="rs-tap-hint">${escapeHtml(t('reader.tapZones.hint'))}</div>
          <button type="button" class="rs-tap-reset" id="rs-tap-reset">${escapeHtml(t('reader.tapZones.reset'))}</button>
        </div>
      </section>

      <section class="rs-page" data-rs-page="tts" data-rs-title="${escapeHtml(t('reader.rs.tts'))}" hidden>
        <div class="rs-group">
          <div id="rs-tts-mount"></div>
        </div>
      </section>
      ${lite ? '' : `
      <section class="rs-page" data-rs-page="eink" data-rs-title="${escapeHtml(t('reader.rs.eink'))}" hidden>
        <div class="rs-group">
          <div class="rs-label">${escapeHtml(t('reader.einkMode'))}</div>
          <div class="rs-seg">
            <button type="button" data-set-eink-mode="auto">${escapeHtml(t('reader.einkMode.auto'))}</button>
            <button type="button" data-set-eink-mode="on">${escapeHtml(t('reader.einkMode.on'))}</button>
            <button type="button" data-set-eink-mode="off">${escapeHtml(t('reader.einkMode.off'))}</button>
          </div>
          <div class="rs-hint">${escapeHtml(t('reader.einkMode.hint'))}</div>
        </div>
      </section>`}
    </div>
  </div>
</div>

<div class="reader-toast" id="reader-toast"></div>

<script src="/book-ref.js?v=${STATIC_ASSET_VERSION}" defer></script>
${liteBoot}
<script>window.__READER_BOOK_ID=${JSON.stringify(book.id).replace(/</g, '\\u003c')};window.__READER_BOOK_EXT=${JSON.stringify(ext).replace(/</g, '\\u003c')}</script>
<script type="module" src="/reader.js?v=${STATIC_ASSET_VERSION}"></script>
</body>
</html>`;
}

function profileCoverThumb(bookId) {
  return `<span class="profile-cover"><img class="profile-cover-img" src="${apiBookPath(bookId, 'cover')}" alt="" loading="lazy" onerror="this.remove()"></span>`;
}

function renderReaderBookmarkRows(readerBookmarks = []) {
  return readerBookmarks.length
    ? readerBookmarks.map((bm) => `
        <div class="profile-list-item profile-litem" data-profile-bookmark="${escapeHtml(String(bm.id))}" data-reader-bm-book-id="${escapeHtml(String(bm.bookId))}" data-reader-bm-position="${escapeHtml(String(bm.position ?? ''))}" data-reader-bm-title="${escapeHtml(String(bm.label || ''))}">
          <a class="profile-litem-link" href="${readPagePath(bm.bookId)}?pos=${encodeURIComponent(bm.position)}" title="${escapeHtml(bm.bookTitle)}" target="_blank" rel="noopener noreferrer">
            ${profileCoverThumb(bm.bookId)}
            <span class="profile-litem-text">
              <span class="profile-litem-title">${escapeHtml(bm.label || bm.bookTitle)}</span>
              <span class="profile-litem-sub">${escapeHtml(bm.bookTitle !== bm.label && bm.label ? bm.bookTitle : '')}</span>
            </span>
          </a>
          ${renderListRemoveBtn({ extraAttrs: `data-remove-bookmark="${escapeHtml(String(bm.id))}"` })}
        </div>`).join('')
    : `<div class="profile-empty">${escapeHtml(t('profile.noBookmarks'))}</div>`;
}

const NOTE_COLORS = ['yellow', 'green', 'blue', 'pink', 'underline'];

const NOTE_ICONS = {
  copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>'
};

function noteColorLabel(color) {
  return NOTE_COLORS.includes(color) ? t(`notes.color.${color}`) : String(color || '');
}

function noteSwatch(color) {
  return `<span class="notes-swatch notes-swatch-${escapeHtml(color)}" aria-hidden="true"></span>`;
}

function renderNoteActionBtn(attr, icon, labelKey, extraClass = '') {
  const label = escapeHtml(t(labelKey));
  return `<button type="button" class="note-action ${extraClass}" ${attr} title="${label}" aria-label="${label}">${icon}</button>`;
}

function renderNoteCard(an, group) {
  const color = NOTE_COLORS.includes(an.color) ? an.color : 'yellow';
  const quote = String(an.text || '').trim();
  const note = String(an.note || '').trim();
  const bookLink = group === 'color'
    ? `<a class="note-meta-book" href="${bookPagePath(an.bookId)}">${escapeHtml(an.bookTitle || '')}</a>`
    : '';
  const colorPicks = NOTE_COLORS.map((c) => `
        <label class="note-color-pick" title="${escapeHtml(noteColorLabel(c))}">
          <input type="radio" name="note-color-${escapeHtml(String(an.id))}" value="${c}"${c === color ? ' checked' : ''}>
          ${noteSwatch(c)}
        </label>`).join('');
  return `
    <article class="note-card note-card-${color}" data-note-id="${escapeHtml(String(an.id))}" data-note-color="${color}" data-note-url="${escapeHtml(apiBookPath(an.bookId, `annotations/${an.id}`))}" data-note-book="${escapeHtml(an.bookTitle || '')}">
      <label class="note-check"><input type="checkbox" data-note-select aria-label="${escapeHtml(t('notes.select.one'))}"></label>
      <div class="note-main">
        ${quote ? `<a class="note-quote" href="${readPagePath(an.bookId)}?pos=${encodeURIComponent(an.cfi)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t('notes.openInReader'))}">${escapeHtml(quote)}</a>` : ''}
        <p class="note-comment"${note ? '' : ' hidden'}>${escapeHtml(note)}</p>
        <div class="note-meta">
          ${bookLink}
          <span class="note-meta-color">${noteSwatch(color)}<span data-note-color-label>${escapeHtml(noteColorLabel(color))}</span></span>
          <time>${escapeHtml(String(an.createdAt || '').slice(0, 10))}</time>
        </div>
      </div>
      <div class="note-actions">
        ${renderNoteActionBtn('data-note-copy', NOTE_ICONS.copy, 'notes.action.copy')}
        ${renderNoteActionBtn('data-note-edit', NOTE_ICONS.edit, 'notes.action.edit')}
        ${renderNoteActionBtn('data-note-delete', NOTE_ICONS.trash, 'notes.action.delete', 'note-action-danger')}
      </div>
      <form class="note-edit" hidden>
        <textarea name="note" rows="3" maxlength="8000" placeholder="${escapeHtml(t('notes.edit.placeholder'))}">${escapeHtml(note)}</textarea>
        <div class="note-edit-colors" role="radiogroup" aria-label="${escapeHtml(t('notes.action.color'))}">${colorPicks}
        </div>
        <div class="note-edit-buttons">
          <button type="submit" class="button">${escapeHtml(t('notes.action.save'))}</button>
          <button type="button" class="button" data-note-edit-cancel>${escapeHtml(t('notes.action.cancel'))}</button>
        </div>
      </form>
    </article>`;
}

/** Группы идут подряд: запрос уже отсортирован по книге или по цвету. */
function renderNoteGroups(items, group) {
  const parts = [];
  let currentKey = null;
  for (const an of items) {
    const key = group === 'color' ? `c:${an.color}` : `b:${an.bookId}`;
    if (key !== currentKey) {
      if (currentKey !== null) parts.push('</div></section>');
      currentKey = key;
      const head = group === 'color'
        ? `<div class="notes-group-head">${noteSwatch(an.color)}<strong>${escapeHtml(noteColorLabel(an.color))}</strong></div>`
        : `<a class="notes-group-head notes-group-book" href="${bookPagePath(an.bookId)}">
            ${profileCoverThumb(an.bookId)}
            <span class="notes-group-text"><strong>${escapeHtml(an.bookTitle || '')}</strong><span class="muted">${escapeHtml(formatAuthorLabel(an.authors))}</span></span>
          </a>`;
      parts.push(`<section class="notes-group">${head}<div class="notes-group-list">`);
    }
    parts.push(renderNoteCard(an, group));
  }
  if (currentKey !== null) parts.push('</div></section>');
  return parts.join('');
}

function renderReaderListPage({ title, subtitle, total, rows, basePath, page, pageSize, user, stats, indexStatus, csrfToken }) {
  const content = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)} <span class="profile-section-count">(${formatLocaleInt(total)})</span></h1>
        <p>${escapeHtml(subtitle)}</p>
      </div>
    </section>
    <section class="profile-section">
      <div class="profile-list">${rows}</div>
    </section>
    ${renderPagination(basePath, page, pageSize, total)}`;
  return pageShell({ title, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: title }], currentPath: basePath, csrfToken });
}

export function renderReaderBookmarksPage({ items = [], total = 0, page = 1, pageSize = 30, user, stats, indexStatus, csrfToken = '' }) {
  return renderReaderListPage({
    title: t('profile.readerBookmarks'),
    subtitle: t('bookmarks.subtitle'),
    total,
    rows: renderReaderBookmarkRows(items),
    basePath: '/library/bookmarks',
    page, pageSize, user, stats, indexStatus, csrfToken
  });
}

export function renderReaderNotesPage({
  items = [], total = 0, page = 1, pageSize = 50, filter = {}, facets = null, user, stats, indexStatus, csrfToken = ''
}) {
  const f = { color: '', bookId: '', q: '', sort: 'new', group: 'book', ...filter };
  const colorCounts = facets?.colorCounts || { all: total };
  const books = facets?.books || [];
  const hasFilter = Boolean(f.color || f.bookId || f.q);
  const queryString = (over = {}) => {
    const v = { ...f, ...over };
    const p = new URLSearchParams();
    if (v.q) p.set('q', v.q);
    if (v.bookId) p.set('book', encodeBookRef(v.bookId));
    if (v.color) p.set('color', v.color);
    if (v.sort !== 'new') p.set('sort', v.sort);
    if (v.group !== 'book') p.set('group', v.group);
    return p.toString();
  };
  const pathWith = (over) => {
    const qs = queryString(over);
    return qs ? `/library/notes?${qs}` : '/library/notes';
  };
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  const chips = [
    { color: '', label: t('notes.filter.all'), count: colorCounts.all || 0 },
    ...NOTE_COLORS.map((c) => ({ color: c, label: noteColorLabel(c), count: colorCounts[c] || 0 }))
  ].filter((c) => !c.color || c.count > 0 || c.color === f.color).map((c) => `
        <a class="notes-chip${c.color === f.color ? ' is-active' : ''}" href="${escapeHtml(pathWith({ color: c.color }))}"${c.color === f.color ? ' aria-current="true"' : ''}>
          ${c.color ? noteSwatch(c.color) : ''}${escapeHtml(c.label)} <span class="notes-chip-count">${formatLocaleInt(c.count)}</span>
        </a>`).join('');

  const formatButtons = (attr) => ['md', 'html'].map((fmt) =>
    `<button type="button" class="download-format-link" ${attr}="${fmt}">${escapeHtml(t(`notes.format.${fmt}`))}</button>`
  ).join('');

  const toolbar = `
    <div class="notes-toolbar" data-notes-toolbar data-notes-filter-qs="${escapeHtml(queryString())}" data-notes-group="${escapeHtml(f.group)}">
      <label class="notes-select-all"><input type="checkbox" data-notes-select-all> ${escapeHtml(t('notes.select.all'))}</label>
      <span class="notes-selected" data-notes-selected hidden></span>
      <div class="notes-toolbar-actions">
        <details class="download-menu download-menu-compact notes-bulk" data-notes-bulk hidden>
          <summary class="button download-menu-trigger">${escapeHtml(t('notes.action.color'))}</summary>
          <div class="download-menu-popover">${NOTE_COLORS.map((c) => `<button type="button" class="download-format-link notes-color-option" data-notes-bulk-color="${c}">${noteSwatch(c)}${escapeHtml(noteColorLabel(c))}</button>`).join('')}</div>
        </details>
        <button type="button" class="button notes-bulk-delete" data-notes-bulk-delete hidden>${escapeHtml(t('notes.action.delete'))}</button>
        <details class="download-menu download-menu-compact">
          <summary class="button download-menu-trigger" title="${escapeHtml(t('notes.scopeHint'))}">${escapeHtml(t('notes.action.export'))}</summary>
          <div class="download-menu-popover">${formatButtons('data-notes-export')}</div>
        </details>
        ${canSendToEmailInUi(user) ? `
        <details class="download-menu download-menu-compact">
          <summary class="button download-menu-trigger" title="${escapeHtml(t('notes.scopeHint'))}">${escapeHtml(t('notes.action.send'))}</summary>
          <div class="download-menu-popover">${formatButtons('data-notes-send')}</div>
        </details>` : ''}
      </div>
    </div>`;

  const filterForm = `
    <form class="notes-filter" method="get" action="/library/notes" role="search">
      ${f.color ? `<input type="hidden" name="color" value="${escapeHtml(f.color)}">` : ''}
      <input type="search" name="q" value="${escapeHtml(f.q)}" placeholder="${escapeHtml(t('notes.filter.search'))}" aria-label="${escapeHtml(t('notes.filter.search'))}" maxlength="200">
      <select name="book" aria-label="${escapeHtml(t('notes.filter.book'))}" data-notes-autosubmit>
        ${option('', t('notes.filter.allBooks'), !f.bookId)}
        ${books.map((b) => option(encodeBookRef(b.bookId), `${b.title} (${b.n})`, b.bookId === f.bookId)).join('')}
      </select>
      <select name="sort" aria-label="${escapeHtml(t('notes.sort.label'))}" data-notes-autosubmit>
        ${['new', 'old', 'title'].map((s) => option(s, t(`notes.sort.${s}`), f.sort === s)).join('')}
      </select>
      <select name="group" aria-label="${escapeHtml(t('notes.group.label'))}" data-notes-autosubmit>
        ${['book', 'color'].map((g) => option(g, t(`notes.group.${g}`), f.group === g)).join('')}
      </select>
      <button type="submit" class="button">${escapeHtml(t('notes.filter.apply'))}</button>
      ${hasFilter ? `<a class="button" href="${escapeHtml(pathWith({ color: '', bookId: '', q: '' }))}">${escapeHtml(t('notes.filter.reset'))}</a>` : ''}
    </form>`;

  const body = items.length
    ? `${toolbar}<div class="notes-list" data-notes-list>${renderNoteGroups(items, f.group)}</div>`
    : renderEmptyState({
      title: hasFilter ? t('notes.emptyFiltered') : t('notes.empty'),
      text: hasFilter ? '' : t('notes.emptyText')
    });

  const title = t('profile.readerNotes');
  const content = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)} <span class="profile-section-count">(${formatLocaleInt(total)})</span></h1>
        <p>${escapeHtml(t('notes.subtitle'))}</p>
      </div>
    </section>
    <section class="profile-section notes-page" data-notes-page>
      ${filterForm}
      <nav class="notes-chips" aria-label="${escapeHtml(t('notes.filter.colorAria'))}">${chips}</nav>
      ${body}
    </section>
    ${renderPagination(pathWith({}), page, pageSize, total)}`;
  return pageShell({ title, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: title }], currentPath: '/library/notes', csrfToken });
}

/** Хаб «Моя библиотека» — главная вкладка личных разделов на телефоне (нижняя навигация). */
export function renderMyLibrary({ user, stats, indexStatus, userStats, csrfToken = '' }) {
  const favoritesTotal = (Number(userStats.bookmarkCount) || 0)
    + (Number(userStats.favoriteAuthorsCount) || 0)
    + (Number(userStats.favoriteSeriesCount) || 0);
  const sections = [
    { href: '/library/continue', title: t('nav.reading'), count: userStats.readingCount },
    { href: '/library/want', title: t('nav.want'), count: userStats.wantCount },
    { href: '/library/following', title: t('nav.following'), count: userStats.followingNewCount || 0 },
    { href: '/favorites', title: t('nav.favorites'), count: favoritesTotal },
    { href: '/shelves', title: t('nav.shelves'), count: (Number(userStats.shelvesCount) || 0) + (Number(userStats.smartShelvesCount) || 0) },
    { href: '/library/read', title: t('library.title.read'), count: userStats.readBooksCount },
    { href: '/library/rated', title: t('library.title.rated'), count: userStats.ratedCount },
    { href: '/library/bookmarks', title: t('nav.bookmarks'), count: userStats.readerBookmarksCount },
    { href: '/library/notes', title: t('nav.notes'), count: userStats.readerAnnotationsCount }
  ];
  const content = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(t('nav.myLibrary'))}</h1>
        <p>${escapeHtml(t('my.subtitle'))}</p>
      </div>
    </section>
    <div class="table-list entity-list my-library-list">
      ${sections.map((s) => `
        <a class="table-row table-row-link" href="${s.href}">
          <div class="my-library-row">
            <strong>${escapeHtml(s.title)}</strong>
            <span class="view-switcher-count">${formatLocaleInt(Math.max(0, Math.floor(Number(s.count) || 0)))}</span>
          </div>
        </a>`).join('')}
    </div>`;
  return pageShell({ title: t('nav.myLibrary'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('nav.myLibrary') }], currentPath: '/library/my', csrfToken });
}

export function renderProfile({ user, stats, indexStatus, userStats, readingStats = null, csrfToken = '' }) {
  const rs = readingStats || {};
  const readByYear = Array.isArray(rs.readByYear) ? rs.readByYear : [];
  const topAuthors = Array.isArray(rs.topAuthors) ? rs.topAuthors : [];
  const topGenres = Array.isArray(rs.topGenres) ? rs.topGenres : [];
  const count = (v) => formatLocaleInt(Math.max(0, Math.floor(Number(v) || 0)));
  const tiles = [
    { href: '/library/continue', label: t('nav.reading'), value: userStats.readingCount },
    { href: '/library/read', label: t('library.title.read'), value: userStats.readBooksCount },
    { href: '/library/want', label: t('nav.want'), value: userStats.wantCount },
    { href: '/library/rated', label: t('library.title.rated'), value: userStats.ratedCount },
    { href: '/favorites?view=books', label: t('favorites.books'), value: userStats.bookmarkCount },
    { href: '/favorites?view=authors', label: t('favorites.authors'), value: userStats.favoriteAuthorsCount },
    { href: '/favorites?view=series', label: t('favorites.series'), value: userStats.favoriteSeriesCount },
    { href: '/shelves', label: t('nav.shelves'), value: (Number(userStats.shelvesCount) || 0) + (Number(userStats.smartShelvesCount) || 0) },
    { href: '/library/bookmarks', label: t('profile.readerBookmarks'), value: userStats.readerBookmarksCount },
    { href: '/library/notes', label: t('profile.readerNotes'), value: userStats.readerAnnotationsCount }
  ];
  const tilesHtml = tiles.map((tile) => `
        <a class="profile-stat-tile" href="${tile.href}">
          <span class="profile-stat-value">${count(tile.value)}</span>
          <span class="profile-stat-label">${escapeHtml(tile.label)}</span>
        </a>`).join('');

  const maxYear = Math.max(1, ...readByYear.map((y) => Number(y.count) || 0));
  const yearRows = readByYear.map((y) => `
          <div class="profile-bar-row">
            <span class="profile-bar-label">${escapeHtml(String(y.year))}</span>
            <span class="profile-bar" aria-hidden="true"><span class="profile-bar-fill" style="width:${Math.max(4, Math.round(((Number(y.count) || 0) / maxYear) * 100))}%"></span></span>
            <span class="profile-bar-value">${count(y.count)}</span>
          </div>`).join('');
  const topRow = (href, label, n) => `
          <a class="profile-top-row" href="${href}">
            <span class="profile-top-name">${escapeHtml(label)}</span>
            <span class="muted">${count(n)}</span>
          </a>`;
  const authorRows = topAuthors.map((a) => topRow(
    `/facet/authors/${encodeURIComponent(a.name)}`,
    formatAuthorLabel(a.displayName || a.name) || a.displayName || a.name,
    a.count
  )).join('');
  const genreRows = topGenres.map((g) => topRow(
    `/facet/genres/${encodeURIComponent(g.name)}`,
    formatGenreLabel(g.name),
    g.count
  )).join('');
  const section = (titleKey, body) => `
        <section class="profile-section">
          <div class="profile-section-head"><h3>${escapeHtml(t(titleKey))}</h3></div>
          <div class="profile-list">${body}</div>
        </section>`;
  const statsBlock = yearRows || authorRows || genreRows
    ? `
      <div class="profile-activity-grid">
        ${yearRows ? section('profile.stats.byYear', yearRows) : ''}
        ${authorRows ? section('profile.stats.topAuthors', authorRows) : ''}
        ${genreRows ? section('profile.stats.topGenres', genreRows) : ''}
      </div>`
    : `<div class="profile-empty">${escapeHtml(t('profile.stats.empty'))}</div>`;

  // Yearly goal + this year by month.
  const year = Number(rs.year) || new Date().getFullYear();
  const goal = Math.max(0, Math.floor(Number(rs.goal) || 0));
  const readThisYear = Math.max(0, Math.floor(Number(rs.readThisYear) || 0));
  const byMonth = Array.isArray(rs.byMonth) ? rs.byMonth : [];
  const maxMonth = Math.max(1, ...byMonth.map((n) => Number(n) || 0));
  const monthNames = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString(getLocale(), { month: 'short' }));
  const monthBars = byMonth.length ? `
        <div class="profile-months" aria-label="${escapeHtml(tp('profile.goal.byMonth', { year }))}">
          ${byMonth.map((n, i) => `<div class="profile-month" title="${escapeHtml(`${monthNames[i]}: ${count(n)}`)}">
            <span class="profile-month-bar"><span style="height:${n ? Math.max(6, Math.round(((Number(n) || 0) / maxMonth) * 100)) : 0}%"></span></span>
            <span class="profile-month-label">${escapeHtml(monthNames[i])}</span>
          </div>`).join('')}
        </div>` : '';
  const goalPct = goal ? Math.min(100, Math.round((readThisYear / goal) * 100)) : 0;
  const goalBlock = `
      <section class="profile-section profile-section-wide profile-goal">
        <div class="profile-section-head"><h3>${escapeHtml(tp('profile.goal.title', { year }))}</h3></div>
        <p class="profile-goal-line">${goal
          ? escapeHtml(tp('profile.goal.progress', { read: count(readThisYear), goal: count(goal) }))
          : escapeHtml(tp('profile.goal.noGoal', { read: count(readThisYear) }))}</p>
        ${goal ? `<div class="profile-goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.min(readThisYear, goal)}"><span style="width:${goalPct}%"></span></div>` : ''}
        ${monthBars}
        <form method="post" action="/profile/reading-goal" class="profile-goal-form">
          ${csrfHiddenField(csrfToken)}
          <input type="hidden" name="year" value="${year}">
          <label>${escapeHtml(t('profile.goal.set'))}
            <input type="number" name="goal" min="0" max="1000" step="1" value="${goal || ''}" placeholder="${escapeHtml(t('profile.goal.placeholder'))}">
          </label>
          <button type="submit" class="button">${escapeHtml(t('profile.save'))}</button>
        </form>
      </section>`;

  const content = `
    <div class="profile-shell">
    ${renderProfileIdentityHeader(user, userStats)}
    ${renderProfileNav('stats')}
    <div class="profile-activity">
      ${goalBlock}
      <section class="profile-section profile-section-wide">
        <div class="profile-section-head"><h3>${escapeHtml(t('profile.stats.collection'))}</h3></div>
        <div class="profile-stat-grid">${tilesHtml}
        </div>
      </section>
      ${statsBlock}
    </div>
    </div>
  `;
  return pageShell({ title: t('profile.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('profile.title') }], currentPath: '/profile', csrfToken });
}

function renderProfileIdentityHeader(user, userStats) {
  const fmtDate = (d) => formatLocaleDateLong(d);
  const initials = String(user.username || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  const roleLabel = user.role === 'admin' ? t('profile.admin') : t('profile.user');
  const memberSince = tp('profile.memberSince', { date: fmtDate(userStats.createdAt) });
  return `
    <header class="profile-identity">
      <span class="profile-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
      <div class="profile-identity-info">
        <h2 class="profile-identity-name">${escapeHtml(user.username)}</h2>
        <div class="profile-identity-meta">
          <span class="profile-role-badge${user.role === 'admin' ? ' is-admin' : ''}">${escapeHtml(roleLabel)}</span>
          <span class="muted">${escapeHtml(memberSince)}</span>
        </div>
      </div>
    </header>`;
}

function renderProfileSettingsSubnav(active = 'account') {
  const section = active === 'view' ? 'view' : 'account';
  const tab = (key, label) => {
    const href = key === 'view' ? '/profile/settings?section=view' : '/profile/settings';
    const isActive = section === key;
    return `<a class="button profile-settings-tab${isActive ? ' is-active' : ''}" href="${escapeHtml(href)}"${isActive ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  };
  return `
    <nav class="profile-settings-tabs" aria-label="${escapeHtml(t('profile.settingsTabsAria'))}">
      ${tab('account', t('profile.settingsTab.account'))}
      ${tab('view', t('profile.settingsTab.view'))}
    </nav>`;
}

/** Profile → view «Главная страница»: show / hide and ▲▼ per web home block (app-only `recent` kept as is). */
function renderHomeLayoutForm(layout, csrfToken) {
  const ids = layout.order.filter((id) => WEB_HOME_SECTION_IDS.includes(id));
  const rows = ids.map((id, i) => `
    <li class="home-layout-row">
      <label class="admin-checkbox-label">
        <input type="checkbox" name="show" value="${escapeHtml(id)}"${isHomeSectionVisible(layout, id) ? ' checked' : ''}>
        ${escapeHtml(t(`profile.homeLayout.section.${id}`))}
      </label>
      <span class="home-layout-move">
        <button type="submit" name="move" value="${escapeHtml(id)}:up" class="button-secondary" aria-label="${escapeHtml(`${t(`profile.homeLayout.section.${id}`)}: ${t('profile.homeLayout.up')}`)}"${i === 0 ? ' disabled' : ''}>▲</button>
        <button type="submit" name="move" value="${escapeHtml(id)}:down" class="button-secondary" aria-label="${escapeHtml(`${t(`profile.homeLayout.section.${id}`)}: ${t('profile.homeLayout.down')}`)}"${i === ids.length - 1 ? ' disabled' : ''}>▼</button>
      </span>
    </li>`).join('');
  return `
      <div class="table-row table-row-stack profile-form-row" id="home-layout">
        <div>
          <strong>${escapeHtml(t('profile.homeLayout'))}</strong>
          <p class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('profile.homeLayout.hint'))}</p>
          <form method="post" action="/profile/home-layout" class="vertical-form">
            ${csrfHiddenField(csrfToken)}
            <ul class="home-layout-list">${rows}</ul>
            <div class="actions">
              <button type="submit" class="button-primary">${escapeHtml(t('profile.save'))}</button>
              <button type="submit" name="reset" value="1" class="button-secondary">${escapeHtml(t('profile.homeLayout.reset'))}</button>
            </div>
          </form>
        </div>
      </div>`;
}

export function renderProfileSettings({
  user, stats, indexStatus, userStats,
  ereaderEmail = '', accountEmail = '', telegramId = '', telegramLinkedAt = '',
  telegramBotAvailable = false, telegramBotAllowed = true, ereaderEmailAllowed = true,
  flash = '', csrfToken = '', hasLocalPassword = true,
  homeView = 'grid', catalogView = 'grid',
  contentLangOptions = [], contentLangs = [],
  kosyncUrl = '', kosyncHasPassword = false,
  hideRead = false, downloadFormat = '', downloadFormatOptions = [], telegramDigest = false,
  homeLayout = null,
  section = 'account'
} = {}) {
  const fmtDate = (d) => formatLocaleDateLong(d);
  const activeSection = section === 'view' ? 'view' : 'account';
  const currentPath = activeSection === 'view' ? '/profile/settings?section=view' : '/profile/settings';

  const accountPanel = `
    <div class="table-list profile-tab-panel">
      <div class="table-row table-row-stack profile-form-row">
        <div>
          ${renderAppPairWidget()}
        </div>
      </div>
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(t('profile.telegram.title'))}</strong>
          <p class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('profile.telegram.hint'))}</p>
          ${telegramId
            ? `<p style="margin:0 0 8px;">${escapeHtml(t('profile.telegram.linked'))} · ID <code>${escapeHtml(telegramId)}</code>${telegramLinkedAt ? `<span class="muted"> · ${escapeHtml(fmtDate(telegramLinkedAt))}</span>` : ''}</p>
               ${telegramBotAllowed
                 ? `<form method="post" action="/profile/telegram/digest" class="vertical-form profile-digest-form">
                      ${csrfHiddenField(csrfToken)}
                      <input type="hidden" name="digest" value="0">
                      <label class="admin-checkbox-label"><input type="checkbox" name="digest" value="1"${telegramDigest ? ' checked' : ''}> ${escapeHtml(t('profile.telegram.digest'))}</label>
                      <p class="muted" style="margin:2px 0 8px;font-size:12px;">${escapeHtml(t('profile.telegram.digestHint'))}</p>
                      <div class="actions"><button type="submit" class="button">${escapeHtml(t('profile.save'))}</button></div>
                    </form>
                    <form method="post" action="/profile/telegram/unlink" class="admin-inline-form" data-confirm="${escapeHtml(t('profile.telegram.unlinkConfirm'))}">
                      ${csrfHiddenField(csrfToken)}
                      <button type="submit" class="button-danger">${escapeHtml(t('profile.telegram.unlink'))}</button>
                    </form>`
                 : `<p class="muted" style="margin:0;">${escapeHtml(t('profile.telegram.accessDenied'))}</p>`}`
            : !telegramBotAllowed
              ? `<p class="muted" style="margin:0;">${escapeHtml(t('profile.telegram.accessDenied'))}</p>`
              : telegramBotAvailable
                ? `<a class="button" href="/profile/telegram/link">${escapeHtml(t('profile.telegram.link'))}</a>`
                : `<p class="muted" style="margin:0;">${escapeHtml(t('profile.telegram.botUnavailable'))}</p>`}
        </div>
      </div>
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(t('import.reading.title'))}</strong>
          <p class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('import.reading.hint'))}</p>
          <form class="vertical-form" data-reading-import>
            <div><input type="file" name="csv" accept=".csv,text/csv,text/plain" required></div>
            <div class="actions"><button type="submit" class="button-primary">${escapeHtml(t('import.reading.button'))}</button></div>
            <div class="import-report muted" data-reading-import-report hidden></div>
          </form>
        </div>
      </div>
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(t('profile.accountEmail'))}</strong>
          <p class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('profile.accountEmail.hint'))}</p>
          <form method="post" action="/profile/account-email" class="vertical-form">
            ${csrfHiddenField(csrfToken)}
            <div><input type="email" name="accountEmail" value="${escapeHtml(accountEmail)}" placeholder="name@example.com" autocomplete="email"></div>
            <div class="actions"><button type="submit" class="button-primary">${escapeHtml(t('profile.save'))}</button></div>
          </form>
        </div>
      </div>
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(t('profile.kosync.title'))}</strong>
          <p class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('profile.kosync.hint'))}</p>
          <p style="margin:0 0 4px;">${escapeHtml(t('profile.kosync.url'))}: <code>${escapeHtml(kosyncUrl)}</code></p>
          <p style="margin:0 0 8px;">${escapeHtml(t('profile.kosync.username'))}: <code>${escapeHtml(user.username)}</code> · <span class="muted">${escapeHtml(t(kosyncHasPassword ? 'profile.kosync.status.on' : 'profile.kosync.status.off'))}</span></p>
          <div class="actions">
            <form method="post" action="/profile/kosync-password" class="admin-inline-form">
              ${csrfHiddenField(csrfToken)}
              <button type="submit" class="button-primary">${escapeHtml(t(kosyncHasPassword ? 'profile.kosync.reset' : 'profile.kosync.create'))}</button>
            </form>
            ${kosyncHasPassword
              ? `<form method="post" action="/profile/kosync-password/revoke" class="admin-inline-form" data-confirm="${escapeHtml(t('profile.kosync.revokeConfirm'))}">
                   ${csrfHiddenField(csrfToken)}
                   <button type="submit" class="button-danger">${escapeHtml(t('profile.kosync.revoke'))}</button>
                 </form>`
              : ''}
          </div>
        </div>
      </div>
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(t('profile.ereaderEmail'))}</strong>
          ${ereaderEmailAllowed
            ? `<form method="post" action="/profile/email" class="vertical-form" style="margin-top:8px;">
                 ${csrfHiddenField(csrfToken)}
                 <div><input type="email" name="ereaderEmail" value="${escapeHtml(ereaderEmail)}" placeholder="kindle@kindle.com"></div>
                 <div class="actions"><button type="submit" class="button-primary">${escapeHtml(t('profile.save'))}</button></div>
               </form>`
            : `<p class="muted" style="margin:4px 0 0;font-size:12px;">${escapeHtml(t('profile.ereaderEmail.accessDenied'))}</p>`}
        </div>
      </div>
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(hasLocalPassword ? t('profile.changePassword') : t('profile.setPassword'))}</strong>
          <div class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(hasLocalPassword ? t('profile.passwordRules') : t('profile.setPasswordHint'))}</div>
          <form method="post" action="/profile/password" class="vertical-form">
            ${csrfHiddenField(csrfToken)}
            ${hasLocalPassword
              ? `<div><input type="password" name="currentPassword" placeholder="${escapeHtml(t('profile.currentPassword'))}" autocomplete="current-password" required></div>`
              : ''}
            <div><input type="password" name="newPassword" placeholder="${escapeHtml(t('profile.newPassword'))}" autocomplete="new-password" required></div>
            <div><input type="password" name="confirmPassword" placeholder="${escapeHtml(t('profile.confirmPassword'))}" autocomplete="new-password" required></div>
            <div class="actions"><button type="submit" class="button-primary">${escapeHtml(hasLocalPassword ? t('profile.changeBtn') : t('profile.setPasswordBtn'))}</button></div>
          </form>
        </div>
      </div>
    </div>`;

  const viewPanel = `
    <div class="table-list profile-tab-panel">
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(t('profile.viewPrefs'))}</strong>
          <p class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('profile.viewPrefs.hint'))}</p>
          <form method="post" action="/profile/view" class="vertical-form">
            ${csrfHiddenField(csrfToken)}
            <div class="profile-view-prefs">
              <label class="profile-view-pref">
                <span>${escapeHtml(t('profile.viewPrefs.home'))}</span>
                <select name="homeView" aria-label="${escapeHtml(t('profile.viewPrefs.home'))}">
                  <option value="grid"${homeView !== 'list' ? ' selected' : ''}>${escapeHtml(t('browse.viewGrid'))}</option>
                  <option value="list"${homeView === 'list' ? ' selected' : ''}>${escapeHtml(t('browse.viewList'))}</option>
                </select>
              </label>
              <label class="profile-view-pref">
                <span>${escapeHtml(t('profile.viewPrefs.catalog'))}</span>
                <select name="catalogView" aria-label="${escapeHtml(t('profile.viewPrefs.catalog'))}">
                  <option value="grid"${catalogView !== 'list' ? ' selected' : ''}>${escapeHtml(t('browse.viewGrid'))}</option>
                  <option value="list"${catalogView === 'list' ? ' selected' : ''}>${escapeHtml(t('browse.viewList'))}</option>
                </select>
              </label>
              <label class="profile-view-pref">
                <span>${escapeHtml(t('profile.downloadFormat'))}</span>
                <select name="downloadFormat" aria-label="${escapeHtml(t('profile.downloadFormat'))}">
                  <option value=""${downloadFormat ? '' : ' selected'}>${escapeHtml(t('profile.downloadFormat.ask'))}</option>
                  ${downloadFormatOptions.map(([code, label]) => `<option value="${escapeHtml(code)}"${downloadFormat === code ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="admin-checkbox-label" style="margin-top:8px;">
              <input type="hidden" name="hideRead" value="0">
              <input type="checkbox" name="hideRead" value="1"${hideRead ? ' checked' : ''}> ${escapeHtml(t('browse.hideRead'))}
            </label>
            <p class="muted" style="margin:2px 0 0;font-size:12px;">${escapeHtml(t('profile.downloadFormat.hint'))} ${escapeHtml(t('profile.hideRead.hint'))}</p>
            <div class="actions"><button type="submit" class="button-primary">${escapeHtml(t('profile.save'))}</button></div>
          </form>
        </div>
      </div>
      ${renderHomeLayoutForm(homeLayout || normalizeHomeLayout(''), csrfToken)}
      <div class="table-row table-row-stack profile-form-row">
        <div>
          <strong>${escapeHtml(t('profile.contentLangs'))}</strong>
          <p class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('profile.contentLangs.hint'))}</p>
          ${contentLangOptions.length
            ? `<form method="post" action="/profile/content-langs" class="vertical-form">
                ${csrfHiddenField(csrfToken)}
                <div class="profile-lang-prefs">
                  ${contentLangOptions.map((code) => `<label class="profile-lang-pref"><input type="checkbox" name="contentLangs" value="${escapeHtml(code)}"${contentLangs.includes(code) ? ' checked' : ''}> ${escapeHtml(code.toUpperCase())}</label>`).join('')}
                </div>
                <div class="actions"><button type="submit" class="button-primary">${escapeHtml(t('profile.save'))}</button></div>
              </form>`
            : `<p class="muted" style="margin:0;">${escapeHtml(t('profile.contentLangs.empty'))}</p>`}
        </div>
      </div>
    </div>`;

  const content = `
    ${flash ? renderAlert('success', flash) : ''}
    <div class="profile-shell">
    ${renderProfileIdentityHeader(user, userStats)}
    ${renderProfileNav('settings')}
    ${renderProfileSettingsSubnav(activeSection)}
    ${activeSection === 'view' ? viewPanel : accountPanel}
    </div>
  `;
  return pageShell({ title: t('profile.tabSettings'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('profile.tabSettings') }], currentPath, csrfToken });
}
