/**
 * Re-anchoring a saved FB2 position after the body was split into buckets (#40 review).
 *
 * The problem this solves. Before bucket splitting, the whole first <body> was reader
 * section 0, so a saved `{ sectionIndex: 0, textOffset: N }` meant "N characters into the
 * book's body text". After splitting, section 0 is only the FIRST bucket, so the same pair
 * now means "N characters into the first 220 KB" — for a position deep in a big book it
 * either lands in the wrong place or past the end of the bucket.
 *
 * The fix does not guess. A saved position for a big book carries `textQuote` — up to 96
 * characters of the normalized body text at that offset — and the buckets preserve the
 * body text exactly (that property is pinned by `test/fb2-section-split.test.js`). So the
 * body text can be rebuilt by concatenating the buckets in order, the quote is located in
 * it, and the stale pair is translated to the bucket that now holds that text.
 *
 * When this must NOT run: for small books nothing was split (one bucket, index 0 stays
 * index 0), and a position with no quote cannot be resolved reliably — then the caller
 * falls back to `fraction`, which is layout- and structure-independent.
 */

/** Normalize exactly like the reader/paginator: collapse whitespace runs, trim. */
export function normalizeBodyText(value) {
  return String(value ?? '').replace(/[\t\n\f\r ]+/g, ' ').trim();
}

/**
 * Is this saved position "section 0 of a body that is now several sections"?
 *
 * Only then is the index ambiguous. A position already pointing at bucket 3 was saved by a
 * reader that had buckets, so it is correct as is.
 *
 * @param {object} saved payload with `sectionIndex`
 * @param {number} sectionCount number of reader sections the book now has
 * @returns {boolean}
 */
export function needsRebucket(saved, sectionCount) {
  if (!saved) return false;
  const index = Number(saved?.sectionIndex);
  if (!Number.isInteger(index) || index < 0) return false;
  if (!(sectionCount > 1)) return false;
  return index === 0;
}

/**
 * Translate a pre-split `{ sectionIndex: 0, textOffset }` into the bucket that now holds it.
 *
 * @param {object} saved         payload with `textOffset` and `textQuote`
 * @param {string[]} bucketTexts normalized text of each bucket, in reading order
 * @returns {{sectionIndex: number, textOffset: number} | null}
 *   null when the quote cannot be located — the caller must fall back to `fraction`.
 */
export function rebucketAnchor(saved, bucketTexts) {
  const buckets = (bucketTexts || []).map(normalizeBodyText);
  if (!buckets.length) return null;

  const quote = normalizeBodyText(saved?.textQuote);
  const offset = Number(saved?.textOffset);

  /* A short quote matches everywhere; requiring a real probe is what keeps this from
     landing confidently in the wrong chapter. */
  const MIN_PROBE = 24;
  if (quote.length >= MIN_PROBE) {
    /* Where the quote sat in the whole body, rebuilt from the buckets. */
    let cursor = 0;
    const starts = [];
    for (const text of buckets) {
      starts.push(cursor);
      cursor += text.length + 1; // +1 for the space the join would collapse to
    }
    const body = buckets.join(' ');

    /* Prefer the occurrence nearest the saved offset: the same sentence can repeat in a
       book, and the stored offset is the only hint about which one was meant. */
    let best = -1;
    let bestDistance = Infinity;
    for (let at = body.indexOf(quote); at >= 0; at = body.indexOf(quote, at + 1)) {
      const distance = Number.isFinite(offset) ? Math.abs(at - offset) : 0;
      if (distance < bestDistance) {
        best = at;
        bestDistance = distance;
      }
    }
    if (best < 0) return null;

    /* Find the bucket containing that absolute character. */
    for (let i = buckets.length - 1; i >= 0; i -= 1) {
      if (best >= starts[i]) {
        return { sectionIndex: i, textOffset: best - starts[i] };
      }
    }
    return null;
  }

  /* No usable quote: honour the offset only when it still fits inside the first bucket,
     i.e. the reader never got past it and the old coordinate is still meaningful. */
  if (Number.isInteger(offset) && offset >= 0 && offset <= buckets[0].length) {
    return { sectionIndex: 0, textOffset: offset };
  }
  return null;
}
