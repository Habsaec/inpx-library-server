/**
 * Индексация Calibre-библиотеки: каталог читается из снимка metadata.db (src/calibre.js),
 * файлы книг не открываются. Одна строка books на книгу Calibre (основной формат),
 * id = sha256(source:calibre:uuid) — правка названия/автора в Calibre (переименование папки) id не меняет.
 *
 * Инкрементальный проход: metadata.db не изменился (mtime + size) — источник пропускается; иначе
 * книги сравниваются с calibre_book_state (last_modified + форматы), читаются только изменённые.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  db,
  getMeta,
  setMeta,
  moveUserDataToBooks,
  updateSourceBookCount,
  updateSourceIndexedAt,
  reattachDetachedUserData,
  stashUserDataRefsForSource,
  runWithForeignKeysOff,
  stashMovedFolderBookRef,
  reattachMovedFolderUserData,
  dropBooksFtsTriggers,
  ensureBooksFtsTriggers,
  rebuildBooksFtsFromContent,
  beginFastSqliteImport,
  endFastSqliteImport,
  dropBulkImportIndexes,
  ensureBulkImportIndexesAsync,
  beginExclusiveOperation,
  endExclusiveOperation,
  getSuppressedBookIds
} from './db.js';
import { enrichBookRow, normalizeText, bumpIndexNewBooks, repairBookJunctionLinks } from './inpx.js';
import { prepareBookCatalogWriter } from './index-book-writer.js';
import { resolveIndexImportMode } from './index-import-mode.js';
import {
  calibreDbPath,
  calibreDbFingerprint,
  getStoredCalibreFingerprint,
  getCalibreSnapshotDb,
  copyCalibreSnapshot,
  commitCalibreSnapshot,
  openCalibreDbReadonly,
  inspectCalibreSchema,
  makeCalibreBookId,
  calibreLibId,
  calibreAuthorToInpx,
  calibreLangToIso1,
  calibreDateOnly,
  cleanCalibreTag,
  formatCalibreSeriesIndex,
  pickCalibrePrimaryFormat,
  calibreFormatsSignature
} from './calibre.js';
import { invalidateCoverThumbCaches } from './services/cover.js';
import { resetBookFilesProbe } from './download-formats.js';
import { appendIndexDiaryLine } from './services/file-log.js';
import { logSystemEvent } from './services/system-events.js';

const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const BOOKS_FTS_DIRTY_META_KEY = 'books_fts_dirty';
/** Ключевой проход по снимку: по 1000 id; чтение и запись — порциями по 350 (короткие транзакции). */
const SCAN_CHUNK = 1000;
const IMPORT_CHUNK = 350;

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

/** Связи порции книг: Map<bookId, row[]> в порядке ORDER BY. */
function groupByBook(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.book)) map.set(row.book, []);
    map.get(row.book).push(row);
  }
  return map;
}

function readFormats(snap, ids) {
  if (!ids.length) return new Map();
  return groupByBook(snap.prepare(`
    SELECT book, format, uncompressed_size AS size, name FROM data WHERE book IN (${placeholders(ids.length)})
  `).all(...ids));
}

