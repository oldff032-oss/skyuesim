const storage = require('./persistentState');

let store = { subscriptions: {} };

async function bootstrap() {
  store = { subscriptions: {}, ...(await storage.load('push-subscriptions.json', store)) };
}

function subscriptionsFor(email) {
  return Object.values(store.subscriptions).filter((subscription) => subscription.email === email);
}

function saveSubscription(email, subscription) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('Некоректна підписка на сповіщення');
  }
  store.subscriptions[subscription.endpoint] = {
    email,
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    createdAt: new Date().toISOString(),
  };
  storage.save('push-subscriptions.json', store);
}

function removeSubscription(endpoint, email = null) {
  if (!endpoint || !store.subscriptions[endpoint]) return false;
  if (email && store.subscriptions[endpoint].email !== email) return false;
  delete store.subscriptions[endpoint];
  storage.save('push-subscriptions.json', store);
  return true;
}

module.exports = { bootstrap, subscriptionsFor, saveSubscription, removeSubscription };

