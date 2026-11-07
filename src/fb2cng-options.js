/**
 * Настройки конвертации fb2cng (Админка → Контент → «Конвертация»).
 *
 * Хранится разреженный JSON `fb2cng_options` — только отличия от значений, которые уже заданы в
 * поставляемом converter/fb2cng.yaml. При конвертации берётся базовый YAML (FB2CNG_CONFIG_PATH или
 * converter/fb2cng.yaml), в нём точечно заменяются значения и результат кладётся в
 * data/converter/fb2cng-<hash>.yaml (fbc не умеет объединять несколько `-c`: берётся последний).
 * В YAML попадают булевы / enum / ограниченные числа из белого списка; текстовые значения (шаблоны Go)
 * пишутся только как блочный скаляр `|` с фиксированным отступом, свой CSS — отдельным файлом в
 * data/converter/ (в конфиг идёт путь, который строим мы), виньетки — только `builtin`.
 * Перед сохранением конфиг проверяет сам fbc (`dumpconfig`).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.js';
import { getSetting } from './db.js';
import { getFb2cngBinaryPath } from './fb2cng-binary.js';
import { detectImageMimeFromBuffer } from './services/cover.js';

// Виньетка: 'off' | 'builtin' | 'file:<sha1-16>.<png|jpg|gif|webp>' (загруженная картинка в data/converter/vignettes/).
const VIGNETTE_FILE_RE = /^file:[0-9a-f]{16}\.(png|jpg|gif|webp)$/;
const vignette = (key, pathKey, group = 'vignettes') => (
  { key, path: `document.vignettes.${pathKey}`, type: 'vignette', def: 'off', group }
);
export const VIGNETTE_MAX_BYTES = 1024 * 1024;
const VIGNETTE_EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function getVignetteDir() {
  return path.join(config.dataDir, 'converter', 'vignettes');
}

/** Сохранить загруженную картинку; возвращает токен 'file:<hash>.<ext>'. Тип определяется по байтам. */
export async function saveVignetteImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('EMPTY');
  if (buffer.length > VIGNETTE_MAX_BYTES) throw new Error('TOO_BIG');
  const ext = VIGNETTE_EXT_BY_MIME[detectImageMimeFromBuffer(buffer)];
  if (!ext) throw new Error('BAD_TYPE');
  const name = `${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}.${ext}`;
  const dir = getVignetteDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tmp, buffer);
    await fs.promises.rename(tmp, target);
  }
  return `file:${name}`;
}

/** Удалить загруженные картинки, на которые не ссылается ни одна сохранённая виньетка (старше часа). */
export async function gcVignetteImages(options) {
  const keep = new Set(Object.values(options || {}).filter((v) => typeof v === 'string' && VIGNETTE_FILE_RE.test(v)).map((v) => v.slice(5)));
  let names = [];
  try { names = await fs.promises.readdir(getVignetteDir()); } catch { return; }
  for (const name of names) {
    if (keep.has(name) || !/^[0-9a-f]{16}\.(png|jpg|gif|webp)$/.test(name)) continue;
    try {
      const p = path.join(getVignetteDir(), name);
      if (Date.now() - (await fs.promises.stat(p)).mtimeMs > 3600_000) await fs.promises.unlink(p);
    } catch { /* ignore */ }
  }
}

/** fbc 1.9.5 `dumpconfig --default`: шаблон заголовка оглавления (в поставляемом fb2cng.yaml его нет). */
export const DEFAULT_AUTHORS_TEMPLATE = `{{- $names := list -}}
{{- range .Authors -}}
{{-   $name := list -}}
{{-   if .FirstName -}}{{ $name = append $name .FirstName -}}{{- end -}}
{{-   if .MiddleName -}}{{ $name = append $name .MiddleName -}}{{- end -}}
{{-   if .LastName -}}{{ $name = append $name .LastName }}{{- end -}}
{{-   if and (not $name) .Nickname -}}{{ $name = append $name .Nickname }}{{- end -}}
{{-   $names = append $names (join " " $name) -}}
{{- end -}}
{{- join ", " $names -}}`;

