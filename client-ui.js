(() => {
  const page = location.pathname.split('/').pop() || 'index.html';
  const language = localStorage.getItem('signal_language') === 'en' ? 'en' : 'uk';
  const sessionToken = localStorage.getItem('signal_session_token');
  const authPages = new Set([
    'index.html','welcome.html','login.html','register-email.html','verify-code.html',
    'set-password.html','forgot-password.html','reset-code.html','new-password.html',
    'account-created.html','access-recovery.html','access-recovery-complete.html','rescue-mode.html'
  ]);

  const labels = {
    'dashboard.html':['Головна','Home'],
    'profile.html':['Профіль','Profile'],
    'plans.html':['Тарифи','Plans'],
    'travel-plans.html':['Пакети для подорожей','Travel plans'],
    'usage.html':['Витрати трафіку','Data usage'],
    'traffic-alerts.html':['Сповіщення про трафік','Usage alerts'],
    'activity.html':['Історія активності','Activity history'],
    'savings.html':['Моя економія','My savings'],
    'smart-assist.html':['Розумний помічник','Smart assistant'],
    'esim-management.html':['Моя eSIM','My eSIM'],
    'esim-topup.html':['Додати пакет','Add a package'],
    'offline-esim.html':['Офлайн eSIM','Offline eSIM'],
    'payments.html':['Оплата й підписка','Payments'],
    'account-settings.html':['Акаунт і безпека','Account & security'],
    'security.html':['Захист застосунку','App security'],
    'notifications.html':['Сповіщення','Notifications'],
    'support.html':['Підтримка','Support'],
    'help.html':['Допомога','Help'],
    'app-guide.html':['Як користуватися Signal','How to use Signal'],
    'app-tools.html':['Допомога з підключенням','Connection help'],
    'new-ticket.html':['Нове звернення','New request'],
    'ticket.html':['Звернення до підтримки','Support request'],
    'feedback.html':['Відгук','Feedback'],
    'family-center.html':['Сімейний центр','Family center'],
    'family-esims.html':['eSIM для близьких','Family eSIMs'],
    'family-share.html':['Передача eSIM','Share eSIM'],
    'family-trip.html':['Сімейна подорож','Family trip'],
    'signal-universe.html':['Signal Universe','Signal Universe'],
    'signal-club.html':['Signal Club','Signal Club'],
    'signal-passport.html':['Signal Passport','Signal Passport'],
    'travel-assistant.html':['Моя подорож','My trip'],
    'mobile-topup.html':['Поповнення номера','Mobile top-up'],
    'wallet-pass.html':['Travel Pass','Travel Pass'],
    'device-check.html':['Перевірка пристрою','Device check'],
    'installing.html':['Встановлення eSIM','Installing eSIM'],
    'language.html':['Мова та вигляд','Language & appearance'],
    'success.html':['Готово','Success']
  };

  const parents = {
    'travel-plans.html':'plans.html','esim-topup.html':'esim-management.html','mobile-topup.html':'plans.html',
    'traffic-alerts.html':'usage.html','activity.html':'usage.html','savings.html':'usage.html','smart-assist.html':'usage.html',
    'esim-management.html':'profile.html','offline-esim.html':'esim-management.html','payments.html':'profile.html',
    'account-settings.html':'profile.html','security.html':'account-settings.html','notifications.html':'profile.html',
    'support.html':'profile.html','help.html':'support.html','app-guide.html':'profile.html','app-tools.html':'support.html',
    'new-ticket.html':'support.html','ticket.html':'support.html','feedback.html':'support.html',
    'family-center.html':'profile.html','family-esims.html':'family-center.html','family-share.html':'family-esims.html',
    'family-trip.html':'family-center.html','signal-universe.html':'profile.html','signal-club.html':'signal-universe.html',
    'signal-passport.html':'signal-universe.html','travel-assistant.html':'profile.html','wallet-pass.html':'profile.html',
    'device-check.html':'app-tools.html','installing.html':'esim-management.html','language.html':'profile.html','success.html':'dashboard.html'
  };

  const primaryPages = new Set(['dashboard.html','plans.html','usage.html','profile.html']);
  const widePages = new Set(['travel-plans.html']);
  const icon = {
    back:'<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
    bell:'<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>'
  };

  function titleForCurrentPage() {
    const value = labels[page];
    if (value) return value[language === 'en' ? 1 : 0];
    return document.title.split(/[—|]/)[0].trim() || 'Signal';
  }

  function mountShell() {
    if (!document.body || page.startsWith('admin-') || authPages.has(page) || !sessionToken) return;
    document.documentElement.classList.add('signal-v4-root');
    document.body.classList.add('signal-v4-app', `signal-v4-${page.replace('.html','')}`);
    if (widePages.has(page)) document.body.classList.add('signal-v4-wide');

    document.querySelectorAll('.bottomnav').forEach((nav, index) => { if (index) nav.remove(); });
    if (!document.querySelector('.signal-v4-bar')) {
      const back = primaryPages.has(page)
        ? '<span class="signal-v4-bar-spacer" aria-hidden="true"></span>'
        : `<a class="signal-v4-bar-action signal-v4-back" href="${parents[page] || 'profile.html'}" aria-label="${language === 'en' ? 'Back' : 'Назад'}">${icon.back}</a>`;
      document.body.insertAdjacentHTML('afterbegin', `<header class="signal-v4-bar">${back}<a class="signal-v4-brand" href="dashboard.html"><img src="signal-premium-logo.png" alt=""><span><small>Signal eSIM</small><b>${titleForCurrentPage()}</b></span></a><a class="signal-v4-bar-action signal-v4-bell" href="notifications.html" aria-label="${language === 'en' ? 'Notifications' : 'Сповіщення'}">${icon.bell}<span class="signal-v4-badge" hidden></span></a></header>`);
    }

    document.querySelectorAll('main,.wrap,.xp-wrap').forEach(root => root.classList.add('signal-v4-content'));
    requestAnimationFrame(() => document.body.classList.add('signal-v4-ready'));
    refreshUnread();
  }

  async function refreshUnread() {
    const badge = document.querySelector('.signal-v4-badge');
    if (!badge || typeof API_URL === 'undefined') return;
    try {
      const response = await fetch(`${API_URL}/api/account/notifications`, {
        cache:'no-store', headers:{'x-session-token':sessionToken}
      });
      if (!response.ok) return;
      const data = await response.json();
      const unread = Math.max(0, Number(data.unread || 0));
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.closest('.signal-v4-bell')?.classList.toggle('has-unread', unread > 0);
    } catch {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountShell, { once:true });
  else mountShell();
  window.addEventListener('focus', refreshUnread);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUnread(); });
})();
