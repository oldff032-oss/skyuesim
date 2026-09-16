const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const inventory = require('../esimInventoryService');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('eSIM lifecycle distinguishes reusable profiles from installed profiles', () => {
  assert.equal(inventory.profileState({smdpStatus:'RELEASED',esimStatus:'GOT_RESOURCE',activateTime:null,eidBound:false}), 'available');
  assert.equal(inventory.profileState({smdpStatus:'ENABLED',esimStatus:'IN_USE',activateTime:'2026-01-01'}), 'active');
  assert.equal(inventory.profileState({smdpStatus:'DELETED',esimStatus:'IN_USE'}), 'deleted_from_device');
  assert.equal(inventory.profileState({smdpStatus:'ENABLED',esimStatus:'USED_UP'}), 'used_up');
});

test('inventory deduplicates purchase records in favour of the current owner', () => {
  const profile={iccid:'89852240810733629810',orderNo:'B123',esimTranNo:'T123',smdpStatus:'RELEASED',esimStatus:'GOT_RESOURCE'};
  const records=inventory.collectInventory({a:{email:'a@example.com',plan:'standard',esim:profile,purchases:[{id:'p1',iccid:profile.iccid,esimOrderNo:profile.orderNo}]}},[]);
  assert.equal(records.length,1);
  assert.equal(records[0].source,'current');
  assert.equal(records[0].ownerEmail,'a@example.com');
});

test('admin inventory responses never expose QR or activation secrets', () => {
  const record=inventory.publicRecord({id:'esim_1',source:'pool',profile:{iccid:'89852240810733629810',activationCode:'LPA:1$secret',qrCodeUrl:'https://secret.example/qr',smdpStatus:'RELEASED',esimStatus:'GOT_RESOURCE'}});
  assert.equal(record.canAssign,true);
  assert.equal('activationCode' in record,false);
  assert.equal('qrCodeUrl' in record,false);
  assert.equal(record.iccidLast4,'9810');
});