// C0 controls except TAB and LF, DEL, line / paragraph separators
const CONTROL_CHARS_RE = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]', 'g');
export const FB2CNG_TEXT_MAX = 4000;
export const FB2CNG_CSS_MAX = 200_000;

export const FB2CNG_OPTION_DEFS = [
  { key: 'footnotes_mode', path: 'document.footnotes.mode', type: 'enum', values: ['default', 'float', 'floatRenumbered'], def: 'float', group: 'text' },
  { key: 'annotation', path: 'document.annotation.enable', type: 'bool', def: true, group: 'text' },
  { key: 'toc_page', path: 'document.toc_page.placement', type: 'enum', values: ['none', 'before', 'after'], def: 'before', group: 'text' },
  { key: 'toc_type', path: 'document.toc_type', type: 'enum', values: ['normal', 'old_kindle', 'flat'], def: 'normal', group: 'text' },
  { key: 'page_map', path: 'document.page_map.enable', type: 'bool', def: true, group: 'text' },
  { key: 'open_from_cover', path: 'document.open_from_cover', type: 'bool', def: true, group: 'text' },
  { key: 'soft_hyphen', path: 'document.insert_soft_hyphen', type: 'bool', def: false, group: 'text' },
  { key: 'dropcaps', path: 'document.dropcaps.enable', type: 'bool', def: false, group: 'text' },
  { key: 'transliterate_meta', path: 'document.metainformation.transliterate', type: 'bool', def: false, group: 'text' },
  { key: 'fix_zip', path: 'document.fix_zip', type: 'bool', def: false, group: 'text' },
  { key: 'fix_speech', path: 'document.text_transformations.speech.enable', type: 'bool', def: true, group: 'fix' },
  { key: 'fix_dashes', path: 'document.text_transformations.dashes.enable', type: 'bool', def: true, group: 'fix' },
  { key: 'fix_dialogue', path: 'document.text_transformations.dialogue.enable', type: 'bool', def: false, group: 'fix' },
  { key: 'img_optimize', path: 'document.images.optimize', type: 'bool', def: true, group: 'images' },
  { key: 'img_jpeg_quality', path: 'document.images.jpeg_quality_level', type: 'int', min: 40, max: 100, def: 85, group: 'images' },
  { key: 'img_scale', path: 'document.images.scale_factor', type: 'float', min: 0.1, max: 1, def: 1, group: 'images' },
  { key: 'img_remove_transparency', path: 'document.images.remove_transparency', type: 'bool', def: false, group: 'images' },
  { key: 'img_use_broken', path: 'document.images.use_broken', type: 'bool', def: false, group: 'images' },
  { key: 'screen_width', path: 'document.images.screen.width', type: 'int', min: 600, max: 4000, def: 1264, group: 'images' },
  { key: 'screen_height', path: 'document.images.screen.height', type: 'int', min: 600, max: 4000, def: 1680, group: 'images' },
  { key: 'cover_generate', path: 'document.images.cover.generate', type: 'bool', def: true, group: 'images' },
  { key: 'cover_resize', path: 'document.images.cover.resize', type: 'enum', values: ['none', 'keepAR', 'stretch', 'fit'], def: 'stretch', group: 'images' },
  { key: 'screen_dpi', path: 'document.images.screen.dpi', type: 'int', min: 72, max: 600, def: 300, group: 'images', since: '1.9.0' },
  { key: 'img_rasterize_svg', path: 'document.images.rasterize_svg', type: 'bool', def: false, group: 'images', since: '1.9.0' },
  { key: 'img_raster_format', path: 'document.images.raster_format', type: 'enum', values: ['auto', 'jpeg'], def: 'auto', group: 'images', since: '1.9.0' },
  { key: 'page_map_size', path: 'document.page_map.size', type: 'int', min: 500, max: 20000, def: 2300, group: 'text' },
  { key: 'annotation_in_toc', path: 'document.annotation.in_toc', type: 'bool', def: true, group: 'text' },
  { key: 'toc_untitled', path: 'document.toc_page.include_chapters_without_title', type: 'bool', def: false, group: 'text' },
  { key: 'kfx_compression', path: 'document.kfx.compression', type: 'enum', values: ['none', 'lzma'], def: 'none', group: 'kindle', since: '1.9.0' },
  { key: 'pdf_page_frame', path: 'document.pdf.page_frame', type: 'enum', values: ['0', '0.5pt', '1pt', '2pt', '1px'], def: '0', group: 'pdf', since: '1.9.5' },
  { key: 'md_images', path: 'document.images.markdown', type: 'enum', values: ['placeholder', 'embedded'], def: 'placeholder', group: 'md', since: '1.9.0' },
  // Шаблоны Go (text/template + slim-sprig). '' = оставить как в базовом конфиге. Проверяет fbc при сохранении.
  { key: 'tpl_title', path: 'document.metainformation.title_template', type: 'text', def: '', group: 'templates', fallback: '' },
  { key: 'tpl_creator', path: 'document.metainformation.creator_name_template', type: 'text', def: '', group: 'templates', fallback: '' },
  { key: 'tpl_toc_authors', path: 'document.toc_page.authors_template', type: 'text', def: '', group: 'templates', fallback: DEFAULT_AUTHORS_TEMPLATE },
  // Свой CSS целиком заменяет встроенный стиль fbc. Пишется в data/converter/css-<hash>.css.
  { key: 'custom_css', path: 'document.stylesheet_path', type: 'css', def: '', group: 'css' },
  vignette('vg_book_top', 'book.title_top'),
  vignette('vg_book_bottom', 'book.title_bottom'),
  vignette('vg_chapter_top', 'chapter.title_top'),
  vignette('vg_chapter_bottom', 'chapter.title_bottom'),
  vignette('vg_chapter_end', 'chapter.end'),
  vignette('vg_section_top', 'section.title_top'),
  vignette('vg_section_bottom', 'section.title_bottom'),
  vignette('vg_section_end', 'section.end')
];

