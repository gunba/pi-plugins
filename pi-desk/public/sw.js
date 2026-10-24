const CACHE = "pi-desk-shell-v5";
// The app's page opens from the cache at once, refreshed in the background for next time: on a slow link (a plane),
// waiting on the network first held it back for tens of seconds. The page names its versioned files (/assets/…), so it
// is used from the cache only with all of them cached too, and a newer page replaces it only once its files are. A
// cached page whose files were not (the server had moved on a release or two) left the screen grey.
const assetsOf = html => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);

async function complete(cache, page) {
  for (const name of assetsOf(await page.clone().text())) if (!await cache.match(name)) return false;
  return true;
}
/** Fetches the page, and caches it with its files once they are all cached; the files of older pages are dropped. */
async function refresh(cache, request) {
  const response = await fetch(request);
  if (!response.ok) return response;
  const page = response.clone(), names = assetsOf(await response.clone().text());
  try {
    await Promise.all(names.map(async name => {
      if (await cache.match(name)) return;
      const asset = await fetch(name);
      if (!asset.ok) throw new Error(`${name}: ${asset.status}`);
      await cache.put(name, asset);
    }));
    await cache.put("/", page);
    for (const key of await cache.keys()) {
      const path = new URL(key.url).pathname;
      if (path.startsWith("/assets/") && !names.includes(path)) await cache.delete(key);
    }
  } catch { /* Kept for the next try; the page itself is still answered. */ }
  return response;
}

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(["/icon.svg", "/manifest.webmanifest"]);
    await refresh(cache, "/").catch(() => {});
  }));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys =>
    Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))]));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  // sandbox.html is a frame's page, not the app: answered by the server, with its own policy.
  if (url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") ||
      url.pathname === "/desk-account.json" || url.pathname === "/sandbox.html" || event.request.method !== "GET") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (event.request.mode === "navigate" || url.pathname === "/") {
      const cached = await cache.match("/");
      if (cached && await complete(cache, cached)) { event.waitUntil(refresh(cache, "/").catch(() => {})); return cached; }
      try { return await refresh(cache, event.request); }
      catch { return cached ?? new Response("Offline", { status: 503 }); }
    }
    // Versioned files never change: from the cache when there, otherwise fetched and kept.
    if (url.pathname.startsWith("/assets/")) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) event.waitUntil(cache.put(event.request, response.clone()));
      return response;
    }
    try { return await fetch(event.request); }
    catch { return (await cache.match(event.request)) ?? new Response("Offline", { status: 503 }); }
  })());
});
