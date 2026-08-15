const storage = require('./persistentState');
const crypto = require('crypto');
let users = {};

async function bootstrap() {
  users = await storage.load('users.json', {});
  Object.keys(users).forEach(ensureSignalId);
}
function getUser(email) { return users[email] || null; }
function saveUser(email, userData) {
  users[email] = { ...(users[email] || {}), ...userData, updatedAt: new Date().toISOString() };
  storage.save('users.json', users);
  return users[email];
}
function getUserByStripeCustomerId(customerId) {
  return Object.values(users).find(user => user.stripeCustomerId === customerId) || null;
}
function getAllUsers() { return users; }

function ensureSignalId(email) {
  const user = users[email];
  if (!user) return null;
  if (user.signalId) return user.signalId;
  let signalId;
  do {
    signalId = `signal-${crypto.randomBytes(4).toString('hex')}`;
  } while (Object.values(users).some(item => item.signalId === signalId));
  saveUser(email, { signalId });
  return signalId;
}

function getUserBySignalId(signalId) {
  const normalized = String(signalId || '').trim().toLowerCase();
  return Object.values(users).find(user => String(user.signalId || '').toLowerCase() === normalized) || null;
}

module.exports = { bootstrap, getUser, saveUser, getUserByStripeCustomerId, getAllUsers, ensureSignalId, getUserBySignalId };
