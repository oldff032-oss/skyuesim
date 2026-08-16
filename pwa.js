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
// sessionStorage survives navigation between app pages, but is cleared when a
// standalone PWA/browser session is closed. This makes the PIN an entry lock,
// not a prompt on every bottom-navigation click.
window.addEventListener('load', async () => {
  const token = localStorage.getItem('signal_session_token');
  if (!token || typeof API_URL === 'undefined') return;
  const unlockKey = `signal_app_unlocked:${token}`;
  if (sessionStorage.getItem(unlockKey) === '1') return;

  try {
    const response = await fetch(`${API_URL}/api/account/lock`, { headers: { 'x-session-token': token } });
    const lock = await response.json();
    if (!response.ok || !lock.enabled) {
      sessionStorage.setItem(unlockKey, '1');
      return;
    }

    document.body.insertAdjacentHTML('beforeend', '<div id="lock" style="position:fixed;inset:0;z-index:99999;background:radial-gradient(circle at top,#1c2650,#05060d 62%);color:white;display:grid;place-items:center;padding:24px;text-align:center"><div style="width:min(100%,360px)"><div style="font-size:48px;margin-bottom:16px">🔒</div><div style="font:700 26px Space Grotesk,sans-serif">Signal захищено</div><p style="color:#aeb6c9;line-height:1.5">Введи свій PIN, щоб продовжити</p><input id="pin" inputmode="numeric" maxlength="6" type="password" placeholder="••••••" style="width:100%;box-sizing:border-box;text-align:center;letter-spacing:10px;font-size:24px;margin-top:16px"></div></div>');
    const input = document.getElementById('pin');
    input.focus();
    input.addEventListener('input', async () => {
      if (input.value.length !== 6) return;
      input.disabled = true;
      const result = await fetch(`${API_URL}/api/account/lock/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': token },
        body: JSON.stringify({ pin: input.value }),
      });
      if (result.ok) {
        sessionStorage.setItem(unlockKey, '1');
        document.getElementById('lock')?.remove();
      } else {
        input.disabled = false;
        input.value = '';
        input.focus();
        alert('Невірний PIN');
      }
    });
  } catch (error) {
    console.warn('App lock is temporarily unavailable:', error.message);
  }
});
