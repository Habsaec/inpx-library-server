# Code Audit Report: INPX Library Server

**Date:** 2025-01-15  
**Scope:** Full codebase review (`src/`, `test/`, `public/`, configuration, tests)  
**Lines of Code:** ~15,000+ (JavaScript/Node.js)

---

## Executive Summary

The codebase is a **well-structured, production-ready** INPX library server with solid architectural decisions, comprehensive feature set, and good security practices. The code demonstrates mature patterns for a Node.js/Express application with SQLite, including proper middleware layering, caching strategies, and background job handling.

**Overall Grade: B+** — Good to Very Good, with specific areas for improvement.

---

## 1. Architecture & Project Structure

### Strengths

- **Clean separation of concerns**: Routes, services, middleware, templates, and utilities are properly separated into directories.
- **Template-based rendering**: HTML generation is centralized in `src/templates/` with shared helpers, avoiding inline HTML in route handlers.
- **Modular route registration**: Routes are registered via dedicated functions (`registerLibraryRoutes`, `registerAdminRoutes`, etc.) making the main `server.js` clean.
- **Environment configuration**: Comprehensive env-based configuration in `src/config.js` with validation and defaults.
- **Database migrations**: Schema evolution is handled with idempotent `CREATE IF NOT EXISTS` and explicit migration logic.

### Recommendations

#### 1.1. Extract Business Logic from Route Handlers
**Priority: Medium**

Several route files mix HTTP handling with business logic. For example, `src/routes/library.js` (~1200 lines) contains cover image processing, book content streaming, and search logic inline.

**Suggested refactor**:
```javascript
// Current (library.js:1000-1044)
app.get('/api/books/:id/cover-thumb', requireBrowseAuth, async (req, res, next) => {
  // ~40 lines of cache lookup, sharp processing, disk I/O
});

// Better: Extract to src/services/cover-service.js
import { getCoverThumbnail } from '../services/cover-service.js';
app.get('/api/books/:id/cover-thumb', requireBrowseAuth, async (req, res, next) => {
  try {
    const { buffer, contentType } = await getCoverThumbnail(req.params.id);
    res.type(contentType).send(buffer);
  } catch (err) { next(err); }
});
```

#### 1.2. Standardize Async Error Handling
**Priority: High**

The project uses a mix of `try/catch` blocks in route handlers and a global error handler. Consider implementing an `asyncHandler` wrapper to eliminate repetitive `try/catch` in every async route.

**Current pattern** (repeated 50+ times):
```javascript
app.get('/some/route', async (req, res, next) => {
  try {
    // ... logic
  } catch (error) {
    next(error);
  }
});
```

**Recommended**:
```javascript
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.get('/some/route', asyncHandler(async (req, res) => {
  // ... logic without try/catch
}));
```

#### 1.3. Controller Layer
**Priority: Low**

Consider adding a thin controller layer between routes and services for complex endpoints (admin operations, batch downloads) to improve testability.

---

## 2. Security

### Strengths

- **CSRF protection**: Proper CSRF tokens with exempt paths for specific routes.
- **Password security**: `scrypt`-based hashing with salt.
- **Rate limiting**: Token-bucket rate limiter for browsing and login attempts.
- **Path traversal prevention**: Archive path validation with `path.resolve()` and root checking.
- **Input sanitization**: HTML escaping in templates via `escapeHtml()`.
- **Security headers**: CSP, X-Frame-Options, X-Content-Type-Options, etc.
- **SQL injection prevention**: Consistent use of parameterized queries.

### Recommendations

#### 2.1. SQL Injection in Dynamic Queries
**Priority: High**

While most queries use parameters, some dynamic ORDER BY clauses concatenate user input directly:

```javascript
// src/db.js:1875
ORDER BY ${orderBy}
```

`orderBy` comes from a controlled map, but this is risky. Use a whitelist validation:

```javascript
const ALLOWED_ORDERS = {
  title: 'b.title COLLATE NOCASE ASC',
  author: `COALESCE(b.authors, '') COLLATE NOCASE ASC, b.title COLLATE NOCASE ASC`,
  date: 'rb.created_at DESC'
};
const orderBy = ALLOWED_ORDERS[sort] || ALLOWED_ORDERS.date;
```

#### 2.2. Missing Rate Limit on Reader API
**Priority: Medium**

The reader bookmark/position endpoints (`/api/reader/bookmarks`, `/api/reader/position`) don't appear to have rate limiting. A malicious client could spam these endpoints.

**Recommendation**: Apply `browseLimiter` or a dedicated API rate limiter to reader endpoints.

#### 2.3. Content Security Policy (CSP) Unsafe Inline
**Priority: Medium**

`script-src 'self' 'unsafe-inline'` weakens CSP protection. Consider using nonce-based CSP or moving inline scripts to external files.

#### 2.4. Session Secret Validation
**Priority: Low**

The session secret validation rejects weak secrets but auto-generates one silently. Consider requiring explicit strong secret configuration in production.

---

