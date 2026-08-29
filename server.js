// server.js
//
// Запуск: npm install, потім npm start
// Сервер підніметься на порту з .env (за замовчуванням 4242)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');

const { createCheckoutSession, createCustomPackageCheckout, createMobileTopupCheckout, createBillingPortalSession, cancelSubscription, cancelSubscriptionAtPeriodEnd, cancelAllSubscriptionsForCustomers, deleteStripeCustomer, constructWebhookEvent, getNextBillingDate, getBillingHistory, getRecoveryPaymentEvidence, findCustomerIdsByEmail, resolveStripeCustomerProfile, getCustomerEmail, getSubscriptionStateByEmail, listCompletedCheckoutPurchasesByEmail, getCheckoutPurchaseDetails, listRefundablePaymentsByEmail, refundPayment } = require('./stripeService');
const crypto = require('crypto');
const { provisionEsim, checkUsage, recoverEsim, topupEsim, listPackages, findRenewalTopup } = require('./esimService');
const { bootstrap: bootstrapUsers, getUser, saveUser, deleteUser, getUserByStripeCustomerId, getAllUsers } = require('./db');
const storage = require('./persistentState');
const authStore = require('./authStore');
const adminStore = require('./adminStore');
const authService = require('./authService');
const ticketStore = require('./ticketStore');
const auditStore = require('./auditStore');
const adminAuth = require('./adminAuthService');
const pushStore = require('./pushStore');
const operationsStore = require('./operationsStore');
const diagnosticsStore = require('./diagnosticsStore');
const translationService = require('./translationService');
const { isConfigured: isPushConfigured, sendToEmail } = require('./pushService');
const { sendEmail, getReceivedEmail, verifyInboundSignature, isEmailConfigured } = require('./emailService');
const emailTemplates = require('./emailTemplates');
const backupService = require('./backupService');
const controlCenter = require('./controlCenterService');
const mobileTopups = require('./mobileTopupService');
const engagement = require('./engagementService');
const googleWallet = require('./googleWalletService');

function refreshGoogleWallet(email) {
  const user=getUser(email);
  if(!user)return;
  googleWallet.createPass(engagement.walletCard(user)).catch(()=>{});
}

