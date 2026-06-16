// ⚠️ PWA SERVICE WORKER — 開発中につき一時停止
// このSWは起動時に既存キャッシュを全削除し、自身を解除します。
// PWA機能はアプリ完成後に再有効化します。

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.registration.unregister())
  );
});