## 3. Performance

### Strengths

- **Caching layers**: Multiple cache levels (page data, cover thumbnails, card HTML, sidecar cover cache, read status cache).
- **Lazy loading**: Book details and covers are fetched on-demand.
- **Background indexing**: Non-blocking indexing with progress tracking.
- **Sharp concurrency limit**: Prevents image processing from overwhelming the server.
- **WAL mode**: SQLite WAL mode for better concurrency.
- **Event loop yielding**: `setImmediate()` used in tight loops to prevent blocking.

### Recommendations

#### 3.1. Cache Key Consistency
**Priority: Medium**

The `_cardHtmlCache` in `src/templates/shared.js` uses a composite key that includes boolean flags. Consider using a more robust key generation:

```javascript
// Current
const flags = `${effectiveBatch ? '1' : '0'}${hideDownloads ? '1' : '0'}${canDl ? '1' : '0'}`;

// Better: Use structured key
const flags = JSON.stringify({ batch: effectiveBatch, hideDl: hideDownloads, canDl });
```

#### 3.2. Memory Leak in `hits` Map
**Priority: Low**

The `browseLimiter` uses a `Map` for IP tracking with manual pruning. The pruning interval is 2 minutes, but under a DDoS, the map could grow to `MAX_TRACKED` (20,000) entries quickly. Consider using a library like `lru-cache` with TTL.

#### 3.3. Database Connection Pooling
**Priority: Low**

SQLite is single-writer. The current `busy_timeout = 120000` during indexing is very high. Monitor for `SQLITE_BUSY` errors in production and consider connection pooling or read replicas if scaling beyond single-node.

---

## 4. Code Quality & Maintainability

### Strengths

- **Consistent naming**: camelCase for JS, snake_case for SQL columns with explicit mapping.
- **JSDoc comments**: Some functions have JSDoc types.
- **Error handling**: Detailed error messages with Russian/English i18n support.
- **Feature flags**: Environment-based toggles for many features.

### Recommendations

#### 4.1. Magic Numbers
**Priority: Medium**

Many magic numbers are scattered throughout the code:
- `120` (browse rate limit)
- `220` / `320` (cover dimensions)
- `3000` (card cache max)
- `600_000` (card cache TTL)

**Recommendation**: Centralize in `src/constants.js`:
```javascript
export const CACHE_CONFIG = {
  CARD_MAX_ENTRIES: 3000,
  CARD_TTL_MS: 10 * 60 * 1000,
  COVER_MAX_WIDTH: 220,
  COVER_MAX_HEIGHT: 320
};
```

#### 4.2. Function Length
**Priority: Medium**

Several functions exceed 100 lines:
- `renderAdminUsers` (~350 lines)
- `renderAdminContent` (~400 lines)
- `buildAuthorSidecarIndex` (~150 lines)

**Recommendation**: Extract sub-renderers and helper functions.

#### 4.3. Template Logic Complexity
**Priority: Medium**

Template functions contain complex business logic (e.g., `renderOperations` calculates gradients, formats disk space). Extract to pure helper functions:

```javascript
// Extract from renderOperations
function formatUptime(seconds) { /* ... */ }
function gradientForPercentage(pct) { /* ... */ }
```

#### 4.4. Dead Code
**Priority: Low**

- `src/utils/async-timeout.js` exports `parseEnvTimeoutMs` which is also defined in `src/seven-zip.js` (duplication).
- Some commented-out code remains in `src/db.js`.

---

## 5. Testing

### Strengths

- **Test coverage exists**: Unit tests for rate limiting, file probing, flibusta sidecar.
- **Integration tests**: API endpoint tests using `supertest`.

### Recommendations

#### 5.1. Test Coverage Gaps
**Priority: High**

Critical untested areas:
- `src/routes/library.js` — no tests for cover generation, book streaming, search
- `src/fb2.js` — no tests for FB2 parsing, cover extraction, encoding detection
- `src/conversion.js` — no tests for format conversion, cache management
- `src/archives.js` — limited archive operation tests
- `src/db.js` — no tests for schema migrations, backup/restore

#### 5.2. Test Database Isolation
**Priority: Medium**

Tests appear to use the production database file. Implement an in-memory or temporary test database:

```javascript
// test-setup.js
import Database from 'better-sqlite3';
const testDb = new Database(':memory:');
// Run schema initialization
```

#### 5.3. Mock External Dependencies
**Priority: Medium**

Tests for conversion and 7-zip extraction should mock `child_process.spawn` to avoid external binary dependencies in CI.

#### 5.4. E2E Tests
**Priority: Low**

Consider adding Playwright or Cypress tests for critical user flows (login, search, book reading).

---

## 6. Database & Migrations

### Strengths

- **Schema versioning**: Uses `meta` table and `schema_bootstrap_v4` key.
- **Idempotent migrations**: `CREATE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` checks.
- **Index strategy**: Comprehensive indexes for query patterns.
- **VIEW for active books**: Clean abstraction over soft-deleted/excluded books.

