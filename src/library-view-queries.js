/**
 * SQL для списка «Популярное»: книги с историей чтения и/или каталожными закладками (избранное).
 * Рейтинг — по числу читателей (reading_history) и «поклонников» (bookmarks), без отдельного кэша в приложении.
 * Вынесено в отдельный модуль: регрессионный тест без загрузки inpx/db.
 * Ветки с ORDER BY/LIMIT должны быть в подзапросах до UNION ALL (правила SQLite).
 */
export const POPULAR_VIEW_ITEMS_SQL = `
      WITH pop AS (
        SELECT * FROM (
          SELECT book_id, COUNT(DISTINCT username) AS readers, 0 AS fans
          FROM reading_history
          GROUP BY book_id
          ORDER BY readers DESC
          LIMIT 2000
        )
        UNION ALL
        SELECT * FROM (
          SELECT book_id, 0 AS readers, COUNT(DISTINCT username) AS fans
          FROM bookmarks
          GROUP BY book_id
          ORDER BY fans DESC
          LIMIT 2000
        )
      ),
      pop_agg AS (
        SELECT book_id, SUM(readers) AS readers, SUM(fans) AS fans
        FROM pop
        GROUP BY book_id
        ORDER BY readers DESC, fans DESC
        LIMIT 1000
      )
      SELECT b.id, b.title, b.authors, b.genres, b.series, b.series_no AS seriesNo, b.ext, b.lang, b.archive_name AS archiveName
      FROM active_books b
      JOIN pop_agg p ON p.book_id = b.id
      ORDER BY p.readers DESC, p.fans DESC, COALESCE(NULLIF(b.date, ''), b.imported_at) DESC, b.title_sort ASC
      LIMIT ? OFFSET ?
    `;
