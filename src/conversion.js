import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { logSystemEvent } from './services/system-events.js';
import { readBookBuffer, readBookBufferForDelivery } from './fb2.js';
import {
  DOWNLOAD_FORMATS,
  FORMAT_LABELS,
  getAvailableDownloadFormats
} from './download-formats.js';
const MIME_TYPES = {
  fb2: 'application/octet-stream',
  epub: 'application/epub+zip',
  epub2: 'application/epub+zip',
  epub3: 'application/epub+zip',
  kepub: 'application/epub+zip',
  kfx: 'application/octet-stream',
  azw8: 'application/octet-stream',
  azw3: 'application/x-mobipocket-ebook',
  mobi: 'application/x-mobipocket-ebook'
};
const FILE_EXTENSIONS = {
  fb2: 'fb2',
  epub: 'epub',
  epub2: 'epub',
  epub3: 'epub',
  kepub: 'kepub.epub',
  kfx: 'kfx',
  azw8: 'azw8',
  azw3: 'azw3',
  mobi: 'mobi'
};
const conversionLocks = new Map();
const converterWaiters = [];
let activeConverters = 0;

const CONVERSION_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONVERSION_CACHE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function cleanupConversionCache() {
  try {
    const dir = config.conversionCacheDir;
    if (!dir) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const filePath = path.join(dir, entry.name);
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > CONVERSION_CACHE_MAX_AGE_MS) {
          await fs.promises.unlink(filePath);
          removed++;
        }
      } catch { /* ignore per-file errors */ }
    }
    if (removed > 0) console.log(`[conversion] cache cleanup: removed ${removed} stale file(s)`);
  } catch (err) {
    console.warn('[conversion] cache cleanup error:', err.message);
  }
}

const STALE_TEMP_SESSION_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

async function cleanupStaleTempSessions() {
  try {
    const dir = config.conversionTempDir;
    if (!dir) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const now = Date.now();
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
      try {
        const dirPath = path.join(dir, entry.name);
        const stat = await fs.promises.stat(dirPath);
        if (now - stat.mtimeMs > STALE_TEMP_SESSION_MAX_AGE_MS) {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          removed++;
        }
      } catch { /* ignore per-dir errors */ }
    }
    if (removed > 0) console.log(`[conversion] temp session cleanup: removed ${removed} stale dir(s)`);
  } catch (err) {
    console.warn('[conversion] temp session cleanup error:', err.message);
  }
}

// Synchronous startup cleanup of stale temp directories (before async periodic cleanup)
function cleanupStaleTempDirsSync() {
  try {
    const tempBase = config.conversionTempDir;
    if (!tempBase || !fs.existsSync(tempBase)) return;

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const entries = fs.readdirSync(tempBase, { withFileTypes: true });
    let cleaned = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue;
      try {
        const dirPath = path.join(tempBase, entry.name);
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > ONE_HOUR) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch (e) {
        // Ignore individual cleanup failures
      }
    }

    if (cleaned > 0) {
      console.log(`[conversion] startup cleanup: removed ${cleaned} stale temp directories`);
    }
  } catch (err) {
    console.warn('[conversion] startup cleanup failed:', err.message);
  }
}

// Run synchronous cleanup immediately on module load
cleanupStaleTempDirsSync();

// Run async cleanup at startup and every 6 hours
try {
  fs.mkdirSync(config.conversionCacheDir, { recursive: true });
} catch { /* directory may already exist or config not set */ }
cleanupConversionCache();
cleanupStaleTempSessions();
setInterval(cleanupConversionCache, CONVERSION_CACHE_CLEANUP_INTERVAL_MS).unref();
setInterval(cleanupStaleTempSessions, CONVERSION_CACHE_CLEANUP_INTERVAL_MS).unref();
const DEFAULT_MAX_CONVERTERS = (() => {
  const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : 4;
  return Math.max(2, Math.min(6, Math.floor(cpuCount / 2) || 2));
})();
const MAX_CONVERTERS = Math.max(1, Math.min(8, Number(process.env.FB2CNG_MAX_PARALLEL) || DEFAULT_MAX_CONVERTERS));

async function acquireConverterSlot() {
  if (activeConverters < MAX_CONVERTERS) {
    activeConverters += 1;
    return;
  }
  await new Promise((resolve) => converterWaiters.push(resolve));
  activeConverters += 1;
}

