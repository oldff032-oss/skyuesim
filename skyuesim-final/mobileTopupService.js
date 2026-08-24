require('dotenv').config();

const DEFAULT_TIMEOUT_MS = 15000;
const cache = new Map();

function configuredProvider() {
  return String(process.env.MOBILE_TOPUP_PROVIDER || 'dtone').trim().toLowerCase();
}

function configuration() {
  const provider = configuredProvider();
  const environment = String(process.env.DTONE_ENV || 'preprod').trim().toLowerCase() === 'production' ? 'production' : 'preprod';
  const key = String(process.env.DTONE_API_KEY || '').trim();
  const secret = String(process.env.DTONE_API_SECRET || '').trim();
  const defaultBaseUrl = environment === 'production'
    ? 'https://dvs-api.dtone.com/v1'
    : 'https://preprod-dvs-api.dtone.com/v1';
  const baseUrl = String(process.env.DTONE_API_BASE_URL || defaultBaseUrl).trim().replace(/\/$/, '');
  return {
    provider,
    environment,
    baseUrl,
    configured: provider === 'dtone' && Boolean(key && secret),
    key,
    secret,
  };
}

function publicStatus() {
  const config = configuration();
  return {
    provider: config.provider === 'dtone' ? 'DT One' : config.provider,
    environment: config.environment,
    configured: config.configured,
    live: config.configured && config.environment === 'production',
  };
}

function serviceError(message, code, status = 502, nonRetryable = false) {
  return Object.assign(new Error(message), { code, status, nonRetryable });
}

function requireConfiguration() {
  const config = configuration();
  if (config.provider !== 'dtone') throw serviceError('Непідтримуваний партнер мобільних поповнень', 'TOPUP_PROVIDER_UNSUPPORTED', 503, true);
  if (!config.configured) throw serviceError('Партнер мобільних поповнень ще не підключений', 'TOPUP_PROVIDER_NOT_CONFIGURED', 503, true);
  return config;
}

function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['items', 'data', 'content', 'results']) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

