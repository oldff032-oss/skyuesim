// Register from every entry page so a fresh "Add to Home Screen" install has
// a service worker even when it starts directly on dashboard.html.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
// All customer pages already load pwa.js, so language support is loaded once
// and stays consistent across the app.
if (!document.querySelector('script[data-signal-i18n]')) {
  const script = document.createElement('script');
  script.src = '/i18n.js';
  script.defer = true;
  script.dataset.signalI18n = 'true';
  document.head.appendChild(script);
}