/** Строки книг Calibre для порции id (+ связи), без представлений Calibre. */
function readCalibreBooks(snap, tables, ids) {
  const list = placeholders(ids.length);
  const books = snap.prepare(`
    SELECT id, uuid, title, series_index AS seriesIndex, timestamp, pubdate, last_modified AS lastModified, path
    FROM books WHERE id IN (${list})
  `).all(...ids);
  const linked = (table, sql) => (tables.has(table) ? groupByBook(snap.prepare(sql).all(...ids)) : new Map());
  const authors = linked('books_authors_link', `
    SELECT l.book, a.name, a.sort FROM books_authors_link l JOIN authors a ON a.id = l.author
    WHERE l.book IN (${list}) ORDER BY l.book, l.id
  `);
  const series = tables.has('series') ? linked('books_series_link', `
    SELECT l.book, s.name FROM books_series_link l JOIN series s ON s.id = l.series
    WHERE l.book IN (${list}) ORDER BY l.book, l.id
  `) : new Map();
  const tags = tables.has('tags') ? linked('books_tags_link', `
    SELECT l.book, t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag
    WHERE l.book IN (${list}) ORDER BY l.book, t.name
  `) : new Map();
  const ratings = tables.has('ratings') ? linked('books_ratings_link', `
    SELECT l.book, r.rating FROM books_ratings_link l JOIN ratings r ON r.id = l.rating
    WHERE l.book IN (${list})
  `) : new Map();
  const publishers = tables.has('publishers') ? linked('books_publishers_link', `
    SELECT l.book, p.name FROM books_publishers_link l JOIN publishers p ON p.id = l.publisher
    WHERE l.book IN (${list})
  `) : new Map();
  const languages = tables.has('languages') ? linked('books_languages_link', `
    SELECT l.book, g.lang_code AS code FROM books_languages_link l JOIN languages g ON g.id = l.lang_code
    WHERE l.book IN (${list}) ORDER BY l.book, l.item_order
  `) : new Map();
  const formats = readFormats(snap, ids);
  return books.map((b) => ({
    ...b,
    authors: authors.get(b.id) || [],
    series: series.get(b.id)?.[0]?.name || '',
    tags: (tags.get(b.id) || []).map((t) => t.name),
    rating: Number(ratings.get(b.id)?.[0]?.rating) || 0,
    publisher: publishers.get(b.id)?.[0]?.name || '',
    lang: languages.get(b.id)?.[0]?.code || '',
    formats: formats.get(b.id) || []
  }));
}

