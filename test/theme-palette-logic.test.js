import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThemePalette,
  contrastRatio,
  ensureContrast,
  isBuiltinSurface,
  THEME_PRESETS,
  LEGACY_SURFACE_DARK,
  LEGACY_SURFACE_LIGHT,
} from '../src/services/theme-engine.js';

const {
  getUiCustomization,
  getThemeCssVars,
  usesPanelGlass,
  resetUiThemeColors,
  resetUiThemeSliders,
  saveUiSettings,
  invalidateUiCustomizationCache,
  getPublicUiSettingsJson,
  getThemePreviewFromDraft,
  detectActiveThemePreset,
} = await import('../src/services/ui-customization.js');
const { initDb, setSetting } = await import('../src/db.js');

before(() => {
  initDb();
});

test('built-in surface keeps the hand-tuned tokens of styles.css', () => {
  const dark = buildThemePalette(LEGACY_SURFACE_DARK);
  assert.equal(dark.text, '#f2ebe0');
  assert.equal(dark.accent, '#c4a35a');
  assert.equal(dark.bg, '#14110e');
  const light = buildThemePalette(LEGACY_SURFACE_LIGHT);
  assert.equal(light.bg, '#f3ebe0');
  assert.equal(light.accent, '#8a6230');
});

test('changing only the accent leaves the rest of the built-in theme alone and links follow it', () => {
  const base = buildThemePalette(LEGACY_SURFACE_DARK);
  const blue = buildThemePalette(LEGACY_SURFACE_DARK, '', '#3b82f6');
  assert.equal(blue.accent, '#3b82f6');
  for (const key of ['text', 'muted', 'bg', 'shellBg', 'surface', 'sidebarBg', 'topbarBg', 'cardCoverBg']) {
    assert.equal(blue[key], base[key], key);
  }
  assert.notEqual(blue.link, base.link);
  assert.ok(contrastRatio(blue.link, blue.surface) >= 4.5);
  assert.match(blue.border, /^rgba\(59, 130, 246,/, 'gold-tinted borders take the new accent');
});

test('old light default #fffdf8 still counts as the built-in light surface', () => {
  assert.equal(isBuiltinSurface('#fffdf8', 'light'), true);
  assert.equal(buildThemePalette('#fffdf8').surface, LEGACY_SURFACE_LIGHT);
});

test('ensureContrast reaches AA and keeps colors that already pass', () => {
  assert.equal(ensureContrast('#ffffff', '#000000'), '#ffffff');
  const fixed = ensureContrast('#d97706', '#fff8eb');
  assert.ok(contrastRatio(fixed, '#fff8eb') >= 4.5);
});

test('every preset gives readable auto text, muted text, links and accent in both modes', () => {
  for (const preset of THEME_PRESETS) {
    for (const mode of ['dark', 'light']) {
      const p = buildThemePalette(preset[mode].surface, '', preset[mode].accent);
      for (const role of ['text', 'muted', 'link', 'accent']) {
        assert.ok(contrastRatio(p[role], p.surface) >= 4.5, `${preset.id} ${mode} ${role}`);
      }
    }
  }
});

test('accent-only change does not turn panels into glass; a custom surface does', () => {
  invalidateUiCustomizationCache();
  resetUiThemeColors();
  resetUiThemeSliders();
  saveUiSettings({ accentAutoDark: false, accentDark: '#3b82f6' });
  assert.equal(usesPanelGlass(), false);
  assert.ok(getThemeCssVars().includes('--ui-theme-dark-bg:#14110e'));
  assert.equal(detectActiveThemePreset(), 'custom');
  saveUiSettings({ glassColorDark: '#222222' });
  assert.equal(usesPanelGlass(), true);
  resetUiThemeColors();
});

test('active preset is detected from saved colors', () => {
  invalidateUiCustomizationCache();
  resetUiThemeColors();
  assert.equal(detectActiveThemePreset(), 'default');
  const nord = THEME_PRESETS.find((p) => p.id === 'nord');
  saveUiSettings({
    glassColorDark: nord.dark.surface,
    glassColorLight: nord.light.surface,
    accentAutoDark: false,
    accentDark: nord.dark.accent,
    accentAutoLight: false,
    accentLight: nord.light.accent,
  });
  assert.equal(getUiCustomization().activePreset, 'nord');
  saveUiSettings({ glassTextAutoDark: false, glassTextDark: '#ffffff' });
  assert.equal(detectActiveThemePreset(), 'custom');
  resetUiThemeColors();
});

test('themeVersion changes with any appearance field Android caches', () => {
  invalidateUiCustomizationCache();
  resetUiThemeSliders();
  const before = getPublicUiSettingsJson().themeVersion;
  saveUiSettings({ surfaceOpacity: 60 });
  const after = getPublicUiSettingsJson().themeVersion;
  assert.notEqual(before, after);
  resetUiThemeSliders();
  assert.equal(getPublicUiSettingsJson().themeVersion, before);
});

test('default app palette for Android equals the built-in web theme', () => {
  invalidateUiCustomizationCache();
  resetUiThemeColors();
  const json = getPublicUiSettingsJson();
  assert.equal(json.appPaletteDark.accent, '#c4a35a');
  assert.equal(json.appPaletteDark.bg, '#14110e');
  assert.equal(json.appPaletteLight.surface, '#fff9f0');
});

test('preview returns the resolved palettes with contrast', () => {
  invalidateUiCustomizationCache();
  resetUiThemeColors();
  setSetting('ui_dynamic_theme_from_bg', '');
  const preview = getThemePreviewFromDraft({ accentAutoLight: '0', accentLight: '#d97706' });
  assert.equal(preview.palettes.light.accent, '#d97706');
  assert.ok(preview.palettes.light.contrast.accent < 4.5, 'manual accent is kept, the badge warns');
  assert.ok(preview.palettes.light.contrast.link >= 4.5, 'auto link is still readable');
  assert.equal(preview.attrs.sliders, false);
});

test('saving default panel sliders does not switch glass panels on', () => {
  invalidateUiCustomizationCache();
  resetUiThemeColors();
  resetUiThemeSliders();
  saveUiSettings({ surfaceOpacity: 88, surfaceBlur: 0 });
  assert.equal(usesPanelGlass(), false);
  setSetting('ui_surface_opacity', '88');
  assert.equal(usesPanelGlass(), false, 'a default stored by older builds is ignored');
  saveUiSettings({ surfaceOpacity: 70 });
  assert.equal(usesPanelGlass(), true);
  resetUiThemeSliders();
});

test('background picture is cropped and grown only while blurred; panel blur off at 0', async () => {
  const { backgroundLayoutToCssVars, panelBackdropCssVar } = await import('../src/services/theme-engine.js');
  const sharp = backgroundLayoutToCssVars('cover', 'center', 0);
  assert.ok(sharp.includes('--ui-bg-transform:none'));
  assert.ok(sharp.includes('--ui-bg-inset:0'));
  const blurred = backgroundLayoutToCssVars('cover', 'center', 8);
  assert.ok(blurred.includes('--ui-bg-transform:scale(1.06)'));
  assert.ok(blurred.includes('--ui-bg-inset:-24px'));
  assert.equal(panelBackdropCssVar(0), '--ui-panel-backdrop:none');
  assert.equal(panelBackdropCssVar(6), '--ui-panel-backdrop:blur(6px)');
});
