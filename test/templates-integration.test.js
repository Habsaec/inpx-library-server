/**
 * Integration tests: template module split integrity.
 * Verifies that the barrel re-export in templates.js exposes every expected symbol,
 * and that each sub-module renders without throwing.
 */
import { test } from 'node:test';
import assert from 'node:assert';

// ── 1. Barrel completeness ──────────────────────────────────────────

test('templates.js barrel exports all expected symbols', async () => {
  const m = await import('../src/templates.js');
  const expected = [
    // shared state
    'setSiteName', 'getSiteName', 'setAllowAnonymousDownload',
    // auth
    'renderLogin', 'renderAdminLogin', 'renderRegister',
    // library
    'renderHome', 'renderCatalog', 'renderLibraryView', 'renderBook',
    'renderFavorites', 'renderBrowsePage', 'renderFacetBooks',
    'renderAuthorFacetPage', 'renderAuthorOutsideSeriesPage',
    'renderShelves', 'renderShelfDetail', 'renderReader', 'renderProfile',
    // admin
    'renderOperations', 'renderAdminUpdate', 'renderAdminUsers',
    'renderAdminEvents', 'renderAdminContent', 'renderAdminDuplicates',
    'renderAdminSources', 'renderAdminSmtp',
    // opds
    'renderOpdsRoot', 'renderOpdsOpenSearch', 'renderOpdsSearchHelp',
    'renderOpdsSectionFeed', 'renderOpdsBooksFeed', 'renderOpdsBookDetail'
  ];
  for (const name of expected) {
    assert.strictEqual(typeof m[name], 'function', `Missing export: ${name}`);
  }
});

// ── 2. Shared helpers ───────────────────────────────────────────────

test('shared.js escapeHtml works correctly', async () => {
  const { escapeHtml } = await import('../src/templates/shared.js');
  assert.strictEqual(escapeHtml('<b>"&\'</b>'), '&lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;');
  assert.strictEqual(escapeHtml(''), '');
  assert.strictEqual(escapeHtml(undefined), '');
});

test('shared.js setSiteName / getSiteName round-trip', async () => {
  const { setSiteName, getSiteName } = await import('../src/templates/shared.js');
  setSiteName('Test Library');
  assert.strictEqual(getSiteName(), 'Test Library');
  setSiteName('');
});

test('shared.js pageShell returns valid HTML document', async () => {
  const { pageShell } = await import('../src/templates/shared.js');
  const html = pageShell({
    title: 'Test',
    content: '<p>hello</p>',
    user: null,
    stats: { totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 1 },
    indexStatus: {}
  });
  assert.ok(html.includes('<!doctype html>'), 'Should start with doctype');
  assert.ok(html.includes('<p>hello</p>'), 'Should include content');
  assert.ok(html.includes('</html>'), 'Should close html tag');
});

// ── 3. Auth templates ───────────────────────────────────────────────

test('renderLogin returns HTML with login form', async () => {
  const { renderLogin } = await import('../src/templates/auth.js');
  const html = renderLogin();
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('action="/login"'));
});

test('renderAdminLogin returns HTML', async () => {
  const { renderAdminLogin } = await import('../src/templates/auth.js');
  const html = renderAdminLogin();
  assert.ok(html.includes('action="/admin/login"'));
});

test('renderRegister with registration disabled', async () => {
  const { renderRegister } = await import('../src/templates/auth.js');
  const html = renderRegister({ registrationEnabled: false });
  assert.ok(html.includes('<!doctype html>'));
});

// ── 4. OPDS templates ───────────────────────────────────────────────

test('renderOpdsRoot returns valid XML', async () => {
  const { renderOpdsRoot } = await import('../src/templates/opds.js');
  const xml = renderOpdsRoot('http://localhost:3000');
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('<feed'));
  assert.ok(xml.includes('/opds/author'));
});

test('renderOpdsOpenSearch returns OpenSearch XML', async () => {
  const { renderOpdsOpenSearch } = await import('../src/templates/opds.js');
  const xml = renderOpdsOpenSearch('http://localhost:3000');
  assert.ok(xml.includes('OpenSearchDescription'));
});

test('renderOpdsBooksFeed renders book entries', async () => {
  const { renderOpdsBooksFeed } = await import('../src/templates/opds.js');
  const xml = renderOpdsBooksFeed('http://localhost:3000', {
    id: 'test', title: 'Test', selfPath: '/opds/test',
    items: [{ id: '1', title: 'Book One', authors: 'Author A', ext: 'fb2', lang: 'ru' }]
  });
  assert.ok(xml.includes('Book One'));
  assert.ok(xml.includes('application/fb2+zip'));
});

// ── 5. Admin templates ──────────────────────────────────────────────

test('renderOperations returns admin page with dashboard', async () => {
  const { renderOperations } = await import('../src/templates/admin.js');
  const html = renderOperations({
    user: { username: 'admin', role: 'admin' },
    stats: { totalBooks: 10, totalAuthors: 5, totalSeries: 3, totalGenres: 2, totalLanguages: 1 },
    indexStatus: { totalArchives: 1 },
    operations: {},
    csrfToken: 'tok'
  });
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('data-operations-dashboard'));
});

test('renderAdminSmtp returns SMTP config page', async () => {
  const { renderAdminSmtp } = await import('../src/templates/admin.js');
  const html = renderAdminSmtp({
    user: { username: 'admin', role: 'admin' },
    stats: { totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 1 },
    indexStatus: {},
    smtp: {}
  });
  assert.ok(html.includes('action="/admin/smtp"'));
});

// ── 6. Library templates ────────────────────────────────────────────

test('renderHome returns home page HTML', async () => {
  const { renderHome } = await import('../src/templates/library.js');
  const html = renderHome({
    user: null,
    stats: { totalBooks: 100, totalAuthors: 50, totalSeries: 20, totalGenres: 10, totalLanguages: 2 },
    indexStatus: {},
    sections: {}
  });
  assert.ok(html.includes('<!doctype html>'));
});

test('renderBook returns book detail page', async () => {
  const { renderBook } = await import('../src/templates/library.js');
  const html = renderBook({
    book: { id: '42', title: 'Test Book', authors: 'Test Author', ext: 'fb2', lang: 'ru' },
    details: {},
    user: null,
    stats: { totalBooks: 1, totalAuthors: 1, totalSeries: 0, totalGenres: 0, totalLanguages: 1 },
    indexStatus: {}
  });
  assert.ok(html.includes('Test Book'));
  assert.ok(html.includes('Test Author'));
});

test('renderReader returns standalone reader HTML', async () => {
  const { renderReader } = await import('../src/templates/library.js');
  const html = renderReader({
    book: { id: '42', ext: 'fb2' },
    details: { title: 'Reader Book' },
    user: null
  });
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('reader.js'));
  assert.ok(html.includes('__READER_BOOK_ID'));
});

// ── 7. Route modules importable ─────────────────────────────────────

test('all route modules can be imported', async () => {
  const modules = [
    '../src/routes/admin.js',
    '../src/routes/auth-routes.js',
    '../src/routes/download.js',
    '../src/routes/library.js',
    '../src/routes/opds.js',
    '../src/routes/reader.js',
    '../src/routes/user-api.js'
  ];
  for (const mod of modules) {
    const m = await import(mod);
    assert.ok(m, `Module ${mod} should be importable`);
  }
});
