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
    'renderLogin', 'renderAdminLogin', 'renderRegister', 'renderForgotPassword', 'renderResetPassword',
    // library
    'renderHome', 'renderCatalog', 'renderSearchOverview', 'renderLibraryView', 'renderBook',
    'renderFavorites', 'renderBrowsePage', 'renderFacetBooks',
    'renderAuthorFacetPage', 'renderAuthorOutsideSeriesPage',
    'renderShelves', 'renderShelfDetail', 'renderReader', 'renderProfile',
    // admin
    'renderOperations', 'renderAdminUpdate', 'renderAdminUsers',
    'renderAdminEvents', 'renderAdminContent', 'renderAdminDuplicates',
    'renderAdminSources', 'renderAdminSmtp',
    // opds
    'renderOpdsRoot', 'renderOpdsOpenSearch',
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
  assert.strictEqual(escapeHtml('id\u0000suffix'), 'idsuffix');
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

test('renderLogin shows default logo when enabled and no custom logo uploaded', async () => {
  const { setSetting } = await import('../src/db.js');
  const { invalidateUiCustomizationCache, removeUiAsset } = await import('../src/services/ui-customization.js');
  const { renderLogin } = await import('../src/templates/auth.js');
  try { removeUiAsset('logo'); } catch { /* no custom logo uploaded */ }
  setSetting('ui_show_logo_login', '1');
  invalidateUiCustomizationCache();
  const html = renderLogin();
  assert.match(html, /class="login-brand-logo"/);
  assert.match(html, /class="login-logo-img"/);
  assert.match(html, /src="\/logo\.png"/);
});

