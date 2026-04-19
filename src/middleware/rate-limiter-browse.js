/**
 * Sliding-window per-IP rate limiter для просмотра каталога / API.
 * Защищает от спам-запросов поиском и каталогом, которые блокируют event loop.
 */
import { getClientKey } from '../services/rate-limiter.js';

const BROWSE_WINDOW_MS = 60_000; // 1 минута
const BROWSE_MAX_HITS = Number(process.env.BROWSE_RATE_LIMIT) || 120; // запросов / мин
const MAX_TRACKED = 20_000;

const hits = new Map(); // ip -> { timestamps: number[] }

function pruneOldHits() {
  const now = Date.now();
  for (const [key, record] of hits) {
    record.timestamps = record.timestamps.filter(ts => now - ts < BROWSE_WINDOW_MS);
    if (record.timestamps.length === 0) hits.delete(key);
  }
}

// Чистка каждые 2 минуты
setInterval(pruneOldHits, 2 * 60_000).unref();

export function browseLimiter(req, res, next) {
  const key = getClientKey(req);
  const now = Date.now();

  let record = hits.get(key);
  if (!record) {
    if (hits.size >= MAX_TRACKED) pruneOldHits();
    record = { timestamps: [] };
    hits.set(key, record);
  }

  // Отсекаем старые записи за пределами окна
  record.timestamps = record.timestamps.filter(ts => now - ts < BROWSE_WINDOW_MS);
  record.timestamps.push(now);

  if (record.timestamps.length > BROWSE_MAX_HITS) {
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Слишком много запросов. Попробуйте через минуту.' });
  }
  next();
}
