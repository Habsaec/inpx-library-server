/**
 * Theme engine: derive a coherent token palette from base surface (+ optional text) colors.
 * Used when custom background is active (glass mode).
 */

/** Built-in palette surfaces (:root / html[data-theme="light"]) before theme overrides. */
export const LEGACY_SURFACE_DARK = '#1a1612';
export const LEGACY_SURFACE_LIGHT = '#fffdf8';
export const DEFAULT_GLASS_DARK = LEGACY_SURFACE_DARK;
export const DEFAULT_GLASS_LIGHT = LEGACY_SURFACE_LIGHT;

export function normalizeHexColor(raw, fallback) {
  const s = String(raw || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return fallback;
}

export function hexToRgb(hex) {
  const h = normalizeHexColor(hex, '#000000').slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function relativeLuminance(r, g, b) {
  const linear = [r, g, b].map((c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((x) => Math.min(255, Math.max(0, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(a, b, weightB) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const w = Math.min(1, Math.max(0, weightB));
  return rgbToHex(
    ar * (1 - w) + br * w,
    ag * (1 - w) + bg * w,
    ab * (1 - w) + bb * w,
  );
}

function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    default: h = ((r - g) / d + 4) / 6; break;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(100, Math.max(0, s)) / 100;
  l = Math.min(100, Math.max(0, l)) / 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return rgbToHex(v, v, v);
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, h / 360 + 1 / 3);
  const g = hue2rgb(p, q, h / 360);
  const b = hue2rgb(p, q, h / 360 - 1 / 3);
  return rgbToHex(r * 255, g * 255, b * 255);
}

function pickAutoText(surfaceHex) {
  return relativeLuminance(...hexToRgb(surfaceHex)) < 0.45 ? '#ece6dc' : '#2a2218';
}

/** Shift a hex color's lightness for a hover variant (lighter on dark, darker on light). */
function shiftLightness(hex, deltaL) {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, s, Math.min(100, Math.max(0, l + deltaL)));
}

/**
 * Build full semantic palette for one theme mode from a surface tint.
 * @param {string} surfaceHex
 * @param {string} [textHex] - empty = auto from surface luminance
 * @param {string} [accentHex] - empty = auto-derived accent from surface hue
 */
export function buildThemePalette(surfaceHex, textHex = '', accentHex = '') {
  const surface = normalizeHexColor(surfaceHex, DEFAULT_GLASS_DARK);
  const textOverride = String(textHex || '').trim();
  const text = textOverride ? normalizeHexColor(textOverride, pickAutoText(surface)) : pickAutoText(surface);
  const isDark = relativeLuminance(...hexToRgb(surface)) < 0.45;
  const { h, s } = hexToHsl(surface);
  const hue = s < 8 ? 38 : h;

  const accentOverride = String(accentHex || '').trim();
  const hasAccentOverride = /^#[0-9a-fA-F]{3,6}$/.test(accentOverride);
  const accent = hasAccentOverride
    ? normalizeHexColor(accentOverride, hslToHex(hue, Math.min(42, s + 12), isDark ? 58 : 42))
    : hslToHex(hue, Math.min(42, s + 12), isDark ? 58 : 42);
  const accentHover = hasAccentOverride
    ? shiftLightness(accent, isDark ? 8 : -8)
    : hslToHex(hue, Math.min(48, s + 18), isDark ? 52 : 36);
  const link = hslToHex(hue, Math.min(55, s + 22), isDark ? 68 : 34);
  const linkHover = hslToHex(hue, Math.min(60, s + 28), isDark ? 74 : 28);
  const muted = mixHex(text, surface, isDark ? 0.42 : 0.38);
  const surfaceHover = isDark ? mixHex(surface, '#ffffff', 0.12) : mixHex(surface, '#000000', 0.06);
  const shellBg = isDark ? mixHex(surface, '#000000', 0.15) : mixHex(surface, '#ffffff', 0.08);
  const borderMix = isDark ? 'rgba(255,255,255,0.11)' : `color-mix(in srgb, ${text} 14%, transparent)`;
  const fieldBg = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.72)';
  const panelSoftBg = isDark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.52)';
  const buttonBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.58)';
  const buttonBgHover = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.78)';
  const buttonBorderHover = isDark ? 'rgba(255,255,255,0.16)' : `color-mix(in srgb, ${text} 18%, transparent)`;
  const cardBg = isDark
    ? `color-mix(in srgb, ${surface} 82%, ${accent} 6%)`
    : `color-mix(in srgb, ${surface} 48%, white 52%)`;
  const cardBgHover = isDark
    ? `color-mix(in srgb, ${surface} 78%, ${accent} 10%)`
    : `color-mix(in srgb, ${surface} 40%, white 60%)`;
  const coverA = isDark ? mixHex(surface, '#000000', 0.2) : mixHex(surface, '#ffffff', 0.15);
  const coverB = isDark ? mixHex(surface, '#000000', 0.45) : mixHex(surface, '#000000', 0.08);
  const bgOverlayColor = surface;

  return {
    surface,
    text,
    muted,
    accent,
    accentHover,
    link,
    linkHover,
    surfaceHover,
    shellBg,
    bgOverlayColor,
    sidebarBg: surface,
    topbarBg: surface,
    border: borderMix,
    sidebarBrandBorder: borderMix,
    topbarBorder: borderMix,
    fieldBg,
    panelSoftBg,
    buttonBg,
    buttonBgHover,
    buttonBorderHover,
    cardBg,
    cardBgHover,
    cardCoverBg: `linear-gradient(135deg, ${coverA} 0%, ${coverB} 100%)`,
    cardCoverFallbackBg: `linear-gradient(180deg, ${coverA} 0%, ${coverB} 100%)`,
    cardCoverBorder: isDark ? 'rgba(255,255,255,0.1)' : `color-mix(in srgb, ${text} 12%, transparent)`,
    textAuto: textOverride === '',
    accentAuto: !hasAccentOverride,
  };
}

