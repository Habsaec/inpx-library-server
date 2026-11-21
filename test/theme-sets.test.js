import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { getSetting, setSetting } from '../src/db.js';
import {
  normalizeMonthDay,
  monthDayInRange,
  normalizeThemeSchedule,
  saveThemeSchedule,
  resolveThemeSetAt,
  upcomingThemeSetChanges,
  createThemeSetFromCurrent,
  updateThemeSet,
  replaceThemeSetFromCurrent,
  applyThemeSetToBase,
  deleteThemeSet,
  moveThemeSet,
  listThemeSets,
  runWithBaseAppearance,
  themeSetSetting,
  themeSetAssetPath,
  themeSetFileName,
} from '../src/services/theme-sets.js';
import { getUiCustomization, getPublicUiSettingsJson, invalidateUiCustomizationCache } from '../src/services/ui-customization.js';

const uiDir = path.join(config.dataDir, 'ui');
const KEYS = ['ui_glass_color_dark', 'ui_accent_dark', 'ui_show_logo', 'ui_header_height'];

function resetAll() {
  for (const set of listThemeSets()) deleteThemeSet(set.id);
  setSetting('ui_theme_schedule', '');
  for (const key of KEYS) setSetting(key, '');
  for (const f of ['header.webp', 'logo.png', 'background.webp']) fs.rmSync(path.join(uiDir, f), { force: true });
  invalidateUiCustomizationCache();
}

before(() => { fs.mkdirSync(uiDir, { recursive: true }); resetAll(); });
after(() => resetAll());

/* A set object for the pure resolver (no storage). */
const fakeSet = (id, from = '', to = '') => ({ id, name: id, includeLogo: false, from, to, settings: {}, files: [] });

test('month-day parsing accepts DD.MM and MM-DD, rejects impossible dates', () => {
  assert.equal(normalizeMonthDay('20.12'), '12-20');
  assert.equal(normalizeMonthDay('1.1'), '01-01');
  assert.equal(normalizeMonthDay('02-29'), '02-29');
  assert.equal(normalizeMonthDay('31.04'), '');
  assert.equal(normalizeMonthDay('nonsense'), '');
  assert.equal(monthDayInRange('12-31', '12-20', '01-10'), true, 'wraps over New Year');
  assert.equal(monthDayInRange('01-05', '12-20', '01-10'), true);
  assert.equal(monthDayInRange('06-01', '12-20', '01-10'), false);
  assert.equal(monthDayInRange('06-01', '', ''), false);
});

test('schedule is clamped and defaults to off', () => {
  assert.deepEqual({ ...normalizeThemeSchedule({}) }, { mode: 'off', every: 3, unit: 'days', includeBase: true });
  assert.equal(normalizeThemeSchedule({ mode: 'rotate', every: 9999, unit: 'hours' }).every, 168);
  assert.equal(normalizeThemeSchedule({ mode: 'rotate', every: 0 }).every, 1);
  assert.equal(normalizeThemeSchedule({ mode: 'x' }).mode, 'off');
});

test('calendar: a set shows inside its range, the main look outside; higher in the list wins', () => {
  const sets = [fakeSet('aaaaaaaa', '12-20', '01-10'), fakeSet('bbbbbbbb', '12-01', '12-31')];
  const cal = normalizeThemeSchedule({ mode: 'calendar' });
  assert.equal(resolveThemeSetAt(new Date(2026, 11, 25), cal, sets).id, 'aaaaaaaa');
  assert.equal(resolveThemeSetAt(new Date(2027, 0, 3), cal, sets).id, 'aaaaaaaa');
  assert.equal(resolveThemeSetAt(new Date(2026, 11, 5), cal, sets).id, 'bbbbbbbb');
  assert.equal(resolveThemeSetAt(new Date(2026, 6, 1), cal, sets), null);
  const next = upcomingThemeSetChanges(new Date(2026, 10, 21), 3, cal, sets);
  assert.deepEqual(next.map((c) => [c.at.getMonth() + 1, c.at.getDate(), c.set?.id || null]),
    [[12, 1, 'bbbbbbbb'], [12, 20, 'aaaaaaaa'], [1, 11, null]]);
});

test('rotation: deterministic slots, main look included or not', () => {
  const sets = [fakeSet('aaaaaaaa'), fakeSet('bbbbbbbb')];
  const withBase = normalizeThemeSchedule({ mode: 'rotate', every: 12, unit: 'hours' });
  const t0 = new Date(2026, 10, 21, 1, 0);
  const seen = [0, 12, 24, 36].map((h) => resolveThemeSetAt(new Date(t0.getTime() + h * 3600_000), withBase, sets)?.id || null);
  assert.equal(new Set(seen).size, 3, `base + 2 sets in turn: ${seen}`);
  assert.equal(seen[0], seen[3]);
  /* same instant → same answer (every cluster worker agrees) */
  assert.equal(resolveThemeSetAt(t0, withBase, sets)?.id, resolveThemeSetAt(new Date(t0), withBase, sets)?.id);
  const noBase = normalizeThemeSchedule({ mode: 'rotate', every: 1, unit: 'days', includeBase: false });
  for (let d = 0; d < 6; d += 1) assert.ok(resolveThemeSetAt(new Date(2026, 10, 21 + d, 15), noBase, sets));
  const changes = upcomingThemeSetChanges(new Date(2026, 10, 21, 15), 2, noBase, sets);
  assert.equal(changes[0].at.getHours(), 0, 'day boundary at local midnight');
  assert.equal(changes[0].at.getDate(), 22);
  assert.equal(resolveThemeSetAt(new Date(2026, 10, 21), normalizeThemeSchedule({ mode: 'off' }), sets), null);
});

