import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stemRussianToken, expandSearchTokenVariants } from '../src/search-stem.js';

test('stemRussianToken strips common noun endings', () => {
  assert.equal(stemRussianToken('облаками'), 'облак');
  assert.equal(stemRussianToken('девочка'), 'девочк');
  assert.equal(stemRussianToken('пешком'), 'пешк');
});

test('stemRussianToken keeps short tokens', () => {
  assert.equal(stemRussianToken('над'), 'над');
  assert.equal(stemRussianToken('мир'), 'мир');
});

test('expandSearchTokenVariants uses one long stem prefix', () => {
  const groups = expandSearchTokenVariants(['облаками', 'над', 'небо']);
  assert.deepEqual(groups[0], ['облак']);
  assert.deepEqual(groups[1], ['над']);
  assert.deepEqual(groups[2], ['небо']);
});
