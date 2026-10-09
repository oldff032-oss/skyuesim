// sw.js — мінімальний service worker, потрібен щоб сайт вважався
// повноцінним PWA (без нього PWABuilder не зможе згенерувати нормальний APK).
// Кешує тільки статичну "оболонку" — самі дані (підписка, тікети) завжди
// тягнуться наживо з бекенду, ніколи не кешуються.

const CACHE_NAME = 'signal-shell-v111-glass-pin-lock';
const SHELL_FILES = [
  '/index.html',
  '/welcome.html',
  '/login.html',
  '/register-email.html',
  '/verify-code.html',
  '/set-password.html',
  '/account-created.html',
  '/admin-dashboard.html',
  '/dashboard.html',
  '/profile.html',
  '/security.html',
  '/security-setup.html',
  '/security-pin.html',
  '/security-pattern.html',
  '/security-recovery.html',
  '/notifications.html',
  '/activity.html',
  '/savings.html',
  '/family-center.html',
  '/plans.html',
  '/travel-plans.html',
  '/travel-assistant.html',
  '/signal-universe.html',
  '/signal-passport.html',
  '/signal-club.html',
  '/smart-assist.html',
  '/traffic-alerts.html',
  '/family-trip.html',
  '/wallet-pass.html',
  '/rescue-mode.html',
  '/esim-topup.html',
  '/family-share.html',
  '/usage.html',
  '/installing.html',
  '/esim-management.html',
  '/family-esims.html',
  '/offline-esim.html',
  '/app-tools.html',
  '/support.html',
  '/new-ticket.html',
  '/ticket.html',
  '/help.html',
  '/style.css',
  '/signal-v5.css',
  '/experience.css',
  '/experience.js',
  '/vendor/heic-worker-1.5.2.js',
  '/vendor/libheif-1.22.2.js',
  '/pwa.js',
  '/signal-pattern.js',
  '/config.js',
  '/i18n.js',
  '/offline-esim.js',
  '/icon-192.png',
  '/icon-512.png',
  '/signal-premium-logo.png',
  '/signal-earth-v1.png',
  '/signal-card-scenes-v1.png',
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
    caches.keys().then((keys) => Promise.all(keys.filter((key)=>key!==CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => caches.open(CACHE_NAME)).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.clients.claim();
});
self.addEventListener('message',event=>{if(event.data?.type!=='REFRESH_CRITICAL')return;const allowed=new Set(['/i18n.js','/style.css','/signal-v5.css','/experience.css','/experience.js','/pwa.js','/signal-pattern.js','/sw.js','/config.js','/admin-common.js']),assets=(event.data.assets||[]).filter(item=>allowed.has(item));event.waitUntil(caches.open(CACHE_NAME).then(cache=>Promise.all(assets.map(path=>cache.delete(path)))));});

self.addEventListener('fetch', (event) => {
  // Ніколи не кешуємо запити до API — там завжди мають бути свіжі дані
  if (event.request.url.includes('/api/')) return;

  // HTML and critical scripts are network-first so a newly deployed auth,
  // push or payment fix is not hidden behind an old PWA cache.
  const url = new URL(event.request.url);
  const neverCache = ['/pwa.js','/signal-pattern.js','/config.js','/sw.js','/i18n.js','/style.css','/signal-v5.css','/experience.css','/experience.js','/admin-common.js'].includes(url.pathname);
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
  event.waitUntil(self.registration.showNotification(data.title || 'Нове повідомлення', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'signal-update',
    renotify: false,
    requireInteraction: data.requireInteraction === true,
    actions: Array.isArray(data.actions) ? data.actions.slice(0, 2) : [],
    data: { url: data.url || '/dashboard.html' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const actionUrl = event.action === 'topup' ? '/esim-topup.html' : event.action === 'usage' ? '/usage.html' : event.notification.data?.url;
  const target = new URL(actionUrl || '/dashboard.html', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => client.url.startsWith(self.location.origin));
    if (existing) { existing.navigate(target); return existing.focus(); }
    return clients.openWindow(target);
  }));
});
