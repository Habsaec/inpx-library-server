/**
 * Service Worker — cache-first for static assets, network-first for everything else.
 */
// IMPORTANT: Bump this version when deploying new assets to invalidate browser caches
const CACHE_VERSION = 4;
const CACHE_NAME = `inpx-v1-ecb07a15`;
const COVER_CACHE_NAME = 'inpx-covers-v1';
const MAX_COVER_CACHE_ENTRIES = 500;

const STATIC_ASSETS = [
  '/styles.css',
  '/styles.min.css',
  '/app.js',
  '/app.min.js',
  '/reader.css',
  '/reader.js',
  '/position-sync.js',
  '/reader-shared/position-revision.js',
  '/reader-shared/reader-position.js',
  '/reader-shared/suppression-counter.js',
  '/logo.png',
  '/favicon.png',
  '/favicon-192.png',
  '/favicon-512.png',
  '/book-fallback.png'
];

// `cache: 'reload'` — мимо HTTP-кэша браузера. Старые версии сервера отдавали
// JS/CSS с `immutable, max-age=365d`; обычный addAll брал оттуда протухший
// position-sync.js, и новый reader.js падал на импорте («Загрузка книги…» навечно).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME && k !== COVER_CACHE_NAME).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    // Delete oldest entries (first in list = oldest)
    for (let i = 0; i < keys.length - maxEntries; i++) {
      await cache.delete(keys[i]);
    }
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests (e.g. Google Fonts)
  if (url.origin !== self.location.origin) return;

  // Static assets: network-first (сервер отдаёт их с `no-cache` → дешёвый 304),
  // кэш SW — только офлайн-фолбэк. `cache: 'no-cache'` заставляет браузер
  // ревалидировать даже записи HTTP-кэша с устаревшим `immutable`, иначе
  // reader.js?v=new импортировал бы старый position-sync.js и не открывал книгу.
  if (STATIC_ASSETS.some((a) => url.pathname === a)) {
    event.respondWith((async () => {
      try {
        const resp = await fetch(new Request(event.request, { cache: 'no-cache' }));
        if (resp.ok) {
          const clone = resp.clone();
          const normalizedUrl = new URL(event.request.url);
          normalizedUrl.search = '';
          event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(new Request(normalizedUrl.href), clone)));
        }
        return resp;
      } catch {
        const cached = await caches.match(event.request, { ignoreSearch: true });
        return cached || Response.error();
      }
    })());
    return;
  }

  // Cover images: cache-first with size limit (separate cache)
  if (url.pathname.includes('/cover')) {
    event.respondWith(
      caches.match(event.request, { cacheName: COVER_CACHE_NAME, ignoreSearch: true }).then((cached) => cached || fetch(event.request).then((resp) => {
        if (resp.ok && resp.headers.get('content-type')?.startsWith('image/')) {
          const clone = resp.clone();
          caches.open(COVER_CACHE_NAME).then((c) => {
            c.put(event.request, clone);
            trimCache(COVER_CACHE_NAME, MAX_COVER_CACHE_ENTRIES);
          });
        }
        return resp;
      }))
    );
    return;
  }

  // Everything else: network-first
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
