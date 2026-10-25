<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="INPX Library Server — self-hosted ebook library: search, browser reading, OPDS, send to device">
</p>

<p align="center">
  <a href="https://github.com/Habsaec/inpx-library-server/releases/latest"><img src="https://img.shields.io/github/v/release/Habsaec/inpx-library-server?style=flat-square&labelColor=1e1a16&color=a1671b&label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-d4ac5c?style=flat-square&labelColor=1e1a16" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-9a8e7e?style=flat-square&labelColor=1e1a16" alt="Node.js 20+">
  <a href="https://hub.docker.com/r/habsaec/inpx-library-server"><img src="https://img.shields.io/badge/docker-amd64%20%7C%20arm64-7a5a28?style=flat-square&labelColor=1e1a16" alt="Docker amd64 / arm64"></a>
  <img src="https://img.shields.io/badge/OPDS-1.x%20%7C%202-3d4a5c?style=flat-square&labelColor=1e1a16" alt="OPDS 1.x / 2">
</p>

<p align="center">
  <a href="#быстрый-старт">Быстрый старт</a> ·
  <a href="#возможности">Возможности</a> ·
  <a href="#android-приложение">Android</a> ·
  <a href="#opds-и-koreader">OPDS</a> ·
  <a href="#настройка">Настройка</a> ·
  <a href="CHANGELOG.md">Изменения</a>
</p>

