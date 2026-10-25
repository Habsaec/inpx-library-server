import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { createSessionValue, parseSession } from '../src/services/session.js';

test('session cookie carries its issue time and expires on the server', () => {
  const now = Date.now();
  const cookie = createSessionValue('alice', 3, now);
  assert.deepEqual(parseSession(cookie, now + 1000), { username: 'alice', sessionGen: 3 });
  assert.equal(parseSession(cookie, now + config.sessionMaxAgeMs + 60_000), null, 'expired');
});

test('session cookie rejects a tampered issue time', () => {
  const now = Date.now();
  const cookie = createSessionValue('alice', 0, now - config.sessionMaxAgeMs - 60_000);
  const forged = cookie.replace(/^v2\|\d+/, `v2|${Math.floor(now / 1000)}`);
  assert.equal(parseSession(forged, now), null);
});

test('legacy session cookies without an issue time stay valid', () => {
  const payload = 'bob:2';
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
  assert.deepEqual(parseSession(`${payload}.${sig}`), { username: 'bob', sessionGen: 2 });
});