test('admin eSIM actions are protected by explicit permission and two-factor gates', () => {
  const server=read('server.js'),auth=read('adminAuthService.js'),page=read('admin-esims.html');
  assert.match(auth,/esim\.manage/);
  assert.match(server,/\/api\/admin\/esims\/\:id\/assign',[^\n]*requirePermission\('esim\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(server,/\/api\/admin\/esims\/\:id\/\:action',[^\n]*requirePermission\('esim\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(page,/власник видаляє його в налаштуваннях телефону/);
});

test('customer activation hides already-consumed install credentials', () => {
  const server=read('server.js'),page=read('esim-management.html'),provider=read('esimService.js');
  assert.match(server,/activationCode: canInstall \? esim\.activationCode \|\| null : null/);
  assert.match(server,/qrCodeUrl: canInstall \? esim\.qrCodeUrl \|\| null : null/);
  assert.match(server,/supportInstallUrl: canInstall \? esim\.supportInstallUrl \|\| null : null/);
  assert.match(server,/delete result\.esim\.supportInstallUrl/);
  assert.match(page,/Відкрити сторінку встановлення/);
  assert.match(page,/Цей код уже був завантажений на пристрій/);
  assert.match(provider,/smdpStatus: profile\.smdpStatus/);
  assert.match(provider,/esimStatus: profile\.esimStatus/);
});

test('Super Admin can grant a provider-confirmed free eSIM without Stripe', () => {
  const server=read('server.js'),page=read('admin-esims.html');
  const route=server.slice(server.indexOf("app.post('/api/admin/esims/:id/assign'"),server.indexOf("app.post('/api/admin/esims/:id/replace-and-assign'"));
  assert.match(page,/Видати eSIM безкоштовно/);
  assert.match(page,/Оплата Stripe і підписка не створюються/);
  assert.match(route,/grantType=transferred\?'admin_transfer':'admin_promo'/);
  assert.match(route,/priceCents:0/);
  assert.match(route,/Stripe, оплата та підписка не створювалися/);
  assert.doesNotMatch(route,/createCheckout|createCustomPackageCheckout|upsertPurchase/);
});

test('an unused assigned eSIM can be transferred in one step without moving billing', () => {
  const page=read('admin-esims.html'),server=read('server.js'),record=inventory.publicRecord({id:'esim_transfer',source:'current',ownerEmail:'from@example.com',ownerHasPaidSubscription:true,profile:{iccid:'89852240810733629810',smdpStatus:'RELEASED',esimStatus:'GOT_RESOURCE',usedGb:0}});
  assert.equal(record.canTransfer,true);
  assert.equal(record.ownerHasPaidSubscription,true);
  assert.match(page,/Передати іншому/);
  assert.match(page,/Stripe-підписка поточного власника не переноситься/);
  const route=server.slice(server.indexOf("app.post('/api/admin/esims/:id/assign'"),server.indexOf("app.post('/api/admin/esims/:id/replace-and-assign'"));
  assert.match(route,/reason:'admin_transfer'/);
  assert.match(route,/status:sourceOwner\?\.status==='blocked'\?'blocked':'esim_transferred'/);
  assert.match(route,/Stripe-підписка попереднього власника не змінювалася/);
  assert.doesNotMatch(route,/cancelSubscription|stripeSubscriptionId:null/);
});

test('deleted provider profiles are archived and can issue a new same-package replacement', () => {
  const page=read('admin-esims.html'),server=read('server.js'),provider=read('esimService.js');
  const record=inventory.publicRecord({id:'old_profile',source:'pool',stateOverride:'quarantined',profile:{iccid:'89852240810733629810',packageCode:'EU20',smdpStatus:'DELETED',esimStatus:'GOT_RESOURCE'}});
  assert.equal(record.state,'quarantined');
  assert.equal(record.canAssign,false);
  assert.equal(record.canReplace,true);
  assert.match(page,/Архів провайдера/);
  assert.match(page,/Видати нову eSIM/);
  const route=server.slice(server.indexOf("app.post('/api/admin/esims/:id/replace-and-assign'"),server.indexOf("app.post('/api/admin/esims/:id/detach'"));
  assert.match(route,/confirmProviderCharge/);
  assert.match(route,/await provisionEsim/);
  assert.match(route,/grantType:'admin_replacement'/);
  assert.match(route,/stateOverride:'replaced'/);
  assert.match(route,/REPLACEMENT_PERSISTENCE_UNCONFIRMED/);
  assert.match(route,/listAllocatedEsims\(\)/);
  assert.match(route,/item\.transactionId/);
  assert.match(route,/recoveredExistingOrder/);
  assert.match(route,/без повторної оплати прив’язано/);
  assert.doesNotMatch(route,/createCheckout|createCustomPackageCheckout/);
  assert.match(provider,/transactionId: suppliedTransactionId/);
  assert.match(provider,/transactionId: profile\.transactionId \|\| null/);
  assert.match(page,/record\.source==='current'&&record\.ownerEmail===email/);
  assert.match(page,/!data\.profileId\|\|record\.id===data\.profileId/);
});

test('a profile deleted from the first phone can be transferred only through a fresh provider QR', () => {
  const page=read('admin-esims.html'),client=read('admin-client.html'),server=read('server.js');
  const record=inventory.publicRecord({id:'deleted_current',source:'current',ownerEmail:'first@example.com',profile:{iccid:'89852240810733629810',packageCode:'EU20',smdpStatus:'DELETED',esimStatus:'IN_USE'}});
  assert.equal(record.state,'deleted_from_device');
  assert.equal(record.canTransfer,false);
  assert.equal(record.canReplace,true);
  assert.match(page,/Передати з новим QR/);
  assert.match(page,/Старий QR уже використаний/);
  assert.match(client,/transferEsim/);
  const route=server.slice(server.indexOf("app.post('/api/admin/esims/:id/replace-and-assign'"),server.indexOf("app.post('/api/admin/esims/:id/detach'"));
  assert.match(route,/\['pool','current'\]\.includes\(record\.source\)/);
  assert.match(route,/reason:'admin_replacement_transfer'/);
  assert.match(route,/status:sourceOwner\.status==='blocked'\?'blocked':'esim_transferred'/);
  assert.match(route,/Використану eSIM замінено новим профілем і передано іншому користувачу/);
});

test('archived eSIM transfer stays visible when provider sync omitted the package code', () => {
  const records=inventory.collectInventory({
    'first@example.com':{email:'first@example.com',purchases:[{id:'purchase_1',iccid:'89852240810733629810',packageCode:'EU20GB30D',packageName:'Europe 20GB',dataLimitGb:20,durationDays:30}]},
  },[{id:'archived_1',previousOwnerEmail:'first@example.com',purchaseId:'purchase_1',stateOverride:'revoked',profile:{iccid:'89852240810733629810',esimStatus:'REVOKED'}}]);
  const record=inventory.publicRecord(records[0]),page=read('admin-esims.html'),server=read('server.js');
  assert.equal(record.state,'revoked');
  assert.equal(record.hasReplacementPackage,true);
  assert.equal(record.canReplace,true);
  assert.match(page,/refreshAdminIdentity/);
  assert.match(page,/needsFreshProfile/);
  assert.match(page,/Код цього пакета з eSIM Access/);
  assert.match(server,/record\.profile\?\.packageCode\|\|req\.body\?\.packageCode/);
});

test('account deletion preserves package details needed to reissue a working QR', () => {
  const server=read('server.js');
  const route=server.slice(server.indexOf("app.delete('/api/admin/users/:email'"),server.indexOf("app.post('/api/admin/users/:email/revoke-sessions'"));
  assert.match(route,/const archivedProfile=/);
  assert.match(route,/packageCode:user\.esim\.packageCode\|\|purchase\?\.packageCode/);
  assert.match(route,/remainingGb:user\.esim\.remainingGb/);
  assert.match(route,/providerState==='available'\?null/);
  assert.match(route,/Передати з новим QR/);
});

test('Super Admin can import an exact support replacement without creating another order', () => {
  const server=read('server.js'),provider=read('esimService.js'),page=read('admin-esims.html');
  const route=server.slice(server.indexOf("app.post('/api/admin/esims/import-provider-profile'"),server.indexOf("app.post('/api/admin/esims/:id/sync'"));
  assert.match(page,/Імпортувати від підтримки/);
  assert.match(page,/ПОВНЕ посилання підтримки/);
  assert.match(route,/requireRole\('super_admin'\)/);
  assert.match(route,/requirePermission\('esim\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(route,/recoverEsimByOrderNo/);
  assert.match(route,/listAllocatedEsims/);
  assert.match(route,/directLookupError/);
  assert.match(route,/item\.iccid,item\.orderNo,item\.transactionId/);
  assert.match(route,/confirmSupportLinkImport===true/);
  assert.match(route,/alreadyInstalled=req\.body\?\.alreadyInstalled===true/);
  assert.match(page,/Василь уже встановив цю eSIM/);
  assert.match(route,/safeSupportInstallUrl/);
  assert.match(page,/p\\\.qrsim\\\.net/);
  assert.match(route,/putEsimInPool/);
  assert.match(route,/type:'support_replacement'/);
  assert.match(route,/saveUser\(targetEmail/);
  assert.match(route,/support_profile_assigned/);
  assert.match(route,/support_usage_link_updated/);
  assert.match(route,/priceCents:0/);
  assert.doesNotMatch(route,/provisionEsim|\/esim\/order|confirmProviderCharge/);
  assert.match(provider,/async function recoverEsimByOrderNo/);
});

test('support-link usage is updated manually without querying a fake provider order', () => {
  const server=read('server.js'),page=read('admin-client.html'),inventory=read('esimInventoryService.js');
  const route=server.slice(server.indexOf("app.patch('/api/admin/users/:email/esim-usage'"),server.indexOf("app.post('/api/admin/users/:email/resend-esim-instructions'"));
  assert.match(route,/requireRole\('super_admin'\)/);
  assert.match(route,/requirePermission\('esim\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(route,/provider!=='support-link'/);
  assert.match(route,/remainingGb===0/);
  assert.match(route,/support_esim_usage_adjusted/);
  assert.doesNotMatch(route,/checkUsage|provisionEsim|topupEsim/);
  assert.match(page,/Вказати вручну/);
  assert.match(page,/Якщо інтернет закінчився — введіть 0/);
  assert.match(inventory,/provider==='support-link'\)actions\.canSync=false/);
});

test('support share link supplies real usage to both admin and customer screens', () => {
  const server=read('server.js'),provider=read('esimService.js'),page=read('admin-client.html');
  const adminRoute=server.slice(server.indexOf("app.post('/api/admin/users/:email/resync-esim'"),server.indexOf("app.get('/api/admin/users/:email/esim-topups'"));
  const customerRoute=server.slice(server.indexOf("app.get('/api/usage'"),server.indexOf("app.get('/api/billing'"));
  assert.match(provider,/async function checkSupportLinkUsage/);
  assert.match(provider,/hostname\.toLowerCase\(\) !== 'p\.qrsim\.net'/);
  assert.match(provider,/usageUrl\.hostname\.toLowerCase\(\) !== 'api\.esimaccess\.com'/);
  assert.match(provider,/\/api\/v1\/h5\/share\/order\/queryUsage/);
  assert.match(provider,/SUPPORT_USAGE_VALUES_MISSING/);
  assert.match(adminRoute,/checkSupportLinkUsage\(user\.esim\.supportInstallUrl\)/);
  assert.match(adminRoute,/persistSupportLinkUsage/);
  assert.match(customerRoute,/checkSupportLinkUsage\(user\.esim\.supportInstallUrl\)/);
  assert.match(customerRoute,/source:'support_link_saved'/);
  assert.match(page,/Перевірити залишок/);
  assert.match(page,/Вказати вручну/);
});

test('support share usage parser accepts only the official token endpoint', async t => {
  const service=require('../esimService'),originalFetch=global.fetch,calls=[];
  t.after(()=>{global.fetch=originalFetch});
  global.fetch=async url=>{
    calls.push(String(url));
    if(calls.length===1)return new Response('<input value="https://api.esimaccess.com/api/v1/h5/share/order/queryUsage?token=safe%2Btoken" id="queryUsageAPI">',{status:200,headers:{'content-type':'text/html'}});
    return new Response(JSON.stringify({success:true,obj:{iccid:'8943108170002370489',totalVolume:10737418240,dataUsage:2684354560,expiredTime:'2027-01-01T00:00:00Z',totalDuration:30,dataType:1}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const usage=await service.checkSupportLinkUsage('https://p.qrsim.net/0123456789abcdef0123456789abcdef');
  assert.equal(calls.length,2);
  assert.equal(new URL(calls[1]).hostname,'api.esimaccess.com');
  assert.equal(usage.totalBytes,10737418240);
  assert.equal(usage.usedBytes,2684354560);
  assert.equal(usage.remainingBytes,8053063680);
});

test('Super Admin can add a compatible package to the installed eSIM without a new QR or Stripe charge', () => {
  const server=read('server.js'),page=read('admin-client.html');
  const start=server.indexOf("app.get('/api/admin/users/:email/esim-topups'");
  const end=server.indexOf("app.patch('/api/admin/users/:email/esim-usage'");
  const routes=server.slice(start,end);
  assert.ok(start>0&&end>start);
  assert.match(routes,/requireRole\('super_admin'\)/);
  assert.match(routes,/requirePermission\('esim\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(routes,/listPackages\(\{type:'TOPUP',iccid:esim\.iccid/);
  assert.match(routes,/confirmProviderCharge!==true/);
  assert.match(routes,/claimExternalEvent\('admin-esim-topup'/);
  assert.match(routes,/topupEsim\(\{esimTranNo:esim\.esimTranNo,iccid:esim\.iccid,packageCode,transactionId\}/);
  assert.match(routes,/customerCharged:false/);
  assert.match(routes,/newQrRequired:false/);
  assert.match(routes,/type:'admin_topup'/);
  assert.doesNotMatch(routes,/provisionEsim|createCustomPackageCheckout|Stripe/);
  assert.match(page,/Додати пакет без нового QR/);
  assert.match(page,/Клієнт нічого не платить, Stripe не використовується/);
  assert.match(page,/confirmProviderCharge:true/);
});

test('support-issued profile must be linked to the provider API before a real top-up', () => {
  const server=read('server.js');
  const helper=server.slice(server.indexOf('async function providerManagedEsimForTopup'),server.indexOf("app.get('/api/account/esim/qr-image'"));
  assert.match(helper,/user\.esim\.provider !== 'support-link'/);
  assert.match(helper,/recoverEsim\(\{ iccid:user\.esim\.iccid/);
  assert.match(helper,/PROVIDER_PROFILE_NOT_LINKED/);
  assert.match(helper,/API\/reseller account/);
});

test('customer top-up checkout returns the existing-eSIM Stripe session without an undefined reward reference', () => {
  const server=read('server.js');
  const route=server.slice(server.indexOf("app.post('/api/account/esim/topups/checkout'"),server.indexOf("app.get('/api/push/public-key'"));
  assert.match(route,/providerManagedEsimForTopup/);
  assert.match(route,/changeMode:'topup_existing'/);
  assert.match(route,/res\.json\(\{url:session\.url\}\)/);
  assert.doesNotMatch(route,/rewardApplied:reward/);
});
