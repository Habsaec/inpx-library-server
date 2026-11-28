/**
 * Bucketing rule for the FB2 body: the one place that decides how a book's
 * top-level blocks are grouped into reader sections.
 *
 * Why this module exists rather than living inside `fb2.js`: the rule used to be
 * duplicated in `test/fb2-section-split.test.js`, so the test pinned a copy and a
 * divergence between production and test could not have been noticed. Here the
 * converter (`fb2.js`) and the test import the same function (`#40` review).
 *
 * The rule is byte-bounded, not chapter-bounded: a single huge chapter still
 * splits, and a chapter that alone exceeds the limit goes into its own bucket
 * because it cannot be split here. Splitting never drops or reorders a block, so
 * the concatenated text is unchanged — which is what keeps saved positions and
 * KOReader anchors valid (`src/kosync-position.js` scans the same text).
 */

/** Weight limit of one bucket, in characters of `outerHTML` (≈ bytes for Cyrillic UTF-8 markup). */
export const STITCH_MAX_BYTES = 220 * 1024;

/**
 * Byte weight of one block.
 * @param {Element} el
 * @returns {number}
 */
export function blockBytes(el) {
  try {
    return (el.outerHTML || '').length;
  } catch {
    return 0;
  }
}

/**
 * Group blocks into buckets that each stay under `limit`.
 *
 * Returns plain arrays of the elements, so the caller decides how to wrap them:
 * `fb2.js` wraps every bucket in a `div.fb2-body` (and a small body in one div),
 * the test only counts. Keeping the DOM work out of here is what makes the rule
 * testable without a real document.
 *
 * @param {Element[]} els top-level blocks of the first <body>, in document order
 * @param {number} [limit] bucket weight limit
 * @returns {Element[][]} buckets, each non-empty; one bucket when `total <= limit`
 */
export function bucketizeBlocks(els, limit = STITCH_MAX_BYTES) {
  const list = (els || []).filter(Boolean);
  if (!list.length) return [];
  const total = list.reduce((sum, el) => sum + blockBytes(el), 0);
  if (total <= limit) return [list];

  const buckets = [];
  let current = null;
  for (const el of list) {
    const size = blockBytes(el);
    /* `current` is null on the first block, and `fits` is false for a block that
       alone exceeds `limit` — both cases open a new bucket. */
    const fits = current && current.bytes + size <= limit;
    if (!fits) {
      current = { bytes: 0, els: [] };
      buckets.push(current);
    }
    current.els.push(el);
    current.bytes += size;
  }
  return buckets.map((b) => b.els);
}
