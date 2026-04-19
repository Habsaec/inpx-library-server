# INPX Library Server

Домашний веб-сервер для электронных библиотек: каталогизация, чтение в браузере, скачивание, конвертация и отправка на читалку по почте.

---

## Возможности

### Каталог и поиск
- Полнотекстовый поиск по авторам, названиям, сериям, жанрам и ключевым словам
- Навигация: по авторам, сериям, жанрам, языкам — с фильтрацией по букве и сортировкой
- Карточка книги: обложка, аннотация, метаданные, похожие книги
- 60+ жанров с русскими названиями и автоматическими переводами

### Форматы и источники
- **Книги:** FB2, EPUB, MOBI, AZW3
- **Архивы:** ZIP, 7z (в том числе пары `*.inpx` + `*.zip` / `*.7z`)
- **Источники:** каталог INPX, папка с файлами — несколько источников одновременно
- Инкрементальная и полная переиндексация; планировщик автоматических сканирований

### Чтение в браузере
- HTML5-читалка для FB2 и EPUB с адаптивной вёрсткой
- Темы оформления, настройка шрифтов
- Закладки на страницах и сохранение позиции чтения
- Озвучка текста (TTS) — удобно на мобильных
- История чтения и раздел «Продолжить»

### Персонализация
- Избранные книги, авторы и серии
- Пользовательские полки (коллекции) с возможностью скачивания целиком
- Персональные рекомендации на главной

