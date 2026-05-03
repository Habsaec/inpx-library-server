import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import iconv from 'iconv-lite';
import { config } from './config.js';
import { initSync as initJxlSync, JxlImage } from 'jxl-oxide-wasm';
import {
  db,
  getSources,
  getMeta,
  setMeta,
  replaceFlibustaAuthorShardsForSource,
  replaceBookReviewPointersForSource,
  updateSourceFlibustaSidecar,
  upsertFlibustaAuthorPortrait,
  getFlibustaAuthorPortrait,
  getFlibustaAuthorShardRow,
  getBookReviewRecord,
  getSourceById,
  getBookRowsForReviewPointerBuild
} from './db.js';
import { readArchiveEntryBuffer, listArchiveFiles } from './archives.js';
import { parseEnvTimeoutMs } from './utils/async-timeout.js';
import { readSevenZipEntry } from './seven-zip.js';

const ANNOTATIONS_REL = path.join('etc', 'annotations.7z');
/** Как FLibrary: `GetAdditionalFolder()` + `/reviews` (см. AuthorReviewModel.cpp); у типичной выкладки Флибусты additional = `etc`. */
const REVIEWS_DIR = path.join('etc', 'reviews');
const AUTHORS_DIR = path.join('etc', 'authors');
const AUTHOR_PICTURES_DIR = path.join('etc', 'authors', 'pictures');
const SIDECAR_COVER_CACHE_TTL_MS = parseEnvTimeoutMs('SIDECAR_COVER_CACHE_TTL_MS', 15 * 60_000);
const SIDECAR_COVER_NEGATIVE_TTL_MS = parseEnvTimeoutMs('SIDECAR_COVER_NEGATIVE_TTL_MS', 2 * 60_000);
const SIDECAR_COVER_CACHE_MAX_ENTRIES = Math.max(
  32,
  Number.parseInt(String(process.env.SIDECAR_COVER_CACHE_MAX_ENTRIES || ''), 10) || 2000
);
const SIDECAR_COVER_CACHE_MAX_BYTES = Math.max(
  8 * 1024 * 1024,
  Number.parseInt(String(process.env.SIDECAR_COVER_CACHE_MAX_BYTES || ''), 10) || 256 * 1024 * 1024
);
const sidecarCoverCache = new Map();
let sidecarCoverCacheBytes = 0;
let _coverCacheHits = 0;
let _coverCacheMisses = 0;
const require = createRequire(import.meta.url);
let jxlDecoderInitState = 0; // 0 unknown, 1 ready, -1 failed

/**
 * Имя записи в covers/*.zip|7z и префикс {id}/ в images (lib_id из INPX).
 * При мульти-источниках books.id = «sourceId:raw», в архивах ключ без префикса.
 */
export function sidecarArchiveEntryKey(book) {
  const lib = String(book?.libId || '').trim();
  if (lib) return lib;
  const id = String(book?.id || '').trim();
  const m = id.match(/^(\d+):(.+)$/);
  return m ? m[2] : id;
}

function deleteSidecarCoverCacheEntry(cacheKey) {
  const prev = sidecarCoverCache.get(cacheKey);
  if (!prev) return;
  sidecarCoverCache.delete(cacheKey);
  sidecarCoverCacheBytes = Math.max(0, sidecarCoverCacheBytes - (prev.bytes || 0));
}

function getSidecarCoverCache(cacheKey) {
  const item = sidecarCoverCache.get(cacheKey);
  if (!item) {
    _coverCacheMisses++;
    _logCoverCacheMetrics();
    return undefined;
  }
  const now = Date.now();
  const ttl = item.value ? SIDECAR_COVER_CACHE_TTL_MS : SIDECAR_COVER_NEGATIVE_TTL_MS;
  if (ttl > 0 && now - item.at > ttl) {
    deleteSidecarCoverCacheEntry(cacheKey);
    _coverCacheMisses++;
    _logCoverCacheMetrics();
    return undefined;
  }
  sidecarCoverCache.delete(cacheKey);
  sidecarCoverCache.set(cacheKey, item);
  _coverCacheHits++;
  _logCoverCacheMetrics();
  return item.value;
}

function _logCoverCacheMetrics() {
  const total = _coverCacheHits + _coverCacheMisses;
  if (total > 0 && total % 1000 === 0) {
    const ratio = total > 0 ? (_coverCacheHits / total * 100).toFixed(1) : '0.0';
    console.log(`[sidecar-cache] hits=${_coverCacheHits} misses=${_coverCacheMisses} ratio=${ratio}% entries=${sidecarCoverCache.size} bytes=${(sidecarCoverCacheBytes / (1024 * 1024)).toFixed(1)}MB`);
  }
}

function setSidecarCoverCache(cacheKey, value) {
  deleteSidecarCoverCacheEntry(cacheKey);
  const bytes = value?.data?.length || 0;
  sidecarCoverCache.set(cacheKey, {
    at: Date.now(),
    bytes,
    value
  });
  sidecarCoverCacheBytes += bytes;
  while (
    sidecarCoverCache.size > SIDECAR_COVER_CACHE_MAX_ENTRIES ||
    sidecarCoverCacheBytes > SIDECAR_COVER_CACHE_MAX_BYTES
  ) {
    const oldest = sidecarCoverCache.keys().next().value;
    if (oldest == null) break;
    deleteSidecarCoverCacheEntry(oldest);
  }
}

function clearSidecarCoverCache() {
  sidecarCoverCache.clear();
  sidecarCoverCacheBytes = 0;
  _coverCacheHits = 0;
  _coverCacheMisses = 0;
}

function isPathInsideRoot(root, absPath) {
  const r = path.resolve(root);
  const a = path.resolve(absPath);
  return a === r || a.startsWith(r + path.sep);
}

/**
 * INPX нередко содержит путь вида `f/архив.7z`, а на зеркале fb2.flibusta файл лежит в корне как `f.fb2-….7z` / `fb2-….7z`.
 * Без подстановки реального пути covers/images ищутся рядом с несуществующим каталогом `…/f/`.
 */
