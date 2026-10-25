/**
 * Import of reading lists from Goodreads / LiveLib CSV exports (Profile → «Импорт из Goodreads / LiveLib»).
 *
 * Columns are found by header name, so Goodreads (`Title`, `Author`, `My Rating`, `Exclusive Shelf`),
 * LiveLib (`Название`, `Автор`, `Оценка`, `Статус`) and hand-made files work alike.
 * Status → «Прочитано» / «Хочу прочитать», rating 1–5 → «Мои оценки». A row is matched by title
 * (normalized, Goodreads «(Series, #1)» stripped) plus author surname; unmatched rows are reported.
 * Rows are processed in small chunks with event-loop yields — search on a 500k catalog is not free.
 */
import { searchBooks, addReadBooksIfMissing, isWantToRead, toggleWantToRead, isBookRead } from '../inpx.js';
import { setBookRating } from '../db.js';

export const READING_IMPORT_MAX_ROWS = 5000;
const UNMATCHED_REPORT_MAX = 200;
const CHUNK = 25;

const HEADER_ALIASES = {
  title: ['title', 'название', 'книга', 'name', 'book'],
  author: ['author', 'автор', 'authors', 'авторы', 'author l-f'],
  rating: ['my rating', 'моя оценка', 'оценка', 'rating', 'rate'],
  status: ['exclusive shelf', 'статус', 'status', 'shelf', 'полка', 'bookshelves']
};

const READ_STATUSES = ['read', 'прочитано', 'прочитана', 'прочитал', 'прочитала', 'прочитанное', 'done'];
const WANT_STATUSES = ['to-read', 'to read', 'want', 'want to read', 'хочу прочитать', 'хочу', 'в планах', 'отложено', 'currently-reading', 'reading', 'читаю', 'сейчас читаю'];

/** Minimal RFC 4180 parser: quotes, doubled quotes, newlines inside quotes; `,` or `;` (auto). */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'));
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Goodreads appends the series: «Dune (Dune Chronicles, #1)». */
function cleanTitle(title) {
  return String(title || '').replace(/\s*\([^()]*#\s*[\d.]+\)\s*$/u, '').trim();
}

function authorSurname(author) {
  const raw = String(author || '').split(/[,;&]| and | и /)[0].trim();
  const words = normalizeText(raw).split(' ').filter((w) => w.length > 1);
  if (!words.length) return '';
  // «Лев Толстой» / «Толстой Лев» / «Tolstoy, Leo»: any word may be the surname — the longest is a good bet.
  return words.sort((a, b) => b.length - a.length)[0];
}

function findColumn(headers, key) {
  const aliases = HEADER_ALIASES[key];
  return headers.findIndex((h) => aliases.includes(normalizeText(h).replace(/\s+/g, ' ')) || aliases.includes(String(h || '').trim().toLowerCase()));
}

function classifyStatus(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (READ_STATUSES.includes(v)) return 'read';
  if (WANT_STATUSES.includes(v)) return 'want';
  return '';
}

/** Best catalog match for title + author, or null. */
export function matchBook(title, author) {
  const cleaned = cleanTitle(title);
  const wanted = normalizeText(cleaned);
  if (!wanted) return null;
  const surname = authorSurname(author);
  const { items } = searchBooks({ query: cleaned, field: 'title', page: 1, pageSize: 20, totalMode: 'omit', allowTypoRetry: false });
  const candidates = (items || []).filter((book) => {
    const bookTitle = normalizeText(book.title);
    return bookTitle === wanted || bookTitle.startsWith(`${wanted} `) || wanted.startsWith(`${bookTitle} `);
  });
  const byAuthor = surname
    ? candidates.filter((book) => normalizeText(book.authors).split(' ').includes(surname))
    : candidates;
  const pool = byAuthor.length ? byAuthor : (surname ? [] : candidates);
  return pool.find((book) => normalizeText(book.title) === wanted) || pool[0] || null;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * → { rows, matched, read, want, rated, unmatched: [{ title, author }], unmatchedTotal }
 * Throws `{ code: 'IMPORT_NO_COLUMNS' }` when no title column is found.
 */
export async function importReadingCsv(username, csvText) {
  const table = parseCsv(csvText);
  if (!table.length) return { rows: 0, matched: 0, read: 0, want: 0, rated: 0, unmatched: [], unmatchedTotal: 0 };
  const [headers, ...body] = table;
  const col = {
    title: findColumn(headers, 'title'),
    author: findColumn(headers, 'author'),
    rating: findColumn(headers, 'rating'),
    status: findColumn(headers, 'status')
  };
  if (col.title < 0) {
    const err = new Error('No title column');
    err.code = 'IMPORT_NO_COLUMNS';
    throw err;
  }
  const rows = body.slice(0, READING_IMPORT_MAX_ROWS);
  const report = { rows: rows.length, matched: 0, read: 0, want: 0, rated: 0, unmatched: [], unmatchedTotal: 0 };
  const readIds = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (i && i % CHUNK === 0) await tick();
    const row = rows[i];
    const title = row[col.title] || '';
    const author = col.author >= 0 ? row[col.author] || '' : '';
    if (!String(title).trim()) continue;
    const book = matchBook(title, author);
    if (!book) {
      report.unmatchedTotal += 1;
      if (report.unmatched.length < UNMATCHED_REPORT_MAX) report.unmatched.push({ title: cleanTitle(title), author: String(author).trim() });
      continue;
    }
    report.matched += 1;
    const rating = col.rating >= 0 ? Math.round(Number(String(row[col.rating] || '').replace(',', '.'))) : 0;
    if (rating >= 1 && rating <= 5) {
      setBookRating(username, book.id, rating);
      report.rated += 1;
    }
    const status = col.status >= 0 ? classifyStatus(row[col.status]) : (rating ? 'read' : '');
    if (status === 'read') {
      readIds.push(book.id);
    } else if (status === 'want' && !isWantToRead(username, book.id) && !isBookRead(username, book.id)) {
      toggleWantToRead(username, book.id);
      report.want += 1;
    }
  }
  if (readIds.length) report.read = addReadBooksIfMissing(username, readIds).added;
  return report;
}
