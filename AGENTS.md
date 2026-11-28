# INPX Library Server — Agent Instructions

Rules for any agent working in this repository. Read this file completely: it holds
**only rules** and fits in an agent's instruction budget.

The detailed spec of each subsystem lives in `docs/agents/`, one file per area (map
below). Open the file for the area you are about to change, follow it, and update it
in the same commit as the code. When code and documentation disagree, the code wins —
then fix the document.

Why the split: the spec used to be a single 145 KB `AGENTS.md`, while an agent's
instruction budget is 64 KB. The file was silently truncated on load, so roughly half
of the rules was never read by anyone. Keep this file under 60 KB: new detail belongs
in `docs/agents/<topic>.md` plus one row in the table below.

## Reference map

| Subsystem | Reference | Read it before touching |
|---|---|---|
| Sources and indexing (INPX, folder, Calibre, sidecars) | `docs/agents/indexing-sources.md` | `src/inpx.js`, `src/folder-indexer.js`, `src/calibre-indexer.js`, `src/folder-sidecar-meta.js`, `src/services/folder-watcher.js`, `src/archives.js` |
| User data safety (source delete, reindex, backup / restore) | `docs/agents/data-safety.md` | `deleteSourceProgressive`, `reattachDetachedUserData`, `src/services/portable-backup*.js`, `src/services/migrations.js` |
| Performance / event loop | `docs/agents/performance.md` | any SQL over `active_books`, boot work, `src/services/query-worker.js`, `src/services/cache.js` |
| Conversion and delivery (fbc, formats, e-mail) | `docs/agents/conversion-delivery.md` | `src/conversion.js`, `src/fb2cng-*.js`, `src/download-formats.js`, `src/routes/download.js` |
| OPDS 1.x / 2 | `docs/agents/opds.md` | `src/routes/opds*.js`, `src/opds-*.js`, `src/templates/opds.js` |
| Telegram bot | `docs/agents/telegram.md` | `src/services/telegram-*.js` |
| Reader plane (position, bookmarks, notes, KOSync, TTS) | `docs/agents/reader-sync.md` | `src/routes/reader.js`, `src/kosync*.js`, `src/services/kosync-position-bridge.js`, `public/reader*.js`, `public/position-sync.js` |
| Appearance (palette, theme sets, background, effects, covers) | `docs/agents/appearance.md` | `src/services/theme-*.js`, `src/services/ui-customization.js`, `src/services/cover-tones.js`, `public/styles.css` |
| Catalog, search and facets | `docs/agents/catalog-search.md` | `searchBooks` in `src/inpx.js`, `src/search-*.js`, `src/routes/browse-api.js` |
| Personal lists, ratings, goal, preferences | `docs/agents/personal-lists.md` | `src/routes/library.js`, `src/routes/user-api.js`, `src/routes/browse-api.js` |
| Shelves, smart shelves, collections, home layout | `docs/agents/shelves-collections.md` | `src/smart-shelves.js`, `src/collections.js`, `src/home-layout.js` |
| Android app-only behaviour | `docs/agents/android-app.md` | anything the app does without a server route |
| Auth (pairing, OIDC, app TLS) | `docs/agents/auth.md` | `src/routes/auth-routes.js`, `src/routes/oidc.js`, `src/services/oidc.js` |

## Unified ecosystem (server + Android reader)

**INPX Library Server** and **inpx-book-reader** (`D:\inpx-book-reader`) are one product during development.

| Rule | Meaning |
|------|---------|
| API-first metadata | Series, author, genres come from the INPX index via `/api/*`, not from client-side file parsing |
| Paired changes | New/changed API routes require matching updates in reader `inpxClient.ts` and both `AGENTS.md` files |
| **Feature parity (always)** | Every new or changed **user-facing feature** ships in the web UI **and** the Android reader (`D:inpx-book-reader`) **in the same task**: server API + `inpxClient.ts` + the app screen/UI + both `AGENTS.md`. Plan the Android steps from the start; never leave the app «for later». Only server internals, performance work and admin-only settings are web/server-only — say so explicitly when that is the case |
| Sync by `bookId` | Reading position, bookmarks, annotations sync through server APIs; on-disk file path is a download-time snapshot |
| Restart after routes | Restart the server after adding or changing route handlers |
| Additive API | Prefer backward-compatible response changes; Android and OPDS depend on stable contracts |
| Android-only reader | `inpx-book-reader` targets **Android APK only** — do not design API or UX for iOS/desktop/web client |

