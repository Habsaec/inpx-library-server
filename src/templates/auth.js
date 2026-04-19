/**
 * Auth template functions: login, admin login, registration.
 */
import { renderLoginScreen, escapeHtml, t } from './shared.js';

export function renderLogin(error = '', { registrationEnabled = false } = {}) {
  return renderLoginScreen({
    title: t('login.title'),
    subtitle: t('login.subtitle'),
    action: '/login',
    error,
    extraHtml: registrationEnabled ? `<a href="/register" class="login-footer-link">${escapeHtml(t('login.register'))}</a>` : ''
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

export function renderRegister({ error = '', registrationEnabled = false, recaptchaSiteKey = '' } = {}) {
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
  return renderLoginScreen({
    title: t('register.title'),
    subtitle: t('register.subtitle'),
    action: '/register',
    error,
    extraHtml: `<a href="/login" class="login-footer-link">${escapeHtml(t('register.haveAccount'))}</a>`,
    submitLabel: t('register.submit'),
    passwordAutocomplete: 'new-password',
    headExtra: hasCaptcha ? '<script src="https://www.google.com/recaptcha/api.js" async defer></script>' : '',
    captchaHtml: hasCaptcha ? `<div class="g-recaptcha" data-sitekey="${escapeHtml(recaptchaSiteKey)}" style="margin:8px 0;"></div>` : ''
  });
}
