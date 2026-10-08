// Run by Render Cron Job. It checks current eSIM usage and sends a push once
// for every selected threshold in the active data cycle.
require('dotenv').config();
const storage = require('./persistentState');
const { bootstrap: bootstrapUsers, getAllUsers, saveUser } = require('./db');
const pushStore = require('./pushStore');
const { checkUsage } = require('./esimService');
const { isConfigured, sendToEmail } = require('./pushService');
const { sendEmail, isEmailConfigured } = require('./emailService');
const emailTemplates = require('./emailTemplates');
const notificationPolicy = require('./notificationPolicyService');
const engagement = require('./engagementService');

function minutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function quietNow(preference, now = new Date()) {
  if (!preference.quietHours?.enabled) return false;
  const start = minutes(preference.quietHours.start), end = minutes(preference.quietHours.end);
  if (start == null || end == null || start === end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.REPORT_TIMEZONE || 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const current = Number(parts.find(item => item.type === 'hour')?.value) * 60 + Number(parts.find(item => item.type === 'minute')?.value);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

async function run() {
  await storage.init();
  await bootstrapUsers();
  await pushStore.bootstrap();

  for (const [email, user] of Object.entries(getAllUsers())) {
    if (user.status !== 'active' || !user.esim?.orderNo) continue;
    try {
      const assistant=notificationPolicy.smartAssistPreference(user);
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
        const due=assistant.expiryReminderDays.find(day=>daysLeft<=day&&daysLeft>=0&&!sent.includes(day));
        if(due&&assistant.enabled&&assistant.channels.push&&isConfigured()&&!quietNow(assistant)){await sendToEmail(email,{title:due===1?'Останній день пакета eSIM':'Пакет eSIM скоро завершиться',body:due===1?'Додай інтернет зараз, щоб не залишитися без зв’язку.':`До завершення залишилося близько ${daysLeft} днів.`,url:'/esim-topup.html',tag:`expiry-${expiryKey}-${due}`,actions:[{action:'topup',title:'Додати пакет'}]});sent.push(due);saveUser(email,{esim:{...user.esim,expiryAlerts:{key:expiryKey,days:sent}}});user.esim.expiryAlerts={key:expiryKey,days:sent};}
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
      const decision = notificationPolicy.evaluateTrafficAlert(user, { ...usage, totalBytes: total });
      if (!assistant.enabled) {
        saveUser(email, { trafficAlertState: notificationPolicy.rebaseTrafficAlertState(user, user.preferences?.trafficAlertThresholds) });
        continue;
      }
      if (decision.notification && decision.threshold < 100 && quietNow(assistant)) {
        console.log(`[push] ${email}: threshold ${decision.threshold}% deferred by quiet hours`);
      } else {
        let delivered = 0;
        if (decision.notification && assistant.channels.push && isConfigured()) {
          try { delivered = await sendToEmail(email, decision.notification); }
          catch (error) { console.error(`[push] ${email}: ${error.message}`); }
        }
        if (decision.notification && assistant.channels.email && isEmailConfigured()) {
          try { await sendEmail({to:email,subject:decision.notification.title,html:emailTemplates.notification({title:decision.notification.title,message:decision.notification.body,actionUrl:decision.notification.url,actionLabel:decision.threshold>=80?'Додати пакет':'Переглянути витрати'})}); }
          catch (error) { console.error(`[traffic email] ${email}: ${error.message}`); }
        }
        saveUser(email, { trafficAlertState: decision.state });
        if(decision.notification)console.log(`[push] ${email}: threshold ${decision.threshold}% (${delivered} devices)`);
      }

      const insights=engagement.usageInsights(user),forecastState=user.smartAssistForecastState?.cycleKey===notificationPolicy.cycleKey(user.esim)?user.smartAssistForecastState:{cycleKey:notificationPolicy.cycleKey(user.esim),sentForDays:[]};
      if(insights.projectedDaysLeft!=null&&insights.projectedDaysLeft<=assistant.forecastDays&&!forecastState.sentForDays.includes(assistant.forecastDays)&&!quietNow(assistant)){
        const notification={title:'Інтернету може не вистачити',body:`За поточного темпу пакета вистачить приблизно на ${insights.projectedDaysLeft} дн. Переглянь прогноз або підготуй наступний пакет.`,url:'/smart-assist.html',tag:`forecast-${forecastState.cycleKey}-${assistant.forecastDays}`,actions:[{action:'usage',title:'Переглянути'},{action:'topup',title:'Додати пакет'}]};
        if(assistant.channels.push&&isConfigured())await sendToEmail(email,notification).catch(error=>console.error(`[forecast push] ${email}: ${error.message}`));
        if(assistant.channels.email&&isEmailConfigured())await sendEmail({to:email,subject:notification.title,html:emailTemplates.notification({title:notification.title,message:notification.body,actionUrl:notification.url,actionLabel:'Відкрити Smart Assist'})}).catch(error=>console.error(`[forecast email] ${email}: ${error.message}`));
        forecastState.sentForDays.push(assistant.forecastDays);forecastState.lastSentAt=new Date().toISOString();saveUser(email,{smartAssistForecastState:forecastState});
      }
    } catch (error) {
      console.error(`[push] ${email}: ${error.message}`);
    }
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

