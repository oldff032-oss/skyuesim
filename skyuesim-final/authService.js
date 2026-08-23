// services/authService.js
//
// Логіка автентифікації: email -> код -> пароль -> акаунт, і логін.
// Паролі зберігаються ТІЛЬКИ як bcrypt-хеш, ніколи у відкритому вигляді.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { readAll, writeAll } = require('./authStore');
const { getUser, saveUser, getAllUsers, deleteUser } = require('./db');
const { sendVerificationCode } = require('./emailService');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 хвилин
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 секунд між повторними надсиланнями
const MAX_ATTEMPTS = 5;
const VERIFY_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 хвилин на встановлення пароля після коду
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 днів

function randomCode() {
  return String(crypto.randomInt(100000,1000000));
}
function normalizeEmail(email){return String(email||'').trim().toLowerCase();}
function verificationCodeHash(email,code){const secret=String(process.env.AUTH_CODE_PEPPER||process.env.ADMIN_RECOVERY_SECRET||process.env.BACKUP_ENCRYPTION_KEY||'signal-local-development');return crypto.createHmac('sha256',secret).update(`${normalizeEmail(email)}:${String(code||'')}`).digest('hex');}
function codeMatches(email,entry,code){if(entry.codeHash){const expected=Buffer.from(entry.codeHash,'hex'),actual=Buffer.from(verificationCodeHash(email,code),'hex');return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);}return entry.code===String(code||'');}
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
async function requestCode(email, language = 'uk', referralCode = '', profile = {}) {
  email=normalizeEmail(email);
  const store = readAll();
  const existing = store.codes[email];

  if (existing && Date.now() - existing.sentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000);
    throw Object.assign(new Error(`Зачекай ${waitSec} сек перед повторним надсиланням`), { code: 'COOLDOWN', waitSec });
  }

  const code = randomCode();
  const displayName = String(profile?.displayName || existing?.displayName || '').trim().slice(0, 60);
  const avatarDataUrl = typeof profile?.avatarDataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(profile.avatarDataUrl) && profile.avatarDataUrl.length <= 700000 ? profile.avatarDataUrl : (existing?.avatarDataUrl || null);
  store.codes[email] = { codeHash:verificationCodeHash(email,code), sentAt: Date.now(), attempts: 0, language: language === 'en' ? 'en' : 'uk', referralCode: String(referralCode || existing?.referralCode || '').trim().toUpperCase().slice(0, 32), displayName, avatarDataUrl };
  writeAll(store);

  await sendVerificationCode(email, code);
  return { sent: true };
}

// ---------- Крок 2: перевірка коду ----------
function verifyCode(email, code) {
  email=normalizeEmail(email);
  const store = readAll();
  const entry = store.codes[email];

  if (!entry) throw Object.assign(new Error('Код не запитувався або вже використаний'), { code: 'NO_CODE' });
  if (Date.now() - entry.sentAt > CODE_TTL_MS) throw Object.assign(new Error('Код прострочено'), { code: 'EXPIRED' });
  if (entry.attempts >= MAX_ATTEMPTS) throw Object.assign(new Error('Забагато спроб, запроси новий код'), { code: 'TOO_MANY_ATTEMPTS' });

  entry.attempts += 1;

  if (!codeMatches(email,entry,code)) {
    writeAll(store);
    throw Object.assign(new Error('Невірний код'), { code: 'WRONG_CODE' });
  }

  // Код правильний -> видаємо тимчасовий токен для встановлення пароля
  delete store.codes[email];
  const verifyToken = randomToken();
  store.verifyTokens[verifyToken] = { email, language: entry.language || 'uk', referralCode: entry.referralCode || '', displayName: entry.displayName || '', avatarDataUrl: entry.avatarDataUrl || null, createdAt: Date.now() };
  writeAll(store);

  return { verifyToken };
}

