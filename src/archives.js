import path from 'node:path';
import unzipper from 'unzipper';
import {
  isSevenZipPath,
  listSevenZipEntries,
  readSevenZipEntry,
  testSevenZipArchive,
} from './seven-zip.js';
import { config } from './config.js';
import { ARCHIVE_MAX_ENTRY_BYTES } from './constants.js';
import { parseEnvTimeoutMs, promiseWithTimeout } from './utils/async-timeout.js';

const MAX_ARCHIVE_ENTRY_SIZE = ARCHIVE_MAX_ENTRY_BYTES;
const ZIP_OPEN_MS = parseEnvTimeoutMs('ARCHIVE_ZIP_OPEN_TIMEOUT_MS', 120_000);
const ZIP_DIRECTORY_CACHE_TTL_MS = 120_000;
const ZIP_DIRECTORY_CACHE_MAX = 24;
const SEVEN_ZIP_LIST_CACHE_TTL_MS = parseEnvTimeoutMs('SEVEN_ZIP_LIST_CACHE_TTL_MS', 120_000);
const SEVEN_ZIP_LIST_CACHE_MAX = Math.max(
  16,
  Number.parseInt(String(process.env.SEVEN_ZIP_LIST_CACHE_MAX || ''), 10) || 48
);

const zipDirectoryCache = new Map();
const zipDirectoryInflight = new Map();
const sevenZipListCache = new Map();
const sevenZipListInflight = new Map();

export function clearArchiveReadCaches() {
  zipDirectoryCache.clear();
  zipDirectoryInflight.clear();
  sevenZipListCache.clear();
  sevenZipListInflight.clear();
}

export function invalidateArchiveReadCache(archivePath) {
  const key = path.resolve(String(archivePath || ''));
  if (!key) return;
  zipDirectoryCache.delete(key);
  zipDirectoryInflight.delete(key);
  sevenZipListCache.delete(key);
  sevenZipListInflight.delete(key);
}

function normalizeEntryKey(p) {
  return String(p || '').replace(/\\/g, '/');
}

function findEntryInZipFiles(files, normalizedFileName) {
  const n = normalizedFileName.toLowerCase();
  return files.find(
    (item) =>
      item.type !== 'Directory' &&
      (item.path.toLowerCase() === n || item.path.toLowerCase().endsWith(`/${n}`))
  );
}

function buildZipEntryLookup(files = []) {
  const map = new Map();
  for (const item of files) {
    if (!item || item.type === 'Directory') continue;
    const key = String(item.path || '').replace(/\\/g, '/').toLowerCase();
    if (key && !map.has(key)) map.set(key, item);
    const idx = key.lastIndexOf('/');
    const tail = idx >= 0 ? key.slice(idx + 1) : key;
    if (tail && !map.has(tail)) map.set(tail, item);
  }
  return map;
}

function evictZipDirectoryCacheIfNeeded() {
  while (zipDirectoryCache.size > ZIP_DIRECTORY_CACHE_MAX) {
    const oldest = zipDirectoryCache.keys().next().value;
    if (oldest === undefined) break;
    zipDirectoryCache.delete(oldest);
  }
}

async function getZipDirectoryCached(archivePath) {
  const key = path.resolve(String(archivePath || ''));
  const now = Date.now();
  const cached = zipDirectoryCache.get(key);
  if (cached && cached.expiresAt > now) {
    // lightweight LRU bump
    zipDirectoryCache.delete(key);
    zipDirectoryCache.set(key, cached);
    return cached;
  }
  if (cached) zipDirectoryCache.delete(key);

  const inflight = zipDirectoryInflight.get(key);
  if (inflight) return inflight;

  const openPromise = (async () => {
    const directory = await promiseWithTimeout(
      unzipper.Open.file(archivePath),
      ZIP_OPEN_MS,
      `zip open ${path.basename(archivePath)}`
    );
    const payload = {
      directory,
      entryLookup: buildZipEntryLookup(directory.files),
      expiresAt: Date.now() + ZIP_DIRECTORY_CACHE_TTL_MS
    };
    zipDirectoryCache.set(key, payload);
    evictZipDirectoryCacheIfNeeded();
    return payload;
  })();
  zipDirectoryInflight.set(key, openPromise);
  try {
    return await openPromise;
  } finally {
    zipDirectoryInflight.delete(key);
  }
}

