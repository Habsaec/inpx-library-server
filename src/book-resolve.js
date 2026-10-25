import { db } from './db.js';
import { createSortKey } from './inpx.js';

/** Max refs per `POST /api/books/resolve` call (same order as reader-sync-index). */
export const BOOK_RESOLVE_MAX_REFS = 200;

const LOCAL_READER_BOOK_ID = /^local:[a-f0-9]{64}$/;
/** INPX book id `<sourceId>:<libId>`; the source id is per server, the lib id is per library. */
const INPX_BOOK_ID = /^\d+:(\d+)$/;

function foldText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Author tokens, order-independent: «Винокуров,Юрий,:Сапфир,Олег,:» == «Сапфир Олег, Винокуров Юрий». */
function authorKey(value) {
  const raw = Array.isArray(value) ? value.join(' ') : String(value ?? '');
  return foldText(raw.replace(/[:,;]/g, ' ')).split(' ').filter(Boolean).sort().join(' ');
}

function normalizeExt(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^\./, '');
}

let _stmtKnown = null;
let _stmtByLibId = null;
let _stmtByTitle = null;

function uniqueMatch(rows, ref) {
  const title = foldText(ref.title);
  _stmtKnown ??= db.prepare('SELECT 1 FROM active_books WHERE id = ?');
  const authors = authorKey(ref.authors);
  const ext = normalizeExt(ref.ext);
  const hits = rows.filter((row) => (
    foldText(row.title) === title
    && (!ext || normalizeExt(row.ext) === ext)
    && (!authors || !ref.requireAuthors || authorKey(row.authors) === authors)
    && _stmtKnown.get(row.id)
  ));
  return hits.length === 1 ? String(hits[0].id) : null;
}

/**
 * Map a book id from another catalog (another server, or a source deleted and added again,
 * which gets a new source id) onto this library. The title must match in every branch,
 * and a candidate is accepted only when it is the single match:
 *   1. the id itself is an active book;
 *   2. same lib id (from `libId` or the `<src>:<lib>` id) + title (+ ext);
 *   3. title + authors (+ ext).
 * @param {{ id: string, title?: string, authors?: string|string[], ext?: string, libId?: string }} ref
 * @returns {{ id: string, bookId: string|null, match: 'id'|'libId'|'title'|null }}
 */
export function resolveBookRef(ref) {
  const id = String(ref?.id ?? '').trim();
  const none = { id, bookId: null, match: null };
  if (!id) return none;
  _stmtKnown ??= db.prepare('SELECT 1 FROM active_books WHERE id = ?');
  if (LOCAL_READER_BOOK_ID.test(id) || _stmtKnown.get(id)) return { id, bookId: id, match: 'id' };

  const title = String(ref?.title ?? '').trim();
  if (!foldText(title)) return none;

  const libId = String(ref?.libId ?? '').trim() || (INPX_BOOK_ID.exec(id)?.[1] ?? '');
  if (/^\d+$/.test(libId)) {
    // Candidates from `books` (indexed); `active_books` is checked per row — the view scans.
    _stmtByLibId ??= db.prepare(`
      SELECT id, title, authors, ext FROM books
      WHERE lib_id = ? AND deleted = 0 AND lib_id IS NOT NULL AND TRIM(lib_id) != ''
      LIMIT 50
    `);
    const bookId = uniqueMatch(_stmtByLibId.all(libId), { ...ref, requireAuthors: false });
    if (bookId) return { id, bookId, match: 'libId' };
  }

  if (!authorKey(ref?.authors)) return none;
  _stmtByTitle ??= db.prepare(`
    SELECT id, title, authors, ext FROM books
    WHERE title_sort = ? AND deleted = 0
    LIMIT 50
  `);
  const bookId = uniqueMatch(_stmtByTitle.all(createSortKey(title)), { ...ref, requireAuthors: true });
  return bookId ? { id, bookId, match: 'title' } : none;
}

export function resolveBookRefs(refs) {
  const list = Array.isArray(refs) ? refs.slice(0, BOOK_RESOLVE_MAX_REFS) : [];
  return list
    .filter((ref) => ref && typeof ref === 'object')
    .map((ref) => resolveBookRef(ref));
}
