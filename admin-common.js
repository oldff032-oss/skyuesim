// admin-common.js
// Спільна логіка для всіх сторінок адмін-панелі.

function requireAdminAuth(){
  const token = localStorage.getItem('signal_admin_token');
  if(!token){ window.location.href = 'admin-login.html'; }
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
  window.location.href = 'admin-login.html';
}
