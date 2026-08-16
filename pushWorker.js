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
        body: `Використано ${percent}% твого пакета даних.`,
        url: '/usage.html',
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
