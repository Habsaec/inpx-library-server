import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initDb,
  db,
  rebuildBooksFtsFromContentSync,
  setMeta,
  getBooksFtsStatus,
  invalidateBooksFtsHealthCache,
  isBooksFtsUsable
} from '../src/db.js';
import {
  createSortKey,
  searchBooks,
  buildSearchRecoveryHints,
  opdsSearchAuthors,
  listAuthors,
  enrichBookRow,
  findDidYouMeanSuggestions,
  rebuildTitleTokenDictionary,
  getBooksByFacetLight,
  resolveAuthorName,
  authorDisplayName,
  authorSearchName,
  authorSortKey
} from '../src/inpx.js';
import { buildSimilarBooks } from '../src/services/recommendations.js';
import { appendStemmedSearchTokens } from '../src/search-stem.js';

const BOOK_ID = 'peshkom-nad-oblakami';
const BOOK_ID_2 = 'peshkom-other-sadovnikov';
const TITLE = 'Пешком над облаками';
const AUTHORS = 'Садовников Георгий Михайлович';
const AUTHOR_NAME = 'садовников,георгий,михайлович';

before(() => {
  initDb();
  for (const id of [BOOK_ID, BOOK_ID_2]) {
    db.prepare('DELETE FROM book_authors WHERE book_id = ?').run(id);
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
  }
  const enriched = enrichBookRow({
    title: TITLE,
    authors: AUTHORS,
    genres: '',
    series: '',
    seriesNo: '',
    keywords: '',
    date: ''
  });
  const insertBook = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, ?, '', '', '', ?, ?,
      '', 0, ?, ?, '',
      '', '', 'x.fb2', 'a.zip', 1, ?, 0,
      'fb2', '', 'ru', '', 0, NULL
    )
  `);
  insertBook.run(
    BOOK_ID,
    TITLE,
    AUTHORS,
    enriched.titleSort,
    enriched.authorSort,
    enriched.titleSearch,
    enriched.authorsSearch,
    BOOK_ID,
  );
  const enriched2 = enrichBookRow({
    title: 'Другая книга Садовникова',
    authors: AUTHORS,
    genres: '',
    series: '',
    seriesNo: '',
    keywords: '',
    date: ''
  });
  insertBook.run(
    BOOK_ID_2,
    'Другая книга Садовникова',
    AUTHORS,
    enriched2.titleSort,
    enriched2.authorSort,
    enriched2.titleSearch,
    enriched2.authorsSearch,
    BOOK_ID_2,
  );
  db.prepare(`
    INSERT OR REPLACE INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES (?, ?, ?, ?, 2)
  `).run(
    AUTHOR_NAME,
    authorDisplayName(AUTHOR_NAME),
    createSortKey(authorSortKey(AUTHOR_NAME)),
    authorSearchName(AUTHOR_NAME)
  );
  const authorId = db.prepare('SELECT id FROM authors WHERE name = ?').get(AUTHOR_NAME)?.id;
  if (authorId) {
    db.prepare('INSERT OR IGNORE INTO book_authors (book_id, author_id) VALUES (?, ?)').run(BOOK_ID, authorId);
    db.prepare('INSERT OR IGNORE INTO book_authors (book_id, author_id) VALUES (?, ?)').run(BOOK_ID_2, authorId);
  }
  rebuildBooksFtsFromContentSync();
  setMeta('books_fts_dirty', '0');
  invalidateBooksFtsHealthCache();
  rebuildTitleTokenDictionary({ force: true });
});

test('exact multi-word title outranks a keyword-only hit', () => {
  const id = 'peshkom-keyword-distractor';
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  const enriched = enrichBookRow({
    title: 'Заметки читателя',
    authors: 'Другой Автор',
    genres: '',
    series: '',
    seriesNo: '',
    keywords: TITLE,
    date: ''
  });
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, ?, '', '', '', ?, ?,
      '', 0, ?, ?, '',
      '', ?, 'k.fb2', 'a.zip', 1, ?, 0,
      'fb2', '', 'ru', ?, 0, NULL
    )
  `).run(
    id,
    'Заметки читателя',
    'Другой Автор',
    enriched.titleSort,
    enriched.authorSort,
    enriched.titleSearch,
    enriched.authorsSearch,
    enriched.keywordsSearch,
    id,
    TITLE
  );
  rebuildBooksFtsFromContentSync();
  setMeta('books_fts_dirty', '0');
  invalidateBooksFtsHealthCache();
  try {
    const result = searchBooks({ query: TITLE, page: 1, pageSize: 24, field: 'all' });
    const ids = result.items.map((row) => row.id);
    assert.ok(ids.includes(id), 'keyword hit must still be recalled');
    assert.equal(ids[0], BOOK_ID, 'exact title must stay ahead of a keyword-only hit');
  } finally {
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    rebuildBooksFtsFromContentSync();
    setMeta('books_fts_dirty', '0');
    invalidateBooksFtsHealthCache();
  }
});