export function deriveGlassTheme(glassHex) {
  const p = buildThemePalette(glassHex);
  return {
    text: p.text,
    muted: p.muted,
    fieldBg: p.fieldBg,
    panelSoftBg: p.panelSoftBg,
    border: p.border,
    buttonBg: p.buttonBg,
    buttonBgHover: p.buttonBgHover,
    buttonBorderHover: p.buttonBorderHover,
  };
}

export function buildThemePair(darkSurface, lightSurface, darkText = '', lightText = '', darkAccent = '', lightAccent = '') {
  return {
    dark: buildThemePalette(darkSurface || DEFAULT_GLASS_DARK, darkText, darkAccent),
    light: buildThemePalette(lightSurface || DEFAULT_GLASS_LIGHT, lightText, lightAccent),
  };
}

/** Perceived fill strength differs by surface luminance; light tints need lower mix %. */
export function effectiveGlassFillOpacity(surfaceHex, surfaceOpacity) {
  const opacity = Math.min(100, Math.max(0, Number(surfaceOpacity)));
  if (!Number.isFinite(opacity)) return 88;
  const surface = normalizeHexColor(surfaceHex, DEFAULT_GLASS_DARK);
  const isLight = relativeLuminance(...hexToRgb(surface)) >= 0.45;
  if (isLight) return Math.max(0, opacity - 14);
  return opacity;
}

/** Glass panel fill from surface tint and user opacity. */
export function buildGlassPanelBackground(surfaceHex, surfaceOpacity, fallback = DEFAULT_GLASS_DARK) {
  const surface = normalizeHexColor(surfaceHex, fallback);
  const opacity = effectiveGlassFillOpacity(surface, surfaceOpacity);
  return `color-mix(in srgb, ${surface} ${opacity}%, transparent)`;
}

