/**
 * Theme sets («Наборы оформления»): snapshots of the site look — theme colors, background picture and
 * its sliders, header picture and layout, optionally the logo + favicon — shown on a schedule:
 *   - `rotate`: in turn every N hours / days (the main look can take part),
 *   - `calendar`: a set is shown inside its day range (MM-DD … MM-DD, may wrap over New Year),
 *     the main look the rest of the time.
 *
 * Storage: settings `ui_theme_sets` (JSON list) + `ui_theme_schedule` (JSON); the pictures of a set are
 * flat files `data/ui/theme-set-<id>-<file>` next to the main ones, so the portable backup (top-level
 * `data/ui` files + settings) carries them without changes.
 *
 * The active set is a pure function of the clock and those settings (no timers, no writes), so every
 * cluster worker shows the same set. ui-customization reads its appearance settings and files through
 * `themeSetSetting()` / `themeSetAssetPath()`; admin appearance routes run inside
 * `runWithBaseAppearance()` and always see and edit the main look. The Telegram bot avatar reads
 * `data/ui/logo.png` directly and is never switched by a schedule.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';

const UI_DIR = path.join(config.dataDir, 'ui');

export const THEME_SETS_SETTING = 'ui_theme_sets';
export const THEME_SCHEDULE_SETTING = 'ui_theme_schedule';
export const MAX_THEME_SETS = 24;
export const MAX_THEME_SET_NAME = 60;
export const MAX_ROTATE_HOURS = 24 * 7;
export const MAX_ROTATE_DAYS = 365;

/** Settings captured by every set (colors, background picture sliders, panel glass, header layout). */
export const THEME_SET_KEYS = Object.freeze([
  'ui_glass_color_dark', 'ui_glass_color_light',
  'ui_glass_text_dark', 'ui_glass_text_light',
  'ui_glass_muted_dark', 'ui_glass_muted_light',
  'ui_glass_link_dark', 'ui_glass_link_light',
  'ui_accent_dark', 'ui_accent_light',
  'ui_bg_overlay_color_dark', 'ui_bg_overlay_color_light',
  'ui_dynamic_theme_from_bg', 'ui_bg_palette_dark', 'ui_bg_palette_light',
  'ui_bg_blur', 'ui_bg_overlay', 'ui_bg_size', 'ui_bg_position',
  'ui_surface_opacity', 'ui_surface_blur', 'ui_panel_opacity', 'ui_topbar_opacity', 'ui_sidebar_opacity',
  'ui_header_height', 'ui_header_position', 'ui_header_size', 'ui_show_header',
  'ui_decor',
]);
/** Only with «включая логотип и иконку». */
export const THEME_SET_LOGO_KEYS = Object.freeze(['ui_show_logo']);
export const THEME_SET_FILES = Object.freeze(['background.webp', 'header.webp']);
export const THEME_SET_LOGO_FILES = Object.freeze(['logo.png', 'favicon-32.png', 'favicon-192.png']);

