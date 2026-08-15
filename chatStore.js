const crypto = require('crypto');
const storage = require('./persistentState');

let store = { conversations: [], nextMessageId: 1, nextSignalId: 1 };

async function bootstrap() {
  store = { conversations: [], nextMessageId: 1, nextSignalId: 1, ...(await storage.load('chats.json', store)) };
}

function persist() { storage.save('chats.json', store); }

function conversationFor(email, conversationId) {
  const conversation = store.conversations.find(item => item.id === conversationId);
  return conversation?.members.includes(email) ? conversation : null;
}

function getOrCreateDirectConversation(firstEmail, secondEmail) {
  let conversation = store.conversations.find(item => item.members.length === 2 && item.members.includes(firstEmail) && item.members.includes(secondEmail));
  if (conversation) return conversation;
  const now = new Date().toISOString();
  conversation = { id: crypto.randomUUID(), members: [firstEmail, secondEmail], createdAt: now, updatedAt: now, messages: [], signals: [] };
  store.conversations.push(conversation);
  persist();
  return conversation;
}

function listConversations(email, profileForEmail) {
  return store.conversations.filter(conversation => conversation.members.includes(email)).map(conversation => {
    const otherEmail = conversation.members.find(member => member !== email);
    const lastMessage = conversation.messages.at(-1) || null;
    return { id: conversation.id, contact: profileForEmail(otherEmail), updatedAt: conversation.updatedAt, lastMessage: lastMessage ? { text: lastMessage.text, createdAt: lastMessage.createdAt, from: lastMessage.from } : null };
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function messages(email, conversationId) { const conversation = conversationFor(email, conversationId); return conversation ? conversation.messages : null; }
function addMessage(email, conversationId, text) {
  const conversation = conversationFor(email, conversationId);
  if (!conversation) return null;
  const message = { id: store.nextMessageId++, from: email, text, createdAt: new Date().toISOString() };
  conversation.messages.push(message); conversation.updatedAt = message.createdAt; persist(); return message;
}
function addSignal(email, conversationId, type, payload) {
  const conversation = conversationFor(email, conversationId);
  if (!conversation) return null;
  const signal = { id: store.nextSignalId++, from: email, type, payload, createdAt: new Date().toISOString() };
  conversation.signals.push(signal); conversation.signals = conversation.signals.slice(-100); conversation.updatedAt = signal.createdAt; persist(); return signal;
}
function signals(email, conversationId, afterId = 0) {
  const conversation = conversationFor(email, conversationId);
  return conversation ? conversation.signals.filter(signal => signal.id > afterId && signal.from !== email) : null;
}

module.exports = { bootstrap, getOrCreateDirectConversation, listConversations, messages, addMessage, addSignal, signals };
