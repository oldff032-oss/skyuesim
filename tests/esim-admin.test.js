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
  assert.doesNotMatch(route,/createCheckout|createCustomPackageCheckout/);
  assert.match(provider,/transactionId: suppliedTransactionId/);
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
