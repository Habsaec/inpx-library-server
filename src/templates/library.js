/**
 * Library template functions: home, catalog, browse, book detail, favorites, shelves, reader, profile.
 */
import {
  escapeHtml, csrfHiddenField, pageShell,
  renderBookGrid, renderFavoriteBookGrid, renderEntityGrid,
  renderPagination, renderSortControl, renderEmptyState,
  renderDownloadMenu, renderBatchDownloadToolbar,
  renderHomeShelf, renderMiniBookList, renderDiscoveryTiles,
  renderStatsRibbon, renderBookMetaList, renderSkeletonGrid,
  renderAuthorFacetSeriesList, renderFacetSummaryBlock,
  renderSectionIntro, renderFacetHero, renderAlert,
  firstAuthorValue, uniqueBooksById, batchSelectInputAttrs, safeDomIdPart,
  browseTotalLine, canDownloadInUi,
  STATIC_ASSET_VERSION, siteTitleForDisplay, READ_CHECK_SVG,
  t, tp, getLocale, plural, countLabel, formatLocaleInt,
  formatLocaleDateLong, serializeClientI18n,
  formatAuthorLabel, formatLanguageLabel,
  formatGenreLabel, parseGenreCodes
} from './shared.js';

export function renderHome({ user, stats, indexStatus, history = [], favoriteAuthors = [], favoriteSeries = [], sections = {}, recommendations = [], continueBooks = [], homeSubtitle = '', csrfToken = '', readBookIds = null }) {
  const isAuthenticated = Boolean(user);
  const loginHint = tp('home.loginHint', { login: `<a href="/login">${escapeHtml(t('nav.login'))}</a>` });
  const subtitleText = homeSubtitle === '-' ? '' : (homeSubtitle || t('home.subtitle'));
  const recommendationsShelf = isAuthenticated
    ? (recommendations.length
        ? renderHomeShelf({ title: t('home.shelfRecommended'), href: '/library/recommended', items: recommendations, type: 'books', isAuthenticated, showBatch: true, user, readBookIds })
        : `
    <section class="library-shelf" data-home-recommendations data-loaded="0">
      <div class="section-title">
        <h2>${escapeHtml(t('home.shelfRecommended'))}</h2>
        <div class="actions"><a class="shelf-link" href="/library/recommended">${escapeHtml(t('home.showAll'))}</a></div>
      </div>
      <div data-home-recommendations-grid>${renderSkeletonGrid(8)}</div>
    </section>`)
    : '';
  const content = `
    <section class="page-intro page-intro-home">
      <div class="page-intro-copy">
        <h1>${escapeHtml(t('home.title'))}</h1>
        ${subtitleText ? `<p>${escapeHtml(subtitleText)}</p>` : ''}
      </div>
    </section>
    ${!isAuthenticated ? `<div class="home-inline-note">${loginHint}</div>` : ''}
    ${renderHomeShelf({ title: t('home.shelfNew'), href: '/library/recent', items: sections.newest || [], type: 'books', isAuthenticated, showBatch: true, user, readBookIds })}
    ${recommendationsShelf}
    ${isAuthenticated ? renderHomeShelf({ title: t('home.shelfContinue'), href: '/library/continue', items: continueBooks || [], type: 'books', isAuthenticated, showBatch: true, user, readBookIds }) : ''}
    `;
  return pageShell({ title: t('home.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home') }], currentPath: '/', csrfToken, readBookIds });
}

export function renderCatalog({ items, total, page, pageSize, query, field, sort, genre = '', letter = '', user, stats, indexStatus, csrfToken = '', readBookIds = null }) {
  const fieldLabels = {
    books: t('catalog.inBooks'),
    authors: t('catalog.inAuthors'),
    series: t('catalog.inSeries')
  };
  const hasSearchContext = Boolean(query || genre || letter);
  const isBookField = ['books', 'title', 'book-authors', 'book-series', 'genres', 'keywords'].includes(field);
  const sortOptions = isBookField
    ? [
        { value: 'recent', label: t('sort.recentFirst') },
        { value: 'title', label: t('sort.byTitle') },
        { value: 'author', label: t('sort.byAuthor') },
        { value: 'series', label: t('sort.bySeries') }
      ]
    : [
        { value: 'count', label: t('sort.popularFirst') },
        { value: 'name', label: t('sort.byName') }
      ];
  const catalogApiParams = `field=${encodeURIComponent(field)}&sort=${encodeURIComponent(sort)}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}${letter ? `&letter=${encodeURIComponent(letter)}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const batchAdhocJson = escapeHtml(JSON.stringify({ adhoc: true }));
  const catalogHintBlock = hasSearchContext
    ? (() => {
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
        const genrePart = genre
          ? `${query ? ' · ' : ' '}${t('catalog.genrePrefix')} <strong>${escapeHtml(formatGenreLabel(genre))}</strong>`
          : '';
        const line = tp('catalog.found', { what: foundCore, queryPart, genrePart });
        return `<div class="list-context-hint list-context-hint-spacious">${line}</div>`;
      })()
    : '';
  const catalogEmpty = renderEmptyState({
    title: t('catalog.emptyTitle'),
    text: t('catalog.emptyText'),
    actionHref: '/catalog',
    actionLabel: t('catalog.resetSearch')
  });
  const catalogBatch = false;
  const resultsMarkup = !hasSearchContext
    ? ''
    : items.length
      ? isBookField
        ? catalogBatch
          ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${catalogHintBlock}<div data-load-more-grid data-load-more-api="/api/catalog?${catalogApiParams}" data-load-more-page="${page}" data-load-more-total="${total}" data-load-more-page-size="${pageSize}" data-batch-context="${batchAdhocJson}">${renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: true, user, readBookIds })}</div></div>`
          : `${catalogHintBlock}<div data-load-more-grid data-load-more-api="/api/catalog?${catalogApiParams}" data-load-more-page="${page}" data-load-more-total="${total}" data-load-more-page-size="${pageSize}">${renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: false, user, readBookIds })}</div>`
        : `${catalogHintBlock}${renderEntityGrid(items, field === 'authors' ? '/facet/authors' : '/facet/series', t('browse.empty'))}`
      : `${catalogHintBlock}${catalogEmpty}`;
  const content = `
    <section class="hero">
      <div class="section-title">
        <h2>${hasSearchContext ? escapeHtml(t('catalog.resultsTitle')) : escapeHtml(t('catalog.searchTitle'))}</h2>
        <div class="actions">
          ${renderSortControl({
            action: '/catalog',
            sort,
            query,
            field,
            genre,
            options: sortOptions
          })}
        </div>
      </div>
      ${!hasSearchContext ? `<div class="list-context-hint">${tp('catalog.pickMode', { books: `<strong>${escapeHtml(t('search.books'))}</strong>`, authors: `<strong>${escapeHtml(t('search.authors'))}</strong>`, series: `<strong>${escapeHtml(t('search.series'))}</strong>` })}</div>` : ''}
      ${letter && !query ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(tp('catalog.letterResults', { letter: letter.toUpperCase() }))}</div>` : ''}
      ${resultsMarkup}
      ${isBookField && items.length && total > page * pageSize ? `<div class="load-more-wrap"><button class="button load-more-button" data-load-more-trigger>${escapeHtml(t('catalog.loadMore'))}</button></div>` : ''}
      ${isBookField && items.length && total > page * pageSize
        ? `<noscript>${renderPagination(`/catalog?field=${encodeURIComponent(field)}&sort=${encodeURIComponent(sort)}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}`, page, pageSize, total, query)}</noscript>`
        : ''}
      ${!isBookField || !items.length ? renderPagination(`/catalog?field=${encodeURIComponent(field)}&sort=${encodeURIComponent(sort)}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}`, page, pageSize, total, query) : ''}
    </section>`;
  return pageShell({ title: t('catalog.title'), content, user, query, field, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('catalog.title') }], currentPath: '/catalog', csrfToken, readBookIds });
}


