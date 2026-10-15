/**
 * Дисковый кэш FB2 с вшитыми иллюстрациями из Flibusta sidecar (images/*.zip|.7z).
 * Сборка книги с сотнями картинок занимает секунды, а читалка и скачивание просят её каждый раз.
 * Кэшируем только «дорогие» сборки (FB2_SIDECAR_CACHE_MIN_MS, по умолчанию 1500 мс); лежит рядом с
 * конверсиями в data/converted-books (их уборщик удаляет файлы старше 7 дней), плюс общий лимит
 * FB2_SIDECAR_CACHE_MB (по умолчанию 1024; 0 — кэш выключен).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const PREFIX = 'fb2-sidecar-';
const KEY_VERSION = 'v1'; // менять при смене способа сборки (формат/качество картинок)
const MIN_BUILD_MS = Math.max(0, Number.parseInt(String(process.env.FB2_SIDECAR_CACHE_MIN_MS ?? ''), 10) || 1500);
const MAX_BYTES = (() => {
  const mb = Number.parseInt(String(process.env.FB2_SIDECAR_CACHE_MB ?? ''), 10);
  return (Number.isFinite(mb) ? Math.max(0, mb) : 1024) * 1024 * 1024;
})();

const inflight = new Map();
const storing = new Set();

export function mergedFb2CacheEnabled() {
  return MAX_BYTES > 0 && Boolean(config.conversionCacheDir);
}

export function mergedFb2CacheKey(parts) {
  return crypto.createHash('sha1').update([KEY_VERSION, ...parts].join('\u0000')).digest('hex');
}

function cachePath(key) {
  return path.join(config.conversionCacheDir, `${PREFIX}${key}.fb2`);
}

export async function readMergedFb2(key) {
  if (!mergedFb2CacheEnabled()) return null;
  const file = cachePath(key);
  try {
    const buffer = await fs.promises.readFile(file);
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {}); // «свежесть» для LRU и 7-дневной уборки
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

async function pruneMergedFb2Cache() {
  const dir = config.conversionCacheDir;
  const files = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(PREFIX)) continue;
    try {
      const file = path.join(dir, entry.name);
      const stat = await fs.promises.stat(file);
      files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch { /* файл удалён параллельно */ }
  }
  let total = files.reduce((sum, f) => sum + f.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of files) {
    if (total <= MAX_BYTES) break;
    try {
      await fs.promises.unlink(f.file);
      total -= f.size;
    } catch { /* ignore */ }
  }
}

/** Сохраняет результат, если сборка заняла достаточно долго. Ошибки кэша не должны ломать отдачу книги. */
export function storeMergedFb2(key, buffer, buildMs) {
  if (!mergedFb2CacheEnabled() || buildMs < MIN_BUILD_MS || !buffer?.length || storing.has(key)) return;
  storing.add(key);
  const file = cachePath(key);
  const tmp = `${file}.${process.pid}.tmp`;
  (async () => {
    try {
      await fs.promises.mkdir(config.conversionCacheDir, { recursive: true });
      await fs.promises.writeFile(tmp, buffer);
      await fs.promises.rename(tmp, file);
      await pruneMergedFb2Cache();
    } catch (err) {
      fs.promises.unlink(tmp).catch(() => {});
      console.warn('[fb2-cache] store failed:', err?.message || err);
    } finally {
      storing.delete(key);
    }
  })();
}

/** Параллельные запросы одной книги (читалка + скачивание) делят одну сборку. */
export function withMergedFb2Lock(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(fn).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}
