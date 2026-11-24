// При изменении ресурсов увеличьте версию оболочки.
const CACHE_PREFIX = "fuelwise-v5:" + self.registration.scope + ":";
const CACHE_NAME = CACHE_PREFIX + "7";

const PRECACHE_URLS = [
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
  "js/fuels.js",
  "js/services/requestQueue.js",
  "js/services/geocodingService.js",
  "js/services/routingService.js",
  "js/services/fuelStationsService.js",
  "js/services/stationsApiConfig.js",
  "js/services/liveFuelStationsService.live.js",
  "js/moscowStationsMap.live.js",
  "data/moscow-stations.snapshot.fallback.js",
  "vendor/leaflet/leaflet.js",
  "vendor/leaflet/leaflet.css",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" }))),
  ));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)),
  )));
});

const scope = self.registration.scope;
const assets = new Set(PRECACHE_URLS.map((path) => new URL(path, scope).href));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  url.search = "";
  if (url.href === scope && event.request.mode === "navigate") url.pathname += "index.html";
  if (!assets.has(url.href)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async (cache) =>
    (await cache.match(url.href)) ?? fetch(event.request),
  ));
});
