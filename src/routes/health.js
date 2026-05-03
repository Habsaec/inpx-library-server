/**
 * Публичные диагностические маршруты (до express.static).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ApiErrorCode } from '../api-errors.js';
import { validateArchiveIntegrity } from '../archives.js';
import { config } from '../config.js';
import { getEnabledSources } from '../db.js';
import { getIndexStatus, getSourceRoot } from '../inpx.js';
import { promiseWithTimeout } from '../utils/async-timeout.js';

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

  app.get('/api/health/archives', async (req, res) => {
    const SAMPLE_SIZE = 5;
    const ENDPOINT_TIMEOUT_MS = 30_000;
    const PER_ARCHIVE_TIMEOUT_MS = 15_000;

    try {
      const result = await promiseWithTimeout(
        (async () => {
          const sources = getEnabledSources();
          // Collect unique archive files across all enabled sources
          const archivePaths = new Set();
          const sourceResults = { ok: [], degraded: [], errors: [] };
          for (const source of sources) {
            try {
              const root = getSourceRoot(source.id);
              if (!root || !fs.existsSync(root)) {
                sourceResults.errors.push({ id: source.id, name: source.name, error: 'Source directory not found' });
                continue;
              }
              const entries = fs.readdirSync(root);
              for (const entry of entries) {
                if (/\.(zip|7z)$/i.test(entry)) {
                  archivePaths.add(path.join(root, entry));
                }
              }
              sourceResults.ok.push({ id: source.id, name: source.name });
            } catch (err) {
              sourceResults.errors.push({ id: source.id, name: source.name, error: err.message });
            }
          }

          const all = [...archivePaths];
          const total = all.length;

          // Sample random archives
          const sampled = [];
          const pool = all.slice();
          const count = Math.min(SAMPLE_SIZE, pool.length);
          for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * pool.length);
            sampled.push(pool.splice(idx, 1)[0]);
          }

          let accessible = 0;
          const errors = [];
          await Promise.all(
            sampled.map(async (archivePath) => {
              try {
                const check = await promiseWithTimeout(
                  validateArchiveIntegrity(archivePath),
                  PER_ARCHIVE_TIMEOUT_MS,
                  `archive check ${path.basename(archivePath)}`
                );
                if (check.ok) {
                  accessible++;
                } else {
                  errors.push({ archive: path.basename(archivePath), error: check.error });
                }
              } catch (err) {
                errors.push({ archive: path.basename(archivePath), error: err.message || String(err) });
              }
            })
          );

          // Return degraded status if some sources failed
          if (sourceResults.errors.length > 0 && sourceResults.ok.length > 0) {
            return {
              ok: false,
              status: 'degraded',
              total,
              checked: sampled.length,
              accessible,
              healthy: sourceResults.ok.length,
              unhealthy: sourceResults.errors.length,
              sourceErrors: sourceResults.errors,
              errors
            };
          } else if (sourceResults.errors.length > 0 && sourceResults.ok.length === 0) {
            return {
              ok: false,
              status: 'unhealthy',
              total: 0,
              checked: 0,
              accessible: 0,
              sourceErrors: sourceResults.errors,
              errors: []
            };
          }

          return {
            ok: errors.length === 0,
            total,
            checked: sampled.length,
            accessible,
            errors
          };
        })(),
        ENDPOINT_TIMEOUT_MS,
        'archive health check'
      );
      const statusCode = result.status === 'unhealthy' ? 503 : 200;
      res.status(statusCode).json(result);
    } catch (err) {
      res.status(504).json({
        ok: false,
        total: 0,
        checked: 0,
        accessible: 0,
        errors: [{ archive: '*', error: err.message || 'Timeout' }]
      });
    }
  });
}
