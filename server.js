// server.js
//
// Запуск: npm install, потім npm start
// Сервер підніметься на порту з .env (за замовчуванням 4242)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');

const { createCheckoutSession, createCustomPackageCheckout, cancelSubscription, cancelAllSubscriptionsForCustomers, deleteStripeCustomer, constructWebhookEvent, getNextBillingDate, getBillingHistory, getRecoveryPaymentEvidence, findCustomerIdsByEmail, getCustomerEmail, getSubscriptionStateByEmail, listCompletedCheckoutPurchasesByEmail, getCheckoutPurchaseDetails, listRefundablePaymentsByEmail, refundPayment } = require('./stripeService');
const crypto = require('crypto');
const { provisionEsim, checkUsage, recoverEsim, topupEsim, listPackages, findRenewalTopup } = require('./esimService');
const { bootstrap: bootstrapUsers, getUser, saveUser, deleteUser, getUserByStripeCustomerId, getAllUsers } = require('./db');
const storage = require('./persistentState');
const authStore = require('./authStore');
const adminStore = require('./adminStore');
const authService = require('./authService');
const ticketStore = require('./ticketStore');
const auditStore = require('./auditStore');
const adminAuth = require('./adminAuthService');
const pushStore = require('./pushStore');
const operationsStore = require('./operationsStore');
const diagnosticsStore = require('./diagnosticsStore');
const translationService = require('./translationService');
const { isConfigured: isPushConfigured, sendToEmail } = require('./pushService');
const { sendEmail, getReceivedEmail, verifyInboundSignature } = require('./emailService');
const emailTemplates = require('./emailTemplates');

const app = express();
const esimRetriesInProgress = new Set();
const renewalInvoicesInProgress = new Set();
const coverageCache = new Map();
const accessRecoveryRateLimit = new Map();
app.use(cors());

function upsertPurchase(email, purchaseId, patch, defaults = {}) {
  const user = getUser(email) || {};
  const purchases = Array.isArray(user.purchases) ? [...user.purchases] : [];
  const index = purchases.findIndex(item => item.id === purchaseId);
  const current = index >= 0 ? purchases[index] : { id:purchaseId, createdAt:new Date().toISOString(), ...defaults };
  const next = { ...current, ...patch, updatedAt:new Date().toISOString() };
  if (index >= 0) purchases[index] = next; else purchases.unshift(next);
  saveUser(email, { purchases });
  return next;
}

async function deliverPurchaseReceipt(email, purchaseId, defaults = {}, suppliedReceiptUrl = null) {
  const stored = (getUser(email)?.purchases || []).find(item => item.id === purchaseId);
  if (stored?.receiptEmailSentAt) return { duplicate:true, receiptUrl:stored.receiptUrl || suppliedReceiptUrl || null };
  let receiptUrl = suppliedReceiptUrl || stored?.receiptUrl || null;
  try {
    if (!receiptUrl && String(purchaseId).startsWith('cs_')) {
      const details = await getCheckoutPurchaseDetails(purchaseId);
      receiptUrl = details.charge?.receiptUrl || details.invoice?.hostedInvoiceUrl || details.invoice?.pdfUrl || null;
    }
    const purchase = upsertPurchase(email, purchaseId, { receiptUrl }, defaults);
    const delivery = await sendEmail({
      to:email,
      subject:`Ваш чек за ${purchase.packageName || purchase.plan || 'eSIM-пакет'} — Сигнал`,
      html:emailTemplates.purchaseReceipt({purchase,receiptUrl,fulfillmentStatus:purchase.fulfillmentStatus}),
    });
    if (delivery?.mocked) throw new Error('RESEND_API_KEY не налаштовано');
    upsertPurchase(email, purchaseId, {receiptUrl,receiptEmailSentAt:new Date().toISOString(),receiptEmailError:null}, defaults);
    return {sent:true,receiptUrl};
  } catch (error) {
    upsertPurchase(email, purchaseId, {receiptUrl,receiptEmailError:error.message,receiptEmailLastAttemptAt:new Date().toISOString()}, defaults);
    console.error(`[purchase receipt] ${email} ${purchaseId}:`, error.message);
    return {sent:false,receiptUrl,error:error.message};
  }
}

async function syncPurchasesForUser(email) {
  const user = getUser(email);
  const imported = await listCompletedCheckoutPurchasesByEmail(email, user?.stripeCustomerId || null);
  const currentPurchases = Array.isArray(user?.purchases) ? user.purchases : [];
  imported.forEach((purchase, index) => {
    const existing = currentPurchases.find(item => item.id === purchase.id);
    const inferredStatus = !existing && user?.status === 'payment_ok_esim_failed' && index === 0 ? 'failed' : 'not_recorded';
    upsertPurchase(email, purchase.id, { ...purchase, fulfillmentStatus:existing?.fulfillmentStatus || inferredStatus, fulfillmentError:existing?.fulfillmentError || (inferredStatus === 'failed' ? user?.lastEsimProvisionError || 'Оплату знайдено, QR/eSIM не була видана' : null) });
  });
  return imported.length;
}

function notifySuperAdminsAboutTicket(ticket) {
  const recipients = adminAuth.listAdmins().filter(admin=>!admin.blocked&&admin.role==='super_admin');
  for(const admin of recipients) sendToEmail(`admin:${admin.email}`, { title:'Нове звернення в підтримку', body:`Тікет #${ticket.id}: ${ticket.subject}`, url:`/admin-ticket.html?id=${ticket.id}`, tag:`admin-ticket-${ticket.id}` }).catch(()=>{});
}

// ВАЖЛИВО: вебхук Stripe має отримати "сирий" (не розпарсений) body,
// тому для цього одного маршруту JSON-парсер вимикаємо.
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use('/api/inbound-email', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// =========================================================
// АВТЕНТИФІКАЦІЯ: email -> код -> пароль -> акаунт, і логін
// =========================================================

app.post('/api/auth/request-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Введи коректний email' });
    if (operationsStore.store().blacklist.emails.includes(email.toLowerCase())) return res.status(403).json({ error: 'Цей email недоступний для реєстрації' });
    await authService.requestCode(email, req.body?.language, req.body?.referralCode, { displayName: req.body?.displayName, avatarDataUrl: req.body?.avatarDataUrl });
    res.json({ sent: true });
  } catch (err) {
    const status = err.code === 'COOLDOWN' ? 429 : 500;
    res.status(status).json({ error: err.message, code: err.code, waitSec: err.waitSec });
  }
});

app.post('/api/auth/verify-code', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Потрібні email і code' });
    const result = authService.verifyCode(email, code);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/auth/set-password', async (req, res) => {
  try {
    const { verifyToken, password } = req.body;
    if (!verifyToken || !password) return res.status(400).json({ error: 'Потрібні verifyToken і password' });
    const result = await authService.setPassword(verifyToken, password, req.headers['x-device-name'] || req.headers['user-agent'], req.body?.pin);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Потрібні email і password' });
    const result = await authService.login(email, password, req.headers['x-device-name'] || req.headers['user-agent']);
    if (getUser(result.email)?.status === 'blocked') {
      return res.status(403).json({ error: 'Акаунт заблоковано. Зверніться до підтримки.' });
    }
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message, code: err.code });
  }
});

app.get('/api/auth/me', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const email = authService.getSessionEmail(sessionToken);
  if (!email) return res.status(401).json({ error: 'Сесія недійсна, увійди знову' });
  res.json({ email });
});

function requireUserSession(req, res, next) {
  const sessionToken = req.headers['x-session-token'];
  const email = authService.getSessionEmail(sessionToken);
  if (!email) return res.status(401).json({ error: 'Сесія недійсна, увійди знову' });
  req.userEmail = email;
  req.sessionToken = sessionToken;
  next();
}

// Security Center: show only the current account's sessions and let the user
// invalidate every other login in one action.
app.get('/api/account/sessions', requireUserSession, (req, res) => {
  res.json({ sessions: authService.listSessions(req.userEmail, req.sessionToken) });
});

app.post('/api/account/sessions/revoke-others', requireUserSession, (req, res) => {
  const revoked = authService.revokeOtherSessions(req.userEmail, req.sessionToken);
  res.json({ ok: true, revoked });
});

