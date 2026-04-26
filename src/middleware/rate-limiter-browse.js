/**
 * Token-bucket per-IP rate limiter для просмотра каталога / API.
 * Защищает от спам-запросов поиском и каталогом, которые блокируют event loop.
 */
import { getClientKey } from '../services/rate-limiter.js';

const BROWSE_WINDOW_MS = 60_000; // 1 минута
const envLimit = Number(process.env.BROWSE_RATE_LIMIT);
const BROWSE_MAX_HITS = Number.isFinite(envLimit) && envLimit > 0 ? Math.floor(envLimit) : 120; // запросов / мин
const MAX_TRACKED = 20_000;
const STALE_RECORD_MS = BROWSE_WINDOW_MS * 2;
const TOKENS_PER_MS = BROWSE_MAX_HITS / BROWSE_WINDOW_MS;

const hits = new Map(); // ip -> { tokens: number, lastRefillAt: number, lastSeenAt: number }

const EXEMPT_PATHS = new Set(['/health', '/health/perf', '/ready', '/api/index-status']);

function pruneOldHits() {
  const now = Date.now();
  for (const [key, record] of hits) {
    if (now - record.lastSeenAt > STALE_RECORD_MS) hits.delete(key);
  }
}

function refillTokens(record, now) {
  const elapsedMs = Math.max(0, now - record.lastRefillAt);
  if (elapsedMs <= 0) return;
  record.tokens = Math.min(BROWSE_MAX_HITS, record.tokens + elapsedMs * TOKENS_PER_MS);
  record.lastRefillAt = now;
}

// Чистка каждые 2 минуты
setInterval(pruneOldHits, 2 * 60_000).unref();

export function browseLimiter(req, res, next) {
  if (EXEMPT_PATHS.has(req.path)) return next();
  const key = getClientKey(req);
  const now = Date.now();

  let record = hits.get(key);
  if (!record) {
    if (hits.size >= MAX_TRACKED) pruneOldHits();
    if (hits.size >= MAX_TRACKED) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
    record = { tokens: BROWSE_MAX_HITS, lastRefillAt: now, lastSeenAt: now };
    hits.set(key, record);
  }

  refillTokens(record, now);
  record.lastSeenAt = now;

  if (record.tokens < 1) {
    const retryAfterSec = Math.max(1, Math.ceil((1 - record.tokens) / TOKENS_PER_MS / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'Слишком много запросов. Попробуйте через минуту.' });
  }
  record.tokens -= 1;
  next();
}
