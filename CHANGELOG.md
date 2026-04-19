# Changelog

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.0.0/).

## [Unreleased]

### Для самохостинга

- Документация: [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
- Переменные: `POST_INDEX_MAINTENANCE_DELAY_MS`, `HEALTH_MINIMAL`, см. `.env.example`.

### OPDS

- Пути `/opds/*` и параметры запросов (`query`, `term`, `type`, `uid`, …) сохраняются по возможности совместимыми между минорными версиями. При изменении контракта фидов будет отмечено в этом файле и в заметках релиза.
