import fs from 'node:fs';
import { getSharp } from './sharp-loader.js';
import {
  DEFAULT_GLASS_DARK,
  DEFAULT_GLASS_LIGHT,
  normalizeHexColor,
  hexToRgb,
  relativeLuminance,
} from './theme-engine.js';

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

function pixelSaturation(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max === 0) return 0;
  return (max - min) / max;
}

function averageRgb(pixels) {
  if (!pixels.length) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pixel of pixels) {
    r += pixel.r;
    g += pixel.g;
    b += pixel.b;
  }
  const n = pixels.length;
  return rgbToHex(r / n, g / n, b / n);
}

function ensureDarkSurface(hex) {
  const normalized = normalizeHexColor(hex, DEFAULT_GLASS_DARK);
  const lum = relativeLuminance(...hexToRgb(normalized));
  if (lum <= 0.22) return normalized;
  const mix = Math.min(0.88, 0.42 + (lum - 0.22) * 1.1);
  return mixHex(normalized, '#000000', mix);
}

function ensureLightSurface(hex) {
  const normalized = normalizeHexColor(hex, DEFAULT_GLASS_LIGHT);
  const lum = relativeLuminance(...hexToRgb(normalized));
  if (lum >= 0.78) return normalized;
  const mix = Math.min(0.9, 0.45 + (0.78 - lum) * 0.9);
  return mixHex(normalized, '#ffffff', mix);
}

/**
 * Derive dark/light theme surfaces from sampled RGB pixels (64×64 cover sample).
 * @param {Array<{ r: number, g: number, b: number }>} samples
 */
export function extractThemeFromPixels(samples) {
  if (!samples.length) {
    return {
      darkSurface: DEFAULT_GLASS_DARK,
      lightSurface: DEFAULT_GLASS_LIGHT,
    };
  }

  const pixels = samples.map(({ r, g, b }) => {
    const lum = relativeLuminance(r, g, b);
    const sat = pixelSaturation(r, g, b);
    return { r, g, b, lum, sat };
  });

  pixels.sort((a, b) => a.lum - b.lum);
  const count = pixels.length;
  const darkSlice = pixels.slice(0, Math.max(1, Math.floor(count * 0.18)));
  const lightSlice = pixels.slice(Math.max(0, Math.floor(count * 0.82)));
  const saturated = pixels.filter((p) => p.sat >= 0.12 && p.lum >= 0.05 && p.lum <= 0.94);
  const accentPool = saturated.length >= 6 ? saturated : pixels.slice(Math.floor(count * 0.25), Math.ceil(count * 0.75));

  const accent = averageRgb(accentPool) || averageRgb(pixels);
  let darkSurface;
  let lightSurface;

  if (accent && pixelSaturation(...hexToRgb(accent)) >= 0.08) {
    darkSurface = ensureDarkSurface(mixHex(accent, '#000000', 0.68));
    lightSurface = ensureLightSurface(mixHex(accent, '#ffffff', 0.8));
  } else {
    darkSurface = ensureDarkSurface(averageRgb(darkSlice) || DEFAULT_GLASS_DARK);
    lightSurface = ensureLightSurface(averageRgb(lightSlice) || DEFAULT_GLASS_LIGHT);
  }

  return {
    darkSurface: normalizeHexColor(darkSurface, DEFAULT_GLASS_DARK),
    lightSurface: normalizeHexColor(lightSurface, DEFAULT_GLASS_LIGHT),
  };
}

export async function extractThemeFromImageBuffer(buffer) {
  const sharp = await getSharp();
  if (!sharp) return null;
  const { data, info } = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize(64, 64, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const samples = [];
  for (let i = 0; i < data.length; i += info.channels) {
    samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  return extractThemeFromPixels(samples);
}

export async function extractThemeFromImageFile(filePath) {
  return extractThemeFromImageBuffer(await fs.promises.readFile(filePath));
}
