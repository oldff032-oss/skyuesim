// auditStore.js
// Журнал дій адмінів: хто, що, коли зробив. Append-only (записи не редагуються).

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'audit-log.json');
const MAX_ENTRIES = 10000; // щоб файл не ріс нескінченно

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ entries: [] }, null, 2));
}

function readAll() {
  ensure();
  const raw = fs.readFileSync(FILE, 'utf-8').trim();
  return raw ? JSON.parse(raw) : { entries: [] };
}

function writeAll(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function log({ adminEmail, action, target, details }) {
  const store = readAll();
  store.entries.push({
    timestamp: new Date().toISOString(),
    adminEmail,
    action,
    target: target || null,
    details: details || null,
  });
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(-MAX_ENTRIES);
  }
  writeAll(store);
}

function getAll({ limit = 300 } = {}) {
  const store = readAll();
  return store.entries.slice(-limit).reverse();
}

module.exports = { log, getAll };
