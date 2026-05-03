/**
 * Маршруты аутентификации: login, logout, register, profile.
 */
import { config } from '../config.js';
import { t, translateKnownErrorMessage } from '../i18n.js';
import { requireWebAuth } from '../middleware/auth.js';
import { verifyPassword } from '../auth.js';
import { createSessionValue } from '../services/session.js';
import { isRateLimited, registerFailedLogin, clearLoginAttempts, getClientKey } from '../services/rate-limiter.js';
import { DUMMY_PASSWORD_HASH } from '../constants.js';
import { getIndexStatus, getReadingHistory } from '../inpx.js';
import {
  getUserByUsername, getSetting, createUser, changePassword,
  setEreaderEmail, getEreaderEmail, getUserStats,
  getAllReaderBookmarks, decryptValue,
} from '../db.js';
import { logSystemEvent } from '../services/system-events.js';
import {
  renderLogin, renderAdminLogin, renderRegister, renderProfile,
} from '../templates.js';

function getRecaptchaKeys() {
  return { siteKey: getSetting('recaptcha_site_key'), secretKey: decryptValue(getSetting('recaptcha_secret_key')) };
}

async function verifyRecaptcha(token, secretKey) {
  if (!secretKey || !token) return false;
  try {
    const params = new URLSearchParams({ secret: secretKey, response: token });
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', body: params });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}

/**
 * @param {import('express').Application} app
 * @param {{ getCachedStats: () => unknown }} deps
 */
export function registerAuthRoutes(app, deps) {
  const { getCachedStats } = deps;

  function buildProfileData(user, flash = '', csrfToken = '') {
    return {
      user,
      stats: getCachedStats(),
      indexStatus: getIndexStatus(),
      userStats: getUserStats(user.username),
      ereaderEmail: getEreaderEmail(user.username),
      recentBooks: getReadingHistory(user.username, 5),
      readerBookmarks: getAllReaderBookmarks(user.username, 10),
      flash,
      csrfToken
    };
  }

  // --- Login ---

  app.get('/login', (req, res) => {
    const registrationEnabled = getSetting('allow_registration') === '1';
    res.send(renderLogin('', { registrationEnabled }));
  });

  app.get('/admin/login', (req, res) => {
    res.send(renderAdminLogin());
  });

  app.post('/login', (req, res) => {
    if (isRateLimited(req)) {
      logSystemEvent('warn', 'auth', 'login rate limit triggered', { client: getClientKey(req) });
      return res.status(429).send(renderLogin(t('auth.rateLimitLogin'), { registrationEnabled: getSetting('allow_registration') === '1' }));
    }

    const { username, password } = req.body;
    const user = getUserByUsername(String(username || '').trim());
    const passwordValid = verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!user || !passwordValid) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'login failed', { client: getClientKey(req), username: String(username || '') });
      return res.status(401).send(renderLogin(t('auth.invalidCredentials'), { registrationEnabled: getSetting('allow_registration') === '1' }));
    }

    if (user.blocked) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'blocked user login attempt', { client: getClientKey(req), username: user.username });
      return res.status(403).send(renderLogin(t('auth.accountBlocked'), { registrationEnabled: getSetting('allow_registration') === '1' }));
    }

    clearLoginAttempts(req);
    logSystemEvent('info', 'auth', 'login successful', { client: getClientKey(req), username: user.username, role: user.role });
    res.cookie('session', createSessionValue(user.username, user.sessionGen || 0), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionSecureCookie,
      maxAge: config.sessionMaxAgeMs
    });
    res.redirect('/');
  });

  app.post('/admin/login', (req, res) => {
    if (isRateLimited(req)) {
      logSystemEvent('warn', 'auth', 'admin login rate limit triggered', { client: getClientKey(req) });
      return res.status(429).send(renderAdminLogin(t('auth.rateLimitLogin')));
    }

    const { username, password } = req.body;
    const user = getUserByUsername(String(username || '').trim());
    const passwordValid = verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!user || user.role !== 'admin' || !passwordValid) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'admin login failed', { client: getClientKey(req), username: String(username || '') });
      return res.status(401).send(renderAdminLogin(t('auth.adminRequired')));
    }

    if (user.blocked) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'blocked admin login attempt', { client: getClientKey(req), username: user.username });
      return res.status(403).send(renderAdminLogin(t('auth.accountBlockedShort')));
    }

    clearLoginAttempts(req);
    logSystemEvent('info', 'auth', 'admin login successful', { client: getClientKey(req), username: user.username, role: user.role });
    res.cookie('session', createSessionValue(user.username, user.sessionGen || 0), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionSecureCookie,
      maxAge: config.sessionMaxAgeMs
    });
    res.redirect('/admin');
  });

  app.post('/logout', (req, res) => {
    res.clearCookie('session');
    res.redirect('/');
  });

  // --- Registration ---

  app.get('/register', (req, res) => {
    const registrationEnabled = getSetting('allow_registration') === '1';
    const { siteKey } = getRecaptchaKeys();
    res.send(renderRegister({ registrationEnabled, recaptchaSiteKey: siteKey }));
  });

  app.post('/register', async (req, res) => {
    const registrationEnabled = getSetting('allow_registration') === '1';
    const { siteKey, secretKey } = getRecaptchaKeys();
    const regOpts = { registrationEnabled, recaptchaSiteKey: siteKey };
    if (!registrationEnabled) {
      return res.send(renderRegister({ registrationEnabled: false }));
    }
    if (isRateLimited(req)) {
      return res.status(429).send(renderRegister({ ...regOpts, error: t('register.rateLimit') }));
    }
    if (secretKey) {
      const captchaToken = req.body['g-recaptcha-response'] || '';
      const captchaOk = await verifyRecaptcha(captchaToken, secretKey);
      if (!captchaOk) {
        return res.status(400).send(renderRegister({ ...regOpts, error: t('register.captchaFail') }));
      }
    }
    try {
      const user = createUser({ username: req.body.username, password: req.body.password });
      logSystemEvent('info', 'auth', 'user registered', { username: user.username });
      res.cookie('session', createSessionValue(user.username, user.sessionGen || 0), {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.sessionSecureCookie,
        maxAge: config.sessionMaxAgeMs
      });
      res.redirect('/');
    } catch (error) {
      res.status(400).send(renderRegister({ ...regOpts, error: translateKnownErrorMessage(error.message) }));
    }
  });

  // --- Profile ---

  app.get('/profile', requireWebAuth, (req, res) => {
    res.send(renderProfile(buildProfileData(req.user, '', req.csrfToken || '')));
  });

  app.post('/profile/email', requireWebAuth, (req, res) => {
    const rawEmail = String(req.body.ereaderEmail || '').trim();
    if (rawEmail && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(rawEmail)) {
      return res.status(400).send(renderProfile(buildProfileData(req.user, t('profile.invalidEmail'), req.csrfToken || '')));
    }
    try {
      setEreaderEmail(req.user.username, rawEmail);
      res.send(renderProfile(buildProfileData(req.user, t('profile.emailSaved'), req.csrfToken || '')));
    } catch (error) {
      res.status(500).send(renderProfile(buildProfileData(req.user, translateKnownErrorMessage(error.message), req.csrfToken || '')));
    }
  });

  app.post('/profile/password', requireWebAuth, (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const renderErr = (msg) => res.status(400).send(renderProfile(buildProfileData(req.user, msg, req.csrfToken || '')));

    const fullUser = getUserByUsername(req.user.username);
    if (!fullUser || !verifyPassword(currentPassword, fullUser.passwordHash)) {
      return renderErr(t('profile.wrongCurrentPassword'));
    }
    if (newPassword !== confirmPassword) {
      return renderErr(t('profile.passwordMismatch'));
    }
    try {
      changePassword(req.user.username, newPassword);
      logSystemEvent('info', 'auth', 'password changed', { username: req.user.username });
      res.send(renderProfile(buildProfileData(req.user, t('profile.passwordChanged'), req.csrfToken || '')));
    } catch (error) {
      return renderErr(translateKnownErrorMessage(error.message));
    }
  });
}
