const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const wallet = require('../googleWalletService');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('Google Wallet stays disabled until all protected issuer credentials exist',()=>{
  const result=wallet.createSaveLink({serial:'signal-test'},{FRONTEND_URL:'https://esimsignalapp.com'});
  assert.equal(result.configured,false);
  assert.equal(result.status,'setup_required');
  assert.deepEqual(result.missing,['GOOGLE_WALLET_ISSUER_ID','GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL','GOOGLE_WALLET_PRIVATE_KEY']);
});

test('Google Wallet creates a short-lived signed personal pass without eSIM secrets',()=>{
  const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const env={
    FRONTEND_URL:'https://esimsignalapp.com',
    GOOGLE_WALLET_ISSUER_ID:'1234567890',
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL:'wallet@signal-test.iam.gserviceaccount.com',
    GOOGLE_WALLET_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'}),
  };
  const result=wallet.createSaveLink({serial:'signal-safe123',holder:'Traveler',plan:'Europe 20 GB',destination:'Italy',validUntil:'2026-09-30T00:00:00.000Z',activationCode:'LPA:SECRET',iccid:'8942',pin:'0000'},env);
  assert.equal(result.configured,true);
  assert.equal(result.status,'ready');
  assert.match(result.url,/^https:\/\/pay\.google\.com\/gp\/v\/save\//);
  const token=result.url.split('/').pop(),parts=token.split('.');
  assert.equal(parts.length,3);
  const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  assert.equal(payload.iss,env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL);
  assert.equal(payload.aud,'google');
  assert.equal(payload.typ,'savetowallet');
  assert.ok(payload.exp-payload.iat<=600);
  assert.ok(result.url.length<1800);
  assert.equal(payload.payload.genericObjects[0].id,'1234567890.signal-safe123');
  assert.equal(payload.payload.genericObjects[0].classId,'1234567890.signal_travel_pass');
  assert.doesNotMatch(JSON.stringify(payload),/LPA:SECRET|8942|activationCode|qrCodeUrl|iccid|pin|@example\.com/i);
});

test('Google Wallet exposes live travel status and safe built-in reminders',()=>{
  const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const env={FRONTEND_URL:'https://esimsignalapp.com',GOOGLE_WALLET_ISSUER_ID:'3388000000023179296',GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL:'wallet@signal-test.iam.gserviceaccount.com',GOOGLE_WALLET_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})};
  const resources=wallet.passResources({serial:'signal-live',plan:'Europe 20 GB',destination:'Italy',status:'active',remainingGb:13.04,usedGb:6.96,totalGb:20,usagePercent:34.8,dataStatus:'healthy',esimReadiness:'ready',tripStartDate:'2026-09-10',tripEndDate:'2026-09-17',daysUntilTrip:12,tripStatus:'upcoming',validUntil:'2026-09-30T23:59:59.000Z',daysUntilExpiry:32,lastSyncAt:'2026-08-29T10:00:00.000Z',familyReady:2,familyTotal:3},env);
  const object=resources.genericObject,modules=Object.fromEntries(object.textModulesData.map(item=>[item.id,item]));
  assert.equal(resources.genericClass.multipleDevicesAndHoldersAllowedStatus,'ONE_USER_ALL_DEVICES');
  assert.match(object.header.defaultValue.value,/13,04 GB/);
  for(const id of ['readiness','usage','data_state','plan','destination','trip','validity','sync','family'])assert.ok(modules[id],id);
  assert.match(modules.readiness.body,/готова до поїздки/);
  assert.match(modules.usage.body,/6,96 із 20 GB/);
  assert.deepEqual(object.notifications,{expiryNotification:{enableNotification:true}});
  assert.equal(object.messages[0].messageType,'TEXT');
  assert.ok(object.linksModuleData.uris.some(item=>item.uri.endsWith('/usage.html')));
  assert.ok(object.linksModuleData.uris.some(item=>item.uri.endsWith('/travel-assistant.html')));
  assert.doesNotMatch(JSON.stringify(object),/activationCode|qrCodeUrl|iccid|pin|privateKey|@example\.com/i);
});