/** Slightly darken light-theme text when panels are very transparent. */
export function adjustLightTextForGlassOpacity(palette, surfaceOpacity) {
  const opacity = Math.min(100, Math.max(0, Number(surfaceOpacity)));
  if (!Number.isFinite(opacity) || opacity >= 58) return palette;
  if (relativeLuminance(...hexToRgb(palette.surface)) < 0.45) return palette;
  const factor = (58 - opacity) / 58;
  return {
    ...palette,
    text: mixHex(palette.text, '#000000', factor * 0.22),
    muted: mixHex(palette.muted, '#000000', factor * 0.12),
  };
}

// ── Предустановки радиусов ──
const RADIUS_PRESETS = {
  sharp: { sm: '2px', md: '4px', lg: '6px', xl: '8px', button: '4px', card: '2px' },
  rounded: { sm: '6px', md: '8px', lg: '12px', xl: '16px', button: '10px', card: '6px' },
  pill: { sm: '12px', md: '16px', lg: '22px', xl: '28px', button: '999px', card: '12px' },
};

// ── Предустановки теней ──
const SHADOW_PRESETS = {
  none: {
    sm: 'none',
    md: 'none',
    lg: 'none',
    'card-cover': 'none',
    'card-cover-hover': 'none',
  },
  subtle: {
    sm: '0 1px 2px rgba(0,0,0,0.06)',
    md: '0 2px 6px -2px rgba(0,0,0,0.08)',
    lg: '0 6px 16px -6px rgba(0,0,0,0.12)',
    'card-cover': '0 1px 1px rgba(0,0,0,0.12), 1px 2px 2px rgba(0,0,0,0.08), 3px 5px 8px rgba(0,0,0,0.06)',
    'card-cover-hover': '0 1px 1px rgba(0,0,0,0.16), 2px 4px 4px rgba(0,0,0,0.12), 6px 10px 16px rgba(0,0,0,0.10)',
  },
  normal: {
    sm: '0 1px 3px rgba(0,0,0,0.2)',
    md: '0 4px 12px -2px rgba(0,0,0,0.3)',
    lg: '0 12px 28px -4px rgba(0,0,0,0.4)',
    'card-cover': '0 1px 1px rgba(0,0,0,0.5), 2px 3px 3px rgba(0,0,0,0.35), 5px 8px 12px rgba(0,0,0,0.3), 10px 18px 24px rgba(0,0,0,0.25)',
    'card-cover-hover': '0 2px 2px rgba(0,0,0,0.6), 4px 6px 6px rgba(0,0,0,0.45), 12px 18px 24px rgba(0,0,0,0.4), 24px 38px 48px rgba(0,0,0,0.3)',
  },
  pronounced: {
    sm: '0 2px 6px rgba(0,0,0,0.25)',
    md: '0 8px 24px -4px rgba(0,0,0,0.4)',
    lg: '0 20px 40px -8px rgba(0,0,0,0.55)',
    'card-cover': '0 2px 2px rgba(0,0,0,0.6), 4px 6px 6px rgba(0,0,0,0.5), 8px 14px 20px rgba(0,0,0,0.4), 18px 30px 40px rgba(0,0,0,0.35)',
    'card-cover-hover': '0 3px 3px rgba(0,0,0,0.7), 6px 10px 10px rgba(0,0,0,0.55), 18px 28px 36px rgba(0,0,0,0.5), 32px 50px 64px rgba(0,0,0,0.4)',
  },
};

