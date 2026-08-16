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
window.addEventListener('load',async()=>{const t=localStorage.getItem('signal_session_token');if(!t||!window.API_URL)return;try{const r=await fetch(`${API_URL}/api/account/lock`,{headers:{'x-session-token':t}}),d=await r.json();if(!r.ok||!d.enabled)return;document.body.insertAdjacentHTML('beforeend','<div id="lock" style="position:fixed;inset:0;z-index:99999;background:#05060d;color:white;display:grid;place-items:center;text-align:center"><div><h2>🔒 Застосунок заблоковано</h2><p>Введи PIN із 6 цифр</p><input id="pin" inputmode="numeric" maxlength="6" type="password"><button class="btn" id="unlock">Розблокувати</button></div></div>');document.getElementById('unlock').onclick=async()=>{const x=await fetch(`${API_URL}/api/account/lock/pin`,{method:'POST',headers:{'Content-Type':'application/json','x-session-token':t},body:JSON.stringify({pin:document.getElementById('pin').value})});if(x.ok)document.getElementById('lock').remove();else alert('Невірний PIN')}}catch(e){}});