export function renderLibraryView({ view, title, subtitle = '', items, total, page, pageSize, user, stats, indexStatus, csrfToken = '', readBookIds = null }) {
  const emptyStates = {
    recent: {
      title: t('library.empty.recent.title'),
      text: t('library.empty.recent.text')
    },

    recommended: {
      title: t('library.empty.recommended.title'),
      text: t('library.empty.recommended.text')
    },
    continue: {
      title: t('library.empty.continue.title'),
      text: t('library.empty.continue.text')
    },
    read: {
      title: t('library.empty.read.title'),
      text: t('library.empty.read.text')
    }
  };

  const currentPath = `/library/${view}`;
  const countHintLabel = view === 'continue' || view === 'recommended' || view === 'read' ? t('library.countInSection') : t('library.countInCatalog');
  const totalN = Math.max(0, Math.floor(Number(total) || 0));
  const totalNum = formatLocaleInt(totalN);
  const totalBookWord = plural('book', totalN);
  const libBatchJson = '';
  const content = `
    <section class="page-intro">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
    </section>
    ${items.length
      ? `<div class="list-context-hint list-context-hint-spacious">${escapeHtml(countHintLabel)}: <strong>${totalNum}</strong> ${totalBookWord}${page > 1 ? ` ${escapeHtml(t('library.pageSep'))} <strong>${formatLocaleInt(page)}</strong>` : ''}</div>
      <section class="library-shelf library-shelf-primary">
        <div data-load-more-grid data-load-more-api="/api/library/${encodeURIComponent(view)}" data-load-more-page="${page}" data-load-more-total="${total}" data-load-more-page-size="${pageSize}">${renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: false, user, readBookIds })}</div>
      </section>`
      : `
    <div class="list-context-hint list-context-hint-spacious">${escapeHtml(countHintLabel)}: <strong>${totalNum}</strong> ${totalBookWord}${page > 1 ? ` ${escapeHtml(t('library.pageSep'))} <strong>${formatLocaleInt(page)}</strong>` : ''}</div>
    <section class="library-shelf library-shelf-primary">
      ${renderEmptyState({
        title: emptyStates[view]?.title || t('library.empty.genericTitle'),
        text: emptyStates[view]?.text || t('library.empty.genericText'),
        actionHref: '/library/recent',
        actionLabel: t('library.openRecent')
      })}
    </section>`}
    ${total > page * pageSize ? `<div class="load-more-wrap"><button class="button load-more-button" data-load-more-trigger>${escapeHtml(t('catalog.loadMore'))}</button></div>` : ''}
    <noscript>${renderPagination(currentPath, page, pageSize, total)}</noscript>
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
  userRating = 0,
  avgRating = { average: 0, count: 0 },
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
  const summaryBits = [
    book.series ? `<a href="/facet/series/${encodeURIComponent(book.series)}">${escapeHtml(book.series)}${book.seriesNo ? ` #${escapeHtml(book.seriesNo)}` : ''}</a>` : '',
    (book.lang || 'unknown') ? `<a href="/facet/languages/${encodeURIComponent(book.lang || 'unknown')}">${escapeHtml(formatLanguageLabel(book.lang || 'unknown'))}</a>` : '',
    genreSummaryHtml
  ].filter(Boolean);
  const parentLibraryHref = book.series ? `/facet/series/${encodeURIComponent(book.series)}` : primaryAuthor ? `/facet/authors/${encodeURIComponent(primaryAuthor)}` : '/library/recent';
  const parentLibraryLabel = book.series
    ? tp('book.seriesPrefix', { name: book.series })
    : primaryAuthor
      ? tp('book.authorPrefix', { name: formatAuthorLabel(book.authors) })
      : t('nav.recent');
  const content = `
    <section class="book-detail-shell">
      <div class="book-detail-main card-detail-panel">
        <div class="book-detail-cover">
          <div class="cover ${hasRealCover ? '' : 'cover-fallback-active'}">
            <img class="cover-image is-loaded" src="/api/books/${encodeURIComponent(book.id)}/cover" alt="${escapeHtml(book.title)}">
            <span class="cover-fallback" ${hasRealCover ? 'hidden' : ''} aria-hidden="${hasRealCover ? 'true' : 'false'}">
              <img class="cover-fallback-image" src="/book-fallback.png" alt="">
              <span class="cover-fallback-overlay"></span>
              <span class="cover-fallback-copy">
                <span class="cover-fallback-title">${escapeHtml(book.title)}</span>
                <span class="cover-fallback-author">${escapeHtml(formatAuthorLabel(book.authors) || t('book.authorUnknown'))}</span>
              </span>
            </span>
          </div>
        </div>
        <div class="book-detail-content">
          <h2 class="book-detail-title">${escapeHtml(book.title)}</h2>
          <div class="author">${book.authors ? `<a href="/facet/authors/${encodeURIComponent(primaryAuthor)}">${escapeHtml(formatAuthorLabel(book.authors))}</a>` : escapeHtml(t('book.authorUnknown'))}</div>
          ${summaryBits.length ? `<div class="book-detail-summary">${summaryBits.join('<span class="book-detail-sep">·</span>')}</div>` : ''}
          <div class="book-detail-rating" data-rating-widget data-book-id="${escapeHtml(String(book.id))}" data-user-rating="${userRating}" data-avg="${avgRating.average}" data-count="${avgRating.count}"${user ? '' : ' data-readonly="true"'}>
            <div class="star-rating">
              ${[1,2,3,4,5].map(i => `<button type="button" class="star-btn${i <= userRating ? ' is-active' : ''}" data-star="${i}" aria-label="${i}"${user ? '' : ' disabled'}>★</button>`).join('')}
            </div>
            <span class="rating-info">${avgRating.count ? `<span class="rating-avg">${avgRating.average}</span> <span class="rating-count">(${avgRating.count})</span>` : `<span class="rating-empty">${escapeHtml(t('book.rating.noRatings'))}</span>`}</span>
          </div>
          ${
            details.annotationIsHtml && String(details.annotation || '').trim()
              ? `<div class="book-detail-annotation book-detail-annotation--html">${details.annotation}</div>`
              : `<p class="book-detail-annotation">${escapeHtml(details.annotation || t('book.noAnnotation'))}</p>`
          }
          <div class="book-detail-review-mount" data-book-review-mount data-book-review-for="${escapeHtml(String(book.id))}" data-review-heading="${escapeHtml(t('book.review'))}" hidden aria-hidden="true"></div>
          ${
            illustrationUrls.length
              ? `<section class="book-detail-side-block book-detail-illustrations"><details class="book-detail-disclosure book-detail-illustrations-disclosure"><summary><span class="book-detail-disclosure-title">${escapeHtml(t('book.illustrations'))}</span><span class="book-detail-disclosure-note">${formatLocaleInt(illustrationUrls.length)}</span></summary><div class="book-detail-illustrations-strip">${illustrationUrls.map((it, idx) => `<a href="${escapeHtml(it.url)}" data-illustration-link data-illustration-index="${idx}"><img src="${escapeHtml(it.url)}" alt="" loading="lazy"></a>`).join('')}</div></details></section>`
              : ''
          }
          <div class="actions actions-primary">
            ${renderDownloadMenu(book, { accent: true, user })}
            <a href="/read/${encodeURIComponent(book.id)}" class="button">${escapeHtml(t('book.read'))}</a>
          </div>
          ${(primaryAuthor || book.series) ? `<div class="book-detail-links">${primaryAuthor ? `<a href="/facet/authors/${encodeURIComponent(primaryAuthor)}">${escapeHtml(t('book.allByAuthor'))}</a>` : ''}${primaryAuthor && book.series ? '<span class="book-detail-sep">·</span>' : ''}${book.series ? `<a href="/facet/series/${encodeURIComponent(book.series)}">${escapeHtml(t('book.allInSeries'))}</a>` : ''}</div>` : ''}
          ${isAuthenticated ? `<div class="actions actions-secondary"><button class="button book-detail-read-action ${isRead ? 'is-active' : ''}" type="button" data-read-button="${escapeHtml(book.id)}">${isRead ? escapeHtml(t('book.markedRead')) : escapeHtml(t('book.markRead'))}</button><button class="button book-detail-bookmark-action ${bookmarked ? 'is-active' : ''}" type="button" data-bookmark-button="${escapeHtml(book.id)}" ${bookmarked ? 'data-active-favorite="true"' : ''}>${bookmarked ? escapeHtml(t('book.inFavorite')) : escapeHtml(t('book.addFavorite'))}</button><button class="button" type="button" data-add-to-shelf="${escapeHtml(book.id)}">${escapeHtml(t('book.toShelf'))}</button><button class="button" type="button" data-send-to-ereader="${escapeHtml(book.id)}">${escapeHtml(t('book.toEmail'))}</button></div>` : ''}
        </div>
      </div>
    </section>
    ${user?.role === 'admin' ? `
    <section class="book-edit-section">
      ${flash ? renderAlert('success', escapeHtml(flash)) : ''}
      <details class="book-edit-disclosure">
        <summary class="book-edit-summary">${escapeHtml(t('book.edit.title'))}</summary>
        <form class="book-edit-form" action="/book/${encodeURIComponent(book.id)}/edit" method="post">
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
              <input type="text" id="edit-series-no" name="seriesNo" value="${escapeHtml(book.seriesNo || '')}" style="max-width:100px">
            </div>
          </div>
          <div class="book-edit-actions">
            <button type="submit">${escapeHtml(t('book.edit.save'))}</button>
          </div>
        </form>
      </details>
    </section>
    ` : ''}
    <section class="library-shelf library-shelf-secondary book-detail-related-shelf">
      <div class="section-title">
        <h2>${escapeHtml(similar.title || t('book.similar'))}</h2>
      </div>
      ${similar.items?.length ? renderBookGrid(similar.items, { isAuthenticated, batchSelect: false, user, hideDownloads: Boolean(similar.hideDownloads), readBookIds }) : renderEmptyState({ title: t('book.similarEmptyTitle'), text: t('book.similarEmptyText') })}
    </section>`;
  return pageShell({ title: book.title, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: parentLibraryLabel, href: parentLibraryHref }, { label: book.title }], currentPath: '', csrfToken, readBookIds });
}


export function renderFavorites({ books = [], readBooks = [], authors = [], series = [], view = 'books', sort = 'date', user, stats, indexStatus, csrfToken = '', readBookIds = null, readSeriesNames = null, counts = null }) {
  const currentView = ['books', 'read', 'authors', 'series'].includes(view) ? view : 'books';
  // `counts` — дешёвый агрегат из getUserStats; fallback на .length для старого поведения.
  const favoritesViews = [
    { key: 'books', label: t('search.books'), count: counts?.books ?? books.length },
    { key: 'authors', label: t('search.authors'), count: counts?.authors ?? authors.length },
    { key: 'series', label: t('search.series'), count: counts?.series ?? series.length }
  ];
  const switcher = `
    <div class="view-switcher favorites-switcher">
      ${favoritesViews.map((item) => `<a class="button view-switcher-link ${item.key === currentView ? 'is-active' : ''}" href="/favorites?view=${encodeURIComponent(item.key)}">${escapeHtml(item.label)} <span class="favorites-switcher-count">${formatLocaleInt(item.count)}</span></a>`).join('')}
    </div>`;
  const bookSortOptions = [
    { value: 'date', label: t('sort.byDateAdded') },
    { value: 'title', label: t('sort.byTitle') },
    { value: 'author', label: t('sort.byAuthor') }
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
        <div class="actions">${renderSortControl({ action: '/favorites', sort, options: bookSortOptions, extraHidden: { view: 'books' } })}</div>
      </div>
      ${books.length ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderFavoriteBookGrid(books, { batchSelect: true, user, readBookIds })}</div>` : renderEmptyState({ title: t('favorites.emptyBooksTitle'), text: t('favorites.emptyBooksText'), actionHref: '/', actionLabel: t('favorites.toCatalog') })}
    </section>`;
  const readSection = `
    <section class="library-shelf library-shelf-secondary favorites-section favorites-section-books">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.read'))}</h2>
        <div class="actions">${renderSortControl({ action: '/favorites', sort, options: bookSortOptions, extraHidden: { view: 'read' } })}</div>
      </div>
      ${readBooks.length ? `<div class="batch-select-scope">${renderBatchDownloadToolbar({ adhoc: true }, { user })}${renderFavoriteBookGrid(readBooks, { batchSelect: true, user, readBookIds })}</div>` : renderEmptyState({ title: t('favorites.emptyReadTitle'), text: t('favorites.emptyReadText'), actionHref: '/', actionLabel: t('favorites.toCatalog') })}
    </section>`;
  const authorsSection = `
    <section class="library-shelf library-shelf-secondary favorites-section">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.authors'))}</h2>
        <div class="actions">${renderSortControl({ action: '/favorites', sort, options: entitySortOptions, extraHidden: { view: 'authors' } })}</div>
      </div>
      <div class="table-list entity-list favorites-list">
        ${authors.map((item) => `
          <a class="table-row table-row-link favorites-row" href="/facet/authors/${encodeURIComponent(item.name)}">
            <div class="favorites-row-main">
              <strong>${escapeHtml(item.displayName || item.name)}</strong><br>
              <span class="muted">${countLabel('book', item.bookCount)} ${escapeHtml(t('entity.inLibrary'))}</span>
            </div>
            <div class="actions favorites-row-actions">
              <button class="button" type="button" data-favorite-author="${escapeHtml(item.name)}">${escapeHtml(t('book.remove'))}</button>
            </div>
          </a>
        `).join('') || renderEmptyState({ title: t('favorites.emptyAuthorsTitle'), text: t('favorites.emptyAuthorsText'), actionHref: '/authors', actionLabel: t('favorites.openAuthors') })}
      </div>
    </section>`;
  const seriesSection = `
    <section class="library-shelf library-shelf-secondary favorites-section">
      <div class="section-title">
        <h2>${escapeHtml(t('favorites.series'))}</h2>
        <div class="actions">${renderSortControl({ action: '/favorites', sort, options: entitySortOptions, extraHidden: { view: 'series' } })}</div>
      </div>
      <div class="table-list entity-list favorites-list">
        ${series.map((item) => `
          <a class="table-row table-row-link favorites-row" href="/facet/series/${encodeURIComponent(item.name)}">
            <div class="favorites-row-main" style="display:flex;align-items:center">
              <span><strong>${escapeHtml(item.displayName || item.name)}</strong><br>
              <span class="muted">${countLabel('book', item.bookCount)} ${escapeHtml(t('entity.inLibrary'))}</span></span>
              ${readSeriesNames && readSeriesNames.has(item.name) ? `<span class="read-series-badge">${READ_CHECK_SVG}</span>` : ''}
            </div>
            <div class="actions favorites-row-actions">
              <button class="button" type="button" data-favorite-series="${escapeHtml(item.name)}">${escapeHtml(t('book.remove'))}</button>
            </div>
          </a>
        `).join('') || renderEmptyState({ title: t('favorites.emptySeriesTitle'), text: t('favorites.emptySeriesText'), actionHref: '/series', actionLabel: t('favorites.openSeries') })}
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
    ${switcher}
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

