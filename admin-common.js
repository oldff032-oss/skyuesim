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
