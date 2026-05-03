/**
 * In-memory page data cache with TTL and LRU-like eviction.
 */
import { PAGE_CACHE_MAX, PAGE_CACHE_TTL_MS } from '../constants.js';

const pageDataCache = new Map();
const refreshing = new Set();

/**
 * Get or compute a cached value.
 * @param {string} key
 * @param {() => any} compute
 * @param {number} [ttlMs]
 * @returns {any}
 */
export function getCachedPageData(key, compute, ttlMs = PAGE_CACHE_TTL_MS) {
  const now = Date.now();
  const cached = pageDataCache.get(key);
  if (cached && now - cached.createdAt < ttlMs) {
    // True LRU behavior: promote on access.
    pageDataCache.delete(key);
    pageDataCache.set(key, cached);
    return cached.value;
  }
  if (cached) {
    pageDataCache.delete(key);
  }
  if (pageDataCache.size >= PAGE_CACHE_MAX) {
    const oldest = pageDataCache.keys().next().value;
    if (oldest !== undefined) pageDataCache.delete(oldest);
  }
  const value = compute();
  pageDataCache.set(key, { value, createdAt: now });
  return value;
}

/**
 * Stale-while-revalidate variant of getCachedPageData.
 * - Fresh hit (age < ttlMs)        → return value instantly.
 * - Stale hit (age >= ttlMs)       → return stale value instantly + rebuild in background.
 * - Cold miss (no cache at all)    → return `fallback` instantly + rebuild in background.
 *
 * The page renders immediately; data fills in on the next visit.
 *
 * @template T
 * @param {string} key
 * @param {() => T} compute
 * @param {number} ttlMs
 * @param {T} fallback
 * @returns {T}
 */
export function getStaleOrSchedule(key, compute, ttlMs = PAGE_CACHE_TTL_MS, fallback = null) {
  const now = Date.now();
  const cached = pageDataCache.get(key);
  if (cached && now - cached.createdAt < ttlMs) {
    // Fresh hit
    pageDataCache.delete(key);
    pageDataCache.set(key, cached);
    return cached.value;
  }
  if (cached) {
    // Stale hit — return stale data instantly, refresh in background
    scheduleRefresh(key, compute);
    return cached.value;
  }
  // Cold miss — compute synchronously to avoid empty page
  try {
    if (pageDataCache.size >= PAGE_CACHE_MAX) {
      const oldest = pageDataCache.keys().next().value;
      if (oldest !== undefined) pageDataCache.delete(oldest);
    }
    const value = compute();
    pageDataCache.set(key, { value, createdAt: now });
    return value;
  } catch (err) {
    console.error(`[cache] sync compute failed for ${key}:`, err?.message || err);
    return fallback;
  }
}

function scheduleRefresh(key, compute) {
  if (refreshing.has(key)) return;
  refreshing.add(key);
  setImmediate(() => {
    try {
      const value = compute();
      if (pageDataCache.size >= PAGE_CACHE_MAX) {
        const oldest = pageDataCache.keys().next().value;
        if (oldest !== undefined && oldest !== key) pageDataCache.delete(oldest);
      }
      pageDataCache.set(key, { value, createdAt: Date.now() });
    } catch (error) {
      console.error(`[cache] background refresh failed for ${key}:`, error?.message || error);
    } finally {
      refreshing.delete(key);
    }
  });
}

export function clearPageDataCache() {
  pageDataCache.clear();
}

/** Сброс кэша главной для одного пользователя (история / продолжить чтение). */
export function invalidateHomeUserSnapshot(username) {
  const u = String(username || '').trim();
  if (!u) return;
  pageDataCache.delete(`home:userSnap:${u}`);
  pageDataCache.delete(`home:readIds:${u}`);
  // Also drop per-user paged caches for the 'continue' and 'read' library views
  // (keys like `library:continue:${u}:p1:s6`). Without this, opening a new book
  // in the reader does NOT refresh the "Продолжить чтение" block on the home
  // page until PAGE_CACHE_TTL_MS (15 min) expires — the cached empty result
  // from the first visit kept the block empty forever.
  const continuePrefix = `library:continue:${u}:`;
  const readPrefix = `library:read:${u}:`;
  for (const key of pageDataCache.keys()) {
    if (key.startsWith(continuePrefix) || key.startsWith(readPrefix)) {
      pageDataCache.delete(key);
    }
  }
}

/**
 * Сброс кэша страницы /favorites для юзера (все view × sort комбинации).
 * Использует префикс `favorites:${username}:`.
 */
export function invalidateFavoritesPage(username) {
  const u = String(username || '').trim();
  if (!u) return;
  const prefix = `favorites:${u}:`;
  for (const key of pageDataCache.keys()) {
    if (key.startsWith(prefix)) pageDataCache.delete(key);
  }
}

/**
 * Комбинированный сброс всех per-user кэшей страниц при действии юзера.
 * Зовётся из роутов bookmark / read / favorite toggle.
 */
export function invalidateUserPageCaches(username) {
  invalidateHomeUserSnapshot(username);
  invalidateFavoritesPage(username);
}
