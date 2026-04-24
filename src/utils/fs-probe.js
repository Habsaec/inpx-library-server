/**
 * Cached fs.existsSync / fs.statSync wrapper.
 *
 * Горячие пути (/cover, /download, indexer) делают множество синхронных проверок
 * путей, что на сетевых FS (SMB/NFS) блокирует event-loop на каждый запрос.
 *
 * Этот модуль кэширует результат с TTL. Кэш сбрасывается через invalidate(path)
 * после любых мутаций (удаление архива источника, загрузка нового файла и т. п.).
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL_MS = 30_000;
const MAX_ENTRIES = 4000;

const _existsCache = new Map(); // key: abs path → { exists, expiresAt }
const _statCache = new Map();   // key: abs path → { stat|null, expiresAt }

function normalizeKey(p) {
  if (!p) return '';
  try { return path.resolve(String(p)); } catch { return String(p); }
}

function getCached(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit;
}

function setCached(map, key, entry) {
  map.set(key, entry);
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export function existsSyncCached(p, ttlMs = DEFAULT_TTL_MS) {
  const key = normalizeKey(p);
  if (!key) return false;
  const hit = getCached(_existsCache, key);
  if (hit) return hit.exists;
  const exists = fs.existsSync(key);
  setCached(_existsCache, key, { exists, expiresAt: Date.now() + ttlMs });
  return exists;
}

export function statSyncCached(p, ttlMs = DEFAULT_TTL_MS) {
  const key = normalizeKey(p);
  if (!key) return null;
  const hit = getCached(_statCache, key);
  if (hit) return hit.stat;
  let stat = null;
  try {
    stat = fs.statSync(key);
  } catch {
    stat = null;
  }
  setCached(_statCache, key, { stat, expiresAt: Date.now() + ttlMs });
  return stat;
}

/** Сбросить кэшированный результат по одному пути (после удаления/создания файла). */
export function invalidateFsProbe(p) {
  const key = normalizeKey(p);
  if (!key) return;
  _existsCache.delete(key);
  _statCache.delete(key);
}

/** Полный сброс (после индексации источника). */
export function clearFsProbeCache() {
  _existsCache.clear();
  _statCache.clear();
}
