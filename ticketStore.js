// ticketStore.js
//
// Файлове сховище для тікетів підтримки. Як і db.js/authStore.js —
// просте рішення для старту, заміниш на справжню БД, коли зросте
// кількість користувачів і звернень.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'tickets.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ tickets: [], nextId: 1001 }, null, 2));
}

function readAll() {
  ensure();
  const raw = fs.readFileSync(FILE, 'utf-8').trim();
  return raw ? JSON.parse(raw) : { tickets: [], nextId: 1001 };
}

function writeAll(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function createTicket({ email, category, subject, message }) {
  const store = readAll();
  const id = store.nextId;
  const ticket = {
    id,
    email,
    category,
    subject,
    status: 'open', // open | in_progress | waiting_customer | resolved | closed
    priority: 'normal', // normal | priority | high | critical
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      { from: 'user', text: message, createdAt: new Date().toISOString() },
    ],
  };
  store.tickets.push(ticket);
  store.nextId += 1;
  writeAll(store);
  return ticket;
}

function getTicketsByEmail(email) {
  const store = readAll();
  return store.tickets.filter(t => t.email === email).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getAllTickets({ status, priority, search } = {}) {
  const store = readAll();
  let list = store.tickets;
  if (status) list = list.filter(t => t.status === status);
  if (priority) list = list.filter(t => t.priority === priority);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(t =>
      String(t.id).includes(q) ||
      t.email.toLowerCase().includes(q) ||
      t.subject.toLowerCase().includes(q)
    );
  }
  return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function getTicket(id) {
  const store = readAll();
  return store.tickets.find(t => t.id === Number(id)) || null;
}

function addMessage(id, { from, text }) {
  const store = readAll();
  const ticket = store.tickets.find(t => t.id === Number(id));
  if (!ticket) return null;
  ticket.messages.push({ from, text, createdAt: new Date().toISOString() });
  ticket.updatedAt = new Date().toISOString();
  if (from === 'admin' && ticket.status === 'open') ticket.status = 'in_progress';
  writeAll(store);
  return ticket;
}

function updateTicket(id, patch) {
  const store = readAll();
  const ticket = store.tickets.find(t => t.id === Number(id));
  if (!ticket) return null;
  Object.assign(ticket, patch, { updatedAt: new Date().toISOString() });
  writeAll(store);
  return ticket;
}

module.exports = { createTicket, getTicketsByEmail, getAllTickets, getTicket, addMessage, updateTicket };
