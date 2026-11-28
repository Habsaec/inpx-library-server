/**
 * Per-book pagination cache: section index → screens measured by the paginator.
 *
 * The copy of this logic inside `public/reader.js` carried two defects (issue #38):
 *  - the layout key did not name the book, so opening another book with the same layout could
 *    reuse the previous book's screen counts — and `remember()` keeps the MAXIMUM, so a too-large
 *    value from another book would never correct itself;
 *  - every open cleared the cache twice, so a 3000-page book was re-paginated on each open even
 *    though nothing about the layout had changed.
 *
 * Keeping the decision in a pure module makes both testable without a browser.
 */

/** Everything the paginator's result depends on — the book included. */
export function paginationLayoutKey({ bookId, settings = {}, layoutMode = '', width = 0, height = 0 }) {
  return [
    bookId,
    settings.font,
    settings.fontSize,
    settings.fontWeight,
    settings.lineHeight,
    settings.maxWidth,
    settings.maxBlockSize,
    settings.pageMargin,
    settings.verticalMargin,
    settings.columnGap,
    layoutMode,
    width,
    height
  ].join('|');
}

export function createSectionPaginationCache() {
  const pages = new Map();
  let key = '';
  return {
    /** Drops everything, key included: used when the reader throws the current book away. */
    clear() {
      pages.clear();
      key = '';
    },
    /**
     * Drops the cache only when the book or the layout changed. This is what a reopen of the same
     * book must NOT do.
     */
    sync(nextKey) {
      if (nextKey !== key) {
        pages.clear();
        key = nextKey;
      }
    },
    has(index) {
      return pages.has(index);
    },
    get(index) {
      return pages.get(index);
    },
    /** The paginator reports a section again: keep the largest count seen, so a partially
     *  measured book only grows. */
    remember(index, count) {
      const prev = pages.get(index) ?? 0;
      pages.set(index, Math.max(prev, count));
      return pages.get(index);
    },
    entries() {
      return pages.entries();
    },
    get size() {
      return pages.size;
    }
  };
}