const PASSKEY_RP_ID = 'skyesim.netlify.app';
const PASSKEY_ORIGIN = 'https://skyesim.netlify.app';
app.post('/api/account/passkeys/register/options', requireUserSession, async (req,res) => {
  const user=getUser(req.userEmail); const passkeys=user?.passkeys||[];
  const options=await generateRegistrationOptions({rpName:'Signal eSIM',rpID:PASSKEY_RP_ID,userName:req.userEmail,userID:Buffer.from(req.userEmail),attestationType:'none',excludeCredentials:passkeys.map(p=>({id:p.id,transports:p.transports})),authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'required',userVerification:'required'}});
  saveUser(req.userEmail,{passkeyChallenge:options.challenge}); res.json(options);
});
app.post('/api/account/passkeys/register/verify', requireUserSession, async (req,res) => {
  try { const user=getUser(req.userEmail); const verification=await verifyRegistrationResponse({response:req.body,expectedChallenge:user?.passkeyChallenge,expectedOrigin:PASSKEY_ORIGIN,expectedRPID:PASSKEY_RP_ID,requireUserVerification:true}); if(!verification.verified||!verification.registrationInfo) throw new Error('Face ID не підтверджено'); const c=verification.registrationInfo.credential; saveUser(req.userEmail,{passkeys:[...(user.passkeys||[]),{id:c.id,publicKey:Buffer.from(c.publicKey).toString('base64url'),counter:c.counter,transports:c.transports||[],createdAt:new Date().toISOString()}],passkeyChallenge:null}); res.json({ok:true}); } catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/account/lock', requireUserSession, (req,res)=>{const u=getUser(req.userEmail);res.json({enabled:Boolean(u?.appLock?.enabled),hasPin:Boolean(u?.appLock?.pinHash),hasPasskey:Boolean(u?.passkeys?.length)});});
app.put('/api/account/lock', requireUserSession, async (req,res)=>{const pin=String(req.body?.pin||''); if(!/^\d{6}$/.test(pin))return res.status(400).json({error:'PIN має містити рівно 6 цифр'}); saveUser(req.userEmail,{appLock:{enabled:true,pinHash:await bcrypt.hash(pin,10)}});res.json({ok:true});});
app.post('/api/account/lock/pin', requireUserSession, async (req,res)=>{const hash=getUser(req.userEmail)?.appLock?.pinHash; if(!hash||!await bcrypt.compare(String(req.body?.pin||''),hash))return res.status(401).json({error:'Невірний PIN'});res.json({ok:true});});

app.put('/api/account/profile', requireUserSession, async (req, res) => {
  try {
    const result = await authService.updateAccount(req.userEmail, req.body || {});
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

app.get('/api/account/preferences', requireUserSession, (req, res) => {
  const preferences = getUser(req.userEmail)?.preferences || {};
  res.json({ trafficAlertThresholds: preferences.trafficAlertThresholds || [50, 80, 95], language: getUser(req.userEmail)?.language || 'uk' });
});

app.post('/api/account/diagnostics', requireUserSession, (req, res) => {
  const { type, severity, page, message, context } = req.body || {};
  if (!type || String(type).length > 80) return res.status(400).json({ error:'Некоректний тип події' });
  diagnosticsStore.add({ email:req.userEmail, source:'client', type, severity, page, message, context });
  res.status(202).json({ ok:true });
});

async function localizedAnnouncements(email) {
  const announcements = operationsStore.activeAnnouncements(email);
  const userLanguage = getUser(email)?.language || 'uk';
  if (userLanguage !== 'en') return announcements;
  return Promise.all(announcements.map(async (announcement) => ({
    ...announcement,
    title: await translationService.translate(announcement.title, 'en'),
    message: await translationService.translate(announcement.message, 'en'),
  })));
}

app.get('/api/account/announcements', requireUserSession, async (req, res) => res.json({ announcements: await localizedAnnouncements(req.userEmail) }));
// General announcements are public by design so the app can show maintenance
// notices before a saved login session has been restored.
app.get('/api/announcements', async (req, res) => res.json({ announcements: await localizedAnnouncements(req.query.email || null) }));

app.put('/api/account/preferences', requireUserSession, (req, res) => {
  const raw = req.body?.trafficAlertThresholds;
  const language = req.body?.language;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((value) => !Number.isInteger(value) || value < 1 || value > 100))) {
    return res.status(400).json({ error: 'Вкажи коректні пороги від 1 до 100' });
  }
  if (language !== undefined && !['uk','en'].includes(language)) return res.status(400).json({ error: 'Некоректна мова' });
  const trafficAlertThresholds = raw === undefined ? null : [...new Set(raw)].sort((a, b) => a - b);
  const user = getUser(req.userEmail);
  saveUser(req.userEmail, { ...(language ? { language } : {}), preferences: { ...(user?.preferences || {}), ...(trafficAlertThresholds ? { trafficAlertThresholds } : {}) } });
  res.json({ ok: true, trafficAlertThresholds: trafficAlertThresholds || user?.preferences?.trafficAlertThresholds || [50,80,95], language: language || user?.language || 'uk' });
});

app.get('/api/account/usage-history', requireUserSession, (req, res) => {
  res.json({ history: getUser(req.userEmail)?.esim?.usageHistory || [] });
});

app.get('/api/account/referral', requireUserSession, (req, res) => {
  const user = getUser(req.userEmail);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  const referralCode = user.referralCode || crypto.randomBytes(4).toString('hex').toUpperCase();
  if (!user.referralCode) saveUser(req.userEmail, { referralCode });
  res.json({ code: referralCode, referrals: user.referrals || [] });
});

app.get('/api/account/referral-status', requireUserSession, (req, res) => {
  const user = getUser(req.userEmail);
  res.json({ referredBy: user?.referredBy || null, rewardStatus: user?.referralRewardStatus || null, rewardPackageCode: user?.referralRewardPackageCode || null });
});

app.post('/api/account/feedback', requireUserSession, (req, res) => {
  const rating = Number(req.body?.rating);
  const message = String(req.body?.message || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || message.length > 1000) return res.status(400).json({ error: 'Некоректний відгук' });
  const operations = operationsStore.store();
  (operations.feedback ||= []).unshift({ id: Date.now().toString(36), email: req.userEmail, rating, message, createdAt: new Date().toISOString() });
  operationsStore.save();
  res.json({ ok: true });
});

app.get('/api/service-status', (req, res) => {
  const maintenance = operationsStore.activeAnnouncements(null).find((item) => item.type === 'maintenance');
  res.json({ status: maintenance ? 'maintenance' : 'operational', message: maintenance?.message || null, checkedAt: new Date().toISOString() });
});

app.get('/api/account/coverage', requireUserSession, async (req, res) => {
  const locationCode = String(req.query.location || '').trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(locationCode)) return res.status(400).json({ error: 'Вкажи код країни' });
  const cached = coverageCache.get(locationCode);
  if (cached && Date.now() - cached.createdAt < 6 * 60 * 60 * 1000) return res.json({ locationCode, cached: true, packages: cached.packages });
  try {
    const packages = await listPackages({ locationCode });
    const safePackages = packages.slice(0, 100).map((item) => ({
      packageCode: item.packageCode,
      name: item.name,
      description: item.description,
      volume: item.volume,
      duration: item.duration,
      durationUnit: item.durationUnit,
      speed: item.speed,
      currencyCode: item.currencyCode,
      location: item.location,
      networks: (item.locationNetworkList || []).map((network) => ({ locationName: network.locationName, operatorCount: (network.operatorList || []).length })),
    }));
    coverageCache.set(locationCode, { createdAt: Date.now(), packages: safePackages });
    res.json({ locationCode, cached: false, packages: safePackages });
  } catch (error) {
    console.error(`[coverage] ${locationCode}:`, error.message);
    res.status(502).json({ error: 'Не вдалося отримати покриття від eSIM-провайдера' });
  }
});

// The activation code is intentionally available only to the account owner.
app.get('/api/account/esim', requireUserSession, (req, res) => {
  const user = getUser(req.userEmail);
  if (!user?.esim) return res.status(404).json({ error: 'eSIM ще не видано' });
  if (user.status === 'blocked') return res.status(403).json({ error: 'Акаунт заблоковано' });
  const { esim } = user;
  res.json({
    plan: user.plan || null,
    status: user.status,
    esim: {
      iccid: esim.iccid || null,
      activationCode: esim.activationCode || null,
      qrCodeUrl: esim.qrCodeUrl || null,
      apn: esim.apn || null,
      dataLimitGb: esim.dataLimitGb ?? null,
      usedGb: esim.usedGb ?? 0,
      remainingGb: esim.remainingGb ?? null,
      activateTime: esim.activateTime || null,
      expiredTime: esim.expiredTime || null,
    },
  });
});

app.get('/api/push/public-key', requireUserSession, (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: 'Push ще не налаштовано на сервері' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireUserSession, (req, res) => {
  try {
    pushStore.saveSubscription(req.userEmail, req.body?.subscription);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/push/status', requireUserSession, (req, res) => {
  const endpoint = String(req.query.endpoint || '');
  const registered = endpoint ? pushStore.subscriptionsFor(req.userEmail).some(subscription => subscription.endpoint === endpoint) : false;
  res.json({ configured: isPushConfigured(), registered, devices: pushStore.subscriptionsFor(req.userEmail).length });
});

app.post('/api/push/unsubscribe', requireUserSession, (req, res) => {
  pushStore.removeSubscription(req.body?.endpoint, req.userEmail);
  res.json({ ok: true });
});

app.post('/api/push/test', requireUserSession, async (req, res) => {
  try {
    const delivered = await sendToEmail(req.userEmail, {
      title: 'Сповіщення увімкнено',
      body: 'Тепер Сигнал може попереджати про трафік та eSIM.',
      url: '/traffic-alerts.html',
      tag: 'signal-test',
    });
    res.json({ ok: true, delivered });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

// ---- Забув(ла) пароль ----
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Введи коректний email' });
    const result = await authService.requestPasswordReset(email);
    res.json(result);
  } catch (err) {
    const status = err.code === 'COOLDOWN' ? 429 : 500;
    res.status(status).json({ error: err.message, code: err.code, waitSec: err.waitSec });
  }
});

app.post('/api/auth/verify-reset-code', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Потрібні email і code' });
    const result = authService.verifyResetCode(email, code);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { resetToken, password } = req.body;
    if (!resetToken || !password) return res.status(400).json({ error: 'Потрібні resetToken і password' });
    const result = await authService.resetPassword(resetToken, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// =========================================================
// ВХІДНА ПОШТА: реальні відповіді користувачів на email потрапляють сюди
// =========================================================

app.post('/api/inbound-email', async (req, res) => {
  try {
    verifyInboundSignature(req.body, req.headers);
    const event = JSON.parse(req.body);

    if (event.type !== 'email.received') {
      return res.json({ received: true, skipped: true });
    }

    // Вебхук дає тільки метадані — забираємо повний текст листа окремо
    const email = await getReceivedEmail(event.data.email_id);

    // Витягуємо ID тікета з теми листа: "[Сигнал Підтримка #123] ..."
    const match = (email.subject || '').match(/#(\d+)/);
    if (!match) {
      console.log('[inbound-email] Не вдалося знайти Ticket ID в темі:', email.subject);
      return res.json({ received: true, matched: false });
    }

    const ticketId = match[1];
    const ticket = ticketStore.getTicket(ticketId);
    if (!ticket) {
      console.log(`[inbound-email] Тікет #${ticketId} не знайдено`);
      return res.json({ received: true, matched: false });
    }

    // Простий текст без HTML-розмітки, якщо є тільки html-версія
    const text = email.text || (email.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    ticketStore.addMessage(ticketId, { from: 'user', text });
    console.log(`[inbound-email] Додано відповідь у тікет #${ticketId} від ${email.from}`);

    res.json({ received: true, ticketId });
  } catch (err) {
    console.error('Помилка обробки вхідного листа:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// =========================================================
// ПІДТРИМКА (SUPPORT): звернення користувачів
// =========================================================

// Public intake for people who cannot receive a verification email. It never
// reveals whether the supplied email/ICCID matches an account; only an admin
// can verify ownership and issue a short-lived recovery link.
app.post('/api/auth/access-recovery', (req, res) => {
  const rateKey = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (accessRecoveryRateLimit.get(rateKey) || []).filter(timestamp => now - timestamp < 60 * 60 * 1000);
  if (recent.length >= 3) return res.status(429).json({ error: 'Забагато запитів. Спробуй через годину.' });
  recent.push(now);
  accessRecoveryRateLimit.set(rateKey, recent);
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const possibleEmail = String(req.body?.possibleEmail || '').trim().toLowerCase().slice(0, 254);
  const contactEmail = String(req.body?.contactEmail || '').trim().toLowerCase().slice(0, 254);
  const esimId = String(req.body?.esimId || '').replace(/\s/g, '').slice(0, 80);
  const purchaseHint = String(req.body?.purchaseHint || '').trim().slice(0, 200);
  const description = String(req.body?.description || '').trim().slice(0, 2000);
  if (!name || !possibleEmail || !contactEmail || description.length < 10) {
    return res.status(400).json({ error: 'Вкажи ім’я, старий email, доступний контактний email та коротко опиши проблему' });
  }
  if (possibleEmail && !possibleEmail.includes('@')) return res.status(400).json({ error: 'Можливий email має бути коректним' });
  if (!contactEmail.includes('@')) return res.status(400).json({ error: 'Контактний email має бути коректним' });

  const ticket = ticketStore.createTicket({
    email: possibleEmail || `recovery-${Date.now()}@no-email.invalid`,
    category: 'access_recovery',
    subject: 'Відновлення доступу без email',
    message: `Ім’я: ${name}\nСтарий email: ${possibleEmail}\nДоступний контактний email: ${contactEmail}\nICCID / UID eSIM: ${esimId || 'не вказано'}\nДані про покупку: ${purchaseHint || 'не вказано'}\n\n${description}`,
    recoveryRequest: { name, possibleEmail, contactEmail, esimId: esimId || null, purchaseHint: purchaseHint || null, description },
  });
  notifySuperAdminsAboutTicket(ticket);
  auditStore.log({ action: 'access_recovery_requested', target: `#${ticket.id}` });
  res.status(201).json({ ok: true, ticketId: ticket.id });
});

app.get('/api/auth/admin-recovery/:token', (req, res) => {
  try {
    res.json(authService.inspectAdminRecoveryToken(req.params.token));
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

app.post('/api/auth/admin-recovery/:token', async (req, res) => {
  try {
    const result = await authService.completeAdminRecovery(req.params.token, req.body?.email, req.body?.password, req.body?.pin);
    const ticket = ticketStore.getTicket(result.ticketId);
    if (ticket) ticketStore.updateTicket(result.ticketId, { status: 'resolved', recoveredEmail: result.email, recoveryCompletedAt: new Date().toISOString() });
    auditStore.log({ action: 'access_recovery_completed', target: result.email, details: { ticketId: result.ticketId } });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

app.post('/api/support/tickets', async (req, res) => {
  try {
    const { email, category, subject, message, attachment } = req.body;
    if (!email || !subject || !message) return res.status(400).json({ error: 'Потрібні email, subject і message' });
    if (attachment && attachment.dataUrl && attachment.dataUrl.length > 4_500_000) {
      return res.status(400).json({ error: 'Файл завеликий (максимум ~3МБ)' });
    }

    const ticket = ticketStore.createTicket({ email, category: category || 'Інше', subject, message, attachment });
    notifySuperAdminsAboutTicket(ticket);
    res.json(ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/support/tickets', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Потрібен email' });
  res.json(ticketStore.getTicketsByEmail(email));
});

app.get('/api/support/tickets/:id', (req, res) => {
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (req.query.email && ticket.email !== req.query.email) {
    return res.status(403).json({ error: 'Немає доступу до цього тікета' });
  }
  // Внутрішні нотатки адмінів користувач бачити не повинен
  const safeTicket = ticketStore.stripNotesForUser(ticket);
  if ((getUser(ticket.email)?.language || 'uk') !== 'en') return res.json(safeTicket);
  Promise.all((safeTicket.messages || []).map(async (item) => item.from === 'admin'
    ? { ...item, text: await translationService.translate(item.text, 'en') }
    : item
  )).then((messages) => res.json({ ...safeTicket, messages })).catch(() => res.json(safeTicket));
});

app.post('/api/support/tickets/:id/reply', (req, res) => {
  const { email, message, attachment } = req.body;
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (ticket.email !== email) return res.status(403).json({ error: 'Немає доступу до цього тікета' });
  if (attachment && attachment.dataUrl && attachment.dataUrl.length > 4_500_000) {
    return res.status(400).json({ error: 'Файл завеликий (максимум ~3МБ)' });
  }

  const updated = ticketStore.addMessage(req.params.id, { from: 'user', text: message, attachment });
  res.json(ticketStore.stripNotesForUser(updated));
});

// =========================================================
// АДМІН-ПАНЕЛЬ: акаунти адмінів з ролями (Super Admin/Admin/Support/Viewer)
// =========================================================

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await adminAuth.login(email, password);
    if (result.requiresTwoFactor) {
      const delivery=await sendEmail({to:result.email,subject:'Код входу в адмін-панель — Сигнал',html:emailTemplates.twoFactorCode({code:result.code,purpose:'login'})});
      if(delivery?.mocked) throw Object.assign(new Error('2FA не може надіслати код: RESEND_API_KEY не налаштовано'),{code:'EMAIL_NOT_CONFIGURED'});
      auditStore.log({adminEmail:result.email,action:'admin_2fa_code_sent'});
      return res.json({requiresTwoFactor:true,challengeId:result.challengeId,email:result.email,expiresIn:result.expiresIn});
    }
    auditStore.log({ adminEmail: result.email, action: 'admin_login' });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message, code: err.code });
  }
});

app.post('/api/admin/login/2fa', (req,res)=>{
  try{const result=adminAuth.completeLogin(String(req.body?.challengeId||''),String(req.body?.code||''));auditStore.log({adminEmail:result.email,action:'admin_login_2fa'});res.json(result);}
  catch(error){res.status(401).json({error:error.message,code:error.code});}
});

app.get('/api/admin/me', adminAuth.requireAdmin, (req, res) => {
  res.json(req.admin);
});

app.get('/api/admin/security/2fa',adminAuth.requireAdmin,(req,res)=>res.json(adminAuth.twoFactorStatus(req.admin.email)));
app.post('/api/admin/security/2fa/request',adminAuth.requireAdmin,async(req,res)=>{
  try{const enabled=Boolean(req.body?.enabled),result=adminAuth.startTwoFactorChange(req.admin.email,enabled);const delivery=await sendEmail({to:req.admin.email,subject:`${enabled?'Увімкнення':'Вимкнення'} двофакторного захисту — Сигнал`,html:emailTemplates.twoFactorCode({code:result.code,purpose:enabled?'enable':'disable'})});if(delivery?.mocked)throw new Error('RESEND_API_KEY не налаштовано');auditStore.log({adminEmail:req.admin.email,action:'admin_2fa_change_requested',details:{enabled}});res.json({challengeId:result.challengeId,expiresIn:result.expiresIn});}
  catch(error){res.status(400).json({error:error.message,code:error.code});}
});
app.post('/api/admin/security/2fa/confirm',adminAuth.requireAdmin,(req,res)=>{
  try{const enabled=Boolean(req.body?.enabled),result=adminAuth.completeTwoFactorChange(req.admin.email,enabled,String(req.body?.challengeId||''),String(req.body?.code||''));auditStore.log({adminEmail:req.admin.email,action:enabled?'admin_2fa_enabled':'admin_2fa_disabled'});res.json({ok:true,...result,loggedOut:!enabled});}
  catch(error){res.status(400).json({error:error.message,code:error.code});}
});

app.get('/api/admin/push/public-key', adminAuth.requireAdmin, (req,res)=>{
  if(!isPushConfigured()) return res.status(503).json({error:'Push не налаштовано на сервері'});
  res.json({publicKey:process.env.VAPID_PUBLIC_KEY});
});
app.post('/api/admin/push/subscribe', adminAuth.requireAdmin, (req,res)=>{
  try{ pushStore.saveSubscription(`admin:${req.admin.email}`,req.body?.subscription); res.json({ok:true}); }
  catch(error){ res.status(400).json({error:error.message}); }
});
app.get('/api/admin/push/status', adminAuth.requireAdmin, (req,res)=>{
  const endpoint=String(req.query.endpoint||''),key=`admin:${req.admin.email}`;
  res.json({configured:isPushConfigured(),registered:endpoint?pushStore.subscriptionsFor(key).some(item=>item.endpoint===endpoint):false,devices:pushStore.subscriptionsFor(key).length});
});
app.post('/api/admin/push/test', adminAuth.requireAdmin, async(req,res)=>{
  try{const delivered=await sendToEmail(`admin:${req.admin.email}`,{title:'Адмін-сповіщення працюють',body:'Ви отримуватимете нові та призначені звернення.',url:'/admin-tickets.html',tag:'admin-push-test'});res.json({ok:true,delivered});}
  catch(error){res.status(503).json({error:error.message});}
});

app.get('/api/admin/diagnostics', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req,res)=>{
  res.json({events:diagnosticsStore.list({email:req.query.email||'',type:req.query.type||'',severity:req.query.severity||'',limit:req.query.limit||200})});
});

// Керування командою — тільки Super Admin
app.get('/api/admin/team', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  res.json(adminAuth.listAdmins());
});

app.get('/api/admin/assignees', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  res.json(adminAuth.listAdmins().filter((admin) => !admin.blocked && admin.role === 'admin').map((admin) => ({ email: admin.email, role: admin.role })));
});

app.post('/api/admin/team', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: 'Потрібні email, password і role' });
    if (password.length < 8) return res.status(400).json({ error: 'Пароль має бути не менше 8 символів' });
    await adminAuth.createAdmin({ email, password, role });
    auditStore.log({ adminEmail: req.admin.email, action: 'admin_created', target: email, details: { role } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.patch('/api/admin/team/:email/block', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  try {
    const result = adminAuth.setAdminBlocked({
      email: req.params.email,
      blocked: Boolean(req.body?.blocked),
      actorEmail: req.admin.email,
    });
    auditStore.log({ adminEmail: req.admin.email, action: result.blocked ? 'admin_blocked' : 'admin_unblocked', target: result.email });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/admin/team/:email/reset-2fa',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{try{const result=adminAuth.resetTwoFactor({email:req.params.email,actorEmail:req.admin.email});auditStore.log({adminEmail:req.admin.email,action:'admin_2fa_reset',target:result.email});res.json({ok:true,...result});}catch(error){res.status(400).json({error:error.message,code:error.code});}});

app.delete('/api/admin/team/:email', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  try {
    const email = req.params.email;
    adminAuth.deleteAdmin({ email, actorEmail: req.admin.email });
    auditStore.log({ adminEmail: req.admin.email, action: 'admin_deleted', target: email });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// Перегляд тікетів — доступний усім ролям, крім нічого (навіть Viewer читає)
app.get('/api/admin/tickets', adminAuth.requireAdmin, (req, res) => {
  const { status, priority, search } = req.query;
  const tickets = ticketStore.getAllTickets({ status, priority, search });
  res.json(req.admin.role === 'admin' ? tickets.filter(ticket => ticket.assignedTo === req.admin.email) : tickets);
});

app.get('/api/admin/tickets/:id', adminAuth.requireAdmin, async (req, res) => {
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });
  const userSubscription = getUser(ticket.email);
  let recoveryVerification = null;
  if (ticket.category === 'access_recovery' && req.admin.role === 'super_admin') {
    const authUser = authStore.readAll().users?.[ticket.email] || null;
    let payment = null;
    let paymentError = null;
    try {
      payment = await getRecoveryPaymentEvidence(userSubscription?.stripeCustomerId);
    } catch (error) {
      paymentError = 'Stripe-дані тимчасово недоступні';
      console.error(`[access recovery] Stripe evidence for #${ticket.id}:`, error.message);
    }
    recoveryVerification = {
      accountFound: Boolean(authUser && userSubscription),
      accountEmail: authUser?.email || userSubscription?.email || null,
      registeredAt: authUser?.createdAt || userSubscription?.createdAt || null,
      lastLoginAt: authUser?.lastLoginAt || null,
      displayName: userSubscription?.displayName || null,
      plan: userSubscription?.plan || null,
      status: userSubscription?.status || null,
      hasEsim: Boolean(userSubscription?.esim),
      iccidLast4: userSubscription?.esim?.iccid ? String(userSubscription.esim.iccid).slice(-4) : null,
      payment,
      paymentError,
    };
  }
  res.json({ ticket, userSubscription, recoveryVerification });
});

app.post('/api/admin/tickets/:id/create-recovery-link', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  try {
    const ticket = ticketStore.getTicket(req.params.id);
    if (!ticket || ticket.category !== 'access_recovery') return res.status(404).json({ error: 'Запит відновлення не знайдено' });
    if (req.body?.verificationConfirmed !== true) return res.status(400).json({ error: 'Підтвердіть перевірку щонайменше двох незалежних ознак власника' });
    const accountEmail = String(req.body?.accountEmail || '').trim().toLowerCase();
    if (accountEmail !== String(ticket.recoveryRequest?.possibleEmail || '').trim().toLowerCase()) {
      return res.status(409).json({ error: 'Email підтвердженого акаунта не збігається зі старим email у запиті' });
    }
    const deliveryEmail = String(req.body?.deliveryEmail || ticket.recoveryRequest?.contactEmail || '').trim().toLowerCase();
    if (!deliveryEmail.includes('@') || deliveryEmail.length > 254) return res.status(400).json({ error: 'Вкажіть коректний email для отримання посилання' });
    const result = authService.createAdminRecoveryToken(accountEmail, ticket.id);
    const frontendUrl = String(process.env.FRONTEND_URL || '').replace(/\/$/, '');
    if (!frontendUrl) return res.status(500).json({ error: 'FRONTEND_URL не налаштовано' });
    const url = `${frontendUrl}/access-recovery-complete.html?token=${encodeURIComponent(result.token)}`;
    const delivery = await sendEmail({
      to: deliveryEmail,
      subject: 'Безпечне відновлення доступу — Сигнал',
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto"><h2>Відновлення доступу</h2><p>Підтримка Сигнал підтвердила запит на відновлення акаунта.</p><p><a href="${url}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:9px;font-weight:bold">Задати нові дані входу</a></p><p>Посилання одноразове та діє до ${new Date(result.expiresAt).toLocaleString('uk-UA')}.</p><p style="color:#666;font-size:12px">Якщо ви не подавали цей запит, не відкривайте посилання.</p></div>`,
    });
    if (delivery?.mocked) throw new Error('Лист не надіслано: RESEND_API_KEY не налаштований на сервері');
    ticketStore.updateTicket(ticket.id, { status: 'waiting_customer', verifiedAccountEmail: accountEmail, recoveryDeliveryEmail: deliveryEmail, recoveryLinkCreatedAt: new Date().toISOString(), recoveryLinkExpiresAt: result.expiresAt });
    auditStore.log({ adminEmail: req.admin.email, action: 'access_recovery_link_sent', target: accountEmail, details: { ticketId: ticket.id, deliveryEmail, expiresAt: result.expiresAt } });
    res.json({ ok: true, sent: true, sentTo: deliveryEmail, expiresAt: result.expiresAt });
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

// Зміна статусу/пріоритету — заборонено для Viewer
app.patch('/api/admin/tickets/:id', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  const { status, priority, assignedTo } = req.body;
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error:'Тікет не знайдено' });
  if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });
  if (assignedTo !== undefined && req.admin.role !== 'super_admin') return res.status(403).json({ error:'Виконавця може змінити лише Super Admin' });
  const assignedAdmin = assignedTo ? adminStore.readAll().admins?.[assignedTo] : null;
  if (assignedTo && (!assignedAdmin || assignedAdmin.blocked || assignedAdmin.role !== 'admin')) {
    return res.status(400).json({ error: 'Можна призначити лише активного адміністратора з роллю Admin' });
  }
  if (status === 'closed') {
    const deleted = ticketStore.deleteTicket(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Тікет не знайдено' });
    auditStore.log({ adminEmail: req.admin.email, action: 'ticket_closed_and_deleted', target: `#${req.params.id}` });
    return res.json({ ok: true, deleted: true });
  }
  const previousAssignee = ticket.assignedTo || null;
  const assignmentChanged = assignedTo !== undefined && (assignedTo || null) !== previousAssignee;
  const assignmentEvent = assignmentChanged ? { from:previousAssignee, to:assignedTo || null, by:req.admin.email, createdAt:new Date().toISOString() } : null;
  const updated = ticketStore.updateTicket(req.params.id, {
    ...(status && { status }),
    ...(priority && { priority }),
    ...(assignedTo !== undefined && { assignedTo: assignedTo || null }),
    ...(assignmentEvent && { assignmentHistory:[...(ticket.assignmentHistory || []), assignmentEvent] }),
  });
  if (!updated) return res.status(404).json({ error: 'Тікет не знайдено' });
  auditStore.log({ adminEmail: req.admin.email, action: assignmentChanged ? 'ticket_assigned' : 'ticket_updated', target: `#${req.params.id}`, details: { status, priority, assignedTo, previousAssignee } });
  let delivery = null;
  if (assignmentChanged && assignedTo) {
    const [emailResult, pushResult] = await Promise.allSettled([
      sendEmail({ to:assignedTo, subject:`Вам призначено звернення #${updated.id} — Сигнал`, html:emailTemplates.ticketAssignment({ticketId:updated.id,customerEmail:updated.email,subject:updated.subject}) }),
      sendToEmail(`admin:${assignedTo}`, { title:'Вам призначено звернення', body:`Тікет #${updated.id}: ${updated.subject}`, url:`/admin-ticket.html?id=${updated.id}`, tag:`assigned-ticket-${updated.id}` }),
    ]);
    delivery = { email:emailResult.status === 'fulfilled' && !emailResult.value?.mocked, push:pushResult.status === 'fulfilled' ? pushResult.value : 0 };
    auditStore.log({adminEmail:req.admin.email,action:'ticket_assignment_notified',target:assignedTo,details:{ticketId:updated.id,...delivery}});
  }
  res.json({...updated,...(delivery?{notificationDelivery:delivery}:{})});
});

// Відповідь клієнту (реальний email) — заборонено для Viewer
app.post('/api/admin/tickets/:id/reply', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  try {
    const { message, attachment } = req.body;
    const ticket = ticketStore.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
    if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });

    const updated = ticketStore.addMessage(req.params.id, { from: 'admin', text: message, attachment });
    const customerMessage = await translationService.forEmail(ticket.email, message, getUser);
    const customerTitle = await translationService.forEmail(ticket.email, 'Нова відповідь від підтримки', getUser);
    // Do not put the reply text in a lock-screen notification. The user can
    // open the protected ticket by tapping the generic push instead.
    sendToEmail(ticket.email, {
      title: customerTitle,
      body: `У зверненні #${ticket.id} є нове повідомлення.`,
      url: `/ticket.html?id=${ticket.id}`,
      tag: `support-${ticket.id}`,
    }).catch((pushErr) => console.error(`[push] support reply #${ticket.id}:`, pushErr.message));
    auditStore.log({ adminEmail: req.admin.email, action: 'ticket_reply_sent', target: `#${req.params.id}` });

    try {
      await sendEmail({
        to: ticket.email,
        subject: `[Сигнал Підтримка #${ticket.id}] ${ticket.subject}`,
        html: emailTemplates.supportReply({ ticketId:ticket.id, subject:ticket.subject, message:customerMessage }),
        replyTo: process.env.RESEND_INBOUND_ADDRESS || undefined,
      });
    } catch (emailErr) {
      console.error('Не вдалося надіслати email по тікету:', emailErr.message);
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Внутрішня нотатка — видно ТІЛЬКИ адмінам, email не надсилається. Заборонено для Viewer
app.post('/api/admin/tickets/:id/note', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), (req, res) => {
  const { text } = req.body;
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });
  const updated = ticketStore.addMessage(req.params.id, { from: 'note', text });
  auditStore.log({ adminEmail: req.admin.email, action: 'ticket_note_added', target: `#${req.params.id}` });
  res.json(updated);
});

// Audit Log — тільки Super Admin (це чутливі дані про дії всієї команди)
app.get('/api/admin/audit-log', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  res.json(auditStore.getAll());
});

app.get('/api/admin/dashboard', adminAuth.requireAdmin, (req, res) => {
  const users = Object.values(getAllUsers());
  const tickets = ticketStore.getAllTickets();
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const active = users.filter((user) => user.status === 'active');
  const highUsage = active.filter((user) => {
    const esim = user.esim || {};
    return esim.dataLimitGb && (Number(esim.usedGb || 0) / Number(esim.dataLimitGb)) >= 0.8;
  });
  res.json({
    users: { total: users.length, registeredToday: users.filter((user) => new Date(user.createdAt || 0).getTime() >= since).length, active: active.length, blocked: users.filter((user) => user.status === 'blocked').length },
    esim: { active: active.filter((user) => user.esim?.orderNo).length, failed: users.filter((user) => user.status === 'payment_ok_esim_failed').length, highUsage: highUsage.length, expiringSoon: active.filter((user) => user.esim?.expiredTime && new Date(user.esim.expiredTime).getTime() - Date.now() < 7 * 86400000).length },
    tickets: { total: tickets.length, open: tickets.filter((ticket) => ticket.status === 'open').length, unassigned: tickets.filter((ticket) => !ticket.assignedTo && !['resolved', 'closed'].includes(ticket.status)).length, waitingOver24h: tickets.filter((ticket) => ticket.status === 'waiting_customer' && Date.now() - new Date(ticket.updatedAt).getTime() > 24 * 3600000).length },
    recentTickets: tickets.slice(0, 5),
  });
});

app.get('/api/admin/operations', adminAuth.requireAdmin, (req, res) => res.json(operationsStore.store()));
app.post('/api/admin/announcements', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req,res) => {
  const { title, message, audience='all', expiresAt=null, sendPush=false, type='notice' } = req.body || {};
  if(!title || !message) return res.status(400).json({error:'Вкажіть заголовок і текст'});
  const isMaintenance = type === 'maintenance' || /^\s*\[maintenance\]/i.test(String(title));
  const normalizedAudience = isMaintenance ? 'all' : String(audience || 'all').trim().toLowerCase();
  if (normalizedAudience !== 'all' && !authStore.readAll().users?.[normalizedAudience] && !getUser(normalizedAudience)) return res.status(404).json({error:'Користувача з таким email не знайдено'});
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) return res.status(400).json({error:'Некоректна дата завершення'});
  const announcement={ id:Date.now().toString(36), title:String(title).replace(/^\s*\[maintenance\]\s*/i,'').slice(0,100), message:String(message).slice(0,500), audience:normalizedAudience, type:isMaintenance?'maintenance':'notice', startsAt:new Date().toISOString(), expiresAt:expiresAt||null, createdBy:req.admin.email };
  operationsStore.store().announcements.unshift(announcement); operationsStore.save();
  let pushRecipients = 0, pushDelivered = 0;
  if(sendPush && isPushConfigured()) {
    const recipients = normalizedAudience === 'all' ? Object.keys(authStore.readAll().users || {}) : [normalizedAudience];
    pushRecipients = recipients.length;
    for (const email of recipients) {
      try {
        const [localizedTitle, localizedMessage] = await Promise.all([translationService.forEmail(email, announcement.title, getUser), translationService.forEmail(email, announcement.message, getUser)]);
        pushDelivered += await sendToEmail(email,{title:localizedTitle,body:localizedMessage,url:'/dashboard.html',tag:`announcement-${announcement.id}`});
      } catch (error) { console.error(`[announcement push] ${email}:`, error.message); }
    }
  }
  auditStore.log({adminEmail:req.admin.email,action:'announcement_created',target:normalizedAudience,details:{id:announcement.id,type:announcement.type,sendPush,pushRecipients,pushDelivered}}); res.json({...announcement,pushRecipients,pushDelivered,pushConfigured:isPushConfigured()});
});
app.post('/api/admin/notify-bulk', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req,res) => {
  const { channel, title, message, status, plan, minUsage } = req.body || {};
  if(!['push','email'].includes(channel) || !message) return res.status(400).json({error:'Оберіть канал і введіть текст'});
  const users=Object.values(getAllUsers()).filter(user => (!status || user.status===status) && (!plan || user.plan===plan) && (!minUsage || (user.esim?.dataLimitGb && (user.esim.usedGb||0)/user.esim.dataLimitGb*100>=Number(minUsage))));
  if(users.length>200) return res.status(400).json({error:'Занадто багато отримувачів; звузьте фільтр до 200'});
  let delivered=0;
  for(const user of users){ try { const localizedTitle=await translationService.forEmail(user.email,title||'Сигнал',getUser); const localizedMessage=await translationService.forEmail(user.email,String(message),getUser); if(channel==='push') delivered += await sendToEmail(user.email,{title:localizedTitle,body:localizedMessage,url:'/dashboard.html',tag:'bulk-message'}); else { await sendEmail({to:user.email,subject:localizedTitle,html:`<p>${localizedMessage.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\n/g,'<br>')}</p>`}); delivered++; } } catch(e){} }
  auditStore.log({adminEmail:req.admin.email,action:'bulk_notification_sent',target:`${users.length} users`,details:{channel,status,plan,minUsage,delivered}}); res.json({ok:true,recipients:users.length,delivered});
});
app.delete('/api/admin/announcements/:id', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), (req,res)=>{ const s=operationsStore.store(); s.announcements=s.announcements.filter(a=>a.id!==req.params.id); operationsStore.save(); auditStore.log({adminEmail:req.admin.email,action:'announcement_deleted',target:req.params.id}); res.json({ok:true}); });
app.post('/api/admin/users/:email/note', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), (req,res)=>{ const text=String(req.body?.text||'').trim(); if(!text) return res.status(400).json({error:'Введіть нотатку'}); const s=operationsStore.store(); (s.notes[req.params.email] ||= []).push({text:text.slice(0,1000),by:req.admin.email,createdAt:new Date().toISOString()}); operationsStore.save(); auditStore.log({adminEmail:req.admin.email,action:'user_note_added',target:req.params.email}); res.json({ok:true}); });
app.post('/api/admin/blacklist', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), (req,res)=>{ const {type,value}=req.body||{}; if(!['emails','iccids'].includes(type)||!value) return res.status(400).json({error:'Некоректні дані'}); const list=operationsStore.store().blacklist[type]; if(!list.includes(value)) list.push(value); operationsStore.save(); auditStore.log({adminEmail:req.admin.email,action:'blacklist_added',target:value}); res.json({ok:true}); });
app.delete('/api/admin/blacklist/:type/:value', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), (req,res)=>{ const list=operationsStore.store().blacklist[req.params.type]; if(!list) return res.status(400).json({error:'Некоректний список'}); operationsStore.store().blacklist[req.params.type]=list.filter(v=>v!==req.params.value); operationsStore.save(); res.json({ok:true}); });
app.post('/api/admin/templates', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), (req,res)=>{ const {title,text}=req.body||{}; if(!title||!text) return res.status(400).json({error:'Вкажіть назву і текст'}); const template={id:Date.now().toString(36),title:String(title).slice(0,100),text:String(text).slice(0,2000),by:req.admin.email}; operationsStore.store().templates.unshift(template); operationsStore.save(); res.json(template); });
app.delete('/api/admin/templates/:id', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), (req,res)=>{ const s=operationsStore.store(); s.templates=s.templates.filter(t=>t.id!==req.params.id); operationsStore.save(); res.json({ok:true}); });
app.get('/api/admin/backup', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req,res)=>{ auditStore.log({adminEmail:req.admin.email,action:'backup_exported'}); res.attachment(`signal-backup-${new Date().toISOString().slice(0,10)}.json`).json({ exportedAt:new Date().toISOString(), users:getAllUsers(), auth:authStore.readAll(), tickets:ticketStore.getAllTickets(), operations:operationsStore.store(), audit:auditStore.getAll({limit:10000}) }); });
app.get('/api/admin/system-status', adminAuth.requireAdmin, (req,res)=>res.json({ server:'ok', database:Boolean(process.env.DATABASE_URL), push:isPushConfigured(), esimProvider:Boolean(process.env.ESIM_PROVIDER_API_KEY), stripe:Boolean(process.env.STRIPE_SECRET_KEY), checkedAt:new Date().toISOString() }));

