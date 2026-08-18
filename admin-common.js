// admin-common.js
// Спільна логіка для всіх сторінок адмін-панелі.

function requireAdminAuth(){
  const token = localStorage.getItem('signal_admin_token');
  if(!token){ window.location.href = 'admin-login.html'; }
  const role = localStorage.getItem('signal_admin_role');
  const teamLink = document.getElementById('teamNavLink');
  const auditLink = document.getElementById('auditNavLink');
  if(role !== 'super_admin'){
    if(teamLink) teamLink.style.display = 'none';
    if(auditLink) auditLink.style.display = 'none';
  }
  const nav = document.querySelector('.admin-nav');
  if(nav && !document.getElementById('adminNotificationsNavLink')){
    const notifications=document.createElement('a');notifications.id='adminNotificationsNavLink';notifications.href='admin-notifications.html';notifications.textContent='🔔 Сповіщення';if(location.pathname.endsWith('/admin-notifications.html'))notifications.classList.add('active');nav.insertBefore(notifications,nav.querySelector('a[onclick="logout()"]')||null);
  }
  if(nav && !document.getElementById('adminSecurityNavLink')){const security=document.createElement('a');security.id='adminSecurityNavLink';security.href='admin-security.html';security.textContent='🔐 Безпека';if(location.pathname.endsWith('/admin-security.html'))security.classList.add('active');nav.insertBefore(security,nav.querySelector('a[onclick="logout()"]')||null);}
  if(nav && role === 'super_admin' && !document.getElementById('diagnosticsNavLink')){
    const diagnostics=document.createElement('a');diagnostics.id='diagnosticsNavLink';diagnostics.href='admin-diagnostics.html';diagnostics.textContent='🩺 Діагностика';if(location.pathname.endsWith('/admin-diagnostics.html'))diagnostics.classList.add('active');nav.insertBefore(diagnostics,nav.querySelector('a[onclick="logout()"]')||null);
  }
  if(nav && role === 'super_admin' && !document.getElementById('errorGuideNavLink')){const guide=document.createElement('a');guide.id='errorGuideNavLink';guide.href='admin-error-guide.html';guide.textContent='📘 Помилки';if(location.pathname.endsWith('/admin-error-guide.html'))guide.classList.add('active');nav.insertBefore(guide,nav.querySelector('a[onclick="logout()"]')||null);}
  if(nav && role === 'super_admin' && !document.getElementById('emailBroadcastsNavLink')){const mail=document.createElement('a');mail.id='emailBroadcastsNavLink';mail.href='admin-email-broadcasts.html';mail.textContent='✉️ Email-розсилки';if(location.pathname.endsWith('/admin-email-broadcasts.html'))mail.classList.add('active');nav.insertBefore(mail,nav.querySelector('a[onclick="logout()"]')||null);}
  if(nav && !document.getElementById('purchasesNavLink')){
    const purchases = document.createElement('a');
    purchases.id = 'purchasesNavLink';
    purchases.href = 'admin-purchases.html';
    purchases.textContent = '🧾 Покупки';
    if(window.location.pathname.endsWith('/admin-purchases.html')) purchases.classList.add('active');
    const operationsLink = [...nav.querySelectorAll('a')].find(link => link.getAttribute('href') === 'admin-operations.html');
    nav.insertBefore(purchases, operationsLink || nav.querySelector('a[onclick="logout()"]') || null);
  }
  if(nav && !document.getElementById('guideNavLink')){
    const guide = document.createElement('a');
    guide.id = 'guideNavLink';
    guide.href = 'admin-guide.html';
    guide.textContent = '📚 Інструкції';
    if(window.location.pathname.endsWith('/admin-guide.html')) guide.classList.add('active');
    const logoutLink = nav.querySelector('a[onclick="logout()"]');
    nav.insertBefore(guide, logoutLink || null);
  }
}

async function adminFetch(path, options = {}){
  const token = localStorage.getItem('signal_admin_token');
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': token,
      ...(options.headers || {}),
    },
  });
  if(res.status === 401){
    localStorage.removeItem('signal_admin_token');
    window.location.href = 'admin-login.html';
    throw new Error('Сесія завершена');
  }
  return res;
}

function logout(){
  localStorage.removeItem('signal_admin_token');
  localStorage.removeItem('signal_admin_role');
  localStorage.removeItem('signal_admin_email');
  window.location.href = 'admin-login.html';
}
