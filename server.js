// server.js
//
// Запуск: npm install, потім npm start
// Сервер підніметься на порту з .env (за замовчуванням 4242)

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { createCheckoutSession, createCustomPackageCheckout, cancelSubscription, constructWebhookEvent, getNextBillingDate, getBillingHistory } = require('./stripeService');
const crypto = require('crypto');
const { provisionEsim, checkUsage, recoverEsim, topupEsim, listPackages } = require('./esimService');
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
const translationService = require('./translationService');
const { isConfigured: isPushConfigured, sendToEmail } = require('./pushService');
const { sendEmail, getReceivedEmail, verifyInboundSignature } = require('./emailService');

const app = express();
const esimRetriesInProgress = new Set();
const coverageCache = new Map();
app.use(cors());

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
    const result = await authService.setPassword(verifyToken, password, req.headers['x-device-name'] || req.headers['user-agent']);
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

app.post('/api/support/tickets', async (req, res) => {
  try {
    const { email, category, subject, message, attachment } = req.body;
    if (!email || !subject || !message) return res.status(400).json({ error: 'Потрібні email, subject і message' });
    if (attachment && attachment.dataUrl && attachment.dataUrl.length > 4_500_000) {
      return res.status(400).json({ error: 'Файл завеликий (максимум ~3МБ)' });
    }

    const ticket = ticketStore.createTicket({ email, category: category || 'Інше', subject, message, attachment });
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
    auditStore.log({ adminEmail: result.email, action: 'admin_login' });
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message, code: err.code });
  }
});

app.get('/api/admin/me', adminAuth.requireAdmin, (req, res) => {
  res.json(req.admin);
});

// Керування командою — тільки Super Admin
app.get('/api/admin/team', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  res.json(adminAuth.listAdmins());
});

app.get('/api/admin/assignees', adminAuth.requireAdmin, (req, res) => {
  res.json(adminAuth.listAdmins().filter((admin) => !admin.blocked && ['super_admin', 'admin', 'support'].includes(admin.role)).map((admin) => ({ email: admin.email, role: admin.role })));
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
  res.json(ticketStore.getAllTickets({ status, priority, search }));
});

app.get('/api/admin/tickets/:id', adminAuth.requireAdmin, (req, res) => {
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  const userSubscription = getUser(ticket.email);
  res.json({ ticket, userSubscription });
});

// Зміна статусу/пріоритету — заборонено для Viewer
app.patch('/api/admin/tickets/:id', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), (req, res) => {
  const { status, priority, assignedTo } = req.body;
  if (assignedTo !== undefined && assignedTo !== null && assignedTo !== '' && !adminStore.readAll().admins?.[assignedTo]) {
    return res.status(400).json({ error: 'Призначеного адміністратора не знайдено' });
  }
  if (status === 'closed') {
    const deleted = ticketStore.deleteTicket(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Тікет не знайдено' });
    auditStore.log({ adminEmail: req.admin.email, action: 'ticket_closed_and_deleted', target: `#${req.params.id}` });
    return res.json({ ok: true, deleted: true });
  }
  const updated = ticketStore.updateTicket(req.params.id, {
    ...(status && { status }),
    ...(priority && { priority }),
    ...(assignedTo !== undefined && { assignedTo: assignedTo || null }),
  });
  if (!updated) return res.status(404).json({ error: 'Тікет не знайдено' });
  auditStore.log({ adminEmail: req.admin.email, action: 'ticket_updated', target: `#${req.params.id}`, details: { status, priority, assignedTo } });
  res.json(updated);
});