// ---------- Крок 3: встановлення пароля / створення акаунта ----------
async function setPassword(verifyToken, password, deviceName, pin) {
  const store = readAll();
  const entry = store.verifyTokens[verifyToken];

  if (!entry) throw Object.assign(new Error('Недійсний або вже використаний токен'), { code: 'INVALID_TOKEN' });
  if (Date.now() - entry.createdAt > VERIFY_TOKEN_TTL_MS) throw Object.assign(new Error('Токен прострочено, почни реєстрацію заново'), { code: 'TOKEN_EXPIRED' });
  if (password.length < 8) throw Object.assign(new Error('Пароль має бути не менше 8 символів'), { code: 'WEAK_PASSWORD' });
  if (!/^\d{6}$/.test(String(pin || ''))) throw Object.assign(new Error('PIN має містити рівно 6 цифр'), { code: 'INVALID_PIN' });

  const passwordHash = await bcrypt.hash(password, 10);
  store.users[entry.email] = { email: entry.email, passwordHash, createdAt: Date.now() };
  // Keep the account visible immediately after registration, but never replace
  // an existing subscription/eSIM when an account is restored with the same email.
  if (!getUser(entry.email)) {
    const inviter = Object.values(getAllUsers()).find((user) => user.referralCode && user.referralCode === entry.referralCode && user.email !== entry.email);
    saveUser(entry.email, { email: entry.email, status: 'registered', language: entry.language || 'uk', displayName: entry.displayName || '', avatarDataUrl: entry.avatarDataUrl || null, appLock: { enabled: true, pinHash: await bcrypt.hash(String(pin), 10) }, createdAt: new Date().toISOString(), ...(inviter ? { referredBy: inviter.email, referralRewardStatus: 'pending_first_payment' } : {}) });
    if (inviter) saveUser(inviter.email, { referrals: [...(inviter.referrals || []), { email: entry.email, createdAt: new Date().toISOString(), status: 'pending_first_payment' }] });
  } else {
    saveUser(entry.email, { language: entry.language || 'uk' });
  }
  delete store.verifyTokens[verifyToken];

  const sessionToken = createSession(store, entry.email, deviceName);
  writeAll(store);

  return { sessionToken, email: entry.email, language: getUser(entry.email)?.language || entry.language || 'uk' };
}

// ---------- Логін ----------
async function login(email, password, deviceName) {
  email=normalizeEmail(email);
  const store = readAll();
  const user = store.users[email];
  if (!user) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID_CREDENTIALS' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID_CREDENTIALS' });

  const sessionToken = createSession(store, email, deviceName);
  user.lastLoginAt = new Date().toISOString();
  writeAll(store);

  return { sessionToken, email, language: getUser(email)?.language || 'uk' };
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

function revokeAllSessions(email) {
  const store = readAll();
  let revoked = 0;
  for (const [token, session] of Object.entries(store.sessions)) {
    if (session.email === email) {
      delete store.sessions[token];
      revoked += 1;
    }
  }
  writeAll(store);
  return revoked;
}

function deleteAccountAuth(email) {
  const store = readAll();
  const normalized = String(email || '').trim().toLowerCase();
  let sessions = 0;
  delete store.users[normalized];
  delete store.codes?.[normalized];
  delete store.resetCodes?.[normalized];
  for (const [token, entry] of Object.entries(store.sessions || {})) if (entry.email === normalized) { delete store.sessions[token]; sessions += 1; }
  for (const [token, entry] of Object.entries(store.verifyTokens || {})) if (entry.email === normalized) delete store.verifyTokens[token];
  for (const [token, entry] of Object.entries(store.resetTokens || {})) if (entry.email === normalized) delete store.resetTokens[token];
  for (const [token, entry] of Object.entries(store.adminRecoveryTokens || {})) if (entry.accountEmail === normalized) delete store.adminRecoveryTokens[token];
  writeAll(store);
  return { sessions };
}

