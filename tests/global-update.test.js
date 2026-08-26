const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('active eSIM top-ups are authenticated, server-priced, and fulfilled after Stripe confirmation', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/account\/esim\/topups',\s*requireUserSession/);
  assert.match(server, /app\.post\('\/api\/account\/esim\/topups\/checkout',\s*requireUserSession/);
  assert.match(server, /type:'TOPUP'/);
  assert.match(server, /changeMode:'topup_existing'/);
  assert.match(server, /await topupEsim\(\{esimTranNo:current\.esim\.esimTranNo,iccid:current\.esim\.iccid,packageCode/);
  assert.match(read('esim-topup.html'), /Новий QR-код не потрібний/);
});

test('family eSIM sharing stores only a token hash and supports revoke and install acknowledgement', () => {
  const server = read('server.js');
  assert.match(server, /crypto\.createHash\('sha256'\)/);
  assert.match(server, /tokenHash:familyShareHash\(token\)/);
  assert.doesNotMatch(server, /shareToken\s*:/);
  assert.match(server, /app\.delete\('\/api\/account\/family-esims\/:id\/share',requireUserSession/);
  assert.match(server, /app\.post\('\/api\/family-share\/:token\/installed'/);
  assert.match(read('family-share.html'), /cache:'no-store'/);
});

test('travel mode has customer reminders and an authenticated admin overview', () => {
  const server = read('server.js');
  const worker = read('pushWorker.js');
  assert.match(server, /app\.put\('\/api\/account\/travel-mode',\s*requireUserSession/);
  assert.match(server, /app\.get\('\/api\/admin\/travel',adminAuth\.requireAdmin,adminAuth\.requireRole/);
  assert.match(worker, /trip-prepare-/);
  assert.match(worker, /trip-departure-/);
  assert.match(read('admin-common.js'), /admin-travel\.html/);
  assert.match(read('dashboard.html'), /travel-assistant\.html/);
});

test('password recovery repairs a legacy customer profile missing its password record', () => {
  const auth = read('authService.js');
  assert.match(auth, /store\.users\[email\] \|\| getUser\(email\)/);
  assert.match(auth, /const applicationUser = getUser\(entry\.email\)/);
  assert.match(auth, /store\.users\[entry\.email\] = \{/);
});

test('passkeys follow the configured production domain instead of an obsolete hostname', () => {
  const server = read('server.js');
  assert.match(server, /process\.env\.PASSKEY_ORIGIN \|\| process\.env\.FRONTEND_URL/);
  assert.match(server, /process\.env\.PASSKEY_RP_ID/);
  assert.doesNotMatch(server, /const PASSKEY_RP_ID = 'skyesim\.netlify\.app'/);
});

test('global update assets use one coherent cache and app version', () => {
  const worker = read('sw.js');
  const pwa = read('pwa.js');
  for (const page of ['/travel-assistant.html','/esim-topup.html','/family-share.html']) assert.match(worker, new RegExp(page.replace('.', '\\.')));
  assert.match(worker, /signal-shell-v70-global-travel/);
  assert.match(pwa, /SIGNAL_FRONTEND_VERSION='2\.0\.0'/);
  assert.match(pwa, /SIGNAL_SW_VERSION='v70'/);
});
