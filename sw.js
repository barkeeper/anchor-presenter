// sw.js — offline support for ANCHOR.
// • App shell precached on install (list shared with app.js via shell-files.json).
// • same-origin code (js/css/html): network-first (so edits show), fall back to cache.
// • same-origin static assets (vrm/img/fonts): stale-while-revalidate (instant, self-updating).
// • CDN / HuggingFace / fonts: cache-first (version-pinned, immutable).
// • message {type:'precache', urls} → fetch + cache a list, report progress.
const CACHE = 'anchor-v12'; // bump: transformers.js 4.2.0 + ORT 1.26 wasm + Gemma-4-E2B
// Minimal bootstrap list in case shell-files.json can't be fetched on install.
const SHELL_FALLBACK = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    let shell = SHELL_FALLBACK;
    try { const r = await fetch('./shell-files.json', { cache: 'no-store' }); if (r.ok) shell = await r.json(); } catch {}
    await Promise.allSettled(shell.map((u) => c.add(u)));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isCDN = (h) => /(^|\.)jsdelivr\.net$|(^|\.)huggingface\.co$|(^|\.)hf\.co$|(^|\.)xethub\.hf\.co$|fonts\.(googleapis|gstatic)\.com$/.test(h);

// Inject COOP/COEP into our own responses so the page becomes crossOriginIsolated.
// Threaded WASM (ORT) needs SharedArrayBuffer which requires this. Without it, the
// onnxruntime worker aborts on init with "Aborted()". credentialless EMBEDDER policy
// lets us still load cross-origin model bytes from HuggingFace without them needing
// to send CORP headers. Supported in Chrome 96+, Firefox 119+, Safari 17.4+.
function withCOI(res) {
  if (!res) return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isCDN(url.host)) return; // not ours to handle

  // Large, rarely-changing same-origin assets (avatar, backgrounds, icons, fonts) load
  // from cache instantly and refresh in the background. Code stays network-first so edits show.
  const isStaticAsset = /\.(vrm|vrma|png|jpe?g|webp|gif|woff2?|ico|basis|ktx2|mp3|ogg|m4a|svg)$/i.test(url.pathname);

  if (sameOrigin && isStaticAsset) {
    // stale-while-revalidate
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const fetching = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
      if (hit) { fetching; return withCOI(hit); }
      const res = await fetching;
      if (res) return withCOI(res);
      throw new Error('offline and uncached: ' + url.pathname);
    })());
  } else if (sameOrigin) {
    // network-first
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return withCOI(res);
      } catch {
        const hit = await cache.match(req) || await cache.match('./index.html');
        if (hit) return withCOI(hit);
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
