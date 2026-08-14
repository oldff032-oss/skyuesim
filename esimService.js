```javascript
// services/esimService.js
//
// Інтеграція з eSIM Access.
// Після створення замовлення система автоматично чекає,
// поки eSIM Access видасть реальний eSIM-профіль.
//
// ВАЖЛИВО:
// - Stripe тут не використовується.
// - Гроші вже підтверджуються Stripe webhook.
// - Якщо eSIM Access відповідає 200010 / esimList порожній,
//   система не вважає замовлення остаточно проваленим.
// - Система повторно перевіряє orderNo, поки профіль не буде готовий.

require('dotenv').config();

const BASE_URL =
  process.env.ESIM_PROVIDER_API_URL || 'https://api.esimaccess.com';

const PACKAGE_CODE_MAP = {
  basic:
    process.env.ESIM_PACKAGE_CODE_BASIC || 'REPLACE_ME_BASIC',

  standard:
    process.env.ESIM_PACKAGE_CODE_STANDARD || 'REPLACE_ME_STANDARD',

  unlimited:
    process.env.ESIM_PACKAGE_CODE_UNLIMITED || 'REPLACE_ME_UNLIMITED',
};


// =========================================================
// Налаштування очікування eSIM
// =========================================================

// Скільки разів перевіряємо готовність eSIM.
const ESIM_MAX_ATTEMPTS = Number(
  process.env.ESIM_MAX_ATTEMPTS || 12
);

// Інтервал між перевірками.
// 5000 = 5 секунд.
const ESIM_POLL_INTERVAL_MS = Number(
  process.env.ESIM_POLL_INTERVAL_MS || 5000
);


// =========================================================
// Допоміжна функція затримки
// =========================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// =========================================================
// Запит до eSIM Access
// =========================================================

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
    throw new Error(
      `eSIM Access error: ${response.status} ${JSON.stringify(data)}`
    );
  }

  return data;
}


// =========================================================
// Запит профілю за orderNo
// =========================================================

async function queryEsimProfile(orderNo) {
  console.log(
    `🔎 Перевіряємо готовність eSIM. orderNo=${orderNo}`
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

  const esimList = profile.obj?.esimList;

  if (!Array.isArray(esimList) || esimList.length === 0) {
    return null;
  }

  return esimList[0];
}


// =========================================================
// Очікування готовності eSIM
// =========================================================

async function waitForEsim(orderNo) {
  console.log(
    `⏳ Очікуємо видачу eSIM. orderNo=${orderNo}`
  );

  for (let attempt = 1; attempt <= ESIM_MAX_ATTEMPTS; attempt++) {
    console.log(
      `🔄 Перевірка eSIM ${attempt}/${ESIM_MAX_ATTEMPTS}`
    );

    try {
      const esim = await queryEsimProfile(orderNo);

      if (esim) {
        console.log(
          `✅ eSIM-профіль отримано. orderNo=${orderNo}, ICCID=${esim.iccid || 'N/A'}`
        );

        return esim;
      }

      console.log(
        `⏳ eSIM ще не готова. Наступна перевірка через ${ESIM_POLL_INTERVAL_MS / 1000} сек.`
      );
    } catch (err) {
      console.error(
        `⚠️ Помилка перевірки eSIM, спроба ${attempt}:`,
        err.message
      );

      // Не падаємо одразу.
      // Продовжуємо polling.
    }

    if (attempt < ESIM_MAX_ATTEMPTS) {
      await sleep(ESIM_POLL_INTERVAL_MS);
    }
  }

  throw new Error(
    `eSIM Access не видав eSIM-профіль протягом ${
      (ESIM_MAX_ATTEMPTS * ESIM_POLL_INTERVAL_MS) / 1000
    } секунд. orderNo=${orderNo}`
  );
}


// =========================================================
// Видача eSIM
// =========================================================

async function provisionEsim({ email, plan }) {

  const useMock =
    !process.env.ESIM_PROVIDER_API_KEY ||
    process.env.ESIM_PROVIDER_API_KEY === 'your_access_code_here';


  // =======================================================
  // MOCK
  // =======================================================

  if (useMock) {

    console.log(
      `[esimService] MOCK-режим: видаю тестовий eSIM для ${email} (тариф: ${plan})`
    );

    return {
      status: 'active',

      iccid:
        '8944' +
        Math.floor(Math.random() * 1e15)
          .toString()
          .padStart(15, '0'),

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

      apn: 'mock.apn',

      expiredTime:
        new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ).toISOString(),

      activateTime:
        new Date().toISOString(),
    };
  }


  // =======================================================
  // Перевірка packageCode
  // =======================================================

  const packageCode = PACKAGE_CODE_MAP[plan];

  if (
    !packageCode ||
    packageCode.startsWith('REPLACE_ME')
  ) {
    throw new Error(
      `Немає packageCode для тарифу "${plan}". ` +
      `Встав реальний код пакету з eSIM Access у .env ` +
      `(ESIM_PACKAGE_CODE_${plan.toUpperCase()}).`
    );
  }


  // =======================================================
  // КРОК 1 — створення замовлення
  // =======================================================

  const transactionId =
    `signal_${email}_${Date.now()}`.slice(0, 50);

  console.log('');
  console.log('========================================');
  console.log('📱 Створення замовлення eSIM');
  console.log(`Email: ${email}`);
  console.log(`Plan: ${plan}`);
  console.log(`Package code: ${packageCode}`);
  console.log(`Transaction ID: ${transactionId}`);
  console.log('========================================');


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


  if (!order.success) {
    throw new Error(
      `eSIM Access відхилив замовлення: ${
        order.errorMsg || JSON.stringify(order)
      }`
    );
  }


  const orderNo = order.obj?.orderNo;


  if (!orderNo) {
    throw new Error(
      `eSIM Access не повернув orderNo: ${JSON.stringify(order)}`
    );
  }


  console.log(
    `✅ Замовлення eSIM створено. orderNo=${orderNo}`
  );


  // =======================================================
  // КРОК 2 — ЧЕКАЄМО ГОТОВИЙ ПРОФІЛЬ
  // =======================================================

  const esim = await waitForEsim(orderNo);


  // =======================================================
  // КРОК 3 — отримуємо дані профілю
  // =======================================================

  const volumeBytes =
    esim.packageList?.[0]?.volume;


  const dataLimitGb =
    volumeBytes
      ? Math.round(volumeBytes / 1e9)
      : (
          plan === 'unlimited'
            ? null
            : plan === 'standard'
              ? 20
              : 10
        );


  const result = {
    status: 'active',

    iccid:
      esim.iccid || null,

    activationCode:
      esim.ac || esim.activationCode || null,

    qrCodeUrl:
      esim.qrCodeUrl || null,

    dataLimitGb,

    provider: 'esim-access',

    orderNo,

    apn:
      esim.apn || null,

    expiredTime:
      esim.expiredTime || null,

    activateTime:
      esim.activateTime || null,
  };


  console.log('');
  console.log('========================================');
  console.log('🎉 eSIM УСПІШНО ВИДАНО');
  console.log(`Order No: ${result.orderNo}`);
  console.log(`ICCID: ${result.iccid}`);
  console.log(`Activation code: ${result.activationCode ? 'YES' : 'NO'}`);
  console.log(`QR Code URL: ${result.qrCodeUrl ? 'YES' : 'NO'}`);
  console.log('========================================');
  console.log('');


  return result;
}


// =========================================================
// Оновлення використання трафіку
// =========================================================

async function checkUsage(orderNo) {

  const useMock =
    !process.env.ESIM_PROVIDER_API_KEY ||
    process.env.ESIM_PROVIDER_API_KEY === 'your_access_code_here';


  if (useMock) {
    return {
      usedBytes: 0,
      totalBytes: null,
    };
  }


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


  const esim =
    profile.obj?.esimList?.[0];


  if (!esim) {
    throw new Error(
      `Не вдалося оновити дані використання для замовлення ${orderNo}`
    );
  }


  return {
    usedBytes:
      esim.orderUsage || 0,

    totalBytes:
      esim.packageList?.[0]?.volume || null,

    esimStatus:
      esim.esimStatus,

    apn:
      esim.apn || null,

    expiredTime:
      esim.expiredTime || null,

    activateTime:
      esim.activateTime || null,
  };
}


module.exports = {
  provisionEsim,
  checkUsage,
};
```
