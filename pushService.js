const webpush = require('web-push');
const pushStore = require('./pushStore');

function isConfigured() {
  return Boolean(process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function configure() {
  if (!isConfigured()) throw new Error('Push ще не налаштовано: додай VAPID ключі у Render Environment');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function sendToEmail(email, notification) {
  configure();
  const payload = JSON.stringify({
    title: notification.title || 'Сигнал',
    body: notification.body || '',
    url: notification.url || '/dashboard.html',
    tag: notification.tag || 'signal-update',
  });
  const subscriptions = pushStore.subscriptionsFor(email);
  const results = await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 * 60, urgency: 'normal', topic: notification.tag || 'signal-update' });
      return true;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) pushStore.removeSubscription(subscription.endpoint);
      throw error;
    }
  }));
  return results.filter((result) => result.status === 'fulfilled').length;
}

module.exports = { isConfigured, sendToEmail };

