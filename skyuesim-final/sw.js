// sw.js — мінімальний service worker, потрібен щоб сайт вважався
// повноцінним PWA (без нього PWABuilder не зможе згенерувати нормальний APK).
// Кешує тільки статичну "оболонку" — самі дані (підписка, тікети) завжди
// тягнуться наживо з бекенду, ніколи не кешуються.

const CACHE_NAME = 'signal-shell-v61-ticket-flow';
const SHELL_FILES = [
  '/dashboard.html',
  '/profile.html',
  '/plans.html',
  '/travel-plans.html',
  '/usage.html',
  '/installing.html',
  '/esim-management.html',
  '/family-esims.html',
  '/offline-esim.html',
  '/app-tools.html',
  '/support.html',
  '/style.css',
  '/pwa.js',
  '/config.js',
  '/i18n.js',
  '/offline-esim.js',
  '/icon-192.png',
  '/icon-512.png',
  '/signal-premium-logo.png',
  '/nav-home-v2.png',
  '/nav-plans-v2.png',
  '/nav-usage-v2.png',
  '/nav-profile-v2.png',
  '/mobile-topup.html',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => caches.open(CACHE_NAME)).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.clients.claim();
});
self.addEventListener('message',event=>{if(event.data?.type!=='REFRESH_CRITICAL')return;const allowed=new Set(['/i18n.js','/style.css','/pwa.js','/sw.js','/config.js','/admin-common.js']),assets=(event.data.assets||[]).filter(item=>allowed.has(item));event.waitUntil(caches.open(CACHE_NAME).then(cache=>Promise.all(assets.map(path=>cache.delete(path)))));});

self.addEventListener('fetch', (event) => {
  // Ніколи не кешуємо запити до API — там завжди мають бути свіжі дані
  if (event.request.url.includes('/api/')) return;

  // HTML and critical scripts are network-first so a newly deployed auth,
  // push or payment fix is not hidden behind an old PWA cache.
  const url = new URL(event.request.url);
  const neverCache = ['/pwa.js','/config.js','/sw.js','/i18n.js','/style.css'].includes(url.pathname);
  if (neverCache) {
    event.respondWith(fetch(event.request, { cache:'no-store' }).then(response=>{
      const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));return response;
    }).catch(()=>caches.match(event.request)));
    return;
  }
  const critical = event.request.mode === 'navigate';
  if (critical) {
    event.respondWith(fetch(event.request, { cache:'no-store' }).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
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
  const target = new URL(event.notification.data?.url || '/dashboard.html', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => client.url.startsWith(self.location.origin));
    if (existing) { existing.navigate(target); return existing.focus(); }
    return clients.openWindow(target);
  }));
});
