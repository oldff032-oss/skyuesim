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

module.exports = { sendVerificationCode };
