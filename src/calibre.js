/**
 * Calibre-библиотека как источник книг: снимок metadata.db, разбор полей Calibre, детали книги.
 *
 * Живой metadata.db никто, кроме copyFile, не открывает: Calibre может писать в него, он бывает на
 * SMB/NFS (блокировки SQLite там ненадёжны) и в Docker смонтирован только для чтения. Индексатор
 * копирует файл в data/calibre/<sourceId>-<mtimeMs>.db, и всё чтение (индексация, аннотации на
 * странице книги) идёт из этой копии. Имена версионные: на Windows открытый другим воркером
 * кластера файл нельзя заменить переименованием, поэтому указатель на текущий снимок лежит в meta
 * `calibre_snapshot_<id>`, а каждый процесс переоткрывает свою read-only копию, когда он меняется.
 *
 * Только таблицы, без представлений: `meta` и др. вызывают функции Calibre (concat, sortconcat,
 * title_sort), которых в нашем процессе нет.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { db, getMeta, setMeta, getSourceById } from './db.js';
import { detectImageMimeFromBuffer } from './services/cover.js';

export const CALIBRE_DB_FILE = 'metadata.db';

/**
 * Основной формат книги — первый из списка, который есть у книги: сначала то, что открывают читалки,
 * потом форматы «только скачать / OPDS / отправить» (фаза 3). Книги лишь в других форматах (LIT, HTMLZ…)
 * не индексируются.
 */
export const CALIBRE_PRIMARY_FORMATS = ['epub', 'azw3', 'mobi', 'fb2', 'pdf', 'djvu', 'cbz', 'cbr', 'txt', 'rtf', 'docx'];

const REQUIRED_TABLES = ['books', 'data', 'authors', 'books_authors_link'];
const REQUIRED_BOOK_COLUMNS = ['id', 'uuid', 'title', 'path', 'last_modified'];
const MAX_COVER_BYTES = 10 * 1024 * 1024;

const snapshotDir = () => path.join(config.dataDir, 'calibre');
const fingerprintKey = (sourceId) => `calibre_db_fp_${sourceId}`;
const snapshotKey = (sourceId) => `calibre_snapshot_${sourceId}`;

export function calibreDbPath(root) {
  return path.join(String(root || ''), CALIBRE_DB_FILE);
}

export function isCalibreLibraryDir(dir) {
  try {
    return fs.statSync(calibreDbPath(dir)).isFile();
  } catch {
    return false;
  }
}

export function makeCalibreBookId(sourceId, uuid) {
  return crypto.createHash('sha256').update(`${sourceId}:calibre:${uuid}`).digest('hex').slice(0, 32);
}

export const calibreLibId = (uuid) => `calibre:${uuid}`;

export function isCalibreBook(book) {
  return String(book?.libId || '').startsWith('calibre:');
}

/** Отпечаток metadata.db: mtime + size. */
export function calibreDbFingerprint(stat) {
  return stat ? `${stat.mtimeMs}:${stat.size}` : '';
}

export function getStoredCalibreFingerprint(sourceId) {
  return getMeta(fingerprintKey(sourceId)) || '';
}

/**
 * Проверяет схему: обязательные таблицы и столбцы. Возвращает множество имеющихся таблиц
 * (необязательные — серии, теги, рейтинги… — читаются, только если есть).
 */
