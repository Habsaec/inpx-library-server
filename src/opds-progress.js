/**
 * Прогресс чтения для OPDS-лент: клиенты (KOReader, Moon+) не умеют метаданных прогресса,
 * поэтому значок кладётся в начало названия книги (как в Kavita): ◔ ≤25%, ◑ ≤50%, ◕ >50%, ⬤ прочитано.
 * Источники: reading_positions (веб/Android), read_books и прогресс KOReader (kosync) по скачанным файлам.
 */
import { db } from './db.js';

const CHUNK = 400;

export function opdsProgressIcon(percent, isRead = false) {
  if (isRead || percent >= 99) return '\u2B24';
  if (!(percent > 0)) return '';
  if (percent <= 25) return '\u25D4';
  if (percent <= 50) return '\u25D1';
  return '\u25D5';
}

/** @returns {Map<string, { percent: number, read: boolean }>} только книги с прогрессом. */
export function getOpdsProgressMap(username, bookIds) {
  const result = new Map();
  const ids = [...new Set((bookIds || []).map((id) => String(id || '')).filter(Boolean))];
  if (!username || !ids.length) return result;
  const put = (id, percent, read = false) => {
    const prev = result.get(id) || { percent: 0, read: false };
    result.set(id, { percent: Math.max(prev.percent, percent), read: prev.read || read });
  };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT book_id AS id, progress FROM reading_positions WHERE username = ? AND book_id IN (${marks})`).all(username, ...part)) {
      put(row.id, Number(row.progress) || 0);
    }
    for (const row of db.prepare(`SELECT book_id AS id FROM read_books WHERE username = ? AND book_id IN (${marks})`).all(username, ...part)) {
      put(row.id, 100, true);
    }
    for (const row of db.prepare(`
      SELECT d.book_id AS id, MAX(p.percentage) AS pct
      FROM kosync_progress p JOIN kosync_documents d ON d.document = p.document
      WHERE p.username = ? AND d.book_id IN (${marks}) GROUP BY d.book_id
    `).all(username, ...part)) {
      put(row.id, (Number(row.pct) || 0) * 100);
    }
  }
  return result;
}

/** Копии книг с `opdsProgressIcon` (исходные объекты, в т.ч. из кэша, не мутируются). */
export function withOpdsProgress(items, username) {
  if (!username || !items?.length) return items;
  const map = getOpdsProgressMap(username, items.map((book) => book?.id));
  if (!map.size) return items;
  return items.map((book) => {
    const entry = book && map.get(String(book.id));
    const icon = entry ? opdsProgressIcon(entry.percent, entry.read) : '';
    return icon ? { ...book, opdsProgressIcon: icon } : book;
  });
}