const SET_ID_RE = /^[a-f0-9]{8}$/;
const MONTH_DAY_RE = /^(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/* ── Base-appearance context ── */

const baseStore = new AsyncLocalStorage();

/** Runs `fn` (and everything it awaits) with the main appearance, ignoring the active set. */
export function runWithBaseAppearance(fn) {
  return baseStore.run(true, fn);
}

/** Express middleware: the rest of the request sees the main appearance (admin appearance pages). */
export function baseAppearanceMiddleware(req, res, next) {
  baseStore.run(true, next);
}

export function isBaseAppearanceContext() {
  return baseStore.getStore() === true;
}

/* ── Parsing ── */

/** 'MM-DD' or '' (invalid → ''). Accepts 'DD.MM' from the form as well. */
export function normalizeMonthDay(raw) {
  const s = String(raw ?? '').trim();
  let m = MONTH_DAY_RE.exec(s);
  let month;
  let day;
  if (m) {
    month = Number(m[1]);
    day = Number(m[2]);
  } else {
    m = /^(\d{1,2})\.(\d{1,2})$/.exec(s);
    if (!m) return '';
    day = Number(m[1]);
    month = Number(m[2]);
  }
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) return '';
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 'MM-DD' → 'DD.MM' for display; '' stays ''. */
export function formatMonthDay(md) {
  const m = MONTH_DAY_RE.exec(String(md || ''));
  return m ? `${m[2]}.${m[1]}` : '';
}

function sanitizeSet(raw) {
  if (!raw || typeof raw !== 'object' || !SET_ID_RE.test(String(raw.id || ''))) return null;
  const includeLogo = raw.includeLogo === true;
  const keys = includeLogo ? [...THEME_SET_KEYS, ...THEME_SET_LOGO_KEYS] : THEME_SET_KEYS;
  const allowedFiles = includeLogo ? [...THEME_SET_FILES, ...THEME_SET_LOGO_FILES] : THEME_SET_FILES;
  const settings = {};
  const src = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  for (const key of keys) settings[key] = typeof src[key] === 'string' ? src[key].slice(0, 4000) : '';
  const files = Array.isArray(raw.files) ? raw.files.filter((f) => allowedFiles.includes(f)) : [];
  return {
    id: raw.id,
    name: String(raw.name || '').trim().slice(0, MAX_THEME_SET_NAME) || raw.id,
    includeLogo,
    from: normalizeMonthDay(raw.from),
    to: normalizeMonthDay(raw.to),
    settings,
    files: [...new Set(files)],
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
  };
}

let _setsMemo = { raw: null, list: [] };
/** All sets in admin order (sanitized; memoized by the raw setting string). */
export function listThemeSets() {
  const raw = getSetting(THEME_SETS_SETTING);
  if (raw === _setsMemo.raw) return _setsMemo.list;
  let list = [];
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.map(sanitizeSet).filter(Boolean).slice(0, MAX_THEME_SETS);
  } catch { list = []; }
  _setsMemo = { raw, list };
  return list;
}

export function getThemeSet(id) {
  const key = String(id || '');
  if (!SET_ID_RE.test(key)) return null;
  return listThemeSets().find((s) => s.id === key) || null;
}

function saveThemeSets(list) {
  setSetting(THEME_SETS_SETTING, list.length ? JSON.stringify(list) : '');
}

export const DEFAULT_THEME_SCHEDULE = Object.freeze({ mode: 'off', every: 3, unit: 'days', includeBase: true });

let _scheduleMemo = { raw: null, value: DEFAULT_THEME_SCHEDULE };
export function getThemeSchedule() {
  const raw = getSetting(THEME_SCHEDULE_SETTING);
  if (raw === _scheduleMemo.raw) return _scheduleMemo.value;
  let value = DEFAULT_THEME_SCHEDULE;
  try {
    if (raw) value = normalizeThemeSchedule(JSON.parse(raw));
  } catch { value = DEFAULT_THEME_SCHEDULE; }
  _scheduleMemo = { raw, value };
  return value;
}

export function normalizeThemeSchedule(input = {}) {
  const mode = ['off', 'rotate', 'calendar'].includes(input.mode) ? input.mode : 'off';
  const unit = input.unit === 'hours' ? 'hours' : 'days';
  const max = unit === 'hours' ? MAX_ROTATE_HOURS : MAX_ROTATE_DAYS;
  const n = Math.trunc(Number(input.every));
  const every = Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : DEFAULT_THEME_SCHEDULE.every;
  const includeBase = input.includeBase !== false && input.includeBase !== '0' && input.includeBase !== 0;
  return Object.freeze({ mode, every, unit, includeBase });
}

export function saveThemeSchedule(input) {
  const value = normalizeThemeSchedule(input);
  setSetting(THEME_SCHEDULE_SETTING, value.mode === 'off' && value.every === DEFAULT_THEME_SCHEDULE.every
    && value.unit === DEFAULT_THEME_SCHEDULE.unit && value.includeBase ? '' : JSON.stringify(value));
  return value;
}

/* ── Resolution (pure: schedule + sets + time) ── */

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Server-local wall clock as a UTC-based ms count (so day boundaries fall at local midnight). */
function localMs(date) {
  return date.getTime() - date.getTimezoneOffset() * 60_000;
}

