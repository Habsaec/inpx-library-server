/**
 * Маршруты аутентификации: login, logout, register, profile.
 */
import { config } from '../config.js';
import { t, tp, translateKnownErrorMessage } from '../i18n.js';
import { requireWebAuth, invalidateSessionUserCache } from '../middleware/auth.js';
import { verifyPassword, timingSafeStringEqual } from '../auth.js';
import { createSessionValue } from '../services/session.js';
import { isRateLimited, registerFailedLogin, clearLoginAttempts, getClientKey, isPasswordResetRateLimited, registerPasswordResetAttempt } from '../services/rate-limiter.js';
import { DUMMY_PASSWORD_HASH } from '../constants.js';
import { getIndexStatus } from '../inpx.js';
import { getUserContentLangs, setUserContentLangs, normalizeContentLangList, listEnabledContentLangs } from '../user-content-langs.js';
import {
  getUserByUsername, getSetting, createUser, changePassword,
  setEreaderEmail, getEreaderEmail, setUserAccountEmail, getUserStats,
  getUserBrowseViewPrefs, setUserBrowseViewPrefs,
  getUserReadingStats, decryptValue,
  createTelegramLinkToken, unlinkTelegram, getTelegramBotUsername, resolveTelegramRuntimeConfig, resolveTelegramApiBase, setMeta,
  isTelegramBotAllowedForUser,
  isEreaderEmailAllowedForUser,
  isPasswordResetConfigured,
  getUserByResetEmail,
  normalizePasswordResetEmail,
  createPasswordResetToken,
  validatePasswordResetToken,
  completePasswordReset,
  getOidcSettings, isOidcRegistrationBlocked,
  getUserHideRead, setUserHideRead, getUserDownloadFormat, setUserDownloadFormat,
  getUserTelegramDigest, setUserTelegramDigest, setReadingGoal
} from '../db.js';
import { getConfiguredDownloadFormats, isDownloadFormatEnabled, FORMAT_LABELS } from '../download-formats.js';
import { invalidateUserPageCaches } from '../services/cache.js';

/** Last value of a form field that may come twice (hidden 0 + checkbox 1). */
function lastFormValue(value) {
  return String([].concat(value ?? '').pop() ?? '');
}
import { isOidcConfigured } from '../services/oidc.js';
import { logSystemEvent } from '../services/system-events.js';
import { resolvePublicBaseUrl, sendPasswordResetEmail } from '../services/password-reset.js';
import { createKosyncPassword, hasKosyncPassword, revokeKosyncPassword } from '../kosync.js';
import { getUserHomeLayout, setUserHomeLayout, moveHomeSection, reorderHomeSections, WEB_HOME_SECTION_IDS } from '../home-layout.js';

