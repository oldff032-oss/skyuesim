const storage = require('./persistentState');
let users = {};

async function bootstrap() { users = await storage.load('users.json', {}); }
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
function deleteUser(email) { if (!users[email]) return false; delete users[email]; storage.save('users.json', users); return true; }

module.exports = { bootstrap, getUser, saveUser, deleteUser, getUserByStripeCustomerId, getAllUsers };

