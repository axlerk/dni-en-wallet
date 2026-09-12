/* Service worker mínimo: cachea el shell para que la app abra sin red.
 * Estrategia network-first: con red siempre se sirve la versión nueva (y se actualiza el cache); sin red, el cache.
 * NUNCA cachea /api/ — el pase se firma siempre en vivo. */
const CACHE = 'dni-wallet-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'pass-json.js', 'pkpass-build.js', 'pass-assets.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'vendor/zxing-library.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// El pase armado en la página se entrega desde acá: así Wallet recibe una respuesta de red normal
// (Content-Type application/vnd.apple.pkpass) sin que la foto haya salido del teléfono.
const passes = new Map();
self.addEventListener('message', (e) => {
  const d = e.data;
  if (d?.type !== 'pkpass' || !d.path || !d.bytes) return;
  passes.set(d.path, d.bytes);
  setTimeout(() => passes.delete(d.path), 120000); // no lo guardamos más de lo necesario
  e.ports?.[0]?.postMessage({ ok: true });
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const pass = passes.get(url.pathname);
  if (pass) {
    return e.respondWith(new Response(pass, {
      headers: {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Content-Disposition': `attachment; filename="${url.pathname.split('/').pop()}"`,
        'Cache-Control': 'no-store',
      },
    }));
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return; // network only
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
