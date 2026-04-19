/**
 * In-memory rate limiter for login attempts.
 * Tracks attempts per client IP with configurable window and max attempts.
 */
import { config } from '../config.js';

const loginAttempts = new Map();
const MAX_TRACKED_CLIENTS = 10_000;

/** Extract a client identifier from the request.
 *  When trust-proxy is off, req.ip is the raw socket address.
 *  X-Forwarded-For is NOT used as fallback — it is trivially spoofable. */
export function getClientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function getLoginAttemptState(key) {
  const now = Date.now();
  const existing = loginAttempts.get(key);
  if (!existing || now - existing.firstAttemptAt > config.loginWindowMs) {
    const fresh = { count: 0, firstAttemptAt: now };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return existing;
}

export function isRateLimited(req) {
  const key = getClientKey(req);
  const state = getLoginAttemptState(key);
  return state.count >= config.loginMaxAttempts;
}

export function registerFailedLogin(req) {
  // Prevent unbounded growth under DDoS
  if (loginAttempts.size > MAX_TRACKED_CLIENTS) {
    pruneExpiredEntries();
    if (loginAttempts.size > MAX_TRACKED_CLIENTS) return;
  }
  const key = getClientKey(req);
  const state = getLoginAttemptState(key);
  state.count += 1;
  loginAttempts.set(key, state);
}

export function clearLoginAttempts(req) {
  loginAttempts.delete(getClientKey(req));
}

/** Remove expired entries. Called periodically and on overflow. */
export function pruneExpiredEntries() {
  const now = Date.now();
  for (const [key, state] of loginAttempts) {
    if (now - state.firstAttemptAt > config.loginWindowMs) {
      loginAttempts.delete(key);
    }
  }
}