### Скачивание и конвертация
- Скачивание отдельных книг и пакетная выгрузка в ZIP (по автору, серии, полке, списку)
- Конвертация FB2 → EPUB, EPUB3, KEPUB, KFX, AZW8 (через [fb2cng](https://github.com/rupor-github/fb2cng))
- Кэш конвертированных файлов

### Отправка на читалку
- Отправка книг на e-reader (Kindle, PocketBook, Kobo и др.) по email
- Поддержка одиночной и пакетной отправки с выбором формата
- Настройка SMTP в админ-панели с проверкой подключения

### OPDS-каталог
- Полноценный OPDS 1.x фид (`/opds`) для приложений-читалок
- Совместим с KOReader, Moon+ Reader, Librera, FBReader и др.
- Поиск по авторам, сериям, названиям, жанрам; OpenSearch
- Аутентификация Basic Auth

### Flibusta / FLibrary sidecar
- Автоопределение sidecar-раскладки рядом с библиотекой
- Обложки из `covers/*.zip|7z`, включая формат JXL
- Рецензии, биографии авторов, портреты, иллюстрации
- Кэш обложек с ограничением по памяти

### Администрирование
- **Операции:** статус индексации (пауза/возобновление/остановка), статистика, кэш
- **Источники:** добавление, включение/отключение, переиндексация, удаление
- **Пользователи:** создание, роли (admin/user), блокировка, регистрация, reCAPTCHA
- **Почта (SMTP):** настройка и проверка подключения
- **Дубликаты:** просмотр групп, ручное удаление, автоочистка с предпросмотром
- **Подавленные книги:** удалённые книги не возвращаются при переиндексации; можно восстановить
- **Языки:** фильтрация книг по языкам
- **События:** журнал действий с фильтрами и SSE-стримингом в реальном времени
- **Логи:** просмотр и скачивание runtime-логов
- **Резервная копия:** скачивание БД и экспорт настроек
- **Обновление:** загрузка ZIP-архива с новой версией прямо из браузера
- **Sidecar:** перестройка индексов Flibusta/FLibrary
- **Редактирование метаданных:** изменение названия, авторов, серии прямо из карточки книги

### Безопасность
- Cookie-сессии (httpOnly, sameSite) с автогенерацией секрета
- Ограничение попыток входа (rate limiting по IP)
- CSRF-защита всех форм
- Шифрование SMTP-пароля в БД (AES-256-GCM)
- Анонимный доступ настраивается раздельно: просмотр, скачивание, OPDS

### Прочее
- Интерфейс на русском и английском (переключатель RU · EN)
- Анимированный индикатор загрузки на всех страницах
- Кэш обложек-миниатюр (WebP, два уровня: память + диск)
- Кластерный режим (`CLUSTER_WORKERS=N`)
- Health-проверки: `/health`, `/ready`, `/api/index-status`

---

## Установка

### Требования

- **Node.js 18+** (установщики скачают автоматически, если не найден)
- Папка с книгами или архивами библиотеки

---

### Windows

1. Скачайте [релиз](https://github.com/nicklvsa/inpx-library-server/releases) или клонируйте репозиторий.
2. Запустите **`install.cmd`** — скачает портативный Node.js 20 и установит зависимости.
3. Запуск: **`start-server.cmd`**. Остановка: **`stop-server.cmd`**. Перезапуск: **`restart-server.cmd`**.

Откройте **http://localhost:3000**. Первый вход: **admin / admin** — сразу смените пароль.

---

### Linux (Debian / Ubuntu / Raspbian / OpenMediaVault)

```bash
cd /путь/к/проекту
chmod +x install.sh start.sh stop.sh restart.sh
sudo ./install.sh      # установит Node.js, зависимости; предложит systemd
./start.sh             # запуск сервера
```

Скрипт поддерживает: Debian 11+, Ubuntu 20.04+, Raspbian, OpenMediaVault 6/7/8.

**systemd** (если настроили при установке):

```bash
sudo systemctl start inpx-library
sudo systemctl status inpx-library
sudo journalctl -u inpx-library -f
```

---

### macOS

```bash
chmod +x install.sh start.sh
sudo ./install.sh     # потребуются Xcode Command Line Tools и Homebrew/Node
./start.sh
```

Нужны [Command Line Tools](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools). Node.js — через [nodejs.org](https://nodejs.org) (LTS .pkg) или Homebrew (`brew install node`).

---

### Docker (CLI)

```bash
docker build -t inpx-library .

docker run -d \
  --name inpx-library \
  --restart unless-stopped \
  -p 3000:3000 \
  -v inpx-app:/app \
  -v inpx-data:/app/data \
  -v /путь/к/библиотеке:/library:ro \
  inpx-library
```

**Дополнительные источники книг** (папки с EPUB, FB2 и т.д.):

```bash
-v /путь/к/epub:/sources/epub:ro
-v /путь/к/pdf:/sources/pdf:ro
```

Затем в админке: **Источники → Добавить → тип «Папка» → путь `/sources/epub`**.

---

### Docker Compose

Отредактируйте пути к томам в `docker-compose.yml`:

```yaml
services:
  library:
    build: .
    container_name: inpx-library
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - app-code:/app
      - app-data:/app/data
      - /путь/к/библиотеке:/library:ro
      # Доп. источники:
      # - /home/user/books:/sources/books:ro
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

> **Внимание:** `docker compose down -v` удалит данные в именованных томах.

---

### Synology NAS (Container Manager)

#### Вариант 1: через Docker Compose (рекомендуется)

1. Откройте **Container Manager → Проект → Создать**.
2. Укажите имя (например `inpx-library`), путь — папка с файлами проекта.
3. Вставьте содержимое `docker-compose.yml` (или загрузите файл), отредактируйте тома:

```yaml
services:
  library:
    build: .
    container_name: inpx-library
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - app-code:/app
      # Bind-mount в видимую папку File Station (для удобства бэкапов БД):
      - /volume1/docker/inpx-library-data:/app/data
      # Папка с книгами (только чтение):
      - /volume1/books/library:/library:ro
      # Доп. источники:
      # - /volume1/homes/username:/sources/home:ro
    environment:
      - PORT=3000
      - LIBRARY_ROOT=/library

volumes:
  app-code:
```

4. Нажмите **Применить** → Container Manager соберёт образ и запустит контейнер.
5. Откройте **http://IP-адрес-NAS:3000**, войдите как **admin / admin**.

> **Совет:** используйте bind-mount для `/app/data` (`/volume1/docker/inpx-library-data`) — тогда БД и кэш видны в File Station, легко делать резервные копии.

> Папку `inpx-library-data` нужно создать заранее через SSH:
> ```bash
> mkdir -p /volume1/docker/inpx-library-data
> ```

#### Вариант 2: ручная настройка контейнера

1. **Container Manager → Образ → Создать** из Dockerfile (или соберите на другой машине и загрузите `.tar`).
2. **Контейнер → Создать:**
   - Порт: `3000` → `3000`
   - Тома:
     - `/volume1/docker/inpx-library-data` → `/app/data`
     - `/volume1/books` → `/library` (только чтение)
   - Переменные среды: `PORT=3000`, `LIBRARY_ROOT=/library`
3. Запустите контейнер.

#### Примечания для Synology

- Healthcheck использует `curl` (не Node) — на слабых NAS проверка через Node.js часто превышает таймаут.
- Образ поддерживает архитектуры **amd64** и **arm64** (DS220+, DS920+, DS923+, DS224+ и т.д.).
- Именованные тома не всегда видны в UI Container Manager → SSH: `docker volume ls`.
- При обновлении: пересоберите образ → Container Manager обновит код, данные в `/app/data` сохранятся.

---

## После установки

1. В **админке** добавьте **источник** — путь к папке с `.inpx`/архивами или каталог с файлами книг.
2. Дождитесь индексации (от минуты до ~45 минут при большой библиотеке).
3. Язык интерфейса — переключатель **RU · EN** в шапке.
4. **SMTP** для отправки на ридер — раздел «Почта» в админке.
5. Резервная копия БД — админка → Операции → «Скачать бэкап» (или файл `data/library.db`).

---

## Переменные окружения

Все настройки задаются через `.env` (шаблон — `.env.example`) или переменные окружения.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт сервера |
| `LIBRARY_ROOT` | `/library` | Путь к папке с книгами |
| `INPX_FILE` | — | Путь к .inpx (иначе задаётся в админке) |
| `SESSION_SECRET` | автогенерация | Секрет подписи cookie (≥16 символов или автогенерация в `data/.session-secret`) |
| `SESSION_SECURE_COOKIE` | `false` | `true` для HTTPS (Secure флаг cookie) |
| `SESSION_MAX_AGE_MS` | `1209600000` | Время жизни сессии (14 дней) |
| `LOGIN_WINDOW_MS` | `900000` | Окно для подсчёта попыток входа (15 мин) |
| `LOGIN_MAX_ATTEMPTS` | `10` | Макс. неудачных попыток в окне |
| `TRUST_PROXY` | `false` | `true` за обратным прокси (nginx, Caddy) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | — | SMTP-сервер для отправки на читалку |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | — | Учётные данные SMTP |
| `FB2CNG_PATH` | `./converter/fbc` | Путь к бинарнику fb2cng |
| `FB2CNG_CONFIG_PATH` | `./converter/fb2cng.yaml` | Конфиг fb2cng |
| `SEVEN_ZIP_PATH` | npm `7zip-bin` | Путь к 7z/7za для .7z архивов |
| `COVER_MAX_WIDTH` | `220` | Макс. ширина миниатюры обложки (px) |
| `COVER_MAX_HEIGHT` | `320` | Макс. высота миниатюры обложки (px) |
| `COVER_QUALITY` | `86` | Качество WebP-миниатюры (1–100) |
| `SCAN_INTERVAL_HOURS` | `0` | Автосканирование каждые N часов (0 = выключено) |
| `EVENTS_STDOUT` | `true` | Дублировать события в stdout (удобно для `docker logs`) |
| `HEALTH_MINIMAL` | `false` | Минимальный ответ `/health` (без порта) |
| `CLUSTER_WORKERS` | `0` | Кол-во воркеров кластера (0 = без кластера) |

---

## Устранение неполадок

- **Сервер не отвечает:** проверьте `curl -sS http://127.0.0.1:3000/health` — в ответе должно быть `"ok":true`.
- **Порт занят:** измените `PORT` в `.env` или переменной окружения.
- **Медленная первая загрузка:** во время индексации сервер может отвечать с задержкой — это нормально.
- **Книги не появляются:** убедитесь, что источник добавлен и индексация завершена (проверьте статус в админке).
- **Конвертация не работает:** fb2cng устанавливается автоматически скриптом `install.sh`/`install.cmd`. Проверьте наличие `converter/fbc` (или `fbc.exe`).
- **Сброс пароля:** `reset-admin.cmd` (Windows) или `./reset-admin.sh` (Linux/macOS).

---

## Развёртывание в продакшене

Подробный чеклист: **[DEPLOY.md](DEPLOY.md)** — HTTPS, обратный прокси, безопасность cookie.

---

## OPDS

Адрес: `/opds`. Аутентификация — Basic Auth (логин/пароль пользователя). Подходит для KOReader, Moon+ Reader, Librera, FBReader.

Анонимный OPDS-доступ можно включить в админке → Пользователи → «Анонимный доступ».

---

## API

JSON-ответы с ошибками содержат стабильное поле `code` (например `UNAUTHORIZED`, `BATCH_NO_BOOKS`) и локализованное `error`. Клиентам следует ориентироваться на `code`.

---

## Лицензия

**[MIT](LICENSE)**
