// db.js
//
// Це проста файлова "база даних" (JSON-файл) — вистачить для запуску й тестів.
// Коли будеш готовий(а) до реального продукту з багатьма користувачами,
// заміни цей файл на підключення до справжньої БД (наприклад PostgreSQL
// через Prisma, або MongoDB). Усі функції нижче (getUser, saveUser, ...)
// можна переписати так, щоб вони робили запити до реальної БД — решта коду
// (server.js) не зміниться, бо він викликає тільки ці функції.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

function ensureDbFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '{}');
  }
}

function readAll() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_FILE, 'utf-8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeAll(data) {
  ensureDbFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function getUser(email) {
  const all = readAll();
  return all[email] || null;
}

function saveUser(email, userData) {
  const all = readAll();
  all[email] = { ...(all[email] || {}), ...userData };
  writeAll(all);
  return all[email];
}

function getUserByStripeCustomerId(customerId) {
  const all = readAll();
  return Object.values(all).find(u => u.stripeCustomerId === customerId) || null;
}

module.exports = { getUser, saveUser, getUserByStripeCustomerId };