test('exact multi-word title is found via default search', () => {
  const result = searchBooks({ query: TITLE, page: 1, pageSize: 24, field: 'all' });
  const ids = result.items.map((row) => row.id);
  assert.ok(result.total > 0, `expected total > 0, got ${result.total}`);
  assert.ok(ids.includes(BOOK_ID), `expected ${BOOK_ID} in ${JSON.stringify(result.items.map((r) => r.title))}`);
  assert.equal(ids[0], BOOK_ID, 'exact title should rank first');
});

test('author + title query finds the book', () => {
  const result = searchBooks({ query: 'Садовников Пешком над облаками', page: 1, pageSize: 24, field: 'all' });
  assert.ok(result.items.some((row) => row.id === BOOK_ID), 'author+title split must find the book');
  assert.equal(result.items[0]?.id, BOOK_ID, 'author+title hit should rank first');
});

test('FTS MATCH finds multi-word Cyrillic title', () => {
  const tokens = createSortKey(TITLE).split(/\s+/).filter(Boolean);
  const match = tokens.map((t) => `"${t}"*`).join(' AND ');
  const rows = db.prepare('SELECT id, title_search FROM books_fts WHERE books_fts MATCH ?').all(match);
  assert.ok(rows.some((r) => r.id === BOOK_ID), `FTS miss for ${match}: ${JSON.stringify(rows)}`);
});

test('LIKE fallback finds multi-word title when FTS is dirty', () => {
  setMeta('books_fts_dirty', '1');
  invalidateBooksFtsHealthCache();
  try {
    assert.equal(isBooksFtsUsable(), false);
    const result = searchBooks({ query: TITLE, page: 1, pageSize: 24, field: 'all' });
    assert.ok(
      result.items.some((row) => row.id === BOOK_ID),
      'LIKE fallback must find multi-word title while FTS is unusable'
    );
  } finally {
    setMeta('books_fts_dirty', '0');
    invalidateBooksFtsHealthCache();
  }
});

