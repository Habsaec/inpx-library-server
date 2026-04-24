/**
 * Lightweight in-memory runtime performance metrics.
 */

const ROUTE_SAMPLE_LIMIT = 120;
const MAX_ROUTES = 220;
const EVENT_LOOP_SAMPLE_LIMIT = 180;

const routeStats = new Map();
let totalRequests = 0;
let inFlight = 0;
let lastEventLoopLagMs = 0;
const eventLoopLagSamples = [];

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return Number(sorted[pos].toFixed(2));
}

function pushBounded(array, value, max) {
  array.push(value);
  if (array.length > max) array.shift();
}

function normalizeRouteLabel(req) {
  const routePath = req.route?.path;
  const baseUrl = req.baseUrl || '';
  if (routePath) {
    const route = typeof routePath === 'string' ? routePath : String(routePath);
    return `${req.method} ${baseUrl}${route}`;
  }
  const normalizedPath = String(req.path || '/')
    .replace(/\/[0-9a-f]{8,}/gi, '/:id')
    .replace(/\/[0-9]{2,}/g, '/:n')
    .replace(/\/[A-Za-z0-9_-]{20,}/g, '/:token');
  return `${req.method} ${normalizedPath}`;
}

function getOrCreateRouteStats(label) {
  let stats = routeStats.get(label);
  if (stats) return stats;
  if (routeStats.size >= MAX_ROUTES) {
    const oldest = routeStats.keys().next().value;
    if (oldest !== undefined) routeStats.delete(oldest);
  }
  stats = { count: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] };
  routeStats.set(label, stats);
  return stats;
}

export function createPerfMetricsMiddleware() {
  return function perfMetricsMiddleware(req, res, next) {
    totalRequests += 1;
    inFlight += 1;
    const startedAt = process.hrtime.bigint();
    let done = false;

    const finalize = () => {
      if (done) return;
      done = true;
      inFlight = Math.max(0, inFlight - 1);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const label = normalizeRouteLabel(req);
      const stats = getOrCreateRouteStats(label);
      stats.count += 1;
      if (res.statusCode >= 500) stats.errors += 1;
      stats.totalMs += durationMs;
      stats.maxMs = Math.max(stats.maxMs, durationMs);
      pushBounded(stats.samples, durationMs, ROUTE_SAMPLE_LIMIT);
    };

    res.on('finish', finalize);
    res.on('close', finalize);

    next();
  };
}

function sampleEventLoopLag() {
  const started = process.hrtime.bigint();
  setTimeout(() => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const lagMs = Math.max(0, elapsedMs - 10);
    lastEventLoopLagMs = Number(lagMs.toFixed(2));
    pushBounded(eventLoopLagSamples, lagMs, EVENT_LOOP_SAMPLE_LIMIT);
  }, 10).unref();
}

setInterval(sampleEventLoopLag, 10_000).unref();
sampleEventLoopLag();

export function getPerfSnapshot() {
  const routes = [...routeStats.entries()].map(([route, stats]) => ({
    route,
    count: stats.count,
    errors: stats.errors,
    avgMs: stats.count ? Number((stats.totalMs / stats.count).toFixed(2)) : 0,
    p95Ms: quantile(stats.samples, 0.95),
    maxMs: Number(stats.maxMs.toFixed(2))
  }));

  routes.sort((a, b) => b.p95Ms - a.p95Ms || b.avgMs - a.avgMs || b.count - a.count);

  return {
    totalRequests,
    inFlight,
    routeCount: routeStats.size,
    lastEventLoopLagMs,
    eventLoopLagP95Ms: quantile(eventLoopLagSamples, 0.95),
    hottestRoutes: routes.slice(0, 15)
  };
}
