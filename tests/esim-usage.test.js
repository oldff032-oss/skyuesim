const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.ESIM_MOCK_MODE = 'false';
process.env.ESIM_PROVIDER_API_KEY = 'test-access-code';
process.env.ESIM_PROVIDER_API_URL = 'https://provider.test';

const service = require('../esimService');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const response = payload => new Response(JSON.stringify(payload), { status:200, headers:{ 'content-type':'application/json' } });

test('usage query follows the exact stored eSIM instead of the first profile in an order', async t => {
  const originalFetch=global.fetch,calls=[];
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async (url,options={})=>{
    calls.push({url:String(url),body:JSON.parse(options.body||'{}')});
    return response({success:true,obj:{esimList:[
      {orderNo:'ORDER-1',esimTranNo:'TRAN-OLD',iccid:'8943000000000000001',orderUsage:0,totalVolume:10737418240},
      {orderNo:'ORDER-1',esimTranNo:'TRAN-LIVE',iccid:'8943000000000000002',orderUsage:5368709120,totalVolume:10737418240,esimStatus:'IN_USE',lastUpdateTime:'2026-09-18T10:00:00Z'},
    ]}});
  };
  const usage=await service.checkUsage({orderNo:'ORDER-1',esimTranNo:'TRAN-LIVE',iccid:'8943000000000000002'});
  assert.equal(calls[0].body.iccid,'8943000000000000002');
  assert.equal(calls.length,1);
  assert.equal(usage.usedBytes,5368709120);
  assert.equal(usage.totalBytes,10737418240);
  assert.equal(usage.source,'profile_api');
  assert.equal(usage.stale,false);
  assert.equal(usage.providerUpdatedAt,'2026-09-18T10:00:00Z');
});

test('official ICCID profile is the only usage source and is not mixed with another endpoint', async t => {
  const originalFetch=global.fetch,calls=[];
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async (url,options={})=>{
    calls.push({url:String(url),body:JSON.parse(options.body||'{}')});
    return response({success:true,obj:{esimList:[{orderNo:'ORDER-2',esimTranNo:'TRAN-2',iccid:'8943000000000000003',orderUsage:3221225472,totalVolume:10737418240,esimStatus:'IN_USE'}]}});
  };
  const usage=await service.checkUsage({orderNo:'ORDER-2',esimTranNo:'TRAN-2',iccid:'8943000000000000003'});
  assert.equal(usage.usedBytes,3221225472);
  assert.equal(usage.source,'profile_api');
  assert.equal(usage.live,true);
  assert.equal(usage.stale,false);
  assert.equal(calls.length,1);
});

test('usage parser accepts live and nested provider counters instead of treating orderUsage zero as authoritative', async t => {
  const originalFetch=global.fetch;
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async()=>response({success:true,obj:{esimList:[{orderNo:'ORDER-FIELDS',esimTranNo:'TRAN-FIELDS',iccid:'8943000000000000008',orderUsage:0,totalVolume:20*1024**3,packageList:[{volume:20*1024**3,dataUsage:3*1024**3}],esimStatus:'IN_USE',lastDataUsageUpdateTime:'2026-09-21T09:00:00Z'}]}});
  const usage=await service.checkUsage({orderNo:'ORDER-FIELDS',esimTranNo:'TRAN-FIELDS',iccid:'8943000000000000008'});
  assert.equal(usage.usedBytes,3*1024**3);
  assert.equal(usage.totalBytes,20*1024**3);
  assert.equal(usage.counterSource,'package.used');
  assert.equal(usage.hasUsageTimestamp,true);
});

