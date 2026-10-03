/**
 * Lightweight Russian query expansion for FTS prefix MATCH.
 * Not a full morphological analyzer — strips common inflectional suffixes
 * so "облаками" can match indexed "облаками" via stem "облак"* .
 */

const RU_SUFFIXES = [
  'иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
  'ах', 'ях', 'ов', 'ев', 'ём', 'ом', 'ем', 'ам', 'ям',
  'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ую', 'юю', 'ии', 'ых', 'их', 'ым', 'им',
  'ы', 'и', 'а', 'я', 'у', 'ю', 'о', 'е', 'ь'
];

/**
 * @param {string} token lowercase sort-key token
 * @returns {string} stem (may equal token)
 */
export function stemRussianToken(token = '') {
  const t = String(token || '').toLowerCase();
  if (t.length < 4) return t;
  for (const suf of RU_SUFFIXES) {
    if (t.length - suf.length < 3) continue;
    if (t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

/**
 * One FTS prefix per token.
 * A stem of 4+ characters is a prefix of the surface form, so `stem*` matches
 * both the original token and the indexed stem. OR-ing `token*` with `stem*`
 * only unions two posting lists. Stems shorter than 4 stay as the surface
 * token — a 3-letter prefix matches too much.
 * @param {string[]} tokens
 * @returns {string[][]}
 */
export function expandSearchTokenVariants(tokens = []) {
  return tokens.map((token) => {
    const t = String(token || '').trim();
    if (!t) return [];
    if (t.length >= 5) {
      const stem = stemRussianToken(t);
      if (stem && stem !== t && stem.length >= 4) return [stem];
    }
    return [t];
  }).filter((group) => group.length > 0);
}

/**
 * Append stemmed forms to a sort-key / search field for index-time matching.
 * @param {string} sortKey
 * @returns {string}
 */
export function appendStemmedSearchTokens(sortKey = '') {
  const key = String(sortKey || '').trim();
  if (!key) return '';
  const tokens = key.split(/\s+/).filter(Boolean);
  const extra = [];
  const seen = new Set(tokens);
  for (const token of tokens) {
    if (token.length < 4) continue;
    const stem = stemRussianToken(token);
    if (stem && stem !== token && stem.length >= 3 && !seen.has(stem)) {
      seen.add(stem);
      extra.push(stem);
    }
  }
  return extra.length ? `${key} ${extra.join(' ')}` : key;
}
