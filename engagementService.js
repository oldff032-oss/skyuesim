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

module.exports={ id, passportFor, loyaltyFor, publicClub, awardPurchase, redeem, usageInsights, safeFamilyTrip, safeRescueDiagnostics, walletCard };
