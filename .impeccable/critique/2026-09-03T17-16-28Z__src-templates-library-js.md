---
target: home, catalog, book detail
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\inpx-library-server\\src\\templates\\library.js"
target_fingerprint: "sha256:f66a6db0fac196ccda1aada2c89318b2bfd3f0b311f73239ab4fae4de10dce6a"
target_path: "D:\\inpx-library-server\\src\\templates\\library.js"
timestamp: 2026-09-03T17-16-28Z
slug: src-templates-library-js
---
Method: dual-agent (A: 0e15dd55-a91f-4fcc-846a-b47ffce47c9f · B: 1e39c2cc-70a3-4516-83a7-0976410052a6)

Target: `src/templates/library.js` — home `/`, catalog `/catalog` (+ `?view=list`), book detail `/book/:id`. Mode: Operate. World: Private reading room.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Counts, breadcrumbs, active nav exist; mobile search collapse hides the live query |
| 2 | Match System / Real World | 3 | Covers and library language work; then `UN` in lang select and mixed `Download` / `Скачать` |
| 3 | User Control and Freedom | 2 | Filter chips + reset exist; `/login` has no path back to catalog despite promising guest access |
| 4 | Consistency and Standards | 2 | Grid CTA is Download-only; list rows add `Читать`; card HTML cache ignores locale |
| 5 | Error Prevention | 2 | Year is a raw number; list batch checkboxes; download has no confirm |
| 6 | Recognition Rather Than Recall | 3 | Nav and covers are visible; `?view=list` has no on-page control; ratings are raw `★` |
| 7 | Flexibility and Efficiency | 2 | Sort/filters/batch exist; list view is URL-or-profile-only; 66-lang dump |
| 8 | Aesthetic and Minimalist Design | 2 | Covers lead; then quote theatre, per-card Download, and instance background under the list |
| 9 | Error Recovery | 3 | Empty state + reset work; copy still says to “open the catalog again” while already on it |
| 10 | Help and Documentation | 2 | Login subtitle explains guest access; no link, no help for `+1`, list view, or format choice |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict

**Start here.** Authored for this product, then dressed in file-browser habits.

**LLM assessment:** This is not a generic SaaS grid. Dark leather (`#14110e`, ink-gold `#c4a35a`) and light parchment (`#f3ebe0`) hold. Covers use a spine radius and Source Serif 4 titles. The live light theme stayed cream, not cool gray. The instance logo and background belong to this library. What is interchangeable is the Operate chrome: every `.card` ends in `.download-menu-trigger` «Скачать», catalog is stock filter+sort+grid, guest `.welcome-hero-banner` is a quote poster before books. The world is specific; the task UI still behaves like a file browser with a literary skin.

**Deterministic scan:** `detect.mjs` on `library.js`, `shared.js`, `auth.js` — **1 finding**. `layout-transition` at `src/templates/shared.js:393` (`transition: width` on `#sources-progress-bar`). That banner is admin reindex chrome, not home/catalog/book. Treat as **out of scope for this target**, not a live-page defect. `library.js` and `auth.js`: clean.

**Visual overlays:** No reliable user-visible overlay. Mutation preflight succeeded (inline script + `document.title`), but CSP `script-src 'self' 'unsafe-inline'` blocked `http://localhost:8400/detect.js` on home, catalog, list, and book. Overlay count 0; `window.impeccableDetect` undefined. Fallback: CLI scan + live screenshots/snapshots (desktop + 390×844). Live-server on 8400 was started and stopped.

## Overall Impression

The reading room is real — covers, parchment, serif titles — and then the product asks you to **download**. Guest home opens on a quote and a login hint; catalog opens on 200k+ titles with Download as the repeated control; the book page finally feels like a library, but **Читать** sits below the annotation, off the first mobile screen. Biggest opportunity: make Read the primary path and Download a quiet secondary, without touching the pinned world.

## What's Working

- **Covers as objects.** `.cover` is 2:3, clickable, spine-asymmetric radius, layered shadow; titles in Source Serif 4. This is the product.
- **Place and recovery chrome.** Skip link, breadcrumbs, sidebar active pill, `Найдено …`, empty state with reset.
- **Light theme honors the brief.** Live parchment/espresso; login card still reads as a reading room.

## Priority Issues

**[P1] Primary action is Download, not Read**
- **Why it matters:** The product purpose is find a book and read. Grid `.card-actions` only render `renderDownloadMenu`. List rows add `Читать`. Book detail puts `.actions-primary` after `.book-detail-annotation`; on 390px the fold hides Read. `accent: true` on the download menu is ignored, so Скачать and Читать are twin buttons.
- **Fix:** Cover/title = read path. One primary `Читать` on cards and above the fold on `.book-detail-content`. Demote Download to a quiet menu. Label `target="_blank"` if kept.
- **Suggested command:** `/impeccable distill` (task hierarchy) then `/impeccable layout`

