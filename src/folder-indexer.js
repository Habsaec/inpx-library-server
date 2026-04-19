import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import unzipper from 'unzipper';
import { listArchiveFiles, readArchiveEntryBuffer } from './archives.js';
import { parseEnvTimeoutMs, promiseWithTimeout } from './utils/async-timeout.js';
import iconv from 'iconv-lite';
import {
  db,
  getMeta,
  setMeta,
  updateSourceBookCount,
  updateSourceIndexedAt,
  dropBooksFtsTriggers,
  ensureBooksFtsTriggers,
  rebuildBooksFtsFromContent,
  beginFastSqliteImport,
  endFastSqliteImport,
  getSourceById,
  getSuppressedBookIds
} from './db.js';
import {
  enrichBookRow, splitAuthorValues, splitFacetValues,
  formatSingleAuthorName, authorDisplayName, authorSortKey, authorSearchName,
  seriesDisplayName, seriesSortName, seriesSearchName,
  genreDisplayName, genreSortName, genreSearchName,
  createSortKey, normalizeText
} from './inpx.js';
import { getOrExtractBookDetails } from './fb2.js';
import { logSystemEvent } from './services/system-events.js';

/** Уступка циклу событий без лишней задержки (см. inpx.js — setTimeout(2) накладывался тысячи раз). */
const yieldEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const BOOKS_FTS_DIRTY_META_KEY = 'books_fts_dirty';

/**
 * Фоновое предизвлечение обложек/аннотаций для книг источника.
 * Вызывается после индексации, чтобы при первом открытии страницы книги
 * данные уже были в book_details_cache.
 * @internal - вызывается только из indexFolder
 */
export async function warmupBookDetailsCache(sourceId, { limit = 200 } = {}) {
  try {
    const books = db.prepare(`
      SELECT id, title, file_name AS fileName, archive_name AS archiveName,
             lang, source_id AS sourceId
      FROM books
      WHERE source_id = ? AND deleted = 0
        AND id NOT IN (SELECT book_id FROM book_details_cache)
      ORDER BY imported_at DESC
      LIMIT ?
    `).all(sourceId, limit);
    
    if (!books.length) return;
    
    console.log(`[cache-warmup] Preloading details for ${books.length} books from source ${sourceId}`);
    
    let processed = 0;
    for (const book of books) {
      try {
        await getOrExtractBookDetails(book);
        processed++;
        // Уступаем event loop каждые 10 книг
        if (processed % 10 === 0) {
          await yieldEventLoop();
        }
      } catch (err) {
        console.warn(`[cache-warmup] Failed to extract details for book ${book.id}:`, err.message);
      }
    }
    console.log(`[cache-warmup] Completed: ${processed}/${books.length} books cached for source ${sourceId}`);
  } catch (err) {
    console.error('[cache-warmup] Failed:', err.message);
  }
}
function readBoundedConcurrency(envName, fallback) {
  const raw = Number.parseInt(String(process.env[envName] || ''), 10);
  const n = Number.isFinite(raw) ? raw : fallback;
  return Math.max(1, Math.min(6, n));
}

function resolveMetadataExtractConcurrency(incremental) {
  const common = readBoundedConcurrency('INDEX_METADATA_CONCURRENCY', 3);
  const full = readBoundedConcurrency('INDEX_METADATA_CONCURRENCY_FULL', Math.max(common, 4));
  const inc = readBoundedConcurrency('INDEX_METADATA_CONCURRENCY_INCREMENTAL', common);
  return incremental ? inc : full;
}

