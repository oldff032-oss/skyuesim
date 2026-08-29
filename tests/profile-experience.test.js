const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const engagement=require('../engagementService');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const sampleUser={email:'traveler@example.com',displayName:'Traveler',createdAt:'2026-01-01T00:00:00.000Z',status:'active',plan:'travel',stripeCustomerId:'cus_secret',esim:{orderNo:'order-secret',iccid:'iccid-secret',activationCode:'LPA:secret',qrCodeUrl:'https://secret.invalid/qr',status:'active',dataLimitGb:10,usedGb:7.5,remainingGb:2.5,expiredTime:'2026-09-20T00:00:00.000Z',lastUpdateTime:'2026-08-29T00:00:00.000Z'},purchases:[{id:'purchase_1',packageName:'Italy 10 GB',location:'Italy',dataLimitGb:10,durationDays:30,amountCents:1100,paymentStatus:'paid',fulfillmentStatus:'provisioned',createdAt:'2026-08-20T00:00:00.000Z'}],sharedEsims:[{id:'family_1',recipientName:'Anna',packageName:'Italy 5 GB',location:'Italy',createdAt:'2026-08-22T00:00:00.000Z',esim:{activationCode:'family-secret',iccid:'family-iccid'},share:{expiresAt:'2099-01-01T00:00:00.000Z',viewedAt:'2026-08-23T00:00:00.000Z'}}],travelMode:{destination:'Rome',startDate:'2026-09-10',endDate:'2026-09-18'},loyalty:{points:250,lifetimePoints:750,ledger:[]}};

test('new customer experience derives useful data without exposing eSIM or payment secrets',()=>{
  const payload={profile:engagement.profileOverview(sampleUser,{}),activity:engagement.activityFeed(sampleUser,[]),notifications:engagement.notificationCenter(sampleUser,[],[]),savings:engagement.savingsSummary(sampleUser,{}),family:engagement.familyCenter(sampleUser)};
  const encoded=JSON.stringify(payload);
  for(const secret of ['order-secret','iccid-secret','LPA:secret','cus_secret','family-secret','family-iccid'])assert.doesNotMatch(encoded,new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(payload.savings.estimatedSavingsCents,8900);
  assert.equal(payload.family.summary.totalEsims,1);
  assert.equal(payload.profile.stats.points,250);
});

test('notification ids are stable and persisted read ids change unread count',()=>{
  const notice={id:'notice_1',title:'Технічні роботи',message:'Коротке оновлення',startsAt:'2026-08-29T10:00:00.000Z'};
  const first=engagement.notificationCenter(sampleUser,[],[notice]);
  const id=first.items.find(item=>item.type==='announcement').id;
  const second=engagement.notificationCenter({...sampleUser,notificationCenter:{readIds:[id]}},[],[notice]);
  assert.equal(second.items.find(item=>item.id===id).read,true);
  assert.equal(second.unread,first.unread-1);
});

test('profile, notifications, activity, savings and family endpoints require a customer session',()=>{
  const server=read('server.js');
  for(const route of ['profile-overview','smart-trip-status','activity','savings','family-center','notifications'])assert.match(server,new RegExp(`app\\.get\\('\\/api\\/account\\/${route}',requireUserSession`));
  assert.match(server,/app\.post\('\/api\/account\/notifications\/read-all',requireUserSession/);
  assert.match(server,/app\.post\('\/api\/account\/notifications\/:id\/read',requireUserSession/);
});

test('profile 2.0 and its mobile centers are connected and cacheable offline',()=>{
  const profile=read('profile.html'),worker=read('sw.js'),dashboard=read('dashboard.html');
  for(const page of ['notifications.html','activity.html','savings.html','family-center.html']){assert.match(profile,new RegExp(page.replace('.','\\.')));assert.match(worker,new RegExp(page.replace('.','\\.')));assert.match(read(page),/viewport-fit=cover/);}
  assert.match(dashboard,/smart-trip-status/);
  assert.match(dashboard,/href="notifications\.html"/);
  assert.match(read('family-trip.html'),/data-member/);
  assert.match(read('family-trip.html'),/Додати близьку людину/);
});

test('savings is explicitly estimated instead of promising an exact roaming saving',()=>{
  const data=engagement.savingsSummary(sampleUser,{});
  assert.match(data.method,/Орієнтовне/);
  assert.equal(data.referenceCentsPerGb,1000);
  assert.match(read('savings.html'),/ОРІЄНТОВНА ВИГОДА/);
});
