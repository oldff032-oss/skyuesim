const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engagement = require('../engagementService');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('premium home endpoint is authenticated and uses the safe deck presenter', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/account\/home-deck',requireUserSession/);
  assert.match(server, /engagement\.homeDeck\(user,operationsStore\.store\(\)\.engagementSettings/);
});

test('home deck exposes useful card data without eSIM or payment secrets', () => {
  const deck = engagement.homeDeck({
    email:'traveler@example.com',
    plan:'standard',
    esim:{activationCode:'LPA:SECRET',qrCodeUrl:'https://secret.invalid/qr',iccid:'89420000123',pin:'0000',usedBytes:7*1024**3,totalBytes:20*1024**3},
    purchases:[{id:'purchase_1',plan:'standard',fulfillmentStatus:'provisioned',paymentStatus:'paid',stripeCustomerId:'cus_secret',orderNo:'order_secret',amountCents:1999}],
    loyalty:{points:600,lifetimePoints:800,rewards:[]},
  });
  assert.equal(deck.active.title, 'Стандарт');
  assert.equal(deck.active.scene, 'standard');
  assert.equal(deck.cards[0].dataLabel, '20 GB');
  assert.equal(deck.active.usedLabel, '7 GB');
  assert.equal(deck.active.totalLabel, '20 GB');
  assert.equal(deck.active.remainingPercent, 65);
  assert.equal(deck.tiers.length, 3);
  const serialized = JSON.stringify(deck);
  for (const secret of ['LPA:SECRET','secret.invalid','89420000123','0000','cus_secret','order_secret']) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('home corrects stale monthly labels from the active eSIM allowance', () => {
  const deck = engagement.homeDeck({
    plan:'basic',
    esim:{orderNo:'safe-order',usedBytes:2*1024**3,totalBytes:20*1024**3},
    purchases:[{id:'purchase_1',plan:'basic',fulfillmentStatus:'provisioned',paymentStatus:'paid'}],
  });
  assert.equal(deck.active.title, 'Стандарт');
  assert.equal(deck.active.planKey, 'standard');
  assert.equal(deck.active.totalLabel, '20 GB');
});

test('home names regional packages from the fulfilled purchase instead of a stale account plan', () => {
  const deck = engagement.homeDeck({
    plan:'basic',
    esim:{orderNo:'safe-order',usedGb:3,remainingGb:17,dataLimitGb:20,apn:'drei.at'},
    purchases:[{id:'purchase_2',plan:'custom',kind:'custom_package',packageCode:'eu-20',packageName:'Європа 20 GB',location:'Європа',fulfillmentStatus:'provisioned',paymentStatus:'paid'}],
  });
  assert.equal(deck.active.title, 'Європа 20 GB');
  assert.equal(deck.active.planKey, 'travel');
  assert.equal(deck.active.networkLabel, 'drei.at');
});

test('approved visual system and functional gift center are present on mobile home', () => {
  const dashboard = read('dashboard.html');
  assert.match(dashboard, />Signal eSIM</);
  assert.match(dashboard, /signal-card-scenes-v1\.png/);
  assert.match(dashboard, /\/api\/account\/home-deck/);
  assert.match(dashboard, /href="signal-club\.html" aria-label="Винагороди"/);
  assert.match(dashboard, /hero-used/);
  assert.match(dashboard, /remainingPercent/);
  assert.match(dashboard, /networkLabel/);
  assert.match(dashboard, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  for (const action of ['Встановити','Додати пакет','Для близьких','Підтримка']) assert.match(dashboard, new RegExp(action));
  assert.doesNotMatch(dashboard, /quick-new[^>]*[\s\S]{0,120}<img/);
  assert.doesNotMatch(dashboard, /<b>Витрати<\/b>|<b>Моя eSIM<\/b>/);
  assert.doesNotMatch(dashboard, /Обери свій рівень|Мої картки|tier-grid|owned-strip/);
  assert.match(dashboard, /overflow-x:hidden/);
});

test('tier links preselect the requested Stripe subscription', () => {
  const plans = read('plans.html');
  assert.match(plans, /new URLSearchParams\(location\.search\)\.get\('plan'\)/);
  assert.match(plans, /\['basic','standard','unlimited'\]\.includes\(requestedPlan\)/);
  assert.match(plans, /selectTier\(requestedTier\)/);
});

test('premium atlas is shipped in the offline shell and version is coherent', () => {
  const worker = read('sw.js');
  const pwa = read('pwa.js');
  const operations = read('operationsStore.js');
  assert.match(worker, /'\/signal-card-scenes-v1\.png'/);
  assert.match(worker, /signal-shell-v87-compact-nav/);
  assert.match(pwa, /SIGNAL_FRONTEND_VERSION='2\.6\.1'/);
  assert.match(operations, /frontend:'2\.6\.1', backend:'2\.6\.1', serviceWorker:'v87'/);
  assert.ok(fs.statSync(path.join(root, 'signal-card-scenes-v1.png')).size > 100000);
});
