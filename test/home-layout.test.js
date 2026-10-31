import test from 'node:test';
import assert from 'node:assert/strict';
import { HOME_SECTION_IDS, WEB_HOME_SECTION_IDS, normalizeHomeLayout, moveHomeSection } from '../src/home-layout.js';

test('normalizeHomeLayout: empty → default order, nothing hidden', () => {
  assert.deepEqual(normalizeHomeLayout(''), { order: HOME_SECTION_IDS, hidden: [] });
  assert.deepEqual(normalizeHomeLayout('not json'), { order: HOME_SECTION_IDS, hidden: [] });
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
