// Impeccable 5.2 service worker: everything is cached so the app works offline.
// Bump CACHE when you publish changes so installed copies pick them up.
const CACHE = "impeccable-5.2.0";
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest",
  "./fonts/vt323-latin.woff2", "./fonts/vt323-latin-ext.woff2",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from cache at once, refresh the cache in the background.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const key = req.mode === "navigate" ? "./index.html" : req;
      const hit = await cache.match(key, { ignoreSearch: true });
      const fresh = fetch(req).then((res) => {
        if (res.ok && req.mode !== "navigate") cache.put(req, res.clone());
        if (res.ok && req.mode === "navigate") cache.put("./index.html", res.clone());
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});