async function updateAccount(email, changes = {}) {
  const store = readAll();
  const authUser = store.users[email];
  if (!authUser) throw Object.assign(new Error('Акаунт не знайдено'), { code: 'ACCOUNT_NOT_FOUND' });

  const displayName = changes.displayName === undefined ? undefined : String(changes.displayName || '').trim().slice(0, 60);
  if (changes.displayName !== undefined && !displayName) throw Object.assign(new Error('Вкажи ім’я'), { code: 'INVALID_NAME' });
  let avatarDataUrl;
  if (changes.avatarDataUrl !== undefined) {
    avatarDataUrl = changes.avatarDataUrl === null ? null : changes.avatarDataUrl;
    if (avatarDataUrl !== null && (typeof avatarDataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/i.test(avatarDataUrl) || avatarDataUrl.length > 700000)) {
      throw Object.assign(new Error('Некоректне фото профілю'), { code: 'INVALID_AVATAR' });
    }
  }

  const nextEmail = changes.newEmail === undefined ? email : String(changes.newEmail).trim().toLowerCase();
  const newPassword = changes.newPassword ? String(changes.newPassword) : '';
  const sensitiveChange = nextEmail !== email || Boolean(newPassword);
  if (sensitiveChange) {
    if (!changes.currentPassword || !await bcrypt.compare(String(changes.currentPassword), authUser.passwordHash)) {
      throw Object.assign(new Error('Поточний пароль невірний'), { code: 'INVALID_CURRENT_PASSWORD' });
    }
    if (nextEmail !== email && (!nextEmail.includes('@') || nextEmail.length > 254)) throw Object.assign(new Error('Введи коректний email'), { code: 'INVALID_EMAIL' });
    if (nextEmail !== email && (store.users[nextEmail] || getUser(nextEmail))) throw Object.assign(new Error('Цей email уже використовується'), { code: 'EMAIL_TAKEN' });
    if(nextEmail!==email){const matched=Object.entries(store.emailChangeTokens||{}).find(([,item])=>item.accountEmail===email&&item.newEmail===nextEmail&&Date.now()-item.createdAt<=VERIFY_TOKEN_TTL_MS);if(!matched)throw Object.assign(new Error('Спочатку підтвердьте новий email кодом'),{code:'EMAIL_VERIFICATION_REQUIRED'});delete store.emailChangeTokens[matched[0]];}
    if (newPassword && newPassword.length < 8) throw Object.assign(new Error('Новий пароль має містити щонайменше 8 символів'), { code: 'WEAK_PASSWORD' });
  }

  if (newPassword) authUser.passwordHash = await bcrypt.hash(newPassword, 10);
  if (nextEmail !== email) {
    delete store.users[email];
    store.users[nextEmail] = { ...authUser, email: nextEmail };
    for (const session of Object.values(store.sessions)) if (session.email === email) session.email = nextEmail;
    const oldUser = getUser(email);
    if (oldUser) { deleteUser(email); saveUser(nextEmail, { ...oldUser, email: nextEmail }); }
    for (const user of Object.values(getAllUsers())) {
      const patches = {};
      if (user.referredBy === email) patches.referredBy = nextEmail;
      if (Array.isArray(user.referrals)) patches.referrals = user.referrals.map((referral) => referral.email === email ? { ...referral, email: nextEmail } : referral);
      if (Object.keys(patches).length) saveUser(user.email, patches);
    }
  }
  const accountEmail = nextEmail;
  if (displayName !== undefined || avatarDataUrl !== undefined) saveUser(accountEmail, { ...(displayName !== undefined ? { displayName } : {}), ...(avatarDataUrl !== undefined ? { avatarDataUrl } : {}) });
  writeAll(store);
  return { email: accountEmail, displayName: getUser(accountEmail)?.displayName || '', avatarDataUrl: getUser(accountEmail)?.avatarDataUrl || null };
}

async function requestEmailChange(accountEmail,newEmail,currentPassword){
  accountEmail=normalizeEmail(accountEmail);newEmail=normalizeEmail(newEmail);const store=readAll(),user=store.users[accountEmail];
  if(!user||!await bcrypt.compare(String(currentPassword||''),user.passwordHash))throw Object.assign(new Error('Поточний пароль невірний'),{code:'INVALID_CURRENT_PASSWORD'});
  if(!newEmail.includes('@')||newEmail.length>254)throw Object.assign(new Error('Введіть коректний новий email'),{code:'INVALID_EMAIL'});
  if(store.users[newEmail]||getUser(newEmail))throw Object.assign(new Error('Цей email уже використовується'),{code:'EMAIL_TAKEN'});
  const code=randomCode(),key=`${accountEmail}:${newEmail}`;store.emailChangeCodes||={};store.emailChangeCodes[key]={accountEmail,newEmail,codeHash:verificationCodeHash(newEmail,code),attempts:0,createdAt:Date.now()};writeAll(store);await sendVerificationCode(newEmail,code);return {sent:true};
}
function confirmEmailChange(accountEmail,newEmail,code){
  accountEmail=normalizeEmail(accountEmail);newEmail=normalizeEmail(newEmail);const store=readAll(),key=`${accountEmail}:${newEmail}`,entry=store.emailChangeCodes?.[key];
  if(!entry||Date.now()-entry.createdAt>CODE_TTL_MS)throw Object.assign(new Error('Код недійсний або прострочений'),{code:'INVALID_CODE'});
  entry.attempts+=1;if(entry.attempts>MAX_ATTEMPTS||!codeMatches(newEmail,entry,code)){writeAll(store);throw Object.assign(new Error('Невірний код'),{code:'WRONG_CODE'});}
  const token=randomToken();delete store.emailChangeCodes[key];store.emailChangeTokens||={};store.emailChangeTokens[token]={accountEmail,newEmail,createdAt:Date.now()};writeAll(store);return {emailChangeToken:token};
}

const ADMIN_RECOVERY_TTL_MS = 60 * 60 * 1000;

function recoveryTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createAdminRecoveryToken(accountEmail, ticketId) {
  const email = String(accountEmail || '').trim().toLowerCase();
  const store = readAll();
  if (!store.users[email] || !getUser(email)) {
    throw Object.assign(new Error('Акаунт із таким email не знайдено'), { code: 'ACCOUNT_NOT_FOUND' });
  }
  const token = randomToken();
  store.adminRecoveryTokens ||= {};
  store.adminRecoveryTokens[recoveryTokenHash(token)] = {
    accountEmail: email,
    ticketId: Number(ticketId),
    createdAt: Date.now(),
  };
  writeAll(store);
  return { token, expiresAt: new Date(Date.now() + ADMIN_RECOVERY_TTL_MS).toISOString() };
}

