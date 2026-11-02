# 004 — Calibre library as a book source (plan)

Status: proposed — plan only, nothing implemented yet. Waiting for review.

## Why

Western users rarely have INPX collections; they keep books in Calibre. A folder source can
already index a Calibre folder's EPUB/MOBI/AZW3 files, but it:

- ignores `metadata.db`, so titles/authors the user fixed in Calibre, series, tags, ratings,
  languages, publisher, ISBN and the description are lost or re-guessed from each file's OPF;
- unpacks every EPUB at index time (slow on a NAS, 100k books = hours);
- shows one book per **file**: a Calibre book with EPUB + AZW3 + PDF appears three times;
- uses path-based ids (`sha256(sourceId:relativePath)`), and Calibre renames the folder and
  the files whenever the title or author is edited, so every metadata fix in Calibre "moves"
  the book and user data has to be rescued by `reattachMovedFolderUserData`;
- skips PDF / CBZ / CBR / DJVU / TXT, which many Calibre libraries are full of.

A dedicated source type `calibre` reads the catalog from `metadata.db` and never opens a book
file while indexing.

## What a Calibre library looks like

```
<library>/
  metadata.db                 SQLite, the catalog (Calibre is the only writer)
  metadata_db_prefs_backup.json
  Author Name/
    Book Title (123)/         books.path = "Author Name/Book Title (123)"
      Book Title - Author Name.epub   data.name = "Book Title - Author Name", data.format = 'EPUB'
      Book Title - Author Name.pdf
      cover.jpg               present when books.has_cover = 1
      metadata.opf            Calibre's per-book backup
```

Tables we read (all plain tables; **never the views** — `meta` and friends call Calibre's
custom SQL functions `concat`, `sortconcat`, `title_sort` that are not registered in our
process and would throw):

| Calibre | Columns used |
|---|---|
| `books` | `id`, `uuid`, `title`, `sort`, `author_sort`, `series_index` (REAL), `pubdate`, `timestamp` (added), `last_modified`, `path`, `has_cover` |
| `authors` + `books_authors_link` | `name` ("First Last"), `sort` ("Last, First"); link order = `books_authors_link.id` |
| `series` + `books_series_link` | `name` (at most one series per book) |
| `tags` + `books_tags_link` | `name` (free text) |
| `ratings` + `books_ratings_link` | `rating` 0–10 (half stars) |
| `publishers` + `books_publishers_link` | `name` |
| `languages` + `books_languages_link` | `lang_code` (ISO 639-2/3: `eng`, `rus`, `deu`), `item_order` |
| `comments` | `book`, `text` (HTML) |
| `identifiers` | `book`, `type` (`isbn`, `goodreads`, `amazon`…), `val` |
| `data` | `book`, `format` (upper case), `uncompressed_size`, `name` (file name without extension) |

Custom columns (`custom_column_N`) are out of scope (see «Later»).

## Mapping onto our tables

One `books` row per **Calibre book** (not per file).

| Our column | From Calibre |
|---|---|
| `id` | `sha256("<sourceId>:calibre:<uuid>").slice(0, 32)` — same hex shape as folder ids; independent of path, so renames in Calibre keep the id |
| `lib_id` | `calibre:<uuid>` — the stable fingerprint for re-attaching user data (below) and for `POST /api/books/resolve` (Android books downloaded from another server running the same library match by `libId` + title). Duplicates auto-clean partitions by `lib_id` + archive stem, so the prefix keeps it from ever colliding with numeric Flibusta ids |
| `title` | `books.title` |
| `authors` | from `authors.sort` ("Last, First Middle") → INPX form `Last,First,Middle`, joined with `:`, in link order. The INPX form matters: collections matching and `authorSortKey` take the surname as the part before the first comma. Fallback when `sort` is empty or equals `name`: `name` as is (like EPUB `dc:creator` today) |
| `series`, `series_no` | `series.name`; `series_index` REAL → `"1"`, `"2.5"` (drop `.0`) |
| `genres` | tags (see «Tags») |
| `keywords` | publisher + tags not used as genres; only for search |
| `lang` | first language by `item_order`, ISO 639-2/3 → 639-1 (`eng`→`en`, `rus`→`ru`, `deu`/`ger`→`de` …; small static table, unknown codes kept as is). Without the mapping `en` from INPX/EPUB and `eng` from Calibre would be two languages in the profile language filter and `catalog_lang_counts` |
| `date` | `books.timestamp` (date added, `YYYY-MM-DD`) — this is what «Новинки» means for a Calibre user. `pubdate` goes to publish-info instead |
| `lib_rate` | `round(rating / 2)` (0 = none) |
| `ext` | primary format (see «Formats of one book») |
| `file_name` | `<books.path>/<data.name>` of the primary format, forward slashes — exactly what `readDirectFile` / `findNearFileCover` already resolve as `<root>/<fileName>.<ext>` |
| `archive_name` | `''` (loose files) |
| `size` | `data.uncompressed_size` of the primary format |
| `deleted` | `0` |

