const crypto = require('crypto');

const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
const text = (value, max = 100) => String(value || '').replace(/[\r\n<>]/g, ' ').trim().slice(0, max);

const COUNTRY_CODES = {
  ukraine:'UA', україна:'UA', poland:'PL', польща:'PL', germany:'DE', німеччина:'DE',
  france:'FR', франція:'FR', italy:'IT', італія:'IT', spain:'ES', іспанія:'ES',
  czechia:'CZ', 'czech republic':'CZ', чехія:'CZ', austria:'AT', австрія:'AT',
  turkey:'TR', туреччина:'TR', usa:'US', 'united states':'US', сша:'US',
  canada:'CA', канада:'CA', japan:'JP', японія:'JP', thailand:'TH', таїланд:'TH',
  egypt:'EG', єгипет:'EG', global:'GL', європа:'EU', europe:'EU',
};

function locationIdentity(value) {
  const name = text(String(value || '').split(/[,;/]/)[0], 80) || 'Нова країна';
  const code = COUNTRY_CODES[name.toLowerCase()] || 'GL';
  const flag = /^[A-Z]{2}$/.test(code) && !['GL','EU'].includes(code)
    ? String.fromCodePoint(...code.split('').map(letter => 127397 + letter.charCodeAt()))
    : code === 'EU' ? '🇪🇺' : '🌍';
  return { name, code, flag };
}

function loyaltyFor(user = {}) {
  const value = user.loyalty || {};
  return {
    points:Math.max(0, Math.trunc(Number(value.points) || 0)),
    lifetimePoints:Math.max(0, Math.trunc(Number(value.lifetimePoints) || 0)),
    ledger:Array.isArray(value.ledger) ? value.ledger.slice(0, 500) : [],
    rewards:Array.isArray(value.rewards) ? value.rewards.slice(0, 50) : [],
  };
}

function tier(points) {
  if (points >= 5000) return { key:'orbit', name:'Orbit', next:null, progress:100 };
  if (points >= 2000) return { key:'explorer', name:'Explorer', next:5000, progress:Math.round((points-2000)/30) };
  if (points >= 500) return { key:'traveler', name:'Traveler', next:2000, progress:Math.round((points-500)/15) };
  return { key:'starter', name:'Starter', next:500, progress:Math.round(points/5) };
}

function passportFor(user = {}) {
  const persisted = Array.isArray(user.passport?.stamps) ? user.passport.stamps : [];
  const sources = [
    ...(Array.isArray(user.purchases) ? user.purchases : []),
    ...(Array.isArray(user.sharedEsims) ? user.sharedEsims : []),
  ];
  const generated = sources
    .filter(item => ['provisioned','delivered'].includes(item.fulfillmentStatus) || item.esim?.orderNo)
    .map(item => {
      const country = locationIdentity(item.location || item.destination || item.packageName);
      return { id:`stamp_${String(item.id || item.purchaseId || country.code).replace(/[^A-Za-z0-9_-]/g,'').slice(-60)}`, country:country.name, countryCode:country.code, flag:country.flag, source:item.kind === 'family_esim' ? 'family' : 'purchase', purchaseId:item.id || item.purchaseId || null, firstConnectedAt:item.fulfilledAt || item.createdAt || now() };
    });
  const all = [...persisted, ...generated];
  return [...new Map(all.map(stamp => [stamp.purchaseId || `${stamp.countryCode}:${stamp.firstConnectedAt}`, stamp])).values()]
    .sort((a,b) => new Date(b.firstConnectedAt) - new Date(a.firstConnectedAt)).slice(0, 100);
}

function awardPurchase(user = {}, purchase = {}, settings = {}) {
  const loyalty = loyaltyFor(user);
  const key = `purchase:${purchase.id}`;
  if (!purchase.id || loyalty.ledger.some(entry => entry.key === key)) return { loyalty, awarded:0 };
  const perDollar = Math.max(1, Math.min(100, Number(settings.pointsPerDollar) || 10));
  const stampBonus = Math.max(0, Math.min(1000, Number(settings.stampBonus) || 50));
  const amount = Math.max(0, Number(purchase.amountCents) || 0);
  const points = Math.max(stampBonus, Math.round(amount / 100 * perDollar) + stampBonus);
  loyalty.points += points;
  loyalty.lifetimePoints += points;
  loyalty.ledger.unshift({ id:id('points'), key, type:'purchase', points, reason:`${purchase.packageName || 'eSIM'} · бонус за подорож`, purchaseId:purchase.id, createdAt:now() });
  loyalty.ledger = loyalty.ledger.slice(0, 500);
  return { loyalty, awarded:points };
}

