// services/emailService.js
//
// Надсилає код підтвердження на email. Реальна інтеграція — через Resend
// (resend.com), бо в них найпростіша реєстрація й щедрий безкоштовний
// рівень (100 листів/день). Якщо ключа ще немає в .env — код просто
// друкується в консоль сервера (MOCK-режим), щоб фронтенд і решта логіки
// вже працювали, поки не зареєструєшся в Resend.
//
// Щоб підключити реальну відправку:
//   1. Зареєструйся на resend.com (безкоштовно)
//   2. Підтверди домен АБО просто використай їхню тестову адресу
//      onboarding@resend.dev для перших тестів (працює без підтвердження
//      домену, але лист прийде тільки на email, яким ти зареєстрував(ла)
//      акаунт у Resend — обмеження їхнього безкоштовного тесту)
//   3. Скопіюй API key -> встав у .env як RESEND_API_KEY

require('dotenv').config();
const crypto = require('crypto');

async function sendVerificationCode(email, code) {
  const useMock = !process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here';

  if (useMock) {
    console.log(`\n📧 [emailService] MOCK-режим: лист не надсилається насправді.`);
    console.log(`   Код підтвердження для ${email}: ${code}\n`);
    return { mocked: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'Сигнал <onboarding@resend.dev>',
      to: [email],
      subject: 'Код підтвердження — Сигнал',
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
          <h2>Твій код підтвердження</h2>
          <p style="font-size: 32px; font-weight: 700; letter-spacing: 8px; background: #f2f4f8; padding: 16px; border-radius: 12px; text-align: center;">${code}</p>
          <p style="color: #7c879c; font-size: 13px;">Код дійсний 10 хвилин. Якщо ти не запитував(ла) цей код — просто ігноруй лист.</p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend error: ${response.status} ${errText}`);
  }

  return await response.json();
}

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 'your_resend_api_key_here');
}

module.exports = { sendVerificationCode, sendEmail, getReceivedEmail, verifyInboundSignature, isEmailConfigured };

// ---- Вхідна пошта (реальні відповіді користувачів на тікети) ----
// Resend спочатку шле вебхук лише з метаданими — повний текст листа
// треба забрати окремим запитом до їхнього Receiving API.
async function getReceivedEmail(emailId) {
  const response = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Не вдалося отримати вміст листа: ${response.status}`);
  return await response.json();
}

// Перевіряє, що вебхук справді прийшов від Resend (формат Svix: заголовки
// svix-id/svix-timestamp/svix-signature, секрет виду whsec_...).
function verifyInboundSignature(rawBody, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) throw new Error('RESEND_WEBHOOK_SECRET не встановлено');

  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];
  if (!svixId || !svixTimestamp || !svixSignature) throw new Error('Відсутні заголовки підпису');

  // Захист від застарілих запитів (більше 5 хвилин)
  const age = Math.abs(Date.now() / 1000 - Number(svixTimestamp));
  if (age > 5 * 60) throw new Error('Timestamp outside tolerance');

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  const validSignatures = svixSignature.split(' ').map(s => s.split(',')[1]);
  if (!validSignatures.includes(expected)) throw new Error('Невірний підпис вебхука');

  return true;
}

// Універсальна відправка листа — використовується і для коду підтвердження,
// і для відповідей підтримки на тікети.
async function sendEmail({ to, subject, html, replyTo }) {
  const useMock = !process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 'your_resend_api_key_here';

  if (useMock) {
    console.log(`\n📧 [emailService] MOCK-режим: лист "${subject}" для ${to} не надіслано насправді.\n`);
    return { mocked: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'Сигнал <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
      ...(replyTo && { reply_to: replyTo }),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Resend error: ${response.status} ${errText}`);
  }
  return await response.json();
}
