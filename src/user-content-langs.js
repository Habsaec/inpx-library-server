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
  const list = expandLangSpellings(hasRequest ? [requested] : prefs);
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

/** Raw `books.lang` values: INPX may spell one language as `ru`, `RU` and `Ru`. */
function presentRawLangs() {
  const now = Date.now();
  if (!_presentLangsCache || now - _presentLangsCacheAt >= PRESENT_LANGS_TTL_MS) {
    _stmtPresentLangs ??= db.prepare(`
      SELECT lang AS code
      FROM books
      WHERE deleted = 0 AND lang != ''
      GROUP BY lang
    `);
    _presentLangsCache = _stmtPresentLangs.all().map((row) => String(row.code || ''));
    _presentLangsCacheAt = now;
  }
  return _presentLangsCache;
}

/** The admin hides exact raw values (same comparison as the `active_books` view). */
function enabledRawLangs() {
  const excluded = new Set(
    String(getSetting('excluded_languages') || '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean)
  );
  return presentRawLangs().filter((raw) => !excluded.has(raw.trim()));
}

/** Languages that still have books and that the admin left enabled. */
export function listEnabledContentLangs() {
  const seen = new Set();
  for (const raw of enabledRawLangs()) {
    const code = raw.trim().toLowerCase();
    if (LANG_CODE.test(code)) seen.add(code);
  }
  return [...seen].sort();
}

/** Raw spellings of lower-case codes, for an index-friendly `lang IN (...)`. */
function expandLangSpellings(codes) {
  let raws;
  try {
    raws = enabledRawLangs();
  } catch {
    return codes;
  }
  const wanted = new Set(codes);
  const out = [...codes];
  for (const raw of raws) {
    if (wanted.has(raw.trim().toLowerCase()) && !out.includes(raw)) out.push(raw);
  }
  return out;
}

export function clearEnabledContentLangCache() {
  _presentLangsCache = null;
  _presentLangsCacheAt = 0;
}
