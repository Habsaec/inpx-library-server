/**
 * OpenID Connect client helpers (Authentik-compatible).
 * Uses openid-client for discovery, PKCE, and token validation.
 */
import crypto from 'node:crypto';
import * as openidClient from 'openid-client';
import { config } from '../config.js';
import { getOidcSettings } from '../db.js';

const OIDC_STATE_COOKIE = 'oidc_flow';
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const discoveryCache = new Map();

function signPayload(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
}

/** Create a signed short-lived OIDC flow cookie value. */
export function createOidcFlowCookie({ state, nonce, codeVerifier, returnTo = '/' }) {
  const exp = Date.now() + OIDC_STATE_TTL_MS;
  const body = JSON.stringify({
    state: String(state),
    nonce: String(nonce),
    codeVerifier: String(codeVerifier),
    returnTo: String(returnTo || '/').startsWith('/') ? String(returnTo || '/') : '/',
    exp
  });
  const payload = Buffer.from(body, 'utf8').toString('base64url');
  return `${payload}.${signPayload(payload)}`;
}

/** Parse and verify OIDC flow cookie. Returns null if invalid/expired. */
export function parseOidcFlowCookie(value) {
  if (!value || !value.includes('.')) return null;
  const lastDot = value.lastIndexOf('.');
  const payload = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  if (!payload || !signature) return null;
  const expected = signPayload(payload);
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const raw = Buffer.from(payload, 'base64url').toString('utf8');
    const data = JSON.parse(raw);
    if (!data?.state || !data?.nonce || !data?.codeVerifier || !data?.exp) return null;
    if (Number(data.exp) < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function oidcFlowCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.sessionSecureCookie,
    path: '/',
    maxAge: OIDC_STATE_TTL_MS
  };
}

export function getOidcFlowCookieName() {
  return OIDC_STATE_COOKIE;
}

export function resolveOidcRedirectUri(req, settings = getOidcSettings()) {
  if (settings.redirectUri) return settings.redirectUri;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}/auth/oidc/callback`;
}

export function isOidcConfigured(settings = getOidcSettings()) {
  return Boolean(
    settings.enabled
    && settings.issuer
    && settings.clientId
    && settings.clientSecret
  );
}

async function getConfiguration(settings = getOidcSettings()) {
  if (!isOidcConfigured(settings)) {
    throw new Error('OIDC_NOT_CONFIGURED');
  }
  const cacheKey = `${settings.issuer}|${settings.clientId}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && cached.ts > Date.now() - 5 * 60 * 1000) {
    return cached.config;
  }
  const server = await openidClient.discovery(
    new URL(settings.issuer),
    settings.clientId,
    settings.clientSecret
  );
  discoveryCache.set(cacheKey, { ts: Date.now(), config: server });
  return server;
}

export function clearOidcDiscoveryCache() {
  discoveryCache.clear();
}

/**
 * Build IdP authorization redirect URL and flow cookie payload.
 */
export async function beginOidcLogin(req, { returnTo = '/' } = {}) {
  const settings = getOidcSettings();
  if (!isOidcConfigured(settings)) throw new Error('OIDC_NOT_CONFIGURED');
  const redirectUri = resolveOidcRedirectUri(req, settings);
  if (!redirectUri) throw new Error('OIDC_REDIRECT_MISSING');

  const server = await getConfiguration(settings);
  const codeVerifier = openidClient.randomPKCECodeVerifier();
  const codeChallenge = await openidClient.calculatePKCECodeChallenge(codeVerifier);
  const state = openidClient.randomState();
  const nonce = openidClient.randomNonce();

  const authorizationUrl = openidClient.buildAuthorizationUrl(server, {
    redirect_uri: redirectUri,
    scope: settings.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce
  });

  const flowCookie = createOidcFlowCookie({
    state,
    nonce,
    codeVerifier,
    returnTo
  });

  return { authorizationUrl: authorizationUrl.href, flowCookie };
}

/**
 * Exchange callback for claims (validated id_token via openid-client).
 */
export async function completeOidcLogin(req, currentUrl, flow) {
  const settings = getOidcSettings();
  if (!isOidcConfigured(settings)) throw new Error('OIDC_NOT_CONFIGURED');
  if (!flow?.state || !flow?.nonce || !flow?.codeVerifier) throw new Error('OIDC_FLOW_INVALID');

  const server = await getConfiguration(settings);
  const tokens = await openidClient.authorizationCodeGrant(
    server,
    currentUrl instanceof URL ? currentUrl : new URL(String(currentUrl)),
    {
      pkceCodeVerifier: flow.codeVerifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true
    }
  );

  const idClaims = tokens.claims();
  if (!idClaims?.sub) throw new Error('OIDC_MISSING_SUB');

  // Some IdPs (Synology SSO Server) put username/email/groups only in userinfo, not in id_token.
  // id_token values win; userinfo only fills gaps. Failure is non-fatal.
  let userinfo = {};
  if (tokens.access_token) {
    try {
      userinfo = await openidClient.fetchUserInfo(server, tokens.access_token, idClaims.sub);
    } catch (err) {
      console.warn('[oidc] userinfo fetch failed:', err?.message || err);
    }
  }
  const claims = { ...userinfo, ...idClaims };
  console.log(`[oidc] claims: id_token=[${Object.keys(idClaims).join(',')}] userinfo=[${Object.keys(userinfo).join(',')}]`);
  return { claims, settings };
}

export function safeOidcReturnTo(value) {
  const path = String(value || '/');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
  return path;
}
