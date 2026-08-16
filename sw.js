// sw.js — мінімальний service worker, потрібен щоб сайт вважався
// повноцінним PWA (без нього PWABuilder не зможе згенерувати нормальний APK).
// Кешує тільки статичну "оболонку" — самі дані (підписка, тікети) завжди
// тягнуться наживо з бекенду, ніколи не кешуються.

const CACHE_NAME = 'signal-shell-v18';
const SHELL_FILES = [
  '/index.html',
  '/style.css',
  '/config.js',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  '/pwa.js',
  '/i18n.js',
  '/coverage.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Ніколи не кешуємо запити до API — там завжди мають бути свіжі дані
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || 'Сигнал', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'signal-update',
    data: { url: data.url || '/dashboard.html' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/dashboard.html'));
});
