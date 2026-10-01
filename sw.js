// Service worker: caches the app shell only, so the app opens from the home screen with no
// network. Never data: Supabase is another origin and is not touched here, and the shell list is
// fixed. VERSION changes with every change to a shell file (`node dev/check.mjs --fix` does it);
// the app then offers "Reload".
const VERSION = 'r5-16'; // shell: 6cb57beda808
const CACHE = `shell-${VERSION}`;
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/auth.js', 'js/images.js', 'js/mailbox.js', 'js/markdown.js', 'js/relay_crypto.js', 'js/store.js', 'js/sync.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Navigations (including the ?code= sign-in return) get the cached page; files come from the
  // cache first. Anything not in the shell goes to the network untouched.
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html', { cacheName: CACHE }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((r) => r || fetch(req)));
});