const app = express();
const esimRetriesInProgress = new Set();
const renewalInvoicesInProgress = new Set();
const planChangesInProgress = new Set();
const coverageCache = new Map();
const travelPackageCache = { createdAt:0, packages:[] };
const adminRecoveryRateLimit = new Map();
const pendingBackupRestores = new Map();
const securityAttemptTracker = new Map();
const BACKUP_STATE_KEYS = ['users.json','auth.json','admins.json','tickets.json','audit-log.json','operations.json','push-subscriptions.json','diagnostics.json','translations.json'];
app.set('trust proxy',1);
const allowedOrigins=new Set([process.env.FRONTEND_URL,'https://skyesim.netlify.app',...String(process.env.ALLOWED_ORIGINS||'').split(',')].map(value=>String(value||'').trim().replace(/\/$/,'')).filter(Boolean));
if(process.env.NODE_ENV!=='production'){allowedOrigins.add('http://localhost:3000');allowedOrigins.add('http://localhost:4242');allowedOrigins.add('http://127.0.0.1:5500');}
app.use(cors({origin(origin,callback){if(!origin||allowedOrigins.has(String(origin).replace(/\/$/,'')))return callback(null,true);callback(new Error('Origin is not allowed'));},methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'],allowedHeaders:['Content-Type','x-session-token','x-admin-token','x-device-name','stripe-signature','svix-id','svix-timestamp','svix-signature'],exposedHeaders:['x-request-id'],maxAge:86400}));
app.use((req,res,next)=>{req.requestId=String(req.headers['x-request-id']||crypto.randomUUID()).slice(0,100);res.setHeader('x-request-id',req.requestId);next();});
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.setHeader('Cross-Origin-Resource-Policy','same-site');if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');next();});

function upsertPurchase(email, purchaseId, patch, defaults = {}) {
  const user = getUser(email) || {};
  const purchases = Array.isArray(user.purchases) ? [...user.purchases] : [];
  const index = purchases.findIndex(item => item.id === purchaseId);
  const current = index >= 0 ? purchases[index] : { id:purchaseId, createdAt:new Date().toISOString(), ...defaults };
  const next = { ...current, ...patch, updatedAt:new Date().toISOString() };
  if (index >= 0) purchases[index] = next; else purchases.unshift(next);
  saveUser(email, { purchases });
  if(['provisioned','delivered'].includes(next.fulfillmentStatus))awardEngagementForPurchase(email,purchaseId);
  return next;
}

function userStatusView(user) {
  if(!user)return null;
  const allowed=['email','displayName','avatarDataUrl','status','plan','createdAt','updatedAt','subscriptionPeriodEnd','lastRenewalError','lastEsimProvisionError'];
  const result=Object.fromEntries(allowed.filter(key=>user[key]!==undefined).map(key=>[key,user[key]]));
  if(user.esim){const hidden=new Set(['pinHash','passkeyChallenge','passwordHash']);result.esim=Object.fromEntries(Object.entries(user.esim).filter(([key])=>!hidden.has(key)));}
  if(user.pendingPlanChange){const change=user.pendingPlanChange;result.pendingPlanChange={purchaseId:change.purchaseId||null,packageName:change.packageName||null,dataLimitGb:change.dataLimitGb??null,durationDays:change.durationDays??null,location:change.location||null,scheduledFor:change.scheduledFor||null,paidAt:change.paidAt||null,status:change.status==='failed'?'failed':change.cancellationError?'needs_attention':'scheduled',error:change.status==='failed'?'Не вдалося активувати новий пакет. Звернися в підтримку.':null};}
  return result;
}
function validateSupportAttachment(attachment){if(!attachment)return null;const type=String(attachment.type||'').toLowerCase(),allowed=['image/png','image/jpeg','image/webp','application/pdf'];if(!allowed.includes(type)||typeof attachment.dataUrl!=='string'||attachment.dataUrl.length>800000||!attachment.dataUrl.startsWith(`data:${type};base64,`))throw Object.assign(new Error('Дозволено PNG, JPG, WEBP або PDF до 550 КБ'),{code:'INVALID_ATTACHMENT'});return {name:String(attachment.name||'attachment').replace(/[\r\n<>"']/g,'').slice(0,120),type,dataUrl:attachment.dataUrl};}

function buildSupportDiagnostics(user, client = {}) {
  const latestPurchase = Array.isArray(user?.purchases) ? user.purchases[0] : null;
  const trackedVersion = operationsStore.store().clientVersions?.[user?.email] || null;
  const clean = (value, maximum = 120) => {
    const text = String(value || '').replace(/[\r\n<>]/g, ' ').trim();
    return text ? text.slice(0, maximum) : null;
  };
  return {
    capturedAt:new Date().toISOString(),
    deviceModel:clean(client?.deviceModel, 100) || 'Не визначено',
    appVersion:clean(trackedVersion?.frontend || client?.appVersion, 40) || 'Не визначено',
    platform:clean(trackedVersion?.platform || client?.platform, 40) || 'web',
    esimStatus:clean(user?.esim?.status || (user?.esim ? user?.status : 'not_issued'), 60),
    lastSyncAt:user?.esim?.lastUpdateTime || user?.esim?.recoveredAt || user?.updatedAt || null,
    purchaseId:clean(latestPurchase?.id, 100),
    stripeStatus:clean(latestPurchase?.paymentStatus || (user?.stripeCustomerId ? 'profile_linked' : 'profile_not_linked'), 60),
    providerStatus:clean(latestPurchase?.fulfillmentStatus || user?.esim?.provider || (user?.esim ? 'issued' : 'not_issued'), 80),
    apn:clean(user?.esim?.apn, 100),
  };
}

function awardEngagementForPurchase(email, purchaseId) {
  const user=getUser(email),purchase=(user?.purchases||[]).find(item=>item.id===purchaseId);
  if(!user||!purchase||!['provisioned','delivered'].includes(purchase.fulfillmentStatus))return {awarded:0};
  const result=engagement.awardPurchase(user,purchase,operationsStore.store().engagementSettings||{});
  if(result.awarded)saveUser(email,{loyalty:result.loyalty,passport:{stamps:engagement.passportFor({...user,loyalty:result.loyalty})}});
  return result;
}

function syncEngagementForUser(email) {
  let user=getUser(email)||{},loyalty=engagement.loyaltyFor(user),awarded=0;
  for(const purchase of user.purchases||[]){
    if(!['provisioned','delivered'].includes(purchase.fulfillmentStatus))continue;
    const result=engagement.awardPurchase({...user,loyalty},purchase,operationsStore.store().engagementSettings||{});
    loyalty=result.loyalty;awarded+=result.awarded;
  }
  const stamps=engagement.passportFor({...user,loyalty}),changedStamps=JSON.stringify(stamps)!==JSON.stringify(user.passport?.stamps||[]);
  if(awarded||changedStamps){saveUser(email,{loyalty,passport:{...(user.passport||{}),stamps,lastSyncedAt:new Date().toISOString()}});user=getUser(email)||user;}
  return user;
}

function recordDiagnostic(req,event={}) {
  return diagnosticsStore.add({ source:'server', requestId:req?.requestId||null, page:req?.path||'', ...event });
}
function featureEnabled(name){return operationsStore.store().featureFlags?.[name]!==false;}
function normalizedRule(value){return String(value||'').trim().toLowerCase();}
function packageAllowed(item){const rules=operationsStore.store().featureRules||{},code=normalizedRule(item?.packageCode),location=normalizedRule(item?.location);if((rules.disabledPackages||[]).map(normalizedRule).includes(code))return false;return !(rules.disabledCountries||[]).map(normalizedRule).some(country=>country&&(location===country||location.split(/[,;/]/).map(x=>x.trim()).includes(country)));}
function paymentMethodEnabled(name){return operationsStore.store().featureRules?.paymentMethods?.[name]!==false;}
function requireFeature(name,message){return(req,res,next)=>featureEnabled(name)?next():res.status(503).json({error:message||'Функція тимчасово вимкнена адміністратором',code:'FEATURE_DISABLED',feature:name});}
function requireProviderCapacity(req,res,next){const b=operationsStore.store().providerBalance||{};const orders=b.amount!=null&&Number(b.averageOrderCost)>0?Math.floor(Number(b.amount)/Number(b.averageOrderCost)):null;return orders!=null&&orders<3?res.status(503).json({error:'Продажі тимчасово призупинено через критичний баланс eSIM-провайдера',code:'PROVIDER_BALANCE_CRITICAL'}):next();}

function packageVolumeGb(item) {
  const raw = Number(item?.volume ?? item?.dataVolume);
  return Number.isFinite(raw) && raw >= 0 ? +(raw / (1024 ** 3)).toFixed(2) : null;
}

function packageRetailCents(item) {
  const providerCostUsd = Number(item?.price || 0) / 10000;
  if (!Number.isFinite(providerCostUsd) || providerCostUsd <= 0) return null;
  const percent = Math.min(100, Math.max(10, Number(process.env.PACKAGE_MARKUP_PERCENT || 35))) / 100;
  const fixed = Math.min(10, Math.max(0.5, Number(process.env.PACKAGE_FIXED_MARKUP_USD || 1)));
  const minimum = Math.min(20, Math.max(1.99, Number(process.env.PACKAGE_MIN_PRICE_USD || 2.99)));
  const calculated = Math.max(minimum, providerCostUsd * (1 + percent), providerCostUsd + fixed);
  return Math.max(199, Math.round((Math.ceil(calculated) - 0.01) * 100));
}

function safeTravelPackage(item) {
  const packageCode = String(item?.packageCode || item?.slug || '').trim();
  const amountCents = packageRetailCents(item);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(packageCode) || !amountCents) return null;
  const text = `${item?.type || ''} ${item?.packageType || ''} ${item?.name || ''}`.toLowerCase();
  if (text.includes('topup') || text.includes('top-up')) return null;
  const unlimited = Number(item?.dataType) === 4 || /unlimited|безліміт/i.test(`${item?.name || ''} ${item?.description || ''}`);
  const networks = (item?.locationNetworkList || []).slice(0,30).map(network => ({ locationName:String(network?.locationName || '').slice(0,80), operatorCount:(network?.operatorList || []).length }));
  const rawDuration=Number(item?.duration || 30);
  const durationDays=Number.isFinite(rawDuration)?Math.max(1,Math.min(365,rawDuration)):30;
  return {
    packageCode,
    name:String(item?.name || item?.description || packageCode).slice(0,120),
    description:String(item?.description || '').slice(0,240),
    location:String(item?.location || networks.map(network=>network.locationName).filter(Boolean).join(', ') || 'Global').slice(0,160),
    dataLimitGb:unlimited ? null : packageVolumeGb(item),
    unlimited,
    durationDays,
    speed:String(item?.speed || '4G/5G').slice(0,40),
    amountCents,
    currency:'usd',
    networks,
  };
}

async function getTravelPackages(force = false) {
  if (!force && travelPackageCache.packages.length && Date.now() - travelPackageCache.createdAt < 10 * 60 * 1000) return travelPackageCache.packages;
  const raw = await listPackages({});
  const packages = raw.map(safeTravelPackage).filter(Boolean).sort((a,b) => a.location.localeCompare(b.location,'uk') || (a.dataLimitGb||Infinity)-(b.dataLimitGb||Infinity) || a.durationDays-b.durationDays || a.amountCents-b.amountCents).slice(0,5000);
  travelPackageCache.createdAt=Date.now();
  travelPackageCache.packages=packages;
  return packages;
}

async function executePaidPlanChange({email,purchaseId,packageCode,packageName,dataLimitGb,durationDays,location,previousPlan,previousSubscriptionId,requestId=null}) {
  if(planChangesInProgress.has(purchaseId)) return {ok:false,inProgress:true};
  planChangesInProgress.add(purchaseId);
  const trackedJob=operationsStore.addJob({type:'plan_change',status:'running',email,purchaseId,payload:{packageCode,packageName},maxAttempts:3});
  const diagnostic=event=>diagnosticsStore.add({email,source:'server',type:'plan_change',purchaseId,requestId,...event});
  const before=getUser(email);
  try {
    diagnostic({action:'new_esim_provision',outcome:'started',severity:'info',message:'Provisioning new eSIM for paid plan change',context:{previousPlan:previousPlan||before?.plan||null,newPackage:packageName,packageCode}});
    const esim=await provisionEsim({email,plan:'custom',packageCode,dataLimitGb});
    esim.dashboardQrExpiresAt=new Date(Date.now()+5*60*1000).toISOString();
    let cancellationError=null;
    if(previousSubscriptionId){
      try{await cancelSubscription(previousSubscriptionId);diagnostic({source:'stripe',action:'previous_subscription_canceled',outcome:'success',severity:'info',message:'Previous Stripe subscription canceled after new eSIM was ready',context:{previousSubscriptionId}});}
      catch(error){cancellationError=error.message;diagnostic({source:'stripe',action:'previous_subscription_cancel',outcome:'failed',severity:'error',message:'New eSIM is ready but previous Stripe subscription cancellation failed',errorCode:error.code||'PREVIOUS_SUBSCRIPTION_CANCEL_FAILED',context:{previousSubscriptionId}});}
    }
    const history=Array.isArray(before?.esimHistory)?[...before.esimHistory]:[];
    if(before?.esim) history.unshift({plan:before.plan||previousPlan||null,esim:before.esim,replacedAt:new Date().toISOString(),reason:'plan_change',purchaseId});
    saveUser(email,{status:'active',plan:'custom',esim,stripeSubscriptionId:null,pendingPlanChange:null,esimHistory:history.slice(0,10),lastPlanChangeAt:new Date().toISOString(),lastPlanChangeError:null,previousSubscriptionCancellationError:cancellationError});
    upsertPurchase(email,purchaseId,{fulfillmentStatus:'provisioned',planChangeStatus:cancellationError?'completed_with_warning':'completed',fulfilledAt:new Date().toISOString(),fulfillmentError:null,esimOrderNo:esim.orderNo||null,iccid:esim.iccid||null,esimTranNo:esim.esimTranNo||null,previousPlan:previousPlan||before?.plan||null,previousSubscriptionId:previousSubscriptionId||null,cancellationError});
    diagnostic({source:'esim_access',action:'plan_change_completed',outcome:'success',severity:cancellationError?'warning':'info',message:cancellationError?'New eSIM activated; previous subscription needs admin attention':'Plan change completed successfully',context:{packageCode,packageName,dataLimitGb,durationDays,location,cancellationWarning:Boolean(cancellationError)}});
    sendToEmail(email,{title:'Тариф успішно змінено',body:`Новий пакет ${packageName||'eSIM'} активовано. QR-код доступний на головному екрані 5 хвилин.`,url:'/dashboard.html',tag:`plan-change-${String(purchaseId).slice(-10)}`}).catch(()=>{});
    operationsStore.updateJob(trackedJob.id,{status:'succeeded',completedAt:new Date().toISOString()});return {ok:true,esim,cancellationError};
  } catch(error) {
    const failedPending=before?.pendingPlanChange?.purchaseId===purchaseId?{...before.pendingPlanChange,status:'failed',scheduledFor:null,failedAt:new Date().toISOString(),error:error.message}:before?.pendingPlanChange||null;
    saveUser(email,{pendingPlanChange:failedPending,lastPlanChangeError:error.message,lastPlanChangeFailedAt:new Date().toISOString()});
    upsertPurchase(email,purchaseId,{fulfillmentStatus:'failed',planChangeStatus:'failed',failedAt:new Date().toISOString(),fulfillmentError:error.message,fulfillmentErrorCode:error.code||null});
    diagnostic({source:'esim_access',action:'plan_change_failed',outcome:'failed',severity:'error',message:'Paid plan change failed while provisioning new eSIM',errorCode:error.code||'PLAN_CHANGE_PROVISION_FAILED',context:{packageCode,providerStatus:error.status||null}});
    const nonRetryable=/balance is insufficient|invalid package|doesn.t exist/i.test(String(error.message||''));operationsStore.updateJob(trackedJob.id,{status:'failed',error:error.message,retryable:!nonRetryable,completedAt:new Date().toISOString()});return {ok:false,error};
  } finally { planChangesInProgress.delete(purchaseId); }
}

async function processDuePlanChanges() {
  const due=Object.values(getAllUsers()).filter(user=>user?.pendingPlanChange?.scheduledFor&&new Date(user.pendingPlanChange.scheduledFor).getTime()<=Date.now());
  for(const user of due){const change=user.pendingPlanChange;await executePaidPlanChange({email:user.email,purchaseId:change.purchaseId,packageCode:change.packageCode,packageName:change.packageName,dataLimitGb:change.dataLimitGb,durationDays:change.durationDays,location:change.location,previousPlan:change.previousPlan,previousSubscriptionId:change.previousSubscriptionId,requestId:change.requestId});}
}

function upsertMobileTopupOrder(email, orderId, patch, defaults = {}) {
  const user = getUser(email) || {};
  const orders = Array.isArray(user.mobileTopupOrders) ? [...user.mobileTopupOrders] : [];
  const index = orders.findIndex(item => item.id === orderId);
  const current = index >= 0 ? orders[index] : { id:orderId, createdAt:new Date().toISOString(), ...defaults };
  const next = { ...current, ...patch, updatedAt:new Date().toISOString() };
  if (index >= 0) orders[index] = next; else orders.unshift(next);
  saveUser(email, { mobileTopupOrders:orders.slice(0, 100) });
  return next;
}

function getMobileTopupOrder(email, orderId) {
  return (getUser(email)?.mobileTopupOrders || []).find(item => item.id === orderId) || null;
}

function maskPhone(phone) {
  const value=String(phone||'');
  return value.length > 6 ? `${value.slice(0,3)}••••${value.slice(-3)}` : '••••';
}

function mobileTopupPurchaseDefaults(order, session = null) {
  return {
    kind:'mobile_topup',
    plan:'mobile_topup',
    packageCode:String(order.productId),
    packageName:order.productName || 'Поповнення мобільного інтернету',
    dataLimitGb:null,
    durationDays:null,
    location:[order.operatorName,order.countryName].filter(Boolean).join(' · ') || null,
    amountCents:session?.amount_total ?? order.amountCents ?? null,
    currency:session?.currency || order.currency || null,
    stripeSessionId:session?.id || order.stripeSessionId || null,
    stripeCustomerId:typeof session?.customer === 'string' ? session.customer : session?.customer?.id || null,
    stripePaymentIntentId:typeof session?.payment_intent === 'string' ? session.payment_intent : session?.payment_intent?.id || null,
    paidAt:session ? new Date((session.created || Math.floor(Date.now()/1000)) * 1000).toISOString() : order.paidAt || null,
    paymentStatus:session?.payment_status || order.paymentStatus || null,
    topupOrderId:order.id,
    recipientPhoneMasked:maskPhone(order.phone),
    operatorName:order.operatorName || null,
    provider:'dtone',
  };
}

function queueMobileTopupStatus(email, order, purchaseId) {
  const duplicate=(operationsStore.store().jobs||[]).find(job=>job.type==='mobile_topup_status'&&job.email===email&&job.payload?.orderId===order.id&&['pending','running'].includes(job.status));
  if(duplicate)return duplicate;
  return operationsStore.addJob({type:'mobile_topup_status',status:'pending',email,purchaseId,payload:{orderId:order.id},maxAttempts:20,retryable:true});
}

async function fulfillMobileTopupOrder({ email, orderId, purchaseId }) {
  let order=getMobileTopupOrder(email,orderId);
  if(!order)throw Object.assign(new Error('Оплачене замовлення поповнення не знайдено'),{code:'TOPUP_ORDER_NOT_FOUND',nonRetryable:true});
  if(order.status==='delivered')return {state:'delivered',duplicate:true,order};
  if(order.paymentStatus!=='paid')throw Object.assign(new Error('Stripe ще не підтвердив оплату поповнення'),{code:'TOPUP_PAYMENT_NOT_CONFIRMED',nonRetryable:true});
  order=upsertMobileTopupOrder(email,orderId,{status:'processing',fulfillmentError:null,fulfillmentStartedAt:new Date().toISOString(),purchaseId});
  let transaction;
  try{
    transaction=order.providerTransactionId
      ? await mobileTopups.getTransaction(order.providerTransactionId)
      : await mobileTopups.purchaseProduct({orderId,productId:order.productId,phone:order.phone});
  }catch(error){
    upsertMobileTopupOrder(email,orderId,{status:'failed',failedAt:new Date().toISOString(),fulfillmentError:error.message,fulfillmentErrorCode:error.code||'TOPUP_PROVIDER_ERROR'});
    upsertPurchase(email,purchaseId,{fulfillmentStatus:'failed',failedAt:new Date().toISOString(),fulfillmentError:error.message,fulfillmentErrorCode:error.code||'TOPUP_PROVIDER_ERROR'},mobileTopupPurchaseDefaults(order));
    throw error;
  }
  const common={providerTransactionId:transaction.id||order.providerTransactionId||null,providerStatus:transaction.status||null,operatorReference:transaction.operatorReference||null};
  if(transaction.state==='delivered'){
    order=upsertMobileTopupOrder(email,orderId,{...common,status:'delivered',deliveredAt:transaction.completedAt||new Date().toISOString(),fulfillmentError:null});
    upsertPurchase(email,purchaseId,{...common,fulfillmentStatus:'delivered',fulfilledAt:order.deliveredAt,fulfillmentError:null},mobileTopupPurchaseDefaults(order));
    return {state:'delivered',order,transaction};
  }
  if(transaction.state==='processing'){
    order=upsertMobileTopupOrder(email,orderId,{...common,status:'processing'});
    upsertPurchase(email,purchaseId,{...common,fulfillmentStatus:'processing',fulfillmentError:null},mobileTopupPurchaseDefaults(order));
    queueMobileTopupStatus(email,order,purchaseId);
    return {state:'processing',order,transaction};
  }
  const error=Object.assign(new Error(`Оператор не зарахував пакет: ${transaction.status||'відхилено'}`),{code:'TOPUP_PROVIDER_DECLINED',nonRetryable:true});
  upsertMobileTopupOrder(email,orderId,{...common,status:'failed',failedAt:new Date().toISOString(),fulfillmentError:error.message,fulfillmentErrorCode:error.code});
  upsertPurchase(email,purchaseId,{...common,fulfillmentStatus:'failed',failedAt:new Date().toISOString(),fulfillmentError:error.message,fulfillmentErrorCode:error.code},mobileTopupPurchaseDefaults(order));
  throw error;
}

async function recoverStripeProfile(email) {
  const normalizedEmail=String(email||'').trim().toLowerCase(),user=getUser(normalizedEmail)||{};
  const purchaseCustomerIds=(user.purchases||[]).map(purchase=>purchase.stripeCustomerId).filter(Boolean);
  const profile=await resolveStripeCustomerProfile({email:normalizedEmail,knownCustomerId:user.stripeCustomerId||null,purchaseCustomerIds});
  if(profile.customerId){
    saveUser(normalizedEmail,{
      stripeCustomerId:profile.customerId,
      ...(profile.subscriptionId?{stripeSubscriptionId:profile.subscriptionId}:{}),
      stripeProfileLinkedAt:user.stripeCustomerId===profile.customerId?(user.stripeProfileLinkedAt||new Date().toISOString()):new Date().toISOString(),
      stripeProfileSource:profile.source,
      stripeProfileCustomerCount:profile.customerCount,
      stripeProfileLastCheckedAt:new Date().toISOString(),
    });
  }
  return profile;
}

let operationalJobsRunning=false;
async function processOperationalJobs(){
  if(operationalJobsRunning)return;operationalJobsRunning=true;
  try{
    const pending=(operationsStore.store().jobs||[]).filter(job=>job.status==='pending'&&job.retryable!==false&&Number(job.attempts||0)<Number(job.maxAttempts||3)&&(!job.nextAttemptAt||new Date(job.nextAttemptAt)<=new Date())).slice(0,10);
    for(const job of pending){
      operationsStore.updateJob(job.id,{status:'running',attempts:Number(job.attempts||0)+1,startedAt:new Date().toISOString()});
      try{
        if(job.type==='plan_change'){
          const user=getUser(job.email),purchase=(user?.purchases||[]).find(item=>item.id===job.purchaseId);if(!user||!purchase)throw new Error('Purchase for plan change was not found');
          const result=await executePaidPlanChange({email:job.email,purchaseId:purchase.id,packageCode:purchase.packageCode,packageName:purchase.packageName,dataLimitGb:purchase.dataLimitGb,durationDays:purchase.durationDays,location:purchase.location,previousPlan:purchase.previousPlan,previousSubscriptionId:purchase.previousSubscriptionId});if(!result.ok)throw result.error||new Error('Plan change failed');
        }else if(job.type==='mobile_topup_status'){
          const result=await fulfillMobileTopupOrder({email:job.email,orderId:job.payload?.orderId,purchaseId:job.purchaseId});
          if(result.state==='processing')throw new Error('Оператор ще обробляє поповнення');
        }else throw Object.assign(new Error(`Unsupported job type: ${job.type}`),{nonRetryable:true});
        operationsStore.updateJob(job.id,{status:'succeeded',completedAt:new Date().toISOString(),error:null});
      }catch(error){const attempts=Number(job.attempts||0)+1,retryable=!error.nonRetryable&&attempts<Number(job.maxAttempts||3);operationsStore.updateJob(job.id,{status:retryable?'pending':'failed',retryable,error:error.message,nextAttemptAt:retryable?new Date(Date.now()+Math.min(30*60*1000,2**attempts*60000)).toISOString():null,completedAt:retryable?null:new Date().toISOString()});}
    }
  }finally{operationalJobsRunning=false;}
}

async function deliverPurchaseReceipt(email, purchaseId, defaults = {}, suppliedReceiptUrl = null) {
  const trackedJob=operationsStore.addJob({type:'receipt_email',status:'running',email,purchaseId,maxAttempts:3});
  const stored = (getUser(email)?.purchases || []).find(item => item.id === purchaseId);
  if (stored?.receiptEmailSentAt){operationsStore.updateJob(trackedJob.id,{status:'succeeded',completedAt:new Date().toISOString(),duplicate:true});return { duplicate:true, receiptUrl:stored.receiptUrl || suppliedReceiptUrl || null };}
  let receiptUrl = suppliedReceiptUrl || stored?.receiptUrl || null;
  try {
    if (!receiptUrl && String(purchaseId).startsWith('cs_')) {
      const details = await getCheckoutPurchaseDetails(purchaseId);
      receiptUrl = details.charge?.receiptUrl || details.invoice?.hostedInvoiceUrl || details.invoice?.pdfUrl || null;
    }
    const purchase = upsertPurchase(email, purchaseId, { receiptUrl }, defaults);
    const delivery = await sendEmail({
      to:email,
      subject:`Ваш чек за ${purchase.packageName || purchase.plan || 'eSIM-пакет'} — Сигнал`,
      html:emailTemplates.purchaseReceipt({purchase,receiptUrl,fulfillmentStatus:purchase.fulfillmentStatus}),
    });
    if (delivery?.mocked) throw new Error('RESEND_API_KEY не налаштовано');
    upsertPurchase(email, purchaseId, {receiptUrl,receiptEmailSentAt:new Date().toISOString(),receiptEmailError:null}, defaults);
    operationsStore.updateJob(trackedJob.id,{status:'succeeded',completedAt:new Date().toISOString()});return {sent:true,receiptUrl};
  } catch (error) {
    upsertPurchase(email, purchaseId, {receiptUrl,receiptEmailError:error.message,receiptEmailLastAttemptAt:new Date().toISOString()}, defaults);
    console.error(`[purchase receipt] ${email} ${purchaseId}:`, error.message);
    operationsStore.updateJob(trackedJob.id,{status:'failed',error:error.message,completedAt:new Date().toISOString()});return {sent:false,receiptUrl,error:error.message};
  }
}

async function syncPurchasesForUser(email) {
  const user = getUser(email);
  const imported = await listCompletedCheckoutPurchasesByEmail(email, user?.stripeCustomerId || null);
  const currentPurchases = Array.isArray(user?.purchases) ? user.purchases : [];
  imported.forEach((purchase, index) => {
    const existing = currentPurchases.find(item => item.id === purchase.id);
    const inferredStatus = !existing && user?.status === 'payment_ok_esim_failed' && index === 0 ? 'failed' : 'not_recorded';
    upsertPurchase(email, purchase.id, { ...purchase, fulfillmentStatus:existing?.fulfillmentStatus || inferredStatus, fulfillmentError:existing?.fulfillmentError || (inferredStatus === 'failed' ? user?.lastEsimProvisionError || 'Оплату знайдено, QR/eSIM не була видана' : null) });
  });
  return imported.length;
}

function notifySuperAdminsAboutTicket(ticket) {
  const recipients = adminAuth.listAdmins().filter(admin=>!admin.blocked&&admin.role==='super_admin');
  for(const admin of recipients) sendEmail({to:admin.email,subject:`Нове звернення #${ticket.id} — Signal Admin`,html:emailTemplates.notification({title:'Нове звернення в підтримку',message:`Користувач ${ticket.email} створив звернення «${ticket.subject}».`,actionUrl:`/admin-ticket.html?id=${ticket.id}`,actionLabel:'Відкрити звернення'})}).catch(()=>{});
  for(const admin of recipients) sendToEmail(`admin:${admin.email}`, { title:'Нове звернення в підтримку', body:`Тікет #${ticket.id}: ${ticket.subject}`, url:`/admin-ticket.html?id=${ticket.id}`, tag:`admin-ticket-${ticket.id}` }).catch(()=>{});
}

function notifyStaffAboutUserReply(ticket){
  const recipients=adminAuth.listAdmins().filter(admin=>!admin.blocked&&(ticket.assignedTo?admin.email===ticket.assignedTo:admin.role==='super_admin'));
  for(const admin of recipients){
    sendToEmail(`admin:${admin.email}`,{title:'Нова відповідь користувача',body:`Звернення #${ticket.id}: ${ticket.subject}`,url:`/admin-ticket.html?id=${ticket.id}`,tag:`ticket-user-reply-${ticket.id}`}).catch(()=>{});
    sendEmail({to:admin.email,subject:`Нова відповідь у зверненні #${ticket.id} — Signal`,html:emailTemplates.notification({title:'Користувач відповів у зверненні',message:`У зверненні #${ticket.id} «${ticket.subject}» є нове повідомлення від ${ticket.email}.`,actionUrl:`/admin-ticket.html?id=${ticket.id}`,actionLabel:'Переглянути відповідь'})}).catch(()=>{});
  }
}

function securityFingerprint(req) {
  return crypto.createHash('sha256').update(`${process.env.SECURITY_EVENT_SALT||process.env.ADMIN_RECOVERY_SECRET||'signal'}:${req.ip||'unknown'}`).digest('hex').slice(0,12);
}
function notifySuperAdminsSecurity(event,count) {
  const state=operationsStore.store();
  const notificationKey=`${event.surface}:${event.fingerprint}`;
  state.securityNotificationAtByKey||={};
  const previous=state.securityNotificationAtByKey[notificationKey];
  if(previous&&Date.now()-new Date(previous).getTime()<10*60*1000)return;
  state.securityNotificationAtByKey[notificationKey]=new Date().toISOString();
  state.securityNotificationAtByKey=Object.fromEntries(Object.entries(state.securityNotificationAtByKey).filter(([,value])=>Date.now()-new Date(value).getTime()<24*60*60*1000));
  operationsStore.save();
  const recipients=adminAuth.listAdmins().filter(admin=>!admin.blocked&&admin.role==='super_admin');
  for(const admin of recipients){
    sendToEmail(`admin:${admin.email}`,{title:'🚨 Підозріла спроба входу',body:`${event.surface}: ${event.code}. Спроб за 15 хв: ${count}.`,url:'/admin-security-incident.html',tag:`security-${event.surface}-${event.fingerprint}`}).catch(()=>{});
    sendEmail({to:admin.email,subject:`🚨 Підозріла спроба входу — ${event.surface}`,html:emailTemplates.adminSecurityAlert({title:'Виявлено підозрілу активність',message:`Час: ${new Date(event.createdAt).toLocaleString('uk-UA')}\nЗона: ${event.surface}\nПодія: ${event.code}\nСпроб за 15 хвилин: ${count}${event.email?`\nВказаний акаунт: ${event.email}`:''}\nАнонімний відбиток джерела: ${event.fingerprint}\n\nПеревірте розділ «Захист системи». Паролі, PIN, токени та повна IP-адреса в лист не додаються.`})}).catch(error=>console.error('[security email]',error.message));
  }
}
function recordSecurityFailure(req,surface,code,email='') {
  const fingerprint=securityFingerprint(req),now=Date.now(),key=`${surface}:${fingerprint}`;
  const attempts=(securityAttemptTracker.get(key)||[]).filter(time=>now-time<15*60*1000);attempts.push(now);securityAttemptTracker.set(key,attempts);
  const immediateSurfaces=['admin_login','admin_2fa','admin_emergency_recovery','backup_restore'];
  const alertThreshold=surface.startsWith('rate_limit_')||immediateSurfaces.includes(surface)?1:3;
  const event={id:`sec_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,createdAt:new Date(now).toISOString(),surface:String(surface).slice(0,80),code:String(code||'FAILED').slice(0,80),email:String(email||'').trim().toLowerCase().slice(0,254)||null,fingerprint,count15m:attempts.length,severity:attempts.length>=alertThreshold?'critical':attempts.length>=3?'warning':'info'};
  const state=operationsStore.store();(state.securityEvents||=[]).unshift(event);state.securityEvents=state.securityEvents.slice(0,500);operationsStore.save();
  if(attempts.length===alertThreshold)notifySuperAdminsSecurity(event,attempts.length);
}
function rateLimit(name,windowMs,maximum,keyFromRequest=()=> ''){
  return async(req,res,next)=>{try{const material=`${name}:${securityFingerprint(req)}:${String(keyFromRequest(req)||'').trim().toLowerCase()}`,key=crypto.createHash('sha256').update(material).digest('hex'),result=await storage.consumeRateLimit(key,windowMs,maximum);res.setHeader('X-RateLimit-Limit',String(maximum));res.setHeader('X-RateLimit-Remaining',String(Math.max(0,maximum-result.count)));if(!result.allowed){res.setHeader('Retry-After',String(Math.max(1,Math.ceil(result.retryAfterMs/1000))));recordSecurityFailure(req,`rate_limit_${name}`,'RATE_LIMITED',keyFromRequest(req));return res.status(429).json({error:'Забагато спроб. Спробуйте пізніше',code:'RATE_LIMITED',retryAfterSec:Math.max(1,Math.ceil(result.retryAfterMs/1000))});}next();}catch(error){console.error('[rate limit]',error.message);res.status(503).json({error:'Захист запитів тимчасово недоступний'});}};
}

// ВАЖЛИВО: вебхук Stripe має отримати "сирий" (не розпарсений) body,
// тому для цього одного маршруту JSON-парсер вимикаємо.
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use('/api/inbound-email', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// =========================================================
// АВТЕНТИФІКАЦІЯ: email -> код -> пароль -> акаунт, і логін
// =========================================================

app.post('/api/auth/request-code',requireFeature('registration','Реєстрацію тимчасово призупинено'),rateLimit('request_code',15*60*1000,10,req=>req.body?.email), async (req, res) => {
  try {
    if(req.body?.avatarDataUrl&&!featureEnabled('photoUploads'))return res.status(503).json({error:'Завантаження фотографій тимчасово вимкнено',code:'FEATURE_DISABLED',feature:'photoUploads'});
    if(req.body?.referralCode&&!featureEnabled('referrals'))return res.status(503).json({error:'Реферальна програма тимчасово вимкнена',code:'FEATURE_DISABLED',feature:'referrals'});
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Введи коректний email' });
    if (operationsStore.store().blacklist.emails.includes(email.toLowerCase())) return res.status(403).json({ error: 'Цей email недоступний для реєстрації' });
    await authService.requestCode(email, req.body?.language, req.body?.referralCode, { displayName: req.body?.displayName, avatarDataUrl: req.body?.avatarDataUrl });
    res.json({ sent: true });
  } catch (err) {
    const status = err.code === 'COOLDOWN' ? 429 : 500;
    res.status(status).json({ error: err.message, code: err.code, waitSec: err.waitSec });
  }
});

app.post('/api/auth/verify-code',rateLimit('verify_code',15*60*1000,15,req=>req.body?.email), (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Потрібні email і code' });
    const result = authService.verifyCode(email, code);
    res.json(result);
  } catch (err) {
    recordSecurityFailure(req,'email_verification_code',err.code,req.body?.email);
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/auth/set-password', async (req, res) => {
  try {
    const { verifyToken, password } = req.body;
    if (!verifyToken || !password) return res.status(400).json({ error: 'Потрібні verifyToken і password' });
    const result = await authService.setPassword(verifyToken, password, req.headers['x-device-name'] || req.headers['user-agent'], req.body?.pin);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/auth/login',rateLimit('user_login',15*60*1000,20,req=>req.body?.email), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Потрібні email і password' });
    const result = await authService.login(email, password, req.headers['x-device-name'] || req.headers['user-agent']);
    if (getUser(result.email)?.status === 'blocked') {
      return res.status(403).json({ error: 'Акаунт заблоковано. Зверніться до підтримки.' });
    }
    res.json(result);
  } catch (err) {
    if(['INVALID_CREDENTIALS','INVALID','BLOCKED'].includes(err.code))recordSecurityFailure(req,'user_login',err.code,req.body?.email);
    res.status(401).json({ error: err.message, code: err.code });
  }
});

app.get('/api/auth/me', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const email = authService.getSessionEmail(sessionToken);
  if (!email) return res.status(401).json({ error: 'Сесія недійсна, увійди знову' });
  res.json({ email });
});

function requireUserSession(req, res, next) {
  const sessionToken = req.headers['x-session-token'];
  const email = authService.getSessionEmail(sessionToken);
  if (!email) return res.status(401).json({ error: 'Сесія недійсна, увійди знову' });
  req.userEmail = email;
  req.sessionToken = sessionToken;
  next();
}

// Security Center: show only the current account's sessions and let the user
// invalidate every other login in one action.
app.get('/api/account/sessions', requireUserSession, (req, res) => {
  res.json({ sessions: authService.listSessions(req.userEmail, req.sessionToken) });
});

app.post('/api/account/sessions/revoke-others', requireUserSession, (req, res) => {
  const revoked = authService.revokeOtherSessions(req.userEmail, req.sessionToken);
  res.json({ ok: true, revoked });
});

const PASSKEY_ORIGIN = String(process.env.PASSKEY_ORIGIN || process.env.FRONTEND_URL || 'https://esimsignalapp.com').replace(/\/$/,'');
let PASSKEY_RP_ID = String(process.env.PASSKEY_RP_ID || '').trim();
if (!PASSKEY_RP_ID) {
  try { PASSKEY_RP_ID = new URL(PASSKEY_ORIGIN).hostname; }
  catch { PASSKEY_RP_ID = 'esimsignalapp.com'; }
}
app.post('/api/account/passkeys/register/options', requireUserSession, async (req,res) => {
  const user=getUser(req.userEmail); const passkeys=user?.passkeys||[];
  const options=await generateRegistrationOptions({rpName:'Signal eSIM',rpID:PASSKEY_RP_ID,userName:req.userEmail,userID:Buffer.from(req.userEmail),attestationType:'none',excludeCredentials:passkeys.map(p=>({id:p.id,transports:p.transports})),authenticatorSelection:{authenticatorAttachment:'platform',residentKey:'required',userVerification:'required'}});
  saveUser(req.userEmail,{passkeyChallenge:options.challenge}); res.json(options);
});
app.post('/api/account/passkeys/register/verify', requireUserSession, async (req,res) => {
  try { const user=getUser(req.userEmail); const verification=await verifyRegistrationResponse({response:req.body,expectedChallenge:user?.passkeyChallenge,expectedOrigin:PASSKEY_ORIGIN,expectedRPID:PASSKEY_RP_ID,requireUserVerification:true}); if(!verification.verified||!verification.registrationInfo) throw new Error('Face ID не підтверджено'); const c=verification.registrationInfo.credential; saveUser(req.userEmail,{passkeys:[...(user.passkeys||[]),{id:c.id,publicKey:Buffer.from(c.publicKey).toString('base64url'),counter:c.counter,transports:c.transports||[],createdAt:new Date().toISOString()}],passkeyChallenge:null}); res.json({ok:true}); } catch(e){res.status(400).json({error:e.message});}
});
function pinResetPublicView(item){
  if(!item)return null;
  const [name='',domain='']=String(item.email||'').split('@');
  const maskedEmail=domain?`${name.slice(0,2)}${'*'.repeat(Math.max(2,Math.min(8,name.length-2)))}@${domain}`:'';
  return {id:item.id,status:item.status,requestedAt:item.requestedAt,decidedAt:item.decidedAt||null,expiresAt:item.expiresAt||null,completedAt:item.completedAt||null,emailCodeSent:Boolean(item.emailCodeHash&&item.emailCodeExpiresAt&&new Date(item.emailCodeExpiresAt)>new Date()),emailCodeExpiresAt:item.emailCodeExpiresAt||null,maskedEmail};
}
function latestPinResetRequest(email){
  return (operationsStore.store().pinResetRequests||[]).find(item=>item.email===email)||null;
}
async function issuePinResetEmailCode(item){
  const code=String(crypto.randomInt(100000,1000000));
  item.emailCodeHash=await bcrypt.hash(code,10);item.emailCodeAttempts=0;item.emailCodeSentAt=new Date().toISOString();item.emailCodeExpiresAt=new Date(Date.now()+10*60*1000).toISOString();item.updatedAt=item.emailCodeSentAt;
  try{
    const delivery=await sendEmail({to:item.email,subject:'Код для відновлення PIN — Signal',html:emailTemplates.verificationCode({code})});
    if(delivery?.mocked){item.emailCodeHash=null;item.emailCodeExpiresAt=null;return false;}
    return true;
  }catch(error){item.emailCodeHash=null;item.emailCodeExpiresAt=null;throw error;}
}
app.get('/api/account/lock', requireUserSession, (req,res)=>{const u=getUser(req.userEmail),reset=latestPinResetRequest(req.userEmail);res.json({enabled:Boolean(u?.appLock?.enabled),hasPin:Boolean(u?.appLock?.pinHash),hasPasskey:Boolean(u?.passkeys?.length),resetApproved:Boolean(reset?.status==='approved'&&reset.expiresAt&&new Date(reset.expiresAt)>new Date())});});
app.put('/api/account/lock', requireUserSession, async (req,res)=>{const pin=String(req.body?.pin||''); if(!/^\d{6}$/.test(pin))return res.status(400).json({error:'PIN має містити рівно 6 цифр'}); saveUser(req.userEmail,{appLock:{enabled:true,pinHash:await bcrypt.hash(pin,10)}});res.json({ok:true});});
app.post('/api/account/lock/pin', requireUserSession, async (req,res)=>{const hash=getUser(req.userEmail)?.appLock?.pinHash;if(!hash||!await bcrypt.compare(String(req.body?.pin||''),hash)){recordSecurityFailure(req,'app_pin','INVALID_PIN',req.userEmail);return res.status(401).json({error:'Невірний PIN'});}res.json({ok:true});});

app.get('/api/account/lock/reset-request',requireUserSession,async(req,res)=>{
  await operationsStore.refresh();
  const item=latestPinResetRequest(req.userEmail);
  if(item?.status==='approved'&&item.expiresAt&&new Date(item.expiresAt)<=new Date()){
    item.status='expired';item.updatedAt=new Date().toISOString();await operationsStore.saveNow();
  }
  res.json({request:pinResetPublicView(item)});
});
app.post('/api/account/lock/reset-request',requireUserSession,rateLimit('app_pin_reset_request',24*60*60*1000,3,req=>req.userEmail),async(req,res)=>{
  await operationsStore.refresh();
  const user=getUser(req.userEmail);
  if(!user?.appLock?.enabled||!user?.appLock?.pinHash)return res.status(409).json({error:'PIN-захист для цього акаунта не увімкнений'});
  const state=operationsStore.store();
  const existing=(state.pinResetRequests||[]).find(item=>item.email===req.userEmail&&item.status==='pending');
  if(existing){
    if(!existing.emailCodeHash||!existing.emailCodeExpiresAt||new Date(existing.emailCodeExpiresAt)<=new Date()){
      try{await issuePinResetEmailCode(existing);await operationsStore.saveNow();}catch(error){console.error('[pin reset code email]',error.message);}
    }
    return res.json({ok:true,request:pinResetPublicView(existing)});
  }
  const now=new Date().toISOString(),item={id:`pin_reset_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,email:req.userEmail,status:'pending',requestedAt:now,updatedAt:now};
  (state.pinResetRequests||=[]).unshift(item);state.pinResetRequests=state.pinResetRequests.slice(0,1000);
  try{await issuePinResetEmailCode(item);}catch(error){console.error('[pin reset code email]',error.message);}
  await operationsStore.saveNow();
  const recipients=adminAuth.listAdmins().filter(admin=>admin.role==='super_admin'&&!admin.blocked);
  for(const admin of recipients){
    sendEmail({to:admin.email,subject:'Запит на відновлення PIN — Signal Admin',html:emailTemplates.notification({title:'Користувач забув PIN',message:`${req.userEmail} надіслав запит на безпечне відновлення PIN. Старий PIN не передається. Перевірте запит і підтвердьте дію лише якщо впевнені, що це власник акаунта.`,actionUrl:'/admin-pin-resets.html',actionLabel:'Перевірити запит'})}).catch(error=>console.error('[pin reset email]',error.message));
    sendToEmail(`admin:${admin.email}`,{title:'Запит на відновлення PIN',body:`${req.userEmail} очікує перевірки.`,url:'/admin-pin-resets.html',tag:`pin-reset-${item.id}`}).catch(()=>{});
  }
  auditStore.log({adminEmail:'system',action:'app_pin_reset_requested',target:req.userEmail,details:{requestId:item.id}});
  res.status(201).json({ok:true,request:pinResetPublicView(item)});
});
app.post('/api/account/lock/reset-request/email-code',requireUserSession,rateLimit('app_pin_reset_email_code',60*60*1000,3,req=>req.userEmail),async(req,res)=>{
  await operationsStore.refresh();
  const item=latestPinResetRequest(req.userEmail);
  if(!item||item.status!=='pending')return res.status(409).json({error:'Спочатку надішліть запит на відновлення PIN'});
  try{const sent=await issuePinResetEmailCode(item);await operationsStore.saveNow();if(!sent)return res.status(503).json({error:'Email-сервіс ще не налаштований. Запит уже бачить адміністратор'});res.json({ok:true,request:pinResetPublicView(item)});}catch(error){console.error('[pin reset resend email]',error.message);res.status(502).json({error:'Не вдалося надіслати код. Запит уже бачить адміністратор'});}
});
app.post('/api/account/lock/reset-request/verify-code',requireUserSession,rateLimit('app_pin_reset_verify_code',15*60*1000,10,req=>req.userEmail),async(req,res)=>{
  await operationsStore.refresh();
  const item=latestPinResetRequest(req.userEmail),code=String(req.body?.code||'').trim();
  if(!item||item.status!=='pending')return res.status(409).json({error:'Активного запиту на відновлення немає'});
  if(!/^\d{6}$/.test(code))return res.status(400).json({error:'Введіть 6 цифр із листа'});
  if(!item.emailCodeHash||!item.emailCodeExpiresAt||new Date(item.emailCodeExpiresAt)<=new Date())return res.status(410).json({error:'Код прострочено. Надішліть новий'});
  item.emailCodeAttempts=Number(item.emailCodeAttempts||0)+1;
  if(item.emailCodeAttempts>5){item.emailCodeHash=null;item.emailCodeExpiresAt=null;await operationsStore.saveNow();return res.status(429).json({error:'Забагато спроб. Надішліть новий код'});}
  if(!await bcrypt.compare(code,item.emailCodeHash)){await operationsStore.saveNow();recordSecurityFailure(req,'app_pin_reset_code','INVALID_CODE',req.userEmail);return res.status(401).json({error:'Невірний код'});}
  const decidedAt=new Date(),expiresAt=new Date(decidedAt.getTime()+30*60*1000);
  Object.assign(item,{status:'approved',decidedAt:decidedAt.toISOString(),decidedBy:'email_verification',expiresAt:expiresAt.toISOString(),emailCodeHash:null,emailCodeExpiresAt:null,updatedAt:decidedAt.toISOString()});
  await operationsStore.saveNow();auditStore.log({adminEmail:'email_verification',action:'app_pin_reset_email_verified',target:item.email,details:{requestId:item.id,expiresAt:item.expiresAt}});
  res.json({ok:true,request:pinResetPublicView(item)});
});
app.post('/api/account/lock/reset-complete',requireUserSession,rateLimit('app_pin_reset_complete',15*60*1000,10,req=>req.userEmail),async(req,res)=>{
  await operationsStore.refresh();
  const pin=String(req.body?.pin||''),confirmation=String(req.body?.confirmation||'');
  if(!/^\d{6}$/.test(pin))return res.status(400).json({error:'Новий PIN має містити рівно 6 цифр'});
  if(pin!==confirmation)return res.status(400).json({error:'PIN-коди не збігаються'});
  const item=latestPinResetRequest(req.userEmail);
  if(!item||item.status!=='approved')return res.status(403).json({error:'Скидання PIN ще не підтверджено адміністратором'});
  if(!item.expiresAt||new Date(item.expiresAt)<=new Date()){item.status='expired';item.updatedAt=new Date().toISOString();await operationsStore.saveNow();return res.status(410).json({error:'Дозвіл на скидання завершився. Надішліть новий запит'});}
  const completedAt=new Date().toISOString();
  saveUser(req.userEmail,{appLock:{enabled:true,pinHash:await bcrypt.hash(pin,10),resetCompletedAt:completedAt}});
  item.status='completed';item.completedAt=completedAt;item.updatedAt=completedAt;item.emailCodeHash=null;item.emailCodeExpiresAt=null;await operationsStore.saveNow();
  authService.revokeOtherSessions(req.userEmail,req.sessionToken);
  auditStore.log({adminEmail:item.decidedBy||'system',action:'app_pin_reset_completed',target:req.userEmail,details:{requestId:item.id}});
  res.json({ok:true});
});

app.get('/api/admin/pin-reset-requests',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('security.manage'),async(req,res)=>{
  await operationsStore.refresh();
  const items=(operationsStore.store().pinResetRequests||[]).map(item=>({id:item.id,email:item.email,status:item.status,requestedAt:item.requestedAt,decidedAt:item.decidedAt||null,decidedBy:item.decidedBy||null,expiresAt:item.expiresAt||null,completedAt:item.completedAt||null}));
  res.json({items,summary:{pending:items.filter(item=>item.status==='pending').length,approved:items.filter(item=>item.status==='approved').length,completed:items.filter(item=>item.status==='completed').length}});
});
app.post('/api/admin/pin-reset-requests/:id/approve',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('security.manage',{requireTwoFactor:true}),async(req,res)=>{
  await operationsStore.refresh();
  const state=operationsStore.store(),item=(state.pinResetRequests||[]).find(entry=>entry.id===req.params.id);
  if(!item)return res.status(404).json({error:'Запит не знайдено'});
  if(item.status!=='pending')return res.status(409).json({error:'Цей запит уже опрацьовано'});
  const user=getUser(item.email);if(!user)return res.status(404).json({error:'Акаунт користувача не знайдено'});
  const decidedAt=new Date(),expiresAt=new Date(decidedAt.getTime()+30*60*1000);
  Object.assign(item,{status:'approved',decidedAt:decidedAt.toISOString(),decidedBy:req.admin.email,expiresAt:expiresAt.toISOString(),emailCodeHash:null,emailCodeExpiresAt:null,updatedAt:decidedAt.toISOString()});
  await operationsStore.saveNow();
  auditStore.log({adminEmail:req.admin.email,action:'app_pin_reset_approved',target:item.email,details:{requestId:item.id,expiresAt:item.expiresAt}});
  sendEmail({to:item.email,subject:'Відновлення PIN підтверджено — Signal',html:emailTemplates.notification({title:'Можна створити новий PIN',message:'Адміністратор підтвердив відновлення. Відкрийте Signal протягом 30 хвилин і створіть новий 6-значний PIN на захищеному екрані.',actionUrl:'/dashboard.html',actionLabel:'Відкрити Signal'})}).catch(error=>console.error('[pin reset approved email]',error.message));
  sendToEmail(item.email,{title:'Відновлення PIN підтверджено',body:'Відкрийте Signal протягом 30 хвилин і створіть новий PIN.',url:'/dashboard.html',tag:`pin-reset-approved-${item.id}`}).catch(()=>{});
  res.json({ok:true,item:pinResetPublicView(item)});
});
app.post('/api/admin/pin-reset-requests/:id/deny',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('security.manage',{requireTwoFactor:true}),async(req,res)=>{
  await operationsStore.refresh();
  const item=(operationsStore.store().pinResetRequests||[]).find(entry=>entry.id===req.params.id);
  if(!item)return res.status(404).json({error:'Запит не знайдено'});
  if(item.status!=='pending')return res.status(409).json({error:'Цей запит уже опрацьовано'});
  const decidedAt=new Date().toISOString();Object.assign(item,{status:'denied',decidedAt,decidedBy:req.admin.email,emailCodeHash:null,emailCodeExpiresAt:null,updatedAt:decidedAt});await operationsStore.saveNow();
  auditStore.log({adminEmail:req.admin.email,action:'app_pin_reset_denied',target:item.email,details:{requestId:item.id}});
  sendEmail({to:item.email,subject:'Запит на відновлення PIN відхилено — Signal',html:emailTemplates.notification({title:'Запит на відновлення відхилено',message:'Адміністратор не зміг підтвердити цей запит. Якщо це були ви, зверніться до підтримки для перевірки власника акаунта.',actionUrl:'/support.html',actionLabel:'Написати в підтримку'})}).catch(()=>{});
  res.json({ok:true,item:pinResetPublicView(item)});
});

app.put('/api/account/profile', requireUserSession, async (req, res) => {
  try {
    if(Object.prototype.hasOwnProperty.call(req.body||{},'avatarDataUrl')&&!featureEnabled('photoUploads'))return res.status(503).json({error:'Завантаження фотографій тимчасово вимкнено',code:'FEATURE_DISABLED',feature:'photoUploads'});
    const result = await authService.updateAccount(req.userEmail, req.body || {});
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

app.get('/api/account/preferences', requireUserSession, (req, res) => {
  const preferences = getUser(req.userEmail)?.preferences || {};
  res.json({ trafficAlertThresholds: preferences.trafficAlertThresholds || [50, 80, 95], marketingEmails:preferences.marketingEmails===true, language: getUser(req.userEmail)?.language || 'uk' });
});

app.post('/api/account/diagnostics', requireUserSession, (req, res) => {
  const { type, severity, page, message, context } = req.body || {};
  if (!type || String(type).length > 80) return res.status(400).json({ error:'Некоректний тип події' });
  diagnosticsStore.add({ email:req.userEmail, source:'client', type, severity, page, message, action:context?.action||context?.path||null, outcome:context?.outcome||null, requestId:context?.requestId||req.requestId, durationMs:context?.durationMs, errorCode:context?.status?`HTTP_${context.status}`:null, context });
  res.status(202).json({ ok:true });
});

async function localizedAnnouncements(email) {
  await operationsStore.refresh();
  const announcements = operationsStore.activeAnnouncements(email);
  const userLanguage = getUser(email)?.language || 'uk';
  if (userLanguage !== 'en') return announcements;
  return Promise.all(announcements.map(async (announcement) => ({
    ...announcement,
    title: await translationService.translate(announcement.title, 'en'),
    message: await translationService.translate(announcement.message, 'en'),
  })));
}

app.get('/api/account/announcements', requireUserSession, async (req, res) => res.json({ announcements: await localizedAnnouncements(req.userEmail) }));
// General announcements are public by design so the app can show maintenance
// notices before a saved login session has been restored.
app.get('/api/announcements', async (req, res) => res.json({ announcements: await localizedAnnouncements(req.query.email || null) }));

app.put('/api/account/preferences', requireUserSession, (req, res) => {
  const raw = req.body?.trafficAlertThresholds;
  const language = req.body?.language;
  const marketingEmails=req.body?.marketingEmails;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((value) => !Number.isInteger(value) || value < 1 || value > 100))) {
    return res.status(400).json({ error: 'Вкажи коректні пороги від 1 до 100' });
  }
  if (language !== undefined && !['uk','en'].includes(language)) return res.status(400).json({ error: 'Некоректна мова' });
  const trafficAlertThresholds = raw === undefined ? null : [...new Set(raw)].sort((a, b) => a - b);
  const user = getUser(req.userEmail);
  if(marketingEmails!==undefined&&typeof marketingEmails!=='boolean')return res.status(400).json({error:'Некоректне налаштування email'});
  saveUser(req.userEmail, { ...(language ? { language } : {}), preferences: { ...(user?.preferences || {}), ...(trafficAlertThresholds ? { trafficAlertThresholds } : {}),...(marketingEmails!==undefined?{marketingEmails}:{}) } });
  res.json({ ok: true, trafficAlertThresholds: trafficAlertThresholds || user?.preferences?.trafficAlertThresholds || [50,80,95],marketingEmails:marketingEmails??user?.preferences?.marketingEmails===true, language: language || user?.language || 'uk' });
});

function safeTravelMode(value={}) {
  const destination=String(value.destination||'').replace(/[\r\n<>]/g,' ').trim().slice(0,80);
  const startDate=String(value.startDate||'').slice(0,10);
  const endDate=String(value.endDate||'').slice(0,10);
  const deviceModel=String(value.deviceModel||'').replace(/[\r\n<>]/g,' ').trim().slice(0,100);
  const platform=['iphone','android','other'].includes(value.platform)?value.platform:'other';
  return {enabled:value.enabled!==false,destination,startDate,endDate,deviceModel,platform,reminders:value.reminders&&typeof value.reminders==='object'?value.reminders:{},updatedAt:new Date().toISOString()};
}

app.get('/api/account/travel-mode', requireUserSession, (req,res) => {
  const user=getUser(req.userEmail);
  res.json({travelMode:user?.travelMode||null,readiness:{hasEsim:Boolean(user?.esim?.orderNo),hasActivation:Boolean(user?.esim?.activationCode||user?.esim?.qrCodeUrl),hasPush:pushStore.subscriptionsFor(req.userEmail).length>0,hasOfflineCard:Boolean(user?.esim?.offlineSavedAt),expiresAt:user?.esim?.expiredTime||null}});
});

app.put('/api/account/travel-mode', requireUserSession, (req,res) => {
  const travelMode=safeTravelMode(req.body||{});
  if(!travelMode.destination||!/^\d{4}-\d{2}-\d{2}$/.test(travelMode.startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(travelMode.endDate))return res.status(400).json({error:'Вкажіть напрямок і коректні дати подорожі'});
  const start=new Date(`${travelMode.startDate}T00:00:00Z`),end=new Date(`${travelMode.endDate}T23:59:59Z`);
  if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<start)return res.status(400).json({error:'Дата повернення має бути після дати початку'});
  if(start.getTime()<Date.now()-24*3600000||end.getTime()>Date.now()+730*24*3600000)return res.status(400).json({error:'Оберіть майбутню подорож у межах двох років'});
  const existing=getUser(req.userEmail)?.travelMode||{};
  travelMode.reminders=existing.startDate===travelMode.startDate?existing.reminders||{}:{};
  saveUser(req.userEmail,{travelMode});
  refreshGoogleWallet(req.userEmail);
  res.json({ok:true,travelMode});
});

app.delete('/api/account/travel-mode', requireUserSession, (req,res) => {
  saveUser(req.userEmail,{travelMode:null});
  refreshGoogleWallet(req.userEmail);
  res.json({ok:true});
});

app.get('/api/account/passport',requireUserSession,(req,res)=>{
  const user=syncEngagementForUser(req.userEmail);
  const stamps=engagement.passportFor(user);
  if(JSON.stringify(stamps)!==JSON.stringify(user.passport?.stamps||[]))saveUser(req.userEmail,{passport:{...(user.passport||{}),stamps,lastSyncedAt:new Date().toISOString()}});
  res.json({stamps,totalCountries:new Set(stamps.map(item=>item.countryCode)).size,totalTrips:stamps.length,shareCard:{name:user.displayName||'Signal Traveler',level:engagement.publicClub(user,operationsStore.store().engagementSettings||{}).tier.name}});
});

app.post('/api/account/passport/sync',requireUserSession,rateLimit('passport_sync',15*60*1000,10,req=>req.userEmail),(req,res)=>{
  const user=getUser(req.userEmail)||{},stamps=engagement.passportFor(user);
  saveUser(req.userEmail,{passport:{...(user.passport||{}),stamps,lastSyncedAt:new Date().toISOString()}});
  res.json({ok:true,stamps,totalCountries:new Set(stamps.map(item=>item.countryCode)).size});
});

app.get('/api/account/club',requireUserSession,(req,res)=>res.json(engagement.publicClub(syncEngagementForUser(req.userEmail),operationsStore.store().engagementSettings||{})));

app.post('/api/account/club/redeem',requireUserSession,rateLimit('club_redeem',60*60*1000,8,req=>req.userEmail),(req,res)=>{
  try{const user=getUser(req.userEmail)||{},result=engagement.redeem(user,String(req.body?.rewardId||''),operationsStore.store().engagementSettings||{});saveUser(req.userEmail,{loyalty:result.loyalty});res.json({ok:true,reward:result.reward,club:engagement.publicClub({...user,loyalty:result.loyalty},operationsStore.store().engagementSettings||{})});}
  catch(error){res.status(error.code==='POINTS_INSUFFICIENT'?409:404).json({error:error.message,code:error.code});}
});

app.get('/api/account/usage-insights',requireUserSession,(req,res)=>res.json(engagement.usageInsights(getUser(req.userEmail)||{})));

app.get('/api/account/smart-assist',requireUserSession,(req,res)=>{
  const user=getUser(req.userEmail)||{},preference=user.smartAssist||{enabled:false,thresholdGb:1,maxMonthlySpendCents:2000};
  res.json({preference,insights:engagement.usageInsights(user),requiresConfirmation:true,explanation:'Signal попереджає та відкриває захищену оплату. Картка не списується без підтвердження.'});
});
app.put('/api/account/smart-assist',requireUserSession,(req,res)=>{
  const thresholdGb=Number(req.body?.thresholdGb),maxMonthlySpendCents=Math.trunc(Number(req.body?.maxMonthlySpendCents));
  if(!Number.isFinite(thresholdGb)||thresholdGb<.1||thresholdGb>10||!Number.isInteger(maxMonthlySpendCents)||maxMonthlySpendCents<500||maxMonthlySpendCents>50000)return res.status(400).json({error:'Вкажіть поріг 0,1–10 ГБ і місячний ліміт від $5 до $500'});
  const preference={enabled:req.body?.enabled===true,thresholdGb:+thresholdGb.toFixed(2),maxMonthlySpendCents,requiresConfirmation:true,updatedAt:new Date().toISOString()};saveUser(req.userEmail,{smartAssist:preference});res.json({ok:true,preference});
});

app.get('/api/account/family-trips',requireUserSession,(req,res)=>res.json({trips:getUser(req.userEmail)?.familyTrips||[],availableEsims:(getUser(req.userEmail)?.sharedEsims||[]).map(item=>({id:item.id,recipientName:item.recipientName,packageName:item.packageName,status:item.share?.installedAt?'installed':item.share?.viewedAt?'opened':item.share?'shared':'ready'}))}));
app.post('/api/account/family-trips',requireUserSession,rateLimit('family_trip_write',60*60*1000,20,req=>req.userEmail),(req,res)=>{
  try{const user=getUser(req.userEmail)||{},trips=[...(user.familyTrips||[])],trip=engagement.safeFamilyTrip(req.body||{});trips.unshift(trip);saveUser(req.userEmail,{familyTrips:trips.slice(0,20)});res.json({ok:true,trip});}catch(error){res.status(400).json({error:error.message,code:error.code});}
});
app.put('/api/account/family-trips/:id',requireUserSession,(req,res)=>{
  try{const user=getUser(req.userEmail)||{},trips=[...(user.familyTrips||[])],index=trips.findIndex(item=>item.id===req.params.id);if(index<0)return res.status(404).json({error:'Подорож не знайдено'});trips[index]=engagement.safeFamilyTrip(req.body||{},trips[index]);saveUser(req.userEmail,{familyTrips:trips});res.json({ok:true,trip:trips[index]});}catch(error){res.status(400).json({error:error.message,code:error.code});}
});
app.delete('/api/account/family-trips/:id',requireUserSession,(req,res)=>{const user=getUser(req.userEmail)||{},trips=(user.familyTrips||[]).filter(item=>item.id!==req.params.id);if(trips.length===(user.familyTrips||[]).length)return res.status(404).json({error:'Подорож не знайдено'});saveUser(req.userEmail,{familyTrips:trips});res.json({ok:true});});

app.get('/api/account/wallet-pass',requireUserSession,async(req,res)=>{
  const user=getUser(req.userEmail)||{},card=engagement.walletCard(user),base=String(process.env.FRONTEND_URL||'').replace(/\/$/,'');
  const google=await googleWallet.createPass(card);
  res.json({card,google:{status:google.status,configured:google.configured,missing:google.missing||[],expiresAt:google.expiresAt||null},googleUrl:google.url,appleUrl:process.env.APPLE_WALLET_PASS_URL||null,offlineUrl:`${base}/offline-esim.html`,privacy:'Wallet-картка не містить email, QR, ICCID, PIN або коду активації.'});
});

app.get('/api/account/rescue',requireUserSession,(req,res)=>{const user=getUser(req.userEmail)||{};res.json({diagnostics:engagement.safeRescueDiagnostics(user,{}),insights:engagement.usageInsights(user),checks:{hasEsim:Boolean(user.esim?.orderNo),hasApn:Boolean(user.esim?.apn),hasRecentSync:Boolean(user.esim?.lastUpdateTime&&Date.now()-new Date(user.esim.lastUpdateTime)<24*3600000),hasPaidPurchase:Boolean((user.purchases||[]).some(item=>item.paymentStatus==='paid'))}});});
app.post('/api/account/rescue/credit-request',requireUserSession,rateLimit('rescue_credit',24*60*60*1000,2,req=>req.userEmail),(req,res)=>{
  const user=getUser(req.userEmail)||{},state=operationsStore.store(),existing=(state.rescueRequests||[]).find(item=>item.email===req.userEmail&&item.status==='pending');if(existing)return res.status(409).json({error:'Запит уже передано команді',request:existing});
  const request={id:engagement.id('rescue'),email:req.userEmail,reason:String(req.body?.reason||'connection_failure').slice(0,60),note:String(req.body?.note||'').replace(/[\r\n<>]/g,' ').trim().slice(0,500),diagnostics:engagement.safeRescueDiagnostics(user,req.body?.diagnostics||{}),status:'pending',createdAt:new Date().toISOString()};(state.rescueRequests||=[]).unshift(request);state.rescueRequests=state.rescueRequests.slice(0,1000);operationsStore.save();auditStore.log({adminEmail:req.userEmail,action:'rescue_credit_requested',target:request.id,details:{purchaseId:request.diagnostics.purchaseId}});res.json({ok:true,request});
});

app.post('/api/translations/batch', requireUserSession, rateLimit('ui_translation',60*1000,20,req=>req.userEmail), async (req,res) => {
  const language = getUser(req.userEmail)?.language || 'uk';
  if (language !== 'en') return res.json({ translations: {}, enabled:false });
  const texts = Array.isArray(req.body?.texts) ? [...new Set(req.body.texts.map(value=>String(value||'').trim()).filter(value=>value && value.length<=300))].slice(0,40) : [];
  if (!texts.length) return res.json({ translations:{}, enabled:translationService.enabled() });
  const translated = await translationService.translateBatch(texts,'en');
  res.json({ translations:Object.fromEntries(Object.entries(translated).filter(([source,target])=>target && target!==source)), enabled:translationService.enabled() });
});

app.get('/api/account/usage-history', requireUserSession, (req, res) => {
  res.json({ history: getUser(req.userEmail)?.esim?.usageHistory || [] });
});

app.get('/api/account/referral', requireUserSession, requireFeature('referrals','Реферальна програма тимчасово призупинена'), (req, res) => {
  const user = getUser(req.userEmail);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  const referralCode = user.referralCode || crypto.randomBytes(4).toString('hex').toUpperCase();
  if (!user.referralCode) saveUser(req.userEmail, { referralCode });
  res.json({ code: referralCode, referrals: user.referrals || [] });
});

app.get('/api/account/referral-status', requireUserSession, (req, res) => {
  const user = getUser(req.userEmail);
  res.json({ referredBy: user?.referredBy || null, rewardStatus: user?.referralRewardStatus || null, rewardPackageCode: user?.referralRewardPackageCode || null });
});

app.post('/api/account/feedback', requireUserSession, (req, res) => {
  const rating = Number(req.body?.rating);
  const message = String(req.body?.message || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || message.length > 1000) return res.status(400).json({ error: 'Некоректний відгук' });
  const operations = operationsStore.store();
  const tags=(Array.isArray(req.body?.tags)?req.body.tags:[]).filter(tag=>['design','esim','payment','speed','translation','support'].includes(tag)).slice(0,6);
  const item={ id: Date.now().toString(36), email: req.userEmail, rating, message, tags, status:'new', assignedTo:null, createdAt: new Date().toISOString() };
  (operations.feedback ||= []).unshift(item);
  operationsStore.save();
  if(rating<=2)for(const admin of adminAuth.listAdmins().filter(a=>a.role==='super_admin'&&!a.blocked))sendEmail({to:admin.email,subject:`Низька оцінка ${rating}/5 — Signal`,html:emailTemplates.notification({title:'Користувач залишив низьку оцінку',message:`${req.userEmail}: ${message||'без коментаря'}`,actionUrl:'/admin-feedback.html',actionLabel:'Переглянути відгук'})}).catch(()=>{});
  res.json({ ok: true });
});

app.get('/api/admin/feedback', adminAuth.requireAdmin, (req,res) => {
  const ratingFilter = Number(req.query.rating || 0);
  const items = (operationsStore.store().feedback || []).filter(item=>!ratingFilter || item.rating===ratingFilter).map(item=>{
    const user=getUser(item.email)||{};
    return {...item,displayName:user.displayName||'',avatarDataUrl:user.avatarDataUrl||null};
  });
  const all=operationsStore.store().feedback||[];
  const average=all.length?all.reduce((sum,item)=>sum+Number(item.rating||0),0)/all.length:0;
  res.json({items,summary:{total:all.length,average:Number(average.toFixed(2)),distribution:Object.fromEntries([1,2,3,4,5].map(rating=>[rating,all.filter(item=>item.rating===rating).length])),byStatus:Object.fromEntries(['new','reviewed','planned','done'].map(status=>[status,all.filter(item=>(item.status||'new')===status).length])),byTag:Object.fromEntries(['design','esim','payment','speed','translation','support'].map(tag=>[tag,all.filter(item=>(item.tags||[]).includes(tag)).length]))}});
});
app.patch('/api/admin/feedback/:id',adminAuth.requireAdmin,adminAuth.requirePermission('operations.manage'),(req,res)=>{const item=(operationsStore.store().feedback||[]).find(x=>x.id===req.params.id);if(!item)return res.status(404).json({error:'Відгук не знайдено'});if(req.body?.status&&['new','reviewed','planned','done'].includes(req.body.status))item.status=req.body.status;if(req.body?.assignedTo!==undefined)item.assignedTo=String(req.body.assignedTo||'').slice(0,254)||null;if(req.body?.createTask){item.task={id:`feedback_${item.id}`,title:String(req.body.taskTitle||item.message||'Опрацювати відгук').slice(0,200),status:'open',createdAt:new Date().toISOString(),createdBy:req.admin.email};}item.updatedAt=new Date().toISOString();operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'feedback_updated',target:item.id,details:{status:item.status,assignedTo:item.assignedTo,task:Boolean(item.task)}});res.json(item);});

app.get('/api/service-status', async (req, res) => {
  await operationsStore.refresh();
  const maintenance = operationsStore.activeAnnouncements(null).find((item) => item.type === 'maintenance');
  res.set('Cache-Control','no-store, no-cache, must-revalidate');
  res.json({ status: maintenance ? 'maintenance' : 'operational', maintenanceId:maintenance?.id||null, title:maintenance?.title||null, message: maintenance?.message || null, expiresAt:maintenance?.expiresAt||null, checkedAt: new Date().toISOString() });
});

app.get('/api/travel-packages', requireUserSession, requireFeature('travelPackages','Пакети для подорожей тимчасово недоступні'), rateLimit('travel_catalog',60*1000,30,req=>req.userEmail), async (req,res) => {
  const started=Date.now();
  try {
    const query=String(req.query.q||'').trim().toLowerCase().slice(0,80);
    const location=String(req.query.location||'').trim().toLowerCase().slice(0,160);
    const data=String(req.query.data||'all');
    const duration=String(req.query.duration||'all');
    let packages=(await getTravelPackages()).filter(packageAllowed);
    const locations=[...new Set(packages.map(item=>item.location).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'uk')).slice(0,300);
    if(location) packages=packages.filter(item=>item.location.toLowerCase()===location);
    if(query) packages=packages.filter(item=>`${item.name} ${item.location} ${item.description}`.toLowerCase().includes(query));
    if(data==='1') packages=packages.filter(item=>item.dataLimitGb!=null&&item.dataLimitGb<=1.2);
    if(data==='2_3') packages=packages.filter(item=>item.dataLimitGb>1.2&&item.dataLimitGb<=3.2);
    if(data==='5_10') packages=packages.filter(item=>item.dataLimitGb>3.2&&item.dataLimitGb<=10.5);
    if(data==='20_30') packages=packages.filter(item=>item.dataLimitGb>10.5&&item.dataLimitGb<=30.5);
    if(data==='50_plus') packages=packages.filter(item=>item.dataLimitGb>30.5&&!item.unlimited);
    if(data==='unlimited') packages=packages.filter(item=>item.unlimited);
    if(duration==='7') packages=packages.filter(item=>item.durationDays<=7);
    if(duration==='15') packages=packages.filter(item=>item.durationDays>7&&item.durationDays<=15);
    if(duration==='30') packages=packages.filter(item=>item.durationDays>15&&item.durationDays<=30);
    if(duration==='long') packages=packages.filter(item=>item.durationDays>30);
    const total=packages.length,visible=packages.slice(0,200);
    recordDiagnostic(req,{email:req.userEmail,type:'catalog_flow',action:'travel_catalog_loaded',outcome:'success',severity:'info',message:'Travel package catalogue loaded',durationMs:Date.now()-started,context:{query:Boolean(query),location:location||null,data,duration,resultCount:visible.length,total}});
    res.json({packages:visible,locations,total,updatedAt:new Date(travelPackageCache.createdAt).toISOString()});
  } catch(error) {
    recordDiagnostic(req,{email:req.userEmail,type:'catalog_flow',action:'travel_catalog_load',outcome:'failed',severity:'error',message:'Travel package catalogue failed',errorCode:error.code||'CATALOG_PROVIDER_ERROR',durationMs:Date.now()-started,context:{provider:'esim_access',status:error.status||null}});
    console.error('[travel packages]',error.message);
    res.status(502).json({error:'Не вдалося завантажити актуальні пакети eSIM Access'});
  }
});

app.post('/api/travel-packages/checkout', requireUserSession, requireFeature('travelPackages'), requireFeature('cardPayments','Оплати тимчасово призупинено'), requireProviderCapacity, rateLimit('travel_checkout',60*60*1000,10,req=>req.userEmail), async (req,res) => {
  const started=Date.now();
  try {
    const currentUser=getUser(req.userEmail);
    const recipientMode=String(req.body?.purchaseFor||'self')==='family'?'family':'self';
    const recipientName=recipientMode==='family'?String(req.body?.recipientName||'').replace(/[\r\n<>]/g,' ').trim().slice(0,60):'';
    if(recipientMode==='family'&&(recipientName.length<2||recipientName.length>60))return res.status(400).json({error:'Вкажи ім’я близької людини — від 2 до 60 символів.',code:'RECIPIENT_NAME_INVALID'});
    const hasActiveEsim=recipientMode==='self'&&Boolean(currentUser?.esim&&['active','payment_confirmed','renewal_failed'].includes(currentUser.status));
    const changeMode=hasActiveEsim?String(req.body?.changeMode||''):'';
    if(hasActiveEsim&&!['immediate','after_expiry'].includes(changeMode)){recordDiagnostic(req,{email:req.userEmail,type:'plan_change',action:'change_mode_required',outcome:'blocked',severity:'warning',message:'Plan change mode is required',errorCode:'CHANGE_MODE_REQUIRED'});return res.status(409).json({error:'Вибери: змінити зараз або після завершення поточного тарифу.',code:'CHANGE_MODE_REQUIRED'});}
    if(recipientMode==='self'&&currentUser?.pendingPlanChange){return res.status(409).json({error:'Вже є оплачена відкладена зміна тарифу. Її можна перевірити в профілі або через підтримку.',code:'PLAN_CHANGE_ALREADY_PENDING'});}
    const packageCode=String(req.body?.packageCode||'').trim();
    if(!/^[A-Za-z0-9_-]{3,80}$/.test(packageCode)){recordDiagnostic(req,{email:req.userEmail,type:'payment_flow',action:'travel_checkout',outcome:'blocked',severity:'warning',message:'Invalid travel package code',errorCode:'PACKAGE_CODE_INVALID'});return res.status(400).json({error:'Некоректний пакет'});}
    const packages=await getTravelPackages(true);
    const selected=packages.find(item=>item.packageCode===packageCode);
    if(!selected){recordDiagnostic(req,{email:req.userEmail,type:'payment_flow',action:'travel_checkout',outcome:'blocked',severity:'warning',message:'Selected travel package is no longer available',errorCode:'PACKAGE_NOT_AVAILABLE',context:{packageCode}});return res.status(404).json({error:'Пакет більше недоступний. Онови каталог і вибери інший.'});}
    if(!packageAllowed(selected))return res.status(503).json({error:'Цю країну або пакет тимчасово вимкнено Super Admin',code:'PACKAGE_DISABLED'});
    if(!paymentMethodEnabled('stripeCard'))return res.status(503).json({error:'Оплата карткою Stripe тимчасово недоступна',code:'PAYMENT_METHOD_DISABLED'});
    let scheduledFor='';
    if(changeMode==='after_expiry'){
      if(currentUser.stripeSubscriptionId) scheduledFor=await getNextBillingDate(currentUser.stripeSubscriptionId).catch(()=>null)||'';
      scheduledFor=scheduledFor||currentUser.subscriptionPeriodEnd||currentUser.esim?.expiredTime||'';
      if(!scheduledFor||Number.isNaN(new Date(scheduledFor).getTime())||new Date(scheduledFor).getTime()<=Date.now()) return res.status(409).json({error:'Не вдалося визначити дату завершення поточного тарифу. Вибери «Змінити зараз» або звернися в підтримку.',code:'CURRENT_PLAN_END_UNKNOWN'});
    }
    const recoveredProfile=await recoverStripeProfile(req.userEmail).catch(()=>({customerId:currentUser?.stripeCustomerId||null}));
    const loyalty=engagement.loyaltyFor(currentUser||{}),reward=loyalty.rewards.find(item=>item.kind==='discount'&&(item.status==='available'||(item.status==='reserved'&&Date.now()-new Date(item.reservedAt||0).getTime()>2*3600000))&&(!item.expiresAt||new Date(item.expiresAt)>new Date()))||null;
    const discountCents=reward?Math.min(Math.max(0,Number(reward.amountCents)||0),Math.max(0,selected.amountCents-50)):0;
    const checkoutAmountCents=selected.amountCents-discountCents;
    const session=await createCustomPackageCheckout({
      email:req.userEmail,
      customerId:recoveredProfile.customerId||currentUser?.stripeCustomerId||null,
      packageCode:selected.packageCode,
      packageName:selected.name,
      amountCents:checkoutAmountCents,
      currency:'usd',
      dataLimitGb:selected.dataLimitGb,
      durationDays:selected.durationDays,
      location:selected.location,
      changeMode:changeMode||'new',
      previousPlan:currentUser?.plan||'',
      previousSubscriptionId:currentUser?.stripeSubscriptionId||'',
      scheduledFor,
      recipientMode,
      recipientName,
      rewardId:reward?.id||'',
      rewardCode:reward?.code||'',
      discountCents,
      originalAmountCents:selected.amountCents,
    });
    if(reward){const index=loyalty.rewards.findIndex(item=>item.id===reward.id);loyalty.rewards[index]={...loyalty.rewards[index],status:'reserved',reservedAt:new Date().toISOString(),stripeSessionId:session.id};saveUser(req.userEmail,{loyalty});}
    recordDiagnostic(req,{email:req.userEmail,type:changeMode?'plan_change':'payment_flow',action:'stripe_checkout_created',outcome:'success',severity:'info',message:recipientMode==='family'?'Stripe Checkout created for family eSIM':changeMode?'Stripe Checkout created for plan change':'Stripe Checkout created for travel package',purchaseId:session.id,durationMs:Date.now()-started,context:{packageCode:selected.packageCode,amountCents:selected.amountCents,currency:'usd',dataLimitGb:selected.dataLimitGb,durationDays:selected.durationDays,location:selected.location,changeMode:recipientMode==='family'?'family':changeMode||'new',scheduledFor:scheduledFor||null,previousPlan:currentUser?.plan||null,recipientMode}});
    res.json({url:session.url});
  } catch(error) {
    recordDiagnostic(req,{email:req.userEmail,type:'payment_flow',action:'stripe_checkout_create',outcome:'failed',severity:'error',message:'Stripe Checkout creation failed',errorCode:error.code||error.type||'STRIPE_CHECKOUT_ERROR',durationMs:Date.now()-started,context:{provider:'stripe'}});
    console.error('[travel checkout]',error.message);
    res.status(502).json({error:'Не вдалося створити безпечну оплату пакета'});
  }
});

function safeMobileTopupOrder(order) {
  return {
    id:order.id,
    productName:order.productName,
    data:order.data,
    validity:order.validity||null,
    operatorName:order.operatorName,
    countryName:order.countryName,
    phoneMasked:maskPhone(order.phone),
    amountCents:order.amountCents,
    currency:order.currency,
    status:order.status,
    paymentStatus:order.paymentStatus||null,
    providerStatus:order.providerStatus||null,
    operatorReference:order.operatorReference||null,
    fulfillmentError:order.fulfillmentError?String(order.fulfillmentError).slice(0,240):null,
    createdAt:order.createdAt,
    paidAt:order.paidAt||null,
    deliveredAt:order.deliveredAt||null,
  };
}

app.get('/api/mobile-topups/status', requireUserSession, requireFeature('mobileTopups','Поповнення SIM тимчасово недоступне'), (req,res) => {
  res.json(mobileTopups.publicStatus());
});

app.get('/api/mobile-topups/countries', requireUserSession, requireFeature('mobileTopups'), rateLimit('mobile_topup_catalog',60*1000,30,req=>req.userEmail), async(req,res)=>{
  try{res.json({countries:await mobileTopups.listCountries()});}
  catch(error){recordDiagnostic(req,{email:req.userEmail,source:'dtone',type:'mobile_topup',action:'countries_load',outcome:'failed',severity:'error',message:error.message,errorCode:error.code});res.status(error.status||502).json({error:error.message,code:error.code});}
});

app.get('/api/mobile-topups/operators', requireUserSession, requireFeature('mobileTopups'), rateLimit('mobile_topup_catalog',60*1000,30,req=>req.userEmail), async(req,res)=>{
  try{res.json({operators:await mobileTopups.listOperators(req.query.country)});}
  catch(error){recordDiagnostic(req,{email:req.userEmail,source:'dtone',type:'mobile_topup',action:'operators_load',outcome:'failed',severity:'warning',message:error.message,errorCode:error.code});res.status(error.status||502).json({error:error.message,code:error.code});}
});

app.get('/api/mobile-topups/products', requireUserSession, requireFeature('mobileTopups'), rateLimit('mobile_topup_catalog',60*1000,30,req=>req.userEmail), async(req,res)=>{
  try{
    const products=await mobileTopups.listProducts({countryIsoCode:req.query.country,operatorId:req.query.operatorId});
    res.json({products});
  }catch(error){recordDiagnostic(req,{email:req.userEmail,source:'dtone',type:'mobile_topup',action:'products_load',outcome:'failed',severity:'warning',message:error.message,errorCode:error.code});res.status(error.status||502).json({error:error.message,code:error.code});}
});

app.get('/api/mobile-topups/orders', requireUserSession, requireFeature('mobileTopups'), (req,res)=>{
  const orders=(getUser(req.userEmail)?.mobileTopupOrders||[]).map(safeMobileTopupOrder);
  res.json({orders});
});

app.get('/api/mobile-topups/orders/:orderId', requireUserSession, requireFeature('mobileTopups'), (req,res)=>{
  const order=getMobileTopupOrder(req.userEmail,String(req.params.orderId||''));
  if(!order)return res.status(404).json({error:'Замовлення не знайдено'});
  res.json({order:safeMobileTopupOrder(order)});
});

app.post('/api/mobile-topups/checkout', requireUserSession, requireFeature('mobileTopups','Поповнення SIM тимчасово недоступне'), requireFeature('cardPayments','Оплати тимчасово призупинено'), rateLimit('mobile_topup_checkout',60*60*1000,8,req=>req.userEmail), async(req,res)=>{
  const started=Date.now();
  let orderId=null;
  try{
    const providerStatus=mobileTopups.publicStatus();
    if(!providerStatus.configured)return res.status(503).json({error:'Партнер мобільних поповнень ще не підключений. Оплата не створена.',code:'TOPUP_PROVIDER_NOT_CONFIGURED'});
    if(!paymentMethodEnabled('stripeCard'))return res.status(503).json({error:'Оплата карткою Stripe тимчасово недоступна',code:'PAYMENT_METHOD_DISABLED'});
    const phone=mobileTopups.normalizePhone(req.body?.phone);
    const product=await mobileTopups.getProduct(req.body?.productId,{includeCost:true});
    orderId=`topup_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
    const defaults={
      productId:product.id,productName:product.name,data:product.data,validity:product.validity,
      operatorId:product.operator.id,operatorName:product.operator.name,countryIsoCode:product.country.isoCode,countryName:product.country.name,
      phone,amountCents:product.amountCents,currency:product.currency,providerCost:product.providerCost,providerCurrency:product.providerCurrency,
      provider:'dtone',providerEnvironment:providerStatus.environment,status:'awaiting_payment',paymentStatus:'unpaid',
    };
    upsertMobileTopupOrder(req.userEmail,orderId,{},defaults);
    const currentUser=getUser(req.userEmail);
    const recoveredProfile=await recoverStripeProfile(req.userEmail).catch(()=>({customerId:currentUser?.stripeCustomerId||null}));
    const session=await createMobileTopupCheckout({email:req.userEmail,customerId:recoveredProfile.customerId||currentUser?.stripeCustomerId||null,orderId,productName:`${product.data} · ${product.operator.name}`,amountCents:product.amountCents,currency:product.currency});
    upsertMobileTopupOrder(req.userEmail,orderId,{stripeSessionId:session.id,checkoutCreatedAt:new Date().toISOString()});
    recordDiagnostic(req,{email:req.userEmail,source:'stripe',type:'mobile_topup',action:'checkout_created',outcome:'success',severity:'info',message:'Mobile data top-up checkout created',purchaseId:session.id,durationMs:Date.now()-started,context:{orderId,productId:product.id,operatorId:product.operator.id,country:product.country.isoCode,amountCents:product.amountCents,currency:product.currency,phone:maskPhone(phone)}});
    res.json({url:session.url,orderId});
  }catch(error){
    if(orderId)upsertMobileTopupOrder(req.userEmail,orderId,{status:'checkout_failed',fulfillmentError:error.message,fulfillmentErrorCode:error.code||error.type||'CHECKOUT_ERROR'});
    recordDiagnostic(req,{email:req.userEmail,source:error.code?.startsWith('TOPUP_')?'dtone':'stripe',type:'mobile_topup',action:'checkout_create',outcome:'failed',severity:'error',message:error.message,errorCode:error.code||error.type||'TOPUP_CHECKOUT_ERROR',durationMs:Date.now()-started,context:{orderId}});
    res.status(error.status&&error.status<500?error.status:502).json({error:error.message||'Не вдалося створити безпечну оплату',code:error.code});
  }
});

app.get('/api/account/coverage', requireUserSession, async (req, res) => {
  const locationCode = String(req.query.location || '').trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(locationCode)) return res.status(400).json({ error: 'Вкажи код країни' });
  const cached = coverageCache.get(locationCode);
  if (cached && Date.now() - cached.createdAt < 6 * 60 * 60 * 1000) return res.json({ locationCode, cached: true, packages: cached.packages });
  try {
    const packages = await listPackages({ locationCode });
    const safePackages = packages.slice(0, 100).map((item) => ({
      packageCode: item.packageCode,
      name: item.name,
      description: item.description,
      volume: item.volume,
      duration: item.duration,
      durationUnit: item.durationUnit,
      speed: item.speed,
      currencyCode: item.currencyCode,
      location: item.location,
      networks: (item.locationNetworkList || []).map((network) => ({ locationName: network.locationName, operatorCount: (network.operatorList || []).length })),
    }));
    coverageCache.set(locationCode, { createdAt: Date.now(), packages: safePackages });
    res.json({ locationCode, cached: false, packages: safePackages });
  } catch (error) {
    console.error(`[coverage] ${locationCode}:`, error.message);
    res.status(502).json({ error: 'Не вдалося отримати покриття від eSIM-провайдера' });
  }
});

// The activation code is intentionally available only to the account owner.
app.get('/api/account/esim', requireUserSession, (req, res) => {
  const user = getUser(req.userEmail);
  if (!user?.esim) return res.status(404).json({ error: 'eSIM ще не видано' });
  if (user.status === 'blocked') return res.status(403).json({ error: 'Акаунт заблоковано' });
  const { esim } = user;
  res.json({
    plan: user.plan || null,
    status: user.status,
    esim: {
      iccid: esim.iccid || null,
      activationCode: esim.activationCode || null,
      qrCodeUrl: esim.qrCodeUrl || null,
      apn: esim.apn || null,
      dataLimitGb: esim.dataLimitGb ?? null,
      usedGb: esim.usedGb ?? 0,
      remainingGb: esim.remainingGb ?? null,
      activateTime: esim.activateTime || null,
      expiredTime: esim.expiredTime || null,
    },
  });
});

function isSafeQrImageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (parsed.protocol !== 'https:' || !host || parsed.username || parsed.password) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host.includes(':') && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:') || host.includes('::ffff:'))) return false;
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
      if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)) return false;
    }
    return true;
  } catch { return false; }
}

function safeTopupPackage(item) {
  const packageCode = String(item?.packageCode || item?.slug || '').trim();
  const amountCents = packageRetailCents(item);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(packageCode) || !amountCents) return null;
  const unlimited = Number(item?.dataType) === 4 || /unlimited|безліміт/i.test(`${item?.name || ''} ${item?.description || ''}`);
  const rawDuration = Number(item?.duration || 30);
  return {
    packageCode,
    name:String(item?.name || item?.description || 'Додатковий пакет').slice(0,120),
    description:String(item?.description || '').slice(0,240),
    dataLimitGb:unlimited ? null : packageVolumeGb(item),
    unlimited,
    durationDays:Number.isFinite(rawDuration) ? Math.max(1, Math.min(365, rawDuration)) : 30,
    amountCents,
    currency:'usd',
  };
}

// Same-origin, authenticated QR proxy. The provider image can be displayed by
// <img>, but often blocks browser fetch/CORS, which prevented encrypted offline
// storage. Only a QR URL already owned by this authenticated account is fetched.
app.get('/api/account/esim/qr-image', requireUserSession, rateLimit('esim_qr_image',60*1000,20,req=>req.userEmail), async (req, res) => {
  try {
    const user = getUser(req.userEmail);
    if (!user || user.status === 'blocked') return res.status(403).json({ error:'Доступ до eSIM недоступний' });
    const scope = String(req.query.scope || 'primary');
    let esim = user.esim;
    if (scope === 'family') {
      const id = String(req.query.id || '');
      if (!/^[A-Za-z0-9:_-]{1,120}$/.test(id)) return res.status(400).json({ error:'Некоректний ID eSIM' });
      esim = (user.sharedEsims || []).find(item => item.id === id)?.esim;
    } else if (scope !== 'primary') return res.status(400).json({ error:'Некоректний тип eSIM' });
    const qrUrl = esim?.qrCodeUrl;
    if (!qrUrl) return res.status(404).json({ error:'QR-код ще не надано оператором' });
    if (!isSafeQrImageUrl(qrUrl)) return res.status(400).json({ error:'Неприпустиме джерело QR-коду' });
    const upstream = await fetch(qrUrl, { headers:{ Accept:'image/png,image/jpeg,image/webp,image/gif' }, redirect:'error', signal:AbortSignal.timeout(12000) });
    if (!upstream.ok) return res.status(502).json({ error:'Оператор тимчасово не віддає QR-код' });
    const contentType = String(upstream.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const allowed = new Set(['image/png','image/jpeg','image/webp','image/gif']);
    if (!allowed.has(contentType)) return res.status(502).json({ error:'Оператор повернув непідтримуваний формат QR-коду' });
    const declaredSize = Number(upstream.headers.get('content-length') || 0);
    if (declaredSize > 900000) return res.status(413).json({ error:'QR-код завеликий для офлайн-картки' });
    const payload = Buffer.from(await upstream.arrayBuffer());
    if (!payload.length || payload.length > 900000) return res.status(413).json({ error:'QR-код завеликий для офлайн-картки' });
    res.set({ 'Content-Type':contentType, 'Content-Length':String(payload.length), 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff' });
    res.send(payload);
  } catch (error) {
    recordDiagnostic(req,{email:req.userEmail,type:'esim_flow',action:'offline_qr_download',outcome:'failed',severity:'warning',message:'Offline QR image download failed',errorCode:error.name==='TimeoutError'?'QR_DOWNLOAD_TIMEOUT':'QR_DOWNLOAD_FAILED'});
    res.status(502).json({ error:error.name==='TimeoutError'?'Оператор не відповів вчасно':'Не вдалося завантажити QR-код оператора' });
  }
});

app.get('/api/account/esim/topups', requireUserSession, requireFeature('travelPackages','Додаткові пакети тимчасово недоступні'), rateLimit('esim_topup_catalog',60*1000,20,req=>req.userEmail), async (req,res) => {
  const user=getUser(req.userEmail);
  if(!user?.esim?.iccid)return res.status(409).json({error:'Спочатку активуйте eSIM',code:'ESIM_NOT_ISSUED'});
  try{
    const packages=(await listPackages({type:'TOPUP',iccid:user.esim.iccid})).map(safeTopupPackage).filter(Boolean).filter(packageAllowed).sort((a,b)=>(a.dataLimitGb||Infinity)-(b.dataLimitGb||Infinity)||a.durationDays-b.durationDays||a.amountCents-b.amountCents).slice(0,100);
    res.json({packages,iccidEnding:String(user.esim.iccid).slice(-4),current:{plan:user.plan||null,remainingGb:user.esim.remainingGb??null,expiredTime:user.esim.expiredTime||null}});
  }catch(error){
    recordDiagnostic(req,{email:req.userEmail,source:'esim_access',type:'topup_flow',action:'catalog',outcome:'failed',severity:'warning',message:error.message,errorCode:error.code||'TOPUP_CATALOG_FAILED'});
    res.status(502).json({error:'Не вдалося завантажити сумісні пакети для цієї eSIM',code:error.code||'TOPUP_CATALOG_FAILED'});
  }
});

app.post('/api/account/esim/topups/checkout', requireUserSession, requireFeature('travelPackages','Додаткові пакети тимчасово недоступні'), requireFeature('cardPayments','Оплати тимчасово призупинено'), requireProviderCapacity, rateLimit('esim_topup_checkout',60*60*1000,8,req=>req.userEmail), async (req,res) => {
  const user=getUser(req.userEmail);
  if(!user?.esim?.iccid)return res.status(409).json({error:'Немає активної eSIM для поповнення',code:'ESIM_NOT_ISSUED'});
  const packageCode=String(req.body?.packageCode||'').trim();
  if(!/^[A-Za-z0-9_-]{3,80}$/.test(packageCode))return res.status(400).json({error:'Некоректний пакет'});
  try{
    const selected=(await listPackages({type:'TOPUP',iccid:user.esim.iccid,packageCode})).map(safeTopupPackage).filter(Boolean).find(item=>item.packageCode===packageCode);
    if(!selected)return res.status(404).json({error:'Цей пакет більше не сумісний з eSIM. Оновіть список.',code:'TOPUP_NOT_AVAILABLE'});
    if(!packageAllowed(selected)||!paymentMethodEnabled('stripeCard'))return res.status(503).json({error:'Оплата цього пакета тимчасово недоступна'});
    const recovered=await recoverStripeProfile(req.userEmail).catch(()=>({customerId:user.stripeCustomerId||null}));
    const session=await createCustomPackageCheckout({email:req.userEmail,customerId:recovered.customerId||user.stripeCustomerId||null,packageCode:selected.packageCode,packageName:selected.name,amountCents:selected.amountCents,currency:'usd',dataLimitGb:selected.dataLimitGb,durationDays:selected.durationDays,location:'',changeMode:'topup_existing',previousPlan:user.plan||'',previousSubscriptionId:user.stripeSubscriptionId||''});
    recordDiagnostic(req,{email:req.userEmail,source:'stripe',type:'topup_flow',action:'checkout_created',outcome:'success',severity:'info',message:'Existing eSIM top-up checkout created',purchaseId:session.id,context:{packageCode,amountCents:selected.amountCents,iccidEnding:String(user.esim.iccid).slice(-4)}});
    res.json({url:session.url,rewardApplied:reward?{name:reward.name,code:reward.code,discountCents}:null});
  }catch(error){
    recordDiagnostic(req,{email:req.userEmail,source:error.code?.includes('PACKAGE')?'esim_access':'stripe',type:'topup_flow',action:'checkout',outcome:'failed',severity:'error',message:error.message,errorCode:error.code||'TOPUP_CHECKOUT_FAILED'});
    res.status(502).json({error:'Не вдалося створити безпечну оплату поповнення',code:error.code||'TOPUP_CHECKOUT_FAILED'});
  }
});

app.get('/api/push/public-key', requireUserSession, (req, res) => {
  if (!isPushConfigured()) return res.status(503).json({ error: 'Push ще не налаштовано на сервері' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireUserSession, (req, res) => {
  try {
    pushStore.saveSubscription(req.userEmail, req.body?.subscription);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/push/status', requireUserSession, (req, res) => {
  const endpoint = String(req.query.endpoint || '');
  const registered = endpoint ? pushStore.subscriptionsFor(req.userEmail).some(subscription => subscription.endpoint === endpoint) : false;
  res.json({ configured: isPushConfigured(), registered, devices: pushStore.subscriptionsFor(req.userEmail).length });
});

app.post('/api/push/unsubscribe', requireUserSession, (req, res) => {
  pushStore.removeSubscription(req.body?.endpoint, req.userEmail);
  res.json({ ok: true });
});

app.post('/api/push/test', requireUserSession, async (req, res) => {
  try {
    const delivered = await sendToEmail(req.userEmail, {
      title: 'Сповіщення увімкнено',
      body: 'Тепер Сигнал може попереджати про трафік та eSIM.',
      url: '/traffic-alerts.html',
      tag: 'signal-test',
    });
    res.json({ ok: true, delivered });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

// ---- Забув(ла) пароль ----
app.post('/api/auth/forgot-password',rateLimit('forgot_password',60*60*1000,10,req=>req.body?.email), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Введи коректний email' });
    const result = await authService.requestPasswordReset(email);
    res.json(result);
  } catch (err) {
    const status = err.code === 'COOLDOWN' ? 429 : 500;
    res.status(status).json({ error: err.message, code: err.code, waitSec: err.waitSec });
  }
});

app.post('/api/auth/verify-reset-code', rateLimit('verify_reset_code',15*60*1000,15,req=>req.body?.email), (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Потрібні email і code' });
    const result = authService.verifyResetCode(email, code);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/auth/reset-password', rateLimit('reset_password',15*60*1000,10,req=>req.body?.resetToken), async (req, res) => {
  try {
    const { resetToken, password } = req.body;
    if (!resetToken || !password) return res.status(400).json({ error: 'Потрібні resetToken і password' });
    const result = await authService.resetPassword(resetToken, password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// =========================================================
// ВХІДНА ПОШТА: реальні відповіді користувачів на email потрапляють сюди
// =========================================================

app.post('/api/inbound-email', async (req, res) => {
  let inboundId='';
  try {
    verifyInboundSignature(req.body, req.headers);
    const event = JSON.parse(req.body);
    inboundId=String(req.headers['svix-id']||event.data?.email_id||'');
    if(!await storage.claimExternalEvent('resend',inboundId,event.type))return res.json({received:true,duplicate:true});

    if (event.type !== 'email.received') {
      await storage.finishExternalEvent('resend',inboundId,'ignored');return res.json({ received: true, skipped: true });
    }

    // Вебхук дає тільки метадані — забираємо повний текст листа окремо
    const email = await getReceivedEmail(event.data.email_id);

    // Витягуємо ID тікета з теми листа: "[Сигнал Підтримка #123] ..."
    const match = (email.subject || '').match(/#(\d+)/);
    if (!match) {
      console.log('[inbound-email] Не вдалося знайти Ticket ID в темі:', email.subject);
      await storage.finishExternalEvent('resend',inboundId,'ignored','ticket_id_missing');return res.json({ received: true, matched: false });
    }

    const ticketId = match[1];
    const ticket = ticketStore.getTicket(ticketId);
    if (!ticket) {
      console.log(`[inbound-email] Тікет #${ticketId} не знайдено`);
      await storage.finishExternalEvent('resend',inboundId,'ignored','ticket_not_found');return res.json({ received: true, matched: false });
    }

    const sender=String(Array.isArray(email.from)?email.from[0]:email.from||'').toLowerCase();
    if(!sender.includes(String(ticket.email||'').toLowerCase())){await storage.finishExternalEvent('resend',inboundId,'rejected','sender_mismatch');return res.status(403).json({error:'Відправник не збігається з власником звернення'});}

    // Простий текст без HTML-розмітки, якщо є тільки html-версія
    const text = email.text || (email.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    ticketStore.addMessage(ticketId, { from: 'user', text });
    console.log(`[inbound-email] Додано відповідь у тікет #${ticketId} від ${email.from}`);

    await storage.finishExternalEvent('resend',inboundId,'completed');res.json({ received: true, ticketId });
  } catch (err) {
    console.error('Помилка обробки вхідного листа:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// =========================================================
// ПІДТРИМКА (SUPPORT): звернення користувачів
// =========================================================

// Public intake for people who cannot receive a verification email. It never
// reveals whether the supplied email/ICCID matches an account; only an admin
// can verify ownership and issue a short-lived recovery link.
app.post('/api/auth/access-recovery', rateLimit('access_recovery',60*60*1000,3,req=>req.body?.contactEmail || req.body?.possibleEmail), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const possibleEmail = String(req.body?.possibleEmail || '').trim().toLowerCase().slice(0, 254);
  const contactEmail = String(req.body?.contactEmail || '').trim().toLowerCase().slice(0, 254);
  const esimId = String(req.body?.esimId || '').replace(/\s/g, '').slice(0, 80);
  const purchaseHint = String(req.body?.purchaseHint || '').trim().slice(0, 200);
  const description = String(req.body?.description || '').trim().slice(0, 2000);
  if (!name || !possibleEmail || !contactEmail || description.length < 10) {
    return res.status(400).json({ error: 'Вкажи ім’я, старий email, доступний контактний email та коротко опиши проблему' });
  }
  if (possibleEmail && !possibleEmail.includes('@')) return res.status(400).json({ error: 'Можливий email має бути коректним' });
  if (!contactEmail.includes('@')) return res.status(400).json({ error: 'Контактний email має бути коректним' });

  const ticket = ticketStore.createTicket({
    email: possibleEmail || `recovery-${Date.now()}@no-email.invalid`,
    category: 'access_recovery',
    subject: 'Відновлення доступу без email',
    message: `Ім’я: ${name}\nСтарий email: ${possibleEmail}\nДоступний контактний email: ${contactEmail}\nICCID / UID eSIM: ${esimId || 'не вказано'}\nДані про покупку: ${purchaseHint || 'не вказано'}\n\n${description}`,
    recoveryRequest: { name, possibleEmail, contactEmail, esimId: esimId || null, purchaseHint: purchaseHint || null, description },
  });
  notifySuperAdminsAboutTicket(ticket);
  auditStore.log({ action: 'access_recovery_requested', target: `#${ticket.id}` });
  res.status(201).json({ ok: true, ticketId: ticket.id });
});

app.get('/api/auth/admin-recovery/:token', (req, res) => {
  try {
    res.json(authService.inspectAdminRecoveryToken(req.params.token));
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

app.post('/api/auth/admin-recovery/:token', rateLimit('complete_recovery',15*60*1000,10,req=>req.params.token), async (req, res) => {
  try {
    const result = await authService.completeAdminRecovery(req.params.token, req.body?.email, req.body?.password, req.body?.pin);
    const ticket = ticketStore.getTicket(result.ticketId);
    if (ticket) ticketStore.updateTicket(result.ticketId, { status: 'resolved', recoveredEmail: result.email, recoveryCompletedAt: new Date().toISOString() });
    auditStore.log({ action: 'access_recovery_completed', target: result.email, details: { ticketId: result.ticketId } });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

app.post('/api/maintenance-support',rateLimit('maintenance_support',60*60*1000,5,req=>req.ip),async(req,res)=>{
  const maintenance=operationsStore.activeAnnouncements(null).find(item=>item.type==='maintenance'&&item.audience==='all');
  if(!maintenance)return res.status(409).json({error:'Технічні роботи вже завершено. Увійдіть у застосунок і скористайтеся звичайною підтримкою.',code:'MAINTENANCE_INACTIVE'});
  const email=String(req.body?.email||'').trim().toLowerCase(),subject=String(req.body?.subject||'Проблема під час технічних робіт').trim().slice(0,160),message=String(req.body?.message||'').trim().slice(0,5000);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Вкажіть правильний email.'});
  if(message.length<10)return res.status(400).json({error:'Опишіть проблему щонайменше десятьма символами.'});
  const ticket=ticketStore.createTicket({email,category:'Технічні роботи',subject,message,recoveryRequest:{contactEmail:email,source:'maintenance_support'}});
  notifySuperAdminsAboutTicket(ticket);
  sendEmail({to:email,subject:`Звернення #${ticket.id} отримано — Signal`,html:emailTemplates.notification({title:'Ми отримали ваше звернення',message:`Звернення під номером #${ticket.id} зареєстровано під час технічних робіт. Команда підтримки відповість на цей email.`,actionUrl:'/maintenance-support.html',actionLabel:'Перевірити стан сервісу'})}).catch(()=>{});
  recordDiagnostic(req,{email,type:'support_flow',action:'maintenance_ticket_created',outcome:'success',severity:'info',message:'Maintenance support ticket created',context:{ticketId:ticket.id}});
  res.status(201).json({ok:true,ticketId:ticket.id});
});

app.post('/api/support/tickets', requireUserSession,rateLimit('support_ticket',60*60*1000,10,req=>req.userEmail), async (req, res) => {
  try {
    const category = String(req.body?.category || 'Інше').trim().slice(0, 60);
    const subject = String(req.body?.subject || '').trim().slice(0, 160);
    const message = String(req.body?.message || '').trim().slice(0, 5000);
    const attachment = req.body?.attachment;
    const email=req.userEmail;
    if (!subject || !message) return res.status(400).json({ error: 'Потрібні subject і message' });
    const safeAttachment=validateSupportAttachment(attachment);
    const diagnostics=buildSupportDiagnostics(getUser(email),req.body?.diagnostics);
    const ticket = ticketStore.createTicket({ email, category: category || 'Інше', subject, message, attachment:safeAttachment, diagnostics });
    notifySuperAdminsAboutTicket(ticket);
    sendEmail({to:email,subject:`Звернення #${ticket.id} отримано — Signal`,html:emailTemplates.notification({title:'Ми отримали ваше звернення',message:`Звернення «${subject}» зареєстровано під номером #${ticket.id}. Відповідь з’явиться в застосунку та надійде на email.`,actionUrl:`/ticket.html?id=${ticket.id}`,actionLabel:'Переглянути звернення'})}).catch(()=>{});
    res.json(ticketStore.stripNotesForUser(ticket));
  } catch (err) {
    res.status(err.code === 'INVALID_ATTACHMENT' ? 400 : 500).json({ error: err.code === 'INVALID_ATTACHMENT' ? err.message : 'Не вдалося створити звернення' });
  }
});

app.get('/api/support/tickets', requireUserSession, (req, res) => {
  res.json(ticketStore.getTicketsByEmail(req.userEmail).map(ticketStore.stripNotesForUser));
});

app.get('/api/support/tickets/:id', requireUserSession, (req, res) => {
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (ticket.email !== req.userEmail) return res.status(403).json({ error: 'Немає доступу до цього тікета' });
  // Внутрішні нотатки адмінів користувач бачити не повинен
  const safeTicket = ticketStore.stripNotesForUser(ticket);
  if ((getUser(ticket.email)?.language || 'uk') !== 'en') return res.json(safeTicket);
  Promise.all((safeTicket.messages || []).map(async (item) => item.from === 'admin'
    ? { ...item, text: await translationService.translate(item.text, 'en') }
    : item
  )).then((messages) => res.json({ ...safeTicket, messages })).catch(() => res.json(safeTicket));
});

app.post('/api/support/tickets/:id/reply', requireUserSession, (req, res) => {
  const message = String(req.body?.message || '').trim().slice(0, 5000);
  const attachment = req.body?.attachment;
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (ticket.email !== req.userEmail) return res.status(403).json({ error: 'Немає доступу до цього тікета' });
  if (!message) return res.status(400).json({ error: 'Напиши повідомлення' });
  let safeAttachment;try{safeAttachment=validateSupportAttachment(attachment);}catch(error){return res.status(400).json({error:error.message,code:error.code});}
  const updated = ticketStore.addMessage(req.params.id, { from: 'user', text: message, attachment:safeAttachment });
  notifyStaffAboutUserReply(updated);
  res.json(ticketStore.stripNotesForUser(updated));
});

// =========================================================
// АДМІН-ПАНЕЛЬ: акаунти адмінів з ролями (Super Admin/Admin/Support/Viewer)
// =========================================================

app.post('/api/admin/login',rateLimit('admin_login',15*60*1000,10,req=>req.body?.email), async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await adminAuth.login(email, password);
    if (result.requiresTwoFactor) {
      const delivery=await sendEmail({to:result.email,subject:'Код входу в адмін-панель — Сигнал',html:emailTemplates.twoFactorCode({code:result.code,purpose:'login'})});
      if(delivery?.mocked) throw Object.assign(new Error('2FA не може надіслати код: RESEND_API_KEY не налаштовано'),{code:'EMAIL_NOT_CONFIGURED'});
      auditStore.log({adminEmail:result.email,action:'admin_2fa_code_sent'});
      return res.json({requiresTwoFactor:true,challengeId:result.challengeId,email:result.email,expiresIn:result.expiresIn});
    }
    auditStore.log({ adminEmail: result.email, action: 'admin_login' });
    res.json(result);
  } catch (err) {
    if(['INVALID','BLOCKED'].includes(err.code))recordSecurityFailure(req,'admin_login',err.code,req.body?.email);
    res.status(401).json({ error: err.message, code: err.code });
  }
});

app.post('/api/admin/login/2fa',rateLimit('admin_2fa',15*60*1000,10), (req,res)=>{
  try{const result=adminAuth.completeLogin(String(req.body?.challengeId||''),String(req.body?.code||''));auditStore.log({adminEmail:result.email,action:'admin_login_2fa'});res.json(result);}
  catch(error){recordSecurityFailure(req,'admin_2fa',error.code);res.status(401).json({error:error.message,code:error.code});}
});

app.post('/api/admin/login/recover-2fa',async(req,res)=>{
  const email=String(req.body?.email||'').trim().toLowerCase();
  const key=`${req.ip}:${email}`;const now=Date.now();const recent=(adminRecoveryRateLimit.get(key)||[]).filter(time=>now-time<15*60*1000);
  if(recent.length>=5)return res.status(429).json({error:'Забагато спроб. Повторіть через 15 хвилин'});
  recent.push(now);adminRecoveryRateLimit.set(key,recent);
  try{const result=await adminAuth.emergencyResetTwoFactor({email,password:req.body?.password,recoverySecret:req.body?.recoverySecret});auditStore.log({adminEmail:result.email,action:'admin_2fa_emergency_reset',target:result.email,details:{fingerprint:securityFingerprint(req)}});sendEmail({to:result.email,subject:'Аварійне скидання 2FA — Сигнал',html:emailTemplates.adminSecurityAlert({title:'Двофакторний захист аварійно скинуто',message:'Усі активні сесії завершено. Увійдіть знову та негайно підключіть 2FA, після чого збережіть нові резервні коди.'})}).catch(error=>console.error('[admin recovery email]',error.message));res.json({ok:true,message:'2FA скинуто. Увійдіть з паролем і одразу підключіть її знову.'});}
  catch(error){if(error.code!=='RECOVERY_NOT_CONFIGURED')recordSecurityFailure(req,'admin_emergency_recovery',error.code,email);auditStore.log({adminEmail:email||'unknown',action:'admin_2fa_emergency_reset_failed',target:email,details:{code:error.code,fingerprint:securityFingerprint(req)}});res.status(error.code==='RECOVERY_NOT_CONFIGURED'?503:401).json({error:error.message,code:error.code});}
});

app.get('/api/admin/me', adminAuth.requireAdmin, (req, res) => {
  res.json(req.admin);
});

app.get('/api/admin/security/2fa',adminAuth.requireAdmin,(req,res)=>res.json(adminAuth.twoFactorStatus(req.admin.email)));
app.post('/api/admin/security/2fa/request',adminAuth.requireAdmin,async(req,res)=>{
  try{const enabled=Boolean(req.body?.enabled),result=adminAuth.startTwoFactorChange(req.admin.email,enabled);const delivery=await sendEmail({to:req.admin.email,subject:`${enabled?'Увімкнення':'Вимкнення'} двофакторного захисту — Сигнал`,html:emailTemplates.twoFactorCode({code:result.code,purpose:enabled?'enable':'disable'})});if(delivery?.mocked)throw new Error('RESEND_API_KEY не налаштовано');auditStore.log({adminEmail:req.admin.email,action:'admin_2fa_change_requested',details:{enabled}});res.json({challengeId:result.challengeId,expiresIn:result.expiresIn});}
  catch(error){res.status(400).json({error:error.message,code:error.code});}
});
app.post('/api/admin/security/2fa/confirm',adminAuth.requireAdmin,(req,res)=>{
  try{const enabled=Boolean(req.body?.enabled),result=adminAuth.completeTwoFactorChange(req.admin.email,enabled,String(req.body?.challengeId||''),String(req.body?.code||''));auditStore.log({adminEmail:req.admin.email,action:enabled?'admin_2fa_enabled':'admin_2fa_disabled'});res.json({ok:true,...result,loggedOut:!enabled});}
  catch(error){res.status(400).json({error:error.message,code:error.code});}
});

app.get('/api/admin/push/public-key', adminAuth.requireAdmin, (req,res)=>{
  if(!isPushConfigured()) return res.status(503).json({error:'Push не налаштовано на сервері'});
  res.json({publicKey:process.env.VAPID_PUBLIC_KEY});
});
app.post('/api/admin/push/subscribe', adminAuth.requireAdmin, (req,res)=>{
  try{ pushStore.saveSubscription(`admin:${req.admin.email}`,req.body?.subscription); res.json({ok:true}); }
  catch(error){ res.status(400).json({error:error.message}); }
});
app.get('/api/admin/push/status', adminAuth.requireAdmin, (req,res)=>{
  const endpoint=String(req.query.endpoint||''),key=`admin:${req.admin.email}`;
  res.json({configured:isPushConfigured(),registered:endpoint?pushStore.subscriptionsFor(key).some(item=>item.endpoint===endpoint):false,devices:pushStore.subscriptionsFor(key).length});
});
app.post('/api/admin/push/test', adminAuth.requireAdmin, async(req,res)=>{
  try{const delivered=await sendToEmail(`admin:${req.admin.email}`,{title:'Адмін-сповіщення працюють',body:'Ви отримуватимете нові та призначені звернення.',url:'/admin-tickets.html',tag:'admin-push-test'});res.json({ok:true,delivered});}
  catch(error){res.status(503).json({error:error.message});}
});

app.get('/api/admin/diagnostics', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req,res)=>{
  const filters={email:req.query.email||'',type:req.query.type||'',severity:req.query.severity||'',source:req.query.source||'',outcome:req.query.outcome||'',search:req.query.search||'',since:req.query.since||'',limit:req.query.limit||300};
  res.json({events:diagnosticsStore.list(filters),summary:diagnosticsStore.summary(req.query.hours||24)});
});

// Керування командою — тільки Super Admin
app.get('/api/admin/team', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  res.json(adminAuth.listAdmins());
});

app.get('/api/admin/assignees', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  res.json(adminAuth.listAdmins().filter((admin) => !admin.blocked && admin.role === 'admin').map((admin) => ({ email: admin.email, role: admin.role })));
});

app.post('/api/admin/team', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password || !role) return res.status(400).json({ error: 'Потрібні email, password і role' });
    if (password.length < 8) return res.status(400).json({ error: 'Пароль має бути не менше 8 символів' });
    await adminAuth.createAdmin({ email, password, role });
    auditStore.log({ adminEmail: req.admin.email, action: 'admin_created', target: email, details: { role } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.patch('/api/admin/team/:email/block', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  try {
    const result = adminAuth.setAdminBlocked({
      email: req.params.email,
      blocked: Boolean(req.body?.blocked),
      actorEmail: req.admin.email,
    });
    auditStore.log({ adminEmail: req.admin.email, action: result.blocked ? 'admin_blocked' : 'admin_unblocked', target: result.email });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/api/admin/team/:email/reset-2fa',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{try{const result=adminAuth.resetTwoFactor({email:req.params.email,actorEmail:req.admin.email});auditStore.log({adminEmail:req.admin.email,action:'admin_2fa_reset',target:result.email});sendEmail({to:result.email,subject:'Вашу 2FA скинув Super Admin — Сигнал',html:emailTemplates.adminSecurityAlert({title:'Двофакторний захист скинуто',message:`Super Admin ${req.admin.email} скинув вашу 2FA та завершив усі активні сесії. Увійдіть знову й одразу підключіть захист.`})}).catch(error=>console.error('[2fa reset email]',error.message));res.json({ok:true,...result});}catch(error){res.status(400).json({error:error.message,code:error.code});}});

app.delete('/api/admin/team/:email', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  try {
    const email = req.params.email;
    adminAuth.deleteAdmin({ email, actorEmail: req.admin.email });
    auditStore.log({ adminEmail: req.admin.email, action: 'admin_deleted', target: email });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

// Перегляд тікетів — доступний усім ролям, крім нічого (навіть Viewer читає)
app.get('/api/admin/tickets', adminAuth.requireAdmin, (req, res) => {
  const { status, priority, search } = req.query;
  const tickets = ticketStore.getAllTickets({ status, priority, search });
  res.json(req.admin.role === 'admin' ? tickets.filter(ticket => ticket.assignedTo === req.admin.email) : tickets);
});

app.get('/api/admin/tickets/:id', adminAuth.requireAdmin, async (req, res) => {
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });
  const userSubscription = getUser(ticket.email);
  let recoveryVerification = null;
  if (ticket.category === 'access_recovery' && req.admin.role === 'super_admin') {
    const authUser = authStore.readAll().users?.[ticket.email] || null;
    let payment = null;
    let paymentError = null;
    try {
      payment = await getRecoveryPaymentEvidence(userSubscription?.stripeCustomerId);
    } catch (error) {
      paymentError = 'Stripe-дані тимчасово недоступні';
      console.error(`[access recovery] Stripe evidence for #${ticket.id}:`, error.message);
    }
    recoveryVerification = {
      accountFound: Boolean(authUser && userSubscription),
      accountEmail: authUser?.email || userSubscription?.email || null,
      registeredAt: authUser?.createdAt || userSubscription?.createdAt || null,
      lastLoginAt: authUser?.lastLoginAt || null,
      displayName: userSubscription?.displayName || null,
      plan: userSubscription?.plan || null,
      status: userSubscription?.status || null,
      hasEsim: Boolean(userSubscription?.esim),
      iccidLast4: userSubscription?.esim?.iccid ? String(userSubscription.esim.iccid).slice(-4) : null,
      payment,
      paymentError,
    };
  }
  res.json({ ticket, userSubscription, recoveryVerification });
});

app.post('/api/admin/tickets/:id/create-recovery-link', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  try {
    const ticket = ticketStore.getTicket(req.params.id);
    if (!ticket || ticket.category !== 'access_recovery') return res.status(404).json({ error: 'Запит відновлення не знайдено' });
    if (req.body?.verificationConfirmed !== true) return res.status(400).json({ error: 'Підтвердіть перевірку щонайменше двох незалежних ознак власника' });
    const accountEmail = String(req.body?.accountEmail || '').trim().toLowerCase();
    if (accountEmail !== String(ticket.recoveryRequest?.possibleEmail || '').trim().toLowerCase()) {
      return res.status(409).json({ error: 'Email підтвердженого акаунта не збігається зі старим email у запиті' });
    }
    const deliveryEmail = String(req.body?.deliveryEmail || ticket.recoveryRequest?.contactEmail || '').trim().toLowerCase();
    if (!deliveryEmail.includes('@') || deliveryEmail.length > 254) return res.status(400).json({ error: 'Вкажіть коректний email для отримання посилання' });
    const result = authService.createAdminRecoveryToken(accountEmail, ticket.id);
    const frontendUrl = String(process.env.FRONTEND_URL || '').replace(/\/$/, '');
    if (!frontendUrl) return res.status(500).json({ error: 'FRONTEND_URL не налаштовано' });
    const url = `${frontendUrl}/access-recovery-complete.html?token=${encodeURIComponent(result.token)}`;
    const delivery = await sendEmail({
      to: deliveryEmail,
      subject: 'Безпечне відновлення доступу — Сигнал',
      html: emailTemplates.accessRecovery({url,expiresAt:result.expiresAt}),
    });
    if (delivery?.mocked) throw new Error('Лист не надіслано: RESEND_API_KEY не налаштований на сервері');
    ticketStore.updateTicket(ticket.id, { status: 'waiting_customer', verifiedAccountEmail: accountEmail, recoveryDeliveryEmail: deliveryEmail, recoveryLinkCreatedAt: new Date().toISOString(), recoveryLinkExpiresAt: result.expiresAt });
    auditStore.log({ adminEmail: req.admin.email, action: 'access_recovery_link_sent', target: accountEmail, details: { ticketId: ticket.id, deliveryEmail, expiresAt: result.expiresAt } });
    res.json({ ok: true, sent: true, sentTo: deliveryEmail, expiresAt: result.expiresAt });
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code });
  }
});

// Зміна статусу/пріоритету — заборонено для Viewer
app.patch('/api/admin/tickets/:id', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  const { status, priority, assignedTo, category, tags } = req.body;
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error:'Тікет не знайдено' });
  if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });
  if (assignedTo !== undefined && req.admin.role !== 'super_admin') return res.status(403).json({ error:'Виконавця може змінити лише Super Admin' });
  const assignedAdmin = assignedTo ? adminStore.readAll().admins?.[assignedTo] : null;
  if (assignedTo && (!assignedAdmin || assignedAdmin.blocked || assignedAdmin.role !== 'admin')) {
    return res.status(400).json({ error: 'Можна призначити лише активного адміністратора з роллю Admin' });
  }
  if (status === 'closed') {
    const deleted = ticketStore.deleteTicket(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Тікет не знайдено' });
    auditStore.log({ adminEmail: req.admin.email, action: 'ticket_closed_and_deleted', target: `#${req.params.id}` });
    return res.json({ ok: true, deleted: true });
  }
  const previousAssignee = ticket.assignedTo || null;
  const assignmentChanged = assignedTo !== undefined && (assignedTo || null) !== previousAssignee;
  const assignmentEvent = assignmentChanged ? { from:previousAssignee, to:assignedTo || null, by:req.admin.email, createdAt:new Date().toISOString() } : null;
  const updated = ticketStore.updateTicket(req.params.id, {
    ...(status && { status }),
    ...(priority && { priority }),
    ...(assignedTo !== undefined && { assignedTo: assignedTo || null }),
    ...(category && {category:String(category).slice(0,80)}),
    ...(Array.isArray(tags) && {tags:tags.map(tag=>String(tag).trim().slice(0,40)).filter(Boolean).slice(0,10)}),
    ...(status==='waiting_provider' && {waitingProviderAt:new Date().toISOString()}),
    ...(status==='resolved' && {resolvedAt:new Date().toISOString()}),
    ...(assignmentEvent && { assignmentHistory:[...(ticket.assignmentHistory || []), assignmentEvent] }),
  });
  if (!updated) return res.status(404).json({ error: 'Тікет не знайдено' });
  auditStore.log({ adminEmail: req.admin.email, action: assignmentChanged ? 'ticket_assigned' : 'ticket_updated', target: `#${req.params.id}`, details: { status, priority, assignedTo, previousAssignee } });
  let delivery = null;
  if (assignmentChanged && assignedTo) {
    const [emailResult, pushResult] = await Promise.allSettled([
      sendEmail({ to:assignedTo, subject:`Вам призначено звернення #${updated.id} — Сигнал`, html:emailTemplates.ticketAssignment({ticketId:updated.id,customerEmail:updated.email,subject:updated.subject}) }),
      sendToEmail(`admin:${assignedTo}`, { title:'Вам призначено звернення', body:`Тікет #${updated.id}: ${updated.subject}`, url:`/admin-ticket.html?id=${updated.id}`, tag:`assigned-ticket-${updated.id}` }),
    ]);
    delivery = { email:emailResult.status === 'fulfilled' && !emailResult.value?.mocked, push:pushResult.status === 'fulfilled' ? pushResult.value : 0 };
    auditStore.log({adminEmail:req.admin.email,action:'ticket_assignment_notified',target:assignedTo,details:{ticketId:updated.id,...delivery}});
  }
  res.json({...updated,...(delivery?{notificationDelivery:delivery}:{})});
});

// Відповідь клієнту (реальний email) — заборонено для Viewer
app.post('/api/admin/tickets/:id/reply', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  try {
    const { message, attachment } = req.body;
    const ticket = ticketStore.getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
    if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });

    const safeAttachment=validateSupportAttachment(attachment);
    const updated = ticketStore.addMessage(req.params.id, { from: 'admin', text: message, attachment:safeAttachment, adminEmail:req.admin.email });
    const customerMessage = await translationService.forEmail(ticket.email, message, getUser);
    const customerTitle = await translationService.forEmail(ticket.email, 'Нова відповідь від підтримки', getUser);
    // Do not put the reply text in a lock-screen notification. The user can
    // open the protected ticket by tapping the generic push instead.
    sendToEmail(ticket.email, {
      title: customerTitle,
      body: `У зверненні #${ticket.id} є нове повідомлення.`,
      url: `/ticket.html?id=${ticket.id}`,
      tag: `support-${ticket.id}`,
    }).catch((pushErr) => console.error(`[push] support reply #${ticket.id}:`, pushErr.message));
    auditStore.log({ adminEmail: req.admin.email, action: 'ticket_reply_sent', target: `#${req.params.id}` });

    try {
      await sendEmail({
        to: ticket.email,
        subject: `[Сигнал Підтримка #${ticket.id}] ${ticket.subject}`,
        html: emailTemplates.supportReply({ ticketId:ticket.id, subject:ticket.subject, message:customerMessage }),
        replyTo: process.env.RESEND_INBOUND_ADDRESS || undefined,
      });
    } catch (emailErr) {
      console.error('Не вдалося надіслати email по тікету:', emailErr.message);
    }

    res.json(updated);
  } catch (err) {
    res.status(err.code === 'INVALID_ATTACHMENT' ? 400 : 500).json({ error: err.code === 'INVALID_ATTACHMENT' ? err.message : 'Не вдалося надіслати відповідь' });
  }
});

// Внутрішня нотатка — видно ТІЛЬКИ адмінам, email не надсилається. Заборонено для Viewer
app.post('/api/admin/tickets/:id/note', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), (req, res) => {
  const { text } = req.body;
  const ticket = ticketStore.getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Тікет не знайдено' });
  if (req.admin.role === 'admin' && ticket.assignedTo !== req.admin.email) return res.status(403).json({ error:'Це звернення не призначене вам' });
  const updated = ticketStore.addMessage(req.params.id, { from: 'note', text });
  auditStore.log({ adminEmail: req.admin.email, action: 'ticket_note_added', target: `#${req.params.id}` });
  res.json(updated);
});

// Audit Log — тільки Super Admin (це чутливі дані про дії всієї команди)
app.get('/api/admin/audit-log', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), (req, res) => {
  res.json(auditStore.getAll());
});