test('a scheduled set overrides appearance reads; admin (base) context sees the main look', () => {
  setSetting('ui_glass_color_dark', '#223344');
  setSetting('ui_accent_dark', '#ff8800');
  fs.writeFileSync(path.join(uiDir, 'header.webp'), Buffer.from('main-header'));
  const set = createThemeSetFromCurrent({ name: 'Новый год', from: '01.01', to: '31.12' });
  assert.deepEqual(set.files, ['header.webp']);
  assert.equal(fs.readFileSync(path.join(uiDir, themeSetFileName(set.id, 'header.webp')), 'utf8'), 'main-header');

  /* change the main look after the snapshot */
  setSetting('ui_glass_color_dark', '#101010');
  setSetting('ui_accent_dark', '');
  fs.writeFileSync(path.join(uiDir, 'header.webp'), Buffer.from('new-main-header'));
  invalidateUiCustomizationCache();

  saveThemeSchedule({ mode: 'calendar' });
  assert.equal(themeSetSetting('ui_glass_color_dark'), '#223344');
  assert.equal(themeSetSetting('site_name'), getSetting('site_name'), 'keys outside a set fall through');
  assert.equal(themeSetSetting('ui_show_logo'), getSetting('ui_show_logo'), 'logo keys only with includeLogo');
  const asset = themeSetAssetPath('header.webp');
  assert.equal(asset.setId, set.id);
  assert.equal(themeSetAssetPath('logo.png').setId, '', 'logo stays the main one');

  const ui = getUiCustomization();
  assert.equal(ui.glassColorDark, '#223344');
  assert.match(ui.headerUrl, new RegExp(`&s=${set.id}$`));
  assert.equal(getPublicUiSettingsJson().appPaletteDark.surface, '#223344', 'Android gets the set palette');

  runWithBaseAppearance(() => {
    assert.equal(themeSetSetting('ui_glass_color_dark'), '#101010');
    const base = getUiCustomization();
    assert.equal(base.glassColorDark, '#101010');
    assert.doesNotMatch(base.headerUrl, /&s=/);
  });

  saveThemeSchedule({ mode: 'off' });
  invalidateUiCustomizationCache();
  assert.equal(getUiCustomization().glassColorDark, '#101010');
});

test('apply / replace / rename / move / delete', () => {
  resetAll();
  setSetting('ui_accent_dark', '#00aa55');
  fs.writeFileSync(path.join(uiDir, 'logo.png'), Buffer.from('logo-a'));
  const a = createThemeSetFromCurrent({ name: 'A', includeLogo: true });
  assert.deepEqual(a.files, ['logo.png']);
  setSetting('ui_accent_dark', '#aa0055');
  fs.rmSync(path.join(uiDir, 'logo.png'));
  const b = createThemeSetFromCurrent({ name: 'B' });

  const { logoChanged } = applyThemeSetToBase(a.id);
  assert.equal(logoChanged, true);
  assert.equal(getSetting('ui_accent_dark'), '#00aa55');
  assert.equal(fs.readFileSync(path.join(uiDir, 'logo.png'), 'utf8'), 'logo-a');

  setSetting('ui_accent_dark', '#123456');
  replaceThemeSetFromCurrent(b.id);
  assert.equal(listThemeSets().find((s) => s.id === b.id).settings.ui_accent_dark, '#123456');

  updateThemeSet(a.id, { name: 'A2', from: '1.3', to: 'bad' });
  const a2 = listThemeSets().find((s) => s.id === a.id);
  assert.equal(a2.name, 'A2');
  assert.equal(a2.from, '03-01');
  assert.equal(a2.to, '');

  moveThemeSet(b.id, 'up');
  assert.deepEqual(listThemeSets().map((s) => s.name), ['B', 'A2']);

  deleteThemeSet(a.id);
  assert.equal(fs.existsSync(path.join(uiDir, themeSetFileName(a.id, 'logo.png'))), false, 'set files removed');
  assert.deepEqual(listThemeSets().map((s) => s.name), ['B']);
  assert.throws(() => deleteThemeSet(a.id), /errorNotFound/);
});

test('set file names pass the portable-backup file filter (flat data/ui files)', () => {
  const UI_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
  assert.ok(UI_FILE_RE.test(themeSetFileName('0a1b2c3d', 'favicon-192.png')));
});

test('seasonal decoration is an appearance setting carried by theme sets', async () => {
  const { THEME_SET_KEYS } = await import('../src/services/theme-sets.js');
  assert.ok(THEME_SET_KEYS.includes('ui_decor'));
  const { saveUiSettings } = await import('../src/services/ui-customization.js');
  saveUiSettings({ decor: 'snow' });
  invalidateUiCustomizationCache();
  assert.equal(getUiCustomization().decor, 'snow');
  saveUiSettings({ decor: 'drifts, snow,garland,bogus' });
  invalidateUiCustomizationCache();
  assert.equal(getUiCustomization().decor, 'snow,garland,drifts', 'any combination, canonical order, unknown names dropped');
  saveUiSettings({ decor: '<script>' });
  invalidateUiCustomizationCache();
  assert.equal(getUiCustomization().decor, '', 'unknown values are dropped');
});
