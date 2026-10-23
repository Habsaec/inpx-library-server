/**
 * Auth template functions: login, admin login, registration, password reset.
 */
import { renderLoginScreen, escapeHtml, t } from './shared.js';

export function renderLogin(error = '', {
  registrationEnabled = false,
  passwordResetEnabled = false,
  successMessage = '',
  oidcEnabled = false
} = {}) {
  const footerLinks = [];
  if (passwordResetEnabled) {
    footerLinks.push(`<a href="/forgot-password" class="login-footer-link">${escapeHtml(t('login.forgotPassword'))}</a>`);
  }
  if (registrationEnabled) {
    footerLinks.push(`<a href="/register" class="login-footer-link">${escapeHtml(t('login.register'))}</a>`);
  }
  footerLinks.push(`<a href="/" class="login-footer-link">${escapeHtml(t('login.browseCatalog'))}</a>`);
  const ssoBlock = oidcEnabled
    ? `<div class="login-sso-block">
        <a class="button login-sso-button" href="/auth/oidc/start">${escapeHtml(t('login.sso'))}</a>
        <div class="login-sso-divider muted">${escapeHtml(t('login.ssoOr'))}</div>
      </div>`
    : '';
  return renderLoginScreen({
    title: t('login.title'),
    subtitle: t('login.subtitle'),
    action: '/login',
    error,
    successMessage,
    beforeFormHtml: ssoBlock,
    extraHtml: footerLinks.join('')
  });
}

export function renderAdminLogin(error = '') {
  return renderLoginScreen({
    title: t('adminLogin.title'),
    subtitle: t('adminLogin.subtitle'),
    action: '/admin/login',
    error
  });
}

export function renderRegister({
  error = '',
  registrationEnabled = false,
  recaptchaSiteKey = '',
  inviteRequired = false,
  inviteValue = ''
} = {}) {
  if (!registrationEnabled) {
    return renderLoginScreen({
      title: t('register.closedTitle'),
      subtitle: t('register.closedSubtitle'),
      action: '/register',
      error: '',
      extraHtml: `<a href="/login" class="login-footer-link">${escapeHtml(t('register.loginLink'))}</a>`,
      hideForm: true
    });
  }
  const hasCaptcha = Boolean(recaptchaSiteKey);
  const inviteHtml = inviteRequired
    ? `<div>
          <label for="inviteToken">${escapeHtml(t('register.inviteToken'))}</label>
          <input id="inviteToken" name="inviteToken" type="text" autocomplete="off" spellcheck="false" required maxlength="128" value="${escapeHtml(inviteValue)}">
        </div>`
    : '';
  return renderLoginScreen({
    title: t('register.title'),
    subtitle: t('register.subtitle'),
    action: '/register',
    error,
    extraHtml: `<a href="/login" class="login-footer-link">${escapeHtml(t('register.haveAccount'))}</a>`,
    submitLabel: t('register.submit'),
    passwordAutocomplete: 'new-password',
    extraFieldsHtml: inviteHtml,
    headExtra: hasCaptcha ? '<script src="https://www.google.com/recaptcha/api.js" async defer></script>' : '',
    captchaHtml: hasCaptcha ? `<div class="g-recaptcha" data-sitekey="${escapeHtml(recaptchaSiteKey)}" style="margin:8px 0;"></div>` : ''
  });
}

export function renderForgotPassword({ error = '', message = '', disabled = false } = {}) {
  if (disabled) {
    return renderLoginScreen({
      title: t('passwordReset.forgotTitle'),
      subtitle: t('passwordReset.disabledSubtitle'),
      action: '/forgot-password',
      error: '',
      extraHtml: `<a href="/login" class="login-footer-link">${escapeHtml(t('passwordReset.backToLogin'))}</a>`,
      hideForm: true
    });
  }
  return renderLoginScreen({
    title: t('passwordReset.forgotTitle'),
    subtitle: t('passwordReset.forgotSubtitle'),
    action: '/forgot-password',
    error,
    successMessage: message,
    extraHtml: `<a href="/login" class="login-footer-link">${escapeHtml(t('passwordReset.backToLogin'))}</a>`,
    hideForm: false,
    submitLabel: t('passwordReset.sendLink'),
    hidePasswordField: true,
    usernameLabel: t('passwordReset.emailLabel'),
    usernameName: 'email',
    usernameType: 'email',
    usernameAutocomplete: 'email'
  });
}

export function renderResetPassword({ error = '', token = '', invalid = false } = {}) {
  if (invalid || !token) {
    return renderLoginScreen({
      title: t('passwordReset.resetTitle'),
      subtitle: t('passwordReset.invalidToken'),
      action: '/reset-password',
      error: '',
      extraHtml: `<a href="/forgot-password" class="login-footer-link">${escapeHtml(t('passwordReset.requestAgain'))}</a>`,
      hideForm: true
    });
  }
  return renderLoginScreen({
    title: t('passwordReset.resetTitle'),
    subtitle: t('passwordReset.resetSubtitle'),
    action: '/reset-password',
    error,
    extraHtml: `<a href="/login" class="login-footer-link">${escapeHtml(t('passwordReset.backToLogin'))}</a>`,
    submitLabel: t('passwordReset.savePassword'),
    passwordLabel: t('passwordReset.newPassword'),
    passwordAutocomplete: 'new-password',
    hideUsernameField: true,
    hiddenFieldsHtml: `<input type="hidden" name="token" value="${escapeHtml(token)}">`,
    confirmPasswordField: true
  });
}
