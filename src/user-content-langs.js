import { db, getSetting, getUserContentLangsRaw, setUserContentLangsRaw } from './db.js';

const LANG_CODE = /^[a-z]{2,8}$/;

/** Lower-case language codes, de-duplicated, in first-seen order. */
export function normalizeContentLangList(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const code = String(item || '').trim().toLowerCase();
    if (!LANG_CODE.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export function getUserContentLangs(username) {
  return normalizeContentLangList(getUserContentLangsRaw(username));
}

export function setUserContentLangs(username, langs) {
  setUserContentLangsRaw(username, normalizeContentLangList(langs).join(','));
}

/**
 * SQL fragment for a book language column.
 * `langs` is the user's saved set. A single `lang` further narrows it.
 * A requested language outside the set matches nothing.
 * @returns {{ where: string, params: string[] } | null}
 */
export function languageFilterClause(column, lang = '', langs = null) {
  const rawList = Array.isArray(langs) ? langs : [];
  const prefs = normalizeContentLangList(rawList);
  if (rawList.length && !prefs.length) return { where: '0', params: [] };
  const requested = String(lang || '').trim().toLowerCase();
  const hasRequest = LANG_CODE.test(requested);
  if (hasRequest && prefs.length && !prefs.includes(requested)) {
    return { where: '0', params: [] };
  }
  const list = hasRequest ? [requested] : prefs;
  if (!list.length) return null;
  if (list.length === 1) return { where: `${column} = ?`, params: list };
  return { where: `${column} IN (${list.map(() => '?').join(',')})`, params: list };
}

/**
 * What a book query should apply.
 * Empty prefs: only the page's `?lang=`.
 * Prefs set, no page lang: the saved set.
 * Both: the page lang when it is inside the set.
 */
export function mergeContentLangFilter(prefs, requestLang = '') {
  const saved = normalizeContentLangList(prefs);
  const requested = String(requestLang || '').trim().toLowerCase();
  const hasRequest = LANG_CODE.test(requested);
  if (hasRequest && saved.length && !saved.includes(requested)) {
    return { lang: '', langs: ['__none__'] };
  }
  if (hasRequest) return { lang: requested, langs: [] };
  if (!saved.length) return { lang: '', langs: [] };
  if (saved.length === 1) return { lang: saved[0], langs: [] };
  return { lang: '', langs: saved };
}

/**
 * Saved languages that the admin still allows.
 * A choice the admin has since turned off does not hide the catalog.
 */
export function effectiveContentLangs(username) {
  const saved = username ? getUserContentLangs(username) : [];
  if (!saved.length) return [];
  const enabled = new Set(listEnabledContentLangs());
  return saved.filter((code) => enabled.has(code));
}

export function resolveContentLangFilter(username, requestLang = '') {
  return mergeContentLangFilter(effectiveContentLangs(username), requestLang);
}

export function contentLangCacheKey(langs) {
  return normalizeContentLangList(langs).join(',');
}

let _stmtPresentLangs = null;
let _presentLangsCache = null;
let _presentLangsCacheAt = 0;
const PRESENT_LANGS_TTL_MS = 60_000;

/** Languages that still have books and that the admin left enabled. */
export function listEnabledContentLangs() {
  const now = Date.now();
  if (!_presentLangsCache || now - _presentLangsCacheAt >= PRESENT_LANGS_TTL_MS) {
    _stmtPresentLangs ??= db.prepare(`
      SELECT lang AS code
      FROM books
      WHERE deleted = 0 AND lang != ''
      GROUP BY lang
    `);
    const seen = new Set();
    const codes = [];
    for (const row of _stmtPresentLangs.all()) {
      const code = String(row.code || '').trim().toLowerCase();
      if (!LANG_CODE.test(code) || seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
    codes.sort();
    _presentLangsCache = codes;
    _presentLangsCacheAt = now;
  }
  const excluded = new Set(
    String(getSetting('excluded_languages') || '')
      .split(',')
      .map((code) => code.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!excluded.size) return _presentLangsCache;
  return _presentLangsCache.filter((code) => !excluded.has(code));
}

export function clearEnabledContentLangCache() {
  _presentLangsCache = null;
  _presentLangsCacheAt = 0;
}