test('renderLogin hides logo block when showLogoOnLogin is disabled', async () => {
  const { setSetting } = await import('../src/db.js');
  const { invalidateUiCustomizationCache, saveUiSettings } = await import('../src/services/ui-customization.js');
  const { renderLogin } = await import('../src/templates/auth.js');
  saveUiSettings({ showLogoOnLogin: false });
  invalidateUiCustomizationCache();
  const html = renderLogin();
  assert.doesNotMatch(html, /class="login-brand-logo"/);
  setSetting('ui_show_logo_login', '1');
  invalidateUiCustomizationCache();
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

test('renderRegister shows invite field only when required', async () => {
  const { renderRegister } = await import('../src/templates/auth.js');
  const open = renderRegister({ registrationEnabled: true });
  assert.equal(open.includes('name="inviteToken"'), false);
  const invited = renderRegister({
    registrationEnabled: true,
    inviteRequired: true,
    inviteValue: 'abc-invite'
  });
  assert.ok(invited.includes('name="inviteToken"'));
  assert.ok(invited.includes('value="abc-invite"'));
});

test('renderForgotPassword returns HTML', async () => {
  const { renderForgotPassword } = await import('../src/templates/auth.js');
  const html = renderForgotPassword();
  assert.ok(html.includes('action="/forgot-password"'));
});

test('renderResetPassword returns HTML', async () => {
  const { renderResetPassword } = await import('../src/templates/auth.js');
  const html = renderResetPassword({ token: 'abc123' });
  assert.ok(html.includes('action="/reset-password"'));
  assert.ok(html.includes('value="abc123"'));
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
  assert.equal(html.includes('action="/admin/settings/password-reset"'), false);
});

test('renderAdminContent includes download filename template select', async () => {
  const { renderAdminContent } = await import('../src/templates/admin.js');
  const html = renderAdminContent({
    user: { username: 'admin', role: 'admin' },
    stats: { totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 1 },
    indexStatus: {},
    languages: [],
    excludedLangSet: new Set(),
    genres: [],
    excludedGenreSet: new Set(),
    disabledDownloadFormatSet: new Set(),
    downloadFilenameStyle: 'title',
    csrfToken: 'tok'
  });
  assert.ok(html.includes('name="download_filename_style"'));
  assert.ok(html.includes('value="title" selected'));
  assert.ok(html.includes('value="translit-full"'));
});

test('renderAdminUsers includes password recovery settings', async () => {
  const { renderAdminUsers } = await import('../src/templates/admin.js');
  const html = renderAdminUsers({
    user: { username: 'admin', role: 'admin' },
    stats: { totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 1 },
    indexStatus: {},
    users: [],
    passwordResetEnabled: true,
    publicBaseUrl: 'https://books.example.com',
    csrfToken: 'tok'
  });
  assert.ok(html.includes('action="/admin/settings/password-reset"'));
  assert.ok(html.includes('https://books.example.com'));
});

test('renderAdminUsers includes registration invite form', async () => {
  const { renderAdminUsers } = await import('../src/templates/admin.js');
  const html = renderAdminUsers({
    user: { username: 'admin', role: 'admin' },
    stats: { totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 1 },
    indexStatus: {},
    users: [],
    registrationInviteToken: 'secret-invite',
    registrationInviteUrl: 'https://books.example.com/register?invite=secret-invite',
    csrfToken: 'tok'
  });
  assert.ok(html.includes('id="registration-invite-form"'));
  assert.ok(html.includes('data-ajax'));
  assert.ok(html.includes('action="/admin/settings/registration-invite"'));
  assert.ok(html.includes('value="secret-invite"'));
  assert.ok(html.includes('name="inviteAction" value="generate"'));
  assert.ok(html.includes('https://books.example.com/register?invite=secret-invite'));
  assert.ok(html.includes('data-copy-invite'));
  assert.ok(html.includes('data-copy-text="https://books.example.com/register?invite=secret-invite"'));
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
  assert.ok(!html.includes('data-home-continue'));
  assert.ok(!html.includes('data-home-recommendations'));
  const withContinue = renderHome({
    user: { username: 'tester' },
    stats: { totalBooks: 100, totalAuthors: 50, totalSeries: 20, totalGenres: 10, totalLanguages: 2 },
    indexStatus: {},
    sections: {},
    hasContinueData: true
  });
  assert.ok(withContinue.includes('data-home-continue'));
  assert.ok(!withContinue.includes('data-home-continue-grid'));
  assert.ok(!withContinue.includes('data-home-continue-cta'));
  assert.ok(withContinue.includes('data-home-recommendations-grid'));
  assert.ok(withContinue.indexOf('data-home-continue') < withContinue.indexOf('data-home-recommendations'));
  assert.ok(withContinue.lastIndexOf('href="/library/recent"') < withContinue.indexOf('data-home-recommendations-grid'));
});

test('renderBook returns book detail page', async () => {
  const { renderBook } = await import('../src/templates/library.js');
  const html = renderBook({
    book: { id: '42', title: 'Test Book', authors: 'Test Author', ext: 'fb2', lang: 'ru' },
    details: {},
    user: { username: 'tester' },
    stats: { totalBooks: 1, totalAuthors: 1, totalSeries: 0, totalGenres: 0, totalLanguages: 1 },
    indexStatus: {}
  });
  assert.ok(html.includes('Test Book'));
  assert.ok(html.includes('Test Author'));
  const actionsStart = html.indexOf('class="actions actions-primary"');
  const actions = actionsStart >= 0 ? html.slice(actionsStart, actionsStart + 2500) : '';
  const readAt = actions.search(/class="button button-primary"[^>]*>(?:<svg[\s\S]*?<\/svg>)?[^<]*(Читать книгу|Read book)/);
  const downloadAt = actions.indexOf('download-menu-trigger');
  assert.ok(readAt >= 0 && downloadAt >= 0 && readAt < downloadAt, 'Read book should come before Download');
});

test('renderFacetBooks: genre page renders view tabs', async () => {
  const { renderFacetBooks } = await import('../src/templates/library.js');
  const html = renderFacetBooks({
    title: 'Жанр: Фэнтези',
    items: [], total: 0, page: 1, pageSize: 24,
    user: null, stats: {}, facetPath: '/facet/genres/sf_fantasy',
    indexStatus: {}, sort: 'recent', breadcrumbs: [{ label: 'Home', href: '/' }],
    facet: 'genres', facetValue: 'sf_fantasy'
  });
  assert.ok(html.includes('facet-view-tabs'), 'tab strip should be rendered');
  assert.ok(html.includes('view=authors'), 'authors tab href');
  assert.ok(html.includes('view=series'), 'series tab href');
});

test('renderFacetBooks: view=authors renders entity grid for genre', async () => {
  const { renderFacetBooks } = await import('../src/templates/library.js');
  const html = renderFacetBooks({
    title: 'Жанр: Фэнтези',
    items: [], total: 2, page: 1, pageSize: 50,
    user: null, stats: {}, facetPath: '/facet/genres/sf_fantasy',
    indexStatus: {}, sort: 'count', breadcrumbs: [{ label: 'Home', href: '/' }],
    facet: 'genres', facetValue: 'sf_fantasy',
    view: 'authors',
    entityItems: [
      { name: 'Толкиен', displayName: 'Толкиен', bookCount: 12 },
      { name: 'Сапковский', displayName: 'Сапковский', bookCount: 8 }
    ]
  });
  assert.ok(html.includes('/facet/authors/'), 'rows should link to author facet');
  assert.ok(html.includes('Толкиен'), 'first author should be listed');
});

test('renderFacetBooks: non-genre facets do not render view tabs', async () => {
  const { renderFacetBooks } = await import('../src/templates/library.js');
  const html = renderFacetBooks({
    title: 'Серия: Ведьмак',
    items: [], total: 0, page: 1, pageSize: 24,
    user: null, stats: {}, facetPath: '/facet/series/Ведьмак',
    indexStatus: {}, sort: 'recent', breadcrumbs: [{ label: 'Home', href: '/' }],
    facet: 'series', facetValue: 'Ведьмак'
  });
  assert.ok(!html.includes('facet-view-tabs'), 'series facet should not render tabs');
});

test('renderScopeDownloadMenu: author and series links omit the 20-book checkbox cap', async () => {
  const { renderScopeDownloadMenu, batchScopeDownloadPath } = await import('../src/templates/shared.js');
  const user = { username: 'tester' };
  const authorHtml = renderScopeDownloadMenu({ facet: 'authors', value: 'Толстой' }, { user });
  const seriesHtml = renderScopeDownloadMenu({ facet: 'series', value: 'Ведьмак' }, { user });
  assert.ok(authorHtml.includes('/download/batch?'));
  assert.ok(authorHtml.includes('facet=authors'));
  assert.ok(authorHtml.includes('data-scope-per-book-zip'));
  assert.ok(authorHtml.includes(encodeURIComponent('Толстой')));
  assert.ok(seriesHtml.includes('facet=series'));
  assert.ok(seriesHtml.includes(encodeURIComponent('Ведьмак')));
  assert.strictEqual(
    batchScopeDownloadPath({ facet: 'series', value: 'Ведьмак', format: 'fb2' }),
    '/download/batch?facet=series&value=%D0%92%D0%B5%D0%B4%D1%8C%D0%BC%D0%B0%D0%BA&format=fb2'
  );
  assert.strictEqual(renderScopeDownloadMenu({ facet: 'authors', value: 'X' }, { user: null }), '');
});

test('renderAuthorFacetPage: shows download-all for an author with books', async () => {
  const { renderAuthorFacetPage } = await import('../src/templates/library.js');
  const html = renderAuthorFacetPage({
    title: 'Автор: Тест',
    displayName: 'Тест',
    series: [{ name: 'Цикл', displayName: 'Цикл', bookCount: 3, books: [] }],
    standaloneBooks: [],
    total: 3,
    user: { username: 'tester' },
    stats: {},
    facetPath: '/facet/authors/Тест',
    indexStatus: {},
    sort: 'recent',
    breadcrumbs: [{ label: 'Home', href: '/' }],
    facetValue: 'Тест'
  });
  assert.ok(html.includes('/download/batch?'));
  assert.ok(html.includes('facet=authors'));
});

test('renderFacetBooks: series page shows download-all when user can download', async () => {
  const { renderFacetBooks } = await import('../src/templates/library.js');
  const html = renderFacetBooks({
    title: 'Серия: Ведьмак',
    items: [{ id: '1', title: 'Книга', ext: 'fb2', authors: 'Автор' }],
    total: 25,
    page: 1,
    pageSize: 24,
    user: { username: 'tester' },
    stats: {},
    facetPath: '/facet/series/Ведьмак',
    indexStatus: {},
    sort: 'recent',
    breadcrumbs: [{ label: 'Home', href: '/' }],
    facet: 'series',
    facetValue: 'Ведьмак'
  });
  assert.ok(html.includes('/download/batch?'));
  assert.ok(html.includes('facet=series'));
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

test('renderReader lite mode sets e-ink attrs and lite boot', async () => {
  const { renderReader } = await import('../src/templates/library.js');
  const html = renderReader({
    book: { id: '42', ext: 'fb2' },
    details: { title: 'Lite Reader' },
    user: null,
    lite: true
  });
  assert.ok(html.includes('data-eink="1"'));
  assert.ok(html.includes('data-reader-theme="eink"'));
  assert.ok(html.includes('__READER_LITE=1'));
  assert.ok(html.includes('/lite/book/'));
  assert.ok(html.includes('history.back()'));
  assert.ok(!html.includes('data-set-theme'));
});

test('renderLiteHome shows logo in header and admin subtitle in hero', async () => {
  const { setSiteName } = await import('../src/templates/shared.js');
  const { renderLiteHome } = await import('../src/templates/lite.js');
  setSiteName('My Library');
  const html = renderLiteHome({
    stats: { totalBooks: 1, totalAuthors: 2, totalSeries: 3, totalGenres: 4 },
    user: null,
    homeSubtitle: 'Custom home tagline'
  });
  assert.ok(html.includes('lite-header-logo'));
  assert.ok(!html.includes('lite-header-title'));
  assert.ok(html.includes('Custom home tagline'));
  assert.ok(html.includes('My Library'));
  assert.ok(html.includes('lite-hero-subtitle'));
});

// ── 7. Route modules importable ─────────────────────────────────────

test('all route modules can be imported', async () => {
  const modules = [
    '../src/routes/admin.js',
    '../src/routes/auth-routes.js',
    '../src/routes/download.js',
    '../src/routes/library.js',
    '../src/routes/lite.js',
    '../src/routes/opds.js',
    '../src/routes/reader.js',
    '../src/routes/user-api.js'
  ];
  for (const mod of modules) {
    const m = await import(mod);
    assert.ok(m, `Module ${mod} should be importable`);
  }
});