- Product priority: web UI and Android reader are **equal clients** — a user-facing feature is done only when it works in both (see «Feature parity» above). Admin and server-maintenance features stay web-only

Cursor rule: `.cursor/rules/unified-ecosystem.mdc` (always apply).

---

## Project Overview

This repository is a self-hosted ebook library server.

Repository type:

* single-package Node.js application
* NOT a monorepo
* NOT a workspace-based repository
* exception: `site/` is the public website (Astro Starlight, en at the root + ru under `/ru/`, GitHub Pages via `.github/workflows/site.yml`) — a separate package with its own `package.json`, never part of the server or Docker image; run its npm commands from `site/`. Docs pages there are marketing/docs only (no feature-parity duty), but keep them in step with README install / config sections

Main stack:

* Node.js
* Express
* SQLite (better-sqlite3)
* ESM modules
* Vanilla frontend JavaScript
* Docker

Primary goals:

1. Stability
2. Backward compatibility
3. Low resource usage
4. Performance
5. Maintainability

---

## Working Directory Rules

Repository root is the primary working directory.

All commands must be executed from repository root unless explicitly specified otherwise.

Never:

* run npm commands from nested directories
* assume monorepo structure
* invent alternative workflows

Before executing commands:

1. verify current working directory
2. verify package.json exists
3. verify command exists in package.json scripts

---

## Main Commands

Install dependencies:

```
npm install
```

Development:

```
npm run dev
```

Production:

```
npm start
```

Tests:

```
npm test
```

Coverage of the server code (`src/**` only, built-in Node reporter — no extra dependency):

```
npm run test:coverage
```

Do not bypass existing npm scripts unless necessary.

Prefer existing workflows and scripts.

---

## Architecture Principles

The codebase prioritizes:

* simplicity
* predictability
* maintainability
* low memory usage

Prefer:

* minimal diffs
* incremental changes
* explicit code
* existing project patterns
* reusable helpers

Avoid:

* mass refactoring
* unnecessary abstractions
* large rewrites
* formatting-only changes

Never introduce:

* React
* Vue
* Svelte
* TypeScript
* ORM
* enterprise architecture patterns
* dependency injection
* CQRS/event sourcing

---

## Compatibility Requirements

Backward compatibility is critical.

Never silently break:

* API responses
* database compatibility
* Docker compatibility
* OPDS compatibility
* configuration formats
* existing environment variables

Prefer additive changes over breaking changes.

---

## Performance Constraints

Target environments include:

* NAS devices
* Raspberry Pi
* Docker containers
* low-memory systems

Libraries may contain:

* hundreds of thousands of books
* huge archives
* slow disks
* limited RAM

Performance and memory efficiency are important.

Avoid:

* loading huge datasets into memory
* full archive extraction
* memory-heavy scans
* unnecessary buffering

Prefer:

* streaming
* pagination
* batching
* indexed SQL queries
* incremental processing

---

## Database Rules

Database:

* SQLite
* better-sqlite3

Use:

* prepared statements
* existing DB helpers
* indexed queries

Avoid:

* ORM
* query builders
* unnecessary schema rewrites
* loading large result sets fully into memory

Schema changes must:

* be additive
* preserve old databases
* include migration logic

Settings, users, catalog, FTS and cover cache live in **one** `library.db`. Do not split the file. Dashboard counters use `library_stats_snapshot` (written after catalog refresh) so admin pages do not `COUNT(DISTINCT)` million-row views. `/health` does no DB work — a watchdog timeout means the Node event loop is blocked (heavy sync SQLite), not a missing health query.

