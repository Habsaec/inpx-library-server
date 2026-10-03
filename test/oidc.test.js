import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  initDb,
  db,
  createUser,
  deleteUser,
  getUserByUsername,
  getOauthUser,
  resolveOrProvisionOidcUser,
  sanitizeOidcUsername,
  oidcAdminClaimMatches,
  changePassword,
  setOidcSettings,
  getOidcSettings,
  OIDC_PROVIDER,
  promoteUserToAdmin
} from '../src/db.js';
import { verifyPassword } from '../src/auth.js';
import {
  createOidcFlowCookie,
  parseOidcFlowCookie,
  safeOidcReturnTo,
  isOidcConfigured,
  getOidcFlowCookieName
} from '../src/services/oidc.js';
import { registerOidcRoutes } from '../src/routes/oidc.js';
import { createSessionValue } from '../src/services/session.js';

initDb();

const LOCAL_USER = 'oidclocaluser1';
const LOCAL_PASS = 'LocalPassw0rd!';
const OIDC_SUB = 'oidc-sub-test-001';
const OIDC_SUB_ADMIN = 'oidc-sub-admin-002';

function cleanupUsers(...names) {
  for (const name of names) {
    try { deleteUser(name); } catch { /* ignore */ }
  }
}

function setUserEmail(username, email) {
  db.prepare('UPDATE users SET email = ? WHERE username = ?').run(String(email || ''), username);
}

function trackLinked(sub, bucket) {
  const linked = getOauthUser(OIDC_PROVIDER, sub);
  if (linked?.username) bucket.push(linked.username);
}

describe('OIDC flow cookie', () => {
  it('roundtrips state/nonce/codeVerifier/returnTo', () => {
    const raw = createOidcFlowCookie({
      state: 'stateraw',
      nonce: 'nonceraw',
      codeVerifier: 'verifierraw',
      returnTo: '/favorites'
    });
    const parsed = parseOidcFlowCookie(raw);
    assert.ok(parsed);
    assert.equal(parsed.state, 'stateraw');
    assert.equal(parsed.nonce, 'nonceraw');
    assert.equal(parsed.codeVerifier, 'verifierraw');
    assert.equal(parsed.returnTo, '/favorites');
  });

  it('rejects tampered or empty cookie', () => {
    assert.equal(parseOidcFlowCookie(''), null);
    assert.equal(parseOidcFlowCookie('not.a.valid'), null);
    const good = createOidcFlowCookie({
      state: 's',
      nonce: 'n',
      codeVerifier: 'v',
      returnTo: '/'
    });
    const lastDot = good.lastIndexOf('.');
    const payload = good.slice(0, lastDot);
    const signature = good.slice(lastDot + 1);
    const flipped = signature[0] === 'a' ? 'b' : 'a';
    const tampered = `${payload}.${flipped}${signature.slice(1)}`;
    assert.equal(parseOidcFlowCookie(tampered), null);
  });

  it('safeOidcReturnTo blocks open redirects', () => {
    assert.equal(safeOidcReturnTo('/books'), '/books');
    assert.equal(safeOidcReturnTo('//evil.example'), '/');
    assert.equal(safeOidcReturnTo('https://evil.example'), '/');
    assert.equal(safeOidcReturnTo('\\evil'), '/');
  });
});

describe('OIDC username + admin claim helpers', () => {
  it('sanitizeOidcUsername normalizes preferred_username and email local-part', () => {
    assert.equal(sanitizeOidcUsername('Alice.Wonder'), 'alice.wonder');
    assert.ok(sanitizeOidcUsername('ab').length >= 5);
    assert.equal(sanitizeOidcUsername('reader@example.com'), 'reader');
  });

  it('oidcAdminClaimMatches supports string, list, and CSV claims', () => {
    assert.equal(oidcAdminClaimMatches({ groups: 'inpx-admins' }, 'groups', 'inpx-admins'), true);
    assert.equal(oidcAdminClaimMatches({ groups: ['a', 'inpx-admins'] }, 'groups', 'inpx-admins'), true);
    assert.equal(oidcAdminClaimMatches({ groups: 'a,inpx-admins,b' }, 'groups', 'inpx-admins'), true);
    assert.equal(oidcAdminClaimMatches({ groups: 'users' }, 'groups', 'inpx-admins'), false);
    assert.equal(oidcAdminClaimMatches({ groups: 'users' }, '', 'inpx-admins'), false);
  });
});

