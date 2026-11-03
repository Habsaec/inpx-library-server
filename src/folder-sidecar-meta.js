/**
 * Метаданные книг папочного источника помимо самой книги:
 *   - OPF рядом с книгой (`<имя книги>.opf` или `metadata.opf` в папке одной книги) — так раскладывают
 *     экспорт Calibre («Сохранить на диск»), Readarr, LazyLibrarian, Kavita;
 *   - ComicInfo.xml внутри CBZ (комиксы / манга, формат Komga / Kavita / ComicRack) + первая страница как обложка;
 *   - Info-словарь и XMP пакет PDF (читаются только начало и конец файла).
 * Всё только для отдельных файлов (не записей внутри zip/7z) и без новых зависимостей.
 */
import fs from 'node:fs';
import path from 'node:path';
import unzipper from 'unzipper';
import iconv from 'iconv-lite';
import { parseEnvTimeoutMs, promiseWithTimeout } from './utils/async-timeout.js';
import {
  calibreAuthorToInpx,
  calibreDateOnly,
  calibreLangToIso1,
  calibreYear,
  cleanCalibreTag,
  formatCalibreSeriesIndex
} from './calibre.js';
import { detectImageMimeFromBuffer } from './services/cover.js';
import { DOCUMENT_FORMATS } from './utils/book-format.js';

const MAX_OPF_BYTES = 2 * 1024 * 1024;
const MAX_COMIC_INFO_BYTES = 1024 * 1024;
const MAX_COVER_BYTES = 15 * 1024 * 1024;
const PDF_PROBE_BYTES = 256 * 1024;

/* ---------- XML helpers ---------- */

