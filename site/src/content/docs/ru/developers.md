---
title: Разработчикам
description: Запуск из исходников, архитектура и документация проекта.
---

```bash
npm install
npm run dev      # перезапуск при изменениях
npm test
```

Стек: Node.js (ESM), Express, SQLite (better-sqlite3), чистые JS / CSS без фреймворков.

## Документация в репозитории

Преимущественно на английском:

- [`AGENTS.md`](https://github.com/Habsaec/inpx-library-server/blob/master/AGENTS.md) — API для Android и правила проекта;
- [`docs/architecture`](https://github.com/Habsaec/inpx-library-server/tree/master/docs/architecture) — индексация, INPX, поиск, OPDS;
- [`docs/decisions`](https://github.com/Habsaec/inpx-library-server/tree/master/docs/decisions) — принятые решения;
- [`CHANGELOG.md`](https://github.com/Habsaec/inpx-library-server/blob/master/CHANGELOG.md) — история изменений.

Ошибки API содержат стабильное поле `code` — клиентам стоит опираться на него. Issues и pull request’ы приветствуются.

## Сайт

Этот сайт лежит в папке `site/` ([Astro Starlight](https://starlight.astro.build)) и публикуется на GitHub Pages при каждом изменении в ней. Локально: `cd site && npm install && npm run dev`.
