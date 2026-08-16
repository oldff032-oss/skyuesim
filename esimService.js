// eSIM Access integration for Node.js 24+ (CommonJS).
// Keep the public API stable for server.js:
//   provisionEsim({ email, plan })
//   checkUsage(orderNo)

// dotenv is already loaded by server.js. Loading it here is convenient for
// direct use, but it must not prevent the service from being imported alone.
try {
  require('dotenv').config();
} catch {
  // Environment variables may be supplied by the host instead.
}

const crypto = require('crypto');

const BASE_URL = (process.env.ESIM_PROVIDER_API_URL || 'https://api.esimaccess.com')
  .replace(/\/+$/, '');
const ACCESS_CODE = process.env.ESIM_PROVIDER_API_KEY || process.env.ESIM_ACCESS_CODE || '';
const SECRET_KEY = process.env.ESIM_PROVIDER_SECRET_KEY || process.env.ESIM_SECRET_KEY || '';

const PACKAGE_CODE_MAP = {
  basic: process.env.ESIM_PACKAGE_CODE_BASIC || '',
  standard: process.env.ESIM_PACKAGE_CODE_STANDARD || '',
  unlimited: process.env.ESIM_PACKAGE_CODE_UNLIMITED || '',
};

const DEFAULT_PLAN_LIMITS_GB = { basic: 10, standard: 20, unlimited: null };
const MAX_ATTEMPTS = positiveInteger(process.env.ESIM_MAX_ATTEMPTS, 12);
const POLL_INTERVAL_MS = positiveInteger(process.env.ESIM_POLL_INTERVAL_MS, 5000);
const REQUEST_TIMEOUT_MS = positiveInteger(process.env.ESIM_REQUEST_TIMEOUT_MS, 15000);

class EsimAccessError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'EsimAccessError';
    this.code = options.code == null ? null : String(options.code);
    this.status = options.status == null ? null : options.status;
    this.payload = options.payload || null;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConfiguredMockMode() {
  const setting = String(process.env.ESIM_MOCK_MODE || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(setting)) return true;
  if (['0', 'false', 'no', 'off'].includes(setting)) return false;
  // Useful for a new deployment: no credentials means no accidental live order.
  return !ACCESS_CODE || ACCESS_CODE === 'your_access_code_here';
}

function mask(value, visible = 4) {
  if (!value) return 'n/a';
  const text = String(value);
  return text.length <= visible ? '***' : `${text.slice(0, visible)}***`;
}

function log(event, fields = {}) {
  const safeFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== '') safeFields[key] = value;
  }
  console.log(`[esimService] ${event}`, safeFields);
}

function apiMessage(payload) {
  return payload?.errorMessage || payload?.errorMsg || payload?.message || 'Unknown eSIM Access error';
}

function apiCode(payload) {
  const code = payload?.errorCode ?? payload?.code;
  return code == null ? null : String(code);
}

function isSuccess(payload) {
  return payload?.success === true || payload?.success === 'true' || payload?.success === 1;
}

function isPendingAllocation(errorOrPayload) {
  return apiCode(errorOrPayload) === '200010' || errorOrPayload?.code === '200010';
}

function makeHeaders(bodyText) {
  const headers = {
    'Content-Type': 'application/json',
    'RT-AccessCode': ACCESS_CODE,
  };

  // Most accounts accept RT-AccessCode alone. Add HMAC headers when a secret is set.
  if (SECRET_KEY) {
    const timestamp = String(Date.now());
    const requestId = crypto.randomUUID();
    const signature = crypto
      .createHmac('sha256', SECRET_KEY)
      .update(timestamp + requestId + ACCESS_CODE + bodyText)
      .digest('hex');
    headers['RT-Timestamp'] = timestamp;
    headers['RT-RequestID'] = requestId;
    headers['RT-Signature'] = signature;
  }
  return headers;
}

