// Shared admin navigation and authenticated API helper.
function requireAdminAuth(){
  const token=localStorage.getItem('signal_admin_token');
  if(!token){location.href='admin-login.html';return;}
  const role=localStorage.getItem('signal_admin_role');
  const nav=document.querySelector('.admin-nav');
  if(!nav)return;
  const links=[
    ['admin-dashboard.html','📊 Dashboard'],
    ['admin-control-center.html','🎛️ Центр керування'],
    ['admin-tickets.html','🎫 Підтримка'],
    ['admin-users.html','👥 Користувачі'],
    ['admin-purchases.html','🧾 Покупки'],
    ['admin-plan-changes.html','🔄 Зміни тарифів'],
    ['admin-operations.html','⚙️ Операції'],
    ['admin-feedback.html','⭐ Відгуки'],
    ['admin-notifications.html','🔔 Сповіщення'],
    ['admin-security.html','🔐 Безпека'],
    ...(role==='super_admin'?[
      ['admin-diagnostics.html','🩺 Діагностика'],
      ['admin-error-guide.html','📘 Довідник помилок'],
      ['admin-email-broadcasts.html','✉️ Email-розсилки'],
      ['admin-team.html','🔑 Команда'],
      ['admin-audit.html','🛡️ Журнал дій'],
      ['admin-backup.html','🗄️ Резервні копії'],
      ['admin-security-incident.html','🚨 Захист системи']
    ]:[]),
    ['admin-guide.html','📚 Інструкції']
  ];
  const current=location.pathname.split('/').pop()||'admin-dashboard.html';
  nav.innerHTML=links.map(([href,label])=>`<a href="${href}"${current===href?' class="active"':''}>${label}</a>`).join('')+'<a href="#" onclick="logout();return false">⏏ Вийти</a>';
  requestAnimationFrame(()=>nav.querySelector('.active')?.scrollIntoView({block:'nearest'}));
}

async function adminFetch(path,options={}){
  const token=localStorage.getItem('signal_admin_token');
  const res=await fetch(`${API_URL}${path}`,{...options,headers:{'Content-Type':'application/json','X-Admin-Token':token,...(options.headers||{})}});
  if(res.status===401){localStorage.removeItem('signal_admin_token');location.href='admin-login.html';throw new Error('Сесія завершена');}
  return res;
}

function logout(){
  localStorage.removeItem('signal_admin_token');
  localStorage.removeItem('signal_admin_role');
  localStorage.removeItem('signal_admin_email');
  location.href='admin-login.html';
}
