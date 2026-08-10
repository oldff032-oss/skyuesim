// services/adminAuthService.js
//
// Проста адмін-автентифікація на старт: один пароль з .env (ADMIN_PASSWORD).
// Коли будеш готовий(а) до кількох адмінів з різними ролями (Super Admin/
// Admin/Support/Viewer з ТЗ) — розширимо на повноцінні акаунти з хешованими
// паролями (як у authService.js) і полем role.

const crypto = require('crypto');

const sessions = {}; // { token: { createdAt } } — тримаємо в пам'яті, досить для одного адміна

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 годин

function login(password) {
  if (!process.env.ADMIN_PASSWORD) {
    throw Object.assign(new Error('ADMIN_PASSWORD не встановлено на сервері'), { code: 'NOT_CONFIGURED' });
  }
  if (password !== process.env.ADMIN_PASSWORD) {
    throw Object.assign(new Error('Невірний пароль'), { code: 'INVALID_PASSWORD' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { createdAt: Date.now() };
  return token;
}

function isValidSession(token) {
  const session = sessions[token];
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) { delete sessions[token]; return false; }
  return true;
}

// Middleware-функція для захисту адмін-маршрутів
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!isValidSession(token)) {
    return res.status(401).json({ error: 'Потрібен вхід в адмін-панель' });
  }
  next();
}

module.exports = { login, isValidSession, requireAdmin };
