/**
 * Shared constants used across the application.
 * Extracted to avoid magic values and duplication.
 */

/**
 * Dummy scrypt hash for timing-safe comparison when user is not found.
 * Format: scrypt$<salt 32 hex = 16 bytes>$<derived key 128 hex = 64 bytes>
 * Salt and key lengths must match hashPassword() output so that
 * timingSafeEqual is always reached (prevents timing side-channel).
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$' + '0'.repeat(32) + '$' + '0'.repeat(128);

// --- Caching ---
export const DETAILS_CACHE_MAX = 1000;
export const PAGE_CACHE_MAX = 600;
export const PAGE_CACHE_TTL_MS = 1000 * 60 * 15;       // 5 min → 15 min: увеличить время кэширования
export const STATS_CACHE_TTL_MS = 1000 * 60 * 10;      // 10 min
export const HOME_SECTIONS_CACHE_TTL_MS = 1000 * 60 * 30; // 30 min
/**
 * Главная для залогиненных: «продолжить», история и избранные авторы/серии — без повторных
 * тяжёлых запросов на каждый F5. Инвалидируется адресно при действиях пользователя через
 * clearPageDataCache(`home:userSnap:${username}`), поэтому TTL может быть большим.
 */
export const HOME_USER_SNAPSHOT_CACHE_TTL_MS = 1000 * 60 * 30;   // 30 мин (инвалидируется адресно при действиях юзера)
/** TTL кэша пользователей сессии (middleware/auth.js): короткий, чтобы блокировка/смена роли применялись быстро. */
export const SESSION_USER_CACHE_TTL_MS = 20_000;
export const SESSION_USER_CACHE_MAX = 2000;

// --- Rate limiting ---
export const SYSTEM_EVENTS_MAX_COUNT = 1000;
export const SYSTEM_EVENTS_RETAIN_COUNT = 200;
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;      // 5 min

// --- Browse rate limiter (token-bucket) ---
export const BROWSE_WINDOW_MS = 60 * 1000;              // 1 min window
export const BROWSE_MAX_HITS_DEFAULT = 180;              // anon tokens / window (overridable via BROWSE_RATE_LIMIT)
/** Authenticated API clients (Android device token / Basic) — covers exempt; search+sync still bursty. */
export const BROWSE_MAX_HITS_AUTH_DEFAULT = 360;         // overridable via BROWSE_RATE_LIMIT_AUTH
export const BROWSE_MAX_TRACKED = 10_000;                // max tracked IPs
export const BROWSE_PRUNE_INTERVAL_MS = 2 * 60 * 1000;  // prune stale records every 2 min

// --- Batch operations (скачивание архива, email, выбор на клиенте) ---
/** Полки, закладки, «прочитано» — короткий лимит (UX). */
export const BATCH_DOWNLOAD_MAX = 20;
/** ZIP и отправка на email. Страховка для NAS/Pi, не «все книги на экране». */
export const BATCH_ZIP_MAX = 2000;
/** Карточек в Telegram за одну пакетную отправку: каждая — отдельное сообщение бота. */
export const TELEGRAM_BATCH_MAX = 20;

/** Единый лимит распаковки одной записи из zip/7z (archives.js, seven-zip.js). */
export const ARCHIVE_MAX_ENTRY_BYTES = 100 * 1024 * 1024;

// --- Update from ZIP ---
export const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;       // 10 min
export const UPDATE_PROTECTED_DIRS = new Set(['data', 'node_modules', 'runtime', '.env', '.env.local']);
export const UPDATE_PROTECTED_FILES = new Set(['converter/fbc', 'converter/fbc.exe', 'converter/mhl-connector.exe']);
export const MAX_UNCOMPRESSED_TOTAL = 500 * 1024 * 1024; // 500 MB
export const MAX_SINGLE_FILE = 50 * 1024 * 1024;         // 50 MB

// --- CSRF ---
export const CSRF_EXEMPT_PATHS = new Set([
  '/login',
  '/register',
  '/admin/login',
  '/set-lang',
  '/lite/login',
  '/forgot-password',
  '/reset-password',
  '/api/auth/pairing/redeem'
]);

// --- Safe admin redirects ---
export const SAFE_ADMIN_REDIRECTS = new Set(['/admin', '/admin/users', '/admin/smtp', '/admin/events', '/admin/content']);