function isAdaptiveConcurrencyEnabled() {
  const raw = String(process.env.INDEX_METADATA_ADAPTIVE || '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

async function measureEventLoopLagMs() {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return Date.now() - started;
}

async function asyncMapLimit(items, limit, mapper) {
  const arr = Array.isArray(items) ? items : [];
  const out = new Array(arr.length);
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  let index = 0;
  const workers = Array.from({ length: Math.min(max, arr.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= arr.length) return;
      out[i] = await mapper(arr[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const SUPPORTED_EXTENSIONS = new Set(['fb2', 'epub', 'mobi', 'azw3']);

function makeBookId(sourceId, relativePath) {
  return crypto.createHash('sha256').update(`${sourceId}:${relativePath}`).digest('hex').slice(0, 32);
}

/** Рекурсивный обход дерева; уступки циклу событий — иначе на больших зеркалах (Флибуста) HTTP «висит» минутами. */
const SCAN_YIELD_EVERY_DIRS = 48;

async function scanDirectory(rootPath, onScanTick = null, control = null) {
  const waitIfPaused = async () => {
    if (typeof control?.waitIfPaused === 'function') {
      await control.waitIfPaused();
    }
  };
  const throwIfCancelled = () => {
    if (typeof control?.throwIfCancelled === 'function') {
      control.throwIfCancelled();
    }
  };
  const results = [];
  const containerArchives = [];
  const stack = [rootPath];
  let hadReadErrors = false;
  let dirsVisited = 0;
  while (stack.length) {
    throwIfCancelled();
    await waitIfPaused();
    const dir = stack.pop();
    dirsVisited += 1;
    if (dirsVisited % SCAN_YIELD_EVERY_DIRS === 0) {
      await yieldEventLoop();
      if (onScanTick) {
        onScanTick({
          dirs: dirsVisited,
          looseFiles: results.length,
          containerArchives: containerArchives.length
        });
      }
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      hadReadErrors = true;
      console.warn(`[folder-indexer] Cannot read directory ${dir}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push({ fullPath, relativePath: path.relative(rootPath, fullPath), ext, zipPath: null, zipEntry: null });
        } else if (ext === 'zip' || ext === '7z') {
          containerArchives.push({
            fullPath,
            relativePath: path.relative(rootPath, fullPath),
            ext
          });
        }
      }
    }
  }
  if (onScanTick) {
    onScanTick({
      dirs: dirsVisited,
      looseFiles: results.length,
      containerArchives: containerArchives.length,
      done: true
    });
  }
  return { files: results, containerArchives, hadReadErrors };
}

const LIST_ARCHIVES_LOG_EVERY = 200;
const ARCHIVE_SCAN_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number.parseInt(String(process.env.ARCHIVE_SCAN_CONCURRENCY || ''), 10) || 3)
);

async function scanContainerArchives(rootPath, archives, onArchiveTick = null, control = null) {
  const waitIfPaused = async () => {
    if (typeof control?.waitIfPaused === 'function') {
      await control.waitIfPaused();
    }
  };
  const throwIfCancelled = () => {
    if (typeof control?.throwIfCancelled === 'function') {
      control.throwIfCancelled();
    }
  };
  const results = [];
  let hadListErrors = false;
  let listedCount = 0;
  let index = 0;
  const workers = Array.from({ length: Math.min(ARCHIVE_SCAN_CONCURRENCY, archives.length) }, async () => {
    for (;;) {
      const ai = index++;
      if (ai >= archives.length) return;
      const arch = archives[ai];
      try {
        throwIfCancelled();
        await waitIfPaused();
        const listed = await listArchiveFiles(arch.fullPath);
        await yieldEventLoop();
        for (const entry of listed) {
          const ext = path.extname(entry.path).slice(1).toLowerCase();
          if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
          const virtualRelPath = arch.relativePath + '/' + entry.path;
          results.push({
            fullPath: arch.fullPath,
            relativePath: virtualRelPath,
            ext,
            zipPath: arch.relativePath,
            zipEntry: entry.path,
            uncompressedSize: entry.uncompressedSize || 0
          });
        }
      } catch (err) {
        if (/cancelled by user/i.test(String(err?.message || err))) {
          throw err;
        }
        hadListErrors = true;
        const label = arch.ext === '7z' ? '7z' : 'ZIP';
        console.error(`[folder-indexer] Failed to read ${label} ${arch.fullPath}: ${err.message}`);
        logSystemEvent('warn', 'index', `Corrupted or unreadable ${label} archive: ${path.basename(arch.fullPath)}`, {
          path: arch.fullPath,
          error: err.message
        });
      } finally {
        listedCount += 1;
        if (listedCount > 0 && listedCount % LIST_ARCHIVES_LOG_EVERY === 0) {
          console.log(`[folder-index] archive listings ${listedCount}/${archives.length}, virtual files so far: ${results.length}`);
        }
        onArchiveTick?.({ listed: listedCount, totalArchives: archives.length, virtualFiles: results.length });
      }
    }
  });
  await Promise.all(workers);
  onArchiveTick?.({ listed: archives.length, totalArchives: archives.length, virtualFiles: results.length });
  return { entries: results, hadListErrors };
}

function parseFilenameMetadata(relativePath) {
  const parsed = path.parse(relativePath);
  const baseName = parsed.name;
  const dirParts = parsed.dir ? parsed.dir.split(/[\\/]/).filter(Boolean) : [];

  let author = '';
  let title = baseName;
  let series = '';

  const dashMatch = baseName.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    author = dashMatch[1].trim();
    title = dashMatch[2].trim();
  }

  if (!author && dirParts.length >= 1) {
    author = dirParts[0];
  }
  if (!series && dirParts.length >= 2) {
    series = dirParts[1];
  }

  return { title, authors: author, series };
}

function parseFb2Metadata(content) {
  const titleMatch = content.match(/<book-title[^>]*>([\s\S]*?)<\/book-title>/i);
  const title = titleMatch ? stripXmlTags(titleMatch[1]) : '';

  const titleInfoMatch = content.match(/<title-info[\s\S]*?<\/title-info>/i);
  const titleInfoBlock = titleInfoMatch ? titleInfoMatch[0] : content;
  const authorMatches = [...titleInfoBlock.matchAll(/<author>([\s\S]*?)<\/author>/gi)];
  const authors = authorMatches.map((m) => {
    const block = m[1];
    const last = extractTag(block, 'last-name');
    const first = extractTag(block, 'first-name');
    const middle = extractTag(block, 'middle-name');
    return [last, first, middle].filter(Boolean).join(' ');
  }).filter(Boolean);

  const genreMatches = [...titleInfoBlock.matchAll(/<genre[^>]*>([\s\S]*?)<\/genre>/gi)];
  const genres = genreMatches.map((m) => stripXmlTags(m[1]).trim()).filter(Boolean);

  const seqMatch = titleInfoBlock.match(/<sequence\s+name=["']([^"']+)["'](?:\s+number=["']([^"']+)["'])?/i);
  const series = seqMatch ? seqMatch[1] : '';
  const seriesNo = seqMatch ? (seqMatch[2] || '') : '';

  const langMatch = titleInfoBlock.match(/<lang[^>]*>([\s\S]*?)<\/lang>/i);
  const lang = langMatch ? stripXmlTags(langMatch[1]).trim() : '';

  const kwMatch = titleInfoBlock.match(/<keywords[^>]*>([\s\S]*?)<\/keywords>/i);
  const keywords = kwMatch ? stripXmlTags(kwMatch[1]).trim() : '';

  const dateMatch = titleInfoBlock.match(/<date[^>]*\bvalue=["']([^"']+)["']/i);
  const date = dateMatch ? dateMatch[1] : '';

  return { title, authors: authors.join(':'), genres: genres.join(':'), series, seriesNo, lang, keywords, date };
}

function parseEpubMetadata(filePath) {
  const zipOpenMs = parseEnvTimeoutMs('ARCHIVE_ZIP_OPEN_TIMEOUT_MS', 120_000);
  try {
    const zip = promiseWithTimeout(
      unzipper.Open.file(filePath),
      zipOpenMs,
      `epub open ${path.basename(filePath)}`
    );
    return zip.then((directory) => {
      const containerEntry = directory.files.find((f) => f.path === 'META-INF/container.xml');
      if (!containerEntry) return null;
      return containerEntry.buffer().then((buf) => {
        const containerXml = buf.toString('utf8');
        const rootFileMatch = containerXml.match(/rootfile[^>]+full-path=["']([^"']+)["']/i);
        if (!rootFileMatch) return null;
        const opfPath = rootFileMatch[1];
        const opfEntry = directory.files.find((f) => f.path === opfPath);
        if (!opfEntry) return null;
        return opfEntry.buffer().then((opfBuf) => {
          const opf = opfBuf.toString('utf8');
          return parseOpfMetadata(opf);
        });
      });
    });
  } catch {
    return Promise.resolve(null);
  }
}

function parseOpfMetadata(opf) {
  const title = extractDcTag(opf, 'title');
  const creatorsRaw = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)];
  const authors = creatorsRaw.map((m) => stripXmlTags(m[1]).trim()).filter(Boolean);

  const subjects = [...opf.matchAll(/<dc:subject[^>]*>([\s\S]*?)<\/dc:subject>/gi)];
  const genres = subjects.map((m) => stripXmlTags(m[1]).trim()).filter(Boolean);

  const lang = extractDcTag(opf, 'language');

  const seriesMatch = opf.match(/<meta\s+name=["']calibre:series["']\s+content=["']([^"']+)["']/i);
  const seriesNoMatch = opf.match(/<meta\s+name=["']calibre:series_index["']\s+content=["']([^"']+)["']/i);
  const series = seriesMatch ? seriesMatch[1] : '';
  const seriesNo = seriesNoMatch ? seriesNoMatch[1] : '';

  const dateTag = extractDcTag(opf, 'date');
  const date = dateTag ? dateTag.slice(0, 10) : '';

  return { title, authors: authors.join(':'), genres: genres.join(':'), series, seriesNo, lang, keywords: '', date };
}

function extractTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? stripXmlTags(match[1]).trim() : '';
}

function extractDcTag(xml, tagName) {
  const match = xml.match(new RegExp(`<dc:${tagName}[^>]*>([\\s\\S]*?)<\\/dc:${tagName}>`, 'i'));
  return match ? stripXmlTags(match[1]).trim() : '';
}

function stripXmlTags(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMobiMetadata(buf) {
  if (buf.length < 132) return {};

  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 1 || 78 + numRecords * 8 > buf.length) return {};
  const record0Offset = buf.readUInt32BE(78);
  if (record0Offset + 16 >= buf.length) return {};

  const rec = buf.slice(record0Offset);
  if (rec.length < 232) return {};

  const mobiMagic = rec.slice(16, 20).toString('ascii');
  if (mobiMagic !== 'MOBI') return {};

  const fullNameOffset = rec.readUInt32BE(84);
  const fullNameLength = rec.readUInt32BE(88);
  const encoding = rec.readUInt32BE(28);
  const codec = encoding === 65001 ? 'utf8' : 'latin1';

  let title = '';
  if (fullNameOffset + fullNameLength <= rec.length && fullNameLength > 0 && fullNameLength < 4096) {
    title = rec.slice(fullNameOffset, fullNameOffset + fullNameLength).toString(codec).trim();
  }

  const exthFlag = rec.readUInt32BE(128);
  if (!(exthFlag & 0x40)) return { title };

  const mobiHeaderLength = rec.readUInt32BE(20);
  const exthStart = 16 + mobiHeaderLength;
  if (exthStart + 12 > rec.length) return { title };

  const exthMagic = rec.slice(exthStart, exthStart + 4).toString('ascii');
  if (exthMagic !== 'EXTH') return { title };

  const exthCount = rec.readUInt32BE(exthStart + 8);
  let authors = [];
  let series = '';
  let seriesNo = '';
  let lang = '';
  let genres = [];
  let date = '';

  let pos = exthStart + 12;
  for (let i = 0; i < exthCount && pos + 8 <= rec.length; i++) {
    const type = rec.readUInt32BE(pos);
    const len = rec.readUInt32BE(pos + 4);
    if (len < 8 || pos + len > rec.length) break;
    const val = rec.slice(pos + 8, pos + len).toString(codec).trim();
    switch (type) {
      case 100: if (val) authors.push(val); break;
      case 105: if (val) genres.push(val); break;
      case 106: if (val) date = val.slice(0, 10); break;
      case 503: if (val && !title) title = val; break;
    }
    pos += len;
  }

  return {
    title: title || '',
    authors: authors.join(':'),
    genres: genres.join(':'),
    series,
    seriesNo,
    lang,
    keywords: '',
    date
  };
}

function parseFb2FromBuffer(raw) {
  const head = raw.slice(0, 200).toString('latin1');
  const encMatch = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  const declared = (encMatch?.[1] || 'utf-8').toLowerCase().replace(/\s/g, '');
  let content;
  if (declared === 'windows-1251' || declared === 'cp1251' || declared === 'win-1251') {
    content = iconv.decode(raw, 'win1251');
  } else {
    content = raw.toString('utf8');
  }
  return parseFb2Metadata(content);
}

async function extractMetadata(filePath, relativePath, ext, { zipEntry = null } = {}) {
  if (ext === 'fb2') {
    try {
      const raw = zipEntry
        ? await readArchiveEntryForIndexer(filePath, zipEntry)
        : fs.readFileSync(filePath);
      const meta = parseFb2FromBuffer(raw);
      if (meta.title) return meta;
    } catch (err) {
      console.warn(`[folder-indexer] FB2 metadata extraction failed for ${relativePath}: ${err.message}`);
    }
  }

  if (ext === 'epub') {
    try {
      if (zipEntry) {
        const buf = await readArchiveEntryForIndexer(filePath, zipEntry);
        const meta = await parseEpubMetadataFromBuffer(buf);
        if (meta?.title) return meta;
      } else {
        const meta = await parseEpubMetadata(filePath);
        if (meta?.title) return meta;
      }
    } catch (err) {
      console.warn(`[folder-indexer] EPUB metadata extraction failed for ${relativePath}: ${err.message}`);
    }
  }

  if (ext === 'mobi' || ext === 'azw3') {
    try {
      const raw = zipEntry
        ? await readArchiveEntryForIndexer(filePath, zipEntry)
        : fs.readFileSync(filePath);
      const meta = parseMobiMetadata(raw);
      if (meta.title) return meta;
    } catch (err) {
      console.warn(`[folder-indexer] MOBI metadata extraction failed for ${relativePath}: ${err.message}`);
    }
  }

  const nameForParsing = zipEntry || relativePath;
  const fallback = parseFilenameMetadata(nameForParsing);
  return { ...fallback, genres: '', seriesNo: '', lang: '', keywords: '', date: '' };
}

const MAX_ZIP_ENTRY_SIZE = 100 * 1024 * 1024;

async function readArchiveEntryForIndexer(archivePath, entryPath) {
  const buf = await readArchiveEntryBuffer(archivePath, entryPath);
  if (buf.length > MAX_ZIP_ENTRY_SIZE) throw new Error(`Archive entry too large: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  return buf;
}

async function parseEpubMetadataFromBuffer(buf) {
  const tmpPath = path.join(os.tmpdir(), `epub-${Date.now()}-${Math.random().toString(36).slice(2)}.epub`);
  try {
    fs.writeFileSync(tmpPath, buf);
    return await parseEpubMetadata(tmpPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

export async function indexFolder(source, { incremental = true, onProgress = null, control = null } = {}) {
  const waitIfPaused = async () => {
    if (typeof control?.waitIfPaused === 'function') {
      await control.waitIfPaused();
    }
  };
  const throwIfCancelled = () => {
    if (typeof control?.throwIfCancelled === 'function') {
      control.throwIfCancelled();
    }
  };
  const rootPath = source.path;
  if (!fs.existsSync(rootPath)) {
    throw new Error(`Папка не найдена: ${rootPath}`);
  }
  console.log(`[folder-index] start source_id=${source.id} path=${rootPath} incremental=${incremental}`);
  logSystemEvent('info', 'index', 'folder index started', {
    sourceId: source.id,
    name: source.name || '',
    incremental,
    path: rootPath
  });

  const metaKey = `folder_index_${source.id}`;
  let previousFiles = {};
  if (incremental) {
    try { previousFiles = JSON.parse(getMeta(metaKey) || '{}'); } catch { previousFiles = {}; }
  }

  const sourceLabel = source.name || `id ${source.id}`;
  const maxMetadataExtractConcurrency = resolveMetadataExtractConcurrency(incremental);
  const adaptiveConcurrencyEnabled = isAdaptiveConcurrencyEnabled();
  let metadataExtractConcurrency = maxMetadataExtractConcurrency;
  let fastBatchStreak = 0;
  let slowBatchStreak = 0;
  const scanLogEvery = SCAN_YIELD_EVERY_DIRS * 25;
  const scanProgressEvery = SCAN_YIELD_EVERY_DIRS * 10;
  const { files: looseFiles, containerArchives, hadReadErrors } = await scanDirectory(rootPath, (tick) => {
    if (tick.done) {
      console.log(
        `[folder-index] scan done: ${tick.dirs} dirs, ${tick.looseFiles} loose books, ${tick.containerArchives} zip/7z containers`
      );
      logSystemEvent('info', 'index', 'folder scan completed', {
        sourceId: source.id,
        name: sourceLabel,
        dirs: tick.dirs,
        looseFiles: tick.looseFiles,
        containerArchives: tick.containerArchives
      });
      onProgress?.({
        processed: 0,
        total: 0,
        imported: 0,
        currentArchive: `${sourceLabel}: обход завершён (${tick.dirs} кат., ${tick.containerArchives} арх.)`
      });
      return;
    }
    if (tick.dirs % scanLogEvery === 0) {
      console.log(
        `[folder-index] scanning… ${tick.dirs} dirs, ${tick.looseFiles} loose, ${tick.containerArchives} containers`
      );
    }
    if (tick.dirs % scanProgressEvery === 0) {
      onProgress?.({
        processed: 0,
        total: 0,
        imported: 0,
        currentArchive: `${sourceLabel}: обход папок… ${tick.dirs} кат., ${tick.containerArchives} арх., ${tick.looseFiles} файлов`
      });
    }
  }, control);

  const { entries: zipEntries, hadListErrors } = await scanContainerArchives(rootPath, containerArchives, (tick) => {
    onProgress?.({
      processed: tick.listed,
      total: Math.max(1, tick.totalArchives),
      imported: 0,
      currentArchive: `${sourceLabel}: список архивов ${tick.listed}/${tick.totalArchives}, записей ${tick.virtualFiles}`
    });
  }, control);
  const allFiles = [...zipEntries, ...looseFiles];
  const canReconcileDeletedFiles = !hadReadErrors && !hadListErrors;
  console.log(`[folder-index] ${allFiles.length} paths to stat (loose + inside archives)`);
  const filesToProcess = [];
  const currentFiles = {};
  const statCache = new Map();

  for (let fi = 0; fi < allFiles.length; fi++) {
    throwIfCancelled();
    await waitIfPaused();
    const file = allFiles[fi];
    if (fi > 0 && fi % 2500 === 0) {
      await yieldEventLoop();
      onProgress?.({
        processed: fi,
        total: allFiles.length,
        imported: 0,
        currentArchive: `${sourceLabel}: проверка mtime/size ${fi}/${allFiles.length}`
      });
    }
    let stat = statCache.get(file.fullPath);
    if (!stat) {
      try {
        stat = fs.statSync(file.fullPath);
        statCache.set(file.fullPath, stat);
      } catch {
        continue;
      }
    }
    const key = file.relativePath;
    const mtimeMs = String(stat.mtimeMs);
    const size = stat.size;
    file._statSize = size;
    currentFiles[key] = { mtimeMs, size };

    if (incremental && previousFiles[key] && previousFiles[key].mtimeMs === mtimeMs && previousFiles[key].size === size) {
      continue;
    }
    filesToProcess.push(file);
  }

  const ftsBulkMode = !incremental;
  let completedSuccessfully = false;
  try {
  if (ftsBulkMode) {
    beginFastSqliteImport();
    setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
  }
  if (!incremental) {
    dropBooksFtsTriggers();
    db.transaction(() => {
      db.prepare('DELETE FROM book_details_cache WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
      db.prepare('DELETE FROM book_authors WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
      db.prepare('DELETE FROM book_series WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
      db.prepare('DELETE FROM book_genres WHERE book_id IN (SELECT id FROM books WHERE source_id = ?)').run(source.id);
      db.prepare('DELETE FROM books WHERE source_id = ?').run(source.id);
    })();
    await yieldEventLoop();
  } else {
    const deletedKeys = Object.keys(previousFiles).filter((k) => !(k in currentFiles));
    if (!canReconcileDeletedFiles && deletedKeys.length > 0) {
      console.warn(
        `[folder-indexer] Skipping deletion reconciliation (${deletedKeys.length} candidates): scan/list had transient errors`
      );
    } else if (deletedKeys.length > 0) {
      console.log(`[folder-indexer] Removing ${deletedKeys.length} deleted files from index`);
      const deleteBook = db.prepare('DELETE FROM books WHERE id = ? AND source_id = ?');
      const deleteBookAuthors = db.prepare('DELETE FROM book_authors WHERE book_id = ?');
      const deleteBookSeries = db.prepare('DELETE FROM book_series WHERE book_id = ?');
      const deleteBookGenres = db.prepare('DELETE FROM book_genres WHERE book_id = ?');
      const deleteBookCache = db.prepare('DELETE FROM book_details_cache WHERE book_id = ?');
      const DEL_CHUNK = 100;
      for (let j = 0; j < deletedKeys.length; j += DEL_CHUNK) {
        const slice = deletedKeys.slice(j, j + DEL_CHUNK);
        db.transaction(() => {
          for (const key of slice) {
            const bookId = makeBookId(source.id, key);
            deleteBookCache.run(bookId);
            deleteBookAuthors.run(bookId);
            deleteBookSeries.run(bookId);
            deleteBookGenres.run(bookId);
            deleteBook.run(bookId, source.id);
          }
        })();
        await yieldEventLoop();
      }
    }
    // Incremental: FTS triggers stay ON — per-row updates are cheap vs full rebuild
  }

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
  const linkSeries = db.prepare('INSERT OR REPLACE INTO book_series(book_id, series_id) VALUES(?, ?)');
  const linkGenre = db.prepare('INSERT OR IGNORE INTO book_genres(book_id, genre_id) VALUES(?, ?)');
  const unlinkAuthors = db.prepare('DELETE FROM book_authors WHERE book_id = ?');
  const unlinkSeries = db.prepare('DELETE FROM book_series WHERE book_id = ?');
  const unlinkGenres = db.prepare('DELETE FROM book_genres WHERE book_id = ?');
  const suppressedIds = getSuppressedBookIds();
  const insertBook = db.prepare(`
    INSERT INTO books (
      id, title, authors, genres, series, series_no, title_sort, author_sort,
      series_sort, series_index, title_search, authors_search, series_search,
      genres_search, keywords_search, file_name, archive_name, size, lib_id, deleted,
      ext, date, lang, keywords, source_id
    ) VALUES (
      @id, @title, @authors, @genres, @series, @seriesNo, @titleSort, @authorSort,
      @seriesSort, @seriesIndex, @titleSearch, @authorsSearch, @seriesSearch,
      @genresSearch, @keywordsSearch, @fileName, @archiveName, @size, @libId, @deleted,
      @ext, @date, @lang, @keywords, @sourceId
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
      size = excluded.size, ext = excluded.ext, date = excluded.date,
      lang = excluded.lang, keywords = excluded.keywords,
      source_id = excluded.source_id, imported_at = CURRENT_TIMESTAMP
  `);

  let imported = 0;

  function resolveAuthorId(name) {
    if (authorIdCache.has(name)) return authorIdCache.get(name);
    insertAuthor.run(name, authorDisplayName(name), createSortKey(authorSortKey(name)), authorSearchName(name));
    const id = selectAuthor.get(name)?.id || null;
    authorIdCache.set(name, id);
    return id;
  }

  function resolveSeriesId(name) {
    if (seriesIdCache.has(name)) return seriesIdCache.get(name);
    insertSeries.run(name, seriesDisplayName(name), seriesSortName(name), seriesSearchName(name));
    const id = selectSeries.get(name)?.id || null;
    seriesIdCache.set(name, id);
    return id;
  }

  function resolveGenreId(name) {
    if (genreIdCache.has(name)) return genreIdCache.get(name);
    insertGenre.run(name, genreDisplayName(name), genreSortName(name), genreSearchName(name));
    const id = selectGenre.get(name)?.id || null;
    genreIdCache.set(name, id);
    return id;
  }

  /** Меньший batch = короче одна db.transaction(); в bulk — уступка после каждого batch. */
  const BATCH_SIZE = ftsBulkMode ? 350 : 120;
  const YIELD_EVERY_N_BATCHES = 1;
  let batchSeq = 0;
  for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
    throwIfCancelled();
    await waitIfPaused();
    const batchEnd = Math.min(i + BATCH_SIZE, filesToProcess.length);
    console.log(`[folder-index] files ${i + 1}–${batchEnd} of ${filesToProcess.length} (source_id=${source.id})`);
    const batch = filesToProcess.slice(i, i + BATCH_SIZE);
    const batchRows = [];

    const metaStartedAt = Date.now();
    const extracted = await asyncMapLimit(batch, metadataExtractConcurrency, async (file) => {
      throwIfCancelled();
      await waitIfPaused();
      let meta;
      try {
        meta = await extractMetadata(file.fullPath, file.relativePath, file.ext, { zipEntry: file.zipEntry });
      } catch {
        return null;
      }
      let archiveName = '';
      let fileName;
      if (file.zipEntry) {
        archiveName = file.zipPath.replace(/\\/g, '/');
        fileName = file.zipEntry.replace(/\.[^.]+$/, '');
      } else {
        fileName = file.relativePath.replace(/\.[^.]+$/, '').replace(/\\/g, '/');
      }

      const displayName = file.zipEntry
        ? path.parse(file.zipEntry).name
        : path.parse(file.relativePath).name;

      const title = normalizeText(meta.title) || displayName;
      const authors = normalizeText(meta.authors) || '';
      const series = normalizeText(meta.series) || '';
      const seriesNo = normalizeText(meta.seriesNo) || '';

      const rawRow = {
        id: makeBookId(source.id, file.relativePath),
        title,
        authors,
        genres: normalizeText(meta.genres) || '',
        series,
        seriesNo,
        fileName,
        archiveName,
        size: Number(file._statSize) || 0,
        libId: '',
        deleted: 0,
        ext: file.ext,
        date: normalizeText(meta.date) || '',
        lang: normalizeText(meta.lang) || '',
        keywords: normalizeText(meta.keywords) || ''
      };
      return { rawRow };
    });
    const metaMs = Date.now() - metaStartedAt;

    for (const item of extracted) {
      if (!item?.rawRow) continue;
      batchRows.push(item.rawRow);
    }

    const txStartedAt = Date.now();
    const tx = db.transaction((rows) => {
      for (const rawRow of rows) {
        const row = enrichBookRow(rawRow);
        if (!row || suppressedIds.has(row.id)) continue;
        row.sourceId = source.id;
        insertBook.run(row);

        if (incremental) {
          unlinkAuthors.run(row.id);
          unlinkSeries.run(row.id);
          unlinkGenres.run(row.id);
        }

        for (const authorName of splitAuthorValues(row.authors)) {
          const authorId = resolveAuthorId(authorName);
          if (authorId) linkAuthor.run(row.id, authorId);
        }

        if (row.series) {
          const seriesId = resolveSeriesId(row.series);
          if (seriesId) linkSeries.run(row.id, seriesId);
        }

        for (const genreName of splitFacetValues(row.genres)) {
          const genreId = resolveGenreId(genreName);
          if (genreId) linkGenre.run(row.id, genreId);
        }

        imported++;
      }
    });
    tx(batchRows);
    throwIfCancelled();
    const txMs = Date.now() - txStartedAt;

    if (adaptiveConcurrencyEnabled) {
      const loopLagMs = await measureEventLoopLagMs();
      const isSlowBatch = metaMs > 6500 || txMs > 4200 || loopLagMs > 120;
      const isFastBatch = metaMs < 2200 && txMs < 1600 && loopLagMs < 35;

      if (isSlowBatch) {
        slowBatchStreak += 1;
        fastBatchStreak = 0;
      } else if (isFastBatch) {
        fastBatchStreak += 1;
        slowBatchStreak = 0;
      } else {
        fastBatchStreak = 0;
        slowBatchStreak = 0;
      }

      if (slowBatchStreak >= 2 && metadataExtractConcurrency > 1) {
        metadataExtractConcurrency -= 1;
        slowBatchStreak = 0;
        fastBatchStreak = 0;
        console.log(`[folder-index] adaptive concurrency down -> ${metadataExtractConcurrency} (meta=${metaMs}ms tx=${txMs}ms lag=${loopLagMs}ms)`);
      } else if (fastBatchStreak >= 3 && metadataExtractConcurrency < maxMetadataExtractConcurrency) {
        metadataExtractConcurrency += 1;
        slowBatchStreak = 0;
        fastBatchStreak = 0;
        console.log(`[folder-index] adaptive concurrency up -> ${metadataExtractConcurrency} (meta=${metaMs}ms tx=${txMs}ms lag=${loopLagMs}ms)`);
      }
    }
    batchSeq += 1;
    const lastBatch = i + BATCH_SIZE >= filesToProcess.length;
    if (batchSeq % YIELD_EVERY_N_BATCHES === 0 || lastBatch) {
      await yieldEventLoop();
    }

    if (onProgress) {
      onProgress({ processed: Math.min(i + BATCH_SIZE, filesToProcess.length), total: filesToProcess.length, imported });
    }
  }

  setMeta(metaKey, JSON.stringify(currentFiles));
  updateSourceBookCount(source.id);
  updateSourceIndexedAt(source.id);

  const resolvedSidecarRoot = path.resolve(source.path);
  try {
    const { refreshFlibustaSidecarForSource } = await import('./flibusta-sidecar.js');
    await refreshFlibustaSidecarForSource(source.id, resolvedSidecarRoot, {
      rebuildAuxiliary: !incremental,
      onProgress: onProgress
        ? (msg) => {
            onProgress({
              processed: filesToProcess.length,
              total: filesToProcess.length,
              imported,
              currentArchive: msg
            });
          }
        : null
    });
  } catch (err) {
    console.error('[folder-index] Sidecar refresh failed:', err.message);
  }

  console.log(`[folder-index] done source_id=${source.id} imported=${imported} scanned_files=${allFiles.length}`);
  logSystemEvent('info', 'index', 'folder index import pass completed', {
    sourceId: source.id,
    name: sourceLabel,
    imported,
    scannedFiles: allFiles.length,
    processed: filesToProcess.length,
    skipped: allFiles.length - filesToProcess.length,
    deduplicated: 0
  });
  const result = {
    imported,
    total: allFiles.length,
    processed: filesToProcess.length,
    skipped: allFiles.length - filesToProcess.length,
    deduplicated: 0
  };
  completedSuccessfully = true;
  
  // Фоновое предизвлечение обложек/аннотаций для новых книг (не блокирует завершение индексации)
  setImmediate(() => warmupBookDetailsCache(source.id));
  
  return result;
  } finally {
    if (ftsBulkMode && completedSuccessfully) {
      logSystemEvent('info', 'index', 'folder FTS full rebuild started', { sourceId: source.id, name: sourceLabel });
      const ftsT0 = Date.now();
      try {
        await rebuildBooksFtsFromContent();
        logSystemEvent('info', 'index', 'folder FTS full rebuild completed', {
          sourceId: source.id,
          name: sourceLabel,
          seconds: Number(((Date.now() - ftsT0) / 1000).toFixed(1))
        });
      } catch (err) {
        console.error('[folder-index] FTS rebuild failed:', err.message);
        logSystemEvent('error', 'index', 'folder FTS full rebuild failed', {
          sourceId: source.id,
          name: sourceLabel,
          error: err.message
        });
      }
      ensureBooksFtsTriggers();
      setMeta(BOOKS_FTS_DIRTY_META_KEY, '0');
    } else if (ftsBulkMode) {
      // Cancellation/failure: keep DB responsive, do not run expensive FTS rebuild now.
      ensureBooksFtsTriggers();
      setMeta(BOOKS_FTS_DIRTY_META_KEY, '1');
    }
    if (ftsBulkMode) {
      endFastSqliteImport();
    }
  }
}
