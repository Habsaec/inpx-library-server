import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { LOCALE_BUNDLES } from './locale-bundles.js';

const localeStore = new AsyncLocalStorage();

const cache = { ru: null, en: null };

function loadBundle(lang) {
  if (cache[lang]) return cache[lang];
  cache[lang] = LOCALE_BUNDLES[lang] || LOCALE_BUNDLES.ru || {};
  return cache[lang];
}

/* «Язык по умолчанию» для гостей без явного Accept-Language / cookie.
   Возможные значения: 'ru' | 'en' | 'auto'. 'auto' = старое поведение
   («fallback en»). Кешируется в памяти, обновляется через setDefaultLocale.
   Это критично для OPDS-клиентов вроде KOReader, которые не присылают
   Accept-Language — без этой настройки они всегда получали английский. */
let _defaultLocale = 'auto';
export function setDefaultLocale(value) {
  const v = String(value || '').toLowerCase().trim();
  _defaultLocale = (v === 'ru' || v === 'en') ? v : 'auto';
}
export function getDefaultLocale() {
  return _defaultLocale;
}

/** Определить язык UI: cookie lang → Accept-Language → default_locale → 'en'. */
export function resolveLocale(req) {
  const c = req?.cookies?.lang;
  if (c === 'en' || c === 'ru') return c;
  const al = String(req?.get?.('Accept-Language') || '');
  if (/^\s*ru\b/i.test(al) || /,\s*ru\b/i.test(al)) return 'ru';
  if (/^\s*en\b/i.test(al) || /,\s*en\b/i.test(al)) return 'en';
  /* Ни cookie, ни Accept-Language ничего конкретного не сказали —
     используем серверную настройку (если 'auto' — оставляем 'en'). */
  if (_defaultLocale === 'ru' || _defaultLocale === 'en') return _defaultLocale;
  return 'en';
}

export function runWithLocale(req, fn) {
  const locale = resolveLocale(req);
  return localeStore.run({ locale }, fn);
}

/** Выполнить fn в контексте локали (например фоновый журнал обновления с языком запроса). */
export function runWithLocaleLang(locale, fn) {
  const loc = locale === 'en' ? 'en' : 'ru';
  return localeStore.run({ locale: loc }, fn);
}

export function getLocale() {
  return localeStore.getStore()?.locale || 'en';
}

export function t(key) {
  const lang = getLocale();
  const primary = loadBundle(lang);
  const fallback = loadBundle('ru');
  if (Object.prototype.hasOwnProperty.call(primary, key)) {
    const v = primary[key];
    if (v !== undefined && v !== null) return v;
  }
  if (Object.prototype.hasOwnProperty.call(fallback, key)) {
    const v = fallback[key];
    if (v !== undefined && v !== null) return v;
  }
  return key;
}

/** Замена {{name}} в строке перевода. */
export function tp(key, vars = {}) {
  let s = t(key);
  for (const [k, v] of Object.entries(vars)) {
    s = s.split(`{{${k}}}`).join(String(v));
  }
  return s;
}

function ruPluralFormIndex(n) {
  const v = Math.floor(Math.abs(Number(n) || 0));
  const m10 = v % 10;
  const m100 = v % 100;
  if (m100 >= 11 && m100 <= 14) return 'many';
  if (m10 === 1) return 'one';
  if (m10 >= 2 && m10 <= 4) return 'few';
  return 'many';
}

/**
 * Склоняемое слово по типу: book, author, series, genre, language, record, archive, user, admin, shelf, title, source.
 * В en.json для каждого типа: plural.TYPE.one, plural.TYPE.other
 * В ru.json: plural.TYPE.one, .few, .many
 */
export function plural(type, n) {
  const lang = getLocale();
  const v = Math.floor(Math.abs(Number(n) || 0));
  if (lang === 'en') {
    const suffix = v === 1 ? 'one' : 'other';
    return t(`plural.${type}.${suffix}`);
  }
  const idx = ruPluralFormIndex(n);
  const suffix = idx === 'one' ? 'one' : idx === 'few' ? 'few' : 'many';
  return t(`plural.${type}.${suffix}`);
}

export function countLabel(type, n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  const loc = getLocale() === 'en' ? 'en-US' : 'ru-RU';
  return `${v.toLocaleString(loc)} ${plural(type, v)}`;
}

export function formatLocaleInt(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toLocaleString(getLocale() === 'en' ? 'en-US' : 'ru-RU');
}

export function formatLocaleDateShort(d) {
  if (!d) return t('common.dash');
  try {
    const loc = getLocale() === 'en' ? 'en-US' : 'ru-RU';
    return new Date(d).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return String(d);
  }
}

