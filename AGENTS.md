# INPX Library Server — Agent Instructions

## Unified ecosystem (server + Android reader)

**INPX Library Server** and **inpx-book-reader** (`D:\inpx-book-reader`) are one product during development.

| Rule | Meaning |
|------|---------|
| API-first metadata | Series, author, genres come from the INPX index via `/api/*`, not from client-side file parsing |
| Paired changes | New/changed API routes require matching updates in reader `inpxClient.ts` and both `AGENTS.md` files |
| Sync by `bookId` | Reading position, bookmarks, annotations sync through server APIs; on-disk file path is a download-time snapshot |
| Restart after routes | Restart the server after adding or changing route handlers |
| Additive API | Prefer backward-compatible response changes; Android and OPDS depend on stable contracts |
| INPX DEL=1 | Indexed with `deleted=1` (not purged). Hidden by default via `active_books`; admin **Content → Show deleted books** (`show_deleted_books`) reveals them. Soft-deleted duplicates (`suppressed_books`) stay hidden. Book payloads may include additive `deleted: 0\|1` |
| Android-only reader | `inpx-book-reader` targets **Android APK only** — do not design API or UX for iOS/desktop/web client |
| Compressed libraries | Flibusta + Librusec «96 GB» builds: ZIP entries use **PPMd** (`unzipper` can't inflate → `archives.js` falls back to 7z for non Store/Deflate methods) and FB2 images are **WebP** (often inside `content-type="image/jpeg"`). Admin **Content → WebP images in FB2** (`fb2_webp_images`: `keep`\|`png`) recodes WebP `<binary>` to PNG on download / fb2cng input (`src/fb2-webp-images.js`); `/api/books/:id/content` (web reader, Android) is never converted |

Key endpoints for reader:
- `GET /api/books/:id/meta` (`seriesList` from index)
- `GET /api/books/:id/position` — position fields plus `positionVersion: 4`, monotonic `revision`, and holder `sessionId` / `lastUserActivityAt` / `sessionStatus` (`active` if user activity within 4 minutes); rows below v4 are migrated lazily and idempotently
- `POST /api/books/:id/position` — CAS write; requires `positionVersion: 4` and `baseRevision`, optional `sessionId`; returns a new `revision`; a different *active* session cannot overwrite even with a matching revision; stale writes receive `409 { current }` unless the holder session is idle (>4 min) and the writer is a different `sessionId` (idle-steal); clients that omit `sessionId` keep revision-only CAS; legacy protocol clients receive `428`; marks read at `progress >= 99` and clears that status when rereading drops below 95%
- `GET /api/books/:id/reader-sync-meta` — bookmark/annotation revs and position sync metadata (`positionRevision`, `positionUpdatedAt`, counts)
- `GET /api/reader-sync-index?ids=` — bulk dirty-check for Android silent sync: `{ activity, books[] }` (same fields as per-book meta + `bookId`; max ~200 ids)
- `GET /api/profile` — user stats, recent books, bookmarks, annotations (Android profile screen)
- `GET /api/settings/ui` — public library chrome for Android: `siteName`, `logoUrl`, palettes, `radius`/`radiusPreset`/`radiusScale`, `shadows`/`shadowPreset`, `backgroundUrl`, `bgBlur`, `bgOverlayStrength`, `bgSize`, `bgPosition`, `surfaceOpacity` (0–100), `surfaceBlur` (0–24px)
- `GET /api/reader-bookmarks` — all reader bookmarks for the user (`items`, `total`, `page`, `pageSize`)
- `GET /api/reader-annotations` — all reader annotations for the user (`items`, `total`, `page`, `pageSize`)
- `GET /api/favorites` — favorite authors (`name`, `displayName`, `bookCount`, `coverBookId`) and series (`name`, `displayName`, `bookCount`, `previewBookIds`)
- `GET /api/reader-activity-sync-meta` — read-state and reading-history revs
- `POST /api/reading-history/:id` — record `lastOpenedAt` when a book is opened
- `DELETE /api/reading-history/:id` — remove a reading-history entry
- «Читаю» / «Продолжить чтение» (`reading_history`) не показывают книги из `read_books`; при снятии «Прочитано» (в т.ч. при progress ниже 95%) снова появляются там. Раздел «Прочитано» отдельный.
- Cross-device reading position uses server revisions/CAS plus per-open `sessionId`; an idle holder (>4 min without page turns) can be stolen; a different active session cannot take over via matching-revision CAS; an open reader prompts on a live coordinate conflict (never silent jump); «stay here» is bound to that holder `sessionId` until the holder changes
- `GET /api/search?q=` — search section totals: `{ query, books:{total, capped?}, authors:{total}, series:{total}, preferredField?, routeField: null }`; book totals capped (≤10k); web `/catalog?q=` always opens books with Авторы/Серии chips (no hub / smart redirect)
- `GET /api/search/suggest?q=` — typeahead books/authors/series (web dropdown + Android); multi-word book suggest prefers title scope; web/Android author/series hits open the facet page (`/facet/authors|:series/:name`), not catalog `field=authors|series`
- `GET /api/search/genres?q=` — genres among matching books (optional `format` / `year` / `minRate` / `hasSeries`); web loads lazily after HTML for free-text
- `GET /api/catalog` — lists books even without `q`/filters (paginated browse); additive filters (AND): `genre` (single/CSV/repeated; multi = OR), `lang`, `format`, `year`, `minRate` (1–5), `hasSeries` (`1`/`0`), plus `q` / `letter` / `field` / `sort`; empty/weak may include additive `searchHints` (`tip`, `didYouMean`, `weak?`)
- `GET /api/library/recent` — novinki by INPX catalog `date` (30 days before the newest dated book in the DB, paginated); not full catalog / not reindex `imported_at` stamps; additive filters like catalog: `genre` (CSV/repeated, OR), `lang`, `format`, `year`, `minRate`, `hasSeries` (1/0)
- `GET /api/library/recommended` — personalized pool + same additive filters (`genre`, `format`, `year`, `minRate`, `hasSeries`)
- `GET /api/facet-books` — books by facet (`authors`/`series`/`genres`/`languages`); additive filters: `format`, `year`, `minRate`, `hasSeries` (1/0), `lang`
- Web catalog / search / novinki support `?view=list` (Flibusta-style rows) alongside the default cover grid
- `GET /api/browse/authors/:value/grouped` — author series + `standaloneBooks` + `books[]` per series (Flibusta-style list); `lean=1` omits `books[]` (name/displayName/bookCount only); `resolveAuthorName` picks the `authors` alias with the same `search_name` and higher `book_count` (INPX Latin vs Cyrillic duplicate)
- Book search: SQLite FTS5, stem expand, title boost (exact/ordered/prefix), author+title split, phrase OR, stopword-aware AND, catalog-layer typo retry on miss, page-level edition dedupe, LIKE fallback when dirty/desynced. Dirty/desync auto-rebuild; post-index FTS warmup. Admin/ops: additive `ftsStatus`, `POST /api/operations/fts-rebuild`
- Details: `docs/architecture/search.md`
- `POST /api/auth/pairing` — authenticated; creates a one-time 10-minute QR pairing code (`payload` JSON + `svg`) for Android app sign-in; does not include the password
- `POST /api/auth/pairing/redeem` — public + rate-limited; exchanges pairing `code` for a device Bearer token (`deviceToken`, `deviceTokenId`, `username`, `serverUrl`)

### OIDC / SSO (web login)

Optional OpenID Connect login (Authentik-compatible): Authorization Code + PKCE, JIT user provisioning, optional admin claim. Configure in **Admin → Users → OIDC / SSO** (`oidc_enabled` off by default). Routes: `GET /auth/oidc/start`, `GET /auth/oidc/callback`. Session cookie contract unchanged. OIDC users get `has_local_password=0` until they set a password in profile (needed for OPDS/Basic). Existing local accounts with the same email are **not** auto-linked.

### Reading position contract (Foliate glue)

Shared logic lives in `public/position-sync.js` (copied to Android `public/inpx-reader/position-sync.js` at build).

| Field | Rule |
|-------|------|
| `textOffset` / `textQuote` / `textSectionLength` | Primary exact v4 text anchor inside `sectionIndex`; independent of viewport, font, and pagination |
| `fraction` | Book-wide display coordinate and restore fallback, **not** an exact text anchor and not TOC-derived % |
| `progress` | Display/sync percent derived from `fraction` (0.0001% precision) |
| `fb2Href` | Coarse FB2 fallback (`section` or `section#block`); it never overrides a differing precise `fraction` |
| `position` | EPUB CFI / paginator token; empty for FB2 when `fb2Href` is set |
| `positionVersion` | Coordinate contract version; rows below v4 migrate lazily: FB2/FBZ coordinates and anchors reset, while EPUB keeps only its CFI |
| `revision` / `baseRevision` | Server CAS token; only a write based on the current revision is accepted |
| `sessionId` | Per-open-reader UUID; a different holder with differing coordinates always shows a dialog (including when the holder omitted `sessionId`) |
| `lastUserActivityAt` / idle 4 min | Open readers stop POSTing after 4 minutes without page/snap/scroll/navigation; another session may idle-steal or take over with the current revision only while the holder is idle |

Cursor rule: `.cursor/rules/unified-ecosystem.mdc` (always apply).

---

## Project Overview

This repository is a self-hosted ebook library server.

Repository type:

* single-package Node.js application
* NOT a monorepo
* NOT a workspace-based repository

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
