// services/authService.js
//
// Логіка автентифікації: email -> код -> пароль -> акаунт, і логін.
// Паролі зберігаються ТІЛЬКИ як bcrypt-хеш, ніколи у відкритому вигляді.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readAll, writeAll } = require('./authStore');
const { getUser, saveUser } = require('./db');
const { sendVerificationCode } = require('./emailService');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 хвилин
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 секунд між повторними надсиланнями
const MAX_ATTEMPTS = 5;
const VERIFY_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 хвилин на встановлення пароля після коду
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 днів

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 цифр
}
function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(store, email, deviceName) {
  const sessionToken = randomToken();
  store.sessions[sessionToken] = {
    email,
    createdAt: Date.now(),
    deviceName: String(deviceName || 'Цей пристрій').slice(0, 120),
  };
  return sessionToken;
}

// ---------- Крок 1: запит коду ----------
async function requestCode(email) {
  const store = readAll();
  const existing = store.codes[email];

  if (existing && Date.now() - existing.sentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000);
    throw Object.assign(new Error(`Зачекай ${waitSec} сек перед повторним надсиланням`), { code: 'COOLDOWN', waitSec });
  }

  const code = randomCode();
  store.codes[email] = { code, sentAt: Date.now(), attempts: 0 };
  writeAll(store);

  await sendVerificationCode(email, code);
  return { sent: true };
}

// ---------- Крок 2: перевірка коду ----------
function verifyCode(email, code) {
  const store = readAll();
  const entry = store.codes[email];

  if (!entry) throw Object.assign(new Error('Код не запитувався або вже використаний'), { code: 'NO_CODE' });
  if (Date.now() - entry.sentAt > CODE_TTL_MS) throw Object.assign(new Error('Код прострочено'), { code: 'EXPIRED' });
  if (entry.attempts >= MAX_ATTEMPTS) throw Object.assign(new Error('Забагато спроб, запроси новий код'), { code: 'TOO_MANY_ATTEMPTS' });

  entry.attempts += 1;

  if (entry.code !== code) {
    writeAll(store);
    throw Object.assign(new Error('Невірний код'), { code: 'WRONG_CODE' });
  }

  // Код правильний -> видаємо тимчасовий токен для встановлення пароля
  delete store.codes[email];
  const verifyToken = randomToken();
  store.verifyTokens[verifyToken] = { email, createdAt: Date.now() };
  writeAll(store);

  return { verifyToken };
}

// ---------- Крок 3: встановлення пароля / створення акаунта ----------
async function setPassword(verifyToken, password, deviceName) {
  const store = readAll();
  const entry = store.verifyTokens[verifyToken];

  if (!entry) throw Object.assign(new Error('Недійсний або вже використаний токен'), { code: 'INVALID_TOKEN' });
  if (Date.now() - entry.createdAt > VERIFY_TOKEN_TTL_MS) throw Object.assign(new Error('Токен прострочено, почни реєстрацію заново'), { code: 'TOKEN_EXPIRED' });
  if (password.length < 8) throw Object.assign(new Error('Пароль має бути не менше 8 символів'), { code: 'WEAK_PASSWORD' });

  const passwordHash = await bcrypt.hash(password, 10);
  store.users[entry.email] = { email: entry.email, passwordHash, createdAt: Date.now() };
  // Keep the account visible immediately after registration, but never replace
  // an existing subscription/eSIM when an account is restored with the same email.
  if (!getUser(entry.email)) {
    saveUser(entry.email, { email: entry.email, status: 'registered', createdAt: new Date().toISOString() });
  }
  delete store.verifyTokens[verifyToken];

  const sessionToken = createSession(store, entry.email, deviceName);
  writeAll(store);

  return { sessionToken, email: entry.email };
}

// ---------- Логін ----------
async function login(email, password, deviceName) {
  const store = readAll();
  const user = store.users[email];
  if (!user) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID_CREDENTIALS' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID_CREDENTIALS' });

  const sessionToken = createSession(store, email, deviceName);
  user.lastLoginAt = new Date().toISOString();
  writeAll(store);

  return { sessionToken, email };
}

