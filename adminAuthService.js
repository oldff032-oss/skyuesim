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
const TWO_FACTOR_TTL_MS = 10 * 60 * 1000;
const ALL_PERMISSIONS=['users.read','support.reply','refunds.manage','esim.retry','activation_code.read','broadcasts.manage','users.delete','backups.manage','security.manage','operations.manage','settings.manage'];
const ROLE_PERMISSIONS={
  super_admin:ALL_PERMISSIONS,
  admin:['users.read','support.reply','refunds.manage','esim.retry','activation_code.read','operations.manage'],
  support:['users.read','support.reply'],
  viewer:['users.read'],
};

function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function codeHash(challengeId, code) { return crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex'); }
function backupCodeHash(email, code) { return crypto.createHash('sha256').update(`${normalizeEmail(email)}:${String(code||'').replace(/[^a-z0-9]/gi,'').toUpperCase()}`).digest('hex'); }
function createBackupCodes(email) {
  const codes=Array.from({length:10},()=>{const raw=crypto.randomBytes(4).toString('hex').toUpperCase();return `${raw.slice(0,4)}-${raw.slice(4)}`;});
  return {codes,hashes:codes.map(code=>backupCodeHash(email,code))};
}
function issueSession(store, email, admin) {
  const token = crypto.randomBytes(32).toString('hex');
  admin.lastLoginAt = new Date().toISOString();
  store.sessions[token] = { email, role: admin.role, createdAt: Date.now(), twoFactorVerified:Boolean(admin.twoFactorEnabled) };
  writeAll(store);
  return { token, role:admin.role, email, twoFactorEnabled:Boolean(admin.twoFactorEnabled) };
}
function issueChallenge(store, email, purpose) {
  store.twoFactorChallenges ||= {};
  for (const [id,item] of Object.entries(store.twoFactorChallenges)) if (item.email === email && item.purpose === purpose) delete store.twoFactorChallenges[id];
  const challengeId = crypto.randomBytes(24).toString('hex');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  store.twoFactorChallenges[challengeId] = { email, purpose, codeHash:codeHash(challengeId,code), createdAt:Date.now(), expiresAt:Date.now()+TWO_FACTOR_TTL_MS, attempts:0 };
  writeAll(store);
  return { challengeId, code, expiresIn:Math.floor(TWO_FACTOR_TTL_MS/1000) };
}
function consumeChallenge(store, challengeId, code, purpose) {
  const item = store.twoFactorChallenges?.[challengeId];
  if (!item || item.purpose !== purpose || item.expiresAt < Date.now()) {
    if (item) delete store.twoFactorChallenges[challengeId]; writeAll(store);
    throw Object.assign(new Error('Код недійсний або строк його дії завершився'), {code:'TWO_FACTOR_EXPIRED'});
  }
  item.attempts = Number(item.attempts || 0) + 1;
  const expected = Buffer.from(item.codeHash, 'hex'), actual = Buffer.from(codeHash(challengeId,String(code||'')), 'hex');
  const ok = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!ok) {
    if (item.attempts >= 5) delete store.twoFactorChallenges[challengeId];
    writeAll(store);
    throw Object.assign(new Error(item.attempts >= 5 ? 'Забагато спроб. Запросіть новий код' : 'Невірний код підтвердження'), {code:'TWO_FACTOR_INVALID'});
  }
  delete store.twoFactorChallenges[challengeId];
  writeAll(store);
  return item;
}

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
  email = normalizeEmail(email);
  const admin = store.admins[email];
  if (!admin) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID' });
  if (admin.blocked) throw Object.assign(new Error('Обліковий запис адміністратора заблоковано'), { code: 'BLOCKED' });

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) throw Object.assign(new Error('Невірний email або пароль'), { code: 'INVALID' });

  if (admin.twoFactorEnabled) return { requiresTwoFactor:true, email, ...issueChallenge(store,email,'login') };
  return issueSession(store,email,admin);
}

