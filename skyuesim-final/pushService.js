const webpush = require('web-push');
const pushStore = require('./pushStore');
const operationsStore = require('./operationsStore');

function isConfigured() {
  return operationsStore.store().featureFlags?.push !== false && Boolean(process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function configure() {
  if (!isConfigured()) throw new Error('Push ще не налаштовано: додай VAPID ключі у Render Environment');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function sendToEmail(email, notification) {
  const delivery=operationsStore.recordDelivery({channel:'push',recipient:email,subject:notification.title||'Signal',status:'pending'});
  try{configure();}catch(error){operationsStore.updateDelivery(delivery.id,{status:'disabled',error:error.message});throw error;}
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
  const delivered=results.filter((result) => result.status === 'fulfilled').length;
  const failed=results.filter((result)=>result.status==='rejected');
  operationsStore.updateDelivery(delivery.id,{status:failed.length?(delivered?'partial':'failed'):'sent',error:failed[0]?.reason?.message||null,delivered,attempts:subscriptions.length||1});
  return delivered;
}

module.exports = { isConfigured, sendToEmail };