/* ───────────── версия fbc ───────────── */

let versionMemo = { path: null, mtime: 0, checkedAt: 0, value: '' };

export function resetFb2cngVersionCache() {
  versionMemo = { path: null, mtime: 0, checkedAt: 0, value: '' };
}

/** Версия бинарника fbc ('1.9.5') или '' (нет бинарника / не удалось определить). Перепроверяется при смене файла. */
export function getFb2cngVersion() {
  const now = Date.now();
  const bin = getFb2cngBinaryPath();
  if (!bin) return '';
  if (versionMemo.path === bin && now - versionMemo.checkedAt < 5000) return versionMemo.value;
  let mtime = 0;
  try { mtime = fs.statSync(bin).mtimeMs; } catch { /* missing */ }
  if (versionMemo.path === bin && versionMemo.mtime === mtime && mtime) {
    versionMemo.checkedAt = now;
    return versionMemo.value;
  }
  let value = '';
  if (mtime) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout || ''} ${r.stderr || ''}`);
      if (m) value = `${m[1]}.${m[2]}.${m[3]}`;
    } catch { /* version stays unknown */ }
  }
  versionMemo = { path: bin, mtime, checkedAt: now, value };
  return value;
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** fbc не older than `min`; при неизвестной версии считаем, что поддерживает (не прячем возможности вслепую). */
export function fb2cngSupports(min) {
  const v = getFb2cngVersion();
  return !v || cmpVersion(v, min) >= 0;
}

/** Опция известна установленному fbc (в старый бинарник ключи 1.9 не пишем — он отклонит конфиг). */
export function isFb2cngOptionSupported(def) {
  return !def.since || fb2cngSupports(def.since);
}

/* ───────────── нормализация ───────────── */

const DEFS_BY_KEY = new Map(FB2CNG_OPTION_DEFS.map((d) => [d.key, d]));

/** Текст шаблона: без \r и управляющих символов, без хвостовых пробелов строк, не длиннее лимита. */
export function cleanTemplateText(raw, max = FB2CNG_TEXT_MAX) {
  const s = String(raw ?? '')
    .replace(/\r\n?/g, '\n')

    .replace(CONTROL_CHARS_RE, "")
    .split('\n').map((l) => l.replace(/[ \t]+$/, '').replace(/\t/g, '    ')).join('\n')
    .trim();
  return s.slice(0, max);
}

function normalizeValue(def, raw) {
  if (def.type === 'bool') {
    if (raw === true || raw === '1' || raw === 'true' || raw === 'on' || raw === 1) return true;
    if (raw === false || raw === '0' || raw === 'false' || raw === 'off' || raw === 0) return false;
    return def.def;
  }
  if (def.type === 'enum') {
    const v = String(raw ?? '').trim();
    return def.values.includes(v) ? v : def.def;
  }
  if (def.type === 'vignette') {
    const v = String(raw ?? '').trim();
    return v === 'builtin' || VIGNETTE_FILE_RE.test(v) ? v : def.def;
  }
  if (def.type === 'text') return cleanTemplateText(raw, FB2CNG_TEXT_MAX);
  if (def.type === 'css') return cleanTemplateText(raw, FB2CNG_CSS_MAX);
  const n = Number(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return def.def;
  const clamped = Math.min(def.max, Math.max(def.min, n));
  return def.type === 'int' ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

/** Полный набор значений (по умолчанию + переопределения) из произвольного объекта. */
export function normalizeFb2cngOptions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const def of FB2CNG_OPTION_DEFS) {
    out[def.key] = Object.prototype.hasOwnProperty.call(src, def.key) ? normalizeValue(def, src[def.key]) : def.def;
  }
  return out;
}

/** Только отличия от значений по умолчанию. */
export function diffFb2cngOptions(full) {
  const out = {};
  for (const def of FB2CNG_OPTION_DEFS) {
    if (full[def.key] !== def.def && isFb2cngOptionSupported(def)) out[def.key] = full[def.key];
  }
  return out;
}

export function parseFb2cngOptionsSetting(raw) {
  if (!raw) return normalizeFb2cngOptions({});
  try {
    return normalizeFb2cngOptions(JSON.parse(String(raw)));
  } catch {
    return normalizeFb2cngOptions({});
  }
}

/* ───────────── чтение / запись YAML ───────────── */

const indentOf = (line) => line.match(/^ */)[0].length;
const isSkippable = (line) => /^\s*(#.*)?$/.test(line);

/** Конец блока, начатого строкой `start` (первая строка с отступом <= отступа родителя). */
function blockEnd(lines, start, from) {
  const parentIndent = indentOf(lines[start]);
  let i = from;
  for (; i < lines.length; i += 1) {
    if (isSkippable(lines[i])) continue;
    if (indentOf(lines[i]) <= parentIndent) break;
  }
  // не захватываем хвостовые пустые строки/комментарии
  while (i > from && isSkippable(lines[i - 1])) i -= 1;
  return i;
}

function splitLines(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Строки значения: скаляр — одна строка `key: v`, блок — `key: |2-` + строки с фиксированным отступом. */
function renderEntry(pad, key, value) {
  if (value && typeof value === 'object' && 'block' in value) {
    const body = String(value.block).split('\n').map((l) => (l === '' ? '' : `${pad}  ${l}`));
    return [`${pad}${key}: |2-`, ...body];
  }
  return [`${pad}${key}: ${value}`];
}

/**
 * Задать значение по пути a.b.c в простом YAML (отступ — пробелы).
 * `value` — строка (скаляр) или `{ block: 'многострочный текст' }`.
 */
export function setYamlValue(text, keyPath, value) {
  const lines = splitLines(text);
  const keys = keyPath.split('.');
  let from = 0;
  let to = lines.length;
  let childIndent = 0;
  for (let depth = 0; depth < keys.length; depth += 1) {
    const key = keys[depth];
    const last = depth === keys.length - 1;
    const re = new RegExp(`^( *)${key}:(.*)$`);
    let found = -1;
    for (let i = from; i < to; i += 1) {
      if (isSkippable(lines[i])) continue;
      const m = re.exec(lines[i]);
      if (m && (depth === 0 ? m[1].length === 0 : m[1].length === childIndent)) { found = i; break; }
    }
    if (found < 0) {
      // ключа нет — создаём недостающую цепочку в конце блока родителя
      const baseIndent = depth === 0 ? 0 : childIndent;
      const add = [];
      for (let d = depth; d < keys.length; d += 1) {
        const pad = ' '.repeat(baseIndent + (d - depth) * 2);
        if (d === keys.length - 1) add.push(...renderEntry(pad, keys[d], value));
        else add.push(`${pad}${keys[d]}:`);
      }
      lines.splice(to, 0, ...add);
      return lines.join('\n');
    }
    if (last) {
      const pad = ' '.repeat(indentOf(lines[found]));
      // старое значение (в т.ч. блочный скаляр) заменяем целиком
      const end = blockEnd(lines, found, found + 1);
      lines.splice(found, end - found, ...renderEntry(pad, key, value));
      return lines.join('\n');
    }
    from = found + 1;
    to = blockEnd(lines, found, from);
    // отступ детей — по первой непустой строке блока, иначе +4
    let ci = indentOf(lines[found]) + 4;
    for (let i = from; i < to; i += 1) { if (!isSkippable(lines[i])) { ci = indentOf(lines[i]); break; } }
    childIndent = ci;
  }
  return lines.join('\n');
}

/** Совместимость: скалярная запись. */
export function setYamlScalar(text, keyPath, valueText) {
  return setYamlValue(text, keyPath, valueText);
}

/** Прочитать блочный (`|`) или обычный скаляр по пути; null — ключа нет. */
export function readYamlText(text, keyPath) {
  const lines = splitLines(text);
  const keys = keyPath.split('.');
  let from = 0;
  let to = lines.length;
  let childIndent = 0;
  for (let depth = 0; depth < keys.length; depth += 1) {
    const re = new RegExp(`^( *)${keys[depth]}:(.*)$`);
    let found = -1;
    for (let i = from; i < to; i += 1) {
      if (isSkippable(lines[i])) continue;
      const m = re.exec(lines[i]);
      if (m && (depth === 0 ? m[1].length === 0 : m[1].length === childIndent)) { found = i; break; }
    }
    if (found < 0) return null;
    if (depth === keys.length - 1) {
      const inline = /^\s*(.*)$/.exec(lines[found].replace(/^ *[^:]+:/, ''))[1];
      if (/^[|>][0-9+-]*\s*$/.test(inline)) {
        const end = blockEnd(lines, found, found + 1);
        const body = lines.slice(found + 1, end);
        const min = Math.min(...body.filter((l) => l.trim()).map(indentOf), Infinity);
        return body.map((l) => l.slice(Number.isFinite(min) ? min : 0)).join('\n').trim();
      }
      return inline.replace(/^["']|["']$/g, '');
    }
    from = found + 1;
    to = blockEnd(lines, found, from);
    let ci = indentOf(lines[found]) + 4;
    for (let i = from; i < to; i += 1) { if (!isSkippable(lines[i])) { ci = indentOf(lines[i]); break; } }
    childIndent = ci;
  }
  return null;
}

export function readBaseConfigText() {
  const p = config.fb2cngConfigPath;
  if (p) {
    try { return fs.readFileSync(p, 'utf8'); } catch { /* fall through */ }
  }
  return 'version: 1\n';
}

/** Значение шаблона в базовом конфиге (или встроенный дефолт fbc) — для подстановки в форму. */
export function getFb2cngTemplateDefaults() {
  const base = readBaseConfigText();
  const out = {};
  for (const def of FB2CNG_OPTION_DEFS) {
    if (def.type !== 'text') continue;
    out[def.key] = cleanTemplateText(readYamlText(base, def.path) ?? def.fallback ?? '');
  }
  return out;
}

/** Значения из тела формы админки (checkbox: «1» либо отсутствует). Шаблон, равный базовому, = «не менять». */
export function fb2cngOptionsFromForm(body, templateDefaults = null) {
  const src = {};
  for (const def of FB2CNG_OPTION_DEFS) {
    if (def.type === 'bool') src[def.key] = body?.[`fb2cng_${def.key}`] === '1';
    else src[def.key] = body?.[`fb2cng_${def.key}`];
  }
  const full = normalizeFb2cngOptions(src);
  if (templateDefaults) {
    for (const def of FB2CNG_OPTION_DEFS) {
      if (def.type === 'text' && full[def.key] === templateDefaults[def.key]) full[def.key] = '';
    }
  }
  return full;
}

function yamlScalar(def, value) {
  if (def.type === 'bool') return value ? 'true' : 'false';
  if (def.type === 'float') return Number.isInteger(value) ? `${value}.0` : String(value);
  if (def.type === 'enum' && def.group === 'vignettes') return value; // 'builtin'
  return String(value);
}

/**
 * Собрать YAML: базовый текст + отличия. `files.cssPath` — путь файла со своим CSS (его пишет вызывающий).
 */
export function buildFb2cngConfigText(baseText, options, files = {}) {
  let text = baseText;
  const diff = diffFb2cngOptions(normalizeFb2cngOptions(options));
  for (const key of Object.keys(diff)) {
    const def = DEFS_BY_KEY.get(key);
    if (def.type === 'text') text = setYamlValue(text, def.path, { block: diff[key] });
    else if (def.type === 'css') text = setYamlValue(text, def.path, JSON.stringify(files.cssPath || 'custom.css'));
    else if (def.type === 'vignette') {
      const v = diff[key];
      if (v === 'builtin') text = setYamlValue(text, def.path, 'builtin');
      else text = setYamlValue(text, def.path, JSON.stringify(path.join(files.vignetteDir || getVignetteDir(), v.slice(5))));
    }
    else text = setYamlValue(text, def.path, yamlScalar(def, diff[key]));
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Записать файл атомарно (tmp → rename). */
function writeFileAtomicSync(target, content) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/** Свой CSS → <dir>/css-<hash>.css; возвращает путь или ''. */
function materializeCssSync(options, dir) {
  const css = normalizeFb2cngOptions(options).custom_css;
  if (!css) return '';
  const name = `css-${crypto.createHash('sha1').update(css).digest('hex').slice(0, 16)}.css`;
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) writeFileAtomicSync(target, `${css}\n`);
  return target;
}

/* ───────────── хэш и путь конфига для запуска ───────────── */

let memo = { raw: null, version: null, hash: '', optionsDiff: {} };

/** Хэш активных переопределений ('' = нет) — входит в ключ кэша конвертации. */
export function getFb2cngOptionsHash() {
  const raw = getSetting('fb2cng_options') || '';
  const version = getFb2cngVersion();
  if (memo.raw === raw && memo.version === version) return memo.hash;
  const diff = diffFb2cngOptions(parseFb2cngOptionsSetting(raw));
  const hash = Object.keys(diff).length
    ? crypto.createHash('sha1').update(JSON.stringify(diff)).digest('hex').slice(0, 12)
    : '';
  memo = { raw, version, hash, optionsDiff: diff };
  return hash;
}

/**
 * Путь конфига для запуска fbc: при пустых переопределениях — базовый (как раньше),
 * иначе сгенерированный data/converter/fb2cng-<hash>-<версия fbc>.yaml.
 */
export function resolveFb2cngConfigForRun() {
  const hash = getFb2cngOptionsHash();
  if (!hash) return config.fb2cngConfigPath || '';
  const dir = path.join(config.dataDir, 'converter');
  const target = path.join(dir, `fb2cng-${hash}-${memo.version || '0'}.yaml`);
  if (fs.existsSync(target)) return target;
  fs.mkdirSync(dir, { recursive: true });
  const cssPath = materializeCssSync(memo.optionsDiff, dir);
  writeFileAtomicSync(target, buildFb2cngConfigText(readBaseConfigText(), memo.optionsDiff, { cssPath }));
  return target;
}

/* ───────────── проверка самим fbc ───────────── */

const SAMPLE_FB2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink"><description><title-info><genre>sf</genre><author><first-name>Ivan</first-name><middle-name>I</middle-name><last-name>Ivanov</last-name></author><book-title>Test</book-title><annotation><p>Annotation</p></annotation><lang>en</lang><sequence name="Test Cycle" number="2"/></title-info><document-info><author><nickname>t</nickname></author><date>2026-01-01</date><id>fb2cng-check</id><version>1.0</version></document-info></description><body><title><p>Test</p></title><section><title><p>One</p></title><p>Text<a l:href="#n1" type="note">[1]</a>.</p></section></body><body name="notes"><section id="n1"><title><p>1</p></title><p>Note.</p></section></body></FictionBook>`;

