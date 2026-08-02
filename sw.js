// Service Worker：離線快取
const VERSION = 'v2.1.1';
const CORE_CACHE = `core-${VERSION}`;
const RUNTIME_CACHE = 'runtime';

const CORE_ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/db.js',
  'js/reader.js',
  'js/pdf-import.js',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CORE_CACHE).then(c => c.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CORE_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => hit ||
      fetch(e.request).then(resp => {
        // 執行期快取（cmaps 等匯入時才用到的檔案）
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      })
    )
  );
});
