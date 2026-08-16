// Customer-app translations. This intentionally runs only in the customer
// interface: admin pages remain in the team's working language.
(() => {
  const language = localStorage.getItem('signal_language') || 'uk';
  document.documentElement.lang = language;
  document.documentElement.dir = 'ltr';
  if (language !== 'en') {
    window.signalT = (uk) => uk;
    return;
  }

  const phrases = {
    'Сигнал': 'Signal', 'Головна': 'Home', 'Тариф': 'Plan', 'Тарифи': 'Plans', 'Витрати': 'Usage', 'Профіль': 'Profile', 'Підтримка': 'Support',
    'Інтернет без кордонів': 'Internet without borders', 'Інтернет\nбез кордонів': 'Internet\nwithout borders', 'Інтернет': 'Internet', 'без кордонів': 'without borders',
    'Створити акаунт': 'Create account', 'Увійти': 'Log in', 'Вийти': 'Log out', 'Вийти з акаунта': 'Log out', 'Продовжити': 'Continue',
    'Назад': 'Back', 'Повернутись до входу': 'Back to login', 'Скасувати': 'Cancel', 'Зберегти': 'Save', 'Надіслати': 'Send',
    'Акаунт створено': 'Account created', 'Твій акаунт створено. Тепер оформи підписку і отримай доступ до інтернету по всій Європі.': 'Your account is ready. Choose a plan to get internet access across Europe.',
    'Обери тариф': 'Choose a plan', 'Обрати тариф': 'Choose a plan', 'Змінити тариф': 'Change plan', 'Оформити підписку': 'Subscribe',
    'Підписка щомісячна, діє у 30+ країнах Європи. Скасувати можна будь-коли в профілі.': 'Monthly subscription, available in 30+ European countries. Cancel anytime in your profile.',
    'Базовий': 'Basic', 'Стандарт': 'Standard', 'Безліміт': 'Unlimited', '10 ГБ / місяць': '10 GB / month', '20 ГБ / місяць': '20 GB / month', 'Необмежено': 'Unlimited', '/міс': '/month', 'Популярний': 'Popular',
    'Натискаючи «Оформити підписку», перейдеш на захищену сторінку оплати Stripe.': 'By choosing Subscribe, you will go to Stripe’s secure payment page.',
    'Привіт! 👋': 'Hello! 👋', 'У тебе ще немає активної підписки. Обери тариф, щоб отримати доступ до інтернету по всій Європі.': 'You do not have an active plan yet. Choose a plan to get internet access across Europe.',
    'Активовано': 'Activated', 'Активна': 'Active', 'Заблоковано': 'Blocked', 'Підписку скасовано': 'Subscription cancelled', 'Очікуємо підтвердження оплати...': 'Waiting for payment confirmation...',
    'Використано': 'Used', 'Використано трафіку': 'Data used', 'Залишилось:': 'Remaining:', 'Термін дії eSIM завершився': 'Your eSIM has expired', 'Днів до закінчення eSIM': 'Days until eSIM expires',
    'Встановити eSIM': 'Install eSIM', 'Відкрити встановлення eSIM': 'Open eSIM installation', 'Скопіювати код eSIM': 'Copy eSIM code', 'Код активації для ручного встановлення:': 'Activation code for manual installation:',
    'Відскануй QR-код камерою телефону, щоб додати eSIM:': 'Scan the QR code with your phone camera to add the eSIM:', 'Або введи вручну (Налаштування → Стільниковий зв’язок → Додати eSIM вручну):': 'Or enter it manually (Settings → Cellular → Add eSIM manually):',
    'Керування eSIM': 'Manage eSIM', 'Повторне встановлення не створює нове замовлення і не списує кошти.': 'Reinstalling does not create a new order or charge you again.', 'Твоя eSIM': 'Your eSIM', 'QR-код тимчасово недоступний — використай код активації нижче.': 'The QR code is temporarily unavailable — use the activation code below.',
    'Як встановити': 'How to install', 'Відкрий налаштування мобільного зв’язку.': 'Open your cellular settings.', 'Обери «Додати eSIM».': 'Choose “Add eSIM”.', 'Відскануй QR-код або введи код вручну.': 'Scan the QR code or enter the code manually.', 'Після встановлення обери цю eSIM для мобільних даних.': 'After installation, select this eSIM for mobile data.',
    'Перевірка пристрою': 'Device check', 'Не всі телефони підтримують eSIM. Перевіримо твій, перш ніж переходити до оплати.': 'Not all phones support eSIM. Let’s check yours before payment.', 'Перевіряємо...': 'Checking...', 'Все одно продовжити': 'Continue anyway',
    'Готуємо eSIM': 'Preparing your eSIM', 'Це займає кілька секунд — не закривай сторінку.': 'This takes a few seconds — do not close this page.', 'Підтверджуємо оплату': 'Confirming payment', 'Замовляємо профіль eSIM': 'Ordering eSIM profile', 'Готуємо QR-код активації': 'Preparing activation QR code', 'Перейти в дашборд': 'Go to dashboard',
    'Оплату отримано': 'Payment received', 'Дякуємо! Твоя eSIM видається автоматично — це займає кілька секунд після підтвердження оплати від Stripe. Перейди в дашборд, щоб побачити статус і кнопку «Підключити».': 'Thank you! Your eSIM is issued automatically after Stripe confirms payment. Go to the dashboard to see its status.',
    'Витрати трафіку': 'Data usage', 'Скільки даних ти використав(ла) цього циклу': 'How much data you have used this cycle', 'Немає активної підписки.': 'No active subscription.', 'Змінити сповіщення': 'Change alerts', 'Прогноз з’явиться, коли назбирається трохи даних про використання.': 'A forecast will appear after enough usage data has been collected.', '⚠️ Використано понад 80% трафіку тарифу': '⚠️ More than 80% of your plan data has been used', 'Мережа:': 'Network:', 'Наступне списання': 'Next payment', 'Завантажуємо дату списання...': 'Loading renewal date...', 'Не вдалося завантажити дані': 'Could not load data',
    'Акаунт Сигнал': 'Signal account', 'Тариф і білінг': 'Plan and billing', 'Керування eSIM': 'Manage eSIM', 'Центр безпеки': 'Security center', 'Сповіщення про трафік': 'Data alerts', 'Мова / Language': 'Language', 'Українська': 'Ukrainian', 'Англійська': 'English',
    'AI Network Copilot': 'AI Network Copilot', 'скоро': 'coming soon', 'Підтримка': 'Support', 'Family / Team': 'Family / Team', 'Travel Mode': 'Travel Mode',
    'Центр\nбезпеки': 'Security\ncenter', 'Перевіряй, де твій акаунт зараз відкритий.': 'See where your account is currently signed in.', 'Твої входи': 'Your sign-ins', 'Поточний пристрій позначено окремо. Незнайомий вхід — привід одразу завершити інші сесії.': 'Your current device is marked separately. If you see an unfamiliar sign-in, end other sessions right away.', 'Вийти з інших пристроїв': 'Sign out of other devices', 'Змінити пароль': 'Change password', 'цей пристрій': 'this device',
    'Сповіщення про\nтрафік': 'Data\nalerts', 'Обери, коли застосунок має попередити, що пакет даних закінчується.': 'Choose when the app should warn you that your data package is running low.', 'Надсилати попередження': 'Send alerts', 'Використано 50%': '50% used', 'Використано 80%': '80% used', 'Використано 95%': '95% used', 'Push-сповіщення': 'Push notifications', 'Отримуй попередження, навіть коли застосунок закритий.': 'Get alerts even when the app is closed.', 'Увімкнути push-сповіщення': 'Enable push notifications', 'Надіслати тестове сповіщення': 'Send test notification', 'Коли push увімкнено, попередження надходять навіть із закритого застосунку. На iPhone встанов додаток на початковий екран перед увімкненням.': 'When push is enabled, alerts arrive even when the app is closed. On iPhone, add the app to your Home Screen first.',
    'Нове звернення': 'New request', 'Опиши проблему — ми відповімо на email': 'Describe the issue — we will reply by email.', 'Категорія': 'Category', 'eSIM не активується': 'eSIM will not activate', 'Немає інтернету': 'No internet connection', 'Оплата / пакет не активувався': 'Payment / plan was not activated', 'Питання про підписку': 'Subscription question', 'Інше': 'Other', 'Тема': 'Subject', 'Опис': 'Description', 'Скріншот або файл (необов’язково)': 'Screenshot or file (optional)', 'Максимум ~3МБ, зображення або PDF': 'Maximum ~3 MB, image or PDF', 'Надіслати звернення': 'Send request',
    'Твої звернення й нові запити': 'Your requests and new tickets', '+ Нове звернення': '+ New request', 'Звернень ще немає.': 'No requests yet.', 'Надіслати відповідь': 'Send reply', 'Напиши відповідь...': 'Write a reply...',
    'Забув(ла) пароль?': 'Forgot password?', 'Введи email — надішлемо код для відновлення': 'Enter your email — we will send a recovery code.', 'Надіслати код': 'Send code', 'Новий пароль': 'New password', 'Придумай новий надійний пароль': 'Create a strong new password', 'Мінімум 8 символів': 'At least 8 characters', 'Зберегти новий пароль': 'Save new password',
    'Введи код': 'Enter code', 'Ми надіслали код на': 'We sent a code to', 'Не прийшов код?': 'Did not receive a code?', 'Надіслати ще раз': 'Send again',
    'Звернення': 'Request', 'Технічні роботи': 'Maintenance', 'Спробуй ще раз пізніше.': 'Please try again later.', 'Помилка': 'Error', 'Готово': 'Done', 'Деталі': 'Details',
    'Email': 'Email', 'Пароль': 'Password', 'Введи пароль': 'Enter password', 'Пошук': 'Search', 'Завантаження...': 'Loading...'
    ,'Історія оплат': 'Payment history', 'Квитанції та статус твоїх платежів Stripe': 'Receipts and status of your Stripe payments', 'Квитанція': 'Receipt', 'Оплат ще немає.': 'No payments yet.'
    ,'Подорожі та інструменти': 'Travel and tools', 'Все важливе для поїздки та зв’язку': 'Everything important for travel and connectivity', 'Карта покриття та Travel Mode': 'Coverage map and Travel Mode', 'Діагностика інтернету': 'Internet diagnostics', 'Запросити друга': 'Invite a friend', 'Статус сервісу': 'Service status', 'Оцінити застосунок': 'Rate the app', 'Змінити тему': 'Change theme', 'Історія використання': 'Usage history'
    ,'Запустити перевірку': 'Run check', 'Поділитися': 'Share', 'Надіслати оцінку': 'Send rating', 'Усі сервіси працюють': 'All services are operational', 'Технічні роботи': 'Maintenance'
  };

  const translate = (value) => phrases[value.trim()] || value;
  const translateNode = (node) => {
    const before = node.nodeValue;
    const trimmed = before.trim();
    const after = phrases[trimmed];
    if (after) node.nodeValue = before.replace(trimmed, after);
  };
  const apply = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(translateNode);
    root.querySelectorAll?.('[placeholder],[title],[aria-label],[alt]').forEach((element) => ['placeholder','title','aria-label','alt'].forEach((attribute) => {
      if (element.hasAttribute(attribute)) element.setAttribute(attribute, translate(element.getAttribute(attribute)));
    }));
  };
  const start = () => {
    apply(document.body);
    document.title = translate(document.title);
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) translateNode(node);
      else if (node.nodeType === Node.ELEMENT_NODE) apply(node);
    }))).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.signalT = (uk, en) => en || phrases[uk] || uk;
})();
