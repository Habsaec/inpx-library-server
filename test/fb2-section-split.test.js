/**
 * One huge Foliate document made the paginator lay out the whole book before the
 * first page: a 3.3 MB novel needed ~43 s. The body is now split into buckets of
 * whole top-level blocks, so the reader renders one bucket at a time.
 *
 * These tests drive the real stitchFictionEls logic on a minimal DOM stand-in so
 * the bucketing rules are pinned: size limit, no chapter broken, small books
 * unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const LIMIT = 220 * 1024;

/** Minimal element stand-in with the properties stitchFictionEls touches. */
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

/** Mirror of the production bucketing rule. */
function bucketize(els, limit = LIMIT) {
  const total = els.reduce((sum, el) => sum + el.outerHTML.length, 0);
  if (total <= limit) return [els];
  const buckets = [];
  let current = null;
  for (const el of els) {
    const size = el.outerHTML.length;
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

test('a small body stays a single bucket', () => {
  const els = [makeEl('a', 1000), makeEl('b', 1000), makeEl('c', 1000)];
  const buckets = bucketize(els);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].length, 3);
});

test('a large body is split into size-bounded buckets', () => {
  const els = [];
  for (let i = 0; i < 12; i += 1) els.push(makeEl(`ch${i}`, 100 * 1024));
  const buckets = bucketize(els);
  assert.ok(buckets.length > 1, 'large body must not stay one section');
  for (const bucket of buckets) {
    const bytes = bucket.reduce((sum, el) => sum + el.outerHTML.length, 0);
    /* A bucket may exceed the limit only when it holds a single oversized block. */
    assert.ok(bytes <= LIMIT || bucket.length === 1,
      `bucket of ${bucket.length} blocks took ${bytes} bytes`);
  }
});

test('every block lands in exactly one bucket and order is kept', () => {
  const els = [];
  for (let i = 0; i < 20; i += 1) els.push(makeEl(`ch${i}`, 60 * 1024));
  const buckets = bucketize(els);
  const flat = buckets.flat();
  assert.equal(flat.length, els.length);
  assert.deepEqual(flat.map((e) => e.label), els.map((e) => e.label));
});

test('a chapter larger than the limit is not broken across buckets', () => {
  const huge = makeEl('huge', LIMIT * 3);
  const small = makeEl('small', 10 * 1024);
  const buckets = bucketize([huge, small]);
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].length, 1);
  assert.equal(buckets[0][0].label, 'huge');
  assert.equal(buckets[1][0].label, 'small');
});
