/**
 * Маршруты аутентификации: login, logout, register, profile.
 */
import { config } from '../config.js';
import { t, translateKnownErrorMessage } from '../i18n.js';
import { requireWebAuth, invalidateSessionUserCache } from '../middleware/auth.js';
import { verifyPassword, timingSafeStringEqual } from '../auth.js';
import { createSessionValue } from '../services/session.js';
import { isRateLimited, registerFailedLogin, clearLoginAttempts, getClientKey, isPasswordResetRateLimited, registerPasswordResetAttempt } from '../services/rate-limiter.js';
import { DUMMY_PASSWORD_HASH } from '../constants.js';
import { getIndexStatus, getReadingHistory } from '../inpx.js';
import {
  getUserByUsername, getSetting, createUser, changePassword,
  setEreaderEmail, getEreaderEmail, getUserStats,
  getUserBrowseViewPrefs, setUserBrowseViewPrefs,
  getAllReaderBookmarks, getAllReaderAnnotations, decryptValue,
  createTelegramLinkToken, unlinkTelegram, getTelegramBotUsername, resolveTelegramRuntimeConfig, setMeta,
  isTelegramBotAllowedForUser,
  isEreaderEmailAllowedForUser,
  isPasswordResetConfigured,
  getUserByEreaderEmail,
  normalizePasswordResetEmail,
  createPasswordResetToken,
  validatePasswordResetToken,
  completePasswordReset,
  getOidcSettings, isOidcRegistrationBlocked
} from '../db.js';
import { isOidcConfigured } from '../services/oidc.js';
import { logSystemEvent } from '../services/system-events.js';
import { resolvePublicBaseUrl, sendPasswordResetEmail } from '../services/password-reset.js';

/** Secure-cookie на голом HTTP по LAN браузер молча выбрасывает: вход в журнале есть, сессии нет. */
function sessionCookieOptions(req) {
  const https = Boolean(req.secure || req.protocol === 'https');
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(config.sessionSecureCookie) && https,
    maxAge: config.sessionMaxAgeMs,
  };
}
import {
  renderLogin, renderAdminLogin, renderRegister, renderProfile, renderProfileSettings,
  renderForgotPassword, renderResetPassword,
} from '../templates.js';

function getRecaptchaKeys() {
  return { siteKey: getSetting('recaptcha_site_key'), secretKey: decryptValue(getSetting('recaptcha_secret_key')) };
}

