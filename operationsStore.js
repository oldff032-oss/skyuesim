const storage = require('./persistentState');
const defaults = () => ({
  announcements: [], notes: {}, blacklist: { emails: [], iccids: [] }, templates: [],
  emailBroadcasts: [], securityEvents: [], jobs: [], deliveryEvents: [], resolvedAttention: {}, processedEvents: {},
  featureFlags: {
    registration:true, monthlyPlans:true, travelPackages:true, mobileTopups:true, referrals:true,
    autoRenew:true, push:true, deepl:true, photoUploads:true, cardPayments:true,
  },
  featureRules: { disabledCountries:[], disabledPackages:[], paymentMethods:{stripeCard:true} },
  providerBalance: { amount:null, currency:'USD', averageOrderCost:null, updatedAt:null, source:'not_configured' },
  versionInfo: { frontend:'1.0.0', backend:'1.0.0', serviceWorker:'v57', cache:'signal-shell-v57-mobile-topups', deployedAt:null, changelog:[],criticalRefreshToken:null,criticalAssets:['/i18n.js','/style.css','/pwa.js','/sw.js'] },
  clientVersions: {},
  dailyReports: [], reportSettings: { enabled:true, hour:8, lastSentDate:null },
});
let store = defaults();
async function bootstrap(){
  const loaded = await storage.load('operations.json', defaults());
  store = {...defaults(), ...loaded};
  store.blacklist = {...defaults().blacklist, ...(loaded.blacklist||{})};
  store.featureFlags = {...defaults().featureFlags, ...(loaded.featureFlags||{})};
  store.featureRules = {...defaults().featureRules, ...(loaded.featureRules||{}),paymentMethods:{...defaults().featureRules.paymentMethods,...(loaded.featureRules?.paymentMethods||{})}};
  store.providerBalance = {...defaults().providerBalance, ...(loaded.providerBalance||{})};
  store.versionInfo = {...defaults().versionInfo, ...(loaded.versionInfo||{})};
  store.reportSettings = {...defaults().reportSettings, ...(loaded.reportSettings||{})};
}
function save(){ storage.save('operations.json', store); }
async function saveNow(){ await storage.saveNow('operations.json',store); }
async function refresh(){
  const loaded=await storage.reload('operations.json',defaults());
  store={...defaults(),...loaded};
  store.blacklist={...defaults().blacklist,...(loaded.blacklist||{})};
  store.featureFlags={...defaults().featureFlags,...(loaded.featureFlags||{})};
  return store;
}
function activeAnnouncements(email){ const now=Date.now(); return store.announcements.filter(a => (!a.startsAt || new Date(a.startsAt)<=now) && (!a.expiresAt || new Date(a.expiresAt)>now) && (a.audience==='all'||a.audience===email)); }
function addJob(job={}){
  const record={id:`job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`,type:String(job.type||'general').slice(0,80),status:job.status||'pending',email:job.email||null,purchaseId:job.purchaseId||null,payload:job.payload||{},attempts:Number(job.attempts||0),maxAttempts:Number(job.maxAttempts||3),retryable:job.retryable!==false,error:job.error||null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  store.jobs.unshift(record);store.jobs=store.jobs.slice(0,3000);save();return record;
}
function updateJob(id,patch={}){const job=store.jobs.find(item=>item.id===id);if(!job)return null;Object.assign(job,patch,{updatedAt:new Date().toISOString()});save();return job;}
function recordDelivery(event={}){
  const record={id:`delivery_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`,channel:event.channel||'email',recipient:String(event.recipient||'').slice(0,200),subject:String(event.subject||'').slice(0,200),status:event.status||'pending',error:event.error?String(event.error).slice(0,500):null,attempts:Number(event.attempts||1),providerId:event.providerId||null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  store.deliveryEvents.unshift(record);store.deliveryEvents=store.deliveryEvents.slice(0,5000);save();return record;
}
function updateDelivery(id,patch={}){const item=store.deliveryEvents.find(event=>event.id===id);if(!item)return null;Object.assign(item,patch,{updatedAt:new Date().toISOString()});save();return item;}
function beginEvent(provider,eventId,type){
  const id=String(eventId||'').trim();if(!id)return {accepted:false,reason:'missing_id'};
  const key=`${provider}:${id}`,existing=store.processedEvents[key];
  if(existing&&['processing','completed'].includes(existing.status))return {accepted:false,duplicate:true,event:existing};
  const event={provider,id,type:String(type||''),status:'processing',startedAt:new Date().toISOString(),attempts:Number(existing?.attempts||0)+1};
  store.processedEvents[key]=event;
  const entries=Object.entries(store.processedEvents).sort((a,b)=>new Date(b[1].startedAt)-new Date(a[1].startedAt)).slice(0,10000);
  store.processedEvents=Object.fromEntries(entries);save();return {accepted:true,key,event};
}
function finishEvent(key,status='completed',error=null){const event=store.processedEvents[key];if(!event)return null;Object.assign(event,{status,error:error?String(error).slice(0,500):null,finishedAt:new Date().toISOString()});save();return event;}
module.exports={ bootstrap, store:()=>store, save, saveNow, refresh, activeAnnouncements, addJob, updateJob, recordDelivery, updateDelivery, beginEvent, finishEvent };