export function decodeXmlEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, ent) => {
    const e = ent.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** Текст элемента без разметки (CDATA раскрыт, сущности декодированы, пробелы схлопнуты). */
function xmlText(value) {
  return decodeXmlEntities(
    String(value || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** Атрибуты тега → Map: ключи в нижнем регистре, и полное имя (`opf:file-as`), и локальное (`file-as`). */
function parseAttrs(tag) {
  const attrs = new Map();
  for (const m of String(tag || '').matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = m[1].toLowerCase();
    const value = decodeXmlEntities(m[3] ?? m[4] ?? '');
    attrs.set(name, value);
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : '';
    if (local && !attrs.has(local)) attrs.set(local, value);
  }
  return attrs;
}

/** Все элементы `<prefix:name …>…</prefix:name>` (префикс любой или без него): [{ attrs, inner }]. */
function findElements(xml, localName) {
  const re = new RegExp(`<((?:[\\w.-]+:)?${localName})(\\s[^>]*)?>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi');
  const out = [];
  for (const m of String(xml || '').matchAll(re)) {
    out.push({ attrs: parseAttrs(m[2] || ''), inner: m[3] });
  }
  return out;
}

/** Пустые / самозакрытые `<meta …/>` и `<meta …>текст</meta>`: [{ attrs, text }]. */
function findMetaTags(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<((?:[\w.-]+:)?meta)(\s[^>]*?)?(\/?)>(?:([\s\S]*?)<\/\1\s*>)?/gi)) {
    const selfClosed = m[3] === '/';
    out.push({ attrs: parseAttrs(m[2] || ''), text: selfClosed ? '' : xmlText(m[4] || '') });
  }
  return out;
}

/* ---------- OPF ---------- */

const OPF_EXT = '.opf';
const METADATA_OPF = 'metadata.opf';

/**
 * Какой OPF относится к книге. `fileNames` — имена файлов той же папки (из readdir), `bookFileNames` — книги
 * этой папки. `<имя книги>.opf` — всегда; `metadata.opf` — только если в папке одна книга (или одна книга в
 * нескольких форматах с одним именем, как в экспорте Calibre): иначе один OPF подписал бы целую папку автора.
 */
export function pickSidecarOpfName(fileNames, bookFileName, bookFileNames) {
  const lower = new Map();
  for (const name of fileNames) {
    if (name.toLowerCase().endsWith(OPF_EXT)) lower.set(name.toLowerCase(), name);
  }
  if (!lower.size) return null;
  const base = path.parse(bookFileName).name.toLowerCase();
  const own = lower.get(`${base}${OPF_EXT}`);
  if (own) return own;
  const shared = lower.get(METADATA_OPF);
  if (!shared) return null;
  const works = new Set(bookFileNames.map((name) => path.parse(name).name.toLowerCase()));
  return works.size === 1 ? shared : null;
}

async function isFile(file) {
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * OPF для книги по полному пути (детали книги, обложка — до записи в book_details_cache). Без OPF это
 * два stat, как у findNearFileCover: плоская папка на 30k файлов не перечитывается на каждую обложку.
 * Папка читается только когда есть metadata.opf (правило «одна книга в папке»), а такие папки малы.
 */
export async function findSidecarOpfPath(bookPath, isBookFileName) {
  const dir = path.dirname(bookPath);
  const base = path.parse(bookPath).name;
  for (const ext of ['.opf', '.OPF']) {
    if (await isFile(path.join(dir, base + ext))) return path.join(dir, base + ext);
  }
  if (!(await isFile(path.join(dir, METADATA_OPF)))) return null;
  let names;
  try {
    names = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const picked = pickSidecarOpfName(names, path.basename(bookPath), names.filter(isBookFileName));
  return picked ? path.join(dir, picked) : null;
}

/**
 * OPF (Calibre / EPUB 2 / EPUB 3) → поля книги. Авторы — по `opf:file-as` (или refines file-as) в форме
 * «Фамилия,Имя», как у источника Calibre; только роль aut (или без роли). date = calibre:timestamp (дата
 * добавления, как у Calibre), иначе dc:date. Издатель — в keywords.
 */
export function parseSidecarOpf(xml) {
  const text = String(xml || '');
  const metadataBlock = text.match(/<(?:[\w.-]+:)?metadata[\s>][\s\S]*?<\/(?:[\w.-]+:)?metadata\s*>/i)?.[0] || text;
  const metas = findMetaTags(metadataBlock);
  const refines = new Map(); // id → Map(property → value)
  const named = new Map(); // calibre:series → content
  for (const meta of metas) {
    const name = meta.attrs.get('name');
    if (name) named.set(name.toLowerCase(), meta.attrs.get('content') ?? meta.text);
    const target = meta.attrs.get('refines');
    const property = meta.attrs.get('property');
    if (target && property) {
      const id = target.replace(/^#/, '');
      if (!refines.has(id)) refines.set(id, new Map());
      refines.get(id).set(property.toLowerCase(), meta.text);
    }
  }

  const title = xmlText(findElements(metadataBlock, 'title')[0]?.inner);

  const authors = [];
  for (const creator of findElements(metadataBlock, 'creator')) {
    const id = creator.attrs.get('id');
    const ref = id ? refines.get(id) : null;
    const role = String(creator.attrs.get('role') || ref?.get('role') || '').trim().toLowerCase();
    if (role && role !== 'aut') continue;
    const name = xmlText(creator.inner);
    const author = calibreAuthorToInpx(name, creator.attrs.get('file-as') || ref?.get('file-as') || '');
    if (author && !authors.includes(author)) authors.push(author);
  }

  const genres = findElements(metadataBlock, 'subject')
    .map((el) => cleanCalibreTag(xmlText(el.inner)))
    .filter(Boolean);

  let series = String(named.get('calibre:series') || '').trim();
  let seriesNo = series ? formatCalibreSeriesIndex(named.get('calibre:series_index')) : '';
  if (!series) {
    for (const meta of metas) {
      if (String(meta.attrs.get('property') || '').toLowerCase() !== 'belongs-to-collection' || !meta.text) continue;
      const ref = refines.get(String(meta.attrs.get('id') || ''));
      const type = String(ref?.get('collection-type') || 'series').toLowerCase();
      if (type !== 'series') continue;
      series = meta.text;
      seriesNo = formatCalibreSeriesIndex(ref?.get('group-position'));
      break;
    }
  }

  const lang = calibreLangToIso1(xmlText(findElements(metadataBlock, 'language')[0]?.inner));
  const pubdate = xmlText(findElements(metadataBlock, 'date')[0]?.inner);
  const date = calibreDateOnly(named.get('calibre:timestamp')) || calibreDateOnly(pubdate);
  const publisher = xmlText(findElements(metadataBlock, 'publisher')[0]?.inner);

  let isbn = '';
  for (const el of findElements(metadataBlock, 'identifier')) {
    const scheme = String(el.attrs.get('scheme') || '').toLowerCase();
    const value = xmlText(el.inner);
    const urn = value.match(/^(?:urn:)?isbn:\s*(.+)$/i);
    if (scheme === 'isbn' || urn) {
      isbn = String(urn ? urn[1] : value).replace(/[^0-9Xx]/g, '').toUpperCase();
      if (isbn.length === 10 || isbn.length === 13) break;
      isbn = '';
    }
  }

  // dc:description у Calibre — экранированный HTML; дальше он проходит через sanitizeHtml.
  const descriptionRaw = findElements(metadataBlock, 'description')[0]?.inner || '';
  const annotation = decodeXmlEntities(descriptionRaw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();

  return {
    title,
    authors: authors.join(':'),
    genres: genres.join(':'),
    series,
    seriesNo,
    lang,
    keywords: publisher ? cleanCalibreTag(publisher) : '',
    date,
    annotation,
    annotationIsHtml: /<[a-z][\s\S]*>/i.test(annotation),
    publishYear: calibreYear(pubdate),
    isbn
  };
}

export async function readSidecarOpf(opfPath) {
  try {
    const stat = await fs.promises.stat(opfPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_OPF_BYTES) return null;
    return parseSidecarOpf(await fs.promises.readFile(opfPath, 'utf8'));
  } catch {
    return null;
  }
}

/* ---------- ComicInfo.xml (CBZ) ---------- */

/** «Alan Moore, Dave Gibbons» → «Alan Moore:Dave Gibbons» (запятая в INPX-форме значила бы «Фамилия,Имя»). */
function splitPeople(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((name) => name.replace(/[:]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function comicNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) ? String(n) : raw;
}

export function parseComicInfo(xml) {
  const text = String(xml || '');
  const get = (name) => xmlText(findElements(text, name)[0]?.inner);
  const series = get('Series');
  const number = comicNumber(get('Number')) || comicNumber(get('Volume'));
  const title = get('Title') || (series ? (number ? `${series} #${number}` : series) : '');
  const writers = splitPeople(get('Writer'));
  const people = writers.length ? writers : splitPeople(get('Penciller') || get('Artist'));
  const year = Number.parseInt(get('Year'), 10);
  const validYear = year >= 1000 && year <= new Date().getFullYear() + 1 ? year : null;
  const pad = (v) => {
    const n = Number.parseInt(v, 10);
    return n >= 1 && n <= 31 ? String(n).padStart(2, '0') : '01';
  };
  const publisher = get('Publisher');
  const tags = splitPeople(get('Tags'));
  const gtin = get('GTIN').replace(/[^0-9Xx]/g, '').toUpperCase();
  return {
    title,
    authors: [...new Set(people)].join(':'),
    genres: splitPeople(get('Genre')).map(cleanCalibreTag).filter(Boolean).join(':'),
    series,
    seriesNo: series ? number : '',
    lang: calibreLangToIso1(get('LanguageISO')),
    keywords: [publisher, ...tags].map(cleanCalibreTag).filter(Boolean).join(', '),
    date: validYear ? `${validYear}-${pad(get('Month'))}-${pad(get('Day'))}` : '',
    annotation: get('Summary'),
    annotationIsHtml: false,
    publishYear: validYear,
    isbn: gtin.length === 10 || gtin.length === 13 ? gtin : ''
  };
}

async function openZipDirectory(filePath) {
  return promiseWithTimeout(
    unzipper.Open.file(filePath),
    parseEnvTimeoutMs('ARCHIVE_ZIP_OPEN_TIMEOUT_MS', 120_000),
    `cbz open ${path.basename(filePath)}`
  );
}

const IMAGE_ENTRY_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const naturalCompare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

function isJunkZipEntry(entryPath) {
  return /(^|\/)(__MACOSX|\.)/.test(entryPath);
}

/** ComicInfo.xml из CBZ (читается только центральный каталог и одна запись). */
export async function readComicInfo(filePath) {
  try {
    const directory = await openZipDirectory(filePath);
    const entry = directory.files
      .filter((f) => f.type !== 'Directory' && path.posix.basename(f.path).toLowerCase() === 'comicinfo.xml' && !isJunkZipEntry(f.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0];
    if (!entry || Number(entry.uncompressedSize) > MAX_COMIC_INFO_BYTES) return null;
    return parseComicInfo((await entry.buffer()).toString('utf8'));
  } catch {
    return null;
  }
}

/** Первая страница CBZ (по естественной сортировке имён) — обложка, как в Komga / Kavita. */
export async function readCbzCover(filePath) {
  try {
    const directory = await openZipDirectory(filePath);
    const images = directory.files
      .filter((f) => f.type !== 'Directory' && IMAGE_ENTRY_RE.test(f.path) && !isJunkZipEntry(f.path))
      .sort((a, b) => naturalCompare(a.path, b.path));
    const entry = images.find((f) => /(^|[\/_\s-])cover\b/i.test(f.path)) || images[0];
    if (!entry || Number(entry.uncompressedSize) > MAX_COVER_BYTES) return null;
    const data = await entry.buffer();
    const contentType = detectImageMimeFromBuffer(data);
    return contentType ? { contentType, data } : null;
  } catch {
    return null;
  }
}

/* ---------- PDF ---------- */

/**
 * Строка PDF (байты литерала или hex) → текст: UTF-16BE с BOM, UTF-8 с BOM / корректный UTF-8, иначе
 * latin1 (PDFDocEncoding) — но если большинство букв в U+00C0–U+00FF, это сырые байты cp1251 из
 * русских PDF («Îñíîâàíèå» = «Основание»); в западных названиях таких букв единицы среди ASCII.
 */
export function decodePdfStringBytes(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf.subarray(2), 'utf16-be');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  let high = 0;
  let letters = 0;
  for (const b of buf) {
    if (b >= 0xc0) { high += 1; letters += 1; } else if ((b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a) letters += 1;
  }
  if (letters && high / letters > 0.5) return iconv.decode(buf, 'win1251');
  return buf.toString('latin1');
}

/** Литерал `( … )` начиная с позиции `(`: экранирование, восьмеричные коды, вложенные скобки. */
function readPdfLiteral(src, start) {
  const bytes = [];
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x5c) { // backslash
      const n = src[i + 1];
      if (n === undefined) break;
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (n in map) { bytes.push(map[n]); i += 1; continue; }
      if (/[0-7]/.test(n)) {
        const oct = src.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        bytes.push(Number.parseInt(oct, 8) & 0xff);
        i += oct.length;
        continue;
      }
      if (n === '\r' || n === '\n') { i += (n === '\r' && src[i + 2] === '\n') ? 2 : 1; continue; }
      bytes.push(n.charCodeAt(0) & 0xff);
      i += 1;
      continue;
    }
    if (c === 0x28) { depth += 1; if (depth === 1) continue; }
    if (c === 0x29) { depth -= 1; if (depth === 0) return bytes; }
    bytes.push(c & 0xff);
  }
  return null;
}

/** Значение ключа в словаре Info (`/Title (…)` или `/Title <FEFF…>`). `dict` — строка latin1. */
function pdfDictString(dict, key) {
  const m = new RegExp(`/${key}\\s*([(<])`).exec(dict);
  if (!m) return '';
  const at = m.index + m[0].length - 1;
  if (m[1] === '(') {
    const bytes = readPdfLiteral(dict, at);
    return bytes ? decodePdfStringBytes(bytes).replace(/\s+/g, ' ').trim() : '';
  }
  const end = dict.indexOf('>', at);
  if (end < 0) return '';
  const hex = dict.slice(at + 1, end).replace(/[^0-9a-f]/gi, '');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
  return decodePdfStringBytes(bytes).replace(/\s+/g, ' ').trim();
}

async function readRange(fh, position, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  const { bytesRead } = await fh.read(buf, 0, buf.length, Math.max(0, position));
  return buf.subarray(0, bytesRead);
}

/** Объект `N G obj … endobj` в одном из буферов; иначе по классической таблице xref. */
async function findPdfObject(fh, size, chunks, num, gen) {
  const re = new RegExp(`(?:^|[\\s>])${num}\\s+${gen}\\s+obj\\b([\\s\\S]*?)endobj`);
  for (const chunk of chunks) {
    const m = re.exec(chunk);
    if (m) return m[1];
  }
  const tail = chunks[chunks.length - 1];
  const startxref = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  const xrefAt = startxref ? Number(startxref[1]) : NaN;
  if (!Number.isFinite(xrefAt) || xrefAt <= 0 || xrefAt >= size) return '';
  const xref = (await readRange(fh, xrefAt, 64 * 1024)).toString('latin1');
  if (!xref.startsWith('xref')) return ''; // xref stream: Info в сжатом потоке объектов — не читаем
  const lines = xref.split(/\r\n|\r|\n/);
  for (let i = 1; i < lines.length; i++) {
    const head = lines[i].trim().match(/^(\d+)\s+(\d+)$/);
    if (!head) break;
    const first = Number(head[1]);
    const count = Number(head[2]);
    if (num >= first && num < first + count) {
      const row = lines[i + 1 + (num - first)]?.trim().match(/^(\d{10})\s+(\d{5})\s+n/);
      if (!row) return '';
      const body = (await readRange(fh, Number(row[1]), 16 * 1024)).toString('latin1');
      return re.exec(body)?.[1] || '';
    }
    i += count;
  }
  return '';
}

const JUNK_TITLE_RE = /^(untitled|unknown|no title|title|document|doc\d*|без названия|документ|документ microsoft word|presentation)\b/i;
const JUNK_TITLE_PREFIX_RE = /^(microsoft (word|powerpoint|excel)\s*-|word\s*-|untitled\s*-)/i;
const FILE_EXT_RE = /\.(docx?|pdf|odt|rtf|txt|indd|qxd|qxp|tex|dvi|ps|eps|p65|pm\d|fm|cdr|html?|xml|djvu?)$/i;
const JUNK_AUTHOR_RE = /^(admin|administrator|user|owner|unknown|author|пользователь|администратор|автор|1|test|default|customer|microsoft)$/i;

/** Мусорное название из PDF («Microsoft Word - doc1.docx», «Untitled», имя файла) → ''. */
export function cleanPdfTitle(title, fileBaseName = '') {
  const value = String(title || '').replace(/\s+/g, ' ').trim();
  if (value.length < 2 || !/\p{L}/u.test(value)) return '';
  if (JUNK_TITLE_RE.test(value) || JUNK_TITLE_PREFIX_RE.test(value) || FILE_EXT_RE.test(value)) return '';
  if (/[\\/]/.test(value) && /\.\w{2,4}$/.test(value)) return '';
  if (fileBaseName && value.toLowerCase() === String(fileBaseName).toLowerCase()) return '';
  if (/^[\w-]+_[\w-]+$/.test(value) && !/\s/.test(value)) return ''; // book_final_v2
  return value;
}

/** «A; B», «A & B», «A and B», «Asimov, Isaac» (одна запятая между двумя словами = «Фамилия,Имя»). */
export function splitPdfAuthors(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const parts = raw.split(/\s*[;&]\s*|\s+(?:and|и)\s+/i).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const commas = part.split(',').map((s) => s.trim()).filter(Boolean);
    if (commas.length === 2 && !/\s/.test(commas[0]) && !/\s/.test(commas[1])) out.push(`${commas[0]},${commas[1]}`);
    else out.push(...commas);
  }
  return out
    .map((name) => name.replace(/:/g, ' ').trim())
    .filter((name) => name.length > 1 && !JUNK_AUTHOR_RE.test(name) && /\p{L}/u.test(name));
}

function parseXmpPacket(xmp) {
  const altOrSeq = (name) => {
    const el = findElements(xmp, name)[0];
    if (!el) return [];
    const items = findElements(el.inner, 'li').map((li) => xmlText(li.inner)).filter(Boolean);
    return items.length ? items : [xmlText(el.inner)].filter(Boolean);
  };
  return {
    title: altOrSeq('title')[0] || '',
    authors: altOrSeq('creator'),
    description: altOrSeq('description')[0] || '',
    lang: altOrSeq('language')[0] || ''
  };
}

/**
 * Название / авторы / язык / описание из PDF без чтения всего файла: первые и последние 256 КБ
 * (XMP пакет и словарь Info, если он не в сжатом потоке объектов). null — файл не PDF или ничего нет.
 */
export async function readPdfMetadata(filePath) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const { size } = await fh.stat();
    if (size < 16) return null;
    const head = await readRange(fh, 0, Math.min(size, PDF_PROBE_BYTES));
    if (head.subarray(0, 1024).indexOf('%PDF-') < 0) return null;
    const tailStart = Math.max(head.length, size - PDF_PROBE_BYTES);
    const tail = tailStart < size ? await readRange(fh, tailStart, size - tailStart) : Buffer.alloc(0);
    const chunks = [head.toString('latin1'), tail.toString('latin1')];

    let xmp = { title: '', authors: [], description: '', lang: '' };
    for (const buf of [tail, head]) {
      const at = buf.lastIndexOf('<x:xmpmeta');
      if (at < 0) continue;
      const end = buf.indexOf('</x:xmpmeta>', at);
      if (end < 0) continue;
      xmp = parseXmpPacket(buf.subarray(at, end).toString('utf8'));
      break;
    }

    let info = '';
    const infoRef = [...(chunks[1] + '\n' + chunks[0]).matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)][0];
    if (infoRef) info = await findPdfObject(fh, size, chunks, Number(infoRef[1]), Number(infoRef[2]));

    const base = path.parse(filePath).name;
    const title = cleanPdfTitle(xmp.title, base) || cleanPdfTitle(pdfDictString(info, 'Title'), base);
    let authors = xmp.authors.flatMap(splitPdfAuthors);
    if (!authors.length) authors = splitPdfAuthors(pdfDictString(info, 'Author'));
    const subject = pdfDictString(info, 'Subject');
    const annotation = xmp.description || (subject.length >= 40 ? subject : '');
    const keywords = pdfDictString(info, 'Keywords');
    if (!title && !authors.length && !annotation) return null;
    return {
      title,
      authors: [...new Set(authors)].join(':'),
      genres: '',
      series: '',
      seriesNo: '',
      lang: calibreLangToIso1(String(xmp.lang).split(/[-_]/)[0]),
      keywords: keywords.length <= 300 ? keywords.replace(/[:;]/g, ',') : '',
      date: '',
      annotation,
      annotationIsHtml: false,
      publishYear: null,
      isbn: ''
    };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/* ---------- Серия = папка ---------- */

/** Номер тома из имени файла: «#12», «v01», «Vol. 3», «Том 2», «Ch 15», иначе последнее число (не год). */
export function volumeNumberFromName(baseName) {
  const name = String(baseName || '');
  const tagged = name.match(/(?:#|(?<![\p{L}\d])(?:v|vol|volume|t|tome|том|т|ch|chapter|глава|issue|book|книга|часть|part)\.?\s*)(\d+(?:[.,]\d+)?)/iu);
  const pickNumber = (raw) => {
    const n = Number(String(raw).replace(',', '.'));
    return Number.isFinite(n) ? String(n) : '';
  };
  if (tagged) return pickNumber(tagged[1]);
  const numbers = [...name.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/g)]
    .map((m) => m[1])
    .filter((n) => !(n.length === 4 && /^(1[89]|20)\d\d$/.test(n)));
  return numbers.length ? pickNumber(numbers[numbers.length - 1]) : '';
}

/**
 * Режим «серия = папка» (Komga / Kavita: `Серия/Серия 001.cbz`): серия — имя родительской папки,
 * номер — из имени файла, название — имя файла; автор из пути не берётся (первая папка — это серия).
 */
export function folderSeriesMetadata(relativePath) {
  const parsed = path.parse(String(relativePath || '').replace(/\\/g, '/'));
  const dirs = parsed.dir ? parsed.dir.split('/').filter(Boolean) : [];
  const series = dirs.length ? dirs[dirs.length - 1] : '';
  return {
    title: parsed.name,
    authors: '',
    series,
    seriesNo: series ? volumeNumberFromName(parsed.name) : ''
  };
}

/* ---------- Детали книги (страница книги, обложка) ---------- */

/** Отдельные файлы книг папочного источника (как в folder-indexer: SUPPORTED_EXTENSIONS + документы). */
const FOLDER_BOOK_EXTS = new Set(['fb2', 'epub', 'mobi', 'azw3', ...DOCUMENT_FORMATS]);
const isFolderBookFileName = (name) => FOLDER_BOOK_EXTS.has(path.extname(name).slice(1).toLowerCase());

/**
 * Аннотация / год / ISBN / обложка отдельного файла папочного источника не из самой книги:
 * OPF рядом, ComicInfo.xml и первая страница CBZ, описание PDF. null — ничего не нашлось.
 */
export async function readFolderBookSidecarDetails(bookPath, ext) {
  const kind = String(ext || '').toLowerCase();
  const layers = [];
  const opfPath = await findSidecarOpfPath(bookPath, isFolderBookFileName);
  if (opfPath) layers.push(await readSidecarOpf(opfPath));
  if (kind === 'cbz') layers.push(await readComicInfo(bookPath));
  if (kind === 'pdf') layers.push(await readPdfMetadata(bookPath));
  const cover = kind === 'cbz' ? await readCbzCover(bookPath) : null;
  const found = layers.filter(Boolean);
  if (!found.length && !cover) return null;
  const withAnnotation = found.find((layer) => String(layer.annotation || '').trim());
  return {
    annotation: withAnnotation ? String(withAnnotation.annotation).trim() : '',
    annotationIsHtml: Boolean(withAnnotation?.annotationIsHtml),
    publishYear: found.find((layer) => layer.publishYear)?.publishYear || null,
    isbn: found.find((layer) => layer.isbn)?.isbn || '',
    cover
  };
}

/* ---------- Слияние ---------- */

const MERGE_FIELDS = ['title', 'authors', 'genres', 'series', 'seriesNo', 'lang', 'keywords', 'date'];

/** Слева направо по убыванию приоритета: первое непустое значение каждого поля. Серия и номер — парой. */
export function mergeBookMetadata(...layers) {
  const out = {};
  for (const field of MERGE_FIELDS) {
    if (field === 'seriesNo') continue;
    const hit = layers.find((layer) => layer && String(layer[field] || '').trim());
    out[field] = hit ? String(hit[field]).trim() : '';
    if (field === 'series') out.seriesNo = hit ? String(hit.seriesNo || '').trim() : '';
  }
  return out;
}
