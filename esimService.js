// eSIM Access integration for Node.js 24+ (CommonJS).
// Keep the public API stable for server.js:
//   provisionEsim({ email, plan })
//   checkUsage({ orderNo, esimTranNo, iccid })

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

const TOPUP_PACKAGE_CODE_MAP = {
  basic: process.env.ESIM_TOPUP_PACKAGE_CODE_BASIC || '',
  standard: process.env.ESIM_TOPUP_PACKAGE_CODE_STANDARD || '',
  unlimited: process.env.ESIM_TOPUP_PACKAGE_CODE_UNLIMITED || '',
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

async function queryProfiles({ orderNo = '', iccid = '', pageNum = 1, pageSize = 50 }) {
  return esimAccessRequest('/api/v1/open/esim/query', {
    orderNo,
    iccid,
    pager: { pageNum, pageSize },
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
    activateTime: null,
    esimStatus: 'GOT_RESOURCE',
    smdpStatus: 'RELEASED',
    eidBound: false,
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
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function firstBytes(...values) {
  for (const value of values) {
    const parsed=bytes(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function maxBytes(...values){const parsed=values.map(bytes).filter(value=>value!=null);return parsed.length?Math.max(...parsed):null;}
function minBytes(...values){const parsed=values.map(bytes).filter(value=>value!=null);return parsed.length?Math.min(...parsed):null;}

function profileUsageCounters(profile = {}) {
  const packages=Array.isArray(profile.packageList)?profile.packageList:[];
  const packageTotals=packages.map(item=>firstBytes(item?.totalVolume,item?.totalData,item?.volume)).filter(value=>value!=null);
  const packageUsed=packages.map(item=>firstBytes(item?.dataUsage,item?.orderUsage,item?.usedVolume,item?.usedData,item?.usedBytes,item?.usage));
  const packageRemaining=packages.map(item=>firstBytes(item?.remain,item?.remaining,item?.remainVolume,item?.remainingVolume,item?.remainingData,item?.remainingBytes,item?.dataRemain));
  const packageTotal=packageTotals.length===packages.length&&packages.length?packageTotals.reduce((sum,value)=>sum+value,0):null;
  const packageUsedTotal=packageUsed.length===packages.length&&packages.length&&packageUsed.every(value=>value!=null)?packageUsed.reduce((sum,value)=>sum+value,0):null;
  const packageRemainingTotal=packageRemaining.length===packages.length&&packages.length&&packageRemaining.every(value=>value!=null)?packageRemaining.reduce((sum,value)=>sum+value,0):null;
  const totalBytes=maxBytes(profile.totalVolume,profile.totalData,profile.dataTotal,profile.volume,packageTotal);
  const explicitRemaining=minBytes(profile.remain,profile.remaining,profile.remainVolume,profile.remainingVolume,profile.remainingData,profile.remainingBytes,profile.dataRemain,packageRemainingTotal);
  const explicitUsed=maxBytes(profile.dataUsage,profile.orderUsage,profile.usedVolume,profile.usedData,profile.usedBytes,profile.usage,packageUsedTotal);
  let usedBytes=explicitUsed,remainingBytes=explicitRemaining,counterSource='missing';
  if(totalBytes!=null&&explicitRemaining!=null){remainingBytes=Math.min(totalBytes,explicitRemaining);usedBytes=Math.max(0,totalBytes-remainingBytes);counterSource=packageRemainingTotal!=null&&explicitRemaining===packageRemainingTotal?'package.remaining':'profile.remaining';}
  else if(totalBytes!=null&&explicitUsed!=null){usedBytes=Math.min(totalBytes,explicitUsed);remainingBytes=Math.max(0,totalBytes-usedBytes);counterSource=packageUsedTotal!=null&&explicitUsed===packageUsedTotal?'package.used':'profile.used';}
  const counterUpdatedAt=profile.lastDataUsageUpdateTime||profile.usageUpdateTime||profile.lastUsageUpdateTime||profile.lastUpdateTime||profile.updateTime||null;
  return{usedBytes,totalBytes,remainingBytes,counterSource,counterUpdatedAt,hasUsageTimestamp:Boolean(counterUpdatedAt)};
}

function realtimeUsageItems(payload) {
  const object=payload?.obj;
  if(Array.isArray(object)) return object;
  if(!object||typeof object!=='object') return [];
  for(const key of ['esimUsageList','usageList','list']){
    if(Array.isArray(object[key])) return object[key];
  }
  return [object];
}

async function queryRealtimeUsage(esimTranNo) {
  const requested=String(esimTranNo||'').trim();
  if(!requested) throw new EsimAccessError('An eSIM transaction number is required for real-time traffic.',{code:'ESIM_TRAN_NO_REQUIRED'});
  const response=await esimAccessRequest('/api/v1/open/esim/usage/query',{esimTranNoList:[requested]});
  const items=realtimeUsageItems(response);
  const exact=items.find(item=>String(item?.esimTranNo||'').trim()===requested);
  // The official endpoint accepts exactly the requested transaction list. Some
  // reseller responses omit esimTranNo when a single item is requested; that
  // response is still unambiguous. Never accept a differently identified item.
  const usage=exact||((items.length===1&&!String(items[0]?.esimTranNo||'').trim())?items[0]:null);
  if(!usage) throw new EsimAccessError('The real-time usage response did not contain the requested eSIM.',{code:'USAGE_PROFILE_MISMATCH'});
  const counters=profileUsageCounters(usage);
  if(counters.usedBytes==null||counters.totalBytes==null){
    throw new EsimAccessError('The real-time usage response did not include complete traffic counters.',{code:'USAGE_VALUES_MISSING'});
  }
  return{...counters,details:usage};
}

function trustedProfileShareUrl(profile = {}) {
  for(const value of [profile.shortUrl,profile.shortURL,profile.shareUrl,profile.installUrl,profile.installationUrl]){
    try{const url=new URL(String(value||'').trim());if(url.protocol==='https:'&&url.hostname.toLowerCase()==='p.qrsim.net')return url.toString();}catch{}
  }
  return null;
}

// Public package catalogue from eSIM Access. It is used server-side only so
// the provider Access Code and signature never reach the customer's browser.
async function listPackages({ locationCode = '', type = '', packageCode = '', iccid = '' } = {}) {
  const collected = [], seen = new Set();
  const maximumPages = Math.min(30, positiveInteger(process.env.ESIM_PACKAGE_MAX_PAGES, 15));
  for (let pageNum = 1; pageNum <= maximumPages; pageNum += 1) {
    const payload = await esimAccessRequest('/api/v1/open/package/list', { locationCode, type, packageCode, iccid, pager:{ pageNum, pageSize:200 } });
    const batch = payload?.obj?.packageList || [];
    if (!batch.length) break;
    let added = 0;
    for (const item of batch) {
      const key = String(item?.packageCode || item?.slug || '');
      if (!key || seen.has(key)) continue;
      seen.add(key); collected.push(item); added += 1;
    }
    // Some provider accounts ignore pager and return the same first page.
    if (!added) break;
  }
  return collected;
}

async function findRenewalTopup({ iccid, plan }) {
  const configured = TOPUP_PACKAGE_CODE_MAP[plan];
  if (configured) return { packageCode: configured, source: 'environment' };
  const packages = await listPackages({ type: 'TOPUP', iccid });
  const targetGb = { basic: 10, standard: 20 }[plan] || null;
  const candidates = packages.map(item => {
    const volumeBytes = bytes(item.volume ?? item.dataVolume);
    const volumeGb = volumeBytes == null ? null : bytesToGb(volumeBytes);
    const text = `${item.name || ''} ${item.description || ''}`.toLowerCase();
    const unlimited = Number(item.dataType) === 4 || text.includes('unlimited');
    return { item, volumeGb, unlimited };
  }).filter(candidate => {
    if (!(candidate.item.packageCode || candidate.item.slug)) return false;
    if (plan === 'unlimited') return candidate.unlimited;
    return candidate.volumeGb != null && Math.abs(candidate.volumeGb - targetGb) <= Math.max(0.25, targetGb * 0.08);
  }).sort((a, b) => {
    const durationA = Math.abs(Number(a.item.duration || 30) - 30);
    const durationB = Math.abs(Number(b.item.duration || 30) - 30);
    return durationA - durationB || Number(a.item.price || Infinity) - Number(b.item.price || Infinity);
  });
  const selected = candidates[0];
  if (!selected) {
    throw new EsimAccessError(`No compatible renewal top-up found for plan "${plan}" and this ICCID. Configure ESIM_TOPUP_PACKAGE_CODE_${String(plan).toUpperCase()}.`, { code: 'RENEWAL_PACKAGE_NOT_FOUND' });
  }
  return {
    packageCode: selected.item.packageCode || selected.item.slug,
    source: 'provider_lookup',
    volumeGb: selected.volumeGb,
    name: selected.item.name || selected.item.description || null,
  };
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
    status: ['REVOKED','CANCELED','CANCELLED','EXPIRED','USED_UP','SUSPENDED'].includes(profile.esimStatus) ? profile.esimStatus.toLowerCase() : 'active',
    providerStatus: profile.esimStatus || 'UNKNOWN',
    installationStatus: profile.smdpStatus || 'UNKNOWN',
    installedBefore: Boolean(profile.eid) || ['ENABLED','DISABLED','DELETED','INSTALLED','DOWNLOADED'].includes(profile.smdpStatus),
    canInstall: profile.smdpStatus === 'RELEASED' && profile.esimStatus === 'GOT_RESOURCE' && !profile.eid && Number(profile.orderUsage) === 0,
    usedGb: bytesToGb(profile.orderUsage),
    orderNo,
    transactionId: profile.transactionId || null,
    esimTranNo: profile.esimTranNo || null,
    iccid: profile.iccid || null,
    activationCode: profile.ac || profile.activationCode || null,
    qrCodeUrl: profile.qrCodeUrl || profile.qrCode || null,
    dataLimitGb: limitGb,
    provider: 'esim-access',
    apn: profile.apn || null,
    expiredTime: profile.expiredTime || null,
    activateTime: profile.activateTime || null,
    esimStatus: profile.esimStatus || null,
    smdpStatus: profile.smdpStatus || null,
    eidBound: Boolean(profile.eid),
    lastUpdateTime: profile.lastUpdateTime || new Date().toISOString(),
    packageName: packageInfo?.packageName || packageInfo?.name || null,
    packageCode: packageInfo?.packageCode || null,
    location: packageInfo?.locationCode || null,
    durationDays: packageInfo?.duration || profile.totalDuration || null,
  };
}

async function provisionEsim({ email, plan, packageCode: suppliedPackageCode = '', dataLimitGb: suppliedDataLimitGb = null, transactionId: suppliedTransactionId = '' }) {
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
  const requestId = suppliedTransactionId || transactionId();
  if (!/^[A-Za-z0-9_-]{8,50}$/.test(requestId)) throw new EsimAccessError('Invalid eSIM order transaction ID.', { code: 'TRANSACTION_ID_INVALID' });
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
  if (!plan || typeof plan !== 'string') throw new EsimAccessError('A valid plan is required.', { code: 'PLAN_REQUIRED' });

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

// Import a support-issued replacement by its exact provider order number.
// This is read-only at eSIM Access and never creates or charges a new order.
async function recoverEsimByOrderNo({ orderNo, plan = 'custom' }) {
  const reference = String(orderNo || '').trim();
  if (isConfiguredMockMode()) {
    throw new EsimAccessError('Cannot recover a real eSIM while mock mode is enabled.', { code: 'MOCK_MODE' });
  }
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(reference)) {
    throw new EsimAccessError('A valid provider order number is required.', { code: 'ORDER_NUMBER_REQUIRED' });
  }
  const response = await queryProfiles({ orderNo: reference });
  const profile = response?.obj?.esimList?.[0];
  if (!profile) throw new EsimAccessError('eSIM Access did not find this order.', { code: 'PROFILE_NOT_FOUND' });
  const esim = profileToEsim(profile, profile.orderNo || reference, plan);
  log('order_profile_recovered', { orderNo: mask(esim.orderNo), iccid: mask(esim.iccid) });
  return esim;
}

async function changeProfileState(action, { esimTranNo = '', iccid = '' } = {}) {
  const allowed = new Set(['cancel', 'revoke', 'suspend', 'unsuspend']);
  if (!allowed.has(action)) throw new EsimAccessError('Unsupported eSIM action.', { code: 'ACTION_INVALID' });
  if (isConfiguredMockMode()) throw new EsimAccessError('Profile management is unavailable while mock mode is enabled.', { code: 'MOCK_MODE' });
  const transaction = String(esimTranNo || '').trim();
  const card = String(iccid || '').trim();
  if (!transaction && !/^\d{15,22}$/.test(card)) throw new EsimAccessError('A valid eSIM transaction number or ICCID is required.', { code: 'ESIM_ID_REQUIRED' });
  const payload = transaction ? { esimTranNo: transaction } : { iccid: card };
  const response = await esimAccessRequest(`/api/v1/open/esim/${action}`, payload);
  log(`profile_${action}`, { esimTranNo: mask(transaction), iccid: mask(card) });
  return response?.obj || { success: true };
}

const cancelEsim = identifiers => changeProfileState('cancel', identifiers);
const revokeEsim = identifiers => changeProfileState('revoke', identifiers);
const suspendEsim = identifiers => changeProfileState('suspend', identifiers);
const unsuspendEsim = identifiers => changeProfileState('unsuspend', identifiers);

async function listAllocatedEsims() {
  if (isConfiguredMockMode()) return [];
  const profiles = [], seen = new Set();
  const maximumPages = Math.min(40, positiveInteger(process.env.ESIM_INVENTORY_MAX_PAGES, 20));
  for (let pageNum = 1; pageNum <= maximumPages; pageNum += 1) {
    const response = await queryProfiles({ pageNum, pageSize: 500 });
    const batch = response?.obj?.esimList || [];
    for (const profile of batch) {
      const key = String(profile.iccid || profile.esimTranNo || profile.orderNo || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      profiles.push(profileToEsim(profile, profile.orderNo || '', 'custom'));
    }
    const total = Number(response?.obj?.pager?.total || 0);
    if (!batch.length || batch.length < 500 || (total && profiles.length >= total)) break;
  }
  return profiles;
}

async function checkUsage(input) {
  const identifiers = typeof input === 'string' ? { orderNo:input } : (input || {});
  const orderNo = String(identifiers.orderNo || '').trim();
  const requestedTranNo = String(identifiers.esimTranNo || '').trim();
  const requestedIccid = String(identifiers.iccid || '').trim();
  if (!orderNo && !requestedTranNo && !requestedIccid) {
    throw new EsimAccessError('An eSIM orderNo, esimTranNo or ICCID is required.', { code: 'ESIM_ID_REQUIRED' });
  }

  if (isConfiguredMockMode() || orderNo.startsWith('MOCK-')) {
    return { usedBytes:0, totalBytes:null, esimStatus:'active', apn:'mock.apn', expiredTime:null, activateTime:null, source:'mock', live:true, stale:false, syncedAt:new Date().toISOString() };
  }

  let profile = null;
  try {
    let profileResponse;
    if (requestedIccid) {
      // Newer eSIM Access accounts expose the documented /list route, while
      // some existing reseller accounts return HTTP 404 for it and only
      // expose /query. Use exactly one successful response and still require
      // an exact ICCID/esimTranNo match below, so counters can never be mixed.
      try {
        profileResponse = await esimAccessRequest('/api/v1/open/esim/list', { iccid:requestedIccid, pager:{ pageNum:1, pageSize:20 } });
      } catch (error) {
        if (Number(error.status) !== 404) throw error;
        log('usage_list_unavailable_using_query', { iccid:mask(requestedIccid), status:error.status, code:error.code });
        profileResponse = await queryProfiles({ iccid:requestedIccid, pageNum:1, pageSize:20 });
      }
    } else profileResponse = await queryOrderProfiles(orderNo);
    const profiles = profileResponse?.obj?.esimList || [];
    profile = profiles.find((item) => requestedTranNo && String(item?.esimTranNo || '') === requestedTranNo)
      || profiles.find((item) => requestedIccid && String(item?.iccid || '') === requestedIccid)
      || (!requestedTranNo && !requestedIccid ? profiles[0] : null)
      || null;
  } catch (error) {
    error.usageLookupFailed = true;
    throw error;
  }

  if (!profile) {
    throw new EsimAccessError(`No exact eSIM profile found for ${requestedIccid || requestedTranNo || orderNo}.`, { code:'PROFILE_NOT_FOUND' });
  }

  const profileTranNo=String(profile.esimTranNo||requestedTranNo||'').trim();
  if(profileTranNo){
    try{
      const realtime=await queryRealtimeUsage(profileTranNo);
      return usageResult(realtime.usedBytes,realtime.totalBytes,profile,realtime.details,{
        source:'realtime_usage_api',live:true,stale:false,syncedAt:new Date().toISOString(),
        counterSource:`realtime.${realtime.counterSource}`,counterUpdatedAt:realtime.counterUpdatedAt,hasUsageTimestamp:realtime.hasUsageTimestamp,
      });
    }catch(error){
      log('realtime_usage_failed_using_fallback',{esimTranNo:mask(profileTranNo),code:error.code,status:error.status,message:error.message});
    }
  }

  const shareUrl=trustedProfileShareUrl(profile);
  if(shareUrl){
    try{
      const live=await checkSupportLinkUsage(shareUrl);
      if(requestedIccid&&live.iccid&&String(live.iccid)!==requestedIccid)throw new EsimAccessError('Live usage link returned another ICCID.',{code:'USAGE_ICCID_MISMATCH'});
      return usageResult(live.usedBytes,live.totalBytes,profile,live,{
        source:'share_usage_api',live:true,stale:false,syncedAt:new Date().toISOString(),counterSource:'share.dataUsage',counterUpdatedAt:live.lastUpdateTime||null,hasUsageTimestamp:Boolean(live.lastUpdateTime),
      });
    }catch(error){
      log('share_usage_failed_using_profile_counter',{iccid:mask(requestedIccid),code:error.code,message:error.message});
    }
  }

  const counters=profileUsageCounters(profile),{usedBytes,totalBytes}=counters;
  if (usedBytes == null || totalBytes == null) {
    throw new EsimAccessError('The provider profile did not include a complete traffic counter.', { code:'USAGE_VALUES_MISSING' });
  }
  return usageResult(usedBytes, totalBytes, profile, profile, {
    source:'profile_api', live:true, stale:false,
    syncedAt:new Date().toISOString(),counterSource:counters.counterSource,counterUpdatedAt:counters.counterUpdatedAt,hasUsageTimestamp:counters.hasUsageTimestamp,
  });
}

function usageResult(usedBytes, totalBytes, profile, usageDetails = null, metadata = {}) {
  return {
    usedBytes: usedBytes ?? null,
    totalBytes: totalBytes ?? null,
    esimStatus: profile.esimStatus || profile.smdpStatus || null,
    apn: profile.apn || null,
    expiredTime: profile.expiredTime || null,
    activateTime: profile.activateTime || null,
    lastUpdateTime: usageDetails?.lastUpdateTime || usageDetails?.lastDataUsageUpdateTime || profile.lastUpdateTime || null,
    providerUpdatedAt: usageDetails?.lastDataUsageUpdateTime || usageDetails?.usageUpdateTime || usageDetails?.lastUsageUpdateTime || usageDetails?.lastUpdateTime || usageDetails?.updateTime || null,
    ...metadata,
  };
}

// Adds a provider top-up package to an existing eSIM. Unlike /order, this
// does not issue a second profile; it increases the existing profile balance.
async function topupEsim({ esimTranNo = '', iccid = '', packageCode, transactionId: suppliedTransactionId = '' }) {
  if (isConfiguredMockMode()) throw new EsimAccessError('Cannot top up a real eSIM while mock mode is enabled.', { code: 'MOCK_MODE' });
  if (!esimTranNo && !iccid) throw new EsimAccessError('eSIM UID or ICCID is required for top-up.', { code: 'ESIM_ID_REQUIRED' });
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(packageCode || ''))) throw new EsimAccessError('A valid top-up package code is required.', { code: 'PACKAGE_CODE_INVALID' });
  const result = await esimAccessRequest('/api/v1/open/esim/topup', {
    esimTranNo: String(esimTranNo || ''),
    iccid: String(iccid || ''),
    packageCode: String(packageCode),
    transactionId: suppliedTransactionId || transactionId(),
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

async function listOwnedProfiles(pageNum = 1) {
  if (isConfiguredMockMode()) throw new EsimAccessError('Для обліку потрібен реальний eSIM Access', {code:'MOCK_MODE'});
  const result = await esimAccessRequest('/api/v1/open/esim/query', {orderNo:'',iccid:'',pager:{pageNum,pageSize:50}});
  return {profiles:result?.obj?.esimList || [],pager:result?.obj?.pager || {pageNum,pageSize:50}};
}
async function manageProfile(iccid, action) {
  if (!['suspend','unsuspend','revoke','cancel'].includes(action)) throw new Error('Невідома дія');
  const current = await recoverEsim({iccid,plan:'custom'});
  if (!current.esimTranNo) throw new Error('Відсутній ідентифікатор провайдера');
  if (action === 'cancel' && !current.canInstall) throw new Error('Повернення доступне лише для невстановленої невикористаної картки');
  await esimAccessRequest('/api/v1/open/esim/' + action, {esimTranNo:current.esimTranNo});
  return {accepted:true};
}

// Support may issue a replacement through a p.qrsim.net share link without
// attaching the profile to this reseller API account. The share page's own
// "Check Usage" button uses a tokenized read-only eSIM Access endpoint. Read
// that same endpoint server-side so the customer app can still show real data.
async function checkSupportLinkUsage(supportInstallUrl) {
  let shareUrl;
  try { shareUrl = new URL(String(supportInstallUrl || '').trim()); }
  catch { throw new EsimAccessError('A valid support share URL is required.', { code:'SUPPORT_USAGE_URL_INVALID' }); }
  if (shareUrl.protocol !== 'https:' || shareUrl.hostname.toLowerCase() !== 'p.qrsim.net' || shareUrl.username || shareUrl.password) {
    throw new EsimAccessError('Only an official p.qrsim.net support link can be used for usage checks.', { code:'SUPPORT_USAGE_URL_INVALID' });
  }

  let pageResponse;
  try {
    pageResponse = await fetch(shareUrl, { headers:{ Accept:'text/html' }, redirect:'error', signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new EsimAccessError(error?.name === 'TimeoutError' ? 'Support usage page timed out.' : `Support usage page error: ${error.message}`, { code:'SUPPORT_USAGE_PAGE_FAILED' });
  }
  if (!pageResponse.ok) throw new EsimAccessError(`Support usage page returned HTTP ${pageResponse.status}.`, { code:'SUPPORT_USAGE_PAGE_FAILED', status:pageResponse.status });
  const declaredLength = Number(pageResponse.headers.get('content-length') || 0);
  if (declaredLength > 750000) throw new EsimAccessError('Support usage page is unexpectedly large.', { code:'SUPPORT_USAGE_PAGE_INVALID' });
  const html = await pageResponse.text();
  if (!html || html.length > 750000) throw new EsimAccessError('Support usage page is invalid.', { code:'SUPPORT_USAGE_PAGE_INVALID' });
  const input = html.match(/<input\b(?=[^>]*\bid\s*=\s*["']queryUsageAPI["'])[^>]*>/i)?.[0] || '';
  const encodedEndpoint = input.match(/\bvalue\s*=\s*["']([^"']+)["']/i)?.[1] || '';
  const decodedEndpoint = encodedEndpoint.replace(/&amp;/gi,'&').replace(/&#38;/g,'&').replace(/&quot;/gi,'"').replace(/&#39;/g,"'");
  let usageUrl;
  try { usageUrl = new URL(decodedEndpoint); }
  catch { throw new EsimAccessError('Support page did not provide a usage endpoint.', { code:'SUPPORT_USAGE_ENDPOINT_MISSING' }); }
  if (usageUrl.protocol !== 'https:' || usageUrl.hostname.toLowerCase() !== 'api.esimaccess.com' || usageUrl.pathname !== '/api/v1/h5/share/order/queryUsage' || !usageUrl.searchParams.get('token')) {
    throw new EsimAccessError('Support page returned an untrusted usage endpoint.', { code:'SUPPORT_USAGE_ENDPOINT_INVALID' });
  }

  let usageResponse;
  try {
    usageResponse = await fetch(usageUrl, { headers:{ Accept:'application/json' }, redirect:'error', signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new EsimAccessError(error?.name === 'TimeoutError' ? 'Support usage request timed out.' : `Support usage request error: ${error.message}`, { code:'SUPPORT_USAGE_REQUEST_FAILED' });
  }
  const raw = await usageResponse.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : null; }
  catch { throw new EsimAccessError('Support usage endpoint returned invalid JSON.', { code:'SUPPORT_USAGE_RESPONSE_INVALID', status:usageResponse.status }); }
  if (!usageResponse.ok || !isSuccess(payload) || !payload?.obj) {
    throw new EsimAccessError(`Support usage error: ${apiMessage(payload)}`, { code:apiCode(payload) || 'SUPPORT_USAGE_FAILED', status:usageResponse.status, payload });
  }
  const totalBytes = bytes(payload.obj.totalVolume);
  const usedBytes = bytes(payload.obj.dataUsage ?? payload.obj.orderUsage);
  if (totalBytes == null || usedBytes == null) throw new EsimAccessError('Support usage response did not include traffic values.', { code:'SUPPORT_USAGE_VALUES_MISSING' });
  return {
    usedBytes:Math.max(0, usedBytes),
    totalBytes:Math.max(0, totalBytes),
    remainingBytes:Math.max(0, totalBytes - usedBytes),
    iccid:payload.obj.iccid || null,
    expiredTime:payload.obj.expiredTime || null,
    totalDuration:payload.obj.totalDuration ?? null,
    dataType:payload.obj.dataType ?? null,
    lastUpdateTime:new Date().toISOString(),
  };
}
module.exports = { provisionEsim, checkUsage, checkSupportLinkUsage, recoverEsim, recoverEsimByOrderNo, topupEsim, listPackages, findRenewalTopup, cancelEsim, revokeEsim, suspendEsim, unsuspendEsim, listAllocatedEsims, listOwnedProfiles, manageProfile, profileToEsim };
