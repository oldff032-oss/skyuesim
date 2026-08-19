const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('sensitive legacy user routes require a session', () => {
  const server = read('server.js');
  for (const route of ['/api/status', '/api/usage', '/api/billing', '/api/cancel', '/api/create-subscription']) {
    const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(server, new RegExp(`app\\.(?:get|post)\\('${escaped}',\\s*requireUserSession`), `${route} must require authentication`);
  }
});

test('support tickets enforce authenticated ownership', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/support\/tickets\/:id',\s*requireUserSession/);
  assert.match(server, /ticket\.email !== req\.userEmail/);
  assert.doesNotMatch(server, /req\.query\.email\s*&&\s*ticket\.email/);
});

test('verification codes use cryptographic randomness and hashed storage', () => {
  const auth = read('authService.js');
  assert.match(auth, /crypto\.randomInt\(/);
  assert.match(auth, /codeHash/);
  assert.doesNotMatch(auth, /Math\.random\(/);
});

test('production CORS is allowlisted and seeded user data is absent', () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /app\.use\(cors\(\)\)/);
  assert.equal(fs.existsSync(path.join(root, 'data', 'users.json')), false);
});

test('Stripe success redirect does not disclose customer email', () => {
  const stripe = read('stripeService.js');
  assert.doesNotMatch(stripe, /installing\.html\?email=/);
  assert.match(stripe, /session_id=\{CHECKOUT_SESSION_ID\}/);
});

test('frontend ticket messages are escaped before HTML rendering', () => {
  for (const page of ['ticket.html', 'admin-ticket.html']) {
    const html = read(page);
    assert.match(html, /(?:escapeHtml|esc)\(m\.text\)\.replace/);
  }
});

test('travel package prices are calculated only on the server', () => {
  const server = read('server.js');
  const page = read('travel-plans.html');
  assert.match(server, /packageRetailCents\(item\)/);
  assert.match(server, /packages\.find\(item=>item\.packageCode===packageCode\)/);
  assert.match(page, /body:JSON\.stringify\(\{packageCode:code,changeMode\}\)/);
});

