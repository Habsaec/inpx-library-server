/**
 * Подборки (src/collections.js): веб /collections, /collections/:slug; API для Android
 * (/api/collections, /api/collections/:slug); формы Админка → Контент → «Подборки».
 */
import { t, tp } from '../i18n.js';
import { requireBrowseAuth, requireAdminWeb, requireApiAuth, requireWebAuth } from '../middleware/auth.js';
import { ApiErrorCode, apiFail } from '../api-errors.js';
import { getIndexStatus } from '../inpx.js';
import { getReadBookIdSet } from '../db.js';
import { logSystemEvent } from '../services/system-events.js';
import {
  listCollections, getCollection, importCollectionJson, setCollectionEnabled, deleteCollection,
  matchCollectionsNow, isCollectionsMatchRunning, setCollectionOnHome
} from '../collections.js';
import { renderCollections, renderCollection } from '../templates/library.js';
import { isListBrowseView } from '../browse-view-prefs.js';
import { getUserHomeLayout, setUserHomeLayout, reorderCollectionList } from '../home-layout.js';

const ADMIN_BACK = '/admin/content';

function adminRedirect(res, { flash = '', error = '' } = {}) {
  const params = new URLSearchParams();
  if (flash) params.set('flash', flash);
  if (error) params.set('collectionsError', error);
  const qs = params.toString();
  res.redirect(`${ADMIN_BACK}${qs ? `?${qs}` : ''}#collections`);
}

/** API shape of a list entry (no admin-only fields). */
function publicCollection(c) {
  return {
    slug: c.slug,
    title: c.title,
    description: c.description,
    source: c.source,
    sourceUrl: c.sourceUrl,
    total: c.total,
    found: c.found,
    matching: c.matching,
    previewBookIds: c.previewBookIds,
    ...(c.onHome !== undefined ? { onHome: c.onHome } : {})
  };
}

/**
 * @param {import('express').Application} app
 * @param {{ getCachedStats: () => any }} deps
 */
export function registerCollectionRoutes(app, { getCachedStats }) {
  app.get('/collections', requireBrowseAuth, (req, res) => {
    res.send(renderCollections({
      collections: listCollections({ username: req.user?.username || '' }),
      user: req.user || null,
      stats: getCachedStats(),
      indexStatus: getIndexStatus(),
      csrfToken: req.csrfToken || ''
    }));
  });

  app.get('/collections/:slug', requireBrowseAuth, (req, res) => {
    const username = req.user?.username || '';
    const collection = getCollection(req.params.slug, { username });
    if (!collection) return res.status(404).send(t('collections.notFound'));
    res.send(renderCollection({
      collection,
      // Same covers / list choice as the catalog and library sections.
      listView: isListBrowseView({ username, queryView: req.query.view, scope: 'catalog' }),
      user: req.user || null,
      stats: getCachedStats(),
      indexStatus: getIndexStatus(),
      csrfToken: req.csrfToken || '',
      readBookIds: username ? getReadBookIdSet(username) : null
    }));
  });

  /** → { items: [{ slug, title, description, source, sourceUrl, total, found, matching, previewBookIds, onHome? }] } (`onHome` 1|0 for a signed-in user) */
  app.get('/api/collections', requireBrowseAuth, (req, res) => {
    res.json({ items: listCollections({ username: req.user?.username || '' }).map(publicCollection) });
  });

  /** Pin to the home page, like `POST /api/shelves/:id/home`: `{ on }` → `{ ok, onHome }`. */
  app.post('/api/collections/:slug/home', requireApiAuth, (req, res) => {
    const onHome = setCollectionOnHome(req.user.username, req.params.slug, [true, 1, '1', 'true'].includes(req.body?.on));
    if (onHome === null) return apiFail(res, 404, ApiErrorCode.NOT_FOUND, t('collections.notFound'));
    res.json({ ok: true, onHome });
  });

  /* Drag in the /collections list (app.js initSortableLists): `order=slug1,slug2,…` → homeLayout.collectionOrder. */
  app.post('/collections/order', requireWebAuth, (req, res) => {
    const username = req.user.username;
    const allSlugs = listCollections({ username }).map((c) => c.slug);
    const slugs = String([].concat(req.body?.order ?? '').pop() || '').split(',');
    setUserHomeLayout(username, reorderCollectionList(getUserHomeLayout(username), allSlugs, slugs));
    if (String(req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
    res.redirect(303, '/collections');
  });

  app.post('/collections/:slug/home', requireWebAuth, (req, res) => {
    setCollectionOnHome(req.user.username, req.params.slug, req.body?.on === '1');
    const next = String(req.body?.next || '');
    res.redirect(303, /^\/collections(?:\/[a-z0-9-]{1,64})?$/.test(next) ? next : '/collections');
  });

  /**
   * → { slug, title, description, source, sourceUrl, total, found, read, matching,
   *     items: [{ position, author, title, year, note, book: Book|null, read }] }
   */
  app.get('/api/collections/:slug', requireBrowseAuth, (req, res) => {
    const collection = getCollection(req.params.slug, { username: req.user?.username || '' });
    if (!collection) return apiFail(res, 404, ApiErrorCode.NOT_FOUND, t('collections.notFound'));
    const { id, builtin, enabled, ...rest } = collection;
    res.json(rest);
  });

  app.post('/admin/collections/import', requireAdminWeb, (req, res) => {
    try {
      const result = importCollectionJson(req.body?.json);
      logSystemEvent('info', 'collections', 'collection imported', { user: req.user.username, slug: result.slug, items: result.items });
      adminRedirect(res, { flash: tp('admin.collections.imported', { slug: result.slug, n: result.items }) });
    } catch (error) {
      adminRedirect(res, { error: error.message || t('api.error.unknown') });
    }
  });

  app.post('/admin/collections/rematch', requireAdminWeb, (req, res) => {
    if (!isCollectionsMatchRunning()) matchCollectionsNow();
    adminRedirect(res, { flash: t('admin.collections.rematchStarted') });
  });

  app.post('/admin/collections/:id/toggle', requireAdminWeb, (req, res) => {
    setCollectionEnabled(req.params.id, req.body?.enabled === '1');
    adminRedirect(res, { flash: t('admin.content.saved') });
  });

  app.post('/admin/collections/:id/delete', requireAdminWeb, (req, res) => {
    if (deleteCollection(req.params.id)) {
      logSystemEvent('info', 'collections', 'collection deleted', { user: req.user.username, id: req.params.id });
    }
    adminRedirect(res, { flash: t('admin.collections.deleted') });
  });
}
