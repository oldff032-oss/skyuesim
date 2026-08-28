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
async function createCheckoutSession({ email, plan, customerId = null }) {
  const priceId = PRICE_MAP[plan];
  if (!priceId) throw new Error(`Невідомий тариф: ${plan}`);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    ...(customerId ? { customer:customerId } : { customer_email:email }),
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/installing.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.FRONTEND_URL}/plans.html`,
    metadata: { plan, email },
  });

  return session;
}

// Дозволяє користувачу скасувати підписку (викликається з дашборду).
async function cancelSubscription(subscriptionId) {
  return stripe.subscriptions.cancel(subscriptionId);
}

async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end:true });
}
async function createBillingPortalSession(customerId){
  if(!customerId)throw new Error('Stripe customer is required');
  return stripe.billingPortal.sessions.create({customer:customerId,return_url:`${process.env.FRONTEND_URL}/payments.html`});
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

async function createCustomPackageCheckout({ email, customerId = null, packageCode, packageName, amountCents, currency = 'usd', dataLimitGb = null, durationDays = null, location = '', changeMode = '', previousPlan = '', previousSubscriptionId = '', scheduledFor = '', recipientMode = '', recipientName = '', rewardId = '', rewardCode = '', discountCents = 0, originalAmountCents = 0 }) {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ...(customerId ? { customer:customerId } : { customer_email:email, customer_creation:'always' }),
    line_items: [{ price_data: { currency, product_data: { name: packageName }, unit_amount: amountCents }, quantity: 1 }],
    success_url: `${process.env.FRONTEND_URL}/installing.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.FRONTEND_URL}/profile.html`,
    metadata: { plan: 'custom', email, packageCode, packageName, dataLimitGb: dataLimitGb == null ? '' : String(dataLimitGb), durationDays: durationDays == null ? '' : String(durationDays), location: String(location || '').slice(0,80), changeMode:String(changeMode||'').slice(0,30), previousPlan:String(previousPlan||'').slice(0,40), previousSubscriptionId:String(previousSubscriptionId||'').slice(0,100), scheduledFor:String(scheduledFor||'').slice(0,40), recipientMode:String(recipientMode||'').slice(0,20), recipientName:String(recipientName||'').slice(0,60), rewardId:String(rewardId||'').slice(0,80), rewardCode:String(rewardCode||'').slice(0,40), discountCents:String(Math.max(0,Math.trunc(Number(discountCents)||0))), originalAmountCents:String(Math.max(0,Math.trunc(Number(originalAmountCents)||0))) },
  });
  return session;
}

async function createMobileTopupCheckout({ email, customerId = null, orderId, productName, amountCents, currency = 'usd' }) {
  if (!/^topup_[A-Za-z0-9_-]{8,60}$/.test(String(orderId || ''))) throw new Error('Некоректне замовлення поповнення');
  if (!Number.isInteger(Number(amountCents)) || Number(amountCents) < 50) throw new Error('Некоректна сума поповнення');
  const safeCurrency = String(currency || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(safeCurrency)) throw new Error('Некоректна валюта поповнення');
  return stripe.checkout.sessions.create({
    mode: 'payment',
    ...(customerId ? { customer:customerId } : { customer_email:email, customer_creation:'always' }),
    line_items: [{
      price_data: {
        currency:safeCurrency,
        product_data: { name:String(productName || 'Поповнення мобільного інтернету').slice(0,120) },
        unit_amount:Number(amountCents),
      },
      quantity:1,
    }],
    success_url: `${process.env.FRONTEND_URL}/mobile-topup.html?checkout=success&order_id=${encodeURIComponent(orderId)}`,
    cancel_url: `${process.env.FRONTEND_URL}/mobile-topup.html?checkout=cancelled&order_id=${encodeURIComponent(orderId)}`,
    // The phone number is deliberately stored only in our protected user
    // record. Stripe receives the opaque order identifier, never the number.
    metadata: { purchaseKind:'mobile_topup', mobileTopupOrderId:String(orderId), packageName:String(productName||'Поповнення мобільного інтернету').slice(0,120), email },
  });
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
      kind:session.metadata?.purchaseKind === 'mobile_topup' ? 'mobile_topup' : session.metadata?.plan === 'custom' ? 'custom_package' : 'subscription',
      plan:session.metadata?.purchaseKind === 'mobile_topup' ? 'mobile_topup' : session.metadata?.plan || null,
      packageCode:session.metadata?.purchaseKind === 'mobile_topup' ? session.metadata?.mobileTopupOrderId || null : session.metadata?.packageCode || null,
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

async function getCheckoutPurchaseDetails(sessionId) {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  let subscription = null, invoice = null, paymentIntent = null, charge = null;
  if (session.subscription) {
    subscription = await stripe.subscriptions.retrieve(typeof session.subscription === 'string' ? session.subscription : session.subscription.id, { expand:['latest_invoice.payment_intent'] });
    invoice = subscription.latest_invoice && typeof subscription.latest_invoice !== 'string' ? subscription.latest_invoice : null;
    paymentIntent = invoice?.payment_intent && typeof invoice.payment_intent !== 'string' ? invoice.payment_intent : null;
  }
  if (!paymentIntent && session.payment_intent) paymentIntent = await stripe.paymentIntents.retrieve(typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id, { expand:['latest_charge'] });
  const chargeRef = paymentIntent?.latest_charge || invoice?.charge || null;
  if (chargeRef) charge = typeof chargeRef === 'string' ? await stripe.charges.retrieve(chargeRef) : chargeRef;
  const refunds = charge ? await stripe.refunds.list({ charge:charge.id, limit:100 }) : { data:[] };
  return {
    checkout:{ id:session.id, mode:session.mode, status:session.status, paymentStatus:session.payment_status, createdAt:new Date(session.created*1000).toISOString(), expiresAt:session.expires_at?new Date(session.expires_at*1000).toISOString():null, amountTotal:session.amount_total, currency:session.currency, customerEmail:session.customer_details?.email || session.customer_email || null, customerName:session.customer_details?.name || null },
    subscription:subscription ? { id:subscription.id, status:subscription.status, cancelAtPeriodEnd:subscription.cancel_at_period_end, currentPeriodEnd:subscription.current_period_end?new Date(subscription.current_period_end*1000).toISOString():null, canceledAt:subscription.canceled_at?new Date(subscription.canceled_at*1000).toISOString():null } : null,
    invoice:invoice ? { id:invoice.id, status:invoice.status, amountPaid:invoice.amount_paid, currency:invoice.currency, hostedInvoiceUrl:invoice.hosted_invoice_url || null, pdfUrl:invoice.invoice_pdf || null } : null,
    paymentIntent:paymentIntent ? { id:paymentIntent.id, status:paymentIntent.status, amount:paymentIntent.amount, amountReceived:paymentIntent.amount_received, currency:paymentIntent.currency } : null,
    charge:charge ? { id:charge.id, status:charge.status, paid:charge.paid, amount:charge.amount, amountRefunded:charge.amount_refunded, refunded:charge.refunded, currency:charge.currency, receiptUrl:charge.receipt_url || null, card:{ brand:charge.payment_method_details?.card?.brand || null, last4:charge.payment_method_details?.card?.last4 || null, country:charge.payment_method_details?.card?.country || null }, billingName:charge.billing_details?.name || null, billingEmail:charge.billing_details?.email || null } : null,
    refunds:refunds.data.map(refund => ({ id:refund.id, status:refund.status, amount:refund.amount, currency:refund.currency, reason:refund.reason || null, createdAt:new Date(refund.created*1000).toISOString(), failureReason:refund.failure_reason || null })),
    metadata:session.metadata || {},
  };
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
  const configuredTolerance = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS || 300);
  const tolerance = Number.isFinite(configuredTolerance)
    ? Math.max(60, Math.min(900, Math.trunc(configuredTolerance)))
    : 300;
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET,
    tolerance
  );
}

async function resolveStripeCustomerProfile({ email, knownCustomerId = null, purchaseCustomerIds = [] }) {
  const normalizedEmail=String(email||'').trim().toLowerCase();
  const preferred=[knownCustomerId,...purchaseCustomerIds].filter(Boolean);
  const listed=normalizedEmail ? await stripe.customers.list({email:normalizedEmail,limit:100}) : {data:[]};
  const candidateIds=[...new Set([...preferred,...listed.data.map(customer=>customer.id)])];
  const candidates=[];
  for(const id of candidateIds){
    try{
      const customer=listed.data.find(item=>item.id===id)||await stripe.customers.retrieve(id);
      if(!customer||customer.deleted)continue;
      const [subscriptions,invoices]=await Promise.all([
        stripe.subscriptions.list({customer:id,status:'all',limit:20}),
        stripe.invoices.list({customer:id,limit:20}),
      ]);
      const active=subscriptions.data.filter(subscription=>!['canceled','incomplete_expired'].includes(subscription.status));
      const paidInvoices=invoices.data.filter(invoice=>invoice.status==='paid'&&invoice.amount_paid>0);
      candidates.push({id,email:String(customer.email||'').trim().toLowerCase()||null,created:customer.created||0,subscriptions:subscriptions.data,active,paidInvoices,preferred:preferred.includes(id)});
    }catch(error){if(error?.code!=='resource_missing')throw error;}
  }
  candidates.sort((a,b)=>Number(b.preferred)-Number(a.preferred)||b.active.length-a.active.length||b.paidInvoices.length-a.paidInvoices.length||b.subscriptions.length-a.subscriptions.length||b.created-a.created);
  const selected=candidates[0];
  if(!selected)return {customerId:null,subscriptionId:null,subscriptionStatus:null,activeSubscription:false,customerCount:0,paidInvoiceCount:0,source:'none'};
  const subscription=selected.active[0]||selected.subscriptions[0]||null;
  return {customerId:selected.id,subscriptionId:subscription?.id||null,subscriptionStatus:subscription?.status||null,activeSubscription:Boolean(selected.active.length),customerCount:candidates.length,paidInvoiceCount:selected.paidInvoices.length,source:selected.preferred?'stored_or_purchase':'verified_email'};
}

module.exports = { createCheckoutSession, createCustomPackageCheckout, createMobileTopupCheckout, createBillingPortalSession, cancelSubscription, cancelSubscriptionAtPeriodEnd, cancelAllSubscriptionsForCustomers, deleteStripeCustomer, constructWebhookEvent, getNextBillingDate, getBillingHistory, getRecoveryPaymentEvidence, findCustomerIdsByEmail, resolveStripeCustomerProfile, getCustomerEmail, getSubscriptionStateByEmail, listCompletedCheckoutPurchasesByEmail, getCheckoutPurchaseDetails, listRefundablePaymentsByEmail, refundPayment };
