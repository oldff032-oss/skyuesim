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
  assert.match(i18n, /savedLocally:\s*true/);
  assert.match(i18n, /catch \{ synced = false; \}/);
  assert.match(i18n, /translations\/batch/);
  assert.match(read('server.js'), /app\.post\('\/api\/translations\/batch', requireUserSession/);
  assert.match(read('translationService.js'), /translateBatch/);
  assert.match(read('translationService.js'), /cooldownUntil/);
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

test('service worker bypasses stale cache for maintenance and localization assets', () => {
  const worker=read('sw.js');
  const support=read('support.html');
  assert.match(worker, /signal-shell-v39-control-center/);
  assert.match(worker, /fetch\(event\.request, \{ cache:'no-store' \}\)/);
  assert.match(worker, /'\/i18n\.js'/);
  assert.match(worker, /'\/style\.css'/);
  assert.match(support, /maintenance-support\.html/);
});

test('feedback has a branded customer form and a protected admin inbox', () => {
  const server=read('server.js');
  const form=read('feedback.html');
  const admin=read('admin-feedback.html');
  const users=read('admin-users.html');
  assert.match(server, /app\.post\('\/api\/account\/feedback', requireUserSession/);
  assert.match(server, /app\.get\('\/api\/admin\/feedback', adminAuth\.requireAdmin/);
  assert.match(form, /rating-button/);
  assert.match(form, /feedback-text/);
  assert.match(admin, /summary\.distribution/);
  assert.match(admin, /avatarDataUrl/);
  assert.match(users, /userDetailsAvatar/);
});

test('admin navigation exposes every section and scrolls independently', () => {
  const css=read('style.css');
  const common=read('admin-common.js');
  assert.match(css, /\.admin-sidebar[\s\S]*overflow-y:auto/);
  for(const page of ['admin-dashboard.html','admin-tickets.html','admin-users.html','admin-operations.html','admin-feedback.html','admin-diagnostics.html','admin-error-guide.html']) assert.match(common,new RegExp(page.replace('.','\\.')));
  assert.match(common, /nav\.innerHTML=links\.map/);
});

test('suspicious sign-ins automatically notify only super admins', () => {
  const server=read('server.js');
  assert.match(server, /role==='super_admin'/);
  assert.match(server, /immediateSurfaces=\['admin_login','admin_2fa','admin_emergency_recovery','backup_restore'\]/);
  assert.match(server, /securityNotificationAtByKey/);
  assert.match(server, /sendEmail\(\{to:admin\.email,subject:`🚨 Підозріла спроба входу/);
  assert.match(server, /Паролі, PIN, токени та повна IP-адреса в лист не додаються/);
});

test('control center covers operations reconciliation jobs delivery and reporting',()=>{
  const server=read('server.js'),page=read('admin-control-center.html'),service=read('controlCenterService.js');
  for(const route of ['/api/admin/control-center','/api/admin/jobs/:id/retry','/api/admin/deliveries/:id/retry','/api/admin/feature-flags','/api/admin/provider-balance','/api/admin/daily-report/generate'])assert.match(server,new RegExp(route.replaceAll('/','\\/')));
  for(const section of ['attention','reconciliation','jobs','delivery','support','localization','settings','reports'])assert.match(page,new RegExp(`id="${section}"`));
  assert.match(service,/function buildAttention/);assert.match(service,/function reconciliation/);assert.match(service,/function userTimeline/);assert.match(service,/function dailyReport/);
});

test('granular permissions and dangerous two-factor gates are enforced',()=>{
  const auth=read('adminAuthService.js'),server=read('server.js');
  assert.match(auth,/ALL_PERMISSIONS/);assert.match(auth,/function requirePermission/);assert.match(auth,/STEP_UP_REQUIRED/);
  assert.match(server,/requirePermission\('refunds\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(server,/requirePermission\('users\.delete',\{requireTwoFactor:true\}\)/);
  assert.match(server,/requirePermission\('backups\.manage',\{requireTwoFactor:true\}\)/);
});

test('delivery translation health and user timeline remain persistent and protected',()=>{
  const operations=read('operationsStore.js'),translation=read('translationService.js'),server=read('server.js');
  assert.match(operations,/deliveryEvents/);assert.match(operations,/function recordDelivery/);assert.match(operations,/featureFlags/);
  assert.match(translation,/function status/);assert.match(translation,/rateLimits/);assert.match(translation,/function setManual/);
  assert.match(server,/\/api\/admin\/users\/:email\/timeline/);assert.match(server,/adminAuth\.requirePermission\('users\.read'\)/);
});
