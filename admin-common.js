// Shared admin navigation and authenticated API helper.
function requireAdminAuth(){
  const token=localStorage.getItem('signal_admin_token');
  if(!token){location.href='admin-login.html';return;}
  const role=localStorage.getItem('signal_admin_role'),nav=document.querySelector('.admin-nav');
  if(!nav)return;
  const svg=paths=>`<span class="admin-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>`;
  const current=location.pathname.split('/').pop()||'admin-dashboard.html';
  const contextSections=[
    {root:'admin-purchases.html',label:'Замовлення',pages:[['admin-purchases.html','Покупки'],['admin-plan-changes.html','Зміни тарифів'],['admin-mobile-topups.html','Поповнення SIM']]},
    {root:'admin-tickets.html',label:'Підтримка',pages:[['admin-tickets.html','Звернення'],['admin-feedback.html','Відгуки'],['admin-rescue.html','Порятунок']]},
    {root:'admin-operations.html',label:'Комунікації',pages:[['admin-operations.html','Технічні роботи'],['admin-notifications.html','Push-сповіщення'],['admin-email-broadcasts.html','Email-розсилки',true]]},
    {root:'admin-control-center.html',label:'Моніторинг',pages:[['admin-control-center.html','Стан системи'],['admin-diagnostics.html','Діагностика',true],['admin-error-guide.html','Довідник помилок',true],['admin-versions.html','Версії',true]]},
    {root:'admin-security.html',label:'Безпека',pages:[['admin-security.html','Моя 2FA'],['admin-team.html','Команда й доступ',true],['admin-audit.html','Журнал дій',true],['admin-backup.html','Резервні копії',true],['admin-security-incident.html','Захист системи',true]]}
  ];
  const allowed=page=>!page[2]||role==='super_admin';
  const currentSection=contextSections.find(section=>section.pages.some(page=>page[0]===current));
  const active=href=>current===href||currentSection?.root===href;
  const primary=[
    ['admin-dashboard.html',svg('<path d="M3 11.5 12 4l9 7.5M5.5 10.5V20h13v-9.5"/>')+'Огляд'],
    ['admin-users.html',svg('<circle cx="9" cy="8" r="4"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0M16 5.5a3.5 3.5 0 0 1 0 7M17 15a6 6 0 0 1 4.5 6"/>')+'Клієнти'],
    ['admin-purchases.html',svg('<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h4"/>')+'Замовлення'],
    ['admin-esims.html',svg('<rect x="5" y="2" width="14" height="20" rx="3"/><path d="M9 7h6v5H9zM9 16h.01M12 16h.01M15 16h.01"/>')+'Керування eSIM'],
    ['admin-tickets.html',svg('<path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-3v-7h5M4 13v5a2 2 0 0 0 2 2h3v-7H4"/>')+'Підтримка']
  ];
  const operations=[
    ['admin-travel.html',svg('<path d="M3 11.5h18M12 3c3 3 4.5 6 4.5 9S15 18 12 21c-3-3-4.5-6-4.5-9S9 6 12 3Z"/><path d="m15.5 7.5 5-3M18 6l2 2"/>')+'Подорожі'],
    ['admin-engagement.html',svg('<path d="M12 3 9.8 8.1 4 9l4.2 4.1-1 5.8 4.8-2.6 4.8 2.6-1-5.8L20 9l-5.8-.9L12 3Z"/>')+'Лояльність'],
    ['admin-operations.html',svg('<path d="M4 6h16v12H4zM4 9l8 5 8-5"/>')+'Комунікації'],
    ['admin-control-center.html',svg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>')+'Моніторинг'],
    ...(role==='super_admin'?[[ 'admin-pin-resets.html',svg('<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>')+'Відновлення PIN' ]]:[])
  ];
  const system=[['admin-security.html',svg('<path d="M12 3 5 6v5c0 4.8 2.8 8.2 7 10 4.2-1.8 7-5.2 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-5"/>')+'Безпека й доступ']];
  const renderLinks=items=>items.map(([href,label])=>`<a href="${href}"${active(href)?' class="active"':''}>${label}</a>`).join('');
  const renderGroup=(label,items,icon)=>`<details${items.some(([href])=>active(href))?' open':''}><summary>${svg(icon)}${label}</summary>${renderLinks(items)}</details>`;
  nav.innerHTML=renderLinks(primary)
    +renderGroup('Операції',operations,'<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>')
    +renderGroup('Система',system,'<path d="M12 3 5 6v5c0 4.8 2.8 8.2 7 10 4.2-1.8 7-5.2 7-10V6l-7-3Z"/>')
    +`<a href="#" onclick="logout();return false">${svg('<path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9"/>')}Вийти</a>`;
  if(currentSection){
    const pages=currentSection.pages.filter(allowed);
    const tabs=document.createElement('nav');
    tabs.className='admin-context-nav';
    tabs.setAttribute('aria-label',currentSection.label);
    tabs.innerHTML=pages.map(([href,label])=>`<a href="${href}"${current===href?' class="active" aria-current="page"':''}>${label}</a>`).join('');
    const title=document.querySelector('.admin-main h1');
    if(title)title.insertAdjacentElement('afterend',tabs);
  }
  requestAnimationFrame(()=>nav.querySelector('.active')?.scrollIntoView({block:'nearest'}));
}
async function adminFetch(path,options={}){const token=localStorage.getItem('signal_admin_token');const res=await fetch(`${API_URL}${path}`,{...options,headers:{'Content-Type':'application/json','X-Admin-Token':token,...(options.headers||{})}});if(res.status===401){localStorage.removeItem('signal_admin_token');location.href='admin-login.html';throw new Error('Сесія завершена');}return res;}
function logout(){localStorage.removeItem('signal_admin_token');localStorage.removeItem('signal_admin_role');localStorage.removeItem('signal_admin_email');location.href='admin-login.html';}
