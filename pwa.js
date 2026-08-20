// Register from every entry page so a fresh "Add to Home Screen" install has
// a service worker even when it starts directly on dashboard.html.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(sessionStorage.getItem('signal_sw_reloaded_v32')==='1')return;
    sessionStorage.setItem('signal_sw_reloaded_v32','1');
    location.reload();
  });
}
const applyTheme = () => document.documentElement.classList.toggle('light-theme', localStorage.getItem('signal_theme') === 'light');
applyTheme();
const maintenanceGateStyle=document.createElement('style');
maintenanceGateStyle.textContent='html.signal-maintenance-check body{visibility:hidden!important}';
document.head.appendChild(maintenanceGateStyle);
document.documentElement.classList.add('signal-maintenance-check');
window.setTimeout(()=>document.documentElement.classList.remove('signal-maintenance-check'),5000);
// All customer pages already load pwa.js, so language support is loaded once
// and stays consistent across the app.
if (!document.querySelector('script[data-signal-i18n]')) {
  const script = document.createElement('script');
  script.src = '/i18n.js?v=39';
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
const SIGNAL_FRONTEND_VERSION='1.0.0',SIGNAL_SW_VERSION='v39',SIGNAL_CACHE_VERSION='signal-shell-v39-control-center';
window.addEventListener('load',async()=>{
  if(typeof API_URL==='undefined')return;
  const token=localStorage.getItem('signal_session_token');
  try{
    const versionResponse=await signalOriginalFetch(`${API_URL}/api/app-version`,{cache:'no-store'}),version=await versionResponse.json();
    const refreshKey='signal_critical_refresh_token';
    if(version.criticalRefreshToken&&localStorage.getItem(refreshKey)!==version.criticalRefreshToken){
      localStorage.setItem(refreshKey,version.criticalRefreshToken);
      const registration=await navigator.serviceWorker?.ready;registration?.active?.postMessage({type:'REFRESH_CRITICAL',assets:version.criticalAssets||[]});
      await registration?.update?.();setTimeout(()=>location.reload(),500);
    }
    if(token)signalOriginalFetch(`${API_URL}/api/account/client-version`,{method:'POST',headers:{'Content-Type':'application/json','x-session-token':token},body:JSON.stringify({frontend:SIGNAL_FRONTEND_VERSION,serviceWorker:SIGNAL_SW_VERSION,cache:SIGNAL_CACHE_VERSION,platform:navigator.standalone?'ios-pwa':matchMedia('(display-mode: standalone)').matches?'pwa':'web'})}).catch(()=>{});
  }catch{}
});
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
    const durationMs=Math.round(performance.now()-started),requestId=response.headers.get('x-request-id');
    if (response.status >= 400) signalReportDiagnostic('api_error',response.status>=500?'error':'warning',`API returned ${response.status}`,{path,method:String(init.method||'GET').toUpperCase(),status:response.status,durationMs,requestId,outcome:'failed'});
    else if(['/api/travel-packages','/api/travel-packages/checkout','/api/create-subscription','/api/cancel','/api/support/tickets'].some(prefix=>path===prefix||path.startsWith(`${prefix}/`))) signalReportDiagnostic('api_flow','info','API operation completed',{path,method:String(init.method||'GET').toUpperCase(),status:response.status,durationMs,requestId,outcome:'success'});
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
    if (!response.ok){document.documentElement.classList.remove('signal-maintenance-check');return;}
    const { announcements = [] } = await response.json();
    document.documentElement.classList.remove('signal-maintenance-check');
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
    // During maintenance every customer page is blocked. The only exception
    // is the standalone form, which deliberately does not load this script.
    const onSupportPage = /\/maintenance-support\.html$/i.test(location.pathname);
    if (maintenance && !existingMaintenance && !onSupportPage) {
      document.body.insertAdjacentHTML('beforeend', `<div id="signal-maintenance-screen" role="dialog" aria-modal="true" aria-label="Технічні роботи" style="position:fixed;inset:0;z-index:2147483647;background:radial-gradient(circle at 50% -10%,#172d68 0,#080b19 48%,#03050b 100%);color:#f5f7ff;display:grid;place-items:center;padding:24px;text-align:center;font-family:Inter,-apple-system,sans-serif"><div style="width:min(100%,540px);padding:30px 24px;border:1px solid #5a7dff44;border-radius:28px;background:#090d1ddd;box-shadow:0 28px 90px #000a,0 0 70px #376dff22;backdrop-filter:blur(18px)"><img src="signal-premium-logo.png" alt="Signal" width="104" height="104" style="display:block;margin:0 auto;border-radius:24px;box-shadow:0 14px 42px #3178ff55"><div style="display:inline-flex;margin-top:22px;padding:7px 12px;border-radius:999px;background:#ffb02018;border:1px solid #ffb02055;color:#ffc45c;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase">Оновлення системи</div><h1 style="font-size:clamp(27px,6vw,36px);margin:18px 0 0">${signalEscapeHtml(maintenance.title || 'Тимчасово недоступно')}</h1><p style="color:#bec8df;line-height:1.7;margin:15px auto 0;max-width:460px">${signalEscapeHtml(maintenance.message).replace(/\n/g,'<br>')}</p><p style="color:#7f8aa3;font-size:13px;margin-top:22px">Дані акаунта та активні eSIM залишаються захищеними. Стан перевіряється автоматично.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:22px"><button type="button" onclick="location.reload()" style="padding:13px 16px;border:0;border-radius:13px;background:linear-gradient(135deg,#3e87ff,#7457ff);color:white;font-weight:800;cursor:pointer">Перевірити стан</button><button type="button" onclick="location.href='support.html?maintenance=1'" style="padding:13px 16px;border:1px solid #7386b955;border-radius:13px;background:#ffffff0b;color:#eef3ff;font-weight:800;cursor:pointer">Звернутися в підтримку</button></div></div></div>`);
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
    document.documentElement.classList.remove('signal-maintenance-check');
    console.warn('Announcements are temporarily unavailable:', error.message);
  }
}
window.addEventListener('load', () => {
  checkAppAnnouncements();
  window.setInterval(checkAppAnnouncements, 30000);
});
document.addEventListener('click',event=>{
  const button=event.target.closest?.('#signal-maintenance-screen button');
  if(button&&/підтримк/i.test(button.textContent||'')){
    event.preventDefault();event.stopImmediatePropagation();location.href='/maintenance-support.html';
  }
},true);
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

    const lockEnglish=localStorage.getItem('signal_language')==='en';
    const lockTitle=lockEnglish?'Signal is protected':'Signal захищено',lockHint=lockEnglish?'Enter your PIN to continue':'Введи свій PIN, щоб продовжити',lockDelete=lockEnglish?'Delete':'Видалити';
    document.body.insertAdjacentHTML('beforeend', `<div id="lock" style="position:fixed;inset:0;z-index:99999;background:radial-gradient(circle at 50% -12%,#17356f 0,#080c1b 43%,#03050b 100%);color:white;display:grid;place-items:center;padding:22px;text-align:center;font-family:Inter,-apple-system,sans-serif"><div style="width:min(100%,390px);padding:30px 22px;border:1px solid #6685ff38;border-radius:30px;background:#090d1dcc;box-shadow:0 28px 90px #000b,0 0 70px #3978ff20;backdrop-filter:blur(18px)"><img src="/signal-premium-logo.png" alt="Signal" width="88" height="88" style="display:block;margin:auto;border-radius:24px;box-shadow:0 15px 45px #2d79ff55"><div style="font:700 27px Space Grotesk,sans-serif;margin-top:20px">${lockTitle}</div><p style="color:#aebbd5;line-height:1.5;margin:8px 0 0">${lockHint}</p><div id="pinDots" style="display:flex;justify-content:center;gap:11px;margin:25px 0 20px">${'<span style="width:13px;height:13px;border:1.5px solid #7d8caf;border-radius:50%;transition:.15s"></span>'.repeat(6)}</div><input id="pin" inputmode="numeric" maxlength="6" type="password" autocomplete="off" style="position:absolute;opacity:0;pointer-events:none"><div id="pinPad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:300px;margin:auto">${[1,2,3,4,5,6,7,8,9].map(n=>`<button type="button" data-pin="${n}" style="height:58px;border:1px solid #7183af3d;border-radius:17px;background:#ffffff09;color:#f7f9ff;font:700 20px Space Grotesk;cursor:pointer">${n}</button>`).join('')}<button type="button" data-action="clear" style="height:58px;border:0;background:transparent;color:#8e9ab4;font-size:11px;font-weight:700">${lockDelete}</button><button type="button" data-pin="0" style="height:58px;border:1px solid #7183af3d;border-radius:17px;background:#ffffff09;color:#f7f9ff;font:700 20px Space Grotesk;cursor:pointer">0</button><button type="button" data-action="back" aria-label="${lockDelete}" style="height:58px;border:0;background:transparent;color:#cbd4e8;font-size:23px">⌫</button></div><p id="pinError" style="min-height:18px;color:#ff7185;font-size:12px;margin:14px 0 0"></p></div></div>`);
    const input = document.getElementById('pin');
    const drawPin=()=>document.querySelectorAll('#pinDots span').forEach((dot,index)=>{const filled=index<input.value.length;dot.style.background=filled?'#6d70ff':'transparent';dot.style.borderColor=filled?'#7f7dff':'#7d8caf';dot.style.boxShadow=filled?'0 0 16px #5d73ff88':'none';});
    document.querySelectorAll('#pinPad [data-pin]').forEach(button=>button.onclick=()=>{if(input.value.length<6){input.value+=button.dataset.pin;drawPin();input.dispatchEvent(new Event('input'));}});
    document.querySelector('#pinPad [data-action="back"]').onclick=()=>{input.value=input.value.slice(0,-1);drawPin();};
    document.querySelector('#pinPad [data-action="clear"]').onclick=()=>{input.value='';drawPin();};
    const lockKeyHandler=event=>{if(/^\d$/.test(event.key)&&input.value.length<6){input.value+=event.key;drawPin();input.dispatchEvent(new Event('input'));}else if(event.key==='Backspace'){input.value=input.value.slice(0,-1);drawPin();}};
    document.addEventListener('keydown',lockKeyHandler);
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
        document.removeEventListener('keydown',lockKeyHandler);
        document.getElementById('lock')?.remove();
      } else {
        input.disabled = false;
        input.value = '';
        drawPin();
        document.getElementById('pinError').textContent=lockEnglish?'Incorrect PIN. Try again.':'Невірний PIN. Спробуй ще раз.';
      }
    });
  } catch (error) {
    console.warn('App lock is temporarily unavailable:', error.message);
  }
});