function publicClub(user = {}, settings = {}) {
  const loyalty = loyaltyFor(user);
  const rewards = (settings.rewards || [
    {id:'discount_1',name:'Знижка $1 на наступну eSIM',points:250,kind:'discount',amountCents:100},
    {id:'discount_2',name:'Знижка $2 на наступну eSIM',points:500,kind:'discount',amountCents:200},
    {id:'discount_5',name:'Знижка $5 на наступну eSIM',points:1100,kind:'discount',amountCents:500},
  ]).map(item => ({id:text(item.id,40),name:text(item.name,100),points:Math.max(1,Math.trunc(Number(item.points)||1)),kind:text(item.kind,30),amountCents:Math.max(0,Math.trunc(Number(item.amountCents)||0))}));
  return { ...loyalty, tier:tier(loyalty.lifetimePoints), rewardsCatalog:rewards, enabled:settings.enabled !== false };
}

function redeem(user = {}, reward, settings = {}) {
  const club = publicClub(user, settings);
  const selected = club.rewardsCatalog.find(item => item.id === reward);
  if (!selected) throw Object.assign(new Error('Винагороду не знайдено'), { code:'REWARD_NOT_FOUND' });
  if (club.points < selected.points) throw Object.assign(new Error('Поки недостатньо Signal Points'), { code:'POINTS_INSUFFICIENT' });
  const loyalty = loyaltyFor(user);
  loyalty.points -= selected.points;
  const record = { id:id('reward'), catalogId:selected.id, name:selected.name, kind:selected.kind, amountCents:selected.amountCents, code:`SIG-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, status:'available', createdAt:now(), expiresAt:new Date(Date.now()+180*86400000).toISOString() };
  loyalty.rewards.unshift(record);
  loyalty.ledger.unshift({ id:id('points'), key:`reward:${record.id}`, type:'redeem', points:-selected.points, reason:selected.name, createdAt:record.createdAt });
  return { loyalty, reward:record };
}

function usageInsights(user = {}) {
  const esim = user.esim || {};
  const history = (Array.isArray(esim.usageHistory) ? esim.usageHistory : []).filter(item => item?.day && Number.isFinite(Number(item.usedBytes))).sort((a,b)=>a.day.localeCompare(b.day));
  const deltas=[];
  for(let i=1;i<history.length;i++){
    const days=Math.max(1,Math.round((new Date(`${history[i].day}T00:00:00Z`)-new Date(`${history[i-1].day}T00:00:00Z`))/86400000));
    const delta=Math.max(0,Number(history[i].usedBytes)-Number(history[i-1].usedBytes))/(1024**3)/days;
    if(Number.isFinite(delta))deltas.push(delta);
  }
  const recent=deltas.slice(-7),daily=recent.length?recent.reduce((sum,value)=>sum+value,0)/recent.length:0;
  const total=esim.dataLimitGb == null ? null : Number(esim.dataLimitGb);
  const remaining=esim.remainingGb == null ? (total == null ? null : Math.max(0,total-Number(esim.usedGb||0))) : Number(esim.remainingGb);
  const daysLeft=remaining != null && daily > .005 ? Math.max(0,Math.floor(remaining/daily)) : null;
  const expiryDays=esim.expiredTime ? Math.max(0,Math.ceil((new Date(esim.expiredTime)-Date.now())/86400000)) : null;
  const risk=remaining != null && (remaining < 1 || (daysLeft != null && daysLeft <= 3)) ? 'high' : remaining != null && (remaining < 3 || (daysLeft != null && daysLeft <= 7)) ? 'medium' : 'low';
  return {dailyAverageGb:+daily.toFixed(3),remainingGb:remaining == null?null:+remaining.toFixed(3),projectedDaysLeft:daysLeft,expiryDays,confidence:recent.length>=5?'high':recent.length>=2?'medium':'low',risk,recommendation:risk==='high'?'Дані можуть закінчитися скоро — підготуй пакет заздалегідь.':risk==='medium'?'Контролюй витрати протягом найближчих днів.':'Запасу даних достатньо за поточного темпу.',historyDays:history.length,lastSyncAt:esim.lastUpdateTime||null};
}

function safeFamilyTrip(value = {}, previous = {}) {
  const destination=text(value.destination,80), startDate=String(value.startDate||'').slice(0,10), endDate=String(value.endDate||'').slice(0,10);
  if(!destination || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || new Date(endDate)<new Date(startDate)) throw Object.assign(new Error('Вкажіть напрямок і правильні дати'),{code:'FAMILY_TRIP_INVALID'});
  const members=(Array.isArray(value.members)?value.members:previous.members||[]).slice(0,12).map(member=>({id:text(member.id,80)||id('member'),name:text(member.name,60),email:text(member.email,254).toLowerCase()||null,sharedEsimId:text(member.sharedEsimId,100)||null,status:['invited','ready','installed','attention'].includes(member.status)?member.status:'invited'})).filter(member=>member.name);
  return {id:previous.id||id('trip'),name:text(value.name,80)||`Подорож · ${destination}`,destination,startDate,endDate,members,createdAt:previous.createdAt||now(),updatedAt:now()};
}

function safeRescueDiagnostics(user = {}, client = {}) {
  const latest=(user.purchases||[])[0]||{};
  return {deviceModel:text(client.deviceModel,100)||'Не визначено',platform:text(client.platform,40)||'web',appVersion:text(client.appVersion,40)||'Не визначено',online:client.online!==false,esimStatus:text(user.esim?.status||user.status||'not_issued',60),lastSyncAt:user.esim?.lastUpdateTime||user.updatedAt||null,purchaseId:text(latest.id,100)||null,stripeStatus:text(latest.paymentStatus||(user.stripeCustomerId?'profile_linked':'not_linked'),60),providerStatus:text(latest.fulfillmentStatus||user.esim?.provider||'not_issued',80),apn:text(user.esim?.apn,100)||null};
}

function walletCard(user = {}) {
  const latest=(user.purchases||[]).find(item=>['provisioned','delivered'].includes(item.fulfillmentStatus))||{};
  const esim=user.esim||{},nowMs=Date.now(),toNumber=value=>value==null?null:Number(value),fromBytes=value=>value==null?null:Number(value)/(1024**3);
  const usedGb=fromBytes(esim.usedBytes)??toNumber(esim.usedGb)??0,totalGb=fromBytes(esim.totalBytes)??toNumber(esim.dataLimitGb),remainingGb=fromBytes(esim.remainingBytes)??toNumber(esim.remainingGb)??(totalGb==null?null:Math.max(0,totalGb-usedGb));
  const validUntil=esim.expiredTime||latest.expiresAt||null,validMs=validUntil?new Date(validUntil).getTime():null,daysUntilExpiry=Number.isFinite(validMs)?Math.max(0,Math.ceil((validMs-nowMs)/86400000)):null;
  const trip=user.travelMode?.enabled===false?null:user.travelMode||null,tripStartDate=trip?.startDate||null,tripEndDate=trip?.endDate||null,startMs=tripStartDate?new Date(`${tripStartDate}T00:00:00Z`).getTime():null,endMs=tripEndDate?new Date(`${tripEndDate}T23:59:59Z`).getTime():null;
  const daysUntilTrip=Number.isFinite(startMs)?Math.ceil((startMs-nowMs)/86400000):null,tripStatus=!Number.isFinite(startMs)?'not_planned':nowMs<startMs?'upcoming':Number.isFinite(endMs)&&nowMs>endMs?'completed':'in_progress';
  const hasEsim=Boolean(esim.orderNo),hasActivation=Boolean(esim.activationCode||esim.qrCodeUrl),expiresBeforeTrip=Number.isFinite(validMs)&&Number.isFinite(endMs)&&validMs<endMs;
  const status=user.status==='blocked'?'blocked':Number.isFinite(validMs)&&validMs<nowMs?'expired':hasEsim?'active':'planned';
  const esimReadiness=!hasEsim?'not_ready':expiresBeforeTrip?'attention':hasActivation||status==='active'?'ready':'attention';
  const usagePercent=totalGb!=null&&totalGb>0?Math.min(100,Math.max(0,usedGb/totalGb*100)):null;
  const dataStatus=remainingGb==null?'unlimited':remainingGb<=0?'empty':remainingGb<1?'critical':remainingGb<3?'low':'healthy';
  const familyTrip=(user.familyTrips||[]).find(item=>!item.endDate||new Date(`${item.endDate}T23:59:59Z`).getTime()>=nowMs)||(user.familyTrips||[])[0]||null,familyMembers=familyTrip?.members||[],familyReady=familyMembers.filter(item=>['ready','installed'].includes(item.status)).length;
  const cleanNumber=value=>value==null||!Number.isFinite(Number(value))?null:+Number(value).toFixed(3);
  return {serial:`signal-${crypto.createHash('sha256').update(user.email||'guest').digest('hex').slice(0,16)}`,holder:text(user.displayName,80)||'Signal Traveler',plan:text(latest.packageName||user.plan||'eSIM',100),destination:text(trip?.destination||latest.location||'Global',80),validUntil,status,usedGb:cleanNumber(usedGb),totalGb:cleanNumber(totalGb),remainingGb:cleanNumber(remainingGb),usagePercent:cleanNumber(usagePercent),dataStatus,esimReadiness,tripStartDate,tripEndDate,daysUntilTrip,tripStatus,daysUntilExpiry,lastSyncAt:esim.lastUpdateTime||user.updatedAt||null,familyReady,familyTotal:familyMembers.length};
}

function smartTripStatus(user = {}) {
  const card=walletCard(user),insights=usageInsights(user),trip=user.travelMode?.enabled===false?null:user.travelMode||null;
  let state='idle',eyebrow='SIGNAL ГОТОВИЙ',title='Куди далі?',message='Заплануй напрямок і дати — Signal підготує eSIM та нагадування.',action={label:'Запланувати подорож',url:'/travel-assistant.html'};
  if(card.tripStatus==='upcoming'){
    state='upcoming';eyebrow=card.daysUntilTrip<=1?'ВИЇЗД УЖЕ ЗАВТРА':`ДО ПОЇЗДКИ ${Math.max(0,card.daysUntilTrip)} ДН.`;
    if(card.esimReadiness==='not_ready'){title='Потрібна eSIM';message=`Для поїздки до ${card.destination} ще не обрано пакет.`;action={label:'Обрати пакет',url:'/travel-plans.html'};}
    else if(card.esimReadiness==='attention'){title='Перевір термін eSIM';message='Поточна eSIM може не покрити всю поїздку. Перевір пакет до виїзду.';action={label:'Перевірити eSIM',url:'/esim-management.html'};}
    else if(card.daysUntilTrip<=3){title='Все готово до подорожі';message='eSIM готова. Збережи Travel Pass та офлайн-картку перед виїздом.';action={label:'Відкрити Travel Pass',url:'/wallet-pass.html'};}
    else {title=`${card.destination} уже близько`;message='eSIM готова. Signal продовжить стежити за датою та терміном пакета.';action={label:'Переглянути готовність',url:'/travel-assistant.html'};}
  } else if(card.tripStatus==='in_progress'){
    state=insights.risk==='high'?'attention':'active';eyebrow='ПОДОРОЖ ТРИВАЄ';title=insights.risk==='high'?'Інтернет може закінчитися':'Зв’язок під контролем';message=insights.recommendation;action={label:insights.risk==='high'?'Додати пакет':'Переглянути витрати',url:insights.risk==='high'?'/esim-topup.html':'/usage.html'};
  } else if(card.status==='active'){
    state=insights.risk==='high'?'attention':'ready';eyebrow='ESIM АКТИВНА';title=insights.risk==='high'?'Залишилося мало даних':'Інтернет готовий';message=insights.recommendation;action={label:insights.risk==='high'?'Додати пакет':'Відкрити Travel Pass',url:insights.risk==='high'?'/esim-topup.html':'/wallet-pass.html'};
  } else if(card.status==='expired'){
    state='attention';eyebrow='ПАКЕТ ЗАВЕРШЕНО';title='Час обрати новий пакет';message='Попередня eSIM залишилася в історії, а новий пакет можна придбати окремо.';action={label:'Переглянути тарифи',url:'/plans.html'};
  }
  return {state,eyebrow,title,message,action,destination:trip?.destination||null,startDate:trip?.startDate||null,endDate:trip?.endDate||null,daysUntilTrip:card.daysUntilTrip,tripStatus:card.tripStatus,readiness:{esim:card.esimReadiness,wallet:card.status==='active'?'ready':'available',offline:Boolean(user.esim?.activationCode||user.esim?.qrCodeUrl)},updatedAt:card.lastSyncAt||user.updatedAt||null};
}

function activityFeed(user = {}, tickets = []) {
  const items=[];
  const add=(value)=>{if(value.date&&value.id)items.push(value);};
  for(const purchase of (user.purchases||[]).slice(0,80)) add({id:`purchase:${purchase.id}`,type:'purchase',title:purchase.fulfillmentStatus==='failed'?'Потрібна увага до замовлення':purchase.fulfillmentStatus==='provisioned'||purchase.fulfillmentStatus==='delivered'?'eSIM підготовлено':purchase.paymentStatus==='paid'?'Оплату підтверджено':'Створено замовлення',detail:text(purchase.packageName||purchase.plan||'Пакет Signal',120),status:purchase.fulfillmentStatus||purchase.paymentStatus||'created',date:purchase.fulfilledAt||purchase.paidAt||purchase.updatedAt||purchase.createdAt,url:'/payments.html'});
  for(const entry of loyaltyFor(user).ledger.slice(0,80)) add({id:`points:${entry.id}`,type:'points',title:Number(entry.points)>=0?`+${entry.points} Signal Points`:`${entry.points} Signal Points`,detail:text(entry.reason,140)||'Зміна балансу',status:Number(entry.points)>=0?'earned':'used',date:entry.createdAt,url:'/signal-club.html'});
  for(const ticket of tickets.slice(0,50)) add({id:`ticket:${ticket.id}:${ticket.updatedAt}`,type:'support',title:`Звернення #${ticket.id}`,detail:text(ticket.subject,140),status:ticket.status,date:ticket.updatedAt||ticket.createdAt,url:`/ticket.html?id=${encodeURIComponent(ticket.id)}`});
  for(const item of (user.sharedEsims||[]).slice(0,40)){
    add({id:`family:${item.id}`,type:'family',title:`eSIM для ${text(item.recipientName,60)||'близької людини'}`,detail:text(item.packageName,120)||'Сімейна eSIM',status:item.share?.installedAt?'installed':item.share?.viewedAt?'opened':item.share?'shared':'ready',date:item.share?.installedAt||item.share?.viewedAt||item.share?.createdAt||item.createdAt,url:'/family-esims.html'});
  }
  for(const trip of (user.familyTrips||[]).slice(0,30)) add({id:`trip:${trip.id}`,type:'trip',title:text(trip.name,100)||'Сімейна подорож',detail:text(trip.destination,100),status:new Date(`${trip.endDate}T23:59:59Z`)<new Date()?'completed':'planned',date:trip.updatedAt||trip.createdAt,url:'/family-trip.html'});
  return items.sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,120);
}

