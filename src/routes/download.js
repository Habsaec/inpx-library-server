/**
 * Маршруты скачивания книг: /download/:id, /download/batch (GET, POST).
 * Экспортирует batch-хелперы, используемые также e-reader модулем.
 */
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { t, tp } from '../i18n.js';
import { ApiErrorCode } from '../api-errors.js';
import { requireDownloadAuth } from '../middleware/auth.js';
import { BATCH_DOWNLOAD_MAX } from '../constants.js';
import { getShelfById, getShelfBooks } from '../db.js';
import { getBookById, getBooksByIds, getAllBookIdsByFacet } from '../inpx.js';
import { logSystemEvent } from '../services/system-events.js';
import { resolveDownload } from '../conversion.js';

const batchDownloadLocks = new Set();

export function normalizeBatchIdsParam(raw) {
  if (raw === undefined || raw === null) return null;
  const parts = Array.isArray(raw)
    ? raw.flatMap((x) => String(x).split(','))
    : String(raw).split(',');
  return parts.map((s) => s.trim()).filter(Boolean).map(String);
}

/** Порядок как в запросе; только существующие книги, без дубликатов, лимит BATCH_DOWNLOAD_MAX. */
export function resolveAdhocBookIdsFromClientList(rawIds) {
  const seen = new Set();
  const bookIds = [];
  for (const id of rawIds) {
    const sid = String(id).trim();
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    if (bookIds.length >= BATCH_DOWNLOAD_MAX) break;
    const book = getBookById(sid);
    if (book) bookIds.push(book.id);
  }
  return bookIds;
}

export function resolveBatchScopeBookIds(req, source) {
  const facet = String(source.facet || '').trim();
  const value = String(source.value ?? '').trim();
  const shelfId = source.shelf ? Number(source.shelf) : 0;

  let bookIds = [];
  let archiveName = 'books';

  if (shelfId && req.user) {
    const shelf = getShelfById(shelfId, req.user.username);
    if (!shelf) {
      return { error: 404, code: ApiErrorCode.SHELF_NOT_FOUND, message: t('shelf.notFound') };
    }
    const shelfBooks = getShelfBooks(shelfId, req.user.username);
    bookIds = shelfBooks.map((b) => b.id);
    archiveName = shelf.name;
  } else if (facet && value) {
    if (facet !== 'authors' && facet !== 'series') {
      return { error: 400, code: ApiErrorCode.BATCH_SCOPE_FACET_ONLY, message: t('api.batch.scopeFacetOnly') };
    }
    bookIds = getAllBookIdsByFacet(facet, value);
    archiveName = value;
  } else {
    return { error: 400, code: ApiErrorCode.BATCH_SCOPE_MISSING, message: t('api.batch.scopeMissingParams') };
  }

  if (!bookIds.length) {
    return { error: 404, code: ApiErrorCode.BATCH_BOOKS_NOT_FOUND, message: t('api.error.booksNotFound') };
  }

  return { bookIds, archiveName };
}

/** Параметр «каждая книга в своём ZIP» из query (GET) или body (POST). */
function parsePerBookZip(req) {
  try {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.perBookZip : undefined;
    const q = req.query?.perBookZip;
    const v = b !== undefined && b !== null && b !== '' ? b : q;
    if (v === true || v === 1) return true;
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
  } catch { /* */ }
  return false;
}

/** Один файл — один небольшой ZIP в памяти (для вложения в общий архив). */
function bufferSingleFileZip(content, entryName) {
  return new Promise((resolve, reject) => {
    const inner = archiver('zip', { store: true, forceZip64: false, forceLocalTime: true });
    const chunks = [];
    inner.on('data', (chunk) => chunks.push(chunk));
    inner.on('end', () => resolve(Buffer.concat(chunks)));
    inner.on('error', reject);
    inner.append(content, { name: entryName });
    inner.finalize().catch(reject);
  });
}

function sanitizeZipEntryName(value, fallback = 'book.bin') {
  const raw = String(value || '').trim();
  const safe = (raw || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!safe) return fallback;
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length) || 'book';
  const maxBase = 80;
  const clippedBase = base.slice(0, maxBase).trim() || 'book';
  const clippedExt = ext.slice(0, 20);
  return `${clippedBase}${clippedExt}`.trim();
}