// ── Предустановки теней для светлой темы ──
const SHADOW_PRESETS_LIGHT = {
  none: SHADOW_PRESETS.none,
  subtle: {
    sm: '0 1px 2px rgba(32,24,14,0.04)',
    md: '0 2px 8px -4px rgba(32,24,14,0.06)',
    lg: '0 8px 20px -8px rgba(32,24,14,0.10)',
    'card-cover': '0 1px 1px rgba(32,24,14,0.10), 1px 2px 2px rgba(32,24,14,0.06), 3px 5px 8px rgba(32,24,14,0.04)',
    'card-cover-hover': '0 1px 1px rgba(32,24,14,0.14), 2px 4px 4px rgba(32,24,14,0.10), 6px 10px 16px rgba(32,24,14,0.08)',
  },
  normal: {
    sm: '0 1px 2px rgba(32,24,14,0.08)',
    md: '0 6px 18px -4px rgba(32,24,14,0.16)',
    lg: '0 16px 36px -12px rgba(32,24,14,0.24)',
    'card-cover': '0 1px 1px rgba(32,24,14,0.35), 2px 3px 3px rgba(32,24,14,0.22), 5px 8px 12px rgba(32,24,14,0.18), 10px 18px 24px rgba(32,24,14,0.14)',
    'card-cover-hover': '0 2px 2px rgba(32,24,14,0.42), 4px 6px 6px rgba(32,24,14,0.28), 12px 18px 24px rgba(32,24,14,0.24), 24px 38px 48px rgba(32,24,14,0.18)',
  },
  pronounced: {
    sm: '0 2px 6px rgba(32,24,14,0.12)',
    md: '0 8px 24px -4px rgba(32,24,14,0.22)',
    lg: '0 20px 40px -8px rgba(32,24,14,0.32)',
    'card-cover': '0 2px 2px rgba(32,24,14,0.45), 4px 6px 6px rgba(32,24,14,0.32), 8px 14px 20px rgba(32,24,14,0.26), 18px 30px 40px rgba(32,24,14,0.20)',
    'card-cover-hover': '0 3px 3px rgba(32,24,14,0.52), 6px 10px 10px rgba(32,24,14,0.38), 18px 28px 36px rgba(32,24,14,0.32), 32px 50px 64px rgba(32,24,14,0.26)',
  },
};

// ── Базовый размер шрифта (px) ──
export const DEFAULT_FONT_SIZE_PX = 14;
export const MIN_FONT_SIZE_PX = 11;
export const MAX_FONT_SIZE_PX = 20;

const FONT_SIZE_RATIOS = {
  sm: 12 / 14,
  lg: 16 / 14,
  xl: 20 / 14,
  '2xl': 26 / 14,
};

export const DEFAULT_HEADING_SCALE = 100;
export const MIN_HEADING_SCALE = 100;
export const MAX_HEADING_SCALE = 170;

/**
 * CSS custom properties for UI font sizes from base size in px.
 * @param {number} basePx        base body font size
 * @param {number} headingScale  percentage (100–170) applied to heading sizes (xl / 2xl)
 */
export function fontSizeToCssVars(basePx = DEFAULT_FONT_SIZE_PX, headingScale = DEFAULT_HEADING_SCALE) {
  const base = Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(Number(basePx) || DEFAULT_FONT_SIZE_PX)));
  const scale = Math.min(MAX_HEADING_SCALE, Math.max(MIN_HEADING_SCALE, Math.round(Number(headingScale) || DEFAULT_HEADING_SCALE))) / 100;
  const toRem = (px) => `${Math.round((px / 16) * 100000) / 100000}rem`;
  return [
    `--font-size-sm:${toRem(Math.round(base * FONT_SIZE_RATIOS.sm))}`,
    `--font-size-base:${toRem(base)}`,
    `--font-size-lg:${toRem(Math.round(base * FONT_SIZE_RATIOS.lg))}`,
    `--font-size-xl:${toRem(Math.round(base * FONT_SIZE_RATIOS.xl * scale))}`,
    `--font-size-2xl:${toRem(Math.round(base * FONT_SIZE_RATIOS['2xl'] * scale))}`,
  ];
}

/** Background layout (size / position) CSS vars for a custom background image. */
export const BG_SIZE_PRESETS = ['cover', 'contain', 'tile'];
export const BG_POSITION_PRESETS = ['center', 'top', 'bottom', 'left', 'right'];

