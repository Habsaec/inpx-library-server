# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are readers who self-host or join a private ebook library (home NAS, Raspberry Pi, personal server). They search, browse, open books in the browser or Android app, resume reading, and manage favorites/shelves. Secondary users are library admins who configure sources, users, SMTP, and indexing. *[Inferred from README / AGENTS.md; confirmed by rebrand brief.]*

## Product Purpose

INPX Library Server turns INPX/FB2 (and related) ebook collections into a searchable personal library with web catalog, online reader, OPDS, and delivery to devices. Success means finding a book quickly, reading without friction, and keeping progress/bookmarks across sessions and clients.

## Positioning

Metadata and catalog power come from the INPX index via a single API contract shared by web, OPDS, and the Android reader — not from client-side archive parsing. Self-hosted, offline-capable collections stay under the user's control.

## Operating Context

Frequent tasks: search/browse catalog, open book detail, continue reading, download/convert, manage favorites. Environments: desktop browser, mobile web, Android APK, OPDS clients (KOReader, FBReader). Light and dark themes; RU/EN UI.

## Capabilities and Constraints

- Confirmed: catalog search (FTS), authors/series/genres, filters, covers, reader (FB2/EPUB), position sync, favorites, OPDS, admin panel, OIDC optional.
- Stack: Node.js ESM, Express, SQLite, Vanilla JS/CSS in `public/` — no React/TypeScript/ORM.
- Constraints: low-resource hosts (NAS, Pi); additive API compatibility; admin theme customization must continue to override tokens when configured.

## Brand Commitments

- Product name: **INPX Library Server**.
- Visual world (user-pinned, 2026-08 rebrand): **Private reading room** — warm parchment paper for light theme, deep warm book-leather for dark; restrained ink-gold/espresso accent; book covers lead the visual hierarchy.
- Light theme must remain **parchment** (warm paper), not cooler gray.
- Operate-mode UI: scanability and task clarity outrank marketing expression; premium craft through materials, type, and spacing — not landing-page theatre.

## Evidence on Hand

- Live product UI in `public/styles.css`, `public/app.js`, `src/templates/*`.
- README and `AGENTS.md` for capability/API truth.
- No fabricated testimonials, user counts, or commercial claims.

## Product Principles

1. Covers and catalog clarity come first; chrome stays quiet.
2. One metadata contract for every client.
3. Self-hosted performance and backward compatibility beat visual novelty.
4. Premium means refined materials and type, not louder decoration.
5. Admin and reader surfaces share tokens; reader-facing craft is the bar.

## Accessibility & Inclusion

Target WCAG-minded contrast for body text (≥4.5:1), visible focus, and usable touch targets on mobile. No stricter product-specific standard was set.