export function inspectCalibreSchema(snap) {
  const tables = new Set(snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
  if (missing.length) throw new Error(`metadata.db: нет таблиц Calibre (${missing.join(', ')})`);
  const bookCols = new Set(snap.prepare('PRAGMA table_info(books)').all().map((c) => c.name));
  const missingCols = REQUIRED_BOOK_COLUMNS.filter((c) => !bookCols.has(c));
  if (missingCols.length) throw new Error(`metadata.db: в таблице books нет столбцов ${missingCols.join(', ')}`);
  return { tables, bookCols };
}

export function openCalibreDbReadonly(file) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** Админка (probe): число книг в живом metadata.db — один COUNT по read-only соединению. */
export function probeCalibreLibrary(dir) {
  if (!isCalibreLibraryDir(dir)) return null;
  let snap = null;
  try {
    snap = openCalibreDbReadonly(calibreDbPath(dir));
    inspectCalibreSchema(snap);
    return { books: Number(snap.prepare('SELECT COUNT(*) AS c FROM books').get()?.c) || 0 };
  } catch {
    return { books: null };
  } finally {
    try { snap?.close(); } catch { /* ignore */ }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Копирует metadata.db в data/calibre. Файл изменился во время копирования (mtime/size до и после
 * разные) или рядом «горячий» журнал Calibre — повтор (до 3 раз), потом ошибка: прежний снимок
 * остаётся в работе.
 */
export async function copyCalibreSnapshot(sourceId, root, { attempts = 3, retryDelayMs = 2000 } = {}) {
  const live = calibreDbPath(root);
  fs.mkdirSync(snapshotDir(), { recursive: true });
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const before = await fs.promises.stat(live);
    const journal = await fs.promises.stat(`${live}-journal`).catch(() => null);
    const file = path.join(snapshotDir(), `${sourceId}-${Math.round(before.mtimeMs)}-${process.pid}-${attempt}.db`);
    if (journal?.size > 0) {
      lastError = new Error('metadata.db is being written by Calibre (journal present)');
    } else {
      await fs.promises.copyFile(live, file);
      const after = await fs.promises.stat(live);
      if (after.mtimeMs === before.mtimeMs && after.size === before.size) {
        return { file, fingerprint: calibreDbFingerprint(before) };
      }
      lastError = new Error('metadata.db changed while it was being copied');
      await fs.promises.unlink(file).catch(() => {});
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw lastError;
}

/** Снимок прошёл индексацию: запоминаем указатель и отпечаток, старые снимки источника удаляем. */
export function commitCalibreSnapshot(sourceId, file, fingerprint) {
  setMeta(snapshotKey(sourceId), path.basename(file));
  setMeta(fingerprintKey(sourceId), fingerprint);
  removeStaleCalibreSnapshots(sourceId);
}

export function removeStaleCalibreSnapshots(sourceId, { all = false } = {}) {
  const current = all ? '' : getMeta(snapshotKey(sourceId)) || '';
  let names = [];
  try {
    names = fs.readdirSync(snapshotDir());
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${sourceId}-`) || name === current) continue;
    const open = openSnapshots.get(Number(sourceId));
    if (open?.name === name) {
      try { open.db.close(); } catch { /* ignore */ }
      openSnapshots.delete(Number(sourceId));
    }
    // Другой воркер кластера ещё держит файл (Windows) — удалится в следующий проход.
    try { fs.unlinkSync(path.join(snapshotDir(), name)); } catch { /* busy */ }
  }
}

/** Источник удалён: его снимки и meta больше не нужны. */
export function forgetCalibreSource(sourceId) {
  const open = openSnapshots.get(Number(sourceId));
  if (open) {
    try { open.db.close(); } catch { /* ignore */ }
    openSnapshots.delete(Number(sourceId));
  }
  try { db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run(snapshotKey(sourceId), fingerprintKey(sourceId)); } catch { /* ignore */ }
  removeStaleCalibreSnapshots(sourceId, { all: true });
}

/** sourceId → { name, db, tables } — по одному read-only соединению на процесс. */
const openSnapshots = new Map();

export function getCalibreSnapshotDb(sourceId) {
  const sid = Number(sourceId);
  const name = getMeta(snapshotKey(sid)) || '';
  const open = openSnapshots.get(sid);
  if (open && open.name === name) return open;
  if (open) {
    try { open.db.close(); } catch { /* ignore */ }
    openSnapshots.delete(sid);
  }
  if (!name) return null;
  try {
    const snap = openCalibreDbReadonly(path.join(snapshotDir(), name));
    const { tables } = inspectCalibreSchema(snap);
    const entry = { name, db: snap, tables };
    openSnapshots.set(sid, entry);
    return entry;
  } catch {
    return null;
  }
}

/* ---------- Разбор полей Calibre ---------- */

/** ISO 639-2/3 (Calibre) → 639-1, как в INPX/EPUB; иначе en и eng — два разных языка в фильтре. */
const ISO639_3_TO_1 = {
  afr: 'af', ara: 'ar', aze: 'az', bel: 'be', ben: 'bn', bos: 'bs', bul: 'bg', cat: 'ca', ces: 'cs', cze: 'cs',
  chi: 'zh', zho: 'zh', cym: 'cy', wel: 'cy', dan: 'da', deu: 'de', ger: 'de', ell: 'el', gre: 'el', eng: 'en',
  epo: 'eo', est: 'et', eus: 'eu', baq: 'eu', fas: 'fa', per: 'fa', fin: 'fi', fra: 'fr', fre: 'fr', gle: 'ga',
  glg: 'gl', heb: 'he', hin: 'hi', hrv: 'hr', hun: 'hu', hye: 'hy', arm: 'hy', ind: 'id', isl: 'is', ice: 'is',
  ita: 'it', jpn: 'ja', kat: 'ka', geo: 'ka', kaz: 'kk', kor: 'ko', kir: 'ky', lat: 'la', lav: 'lv', lit: 'lt',
  mkd: 'mk', mac: 'mk', mon: 'mn', msa: 'ms', may: 'ms', nld: 'nl', dut: 'nl', nor: 'no', nob: 'nb', nno: 'nn',
  pol: 'pl', por: 'pt', ron: 'ro', rum: 'ro', rus: 'ru', slk: 'sk', slo: 'sk', slv: 'sl', spa: 'es', sqi: 'sq',
  alb: 'sq', srp: 'sr', swe: 'sv', tat: 'tt', tgk: 'tg', tha: 'th', tur: 'tr', tuk: 'tk', ukr: 'uk', urd: 'ur',
  uzb: 'uz', vie: 'vi', yid: 'yi'
};

export function calibreLangToIso1(code) {
  const value = String(code || '').trim().toLowerCase();
  if (!value || value === 'und' || value === 'zxx') return '';
  return ISO639_3_TO_1[value] || value;
}

/**
 * Автор Calibre → INPX-форма «Фамилия,Имя,Отчество» из authors.sort («Asimov, Isaac»): на фамилию
 * до первой запятой опираются сортировка и сопоставление подборок. Calibre хранит запятую в имени
 * как «|». Пустой sort или sort без запятой — имя как есть (как dc:creator у EPUB папки).
 */
export function calibreAuthorToInpx(name, sort) {
  const clean = (v) => String(v || '').replace(/\|/g, ',').replace(/[:;]/g, ' ').replace(/\s+/g, ' ').trim();
  const sortValue = clean(sort);
  if (sortValue.includes(',')) {
    return sortValue.split(',').map((part) => part.trim()).filter(Boolean).join(',');
  }
  return clean(name).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

/** series_index REAL → «1», «2.5». */
export function formatCalibreSeriesIndex(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 1000) / 1000);
}

/** Тег Calibre как значение жанра/ключевого слова: разделители списков (: ; ,) внутри тега — пробел. */
export function cleanCalibreTag(tag) {
  return String(tag || '').replace(/[:;,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** YYYY-MM-DD из метки Calibre («2024-03-01 12:00:00+00:00»); «0101-01-01» = «не задано». */
export function calibreDateOnly(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || Number(m[1]) < 1000) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function calibreYear(value) {
  const date = calibreDateOnly(value);
  const year = date ? Number(date.slice(0, 4)) : 0;
  return year >= 1000 && year <= new Date().getFullYear() + 1 ? year : null;
}

/** formats — [{ format: 'EPUB', name, size }] → основной (по CALIBRE_PRIMARY_FORMATS) или null. */
export function pickCalibrePrimaryFormat(formats) {
  for (const ext of CALIBRE_PRIMARY_FORMATS) {
    const hit = formats.find((f) => String(f.format || '').toLowerCase() === ext && f.name);
    if (hit) return { ext, name: hit.name, size: Number(hit.size) || 0 };
  }
  return null;
}

/** Подпись списка форматов для calibre_book_state: «EPUB:12345,PDF:999». */
export function calibreFormatsSignature(formats) {
  return formats
    .map((f) => `${String(f.format || '').toUpperCase()}:${Number(f.size) || 0}`)
    .sort()
    .join(',');
}

/* ---------- Детали книги (страница книги, обложка) ---------- */

function resolveInsideRoot(root, relative) {
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, relative);
  if (!full.startsWith(resolvedRoot + path.sep)) return null;
  return full;
}

async function readCalibreCover(root, bookPath) {
  const file = resolveInsideRoot(root, path.join(bookPath, 'cover.jpg'));
  if (!file) return null;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_COVER_BYTES) return null;
    const data = await fs.promises.readFile(file);
    const contentType = detectImageMimeFromBuffer(data);
    return contentType ? { contentType, data } : null;
  } catch {
    return null;
  }
}

let _stmtCalibreIdForBook = null;

/**
 * Аннотация (comments, HTML), год издания (pubdate), ISBN (identifiers) и cover.jpg — без распаковки
 * книги. null — снимка нет или книги в нём нет (тогда работает обычный путь).
 */
export async function readCalibreBookDetails(book) {
  if (!book?.id || !book.sourceId) return null;
  _stmtCalibreIdForBook ??= db.prepare('SELECT calibre_id AS calibreId FROM calibre_book_state WHERE book_id = ? AND source_id = ?');
  const calibreId = _stmtCalibreIdForBook.get(book.id, Number(book.sourceId))?.calibreId;
  if (calibreId == null) return null;
  const snap = getCalibreSnapshotDb(book.sourceId);
  if (!snap) return null;
  const source = getSourceById(Number(book.sourceId));
  if (!source?.path) return null;
  let row;
  let annotation = '';
  let isbn = '';
  try {
    row = snap.db.prepare('SELECT path, pubdate, has_cover AS hasCover FROM books WHERE id = ?').get(calibreId);
    if (!row) return null;
    if (snap.tables.has('comments')) {
      annotation = String(snap.db.prepare('SELECT text FROM comments WHERE book = ?').get(calibreId)?.text || '').trim();
    }
    if (snap.tables.has('identifiers')) {
      const raw = snap.db.prepare("SELECT val FROM identifiers WHERE book = ? AND lower(type) = 'isbn' ORDER BY id LIMIT 1").get(calibreId)?.val;
      isbn = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    }
  } catch {
    return null;
  }
  const cover = Number(row.hasCover) ? await readCalibreCover(source.path, String(row.path || '')) : null;
  return {
    title: book.title || '',
    annotation,
    annotationIsHtml: Boolean(annotation),
    publishYear: calibreYear(row.pubdate),
    isbn,
    metaResolved: true,
    cover
  };
}
