// Run by Render Cron Job. It checks current eSIM usage and sends a push once
// for every selected threshold in the active data cycle.
require('dotenv').config();
const storage = require('./persistentState');
const { bootstrap: bootstrapUsers, getAllUsers, saveUser } = require('./db');
const pushStore = require('./pushStore');
const { checkUsage } = require('./esimService');
const { isConfigured, sendToEmail } = require('./pushService');

async function run() {
  await storage.init();
  await bootstrapUsers();
  await pushStore.bootstrap();
  if (!isConfigured()) throw new Error('VAPID ключі не задані');

  for (const [email, user] of Object.entries(getAllUsers())) {
    if (user.status !== 'active' || !user.esim?.orderNo) continue;
    try {
      const trip=user.travelMode;
      if(trip?.enabled&&trip.startDate){
        const startAt=new Date(`${trip.startDate}T00:00:00Z`).getTime(),hoursUntil=(startAt-Date.now())/3600000,reminders={...(trip.reminders||{})};
        if(hoursUntil>=24&&hoursUntil<=72&&!reminders.prepare){
          await sendToEmail(email,{title:`Подорож до ${trip.destination} наближається`,body:'Перевір сумісність телефона, збережи eSIM офлайн і підготуй встановлення.',url:'/travel-assistant.html',tag:`trip-prepare-${trip.startDate}`});
          reminders.prepare=new Date().toISOString();
        }
        if(hoursUntil>=0&&hoursUntil<24&&!reminders.departure){
          await sendToEmail(email,{title:'Signal готовий до подорожі',body:'Перед виїздом встанови eSIM. Після прибуття увімкни мобільні дані та роумінг даних.',url:'/travel-assistant.html',tag:`trip-departure-${trip.startDate}`});
          reminders.departure=new Date().toISOString();
        }
        if(Object.keys(reminders).length!==Object.keys(trip.reminders||{}).length){saveUser(email,{travelMode:{...trip,reminders}});user.travelMode={...trip,reminders};}
      }
      if(user.esim.expiredTime){
        const expiryAt=new Date(user.esim.expiredTime).getTime(),daysLeft=Math.ceil((expiryAt-Date.now())/86400000),expiryKey=String(user.esim.expiredTime).slice(0,10),sent=user.esim.expiryAlerts?.key===expiryKey?[...(user.esim.expiryAlerts.days||[])]:[];
        const due=[3,1].find(day=>daysLeft<=day&&daysLeft>=0&&!sent.includes(day));
        if(due){await sendToEmail(email,{title:due===1?'Останній день пакета eSIM':'Пакет eSIM скоро завершиться',body:due===1?'Додай інтернет зараз, щоб не залишитися без зв’язку.':`До завершення залишилося близько ${daysLeft} днів.`,url:'/esim-topup.html',tag:`expiry-${expiryKey}-${due}`});sent.push(due);saveUser(email,{esim:{...user.esim,expiryAlerts:{key:expiryKey,days:sent}}});user.esim.expiryAlerts={key:expiryKey,days:sent};}
      }
      // A profile issued over a day ago but not activated often means the
      // customer needs installation instructions, not a new eSIM purchase.
      const issuedAt = new Date(user.esim.createdAt || user.createdAt || 0).getTime();
      if (!user.esim.activateTime && issuedAt && Date.now() - issuedAt > 24 * 3600000 && !user.esim.installReminderSentAt) {
        await sendToEmail(email, { title: 'Встанови свою eSIM', body: 'Твоя eSIM готова. Відкрий Керування eSIM для QR-коду та інструкції.', url: '/esim-management.html', tag: 'esim-install-reminder' });
        saveUser(email, { esim: { ...user.esim, installReminderSentAt: new Date().toISOString() } });
        user.esim.installReminderSentAt = new Date().toISOString();
      }
      const usage = await checkUsage(user.esim.orderNo);
      const total = usage.totalBytes || Math.round((user.esim.dataLimitGb || 0) * 1024 ** 3);
      if (!total) continue;
      const percent = Math.min(100, Math.floor((usage.usedBytes / total) * 100));
      const thresholds = (user.preferences?.trafficAlertThresholds || [50, 80, 95]).slice().sort((a, b) => a - b);
      const reached = thresholds.filter((threshold) => percent >= threshold).pop() || null;
      const previous = user.esim.lastPushAlertThreshold || null;
      if (!reached) {
        if (previous) saveUser(email, { esim: { ...user.esim, lastPushAlertThreshold: null } });
        continue;
      }
      if (previous === reached || previous > reached) continue;
      const delivered = await sendToEmail(email, {
        title: 'Сигнал: трафік закінчується',
        body: `Використано ${percent}% твого пакета даних. Додай інтернет, щоб залишатися онлайн.`,
        url: '/esim-topup.html',
        tag: `traffic-${reached}`,
      });
      saveUser(email, { esim: { ...user.esim, lastPushAlertThreshold: reached } });
      console.log(`[push] ${email}: threshold ${reached}% (${delivered} devices)`);
    } catch (error) {
      console.error(`[push] ${email}: ${error.message}`);
    }
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