test('Google Wallet pre-creates the class and personal object through the protected API',async()=>{
  const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const env={FRONTEND_URL:'https://esimsignalapp.com',GOOGLE_WALLET_ISSUER_ID:'987654321',GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL:'wallet@signal-test.iam.gserviceaccount.com',GOOGLE_WALLET_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})};
  const resources=wallet.passResources({serial:'signal-object',holder:'Traveler',plan:'Global'},env),calls=[];
  const responses=[
    {ok:true,status:200,json:async()=>({access_token:'test-token',expires_in:3600})},
    {ok:false,status:404,json:async()=>({})},
    {ok:true,status:200,json:async()=>({})},
    {ok:false,status:404,json:async()=>({})},
    {ok:true,status:200,json:async()=>({})},
  ];
  const fakeFetch=async(url,options={})=>{calls.push({url:String(url),options});return responses.shift();};
  const synced=await wallet.syncPass(resources,fakeFetch);
  assert.equal(synced.objectId,'987654321.signal-object');
  assert.equal(calls[0].url,'https://oauth2.googleapis.com/token');
  assert.match(calls[1].url,/genericClass\/987654321\.signal_travel_pass$/);
  assert.equal(calls[2].options.method,'POST');
  assert.match(calls[3].url,/genericObject\/987654321\.signal-object$/);
  assert.equal(calls[4].options.method,'POST');
  assert.equal(calls[4].options.headers.Authorization,'Bearer test-token');
});

test('Google Wallet never replaces an existing shared class while refreshing one user object',async()=>{
  const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const env={FRONTEND_URL:'https://esimsignalapp.com',GOOGLE_WALLET_ISSUER_ID:'987654321',GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL:'wallet@signal-test.iam.gserviceaccount.com',GOOGLE_WALLET_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})};
  const resources=wallet.passResources({serial:'signal-existing',remainingGb:9,esimReadiness:'ready'},env),calls=[];
  const responses=[
    {ok:true,status:200,json:async()=>({access_token:'test-token',expires_in:3600})},
    {ok:true,status:200,json:async()=>({id:resources.config.classId})},
    {ok:true,status:200,json:async()=>({id:resources.objectId})},
    {ok:true,status:200,json:async()=>({id:resources.objectId})},
  ];
  const fakeFetch=async(url,options={})=>{calls.push({url:String(url),options});return responses.shift();};
  await wallet.syncPass(resources,fakeFetch);
  assert.equal(calls.filter(call=>call.url.includes('/genericClass/')).length,1);
  assert.equal(calls.some(call=>call.url.includes('/genericClass/')&&call.options.method==='PUT'),false);
  assert.equal(calls.at(-1).options.method,'PUT');
  assert.match(calls.at(-1).url,/genericObject\/987654321\.signal-existing$/);
});

test('Wallet endpoint generates Google links on the server and frontend shows a setup state safely',()=>{
  const server=read('server.js'),page=read('wallet-pass.html'),service=read('googleWalletService.js');
  assert.match(server,/googleWallet\.createPass\(card\)/);
  assert.match(server,/function refreshGoogleWallet\(email\)/);
  assert.match(server,/saveUser\(req\.userEmail,\{travelMode\}\);\s*refreshGoogleWallet\(req\.userEmail\)/);
  assert.match(server,/usageHistory,[\s\S]{0,120}\}\s*,\s*\}\);\s*refreshGoogleWallet\(email\)/);
  assert.doesNotMatch(server,/GOOGLE_WALLET_SAVE_URL/);
  assert.match(service,/crypto\.sign\('RSA-SHA256'/);
  assert.match(service,/payload:\{genericObjects:\[\{id:resources\.objectId,classId:resources\.config\.classId\}\]\}/);
  assert.match(service,/walletobjects\.googleapis\.com\/walletobjects\/v1/);
  assert.match(service,/\/help\.html/);
  assert.match(read('help.html'),/support@esimsignalapp\.com/);
  assert.match(page,/class="xp-google-btn"/);
  assert.match(page,/Оновити статус картки/);
  assert.match(page,/GB залишилось/);
  assert.match(page,/Google Wallet ще не синхронізовано/);
  assert.doesNotMatch(page,/GOOGLE_WALLET_PRIVATE_KEY|GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL/);
});
