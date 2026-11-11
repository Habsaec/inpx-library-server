---
title: Troubleshooting
description: Common problems and how to fix them.
---

- **The server doesn't respond.** `curl -sS http://127.0.0.1:3000/health` should return `"ok":true`.
- **The catalog is empty.** Is the source added and has indexing finished? In Docker, the source path is inside the container (`/library`, `/sources/…`).
- **«Archives not found» after an INPX import.** The `.zip` / `.7z` archives must sit next to the `.inpx`; check the mount.
- **No EPUB / MOBI under «Download».** The converter is not installed — run `install.cmd` / `install.sh` again.
- **`better-sqlite3` / `NODE_MODULE_VERSION` error.** Run `install.cmd` / `install.sh` again.
- **Forgot the admin password.** `reset-admin.cmd` (Windows) or `./reset-admin.sh`.
- **The server «freezes».** Look for `[perf] event loop stalled` in `data/runtime.log`; response times per route are at `/health/perf` (signed in as an admin).