`book_authors` / `book_series` / `book_genres` are filled through the same
`resolveAuthorId` / `resolveSeriesId` / `resolveGenreId` + `enrichBookRow` path as the folder
indexer (extract those helpers into a shared module rather than copy them).

### Tags

Calibre tags are free text ("Fiction", "Science Fiction", "To read", "Kindle"). Folder EPUBs
already put `dc:subject` into genres, so the default is the same: **tags → genres**, stored
as `genres_catalog.name = lower(tag)`, display = the tag as typed. Codes not in
`GENRE_LABELS` keep their stored name, so `formatGenreLabel` / `localizeGenreLabel` and
`displayNameEn` need no change.

A per-source setting decides it (additive column `sources.calibre_tags`):
`genres` (default) | `keywords` (searchable only, no genre facet) | `ignore`. Libraries with
hundreds of workflow tags ("unread", "kobo") would otherwise flood `/genres`.

Mapping common English tags to FB2 codes (`Science Fiction` → `sf`) so they merge with INPX
genres is **not** in phase 1 — it is a list to curate, and wrong merges are worse than
separate genres.

### Book details (annotation, cover, publish info)

Calibre already has everything the book page needs; nothing should unpack the EPUB.

- **Annotation** = `comments.text` (HTML) → `annotationIsHtml: true`, always through
  `sanitizeHtml` (the BB-code path is for INPX plain text and is skipped).
- **Cover** = `<root>/<books.path>/cover.jpg` when `has_cover = 1`. `findNearFileCover`
  already finds `cover.jpg` next to a loose file, so covers of folder-indexed Calibre
  libraries work today — but it `statSync`s up to 18 candidates on the request path. For
  `calibre` books read the one known path with `fs.promises.readFile` and skip the
  candidates; the existing thumb memory/disk caches stay in front of it.
- **Publish info** = year of `pubdate` (Calibre writes `0101-01-01` for "unknown" — treat
  year < 1000 as none) + first `identifiers` row of type `isbn`.

`getOrExtractBookDetails` gets a `calibre` branch before `needArchiveExtract`: one indexed
lookup in the snapshot (below) by Calibre id, fill `annotation` / `publishYear` / `isbn` /
`cover`, `metaResolved = true`, save to `book_details_cache` as today. Details are **not**
written at index time: 100k comments ≈ 150 MB of HTML in `library.db` for books nobody opens.
`warmupBookDetailsCache` is not run for this source type (it exists to pre-unpack archives).

## Reading `metadata.db` safely: the snapshot

Calibre may write the database while we read it, it is often on SMB/NFS (where SQLite
locking is unreliable — Calibre itself warns about network drives) and Docker users mount it
read-only. So the indexer never reads the live file:

1. `stat` `metadata.db` (async). Same `mtimeMs` + `size` as meta `calibre_db_fp_<id>` and an
   incremental run → skip the source entirely (like `ensureInpxSourceIndex`).
