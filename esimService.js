// services/esimService.js
//
// Інтеграція з eSIM Access
// Документація: https://docs.esimaccess.com/
//
// Основний процес:
//
// 1. Створюємо замовлення
// 2. Отримуємо orderNo
// 3. Чекаємо, поки eSIM Access створить профіль
// 4. Запитуємо профіль повторно
// 5. Отримуємо ICCID + activation code + QR
// 6. Повертаємо готовий eSIM зі status: active

require('dotenv').config();

const BASE_URL = (
  process.env.ESIM_PROVIDER_API_URL || 'https://api.esimaccess.com'
).replace(/\/+$/, '');


// ------------------------------------------------------------
// Тарифи Signal → packageCode eSIM Access
// ------------------------------------------------------------

const PACKAGE_CODE_MAP = {
  basic: process.env.ESIM_PACKAGE_CODE_BASIC || 'REPLACE_ME_BASIC',
  standard: process.env.ESIM_PACKAGE_CODE_STANDARD || 'REPLACE_ME_STANDARD',
  unlimited: process.env.ESIM_PACKAGE_CODE_UNLIMITED || 'REPLACE_ME_UNLIMITED',
};


// ------------------------------------------------------------
// Допоміжна функція очікування
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ------------------------------------------------------------
// Запит до eSIM Access
// ------------------------------------------------------------

