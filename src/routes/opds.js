/**
 * OPDS (Open Publication Distribution System) маршруты.
 */
import iconv from 'iconv-lite';
import { t, tp, countLabel } from '../i18n.js';
import { requireOpdsAuth } from '../middleware/auth.js';
import { formatGenreLabel, getGenreGroups } from '../genre-map.js';
import { safePage } from '../utils/safe-int.js';
import { getOrExtractBookDetails } from '../fb2.js';
import { attachFlibustaAnnotationsFromShards } from '../flibusta-sidecar.js';
import {
  listGenres, getBookById,
  opdsQuery,
  getAuthorBooksOpds,
  getAuthorSeriesBooksOpds,
  getSeriesBooksOpds,
  opdsSearchAuthors,
  searchCatalog,
  getBookmarks,
  getFavoriteAuthorsLight,
  getFavoriteSeriesLight,
} from '../inpx.js';
import { getUserShelves, getShelfById, getShelfBooks } from '../db.js';
import { listSmartShelves, getSmartShelf, getSmartShelfBooks } from '../smart-shelves.js';
import {
  renderOpdsRoot,
  renderOpdsOpenSearch,
  renderOpdsSectionFeed,
  renderOpdsBooksFeed,
  renderOpdsBookDetail,
} from '../templates.js';

function formatAuthorForOpds(author) {
  if (!author) return '';
  const parts = author.split(',');
  return parts.slice(0, 3).join(', ') + (parts.length > 3 ? t('opds.authorEtAl') : '');
}

/**
 * @param {import('express').Application} app
 * @param {{ baseUrl: (req: import('express').Request) => string }} deps
 */
