const storage = require('./persistentState');
const MAX_ENTRIES = 10000;
let store = { entries: [] };

async function bootstrap() { store = { entries: [], ...(await storage.load('audit-log.json', store)) }; }
function writeAll(data) { store = data; storage.save('audit-log.json', store); }
function log({ adminEmail, action, target, details }) {
  store.entries.push({ timestamp: new Date().toISOString(), adminEmail, action, target: target || null, details: details || null });
  if (store.entries.length > MAX_ENTRIES) store.entries = store.entries.slice(-MAX_ENTRIES);
  writeAll(store);
}
function getAll({ limit = 300 } = {}) { return store.entries.slice(-limit).reverse(); }

module.exports = { bootstrap, log, getAll };