function notificationCenter(user = {}, tickets = [], announcements = []) {
  const items=[],readIds=new Set(Array.isArray(user.notificationCenter?.readIds)?user.notificationCenter.readIds:[]),card=walletCard(user),insights=usageInsights(user),nowMs=Date.now();
  const add=value=>{if(!value?.id)return;items.push({...value,read:readIds.has(value.id)});};
  for(const notice of announcements) add({id:`announcement:${notice.id}`,type:'announcement',priority:notice.type==='security'?'critical':notice.type==='maintenance'?'high':'normal',title:text(notice.title,100)||'Повідомлення Signal',message:text(notice.message,260),date:notice.startsAt||notice.createdAt||now(),url:'/dashboard.html'});
  for(const ticket of tickets){const reply=[...(ticket.messages||[])].reverse().find(message=>message.from==='admin');if(reply)add({id:`support:${ticket.id}:${reply.createdAt}`,type:'support',priority:'normal',title:`Нова відповідь у зверненні #${ticket.id}`,message:text(ticket.subject,180),date:reply.createdAt,url:`/ticket.html?id=${encodeURIComponent(ticket.id)}`});}
  if(insights.risk==='high')add({id:`usage:${String(insights.lastSyncAt||'current').slice(0,10)}:high`,type:'usage',priority:'high',title:'Інтернет може закінчитися скоро',message:insights.recommendation,date:insights.lastSyncAt||now(),url:'/usage.html'});
  if(card.daysUntilExpiry!=null&&card.daysUntilExpiry<=5)add({id:`expiry:${String(card.validUntil).slice(0,10)}`,type:'expiry',priority:card.daysUntilExpiry<=1?'high':'normal',title:card.daysUntilExpiry===0?'Термін eSIM завершується сьогодні':`До завершення eSIM ${card.daysUntilExpiry} дн.`,message:'Перевір залишок і підготуй наступний пакет без поспіху.',date:user.esim?.lastUpdateTime||user.updatedAt||now(),url:'/esim-management.html'});
  const smart=smartTripStatus(user);if(smart.tripStatus==='upcoming'&&smart.daysUntilTrip!=null&&smart.daysUntilTrip<=7)add({id:`trip-reminder:${user.travelMode?.startDate}:${smart.daysUntilTrip}`,type:'trip',priority:smart.daysUntilTrip<=1?'high':'normal',title:smart.title,message:smart.message,date:user.travelMode?.updatedAt||user.updatedAt||now(),url:smart.action.url});
  for(const purchase of (user.purchases||[]).filter(item=>item.fulfillmentStatus==='failed').slice(0,10))add({id:`purchase-failed:${purchase.id}`,type:'purchase',priority:'high',title:'Не вдалося підготувати eSIM',message:text(purchase.packageName||'Замовлення Signal',120),date:purchase.updatedAt||purchase.createdAt,url:'/payments.html'});
  for(const item of (user.sharedEsims||[]).filter(item=>item.share?.installedAt||item.share?.viewedAt).slice(0,20)){const installed=Boolean(item.share.installedAt),date=installed?item.share.installedAt:item.share.viewedAt;add({id:`family-${installed?'installed':'opened'}:${item.id}:${date}`,type:'family',priority:'normal',title:installed?'Близька людина встановила eSIM':'Посилання на eSIM відкрито',message:text(item.recipientName||item.packageName,100),date,url:'/family-esims.html'});}
  items.sort((a,b)=>(a.read===b.read?new Date(b.date)-new Date(a.date):a.read?1:-1));
  return {items:items.slice(0,80),unread:items.filter(item=>!item.read).length,generatedAt:new Date(nowMs).toISOString()};
}