function findEntryInSevenList(entries, normalizedFileName) {
  const n = normalizedFileName.toLowerCase();
  return entries.find(
    (e) =>
      e.path.toLowerCase() === n || e.path.toLowerCase().endsWith(`/${n}`)
  );
}

function evictSevenZipListCacheIfNeeded() {
  while (sevenZipListCache.size > SEVEN_ZIP_LIST_CACHE_MAX) {
    const oldest = sevenZipListCache.keys().next().value;
    if (oldest === undefined) break;
    sevenZipListCache.delete(oldest);
  }
}

/**
 * Один вызов `7z l` на архив: при переборе имён в readFlibustaCover иначе каждый промах
 * заново листит весь .7z (очень медленно на больших covers/*.7z).
 */
async function getSevenZipEntriesCached(archivePath) {
  const key = path.resolve(String(archivePath || ''));
  const now = Date.now();
  const cached = sevenZipListCache.get(key);
  if (cached && cached.expiresAt > now) {
    sevenZipListCache.delete(key);
    sevenZipListCache.set(key, cached);
    return cached.entries;
  }
  if (cached) sevenZipListCache.delete(key);

  const inflight = sevenZipListInflight.get(key);
  if (inflight) return inflight;

  const openPromise = (async () => {
    const entries = await listSevenZipEntries(archivePath, config.sevenZipPath);
    if (!Array.isArray(entries)) {
      throw new Error(`7z list returned non-array for ${path.basename(archivePath)}`);
    }
    sevenZipListCache.set(key, {
      entries,
      expiresAt: Date.now() + SEVEN_ZIP_LIST_CACHE_TTL_MS
    });
    evictSevenZipListCacheIfNeeded();
    return entries;
  })();
  sevenZipListInflight.set(key, openPromise);
  try {
    return await openPromise;
  } finally {
    sevenZipListInflight.delete(key);
  }
}

/** Список файлов в ZIP или 7z (для индексации папок). */
export async function listArchiveFiles(archivePath) {
  if (isSevenZipPath(archivePath)) {
    return getSevenZipEntriesCached(archivePath);
  }
  const { directory } = await getZipDirectoryCached(archivePath);
  return directory.files
    .filter((f) => f.type !== 'Directory')
    .map((f) => ({
      path: normalizeEntryKey(f.path),
      uncompressedSize: f.uncompressedSize || 0,
    }));
}

/**
 * Прочитать один файл из ZIP или 7z (как readBookBuffer).
 */
export async function readArchiveEntryBuffer(archivePath, entryPath) {
  const normalized = normalizeEntryKey(entryPath);
  if (isSevenZipPath(archivePath)) {
    try {
      return await readSevenZipEntry(archivePath, normalized, config.sevenZipPath);
    } catch (first) {
      const entries = await getSevenZipEntriesCached(archivePath);
      const hit = findEntryInSevenList(entries, normalized);
      if (!hit) throw first;
      if (hit.uncompressedSize > MAX_ARCHIVE_ENTRY_SIZE) {
        throw new Error(
          `Book file too large: ${(hit.uncompressedSize / (1024 * 1024)).toFixed(1)} MB`
        );
      }
      return readSevenZipEntry(archivePath, hit.path, config.sevenZipPath);
    }
  }

  const { directory, entryLookup } = await getZipDirectoryCached(archivePath);
  const directHit = entryLookup.get(normalized.toLowerCase());
  const entry = directHit || findEntryInZipFiles(directory.files, normalized);
  if (!entry) {
    throw new Error(`Book file not found in archive: ${normalized}`);
  }
  if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_SIZE) {
    throw new Error(
      `Book file too large: ${(entry.uncompressedSize / (1024 * 1024)).toFixed(1)} MB`
    );
  }
  const uc = Number(entry.uncompressedSize) || 0;
  const bufMs = Math.min(600_000, 60_000 + Math.floor(uc / 25_000));
  return promiseWithTimeout(entry.buffer(), bufMs, `zip entry ${normalized}`);
}

/**
 * Validate archive integrity. Returns { ok: true } or { ok: false, error: string }.
 * For ZIP: tries to open and list entries.
 * For 7z: runs `7z t`.
 */
export async function validateArchiveIntegrity(archivePath) {
  try {
    if (isSevenZipPath(archivePath)) {
      return testSevenZipArchive(archivePath, config.sevenZipPath);
    }
    // ZIP: try to open and verify directory listing
    await promiseWithTimeout(
      unzipper.Open.file(archivePath),
      ZIP_OPEN_MS,
      `zip integrity ${path.basename(archivePath)}`
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