app.get('/api/admin/dashboard', adminAuth.requireAdmin, (req, res) => {
  const users = Object.values(getAllUsers());
  const tickets = ticketStore.getAllTickets();
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const active = users.filter((user) => user.status === 'active');
  const highUsage = active.filter((user) => {
    const esim = user.esim || {};
    return esim.dataLimitGb && (Number(esim.usedGb || 0) / Number(esim.dataLimitGb)) >= 0.8;
  });
  const trips=users.filter(user=>user.travelMode?.enabled&&user.travelMode?.startDate);
  const upcomingTrips=trips.filter(user=>{const start=new Date(`${user.travelMode.startDate}T00:00:00Z`).getTime();return start>=Date.now()-86400000&&start<=Date.now()+14*86400000;});
  const clubMembers=users.map(user=>engagement.publicClub(user,operationsStore.store().engagementSettings||{})).filter(club=>club.lifetimePoints>0);
  const rescueRequests=operationsStore.store().rescueRequests||[];
  res.json({
    users: { total: users.length, registeredToday: users.filter((user) => new Date(user.createdAt || 0).getTime() >= since).length, active: active.length, blocked: users.filter((user) => user.status === 'blocked').length },
    esim: { active: active.filter((user) => user.esim?.orderNo).length, failed: users.filter((user) => user.status === 'payment_ok_esim_failed').length, highUsage: highUsage.length, expiringSoon: active.filter((user) => user.esim?.expiredTime && new Date(user.esim.expiredTime).getTime() - Date.now() < 7 * 86400000).length },
    tickets: { total: tickets.length, open: tickets.filter((ticket) => ticket.status === 'open').length, unassigned: tickets.filter((ticket) => !ticket.assignedTo && !['resolved', 'closed'].includes(ticket.status)).length, waitingOver24h: tickets.filter((ticket) => ticket.status === 'waiting_customer' && Date.now() - new Date(ticket.updatedAt).getTime() > 24 * 3600000).length },
    travel:{planned:trips.length,upcoming14Days:upcomingTrips.length,withoutEsim:upcomingTrips.filter(user=>!user.esim?.orderNo).length,withoutPush:upcomingTrips.filter(user=>!pushStore.subscriptionsFor(user.email).length).length},
    engagement:{members:clubMembers.length,pointsInCirculation:clubMembers.reduce((sum,club)=>sum+club.points,0)},
    rescue:{pending:rescueRequests.filter(item=>item.status==='pending').length},
    recentTickets: tickets.slice(0, 5),
  });
});

