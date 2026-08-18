const storage = require('./persistentState');
let store = { announcements: [], notes: {}, blacklist: { emails: [], iccids: [] }, templates: [], emailBroadcasts: [] };
async function bootstrap(){ store = { announcements: [], notes: {}, blacklist: { emails: [], iccids: [] }, templates: [], emailBroadcasts: [], ...(await storage.load('operations.json', store)) }; }
function save(){ storage.save('operations.json', store); }
function activeAnnouncements(email){ const now=Date.now(); return store.announcements.filter(a => (!a.startsAt || new Date(a.startsAt)<=now) && (!a.expiresAt || new Date(a.expiresAt)>now) && (a.audience==='all'||a.audience===email)); }
module.exports={ bootstrap, store:()=>store, save, activeAnnouncements };