**INPX Library Server** — self-hosted библиотека электронных книг для коллекций INPX/FB2 (Флибуста, Либрусек и любые свои папки). Каталог с полнотекстовым поиском, чтение в браузере, OPDS для KOReader, отправка на Kindle/Kobo и в Telegram, синхронизация с [Android-приложением](https://github.com/Habsaec/inpx-book-reader). Работает на NAS, Raspberry Pi и обычном ПК и рассчитан на библиотеки в сотни тысяч книг.

---

<p align="center">
  <img src="./assets/readme/features.svg" width="100%" alt="Capabilities: Search, Reader, Delivery, Clients">
</p>

## Возможности

### Каталог и поиск

- Полнотекстовый поиск (SQLite FTS5) со стеммингом, подсказками при вводе, исправлением опечаток и «Возможно, вы искали»
- Авторы, серии, жанры, языки; фильтры по жанру (И / ИЛИ), языку, формату, году, рейтингу, наличию серии
- Страница автора в стиле Флибусты: серии, межавторские серии, книги вне серий, портрет и биография
- Новинки по дате INPX, персональные рекомендации, похожие книги
- Обложки или компактный список; выбор нескольких книг для скачивания и отправки

### Чтение

- Читалка в браузере для FB2 и EPUB: темы, шрифты, закладки, заметки с цветами, озвучка (TTS)
- Позиция чтения синхронизируется между браузером, Android-приложением и устройствами — без «прыжков»: при конфликте читалка спрашивает, где продолжить
- Экспорт заметок в Markdown / HTML или на почту ридера

### Личная библиотека

- «Продолжить чтение», «Хочу прочитать», «Прочитано», «Мои оценки»
- Избранные авторы и серии, раздел «Новое у любимых»
- Обычные и **умные полки** (сохранённый фильтр каталога), закрепление полок на главной
- Прогресс серии («Прочитано 3 из 8 · Читать следующую»), отметка «прочитано до тома N»
- Цель на год и статистика чтения, импорт из Goodreads / LiveLib (CSV)
- Скрытие прочитанного, свой набор языков, формат скачивания по умолчанию

### Выдача книг

- FB2, FB2.ZIP, EPUB, MOBI, AZW3; пакетный ZIP
- Конвертация через [fb2cng](https://github.com/rupor-github/fb2cng)
- Отправка на e-mail ридера (Kindle, PocketBook, Kobo) и в Telegram; Telegram-бот с поиском и еженедельной сводкой
- OPDS 1.x / 2 с прогрессом чтения, синхронизация позиции с KOReader (KOSync)

### Источники

- INPX-коллекции (ZIP / 7z, в т.ч. PPMd) и обычные папки с FB2 / EPUB / MOBI / AZW3
- Несколько источников одновременно, автоматическая чистка дубликатов
- Слежение за папками: новые файлы индексируются сами
- Sidecar Флибусты / FLibrary: обложки, иллюстрации (JPEG XL, WebP), рецензии, биографии, портреты авторов
- Пересоздание индекса и удаление источника не теряют закладки, позиции и полки пользователей

### Администрирование

- Источники и индексация с журналом, пользователи и права, анонимный доступ
- SMTP, Telegram-бот, вход через OIDC / SSO (Authentik и совместимые)
- Оформление: логотип, шапка, фон, палитра с проверкой контрастности, 3D-обложки
- Мониторинг, журналы, бэкап базы и пользователей, обновление из ZIP

Интерфейс **RU · EN**, светлая, тёмная и автоматическая тема. Кластерный режим и health-checks (`/health`, `/ready`) для продакшена.

---

<p align="center">
  <img src="./assets/readme/architecture.svg" width="100%" alt="Architecture: sources to SQLite index to Web, OPDS, Android">
</p>

Метаданные книг живут в одном SQLite-индексе и отдаются через `/api/*` — один контракт для веба, OPDS, Telegram и Android-приложения.

---

## Быстрый старт

Нужна папка с книгами: `.inpx` + архивы `.zip` / `.7z` или каталог с FB2 / EPUB.

### Docker

```bash
docker run -d \
  --name inpx-library \
  --restart unless-stopped \
  -p 3000:3000 \
  -v inpx-app:/app \
  -v inpx-data:/app/data \
  -v /path/to/library:/library:ro \
  -e LIBRARY_ROOT=/library \
  habsaec/inpx-library-server:latest
```

Откройте http://localhost:3000 → войдите как **admin / admin** и сразу смените пароль.

Дополнительные источники монтируйте в `/sources/*` (`-v /path/to/epub:/sources/epub:ro`) и добавляйте в админке: **Источники → Добавить → «Папка»**.

<details>
<summary><strong>Docker Compose</strong></summary>

```yaml
services:
  library:
    image: habsaec/inpx-library-server:latest
    container_name: inpx-library
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - app-code:/app
      - app-data:/app/data
      - /path/to/library:/library:ro
    environment:
      - PORT=3000
      - LIBRARY_ROOT=/library

volumes:
  app-code:
  app-data:
```

```bash
docker compose up -d
```

`docker compose down -v` удалит данные в именованных томах.
</details>

<details>
<summary><strong>Synology NAS (Container Manager)</strong></summary>

В репозитории есть готовый [`docker-compose.yml`](docker-compose.yml) под Synology: порт **3000**, данные в `/volume1/docker/inpx-library-data`.

1. Создайте папку данных: `mkdir -p /volume1/docker/inpx-library-data`
2. В compose раскомментируйте том с книгами, например `- /volume1/books/library:/library:ro`
3. **Container Manager → Проект → Создать**, укажите папку с `docker-compose.yml` → **Применить**
4. Откройте `http://NAS-IP:3000` → **admin / admin**

Образ собран для **amd64** и **arm64**. Healthcheck идёт через `curl`: на слабых NAS проверка через Node не укладывается в таймаут.
</details>

<details>
<summary><strong>Сборка образа из исходников</strong></summary>

```bash
docker build -t inpx-library .
docker run -d --name inpx-library -p 3000:3000 \
  -v inpx-data:/app/data \
  -v /path/to/library:/library:ro \
  -e LIBRARY_ROOT=/library \
  inpx-library
```
</details>

### Windows

1. Скачайте [последний релиз](https://github.com/Habsaec/inpx-library-server/releases/latest) и распакуйте (или `git clone https://github.com/Habsaec/inpx-library-server.git`).
2. Запустите **`install.cmd`** — он скачает портативный Node.js 24 и установит зависимости вместе с конвертером.
3. При желании создайте `.env` из [`.env.example`](.env.example) и укажите путь к книгам: `LIBRARY_ROOT=D:\Books`.
4. Запустите **`start-server.cmd`** и откройте http://localhost:3000.

Остановка — `stop-server.cmd`, перезапуск — `restart-server.cmd`.

### Linux (Debian / Ubuntu / Raspberry Pi OS / OpenMediaVault)

```bash
git clone https://github.com/Habsaec/inpx-library-server.git
cd inpx-library-server
chmod +x install.sh start.sh stop.sh restart.sh
sudo ./install.sh    # Node.js, зависимости; предложит службу systemd
./start.sh
```

```bash
sudo systemctl status inpx-library     # если служба установлена
sudo journalctl -u inpx-library -f
```

### macOS

```bash
chmod +x install.sh start.sh
sudo ./install.sh    # нужны Xcode Command Line Tools и Node.js 20+
./start.sh
```

---

## Первые шаги

1. Войдите как **admin / admin** и смените пароль в профиле.
2. **Админка → Источники → Добавить**: папка с `.inpx` и архивами или каталог с книгами.
3. Дождитесь индексации — от минут до ~45 минут на полной Флибусте. Ход виден в админке.
4. Создайте пользователей или включите **Админка → Пользователи → «Анонимный доступ»**.
5. Для отправки на ридер настройте **Админка → Почта**, для Telegram — **Админка → Telegram-бот**.
6. Бэкап: **Админка → Резервные копии и обновление → «Скачать бэкап БД»** или файл `data/library.db`.

**За HTTPS / reverse proxy** (nginx, Caddy, Traefik): `TRUST_PROXY=1` и `SESSION_SECURE_COOKIE=true`.

---

## Android-приложение

[**INPX Book Reader**](https://github.com/Habsaec/inpx-book-reader) — читалка для Android, работающая с этим сервером: каталог, офлайн-полка, озвучка, режим для E-Ink и синхронизация позиции, закладок и заметок с веб-читалкой.

- APK: [последний релиз](https://github.com/Habsaec/inpx-book-reader/releases/latest) — или QR-код в боковой панели веб-интерфейса.
- Вход без ввода пароля: в том же окне сервер показывает одноразовый QR-код (10 минут), который сканирует приложение.

---

## OPDS и KOReader

**OPDS:** `http://<сервер>:3000/opds` (OPDS 2 — `/opds/v2`). Вход — логин и пароль пользователя библиотеки (Basic Auth). Подходит для KOReader, FBReader, Moon+ Reader, Librera. У начатых книг в названии виден прогресс: ◔ ◑ ◕ ⬤. Анонимный OPDS включается в **Админка → Пользователи**.

**KOSync (синхронизация прогресса KOReader):**

1. **Профиль → «KOReader: синхронизация прогресса»**: создайте отдельный пароль для KOReader (пароль аккаунта не используется).
2. В KOReader: **Облако → Синхронизация прогресса → Свой сервер** → `http://<сервер>:3000/kosync`, логин библиотеки и созданный пароль.
3. Скачайте книгу через сервер хотя бы раз — так сервер узнаёт её в KOReader.

---

## Настройка

Все переменные с комментариями — в [`.env.example`](.env.example). Большинство параметров (SMTP, Telegram, OIDC, оформление, память базы, слежение за папками) удобнее менять в админке; переменные окружения задают значения по умолчанию.

<details>
<summary><strong>Основные переменные окружения</strong></summary>

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт сервера |
| `LIBRARY_ROOT` | `/library` | Папка с книгами (на Windows — свой путь, например `D:\Books`) |
| `INPX_FILE` | — | Путь к `.inpx` (иначе задаётся в админке) |
| `SESSION_SECRET` | авто | Секрет cookie (≥16 символов, иначе создаётся `data/.session-secret`) |
| `SESSION_SECURE_COOKIE` | `false` | `true` за HTTPS |
| `SESSION_MAX_AGE_MS` | `1209600000` | Время жизни сессии (14 дней) |
| `TRUST_PROXY` | `false` | Прокси перед сервером: `1` — один nginx / Caddy, `loopback` или список подсетей; `true` — доверять любому (IP можно подделать) |
| `LOGIN_WINDOW_MS` / `LOGIN_MAX_ATTEMPTS` | `900000` / `10` | Ограничение попыток входа |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | — | SMTP для отправки на ридер |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | Учётные данные SMTP |
| `TELEGRAM_BOT_TOKEN` | — | Токен Telegram-бота (или в админке) |
| `FB2CNG_PATH` | `./converter/fbc` | Конвертер fb2cng |
| `FB2CNG_CONFIG_PATH` | `./converter/fb2cng.yaml` | Конфиг конвертера |
| `SEVEN_ZIP_PATH` | из `7zip-bin` | Путь к 7z |
| `SCAN_INTERVAL_HOURS` | `0` | Автоскан источников каждые N часов (0 — выкл.) |
| `FOLDER_WATCH` | `1` | Слежение за папочными источниками (`0` — выкл.) |
| `FOLDER_WATCH_QUIET_SEC` | `120` | Пауза без изменений перед индексацией, с |
| `COVER_MAX_WIDTH` / `COVER_MAX_HEIGHT` | `220` / `320` | Размер миниатюр обложек |
| `COVER_QUALITY` | `86` | Качество WebP-миниатюр |
| `COVER_THUMB_DISK_TTL_DAYS` | `30` | Срок хранения миниатюр на диске |
| `COVER_THUMB_DISK_CACHE_MB` | `2048` | Лимит дискового кэша миниатюр |
| `DOWNLOAD_MAX_CONCURRENT` | `4` | Сколько книг готовится к выдаче одновременно |
| `DOWNLOAD_MAX_QUEUE` | `100` | Очередь скачиваний; сверх неё — `503` с `Retry-After` |
| `DOWNLOAD_QUEUE_TIMEOUT_MS` | `120000` | Сколько скачивание ждёт в очереди |
| `SQLITE_CACHE_SIZE_MB` / `SQLITE_MMAP_SIZE_MB` | авто | Память SQLite (можно задать в админке) |
| `PERF_PROFILE` | авто | `default` или `embedded` для NAS / малой памяти |
| `CLUSTER_WORKERS` | `0` | Число воркеров кластера (0 — один процесс) |
| `EVENTS_STDOUT` | `true` | События в stdout (`docker logs`) |
| `HEALTH_MINIMAL` | `false` | Минимальный ответ `/health` |

</details>

<details>
<summary><strong>Большие библиотеки и слабое железо</strong></summary>

- Индексация, подсчёт счётчиков каталога и декодирование иллюстраций идут в фоновых потоках — сервер отвечает во время импорта.
- На устройствах с ≤ 2 ГБ памяти включается экономный профиль; подстроить кэш SQLite можно в **Админка → Обслуживание → Память базы данных**.
- Флибуста и Либрусек «96 ГБ» (PPMd-архивы, WebP-картинки) поддерживаются; для старых ридеров включите **Админка → Контент → WebP в FB2 → PNG**.
- При добавлении второй копии той же коллекции используйте **Админка → Дубликаты → Автоочистка**.
- Если сервер «подвисает», первым делом смотрите строки `[perf] event loop stalled` в `runtime.log` и `/health/perf`.

</details>

<details>
<summary><strong>Устранение неполадок</strong></summary>

- **Не отвечает:** `curl -sS http://127.0.0.1:3000/health` должен вернуть `"ok":true`.
- **Порт занят:** смените `PORT` в `.env` или проброс порта в Docker.
- **Нет книг:** источник добавлен в админке, индексация завершилась, путь смонтирован внутрь контейнера?
- **«Архивы не найдены» после импорта INPX:** проверьте путь и монтирование папки с архивами.
- **Windows, пустой каталог:** проверьте `LIBRARY_ROOT` в `.env`.
- **Нет конвертации в EPUB/MOBI:** после установки должен быть `converter/fbc` (`fbc.exe` на Windows).
- **Ошибка `better-sqlite3` / `NODE_MODULE_VERSION`:** повторно запустите `install.cmd` / `install.sh`.
- **Забыли пароль admin:** `reset-admin.cmd` (Windows) или `./reset-admin.sh`.

</details>

---

## Для разработчиков

```bash
npm install
npm run dev      # сервер с перезапуском при изменениях
npm test
```

Стек: Node.js (ESM), Express, SQLite (better-sqlite3), vanilla JS/CSS без фреймворков.

- [`AGENTS.md`](AGENTS.md) — контракт API для Android-приложения и правила проекта
- [`docs/architecture`](docs/architecture) — индексация, парсер INPX, поиск, OPDS, структура проекта
- [`docs/decisions`](docs/decisions) — архитектурные решения
- [`CHANGELOG.md`](CHANGELOG.md) — история изменений

JSON-ошибки API содержат стабильное поле `code` (например `UNAUTHORIZED`) и локализованное `error` — клиентам стоит опираться на `code`.

## Связанные проекты

| Репозиторий | Роль |
|---|---|
| [inpx-library-server](https://github.com/Habsaec/inpx-library-server) | Сервер: индекс, веб, OPDS, API (этот репозиторий) |
| [inpx-book-reader](https://github.com/Habsaec/inpx-book-reader) | Android-приложение |

## Лицензия

[MIT](LICENSE)