test('language selection is explicit, persistent, and synchronized', () => {
  const registration = read('register-email.html');
  const profile = read('profile.html');
  const languagePage = read('language.html');
  const i18n = read('i18n.js');
  assert.match(registration, /selectRegistrationLanguage\('uk'\)/);
  assert.match(registration, /selectRegistrationLanguage\('en'\)/);
  assert.doesNotMatch(profile, /prompt\(/);
  assert.match(profile, /language\.html/);
  assert.match(languagePage, /Українська/);
  assert.match(languagePage, /English/);
  assert.match(i18n, /signalSetLanguage/);
  assert.match(i18n, /api\/account\/preferences/);
  assert.match(i18n, /localStorage\.setItem\('signal_language'/);
});

test('all customer pages load localization support', () => {
  const excluded = new Set(['maintenance-support.html']);
  const customerPages = fs.readdirSync(root).filter(name => name.endsWith('.html') && !name.startsWith('admin-') && !excluded.has(name));
  for (const page of customerPages) assert.match(read(page), /pwa\.js/, `${page} must load customer localization`);
  assert.match(read('maintenance-support.html'), /i18n\.js/);
});

test('travel package catalogue and checkout require a user session', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/travel-packages',\s*requireUserSession/);
  assert.match(server, /app\.post\('\/api\/travel-packages\/checkout',\s*requireUserSession/);
});

test('diagnostics correlate payment and eSIM events without storing secrets', () => {
  const server = read('server.js');
  const store = read('diagnosticsStore.js');
  assert.match(server, /x-request-id/);
  assert.match(server, /purchaseId:session\.id/);
  assert.match(server, /action:'provision_failed'/);
  assert.match(store, /password\|pass\|pin\|token\|secret/);
  assert.match(store, /function summary\(/);
});

test('travel catalogue is paginated and mobile layout prevents horizontal overflow', () => {
  const esim = read('esimService.js');
  const page = read('travel-plans.html');
  assert.match(esim, /for \(let pageNum = 1; pageNum <= maximumPages/);
  assert.match(page, /overflow-x:hidden/);
  assert.match(page, /@media\(max-width:600px\)/);
  assert.match(page, /package-buy\{width:100%/);
  assert.match(page, /id="location"/);
  assert.match(page, /value="unlimited"/);
});

test('paid plan changes provision first and expose clear admin states', () => {
  const server = read('server.js');
  const stripe = read('stripeService.js');
  const page = read('travel-plans.html');
  assert.match(server, /executePaidPlanChange/);
  assert.match(server, /cancelSubscriptionAtPeriodEnd/);
  assert.match(server, /app\.get\('\/api\/admin\/plan-changes'/);
  assert.match(server, /PLAN_CHANGE_ALREADY_PENDING/);
  assert.match(stripe, /changeMode/);
  assert.match(page, /after_expiry/);
  assert.match(page, /immediate/);
  assert.ok(server.indexOf('const esim=await provisionEsim') < server.indexOf('await cancelSubscription(previousSubscriptionId)'), 'new eSIM must be provisioned before the old subscription is canceled');
});

test('classic subscription checkout cannot create an accidental duplicate', () => {
  const server = read('server.js');
  assert.match(server, /ACTIVE_SUBSCRIPTION_EXISTS/);
  assert.match(server, /currentUser\?\.stripeSubscriptionId/);
});

test('all transactional emails share the responsive Signal logo template', () => {
  const templates = read('emailTemplates.js');
  const emailService = read('emailService.js');
  const server = read('server.js');
  assert.match(templates, /signal-premium-logo\.png/);
  assert.match(templates, /name="viewport"/);
  for (const name of ['verificationCode','supportReply','ticketAssignment','purchaseReceipt','twoFactorCode','broadcast','adminSecurityAlert','notification','accessRecovery','esimInstructions']) assert.match(templates, new RegExp(`function ${name}\\(`));
  assert.match(emailService, /emailTemplates\.verificationCode/);
  assert.match(server, /emailTemplates\.accessRecovery/);
  assert.match(server, /emailTemplates\.esimInstructions/);
  assert.match(server, /notifyStaffAboutUserReply/);
});

test('customer support screens are mobile friendly and free of legacy mojibake', () => {
  for (const pageName of ['support.html','new-ticket.html','ticket.html']) {
    const page = read(pageName);
    assert.match(page, /viewport-fit=cover/);
    assert.match(page, /class="mark"/);
    assert.doesNotMatch(page, /Рџ|РЎРё|вЂ/);
  }
});

test('maintenance support works without account unlock and remains rate limited', () => {
  const server = read('server.js');
  const pwa = read('pwa.js');
  const page = read('maintenance-support.html');
  assert.match(server, /app\.post\('\/api\/maintenance-support',rateLimit\('maintenance_support'/);
  assert.match(server, /MAINTENANCE_INACTIVE/);
  assert.match(server, /operationsStore\.activeAnnouncements\(null\)/);
  assert.match(pwa, /maintenance-support/);
  assert.match(pwa, /signal-maintenance-check/);
  assert.doesNotMatch(pwa, /\(support\|new-ticket\|ticket\|maintenance-support\)/);
  assert.match(page, /\/api\/maintenance-support/);
  assert.match(page, /signal-premium-logo\.png/);
  assert.doesNotMatch(page, /pwa\.js/);
});

test('service worker bypasses stale cache for critical maintenance assets', () => {
  const worker=read('sw.js');
  const support=read('support.html');
  assert.match(worker, /signal-shell-v32-hard-maintenance/);
  assert.match(worker, /fetch\(event\.request, \{ cache:'no-store' \}\)/);
  assert.match(support, /maintenance-support\.html/);
});
