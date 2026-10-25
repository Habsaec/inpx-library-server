import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initDb, createUser, db, rebuildActiveBooksView, getSetting, setSetting, setMeta,
  catalogLangCountsReady, adjustCatalogCountsForBook
} from '../src/db.js';
import { searchCatalog, getAuthorBooksGrouped, listAuthors, listSeries, listGenres } from '../src/inpx.js';
import {
  getUserContentLangs,
  setUserContentLangs,
  languageFilterClause,
  mergeContentLangFilter,
  normalizeContentLangList,
  contentLangCacheKey,
  listEnabledContentLangs,
  clearEnabledContentLangCache,
  effectiveContentLangs,
  resolveContentLangFilter
} from '../src/user-content-langs.js';
import { renderBookGrid, renderBookFlibustaList } from '../src/templates/shared.js';
import { renderFacetBooks } from '../src/templates/library.js';

const USER = 'content-langs-user';

test('normalizeContentLangList keeps valid codes only', () => {
  assert.deepEqual(normalizeContentLangList('RU, en, ru, 1, toolongcode'), ['ru', 'en']);
  assert.deepEqual(normalizeContentLangList(['ru', 'RU', 'de']), ['ru', 'de']);
  assert.equal(contentLangCacheKey(['EN', 'ru']), 'en,ru');
});

test('mergeContentLangFilter intersects the page language with the saved set', () => {
  assert.deepEqual(mergeContentLangFilter([], 'en'), { lang: 'en', langs: [] });
  assert.deepEqual(mergeContentLangFilter(['ru'], ''), { lang: 'ru', langs: [] });
  assert.deepEqual(mergeContentLangFilter(['ru', 'en'], ''), { lang: '', langs: ['ru', 'en'] });
  assert.deepEqual(mergeContentLangFilter(['ru', 'en'], 'en'), { lang: 'en', langs: [] });
  assert.deepEqual(mergeContentLangFilter(['ru'], 'en'), { lang: '', langs: ['__none__'] });
});

test('languageFilterClause builds SQL and matches nothing outside the saved set', () => {
  assert.equal(languageFilterClause('b.lang', '', []), null);
  assert.deepEqual(languageFilterClause('b.lang', 'ru', []), { where: 'b.lang = ?', params: ['ru'] });
  assert.deepEqual(languageFilterClause('b.lang', '', ['ru', 'en']), {
    where: 'b.lang IN (?,?)',
    params: ['ru', 'en']
  });
  assert.deepEqual(languageFilterClause('b.lang', '', ['__none__']), { where: '0', params: [] });
  assert.deepEqual(languageFilterClause('b.lang', 'de', ['ru']), { where: '0', params: [] });
});

test('content language preference is stored per user', () => {
  initDb();
  try { createUser({ username: USER, password: 'Contentlang1' }); } catch { /* already created */ }
  setUserContentLangs(USER, ['EN', 'ru', 'x']);
  assert.deepEqual(getUserContentLangs(USER), ['en', 'ru']);
  setUserContentLangs(USER, []);
  assert.deepEqual(getUserContentLangs(USER), []);
});

