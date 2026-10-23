import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskLimiter, isServerBusyError } from '../src/services/heavy-task-limiter.js';
import { parseTrustProxy } from '../src/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('limiter runs at most max tasks at once and queues the rest in order', async () => {
  const limiter = createTaskLimiter({ name: 't', max: 2, maxQueue: 10, timeoutMs: 5_000 });
  let running = 0;
  let peak = 0;
  const order = [];
  const task = (id) => limiter.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(20);
    running--;
    order.push(id);
    return id;
  });
  const results = await Promise.all([1, 2, 3, 4, 5].map(task));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(order.slice(2), [3, 4, 5]);
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0, max: 2, maxQueue: 10 });
});

test('limiter refuses with SERVER_BUSY when the queue is full and frees the slot on errors', async () => {
  const limiter = createTaskLimiter({ name: 't', max: 1, maxQueue: 1, timeoutMs: 5_000 });
  const first = limiter.run(() => sleep(30).then(() => { throw new Error('boom'); }));
  const second = limiter.run(() => 'second');
  await assert.rejects(limiter.run(() => 'third'), (err) => isServerBusyError(err));
  await assert.rejects(first, /boom/);
  assert.equal(await second, 'second');
  assert.equal(limiter.stats().active, 0);
});

test('a queued task that waits too long is refused with SERVER_BUSY', async () => {
  const limiter = createTaskLimiter({ name: 't', max: 1, maxQueue: 5, timeoutMs: 20 });
  const slow = limiter.run(() => sleep(80));
  await assert.rejects(limiter.run(() => 'late'), (err) => isServerBusyError(err));
  await slow;
  assert.deepEqual(limiter.stats(), { active: 0, queued: 0, max: 1, maxQueue: 5 });
});

test('TRUST_PROXY accepts booleans, a proxy count and address lists', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('yes'), true);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
});