export function backgroundLayoutToCssVars(size = 'cover', position = 'center') {
  const sz = BG_SIZE_PRESETS.includes(size) ? size : 'cover';
  const pos = BG_POSITION_PRESETS.includes(position) ? position : 'center';
  if (sz === 'tile') {
    return [
      '--ui-bg-size:auto',
      '--ui-bg-repeat:repeat',
      `--ui-bg-position:${pos}`,
      '--ui-bg-transform:none',
    ];
  }
  return [
    `--ui-bg-size:${sz}`,
    '--ui-bg-repeat:no-repeat',
    `--ui-bg-position:${pos}`,
    `--ui-bg-transform:${sz === 'contain' ? 'none' : 'scale(1.06)'}`,
  ];
}

// ── Предустановки плотности ──
const DENSITY_PRESETS = {
  compact: { xs: '2px', sm: '4px', md: '8px', lg: '12px', xl: '18px' },
  normal: { xs: '4px', sm: '8px', md: '14px', lg: '20px', xl: '28px' },
  comfortable: { xs: '6px', sm: '12px', md: '20px', lg: '28px', xl: '38px' },
};

export const UI_FONT_FAMILY_PRESETS = ['inter', 'system', 'serif', 'georgia', 'merriweather', 'rounded', 'mono', 'custom'];

/** Default UI voice: Source Sans 3 (preset key `inter` kept for settings compatibility). */
export const FONT_FAMILY_STACKS = {
  inter: "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  serif: "'Source Serif 4', Georgia, 'Times New Roman', serif",
  georgia: "Georgia, 'Times New Roman', serif",
  merriweather: "'Merriweather', Georgia, 'Times New Roman', serif",
  rounded: "'Nunito', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
  mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Consolas', 'Liberation Mono', monospace",
};

/** Google Fonts family spec for presets that require a web font (empty = system/available). */
export const FONT_FAMILY_WEBFONT = {
  inter: 'Source+Sans+3:wght@400;500;600;700',
  serif: 'Source+Serif+4:ital,wght@0,400;0,600;1,400;1,600',
  merriweather: 'Merriweather:wght@400;700',
  rounded: 'Nunito:wght@400;600;700;800',
};

/** Display/serif companion loaded on every page for hero and literary chrome. */
export const DISPLAY_FONT_WEBFONT = 'Source+Serif+4:ital,wght@0,400;0,600;1,400;1,600';
export const DISPLAY_FONT_STACK = "'Source Serif 4', Georgia, 'Times New Roman', serif";