2. `fs.promises.copyFile` to `data/calibre/<sourceId>-<mtimeMs>.db`, then `stat` the source
   again: if it changed during the copy, retry (max 3, then fail the pass with a `warn`
   event — the previous snapshot stays in use).
3. Open the copy with `new Database(path, { readonly: true, fileMustExist: true })`,
   check `PRAGMA user_version` / required tables exist (unknown schema → clear error, not
   a crash), read.
4. On success store meta `calibre_snapshot_<id>` = file name and delete older snapshots of
   that source. Versioned names (not rename-over) because on Windows a file another cluster
   worker holds open cannot be replaced; each process keeps a lazily opened read-only
   connection per source and reopens when the meta pointer changes. Old files a worker still
   holds are removed on a later pass (best effort).

The snapshot is the only thing request-time code reads (book details, extra formats). Disk
cost = one copy of `metadata.db` (~1–3 KB per book: 100k books ≈ 100–300 MB, mostly
comments). The live file is opened by nothing but `copyFile`.

## Indexing

New `src/calibre-indexer.js` with `indexCalibre(source, { incremental, onProgress, control })`,
dispatched next to `indexFolder` in `indexSingleSource` / `indexAllSources` (`src/inpx.js`).
It reuses: `beginExclusiveOperation('indexing')`, `resolveIndexImportMode` (FTS bulk mode only
for big changes against `MAX(rowid)` of the whole library), `beginFastSqliteImport`,
`stashUserDataRefsForSource` / `runWithForeignKeysOff` for a full reindex,
`bumpIndexNewBooks`, `updateSourceBookCount`, `updateSourceIndexedAt`,
`reattachDetachedUserData`, `repairBookJunctionLinks`, the `onIndexComplete` hooks (catalog
counts worker, projection, collections re-match).

Reading pattern (no full result sets in memory, no long sync statements):

- keyset chunks over the snapshot: `SELECT … FROM books WHERE id > ? ORDER BY id LIMIT 1000`;
- the links for that chunk with `WHERE book IN (…ids)` per link table (all have indexes on
  `book`), assembled in JS;
- write the chunk into `library.db` in transactions of ≤ 350 rows, `setImmediate` yield after
  each chunk, `waitIfPaused` / `throwIfCancelled` between chunks;
- every snapshot statement is small and indexed (~ms); if profiling on a 100k library shows a
  chunk above ~50 ms, move the reading into a `worker_threads` worker that posts chunks
  (same shape as `catalog-counts-worker.js`) — the write side stays where it is.

### Incremental

New additive table (cleaned with the source):

```sql
CREATE TABLE IF NOT EXISTS calibre_book_state (
  source_id INTEGER NOT NULL,
  calibre_id INTEGER NOT NULL,
  book_id TEXT NOT NULL,
  uuid TEXT NOT NULL,
  last_modified TEXT NOT NULL,
  formats TEXT NOT NULL DEFAULT '',   -- "EPUB:12345,PDF:999" — detects format add/remove
  PRIMARY KEY (source_id, calibre_id)
);
```

(Not a JSON blob in `meta` like `folder_index_<id>`, which is megabytes for big folders.)

A pass with a changed `metadata.db`:

1. Walk the snapshot in keyset chunks comparing `last_modified` + `formats` with the state
   row → changed / new ids go to the import queue.
2. Calibre ids in the state table but not in the snapshot = deleted in Calibre.
3. Import queue → upsert rows + re-link authors/series/genres (as the folder indexer does).
4. Deleted: same rules as a vanished folder file — `stashMovedFolderBookRef` (source id +
   size + title key) and delete with foreign keys off; `reattachMovedFolderUserData` at the
   end matches a book new in this pass (a book removed and re-added in Calibre gets a new
   uuid); unmatched refs expire after 30 days (delayed cascade). No new purge logic.
5. Drop `book_details_cache` rows of changed books (their comment/cover may have changed);
   the cover thumb caches through `invalidateCoverThumbCaches`.