app.get('/api/admin/travel',adminAuth.requireAdmin,adminAuth.requireRole('super_admin','admin','support','viewer'),(req,res)=>{
  const now=Date.now(),items=Object.values(getAllUsers()).filter(user=>user.travelMode?.enabled&&user.travelMode?.startDate).map(user=>{const startAt=new Date(`${user.travelMode.startDate}T00:00:00Z`).getTime(),daysUntil=Math.ceil((startAt-now)/86400000),remaining=user.esim?.remainingGb??(user.esim?.dataLimitGb!=null?Math.max(0,Number(user.esim.dataLimitGb)-Number(user.esim.usedGb||0)):null);return {email:user.email,displayName:user.displayName||'',destination:user.travelMode.destination,startDate:user.travelMode.startDate,endDate:user.travelMode.endDate,deviceModel:user.travelMode.deviceModel||'',platform:user.travelMode.platform||'other',daysUntil,hasEsim:Boolean(user.esim?.orderNo),remainingGb:remaining,expiresAt:user.esim?.expiredTime||null,pushDevices:pushStore.subscriptionsFor(user.email).length};}).sort((a,b)=>a.startDate.localeCompare(b.startDate));
  res.json({items,summary:{planned:items.length,next14Days:items.filter(item=>item.daysUntil>=0&&item.daysUntil<=14).length,withoutEsim:items.filter(item=>item.daysUntil>=0&&item.daysUntil<=14&&!item.hasEsim).length,lowData:items.filter(item=>item.daysUntil>=0&&item.remainingGb!=null&&item.remainingGb<1).length}});
});

