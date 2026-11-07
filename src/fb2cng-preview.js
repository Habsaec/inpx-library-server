/**
 * Предпросмотр настроек конвертации (Админка → Контент → «Конвертация»).
 *
 * Берёт книгу из каталога (по id / ссылке) или встроенный пример, конвертирует в EPUB с настройками из формы —
 * в том числе ещё не сохранёнными — и кладёт распакованный EPUB в память на 15 минут. Страницы отдаются
 * `GET /admin/conversion/preview/:token/<путь внутри EPUB>` с настоящими MIME-типами, поэтому CSS,
 * картинки и шрифты находятся по своим относительным ссылкам; iframe — `sandbox="allow-same-origin"` плюс CSP
 * `sandbox` на самих ответах (скрипты из книги не выполняются). Ничего не сохраняется в настройки и в кэш.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import unzipper from 'unzipper';
import { getBookById } from './inpx.js';
import { convertForPreview } from './conversion.js';
import { getFb2cngConvertibleFormats } from './download-formats.js';
import {
  fb2cngOptionsFromForm, getFb2cngTemplateDefaults, writeCurrentConfigForCheck, normalizeFb2cngOptions
} from './fb2cng-options.js';
import { getSharp } from './services/sharp-loader.js';

const TTL_MS = 15 * 60 * 1000;
const MAX_PREVIEWS = 4;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_PAGES = 300;

const store = new Map(); // token -> { at, files: Map<string, Buffer> }

function sweep() {
  const now = Date.now();
  for (const [token, entry] of store) if (now - entry.at > TTL_MS) store.delete(token);
  while (store.size >= MAX_PREVIEWS) store.delete(store.keys().next().value);
}

const MIME = {
  xhtml: 'application/xhtml+xml; charset=utf-8', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  kfx: 'application/octet-stream', azw8: 'application/octet-stream', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2'
};

/** Файл из распакованного предпросмотра или null. */
export function getPreviewFile(token, name) {
  if (!/^[a-f0-9]{32}$/.test(String(token))) return null;
  const entry = store.get(token);
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  const buffer = entry.files.get(String(name).replace(/\\/g, '/'));
  if (!buffer) return null;
  const ext = path.posix.extname(String(name)).slice(1).toLowerCase();
  return { buffer, type: MIME[ext] || 'application/octet-stream' };
}

const decodeXml = (s) => String(s || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => decodeXml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeXml(m[2] ?? m[3]) : '';
}

/** Встроенный пример: обложка, аннотация, серия, диалоги, сноска, эпиграф, стихи, вложенный раздел. */
async function buildSampleFb2() {
  let cover = '';
  const sharp = await getSharp().catch(() => null);
  if (sharp) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4a6b"/><stop offset="1" stop-color="#c9a15b"/></linearGradient></defs><rect width="600" height="900" fill="url(#g)"/><text x="300" y="420" font-size="54" text-anchor="middle" fill="#fff" font-family="sans-serif">Sample</text><text x="300" y="490" font-size="30" text-anchor="middle" fill="#fff" font-family="sans-serif">INPX Library</text></svg>';
    try { cover = (await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer()).toString('base64'); } catch { cover = ''; }
  }
  const para = 'Это пример текста для предпросмотра настроек конвертации. Здесь видно отступы, шрифт, переносы и оформление абзацев, а также то, как выглядят заголовки и разделители.';
  return `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>sf</genre>
<author><first-name>Иван</first-name><middle-name>Иванович</middle-name><last-name>Иванов</last-name></author>
<book-title>Пример книги</book-title>
<annotation><p>Короткая аннотация, чтобы проверить оформление аннотации и её место в оглавлении.</p></annotation>
<lang>ru</lang>${cover ? '<coverpage><image l:href="#cover.jpg"/></coverpage>' : ''}
<sequence name="Тестовый цикл" number="2"/></title-info>
<document-info><author><nickname>preview</nickname></author><date>2026-01-01</date><id>7f0c9a58-4b2a-4c0e-9d51-8a1c2c3d4e5f</id><version>1.0</version></document-info></description>
<body><title><p>Пример книги</p></title>
<epigraph><p>Эпиграф: всё течёт, всё меняется.</p><text-author>Гераклит</text-author></epigraph>
<section><title><p>Глава 1</p></title>
<p>${para}</p>
<p>— Привет, мир<a l:href="#n1" type="note">[1]</a>, — сказал он.</p>
<p>- Как дела? – спросил второй.</p>
<p>${para} ${para}</p>
<subtitle>Подзаголовок</subtitle>
<poem><stanza><v>Строка первая стихотворения,</v><v>строка вторая стихотворения.</v></stanza></poem>
<cite><p>Цитата для проверки оформления.</p><text-author>Автор цитаты</text-author></cite>
<p>${para}</p></section>
<section><title><p>Глава 2</p></title>
<section><title><p>Вложенный раздел</p></title><p>${para}</p><p>${para}</p></section>
<p>${para}</p></section>
<section><title><p>Глава 3</p></title><p>${para} ${para}</p><empty-line/><p>${para}</p></section>
</body>
<body name="notes"><title><p>Примечания</p></title><section id="n1"><title><p>1</p></title><p>Текст примечания.</p></section></body>
${cover ? `<binary id="cover.jpg" content-type="image/jpeg">${cover}</binary>` : ''}
</FictionBook>`;
}

