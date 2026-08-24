// Shared admin navigation and authenticated API helper.
function requireAdminAuth(){
  const token=localStorage.getItem('signal_admin_token');
  if(!token){location.href='admin-login.html';return;}
  const role=localStorage.getItem('signal_admin_role'),nav=document.querySelector('.admin-nav');
  if(!nav)return;
  const svg=paths=>`<span class="admin-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>`;
  const links=[
    ['admin-dashboard.html',svg('<path d="M3 11.5 12 4l9 7.5M5.5 10.5V20h13v-9.5"/>')+'Огляд'],
    ['admin-users.html',svg('<circle cx="9" cy="8" r="4"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0M16 5.5a3.5 3.5 0 0 1 0 7M17 15a6 6 0 0 1 4.5 6"/>')+'Клієнти'],
    ['admin-purchases.html',svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>')+'Замовлення й оплати'],
    ['admin-mobile-topups.html',svg('<path d="M5 8.5a10 10 0 0 1 14 0M8 12a6 6 0 0 1 8 0M11 15.5a2 2 0 0 1 2 0"/><path d="M12 19h.01"/>')+'Поповнення SIM'],
    ['admin-tickets.html',svg('<path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-3v-7h5M4 13v5a2 2 0 0 0 2 2h3v-7H4"/>')+'Підтримка'],
    ['admin-operations.html',svg('<path d="M4 6h16v12H4zM4 9l8 5 8-5"/><path d="M17.5 3.5 20 6l-2.5 2.5"/>')+'Повідомлення й технічні роботи'],
    ['admin-control-center.html',svg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>')+'Операційний центр'],
    ...(role==='super_admin'?[[ 'admin-team.html',svg('<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>')+'Команда й безпека' ]]:[])
  ];
  const tools=[['admin-security.html','Моя 2FA'],...(role==='super_admin'?[['admin-diagnostics.html','Діагностика'],['admin-email-broadcasts.html','Email-розсилки'],['admin-audit.html','Журнал дій'],['admin-backup.html','Резервні копії'],['admin-security-incident.html','Захист системи']]:[])];
  const current=location.pathname.split('/').pop()||'admin-dashboard.html';
  nav.innerHTML=links.map(([href,label])=>`<a href="${href}"${current===href?' class="active"':''}>${label}</a>`).join('')+`<details${tools.some(([href])=>href===current)?' open':''}><summary>${svg('<path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-8.4 8.4a2 2 0 1 0 2.8 2.8l8.4-8.4 2.1 2.1a4 4 0 0 0-2-2Z"/>')}Інструменти</summary>${tools.map(([href,label])=>`<a href="${href}"${current===href?' class="active"':''}>${label}</a>`).join('')}</details>`+`<a href="#" onclick="logout();return false">${svg('<path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/>')}Вийти</a>`;
  requestAnimationFrame(()=>nav.querySelector('.active')?.scrollIntoView({block:'nearest'}));
}
async function adminFetch(path,options={}){const token=localStorage.getItem('signal_admin_token');const res=await fetch(`${API_URL}${path}`,{...options,headers:{'Content-Type':'application/json','X-Admin-Token':token,...(options.headers||{})}});if(res.status===401){localStorage.removeItem('signal_admin_token');location.href='admin-login.html';throw new Error('Сесія завершена');}return res;}
function logout(){localStorage.removeItem('signal_admin_token');localStorage.removeItem('signal_admin_role');localStorage.removeItem('signal_admin_email');location.href='admin-login.html';}
