// Service Worker：離線快取
// 快取名一律加 book-reader- 前綴：同一個 github.io origin 底下還有別的 PWA，
// activate 只能刪自己的，否則會把其他 App 的離線快取一起清掉。
// VERSION 要跟 main.js 的 APP_VERSION 一起改，否則手機會一直吃到舊的 JS。
const PREFIX = 'book-reader-';
const VERSION = 'v2.3.2';
const CORE_CACHE = `${PREFIX}core-${VERSION}`;
const RUNTIME_CACHE = `${PREFIX}runtime`;

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
      keys.filter(k => k.startsWith(PREFIX) && k !== CORE_CACHE && k !== RUNTIME_CACHE)
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    // 只查自己的兩個快取，不要用 caches.match 掃過整個 origin
    caches.open(CORE_CACHE)
      .then(c => c.match(e.request, { ignoreSearch: true }))
      .then(hit => hit || caches.open(RUNTIME_CACHE).then(c => c.match(e.request, { ignoreSearch: true })))
      .then(hit => hit || fetch(e.request).then(resp => {
        // 執行期快取（cmaps 等匯入時才用到的檔案）
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(RUNTIME_CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      }))
  );
});
