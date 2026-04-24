/**
 * In-memory page data cache with TTL and LRU-like eviction.
 */
import { PAGE_CACHE_MAX, PAGE_CACHE_TTL_MS } from '../constants.js';

const pageDataCache = new Map();

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

export function clearPageDataCache() {
  pageDataCache.clear();
}

/** Сброс кэша главной для одного пользователя (история / продолжить чтение). */
export function invalidateHomeUserSnapshot(username) {
  const u = String(username || '').trim();
  if (!u) return;
  pageDataCache.delete(`home:userSnap:${u}`);
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