test('healthy FTS miss does not fall through to a broad LIKE scan', () => {
  const id = 'healthy-fts-like-only-hit';
  const title = 'Альфабета Гаммадельта';
  const enriched = enrichBookRow({
    title,
    authors: 'Тестовый Автор',
    genres: '',
    series: '',
    seriesNo: '',
    keywords: '',
    date: ''
  });
  db.prepare('DELETE FROM books WHERE id = ?').run(id);
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, 'Тестовый Автор', '', '', '', ?, ?,
      '', 0, ?, ?, '',
      '', '', 'like-only.fb2', 'a.zip', 1, ?, 0,
      'fb2', '', 'ru', '', 0, NULL
    )
  `).run(
    id,
    title,
    enriched.titleSort,
    enriched.authorSort,
    enriched.titleSearch,
    enriched.authorsSearch,
    id
  );
  rebuildBooksFtsFromContentSync();
  setMeta('books_fts_dirty', '0');
  invalidateBooksFtsHealthCache();
  try {
    const defaultSearch = searchBooks({ query: 'бета дельта', page: 1, pageSize: 24, field: 'title' });
    assert.equal(defaultSearch.total, 0, 'healthy zero-MATCH must return immediately');

    const explicitContains = searchBooks({ query: '*бета дельта', page: 1, pageSize: 24, field: 'title' });
    assert.ok(
      explicitContains.items.some((row) => row.id === id),
      'explicit * search must retain the contains/LIKE behaviour'
    );
  } finally {
    db.prepare('DELETE FROM books WHERE id = ?').run(id);
    rebuildBooksFtsFromContentSync();
    setMeta('books_fts_dirty', '0');
    invalidateBooksFtsHealthCache();
  }
});

test('single-token prefix still finds the title', () => {
  const prefix = searchBooks({ query: 'пешком', page: 1, pageSize: 24, field: 'title' });
  assert.ok(prefix.items.some((row) => row.id === BOOK_ID), 'single prefix token must match');
});

test('stemmed inflection finds title via FTS expand', () => {
  const result = searchBooks({ query: 'облаками', page: 1, pageSize: 24, field: 'title' });
  assert.ok(result.items.some((row) => row.id === BOOK_ID), 'inflected title token must match via stem expand');
});

test('index-time stems are stored on title_search', () => {
  const row = db.prepare('SELECT title_search AS t FROM books WHERE id = ?').get(BOOK_ID);
  assert.ok(String(row.t).includes('облак'), `expected stem in title_search, got ${row.t}`);
  assert.ok(appendStemmedSearchTokens(createSortKey(TITLE)).includes('облак'));
});

test('FTS health reports ok after rebuild', () => {
  invalidateBooksFtsHealthCache();
  const status = getBooksFtsStatus({ force: true, recover: false });
  assert.equal(status.status, 'ok');
  assert.ok(status.ftsDocCount >= 1);
  assert.ok(isBooksFtsUsable());
});

test('FTS dirty flag marks index unusable for rebuild path', () => {
  setMeta('books_fts_dirty', '1');
  invalidateBooksFtsHealthCache();
  try {
    const status = getBooksFtsStatus({ force: true, recover: false });
    assert.equal(status.status, 'dirty');
    assert.equal(isBooksFtsUsable(), false);
  } finally {
    setMeta('books_fts_dirty', '0');
    invalidateBooksFtsHealthCache();
  }
});

test('did-you-mean can suggest title tokens', () => {
  const hints = findDidYouMeanSuggestions('облакаии', 5);
  assert.ok(
    hints.some((h) => h.type === 'title' && /облак/i.test(h.label)),
    `expected title hint, got ${JSON.stringify(hints)}`
  );
});

test('recovery hints tip try_authors when authors exist', () => {
  db.prepare(`
    INSERT OR REPLACE INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES ('uniqueauthorxyz', 'Unique Author XYZ', 'uniqueauthorxyz', 'uniqueauthorxyz', 1)
  `).run();
  const hints = buildSearchRecoveryHints({ query: 'uniqueauthorxyz', field: 'books' });
  assert.equal(hints.tip, 'try_authors');
  assert.ok(hints.alternateModes.some((m) => m.field === 'authors'));
});

test('opdsSearchAuthors matches listAuthors', () => {
  const listed = listAuthors({ query: 'Садовников', page: 1, pageSize: 10, sort: 'count' });
  const opds = opdsSearchAuthors('Садовников', { page: 1, pageSize: 10 });
  assert.equal(opds.total, listed.total);
  assert.deepEqual(
    opds.items.map((r) => r.name).sort(),
    listed.items.map((r) => r.name).sort()
  );
});

test('similar books resolves display author to catalog name', () => {
  assert.equal(resolveAuthorName(AUTHORS), AUTHOR_NAME);
  const byDisplay = getBooksByFacetLight('authors', AUTHORS, 8, 'recent');
  assert.ok(byDisplay.some((row) => row.id === BOOK_ID_2), 'facet light must find other books via display author');
  const similar = buildSimilarBooks({
    id: BOOK_ID,
    authors: AUTHORS,
    series: '',
    seriesList: [],
    genres: ''
  });
  assert.ok(similar.items.some((row) => row.id === BOOK_ID_2), 'Другие книги автора must list sibling books');
  assert.ok(!similar.items.some((row) => row.id === BOOK_ID), 'current book must be excluded');
});