/** Книга Calibre → строка books (до enrichBookRow); null — нет поддерживаемого формата. */
export function calibreBookToRow(book, { sourceId, tagsMode = 'genres' }) {
  const primary = pickCalibrePrimaryFormat(book.formats);
  if (!primary || !book.uuid) return null;
  const tags = book.tags.map(cleanCalibreTag).filter(Boolean);
  const keywords = [book.publisher, ...(tagsMode === 'keywords' ? tags : [])].map(cleanCalibreTag).filter(Boolean);
  const bookPath = String(book.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return {
    id: makeCalibreBookId(sourceId, book.uuid),
    title: normalizeText(book.title) || primary.name,
    authors: book.authors.map((a) => calibreAuthorToInpx(a.name, a.sort)).filter(Boolean).join(':'),
    genres: tagsMode === 'genres' ? tags.join(':') : '',
    series: normalizeText(book.series) || '',
    seriesNo: book.series ? formatCalibreSeriesIndex(book.seriesIndex) : '',
    fileName: `${bookPath}/${primary.name}`,
    archiveName: '',
    size: primary.size,
    libId: calibreLibId(book.uuid),
    deleted: 0,
    ext: primary.ext,
    date: calibreDateOnly(book.timestamp),
    lang: calibreLangToIso1(book.lang),
    keywords: keywords.join(' '),
    libRate: Math.max(0, Math.min(5, Math.round((Number(book.rating) || 0) / 2)))
  };
}

/** Остальные форматы книги (кроме основного) → строки book_files: отдаются при скачивании как есть. */
export function calibreExtraFiles(book, primaryExt) {
  const bookPath = String(book.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const seen =new Set([primaryExt]);
  const out = [];
  for (const f of book.formats) {
    const ext = String(f.format || '').trim().toLowerCase();
    if (!ext || !f.name || seen.has(ext) || !/^[a-z0-9]{1,10}$/.test(ext)) continue;
    seen.add(ext);
    out.push({ ext, fileName: `${bookPath}/${f.name}`, size: Number(f.size) || 0 });
  }
  return out;
}

/**
 * Перевод папочного источника в Calibre: старые книги (id = sha256 пути) с пользовательскими данными
 * сопоставляются с книгами Calibre по file_name + ext — сначала основной файл, потом book_files.
 * Один проход по книгам источника порциями по rowid; в памяти — только отпечатки книг с данными.
 */
async function moveConvertedFolderUserData(sourceId, refs) {
  if (!refs.length) return { moved: 0, unmatched: 0 };
  const key = (fileName, ext) => `${String(fileName || '').toLowerCase()}|${String(ext || '').toLowerCase()}`;
  const wanted = new Map(refs.map((r) => [key(r.fileName, r.ext), r.oldId]));
  const primaryPairs = [];
  const extraPairs = [];
  const books = db.prepare(`
    SELECT rowid AS rid, id, file_name AS fileName, ext FROM books WHERE source_id = ? AND rowid > ? ORDER BY rowid LIMIT 5000
  `);
  const extras = db.prepare('SELECT book_id AS bookId, file_name AS fileName, ext FROM book_files WHERE book_id = ?');
  let after = -1;
  for (;;) {
    const chunk = books.all(sourceId, after);
    if (!chunk.length) break;
    after = chunk[chunk.length - 1].rid;
    for (const b of chunk) {
      const oldId = wanted.get(key(b.fileName, b.ext));
      if (oldId) primaryPairs.push([oldId, b.id]);
      for (const f of extras.all(b.id)) {
        const extraOld = wanted.get(key(f.fileName, f.ext));
        if (extraOld) extraPairs.push([extraOld, b.id]);
      }
    }
    await yieldEventLoop();
  }
  // Основной формат первым: при конфликте (одна позиция чтения на книгу) остаётся его позиция.
  const pairs = [...primaryPairs, ...extraPairs];
  moveUserDataToBooks(pairs);
  return { moved: pairs.length, unmatched: refs.length - pairs.length };
}

/** До 50 основных файлов источника: ни одного на месте — том, вероятно, не смонтирован. */
function checkCalibreFilesOnDisk(source) {
  const rows = db.prepare(`
    SELECT file_name AS fileName, ext FROM books WHERE source_id = ? ORDER BY RANDOM() LIMIT 50
  `).all(source.id);
  if (!rows.length) return;
  const missing = rows.filter((r) => !fs.existsSync(path.join(source.path, `${r.fileName}.${r.ext}`)));
  if (!missing.length) return;
  const none = missing.length === rows.length;
  const text = none
    ? `Calibre: ни один из ${rows.length} проверенных файлов книг не найден в ${source.path} — проверьте путь и монтирование диска`
    : `Calibre: ${missing.length} из ${rows.length} проверенных файлов книг отсутствуют в ${source.path}`;
  console.warn(`[calibre-index] ${text}`);
  appendIndexDiaryLine(text);
  logSystemEvent(none ? 'warn' : 'info', 'index', 'Calibre book files missing on disk', {
    sourceId: source.id,
    checked: rows.length,
    missing: missing.length,
    examples: missing.slice(0, 3).map((r) => `${r.fileName}.${r.ext}`)
  });
}

export async function indexCalibre(source, { incremental: requestedIncremental = true, onProgress = null, control = null } = {}) {
  // Перевод из папочного источника (convertFolderSourceToCalibre): только полный проход — старые строки папки
  // удаляются, их пользовательские данные переносятся на книги Calibre.
  const convertKey = `calibre_convert_${source.id}`;
  const converting = getMeta(convertKey) === '1';
  const incremental = requestedIncremental && !converting;
  const waitIfPaused = async () => {
    if (typeof control?.waitIfPaused === 'function') await control.waitIfPaused();
  };
  const throwIfCancelled = () => {
    if (typeof control?.throwIfCancelled === 'function') control.throwIfCancelled();
  };
  const sourceLabel = source.name || `id ${source.id}`;
  const liveDb = calibreDbPath(source.path);
  const liveStat = await fs.promises.stat(liveDb).catch(() => null);
  if (!liveStat?.isFile()) {
    // Не смонтированный том выглядит как пропавшая библиотека: ничего не трогаем.
    logSystemEvent('error', 'index', 'Calibre metadata.db not found, index aborted', { sourceId: source.id, name: sourceLabel, path: source.path });
    throw new Error(`metadata.db не найден в ${source.path}. Индексация прервана, ничего не удалено. Проверьте путь и монтирование диска.`);
  }
  const hasSnapshot = Boolean(getCalibreSnapshotDb(source.id));
  if (incremental && source.lastIndexedAt && hasSnapshot && getStoredCalibreFingerprint(source.id) === calibreDbFingerprint(liveStat)) {
    logSystemEvent('info', 'index', 'Calibre source skipped (unchanged metadata.db)', { sourceId: source.id, name: sourceLabel });
    return { imported: 0, total: 0, processed: 0, skipped: 0, deduplicated: 0, unchanged: true };
  }

  console.log(`[calibre-index] start source_id=${source.id} path=${source.path} incremental=${incremental}`);
  logSystemEvent('info', 'index', 'Calibre index started', { sourceId: source.id, name: sourceLabel, incremental, path: source.path });
  onProgress?.({ processed: 0, total: 0, imported: 0, currentArchive: `${sourceLabel}: копия metadata.db…` });
  const { file: snapshotFile, fingerprint } = await copyCalibreSnapshot(source.id, source.path);
  let snap = null;
  let committed = false;
  try {
    snap = openCalibreDbReadonly(snapshotFile);
    const { tables } = inspectCalibreSchema(snap);
    const calibreTotal = Number(snap.prepare('SELECT COUNT(*) AS c FROM books').get()?.c) || 0;
    if (calibreTotal === 0 && db.prepare('SELECT 1 FROM books WHERE source_id = ? LIMIT 1').get(source.id)) {
      logSystemEvent('error', 'index', 'Calibre library is empty, index aborted to keep existing books', { sourceId: source.id, name: sourceLabel });
      throw new Error(`Calibre-библиотека ${source.path} пуста. В индексе уже есть её книги — индексация прервана, ничего не удалено. Если книги удалены намеренно, удалите источник.`);
    }

    // 1. Что изменилось: last_modified + форматы против calibre_book_state.
    const stateGet = db.prepare('SELECT last_modified AS lastModified, formats FROM calibre_book_state WHERE source_id = ? AND calibre_id = ?');
    const scanStmt = snap.prepare(`SELECT id, last_modified AS lastModified FROM books WHERE id > ? ORDER BY id LIMIT ${SCAN_CHUNK}`);
    const changedIds = [];
    let lastId = -1;
    let scanned = 0;
    for (;;) {
      throwIfCancelled();
      await waitIfPaused();
      const chunk = scanStmt.all(lastId);
      if (!chunk.length) break;
      lastId = chunk[chunk.length - 1].id;
      scanned += chunk.length;
      if (!incremental) {
        for (const row of chunk) changedIds.push(row.id);
      } else {
        const formats = readFormats(snap, chunk.map((r) => r.id));
        for (const row of chunk) {
          const state = stateGet.get(source.id, row.id);
          const sig = calibreFormatsSignature(formats.get(row.id) || []);
          if (!state || state.lastModified !== String(row.lastModified || '') || state.formats !== sig) changedIds.push(row.id);
        }
      }
      onProgress?.({ processed: scanned, total: calibreTotal, imported: 0, currentArchive: `${sourceLabel}: сравнение ${scanned}/${calibreTotal}` });
      await yieldEventLoop();
    }

    // 2. Удалённые в Calibre (только инкрементально; полный проход удаляет всё ниже).
    const deletedStates = [];
    if (incremental) {
      const stateScan = db.prepare(`
        SELECT calibre_id AS calibreId, book_id AS bookId FROM calibre_book_state
        WHERE source_id = ? AND calibre_id > ? ORDER BY calibre_id LIMIT ${SCAN_CHUNK}
      `);
      const existsInSnap = snap.prepare('SELECT 1 FROM books WHERE id = ?');
      let after = -1;
      for (;;) {
        const chunk = stateScan.all(source.id, after);
        if (!chunk.length) break;
        after = chunk[chunk.length - 1].calibreId;
        for (const row of chunk) if (!existsInSnap.get(row.calibreId)) deletedStates.push(row);
        await yieldEventLoop();
      }
    }

    const workUnits = changedIds.length + deletedStates.length;
    const libraryRows = incremental ? (db.prepare('SELECT MAX(rowid) AS n FROM books').get()?.n || 0) : 0;
    const { ftsBulkMode, useFastSqlite } = resolveIndexImportMode({
      incremental,
      toProcess: workUnits,
      total: Math.max(calibreTotal, libraryRows)
    });
    console.log(`[calibre-index] plan source_id=${source.id}: changed=${changedIds.length} deleted=${deletedStates.length} of ${calibreTotal} ftsBulk=${ftsBulkMode}`);

    let imported = 0;
    let skippedNoFormat = 0;
    let convertRefs = [];
    let completedSuccessfully = false;
    beginExclusiveOperation('indexing');
    if (useFastSqlite) beginFastSqliteImport();
    if (ftsBulkMode) {
      setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
      dropBooksFtsTriggers();
      dropBulkImportIndexes();
    }
    try {
      const deleteBookRow = (bookId) => {
        db.prepare('DELETE FROM book_files WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM book_details_cache WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM book_reviews WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM book_authors WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM book_series WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM book_genres WHERE book_id = ?').run(bookId);
        db.prepare('DELETE FROM books WHERE id = ? AND source_id = ?').run(bookId, source.id);
      };

      if (!incremental) {
        // Пользовательские данные: отпечаток → удаление без FK-каскада → перепривязка в конце (id те же).
        stashUserDataRefsForSource(source.id);
        if (converting) {
          convertRefs = db.prepare(`
            SELECT d.old_book_id AS oldId, d.file_name AS fileName, d.ext
            FROM detached_book_refs d JOIN books b ON b.id = d.old_book_id
            WHERE b.source_id = ? AND d.archive_name = ''
          `).all(source.id);
        }
        runWithForeignKeysOff(() => db.transaction(() => {
          db.prepare('DELETE FROM book_files WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
          db.prepare('DELETE FROM book_details_cache WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
          db.prepare('DELETE FROM book_reviews WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
          db.prepare('DELETE FROM book_authors WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
          db.prepare('DELETE FROM book_series WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
          db.prepare('DELETE FROM book_genres WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
          db.prepare('DELETE FROM books WHERE source_id = ?').run(source.id);
          db.prepare('DELETE FROM calibre_book_state WHERE source_id = ?').run(source.id);
        })());
        await yieldEventLoop();
      } else if (deletedStates.length) {
        // Как пропавший файл папки: книга с данными пользователя ждёт 30 дней (удалена и добавлена заново
        // в Calibre — новый uuid; совпадение по размеру + названию в reattachMovedFolderUserData).
        const dropState = db.prepare('DELETE FROM calibre_book_state WHERE source_id = ? AND calibre_id = ?');
        for (let i = 0; i < deletedStates.length; i += 100) {
          const slice = deletedStates.slice(i, i + 100);
          runWithForeignKeysOff(() => db.transaction(() => {
            for (const { calibreId, bookId } of slice) {
              stashMovedFolderBookRef(bookId, source.id);
              deleteBookRow(bookId);
              dropState.run(source.id, calibreId);
            }
          })());
          await yieldEventLoop();
        }
      }

      const writer = prepareBookCatalogWriter();
      const suppressedIds = getSuppressedBookIds();
      const tagsMode = source.calibreTags || 'genres';
      const bookExists = db.prepare('SELECT 1 FROM books WHERE id = ? AND source_id = ?');
      const upsertState = db.prepare(`
        INSERT INTO calibre_book_state(source_id, calibre_id, book_id, uuid, last_modified, formats)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, calibre_id) DO UPDATE SET
          book_id = excluded.book_id, uuid = excluded.uuid,
          last_modified = excluded.last_modified, formats = excluded.formats
      `);
      const dropDetails = db.prepare('DELETE FROM book_details_cache WHERE book_id = ?');
      const dropFiles = db.prepare('DELETE FROM book_files WHERE book_id = ?');
      const insertFile = db.prepare('INSERT OR REPLACE INTO book_files(book_id, ext, file_name, size) VALUES(?, ?, ?, ?)');
      const newBookIds = [];
      const changedBookIds = [];

      for (let i = 0; i < changedIds.length; i += IMPORT_CHUNK) {
        throwIfCancelled();
        await waitIfPaused();
        const books = readCalibreBooks(snap, tables, changedIds.slice(i, i + IMPORT_CHUNK));
        runWithForeignKeysOff(() => db.transaction(() => {
          for (const book of books) {
            const bookId = makeCalibreBookId(source.id, book.uuid);
            const existed = Boolean(bookExists.get(bookId, source.id));
            const raw = calibreBookToRow(book, { sourceId: source.id, tagsMode });
            upsertState.run(source.id, book.id, bookId, String(book.uuid || ''), String(book.lastModified || ''), calibreFormatsSignature(book.formats));
            if (!raw) {
              // Остались только форматы вне CALIBRE_PRIMARY_FORMATS (LIT, HTMLZ…): книгу убираем, как удалённую.
              skippedNoFormat += 1;
              if (existed) {
                stashMovedFolderBookRef(bookId, source.id);
                deleteBookRow(bookId);
              }
              continue;
            }
            const row = enrichBookRow(raw);
            if (!row || suppressedIds.has(row.id)) continue;
            row.sourceId = source.id;
            writer.upsertBook(row);
            if (existed) {
              writer.unlinkAuthors(row.id);
              writer.unlinkSeries(row.id);
              writer.unlinkGenres(row.id);
              dropDetails.run(row.id);
              changedBookIds.push(row.id);
            } else {
              if (incremental) bumpIndexNewBooks();
              newBookIds.push(row.id);
            }
            writer.linkFacets(row);
            dropFiles.run(row.id);
            for (const f of calibreExtraFiles(book, row.ext)) insertFile.run(row.id, f.ext, f.fileName, f.size);
            imported += 1;
          }
        })());
        onProgress?.({
          processed: Math.min(i + IMPORT_CHUNK, changedIds.length),
          total: changedIds.length,
          imported,
          currentArchive: `${sourceLabel}: ${Math.min(i + IMPORT_CHUNK, changedIds.length)}/${changedIds.length}`
        });
        await yieldEventLoop();
      }

      for (const id of changedBookIds) invalidateCoverThumbCaches(id);
      commitCalibreSnapshot(source.id, snapshotFile, fingerprint);
      committed = true;
      resetBookFilesProbe();
      updateSourceBookCount(source.id);
      updateSourceIndexedAt(source.id);
      if (converting) {
        const result = await moveConvertedFolderUserData(source.id, convertRefs);
        db.prepare('DELETE FROM meta WHERE key = ?').run(convertKey);
        logSystemEvent('info', 'index', 'folder source converted to Calibre library', { sourceId: source.id, name: sourceLabel, ...result });
      }
      reattachDetachedUserData(source.id);
      if (incremental) reattachMovedFolderUserData(source.id, newBookIds);
      repairBookJunctionLinks();
      try {
        checkCalibreFilesOnDisk(source);
      } catch (err) {
        console.warn('[calibre-index] file presence check failed:', err.message);
      }
      completedSuccessfully = true;
    } finally {
      if (ftsBulkMode) {
        try {
          await rebuildBooksFtsFromContent();
          ensureBooksFtsTriggers();
          setMeta(BOOKS_FTS_DIRTY_META_KEY, '0');
        } catch (err) {
          console.error('[calibre-index] FTS rebuild failed:', err.message);
          setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
        }
        await ensureBulkImportIndexesAsync({
          onProgress: ({ done, total }) => {
            onProgress?.({ processed: workUnits, total: workUnits, imported, currentArchive: `БД: индексы ${done}/${total}…` });
          }
        });
      }
      if (useFastSqlite) endFastSqliteImport();
      endExclusiveOperation('indexing');
    }

    console.log(`[calibre-index] done source_id=${source.id} imported=${imported} calibre_books=${calibreTotal}`);
    logSystemEvent('info', 'index', 'Calibre index pass completed', {
      sourceId: source.id,
      name: sourceLabel,
      imported,
      calibreBooks: calibreTotal,
      deleted: deletedStates.length,
      skippedNoSupportedFormat: skippedNoFormat,
      completed: completedSuccessfully
    });
    return {
      imported,
      total: calibreTotal,
      processed: changedIds.length,
      skipped: calibreTotal - changedIds.length,
      deduplicated: 0,
      // metadata.db was re-read but no book changed (e.g. Calibre only touched its own prefs): no catalog recount.
      unchanged: incremental && workUnits === 0 && completedSuccessfully
    };
  } finally {
    try { snap?.close(); } catch { /* ignore */ }
    if (!committed) await fs.promises.unlink(snapshotFile).catch(() => {});
  }
}
