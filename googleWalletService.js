const crypto = require('crypto');

const SAVE_BASE_URL = 'https://pay.google.com/gp/v/save/';
const API_BASE_URL = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const WALLET_SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
let cachedAccessToken=null;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function cleanIdentifier(value, fallback) {
  const cleaned=String(value||'').trim().replace(/[^A-Za-z0-9._-]/g,'_').slice(0,80);
  return cleaned || fallback;
}

function parseCredentials(raw) {
  const value=String(raw||'').trim();
  if(!value)return {};
  try{return JSON.parse(value);}catch{}
  try{return JSON.parse(Buffer.from(value,'base64').toString('utf8'));}catch{}
  return {};
}

function configuration(env = process.env) {
  const credentials=parseCredentials(env.GOOGLE_WALLET_CREDENTIALS_JSON);
  const issuerId=String(env.GOOGLE_WALLET_ISSUER_ID||'').trim();
  const clientEmail=String(env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL||credentials.client_email||'').trim();
  const privateKey=String(env.GOOGLE_WALLET_PRIVATE_KEY||credentials.private_key||'').replace(/\\n/g,'\n').trim();
  const classSuffix=cleanIdentifier(env.GOOGLE_WALLET_CLASS_SUFFIX,'signal_travel_pass');
  const missing=[];
  if(!/^\d+$/.test(issuerId))missing.push('GOOGLE_WALLET_ISSUER_ID');
  if(!clientEmail.includes('@'))missing.push('GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL');
  if(!privateKey.includes('BEGIN PRIVATE KEY'))missing.push('GOOGLE_WALLET_PRIVATE_KEY');
  return {configured:missing.length===0,missing,issuerId,clientEmail,privateKey,classId:issuerId?`${issuerId}.${classSuffix}`:null};
}

function localized(value) {
  return {defaultValue:{language:'uk-UA',value:String(value||'')}};
}

function formatGb(value) {
  return value==null?'∞':Number(value).toLocaleString('uk-UA',{maximumFractionDigits:2});
}

function formatDate(value) {
  return value&&!Number.isNaN(new Date(value).getTime())?new Date(value).toLocaleDateString('uk-UA',{day:'numeric',month:'short',year:'numeric'}):'Без дати';
}

function readinessLabel(card) {
  if(card?.status==='expired')return 'Пакет завершився';
  if(card?.status==='blocked')return 'Потрібна перевірка акаунта';
  if(card?.esimReadiness==='ready')return 'eSIM готова до поїздки';
  if(card?.esimReadiness==='attention')return 'Перевір eSIM до поїздки';
  return 'eSIM ще не підготовлена';
}

function safeHttpsBase(value) {
  try{const url=new URL(String(value||''));return url.protocol==='https:'?url.origin:null;}catch{return null;}
}

