---
title: For developers
description: Run from source, architecture and project documentation.
---

```bash
npm install
npm run dev      # restarts on changes
npm test
```

Stack: Node.js (ESM), Express, SQLite (better-sqlite3), vanilla JS / CSS without frameworks.

## Documentation in the repository

- [`AGENTS.md`](https://github.com/Habsaec/inpx-library-server/blob/master/AGENTS.md) — API for Android and project rules;
- [`docs/architecture`](https://github.com/Habsaec/inpx-library-server/tree/master/docs/architecture) — indexing, INPX, search, OPDS;
- [`docs/decisions`](https://github.com/Habsaec/inpx-library-server/tree/master/docs/decisions) — decisions taken;
- [`CHANGELOG.md`](https://github.com/Habsaec/inpx-library-server/blob/master/CHANGELOG.md) — change history.

API errors carry a stable `code` field — clients should rely on it. Issues and pull requests in English are welcome.

## This website

The site lives in the `site/` folder ([Astro Starlight](https://starlight.astro.build)) and is published to GitHub Pages on every change there. Locally: `cd site && npm install && npm run dev`.