function bookIdFromInput(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const fromUrl = /\/book\/([^/?#]+)/.exec(s);
  const id = decodeURIComponent(fromUrl ? fromUrl[1] : s);
  return /^[A-Za-z0-9:_.-]{1,120}$/.test(id) ? id : '';
}

const EPUB_FORMATS = new Set(['epub2', 'epub3', 'kepub', 'kepub3']);
const KINDLE_FORMATS = new Set(['kfx', 'azw8']);
const SINGLE_FILE_EXT = { pdf: 'pdf', txt: 'txt', md: 'md', kfx: 'kfx', azw8: 'azw8' };

const hrefFor = (token, name) => `/admin/conversion/preview/${token}/${name.split('/').map(encodeURIComponent).join('/')}`;

/** Распаковать EPUB в память и разобрать OPF: метаданные + список страниц (по spine). */
async function indexEpub(epub, token) {
  const dir = await unzipper.Open.buffer(epub);
  const files = new Map();
  let total = 0;
  for (const entry of dir.files) {
    if (entry.type !== 'File') continue;
    total += Number(entry.uncompressedSize) || 0;
    if (total > MAX_TOTAL_BYTES) throw new Error('TOO_LARGE');
    files.set(entry.path.replace(/\\/g, '/'), await entry.buffer());
  }

  const container = files.get('META-INF/container.xml')?.toString('utf8') || '';
  const opfPath = attr(/<rootfile\b[^>]*>/i.exec(container)?.[0] || '', 'full-path');
  const opf = files.get(opfPath)?.toString('utf8');
  if (!opf) throw new Error('BAD_EPUB');
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);
  const resolve = (href) => path.posix.normalize(opfDir ? `${opfDir}/${decodeURIComponent(href)}` : decodeURIComponent(href));

  const manifest = new Map();
  for (const tag of opf.match(/<item\b[^>]*>/gi) || []) {
    manifest.set(attr(tag, 'id'), { href: attr(tag, 'href'), type: attr(tag, 'media-type'), props: attr(tag, 'properties') });
  }
  const meta = {
    title: stripTags(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1]),
    authors: [...opf.matchAll(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => stripTags(m[1])).filter(Boolean),
    language: stripTags(/<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i.exec(opf)?.[1]),
    series: '', seriesIndex: '', cover: ''
  };
  const metaTags = opf.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    if (attr(tag, 'name') === 'calibre:series') meta.series = attr(tag, 'content');
    if (attr(tag, 'name') === 'calibre:series_index') meta.seriesIndex = attr(tag, 'content');
  }
  if (!meta.series) {
    const m = /<meta\b[^>]*property="belongs-to-collection"[^>]*>([\s\S]*?)<\/meta>/i.exec(opf);
    if (m) meta.series = stripTags(m[1]);
  }
  const coverMeta = metaTags.find((tg) => attr(tg, 'name') === 'cover');
  const coverItem = [...manifest.values()].find((it) => /\bcover-image\b/.test(it.props))
    || (coverMeta ? manifest.get(attr(coverMeta, 'content')) : null);
  if (coverItem) meta.cover = hrefFor(token, resolve(coverItem.href));

  const pages = [];
  for (const ref of opf.match(/<itemref\b[^>]*>/gi) || []) {
    if (pages.length >= MAX_PAGES) break;
    const item = manifest.get(attr(ref, 'idref'));
    if (!item || !/xhtml|html/i.test(item.type)) continue;
    const name = resolve(item.href);
    const html = files.get(name)?.toString('utf8');
    if (!html) continue;
    const title = stripTags(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1])
      || stripTags(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html)?.[1])
      || path.posix.basename(name);
    pages.push({ title: title.slice(0, 120), href: hrefFor(token, name) });
  }
  if (!pages.length) throw new Error('BAD_EPUB');
  return { files, meta, pages };
}

