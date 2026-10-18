/**
 * Lightweight e-ink UI at /lite/* — separate URL space with its own login.
 */
import { config } from '../config.js';
import { t, tp, getLocale, translateKnownErrorMessage } from '../i18n.js';
import { requireLiteBrowseAuth } from '../middleware/auth.js';
import { getCachedPageData, getStaleOrSchedule, invalidateUserPageCaches } from '../services/cache.js';
import { logSystemEvent } from '../services/system-events.js';
import { safePage } from '../utils/safe-int.js';
import { PAGE_CACHE_TTL_MS } from '../constants.js';
import {
  getSetting,
  getReadBookIdSet,
  getUserByUsername,
  getEreaderEmail,
  setEreaderEmail,
  setUserAccountEmail,
  isEreaderEmailAllowedForUser,
  getUserStats,
  changePassword,
  getAllReaderBookmarks,
  getUserShelves,
  getShelfById,
  getShelfBooks
} from '../db.js';
import { effectiveContentLangs, contentLangCacheKey } from '../user-content-langs.js';
import {
  getBookById,
  getAuthorBooksGroupedCoalesced,
  getBooksByFacetCoalesced,
  getLibraryView,
  isBookRead,
  listAuthors,
  listGenres,
  listGenresGrouped,
  listSeries,
  resolveAuthorName,
  resolveSeriesCatalogName,
  searchCatalog,
  getReadingHistory,
  getFavoriteAuthors,
  getFavoriteSeries,
  getBookmarks,
  getReadBooks,
  recordReadingHistory
} from '../inpx.js';
import { formatAuthorLabel, formatGenreLabel, formatLanguageLabel, getGenreGroups } from '../genre-map.js';
import { verifyPassword } from '../auth.js';
import { invalidateSessionUserCache } from '../middleware/auth.js';
import { createSessionValue } from '../services/session.js';
import { isRateLimited, registerFailedLogin, clearLoginAttempts, getClientKey } from '../services/rate-limiter.js';
import { DUMMY_PASSWORD_HASH } from '../constants.js';
import {
  renderLiteHome,
  renderLiteCatalog,
  renderLiteBrowsePage,
  renderLiteBookListPage,
  renderLiteBook,
  renderLiteAuthorFacetPage,
  renderLiteLogin,
  renderLiteProfileMenu,
  renderLiteProfileActivity,
  renderLiteProfileFavorites,
  renderLiteProfileShelves,
  renderLiteShelfDetail,
  renderLiteProfileRead,
  renderLiteProfileSettings,
  LITE_BASE
} from '../templates/lite.js';
import { renderReader } from '../templates/library.js';
import { getDetails } from './library.js';

function requireLiteUserAuth(req, res, next) {
  if (!req.user?.username) return res.redirect(`${LITE_BASE}/login`);
  next();
}

