import './load-env.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const libraryRoot = process.env.LIBRARY_ROOT || (process.platform === 'win32' ? '' : '/library');
const inpxFile = process.env.INPX_FILE || '';
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'library.db');
const conversionCacheDir = path.join(dataDir, 'converted-books');
const conversionTempDir = path.join(dataDir, 'tmp');

const WEAK_SECRETS = new Set(['inpx-library-local-secret', 'change-me-please', 'change-me', 'secret', 'password']);

function resolveSessionSecret() {
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret && !WEAK_SECRETS.has(envSecret) && envSecret.length >= 16) {
    return envSecret;
  }
  if (envSecret) {
    console.warn('[WARN] SESSION_SECRET слишком слабый или короткий — будет сгенерирован автоматически.');
  }
  const secretPath = path.join(dataDir, '.session-secret');
  try {
    const stored = fs.readFileSync(secretPath, 'utf8').trim();
    if (stored.length >= 32) return stored;
  } catch {}
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}

function resolveBundledFb2cngPath() {
  const candidates = process.platform === 'win32'
    ? [path.join(rootDir, 'converter', 'fbc.exe'), path.join(rootDir, 'converter', 'fbc')]
    : [path.join(rootDir, 'converter', 'fbc'), path.join(rootDir, 'converter', 'fbc.exe')];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

const bundledFb2cngPath = resolveBundledFb2cngPath();

function resolveFb2cngConfigPath() {
  const envPath = process.env.FB2CNG_CONFIG_PATH;
  if (envPath) return envPath;
  const candidate = path.join(rootDir, 'converter', 'fb2cng.yaml');
  return fs.existsSync(candidate) ? candidate : '';
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Целое из env: NaN, ±Infinity и вне диапазона → default с предупреждением в лог. */
function parseEnvInt(envName, raw, defaultValue, { min, max } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  const n = Number(raw);
  const lo = min ?? Number.MIN_SAFE_INTEGER;
  const hi = max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(n) || n < lo || n > hi) {
    console.warn(`[WARN] ${envName}: некорректное числовое значение "${raw}", используется ${defaultValue}`);
    return defaultValue;
  }
  return Math.trunc(n);
}

export const config = {
  rootDir,
  dataDir,
  dbPath,
  publicDir: path.join(rootDir, 'public'),
  libraryRoot,
  inpxFile,
  fb2cngPath: process.env.FB2CNG_PATH || bundledFb2cngPath,
  fb2cngConfigPath: resolveFb2cngConfigPath(),
  conversionCacheDir,
  conversionTempDir,
  port: parseEnvInt('PORT', process.env.PORT, 3000, { min: 0, max: 65535 }),
  sessionSecret: resolveSessionSecret(),
  sessionMaxAgeMs: parseEnvInt(
    'SESSION_MAX_AGE_MS',
    process.env.SESSION_MAX_AGE_MS,
    1000 * 60 * 60 * 24 * 14,
    { min: 0, max: Number.MAX_SAFE_INTEGER }
  ),
  sessionSecureCookie: parseBoolean(process.env.SESSION_SECURE_COOKIE, false),
  loginWindowMs: parseEnvInt('LOGIN_WINDOW_MS', process.env.LOGIN_WINDOW_MS, 1000 * 60 * 15, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  }),
  loginMaxAttempts: parseEnvInt('LOGIN_MAX_ATTEMPTS', process.env.LOGIN_MAX_ATTEMPTS, 10, {
    min: 1,
    max: 1_000_000
  }),
  trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseEnvInt('SMTP_PORT', process.env.SMTP_PORT, 587, { min: 1, max: 65535 }),
  smtpSecure: parseBoolean(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || '',
  /** Путь к 7za / 7z для .7z архивов; пусто — из npm `7zip-bin`. */
  sevenZipPath: (process.env.SEVEN_ZIP_PATH || '').trim(),
  /** Дублировать события (как в админке «События») в stdout/stderr для Docker. false / 0 — отключить. */
  eventsLogStdout: parseBoolean(process.env.EVENTS_STDOUT ?? process.env.EVENTS_LOG_STDOUT, true),
  /** Задержка перед post-index wal_checkpoint + ANALYZE (мс), чтобы HTTP успел обработать очередь после снятия флага индексации. */
  postIndexMaintenanceDelayMs: parseEnvInt(
    'POST_INDEX_MAINTENANCE_DELAY_MS',
    process.env.POST_INDEX_MAINTENANCE_DELAY_MS,
    2000,
    { min: 0, max: 600_000 }
  ),
  /** Если true, `/health` не отдаёт порт и лишние поля (для публичного мониторинга за прокси). */
  healthMinimal: parseBoolean(process.env.HEALTH_MINIMAL, false),

  // ── Cover thumbnails ─────────────────────────────
  coverMaxWidth: parseEnvInt('COVER_MAX_WIDTH', process.env.COVER_MAX_WIDTH, 220, { min: 32, max: 1200 }),
  coverMaxHeight: parseEnvInt('COVER_MAX_HEIGHT', process.env.COVER_MAX_HEIGHT, 320, { min: 32, max: 1600 }),
  coverQuality: parseEnvInt('COVER_QUALITY', process.env.COVER_QUALITY, 86, { min: 1, max: 100 }),

  // ── Scan scheduler ───────────────────────────────
  scanIntervalHours: parseEnvInt('SCAN_INTERVAL_HOURS', process.env.SCAN_INTERVAL_HOURS, 0, { min: 0, max: 8760 }),

  // ── Performance profile ────────────────────────────
  ...resolvePerfProfile()
};

function resolvePerfProfile() {
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  const envProfile = (process.env.PERF_PROFILE || '').trim().toLowerCase();
  let isEmbedded;
  let profileLabel;
  if (envProfile === 'embedded') {
    isEmbedded = true;
    profileLabel = 'embedded';
  } else if (envProfile === 'default') {
    isEmbedded = false;
    profileLabel = 'default';
  } else {
    isEmbedded = totalMemMb <= 2048;
    profileLabel = isEmbedded ? 'auto-embedded' : 'auto-default';
  }

  const defaultCache = isEmbedded ? 64 : 256;
  const defaultMmap = isEmbedded ? 0 : 256;

  const sqliteCacheSizeMb = parseEnvInt('SQLITE_CACHE_SIZE_MB', process.env.SQLITE_CACHE_SIZE_MB, defaultCache, { min: 8, max: 2048 });
  const sqliteMmapSizeMb = parseEnvInt('SQLITE_MMAP_SIZE_MB', process.env.SQLITE_MMAP_SIZE_MB, defaultMmap, { min: 0, max: 2048 });

  console.log(`[perf] profile: ${profileLabel} (RAM: ${totalMemMb} MB, cache: ${sqliteCacheSizeMb} MB, mmap: ${sqliteMmapSizeMb} MB)`);

  return { perfProfile: profileLabel, sqliteCacheSizeMb, sqliteMmapSizeMb, totalMemMb };
}