describe('OIDC resolveOrProvisionOidcUser', () => {
  const created = [];

  beforeEach(() => {
    for (const name of created.splice(0)) cleanupUsers(name);
    cleanupUsers(LOCAL_USER);
    trackLinked(OIDC_SUB, created);
    trackLinked(OIDC_SUB_ADMIN, created);
    for (const name of created.splice(0)) cleanupUsers(name);
  });

  after(() => {
    for (const name of created.splice(0)) cleanupUsers(name);
    cleanupUsers(LOCAL_USER);
    trackLinked(OIDC_SUB, created);
    trackLinked(OIDC_SUB_ADMIN, created);
    for (const name of created.splice(0)) cleanupUsers(name);
  });

  it('JIT creates user + oauth_users row with has_local_password=0', () => {
    const user = resolveOrProvisionOidcUser({
      sub: OIDC_SUB,
      email: 'oidc.jit@example.com',
      email_verified: true,
      preferred_username: 'Alice.Wonder'
    });
    created.push(user.username);
    assert.equal(Number(user.hasLocalPassword), 0);
    assert.equal(String(user.email || '').toLowerCase(), 'oidc.jit@example.com');
    const link = getOauthUser(OIDC_PROVIDER, OIDC_SUB);
    assert.ok(link);
    assert.equal(link.username, user.username);
  });

  it('reuses existing oauth link and does not create a second user', () => {
    const first = resolveOrProvisionOidcUser({
      sub: OIDC_SUB,
      email: 'oidc.jit2@example.com',
      email_verified: true,
      preferred_username: 'alice.wonder'
    });
    created.push(first.username);
    const second = resolveOrProvisionOidcUser({
      sub: OIDC_SUB,
      email: 'oidc.jit2@example.com',
      email_verified: true,
      preferred_username: 'other.name'
    });
    assert.equal(second.username, first.username);
  });

  it('refuses email collision with existing local account (no auto-link)', () => {
    createUser({ username: LOCAL_USER, password: LOCAL_PASS });
    setUserEmail(LOCAL_USER, 'taken@example.com');
    assert.throws(
      () => resolveOrProvisionOidcUser({
        sub: OIDC_SUB,
        email: 'taken@example.com',
        email_verified: true,
        preferred_username: 'newoidcuser'
      }),
      /OIDC_EMAIL_EXISTS/
    );
    assert.equal(getOauthUser(OIDC_PROVIDER, OIDC_SUB), undefined);
  });

  it('uses Synology `username` claim and configurable usernameClaim instead of sub', () => {
    const synology = resolveOrProvisionOidcUser({ sub: 'user_c4f4abcdef', username: 'synologyreader' });
    created.push(synology.username);
    assert.equal(synology.username, 'synologyreader');

    const custom = resolveOrProvisionOidcUser(
      { sub: 'user_c4f4fedcba', preferred_username: 'ignoredname', login: 'customloginname' },
      { usernameClaim: 'login' }
    );
    created.push(custom.username);
    assert.equal(custom.username, 'customloginname');
  });

  it('promotes to admin when claim matches, never demotes', () => {
    const user = resolveOrProvisionOidcUser(
      {
        sub: OIDC_SUB_ADMIN,
        email: 'oidc.admin@example.com',
        email_verified: true,
        preferred_username: 'oidcadminuser',
        groups: ['inpx-admins']
      },
      { adminClaim: 'groups', adminValue: 'inpx-admins' }
    );
    created.push(user.username);
    assert.equal(user.role, 'admin');

    const again = resolveOrProvisionOidcUser(
      {
        sub: OIDC_SUB_ADMIN,
        email: 'oidc.admin@example.com',
        email_verified: true,
        groups: ['users']
      },
      { adminClaim: 'groups', adminValue: 'inpx-admins' }
    );
    assert.equal(again.role, 'admin');
  });

  it('has_local_password=0 can set password without current, then verifyPassword works', () => {
    const user = resolveOrProvisionOidcUser({
      sub: OIDC_SUB,
      email: 'oidc.setpass@example.com',
      email_verified: true,
      preferred_username: 'oidcsetpass'
    });
    created.push(user.username);
    assert.equal(Number(user.hasLocalPassword), 0);
    assert.equal(verifyPassword('wrong-password', user.passwordHash), false);

    changePassword(user.username, 'NewOpdsPass1!');
    const fresh = getUserByUsername(user.username);
    assert.equal(Number(fresh.hasLocalPassword), 1);
    assert.equal(verifyPassword('NewOpdsPass1!', fresh.passwordHash), true);
  });

  it('rejects unverified email when required', () => {
    assert.throws(
      () => resolveOrProvisionOidcUser({
        sub: OIDC_SUB,
        email: 'unverified@example.com',
        email_verified: false,
        preferred_username: 'unverifieduser'
      }),
      /OIDC_EMAIL_UNVERIFIED/
    );
  });
});

