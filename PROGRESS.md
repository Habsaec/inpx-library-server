# INPX Library Server — Progress & Architecture

**v1.5.0** · Node.js + Express + SQLite · Server-rendered HTML + vanilla JS

## Tech Stack

| Компонент | Технология |
|---|---|
| Runtime | Node.js ≥ 18 |
| Server | Express 4 |
| Database | SQLite via better-sqlite3 (WAL, mmap, 64 MB cache) |
| Auth | scrypt hashing, cookie sessions, Basic Auth (OPDS) |
| Reader | foliate-js (`<foliate-view>` web component) |
| Converter | fb2cng (внешний бинарник) |
| Email | nodemailer |
| Config | dotenv + DB settings (admin panel) |

## Project Structure

```
src/
  server.js        — Express app, routes, bootstrap          (~2570 lines)
  templates.js     — HTML rendering functions                (~2010 lines)
  inpx.js          — INPX parsing, indexing, search, OPDS   (~2570 lines)
  db.js            — SQLite schema, migrations, CRUD         (~940 lines)
  fb2.js           — FB2/ZIP extraction, XML parsing         (~170 lines)
  conversion.js    — Format conversion via fb2cng            (~230 lines)
  config.js        — Environment config with defaults        (~85 lines)
  auth.js          — Password hashing (scrypt)               (~40 lines)
  constants.js     — Shared constants (no magic values)      (~40 lines)
  download-formats.js — Format definitions and availability   (~30 lines)
  ru-plural.js     — Russian pluralization helper            (~25 lines)
  genre-map.js     — Genre code → label mapping
  load-env.js      — Loads .env and .env.local

  middleware/
    auth.js        — Session, CSRF, auth guards              (~120 lines)
    security-headers.js — CSP, X-Frame-Options, etc.         (~25 lines)

  services/
    cache.js       — Page data cache with TTL                (~35 lines)
    email.js       — SMTP transport factory                  (~40 lines)
    online-tracker.js — Online user tracking                 (~25 lines)
    rate-limiter.js — Login rate limiting                    (~55 lines)
    recommendations.js — Book recommendation engine          (~130 lines)
    session.js     — Session creation, CSRF tokens           (~65 lines)
    system-events.js — Event logging and querying            (~90 lines)

  utils/
    safe-int.js    — Safe integer parsing (NaN prevention)   (~25 lines)

public/
  app.js           — Client-side JS                          (~2410 lines)
  styles.css       — CSS (dark/light themes, warm palette)   (~2440 lines)
  reader.js        — Online reader (foliate-js, v2)          (~550 lines)
  reader.css       — Reader styles (Readest-inspired)        (~450 lines)
  foliate/         — foliate-js library (from npm)

scripts/
  server-control.js   — Process manager (PID file)
  create-user.js      — CLI user creation
  repair-metadata.js  — DB metadata repair (preserves favorites)
  reset-admin.js      — Admin password reset

*.cmd / *.sh       — Platform scripts (start/stop/restart/install)
Dockerfile         — Multi-arch image (amd64/arm64/386)
docker-compose.yml — Synology NAS / quick Docker setup
```

## Architecture

### Database (db.js)

- Single file `data/library.db`
- **WAL mode** + `wal_autocheckpoint = 1000` + periodic TRUNCATE checkpoint (5 min)
- **Performance pragmas:** `cache_size = 64 MB`, `mmap_size = 256 MB`, `temp_store = MEMORY`
- `PRAGMA optimize` при старте, `ANALYZE` после индексации
- Schema auto-migrations via `ensureXxxSchema()`
- Settings: `settings` table (key-value), catalog metadata: `meta` table

