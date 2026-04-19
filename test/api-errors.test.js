import test from 'node:test';
import assert from 'node:assert';
import { ApiErrorCode } from '../src/api-errors.js';

test('ApiErrorCode has expected auth-related values', () => {
  assert.strictEqual(ApiErrorCode.UNAUTHORIZED, 'UNAUTHORIZED');
  assert.strictEqual(ApiErrorCode.CSRF_INVALID, 'CSRF_INVALID');
  assert.strictEqual(ApiErrorCode.FORBIDDEN_ADMIN, 'FORBIDDEN_ADMIN');
});

test('ApiErrorCode batch codes are stable strings', () => {
  assert.strictEqual(ApiErrorCode.BATCH_NO_BOOKS, 'BATCH_NO_BOOKS');
  assert.strictEqual(ApiErrorCode.SEND_IN_PROGRESS, 'SEND_IN_PROGRESS');
  assert.strictEqual(ApiErrorCode.SERVICE_NOT_READY, 'SERVICE_NOT_READY');
});
