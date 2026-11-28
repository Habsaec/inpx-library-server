/**
 * One huge Foliate document made the paginator lay out the whole book before the
 * first page: a 3.3 MB novel needed ~43 s. The body is now split into buckets of
 * whole top-level blocks, so the reader renders one bucket at a time.
 *
 * These tests import the real rule from `public/foliate/fb2-sections.js` — the same
 * module `fb2.js` uses. A copy of the rule here would pass while production drifted
 * (#40 review), so `bucketizeBlocks` is the single source of truth and this file
 * only supplies the DOM stand-in and the assertions.
 *
 * What must hold, and why:
 *  - a small body stays one bucket (no regression for most books);
 *  - a big body splits into buckets under the limit (the point: start reading fast);
 *  - splitting keeps every block once, in order, with identical markup — the section
 *    text is unchanged, so saved positions and KOReader anchors stay valid
 *    (`src/kosync-position.js` scans that same text);
 *  - a chapter bigger than the limit lands in its own bucket rather than being cut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bucketizeBlocks, blockBytes, STITCH_MAX_BYTES } from '../public/foliate/fb2-sections.js';

const LIMIT = STITCH_MAX_BYTES;

/** Minimal element stand-in with the properties the rule touches. */
function makeEl(label, bytes) {
  const node = {
    label,
    localName: 'section',
    children: [],
    classList: { contains: () => false, add() {} },
    outerHTML: `<section>${'x'.repeat(Math.max(0, bytes - 17))}</section>`,
    querySelectorAll: () => [],
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    ownerDocument: null,
  };
  node.ownerDocument = { createElement: () => makeEl('wrapper', 0) };
  return node;
}

const allBlocks = (buckets) => buckets.flat();

test('a small body stays a single bucket', () => {
  const els = [makeEl('a', 1000), makeEl('b', 1000), makeEl('c', 1000)];
  const buckets = bucketizeBlocks(els);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].length, 3);
});

test('an empty body yields no buckets', () => {
  assert.deepEqual(bucketizeBlocks([]), []);
  assert.deepEqual(bucketizeBlocks([null]), []);
});

test('a large body is split into size-bounded buckets', () => {
  const els = [];
  for (let i = 0; i < 12; i += 1) els.push(makeEl(`ch${i}`, 100 * 1024));
  const buckets = bucketizeBlocks(els);
  assert.ok(buckets.length > 1, 'large body must not stay one section');
  for (const bucket of buckets) {
    const bytes = bucket.reduce((sum, el) => sum + blockBytes(el), 0);
    /* A bucket may exceed the limit only when it holds a single oversized block. */
    assert.ok(bytes <= LIMIT || bucket.length === 1,
      `bucket of ${bucket.length} blocks took ${bytes} bytes`);
  }
});

test('every block lands in exactly one bucket and order is kept', () => {
  const els = [];
  for (let i = 0; i < 20; i += 1) els.push(makeEl(`ch${i}`, 60 * 1024));
  const flat = allBlocks(bucketizeBlocks(els));
  assert.equal(flat.length, els.length);
  assert.deepEqual(flat.map((e) => e.label), els.map((e) => e.label));
});

test('splitting leaves the markup identical, so the section text is unchanged', () => {
  // The property that keeps positions valid: no block is rewritten, added or
  // dropped, so the concatenated markup — and the text Foliate derives from it —
  // is byte-identical to the unsplit body.
  const els = [];
  for (let i = 0; i < 9; i += 1) els.push(makeEl(`ch${i}`, 90 * 1024));
  const before = els.map((el) => el.outerHTML).join('');
  const after = allBlocks(bucketizeBlocks(els)).map((el) => el.outerHTML).join('');
  assert.equal(after, before);
});

test('a chapter larger than the limit is not broken across buckets', () => {
  const huge = makeEl('huge', LIMIT * 3);
  const small = makeEl('small', 10 * 1024);
  const buckets = bucketizeBlocks([huge, small]);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].length, 1);
  assert.equal(buckets[0][0].label, 'huge');
  assert.equal(buckets[1][0].label, 'small');
  assert.equal(blockBytes(buckets[0][0]), huge.outerHTML.length, 'the oversized chapter is intact');
});
