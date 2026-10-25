import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, upsertUser, deleteUser } from '../src/db.js';
import { csrfGuard, requireApiAuth } from '../src/middleware/auth.js';
import { clearLoginAttempts } from '../src/services/rate-limiter.js';
import { config } from '../src/config.js';

initDb();

function fakeReq({ headers = {}, user = null, authMethod = null, ip = '10.9.9.9', method = 'POST', path = '/api/x' } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method, path, ip, user, authMethod, body: {}, headers: lower, socket: {},
    get: (name) => lower[String(name).toLowerCase()]
  };
}

function fakeRes() {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.type = () => res;
  res.send = (body) => { res.body = body; return res; };
  return res;
}

function run(mw, req) {
  const res = fakeRes();
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { passed, res };
}

test('Basic auth skips CSRF for clients, but not for cross-site browser requests', () => {
  const user = { username: 'basic-csrf', role: 'admin' };
  assert.equal(run(csrfGuard, fakeReq({ user, authMethod: 'basic' })).passed, true, 'KOReader/app: no Sec-Fetch-Site');
  assert.equal(run(csrfGuard, fakeReq({ user, authMethod: 'basic', headers: { 'Sec-Fetch-Site': 'same-origin' } })).passed, true);
  const crossSite = run(csrfGuard, fakeReq({ user, authMethod: 'basic', headers: { 'Sec-Fetch-Site': 'cross-site' } }));
  assert.equal(crossSite.passed, false);
  assert.equal(crossSite.res.statusCode, 403);
  assert.equal(run(csrfGuard, fakeReq({ user, authMethod: 'device', headers: { 'Sec-Fetch-Site': 'cross-site' } })).passed, true);
});

test('failed Basic auth attempts are rate limited like the login form', () => {
  const username = 'basic-limit';
  upsertUser({ username, password: 'Right-password-1', role: 'user' });
  const auth = (pass) => ({ Authorization: `Basic ${Buffer.from(`${username}:${pass}`).toString('base64')}` });
  const ip = '10.8.8.8';
  try {
    assert.equal(run(requireApiAuth, fakeReq({ ip, headers: auth('Right-password-1') })).passed, true);
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      assert.equal(run(requireApiAuth, fakeReq({ ip, headers: auth('wrong') })).res.statusCode, 401);
    }
    assert.equal(run(requireApiAuth, fakeReq({ ip, headers: auth('Right-password-1') })).passed, false,
      'correct password is refused while the client is rate limited');
  } finally {
    clearLoginAttempts(fakeReq({ ip }));
    deleteUser(username);
  }
});
