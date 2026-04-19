import test from 'node:test';
import assert from 'node:assert';
import { safePage, safePositiveInt } from '../src/utils/safe-int.js';

test('safePage never returns NaN', () => {
  assert.strictEqual(safePage(undefined), 1);
  assert.strictEqual(safePage(''), 1);
  assert.strictEqual(safePage('3'), 3);
  assert.strictEqual(safePage('-1'), 1);
  assert.strictEqual(safePage('bogus'), 1);
});

test('safePositiveInt respects min', () => {
  assert.strictEqual(safePositiveInt(5, 1, 2), 5);
  assert.strictEqual(safePositiveInt(0, 10, 3), 10);
});
