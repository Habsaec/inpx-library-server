/**
 * Тесты чистой логики services/update-check.js — сравнение версий и разбор
 * ответа GitHub /releases/latest. Сеть не дёргаем.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, buildUpdateCheckResult, releaseFromTagUrl } from '../src/services/update-check.js';

test('compareVersions: базовые случаи', () => {
  assert.equal(compareVersions('2.6.3', '2.6.2'), 1);
  assert.equal(compareVersions('2.6.2', '2.6.3'), -1);
  assert.equal(compareVersions('2.6.2', '2.6.2'), 0);
  assert.equal(compareVersions('3.0.0', '2.99.99'), 1);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('v2.7.0', '2.6.2'), 1); // префикс v допустим
  // Нераспознанные версии не считаются новее
  assert.equal(compareVersions('?', '2.6.2'), 0);
  assert.equal(compareVersions('2.7.0', ''), 0);
});

const releaseFixture = (tag, assetName) => ({
  tag_name: tag,
  html_url: `https://github.com/Habsaec/inpx-library-server/releases/tag/${tag}`,
  published_at: '2026-09-02T19:00:25Z',
  body: 'Release notes',
  assets: assetName ? [{
    name: assetName,
    size: 1499496,
    browser_download_url: `https://github.com/Habsaec/inpx-library-server/releases/download/${tag}/${assetName}`
  }] : []
});

test('buildUpdateCheckResult: новее и есть ZIP-ассет → updateAvailable', () => {
  const r = buildUpdateCheckResult(releaseFixture('v9.9.9', 'inpx-library-server-9.9.9.zip'), '2.6.2');
  assert.equal(r.updateAvailable, true);
  assert.equal(r.latestVersion, '9.9.9');
  assert.equal(r.currentVersion, '2.6.2');
  assert.equal(r.assetName, 'inpx-library-server-9.9.9.zip');
  assert.ok(r.assetUrl.startsWith('https://github.com/'));
  assert.ok(r.releaseUrl.includes('/releases/tag/'));
});

test('buildUpdateCheckResult: та же версия → updateAvailable=false', () => {
  const r = buildUpdateCheckResult(releaseFixture('v2.6.2', 'inpx-library-server-2.6.2.zip'), '2.6.2');
  assert.equal(r.updateAvailable, false);
  assert.equal(r.latestVersion, '2.6.2');
});

test('buildUpdateCheckResult: новее, но без ZIP-ассета → updateAvailable=false', () => {
  const r = buildUpdateCheckResult(releaseFixture('v9.9.9', null), '2.6.2');
  assert.equal(r.updateAvailable, false);
  assert.equal(r.assetUrl, '');
});

test('buildUpdateCheckResult: посторонний ассет не подхватывается', () => {
  const release = releaseFixture('v9.9.9', null);
  release.assets = [{ name: 'other-tool.zip', size: 10, browser_download_url: 'https://example.com/x.zip' }];
  const r = buildUpdateCheckResult(release, '2.6.2');
  assert.equal(r.updateAvailable, false);
});

test('releaseFromTagUrl: запись релиза из редиректа /releases/latest (лимит GitHub API)', () => {
  const release = releaseFromTagUrl('https://github.com/Habsaec/inpx-library-server/releases/tag/v2.14.0');
  const r = buildUpdateCheckResult(release, '2.13.0');
  assert.equal(r.latestVersion, '2.14.0');
  assert.equal(r.updateAvailable, true);
  assert.equal(r.assetName, 'inpx-library-server-2.14.0.zip');
  assert.equal(r.assetUrl, 'https://github.com/Habsaec/inpx-library-server/releases/download/v2.14.0/inpx-library-server-2.14.0.zip');
  assert.equal(r.releaseUrl, 'https://github.com/Habsaec/inpx-library-server/releases/tag/v2.14.0');
  assert.equal(buildUpdateCheckResult(release, '2.14.0').updateAvailable, false);
  // Не страница релиза / не версия — запасной путь не срабатывает.
  assert.equal(releaseFromTagUrl(''), null);
  assert.equal(releaseFromTagUrl(null), null);
  assert.equal(releaseFromTagUrl('https://github.com/Habsaec/inpx-library-server/releases'), null);
  assert.equal(releaseFromTagUrl('https://github.com/Habsaec/inpx-library-server/releases/tag/nightly'), null);
});
