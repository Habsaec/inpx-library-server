/**
 * Saved-position contract across the bucket split (#40 review).
 *
 * Before this change the whole FB2 body was reader section 0, so `textOffset` was an
 * offset into the entire book text. After the split section 0 is only the first bucket.
 * These tests pin the translation, including the case that matters most: a position
 * saved deep in a big book must land on the same text, not at the start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { needsRebucket, rebucketAnchor, normalizeBodyText } from '../public/reader-shared/fb2-rebucket.js';

/** Build bucket texts of `size` characters each, numbered so offsets are checkable. */
function makeBuckets(count, size) {
  const buckets = [];
  let n = 0;
  for (let b = 0; b < count; b += 1) {
    let text = '';
    while (text.length < size) {
      text += `слово${n} `;
      n += 1;
    }
    buckets.push(text.trim());
  }
  return buckets;
}

test('a small book needs no re-anchoring: one bucket keeps index 0', () => {
  assert.equal(needsRebucket({ sectionIndex: 0, textOffset: 100 }, 1), false);
});

test('a position already in a later bucket is left alone', () => {
  assert.equal(needsRebucket({ sectionIndex: 2, textOffset: 100 }, 5), false);
});

test('section 0 of a multi-section book is re-anchored', () => {
  assert.equal(needsRebucket({ sectionIndex: 0, textOffset: 100 }, 5), true);
});

test('a position deep in the book lands on the same text, not at the start', () => {
  const buckets = makeBuckets(4, 500);
  const body = buckets.join(' ');
  // Pretend the reader saved a spot ~60% into the whole body, back when it was one section.
  const absolute = Math.floor(body.length * 0.6);
  const quote = body.slice(absolute, absolute + 60);
  const saved = { sectionIndex: 0, textOffset: absolute, textQuote: quote };

  const moved = rebucketAnchor(saved, buckets);
  assert.ok(moved, 'the quote must be locatable');
  assert.ok(moved.sectionIndex > 0, `expected a later bucket, got ${moved.sectionIndex}`);

  // The text at the new coordinate is the same text the reader saw.
  const landed = buckets[moved.sectionIndex].slice(moved.textOffset, moved.textOffset + quote.length);
  assert.equal(landed, quote);
});

test('a start-of-book position stays in the first bucket', () => {
  const buckets = makeBuckets(3, 400);
  const quote = buckets[0].slice(0, 60);
  const moved = rebucketAnchor({ sectionIndex: 0, textOffset: 0, textQuote: quote }, buckets);
  assert.equal(moved.sectionIndex, 0);
  assert.equal(buckets[0].slice(moved.textOffset, moved.textOffset + quote.length), quote);
});

test('a repeated sentence resolves to the occurrence nearest the saved offset', () => {
  const line = 'это повторяющаяся фраза, которая встречается дважды в тексте книги';
  const buckets = [
    `${line} ${'a'.repeat(400)}`,
    `${'b'.repeat(400)} ${line} ${'c'.repeat(200)}`,
  ];
  const body = buckets.join(' ');
  const second = body.indexOf(line, body.indexOf(line) + 1);
  const moved = rebucketAnchor({ sectionIndex: 0, textOffset: second, textQuote: line }, buckets);
  assert.equal(moved.sectionIndex, 1, 'must pick the second occurrence, matching the offset');
});

test('without a usable quote the old offset is kept only when it still fits bucket 0', () => {
  const buckets = makeBuckets(3, 300);
  const inside = rebucketAnchor({ sectionIndex: 0, textOffset: 50, textQuote: '' }, buckets);
  assert.deepEqual(inside, { sectionIndex: 0, textOffset: 50 });

  const past = rebucketAnchor({ sectionIndex: 0, textOffset: 100000, textQuote: '' }, buckets);
  assert.equal(past, null, 'out of range must fall back to fraction, not guess');
});

test('an unlocatable quote returns null so the caller falls back to fraction', () => {
  const buckets = makeBuckets(2, 300);
  const moved = rebucketAnchor(
    { sectionIndex: 0, textOffset: 100, textQuote: 'этой фразы в книге нет нигде вообще' },
    buckets,
  );
  assert.equal(moved, null);
});

test('normalization matches the reader: whitespace runs collapse, edges trim', () => {
  assert.equal(normalizeBodyText('  a\n\n\tb   c  '), 'a b c');
  assert.equal(normalizeBodyText(null), '');
});
