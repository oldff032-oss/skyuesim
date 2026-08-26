// Register from every entry page so a fresh "Add to Home Screen" install has
// a service worker even when it starts directly on dashboard.html.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js?v=72', { updateViaCache: 'none' }).then(registration => registration.update()).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(sessionStorage.getItem('signal_sw_reloaded_v72')==='1')return;
    sessionStorage.setItem('signal_sw_reloaded_v72','1');
    location.reload();
  });
}
const applyTheme = () => document.documentElement.classList.toggle('light-theme', localStorage.getItem('signal_theme') === 'light');
applyTheme();
const signalAuthPages=new Set(['login.html','register-email.html','verify-code.html','set-password.html','forgot-password.html','reset-code.html','new-password.html','account-created.html']);
const signalCurrentPage=location.pathname.split('/').pop()||'index.html';
if(signalAuthPages.has(signalCurrentPage))document.documentElement.classList.add('signal-auth-page');
function signalMountAuthExperience(){if(!signalAuthPages.has(signalCurrentPage)||!document.body)return;const wrap=document.querySelector('.wrap');if(wrap&&!wrap.querySelector('.auth-atmosphere'))wrap.insertAdjacentHTML('afterbegin','<div class="auth-atmosphere" aria-hidden="true"><i></i><i></i><i></i></div>');if(!document.getElementById('signal-auth-loader'))document.body.insertAdjacentHTML('beforeend','<div id="signal-auth-loader" class="auth-loader" role="status" aria-live="polite" aria-hidden="true"><div class="auth-loader-core"><span class="auth-logo-stage"><img src="signal-premium-logo.png" alt=""><i></i><b></b></span><strong id="signal-auth-loader-title">Захищений вхід</strong><small id="signal-auth-loader-copy">Підключаємо твій акаунт до Signal</small><span class="auth-loader-progress"><i></i></span></div></div>');const splashAllowed=['login.html','register-email.html'].includes(signalCurrentPage),splashKey=`signal_auth_intro:${signalCurrentPage}`;if(splashAllowed&&!sessionStorage.getItem(splashKey)){sessionStorage.setItem(splashKey,'1');signalAuthLoading(true,signalCurrentPage==='login.html'?'Ласкаво просимо':'Створюємо твій Signal');setTimeout(()=>signalAuthLoading(false),1150);}}
window.signalAuthLoading=function(active,title,copy){const loader=document.getElementById('signal-auth-loader');if(!loader)return;if(title)document.getElementById('signal-auth-loader-title').textContent=title;if(copy)document.getElementById('signal-auth-loader-copy').textContent=copy;loader.classList.toggle('visible',Boolean(active));loader.setAttribute('aria-hidden',active?'false':'true');document.body.classList.toggle('auth-busy',Boolean(active));};
window.signalAuthSuccess=function(title='Готово!'){const loader=document.getElementById('signal-auth-loader');if(!loader)return;document.getElementById('signal-auth-loader-title').textContent=title;document.getElementById('signal-auth-loader-copy').textContent='Відкриваємо твій особистий простір';loader.classList.add('visible','success');loader.setAttribute('aria-hidden','false');document.body.classList.add('auth-busy');};
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',signalMountAuthExperience):signalMountAuthExperience();
const signalNavItems={'dashboard.html':{label:'Головна',labelEn:'Home',image:'nav-home-v2.png'},'plans.html':{label:'Тарифи',labelEn:'Plans',image:'nav-plans-v2.png'},'usage.html':{label:'Витрати',labelEn:'Usage',image:'nav-usage-v2.png'},'profile.html':{label:'Профіль',labelEn:'Profile',image:'nav-profile-v2.png'}};
function enhanceSignalNavigation(){const current=location.pathname.split('/').pop(),isCore=Boolean(signalNavItems[current]),english=localStorage.getItem('signal_language')==='en';document.querySelectorAll('.bottomnav a').forEach(link=>{const page=(link.getAttribute('href')||'').split(/[?#]/)[0].split('/').pop(),item=signalNavItems[page];if(!item)return;const label=english?item.labelEn:item.label;if(isCore)link.classList.toggle('active',page===current);link.dataset.nav=page.replace('.html','');link.setAttribute('aria-label',label);link.setAttribute('title',label);link.innerHTML=`<span class="nav-icon" aria-hidden="true"><img class="nav-art" src="${item.image}" alt=""></span><span class="nav-label" data-no-auto-translate>${label}</span>`;});const dashboardLogo=document.querySelector('.logo-orbit');if(dashboardLogo&&!dashboardLogo.querySelector('img'))dashboardLogo.innerHTML='<img src="signal-premium-logo.png" alt="Signal">';}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',enhanceSignalNavigation):enhanceSignalNavigation();
window.addEventListener('load',()=>{enhanceSignalNavigation();setTimeout(enhanceSignalNavigation,500);});
const maintenanceGateStyle=document.createElement('style');
maintenanceGateStyle.textContent='html.signal-maintenance-check body{visibility:hidden!important}';
document.head.appendChild(maintenanceGateStyle);
const signalOfflineCardPage=/\/offline-esim\.html$/i.test(location.pathname);
if(!signalOfflineCardPage)document.documentElement.classList.add('signal-maintenance-check');
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
const SIGNAL_FRONTEND_VERSION='2.0.2',SIGNAL_SW_VERSION='v72',SIGNAL_CACHE_VERSION='signal-shell-v72-pin-recovery';
window.SIGNAL_APP_VERSION=SIGNAL_FRONTEND_VERSION;
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
  const protectedLegacyPaths=['/api/status','/api/usage','/api/billing','/api/cancel','/api/create-subscription','/api/support/tickets','/api/mobile-topups'];
  const sessionToken=localStorage.getItem('signal_session_token');
  if(sessionToken&&protectedLegacyPaths.some(prefix=>path===prefix||path.startsWith(`${prefix}/`))){
    const headers=new Headers(init.headers||{});if(!headers.has('x-session-token'))headers.set('x-session-token',sessionToken);init={...init,headers};
  }
  if (path === '/api/account/diagnostics') return signalOriginalFetch(input, init);
  try {
    const response = await signalOriginalFetch(input, init);
    const durationMs=Math.round(performance.now()-started),requestId=response.headers.get('x-request-id');
    if (response.status >= 400) signalReportDiagnostic('api_error',response.status>=500?'error':'warning',`API returned ${response.status}`,{path,method:String(init.method||'GET').toUpperCase(),status:response.status,durationMs,requestId,outcome:'failed'});
    else if(['/api/travel-packages','/api/travel-packages/checkout','/api/mobile-topups','/api/create-subscription','/api/cancel','/api/support/tickets'].some(prefix=>path===prefix||path.startsWith(`${prefix}/`))) signalReportDiagnostic('api_flow','info','API operation completed',{path,method:String(init.method||'GET').toUpperCase(),status:response.status,durationMs,requestId,outcome:'success'});
    return response;
  } catch (error) {
    signalReportDiagnostic('network_error','error','Network request failed',{path,method:String(init.method||'GET').toUpperCase(),durationMs:Math.round(performance.now()-started),online:navigator.onLine});
    throw error;
  }
};
window.addEventListener('error',event=>signalReportDiagnostic('javascript_error','error',event.message||'JavaScript error',{file:event.filename?String(event.filename).split('/').pop():null,line:event.lineno||null,column:event.colno||null}));
window.addEventListener('unhandledrejection',event=>signalReportDiagnostic('promise_rejection','error',event.reason?.message||'Unhandled promise rejection',{}));
function signalRenderOfflineState(){
  const existing=document.getElementById('signal-offline-banner');
  if(navigator.onLine){existing?.remove();return;}
  if(existing||/\/offline-esim\.html$/i.test(location.pathname))return;
  document.body?.insertAdjacentHTML('afterbegin','<div id="signal-offline-banner" role="status" style="position:fixed;z-index:2147483000;top:max(8px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(calc(100% - 24px),520px);padding:10px 14px;border:1px solid rgba(78,211,255,.32);border-radius:14px;background:rgba(7,11,27,.94);box-shadow:0 12px 40px rgba(0,0,0,.45);backdrop-filter:blur(16px);color:#d9efff;font:600 12px Inter,sans-serif;text-align:center">Офлайн-режим · збережені eSIM доступні <a href="/offline-esim.html" style="color:#5ee7ff;margin-left:6px">Відкрити</a></div>');
}
window.addEventListener('offline',()=>{signalReportDiagnostic('connection','warning','Device went offline',{online:false});signalRenderOfflineState();});
window.addEventListener('online',()=>{signalReportDiagnostic('connection','info','Device is online',{online:true});signalRenderOfflineState();});
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',signalRenderOfflineState):signalRenderOfflineState();
window.addEventListener('load',()=>signalReportDiagnostic('page_view','info','Page opened',{online:navigator.onLine,userAgent:navigator.userAgent.slice(0,160)}));

const signalEscapeHtml = (value) => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
let signalMaintenanceTimer=null;
function startMaintenanceCountdown(expiresAt){clearInterval(signalMaintenanceTimer);const target=new Date(expiresAt).getTime(),root=document.getElementById('signal-maintenance-countdown');if(!root||!Number.isFinite(target)){root?.remove();return;}const tick=()=>{const remaining=Math.max(0,target-Date.now()),days=Math.floor(remaining/86400000),hours=Math.floor(remaining%86400000/3600000),minutes=Math.floor(remaining%3600000/60000),seconds=Math.floor(remaining%60000/1000),value=document.getElementById('signal-maintenance-countdown-value'),exact=document.getElementById('signal-maintenance-countdown-exact');if(value)value.textContent=`${days?`${days} дн. `:''}${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;if(exact)exact.textContent=`Орієнтовне завершення: ${new Date(target).toLocaleString(localStorage.getItem('signal_language')==='en'?'en-GB':'uk-UA',{dateStyle:'medium',timeStyle:'short'})}`;if(remaining<=0){clearInterval(signalMaintenanceTimer);setTimeout(checkAppAnnouncements,500);}};tick();signalMaintenanceTimer=setInterval(tick,1000);}
function renderSignalDashboardNotice(notice){const home=document.querySelector('.home'),existing=document.getElementById('signal-dashboard-notice');if(!home||!notice)return;if(existing?.dataset.noticeId===notice.id)return;existing?.remove();const anchor=document.getElementById('loading')||document.getElementById('content');if(!anchor)return;anchor.insertAdjacentHTML('beforebegin',`<article id="signal-dashboard-notice" class="signal-dashboard-notice" data-notice-id="${signalEscapeHtml(notice.id)}"><i class="dashboard-notice-glow" aria-hidden="true"></i><header><span class="dashboard-notice-logo"><img src="signal-premium-logo.png" alt="Signal"></span><span><small><i></i> Актуальне повідомлення</small><strong>${signalEscapeHtml(notice.title||'Повідомлення Signal')}</strong></span></header><div class="dashboard-notice-copy">${signalEscapeHtml(notice.message).replace(/\n/g,'<br>')}</div><footer><span>Signal інформує</span><button type="button" aria-expanded="false">Читати повністю</button></footer></article>`);const card=document.getElementById('signal-dashboard-notice'),button=card.querySelector('footer button');button.onclick=()=>{const expanded=card.classList.toggle('expanded');button.setAttribute('aria-expanded',String(expanded));button.textContent=expanded?'Згорнути':'Читати повністю';};}
async function checkAppAnnouncements() {
  if (typeof API_URL === 'undefined' || !document.body) return;
  const token = localStorage.getItem('signal_session_token');
  const email = localStorage.getItem('signal_email');
  const endpoint = token ? '/api/account/announcements' : '/api/announcements';
  try {
    const statusResponse=await signalOriginalFetch(`${API_URL}/api/service-status?_=${Date.now()}`,{cache:'no-store'});
    const serviceStatus=statusResponse.ok?await statusResponse.json():{status:'unknown'};
    let response = await fetch(`${API_URL}${endpoint}${!token && email ? `?email=${encodeURIComponent(email)}` : ''}`, {
      headers: token ? { 'x-session-token': token } : {},
      cache: 'no-store',
    });
    if (response.status === 401 && token) response = await fetch(`${API_URL}/api/announcements`, { cache:'no-store' });
    const announcements=response.ok?((await response.json()).announcements||[]):[];
    if(!response.ok&&serviceStatus.status!=='maintenance'){document.documentElement.classList.remove('signal-maintenance-check');return;}
    document.documentElement.classList.remove('signal-maintenance-check');
    const securityIncident = announcements.find(item => item.type === 'security' && item.audience === 'all');
    const existingSecurity = document.getElementById('signal-security-incident-screen');
    if (!securityIncident) existingSecurity?.remove();
    if (securityIncident && !existingSecurity) {
      document.body.insertAdjacentHTML('beforeend', `<div id="signal-security-incident-screen" style="position:fixed;inset:0;z-index:2147483647;background:radial-gradient(circle at 50% 0,#482044 0,#131326 42%,#05060d 100%);color:#f7f8ff;display:grid;place-items:center;padding:24px;text-align:center;font-family:Inter,-apple-system,sans-serif"><div style="width:min(100%,560px)"><div style="width:92px;height:92px;margin:auto;border-radius:28px;display:grid;place-items:center;background:linear-gradient(145deg,#ff4d6d,#7557ff);box-shadow:0 0 60px rgba(255,77,109,.4);font-size:48px">🛡️</div><div style="margin-top:22px;font-size:11px;font-weight:800;letter-spacing:2px;color:#ff9bac">ЗАХИСТ SIGNAL АКТИВОВАНО</div><h1 style="font-size:30px;line-height:1.25;margin:10px 0 0">${signalEscapeHtml(securityIncident.title || 'Важливе повідомлення безпеки')}</h1><p style="color:#c7cada;line-height:1.7;margin:16px auto 0;max-width:500px">${signalEscapeHtml(securityIncident.message).replace(/\n/g,'<br>')}</p><div style="margin-top:20px;padding:13px;border:1px solid rgba(255,255,255,.13);border-radius:13px;background:rgba(255,255,255,.05);font-size:13px;color:#aeb5c9">Ваш акаунт не вимкнено. Нікому не повідомляйте пароль, PIN, резервні коди або коди з email.</div><button type="button" onclick="location.reload()" style="margin-top:20px;padding:12px 20px;border:0;border-radius:11px;background:linear-gradient(135deg,#ff4d6d,#7658ff);color:#fff;font-weight:800">Перевірити стан системи</button><p style="color:#7f879d;font-size:12px;margin-top:16px">Екран автоматично оновлюється кожні 30 секунд.</p></div></div>`);
      return;
    }
    if (securityIncident) return;
    const maintenance = announcements.find(item => item.type === 'maintenance' && item.audience === 'all')||(serviceStatus.status==='maintenance'?{title:'Тимчасово недоступно',message:serviceStatus.message||'Ми проводимо технічні роботи. Спробуйте відкрити застосунок трохи пізніше.',audience:'all',type:'maintenance'}:null);
    const existingMaintenance = document.getElementById('signal-maintenance-screen');
    if (!maintenance){existingMaintenance?.remove();clearInterval(signalMaintenanceTimer);signalMaintenanceTimer=null;}
    // During maintenance every customer page is blocked. The only exception
    // is the standalone form, which deliberately does not load this script.
    const onSupportPage = /\/maintenance-support\.html$/i.test(location.pathname);
    if (maintenance && !existingMaintenance && !onSupportPage && !signalOfflineCardPage) {
      document.body.insertAdjacentHTML('beforeend', `<div id="signal-maintenance-screen" class="signal-maintenance-screen" role="dialog" aria-modal="true" aria-label="Технічні роботи"><i class="maintenance-orb one" aria-hidden="true"></i><i class="maintenance-orb two" aria-hidden="true"></i><div class="signal-maintenance-card"><span class="maintenance-logo"><img src="signal-premium-logo.png" alt="Signal"><i></i></span><div class="maintenance-badge"><i></i> Оновлення системи</div><h1>${signalEscapeHtml(maintenance.title || 'Тимчасово недоступно')}</h1><p class="maintenance-message">${signalEscapeHtml(maintenance.message).replace(/\n/g,'<br>')}</p>${maintenance.expiresAt?'<div id="signal-maintenance-countdown" class="maintenance-countdown"><span>До завершення робіт</span><strong id="signal-maintenance-countdown-value">00:00:00</strong><small id="signal-maintenance-countdown-exact"></small></div>':''}<p class="maintenance-safe">Дані акаунта та активні eSIM залишаються захищеними. Стан перевіряється автоматично.</p><div class="maintenance-actions"><button type="button" onclick="location.reload()">Перевірити стан</button><button type="button" onclick="location.href='maintenance-support.html'">Написати в підтримку</button></div></div></div>`);
      if(maintenance.expiresAt)startMaintenanceCountdown(maintenance.expiresAt);
      return;
    }
    if(maintenance?.expiresAt&&!signalMaintenanceTimer)startMaintenanceCountdown(maintenance.expiresAt);
    if (maintenance || !token) return;
    const activeNotice = announcements.find(item => !['maintenance','security'].includes(item.type));
    const dashboardNotice=document.getElementById('signal-dashboard-notice');
    if(!activeNotice)dashboardNotice?.remove();
    const notice = activeNotice&&localStorage.getItem(`signal_announcement_seen:${activeNotice.id}`)!=='1'?activeNotice:null;
    if(activeNotice&&!notice)renderSignalDashboardNotice(activeNotice);
    if (notice && !document.getElementById('signal-announcement-modal')) {
      document.body.insertAdjacentHTML('beforeend', `<div id="signal-announcement-modal" class="signal-announcement-modal" role="dialog" aria-modal="true" aria-label="Повідомлення Signal"><i class="notice-orb one" aria-hidden="true"></i><i class="notice-orb two" aria-hidden="true"></i><section class="signal-announcement-card"><span class="notice-logo"><img src="signal-premium-logo.png" alt="Signal"><i></i></span><div class="notice-badge"><i></i> Повідомлення Signal</div><h2>${signalEscapeHtml(notice.title||'Важливе повідомлення')}</h2><div class="notice-message">${signalEscapeHtml(notice.message).replace(/\n/g,'<br>')}</div><button id="signal-announcement-close" type="button">Зрозуміло</button></section></div>`);
      document.getElementById('signal-announcement-close').onclick = () => {
        localStorage.setItem(`signal_announcement_seen:${notice.id}`, '1');
        document.getElementById('signal-announcement-modal')?.remove();
        renderSignalDashboardNotice(notice);
      };
    }
  } catch (error) {
    document.documentElement.classList.remove('signal-maintenance-check');
    console.warn('Announcements are temporarily unavailable:', error.message);
  }
}
window.addEventListener('load', () => {
  checkAppAnnouncements();
  window.setInterval(checkAppAnnouncements, 5000);
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
    const forgotLabel=lockEnglish?'Forgot PIN?':'Забули PIN?',requestLabel=lockEnglish?'Send reset request':'Надіслати запит адміністратору';
    document.body.insertAdjacentHTML('beforeend', `<div id="lock" style="position:fixed;inset:0;z-index:99999;background:radial-gradient(circle at 50% -12%,#17356f 0,#080c1b 43%,#03050b 100%);color:white;display:grid;place-items:center;padding:22px;text-align:center;font-family:Inter,-apple-system,sans-serif;overflow:auto"><div style="position:relative;width:min(100%,390px);padding:30px 22px;border:1px solid #6685ff38;border-radius:30px;background:#090d1dee;box-shadow:0 28px 90px #000b,0 0 70px #3978ff20;backdrop-filter:blur(18px);overflow:hidden"><i aria-hidden="true" style="position:absolute;width:180px;height:180px;border-radius:50%;background:#25d9ff18;filter:blur(12px);top:-90px;left:-70px;animation:signalPinGlow 4s ease-in-out infinite"></i><img src="/signal-premium-logo.png" alt="Signal" width="78" height="78" style="position:relative;display:block;margin:auto;border-radius:22px;box-shadow:0 15px 45px #2d79ff55"><div id="lockTitle" style="position:relative;font:700 27px Space Grotesk,sans-serif;margin-top:18px">${lockTitle}</div><p id="lockHint" style="color:#aebbd5;line-height:1.5;margin:8px 0 0">${lockHint}</p><div id="pinEntry"><div id="pinDots" style="display:flex;justify-content:center;gap:11px;margin:22px 0 18px">${'<span style="width:13px;height:13px;border:1.5px solid #7d8caf;border-radius:50%;transition:.15s"></span>'.repeat(6)}</div><input id="pin" inputmode="numeric" maxlength="6" type="password" autocomplete="off" aria-label="PIN" style="position:absolute;opacity:0;pointer-events:none"><div id="pinPad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px;max-width:286px;margin:auto">${[1,2,3,4,5,6,7,8,9].map(n=>`<button type="button" data-pin="${n}" style="height:54px;border:1px solid #7183af3d;border-radius:16px;background:#ffffff09;color:#f7f9ff;font:700 20px Space Grotesk;cursor:pointer;touch-action:manipulation">${n}</button>`).join('')}<button type="button" data-action="clear" style="height:54px;border:0;background:transparent;color:#8e9ab4;font-size:11px;font-weight:700">${lockDelete}</button><button type="button" data-pin="0" style="height:54px;border:1px solid #7183af3d;border-radius:16px;background:#ffffff09;color:#f7f9ff;font:700 20px Space Grotesk;cursor:pointer;touch-action:manipulation">0</button><button type="button" data-action="back" aria-label="${lockDelete}" style="height:54px;border:0;background:transparent;color:#cbd4e8;font-size:23px">⌫</button></div><p id="pinError" style="min-height:18px;color:#ff7185;font-size:12px;margin:11px 0 0"></p><button id="forgotPin" type="button" style="display:inline-flex;align-items:center;gap:8px;justify-content:center;border:1px solid #607cff4a;border-radius:14px;padding:11px 16px;background:linear-gradient(135deg,#172649cc,#15132ccc);color:#bfe9ff;font-weight:800;cursor:pointer;box-shadow:0 10px 28px #0005"><span aria-hidden="true">◇</span>${forgotLabel}</button></div><div id="pinRecovery" hidden style="position:relative;margin-top:20px;padding:18px;border:1px solid #56cfff42;border-radius:20px;background:linear-gradient(145deg,#11213bd9,#15112fd9);box-shadow:inset 0 1px #ffffff0c,0 18px 40px #0005"><div style="width:48px;height:48px;margin:0 auto 11px;border-radius:15px;display:grid;place-items:center;background:linear-gradient(135deg,#27d7ff,#7358ff);box-shadow:0 0 28px #3b9cff66;font-size:23px">⌁</div><b id="pinRecoveryTitle" style="display:block;font-size:17px">${lockEnglish?'PIN recovery':'Відновлення PIN'}</b><p id="pinRecoveryText" style="color:#adbad2;font-size:13px;line-height:1.55;margin:8px 0 14px">${lockEnglish?'The administrator will verify your request. Your old PIN is never sent.':'Адміністратор перевірить запит. Старий PIN нікому не передається.'}</p><button id="requestPinReset" type="button" style="width:100%;border:0;border-radius:14px;padding:13px;background:linear-gradient(135deg,#278cff,#8258ff);color:white;font-weight:800;cursor:pointer">${requestLabel}</button><button id="backToPin" type="button" style="margin-top:10px;border:0;background:transparent;color:#91a0bd;font-weight:700;cursor:pointer">${lockEnglish?'Back to PIN':'Повернутися до PIN'}</button></div><div id="newPinPanel" hidden style="position:relative;margin-top:20px"><div style="width:56px;height:56px;margin:auto;border-radius:18px;display:grid;place-items:center;background:linear-gradient(135deg,#2ce6c2,#477cff);box-shadow:0 0 34px #2ce6c255;font-size:26px">✓</div><h2 style="font-size:20px;margin:13px 0 5px">${lockEnglish?'Create a new PIN':'Створіть новий PIN'}</h2><p style="color:#aebbd5;font-size:13px;line-height:1.5;margin:0 0 14px">${lockEnglish?'Approval is valid for 30 minutes.':'Підтвердження діє 30 хвилин.'}</p><input id="newPin" inputmode="numeric" maxlength="6" type="password" autocomplete="new-password" placeholder="••••••" style="box-sizing:border-box;width:100%;padding:14px;text-align:center;letter-spacing:10px;border:1px solid #6e82b84d;border-radius:14px;background:#ffffff0b;color:white;font-size:22px;outline:none"><input id="confirmNewPin" inputmode="numeric" maxlength="6" type="password" autocomplete="new-password" placeholder="••••••" style="box-sizing:border-box;width:100%;padding:14px;margin-top:10px;text-align:center;letter-spacing:10px;border:1px solid #6e82b84d;border-radius:14px;background:#ffffff0b;color:white;font-size:22px;outline:none"><button id="saveNewPin" type="button" style="width:100%;margin-top:12px;border:0;border-radius:14px;padding:14px;background:linear-gradient(135deg,#22d3b6,#4a76ff);color:white;font-weight:800">${lockEnglish?'Save new PIN':'Зберегти новий PIN'}</button><p id="newPinError" style="min-height:18px;color:#ff8393;font-size:12px;margin:10px 0 0"></p></div><style>@keyframes signalPinGlow{50%{transform:translate(115px,28px) scale(1.12);opacity:.65}}@media(prefers-reduced-motion:reduce){#lock *{animation:none!important}}</style></div></div>`);
    const input = document.getElementById('pin');
    const drawPin=()=>document.querySelectorAll('#pinDots span').forEach((dot,index)=>{const filled=index<input.value.length;dot.style.background=filled?'#6d70ff':'transparent';dot.style.borderColor=filled?'#7f7dff':'#7d8caf';dot.style.boxShadow=filled?'0 0 16px #5d73ff88':'none';});
    document.querySelectorAll('#pinPad [data-pin]').forEach(button=>button.onclick=()=>{if(input.value.length<6){input.value+=button.dataset.pin;drawPin();input.dispatchEvent(new Event('input'));}});
    document.querySelector('#pinPad [data-action="back"]').onclick=()=>{input.value=input.value.slice(0,-1);drawPin();};
    document.querySelector('#pinPad [data-action="clear"]').onclick=()=>{input.value='';drawPin();};
    const lockKeyHandler=event=>{if(/^\d$/.test(event.key)&&input.value.length<6){input.value+=event.key;drawPin();input.dispatchEvent(new Event('input'));}else if(event.key==='Backspace'){input.value=input.value.slice(0,-1);drawPin();}};
    document.addEventListener('keydown',lockKeyHandler);
    const pinEntry=document.getElementById('pinEntry'),recovery=document.getElementById('pinRecovery'),newPinPanel=document.getElementById('newPinPanel'),requestButton=document.getElementById('requestPinReset');
    let recoveryTimer=null;
    const showRecovery=()=>{pinEntry.hidden=true;newPinPanel.hidden=true;recovery.hidden=false;};
    const showPin=()=>{recovery.hidden=true;newPinPanel.hidden=true;pinEntry.hidden=false;};
    const showNewPin=()=>{pinEntry.hidden=true;recovery.hidden=true;newPinPanel.hidden=false;document.getElementById('newPin').focus();};
    const renderResetStatus=request=>{
      const title=document.getElementById('pinRecoveryTitle'),copy=document.getElementById('pinRecoveryText');
      if(request?.status==='approved'){showNewPin();return;}
      if(request?.status==='pending'){showRecovery();title.textContent=lockEnglish?'Request sent':'Запит надіслано';copy.textContent=lockEnglish?'Waiting for the administrator. This screen will update automatically.':'Очікуємо підтвердження адміністратора. Цей екран оновиться автоматично.';requestButton.disabled=true;requestButton.textContent=lockEnglish?'Waiting for approval…':'Очікуємо підтвердження…';return;}
      showRecovery();requestButton.disabled=false;requestButton.textContent=requestLabel;
      if(request?.status==='denied'){title.textContent=lockEnglish?'Request not approved':'Запит не підтверджено';copy.textContent=lockEnglish?'Contact support or send a new request.':'Зверніться в підтримку або надішліть новий запит.';}
      if(request?.status==='expired'){title.textContent=lockEnglish?'Approval expired':'Час підтвердження минув';copy.textContent=lockEnglish?'Send a new request to reset the PIN.':'Надішліть новий запит на скидання PIN.';}
    };
    const checkResetStatus=async()=>{try{const response=await fetch(`${API_URL}/api/account/lock/reset-request`,{headers:{'x-session-token':token},cache:'no-store'}),data=await response.json();if(response.ok&&data.request)renderResetStatus(data.request);}catch{}};
    document.getElementById('forgotPin').onclick=()=>{showRecovery();checkResetStatus();};
    document.getElementById('backToPin').onclick=showPin;
    requestButton.onclick=async()=>{requestButton.disabled=true;requestButton.textContent=lockEnglish?'Sending…':'Надсилаємо…';try{const response=await fetch(`${API_URL}/api/account/lock/reset-request`,{method:'POST',headers:{'Content-Type':'application/json','x-session-token':token},body:'{}'}),data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');renderResetStatus(data.request);}catch(error){requestButton.disabled=false;requestButton.textContent=requestLabel;document.getElementById('pinRecoveryText').textContent=error.message;}};
    document.getElementById('saveNewPin').onclick=async()=>{const pin=document.getElementById('newPin').value,confirmation=document.getElementById('confirmNewPin').value,errorBox=document.getElementById('newPinError'),button=document.getElementById('saveNewPin');errorBox.textContent='';if(!/^\d{6}$/.test(pin)){errorBox.textContent=lockEnglish?'Enter exactly 6 digits.':'Введіть рівно 6 цифр.';return;}if(pin!==confirmation){errorBox.textContent=lockEnglish?'PINs do not match.':'PIN-коди не збігаються.';return;}button.disabled=true;button.textContent=lockEnglish?'Saving…':'Зберігаємо…';try{const response=await fetch(`${API_URL}/api/account/lock/reset-complete`,{method:'POST',headers:{'Content-Type':'application/json','x-session-token':token},body:JSON.stringify({pin,confirmation})}),data=await response.json();if(!response.ok)throw Error(data.error||'Reset failed');sessionStorage.setItem(unlockKey,'1');clearInterval(recoveryTimer);document.removeEventListener('keydown',lockKeyHandler);document.getElementById('lock')?.remove();}catch(error){errorBox.textContent=error.message;button.disabled=false;button.textContent=lockEnglish?'Save new PIN':'Зберегти новий PIN';}};
    recoveryTimer=setInterval(()=>{if(document.getElementById('lock'))checkResetStatus();else clearInterval(recoveryTimer);},7000);
    if(lock.resetApproved){showNewPin();}else checkResetStatus();
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
        clearInterval(recoveryTimer);
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
