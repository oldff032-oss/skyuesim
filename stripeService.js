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

async function deleteStripeCustomer(customerId) {
  if (!customerId) return null;
  return stripe.customers.del(customerId);
}

// Дата наступного списання — реальні дані напряму зі Stripe (не розрахунок,
// а те, що Stripe сам планує списати наступного разу).
async function getNextBillingDate(subscriptionId) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  return sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
}

async function createCustomPackageCheckout({ email, packageCode, packageName, amountCents, currency = 'usd', dataLimitGb = null, durationDays = null, location = '' }) {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    customer_creation: 'always',
    line_items: [{ price_data: { currency, product_data: { name: packageName }, unit_amount: amountCents }, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/installing.html?email=${encodeURIComponent(email)}`,
    cancel_url: `${process.env.FRONTEND_URL}/profile.html`,
    metadata: { plan: 'custom', email, packageCode, packageName, dataLimitGb: dataLimitGb == null ? '' : String(dataLimitGb), durationDays: durationDays == null ? '' : String(durationDays), location: String(location || '').slice(0,80) },
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

async function findCustomerIdsByEmail(email, knownCustomerId = null) {
  const ids = new Set(knownCustomerId ? [knownCustomerId] : []);
  if (email) {
    const customers = await stripe.customers.list({ email: String(email).trim().toLowerCase(), limit: 100 });
    customers.data.forEach(customer => ids.add(customer.id));
  }
  return [...ids];
}

async function listRefundablePaymentsByEmail(email, knownCustomerId = null) {
  const customerIds = await findCustomerIdsByEmail(email, knownCustomerId);
  const chargeLists = await Promise.all(customerIds.map(customer => stripe.charges.list({ customer, limit: 100 })));
  const charges = [...new Map(chargeLists.flatMap(list => list.data).map(charge => [charge.id, charge])).values()];
  return charges
    .filter(charge => charge.paid && !charge.disputed && charge.amount > charge.amount_refunded)
    .map(charge => ({
      id: charge.id,
      createdAt: new Date(charge.created * 1000).toISOString(),
      amount: charge.amount,
      amountRefunded: charge.amount_refunded,
      refundableAmount: charge.amount - charge.amount_refunded,
      currency: charge.currency,
      description: charge.description || charge.metadata?.plan || 'Stripe payment',
      receiptUrl: charge.receipt_url || null,
    }));
}

async function refundPayment({ customerIds, chargeId, amount, reason = 'requested_by_customer', metadata = {}, idempotencyKey }) {
  const charge = await stripe.charges.retrieve(chargeId);
  const chargeCustomer = typeof charge.customer === 'string' ? charge.customer : charge.customer?.id;
  if (!chargeCustomer || !customerIds.includes(chargeCustomer)) throw new Error('Цей платіж не належить вибраному користувачу');
  if (!charge.paid || charge.disputed) throw new Error('Цей платіж не можна повернути');
  const refundableAmount = charge.amount - charge.amount_refunded;
  if (!Number.isInteger(amount) || amount < 1 || amount > refundableAmount) throw new Error('Сума перевищує доступний залишок повернення');
  return stripe.refunds.create({ charge: chargeId, amount, reason, metadata }, idempotencyKey ? { idempotencyKey } : undefined);
}

async function cancelAllSubscriptionsForCustomers(customerIds) {
  const subscriptions = [];
  for (const customer of [...new Set(customerIds || [])]) {
    const list = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    subscriptions.push(...list.data);
  }
  const cancelable = [...new Map(subscriptions.map(subscription => [subscription.id, subscription])).values()]
    .filter(subscription => !['canceled','incomplete_expired'].includes(subscription.status));
  const canceled = [], errors = [];
  for (const subscription of cancelable) {
    try {
      const result = await stripe.subscriptions.cancel(subscription.id);
      canceled.push({ id: result.id, status: result.status, canceledAt: result.canceled_at ? new Date(result.canceled_at * 1000).toISOString() : new Date().toISOString() });
    } catch (error) {
      errors.push({ id: subscription.id, error: error.message });
    }
  }
  return { canceled, errors };
}

async function getCustomerEmail(customerId) {
  if (!customerId) return null;
  const customer = await stripe.customers.retrieve(customerId);
  return customer && !customer.deleted ? String(customer.email || '').trim().toLowerCase() || null : null;
}

async function getSubscriptionStateByEmail(email, knownCustomerId = null) {
  const customerIds = await findCustomerIdsByEmail(email, knownCustomerId);
  const subscriptions = [];
  for (const customer of customerIds) {
    const list = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
    subscriptions.push(...list.data.map(subscription => ({ id:subscription.id, customer, status:subscription.status, cancelAtPeriodEnd:subscription.cancel_at_period_end })));
  }
  const unique = [...new Map(subscriptions.map(subscription => [subscription.id, subscription])).values()];
  const active = unique.filter(subscription => !['canceled','incomplete_expired'].includes(subscription.status));
  return { customerIds, subscriptions:unique, active };
}

async function listCompletedCheckoutPurchasesByEmail(email, knownCustomerId = null) {
  const customerIds = await findCustomerIdsByEmail(email, knownCustomerId);
  const sessionLists = await Promise.all(customerIds.map(customer => stripe.checkout.sessions.list({ customer, status:'complete', limit:100 })));
  return [...new Map(sessionLists.flatMap(list => list.data).map(session => [session.id, session])).values()]
    .filter(session => session.payment_status === 'paid')
    .sort((a,b) => b.created - a.created)
    .map(session => ({
      id:session.id,
      kind:session.metadata?.plan === 'custom' ? 'custom_package' : 'subscription',
      plan:session.metadata?.plan || null,
      packageCode:session.metadata?.packageCode || null,
      packageName:session.metadata?.packageName || session.metadata?.plan || 'Stripe purchase',
      dataLimitGb:session.metadata?.dataLimitGb ? Number(session.metadata.dataLimitGb) : ({basic:10,standard:20,unlimited:null}[session.metadata?.plan] ?? null),
      durationDays:session.metadata?.durationDays ? Number(session.metadata.durationDays) : (session.metadata?.plan && session.metadata.plan !== 'custom' ? 30 : null),
      location:session.metadata?.location || null,
      amountCents:session.amount_total ?? null,
      currency:session.currency || null,
      stripeSessionId:session.id,
      stripeCustomerId:typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
      stripeSubscriptionId:typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
      stripePaymentIntentId:typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      paidAt:new Date(session.created * 1000).toISOString(),
      paymentStatus:session.payment_status,
    }));
}

// Read-only evidence for a Super Admin reviewing an account recovery request.
// Only non-sensitive card metadata is returned; full card data never reaches us.
async function getRecoveryPaymentEvidence(customerId) {
  if (!customerId) return null;
  const [invoices, paymentMethods] = await Promise.all([
    stripe.invoices.list({ customer: customerId, limit: 3 }),
    stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 3 }),
  ]);
  return {
    recentPayments: invoices.data.map(invoice => ({
      date: new Date(invoice.created * 1000).toISOString(),
      amount: invoice.amount_paid / 100,
      currency: invoice.currency,
      status: invoice.status,
    })),
    cards: paymentMethods.data.map(method => ({
      brand: method.card?.brand || null,
      last4: method.card?.last4 || null,
      expMonth: method.card?.exp_month || null,
      expYear: method.card?.exp_year || null,
      billingName: method.billing_details?.name || null,
    })),
  };
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

module.exports = { createCheckoutSession, createCustomPackageCheckout, cancelSubscription, cancelAllSubscriptionsForCustomers, deleteStripeCustomer, constructWebhookEvent, getNextBillingDate, getBillingHistory, getRecoveryPaymentEvidence, findCustomerIdsByEmail, getCustomerEmail, getSubscriptionStateByEmail, listCompletedCheckoutPurchasesByEmail, listRefundablePaymentsByEmail, refundPayment };