/** Only the current catalog URL, without a view override, so the saved preference applies. */
function safeCatalogViewReturn(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/catalog') || raw.startsWith('//') || raw.includes('\\') || /[\r\n]/.test(raw)) return '/catalog';
  let url;
  try {
    url = new URL(raw, 'http://local');
  } catch {
    return '/catalog';
  }
  if (url.pathname !== '/catalog') return '/catalog';
  url.searchParams.delete('view');
  const qs = url.searchParams.toString();
  return qs ? `/catalog?${qs}` : '/catalog';
}

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
    const resp = await fetch(`${resolveTelegramApiBase()}/bot${tgRuntime.token}/getMe`);
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
      readingStats: getUserReadingStats(user.username),
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
      accountEmail: fullUser?.email || '',
      homeView: browseView.homeView,
      catalogView: browseView.catalogView,
      contentLangs: getUserContentLangs(user.username),
      contentLangOptions: listEnabledContentLangs(),
      telegramId: fullUser?.telegramId || '',
      telegramLinkedAt: fullUser?.telegramLinkedAt || '',
      telegramBotUsername: getTelegramBotUsername(),
      telegramBotAvailable: Boolean(tgRuntime.enabled && tgRuntime.token),
      telegramBotAllowed: fullUser ? isTelegramBotAllowedForUser(fullUser) : true,
      ereaderEmailAllowed: fullUser ? isEreaderEmailAllowedForUser(fullUser) : true,
      hasLocalPassword: Number(fullUser?.hasLocalPassword ?? 1) !== 0,
      hideRead: getUserHideRead(user.username),
      downloadFormat: getUserDownloadFormat(user.username),
      downloadFormatOptions: getConfiguredDownloadFormats()
        .filter((format) => isDownloadFormatEnabled(format))
        .map((format) => [format, FORMAT_LABELS[format] || format.toUpperCase()]),
      telegramDigest: getUserTelegramDigest(user.username),
      homeLayout: getUserHomeLayout(user.username),
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

    const user = getUserByResetEmail(email);
    if (user) {
      try {
        const { token, email: recipient } = createPasswordResetToken(user.username, email);
        const baseUrl = resolvePublicBaseUrl(req);
        const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        await sendPasswordResetEmail({ to: recipient, resetUrl, username: user.username });
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

  app.post('/profile/reading-goal', requireWebAuth, (req, res) => {
    try {
      setReadingGoal(req.user.username, Number(req.body?.year) || new Date().getFullYear(), req.body?.goal);
    } catch {
      /* invalid year — keep the page as it was */
    }
    res.redirect('/profile');
  });

  function profileSettingsSection(req) {
    return String(req.query.section || req.body?.section || '') === 'view' ? 'view' : 'account';
  }

  function renderSettingsPage(req, flash, csrfToken, section = 'account', user = req.user) {
    return renderProfileSettings(buildProfileSettingsData(user, flash, csrfToken, {
      section,
      kosyncUrl: `${resolvePublicBaseUrl(req)}/kosync`,
      kosyncHasPassword: hasKosyncPassword(user.username)
    }));
  }

  app.get('/profile/settings', requireWebAuth, (req, res) => {
    res.send(renderSettingsPage(req, String(req.query.flash || ''), req.csrfToken || '', profileSettingsSection(req)));
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
      return res.status(400).send(renderSettingsPage(req, t('profile.invalidEmail'), req.csrfToken || '', 'account'));
    }
    const fullUser = getUserByUsername(req.user.username);
    if (!isEreaderEmailAllowedForUser(fullUser)) {
      return res.status(403).send(renderSettingsPage(req, t('profile.ereaderEmail.accessDenied'), req.csrfToken || '', 'account'));
    }
    try {
      setEreaderEmail(req.user.username, rawEmail);
      res.send(renderSettingsPage(req, t('profile.emailSaved'), req.csrfToken || '', 'account'));
    } catch (error) {
      res.status(500).send(renderSettingsPage(req, translateKnownErrorMessage(error.message), req.csrfToken || '', 'account'));
    }
  });

  app.post('/profile/account-email', requireWebAuth, (req, res) => {
    try {
      setUserAccountEmail(req.user.username, req.body.accountEmail);
      res.send(renderSettingsPage(req, t('profile.emailSaved'), req.csrfToken || '', 'account'));
    } catch (error) {
      const status = /^(Invalid email|Email already in use)$/.test(error.message) ? 400 : 500;
      res.status(status).send(renderSettingsPage(req, translateKnownErrorMessage(error.message), req.csrfToken || '', 'account'));
    }
  });

  app.post('/profile/kosync-password', requireWebAuth, (req, res) => {
    const password = createKosyncPassword(req.user.username);
    logSystemEvent('info', 'auth', 'kosync password created', { username: req.user.username });
    res.send(renderSettingsPage(req, tp('profile.kosync.created', { password }), req.csrfToken || '', 'account'));
  });

  app.post('/profile/kosync-password/revoke', requireWebAuth, (req, res) => {
    revokeKosyncPassword(req.user.username);
    res.send(renderSettingsPage(req, t('profile.kosync.revoked'), req.csrfToken || '', 'account'));
  });

  app.post('/profile/content-langs', requireWebAuth, (req, res) => {
    try {
      const available = listEnabledContentLangs();
      const picked = normalizeContentLangList(req.body.contentLangs).filter((code) => available.includes(code));
      const stored = !picked.length || picked.length === available.length ? [] : picked;
      setUserContentLangs(req.user.username, stored);
      res.send(renderSettingsPage(req, t('profile.contentLangsSaved'), req.csrfToken || '', 'view'));
    } catch (error) {
      res.status(500).send(renderSettingsPage(req, translateKnownErrorMessage(error.message), req.csrfToken || '', 'view'));
    }
  });

  app.post('/profile/home-view', requireWebAuth, (req, res) => {
    const prefs = getUserBrowseViewPrefs(req.user.username);
    const next = String(req.body?.view || '').toLowerCase() === 'list' ? 'list' : 'grid';
    setUserBrowseViewPrefs(req.user.username, { homeView: next, catalogView: prefs.catalogView });
    res.redirect('/');
  });

  app.post('/profile/catalog-view', requireWebAuth, (req, res) => {
    const prefs = getUserBrowseViewPrefs(req.user.username);
    const next = String(req.body?.view || '').toLowerCase() === 'list' ? 'list' : 'grid';
    setUserBrowseViewPrefs(req.user.username, { homeView: prefs.homeView, catalogView: next });
    res.redirect(safeCatalogViewReturn(req.body?.next));
  });

  app.post('/profile/home-layout', requireWebAuth, (req, res) => {
    try {
      const username = req.user.username;
      // Drag-and-drop (app.js): `order=continue,novinki,…` only reorders, switches stay as they are.
      if (req.body.order !== undefined) {
        const ids = lastFormValue(req.body.order).split(',');
        setUserHomeLayout(username, reorderHomeSections(getUserHomeLayout(username), ids, WEB_HOME_SECTION_IDS));
        if (String(req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
        return res.send(renderSettingsPage(req, t('profile.homeLayout.saved'), req.csrfToken || '', 'view'));
      }
      if (lastFormValue(req.body.reset) === '1') {
        setUserHomeLayout(username, '');
      } else {
        const current = getUserHomeLayout(username);
        const show = new Set([].concat(req.body.show || []).map((v) => String(v)));
        // Web checkboxes rule the web blocks; the app-only «recent» keeps its own switch.
        const hidden = current.hidden.filter((id) => !WEB_HOME_SECTION_IDS.includes(id))
          .concat(WEB_HOME_SECTION_IDS.filter((id) => !show.has(id)));
        let next = { ...current, hidden };
        const [moveId, direction] = lastFormValue(req.body.move).split(':');
        if (moveId && (direction === 'up' || direction === 'down')) {
          next = moveHomeSection(next, moveId, direction, WEB_HOME_SECTION_IDS);
        }
        setUserHomeLayout(username, next);
      }
      res.send(renderSettingsPage(req, t('profile.homeLayout.saved'), req.csrfToken || '', 'view'));
    } catch (error) {
      res.status(500).send(renderSettingsPage(req, translateKnownErrorMessage(error.message), req.csrfToken || '', 'view'));
    }
  });

  app.post('/profile/view', requireWebAuth, (req, res) => {
    try {
      setUserBrowseViewPrefs(req.user.username, {
        homeView: req.body.homeView,
        catalogView: req.body.catalogView
      });
      if (req.body.downloadFormat !== undefined) {
        const format = lastFormValue(req.body.downloadFormat).toLowerCase();
        setUserDownloadFormat(req.user.username, getConfiguredDownloadFormats().includes(format) ? format : '');
      }
      if (req.body.hideRead !== undefined) {
        setUserHideRead(req.user.username, lastFormValue(req.body.hideRead) === '1');
        invalidateUserPageCaches(req.user.username);
      }
      res.send(renderSettingsPage(req, t('profile.viewPrefsSaved'), req.csrfToken || '', 'view'));
    } catch (error) {
      res.status(500).send(renderSettingsPage(req, translateKnownErrorMessage(error.message), req.csrfToken || '', 'view'));
    }
  });

  app.post('/profile/password', requireWebAuth, (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const renderErr = (msg) => res.status(400).send(renderSettingsPage(req, msg, req.csrfToken || '', 'account'));

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
      res.send(renderSettingsPage(req, okMsg, req.csrfToken || '', 'account', freshUser));
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

  app.post('/profile/telegram/digest', requireWebAuth, (req, res) => {
    setUserTelegramDigest(req.user.username, lastFormValue(req.body?.digest) === '1');
    res.redirect('/profile/settings?flash=' + encodeURIComponent(t('profile.telegram.digestSaved')));
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