Event-loop hygiene (700k-book libraries): `refreshCatalogBookCounts` runs in a `worker_threads` worker (`src/services/catalog-counts-worker.js`, own connection, chunked UPDATEs; `CATALOG_COUNTS_INLINE=1` forces the old inline path) — never call it for a single book, use `adjustCatalogCountsForBook(id, ±1)`. The same worker pass groups by language and fills `catalog_lang_counts` (`kind` 1 authors / 2 series / 3 genres, raw `lang`, `book_count`; meta `catalog_lang_counts_ready`, set to `0` by the inline fallback, rebuilt once at boot when missing): author / series / genre lists filtered by profile languages read it instead of a GROUP BY over `active_books` (genres 11 s → 2 ms, series 4.5 s → 0.1 s, authors 50 s → ~0.4 s on 684k books) and fall back to counting books until it is ready. `dropBooksTableIndexes` → `ensureBooksTableIndexes` must end with `analyzeBooksIndexesYielding()`: DROP INDEX wipes `sqlite_stat1` and without stats the planner sorts the whole catalog in a TEMP B-TREE (~800 ms per page instead of ~2 ms); boot re-checks via `booksIndexStatsMissing()`. Browse ORDER BY must match an existing index exactly (`idx_books_title_nocase_id`, `idx_books_series_full` — no `CAST`, `idx_books_recent_sort`, `idx_books_date10` for novinki); a sort key from the joined `sources` table (`flibusta_sidecar`) is only added when enabled sources differ in that flag. `show_deleted_books=1` rewrites `active_books` as `deleted = 0 OR NOT EXISTS(suppressed)`, which disables every `WHERE deleted = 0` partial index — keep it off unless debugging. `[perf] event loop stalled N s` in `runtime.log` (threshold `LOOP_STALL_LOG_MS`, default 2000) is the first thing to check for "server hangs" reports; `/health/perf` has per-route p95. Plain catalog browse (no `q`) reads the materialized `active_book_ids` while `active_books_projection_state.dirty = 0` and the filter fingerprint matches — as `books b CROSS JOIN active_book_ids visible ON visible.book_id = b.id` (`browseFrom` in `searchCatalog`), NOT through the view `catalog_active_books`: the view let SQLite scan the id list and sort the whole catalog in a TEMP B-TREE for every page (~1 s, 2.8 s for `recent` on 620k books — the recurring «slow catalog q=""» and event-loop stalls); CROSS JOIN pins `books` as the outer loop so ORDER BY walks its sort index and LIMIT stops the walk (0–50 ms). The browse total is memoized per view + filters (`_browseTotalMemo`, TTL `PAGE_CACHE_TTL_MS`, cleared by `clearRuntimeQueryCaches`); with no filter it is `COUNT(*) FROM active_book_ids`. Keep `sqlite_stat1` present — without stats the planner stops preferring the sort index; any write to `books`/`book_genres`/`sources.enabled`/`genres_catalog.name`/`suppressed_books` flips it to `1` (triggers) and browse falls back to the dynamic `active_books` view. The projection is rebuilt by `ensureActiveBooksProjection()` — single-flight, chunked by `books.rowid` with `setImmediate` yields (state `2` = building; a write during a pass leaves it stale and a follow-up pass runs) — never synchronously: `refreshCatalogBookCounts`/boot only call the debounced `scheduleActiveBooksProjection()`; `rebuildActiveBooksView` (filter settings change) awaits `ensureActiveBooksProjection()`. SQLite page cache / mmap: env `SQLITE_CACHE_SIZE_MB` / `SQLITE_MMAP_SIZE_MB` (or the `PERF_PROFILE` auto defaults) are only the startup defaults; Admin **Dashboard → Обслуживание → Память базы данных** saves `db_cache_mb` / `db_mmap_mb` (empty = back to env/auto) and `applyDbMemorySettings()` applies them to the main connection at boot and on save (other cluster workers on restart). Code that temporarily drops mmap must restore the module-level `_mmapSize`, not `config`. `recommendDbMemory()`: ≤ 2 GB RAM → 64 MB / mmap 0; otherwise mmap ≈ DB size (max 2048) within ~25% of RAM. Downloads: `resolveDownload` (single / batch ZIP / e-mail / Telegram) runs through `downloadLimiter` (`src/services/heavy-task-limiter.js`, `DOWNLOAD_MAX_CONCURRENT` 4, `DOWNLOAD_MAX_QUEUE` 100, `DOWNLOAD_QUEUE_TIMEOUT_MS` 120 s) so a download wave cannot fill the 7z queue (`SEVEN_Z_MAX_CONCURRENT` 6 / `SEVEN_Z_MAX_QUEUE` 20) that covers and the reader also need; full queues throw `SERVER_BUSY` and the HTTP layer answers 503 + `Retry-After` (`errors.serverBusy`, API code `SERVICE_UNAVAILABLE`), not a 500. A book file / INPX archive missing on disk (deleted or moved outside the catalog — e.g. a format removed by hand from a Calibre book folder while `metadata.db` still lists it) makes `readBookBuffer` (`src/fb2.js`) throw `BOOK_FILE_MISSING` and the HTTP layer answers 404 (`errors.bookFileMissing`, API code `BOOK_FILE_MISSING`, also for a single send-to-ereader; batch ZIP / e-mail skip such books), not a 500. `deleteUser` also clears `read_books`, `book_ratings`, `reader_annotations`, `reader_book_revisions`, `user_reader_revisions` and the user's Android device tokens in `meta` (a re-created same-name user must not inherit them). Basic auth (OPDS, API): a successful scrypt check is cached for 5 min (key includes the current password hash, blocked is re-read every request); failures count toward the login rate limiter per IP (`LOGIN_MAX_ATTEMPTS`), so a client with a stale password locks that IP's web login for the window too; Session cookie `v2|<issuedAtSec>|<username>:<sessionGen>.<hmac>` (`src/services/session.js`) is rejected on the server after `SESSION_MAX_AGE_MS` (0 = no server limit); legacy `<username>:<sessionGen>.<hmac>` cookies are still accepted until the next login. CSRF is skipped for Basic only without `Sec-Fetch-Site` or with `same-origin`/`none` (device Bearer always skips). `TRUST_PROXY`: `true` (any hop), a proxy count (`1`) or an address list (`loopback`, CIDR) — see `parseTrustProxy` in `src/config.js`. Cover thumb disk cache: `COVER_THUMB_DISK_TTL_DAYS` (30) / `COVER_THUMB_DISK_CACHE_MB` (2048), daily GC in `scheduler.js`. Admin **Backup** can export/import users JSON (password hashes, email, Telegram, favorite author/series **names** — not book ids, which change on reindex). Existing usernames are not overwritten.

