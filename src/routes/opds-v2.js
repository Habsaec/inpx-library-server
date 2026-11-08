/**
 * OPDS 2.0 (JSON) routes — parallel to OPDS 1.2 XML at /opds/.
 * All endpoints under /opds/v2/.
 */
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
  warmOpdsTitleQuery,
  getLibraryView,
  getFollowingNewBooks,
} from '../inpx.js';
import { getUserShelves, getShelfById, getShelfBooks } from '../db.js';
import { listSmartShelves, getSmartShelf, getSmartShelfBooks } from '../smart-shelves.js';
import { getRecommendedLibraryView } from '../services/recommendations.js';
import { effectiveContentLangs } from '../user-content-langs.js';
import {
  renderOpds2Root,
  renderOpds2NavigationFeed,
  renderOpds2PublicationsFeed,
  renderOpds2BookDetail,
} from '../templates/opds-v2.js';

const OPDS_JSON = 'application/opds+json; charset=utf-8';
const PAGE_SIZE = 100;

function formatAuthorForOpds(author) {
  if (!author) return '';
  const parts = author.split(',');
  return parts.slice(0, 3).join(', ') + (parts.length > 3 ? t('opds.authorEtAl') : '');
}


/**
 * @param {import('express').Application} app
 * @param {{ baseUrl: (req: import('express').Request) => string }} deps
 */
