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
  const record={ id:`log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`, createdAt:new Date().toISOString(), email:String(event.email||'').trim().toLowerCase()||null, source:['client','server','stripe','esim_access','email','push'].includes(event.source)?event.source:'client', severity:['info','warning','error'].includes(event.severity)?event.severity:'info', type:String(event.type||'event').slice(0,80), action:String(event.action||'').slice(0,100)||null, outcome:['started','success','failed','blocked','pending'].includes(event.outcome)?event.outcome:null, page:String(event.page||'').slice(0,200), message:String(event.message||'').slice(0,500), errorCode:String(event.errorCode||'').slice(0,100)||null, requestId:String(event.requestId||'').slice(0,100)||null, purchaseId:String(event.purchaseId||'').slice(0,120)||null, durationMs:Number.isFinite(Number(event.durationMs))?Math.max(0,Math.round(Number(event.durationMs))):null, context:sanitize(event.context||{}) };
  store.events.unshift(record); store.events=store.events.slice(0,5000); storage.save('diagnostics.json',store); return record;
}
function list({email,type,severity,source,outcome,search,since,limit=200}={}){ const sinceTime=since?new Date(since).getTime():0,q=String(search||'').trim().toLowerCase();return store.events.filter(item=>(!email||item.email===String(email).toLowerCase())&&(!type||item.type===type)&&(!severity||item.severity===severity)&&(!source||item.source===source)&&(!outcome||item.outcome===outcome)&&(!sinceTime||new Date(item.createdAt).getTime()>=sinceTime)&&(!q||`${item.email||''} ${item.type||''} ${item.action||''} ${item.message||''} ${item.errorCode||''} ${item.purchaseId||''} ${item.requestId||''}`.toLowerCase().includes(q))).slice(0,Math.min(1000,Math.max(1,Number(limit)||200))); }
function summary(hours=24){const cutoff=Date.now()-Math.max(1,Math.min(720,Number(hours)||24))*3600000,events=store.events.filter(item=>new Date(item.createdAt).getTime()>=cutoff),count=key=>events.reduce((result,item)=>{const value=item[key]||'unknown';result[value]=(result[value]||0)+1;return result;},{});return {total:events.length,errors:events.filter(item=>item.severity==='error').length,warnings:events.filter(item=>item.severity==='warning').length,failedPayments:events.filter(item=>item.type==='payment_flow'&&item.outcome==='failed').length,failedEsims:events.filter(item=>item.type==='esim_flow'&&item.outcome==='failed').length,byType:count('type'),bySource:count('source')};}
function removeForEmail(email){ const before=store.events.length; store.events=store.events.filter(item=>item.email!==String(email).toLowerCase()); storage.save('diagnostics.json',store); return before-store.events.length; }
module.exports={bootstrap,add,list,summary,removeForEmail};