export function registerLiteRoutes(app, { getCachedStats }) {
  const csrf = (req) => req.csrfToken || '';
  app.get('/lite/login', (req, res) => {
    if (req.user?.username) {
      return res.redirect(`${LITE_BASE}/`);
    }
    res.send(renderLiteLogin({ csrfToken: req.csrfToken || '' }));
  });

  app.post('/lite/login', (req, res) => {
    if (isRateLimited(req)) {
      logSystemEvent('warn', 'auth', 'lite login rate limit triggered', { client: getClientKey(req) });
      return res.status(429).send(renderLiteLogin({ error: t('auth.rateLimitLogin'), csrfToken: req.csrfToken || '' }));
    }
    const { username, password } = req.body;
    const user = getUserByUsername(String(username || '').trim());
    const passwordValid = verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!user || !passwordValid) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'lite login failed', { client: getClientKey(req), username: String(username || '') });
      return res.status(401).send(renderLiteLogin({ error: t('auth.invalidCredentials'), csrfToken: req.csrfToken || '' }));
    }
    if (user.blocked) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'lite login blocked user', { client: getClientKey(req), username: user.username });
      return res.status(403).send(renderLiteLogin({ error: t('auth.accountBlocked'), csrfToken: req.csrfToken || '' }));
    }
    clearLoginAttempts(req);
    invalidateSessionUserCache(user.username);
    const freshUser = getUserByUsername(user.username);
    logSystemEvent('info', 'auth', 'lite login successful', { client: getClientKey(req), username: user.username });
    res.cookie('session', createSessionValue(freshUser.username, freshUser.sessionGen || 0), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionSecureCookie,
      maxAge: config.sessionMaxAgeMs
    });
    res.redirect(`${LITE_BASE}/`);
  });

  app.post('/lite/logout', (req, res) => {
    res.clearCookie('session', { path: '/' });
    res.redirect(`${LITE_BASE}/login`);
  });

  app.get(['/lite', '/lite/'], requireLiteBrowseAuth, (req, res) => {
    const stats = getCachedStats();
    const user = req.user || null;
    const homeSubtitle = getSetting('home_subtitle') || '';
    const canCache = !user;
    const html = canCache
      ? getCachedPageData(`page:lite:home:anon:${getLocale()}:${homeSubtitle}`, () => renderLiteHome({ stats, user: null, homeSubtitle }), 1000 * 60 * 2)
      : renderLiteHome({ stats, user, csrfToken: csrf(req), homeSubtitle });
    res.send(html);
  });

  app.get('/lite/catalog', requireLiteBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const letter = String(req.query.letter || '').trim().slice(0, 2);
    const field = ['books', 'authors', 'series'].includes(String(req.query.field || '')) ? String(req.query.field) : 'books';
    const isBookField = field === 'books';
    const bookSorts = ['recent', 'title', 'author', 'series', 'rating'];
    const entitySorts = ['name', 'count'];
    const allowedSorts = isBookField ? bookSorts : entitySorts;
    const sort = allowedSorts.includes(String(req.query.sort || '')) ? String(req.query.sort) : (isBookField ? 'title' : 'name');
    const page = safePage(req.query.page);
    const pageSize = 24;
    const langs = effectiveContentLangs(req.user?.username);
    const cacheKey = `lite:catalog:${contentLangCacheKey(langs)}:${field}:${sort}:${letter}:${query}:p${page}`;
    const result = getCachedPageData(cacheKey, () => searchCatalog({ query, field, page, pageSize, sort, order: '', genre: '', letter, lang: '', format: '', year: 0, langs }));
    const user = req.user || null;
    const readBookIds = user ? getReadBookIdSet(user.username) : null;
    res.send(renderLiteCatalog({ ...result, page, pageSize, query, field, sort, letter, user, readBookIds, csrfToken: csrf(req) }));
  });

  app.get('/lite/library/recent', requireLiteBrowseAuth, (req, res) => {
    const page = safePage(req.query.page);
    const pageSize = 24;
    const requestedSort = String(req.query.sort || '');
    const sort = ['recent', 'title', 'author', 'series', 'rating'].includes(requestedSort) ? requestedSort : 'recent';
    const user = req.user || null;
    const result = getStaleOrSchedule(`library:recent:v4:sort:${sort}:page:${page}:size:${pageSize}`, () => getLibraryView('recent', { page, pageSize, sort, order: '' }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    const readBookIds = user ? getReadBookIdSet(user.username) : null;
    res.send(renderLiteBookListPage({
      title: t('library.title.recent'),
      items: result.items,
      total: result.total,
      page,
      pageSize,
      sort,
      user,
      paginationBase: `${LITE_BASE}/library/recent?sort=${encodeURIComponent(sort)}`,
      readBookIds,
      hint: t('library.sub.recent'),
      csrfToken: csrf(req)
    }));
  });

  app.get('/lite/authors', requireLiteBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const sort = String(req.query.sort || 'name');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const startsWith = query.length <= 2;
    const stats = getCachedStats();
    const langs = effectiveContentLangs(req.user?.username);
    const cacheKey = `lite:authors:${contentLangCacheKey(langs)}:${page}:${sort}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listAuthors({ query, page, pageSize, sort, order: '', startsWith, letter: '', langs }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderLiteBrowsePage({
      title: t('nav.authors'),
      ...result, page, pageSize, user: req.user || null, stats, query,
      path: `${LITE_BASE}/authors`, sort, csrfToken: csrf(req)
    }));
  });

  app.get('/lite/series', requireLiteBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const sort = String(req.query.sort || 'name');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();
    const langs = effectiveContentLangs(req.user?.username);
    const cacheKey = `lite:series:${contentLangCacheKey(langs)}:${page}:${sort}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listSeries({ query, page, pageSize, sort, order: '', letter: '', langs }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderLiteBrowsePage({
      title: t('nav.series'),
      ...result, page, pageSize, user: req.user || null, stats, query,
      path: `${LITE_BASE}/series`, sort, csrfToken: csrf(req)
    }));
  });

  app.get('/lite/genres', requireLiteBrowseAuth, (req, res) => {
    const query = String(req.query.q || '');
    const sort = String(req.query.sort || 'name');
    const page = safePage(req.query.page);
    const pageSize = 50;
    const stats = getCachedStats();
    const genreLangs = effectiveContentLangs(req.user?.username);
    if (!query && page === 1 && (sort === 'count' || sort === 'name')) {
      const allGenres = genreLangs.length
        ? getStaleOrSchedule(
          `lite:genres:${contentLangCacheKey(genreLangs)}:${sort}`,
          () => listGenres({ query: '', page: 1, pageSize: 10000, sort, langs: genreLangs }).items,
          PAGE_CACHE_TTL_MS,
          []
        )
        : getStaleOrSchedule(`browse:genres:grouped:${sort}`, () => listGenresGrouped({ sort }), PAGE_CACHE_TTL_MS, []);
      const groups = getGenreGroups();
      const grouped = [];
      const entries = sort === 'name'
        ? Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], getLocale()))
        : Object.entries(groups);
      for (const [groupName, codes] of entries) {
        const codesSet = new Set(codes);
        const items = allGenres.filter(g => codesSet.has(g.name));
        if (items.length) grouped.push({ groupName, items });
      }
      const allGrouped = new Set(Object.values(groups).flat());
      const uncategorized = allGenres.filter(g => !allGrouped.has(g.name));
      if (uncategorized.length) grouped.push({ groupName: t('genre.other'), items: uncategorized });
      res.send(renderLiteBrowsePage({
        title: t('nav.genres'),
        items: allGenres, total: allGenres.length, page, pageSize: allGenres.length,
        user: req.user || null, stats, query,
        path: `${LITE_BASE}/genres`, sort, genreGroups: grouped, csrfToken: csrf(req)
      }));
      return;
    }
    const langs = effectiveContentLangs(req.user?.username);
    const cacheKey = `lite:genres:${contentLangCacheKey(langs)}:${page}:${sort}:${query}`;
    const result = getStaleOrSchedule(cacheKey, () => listGenres({ query, page, pageSize, sort, order: '', letter: '', langs }), PAGE_CACHE_TTL_MS, { total: 0, items: [] });
    res.send(renderLiteBrowsePage({
      title: t('nav.genres'),
      ...result, page, pageSize, user: req.user || null, stats, query,
      path: `${LITE_BASE}/genres`, sort, csrfToken: csrf(req)
    }));
  });

  app.get('/lite/facet/:facet(authors|series|genres)/:value', requireLiteBrowseAuth, async (req, res, next) => {
    try {
      const facet = String(req.params.facet || '');
      const sort = String(req.query.sort || (facet === 'series' ? 'series' : 'title'));
      const page = safePage(req.query.page);
      const pageSize = 24;
      const stats = getCachedStats();
      let value = String(req.params.value || '');
      if (facet === 'series') {
        const resolved = resolveSeriesCatalogName(value);
        if (resolved !== value) {
          const qs = new URLSearchParams(req.query).toString();
          return res.redirect(302, `${LITE_BASE}/facet/series/${encodeURIComponent(resolved)}${qs ? `?${qs}` : ''}`);
        }
        value = resolved;
      }
      if (facet === 'authors') {
        const resolvedAuthor = resolveAuthorName(value);
        if (resolvedAuthor && resolvedAuthor !== value) {
          const qs = new URLSearchParams(req.query).toString();
          return res.redirect(302, `${LITE_BASE}/facet/authors/${encodeURIComponent(resolvedAuthor)}${qs ? `?${qs}` : ''}`);
        }
        if (resolvedAuthor) value = resolvedAuthor;
        const p = safePage(req.query.page, 1);
        const authorPageSize = 48;
        const grouped = await getAuthorBooksGroupedCoalesced(value, sort, '', {
          page: p, pageSize: authorPageSize, langs: effectiveContentLangs(req.user?.username)
        });
        const displayValue = formatAuthorLabel(value);
        res.send(renderLiteAuthorFacetPage({
          title: displayValue,
          displayName: displayValue,
          series: grouped.series,
          standaloneBooks: grouped.standaloneBooks,
          facetValue: value,
          total: grouped.total,
          user: req.user || null,
          stats,
          csrfToken: csrf(req)
        }));
        return;
      }
      const displayValue = facet === 'genres' ? formatGenreLabel(value) : value;
      let authorFilter = facet === 'series' ? String(req.query.author || '').trim() : '';
      if (authorFilter) {
        const canonical = resolveAuthorName(authorFilter);
        authorFilter = canonical ?? authorFilter.toLowerCase();
      }
      const result = await getBooksByFacetCoalesced({
        facet, value, page, pageSize, sort, order: '', author: authorFilter,
        langs: effectiveContentLangs(req.user?.username)
      });
      const facetPath = `${LITE_BASE}/facet/${facet}/${encodeURIComponent(value)}`;
      const user = req.user || null;
      const readBookIds = user ? getReadBookIdSet(user.username) : null;
      res.send(renderLiteBookListPage({
        title: tp('facet.titleWithValue', { label: facet === 'genres' ? t('facet.facetGenres') : t('facet.facetSeries'), value: displayValue }),
        items: result.items,
        total: result.total,
        page,
        pageSize,
        sort,
        user,
        paginationBase: `${facetPath}?sort=${encodeURIComponent(sort)}${authorFilter ? `&author=${encodeURIComponent(authorFilter)}` : ''}`,
        readBookIds,
        csrfToken: csrf(req),
        scopeDownload: facet === 'series' ? { facet: 'series', value } : null
      }));
    } catch (error) {
      next(error);
    }
  });

  // Главная кабинета — меню-список разделов.
  app.get('/lite/profile', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    res.send(renderLiteProfileMenu({
      user,
      userStats: getUserStats(user.username),
      csrfToken: csrf(req)
    }));
  });

  // Активность: история чтения + закладки читалки.
  app.get('/lite/profile/activity', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    res.send(renderLiteProfileActivity({
      user,
      recentBooks: getReadingHistory(user.username, 50),
      readerBookmarks: getAllReaderBookmarks(user.username, 50),
      csrfToken: csrf(req)
    }));
  });

  // Избранное: книги (закладки) / серии / авторы.
  app.get('/lite/profile/favorites', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    const view = ['books', 'series', 'authors'].includes(String(req.query.view || '')) ? String(req.query.view) : 'books';
    const props = { user, view, csrfToken: csrf(req) };
    if (view === 'series') {
      props.series = getFavoriteSeries(user.username, 200);
    } else if (view === 'authors') {
      props.authors = getFavoriteAuthors(user.username, 200);
    } else {
      props.books = getBookmarks(user.username, 'date', 200);
      props.readBookIds = getReadBookIdSet(user.username);
    }
    res.send(renderLiteProfileFavorites(props));
  });

  // Список полок пользователя.
  app.get('/lite/profile/shelves', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    res.send(renderLiteProfileShelves({
      user,
      shelves: getUserShelves(user.username),
      csrfToken: csrf(req)
    }));
  });

  // Книги конкретной полки.
  app.get('/lite/profile/shelf/:id', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    const shelf = getShelfById(Number(req.params.id), user.username);
    if (!shelf) return res.status(404).send(t('shelf.notFound'));
    res.send(renderLiteShelfDetail({
      user,
      shelf,
      books: getShelfBooks(shelf.id, user.username),
      readBookIds: getReadBookIdSet(user.username),
      csrfToken: csrf(req)
    }));
  });

  // Прочитанные книги.
  app.get('/lite/profile/read', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    res.send(renderLiteProfileRead({
      user,
      books: getReadBooks(user.username, 'date', 200),
      csrfToken: csrf(req)
    }));
  });

  // Настройки: e-reader email, смена пароля.
  app.get('/lite/profile/settings', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    const fullUser = getUserByUsername(user.username);
    res.send(renderLiteProfileSettings({
      user,
      ereaderEmail: getEreaderEmail(user.username),
      accountEmail: fullUser?.email || '',
      ereaderEmailAllowed: fullUser ? isEreaderEmailAllowedForUser(fullUser) : true,
      flash: String(req.query.flash || ''),
      csrfToken: csrf(req)
    }));
  });

  // Сборка пропсов для страницы настроек (повторно для POST-обработчиков).
  const buildLiteSettingsProps = (req, flash) => {
    const user = req.user;
    const fullUser = getUserByUsername(user.username);
    return {
      user,
      ereaderEmail: getEreaderEmail(user.username),
      accountEmail: fullUser?.email || '',
      ereaderEmailAllowed: fullUser ? isEreaderEmailAllowedForUser(fullUser) : true,
      flash,
      csrfToken: csrf(req)
    };
  };

  app.post('/lite/profile/email', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    const rawEmail = String(req.body.ereaderEmail || '').trim();
    if (rawEmail && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(rawEmail)) {
      return res.status(400).send(renderLiteProfileSettings({ ...buildLiteSettingsProps(req, t('profile.invalidEmail')), ereaderEmail: rawEmail }));
    }
    const fullUser = getUserByUsername(user.username);
    if (!fullUser || !isEreaderEmailAllowedForUser(fullUser)) {
      return res.status(403).send(renderLiteProfileSettings({ ...buildLiteSettingsProps(req, t('profile.ereaderEmail.accessDenied')), ereaderEmailAllowed: false }));
    }
    try {
      setEreaderEmail(user.username, rawEmail);
      res.send(renderLiteProfileSettings(buildLiteSettingsProps(req, t('profile.emailSaved'))));
    } catch (err) {
      res.status(500).send(renderLiteProfileSettings({ ...buildLiteSettingsProps(req, translateKnownErrorMessage(err.message)), ereaderEmail: rawEmail }));
    }
  });

  app.post('/lite/profile/account-email', requireLiteUserAuth, (req, res) => {
    const rawEmail = String(req.body.accountEmail || '').trim();
    try {
      setUserAccountEmail(req.user.username, rawEmail);
      res.send(renderLiteProfileSettings(buildLiteSettingsProps(req, t('profile.emailSaved'))));
    } catch (err) {
      const status = /^(Invalid email|Email already in use)$/.test(err.message) ? 400 : 500;
      res.status(status).send(renderLiteProfileSettings({ ...buildLiteSettingsProps(req, translateKnownErrorMessage(err.message)), accountEmail: rawEmail }));
    }
  });

  app.post('/lite/profile/password', requireLiteUserAuth, (req, res) => {
    const user = req.user;
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const fullUser = getUserByUsername(user.username);
    if (!fullUser || !verifyPassword(currentPassword, fullUser.passwordHash)) {
      return res.status(400).send(renderLiteProfileSettings(buildLiteSettingsProps(req, t('profile.wrongCurrentPassword'))));
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).send(renderLiteProfileSettings(buildLiteSettingsProps(req, t('profile.passwordMismatch'))));
    }
    try {
      changePassword(user.username, newPassword);
      invalidateSessionUserCache(user.username);
      const freshUser = getUserByUsername(user.username);
      logSystemEvent('info', 'auth', 'lite profile password changed', { username: user.username });
      res.cookie('session', createSessionValue(freshUser.username, freshUser.sessionGen || 0), {
        httpOnly: true, sameSite: 'lax', secure: config.sessionSecureCookie, maxAge: config.sessionMaxAgeMs
      });
      res.send(renderLiteProfileSettings(buildLiteSettingsProps(req, t('profile.passwordChanged'))));
    } catch (err) {
      res.status(400).send(renderLiteProfileSettings(buildLiteSettingsProps(req, translateKnownErrorMessage(err.message))));
    }
  });

  app.get('/lite/book/:id', requireLiteBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return res.status(404).send(t('book.notFound'));
      }
      const user = req.user || null;
      const username = user?.username || '';
      const details = await getDetails(book);
      const isRead = username ? isBookRead(username, book.id) : false;
      res.send(renderLiteBook({ book, details, user, isRead, csrfToken: csrf(req) }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/lite/read/:id', requireLiteBrowseAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) return res.status(404).send(t('book.notFound'));
      const username = req.user?.username || '';
      if (username) {
        try {
          recordReadingHistory(username, book.id);
        } catch (err) {
          if (err?.code !== 'SQLITE_BUSY') throw err;
        }
        invalidateUserPageCaches(username);
      }
      const details = await getDetails(book);
      res.send(renderReader({ book, details, user: req.user, csrfToken: csrf(req) || '', lite: true }));
    } catch (error) {
      next(error);
    }
  });
}