function monthDayOf(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** True when `md` lies in from…to (inclusive; from > to wraps over the year end). */
export function monthDayInRange(md, from, to) {
  if (!from || !to) return false;
  return from <= to ? (md >= from && md <= to) : (md >= from || md <= to);
}

function rotationCycle(schedule, sets) {
  const cycle = schedule.includeBase ? [null, ...sets] : [...sets];
  return cycle.length ? cycle : [null];
}

function rotationSlot(schedule, date) {
  const period = schedule.every * (schedule.unit === 'hours' ? HOUR_MS : DAY_MS);
  return Math.floor(localMs(date) / period);
}

/**
 * The set shown at `date` (null = main look). Pure function of the arguments; `sets` default to the
 * stored list, `schedule` to the stored schedule.
 */
export function resolveThemeSetAt(date = new Date(), schedule = getThemeSchedule(), sets = listThemeSets()) {
  if (!sets.length || schedule.mode === 'off') return null;
  if (schedule.mode === 'calendar') {
    const md = monthDayOf(date);
    return sets.find((s) => monthDayInRange(md, s.from, s.to)) || null;
  }
  const cycle = rotationCycle(schedule, sets);
  const slot = rotationSlot(schedule, date);
  return cycle[((slot % cycle.length) + cycle.length) % cycle.length];
}

/**
 * The next `count` changes after `date`: [{ at: Date, set: object|null }]. Rotation steps whole
 * periods; the calendar scans day by day (≤ 2 years).
 */
export function upcomingThemeSetChanges(date = new Date(), count = 3, schedule = getThemeSchedule(), sets = listThemeSets()) {
  const out = [];
  if (!sets.length || schedule.mode === 'off') return out;
  if (schedule.mode === 'rotate') {
    const cycle = rotationCycle(schedule, sets);
    if (cycle.length < 2) return out;
    const periodMs = schedule.every * (schedule.unit === 'hours' ? HOUR_MS : DAY_MS);
    let slot = rotationSlot(schedule, date);
    while (out.length < count) {
      slot += 1;
      const localStart = slot * periodMs;
      /* back from local wall-clock ms to a real instant (DST: offset of that instant) */
      const guess = new Date(localStart);
      const at = new Date(localStart + guess.getTimezoneOffset() * 60_000);
      out.push({ at, set: cycle[slot % cycle.length] });
    }
    return out;
  }
  let current = resolveThemeSetAt(date, schedule, sets);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  for (let i = 1; i <= 730 && out.length < count; i += 1) {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i);
    const set = resolveThemeSetAt(next, schedule, sets);
    if ((set?.id || null) !== (current?.id || null)) {
      out.push({ at: next, set });
      current = set;
    }
  }
  return out;
}

/** Set whose values the site shows right now; null in the base context or when the main look is on. */
export function activeThemeSetOverride() {
  if (isBaseAppearanceContext()) return null;
  return resolveThemeSetAt(new Date());
}

/* ── Lookups used by ui-customization ── */

function setKeys(set) {
  return set.includeLogo ? [...THEME_SET_KEYS, ...THEME_SET_LOGO_KEYS] : THEME_SET_KEYS;
}

function setCoversFile(set, fileName) {
  return THEME_SET_FILES.includes(fileName) || (set.includeLogo && THEME_SET_LOGO_FILES.includes(fileName));
}

/** Appearance setting as the site shows it: the active set's value when it covers `key`. */
export function themeSetSetting(key) {
  const set = activeThemeSetOverride();
  if (set && setKeys(set).includes(key)) return set.settings[key] ?? '';
  return getSetting(key);
}

export function themeSetFileName(id, fileName) {
  return `theme-set-${id}-${fileName}`;
}

/**
 * Path of an appearance file as the site shows it: `{ full, setId }`. `setId` = explicit set (the
 * `?s=` of a served URL, so a picture cached under one set's URL never gets another set's bytes) or
 * the active one. `full` is null when the set covers the file but has none (e.g. no own header).
 */
export function themeSetAssetPath(fileName, explicitSetId = '') {
  const set = explicitSetId ? getThemeSet(explicitSetId) : activeThemeSetOverride();
  if (set && setCoversFile(set, fileName)) {
    return {
      full: set.files.includes(fileName) ? path.join(UI_DIR, themeSetFileName(set.id, fileName)) : null,
      setId: set.id,
    };
  }
  return { full: path.join(UI_DIR, fileName), setId: '' };
}

/* ── Admin actions (main look ↔ set) ── */

function newSetId(existing) {
  for (;;) {
    const id = crypto.randomBytes(4).toString('hex');
    if (!existing.some((s) => s.id === id)) return id;
  }
}