function savingsSummary(user = {}, settings = {}) {
  const purchases=(user.purchases||[]).filter(item=>item.paymentStatus==='paid'||item.paidAt),referenceCentsPerGb=Math.max(100,Math.min(10000,Number(settings.roamingReferenceCentsPerGb)||1000));
  const paidCents=purchases.reduce((sum,item)=>sum+Math.max(0,Number(item.amountCents)||0),0),dataGb=purchases.reduce((sum,item)=>sum+Math.max(0,Number(item.dataLimitGb)||0),0),tripDays=purchases.reduce((sum,item)=>sum+Math.max(0,Number(item.durationDays)||0),0);
  const comparable=dataGb>0&&paidCents>0,referenceCents=comparable?Math.round(dataGb*referenceCentsPerGb):0,estimatedSavingsCents=comparable?Math.max(0,referenceCents-paidCents):0;
  return {currency:'USD',paidCents,referenceCents,estimatedSavingsCents,dataGb:+dataGb.toFixed(2),tripDays,purchaseCount:purchases.length,averageCentsPerGb:comparable?Math.round(paidCents/dataGb):null,referenceCentsPerGb,comparable,method:'Орієнтовне порівняння з умовною вартістю роумінгу за 1 ГБ. Фактична економія залежить від тарифу домашнього оператора.',updatedAt:purchases.map(item=>item.updatedAt||item.paidAt||item.createdAt).filter(Boolean).sort().at(-1)||user.updatedAt||null};
}

