import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSharp } from './sharp-loader.js';
import { getSetting, setSetting } from '../db.js';
import {
  DEFAULT_GLASS_DARK,
  DEFAULT_GLASS_LIGHT,
  LEGACY_SURFACE_DARK,
  LEGACY_SURFACE_LIGHT,
  buildThemePair,
  adjustLightTextForGlassOpacity,
  themePairToCssVars,
  deriveGlassTheme,
  normalizeHexColor,
  hexToRgb,
  relativeLuminance,
  radiusPresetToCssVars,
  customRadiusToCssVars,
  shadowPresetToCssVars,
  radiusTokensForPreset,
  shadowTokensForPreset,
  fontSizeToCssVars,
  backgroundLayoutToCssVars,
  DEFAULT_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
  MAX_FONT_SIZE_PX,
  DEFAULT_HEADING_SCALE,
  MIN_HEADING_SCALE,
  MAX_HEADING_SCALE,
  UI_RADIUS_PRESETS,
  MIN_RADIUS_SCALE,
  MAX_RADIUS_SCALE,
  DEFAULT_RADIUS_SCALE,
  BG_SIZE_PRESETS,
  BG_POSITION_PRESETS,
  densityToCssVars,
  fontFamilyToCssVars,
  resolveFontFamilyStack,
  UI_FONT_FAMILY_PRESETS,
  FONT_FAMILY_WEBFONT,
  DISPLAY_FONT_WEBFONT,
  DISPLAY_FONT_STACK,
  THEME_PRESETS,
  getThemePresetById,
} from './theme-engine.js';
import { extractThemeFromImageFile } from './bg-theme-extractor.js';

export {
  DEFAULT_GLASS_DARK,
  DEFAULT_GLASS_LIGHT,
  LEGACY_SURFACE_DARK,
  LEGACY_SURFACE_LIGHT,
  deriveGlassTheme,
  normalizeHexColor,
  hexToRgb,
  relativeLuminance,
  radiusPresetToCssVars,
  customRadiusToCssVars,
  shadowPresetToCssVars,
  fontSizeToCssVars,
  backgroundLayoutToCssVars,
  DEFAULT_FONT_SIZE_PX,
  MIN_FONT_SIZE_PX,
  MAX_FONT_SIZE_PX,
  DEFAULT_HEADING_SCALE,
  MIN_HEADING_SCALE,
  MAX_HEADING_SCALE,
  UI_RADIUS_PRESETS,
  MIN_RADIUS_SCALE,
  MAX_RADIUS_SCALE,
  DEFAULT_RADIUS_SCALE,
  BG_SIZE_PRESETS,
  BG_POSITION_PRESETS,
  densityToCssVars,
  fontFamilyToCssVars,
  resolveFontFamilyStack,
  UI_FONT_FAMILY_PRESETS,
  FONT_FAMILY_WEBFONT,
  DISPLAY_FONT_WEBFONT,
  DISPLAY_FONT_STACK,
  THEME_PRESETS,
  getThemePresetById,
} from './theme-engine.js';

const UI_DIR = path.join(config.dataDir, 'ui');
const BG_OVERLAY_MAX = 80;
const BG_OVERLAY_DEFAULT_STRENGTH = 0;

function bgContrastFromOverlayStrength(strength) {
  return BG_OVERLAY_MAX - strength;
}

function overlayStrengthFromBgContrast(contrast) {
  const value = clampInt(contrast, 0, BG_OVERLAY_MAX, bgContrastFromOverlayStrength(BG_OVERLAY_DEFAULT_STRENGTH));
  return BG_OVERLAY_MAX - value;
}
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FONT_BYTES = 2 * 1024 * 1024;
const VALID_ASSETS = new Set(['logo', 'favicon', 'background', 'font']);
const CUSTOM_FONT_BASENAME = 'custom-font';

const FONT_EXTENSIONS = {
  '.woff2': { mime: 'font/woff2', format: 'woff2' },
  '.woff': { mime: 'font/woff', format: 'woff' },
  '.ttf': { mime: 'font/ttf', format: 'truetype' },
  '.otf': { mime: 'font/otf', format: 'opentype' },
};

const SERVE_MAP = {
  logo: { file: 'logo.png', type: 'image/png' },
  favicon: { file: 'favicon-32.png', type: 'image/png' },
  'favicon-192': { file: 'favicon-192.png', type: 'image/png' },
  background: { file: 'background.webp', type: 'image/webp' },
};