function releaseConverterSlot() {
  activeConverters = Math.max(0, activeConverters - 1);
  const next = converterWaiters.shift();
  if (next) next();
}

/**
 * Конвертация FB2 через fb2cng: при отсутствии бинарника или конфига — ошибка с `code === 'FB2CNG_NOT_CONFIGURED'`.
 * Маршруты скачивания/email отвечают 503 с понятным текстом.
 */

const TRANSLIT_MAP = {
  'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya',
  'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
  'І':'I','і':'i','Ї':'Yi','ї':'yi','Є':'Ye','є':'ye','Ґ':'G','ґ':'g'
};

function transliterate(value) {
  return String(value || '').replace(/[\u0400-\u04FF\u0490\u0491]/g, ch => TRANSLIT_MAP[ch] ?? ch);
}

function sanitizeBaseName(value = '') {
  const normalized = String(value || '').trim() || 'book';
  return (normalized.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'book').slice(0, 200);
}

function formatAuthorFileName(value = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const authors = raw
    .split(':')
    .map((author) => author.split(',').map((part) => part.trim()).filter(Boolean).join(' '))
    .filter(Boolean);
  if (!authors.length) {
    return raw;
  }
  return authors.join(', ');
}

function getBookBaseName(book) {
  const parts = [
    formatAuthorFileName(book.authors),
    String(book.title || '').trim(),
    String(book.series || '').trim(),
    String(book.seriesNo || '').trim()
  ].filter(Boolean);
  const raw = sanitizeBaseName(parts.join(' ')) || sanitizeBaseName(book.fileName || book.title || book.id || 'book');
  return transliterate(raw);
}

function getFormatExtension(format) {
  return FILE_EXTENSIONS[format] || format;
}

function getFormatMimeType(format) {
  return MIME_TYPES[format] || 'application/octet-stream';
}

