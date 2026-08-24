# Поповнення фізичних SIM через DT One

Код не містить і не повинен містити API-ключів. Усі секрети додаються тільки в **Render → Environment** для backend-сервісу.

## 1. Підготувати партнерський акаунт

1. Створити бізнес-акаунт DT One / DT Shop.
2. Попросити додати до вашого price list продукти `Mobile` з benefit type `DATA`.
3. Створити окремі ключі для pre-production та production.
4. Перевірити валюту партнерського гаманця й поповнити тестовий баланс.

## 2. Тестове середовище Render

Додайте такі Environment Variables:

```text
MOBILE_TOPUP_PROVIDER=dtone
DTONE_ENV=preprod
DTONE_API_KEY=<pre-production API key>
DTONE_API_SECRET=<pre-production API secret>
MOBILE_TOPUP_MARKUP_PERCENT=18
MOBILE_TOPUP_FIXED_MARKUP=0.50
MOBILE_TOPUP_MIN_MARKUP=0.50
```

Не додавайте `.env` до Git, ZIP або Netlify. `DTONE_API_SECRET` має існувати лише на Render.

## 3. Перевірка перед production

1. Увійти в Signal тестовим користувачем.
2. Відкрити **Поповнити звичайну SIM**.
3. Перевірити завантаження країн, операторів та data-пакетів.
4. Виконати Stripe test payment.
5. Переконатися, що замовлення з'явилося в **Admin → Поповнення SIM**.
6. Перевірити статус DT One і те, що номер не зберігається в Stripe metadata.
7. Перевірити retry під Super Admin із підтвердженою 2FA.
8. Перевірити refund через існуючий платіжний інструмент адмінки, якщо партнер відхилив зарахування.

## 4. Перехід у production

Після завершення договору й тестів замініть лише серверні значення:

```text
DTONE_ENV=production
DTONE_API_KEY=<production API key>
DTONE_API_SECRET=<production API secret>
```

У Stripe повинні залишатися налаштованими робочий webhook та `STRIPE_SECRET_KEY`. До появи коректних DT One ключів backend блокує Checkout: користувача не можна випадково списати без можливості доставити пакет.

## Безпечна модель

- Ціна та продукт повторно завантажуються з DT One на backend перед створенням Stripe Checkout.
- Frontend надсилає лише `productId` і номер, а не суму.
- Повний номер зберігається у захищеному записі користувача й не передається в Stripe metadata.
- Пакет відправляється оператору лише після підписаного Stripe webhook зі статусом `paid`.
- Повторні webhook не створюють повторної видачі.
- Проміжні транзакції перевіряються фоновою чергою.
