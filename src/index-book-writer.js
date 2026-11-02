/**
 * Запись строк книг и их связей (авторы / серии / жанры) для индексаторов папок и Calibre.
 * Подготовленные выражения создаются один раз на проход; id каталогов кэшируются в Map прохода.
 */
import { db } from './db.js';
import {
  splitAuthorValues, splitFacetValues,
  authorDisplayName, authorSortKey, authorSearchName,
  seriesDisplayName, seriesSortName, seriesSearchName,
  genreDisplayName, genreSortName, genreSearchName,
  createSortKey
} from './inpx.js';

export function prepareBookCatalogWriter() {
  const insertAuthor = db.prepare(`
    INSERT INTO authors(name, display_name, sort_name, search_name)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET display_name = excluded.display_name, sort_name = excluded.sort_name, search_name = excluded.search_name
  `);
  const insertSeries = db.prepare(`
    INSERT INTO series_catalog(name, display_name, sort_name, search_name)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET display_name = excluded.display_name, sort_name = excluded.sort_name, search_name = excluded.search_name
  `);
  const insertGenre = db.prepare(`
    INSERT INTO genres_catalog(name, display_name, sort_name, search_name)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET display_name = excluded.display_name, sort_name = excluded.sort_name, search_name = excluded.search_name
  `);
  const selectAuthor = db.prepare('SELECT id FROM authors WHERE name = ?');
  const selectSeries = db.prepare('SELECT id FROM series_catalog WHERE name = ?');
  const selectGenre = db.prepare('SELECT id FROM genres_catalog WHERE name = ?');
  const authorIdCache = new Map();
  const seriesIdCache = new Map();
  const genreIdCache = new Map();
  const linkAuthor = db.prepare('INSERT OR IGNORE INTO book_authors(book_id, author_id) VALUES(?, ?)');
  const linkSeries = db.prepare('INSERT OR IGNORE INTO book_series(book_id, series_id, series_no) VALUES(?, ?, ?)');
  const linkGenre = db.prepare('INSERT OR IGNORE INTO book_genres(book_id, genre_id) VALUES(?, ?)');
  const unlinkAuthors = db.prepare('DELETE FROM book_authors WHERE book_id = ?');
  const unlinkSeries = db.prepare('DELETE FROM book_series WHERE book_id = ?');
  const unlinkGenres = db.prepare('DELETE FROM book_genres WHERE book_id = ?');
  const insertBook = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, lib_rate, source_id
    ) VALUES (
      @id, @title, @authors, @genres, @series, @seriesNo, @titleSort, @authorSort,
      @seriesSort, @seriesIndex, @titleSearch, @authorsSearch, @seriesSearch,
      @genresSearch, @keywordsSearch, @fileName, @archiveName, @size, @libId, @deleted,
      @ext, @date, @lang, @keywords, @libRate, @sourceId
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, authors = excluded.authors, genres = excluded.genres,
      series = excluded.series, series_no = excluded.series_no,
      title_sort = excluded.title_sort, author_sort = excluded.author_sort,
      series_sort = excluded.series_sort, series_index = excluded.series_index,
      title_search = excluded.title_search, authors_search = excluded.authors_search,
      series_search = excluded.series_search, genres_search = excluded.genres_search,
      keywords_search = excluded.keywords_search,
      file_name = excluded.file_name, archive_name = excluded.archive_name,
      size = excluded.size, lib_id = excluded.lib_id, ext = excluded.ext, date = excluded.date,
      lang = excluded.lang, keywords = excluded.keywords,
      lib_rate = excluded.lib_rate,
      source_id = excluded.source_id, imported_at = CURRENT_TIMESTAMP
  `);

  function resolveAuthorId(name) {
    if (authorIdCache.has(name)) return authorIdCache.get(name);
    const key = name.toLowerCase();
    insertAuthor.run(key, authorDisplayName(name), createSortKey(authorSortKey(name)), authorSearchName(name));
    const id = selectAuthor.get(key)?.id || null;
    authorIdCache.set(name, id);
    return id;
  }

  function resolveSeriesId(name) {
    if (seriesIdCache.has(name)) return seriesIdCache.get(name);
    const key = name.toLowerCase();
    insertSeries.run(key, seriesDisplayName(name), seriesSortName(name), seriesSearchName(name));
    const id = selectSeries.get(key)?.id || null;
    seriesIdCache.set(name, id);
    return id;
  }

  function resolveGenreId(name) {
    if (genreIdCache.has(name)) return genreIdCache.get(name);
    const key = name.toLowerCase();
    insertGenre.run(key, genreDisplayName(name), genreSortName(name), genreSearchName(name));
    const id = selectGenre.get(key)?.id || null;
    genreIdCache.set(name, id);
    return id;
  }

  return {
    /** row — результат enrichBookRow + sourceId. */
    upsertBook: (row) => insertBook.run(row),
    unlinkAuthors: (bookId) => unlinkAuthors.run(bookId),
    unlinkSeries: (bookId) => unlinkSeries.run(bookId),
    unlinkGenres: (bookId) => unlinkGenres.run(bookId),
    linkFacets(row) {
      for (const authorName of splitAuthorValues(row.authors)) {
        const authorId = resolveAuthorId(authorName);
        if (authorId) linkAuthor.run(row.id, authorId);
      }
      if (row.series) {
        const seriesId = resolveSeriesId(row.series);
        if (seriesId) linkSeries.run(row.id, seriesId, row.seriesNo || '');
      }
      for (const genreName of splitFacetValues(row.genres)) {
        const genreId = resolveGenreId(genreName);
        if (genreId) linkGenre.run(row.id, genreId);
      }
    }
  };
}