// Список користувачів для адмінки
app.get('/api/admin/users', adminAuth.requireAdmin, (req, res) => {
  const authData = authStore.readAll();
  const allEmails = new Set([...Object.keys(authData.users || {}), ...Object.keys(getAllUsers())]);
  const users = [...allEmails].map(email => ({
    email,
    createdAt: authData.users[email]?.createdAt || getUser(email)?.createdAt,
    subscription: getUser(email) || null,
  }));
  res.json(users);
});

app.get('/api/admin/users/:email', adminAuth.requireAdmin, (req, res) => {
  const email = req.params.email;
  const authUser = authStore.readAll().users?.[email];
  const subscription = getUser(email);
  if (!authUser && !subscription) return res.status(404).json({ error: 'Користувача не знайдено' });
  const safeSubscription = subscription ? JSON.parse(JSON.stringify(subscription)) : null;
  if (req.admin.role !== 'super_admin' && safeSubscription?.esim) {
    delete safeSubscription.esim.activationCode;
    delete safeSubscription.esim.qrCodeUrl;
  }
  const sessions = Object.values(authStore.readAll().sessions || {}).filter((session) => session.email === email).length;
  const pushDevices = pushStore.subscriptionsFor(email).length;
  res.json({
    email,
    account: authUser ? {
      createdAt: authUser.createdAt || null,
      lastLoginAt: authUser.lastLoginAt || null,
    } : null,
    subscription: safeSubscription,
    security: { activeSessions: sessions, pushDevices },
    notes: operationsStore.store().notes[email] || [],
    tickets: ticketStore.getTicketsByEmail(email),
  });
});

