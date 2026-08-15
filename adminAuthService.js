// services/adminAuthService.js
//
// Повноцінна автентифікація адмінів з ролями: Super Admin / Admin / Support /
// Viewer (як у ТЗ). Перший Super Admin створюється автоматично при старті
// сервера з SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD у .env. Далі Super
// Admin створює інших адмінів через розділ "Команда" в панелі.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { readAll, writeAll } = require('./adminStore');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 годин

// Викликається один раз при старті сервера
async function bootstrap() {
  const store = readAll();
  if (Object.keys(store.admins).length === 0 && process.env.SUPER_ADMIN_EMAIL && process.env.SUPER_ADMIN_PASSWORD) {
    const passwordHash = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD, 10);
    store.admins[process.env.SUPER_ADMIN_EMAIL] = { passwordHash, role: 'super_admin', createdAt: new Date().toISOString() };
    writeAll(store);
    console.log(`[adminAuth] Створено Super Admin: ${process.env.SUPER_ADMIN_EMAIL}`);
  }
}

async function login(email, password) {
  const store = readAll();
  const admin = store.admins[email];
  if (!admin) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID' });
  if (admin.blocked) throw Object.assign(new Error('Обліковий запис адміністратора заблоковано'), { code: 'BLOCKED' });

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID' });

  const token = crypto.randomBytes(32).toString('hex');
  admin.lastLoginAt = new Date().toISOString();
  store.sessions[token] = { email, role: admin.role, createdAt: Date.now() };
  writeAll(store);
  return { token, role: admin.role, email };
}

function getSession(token) {
  const store = readAll();
  const session = store.sessions[token];
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) return null;
  return session;
}

// Middleware: перевіряє, що адмін залогінений (будь-яка роль)
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Потрібен вхід в адмін-панель' });
  req.admin = session;
  next();
}

// Middleware-фабрика: перевіряє, що роль адміна входить у дозволений список
// Використання: requireAdmin, requireRole('super_admin')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ error: 'Недостатньо прав для цієї дії' });
    }
    next();
  };
}

async function createAdmin({ email, password, role }) {
  const store = readAll();
  if (store.admins[email]) throw Object.assign(new Error('Адмін з таким email вже існує'), { code: 'EXISTS' });
  if (!['super_admin', 'admin', 'support', 'viewer'].includes(role)) {
    throw Object.assign(new Error('Невідома роль'), { code: 'INVALID_ROLE' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  store.admins[email] = { passwordHash, role, createdAt: new Date().toISOString() };
  writeAll(store);
}

function listAdmins() {
  const store = readAll();
  return Object.entries(store.admins).map(([email, a]) => ({
    email,
    role: a.role,
    createdAt: a.createdAt,
    lastLoginAt: a.lastLoginAt || null,
    blocked: Boolean(a.blocked),
    blockedAt: a.blockedAt || null,
  }));
}

function revokeSessions(store, email) {
  for (const [token, session] of Object.entries(store.sessions)) {
    if (session.email === email) delete store.sessions[token];
  }
}

function setAdminBlocked({ email, blocked, actorEmail }) {
  const store = readAll();
  const admin = store.admins[email];
  if (!admin) throw Object.assign(new Error('Адміністратора не знайдено'), { code: 'NOT_FOUND' });
  if (email === actorEmail) throw Object.assign(new Error('Не можна заблокувати власний обліковий запис'), { code: 'SELF_ACTION' });
  if (admin.role === 'super_admin') throw Object.assign(new Error('Super Admin не можна блокувати'), { code: 'PROTECTED_ADMIN' });
  admin.blocked = Boolean(blocked);
  admin.blockedAt = blocked ? new Date().toISOString() : null;
  if (blocked) revokeSessions(store, email);
  writeAll(store);
  return { email, blocked: admin.blocked };
}

function deleteAdmin({ email, actorEmail }) {
  const store = readAll();
  const admin = store.admins[email];
  if (!admin) throw Object.assign(new Error('Адміністратора не знайдено'), { code: 'NOT_FOUND' });
  if (email === actorEmail) throw Object.assign(new Error('Не можна видалити власний обліковий запис'), { code: 'SELF_ACTION' });
  if (admin.role === 'super_admin') throw Object.assign(new Error('Super Admin не можна видалити'), { code: 'PROTECTED_ADMIN' });
  delete store.admins[email];
  revokeSessions(store, email);
  writeAll(store);
}

module.exports = { bootstrap, login, requireAdmin, requireRole, createAdmin, listAdmins, setAdminBlocked, deleteAdmin };
