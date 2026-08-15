// Register from every entry page so a fresh "Add to Home Screen" install has
// a service worker even when it starts directly on dashboard.html.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
