// server.js
//
// Запуск: npm install, потім npm start
// Сервер підніметься на порту з .env (за замовчуванням 4242)

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { createCheckoutSession, cancelSubscription, constructWebhookEvent } = require('./stripeService');
const { provisionEsim } = require('./esimService');
const { getUser, saveUser, getUserByStripeCustomerId } = require('./db');
const authService = require('./authService');

const app = express();
app.use(cors());

// ВАЖЛИВО: вебхук Stripe має отримати "сирий" (не розпарсений) body,
// тому для цього одного маршруту JSON-парсер вимикаємо.
app.use('/api/webhook', express.raw({ type: 'application/json' }));
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

  res.json(user);
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
app.listen(PORT, () => {
  console.log(`Signal backend running on http://localhost:${PORT}`);
});