app.get('/api/admin/engagement',adminAuth.requireAdmin,adminAuth.requireRole('super_admin','admin','support','viewer'),(req,res)=>{
  const users=Object.values(getAllUsers()),settings=operationsStore.store().engagementSettings||{};
  const items=users.map(user=>{const club=engagement.publicClub(user,settings),stamps=engagement.passportFor(user);return {email:user.email,displayName:user.displayName||'',points:club.points,lifetimePoints:club.lifetimePoints,tier:club.tier.name,stamps:stamps.length,countries:new Set(stamps.map(item=>item.countryCode)).size,rewards:club.rewards.length};}).filter(item=>item.points||item.stamps||item.rewards).sort((a,b)=>b.lifetimePoints-a.lifetimePoints);
  res.json({settings,items,summary:{members:items.length,pointsInCirculation:items.reduce((sum,item)=>sum+item.points,0),stamps:items.reduce((sum,item)=>sum+item.stamps,0),rewards:items.reduce((sum,item)=>sum+item.rewards,0)}});
});
app.patch('/api/admin/engagement/settings',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('settings.manage',{requireTwoFactor:true}),(req,res)=>{
  const state=operationsStore.store(),current=state.engagementSettings||{},pointsPerDollar=Math.trunc(Number(req.body?.pointsPerDollar)),stampBonus=Math.trunc(Number(req.body?.stampBonus));
  if(!Number.isInteger(pointsPerDollar)||pointsPerDollar<1||pointsPerDollar>100||!Number.isInteger(stampBonus)||stampBonus<0||stampBonus>1000)return res.status(400).json({error:'Некоректні правила нарахування'});
  state.engagementSettings={...current,enabled:req.body?.enabled!==false,pointsPerDollar,stampBonus};operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'engagement_settings_updated',target:'signal_club',details:state.engagementSettings});res.json(state.engagementSettings);
});
app.post('/api/admin/engagement/:email/points',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('refunds.manage',{requireTwoFactor:true}),(req,res)=>{
  const email=String(req.params.email||'').toLowerCase(),user=getUser(email);if(!user)return res.status(404).json({error:'Користувача не знайдено'});const points=Math.trunc(Number(req.body?.points));if(!Number.isInteger(points)||points===0||Math.abs(points)>10000)return res.status(400).json({error:'Вкажіть від −10000 до 10000 points'});
  const loyalty=engagement.loyaltyFor(user);if(loyalty.points+points<0)return res.status(409).json({error:'Не можна створити від’ємний баланс'});loyalty.points+=points;if(points>0)loyalty.lifetimePoints+=points;loyalty.ledger.unshift({id:engagement.id('points'),key:`admin:${crypto.randomUUID()}`,type:'admin_adjustment',points,reason:String(req.body?.reason||'Коригування Super Admin').replace(/[\r\n<>]/g,' ').slice(0,180),createdAt:new Date().toISOString(),by:req.admin.email});saveUser(email,{loyalty});auditStore.log({adminEmail:req.admin.email,action:'signal_points_adjusted',target:email,details:{points,reason:req.body?.reason||null}});res.json(engagement.publicClub({...user,loyalty},operationsStore.store().engagementSettings||{}));
});

app.get('/api/admin/rescue-requests',adminAuth.requireAdmin,adminAuth.requireRole('super_admin','admin','support','viewer'),(req,res)=>{const items=operationsStore.store().rescueRequests||[];res.json({items,summary:{pending:items.filter(item=>item.status==='pending').length,approved:items.filter(item=>item.status==='approved').length,declined:items.filter(item=>item.status==='declined').length}});});
app.post('/api/admin/rescue-requests/:id/resolve',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('refunds.manage',{requireTwoFactor:true}),(req,res)=>{
  const state=operationsStore.store(),request=(state.rescueRequests||[]).find(item=>item.id===req.params.id);if(!request)return res.status(404).json({error:'Запит не знайдено'});if(request.status!=='pending')return res.status(409).json({error:'Запит уже опрацьовано'});const approved=req.body?.approved===true;request.status=approved?'approved':'declined';request.resolvedAt=new Date().toISOString();request.resolvedBy=req.admin.email;request.noteAdmin=String(req.body?.note||'').replace(/[\r\n<>]/g,' ').slice(0,500);
  if(approved){const user=getUser(request.email)||{},loyalty=engagement.loyaltyFor(user),points=Math.max(50,Math.min(1000,Math.trunc(Number(req.body?.points)||250)));loyalty.points+=points;loyalty.lifetimePoints+=points;loyalty.ledger.unshift({id:engagement.id('points'),key:`rescue:${request.id}`,type:'rescue_courtesy',points,reason:'Бонус турботи Signal',createdAt:new Date().toISOString(),by:req.admin.email});saveUser(request.email,{loyalty});request.points=points;sendToEmail(request.email,{title:'Signal допоміг',body:`Ми перевірили звернення та додали ${points} Signal Points.`,url:'/signal-club.html',tag:`rescue-${request.id}`}).catch(()=>{});}operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:approved?'rescue_credit_approved':'rescue_credit_declined',target:request.email,details:{requestId:request.id,points:request.points||0}});res.json({ok:true,request});
});

function controlContext(){
  const users=Object.values(getAllUsers()),tickets=ticketStore.getAllTickets(),diagnostics=diagnosticsStore.list({limit:1000}),operations=operationsStore.store(),audit=auditStore.getAll({limit:1000});
  const support=controlCenter.supportMetrics(tickets),attention=controlCenter.buildAttention({users,tickets,diagnostics,operations});
  return {users,tickets,diagnostics,operations,audit,support,attention};
}
async function runDailySuperAdminReport(){
  const c=controlContext(),settings=c.operations.reportSettings||{};
  if(settings.enabled===false)return;
  const now=new Date(),localDate=new Intl.DateTimeFormat('en-CA',{timeZone:process.env.REPORT_TIMEZONE||'Europe/Prague'}).format(now);
  const localHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:process.env.REPORT_TIMEZONE||'Europe/Prague',hour:'2-digit',hour12:false}).format(now));
  if(settings.lastSentDate===localDate||localHour<Number(settings.hour??8))return;
  const report=controlCenter.dailyReport(c);c.operations.dailyReports.unshift(report);c.operations.dailyReports=c.operations.dailyReports.slice(0,90);settings.lastSentDate=localDate;c.operations.reportSettings=settings;operationsStore.save();
  const since=Date.now()-86400000,hasRecentFailure=source=>c.diagnostics.some(item=>item.source===source&&item.severity==='error'&&new Date(item.createdAt).getTime()>=since),deliveryFailed=channel=>(c.operations.deliveryEvents||[]).some(item=>item.channel===channel&&item.status==='failed'&&new Date(item.updatedAt).getTime()>=since);
  const services={stripe:Boolean(process.env.STRIPE_SECRET_KEY)&&!hasRecentFailure('stripe'),email:isEmailConfigured()&&!deliveryFailed('email'),push:isPushConfigured()&&!deliveryFailed('push'),esim:Boolean(process.env.ESIM_PROVIDER_API_KEY||process.env.ESIM_ACCESS_CODE)&&!hasRecentFailure('esim_access')};
  const healthy=report.status==='healthy'&&Object.values(services).every(Boolean);
  for(const admin of adminAuth.listAdmins().filter(a=>a.role==='super_admin'&&!a.blocked))await sendEmail({to:admin.email,subject:`${healthy?'✅':'🚨'} Щоденний звіт Signal — ${healthy?'усе добре':'потрібна увага'}`,html:emailTemplates.dailyAdminReport({report,services})}).catch(error=>console.error('[daily report]',error.message));
}
app.get('/api/admin/control-center',adminAuth.requireAdmin,(req,res)=>{
  const c=controlContext(),recon=controlCenter.reconciliation(c.users),balance=c.operations.providerBalance||{},estimated=balance.amount!=null&&balance.averageOrderCost>0?Math.floor(balance.amount/balance.averageOrderCost):null;
  const providerLevel=estimated==null?'unknown':estimated<3?'critical':estimated<10?'warning':'healthy';
  res.json({generatedAt:new Date().toISOString(),summary:{attention:c.attention.length,critical:c.attention.filter(i=>i.severity==='critical').length,jobsFailed:(c.operations.jobs||[]).filter(j=>j.status==='failed').length,deliveriesFailed:(c.operations.deliveryEvents||[]).filter(d=>d.status==='failed').length,reconciliationIssues:recon.summary.issues},attention:c.attention.slice(0,300),reconciliation:recon,support:c.support,provider:{...balance,estimatedOrders:estimated,level:providerLevel,salesPaused:providerLevel==='critical'},services:{server:true,database:Boolean(process.env.DATABASE_URL),stripe:Boolean(process.env.STRIPE_SECRET_KEY),esim:Boolean(process.env.ESIM_PROVIDER_API_KEY||process.env.ESIM_ACCESS_CODE),mobileTopups:mobileTopups.publicStatus(),email:isEmailConfigured(),push:isPushConfigured(),deepl:translationService.status()},jobs:(c.operations.jobs||[]).slice(0,300),deliveries:(c.operations.deliveryEvents||[]).slice(0,300),featureFlags:c.operations.featureFlags,featureRules:c.operations.featureRules,versionInfo:c.operations.versionInfo,latestReport:(c.operations.dailyReports||[])[0]||null});
});
app.get('/api/app-version',(req,res)=>{const v=operationsStore.store().versionInfo;res.json({frontend:v.frontend,serviceWorker:v.serviceWorker,cache:v.cache,criticalRefreshToken:v.criticalRefreshToken,criticalAssets:v.criticalAssets||[]});});
app.post('/api/account/client-version',requireUserSession,(req,res)=>{const state=operationsStore.store(),safe={frontend:String(req.body?.frontend||'unknown').slice(0,40),serviceWorker:String(req.body?.serviceWorker||'unknown').slice(0,40),cache:String(req.body?.cache||'unknown').slice(0,80),platform:String(req.body?.platform||'web').slice(0,40),lastSeenAt:new Date().toISOString()};state.clientVersions[req.userEmail]=safe;operationsStore.save();res.status(202).json({ok:true});});
app.get('/api/admin/versions',adminAuth.requireAdmin,(req,res)=>{const state=operationsStore.store(),current=state.versionInfo,clients=Object.entries(state.clientVersions||{}).map(([email,item])=>({email,...item,old:item.frontend!==current.frontend||item.serviceWorker!==current.serviceWorker}));res.json({current,clients,summary:{tracked:clients.length,old:clients.filter(x=>x.old).length,current:clients.filter(x=>!x.old).length,untracked:Math.max(0,Object.keys(getAllUsers()).length-clients.length)}});});
app.post('/api/admin/versions/request-update',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage'),async(req,res)=>{const state=operationsStore.store(),clients=state.clientVersions||{},targets=Object.entries(clients).filter(([,item])=>item.frontend!==state.versionInfo.frontend||item.serviceWorker!==state.versionInfo.serviceWorker).map(([email])=>email);let delivered=0;for(const email of targets)try{delivered+=await sendToEmail(email,{title:'Доступне оновлення Signal',body:'Відкрийте застосунок, щоб отримати останні виправлення та покращення.',url:'/dashboard.html',tag:`app-update-${state.versionInfo.frontend}`});}catch{}state.versionInfo.updateRequestedAt=new Date().toISOString();operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'app_update_requested',target:`${targets.length} users`,details:{delivered,frontend:state.versionInfo.frontend}});res.json({ok:true,targets:targets.length,delivered});});
app.post('/api/admin/versions/critical-refresh',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage',{requireTwoFactor:true}),(req,res)=>{const state=operationsStore.store(),allowed=['/i18n.js','/style.css','/experience.css','/experience.js','/pwa.js','/sw.js','/config.js','/admin-common.js'],assets=[...new Set((req.body?.assets||[]).filter(item=>allowed.includes(item)))];if(!assets.length)return res.status(400).json({error:'Оберіть хоча б один критичний файл'});state.versionInfo.criticalAssets=assets;state.versionInfo.criticalRefreshToken=`refresh_${Date.now().toString(36)}`;state.versionInfo.criticalRefreshAt=new Date().toISOString();operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'critical_assets_refresh_requested',target:assets.join(', '),details:{token:state.versionInfo.criticalRefreshToken}});res.json({ok:true,token:state.versionInfo.criticalRefreshToken,assets});});
app.post('/api/admin/attention/:id/resolve',adminAuth.requireAdmin,adminAuth.requirePermission('operations.manage'),(req,res)=>{const state=operationsStore.store();state.resolvedAttention[req.params.id]={by:req.admin.email,at:new Date().toISOString(),note:String(req.body?.note||'').slice(0,500)};operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'attention_resolved',target:req.params.id});res.json({ok:true});});
app.post('/api/admin/jobs',adminAuth.requireAdmin,adminAuth.requirePermission('operations.manage'),(req,res)=>{const job=operationsStore.addJob({type:req.body?.type,email:req.body?.email,purchaseId:req.body?.purchaseId,payload:req.body?.payload,retryable:req.body?.retryable!==false});auditStore.log({adminEmail:req.admin.email,action:'job_created',target:job.id,details:{type:job.type}});res.json(job);});
app.post('/api/admin/jobs/:id/retry',adminAuth.requireAdmin,adminAuth.requirePermission('operations.manage'),(req,res)=>{const current=operationsStore.store().jobs.find(j=>j.id===req.params.id);if(!current)return res.status(404).json({error:'Завдання не знайдено'});if(!current.retryable)return res.status(409).json({error:'Ця помилка не допускає автоматичного повтору'});const job=operationsStore.updateJob(current.id,{status:'pending',attempts:Number(current.attempts||0)+1,error:null,nextAttemptAt:new Date().toISOString()});auditStore.log({adminEmail:req.admin.email,action:'job_retried',target:job.id});res.json(job);});
app.post('/api/admin/deliveries/:id/retry',adminAuth.requireAdmin,adminAuth.requirePermission('operations.manage'),async(req,res)=>{const item=operationsStore.store().deliveryEvents.find(d=>d.id===req.params.id);if(!item)return res.status(404).json({error:'Подію доставки не знайдено'});try{if(item.channel==='push')await sendToEmail(item.recipient,{title:item.subject||'Signal',body:'Повторне повідомлення від Signal',url:'/dashboard.html',tag:`retry-${item.id}`});else await sendEmail({to:item.recipient,subject:item.subject||'Повторне повідомлення Signal',html:emailTemplates.notification({title:item.subject||'Signal',message:'Повторне службове повідомлення. Відкрийте застосунок для деталей.'})});operationsStore.updateDelivery(item.id,{status:'retried',attempts:Number(item.attempts||1)+1,error:null});res.json({ok:true});}catch(error){operationsStore.updateDelivery(item.id,{status:'failed',attempts:Number(item.attempts||1)+1,error:error.message});res.status(502).json({error:error.message});}});
app.get('/api/admin/users/:email/timeline',adminAuth.requireAdmin,adminAuth.requirePermission('users.read'),(req,res)=>{const c=controlContext(),result=controlCenter.userTimeline(String(req.params.email).toLowerCase(),c);if(!result)return res.status(404).json({error:'Користувача не знайдено'});res.json(result);});
app.get('/api/admin/localization-health',adminAuth.requireAdmin,(req,res)=>res.json(translationService.status()));
app.delete('/api/admin/localization-cache',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage',{requireTwoFactor:true}),(req,res)=>{const removed=translationService.clearCache();auditStore.log({adminEmail:req.admin.email,action:'translation_cache_cleared',details:{removed}});res.json({ok:true,removed});});
app.post('/api/admin/localization-manual',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage'),(req,res)=>{try{const result=translationService.setManual(req.body?.source,req.body?.translated);auditStore.log({adminEmail:req.admin.email,action:'manual_translation_saved',target:result.source});res.json(result);}catch(error){res.status(400).json({error:error.message});}});
app.patch('/api/admin/feature-flags',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage',{requireTwoFactor:true}),(req,res)=>{const state=operationsStore.store(),allowed=Object.keys(state.featureFlags),before={...state.featureFlags};for(const [key,value] of Object.entries(req.body||{}))if(allowed.includes(key))state.featureFlags[key]=Boolean(value);operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'feature_flags_updated',target:'global',details:{before,after:state.featureFlags,changed:Object.keys(state.featureFlags).filter(key=>before[key]!==state.featureFlags[key])}});res.json(state.featureFlags);});
app.patch('/api/admin/feature-rules',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage',{requireTwoFactor:true}),(req,res)=>{const state=operationsStore.store(),before=JSON.parse(JSON.stringify(state.featureRules||{})),cleanList=value=>[...new Set((Array.isArray(value)?value:[]).map(x=>String(x).trim()).filter(Boolean))].slice(0,500);state.featureRules={disabledCountries:cleanList(req.body?.disabledCountries),disabledPackages:cleanList(req.body?.disabledPackages),paymentMethods:{stripeCard:req.body?.paymentMethods?.stripeCard!==false}};operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'feature_rules_updated',target:'catalog_and_payments',details:{before,after:state.featureRules}});res.json(state.featureRules);});
app.patch('/api/admin/provider-balance',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage'),async(req,res)=>{const amount=req.body?.amount==null?null:Number(req.body.amount),averageOrderCost=req.body?.averageOrderCost==null?null:Number(req.body.averageOrderCost);if((amount!=null&&!Number.isFinite(amount))||(averageOrderCost!=null&&(!Number.isFinite(averageOrderCost)||averageOrderCost<=0)))return res.status(400).json({error:'Вкажіть коректні числові значення'});const balance={amount,currency:String(req.body?.currency||'USD').slice(0,8),averageOrderCost,updatedAt:new Date().toISOString(),source:'manual'};operationsStore.store().providerBalance=balance;operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'provider_balance_updated',details:balance});const orders=amount!=null&&averageOrderCost>0?Math.floor(amount/averageOrderCost):null;if(orders!=null&&orders<10){for(const admin of adminAuth.listAdmins().filter(a=>a.role==='super_admin'&&!a.blocked))sendEmail({to:admin.email,subject:`${orders<3?'🚨':'⚠️'} Низький баланс eSIM Access`,html:emailTemplates.notification({title:orders<3?'Продажі призупинено':'Потрібно поповнити баланс',message:`Поточного балансу орієнтовно вистачить на ${orders} замовлень.`,actionUrl:'/admin-control-center.html#settings',actionLabel:'Відкрити баланс'})}).catch(()=>{});}res.json(balance);});
app.patch('/api/admin/version-info',adminAuth.requireAdmin,adminAuth.requirePermission('settings.manage'),(req,res)=>{const state=operationsStore.store(),current=state.versionInfo,before={...current},entry=String(req.body?.change||'').trim();state.versionInfo={...current,frontend:String(req.body?.frontend||current.frontend).slice(0,40),backend:String(req.body?.backend||current.backend).slice(0,40),serviceWorker:String(req.body?.serviceWorker||current.serviceWorker).slice(0,40),cache:String(req.body?.cache||current.cache).slice(0,80),deployedAt:req.body?.deployedAt||new Date().toISOString(),changelog:entry?[{id:`change_${Date.now().toString(36)}`,version:String(req.body?.frontend||current.frontend),text:entry.slice(0,500),createdAt:new Date().toISOString(),by:req.admin.email},...(current.changelog||[])].slice(0,100):current.changelog};operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'version_info_updated',target:state.versionInfo.frontend,details:{before,after:state.versionInfo}});res.json(state.versionInfo);});
app.post('/api/admin/daily-report/generate',adminAuth.requireAdmin,adminAuth.requirePermission('operations.manage'),(req,res)=>{const c=controlContext(),report=controlCenter.dailyReport(c);c.operations.dailyReports.unshift(report);c.operations.dailyReports=c.operations.dailyReports.slice(0,90);operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'daily_report_generated',details:{status:report.status}});res.json(report);});
app.patch('/api/admin/team/:email/permissions',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{try{const result=adminAuth.setPermissions({email:req.params.email,permissions:req.body?.permissions});auditStore.log({adminEmail:req.admin.email,action:'admin_permissions_updated',target:result.email,details:{permissions:result.permissions}});res.json(result);}catch(error){res.status(400).json({error:error.message});}});

app.get('/api/admin/operations', adminAuth.requireAdmin, async (req, res) => {await operationsStore.refresh();res.json(operationsStore.store());});
app.post('/api/admin/announcements', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req,res) => {
  await operationsStore.refresh();
  const { title, message, audience='all', expiresAt=null, sendPush=false, type='notice' } = req.body || {};
  if(!title || !message) return res.status(400).json({error:'Вкажіть заголовок і текст'});
  const isMaintenance = type === 'maintenance' || /^\s*\[maintenance\]/i.test(String(title));
  if(isMaintenance&&!expiresAt)return res.status(400).json({error:'Для технічних робіт обов’язково вкажіть час завершення'});
  const normalizedAudience = isMaintenance ? 'all' : String(audience || 'all').trim().toLowerCase();
  if (normalizedAudience !== 'all' && !authStore.readAll().users?.[normalizedAudience] && !getUser(normalizedAudience)) return res.status(404).json({error:'Користувача з таким email не знайдено'});
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) return res.status(400).json({error:'Некоректна дата завершення'});
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return res.status(400).json({error:'Час завершення має бути в майбутньому'});
  const announcement={ id:Date.now().toString(36), title:String(title).replace(/^\s*\[maintenance\]\s*/i,'').slice(0,100), message:String(message).slice(0,500), audience:normalizedAudience, type:isMaintenance?'maintenance':'notice', startsAt:new Date().toISOString(), expiresAt:expiresAt||null, createdBy:req.admin.email };
  operationsStore.store().announcements.unshift(announcement); await operationsStore.saveNow();
  let pushRecipients = 0, pushDelivered = 0;
  if(sendPush && isPushConfigured()) {
    const recipients = normalizedAudience === 'all' ? Object.keys(authStore.readAll().users || {}) : [normalizedAudience];
    pushRecipients = recipients.length;
    for (const email of recipients) {
      try {
        const [localizedTitle, localizedMessage] = await Promise.all([translationService.forEmail(email, announcement.title, getUser), translationService.forEmail(email, announcement.message, getUser)]);
        pushDelivered += await sendToEmail(email,{title:localizedTitle,body:localizedMessage,url:'/dashboard.html',tag:`announcement-${announcement.id}`});
      } catch (error) { console.error(`[announcement push] ${email}:`, error.message); }
    }
  }
  auditStore.log({adminEmail:req.admin.email,action:'announcement_created',target:normalizedAudience,details:{id:announcement.id,type:announcement.type,sendPush,pushRecipients,pushDelivered}}); res.json({...announcement,pushRecipients,pushDelivered,pushConfigured:isPushConfigured()});
});
app.get('/api/admin/security-incident',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{
  const state=operationsStore.store(),active=(state.announcements||[]).find(item=>item.type==='security'&&(!item.expiresAt||new Date(item.expiresAt)>new Date()));
  const events=state.securityEvents||[],since=Date.now()-24*60*60*1000;
  res.json({active:active||null,events:events.slice(0,100),counts:{last24h:events.filter(item=>new Date(item.createdAt).getTime()>=since).length,critical24h:events.filter(item=>item.severity==='critical'&&new Date(item.createdAt).getTime()>=since).length},pushConfigured:isPushConfigured(),emailConfigured:isEmailConfigured()});
});
app.post('/api/admin/security-incident/activate',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),async(req,res)=>{
  const title=String(req.body?.title||'Важливе повідомлення безпеки').trim().slice(0,100),message=String(req.body?.message||'Ми перевіряємо безпеку системи. Ваш акаунт залишається активним. Не повідомляйте нікому пароль, PIN або коди підтвердження.').trim().slice(0,1000);
  const durationMinutes=Math.min(1440,Math.max(15,Number(req.body?.durationMinutes)||120)),expiresAt=new Date(Date.now()+durationMinutes*60000).toISOString(),state=operationsStore.store();
  state.announcements=(state.announcements||[]).filter(item=>item.type!=='security');
  const incident={id:`security_${Date.now().toString(36)}`,title,message,audience:'all',type:'security',startsAt:new Date().toISOString(),expiresAt,createdBy:req.admin.email};state.announcements.unshift(incident);operationsStore.save();
  let delivered=0;const recipients=Object.keys(authStore.readAll().users||{});
  if(req.body?.sendPush&&isPushConfigured())for(const email of recipients){try{delivered+=await sendToEmail(email,{title:`🛡️ ${title}`,body:message,url:'/dashboard.html',tag:'security-incident-user'})}catch{}}
  auditStore.log({adminEmail:req.admin.email,action:'security_incident_activated',target:incident.id,details:{durationMinutes,pushRecipients:recipients.length,pushDelivered:delivered}});res.json({ok:true,incident,pushRecipients:recipients.length,pushDelivered:delivered});
});
app.post('/api/admin/security-incident/deactivate',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{const state=operationsStore.store(),removed=(state.announcements||[]).filter(item=>item.type==='security').length;state.announcements=(state.announcements||[]).filter(item=>item.type!=='security');operationsStore.save();auditStore.log({adminEmail:req.admin.email,action:'security_incident_deactivated',details:{removed}});res.json({ok:true,removed});});
app.post('/api/admin/security-incident/revoke-user-sessions',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{
  if(String(req.body?.adminEmail||'').trim().toLowerCase()!==req.admin.email||String(req.body?.confirmation||'')!=='ЗАВЕРШИТИ СЕСІЇ')return res.status(400).json({error:'Введіть точний email і фразу ЗАВЕРШИТИ СЕСІЇ'});
  const auth=authStore.readAll(),revoked=Object.keys(auth.sessions||{}).length;auth.sessions={};authStore.writeAll(auth);auditStore.log({adminEmail:req.admin.email,action:'all_user_sessions_revoked',details:{revoked}});res.json({ok:true,revoked});
});
app.post('/api/admin/notify-bulk', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req,res) => {
  const { channel, title, message, status, plan, minUsage } = req.body || {};
  if(!['push','email'].includes(channel) || !message) return res.status(400).json({error:'Оберіть канал і введіть текст'});
  const users=Object.values(getAllUsers()).filter(user => (!status || user.status===status) && (!plan || user.plan===plan) && (!minUsage || (user.esim?.dataLimitGb && (user.esim.usedGb||0)/user.esim.dataLimitGb*100>=Number(minUsage))));
  if(users.length>200) return res.status(400).json({error:'Занадто багато отримувачів; звузьте фільтр до 200'});
  let delivered=0;
  for(const user of users){ try { const localizedTitle=await translationService.forEmail(user.email,title||'Signal',getUser); const localizedMessage=await translationService.forEmail(user.email,String(message),getUser); if(channel==='push') delivered += await sendToEmail(user.email,{title:localizedTitle,body:localizedMessage,url:'/dashboard.html',tag:'bulk-message'}); else { await sendEmail({to:user.email,subject:localizedTitle,html:emailTemplates.notification({title:localizedTitle,message:localizedMessage})}); delivered++; } } catch(e){} }
  auditStore.log({adminEmail:req.admin.email,action:'bulk_notification_sent',target:`${users.length} users`,details:{channel,status,plan,minUsage,delivered}}); res.json({ok:true,recipients:users.length,delivered});
});

function uniqueEmails(values) {
  return [...new Set(values.map(value=>String(value||'').trim().toLowerCase()).filter(value=>/^\S+@\S+\.\S+$/.test(value)))];
}

async function deliverBroadcast({ recipients, subject, html }) {
  const delivered=[];
  const failed=[];
  for(let offset=0;offset<recipients.length;offset+=5){
    const batch=recipients.slice(offset,offset+5);
    const results=await Promise.allSettled(batch.map(email=>sendEmail({to:email,subject,html})));
    results.forEach((result,index)=>{
      const email=batch[index];
      if(result.status==='fulfilled'&&!result.value?.mocked) delivered.push(email);
      else failed.push({email,error:result.status==='rejected'?String(result.reason?.message||result.reason).slice(0,240):'Email-сервіс працює в тестовому режимі'});
    });
  }
  return {delivered,failed};
}

