/**
 * Публичные диагностические маршруты (до express.static).
 */
import { ApiErrorCode } from '../api-errors.js';
import { config } from '../config.js';
import { getIndexStatus } from '../inpx.js';

/**
 * @param {import('express').Application} app
 * @param {{ getCachedStats: () => unknown, getServiceValidation: () => { ok: boolean, checks: Record<string, boolean> }, getPerfSnapshot?: () => unknown }} deps
 */
export function registerHealthRoutes(app, deps) {
  const { getCachedStats, getServiceValidation, getPerfSnapshot } = deps;

  app.get('/health', (req, res) => {
    if (config.healthMinimal) {
      res.json({ ok: true });
      return;
    }
    res.json({ ok: true, service: 'inpx-library', time: new Date().toISOString(), port: config.port });
  });

  app.get('/api/index-status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ...getIndexStatus(),
      stats: getCachedStats(),
      port: config.port
    });
  });

  app.get('/ready', (req, res) => {
    const status = getIndexStatus();
    const validation = getServiceValidation();
    const ok = !status.error && validation.ok;
    const body = {
      ok,
      indexing: status.active,
      indexedAt: status.indexedAt,
      error: status.error || '',
      validation,
      port: config.port
    };
    if (!ok) body.code = ApiErrorCode.SERVICE_NOT_READY;
    res.status(ok ? 200 : 503).json(body);
  });

  app.get('/health/perf', (req, res) => {
    if (typeof getPerfSnapshot !== 'function') {
      return res.json({ ok: true, perf: null });
    }
    res.json({ ok: true, perf: getPerfSnapshot() });
  });
}
