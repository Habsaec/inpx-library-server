/**
 * Library template functions: home, catalog, browse, book detail, favorites, shelves, reader, profile.
 */
import {
  escapeHtml, sanitizeHtml, csrfHiddenField, pageShell,
  renderBookGrid, renderFavoriteBookGrid, renderEntityGrid, renderCover,
  renderPagination, renderSortControl, renderEmptyState,
  renderDownloadMenu, renderBatchDownloadToolbar, renderScopeDownloadMenu,
  renderHomeShelf, renderMiniBookList, renderDiscoveryTiles,
  renderStatsRibbon, renderBookMetaList, renderSkeletonGrid,
  renderAuthorFacetSeriesList, renderAuthorFlibustaList, renderBookFlibustaList,
  renderFacetSummaryBlock,
  renderSectionIntro, renderFacetHero, renderAlert, renderAccountNav, renderAppPairWidget,
  renderListRemoveBtn, bookIdDataAttr, bookCardDataAttrs, batchBookIdDataAttr,
  firstAuthorValue, uniqueBooksById, batchSelectInputAttrs, safeDomIdPart,
  browseTotalLine, canDownloadInUi, canSendToEmailInUi, renderAuthorLinks, renderSeriesLinks, renderWelcomeQuoteAuthor,
  STATIC_ASSET_VERSION, siteTitleForDisplay, READ_CHECK_SVG, renderFaviconLinks,
  bookPagePath, readPagePath, apiBookPath, liteBookPagePath, liteReadPagePath,
  t, tp, getLocale, plural, countLabel, formatLocaleInt,
  formatLocaleDateLong, serializeClientI18n,
  formatAuthorLabel, formatLanguageLabel,
  formatGenreLabel, parseGenreCodes
} from './shared.js';
import { pickHomeWelcomeQuote } from '../home-welcome-quotes.js';

export function renderHome({ user, stats, indexStatus, history = [], favoriteAuthors = [], favoriteSeries = [], sections = {}, recommendations = [], homeSubtitle = '', csrfToken = '', readBookIds = null, hasContinueData = false, listView = false }) {
  const isAuthenticated = Boolean(user);
  const loginHint = tp('home.loginHint', { login: `<a href="/login">${escapeHtml(t('nav.login'))}</a>` });
  const quoteInviting = !isAuthenticated || !hasContinueData;
  const welcomeQuote = pickHomeWelcomeQuote(getLocale(), { inviting: quoteInviting });
  const subtitleText = homeSubtitle === '-' ? '' : (homeSubtitle || t('home.subtitle'));
  const homeViewAttr = listView ? 'list' : 'grid';
  const recommendationsShelf = isAuthenticated
    ? (recommendations.length
        ? renderHomeShelf({ title: t('home.shelfRecommended'), href: '/library/recommended', items: recommendations, type: 'books', isAuthenticated, showBatch: true, user, readBookIds, listView })
        : `
    <section class="library-shelf" data-home-recommendations data-home-view="${homeViewAttr}" data-loaded="0">
      <div class="section-title">
        <h2>${escapeHtml(t('home.shelfRecommended'))}</h2>
        <div class="actions"><a class="shelf-link" href="/library/recommended">${escapeHtml(t('home.showAll'))}</a></div>
      </div>
      <div data-home-recommendations-grid>${renderSkeletonGrid(8)}</div>
    </section>`)
    : '';
  const continueAttr = isAuthenticated && hasContinueData ? ' data-home-continue' : '';
  const content = `
    ${subtitleText ? `<header class="home-page-intro"><p class="home-page-subtitle">${escapeHtml(subtitleText)}</p></header>` : ''}
    <section class="welcome-hero-banner home-reveal"${continueAttr}>
      <div class="welcome-hero-overlay"></div>
      <div class="welcome-hero-content">
        <blockquote class="welcome-hero-quote">${escapeHtml(welcomeQuote.quote)}</blockquote>
        <cite class="welcome-hero-author">${renderWelcomeQuoteAuthor(welcomeQuote.author)}</cite>
      </div>
    </section>
    ${!isAuthenticated ? `<div class="home-inline-note">${loginHint}</div>` : ''}
    ${renderHomeShelf({ title: t('home.shelfNew'), href: '/library/recent', items: sections.newest || [], type: 'books', isAuthenticated, showBatch: false, user, readBookIds, listView })}
    ${recommendationsShelf}
    `;
  return pageShell({ title: t('home.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home') }], currentPath: '/', csrfToken, readBookIds });
}

