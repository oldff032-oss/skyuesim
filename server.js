// server.js
//
// Запуск: npm install, потім npm start
// Сервер підніметься на порту з .env (за замовчуванням 4242)

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { createCheckoutSession, cancelSubscription, constructWebhookEvent, getNextBillingDate } = require('./stripeService');
const { provisionEsim, checkUsage, recoverEsim } = require('./esimService');
const { bootstrap: bootstrapUsers, getUser, saveUser, getUserByStripeCustomerId, getAllUsers } = require('./db');
const storage = require('./persistentState');
const authStore = require('./authStore');
const adminStore = require('./adminStore');
const authService = require('./authService');
const ticketStore = require('./ticketStore');
const auditStore = require('./auditStore');
const adminAuth = require('./adminAuthService');
const { sendEmail, getReceivedEmail, verifyInboundSignature } = require('./emailService');

const app = express();
const esimRetriesInProgress = new Set();
app.use(cors());

// ВАЖЛИВО: вебхук Stripe має отримати "сирий" (не розпарсений) body,
// тому для цього одного маршруту JSON-парсер вимикаємо.
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use('/api/inbound-email', express.raw({ type: 'application/json' }));
app.use(express.json());

// =========================================================
// АВТЕНТИФІКАЦІЯ: email -> код -> пароль -> акаунт, і логін
// =========================================================

app.post('/api/auth/request-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Введи коректний email' });
    await authService.requestCode(email);
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
    const result = await authService.setPassword(verifyToken, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Потрібні email і password' });
    const result = await authService.login(email, password);
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
  res.json(ticketStore.stripNotesForUser(ticket));
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
  const { status, priority } = req.body;
  const updated = ticketStore.updateTicket(req.params.id, {
    ...(status && { status }),
    ...(priority && { priority }),
  });
  if (!updated) return res.status(404).json({ error: 'Тікет не знайдено' });
  auditStore.log({ adminEmail: req.admin.email, action: 'ticket_updated', target: `#${req.params.id}`, details: { status, priority } });
  res.json(updated);
});

// Відповідь клієнту (реальний email) — заборонено для Viewer
app.post('/api/admin/tickets/:id/reply', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  try {
    const { message, attachment } = req.body;
    const ticket = ticketStore.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });

    const updated = ticketStore.addMessage(req.params.id, { from: 'admin', text: message, attachment });
    auditStore.log({ adminEmail: req.admin.email, action: 'ticket_reply_sent', target: `#${req.params.id}` });

    try {
      await sendEmail({
        to: ticket.email,
        subject: `[Сигнал Підтримка #${ticket.id}] ${ticket.subject}`,
        html: `
          <div style="font-family: sans-serif; max-width: 480px;">
            <p>${message.replace(/\n/g, '<br>')}</p>
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
  if (user.esim?.orderNo) return res.status(409).json({ error: 'До цього акаунта вже прикріплено eSIM' });

  try {
    const esim = await recoverEsim({ iccid, plan });
    saveUser(email, { status: 'active', plan, esim });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_recovered', target: email, details: { orderNo: esim.orderNo } });
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

    saveUser(email, { email, plan, status: 'pending_payment' });

    const session = await createCheckoutSession({ email, plan });
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
      const esim = await provisionEsim({ email, plan });

      saveUser(email, {
        status: 'active',
        plan,
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
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
    const usedGb = +(usage.usedBytes / 1e9).toFixed(2);
    const totalGb = usage.totalBytes ? Math.round(usage.totalBytes / 1e9) : user.esim.dataLimitGb;

    // Зберігаємо оновлені дані, щоб дашборд теж їх бачив без повторного запиту
    saveUser(email, {
      esim: {
        ...user.esim,
        usedGb,
        dataLimitGb: totalGb,
        apn: usage.apn ?? user.esim.apn,
        expiredTime: usage.expiredTime ?? user.esim.expiredTime,
        activateTime: usage.activateTime ?? user.esim.activateTime,
      },
    });

    res.json({ usedGb, totalGb, esimStatus: usage.esimStatus, apn: usage.apn, expiredTime: usage.expiredTime, activateTime: usage.activateTime });
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
  adminStore.bootstrap(),
  ticketStore.bootstrap(),
  auditStore.bootstrap(),
])).then(() => adminAuth.bootstrap()).then(() => {
  app.listen(PORT, () => {
    console.log(`Signal backend running on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to start persistent storage:', error);
  process.exit(1);
});