async function streamBatchZipArchive(req, res, next, { bookIds, archiveName, format }) {
  const lockKey = req.user?.username || `anon:${req.ip}`;
  const startedAt = Date.now();
  try {
    if (bookIds.length > BATCH_DOWNLOAD_MAX) {
      return res.status(400).send(tp('api.batch.downloadMax', { max: BATCH_DOWNLOAD_MAX }));
    }

    if (batchDownloadLocks.has(lockKey)) {
      return res.status(429).send(t('api.batch.downloadInProgress'));
    }
    batchDownloadLocks.add(lockKey);

    const perBookZip = parsePerBookZip(req);
    const usedNames = new Map();
    const usedOuterZipBase = new Map();
    let includedCount = 0;
    let skippedMissing = 0;
    let skippedFailed = 0;
    const skippedDetails = [];
    let totalResolveMs = 0;
    let totalReadMs = 0;
    let totalPackMs = 0;

    const safeName = String(archiveName || 'books').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'books';
    const zipFileName = `${safeName}.zip`;

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFileName)}"`);
    res.setHeader('X-Batch-Requested', String(bookIds.length));
    res.type('application/zip');

    const archive = archiver('zip', { store: true, forceZip64: false, forceLocalTime: true });
    archive.on('error', () => {
      archive.destroy();  // Explicitly destroy to prevent stream leak
      batchDownloadLocks.delete(lockKey);
      if (!res.headersSent) {
        res.status(500).send(t('api.batch.archiveError'));
      }
    });
    res.on('close', () => {
      if (!archive.finalized) {
        archive.destroy();
      }
      batchDownloadLocks.delete(lockKey);
    });
    archive.pipe(res);

    let cursor = 0;
    const normalizedFormat = String(format || '').toLowerCase();
    const isConversionBatch = normalizedFormat && normalizedFormat !== 'fb2';
    const defaultWorkers = isConversionBatch ? 4 : 12;
    const envWorkerRaw = isConversionBatch
      ? Number(process.env.BATCH_CONVERT_WORKERS || defaultWorkers)
      : Number(process.env.BATCH_DOWNLOAD_WORKERS || defaultWorkers);
    const envWorkers = Math.max(1, Math.min(20, envWorkerRaw || defaultWorkers));
    const workerCount = Math.max(1, Math.min(envWorkers, bookIds.length));
    const sourceExtStats = Object.create(null);
    const booksMap = getBooksByIds(bookIds);
    let fatalError = null;
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        if (fatalError) return;
        const idx = cursor++;
        if (idx >= bookIds.length) return;
        const bookId = bookIds[idx];
        try {
          const book = booksMap.get(bookId);
          if (!book) {
            skippedMissing++;
            if (skippedDetails.length < 50) skippedDetails.push(`${bookId}: missing`);
            continue;
          }
          const sourceExt = String(book.ext || '').toLowerCase() || 'unknown';
          sourceExtStats[sourceExt] = (sourceExtStats[sourceExt] || 0) + 1;
          const tResolve = Date.now();
          const download = await resolveDownload(book, format || undefined);
          totalResolveMs += Date.now() - tResolve;

          let fileName = sanitizeZipEntryName(download.fileName, `book-${bookId}.${download.format || 'fb2'}`);
          const count = usedNames.get(fileName) || 0;
          if (count > 0) {
            const ext = path.extname(fileName);
            const base = fileName.slice(0, fileName.length - ext.length);
            fileName = `${base} (${count})${ext}`;
          }
          usedNames.set(fileName, count + 1);

          if (perBookZip) {
            const tRead = Date.now();
            let content;
            if (download.filePath) {
              content = await fs.promises.readFile(download.filePath);
            } else {
              content = download.content;
            }
            totalReadMs += Date.now() - tRead;
            const tPack = Date.now();
            const innerBuf = await bufferSingleFileZip(content, fileName);
            totalPackMs += Date.now() - tPack;
            const ext = path.extname(fileName);
            const stem = fileName.slice(0, fileName.length - ext.length) || 'book';
            const n = usedOuterZipBase.get(stem) || 0;
            usedOuterZipBase.set(stem, n + 1);
            const outerName = sanitizeZipEntryName(n === 0 ? `${stem}.zip` : `${stem} (${n}).zip`, `book-${bookId}.zip`);
            archive.append(innerBuf, { name: outerName });
          } else if (download.filePath) {
            archive.file(download.filePath, { name: fileName });
          } else {
            archive.append(download.content, { name: fileName });
          }
          includedCount++;
        } catch (error) {
          if (error?.code === 'FB2CNG_NOT_CONFIGURED') {
            fatalError = error;
            cursor = bookIds.length;
            return;
          }
          skippedFailed++;
          if (skippedDetails.length < 50) {
            const message = String(error?.message || 'failed').replace(/\s+/g, ' ').slice(0, 180);
            skippedDetails.push(`${bookId}: ${message}`);
          }
        }
      }
    });
    await Promise.all(workers);
    if (fatalError) {
      throw fatalError;
    }
    if (skippedMissing + skippedFailed > 0 || includedCount === 0) {
      const report = [
        `requested: ${bookIds.length}`,
        `included: ${includedCount}`,
        `skipped_missing: ${skippedMissing}`,
        `skipped_failed: ${skippedFailed}`,
        '',
        ...skippedDetails
      ].join('\n');
      archive.append(Buffer.from(report, 'utf8'), { name: '_batch_report.txt' });
    }

    await archive.finalize();
    const elapsedMs = Date.now() - startedAt;
    if (String(process.env.DEBUG_BATCH || '') === '1') {
      logSystemEvent('info', 'operations', 'batch download timing', {
        user: req.user?.username || 'anon',
        requested: bookIds.length,
        included: includedCount,
        skipped: skippedMissing + skippedFailed,
        elapsedMs,
        resolveMs: totalResolveMs,
        resolveAvgMs: includedCount ? Math.round(totalResolveMs / includedCount) : 0,
        readMs: totalReadMs,
        packMs: totalPackMs,
        workers: workerCount,
        format: String(format || 'auto'),
        sourceExt: JSON.stringify(sourceExtStats),
        perBookZip
      });
    }
  } catch (error) {
    batchDownloadLocks.delete(lockKey);
    if (error?.code === 'FB2CNG_NOT_CONFIGURED') {
      return res.status(503).send(t('api.email.err.converterMissing'));
    }
    next(error);
  }
}

