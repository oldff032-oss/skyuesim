const storage = require('./persistentState');
const defaults = () => ({
  announcements: [], notes: {}, blacklist: { emails: [], iccids: [] }, templates: [],
  emailBroadcasts: [], securityEvents: [], jobs: [], deliveryEvents: [], resolvedAttention: {},
  featureFlags: {
    registration:true, monthlyPlans:true, travelPackages:true, referrals:true,
    autoRenew:true, push:true, deepl:true, photoUploads:true, cardPayments:true,
  },
  providerBalance: { amount:null, currency:'USD', averageOrderCost:null, updatedAt:null, source:'not_configured' },
  versionInfo: { frontend:'1.0.0', backend:'1.0.0', serviceWorker:'v37', deployedAt:null, changelog:[] },
  dailyReports: [], reportSettings: { enabled:true, hour:8, lastSentDate:null },
});
let store = defaults();
async function bootstrap(){
  const loaded = await storage.load('operations.json', defaults());
  store = {...defaults(), ...loaded};
  store.blacklist = {...defaults().blacklist, ...(loaded.blacklist||{})};
  store.featureFlags = {...defaults().featureFlags, ...(loaded.featureFlags||{})};
  store.providerBalance = {...defaults().providerBalance, ...(loaded.providerBalance||{})};
  store.versionInfo = {...defaults().versionInfo, ...(loaded.versionInfo||{})};
  store.reportSettings = {...defaults().reportSettings, ...(loaded.reportSettings||{})};
}
function save(){ storage.save('operations.json', store); }
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
module.exports={ bootstrap, store:()=>store, save, activeAnnouncements, addJob, updateJob, recordDelivery, updateDelivery };
