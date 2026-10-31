import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_SECTION_IDS, WEB_HOME_SECTION_IDS, normalizeHomeLayout, moveHomeSection, orderShelves, reorderHomeSections, reorderShelfGroup } from '../src/home-layout.js';

test('normalizeHomeLayout: empty → default order, nothing hidden', () => {
  assert.deepEqual(normalizeHomeLayout(''), { order: HOME_SECTION_IDS, hidden: [], shelfOrder: [] });
  assert.deepEqual(normalizeHomeLayout('not json'), { order: HOME_SECTION_IDS, hidden: [], shelfOrder: [] });
});

test('normalizeHomeLayout: drops unknown ids and puts missing ones back in place', () => {
  const layout = normalizeHomeLayout({ order: ['shelves', 'bogus', 'novinki', 'novinki'], hidden: ['recommended', 'x'] });
  assert.deepEqual(layout.order, ['continue', 'recent', 'shelves', 'novinki', 'recommended', 'following']);
  assert.deepEqual(layout.hidden, ['recommended']);
});

test('moveHomeSection: web moves skip the app-only block', () => {
  const layout = normalizeHomeLayout('');
  const moved = moveHomeSection(layout, 'novinki', 'up', WEB_HOME_SECTION_IDS);
  assert.deepEqual(moved.order, ['novinki', 'recent', 'continue', 'recommended', 'following', 'shelves']);
  assert.equal(moveHomeSection(layout, 'continue', 'up', WEB_HOME_SECTION_IDS), layout);
  const down = moveHomeSection(layout, 'following', 'down');
  assert.deepEqual(down.order.slice(-2), ['shelves', 'following']);
});

test('renderHome follows the layout: hidden blocks gone, banner after a moved shelf', async () => {
  const { renderHome } = await import('../src/templates/library.js');
  const { t } = await import('../src/i18n.js');
  const user = { username: 'layout_user', role: 'user' };
  const html = renderHome({
    user,
    stats: {},
    sections: { newest: [] },
    homeLayout: normalizeHomeLayout({ order: ['novinki', 'continue'], hidden: ['recommended'] })
  });
  const novinki = html.indexOf(`<h2>${t('home.shelfNew')}`);
  const shelf = html.indexOf('<section class="library-shelf"');
  const banner = html.indexOf('welcome-hero-banner');
  assert.ok(shelf > 0 && banner > 0 && shelf < banner, 'a shelf comes before the banner');
  assert.ok(novinki > shelf && novinki < banner, 'that shelf is «Новинки»');
  assert.equal(html.includes('data-home-recommendations'), false, 'hidden recommendations are not rendered');
});

test('profile settings render the home layout form', async () => {
  const { renderProfileSettings } = await import('../src/templates/library.js');
  const html = renderProfileSettings({ user: { username: 'layout_user' }, stats: {}, userStats: {}, section: 'view' });
  assert.ok(html.includes('action="/profile/home-layout"'));
  assert.ok(html.includes('name="move" value="novinki:up"'));
});

test('shelves follow shelfOrder; unlisted ones keep their place after it', () => {
  const shelves = [{ id: 1, kind: 'shelf' }, { id: 2, kind: 'shelf' }, { id: 3, kind: 'smart' }, { id: 4, kind: 'smart' }];
  const ordered = orderShelves(shelves, ['smart:4', 'shelf:2', 'shelf:99']).map((s) => `${s.kind}:${s.id}`);
  assert.deepEqual(ordered, ['smart:4', 'shelf:2', 'shelf:1', 'smart:3']);
  assert.deepEqual(normalizeHomeLayout({ shelfOrder: ['smart:4', 'bad', 'smart:4', 'shelf:x'] }).shelfOrder, ['smart:4']);
});

test('drag-and-drop: home blocks keep the app-only slot, a shelves list reorders only its kind', () => {
  const layout = normalizeHomeLayout({ hidden: ['recent'], shelfOrder: ['smart:3'] });
  const moved = reorderHomeSections(layout, ['shelves', 'continue', 'novinki', 'recommended', 'following'], WEB_HOME_SECTION_IDS);
  assert.deepEqual(moved.order, ['shelves', 'recent', 'continue', 'novinki', 'recommended', 'following']);
  assert.deepEqual(moved.hidden, ['recent']);
  assert.equal(reorderHomeSections(layout, ['shelves', 'continue'], WEB_HOME_SECTION_IDS), layout);

  const all = ['shelf:1', 'smart:3', 'shelf:2', 'smart:4'];
  // Regular shelves swapped; smart ones keep their slots in the mixed order.
  assert.deepEqual(reorderShelfGroup(layout, all, ['shelf:2', 'shelf:1']).shelfOrder, ['shelf:2', 'smart:3', 'shelf:1', 'smart:4']);
  assert.deepEqual(reorderShelfGroup(layout, all, ['smart:4', 'smart:3']).shelfOrder, ['shelf:1', 'smart:4', 'shelf:2', 'smart:3']);
  // Not the whole list of one kind → unchanged.
  assert.equal(reorderShelfGroup(layout, all, ['shelf:2']), layout);
  assert.equal(reorderShelfGroup(layout, all, ['shelf:2', 'smart:3']), layout);
  assert.deepEqual(moveHomeSection(reorderShelfGroup(layout, all, ['shelf:2', 'shelf:1']), 'novinki', 'up').shelfOrder.slice(0, 1), ['shelf:2']);
});

test('shelves page: lists are drag-sortable, no separate home order block', async () => {
  const { renderShelves, renderProfileSettings } = await import('../src/templates/library.js');
  const html = renderShelves({
    user: { username: 'u' }, stats: {}, indexStatus: {},
    shelves: [{ id: 2, name: 'Second', bookCount: 0, previewBookIds: [] }, { id: 1, name: 'First', bookCount: 0, previewBookIds: [] }],
    smartShelves: [{ id: 3, name: 'Smart', query: 'genre=x', catalogUrl: '/catalog?genre=x', bookCount: 0, previewBookIds: [] }]
  });
  assert.ok(html.includes('data-sortable data-sort-url="/shelves/order"'));
  assert.ok(html.indexOf('data-sort-key="shelf:2"') < html.indexOf('data-sort-key="shelf:1"'));
  // One smart shelf: nothing to sort there.
  assert.equal((html.match(/data-sortable/g) || []).length, 1);
  assert.equal(html.includes('home-shelf-order'), false);
  const profile = renderProfileSettings({ user: { username: 'u' }, stats: {}, userStats: {}, section: 'view' });
  assert.ok(profile.includes('data-sort-url="/profile/home-layout"'));
  assert.ok(profile.includes('data-sort-key="novinki"'));
});
