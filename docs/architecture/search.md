# Search Architecture

Requirements:

- huge library support (Flibusta-scale on NAS)
- indexed queries
- low memory usage
- deterministic SQL pagination

Avoid:

- full table scans on the hot path
- memory-heavy ranking / loading all hits into JS
- Elasticsearch / Meilisearch / Typesense for catalog metadata (not used)

## Pipeline

```text
User query
  → normalize (createSortKey + ё→е + mixed lookalike Latin/Cyrillic)
  → optional author+title split (content tokens; no FTS peek loop)
  → light Russian stem (one prefix: stem* when the stem is 4+ chars)
  → web `/catalog?q` (no field): always books page + section chips (Авторы / Серии)
  → GET /api/search: totals for chips / Android (`routeField` always null)
  → typeahead: GET /api/search/suggest (web dropdown + Android)
  → GET /api/catalog?field=authors|series from chips
  → empty: recovery hints + one typo retry; weak: ≤1 did-you-mean
  → paginated page (edition dedupe by title+author)
```

| Mode | Matcher |
|------|---------|
| Overview | `searchOverview` — capped book COUNT (≤10k) + authors/series totals + soft `preferredField`; `routeField` always null |
| Books | FTS5 MATCH + title boost (exact/prefix/ordered-token) then `bm25`; author+title split when confident; phrase OR; stopwords skipped in AND; LIKE fallback when dirty/desynced/`*`/zero MATCH; free-text uses capped COUNT |
| Authors | `listAuthors` (also OPDS). A single surname is a `sort_name` range (`>=` / `<` on `idx_authors_sort_name`); `LIKE '%token%'` only for `*` or when that prefix misses |
| Series | A single token is a `sort_name` range (`>=` / `<` on `idx_series_catalog_sort_name`); `LIKE '%token%'` only for `*` or when that prefix misses. Multi-token: series name + mixed author+series |

## Web navigation

Enter always opens **books** (Flibusta-like). Authors / series are chips above results — no hub screen and no smart 302 redirect. `preferredField` remains a soft API hint (series only when no author hits).

## Operators

| Operator | Meaning |
|----------|---------|
| (default) | Prefix FTS (`token*` + stem OR-expand) + multi-token phrase OR; LIKE: single `token%`, multi `%token%` |
| `=` | Exact token |
| `*` | Contains via LIKE |
| `~` | Regex over capped 5k-row scan |

## Morphology

- Query-time stem prefix (`src/search-stem.js`): one `stem*` when the stem is at least 4 characters; shorter stems stay as the typed token
- Index-time: stemmed tokens appended to `title_search` / `authors_search` (meta `search_stems_v1` backfill)
- Mixed Latin/Cyrillic lookalikes normalized at query time only (`src/search-normalize.js`)

## Hot-path speed rules

1. Overview never materializes/ranks 24 books synchronously; it warms the first page only when called without `booksTotal` (`/api/search`), never from `/catalog`, which already has that page
1a. `/api/search/suggest` is cached per query (`PAGE_CACHE_TTL_MS`); calls slower than `SLOW_SEARCH_LOG_MS` (default 300) log `[perf] slow suggest|overview|catalog q="…" authors=…ms series=…ms books=…ms`
2. No typo dictionary on suggest / overview
3. No alternate-mode rescans except empty catalog results
4. Suggest: `totalMode: 'omit'`; multi-word book suggest uses `field: 'title'`
5. FTS when healthy; LIKE only on miss/dirty/`*`
6. Unfiltered book totals count FTS rows only (cap 10k), without joining `active_books`
7. Language/format dropdowns read `catalog_distinct_langs` / `catalog_distinct_exts`, not `SELECT DISTINCT` over `books` on each search

## FTS reliability

- `books_fts_dirty`, desync probe vs `books_fts_docsize` **and** an empty `books_fts_idx` (docs without tokens)
- `content='books'` indexes only the values passed to `INSERT`/`'delete'`: triggers and the staged `rebuildBooksFtsFromContent` must pass all `*_search` columns. `INSERT INTO books_fts(rowid) VALUES (?)` fills `docsize` but no tokens → MATCH finds nothing, every search silently falls to a full-table `LIKE` (seconds on a NAS). `ensureBooksFtsTriggers` recreates triggers (old DBs hold the broken ones)
- Auto-recovery: desync → dirty; dirty also scheduled from search hot path; libraries over 50k books rebuild staged (yields to the event loop), smaller ones with one sync `rebuild`
- Admin: FTS status + **Rebuild FTS** (`POST /api/operations/fts-rebuild`)
- Post-index / post-rebuild: `warmupSearchFts`

## Did-you-mean

Authors + series + `search_title_tokens` (≤50k). Empty catalog → full `searchHints`; weak books page → ≤1 suggestion. Typo retry only after a true miss at catalog layer.

## Ranking (books)

1. Exact / stemmed-prefix `title_search`
2. Ordered token contains (`%a%b%c%`)
3. Prefix phrase
4. `bm25` / author rank
5. Catalog sort; page-level edition dedupe

Unfiltered book search (not an author+title split, not series sort, first ~16 pages) takes the FTS5 `ORDER BY rank LIMIT` window, pins multi-word exact titles via `idx_books_title_search`, then applies the same boost in JS. Series sort, author+title splits, catalog filters, and deeper pages keep the SQL `ORDER BY`.

## UX extras

- Web suggest dropdown → `/api/search/suggest` (+ history); debounce ≥300ms, min 3 chars
- Genre facets for free-text load via `/api/search/genres` after HTML
- Section chips (Книги / Авторы / Серии) above catalog results for free-text `q`
- Helpers: `src/search-enhance.js` (warm cache, dedupe; `routeField` unused)

## What we do not do

- Meilisearch / Elasticsearch / Typesense
- Trigram FTS over all books
- Full-text of book content (fb2 body)