async function request(path, { method = 'GET', query = {}, body = null } = {}) {
  const config = requireConfiguration();
  const url = new URL(`${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(3000, Number(process.env.MOBILE_TOPUP_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)));
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.key}:${config.secret}`).toString('base64')}`,
        Accept: 'application/json',
        'Accept-Language': 'en',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { message: text }; }
    if (!response.ok) {
      const detail = payload?.message || payload?.error?.message || payload?.error || `HTTP ${response.status}`;
      const nonRetryable = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status);
      throw serviceError(`Партнер відхилив запит: ${String(detail).slice(0, 300)}`, 'TOPUP_PROVIDER_ERROR', response.status, nonRetryable);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw serviceError('Партнер не відповів вчасно', 'TOPUP_PROVIDER_TIMEOUT', 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function cached(key, ttlMs, loader) {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = await loader();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function listPages(path, query, maxPages = 3) {
  const output = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await request(path, { query: { ...query, page, per_page: 100 } });
    const items = unwrapList(payload);
    output.push(...items);
    if (items.length < 100) break;
  }
  return output;
}

function normalizeCountry(country) {
  const isoCode = String(country?.iso_code || country?.isoCode || country?.code || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(isoCode)) return null;
  return { isoCode, name: String(country?.name || isoCode).slice(0, 100) };
}

async function listCountries() {
  return cached('countries', 6 * 60 * 60 * 1000, async () => {
    const countries = await listPages('/countries', { service_id: 1 }, 3);
    return countries.map(normalizeCountry).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  });
}

async function listOperators(countryIsoCode) {
  const country = String(countryIsoCode || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(country)) throw serviceError('Вибери коректну країну', 'TOPUP_COUNTRY_INVALID', 400, true);
  return cached(`operators:${country}`, 60 * 60 * 1000, async () => {
    const operators = await listPages('/operators', { country_iso_code: country, service_id: 1 }, 3);
    return operators.map(item => ({ id: Number(item?.id), name: String(item?.name || '').slice(0, 120) }))
      .filter(item => Number.isInteger(item.id) && item.id > 0 && item.name)
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  });
}

function wholesalePrice(product) {
  const amount = Number(product?.prices?.wholesale?.amount);
  const currency = String(product?.prices?.wholesale?.unit || '').trim().toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  return { amount, currency };
}

function retailPrice(product) {
  const wholesale = wholesalePrice(product);
  if (!wholesale) return null;
  const percent = Math.min(100, Math.max(0, Number(process.env.MOBILE_TOPUP_MARKUP_PERCENT || 18))) / 100;
  const fixed = Math.min(50, Math.max(0, Number(process.env.MOBILE_TOPUP_FIXED_MARKUP || 0.5)));
  const minimum = Math.min(50, Math.max(0, Number(process.env.MOBILE_TOPUP_MIN_MARKUP || 0.5)));
  const retailAmount = Math.max(wholesale.amount + minimum, wholesale.amount * (1 + percent) + fixed);
  return { amountCents: Math.ceil(retailAmount * 100), currency: wholesale.currency.toLowerCase(), wholesale };
}

function dataBenefit(product) {
  const benefits = Array.isArray(product?.benefits) ? product.benefits : [];
  return benefits.find(item => String(item?.type || '').toUpperCase() === 'DATA') || null;
}

function benefitLabel(product) {
  const benefit = dataBenefit(product);
  if (!benefit) return 'Мобільний інтернет';
  const raw = benefit?.amount || {};
  const amount = Number(raw.total_including_tax ?? raw.total_excluding_tax ?? raw.base);
  const unit = String(benefit?.unit || '').trim().toUpperCase();
  if (Number.isFinite(amount) && amount < 0 && unit) return `Безліміт ${unit}`;
  if (Number.isFinite(amount) && unit) return `${amount.toLocaleString('uk-UA')} ${unit}`;
  return String(benefit?.additional_information || 'Мобільний інтернет').slice(0, 120);
}

function validityLabel(product) {
  const candidates = [product?.validity, dataBenefit(product)?.validity].filter(Boolean);
  for (const validity of candidates) {
    const quantity = Number(validity?.quantity);
    const unit = String(validity?.unit || '').toUpperCase();
    if (Number.isFinite(quantity) && quantity > 0 && unit) return `${quantity} ${unit === 'DAY' || unit === 'DAYS' ? 'днів' : unit.toLowerCase()}`;
  }
  const text = `${product?.name || ''} ${product?.description || ''}`;
  const match = text.match(/(\d{1,3})\s*(?:day|days|дн(?:і|ів)?)/i);
  return match ? `${match[1]} днів` : null;
}

function safeProduct(product, { includeCost = false } = {}) {
  const id = Number(product?.id);
  const pricing = retailPrice(product);
  const benefit = dataBenefit(product);
  const type = String(product?.type || '').toUpperCase();
  if (!Number.isInteger(id) || id <= 0 || !pricing || !benefit || type !== 'FIXED_VALUE_RECHARGE') return null;
  const operator = product?.operator || {};
  const country = operator?.country || {};
  return {
    id,
    name: String(product?.name || benefitLabel(product)).slice(0, 140),
    description: String(product?.description || benefit?.additional_information || '').slice(0, 300),
    data: benefitLabel(product),
    validity: validityLabel(product),
    operator: { id: Number(operator?.id) || null, name: String(operator?.name || '').slice(0, 120) },
    country: { isoCode: String(country?.iso_code || '').slice(0, 3), name: String(country?.name || '').slice(0, 100) },
    amountCents: pricing.amountCents,
    currency: pricing.currency,
    ...(includeCost ? { providerCost: pricing.wholesale.amount, providerCurrency: pricing.wholesale.currency } : {}),
  };
}

async function listProducts({ countryIsoCode, operatorId }) {
  const country = String(countryIsoCode || '').trim().toUpperCase();
  const operator = Number(operatorId);
  if (!/^[A-Z]{3}$/.test(country)) throw serviceError('Вибери коректну країну', 'TOPUP_COUNTRY_INVALID', 400, true);
  if (!Number.isInteger(operator) || operator <= 0) throw serviceError('Вибери мобільного оператора', 'TOPUP_OPERATOR_INVALID', 400, true);
  return cached(`products:${country}:${operator}`, 15 * 60 * 1000, async () => {
    const products = await listPages('/products', {
      service_id: 1,
      country_iso_code: country,
      operator_id: operator,
      type: 'FIXED_VALUE_RECHARGE',
      benefit_types: 'DATA',
      sort: 'amount,name',
    }, 3);
    return products.map(item => safeProduct(item)).filter(Boolean);
  });
}

async function getProduct(productId, { includeCost = false } = {}) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) throw serviceError('Некоректний пакет інтернету', 'TOPUP_PRODUCT_INVALID', 400, true);
  const raw = await request(`/products/${id}`);
  const product = safeProduct(raw, { includeCost });
  if (!product) throw serviceError('Цей продукт не є підтримуваним пакетом мобільного інтернету', 'TOPUP_PRODUCT_UNSUPPORTED', 409, true);
  return product;
}

function normalizePhone(value) {
  const phone = String(value || '').trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw serviceError('Введи номер у міжнародному форматі, наприклад +420123456789', 'TOPUP_PHONE_INVALID', 400, true);
  return phone;
}

function transactionState(transaction) {
  const classId = Number(transaction?.status?.class?.id);
  const message = String(transaction?.status?.class?.message || transaction?.status?.message || transaction?.status || '').trim().toUpperCase();
  if (classId === 7 || message === 'COMPLETED' || message === 'SUCCESSFUL') return 'delivered';
  if ([3, 4, 8, 9].includes(classId) || ['REJECTED', 'CANCELLED', 'DECLINED', 'REVERSED', 'FAILED'].includes(message)) return 'failed';
  return 'processing';
}

function safeTransaction(transaction) {
  return {
    id: transaction?.id == null ? null : String(transaction.id),
    externalId: String(transaction?.external_id || '').slice(0, 40) || null,
    state: transactionState(transaction),
    status: String(transaction?.status?.message || transaction?.status?.class?.message || transaction?.status || 'PROCESSING').slice(0, 100),
    operatorReference: String(transaction?.operator_reference || '').slice(0, 120) || null,
    completedAt: transaction?.confirmation_date || null,
  };
}

async function purchaseProduct({ orderId, productId, phone }) {
  const externalId = String(orderId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  if (!externalId) throw serviceError('Замовлення не має ідентифікатора', 'TOPUP_ORDER_INVALID', 400, true);
  const transaction = await request('/sync/transactions', {
    method: 'POST',
    body: {
      external_id: externalId,
      product_id: Number(productId),
      auto_confirm: true,
      credit_party_identifier: { mobile_number: normalizePhone(phone) },
    },
  });
  return safeTransaction(transaction);
}

async function getTransaction(transactionId) {
  const id = String(transactionId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw serviceError('Некоректний ідентифікатор транзакції', 'TOPUP_TRANSACTION_INVALID', 400, true);
  return safeTransaction(await request(`/transactions/${encodeURIComponent(id)}`));
}

module.exports = {
  publicStatus,
  listCountries,
  listOperators,
  listProducts,
  getProduct,
  normalizePhone,
  purchaseProduct,
  getTransaction,
};
