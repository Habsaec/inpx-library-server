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
| Source delete keeps user data | Deleting a source never removes users, settings or per-book user data (`bookmarks`, `read_books`, `book_ratings`, `reading_history`, `shelf_books`, `reading_positions`, `reader_*`). `deleteSourceProgressive` / `forceDetachSourceRowUnsafe` stash a book fingerprint (`lib_id` + `archive_name` + `file_name` + `ext`) in `detached_book_refs`, delete books with `foreign_keys=OFF` (no `ON DELETE CASCADE`), and `reattachDetachedUserData(sourceId)` (called at the end of INPX/folder indexing) moves the rows onto the re-indexed books. Orphan rows are hidden by `active_books` joins. A full (non-incremental) reindex (`rebuildIndex` in `src/inpx.js`, `indexFolder`) does the same stash → delete with `runWithForeignKeysOff` → reattach, so user data survives it too; removal of individual vanished files still cascades |
| INPX DEL=1 | Indexed with `deleted=1` (not purged). Hidden by default via `active_books`; admin **Content → Show deleted books** (`show_deleted_books`) reveals them. Soft-deleted duplicates (`suppressed_books`) stay hidden. Book payloads may include additive `deleted: 0\|1` |
| Android-only reader | `inpx-book-reader` targets **Android APK only** — do not design API or UX for iOS/desktop/web client |
| Compressed libraries | Flibusta + Librusec «96 GB» builds: ZIP entries use **PPMd** (`unzipper` can't inflate → `archives.js` falls back to 7z for non Store/Deflate methods) and FB2 images are **WebP** (often inside `content-type="image/jpeg"`). Admin **Content → WebP images in FB2** (`fb2_webp_images`: `keep`\|`png`) recodes WebP `<binary>` to PNG on download / fb2cng input (`src/fb2-webp-images.js`); `/api/books/:id/content` (web reader, Android) is never converted. Book archives as **`.7z`** (solid): catalog covers must not unpack the FB2 (`bookUsesSevenZipArchive`); sidecar image reads use `listFallback: false` so a miss does not `7z l` a huge archive (that froze Node and made Android reconnect every ~30 s). Flibusta `images/*.zip` illustrations are **JPEG XL**: `mergeSidecarBinariesIntoFb2Xml` (reader `/api/books/:id/content`, downloads, conversion) decodes them in a `worker_threads` pool (`src/services/jxl-pool.js` + `jxl-worker.js`: libjxl via `@jsquash/jxl` → sharp JPEG q85, PNG only when the image has alpha; `JXL_WORKERS`, `0` = off; falls back to `jxl-oxide-wasm` PNG in the main thread when sharp/worker is unavailable) and caches the assembled FB2 in `data/converted-books/fb2-sidecar-*.fb2` (`src/fb2-sidecar-cache.js`: only builds slower than `FB2_SIDECAR_CACHE_MIN_MS`=1500, cap `FB2_SIDECAR_CACHE_MB`=1024, `0` = off). A 175-image book went from ~55 s / 150 MB to ~6 s / 23 MB (instant when cached). Adding such a dump next to an already indexed Flibusta/Librusec source creates hundreds of thousands of duplicates (`sourceId:libId`); Admin **Duplicates → auto-clean** keeps the newer source when formats match, also hides the same Flibusta `lib_id` across sources (even if title/author drifted) and same-title pairs from two sources when the author was renamed, and must not load every duplicate row into RAM |

Key endpoints for reader:
- `GET /api/books/:id/meta` (`seriesList` from index)
- `GET /api/books/:id/position` — position fields plus `positionVersion: 4`, monotonic `revision`, and holder `sessionId` / `lastUserActivityAt` / `sessionStatus` (`active` if user activity within 4 minutes); rows below v4 are migrated lazily and idempotently
- `POST /api/books/:id/position` — CAS write; requires `positionVersion: 4` and `baseRevision`, optional `sessionId`; returns a new `revision`; a different *active* session cannot overwrite even with a matching revision; stale writes receive `409 { current }` unless the holder session is idle (>4 min) and the writer is a different `sessionId` (idle-steal); clients that omit `sessionId` keep revision-only CAS; legacy protocol clients receive `428`; marks read at `progress >= 99` and clears that status when rereading drops below 95%
- `GET /api/books/:id/reader-sync-meta` — bookmark/annotation revs and position sync metadata (`positionRevision`, `positionUpdatedAt`, counts)
- `GET /api/reader-sync-index?ids=` — bulk dirty-check for Android silent sync: `{ activity, books[] }` (same fields as per-book meta + `bookId`; max ~200 ids)
- `GET /api/profile` — user stats, recent books, bookmarks, annotations (Android profile screen); additive `user.email` (account email)
- `GET /api/account-email` / `POST /api/account-email` (`{ email }`, empty clears) — account email `users.email` (unique, lower-cased; `400 PROFILE_INVALID_EMAIL`, `409 PROFILE_EMAIL_TAKEN`); separate from `/api/ereader-email`. Also settable in web/lite profile and Admin → Users. Password reset (`/forgot-password`) matches the account email first, then falls back to the e-reader email
- `GET /api/settings/ui` — public library chrome for Android: `siteName`, `logoUrl`, palettes, `radius`/`radiusPreset`/`radiusScale`, `shadows`/`shadowPreset`, `backgroundUrl`, `bgBlur`, `bgOverlayStrength`, `bgSize`, `bgPosition`, additive `headerUrl` / `hasHeader` / `hasCustomHeader` / `showHeader` / `showLogo` / `headerHeight` (80–640, default 180) / `headerPosition` (`center`/`top`/`bottom`) / `headerSize` (`contain`/`cover`, default `cover`; bundled `/header.png` is on by default — custom upload replaces it; Admin → Appearance can hide the header or logo), `surfaceOpacity` (0–100), `surfaceBlur` (0–24px), `coverFallbackUrl`, `coverFallbackLightUrl` (same URL when a custom placeholder is set; otherwise the dark and light bundled plates)
- `GET /api/reader-bookmarks` — all reader bookmarks for the user (`items`, `total`, `page`, `pageSize`)
- `PATCH /api/books/:id/bookmarks/:bmId` — rename a reader bookmark (`title`, max 500)
- `GET /api/reader-annotations` — all reader annotations for the user (`items`, `total`, `page`, `pageSize`)
- `PATCH /api/books/:id/annotations/:aid` — update a highlight note and/or color (`note`, `color`); bumps `annotations_rev` like add/delete
- `GET /api/reader-notes/export` — Markdown/HTML export (`format=md|html`, filters `color`, `book` (base64url ref) or `bookId`, `q`, `sort=new|old|title`, `group=book|color`, optional `ids=1,2`; max 5000); `POST /api/reader-notes/send` (same filters/`ids` in JSON, `format`) mails the file to the profile e-reader email (`EREADER_EMAIL_MISSING` / `SMTP_NOT_CONFIGURED`); `POST /api/reader-notes/bulk` — `{ action: 'delete'|'color', ids[], color? }` (own notes only). Export header = library name + inline logo (data URI, hidden when Appearance «show logo» is off) + plain title «Заметки». Web page: `/library/notes` (filters, color counts, inline edit, bulk select)
- `GET /api/favorites` — favorite authors (`name`, `displayName`, `bookCount`, `coverBookId`) and series (`name`, `displayName`, `bookCount`, `previewBookIds`)
- `GET /api/reader-activity-sync-meta` — read-state and reading-history revs
- `DELETE /api/read/:id` — idempotent unmark (`{ read: false }` even when the book was not marked); `POST /api/read/batch` marks, `POST /api/read/:id` still toggles
- `POST /api/reading-history/:id` — record `lastOpenedAt` when a book is opened
- `DELETE /api/reading-history/:id` — remove a reading-history entry
- «Читаю» / «Продолжить чтение» (`reading_history`) не показывают книги из `read_books`; при снятии «Прочитано» (в т.ч. при progress ниже 95%) снова появляются там. Раздел «Прочитано» отдельный.
- Cross-device reading position uses server revisions/CAS plus per-open `sessionId`; an idle holder (>4 min without page turns) can be stolen; a different active session cannot take over via matching-revision CAS; an open reader prompts on a live coordinate conflict (never silent jump); «stay here» is bound to that holder `sessionId` until the holder changes
- `GET /api/search?q=` — search section totals: `{ query, books:{total, capped?}, authors:{total}, series:{total}, preferredField?, routeField: null }`; book totals capped (≤10k); web `/catalog?q=` always opens books with Авторы/Серии chips (no hub / smart redirect)
- `GET /api/search/suggest?q=` — typeahead books/authors/series (web dropdown + Android); multi-word book suggest prefers title scope; web/Android author/series hits open the facet page (`/facet/authors|:series/:name`), not catalog `field=authors|series`
- `GET /api/search/genres?q=` — genres among matching books (optional `format` / `year` / `minRate` / `hasSeries`); web loads lazily after HTML for free-text
- `GET /api/catalog` — lists books even without `q`/filters (paginated browse); additive filters (AND): `genre` (single/CSV/repeated; multi = OR by default; additive `genreMode=and` requires every selected genre — web catalog filter panel toggle, default `or`), `lang`, `format`, `year`, `minRate` (1–5), `hasSeries` (`1`/`0`), plus `q` / `letter` / `field` / `sort`; empty/weak may include additive `searchHints` (`tip`, `didYouMean`, `weak?`). A logged-in user's `users.content_langs` (Profile → view, empty = every language the admin left) further limits catalog, search, author/series/genre lists (the count on each row is only books in those languages), facet books, novinki, recommendations and smart shelves on the web and the matching `/api/*` lists; a page `lang` outside that set matches nothing. Continue reading, read, and ordinary shelves stay unfiltered, and a direct book URL still opens. Cover cards and list rows show the language code. Web author / outside-series / series / genre pages take `?lang=` (picker next to sort, shown when there are 2+ languages to choose). Language codes are compared case-insensitively (`ru` / `RU` / `Ru` are one language; the admin still hides exact raw values)
- `GET /api/library/recent` — novinki by INPX catalog `date` (30 days before the newest dated book in the DB, paginated); not full catalog / not reindex `imported_at` stamps; additive filters like catalog: `genre` (CSV/repeated, OR by default; additive `genreMode=and`), `lang`, `format`, `year`, `minRate`, `hasSeries` (1/0)
- `GET /api/library/continue` — «Продолжить чтение» (`reading_history` minus `read_books`); additive `lastOpenedAt` / `openCount` per item (web `/library/continue` cards/rows have «Убрать» → `DELETE /api/reading-history/:id`, undo re-POSTs these two fields). Web home hero renders one book with the same markup as the carousel (no dots/counter)
- `GET /api/library/recommended` — personalized pool + same additive filters (`genre`, `genreMode`, `lang`, `format`, `year`, `minRate`, `hasSeries`)
- `GET /api/facet-books` — books by facet (`authors`/`series`/`genres`/`languages`); additive filters: `genre` (CSV/repeated, OR), `format`, `year`, `minRate`, `hasSeries` (1/0), `lang`
- 3D book covers (web only): catalog cards, home carousel and book page turn on mouse hover (the home quote cover / author portraits stay flat; hero / book page only while the pointer is over the cover itself: stable `.book-3d` wrapper catches hover, inner `.book-3d-body` turns) (flat at rest; off for touch / `prefers-reduced-motion`). Admin → Appearance → Effects → «3D-обложки книг» (`ui_book_3d`, default on) sets `data-ui-book3d="0"` on `<html>`, every rule in the «3D book covers» block of `public/styles.css` is gated by `html:not([data-ui-book3d="0"])`. Not part of `/api/settings/ui` (Android reader doesn't use it)
- Home quote cover = the quote author's "book": author name + link to their books, portrait from `GET /api/authors/portrait?name=` when present (blurs out with the quote on rotation). The endpoint falls back to word-order-independent `listAuthors` matching when the exact name misses («Александр Пушкин» → «Пушкин Александр Сергеевич»)
- Web home, catalog, search, novinki and recommendations support covers or `?view=list` (Flibusta-style rows). Home shelves («Новинки», recommendations, pinned shelves) share one batch-select scope. The home toggle is `/?view=list|grid` for guests; signed-in users `POST /profile/home-view` (`view=list|grid`, CSRF), which saves `users.ui_home_view` and keeps the catalog preference. The catalog toggle does the same for `users.ui_catalog_view` via `POST /profile/catalog-view` (`view`, CSRF, `next` back to the current `/catalog` filters without `view`) and leaves the home preference unchanged
- `GET /api/browse/authors/:value/grouped` — author series + `standaloneBooks` + `books[]` per series (Flibusta-style list); `lean=1` omits `books[]` (name/displayName/bookCount only); additive `authorSeries` per series (`true` = every book of the series has this author; `false` = multi-author/publisher series — web shows those last under «Межавторские и издательские серии», after «Книги вне серий»); `resolveAuthorName` picks the `authors` alias with the same `search_name` and higher `book_count` (INPX Latin vs Cyrillic duplicate)
- Book search: SQLite FTS5, stem expand, title boost (exact/ordered/prefix), author+title split, phrase OR, stopword-aware AND, catalog-layer typo retry on miss, page-level edition dedupe (same title, author, series, year, and format only), LIKE fallback when dirty/desynced. Dirty/desync auto-rebuild; post-index FTS warmup. Admin/ops: additive `ftsStatus`, `POST /api/operations/fts-rebuild`. Multi-word author and series counts use `author_name_tokens` / `series_name_tokens` (author words exact, series words by prefix) after meta `catalog_name_tokens_ready`; until the background backfill finishes, search keeps the LIKE scan
- Details: `docs/architecture/search.md`
- `POST /api/auth/pairing` — authenticated; creates a one-time 10-minute QR pairing code (`payload` JSON + `svg`) for Android app sign-in; does not include the password
- `POST /api/auth/pairing/redeem` — public + rate-limited; exchanges pairing `code` for a device Bearer token (`deviceToken`, `deviceTokenId`, `username`, `serverUrl`)

- `POST /api/send-to-telegram/:id` (also `/api/send-to-telegram/b64/<ref>`) — web «В Telegram» button: sends the same book card the bot shows in search (cover + annotation + one `dl:` button per available format, 3 per row; the file arrives on button press) to the Telegram account linked in the profile. Errors (`code`): `TELEGRAM_DISABLED` 400, `TELEGRAM_DENIED` 403, `TELEGRAM_NOT_LINKED` 400 (+`linkUrl`), `TELEGRAM_SEND_FAILED` 500, `SEND_IN_PROGRESS` 429. `dl:` keys live in the bot process memory, so with `CLUSTER_WORKERS>1` the card must be sent from the worker that polls the bot. Not used by the Android reader. `POST /api/send-to-telegram/batch` `{ ids[] }` (max `TELEGRAM_BATCH_MAX` = 20) sends one card per book sequentially → `{ ok, message, requested, sent, skipped, partial }`, same error codes. Web list rows, cover cards (replaces «Подробнее»; anonymous users keep «Подробнее») and the selection toolbar show one «Отправить» menu (email + Telegram) like the book page; a single available target stays a plain button. Catalog / library pages allow multi-select in both cover and list view
- Download format `fb2zip` (label `FB2.ZIP`, file `*.fb2.zip`, `application/zip`): the delivered FB2 (WebP mode, sidecar images applied) zipped as a single entry in memory (`resolveDownload`); offered for every FB2 book without fb2cng, admin can disable it like other formats. Additive entry in `downloadFormats`; OPDS links unchanged. The web e-mail dialog remembers the last format in `localStorage['ereader-format']`
- Folder sources: additive `sources.fastScan` (0/1, `POST /admin/sources/add` `fast_scan`, folder type only) — indexer takes author/title from the file name and never unpacks archives (no genres/series/lang, no cover warm-up). Applies to files indexed afterwards; re-run a full reindex to re-read old ones. `POST /api/sources/probe` lists `.inpx` up to 2 levels deep (`_local.inpx` first); `findInpxFiles()` in `src/inpx.js`
- KOSync (KOReader progress sync, `src/kosync.js`, `src/routes/kosync.js`): custom server URL `http://host/kosync`; `GET /kosync/users/auth`, `PUT /kosync/syncs/progress`, `GET /kosync/syncs/progress/:document` (no progress → `200 {}`); `POST /kosync/users/create` → 403. Auth headers `x-auth-user` / `x-auth-key` (= md5 of a **dedicated generated KOReader password**, created in Profile → settings via `POST /profile/kosync-password`, revoked via `/profile/kosync-password/revoke`; DB stores `sha256(md5)` in `kosync_keys`, never the account password). KOReader's partial-MD5 document id is mapped to a book at `/download/:id` time (`kosync_documents`), so a book must be downloaded through the server once for OPDS progress to reflect KOReader. Progress lives in `kosync_progress`; it is **not** bridged into `reading_positions`. Tables are cleaned in `deleteUser`
- OPDS progress icons (`src/opds-progress.js`): OPDS v1 acquisition titles of started books get a prefix ◔ (≤25%) ◑ (≤50%) ◕ (>50%) ⬤ (read or ≥99%); sources `reading_positions`, `read_books`, KOSync percentage (max wins). Unstarted books are untouched, no opt-out toggle, OPDS v2 JSON unchanged
- Smart shelves (`src/smart-shelves.js`, `src/routes/smart-shelves.js`, table `smart_shelves`): a saved catalog filter (whitelisted `q`, `genre`, `genreMode`, `lang`, `format`, `year`, `minRate`, `hasSeries`, `sort`, `order`), books are searched live via `searchCatalog`. `GET/POST /api/smart-shelves`, `PUT/DELETE /api/smart-shelves/:id`, `GET /api/smart-shelves/:id/books?page=` → `{items,total,page,pageSize}`; shelf object `{id,name,query,catalogUrl,createdAt}`. Web: «Сохранить как умную полку» in the catalog filter panel, section on `/shelves`; OPDS `/opds/user/smart-shelves[/:id]`. Web `/shelves` rows show cover thumbs + book count for smart shelves like regular ones (`listSmartShelves(user, {withPreview:true})`: `bookCount`, `previewBookIds`; opt-in, API/OPDS stay cheap). Pin to home: additive `onHome` (0/1; column `on_home` on `shelves` and `smart_shelves`) toggled by web forms `POST /shelves/:id/home` and `POST /shelves/smart/:id/home` (`on=1|0`); the authenticated home renders pinned non-empty shelves (max 8, below «Новинки» and recommendations; anonymous home unaffected). Not yet used by the Android reader
- Folder watching (`src/services/folder-watcher.js`, thread `folder-watch-worker.js`): enabled **folder** sources are watched with recursive `fs.watch` in a `worker_threads` worker (Linux walks the whole tree synchronously at start — never in the main thread). Book/archive events (`fb2|epub|mobi|azw3|zip|7z`, directories) → after quiet period (default 120 s) `startSourceIndexing(id, false)`; busy indexer → source is marked dirty (no timer retries) and re-triggered only after a **successful** index completion (`onIndexComplete`), so a Stop never restarts itself. Folder incremental import mode compares changes to the whole library (`MAX(rowid)` of `books`), not to the source's file count, so a few dozen new books never trigger the full FTS/index rebuild. Only sources with a finished first index (`lastIndexedAt`) are triggered. Watcher errors (e.g. inotify limit) retry after 5/10 min, 3 failures → watching off for that source until restart (interval scans stay the fallback; SMB/NFS often emit no events). Sources and settings are reconciled every minute (add/update source and the settings form also reconcile immediately in the process that serves them); in a cluster only worker 1 watches. **Web admin is the control surface** (Admin → Sources: toggle `folder_watch_enabled`, quiet period `folder_watch_quiet_sec`, per-source status from meta `folder_watch_status`; env `FOLDER_WATCH` / `FOLDER_WATCH_QUIET_SEC` are only the defaults). No public API; the Android reader does not use it
- Product priority: the **web UI is the primary client** — new features land in the web UI/admin first; API / Android reader parity follows later and is not a blocker
- Index safety: `indexFolder` aborts (throws, DB untouched) when the scan finds **zero** files but the source already has books — an unmounted volume looks like an empty folder and would otherwise purge books and cascade user data; delete the source if the files are gone on purpose. After an INPX import `checkInpxArchivesOnDisk()` (`src/inpx.js`) samples ≤50 archives (zip/7z, same lookup as downloads): none found → `warn` system event + index diary line («проверьте путь и монтирование»), some missing → `info` (partial collections are normal)

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

Web static assets (`public/sw.js`): the Service Worker is **network-first** for `STATIC_ASSETS` (`fetch` with `cache: 'no-cache'`, install uses `cache: 'reload'`); the SW cache is only an offline fallback. A cache-first SW combined with `immutable` headers served a stale `position-sync.js` next to a new `reader.js` and the web reader hung on «Загрузка книги…» (`SyntaxError: does not provide an export`). `node scripts/build-assets.js` bumps `CACHE_NAME`.

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

Settings, users, catalog, FTS and cover cache live in **one** `library.db`. Do not split the file. Dashboard counters use `library_stats_snapshot` (written after catalog refresh) so admin pages do not `COUNT(DISTINCT)` million-row views. `/health` does no DB work — a watchdog timeout means the Node event loop is blocked (heavy sync SQLite), not a missing health query.

Event-loop hygiene (700k-book libraries): `refreshCatalogBookCounts` runs in a `worker_threads` worker (`src/services/catalog-counts-worker.js`, own connection, chunked UPDATEs; `CATALOG_COUNTS_INLINE=1` forces the old inline path) — never call it for a single book, use `adjustCatalogCountsForBook(id, ±1)`. `dropBooksTableIndexes` → `ensureBooksTableIndexes` must end with `analyzeBooksIndexesYielding()`: DROP INDEX wipes `sqlite_stat1` and without stats the planner sorts the whole catalog in a TEMP B-TREE (~800 ms per page instead of ~2 ms); boot re-checks via `booksIndexStatsMissing()`. Browse ORDER BY must match an existing index exactly (`idx_books_title_nocase_id`, `idx_books_series_full` — no `CAST`, `idx_books_recent_sort`, `idx_books_date10` for novinki); a sort key from the joined `sources` table (`flibusta_sidecar`) is only added when enabled sources differ in that flag. `show_deleted_books=1` rewrites `active_books` as `deleted = 0 OR NOT EXISTS(suppressed)`, which disables every `WHERE deleted = 0` partial index — keep it off unless debugging. `[perf] event loop stalled N s` in `runtime.log` (threshold `LOOP_STALL_LOG_MS`, default 2000) is the first thing to check for "server hangs" reports; `/health/perf` has per-route p95. Plain catalog browse (no `q`) reads `catalog_active_books` (JOIN on the materialized `active_book_ids`) while `active_books_projection_state.dirty = 0` and the filter fingerprint matches; any write to `books`/`book_genres`/`sources.enabled`/`genres_catalog.name`/`suppressed_books` flips it to `1` (triggers) and browse falls back to the dynamic `active_books` view. The projection is rebuilt by `ensureActiveBooksProjection()` — single-flight, chunked by `books.rowid` with `setImmediate` yields (state `2` = building; a write during a pass leaves it stale and a follow-up pass runs) — never synchronously: `refreshCatalogBookCounts`/boot only call the debounced `scheduleActiveBooksProjection()`; `rebuildActiveBooksView` (filter settings change) awaits `ensureActiveBooksProjection()`. Cover thumb disk cache: `COVER_THUMB_DISK_TTL_DAYS` (30) / `COVER_THUMB_DISK_CACHE_MB` (2048), daily GC in `scheduler.js`. Admin **Backup** can export/import users JSON (password hashes, email, Telegram, favorite author/series **names** — not book ids, which change on reindex). Existing usernames are not overwritten.

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