/**
 * @param {import('express').Application} app
 */
export function registerDownloadRoutes(app) {
  app.get('/download/batch', requireDownloadAuth, async (req, res, next) => {
    try {
      const format = String(req.query.format || '').trim().toLowerCase();
      const q = req.query;
      const shelfId = q.shelf ? Number(q.shelf) : 0;
      const facet = String(q.facet || '').trim();
      const value = String(q.value ?? '').trim();
      const hasScope =
        (shelfId > 0 && req.user) || (facet && value && (facet === 'authors' || facet === 'series'));
      const requested = normalizeBatchIdsParam(q.ids);

      if (!hasScope && requested !== null && requested.length) {
        const bookIds = resolveAdhocBookIdsFromClientList(requested);
        if (!bookIds.length) {
          return res.status(400).send(t('api.batch.noMatchingBooks'));
        }
        await streamBatchZipArchive(req, res, next, { bookIds, archiveName: 'books', format });
        return;
      }

      const scope = resolveBatchScopeBookIds(req, q);
      if (scope.error) {
        return res.status(scope.error).send(scope.message);
      }
      let { bookIds, archiveName } = scope;
      if (requested !== null) {
        if (!requested.length) {
          return res.status(400).send(t('api.batch.noBookIds'));
        }
        bookIds = resolveAdhocBookIdsFromClientList(requested);
        if (!bookIds.length) {
          return res.status(400).send(t('api.batch.noMatchingBooksInList'));
        }
      }
      await streamBatchZipArchive(req, res, next, { bookIds, archiveName, format });
    } catch (error) {
      next(error);
    }
  });

  app.post('/download/batch', requireDownloadAuth, async (req, res, next) => {
    try {
      const format = String(req.body?.format || '').trim().toLowerCase();
      const body = req.body || {};
      const hasShelf = Number(body.shelf) > 0;
      const hasFacet =
        (body.facet === 'authors' || body.facet === 'series') && String(body.value ?? '').trim().length > 0;

      const rawIds = Array.isArray(body.ids)
        ? body.ids.map((x) => String(x).trim()).filter(Boolean)
        : normalizeBatchIdsParam(body.ids);

      if (!hasShelf && !hasFacet) {
        if (rawIds === null || !rawIds.length) {
          return res.status(400).send(t('api.batch.scopeMissingParams'));
        }
        const bookIds = resolveAdhocBookIdsFromClientList(rawIds);
        if (!bookIds.length) {
          return res.status(400).send(t('api.batch.noMatchingBooks'));
        }
        await streamBatchZipArchive(req, res, next, { bookIds, archiveName: 'books', format });
        return;
      }

      const scope = resolveBatchScopeBookIds(req, body);
      if (scope.error) {
        return res.status(scope.error).send(scope.message);
      }
      let { bookIds, archiveName } = scope;
      if (rawIds !== null) {
        if (!rawIds.length) {
          return res.status(400).send(t('api.batch.noBookIds'));
        }
        bookIds = resolveAdhocBookIdsFromClientList(rawIds);
        if (!bookIds.length) {
          return res.status(400).send(t('api.batch.noMatchingBooksInList'));
        }
      }
      await streamBatchZipArchive(req, res, next, { bookIds, archiveName, format });
    } catch (error) {
      next(error);
    }
  });

  app.get('/download/:id', requireDownloadAuth, async (req, res, next) => {
    try {
      const book = getBookById(req.params.id);
      if (!book) {
        return res.status(404).send(t('book.notFound'));
      }

      const download = await resolveDownload(book, req.query.format);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(download.fileName)}"`);
      res.type(download.mimeType);
      if (download.filePath) {
        const buf = await fs.promises.readFile(download.filePath);
        res.send(buf);
        return;
      }
      res.send(download.content);
    } catch (error) {
      if (error?.code === 'FB2CNG_NOT_CONFIGURED') {
        return res.status(503).send(t('api.email.err.converterMissing'));
      }
      next(error);
    }
  });
}