function lastErrorLine(out) {
  const lines = String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => /error|fail|template/i.test(l));
  return (err.length ? err.slice(-2) : lines.slice(-2)).join(' ').slice(0, 400);
}


function runFbc(bin, args, cwd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -1, out: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', (c) => { if (out.length < 16000) out += String(c); });
    child.stderr.on('data', (c) => { if (out.length < 16000) out += String(c); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * Записать конфиг для `options` во временную папку и прогнать `fbc dumpconfig`.
 * `bin` — какой бинарник проверять (по умолчанию используемый сейчас).
 * Неизвестное поле / значение / ошибка шаблона → `{ ok: false, error }`.
 */
export async function validateFb2cngOptions(options, bin = getFb2cngBinaryPath()) {
  if (!bin) return { ok: true, skipped: true };
  const dir = path.join(config.conversionTempDir, `cfgcheck-${crypto.randomBytes(6).toString('hex')}`);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    const cssPath = materializeCssSync(options, dir);
    const cfg = path.join(dir, 'cfg.yaml');
    await fs.promises.writeFile(cfg, buildFb2cngConfigText(readBaseConfigText(), options, { cssPath }), 'utf8');
    const r = await runFbc(bin, ['-c', cfg, 'dumpconfig', path.join(dir, 'out.yaml')], dir);
    if (!(r.code === 0 && !/error/i.test(r.out))) return { ok: false, error: r.out.trim().slice(0, 400) };
    // dumpconfig does not parse Go templates: convert a tiny book (author, series, footnote) to catch template errors.
    const sample = path.join(dir, 'sample.fb2');
    await fs.promises.writeFile(sample, SAMPLE_FB2, 'utf8');
    const outDir = path.join(dir, 'out');
    await fs.promises.mkdir(outDir, { recursive: true });
    const c = await runFbc(bin, ['-c', cfg, 'convert', '--to', 'epub2', '--ow', '--nd', sample, outDir], dir, 30000);
    if (c.code !== 0) return { ok: false, error: lastErrorLine(c.out) };
    // fbc survives a broken template with a WARN ("unable to parse template field …") — that is still an error for us.
    const tplWarn = c.out.split(/\r?\n/).find((l) => /\b(WARN|ERROR)\b/.test(l) && /template/i.test(l));
    if (tplWarn) return { ok: false, error: (/"error": "([^"]+)/.exec(tplWarn)?.[1] || tplWarn).slice(0, 400) };
    return { ok: true };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Файл конфига с текущими сохранёнными настройками во временной папке — для проверки нового fbc перед установкой.
 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }>}
 */
export async function writeCurrentConfigForCheck(optionsOverride = null) {
  const dir = path.join(config.conversionTempDir, `cfgcur-${crypto.randomBytes(6).toString('hex')}`);
  await fs.promises.mkdir(dir, { recursive: true });
  const options = optionsOverride || parseFb2cngOptionsSetting(getSetting('fb2cng_options'));
  // для нового бинарника не отфильтровываем опции по версии установленного (since снимаем)
  const cssPath = materializeCssSync(options, dir);
  const cfg = path.join(dir, 'cfg.yaml');
  await fs.promises.writeFile(cfg, buildFb2cngConfigText(readBaseConfigText(), options, { cssPath }), 'utf8');
  return { path: cfg, cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }) };
}
