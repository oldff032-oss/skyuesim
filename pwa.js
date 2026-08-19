// Register from every entry page so a fresh "Add to Home Screen" install has
// a service worker even when it starts directly on dashboard.html.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
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

// Privacy-safe client diagnostics. Never sends form values, request bodies,
// auth headers, PINs, tokens, QR data or full URLs/query strings.
const signalOriginalFetch = window.fetch.bind(window);
let signalDiagnosticCount = 0;
function signalReportDiagnostic(type, severity, message, context = {}) {
  const token = localStorage.getItem('signal_session_token');
  if (!token || typeof API_URL === 'undefined' || signalDiagnosticCount >= 100) return;
  signalDiagnosticCount += 1;
  signalOriginalFetch(`${API_URL}/api/account/diagnostics`, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-session-token':token},
    body:JSON.stringify({type,severity,page:location.pathname,message:String(message||'').slice(0,300),context}),
  }).catch(()=>{});
}
window.fetch = async function(input, init = {}) {
  const started = performance.now();
  const rawUrl = typeof input === 'string' ? input : input?.url || '';
  let path = 'unknown';
  try { path = new URL(rawUrl, location.origin).pathname; } catch {}
  const protectedLegacyPaths=['/api/status','/api/usage','/api/billing','/api/cancel','/api/create-subscription','/api/support/tickets'];
  const sessionToken=localStorage.getItem('signal_session_token');
  if(sessionToken&&protectedLegacyPaths.some(prefix=>path===prefix||path.startsWith(`${prefix}/`))){
    const headers=new Headers(init.headers||{});if(!headers.has('x-session-token'))headers.set('x-session-token',sessionToken);init={...init,headers};
  }
  if (path === '/api/account/diagnostics') return signalOriginalFetch(input, init);
  try {
    const response = await signalOriginalFetch(input, init);
    if (response.status >= 400) signalReportDiagnostic('api_error','warning',`API returned ${response.status}`,{path,method:String(init.method||'GET').toUpperCase(),status:response.status,durationMs:Math.round(performance.now()-started)});
    return response;
  } catch (error) {
    signalReportDiagnostic('network_error','error','Network request failed',{path,method:String(init.method||'GET').toUpperCase(),durationMs:Math.round(performance.now()-started),online:navigator.onLine});
    throw error;
  }
};
window.addEventListener('error',event=>signalReportDiagnostic('javascript_error','error',event.message||'JavaScript error',{file:event.filename?String(event.filename).split('/').pop():null,line:event.lineno||null,column:event.colno||null}));
window.addEventListener('unhandledrejection',event=>signalReportDiagnostic('promise_rejection','error',event.reason?.message||'Unhandled promise rejection',{}));
window.addEventListener('offline',()=>signalReportDiagnostic('connection','warning','Device went offline',{online:false}));
window.addEventListener('online',()=>signalReportDiagnostic('connection','info','Device is online',{online:true}));
window.addEventListener('load',()=>signalReportDiagnostic('page_view','info','Page opened',{online:navigator.onLine,userAgent:navigator.userAgent.slice(0,160)}));