export function registerOpdsRoutes(app, deps) {
  const { baseUrl } = deps;

  function buildUserOpdsEntries(username) {
    if (!username) return [];
    return [
      {
        id: 'user-library',
        title: t('opds.user.myLibrary'),
        href: '/opds/user',
        content: t('opds.user.bookmarksDesc')
      }
    ];
  }

  app.get('/opds', requireOpdsAuth, (req, res) => {
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsRoot(baseUrl(req), { userEntries: buildUserOpdsEntries(req.user?.username) }));
  });

  app.get('/opds/root', requireOpdsAuth, (req, res) => {
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsRoot(baseUrl(req), { userEntries: buildUserOpdsEntries(req.user?.username) }));
  });

  app.get('/opds/user', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) {
      return res.type('application/atom+xml; charset=utf-8')
        .send(renderOpdsSectionFeed(baseUrl(req), { id: 'user', title: t('opds.user.myLibrary'), selfPath: '/opds/user', entries: [] }));
    }
    const entries = [
      {
        id: 'user-bookmarks',
        title: t('opds.user.bookmarks'),
        href: '/opds/user/bookmarks',
        content: t('opds.user.bookmarksDesc')
      },
      {
        id: 'user-shelves',
        title: t('opds.user.shelves'),
        href: '/opds/user/shelves',
        content: t('opds.user.shelvesDesc')
      },
      {
        id: 'user-smart-shelves',
        title: t('opds.user.smartShelves'),
        href: '/opds/user/smart-shelves',
        content: t('opds.user.smartShelvesDesc')
      },
      {
        id: 'user-fav-authors',
        title: t('opds.user.favoriteAuthors'),
        href: '/opds/user/favorite-authors',
        content: t('opds.user.favoriteAuthorsDesc')
      },
      {
        id: 'user-fav-series',
        title: t('opds.user.favoriteSeries'),
        href: '/opds/user/favorite-series',
        content: t('opds.user.favoriteSeriesDesc')
      },
    ];
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(baseUrl(req), { id: 'user', title: t('opds.user.myLibrary'), selfPath: '/opds/user', entries }));
  });

  app.get('/opds/user/bookmarks', requireOpdsAuth, async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type('text/plain').send(t('api.auth.unauthorized'));
    const items = getBookmarks(username, 'date');
    await attachFlibustaAnnotationsFromShards(items);
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsBooksFeed(baseUrl(req), { username: req.user?.username,
      id: 'user-bookmarks',
      title: t('opds.user.bookmarks'),
      selfPath: '/opds/user/bookmarks',
      items
    }));
  });

  app.get('/opds/user/shelves', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type('text/plain').send(t('api.auth.unauthorized'));
    const shelves = getUserShelves(username);
    const entries = shelves.map((shelf) => ({
      id: `shelf-${shelf.id}`,
      title: shelf.name,
      href: `/opds/user/shelves/${shelf.id}`,
      content: countLabel('book', shelf.bookCount)
    }));
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(baseUrl(req), { id: 'user-shelves', title: t('opds.user.shelves'), selfPath: '/opds/user/shelves', entries }));
  });

  app.get('/opds/user/shelves/:id', requireOpdsAuth, async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type('text/plain').send(t('api.auth.unauthorized'));
    const shelfId = Number(req.params.id);
    if (!Number.isFinite(shelfId) || shelfId < 1) return res.status(404).type('text/plain').send(t('shelf.notFound'));
    const shelf = getShelfById(shelfId, username);
    if (!shelf) return res.status(404).type('text/plain').send(t('shelf.notFound'));
    const items = getShelfBooks(shelf.id, username);
    await attachFlibustaAnnotationsFromShards(items);
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsBooksFeed(baseUrl(req), { username: req.user?.username,
      id: `user-shelf-${shelf.id}`,
      title: shelf.name,
      selfPath: req.originalUrl,
      items
    }));
  });

  app.get('/opds/user/smart-shelves', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type('text/plain').send(t('api.auth.unauthorized'));
    const entries = listSmartShelves(username).map((shelf) => ({
      id: `smart-shelf-${shelf.id}`,
      title: shelf.name,
      href: `/opds/user/smart-shelves/${shelf.id}`,
      acquisition: true
    }));
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(baseUrl(req), { id: 'user-smart-shelves', title: t('opds.user.smartShelves'), selfPath: '/opds/user/smart-shelves', entries }));
  });

  app.get('/opds/user/smart-shelves/:id', requireOpdsAuth, async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type('text/plain').send(t('api.auth.unauthorized'));
    const shelf = getSmartShelf(req.params.id, username);
    if (!shelf) return res.status(404).type('text/plain').send(t('shelf.notFound'));
    const page = safePage(req.query.page);
    const limit = 100;
    const result = getSmartShelfBooks(shelf, { page, pageSize: limit });
    await attachFlibustaAnnotationsFromShards(result.items);
    const nextHref = result.total > page * limit ? `/opds/user/smart-shelves/${shelf.id}?page=${page + 1}` : '';
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsBooksFeed(baseUrl(req), {
      username,
      id: `user-smart-shelf-${shelf.id}`,
      title: shelf.name,
      selfPath: req.originalUrl,
      items: result.items,
      nextHref
    }));
  });

  app.get('/opds/user/favorite-authors', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type('text/plain').send(t('api.auth.unauthorized'));
    const authors = getFavoriteAuthorsLight(username, 500);
    const entries = authors.map((a) => ({
      id: `fav-author-${a.name}`,
      title: formatAuthorForOpds(a.displayName || a.name),
      href: `/opds/author?author=${encodeURIComponent('=' + a.name)}`,
    }));
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(baseUrl(req), { id: 'user-fav-authors', title: t('opds.user.favoriteAuthors'), selfPath: '/opds/user/favorite-authors', entries }));
  });

  app.get('/opds/user/favorite-series', requireOpdsAuth, async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type('text/plain').send(t('api.auth.unauthorized'));
    const series = getFavoriteSeriesLight(username, 500);
    const entries = series.map((s) => ({
      id: `fav-series-${s.name}`,
      title: s.displayName || s.name,
      href: `/opds/series?series=${encodeURIComponent('=' + s.name)}`,
    }));
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(baseUrl(req), { id: 'user-fav-series', title: t('opds.user.favoriteSeries'), selfPath: '/opds/user/favorite-series', entries }));
  });

  app.get('/opds/opensearch', requireOpdsAuth, (req, res) => {
    res.type('application/opensearchdescription+xml; charset=utf-8');
    res.send(renderOpdsOpenSearch(baseUrl(req)));
  });

  app.get('/opds/search', requireOpdsAuth, async (req, res) => {
    let term = String(req.query.term || req.query.query || req.query.q || req.query.searchTerm || '').trim();
    const type = String(req.query.type || '').trim();
    const genre = String(req.query.genre || '').trim();
    const page = safePage(req.query.page);
    const limit = 100;
    const base = baseUrl(req);

    if (!type) {
      const entries = [
        { id: 'search_author', title: t('opds.searchAuthorsTitle'), href: `/opds/search?type=author&term=${encodeURIComponent(term)}`, content: t('opds.searchAuthorsDesc') },
        { id: 'search_series', title: t('opds.searchSeriesTitle'), href: `/opds/search?type=series&term=${encodeURIComponent(term)}`, content: t('opds.searchSeriesDesc') },
        { id: 'search_title', title: t('opds.searchBooksTitle'), href: `/opds/search?type=title&term=${encodeURIComponent(term)}`, content: t('opds.searchBooksDesc') },
        { id: 'search_genre', title: t('opds.searchInGenreTitle'), href: `/opds/genre?from=search&term=${encodeURIComponent(term)}`, content: t('opds.searchInGenreDesc') }
      ];
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.nav.search'), selfPath: req.originalUrl, entries }));
    }

    if (type === 'author') {
      let result = opdsSearchAuthors(term, { page, pageSize: limit });

      if (result.total === 0 && term) {
        try {
          const recodedTerm = iconv.encode(term, 'ISO-8859-1').toString();
          if (recodedTerm !== term) {
            const retry = opdsSearchAuthors(recodedTerm, { page, pageSize: limit });
            if (retry.total > 0) { result = retry; term = recodedTerm; }
          }
        } catch {}
      }

      const entries = result.items.map((item) => ({
        id: item.name,
        title: formatAuthorForOpds(item.name),
        href: `/opds/author?author=${encodeURIComponent(`=${item.name}`)}`,
        content: countLabel('book', item.bookCount)
      }));
      if (result.total > page * limit) {
        entries.push({ id: 'next_page', title: t('opds.nextPage'), href: `/opds/search?type=author&term=${encodeURIComponent(term)}&page=${page + 1}` });
      }
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.searchAuthorsTitle'), selfPath: req.originalUrl, entries }));
    }

    if (['series', 'title'].includes(type)) {
      const fieldMap = { series: 'series', title: 'title' };
      /*
       * Для OPDS-поиска по сериям пользователь вводит ИМЯ серии, не автора.
       * Включаем nameOnly=true чтобы пропустить дорогостоящий EXISTS-JOIN
       * через books×authors с LIKE по имени автора — на большой библиотеке
       * это съедало 100%+ CPU на один запрос. type='title' использует
       * другой путь (searchBooks через FTS), флаг там игнорируется.
       */
      const nameOnly = type === 'series';
      let result = searchCatalog({ query: term, field: fieldMap[type], page, pageSize: limit, sort: type === 'title' ? 'recent' : 'count', genre, nameOnly });

      if (result.total === 0 && term) {
        try {
          const recodedTerm = iconv.encode(term, 'ISO-8859-1').toString();
          if (recodedTerm !== term) {
            const retry = searchCatalog({ query: recodedTerm, field: fieldMap[type], page, pageSize: limit, sort: type === 'title' ? 'recent' : 'count', genre, nameOnly });
            if (retry.total > 0) { result = retry; term = recodedTerm; }
          }
        } catch {}
      }

      if (type === 'title') {
        const hasMoreTitle = result.total > page * limit;
        const nextHref = hasMoreTitle
          ? `/opds/search?type=title&term=${encodeURIComponent(term)}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}&page=${page + 1}`
          : '';
        await attachFlibustaAnnotationsFromShards(result.items);
        res.type('application/atom+xml; charset=utf-8');
        return res.send(renderOpdsBooksFeed(base, { username: req.user?.username, id: 'search', title: t('opds.nav.search'), selfPath: req.originalUrl, items: result.items, nextHref }));
      }

      const entries = result.items.map((item) => ({
        id: item.name,
        title: tp('book.seriesPrefix', { name: item.displayName || item.name }),
        href: `/opds/series?series=${encodeURIComponent(`=${item.name}`)}`,
        content: countLabel('book', item.bookCount)
      }));
      if (result.total > page * limit) {
        entries.push({ id: 'next_page', title: t('opds.nextPage'), href: `/opds/search?type=${type}&term=${encodeURIComponent(term)}&genre=${encodeURIComponent(genre)}&page=${page + 1}` });
      }
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.nav.search'), selfPath: req.originalUrl, entries }));
    }

    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.nav.search'), selfPath: req.originalUrl, entries: [] }));
  });

  app.get('/opds/author', requireOpdsAuth, async (req, res) => {
    const author = String(req.query.author || '');
    const genre = String(req.query.genre || '');
    const seriesQ = String(req.query.series || '');
    const base = baseUrl(req);

    if (seriesQ) {
      const authorName = author.startsWith('=') ? author.slice(1) : '';
      const items = authorName
        ? getAuthorSeriesBooksOpds(authorName, seriesQ, genre)
        : getSeriesBooksOpds(seriesQ);
      await attachFlibustaAnnotationsFromShards(items);
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsBooksFeed(base, { username: req.user?.username, id: 'search', title: seriesQ, selfPath: req.originalUrl, items }));
    }

    if (author.startsWith('=')) {
      const authorName = author.slice(1);
      const allBooks = getAuthorBooksOpds(authorName, genre);
      // Group by series like inpx-web: series entries first, then standalone books
      const seriesMap = new Map();
      const standalone = [];
      for (const book of allBooks) {
        if (book.series) {
          if (!seriesMap.has(book.series)) {
            seriesMap.set(book.series, { book, count: 0 });
          }
          seriesMap.get(book.series).count++;
        } else {
          standalone.push(book);
        }
      }
      const navEntries = [...seriesMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, { count }]) => ({
          id: `series:${name}`,
          title: tp('book.seriesPrefix', { name }),
          href: `/opds/author?author=${encodeURIComponent(author)}&series=${encodeURIComponent(name)}&genre=${encodeURIComponent(genre)}`,
          content: countLabel('book', count),
        }));
      await attachFlibustaAnnotationsFromShards(standalone);
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsBooksFeed(base, { username: req.user?.username,
        id: 'search',
        title: authorName,
        selfPath: req.originalUrl,
        navEntries,
        items: standalone,
      }));
    }

    const entries = [];
    if (!author && !genre) {
      entries.push({ id: 'select_genre', title: t('opds.selectGenre'), href: `/opds/genre?from=author` });
    }

    const items = opdsQuery('authors', author, 0, genre);
    for (const item of items) {
      if (item.isNav) {
        entries.push({ id: item.id, title: item.title, href: `/opds/author?author=${encodeURIComponent(item.prefix)}&genre=${encodeURIComponent(genre)}`, content: countLabel('author', item.count) });
      } else {
        entries.push({ id: item.id, title: formatAuthorForOpds(item.title), href: `/opds/author?author=${encodeURIComponent(`=${item.name}`)}&genre=${encodeURIComponent(genre)}`, content: countLabel('book', item.bookCount) });
      }
    }

    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.nav.authors'), selfPath: req.originalUrl, entries }));
  });

  app.get('/opds/series', requireOpdsAuth, async (req, res) => {
    const series = String(req.query.series || '');
    const genre = String(req.query.genre || '');
    const base = baseUrl(req);

    if (series.startsWith('=')) {
      const seriesName = series.slice(1);
      const items = getSeriesBooksOpds(seriesName);
      await attachFlibustaAnnotationsFromShards(items);
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsBooksFeed(base, { username: req.user?.username, id: 'search', title: seriesName || t('facet.facetSeries'), selfPath: req.originalUrl, items }));
    }

    const entries = [];
    if (!series && !genre) {
      entries.push({ id: 'select_genre', title: t('opds.selectGenre'), href: `/opds/genre?from=series` });
    }

    const items = opdsQuery('series', series, 0, genre);
    for (const item of items) {
      if (item.isNav) {
        entries.push({ id: item.id, title: item.title, href: `/opds/series?series=${encodeURIComponent(item.prefix)}&genre=${encodeURIComponent(genre)}`, content: countLabel('series', item.count) });
      } else {
        entries.push({ id: item.id, title: tp('book.seriesPrefix', { name: item.title }), href: `/opds/series?series=${encodeURIComponent(`=${item.name}`)}&genre=${encodeURIComponent(genre)}`, content: countLabel('book', item.bookCount) });
      }
    }

    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.nav.series'), selfPath: req.originalUrl, entries }));
  });

  app.get('/opds/title', requireOpdsAuth, (req, res) => {
    const titleQ = String(req.query.title || '');
    const genre = String(req.query.genre || '');
    const base = baseUrl(req);

    const entries = [];
    if (!titleQ && !genre) {
      entries.push({ id: 'select_genre', title: t('opds.selectGenre'), href: `/opds/genre?from=title` });
    }

    const items = opdsQuery('title', titleQ, 0, genre);
    for (const item of items) {
      if (item.isNav) {
        entries.push({ id: item.id, title: item.title, href: `/opds/title?title=${encodeURIComponent(item.prefix)}&genre=${encodeURIComponent(genre)}`, content: countLabel('title', item.count) });
      } else if (item.isBook) {
        entries.push({ id: item.id, title: item.title, href: `/opds/book?uid=${encodeURIComponent(item.bookId)}`, content: formatAuthorForOpds(item.authors), acquisition: true });
      }
    }

    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.nav.books'), selfPath: req.originalUrl, entries }));
  });

  app.get('/opds/genre', requireOpdsAuth, (req, res) => {
    const from = String(req.query.from || 'author');
    const term = String(req.query.term || '');
    const section = String(req.query.section || '');
    const base = baseUrl(req);

    let searchQuery = '';
    if (from === 'search') {
      searchQuery = `&type=title&term=${encodeURIComponent(term)}`;
    }

    const entries = [];
    const allGenres = listGenres({ page: 1, pageSize: 9999, query: '', sort: 'name' }).items;
    const genreBookCount = new Map(allGenres.map(g => [g.name, g.bookCount]));
    const groups = getGenreGroups();

    if (section) {
      const codes = groups[section] || [];
      if (codes.length) {
        const allCodes = codes.join(',');
        entries.push({
          id: 'whole_section',
          title: '[Весь раздел]',
          href: from === 'search'
            ? `/opds/search?type=title&term=${encodeURIComponent(term)}&genre=${encodeURIComponent(allCodes)}`
            : `/opds/${encodeURIComponent(from)}?genre=${encodeURIComponent(allCodes)}`,
        });
      }
      for (const code of codes.slice().sort((a, b) => formatGenreLabel(a).localeCompare(formatGenreLabel(b), 'ru'))) {
        const count = genreBookCount.get(code) || 0;
        if (count > 0) {
          entries.push({
            id: code,
            title: formatGenreLabel(code),
            href: from === 'search'
              ? `/opds/search?type=title&term=${encodeURIComponent(term)}&genre=${encodeURIComponent(code)}`
              : `/opds/${encodeURIComponent(from)}?genre=${encodeURIComponent(code)}`,
            content: countLabel('book', count)
          });
        }
      }
    } else {
      for (const [groupName, codes] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
        const total = codes.reduce((sum, code) => sum + (genreBookCount.get(code) || 0), 0);
        if (total > 0) {
          entries.push({
            id: groupName,
            title: groupName,
            href: `/opds/genre?section=${encodeURIComponent(groupName)}&from=${encodeURIComponent(from)}${searchQuery}`,
            content: countLabel('book', total)
          });
        }
      }
    }

    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSectionFeed(base, { id: 'search', title: t('opds.nav.genres'), selfPath: req.originalUrl, entries }));
  });

  app.get('/opds/book', requireOpdsAuth, async (req, res) => {
    const book = getBookById(String(req.query.uid || ''));
    if (!book) {
      return res.status(404).type('text/plain').send(t('book.notFound'));
    }
    try {
      const details = await getOrExtractBookDetails(book, { skipCoverAugment: true });
      book.annotation = details?.annotation || '';
    } catch (err) {
      console.warn('[OPDS] book detail annotation extraction failed for uid=%s: %s', book.id, err?.message || err);
    }
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsBookDetail(baseUrl(req), book, { username: req.user?.username }));
  });
}
