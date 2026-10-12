import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { initDb } from '../src/db.js';

initDb();
import {
  pickCoverTitleColor,
  coverTitleColorFromImageBuffer,
  coverFallbackToCssVars,
  saveUiAsset,
  removeUiAsset,
  getUiCustomization,
  DEFAULT_COVER_TITLE_COLOR,
  COVER_TITLE_COLOR_ON_LIGHT,
  bundledCoverUrl,
} from '../src/services/ui-customization.js';

function solidPng(hex) {
  return sharp({
    create: { width: 80, height: 120, channels: 3, background: hex },
  }).png().toBuffer();
}

test('bundled placeholder colors follow the theme until a color is chosen', () => {
  const base = {
    coverTitleFont: 'serif',
    coverTitleSize: 100,
    coverTitleX: 0,
    coverTitleY: 0,
    coverTitleShadow: 100,
    coverTitleColor: DEFAULT_COVER_TITLE_COLOR,
    coverTitleColorSet: false,
    coverFallbackUrl: null,
  };
  const bundled = coverFallbackToCssVars(base);
  assert.ok(bundled.includes(`--cover-title-color:${DEFAULT_COVER_TITLE_COLOR}`));
  assert.ok(bundled.includes(`--cover-title-color-light:${COVER_TITLE_COLOR_ON_LIGHT}`));
  const chosen = coverFallbackToCssVars({ ...base, coverTitleColor: '#112233', coverTitleColorSet: true });
  assert.ok(chosen.includes('--cover-title-color:#112233'));
  assert.ok(chosen.includes('--cover-title-color-light:#112233'));
  const custom = coverFallbackToCssVars({ ...base, coverFallbackUrl: '/custom/ui/cover?v=1' });
  assert.ok(custom.includes(`--cover-title-color-light:${DEFAULT_COVER_TITLE_COLOR}`));
});

test('pickCoverTitleColor uses dark ink on a light plate and cream on a dark one', () => {
  assert.equal(pickCoverTitleColor(0.9), COVER_TITLE_COLOR_ON_LIGHT);
  assert.equal(pickCoverTitleColor(0.45), COVER_TITLE_COLOR_ON_LIGHT);
  assert.equal(pickCoverTitleColor(0.2), DEFAULT_COVER_TITLE_COLOR);
  assert.equal(pickCoverTitleColor(Number.NaN), DEFAULT_COVER_TITLE_COLOR);
});

test('cover image luminance picks the title color from the plate', async () => {
  assert.equal(await coverTitleColorFromImageBuffer(await solidPng('#ffffff')), COVER_TITLE_COLOR_ON_LIGHT);
  assert.equal(await coverTitleColorFromImageBuffer(await solidPng('#f4f1ea')), COVER_TITLE_COLOR_ON_LIGHT);
  assert.equal(await coverTitleColorFromImageBuffer(await solidPng('#1a120c')), DEFAULT_COVER_TITLE_COLOR);
  assert.equal(await coverTitleColorFromImageBuffer(await solidPng('#2a2014')), DEFAULT_COVER_TITLE_COLOR);
});

test('uploading a cover stores the matching title color', async () => {
  await saveUiAsset('cover', await solidPng('#ffffff'));
  assert.equal(getUiCustomization().coverTitleColor, COVER_TITLE_COLOR_ON_LIGHT);
  await saveUiAsset('cover', await solidPng('#1a120c'));
  assert.equal(getUiCustomization().coverTitleColor, DEFAULT_COVER_TITLE_COLOR);
  removeUiAsset('cover');
  assert.equal(getUiCustomization().coverTitleColor, DEFAULT_COVER_TITLE_COLOR);
  assert.equal(getUiCustomization().hasCustomCover, false);
});

test('bundled cover urls carry a content hash so a same-name replacement is not immutable-cached', () => {
  assert.match(bundledCoverUrl('dark'), /^\/book-fallback\.png\?v=[0-9a-f]{8}$/);
  assert.match(bundledCoverUrl('light'), /^\/book-fallback-light\.png\?v=[0-9a-f]{8}$/);
  assert.equal(bundledCoverUrl('dark'), bundledCoverUrl('dark'));
});

test('bundled leather placeholder keeps the light title color', async () => {
  const leather = fs.readFileSync(path.join(process.env.INPX_TEST_ROOT || process.cwd(), 'public', 'book-fallback.png'));
  assert.equal(await coverTitleColorFromImageBuffer(leather), DEFAULT_COVER_TITLE_COLOR);
});
