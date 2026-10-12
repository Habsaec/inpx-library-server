import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  initDb, db, createUser, getUserByUsername, listUsers, setUserAccountEmail, assertAccountEmailAvailable,
  getUserByResetEmail, createPasswordResetToken
} from '../src/db.js';
import { registerUserApiRoutes } from '../src/routes/user-api.js';
import { registerProfileApiRoutes } from '../src/routes/profile-api.js';
import { renderLiteProfileSettings } from '../src/templates/lite.js';
import { renderProfileSettings } from '../src/templates/library.js';
import { renderAdminUsers } from '../src/templates/admin.js';
import { translateKnownErrorMessage } from '../src/i18n.js';

const A = 'acct_email_a';
const B = 'acct_email_b';

before(() => {
  initDb();
  for (const username of [A, B]) {
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      createUser({ username, password: 'AccountPass1!' });
    }
  }
  db.prepare("UPDATE users SET email = '' WHERE username IN (?, ?)").run(A, B);
});

test('account email is normalized, listed and can be cleared', () => {
  assert.equal(setUserAccountEmail(A, '  Reader.A@Example.COM '), 'reader.a@example.com');
  assert.equal(getUserByUsername(A).email, 'reader.a@example.com');
  assert.equal(listUsers().find((u) => u.username === A).email, 'reader.a@example.com');
  assert.equal(setUserAccountEmail(A, ''), '');
  assert.equal(getUserByUsername(A).email, '');
});

test('account email rejects invalid and duplicate addresses', () => {
  setUserAccountEmail(A, 'dup.a@example.com');
  assert.throws(() => setUserAccountEmail(B, 'not-an-email'), /Invalid email/);
  assert.throws(() => setUserAccountEmail(B, 'DUP.A@example.com'), /Email already in use/);
  assert.equal(assertAccountEmailAvailable(A, 'dup.a@example.com'), 'dup.a@example.com', 'owner may keep their own address');
  assert.throws(() => setUserAccountEmail('acct_email_missing', 'x@example.com'), /User not found/);
  assert.match(translateKnownErrorMessage('Email already in use'), /\S/);
  assert.notEqual(translateKnownErrorMessage('Email already in use'), 'Email already in use');
});

test('profile settings and admin users render the account email field', () => {
  const stats = { totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 0 };
  const profile = renderProfileSettings({
    user: { username: A, role: 'user' }, stats, indexStatus: {}, userStats: {},
    accountEmail: 'show.me@example.com'
  });
  assert.ok(profile.includes('action="/profile/account-email"'));
  assert.ok(profile.includes('name="accountEmail" value="show.me@example.com"'));

  const admin = renderAdminUsers({
    user: { username: 'root_admin', role: 'admin' }, stats, indexStatus: {},
    users: [{ username: A, role: 'user', createdAt: '2026-01-01 00:00:00', email: 'adm.view@example.com', ereaderEmail: '' }]
  });
  assert.ok(admin.includes('data-initial-account-email="adm.view@example.com"'));
  assert.ok(admin.includes('accountEmail__acct_email_a'));
});

test('password reset resolves by account email first, then e-reader email', () => {
  setUserAccountEmail(A, 'reset.a@example.com');
  db.prepare('UPDATE users SET ereader_email = ? WHERE username = ?').run('kindle.b@example.com', B);
  assert.equal(getUserByResetEmail('RESET.A@example.com').username, A);
  assert.equal(getUserByResetEmail('kindle.b@example.com').username, B, 'legacy e-reader lookup still works');
  assert.equal(getUserByResetEmail('nobody@example.com'), null);

  assert.equal(createPasswordResetToken(A, 'reset.a@example.com').email, 'reset.a@example.com');
  assert.equal(createPasswordResetToken(A).email, 'reset.a@example.com', 'defaults to the account email');
  assert.equal(createPasswordResetToken(B, 'kindle.b@example.com').email, 'kindle.b@example.com');
  db.prepare("UPDATE users SET ereader_email = '' WHERE username = ?").run(B);
  assert.throws(() => createPasswordResetToken(B), /not set/);
});

test('lite profile settings render the account email form', () => {
  const html = renderLiteProfileSettings({ user: { username: A }, accountEmail: 'lite.me@example.com' });
  assert.ok(html.includes('profile/account-email'));
  assert.ok(html.includes('name="accountEmail" value="lite.me@example.com"'));
});

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  registerUserApiRoutes(app, { batchEmailLocks: new Set() });
  registerProfileApiRoutes(app);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

const authHeaders = (username, extra = {}) => ({
  Authorization: `Basic ${Buffer.from(`${username}:AccountPass1!`).toString('base64')}`,
  ...extra
});

test('account email API: get, set, validation, conflict and profile field', async () => {
  const post = (username, email) => fetch(`${baseUrl}/api/account-email`, {
    method: 'POST', headers: authHeaders(username, { 'Content-Type': 'application/json' }), body: JSON.stringify({ email })
  });
  assert.equal((await fetch(`${baseUrl}/api/account-email`)).status, 401);

  const saved = await post(A, ' Api.A@Example.com ');
  assert.deepEqual(await saved.json(), { ok: true, email: 'api.a@example.com' });
  const got = await fetch(`${baseUrl}/api/account-email`, { headers: authHeaders(A) });
  assert.deepEqual(await got.json(), { email: 'api.a@example.com' });

  const bad = await post(B, 'nope');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'PROFILE_INVALID_EMAIL');
  const taken = await post(B, 'api.a@example.com');
  assert.equal(taken.status, 409);
  assert.equal((await taken.json()).code, 'PROFILE_EMAIL_TAKEN');

  const profile = await (await fetch(`${baseUrl}/api/profile`, { headers: authHeaders(A) })).json();
  assert.equal(profile.user.email, 'api.a@example.com');

  assert.deepEqual(await (await post(A, '')).json(), { ok: true, email: '' });
});