Calibre bumps `books.last_modified` on metadata edits, cover changes and format add/remove,
and when an author/series/tag is renamed through "Manage …" for every affected book.
**Verify on a real library before relying on it** (Calibre 5–8); the `formats` column is a
belt-and-braces check for formats, and a forced full reindex stays available in Admin.

### Index safety

- `metadata.db` missing or unreadable → abort the pass, nothing touched (an unmounted volume).
- Snapshot has 0 books while the source has books → abort with the same message style as
  `indexFolder`'s empty-folder guard.
- Book files are **not** `stat`ed during indexing (100k stats on a NAS); after the pass sample
  ≤ 50 primary files like `checkInpxArchivesOnDisk()`: none found → `warn` event + index diary
  line («проверьте путь и монтирование»).

### Full reindex and source re-add

Ids derive from the uuid, so a full reindex reproduces the same ids and the existing
stash → delete → `reattachDetachedUserData` sequence is enough. A source deleted and added
again gets a new source id → new book ids; `detached_book_refs` matches by
`lib_id` + `archive_name` + `file_name` + `ext`. `file_name` and `ext` can change in Calibre
between the delete and the re-add (title edit, new primary format), so add one rule to
`reattachDetachedUserData`: refs whose `lib_id` starts with `calibre:` match on `lib_id` alone
(unique by construction).

### Converting an existing folder source

Users who already pointed a folder source at their Calibre library: Admin offers «Convert to
Calibre library» on a folder source whose path has `metadata.db`. It changes the type, runs a
full Calibre index, and before deleting the old rows maps old folder ids to new ones by
`file_name` + `ext` (the folder file path equals `<books.path>/<data.name>`), moving user rows
with `moveUserBookRows`. Non-primary formats of a book map onto the same new book. Phase 2.

## Formats of one book

A Calibre book often has several files. One row, one **primary** format, chosen by a fixed
preference: `epub > azw3 > mobi > fb2 > pdf > djvu > cbz > cbr > txt > rtf > docx`
(readers first; formats outside the list are ignored). If the primary changes (EPUB added to
a PDF-only book), the row's `ext` / `file_name` change but the id stays; positions survive
by `fraction` (`positionForBookFormat` already drops format-specific anchors).

The other formats: phase 1 ignores them (the primary is what the reader and OPDS serve).
Phase 2 adds additive table `book_files (book_id, ext, file_name, size)` and extends
`getBookNativeDownloadFormats` to return `[ext, ...extra exts]`, so `downloadFormats`,
`/download/:id?format=pdf`, OPDS acquisition links and send-to-ereader can pick any of
them (Kindle users usually want AZW3/MOBI or EPUB; the format menu already exists in web and
Android). `resolveDownload` reads `book_files` for a non-primary `format`.

## Formats we don't handle today (separate phase)

PDF, DJVU, CBZ, CBR, TXT, RTF, DOCX. What already works: non-FB2 books download as is
(`getBookNativeDownloadFormats` returns `[ext]`), `book-format.js` sniffs pdf/djvu/cbz, INPX
libraries already contain pdf/djvu rows. Minimal support = **download + OPDS + send, no
web reader**:

- MIME entries for `pdf`, `djvu`, `cbz`, `cbr`, `txt`, `rtf`, `docx` in `opds.js`,
  `opds-v2.js`, `conversion.js` (KOReader opens PDF/DJVU/CBZ from OPDS, so OPDS is the main
  win);