test('profile share URL supplies the live counter when the allocated-profile counter stays at zero', async t => {
  const originalFetch=global.fetch,calls=[];
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async url=>{
    calls.push(String(url));
    if(calls.length===1)return response({success:true,obj:{esimList:[{orderNo:'ORDER-SHARE',esimTranNo:'TRAN-SHARE',iccid:'8943000000000000009',orderUsage:0,totalVolume:20*1024**3,shortUrl:'https://p.qrsim.net/0123456789abcdef0123456789abcdef',esimStatus:'IN_USE'}]}});
    if(calls.length===2)return new Response('<input value="https://api.esimaccess.com/api/v1/h5/share/order/queryUsage?token=safe%2Btoken" id="queryUsageAPI">',{status:200,headers:{'content-type':'text/html'}});
    return response({success:true,obj:{iccid:'8943000000000000009',totalVolume:20*1024**3,dataUsage:4*1024**3,expiredTime:'2027-01-01T00:00:00Z'}});
  };
  const usage=await service.checkUsage({orderNo:'ORDER-SHARE',esimTranNo:'TRAN-SHARE',iccid:'8943000000000000009'});
  assert.equal(calls.length,3);
  assert.equal(usage.usedBytes,4*1024**3);
  assert.equal(usage.totalBytes,20*1024**3);
  assert.equal(usage.source,'share_usage_api');
  assert.equal(usage.counterSource,'share.dataUsage');
});

test('legacy reseller accounts fall back to the compatible query route when list returns 404', async t => {
  const originalFetch=global.fetch,calls=[];
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async (url,options={})=>{
    calls.push({url:String(url),body:JSON.parse(options.body||'{}')});
    if(calls.length===1)return new Response(JSON.stringify({success:false,errorCode:'404',errorMsg:'path: /api/v1/open/esim/list'}),{status:404,headers:{'content-type':'application/json'}});
    return response({success:true,obj:{esimList:[{orderNo:'ORDER-LEGACY',esimTranNo:'TRAN-LEGACY',iccid:'8943000000000000007',orderUsage:7441033216,totalVolume:42949672960,esimStatus:'IN_USE'}]}});
  };
  const usage=await service.checkUsage({orderNo:'ORDER-LEGACY',esimTranNo:'TRAN-LEGACY',iccid:'8943000000000000007'});
  assert.equal(calls.length,2);
  assert.match(calls[0].url,/\/api\/v1\/open\/esim\/list$/);
  assert.match(calls[1].url,/\/api\/v1\/open\/esim\/query$/);
  assert.equal(calls[1].body.iccid,'8943000000000000007');
  assert.equal(usage.usedBytes,7441033216);
  assert.equal(usage.totalBytes,42949672960);
  assert.equal(usage.source,'profile_api');
});

test('usage lookup rejects a response that does not contain the requested ICCID', async t => {
  const originalFetch=global.fetch;
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async()=>response({success:true,obj:{esimList:[{orderNo:'OTHER',esimTranNo:'OTHER',iccid:'8943000000000099999',orderUsage:1,totalVolume:2}]}});
  await assert.rejects(()=>service.checkUsage({orderNo:'ORDER-3',esimTranNo:'TRAN-3',iccid:'8943000000000000006'}),error=>error.code==='PROFILE_NOT_FOUND');
});

test('failed provider lookups are marked stale and never erase cached usage', () => {
  const server=read('server.js'),provider=read('esimService.js');
  assert.match(provider,/No exact eSIM profile found/);
  assert.match(server,/providerTotalRegressed/);
  assert.match(server,/counterStale\?cached\.usedBytes/);
});

test('top-up accounting adds the new allowance to the existing profile when provider response only echoes the added volume', () => {
  const server=read('server.js'),helper=server.slice(server.indexOf('function cachedEsimUsage'),server.indexOf('async function syncEsimUsageForUser'));
  const context={};
  vm.runInNewContext(`${helper}\nthis.mergeTopupUsage=mergeTopupUsage;`,context);
  const result=context.mergeTopupUsage({totalBytes:20*1024**3,usedBytes:7*1024**3,remainingBytes:13*1024**3},{transactionId:'TOPUP-1',totalGb:20,usedGb:0,remainingGb:20},{packageCode:'EU20',dataLimitGb:20,unlimited:false},'2026-09-18T12:00:00Z');
  assert.equal(result.totalBytes,40*1024**3);
  assert.equal(result.usedBytes,7*1024**3);
  assert.equal(result.remainingBytes,33*1024**3);
  assert.equal(result.usageStale,true);
  assert.equal(result.pendingTopupConfirmation.expectedMinimumTotalBytes,40*1024**3);
});

