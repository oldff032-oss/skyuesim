const storage = require('./persistentState');
let store = { admins: {}, sessions: {} };

async function bootstrap() { store = { admins: {}, sessions: {}, ...(await storage.load('admins.json', store)) }; }
function readAll() { return store; }
function writeAll(data) { store = data; storage.save('admins.json', store); }

module.exports = { bootstrap, readAll, writeAll };
