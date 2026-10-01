// Bump the vN suffix whenever you publish changed app files. The previous
// cache stays intact while this worker waits, then is removed after activation.
const CACHE_NAME = 'volleyball-set-tracker-shell-v35';
const APP_SHELL = [
  './',
  './index.html',
  './teams.html',
  './practice.html',
  './volleyball-rotations.html',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/app/live-set.mjs',
  './src/app/session.mjs',
  './src/app/pwa.mjs',
  './src/app/themes.mjs',
  './src/app/formations.mjs',
  './src/app/team-menu.mjs',
  './src/practice/practice.mjs',
  './src/practice/practice-model.mjs',
  './src/practice/practice.css',
  './src/storage/indexeddb.mjs',
  './src/engine/set-engine.mjs',
  './src/engine/receive-layout.mjs',
  './src/teams/teams.mjs',
  './src/teams/teams.css',
  './src/teams/team-model.mjs',
  './src/teams/match-model.mjs',
  './src/teams/lineup-model.mjs',
  './src/teams/stats-model.mjs',
  './src/teams/lineup-editor.mjs',
];

const inScope = url => {
  const scope = new URL(self.registration.scope);
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
};

self.addEventListener('install', event => {
  const urls = APP_SHELL.map(path => new URL(path, self.registration.scope).href);
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urls)));
  // No skipWaiting(): updates wait for open app pages to close instead of
  // replacing the app shell while a set is in progress.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith('volleyball-set-tracker-shell-') && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!inScope(url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(request);
    if (saved) return saved;

    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic')
        await cache.put(request, response.clone());
      return response;
    } catch {
      return new Response('This page is not available offline yet.', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
