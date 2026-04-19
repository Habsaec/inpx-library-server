import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sevenBin from '7zip-bin';
import { ARCHIVE_MAX_ENTRY_BYTES } from './constants.js';

const MAX_SLT_OUTPUT = 64 * 1024 * 1024;
const MAX_BOOK_SIZE = ARCHIVE_MAX_ENTRY_BYTES;

/* ── Семафор: ограничение параллельных 7z-процессов ── */
const SEVEN_Z_MAX_CONCURRENT = Number(process.env.SEVEN_Z_MAX_CONCURRENT) || 6;
const SEVEN_Z_MAX_QUEUE = 50;
let active7z = 0;
const queue7z = [];

function acquire7zSlot() {
  if (active7z < SEVEN_Z_MAX_CONCURRENT) {
    active7z++;
    return Promise.resolve();
  }
  if (queue7z.length >= SEVEN_Z_MAX_QUEUE) {
    return Promise.reject(new Error('Очередь 7z переполнена, попробуйте позже'));
  }
  return new Promise((resolve, reject) => queue7z.push({ resolve, reject }));
}

function release7zSlot() {
  if (queue7z.length > 0) {
    queue7z.shift().resolve();
  } else {
    active7z--;
  }
}

function parseTimeoutMs(envName, defaultMs) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/** Зависший 7z иначе блокирует индексацию бесконечно (повреждённый .7z, антивирус). */
const SEVEN_Z_LIST_TIMEOUT_MS = parseTimeoutMs('SEVEN_Z_LIST_TIMEOUT_MS', 25 * 60 * 1000);
const SEVEN_Z_EXTRACT_TIMEOUT_MS = parseTimeoutMs('SEVEN_Z_EXTRACT_TIMEOUT_MS', 15 * 60 * 1000);

/** Кэш успешно выбранного бинарника (пустой explicit). */
let cachedSevenZipBinary = null;

function tryChmodBundledExecutable(bundledPath) {
  if (process.platform === 'win32' || !bundledPath || !sevenBin.path7za) return;
  if (path.resolve(bundledPath) !== path.resolve(sevenBin.path7za)) return;
  try {
    fs.accessSync(bundledPath, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(bundledPath, 0o755);
    } catch {
      /* Docker read-only FS и т.п. */
    }
  }
}

function isExecutableFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const st = fs.statSync(filePath);
  if (!st.isFile()) return false;
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Путь к 7z/7za: explicit / SEVEN_ZIP_PATH / npm `7zip-bin` / типичные пути в Linux (p7zip).
 * У bundled из npm часто нет +x в образе Docker — тогда берётся системный 7z или chmod.
 */
export function getSevenZipBinary(explicit) {
  const trimmedExplicit =
    explicit != null && String(explicit).trim() !== '' ? String(explicit).trim() : '';
  if (!trimmedExplicit && cachedSevenZipBinary) {
    return cachedSevenZipBinary;
  }

  const bundled = sevenBin.path7za;
  if (bundled) {
    tryChmodBundledExecutable(bundled);
  }

  const candidates = [];
  const push = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };

  push(trimmedExplicit);
  push((process.env.SEVEN_ZIP_PATH || '').trim());
  push(bundled);

  if (process.platform !== 'win32') {
    push('/usr/bin/7z');
    push('/usr/bin/7za');
    push('/bin/7z');
  }

  for (const p of candidates) {
    if (isExecutableFile(p)) {
      if (!trimmedExplicit) {
        cachedSevenZipBinary = p;
      }
      return p;
    }
  }

  throw new Error(
    'Не найден исполняемый 7-Zip (7z/7za). В Docker: установите пакет p7zip (например apt-get install -y p7zip-full) ' +
      'и при необходимости задайте SEVEN_ZIP_PATH=/usr/bin/7z, либо выполните chmod +x на бинарнике из node_modules/7zip-bin.'
  );
}