export function resolveLibraryArchiveFile(libraryRoot, archiveName) {
  const root = path.resolve(String(libraryRoot || '').trim());
  const raw = String(archiveName || '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('..')) return null;
  const variants = [];
  variants.push(raw);
  const base = path.posix.basename(raw);
  if (base && base !== raw) variants.push(base);
  const parts = raw.split('/').filter(Boolean);
  if (parts.length >= 2) {
    variants.push(parts.slice(1).join('/'));
    if (parts.length === 2 && /^[a-z]$/i.test(parts[0])) {
      variants.push(parts[1]);
    }
  }
  const seen = new Set();
  for (const rel of variants) {
    if (!rel || rel.includes('..')) continue;
    const key = rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const abs = path.normalize(path.join(root, ...rel.split('/')));
    if (!isPathInsideRoot(root, abs)) continue;
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Относительный путь от libraryRoot к реальному файлу архива (для sidecar). */
export function resolveLibraryArchiveRelPath(libraryRoot, archiveName) {
  const root = path.resolve(String(libraryRoot || '').trim());
  const abs = resolveLibraryArchiveFile(libraryRoot, archiveName);
  if (abs) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..')) return rel.replace(/\\/g, '/');
  }
  return String(archiveName || '').replace(/\\/g, '/').trim();
}

function hasAnyZip7zInDir(absDir) {
  if (!absDir) return false;
  try {
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return false;
    return fs.readdirSync(absDir).some((f) => /\.(zip|7z)$/i.test(f));
  } catch {
    return false;
  }
}

/** Подпапки вида `f/covers/` у зеркала lib.rus.ec (heimdallr/books: dirname(книжный.zip)/covers/). */
function hasZip7zInChildCoversOrImages(libraryRoot, subdir) {
  const root = path.resolve(String(libraryRoot || '').trim());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return false;
  try {
    for (const name of fs.readdirSync(root)) {
      const child = path.join(root, name);
      let st;
      try {
        st = fs.statSync(child);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (hasAnyZip7zInDir(path.join(child, subdir))) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** В каталоге `covers/` есть хотя бы один .zip/.7z с обложками (корень или f/covers, …). */
export function hasCoversArchives(libraryRoot) {
  const root = String(libraryRoot || '').trim();
  if (!root || !fs.existsSync(root)) return false;
  if (hasAnyZip7zInDir(path.join(root, 'covers'))) return true;
  return hasZip7zInChildCoversOrImages(libraryRoot, 'covers');
}

/** В каталоге `images/` есть хотя бы один архив (корень или f/images, …). */
export function hasImagesArchives(libraryRoot) {
  const root = String(libraryRoot || '').trim();
  if (!root || !fs.existsSync(root)) return false;
  if (hasAnyZip7zInDir(path.join(root, 'images'))) return true;
  return hasZip7zInChildCoversOrImages(libraryRoot, 'images');
}

/**
 * Классическая полная раскладка FLibrary: и covers, и images (оба с архивами).
 * Раньше из‑за требования «оба сразу» флаг sidecar оставался выключенным, если не торчала папка images —
 * тогда не работали даже обложки из covers/.
 */
export function hasCoverImageSidecar(libraryRoot) {
  return hasCoversArchives(libraryRoot) && hasImagesArchives(libraryRoot);
}

function hasAuthorPicturesArchives(libraryRoot) {
  const root = String(libraryRoot || '').trim();
  if (!root || !fs.existsSync(root)) return false;
  return hasAnyZip7zInDir(path.join(root, AUTHOR_PICTURES_DIR));
}

function hasAnnotationsArchiveFile(libraryRoot) {
  const root = String(libraryRoot || '').trim();
  if (!root || !fs.existsSync(root)) return false;
  try {
    const p = path.join(root, ANNOTATIONS_REL);
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `etc/reviews` с шардами .zip/.7z (не additional.zip — только агрегат рейтингов). */
export function hasReviewSidecar(libraryRoot) {
  const root = String(libraryRoot || '').trim();
  if (!root || !fs.existsSync(root)) return false;
  const revDir = path.join(root, REVIEWS_DIR);
  if (!fs.existsSync(revDir) || !fs.statSync(revDir).isDirectory()) return false;
  try {
    return fs.readdirSync(revDir).some(
      (f) => /\.(zip|7z)$/i.test(f) && f.toLowerCase() !== 'additional.zip'
    );
  } catch {
    return false;
  }
}

/** `etc/authors` с шардами биографий. */
export function hasAuthorSidecar(libraryRoot) {
  const root = String(libraryRoot || '').trim();
  if (!root || !fs.existsSync(root)) return false;
  const authDir = path.join(root, AUTHORS_DIR);
  if (!fs.existsSync(authDir) || !fs.statSync(authDir).isDirectory()) return false;
  try {
    return fs.readdirSync(authDir).some((f) => /\.(zip|7z)$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * Раскладка Flibusta/FLibrary: достаточно любого распознанного слоя (covers **или** images, авторы, портреты, аннотации…).
 * Результат кэшируется по пути: иначе при каждом getBookById (effectiveSourceFlibustaForBook) повторялся
 * полный обход диска — регрессия относительно 1.5.4 на больших зеркалах.
 */
const flibustaLayoutDetectCache = new Map();

/** Сброс кэша детекта (например после смены путей на диске вне админки). */
export function clearFlibustaLayoutCache() {
  flibustaLayoutDetectCache.clear();
}

export function detectFlibustaSidecarLayout(libraryRoot) {
  const root = path.resolve(String(libraryRoot || '').trim());
  if (!root) return false;
  if (flibustaLayoutDetectCache.has(root)) {
    return flibustaLayoutDetectCache.get(root);
  }
  const detected =
    hasCoversArchives(root) ||
    hasImagesArchives(root) ||
    hasReviewSidecar(root) ||
    hasAuthorSidecar(root) ||
    hasAuthorPicturesArchives(root) ||
    hasAnnotationsArchiveFile(root);
  flibustaLayoutDetectCache.set(root, detected);
  return detected;
}

/** Выкладки отличаются: в INPX `f.fb2-….7z`, файл обложек — `fb2-….zip` или наоборот. */
function sidecarArchiveStemVariants(stem) {
  const out = new Set([stem]);
  if (/^f\.fb2-/i.test(stem)) out.add(stem.replace(/^f\./i, ''));
  if (/^fb2-/i.test(stem) && !/^f\.fb2-/i.test(stem)) out.add(`f.${stem}`);
  return [...out];
}

function candidateAnnotationSevenZipInternals(archiveFileName) {
  const base = path.basename(String(archiveFileName || '').replace(/\\/g, '/'));
  if (!base || base.includes('..')) return [];
  const out = new Set([base]);
  const stem = base.replace(/\.(zip|7z)$/i, '');
  for (const s of sidecarArchiveStemVariants(stem)) {
    out.add(`${s}.zip`);
    out.add(`${s}.7z`);
  }
  return [...out];
}

function annotationXmlFolderNameCandidates(archiveName) {
  const base = path.basename(String(archiveName || '').replace(/\\/g, '/'));
  const out = new Set([base]);
  const stem = base.replace(/\.(zip|7z)$/i, '');
  out.add(stem);
  for (const s of sidecarArchiveStemVariants(stem)) {
    out.add(s);
    out.add(`${s}.zip`);
    out.add(`${s}.7z`);
  }
  return [...out];
}

/** Имена записи обложки во FLibrary-архиве: id, id.jpg, … */
function coverEntryKeyCandidates(libId) {
  const id = String(libId ?? '').trim();
  if (!id) return [];
  const out = [id];
  if (!/\.(jpe?g|png|gif|webp)$/i.test(id)) {
    for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
      out.push(`${id}${ext}`);
    }
  }
  return out;
}

/**
 * Как FLibrary (books-fnd util/ImageRestore.cpp → ParseCover): внутри covers/{stem(книжного.zip)}.zip
 * ищется файл с именем QFileInfo(fb2).completeBaseName(), т.е. то же поле file_name из INPX (без .fb2).
 * lib_id обычно совпадает, но не всегда — перебираем оба ключа.
 */
export function coverPrimaryKeysForBook(book) {
  const fromLib = String(sidecarArchiveEntryKey(book) || '').trim();
  const fromFile = String(book?.fileName || '').replace(/\\/g, '/').trim();
  const fromFileBase = fromFile ? path.posix.basename(fromFile) : '';
  const fromFileStem = fromFileBase ? fromFileBase.replace(/\.[^/.]+$/, '') : '';
  const out = [];
  const seen = new Set();
  for (const k of [fromLib, fromFile, fromFileBase, fromFileStem]) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function normalizeCoverPrimaryKeys(libIdOrKeys) {
  if (Array.isArray(libIdOrKeys)) {
    return libIdOrKeys.map((k) => String(k ?? '').trim()).filter(Boolean);
  }
  const s = String(libIdOrKeys ?? '').trim();
  return s ? [s] : [];
}

function flattenCoverEntryCandidates(primaryKeys) {
  const out = [];
  const seen = new Set();
  for (const pk of normalizeCoverPrimaryKeys(primaryKeys)) {
    for (const c of coverEntryKeyCandidates(pk)) {
      const low = c.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      out.push(c);
    }
  }
  return out;
}

/**
 * Ищет covers|images для книжного архива из INPX.
 * 1) Как FLibrary/heimdallr (`util/ImageRestore.cpp`): `{dirname(путь к книжному.zip)}/{subdir}/{stem}.zip`
 *    при архиве `f/f.fb2-….zip` → `f/covers/f.fb2-….zip`, не `covers/` в корне библиотеки.
 * 2) Зеркала со старой плоскокой раскладкой: `{libraryRoot}/{subdir}/…`.
 */
export function resolveSidecarArchivePath(libraryRoot, subdir, archiveFileName) {
  const root = path.resolve(String(libraryRoot || '').trim());
  const norm = String(archiveFileName || '').replace(/\\/g, '/');
  if (!norm || norm.includes('..')) return null;
  const base = path.posix.basename(norm);
  if (!base) return null;
  const stem = base.replace(/\.(zip|7z)$/i, '');
  if (!stem) return null;

  const candidates = [];
  const stemVariants = sidecarArchiveStemVariants(stem);
  const exts = ['.zip', '.7z'];

  const segments = norm.split('/').filter(Boolean);
  if (segments.length) {
    const absBookArchive = path.normalize(path.join(root, ...segments));
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    const underRoot = absBookArchive === root || absBookArchive.startsWith(rootWithSep);
    if (underRoot) {
      const archiveDir = path.dirname(absBookArchive);
      for (const s of stemVariants) {
        for (const ext of exts) {
          candidates.push(path.join(archiveDir, subdir, `${s}${ext}`));
        }
      }
    }
  }

  const dir = path.join(root, subdir);
  const parent = path.posix.dirname(norm);
  const nestedParts = parent && parent !== '.' ? parent.split('/').filter(Boolean) : [];
  for (const s of stemVariants) {
    for (const ext of exts) {
      const file = `${s}${ext}`;
      candidates.push(path.join(dir, file));
      if (nestedParts.length) {
        candidates.push(path.join(dir, ...nestedParts, file));
      }
    }
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Допускаем ограниченный HTML из sidecar (аннотации / био Флибусты; там часто div, span, списки). */
export function sanitizeRichAnnotationHtml(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<\/?(?:iframe|object|embed|style|link|meta|svg|math|form|input|textarea|button|select|details|dialog|template|base|noscript|plaintext|xmp)\b[\s\S]*?>/gi, '');
  s = s.replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/javascript\s*:/gi, '');
  s = s.replace(/data\s*:\s*text\/html/gi, '');
  s = s.replace(/vbscript\s*:/gi, '');
  const allowed = new Set([
    'p',
    'br',
    'b',
    'strong',
    'i',
    'em',
    'u',
    'a',
    'div',
    'span',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'blockquote',
    'hr'
  ]);
  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (full, tag, attrs) => {
    const t = String(tag).toLowerCase();
    if (!allowed.has(t)) return '';
    if (t === 'br') return '<br>';
    const closing = full.startsWith('</');
    if (closing) return `</${t}>`;
    if (t === 'a') {
      const m = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const raw = m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
      if (!/^https?:\/\//i.test(raw)) return '';
      return `<a href="${escapeAttr(raw)}" rel="noopener noreferrer">`;
    }
    return `<${t}>`;
  });
}

function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return 'application/octet-stream';
  if (buf[0] === 0xff && buf[1] === 0x0a) return 'image/jxl';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'image/webp';
  return 'application/octet-stream';
}

function ensureJxlDecoderReady() {
  if (jxlDecoderInitState === 1) return true;
  if (jxlDecoderInitState === -1) return false;
  try {
    const pkgJson = require.resolve('jxl-oxide-wasm/package.json');
    const wasmPath = path.join(path.dirname(pkgJson), 'jxl_oxide_wasm_bg.wasm');
    const wasmBytes = fs.readFileSync(wasmPath);
    initJxlSync({ module: wasmBytes });
    jxlDecoderInitState = 1;
    return true;
  } catch {
    jxlDecoderInitState = -1;
    return false;
  }
}

function decodeJxlToPngBuffer(bytes) {
  if (!bytes?.length) return null;
  if (!ensureJxlDecoderReady()) return null;
  let frame = null;
  let image = null;
  try {
    image = new JxlImage();
    image.feedBytes(bytes);
    if (!image.tryInit()) return null;
    frame = image.render();
    const png = frame?.encodeToPng?.();
    if (!png?.length) return null;
    return Buffer.from(png);
  } catch {
    return null;
  } finally {
    try { frame?.free?.(); } catch {}
    try { image?.free?.(); } catch {}
  }
}

function normalizeSidecarImageBuffer(buf) {
  if (!buf?.length) return null;
  let contentType = sniffImageMime(buf);
  let data = buf;
  if (contentType === 'image/jxl') {
    const png = decodeJxlToPngBuffer(buf);
    if (png?.length) {
      data = png;
      contentType = 'image/png';
    }
  }
  return { contentType, data };
}

function parseAnnotationFromShardXml(xml, archiveName, fileBase) {
  const folderRe = new RegExp(
    `<folder\\s+[^>]*name\\s*=\\s*["']${escapeRegExp(archiveName)}["'][^>]*>([\\s\\S]*?)</folder>`,
    'i'
  );
  const fm = xml.match(folderRe);
  if (!fm) return '';
  const inner = fm[1];
  const fileRe = new RegExp(
    `<file\\s+[^>]*name\\s*=\\s*["']${escapeRegExp(fileBase)}\\.fb2["'][^>]*>([\\s\\S]*?)</file>`,
    'i'
  );
  const m = inner.match(fileRe);
  return m ? String(m[1] || '').trim() : '';
}

/**
 * Аннотация из etc/annotations.7z (внутри — XML UTF-8 с «папками» по имени книжного архива).
 */
export async function readFlibustaAnnotationHtml(libraryRoot, archiveName, fileName) {
  const root = path.resolve(libraryRoot);
  const annPath = path.join(root, ANNOTATIONS_REL);
  if (!fs.existsSync(annPath)) return '';
  const resolved = resolveLibraryArchiveRelPath(root, archiveName);
  const keySet = new Set([
    ...candidateAnnotationSevenZipInternals(archiveName),
    ...candidateAnnotationSevenZipInternals(resolved)
  ]);
  const keys = [...keySet];
  let xml = '';
  for (const internalRaw of keys) {
    const internal = String(internalRaw || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!internal || internal.includes('..')) continue;
    try {
      const xmlBuf = await readSevenZipEntry(annPath, internal, config.sevenZipPath);
      xml = xmlBuf.toString('utf8');
      if (xml) break;
    } catch {
      /* next key */
    }
  }
  if (!xml) return '';
  const fileBase = String(fileName || '').replace(/\.fb2$/i, '');
  const folderNameSet = new Set([
    ...annotationXmlFolderNameCandidates(archiveName),
    ...annotationXmlFolderNameCandidates(resolved)
  ]);
  for (const folderName of folderNameSet) {
    const raw = parseAnnotationFromShardXml(xml, folderName, fileBase);
    if (raw) return sanitizeRichAnnotationHtml(raw);
  }
  return '';
}

/**
 * Обложка строго из covers/*.zip|.7z (как FLibrary ParseCover, без подмены иллюстрацией).
 * Третий аргумент: lib_id (строка), массив ключей или объект book (см. coverPrimaryKeysForBook — как FLibrary ImageRestore).
 */
export async function readFlibustaCover(libraryRoot, archiveName, libIdOrKeys) {
  const root = path.resolve(libraryRoot);
  const norm = resolveLibraryArchiveRelPath(root, archiveName);
  if (!norm.trim() || norm.includes('..')) return null;
  const base = path.basename(norm);
  if (!base) return null;
  const primaryKeys =
    libIdOrKeys && typeof libIdOrKeys === 'object' && !Array.isArray(libIdOrKeys) && libIdOrKeys.archiveName
      ? coverPrimaryKeysForBook(libIdOrKeys)
      : normalizeCoverPrimaryKeys(libIdOrKeys);
  const entriesTry = flattenCoverEntryCandidates(primaryKeys);
  const cacheKey = `${root}\n${norm}\n${primaryKeys.join('|')}`;
  const cached = getSidecarCoverCache(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const acceptBuffer = async (buf) => {
    let data = buf;
    let contentType = sniffImageMime(buf);
    if (contentType === 'image/jxl') {
      const png = decodeJxlToPngBuffer(buf);
      if (!png?.length) return null;
      data = png;
      contentType = 'image/png';
    }
    if (!data?.length || contentType === 'application/octet-stream') return null;
    const out = { contentType, data };
    setSidecarCoverCache(cacheKey, out);
    return out;
  };

  const coverArchivePath = resolveSidecarArchivePath(root, 'covers', norm);
  if (coverArchivePath && entriesTry.length) {
    for (const entryName of entriesTry) {
      try {
        const buf = await readArchiveEntryBuffer(coverArchivePath, entryName);
        const out = await acceptBuffer(buf);
        if (out) return out;
      } catch {
        /* try next */
      }
    }
  }
  setSidecarCoverCache(cacheKey, null);
  return null;
}

function normalizeZipPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/**
 * Список иллюстраций: пути внутри images/{archive}.zip|.7z вида {libId}/0, {libId}/1, …
 */
export async function listFlibustaIllustrations(libraryRoot, archiveName, libId) {
  const root = path.resolve(libraryRoot);
  const norm = resolveLibraryArchiveRelPath(root, archiveName);
  if (!norm.trim() || norm.includes('..')) return [];
  const archivePath = resolveSidecarArchivePath(root, 'images', norm);
  if (!archivePath) return [];
  const id = String(libId || '').trim();
  if (!id) return [];
  const prefixA = `${id}/`;
  let files = [];
  try {
    files = await listArchiveFiles(archivePath);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const norm = normalizeZipPath(f.path);
    if (norm.startsWith(prefixA)) {
      const rest = norm.slice(prefixA.length);
      if (!rest || rest.includes('/')) continue;
      const dotIdx = rest.lastIndexOf('.');
      const stem = dotIdx > 0 ? rest.slice(0, dotIdx) : rest;
      if (!/^\d+$/.test(stem)) continue;
      const idx = Number(stem);
      if (Number.isFinite(idx)) {
        out.push({ index: idx, pathInZip: norm });
      }
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

/**
 * Первый непустой список иллюстраций по ключам из {@link coverPrimaryKeysForBook} (как FLibrary: префикс папки = fb2 base / lib id).
 */
export async function listFlibustaIllustrationsForBook(libraryRoot, book) {
  const keys = coverPrimaryKeysForBook(book);
  for (const k of keys) {
    const list = await listFlibustaIllustrations(libraryRoot, book.archiveName, k);
    if (list.length) return list;
  }
  return [];
}

/**
 * Чтение иллюстрации с перебором ключей (индекс относится к первой подошедшей папке в архиве).
 */
export async function readFlibustaIllustrationForBook(libraryRoot, book, index) {
  const idx = Number(index);
  if (!Number.isFinite(idx)) return null;
  for (const k of coverPrimaryKeysForBook(book)) {
    const img = await readFlibustaIllustration(libraryRoot, book.archiveName, k, idx);
    if (img?.data?.length) return img;
  }
  return null;
}

export async function readFlibustaIllustration(libraryRoot, archiveName, libId, index) {
  const list = await listFlibustaIllustrations(libraryRoot, archiveName, libId);
  const item = list.find((x) => x.index === Number(index));
  if (!item) return null;
  const root = path.resolve(libraryRoot);
  const norm = resolveLibraryArchiveRelPath(root, archiveName);
  if (!norm.trim() || norm.includes('..')) return null;
  const archivePath = resolveSidecarArchivePath(root, 'images', norm);
  if (!archivePath) return null;
  try {
    const buf = await readArchiveEntryBuffer(archivePath, item.pathInZip);
    return normalizeSidecarImageBuffer(buf);
  } catch {
    return null;
  }
}

function escapeXmlIdAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function collectFictionImageRefIds(xml) {
  const ids = [];
  const re = /<image\b[^>]*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const hm =
      tag.match(/\bl:href\s*=\s*(["'])([^"']*)\1/i) ||
      tag.match(/\bxlink:href\s*=\s*(["'])([^"']*)\1/i) ||
      tag.match(/\bhref\s*=\s*(["'])([^"']*)\1/i);
    if (!hm) continue;
    const ref = String(hm[2] || '').trim();
    if (!ref.startsWith('#')) continue;
    const id = ref.slice(1).trim();
    if (id) ids.push(id);
  }
  return ids;
}

function orderedUniqueStrings(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function binaryPayloadSufficient(xml, binaryId) {
  const re = new RegExp(
    `<binary\\b[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(binaryId)}\\1[^>]*>([\\s\\S]*?)<\\/binary>`,
    'i'
  );
  const m = xml.match(re);
  if (!m) return false;
  const inner = m[2].replace(/\s/g, '');
  if (inner.length < 48) return false;
  try {
    const buf = Buffer.from(inner, 'base64');
    return buf.length >= 16;
  } catch {
    return false;
  }
}

function injectOrReplaceBinaryBlock(xml, binaryId, contentType, dataBuffer) {
  const b64 = dataBuffer.toString('base64');
  const ct = String(contentType || 'image/jpeg').trim() || 'image/jpeg';
  const safeId = escapeXmlIdAttr(binaryId);
  const safeCt = escapeXmlIdAttr(ct);
  const re = new RegExp(
    `(<binary\\b[^>]*\\bid\\s*=\\s*(["'])${escapeRegExp(binaryId)}\\2[^>]*>)([\\s\\S]*?)(<\\/binary>)`,
    'i'
  );
  if (re.test(xml)) {
    return xml.replace(re, `$1${b64}$4`);
  }
  const insert = `<binary id="${safeId}" content-type="${safeCt}">${b64}</binary>\n`;
  return xml.replace(/<\/FictionBook\s*>/i, (close) => insert + close);
}

function ensureXmlUtf8EncodingDeclaration(xml) {
  if (!/<\?xml/i.test(xml)) {
    return `<?xml version="1.0" encoding="utf-8"?>\n${xml}`;
  }
  return xml.replace(/<\?xml\b[^?]*\?>/i, (decl) => {
    if (/encoding\s*=/i.test(decl)) {
      return decl.replace(/encoding\s*=\s*["'][^"']*["']/i, 'encoding="utf-8"');
    }
    return decl.replace(/\?>/, ' encoding="utf-8"?>');
  });
}

/**
 * Встраивает обложку из covers/*.zip и иллюстрации из images/*.zip в FB2 (как при сборке в FLibrary).
 * Порядок: сначала обложка по &lt;coverpage&gt;, затем по порядку уникальных l:href у &lt;image&gt; — файлы .../0, .../1 из sidecar.
 */
export async function mergeSidecarBinariesIntoFb2Xml(xml, book, libraryRoot) {
  let out = String(xml || '');
  if (!out.trim()) return out;
  const root = String(libraryRoot || '').trim();
  if (!root || !book.archiveName) return out;

  const primaryKeys = coverPrimaryKeysForBook(book);
  if (!primaryKeys.length) return out;

  const coverPage = out.match(/<coverpage[^>]*>([\s\S]*?)<\/coverpage>/i);
  if (coverPage) {
    const im = coverPage[1].match(
      /<image\b[^>]*\b(?:l:href|xlink:href|href)\s*=\s*(['"])([^'"]+)\1/i
    );
    if (im) {
      const cid = String(im[2] || '').trim().replace(/^#/, '');
      if (cid && !binaryPayloadSufficient(out, cid)) {
        const cov = await readFlibustaCover(root, book.archiveName, book);
        if (cov?.data?.length) {
          out = injectOrReplaceBinaryBlock(out, cid, cov.contentType, cov.data);
        }
      }
    }
  }

  const refIds = orderedUniqueStrings(collectFictionImageRefIds(out));
  let illList = [];
  for (const k of primaryKeys) {
    illList = await listFlibustaIllustrations(root, book.archiveName, k);
    if (illList.length) break;
  }
  const archRel = resolveLibraryArchiveRelPath(path.resolve(root), book.archiveName);
  const imagesArchivePath = resolveSidecarArchivePath(path.resolve(root), 'images', archRel);
  let illPos = 0;
  for (const bid of refIds) {
    if (binaryPayloadSufficient(out, bid)) continue;
    while (illPos < illList.length && imagesArchivePath) {
      const item = illList[illPos++];
      try {
        const buf = await readArchiveEntryBuffer(imagesArchivePath, item.pathInZip);
        const normalized = normalizeSidecarImageBuffer(buf);
        if (!normalized?.data?.length) continue;
        out = injectOrReplaceBinaryBlock(out, bid, normalized.contentType, normalized.data);
        break;
      } catch {
        continue;
      }
    }
  }

  return ensureXmlUtf8EncodingDeclaration(out);
}

export function md5Hex(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function isMd5Key32(s) {
  return /^[a-f0-9]{32}$/i.test(String(s || '').trim());
}

/** Варианты ключа автора как у зеркал lib.rus.ec (MD5 UTF-8 / lower / windows-1251). */
export function flibustaAuthorKeyCandidates(authorName) {
  const raw = String(authorName || '').trim();
  if (!raw) return [];
  const out = [];
  const push = (h) => {
    if (h && !out.includes(h)) out.push(h);
  };
  /**
   * Точное совпадение с FLibrary `AuthorAnnotationController::Find`:
   * `split(' ', SkipEmptyParts).join(' ').toLower().simplified()` → MD5 UTF-8.
   * Важно: разделитель только ASCII U+0020 (не \t и не общий \s).
   */
  const qtNormalized = raw
    .split(' ')
    .filter((p) => p.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  push(md5Hex(qtNormalized));
  /** heimdallr/books — более мягкий вариант (любые пробельные символы) */
  const flibraryKey = raw
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  push(md5Hex(flibraryKey));
  const commaParts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (commaParts.length) {
    const commaSpaced = commaParts.join(' ');
    push(md5Hex(commaSpaced));
    push(md5Hex(commaSpaced.toLowerCase()));
    if (commaParts.length >= 2) {
      const reversedComma = [...commaParts.slice(1), commaParts[0]].join(' ');
      push(md5Hex(reversedComma));
      push(md5Hex(reversedComma.toLowerCase()));
    }
    try {
      push(crypto.createHash('md5').update(iconv.encode(commaSpaced, 'windows-1251')).digest('hex'));
    } catch {
      /* ignore */
    }
  }
  push(md5Hex(raw));
  push(md5Hex(raw.toLowerCase()));
  const collapsed = raw.replace(/\s+/g, ' ');
  if (collapsed !== raw) push(md5Hex(collapsed));
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    push(md5Hex([...words].reverse().join(' ')));
  }
  try {
    push(crypto.createHash('md5').update(iconv.encode(raw, 'windows-1251')).digest('hex'));
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Портрет по имени автора: MD5-кандидаты + только запись из индекса sidecar (без обхода архивов).
 */
export async function readFlibustaAuthorPortraitForAuthorName(authorName, libraryRoot) {
  for (const key of flibustaAuthorKeyCandidates(authorName)) {
    const pic = await readFlibustaAuthorPortraitBuffer(String(key).toLowerCase(), libraryRoot);
    if (pic?.data?.length) return pic;
  }
  return null;
}

export function syncAllSourcesFlibustaFlag() {
  flibustaLayoutDetectCache.clear();
  for (const s of getSources()) {
    if (!s.path) continue;
    if (s.type === 'inpx') {
      const root = path.dirname(path.resolve(String(s.path)));
      updateSourceFlibustaSidecar(s.id, detectFlibustaSidecarLayout(root));
    } else if (s.type === 'folder') {
      const root = path.resolve(String(s.path));
      updateSourceFlibustaSidecar(s.id, detectFlibustaSidecarLayout(root));
    }
  }
}

/** Корень библиотеки с sidecar для книги (INPX или folder при flibusta_sidecar). */
export function getSidecarRootForBook(book) {
  if (!book?.sourceId) return null;
  const src = getSourceById(book.sourceId);
  if (!src?.path || !Number(src.flibustaSidecar)) return null;
  if (src.type === 'inpx') return path.dirname(path.resolve(String(src.path)));
  if (src.type === 'folder') return path.resolve(String(src.path));
  return null;
}

export async function readFlibustaAuthorPortraitBuffer(authorKey, libraryRoot) {
  const root = String(libraryRoot || '').trim();
  if (!root) return null;
  const key = String(authorKey || '').toLowerCase().trim();
  if (!isMd5Key32(key)) return null;

  const row = getFlibustaAuthorPortrait(key);
  if (!row?.zip_name || !row?.entry_path) return null;
  const zipPath = path.join(root, AUTHOR_PICTURES_DIR, row.zip_name);
  if (!fs.existsSync(zipPath)) return null;
  try {
    const buf = await readArchiveEntryBuffer(zipPath, row.entry_path.replace(/\\/g, '/'));
    if (buf?.length) return normalizeSidecarImageBuffer(buf);
  } catch {
    /* нет в архиве или битый zip — после индексации путь должен совпадать */
  }
  return null;
}

function parseReviewEntryName(name) {
  const n = String(name || '').replace(/\\/g, '/');
  const hash = n.indexOf('#');
  if (hash < 0) return null;
  const archivePart = n.slice(0, hash).trim();
  const filePart = n.slice(hash + 1).trim();
  if (!archivePart || !filePart || !filePart.toLowerCase().endsWith('.fb2')) return null;
  const fileName = filePart.replace(/\.fb2$/i, '');
  return { archiveName: archivePart, fileName };
}

function createSidecarYield() {
  let n = 0;
  return async () => {
    n += 1;
    if (n % 24 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

function runSidecarReport(onProgress, msg) {
  if (typeof onProgress === 'function') {
    try {
      onProgress(msg);
    } catch {
      /* ignore */
    }
  }
  if (msg) console.log(`[sidecar] ${msg}`);
}

/**
 * Прединдекс указателей на отзывы: только листинг шардов etc/reviews, без чтения JSON.
 */
export async function buildBookReviewPointersForSource(libraryRoot, sourceId, onProgress) {
  const root = path.resolve(String(libraryRoot || '').trim());
  const revDir = path.join(root, REVIEWS_DIR);
  if (!fs.existsSync(revDir)) {
    await replaceBookReviewPointersForSource(sourceId, []);
    runSidecarReport(onProgress, 'Sidecar: etc/reviews отсутствует — указатели отзывов очищены');
    return;
  }
  const shards = fs
    .readdirSync(revDir)
    .filter((f) => /\.(zip|7z)$/i.test(f) && f.toLowerCase() !== 'additional.zip');
  shards.sort();
  const map = new Map();
  for (let si = 0; si < shards.length; si++) {
    const shard = shards[si];
    if (si % 2 === 1) {
      await new Promise((r) => setImmediate(r));
    }
    runSidecarReport(onProgress, `Sidecar: отзывы — листинг шарда ${si + 1}/${shards.length}: ${shard}`);
    const ap = path.join(revDir, shard);
    let entries = [];
    try {
      entries = await listArchiveFiles(ap);
    } catch {
      continue;
    }
    let tick = 0;
    for (const e of entries) {
      tick += 1;
      if (tick % 400 === 0) {
        await new Promise((r) => setImmediate(r));
      }
      const parsed = parseReviewEntryName(e.path);
      if (!parsed) continue;
      const k = `${normSidecarArchiveKey(parsed.archiveName)}#${normSidecarArchiveKey(parsed.fileName)}`;
      if (map.has(k)) continue;
      map.set(k, {
        reviewShard: shard,
        entryKey: String(e.path || '').replace(/\\/g, '/')
      });
    }
  }
  const books = getBookRowsForReviewPointerBuild(sourceId);
  const out = [];
  const MATCH_YIELD_EVERY = 12_000;
  for (let bi = 0; bi < books.length; bi++) {
    const b = books[bi];
    if (bi > 0 && bi % MATCH_YIELD_EVERY === 0) {
      runSidecarReport(
        onProgress,
        `Sidecar: отзывы — сопоставление с каталогом ${bi}/${books.length}…`
      );
      await new Promise((r) => setImmediate(r));
    }
    const k = `${normSidecarArchiveKey(b.archiveName)}#${normReviewFileStem(b.fileName)}`;
    const hit = map.get(k);
    if (hit) {
      out.push({ bookId: b.id, reviewShard: hit.reviewShard, entryKey: hit.entryKey });
    }
  }
  await replaceBookReviewPointersForSource(sourceId, out);
  runSidecarReport(
    onProgress,
    `Sidecar: указатели отзывов — ${out.length} книг (кандидатов с архивом/файлом: ${books.length})`
  );
}

/**
 * После индексации INPX/folder: пометить источник, при полной переиндексации — указатели отзывов и справочник авторов.
 * onProgress — строка для UI (indexState.currentArchive) и логов.
 */
export async function refreshFlibustaSidecarForSource(
  sourceId,
  libraryRoot,
  { rebuildAuxiliary = true, onProgress = null } = {}
) {
  clearSidecarCoverCache();
  const root = path.resolve(libraryRoot);
  const has = detectFlibustaSidecarLayout(root);
  updateSourceFlibustaSidecar(sourceId, has);

  if (!has) {
    runSidecarReport(
      onProgress,
      'Sidecar: нет доп. контента (covers и/или images, etc/reviews, etc/authors, etc/authors/pictures, etc/annotations.7z) — не подключается'
    );
    try {
      setMeta(`flibusta_sidecar_fp_${sourceId}`, '');
    } catch {
      /* optional */
    }
    return;
  }
  const fingerprint = buildSidecarFingerprint(root);
  const fpMetaKey = `flibusta_sidecar_fp_${sourceId}`;
  if (rebuildAuxiliary) {
    let prevFingerprint = '';
    try {
      prevFingerprint = String(getMeta(fpMetaKey) || '');
    } catch {
      prevFingerprint = '';
    }
    if (prevFingerprint && fingerprint && prevFingerprint === fingerprint) {
      runSidecarReport(onProgress, 'Sidecar: структура не изменилась — пересборка указателей пропущена');
      return;
    }
  }
  if (!rebuildAuxiliary) {
    runSidecarReport(
      onProgress,
      'Sidecar: инкремент — полная пересборка указателей отзывов отложена (нужна полная переиндексация)'
    );
    const authorCnt =
      db.prepare('SELECT COUNT(*) AS c FROM flibusta_author_shard WHERE source_id = ?').get(sourceId)?.c ?? 0;
    if (hasAuthorSidecar(root) && authorCnt === 0) {
      runSidecarReport(
        onProgress,
        'Sidecar: справочник биографий пуст — обход etc/authors (инкремент после добавления папки)'
      );
      await buildAuthorSidecarIndex(root, sourceId, onProgress);
    }
    return;
  }

  if (hasReviewSidecar(root)) {
    await buildBookReviewPointersForSource(root, sourceId, onProgress);
  } else {
    await replaceBookReviewPointersForSource(sourceId, []);
    runSidecarReport(onProgress, 'Sidecar: etc/reviews без шардов — указатели отзывов очищены');
  }

  if (hasAuthorSidecar(root)) {
    await buildAuthorSidecarIndex(root, sourceId, onProgress);
    runSidecarReport(onProgress, 'Sidecar: справочник авторов/портретов обновлён');
  } else {
    await replaceFlibustaAuthorShardsForSource(sourceId, []);
    runSidecarReport(onProgress, 'Sidecar: etc/authors отсутствует — указатели биографий очищены');
  }
  try {
    setMeta(fpMetaKey, fingerprint);
  } catch {
    /* optional */
  }
}

function buildSidecarFingerprint(rootPath) {
  const root = path.resolve(String(rootPath || '').trim());
  if (!root || !fs.existsSync(root)) return '';
  const pack = [];
  const fileSig = (abs, relName) => {
    try {
      if (!fs.existsSync(abs)) return;
      const st = fs.statSync(abs);
      if (!st.isFile()) return;
      pack.push(`${relName}:${st.size}:${Math.trunc(st.mtimeMs)}`);
    } catch {
      /* ignore */
    }
  };
  const listArchiveSigs = (absDir, relPrefix) => {
    try {
      if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return;
      const rows = fs
        .readdirSync(absDir)
        .filter((f) => /\.(zip|7z)$/i.test(f))
        .sort((a, b) => a.localeCompare(b));
      for (const name of rows) {
        fileSig(path.join(absDir, name), `${relPrefix}/${name}`);
      }
    } catch {
      /* ignore */
    }
  };
  listArchiveSigs(path.join(root, REVIEWS_DIR), REVIEWS_DIR.replace(/\\/g, '/'));
  listArchiveSigs(path.join(root, AUTHORS_DIR), AUTHORS_DIR.replace(/\\/g, '/'));
  listArchiveSigs(path.join(root, AUTHOR_PICTURES_DIR), AUTHOR_PICTURES_DIR.replace(/\\/g, '/'));
  fileSig(path.join(root, ANNOTATIONS_REL), ANNOTATIONS_REL.replace(/\\/g, '/'));
  if (!pack.length) return '';
  return crypto.createHash('sha1').update(pack.join('|')).digest('hex');
}

function escapeHtmlPlain(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Раскладка FLibrary: JSON-массив объектов с полями time / name / text (и варианты). */
function flibraryReviewsJsonToHtml(doc) {
  const arr = Array.isArray(doc) ? doc : [];
  if (!arr.length) return '';
  const blocks = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name ?? item.reviewer ?? item.Reviewer ?? '').trim();
    const text = String(item.text ?? item.body ?? item.Text ?? '').trim();
    const time = String(item.time ?? item.date ?? item.Time ?? '').trim();
    const bodyHtml = text ? sanitizeRichAnnotationHtml(text) : '';
    blocks.push(
      `<div class="flib-review-item"><p class="flib-review-meta"><strong>${escapeHtmlPlain(name)}</strong>${time ? ` <span class="muted">${escapeHtmlPlain(time)}</span>` : ''}</p>${bodyHtml ? `<div class="flib-review-text">${bodyHtml}</div>` : ''}</div>`
    );
  }
  return blocks.length ? `<div class="flib-reviews">${blocks.join('')}</div>` : '';
}

function reviewArchiveRawToHtml(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const doc = JSON.parse(t);
      const html = flibraryReviewsJsonToHtml(Array.isArray(doc) ? doc : []);
      if (html) return html;
    } catch {
      /* не JSON */
    }
  }
  return sanitizeRichAnnotationHtml(t);
}

function normSidecarArchiveKey(s) {
  return String(s || '')
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase();
}

/** Stem файла как в записи `архив#имя.fb2` внутри шарда отзывов. */
function normReviewFileStem(s) {
  return normSidecarArchiveKey(String(s || '').replace(/\.fb2$/i, ''));
}

async function readReviewFromShard(root, reviewShard, entryKey) {
  const ap = path.join(root, REVIEWS_DIR, String(reviewShard));
  if (!fs.existsSync(ap)) return '';
  try {
    const buf = await readArchiveEntryBuffer(ap, String(entryKey).replace(/\\/g, '/'));
    return reviewArchiveRawToHtml(buf.toString('utf8'));
  } catch {
    return '';
  }
}

/**
 * Отзыв: legacy body в БД и/или указатель (shard + entry), заполняемые при индексации sidecar.
 */
export async function readFlibustaBookReviewHtml(book, libraryRoot) {
  const rec = getBookReviewRecord(book?.id);
  if (rec?.body && String(rec.body).trim()) {
    return reviewArchiveRawToHtml(String(rec.body));
  }
  const root = path.resolve(String(libraryRoot || '').trim());
  if (rec?.review_shard && rec?.entry_key) {
    const html = await readReviewFromShard(root, rec.review_shard, rec.entry_key);
    if (html) return html;
  }
  return '';
}

/**
 * Биография автора из etc/authors/{shard}.7z по индексу (список имён при полной индексации).
 */
function getFlibustaAuthorShardRowPreferGlobal(authorKeyLower, sourceId) {
  if (sourceId != null && sourceId !== '') {
    const scoped = getFlibustaAuthorShardRow(authorKeyLower, sourceId);
    if (scoped?.shard_name && scoped.entry_path) return scoped;
  }
  return db
    .prepare(
      `SELECT shard_name, entry_path FROM flibusta_author_shard WHERE LOWER(author_key) = LOWER(?) LIMIT 1`
    )
    .get(authorKeyLower);
}

export async function readFlibustaAuthorBioHtml(authorName, libraryRoot, sourceId) {
  const root = path.resolve(String(libraryRoot || '').trim());
  if (!root) return '';
  for (const key of flibustaAuthorKeyCandidates(authorName)) {
    const k = key.toLowerCase();
    const row = getFlibustaAuthorShardRowPreferGlobal(k, sourceId);
    if (!row?.shard_name || !row.entry_path) continue;
    const ap = path.join(root, AUTHORS_DIR, row.shard_name);
    if (!fs.existsSync(ap)) continue;
    try {
      const buf = await readArchiveEntryBuffer(ap, String(row.entry_path).replace(/\\/g, '/'));
      let raw = buf.toString('utf8').trim();
      if (!raw.length && buf.length) {
        try {
          raw = iconv.decode(buf, 'windows-1251').trim();
        } catch {
          /* skip */
        }
      }
      const body = sanitizeRichAnnotationHtml(raw);
      if (body) return body;
    } catch {
      /* skip */
    }
  }
  return '';
}

function authorShardBioPathScore(p) {
  const pl = String(p || '').toLowerCase();
  if (/\.(html?|xhtml)$/.test(pl)) return 0;
  if (/\.(htm|xml|txt|fb2)$/i.test(pl)) return 1;
  return 2;
}

function pickAuthorShardEntryPath(paths) {
  if (!paths?.length) return null;
  return [...paths].sort((a, b) => {
    const d = authorShardBioPathScore(a) - authorShardBioPathScore(b);
    if (d !== 0) return d;
    return String(a).localeCompare(String(b));
  })[0];
}

async function buildAuthorSidecarIndex(libraryRoot, sourceId, onProgress) {
  const yieldTick = createSidecarYield();
  const authDir = path.join(libraryRoot, AUTHORS_DIR);
  if (!fs.existsSync(authDir)) {
    await replaceFlibustaAuthorShardsForSource(sourceId, []);
    runSidecarReport(onProgress, 'Sidecar: папка etc/authors отсутствует');
    return;
  }
  const byAuthor = new Map();
  const shards = fs.readdirSync(authDir).filter((x) => /\.(zip|7z)$/i.test(x));
  for (let si = 0; si < shards.length; si++) {
    const sh = shards[si];
    runSidecarReport(onProgress, `Sidecar: авторы — список ${si + 1}/${shards.length}: ${sh}`);
    await new Promise((resolve) => setImmediate(resolve));
    const ap = path.join(authDir, sh);
    let entries = [];
    try {
      entries = await listArchiveFiles(ap);
    } catch {
      continue;
    }
    let ei = 0;
    const pathsByKey = new Map();
    for (const e of entries) {
      await yieldTick();
      const norm = normalizeZipPath(e.path);
      const parts = norm.split('/').filter(Boolean);
      let authorKey = null;
      if (parts.length >= 2 && isMd5Key32(parts[0])) {
        authorKey = parts[0].toLowerCase();
      } else {
        const base = path.basename(norm);
        const stem = base.replace(/\.[^/.]+$/, '');
        if (isMd5Key32(stem)) authorKey = stem.toLowerCase();
      }
      if (!authorKey) continue;
      if (!pathsByKey.has(authorKey)) pathsByKey.set(authorKey, []);
      pathsByKey.get(authorKey).push(norm);
    }
    for (const [authorKey, paths] of pathsByKey) {
      if (byAuthor.has(authorKey)) continue;
      const entryPath = pickAuthorShardEntryPath(paths);
      if (!entryPath) continue;
      byAuthor.set(authorKey, { authorKey, shardName: sh, entryPath });
      ei += 1;
      if (ei % 800 === 0) {
        runSidecarReport(onProgress, `Sidecar: авторы ${sh}… ~${ei} ключей`);
      }
    }
  }
  runSidecarReport(
    onProgress,
    `Sidecar: запись указателей авторов в БД (~${byAuthor.size} строк, батчами)…`
  );
  await replaceFlibustaAuthorShardsForSource(sourceId, [...byAuthor.values()]);

  const picDir = path.join(libraryRoot, AUTHOR_PICTURES_DIR);
  if (!fs.existsSync(picDir)) {
    runSidecarReport(onProgress, 'Sidecar: портреты — папка etc/authors/pictures отсутствует');
    return;
  }
  const zips = fs.readdirSync(picDir).filter((x) => /\.(zip|7z)$/i.test(x));
  if (!zips.length) {
    runSidecarReport(onProgress, 'Sidecar: в etc/authors/pictures нет архивов — портреты не индексируются');
    return;
  }
  for (let pi = 0; pi < zips.length; pi++) {
    const z = zips[pi];
    runSidecarReport(
      onProgress,
      `Sidecar: портреты авторов ${pi + 1}/${zips.length} — ${z} (обход zip/7z)`
    );
    await new Promise((resolve) => setImmediate(resolve));
    const zp = path.join(picDir, z);
    let files = [];
    try {
      files = await listArchiveFiles(zp);
    } catch {
      continue;
    }
    let fi = 0;
    for (const file of files) {
      await yieldTick();
      const norm = normalizeZipPath(file.path);
      const slash = norm.indexOf('/');
      let key = null;
      if (slash >= 0) {
        key = norm.slice(0, slash).toLowerCase();
      } else {
        const stem = path.basename(norm).replace(/\.[^/.]+$/, '').toLowerCase();
        if (isMd5Key32(stem)) key = stem;
      }
      if (!key || !isMd5Key32(key)) continue;
      upsertFlibustaAuthorPortrait(key, z, norm);
      fi += 1;
      if (fi % 2000 === 0) {
        runSidecarReport(onProgress, `Sidecar: портреты ${z}… ~${fi} путей`);
      }
    }
  }
}

/**
 * Портрет и наличие био в sidecar (текст био — readFlibustaAuthorBioHtml при открытии).
 * @param {number|null} sourceId — источник INPX; без него ищется первая запись shard по ключу автора.
 */
export function resolveFlibustaAuthorExtras(authorName, sourceId = null) {
  for (const key of flibustaAuthorKeyCandidates(authorName)) {
    const k = key.toLowerCase();
    const pic = getFlibustaAuthorPortrait(k);
    const shardRow = getFlibustaAuthorShardRowPreferGlobal(k, sourceId);
    if (pic || shardRow) return { authorKey: k, bioHtml: '', portrait: pic };
  }
  return { authorKey: '', bioHtml: '', portrait: null };
}