export function renderBrowsePage({ title, items, total, page, pageSize, user, stats, query, letter = '', path, facetBasePath, indexStatus, sort, csrfToken = '', genreGroups = null, readSeriesNames = null }) {
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

export function renderFacetBooks({ title, items, total, page, pageSize, user, stats, facetPath, indexStatus, sort, breadcrumbs, summary = {}, facet = '', facetValue = '', favorite = false, seriesRead = false, csrfToken = '', readBookIds = null }) {
  const facetAction = user && (facet === 'authors' || facet === 'series')
    ? `<button class="button ${favorite ? 'is-active' : ''}" type="button" ${facet === 'authors' ? `data-favorite-author="${escapeHtml(facetValue)}"` : `data-favorite-series="${escapeHtml(facetValue)}"`} ${favorite ? 'data-active-favorite="true"' : ''}>${favorite ? escapeHtml(t('facet.inFavorite')) : escapeHtml(t('facet.addFavorite'))}</button>`
    : '';
  const markSeriesReadBtn = user && facet === 'series' && items.length
    ? `<button class="button${seriesRead ? ' is-active' : ''}" type="button" data-mark-series-read="${escapeHtml(facetValue)}">${seriesRead ? escapeHtml(t('facet.seriesMarkedRead')) : escapeHtml(t('facet.markSeriesRead'))}</button>`
    : '';
  const hasMore = items.length > 0 && total > page * pageSize;
  const facetLoadMoreApi = hasMore
    ? `/api/facet-books?${new URLSearchParams({ facet: String(facet), value: String(facetValue), sort: String(sort || 'recent') }).toString()}`
    : '';
  const batchCtx = facet === 'series' && facetValue !== '' ? { facet: 'series', value: facetValue } : null;
  const batchCtxJson = batchCtx ? escapeHtml(JSON.stringify(batchCtx)) : '';
  const showBatch = Boolean(batchCtx && items.length && canDownloadInUi(user));
  const booksBlock = !items.length
    ? renderEmptyState({ title: t('facet.emptyTitle'), text: t('facet.emptyText'), actionHref: '/', actionLabel: t('facet.toCatalog') })
    : hasMore
      ? `<div data-load-more-grid data-load-more-api="${escapeHtml(facetLoadMoreApi)}" data-load-more-page="${page}" data-load-more-total="${total}" data-load-more-page-size="${pageSize}"${showBatch ? ` data-batch-context="${batchCtxJson}"` : ''}>${renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: showBatch, user, readBookIds })}</div>`
      : renderBookGrid(items, { isAuthenticated: Boolean(user), batchSelect: showBatch, user, readBookIds });
  const facetBatchInner = `
    <section class="page-intro page-intro-slim">
      <div class="page-intro-copy">
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="page-intro-actions">
        ${facetAction}
        ${markSeriesReadBtn}
        ${renderSortControl({
          action: facetPath,
          sort,
          options: [
            { value: 'recent', label: t('sort.recentFirst') },
            { value: 'title', label: t('sort.byTitle') },
            { value: 'author', label: t('sort.byAuthor') },
            { value: 'series', label: t('sort.bySeries') }
          ]
        })}
      </div>
    </section>
    ${showBatch ? renderBatchDownloadToolbar(batchCtx, { user }) : ''}
    <div class="list-context-hint list-context-hint-spacious">${escapeHtml(t('facet.inSectionCount'))} <strong>${formatLocaleInt(Math.max(0, Math.floor(Number(total) || 0)))}</strong> ${plural('book', total)}${page > 1 ? ` ${escapeHtml(t('library.pageSep'))} <strong>${formatLocaleInt(page)}</strong>` : ''}</div>
    ${booksBlock}
    ${hasMore ? `<div class="load-more-wrap"><button class="button load-more-button" data-load-more-trigger>${escapeHtml(t('catalog.loadMore'))}</button></div>` : ''}
    ${hasMore
      ? `<noscript>${renderPagination(`${facetPath}?sort=${encodeURIComponent(sort || 'recent')}`, page, pageSize, total)}</noscript>`
      : renderPagination(`${facetPath}?sort=${encodeURIComponent(sort || 'recent')}`, page, pageSize, total)}
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
      ? `<section class="book-detail-side-block author-facet-bio-block"><h3>${escapeHtml(t('book.aboutAuthor'))}</h3><div class="book-detail-author-bio book-detail-author-bio--facet">${authorBioHtml}</div></section>`
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
          ${bioBlock}
        </div>
      </div>
    </section>`;

  const controls = `
    <section class="page-intro page-intro-slim author-facet-controls">
      <div class="page-intro-actions author-facet-controls-actions">
        ${facetAction}
        ${renderSortControl({
          action: facetPath,
          sort,
          options: [
            { value: 'recent', label: t('sort.recentFirst') },
            { value: 'title', label: t('sort.byTitle') },
            { value: 'series', label: t('sort.bySeries') }
          ]
        })}
      </div>
    </section>`;

  const anyBooks = series.some((s) => (Number(s.bookCount) || 0) > 0) || standaloneBooks.length > 0;
  const outsideSeriesHref = facetValue
    ? `/facet/authors/${encodeURIComponent(facetValue)}/outside-series?sort=${encodeURIComponent(sort || 'recent')}`
    : '';
  const seriesListHtml = (series.length || standaloneBooks.length)
    ? `<section class="library-shelf library-shelf-secondary author-facet-series-block">${renderAuthorFacetSeriesList(series, standaloneBooks.length ? { href: outsideSeriesHref, label: t('authorPage.outsideSeries'), bookCount: standaloneBooks.length } : null, readSeriesNames)}</section>`
    : '';
  const listsCombined = seriesListHtml;

  const booksInner = !anyBooks
    ? renderEmptyState({
        title: t('facet.emptyTitle'),
        text: t('facet.emptyText'),
        actionHref: '/',
        actionLabel: t('facet.toCatalog')
      })
    : listsCombined;

  const genreSummary =
    summary.secondaryItems?.length && summary.secondaryPath
      ? `<div class="facet-summary-group">${renderFacetSummaryBlock(summary.secondaryTitle, summary.secondaryItems, summary.secondaryPath)}</div>`
      : '';

  const content = `
    ${hero}
    ${controls}
    ${booksInner}
    ${genreSummary}
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
  const content = `
    ${controls}
    ${outsideBatch ? renderBatchDownloadToolbar({ adhoc: true }, { user }) : ''}
    <div class="list-context-hint list-context-hint-spacious">${escapeHtml(t('facet.inSectionCount'))} <strong>${formatLocaleInt(Math.max(0, Math.floor(Number(total) || 0)))}</strong> ${plural('book', total)}</div>
    ${booksBlock}
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
    readBookIds
  });
}

