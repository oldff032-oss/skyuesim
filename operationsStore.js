const storage = require('./persistentState');
const defaults = () => ({
  announcements: [], notes: {}, blacklist: { emails: [], iccids: [] }, templates: [],
  emailBroadcasts: [], securityEvents: [], jobs: [], deliveryEvents: [], resolvedAttention: {}, processedEvents: {},
  pinResetRequests: [],
  rescueRequests: [],
  esimInventory: [],
  esimAssignmentEvents: [],
  welcomeRegistrationOffer: {
    enabled:true,
    limit:10,
    dataLimitGb:20,
    claims:[],
  },
  engagementSettings: {
    enabled:true, pointsPerDollar:10, stampBonus:50, roamingReferenceCentsPerGb:1000,
    rewards:[
      {id:'discount_1',name:'Знижка $1 на наступну eSIM',points:250,kind:'discount',amountCents:100},
      {id:'discount_2',name:'Знижка $2 на наступну eSIM',points:500,kind:'discount',amountCents:200},
      {id:'discount_5',name:'Знижка $5 на наступну eSIM',points:1100,kind:'discount',amountCents:500},
    ],
  },
  featureFlags: {
    registration:true, monthlyPlans:true, travelPackages:true, mobileTopups:false, referrals:true,
    autoRenew:true, push:true, deepl:true, photoUploads:true, cardPayments:true,
  },
  featureRules: { disabledCountries:[], disabledPackages:[], paymentMethods:{stripeCard:true} },
  providerBalance: { amount:null, currency:'USD', averageOrderCost:null, updatedAt:null, source:'not_configured' },
  versionInfo: { frontend:'4.2.0', backend:'3.0.0', serviceWorker:'v103', cache:'signal-shell-v103-registration-offer', deployedAt:null, changelog:['Повернуто помітну реєстрацію на екран входу','Перші 10 підтверджених акаунтів отримують резерв 20 ГБ','Додано живий лічильник доступних подарунків','Автоматичне очищення старого кешу v103 без видалення акаунта чи eSIM'],criticalRefreshToken:null,criticalAssets:['/index.html','/welcome.html','/login.html','/register-email.html','/verify-code.html','/set-password.html','/security-setup.html','/security-pin.html','/account-created.html','/dashboard.html','/usage.html','/esim-topup.html','/security.html','/security-pattern.html','/security-recovery.html','/admin-dashboard.html','/signal-v5.css','/signal-earth-v1.png','/signal-premium-logo.png','/i18n.js','/style.css','/experience.css','/experience.js','/pwa.js','/sw.js'] },
  clientVersions: {},
  dailyReports: [], reportSettings: { enabled:true, hour:8, lastSentDate:null },
});
let store = defaults();
async function bootstrap(){
  const loaded = await storage.load('operations.json', defaults());
  store = {...defaults(), ...loaded};
  store.blacklist = {...defaults().blacklist, ...(loaded.blacklist||{})};
  store.featureFlags = {...defaults().featureFlags, ...(loaded.featureFlags||{}), mobileTopups:false};
  store.featureRules = {...defaults().featureRules, ...(loaded.featureRules||{}),paymentMethods:{...defaults().featureRules.paymentMethods,...(loaded.featureRules?.paymentMethods||{})}};
  store.providerBalance = {...defaults().providerBalance, ...(loaded.providerBalance||{})};
  store.engagementSettings = {...defaults().engagementSettings, ...(loaded.engagementSettings||{}),rewards:Array.isArray(loaded.engagementSettings?.rewards)?loaded.engagementSettings.rewards:defaults().engagementSettings.rewards};
  store.esimInventory = Array.isArray(loaded.esimInventory) ? loaded.esimInventory : [];
  store.esimAssignmentEvents = Array.isArray(loaded.esimAssignmentEvents) ? loaded.esimAssignmentEvents : [];
  store.welcomeRegistrationOffer = {...defaults().welcomeRegistrationOffer, ...(loaded.welcomeRegistrationOffer||{}), claims:Array.isArray(loaded.welcomeRegistrationOffer?.claims)?loaded.welcomeRegistrationOffer.claims:[]};
  store.versionInfo = {...defaults().versionInfo, ...(loaded.versionInfo||{}), frontend:defaults().versionInfo.frontend, backend:defaults().versionInfo.backend, serviceWorker:defaults().versionInfo.serviceWorker, cache:defaults().versionInfo.cache, changelog:defaults().versionInfo.changelog, criticalAssets:[...new Set([...defaults().versionInfo.criticalAssets,'/security-pin.html'])]};
  store.reportSettings = {...defaults().reportSettings, ...(loaded.reportSettings||{})};
}
function save(){ storage.save('operations.json', store); }
async function saveNow(){ await storage.saveNow('operations.json',store); }
async function refresh(){
  const loaded=await storage.reload('operations.json',defaults());
  store={...defaults(),...loaded};
  store.blacklist={...defaults().blacklist,...(loaded.blacklist||{})};
  store.featureFlags={...defaults().featureFlags,...(loaded.featureFlags||{}),mobileTopups:false};
  store.engagementSettings={...defaults().engagementSettings,...(loaded.engagementSettings||{}),rewards:Array.isArray(loaded.engagementSettings?.rewards)?loaded.engagementSettings.rewards:defaults().engagementSettings.rewards};
  store.esimInventory=Array.isArray(loaded.esimInventory)?loaded.esimInventory:[];
  store.esimAssignmentEvents=Array.isArray(loaded.esimAssignmentEvents)?loaded.esimAssignmentEvents:[];
  store.welcomeRegistrationOffer={...defaults().welcomeRegistrationOffer,...(loaded.welcomeRegistrationOffer||{}),claims:Array.isArray(loaded.welcomeRegistrationOffer?.claims)?loaded.welcomeRegistrationOffer.claims:[]};
  store.versionInfo={...defaults().versionInfo,...(loaded.versionInfo||{}),frontend:defaults().versionInfo.frontend,backend:defaults().versionInfo.backend,serviceWorker:defaults().versionInfo.serviceWorker,cache:defaults().versionInfo.cache,changelog:defaults().versionInfo.changelog};
  return store;
}
function activeAnnouncements(email){ const now=Date.now(); return store.announcements.filter(a => (!a.startsAt || new Date(a.startsAt)<=now) && (!a.expiresAt || new Date(a.expiresAt)>now) && (a.audience==='all'||a.audience===email)); }
function addJob(job={}){
  const record={id:`job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`,type:String(job.type||'general').slice(0,80),status:job.status||'pending',email:job.email||null,purchaseId:job.purchaseId||null,payload:job.payload||{},attempts:Number(job.attempts||0),maxAttempts:Number(job.maxAttempts||3),retryable:job.retryable!==false,error:job.error||null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  store.jobs.unshift(record);store.jobs=store.jobs.slice(0,3000);save();return record;
}
function welcomeOfferStatus(){
  const offer=store.welcomeRegistrationOffer||defaults().welcomeRegistrationOffer;
  const limit=Math.max(0,Number(offer.limit)||0),claimed=Array.isArray(offer.claims)?offer.claims.length:0;
  return {enabled:offer.enabled!==false,limit,dataLimitGb:Math.max(0,Number(offer.dataLimitGb)||0),claimed,remaining:Math.max(0,limit-claimed),available:offer.enabled!==false&&claimed<limit};
}
function claimWelcomeOffer(email){
  const normalizedEmail=String(email||'').trim().toLowerCase(),offer=store.welcomeRegistrationOffer||defaults().welcomeRegistrationOffer;
  offer.claims=Array.isArray(offer.claims)?offer.claims:[];store.welcomeRegistrationOffer=offer;
  const existing=offer.claims.find(item=>item.email===normalizedEmail);
  if(existing)return {...welcomeOfferStatus(),claimed:true,alreadyClaimed:true,claimId:existing.id,status:existing.status,claimedAt:existing.claimedAt};
  const status=welcomeOfferStatus();
  if(!normalizedEmail||!status.available)return {...status,claimed:false,alreadyClaimed:false};
  const claim={id:`welcome_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`,email:normalizedEmail,dataLimitGb:status.dataLimitGb,status:'reserved',claimedAt:new Date().toISOString(),jobId:null};
  offer.claims.push(claim);
  const job=addJob({type:'welcome_20gb_esim_fulfillment',email:normalizedEmail,status:'awaiting_fulfillment',retryable:false,payload:{claimId:claim.id,dataLimitGb:claim.dataLimitGb}});
  claim.jobId=job.id;save();
  return {...welcomeOfferStatus(),claimed:true,alreadyClaimed:false,claimId:claim.id,status:claim.status,claimedAt:claim.claimedAt};
}
function fulfillWelcomeOffer(email,{profileId=null,dataLimitGb=0}={}){
  const normalizedEmail=String(email||'').trim().toLowerCase(),offer=store.welcomeRegistrationOffer||defaults().welcomeRegistrationOffer;
  const claim=(offer.claims||[]).find(item=>item.email===normalizedEmail&&item.status==='reserved');
  if(!claim||Number(dataLimitGb)<Number(claim.dataLimitGb||offer.dataLimitGb||20))return null;
  Object.assign(claim,{status:'fulfilled',profileId,fulfilledAt:new Date().toISOString()});
  const job=store.jobs.find(item=>item.id===claim.jobId);
  if(job)Object.assign(job,{status:'completed',error:null,updatedAt:new Date().toISOString(),completedAt:claim.fulfilledAt});
  save();return {...claim};
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
module.exports={ bootstrap, store:()=>store, save, saveNow, refresh, activeAnnouncements, addJob, updateJob, welcomeOfferStatus, claimWelcomeOffer, fulfillWelcomeOffer, recordDelivery, updateDelivery, beginEvent, finishEvent };
