/**
 * Authentication and authorization middleware.
 */
import crypto from 'crypto';
import basicAuth from 'basic-auth';
import { getUserByUsername, getSetting, getMeta } from '../db.js';
import { verifyPassword } from '../auth.js';
import { parseSession, csrfTokenForSession, verifyCsrfToken } from '../services/session.js';
import { trackUser } from '../services/online-tracker.js';
import { isRateLimited, registerFailedLogin } from '../services/rate-limiter.js';
import { logSystemEvent } from '../services/system-events.js';
import { CSRF_EXEMPT_PATHS, DUMMY_PASSWORD_HASH, SESSION_USER_CACHE_TTL_MS, SESSION_USER_CACHE_MAX } from '../constants.js';
import { t } from '../i18n.js';
import { ApiErrorCode } from '../api-errors.js';

/* ── OPDS auth helpers (общие для requireOpdsAuth, requireBrowseOrOpds, requireDownloadAuth) ──
 * Сложилось так, что три функции дублировали почти одинаковую логику Basic Auth.
 * Выношу её в helper, плюс добавляю диагностический лог: без него админ при 401
 * видит только «Unauthorized» и не понимает, в чём дело (неверный логин? пароль?
 * заблокирован?). Лог идёт в system_events → доступен в админке. */

/**
 * Попытка авторизовать OPDS-клиент по Basic Auth.
 * Возвращает либо `{ ok: true, user }`, либо `{ ok: false, reason }` с одним из:
 *   'no-credentials' | 'unknown-user' | 'no-password-hash' | 'blocked' | 'wrong-password'
 * Никаких side-effects на response — это решает caller.
 */
/* OPDS-клиенты и приложение шлют Basic на каждый запрос, а scryptSync держит event loop десятки мс
   (на Raspberry Pi — больше). Успешную проверку помним недолго; ключ включает текущий хеш пароля,
   так что смена пароля сразу делает запись бесполезной. Блокировка проверяется по строке users каждый раз. */
const BASIC_AUTH_OK_TTL_MS = 5 * 60_000;
const BASIC_AUTH_OK_MAX = 1000;
const basicAuthOkCache = new Map();

function basicAuthCacheKey(username, password, passwordHash) {
  return crypto.createHash('sha256').update(`${username}\u0000${password}\u0000${passwordHash}`).digest('hex');
}

function verifyBasicPassword(username, password, passwordHash) {
  const key = basicAuthCacheKey(username, password, passwordHash);
  const expiresAt = basicAuthOkCache.get(key);
  if (expiresAt && expiresAt > Date.now()) return true;
  if (expiresAt) basicAuthOkCache.delete(key);
  if (!verifyPassword(password, passwordHash)) return false;
  if (basicAuthOkCache.size >= BASIC_AUTH_OK_MAX) {
    basicAuthOkCache.delete(basicAuthOkCache.keys().next().value);
  }
  basicAuthOkCache.set(key, Date.now() + BASIC_AUTH_OK_TTL_MS);
  return true;
}

function tryOpdsBasicAuth(req) {
  const credentials = basicAuth(req);
  if (!credentials) return { ok: false, reason: 'no-credentials' };
  /* attachSessionUser уже проверил этот заголовок — не считаем scrypt второй раз. */
  if (req.authMethod === 'basic' && req.user?.username === credentials.name) {
    return { ok: true, user: { username: req.user.username, role: req.user.role || 'user' } };
  }
  /* Basic проверяется на любом URL — без лимита это перебор паролей в обход формы входа. */
  if (isRateLimited(req)) {
    return { ok: false, reason: 'rate-limited', username: credentials.name };
  }
  const basicUser = getUserByUsername(credentials.name);
  if (!basicUser) {
    /* Всё равно вычисляем хеш дамми-пароля чтобы не было timing-side-channel
       («есть пользователь / нет»). Результат игнорируем. */
    verifyPassword(credentials.pass, DUMMY_PASSWORD_HASH);
    registerFailedLogin(req);
    return { ok: false, reason: 'unknown-user', username: credentials.name };
  }
  if (!basicUser.passwordHash) {
    return { ok: false, reason: 'no-password-hash', username: basicUser.username };
  }
  if (basicUser.blocked) {
    return { ok: false, reason: 'blocked', username: basicUser.username };
  }
  const valid = verifyBasicPassword(basicUser.username, credentials.pass, basicUser.passwordHash);
  if (!valid) {
    registerFailedLogin(req);
    return { ok: false, reason: 'wrong-password', username: basicUser.username };
  }
  return {
    ok: true,
    user: { username: basicUser.username, role: basicUser.role || 'user' }
  };
}