test('saved languages narrow catalog search and an author book list', async () => {
  initDb();
  const title = 'contentlangprefbook';
  db.prepare('DELETE FROM books WHERE id IN (?, ?)').run('pref-ru', 'pref-en');
  db.prepare(`
    INSERT INTO sources (id, name, type, path, enabled)
    VALUES (91, 'content-lang-src', 'folder', '/', 1)
  `).run();
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, ?, 'Pref Author', '', '', '',
      ?, 'pref author',
      '', 0, ?, 'pref author', '',
      '', '', ?, 'a.zip', 1, ?, 0,
      'fb2', '', ?, '', 0, 91
    )
  `);
  insert.run('pref-ru', title, title, title, 'pref-ru.fb2', 'pref-ru', 'ru');
  insert.run('pref-en', title, title, title, 'pref-en.fb2', 'pref-en', 'en');
  db.prepare(`
    INSERT INTO authors (name, display_name, sort_name, search_name, book_count)
    VALUES ('pref,author', 'Pref Author', 'pref author', 'pref author', 2)
  `).run();
  const authorId = db.prepare('SELECT id FROM authors WHERE name = ?').get('pref,author').id;
  const link = db.prepare('INSERT INTO book_authors (book_id, author_id) VALUES (?, ?)');
  link.run('pref-ru', authorId);
  link.run('pref-en', authorId);
  db.prepare(`
    INSERT INTO series_catalog (name, display_name, sort_name, search_name, book_count)
    VALUES ('contentlang series', 'Contentlang Series', 'contentlang series', 'contentlang series', 2)
  `).run();
  const seriesId = db.prepare('SELECT id FROM series_catalog WHERE name = ?').get('contentlang series').id;
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run('pref-ru', seriesId, '1');
  db.prepare('INSERT INTO book_series (book_id, series_id, series_no) VALUES (?, ?, ?)').run('pref-en', seriesId, '2');
  db.prepare(`
    INSERT INTO genres_catalog (name, display_name, sort_name, search_name, book_count)
    VALUES ('contentlanggenre', 'Contentlang Genre', 'contentlanggenre', 'contentlanggenre', 2)
  `).run();
  const genreId = db.prepare('SELECT id FROM genres_catalog WHERE name = ?').get('contentlanggenre').id;
  db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run('pref-ru', genreId);
  db.prepare('INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?)').run('pref-en', genreId);
  await rebuildActiveBooksView();

  const all = searchCatalog({ query: title, field: 'books', page: 1, pageSize: 24 });
  assert.equal(all.total, 2);
  const russian = searchCatalog({ query: title, field: 'books', page: 1, pageSize: 24, langs: ['ru'] });
  assert.deepEqual(russian.items.map((book) => book.id), ['pref-ru']);
  const blocked = searchCatalog({ query: title, field: 'books', page: 1, pageSize: 24, langs: ['__none__'] });
  assert.equal(blocked.total, 0);

  const grouped = getAuthorBooksGrouped('pref,author', 'title', '', { langs: ['ru'] });
  const ids = [
    ...grouped.standaloneBooks.map((book) => book.id),
    ...grouped.series.flatMap((series) => series.books.map((book) => book.id))
  ];
  assert.deepEqual(ids, ['pref-ru']);

  const enAuthors = listAuthors({ page: 1, pageSize: 50, sort: 'count', langs: ['en'] });
  assert.equal(enAuthors.items.find((row) => row.name === 'pref,author')?.bookCount, 1);
  const enSearch = listAuthors({ query: 'pref author', page: 1, pageSize: 10, sort: 'count', langs: ['en'] });
  assert.equal(enSearch.items.find((row) => row.name === 'pref,author')?.bookCount, 1);
  const deSearch = listAuthors({ query: 'pref author', page: 1, pageSize: 10, sort: 'count', langs: ['de'] });
  assert.equal(deSearch.total, 0);
  assert.equal(deSearch.items.find((row) => row.name === 'pref,author'), undefined);
  const deAuthors = listAuthors({ page: 1, pageSize: 50, sort: 'count', langs: ['de'] });
  assert.equal(deAuthors.items.find((row) => row.name === 'pref,author'), undefined);
  const enSeries = listSeries({ page: 1, pageSize: 50, sort: 'count', langs: ['en'] });
  assert.equal(enSeries.items.find((row) => row.name === 'contentlang series')?.bookCount, 1);
  const deSeries = listSeries({ page: 1, pageSize: 50, sort: 'count', langs: ['de'] });
  assert.equal(deSeries.items.find((row) => row.name === 'contentlang series'), undefined);
  const enGenres = listGenres({ page: 1, pageSize: 50, sort: 'count', langs: ['en'] });
  assert.equal(enGenres.items.find((row) => row.name === 'contentlanggenre')?.bookCount, 1);
  const deGenres = listGenres({ page: 1, pageSize: 50, sort: 'count', langs: ['de'] });
  assert.equal(deGenres.items.find((row) => row.name === 'contentlanggenre'), undefined);
});

test('precomputed language counts match counting the books and follow single-book changes', () => {
  assert.equal(catalogLangCountsReady(), true, 'the counts worker fills catalog_lang_counts');
  const lists = () => ['ru', 'en', 'de'].flatMap((lang) => [
    listAuthors({ page: 1, pageSize: 50, sort: 'count', langs: [lang] }),
    listAuthors({ page: 1, pageSize: 50, sort: 'name', letter: 'p', langs: [lang] }),
    listSeries({ page: 1, pageSize: 50, sort: 'name', langs: [lang] }),
    listGenres({ page: 1, pageSize: 50, sort: 'count', langs: [lang] }),
    listAuthors({ query: 'pref author', page: 1, pageSize: 10, sort: 'count', langs: [lang] })
  ]);
  const precomputed = lists();
  setMeta('catalog_lang_counts_ready', '0');
  try {
    assert.deepEqual(precomputed, lists());
  } finally {
    setMeta('catalog_lang_counts_ready', '1');
  }

  const enCount = () => listAuthors({ page: 1, pageSize: 50, sort: 'count', langs: ['en'] })
    .items.find((row) => row.name === 'pref,author')?.bookCount;
  adjustCatalogCountsForBook('pref-en', -1);
  assert.equal(enCount(), undefined);
  adjustCatalogCountsForBook('pref-en', 1);
  assert.equal(enCount(), 1);
});

test('book cards and list rows show the language code', () => {
  const book = {
    id: '1:1',
    title: 'Книга',
    authors: 'Автор',
    ext: 'fb2',
    lang: 'ru',
    genres: ''
  };
  const grid = renderBookGrid([book]);
  const list = renderBookFlibustaList([book]);
  assert.match(grid, /class="book-lang-badge"/);
  assert.match(grid, />RU</);
  assert.match(list, /class="book-lang-badge"/);
  assert.match(list, />RU</);
  const unknown = renderBookGrid([{ ...book, id: '1:2', lang: '' }]);
  assert.doesNotMatch(unknown, /book-lang-badge/);
});

test('profile language choices follow the languages the admin left enabled', () => {
  initDb();
  const prev = getSetting('excluded_languages') || '';
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, 'enabled lang', '', '', '', '', 'enabled lang', '',
      '', 0, 'enabled lang', '', '',
      '', '', ?, 'a.zip', 1, ?, ?,
      'fb2', '', ?, '', 0, NULL
    )
  `);
  insert.run('enabled-ru', 'enabled-ru.fb2', 'enabled-ru', 0, 'zz');
  insert.run('enabled-hidden', 'enabled-hidden.fb2', 'enabled-hidden', 0, 'qq');
  insert.run('enabled-deleted', 'enabled-deleted.fb2', 'enabled-deleted', 1, 'ghost');
  setSetting('excluded_languages', prev ? `${prev},qq` : 'qq');
  clearEnabledContentLangCache();
  try {
    const langs = listEnabledContentLangs();
    assert.ok(langs.includes('zz'));
    assert.ok(!langs.includes('qq'));
    assert.ok(!langs.includes('ghost'));
  } finally {
    setSetting('excluded_languages', prev);
    db.prepare('DELETE FROM books WHERE id IN (?, ?, ?)').run('enabled-ru', 'enabled-hidden', 'enabled-deleted');
    clearEnabledContentLangCache();
  }
});