// ---------- Перевірка сесії (для захищених маршрутів) ----------
function getSessionEmail(sessionToken) {
  const store = readAll();
  const session = store.sessions[sessionToken];
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) return null;
  return session.email;
}

function listSessions(email, currentToken) {
  const store = readAll();
  return Object.entries(store.sessions)
    .filter(([, session]) => session.email === email && Date.now() - session.createdAt <= SESSION_TTL_MS)
    .map(([token, session]) => ({
      id: token === currentToken ? 'current' : token.slice(-8),
      current: token === currentToken,
      deviceName: session.deviceName || 'Пристрій',
      createdAt: new Date(session.createdAt).toISOString(),
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || new Date(b.createdAt) - new Date(a.createdAt));
}

function revokeOtherSessions(email, currentToken) {
  const store = readAll();
  let revoked = 0;
  for (const [token, session] of Object.entries(store.sessions)) {
    if (token !== currentToken && session.email === email) {
      delete store.sessions[token];
      revoked += 1;
    }
  }
  writeAll(store);
  return revoked;
}

module.exports = { requestCode, verifyCode, setPassword, login, getSessionEmail, listSessions, revokeOtherSessions, requestPasswordReset, verifyResetCode, resetPassword };

// ---------- Забув(ла) пароль: запит коду ----------
async function requestPasswordReset(email) {
  const store = readAll();
  store.resetCodes = store.resetCodes || {};
  const existing = store.resetCodes[email];

  if (existing && Date.now() - existing.sentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000);
    throw Object.assign(new Error(`Зачекай ${waitSec} сек перед повторним надсиланням`), { code: 'COOLDOWN', waitSec });
  }

  // Навмисно НЕ повідомляємо, чи існує акаунт з таким email (захист від
  // перебору email-адрес) — завжди повертаємо "sent: true", але лист
  // реально шлемо тільки якщо акаунт справді є.
  if (store.users[email]) {
    const code = randomCode();
    store.resetCodes[email] = { code, sentAt: Date.now(), attempts: 0 };
    writeAll(store);
    await sendVerificationCode(email, code);
  }

  return { sent: true };
}

// ---------- Забув(ла) пароль: перевірка коду ----------
function verifyResetCode(email, code) {
  const store = readAll();
  store.resetCodes = store.resetCodes || {};
  const entry = store.resetCodes[email];

  if (!entry) throw Object.assign(new Error('Код не запитувався або вже використаний'), { code: 'NO_CODE' });
  if (Date.now() - entry.sentAt > CODE_TTL_MS) throw Object.assign(new Error('Код прострочено'), { code: 'EXPIRED' });
  if (entry.attempts >= MAX_ATTEMPTS) throw Object.assign(new Error('Забагато спроб, запроси новий код'), { code: 'TOO_MANY_ATTEMPTS' });

  entry.attempts += 1;

  if (entry.code !== code) {
    writeAll(store);
    throw Object.assign(new Error('Невірний код'), { code: 'WRONG_CODE' });
  }

  delete store.resetCodes[email];
  store.resetTokens = store.resetTokens || {};
  const resetToken = randomToken();
  store.resetTokens[resetToken] = { email, createdAt: Date.now() };
  writeAll(store);

  return { resetToken };
}

// ---------- Забув(ла) пароль: встановлення нового пароля ----------
async function resetPassword(resetToken, newPassword) {
  const store = readAll();
  store.resetTokens = store.resetTokens || {};
  const entry = store.resetTokens[resetToken];

  if (!entry) throw Object.assign(new Error('Недійсний або вже використаний токен'), { code: 'INVALID_TOKEN' });
  if (Date.now() - entry.createdAt > VERIFY_TOKEN_TTL_MS) throw Object.assign(new Error('Токен прострочено, почни спочатку'), { code: 'TOKEN_EXPIRED' });
  if (newPassword.length < 8) throw Object.assign(new Error('Пароль має бути не менше 8 символів'), { code: 'WEAK_PASSWORD' });
  if (!store.users[entry.email]) throw Object.assign(new Error('Акаунт не знайдено'), { code: 'NO_USER' });

  store.users[entry.email].passwordHash = await bcrypt.hash(newPassword, 10);
  delete store.resetTokens[resetToken];
  writeAll(store);

  return { ok: true };
}