test('top-up and later sync never reset consumed traffic to zero on the same ICCID', () => {
  const server=read('server.js'),helper=server.slice(server.indexOf('function cachedEsimUsage'),server.indexOf('async function syncEsimUsageForUser'));
  const context={};
  vm.runInNewContext(`${helper}\nthis.mergeTopupUsage=mergeTopupUsage;`,context);
  const result=context.mergeTopupUsage({totalBytes:20*1024**3,usedBytes:7*1024**3,remainingBytes:13*1024**3},{transactionId:'TOPUP-2',totalGb:40,usedGb:0,remainingGb:40},{packageCode:'EU20',dataLimitGb:20,unlimited:false},'2026-09-21T12:00:00Z');
  assert.equal(result.totalBytes,40*1024**3);
  assert.equal(result.usedBytes,7*1024**3);
  assert.equal(result.remainingBytes,33*1024**3);
});

test('provider USED_UP and EXPIRED states override delayed gigabyte counters', async () => {
  const server=read('server.js'),helper=server.slice(server.indexOf('function cachedEsimUsage'),server.indexOf('const SUPPORT_MAX_FILES'));
  const users={
    'used@example.com':{status:'active',esim:{orderNo:'ORDER-U',esimTranNo:'TRAN-U',iccid:'8943000000000000004',usedBytes:14*1024**3,totalBytes:20*1024**3,remainingBytes:6*1024**3,status:'active',esimStatus:'IN_USE'}},
    'expired@example.com':{status:'active',esim:{orderNo:'ORDER-E',esimTranNo:'TRAN-E',iccid:'8943000000000000005',usedBytes:7*1024**3,totalBytes:20*1024**3,remainingBytes:13*1024**3,status:'active',esimStatus:'IN_USE'}},
  };
  const context={
    getUser:email=>users[email],
    saveUser:(email,patch)=>{users[email]={...users[email],...patch};return users[email]},
    refreshGoogleWallet:()=>{},
    checkSupportLinkUsage:async()=>{throw new Error('not used')},
    persistSupportLinkUsage:()=>{throw new Error('not used')},
    checkUsage:async identifiers=>({usedBytes:(identifiers.orderNo==='ORDER-U'?14:7)*1024**3,totalBytes:20*1024**3,esimStatus:identifiers.orderNo==='ORDER-U'?'USED_UP':'IN_USE',expiredTime:identifiers.orderNo==='ORDER-U'?null:'2020-01-01T00:00:00Z',source:'profile_api',stale:false,live:true,syncedAt:'2026-09-18T12:00:00Z'}),
  };
  vm.runInNewContext(`${helper}\nthis.syncEsimUsageForUser=syncEsimUsageForUser;`,context);
  const used=await context.syncEsimUsageForUser('used@example.com',{force:true});
  assert.equal(used.usedBytes,20*1024**3);
  assert.equal(used.remainingBytes,0);
  assert.equal(used.serviceEndedReason,'used_up');
  assert.equal(users['used@example.com'].esim.status,'used_up');
  const expired=await context.syncEsimUsageForUser('expired@example.com',{force:true});
  assert.equal(expired.usedBytes,7*1024**3);
  assert.equal(expired.remainingBytes,0);
  assert.equal(expired.serviceEndedReason,'expired');
  assert.equal(users['expired@example.com'].esim.status,'expired');
});

test('traffic refresh is scheduled every 30 minutes and both interfaces expose freshness', () => {
  const server=read('server.js'),usage=read('usage.html'),admin=read('admin-client.html'),dashboard=read('dashboard.html');
  assert.match(server,/const ESIM_USAGE_SYNC_INTERVAL_MS=30\*60\*1000/);
  assert.match(server,/setInterval\(\(\)=>syncAllActiveEsimUsage\(\)/);
  assert.match(server,/lastProviderUsageAt/);
  assert.match(server,/usageStale/);
  assert.match(usage,/Автоматична перевірка: кожні 30 хвилин/);
  assert.match(usage,/setInterval\(load,30\*60\*1000\)/);
  assert.match(admin,/refreshClientUsage\(\)/);
  assert.match(admin,/Оператор ще не підтвердив свіжі дані/);
  assert.match(admin,/traffic-summary/);
  assert.match(admin,/setInterval\(\(\)=>\{if\(document\.visibilityState==='visible'/);
  assert.match(dashboard,/await fetch\(`\$\{API_URL\}\/api\/usage/);
});