function passResources(card, env = process.env) {
  const config=configuration(env);
  if(!config.configured)return {config};
  const base=safeHttpsBase(env.FRONTEND_URL)||'https://esimsignalapp.com';
  const serial=cleanIdentifier(card?.serial,'signal-pass');
  const objectId=`${config.issuerId}.${serial}`;
  const genericClass={
    id:config.classId,
    issuerName:'Signal',
    reviewStatus:'UNDER_REVIEW',
    multipleDevicesAndHoldersAllowedStatus:'ONE_USER_ALL_DEVICES',
  };
  const dataHeadline=card?.remainingGb==null?'Безлімітний інтернет':`${formatGb(card.remainingGb)} GB залишилось`;
  const usedLine=card?.totalGb==null?`${formatGb(card?.usedGb||0)} GB використано`:`${formatGb(card?.usedGb||0)} із ${formatGb(card.totalGb)} GB`;
  const tripLine=card?.tripStartDate?`${formatDate(card.tripStartDate)}${card.tripEndDate?` — ${formatDate(card.tripEndDate)}`:''}`:'Не запланована';
  const tripState=card?.tripStatus==='in_progress'?'Подорож триває':card?.tripStatus==='completed'?'Подорож завершена':card?.daysUntilTrip===0?'Виїзд сьогодні':card?.daysUntilTrip===1?'До виїзду 1 день':card?.daysUntilTrip>1?`До виїзду ${card.daysUntilTrip} дн.`:'Додайте дати у Signal';
  const dataState={empty:'Дані закінчилися',critical:'Даних залишилось критично мало',low:'Невеликий залишок даних',healthy:'Запас даних достатній',unlimited:'Безлімітний пакет'}[card?.dataStatus]||'Очікуємо синхронізацію';
  const textModules=[
    {id:'readiness',header:'ГОТОВНІСТЬ',body:readinessLabel(card)},
    {id:'usage',header:'ВИКОРИСТАННЯ',body:usedLine},
    {id:'data_state',header:'СТАН ДАНИХ',body:dataState},
    {id:'plan',header:'ПАКЕТ',body:String(card?.plan||'eSIM').slice(0,100)},
    {id:'destination',header:'НАПРЯМОК',body:String(card?.destination||'Global').slice(0,80)},
    {id:'trip',header:'ПОДОРОЖ',body:`${tripState} · ${tripLine}`.slice(0,200)},
    {id:'validity',header:'ДІЄ ДО',body:formatDate(card?.validUntil)},
    {id:'sync',header:'ОСТАННЄ ОНОВЛЕННЯ',body:card?.lastSyncAt?new Date(card.lastSyncAt).toLocaleString('uk-UA'):'Ще не синхронізовано'},
  ];
  if(card?.familyTotal>0)textModules.push({id:'family',header:'СІМЕЙНА ГОТОВНІСТЬ',body:`Готові ${card.familyReady} із ${card.familyTotal}`});
  const genericObject={
    id:objectId,
    classId:config.classId,
    state:'ACTIVE',
    genericType:'GENERIC_OTHER',
    cardTitle:localized('Signal Travel Pass'),
    header:localized(dataHeadline),
    subheader:localized(readinessLabel(card)),
    logo:{sourceUri:{uri:`${base}/signal-premium-logo.png`},contentDescription:localized('Signal')},
    hexBackgroundColor:'#111a42',
    textModulesData:textModules,
    messages:[{id:'signal_status',header:'Signal Travel Pass',body:`${readinessLabel(card)}. ${dataHeadline}.`,messageType:'TEXT'}],
    linksModuleData:{uris:[
      {id:'open_signal',uri:`${base}/dashboard.html`,description:'Відкрити Signal'},
      {id:'usage',uri:`${base}/usage.html`,description:'Перевірити витрати даних'},
      {id:'trip',uri:`${base}/travel-assistant.html`,description:'Підготовка до подорожі'},
      {id:'support',uri:`${base}/help.html`,description:'Підтримка Signal'},
    ]},
  };
  const interval={};
  if(card?.tripStartDate&&!Number.isNaN(new Date(`${card.tripStartDate}T00:00:00Z`).getTime()))interval.start={date:new Date(`${card.tripStartDate}T00:00:00Z`).toISOString()};
  if(card?.validUntil&&!Number.isNaN(new Date(card.validUntil).getTime()))interval.end={date:new Date(card.validUntil).toISOString()};
  if(interval.start&&interval.end&&new Date(interval.start.date).getTime()>new Date(interval.end.date).getTime())delete interval.start;
  if(interval.start||interval.end)genericObject.validTimeInterval=interval;
  if(interval.end&&new Date(interval.end.date).getTime()>Date.now())genericObject.notifications={expiryNotification:{enableNotification:true}};
  else if(interval.start&&new Date(interval.start.date).getTime()>Date.now())genericObject.notifications={upcomingNotification:{enableNotification:true}};
  return {config,genericClass,genericObject,base,objectId};
}