async function esimAccessRequest(path, body = {}) {
  const bodyText = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: makeHeaders(bodyText),
      body: bodyText,
      signal: controller.signal,
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `eSIM Access request timed out after ${REQUEST_TIMEOUT_MS} ms`
      : `eSIM Access network error: ${error.message}`;
    throw new EsimAccessError(message);
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  let payload = null;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new EsimAccessError('eSIM Access returned invalid JSON', {
      status: response.status,
      payload: { rawText: rawText.slice(0, 500) },
    });
  }

  if (!response.ok || !isSuccess(payload)) {
    throw new EsimAccessError(
      `eSIM Access error${response.status ? ` (${response.status})` : ''}: ${apiMessage(payload)}`,
      { code: apiCode(payload), status: response.status, payload }
    );
  }
  return payload;
}

async function queryProfiles({ orderNo = '', iccid = '' }) {
  return esimAccessRequest('/api/v1/open/esim/query', {
    orderNo,
    iccid,
    pager: { pageNum: 1, pageSize: 50 },
  });
}

async function queryOrderProfiles(orderNo) {
  return queryProfiles({ orderNo });
}

async function waitForEsim(orderNo) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const payload = await queryOrderProfiles(orderNo);
      const esim = payload?.obj?.esimList?.[0];
      if (esim) {
        log('profile_ready', { orderNo: mask(orderNo), attempt, iccid: mask(esim.iccid) });
        return esim;
      }
      log('profile_not_ready', { orderNo: mask(orderNo), attempt, reason: 'empty esimList' });
    } catch (error) {
      // 200010 is expected right after /order: SM-DP+ is still allocating profiles.
      if (isPendingAllocation(error)) {
        log('profile_allocating', { orderNo: mask(orderNo), attempt, code: '200010' });
      } else {
        log('profile_query_failed', {
          orderNo: mask(orderNo),
          attempt,
          code: error.code,
          message: error.message,
        });
      }
    }

    if (attempt < MAX_ATTEMPTS) await sleep(POLL_INTERVAL_MS);
  }

  throw new EsimAccessError(
    `eSIM profile was not ready after ${MAX_ATTEMPTS} attempts for order ${orderNo}`,
    { code: 'PROFILE_NOT_READY' }
  );
}

function mockEsim(email, plan) {
  const now = Date.now();
  const token = crypto.randomBytes(8).toString('hex');
  return {
    status: 'active',
    orderNo: `MOCK-${now}-${token.slice(0, 6)}`,
    esimTranNo: `MOCK-${token}`,
    // Keep the mock ICCID-looking value within crypto.randomInt's safe range.
    iccid: `8944${String(now).slice(-10)}${String(crypto.randomInt(0, 100000)).padStart(5, '0')}`,
    activationCode: `LPA:1$mock.esim-provider.invalid$${Buffer.from(email).toString('hex').slice(0, 24)}`,
    qrCodeUrl: null,
    dataLimitGb: Object.hasOwn(DEFAULT_PLAN_LIMITS_GB, plan) ? DEFAULT_PLAN_LIMITS_GB[plan] : null,
    provider: 'mock-provider',
    apn: 'mock.apn',
    expiredTime: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    activateTime: new Date(now).toISOString(),
  };
}

function packageCodeFor(plan) {
  const code = PACKAGE_CODE_MAP[plan];
  if (!code || code.startsWith('REPLACE_ME')) {
    throw new EsimAccessError(
      `No eSIM Access package code is configured for plan "${plan}". Set ESIM_PACKAGE_CODE_${String(plan).toUpperCase()}.`,
      { code: 'PACKAGE_NOT_CONFIGURED' }
    );
  }
  return code;
}