function inspectAdminRecoveryToken(token) {
  const entry = readAll().adminRecoveryTokens?.[recoveryTokenHash(token)];
  if (!entry || Date.now() - entry.createdAt > ADMIN_RECOVERY_TTL_MS) {
    throw Object.assign(new Error('Посилання недійсне або прострочене'), { code: 'INVALID_TOKEN' });
  }
  return { valid: true, expiresAt: new Date(entry.createdAt + ADMIN_RECOVERY_TTL_MS).toISOString() };
}

async function completeAdminRecovery(token, newEmail, newPassword, pin) {
  const store = readAll();
  const hash = recoveryTokenHash(token);
  const entry = store.adminRecoveryTokens?.[hash];
  if (!entry || Date.now() - entry.createdAt > ADMIN_RECOVERY_TTL_MS) {
    throw Object.assign(new Error('Посилання недійсне або прострочене'), { code: 'INVALID_TOKEN' });
  }

  const oldEmail = entry.accountEmail;
  const email = String(newEmail || '').trim().toLowerCase();
  if (!email.includes('@') || email.length > 254) throw Object.assign(new Error('Введи коректний новий email'), { code: 'INVALID_EMAIL' });
  if (String(newPassword || '').length < 8) throw Object.assign(new Error('Пароль має містити щонайменше 8 символів'), { code: 'WEAK_PASSWORD' });
  if (!/^\d{6}$/.test(String(pin || ''))) throw Object.assign(new Error('PIN має містити рівно 6 цифр'), { code: 'INVALID_PIN' });
  if (email !== oldEmail && (store.users[email] || getUser(email))) throw Object.assign(new Error('Цей email уже використовується'), { code: 'EMAIL_TAKEN' });
  if (!store.users[oldEmail] || !getUser(oldEmail)) throw Object.assign(new Error('Акаунт не знайдено'), { code: 'ACCOUNT_NOT_FOUND' });

  const authUser = { ...store.users[oldEmail], email, passwordHash: await bcrypt.hash(String(newPassword), 10) };
  delete store.users[oldEmail];
  store.users[email] = authUser;
  for (const [sessionToken, session] of Object.entries(store.sessions || {})) {
    if (session.email === oldEmail) delete store.sessions[sessionToken];
  }

  const subscription = getUser(oldEmail);
  deleteUser(oldEmail);
  saveUser(email, {
    ...subscription,
    email,
    appLock: { enabled: true, pinHash: await bcrypt.hash(String(pin), 10) },
  });
  for (const user of Object.values(getAllUsers())) {
    const patch = {};
    if (user.referredBy === oldEmail) patch.referredBy = email;
    if (Array.isArray(user.referrals)) patch.referrals = user.referrals.map((item) => item.email === oldEmail ? { ...item, email } : item);
    if (Object.keys(patch).length) saveUser(user.email, patch);
  }

  delete store.adminRecoveryTokens[hash];
  const sessionToken = createSession(store, email, 'Відновлення доступу');
  writeAll(store);
  return { ok: true, email, sessionToken, ticketId: entry.ticketId };
}

module.exports = { requestCode, verifyCode, setPassword, login, getSessionEmail, listSessions, revokeOtherSessions, revokeAllSessions, deleteAccountAuth, updateAccount, requestEmailChange, confirmEmailChange, requestPasswordReset, verifyResetCode, resetPassword, createAdminRecoveryToken, inspectAdminRecoveryToken, completeAdminRecovery };

// ---------- Забув(ла) пароль: запит коду ----------
async function requestPasswordReset(email) {
  email=normalizeEmail(email);
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
    store.resetCodes[email] = { codeHash:verificationCodeHash(email,code), sentAt: Date.now(), attempts: 0 };
    writeAll(store);
    await sendVerificationCode(email, code);
  }

  return { sent: true };
}

// ---------- Забув(ла) пароль: перевірка коду ----------
function verifyResetCode(email, code) {
  email=normalizeEmail(email);
  const store = readAll();
  store.resetCodes = store.resetCodes || {};
  const entry = store.resetCodes[email];

  if (!entry) throw Object.assign(new Error('Код не запитувався або вже використаний'), { code: 'NO_CODE' });
  if (Date.now() - entry.sentAt > CODE_TTL_MS) throw Object.assign(new Error('Код прострочено'), { code: 'EXPIRED' });
  if (entry.attempts >= MAX_ATTEMPTS) throw Object.assign(new Error('Забагато спроб, запроси новий код'), { code: 'TOO_MANY_ATTEMPTS' });

  entry.attempts += 1;

  if (!codeMatches(email,entry,code)) {
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
