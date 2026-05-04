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

// --- Rate limiting ---
export const SYSTEM_EVENTS_MAX_COUNT = 1000;
export const SYSTEM_EVENTS_RETAIN_COUNT = 200;
export const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;      // 5 min

// --- Batch operations (скачивание архива, email, выбор на клиенте) ---
export const BATCH_DOWNLOAD_MAX = 20;

/** Единый лимит распаковки одной записи из zip/7z (archives.js, seven-zip.js). */
export const ARCHIVE_MAX_ENTRY_BYTES = 100 * 1024 * 1024;

// --- Update from ZIP ---
export const UPDATE_TIMEOUT_MS = 10 * 60 * 1000;       // 10 min
export const UPDATE_PROTECTED_DIRS = new Set(['data', 'node_modules', 'runtime', '.env', '.env.local']);
export const UPDATE_PROTECTED_FILES = new Set(['converter/fbc', 'converter/fbc.exe', 'converter/mhl-connector.exe']);
export const MAX_UNCOMPRESSED_TOTAL = 500 * 1024 * 1024; // 500 MB
export const MAX_SINGLE_FILE = 50 * 1024 * 1024;         // 50 MB

// --- Rate limiting (browse) ---
export const BROWSE_WINDOW_MS = 60_000; // 1 minute
export const BROWSE_MAX_HITS_DEFAULT = 120; // requests per minute
export const BROWSE_MAX_TRACKED = 20_000;
export const BROWSE_PRUNE_INTERVAL_MS = 2 * 60_000; // 2 minutes

// --- Rate limiting (login) ---
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MS = 5 * 60_000; // 5 minutes
export const LOGIN_LOCKOUT_MS = 15 * 60_000; // 15 minutes

// --- Cover image processing ---
export const COVER_WIDTH_DEFAULT = 220;
export const COVER_HEIGHT_DEFAULT = 320;
export const COVER_QUALITY_DEFAULT = 86;

// --- Cache limits ---
export const CARD_CACHE_MAX = 3000;
export const CARD_CACHE_TTL_MS = 10 * 60_000; // 10 minutes

// --- CSRF ---
export const CSRF_EXEMPT_PATHS = new Set(['/login', '/register', '/admin/login', '/set-lang']);

// --- Safe admin redirects ---
export const SAFE_ADMIN_REDIRECTS = new Set(['/admin', '/admin/users', '/admin/smtp', '/admin/events']);