function ensureUiDir() {
  fs.mkdirSync(UI_DIR, { recursive: true });
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function fileMtimeUrl(basePath, fileName) {
  const full = path.join(UI_DIR, fileName);
  try {
    const st = fs.statSync(full);
    return `${basePath}?v=${Math.trunc(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

function sanitizeFontFamilyName(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/["\\]/g, '')
    .replace(/[^\w\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64) || 'Custom Font';
}

function detectFontExtension(buffer, originalName = '') {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (FONT_EXTENSIONS[ext]) return ext;
  if (buffer.length >= 4) {
    const sig = buffer.subarray(0, 4).toString('ascii');
    if (sig === 'wOF2') return '.woff2';
    if (sig === 'wOFF') return '.woff';
    if (sig === 'OTTO') return '.otf';
    if (sig === 'true' || sig === 'typ1') return '.ttf';
    if (buffer.readUInt32BE(0) === 0x00010000) return '.ttf';
  }
  return '';
}

function readCustomFontExt() {
  const ext = getSetting('ui_custom_font_ext');
  return FONT_EXTENSIONS[ext] ? ext : '';
}

function customFontFileName(ext = readCustomFontExt()) {
  return ext ? `${CUSTOM_FONT_BASENAME}${ext}` : '';
}

function removeCustomFontFiles() {
  for (const ext of Object.keys(FONT_EXTENSIONS)) {
    try {
      fs.unlinkSync(path.join(UI_DIR, `${CUSTOM_FONT_BASENAME}${ext}`));
    } catch {
      /* ignore missing */
    }
  }
}

function readFontFamilySetting() {
  const raw = getSetting('ui_font_family');
  return UI_FONT_FAMILY_PRESETS.includes(raw) ? raw : (raw === '' ? 'inter' : 'inter');
}

function legacyFontSizeFromScale() {
  const legacy = getSetting('ui_font_scale');
  if (legacy === 'small') return 13;
  if (legacy === 'large') return 16;
  return DEFAULT_FONT_SIZE_PX;
}

function readFontSizeSetting() {
  const raw = getSetting('ui_font_size');
  if (raw !== '') return clampInt(raw, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX, DEFAULT_FONT_SIZE_PX);
  return legacyFontSizeFromScale();
}

function isFontSizeCustomized() {
  if (getSetting('ui_font_size') !== '') return true;
  const legacy = getSetting('ui_font_scale');
  return legacy === 'small' || legacy === 'large';
}

function readHeadingScale() {
  const raw = getSetting('ui_heading_scale');
  if (raw === '') return DEFAULT_HEADING_SCALE;
  return clampInt(raw, MIN_HEADING_SCALE, MAX_HEADING_SCALE, DEFAULT_HEADING_SCALE);
}

function isHeadingScaleCustomized() {
  const raw = getSetting('ui_heading_scale');
  return raw !== '' && clampInt(raw, MIN_HEADING_SCALE, MAX_HEADING_SCALE, DEFAULT_HEADING_SCALE) !== DEFAULT_HEADING_SCALE;
}

function readRadiusPreset() {
  const raw = getSetting('ui_radius_preset');
  return UI_RADIUS_PRESETS.includes(raw) ? raw : 'rounded';
}

function readRadiusScale() {
  const raw = getSetting('ui_radius_scale');
  if (raw === '') return DEFAULT_RADIUS_SCALE;
  return clampInt(raw, MIN_RADIUS_SCALE, MAX_RADIUS_SCALE, DEFAULT_RADIUS_SCALE);
}

function readBgSize() {
  const raw = getSetting('ui_bg_size');
  return BG_SIZE_PRESETS.includes(raw) ? raw : 'cover';
}

function readBgPosition() {
  const raw = getSetting('ui_bg_position');
  return BG_POSITION_PRESETS.includes(raw) ? raw : 'center';
}

function hasCustomFontFile() {
  return Boolean(readCustomFontExt() && fs.existsSync(path.join(UI_DIR, customFontFileName())));
}

/** Совместимость: раньше был in-process кэш, теперь читаем файлы с диска каждый раз. */
export function invalidateUiCustomizationCache() {}

function readSurfaceOpacity() {
  const unifiedRaw = getSetting('ui_surface_opacity');
  if (unifiedRaw !== '') return clampInt(unifiedRaw, 0, 100, 88);
  for (const key of ['ui_panel_opacity', 'ui_topbar_opacity', 'ui_sidebar_opacity']) {
    const raw = getSetting(key);
    if (raw !== '') return clampInt(raw, 0, 100, 88);
  }
  return 88;
}

function resolveThemeSurface(mode, glassColorFromForm) {
  const isDark = mode === 'dark';
  const fallback = isDark ? LEGACY_SURFACE_DARK : LEGACY_SURFACE_LIGHT;
  if (hasUiDynamicThemeFromBg() && hasExtractedBgPalette()) {
    const key = isDark ? 'ui_bg_palette_dark' : 'ui_bg_palette_light';
    return normalizeHexColor(getSetting(key), fallback);
  }
  if (glassColorFromForm !== undefined && glassColorFromForm !== '') {
    return normalizeHexColor(glassColorFromForm, fallback);
  }
  const raw = getSetting(isDark ? 'ui_glass_color_dark' : 'ui_glass_color_light');
  return normalizeHexColor(raw || fallback, fallback);
}

function clearManualGlassSurfaceColors() {
  setSetting('ui_glass_color_dark', '');
  setSetting('ui_glass_color_light', '');
}

function clearExtractedBgPalette() {
  setSetting('ui_bg_palette_dark', '');
  setSetting('ui_bg_palette_light', '');
}

export function hasUiDynamicThemeFromBg() {
  return getSetting('ui_dynamic_theme_from_bg') === '1';
}

export function hasExtractedBgPalette() {
  return getSetting('ui_bg_palette_dark') !== '' && getSetting('ui_bg_palette_light') !== '';
}

function clearManualGlassTypographyColors() {
  setSetting('ui_glass_text_dark', '');
  setSetting('ui_glass_text_light', '');
  setSetting('ui_glass_muted_dark', '');
  setSetting('ui_glass_muted_light', '');
  setSetting('ui_glass_link_dark', '');
  setSetting('ui_glass_link_light', '');
}

export async function refreshBgThemePaletteFromFile({ resetTypography = false } = {}) {
  ensureUiDir();
  const filePath = path.join(UI_DIR, 'background.webp');
  if (!fs.existsSync(filePath)) throw new Error('admin.ui.errorNoBackground');
  const palette = await extractThemeFromImageFile(filePath);
  if (!palette) throw new Error('admin.ui.errorSharpUnavailable');
  setSetting('ui_bg_palette_dark', palette.darkSurface);
  setSetting('ui_bg_palette_light', palette.lightSurface);
  if (resetTypography) clearManualGlassTypographyColors();
  invalidateUiCustomizationCache();
  return palette;
}

/** Re-sample palette from background file and enable dynamic theme (admin action). */
export async function refreshBgThemePaletteForAdmin() {
  if (!hasUiBackgroundImage()) throw new Error('admin.ui.errorNoBackground');
  setSetting('ui_dynamic_theme_from_bg', '1');
  return refreshBgThemePaletteFromFile();
}

/** Saved appearance theme settings (independent of custom background image). */
export function hasUiThemeConfigured() {
  return hasUiThemeColorsConfigured() || hasUiThemeSlidersConfigured();
}

export function hasUiThemeColorsConfigured() {
  if (hasUiDynamicThemeFromBg() && hasExtractedBgPalette()) return true;
  const textDark = getSetting('ui_glass_text_dark');
  const textLight = getSetting('ui_glass_text_light');
  if (textDark !== '' || textLight !== '') return true;
  const mutedDark = getSetting('ui_glass_muted_dark');
  const mutedLight = getSetting('ui_glass_muted_light');
  if (mutedDark !== '' || mutedLight !== '') return true;
  const linkDark = getSetting('ui_glass_link_dark');
  const linkLight = getSetting('ui_glass_link_light');
  if (linkDark !== '' || linkLight !== '') return true;
  const accentDark = getSetting('ui_accent_dark');
  const accentLight = getSetting('ui_accent_light');
  if (accentDark !== '' || accentLight !== '') return true;
  const overlayDark = getSetting('ui_bg_overlay_color_dark');
  const overlayLight = getSetting('ui_bg_overlay_color_light');
  if (overlayDark !== '' || overlayLight !== '') return true;
  const dark = getSetting('ui_glass_color_dark');
  const light = getSetting('ui_glass_color_light');
  if (dark !== '' && normalizeHexColor(dark, LEGACY_SURFACE_DARK) !== LEGACY_SURFACE_DARK) return true;
  if (light !== '' && normalizeHexColor(light, LEGACY_SURFACE_LIGHT) !== LEGACY_SURFACE_LIGHT) return true;
  return false;
}

const UI_BACKGROUND_SLIDER_KEYS = ['ui_bg_blur', 'ui_bg_overlay', 'ui_bg_size', 'ui_bg_position'];
const UI_PANEL_SLIDER_KEYS = [
  'ui_surface_opacity',
  'ui_surface_blur',
  'ui_panel_opacity',
  'ui_topbar_opacity',
  'ui_sidebar_opacity',
];

export function hasUiBackgroundSlidersConfigured() {
  return UI_BACKGROUND_SLIDER_KEYS.some((key) => getSetting(key) !== '');
}

export function hasUiPanelSlidersConfigured() {
  return UI_PANEL_SLIDER_KEYS.some((key) => getSetting(key) !== '');
}

export function hasUiThemeSlidersConfigured() {
  return hasUiBackgroundSlidersConfigured() || hasUiPanelSlidersConfigured();
}

/** Panel glass (opacity/blur) — needed with custom colors, custom panel sliders, or a background image. */
export function hasUiBackgroundImage() {
  ensureUiDir();
  return fs.existsSync(path.join(UI_DIR, 'background.webp'));
}

export function usesPanelGlass() {
  return hasUiPanelSlidersConfigured() || hasUiThemeColorsConfigured() || hasUiBackgroundImage();
}

export function hasUiThemeShapeConfigured() {
  const keys = ['ui_radius_preset', 'ui_shadow_preset', 'ui_radius_scale'];
  return keys.some((key) => getSetting(key) !== '');
}

export function hasUiThemeTypographyConfigured() {
  if (isFontSizeCustomized()) return true;
  if (isHeadingScaleCustomized()) return true;
  if (getSetting('ui_density') !== '') return true;
  if (getSetting('ui_font_family') !== '') return true;
  return hasCustomFontFile();
}

export function resetUiThemeColors() {
  setSetting('ui_dynamic_theme_from_bg', '');
  clearExtractedBgPalette();
  setSetting('ui_glass_color_dark', '');
  setSetting('ui_glass_color_light', '');
  setSetting('ui_accent_dark', '');
  setSetting('ui_accent_light', '');
  setSetting('ui_bg_overlay_color_dark', '');
  setSetting('ui_bg_overlay_color_light', '');
  clearManualGlassTypographyColors();
  invalidateUiCustomizationCache();
}

function deriveLinkHover(linkHex, surfaceHex) {
  const isDark = relativeLuminance(...hexToRgb(surfaceHex)) < 0.45;
  const [r, g, b] = hexToRgb(linkHex);
  const shift = isDark ? 18 : -14;
  const clamp = (v) => Math.min(255, Math.max(0, v + shift));
  return normalizeHexColor(
    `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
    linkHex,
  );
}

function applyGlassPaletteOverrides(palette, { mutedRaw, linkRaw }) {
  if (mutedRaw) {
    palette.muted = normalizeHexColor(mutedRaw, palette.muted);
  }
  if (linkRaw) {
    palette.link = normalizeHexColor(linkRaw, palette.link);
    palette.linkHover = deriveLinkHover(palette.link, palette.surface);
  }
}

export function resetUiThemeSliders() {
  for (const key of [
    'ui_bg_blur',
    'ui_bg_overlay',
    'ui_bg_size',
    'ui_bg_position',
    'ui_surface_opacity',
    'ui_surface_blur',
    'ui_panel_opacity',
    'ui_topbar_opacity',
    'ui_sidebar_opacity',
  ]) {
    setSetting(key, '');
  }
  invalidateUiCustomizationCache();
}

export function resetUiThemeShape() {
  setSetting('ui_radius_preset', '');
  setSetting('ui_shadow_preset', '');
  setSetting('ui_radius_scale', '');
  invalidateUiCustomizationCache();
}

export function resetUiThemeTypography() {
  setSetting('ui_font_size', '');
  setSetting('ui_font_scale', '');
  setSetting('ui_heading_scale', '');
  setSetting('ui_density', '');
  setSetting('ui_font_family', '');
  setSetting('ui_custom_font_name', '');
  setSetting('ui_custom_font_ext', '');
  ensureUiDir();
  removeCustomFontFiles();
  invalidateUiCustomizationCache();
}

export function getUiCustomization() {
  ensureUiDir();
  const blurRaw = getSetting('ui_bg_blur');
  const overlayRaw = getSetting('ui_bg_overlay');
  const blur = blurRaw === '' ? 0 : clampInt(blurRaw, 0, 24, 0);
  const overlay = overlayRaw === '' ? BG_OVERLAY_DEFAULT_STRENGTH : clampInt(overlayRaw, 0, BG_OVERLAY_MAX, BG_OVERLAY_DEFAULT_STRENGTH);
  const bgContrast = bgContrastFromOverlayStrength(overlay);
  const surfaceOpacity = readSurfaceOpacity();
  const surfaceBlurRaw = getSetting('ui_surface_blur');
  const surfaceBlur = surfaceBlurRaw === '' ? 0 : clampInt(surfaceBlurRaw, 0, 24, 0);
  const showLogoOnLogin = getSetting('ui_show_logo_login') !== '0';
  const radiusPreset = getSetting('ui_radius_preset') || 'rounded';
  const shadowPreset = getSetting('ui_shadow_preset') || 'normal';
  const fontSize = readFontSizeSetting();
  const density = getSetting('ui_density') || 'normal';
  let fontFamily = readFontFamilySetting();
  const customFontExt = readCustomFontExt();
  const customFontName = getSetting('ui_custom_font_name') || 'Custom Font';
  const customFontFile = customFontFileName(customFontExt);
  const customFontUrl = customFontFile ? fileMtimeUrl('/custom/ui/font', customFontFile) : null;
  if (fontFamily === 'custom' && !customFontUrl) fontFamily = 'inter';
  const glassColorDarkRaw = getSetting('ui_glass_color_dark');
  const glassColorLightRaw = getSetting('ui_glass_color_light');
  const glassTextDarkRaw = getSetting('ui_glass_text_dark');
  const glassTextLightRaw = getSetting('ui_glass_text_light');
  const glassMutedDarkRaw = getSetting('ui_glass_muted_dark');
  const glassMutedLightRaw = getSetting('ui_glass_muted_light');
  const glassLinkDarkRaw = getSetting('ui_glass_link_dark');
  const glassLinkLightRaw = getSetting('ui_glass_link_light');
  const accentDarkRaw = getSetting('ui_accent_dark');
  const accentLightRaw = getSetting('ui_accent_light');
  const overlayColorDarkRaw = getSetting('ui_bg_overlay_color_dark');
  const overlayColorLightRaw = getSetting('ui_bg_overlay_color_light');
  const bgSize = readBgSize();
  const bgPosition = readBgPosition();
  const headingScale = readHeadingScale();
  const radiusScale = readRadiusScale();
  const dynamicThemeFromBg = hasUiDynamicThemeFromBg() && hasExtractedBgPalette();
  const paletteDarkRaw = getSetting('ui_bg_palette_dark');
  const paletteLightRaw = getSetting('ui_bg_palette_light');
  let displayDark;
  let displayLight;
  if (dynamicThemeFromBg) {
    displayDark = normalizeHexColor(paletteDarkRaw, LEGACY_SURFACE_DARK);
    displayLight = normalizeHexColor(paletteLightRaw, LEGACY_SURFACE_LIGHT);
  } else {
    displayDark = glassColorDarkRaw
      ? normalizeHexColor(glassColorDarkRaw, LEGACY_SURFACE_DARK)
      : LEGACY_SURFACE_DARK;
    displayLight = glassColorLightRaw
      ? normalizeHexColor(glassColorLightRaw, LEGACY_SURFACE_LIGHT)
      : LEGACY_SURFACE_LIGHT;
  }
  const themePair = buildThemePair(
    displayDark,
    displayLight,
    glassTextDarkRaw,
    glassTextLightRaw,
    accentDarkRaw,
    accentLightRaw,
  );
  if (hasUiThemeColorsConfigured() && !glassTextLightRaw) {
    themePair.light = adjustLightTextForGlassOpacity(themePair.light, surfaceOpacity);
  }
  applyGlassPaletteOverrides(themePair.dark, { mutedRaw: glassMutedDarkRaw, linkRaw: glassLinkDarkRaw });
  applyGlassPaletteOverrides(themePair.light, { mutedRaw: glassMutedLightRaw, linkRaw: glassLinkLightRaw });
  if (overlayColorDarkRaw) themePair.dark.bgOverlayColor = normalizeHexColor(overlayColorDarkRaw, themePair.dark.bgOverlayColor);
  if (overlayColorLightRaw) themePair.light.bgOverlayColor = normalizeHexColor(overlayColorLightRaw, themePair.light.bgOverlayColor);
  const logoUrl = fileMtimeUrl('/custom/ui/logo', 'logo.png');
  const faviconUrl = fileMtimeUrl('/custom/ui/favicon', 'favicon-32.png');
  const faviconAppleUrl = fileMtimeUrl('/custom/ui/favicon-192', 'favicon-192.png');
  const backgroundUrl = fileMtimeUrl('/custom/ui/background', 'background.webp');
  return {
    blur,
    overlay,
    bgContrast,
    surfaceOpacity,
    surfaceBlur,
    showLogoOnLogin,
    glassColorDark: themePair.dark.surface,
    glassColorLight: themePair.light.surface,
    glassTextDark: themePair.dark.text,
    glassTextLight: themePair.light.text,
    glassMutedDark: themePair.dark.muted,
    glassMutedLight: themePair.light.muted,
    glassLinkDark: themePair.dark.link,
    glassLinkLight: themePair.light.link,
    glassAccentDark: themePair.dark.accent,
    glassAccentLight: themePair.light.accent,
    glassTextAutoDark: themePair.dark.textAuto,
    glassTextAutoLight: themePair.light.textAuto,
    glassMutedAutoDark: glassMutedDarkRaw === '',
    glassMutedAutoLight: glassMutedLightRaw === '',
    glassLinkAutoDark: glassLinkDarkRaw === '',
    glassLinkAutoLight: glassLinkLightRaw === '',
    glassAccentAutoDark: accentDarkRaw === '',
    glassAccentAutoLight: accentLightRaw === '',
    overlayColorDark: themePair.dark.bgOverlayColor,
    overlayColorLight: themePair.light.bgOverlayColor,
    overlayColorAutoDark: overlayColorDarkRaw === '',
    overlayColorAutoLight: overlayColorLightRaw === '',
    bgSize,
    bgPosition,
    headingScale,
    radiusScale,
    themePair,
    logoUrl,
    faviconUrl,
    faviconAppleUrl,
    backgroundUrl,
    hasBackground: Boolean(backgroundUrl),
    hasLogo: Boolean(logoUrl),
    radiusPreset,
    shadowPreset,
    fontSize,
    density,
    fontFamily,
    customFontName,
    customFontUrl,
    customFontFormat: FONT_EXTENSIONS[customFontExt]?.format || '',
    hasCustomFont: Boolean(customFontUrl),
    hasCustomThemeColors: hasUiThemeColorsConfigured(),
    hasCustomThemeSliders: hasUiThemeSlidersConfigured(),
    hasCustomThemeShape: hasUiThemeShapeConfigured(),
    hasCustomThemeTypography: hasUiThemeTypographyConfigured(),
    dynamicThemeFromBg,
    hasExtractedBgPalette: hasExtractedBgPalette(),
  };
}

export function getThemeCssVars() {
  const ui = getUiCustomization();
  const colors = hasUiThemeColorsConfigured();
  const panelGlass = usesPanelGlass();
  const shape = hasUiThemeShapeConfigured();
  const typography = hasUiThemeTypographyConfigured();
  if (!colors && !panelGlass && !ui.hasBackground && !shape && !typography) return [];
  const vars = [];
  if (colors) {
    vars.push(...themePairToCssVars(ui.themePair));
  } else if (ui.hasBackground) {
    vars.push(
      `--ui-theme-dark-bg-overlay-color:${ui.themePair.dark.bgOverlayColor}`,
      `--ui-theme-light-bg-overlay-color:${ui.themePair.light.bgOverlayColor}`,
    );
  }
  if (panelGlass) {
    vars.push(
      `--ui-surface-opacity:${ui.surfaceOpacity}`,
      `--ui-surface-blur:${ui.surfaceBlur}px`,
    );
  }
  if (ui.hasBackground) {
    vars.push(
      `--ui-bg-image:url("${ui.backgroundUrl}")`,
      `--ui-bg-blur:${ui.blur}px`,
      `--ui-bg-overlay:${ui.overlay}`,
      ...backgroundLayoutToCssVars(ui.bgSize, ui.bgPosition),
    );
  }
  if (shape) {
    vars.push(...(ui.radiusPreset === 'custom'
      ? customRadiusToCssVars(ui.radiusScale)
      : radiusPresetToCssVars(ui.radiusPreset)));
    vars.push(...shadowPresetToCssVars(ui.shadowPreset));
  }
  if (typography) {
    vars.push(...fontSizeToCssVars(ui.fontSize, ui.headingScale));
    vars.push(...densityToCssVars(ui.density));
  }
  if (ui.fontFamily !== 'inter') {
    vars.push(...fontFamilyToCssVars(ui.fontFamily, ui.customFontName));
  }
  return vars;
}

// ── Live preview (admin appearance) ──
function draftStr(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const v = Array.isArray(value) ? value[value.length - 1] : value;
  return String(v);
}

function draftFlag(value) {
  const s = draftStr(value, '').toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function draftAutoFlag(draft, key, savedAuto) {
  if (draft[key] !== undefined && draft[key] !== null) return draftFlag(draft[key]);
  return savedAuto;
}

/** Manual glass color from draft, or saved value when the field is omitted (e.g. disabled inputs). */
function draftManualColor(draft, colorKey, autoKey, savedAuto, savedColor) {
  if (draftAutoFlag(draft, autoKey, savedAuto)) return '';
  return draftStr(draft[colorKey], savedColor);
}

/**
 * Compute theme CSS variables + root attributes from an unsaved draft form payload.
 * Reused by POST /api/admin/ui/preview so the admin sees changes live before saving.
 * Never writes settings; falls back to saved state for background image / custom font.
 */
export function getThemePreviewFromDraft(draft = {}) {
  const saved = getUiCustomization();
  const hasBg = saved.hasBackground;

  const dyn = draft.dynamicThemeFromBg !== undefined
    ? draftFlag(draft.dynamicThemeFromBg)
    : saved.dynamicThemeFromBg;
  const useExtractedPalette = dyn && hasExtractedBgPalette();

  let darkSurface;
  let lightSurface;
  if (useExtractedPalette) {
    darkSurface = normalizeHexColor(getSetting('ui_bg_palette_dark'), LEGACY_SURFACE_DARK);
    lightSurface = normalizeHexColor(getSetting('ui_bg_palette_light'), LEGACY_SURFACE_LIGHT);
  } else {
    darkSurface = normalizeHexColor(draftStr(draft.glassColorDark, saved.glassColorDark), LEGACY_SURFACE_DARK);
    lightSurface = normalizeHexColor(draftStr(draft.glassColorLight, saved.glassColorLight), LEGACY_SURFACE_LIGHT);
  }

  const textDark = draftManualColor(
    draft, 'glassTextDark', 'glassTextAutoDark', saved.glassTextAutoDark, saved.glassTextDark,
  );
  const textLight = draftManualColor(
    draft, 'glassTextLight', 'glassTextAutoLight', saved.glassTextAutoLight, saved.glassTextLight,
  );
  const accentDark = draftManualColor(
    draft, 'accentDark', 'accentAutoDark', saved.glassAccentAutoDark, saved.glassAccentDark,
  );
  const accentLight = draftManualColor(
    draft, 'accentLight', 'accentAutoLight', saved.glassAccentAutoLight, saved.glassAccentLight,
  );

  const surfaceOpacity = clampInt(draftStr(draft.surfaceOpacity, String(saved.surfaceOpacity)), 0, 100, 88);

  const themePair = buildThemePair(darkSurface, lightSurface, textDark, textLight, accentDark, accentLight);
  if (!textLight) themePair.light = adjustLightTextForGlassOpacity(themePair.light, surfaceOpacity);

  const mutedDark = draftManualColor(
    draft, 'glassMutedDark', 'glassMutedAutoDark', saved.glassMutedAutoDark, saved.glassMutedDark,
  );
  const mutedLight = draftManualColor(
    draft, 'glassMutedLight', 'glassMutedAutoLight', saved.glassMutedAutoLight, saved.glassMutedLight,
  );
  const linkDark = draftManualColor(
    draft, 'glassLinkDark', 'glassLinkAutoDark', saved.glassLinkAutoDark, saved.glassLinkDark,
  );
  const linkLight = draftManualColor(
    draft, 'glassLinkLight', 'glassLinkAutoLight', saved.glassLinkAutoLight, saved.glassLinkLight,
  );
  applyGlassPaletteOverrides(themePair.dark, { mutedRaw: mutedDark, linkRaw: linkDark });
  applyGlassPaletteOverrides(themePair.light, { mutedRaw: mutedLight, linkRaw: linkLight });

  const overlayColorDark = draftManualColor(
    draft, 'overlayColorDark', 'overlayColorAutoDark', saved.overlayColorAutoDark, saved.overlayColorDark,
  );
  const overlayColorLight = draftManualColor(
    draft, 'overlayColorLight', 'overlayColorAutoLight', saved.overlayColorAutoLight, saved.overlayColorLight,
  );
  if (overlayColorDark) themePair.dark.bgOverlayColor = normalizeHexColor(overlayColorDark, themePair.dark.bgOverlayColor);
  if (overlayColorLight) themePair.light.bgOverlayColor = normalizeHexColor(overlayColorLight, themePair.light.bgOverlayColor);

  const vars = [...themePairToCssVars(themePair)];

  vars.push(
    `--ui-surface-opacity:${surfaceOpacity}`,
    `--ui-surface-blur:${clampInt(draftStr(draft.surfaceBlur, String(saved.surfaceBlur)), 0, 24, 0)}px`,
  );

  if (hasBg) {
    const blur = clampInt(draftStr(draft.bgBlur, String(saved.blur)), 0, 24, 0);
    const bgContrast = clampInt(draftStr(draft.bgOverlay, String(saved.bgContrast)), 0, BG_OVERLAY_MAX, BG_OVERLAY_MAX);
    const overlay = BG_OVERLAY_MAX - bgContrast;
    const bgSize = draftStr(draft.bgSize, saved.bgSize);
    const bgPosition = draftStr(draft.bgPosition, saved.bgPosition);
    vars.push(
      `--ui-bg-image:url("${saved.backgroundUrl}")`,
      `--ui-bg-blur:${blur}px`,
      `--ui-bg-overlay:${overlay}`,
      ...backgroundLayoutToCssVars(bgSize, bgPosition),
    );
  }

  const radiusPreset = UI_RADIUS_PRESETS.includes(draftStr(draft.radiusPreset)) ? draftStr(draft.radiusPreset) : saved.radiusPreset;
  const radiusScale = clampInt(draftStr(draft.radiusScale, String(saved.radiusScale)), MIN_RADIUS_SCALE, MAX_RADIUS_SCALE, DEFAULT_RADIUS_SCALE);
  vars.push(...(radiusPreset === 'custom' ? customRadiusToCssVars(radiusScale) : radiusPresetToCssVars(radiusPreset)));
  const shadowPreset = draftStr(draft.shadowPreset, saved.shadowPreset);
  vars.push(...shadowPresetToCssVars(shadowPreset));

  const fontSize = clampInt(draftStr(draft.fontSize, String(saved.fontSize)), MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX, DEFAULT_FONT_SIZE_PX);
  const headingScale = clampInt(draftStr(draft.headingScale, String(saved.headingScale)), MIN_HEADING_SCALE, MAX_HEADING_SCALE, DEFAULT_HEADING_SCALE);
  vars.push(...fontSizeToCssVars(fontSize, headingScale));
  const density = draftStr(draft.density, saved.density);
  vars.push(...densityToCssVars(density));
  let fontFamily = draftStr(draft.fontFamily, saved.fontFamily);
  if (!UI_FONT_FAMILY_PRESETS.includes(fontFamily)) fontFamily = 'inter';
  if (fontFamily === 'custom' && !saved.hasCustomFont) fontFamily = 'inter';
  vars.push(...fontFamilyToCssVars(fontFamily, saved.customFontName));

  const webfont = FONT_FAMILY_WEBFONT[fontFamily] || '';

  // Live preview always injects full theme vars — enable matching root attrs so CSS mappings apply.
  return {
    vars,
    attrs: {
      theme: true,
      sliders: true,
      bg: hasBg,
      shape: true,
      typography: true,
    },
    webfont,
    fontFamily,
  };
}

export function saveUiSettings({
  bgBlur,
  bgOverlay,
  surfaceOpacity,
  surfaceBlur,
  glassColorDark,
  glassColorLight,
  glassTextDark,
  glassTextLight,
  glassTextAutoDark,
  glassTextAutoLight,
  glassMutedDark,
  glassMutedLight,
  glassMutedAutoDark,
  glassMutedAutoLight,
  glassLinkDark,
  glassLinkLight,
  glassLinkAutoDark,
  glassLinkAutoLight,
  accentDark,
  accentLight,
  accentAutoDark,
  accentAutoLight,
  overlayColorDark,
  overlayColorLight,
  overlayColorAutoDark,
  overlayColorAutoLight,
  bgSize,
  bgPosition,
  showLogoOnLogin,
  dynamicThemeFromBg,
} = {}) {
  if (dynamicThemeFromBg !== undefined) {
    const enabled = dynamicThemeFromBg === true || dynamicThemeFromBg === '1' || dynamicThemeFromBg === 1;
    setSetting('ui_dynamic_theme_from_bg', enabled ? '1' : '0');
    if (enabled) clearManualGlassSurfaceColors();
  }
  const dynamicActive = getSetting('ui_dynamic_theme_from_bg') === '1';
  if (bgBlur !== undefined) {
    setSetting('ui_bg_blur', String(clampInt(bgBlur, 0, 24, 0)));
  }
  if (bgOverlay !== undefined) {
    setSetting('ui_bg_overlay', String(overlayStrengthFromBgContrast(bgOverlay)));
  }
  if (surfaceOpacity !== undefined) {
    setSetting('ui_surface_opacity', String(clampInt(surfaceOpacity, 0, 100, 88)));
  }
  if (surfaceBlur !== undefined) {
    setSetting('ui_surface_blur', String(clampInt(surfaceBlur, 0, 24, 0)));
  }
  if (!dynamicActive && glassColorDark !== undefined) {
    const palette = buildThemePair(glassColorDark, DEFAULT_GLASS_LIGHT).dark;
    setSetting('ui_glass_color_dark', palette.surface);
  }
  if (!dynamicActive && glassColorLight !== undefined) {
    const palette = buildThemePair(DEFAULT_GLASS_DARK, glassColorLight).light;
    setSetting('ui_glass_color_light', palette.surface);
  }
  if (glassTextAutoDark !== undefined || glassTextDark !== undefined) {
    const auto = glassTextAutoDark === true || glassTextAutoDark === '1' || glassTextAutoDark === 1;
    if (auto) {
      setSetting('ui_glass_text_dark', '');
    } else if (glassTextDark !== undefined) {
      const surface = resolveThemeSurface('dark', dynamicActive ? undefined : glassColorDark);
      const palette = buildThemePair(surface, DEFAULT_GLASS_LIGHT, glassTextDark, '');
      setSetting('ui_glass_text_dark', palette.dark.text);
    }
  }
  if (glassTextAutoLight !== undefined || glassTextLight !== undefined) {
    const auto = glassTextAutoLight === true || glassTextAutoLight === '1' || glassTextAutoLight === 1;
    if (auto) {
      setSetting('ui_glass_text_light', '');
    } else if (glassTextLight !== undefined) {
      const surface = resolveThemeSurface('light', dynamicActive ? undefined : glassColorLight);
      const palette = buildThemePair(DEFAULT_GLASS_DARK, surface, '', glassTextLight);
      setSetting('ui_glass_text_light', palette.light.text);
    }
  }
  if (glassMutedAutoDark !== undefined || glassMutedDark !== undefined) {
    const auto = glassMutedAutoDark === true || glassMutedAutoDark === '1' || glassMutedAutoDark === 1;
    if (auto) setSetting('ui_glass_muted_dark', '');
    else if (glassMutedDark !== undefined) {
      setSetting('ui_glass_muted_dark', normalizeHexColor(glassMutedDark, ''));
    }
  }
  if (glassMutedAutoLight !== undefined || glassMutedLight !== undefined) {
    const auto = glassMutedAutoLight === true || glassMutedAutoLight === '1' || glassMutedAutoLight === 1;
    if (auto) setSetting('ui_glass_muted_light', '');
    else if (glassMutedLight !== undefined) {
      setSetting('ui_glass_muted_light', normalizeHexColor(glassMutedLight, ''));
    }
  }
  if (glassLinkAutoDark !== undefined || glassLinkDark !== undefined) {
    const auto = glassLinkAutoDark === true || glassLinkAutoDark === '1' || glassLinkAutoDark === 1;
    if (auto) setSetting('ui_glass_link_dark', '');
    else if (glassLinkDark !== undefined) {
      setSetting('ui_glass_link_dark', normalizeHexColor(glassLinkDark, ''));
    }
  }
  if (glassLinkAutoLight !== undefined || glassLinkLight !== undefined) {
    const auto = glassLinkAutoLight === true || glassLinkAutoLight === '1' || glassLinkAutoLight === 1;
    if (auto) setSetting('ui_glass_link_light', '');
    else if (glassLinkLight !== undefined) {
      setSetting('ui_glass_link_light', normalizeHexColor(glassLinkLight, ''));
    }
  }
  if (accentAutoDark !== undefined || accentDark !== undefined) {
    const auto = accentAutoDark === true || accentAutoDark === '1' || accentAutoDark === 1;
    if (auto) setSetting('ui_accent_dark', '');
    else if (accentDark !== undefined) setSetting('ui_accent_dark', normalizeHexColor(accentDark, ''));
  }
  if (accentAutoLight !== undefined || accentLight !== undefined) {
    const auto = accentAutoLight === true || accentAutoLight === '1' || accentAutoLight === 1;
    if (auto) setSetting('ui_accent_light', '');
    else if (accentLight !== undefined) setSetting('ui_accent_light', normalizeHexColor(accentLight, ''));
  }
  if (overlayColorAutoDark !== undefined || overlayColorDark !== undefined) {
    const auto = overlayColorAutoDark === true || overlayColorAutoDark === '1' || overlayColorAutoDark === 1;
    if (auto) setSetting('ui_bg_overlay_color_dark', '');
    else if (overlayColorDark !== undefined) setSetting('ui_bg_overlay_color_dark', normalizeHexColor(overlayColorDark, ''));
  }
  if (overlayColorAutoLight !== undefined || overlayColorLight !== undefined) {
    const auto = overlayColorAutoLight === true || overlayColorAutoLight === '1' || overlayColorAutoLight === 1;
    if (auto) setSetting('ui_bg_overlay_color_light', '');
    else if (overlayColorLight !== undefined) setSetting('ui_bg_overlay_color_light', normalizeHexColor(overlayColorLight, ''));
  }
  if (bgSize !== undefined) {
    setSetting('ui_bg_size', BG_SIZE_PRESETS.includes(bgSize) && bgSize !== 'cover' ? bgSize : '');
  }
  if (bgPosition !== undefined) {
    setSetting('ui_bg_position', BG_POSITION_PRESETS.includes(bgPosition) && bgPosition !== 'center' ? bgPosition : '');
  }
  if (showLogoOnLogin !== undefined) {
    setSetting('ui_show_logo_login', showLogoOnLogin ? '1' : '0');
  }
  invalidateUiCustomizationCache();
}

export function saveUiShapeSettings({
  radiusPreset,
  radiusScale,
  shadowPreset,
} = {}) {
  if (radiusPreset !== undefined) {
    const valid = UI_RADIUS_PRESETS.includes(radiusPreset) ? radiusPreset : '';
    setSetting('ui_radius_preset', valid);
  }
  if (radiusScale !== undefined) {
    const scale = clampInt(radiusScale, MIN_RADIUS_SCALE, MAX_RADIUS_SCALE, DEFAULT_RADIUS_SCALE);
    setSetting('ui_radius_scale', String(scale));
  }
  if (shadowPreset !== undefined) {
    const valid = ['none', 'subtle', 'normal', 'pronounced'].includes(shadowPreset) ? shadowPreset : '';
    setSetting('ui_shadow_preset', valid);
  }
  invalidateUiCustomizationCache();
}

export function saveUiTypographySettings({
  fontSize,
  headingScale,
  density,
  fontFamily,
} = {}) {
  if (fontSize !== undefined) {
    const size = clampInt(fontSize, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX, DEFAULT_FONT_SIZE_PX);
    setSetting('ui_font_size', size === DEFAULT_FONT_SIZE_PX ? '' : String(size));
    setSetting('ui_font_scale', '');
  }
  if (headingScale !== undefined) {
    const scale = clampInt(headingScale, MIN_HEADING_SCALE, MAX_HEADING_SCALE, DEFAULT_HEADING_SCALE);
    setSetting('ui_heading_scale', scale === DEFAULT_HEADING_SCALE ? '' : String(scale));
  }
  if (density !== undefined) {
    const valid = ['compact', 'normal', 'comfortable'].includes(density) ? density : '';
    setSetting('ui_density', valid);
  }
  if (fontFamily !== undefined) {
    const normalized = String(fontFamily || '').trim();
    if (!UI_FONT_FAMILY_PRESETS.includes(normalized) || normalized === 'inter') {
      setSetting('ui_font_family', '');
    } else if (normalized === 'custom') {
      if (!hasCustomFontFile()) throw new Error('admin.ui.errorFontRequired');
      setSetting('ui_font_family', 'custom');
    } else {
      setSetting('ui_font_family', normalized);
    }
  }
  invalidateUiCustomizationCache();
}

export async function saveUiAsset(asset, buffer, options = {}) {
  if (!VALID_ASSETS.has(asset)) throw new Error('admin.ui.errorUnknownAsset');
  if (!buffer || !buffer.length) throw new Error('admin.ui.errorEmptyFile');
  if (asset === 'font') {
    await saveUiFontFile(buffer, options.originalName || '');
    return;
  }
  if (buffer.length > MAX_BYTES) throw new Error('admin.ui.errorTooLarge');

  ensureUiDir();
  const sharp = await getSharp();
  if (!sharp) throw new Error('admin.ui.errorSharpUnavailable');
  const image = sharp(buffer, { failOn: 'error' }).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('admin.ui.errorInvalidImage');

  if (asset === 'logo') {
    const out = await image
      .clone()
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(path.join(UI_DIR, 'logo.png'), out);
  } else if (asset === 'favicon') {
    const png32 = await image.clone().resize(32, 32, { fit: 'cover' }).png().toBuffer();
    const png192 = await image.clone().resize(192, 192, { fit: 'cover' }).png().toBuffer();
    fs.writeFileSync(path.join(UI_DIR, 'favicon-32.png'), png32);
    fs.writeFileSync(path.join(UI_DIR, 'favicon-192.png'), png192);
  } else if (asset === 'background') {
    const out = await image
      .clone()
      .resize(2560, 2560, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    fs.writeFileSync(path.join(UI_DIR, 'background.webp'), out);
    if (hasUiDynamicThemeFromBg()) {
      await refreshBgThemePaletteFromFile();
    }
  }

  invalidateUiCustomizationCache();
}

export async function saveUiFontFile(buffer, originalName = '') {
  if (!buffer || !buffer.length) throw new Error('admin.ui.errorEmptyFile');
  if (buffer.length > MAX_FONT_BYTES) throw new Error('admin.ui.errorFontTooLarge');
  const ext = detectFontExtension(buffer, originalName);
  if (!ext) throw new Error('admin.ui.errorInvalidFont');
  ensureUiDir();
  removeCustomFontFiles();
  fs.writeFileSync(path.join(UI_DIR, `${CUSTOM_FONT_BASENAME}${ext}`), buffer);
  setSetting('ui_custom_font_ext', ext);
  setSetting('ui_custom_font_name', sanitizeFontFamilyName(originalName));
  setSetting('ui_font_family', 'custom');
  invalidateUiCustomizationCache();
}

export function removeUiAsset(asset) {
  if (!VALID_ASSETS.has(asset)) throw new Error('admin.ui.errorUnknownAsset');
  ensureUiDir();
  if (asset === 'font') {
    removeCustomFontFiles();
    setSetting('ui_custom_font_ext', '');
    setSetting('ui_custom_font_name', '');
    if (getSetting('ui_font_family') === 'custom') setSetting('ui_font_family', '');
    invalidateUiCustomizationCache();
    return;
  }
  const files = {
    logo: ['logo.png'],
    favicon: ['favicon-32.png', 'favicon-192.png'],
    background: ['background.webp'],
  }[asset];
  for (const fileName of files) {
    try {
      fs.unlinkSync(path.join(UI_DIR, fileName));
    } catch {
      /* ignore missing */
    }
  }
  if (asset === 'background') {
    clearExtractedBgPalette();
    if (hasUiDynamicThemeFromBg()) setSetting('ui_dynamic_theme_from_bg', '0');
  }
  invalidateUiCustomizationCache();
}

export function serveUiAsset(asset, res) {
  if (asset === 'font') {
    const ext = readCustomFontExt();
    const fileName = customFontFileName(ext);
    if (!fileName) return false;
    const full = path.join(UI_DIR, fileName);
    if (!fs.existsSync(full)) return false;
    res.type(FONT_EXTENSIONS[ext]?.mime || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(full);
    return true;
  }
  const spec = SERVE_MAP[asset];
  if (!spec) return false;
  const full = path.join(UI_DIR, spec.file);
  if (!fs.existsSync(full)) return false;
  res.type(spec.type);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(full);
  return true;
}

/** Snapshot for admin appearance form sync after partial section reset (no page reload). */
export function getUiAppearanceFormState() {
  const ui = getUiCustomization();
  return {
    hasCustomThemeSliders: ui.hasCustomThemeSliders,
    hasCustomThemeColors: ui.hasCustomThemeColors,
    hasCustomThemeShape: ui.hasCustomThemeShape,
    hasCustomThemeTypography: ui.hasCustomThemeTypography,
    blur: ui.blur,
    bgContrast: ui.bgContrast,
    surfaceOpacity: ui.surfaceOpacity,
    surfaceBlur: ui.surfaceBlur,
    bgSize: ui.bgSize,
    bgPosition: ui.bgPosition,
    glassColorDark: ui.glassColorDark,
    glassColorLight: ui.glassColorLight,
    glassTextDark: ui.glassTextDark,
    glassTextLight: ui.glassTextLight,
    glassTextAutoDark: ui.glassTextAutoDark,
    glassTextAutoLight: ui.glassTextAutoLight,
    glassMutedDark: ui.glassMutedDark,
    glassMutedLight: ui.glassMutedLight,
    glassMutedAutoDark: ui.glassMutedAutoDark,
    glassMutedAutoLight: ui.glassMutedAutoLight,
    glassLinkDark: ui.glassLinkDark,
    glassLinkLight: ui.glassLinkLight,
    glassLinkAutoDark: ui.glassLinkAutoDark,
    glassLinkAutoLight: ui.glassLinkAutoLight,
    glassAccentDark: ui.glassAccentDark,
    glassAccentLight: ui.glassAccentLight,
    glassAccentAutoDark: ui.glassAccentAutoDark,
    glassAccentAutoLight: ui.glassAccentAutoLight,
    overlayColorDark: ui.overlayColorDark,
    overlayColorLight: ui.overlayColorLight,
    overlayColorAutoDark: ui.overlayColorAutoDark,
    overlayColorAutoLight: ui.overlayColorAutoLight,
    dynamicThemeFromBg: ui.dynamicThemeFromBg,
    radiusPreset: ui.radiusPreset,
    radiusScale: ui.radiusScale,
    shadowPreset: ui.shadowPreset,
    fontSize: ui.fontSize,
    headingScale: ui.headingScale,
    density: ui.density,
    fontFamily: ui.fontFamily,
    hasCustomFont: ui.hasCustomFont,
  };
}

export function getPublicUiSettingsJson() {
  const ui = getUiCustomization();
  const siteName = String(getSetting('site_name') || '').trim();
  const pair = ui.themePair;
  const mapAppPalette = (p) => ({
    bg: p.shellBg,
    surface: p.surface,
    surfaceHover: p.surfaceHover,
    text: p.text,
    muted: p.muted,
    accent: p.accent,
    link: p.link,
    linkHover: p.linkHover,
    accentHover: p.accentHover,
    border: p.border,
    fieldBg: p.fieldBg,
    cardBg: p.cardBg,
    cardBgHover: p.cardBgHover,
    panelSoft: p.panelSoftBg,
    topbarBg: p.topbarBg,
    topbarBorder: p.topbarBorder,
    coverBorder: p.cardCoverBorder,
  });
  const themeVersion = [
    ui.glassColorDark,
    ui.glassColorLight,
    ui.glassTextDark,
    ui.glassTextLight,
    ui.glassAccentDark,
    ui.glassAccentLight,
    ui.glassLinkDark,
    ui.glassLinkLight,
    ui.glassMutedDark,
    ui.glassMutedLight,
    ui.fontFamily,
    ui.fontSize,
    ui.density,
    ui.radiusPreset,
    ui.radiusScale,
    ui.shadowPreset,
    ui.backgroundUrl,
    ui.blur,
    ui.overlay,
  ].join(':');
  return {
    siteName,
    logoUrl: ui.logoUrl,
    faviconUrl: ui.faviconUrl,
    faviconAppleUrl: ui.faviconAppleUrl,
    backgroundUrl: ui.backgroundUrl,
    hasLogo: ui.hasLogo,
    hasBackground: ui.hasBackground,
    hasCustomFont: ui.hasCustomFont,
    bgBlur: ui.blur,
    bgOverlay: ui.bgContrast,
    bgOverlayStrength: ui.overlay,
    bgSize: ui.bgSize,
    bgPosition: ui.bgPosition,
    overlayColorDark: ui.overlayColorDark,
    overlayColorLight: ui.overlayColorLight,
    surfaceOpacity: ui.surfaceOpacity,
    surfaceBlur: ui.surfaceBlur,
    glassColorDark: ui.glassColorDark,
    glassColorLight: ui.glassColorLight,
    glassTextDark: ui.glassTextDark,
    glassTextLight: ui.glassTextLight,
    glassTextAutoDark: ui.glassTextAutoDark,
    glassTextAutoLight: ui.glassTextAutoLight,
    showLogoOnLogin: ui.showLogoOnLogin,
    radiusPreset: ui.radiusPreset,
    radiusScale: ui.radiusScale,
    radius: radiusTokensForPreset(ui.radiusPreset, ui.radiusScale),
    shadowPreset: ui.shadowPreset,
    shadows: shadowTokensForPreset(ui.shadowPreset),
    fontSize: ui.fontSize,
    density: ui.density,
    fontFamily: ui.fontFamily,
    customFontUrl: ui.customFontUrl,
    dynamicThemeFromBg: ui.dynamicThemeFromBg,
    themeVersion,
    appPaletteDark: mapAppPalette(pair.dark),
    appPaletteLight: mapAppPalette(pair.light),
  };
}
