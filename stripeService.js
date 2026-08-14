// services/stripeService.js
//
// Уся логіка роботи зі Stripe:
// - створення Checkout Session
// - підписки
// - скасування підписки
// - отримання дати наступного списання
// - перевірка Stripe Webhook
//
// Усі секретні значення беруться з .env / Render Environment Variables.

require('dotenv').config();

const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY не заданий у Environment Variables');
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Live Price ID повинні бути задані в Render.
// Наприклад:
// STRIPE_PRICE_BASIC=price_...
// STRIPE_PRICE_STANDARD=price_...
// STRIPE_PRICE_UNLIMITED=price_...

const PRICE_MAP = {
  basic: process.env.STRIPE_PRICE_BASIC,
  standard: process.env.STRIPE_PRICE_STANDARD,
  unlimited: process.env.STRIPE_PRICE_UNLIMITED,
};

// ---------------------------------------------------------
// Створення Stripe Checkout Session
// ---------------------------------------------------------

async function createCheckoutSession({ email, plan }) {
  if (!email) {
    throw new Error('Email користувача не заданий');
  }

  if (!plan) {
    throw new Error('Тариф не заданий');
  }

  const normalizedPlan = String(plan).toLowerCase().trim();
  const priceId = PRICE_MAP[normalizedPlan];

  if (!priceId) {
    throw new Error(`Невідомий тариф: ${normalizedPlan}`);
  }

  // Перевіряємо, що Price ID справді існує
  // у поточному Stripe режимі (Live/Test визначається ключем).
  const price = await stripe.prices.retrieve(priceId);

  if (!price || !price.active) {
    throw new Error(`Stripe Price неактивний або не існує: ${priceId}`);
  }

  // Для mode: subscription Price повинен бути recurring.
  if (!price.recurring) {
    throw new Error(
      `Price ${priceId} не є recurring Price. ` +
      `Для підписки Stripe Price повинен мати recurring billing.`
    );
  }

  const frontendUrl = process.env.FRONTEND_URL;

  if (!frontendUrl) {
    throw new Error('FRONTEND_URL не заданий у Environment Variables');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',

    customer_email: email,

    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],

    // Примусово використовуємо банківські картки.
    payment_method_types: ['card'],

    success_url:
      `${frontendUrl}/installing.html` +
      `?email=${encodeURIComponent(email)}` +
      `&session_id={CHECKOUT_SESSION_ID}`,

    cancel_url:
      `${frontendUrl}/plans.html`,

    metadata: {
      plan: normalizedPlan,
      email,
    },

    subscription_data: {
      metadata: {
        plan: normalizedPlan,
        email,
      },
    },
  });

  return session;
}

// ---------------------------------------------------------
// Скасування підписки
// ---------------------------------------------------------

async function cancelSubscription(subscriptionId) {
  if (!subscriptionId) {
    throw new Error('subscriptionId не заданий');
  }

  return stripe.subscriptions.cancel(subscriptionId);
}

// ---------------------------------------------------------
// Отримання дати наступного списання
// ---------------------------------------------------------

async function getNextBillingDate(subscriptionId) {
  if (!subscriptionId) {
    throw new Error('subscriptionId не заданий');
  }

  const subscription =
    await stripe.subscriptions.retrieve(subscriptionId);

  return subscription.current_period_end
    ? new Date(
        subscription.current_period_end * 1000
      ).toISOString()
    : null;
}

// ---------------------------------------------------------
// Перевірка Stripe Webhook
// ---------------------------------------------------------
//
// rawBody ОБОВ'ЯЗКОВО повинен бути оригінальним Buffer,
// який прийшов від Stripe.
//
// ВАЖЛИВО:
// Тут використовується стандартна перевірка Stripe.
// Не залишаємо tolerance 24 години для production.
//

function constructWebhookEvent(rawBody, signature) {
  if (!rawBody) {
    throw new Error('Stripe webhook rawBody відсутній');
  }

  if (!signature) {
    throw new Error('Stripe webhook signature відсутній');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET не заданий у Environment Variables'
    );
  }

  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

// ---------------------------------------------------------
// Експорт
// ---------------------------------------------------------

module.exports = {
  createCheckoutSession,
  cancelSubscription,
  constructWebhookEvent,
  getNextBillingDate,
};