- the «Читать» button only for formats the web reader opens (FB2, EPUB, MOBI/AZW3, and CBZ
  if Foliate's comic book path works in our build — check); others show download only;
- send-to-ereader: Kindle accepts PDF/DOCX/TXT/RTF/EPUB; others are refused with a clear
  error;
- the same extension list can be added to the folder source (`SUPPORTED_EXTENSIONS`, watcher
  `BOOK_EXTENSIONS`) with filename-only metadata — folder parity, optional;
- CBR is RAR: download only, never unpacked (no RAR dependency).

## Admin UI

- **Add source** (`POST /admin/sources/add`): `type` gains `calibre`; `addSource` stops
  coercing everything that isn't `inpx` to `folder`. Path = the library folder. Fast scan does
  not apply. Badge «Calibre» in the sources table.
- **Probe** (`POST /api/sources/probe`): additive `isCalibre: true` + `calibreBooks` (a
  `COUNT(*)` on a read-only open — fast) when `<path>/metadata.db` exists. The admin form
  pre-selects «Calibre library» in that case, the same way it suggests `.inpx` files.
- Per-source «Tags as: genres / keywords / ignore».
- `getSourceRoot`, `flibusta-sidecar` root resolution: `calibre` behaves like `folder`
  (root = the path). Flibusta sidecar refresh is skipped for `calibre`.

## Folder watching

`folder-watcher.js` reconciles `type === 'folder'` sources only. For `calibre`, watch just
`metadata.db`: a **non-recursive** `fs.watch` on the library root filtered to
`metadata.db` / `metadata.db-journal` (no tree walk at all, so no inotify limit problems and no
worker needed for the walk, but keep it in the same worker for one code path). Calibre writes
the database on every edit; the existing quiet period (120 s) debounces a session of edits
into one incremental pass, and the "only after a successful `onIndexComplete`" rule is
unchanged. Interval scans stay the fallback (the mtime check makes them nearly free).

## Android parity (`D:\inpx-book-reader`)

Phase 1 needs **no Android change**: Calibre books are ordinary catalog books (EPUB, AZW3,
MOBI, FB2), `GET /api/books/:id/content` serves the file, metadata comes from `/api/*`.
Things to verify, not build: AZW3/MOBI open in the app reader (they come from folder sources
today too), English tag genres show as stored names (`localizeGenreRows` falls back).

The formats phase **does** need app work (feature parity rule): a PDF/DJVU/CBR book must not
be offered to the built-in reader; the book sheet shows «Скачать» + «Открыть в другом
приложении» (Android intent through a `FileProvider`), and the download format menu lists the
extra formats from phase 2. `inpxClient.ts` already passes `ext` / `downloadFormats` through.

## Risks on 100k+ book libraries

| Risk | Mitigation |
|---|---|
| Event loop blocked by a long SQLite read | keyset chunks of 1000 + yields; worker fallback if a chunk is slow |
| RAM | never all rows: chunked reads; the incremental diff is per chunk against `calibre_book_state` (indexed lookup), not a 100k Map |
| First full index | ~100k rows without opening a file: expected minutes, dominated by our own FTS/index rebuild (bulk mode), not Calibre |
| `metadata.db` changing while copied | stat before/after, retry, keep the previous snapshot |
| Snapshot disk use | one copy per source (100–300 MB at 100k); documented |
| Unknown Calibre schema | check required tables/columns on open, fail with a clear message |
| Genre flood from tags | per-source tags mode |
| Calibre on a network share and read-only Docker mounts | we only ever read it via `copyFile`; snapshot lives in `data/` |
| Same library added twice | two sources, different ids (source id in the hash); duplicates auto-clean sees the same `lib_id` |

## Phases

1. **Calibre source**: snapshot, full + incremental indexing (primary format only), tags mode,
   details from the snapshot + `cover.jpg`, probe/add UI, metadata.db watcher, `lib_id`
   reattach rule, tests with a small fixture `metadata.db` (built in the test with the real
   Calibre schema subset). Server + web only; Android unchanged (verify).
2. **All formats of a book**: `book_files`, extra download/OPDS/send formats; folder → Calibre
   conversion.
3. **PDF / DJVU / CBZ / CBR / TXT…**: MIME types, reader gating, send-to-ereader rules, the
   same list for folder sources; Android «open in another app».

Later, if asked: custom columns (as keywords or a facet), tag → FB2 genre mapping,
Calibre "read" custom column → `read_books` import, writing back to Calibre (never by default).

## Docs to update when implemented

Both `AGENTS.md` (server: source type, snapshot, `calibre_book_state`, probe fields; reader:
formats phase), README «Calibre» section (English and Russian).