const signalEscapeHtml = (value) => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
async function checkAppAnnouncements() {
  if (typeof API_URL === 'undefined' || !document.body) return;
  const token = localStorage.getItem('signal_session_token');
  const email = localStorage.getItem('signal_email');
  const endpoint = token ? '/api/account/announcements' : '/api/announcements';
  try {
    let response = await fetch(`${API_URL}${endpoint}${!token && email ? `?email=${encodeURIComponent(email)}` : ''}`, {
      headers: token ? { 'x-session-token': token } : {},
      cache: 'no-store',
    });
    if (response.status === 401 && token) response = await fetch(`${API_URL}/api/announcements`, { cache:'no-store' });
    if (!response.ok) return;
    const { announcements = [] } = await response.json();
    const securityIncident = announcements.find(item => item.type === 'security' && item.audience === 'all');
    const existingSecurity = document.getElementById('signal-security-incident-screen');
    if (!securityIncident) existingSecurity?.remove();
    if (securityIncident && !existingSecurity) {
      document.body.insertAdjacentHTML('beforeend', `<div id="signal-security-incident-screen" style="position:fixed;inset:0;z-index:2147483647;background:radial-gradient(circle at 50% 0,#482044 0,#131326 42%,#05060d 100%);color:#f7f8ff;display:grid;place-items:center;padding:24px;text-align:center;font-family:Inter,-apple-system,sans-serif"><div style="width:min(100%,560px)"><div style="width:92px;height:92px;margin:auto;border-radius:28px;display:grid;place-items:center;background:linear-gradient(145deg,#ff4d6d,#7557ff);box-shadow:0 0 60px rgba(255,77,109,.4);font-size:48px">🛡️</div><div style="margin-top:22px;font-size:11px;font-weight:800;letter-spacing:2px;color:#ff9bac">ЗАХИСТ SIGNAL АКТИВОВАНО</div><h1 style="font-size:30px;line-height:1.25;margin:10px 0 0">${signalEscapeHtml(securityIncident.title || 'Важливе повідомлення безпеки')}</h1><p style="color:#c7cada;line-height:1.7;margin:16px auto 0;max-width:500px">${signalEscapeHtml(securityIncident.message).replace(/\n/g,'<br>')}</p><div style="margin-top:20px;padding:13px;border:1px solid rgba(255,255,255,.13);border-radius:13px;background:rgba(255,255,255,.05);font-size:13px;color:#aeb5c9">Ваш акаунт не вимкнено. Нікому не повідомляйте пароль, PIN, резервні коди або коди з email.</div><button type="button" onclick="location.reload()" style="margin-top:20px;padding:12px 20px;border:0;border-radius:11px;background:linear-gradient(135deg,#ff4d6d,#7658ff);color:#fff;font-weight:800">Перевірити стан системи</button><p style="color:#7f879d;font-size:12px;margin-top:16px">Екран автоматично оновлюється кожні 30 секунд.</p></div></div>`);
      return;
    }
    if (securityIncident) return;
    const maintenance = announcements.find(item => item.type === 'maintenance' && item.audience === 'all');
    const existingMaintenance = document.getElementById('signal-maintenance-screen');
    if (!maintenance) existingMaintenance?.remove();
    if (maintenance && !existingMaintenance) {
      document.body.insertAdjacentHTML('beforeend', `<div id="signal-maintenance-screen" style="position:fixed;inset:0;z-index:2147483647;background:radial-gradient(circle at top,#182448,#05060d 62%);color:#f5f7ff;display:grid;place-items:center;padding:24px;text-align:center;font-family:Inter,-apple-system,sans-serif"><div style="width:min(100%,520px)"><div style="font-size:60px">🛠️</div><h1 style="font-size:30px;margin:20px 0 0">${signalEscapeHtml(maintenance.title || 'Технічні роботи')}</h1><p style="color:#b7c0d5;line-height:1.65;margin-top:14px">${signalEscapeHtml(maintenance.message).replace(/\n/g,'<br>')}</p><p style="color:#7f8aa3;font-size:13px;margin-top:22px">Сторінка перевірятиметься автоматично.</p><button type="button" onclick="location.reload()" style="margin-top:18px;padding:11px 18px;border:0;border-radius:10px;background:#5578ff;color:white;font-weight:700">Перевірити зараз</button></div></div>`);
      return;
    }
    if (maintenance || !token) return;
    const notice = announcements.find(item => item.type !== 'maintenance' && localStorage.getItem(`signal_announcement_seen:${item.id}`) !== '1');
    if (notice && !document.getElementById('signal-announcement-modal')) {
      document.body.insertAdjacentHTML('beforeend', `<div id="signal-announcement-modal" style="position:fixed;inset:0;z-index:2147483646;background:rgba(2,5,15,.82);backdrop-filter:blur(10px);display:grid;place-items:center;padding:20px;color:#f5f7ff;font-family:Inter,-apple-system,sans-serif"><section style="width:min(100%,470px);background:#10162a;border:1px solid rgba(100,130,255,.45);border-radius:20px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.55)"><div style="font-size:36px">📢</div><h2 style="font-size:22px;margin:12px 0 0">${signalEscapeHtml(notice.title)}</h2><p style="color:#bdc6da;line-height:1.6;margin-top:10px">${signalEscapeHtml(notice.message).replace(/\n/g,'<br>')}</p><button id="signal-announcement-close" type="button" style="width:100%;margin-top:20px;padding:12px;border:0;border-radius:11px;background:#5578ff;color:white;font-weight:700">Зрозуміло</button></section></div>`);
      document.getElementById('signal-announcement-close').onclick = () => {
        localStorage.setItem(`signal_announcement_seen:${notice.id}`, '1');
        document.getElementById('signal-announcement-modal')?.remove();
      };
    }
  } catch (error) {
    console.warn('Announcements are temporarily unavailable:', error.message);
  }
}
window.addEventListener('load', () => {
  checkAppAnnouncements();
  window.setInterval(checkAppAnnouncements, 30000);
});
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