function transactionId() {
  // API allows up to 50 characters and treats a repeated ID as the same order.
  return `signal-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function bytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Public package catalogue from eSIM Access. It is used server-side only so
// the provider Access Code and signature never reach the customer's browser.
async function listPackages({ locationCode = '', type = '', packageCode = '', iccid = '' } = {}) {
  const payload = await esimAccessRequest('/api/v1/open/package/list', { locationCode, type, packageCode, iccid });
  return payload?.obj?.packageList || [];
}

function bytesToGb(value) {
  const valueInBytes = bytes(value);
  return valueInBytes == null ? null : +(valueInBytes / (1024 ** 3)).toFixed(2);
}

function profileToEsim(profile, orderNo, plan) {
  const packageInfo = Array.isArray(profile.packageList) ? profile.packageList[0] : null;
  const volume = bytes(profile.totalVolume) ?? bytes(packageInfo?.volume);
  // eSIM Access reports bytes.  A 20 GiB package is 21,474,836,480 bytes;
  // dividing by 1e9 incorrectly displayed it as 21 GB.
  const limitGb = volume == null ? DEFAULT_PLAN_LIMITS_GB[plan] ?? null : bytesToGb(volume);
  return {
    status: 'active',
    orderNo,
    esimTranNo: profile.esimTranNo || null,
    iccid: profile.iccid || null,
    activationCode: profile.ac || profile.activationCode || null,
    qrCodeUrl: profile.qrCodeUrl || profile.qrCode || null,
    dataLimitGb: limitGb,
    provider: 'esim-access',
    apn: profile.apn || null,
    expiredTime: profile.expiredTime || null,
    activateTime: profile.activateTime || null,
  };
}

async function provisionEsim({ email, plan, packageCode: suppliedPackageCode = '', dataLimitGb: suppliedDataLimitGb = null }) {
  if (!email || typeof email !== 'string') {
    throw new EsimAccessError('A customer email is required.', { code: 'EMAIL_REQUIRED' });
  }
  if (!plan || typeof plan !== 'string') {
    throw new EsimAccessError('An eSIM plan is required.', { code: 'PLAN_REQUIRED' });
  }

  if (isConfiguredMockMode()) {
    const esim = mockEsim(email, plan);
    log('mock_provisioned', { email: mask(email, 3), plan, orderNo: esim.orderNo });
    return esim;
  }

  const packageCode = suppliedPackageCode || packageCodeFor(plan);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(packageCode)) throw new EsimAccessError('Invalid package code.', { code: 'PACKAGE_CODE_INVALID' });
  const requestId = transactionId();
  log('creating_order', { email: mask(email, 3), plan, packageCode, transactionId: requestId });

  const order = await esimAccessRequest('/api/v1/open/esim/order', {
    transactionId: requestId,
    packageInfoList: [{ packageCode, count: 1 }],
  });
  const orderNo = order?.obj?.orderNo;
  if (!orderNo) {
    throw new EsimAccessError('eSIM Access accepted the order but returned no orderNo.', {
      code: 'ORDER_NUMBER_MISSING',
      payload: order,
    });
  }

  log('order_created', { orderNo: mask(orderNo) });
  const profile = await waitForEsim(orderNo);
  const esim = profileToEsim(profile, orderNo, plan);
  if (suppliedDataLimitGb != null && Number.isFinite(Number(suppliedDataLimitGb))) esim.dataLimitGb = Number(suppliedDataLimitGb);
  log('provisioned', {
    orderNo: mask(orderNo),
    iccid: mask(esim.iccid),
    hasActivationCode: Boolean(esim.activationCode),
    hasQrCode: Boolean(esim.qrCodeUrl),
  });
  return esim;
}

// Re-link an already issued profile to an account after a database recovery.
// This only reads eSIM Access; it never creates a new order or charges Stripe.
async function recoverEsim({ iccid, plan }) {
  if (isConfiguredMockMode()) {
    throw new EsimAccessError('Cannot recover a real eSIM while mock mode is enabled.', { code: 'MOCK_MODE' });
  }
  if (!/^\d{15,22}$/.test(String(iccid || '').trim())) {
    throw new EsimAccessError('A valid ICCID is required.', { code: 'ICCID_REQUIRED' });
  }
  if (!Object.hasOwn(DEFAULT_PLAN_LIMITS_GB, plan)) {
    throw new EsimAccessError('A valid plan is required.', { code: 'PLAN_REQUIRED' });
  }

  const response = await queryProfiles({ iccid: String(iccid).trim() });
  const profile = response?.obj?.esimList?.[0];
  if (!profile) {
    throw new EsimAccessError('eSIM Access did not find this ICCID.', { code: 'PROFILE_NOT_FOUND' });
  }
  if (!profile.orderNo) {
    throw new EsimAccessError('The provider returned no order number for this ICCID.', { code: 'ORDER_NUMBER_MISSING' });
  }

  const esim = profileToEsim(profile, profile.orderNo, plan);
  log('profile_recovered', { orderNo: mask(esim.orderNo), iccid: mask(esim.iccid) });
  return esim;
}

async function checkUsage(orderNo) {
  if (!orderNo || typeof orderNo !== 'string') {
    throw new EsimAccessError('An eSIM orderNo is required.', { code: 'ORDER_NUMBER_REQUIRED' });
  }

  if (isConfiguredMockMode() || orderNo.startsWith('MOCK-')) {
    return { usedBytes: 0, totalBytes: null, esimStatus: 'active', apn: 'mock.apn', expiredTime: null, activateTime: null };
  }

  const profileResponse = await queryOrderProfiles(orderNo);
  const profile = profileResponse?.obj?.esimList?.[0];
  if (!profile) {
    throw new EsimAccessError(`No eSIM profile found for order ${orderNo}.`, { code: 'PROFILE_NOT_FOUND' });
  }

  const fallbackUsage = bytes(profile.orderUsage) ?? 0;
  const fallbackTotal = bytes(profile.totalVolume) ?? bytes(profile.packageList?.[0]?.volume);
  const esimTranNo = profile.esimTranNo;
  if (!esimTranNo) {
    log('usage_using_profile_fallback', { orderNo: mask(orderNo), reason: 'missing esimTranNo' });
    return usageResult(fallbackUsage, fallbackTotal, profile);
  }

  try {
    const usageResponse = await esimAccessRequest('/api/v1/open/esim/usage/query', { esimTranNoList: [esimTranNo] });
    const usage = usageResponse?.obj?.[0] || usageResponse?.obj?.esimList?.[0] || usageResponse?.obj?.list?.[0] || usageResponse?.obj;
    if (!usage) throw new EsimAccessError('Usage endpoint returned no record.', { code: 'USAGE_NOT_FOUND' });
    return usageResult(bytes(usage.dataUsage) ?? fallbackUsage, bytes(usage.totalData) ?? fallbackTotal, profile, usage);
  } catch (error) {
    // Usage is delayed by the carrier and should not make the dashboard unavailable.
    log('usage_endpoint_failed_using_profile_fallback', { orderNo: mask(orderNo), code: error.code, message: error.message });
    return usageResult(fallbackUsage, fallbackTotal, profile);
  }
}

function usageResult(usedBytes, totalBytes, profile, usageDetails = null) {
  return {
    usedBytes: usedBytes ?? 0,
    totalBytes: totalBytes ?? null,
    esimStatus: profile.esimStatus || profile.smdpStatus || null,
    apn: profile.apn || null,
    expiredTime: profile.expiredTime || null,
    activateTime: profile.activateTime || null,
    lastUpdateTime: usageDetails?.lastUpdateTime || profile.lastUpdateTime || null,
  };
}

// Adds a provider top-up package to an existing eSIM. Unlike /order, this
// does not issue a second profile; it increases the existing profile balance.
async function topupEsim({ esimTranNo = '', iccid = '', packageCode }) {
  if (isConfiguredMockMode()) throw new EsimAccessError('Cannot top up a real eSIM while mock mode is enabled.', { code: 'MOCK_MODE' });
  if (!esimTranNo && !iccid) throw new EsimAccessError('eSIM UID or ICCID is required for top-up.', { code: 'ESIM_ID_REQUIRED' });
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(packageCode || ''))) throw new EsimAccessError('A valid top-up package code is required.', { code: 'PACKAGE_CODE_INVALID' });
  const result = await esimAccessRequest('/api/v1/open/esim/topup', {
    esimTranNo: String(esimTranNo || ''),
    iccid: String(iccid || ''),
    packageCode: String(packageCode),
    transactionId: transactionId(),
  });
  const topup = result?.obj || {};
  const totalBytes = bytes(topup.totalVolume);
  const usedBytes = bytes(topup.orderUsage);
  return {
    transactionId: topup.transactionId || null,
    iccid: topup.iccid || iccid || null,
    totalGb: totalBytes == null ? null : bytesToGb(totalBytes),
    usedGb: usedBytes == null ? null : bytesToGb(usedBytes),
    remainingGb: totalBytes == null || usedBytes == null ? null : Math.max(0, +(bytesToGb(totalBytes) - bytesToGb(usedBytes)).toFixed(2)),
    expiredTime: topup.expiredTime || null,
    totalDuration: topup.totalDuration || null,
  };
}

module.exports = { provisionEsim, checkUsage, recoverEsim, topupEsim, listPackages };