app.get('/api/admin/users/:email/refundable-payments', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    const user = getUser(email);
    const payments = await listRefundablePaymentsByEmail(email, user?.stripeCustomerId || null);
    res.json({ payments });
  } catch (error) {
    res.status(502).json({ error: `Stripe: ${error.message}` });
  }
});

app.post('/api/admin/users/:email/sync-stripe-status', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const user = getUser(email);
  if (!user && !authStore.readAll().users?.[email]) return res.status(404).json({ error:'Користувача не знайдено' });
  try {
    const state = await getSubscriptionStateByEmail(email, user?.stripeCustomerId || null);
    const status = state.active.length ? 'active' : 'canceled';
    saveUser(email, {
      status,
      stripeCustomerIds: state.customerIds,
      stripeSubscriptionIds: state.subscriptions.map(subscription => subscription.id),
      stripeStatusSyncedAt: new Date().toISOString(),
      ...(status === 'canceled' ? { canceledAt:new Date().toISOString(), canceledReason:'stripe_sync' } : {}),
    });
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_status_synchronized', target:email, details:{ status, customerIds:state.customerIds, subscriptions:state.subscriptions } });
    res.json({ ok:true, status, activeSubscriptions:state.active.length, subscriptions:state.subscriptions });
  } catch (error) {
    res.status(502).json({ error:`Не вдалося перевірити Stripe: ${error.message}` });
  }
});

