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
  isDarkSurface,
  paletteContrast,
  paletteInk,
  contrastRatio,
  minContrast,
  ensureContrast,
  onFillColor,
  THEME_PRESETS,
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

test('isDarkSurface splits where white and black text have equal contrast', () => {
  assert.equal(isDarkSurface('#000000'), true);
  assert.equal(isDarkSurface('#1a1612'), true);
  assert.equal(isDarkSurface('#5a5a5a'), true);
  assert.equal(isDarkSurface('#808080'), false);
  assert.equal(isDarkSurface('#b0a090'), false);
  assert.equal(isDarkSurface('#fff9f0'), false);
});

test('buildThemePalette keeps auto text, muted and link at AA on mid-tone surfaces', () => {
  for (const surface of ['#808080', '#6a7f8e', '#9a8c7a', '#b0a090', '#767676', '#777777', '#5e6a72', '#8a5a5a']) {
    const c = paletteContrast(buildThemePalette(surface));
    for (const role of ['text', 'muted', 'link', 'accent']) {
      assert.ok(c[role] >= c.min[role], `${surface} ${role} = ${c[role]}`);
    }
    assert.ok(c.text >= c.muted, `${surface}: muted (${c.muted}) must not beat text (${c.text})`);
  }
});

test('every role passes on the surface, its hover and the page for random surfaces and accents', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const hex = () => `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`;
  for (let i = 0; i < 1500; i += 1) {
    const surface = hex();
    for (const accent of ['', hex()]) {
      const p = buildThemePalette(surface, '', accent);
      const c = paletteContrast(p);
      const ink = paletteInk(p);
      const where = `${surface}/${accent || 'auto'}`;
      for (const role of ['text', 'muted', 'link']) assert.ok(c[role] >= 4.5, `${where} ${role} ${c[role]}`);
      if (!accent) assert.ok(c.accent >= 3, `${where} accent ${c.accent}`);
      assert.ok(minContrast(ink.accentText, [p.surface, p.surfaceHover, p.bg]) >= 4.5, `${where} accentText`);
      assert.ok(contrastRatio(ink.accentOn, p.accent) >= 4.5, `${where} accentOn`);
      assert.ok(contrastRatio(ink.linkOn, p.link) >= 4.5, `${where} linkOn`);
      assert.ok(c.text >= c.muted, `${where} muted beats text`);
    }
  }
});

test('built-in palette keeps its hand-tuned colors; light accent fill gets light ink', () => {
  const dark = buildThemePalette(DEFAULT_GLASS_DARK);
  assert.equal(dark.accent, '#c4a35a');
  assert.equal(dark.sidebarBg, '#12100d');
  assert.deepEqual(paletteInk(dark), { accentText: '#c4a35a', accentOn: '#1a1612', linkOn: '#1a1612' });
  const light = buildThemePalette(DEFAULT_GLASS_LIGHT);
  assert.equal(light.accent, '#8a6230');
  /* #1a1612 on #8a6230 was 3.3:1 (nav badge, active page link in the built-in light theme). */
  assert.equal(paletteInk(light).accentOn, '#fffdf8');
});

test('a custom surface next to the built-in one keeps the built-in structure', () => {
  const p = buildThemePalette('#1a1613');
  assert.notEqual(p.sidebarBg, p.surface);
  assert.match(p.topbarBg, /^rgba\(/);
  assert.match(p.border, /^rgba\(/);
  assert.ok(contrastRatio(p.sidebarBg, '#12100d') < 1.05, `sidebar ${p.sidebarBg}`);
  const l = buildThemePalette('#fff9f1');
  assert.notEqual(l.sidebarBg, l.surface);
  assert.ok(contrastRatio(l.bg, l.surface) > 1.03);
});

test('presets keep the accent fill at 3:1 instead of washing bright accents out to 4.5:1', () => {
  const amber = THEME_PRESETS.find((p) => p.id === 'amber');
  assert.equal(amber.light.accent, '#d97706');
  for (const preset of THEME_PRESETS) {
    for (const mode of ['dark', 'light']) {
      if (!preset[mode].accent) continue;
      assert.ok(contrastRatio(preset[mode].accent, preset[mode].surface) >= 3, `${preset.id} ${mode}`);
    }
  }
});

test('ensureContrast works in OKLCH: keeps the hue family and checks every background', () => {
  const blue = ensureContrast('#5b8cff', '#ffffff');
  assert.ok(contrastRatio(blue, '#ffffff') >= 4.5);
  const [r, , b] = hexToRgb(blue);
  assert.ok(b > r, `still blue: ${blue}`);
  const yellow = ensureContrast('#f5c542', '#fff9f0');
  const [yr, yg, yb] = hexToRgb(yellow);
  assert.ok(yr > yb && yg > yb, `still yellow-ish: ${yellow}`);
  const both = ensureContrast('#a89884', ['#1a1612', '#3a332a']);
  assert.ok(minContrast(both, ['#1a1612', '#3a332a']) >= 4.5);
  assert.ok(contrastRatio(onFillColor('#d97706'), '#d97706') >= 4.5);
});

test('paletteContrast reports per-role minimums for the admin badges', () => {
  const c = paletteContrast(buildThemePalette(DEFAULT_GLASS_DARK));
  assert.deepEqual({ ...c.min }, { text: 4.5, muted: 4.5, link: 4.5, accent: 3 });
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