export function formatLocaleDateTimeShort(d) {
  if (!d) return t('common.dash');
  try {
    const loc = getLocale() === 'en' ? 'en-US' : 'ru-RU';
    return new Date(d).toLocaleString(loc, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(d);
  }
}

export function formatLocaleDateLong(d) {
  if (!d) return t('common.dash');
  try {
    const loc = getLocale() === 'en' ? 'en-US' : 'ru-RU';
    return new Date(d).toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return String(d);
  }
}

/** Известные тексты ошибок (db, валидация) → ключ i18n. */
const KNOWN_ERROR_TO_KEY = {
  'Логин обязателен': 'validation.usernameRequired',
  'Логин должен быть не менее 5 символов': 'validation.usernameMin',
  'Логин не должен быть длиннее 50 символов': 'validation.usernameMax',
  'Логин может содержать только латинские буквы, цифры, точку, дефис и подчёркивание': 'validation.usernameChars',
  'Пользователь с таким логином уже существует': 'validation.userExists',
  'Пароль слишком длинный (макс. 1024 символа)': 'validation.passwordMax',
  'Пароль должен быть не менее 8 символов': 'validation.passwordMin',
  'Пароль может содержать только латинские буквы, цифры и спецсимволы': 'validation.passwordChars',
  'Пароль должен содержать хотя бы одну строчную букву': 'validation.passwordLower',
  'Пароль должен содержать хотя бы одну заглавную букву': 'validation.passwordUpper',
  'Пароль должен содержать хотя бы одну цифру': 'validation.passwordDigit',
  'Пользователь не найден': 'validation.userNotFound',
  'Username is required': 'validation.usernameRequired',
  'User not found': 'validation.userNotFound',
  'Cannot remove the last admin': 'admin.users.error.lastAdminRole',
  'Cannot delete the last admin': 'admin.users.error.lastAdminDelete',
  'Название источника не указано': 'admin.sources.error.nameRequired',
  'Путь к источнику не указан': 'admin.sources.error.pathRequired',
  'Источник с таким путём уже существует': 'admin.sources.error.duplicatePath',
  'Название полки не указано': 'shelves.error.nameRequired',
  'Полка с таким названием уже существует': 'shelves.error.duplicateName',
  'Фильтр умной полки пуст': 'smartShelves.error.emptyFilter',
  'Invalid Telegram ID': 'profile.telegram.errorInvalidId',
  'Invalid email': 'profile.invalidEmail',
  'Email already in use': 'profile.accountEmail.taken',
  'Link token expired or invalid': 'profile.telegram.errorInvalidToken',
  'This Telegram account is already linked to another user': 'profile.telegram.errorAlreadyLinked',
  'User already has a different Telegram account linked': 'profile.telegram.errorDifferentLinked',
  'Account is blocked': 'auth.accountBlocked',
  'Telegram bot access denied': 'profile.telegram.accessDenied',
  'E-reader email access denied': 'profile.ereaderEmail.accessDenied'
};

export function translateKnownErrorMessage(message) {
  const msg = String(message || '');
  if (/database disk image is malformed/i.test(msg)) {
    return t('errors.sqliteCorrupt');
  }
  const key = KNOWN_ERROR_TO_KEY[msg];
  return key ? t(key) : msg;
}

/** @deprecated Используйте translateKnownErrorMessage; алиас для совместимости. */
export function translateDbUserErrorMessage(message) {
  return translateKnownErrorMessage(message);
}

/** Как t(): для en подставляем ru, если в основной локали ключа нет или пусто. */
function clientStringsForLocale(locale) {
  const ru = loadBundle('ru');
  if (locale === 'ru') return { ...ru };
  const primary = loadBundle(locale);
  const out = { ...ru };
  for (const [k, v] of Object.entries(primary)) {
    if (v != null && v !== '') out[k] = v;
  }
  return out;
}

/** JSON для встраивания в HTML (безопасно внутри <script type="application/json">). */
export function serializeClientI18n() {
  return clientI18nAsset(getLocale()).json;
}

/*
 * Client dictionary as a separate long-cached script: ~105 KB that used to be embedded
 * (and re-serialized, ~1.7 ms) in every HTML page. Bundles are static per process,
 * so the JSON and its content hash are built once per locale.
 */
const _clientI18nAssets = new Map();

function clientI18nAsset(locale) {
  const key = locale === 'en' ? 'en' : 'ru';
  let asset = _clientI18nAssets.get(key);
  if (!asset) {
    const json = JSON.stringify({ locale: key, strings: clientStringsForLocale(key) }).replace(/</g, '\\u003c');
    const script = `window.__UI_I18N__=${json};\n`;
    const version = crypto.createHash('md5').update(script).digest('hex').slice(0, 8);
    asset = { json, script, version };
    _clientI18nAssets.set(key, asset);
  }
  return asset;
}

/** `/i18n/<locale>.js?v=<hash>` for the current request locale (served by server.js). */
export function clientI18nScriptUrl() {
  const locale = getLocale() === 'en' ? 'en' : 'ru';
  return `/i18n/${locale}.js?v=${clientI18nAsset(locale).version}`;
}

/** Script body and version for `GET /i18n/:locale.js`; null for an unknown locale. */
export function getClientI18nScript(locale) {
  if (locale !== 'ru' && locale !== 'en') return null;
  const { script, version } = clientI18nAsset(locale);
  return { script, version };
}
