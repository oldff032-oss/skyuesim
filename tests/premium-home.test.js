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
  assert.equal(deck.tiers.length, 3);
  const serialized = JSON.stringify(deck);
  for (const secret of ['LPA:SECRET','secret.invalid','89420000123','0000','cus_secret','order_secret']) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('approved visual system and functional gift center are present on mobile home', () => {
  const dashboard = read('dashboard.html');
  assert.match(dashboard, />SIGNAL</);
  assert.match(dashboard, /eSIM · TRAVEL/);
  assert.match(dashboard, /signal-card-scenes-v1\.png/);
  assert.match(dashboard, /\/api\/account\/home-deck/);
  assert.match(dashboard, /href="signal-club\.html" aria-label="Винагороди"/);
  for (const plan of ['basic','standard','unlimited']) assert.match(dashboard, new RegExp(`plans\\.html\\?plan=\\$\\{encodeURIComponent\\(item\\.key\\)\\}`));
  assert.match(dashboard, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
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
  assert.match(worker, /signal-shell-v85-premium-cards/);
  assert.match(pwa, /SIGNAL_FRONTEND_VERSION='2\.5\.0'/);
  assert.match(operations, /frontend:'2\.5\.0', backend:'2\.5\.0', serviceWorker:'v85'/);
  assert.ok(fs.statSync(path.join(root, 'signal-card-scenes-v1.png')).size > 100000);
});
