// Офлайн-поддержка. При изменении файлов приложения увеличьте номер версии:
// новый кэш заполнится заново, а старые будут удалены при активации.
const CACHE_VERSION = "v3-11";
const CACHE_NAME = `fuelwisev3-${CACHE_VERSION}`;
// Префикс отделён от исходного приложения: очистка V2 не затрагивает его кэш.
const CACHE_PREFIX = "fuelwisev3-";

const PRECACHE_URLS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/style.css",
  "js/app.js",
  "js/ui.js",
  "js/map.js",
  "js/calculations.js",
  "js/validation.js",
  "js/optimizer.js",
  "js/mapTiles.js",
  "js/storage.js",
  "js/services/demoDataLoader.js",
  "js/services/geocodingService.js",
  "js/services/routingService.js",
  "js/services/fuelStationsService.js",
  "js/services/stationsApiConfig.js",
  "js/services/liveFuelStationsService.live.js",
  "js/moscowStationsMap.live.js",
  "data/demo-data.json",
  "data/demo-data.fallback.js",
  "data/moscow-stations.snapshot.json",
  "data/moscow-stations.snapshot.fallback.js",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // Перечитываем файлы с сервера при каждой версии кэша, минуя HTTP-кэш браузера.
      .then((cache) => cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Сначала сеть, затем кэш: так правки страницы и демо-данных видны сразу.
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) {
      return cached;
    }
    if (request.mode === "navigate") {
      return cache.match("index.html");
    }
    throw error;
  }
}

// Сначала кэш: статические файлы обновляются вместе с версией кэша.
async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  return cached ?? fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  const isFreshDataNeeded = request.mode === "navigate" || url.pathname.endsWith("/data/demo-data.json");
  event.respondWith(isFreshDataNeeded ? networkFirst(request) : cacheFirst(request));
});
