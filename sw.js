// sw.js — offline support for ANCHOR.
// • App shell precached on install.
// • same-origin: network-first (so edits show), fall back to cache.
// • CDN / HuggingFace / fonts: cache-first (version-pinned, immutable).
// • message {type:'precache', urls} → fetch + cache a list, report progress.
const CACHE = 'anchor-v1';
const SHELL = [
  './', './index.html', './app.js', './face.js', './speech.js', './llm.js',
  './stt.js', './emotion.js', './persist.js', './styles.css',
  './manifest.webmanifest', './vendor/stub-empty.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isCDN = (h) => /(^|\.)jsdelivr\.net$|(^|\.)huggingface\.co$|(^|\.)hf\.co$|(^|\.)xethub\.hf\.co$|fonts\.(googleapis|gstatic)\.com$/.test(h);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isCDN(url.host)) return; // not ours to handle

  if (sameOrigin) {
    // network-first
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch {
        const hit = await cache.match(req) || await cache.match('./index.html');
        if (hit) return hit;
        throw new Error('offline and uncached: ' + url.pathname);
      }
    })());
  } else {
    // cache-first for immutable CDN/HF assets
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
  }
});

self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type !== 'precache' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = d.urls, total = urls.length; let done = 0, ok = 0;
    const post = (msg) => self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage(msg)));
    for (const url of urls) {
      try {
        const already = await cache.match(url);
        if (!already) { const res = await fetch(url, { cache: 'no-store' }); if (res && (res.ok || res.type === 'opaque')) { await cache.put(url, res.clone()); ok++; } }
        else ok++;
      } catch { /* best-effort */ }
      done++; post({ type: 'precache-progress', done, total, url });
    }
    post({ type: 'precache-done', ok, total });
  })());
});
