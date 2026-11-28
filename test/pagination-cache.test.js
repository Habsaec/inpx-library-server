/**
 * Pins the pagination cache rules (issue #38).
 *
 * The bugs this must keep out: a cache shared between books (the key had no book id, and the
 * counts are kept with Math.max, so a too-large value never corrected itself), and a cache
 * dropped on every open, which re-paginated a 3000-page book each time it was opened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSectionPaginationCache, paginationLayoutKey } from '../public/reader-shared/pagination-cache.js';

const settings = {
  font: 'serif', fontSize: 18, fontWeight: 400, lineHeight: 1.6,
  maxWidth: 99999, maxBlockSize: 1440, pageMargin: 32, verticalMargin: 32, columnGap: 7
};
const base = { bookId: '3:133576', settings, layoutMode: 'paginated', width: 1180, height: 820 };

test('the layout key names the book', () => {
  assert.notEqual(
    paginationLayoutKey(base),
    paginationLayoutKey({ ...base, bookId: '3:133577' }),
    'two books must not share a pagination key'
  );
});

test('the layout key follows every setting the paginator depends on', () => {
  const key = paginationLayoutKey(base);
  assert.equal(paginationLayoutKey({ ...base }), key, 'the same input gives the same key');
  for (const [name, value] of Object.entries({
    font: 'sans', fontSize: 22, lineHeight: 2, pageMargin: 8, maxWidth: 720, columnGap: 0
  })) {
    assert.notEqual(
      paginationLayoutKey({ ...base, settings: { ...settings, [name]: value } }),
      key,
      `${name} must invalidate the cache`
    );
  }
  assert.notEqual(paginationLayoutKey({ ...base, layoutMode: 'scrolled' }), key, 'layout mode');
  assert.notEqual(paginationLayoutKey({ ...base, width: 900 }), key, 'window width');
  assert.notEqual(paginationLayoutKey({ ...base, height: 600 }), key, 'window height');
});

test('reopening the same book keeps its page counts', () => {
  const cache = createSectionPaginationCache();
  const key = paginationLayoutKey(base);
  cache.sync(key);
  cache.remember(2, 12);
  cache.remember(3, 4);
  assert.equal(cache.size, 2);

  cache.sync(paginationLayoutKey({ ...base })); // second open, nothing changed
  assert.equal(cache.get(2), 12, 'a reopen must not re-paginate');
  assert.equal(cache.get(3), 4);
});

test('another book or another layout drops everything', () => {
  const cache = createSectionPaginationCache();
  cache.sync(paginationLayoutKey(base));
  cache.remember(2, 12);

  cache.sync(paginationLayoutKey({ ...base, bookId: 'other:1' }));
  assert.equal(cache.size, 0, 'a different book starts clean');
  assert.equal(cache.get(2), undefined);

  cache.sync(paginationLayoutKey(base));
  cache.remember(2, 12);
  cache.sync(paginationLayoutKey({ ...base, settings: { ...settings, fontSize: 24 } }));
  assert.equal(cache.size, 0, 'a layout change starts clean');
});

test('a section keeps the largest count seen', () => {
  const cache = createSectionPaginationCache();
  cache.sync(paginationLayoutKey(base));
  assert.equal(cache.remember(1, 10), 10);
  assert.equal(cache.remember(1, 7), 10, 'a smaller later report does not shrink it');
  assert.equal(cache.remember(1, 13), 13, 'a larger one wins');
});

test('clear() empties the cache and forgets the key', () => {
  const cache = createSectionPaginationCache();
  const key = paginationLayoutKey(base);
  cache.sync(key);
  cache.remember(1, 5);
  cache.clear();
  assert.equal(cache.size, 0);
  cache.sync(key);
  assert.equal(cache.size, 0, 'the same key after clear() must not resurrect old counts');
});