function buildCatalogQueryParams({
  query = '', field = 'books', sort = 'title', order = '', genres = [], letter = '',
  lang = '', format = '', year = 0, minRate = 0, hasSeries = null, view = ''
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
  if (view === 'list') p.set('view', 'list');
  for (const g of genres) {
    if (g) p.append('genre', g);
  }
  return p;
}

function catalogChipHref(baseParams, removeKey, removeValue = null) {
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
  return qs ? `/catalog?${qs}` : '/catalog';
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

function sortGenreOptionsAlpha(options = []) {
  return [...(Array.isArray(options) ? options : [])].sort((a, b) => {
    const la = String(a?.displayName || a?.name || '').trim();
    const lb = String(b?.displayName || b?.name || '').trim();
    return la.localeCompare(lb, 'ru', { sensitivity: 'base' });
  });
}

function renderCatalogFilterPanel({
  query, field, sort, order, genres = [], letter, lang, format, year, minRate = 0,
  hasSeries = null, langs = [], formats = [], genreOptions = [], genreOptionsLazy = false,
  view = ''
}) {
  const selected = new Set(genres);
  const baseParams = buildCatalogQueryParams({
    query, field, sort, order, genres, letter, lang, format, year, minRate, hasSeries, view
  });
  const chips = [];
  for (const g of genres) {
    chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(catalogChipHref(baseParams, 'genre', g))}"><span>${escapeHtml(tp('catalog.filter.genre', { value: formatGenreLabel(g) }))}</span><span aria-hidden="true">×</span></a>`);
  }
  if (lang) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(catalogChipHref(baseParams, 'lang'))}"><span>${escapeHtml(tp('catalog.filter.lang', { value: lang.toUpperCase() }))}</span><span aria-hidden="true">×</span></a>`);
  if (format) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(catalogChipHref(baseParams, 'format'))}"><span>${escapeHtml(tp('catalog.filter.format', { value: format.toUpperCase() }))}</span><span aria-hidden="true">×</span></a>`);
  if (year) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(catalogChipHref(baseParams, 'year'))}"><span>${escapeHtml(tp('catalog.filter.year', { value: String(year) }))}</span><span aria-hidden="true">×</span></a>`);
  if (minRate >= 1) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(catalogChipHref(baseParams, 'minRate'))}"><span>${escapeHtml(tp('catalog.filter.minRate', { value: String(minRate) }))}</span><span aria-hidden="true">×</span></a>`);
  if (hasSeries === 1) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(catalogChipHref(baseParams, 'hasSeries'))}"><span>${escapeHtml(t('catalog.filter.hasSeries'))}</span><span aria-hidden="true">×</span></a>`);
  if (hasSeries === 0) chips.push(`<a class="catalog-filter-chip" href="${escapeHtml(catalogChipHref(baseParams, 'hasSeries'))}"><span>${escapeHtml(t('catalog.filter.noSeries'))}</span><span aria-hidden="true">×</span></a>`);

  const sortedGenreOptions = sortGenreOptionsAlpha(genreOptions);
  const selectedGenreChecks = genres.map((name) => {
    const label = formatGenreLabel(name);
    const search = `${name} ${label}`.toLowerCase();
    return `<label class="catalog-genre-option" data-genre-search="${escapeHtml(search)}"><input type="checkbox" name="genre" value="${escapeHtml(name)}" checked><span class="catalog-genre-label">${escapeHtml(label)}</span></label>`;
  }).join('');
  const genreChecks = sortedGenreOptions.map((g) => {
    const name = g.name || '';
    if (selected.has(name)) return '';
    const label = g.displayName || formatGenreLabel(name);
    const count = Number.isFinite(Number(g.bookCount)) ? Math.max(0, Math.floor(Number(g.bookCount))) : null;
    const search = `${name} ${label}`.toLowerCase();
    const countHtml = count != null
      ? `<span class="catalog-genre-count muted">${escapeHtml(String(count))}</span>`
      : '';
    return `<label class="catalog-genre-option" data-genre-search="${escapeHtml(search)}"><input type="checkbox" name="genre" value="${escapeHtml(name)}"><span class="catalog-genre-label">${escapeHtml(label)}</span>${countHtml}</label>`;
  }).join('');
  const lazyAttrs = genreOptionsLazy
    ? ` data-catalog-genres-lazy="1" data-genres-q="${escapeHtml(query || '')}" data-genres-lang="${escapeHtml(lang || '')}" data-genres-format="${escapeHtml(format || '')}" data-genres-year="${escapeHtml(year ? String(year) : '')}" data-genres-min-rate="${escapeHtml(minRate >= 1 ? String(minRate) : '')}" data-genres-has-series="${escapeHtml(hasSeries === 0 || hasSeries === 1 ? String(hasSeries) : '')}"`
    : '';
  const genreListHtml = genreOptionsLazy
    ? `${selectedGenreChecks}<span class="muted catalog-genres-loading" data-catalog-genres-loading>${escapeHtml(t('catalog.filtersGenresLoading'))}</span>`
    : (selectedGenreChecks + genreChecks) || `<span class="muted">${escapeHtml(t('browse.empty'))}</span>`;

  const hasActive = chips.length > 0;
  const resetParams = buildCatalogQueryParams({ query, field, sort, order, letter, view });
  const resetQs = resetParams.toString();
  const resetHref = resetQs ? `/catalog?${resetQs}` : '/catalog';
  const summaryCount = hasActive ? ` (${chips.length})` : '';
  return `
    <form class="catalog-filter-panel" method="get" action="/catalog" data-catalog-filters${lazyAttrs}>
      ${query ? `<input type="hidden" name="q" value="${escapeHtml(query)}">` : ''}
      <input type="hidden" name="field" value="${escapeHtml(field || 'books')}">
      <input type="hidden" name="sort" value="${escapeHtml(sort || 'title')}">
      ${order ? `<input type="hidden" name="order" value="${escapeHtml(order)}">` : ''}
      ${letter ? `<input type="hidden" name="letter" value="${escapeHtml(letter)}">` : ''}
      ${view === 'list' ? '<input type="hidden" name="view" value="list">' : ''}
      <div class="catalog-filter-bar">
        <details class="catalog-filter-shell">
          <summary class="catalog-filter-summary">
            <span class="catalog-filter-summary-label">${escapeHtml(t('catalog.filtersTitle'))}${escapeHtml(summaryCount)}</span>
          </summary>
          <div class="catalog-filter-body">
            <details class="catalog-filter-details"${genres.length ? ' open' : ''}>
              <summary>${escapeHtml(t('catalog.filtersGenres'))}${genres.length ? ` (${genres.length})` : ''}</summary>
              <div class="catalog-genre-panel">
                <input type="search" class="catalog-genre-search" data-catalog-genre-search placeholder="${escapeHtml(t('catalog.filtersGenreSearch'))}" autocomplete="off">
                <div class="catalog-genre-list" role="group" aria-label="${escapeHtml(t('catalog.filtersGenres'))}">${genreListHtml}</div>
              </div>
            </details>
            <div class="catalog-filter-row catalog-filter-row-inline">
              <label class="catalog-filter-field">
                <span class="muted">${escapeHtml(t('catalog.allLanguages'))}</span>
                <select name="lang" onchange="this.form.submit()">
                  <option value="">${escapeHtml(t('catalog.allLanguages'))}</option>
                  ${langs.map((l) => `<option value="${escapeHtml(l)}"${l === lang ? ' selected' : ''}>${escapeHtml(l.toUpperCase())}</option>`).join('')}
                </select>
              </label>
              <label class="catalog-filter-field">
                <span class="muted">${escapeHtml(t('catalog.allFormats'))}</span>
                <select name="format" onchange="this.form.submit()">
                  <option value="">${escapeHtml(t('catalog.allFormats'))}</option>
                  ${formats.map((f) => `<option value="${escapeHtml(f)}"${f === format ? ' selected' : ''}>${escapeHtml(f.toUpperCase())}</option>`).join('')}
                </select>
              </label>
              <label class="catalog-filter-field catalog-filter-field-narrow">
                <span class="muted">${escapeHtml(t('catalog.year'))}</span>
                <input type="number" name="year" min="1800" max="2100" placeholder="${escapeHtml(t('catalog.year'))}" value="${year || ''}" onchange="this.form.submit()">
              </label>
              <label class="catalog-filter-field catalog-filter-field-narrow">
                <span class="muted">${escapeHtml(t('catalog.filtersMinRate'))}</span>
                <select name="minRate" onchange="this.form.submit()">
                  <option value="">${escapeHtml(t('catalog.filtersAnyRate'))}</option>
                  ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${minRate === n ? ' selected' : ''}>${n}+</option>`).join('')}
                </select>
              </label>
              <label class="catalog-filter-field catalog-filter-field-narrow">
                <span class="muted">${escapeHtml(t('catalog.filtersSeries'))}</span>
                <select name="hasSeries" onchange="this.form.submit()">
                  <option value="">${escapeHtml(t('catalog.filtersSeriesAny'))}</option>
                  <option value="1"${hasSeries === 1 ? ' selected' : ''}>${escapeHtml(t('catalog.filtersSeriesYes'))}</option>
                  <option value="0"${hasSeries === 0 ? ' selected' : ''}>${escapeHtml(t('catalog.filtersSeriesNo'))}</option>
                </select>
              </label>
              <div class="catalog-filter-actions">
                <button type="submit" class="button">${escapeHtml(t('catalog.filtersApply'))}</button>
              </div>
            </div>
          </div>
        </details>
        ${hasActive ? `<div class="catalog-filter-chips" aria-label="${escapeHtml(t('catalog.filtersActive'))}">${chips.join('')}</div>` : ''}
        ${hasActive ? `<a class="catalog-filter-reset" href="${escapeHtml(resetHref)}">${escapeHtml(t('catalog.filtersReset'))}</a>` : ''}
      </div>
    </form>`;
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
        <h2>${escapeHtml(t('search.overviewTitle'))}</h2>
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
  minRate = 0, hasSeries = null,
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
  const hasQueryContext = Boolean(query || letter || hasFilterDims);
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
  const catalogParams = buildCatalogQueryParams({
    query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries,
    view: isListView ? 'list' : ''
  });
  const catalogPageBase = `/catalog?${catalogParams.toString()}`;
  const genreCsv = genreList.join(',');
  const filterSummary = [
    ...genreList.map((g) => formatGenreLabel(g)),
    lang ? lang.toUpperCase() : '',
    format ? format.toUpperCase() : '',
    year ? String(year) : '',
    minRate >= 1 ? `≥${minRate}` : '',
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
  const listBatch = Boolean(isListView && canDownloadInUi(user) && items.length);
  const booksMarkup = isListView
    ? (listBatch
      ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderBookFlibustaList(items, { user, batchSelect: true })}</div>`
      : renderBookFlibustaList(items, { user, batchSelect: false }))
    : renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: false, user, readBookIds });
  const resultsMarkup = items.length
    ? isBookField
      ? `${catalogHintBlock}${recoveryHints}${booksMarkup}`
      : `${catalogHintBlock}${recoveryHints}${renderEntityGrid(items, field === 'authors' ? '/facet/authors' : '/facet/series', t('browse.empty'))}`
    : `${catalogHintBlock}${catalogEmpty}${recoveryHints}`;
  const pageHeading = hasQueryContext ? t('catalog.resultsTitle') : t('catalog.title');
  const viewToggle = isBookField
    ? (() => {
      const gridParams = buildCatalogQueryParams({ query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries, view: '' });
      const listParams = buildCatalogQueryParams({ query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries, view: 'list' });
      gridParams.set('view', 'grid');
      const gridIcon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>';
      const listIcon = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';
      return `<div class="view-toggle" role="group" aria-label="${escapeHtml(t('browse.viewGrid'))} / ${escapeHtml(t('browse.viewList'))}">
          <a class="view-toggle-btn${isListView ? '' : ' is-active'}" href="/catalog?${gridParams.toString()}" title="${escapeHtml(t('browse.viewGrid'))}" aria-label="${escapeHtml(t('browse.viewGrid'))}" ${isListView ? '' : 'aria-current="true"'}>${gridIcon}</a>
          <a class="view-toggle-btn${isListView ? ' is-active' : ''}" href="/catalog?${listParams.toString()}" title="${escapeHtml(t('browse.viewList'))}" aria-label="${escapeHtml(t('browse.viewList'))}" ${isListView ? 'aria-current="true"' : ''}>${listIcon}</a>
        </div>`;
    })()
    : '';
  const content = `
    <section class="hero">
      <div class="section-title">
        <h2>${escapeHtml(pageHeading)}</h2>
        <div class="actions">
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
              ...(letter ? { letter } : {}),
              ...(isListView ? { view: 'list' } : {})
            }
          })}
        </div>
      </div>
      ${searchNavBlock}
      ${isBookField ? renderCatalogFilterPanel({
        query, field, sort, order, genres: genreList, letter, lang, format, year, minRate, hasSeries, langs, formats, genreOptions, genreOptionsLazy,
        view: isListView ? 'list' : ''
      }) : ''}
      ${letter && !query ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(tp('catalog.letterResults', { letter: letter.toUpperCase() }))}</div>` : ''}
      ${resultsMarkup}
      ${renderPagination(catalogPageBase, page, pageSize, total)}
    </section>`;
  return pageShell({ title: t('catalog.title'), content, user, query, field, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('catalog.title') }], currentPath: '/catalog', csrfToken, readBookIds });
}


export function renderLibraryView({ view, title, subtitle = '', items, total, page, pageSize, type = '', itemType = '', sort = 'title', order = '', listView = false, user, stats, indexStatus, csrfToken = '', readBookIds = null, readSeriesNames = null, computing = false, userStats = null }) {
  const navCounts = userStats ? {
    books: userStats.bookmarkCount,
    authors: userStats.favoriteAuthorsCount,
    series: userStats.favoriteSeriesCount,
    shelves: userStats.shelvesCount,
    read: userStats.readBooksCount
  } : null;
  if (computing) {
    const content = `
      <section class="page-intro">
        <div class="page-intro-copy">
          <h1>${escapeHtml(title)}</h1>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
      </section>
      <section class="library-shelf library-shelf-primary">
        ${renderSkeletonGrid(12)}
      </section>
      <script>setTimeout(function(){location.reload()},2500)</script>`;
    return pageShell({ title, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: title }], currentPath: `/library/${view}`, csrfToken, readBookIds });
  }
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
  const countHintLabel = view === 'continue' || view === 'recommended' || view === 'read' ? t('library.countInSection') : t('library.countInCatalog');
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
  const viewParams = new URLSearchParams();
  if (sort) viewParams.set('sort', sort);
  if (order) viewParams.set('order', order);
  if (type) viewParams.set('type', type);
  const sortControl = isSeries
    ? ''
    : `<div class="actions">${renderSortControl({
      action: `/library/${view}`,
      sort,
      order,
      options: sortOptions,
      extraHidden: {
        ...(type ? { type } : {})
      }
    })}</div>`;
  const listBatch = Boolean(isListView && canDownloadInUi(user) && items.length);
  const booksMarkup = isListView
    ? (listBatch
      ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderBookFlibustaList(items, { user, batchSelect: true })}</div>`
      : renderBookFlibustaList(items, { user, batchSelect: false }))
    : renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: false, user, readBookIds });
  const currentPathQs = viewParams.toString();
  const currentPath = currentPathQs ? `/library/${view}?${currentPathQs}` : `/library/${view}`;
  const content = `
    <section class="page-intro">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${sortControl}
    </section>
    ${view === 'read' ? renderAccountNav('read', navCounts) : ''}
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


export function renderBook({
  book,
  details,
  bookmarked,
  isRead = false,
  user,
  stats,
  indexStatus,
  similarBooks = null,
  csrfToken = '',
  authorBioHtml = '',
  authorPortraitUrl = '',
  illustrationUrls = [],
  flash = '',
  readBookIds = null
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
    genreSummaryHtml
  ].filter(Boolean);
  const parentLibraryHref = primarySeries ? `/facet/series/${encodeURIComponent(primarySeries.name)}${seriesAuthorParam}` : primaryAuthor ? `/facet/authors/${encodeURIComponent(primaryAuthor)}` : '/library/recent';
  const parentLibraryLabel = primarySeries
    ? tp('book.seriesPrefix', { name: primarySeries.displayName || primarySeries.name })
    : primaryAuthor
      ? tp('book.authorPrefix', { name: formatAuthorLabel(book.authors) })
      : t('nav.recent');
  const content = `
    <section class="book-detail-shell">
      <div class="book-detail-main card-detail-panel">
        ${isAuthenticated ? `<div class="book-detail-corner-actions">
          <button class="button book-detail-read-action ${isRead ? 'is-active' : ''}" type="button" ${bookIdDataAttr(book.id)} data-read-button="1">${isRead ? escapeHtml(t('book.markedRead')) : escapeHtml(t('book.markRead'))}</button>
          <button class="button book-detail-bookmark-action ${bookmarked ? 'is-active' : ''}" type="button" ${bookIdDataAttr(book.id)} data-bookmark-button="1" ${bookmarked ? 'data-active-favorite="true"' : ''}>${bookmarked ? escapeHtml(t('book.inFavorite')) : escapeHtml(t('book.addFavorite'))}</button>
          <button class="button" type="button" ${bookIdDataAttr(book.id)} data-add-to-shelf="1">${escapeHtml(t('book.toShelf'))}</button>
        </div>` : ''}
        <div class="book-detail-cover">
          <div class="cover ${hasRealCover ? '' : 'cover-fallback-active'}">
            <img class="cover-image" src="${apiBookPath(book.id, 'cover')}" alt="${escapeHtml(book.title)}">
            <span class="cover-fallback" ${hasRealCover ? 'hidden' : ''} aria-hidden="${hasRealCover ? 'true' : 'false'}">
              <img class="cover-fallback-image" src="/book-fallback.png" alt="">
              <span class="cover-fallback-overlay"></span>
              <span class="cover-fallback-copy">
                <span class="cover-fallback-title">${escapeHtml(book.title)}</span>
                <span class="cover-fallback-author">${escapeHtml(formatAuthorLabel(book.authors) || t('book.authorUnknown'))}</span>
              </span>
            </span>
            ${(() => { const r = Math.max(0, Math.min(5, Math.floor(Number(book.libRate) || 0))); return r ? `<span class="cover-rating-wrapper"><span class="cover-rating-badge cover-rating-${r}">${Array.from({ length: r }, () => '<span>★</span>').join('')}</span></span>` : ''; })()}
          </div>
        </div>
        <div class="book-detail-content">
          <h2 class="book-detail-title">${escapeHtml(book.title)}${Number(book.deleted) ? ` <span class="deleted-badge deleted-badge--inline" title="${escapeHtml(t('book.deletedHint'))}">${escapeHtml(t('book.deletedBadge'))}</span>` : ''}</h2>
          ${Number(book.deleted) ? `<p class="muted book-deleted-note">${escapeHtml(t('book.deletedHint'))}</p>` : ''}
          <div class="author">${book.authors ? renderAuthorLinks(book.authorsList, { limit: 3, bookAuthors: book.authors, inlineExpand: true }) : escapeHtml(t('book.authorUnknown'))}</div>
          ${summaryBits.length ? `<div class="book-detail-summary">${summaryBits.join('<span class="book-detail-sep">·</span>')}</div>` : ''}
          ${
            details.annotationIsHtml && String(details.annotation || '').trim()
              ? `<div class="book-detail-annotation book-detail-annotation--html">${sanitizeHtml(details.annotation)}</div>`
              : `<p class="book-detail-annotation">${escapeHtml(details.annotation || t('book.noAnnotation'))}</p>`
          }
          <div class="book-detail-review-mount" data-book-review-mount data-book-review-for="${encodeURIComponent(String(book.id))}" data-review-heading="${escapeHtml(t('book.review'))}" hidden aria-hidden="true"></div>
          ${
            illustrationUrls.length
              ? `<section class="book-detail-side-block book-detail-illustrations"><details class="book-detail-disclosure book-detail-illustrations-disclosure"><summary><span class="book-detail-disclosure-title">${escapeHtml(t('book.illustrations'))}</span><span class="book-detail-disclosure-note">${formatLocaleInt(illustrationUrls.length)}</span></summary><div class="book-detail-illustrations-strip">${illustrationUrls.map((it, idx) => `<a href="${escapeHtml(it.url)}" data-illustration-link data-illustration-index="${idx}"><img src="${escapeHtml(it.url)}" alt="" loading="lazy"></a>`).join('')}</div></details></section>`
              : ''
          }
          <div class="actions actions-primary">
            <a href="${readPagePath(book.id)}" class="button button-primary" target="_blank" rel="noopener noreferrer"><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>${escapeHtml(t('home.heroReadBook'))}</a>
            ${renderDownloadMenu(book, { accent: true, user })}
            ${isAuthenticated && canSendToEmailInUi(user) ? `<button class="button" type="button" ${bookIdDataAttr(book.id)} data-send-to-ereader="1">${escapeHtml(t('book.toEmail'))}</button>` : ''}
          </div>
        </div>
        ${user?.role === 'admin' ? `<details class="book-edit-disclosure book-edit-disclosure--inline">
          <summary class="book-edit-summary book-edit-summary--inline" title="${escapeHtml(t('book.edit.title'))}">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.25.25 0 0 0-.064.108l-.558 1.953 1.953-.558a.249.249 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>
          <span>${escapeHtml(t('book.edit.title'))}</span>
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
            <button type="submit">${escapeHtml(t('book.edit.save'))}</button>
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
      ${similar.items?.length ? renderBookGrid(similar.items, { isAuthenticated, batchSelect: false, user, hideDownloads: Boolean(similar.hideDownloads), readBookIds }) : renderEmptyState({ title: t('book.similarEmptyTitle'), text: t('book.similarEmptyText') })}
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
    shelves: userStats.shelvesCount,
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
        <div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: bookSortOptions, extraHidden: { view: 'books' } })}</div>
      </div>
      ${pageHint}
      ${books.length ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderFavoriteBookGrid(books, { batchSelect: true, user, readBookIds })}</div>${booksPagination}` : renderEmptyState({ title: t('favorites.emptyBooksTitle'), text: t('favorites.emptyBooksText'), actionHref: '/catalog', actionLabel: t('favorites.toCatalog'), secondaryHref: '/library/recent', secondaryLabel: t('library.openRecent') })}
    </section>`;
  const readSection = `
    <section class="library-shelf library-shelf-secondary favorites-section favorites-section-books">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.read'))}</h2>
        <div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: bookSortOptions, extraHidden: { view: 'read' } })}</div>
      </div>
      ${pageHint}
      ${readBooks.length ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderFavoriteBookGrid(readBooks, { batchSelect: true, user, readBookIds })}</div>${readPagination}` : renderEmptyState({ title: t('favorites.emptyReadTitle'), text: t('favorites.emptyReadText'), actionHref: '/library/continue', actionLabel: t('favorites.emptyReadAction'), secondaryHref: '/catalog', secondaryLabel: t('favorites.toCatalog') })}
    </section>`;
  const authorsSection = `
    <section class="library-shelf library-shelf-secondary favorites-section">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.authors'))}</h2>
        <div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: entitySortOptions, extraHidden: { view: 'authors' } })}</div>
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
        <div class="actions">${renderSortControl({ action: '/favorites', sort, order, options: entitySortOptions, extraHidden: { view: 'series' } })}</div>
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
    ${renderAccountNav(currentView, navCounts)}
    ${sectionContent}
    </div>`;
  return pageShell({ title: t('favorites.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('favorites.title') }], currentPath: '/favorites', csrfToken, readBookIds });
}


function renderGroupedEntityGrid(groups, facetBasePath, readSeriesNames = null) {
  if (!groups || !groups.length) return '';
  const isSeries = facetBasePath.includes('series');
  const seriesBadge = (name) => isSeries && readSeriesNames && readSeriesNames.has(name) ? `<span class="read-series-badge">${READ_CHECK_SVG}</span>` : '';
  return `<div class="genre-grouped-list">${groups.map(g => `
    <details class="genre-group">
      <summary class="genre-group-header"><span class="genre-group-title">${escapeHtml(g.groupName)}</span><span class="genre-group-count muted">${g.items.length}</span></summary>
      <div class="table-list entity-list genre-group-items">
        ${g.items.map(item => `
          <a class="table-row table-row-link" href="${facetBasePath}/${encodeURIComponent(item.name)}">
            <div style="display:flex;align-items:center">
              <span><strong>${escapeHtml(item.displayName || item.name)}</strong><br>
              <span class="muted">${countLabel('book', item.bookCount)} ${escapeHtml(t('entity.inLibrary'))}</span></span>
              ${seriesBadge(item.name)}
            </div>
          </a>
        `).join('')}
      </div>
    </details>
  `).join('')}</div>`;
}

export function renderBrowsePage({ title, items, total, page, pageSize, user, stats, query, letter = '', path, facetBasePath, indexStatus, sort, order = '', csrfToken = '', genreGroups = null, readSeriesNames = null }) {
  const letterParam = letter ? `&letter=${encodeURIComponent(letter)}` : '';
  const paginationBase = `${path}?sort=${encodeURIComponent(sort || 'count')}${letterParam}`;
  const browseLabels = { '/authors': t('nav.authors'), '/series': t('nav.series'), '/genres': t('nav.genres'), '/languages': t('nav.languages') };
  const letterHint = letter && !query
    ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(tp('catalog.letterResults', { letter: letter.toUpperCase() }))}</div>`
    : '';
  const content = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(t('browse.intro'))}</p>
      </div>
      <div class="page-intro-actions">
        ${renderSortControl({
          action: path,
          sort,
          order,
          query,
          options: [
            { value: 'count', label: t('sort.byBookCount') },
            { value: 'name', label: t('sort.byName') }
          ]
        })}
      </div>
    </section>
    ${letterHint}
    <div class="list-context-hint list-context-hint-spacious">${browseTotalLine(path, total, query)}</div>
    <form class="search-form browse-filter" action="${path}" method="get" style="margin-bottom:16px; max-width:460px;">
      <input name="q" value="${escapeHtml(query || '')}" placeholder="${escapeHtml(t('browse.placeholder'))}">
      <input type="hidden" name="sort" value="${escapeHtml(sort || 'count')}">
      <div class="actions">
        <button type="submit">${escapeHtml(t('browse.submit'))}</button>
        ${query || letter ? `<a class="button" href="${path}?sort=${encodeURIComponent(sort || 'count')}">${escapeHtml(t('browse.reset'))}</a>` : ''}
      </div>
    </form>
    ${genreGroups ? renderGroupedEntityGrid(genreGroups, facetBasePath, readSeriesNames) : renderEntityGrid(items, facetBasePath, query || letter ? t('browse.emptyFiltered') : t('browse.empty'), readSeriesNames)}
    ${genreGroups ? '' : renderPagination(paginationBase, page, pageSize, total, query)}
  `;
  const alphabet = { path, sort: 'name', label: browseLabels[path] || title, activeLetter: letter };
  return pageShell({ title, content, user, stats, query, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: title }], alphabet, currentPath: path, csrfToken });
}

