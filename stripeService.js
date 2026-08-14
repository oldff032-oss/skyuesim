// services/stripeService.js
//
// Уся логіка роботи зі Stripe:
// - створення Checkout Session
// - підписки
// - скасування підписки
// - перевірка webhook
// - дата наступного списання

require('dotenv').config();

const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY не заданий у .env');
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);


// =========================================================
// PRICE ID ДЛЯ ТАРИФІВ
// =========================================================

const PRICE_MAP = {
  basic: process.env.STRIPE_PRICE_BASIC,
  standard: process.env.STRIPE_PRICE_STANDARD,
  unlimited: process.env.STRIPE_PRICE_UNLIMITED,
};


// =========================================================
// СТВОРЕННЯ CHECKOUT SESSION
// =========================================================

async function createCheckoutSession({ email, plan }) {
  const priceId = PRICE_MAP[plan];

  if (!priceId) {
    throw new Error(`Невідомий тариф: ${plan}`);
  }

  console.log('========================================');
  console.log('💳 Створення Stripe Checkout Session');
  console.log(`Email: ${email}`);
  console.log(`Plan: ${plan}`);
  console.log(`Price ID: ${priceId}`);
  console.log('========================================');

  try {
    // Перевіряємо Price напряму у Stripe.
    // Це дозволяє одразу побачити, чи Price існує
    // саме в цьому Stripe акаунті / режимі.
    const price = await stripe.prices.retrieve(priceId);

    console.log('✅ Stripe Price знайдено');
    console.log(`Price: ${price.id}`);
    console.log(`Active: ${price.active}`);
    console.log(`Currency: ${price.currency}`);
    console.log(`Unit amount: ${price.unit_amount}`);
    console.log(
      `Recurring: ${price.recurring ? price.recurring.interval : 'NO'}`
    );

    if (!price.active) {
      throw new Error(`Stripe Price ${priceId} неактивний`);
    }

    if (!price.recurring) {
      throw new Error(
        `Stripe Price ${priceId} не є recurring Price для підписки`
      );
    }

    // Створюємо Checkout.
    //
    // ВАЖЛИВО:
    // payment_method_types: ['card']
    //
    // Це прибирає проблему, коли Stripe не знаходить
    // жодного доступного автоматичного способу оплати.
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',

      customer_email: email,

      payment_method_types: ['card'],

      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],

      success_url:
        `${process.env.FRONTEND_URL}` +
        `/installing.html?email=${encodeURIComponent(email)}`,

      cancel_url:
        `${process.env.FRONTEND_URL}/plans.html`,

      metadata: {
        plan,
        email,
      },

      subscription_data: {
        metadata: {
          plan,
          email,
        },
      },
    });

    console.log('✅ Checkout Session створена');
    console.log(`Session ID: ${session.id}`);
    console.log(`Checkout URL: ${session.url}`);

    return session;

  } catch (err) {

    console.error('========================================');
    console.error('❌ ПОМИЛКА STRIPE');
    console.error('========================================');
    console.error('Message:', err.message);
    console.error('Type:', err.type);
    console.error('Code:', err.code);
    console.error('Param:', err.param);
    console.error('Request ID:', err.requestId);
    console.error('========================================');

    throw err;
  }
}


// =========================================================
// СКАСУВАННЯ ПІДПИСКИ
// =========================================================

async function cancelSubscription(subscriptionId) {
  if (!subscriptionId) {
    throw new Error('Не передано subscriptionId');
  }

  console.log(`🛑 Скасування підписки: ${subscriptionId}`);

  return stripe.subscriptions.cancel(subscriptionId);
}


// =========================================================
// НАСТУПНА ДАТА СПИСАННЯ
// =========================================================

async function getNextBillingDate(subscriptionId) {
  if (!subscriptionId) {
    throw new Error('Не передано subscriptionId');
  }

  const subscription =
    await stripe.subscriptions.retrieve(subscriptionId);

  if (!subscription.current_period_end) {
    return null;
  }

  return new Date(
    subscription.current_period_end * 1000
  ).toISOString();
}


// =========================================================
// STRIPE WEBHOOK
// =========================================================

function constructWebhookEvent(rawBody, signature) {
  if (!signature) {
    throw new Error('Відсутній stripe-signature');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET не заданий');
  }

  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}


// =========================================================
// EXPORT
// =========================================================

module.exports = {
  createCheckoutSession,
  cancelSubscription,
  constructWebhookEvent,
  getNextBillingDate,
};
