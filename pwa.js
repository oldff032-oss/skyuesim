// Register from every entry page so a fresh "Add to Home Screen" install has
// a service worker even when it starts directly on dashboard.html.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
const applyTheme = () => document.documentElement.classList.toggle('light-theme', localStorage.getItem('signal_theme') === 'light');
applyTheme();
// All customer pages already load pwa.js, so language support is loaded once
// and stays consistent across the app.
if (!document.querySelector('script[data-signal-i18n]')) {
  const script = document.createElement('script');
  script.src = '/i18n.js';
  script.defer = true;
  script.dataset.signalI18n = 'true';
  document.head.appendChild(script);
}
if (window.location.pathname.endsWith('/app-tools.html')) {
  const coverageScript = document.createElement('script');
  coverageScript.src = '/coverage.js';
  coverageScript.defer = true;
  document.head.appendChild(coverageScript);
}
