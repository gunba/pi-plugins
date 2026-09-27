const CACHE = "pi-desk-shell-v1";
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(["/", "/icon.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys =>
    Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))]));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/desk-transport.json" || event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) ??
    (event.request.mode === "navigate" ? await caches.match("/") : undefined) ??
    new Response("Offline", { status: 503 })));
});
