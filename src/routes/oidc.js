/**
 * OIDC routes: /auth/oidc/start, /auth/oidc/callback
 */
import { config } from '../config.js';
import { createSessionValue } from '../services/session.js';
import {
  beginOidcLogin,
  completeOidcLogin,
  getOidcFlowCookieName,
  oidcFlowCookieOptions,
  parseOidcFlowCookie,
  isOidcConfigured,
  safeOidcReturnTo
} from '../services/oidc.js';
import {
  getOidcSettings,
  resolveOrProvisionOidcUser
} from '../db.js';
import { invalidateSessionUserCache } from '../middleware/auth.js';
import { logSystemEvent } from '../services/system-events.js';
import { getClientKey } from '../services/rate-limiter.js';

function oidcErrorRedirect(code) {
  const key = String(code || 'OIDC_FAILED');
  return `/login?oidc_error=${encodeURIComponent(key)}`;
}

function mapOidcError(err) {
  const msg = String(err?.message || err || '');
  if (msg === 'OIDC_NOT_CONFIGURED') return 'OIDC_NOT_CONFIGURED';
  if (msg === 'OIDC_EMAIL_EXISTS') return 'OIDC_EMAIL_EXISTS';
  if (msg === 'OIDC_EMAIL_UNVERIFIED') return 'OIDC_EMAIL_UNVERIFIED';
  if (msg === 'OIDC_USER_BLOCKED') return 'OIDC_USER_BLOCKED';
  if (msg === 'OIDC_MISSING_SUB' || msg === 'OIDC_FLOW_INVALID') return 'OIDC_FAILED';
  if (msg === 'OIDC_LINK_ORPHAN') return 'OIDC_FAILED';
  if (msg === 'EMAIL_EXISTS') return 'OIDC_EMAIL_EXISTS';
  return 'OIDC_FAILED';
}

function issueSession(res, user) {
  res.cookie('session', createSessionValue(user.username, user.sessionGen || 0), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.sessionSecureCookie,
    maxAge: config.sessionMaxAgeMs
  });
}

/**
 * @param {import('express').Application} app
 */
export function registerOidcRoutes(app) {
  app.get('/auth/oidc/start', async (req, res) => {
    try {
      const settings = getOidcSettings();
      if (!isOidcConfigured(settings)) {
        return res.redirect(oidcErrorRedirect('OIDC_NOT_CONFIGURED'));
      }
      const returnTo = safeOidcReturnTo(req.query.returnTo || '/');
      const { authorizationUrl, flowCookie } = await beginOidcLogin(req, { returnTo });
      res.cookie(getOidcFlowCookieName(), flowCookie, oidcFlowCookieOptions());
      return res.redirect(authorizationUrl);
    } catch (err) {
      logSystemEvent('error', 'auth', 'oidc start failed', {
        client: getClientKey(req),
        reason: mapOidcError(err)
      });
      return res.redirect(oidcErrorRedirect(mapOidcError(err)));
    }
  });

  app.get('/auth/oidc/callback', async (req, res) => {
    const clearFlow = () => {
      res.clearCookie(getOidcFlowCookieName(), { path: '/' });
    };
    try {
      const settings = getOidcSettings();
      if (!isOidcConfigured(settings)) {
        clearFlow();
        return res.redirect(oidcErrorRedirect('OIDC_NOT_CONFIGURED'));
      }
      if (req.query.error) {
        clearFlow();
        logSystemEvent('warn', 'auth', 'oidc provider error', {
          client: getClientKey(req),
          error: String(req.query.error || '')
        });
        return res.redirect(oidcErrorRedirect('OIDC_FAILED'));
      }

      const flow = parseOidcFlowCookie(req.cookies?.[getOidcFlowCookieName()]);
      if (!flow) {
        clearFlow();
        return res.redirect(oidcErrorRedirect('OIDC_FAILED'));
      }

      const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
      const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
      const currentUrl = new URL(`${proto}://${host}${req.originalUrl || req.url}`);

      const { claims } = await completeOidcLogin(req, currentUrl, flow);
      const user = resolveOrProvisionOidcUser(claims, {
        adminClaim: settings.adminClaim,
        adminValue: settings.adminValue,
        usernameClaim: settings.usernameClaim,
        requireEmailVerified: settings.requireEmailVerified
      });

      clearFlow();
      invalidateSessionUserCache(user.username);
      issueSession(res, user);
      logSystemEvent('info', 'auth', 'oidc login successful', {
        client: getClientKey(req),
        username: user.username,
        role: user.role
      });
      return res.redirect(safeOidcReturnTo(flow.returnTo));
    } catch (err) {
      clearFlow();
      const code = mapOidcError(err);
      logSystemEvent('warn', 'auth', 'oidc callback failed', {
        client: getClientKey(req),
        reason: code
      });
      return res.redirect(oidcErrorRedirect(code));
    }
  });
}
