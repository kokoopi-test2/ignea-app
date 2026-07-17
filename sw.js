/* ÍGNEA service worker — installable PWA + offline app shell.
 *
 * Scope: the UI shell, INCLUDING the in-webview offline fire engine (engine-offline.js). Online
 * predictions (/api/*) are always network; the offline engine runs entirely in the shell, so once
 * the shell is cached a prediction works with no server and no network (weather/terrain degrade to
 * built-in fallbacks). Bump CACHE on any shell change so clients never get stuck on a stale version.
 */
const CACHE = "ignea-shell-v37";
const TILE_CACHE = "ignea-tiles-v1";   // basemap tiles, so viewed areas render offline
const TILE_LIMIT = 800;                // cap tiles kept (rough FIFO trim) to bound disk use
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "engine-offline.js",
  "data/worldcover_biome.png",         // bundled global fuel baseline (offline per-cell fuel)
  "data/worldcover_biome.json",
  "vendor/maplibre-gl.js",
  "vendor/maplibre-gl.css",
  "vendor/pmtiles.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isTile(url) {
  return url.hostname.endsWith("tile.openstreetmap.org") || /\/\d+\/\d+\/\d+\.png$/.test(url.pathname);
}

async function trimCache(name, limit) {
  const c = await caches.open(name);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - limit; i++) await c.delete(keys[i]);  // rough FIFO
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Predictions are dynamic — always network, never cached.
  if (url.pathname.startsWith("/api/")) return;

  // Basemap tiles (cross-origin): cache-first so already-viewed areas render offline.
  if (isTile(url)) {
    e.respondWith(
      caches.open(TILE_CACHE).then((c) =>
        c.match(e.request).then((hit) =>
          hit || fetch(e.request).then((res) => {
            c.put(e.request, res.clone());
            trimCache(TILE_CACHE, TILE_LIMIT);
            return res;
          }).catch(() => hit)
        ))
    );
    return;
  }

  // Other cross-origin: straight to network.
  if (url.origin !== self.location.origin) return;

  // App shell: cache-first, fall back to network and cache the response for next time.
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