function signJwt(claims, privateKey) {
  const header=base64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  const payload=base64url(JSON.stringify(claims));
  const input=`${header}.${payload}`;
  const signature=crypto.sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function createSaveLink(card, env = process.env) {
  const resources=passResources(card,env);
  if(!resources.config.configured)return {configured:false,status:'setup_required',missing:resources.config.missing,url:null};
  const now=Math.floor(Date.now()/1000);
  const claims={
    iss:resources.config.clientEmail,
    aud:'google',
    origins:[resources.base],
    typ:'savetowallet',
    iat:now,
    exp:now+10*60,
    payload:{genericObjects:[{id:resources.objectId,classId:resources.config.classId}]},
  };
  try{
    const token=signJwt(claims,resources.config.privateKey);
    return {configured:true,status:'ready',url:`${SAVE_BASE_URL}${token}`,objectId:resources.objectId,expiresAt:new Date((now+10*60)*1000).toISOString()};
  }catch{
    return {configured:false,status:'invalid_private_key',missing:['GOOGLE_WALLET_PRIVATE_KEY'],url:null};
  }
}

async function accessToken(config, fetchImpl) {
  const now=Math.floor(Date.now()/1000);
  if(cachedAccessToken&&cachedAccessToken.clientEmail===config.clientEmail&&cachedAccessToken.expiresAt>now+60)return cachedAccessToken.value;
  const assertion=signJwt({iss:config.clientEmail,scope:WALLET_SCOPE,aud:TOKEN_URL,iat:now,exp:now+3600},config.privateKey);
  const response=await fetchImpl(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error(`wallet_oauth_${response.status}`);
  cachedAccessToken={clientEmail:config.clientEmail,value:data.access_token,expiresAt:now+Math.max(300,Number(data.expires_in)||3600)};
  return data.access_token;
}

async function walletRequest(path, token, fetchImpl, options={}) {
  const response=await fetchImpl(`${API_BASE_URL}${path}`,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  return {response,data};
}

async function syncPass(resources, fetchImpl=global.fetch) {
  if(typeof fetchImpl!=='function')throw new Error('wallet_fetch_unavailable');
  const token=await accessToken(resources.config,fetchImpl);
  const classPath=`/genericClass/${encodeURIComponent(resources.config.classId)}`;
  const existingClass=await walletRequest(classPath,token,fetchImpl);
  if(existingClass.response.status===404){
    const created=await walletRequest('/genericClass',token,fetchImpl,{method:'POST',body:JSON.stringify(resources.genericClass)});
    if(!created.response.ok&&created.response.status!==409)throw new Error(`wallet_class_${created.response.status}`);
  }else if(existingClass.response.ok){
    const updated=await walletRequest(classPath,token,fetchImpl,{method:'PUT',body:JSON.stringify(resources.genericClass)});
    if(!updated.response.ok)throw new Error(`wallet_class_${updated.response.status}`);
  }else throw new Error(`wallet_class_${existingClass.response.status}`);

  const objectPath=`/genericObject/${encodeURIComponent(resources.objectId)}`;
  const existingObject=await walletRequest(objectPath,token,fetchImpl);
  if(existingObject.response.status===404){
    const created=await walletRequest('/genericObject',token,fetchImpl,{method:'POST',body:JSON.stringify(resources.genericObject)});
    if(!created.response.ok&&created.response.status!==409)throw new Error(`wallet_object_${created.response.status}`);
  }else if(existingObject.response.ok){
    const updated=await walletRequest(objectPath,token,fetchImpl,{method:'PUT',body:JSON.stringify(resources.genericObject)});
    if(!updated.response.ok)throw new Error(`wallet_object_${updated.response.status}`);
  }else throw new Error(`wallet_object_${existingObject.response.status}`);
  return {classId:resources.config.classId,objectId:resources.objectId};
}

async function createPass(card, env=process.env, fetchImpl=global.fetch) {
  const resources=passResources(card,env);
  if(!resources.config.configured)return {configured:false,status:'setup_required',missing:resources.config.missing,url:null};
  try{
    await syncPass(resources,fetchImpl);
    return createSaveLink(card,env);
  }catch{
    return {configured:true,status:'google_api_error',missing:[],url:null};
  }
}

module.exports={ configuration, passResources, createSaveLink, syncPass, createPass };
