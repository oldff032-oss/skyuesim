const storage = require('./persistentState');
const EMPTY = { codes: {}, verifyTokens: {}, users: {}, sessions: {}, resetCodes: {}, resetTokens: {} };
let store = { ...EMPTY };

async function bootstrap() { store = { ...EMPTY, ...(await storage.load('auth.json', EMPTY)) }; }
function readAll() { return store; }
function writeAll(data) { store = data; storage.save('auth.json', store); }

module.exports = { bootstrap, readAll, writeAll };