export function registerOpdsV2Routes(app, deps) {
  const { baseUrl } = deps;

  function buildUserV2NavEntries(username) {
    if (!username) return [];
    return [
      { href: '/opds/v2/user', title: t('opds.user.myLibrary'), type: 'application/opds+json' }
    ];
  }

  // Root navigation
  app.get('/opds/v2', requireOpdsAuth, (req, res) => {
    res.type(OPDS_JSON);
    res.send(renderOpds2Root(baseUrl(req), { userEntries: buildUserV2NavEntries(req.user?.username) }));
  });

  // User library root
  app.get('/opds/v2/user', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) {
      return res.status(401).type(OPDS_JSON).send(JSON.stringify({ metadata: { title: t('opds.user.myLibrary') }, links: [] }));
    }
    const entries = [
      { href: '/opds/v2/user/bookmarks', title: t('opds.user.bookmarks'), type: 'application/opds+json', description: t('opds.user.bookmarksDesc') },
      { href: '/opds/v2/user/shelves', title: t('opds.user.shelves'), type: 'application/opds+json', description: t('opds.user.shelvesDesc') },
      { href: '/opds/v2/user/favorite-authors', title: t('opds.user.favoriteAuthors'), type: 'application/opds+json', description: t('opds.user.favoriteAuthorsDesc') },
      { href: '/opds/v2/user/favorite-series', title: t('opds.user.favoriteSeries'), type: 'application/opds+json', description: t('opds.user.favoriteSeriesDesc') },
      { href: '/opds/v2/user/smart-shelves', title: t('opds.user.smartShelves'), type: 'application/opds+json', description: t('opds.user.smartShelvesDesc') },
      { href: '/opds/v2/user/want', title: t('opds.user.want'), type: 'application/opds+json', description: t('opds.user.wantDesc') },
      { href: '/opds/v2/user/following', title: t('opds.user.following'), type: 'application/opds+json', description: t('opds.user.followingDesc') },
      { href: '/opds/v2/user/recommended', title: t('opds.user.recommended'), type: 'application/opds+json', description: t('opds.user.recommendedDesc') },
    ];
    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(baseUrl(req), { title: t('opds.user.myLibrary'), selfPath: '/opds/v2/user', entries }));
  });

  // User bookmarks
  app.get('/opds/v2/user/bookmarks', requireOpdsAuth, async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
    const items = getBookmarks(username, 'date');
    await attachFlibustaAnnotationsFromShards(items);
    res.type(OPDS_JSON);
    res.send(renderOpds2PublicationsFeed(baseUrl(req), {
      title: t('opds.user.bookmarks'),
      selfPath: '/opds/v2/user/bookmarks',
      items,
      total: items.length
    }));
  });

  // User shelves list
  app.get('/opds/v2/user/shelves', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
    const shelves = getUserShelves(username);
    const entries = shelves.map((s) => ({
      href: `/opds/v2/user/shelves/${s.id}`,
      title: s.name,
      type: 'application/opds+json',
      properties: { numberOfItems: s.bookCount }
    }));
    for (const shelf of listSmartShelves(username)) {
      entries.push({
        href: `/opds/v2/user/smart-shelves/${shelf.id}`,
        title: shelf.name,
        type: 'application/opds+json'
      });
    }
    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(baseUrl(req), { title: t('opds.user.shelves'), selfPath: '/opds/v2/user/shelves', entries }));
  });

  // Single shelf books
  app.get('/opds/v2/user/shelves/:id', requireOpdsAuth, async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
    const shelfId = Number(req.params.id);
    if (!Number.isFinite(shelfId) || shelfId < 1) return res.status(404).type(OPDS_JSON).send(JSON.stringify({ error: t('shelf.notFound') }));
    const shelf = getShelfById(shelfId, username);
    if (!shelf) return res.status(404).type(OPDS_JSON).send(JSON.stringify({ error: t('shelf.notFound') }));
    const items = getShelfBooks(shelf.id, username);
    await attachFlibustaAnnotationsFromShards(items);
    res.type(OPDS_JSON);
    res.send(renderOpds2PublicationsFeed(baseUrl(req), {
      title: shelf.name,
      selfPath: req.originalUrl,
      items,
      total: items.length
    }));
  });

  // Smart shelves (saved catalog filters)
  app.get('/opds/v2/user/smart-shelves', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
    const entries = listSmartShelves(username).map((shelf) => ({
      href: `/opds/v2/user/smart-shelves/${shelf.id}`,
      title: shelf.name,
      type: 'application/opds+json'
    }));
    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(baseUrl(req), { title: t('opds.user.smartShelves'), selfPath: '/opds/v2/user/smart-shelves', entries }));
  });

  app.get('/opds/v2/user/smart-shelves/:id', requireOpdsAuth, async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
    const shelf = getSmartShelf(req.params.id, username);
    if (!shelf) return res.status(404).type(OPDS_JSON).send(JSON.stringify({ error: t('shelf.notFound') }));
    const page = safePage(req.query.page);
    const result = getSmartShelfBooks(shelf, { page, pageSize: PAGE_SIZE });
    await attachFlibustaAnnotationsFromShards(result.items);
    const nextHref = result.total > page * PAGE_SIZE ? `/opds/v2/user/smart-shelves/${shelf.id}?page=${page + 1}` : null;
    res.type(OPDS_JSON);
    res.send(renderOpds2PublicationsFeed(baseUrl(req), {
      title: shelf.name, selfPath: req.originalUrl, items: result.items, total: result.total, nextHref
    }));
  });

  // «Хочу прочитать», «Новое у любимых», «Рекомендации»: the same lists as the site
  const userListFeed = (path, titleKey, load) => {
    app.get(path, requireOpdsAuth, async (req, res) => {
      const username = req.user?.username;
      if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
      const page = safePage(req.query.page);
      const result = load(username, page, PAGE_SIZE);
      await attachFlibustaAnnotationsFromShards(result.items);
      const nextHref = result.total > page * PAGE_SIZE ? `${path}?page=${page + 1}` : null;
      res.type(OPDS_JSON);
      res.send(renderOpds2PublicationsFeed(baseUrl(req), {
        title: t(titleKey), selfPath: req.originalUrl, items: result.items, total: result.total, nextHref
      }));
    });
  };
  userListFeed('/opds/v2/user/want', 'opds.user.want',
    (username, page, limit) => getLibraryView('want', { username, page, pageSize: limit, sort: 'recent' }));
  userListFeed('/opds/v2/user/following', 'opds.user.following',
    (username, page, limit) => getFollowingNewBooks(username, { page, pageSize: limit, langs: effectiveContentLangs(username) }));
  userListFeed('/opds/v2/user/recommended', 'opds.user.recommended',
    (username, page, limit) => getRecommendedLibraryView({ username, page, pageSize: limit, langs: effectiveContentLangs(username) }));

  // Favourite authors
  app.get('/opds/v2/user/favorite-authors', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
    const authors = getFavoriteAuthorsLight(username, 500);
    const entries = authors.map((a) => ({
      href: `/opds/v2/authors?prefix=${encodeURIComponent('=' + a.name)}`,
      title: formatAuthorForOpds(a.displayName || a.name),
      type: 'application/opds+json'
    }));
    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(baseUrl(req), { title: t('opds.user.favoriteAuthors'), selfPath: '/opds/v2/user/favorite-authors', entries }));
  });

  // Favourite series
  app.get('/opds/v2/user/favorite-series', requireOpdsAuth, (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).type(OPDS_JSON).send(JSON.stringify({ error: t('api.auth.unauthorized') }));
    const series = getFavoriteSeriesLight(username, 500);
    const entries = series.map((s) => ({
      href: `/opds/v2/series?prefix=${encodeURIComponent('=' + s.name)}`,
      title: s.displayName || s.name,
      type: 'application/opds+json'
    }));
    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(baseUrl(req), { title: t('opds.user.favoriteSeries'), selfPath: '/opds/v2/user/favorite-series', entries }));
  });

  // Authors navigation (prefix-based)
  app.get('/opds/v2/authors', requireOpdsAuth, async (req, res) => {
    const prefix = String(req.query.prefix || '');
    const genre = String(req.query.genre || '');
    const series = String(req.query.series || '');
    const base = baseUrl(req);

    if (series && prefix.startsWith('=')) {
      const authorName = prefix.slice(1);
      const items = getAuthorSeriesBooksOpds(authorName, series, genre);
      await attachFlibustaAnnotationsFromShards(items);
      res.type(OPDS_JSON);
      return res.send(renderOpds2PublicationsFeed(base, {
        title: series,
        selfPath: req.originalUrl,
        items,
        total: items.length,
      }));
    }

    if (prefix.startsWith('=')) {
      const authorName = prefix.slice(1);
      const allBooks = getAuthorBooksOpds(authorName, genre);
      // Group by series like inpx-web
      const seriesMap = new Map();
      const standalone = [];
      for (const book of allBooks) {
        if (book.series) {
          if (!seriesMap.has(book.series)) {
            seriesMap.set(book.series, 0);
          }
          seriesMap.set(book.series, seriesMap.get(book.series) + 1);
        } else {
          standalone.push(book);
        }
      }
      const navEntries = [...seriesMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, count]) => ({
          title: tp('book.seriesPrefix', { name }),
          href: `/opds/v2/authors?prefix=${encodeURIComponent(prefix)}&series=${encodeURIComponent(name)}&genre=${encodeURIComponent(genre)}`,
          count,
        }));
      await attachFlibustaAnnotationsFromShards(standalone);
      res.type(OPDS_JSON);
      return res.send(renderOpds2PublicationsFeed(base, {
        title: authorName,
        selfPath: req.originalUrl,
        items: standalone,
        total: standalone.length,
        navEntries
      }));
    }

    const items = opdsQuery('authors', prefix, 0, genre);
    const entries = items.map(item => {
      if (item.isNav) {
        return { href: `/opds/v2/authors?prefix=${encodeURIComponent(item.prefix)}&genre=${encodeURIComponent(genre)}`, title: item.title, count: item.count };
      }
      return { href: `/opds/v2/authors?prefix=${encodeURIComponent('=' + item.name)}&genre=${encodeURIComponent(genre)}`, title: formatAuthorForOpds(item.title), count: item.bookCount };
    });

    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(base, { title: t('opds.nav.authors'), selfPath: req.originalUrl, entries }));
  });

  // Series navigation
  app.get('/opds/v2/series', requireOpdsAuth, async (req, res) => {
    const prefix = String(req.query.prefix || '');
    const genre = String(req.query.genre || '');
    const base = baseUrl(req);

    if (prefix.startsWith('=')) {
      const seriesName = prefix.slice(1);
      const items = getSeriesBooksOpds(seriesName);
      await attachFlibustaAnnotationsFromShards(items);
      res.type(OPDS_JSON);
      return res.send(renderOpds2PublicationsFeed(base, {
        title: seriesName || t('facet.facetSeries'),
        selfPath: req.originalUrl,
        items,
        total: items.length,
      }));
    }

    const items = opdsQuery('series', prefix, 0, genre);
    const entries = items.map(item => {
      if (item.isNav) {
        return { href: `/opds/v2/series?prefix=${encodeURIComponent(item.prefix)}&genre=${encodeURIComponent(genre)}`, title: item.title, count: item.count };
      }
      return { href: `/opds/v2/series?prefix=${encodeURIComponent('=' + item.name)}&genre=${encodeURIComponent(genre)}`, title: item.title, count: item.bookCount };
    });

    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(base, { title: t('opds.nav.series'), selfPath: req.originalUrl, entries }));
  });

  // Titles navigation
  app.get('/opds/v2/titles', requireOpdsAuth, async (req, res) => {
    const prefix = String(req.query.prefix || '');
    const genre = String(req.query.genre || '');
    const base = baseUrl(req);

    await warmOpdsTitleQuery(prefix, genre); // the title-prefix scan runs on the query worker
    const items = opdsQuery('title', prefix, 0, genre);

    // Check if any are book entries (not nav)
    const hasBooks = items.some(i => i.isBook);
    if (hasBooks) {
      const books = items.filter(i => i.isBook).map(i => ({
        id: i.bookId,
        title: i.title,
        authors: i.authors,
        ext: i.ext || 'fb2',
        lang: i.lang || '',
        genres: i.genres || '',
        series: i.series || '',
        seriesNo: i.seriesNo || '',
        seriesList: i.seriesList || [],
        archiveName: i.archiveName || '',
        fileName: i.fileName || '',
        sourceId: i.sourceId,
        sourceFlibusta: i.sourceFlibusta,
        annotation: i.annotation || ''
      }));
      await attachFlibustaAnnotationsFromShards(books);
      res.type(OPDS_JSON);
      return res.send(renderOpds2PublicationsFeed(base, { title: t('opds.nav.books'), selfPath: req.originalUrl, items: books }));
    }

    const entries = items.map(item => ({
      href: `/opds/v2/titles?prefix=${encodeURIComponent(item.prefix)}&genre=${encodeURIComponent(genre)}`,
      title: item.title,
      count: item.count
    }));

    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(base, { title: t('opds.nav.books'), selfPath: req.originalUrl, entries }));
  });

  // Genres — hierarchical: sections → sub-genres (like inpx-web)
  app.get('/opds/v2/genres', requireOpdsAuth, (req, res) => {
    const base = baseUrl(req);
    const section = String(req.query.section || '');
    const from = String(req.query.from || 'authors');
    const groups = getGenreGroups();
    const allGenres = listGenres({ page: 1, pageSize: 9999, query: '', sort: 'name' }).items;
    const genreBookCount = new Map(allGenres.map(g => [g.name, g.bookCount]));

    const entries = [];
    if (section) {
      const codes = groups[section] || [];
      if (codes.length) {
        entries.push({
          href: `/opds/v2/${encodeURIComponent(from)}?genre=${encodeURIComponent(codes.join(','))}`,
          title: '[Весь раздел]',
        });
      }
      for (const code of codes) {
        const count = genreBookCount.get(code) || 0;
        if (count > 0) {
          entries.push({
            href: `/opds/v2/${encodeURIComponent(from)}?genre=${encodeURIComponent(code)}`,
            title: formatGenreLabel(code),
            count,
          });
        }
      }
    } else {
      for (const [groupName, codes] of Object.entries(groups)) {
        const total = codes.reduce((sum, code) => sum + (genreBookCount.get(code) || 0), 0);
        if (total > 0) {
          entries.push({
            href: `/opds/v2/genres?section=${encodeURIComponent(groupName)}&from=${encodeURIComponent(from)}`,
            title: groupName,
            count: total,
          });
        }
      }
    }

    res.type(OPDS_JSON);
    res.send(renderOpds2NavigationFeed(base, { title: t('opds.nav.genres'), selfPath: req.originalUrl, entries }));
  });

  // Search
  app.get('/opds/v2/search', requireOpdsAuth, async (req, res) => {
    const query = String(req.query.query || req.query.term || req.query.q || '').trim();
    const genre = String(req.query.genre || '').trim();
    const page = safePage(req.query.page);
    const base = baseUrl(req);

    const result = searchCatalog({ query, field: 'title', page, pageSize: PAGE_SIZE, sort: 'recent', genre });
    const nextHref = result.total > page * PAGE_SIZE
      ? `/opds/v2/search?query=${encodeURIComponent(query)}&genre=${encodeURIComponent(genre)}&page=${page + 1}`
      : null;

    await attachFlibustaAnnotationsFromShards(result.items);
    res.type(OPDS_JSON);
    res.send(renderOpds2PublicationsFeed(base, {
      title: query ? `${t('opds.nav.search')}: ${query}` : t('opds.nav.search'),
      selfPath: req.originalUrl,
      items: result.items,
      nextHref,
      total: result.total
    }));
  });

  // Single book detail
  app.get('/opds/v2/book/:id', requireOpdsAuth, async (req, res) => {
    const book = getBookById(String(req.params.id || ''));
    if (!book) {
      return res.status(404).type(OPDS_JSON).send(renderOpds2BookDetail(baseUrl(req), null));
    }
    try {
      const details = await getOrExtractBookDetails(book, { skipCoverAugment: true });
      book.annotation = details?.annotation || '';
    } catch (err) {
      console.warn('[OPDS v2] book detail annotation extraction failed for id=%s: %s', book.id, err?.message || err);
    }
    res.type(OPDS_JSON);
    res.send(renderOpds2BookDetail(baseUrl(req), book));
  });
}
