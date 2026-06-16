// TENDEN Service Worker — オフライン緊急モード用
// ユーザーが設定でONにした場合のみ登録されます（デフォルト: 未登録）
// ONにすると地図・データをキャッシュしネット不要で動作しますが、アプリの自動更新が届かなくなります。

const CACHE_NAME = 'tenden-v81';
const DYNAMIC_CACHE = 'tenden-dynamic-v57';

const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './assets/congestion_edges.json',
  './assets/congestion_timeseries_baseline.json',
  './assets/shelters.json',
  './assets/routes.json',
  './assets/safe_edges.json',
  './assets/logo.png',
  './assets/icon-512.png',
  './assets/i18n.json',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/hud-logo.png',
  './assets/icons/TENDEN.gif',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js',
  'https://html2canvas.hertzen.com/dist/html2canvas.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&display=swap'
];

// 地図タイル・標高データを動的キャッシュするドメイン
const TILE_DOMAINS = [
  'basemaps.cartocdn.com',
  'cyberjapandata.gsi.go.jp',
  'disaportaldata.gsi.go.jp',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(keys
        .filter(key => key !== CACHE_NAME && key !== DYNAMIC_CACHE)
        .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;

  if (TILE_DOMAINS.some(d => req.url.includes(d)) || urlsToCache.includes(req.url)) {
    event.respondWith(
      caches.match(req).then(cachedRes => {
        if (cachedRes) return cachedRes;
        return fetch(req).then(networkRes => {
          return caches.open(DYNAMIC_CACHE).then(cache => {
            cache.put(req, networkRes.clone());
            return networkRes;
          });
        }).catch(() => new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));
      })
    );
  } else {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
  }
});
