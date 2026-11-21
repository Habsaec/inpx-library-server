/**
 * Cover tones: the dominant color of a book cover and a tiny blurred placeholder (LQIP, an 8×12 WebP
 * data URI, ~100–200 bytes), table `cover_tones`.
 *
 * Filled where the server already holds the cover bytes: after a cover thumb is generated, and — for
 * thumbs served from the memory / disk cache (no tone yet) — in a small background queue from the
 * cached thumb. Nothing scans the catalog: tones appear as covers are viewed.
 *
 * Book payloads get additive `coverColor` (#rrggbb) / `coverLqip` (data URI) through
 * `attachCoverTones(books)` (one indexed IN query per list). Web: placeholder under the cover image and
 * a tint behind the cover on the book page; Android: placeholder in its cover views and a tint in the
 * book sheet. Derived data: skipped by the portable backup, dropped with the cover thumb caches.
 */
import { db } from '../db.js';
import { getSharp } from './sharp-loader.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS cover_tones (
    book_id TEXT PRIMARY KEY,
    color TEXT NOT NULL,
    lqip TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  ) WITHOUT ROWID;
`);

const HEX_RE = /^#[0-9a-f]{6}$/;
const LQIP_MAX_CHARS = 600;
const QUEUE_MAX = 300;

let _selectStmts = new Map();
let _upsertStmt = null;
let _deleteStmt = null;

function selectStmt(n) {
  let stmt = _selectStmts.get(n);
  if (!stmt) {
    stmt = db.prepare(`SELECT book_id AS id, color, lqip FROM cover_tones WHERE book_id IN (${Array(n).fill('?').join(',')})`);
    if (_selectStmts.size > 64) _selectStmts = new Map();
    _selectStmts.set(n, stmt);
  }
  return stmt;
}

/** Map<bookId, { color, lqip }> for the given ids (missing ids absent). */
export function getCoverTones(ids) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(Boolean).map(String))];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const row of selectStmt(chunk.length).all(...chunk)) out.set(row.id, { color: row.color, lqip: row.lqip });
  }
  return out;
}

/* Ids known to have a tone: a cover request hits this Set, not the DB (cleared when it grows large). */
const _known = new Set();
const KNOWN_MAX = 50_000;
function markKnown(id) {
  if (_known.size >= KNOWN_MAX) _known.clear();
  _known.add(id);
}

export function hasCoverTone(bookId) {
  const id = String(bookId);
  if (_known.has(id)) return true;
  const has = getCoverTones([id]).has(id);
  if (has) markKnown(id);
  return has;
}

/*
 * Where list-time scheduling reads thumbs from: set by the cover routes (cover.js imports this module,
 * so it cannot be imported back). Browsers keep up to 500 covers in the Service Worker and the Android
 * app has its own cover cache — such covers never reach the server again, so a list that shows a book
 * without a tone computes it from the server's disk thumb cache (never generates a new thumb).
 */
let _toneSource = null;
export function setCoverToneSource(source) {
  _toneSource = source && typeof source.loadCached === 'function' ? source : null;
}

/** Adds `coverColor` / `coverLqip` to book objects that have a stored tone (in place). */
export function attachCoverTones(books) {
  if (!books || books.length === 0) return;
  let tones;
  try {
    tones = getCoverTones(books.map((b) => b?.id));
  } catch {
    return; // table missing on a read-only replica: payloads simply stay without tones
  }
  for (const book of books) {
    if (!book) continue;
    const tone = tones.get(String(book.id));
    if (!tone) {
      if (_toneSource) scheduleCoverTone(book.id, () => _toneSource.loadCached(String(book.id)), _toneSource);
      continue;
    }
    markKnown(String(book.id));
    book.coverColor = tone.color;
    if (tone.lqip) book.coverLqip = tone.lqip;
  }
}

const looksLikeBook = (x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.title === 'string';

/**
 * Tones for an API response body at send time (list results are cached, often built before a tone
 * existed): `items[]` of books, plus one level of nesting — `items[].items[]` (home shelves) and
 * `items[].book` (collections) — and the author grouped shape. One query for the whole body.
 */
export function attachCoverTonesToBody(body) {
  if (!body || typeof body !== 'object') return;
  const books = [];
  const take = (list) => { if (Array.isArray(list)) for (const b of list) if (looksLikeBook(b)) books.push(b); };
  if (Array.isArray(body.items)) {
    for (const item of body.items) {
      if (looksLikeBook(item)) books.push(item);
      else if (item && typeof item === 'object') {
        take(item.items);
        if (looksLikeBook(item.book)) books.push(item.book);
      }
    }
  }
  /* author grouped: `standaloneBooks`, `books`, `series[].books` */
  take(body.standaloneBooks);
  take(body.books);
  if (Array.isArray(body.series)) for (const s of body.series) take(s?.books);
  if (books.length) attachCoverTones(books.filter((b) => !b.coverColor));
}

export function setCoverTone(bookId, color, lqip = '') {
  if (!bookId || !HEX_RE.test(color)) return;
  _upsertStmt ??= db.prepare(`
    INSERT INTO cover_tones (book_id, color, lqip) VALUES (?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET color = excluded.color, lqip = excluded.lqip
  `);
  try {
    _upsertStmt.run(String(bookId), color, String(lqip || '').slice(0, LQIP_MAX_CHARS));
    markKnown(String(bookId));
  } catch {
    /* the book may have been deleted meanwhile (FK) */
  }
}

export function deleteCoverTone(bookId) {
  _deleteStmt ??= db.prepare('DELETE FROM cover_tones WHERE book_id = ?');
  _known.delete(String(bookId));
  try { _deleteStmt.run(String(bookId)); } catch { /* ignore */ }
}

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/**
 * The cover's most vivid color for a tint: averages the most chromatic pixels of a 12×18 copy whose
 * lightness is not near black / white. The histogram «dominant» is often the dark background of a
 * cover (#280808 for a red one), which gives no visible tint. Grey covers fall back to `fallback`.
 */
function vividColor(raw, channels, fallback) {
  const px = [];
  for (let i = 0; i + 2 < raw.length; i += channels) {
    const r = raw[i]; const g = raw[i + 1]; const b = raw[i + 2];
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    const light = (max + min) / 510;
    const chroma = max - min;
    if (light < 0.12 || light > 0.9) continue;
    px.push({ r, g, b, score: chroma * (1 - Math.abs(light - 0.5)) });
  }
  if (!px.length) return fallback;
  px.sort((a, b) => b.score - a.score);
  const top = px.slice(0, Math.max(3, Math.ceil(px.length * 0.12)));
  const avg = (k) => top.reduce((sum, p) => sum + p[k], 0) / top.length;
  const r = avg('r'); const g = avg('g'); const b = avg('b');
  if (Math.max(r, g, b) - Math.min(r, g, b) < 36) return fallback;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * `{ color, lqip }` from image bytes (a cover thumb), or null without sharp / on a broken image.
 * color = the most vivid color (else sharp's histogram dominant one); lqip = 8×12 WebP, smooth when the
 * browser scales it up.
 */
export async function computeCoverTone(buffer) {
  if (!buffer?.length) return null;
  const sharp = await getSharp();
  if (!sharp) return null;
  try {
    const small = sharp(buffer, { failOn: 'none' }).resize(48, 72, { fit: 'cover' });
    const stats = await small.clone().stats();
    const d = stats.dominant || {};
    const dominant = `#${hex2(d.r)}${hex2(d.g)}${hex2(d.b)}`;
    const { data: raw, info } = await small.clone().resize(12, 18, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const color = vividColor(raw, info.channels, dominant);
    const tiny = await small.clone().resize(8, 12, { fit: 'fill' }).webp({ quality: 50, effort: 4 }).toBuffer();
    const lqip = `data:image/webp;base64,${tiny.toString('base64')}`;
    return { color, lqip: lqip.length <= LQIP_MAX_CHARS ? lqip : '' };
  } catch {
    return null;
  }
}