async function esimAccessRequest(path, body) {
  const apiKey = process.env.ESIM_PROVIDER_API_KEY;

  if (!apiKey) {
    throw new Error(
      'ESIM_PROVIDER_API_KEY не заданий у Environment Variables Render'
    );
  }

  const url = `${BASE_URL}${path}`;

  console.log(`[eSIM Access] POST ${url}`);
  console.log(`[eSIM Access] Body: ${JSON.stringify(body)}`);

  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'RT-AccessCode': apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Не вдалося підключитися до eSIM Access: ${err.message}`
    );
  }

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  console.log(
    `[eSIM Access] HTTP ${response.status}: ${text || '(порожня відповідь)'}`
  );

  if (!response.ok) {
    throw new Error(
      `eSIM Access HTTP ${response.status}: ${text || 'невідома помилка'}`
    );
  }

  if (data && data.success === false) {
    throw new Error(
      `eSIM Access error ${data.errorCode || ''}: ${
        data.errorMsg || JSON.stringify(data)
      }`
    );
  }

  return data;
}


// ------------------------------------------------------------
// Очікування готового eSIM-профілю
// ------------------------------------------------------------
//
// Після /order профіль може бути не готовий одразу.
// Тому не робимо один query, а перевіряємо декілька разів.
//
// 30 спроб × 2 секунди = приблизно 60 секунд очікування.
// ------------------------------------------------------------

async function waitForEsimProfile(orderNo) {
  const MAX_ATTEMPTS = 30;
  const DELAY_MS = 2000;

  console.log(
    `⏳ Очікуємо готовий eSIM-профіль. orderNo=${orderNo}`
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `[eSIM Access] Перевірка профілю ${attempt}/${MAX_ATTEMPTS}`
      );

      const profile = await esimAccessRequest(
        '/api/v1/open/esim/query',
        {
          orderNo,
          pager: {
            pageNum: 1,
            pageSize: 20,
          },
        }
      );

      const esimList = profile?.obj?.esimList;

      if (Array.isArray(esimList) && esimList.length > 0) {
        const esim = esimList[0];

        console.log(
          `✅ eSIM-профіль готовий. orderNo=${orderNo}, ICCID=${esim.iccid}`
        );

        return esim;
      }

      console.log(
        `⏳ Профіль ще не готовий. orderNo=${orderNo}`
      );
    } catch (err) {
      // Профіль може бути ще в процесі створення.
      // Не падаємо одразу — пробуємо ще раз.

      console.log(
        `⏳ eSIM ще не готовий: ${err.message}`
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(DELAY_MS);
    }
  }

  throw new Error(
    `eSIM Access не видав готовий профіль протягом ${
      (MAX_ATTEMPTS * DELAY_MS) / 1000
    } секунд. orderNo=${orderNo}`
  );
}


// ------------------------------------------------------------
// MOCK eSIM
// ------------------------------------------------------------
//
// Використовується тільки якщо немає реального API key.
// ------------------------------------------------------------

function createMockEsim({ email, plan }) {
  console.log(
    `[esimService] MOCK-режим: створюємо тестовий eSIM для ${email}, тариф=${plan}`
  );

  const randomPart = Math.floor(
    Math.random() * 1e15
  )
    .toString()
    .padStart(15, '0');

  return {
    status: 'active',

    iccid: `8944${randomPart}`,

    activationCode:
      `LPA:1$mock.esim-provider.com$${Buffer.from(email)
        .toString('hex')
        .slice(0, 24)}`,

    qrCodeUrl: null,

    dataLimitGb:
      plan === 'unlimited'
        ? null
        : plan === 'standard'
          ? 20
          : 10,

    provider: 'mock-provider',
  };
}


// ------------------------------------------------------------
// Основна функція видачі eSIM
// ------------------------------------------------------------

async function provisionEsim({ email, plan }) {
  if (!email) {
    throw new Error('Для створення eSIM не переданий email');
  }

  if (!plan) {
    throw new Error('Для створення eSIM не переданий тариф');
  }

  if (!PACKAGE_CODE_MAP[plan]) {
    throw new Error(`Невідомий тариф: ${plan}`);
  }


  // ----------------------------------------------------------
  // Перевіряємо API key
  // ----------------------------------------------------------

  const apiKey = process.env.ESIM_PROVIDER_API_KEY;

  const useMock =
    !apiKey ||
    apiKey === 'your_access_code_here';


  // ----------------------------------------------------------
  // MOCK
  // ----------------------------------------------------------

  if (useMock) {
    return createMockEsim({
      email,
      plan,
    });
  }


  // ----------------------------------------------------------
  // Реальний eSIM Access
  // ----------------------------------------------------------

  const packageCode = PACKAGE_CODE_MAP[plan];

  if (
    !packageCode ||
    packageCode.startsWith('REPLACE_ME')
  ) {
    throw new Error(
      `Немає реального packageCode для тарифу "${plan}". ` +
      `Додай у Render Environment Variable: ` +
      `ESIM_PACKAGE_CODE_${plan.toUpperCase()}`
    );
  }

  console.log(
    `🚀 Починаємо створення eSIM: email=${email}, plan=${plan}, packageCode=${packageCode}`
  );


  // ----------------------------------------------------------
  // 1. Створюємо замовлення
  // ----------------------------------------------------------

  const transactionId = (
    `signal_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`
  ).slice(0, 50);

  console.log(
    `📦 Створюємо замовлення eSIM. transactionId=${transactionId}`
  );

  const order = await esimAccessRequest(
    '/api/v1/open/esim/order',
    {
      transactionId,

      packageInfoList: [
        {
          packageCode,
          count: 1,
        },
      ],
    }
  );


  // ----------------------------------------------------------
  // 2. Перевіряємо відповідь
  // ----------------------------------------------------------

  if (!order) {
    throw new Error(
      'eSIM Access повернув порожню відповідь при створенні замовлення'
    );
  }

  if (order.success === false) {
    throw new Error(
      `eSIM Access відхилив замовлення: ${
        order.errorMsg || JSON.stringify(order)
      }`
    );
  }

  const orderNo = order?.obj?.orderNo;

  if (!orderNo) {
    throw new Error(
      `eSIM Access не повернув orderNo: ${JSON.stringify(order)}`
    );
  }

  console.log(
    `✅ Замовлення eSIM створено. orderNo=${orderNo}`
  );


  // ----------------------------------------------------------
  // 3. Чекаємо, поки eSIM Access видасть профіль
  // ----------------------------------------------------------

  const esim = await waitForEsimProfile(orderNo);


  // ----------------------------------------------------------
  // 4. Перевіряємо основні дані профілю
  // ----------------------------------------------------------

  if (!esim.iccid) {
    throw new Error(
      `eSIM Access повернув профіль без ICCID: ${JSON.stringify(esim)}`
    );
  }

  const activationCode =
    esim.ac ||
    esim.activationCode ||
    esim.activationCodeString ||
    null;

  const qrCodeUrl =
    esim.qrCodeUrl ||
    esim.qrCode ||
    null;


  // ----------------------------------------------------------
  // 5. Визначаємо обсяг даних
  // ----------------------------------------------------------

  const volumeBytes =
    esim.packageList?.[0]?.volume;

  let dataLimitGb;

  if (plan === 'unlimited') {
    dataLimitGb = null;
  } else if (volumeBytes) {
    dataLimitGb = Math.round(
      Number(volumeBytes) / 1e9
    );
  } else if (plan === 'standard') {
    dataLimitGb = 20;
  } else {
    dataLimitGb = 10;
  }


  // ----------------------------------------------------------
  // 6. Формуємо результат
  // ----------------------------------------------------------

  const result = {
    status: 'active',

    iccid: esim.iccid,

    activationCode,

    qrCodeUrl,

    dataLimitGb,

    provider: 'esim-access',

    orderNo,

    esimTranNo:
      esim.esimTranNo ||
      esim.esimTranNo,

    smdpStatus:
      esim.smdpStatus || null,

    esimStatus:
      esim.esimStatus || null,
  };


  console.log(
    `🎉 eSIM ГОТОВИЙ: ${JSON.stringify({
      status: result.status,
      iccid: result.iccid,
      orderNo: result.orderNo,
      hasActivationCode: !!result.activationCode,
      hasQrCode: !!result.qrCodeUrl,
      dataLimitGb: result.dataLimitGb,
    })}`
  );

  return result;
}


// ------------------------------------------------------------
// Export
// ------------------------------------------------------------

module.exports = {
  provisionEsim,
};