app.post('/api/admin/users/:email/sync-purchases', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const user = getUser(email);
  if (!user && !authStore.readAll().users?.[email]) return res.status(404).json({ error:'Користувача не знайдено' });
  try {
    const imported = await syncPurchasesForUser(email);
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_purchases_synchronized', target:email, details:{ imported:imported.length } });
    res.json({ ok:true, imported:imported.length, purchases:getUser(email)?.purchases || [] });
  } catch (error) {
    res.status(502).json({ error:`Не вдалося завантажити покупки зі Stripe: ${error.message}` });
  }
});

app.get('/api/admin/purchases', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support','viewer'), (req, res) => {
  const purchases = Object.values(getAllUsers()).flatMap(user => (user.purchases || []).map(purchase => ({ ...purchase, email:user.email, accountStatus:user.status || null })))
    .sort((a,b) => new Date(b.paidAt || b.createdAt || 0) - new Date(a.paidAt || a.createdAt || 0));
  res.json({ purchases, totals:{ purchases:purchases.length, paid:purchases.filter(item=>item.paymentStatus==='paid').length, failed:purchases.filter(item=>item.fulfillmentStatus==='failed').length, provisioned:purchases.filter(item=>item.fulfillmentStatus==='provisioned').length } });
});

app.get('/api/admin/purchases/:purchaseId', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), async (req, res) => {
  const purchaseId = String(req.params.purchaseId || '');
  const owner = Object.values(getAllUsers()).find(user => (user.purchases || []).some(purchase => purchase.id === purchaseId));
  const purchase = owner?.purchases?.find(item => item.id === purchaseId);
  if (!owner || !purchase) return res.status(404).json({ error:'Покупку не знайдено' });
  try {
    const stripe = await getCheckoutPurchaseDetails(purchase.stripeSessionId || purchase.id);
    const timeline = [
      { type:'payment', title:'Stripe підтвердив оплату', at:purchase.paidAt || purchase.createdAt, detail:`${purchase.amountCents == null ? '—' : (purchase.amountCents/100).toFixed(2)} ${(purchase.currency||'').toUpperCase()}` },
      ...(purchase.retryStartedAt ? [{ type:'retry', title:'Адміністратор повторив видачу', at:purchase.retryStartedAt, detail:null }] : []),
      ...(purchase.failedAt ? [{ type:'failed', title:'Видача eSIM завершилась помилкою', at:purchase.failedAt, detail:purchase.fulfillmentError || null }] : []),
      ...(purchase.fulfilledAt ? [{ type:'provisioned', title:'eSIM успішно видано', at:purchase.fulfilledAt, detail:`Order ${purchase.esimOrderNo || '—'} · ICCID ${purchase.iccid || '—'}` }] : []),
      ...stripe.refunds.map(refund => ({ type:'refund', title:`Повернення ${refund.status}`, at:refund.createdAt, detail:`${(refund.amount/100).toFixed(2)} ${refund.currency.toUpperCase()} · ${refund.id}` })),
      ...(stripe.subscription?.canceledAt ? [{ type:'canceled', title:'Stripe-підписку скасовано', at:stripe.subscription.canceledAt, detail:stripe.subscription.id }] : []),
    ].filter(item=>item.at).sort((a,b)=>new Date(a.at)-new Date(b.at));
    res.json({ email:owner.email, accountStatus:owner.status || null, purchase, stripe, timeline });
  } catch (error) {
    res.status(502).json({ error:`Не вдалося отримати деталі Stripe: ${error.message}` });
  }
});

app.post('/api/admin/purchases/sync-all', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req, res) => {
  const emails = [...new Set([...Object.keys(authStore.readAll().users || {}), ...Object.keys(getAllUsers())])];
  if (emails.length > 500) return res.status(409).json({ error:'Забагато користувачів для одного запуску. Зверніться до розробника для фонової синхронізації.' });
  let imported = 0;
  const errors = [];
  for (const email of emails) {
    try { imported += await syncPurchasesForUser(email); }
    catch (error) { errors.push({ email, error:error.message }); }
  }
  auditStore.log({ adminEmail:req.admin.email, action:'all_stripe_purchases_synchronized', target:`${emails.length} users`, details:{ imported, errors:errors.length } });
  res.json({ ok:true, users:emails.length, imported, errors });
});

app.post('/api/admin/users/:email/refund', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const { chargeId, amount, reason = 'requested_by_customer', confirmationEmail, requestId } = req.body || {};
  if (String(confirmationEmail || '').trim().toLowerCase() !== email) return res.status(400).json({ error: 'Email підтвердження не збігається' });
  if (!/^ch_[A-Za-z0-9]+$/.test(String(chargeId || ''))) return res.status(400).json({ error: 'Некоректний Stripe-платіж' });
  if (!['requested_by_customer','duplicate','fraudulent'].includes(reason)) return res.status(400).json({ error: 'Некоректна причина повернення' });
  if (!/^[A-Za-z0-9-]{16,80}$/.test(String(requestId || ''))) return res.status(400).json({ error: 'Некоректний ідентифікатор операції' });
  const amountCents = Number(amount);
  const user = getUser(email);
  try {
    const customerIds = await findCustomerIdsByEmail(email, user?.stripeCustomerId || null);
    if (!customerIds.length) return res.status(404).json({ error: 'Stripe-платежі за цим email не знайдено' });
    const refund = await refundPayment({
      customerIds,
      chargeId: String(chargeId),
      amount: amountCents,
      reason,
      metadata: { signal_user_email: email, signal_admin_email: req.admin.email },
      idempotencyKey: `signal-admin-refund-${requestId}`,
    });
    let canceledSubscriptions = [], cancellationErrors = [];
    try {
      const cancellation = await cancelAllSubscriptionsForCustomers(customerIds);
      canceledSubscriptions = cancellation.canceled;
      cancellationErrors = cancellation.errors;
      if (!cancellationErrors.length) saveUser(email, {
          status: 'canceled',
          canceledAt: new Date().toISOString(),
          canceledReason: 'admin_refund',
          lastRefund: { id:refund.id, chargeId, amount:refund.amount, currency:refund.currency, status:refund.status, createdAt:new Date().toISOString() },
        });
    } catch (error) {
      cancellationErrors = [{ id:null, error:error.message }];
      console.error(`[refund cancellation] ${email}:`, error.message);
    }
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_refund_created', target:email, details:{ refundId:refund.id, chargeId, amount:refund.amount, currency:refund.currency, status:refund.status, reason, canceledSubscriptions:canceledSubscriptions.map(item=>item.id), cancellationErrors } });
    res.json({ ok:true, refund:{ id:refund.id, amount:refund.amount, currency:refund.currency, status:refund.status }, subscription:{ canceled:!cancellationErrors.length, canceledCount:canceledSubscriptions.length, ids:canceledSubscriptions.map(item=>item.id), errors:cancellationErrors } });
  } catch (error) {
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_refund_failed', target:email, details:{ chargeId, amount:amountCents, reason, error:error.message } });
    res.status(502).json({ error:`Stripe не виконав повернення: ${error.message}` });
  }
});

