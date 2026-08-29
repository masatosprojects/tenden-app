// TENDEN Service Worker — オフライン緊急モード用
// ユーザーが設定でONにした場合のみ登録されます（デフォルト: 未登録）
// ONにすると地図・データをキャッシュし、オンライン時はアプリ本体を更新します。

const CACHE_NAME = 'tenden-v173';
const DYNAMIC_CACHE = 'tenden-dynamic-v87';

const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app-config.js',
  './app.js',
  './agent.js',
  './manifest.json',
  './assets/congestion_edges.json',
  './assets/congestion_timeseries_baseline.json',
  './assets/ai_evac_policy.json',
  './assets/ai_evac_policy_timeaware.json',
  './assets/shelters.json',
  './assets/routes.json',
  './assets/safe_edges.json',
  './assets/logo.png',
  './assets/loading.gif',
  './assets/shelter_icons/building.png',
  './assets/shelter_icons/takadai.png',
  './assets/shelter_icons/mound.png',
  './assets/shelter_icons/tower.png',
  './assets/icon-512.png',
  './assets/i18n.json',
  './assets/agent/manifest.json',
  './assets/agent/agent-spritesheet.png',
  './assets/agent/agent-idle.png',
  './assets/agent/agent-search.png',
  './assets/agent/agent-halt.png',
  './assets/agent/agent-route-plan.png',
  './assets/agent/agent-navigate.png',
  './assets/agent/agent-broadcast.png',
  './assets/agent/agent-destination.png',
  './assets/agent/agent-ar-demo.png',
  './assets/agent/agent-evac-active.png',
  './assets/agent/agent-directing.png',
  './assets/agent/agent-high-ground.png',
  './assets/agent/agent-monitor.png',
  './assets/agent/agent-scout.png',
  './assets/agent/agent-safety-share.png',
  './assets/agent/agent-urgent.png',
  './assets/agent/agent-synced.png',
  './assets/agent/agent-night-alert.png',
  './assets/agent/agent-flood.png',
  './assets/agent/agent-checkin.png',
  './assets/agent/agent-watch-coast.png',
  './assets/icons/TENDEN.gif',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-192-maskable.png',
  './assets/icons/icon-512-maskable.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/hud-logo.png',
  './assets/icons/tenden-trunk-pictogram.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/@turf/turf@6/turf.min.js',
  'https://html2canvas.hertzen.com/dist/html2canvas.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@400;500;600;700&display=swap',
  'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400&family=Noto+Sans+JP:wght@400&family=Noto+Sans+SC:wght@400&family=Noto+Sans+TC:wght@400&family=Noto+Sans+KR:wght@400&family=Noto+Sans+Arabic:wght@400&family=Noto+Sans+Thai:wght@400&family=Noto+Sans+Devanagari:wght@400&family=Noto+Sans+Bengali:wght@400&family=Noto+Sans+Hebrew:wght@400&display=swap'
];

// 地図タイル・標高データを動的キャッシュするドメイン
const TILE_DOMAINS = [
  'basemaps.cartocdn.com',
  'cyberjapandata.gsi.go.jp',
  'disaportaldata.gsi.go.jp',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

const CORE_APP_PATHS = new Set([
  '',
  'index.html',
  'style.css',
  'app-config.js',
  'app.js',
  'agent.js',
  'manifest.json',
  'assets/i18n.json'
]);

self.addEventListener('install', event => {
  self.skipWaiting();
  const localUrls = urlsToCache.filter(url => !/^https?:/i.test(url));
  const remoteUrls = urlsToCache.filter(url => /^https?:/i.test(url));
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(localUrls)
        // A temporary CDN failure must not prevent this service worker update.
        .then(() => Promise.allSettled(remoteUrls.map(url => cache.add(url)))))
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
  if (req.method !== 'GET') return;
  const cleanUrl = req.url.split('?')[0];
  const requestUrl = new URL(req.url);
  const appBase = new URL('./', self.location.href).pathname;
  const relativePath = requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith(appBase)
    ? requestUrl.pathname.slice(appBase.length)
    : null;
  const isCoreApp = relativePath !== null && CORE_APP_PATHS.has(relativePath);

  // Avoid mixed-version HTML/JS/CSS while online. If the network is unavailable,
  // fall back to the last complete app shell retained for emergency use.
  if (isCoreApp) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then(networkRes => {
        if (networkRes && networkRes.ok) {
          caches.open(CACHE_NAME).then(cache => cache.put(req, networkRes.clone()));
        }
        return networkRes;
      }).catch(() => caches.match(req).then(cachedRes => cachedRes || caches.match(req, { ignoreSearch: true })))
    );
    return;
  }

  const isStaticAsset = urlsToCache.some(url => {
    try {
      const absoluteUrl = new URL(url, self.location.href).href;
      return cleanUrl === absoluteUrl || cleanUrl === absoluteUrl + 'index.html';
    } catch(e) {
      return false;
    }
  });

  if (TILE_DOMAINS.some(d => req.url.includes(d)) || isStaticAsset) {
    event.respondWith(
      caches.match(req).then(cachedRes => {
        if (cachedRes) return cachedRes;
        return fetch(req).then(networkRes => {
          if (TILE_DOMAINS.some(d => req.url.includes(d))) {
            return caches.open(DYNAMIC_CACHE).then(cache => {
              cache.put(req, networkRes.clone());
              return networkRes;
            });
          }
          return networkRes;
        }).catch(() => new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));
      })
    );
  } else {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
  }
});