// Відповідь клієнту (реальний email) — заборонено для Viewer
app.post('/api/admin/tickets/:id/reply', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  try {
    const { message, attachment } = req.body;
    const ticket = ticketStore.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });

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
        html: `
          <div style="font-family: sans-serif; max-width: 480px;">
            <p>${customerMessage.replace(/[&<>]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[char])).replace(/\n/g, '<br>')}</p>
            <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
            <p style="color:#888; font-size:12px;">Ticket ID: #${ticket.id}. Можеш відповісти прямо на цей email — відповідь автоматично додасться в тікет.</p>
          </div>`,
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
  const announcement={ id:Date.now().toString(36), title:String(title).replace(/^\s*\[maintenance\]\s*/i,'').slice(0,100), message:String(message).slice(0,500), audience, type:isMaintenance?'maintenance':'notice', startsAt:new Date().toISOString(), expiresAt:expiresAt||null, createdBy:req.admin.email };
  operationsStore.store().announcements.unshift(announcement); operationsStore.save();
  if(sendPush && audience !== 'all') Promise.all([
    translationService.forEmail(audience, announcement.title, getUser),
    translationService.forEmail(audience, announcement.message, getUser),
  ]).then(([localizedTitle, localizedMessage]) => sendToEmail(audience,{title:localizedTitle,body:localizedMessage,url:'/dashboard.html',tag:`announcement-${announcement.id}`})).catch(()=>{});
  auditStore.log({adminEmail:req.admin.email,action:'announcement_created',target:audience,details:{id:announcement.id}}); res.json(announcement);
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
app.delete('/api/admin/users/:email/anonymize', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req,res)=>{ const email=req.params.email; if(req.body?.confirmEmail!==email) return res.status(400).json({error:'Підтвердіть email користувача'}); if(!getUser(email)) return res.status(404).json({error:'Користувача не знайдено'}); deleteUser(email); const auth=authStore.readAll(); delete auth.users[email]; for(const [token,session] of Object.entries(auth.sessions)) if(session.email===email) delete auth.sessions[token]; authStore.writeAll(auth); auditStore.log({adminEmail:req.admin.email,action:'user_anonymized',target:'anonymized'}); res.json({ok:true}); });
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
    if (channel === 'push') delivered = await sendToEmail(email, { title: localizedTitle, body: localizedMessage, url: '/dashboard.html', tag: 'admin-message' });
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
  const { packageCode, packageName, amountCents, currency = 'usd', dataLimitGb = null } = req.body || {};
  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (user.esim?.orderNo && user.status === 'active') return res.status(409).json({ error: 'У користувача вже є активна eSIM. Продаж другого профілю буде додано окремо, щоб не замінити поточну eSIM.' });
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(packageCode || ''))) return res.status(400).json({ error: 'Некоректний packageCode' });
  if (!String(packageName || '').trim() || String(packageName).length > 120) return res.status(400).json({ error: 'Вкажіть назву пакета' });
  if (!Number.isInteger(Number(amountCents)) || Number(amountCents) < 50 || Number(amountCents) > 1000000) return res.status(400).json({ error: 'Вкажіть ціну в центах: від $0.50 до $10,000' });
  if (!/^[a-z]{3}$/i.test(currency)) return res.status(400).json({ error: 'Некоректна валюта' });
  try {
    const session = await createCustomPackageCheckout({ email, packageCode: String(packageCode), packageName: String(packageName).trim(), amountCents: Number(amountCents), currency: String(currency).toLowerCase(), dataLimitGb });
    auditStore.log({ adminEmail: req.admin.email, action: 'custom_package_checkout_created', target: email, details: { packageCode, amountCents, currency } });
    res.json({ ok: true, url: session.url });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/admin/referrals', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), (req, res) => {
  res.json(Object.values(getAllUsers()).filter((user) => user.referredBy).map((user) => ({ email: user.email, referredBy: user.referredBy, status: user.referralRewardStatus || 'pending_first_payment', packageCode: user.referralRewardPackageCode || null, createdAt: user.createdAt || null })));
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

    try {
      // Оплата підтверджена Stripe -> тепер видаємо реальну eSIM
      const packageCode = session.metadata.packageCode || '';
      const dataLimitGb = session.metadata.dataLimitGb === '' ? null : Number(session.metadata.dataLimitGb);
      const esim = await provisionEsim({ email, plan, packageCode, dataLimitGb });
      esim.dashboardQrExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      saveUser(email, {
        status: 'active',
        plan,
        stripeCustomerId: session.customer,
        ...(session.subscription ? { stripeSubscriptionId: session.subscription } : {}),
        esim,
      });

      console.log(`✅ Підписку і eSIM активовано для ${email}`);
    } catch (err) {
      console.error('Помилка видачі eSIM після оплати:', err);
      saveUser(email, { status: 'payment_ok_esim_failed' });
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const user = getUserByStripeCustomerId(sub.customer);
    if (user) saveUser(user.email, { status: 'canceled' });
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
    if (!user?.stripeCustomerId) return res.json({ invoices: [] });
    res.json({ invoices: await getBillingHistory(user.stripeCustomerId) });
  } catch (error) {
    console.error('Billing history:', error.message);
    res.status(502).json({ error: 'Не вдалося завантажити історію оплат' });
  }
});
