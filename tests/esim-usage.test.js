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
    if(calls.length===1)return response({success:true,obj:{esimList:[
      {orderNo:'ORDER-1',esimTranNo:'TRAN-OLD',iccid:'8943000000000000001',orderUsage:0,totalVolume:10737418240},
      {orderNo:'ORDER-1',esimTranNo:'TRAN-LIVE',iccid:'8943000000000000002',orderUsage:0,totalVolume:10737418240,esimStatus:'IN_USE'},
    ]}});
    return response({success:true,obj:[{esimTranNo:'TRAN-LIVE',iccid:'8943000000000000002',dataUsage:5368709120,totalData:10737418240,lastUpdateTime:'2026-09-18T10:00:00Z'}]});
  };
  const usage=await service.checkUsage({orderNo:'ORDER-1',esimTranNo:'TRAN-LIVE',iccid:'8943000000000000002'});
  assert.equal(calls[0].body.iccid,'8943000000000000002');
  assert.deepEqual(calls[1].body.esimTranNoList,['TRAN-LIVE']);
  assert.equal(usage.usedBytes,5368709120);
  assert.equal(usage.totalBytes,10737418240);
  assert.equal(usage.source,'usage_api');
  assert.equal(usage.stale,false);
  assert.equal(usage.providerUpdatedAt,'2026-09-18T10:00:00Z');
});

test('official ICCID profile usage remains valid when the detailed usage endpoint is unavailable', async t => {
  const originalFetch=global.fetch,calls=[];
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async (url,options={})=>{
    calls.push({url:String(url),body:JSON.parse(options.body||'{}')});
    if(calls.length===1)return response({success:true,obj:{esimList:[{orderNo:'ORDER-2',esimTranNo:'TRAN-2',iccid:'8943000000000000003',orderUsage:3221225472,totalVolume:10737418240,esimStatus:'IN_USE'}]}});
    return response({success:false,errorCode:'310272',errorMsg:'usage temporarily unavailable'});
  };
  const usage=await service.checkUsage({orderNo:'ORDER-2',esimTranNo:'TRAN-2',iccid:'8943000000000000003'});
  assert.equal(usage.usedBytes,3221225472);
  assert.equal(usage.source,'profile_api');
  assert.equal(usage.live,true);
  assert.equal(usage.stale,false);
});

test('failed provider lookups are marked stale and never erase cached usage', () => {
  const server=read('server.js'),provider=read('esimService.js');
  assert.match(provider,/source:'profile_fallback', live:false, stale:true/);
  assert.match(server,/usage\.stale\?\(candidateUsed==null\?cached\.usedBytes:Math\.max\(cached\.usedBytes,candidateUsed\)\)/);
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
  assert.match(dashboard,/await fetch\(`\$\{API_URL\}\/api\/usage/);
});