export function renderShelves({ shelves = [], user, stats, indexStatus, csrfToken = '' }) {
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
      <form data-shelf-create class="shelf-create-form">
        <input type="text" name="name" placeholder="${escapeHtml(t('shelves.newPlaceholder'))}" required>
        <button type="submit">${escapeHtml(t('shelves.create'))}</button>
      </form>
      ${shelves.length ? `
        <div class="table-list entity-list">
          ${shelves.map((shelf) => `
            <div class="table-row table-row-clickable" data-shelf-row="${shelf.id}" data-href="/shelves/${shelf.id}">
              <div class="shelf-row-info">
                <strong>${escapeHtml(shelf.name)}</strong>
                ${shelf.description ? `<br><span class="muted">${escapeHtml(shelf.description)}</span>` : ''}
                <br><span class="muted">${countLabel('book', shelf.bookCount)}</span>
                ${shelf.previewBookIds && shelf.previewBookIds.length ? `
                  <div class="shelf-covers-preview">
                    ${shelf.previewBookIds.map((bookId) => `<img class="shelf-cover-thumb" src="/api/books/${encodeURIComponent(bookId)}/cover" alt="" loading="lazy" onerror="this.style.display='none'">`).join('')}
                  </div>
                ` : ''}
              </div>
              <div class="actions">
                <button class="button" type="button" data-shelf-delete="${shelf.id}" data-shelf-name="${escapeHtml(shelf.name)}" data-shelf-description="${escapeHtml(shelf.description || '')}">${escapeHtml(t('shelves.delete'))}</button>
              </div>
            </div>
          `).join('')}
        </div>
      ` : renderEmptyState({ title: t('shelves.emptyTitle'), text: t('shelves.emptyText') })}
    </section>`;
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
          <article class="card" data-book-id="${escapeHtml(book.id)}">
            ${shelfBatch ? `<label class="batch-select-hit" title="${escapeHtml(t('batch.selectTitle'))}"><input type="checkbox" class="batch-select-cb" ${batchSelectInputAttrs(book.id)} data-batch-book-id="${escapeHtml(book.id)}" aria-label="${escapeHtml(t('batch.selectAria'))}"></label>` : ''}
            <a class="cover-wrapper" href="/book/${encodeURIComponent(book.id)}">
              <div class="cover" data-role="cover">
                <img class="cover-image is-loaded" loading="lazy" src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" data-cover-src="/api/books/${encodeURIComponent(book.id)}/cover-thumb" alt="${escapeHtml(book.title)}">
                <span class="cover-fallback" hidden>
                  <img class="cover-fallback-image" src="/book-fallback.png" alt="">
                  <span class="cover-fallback-overlay"></span>
                  <span class="cover-fallback-copy">
                    <span class="cover-fallback-title">${escapeHtml(book.title)}</span>
                    <span class="cover-fallback-author">${escapeHtml(formatAuthorLabel(book.authors) || t('book.authorUnknown'))}</span>
                  </span>
                </span>
              </div>
              <div class="cover-highlight"></div>
            </a>${readBookIds && readBookIds.has(book.id) ? `<span class="read-badge">${READ_CHECK_SVG}</span>` : ''}
            <div class="meta">
              <h3><a href="/book/${encodeURIComponent(book.id)}">${escapeHtml(book.title)}</a></h3>
              <div class="author">${book.authors ? `<a href="/facet/authors/${encodeURIComponent(book.authorsList?.[0] || firstAuthorValue(book.authors))}">${escapeHtml(formatAuthorLabel(book.authors))}</a>` : escapeHtml(t('book.authorUnknown'))}</div>
              ${book.series ? `<div class="card-series"><a href="/facet/series/${encodeURIComponent(book.series)}">${escapeHtml(book.series)}${book.seriesNo ? ` #${escapeHtml(book.seriesNo)}` : ''}</a></div>` : ''}
              <div class="card-actions card-actions-favorites">
                ${shelfBatch ? '' : renderDownloadMenu(book, { compact: true, user })}
                <button class="button card-remove-favorite-action" type="button" data-shelf-remove-book="${escapeHtml(book.id)}" data-shelf-id="${shelf.id}">${escapeHtml(t('book.remove'))}</button>
              </div>
            </div>
          </article>
        `).join('')}
      </div>
    ` : renderEmptyState({ title: t('shelfDetail.emptyTitle'), text: t('shelfDetail.emptyText'), actionHref: '/', actionLabel: t('favorites.toCatalog') })}
    ${shelfBatch ? '</div>' : ''}`;
  return pageShell({ title: shelf.name, content, user, stats, indexStatus, breadcrumbs: [{ label: t('nav.home'), href: '/' }, { label: t('shelves.title'), href: '/shelves' }, { label: shelf.name }], currentPath: '/shelves', csrfToken, readBookIds });
}

