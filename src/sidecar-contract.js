/**
 * Единая точка описания контракта «книга → корень библиотеки → sidecar Flibusta/FLibrary».
 *
 * **Корень библиотеки** для источника INPX: `dirname(путь_к_.inpx)`.
 * Для источника «папка»: сам путь источника.
 *
 * **Распознавание** наличия sidecar: {@link detectFlibustaSidecarLayout} — ищет среди прочего:
 * - `covers/`, `images/` (в корне или под каталогами зеркала),
 * - `etc/reviews`, `etc/authors`, `etc/authors/pictures`, `etc/annotations.7z`.
 *
 * Флаг в БД `sources.flibusta_sidecar` обновляется через {@link syncAllSourcesFlibustaFlag}
 * (при старте сервера и при необходимости вручную). Кэш результата детекта по пути см. в `flibusta-sidecar.js`.
 *
 * Реализация чтения обложек/портретов/био/отзывов — в `./flibusta-sidecar.js` и маршрутах в `server.js`.
 */
export {
  detectFlibustaSidecarLayout,
  syncAllSourcesFlibustaFlag,
  clearFlibustaLayoutCache
} from './flibusta-sidecar.js';