### Recommendations

#### 6.1. Migration System
**Priority: Medium**

Current migrations are inline JS. Consider a formal migration framework or at least numbered migration files:

```
migrations/
  001_initial_schema.sql
  002_add_sources.sql
  003_add_flibusta_sidecar.sql
  ...
```

#### 6.2. Foreign Keys
**Priority: Low**

Foreign keys are defined but not consistently enforced. Verify `PRAGMA foreign_keys = ON` is set globally.

#### 6.3. Database Size Monitoring
**Priority: Low**

Add alerting/metrics for database size growth, WAL file size, and index fragmentation.

---

## 7. Error Handling & Observability

### Strengths

- **Structured logging**: System events table with categories and levels.
- **Runtime logs**: SSE-based live log streaming for admin panel.
- **Error boundaries**: Global Express error handler with JSON/text response format.

### Recommendations

#### 7.1. Error Codes
**Priority: Medium**

The `ApiErrorCode` enum exists but isn't used consistently. Some endpoints return plain text errors instead of structured JSON:

```javascript
// src/routes/health.js
return res.status(503).send('Service Unavailable');

// Better
return res.status(503).json({ ok: false, code: ApiErrorCode.SERVICE_UNAVAILABLE, error: t('errors.serviceUnavailable') });
```

#### 7.2. Request Context Logging
**Priority: Low**

Add request ID propagation for tracing:

```javascript
// middleware/request-id.js
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.set('X-Request-ID', req.id);
  next();
});
```

---

## 8. Internationalization (i18n)

### Strengths

- **AsyncLocalStorage-based locale**: Clean implementation without passing `req` everywhere.
- **Russian/English support**: Full UI translation.
- **Pluralization**: Proper Russian plural forms (one/few/many).

### Recommendations

#### 8.1. Missing Translation Keys
**Priority: Low**

Some error messages are hardcoded in Russian in business logic (e.g., `db.js:1082` `'Название источника не указано'`). Move to i18n keys.

---

## 9. Configuration & Deployment

### Strengths

- **Docker support**: Multi-stage Dockerfile with health checks.
- **Environment variables**: Comprehensive `.env.example`.
- **Docker Compose**: Ready-to-use compose file.
- **GitHub Actions**: CI/CD workflows for testing and publishing.

### Recommendations

#### 9.1. Health Check Endpoint
**Priority: Medium**

The `/health` endpoint exists but doesn't verify database connectivity or disk space. Enhance:

```javascript
app.get('/health', async (req, res) => {
  const checks = {
    database: await checkDatabaseConnection(),
    disk: await checkDiskSpace(),
    memory: process.memoryUsage()
  };
  const healthy = Object.values(checks).every(c => c.ok);
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
});
```

#### 9.2. Graceful Shutdown
**Priority: Medium**

Implement graceful shutdown with connection draining:

```javascript
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
```

---

## 10. Priority Action Items

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| **High** | Standardize async error handling (`asyncHandler`) | Low | High |
| **High** | Expand test coverage (library routes, FB2, conversion) | High | High |
| **High** | Validate dynamic SQL ORDER BY clauses | Low | High |
| **Medium** | Extract business logic from route handlers | Medium | Medium |
| **Medium** | Add rate limiting to reader/bookmark APIs | Low | Medium |
| **Medium** | Implement formal database migration files | Medium | Medium |
| **Medium** | Centralize magic numbers in constants | Low | Medium |
| **Low** | Add request ID tracing | Low | Low |
| **Low** | Implement graceful shutdown | Low | Medium |
| **Low** | Refactor long template functions | Medium | Low |

---

## Appendix: File-by-File Quick Notes

| File | Lines | Grade | Notes |
|------|-------|-------|-------|
| `src/server.js` | 1027 | B+ | Clean bootstrap, could use more middleware abstraction |
| `src/db.js` | 2185 | B+ | Comprehensive but long, needs migration framework |
| `src/routes/library.js` | 1209 | B | Good functionality, extract services |
| `src/routes/admin.js` | 1236 | B | Complex admin logic, needs controller layer |
| `src/templates/shared.js` | 1030 | B | Good helpers, some functions too long |
| `src/templates/library.js` | 1218 | B | Reader template is massive |
| `src/inpx.js` | 4563 | B | Core search logic, well-optimized |
| `src/fb2.js` | 386 | B+ | Clean FB2 parsing, good error handling |
| `src/conversion.js` | 410 | B+ | Good process management, needs tests |
| `src/archives.js` | 248 | B+ | Clean archive abstraction |
| `src/middleware/auth.js` | 215 | A | Solid auth, good caching |
| `src/middleware/rate-limiter-browse.js` | 62 | A | Clean token-bucket implementation |
| `src/flibusta-sidecar.js` | 1496 | B | Complex but well-commented |
| `src/config.js` | 164 | A | Excellent config validation |
| `src/i18n.js` | 187 | A | Clean AsyncLocalStorage usage |

---

*End of Report*