export function isSevenZipPath(filePath) {
  return path.extname(filePath || '').toLowerCase() === '.7z';
}

function assertSafeInternalEntry(entryPath) {
  const n = String(entryPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!n || n.includes('..') || path.isAbsolute(n)) {
    throw new Error('Invalid archive entry path');
  }
  return n;
}

function run7zCaptureStdout(bin, args, maxOut = MAX_SLT_OUTPUT, timeoutMs = SEVEN_Z_LIST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            reject(new Error(`7z: таймаут команды (${Math.round(timeoutMs / 1000)} с). Проверьте архив и SEVEN_Z_LIST_TIMEOUT_MS.`));
          }, timeoutMs)
        : null;
    const chunks = [];
    let stderr = '';
    let size = 0;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxOut) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done(new Error('7z list output too large'));
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (e) => done(e));
    child.on('close', (code) => {
      if (code !== 0) {
        done(new Error(stderr.trim() || `7z exited with code ${code}`));
        return;
      }
      done(null, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * Разбор вывода `7z l -slt` — список файлов с размером.
 */
export function parseSevenZipListSlt(text) {
  const blocks = text.split(/\r?\n\r?\n/);
  const files = [];
  for (const block of blocks) {
    const pathLine = block.match(/^Path = (.+)$/m);
    if (!pathLine) continue;
    const p = pathLine[1].trim();
    if (!p || p.endsWith('/') || p.endsWith('\\')) continue;
    const sizeLine = block.match(/^Size = (\d+)$/m);
    const uncompressedSize = sizeLine ? parseInt(sizeLine[1], 10) : 0;
    files.push({ path: p.replace(/\\/g, '/'), uncompressedSize });
  }
  return files;
}

export async function listSevenZipEntries(archivePath, binOverride) {
  const bin = getSevenZipBinary(binOverride);
  await acquire7zSlot();
  let out;
  try {
    out = await run7zCaptureStdout(bin, ['l', '-slt', archivePath]);
  } finally {
    release7zSlot();
  }
  await new Promise((resolve) => setImmediate(resolve));
  const normalizedArchive = String(archivePath || '').replace(/\\/g, '/').toLowerCase();
  return parseSevenZipListSlt(out).filter((entry) => {
    const p = String(entry?.path || '').replace(/\\/g, '/').toLowerCase();
    return p && p !== normalizedArchive;
  });
}

export async function readSevenZipEntry(archivePath, entryPath, binOverride) {
  const internal = assertSafeInternalEntry(entryPath);
  const bin = getSevenZipBinary(binOverride);
  const timeoutMs = SEVEN_Z_EXTRACT_TIMEOUT_MS;
  await acquire7zSlot();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['e', '-so', archivePath, internal], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            reject(
              new Error(
                `7z: таймаут извлечения (${Math.round(timeoutMs / 1000)} с). SEVEN_Z_EXTRACT_TIMEOUT_MS.`
              )
            );
          }, timeoutMs)
        : null;
    const chunks = [];
    let stderr = '';
    let total = 0;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    child.stdout.on('data', (c) => {
      total += c.length;
      if (total > MAX_BOOK_SIZE) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        done(new Error(`7z entry too large (>${MAX_BOOK_SIZE / (1024 * 1024)} MB)`));
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', (e) => done(e));
    child.on('close', (code) => {
      if (code !== 0) {
        done(new Error(stderr.trim() || `7z extract exited with code ${code}`));
        return;
      }
      done(null, Buffer.concat(chunks));
    });
  }).finally(() => release7zSlot());
}

/**
 * Test 7z archive integrity (`7z t`). Returns { ok, error? }.
 */
export async function testSevenZipArchive(archivePath, binOverride) {
  const bin = getSevenZipBinary(binOverride);
  await acquire7zSlot();
  try {
    await run7zCaptureStdout(bin, ['t', archivePath], MAX_SLT_OUTPUT, SEVEN_Z_LIST_TIMEOUT_MS);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    release7zSlot();
  }
}