/**
 * Записать причину неудачной OPDS-авторизации в журнал событий
 * (тихо: не на каждом запросе, а только когда реально пришли credentials —
 * чтобы не флудить логи от клиентов, которые сначала шлют без Basic вообще).
 */
function logOpdsAuthFailure(req, result) {
  if (!result || result.ok) return;
  if (result.reason === 'no-credentials') return; // это нормальный «ping» от клиента до challenge
  try {
    logSystemEvent('warn', 'auth', 'OPDS basic-auth failed', {
      reason: result.reason,
      username: result.username || '',
      ip: req.ip || req.socket?.remoteAddress || '',
      path: req.originalUrl || req.path || ''
    });
  } catch { /* ignore */ }
}

/**
 * Стандартный 401-ответ для OPDS-клиента с UTF-8-charset
 * (RFC 7617 §2.1: клиент при наличии charset="UTF-8" обязан кодировать
 * Basic-credentials в UTF-8 — это чинит логины с не-ASCII в пароле/логине). */
function sendOpdsAuthChallenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="INPX Library OPDS", charset="UTF-8"');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  return res.status(401).send(t('api.auth.unauthorized'));
}

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
  if (sessionUserCache.size > SESSION_USER_CACHE_MAX) {
    let evicted = 0;
    for (const k of sessionUserCache.keys()) {
      sessionUserCache.delete(k);
      if (++evicted >= 100) break;
    }
  }
}

/** Drop cached user row after password/session generation changes. */
export function invalidateSessionUserCache(username) {
  const key = String(username || '').trim();
  if (key) sessionUserCache.delete(key);
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

  return {
    username: user.username,
    role: user.role || 'user',
    sessionGen: user.sessionGen || 0,
    telegramBotAllowed: Number(user.telegramBotAllowed ?? 1) !== 0,
    ereaderEmailAllowed: Number(user.ereaderEmailAllowed ?? 1) !== 0,
    hasLocalPassword: Number(user.hasLocalPassword ?? 1) !== 0,
    email: String(user.email || '')
  };
}