export function renderReader({ book, details, user, csrfToken = '' }) {
  const ext = String(book.ext || 'fb2').toLowerCase();
  const title = details?.title || book.title || t('opds.noTitle');
  const htmlLang = getLocale() === 'en' ? 'en' : 'ru';
  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
${csrfToken ? `<meta name="csrf-token" content="${escapeHtml(csrfToken)}">` : ''}
<title>${escapeHtml(siteTitleForDisplay())} \u2014 ${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="stylesheet" href="/reader.css">
<script>try{var _t=JSON.parse(localStorage.getItem('reader-settings')||'{}').theme||'sepia';document.documentElement.dataset.readerTheme=_t}catch(e){document.documentElement.dataset.readerTheme='sepia'}</script>
</head>
<body class="chrome-hidden">
<script type="application/json" id="ui-i18n-json">${serializeClientI18n()}</script>

<div class="reader-toolbar reader-chrome" id="toolbar">
  <div class="tb-left">
    <a href="/book/${encodeURIComponent(book.id)}" class="tb-btn" title="${escapeHtml(t('reader.back'))}" aria-label="${escapeHtml(t('reader.backToBook'))}"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></a>
    <div class="tb-meta">
      <span class="tb-kicker">${escapeHtml(t('reader.reading'))}</span>
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
      <button class="tb-btn tb-tts-skip js-tts-next" type="button" id="btn-tts-next" disabled title="${escapeHtml(t('reader.ttsNext'))}" aria-label="${escapeHtml(t('reader.ttsNext'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5h2v14h-2V5zm-2.4 7L8 5v14l7.6-7z" fill="currentColor"/></svg></button>
    </div>
    <button class="tb-btn" type="button" id="btn-fullscreen" title="${escapeHtml(t('reader.fullscreen'))}" aria-label="${escapeHtml(t('reader.fullscreen'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3"/></svg></button>
    <button class="tb-btn" type="button" id="btn-day-night" title="${escapeHtml(t('reader.nightMode'))}" aria-label="${escapeHtml(t('reader.dayModeToggle'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg></button>
    <button class="tb-btn" type="button" id="btn-bookmark-add" title="${escapeHtml(t('reader.bookmark'))}" aria-label="${escapeHtml(t('reader.addBookmark'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg></button>
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
    <button type="button" class="reader-tts-dock-btn tb-btn js-tts-prev" id="btn-tts-dock-prev" disabled title="${escapeHtml(t('reader.ttsPrev'))}" aria-label="${escapeHtml(t('reader.ttsPrev'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6V5zm3.6 7L18 5v14L9.6 12z" fill="currentColor"/></svg></button>
    <button type="button" class="reader-tts-dock-btn tb-btn reader-tts-dock-main" id="btn-tts-dock" title="${escapeHtml(t('reader.ttsPlay'))}" aria-label="${escapeHtml(t('reader.tts'))}"><svg class="tts-main-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="tts-main-path" fill="currentColor" d="M8 5v14l11-7z"/></svg></button>
    <button type="button" class="reader-tts-dock-btn tb-btn js-tts-next" id="btn-tts-dock-next" disabled title="${escapeHtml(t('reader.ttsNext'))}" aria-label="${escapeHtml(t('reader.ttsNext'))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5h2v14h-2V5zm-2.4 7L8 5v14l7.6-7z" fill="currentColor"/></svg></button>
  </div>
</div>

<div class="reader-book-pages" id="reader-book-pages" aria-hidden="true">
  <span class="book-page-num" id="book-page-left"></span>
  <span class="book-page-num" id="book-page-right"></span>
</div>

<div class="panel-overlay" id="panel-overlay">
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
      <button class="panel-tab" data-tab="bookmarks">${escapeHtml(t('reader.panelBookmarks'))}</button>
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
    <div class="panel-body" data-panel-tab="bookmarks" style="visibility:hidden;position:absolute;pointer-events:none">
      <div id="bookmarks-content"><div class="bm-empty">${escapeHtml(t('reader.loading'))}</div></div>
    </div>
    <div class="panel-body" data-panel-tab="settings" style="visibility:hidden;position:absolute;pointer-events:none">
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.theme'))}</div>
        <div class="rs-themes">
          <button class="rs-theme-dot" type="button" data-set-theme="dark"><span class="rs-dot-label">${escapeHtml(t('reader.themeDark'))}</span></button>
          <button class="rs-theme-dot" type="button" data-set-theme="light"><span class="rs-dot-label">${escapeHtml(t('reader.themeLight'))}</span></button>
          <button class="rs-theme-dot" type="button" data-set-theme="sepia"><span class="rs-dot-label">${escapeHtml(t('reader.themeSepia'))}</span></button>
          <button class="rs-theme-dot" type="button" data-set-theme="night"><span class="rs-dot-label">${escapeHtml(t('reader.themeNight'))}</span></button>
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
        <select id="rs-font-family" name="readerFontFamily" class="rs-select" aria-label="${escapeHtml(t('reader.fontFaceAria'))}">
          <option value="serif">Georgia</option>
          <option value="palatino">Palatino</option>
          <option value="times">Times New Roman</option>
          <option value="charter">Charter</option>
          <option value="sans">${escapeHtml(t('reader.fontSans'))}</option>
          <option value="verdana">Verdana</option>
          <option value="arial">Arial</option>
          <option value="mono">${escapeHtml(t('reader.fontMono'))}</option>
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
      <div class="rs-group">
        <div class="rs-label">${escapeHtml(t('reader.layoutMode'))}</div>
        <div class="rs-seg">
          <button type="button" data-set-layout="paginated">${escapeHtml(t('reader.layoutPaginated'))}</button>
          <button type="button" data-set-layout="dual">${escapeHtml(t('reader.layoutDual'))}</button>
        </div>
      </div>
      <div class="rs-actions">
        <button type="button" class="rs-reset" id="reader-reset-settings">${escapeHtml(t('reader.reset'))}</button>
      </div>
    </div>
  </div>
</div>

<div class="reader-toast" id="reader-toast"></div>

<script>window.__READER_BOOK_ID=${JSON.stringify(book.id).replace(/</g, '\\u003c')};window.__READER_BOOK_EXT=${JSON.stringify(ext).replace(/</g, '\\u003c')}</script>
<script type="module" src="/reader.js"></script>
</body>
</html>`;
}

export function renderProfile({ user, stats, indexStatus, userStats, ereaderEmail = '', recentBooks = [], readerBookmarks = [], flash = '', csrfToken = '' }) {
  const fmtDate = (d) => formatLocaleDateLong(d);

  const readingTotal = Math.max(0, Math.floor(Number(userStats.readingCount) || 0));
  const readBooksTotal = Math.max(0, Math.floor(Number(userStats.readBooksCount) || 0));
  const readSeriesTotal = Math.max(0, Math.floor(Number(userStats.readSeriesCount) || 0));
  const readerBmTotal = Math.max(0, Math.floor(Number(userStats.readerBookmarksCount) || 0));
  const bookmarkBooks = Math.max(0, Math.floor(Number(userStats.bookmarkCount) || 0));
  const favAuthors = Math.max(0, Math.floor(Number(userStats.favoriteAuthorsCount) || 0));
  const favSeries = Math.max(0, Math.floor(Number(userStats.favoriteSeriesCount) || 0));
  const shelvesCount = Math.max(0, Math.floor(Number(userStats.shelvesCount) || 0));
  const readingAllLine = tp('profile.readingAll', { n: formatLocaleInt(readingTotal), books: plural('book', readingTotal) });

  const recentList = recentBooks.length
    ? recentBooks.map((b) => `
        <div class="profile-list-item" data-profile-reading="${escapeHtml(b.id)}" data-reading-last-opened="${escapeHtml(String(b.lastOpenedAt || ''))}" data-reading-open-count="${Number(b.openCount) > 0 ? Number(b.openCount) : 1}">
          <a class="profile-list-link" href="/book/${encodeURIComponent(b.id)}">${escapeHtml(b.title)}</a>
          <span class="muted profile-list-meta">${escapeHtml(formatAuthorLabel(b.authors) || '')}</span>
          <button type="button" class="profile-remove-btn" data-remove-reading="${escapeHtml(b.id)}" title="${escapeHtml(t('profile.removeTitle'))}">&times;</button>
        </div>`).join('')
    : `<div class="muted" style="padding:4px 0;">${escapeHtml(t('profile.nothingYet'))}</div>`;

  const initialTab = flash ? 'settings' : 'activity';
  const tabActivityActive = initialTab === 'activity';

  const content = `
    ${flash ? renderAlert('success', escapeHtml(flash)) : ''}
    <div class="section-title">
      <h2>${escapeHtml(user.username)}</h2>
      <div class="muted">${escapeHtml(fmtDate(userStats.createdAt))} · ${escapeHtml(user.role === 'admin' ? t('profile.admin') : t('profile.user'))}</div>
    </div>
    <div class="profile-shell" data-profile-root data-profile-initial-tab="${initialTab}">
    <div hidden data-profile-page-stats data-reading-total="${readingTotal}" data-reader-bm-total="${readerBmTotal}"></div>
    <div class="view-switcher profile-tablist" role="tablist" aria-label="${escapeHtml(t('profile.tablistAria'))}">
      <button type="button" class="button profile-tab view-switcher-link${tabActivityActive ? ' is-active' : ''}" role="tab" id="profile-tab-activity" aria-controls="profile-panel-activity" aria-selected="${tabActivityActive ? 'true' : 'false'}" tabindex="${tabActivityActive ? '0' : '-1'}" data-profile-tab="activity">${escapeHtml(t('profile.tabActivity'))}</button>
      <button type="button" class="button profile-tab view-switcher-link${tabActivityActive ? '' : ' is-active'}" role="tab" id="profile-tab-settings" aria-controls="profile-panel-settings" aria-selected="${tabActivityActive ? 'false' : 'true'}" tabindex="${tabActivityActive ? '-1' : '0'}" data-profile-tab="settings">${escapeHtml(t('profile.tabSettings'))}</button>
    </div>
    <div id="profile-panel-activity" class="profile-tab-panel" role="tabpanel" aria-labelledby="profile-tab-activity" data-profile-panel="activity"${tabActivityActive ? '' : ' hidden'}>
      <div class="table-list">
          <div class="table-row table-row-stack">
            <div>
              <strong>${escapeHtml(t('profile.reading'))}</strong>
              <div style="margin-top:6px;">${recentList}</div>
              <a href="/library/continue" class="profile-reading-all-link" data-profile-reading-all-link ${readingTotal === 0 ? 'hidden' : ''}>${escapeHtml(readingAllLine)}</a>
            </div>
          </div>
          <div class="table-row table-row-stack">
            <div>
              <strong>${escapeHtml(t('profile.readBooks'))}</strong>
              <div style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:6px;font-size:.92em;">
                ${readBooksTotal > 0
                  ? `<a href="/library/read">${countLabel('book', readBooksTotal)}</a>`
                  : `<span class="muted">${escapeHtml(t('profile.nothingYet'))}</span>`}
                ${readSeriesTotal > 0
                  ? `<a href="/library/read">${countLabel('series', readSeriesTotal)}</a>`
                  : ''}
              </div>
            </div>
          </div>
          <div class="table-row table-row-stack">
            <div>
              <strong>${escapeHtml(t('profile.favorites'))}</strong>
              <div style="display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:6px;font-size:.92em;">
                <a href="/favorites?view=books">${countLabel('book', bookmarkBooks)}</a>
                <a href="/favorites?view=authors">${countLabel('author', favAuthors)}</a>
                <a href="/favorites?view=series">${countLabel('series', favSeries)}</a>
              </div>
            </div>
          </div>
          <a class="table-row table-row-link" href="/shelves" style="display:flex;text-decoration:none;color:inherit;font-size:.92em;">
            <strong>${formatLocaleInt(shelvesCount)}</strong>&nbsp;${escapeHtml(plural('shelf', shelvesCount))}
          </a>
          <div class="table-row table-row-stack">
            <div>
              <strong>${escapeHtml(t('profile.readerBookmarks'))}</strong> <span class="muted" style="font-size:.85em;">(<span data-profile-reader-bm-count>${formatLocaleInt(readerBmTotal)}</span>)</span>
              ${readerBookmarks.length ? `<div style="margin-top:6px;">${readerBookmarks.map((bm) => `
                <div class="profile-list-item" data-profile-bookmark="${escapeHtml(String(bm.id))}" data-reader-bm-book-id="${escapeHtml(String(bm.bookId))}" data-reader-bm-position="${escapeHtml(String(bm.position ?? ''))}" data-reader-bm-title="${escapeHtml(String(bm.label || ''))}">
                  <a class="profile-list-link" href="/read/${encodeURIComponent(bm.bookId)}?pos=${encodeURIComponent(bm.position)}" title="${escapeHtml(bm.bookTitle)}">${escapeHtml(bm.label || bm.bookTitle)}</a>
                  <span class="muted profile-list-meta">${escapeHtml(bm.bookTitle !== bm.label && bm.label ? bm.bookTitle : '')}</span>
                  <button type="button" class="profile-remove-btn" data-remove-bookmark="${escapeHtml(String(bm.id))}" title="${escapeHtml(t('profile.removeTitle'))}">&times;</button>
                </div>`).join('')}</div>` : `<div class="muted" style="padding:4px 0;margin-top:6px;">${escapeHtml(t('profile.noBookmarks'))}</div>`}
            </div>
          </div>
      </div>
    </div>
    <div id="profile-panel-settings" class="profile-tab-panel" role="tabpanel" aria-labelledby="profile-tab-settings" data-profile-panel="settings"${tabActivityActive ? ' hidden' : ''}>
      <div class="table-list">
        <div class="table-row table-row-stack profile-form-row">
          <div>
            <strong>${escapeHtml(t('profile.ereaderEmail'))}</strong>
            <form method="post" action="/profile/email" class="vertical-form" style="margin-top:8px;">
              ${csrfHiddenField(csrfToken)}
              <div><input type="email" name="ereaderEmail" value="${escapeHtml(ereaderEmail)}" placeholder="kindle@kindle.com"></div>
              <div class="actions"><button type="submit">${escapeHtml(t('profile.save'))}</button></div>
            </form>
          </div>
        </div>
        <div class="table-row table-row-stack profile-form-row">
          <div>
            <strong>${escapeHtml(t('profile.changePassword'))}</strong>
            <div class="muted" style="margin:4px 0 8px;font-size:12px;">${escapeHtml(t('profile.passwordRules'))}</div>
            <form method="post" action="/profile/password" class="vertical-form">
              ${csrfHiddenField(csrfToken)}
              <div><input type="password" name="currentPassword" placeholder="${escapeHtml(t('profile.currentPassword'))}" autocomplete="current-password" required></div>
              <div><input type="password" name="newPassword" placeholder="${escapeHtml(t('profile.newPassword'))}" autocomplete="new-password" required></div>
              <div><input type="password" name="confirmPassword" placeholder="${escapeHtml(t('profile.confirmPassword'))}" autocomplete="new-password" required></div>
              <div class="actions"><button type="submit">${escapeHtml(t('profile.changeBtn'))}</button></div>
            </form>
          </div>
        </div>
      </div>
    </div>
    </div>
  `;
  return pageShell({ title: t('profile.title'), content, user, stats, indexStatus, breadcrumbs: [{ label: t('profile.title') }], currentPath: '/profile', csrfToken });
}
