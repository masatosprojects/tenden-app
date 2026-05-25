// sw.js - Advanced Service Worker with Dynamic Caching
const CACHE_NAME = 'tenden-v3';
const DYNAMIC_CACHE = 'tenden-dynamic-v3';

const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './assets/hazard.geojson',
  './assets/congestion.geojson',
  './assets/shelters.json',
  './assets/routes.json',
  './assets/icons/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://html2canvas.hertzen.com/dist/html2canvas.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
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
    })
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  
  // Cache First strategy for static assets and Map tiles
  if (req.url.includes('basemaps.cartocdn.com') || req.url.includes('cyberjapandata2.gsi.go.jp') || urlsToCache.includes(req.url)) {
    event.respondWith(
      caches.match(req).then(cachedRes => {
        if (cachedRes) return cachedRes;
        
        return fetch(req).then(networkRes => {
          // Dynamic Caching for map tiles and elevation data
          return caches.open(DYNAMIC_CACHE).then(cache => {
            cache.put(req, networkRes.clone());
            return networkRes;
          });
        }).catch(() => {
          // Fallback if offline and not in cache
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
      })
    );
  } else {
    // Network first for other requests
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
  }
});
