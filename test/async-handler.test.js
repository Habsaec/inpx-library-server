import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asyncHandler } from '../src/utils/async-handler.js';

test('asyncHandler resolves and calls handler normally', async () => {
  const handler = async (req, res) => { res.json({ ok: true }); };
  const wrapped = asyncHandler(handler);
  const req = {};
  let jsonCalled = null;
  const res = { json: (v) => { jsonCalled = v; } };
  const nexts = [];
  const next = (err) => { nexts.push(err); };

  wrapped(req, res, next);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(jsonCalled, { ok: true });
  assert.equal(nexts.length, 0);
});

test('asyncHandler catches async errors and forwards to next(err)', async () => {
  const error = new Error('boom');
  const handler = async () => { throw error; };
  const wrapped = asyncHandler(handler);
  const nexts = [];
  const next = (err) => { nexts.push(err); };

  wrapped({}, {}, next);
  await new Promise((r) => setImmediate(r));

  assert.equal(nexts.length, 1);
  assert.equal(nexts[0], error);
});

test('asyncHandler catches rejected promises and forwards to next(err)', async () => {
  const error = new Error('reject');
  const handler = () => Promise.reject(error);
  const wrapped = asyncHandler(handler);
  const nexts = [];
  const next = (err) => { nexts.push(err); };

  wrapped({}, {}, next);
  await new Promise((r) => setImmediate(r));

  assert.equal(nexts.length, 1);
  assert.equal(nexts[0], error);
});
