// adminStore.js
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'admins.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ admins: {}, sessions: {} }, null, 2));
}

function readAll() {
  ensure();
  const raw = fs.readFileSync(FILE, 'utf-8').trim();
  return raw ? JSON.parse(raw) : { admins: {}, sessions: {} };
}

function writeAll(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

module.exports = { readAll, writeAll };