function profileOverview(user = {}, settings = {}) {
  const club=publicClub(user,settings),passport=passportFor(user),card=walletCard(user),smart=smartTripStatus(user),shared=user.sharedEsims||[],trips=user.familyTrips||[];
  return {identity:{displayName:text(user.displayName,80)||'Signal Traveler',email:text(user.email,254),avatarDataUrl:typeof user.avatarDataUrl==='string'&&user.avatarDataUrl.startsWith('data:image/')?user.avatarDataUrl:null,memberSince:user.createdAt||null},plan:{name:card.plan,status:card.status,validUntil:card.validUntil,remainingGb:card.remainingGb,dataStatus:card.dataStatus},stats:{points:club.points,tier:club.tier.name,countries:passport.length,familyEsims:shared.length,activeFamilyTrips:trips.filter(item=>!item.endDate||new Date(`${item.endDate}T23:59:59Z`).getTime()>=Date.now()).length},smart};
}

function familyCenter(user = {}) {
  const trips=user.familyTrips||[],esims=user.sharedEsims||[],nowMs=Date.now(),activeTrips=trips.filter(item=>!item.endDate||new Date(`${item.endDate}T23:59:59Z`).getTime()>=nowMs);
  return {summary:{totalEsims:esims.length,installed:esims.filter(item=>item.share?.installedAt||item.esim?.activateTime).length,shared:esims.filter(item=>item.share&&!item.share.revokedAt&&new Date(item.share.expiresAt).getTime()>nowMs).length,activeTrips:activeTrips.length},members:esims.map(item=>({id:item.id,name:text(item.recipientName,60)||'Близька людина',packageName:text(item.packageName,100)||'eSIM',destination:text(item.location,80)||null,status:item.share?.installedAt||item.esim?.activateTime?'installed':item.share?.viewedAt?'opened':item.share&&!item.share.revokedAt?'shared':'ready',updatedAt:item.share?.installedAt||item.share?.viewedAt||item.share?.createdAt||item.createdAt||null})),trips:activeTrips.map(item=>({id:item.id,name:item.name,destination:item.destination,startDate:item.startDate,endDate:item.endDate,members:item.members||[]}))};
}