// Permanently remove the application account so the same email can register
// again. Billing is stopped before local identity data is erased. Historical
// financial/audit records may still be retained by Stripe or the audit log.
app.delete('/api/admin/users/:email', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const confirmationEmail = String(req.body?.confirmationEmail || '').trim().toLowerCase();
  if (confirmationEmail !== email) return res.status(400).json({ error: 'Для підтвердження введіть точний email користувача' });

  const authUser = authStore.readAll().users?.[email];
  const user = getUser(email);
  if (!authUser && !user) return res.status(404).json({ error: 'Користувача не знайдено' });

  try {
    let stripeSubscriptionCanceled = false;
    let stripeCustomerDeleted = false;
    if (user?.stripeSubscriptionId && user.status !== 'canceled') {
      try {
        await cancelSubscription(user.stripeSubscriptionId);
        stripeSubscriptionCanceled = true;
      } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
      }
    }
    if (user?.stripeCustomerId) {
      try {
        await deleteStripeCustomer(user.stripeCustomerId);
        stripeCustomerDeleted = true;
      } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
        stripeCustomerDeleted = true;
      }
    }

    const authRemoval = authService.deleteAccountAuth(email);
    const pushSubscriptions = pushStore.removeAllForEmail(email);
    const tickets = ticketStore.deleteTicketsByEmail(email);
    const diagnosticEvents = diagnosticsStore.removeForEmail(email);

    const operations = operationsStore.store();
    delete operations.notes?.[email];
    if (Array.isArray(operations.feedback)) operations.feedback = operations.feedback.filter(item => item.email !== email);
    if (Array.isArray(operations.blacklist?.emails)) operations.blacklist.emails = operations.blacklist.emails.filter(item => String(item).toLowerCase() !== email);
    operationsStore.save();

    deleteUser(email);
    for (const related of Object.values(getAllUsers())) {
      const patch = {};
      if (related.referredBy === email) patch.referredBy = null;
      if (Array.isArray(related.referrals)) patch.referrals = related.referrals.filter(item => item.email !== email);
      if (Object.keys(patch).length) saveUser(related.email, patch);
    }

    auditStore.log({
      adminEmail: req.admin.email,
      action: 'user_account_permanently_deleted',
      target: email,
      details: { stripeSubscriptionCanceled, stripeCustomerDeleted, sessions: authRemoval.sessions, pushSubscriptions, tickets, diagnosticEvents },
    });
    res.json({
      ok: true,
      emailReusable: true,
      stripeSubscriptionCanceled,
      stripeCustomerDeleted,
      removed: { sessions: authRemoval.sessions, pushSubscriptions, tickets },
      providerEsimNote: user?.esim ? 'Виданий профіль eSIM відв’язано від застосунку; у провайдера він може зберігатися до завершення строку дії.' : null,
    });
  } catch (error) {
    console.error(`[admin delete user] ${email}:`, error.message);
    res.status(502).json({ error: `Видалення зупинено: ${error.message}. Локальний акаунт не видалено.` });
  }
});

app.post('/api/admin/users/:email/revoke-sessions', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), (req, res) => {
  const email = req.params.email;
  if (!authStore.readAll().users?.[email]) return res.status(404).json({ error: 'Користувача не знайдено' });
  const revoked = authService.revokeAllSessions(email);
  auditStore.log({ adminEmail: req.admin.email, action: 'user_sessions_revoked', target: email, details: { revoked } });
  res.json({ ok: true, revoked });
});

app.post('/api/admin/users/:email/notify', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  const email = req.params.email;
  const { channel, title, message } = req.body || {};
  if (!getUser(email) && !authStore.readAll().users?.[email]) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (!message || String(message).trim().length > 500) return res.status(400).json({ error: 'Введи повідомлення до 500 символів' });
  try {
    let delivered = 0;
    const localizedTitle = await translationService.forEmail(email, title || 'Сигнал', getUser);
    const localizedMessage = await translationService.forEmail(email, String(message), getUser);
    if (channel === 'push') {
      if (!isPushConfigured()) return res.status(503).json({ error: 'Push не налаштовано на сервері. Додайте правильну пару VAPID ключів у Render Environment.' });
      if (!pushStore.subscriptionsFor(email).length) return res.status(409).json({ error: 'У користувача немає підключеного push-пристрою. Попросіть його відкрити «Сповіщення» та натиснути «Увімкнути/перепідключити push».' });
      delivered = await sendToEmail(email, { title: localizedTitle, body: localizedMessage, url: '/dashboard.html', tag: 'admin-message' });
      if (!delivered) return res.status(410).json({ error: 'Push-підписка користувача прострочена або браузер її відхилив. Користувачу потрібно перепідключити push у застосунку.' });
    }
    else if (channel === 'email') {
      await sendEmail({ to: email, subject: localizedTitle, html: `<p>${localizedMessage.replace(/[&<>]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[char])).replace(/\n/g, '<br>')}</p>` });
      delivered = 1;
    } else return res.status(400).json({ error: 'Оберіть push або email' });
    auditStore.log({ adminEmail: req.admin.email, action: 'user_notification_sent', target: email, details: { channel, delivered } });
    res.json({ ok: true, delivered });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/admin/users/:email/custom-package-checkout', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = req.params.email;
  const { packageCode, packageName, amountCents, currency = 'usd', dataLimitGb = null, durationDays = null, location = '' } = req.body || {};
  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (user.esim?.orderNo && user.status === 'active') return res.status(409).json({ error: 'У користувача вже є активна eSIM. Продаж другого профілю буде додано окремо, щоб не замінити поточну eSIM.' });
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(packageCode || ''))) return res.status(400).json({ error: 'Некоректний packageCode' });
  if (!String(packageName || '').trim() || String(packageName).length > 120) return res.status(400).json({ error: 'Вкажіть назву пакета' });
  if (!Number.isInteger(Number(amountCents)) || Number(amountCents) < 50 || Number(amountCents) > 1000000) return res.status(400).json({ error: 'Вкажіть ціну в центах: від $0.50 до $10,000' });
  if (!/^[a-z]{3}$/i.test(currency)) return res.status(400).json({ error: 'Некоректна валюта' });
  try {
    const session = await createCustomPackageCheckout({ email, packageCode: String(packageCode), packageName: String(packageName).trim(), amountCents: Number(amountCents), currency: String(currency).toLowerCase(), dataLimitGb, durationDays, location });
    auditStore.log({ adminEmail: req.admin.email, action: 'custom_package_checkout_created', target: email, details: { packageCode, amountCents, currency } });
    res.json({ ok: true, url: session.url });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/admin/referrals', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), (req, res) => {
  res.json(Object.values(getAllUsers()).filter((user) => user.referredBy).map((user) => ({ email: user.email, referredBy: user.referredBy, status: user.referralRewardStatus || 'pending_first_payment', packageCode: user.referralRewardPackageCode || null, createdAt: user.createdAt || null })));
});

