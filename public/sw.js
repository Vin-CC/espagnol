// Service worker « Español diario ».
// - App shell + data/*.json mis en cache à l'installation (cache versionné).
// - Shell et données : « stale-while-revalidate » (réponse immédiate depuis le cache, mise à jour en fond).
// - Audio : cache séparé et durable (survit aux changements de version), rempli à la première lecture
//   ou par le bouton « Télécharger tout l'audio ». Les requêtes Range (Safari) reçoivent une réponse 206.

const CACHE_VERSION = 'v4';
const SHELL_CACHE = `ed-shell-${CACHE_VERSION}`;
const AUDIO_CACHE = 'ed-audio-v1';
const DAYS = 60;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/scheduler.js',
  'js/dates.js',
  'js/text.js',
  'js/storage.js',
  'js/audio.js',
  'vendor/ts-fsrs.mjs',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'icons/apple-touch-icon.png',
  'data/cards.json',
  'data/days.json',
];
// Fichiers de données facultatifs (peuvent manquer au moment de l'installation).
const OPTIONAL = [
  'data/listen.json',
  ...Array.from({ length: DAYS }, (_, i) => `data/stories/day-${String(i + 1).padStart(2, '0')}.json`),
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: 'reload' : ne pas reprendre une ancienne copie du cache HTTP lors d'une mise à jour.
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await Promise.all(OPTIONAL.map(async (url) => {
      try {
        const r = await fetch(url, { cache: 'reload' });
        if (r.ok) await cache.put(url, r);
      } catch { /* hors-ligne ou absent : ignoré */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('ed-shell-') && k !== SHELL_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function rangeResponse(full, range, buf) {
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
    else {
      start = Number(m[1] || 0);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function serveAudio(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const url = request.url.split('#')[0];
  const range = request.headers.get('range');
  let cached = await cache.match(url, { ignoreSearch: true });
  if (!cached) {
    // Fichiers longs de l'écoute en trajet : on laisse le navigateur les lire en continu
    // (pas de mise en cache automatique ; le bouton « Télécharger tout l'audio » s'en charge).
    if (/\/listen-[^/]*\.mp3$/.test(new URL(url).pathname)) return fetch(request);
    try {
      const r = await fetch(url);
      if (!r.ok || r.status !== 200) return r;
      await cache.put(url, r.clone());
      cached = r;
    } catch {
      return new Response(null, { status: 504 });
    }
  }
  if (!range) return cached;
  return rangeResponse(cached, range, await cached.arrayBuffer());
}

async function staleWhileRevalidate(event, key) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(key, { ignoreSearch: true });
  const network = fetch(event.request).then((r) => {
    if (r.ok && r.status === 200) cache.put(key, r.clone());
    return r;
  });
  if (cached) {
    event.waitUntil(network.catch(() => {}));
    return cached;
  }
  try {
    return await network;
  } catch {
    if (event.request.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    return new Response(null, { status: 504 });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  const rel = url.pathname.slice(scope.pathname.length);
  if (rel.startsWith('audio/')) {
    event.respondWith(serveAudio(request));
    return;
  }
  const key = request.mode === 'navigate' || rel === '' ? 'index.html' : rel;
  event.respondWith(staleWhileRevalidate(event, key));
});
