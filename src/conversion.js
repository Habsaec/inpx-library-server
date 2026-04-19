import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { config } from './config.js';
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
  return sanitizeBaseName(parts.join(' ')) || sanitizeBaseName(book.fileName || book.title || book.id || 'book');
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

const CONVERTER_TIMEOUT_MS = 120_000;
const CONVERTER_OUTPUT_MAX = 1024 * 1024;

async function runConverter(args) {
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
      reject(new Error('fb2cng timed out'));
    }, CONVERTER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
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
    await acquireConverterSlot();
    try {
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
        await runConverter(convertArgs);
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
      releaseConverterSlot();
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