async function resolveTelegramBotUsernameForLink() {
  const cached = getTelegramBotUsername();
  if (cached) return cached;

  const tgRuntime = resolveTelegramRuntimeConfig();
  if (!tgRuntime.enabled || !tgRuntime.token) return '';

  try {
    const resp = await fetch(`https://api.telegram.org/bot${tgRuntime.token}/getMe`);
    const data = await resp.json();
    const username = data?.result?.username;
    if (data?.ok && username) {
      setMeta('telegram_bot_username', username);
      return username;
    }
  } catch {
    /* ignore — fallback to flash on settings page */
  }
  return '';
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
      recentBooks: getReadingHistory(user.username, 5),
      readerBookmarks: getAllReaderBookmarks(user.username, 10),
      readerAnnotations: getAllReaderAnnotations(user.username, 10),
      flash,
      csrfToken
    };
  }

  function buildProfileSettingsData(user, flash = '', csrfToken = '', extra = {}) {
    const fullUser = getUserByUsername(user.username);
    const tgRuntime = resolveTelegramRuntimeConfig();
    const browseView = getUserBrowseViewPrefs(user.username);
    return {
      user,
      stats: getCachedStats(),
      indexStatus: getIndexStatus(),
      userStats: getUserStats(user.username),
      ereaderEmail: getEreaderEmail(user.username),
      homeView: browseView.homeView,
      catalogView: browseView.catalogView,
      telegramId: fullUser?.telegramId || '',
      telegramLinkedAt: fullUser?.telegramLinkedAt || '',
      telegramBotUsername: getTelegramBotUsername(),
      telegramBotAvailable: Boolean(tgRuntime.enabled && tgRuntime.token),
      telegramBotAllowed: fullUser ? isTelegramBotAllowedForUser(fullUser) : true,
      ereaderEmailAllowed: fullUser ? isEreaderEmailAllowedForUser(fullUser) : true,
      hasLocalPassword: Number(fullUser?.hasLocalPassword ?? 1) !== 0,
      flash,
      csrfToken,
      ...extra
    };
  }

  // --- Login ---

  function loginPageOptions() {
    const oidc = getOidcSettings();
    return {
      registrationEnabled: getSetting('allow_registration') === '1' && !isOidcRegistrationBlocked(),
      passwordResetEnabled: isPasswordResetConfigured(),
      oidcEnabled: isOidcConfigured(oidc)
    };
  }

  function oidcLoginErrorMessage(code) {
    const map = {
      OIDC_NOT_CONFIGURED: 'login.oidc.notConfigured',
      OIDC_EMAIL_EXISTS: 'login.oidc.emailExists',
      OIDC_EMAIL_UNVERIFIED: 'login.oidc.emailUnverified',
      OIDC_USER_BLOCKED: 'login.oidc.blocked',
      OIDC_FAILED: 'login.oidc.failed'
    };
    return t(map[String(code || '')] || 'login.oidc.failed');
  }

  app.get('/login', (req, res) => {
    const flash = String(req.query.flash || '');
    const resetOk = String(req.query.reset || '') === 'ok';
    const oidcError = String(req.query.oidc_error || '');
    const successMessage = resetOk ? t('passwordReset.passwordChanged') : flash;
    const error = oidcError ? oidcLoginErrorMessage(oidcError) : '';
    res.send(renderLogin(error, { ...loginPageOptions(), successMessage }));
  });

  app.get('/admin/login', (req, res) => {
    res.send(renderAdminLogin());
  });

  app.post('/login', (req, res) => {
    if (isRateLimited(req)) {
      logSystemEvent('warn', 'auth', 'login rate limit triggered', { client: getClientKey(req) });
      return res.status(429).send(renderLogin(t('auth.rateLimitLogin'), loginPageOptions()));
    }

    const { username, password } = req.body;
    const user = getUserByUsername(String(username || '').trim());
    const passwordValid = verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
    if (!user || !passwordValid) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'login failed', { client: getClientKey(req), username: String(username || '') });
      return res.status(401).send(renderLogin(t('auth.invalidCredentials'), loginPageOptions()));
    }

    if (user.blocked) {
      registerFailedLogin(req);
      logSystemEvent('warn', 'auth', 'blocked user login attempt', { client: getClientKey(req), username: user.username });
      return res.status(403).send(renderLogin(t('auth.accountBlocked'), loginPageOptions()));
    }

    clearLoginAttempts(req);
    invalidateSessionUserCache(user.username);
    const freshUser = getUserByUsername(user.username);
    logSystemEvent('info', 'auth', 'login successful', { client: getClientKey(req), username: user.username, role: user.role });
    res.cookie('session', createSessionValue(freshUser.username, freshUser.sessionGen || 0), sessionCookieOptions(req));
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
      ...sessionCookieOptions(req),
      maxAge: config.sessionMaxAgeMs
    });
    res.redirect('/admin');
  });

  app.post('/logout', (req, res) => {
    res.clearCookie('session');
    res.redirect('/');
  });

  // --- Password reset (e-reader email only) ---

  app.get('/forgot-password', (req, res) => {
    res.send(renderForgotPassword({ disabled: !isPasswordResetConfigured() }));
  });

  app.post('/forgot-password', async (req, res) => {
    if (!isPasswordResetConfigured()) {
      return res.status(404).send(renderForgotPassword({ disabled: true }));
    }
    if (isPasswordResetRateLimited(req)) {
      return res.status(429).send(renderForgotPassword({ error: t('passwordReset.rateLimit') }));
    }

    registerPasswordResetAttempt(req);
    const email = normalizePasswordResetEmail(req.body.email);
    if (!email) {
      return res.status(400).send(renderForgotPassword({ error: t('passwordReset.invalidEmail') }));
    }

    const user = getUserByEreaderEmail(email);
    if (user) {
      try {
        const { token, ereaderEmail } = createPasswordResetToken(user.username);
        const baseUrl = resolvePublicBaseUrl(req);
        const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await sendPasswordResetEmail({ to: ereaderEmail, resetUrl, username: user.username });
        logSystemEvent('info', 'auth', 'password reset email sent', { username: user.username, client: getClientKey(req) });
      } catch (error) {
        logSystemEvent('error', 'auth', 'password reset email failed', {
          username: user.username,
          client: getClientKey(req),
          error: error.message
        });
      }
    } else {
      logSystemEvent('info', 'auth', 'password reset requested for unknown email', { client: getClientKey(req) });
    }

    res.send(renderForgotPassword({ message: t('passwordReset.emailSent') }));
  });

  app.get('/reset-password', (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token || !validatePasswordResetToken(token)) {
      return res.send(renderResetPassword({ invalid: true }));
    }
    res.send(renderResetPassword({ token }));
  });

  app.post('/reset-password', (req, res) => {
    const token = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    if (!token || !validatePasswordResetToken(token)) {
      return res.status(400).send(renderResetPassword({ invalid: true }));
    }
    if (password !== confirmPassword) {
      return res.status(400).send(renderResetPassword({ token, error: t('profile.passwordMismatch') }));
    }

    try {
      const result = completePasswordReset(token, password);
      if (!result) {
        return res.status(400).send(renderResetPassword({ invalid: true }));
      }
      logSystemEvent('info', 'auth', 'password reset completed', { username: result.username, client: getClientKey(req) });
      invalidateSessionUserCache(result.username);
      res.clearCookie('session');
      res.redirect('/login?reset=ok');
    } catch (error) {
      res.status(400).send(renderResetPassword({ token, error: translateKnownErrorMessage(error.message) }));
    }
  });

  // --- Registration ---

  app.get('/register', (req, res) => {
    const registrationEnabled = getSetting('allow_registration') === '1' && !isOidcRegistrationBlocked();
    const { siteKey } = getRecaptchaKeys();
    const inviteToken = String(getSetting('registration_invite_token') || '').trim();
    res.send(renderRegister({
      registrationEnabled,
      recaptchaSiteKey: siteKey,
      inviteRequired: Boolean(inviteToken),
      inviteValue: String(req.query.invite || '').trim().slice(0, 128)
    }));
  });

  app.post('/register', async (req, res) => {
    const registrationEnabled = getSetting('allow_registration') === '1' && !isOidcRegistrationBlocked();
    const { siteKey, secretKey } = getRecaptchaKeys();
    const expectedInvite = String(getSetting('registration_invite_token') || '').trim();
    const inviteRequired = Boolean(expectedInvite);
    const inviteValue = String(req.body.inviteToken || '').trim().slice(0, 128);
    const regOpts = { registrationEnabled, recaptchaSiteKey: siteKey, inviteRequired, inviteValue };
    if (!registrationEnabled) {
      return res.send(renderRegister({ registrationEnabled: false }));
    }
    if (isRateLimited(req)) {
      return res.status(429).send(renderRegister({ ...regOpts, error: t('register.rateLimit') }));
    }
    if (inviteRequired && !timingSafeStringEqual(inviteValue, expectedInvite)) {
      return res.status(403).send(renderRegister({ ...regOpts, error: t('register.inviteInvalid') }));
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
        ...sessionCookieOptions(req),
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

  function profileSettingsSection(req) {
    return String(req.query.section || req.body?.section || '') === 'view' ? 'view' : 'account';
  }

  function renderSettingsPage(user, flash, csrfToken, section = 'account') {
    return renderProfileSettings(buildProfileSettingsData(user, flash, csrfToken, { section }));
  }

  app.get('/profile/settings', requireWebAuth, (req, res) => {
    res.send(renderSettingsPage(req.user, String(req.query.flash || ''), req.csrfToken || '', profileSettingsSection(req)));
  });

  app.get('/profile/view', requireWebAuth, (req, res) => {
    const qs = new URLSearchParams();
    qs.set('section', 'view');
    if (req.query.flash) qs.set('flash', String(req.query.flash));
    res.redirect(302, `/profile/settings?${qs.toString()}`);
  });

  app.post('/profile/email', requireWebAuth, (req, res) => {
    const rawEmail = String(req.body.ereaderEmail || '').trim();
    if (rawEmail && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(rawEmail)) {
      return res.status(400).send(renderSettingsPage(req.user, t('profile.invalidEmail'), req.csrfToken || '', 'account'));
    }
    const fullUser = getUserByUsername(req.user.username);
    if (!isEreaderEmailAllowedForUser(fullUser)) {
      return res.status(403).send(renderSettingsPage(req.user, t('profile.ereaderEmail.accessDenied'), req.csrfToken || '', 'account'));
    }
    try {
      setEreaderEmail(req.user.username, rawEmail);
      res.send(renderSettingsPage(req.user, t('profile.emailSaved'), req.csrfToken || '', 'account'));
    } catch (error) {
      res.status(500).send(renderSettingsPage(req.user, translateKnownErrorMessage(error.message), req.csrfToken || '', 'account'));
    }
  });

  app.post('/profile/view', requireWebAuth, (req, res) => {
    try {
      setUserBrowseViewPrefs(req.user.username, {
        homeView: req.body.homeView,
        catalogView: req.body.catalogView
      });
      res.send(renderSettingsPage(req.user, t('profile.viewPrefsSaved'), req.csrfToken || '', 'view'));
    } catch (error) {
      res.status(500).send(renderSettingsPage(req.user, translateKnownErrorMessage(error.message), req.csrfToken || '', 'view'));
    }
  });

  app.post('/profile/password', requireWebAuth, (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const renderErr = (msg) => res.status(400).send(renderSettingsPage(req.user, msg, req.csrfToken || '', 'account'));

    const fullUser = getUserByUsername(req.user.username);
    const hasLocal = Number(fullUser?.hasLocalPassword ?? 1) !== 0;
    if (hasLocal) {
      if (!fullUser || !verifyPassword(currentPassword, fullUser.passwordHash)) {
        return renderErr(t('profile.wrongCurrentPassword'));
      }
    }
    if (newPassword !== confirmPassword) {
      return renderErr(t('profile.passwordMismatch'));
    }
    try {
      changePassword(req.user.username, newPassword);
      invalidateSessionUserCache(req.user.username);
      const freshUser = getUserByUsername(req.user.username);
      res.cookie('session', createSessionValue(freshUser.username, freshUser.sessionGen || 0), {
        httpOnly: true,
        sameSite: 'lax',
        ...sessionCookieOptions(req),
        maxAge: config.sessionMaxAgeMs
      });
      logSystemEvent('info', 'auth', 'password changed', { username: req.user.username });
      const okMsg = hasLocal ? t('profile.passwordChanged') : t('profile.passwordSet');
      res.send(renderSettingsPage(freshUser, okMsg, req.csrfToken || '', 'account'));
    } catch (error) {
      return renderErr(translateKnownErrorMessage(error.message));
    }
  });

  /** GET — надёжнее для внешнего редиректа в Telegram (POST+disable submit ломает отправку формы). */
  app.get('/profile/telegram/link', requireWebAuth, async (req, res) => {
    try {
      const tgRuntime = resolveTelegramRuntimeConfig();
      if (!tgRuntime.enabled || !tgRuntime.token) {
        return res.redirect('/profile/settings?flash=' + encodeURIComponent(t('profile.telegram.botUnavailable')));
      }
      const botUsername = await resolveTelegramBotUsernameForLink();
      if (!botUsername) {
        return res.redirect('/profile/settings?flash=' + encodeURIComponent(t('profile.telegram.botUnavailable')));
      }
      const { token } = createTelegramLinkToken(req.user.username);
      res.redirect(302, `https://t.me/${botUsername}?start=link_${token}`);
    } catch (error) {
      res.redirect('/profile/settings?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });

  app.post('/profile/telegram/unlink', requireWebAuth, (req, res) => {
    try {
      unlinkTelegram(req.user.username);
      logSystemEvent('info', 'auth', 'telegram unlinked from profile', { username: req.user.username });
      res.redirect('/profile/settings?flash=' + encodeURIComponent(t('profile.telegram.unlinked')));
    } catch (error) {
      res.redirect('/profile/settings?flash=' + encodeURIComponent(translateKnownErrorMessage(error.message)));
    }
  });
}
