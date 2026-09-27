import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThemePalette,
  buildThemePair,
  buildGlassPanelBackground,
  effectiveGlassFillOpacity,
  adjustLightTextForGlassOpacity,
  themePairToCssVars,
  hexToRgb,
  relativeLuminance,
  DEFAULT_GLASS_DARK,
  DEFAULT_GLASS_LIGHT,
  fontSizeToCssVars,
  DEFAULT_FONT_SIZE_PX,
} from '../src/services/theme-engine.js';

test('buildThemePalette derives contrasting text and harmonized link', () => {
  const dark = buildThemePalette('#141210');
  assert.equal(dark.text, '#ece6dc');
  assert.match(dark.link, /^#[0-9a-f]{6}$/);
  const light = buildThemePalette('#f7f4ef');
  assert.equal(light.text, '#2a2218');
  assert.notEqual(light.link, dark.link);
});

test('buildThemePalette uses surface color for bg overlay tint', () => {
  const warm = buildThemePalette('#2a1f14');
  const cool = buildThemePalette('#142028');
  assert.equal(warm.bgOverlayColor, warm.surface);
  assert.equal(cool.bgOverlayColor, cool.surface);
  assert.notEqual(warm.bgOverlayColor, cool.bgOverlayColor);
});

test('buildThemePair emits css vars for both modes', () => {
  const pair = buildThemePair(DEFAULT_GLASS_DARK, '#f0ebe3');
  const vars = themePairToCssVars(pair);
  assert.ok(vars.some((v) => v.startsWith('--ui-theme-dark-surface:')));
  assert.ok(vars.some((v) => v.startsWith('--ui-theme-dark-bg-overlay-color:')));
});

test('buildGlassPanelBackground uses the same opacity for dark theme tint', () => {
  const dark = buildGlassPanelBackground('#141210', 40, DEFAULT_GLASS_DARK);
  assert.equal(dark, 'color-mix(in srgb, #141210 40%, transparent)');
});

test('buildGlassPanelBackground softens light-theme fill for perceptual balance', () => {
  const light = buildGlassPanelBackground('#ffdfb3', 88, DEFAULT_GLASS_LIGHT);
  assert.equal(light, 'color-mix(in srgb, #ffdfb3 74%, transparent)');
  assert.equal(effectiveGlassFillOpacity('#ffdfb3', 88), 74);
  assert.equal(effectiveGlassFillOpacity('#141210', 88), 88);
});

test('buildGlassPanelBackground keeps dark theme as simple tint', () => {
  const bg = buildGlassPanelBackground('#141210', 40, DEFAULT_GLASS_DARK);
  assert.equal(bg, 'color-mix(in srgb, #141210 40%, transparent)');
});

test('adjustLightTextForGlassOpacity subtly darkens text without shadow', () => {
  const base = buildThemePalette('#ffdfb3');
  const high = adjustLightTextForGlassOpacity(base, 70);
  const low = adjustLightTextForGlassOpacity(base, 25);
  assert.equal(high.text, base.text);
  assert.notEqual(low.text, base.text);
  assert.ok(relativeLuminance(...hexToRgb(low.text)) < relativeLuminance(...hexToRgb(base.text)));
});

test('fontSizeToCssVars scales typography from base px', () => {
  const vars = fontSizeToCssVars(16);
  assert.ok(vars.includes('--font-size-base:1rem'));
  assert.ok(vars.includes('--font-size-sm:0.875rem'));
  assert.ok(vars.includes('--font-size-lg:1.125rem'));
  assert.equal(fontSizeToCssVars(DEFAULT_FONT_SIZE_PX).includes('--font-size-base:0.875rem'), true);
});