**Ключевые таблицы:**
- `books` — основной каталог (id, title, authors, genres, series, ext, lang, …)
- `authors`, `series_catalog`, `genres_catalog` — справочники с `display_name`, `sort_name`, `search_name`
- `book_authors`, `book_series`, `book_genres` — связи many-to-many
- `books_fts` — FTS5 полнотекстовый индекс
- `sources` — источники книг (путь, тип, enabled)
- `users` — пользователи (scrypt hash, role, session_gen)
- `bookmarks`, `reader_bookmarks`, `reading_history`, `favorite_authors`, `favorite_series`, `shelves`, `shelf_books`
- `book_details_cache` — кэш обложек и аннотаций
- `system_events` — журнал событий

**View:** `active_books` — `books WHERE deleted = 0 AND source enabled` (EXISTS subquery с индексом)

**Индексы (добавлены в v1.4.3):**
- `books(deleted, source_id)` — composite для active_books view
- `books(lang)` — для listLanguages
- `bookmarks(book_id)`, `reading_history(book_id)`, `shelf_books(book_id)` — для JOIN в popular/shelves
- `sources(enabled)` — для active_books EXISTS

### INPX Path Resolution

1. DB (`meta.inpx_file`) → env `INPX_FILE` → auto-detect first `.inpx` in `LIBRARY_ROOT`
2. `getLibraryRoot()` derives from INPX path (parent dir), fallback to `config.libraryRoot`
3. `ensureIndex()` gracefully handles missing INPX

### Indexing (inpx.js)

- **Incremental** (default): сравнивает размеры `.inp` в `meta.inp_sizes` (JSON), обрабатывает только изменённые
- **Full**: удаляет всё и переимпортирует
- Chunked processing (25 records/transaction) с `yieldEventLoop()` между чанками
- **ID cache** (v1.4.3): `Map` для author/series/genre ID — eliminates redundant SELECT при индексации
- FTS triggers: AFTER INSERT/DELETE/UPDATE на `books` → `books_fts`

### Search

- **FTS5 path**: `books_fts MATCH ?` + JOIN `active_books` по rowid
- **Regex path**: LIKE/search_name scan с REGEX_SCAN_LIMIT
- Genre filter через EXISTS subquery
- Sort: recent (date/imported_at), title, author, series

### Reader (v2)

- foliate-js `<foliate-view>` для FB2 и EPUB
- Layout: paginated (1 col) / dual (2 cols)
- Click zones: 37.5% / 25% / 37.5% (Readest-style)
- Settings: theme, font, fontSize, lineHeight, maxWidth — per user в DB
- Position: CFI strings, bookmarks: CFI

### Site Name

- DB setting `site_name`, default "Библиотека"
- `<title>`: "PageTitle — SiteName"
- Configurable: Admin → Управление → Настройки

### Docker

- Build: code + deps → `/app-image`; converter downloaded at build time
- `unzip` purged after converter extraction (smaller image)
- Runtime: `docker-entrypoint.sh` syncs `/app-image` → `/app` (volume)
- Named volume `app-code` — code survives container recreation
- Admin ZIP update writes to `/app` directly
- `data/`, `node_modules/`, `.env*` never overwritten

### Theme

- Dark: warm brown `#1c1814`, muted accents `#9a8e7e`, dark gold hover `#a1671b`
- Light: similar warm tones

### Security

- **Content-Security-Policy** — global CSP header (default-src 'self'; restricted scripts, frames, connections)
- **Encrypted secrets** — reCAPTCHA secret key and SMTP password stored AES-256-GCM encrypted in DB
- **scrypt password hashing** + timing-safe comparison, dummy hash on invalid user (anti-enumeration)
- **Login rate limiting** (configurable window + max attempts via env)
- **CSRF:** HMAC-based token in `<meta>`, header `X-CSRF-Token`, form field `_csrf`
- **Session secret** auto-generated at first start (warns if weak), stored in `data/.session-secret`
- **SHA256 verification** — `install.cmd` verifies Node.js download checksum
- **Path traversal protection** — in ZIP update, book extraction, archive reading
- **Zip-bomb protection** — 500 MB total / 50 MB per file limits on update ZIP
- **Graceful shutdown** — HTTP server close + DB close with 3s timeout
- `TRUST_PROXY` for reverse proxy
- reCAPTCHA v2 support

