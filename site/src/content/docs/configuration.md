---
title: Configuration
description: Environment variables, large libraries and low-end hardware.
---

Almost everything is configured in the admin panel. Environment variables set the defaults; the full list with comments is in [`.env.example`](https://github.com/Habsaec/inpx-library-server/blob/master/.env.example) (copy it to `.env`).

## Main environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `LIBRARY_ROOT` | `/library` | Default books folder |
| `SESSION_SECURE_COOKIE` | `false` | `true` behind HTTPS |
| `TRUST_PROXY` | `false` | Proxy in front of the server: `1` — a single nginx / Caddy, `loopback` or a list of subnets |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | Mail for sending to e-readers (or in the admin panel) |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (or in the admin panel) |
| `SCAN_INTERVAL_HOURS` | `0` | Rescan sources every N hours |
| `FOLDER_WATCH` | `1` | Watch folders and index new files |
| `DOWNLOAD_MAX_CONCURRENT` | `4` | How many books are prepared for download at once |
| `PERF_PROFILE` | auto | `embedded` for a NAS / low memory |
| `CLUSTER_WORKERS` | `0` | Number of processes (0 — one) |

## Large libraries and low-end hardware

- Indexing and heavy recounts run in background threads — the server keeps responding during an import.
- On devices with ≤ 2 GB of RAM a lean profile is used; the database cache is set in **Admin → Dashboard → Maintenance → Database memory**.
- INPX builds with PPMd archives and WebP images are supported. For older e-readers, turn on **Admin → Content → Books with WebP images** (recode to PNG).
- Added a second copy of the same collection? Run **Admin → Duplicates → Auto-clean duplicates**.
- Rebuilding the index or removing a source never loses users' bookmarks, positions or shelves.

## How it works

```text
INPX collections, Calibre, folders  →  SQLite index (FTS5 search, covers)
                                          ├─ web interface and reader
                                          ├─ OPDS / KOSync
                                          ├─ Android app
                                          └─ Telegram bot and e-mail
```

Metadata (series, authors, genres) comes from the index and is served through `/api/*` — one contract for the web, OPDS, Telegram and Android.