---

## Filesystem Safety

Never trust filesystem paths.

Always:

* normalize paths
* validate paths
* prevent path traversal
* validate archive extraction paths

Never:

* overwrite files silently
* delete user files automatically
* assume filesystem case sensitivity

---

## Security Rules

Always:

* validate request input
* sanitize filenames
* verify permissions
* preserve auth middleware

Never:

* log passwords
* log tokens
* expose SMTP credentials
* trust request parameters

---

## OPDS Compatibility

Compatibility with these clients is critical:

* KOReader
* FBReader

Do not break:

* feed structure
* authentication behavior
* MIME types
* pagination semantics
* existing feed URLs

All OPDS responses must produce valid XML.

---

## Development Workflow

Before modifying code:

1. analyze surrounding files
2. reuse existing patterns
3. reuse existing helpers
4. implement smallest safe change

When fixing bugs:

* identify root cause first
* avoid unrelated refactoring
* preserve existing behavior

When adding features:

* preserve compatibility
* estimate performance impact
* estimate memory impact
* preserve Docker compatibility

---

## Dependency Rules

Before adding dependencies:

* check existing project utilities
* check Node.js built-ins
* estimate maintenance risk
* estimate package size

Never add dependencies for:

* trivial utilities
* simple formatting
* one-time wrappers

Prefer:

* zero-dependency solutions
* mature stable libraries
* already-used packages

---

## Testing Expectations

Before finalizing changes:

* verify affected routes
* verify npm scripts still work
* verify Docker startup
* verify DB compatibility
* verify memory impact

For performance-sensitive changes:

* consider huge library scenarios
* consider low RAM environments

---

## Git and Branch Workflow

Default integration branch for all agent work: **`master`**.

Unless the user **explicitly** asks for a new branch, a pull request branch, or a release merge:

* **Do not** run `git checkout -b`, especially not `cursor/*` branches
* **Do not** follow diff-tab / UI actions that auto-create branches (e.g. “create branch and commit”) — commit on the current branch instead, usually `master`
* **Do not** switch branches while there are uncommitted changes; commit or stash first (use `git stash push -u` if there are untracked files)

After a logical chunk of work (or when the user ends a session), offer to commit on `master` if there are uncommitted changes. Do not push unless asked.

Do **not** modify `install.cmd`, `start-server.cmd`, or other Windows launcher scripts unless the user explicitly requests it or the task is specifically about startup/install.

### Native modules (Windows)

Production startup uses **`runtime\node.exe`** (Node 24) via `start-server.cmd` / `install.cmd`.

* Do not run `npm rebuild` with a different Node (e.g. Cursor’s system Node 22) without telling the user to run `install.cmd` afterward
* If tests fail with `better-sqlite3` / `NODE_MODULE_VERSION`, the fix is rebuild under the same Node as `runtime\node.exe` — usually by running **`install.cmd`**, not by inventing new rebuild scripts

### Recovering work

Before assuming work is lost, check: `git branch -a`, `git stash list`, `git reflog`, and uncommitted files on `master`.