function snapshotInto(set) {
  fs.mkdirSync(UI_DIR, { recursive: true });
  const settings = {};
  for (const key of setKeys(set)) settings[key] = getSetting(key);
  const files = [];
  const allFiles = set.includeLogo ? [...THEME_SET_FILES, ...THEME_SET_LOGO_FILES] : THEME_SET_FILES;
  for (const fileName of allFiles) {
    const dest = path.join(UI_DIR, themeSetFileName(set.id, fileName));
    const src = path.join(UI_DIR, fileName);
    if (fs.existsSync(src)) {
      /* copyFile gives the copy a fresh mtime → a new `?v=` URL, so browsers drop the old picture */
      fs.copyFileSync(src, dest);
      files.push(fileName);
    } else {
      fs.rmSync(dest, { force: true });
    }
  }
  return { ...set, settings, files, updatedAt: new Date().toISOString() };
}

function removeSetFiles(id) {
  for (const fileName of [...THEME_SET_FILES, ...THEME_SET_LOGO_FILES]) {
    fs.rmSync(path.join(UI_DIR, themeSetFileName(id, fileName)), { force: true });
  }
}

/** Saves the main look as a new set. Throws `admin.ui.sets.errorLimit` at MAX_THEME_SETS. */
export function createThemeSetFromCurrent({ name = '', includeLogo = false, from = '', to = '' } = {}) {
  const list = listThemeSets();
  if (list.length >= MAX_THEME_SETS) throw new Error('admin.ui.sets.errorLimit');
  const now = new Date().toISOString();
  const set = snapshotInto({
    id: newSetId(list),
    name: String(name || '').trim().slice(0, MAX_THEME_SET_NAME),
    includeLogo: includeLogo === true,
    from: normalizeMonthDay(from),
    to: normalizeMonthDay(to),
    createdAt: now,
  });
  const clean = sanitizeSet(set);
  saveThemeSets([...list, clean]);
  return clean;
}

/** Renames a set / changes its day range. */
export function updateThemeSet(id, { name, from, to } = {}) {
  const list = listThemeSets();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error('admin.ui.sets.errorNotFound');
  const next = { ...list[idx], updatedAt: new Date().toISOString() };
  if (name !== undefined) next.name = String(name || '').trim().slice(0, MAX_THEME_SET_NAME) || list[idx].name;
  if (from !== undefined) next.from = normalizeMonthDay(from);
  if (to !== undefined) next.to = normalizeMonthDay(to);
  const updated = [...list];
  updated[idx] = sanitizeSet(next);
  saveThemeSets(updated);
  return updated[idx];
}

/** Replaces a set's contents with the current main look (name, dates and logo option stay). */
export function replaceThemeSetFromCurrent(id) {
  const list = listThemeSets();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error('admin.ui.sets.errorNotFound');
  const updated = [...list];
  updated[idx] = sanitizeSet(snapshotInto(list[idx]));
  saveThemeSets(updated);
  return updated[idx];
}

/** Moves a set one step up / down in the list (rotation order, calendar priority). */
export function moveThemeSet(id, direction) {
  const list = [...listThemeSets()];
  const idx = list.findIndex((s) => s.id === id);
  const to = direction === 'up' ? idx - 1 : idx + 1;
  if (idx < 0 || to < 0 || to >= list.length) return;
  [list[idx], list[to]] = [list[to], list[idx]];
  saveThemeSets(list);
}

export function deleteThemeSet(id) {
  const list = listThemeSets();
  if (!list.some((s) => s.id === id)) throw new Error('admin.ui.sets.errorNotFound');
  removeSetFiles(id);
  saveThemeSets(list.filter((s) => s.id !== id));
}

/**
 * Copies a set into the main look (to edit it there and save it back with «Обновить из текущего»).
 * Returns `{ logoChanged }` so the caller can resync the Telegram bot avatar.
 */
export function applyThemeSetToBase(id) {
  const set = getThemeSet(id);
  if (!set) throw new Error('admin.ui.sets.errorNotFound');
  fs.mkdirSync(UI_DIR, { recursive: true });
  for (const key of setKeys(set)) setSetting(key, set.settings[key] ?? '');
  const files = set.includeLogo ? [...THEME_SET_FILES, ...THEME_SET_LOGO_FILES] : THEME_SET_FILES;
  for (const fileName of files) {
    const dest = path.join(UI_DIR, fileName);
    const src = path.join(UI_DIR, themeSetFileName(set.id, fileName));
    if (set.files.includes(fileName) && fs.existsSync(src)) fs.copyFileSync(src, dest);
    else fs.rmSync(dest, { force: true });
  }
  return { logoChanged: set.includeLogo };
}