app.get('/api/admin/email-broadcasts',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{
  const staff=adminAuth.listAdmins().filter(admin=>!admin.blocked);
  const users=Object.entries(getAllUsers()).map(([email,user])=>({...user,email:user.email||email}));
  res.json({
    configured:isEmailConfigured(),
    counts:{staff:uniqueEmails(staff.map(admin=>admin.email)).length,superAdmins:staff.filter(admin=>admin.role==='super_admin').length,customers:uniqueEmails(users.map(user=>user.email)).length,activeCustomers:uniqueEmails(users.filter(user=>user.status==='active').map(user=>user.email)).length},
    staffByRole:staff.reduce((summary,admin)=>({...summary,[admin.role]:(summary[admin.role]||0)+1}),{}),
    history:(operationsStore.store().emailBroadcasts||[]).slice(0,100),
  });
});

app.post('/api/admin/email-broadcasts/:audience',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),async(req,res)=>{
  const audience=String(req.params.audience||'');
  const title=String(req.body?.title||'').trim();
  const message=String(req.body?.message||'').trim();
  if(!['staff','customers'].includes(audience)) return res.status(400).json({error:'Невідома аудиторія розсилки'});
  if(title.length<3||title.length>120) return res.status(400).json({error:'Заголовок має містити від 3 до 120 символів'});
  if(!message||message.length>5000) return res.status(400).json({error:'Текст має містити від 1 до 5000 символів'});
  if(!isEmailConfigured()) return res.status(503).json({error:'Email-розсилку не налаштовано: додайте RESEND_API_KEY та підтверджену адресу RESEND_FROM_EMAIL'});

  let recipients=[];
  let filter='all';
  if(audience==='staff'){
    recipients=uniqueEmails(adminAuth.listAdmins().filter(admin=>!admin.blocked).map(admin=>admin.email));
  } else {
    const users=Object.entries(getAllUsers()).map(([email,user])=>({...user,email:user.email||email}));
    filter=['all','active','single'].includes(req.body?.filter)?req.body.filter:'all';
    const optedIn=users.filter(user=>user.preferences?.marketingEmails===true);
    if(filter==='active') recipients=uniqueEmails(optedIn.filter(user=>user.status==='active').map(user=>user.email));
    else if(filter==='single'){
      const requested=String(req.body?.email||'').trim().toLowerCase();
      const found=optedIn.find(user=>String(user.email||'').toLowerCase()===requested);
      if(!found) return res.status(404).json({error:'Користувача з таким email не знайдено'});
      recipients=[found.email];
    } else recipients=uniqueEmails(optedIn.map(user=>user.email));
  }
  if(!recipients.length) return res.status(400).json({error:'У вибраній аудиторії немає отримувачів'});

  const html=emailTemplates.broadcast({title,message,audience,senderEmail:req.admin.email});
  const delivery=await deliverBroadcast({recipients,subject:`${title} — Сигнал`,html});
  const record={id:`mail_${Date.now().toString(36)}`,audience,filter,title,message,sender:req.admin.email,createdAt:new Date().toISOString(),recipientCount:recipients.length,deliveredCount:delivery.delivered.length,failedCount:delivery.failed.length,failures:delivery.failed.slice(0,20)};
  const state=operationsStore.store();
  (state.emailBroadcasts||=[]).unshift(record);
  state.emailBroadcasts=state.emailBroadcasts.slice(0,200);
  operationsStore.save();
  auditStore.log({adminEmail:req.admin.email,action:'email_broadcast_sent',target:audience,details:{id:record.id,filter,recipients:recipients.length,delivered:delivery.delivered.length,failed:delivery.failed.length}});
  res.json({ok:delivery.failed.length===0,...record});
});
app.delete('/api/admin/announcements/:id', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req,res)=>{ await operationsStore.refresh();const s=operationsStore.store(),found=s.announcements.find(a=>a.id===req.params.id);if(found?.type==='security'&&req.admin.role!=='super_admin')return res.status(403).json({error:'Режим безпеки може вимкнути лише Super Admin'});s.announcements=s.announcements.filter(a=>a.id!==req.params.id);await operationsStore.saveNow();auditStore.log({adminEmail:req.admin.email,action:'announcement_deleted',target:req.params.id});res.json({ok:true}); });
app.post('/api/admin/users/:email/note', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), (req,res)=>{ const text=String(req.body?.text||'').trim(); if(!text) return res.status(400).json({error:'Введіть нотатку'}); const s=operationsStore.store(); (s.notes[req.params.email] ||= []).push({text:text.slice(0,1000),by:req.admin.email,createdAt:new Date().toISOString()}); operationsStore.save(); auditStore.log({adminEmail:req.admin.email,action:'user_note_added',target:req.params.email}); res.json({ok:true}); });
app.post('/api/admin/blacklist', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), (req,res)=>{ const {type,value}=req.body||{}; if(!['emails','iccids'].includes(type)||!value) return res.status(400).json({error:'Некоректні дані'}); const list=operationsStore.store().blacklist[type]; if(!list.includes(value)) list.push(value); operationsStore.save(); auditStore.log({adminEmail:req.admin.email,action:'blacklist_added',target:value}); res.json({ok:true}); });
app.delete('/api/admin/blacklist/:type/:value', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), (req,res)=>{ const list=operationsStore.store().blacklist[req.params.type]; if(!list) return res.status(400).json({error:'Некоректний список'}); operationsStore.store().blacklist[req.params.type]=list.filter(v=>v!==req.params.value); operationsStore.save(); res.json({ok:true}); });
app.post('/api/admin/templates', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), (req,res)=>{ const {title,text}=req.body||{}; if(!title||!text) return res.status(400).json({error:'Вкажіть назву і текст'}); const template={id:Date.now().toString(36),title:String(title).slice(0,100),text:String(text).slice(0,2000),by:req.admin.email}; operationsStore.store().templates.unshift(template); operationsStore.save(); res.json(template); });
app.delete('/api/admin/templates/:id', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), (req,res)=>{ const s=operationsStore.store(); s.templates=s.templates.filter(t=>t.id!==req.params.id); operationsStore.save(); res.json({ok:true}); });
function buildBackupPayload() {
  const data=backupService.sanitizeTransient(storage.snapshot(BACKUP_STATE_KEYS));
  return {schemaVersion:1,backupId:`backup_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,createdAt:new Date().toISOString(),service:'Signal eSIM',data};
}
function backupFilename(prefix='signal-backup'){return `${prefix}-${new Date().toISOString().replace(/[:.]/g,'-')}.signalbackup`;}
function sendBackupFile(res,buffer,filename){res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.setHeader('Cache-Control','no-store');res.send(buffer);}

app.get('/api/admin/backup/status',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),async(req,res)=>{
  const safety=await storage.load('safety-backup.json',null);
  res.json({configured:String(process.env.BACKUP_ENCRYPTION_KEY||'').length>=24,safetyBackup:safety?{createdAt:safety.createdAt,createdBy:safety.createdBy}:null,current:backupService.summary(buildBackupPayload())});
});
app.get('/api/admin/backup',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('backups.manage',{requireTwoFactor:true}),(req,res)=>{
  try{const payload=buildBackupPayload(),encrypted=backupService.encrypt(payload);auditStore.log({adminEmail:req.admin.email,action:'encrypted_backup_exported',details:backupService.summary(payload)});sendBackupFile(res,encrypted,backupFilename());}
  catch(error){res.status(error.code==='BACKUP_NOT_CONFIGURED'?503:500).json({error:error.message,code:error.code});}
});
app.get('/api/admin/backup/safety',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),async(req,res)=>{
  const safety=await storage.load('safety-backup.json',null);
  if(!safety?.file)return res.status(404).json({error:'Страхової копії ще немає'});
  auditStore.log({adminEmail:req.admin.email,action:'safety_backup_downloaded',details:{createdAt:safety.createdAt}});sendBackupFile(res,Buffer.from(safety.file,'base64'),backupFilename('signal-before-restore'));
});
app.post('/api/admin/backup/inspect',express.raw({type:'application/octet-stream',limit:'50mb'}),adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),(req,res)=>{
  try{if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Оберіть файл .signalbackup'});const payload=backupService.validate(backupService.decrypt(req.body));const restoreToken=crypto.randomBytes(32).toString('hex');pendingBackupRestores.set(restoreToken,{payload,adminEmail:req.admin.email,expiresAt:Date.now()+10*60*1000});for(const [token,item] of pendingBackupRestores)if(item.expiresAt<Date.now())pendingBackupRestores.delete(token);auditStore.log({adminEmail:req.admin.email,action:'backup_restore_inspected',target:payload.backupId,details:backupService.summary(payload)});res.json({ok:true,restoreToken,expiresIn:600,summary:backupService.summary(payload)});}
  catch(error){recordSecurityFailure(req,'backup_restore',error.code,req.admin.email);auditStore.log({adminEmail:req.admin.email,action:'backup_restore_rejected',details:{code:error.code}});res.status(400).json({error:error.message,code:error.code});}
});
app.post('/api/admin/backup/restore',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('backups.manage',{requireTwoFactor:true}),async(req,res)=>{
  const item=pendingBackupRestores.get(String(req.body?.restoreToken||''));
  if(!item||item.expiresAt<Date.now()||item.adminEmail!==req.admin.email)return res.status(400).json({error:'Перевірка копії завершилася. Завантажте файл ще раз'});
  if(String(req.body?.confirmation||'')!=='ВІДНОВИТИ'||String(req.body?.adminEmail||'').trim().toLowerCase()!==req.admin.email)return res.status(400).json({error:'Введіть слово ВІДНОВИТИ та точний email Super Admin'});
  try{
    const before=buildBackupPayload(),safetyFile=backupService.encrypt(before);
    await storage.saveNow('safety-backup.json',{createdAt:new Date().toISOString(),createdBy:req.admin.email,file:safetyFile.toString('base64')});
    const restored=backupService.sanitizeTransient(item.payload.data);
    await storage.restoreMany(restored);
    await Promise.all([bootstrapUsers(),authStore.bootstrap(),pushStore.bootstrap(),adminStore.bootstrap(),ticketStore.bootstrap(),auditStore.bootstrap(),operationsStore.bootstrap(),translationService.bootstrap(),diagnosticsStore.bootstrap()]);
    await adminAuth.bootstrap();
    pendingBackupRestores.delete(String(req.body.restoreToken));
    auditStore.log({adminEmail:req.admin.email,action:'backup_restored',target:item.payload.backupId,details:{...backupService.summary(item.payload),allSessionsRevoked:true,safetyBackupCreated:true}});
    res.json({ok:true,message:'Дані відновлено. Усі сесії завершено — увійдіть знову.',summary:backupService.summary(item.payload)});
  }catch(error){res.status(500).json({error:`Відновлення не завершено: ${error.message}`});}
});
app.get('/api/admin/system-status', adminAuth.requireAdmin, (req,res)=>res.json({ server:'ok', database:Boolean(process.env.DATABASE_URL), push:isPushConfigured(), esimProvider:Boolean(process.env.ESIM_PROVIDER_API_KEY), stripe:Boolean(process.env.STRIPE_SECRET_KEY), checkedAt:new Date().toISOString() }));

// Список користувачів для адмінки
app.get('/api/admin/users', adminAuth.requireAdmin, (req, res) => {
  const authData = authStore.readAll();
  const allEmails = new Set([...Object.keys(authData.users || {}), ...Object.keys(getAllUsers())]);
  const users = [...allEmails].map(email => ({
    email,
    createdAt: authData.users[email]?.createdAt || getUser(email)?.createdAt,
    subscription: getUser(email) || null,
  }));
  res.json(users);
});

app.get('/api/admin/users/:email', adminAuth.requireAdmin, (req, res) => {
  const email = req.params.email;
  const authUser = authStore.readAll().users?.[email];
  const subscription = getUser(email);
  if (!authUser && !subscription) return res.status(404).json({ error: 'Користувача не знайдено' });
  const safeSubscription = subscription ? JSON.parse(JSON.stringify(subscription)) : null;
  if (req.admin.role !== 'super_admin' && safeSubscription?.esim) {
    delete safeSubscription.esim.activationCode;
    delete safeSubscription.esim.qrCodeUrl;
  }
  const sessions = Object.values(authStore.readAll().sessions || {}).filter((session) => session.email === email).length;
  const pushDevices = pushStore.subscriptionsFor(email).length;
  res.json({
    email,
    account: authUser ? {
      createdAt: authUser.createdAt || null,
      lastLoginAt: authUser.lastLoginAt || null,
      displayName: subscription?.displayName || '',
      avatarDataUrl: subscription?.avatarDataUrl || null,
    } : null,
    subscription: safeSubscription,
    security: { activeSessions: sessions, pushDevices },
    billing: subscription ? {linked:Boolean(subscription.stripeCustomerId),customerId:subscription.stripeCustomerId||null,subscriptionId:subscription.stripeSubscriptionId||null,linkedAt:subscription.stripeProfileLinkedAt||null,lastCheckedAt:subscription.stripeProfileLastCheckedAt||null,source:subscription.stripeProfileSource||null,duplicateProfiles:Math.max(0,Number(subscription.stripeProfileCustomerCount||0)-1)} : {linked:false},
    notes: operationsStore.store().notes[email] || [],
    tickets: ticketStore.getTicketsByEmail(email),
  });
});

app.get('/api/admin/users/:email/refundable-payments', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  try {
    const email = String(req.params.email || '').trim().toLowerCase();
    const user = getUser(email);
    const payments = await listRefundablePaymentsByEmail(email, user?.stripeCustomerId || null);
    res.json({ payments });
  } catch (error) {
    res.status(502).json({ error: `Stripe: ${error.message}` });
  }
});

app.post('/api/admin/users/:email/sync-stripe-status', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const user = getUser(email);
  if (!user && !authStore.readAll().users?.[email]) return res.status(404).json({ error:'Користувача не знайдено' });
  try {
    const profile=await recoverStripeProfile(email);
    const state = await getSubscriptionStateByEmail(email, profile.customerId || user?.stripeCustomerId || null);
    const status = state.active.length ? 'active' : state.subscriptions.length ? 'canceled' : (user?.status || 'registered');
    saveUser(email, {
      status,
      stripeCustomerIds: state.customerIds,
      stripeSubscriptionIds: state.subscriptions.map(subscription => subscription.id),
      ...(profile.customerId?{stripeCustomerId:profile.customerId}:{}),
      ...(profile.subscriptionId?{stripeSubscriptionId:profile.subscriptionId}:{}),
      stripeStatusSyncedAt: new Date().toISOString(),
      ...(status === 'canceled' ? { canceledAt:new Date().toISOString(), canceledReason:'stripe_sync' } : {}),
    });
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_status_synchronized', target:email, details:{ status, customerIds:state.customerIds, subscriptions:state.subscriptions } });
    res.json({ ok:true, status, linked:Boolean(profile.customerId), customerId:profile.customerId, duplicateProfiles:Math.max(0,profile.customerCount-1), activeSubscriptions:state.active.length, subscriptions:state.subscriptions });
  } catch (error) {
    res.status(502).json({ error:`Не вдалося перевірити Stripe: ${error.message}` });
  }
});

app.post('/api/admin/users/:email/sync-purchases', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const user = getUser(email);
  if (!user && !authStore.readAll().users?.[email]) return res.status(404).json({ error:'Користувача не знайдено' });
  try {
    const imported = await syncPurchasesForUser(email);
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_purchases_synchronized', target:email, details:{ imported:imported.length } });
    res.json({ ok:true, imported:imported.length, purchases:getUser(email)?.purchases || [] });
  } catch (error) {
    res.status(502).json({ error:`Не вдалося завантажити покупки зі Stripe: ${error.message}` });
  }
});

app.get('/api/admin/mobile-topups', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support','viewer'), (req,res)=>{
  const canSeePhone=['super_admin','admin'].includes(req.admin.role);
  const orders=Object.values(getAllUsers()).flatMap(user=>(user.mobileTopupOrders||[]).map(order=>({
    ...safeMobileTopupOrder(order),
    email:user.email,
    phone:canSeePhone?order.phone:undefined,
    providerTransactionId:order.providerTransactionId||null,
    providerEnvironment:order.providerEnvironment||null,
    stripeSessionId:order.stripeSessionId||null,
  }))).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  res.json({provider:mobileTopups.publicStatus(),orders,totals:{all:orders.length,awaitingPayment:orders.filter(item=>item.status==='awaiting_payment').length,processing:orders.filter(item=>item.status==='processing').length,delivered:orders.filter(item=>item.status==='delivered').length,failed:orders.filter(item=>['failed','checkout_failed'].includes(item.status)).length}});
});

app.post('/api/admin/mobile-topups/:orderId/retry',adminAuth.requireAdmin,adminAuth.requireRole('super_admin'),adminAuth.requirePermission('operations.manage',{requireTwoFactor:true}),async(req,res)=>{
  const orderId=String(req.params.orderId||'');
  const owner=Object.values(getAllUsers()).find(user=>(user.mobileTopupOrders||[]).some(order=>order.id===orderId));
  const order=(owner?.mobileTopupOrders||[]).find(item=>item.id===orderId);
  if(!owner||!order)return res.status(404).json({error:'Замовлення поповнення не знайдено'});
  if(order.paymentStatus!=='paid'||!order.stripeSessionId)return res.status(409).json({error:'Повторити можна лише поповнення з підтвердженою оплатою Stripe'});
  if(order.status==='delivered')return res.status(409).json({error:'Пакет уже доставлено. Повторна видача заблокована.'});
  try{
    const result=await fulfillMobileTopupOrder({email:owner.email,orderId,purchaseId:order.stripeSessionId});
    auditStore.log({adminEmail:req.admin.email,action:'mobile_topup_retried',target:orderId,details:{email:owner.email,state:result.state,providerTransactionId:result.transaction?.id||result.order?.providerTransactionId||null}});
    res.json({ok:true,state:result.state,order:safeMobileTopupOrder(result.order)});
  }catch(error){
    auditStore.log({adminEmail:req.admin.email,action:'mobile_topup_retry_failed',target:orderId,details:{email:owner.email,error:error.message,code:error.code}});
    res.status(error.nonRetryable?409:502).json({error:error.message,code:error.code});
  }
});

app.get('/api/admin/purchases', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support','viewer'), (req, res) => {
  const purchases = Object.values(getAllUsers()).flatMap(user => (user.purchases || []).map(purchase => ({ ...purchase, email:user.email, accountStatus:user.status || null })))
    .sort((a,b) => new Date(b.paidAt || b.createdAt || 0) - new Date(a.paidAt || a.createdAt || 0));
  res.json({ purchases, totals:{ purchases:purchases.length, paid:purchases.filter(item=>item.paymentStatus==='paid').length, failed:purchases.filter(item=>item.fulfillmentStatus==='failed').length, provisioned:purchases.filter(item=>item.fulfillmentStatus==='provisioned').length, delivered:purchases.filter(item=>item.fulfillmentStatus==='delivered').length, fulfilled:purchases.filter(item=>['provisioned','delivered'].includes(item.fulfillmentStatus)).length, mobileTopups:purchases.filter(item=>item.kind==='mobile_topup').length } });
});

app.get('/api/admin/plan-changes', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support','viewer'), (req, res) => {
  const changes = Object.values(getAllUsers()).flatMap(user => (user.purchases || [])
    .filter(purchase => ['immediate','after_expiry'].includes(purchase.changeMode))
    .map(purchase => ({ ...purchase, email:user.email, accountStatus:user.status || null, currentPlan:user.plan || null,
      pending:Boolean(user.pendingPlanChange?.purchaseId === purchase.id),
      pendingStatus:user.pendingPlanChange?.purchaseId === purchase.id ? (user.pendingPlanChange.status === 'failed' ? 'failed' : user.pendingPlanChange.cancellationError ? 'needs_attention' : 'scheduled') : null,
    })))
    .sort((a,b) => new Date(b.paidAt || b.createdAt || 0) - new Date(a.paidAt || a.createdAt || 0));
  const statusOf = item => item.fulfillmentStatus === 'failed' ? 'failed'
    : item.cancellationError || item.pendingStatus === 'needs_attention' ? 'needs_attention'
    : item.fulfillmentStatus === 'provisioned' ? 'completed'
    : item.fulfillmentStatus === 'provisioning' ? 'provisioning' : 'scheduled';
  res.json({ changes:changes.map(item => ({ ...item, displayStatus:statusOf(item) })), totals:{
    all:changes.length, scheduled:changes.filter(item => statusOf(item) === 'scheduled').length,
    provisioning:changes.filter(item => statusOf(item) === 'provisioning').length,
    completed:changes.filter(item => statusOf(item) === 'completed').length,
    failed:changes.filter(item => ['failed','needs_attention'].includes(statusOf(item))).length,
  }});
});

app.get('/api/admin/purchases/:purchaseId', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin','support'), async (req, res) => {
  const purchaseId = String(req.params.purchaseId || '');
  const owner = Object.values(getAllUsers()).find(user => (user.purchases || []).some(purchase => purchase.id === purchaseId));
  const purchase = owner?.purchases?.find(item => item.id === purchaseId);
  if (!owner || !purchase) return res.status(404).json({ error:'Покупку не знайдено' });
  try {
    const stripe = await getCheckoutPurchaseDetails(purchase.stripeSessionId || purchase.id);
    const timeline = [
      { type:'payment', title:'Stripe підтвердив оплату', at:purchase.paidAt || purchase.createdAt, detail:`${purchase.amountCents == null ? '—' : (purchase.amountCents/100).toFixed(2)} ${(purchase.currency||'').toUpperCase()}` },
      ...(purchase.retryStartedAt ? [{ type:'retry', title:'Адміністратор повторив видачу', at:purchase.retryStartedAt, detail:null }] : []),
      ...(purchase.failedAt ? [{ type:'failed', title:'Видача eSIM завершилась помилкою', at:purchase.failedAt, detail:purchase.fulfillmentError || null }] : []),
      ...(purchase.fulfilledAt ? [{ type:'provisioned', title:'eSIM успішно видано', at:purchase.fulfilledAt, detail:`Order ${purchase.esimOrderNo || '—'} · ICCID ${purchase.iccid || '—'}` }] : []),
      ...stripe.refunds.map(refund => ({ type:'refund', title:`Повернення ${refund.status}`, at:refund.createdAt, detail:`${(refund.amount/100).toFixed(2)} ${refund.currency.toUpperCase()} · ${refund.id}` })),
      ...(stripe.subscription?.canceledAt ? [{ type:'canceled', title:'Stripe-підписку скасовано', at:stripe.subscription.canceledAt, detail:stripe.subscription.id }] : []),
    ].filter(item=>item.at).sort((a,b)=>new Date(a.at)-new Date(b.at));
    res.json({ email:owner.email, accountStatus:owner.status || null, purchase, stripe, timeline });
  } catch (error) {
    res.status(502).json({ error:`Не вдалося отримати деталі Stripe: ${error.message}` });
  }
});

app.post('/api/admin/purchases/sync-all', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), async (req, res) => {
  const emails = [...new Set([...Object.keys(authStore.readAll().users || {}), ...Object.keys(getAllUsers())])];
  if (emails.length > 500) return res.status(409).json({ error:'Забагато користувачів для одного запуску. Зверніться до розробника для фонової синхронізації.' });
  let imported = 0;
  const errors = [];
  for (const email of emails) {
    try { imported += await syncPurchasesForUser(email); }
    catch (error) { errors.push({ email, error:error.message }); }
  }
  auditStore.log({ adminEmail:req.admin.email, action:'all_stripe_purchases_synchronized', target:`${emails.length} users`, details:{ imported, errors:errors.length } });
  res.json({ ok:true, users:emails.length, imported, errors });
});

app.post('/api/admin/users/:email/refund', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), adminAuth.requirePermission('refunds.manage',{requireTwoFactor:true}), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const { chargeId, amount, reason = 'requested_by_customer', confirmationEmail, requestId } = req.body || {};
  if (String(confirmationEmail || '').trim().toLowerCase() !== email) return res.status(400).json({ error: 'Email підтвердження не збігається' });
  if (!/^ch_[A-Za-z0-9]+$/.test(String(chargeId || ''))) return res.status(400).json({ error: 'Некоректний Stripe-платіж' });
  if (!['requested_by_customer','duplicate','fraudulent'].includes(reason)) return res.status(400).json({ error: 'Некоректна причина повернення' });
  if (!/^[A-Za-z0-9-]{16,80}$/.test(String(requestId || ''))) return res.status(400).json({ error: 'Некоректний ідентифікатор операції' });
  const amountCents = Number(amount);
  const user = getUser(email);
  try {
    const customerIds = await findCustomerIdsByEmail(email, user?.stripeCustomerId || null);
    if (!customerIds.length) return res.status(404).json({ error: 'Stripe-платежі за цим email не знайдено' });
    const refund = await refundPayment({
      customerIds,
      chargeId: String(chargeId),
      amount: amountCents,
      reason,
      metadata: { signal_user_email: email, signal_admin_email: req.admin.email },
      idempotencyKey: `signal-admin-refund-${requestId}`,
    });
    let canceledSubscriptions = [], cancellationErrors = [];
    try {
      const cancellation = await cancelAllSubscriptionsForCustomers(customerIds);
      canceledSubscriptions = cancellation.canceled;
      cancellationErrors = cancellation.errors;
      if (!cancellationErrors.length) saveUser(email, {
          status: 'canceled',
          canceledAt: new Date().toISOString(),
          canceledReason: 'admin_refund',
          lastRefund: { id:refund.id, chargeId, amount:refund.amount, currency:refund.currency, status:refund.status, createdAt:new Date().toISOString() },
        });
    } catch (error) {
      cancellationErrors = [{ id:null, error:error.message }];
      console.error(`[refund cancellation] ${email}:`, error.message);
    }
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_refund_created', target:email, details:{ refundId:refund.id, chargeId, amount:refund.amount, currency:refund.currency, status:refund.status, reason, canceledSubscriptions:canceledSubscriptions.map(item=>item.id), cancellationErrors } });
    res.json({ ok:true, refund:{ id:refund.id, amount:refund.amount, currency:refund.currency, status:refund.status }, subscription:{ canceled:!cancellationErrors.length, canceledCount:canceledSubscriptions.length, ids:canceledSubscriptions.map(item=>item.id), errors:cancellationErrors } });
  } catch (error) {
    auditStore.log({ adminEmail:req.admin.email, action:'stripe_refund_failed', target:email, details:{ chargeId, amount:amountCents, reason, error:error.message } });
    res.status(502).json({ error:`Stripe не виконав повернення: ${error.message}` });
  }
});

// Permanently remove the application account so the same email can register
// again. Billing is stopped before local identity data is erased. Historical
// financial/audit records may still be retained by Stripe or the audit log.
app.delete('/api/admin/users/:email', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), adminAuth.requirePermission('users.delete',{requireTwoFactor:true}), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const confirmationEmail = String(req.body?.confirmationEmail || '').trim().toLowerCase();
  if (confirmationEmail !== email) return res.status(400).json({ error: 'Для підтвердження введіть точний email користувача' });

  const authUser = authStore.readAll().users?.[email];
  const user = getUser(email);
  if (!authUser && !user) return res.status(404).json({ error: 'Користувача не знайдено' });

  try {
    let stripeSubscriptionCanceled = false;
    let stripeCustomerDeleted = false;
    if (user?.stripeSubscriptionId && user.status !== 'canceled') {
      try {
        await cancelSubscription(user.stripeSubscriptionId);
        stripeSubscriptionCanceled = true;
      } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
      }
    }
    if (user?.stripeCustomerId) {
      try {
        await deleteStripeCustomer(user.stripeCustomerId);
        stripeCustomerDeleted = true;
      } catch (error) {
        if (error?.code !== 'resource_missing') throw error;
        stripeCustomerDeleted = true;
      }
    }

    const authRemoval = authService.deleteAccountAuth(email);
    const pushSubscriptions = pushStore.removeAllForEmail(email);
    const tickets = ticketStore.deleteTicketsByEmail(email);
    const diagnosticEvents = diagnosticsStore.removeForEmail(email);

    const operations = operationsStore.store();
    delete operations.notes?.[email];
    if (Array.isArray(operations.feedback)) operations.feedback = operations.feedback.filter(item => item.email !== email);
    if (Array.isArray(operations.blacklist?.emails)) operations.blacklist.emails = operations.blacklist.emails.filter(item => String(item).toLowerCase() !== email);
    operationsStore.save();

    deleteUser(email);
    for (const related of Object.values(getAllUsers())) {
      const patch = {};
      if (related.referredBy === email) patch.referredBy = null;
      if (Array.isArray(related.referrals)) patch.referrals = related.referrals.filter(item => item.email !== email);
      if (Object.keys(patch).length) saveUser(related.email, patch);
    }

    auditStore.log({
      adminEmail: req.admin.email,
      action: 'user_account_permanently_deleted',
      target: email,
      details: { stripeSubscriptionCanceled, stripeCustomerDeleted, sessions: authRemoval.sessions, pushSubscriptions, tickets, diagnosticEvents },
    });
    res.json({
      ok: true,
      emailReusable: true,
      stripeSubscriptionCanceled,
      stripeCustomerDeleted,
      removed: { sessions: authRemoval.sessions, pushSubscriptions, tickets },
      providerEsimNote: user?.esim ? 'Виданий профіль eSIM відв’язано від застосунку; у провайдера він може зберігатися до завершення строку дії.' : null,
    });
  } catch (error) {
    console.error(`[admin delete user] ${email}:`, error.message);
    res.status(502).json({ error: `Видалення зупинено: ${error.message}. Локальний акаунт не видалено.` });
  }
});

app.post('/api/admin/users/:email/revoke-sessions', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), (req, res) => {
  const email = req.params.email;
  if (!authStore.readAll().users?.[email]) return res.status(404).json({ error: 'Користувача не знайдено' });
  const revoked = authService.revokeAllSessions(email);
  auditStore.log({ adminEmail: req.admin.email, action: 'user_sessions_revoked', target: email, details: { revoked } });
  res.json({ ok: true, revoked });
});

app.post('/api/admin/users/:email/notify', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), async (req, res) => {
  const email = req.params.email;
  const { channel, title, message } = req.body || {};
  if (!getUser(email) && !authStore.readAll().users?.[email]) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (!message || String(message).trim().length > 500) return res.status(400).json({ error: 'Введи повідомлення до 500 символів' });
  try {
    let delivered = 0;
    const localizedTitle = await translationService.forEmail(email, title || 'Сигнал', getUser);
    const localizedMessage = await translationService.forEmail(email, String(message), getUser);
    if (channel === 'push') {
      if (!isPushConfigured()) return res.status(503).json({ error: 'Push не налаштовано на сервері. Додайте правильну пару VAPID ключів у Render Environment.' });
      if (!pushStore.subscriptionsFor(email).length) return res.status(409).json({ error: 'У користувача немає підключеного push-пристрою. Попросіть його відкрити «Сповіщення» та натиснути «Увімкнути/перепідключити push».' });
      delivered = await sendToEmail(email, { title: localizedTitle, body: localizedMessage, url: '/dashboard.html', tag: 'admin-message' });
      if (!delivered) return res.status(410).json({ error: 'Push-підписка користувача прострочена або браузер її відхилив. Користувачу потрібно перепідключити push у застосунку.' });
    }
    else if (channel === 'email') {
      await sendEmail({ to: email, subject: localizedTitle, html: emailTemplates.notification({title:localizedTitle,message:localizedMessage}) });
      delivered = 1;
    } else return res.status(400).json({ error: 'Оберіть push або email' });
    auditStore.log({ adminEmail: req.admin.email, action: 'user_notification_sent', target: email, details: { channel, delivered } });
    res.json({ ok: true, delivered });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/admin/users/:email/custom-package-checkout', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = req.params.email;
  const { packageCode, packageName, amountCents, currency = 'usd', dataLimitGb = null, durationDays = null, location = '' } = req.body || {};
  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (user.esim?.orderNo && user.status === 'active') return res.status(409).json({ error: 'У користувача вже є активна eSIM. Продаж другого профілю буде додано окремо, щоб не замінити поточну eSIM.' });
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(packageCode || ''))) return res.status(400).json({ error: 'Некоректний packageCode' });
  if (!String(packageName || '').trim() || String(packageName).length > 120) return res.status(400).json({ error: 'Вкажіть назву пакета' });
  if (!Number.isInteger(Number(amountCents)) || Number(amountCents) < 50 || Number(amountCents) > 1000000) return res.status(400).json({ error: 'Вкажіть ціну в центах: від $0.50 до $10,000' });
  if (!/^[a-z]{3}$/i.test(currency)) return res.status(400).json({ error: 'Некоректна валюта' });
  try {
    const profile=await recoverStripeProfile(email);
    const session = await createCustomPackageCheckout({ email, customerId:profile.customerId||user.stripeCustomerId||null, packageCode: String(packageCode), packageName: String(packageName).trim(), amountCents: Number(amountCents), currency: String(currency).toLowerCase(), dataLimitGb, durationDays, location });
    auditStore.log({ adminEmail: req.admin.email, action: 'custom_package_checkout_created', target: email, details: { packageCode, amountCents, currency } });
    res.json({ ok: true, url: session.url });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/admin/referrals', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), (req, res) => {
  res.json(Object.values(getAllUsers()).filter((user) => user.referredBy).map((user) => ({ email: user.email, referredBy: user.referredBy, status: user.referralRewardStatus || 'pending_first_payment', packageCode: user.referralRewardPackageCode || null, createdAt: user.createdAt || null })));
});

// Resolve the inviter first, then ask eSIM Access which 1 GB top-ups are
// compatible with that exact ICCID. This removes manual package-code entry.
app.get('/api/admin/referrals/:email/compatible-topups', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const invited = getUser(req.params.email);
  if (!invited?.referredBy) return res.status(404).json({ error: 'Для цього користувача не знайдено того, хто запросив' });
  const beneficiary = getUser(invited.referredBy);
  if (!beneficiary?.esim?.iccid) return res.status(409).json({ error: 'У того, хто запросив, немає активної eSIM з ICCID' });
  try {
    const packages = await listPackages({ type: 'TOPUP', iccid: beneficiary.esim.iccid });
    const normalized = packages.map(item => {
      const bytes = Number(item.volume || item.dataVolume || 0);
      const volumeGb = bytes > 0 ? +(bytes / (1024 ** 3)).toFixed(2) : null;
      const rawPrice = Number(item.price ?? 0);
      return {
        packageCode: item.packageCode || item.slug || null,
        slug: item.slug || null,
        name: item.name || item.description || item.packageCode || item.slug || 'Top-up',
        location: item.location || null,
        volumeGb,
        duration: item.duration ?? null,
        durationUnit: item.durationUnit || null,
        currencyCode: item.currencyCode || 'USD',
        price: Number.isFinite(rawPrice) && rawPrice > 0 ? +(rawPrice / 10000).toFixed(2) : null,
      };
    }).filter(item => item.packageCode && item.volumeGb != null && item.volumeGb >= 0.8 && item.volumeGb <= 1.2);
    if (!normalized.length) return res.status(404).json({ error: 'eSIM Access не повернув сумісних пакетів приблизно на 1 ГБ для цієї eSIM' });
    res.json({ beneficiary: beneficiary.email, iccidLast4: String(beneficiary.esim.iccid).slice(-4), packages: normalized });
  } catch (error) {
    console.error(`[referral topups] ${invited.referredBy}:`, error.message);
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/admin/referrals/:email/prepare-reward', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = req.params.email;
  const user = getUser(email);
  const packageCode = String(req.body?.packageCode || '').trim();
  if (!user?.referredBy) return res.status(404).json({ error: 'Запрошення для цього користувача не знайдено' });
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(packageCode)) return res.status(400).json({ error: 'Вкажіть коректний packageCode бонусу' });
  saveUser(email, { referralRewardStatus: 'waiting_12_24h', referralRewardPackageCode: packageCode, referralRewardPreparedAt: new Date().toISOString() });
  const inviter = getUser(user.referredBy);
  if (inviter?.referrals) saveUser(inviter.email, { referrals: inviter.referrals.map((item) => item.email === email ? { ...item, status: 'waiting_12_24h', packageCode } : item) });
  sendToEmail(email, { title: 'Винагорода за запрошення', body: 'Винагорода буде нарахована протягом 12–24 годин.', url: '/profile.html', tag: 'referral-reward' }).catch(() => {});
  auditStore.log({ adminEmail: req.admin.email, action: 'referral_reward_prepared', target: email, details: { packageCode } });
  res.json({ ok: true, status: 'waiting_12_24h' });
});

app.post('/api/admin/referrals/:email/credit-reward', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const invitedEmail = req.params.email;
  const invited = getUser(invitedEmail);
  const packageCode = String(req.body?.packageCode || invited?.referralRewardPackageCode || '').trim();
  if (!invited?.referredBy) return res.status(404).json({ error: 'Запрошення для цього користувача не знайдено' });
  if (invited.referralRewardStatus === 'credited_to_inviter') return res.status(409).json({ error: 'Винагороду вже нараховано' });
  const inviter = getUser(invited.referredBy);
  if (!inviter?.esim?.orderNo || (!inviter.esim.esimTranNo && !inviter.esim.iccid)) return res.status(409).json({ error: 'У того, хто запросив, немає активної eSIM для поповнення' });
  try {
    const topup = await topupEsim({ esimTranNo: inviter.esim.esimTranNo, iccid: inviter.esim.iccid, packageCode });
    saveUser(inviter.email, { esim: { ...inviter.esim, ...(topup.iccid ? { iccid: topup.iccid } : {}), ...(topup.totalGb != null ? { dataLimitGb: topup.totalGb } : {}), ...(topup.usedGb != null ? { usedGb: topup.usedGb } : {}), ...(topup.remainingGb != null ? { remainingGb: topup.remainingGb } : {}), ...(topup.expiredTime ? { expiredTime: topup.expiredTime } : {}), lastTopupAt: new Date().toISOString(), lastTopupPackageCode: packageCode } });
    saveUser(invitedEmail, { referralRewardStatus: 'credited_to_inviter', referralRewardCreditedAt: new Date().toISOString() });
    if (inviter.referrals) saveUser(inviter.email, { referrals: inviter.referrals.map((item) => item.email === invitedEmail ? { ...item, status: 'credited', packageCode, creditedAt: new Date().toISOString() } : item) });
    sendToEmail(inviter.email, { title: 'Винагороду нараховано', body: 'Тобі нараховано реферальний бонус 1 ГБ.', url: '/usage.html', tag: 'referral-credited' }).catch(() => {});
    auditStore.log({ adminEmail: req.admin.email, action: 'referral_reward_credited', target: inviter.email, details: { invitedEmail, packageCode, transactionId: topup.transactionId } });
    res.json({ ok: true, beneficiary: inviter.email, topup });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/admin/users/:email/resync-esim', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = req.params.email;
  const user = getUser(email);
  if (!user?.esim?.orderNo) return res.status(404).json({ error: 'Активну eSIM не знайдено' });
  try {
    const usage = await checkUsage(user.esim.orderNo);
    const usedBytes = Math.max(0, Math.trunc(Number(usage.usedBytes) || 0));
    const providerTotalBytes = usage.totalBytes == null ? null : Math.max(0, Math.trunc(Number(usage.totalBytes) || 0));
    const fallbackTotalBytes = user.esim.dataLimitGb == null ? null : Math.round(Number(user.esim.dataLimitGb) * (1024 ** 3));
    const totalBytes = providerTotalBytes ?? fallbackTotalBytes;
    const remainingBytes = totalBytes == null ? null : Math.max(0, totalBytes - usedBytes);
    // Keep raw integer bytes as the source of truth. GB values remain only for
    // compatibility with older clients and are never rounded to two decimals.
    const usedGb = usedBytes / (1024 ** 3);
    const totalGb = totalBytes == null ? null : totalBytes / (1024 ** 3);
    const remainingGb = remainingBytes == null ? null : remainingBytes / (1024 ** 3);
    saveUser(email, { esim: { ...user.esim, usedBytes, totalBytes, remainingBytes, usedGb, dataLimitGb: totalGb, remainingGb, lastUpdateTime: usage.lastUpdateTime || new Date().toISOString() } });
    refreshGoogleWallet(email);
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_usage_resynced', target: email });
    res.json({ ok: true, usedGb, totalGb, remainingGb });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.post('/api/admin/users/:email/resend-esim-instructions', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin', 'support'), adminAuth.requirePermission('activation_code.read'), async (req, res) => {
  const email = req.params.email;
  const esim = getUser(email)?.esim;
  if (!esim?.activationCode) return res.status(404).json({ error: 'Код активації eSIM не знайдено' });
  try {
    await sendEmail({ to: email, subject: 'Інструкція встановлення eSIM — Signal', html: emailTemplates.esimInstructions({activationCode:esim.activationCode}) });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_instructions_resent', target: email });
    res.json({ ok: true });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Blocked users cannot sign in. Unblocking restores the exact status they had.
app.patch('/api/admin/users/:email/block', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), (req, res) => {
  const email = req.params.email;
  const { blocked } = req.body || {};
  const authUser = authStore.readAll().users?.[email];
  const user = getUser(email);
  if (!authUser && !user) return res.status(404).json({ error: 'Користувача не знайдено' });

  if (blocked) {
    saveUser(email, { email, status: 'blocked', statusBeforeBlock: user?.status || null, blockedAt: new Date().toISOString() });
    auditStore.log({ adminEmail: req.admin.email, action: 'user_blocked', target: email });
  } else {
    saveUser(email, { email, status: user?.statusBeforeBlock || 'active', statusBeforeBlock: null, blockedAt: null });
    auditStore.log({ adminEmail: req.admin.email, action: 'user_unblocked', target: email });
  }
  res.json({ ok: true, user: getUser(email) });
});

// Recover a paid order whose first eSIM allocation failed.  This endpoint is
// restricted to the Super Admin: it never charges Stripe and only accepts the
// explicit failed state, so it cannot be used to create a second eSIM for an
// already active subscription.
app.post('/api/admin/users/:email/retry-esim', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  const email = req.params.email;
  const user = getUser(email);

  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (user.status !== 'payment_ok_esim_failed') {
    return res.status(409).json({ error: 'Повторна видача доступна лише для оплаченої eSIM зі статусом помилки' });
  }
  if (!user.plan) return res.status(400).json({ error: 'У користувача не знайдено тариф' });
  if (esimRetriesInProgress.has(email)) {
    return res.status(409).json({ error: 'Видача eSIM уже виконується. Зачекайте.' });
  }

  esimRetriesInProgress.add(email);
  saveUser(email, { status: 'esim_retrying' });
  try {
    const esim = await provisionEsim({ email, plan: user.plan });
    saveUser(email, { status: 'active', esim });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_retry_succeeded', target: email, details: { orderNo: esim.orderNo } });
    res.json({ ok: true, esim });
  } catch (err) {
    console.error(`[eSIM retry] ${email}:`, err.message);
    saveUser(email, { status: 'payment_ok_esim_failed' });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_retry_failed', target: email, details: { message: err.message } });
    res.status(502).json({ error: 'eSIM не вдалося видати. Деталі є в Render Logs.' });
  } finally {
    esimRetriesInProgress.delete(email);
  }
});

app.post('/api/admin/users/:email/purchases/:purchaseId/retry-provision', adminAuth.requireAdmin, adminAuth.requireRole('super_admin','admin'), adminAuth.requirePermission('esim.retry'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const purchaseId = String(req.params.purchaseId || '');
  const user = getUser(email);
  const purchase = (user?.purchases || []).find(item => item.id === purchaseId);
  if (!purchase) return res.status(404).json({ error:'Покупку не знайдено' });
  if (purchase.paymentStatus !== 'paid') return res.status(409).json({ error:'Stripe не підтвердив оплату цієї покупки' });
  if (purchase.fulfillmentStatus !== 'failed') return res.status(409).json({ error:'Повторити можна лише невдалу видачу' });
  if (['immediate','after_expiry'].includes(purchase.changeMode)) {
    const result=await executePaidPlanChange({email,purchaseId,packageCode:purchase.packageCode,packageName:purchase.packageName,dataLimitGb:purchase.dataLimitGb,durationDays:purchase.durationDays,location:purchase.location,previousPlan:purchase.previousPlan,previousSubscriptionId:purchase.previousSubscriptionId,requestId:req.requestId});
    auditStore.log({adminEmail:req.admin.email,action:'paid_plan_change_retried',target:email,details:{purchaseId,ok:Boolean(result.ok)}});
    if(!result.ok)return res.status(502).json({error:result.error?.message||'Зміну тарифу не вдалося завершити'});
    return res.json({ok:true,purchaseId,esim:result.esim,cancellationError:result.cancellationError||null});
  }
  if (purchase.kind === 'esim_topup' || purchase.changeMode === 'topup_existing') {
    if (!user.esim?.iccid) return res.status(409).json({ error:'Активну eSIM для поповнення не знайдено' });
    const retryKey = `${email}:${purchaseId}`;
    if (esimRetriesInProgress.has(retryKey)) return res.status(409).json({ error:'Це поповнення вже виконується' });
    esimRetriesInProgress.add(retryKey);
    upsertPurchase(email,purchaseId,{fulfillmentStatus:'provisioning',retryStartedAt:new Date().toISOString(),fulfillmentError:null});
    try {
      const topup=await topupEsim({esimTranNo:user.esim.esimTranNo,iccid:user.esim.iccid,packageCode:purchase.packageCode,transactionId:`topup-retry-${String(purchaseId).slice(-34)}`});
      const esim={...user.esim,...(topup.iccid?{iccid:topup.iccid}:{}),...(topup.totalGb!=null?{dataLimitGb:topup.totalGb}:{}),...(topup.usedGb!=null?{usedGb:topup.usedGb}:{}),...(topup.remainingGb!=null?{remainingGb:topup.remainingGb}:{}),...(topup.expiredTime?{expiredTime:topup.expiredTime}:{}),lastTopupAt:new Date().toISOString(),lastTopupPackageCode:purchase.packageCode,lastPushAlertThreshold:null};
      saveUser(email,{status:'active',esim});
      refreshGoogleWallet(email);
      upsertPurchase(email,purchaseId,{fulfillmentStatus:'provisioned',fulfilledAt:new Date().toISOString(),fulfillmentError:null,providerTransactionId:topup.transactionId||null,iccid:esim.iccid||null});
      auditStore.log({adminEmail:req.admin.email,action:'paid_esim_topup_retried',target:email,details:{purchaseId,packageCode:purchase.packageCode,iccidEnding:String(esim.iccid||'').slice(-4)}});
      return res.json({ok:true,purchaseId,topup:true,esim:{iccidEnding:String(esim.iccid||'').slice(-4),remainingGb:esim.remainingGb??null,expiredTime:esim.expiredTime||null}});
    } catch (error) {
      upsertPurchase(email,purchaseId,{fulfillmentStatus:'failed',failedAt:new Date().toISOString(),fulfillmentError:error.message,fulfillmentErrorCode:error.code||'ESIM_TOPUP_FAILED'});
      auditStore.log({adminEmail:req.admin.email,action:'paid_esim_topup_retry_failed',target:email,details:{purchaseId,packageCode:purchase.packageCode,error:error.message}});
      return res.status(502).json({error:`eSIM Access: ${error.message}`});
    } finally {
      esimRetriesInProgress.delete(retryKey);
    }
  }
  if (user.status === 'canceled') return res.status(409).json({ error:'Підписку/акаунт скасовано. Спочатку перевірте оплату та статус у Stripe.' });
  if (user.esim?.orderNo && user.status === 'active') return res.status(409).json({ error:'В акаунті вже є активна eSIM. Автоматична заміна могла б стерти її дані.' });
  const retryKey = `${email}:${purchaseId}`;
  if (esimRetriesInProgress.has(retryKey)) return res.status(409).json({ error:'Ця видача вже виконується' });
  esimRetriesInProgress.add(retryKey);
  upsertPurchase(email, purchaseId, { fulfillmentStatus:'provisioning', retryStartedAt:new Date().toISOString(), fulfillmentError:null });
  try {
    const esim = await provisionEsim({ email, plan:purchase.plan, packageCode:purchase.packageCode || '', dataLimitGb:purchase.dataLimitGb });
    esim.dashboardQrExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    saveUser(email, { status:'active', plan:purchase.plan, esim, lastEsimProvisionError:null });
    upsertPurchase(email, purchaseId, { fulfillmentStatus:'provisioned', fulfilledAt:new Date().toISOString(), fulfillmentError:null, esimOrderNo:esim.orderNo || null, iccid:esim.iccid || null, esimTranNo:esim.esimTranNo || null });
    auditStore.log({ adminEmail:req.admin.email, action:'paid_purchase_provision_retried', target:email, details:{ purchaseId, packageCode:purchase.packageCode, orderNo:esim.orderNo } });
    res.json({ ok:true, purchaseId, esim });
  } catch (error) {
    saveUser(email, { status:'payment_ok_esim_failed', lastEsimProvisionError:error.message });
    upsertPurchase(email, purchaseId, { fulfillmentStatus:'failed', failedAt:new Date().toISOString(), fulfillmentError:error.message, fulfillmentErrorCode:error.code || null });
    auditStore.log({ adminEmail:req.admin.email, action:'paid_purchase_provision_retry_failed', target:email, details:{ purchaseId, packageCode:purchase.packageCode, error:error.message } });
    res.status(502).json({ error:`eSIM Access: ${error.message}` });
  } finally {
    esimRetriesInProgress.delete(retryKey);
  }
});

// Reconnect a profile that already exists at eSIM Access after local account
// data was lost. This is read-only at the provider: it does not order or bill.
app.post('/api/admin/users/:email/recover-esim', adminAuth.requireAdmin, adminAuth.requireRole('super_admin'), async (req, res) => {
  const email = req.params.email;
  const { iccid, plan } = req.body || {};
  const user = getUser(email);

  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });

  try {
    const esim = await recoverEsim({ iccid, plan });
    const previousOrderNo = user.esim?.orderNo || null;
    // A recovery may also deliberately replace stale local eSIM data. It still
    // only reads the provider profile and never creates a Stripe payment/order.
    saveUser(email, { status: 'active', plan, esim });
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_recovered', target: email, details: { orderNo: esim.orderNo, previousOrderNo } });
    res.json({ ok: true, esim });
  } catch (err) {
    console.error(`[eSIM recovery] ${email}:`, err.message);
    auditStore.log({ adminEmail: req.admin.email, action: 'esim_recovery_failed', target: email, details: { message: err.message } });
    res.status(400).json({ error: err.message });
  }
});

// =========================================================
// ПІДПИСКА / eSIM
// =========================================================

// ---------- 1. Створити сесію оплати підписки ----------
// Фронтенд викликає це, коли людина натискає "Оформити підписку"
app.post('/api/create-subscription', requireUserSession,requireFeature('monthlyPlans','Місячні тарифи тимчасово недоступні'),requireFeature('cardPayments','Оплати тимчасово призупинено'),requireProviderCapacity,rateLimit('checkout',60*60*1000,10,req=>req.userEmail), async (req, res) => {
  try {
    if(!paymentMethodEnabled('stripeCard'))return res.status(503).json({error:'Оплата карткою Stripe тимчасово недоступна',code:'PAYMENT_METHOD_DISABLED'});
    const { plan } = req.body;
    const email=req.userEmail;
    const currentUser=getUser(email);
    if(currentUser?.pendingPlanChange)return res.status(409).json({error:'Уже є оплачена запланована зміна тарифу. Дочекайся її виконання або звернися в підтримку.',code:'PLAN_CHANGE_ALREADY_PENDING'});
    if(currentUser?.stripeSubscriptionId&&['active','renewal_failed','payment_confirmed'].includes(currentUser.status))return res.status(409).json({error:'У тебе вже є активна підписка. Для безпечної заміни відкрий «Тарифи» → «Більше пакетів для подорожей» і вибери спосіб зміни.',code:'ACTIVE_SUBSCRIPTION_EXISTS'});
    if (!plan) return res.status(400).json({ error: 'Потрібен plan' });
    if (operationsStore.store().blacklist.emails.includes(email.toLowerCase())) return res.status(403).json({ error: 'Цей email недоступний для оплати' });

    const recovered=await recoverStripeProfile(email).catch(()=>({customerId:currentUser?.stripeCustomerId||null}));
    const session = await createCheckoutSession({ email, plan, customerId:recovered.customerId||currentUser?.stripeCustomerId||null });
    // Do not change the current subscription before Stripe confirms payment.
    // If the customer closes Checkout, their existing plan and eSIM stay intact.
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося створити оплату' });
  }
});

// ---------- 2. Вебхук від Stripe ----------
// Stripe сам викликає цю адресу, коли оплата пройшла успішно.
// Саме тут ми довіряємо, що гроші реально прийшли, і видаємо eSIM.
async function processSubscriptionRenewal(invoice) {
  const invoiceId = String(invoice.id || '');
  if (!invoiceId) return { ok: false, error: 'Stripe invoice ID is missing' };
  if(!featureEnabled('autoRenew'))return {ok:false,error:'Автоматичні поновлення вимкнені Super Admin'};
  if (renewalInvoicesInProgress.has(invoiceId)) return { ok: false, error: 'Поновлення вже виконується' };
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const user = getUserByStripeCustomerId(customerId);
  if (!user?.email || !user.esim?.iccid || !user.plan) {
    console.warn(`[renewal] ${invoiceId}: user/eSIM/plan not found for customer ${customerId || 'n/a'}`);
    return { ok: false, error: 'Користувача, eSIM або тариф не знайдено' };
  }
  if (user.lastRenewalInvoiceId === invoiceId || user.renewalInvoices?.[invoiceId]?.status === 'succeeded') return { ok: true, duplicate: true };

  renewalInvoicesInProgress.add(invoiceId);
  const trackedJob=operationsStore.addJob({type:'subscription_renewal',status:'running',purchaseId:invoiceId,email:user.email,maxAttempts:3});
  saveUser(user.email, { renewalInvoices: { ...(user.renewalInvoices || {}), [invoiceId]: { status: 'processing', startedAt: new Date().toISOString() } } });
  try {
    const selected = await findRenewalTopup({ iccid: user.esim.iccid, plan: user.plan });
    const topup = await topupEsim({
      esimTranNo: user.esim.esimTranNo,
      iccid: user.esim.iccid,
      packageCode: selected.packageCode,
      transactionId: `stripe-${invoiceId}`,
    });
    const current = getUser(user.email) || user;
    const now = new Date().toISOString();
    saveUser(user.email, {
      status: 'active',
      lastRenewalInvoiceId: invoiceId,
      lastRenewalAt: now,
      renewalError: null,
      renewalInvoices: { ...(current.renewalInvoices || {}), [invoiceId]: { status: 'succeeded', packageCode: selected.packageCode, completedAt: now } },
      esim: {
        ...current.esim,
        ...(topup.totalGb != null ? { dataLimitGb: topup.totalGb } : {}),
        ...(topup.usedGb != null ? { usedGb: topup.usedGb } : {}),
        ...(topup.remainingGb != null ? { remainingGb: topup.remainingGb } : {}),
        ...(topup.expiredTime ? { expiredTime: topup.expiredTime } : {}),
        lastTopupAt: now,
        lastTopupPackageCode: selected.packageCode,
        lastPushAlertThreshold: null,
      },
    });
    sendToEmail(user.email, { title: 'Тариф успішно поновлено', body: `Оплату отримано. Пакет ${user.plan} автоматично поновлено.`, url: '/dashboard.html', tag: `renewal-${invoiceId.slice(-12)}` }).catch(error => console.error(`[renewal push] ${user.email}:`, error.message));
    console.log(`[renewal] ${user.email}: ${invoiceId} -> ${selected.packageCode}`);
    operationsStore.updateJob(trackedJob.id,{status:'succeeded',completedAt:new Date().toISOString()});return { ok: true, packageCode: selected.packageCode };
  } catch (error) {
    const current = getUser(user.email) || user;
    const failedAt = new Date().toISOString();
    saveUser(user.email, {
      status: 'renewal_failed',
      renewalError: error.message,
      renewalFailedAt: failedAt,
      renewalInvoices: { ...(current.renewalInvoices || {}), [invoiceId]: { status: 'failed', message: error.message, failedAt } },
    });
    sendToEmail(user.email, { title: 'Потрібна увага до тарифу', body: 'Оплату отримано, але пакет eSIM ще не поновлено. Підтримка вже бачить помилку.', url: '/support.html', tag: `renewal-failed-${invoiceId.slice(-8)}` }).catch(() => {});
    console.error(`[renewal] ${user.email}: ${invoiceId} failed:`, error.message);
    const nonRetryable=/balance is insufficient|doesn.t exist|invalid package/i.test(String(error.message||''));operationsStore.updateJob(trackedJob.id,{status:'failed',error:error.message,retryable:!nonRetryable,completedAt:new Date().toISOString()});return { ok: false, error: error.message };
  } finally {
    renewalInvoicesInProgress.delete(invoiceId);
  }
}

app.post('/api/admin/users/:email/retry-renewal', adminAuth.requireAdmin, adminAuth.requireRole('super_admin', 'admin'), async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  const failed = Object.entries(user.renewalInvoices || {})
    .filter(([, item]) => item?.status === 'failed')
    .sort((a, b) => String(b[1].failedAt || '').localeCompare(String(a[1].failedAt || '')))[0];
  if (!failed) return res.status(409).json({ error: 'Немає невдалого оплаченого поновлення для повтору.' });
  const result = await processSubscriptionRenewal({ id: failed[0], customer: user.stripeCustomerId, billing_reason: 'subscription_cycle' });
  auditStore.log({ adminEmail: req.admin.email, action: 'subscription_renewal_retried', target: email, details: { invoiceId: failed[0], ok: Boolean(result?.ok) } });
  if (!result?.ok) return res.status(502).json({ error: result?.error || 'Пакет eSIM не вдалося поновити.' });
  res.json({ ok: true, invoiceId: failed[0], packageCode: result.packageCode });
});

app.post('/api/webhook', async (req, res) => {
  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    recordDiagnostic(req,{source:'stripe',type:'payment_flow',action:'webhook_verification',outcome:'failed',severity:'error',message:'Stripe webhook signature verification failed',errorCode:'STRIPE_WEBHOOK_SIGNATURE_INVALID'});
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const claimed=await storage.claimExternalEvent('stripe',event.id,event.type);
  if(!claimed)return res.json({received:true,duplicate:true});

  try {

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if(session.payment_status!=='paid'){
      await storage.finishExternalEvent('stripe',event.id,'ignored',`payment_status:${session.payment_status||'unknown'}`);
      return res.json({received:true,fulfilled:false,paymentStatus:session.payment_status||null});
    }
    if(session.metadata?.purchaseKind==='mobile_topup'){
      const email=String(session.metadata.email||'').trim().toLowerCase();
      const orderId=String(session.metadata.mobileTopupOrderId||'');
      const stored=getMobileTopupOrder(email,orderId);
      if(!stored||stored.stripeSessionId!==session.id){
        await storage.finishExternalEvent('stripe',event.id,'failed','mobile_topup_order_mismatch');
        recordDiagnostic(req,{email,source:'stripe',type:'mobile_topup',action:'paid_order_validation',outcome:'failed',severity:'critical',message:'Paid mobile top-up did not match a protected local order',errorCode:'TOPUP_ORDER_MISMATCH',purchaseId:session.id,context:{orderId}});
        return res.status(409).json({received:true,fulfilled:false,error:'TOPUP_ORDER_MISMATCH'});
      }
      const paidAt=new Date((session.created||Math.floor(Date.now()/1000))*1000).toISOString();
      let order=upsertMobileTopupOrder(email,orderId,{status:stored.status==='delivered'?'delivered':'paid',paymentStatus:'paid',paidAt,stripeCustomerId:typeof session.customer==='string'?session.customer:session.customer?.id||null,stripePaymentIntentId:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id||null});
      const defaults=mobileTopupPurchaseDefaults(order,session);
      saveUser(email,{stripeCustomerId:defaults.stripeCustomerId||getUser(email)?.stripeCustomerId||null});
      upsertPurchase(email,session.id,{fulfillmentStatus:order.status==='delivered'?'delivered':'processing',fulfillmentError:null},defaults);
      recordDiagnostic(req,{email,source:'stripe',type:'mobile_topup',action:'payment_confirmed',outcome:'success',severity:'info',message:'Stripe confirmed mobile data top-up payment',purchaseId:session.id,context:{orderId,productId:order.productId,operatorId:order.operatorId,amountCents:session.amount_total??null,currency:session.currency||null,phone:maskPhone(order.phone)}});
      try{
        const result=await fulfillMobileTopupOrder({email,orderId,purchaseId:session.id});
        recordDiagnostic(req,{email,source:'dtone',type:'mobile_topup',action:'delivery',outcome:result.state==='delivered'?'success':'pending',severity:'info',message:result.state==='delivered'?'Mobile data bundle delivered':'Mobile data bundle is processing',purchaseId:session.id,context:{orderId,providerTransactionId:result.transaction?.id||result.order?.providerTransactionId||null}});
      }catch(error){
        recordDiagnostic(req,{email,source:'dtone',type:'mobile_topup',action:'delivery',outcome:'failed',severity:'error',message:error.message,errorCode:error.code||'TOPUP_DELIVERY_FAILED',purchaseId:session.id,context:{orderId}});
      }
      await deliverPurchaseReceipt(email,session.id,defaults);
      await storage.finishExternalEvent('stripe',event.id,'completed');
      return res.json({received:true,mobileTopup:true});
    }
    const email = session.metadata.email;
    const plan = session.metadata.plan;
    const packageCode = session.metadata.packageCode || '';
    const dataLimitGb = session.metadata.dataLimitGb === '' || session.metadata.dataLimitGb == null
      ? ({ basic:10, standard:20, unlimited:null }[plan] ?? null)
      : Number(session.metadata.dataLimitGb);
    const durationDays = session.metadata.durationDays ? Number(session.metadata.durationDays) : (plan === 'custom' ? null : 30);
    const changeMode = String(session.metadata.changeMode || '');
    const previousPlan = String(session.metadata.previousPlan || '');
    const previousSubscriptionId = String(session.metadata.previousSubscriptionId || '');
    const scheduledFor = String(session.metadata.scheduledFor || '');
    const recipientMode = String(session.metadata.recipientMode || '');
    const recipientName = String(session.metadata.recipientName || '').slice(0,60);
    const familyPurchase = plan === 'custom' && recipientMode === 'family';
    const rewardId=String(session.metadata.rewardId||''),discountCents=Math.max(0,Math.trunc(Number(session.metadata.discountCents)||0)),originalAmountCents=Math.max(0,Math.trunc(Number(session.metadata.originalAmountCents)||0));
    if(rewardId){const rewardUser=getUser(email)||{},loyalty=engagement.loyaltyFor(rewardUser),rewardIndex=loyalty.rewards.findIndex(item=>item.id===rewardId&&item.stripeSessionId===session.id);if(rewardIndex>=0){loyalty.rewards[rewardIndex]={...loyalty.rewards[rewardIndex],status:'used',usedAt:new Date().toISOString(),purchaseId:session.id};saveUser(email,{loyalty});}}
    const purchaseDefaults = {
      kind: familyPurchase ? 'family_esim' : changeMode === 'topup_existing' ? 'esim_topup' : plan === 'custom' ? 'custom_package' : 'subscription',
      plan,
      packageCode: packageCode || null,
      packageName: session.metadata.packageName || plan,
      dataLimitGb,
      durationDays,
      location: session.metadata.location || null,
      amountCents: session.amount_total ?? null,
      originalAmountCents:originalAmountCents||session.amount_total||null,
      discountCents,
      rewardId:rewardId||null,
      currency: session.currency || null,
      stripeSessionId: session.id,
      stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
      stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      paidAt: new Date((session.created || Math.floor(Date.now()/1000)) * 1000).toISOString(),
      paymentStatus: session.payment_status || 'paid',
      changeMode:changeMode||null,
      previousPlan:previousPlan||null,
      previousSubscriptionId:previousSubscriptionId||null,
      scheduledFor:scheduledFor||null,
      recipientName:familyPurchase?recipientName:null,
    };
    const existingPurchase = (getUser(email)?.purchases || []).find(item => item.id === session.id);
    recordDiagnostic(req,{email,source:'stripe',type:'payment_flow',action:'checkout_completed',outcome:'success',severity:'info',message:'Stripe confirmed checkout payment',purchaseId:session.id,context:{plan,packageCode:packageCode||null,amountCents:session.amount_total??null,currency:session.currency||null,paymentStatus:session.payment_status||null,mode:session.mode||null}});

    if(familyPurchase){
      if(existingPurchase?.fulfillmentStatus!=='provisioned')upsertPurchase(email,session.id,{fulfillmentStatus:'provisioning',fulfillmentError:null},purchaseDefaults);
      saveUser(email,{stripeCustomerId:typeof session.customer==='string'?session.customer:session.customer?.id||getUser(email)?.stripeCustomerId||null});
      if(existingPurchase?.fulfillmentStatus!=='provisioned')try{
        const esim=await provisionEsim({email,plan,packageCode,dataLimitGb});
        const owner=getUser(email)||{},shared=Array.isArray(owner.sharedEsims)?[...owner.sharedEsims]:[];
        const sharedId=`family_${session.id.replace(/[^A-Za-z0-9_-]/g,'').slice(-48)}`;
        const record={id:sharedId,recipientName,packageName:session.metadata.packageName||'eSIM для подорожі',location:session.metadata.location||null,dataLimitGb,durationDays,purchaseId:session.id,createdAt:new Date().toISOString(),esim};
        const existingIndex=shared.findIndex(item=>item.purchaseId===session.id);
        if(existingIndex>=0)shared[existingIndex]=record;else shared.unshift(record);
        saveUser(email,{sharedEsims:shared.slice(0,30)});
        upsertPurchase(email,session.id,{fulfillmentStatus:'provisioned',fulfilledAt:new Date().toISOString(),fulfillmentError:null,esimOrderNo:esim.orderNo||null,iccid:esim.iccid||null,esimTranNo:esim.esimTranNo||null},purchaseDefaults);
        recordDiagnostic(req,{email,source:'esim_access',type:'esim_flow',action:'family_esim_provisioned',outcome:'success',severity:'info',message:'Family eSIM provisioned without replacing account owner profile',purchaseId:session.id,context:{packageCode,provider:esim.provider||'esim_access'}});
      }catch(err){
        upsertPurchase(email,session.id,{fulfillmentStatus:'failed',failedAt:new Date().toISOString(),fulfillmentError:err.message,fulfillmentErrorCode:err.code||null},purchaseDefaults);
        recordDiagnostic(req,{email,source:'esim_access',type:'esim_flow',action:'family_esim_failed',outcome:'failed',severity:'error',message:'Paid family eSIM provisioning failed',errorCode:err.code||'ESIM_PROVISION_FAILED',purchaseId:session.id});
      }
      await deliverPurchaseReceipt(email,session.id,purchaseDefaults);
      await storage.finishExternalEvent('stripe',event.id,'completed');
      return res.json({received:true,familyEsim:true});
    }

    if(changeMode==='topup_existing'){
      const current=getUser(email);
      if(!current?.esim?.iccid){upsertPurchase(email,session.id,{fulfillmentStatus:'failed',failedAt:new Date().toISOString(),fulfillmentError:'Активну eSIM не знайдено',fulfillmentErrorCode:'ESIM_NOT_ISSUED'},purchaseDefaults);await storage.finishExternalEvent('stripe',event.id,'failed','esim_not_issued');return res.json({received:true,topup:'failed'});}
      if(existingPurchase?.fulfillmentStatus!=='provisioned'){
        upsertPurchase(email,session.id,{fulfillmentStatus:'provisioning',fulfillmentError:null},purchaseDefaults);
        try{
          const topup=await topupEsim({esimTranNo:current.esim.esimTranNo,iccid:current.esim.iccid,packageCode,transactionId:`topup-${String(session.id).slice(-40)}`});
          const esim={...current.esim,...(topup.iccid?{iccid:topup.iccid}:{}),...(topup.totalGb!=null?{dataLimitGb:topup.totalGb}:{}),...(topup.usedGb!=null?{usedGb:topup.usedGb}:{}),...(topup.remainingGb!=null?{remainingGb:topup.remainingGb}:{}),...(topup.expiredTime?{expiredTime:topup.expiredTime}:{}),lastTopupAt:new Date().toISOString(),lastTopupPackageCode:packageCode,lastPushAlertThreshold:null};
          saveUser(email,{status:'active',esim,stripeCustomerId:typeof session.customer==='string'?session.customer:session.customer?.id||current.stripeCustomerId||null});
          refreshGoogleWallet(email);
          upsertPurchase(email,session.id,{fulfillmentStatus:'provisioned',fulfilledAt:new Date().toISOString(),providerTransactionId:topup.transactionId||null,iccid:esim.iccid||null},purchaseDefaults);
          recordDiagnostic(req,{email,source:'esim_access',type:'topup_flow',action:'topup_completed',outcome:'success',severity:'info',message:'Existing eSIM topped up after Stripe payment',purchaseId:session.id,context:{packageCode,iccidEnding:String(esim.iccid||'').slice(-4)}});
          sendToEmail(email,{title:'Інтернет додано',body:`Пакет ${session.metadata.packageName||'eSIM'} додано до вже встановленої eSIM.`,url:'/usage.html',tag:`topup-${String(session.id).slice(-10)}`}).catch(()=>{});
        }catch(error){upsertPurchase(email,session.id,{fulfillmentStatus:'failed',failedAt:new Date().toISOString(),fulfillmentError:error.message,fulfillmentErrorCode:error.code||'ESIM_TOPUP_FAILED'},purchaseDefaults);recordDiagnostic(req,{email,source:'esim_access',type:'topup_flow',action:'topup_delivery',outcome:'failed',severity:'critical',message:error.message,errorCode:error.code||'ESIM_TOPUP_FAILED',purchaseId:session.id});}
      }
      await deliverPurchaseReceipt(email,session.id,purchaseDefaults);await storage.finishExternalEvent('stripe',event.id,'completed');return res.json({received:true,topup:true});
    }

    if(changeMode==='after_expiry'){
      let cancellationScheduled=false,cancellationError=null;
      if(previousSubscriptionId){try{await cancelSubscriptionAtPeriodEnd(previousSubscriptionId);cancellationScheduled=true;}catch(error){cancellationError=error.message;}}
      const pending={purchaseId:session.id,packageCode,packageName:session.metadata.packageName||plan,dataLimitGb,durationDays,location:session.metadata.location||null,previousPlan:previousPlan||getUser(email)?.plan||null,previousSubscriptionId:previousSubscriptionId||null,scheduledFor,paidAt:new Date().toISOString(),requestId:req.requestId,cancellationScheduled,cancellationError};
      saveUser(email,{pendingPlanChange:pending,stripeCustomerId:session.customer,lastPlanChangeError:cancellationError});
      upsertPurchase(email,session.id,{fulfillmentStatus:'scheduled',planChangeStatus:cancellationError?'scheduled_with_warning':'scheduled',fulfillmentError:cancellationError},purchaseDefaults);
      recordDiagnostic(req,{email,source:'stripe',type:'plan_change',action:'plan_change_scheduled',outcome:cancellationError?'failed':'pending',severity:cancellationError?'error':'info',message:cancellationError?'Plan change paid, but old subscription could not be scheduled for cancellation':'Paid plan change scheduled for current plan end',errorCode:cancellationError?'SUBSCRIPTION_END_SCHEDULE_FAILED':null,purchaseId:session.id,context:{scheduledFor,previousPlan,packageCode,cancellationScheduled}});
      await deliverPurchaseReceipt(email,session.id,purchaseDefaults);
      await storage.finishExternalEvent('stripe',event.id,'completed');
      return res.json({received:true,planChange:'scheduled'});
    }

    if(changeMode==='immediate'){
      upsertPurchase(email,session.id,{fulfillmentStatus:'provisioning',planChangeStatus:'provisioning',fulfillmentError:null},purchaseDefaults);
      await executePaidPlanChange({email,purchaseId:session.id,packageCode,packageName:session.metadata.packageName||plan,dataLimitGb,durationDays,location:session.metadata.location||null,previousPlan,previousSubscriptionId,requestId:req.requestId});
      await deliverPurchaseReceipt(email,session.id,purchaseDefaults);
      await storage.finishExternalEvent('stripe',event.id,'completed');
      return res.json({received:true,planChange:'immediate'});
    }

    // Save Stripe ownership immediately after confirmed payment. Provisioning
    // can fail later, but the admin must still be able to find and refund it.
    saveUser(email, {
      ...(existingPurchase?.fulfillmentStatus === 'provisioned' ? {} : { status:'payment_confirmed' }),
      plan,
      stripeCustomerId: session.customer,
      ...(session.subscription ? { stripeSubscriptionId: session.subscription } : {}),
    });
    if (existingPurchase?.fulfillmentStatus !== 'provisioned') upsertPurchase(email, session.id, { fulfillmentStatus:'provisioning', fulfillmentError:null }, purchaseDefaults);

    if (existingPurchase?.fulfillmentStatus !== 'provisioned') try {
      recordDiagnostic(req,{email,source:'esim_access',type:'esim_flow',action:'provision_started',outcome:'started',severity:'info',message:'eSIM provisioning started after confirmed payment',purchaseId:session.id,context:{plan,packageCode:packageCode||null}});
      // Оплата підтверджена Stripe -> тепер видаємо реальну eSIM
      const esim = await provisionEsim({ email, plan, packageCode, dataLimitGb });
      esim.dashboardQrExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      saveUser(email, {
        status: 'active',
        plan,
        stripeCustomerId: session.customer,
        ...(session.subscription ? { stripeSubscriptionId: session.subscription } : {}),
        esim,
      });
      upsertPurchase(email, session.id, { fulfillmentStatus:'provisioned', fulfilledAt:new Date().toISOString(), fulfillmentError:null, esimOrderNo:esim.orderNo || null, iccid:esim.iccid || null, esimTranNo:esim.esimTranNo || null }, purchaseDefaults);
      recordDiagnostic(req,{email,source:'esim_access',type:'esim_flow',action:'provision_completed',outcome:'success',severity:'info',message:'eSIM provisioned successfully',purchaseId:session.id,context:{plan,packageCode:packageCode||null,provider:esim.provider||'esim_access',hasQr:Boolean(esim.qrCodeUrl||esim.activationCode),orderReference:esim.orderNo?String(esim.orderNo).slice(-8):null}});

      console.log(`✅ Підписку і eSIM активовано для ${email}`);
    } catch (err) {
      console.error('Помилка видачі eSIM після оплати:', err);
      saveUser(email, { status: 'payment_ok_esim_failed', lastEsimProvisionError:err.message });
      upsertPurchase(email, session.id, { fulfillmentStatus:'failed', failedAt:new Date().toISOString(), fulfillmentError:err.message, fulfillmentErrorCode:err.code || null }, purchaseDefaults);
      recordDiagnostic(req,{email,source:'esim_access',type:'esim_flow',action:'provision_failed',outcome:'failed',severity:'error',message:'Paid eSIM provisioning failed',errorCode:err.code||'ESIM_PROVISION_FAILED',purchaseId:session.id,context:{plan,packageCode:packageCode||null,providerStatus:err.status||null,providerMessage:String(err.message||'').slice(0,240)}});
    }
    await deliverPurchaseReceipt(email, session.id, purchaseDefaults);
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    let user = getUserByStripeCustomerId(sub.customer);
    if (!user) {
      try {
        const customerEmail = await getCustomerEmail(typeof sub.customer === 'string' ? sub.customer : sub.customer?.id);
        if (customerEmail) user = getUser(customerEmail);
      } catch (error) { console.error('[subscription deleted lookup]', error.message); }
    }
    if (user) {
      if(user.pendingPlanChange){recordDiagnostic(req,{email:user.email,source:'stripe',type:'plan_change',action:'previous_subscription_period_ended',outcome:'pending',severity:'info',message:'Previous subscription ended; scheduled plan change will now be processed',purchaseId:user.pendingPlanChange.purchaseId,context:{subscriptionId:sub.id}});processDuePlanChanges().catch(error=>console.error('[plan change webhook]',error.message));await storage.finishExternalEvent('stripe',event.id,'completed');return res.json({received:true,planChangeQueued:true});}
      if(user.plan==='custom'&&user.esim?.orderNo&&user.lastPlanChangeAt){recordDiagnostic(req,{email:user.email,source:'stripe',type:'plan_change',action:'previous_subscription_deleted_webhook',outcome:'success',severity:'info',message:'Previous subscription deletion confirmed; new one-time eSIM remains active',context:{subscriptionId:sub.id}});await storage.finishExternalEvent('stripe',event.id,'completed');return res.json({received:true,previousSubscriptionClosed:true});}
      const state = await getSubscriptionStateByEmail(user.email, user.stripeCustomerId || null).catch(() => null);
      if (!state || !state.active.length) saveUser(user.email, { status:'canceled', canceledAt:new Date().toISOString(), canceledReason:'stripe_webhook' });
    }
  }

  if (event.type === 'invoice.paid') {
    const invoice = event.data.object;
    // The first invoice is fulfilled by checkout.session.completed. Only a
    // real subscription cycle should top up the existing profile.
    if (invoice.billing_reason === 'subscription_cycle') {
      const renewalResult = await processSubscriptionRenewal(invoice);
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      const user = getUserByStripeCustomerId(customerId);
      if (user?.email) {
        const renewalPurchase = {
          kind:'subscription_renewal', plan:user.plan, packageName:`Поновлення тарифу ${user.plan}`,
          amountCents:invoice.amount_paid ?? null, currency:invoice.currency || null,
          stripeCustomerId:customerId || null, stripeInvoiceId:invoice.id,
          paidAt:new Date((invoice.created || Math.floor(Date.now()/1000))*1000).toISOString(),
          paymentStatus:invoice.status || 'paid', fulfillmentStatus:renewalResult?.ok ? 'provisioned' : 'failed',
          fulfillmentError:renewalResult?.ok ? null : renewalResult?.error || null,
        };
        upsertPurchase(user.email, invoice.id, {}, renewalPurchase);
        await deliverPurchaseReceipt(user.email, invoice.id, renewalPurchase, invoice.hosted_invoice_url || invoice.invoice_pdf || null);
      }
    }
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const user = getUserByStripeCustomerId(customerId);
    if (user) {
      saveUser(user.email, { status: 'renewal_payment_failed', renewalPaymentFailedAt: new Date().toISOString(), renewalPaymentInvoiceId: invoice.id || null });
      sendToEmail(user.email, { title: 'Не вдалося поновити тариф', body: 'Stripe не зміг провести щомісячну оплату. Перевір спосіб оплати.', url: '/payments.html', tag: 'renewal-payment-failed' }).catch(() => {});
    }
  }

  await storage.finishExternalEvent('stripe',event.id,'completed');
  res.json({ received: true });
  } catch(error) {
    await storage.finishExternalEvent('stripe',event.id,'failed',error.message);
    console.error(`[stripe webhook ${event.id}]`,error);
    res.status(500).json({received:false,error:'Webhook processing failed'});
  }
});

app.post('/api/account/email-change/request',requireUserSession,rateLimit('email_change_request',60*60*1000,5,req=>req.userEmail),async(req,res)=>{
  try{res.json(await authService.requestEmailChange(req.userEmail,req.body?.newEmail,req.body?.currentPassword));}catch(error){res.status(400).json({error:error.message,code:error.code});}
});
app.post('/api/account/email-change/confirm',requireUserSession,rateLimit('email_change_confirm',15*60*1000,10,req=>req.userEmail),async(req,res)=>{
  try{res.json(authService.confirmEmailChange(req.userEmail,req.body?.newEmail,req.body?.code));}catch(error){res.status(400).json({error:error.message,code:error.code});}
});

// Safe self-service recovery: re-reads an already issued provider profile.
// It never creates a new provider order and never charges the customer.
app.post('/api/account/esim/recover',requireUserSession,rateLimit('self_esim_recovery',60*60*1000,3,req=>req.userEmail),async(req,res)=>{
  const user=getUser(req.userEmail);
  if(!user?.esim?.iccid||!user?.plan)return res.status(409).json({error:'Немає виданої eSIM для відновлення',code:'ESIM_NOT_ISSUED'});
  try{
    const esim=await recoverEsim({iccid:user.esim.iccid,plan:user.plan});
    const merged={...user.esim,...esim,recoveredAt:new Date().toISOString()};
    saveUser(req.userEmail,{esim:merged,lastEsimProvisionError:null});
    recordDiagnostic(req,{email:req.userEmail,source:'esim_access',type:'esim_flow',action:'self_service_recovery',outcome:'success',severity:'info',message:'Existing eSIM profile recovered by customer'});
    res.json({ok:true,esim:userStatusView({esim:merged}).esim});
  }catch(error){recordDiagnostic(req,{email:req.userEmail,source:'esim_access',type:'esim_flow',action:'self_service_recovery',outcome:'failed',severity:'error',message:'Self-service eSIM recovery failed',errorCode:error.code||'RECOVERY_FAILED'});res.status(502).json({error:'Не вдалося синхронізувати eSIM. Створіть звернення в підтримку.',code:error.code||'RECOVERY_FAILED'});}
});

app.get('/api/account/order-status',requireUserSession,(req,res)=>{
  const user=getUser(req.userEmail);if(!user)return res.status(404).json({error:'Акаунт не знайдено'});
  const purchase=(user.purchases||[])[0]||null;
  const familyEsim=purchase?.kind==='family_esim'?(user.sharedEsims||[]).find(item=>item.purchaseId===purchase.id):null;
  const readyEsim=familyEsim?.esim||user.esim||null;
  const steps=[
    {key:'payment',label:'Оплата',status:purchase?.paymentStatus==='paid'||purchase?.paidAt?'complete':user.status==='registered'?'pending':'complete'},
    {key:'provisioning',label:'Підготовка eSIM',status:purchase?.fulfillmentStatus==='failed'?'failed':readyEsim?.orderNo?'complete':purchase?.fulfillmentStatus==='provisioning'?'active':'pending'},
    {key:'ready',label:'eSIM готова',status:readyEsim?.orderNo?'complete':purchase?.fulfillmentStatus==='failed'?'failed':'pending'},
    {key:'installed',label:purchase?.kind==='family_esim'?'Передача близькій людині':'Встановлення',status:readyEsim?.activateTime?'complete':readyEsim?.orderNo?'active':'pending'},
  ];
  res.json({status:user.status,purchase:purchase?{id:purchase.id,name:purchase.packageName||purchase.plan,kind:purchase.kind||null,recipientName:purchase.recipientName||null,fulfillmentStatus:purchase.fulfillmentStatus,error:purchase.fulfillmentStatus==='failed'?'Потрібна допомога з видачею eSIM':null}:null,steps});
});

app.get('/api/account/family-esims',requireUserSession,(req,res)=>{
  const user=getUser(req.userEmail);if(!user)return res.status(404).json({error:'Акаунт не знайдено'});
  const items=(user.sharedEsims||[]).map(item=>({id:item.id,recipientName:item.recipientName,packageName:item.packageName,location:item.location||null,dataLimitGb:item.dataLimitGb??null,durationDays:item.durationDays??null,purchaseId:item.purchaseId,createdAt:item.createdAt,share:item.share?{createdAt:item.share.createdAt||null,expiresAt:item.share.expiresAt||null,viewedAt:item.share.viewedAt||null,installedAt:item.share.installedAt||null,active:Boolean(!item.share.revokedAt&&new Date(item.share.expiresAt).getTime()>Date.now())}:null,esim:{iccid:item.esim?.iccid||null,activationCode:item.esim?.activationCode||null,qrCodeUrl:item.esim?.qrCodeUrl||null,apn:item.esim?.apn||null,status:item.esim?.status||null,provider:item.esim?.provider||null,activateTime:item.esim?.activateTime||null,expiredTime:item.esim?.expiredTime||null}}));
  res.json({items});
});

function familyShareHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex');}
function findFamilyShare(token){
  if(!/^[A-Za-z0-9_-]{32,100}$/.test(String(token||'')))return null;
  const hash=familyShareHash(token);
  for(const user of Object.values(getAllUsers()))for(const item of user.sharedEsims||[])if(item.share?.tokenHash===hash)return {user,item};
  return null;
}
function publicFamilyShare(item){return {recipientName:item.recipientName,packageName:item.packageName,location:item.location||null,dataLimitGb:item.dataLimitGb??null,durationDays:item.durationDays??null,expiresAt:item.share?.expiresAt||null,viewedAt:item.share?.viewedAt||null,installedAt:item.share?.installedAt||null,esim:{activationCode:item.esim?.activationCode||null,apn:item.esim?.apn||null,expiredTime:item.esim?.expiredTime||null,hasQr:Boolean(item.esim?.qrCodeUrl)}};}

app.post('/api/account/family-esims/:id/share',requireUserSession,rateLimit('family_share_create',60*60*1000,12,req=>req.userEmail),(req,res)=>{
  const user=getUser(req.userEmail),shared=[...(user?.sharedEsims||[])],index=shared.findIndex(item=>item.id===req.params.id);
  if(index<0)return res.status(404).json({error:'eSIM для близької людини не знайдено'});
  if(!shared[index].esim?.activationCode&&!shared[index].esim?.qrCodeUrl)return res.status(409).json({error:'Дані встановлення ще не готові'});
  const token=crypto.randomBytes(32).toString('base64url'),days=Math.min(14,Math.max(1,Number(req.body?.days||7)));
  shared[index]={...shared[index],share:{tokenHash:familyShareHash(token),createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+days*86400000).toISOString(),viewedAt:null,installedAt:null,revokedAt:null}};
  saveUser(req.userEmail,{sharedEsims:shared});
  const base=String(process.env.FRONTEND_URL||'').replace(/\/$/,'');
  res.json({ok:true,url:`${base}/family-share.html?token=${encodeURIComponent(token)}`,expiresAt:shared[index].share.expiresAt});
});

app.delete('/api/account/family-esims/:id/share',requireUserSession,(req,res)=>{
  const user=getUser(req.userEmail),shared=[...(user?.sharedEsims||[])],index=shared.findIndex(item=>item.id===req.params.id);
  if(index<0)return res.status(404).json({error:'eSIM не знайдено'});
  if(shared[index].share)shared[index]={...shared[index],share:{...shared[index].share,revokedAt:new Date().toISOString()}};
  saveUser(req.userEmail,{sharedEsims:shared});res.json({ok:true});
});

app.get('/api/family-share/:token',rateLimit('family_share_open',15*60*1000,60,req=>req.params.token),(req,res)=>{
  const found=findFamilyShare(req.params.token);
  if(!found||found.item.share.revokedAt||new Date(found.item.share.expiresAt).getTime()<=Date.now())return res.status(404).json({error:'Посилання недійсне, відкликане або прострочене'});
  if(!found.item.share.viewedAt){found.item.share.viewedAt=new Date().toISOString();saveUser(found.user.email,{sharedEsims:found.user.sharedEsims});}
  res.set('Cache-Control','no-store');res.json(publicFamilyShare(found.item));
});

app.post('/api/family-share/:token/installed',rateLimit('family_share_installed',60*60*1000,10,req=>req.params.token),(req,res)=>{
  const found=findFamilyShare(req.params.token);
  if(!found||found.item.share.revokedAt||new Date(found.item.share.expiresAt).getTime()<=Date.now())return res.status(404).json({error:'Посилання недійсне або прострочене'});
  found.item.share.installedAt=new Date().toISOString();saveUser(found.user.email,{sharedEsims:found.user.sharedEsims});res.json({ok:true});
});

app.get('/api/family-share/:token/qr',rateLimit('family_share_qr',60*1000,20,req=>req.params.token),async(req,res)=>{
  const found=findFamilyShare(req.params.token);
  if(!found||found.item.share.revokedAt||new Date(found.item.share.expiresAt).getTime()<=Date.now())return res.status(404).json({error:'Посилання недійсне або прострочене'});
  const qrUrl=found.item.esim?.qrCodeUrl;if(!qrUrl)return res.status(404).json({error:'QR-код ще не надано оператором'});if(!isSafeQrImageUrl(qrUrl))return res.status(400).json({error:'Неприпустиме джерело QR'});
  try{const upstream=await fetch(qrUrl,{headers:{Accept:'image/png,image/jpeg,image/webp,image/gif'},redirect:'error',signal:AbortSignal.timeout(12000)});if(!upstream.ok)throw new Error('QR unavailable');const contentType=String(upstream.headers.get('content-type')||'').split(';')[0].toLowerCase(),allowed=new Set(['image/png','image/jpeg','image/webp','image/gif']);if(!allowed.has(contentType))throw new Error('QR format');const payload=Buffer.from(await upstream.arrayBuffer());if(!payload.length||payload.length>900000)return res.status(413).json({error:'QR-код завеликий'});res.set({'Content-Type':contentType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.send(payload);}catch{return res.status(502).json({error:'Не вдалося завантажити QR-код оператора'});}
});

// ---------- 3. Статус користувача (для дашборду) ----------
app.get('/api/status', requireUserSession, (req, res) => {
  const email = req.userEmail;

  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'Користувача не знайдено' });
  if (user.status === 'blocked') return res.status(403).json({ error: 'Акаунт заблоковано' });

  // Repair accounts that were incorrectly marked as pending by older builds
  // after a user opened and then cancelled Stripe Checkout.
  if (user.status === 'pending_payment' && user.esim?.orderNo) {
    return res.json(userStatusView(saveUser(email, { status: 'active' })));
  }

  res.json(userStatusView(user));
});

// ---------- 3.5. Оновити реальне використання трафіку ----------
app.get('/api/usage', requireUserSession, async (req, res) => {
  const email = req.userEmail;
  const cachedUser = getUser(email);
  try {
    const user = cachedUser;
    if (!user || !user.esim?.orderNo) {
      return res.status(404).json({ error: 'Немає активної eSIM для цього користувача' });
    }
    if (user.status === 'blocked') return res.status(403).json({ error: 'Акаунт заблоковано' });

    const usage = await checkUsage(user.esim.orderNo);
    const usedBytes = Math.max(0, Math.trunc(Number(usage.usedBytes) || 0));
    const providerTotalBytes = usage.totalBytes == null ? null : Math.max(0, Math.trunc(Number(usage.totalBytes) || 0));
    const fallbackTotalBytes = user.esim.dataLimitGb == null ? null : Math.round(Number(user.esim.dataLimitGb) * (1024 ** 3));
    const totalBytes = providerTotalBytes ?? fallbackTotalBytes;
    const remainingBytes = totalBytes == null ? null : Math.max(0, totalBytes - usedBytes);
    const usedGb = usedBytes / (1024 ** 3);
    const totalGb = totalBytes == null ? null : totalBytes / (1024 ** 3);
    const remainingGb = remainingBytes == null ? null : remainingBytes / (1024 ** 3);

    // Зберігаємо оновлені дані, щоб дашборд теж їх бачив без повторного запиту
    const history = [...(user.esim.usageHistory || [])];
    const day = new Date().toISOString().slice(0, 10);
    const snapshot = { day, usedBytes, totalBytes, remainingBytes, usedGb, remainingGb, totalGb };
    const existingIndex = history.findIndex((item) => item.day === day);
    if (existingIndex >= 0) history[existingIndex] = snapshot;
    else history.push(snapshot);
    const usageHistory = history.slice(-31);
    saveUser(email, {
      esim: {
        ...user.esim,
        usedGb,
        usedBytes,
        dataLimitGb: totalGb,
        totalBytes,
        apn: usage.apn ?? user.esim.apn,
        expiredTime: usage.expiredTime ?? user.esim.expiredTime,
        activateTime: usage.activateTime ?? user.esim.activateTime,
        lastUpdateTime: usage.lastUpdateTime ?? user.esim.lastUpdateTime,
        remainingGb,
        remainingBytes,
        usageHistory,
      },
    });
    refreshGoogleWallet(email);

    res.json({ usedBytes, totalBytes, remainingBytes, usedGb, totalGb, remainingGb, source:'esim_access_operator', esimStatus: usage.esimStatus, apn: usage.apn, expiredTime: usage.expiredTime, activateTime: usage.activateTime, lastUpdateTime: usage.lastUpdateTime });
  } catch (err) {
    if(inboundId)await storage.finishExternalEvent('resend',inboundId,'failed',err.message).catch(()=>{});
    console.error(err);
    const cached=cachedUser?.esim;
    if(cached&&cached.usedBytes!=null)return res.json({usedBytes:cached.usedBytes,totalBytes:cached.totalBytes??null,remainingBytes:cached.remainingBytes??null,usedGb:cached.usedGb??0,totalGb:cached.dataLimitGb??null,remainingGb:cached.remainingGb??null,source:'cached',stale:true,lastUpdateTime:cached.lastUpdateTime||cached.updatedAt||null,warning:'Оператор тимчасово недоступний. Показано останні відомі дані.'});
    res.status(502).json({ error: 'Не вдалося отримати дані оператора eSIM' });
  }
});

// ---------- 3.6. Дата наступного списання (реальна, зі Stripe) ----------
app.get('/api/billing', requireUserSession, async (req, res) => {
  try {
    const email = req.userEmail;

    const user = getUser(email);
    if (!user || !user.stripeSubscriptionId) {
      return res.status(404).json({ error: 'Немає активної підписки' });
    }

    const nextBillingDate = await getNextBillingDate(user.stripeSubscriptionId);
    res.json({ nextBillingDate });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Не вдалося отримати дані про наступну оплату' });
  }
});

app.get('/api/account/billing-profile',requireUserSession,async(req,res)=>{
  try{const profile=await recoverStripeProfile(req.userEmail);res.json({linked:Boolean(profile.customerId),activeSubscription:profile.activeSubscription,subscriptionStatus:profile.subscriptionStatus,paidInvoiceCount:profile.paidInvoiceCount,duplicateProfiles:Math.max(0,profile.customerCount-1),customerReference:profile.customerId?`…${profile.customerId.slice(-8)}`:null});}
  catch(error){console.error('[billing profile]',error.message);res.status(502).json({error:'Не вдалося перевірити платіжний профіль'});}
});

app.post('/api/billing/portal',requireUserSession,rateLimit('billing_portal',15*60*1000,10,req=>req.userEmail),async(req,res)=>{
  try{const profile=await recoverStripeProfile(req.userEmail);if(!profile.customerId)return res.status(404).json({error:'У Stripe ще немає платіжного профілю для цього акаунта. Він створиться автоматично під час першої оплати.'});const session=await createBillingPortalSession(profile.customerId);res.json({url:session.url,recovered:profile.source!=='stored_or_purchase'});}
  catch(error){console.error('[billing portal]',error.message);res.status(502).json({error:'Не вдалося відкрити керування оплатою'});}
});

// ---------- 4. Скасування підписки ----------
app.post('/api/cancel', requireUserSession, async (req, res) => {
  try {
    const email = req.userEmail;
    const user = getUser(email);
    if (!user || !user.stripeSubscriptionId) {
      return res.status(404).json({ error: 'Активної підписки не знайдено' });
    }
    const subscription=await cancelSubscriptionAtPeriodEnd(user.stripeSubscriptionId);
    const periodEnd=subscription.current_period_end?new Date(subscription.current_period_end*1000).toISOString():null;
    saveUser(email, { status: 'active', cancelAtPeriodEnd:true, subscriptionPeriodEnd:periodEnd });
    res.json({ ok: true, cancelAtPeriodEnd:true, periodEnd });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Не вдалося скасувати підписку' });
  }
});

const PORT = process.env.PORT || 4242;
storage.init().then(() => Promise.all([
  bootstrapUsers(),
  authStore.bootstrap(),
  pushStore.bootstrap(),
  adminStore.bootstrap(),
  ticketStore.bootstrap(),
  auditStore.bootstrap(),
  operationsStore.bootstrap(),
  translationService.bootstrap(),
  diagnosticsStore.bootstrap(),
])).then(() => adminAuth.bootstrap()).then(() => {
  app.listen(PORT, () => {
    console.log(`Signal backend running on http://localhost:${PORT}`);
  });
  processDuePlanChanges().catch(error=>console.error('[plan change scheduler]',error.message));
  const planChangeTimer=setInterval(()=>processDuePlanChanges().catch(error=>console.error('[plan change scheduler]',error.message)),60*1000);
  planChangeTimer.unref?.();
  processOperationalJobs().catch(error=>console.error('[operations worker]',error.message));
  const operationsTimer=setInterval(()=>processOperationalJobs().catch(error=>console.error('[operations worker]',error.message)),30*1000);
  operationsTimer.unref?.();
  runDailySuperAdminReport().catch(error=>console.error('[daily report]',error.message));
  const dailyReportTimer=setInterval(()=>runDailySuperAdminReport().catch(error=>console.error('[daily report]',error.message)),30*60*1000);
  dailyReportTimer.unref?.();
}).catch((error) => {
  console.error('Failed to start persistent storage:', error);
  process.exit(1);
});

