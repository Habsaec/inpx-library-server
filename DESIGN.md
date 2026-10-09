# Design System

<!-- impeccable:design-schema 1 -->

## World

**Private reading room** — a self-hosted library Operate UI. Book covers lead; chrome stays quiet. Warm parchment paper in light theme, deep book-leather in dark. Restrained ink-gold / espresso accent. Premium craft through materials, type, and spacing — not marketing theatre.

## Color

Strategy: **Restrained** (neutrals + one accent).

### Dark (`:root`)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#14110e` | Page ground |
| `--shell-bg` / `--sidebar-bg` | `#16130f` / `#12100d` | Shell |
| `--surface` | `#1a1612` | Panels, menus |
| `--text` | `#f2ebe0` | Primary ink |
| `--muted` | `#a89884` | Secondary |
| `--accent` | `#c4a35a` | Active / emphasis |
| `--link` | `#d4b06a` | Interactive text |
| `--border` | `rgba(196,163,90,0.12)` | Hairlines |

### Light parchment (`html[data-theme="light"]`)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#f3ebe0` | Warm parchment |
| `--surface` | `#fff9f0` | Cards / panels |
| `--text` | `#1f1810` | Deep ink |
| `--muted` | `#6b5a48` | Secondary |
| `--accent` | `#8a6230` | Espresso gold |
| `--link` | `#7a5218` | Links |
| `--border` | `rgba(55,40,24,0.12)` | Hairlines |

Admin UI customization may override tokens when configured (`data-ui-theme`).

## Typography

| Role | Face | Notes |
|---|---|---|
| UI | **Source Sans 3** (preset key `inter` for settings compat) | Body, nav, controls |
| Display | **Source Serif 4** (`--display-font`) | Page titles, hero quote, series headings, book detail title |
| Optional presets | system, Source Serif 4 (`serif`), Georgia, Merriweather, Nunito, mono, custom | Admin → UI |

Web fonts are self-hosted in `public/fonts/` (latin + cyrillic woff2, OFL licenses alongside); UI pages make no Google Fonts requests.

Body ~14.5px / 1.55. Display headings use slight negative tracking (~-0.02em).

## Spacing & radius

- Space scale: 4 / 8 / 16 / 24 / 36 (`--space-*`)
- Radii: 8 / 10 / 14 / 20; buttons pill (`999px`); covers `--radius-card: 6px`
- Sidebar width `--sidenav-w: 232px`; topbar `--topbar-h: 64px`
- Panel padding ~28–32px; grid gap ~32×22

## Elevation & motion

- Soft diffused shadows (`--shadow-sm/md/lg`); covers use layered soft depth, not hard offsets
- Easing: `--ease-premium: cubic-bezier(0.32, 0.72, 0, 1)`
- Prefer `transform` / `opacity` / color / box-shadow; avoid animating layout width/height on new work
- Focus: `--focus-ring` (double ring), not raw outlines alone
- Sticky topbar: backdrop blur ~18px

## Components (reader-facing)

- **Shell:** fixed sidebar, sticky glass topbar, pill search field
- **Nav active:** soft accent wash + inset hairline (no thick side border)
- **Home hero:** quote in display serif; continue-reading card with border + soft shadow
- **Catalog grid:** covers lead; title weight 600; quiet download chrome
- **List view:** grouped panels with soft surface, hover row wash, Covers/List segmented control
- **Book detail:** bordered surface panel; display-serif title

## Magic layer (2026-10)

Additive block at the end of `public/styles.css`, inspired by Magic UI / tailwindcss.com but kept in the warm world. Every effect derives from `--accent` (Admin → UI palettes still drive it); `--magic-ember` is a warm rust mix of the accent.

- **Backdrop:** 48px blueprint grid + gold/ember aurora on `.main-wrap::before` and the login page, faded by a radial mask
- **Home hero:** the quote uses the continue-reading card's anatomy (200px cover column + kicker / title-scale text / author) so swapping in the card does not jump; the cover slot is `.welcome-hero-mark`, a leather "binding" with an embossed open-quote and a drifting glow (`@property --mark-glow-x`); quote and author resolve out of blur
- **Covers:** pointer-following light inside `.cover::after` (`--spot`, `--mx/--my` from `attachPointerSpotlight` in `app.js`), warm glow under the lifted cover
- **Panels:** border that lights up under the pointer on `.admin-card` and `.book-detail-main`
- **Book detail:** the cover itself, blurred, as an ambient backdrop (`--detail-cover` set by the template)
- **Buttons:** shimmer sweep + glow on every bordered button (icon-only toggles excluded); shelf «Show all» is a pill with a sliding arrow
- **Login:** travelling conic border beam (`@property --beam-angle`)
- **Continue reading:** progress bar with a moving sheen
- Off in e-ink mode and `prefers-contrast: more`; animations off under `prefers-reduced-motion`

## Do / Don’t

**Do**

- Let covers carry visual energy
- Keep parchment warm in light theme
- Use display serif sparingly for literary hierarchy

**Don’t**

- Purple gradients, Inter as product voice, neon accents
- Thick colored left borders as card accents
- Landing-page bento / metric-hero patterns in Operate surfaces
- Cool gray light theme (parchment is pinned)

## Surfaces in scope

Documented from the 2026-08 rebrand: shell, home, catalog (grid + list), book detail chrome. Admin inherits tokens only. Foliate reader and Android app are out of this document’s visual scope.
