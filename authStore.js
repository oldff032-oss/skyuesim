// authStore.js
//
// Файлове сховище для автентифікації: одноразові коди, токени верифікації,
// самі акаунти (з хешованим паролем) і сесії. Окремо від db.js (там —
// дані підписки/eSIM), щоб не плутати дві різні речі.
//
// Як і db.js — це просте рішення для старту. Для реального продукту з
// багатьма користувачами заміни на справжню БД.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'auth.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify({ codes: {}, verifyTokens: {}, users: {}, sessions: {} }, null, 2));
  }
}

function readAll() {
  ensure();
  const raw = fs.readFileSync(FILE, 'utf-8').trim();
  return raw ? JSON.parse(raw) : { codes: {}, verifyTokens: {}, users: {}, sessions: {} };
}

function writeAll(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

module.exports = { readAll, writeAll };