function homeDeck(user = {}, settings = {}) {
  const card=walletCard(user),club=publicClub(user,settings),latest=(user.purchases||[]).find(item=>['provisioned','delivered'].includes(item.fulfillmentStatus))||(user.purchases||[])[0]||{};
  const monthly={basic:{title:'Базовий',dataLabel:'10 GB',totalGb:10,scene:'basic'},standard:{title:'Стандарт',dataLabel:'20 GB',totalGb:20,scene:'standard'},unlimited:{title:'Безліміт',dataLabel:'∞ GB',totalGb:null,scene:'unlimited'}};
  const rawPurchasePlan=String(latest.plan||'').toLowerCase(),rawUserPlan=String(user.plan||'').toLowerCase(),packageName=text(latest.packageName,100),purchaseLocation=text(latest.location,80),tripDestination=text(user.travelMode?.destination,80);
  const customPackage=rawPurchasePlan==='custom'||latest.kind==='custom_package'||latest.kind==='family_esim'||Boolean(latest.packageCode)||Boolean(purchaseLocation);
  let planKey=monthly[rawPurchasePlan]?rawPurchasePlan:monthly[rawUserPlan]?rawUserPlan:'';
  if(customPackage)planKey='';
  if(!customPackage&&card.totalGb!=null){
    if(Math.abs(card.totalGb-10)<.05)planKey='basic';
    else if(Math.abs(card.totalGb-20)<.05)planKey='standard';
    else if(planKey&&monthly[planKey].totalGb!==card.totalGb)planKey='';
  }
  if(!customPackage&&card.totalGb==null&&planKey!=='unlimited')planKey='unlimited';
  const isMonthly=Boolean(monthly[planKey]),destination=purchaseLocation||tripDestination,volumeLabel=card.totalGb==null?'Безліміт':`${Number(card.totalGb).toLocaleString('uk-UA',{maximumFractionDigits:2})} GB`;
  const activeTitle=isMonthly?monthly[planKey].title:packageName||[destination,volumeLabel].filter(Boolean).join(' · ')||text(card.plan,100)||'Твоя eSIM',scene=isMonthly?monthly[planKey].scene:destination?'travel':'unlimited';
  const daysLabel=card.daysUntilExpiry==null?'Без обмеження строку':card.daysUntilExpiry===0?'Завершується сьогодні':card.daysUntilExpiry===1?'1 день залишився':`${card.daysUntilExpiry} дн. залишилось`;
  const cards=[],seen=new Set();
  for(const purchase of (user.purchases||[])){
    if(purchase.kind==='mobile_topup'||seen.has(purchase.id))continue;seen.add(purchase.id);
    const key=String(purchase.plan||'').toLowerCase(),preset=monthly[key],location=text(purchase.location,80),title=preset?.title||location||text(purchase.packageName,80)||'Travel eSIM';
    cards.push({id:text(purchase.id,100),title,dataLabel:preset?.dataLabel||(purchase.dataLimitGb==null?'∞ GB':`${Number(purchase.dataLimitGb).toLocaleString('uk-UA',{maximumFractionDigits:2})} GB`),scene:preset?.scene||(location?'travel':'standard'),status:['provisioned','delivered'].includes(purchase.fulfillmentStatus)?'ready':purchase.fulfillmentStatus==='failed'?'attention':purchase.paymentStatus==='paid'?'preparing':'ordered',createdAt:purchase.fulfilledAt||purchase.paidAt||purchase.createdAt||null});
    if(cards.length>=6)break;
  }
  const availableRewards=club.rewards.filter(item=>item.status==='available'&&(!item.expiresAt||new Date(item.expiresAt)>new Date())),nextReward=club.rewardsCatalog.filter(item=>item.points>club.points).sort((a,b)=>a.points-b.points)[0]||null,redeemable=club.rewardsCatalog.filter(item=>item.points<=club.points).sort((a,b)=>b.points-a.points)[0]||null;
  const remainingPercent=card.totalGb!=null&&card.totalGb>0?Math.min(100,Math.max(0,(card.remainingGb||0)/card.totalGb*100)):100;
  return {identity:{displayName:text(user.displayName,80)||'Signal Traveler'},active:{title:activeTitle,planKey:isMonthly?planKey:'travel',scene,dataLabel:card.remainingGb==null?'∞ GB':`${Number(card.remainingGb).toLocaleString('uk-UA',{maximumFractionDigits:2})} GB`,usedLabel:card.usedGb==null?'Не визначено':`${Number(card.usedGb).toLocaleString('uk-UA',{maximumFractionDigits:2})} GB`,totalLabel:card.totalGb==null?'Безлімітний інтернет':`${Number(card.totalGb).toLocaleString('uk-UA',{maximumFractionDigits:2})} GB`,daysLabel,status:card.status,dataStatus:card.dataStatus,usagePercent:card.usagePercent,remainingPercent:+remainingPercent.toFixed(1),validUntil:card.validUntil,lastSyncAt:card.lastSyncAt,networkLabel:text(user.esim?.apn||user.esim?.network||user.esim?.operator,80)||'Мобільна мережа',networkType:text(user.esim?.networkType||user.esim?.radioType,20)||'4G/5G',destination:destination||null},cards,tiers:[{key:'basic',title:'Базовий',dataLabel:'10 GB',priceLabel:'$9.99',scene:'basic',note:'Для легких подорожей'},{key:'standard',title:'Стандарт',dataLabel:'20 GB',priceLabel:'$19.99',scene:'standard',note:'Для активних мандрівників'},{key:'unlimited',title:'Безліміт',dataLabel:'∞ GB',priceLabel:'$34.99',scene:'unlimited',note:'Для безмежних можливостей'}],reward:{points:club.points,tier:club.tier,availableCount:availableRewards.length,redeemable:redeemable?{id:redeemable.id,name:redeemable.name,points:redeemable.points}:null,next:nextReward?{id:nextReward.id,name:nextReward.name,points:nextReward.points,pointsNeeded:Math.max(0,nextReward.points-club.points)}:null}};
}

module.exports={ id, passportFor, loyaltyFor, publicClub, awardPurchase, redeem, usageInsights, safeFamilyTrip, safeRescueDiagnostics, walletCard, smartTripStatus, activityFeed, notificationCenter, savingsSummary, profileOverview, familyCenter, homeDeck };