function getBookFormatFileName(book, format) {
  return `${getBookBaseName(book)}.${getFormatExtension(format)}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getBookCacheKey(book, format) {
  return crypto.createHash('sha1')
    .update(
      [
        book.id,
        book.archiveName,
        book.fileName,
        format,
        String(book.size ?? ''),
        String(book.date ?? ''),
        String(book.importedAt ?? '')
      ].join(':')
    )
    .digest('hex');
}

function getFormatCachePath(book, format) {
  return path.join(config.conversionCacheDir, `${getBookCacheKey(book, format)}.${getFormatExtension(format)}`);
}

/**
 * Resource limits for fb2cng child processes.
 * CONVERTER_TIMEOUT_MS — hard kill after 2 minutes to prevent hanging conversions.
 * CONVERTER_OUTPUT_MAX — cap stdout/stderr capture at 10 MB per stream; prevents
 *   unbounded memory growth when a converter emits verbose diagnostics or binary
 *   garbage.  With up to MAX_CONVERTERS (6) parallel slots this bounds total
 *   buffered output to ~120 MB worst-case.
 */
const CONVERTER_TIMEOUT_MS = 120_000;
const CONVERTER_OUTPUT_MAX = 10 * 1024 * 1024; // 10 MB per stream — intentional resource limit

async function runConverter(args, bookInfo = {}) {
  await fs.promises.access(config.fb2cngPath, fs.constants.R_OK);
  const fullArgs = config.fb2cngConfigPath
    ? ['-c', config.fb2cngConfigPath, ...args]
    : args;
  await new Promise((resolve, reject) => {
    const child = spawn(config.fb2cngPath, fullArgs, {
      cwd: config.conversionTempDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
      // Log timeout as a system event with book details for debugging
      const detail = {
        bookId: bookInfo.id || 'unknown',
        title: String(bookInfo.title || '').slice(0, 120),
        authors: String(bookInfo.authors || '').slice(0, 120),
        timeoutMs: CONVERTER_TIMEOUT_MS,
        args: fullArgs.join(' ').slice(0, 200)
      };
      logSystemEvent('error', 'conversion', 'fb2cng process timed out — killed', detail);
      console.error(`[conversion] fb2cng timed out after ${CONVERTER_TIMEOUT_MS} ms for book ${detail.bookId}: ${detail.title}`);
      reject(new Error(`fb2cng timed out after ${CONVERTER_TIMEOUT_MS} ms for book "${detail.title}" (${detail.bookId})`));
    }, CONVERTER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      // Intentional cap: discard output beyond CONVERTER_OUTPUT_MAX to prevent OOM
      if (stdout.length < CONVERTER_OUTPUT_MAX) stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < CONVERTER_OUTPUT_MAX) stderr += String(chunk || '');
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`fb2cng failed with code ${code}: ${(stderr || stdout).trim().slice(0, 500) || 'unknown error'}`));
    });
  });
}

async function convertFb2Book(book, format) {
  ensureDir(config.conversionTempDir);
  ensureDir(config.conversionCacheDir);
  const cachePath = getFormatCachePath(book, format);
  try {
    await fs.promises.access(cachePath, fs.constants.R_OK);
    return cachePath;
  } catch {
  }

  const lockKey = `${book.id}:${format}`;
  const existingLock = conversionLocks.get(lockKey);
  if (existingLock) {
    // Re-check cache after waiting — the previous holder may have succeeded
    const result = await existingLock;
    return result;
  }

  const work = (async () => {
    let slotAcquired = false;
    try {
      await acquireConverterSlot();
      slotAcquired = true;
      const sessionDir = await fs.promises.mkdtemp(path.join(config.conversionTempDir, 'job-'));
      try {
        const sourcePath = path.join(sessionDir, `${getBookBaseName(book)}.fb2`);
        const outputDir = path.join(sessionDir, 'out');
        ensureDir(outputDir);
        const rawBuffer = await readBookBufferForDelivery(book);
        await fs.promises.writeFile(sourcePath, rawBuffer);
        const convertArgs = ['convert', '--to', format, '--ow', '--nd'];
        if (format === 'kfx' || format === 'azw8') {
          convertArgs.push('--ebook');
        }
        convertArgs.push(sourcePath, outputDir);
        await runConverter(convertArgs, book);
        const outputItems = await fs.promises.readdir(outputDir, { withFileTypes: true });
        const files = outputItems.filter((item) => item.isFile()).map((item) => item.name);
        const expectedSuffix = `.${getFormatExtension(format)}`.toLowerCase();
        const matchedName = files.find((name) => name.toLowerCase().endsWith(expectedSuffix)) || files[0];
        if (!matchedName) {
          throw new Error(`fb2cng did not produce a ${format} file`);
        }
        await fs.promises.copyFile(path.join(outputDir, matchedName), cachePath);
        return cachePath;
      } finally {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
      }
    } finally {
      if (slotAcquired) releaseConverterSlot();
    }
  })();

  conversionLocks.set(lockKey, work);  // must be set synchronously before any await in work yields
  try {
    return await work;
  } finally {
    conversionLocks.delete(lockKey);
  }
}

function normalizeDownloadFormat(book, requestedFormat) {
  const sourceFormat = String(book?.ext || 'fb2').toLowerCase();
  const format = String(requestedFormat || sourceFormat).toLowerCase();
  const available = new Set(getAvailableDownloadFormats(book));
  if (!DOWNLOAD_FORMATS.has(format) || !available.has(format)) {
    return sourceFormat;
  }
  return format;
}

export { getAvailableDownloadFormats, FORMAT_LABELS, getFormatMimeType };

export async function resolveDownload(book, requestedFormat, options = {}) {
  const skipFb2DeliveryProcessing = options?.skipFb2DeliveryProcessing === true;
  const sourceFormat = String(book?.ext || 'fb2').toLowerCase();
  const format = normalizeDownloadFormat(book, requestedFormat);
  if (format === sourceFormat && sourceFormat !== 'fb2') {
    const content = await readBookBuffer(book);
    return {
      format,
      fileName: getBookFormatFileName(book, sourceFormat),
      mimeType: getFormatMimeType(sourceFormat),
      content
    };
  }
  if (format === 'fb2') {
    const content = skipFb2DeliveryProcessing
      ? await readBookBuffer(book)
      : await readBookBufferForDelivery(book);
    return {
      format,
      fileName: getBookFormatFileName(book, 'fb2'),
      mimeType: getFormatMimeType('fb2'),
      content
    };
  }
  if (!config.fb2cngPath) {
    const error = new Error('fb2cng path is not configured');
    error.code = 'FB2CNG_NOT_CONFIGURED';
    throw error;
  }
  const filePath = await convertFb2Book(book, format);
  return {
    format,
    fileName: getBookFormatFileName(book, format),
    mimeType: getFormatMimeType(format),
    filePath
  };
}