/** CSS font-family stack for UI preset (custom uses uploaded @font-face name). */
export function resolveFontFamilyStack(preset, customFontName = 'Custom Font') {
  if (preset === 'custom') {
    const safe = String(customFontName || 'Custom Font').replace(/["\\]/g, '').trim().slice(0, 64) || 'Custom Font';
    return `'${safe}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  }
  return FONT_FAMILY_STACKS[preset] || FONT_FAMILY_STACKS.inter;
}

/** CSS custom properties for UI font family preset */
export function fontFamilyToCssVars(preset, customFontName = 'Custom Font') {
  return [`--ui-font-family:${resolveFontFamilyStack(preset, customFontName)}`];
}

export const UI_RADIUS_PRESETS = ['sharp', 'rounded', 'pill', 'custom'];
export const MIN_RADIUS_SCALE = 0;
export const MAX_RADIUS_SCALE = 28;
export const DEFAULT_RADIUS_SCALE = 8;

/** Resolved radius tokens for a preset (or custom scale). */
export function radiusTokensForPreset(preset, scalePx) {
  if (preset === 'custom') {
    const base = Math.min(MAX_RADIUS_SCALE, Math.max(MIN_RADIUS_SCALE, Math.round(Number(scalePx) || 0)));
    const r = (mult) => `${Math.round(base * mult)}px`;
    return { sm: r(0.75), md: r(1), lg: r(1.5), xl: r(2), button: r(1.25), card: r(0.75) };
  }
  const r = RADIUS_PRESETS[preset] || RADIUS_PRESETS.rounded;
  return { sm: r.sm, md: r.md, lg: r.lg, xl: r.xl, button: r.button, card: r.card };
}

/** Генерация CSS-переменных радиусов по пресету */
export function radiusPresetToCssVars(preset) {
  const r = radiusTokensForPreset(preset);
  return [
    `--radius-sm:${r.sm}`,
    `--radius:${r.md}`,
    `--radius-lg:${r.lg}`,
    `--radius-xl:${r.xl}`,
    `--radius-button:${r.button}`,
    `--radius-card:${r.card}`,
  ];
}

/** Генерация CSS-переменных радиусов по произвольному базовому значению (px). */
export function customRadiusToCssVars(basePx) {
  const r = radiusTokensForPreset('custom', basePx);
  return [
    `--radius-sm:${r.sm}`,
    `--radius:${r.md}`,
    `--radius-lg:${r.lg}`,
    `--radius-xl:${r.xl}`,
    `--radius-button:${r.button}`,
    `--radius-card:${r.card}`,
  ];
}

/** Shadow tokens for Android / public UI JSON (dark + light). */
export function shadowTokensForPreset(preset) {
  const dark = SHADOW_PRESETS[preset] || SHADOW_PRESETS.normal;
  const light = SHADOW_PRESETS_LIGHT[preset] || SHADOW_PRESETS_LIGHT.normal;
  const pick = (s) => ({ sm: s.sm, md: s.md, lg: s.lg });
  return { dark: pick(dark), light: pick(light) };
}

/** Генерация CSS-переменных теней по пресету (с учётом тёмной/светлой темы) */
export function shadowPresetToCssVars(preset) {
  const dark = SHADOW_PRESETS[preset] || SHADOW_PRESETS.normal;
  const light = SHADOW_PRESETS_LIGHT[preset] || SHADOW_PRESETS_LIGHT.normal;

  const mapShadows = (s) => [
    `--shadow-sm:${s.sm}`,
    `--shadow-md:${s.md}`,
    `--shadow-lg:${s.lg}`,
    `--card-cover-shadow:${s['card-cover']}`,
    `--card-cover-shadow-hover:${s['card-cover-hover']}`,
  ];

  const darkVars = mapShadows(dark);
  const lightVars = mapShadows(light).map((v) => {
    const [key, value] = v.split(':');
    return `--shadow-light-${key.slice(2)}:${value}`;
  });

  return [...darkVars, ...lightVars];
}

/** Генерация CSS-переменных плотности по пресету */
export function densityToCssVars(preset) {
  const d = DENSITY_PRESETS[preset] || DENSITY_PRESETS.normal;
  return [
    `--space-xs:${d.xs}`,
    `--space-sm:${d.sm}`,
    `--space-md:${d.md}`,
    `--space-lg:${d.lg}`,
    `--space-xl:${d.xl}`,
  ];
}

/** Flat CSS custom properties for injection on :root */
export function themePairToCssVars(pair) {
  const prefix = (mode, key, value) => `--ui-theme-${mode}-${key}:${value}`;
  const mapMode = (mode, palette) => [
    prefix(mode, 'surface', palette.surface),
    prefix(mode, 'text', palette.text),
    prefix(mode, 'muted', palette.muted),
    prefix(mode, 'accent', palette.accent),
    prefix(mode, 'accent-hover', palette.accentHover),
    prefix(mode, 'link', palette.link),
    prefix(mode, 'link-hover', palette.linkHover),
    prefix(mode, 'surface-hover', palette.surfaceHover),
    prefix(mode, 'shell-bg', palette.shellBg),
    prefix(mode, 'bg-overlay-color', palette.bgOverlayColor),
    prefix(mode, 'sidebar-bg', palette.sidebarBg),
    prefix(mode, 'topbar-bg', palette.topbarBg),
    prefix(mode, 'border', palette.border),
    prefix(mode, 'sidebar-brand-border', palette.sidebarBrandBorder),
    prefix(mode, 'topbar-border', palette.topbarBorder),
    prefix(mode, 'field-bg', palette.fieldBg),
    prefix(mode, 'panel-soft-bg', palette.panelSoftBg),
    prefix(mode, 'button-bg', palette.buttonBg),
    prefix(mode, 'button-bg-hover', palette.buttonBgHover),
    prefix(mode, 'button-border-hover', palette.buttonBorderHover),
    prefix(mode, 'card-bg', palette.cardBg),
    prefix(mode, 'card-bg-hover', palette.cardBgHover),
    prefix(mode, 'card-cover-bg', palette.cardCoverBg),
    prefix(mode, 'card-cover-fallback-bg', palette.cardCoverFallbackBg),
    prefix(mode, 'card-cover-border', palette.cardCoverBorder),
  ];
  return [
    ...mapMode('dark', pair.dark),
    ...mapMode('light', pair.light),
  ];
}

/**
 * One-click palette presets. Each entry defines surface + accent for both modes.
 * `id: 'default'` restores the built-in palette.
 */
export const THEME_PRESETS = [
  { id: 'default', dark: { surface: LEGACY_SURFACE_DARK, accent: '' }, light: { surface: LEGACY_SURFACE_LIGHT, accent: '' } },
  { id: 'sepia', dark: { surface: '#2b2318', accent: '#c9a15a' }, light: { surface: '#f3e9d6', accent: '#a6741f' } },
  { id: 'midnight', dark: { surface: '#12151f', accent: '#5b8cff' }, light: { surface: '#eef1f8', accent: '#3b5bdb' } },
  { id: 'nord', dark: { surface: '#2e3440', accent: '#88c0d0' }, light: { surface: '#eceff4', accent: '#5e81ac' } },
  { id: 'solarized', dark: { surface: '#002b36', accent: '#268bd2' }, light: { surface: '#fdf6e3', accent: '#268bd2' } },
  { id: 'forest', dark: { surface: '#16221a', accent: '#6cc07a' }, light: { surface: '#e9f2e8', accent: '#2f7d46' } },
  { id: 'rose', dark: { surface: '#241820', accent: '#e06c9f' }, light: { surface: '#fbeaf1', accent: '#c04277' } },
  { id: 'slate', dark: { surface: '#1a1d21', accent: '#9aa7b3' }, light: { surface: '#eef1f4', accent: '#5b6b7a' } },
  { id: 'ocean', dark: { surface: '#0d1b2a', accent: '#38bdf8' }, light: { surface: '#e8f4fc', accent: '#0284c7' } },
  { id: 'wine', dark: { surface: '#2a1520', accent: '#f472b6' }, light: { surface: '#faf0f3', accent: '#be123c' } },
  { id: 'graphite', dark: { surface: '#181818', accent: '#a3a3a3' }, light: { surface: '#f5f5f5', accent: '#525252' } },
  { id: 'lavender', dark: { surface: '#1e1830', accent: '#a78bfa' }, light: { surface: '#f3f0fa', accent: '#7c3aed' } },
  { id: 'amber', dark: { surface: '#251a0a', accent: '#fbbf24' }, light: { surface: '#fff8eb', accent: '#d97706' } },
  { id: 'mint', dark: { surface: '#122420', accent: '#34d399' }, light: { surface: '#ecfdf5', accent: '#059669' } },
  { id: 'copper', dark: { surface: '#231812', accent: '#ea580c' }, light: { surface: '#fdf4ee', accent: '#c2410c' } },
];

export function getThemePresetById(id) {
  return THEME_PRESETS.find((preset) => preset.id === id) || null;
}
