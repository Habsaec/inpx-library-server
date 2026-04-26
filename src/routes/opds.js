/**
 * OPDS (Open Publication Distribution System) маршруты.
 */
import iconv from 'iconv-lite';
import { t, tp, countLabel } from '../i18n.js';
import { requireOpdsAuth } from '../middleware/auth.js';
import { formatGenreLabel } from '../genre-map.js';
import { safePage } from '../utils/safe-int.js';
import { getOrExtractBookDetails } from '../fb2.js';
import {
  listGenres, getBookById,
  opdsQuery,
  getAuthorBooksOpds,
  getAuthorSeriesBooksOpds,
  getSeriesBooksOpds,
  opdsSearchAuthors,
  searchCatalog,
} from '../inpx.js';
import {
  renderOpdsRoot,
  renderOpdsOpenSearch,
  renderOpdsSearchHelp,
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

  app.get('/opds', requireOpdsAuth, (req, res) => {
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsRoot(baseUrl(req)));
  });

  app.get('/opds/root', requireOpdsAuth, (req, res) => {
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsRoot(baseUrl(req)));
  });

  app.get('/opds/opensearch', requireOpdsAuth, (req, res) => {
    res.type('application/opensearchdescription+xml; charset=utf-8');
    res.send(renderOpdsOpenSearch(baseUrl(req)));
  });

  app.get('/opds/search-help', requireOpdsAuth, (req, res) => {
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsSearchHelp(baseUrl(req)));
  });

  app.get('/opds/search', requireOpdsAuth, (req, res) => {
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
        { id: 'search_genre', title: t('opds.searchInGenreTitle'), href: `/opds/genre?from=search&term=${encodeURIComponent(term)}`, content: t('opds.searchInGenreDesc') },
        { id: 'search_help', title: t('opds.nav.searchHelp'), href: '/opds/search-help', acquisition: true, content: t('opds.searchSyntaxDesc') }
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
      let result = searchCatalog({ query: term, field: fieldMap[type], page, pageSize: limit, sort: type === 'title' ? 'recent' : 'count', genre });

      if (result.total === 0 && term) {
        try {
          const recodedTerm = iconv.encode(term, 'ISO-8859-1').toString();
          if (recodedTerm !== term) {
            const retry = searchCatalog({ query: recodedTerm, field: fieldMap[type], page, pageSize: limit, sort: type === 'title' ? 'recent' : 'count', genre });
            if (retry.total > 0) { result = retry; term = recodedTerm; }
          }
        } catch {}
      }

      if (type === 'title') {
        res.type('application/atom+xml; charset=utf-8');
        return res.send(renderOpdsBooksFeed(base, { id: 'search', title: t('opds.nav.search'), selfPath: req.originalUrl, items: result.items }));
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

  app.get('/opds/author', requireOpdsAuth, (req, res) => {
    const author = String(req.query.author || '');
    const genre = String(req.query.genre || '');
    const seriesQ = String(req.query.series || '');
    const base = baseUrl(req);

    if (seriesQ) {
      // When the user drilled in via an author entry (author=...&series=...),
      // match books on the same raw `b.series` text we used to group on, scoped to that author.
      // This avoids "каталог пуст" caused by mismatches between books.series and series_catalog.name
      // (whitespace, ё/е, casing, multiple ambiguous matches).
      const authorName = author.startsWith('=') ? author.slice(1) : '';
      const books = authorName
        ? getAuthorSeriesBooksOpds(authorName, seriesQ, genre)
        : getSeriesBooksOpds(seriesQ);
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsBooksFeed(base, { id: 'search', title: seriesQ, selfPath: req.originalUrl, items: books }));
    }

    if (author.startsWith('=')) {
      const authorName = author.slice(1);
      const books = getAuthorBooksOpds(authorName, genre);

      const seriesMap = new Map();
      const entries = [];
      for (const book of books) {
        if (book.series) {
          if (!seriesMap.has(book.series)) {
            seriesMap.set(book.series, 0);
          }
          seriesMap.set(book.series, seriesMap.get(book.series) + 1);
        } else {
          entries.push({
            id: book.id,
            title: `${book.title || t('opds.noTitle')} (${book.ext || 'fb2'})`,
            href: `/opds/book?uid=${encodeURIComponent(book.id)}`,
            content: formatAuthorForOpds(book.authors),
            acquisition: true
          });
        }
      }

      const seriesEntries = [];
      for (const [name, count] of seriesMap) {
        seriesEntries.push({
          id: `series:${name}`,
          title: tp('book.seriesPrefix', { name }),
          href: `/opds/author?author=${encodeURIComponent(author)}&series=${encodeURIComponent(name)}&genre=${encodeURIComponent(genre)}`,
          content: countLabel('book', count)
        });
      }
      seriesEntries.sort((a, b) => a.title.localeCompare(b.title));
      const allEntries = [...seriesEntries, ...entries];

      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsSectionFeed(base, { id: 'search', title: authorName, selfPath: req.originalUrl, entries: allEntries }));
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

  app.get('/opds/series', requireOpdsAuth, (req, res) => {
    const series = String(req.query.series || '');
    const genre = String(req.query.genre || '');
    const base = baseUrl(req);

    if (series.startsWith('=')) {
      const seriesName = series.slice(1);
      const books = getSeriesBooksOpds(seriesName);
      res.type('application/atom+xml; charset=utf-8');
      return res.send(renderOpdsBooksFeed(base, { id: 'search', title: seriesName || t('facet.facetSeries'), selfPath: req.originalUrl, items: books }));
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
    const from = String(req.query.from || 'search');
    const term = String(req.query.term || '');
    const section = String(req.query.section || '');
    const base = baseUrl(req);

    let searchQuery = '';
    if (from === 'search') {
      searchQuery = `&type=title&term=${encodeURIComponent(term)}`;
    }

    const entries = [];
    const allGenres = listGenres({ page: 1, pageSize: 500, query: '', sort: 'name' }).items;

    if (section) {
      const sectionGenres = allGenres.filter(g => {
        const label = formatGenreLabel(g.name);
        return label !== g.name;
      });
      const matchingGenres = allGenres.filter(g => {
        return formatGenreLabel(g.name).toLowerCase().includes(section.toLowerCase()) || g.name.startsWith(section);
      });
      const genresToShow = matchingGenres.length ? matchingGenres : sectionGenres;
      for (const g of genresToShow) {
        entries.push({
          id: g.name,
          title: formatGenreLabel(g.name),
          href: from === 'search'
            ? `/opds/search?type=title&term=${encodeURIComponent(term)}&genre=${encodeURIComponent(g.name)}`
            : `/opds/${encodeURIComponent(from)}?genre=${encodeURIComponent(g.name)}`,
          content: countLabel('book', g.bookCount)
        });
      }
    } else {
      for (const g of allGenres) {
        entries.push({
          id: g.name,
          title: formatGenreLabel(g.name),
          href: from === 'search'
            ? `/opds/search?type=title&term=${encodeURIComponent(term)}&genre=${encodeURIComponent(g.name)}`
            : `/opds/${encodeURIComponent(from)}?genre=${encodeURIComponent(g.name)}`,
          content: countLabel('book', g.bookCount)
        });
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
    } catch { /* ignore */ }
    res.type('application/atom+xml; charset=utf-8');
    res.send(renderOpdsBookDetail(baseUrl(req), book));
  });
}
