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
