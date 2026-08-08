// services/esimService.js
//
// Інтеграція з eSIM Access (docs.esimaccess.com).
// Авторизація: заголовок "RT-AccessCode" з твоїм ключем у кожному запиті.
//
// Структура запиту "Order Profiles" ПЕРЕВІРЕНА напряму з офіційної
// документації (POST /api/v1/open/esim/order, тіло: transactionId +
// packageInfoList[{packageCode, count}], відповідь: obj.orderNo).
//
// ⚠️ Структура запиту "Query All Allocated Profiles" (де беремо ICCID
// і QR-код за orderNo) поки НЕ перевірена з живою документацією —
// шлях і назви полів нижче можуть відрізнятись. Звір їх так само,
// як звірили Order (docs.esimaccess.com -> API -> Query All Allocated
// Profiles -> подивись Example Request/Response).

require('dotenv').config();

const BASE_URL = process.env.ESIM_PROVIDER_API_URL || 'https://api.esimaccess.com';

// TODO: заміни на реальний packageCode з їхнього каталогу (крок 2 вище).
// Поки що це мапа "наш тариф -> код пакету в eSIM Access". Один "глобальний"
// packageCode на всі тарифи не завжди існує — можливо, доведеться замовляти
// кілька регіональних пакетів і показувати їх користувачу як один тариф.
const PACKAGE_CODE_MAP = {
  basic: process.env.ESIM_PACKAGE_CODE_BASIC || 'REPLACE_ME_BASIC',
  standard: process.env.ESIM_PACKAGE_CODE_STANDARD || 'REPLACE_ME_STANDARD',
  unlimited: process.env.ESIM_PACKAGE_CODE_UNLIMITED || 'REPLACE_ME_UNLIMITED',
};

async function esimAccessRequest(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'RT-AccessCode': process.env.ESIM_PROVIDER_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || (data && data.success === false)) {
    throw new Error(`eSIM Access error: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function provisionEsim({ email, plan }) {
  const useMock = !process.env.ESIM_PROVIDER_API_KEY
    || process.env.ESIM_PROVIDER_API_KEY === 'your_access_code_here';

  if (useMock) {
    // ---- MOCK: видає фейковий, але реалістичний профіль ----
    console.log(`[esimService] MOCK-режим: видаю тестовий eSIM для ${email} (тариф: ${plan})`);
    return {
      status: 'active',
      iccid: '8944' + Math.floor(Math.random() * 1e15).toString().padStart(15, '0'),
      activationCode: `LPA:1$mock.esim-provider.com$${Buffer.from(email).toString('hex').slice(0, 24)}`,
      qrCodeUrl: null,
      dataLimitGb: plan === 'unlimited' ? null : plan === 'standard' ? 20 : 10,
      provider: 'mock-provider',
    };
  }

  const packageCode = PACKAGE_CODE_MAP[plan];
  if (!packageCode || packageCode.startsWith('REPLACE_ME')) {
    throw new Error(
      `Немає packageCode для тарифу "${plan}". Встав реальний код пакету з eSIM Access у .env (ESIM_PACKAGE_CODE_${plan.toUpperCase()}).`
    );
  }

  // Крок 1: розмістити замовлення
  const order = await esimAccessRequest('/api/v1/open/esim/order', {
    transactionId: `signal_${email}_${Date.now()}`.slice(0, 50),
    packageInfoList: [
      { packageCode, count: 1 },
    ],
  });

  if (!order.success) {
    throw new Error(`eSIM Access відхилив замовлення: ${order.errorMsg || JSON.stringify(order)}`);
  }
  const orderNo = order.obj?.orderNo;
  if (!orderNo) throw new Error(`eSIM Access не повернув orderNo: ${JSON.stringify(order)}`);

  // Крок 2: отримати виданий профіль (ICCID + активаційний код + QR) за номером замовлення
  const profile = await esimAccessRequest('/api/v1/open/esim/query', {
    orderNo,
    pager: { pageNum: 1, pageSize: 20 },
  });

  const esim = profile.obj?.esimList?.[0];
  if (!esim) throw new Error(`eSIM Access не повернув esimList для замовлення ${orderNo}: ${JSON.stringify(profile)}`);

  const volumeBytes = esim.packageList?.[0]?.volume;

  return {
    status: 'active',
    iccid: esim.iccid,
    activationCode: esim.ac, // рядок формату LPA:1$... — вводиться вручну або кодується в QR
    qrCodeUrl: esim.qrCodeUrl, // готове зображення QR-коду від eSIM Access
    dataLimitGb: volumeBytes ? Math.round(volumeBytes / 1e9) : (plan === 'unlimited' ? null : plan === 'standard' ? 20 : 10),
    provider: 'esim-access',
    orderNo,
  };
}

module.exports = { provisionEsim };
