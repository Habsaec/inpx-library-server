/**
 * Smoke test of the admin panel pages.
 *
 * `src/routes/admin.js` was the least covered file in the repository (~6 % of lines): the panel
 * talks to nearly everything — settings, sources, users, duplicates, conversion, appearance —
 * and a broken query or template there answers 500 on a page only the owner sees. Every page
 * below is rendered by the REAL templates; the deps that server.js builds inline (an operations
 * snapshot, the repair/update hooks) are stubbed, because importing server.js would bind a port
 * and start the indexers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb, db, createUser } from '../src/db.js';
import { registerAdminRoutes } from '../src/routes/admin.js';
import * as templates from '../src/templates.js';
import { stopQueryWorker } from '../src/services/query-pool.js';

/* Shape copied from src/server.js (operationsState). */
function operationsState() {
  return {
    reindexRunning: false, repairRunning: false, ftsRebuildRunning: false, sidecarRunning: false,
    sourceDeleteRunning: false, dupCleanRunning: false, dupCleanProgress: null,
    lastReindexRequestedAt: null, lastFtsRebuildRequestedAt: null, lastSidecarRequestedAt: null,
    lastSourceDeleteRequestedAt: null, lastRestartRequestedAt: null, lastStopRequestedAt: null
  };
}

test('admin pages render on a minimal install', async (t) => {
  initDb();
  for (const table of ['book_series', 'book_authors', 'books', 'authors', 'series_catalog']) db.exec(`DELETE FROM ${table}`);
  db.exec('DELETE FROM sources');
  db.prepare(`INSERT INTO sources (id, name, type, path, enabled) VALUES (1, 'src', 'folder', '/library', 1)`).run();
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get('smokeadmin')) {
    createUser({ username: 'smokeadmin', password: 'SmokeAdmin1!', role: 'admin' });
  }

  const noop = () => {};
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  /* `attachSessionUser` installs req.user in server.js; here a fixed admin plays that part. */
  app.use((req, res, next) => { req.user = { username: 'smokeadmin', role: 'admin' }; next(); });
  registerAdminRoutes(app, {
    operationsState: operationsState(),
    getOperationsSnapshot: () => ({
      db: { sizeBytes: 0, sizeLabel: '0 B' },
      inpx: { present: false },
      memory: { rssBytes: 0 },
      queues: {}
    }),
    getServiceValidation: () => ({ checks: {}, ok: true }),
    getCachedStats: () => ({ totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 0 }),
    clearBookDetailsCache: () => 0,
    getDetailsFull: async () => null,
    buildPublicSettingsExport: () => ({}),
    runRepairMetadata: () => false,
    bookFlibustaSidecarEffective: () => false,
    gracefulExit: noop,
    setAllowAnonymousDownload: noop,
    setSiteName: noop,
    restartTelegramBot: noop,
    isTelegramBotRunning: () => false,
    testAnnounceNewBooksInTelegram: async () => ({}),
    syncTelegramBotProfilePhoto: async () => ({}),
    templates: Object.fromEntries([
      'renderOperations', 'renderAdminUsers', 'renderAdminUpdate', 'renderAdminSmtp', 'renderAdminTelegram',
      'renderAdminEvents', 'renderAdminSources', 'renderAdminDuplicates', 'renderAdminContent',
      'renderAdminAppearance'
    ].map((name) => [name, templates[name]]))
  });
  const server = await new Promise((resolve) => {
    const listener = http.createServer(app).listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => { server.close(); stopQueryWorker(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const pages = [
    '/admin',
    '/admin/users',
    '/admin/sources',
    '/admin/content',
    '/admin/duplicates',
    '/admin/appearance',
    '/admin/conversion',
    '/admin/smtp',
    '/admin/telegram',
    '/admin/events'
  ];
  for (const path of pages) {
    const res = await fetch(base + path, { redirect: 'manual' });
    const body = await res.text();
    if (res.status !== 200) {
      assert.fail(`${path} -> ${res.status} ${firstError(body)}`);
    }
    assert.ok(body.length > 200, `${path}: page looks empty (${body.length} bytes)`);
    assert.ok(!body.includes('Cannot read propert'), `${path}: leaked internals`);
  }

  const sources = await (await fetch(`${base}/admin/sources`)).text();
  assert.ok(sources.includes('/library'), 'the source row shows its path');

  const users = await (await fetch(`${base}/admin/users`)).text();
  assert.ok(users.includes('smokeadmin'), 'the user list shows the admin account');
});

/** Express prints the error and the stack into the page; the test only needs the message. */
function firstError(body) {
  const match = /<pre>([\s\S]{0,400})<\/pre>/.exec(body);
  return match ? match[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) : body.slice(0, 200);
}
