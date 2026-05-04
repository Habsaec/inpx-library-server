import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { getSetting } from '../db.js';

// --- Sharp concurrency limiter ---

const SHARP_CONCURRENCY_LIMIT = 6;
let _sharpActiveCount = 0;
const _sharpQueue = [];

export function acquireSharpSlot() {
  if (_sharpActiveCount < SHARP_CONCURRENCY_LIMIT) {
    _sharpActiveCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => _sharpQueue.push(resolve));
}

export function releaseSharpSlot() {
  if (_sharpQueue.length > 0) {
    const next = _sharpQueue.shift();
    next();
  } else {
    _sharpActiveCount--;
  }
}

// --- Cover thumbnail caching ---

export const ALLOWED_BOOK_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'
]);

const COVER_THUMB_WIDTH = config.coverMaxWidth;
const COVER_THUMB_HEIGHT = config.coverMaxHeight;

export function getCoverWidth() {
  const db = Number(getSetting('cover_max_width'));
  return db > 0 ? db : COVER_THUMB_WIDTH;
}

export function getCoverHeight() {
  const db = Number(getSetting('cover_max_height'));
  return db > 0 ? db : COVER_THUMB_HEIGHT;
}

export function getCoverQuality() {
  const db = Number(getSetting('cover_quality'));
  return (db >= 1 && db <= 100) ? db : config.coverQuality;
}

const COVER_THUMB_CACHE_TTL_MS = 30 * 60_000;
const COVER_THUMB_DISK_TTL_MS = 7 * 24 * 60 * 60_000;
const COVER_THUMB_DISK_DIR = path.join(config.dataDir, 'cover-thumb-cache');
const coverThumbCache = new Map();
let coverThumbDiskReady = false;

export function detectImageMimeFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0x0a) return 'image/jxl';
  if (
    buf.length >= 12 &&
    buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] === 0x0c &&
    buf[4] === 0x4a && buf[5] === 0x4c && buf[6] === 0x4c && buf[7] === 0x20 &&
    buf[8] === 0x0d && buf[9] === 0x0a && buf[10] === 0x87 && buf[11] === 0x0a
  ) {
    return 'image/jxl';
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf.length >= 12 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

export async function normalizeBookImageForClient(img) {
  const sourceType = detectImageMimeFromBuffer(img?.data) || String(img?.contentType || '').toLowerCase();
  if (ALLOWED_BOOK_IMAGE_TYPES.has(sourceType)) {
    return { contentType: sourceType, data: img.data };
  }
  await acquireSharpSlot();
  try {
    const converted = await sharp(img.data, { failOn: 'none' })
      .webp({ quality: getCoverQuality(), effort: 4 })
      .toBuffer();
    return { contentType: 'image/webp', data: converted };
  } catch {
    if (sourceType && sourceType.startsWith('image/')) {
      return { contentType: sourceType, data: img.data };
    }
    return null;
  } finally {
    releaseSharpSlot();
  }
}

export function getCachedCoverThumb(bookId) {
  const key = String(bookId || '').trim();
  if (!key) return null;
  const item = coverThumbCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > COVER_THUMB_CACHE_TTL_MS) {
    coverThumbCache.delete(key);
    return null;
  }
  // LRU promotion: move to end of insertion order
  coverThumbCache.delete(key);
  coverThumbCache.set(key, item);
  return item;
}

export function setCachedCoverThumb(bookId, contentType, data) {
  const key = String(bookId || '').trim();
  if (!key || !data?.length) return;
  coverThumbCache.set(key, { contentType, data, ts: Date.now() });
  if (coverThumbCache.size > 4000) {
    const oldest = coverThumbCache.keys().next().value;
    coverThumbCache.delete(oldest);
  }
}

function ensureCoverThumbDiskDir() {
  if (coverThumbDiskReady) return;
  fs.mkdirSync(COVER_THUMB_DISK_DIR, { recursive: true });
  coverThumbDiskReady = true;
}

/** Hierarchical path: cover-thumb-cache/ab/abcdef....webp */
function coverThumbDiskPath(bookId) {
  const key = String(bookId || '').trim();
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  const subDir = hash.slice(0, 2);
  return path.join(COVER_THUMB_DISK_DIR, subDir, `${hash}.webp`);
}

export async function getDiskCachedCoverThumb(bookId) {
  try {
    ensureCoverThumbDiskDir();
    const diskPath = coverThumbDiskPath(bookId);
    const stat = await fs.promises.stat(diskPath);
    if (Date.now() - stat.mtimeMs > COVER_THUMB_DISK_TTL_MS) {
      void fs.promises.unlink(diskPath).catch(() => {});
      return null;
    }
    const data = await fs.promises.readFile(diskPath);
    return data?.length ? { contentType: 'image/webp', data } : null;
  } catch {
    return null;
  }
}

export function setDiskCachedCoverThumb(bookId, contentType, data) {
  if (!data?.length) return;
  try {
    const diskPath = coverThumbDiskPath(bookId);
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.promises.writeFile(diskPath, data).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function invalidateCoverThumbCaches(bookId) {
  const key = String(bookId || '').trim();
  if (!key) return;
  coverThumbCache.delete(key);
  try {
    ensureCoverThumbDiskDir();
    void fs.promises.unlink(coverThumbDiskPath(bookId)).catch(() => {});
  } catch {
    /* ignore */
  }
}