test('a language spelled in another case stays enabled and filterable', () => {
  initDb();
  const prev = getSetting('excluded_languages') || '';
  const insert = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      ?, 'case lang', '', '', '', '', 'case lang', '',
      '', 0, 'case lang', '', '',
      '', '', ?, 'a.zip', 1, ?, 0,
      'fb2', '', ?, '', 0, NULL
    )
  `);
  insert.run('case-lower', 'case-lower.fb2', 'case-lower', 'yy');
  insert.run('case-upper', 'case-upper.fb2', 'case-upper', 'YY');
  try {
    setSetting('excluded_languages', prev ? `${prev},YY` : 'YY');
    clearEnabledContentLangCache();
    assert.ok(listEnabledContentLangs().includes('yy'));
    assert.deepEqual(languageFilterClause('b.lang', 'yy', []), { where: 'b.lang = ?', params: ['yy'] });

    setSetting('excluded_languages', prev);
    clearEnabledContentLangCache();
    assert.deepEqual(languageFilterClause('b.lang', 'yy', []), { where: 'b.lang IN (?,?)', params: ['yy', 'YY'] });
  } finally {
    setSetting('excluded_languages', prev);
    db.prepare('DELETE FROM books WHERE id IN (?, ?)').run('case-lower', 'case-upper');
    clearEnabledContentLangCache();
  }
});

test('series and genre pages offer a book language picker', () => {
  const html = renderFacetBooks({
    title: 'Серия', items: [], total: 0, page: 1, pageSize: 24, user: null, stats: {},
    facetPath: '/facet/series/x', indexStatus: null, sort: 'series', breadcrumbs: [{}, { href: '/series' }],
    facet: 'series', facetValue: 'x', lang: 'ru', langs: ['en', 'ru']
  });
  assert.match(html, /class="search-form sort-control lang-filter-control"/);
  assert.match(html, /<option value="ru" selected>RU<\/option>/);
  assert.match(html, /<option value="en">EN<\/option>/);
  const single = renderFacetBooks({
    title: 'Серия', items: [], total: 0, page: 1, pageSize: 24, user: null, stats: {},
    facetPath: '/facet/series/x', indexStatus: null, sort: 'series', breadcrumbs: [{}, { href: '/series' }],
    facet: 'series', facetValue: 'x', langs: ['ru']
  });
  assert.doesNotMatch(single, /lang-filter-control/);
});

test('a personal language the admin turned off does not hide books', () => {
  initDb();
  const prev = getSetting('excluded_languages') || '';
  try { createUser({ username: 'langoffuser', password: 'Langoffusr1' }); } catch { /* already created */ }
  db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      'enabled-qq', 'enabled qq', '', '', '', '', 'enabled qq', '',
      '', 0, 'enabled qq', '', '',
      '', '', 'enabled-qq.fb2', 'a.zip', 1, 'enabled-qq', 0,
      'fb2', '', 'qq', '', 0, NULL
    )
  `).run();
  setUserContentLangs('langoffuser', ['qq']);
  setSetting('excluded_languages', prev);
  clearEnabledContentLangCache();
  try {
    assert.deepEqual(effectiveContentLangs('langoffuser'), ['qq']);
    setSetting('excluded_languages', prev ? `${prev},qq` : 'qq');
    assert.deepEqual(effectiveContentLangs('langoffuser'), []);
    assert.deepEqual(resolveContentLangFilter('langoffuser', ''), { lang: '', langs: [] });
  } finally {
    setSetting('excluded_languages', prev);
    db.prepare('DELETE FROM books WHERE id = ?').run('enabled-qq');
    clearEnabledContentLangCache();
  }
});