/** Attach user (session cookie) and CSRF token to every request. */
export function attachSessionUser(req, res, next) {
  const sessionUser = getSessionUser(req);
  if (sessionUser) {
    req.user = sessionUser;
    req.authMethod = 'session';
    req.csrfToken = csrfTokenForSession(sessionUser.username, sessionUser.sessionGen || 0);
    trackUser(sessionUser.username);
    return next();
  }

  req.user = null;
  req.authMethod = null;
  req.csrfToken = '';
  attachBasicAuthUser(req);
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

  if (req.authMethod === 'device') return next();
  /* Браузер сам подставляет запомненный Basic и в чужие формы — для межсайтового запроса
     нужен CSRF-токен. KOReader/приложение заголовок Sec-Fetch-Site не шлют. */
  if (req.authMethod === 'basic') {
    const fetchSite = String(req.get('sec-fetch-site') || '');
    if (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none') return next();
  }

  if (!verifyCsrfToken(req.user.username, req.user.sessionGen || 0, token)) {
    const wantsJson = reqPath.startsWith('/api/') || String(req.get('accept') || '').includes('application/json');
    if (wantsJson) {
      return res.status(403).json({ ok: false, code: ApiErrorCode.CSRF_INVALID, error: t('api.auth.csrfInvalid'), flash: t('auth.csrfInvalid') });
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

/** Basic Auth для REST API (мобильные клиенты без cookie-сессии). */
function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tryDeviceBearerAuth(req) {
  const header = String(req.get('authorization') || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { ok: false, reason: 'no-bearer' };
  const token = match[1].trim();
  if (!token) return { ok: false, reason: 'empty-bearer' };

  const tokenHash = hashDeviceToken(token);
  const ref = getMeta(`device_token_hash:${tokenHash}`);
  if (!ref) return { ok: false, reason: 'unknown-token' };

  const sep = ref.indexOf(':');
  if (sep <= 0) return { ok: false, reason: 'invalid-ref' };
  const username = ref.slice(0, sep);
  const tokenId = ref.slice(sep + 1);

  const raw = getMeta(`device_token:${username}:${tokenId}`);
  if (!raw) return { ok: false, reason: 'revoked' };

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'parse-error' };
  }
  if (meta.tokenHash !== tokenHash) return { ok: false, reason: 'hash-mismatch' };

  const user = getUserByUsername(username);
  if (!user?.passwordHash) return { ok: false, reason: 'unknown-user' };
  if (user.blocked) return { ok: false, reason: 'blocked' };

  return {
    ok: true,
    user: { username: user.username, role: user.role || 'user' },
  };
}

function attachBasicAuthUser(req) {
  if (req.user?.username) return true;
  const result = tryOpdsBasicAuth(req);
  if (result.ok) {
    req.user = result.user;
    req.authMethod = 'basic';
    trackUser(req.user.username);
    return true;
  }
  const deviceResult = tryDeviceBearerAuth(req);
  if (deviceResult.ok) {
    req.user = deviceResult.user;
    req.authMethod = 'device';
    trackUser(req.user.username);
    return true;
  }
  return false;
}

export function requireApiAuth(req, res, next) {
  if (attachBasicAuthUser(req)) return next();
  return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
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
  if (attachBasicAuthUser(req)) return next();
  if (isAnonymousAllowed('allow_anonymous_browse')) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireLiteBrowseAuth(req, res, next) {
  if (req.user?.username) {
    trackUser(req.user.username);
    return next();
  }
  if (isAnonymousAllowed('allow_anonymous_browse')) return next();
  return res.redirect('/lite/login');
}

export function requireBrowseOrOpds(req, res, next) {
  if (req.user?.username) {
    trackUser(req.user.username);
    return next();
  }
  if (isAnonymousAllowed('allow_anonymous_browse')) return next();
  const isOpds = String(req.query?.opds || '') === '1';
  if (isOpds && isAnonymousAllowed('allow_anonymous_opds')) return next();
  if (isOpds) {
    const result = tryOpdsBasicAuth(req);
    if (result.ok) {
      req.user = result.user;
      return next();
    }
    logOpdsAuthFailure(req, result);
    return sendOpdsAuthChallenge(res);
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
  if (isOpds) {
    const result = tryOpdsBasicAuth(req);
    if (result.ok) {
      req.user = result.user;
      return next();
    }
    logOpdsAuthFailure(req, result);
    return sendOpdsAuthChallenge(res);
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, code: ApiErrorCode.UNAUTHORIZED, error: t('api.auth.unauthorized') });
  }
  return res.redirect('/login');
}

export function requireOpdsAuth(req, res, next) {
  /* Сначала пробуем Basic Auth — это «родной» путь для OPDS.
     Если Basic-credentials пришли, но не подошли — НЕ падаем сразу:
     пользователь мог быть аутентифицирован через web-сессию
     (req.user уже выставлен в attachSessionUser) — тогда это тоже валидно. */
  const basicResult = tryOpdsBasicAuth(req);
  let user = basicResult.ok ? basicResult.user : null;

  if (!user && req.user) {
    user = { username: req.user.username, role: req.user.role || 'user' };
  }

  if (user) {
    req.user = user;
    return next();
  }

  if (isAnonymousAllowed('allow_anonymous_opds')) {
    req.user = null;
    return next();
  }

  /* Логируем причину провала только если клиент реально пытался передать credentials
     (no-credentials означает первый запрос «на разведку» — не флудим этим лог). */
  logOpdsAuthFailure(req, basicResult);
  return sendOpdsAuthChallenge(res);
}
