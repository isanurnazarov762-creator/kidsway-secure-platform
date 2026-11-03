// KidsWay service worker, one file for the three apps. Each app registers it at its own path
// (/sw.js, /guardian/sw.js, /control/sw.js), and the browser lets a worker control only pages under
// its own path. Each worker caches only its own app's files: a parent's phone never stores staff code.
// Security: ONLY public static files are cached. API answers (children, trips, codes, locations) and
// photos are never cached, so nothing personal is left on the device by this worker.
"use strict";
const SCOPE = new URL(self.registration.scope).pathname;
const SHARED = ["/static/core.js", "/static/map.js", "/static/app.css"];
const SHELLS = {
  "/": ["/", "/static/parent.js", "/static/icon-192.png", "/manifest.webmanifest"],
  "/guardian/": ["/guardian/", "/guardian/apply", "/static/guardian.js", "/static/careers.js", "/static/icon-guardian-192.png", "/guardian/manifest.webmanifest"],
  "/control/": ["/control/", "/static/control.js", "/static/icon-control-192.png", "/control/manifest.webmanifest"]
};
const SHELL = [...(SHELLS[SCOPE] || SHELLS["/"]), ...SHARED];
const CACHE = "kidsway-shell-v4" + SCOPE.replace(/\//g, "-");

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  // Remove older versions of this app's cache only; the other apps' caches are theirs to manage.
  const mine = (k) => k.startsWith("kidsway-shell-") && k.endsWith(SCOPE.replace(/\//g, "-")) && k !== CACHE;
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => mine(k) || k === "kidsway-shell-v3").map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return; // network only
  // Network first, so a new version is used as soon as it is online; the cache is the offline fallback.
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});
