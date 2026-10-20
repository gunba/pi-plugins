const CACHE = "pi-desk-shell-v4";
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(["/", "/icon.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys =>
    Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))]));
});
// The app's page and its versioned files open from the cache at once and are refreshed in the background for next
// time: on a slow link (a plane), waiting on the network first held the page back for tens of seconds. Anything not
// cached yet, and everything else, goes to the network; the cache answers only when the network cannot.
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") ||
      url.pathname === "/desk-account.json" || event.request.method !== "GET") return;
  const navigate = event.request.mode === "navigate", shell = navigate || url.pathname === "/" || url.pathname.startsWith("/assets/");
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), key = navigate ? "/" : event.request;
    const network = fetch(event.request).then(response => {
      if (response.ok && shell) event.waitUntil(cache.put(key, response.clone()));
      return response;
    });
    const cached = shell ? await cache.match(key) : undefined;
    if (cached) { event.waitUntil(network.catch(() => {})); return cached; }
    try { return await network; }
    catch { return (await cache.match(key)) ?? (navigate ? await cache.match("/") : undefined) ?? new Response("Offline", { status: 503 }); }
  })());
});
