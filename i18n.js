// Customer-app translations. This intentionally runs only in the customer
// interface: admin pages remain in the team's working language.
(() => {
  const supportedLanguages = ['uk', 'en'];
  const savedLanguage = localStorage.getItem('signal_language');
  const language = supportedLanguages.includes(savedLanguage) ? savedLanguage : 'uk';
  if (savedLanguage !== language) localStorage.setItem('signal_language', language);
  document.documentElement.lang = language;
  document.documentElement.dir = 'ltr';

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
    ,'Код запрошення': 'Invitation code', 'Код запрошення прийнято': 'Invitation code accepted', 'Винагорода буде нарахована протягом 12–24 годин.': 'Your reward will be credited within 12–24 hours.'
    ,'Мова застосунку': 'App language', 'Обери мову': 'Choose your language', 'Цією мовою відображатиметься весь застосунок': 'The entire app will be displayed in this language', 'Продовжити українською': 'Continue in Ukrainian', 'Заповни дані — це займе менше хвилини': 'Enter your details — it takes less than a minute', '← Змінити мову': '← Change language', 'Обери мову для всіх екранів і повідомлень': 'Choose the language for every screen and notification', 'Мову збережено': 'Language saved', 'Зберігаємо мову…': 'Saving language…', 'Не вдалося зберегти. Перевір з’єднання.': 'Could not save. Check your connection.'
    ,'Ім’я': 'Name', 'Як до тебе звертатися': 'How should we address you?', 'Фото профілю': 'Profile photo', '(необов’язково)': '(optional)', 'PNG, JPG або WebP до 500 КБ': 'PNG, JPG or WebP up to 500 KB', 'Наприклад: A1B2C3D4': 'For example: A1B2C3D4', 'Вже маєш акаунт?': 'Already have an account?', 'Введи коректний email': 'Enter a valid email', 'Введи ім’я': 'Enter your name', 'Надсилаємо код...': 'Sending code…', 'Помилка сервера': 'Server error', 'Фото має бути PNG, JPG або WebP до 500 КБ': 'Photo must be PNG, JPG or WebP up to 500 KB', 'Не вдалося прочитати фото': 'Could not read the photo'
    ,'Немає доступу до email?': 'No access to your email?', 'Старий email акаунта': 'Previous account email', 'Email, до якого зараз є доступ': 'Email you can currently access', 'Сюди прийде безпечне посилання': 'The secure link will be sent here', 'ICCID або UID eSIM': 'eSIM ICCID or UID', 'Необов’язково, якщо знаєш': 'Optional, if known', 'Не знаєш номер — залиш поле порожнім.': 'If you do not know it, leave this field empty.', 'Що пам’ятаєш про останню покупку?': 'What do you remember about your latest purchase?', 'Що сталося?': 'What happened?', 'Надіслати запит': 'Send request', 'Нові дані входу': 'New sign-in details', 'Новий email': 'New email', 'Новий PIN': 'New PIN', '6 цифр': '6 digits', 'Зберегти та увійти': 'Save and sign in'
    ,'Підтримка працює': 'Support is available', 'Ваш email': 'Your email', 'Опишіть проблему': 'Describe the issue', 'Надіслати в підтримку': 'Send to support', 'Перевірити стан сервісу': 'Check service status', 'Звернення надіслано': 'Request sent', 'Проблема під час технічних робіт': 'Issue during maintenance', 'Що сталося та якої допомоги ви потребуєте?': 'What happened and what help do you need?', 'Не надсилайте пароль, PIN, банківські дані, QR-код або код активації eSIM.': 'Do not send your password, PIN, banking details, QR code, or eSIM activation code.'
    ,'Більше пакетів для подорожей': 'More travel packages', 'Країни, регіони, 1–50+ ГБ та різні терміни': 'Countries, regions, 1–50+ GB and flexible durations', 'Місячні тарифи': 'Monthly plans', 'Пакети для подорожей': 'Travel packages', 'Актуальні країни й регіони безпосередньо з каталогу eSIM Access.': 'Current countries and regions directly from the eSIM Access catalogue.', 'Країна, регіон або назва...': 'Country, region, or package name…', 'Усі країни та регіони': 'All countries and regions', 'Будь-який обсяг': 'Any data allowance', 'Будь-який термін': 'Any duration', 'Ціна остаточна у USD. Пакет не поновлюється автоматично. Якщо eSIM вже активна, ти зможеш безпечно змінити тариф зараз або після завершення поточного.': 'The displayed USD price is final. The package does not renew automatically. If an eSIM is already active, you can safely change the plan now or after the current one expires.'
    ,'QR-код прибрано з головного екрана': 'The QR code was removed from the home screen', 'З міркувань безпеки п’ять хвилин минули. Відкрити знову:': 'For security, the five-minute display period has ended. Open it again in:', 'Активовано': 'Activated', 'Дані оновлюються провайдером протягом кількох годин.': 'Data is refreshed by the provider within a few hours.', 'Безлімітний інтернет': 'Unlimited internet', 'Змінити тариф': 'Change plan', 'Оновити дані оператора': 'Refresh carrier data', 'Точки зберігаються після оновлення даних у застосунку.': 'Data points are saved after refreshing usage in the app.', 'Прогноз з’явиться, коли назбирається трохи даних про використання.': 'A forecast will appear after enough usage data has been collected.'
    ,'Налаштування акаунта': 'Account settings', 'Керуй своїми персональними даними та входом.': 'Manage your personal details and sign-in.', 'PIN-код застосунку': 'App PIN', '6 цифр для захисту при кожному відкритті.': 'Six digits that protect the app when it opens.', 'Новий PIN із 6 цифр': 'New 6-digit PIN', 'Зберегти PIN': 'Save PIN', 'Змінити фото': 'Change photo', 'Прибрати фото': 'Remove photo', 'Щоб змінити email або пароль, введи поточний пароль нижче.': 'To change your email or password, enter your current password below.', 'Зміна пароля': 'Change password', 'Новий пароль': 'New password', 'Щонайменше 8 символів': 'At least 8 characters', 'Поточний пароль': 'Current password', 'Потрібен для email або нового пароля': 'Required to change email or password', 'Зберегти зміни': 'Save changes', 'Зберігаємо…': 'Saving…', 'Зміни збережено': 'Changes saved'
    ,'Центр підтримки': 'Support center', 'Ми допоможемо з eSIM, оплатою або тарифом.': 'We can help with your eSIM, payment, or plan.', '+ Створити звернення': '+ Create request', 'Звернень поки немає': 'No requests yet', 'Створіть нове звернення — воно одразу з’явиться тут.': 'Create a new request and it will appear here immediately.'
    ,'Твоя eSIM': 'Your eSIM', 'Активна': 'Active', 'Код активації для ручного встановлення:': 'Activation code for manual installation:', 'Скопіювати код eSIM': 'Copy eSIM code', 'Повторне встановлення не створює нове замовлення і не списує кошти.': 'Reinstalling does not create a new order or charge you again.'
  };

  const translateDynamic = (value) => {
    if (language !== 'en') return value;
    let result = String(value || '');
    const replacements = [
      [/^Привіт,\s*(.+)\s*👋$/u, 'Hello, $1 👋'], [/^Статус:\s*/u, 'Status: '],
      [/^Залишилось:\s*/u, 'Remaining: '], [/^Використано\s+/u, 'Used '], [/^Дані оновлено:\s*/u, 'Data updated: '],
      [/^Точне значення провайдера:\s*/u, 'Exact provider value: '], [/\sбайт використано/u, ' bytes used'], [/\sіз\s([\d\s,.]+)\sбайт/u, ' of $1 bytes'],
      [/^Мережа:\s*/u, 'Network: '], [/^Профіль → Керування eSIM$/u, 'Profile → Manage eSIM'],
      [/^Днів до закінчення eSIM$/u, 'Days until eSIM expires'], [/^Історія використання$/u, 'Usage history'],
      [/^Наступне списання$/u, 'Next billing date'], [/^Використано трафіку$/u, 'Data used'],
      [/^Трафік$/u, 'Data'], [/^Деталі використання$/u, 'Usage details'],
      [/^Базовий/u, 'Basic'], [/^Стандарт/u, 'Standard'], [/^Безліміт/u, 'Unlimited'],
      [/\bГБ\b/gu, 'GB'], [/\bМБ\b/gu, 'MB'], [/\bКБ\b/gu, 'KB'], [/\bдн\./gu, 'days'], [/\/день/gu, '/day']
    ];
    for (const [pattern, replacement] of replacements) result = result.replace(pattern, replacement);
    return result;
  };
  const translate = (value) => {
    if (language !== 'en') return value;
    const text = String(value || '');
    const trimmed = text.trim();
    return phrases[trimmed] || translateDynamic(text);
  };
  const translateNode = (node) => {
    if (['SCRIPT','STYLE','NOSCRIPT'].includes(node.parentElement?.tagName)) return;
    const before = node.nodeValue;
    const trimmed = before.trim();
    const after = language === 'en' ? (phrases[trimmed] || translateDynamic(trimmed)) : null;
    if (after && after !== trimmed) node.nodeValue = before.replace(trimmed, after);
  };
  const apply = (root) => {
    if (root.nodeType === Node.ELEMENT_NODE && root.hasAttribute?.('data-i18n-uk')) {
      const value = language === 'en' ? root.dataset.i18nEn : root.dataset.i18nUk;
      if (value !== undefined) root.textContent = value;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(translateNode);
    root.querySelectorAll?.('[placeholder],[title],[aria-label],[alt],[data-i18n-uk]').forEach((element) => ['placeholder','title','aria-label','alt'].forEach((attribute) => {
      if (element.hasAttribute(attribute)) element.setAttribute(attribute, translate(element.getAttribute(attribute)));
    }));
    root.querySelectorAll?.('[data-i18n-uk]').forEach((element) => {
      const value = language === 'en' ? element.dataset.i18nEn : element.dataset.i18nUk;
      if (value !== undefined) element.textContent = value;
    });
    root.querySelectorAll?.('[data-i18n-placeholder-uk]').forEach((element) => {
      element.placeholder = language === 'en' ? element.dataset.i18nPlaceholderEn : element.dataset.i18nPlaceholderUk;
    });
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
  window.signalLanguage = language;
  window.signalT = (uk, en) => language === 'en' ? (en || phrases[uk] || uk) : uk;
  window.signalSetLanguage = async (nextLanguage, options = {}) => {
    if (!supportedLanguages.includes(nextLanguage)) throw new Error('Unsupported language');
    localStorage.setItem('signal_language', nextLanguage);
    const token = localStorage.getItem('signal_session_token');
    let synced = false;
    if (token && options.sync !== false && typeof API_URL !== 'undefined') {
      try {
        const response = await fetch(`${API_URL}/api/account/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-session-token': token },
          body: JSON.stringify({ language: nextLanguage })
        });
        synced = response.ok;
      } catch { synced = false; }
    }
    if (options.reload !== false) location.reload();
    return { language: nextLanguage, savedLocally: true, synced };
  };
  window.signalSyncLanguage = async () => {
    const token = localStorage.getItem('signal_session_token');
    if (!token || typeof API_URL === 'undefined') return language;
    try {
      const response = await fetch(`${API_URL}/api/account/preferences`, { headers: { 'x-session-token': token } });
      if (!response.ok) return language;
      const preferences = await response.json();
      if (supportedLanguages.includes(preferences.language) && preferences.language !== language) {
        localStorage.setItem('signal_language', preferences.language);
        location.reload();
      }
      return preferences.language || language;
    } catch { return language; }
  };

  if (language === 'en') {
    let remoteCache = {};
    try { remoteCache = JSON.parse(localStorage.getItem('signal_translation_cache_en') || '{}'); } catch {}
    let translationTimer = null;
    let remoteRequestInFlight = false;
    let nextRemoteAttemptAt = 0;
    const attemptedSources = new Map();
    const translateRemainingText = () => {
      clearTimeout(translationTimer);
      translationTimer = setTimeout(async () => {
        const token = localStorage.getItem('signal_session_token');
        if (!token || typeof API_URL === 'undefined' || remoteRequestInFlight || Date.now()<nextRemoteAttemptAt) return;
        const candidates = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (['SCRIPT','STYLE','NOSCRIPT'].includes(node.parentElement?.tagName) || node.parentElement?.closest('[data-no-auto-translate]')) continue;
          const source = node.nodeValue.trim();
          if (!/[А-ЯІЇЄҐа-яіїєґ]/u.test(source)) continue;
          if (remoteCache[source]) node.nodeValue = node.nodeValue.replace(source, remoteCache[source]);
          else if(Date.now()-(attemptedSources.get(source)||0)>10*60*1000)candidates.push({node,source});
        }
        const texts = [...new Set(candidates.map(item=>item.source))].slice(0,40);
        if (!texts.length) return;
        try {
          remoteRequestInFlight=true;texts.forEach(source=>attemptedSources.set(source,Date.now()));
          const response = await fetch(`${API_URL}/api/translations/batch`, {method:'POST',headers:{'Content-Type':'application/json','x-session-token':token},body:JSON.stringify({texts})});
          if (response.status===429){nextRemoteAttemptAt=Date.now()+2*60*1000;return;}
          if (!response.ok){nextRemoteAttemptAt=Date.now()+30*1000;return;}
          const result = await response.json();
          Object.assign(remoteCache,result.translations||{});
          localStorage.setItem('signal_translation_cache_en',JSON.stringify(Object.fromEntries(Object.entries(remoteCache).slice(-800))));
          candidates.forEach(({node,source})=>{if(remoteCache[source]&&node.isConnected)node.nodeValue=node.nodeValue.replace(source,remoteCache[source]);});
        } catch {nextRemoteAttemptAt=Date.now()+30*1000;} finally {remoteRequestInFlight=false;}
      }, 120);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',translateRemainingText);
    else translateRemainingText();
    new MutationObserver(translateRemainingText).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  }
})();
