// KidsWay service worker: makes the app installable and lets the app shell open without a network.
// Security: it caches ONLY the public static files below. API answers (children, trips, codes,
// locations) and photos are never cached, so nothing personal is left on the phone by this worker.
"use strict";
const CACHE = "kidsway-shell-v3";
const SHELL = ["/", "/static/app.js", "/static/map.js", "/static/app.css", "/static/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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
