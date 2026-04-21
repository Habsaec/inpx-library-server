/**
 * Authentication and authorization middleware.
 */
import basicAuth from 'basic-auth';
import { getUserByUsername, getSetting } from '../db.js';
import { verifyPassword } from '../auth.js';
import { parseSession, csrfTokenForSession, verifyCsrfToken } from '../services/session.js';
import { trackUser } from '../services/online-tracker.js';
import { CSRF_EXEMPT_PATHS, DUMMY_PASSWORD_HASH } from '../constants.js';
import { t } from '../i18n.js';
import { ApiErrorCode } from '../api-errors.js';

const SESSION_USER_CACHE_TTL_MS = 20_000;
const sessionUserCache = new Map();

function getCachedUser(username) {
  const key = String(username || '').trim();
  if (!key) return null;
  const cached = sessionUserCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    sessionUserCache.delete(key);
    return null;
  }
  return cached.user;
}

function setCachedUser(username, user) {
  const key = String(username || '').trim();
  if (!key || !user) return;
  sessionUserCache.set(key, {
    user,
    expiresAt: Date.now() + SESSION_USER_CACHE_TTL_MS
  });
  if (sessionUserCache.size > 2000) {
    const oldest = sessionUserCache.keys().next().value;
    if (oldest !== undefined) sessionUserCache.delete(oldest);
  }
}

/** Extract the authenticated user from the session cookie. */
export function getSessionUser(req) {
  const session = parseSession(req.cookies.session);
  if (!session) return null;

  let user = getCachedUser(session.username);
  if (!user) {
    user = getUserByUsername(session.username);
    if (user) setCachedUser(session.username, user);
  }
  if (!user?.passwordHash) return null;

  const currentGen = user.sessionGen || 0;
  if (session.sessionGen !== currentGen) return null;
  if (user.blocked) return null;

  return { username: user.username, role: user.role || 'user', sessionGen: user.sessionGen || 0 };
}

/** Attach user and CSRF token to every request. */
export function attachSessionUser(req, res, next) {
  const user = getSessionUser(req);
  req.user = user || null;
  req.csrfToken = user ? csrfTokenForSession(user.username, user.sessionGen || 0) : '';
  if (user?.username) {
    trackUser(user.username);
  }
  next();
}

/** CSRF guard for mutating requests. */
export function csrfGuard(req, res, next) {
  const method = req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

  const reqPath = req.path || '';
  if (CSRF_EXEMPT_PATHS.has(reqPath)) return next();
  if (!req.user) return next();

  const headerToken = req.get('x-csrf-token');
  const body = req.body;
  const bodyToken =
    body && typeof body === 'object' && !Buffer.isBuffer(body) && body._csrf !== undefined
      ? body._csrf
      : undefined;
  const token = headerToken || bodyToken;

  if (!verifyCsrfToken(req.user.username, req.user.sessionGen || 0, token)) {
    if (reqPath.startsWith('/api/')) {
      return res.status(403).json({ ok: false, code: ApiErrorCode.CSRF_INVALID, error: t('api.auth.csrfInvalid') });
    }
    return res.status(403).type('text').send(t('auth.csrfInvalid'));
  }
  next();
}

// --- Route-level guards ---

export function requireWebAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

export function requireApiAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  next();
}

export function requireAdminWeb(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.redirect('/admin/login');
  next();
}

export function requireAdminApi(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, code: ApiErrorCode.FORBIDDEN_ADMIN, error: t('api.auth.adminRequired') });
  }
  next();
}

function isAnonymousAllowed(key) {
  return getSetting(key) === '1';
}

export function requireBrowseAuth(req, res, next) {
  if (req.user?.username) {
    trackUser(req.user.username);
    return next();
  }
  if (isAnonymousAllowed('allow_anonymous_browse')) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireBrowseOrOpds(req, res, next) {
  if (req.user?.username) {
    trackUser(req.user.username);
    return next();
  }
  if (isAnonymousAllowed('allow_anonymous_browse')) return next();
  const isOpds = String(req.query?.opds || '') === '1';
  if (isOpds && isAnonymousAllowed('allow_anonymous_opds')) return next();
  // OPDS clients with Basic Auth
  if (isOpds) {
    const credentials = basicAuth(req);
    if (credentials) {
      const basicUser = getUserByUsername(credentials.name);
      if (basicUser && !basicUser.blocked && verifyPassword(credentials.pass, basicUser.passwordHash || DUMMY_PASSWORD_HASH)) {
        req.user = { username: basicUser.username, role: basicUser.role || 'user' };
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="INPX Library OPDS"');
    return res.status(401).send(t('api.auth.unauthorized'));
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireDownloadAuth(req, res, next) {
  if (req.user) return next();
  if (isAnonymousAllowed('allow_anonymous_download')) return next();
  const isOpds = String(req.query?.opds || '') === '1';
  if (isOpds && isAnonymousAllowed('allow_anonymous_opds')) return next();
  // OPDS clients with Basic Auth
  if (isOpds) {
    const credentials = basicAuth(req);
    if (credentials) {
      const basicUser = getUserByUsername(credentials.name);
      if (basicUser && !basicUser.blocked && verifyPassword(credentials.pass, basicUser.passwordHash || DUMMY_PASSWORD_HASH)) {
        req.user = { username: basicUser.username, role: basicUser.role || 'user' };
        return next();
      }
    }
    // Return 401 with WWW-Authenticate so OPDS clients can prompt for credentials
    res.set('WWW-Authenticate', 'Basic realm="INPX Library OPDS"');
    return res.status(401).send(t('api.auth.unauthorized'));
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireOpdsAuth(req, res, next) {
  const credentials = basicAuth(req);
  const basicUser = credentials ? getUserByUsername(credentials.name) : null;
  const basicValid = credentials ? verifyPassword(credentials.pass, basicUser?.passwordHash || DUMMY_PASSWORD_HASH) : false;
  const sessionUser = getSessionUser(req);
  const user = basicUser && basicValid && !basicUser.blocked
    ? { username: basicUser.username, role: basicUser.role || 'user' }
    : sessionUser;

  if (!user) {
    if (isAnonymousAllowed('allow_anonymous_opds')) {
      req.user = null;
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="INPX Library OPDS"');
    return res.status(401).send(t('api.auth.unauthorized'));
  }

  req.user = { username: user.username, role: user.role || 'user' };
  next();
}