describe('OIDC settings + disabled routes', () => {
  let server;
  let baseUrl;
  let prevSettings;

  before(async () => {
    prevSettings = getOidcSettings();
    setOidcSettings({
      enabled: false,
      issuer: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      scopes: 'openid profile email',
      adminClaim: '',
      adminValue: '',
      blockLocalRegister: false,
      requireEmailVerified: true
    });

    const app = express();
    app.use(cookieParser());
    registerOidcRoutes(app);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    setOidcSettings({
      enabled: prevSettings.enabled,
      issuer: prevSettings.issuer,
      clientId: prevSettings.clientId,
      clientSecret: prevSettings.clientSecret || undefined,
      redirectUri: prevSettings.redirectUri,
      scopes: prevSettings.scopes,
      adminClaim: prevSettings.adminClaim,
      adminValue: prevSettings.adminValue,
      blockLocalRegister: prevSettings.blockLocalRegister,
      requireEmailVerified: prevSettings.requireEmailVerified
    });
  });

  it('isOidcConfigured is false when disabled', () => {
    assert.equal(isOidcConfigured(getOidcSettings()), false);
  });

  it('GET /auth/oidc/start redirects to login when OIDC is off', async () => {
    const res = await fetch(`${baseUrl}/auth/oidc/start`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') || '';
    assert.match(location, /\/login\?oidc_error=OIDC_NOT_CONFIGURED/);
  });

  it('GET /auth/oidc/callback redirects to login when OIDC is off', async () => {
    const res = await fetch(`${baseUrl}/auth/oidc/callback?code=x&state=y`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') || '';
    assert.match(location, /\/login\?oidc_error=OIDC_NOT_CONFIGURED/);
  });
});

describe('OIDC callback session issue (claims → session cookie)', () => {
  it('createSessionValue works for JIT user (same contract as password login)', () => {
    const sub = 'oidc-sub-session-003';
    const linked = getOauthUser(OIDC_PROVIDER, sub);
    if (linked?.username) cleanupUsers(linked.username);

    const user = resolveOrProvisionOidcUser({
      sub,
      email: 'oidc.session@example.com',
      email_verified: true,
      preferred_username: 'oidcsession'
    });
    try {
      const cookie = createSessionValue(user.username, user.sessionGen || 0);
      assert.ok(cookie.includes('.'));
      assert.ok(cookie.length > 20);
    } finally {
      cleanupUsers(user.username);
    }
  });

  it('callback with valid flow cookie but failed token exchange clears flow and redirects safely', async () => {
    const prev = getOidcSettings();
    setOidcSettings({
      enabled: true,
      issuer: 'https://oidc.example.invalid/application/o/inpx/',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectUri: 'http://127.0.0.1/auth/oidc/callback',
      scopes: 'openid profile email'
    });

    const app = express();
    app.use(cookieParser());
    registerOidcRoutes(app);
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const flow = createOidcFlowCookie({
        state: 'cbstate',
        nonce: 'cbnonce',
        codeVerifier: 'cbverifier',
        returnTo: '/favorites'
      });
      const res = await fetch(`${baseUrl}/auth/oidc/callback?code=fake&state=cbstate`, {
        redirect: 'manual',
        headers: {
          cookie: `${getOidcFlowCookieName()}=${flow}`,
          host: `127.0.0.1:${server.address().port}`
        }
      });
      assert.equal(res.status, 302);
      const location = res.headers.get('location') || '';
      assert.match(location, /\/login\?oidc_error=/);
      assert.doesNotMatch(location, /test-secret|fake_access|id_token/i);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      setOidcSettings({
        enabled: prev.enabled,
        issuer: prev.issuer,
        clientId: prev.clientId,
        clientSecret: prev.clientSecret || undefined,
        redirectUri: prev.redirectUri,
        scopes: prev.scopes,
        adminClaim: prev.adminClaim,
        adminValue: prev.adminValue,
        blockLocalRegister: prev.blockLocalRegister,
        requireEmailVerified: prev.requireEmailVerified
      });
    }
  });
});

describe('Password login regression helper', () => {
  it('local password user still verifies after OIDC helpers run', () => {
    cleanupUsers(LOCAL_USER);
    createUser({ username: LOCAL_USER, password: LOCAL_PASS });
    try {
      const user = getUserByUsername(LOCAL_USER);
      assert.equal(Number(user.hasLocalPassword ?? 1), 1);
      assert.equal(verifyPassword(LOCAL_PASS, user.passwordHash), true);
      promoteUserToAdmin(LOCAL_USER);
      const admin = getUserByUsername(LOCAL_USER);
      assert.equal(admin.role, 'admin');
      assert.equal(verifyPassword(LOCAL_PASS, admin.passwordHash), true);
    } finally {
      cleanupUsers(LOCAL_USER);
    }
  });
});