## Performance Optimizations (v1.4.3)

### SQLite Pragmas
- `cache_size = -65536` (64 MB, was default 2 MB)
- `mmap_size = 268435456` (256 MB memory-mapped I/O)
- `temp_store = MEMORY`
- `PRAGMA optimize` on startup
- `ANALYZE` after indexing completes

### Indexes
- `books(deleted, source_id)` — composite for active_books view
- `books(lang)` — for listLanguages GROUP BY
- `bookmarks(book_id)` — for popular view JOIN
- `reading_history(book_id)` — for popular view JOIN
- `shelf_books(book_id)` — for shelf queries
- `sources(enabled)` — for active_books EXISTS

### Query Optimizations
- `active_books` view: `IN (SELECT ...)` → `EXISTS` (correlated lookup via PK)
- `getStats()`: 5 separate COUNT → 1 query with subqueries
- `popular` view: double LEFT JOIN + GROUP BY + COUNT(DISTINCT) → pre-aggregated subqueries
- `listAuthors/listSeries` total: `EXISTS` subquery per row → `COUNT(DISTINCT)` on JOIN
- `listGenres` total: same optimization for no-query case

### Indexing Speed
- Author/series/genre ID cache (`Map`) — skips redundant SELECT for repeated names
- ~50%+ fewer SELECT queries during indexing of new data

## Admin Update from ZIP

1. Admin → Управление → «Обновление сервера» → Upload ZIP
2. Server validates, extracts, backs up, copies, runs `npm install`, restarts

**Safety:** path traversal protection, `package.json` name validation, auto-rollback on error, concurrency guard, protected paths (`data/`, `node_modules/`, `converter/`, `runtime/`, `.env`)

## Changes in v1.5.0

### Architecture Refactoring
- Extracted 10 modules from `server.js` (3109→2581 lines, −17%)
- New: `src/middleware/auth.js`, `src/middleware/security-headers.js`
- New: `src/services/cache.js`, `src/services/email.js`, `src/services/online-tracker.js`, `src/services/rate-limiter.js`, `src/services/recommendations.js`, `src/services/session.js`, `src/services/system-events.js`
- New: `src/utils/safe-int.js`, `src/constants.js`
- Deduplicated SMTP transport, dummyHash, SAFE_ADMIN_REDIRECTS

### Bug Fixes
- Fixed NaN pagination bug (`Math.max(1, Number(undefined))` → `safePage()`)
- Fixed DUMMY_PASSWORD_HASH length mismatch (timing side-channel)
- Added SIGTERM/SIGINT graceful shutdown handlers
- Clean old files before copying during ZIP update
- Added `package-lock.json` for reproducible builds
- Fixed `install.sh` npm ownership warning

## Changes in v1.4.7

### Security Hardening
- Global `Content-Security-Policy` header on all responses
- reCAPTCHA secret key and SMTP password encrypted at rest (AES-256-GCM)
- `decryptValue()` gracefully handles key rotation (warns + returns empty)
- SHA256 checksum verification for Node.js download in `install.cmd`

### Scripts & Deployment
- `install.sh`: `unzip` added to system packages; `npm install` runs as service user; `chown` guarded against root/empty user
- `start.sh`: exit code check after `server-control.js start`
- `start-server.cmd`: dynamic port detection via `config.js` import
- `reset-admin.sh`: auto-detects `runtime/bin/node`
- `Dockerfile`: `unzip` purged after fb2cng extraction

### Server
- `gracefulExit()` closes DB connection before exit (prevents WAL corruption)
- `repair-metadata.js` preserves `favorite_authors` and `favorite_series` tables

## Deployment Targets

- **Windows** — `install.cmd` + `start-server.cmd` (portable Node.js, SHA256 verified)
- **Linux/macOS** — `install.sh` + `start.sh` (system or portable Node.js)
- **Docker** — `docker build` + `docker run` (unzip purged, smaller image)
- **Synology / QNAP / Unraid** — `docker-compose.yml`
- **Systemd** — configured by `install.sh`