app.get('/api/account/billing-history', requireUserSession, async (req, res) => {
  try {
    const user = getUser(req.userEmail);
    const local = (user?.purchases || []).map(purchase => ({
      id:purchase.id, createdAt:purchase.paidAt || purchase.createdAt, amount:Number(purchase.amountCents || 0)/100,
      currency:purchase.currency || 'usd', status:purchase.paymentStatus || 'paid',
      fulfillmentStatus:purchase.fulfillmentStatus || null, name:purchase.packageName || purchase.plan || 'eSIM-пакет',
      detail:[purchase.location, purchase.dataLimitGb == null ? null : `${purchase.dataLimitGb} ГБ`, purchase.durationDays ? `${purchase.durationDays} днів` : null].filter(Boolean).join(' · '),
      receiptUrl:purchase.receiptUrl || null, receiptEmailSentAt:purchase.receiptEmailSentAt || null,
    }));
    const profile=await recoverStripeProfile(req.userEmail).catch(()=>({customerId:user?.stripeCustomerId||null}));
    const stripeInvoices = profile.customerId ? await getBillingHistory(profile.customerId) : [];
    const combined = [...local, ...stripeInvoices.filter(invoice => !local.some(item => item.id === invoice.id))]
      .sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    res.json({ invoices:combined });
  } catch (error) {
    console.error('Billing history:', error.message);
    res.status(502).json({ error: 'Не вдалося завантажити історію оплат' });
  }
});

app.use((error, req, res, next) => {
  console.error('Unhandled request error:', error.message);
  if (res.headersSent) return next(error);
  const forbiddenOrigin = error.message === 'Origin is not allowed';
  res.status(forbiddenOrigin ? 403 : 500).json({ error: forbiddenOrigin ? 'Цей сайт не має доступу до API' : 'Внутрішня помилка сервера' });
});
