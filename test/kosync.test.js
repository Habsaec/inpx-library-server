import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import { initDb, db, createUser, blockUser, deleteUser } from '../src/db.js';
import {
  partialMd5, createKosyncPassword, hasKosyncPassword, revokeKosyncPassword,
  verifyKosyncCredentials, rememberKosyncDocument
} from '../src/kosync.js';
import { registerKosyncRoutes } from '../src/routes/kosync.js';

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const USER = 'kosync_user';
const OTHER = 'kosync_other';

let server;
let baseUrl;

before(async () => {
  initDb();
  for (const username of [USER, OTHER]) {
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      createUser({ username, password: 'KosyncPass1!' });
    }
  }
  const app = express();
  app.use(express.json());
  registerKosyncRoutes(app);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('partialMd5 follows KOReader sampling (1 KiB at 0, 1024, 4096, 16384, ...)', () => {
  const small = Buffer.from('tiny book');
  assert.equal(partialMd5(small), md5(small), 'file below 1 KiB hashes whole');

  const buf = crypto.randomBytes(20000);
  const expected = md5(Buffer.concat([
    buf.subarray(0, 1024), buf.subarray(1024, 2048), buf.subarray(4096, 5120), buf.subarray(16384, 17408)
  ]));
  assert.equal(partialMd5(buf), expected);

  const tail = crypto.randomBytes(4096 + 100);
  assert.equal(partialMd5(tail), md5(Buffer.concat([tail.subarray(0, 1024), tail.subarray(1024, 2048), tail.subarray(4096)])),
    'short last sample is included, later offsets are skipped');
});

test('KOReader password: only the md5 of the generated password authenticates', () => {
  assert.equal(hasKosyncPassword(USER), false);
  assert.equal(verifyKosyncCredentials(USER, md5('KosyncPass1!')), false, 'account password is not a KOSync key');

  const password = createKosyncPassword(USER);
  assert.match(password, /^[a-z2-9]{14}$/);
  assert.equal(hasKosyncPassword(USER), true);
  assert.equal(verifyKosyncCredentials(USER, md5(password)), true);
  assert.equal(verifyKosyncCredentials(USER, md5(password).toUpperCase()), true);
  assert.equal(verifyKosyncCredentials(USER, md5('wrong')), false);
  assert.equal(verifyKosyncCredentials(OTHER, md5(password)), false);
  assert.equal(verifyKosyncCredentials('', ''), false);

  const reset = createKosyncPassword(USER);
  assert.equal(verifyKosyncCredentials(USER, md5(password)), false, 'reset invalidates the old password');
  assert.equal(verifyKosyncCredentials(USER, md5(reset)), true);

  assert.equal(revokeKosyncPassword(USER), 1);
  assert.equal(verifyKosyncCredentials(USER, md5(reset)), false);
});

test('KOSync routes: auth, progress roundtrip, empty progress, validation', async () => {
  const password = createKosyncPassword(USER);
  const headers = (extra = {}) => ({ 'x-auth-user': USER, 'x-auth-key': md5(password), ...extra });
  const doc = md5('some book');

  assert.equal((await fetch(`${baseUrl}/kosync/users/auth`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/kosync/users/auth`, { headers: { ...headers(), 'x-auth-key': md5('no') } })).status, 401);
  const ok = await fetch(`${baseUrl}/kosync/users/auth`, { headers: headers() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { authorized: 'OK' });

  const create = await fetch(`${baseUrl}/kosync/users/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x', password: 'y' })
  });
  assert.equal(create.status, 403);

  const empty = await fetch(`${baseUrl}/kosync/syncs/progress/${doc}`, { headers: headers() });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {});

  const put = await fetch(`${baseUrl}/kosync/syncs/progress`, {
    method: 'PUT',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ document: doc, progress: '/body/DocFragment[3]/p[7].0', percentage: 0.4231, device: 'Kobo', device_id: 'abc' })
  });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.document, doc);
  assert.ok(Number.isInteger(putBody.timestamp));

  const got = await (await fetch(`${baseUrl}/kosync/syncs/progress/${doc}`, { headers: headers() })).json();
  assert.equal(got.document, doc);
  assert.equal(got.progress, '/body/DocFragment[3]/p[7].0');
  assert.equal(got.percentage, 0.4231);
  assert.equal(got.device, 'Kobo');
  assert.equal(got.device_id, 'abc');

  const otherPass = createKosyncPassword(OTHER);
  const foreign = await fetch(`${baseUrl}/kosync/syncs/progress/${doc}`, {
    headers: { 'x-auth-user': OTHER, 'x-auth-key': md5(otherPass) }
  });
  assert.deepEqual(await foreign.json(), {}, 'progress is per user');

  const bad = await fetch(`${baseUrl}/kosync/syncs/progress`, {
    method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ document: 'a:b', percentage: 1 })
  });
  assert.equal(bad.status, 403);
});

test('blocked users cannot sync and deleting a user drops key and progress', () => {
  const name = 'kosync_temp';
  createUser({ username: name, password: 'KosyncPass1!' });
  const password = createKosyncPassword(name);
  assert.equal(verifyKosyncCredentials(name, md5(password)), true);
  blockUser(name);
  assert.equal(verifyKosyncCredentials(name, md5(password)), false);
  deleteUser(name);
  assert.equal(hasKosyncPassword(name), false);
});

test('rememberKosyncDocument stores the download hash once and ignores non-buffers', () => {
  const buf = crypto.randomBytes(3000);
  rememberKosyncDocument('1:remember', buf);
  rememberKosyncDocument('1:remember', buf);
  rememberKosyncDocument('1:ignored', 'not a buffer');
  const rows = db.prepare('SELECT document, book_id FROM kosync_documents WHERE book_id LIKE ?').all('1:%');
  assert.deepEqual(rows, [{ document: partialMd5(buf), book_id: '1:remember' }]);
});

test('profile settings render the KOReader sync block', async () => {
  const { renderProfileSettings } = await import('../src/templates/library.js');
  const stats = { totalBooks: 0, totalAuthors: 0, totalSeries: 0, totalGenres: 0, totalLanguages: 0 };
  const off = renderProfileSettings({ user: { username: USER, role: 'user' }, stats, indexStatus: {}, userStats: {}, kosyncUrl: 'http://lib.local/kosync' });
  assert.ok(off.includes('<code>http://lib.local/kosync</code>'));
  assert.ok(off.includes('action="/profile/kosync-password"'));
  assert.ok(!off.includes('/profile/kosync-password/revoke'));

  const on = renderProfileSettings({ user: { username: USER, role: 'user' }, stats, indexStatus: {}, userStats: {}, kosyncUrl: 'http://lib.local/kosync', kosyncHasPassword: true });
  assert.ok(on.includes('action="/profile/kosync-password/revoke"'));
});
