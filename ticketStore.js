const storage = require('./persistentState');
let store = { tickets: [], nextId: 1001 };

async function bootstrap() { store = { tickets: [], nextId: 1001, ...(await storage.load('tickets.json', store)) }; }
function writeAll(data) { store = data; storage.save('tickets.json', store); }
function createTicket({ email, category, subject, message, attachment }) {
  const now = new Date().toISOString();
  const ticket = { id: store.nextId++, email, category, subject, status: 'open', priority: 'normal', createdAt: now, updatedAt: now, messages: [{ from: 'user', text: message, attachment: attachment || null, createdAt: now }] };
  store.tickets.push(ticket); writeAll(store); return ticket;
}
function getTicketsByEmail(email) { return store.tickets.filter(t => t.email === email).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)); }
function getAllTickets({ status, priority, search } = {}) {
  let list = store.tickets;
  if (status) list = list.filter(t => t.status === status);
  if (priority) list = list.filter(t => t.priority === priority);
  if (search) { const q = search.toLowerCase(); list = list.filter(t => String(t.id).includes(q) || t.email.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q)); }
  return list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}
function getTicket(id) { return store.tickets.find(t => t.id === Number(id)) || null; }
function addMessage(id, { from, text, attachment }) {
  const ticket = getTicket(id); if (!ticket) return null;
  ticket.messages.push({ from, text, attachment: attachment || null, createdAt: new Date().toISOString() }); ticket.updatedAt = new Date().toISOString();
  if (from === 'admin' && ticket.status === 'open') ticket.status = 'in_progress'; writeAll(store); return ticket;
}
function updateTicket(id, patch) { const ticket = getTicket(id); if (!ticket) return null; Object.assign(ticket, patch, { updatedAt: new Date().toISOString() }); writeAll(store); return ticket; }
function stripNotesForUser(ticket) { return ticket ? { ...ticket, messages: ticket.messages.filter(message => message.from !== 'note') } : ticket; }

module.exports = { bootstrap, createTicket, getTicketsByEmail, getAllTickets, getTicket, addMessage, updateTicket, stripNotesForUser };