/* ── Background queue for thumbs served from cache ── */

const _queue = new Map(); // bookId -> () => Promise<Buffer|null>
let _running = false;

async function drain(acquire, release) {
  if (_running) return;
  _running = true;
  try {
    while (_queue.size) {
      const [bookId, load] = _queue.entries().next().value;
      _queue.delete(bookId);
      if (hasCoverTone(bookId)) continue;
      let gotSlot = false;
      try {
        await acquire();
        gotSlot = true;
        const buffer = await load();
        const tone = await computeCoverTone(buffer);
        if (tone) setCoverTone(bookId, tone.color, tone.lqip);
      } catch {
        /* busy sharp queue / unreadable thumb: try again on a later view */
      } finally {
        if (gotSlot) release();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    _running = false;
  }
}

/**
 * Computes a missing tone in the background (one at a time, through the shared sharp slots).
 * `load` returns the thumb bytes. No-op when the book already has a tone or the queue is full.
 */
export function scheduleCoverTone(bookId, load, { acquire, release }) {
  const id = String(bookId || '');
  if (!id || /[\u0000-\u001f]/.test(id) || _queue.has(id) || _queue.size >= QUEUE_MAX) return;
  try {
    if (hasCoverTone(id)) return;
  } catch {
    return;
  }
  _queue.set(id, load);
  setImmediate(() => { void drain(acquire, release); });
}
