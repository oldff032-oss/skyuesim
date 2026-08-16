// services/stripeService.js
//
// Уся логіка роботи зі Stripe (платежі й підписки) зібрана тут.
// Нічого тут міняти не треба, окрім значень у .env (ключі і Price ID).

require('dotenv').config();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_MAP = {
  basic: process.env.STRIPE_PRICE_BASIC,
  standard: process.env.STRIPE_PRICE_STANDARD,
  unlimited: process.env.STRIPE_PRICE_UNLIMITED,
};

// Створює Stripe Checkout Session — сторінку оплати, на яку ти
// перенаправляєш користувача. Stripe сам показує форму картки,
// перевіряє її і починає щомісячне списання.
async function createCheckoutSession({ email, plan }) {
  const priceId = PRICE_MAP[plan];
  if (!priceId) throw new Error(`Невідомий тариф: ${plan}`);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/installing.html?email=${encodeURIComponent(email)}`,
    cancel_url: `${process.env.FRONTEND_URL}/plans.html`,
    metadata: { plan, email },
  });

  return session;
}

// Дозволяє користувачу скасувати підписку (викликається з дашборду).
async function cancelSubscription(subscriptionId) {
  return stripe.subscriptions.cancel(subscriptionId);
}

// Дата наступного списання — реальні дані напряму зі Stripe (не розрахунок,
// а те, що Stripe сам планує списати наступного разу).
async function getNextBillingDate(subscriptionId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  return sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
}

async function createCustomPackageCheckout({ email, packageCode, packageName, amountCents, currency = 'usd', dataLimitGb = null }) {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    customer_creation: 'always',
    line_items: [{ price_data: { currency, product_data: { name: packageName }, unit_amount: amountCents }, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/installing.html?email=${encodeURIComponent(email)}`,
    cancel_url: `${process.env.FRONTEND_URL}/profile.html`,
    metadata: { plan: 'custom', email, packageCode, packageName, dataLimitGb: dataLimitGb == null ? '' : String(dataLimitGb) },
  });
  return session;
}

async function getBillingHistory(customerId) {
  const invoices = await stripe.invoices.list({ customer: customerId, limit: 20 });
  return invoices.data.map((invoice) => ({
    id: invoice.id,
    createdAt: new Date(invoice.created * 1000).toISOString(),
    amount: invoice.amount_paid / 100,
    currency: invoice.currency,
    status: invoice.status,
    receiptUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || null,
  }));
}

// Перевіряє, що вебхук справді прийшов від Stripe (а не від когось,
// хто намагається підробити "оплату успішна").
//
// ⚠️ tolerance тут навмисно збільшено до 24 годин через типову проблему
// Windows, де системний годинник розходиться з реальним часом на кілька
// хвилин (стандартний ліміт Stripe — лише 5 хвилин). Перед реальним
// запуском із живими грошима поверни стандартну поведінку — просто
// прибери третій аргумент нижче (або постав null).
function constructWebhookEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET,
    24 * 60 * 60 // 24 години допустимого розходження в часі — ТІЛЬКИ для тестів
  );
}

module.exports = { createCheckoutSession, createCustomPackageCheckout, cancelSubscription, constructWebhookEvent, getNextBillingDate, getBillingHistory };

