import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSE_WINDOW_MS,
  BROWSE_MAX_HITS_DEFAULT,
  BROWSE_MAX_TRACKED,
  BROWSE_PRUNE_INTERVAL_MS,
  COVER_WIDTH_DEFAULT,
  COVER_HEIGHT_DEFAULT,
  COVER_QUALITY_DEFAULT,
  CARD_CACHE_MAX,
  CARD_CACHE_TTL_MS,
} from '../src/constants.js';

test('rate limiting constants are defined', () => {
  assert.equal(BROWSE_WINDOW_MS, 60_000);
  assert.equal(BROWSE_MAX_HITS_DEFAULT, 120);
  assert.equal(BROWSE_MAX_TRACKED, 20_000);
  assert.equal(BROWSE_PRUNE_INTERVAL_MS, 120_000);
});

test('cover constants are defined', () => {
  assert.equal(COVER_WIDTH_DEFAULT, 220);
  assert.equal(COVER_HEIGHT_DEFAULT, 320);
  assert.equal(COVER_QUALITY_DEFAULT, 86);
});

test('cache constants are defined', () => {
  assert.equal(CARD_CACHE_MAX, 3000);
  assert.equal(CARD_CACHE_TTL_MS, 600_000);
});