export function renderFacetBooks({ title, items, total, page, pageSize, user, stats, facetPath, indexStatus, sort, order = '', breadcrumbs, summary = {}, facet = '', facetValue = '', favorite = false, seriesRead = false, csrfToken = '', readBookIds = null, view = 'books', entityItems = null, authorFilter = '' }) {
  const isGenre = facet === 'genres';
  const isLang = facet === 'languages';
  const isEntityView = (isGenre || isLang) && (view === 'authors' || view === 'series');
  const facetAction = user && (facet === 'authors' || facet === 'series')
    ? `<button class="button ${favorite ? 'is-active' : ''}" type="button" ${facet === 'authors' ? `data-favorite-author="${escapeHtml(facetValue)}"` : `data-favorite-series="${escapeHtml(facetValue)}"`} ${favorite ? 'data-active-favorite="true"' : ''}>${favorite ? escapeHtml(t('facet.inFavorite')) : escapeHtml(t('facet.addFavorite'))}</button>`
    : '';
  const markSeriesReadBtn = user && facet === 'series' && items.length
    ? `<button class="button${seriesRead ? ' is-active' : ''}" type="button" data-mark-series-read="${escapeHtml(facetValue)}">${seriesRead ? escapeHtml(t('facet.seriesMarkedRead')) : escapeHtml(t('facet.markSeriesRead'))}</button>`
    : '';
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
  const sortExtraHidden = isEntityView ? { view } : (authorFilter ? { author: authorFilter } : {});
  const paginationBaseParams = new URLSearchParams();
  if (isEntityView) {
    paginationBaseParams.set('view', view);
    paginationBaseParams.set('sort', sort || 'count');
  } else {
    paginationBaseParams.set('sort', sort || 'recent');
    if (authorFilter) paginationBaseParams.set('author', authorFilter);
  }
  if (order) paginationBaseParams.set('order', order);
  const paginationBase = `${facetPath}?${paginationBaseParams.toString()}`;

  // Body block: either entity grid or book grid
  const entityBasePath = view === 'authors' ? '/facet/authors' : '/facet/series';
  const bodyBlock = isEntityView
    ? (entityItems && entityItems.length
        ? renderEntityGrid(entityItems, entityBasePath, t('browse.empty'))
        : renderEmptyState({ title: t('facet.emptyTitle'), text: t('facet.emptyText'), actionHref: facetPath, actionLabel: t('facet.viewBooks') }))
    : !items.length
      ? renderEmptyState({ title: t('facet.emptyTitle'), text: t('facet.emptyText'), actionHref: '/', actionLabel: t('facet.toCatalog') })
      : renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: showBatch, user, readBookIds, seriesContext: facet === 'series' ? facetValue : null });

  const countLabelKey = isEntityView ? (view === 'authors' ? 'author' : 'series') : 'book';

  const facetBatchInner = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="page-intro-actions">
        ${facetAction}
        ${markSeriesReadBtn}
        ${scopeDownload}
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
  readSeriesNames = null
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
        <img class="cover-fallback-image" src="/book-fallback.png" alt="">
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
          <h2 class="book-detail-title">${escapeHtml(displayName || title)}</h2>
          <div class="muted author-facet-count-line">${escapeHtml(t('facet.inSectionCount'))} <strong>${formatLocaleInt(Math.max(0, Math.floor(Number(total) || 0)))}</strong> ${plural('book', total)}</div>
          ${genreChips}
          ${bioBlock}
        </div>
      </div>
    </section>`;

  const controls = `
    <section class="page-intro page-intro-slim author-facet-controls">
      <div class="page-intro-actions author-facet-controls-actions">
        ${facetAction}
        ${total > 0 ? renderScopeDownloadMenu({ facet: 'authors', value: facetValue }, { user }) : ''}
        ${renderSortControl({
          action: facetPath,
          sort,
          order,
          options: [
            { value: 'series', label: t('sort.bySeries') },
            { value: 'count', label: t('sort.byBookCountAlt') },
            { value: 'recent', label: t('sort.recentFirst') }
          ]
        })}
      </div>
    </section>`;

  const anyBooks = series.some((s) => (Number(s.bookCount) || 0) > 0 || (Array.isArray(s.books) && s.books.length)) || standaloneBooks.length > 0;
  const outsideSeriesSort = sort === 'recent' ? 'recent' : 'title';
  const outsideSeriesHref = facetValue
    ? `/facet/authors/${encodeURIComponent(facetValue)}/outside-series?sort=${encodeURIComponent(outsideSeriesSort)}`
    : '';
  const seriesListHtml = (series.length || standaloneBooks.length)
    ? `<section class="library-shelf library-shelf-secondary author-facet-series-block">${renderAuthorFacetSeriesList(series, standaloneBooks.length ? { href: outsideSeriesHref, label: t('authorPage.outsideSeries'), bookCount: standaloneBooks.length } : null, readSeriesNames, facetValue)}</section>`
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
  readBookIds = null
}) {
  const facetAction = user
    ? `<button class="button ${favorite ? 'is-active' : ''}" type="button" data-favorite-author="${escapeHtml(facetValue)}" ${favorite ? 'data-active-favorite="true"' : ''}>${favorite ? escapeHtml(t('facet.inFavorite')) : escapeHtml(t('facet.addFavorite'))}</button>`
    : '';
  const outsideBatch = Boolean(books.length && canDownloadInUi(user));
  const controls = `
    <section class="page-intro page-intro-slim author-facet-controls">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(displayName)}</p>
      </div>
      <div class="page-intro-actions author-facet-controls-actions">
        ${facetAction}
        ${renderSortControl({
          action: facetPath,
          sort,
          order,
          options: [
            { value: 'recent', label: t('sort.recentFirst') },
            { value: 'title', label: t('sort.byTitle') }
          ]
        })}
      </div>
    </section>`;
  const booksBlock = books.length
    ? renderBookGrid(books, { isAuthenticated: Boolean(user), batchSelect: outsideBatch, user, readBookIds })
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

export function renderShelves({ shelves = [], user, stats, indexStatus, csrfToken = '', userStats = null }) {
  const navCounts = userStats ? {
    books: userStats.bookmarkCount,
    authors: userStats.favoriteAuthorsCount,
    series: userStats.favoriteSeriesCount,
    shelves: userStats.shelvesCount,
    read: userStats.readBooksCount
  } : null;
  const content = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(t('shelves.title'))}</h1>
        <p>${escapeHtml(t('shelves.subtitle'))}</p>
      </div>
    </section>
    ${renderAccountNav('shelves', navCounts)}
    <section class="library-shelf">
      <div class="section-title">
        <h2>${escapeHtml(t('shelves.listTitle'))}</h2>
      </div>
      <form data-shelf-create class="shelf-create-form">
        <input type="text" name="name" placeholder="${escapeHtml(t('shelves.newPlaceholder'))}" required>
        <button type="submit">${escapeHtml(t('shelves.create'))}</button>
      </form>
      ${shelves.length ? `
        <div class="table-list entity-list">
          ${shelves.map((shelf) => `
            <div class="table-row table-row-clickable account-list-row" data-shelf-row="${shelf.id}" data-href="/shelves/${shelf.id}">
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
              ${renderListRemoveBtn({
                titleKey: 'shelves.delete',
                extraAttrs: `data-shelf-delete="${shelf.id}" data-shelf-name="${escapeHtml(shelf.name)}" data-shelf-description="${escapeHtml(shelf.description || '')}"`
              })}
            </div>
          `).join('')}
        </div>
      ` : renderEmptyState({ title: t('shelves.emptyTitle'), text: t('shelves.emptyText') })}
    </section>`;
  return pageShell({ title: t('shelves.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('shelves.title') }], currentPath: '/shelves', csrfToken });
}

export function renderShelfDetail({ shelf, books = [], user, stats, indexStatus, csrfToken = '', readBookIds = null, userStats = null }) {
  const navCounts = userStats ? {
    books: userStats.bookmarkCount,
    authors: userStats.favoriteAuthorsCount,
    series: userStats.favoriteSeriesCount,
    shelves: userStats.shelvesCount,
    read: userStats.readBooksCount
  } : null;
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
    ${renderAccountNav('shelves', navCounts)}
    ${shelfBatch ? renderBatchDownloadToolbar({ shelf: shelf.id }, { user }) : ''}
    ${uniqueBooks.length ? `
      <div class="grid">
        ${uniqueBooks.map((book) => `
          <article class="card" ${bookCardDataAttrs(book.id)}>
            ${shelfBatch ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} ${batchBookIdDataAttr(book.id)} aria-label="${escapeHtml(t('batch.selectAria'))}"></label>` : ''}
            ${renderCover(book, { readBookIds })}
            <div class="meta">
              <h3><a href="${bookPagePath(book.id)}">${escapeHtml(book.title)}</a></h3>
              <div class="author">${book.authors ? renderAuthorLinks(book.authorsList, { limit: 1, bookAuthors: book.authors, popoverId: `shelf-a-${book.id}` }) : escapeHtml(t('book.authorUnknown'))}</div>
              ${book.seriesList?.length ? `<div class="card-series">${renderSeriesLinks(book.seriesList, { limit: 1, popoverId: `shelf-s-${book.id}` })}</div>` : ''}
              <div class="card-actions card-actions-favorites">
                ${shelfBatch ? '' : renderDownloadMenu(book, { compact: true, user })}
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
    : "try{var _s=JSON.parse(localStorage.getItem('reader-settings')||'{}');document.documentElement.dataset.readerTheme=_s.theme||'sepia';if(_s.chromePinned)document.documentElement.dataset.chromePinned='1'}catch(e){document.documentElement.dataset.readerTheme='sepia'}";
  const fontPreconnect = lite ? '' : `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`;
  const liteBoot = lite
    ? `<script>window.__READER_LITE=1;window.__READER_BOOK_PAGE_PATH=${JSON.stringify(backHref)}</script>`
    : '';
  const themeSettingsBlock = lite ? '' : `
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.theme'))}</div>
        <div class="rs-themes">
          <button class="rs-theme-dot" type="button" data-set-theme="dark"><span class="rs-dot-label">${escapeHtml(t('reader.themeDark'))}</span></button>
          <button class="rs-theme-dot" type="button" data-set-theme="light"><span class="rs-dot-label">${escapeHtml(t('reader.themeLight'))}</span></button>
          <button class="rs-theme-dot" type="button" data-set-theme="sepia"><span class="rs-dot-label">${escapeHtml(t('reader.themeSepia'))}</span></button>
          <button class="rs-theme-dot" type="button" data-set-theme="night"><span class="rs-dot-label">${escapeHtml(t('reader.themeNight'))}</span></button>
        </div>
      </div>`;
  const ttsStopSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" fill="currentColor"/></svg>';
  return `<!DOCTYPE html>
<html lang="${htmlLang}"${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${csrfToken ? `<meta name="csrf-token" content="${escapeHtml(csrfToken)}">` : ''}
<title>${escapeHtml(documentTitle)}</title>
${renderFaviconLinks()}
${fontPreconnect}
<link rel="stylesheet" href="/reader.css?v=${STATIC_ASSET_VERSION}">
<script>${themeBoot}</script>
</head>
<body class="chrome-hidden${lite ? ' reader-lite' : ''}">
<script type="application/json" id="ui-i18n-json">${serializeClientI18n()}</script>

<div class="reader-toolbar reader-chrome" id="toolbar">
  <div class="tb-left">
    <a href="${backHref}" class="tb-btn"${readerBackClick} title="${escapeHtml(t('reader.back'))}" aria-label="${escapeHtml(t('reader.backToBook'))}"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></a>
    <div class="tb-meta">
      <span class="tb-title">${escapeHtml(title)}</span>
    </div>
  </div>
  <div class="tb-center tb-hide-m">
    <span class="tb-progress" id="progress-text">0%</span>
    <span class="tb-sep"></span>
    <span class="tb-chapter" id="toolbar-chapter">${escapeHtml(t('reader.loading'))}</span>
  </div>
  <div class="tb-right">
    <div class="tb-tts-wrap" role="group" aria-label="${escapeHtml(t('reader.ttsBar'))}">
      <button class="tb-btn tb-tts-skip js-tts-prev" type="button" id="btn-tts-prev" disabled title="${escapeHtml(t('reader.ttsPrev'))}" aria-label="${escapeHtml(t('reader.ttsPrev'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6V5zm3.6 7L18 5v14L9.6 12z" fill="currentColor"/></svg></button>
      <button class="tb-btn" type="button" id="btn-tts" title="${escapeHtml(t('reader.ttsPlay'))}" aria-label="${escapeHtml(t('reader.tts'))}"><svg class="tts-main-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="tts-main-path" fill="currentColor" d="M8 5v14l11-7z"/></svg></button>
      <button class="tb-btn tb-tts-stop js-tts-stop" type="button" id="btn-tts-stop" hidden title="${escapeHtml(t('reader.ttsStop'))}" aria-label="${escapeHtml(t('reader.ttsStop'))}">${ttsStopSvg}</button>
      <button class="tb-btn tb-tts-skip js-tts-next" type="button" id="btn-tts-next" disabled title="${escapeHtml(t('reader.ttsNext'))}" aria-label="${escapeHtml(t('reader.ttsNext'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5h2v14h-2V5zm-2.4 7L8 5v14l7.6-7z" fill="currentColor"/></svg></button>
    </div>
    <button class="tb-btn tb-hide-mobile" type="button" id="btn-fullscreen" title="${escapeHtml(t('reader.fullscreen'))}" aria-label="${escapeHtml(t('reader.fullscreen'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg></button>
    <button class="tb-btn tb-hide-mobile" type="button" id="btn-day-night" title="${escapeHtml(t('reader.nightMode'))}" aria-label="${escapeHtml(t('reader.dayModeToggle'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg></button>
    <button class="tb-btn" type="button" id="btn-bookmark-add" title="${escapeHtml(t('reader.bookmark'))}" aria-label="${escapeHtml(t('reader.addBookmark'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg></button>
    <button class="tb-btn" type="button" id="btn-search" title="${escapeHtml(t('reader.search'))}" aria-label="${escapeHtml(t('reader.searchBook'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></button>
    <button class="tb-btn" type="button" id="btn-toc" title="${escapeHtml(t('reader.toc'))}" aria-label="${escapeHtml(t('reader.tocNav'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M3 6h18M3 18h18"/></svg></button>
    <button class="tb-btn" type="button" id="btn-settings" title="${escapeHtml(t('reader.settings'))}" aria-label="${escapeHtml(t('reader.settingsReading'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg></button>
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

<div class="reader-tts-dock" id="reader-tts-dock" role="region" aria-hidden="true" aria-label="${escapeHtml(t('reader.ttsBar'))}">
  <div class="reader-tts-dock-inner">
    <div class="reader-tts-dock-row reader-tts-dock-transport">
      <button type="button" class="reader-tts-dock-btn tb-btn js-tts-prev" id="btn-tts-dock-prev" disabled title="${escapeHtml(t('reader.ttsPrev'))}" aria-label="${escapeHtml(t('reader.ttsPrev'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6V5zm3.6 7L18 5v14L9.6 12z" fill="currentColor"/></svg></button>
      <button type="button" class="reader-tts-dock-btn tb-btn reader-tts-dock-main" id="btn-tts-dock" title="${escapeHtml(t('reader.ttsPlay'))}" aria-label="${escapeHtml(t('reader.tts'))}"><svg class="tts-main-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="tts-main-path" fill="currentColor" d="M8 5v14l11-7z"/></svg></button>
      <button type="button" class="reader-tts-dock-btn tb-btn js-tts-stop" id="btn-tts-dock-stop" hidden title="${escapeHtml(t('reader.ttsStop'))}" aria-label="${escapeHtml(t('reader.ttsStop'))}">${ttsStopSvg}</button>
      <button type="button" class="reader-tts-dock-btn tb-btn js-tts-next" id="btn-tts-dock-next" disabled title="${escapeHtml(t('reader.ttsNext'))}" aria-label="${escapeHtml(t('reader.ttsNext'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5h2v14h-2V5zm-2.4 7L8 5v14l7.6-7z" fill="currentColor"/></svg></button>
    </div>
    <div class="reader-tts-dock-row reader-tts-dock-rate-group">
      <button type="button" class="reader-tts-dock-btn tb-btn" id="btn-tts-dock-slower" title="${escapeHtml(t('reader.ttsSlower'))}" aria-label="${escapeHtml(t('reader.ttsSlower'))}"><span class="reader-tts-dock-rate-sym" aria-hidden="true">−</span></button>
      <span class="reader-tts-dock-rate" id="tts-dock-rate" aria-live="polite">1.00×</span>
      <button type="button" class="reader-tts-dock-btn tb-btn" id="btn-tts-dock-faster" title="${escapeHtml(t('reader.ttsFaster'))}" aria-label="${escapeHtml(t('reader.ttsFaster'))}"><span class="reader-tts-dock-rate-sym" aria-hidden="true">+</span></button>
    </div>
  </div>
</div>

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
      <button class="panel-tab" data-tab="settings">${escapeHtml(t('reader.panelSettings'))}</button>
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
    <div class="panel-body" data-panel-tab="settings" hidden>
      ${themeSettingsBlock}
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
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.fontSize'))}</div>
        <div class="rs-slider">
          <span class="rs-icon">A</span>
          <input type="range" id="rs-font-size" name="readerFontSize" min="12" max="32" step="1">
          <span class="rs-val" id="rs-font-size-val">18</span>
          <span class="rs-icon rs-icon-lg">A</span>
        </div>
      </div>
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.lineHeight'))}</div>
        <div class="rs-slider">
          <span class="rs-icon">&equiv;</span>
          <input type="range" id="rs-line-height" name="readerLineHeight" min="1.2" max="2.4" step="0.1">
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
        <div class="rs-sublabel">${escapeHtml(t('reader.letterSpacing'))}</div>
        <div class="rs-slider">
          <input type="range" id="rs-letter-spacing" name="readerLetterSpacing" min="-0.05" max="0.2" step="0.01" aria-label="${escapeHtml(t('reader.letterSpacing'))}">
          <span class="rs-val" id="rs-letter-spacing-val">0.00</span>
        </div>
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
      </div>
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.margins'))}</div>
        <div class="rs-sublabel">${escapeHtml(t('reader.pageMargin'))}</div>
        <div class="rs-slider">
          <span class="rs-icon" aria-hidden="true">|</span>
          <input type="range" id="rs-page-margin" name="readerPageMargin" min="0" max="72" step="4" aria-label="${escapeHtml(t('reader.pageMargin'))}">
          <span class="rs-val" id="rs-page-margin-val">32 px</span>
          <span class="rs-icon" aria-hidden="true">|&nbsp;|</span>
        </div>
        <div class="rs-sublabel">${escapeHtml(t('reader.verticalMargin'))}</div>
        <div class="rs-slider">
          <span class="rs-icon" aria-hidden="true">—</span>
          <input type="range" id="rs-vertical-margin" name="readerVerticalMargin" min="0" max="96" step="4" aria-label="${escapeHtml(t('reader.verticalMargin'))}">
          <span class="rs-val" id="rs-vertical-margin-val">32 px</span>
          <span class="rs-icon" aria-hidden="true">≡</span>
        </div>
        <div class="rs-hint">${escapeHtml(t('reader.pageMarginHint'))}</div>
      </div>
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.layoutMode'))}</div>
        <div class="rs-seg">
          <button type="button" data-set-layout="paginated">${escapeHtml(t('reader.layoutPaginated'))}</button>
          <button type="button" data-set-layout="dual" class="rs-layout-dual-btn">${escapeHtml(t('reader.layoutDual'))}</button>
          <button type="button" data-set-layout="scrolled">${escapeHtml(t('reader.layoutScrolled'))}</button>
        </div>
      </div>
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.chromePinned'))}</div>
        <label class="rs-check">
          <input type="checkbox" id="rs-chrome-pinned" name="readerChromePinned">
          <span>${escapeHtml(t('reader.chromePinnedLabel'))}</span>
        </label>
        <div class="rs-hint">${escapeHtml(t('reader.chromePinnedHint'))}</div>
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
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.ttsSettings'))}</div>
        <div class="rs-sublabel">${escapeHtml(t('reader.ttsRate'))}</div>
        <div class="rs-slider">
          <input type="range" id="rs-tts-rate" name="readerTtsRate" min="0.5" max="2" step="0.05" aria-label="${escapeHtml(t('reader.ttsRate'))}">
          <span class="rs-val" id="rs-tts-rate-val">1.00</span>
        </div>
        <div class="rs-sublabel">${escapeHtml(t('reader.ttsVoice'))}</div>
        <select id="rs-tts-voice" name="readerTtsVoice" class="rs-select" aria-label="${escapeHtml(t('reader.ttsVoice'))}">
          <option value="">${escapeHtml(t('reader.ttsVoiceDefault'))}</option>
        </select>
      </div>
      <div class="rs-actions">
        <button type="button" class="rs-reset" id="reader-reset-settings">${escapeHtml(t('reader.reset'))}</button>
      </div>
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

export function renderProfile({ user, stats, indexStatus, userStats, recentBooks = [], readerBookmarks = [], readerAnnotations = [], csrfToken = '' }) {
  const fmtDate = (d) => formatLocaleDateLong(d);

  const readingTotal = Math.max(0, Math.floor(Number(userStats.readingCount) || 0));
  const readerBmTotal = Math.max(0, Math.floor(Number(userStats.readerBookmarksCount) || 0));
  const readerNotesTotal = Math.max(0, Math.floor(Number(userStats.readerAnnotationsCount) || 0));
  const readingAllLine = tp('profile.readingAll', { n: formatLocaleInt(readingTotal), books: plural('book', readingTotal) });

  const initials = String(user.username || '?').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
  const roleLabel = user.role === 'admin' ? t('profile.admin') : t('profile.user');
  const memberSince = tp('profile.memberSince', { date: fmtDate(userStats.createdAt) });

  const coverThumb = (bookId) => `<span class="profile-cover"><img class="profile-cover-img" src="${apiBookPath(bookId, 'cover')}" alt="" loading="lazy" onerror="this.remove()"></span>`;

  const recentList = recentBooks.length
    ? recentBooks.map((b) => `
        <div class="profile-list-item profile-litem" ${bookIdDataAttr(b.id)} data-reading-last-opened="${escapeHtml(String(b.lastOpenedAt || ''))}" data-reading-open-count="${Number(b.openCount) > 0 ? Number(b.openCount) : 1}">
          <a class="profile-litem-link" href="${bookPagePath(b.id)}">
            ${coverThumb(b.id)}
            <span class="profile-litem-text">
              <span class="profile-litem-title">${escapeHtml(b.title)}</span>
              <span class="profile-litem-sub">${escapeHtml(formatAuthorLabel(b.authors) || '')}</span>
            </span>
          </a>
          ${renderListRemoveBtn({ extraAttrs: 'data-remove-reading' })}
        </div>`).join('')
    : `<div class="profile-empty">${escapeHtml(t('profile.nothingYet'))}</div>`;

  const bookmarksList = readerBookmarks.length
    ? readerBookmarks.map((bm) => `
        <div class="profile-list-item profile-litem" data-profile-bookmark="${escapeHtml(String(bm.id))}" data-reader-bm-book-id="${escapeHtml(String(bm.bookId))}" data-reader-bm-position="${escapeHtml(String(bm.position ?? ''))}" data-reader-bm-title="${escapeHtml(String(bm.label || ''))}">
          <a class="profile-litem-link" href="${readPagePath(bm.bookId)}?pos=${encodeURIComponent(bm.position)}" title="${escapeHtml(bm.bookTitle)}" target="_blank" rel="noopener noreferrer">
            ${coverThumb(bm.bookId)}
            <span class="profile-litem-text">
              <span class="profile-litem-title">${escapeHtml(bm.label || bm.bookTitle)}</span>
              <span class="profile-litem-sub">${escapeHtml(bm.bookTitle !== bm.label && bm.label ? bm.bookTitle : '')}</span>
            </span>
          </a>
          ${renderListRemoveBtn({ extraAttrs: `data-remove-bookmark="${escapeHtml(String(bm.id))}"` })}
        </div>`).join('')
    : `<div class="profile-empty">${escapeHtml(t('profile.noBookmarks'))}</div>`;

  const notesList = readerAnnotations.length
    ? readerAnnotations.map((an) => {
        const primary = String(an.note || an.text || an.bookTitle || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        return `
        <div class="profile-list-item profile-litem" data-profile-annotation="${escapeHtml(String(an.id))}" data-annotation-book-id="${encodeURIComponent(String(an.bookId))}">
          <a class="profile-litem-link" href="${readPagePath(an.bookId)}?pos=${encodeURIComponent(an.cfi)}" title="${escapeHtml(primary)}" target="_blank" rel="noopener noreferrer">
            ${coverThumb(an.bookId)}
            <span class="profile-litem-text">
              <span class="profile-litem-title">${escapeHtml(primary)}</span>
              <span class="profile-litem-sub">${escapeHtml(an.bookTitle || '')}</span>
            </span>
          </a>
          ${renderListRemoveBtn({ extraAttrs: `data-remove-annotation="${escapeHtml(String(an.id))}"` })}
        </div>`;
      }).join('')
    : `<div class="profile-empty">${escapeHtml(t('profile.noNotes'))}</div>`;

  const navCounts = {
    books: userStats.bookmarkCount,
    authors: userStats.favoriteAuthorsCount,
    series: userStats.favoriteSeriesCount,
    shelves: userStats.shelvesCount,
    read: userStats.readBooksCount
  };

  const content = `
    <div class="profile-shell">
    <div hidden data-profile-page-stats data-reading-total="${readingTotal}" data-reader-bm-total="${readerBmTotal}" data-reader-notes-total="${readerNotesTotal}"></div>
    <header class="profile-identity">
      <span class="profile-avatar" aria-hidden="true">${escapeHtml(initials)}</span>
      <div class="profile-identity-info">
        <h2 class="profile-identity-name">${escapeHtml(user.username)}</h2>
        <div class="profile-identity-meta">
          <span class="profile-role-badge${user.role === 'admin' ? ' is-admin' : ''}">${escapeHtml(roleLabel)}</span>
          <span class="muted">${escapeHtml(memberSince)}</span>
        </div>
      </div>
    </header>
    ${renderAccountNav('activity', navCounts)}
    <div class="profile-activity">
      <div class="profile-activity-grid">
        <section class="profile-section profile-section-wide">
          <div class="profile-section-head">
            <h3>${escapeHtml(t('profile.reading'))} <span class="profile-section-count">(<span data-profile-reading-count>${formatLocaleInt(readingTotal)}</span>)</span></h3>
            <a href="/library/continue" class="profile-section-link" data-profile-reading-all-link ${readingTotal === 0 ? 'hidden' : ''}>${escapeHtml(readingAllLine)}</a>
          </div>
          <div class="profile-list">${recentList}</div>
        </section>
        <section class="profile-section" id="profile-sec-bookmarks">
          <div class="profile-section-head">
            <h3>${escapeHtml(t('profile.readerBookmarks'))} <span class="profile-section-count">(<span data-profile-reader-bm-count>${formatLocaleInt(readerBmTotal)}</span>)</span></h3>
          </div>
          <div class="profile-list">${bookmarksList}</div>
        </section>
        <section class="profile-section" id="profile-sec-notes">
          <div class="profile-section-head">
            <h3>${escapeHtml(t('profile.readerNotes'))} <span class="profile-section-count">(<span data-profile-reader-notes-count>${formatLocaleInt(readerNotesTotal)}</span>)</span></h3>
          </div>
          <div class="profile-list">${notesList}</div>
        </section>
      </div>
    </div>
    </div>
  `;
  return pageShell({ title: t('profile.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('profile.title') }], currentPath: '/profile', csrfToken });
}

function profileNavCounts(userStats) {
  return {
    books: userStats.bookmarkCount,
    authors: userStats.favoriteAuthorsCount,
    series: userStats.favoriteSeriesCount,
    shelves: userStats.shelvesCount,
    read: userStats.readBooksCount
  };
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

export function renderProfileSettings({
  user, stats, indexStatus, userStats,
  ereaderEmail = '', telegramId = '', telegramLinkedAt = '',
  telegramBotAvailable = false, telegramBotAllowed = true, ereaderEmailAllowed = true,
  flash = '', csrfToken = '', hasLocalPassword = true,
  homeView = 'grid', catalogView = 'grid',
  section = 'account'
} = {}) {
  const fmtDate = (d) => formatLocaleDateLong(d);
  const navCounts = profileNavCounts(userStats);
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
                 ? `<form method="post" action="/profile/telegram/unlink" class="admin-inline-form" data-confirm="${escapeHtml(t('profile.telegram.unlinkConfirm'))}">
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
          <strong>${escapeHtml(t('profile.ereaderEmail'))}</strong>
          ${ereaderEmailAllowed
            ? `<form method="post" action="/profile/email" class="vertical-form" style="margin-top:8px;">
                 ${csrfHiddenField(csrfToken)}
                 <div><input type="email" name="ereaderEmail" value="${escapeHtml(ereaderEmail)}" placeholder="kindle@kindle.com"></div>
                 <div class="actions"><button type="submit">${escapeHtml(t('profile.save'))}</button></div>
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
            <div class="actions"><button type="submit">${escapeHtml(hasLocalPassword ? t('profile.changeBtn') : t('profile.setPasswordBtn'))}</button></div>
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
            </div>
            <div class="actions"><button type="submit">${escapeHtml(t('profile.save'))}</button></div>
          </form>
        </div>
      </div>
    </div>`;

  const content = `
    ${flash ? renderAlert('success', flash) : ''}
    <div class="profile-shell">
    ${renderProfileIdentityHeader(user, userStats)}
    ${renderAccountNav('settings', navCounts)}
    ${renderProfileSettingsSubnav(activeSection)}
    ${activeSection === 'view' ? viewPanel : accountPanel}
    </div>
  `;
  return pageShell({ title: t('profile.tabSettings'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('profile.tabSettings') }], currentPath, csrfToken });
}