**[P1] Filters are a keyboard/SR trap**
- **Why it matters:** `.catalog-filter-shell` is a collapsed `<details>`, but the a11y tree still exposes genre search, dozens of checkboxes, and a lang `<select>` named with the entire 66-code option list (including `UN`). Same on empty search.
- **Fix:** `inert` or don't render filter body until open. Short `aria-label` on lang. Hide or label `UN`.
- **Suggested command:** `/impeccable audit`

**[P1] Login is a dead end**
- **Why it matters:** Subtitle admits the catalog works without auth, then only login/password. Logo `alt=""`, not a link. No `/catalog` or `/`.
- **Fix:** Text link «К каталогу»; logo goes home.
- **Suggested command:** `/impeccable clarify`

**[P2] List view is the better Operate scan and is invisible**
- **Why it matters:** `/catalog?view=list` is Flibusta-dense (title, author, Читать, Скачать) and matches “find a book.” Guests get grid unless they know `?view=`. In-page control lives in profile, not on the catalog.
- **Fix:** Covers | List control on the catalog bar; persist `?view=` for guests.
- **Suggested command:** `/impeccable layout`

**[P2] Locale-unsafe card cache and noisy card chrome**
- **Why it matters:** `_cardCacheKey` omits locale; the same RU home showed `Скачать` and `Download`. Cover ratings are unlabeled `★`; unexplained `+1`; closed format links sit in the a11y tree.
- **Fix:** Key cache by locale; `aria-hidden` on stars; name `+1`; don't expose closed format links.
- **Suggested command:** `/impeccable harden`

## Persona Red Flags

**Jordan (First-Timer):** Home opens on `.welcome-hero-banner`, not a book. Next copy is «Войти для…». Catalog title plus 213 624 books with no “start here.” Grid CTA is Скачать. Login explains guest catalog and offers no way there.

**Casey (Distracted Mobile):** Search toggle is top-of-screen, not thumb zone. Book detail: cover + long annotation, Читать below the fold. Compact download trigger and 11px bottom-nav text. Empty-search query lives in a sentence, not in the collapsed field.

**Sam (Accessibility):** No `h1` on home, catalog (`<h2>`), or book (`<h2 class="book-detail-title">`). Brand is also `h2`. Skip link exists. Collapsed filter descendants remain tabbable; lang select named with 66 codes; cover links announced as `★`; `Читать` opens a new tab without announcement. Focus rings exist.

**Home-library reader (RU/EN, covers, continue):** Guest home has no continue shelf. RU/EN switch works, then cached cards leak English `Download`. Covers work; “keep reading” is behind Войти. Series crumb on the book page is the one moment that feels like their shelf.

## Cognitive load

**Failed (6 of 8):** single focus; chunking; visual hierarchy on home; one thing at a time; minimal choices; progressive disclosure.  
**Passed:** grouping; working memory on desktop (breadcrumbs + result count).  
**Overloaded points:** 7 sidebar links; catalog chrome (sort + filters + 200k books + per-card Download); filter body (genres + 66 langs + format + year + rating + series); each card (cover, title, author, series, `+1`, Download, three formats in the tree); book primary actions at equal weight.

## Emotional journey

Peak: cover grid, then book page (serif title + annotation). Valley: guest quote hero + login hint; undifferentiated 200k catalog with Download as the loudest control. High-stakes: format choice with no guidance; `Читать` `target="_blank"`; continue-reading gated. End: annotation is the right last beat, then the user hunts for Read.

## Minor Observations

- `theme-color` `#1a1a2e` fights leather/parchment.
- Sort control: inline styles and hardcoded RU titles for asc/desc regardless of locale.
- Grammar: `Найдено 213 624 книги` (should be `книг`).
- Empty copy tells you to reopen the catalog while on `/catalog`.
- Duplicate series link in `.book-detail-summary`.
- Guest list still renders batch-download checkboxes when anonymous download is on.
- `.actions-secondary { display: none }` and unused `accent` on download menu.
- Sidebar brand + topbar logo compete on desktop.

## Questions to Consider

- If this is a reading room, why is the repeated control on every cover **Download** rather than **Read**?
- What would guest home be if the quote moved aside and the first row was books?
- Why can a guest open list view only by typing `?view=list`?
- Should Filters exist in the accessibility tree when collapsed?
- Is title-sorted 200k+ books the honest catalog default, or a human-sized slice (letter, recent, genre)?

Inspected live: `/`, `/catalog`, `/catalog?view=list`, `/book/1:859752` and `/book/1:778623`, `/login`, empty search. Desktop + 390×844. Guest browse was open. Foliate reader and admin were out of this pass.
