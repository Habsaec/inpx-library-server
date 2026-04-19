/**
 * Склонение по числу для русского: 1 книга, 2 книги, 5 книг, 11 книг, 21 книга.
 * @param {number} n
 * @param {string} one  — 1, 21, 31…
 * @param {string} few  — 2–4, 22–24…
 * @param {string} many — 0, 5–20, 25–30, 11–14…
 */
export function ruPluralWord(n, one, few, many) {
  const v = Math.floor(Math.abs(Number(n) || 0));
  const m10 = v % 10;
  const m100 = v % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

/** «5 книг» — число с группировкой ru-RU + слово */
export function ruCountLabel(n, one, few, many) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return `${v.toLocaleString('ru-RU')} ${ruPluralWord(v, one, few, many)}`;
}
