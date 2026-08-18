const storage = require('./persistentState');
let store = { events: [] };
async function bootstrap(){ store = { events: [], ...(await storage.load('diagnostics.json', store)) }; }
function sanitize(value, depth = 0){
  if(depth > 3) return '[truncated]';
  if(value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if(typeof value === 'string') return value.slice(0,500);
  if(Array.isArray(value)) return value.slice(0,20).map(item=>sanitize(item,depth+1));
  if(typeof value === 'object'){
    const blocked=/password|pass|pin|token|secret|authorization|cookie|activation|qr|iccid|card|cvc|body/i;
    return Object.fromEntries(Object.entries(value).slice(0,30).map(([key,item])=>[key,blocked.test(key)?'[redacted]':sanitize(item,depth+1)]));
  }
  return String(value).slice(0,500);
}
function add(event){
  const record={ id:`log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`, createdAt:new Date().toISOString(), email:String(event.email||'').trim().toLowerCase()||null, source:event.source||'client', severity:['info','warning','error'].includes(event.severity)?event.severity:'info', type:String(event.type||'event').slice(0,80), page:String(event.page||'').slice(0,200), message:String(event.message||'').slice(0,500), context:sanitize(event.context||{}) };
  store.events.unshift(record); store.events=store.events.slice(0,5000); storage.save('diagnostics.json',store); return record;
}
function list({email,type,severity,limit=200}={}){ return store.events.filter(item=>(!email||item.email===String(email).toLowerCase())&&(!type||item.type===type)&&(!severity||item.severity===severity)).slice(0,Math.min(500,Math.max(1,Number(limit)||200))); }
function removeForEmail(email){ const before=store.events.length; store.events=store.events.filter(item=>item.email!==String(email).toLowerCase()); storage.save('diagnostics.json',store); return before-store.events.length; }
module.exports={bootstrap,add,list,removeForEmail};
