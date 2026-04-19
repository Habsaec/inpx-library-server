/**
 * Session management: creation, parsing, CSRF tokens.
 * All crypto operations use timing-safe comparison.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';

/** Sign a string value with HMAC-SHA256 using the session secret. */
function signValue(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

/** Create a signed session cookie value. */
export function createSessionValue(username, sessionGen = 0) {
  const payload = `${username}:${sessionGen}`;
  return `${payload}.${signValue(payload)}`;
}

/** Parse and verify a session cookie value. Returns { username, sessionGen } or null. */
export function parseSession(value) {
  if (!value || !value.includes('.')) return null;

  const lastDot = value.lastIndexOf('.');
  const payload = value.slice(0, lastDot);
  const signature = value.slice(lastDot + 1);
  if (!payload || !signature) return null;

  const expected = signValue(payload);
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  const colonIndex = payload.lastIndexOf(':');
  if (colonIndex === -1) {
    return { username: payload, sessionGen: 0 };
  }
  return {
    username: payload.slice(0, colonIndex),
    sessionGen: Number(payload.slice(colonIndex + 1)) || 0
  };
}

/** Generate a CSRF token bound to a specific user session. */
export function csrfTokenForSession(username, sessionGen) {
  const payload = `csrf:${username}:${sessionGen}`;
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');
}

/** Verify a CSRF token with timing-safe comparison. */
export function verifyCsrfToken(username, sessionGen, token) {
  if (!token || typeof token !== 'string') return false;
  const expected = csrfTokenForSession(username, sessionGen);
  const a = Buffer.from(String(token).trim(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
