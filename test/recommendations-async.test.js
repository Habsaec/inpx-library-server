import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb } from '../src/db.js';
import {
  getRecommendedLibraryView,
  getRecommendedLibraryViewAsync,
  invalidateRecommendationsCache,
} from '../src/services/recommendations.js';
import { stopQueryWorker } from '../src/services/query-pool.js';

test('recommendations: the async view waits for a cold pool instead of answering «computing»', async (t) => {
  initDb();
  t.after(() => stopQueryWorker());
  invalidateRecommendationsCache('admin');
  const cold = getRecommendedLibraryView({ username: 'admin', page: 1, pageSize: 10 });
  assert.equal(cold.computing, true, 'the sync view answers at once while the pool is built');

  invalidateRecommendationsCache('admin');
  const awaited = await getRecommendedLibraryViewAsync({ username: 'admin', page: 1, pageSize: 10 }, { waitMs: 20_000 });
  assert.equal(awaited.computing, false, 'the async view waited for the build');
  assert.ok(Array.isArray(awaited.items));

  // and the pool is now cached for the sync view too
  assert.equal(getRecommendedLibraryView({ username: 'admin', page: 1, pageSize: 10 }).computing, false);
});
