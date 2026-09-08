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