/**
 * @param {{ fields: Record<string, unknown>, book?: string, format?: string }} p
 * @returns {Promise<object>} { token, kind: 'epub'|'pdf'|'text'|'kindle', format, source, meta, pages, download? }
 */
export async function buildConversionPreview({ fields, book: bookInput = '', format = 'epub2' }) {
  const fmt = String(format || 'epub2').toLowerCase();
  if (!getFb2cngConvertibleFormats().includes(fmt)) throw new Error('BAD_FORMAT');
  const options = normalizeFb2cngOptions(fb2cngOptionsFromForm(fields || {}, getFb2cngTemplateDefaults()));
  let source = 'sample';
  let book = null;
  let buffer = null;
  if (String(bookInput || '').trim()) {
    const id = bookIdFromInput(bookInput);
    book = id ? getBookById(id) : null;
    if (!book) throw new Error('BOOK_NOT_FOUND');
    // fbc reads FB2 only: the conversion settings never apply to books stored in other formats
    if (String(book.ext || '').toLowerCase() !== 'fb2') throw new Error('NOT_FB2');
    source = String(book.title || id);
  } else {
    buffer = Buffer.from(await buildSampleFb2(), 'utf8');
  }

  const cfg = await writeCurrentConfigForCheck(options);
  const token = crypto.randomBytes(16).toString('hex');
  let result;
  try {
    const convert = (to) => convertForPreview({ book, buffer, format: to, configPath: cfg.path });
    if (EPUB_FORMATS.has(fmt)) {
      const epub = await convert(fmt);
      const idx = await indexEpub(epub, token);
      result = { kind: 'epub', files: idx.files, meta: { ...idx.meta, size: epub.length, files: idx.files.size }, pages: idx.pages };
    } else if (KINDLE_FORMATS.has(fmt)) {
      // Kindle containers cannot be drawn in a browser: the real file is offered for download (Kindle Previewer / device),
      // the page view is the EPUB3 rendering of the same settings — an approximation, labelled as such.
      const kindle = await convert(fmt);
      const epub = await convert('epub3');
      const idx = await indexEpub(epub, token);
      const name = `download/book.${SINGLE_FILE_EXT[fmt]}`;
      idx.files.set(name, kindle);
      result = {
        kind: 'kindle', files: idx.files, pages: idx.pages,
        meta: { ...idx.meta, size: kindle.length, files: idx.files.size },
        download: { href: hrefFor(token, name), size: kindle.length, ext: SINGLE_FILE_EXT[fmt] }
      };
    } else {
      const out = await convert(fmt);
      const name = `book.${SINGLE_FILE_EXT[fmt]}`;
      result = {
        kind: fmt === 'pdf' ? 'pdf' : 'text',
        files: new Map([[name, out]]),
        meta: { title: source, authors: [], language: '', series: '', seriesIndex: '', cover: '', size: out.length, files: 1 },
        pages: [{ title: source, href: hrefFor(token, name) }]
      };
    }
  } finally {
    await cfg.cleanup().catch(() => {});
  }

  sweep();
  store.set(token, { at: Date.now(), files: result.files });
  return { token, kind: result.kind, format: fmt, source, meta: result.meta, pages: result.pages, download: result.download || null };
}