// Resolve the inviter first, then ask eSIM Access which 1 GB top-ups are
// compatible with that exact ICCID. This removes manual package-code entry.
app.get('/api/admin/referrals/:email/compatible-topups', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const invited = getUser(req.params.email);
  if (!invited?.referredBy) return res.status(404).json({ error: 'Для цього користувача не знайдено того, хто запросив' });
  const beneficiary = getUser(invited.referredBy);
  if (!beneficiary?.esim?.iccid) return res.status(409).json({ error: 'У того, хто запросив, немає активної eSIM з ICCID' });
  try {
    const packages = await listPackages({ type: 'TOPUP', iccid: beneficiary.esim.iccid });
    const normalized = packages.map(item => {
      const bytes = Number(item.volume || item.dataVolume || 0);
      const volumeGb = bytes > 0 ? +(bytes / (1024 ** 3)).toFixed(2) : null;
      const rawPrice = Number(item.price ?? 0);
      return {
        packageCode: item.packageCode || item.slug || null,
        slug: item.slug || null,
        name: item.name || item.description || item.packageCode || item.slug || 'Top-up',
        location: item.location || null,
        volumeGb,
        duration: item.duration ?? null,
        durationUnit: item.durationUnit || null,
        currencyCode: item.currencyCode || 'USD',
        price: Number.isFinite(rawPrice) && rawPrice > 0 ? +(rawPrice / 10000).toFixed(2) : null,
      };
    }).filter(item => item.packageCode && item.volumeGb != null && item.volumeGb >= 0.8 && item.volumeGb <= 1.2);
    if (!normalized.length) return res.status(404).json({ error: 'eSIM Access не повернув сумісних пакетів приблизно на 1 ГБ для цієї eSIM' });
    res.json({ beneficiary: beneficiary.email, iccidLast4: String(beneficiary.esim.iccid).slice(-4), packages: normalized });
  } catch (error) {
    console.error(`[referral topups] ${invited.referredBy}:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/admin/referrals/:email/prepare-reward', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = req.params.email;
  const user = getUser(email);
  const packageCode = String(req.body?.packageCode || '').trim();
  if (!user?.referredBy) return res.status(404).json({ error: 'Запрошення для цього користувача не знайдено' });
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(packageCode)) return res.status(400).json({ error: 'Вкажіть коректний packageCode бонусу' });
  saveUser(email, { referralRewardStatus: 'waiting_12_24h', referralRewardPackageCode: packageCode, referralRewardPreparedAt: new Date().toISOString() });
  const inviter = getUser(user.referredBy);
  if (inviter?.referrals) saveUser(inviter.email, { referrals: inviter.referrals.map((item) => item.email === email ? { ...item, status: 'waiting_12_24h', packageCode } : item) });
  sendToEmail(email, { title: 'Винагорода за запрошення', body: 'Винагорода буде нарахована протягом 12–24 годин.', url: '/profile.html', tag: 'referral-reward' }).catch(() => {});
  auditStore.log({ adminEmail: req.admin.email, action: 'referral_reward_prepared', target: email, details: { packageCode } });
  res.json({ ok: true, status: 'waiting_12_24h' });
});

app.post('/api/admin/referrals/:email/credit-reward', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const invitedEmail = req.params.email;
  const invited = getUser(invitedEmail);
  const packageCode = String(req.body?.packageCode || invited?.referralRewardPackageCode || '').trim();
  if (!invited?.referredBy) return res.status(404).json({ error: 'Запрошення для цього користувача не знайдено' });
  if (invited.referralRewardStatus === 'credited_to_inviter') return res.status(409).json({ error: 'Винагороду вже нараховано' });
  const inviter = getUser(invited.referredBy);
  if (!inviter?.esim?.orderNo || (!inviter.esim.esimTranNo && !inviter.esim.iccid)) return res.status(409).json({ error: 'У того, хто запросив, немає активної eSIM для поповнення' });
  try {
    const topup = await topupEsim({ esimTranNo: inviter.esim.esimTranNo, iccid: inviter.esim.iccid, packageCode });
    saveUser(inviter.email, { esim: { ...inviter.esim, ...(topup.iccid ? { iccid: topup.iccid } : {}), ...(topup.totalGb != null ? { dataLimitGb: topup.totalGb } : {}), ...(topup.usedGb != null ? { usedGb: topup.usedGb } : {}), ...(topup.remainingGb != null ? { remainingGb: topup.remainingGb } : {}), ...(topup.expiredTime ? { expiredTime: topup.expiredTime } : {}), lastTopupAt: new Date().toISOString(), lastTopupPackageCode: packageCode } });
    saveUser(invitedEmail, { referralRewardStatus: 'credited_to_inviter', referralRewardCreditedAt: new Date().toISOString() });
    if (inviter.referrals) saveUser(inviter.email, { referrals: inviter.referrals.map((item) => item.email === invitedEmail ? { ...item, status: 'credited', packageCode, creditedAt: new Date().toISOString() } : item) });
    sendToEmail(inviter.email, { title: 'Винагороду нараховано', body: 'Тобі нараховано реферальний бонус 1 ГБ.', url: '/usage.html', tag: 'referral-credited' }).catch(() => {});
    auditStore.log({ adminEmail: req.admin.email, action: 'referral_reward_credited', target: inviter.email, details: { invitedEmail, packageCode, transactionId: topup.transactionId } });
    res.json({ ok: true, beneficiary: inviter.email, topup });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/admin/users/:email/resync-esim', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = req.params.email;
  const user = getUser(email);
  if (!user?.esim?.orderNo) return res.status(404).json({ error: 'Активну eSIM не знайдено' });
  try {
    const usage = await checkUsage(user.esim.orderNo);
    const usedGb = +(usage.usedBytes / (1024 ** 3)).toFixed(2);
    const totalGb = usage.totalBytes ? +(usage.totalBytes / (1024 ** 3)).toFixed(2) : user.esim.dataLimitGb;
    const remainingGb = totalGb == null ? null : Math.max(0, +(totalGb - usedGb).toFixed(2));
    saveUser(email, { esim: { ...user.esim, usedGb, dataLimitGb: totalGb, remainingGb, lastUpdateTime: usage.lastUpdateTime || new Date().toISOString() } });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_usage_resynced', target: email });
    res.json({ ok: true, usedGb, totalGb, remainingGb });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/admin/users/:email/resend-esim-instructions', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  const email = req.params.email;
  const esim = getUser(email)?.esim;
  if (!esim?.activationCode) return res.status(404).json({ error: 'Код активації eSIM не знайдено' });
  try {
    await sendEmail({ to: email, subject: 'Інструкція встановлення eSIM', html: `<p>Відкрий застосунок Сигнал → Профіль → Керування eSIM.</p><p>Код активації: <strong>${esim.activationCode}</strong></p><p>Не передавай цей код іншим людям.</p>` });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_instructions_resent', target: email });
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Blocked users cannot sign in. Unblocking restores the exact status they had.
app.patch('/api/admin/users/:email/block', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), (req, res) => {
  const email = req.params.email;
  const { blocked } = req.body || {};
  const authUser = authStore.readAll().users?.[email];
  const user = getUser(email);
  if (!authUser && !user) return res.status(404).json({ error: 'Користувача не знайдено' });

  if (blocked) {
    saveUser(email, { email, status: 'blocked', statusBeforeBlock: user?.status || null, blockedAt: new Date().toISOString() });
    auditStore.log({ adminEmail: req.admin.email, action: 'user_blocked', target: email });
  } else {
    saveUser(email, { email, status: user?.statusBeforeBlock || 'active', statusBeforeBlock: null, blockedAt: null });
    auditStore.log({ adminEmail: req.admin.email, action: 'user_unblocked', target: email });
  }
  res.json({ ok: true, user: getUser(email) });
});

// Recover a paid order whose first eSIM allocation failed.  This endpoint is
// restricted to the Super Admin: it never charges Stripe and only accepts the
// explicit failed state, so it cannot be used to create a second eSIM for an
// already active subscription.
app.post('/api/admin/users/:email/retry-esim', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  const email = req.params.email;
  const user = getUser(email);

  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (user.status !== 'payment_ok_esim_failed') {
    return res.status(409).json({ error: 'Повторна видача доступна лише для оплаченої eSIM зі статусом помилки' });
  }
  if (!user.plan) return res.status(400).json({ error: 'У користувача не знайдено тариф' });
  if (esimRetriesInProgress.has(email)) {
    return res.status(409).json({ error: 'Видача eSIM уже виконується. Зачекайте.' });
  }

  esimRetriesInProgress.add(email);
  saveUser(email, { status: 'esim_retrying' });
  try {
    const esim = await provisionEsim({ email, plan: user.plan });
    saveUser(email, { status: 'active', esim });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_retry_succeeded', target: email, details: { orderNo: esim.orderNo } });
    res.json({ ok: true, esim });
  } catch (err) {
    console.error(`[eSIM retry] ${email}:`, err.message);
    saveUser(email, { status: 'payment_ok_esim_failed' });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_retry_failed', target: email, details: { message: err.message } });
    res.status(502).json({ error: 'eSIM не вдалося видати. Деталі є в Render Logs.' });
  } finally {
    esimRetriesInProgress.delete(email);
  }
});

app.post('/api/admin/users/:email/purchases/:purchaseId/retry-provision', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const purchaseId = String(req.params.purchaseId || '');
  const user = getUser(email);
  const purchase = (user?.purchases || []).find(item => item.id === purchaseId);
  if (!purchase) return res.status(404).json({ error:'Покупку не знайдено' });
  if (purchase.paymentStatus !== 'paid') return res.status(409).json({ error:'Stripe не підтвердив оплату цієї покупки' });
  if (purchase.fulfillmentStatus !== 'failed') return res.status(409).json({ error:'Повторити можна лише невдалу видачу' });
  if (user.status === 'canceled') return res.status(409).json({ error:'Підписку/акаунт скасовано. Спочатку перевірте оплату та статус у Stripe.' });
  if (user.esim?.orderNo && user.status === 'active') return res.status(409).json({ error:'В акаунті вже є активна eSIM. Автоматична заміна могла б стерти її дані.' });
  const retryKey = `${email}:${purchaseId}`;
  if (esimRetriesInProgress.has(retryKey)) return res.status(409).json({ error:'Ця видача вже виконується' });
  esimRetriesInProgress.add(retryKey);
  upsertPurchase(email, purchaseId, { fulfillmentStatus:'provisioning', retryStartedAt:new Date().toISOString(), fulfillmentError:null });
  try {
    const esim = await provisionEsim({ email, plan:purchase.plan, packageCode:purchase.packageCode || '', dataLimitGb:purchase.dataLimitGb });
    esim.dashboardQrExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    saveUser(email, { status:'active', plan:purchase.plan, esim, lastEsimProvisionError:null });
    upsertPurchase(email, purchaseId, { fulfillmentStatus:'provisioned', fulfilledAt:new Date().toISOString(), fulfillmentError:null, esimOrderNo:esim.orderNo || null, iccid:esim.iccid || null, esimTranNo:esim.esimTranNo || null });
    auditStore.log({ adminEmail:req.admin.email, action:'paid_purchase_provision_retried', target:email, details:{ purchaseId, packageCode:purchase.packageCode, orderNo:esim.orderNo } });
    res.json({ ok:true, purchaseId, esim });
  } catch (error) {
    saveUser(email, { status:'payment_ok_esim_failed', lastEsimProvisionError:error.message });
    upsertPurchase(email, purchaseId, { fulfillmentStatus:'failed', failedAt:new Date().toISOString(), fulfillmentError:error.message, fulfillmentErrorCode:error.code || null });
    auditStore.log({ adminEmail:req.admin.email, action:'paid_purchase_provision_retry_failed', target:email, details:{ purchaseId, packageCode:purchase.packageCode, error:error.message } });
    res.status(502).json({ error:`eSIM Access: ${error.message}` });
  } finally {
    esimRetriesInProgress.delete(retryKey);
  }
});

// Reconnect a profile that already exists at eSIM Access after local account
// data was lost. This is read-only at the provider: it does not order or bill.
app.post('/api/admin/users/:email/recover-esim', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  const email = req.params.email;
  const { iccid, plan } = req.body || {};
  const user = getUser(email);

  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });

  try {
    const esim = await recoverEsim({ iccid, plan });
    const previousOrderNo = user.esim?.orderNo || null;
    // A recovery may also deliberately replace stale local eSIM data. It still
    // only reads the provider profile and never creates a Stripe payment/order.
    saveUser(email, { status: 'active', plan, esim });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_recovered', target: email, details: { orderNo: esim.orderNo, previousOrderNo } });
    res.json({ ok: true, esim });
  } catch (err) {
    console.error(`[eSIM recovery] ${email}:`, err.message);
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_recovery_failed', target: email, details: { message: err.message } });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================
// ПІДПИСКА / eSIM
// =========================================================

// ---------- 1. Створити сесію оплати підписки ----------
// Фронтенд викликає це, коли людина натискає "Оформити підписку"
app.post('/api/create-subscription', async (req, res) => {
  try {
    const { email, plan } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'Потрібні email і plan' });
    if (operationsStore.store().blacklist.emails.includes(email.toLowerCase())) return res.status(403).json({ error: 'Цей email недоступний для оплати' });

    const session = await createCheckoutSession({ email, plan });
    // Do not change the current subscription before Stripe confirms payment.
    // If the customer closes Checkout, their existing plan and eSIM stay intact.
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 2. Вебхук від Stripe ----------
// Stripe сам викликає цю адресу, коли оплата пройшла успішно.
// Саме тут ми довіряємо, що гроші реально прийшли, і видаємо eSIM.
async function processSubscriptionRenewal(invoice) {
  const invoiceId = String(invoice.id || '');
  if (!invoiceId) return { ok: false, error: 'Stripe invoice ID is missing' };
  if (renewalInvoicesInProgress.has(invoiceId)) return { ok: false, error: 'Поновлення вже виконується' };
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const user = getUserByStripeCustomerId(customerId);
  if (!user?.email || !user.esim?.iccid || !user.plan) {
    console.warn(`[renewal] ${invoiceId}: user/eSIM/plan not found for customer ${customerId || 'n/a'}`);
    return { ok: false, error: 'Користувача, eSIM або тариф не знайдено' };
  }
  if (user.lastRenewalInvoiceId === invoiceId || user.renewalInvoices?.[invoiceId]?.status === 'succeeded') return { ok: true, duplicate: true };

  renewalInvoicesInProgress.add(invoiceId);
  saveUser(user.email, { renewalInvoices: { ...(user.renewalInvoices || {}), [invoiceId]: { status: 'processing', startedAt: new Date().toISOString() } } });
  try {
    const selected = await findRenewalTopup({ iccid: user.esim.iccid, plan: user.plan });
    const topup = await topupEsim({
      esimTranNo: user.esim.esimTranNo,
      iccid: user.esim.iccid,
      packageCode: selected.packageCode,
      transactionId: `stripe-${invoiceId}`,
    });
    const current = getUser(user.email) || user;
    const now = new Date().toISOString();
    saveUser(user.email, {
      status: 'active',
      lastRenewalInvoiceId: invoiceId,
      lastRenewalAt: now,
      renewalError: null,
      renewalInvoices: { ...(current.renewalInvoices || {}), [invoiceId]: { status: 'succeeded', packageCode: selected.packageCode, completedAt: now } },
      esim: {
        ...current.esim,
        ...(topup.totalGb != null ? { dataLimitGb: topup.totalGb } : {}),
        ...(topup.usedGb != null ? { usedGb: topup.usedGb } : {}),
        ...(topup.remainingGb != null ? { remainingGb: topup.remainingGb } : {}),
        ...(topup.expiredTime ? { expiredTime: topup.expiredTime } : {}),
        lastTopupAt: now,
        lastTopupPackageCode: selected.packageCode,
        lastPushAlertThreshold: null,
      },
    });
    sendToEmail(user.email, { title: 'Тариф успішно поновлено', body: `Оплату отримано. Пакет ${user.plan} автоматично поновлено.`, url: '/dashboard.html', tag: `renewal-${invoiceId.slice(-12)}` }).catch(error => console.error(`[renewal push] ${user.email}:`, error.message));
    console.log(`[renewal] ${user.email}: ${invoiceId} -> ${selected.packageCode}`);
    return { ok: true, packageCode: selected.packageCode };
  } catch (error) {
    const current = getUser(user.email) || user;
    const failedAt = new Date().toISOString();
    saveUser(user.email, {
      status: 'renewal_failed',
      renewalError: error.message,
      renewalFailedAt: failedAt,
      renewalInvoices: { ...(current.renewalInvoices || {}), [invoiceId]: { status: 'failed', message: error.message, failedAt } },
    });
    sendToEmail(user.email, { title: 'Потрібна увага до тарифу', body: 'Оплату отримано, але пакет eSIM ще не поновлено. Підтримка вже бачить помилку.', url: '/support.html', tag: `renewal-failed-${invoiceId.slice(-8)}` }).catch(() => {});
    console.error(`[renewal] ${user.email}: ${invoiceId} failed:`, error.message);
    return { ok: false, error: error.message };
  } finally {
    renewalInvoicesInProgress.delete(invoiceId);
  }
}

app.post('/api/admin/users/:email/retry-renewal', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  const failed = Object.entries(user.renewalInvoices || {})
    .filter(([, item]) => item?.status === 'failed')
    .sort((a, b) => String(b[1].failedAt || '').localeCompare(String(a[1].failedAt || '')))[0];
  if (!failed) return res.status(409).json({ error: 'Немає невдалого оплаченого поновлення для повтору.' });
  const result = await processSubscriptionRenewal({ id: failed[0], customer: user.stripeCustomerId, billing_reason: 'subscription_cycle' });
  auditStore.log({ adminEmail: req.admin.email, action: 'subscription_renewal_retried', target: email, details: { invoiceId: failed[0], ok: Boolean(result?.ok) } });
  if (!result?.ok) return res.status(502).json({ error: result?.error || 'Пакет eSIM не вдалося поновити.' });
  res.json({ ok: true, invoiceId: failed[0], packageCode: result.packageCode });
});

app.post('/api/webhook', async (req, res) => {
  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.metadata.email;
    const plan = session.metadata.plan;
    const packageCode = session.metadata.packageCode || '';
    const dataLimitGb = session.metadata.dataLimitGb === '' || session.metadata.dataLimitGb == null
      ? ({ basic:10, standard:20, unlimited:null }[plan] ?? null)
      : Number(session.metadata.dataLimitGb);
    const durationDays = session.metadata.durationDays ? Number(session.metadata.durationDays) : (plan === 'custom' ? null : 30);
    const purchaseDefaults = {
      kind: plan === 'custom' ? 'custom_package' : 'subscription',
      plan,
      packageCode: packageCode || null,
      packageName: session.metadata.packageName || plan,
      dataLimitGb,
      durationDays,
      location: session.metadata.location || null,
      amountCents: session.amount_total ?? null,
      currency: session.currency || null,
      stripeSessionId: session.id,
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
      stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      paidAt: new Date((session.created || Math.floor(Date.now()/1000)) * 1000).toISOString(),
      paymentStatus: session.payment_status || 'paid',
    };
    const existingPurchase = (getUser(email)?.purchases || []).find(item => item.id === session.id);

    // Save Stripe ownership immediately after confirmed payment. Provisioning
    // can fail later, but the admin must still be able to find and refund it.
    saveUser(email, {
      ...(existingPurchase?.fulfillmentStatus === 'provisioned' ? {} : { status:'payment_confirmed' }),
      plan,
      stripeCustomerId: session.customer,
      ...(session.subscription ? { stripeSubscriptionId: session.subscription } : {}),
    });
    if (existingPurchase?.fulfillmentStatus !== 'provisioned') upsertPurchase(email, session.id, { fulfillmentStatus:'provisioning', fulfillmentError:null }, purchaseDefaults);

    if (existingPurchase?.fulfillmentStatus !== 'provisioned') try {
      // Оплата підтверджена Stripe -> тепер видаємо реальну eSIM
      const esim = await provisionEsim({ email, plan, packageCode, dataLimitGb });
      esim.dashboardQrExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      saveUser(email, {
        status: 'active',
        plan,
        stripeCustomerId: session.customer,
        ...(session.subscription ? { stripeSubscriptionId: session.subscription } : {}),
        esim,
      });
      upsertPurchase(email, session.id, { fulfillmentStatus:'provisioned', fulfilledAt:new Date().toISOString(), fulfillmentError:null, esimOrderNo:esim.orderNo || null, iccid:esim.iccid || null, esimTranNo:esim.esimTranNo || null }, purchaseDefaults);

      console.log(`✅ Підписку і eSIM активовано для ${email}`);
    } catch (err) {
      console.error('Помилка видачі eSIM після оплати:', err);
      saveUser(email, { status: 'payment_ok_esim_failed', lastEsimProvisionError:err.message });
      upsertPurchase(email, session.id, { fulfillmentStatus:'failed', failedAt:new Date().toISOString(), fulfillmentError:err.message, fulfillmentErrorCode:err.code || null }, purchaseDefaults);
    }
    await deliverPurchaseReceipt(email, session.id, purchaseDefaults);
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    let user = getUserByStripeCustomerId(sub.customer);
    if (!user) {
      try {
        const customerEmail = await getCustomerEmail(typeof sub.customer === 'string' ? sub.customer : sub.customer?.id);
        if (customerEmail) user = getUser(customerEmail);
      } catch (error) { console.error('[subscription deleted lookup]', error.message); }
    }
    if (user) {
      const state = await getSubscriptionStateByEmail(user.email, user.stripeCustomerId || null).catch(() => null);
      if (!state || !state.active.length) saveUser(user.email, { status:'canceled', canceledAt:new Date().toISOString(), canceledReason:'stripe_webhook' });
    }
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    // The first invoice is fulfilled by checkout.session.completed. Only a
    // real subscription cycle should top up the existing profile.
    if (invoice.billing_reason === 'subscription_cycle') {
      const renewalResult = await processSubscriptionRenewal(invoice);
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      const user = getUserByStripeCustomerId(customerId);
      if (user?.email) {
        const renewalPurchase = {
          kind:'subscription_renewal', plan:user.plan, packageName:`Поновлення тарифу ${user.plan}`,
          amountCents:invoice.amount_paid ?? null, currency:invoice.currency || null,
          stripeCustomerId:customerId || null, stripeInvoiceId:invoice.id,
          paidAt:new Date((invoice.created || Math.floor(Date.now()/1000))*1000).toISOString(),
          paymentStatus:invoice.status || 'paid', fulfillmentStatus:renewalResult?.ok ? 'provisioned' : 'failed',
          fulfillmentError:renewalResult?.ok ? null : renewalResult?.error || null,
        };
        upsertPurchase(user.email, invoice.id, {}, renewalPurchase);
        await deliverPurchaseReceipt(user.email, invoice.id, renewalPurchase, invoice.hosted_invoice_url || invoice.invoice_pdf || null);
      }
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const user = getUserByStripeCustomerId(customerId);
    if (user) {
      saveUser(user.email, { status: 'renewal_payment_failed', renewalPaymentFailedAt: new Date().toISOString(), renewalPaymentInvoiceId: invoice.id || null });
      sendToEmail(user.email, { title: 'Не вдалося поновити тариф', body: 'Stripe не зміг провести щомісячну оплату. Перевір спосіб оплати.', url: '/payments.html', tag: 'renewal-payment-failed' }).catch(() => {});
    }
  }

  res.json({ received: true });
});

// ---------- 3. Статус користувача (для дашборду) ----------
app.get('/api/status', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Потрібен email' });

  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (user.status === 'blocked') return res.status(403).json({ error: 'Акаунт заблоковано' });

  // Repair accounts that were incorrectly marked as pending by older builds
  // after a user opened and then cancelled Stripe Checkout.
  if (user.status === 'pending_payment' && user.esim?.orderNo) {
    return res.json(saveUser(email, { status: 'active' }));
  }

  res.json(user);
});

// ---------- 3.5. Оновити реальне використання трафіку ----------
app.get('/api/usage', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Потрібен email' });

    const user = getUser(email);
    if (!user || !user.esim?.orderNo) {
      return res.status(404).json({ error: 'Немає активної eSIM для цього користувача' });
    }
    if (user.status === 'blocked') return res.status(403).json({ error: 'Акаунт заблоковано' });

    const usage = await checkUsage(user.esim.orderNo);
    const usedGb = +(usage.usedBytes / (1024 ** 3)).toFixed(2);
    const totalGb = usage.totalBytes ? +(usage.totalBytes / (1024 ** 3)).toFixed(2) : user.esim.dataLimitGb;
    const remainingGb = totalGb == null ? null : Math.max(0, +(totalGb - usedGb).toFixed(2));

    // Зберігаємо оновлені дані, щоб дашборд теж їх бачив без повторного запиту
    const history = [...(user.esim.usageHistory || [])];
    const day = new Date().toISOString().slice(0, 10);
    const snapshot = { day, usedGb, remainingGb, totalGb };
    const existingIndex = history.findIndex((item) => item.day === day);
    if (existingIndex >= 0) history[existingIndex] = snapshot;
    else history.push(snapshot);
    const usageHistory = history.slice(-31);
    saveUser(email, {
      esim: {
        ...user.esim,
        usedGb,
        dataLimitGb: totalGb,
        apn: usage.apn ?? user.esim.apn,
        expiredTime: usage.expiredTime ?? user.esim.expiredTime,
        activateTime: usage.activateTime ?? user.esim.activateTime,
        lastUpdateTime: usage.lastUpdateTime ?? user.esim.lastUpdateTime,
        remainingGb,
        usageHistory,
      },
    });

    res.json({ usedGb, totalGb, remainingGb, esimStatus: usage.esimStatus, apn: usage.apn, expiredTime: usage.expiredTime, activateTime: usage.activateTime, lastUpdateTime: usage.lastUpdateTime });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 3.6. Дата наступного списання (реальна, зі Stripe) ----------
app.get('/api/billing', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Потрібен email' });

    const user = getUser(email);
    if (!user || !user.stripeSubscriptionId) {
      return res.status(404).json({ error: 'Немає активної підписки' });
    }

    const nextBillingDate = await getNextBillingDate(user.stripeSubscriptionId);
    res.json({ nextBillingDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- 4. Скасування підписки ----------
app.post('/api/cancel', async (req, res) => {
  try {
    const { email } = req.body;
    const user = getUser(email);
    if (!user || !user.stripeSubscriptionId) {
      return res.status(404).json({ error: 'Активної підписки не знайдено' });
    }
    await cancelSubscription(user.stripeSubscriptionId);
    saveUser(email, { status: 'canceled' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4242;
storage.init().then(() => Promise.all([
  bootstrapUsers(),
  authStore.bootstrap(),
  pushStore.bootstrap(),
  adminStore.bootstrap(),
  ticketStore.bootstrap(),
  auditStore.bootstrap(),
  operationsStore.bootstrap(),
  translationService.bootstrap(),
  diagnosticsStore.bootstrap(),
])).then(() => adminAuth.bootstrap()).then(() => {
  app.listen(PORT, () => {
    console.log(`Signal backend running on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to start persistent storage:', error);
  process.exit(1);
});

app.get('/api/account/billing-history', requireUserSession, async (req, res) => {
  try {
    const user = getUser(req.userEmail);
    const local = (user?.purchases || []).map(purchase => ({
      id:purchase.id, createdAt:purchase.paidAt || purchase.createdAt, amount:Number(purchase.amountCents || 0)/100,
      currency:purchase.currency || 'usd', status:purchase.paymentStatus || 'paid',
      fulfillmentStatus:purchase.fulfillmentStatus || null, name:purchase.packageName || purchase.plan || 'eSIM-пакет',
      detail:[purchase.location, purchase.dataLimitGb == null ? null : `${purchase.dataLimitGb} ГБ`, purchase.durationDays ? `${purchase.durationDays} днів` : null].filter(Boolean).join(' · '),
      receiptUrl:purchase.receiptUrl || null, receiptEmailSentAt:purchase.receiptEmailSentAt || null,
    }));
    const stripeInvoices = user?.stripeCustomerId ? await getBillingHistory(user.stripeCustomerId) : [];
    const combined = [...local, ...stripeInvoices.filter(invoice => !local.some(item => item.id === invoice.id))]
      .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    res.json({ invoices:combined });
  } catch (error) {
    console.error('Billing history:', error.message);
    res.status(502).json({ error: 'Не вдалося завантажити історію оплат' });
  }
});
