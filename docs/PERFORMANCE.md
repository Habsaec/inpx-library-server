# Производительность и блокирующие операции

## SQLite

- **WAL**, `busy_timeout`, кэш страниц — в [src/db.js](../src/db.js).
- После индексации: задержка `POST_INDEX_MAINTENANCE_DELAY_MS` → `wal_checkpoint(TRUNCATE)` → `ANALYZE` **по таблицам с уступкой event loop** ([analyzeDatabaseYielding](../src/db.js)), затем сброс кэшей.
- Периодический checkpoint (каждые 5 мин): `wal_checkpoint(PASSIVE)` — мягче, чем `TRUNCATE`.

## Индексация

- Фоновая индексация в том же процессе, что и HTTP; тяжёлые участки дробятся через `setImmediate` ([src/inpx.js](../src/inpx.js), [src/folder-indexer.js](../src/folder-indexer.js)).
- Отдельный процесс без веб-сервера: `npm run index:worker` ([scripts/index-worker.js](../scripts/index-worker.js)).

## Flibusta sidecar

- Детект раскладки кэшируется по пути корня; сброс при `syncAllSourcesFlibustaFlag()` и экспорт `clearFlibustaLayoutCache` ([src/flibusta-sidecar.js](../src/flibusta-sidecar.js)).

## Архивы книг

- Единый лимит распаковки записи: `ARCHIVE_MAX_ENTRY_BYTES` в [src/constants.js](../src/constants.js); используется в [archives.js](../src/archives.js) и [seven-zip.js](../src/seven-zip.js).
- Таймауты zip: `ARCHIVE_ZIP_OPEN_TIMEOUT_MS`; 7z: `SEVEN_Z_LIST_TIMEOUT_MS`, `SEVEN_Z_EXTRACT_TIMEOUT_MS`.

## Горячие пути HTTP

- Каталог JSON вынесен в [src/routes/browse-api.js](../src/routes/browse-api.js).
- Диагностика — [src/routes/health.js](../src/routes/health.js); при `HEALTH_MINIMAL=true` ответ `/health` минимален.
