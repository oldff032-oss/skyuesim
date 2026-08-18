const storage = require('./persistentState');
let store = { admins: {}, sessions: {}, twoFactorChallenges: {} };

async function bootstrap() { store = { admins: {}, sessions: {}, twoFactorChallenges: {}, ...(await storage.load('admins.json', store)) }; }
function readAll() { return store; }
function writeAll(data) { store = data; storage.save('admins.json', store); }

module.exports = { bootstrap, readAll, writeAll };
