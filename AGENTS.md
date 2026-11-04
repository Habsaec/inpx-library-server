# INPX Library Server — Agent Instructions

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
| Source delete keeps user data | Deleting a source never removes users, settings or per-book user data (`bookmarks`, `read_books`, `book_ratings`, `reading_history`, `shelf_books`, `reading_positions`, `reader_*`). `deleteSourceProgressive` / `forceDetachSourceRowUnsafe` stash a book fingerprint (`lib_id` + `archive_name` + `file_name` + `ext`) in `detached_book_refs`, delete books with `foreign_keys=OFF` (no `ON DELETE CASCADE`), and `reattachDetachedUserData(sourceId)` (called at the end of INPX/folder indexing) moves the rows onto the re-indexed books. Orphan rows are hidden by `active_books` joins. A full (non-incremental) reindex (`rebuildIndex` in `src/inpx.js`, `indexFolder`) does the same stash → delete with `runWithForeignKeysOff` → reattach, so user data survives it too. Folder incremental (book id = sha256 of the path, so a rename/move changes it): a vanished file with user data gets a `detached_book_refs` row with `source_id` + `size` + `title_key` (`stashMovedFolderBookRef`) and is deleted with foreign keys off; at the end of the pass `reattachMovedFolderUserData` moves the rows onto a book new in this pass by size+ext+title/authors → size+ext+file basename → size+ext (loose files only; inside zip/7z `size` is the container's), accepting a pair only when it is unique on both sides (ambiguous → stays detached, orphans hidden by `active_books`). Refs unmatched for 30 days count as a real delete: their user rows and the ref are purged (delayed cascade); refs from a source delete (`source_id` NULL) never expire. Incremental INPX collects orphan candidates (removed `.inp`, rows missing from a changed `.inp`) and purges them only at the end of the pass, skipping ids seen in any `.inp` — a book moved between archives (daily `.inp` merged into a big one) keeps its id and user data; until that purge, meta `inp_sizes_<id>` keeps the old fingerprint of those `.inp`, so an interrupted pass finds them again; suppressed duplicates (`suppressed_books`) are never purge candidates. An `.inp` over `MAX_INP_ENTRY_BYTES` (256 MB) is skipped with a `warn` event and its fingerprint is not stored, so it is retried. Folder incremental: `stat` runs async in windows of 2500 (8 at a time, only `mtimeMs`/`size` kept); a failed `stat` keeps the previous fingerprint (not «deleted»). A full reindex does no `VACUUM`. Cluster index lock (meta `index_active` / `index_pid` / `index_heartbeat`): a heartbeat older than 30 s is taken over only if the owner pid is dead, or after 10 min regardless (pid reuse after a container restart) |
| Series key | `mergeSeriesQualifierDuplicates` (boot + 5 s after every non-unchanged index pass) also folds Flibusta disambiguation rows `X [Q]` / `X (Q)` / `X. Q` into the bare `X` when Q is generic («межавторская серия») or an author surname present in both series («Вечная война [Карелин]» stays apart). `series_catalog.name` = `seriesCatalogKey()` (`src/inpx.js`: lower-case, ё→е, every non-letter/digit run → one space; no fuzzy matching — «Дюна» ≠ «Дюна 2»), used by INPX / folder / Calibre indexers, manual edit and users backup import. `ON CONFLICT DO NOTHING`: the first-seen spelling stays `display_name`. `resolveSeriesCatalogName` tries the old lower-case name first, then the key, so old URLs / backups / Android requests (`name=` in `/api/series-*`, favorites) still resolve — no API change, Android needs nothing. One-time `mergeSeriesCatalogByKey` (meta `series_key_merge_v1`, started at boot, time-sliced (40 ms of work, then a pause), waits for an active index pass) merges existing rows with the same key: `book_series` / `favorite_series` are repointed to the winner (most books) **before** the loser is deleted (both are `ON DELETE CASCADE` — deleting first would drop favorites), then counts are refreshed. `books.series` text is untouched. OPDS author+series feed matches by `book_series`, not by that text |
| Portable backup | Admin → Backup: `GET /api/operations/portable-backup` (gzipped JSONL, `src/services/portable-backup.js`) and `POST /api/operations/portable-restore?dryRun=&replaceUsers=&includeSettings=&includeSources=` (raw `application/gzip` body, spooled to `data/tmp`, single-flight). Not the catalog: users, settings, uploaded collections, shelves / smart shelves, favorites (by name), not-recommended, goals, KOSync keys, Telegram chats, OIDC links, excluded filters, sources (imported **disabled**), `data/ui/*` files, and every per-book user table (`BOOK_TABLES`) with a fingerprint (`lib_id` + archive + file + ext), never a trusted book id. Import writes book-bound rows under `restore:<backup stamp>:<oldId>` plus a `detached_book_refs` row (`source_id` NULL, never expires), then `reattachDetachedUserData(null)` moves them onto the real books now or when indexing creates them; existing rows win (`INSERT OR IGNORE`). Shelf / smart-shelf ids are remapped (also inside `home_layout.shelfOrder`), «replace existing accounts» is needed on a clean install (bootstrap `admin/admin`). Skipped on purpose: catalog tables, `meta`, `suppressed_books`, `kosync_documents` / `kosync_progress` (document hash maps to a book only after a download), tokens; `test/portable-backup.test.js` fails when a new table is in neither `PORTABLE_EXPORTED_TABLES` nor `PORTABLE_SKIPPED_TABLES`. Reader bookmarks / annotations get new ids and can duplicate if the same file is imported twice. Admin / server only — Android needs nothing. Stored copies + daily schedule (`src/services/portable-backup-store.js`): `data/backups/portable/inpx-portable-<stamp>.jsonl.gz[.enc]`, settings `portable_backup_enabled` (default on) / `portable_backup_keep` (default 7), checked hourly + 10 min after boot, one per 24 h, worker 1 only in a cluster; `GET/POST /api/operations/portable-backups`, `GET/DELETE …/:name` (strict name regex, no paths), `POST /api/operations/portable-backup-schedule`, restore from a stored copy = `portable-restore?file=<name>`. Secrets stored encrypted with this install's `data/.session-secret` (`smtp_pass`, `telegram_bot_token`, `oidc_client_secret`, `recaptcha_secret_key`) are written decrypted (`enc: 1`) and re-encrypted on import — a restore onto a fresh install must not carry values nobody can decrypt — but ONLY inside an encrypted file: the admin sets a **backup password** once (`POST /api/operations/portable-backup-password`, ≥ 8 chars; the server keeps scrypt(password, salt) encrypted with the install key as settings `backup_key` / `backup_key_salt`, never the password, and these two settings are never exported). With a password every portable backup, manual and daily, is `INPXENC1` + salt + iv + AES-256-GCM(gzip) + tag (`src/services/portable-backup-crypto.js`, file extension `.jsonl.gz.enc`); restore needs the password (header `X-Backup-Password`, key derived from the salt in the file; the tag is verified in one full pass BEFORE any row is applied, so a wrong password or a flipped byte changes nothing). Without a password the file is plain gzip and carries NO secrets (header `secrets: false`). **There is deliberately no full-database copy / restore in the app** (it existed briefly): a multi-GB `library.db` copy stalled the event loop for tens of seconds even in a worker-based version on slow storage (NAS / Docker volume) and a force reindex no longer takes an automatic copy either; the catalog is rebuildable from the sources and user data survives in the portable backup. To copy the file itself, stop the server and copy `data/library.db` |
| INPX DEL=1 | Indexed with `deleted=1` (not purged). Hidden by default via `active_books`; admin **Content → Show deleted books** (`show_deleted_books`) reveals them. Soft-deleted duplicates (`suppressed_books`) stay hidden. Book payloads may include additive `deleted: 0\|1` |
| Android-only reader | `inpx-book-reader` targets **Android APK only** — do not design API or UX for iOS/desktop/web client |
| Compressed libraries | Flibusta + Librusec «96 GB» builds: ZIP entries use **PPMd** (`unzipper` can't inflate → `archives.js` falls back to 7z for non Store/Deflate methods) and FB2 images are **WebP** (often inside `content-type="image/jpeg"`). Admin **Content → WebP images in FB2** (`fb2_webp_images`: `keep`\|`png`) recodes WebP `<binary>` to PNG on download / fb2cng input (`src/fb2-webp-images.js`); `/api/books/:id/content` (web reader, Android) is never converted. Book archives as **`.7z`** (solid): catalog covers must not unpack the FB2 (`bookUsesSevenZipArchive`); sidecar image reads use `listFallback: false` so a miss does not `7z l` a huge archive (that froze Node and made Android reconnect every ~30 s). Flibusta `images/*.zip` illustrations are **JPEG XL**: `mergeSidecarBinariesIntoFb2Xml` (reader `/api/books/:id/content`, downloads, conversion) decodes them in a `worker_threads` pool (`src/services/jxl-pool.js` + `jxl-worker.js`: libjxl via `@jsquash/jxl` → sharp JPEG q85, PNG only when the image has alpha; `JXL_WORKERS`, `0` = off; falls back to `jxl-oxide-wasm` PNG in the main thread when sharp/worker is unavailable) and caches the assembled FB2 in `data/converted-books/fb2-sidecar-*.fb2` (`src/fb2-sidecar-cache.js`: only builds slower than `FB2_SIDECAR_CACHE_MIN_MS`=1500, cap `FB2_SIDECAR_CACHE_MB`=1024, `0` = off). A 175-image book went from ~55 s / 150 MB to ~6 s / 23 MB (instant when cached). Adding such a dump next to an already indexed Flibusta/Librusec source creates hundreds of thousands of duplicates (`sourceId:libId`); Admin **Duplicates → auto-clean** keeps the newer source when formats match, also hides the same Flibusta `lib_id` across sources (even if title/author drifted) and same-title pairs from two sources when the author was renamed, and must not load every duplicate row into RAM |

Key endpoints for reader:
- `GET /api/books/:id/meta` (`seriesList` from index)
- `GET /api/books/:id/publish-info` → `{ publishYear: number|null, isbn }` — edition year + first ISBN from FB2 `<publish-info>` (no year → `<title-info><date>`), `extractPublishInfo` / `getBookPublishInfo` in `src/fb2.js`. Stored in `book_details_cache` (`publish_year`, `isbn`, `meta_version`; `BOOK_DETAILS_META_VERSION` — rows below it are re-read lazily). A full archive extract in `getOrExtractBookDetails` fills it; Flibusta SSR never opens the archive and rows cached earlier have no data, so the route reads the FB2 once (single-flight per book) and stores the result, «nothing there» included. Non-FB2 → empty, no read. Additive `publishYear` / `isbn` also in `/api/books/:id/details` (only when already cached). Web book page: year + «ISBN …» in the summary line, otherwise `data-publish-info-for` → `loadBookPagePublishInfo()` in `app.js`. Android `BookDetailsSheet`: «Год издания» replaces the catalog «Год» (INPX date) + «ISBN» row (`fetchBookPublishInfo`)
- BB-codes in annotations: `annotationBbCodeToHtml` (`src/html-sanitize.js`) in `getDetails` (`src/routes/library.js`) → book page, `/api/books/:id/details`, `details-batch`. `[b] [i] [u] [s]/[del] [quote(=who)] [spoiler|hide(=title)]` → `<details><summary>`, `[url(=…)]` (http/https only), `[list][*]`; `[color] [size] [font] [center]…` keep the text, unpaired known tags are dropped. Plain text is HTML-escaped first; the result always goes through `sanitizeHtml` (server) / `sanitizeHtml.ts` (Android), both allow `u s details summary`. Titles lose `"<>` and `=` becomes `&#61;` (the `on…=` stripper of sanitizeHtml ate the closing `</summary>`)
- E-mail to an e-reader (`/api/send-to-ereader/:id`, `/batch`) names the attachment by the title (`EMAIL_FILENAME_STYLE` = `title`, `resolveDownload(…, { filenameStyle })`), whatever Admin → Content says: Kindle shows the attachment name as the book title. Downloads, ZIP and Telegram keep the admin style
- Подборки (curated collections, `src/collections.js`, `src/routes/collections.js`; pages `renderCollections` / `renderCollection` in `src/templates/library.js`, admin card `renderAdminCollectionsCard` in `src/templates/admin.js`): lists «author + title» from `collections/*.json` (bundled, synced at boot by content hash — `builtin`, can only be turned off) and admin uploads (Admin → Content → «Подборки»: JSON ≤ 1 MB / 1000 items, same slug replaces an upload; `POST /admin/collections/import|rematch|:id/toggle|:id/delete`; the import route has its own 4 MB urlencoded parser in `server.js`). Tables `collections` + `collection_items` (`book_id` without FK; joined with `active_books`, so a hidden / deleted book shows as missing). Matching (`matchCollectionItem`): candidates by an index range on `books.title_search` (`createSortKey` prefix, ~20 ms — `searchBooks` took ~1.3 s per item and would stall the loop), title exact or word-prefix (list title loses `(…)` / `: …`, the book title does not, so «"Мастер и Маргарита": статья» is only a prefix hit), author = a list word equals a book **surname** (part before the first comma of each `Фамилия,Имя,Отчество`) by 5-letter stem, words < 5 letters must be whole (Ли, По), х≈г (Герберт / Херберт); best = exact title, then Russian edition for a Cyrillic list, then `lib_rate`, FB2, shorter title. Runs in the background one item per `setImmediate` (single-flight, worker 1 only in a cluster): at boot for never-matched lists, 30 s after every `onIndexComplete` for all, right after an upload. API (browse auth): `GET /api/collections` → `{ items: [{ slug, title, description, source, sourceUrl, total, found, matching, previewBookIds }] }`, `GET /api/collections/:slug` → `{ …, read, items: [{ position, author, title, year, note, book: Book|null, read }] }` (404 when missing / disabled). Web (no own markup — reuse the existing patterns): «Подборки» in the sidebar «Обзор», `/collections` = the «Мои полки» rows (`shelf-list-row`, cover thumbs), `/collections/:slug` = a library section (`renderBookGrid` / `renderBookFlibustaList` by the catalog covers/list preference `?view=`, batch toolbar) with the found books in list order, then «Нет в библиотеке» as plain `table-row`s with a catalog search link. Android: Каталог → «Подборки» row (shown only when the server has collections) → `CollectionsPanel` built from the shelf screens (rows like «Мои книги → Полки»; a collection like `HomeShelfPanel`: `CatalogBookList` + `ViewModeToggle`, then «Нет в библиотеке» rows). The bundled lists come from the scanek fork and are partial — titles say so (no «200» / «100»). Pin to home (per user, like a shelf's `on_home`): table `collection_pins (username, collection_id, pinned_at)` (cleaned by `deleteUser`), `POST /api/collections/:slug/home { on }` → `{ ok, onHome }` (404 for a missing / disabled one), web form `POST /collections/:slug/home` (`on`, `next` = `/collections[/<slug>]`) — the house icon (`renderShelfHomeForm`) on the `/collections` rows and the collection page; additive `onHome` 1|0 in `/api/collections` and `/api/collections/:slug` for a signed-in user. `getPinnedHomeShelves(user, limit, { collections: true })` appends pinned enabled non-empty collections after the pinned shelves (pin order, at most 8): `{ id, kind: 'collection', slug, title, href: '/collections/<slug>', items }` (found books in list order). On the web home they are their own block `collections` in `homeLayout` («Закреплённые подборки», `getPinnedHomeCollections`; Profile → «Главная страница» shows / hides / moves it like any block, hidden = not computed); `GET /api/home/shelves` only with `?collections=1` — older Android builds take every non-`smart` item for a regular shelf id (open `/api/shelves/:id/books`, unpin `/api/shelves/:id/home` = someone's real shelf). Order: per user `homeLayout.collectionOrder` (slugs, like `shelfOrder`; `orderCollections` / `reorderCollectionList` in `src/home-layout.js`) orders `listCollections({ username })` (the /collections list, `/api/collections`) and the pinned block; web drag = `[data-sortable]` on the /collections rows → `POST /collections/order` (`order=slug,…`, a full permutation or nothing), Android saves it with `POST /api/preferences { homeLayout }`. `setUserHomeLayout` keeps the stored `collectionOrder` when the incoming layout has no such key (Android 1.10 saves its layout without it). Collections are not part of `homeLayout.shelfOrder`. Android: house icon (`ShelfHomeToggle`) on each `CollectionsPanel` row and on an open collection → `App.handleSetCollectionOnHome` (`setCollectionOnHomeApi`, optimistic, reloads Home); rows drag by ⠿ (`DragRow` / `useDragOrder`, as `SortableShelfList`) → `App.handleReorderCollections`; «Искать» on a missing book runs the catalog search for title + author; the source is plain text (the app opens no external pages); Home asks `/api/home/shelves?collections=1`, «Все» opens `HomeShelfPanel` with `kind: 'collection'` (books from `fetchCollection(slug)`), «Убрать с главной» unpins via the same handler
- `GET /api/books/:id/cover-thumb` — additive `?hd=1`: twice the cover size setting (≤ 1200×1600), WebP q80; the Android reader asks for it in E-Ink mode (~300 ppi upscaled the 220×320 thumb). HD thumbs are kept only in the disk cache (`coverThumbCacheKey(id, true)` = `<id>#hd`, not in the 4000-entry memory cache); `invalidateCoverThumbCaches` drops both sizes. The web UI keeps the normal thumb
- `GET /api/books/:id/position` — position fields plus `positionVersion: 4`, monotonic `revision`, and holder `sessionId` / `lastUserActivityAt` / `sessionStatus` (`active` if user activity within 4 minutes); rows below v4 are migrated lazily and idempotently
- `POST /api/books/:id/position` — CAS write; requires `positionVersion: 4` and `baseRevision`, optional `sessionId`; returns a new `revision`; a different *active* session cannot overwrite even with a matching revision; stale writes receive `409 { current }` unless the holder session is idle (>4 min) and the writer is a different `sessionId` (idle-steal); clients that omit `sessionId` keep revision-only CAS; legacy protocol clients receive `428`; marks read at `progress >= 99` and clears that status when rereading drops below 95%; additive `releaseSession: true` (with `sessionId`) releases the hold after the write (web reader `pagehide` with a pending save)
- `POST /api/books/:id/position/release` `{ sessionId }` → `{ ok, released }` — a closing reader gives up its hold (`last_user_activity_at` = NULL, only when it is the current holder; coordinates/revision untouched). Without it a closed open stayed the «active» holder for 4 min, so the next open (new `sessionId`) got 409 on every save — Android showed the old % after exit and the web kept the old value. Android calls it after the close-time `finalizeReadingPositionSync`; web `reader.js` on `pagehide`
- `GET /api/books/:id/reader-sync-meta` — bookmark/annotation revs and position sync metadata (`positionRevision`, `positionUpdatedAt`, counts)
- `GET /api/reader-sync-index?ids=` — bulk dirty-check for Android silent sync: `{ activity, books[], unknownIds[] }` (same fields as per-book meta + `bookId`; max ~200 ids). Additive `unknownIds` = requested ids this catalog does not have (`local:<sha256>` excluded)
- `POST /api/books/resolve` `{ books: [{ id, title, authors, ext, libId? }] }` (max 200) → `{ items: [{ id, bookId|null, match: 'id'|'libId'|'title'|null }] }` (`src/book-resolve.js`): maps a book id from another catalog — a book the Android app downloaded from another server, or before its source was re-added under a new source id (`9:857614` there = `6:857614` here) — by known id → same `lib_id` (from `libId` or `<src>:<lib>`) + title (+ ext) → title + authors (+ ext); only a unique match counts, no title = no guess. Without it every per-book call of such a book answered 404 and its position / history never reached the server (web showed nothing). Android keeps the local id and sends the server id via `serverBookAliases.ts` + `bookRef.ts`
- `GET /api/profile` — user stats, recent books, bookmarks, annotations (Android profile screen); additive `user.email` (account email); additive `userStats.smartShelvesCount` — every «Полки» counter (web `/library/my`, profile tiles, favorites nav, Android profile) shows `shelvesCount + smartShelvesCount`. The web `/library/my` hub shows totals: «Новое у любимых» there is the whole list (`getFollowingNewCount(…, { unseenOnly: false })`), only the sidebar badge counts unseen books
- `GET /api/account-email` / `POST /api/account-email` (`{ email }`, empty clears) — account email `users.email` (unique, lower-cased; `400 PROFILE_INVALID_EMAIL`, `409 PROFILE_EMAIL_TAKEN`); separate from `/api/ereader-email`. Also settable in web/lite profile and Admin → Users. Password reset (`/forgot-password`) matches the account email first, then falls back to the e-reader email
- `GET /api/settings/ui` — public library chrome for Android: `siteName`, `logoUrl`, palettes, `radius`/`radiusPreset`/`radiusScale`, `shadows`/`shadowPreset`, `backgroundUrl`, `bgBlur`, `bgOverlayStrength`, `bgSize`, `bgPosition`, additive `headerUrl` / `hasHeader` / `hasCustomHeader` / `showHeader` / `showLogo` / `headerHeight` (80–640, default 180) / `headerPosition` (`center`/`top`/`bottom`) / `headerSize` (`contain`/`cover`, default `cover`; bundled `/header.png` is on by default — custom upload replaces it; Admin → Appearance can hide the header or logo), `surfaceOpacity` (0–100), `surfaceBlur` (0–24px), `coverFallbackUrl`, `coverFallbackLightUrl` (same URL when a custom placeholder is set; otherwise the dark and light bundled plates)
- Theme palette (`src/services/theme-engine.js`): the built-in surfaces (`#1a1612` / `#fff9f0`; old light default `#fffdf8` is an alias) resolve to the hand-tuned tokens of `styles.css`, so a changed accent or text color changes only that role (gold-tinted dark borders follow the accent). Auto links derive from the accent when one is set; every **auto** text / muted / link / accent is nudged to ≥ 4.5:1 against its surface (`ensureContrast`), preset accents too; manual colors are kept and Admin → Appearance → Тема shows a contrast badge per role (preview API returns `palettes.{dark,light}` with `contrast`). Only a custom surface, a background image or non-default panel sliders turn on glass panels (`usesPanelGlass`; stored defaults 88 / 0 do not count). `themeVersion` in `/api/settings/ui` is an opaque hash of the whole payload; `appPalette*.bg` is the page background (built-in `#14110e` / `#f3ebe0` by default). Web theme toggle cycles light → dark → «авто» (follows the OS light/dark; no `theme-preference` in localStorage), matching the Android «Авто». Android «Цвет: Сервер» applies the whole `appPalette*` (page, surfaces, text, muted, borders, links, accent), so keep every `appPalette` field meaningful
- Background layers (web, `public/styles.css` «Layers over a background image»): `body::before` picture (z -2) → `.main-wrap::after` content veil under the whole right column (z -2, panel glass × 0.75, follows «Прозрачность панелей») → `body::after` theme-tinted overlay (z -2, later in tree order) → decorative washes (z -1) → content. The picture is grown/scaled only while blurred (`backgroundLayoutToCssVars(size, position, blur)` → `--ui-bg-inset` / `--ui-bg-transform`); panel blur uses `--ui-panel-backdrop` (`none` at 0). `--bg` is transparent over a picture — use `var(--bg-solid, var(--bg))` where a real page color is needed. `prefers-reduced-transparency` / `prefers-contrast: more` force solid panels and veil. Admin slider «Видимость фона» = `bgOverlay` (0 hidden … 80 as is; default 32 → `bgOverlayStrength` 48). The Android app does not draw the server background picture
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
- «Читаю» / «Продолжить чтение» (`reading_history`) не показывают книги из `read_books`; при снятии «Прочитано» (в т.ч. при progress ниже 95%) снова появляются там. Раздел «Прочитано» отдельный. Android follows the same rule (home «Читаю», «Мои книги → Читаю» from `/api/library/continue`) and hides a downloaded book removed from the server history after it was last opened (`readingHistoryRev` of `/api/reader-activity-sync-meta`).
- Cross-device reading position uses server revisions/CAS plus per-open `sessionId`; an idle holder (>4 min without page turns) can be stolen; a different active session cannot take over via matching-revision CAS; an open reader prompts on a live coordinate conflict (never silent jump); «stay here» is bound to that holder `sessionId` until the holder changes
- `GET /api/search?q=` — search section totals: `{ query, books:{total, capped?}, authors:{total}, series:{total}, preferredField?, routeField: null }`; book totals capped (≤10k); web `/catalog?q=` always opens books with Авторы/Серии chips (no hub / smart redirect)
- `GET /api/search/suggest?q=` — typeahead books/authors/series (web dropdown + Android); multi-word book suggest prefers title scope; web/Android author/series hits open the facet page (`/facet/authors|:series/:name`), not catalog `field=authors|series`
- `GET /api/search/genres?q=` — genres among matching books (optional `format` / `year` / `minRate` / `hasSeries`); web loads lazily after HTML for free-text
- `GET /api/catalog` — lists books even without `q`/filters (paginated browse); additive filters (AND): `genre` (single/CSV/repeated; multi = OR by default; additive `genreMode=and` requires every selected genre — web catalog filter panel toggle, default `or`), `lang`, `format`, `year`, `minRate` (1–5), `hasSeries` (`1`/`0`), plus `q` / `letter` / `field` / `sort`; empty/weak may include additive `searchHints` (`tip`, `didYouMean`, `weak?`). A logged-in user's `users.content_langs` (Profile → view, empty = every language the admin left) further limits catalog, search, author/series/genre lists (the count on each row is only books in those languages), facet books, novinki, recommendations and smart shelves on the web and the matching `/api/*` lists; a page `lang` outside that set matches nothing. Continue reading, read, and ordinary shelves stay unfiltered, and a direct book URL still opens. Cover cards and list rows show the language code. Web author / outside-series / series / genre pages take `?lang=` (picker next to sort, shown when there are 2+ languages to choose). Language codes are compared case-insensitively (`ru` / `RU` / `Ru` are one language; the admin still hides exact raw values)
- `GET /api/library/recent` — novinki by INPX catalog `date` (30 days before the newest dated book in the DB, paginated); not full catalog / not reindex `imported_at` stamps; additive filters like catalog: `genre` (CSV/repeated, OR by default; additive `genreMode=and`), `lang`, `format`, `year`, `minRate`, `hasSeries` (1/0)
- `GET /api/library/continue` — «Продолжить чтение» (`reading_history` minus `read_books`); additive `lastOpenedAt` / `openCount` per item (web `/library/continue` cards/rows have «Убрать» → `DELETE /api/reading-history/:id`, undo re-POSTs these two fields). Web home hero renders one book with the same markup as the carousel (no dots/counter)
- «Хочу прочитать» (table `want_to_read`, in `USER_BOOK_TABLES`, cleaned by `deleteUser`): `POST /api/want/:id` toggles → `{ want }`, `DELETE /api/want/:id` → `{ want: false }` (also `/api/want/b64/<ref>`), list `GET /api/library/want` (same shape as `continue`/`read`, `sort=recent|title|author|rating`). A book leaves the list when it is opened (`recordReadingHistory`, `upsertReadingHistoryEntry`) or marked read (`toggleReadBook`, `addReadBooksIfMissing`); the list query also hides read / opened books. Web: bookmark icon in the book page corner (hidden for read books), `/library/want` with «Убрать» on cards/rows, sidebar + `/library/my`; additive `wantCount` in `getUserStats` / `/api/profile`. Android: «Хочу прочитать / Отложено» in `BookDetailsSheet`, «Мои книги» segment, `wantIds` in `useInpxServer`
- «Новое у любимых»: unread books of favorite authors (`book_authors`) and series (`book_series`) with INPX `date` within 90 days of the newest dated book — `GET /api/library/following` (newest first, profile content languages applied), web `/library/following`, a home shelf (web only — `/api/home/shelves` keeps its `shelf`/`smart` kinds) and a sidebar badge = books newer than meta `following_seen:<user>` (set when page 1 of `/library/following` is opened; count memoized 2 min, cleared by `invalidateUserPageCaches`). Android: home section after «Рекомендации» + `LibrarySectionPanel view="following"` (no filters)
- Series progress: web series page and the Android series screen (`GET /api/series-progress?name=` → `{ total, read, next: { id, title, seriesNo } | null }`, API auth) show «Прочитано N из M» and «Начать читать / Читать следующую» (`getSeriesReadingProgress`: editions with the same number + title count once, unnumbered volumes last, profile languages applied, always the whole series — also under `?author=`); author page series rows add «прочитано N» (`getSeriesReadCounts`) until the series is fully read
- Series info (web + Android): `GET /api/series-info?name=` (API auth) → `{ name, displayName, bookCount, volumeCount, authorCount, authors: [{ name, displayName, bookCount }] (≤ 24, most books first), genres: [{ name, displayName, displayNameEn, bookCount }] (≤ 12), languages: [{ code, bookCount }], yearFrom, yearTo }` (`getSeriesInfo` in `src/inpx.js`): every query starts from the series row (`idx_book_series_series_id` → `active_books` by id → `book_authors` / `book_genres` by `book_id`), so the cost is the size of the series (largest real series 3.6k books ≈ 35 ms per query), cached 10 min per series + languages (key carries `runtimeQueryCacheGeneration`). Profile content languages apply (web: `langState.list`, also the page `?lang=`); volumes use the progress key (`seriesVolumeKey`: number + title, editions once); years = INPX `date` range (1800–2100). Web: `renderSeriesInfo` in the series hero (authors → `/facet/authors/…`, genre chips, language links, years; «Томов» next to the book count when it differs) — the old unfiltered «Авторы серии / Жанры серии» summary under the series list is no longer built. Android: `SeriesInfoBlock` on the series screen (reader AGENTS.md)
- Account preferences (web + Android): `GET/POST /api/preferences` → `{ hideRead, downloadFormat, telegramDigest, homeLayout }` (POST takes any subset; also additive in `/api/profile` `user`). Columns `users.hide_read`, `download_format`, `telegram_digest`, `home_layout`
- «Главная страница» (web + Android): additive `homeLayout` `{ order, hidden, shelfOrder }` of section ids `continue`, `recent` (app-only «Недавно читали»), `novinki`, `recommended`, `following`, `shelves`, `collections` (pinned collections, own block «Закреплённые подборки») (`src/home-layout.js`: `normalizeHomeLayout` drops unknown ids and puts missing ones back at their default place, the default layout is stored as ''). Web: Profile → view «Главная страница» (checkbox + ▲▼ per block, `POST /profile/home-layout` with `show[]`, `move=<id>:up|down`, `reset=1`; web moves skip the app-only block), the `/` route does not even compute hidden blocks and the grid/list toggle sits on the first shelf; with «Продолжить чтение» hidden the banner shows only the quote. Android: Profile → Внешний вид «Блоки главной» (`src/lib/homeLayout.ts`, cached in localStorage; the old local «Новинки: Скрыть» moves into the hidden list once). `shelfOrder` (`shelf:<id>` / `smart:<id>`, ≤ 100) is the user's order of all shelves, set by dragging them in the shelves lists; unlisted (new) shelves follow in the old order (regular, then smart, by name). It sorts the web /shelves lists, `GET /api/shelves`, `GET /api/smart-shelves` and the pinned shelves of the web home and `/api/home/shelves` (`listShelfRefs` → `orderShelves`, ≤ 8 non-empty), so the home shows pinned shelves in the list order. Regular and smart shelves form one list in that order (web /shelves and the app «Мои книги»; a smart shelf — saved catalog filter — is marked by a search icon), so they can be put in any order; a drag sends the whole list (`POST /shelves/order` `order=smart:3,shelf:1,…`, JSON with `Accept: application/json`) and `reorderShelfGroup` stores a full permutation as is (a one-kind order from older clients still refills only that kind's slots). Drag-sortable web lists (/shelves and the Profile «Главная страница» blocks): `[data-sortable]` + `data-sort-url`, rows `data-sort-key`, handle `[data-sort-handle]` (`initSortableLists` in `public/app.js`: pointer drag with listeners on `document` — moving the row in the DOM drops pointer capture — and ↑↓ on the focused handle; the dragged row follows the pointer by `transform`, the others slide aside by FLIP on `offsetTop` (`.is-sortable` is `position: relative`), the row settles on drop, the page auto-scrolls near the window edges, `prefers-reduced-motion` turns the motion off; a click on the handle never opens a clickable row); the blocks list POSTs `order=…` to `/profile/home-layout` (`reorderHomeSections` keeps the app-only `recent` in its slot) and keeps ▲▼ submit buttons for pages without JS. Android: drag handles (`src/ui/DragReorder.tsx`, motion `Reorder`) in the one «Мои книги» shelf list (rows and cards) and in «Блоки главной»; the app saves the same `homeLayout.shelfOrder` through `POST /api/preferences`, and Home sorts the fetched shelves by it. Every writer of `homeLayout` must keep `shelfOrder` (spread the current layout)
- Download format in the Android app: the app follows the account `downloadFormat` only for formats its reader opens (`epub2` / `epub3` / `kepub` → saved as `.epub` from `GET /download/:id?format=` (`/download/b64/<ref>`)), and only when the book's `downloadFormats` (catalog lists, additive in `/api/books/:id/meta`) offer it; otherwise (`''`, `fb2zip`, `kfx`, `azw8`, non-FB2 books) it keeps downloading `/api/books/:id/content`. Settable in Profile → Хранилище «Формат скачивания» (Исходный / EPUB / EPUB3 = the same server preference). A converted EPUB and the web FB2 share the position only by fraction: `positionForBookFormat` (`public/position-sync.js`) drops the CFI / `fb2Href` / section-offset anchor / page of a position saved in the other format (FB2 = `fb2Href` without CFI, EPUB = `epubcfi(…)`) — both readers call it before restoring (Foliate failed on `goTo('0#2')` in an EPUB)
- «Скрыть прочитанное»: `hideReadUser` filter (`NOT EXISTS read_books`) in `buildCatalogExtraFilters` → catalog / search, novinki (`/library/recent`), facet books (series / genre / language), author page (`getAuthorBooksGrouped`). `resolveHideReadUser(req)` (`src/hide-read.js`): `?hideRead=1|0` overrides the saved switch; anonymous → off; cache keys carry `r:<user>`. Web: eye toggle next to the view toggle (POST /api/preferences, reload) + Profile → view. Android: «Прочитанные книги: Показывать / Скрыть» in `CatalogFilterSheet` (`src/lib/hideReadPreference.ts`, fetchers send it explicitly; series download passes `hideRead=0`)
- «Мои оценки»: `GET/POST/DELETE /api/rating/:id` (also `/api/rating/b64/<ref>`; `{ rating }` 1–5, 0 = none) on table `book_ratings`; list `GET /api/library/rated` (items carry `myRating`, default sort = my rating); additive `ratedCount` in user stats. Web: «Ваша оценка» stars under the book title, `/library/rated` (cover stars = own rating), profile tile. Android: «Ваша оценка» row in `BookDetailsSheet`, «Мои книги → Мои оценки»
- Reading goal / stats: `GET /api/reading-stats` → `{ year, goal, readThisYear, byMonth[12], readByYear, topAuthors, topGenres }`, `POST /api/reading-goal { goal, year? }` (≤0 removes; table `reading_goals`, cleaned by `deleteUser`). Web profile «Цель на год» + months; Android `ReadingGoalCard` in the profile
- Series «до тома N»: `POST /api/series-read-up-to { name, upTo }` → `{ added, progress }` marks one edition of every unread numbered volume ≤ N (`markSeriesReadUpTo`); `/api/series-progress` adds `numbers` (numbered volumes). **No UI any more** (web and Android removed it: a mark could not be lowered); the route and `numbers` stay for older Android builds
- Book / series action order (web book page corner, web series page, Android `BookDetailsSheet` and series screen): «Хочу прочитать → Прочитано → Избранное → На полку». Series page uses the same icon buttons (`renderSeriesIconActions`): `POST /api/want/series { name }` → `{ want, added, removed }` (`toggleSeriesWantToRead`: some volume listed → remove every edition of the series, otherwise add one edition of each unread volume; profile languages apply; hidden for a fully read series), additive `want` in `/api/series-progress`; «Прочитано» = `POST /api/read/batch { facet:'series', value }`; «На полку» = additive `series` in `POST /api/shelves/batch-add-books { shelfIds, series }` (server resolves the series books, cap 2000, not `BATCH_DOWNLOAD_MAX`)
- Reading progress on web pages: `pageShell` embeds `ui-read-progress` (`getInProgressBookMap(user)`: `reading_positions` with 0 < progress < 99, not in `read_books`, newest 1000) and `app.js` `applyReadProgressMarks()` adds the bar to cover cards and «N%» to list rows (card HTML is cached for everyone, so per-user progress is never baked into it outside `/library/continue`). Book page: «Прочитано N%» bar + «Продолжить чтение» button. Series: additive `current: { id, title, seriesNo, progress } | null` in `/api/series-progress` (started unread volume read most recently) → the web series page and the Android series block show one button: «Продолжить» for that volume, otherwise «Читать следующую» only when additive `next.prevRead` (the volume before `next` is read), otherwise none (no «Начать читать»). Series page title / breadcrumb use `series_catalog.display_name` (`getSeriesCatalogDisplayName`), not the lowercase key
- Web only: download button with the preferred format (Profile → view; «Скачать FB2.ZIP ▾»), weekly Telegram digest (Profile → Telegram; `src/services/telegram-digest.js`, Mondays ≥ 10:00 in the bot process, meta `telegram_digest_sent:<user>`), Goodreads / LiveLib CSV import (`POST /api/import/reading { csv }` ≤ 2 MB, `src/services/reading-import.js`: matches title + author surname, → read / want / ratings + unmatched list), hotkeys (`/` search, Esc closes menus, ←/→ pages; pagination links carry `rel=prev|next`)
- `GET /api/library/recommended` — personalized pool + same additive filters (`genre`, `genreMode`, `lang`, `format`, `year`, `minRate`, `hasSeries`)
- «Не рекомендовать» автора (web + Android): table `not_recommended_authors (username, author_name, created_at)` — by resolved `authors.name` (`resolveAuthorName`), not `author_id`, so it survives a reindex; cleaned by `deleteUser`. `setNotRecommendedAuthor(user, name, on?)` (`on` boolean sets, omitted toggles; `null` = unknown author), `isNotRecommendedAuthor`, `getNotRecommendedAuthors` (`src/inpx.js`). API (API auth): `POST /api/recommendations/excluded-authors { name, on? }` → `{ excluded }` (404 `FACET_AUTHOR_NOT_FOUND`), `GET /api/recommendations/excluded-authors` → `{ items: [{ name, displayName }] }`, additive `notRecommendedAuthors` (same items) in `GET /api/favorites`. `buildRecommendationsAsync` drops every book with such an author among **any** of its authors (`authorMatchKey` = `createSortKey(authorSortKey(…))`, so `Фамилия,Имя` and `Фамилия Имя` match; a Latin/Cyrillic alias is a different author) and never uses the author as a signal; a change invalidates that user's recommendation cache. Web: «Не рекомендовать» / «Не рекомендуется» button next to «В избранное» on the author page and its outside-series page (`renderNotRecommendAuthorButton`, `data-not-recommend-author`, `attachNotRecommendAuthorActions` in `app.js`); Android: 👎 next to the heart in the author header (reader AGENTS.md)
- `GET /api/facet-books` — books by facet (`authors`/`series`/`genres`/`languages`); additive filters: `genre` (CSV/repeated, OR), `format`, `year`, `minRate`, `hasSeries` (1/0), `lang`
- 3D book covers (web only): catalog cards, home carousel and book page turn on mouse hover (the home quote cover / author portraits stay flat; hero / book page only while the pointer is over the cover itself: stable `.book-3d` wrapper catches hover, inner `.book-3d-body` turns) (flat at rest; off for touch / `prefers-reduced-motion`). At rest a cover is plain 2D — no `preserve-3d`, no `translateZ`, the page edge / back plate pseudo-elements are `display: none` — because a page of covers each holding a 3D context was hundreds of GPU layers and made every page sluggish on weaker GPUs or without hardware acceleration; only the hovered book switches to 3D, and it stays 3D until it has turned back (`transform-style` / `display` / the children's `translateZ` change after the 0.6 s turn via `transition-behavior: allow-discrete` + delay, the back plate fades in with `@starting-style`). Admin → Appearance → Effects → «3D-обложки книг» (`ui_book_3d`, default on) sets `data-ui-book3d="0"` on `<html>`, every rule in the «3D book covers» block of `public/styles.css` is gated by `html:not([data-ui-book3d="0"])`. Not part of `/api/settings/ui` (Android reader doesn't use it)
- Home quote cover = the quote author's "book": author name + link to their books, portrait from `GET /api/authors/portrait?name=` when present (blurs out with the quote on rotation). The endpoint falls back to word-order-independent `listAuthors` matching when the exact name misses («Александр Пушкин» → «Пушкин Александр Сергеевич»)
- Web home, catalog, search, novinki and recommendations support covers or `?view=list` (Flibusta-style rows). Home shelves («Новинки», recommendations, pinned shelves) share one batch-select scope. The home toggle is `/?view=list|grid` for guests; signed-in users `POST /profile/home-view` (`view=list|grid`, CSRF), which saves `users.ui_home_view` and keeps the catalog preference. The catalog toggle does the same for `users.ui_catalog_view` via `POST /profile/catalog-view` (`view`, CSRF, `next` back to the current `/catalog` filters without `view`) and leaves the home preference unchanged
- `GET /api/browse/authors/:value/grouped` — author series + `standaloneBooks` + `books[]` per series (Flibusta-style list); `lean=1` omits `books[]` (name/displayName/bookCount only); additive `authorSeries` per series (`true` = every book of the series has this author; `false` = multi-author/publisher series — web shows those last under «Межавторские и издательские серии», after «Книги вне серий»); `resolveAuthorName` picks the `authors` alias with the same `search_name` and higher `book_count` (INPX Latin vs Cyrillic duplicate)
- Book search: SQLite FTS5, stem expand, title boost (exact/ordered/prefix), author+title split, phrase OR, stopword-aware AND, catalog-layer typo retry on miss, page-level edition dedupe (same title, author, series, year, and format only), LIKE fallback when dirty/desynced or for `*contains`. The LIKE fallback (`searchBooks`, `listSearchGenres`) never runs one statement over every book: `collectLikeFallbackBookIds` takes candidates from FTS word prefixes (`*` with a healthy index), the author index and a rowid-chunked scan of `books` that stops after `SEARCH_LIKE_SCAN_BUDGET_MS` (default 300, `0` = no scan) or 10 001 ids; the page / COUNT then re-check LIKE + filters on those ids only. A cut-short scan adds `partial: true` to the result (mid-word hits may be missing; word-prefix hits are complete). The Android app used to retry every zero-hit search as `*q` — «*Tolkien» on 684k books stalled the loop 21 s; it no longer does, older APKs hit the bounded path. Dirty/desync auto-rebuild; post-index FTS warmup. Admin/ops: additive `ftsStatus`, `POST /api/operations/fts-rebuild`. Multi-word author and series counts use `author_name_tokens` / `series_name_tokens` (author words exact, series words by prefix) after meta `catalog_name_tokens_ready`; until the background backfill finishes, search keeps the LIKE scan
- Details: `docs/architecture/search.md`
- `POST /api/auth/pairing` — authenticated; creates a one-time 10-minute QR pairing code (`payload` JSON + `svg`) for Android app sign-in; does not include the password
- `POST /api/auth/pairing/redeem` — public + rate-limited; exchanges pairing `code` for a device Bearer token (`deviceToken`, `deviceTokenId`, `username`, `serverUrl`)

- `POST /api/send-to-telegram/:id` (also `/api/send-to-telegram/b64/<ref>`) — web «В Telegram» button: sends the same book card the bot shows in search (cover + annotation + one `dl:` button per available format, 3 per row; the file arrives on button press) to the Telegram account linked in the profile. Errors (`code`): `TELEGRAM_DISABLED` 400, `TELEGRAM_DENIED` 403, `TELEGRAM_NOT_LINKED` 400 (+`linkUrl`), `TELEGRAM_SEND_FAILED` 500, `SEND_IN_PROGRESS` 429. `dl:` keys live in the bot process memory, so with `CLUSTER_WORKERS>1` the card must be sent from the worker that polls the bot. Not used by the Android reader. `POST /api/send-to-telegram/batch` `{ ids[] }` (max `TELEGRAM_BATCH_MAX` = 20) sends one card per book sequentially → `{ ok, message, requested, sent, skipped, partial }`, same error codes. Web list rows, cover cards (replaces «Подробнее»; anonymous users keep «Подробнее») and the selection toolbar show one «Отправить» menu (email + Telegram) like the book page; a single available target stays a plain button. Catalog / library pages allow multi-select in both cover and list view
- Download format `fb2zip` (label `FB2.ZIP`, file `*.fb2.zip`, `application/zip`): the delivered FB2 (WebP mode, sidecar images applied) zipped as a single entry in memory (`resolveDownload`); offered for every FB2 book without fb2cng, admin can disable it like other formats. Additive entry in `downloadFormats`; OPDS links unchanged. The web e-mail dialog remembers the last format in `localStorage['ereader-format']`
- Folder sources: additive `sources.fastScan` (0/1, `POST /admin/sources/add` `fast_scan`, folder type only) — indexer takes author/title from the file name (or an OPF next to the book, see «Folder sidecar metadata») and never unpacks archives (no genres/series/lang, no cover warm-up). Applies to files indexed afterwards; re-run a full reindex to re-read old ones. `POST /api/sources/probe` lists `.inpx` up to 2 levels deep (`_local.inpx` first); `findInpxFiles()` in `src/inpx.js`
- Calibre libraries (`sources.type = 'calibre'`, plan `docs/decisions/004-calibre-library-source.md`, phase 1): `src/calibre.js` (snapshot, field mapping, book details) + `src/calibre-indexer.js` (`indexCalibre`, dispatched next to `indexFolder` in `src/inpx.js`); book rows are written through the shared `src/index-book-writer.js` (also used by `indexFolder`). The live `metadata.db` is only ever `copyFile`d to `data/calibre/<sourceId>-<mtime>-….db` (mtime/size re-checked after the copy, retried while a `metadata.db-journal` exists); indexing and book details read that snapshot — tables only, never Calibre's views (they call Calibre SQL functions). Meta `calibre_snapshot_<id>` = current snapshot file (each process reopens its read-only connection when it changes; old files are removed on the next commit), `calibre_db_fp_<id>` = `mtimeMs:size` of the copied `metadata.db`: unchanged + incremental → the source is skipped; a skipped pass, or a re-read that found no changed / removed book, returns `unchanged: true` and `startSourceIndexing` then skips the catalog recount, recommendation reset, collections re-match and post-index ANALYZE (`indexState.lastRunUnchanged`; `onIndexComplete` listeners still run and get `unchanged`, so the folder watcher's dirty queue keeps working). One `books` row per Calibre book: id = `sha256("<sourceId>:calibre:<uuid>")`[0:32], `lib_id` = `calibre:<uuid>`, `file_name` = `<books.path>/<data.name>` (loose file, `archive_name` ''), `ext` = first of `CALIBRE_PRIMARY_FORMATS` epub > azw3 > mobi > fb2 (books with only other formats are not indexed yet — phase 3), authors in INPX form from `authors.sort` («Asimov, Isaac» → `Asimov,Isaac`), `lang` ISO 639-2/3 → 639-1, `date` = date added (`books.timestamp`), `lib_rate` = rating / 2, publisher in `keywords`. Tags per source `sources.calibre_tags` (`genres` default | `keywords` | `ignore`; `POST /admin/sources/add` `calibre_tags`, `POST /admin/sources/:id/update` `calibre_tags` — a change clears `calibre_book_state` + the fingerprint so the next pass re-reads every book). Table `calibre_book_state (source_id, calibre_id, book_id, uuid, last_modified, formats)`: an incremental pass re-reads books whose `last_modified` or format list (`EPUB:size,…`) changed; books gone from Calibre are stashed like vanished folder files (`stashMovedFolderBookRef`, 30-day delayed purge, `reattachMovedFolderUserData`). `reattachDetachedUserData` also matches refs whose `lib_id` starts with `calibre:` on `lib_id` alone (path / format change in Calibre between a source delete and its re-add). Guards: missing `metadata.db` or an empty library while the source has books → abort, nothing touched; ≤ 50 primary files are sampled after a pass (`warn` + index diary when none exist). Book details (`getOrExtractBookDetails` / `getBookPublishInfo`): annotation = `comments` (HTML), year = `pubdate` (`0101-…` = none), ISBN = `identifiers` type `isbn`, cover = `<path>/cover.jpg` when `has_cover` — from the snapshot, cached in `book_details_cache`; the book file is never opened for them. `POST /api/sources/probe` adds `isCalibre` / `calibreBooks`; the web form shows the tag mode once the path is a Calibre library and adds it as `type: 'calibre'`. Folder watching watches only `metadata.db` / `metadata.db-journal` of a Calibre source (non-recursive `fs.watch`); on top of that the minute reconcile compares the `metadata.db` mtime + size with `calibre_db_fp_<id>` (async `stat`, `pollCalibreDb` in `folder-watcher.js`) and queues the quiet-period pass when the file changed since the last poll — SMB/NFS shares (where `fs.watch` fails with «unknown error, watch» or stays silent) and edits made while the server was down are picked up too; admin status `polling` when only the poll works. `POST /api/books/resolve` accepts `libId: 'calibre:<uuid>'`. Android needs nothing for phase 1 (Calibre books are ordinary EPUB/AZW3/MOBI/FB2 catalog books)
- Calibre phase 2 — all formats of a book: table `book_files (book_id, ext, file_name, size)` (WITHOUT ROWID, PK book_id + ext) holds every format of a Calibre book except the primary one (`calibreExtraFiles`, rewritten for each re-read book, cleaned with the book, a full pass and the source; ext `[a-z0-9]{1,10}`, any format — PDF too). `getBookNativeDownloadFormats` (`src/download-formats.js`) = primary formats + stored extra exts (`getBookExtraFiles`; the per-row lookup is skipped while `book_files` is empty, memo 30 s, `resetBookFilesProbe()` after an index pass), so `downloadFormats` on every book payload, the web download / send menus and `/download/:id?format=<ext>` (also batch ZIP, e-mail, Telegram) list them; `resolveDownload` serves a stored extra file as is (`getBookExtraFile`, MIME in `conversion.js`) before any fb2cng conversion — `format=fb2` on an EPUB book is the stored FB2, not the EPUB. OPDS v1 / v2 add one acquisition link per extra format (`getBookExtraAcquisitions`: `…&format=<ext>`, MIME per format, disabled formats left out). An extra EPUB never happens (EPUB is always the primary), so the Android download-format logic (EPUB family only, FB2 sources only) is unchanged. «Перевести в Calibre» (Admin → Sources, shown for a folder source whose path has `metadata.db`): `POST /admin/sources/:id/convert-calibre` → `convertFolderSourceToCalibre` (type `calibre`, `fast_scan` 0, drops `folder_index_<id>`, sets meta `calibre_convert_<id>`) + `startSourceIndexing(id, true)`; while the marker is set every Calibre pass of the source is full: the stashed refs of the folder books (`detached_book_refs`, loose files only) are mapped onto the Calibre books by `file_name` + `ext` (case-insensitive; primary file first, then `book_files`) and moved with `moveUserDataToBooks` (`src/db.js`); a conflict (two formats with a reading position) keeps the primary format's row. Unmatched refs stay detached (`source_id` NULL — never purged). The marker is cleared after a successful pass
- Calibre phase 3 / document formats — PDF, DJVU, CBZ, CBR, TXT, RTF, DOCX (`DOCUMENT_FORMATS` in `src/utils/book-format.js`): `CALIBRE_PRIMARY_FORMATS` = epub > azw3 > mobi > fb2 > pdf > djvu > cbz > cbr > txt > rtf > docx (only other formats such as LIT are skipped). Folder sources index them as **loose files only** (`LOOSE_ONLY_EXTENSIONS` in `folder-indexer.js`; entries inside zip/7z containers keep the old fb2/epub/mobi/azw3 list — readme.txt in archives), metadata from the file name, plus an OPF next to the book, ComicInfo.xml of a CBZ and the head / tail of a PDF (see «Folder sidecar metadata»); the watcher's `BOOK_EXTENSIONS` has them too (and `.opf`). `getOrExtractBookDetails` never reads a whole document-format file for annotation / cover (`isDocumentFormat`; a cover next to a loose file still counts; folder PDF / CBZ get theirs from `readFolderBookSidecarDetails` — PDF head / tail, ComicInfo + first page of a CBZ, OPF). `/api/books/:id/content` sends `application/pdf` (also djvu / cbz / txt types) — the web reader shows PDF in the browser's own viewer (iframe), octet-stream would download it. OPDS v1 / v2 and `conversion.js` know their MIME types; a real RAR CBR is never unpacked (the bundled 7za cannot), but a CBR that is a ZIP inside (first bytes `PK`, `isZipComicFile`) is read like a CBZ for ComicInfo.xml and the first-page cover. Web «Читать» (book page, Flibusta-style rows, lite) only when `canOpenInWebReader(ext)`: Foliate formats (FB2, EPUB, MOBI/AZW3, CBZ) and PDF; DJVU, CBR, TXT, RTF, DOCX are download / send only (the reader page itself still shows its «download» banner for them). `public/reader.js` `sniffBookExt` keeps `cbz` (it was opened as EPUB and failed). Send to e-reader: a Kindle address (`@kindle.com`, `@free.kindle.com`, `@kindle.cn`, `isKindleEmailAddress`) only gets EPUB (epub2/epub3/kepub), PDF, DOC/DOCX, TXT, RTF, HTML — otherwise `400 EREADER_FORMAT_UNSUPPORTED` (single book) or the book is skipped (batch; all skipped → the same code); other addresses are unchanged. Android: its reader opens PDF / CBZ / TXT; DJVU, CBR, RTF, DOCX open via «Открыть в другом приложении» (reader AGENTS.md)
- Folder sidecar metadata (`src/folder-sidecar-meta.js`, loose files of **folder** sources only, never entries inside zip/7z): **OPF next to the book** — `<book name>.opf` (on the details path found by `stat` of `<name>.opf` / `.OPF`, then `metadata.opf`; the folder is listed only when `metadata.opf` exists — a flat 30k-file folder must not be listed per cover), or `metadata.opf` when the folder holds one book (one name in several formats, like a Calibre «save to disk» / Readarr / Kavita folder; a folder of different books ignores it, `pickSidecarOpfName`); found from the scan's own `readdir` (no extra stat per book). `parseSidecarOpf`: Calibre + EPUB 3 (`refines`, `belongs-to-collection` / `group-position`), authors only role `aut` (or none) in INPX form from `file-as` (`calibreAuthorToInpx`), `calibre:series[_index]`, `date` = `calibre:timestamp` else `dc:date`, `eng` → `en`, publisher → keywords; annotation (`dc:description`, HTML) / year / ISBN go to book details. **ComicInfo.xml** inside a CBZ — or a `.cbr` that is a ZIP by its first 4 bytes (`isZipComicFile`; a real RAR gets file-name metadata only, no cover) (central directory + one entry): `Writer` (else `Penciller`/`Artist`) split on commas into separate authors, title = `Title` else «Series #N», `Series` + `Number`/`Volume`, `Summary`, `Year`/`Month`, `Genre`, `LanguageISO`; the CBZ cover = an image named «cover», else the first image by natural name order (a `cover.jpg` next to the file wins). **PDF**: only the first and last 256 KB are read — XMP packet, else the `/Info` dict (literal / UTF-16 hex strings, octal escapes, raw cp1251 bytes of Russian PDFs detected when most letters fall in U+00C0–U+00FF; through a classic `xref` table when the object is elsewhere; Info inside a compressed object stream is not read); junk titles («Microsoft Word - …», «Untitled», file name, paths) are dropped (`cleanPdfTitle`). Priority in `extractMetadata` (`mergeBookMetadata`, first non-empty field, series + number as a pair): ComicInfo → OPF → the book's own metadata (FB2 / EPUB / MOBI) → PDF → file name (the file-name layer is used when nothing gave a title, and always for document formats so «Автор - Название.pdf» keeps its author). Fast scan still reads an OPF (never opens the book). Incremental pass: a book with an OPF stores `opf: "<mtimeMs>:<size>"` in its `folder_index_<id>` fingerprint (books without one keep `{ mtimeMs, size }`, so an upgrade does not re-read the library), so editing only the OPF re-reads that book; a re-read existing book drops its `book_details_cache` row and cover thumbs. The watcher reacts to `.opf` too. Book details (`getOrExtractBookDetails`, `getBookPublishInfo` for non-FB2) read the same sidecars (`readFolderBookSidecarDetails`); one-time boot pass (meta `folder_sidecar_details_v1`) drops cached details of loose folder PDF / CBZ (cached before without annotation / cover); `folder_sidecar_details_v2` does the same for CBR. Books already in the catalog keep their file-name title / author / series until a full reindex of the source (user data is kept). **«Серия = папка»** (`sources.folder_series`, folder sources only; Admin → Sources: checkbox in the add form `folder_series`, per-source form `POST /admin/sources/:id/update` `folder_series_form=1` + `folder_series`): for the Komga / Kavita layout `Серия/Серия 001.cbz` — series = the folder holding the file, number from the file name (`volumeNumberFromName`: `#12`, `v01`, `Vol. 3`, `Том 2`, else the last number that is not a year), title = file name, no author from the path; any series from ComicInfo / OPF / the book wins. A change clears `folder_index_<id>`, so the next pass re-reads every file (ids are path hashes, user data stays). Server / indexer only: Android needs nothing — these are ordinary catalog books (series, authors, covers through the existing payloads and `/cover-thumb`); the toggle is admin-only
- KOSync (KOReader progress sync, `src/kosync.js`, `src/routes/kosync.js`): custom server URL `http://host/kosync`; `GET /kosync/users/auth`, `PUT /kosync/syncs/progress`, `GET /kosync/syncs/progress/:document` (no progress → `200 {}`); `POST /kosync/users/create` → 403. Auth headers `x-auth-user` / `x-auth-key` (= md5 of a **dedicated generated KOReader password**, created in Profile → settings via `POST /profile/kosync-password`, revoked via `/profile/kosync-password/revoke`; DB stores `sha256(md5)` in `kosync_keys`, never the account password). KOReader's partial-MD5 document id is mapped to a book at `/download/:id` time (`kosync_documents`), so a book must be downloaded through the server once for its KOReader progress to show up. Progress lives in `kosync_progress`. The position is bridged both ways (`src/kosync-position.js` + `src/services/kosync-position-bridge.js`): `kosync_documents.format` (additive, from the delivered file name: `fb2` / `fb2zip` / `epub` …, '' for rows remembered earlier — then only an xpointer starting with `/FictionBook` counts as FB2) says whether xpointers follow the book's FB2 tree. `scanFb2Body` rebuilds the reader's section-0 text from the first `<body>` exactly like Foliate `fb2.js` (kept / dropped elements, stanza `v` lines glued at the stanza end, whitespace collapsed; checked char-for-char against Foliate on real books — keep it in step when `public/foliate/fb2.js` changes), the file is decoded by its declared encoding like Foliate (`decodeFb2LikeReader`, not `readBookXml`). PUT (after the response, `setImmediate`; skipped when `progress` equals the stored one): FB2 xpointer → v4 anchor `{ sectionIndex: 0, textOffset, textQuote (96 chars), textSectionLength, fraction }` (`fb2XPointerToAnchor`; V1 and V2 forms, boxing nodes skipped; notes body / unresolvable → percentage only); other reflowable formats (fb2 / epub / mobi / azw3 book) → fraction only; written by `setReadingPositionCas` (FB2 anchors with `fb2Href` `'0'`, so `positionForBookFormat` drops them for the app's converted EPUB) as session `kosync:<device_id>` and released at once (`releaseReadingPositionSession`), never over an *active* reader session (`busy`), skipped when the reader position already lies in that paragraph (KOReader echoing what it was sent). GET: when `reading_positions.updated_at` is newer than the KOReader record and the holder is not `kosync:*`, FB2 documents get `{ progress: <block xpointer with explicit [n] indexes, e.g. /FictionBook[1]/body[1]/section[2]/p[5]>, percentage, device: 'INPX Library', device_id: 'inpx-library-server', timestamp }` (`fb2AnchorToXPointer`: text offset re-found by the quote ±2000 like the reader, else fraction); waits ≤ 5 s for the book file, else the stored record. `saveKosyncProgress` keeps `updated_at` when `progress` is unchanged (KOReader re-sends it on sleep / close; a fresh time would hide a newer web position). The first body of up to 4 books is cached 10 min. The percentage is also used directly: a push for a mapped book puts it into «Читаю» (`recordKosyncReading`: `reading_history` row, `last_opened_at` moved at most every 5 min, `open_count` not bumped, `reading_history_rev` touched, leaves «Хочу прочитать»), ≥ 99% marks it read (a lower percentage never unmarks), and `readProgress` of `getReadingHistory` / `/api/library/continue` plus `getInProgressBookMap` take max(own reader, KOReader) (`getKosyncPercentMap`). Web and Android get it through those routes (no new API). Tables are cleaned in `deleteUser`
- OPDS progress icons (`src/opds-progress.js`): OPDS v1 acquisition titles of started books get a prefix ◔ (≤25%) ◑ (≤50%) ◕ (>50%) ⬤ (read or ≥99%); sources `reading_positions`, `read_books`, KOSync percentage (max wins). Unstarted books are untouched, no opt-out toggle, OPDS v2 JSON unchanged
- Smart shelves (`src/smart-shelves.js`, `src/routes/smart-shelves.js`, table `smart_shelves`): a saved catalog filter (whitelisted `q`, `genre`, `genreMode`, `lang`, `format`, `year`, `minRate`, `hasSeries`, `sort`, `order`), books are searched live via `searchCatalog`. `GET/POST /api/smart-shelves`, `PUT/DELETE /api/smart-shelves/:id`, `GET /api/smart-shelves/:id/books?page=` (optional `pageSize` ≤ 24, default 24 — the Android app asks for whole cover rows) → `{items,total,page,pageSize}`; shelf object `{id,name,query,catalogUrl,createdAt}`. Web: «Сохранить как умную полку» in the catalog filter panel, rows of the one `/shelves` list; Android: the same button at the bottom of the catalog filter sheet (books search: text + sheet filters + current sort → `POST /api/smart-shelves`, name defaults to the search text); OPDS `/opds/user/smart-shelves[/:id]`. Page 1 of a shelf (preview and pinned home shelves) is cached 5 min per query + size + languages and dropped with the runtime catalog caches (`getSmartShelfFirstPage`, `getRuntimeQueryCacheGeneration`) — Android polls the shelf list every 8 s. Web `/shelves` rows show cover thumbs + book count for smart shelves like regular ones (`listSmartShelves(user, {withPreview:true})`: `bookCount`, `previewBookIds`; opt-in via `GET /api/smart-shelves?preview=1`, plain list and OPDS stay cheap). Android «Мои книги» lists them as «Умные полки» and deletes with `DELETE /api/smart-shelves/:id`. Pin to home: additive `onHome` (0/1; column `on_home` on `shelves` and `smart_shelves`) toggled by web forms `POST /shelves/:id/home` and `POST /shelves/smart/:id/home` (`on=1|0`); the authenticated home renders pinned non-empty shelves (max 8, below «Новинки» and recommendations; anonymous home unaffected). Same list for clients: `GET /api/home/shelves` (API auth) → `{ items: [{ id, kind: 'shelf'|'smart', title, href, items: Book[] }] }` from `getPinnedHomeShelves` (per-shelf limit = home newest display count, smart shelves narrowed by profile content languages). The Android reader shows these shelves on its Home after «Рекомендации», «Все» loads the full shelf via `GET /api/shelves/:id/books` / `GET /api/smart-shelves/:id/books?page=`. Pinning from clients: `POST /api/shelves/:id/home` and `POST /api/smart-shelves/:id/home` `{ on }` → `{ ok, onHome }` (404 for someone else's shelf); `onHome` is already in `GET /api/shelves` / `GET /api/smart-shelves`. Android: home icon on every server shelf in «Мои книги» (collection rows and shelf cards) and «Убрать с главной» on a pinned shelf header on Home
- Folder watching (`src/services/folder-watcher.js`, thread `folder-watch-worker.js`): enabled **folder** sources are watched with recursive `fs.watch` in a `worker_threads` worker (Linux walks the whole tree synchronously at start — never in the main thread). Book/archive events (`fb2|epub|mobi|azw3|zip|7z`, directories) → after quiet period (default 120 s) `startSourceIndexing(id, false)`; busy indexer → source is marked dirty (no timer retries) and re-triggered only after a **successful** index completion (`onIndexComplete`), so a Stop never restarts itself. Folder incremental import mode compares changes to the whole library (`MAX(rowid)` of `books`), not to the source's file count, so a few dozen new books never trigger the full FTS/index rebuild. Only sources with a finished first index (`lastIndexedAt`) are triggered. Watcher errors (e.g. inotify limit) retry after 5/10 min, 3 failures → watching off for that source until restart (interval scans stay the fallback; SMB/NFS often emit no events). Sources and settings are reconciled every minute (add/update source and the settings form also reconcile immediately in the process that serves them); in a cluster only worker 1 watches. **Web admin is the control surface** (Admin → Sources: toggle `folder_watch_enabled`, quiet period `folder_watch_quiet_sec`, per-source status from meta `folder_watch_status`; env `FOLDER_WATCH` / `FOLDER_WATCH_QUIET_SEC` are only the defaults). No public API; the Android reader does not use it
- Android account switching (app-only; the web keeps its normal login): Profile → «Сменить» lists saved accounts (non-secret list in localStorage, device tokens per account in the Keystore via `SecureCredentials.saveAccount`). Downloaded books are shared; positions, bookmarks, notes, shelves, favorites, sync queue and reader data belong to one account: the live set sits in the regular tables, other accounts' sets are IndexedDB snapshots swapped on switch (then reload). `inpx_personal_owner` names the owner; the sync queue and background sync never push it under another account, and «Выйти» → login as somebody else swaps first. No server API
- Android home / lock-screen widgets (current book, read-aloud remote with sleep timer, «Новое у любимых» covers) are app-only: they use existing routes (`/api/library/following`, `siteName` / `logoUrl` / `showLogo` from `/api/settings/ui` for the library name and logo at the top of each widget) and the app's cover cache, no server API. Lock-screen placement works only where Android allows it (`widgetCategory` `keyguard`: tablet hub, Android 15–16). Details in the reader's `AGENTS.md` («Виджеты»)
- Android interface languages (app-only): the reader app is in Russian and English (Profile → Внешний вид → Язык, «Авто» = phone language: Russian for ru/uk/be/kk, English otherwise). Every app request sends `Accept-Language` = the app language (not the phone's), so server messages follow it — keep user-facing API errors localized through `t()`. Shared `public/position-sync.js` → `formatPositionDetail` words («стр. N из M», «раздел», «глава») follow `document.documentElement.lang` (`en` → «p. N of M», «section», «chapter»), used by the web and the app cross-device dialogs. No new API
- English genre names (web + Android): `genres_catalog.display_name`, `genres_search` and `formatGenreLabel` stay Russian (index, search, OPDS). English names live in `src/genre-labels-en.js` (`GENRE_LABELS_EN` for every code of `GENRE_LABELS` — the FB2 2.1 list + freeLib aliases, `GENRE_GROUP_LABELS_EN` for the `GENRE_GROUPS` keys; a new code in `GENRE_LABELS` needs an English name, `test/genre-labels-en.test.js` checks it); unknown codes keep the stored name / code. Web pages (`/genres`, `/lite/genres`, genre facet title, book page, catalog filter + chips, author genre chips, profile stats, admin genre exclusions) use `localizeGenreLabel` (request locale; `formatGenreLabel` re-exported from `src/templates/shared.js` is that one, OPDS templates import the Russian one from `genre-map.js`). English `/genres` sorts / filters by letter the whole small list in JS (`listGenresForLocale`, cache keys carry the locale). API is additive, not by `Accept-Language` (old Android builds and cached lists keep the Russian `displayName`): `displayNameEn` on genre rows (`/api/browse/genres` items and group items, `/api/search/genres`, `listGenres*`, `listGenresForBookIds`, `/api/reading-stats` `topGenres` + additive `displayName`), `groupNameEn` on `/api/browse/genres` groups, `genresDisplayListEn` next to `genresDisplayList` on book payloads (catalog lists, `/api/books/:id/meta`). Web `app.js` (lazy catalog genre list) picks `displayNameEn` when `<html lang="en">`; Android: `localizeGenreRows` / `bookGenreLabels` in `inpxClient.ts`. `genres_catalog.search_name` also holds the English name, so `/genres?q=romance` finds genres (existing DBs: one-time startup pass `refreshGenreSearchNames`, meta `genre_search_en_v1`)
- Product priority: web UI and Android reader are **equal clients** — a user-facing feature is done only when it works in both (see «Feature parity» above). Admin and server-maintenance features stay web-only
- Index safety: `indexFolder` aborts (throws, DB untouched) when the scan finds **zero** files but the source already has books — an unmounted volume looks like an empty folder and would otherwise purge books and cascade user data; delete the source if the files are gone on purpose. After an INPX import `checkInpxArchivesOnDisk()` (`src/inpx.js`) samples ≤50 archives (zip/7z, same lookup as downloads): none found → `warn` system event + index diary line («проверьте путь и монтирование»), some missing → `info` (partial collections are normal)

### OIDC / SSO (web login)

Optional OpenID Connect login (Authentik-compatible): Authorization Code + PKCE, JIT user provisioning, optional admin claim. Configure in **Admin → Users → OIDC / SSO** (`oidc_enabled` off by default). Routes: `GET /auth/oidc/start`, `GET /auth/oidc/callback`. Session cookie contract unchanged. OIDC users get `has_local_password=0` until they set a password in profile (needed for OPDS/Basic). Existing local accounts with the same email are **not** auto-linked.

### Reading position contract (Foliate glue)

Shared logic lives in `public/position-sync.js` (copied to Android `public/inpx-reader/position-sync.js` at build).

| Field | Rule |
|-------|------|
| `textOffset` / `textQuote` / `textSectionLength` | Primary exact v4 text anchor inside `sectionIndex`; independent of viewport, font, and pagination |
| `fraction` | Book-wide display coordinate and restore fallback, **not** an exact text anchor and not TOC-derived %; the only coordinate kept across formats (`positionForBookFormat`: EPUB converted from FB2 in the app) |
| `progress` | Display/sync percent derived from `fraction` (0.0001% precision) |
| `fb2Href` | Coarse FB2 fallback (`section` or `section#block`); it never overrides a differing precise `fraction` |
| `position` | EPUB CFI / paginator token; empty for FB2 when `fb2Href` is set |
| `positionVersion` | Coordinate contract version; rows below v4 migrate lazily: FB2/FBZ coordinates and anchors reset, while EPUB keeps only its CFI |
| `revision` / `baseRevision` | Server CAS token; only a write based on the current revision is accepted |
| `sessionId` | Per-open-reader UUID; a different holder with differing coordinates always shows a dialog (including when the holder omitted `sessionId`) |
| `lastUserActivityAt` / idle 4 min | Open readers stop POSTing after 4 minutes without page/snap/scroll/navigation; another session may idle-steal or take over with the current revision only while the holder is idle; a closing reader releases its hold (`/position/release`), which makes it idle at once |

Read aloud (TTS) — one controller for both readers: `public/reader-shared/reader-tts.js` (`createReaderTts(host)`, synced to Android by `npm run sync:shared`). It renders the player dock (`#reader-tts-dock`: chapter title, locate, settings, stop; previous / next paragraph and sentence; speed − / presets / +; sleep timer 15–90 min or end of chapter), the settings block into `#rs-tts-mount` (voice «Авто» = book language + preview, speed 0.5–3, pitch 0.5–2, highlight off / sentence / sentence + word, colour, fill / underline, turn pages with the voice, skip footnote markers `[12]` `{3}` `*`, pauses between paragraphs) and «Читать отсюда» in the selection menu. Settings are `tts*` fields of `reader-settings` (`TTS_SETTING_DEFAULTS`, `normalizeTtsSettings`). Highlight replaces Foliate's `view.tts.highlight` and draws on the overlayer (keys `reader-tts-sentence` / `reader-tts-word`); the word comes from `boundary` events (browser local voices; Android `onRangeStart` → bridge). SSML `<mark name=N>` starts sentence N — the old parser paired it with the previous text and the highlight ran one sentence ahead. Sentences queue ahead: blocks (paragraphs) are cached by offset from the start block while Foliate's iterator is walked to them (`fetchBlock`), `pos` = `{ b, i }` is the sentence being spoken, and the engine always holds the current utterance plus the next one (SpeechSynthesis queue semantics, also across paragraphs unless a paragraph pause is set), so the next sentence starts without a JS round trip; `onstart` of an utterance moves the highlight. Pause = cancel + repeat the sentence on the web, the native pause on Android (`host.nativePause`, keeps the notification); speed / voice / pitch changes restart the current sentence. A section end goes on with `renderer.nextSection()` (not `goRight`, which could re-read the chapter). The host (reader.js) keeps wake lock, keep-alive audio, Media Session (web adds `seekbackward` / `seekforward` = paragraph) and gets `onStateChange({ active, paused })`. Web hotkeys: `V` play/pause (Shift+V stop), `[` `]` sentence, `{` `}` paragraph. Foliate `paginator.js`: attaching the overlayer re-runs `expand()` (it was attached after load and kept `left:0`, so highlights could land one page to the left). Sleep timer «продлевать, пока телефон в руках» (`ttsSleepMotion`, default on): while a minutes timer runs, movement (`createMotionDetector`: gravity vector vs its time-based slow average, above `threshold` m/s² for `spanMs`; `ttsSleepMotionLevel` = `TTS_MOTION_LEVELS` high 0.3 / 0 ms, medium 0.8 / 700 ms (default), low 1.5 / 1500 ms — a single jolt of the bed next to the phone must not count) or any pointer/key event in the reader or a section doc restarts the countdown; the last minute fades the voice (`sleepFadeVolume`, utterance `volume` 1 → 0.25) and a movement then restores it at once. Motion source: `host.watchMotion(onMove, level)` → stop fn (Android: native accelerometer `setMotionWatch`, works with the screen off), else `devicemotion` while the page is visible; it runs only while TTS is active with a minutes timer. For the Android read-aloud widget the controller also has `cycleSleep()` (one button: off → 15 → 30 → 60 min → off) and calls `host.onSleepChange(endsAt)` (epoch ms, 0 = off or «до конца главы») when the timer is set or re-armed; the web reader does not pass it. No server API.

Reader menu and settings (web + Android, AlReader-style; no server API): the toolbar is only ←, title + chapter, % and bookmark. A tap in the middle shows the tile menu above the footer (`#reader-quick`: Оглавление, Закладки, Заметки, Поиск, Озвучка, День/ночь, Весь экран, Настройки — the tiles keep the old toolbar ids `btn-toc` / `btn-search` / `btn-tts` / `btn-day-night` / `btn-fullscreen` / `btn-settings`; `data-quick-tab` opens bookmarks / notes; below them A− / size / A+ `rq-font-*` and theme dots). With «Закрепить панели» the bars stay and the tap toggles only the tiles (`body.quick-open`). Settings are a sheet of their own (no «Настройки» tab in the navigation panel): a list of sections with their current values (`#rs-root`, `data-rs-open`, `data-rs-summary`) → one section page (`.rs-page[data-rs-page]`, `#panel-back`, its own history entry, so Back / Esc return to the list). Web sections: Текст, Цвета и тема, Страница, Управление, Озвучка, Экран E-Ink; the app has its own option set in the same structure. Every slider gets − / + (`enhanceRangeSteppers`). «Режим E-Ink» (`reader-settings.einkMode` `auto|on|off`; auto = `/lite` or an e-reader browser by `READER_EINK_UA_RE`, applied by the boot script before the first paint) sets `html[data-eink="1"]`: no animation / transparency, sliders hidden (only − / +, 44 px), bordered tiles, chrome and panels appear without sliding. Icons, tile / row helpers and the UA regex live in `src/templates/reader-chrome.js` — **no imports**: the Android `scripts/generate-reader-html.mjs` evaluates `renderReader` with stubs + `locale-bundles.js` **ru and en** (the app writes `index.html` and `index.en.html` for its two interface languages), so every `t()` key the reader template uses must exist in both bundles (the generator fails otherwise). Keep the CSS block «TOOLBAR (slim)» … «E-Ink» in `public/reader.css` in step with its copy at the end of the app's `reader.css`.

Web static assets (`public/sw.js`): the Service Worker is **network-first** for `STATIC_ASSETS` (`fetch` with `cache: 'no-cache'`, install uses `cache: 'reload'`); the SW cache is only an offline fallback. A cache-first SW combined with `immutable` headers served a stale `position-sync.js` next to a new `reader.js` and the web reader hung on «Загрузка книги…» (`SyntaxError: does not provide an export`). `node scripts/build-assets.js` bumps `CACHE_NAME`. URLs whose `?v=` equals `STATIC_ASSET_VERSION` (content hash in `src/templates/shared.js` — every file linked with it must be in `computeStaticAssetVersion`) are served `public, max-age=31536000, immutable`, and the SW lets the HTTP cache answer any `?v=` URL; files without `?v=` (foliate modules, `position-sync.js`, `reader-shared/*`) stay `no-cache`. JS/CSS are precompressed once in memory (brotli q11 + gzip 9, `src/services/static-precompress.js`, keyed by mtime/size; the first request falls through to on-the-fly compression). The client dictionary is `/i18n/<ru|en>.js?v=<hash>` (`window.__UI_I18N__`, loaded `defer` before `app.js` / `reader.js`), no longer inline JSON in every page. Minified `app.min.js` / `styles.min.css` are served unless `NODE_ENV=development` (a `.min` older than its source is never used).

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

Event-loop hygiene (700k-book libraries): `refreshCatalogBookCounts` runs in a `worker_threads` worker (`src/services/catalog-counts-worker.js`, own connection, chunked UPDATEs; `CATALOG_COUNTS_INLINE=1` forces the old inline path) — never call it for a single book, use `adjustCatalogCountsForBook(id, ±1)`. The same worker pass groups by language and fills `catalog_lang_counts` (`kind` 1 authors / 2 series / 3 genres, raw `lang`, `book_count`; meta `catalog_lang_counts_ready`, set to `0` by the inline fallback, rebuilt once at boot when missing): author / series / genre lists filtered by profile languages read it instead of a GROUP BY over `active_books` (genres 11 s → 2 ms, series 4.5 s → 0.1 s, authors 50 s → ~0.4 s on 684k books) and fall back to counting books until it is ready. `dropBooksTableIndexes` → `ensureBooksTableIndexes` must end with `analyzeBooksIndexesYielding()`: DROP INDEX wipes `sqlite_stat1` and without stats the planner sorts the whole catalog in a TEMP B-TREE (~800 ms per page instead of ~2 ms); boot re-checks via `booksIndexStatsMissing()`. Browse ORDER BY must match an existing index exactly (`idx_books_title_nocase_id`, `idx_books_series_full` — no `CAST`, `idx_books_recent_sort`, `idx_books_date10` for novinki); a sort key from the joined `sources` table (`flibusta_sidecar`) is only added when enabled sources differ in that flag. `show_deleted_books=1` rewrites `active_books` as `deleted = 0 OR NOT EXISTS(suppressed)`, which disables every `WHERE deleted = 0` partial index — keep it off unless debugging. `[perf] event loop stalled N s` in `runtime.log` (threshold `LOOP_STALL_LOG_MS`, default 2000) is the first thing to check for "server hangs" reports; `/health/perf` has per-route p95. Plain catalog browse (no `q`) reads `catalog_active_books` (JOIN on the materialized `active_book_ids`) while `active_books_projection_state.dirty = 0` and the filter fingerprint matches; any write to `books`/`book_genres`/`sources.enabled`/`genres_catalog.name`/`suppressed_books` flips it to `1` (triggers) and browse falls back to the dynamic `active_books` view. The projection is rebuilt by `ensureActiveBooksProjection()` — single-flight, chunked by `books.rowid` with `setImmediate` yields (state `2` = building; a write during a pass leaves it stale and a follow-up pass runs) — never synchronously: `refreshCatalogBookCounts`/boot only call the debounced `scheduleActiveBooksProjection()`; `rebuildActiveBooksView` (filter settings change) awaits `ensureActiveBooksProjection()`. SQLite page cache / mmap: env `SQLITE_CACHE_SIZE_MB` / `SQLITE_MMAP_SIZE_MB` (or the `PERF_PROFILE` auto defaults) are only the startup defaults; Admin **Dashboard → Обслуживание → Память базы данных** saves `db_cache_mb` / `db_mmap_mb` (empty = back to env/auto) and `applyDbMemorySettings()` applies them to the main connection at boot and on save (other cluster workers on restart). Code that temporarily drops mmap must restore the module-level `_mmapSize`, not `config`. `recommendDbMemory()`: ≤ 2 GB RAM → 64 MB / mmap 0; otherwise mmap ≈ DB size (max 2048) within ~25% of RAM. Downloads: `resolveDownload` (single / batch ZIP / e-mail / Telegram) runs through `downloadLimiter` (`src/services/heavy-task-limiter.js`, `DOWNLOAD_MAX_CONCURRENT` 4, `DOWNLOAD_MAX_QUEUE` 100, `DOWNLOAD_QUEUE_TIMEOUT_MS` 120 s) so a download wave cannot fill the 7z queue (`SEVEN_Z_MAX_CONCURRENT` 6 / `SEVEN_Z_MAX_QUEUE` 20) that covers and the reader also need; full queues throw `SERVER_BUSY` and the HTTP layer answers 503 + `Retry-After` (`errors.serverBusy`, API code `SERVICE_UNAVAILABLE`), not a 500. A book file / INPX archive missing on disk (deleted or moved outside the catalog — e.g. a format removed by hand from a Calibre book folder while `metadata.db` still lists it) makes `readBookBuffer` (`src/fb2.js`) throw `BOOK_FILE_MISSING` and the HTTP layer answers 404 (`errors.bookFileMissing`, API code `BOOK_FILE_MISSING`, also for a single send-to-ereader; batch ZIP / e-mail skip such books), not a 500. `deleteUser` also clears `read_books`, `book_ratings`, `reader_annotations`, `reader_book_revisions`, `user_reader_revisions` and the user's Android device tokens in `meta` (a re-created same-name user must not inherit them). Basic auth (OPDS, API): a successful scrypt check is cached for 5 min (key includes the current password hash, blocked is re-read every request); failures count toward the login rate limiter per IP (`LOGIN_MAX_ATTEMPTS`), so a client with a stale password locks that IP's web login for the window too; Session cookie `v2|<issuedAtSec>|<username>:<sessionGen>.<hmac>` (`src/services/session.js`) is rejected on the server after `SESSION_MAX_AGE_MS` (0 = no server limit); legacy `<username>:<sessionGen>.<hmac>` cookies are still accepted until the next login. CSRF is skipped for Basic only without `Sec-Fetch-Site` or with `same-origin`/`none` (device Bearer always skips). `TRUST_PROXY`: `true` (any hop), a proxy count (`1`) or an address list (`loopback`, CIDR) — see `parseTrustProxy` in `src/config.js`. Cover thumb disk cache: `COVER_THUMB_DISK_TTL_DAYS` (30) / `COVER_THUMB_DISK_CACHE_MB` (2048), daily GC in `scheduler.js`. Admin **Backup** can export/import users JSON (password hashes, email, Telegram, favorite author/series **names** — not book ids, which change on reindex). Existing usernames are not overwritten.

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