function completeLogin(challengeId, code) {
  const store=readAll();
  let challenge;
  const normalizedBackup=String(code||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
  if(normalizedBackup.length===8){
    challenge=store.twoFactorChallenges?.[challengeId];
    if(!challenge||challenge.purpose!=='login'||challenge.expiresAt<Date.now())throw Object.assign(new Error('Спроба входу завершилася. Введіть пароль ще раз'),{code:'TWO_FACTOR_EXPIRED'});
    const adminForCode=store.admins[challenge.email];
    const hash=backupCodeHash(challenge.email,normalizedBackup);
    const index=(adminForCode?.backupCodeHashes||[]).findIndex(item=>item===hash);
    if(index<0){challenge.attempts=Number(challenge.attempts||0)+1;if(challenge.attempts>=5)delete store.twoFactorChallenges[challengeId];writeAll(store);throw Object.assign(new Error(challenge.attempts>=5?'Забагато спроб. Введіть пароль ще раз':'Резервний код недійсний або вже використаний'),{code:'BACKUP_CODE_INVALID'});}
    adminForCode.backupCodeHashes.splice(index,1);delete store.twoFactorChallenges[challengeId];writeAll(store);
  }else challenge=consumeChallenge(store,challengeId,code,'login');
  const admin=store.admins[challenge.email];
  if(!admin || admin.blocked || !admin.twoFactorEnabled) throw Object.assign(new Error('Вхід більше недоступний'),{code:'INVALID'});
  return issueSession(store,challenge.email,admin);
}
function startTwoFactorChange(email, enabled) {
  const store=readAll(); email=normalizeEmail(email); const admin=store.admins[email];
  if(!admin) throw new Error('Адміністратора не знайдено');
  if(Boolean(admin.twoFactorEnabled)===Boolean(enabled)) throw new Error(enabled?'Двофакторний захист уже ввімкнено':'Двофакторний захист уже вимкнено');
  return issueChallenge(store,email,enabled?'enable':'disable');
}
function completeTwoFactorChange(email, enabled, challengeId, code) {
  const store=readAll(); email=normalizeEmail(email); const item=consumeChallenge(store,challengeId,code,enabled?'enable':'disable');
  if(item.email!==email) throw new Error('Код належить іншому обліковому запису');
  const admin=store.admins[email]; if(!admin) throw new Error('Адміністратора не знайдено');
  admin.twoFactorEnabled=Boolean(enabled); admin.twoFactorChangedAt=new Date().toISOString();
  let backupCodes=[];
  if(enabled){const generated=createBackupCodes(email);backupCodes=generated.codes;admin.backupCodeHashes=generated.hashes;}
  else {admin.backupCodeHashes=[];revokeSessions(store,email);}
  writeAll(store); return {enabled:Boolean(admin.twoFactorEnabled),backupCodes};
}
function twoFactorStatus(email){ const admin=readAll().admins[normalizeEmail(email)]; return {enabled:Boolean(admin?.twoFactorEnabled),email:normalizeEmail(email),backupCodesRemaining:(admin?.backupCodeHashes||[]).length}; }

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
function permissionsFor(email,role){const admin=readAll().admins[normalizeEmail(email)]||{};return Array.isArray(admin.permissions)?admin.permissions:ROLE_PERMISSIONS[role]||[];}
function requirePermission(permission,{requireTwoFactor=false}={}){return(req,res,next)=>{const permissions=permissionsFor(req.admin.email,req.admin.role);if(!permissions.includes(permission))return res.status(403).json({error:'Недостатньо прав для цієї дії',permission});if(requireTwoFactor&&(!req.admin.twoFactorVerified||req.admin.role!=='super_admin'))return res.status(403).json({error:'Для небезпечної дії потрібен Super Admin із підтвердженою 2FA',code:'STEP_UP_REQUIRED'});next();};}
function setPermissions({email,permissions}){const store=readAll();email=normalizeEmail(email);const admin=store.admins[email];if(!admin)throw new Error('Адміністратора не знайдено');admin.permissions=[...new Set((permissions||[]).filter(item=>ALL_PERMISSIONS.includes(item)))];writeAll(store);return {email,permissions:admin.permissions};}

async function createAdmin({ email, password, role }) {
  const store = readAll();
  email = normalizeEmail(email);
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
    twoFactorEnabled: Boolean(a.twoFactorEnabled),
    permissions: Array.isArray(a.permissions) ? a.permissions : ROLE_PERMISSIONS[a.role] || [],
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

function resetTwoFactor({email,actorEmail}){
  const store=readAll();email=normalizeEmail(email);actorEmail=normalizeEmail(actorEmail);const admin=store.admins[email];
  if(!admin)throw Object.assign(new Error('Адміністратора не знайдено'),{code:'NOT_FOUND'});
  if(email===actorEmail)throw Object.assign(new Error('Власну 2FA потрібно вимикати кодом у розділі «Безпека»'),{code:'SELF_ACTION'});
  admin.twoFactorEnabled=false;admin.twoFactorChangedAt=new Date().toISOString();revokeSessions(store,email);
  admin.backupCodeHashes=[];
  for(const [id,item] of Object.entries(store.twoFactorChallenges||{}))if(item.email===email)delete store.twoFactorChallenges[id];
  writeAll(store);return {email,enabled:false};
}

async function emergencyResetTwoFactor({email,password,recoverySecret}){
  const expected=String(process.env.ADMIN_RECOVERY_SECRET||'');
  if(expected.length<20)throw Object.assign(new Error('Аварійне відновлення не налаштовано на сервері'),{code:'RECOVERY_NOT_CONFIGURED'});
  const supplied=String(recoverySecret||'');
  const expectedBuffer=Buffer.from(expected),suppliedBuffer=Buffer.from(supplied);
  if(expectedBuffer.length!==suppliedBuffer.length||!crypto.timingSafeEqual(expectedBuffer,suppliedBuffer))throw Object.assign(new Error('Невірні дані відновлення'),{code:'RECOVERY_INVALID'});
  const store=readAll();email=normalizeEmail(email);const admin=store.admins[email];
  if(!admin||admin.role!=='super_admin'||admin.blocked||!(await bcrypt.compare(String(password||''),admin.passwordHash)))throw Object.assign(new Error('Невірні дані відновлення'),{code:'RECOVERY_INVALID'});
  admin.twoFactorEnabled=false;admin.backupCodeHashes=[];admin.twoFactorChangedAt=new Date().toISOString();revokeSessions(store,email);
  for(const [id,item] of Object.entries(store.twoFactorChallenges||{}))if(item.email===email)delete store.twoFactorChallenges[id];
  writeAll(store);return {email,enabled:false};
}

module.exports = { bootstrap, login, completeLogin, twoFactorStatus, startTwoFactorChange, completeTwoFactorChange, resetTwoFactor, emergencyResetTwoFactor, requireAdmin, requireRole, requirePermission, permissionsFor, setPermissions, createAdmin, listAdmins, setAdminBlocked, deleteAdmin, ALL_PERMISSIONS };
