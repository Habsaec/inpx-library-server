import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestId } from '../src/middleware/request-id.js';

function createReq(headers = {}) {
  return { get: (h) => headers[h.toLowerCase()] };
}

test('requestId generates UUID when no client id provided', () => {
  const req = createReq();
  let setKey = null;
  let setVal = null;
  const res = { set: (k, v) => { setKey = k; setVal = v; } };
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  requestId(req, res, next);

  assert.match(req.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(setKey, 'x-request-id');
  assert.equal(setVal, req.id);
  assert.equal(nextCalled, true);
});

test('requestId propagates valid client-provided id', () => {
  const req = createReq({ 'x-request-id': 'abc-123-def' });
  let setKey = null;
  let setVal = null;
  const res = { set: (k, v) => { setKey = k; setVal = v; } };
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  requestId(req, res, next);

  assert.equal(req.id, 'abc-123-def');
  assert.equal(setKey, 'x-request-id');
  assert.equal(setVal, 'abc-123-def');
  assert.equal(nextCalled, true);
});

test('requestId ignores invalid client id and generates new one', () => {
  const longId = 'way-too-long-id-' + 'x'.repeat(100);
  const req = createReq({ 'x-request-id': longId });
  let setVal = null;
  const res = { set: (_k, v) => { setVal = v; } };
  let nextCalled = false;
  const next = () => { nextCalled = true; };

  requestId(req, res, next);

  assert.notEqual(req.id, longId);
  assert.equal(setVal, req.id);
  assert.equal(nextCalled, true);
});
