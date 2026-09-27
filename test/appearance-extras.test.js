import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThemePalette,
  backgroundLayoutToCssVars,
  customRadiusToCssVars,
  fontSizeToCssVars,
  THEME_PRESETS,
  getThemePresetById,
} from '../src/services/theme-engine.js';

test('buildThemePalette honours an explicit accent override', () => {
  const p = buildThemePalette('#1a1612', '', '#ff0000');
  assert.equal(p.accent, '#ff0000');
  assert.equal(p.accentAuto, false);
  const auto = buildThemePalette('#1a1612');
  assert.equal(auto.accentAuto, true);
});

test('backgroundLayoutToCssVars maps tile to repeat + auto size', () => {
  const tile = backgroundLayoutToCssVars('tile', 'top');
  assert.ok(tile.includes('--ui-bg-size:auto'));
  assert.ok(tile.includes('--ui-bg-repeat:repeat'));
  assert.ok(tile.includes('--ui-bg-position:top'));
  const cover = backgroundLayoutToCssVars('cover', 'center');
  assert.ok(cover.includes('--ui-bg-size:cover'));
  assert.ok(cover.includes('--ui-bg-repeat:no-repeat'));
});

test('customRadiusToCssVars scales from a base pixel value', () => {
  const vars = customRadiusToCssVars(10);
  assert.ok(vars.includes('--radius:10px'));
  assert.ok(vars.includes('--radius-lg:15px'));
});

test('fontSizeToCssVars applies a heading scale to xl/2xl only', () => {
  const base = fontSizeToCssVars(14, 100);
  const scaled = fontSizeToCssVars(14, 150);
  assert.ok(base.includes('--font-size-base:0.875rem'));
  assert.ok(scaled.includes('--font-size-base:0.875rem'));
  const baseXl = base.find((v) => v.startsWith('--font-size-2xl:'));
  const scaledXl = scaled.find((v) => v.startsWith('--font-size-2xl:'));
  assert.notEqual(baseXl, scaledXl);
});

test('theme presets expose default + named palettes', () => {
  assert.ok(THEME_PRESETS.length >= 6);
  assert.equal(getThemePresetById('default')?.dark.surface, '#1a1612');
  assert.ok(getThemePresetById('nord'));
  assert.equal(getThemePresetById('nope'), null);
});
