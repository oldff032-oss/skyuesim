const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engagement = require('../engagementService');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('Signal Passport derives one safe stamp per fulfilled purchase without activation secrets',()=>{
  const stamps=engagement.passportFor({purchases:[{id:'cs_paid',location:'Poland',packageName:'Poland 10 GB',fulfillmentStatus:'provisioned',activationCode:'LPA:SECRET',iccid:'123456'}]});
  assert.equal(stamps.length,1);
  assert.equal(stamps[0].countryCode,'PL');
  assert.equal(stamps[0].flag,'🇵🇱');
  assert.equal('activationCode' in stamps[0],false);
  assert.equal('iccid' in stamps[0],false);
});

test('Signal Club purchase awards are idempotent and redemption cannot overdraw points',()=>{
  const purchase={id:'cs_once',packageName:'Italy',amountCents:1100,fulfillmentStatus:'provisioned'};
  const first=engagement.awardPurchase({},purchase,{pointsPerDollar:10,stampBonus:50});
  assert.equal(first.awarded,160);
  const second=engagement.awardPurchase({loyalty:first.loyalty},purchase,{pointsPerDollar:10,stampBonus:50});
  assert.equal(second.awarded,0);
  assert.throws(()=>engagement.redeem({loyalty:first.loyalty},'discount_2',{}),/недостатньо/);
});

test('redeemed discount is server-applied, reserved per Stripe session, and consumed only after paid webhook',()=>{
  const server=read('server.js'),stripe=read('stripeService.js');
  assert.match(server,/const checkoutAmountCents=selected\.amountCents-discountCents/);
  assert.match(server,/status:'reserved'.*stripeSessionId:session\.id/);
  assert.match(server,/item\.id===rewardId&&item\.stripeSessionId===session\.id/);
  assert.match(server,/status:'used'.*purchaseId:session\.id/);
  assert.match(stripe,/rewardId:String\(rewardId\|\|''\)/);
});

test('usage insights use daily deltas and never promise silent payment',()=>{
  const insights=engagement.usageInsights({esim:{remainingGb:1,usageHistory:[{day:'2026-08-20',usedBytes:0},{day:'2026-08-21',usedBytes:512*1024*1024},{day:'2026-08-22',usedBytes:1024*1024*1024}]}});
  assert.equal(insights.dailyAverageGb,0.5);
  assert.equal(insights.projectedDaysLeft,2);
  assert.equal(insights.risk,'high');
  assert.match(read('smart-assist.html'),/Жодного списання без твоєї явної згоди/);
});

test('new customer experiences are authenticated and cached as one mobile shell',()=>{
  const server=read('server.js'),worker=read('sw.js'),css=read('experience.css');
  for(const route of ['/api/account/passport','/api/account/club','/api/account/usage-insights','/api/account/family-trips','/api/account/wallet-pass','/api/account/rescue'])assert.match(server,new RegExp(route.replaceAll('/','\\/').replace('-','\\-')+'.*requireUserSession'));
  for(const page of ['signal-universe.html','signal-passport.html','signal-club.html','smart-assist.html','family-trip.html','wallet-pass.html','rescue-mode.html'])assert.match(worker,new RegExp(page.replace('.','\\.')));
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/overflow-x:hidden/);
});

test('admin rewards and rescue decisions require Super Admin two-factor gates',()=>{
  const server=read('server.js'),nav=read('admin-common.js');
  assert.match(server,/\/api\/admin\/engagement\/:email\/points'.*requireRole\('super_admin'\).*requirePermission\('refunds\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(server,/\/api\/admin\/rescue-requests\/:id\/resolve'.*requireRole\('super_admin'\).*requirePermission\('refunds\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(nav,/admin-engagement\.html/);
  assert.match(nav,/admin-rescue\.html/);
});

test('Wallet public card contains no eSIM activation credential fields',()=>{
  const card=engagement.walletCard({email:'x@example.com',displayName:'Traveler',esim:{activationCode:'LPA:SECRET',qrCodeUrl:'https://secret.invalid/qr',iccid:'89420000123',pin:'0000',usedBytes:5*1024**3,totalBytes:20*1024**3,lastUpdateTime:'2026-08-29T10:00:00.000Z'},travelMode:{destination:'Italy',startDate:'2026-09-10',endDate:'2026-09-17'},purchases:[{fulfillmentStatus:'provisioned',packageName:'Global'}]});
  for(const key of ['serial','holder','plan','destination','validUntil','status','usedGb','totalGb','remainingGb','usagePercent','dataStatus','esimReadiness','tripStartDate','tripEndDate','daysUntilTrip','tripStatus','daysUntilExpiry','lastSyncAt','familyReady','familyTotal'])assert.ok(key in card,key);
  assert.equal(card.usedGb,5);
  assert.equal(card.totalGb,20);
  assert.equal(card.remainingGb,15);
  assert.equal(card.usagePercent,25);
  for(const secret of ['activationCode','qrCodeUrl','iccid','pin','email'])assert.equal(secret in card,false);
  assert.doesNotMatch(JSON.stringify(card),/LPA:SECRET|secret\.invalid|89420000123|0000|x@example\.com/);
});
