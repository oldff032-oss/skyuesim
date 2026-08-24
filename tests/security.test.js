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
  assert.match(page, /body:JSON\.stringify\(\{packageCode:code,changeMode:/);
  assert.match(page, /purchaseFor:changeMode==='gift'\?'family':'self'/);
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
  assert.match(pwa, /\/api\/service-status\?_=/);
  assert.match(pwa, /setInterval\(checkAppAnnouncements, 5000\)/);
  assert.match(pwa, /serviceStatus\.status==='maintenance'/);
  assert.match(read('admin-operations.html'), /Технічний режим збережено й підтверджено сервером/);
  assert.match(read('admin-operations.html'), /Повідомлення збережено й підтверджено сервером/);
  assert.match(pwa, /signal-announcement-card/);
  assert.match(read('style.css'), /\.maintenance-message[\s\S]*overflow-y:auto/);
  assert.match(read('style.css'), /\.maintenance-actions[\s\S]*flex:none/);
  assert.match(pwa, /startMaintenanceCountdown/);
  assert.match(pwa, /signal-maintenance-countdown-value/);
  assert.match(read('admin-operations.html'), /getTimezoneOffset/);
  assert.match(server, /Для технічних робіт обов’язково вкажіть час завершення/);
  assert.match(pwa, /renderSignalDashboardNotice/);
  assert.match(pwa, /signal-dashboard-notice/);
  assert.match(pwa, /Читати повністю/);
  assert.match(read('style.css'), /\.home>#announcements\{display:none!important\}/);
  assert.match(server, /Час завершення має бути в майбутньому/);
  assert.match(read('admin-operations.html'), /\/api\/announcements\?email=/);
  assert.match(read('admin-operations.html'), /не стало активним для користувачів/);
  assert.doesNotMatch(pwa, /\(support\|new-ticket\|ticket\|maintenance-support\)/);
  assert.match(page, /\/api\/maintenance-support/);
  assert.match(page, /signal-premium-logo\.png/);
  assert.doesNotMatch(page, /pwa\.js/);
});

test('service worker bypasses stale cache for maintenance and localization assets', () => {
  const worker=read('sw.js');
  const support=read('support.html');
  assert.match(worker, /signal-shell-v60-support-mobile/);
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
  for(const page of ['admin-dashboard.html','admin-users.html','admin-purchases.html','admin-tickets.html','admin-operations.html','admin-control-center.html','admin-team.html','admin-diagnostics.html']) assert.match(common,new RegExp(page.replace('.','\\.')));
  assert.doesNotMatch(common, /admin-(feedback|error-guide|plan-changes|notifications|versions|guide)\.html/);
  assert.match(common, /admin-nav-icon/);
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

test('daily Super Admin report is branded and switches between green and red states',()=>{
  const templates=read('emailTemplates.js'),server=read('server.js');
  assert.match(templates,/function dailyAdminReport/);assert.match(templates,/ЩОДЕННИЙ ЗВІТ · SUPER ADMIN/);
  for(const label of ['Нові користувачі','Покупки','Виторг','Повернення','Видані eSIM','Невдалі операції','Відкриті звернення','Середній час відповіді','Середня оцінка','Підозрілі входи','Баланс провайдера','Stripe','Email','Push','eSIM Access'])assert.match(templates,new RegExp(label));
  assert.match(server,/emailTemplates\.dailyAdminReport/);assert.match(server,/lastSentDate===localDate/);
});

test('Super Admin feature switches are enforced and fully audited',()=>{
  const server=read('server.js'),operations=read('operationsStore.js'),translation=read('translationService.js'),push=read('pushService.js'),page=read('admin-control-center.html');
  for(const flag of ['monthlyPlans','travelPackages','referrals','autoRenew','push','registration','deepl','photoUploads','cardPayments'])assert.match(operations,new RegExp(flag));
  assert.match(operations,/disabledCountries/);assert.match(operations,/disabledPackages/);assert.match(operations,/stripeCard/);
  assert.match(server,/function packageAllowed/);assert.match(server,/PAYMENT_METHOD_DISABLED/);assert.match(server,/feature_rules_updated/);assert.match(server,/before,after/);
  assert.match(translation,/featureFlags\?\.deepl !== false/);assert.match(push,/featureFlags\?\.push !== false/);
  assert.match(page,/saveRules/);assert.match(page,/disabledCountries/);assert.match(page,/disabledPackages/);
});

test('version control tracks clients and refreshes only approved critical assets',()=>{
  const server=read('server.js'),pwa=read('pwa.js'),worker=read('sw.js'),page=read('admin-versions.html');
  for(const route of ['/api/app-version','/api/account/client-version','/api/admin/versions','/api/admin/versions/request-update','/api/admin/versions/critical-refresh'])assert.match(server,new RegExp(route.replaceAll('/','\\/')));
  assert.match(worker,/REFRESH_CRITICAL/);assert.match(worker,/cache\.delete\(path\)/);assert.match(pwa,/criticalRefreshToken/);
  assert.match(page,/Попросити оновити застосунок/);assert.match(page,/Журнал змін/);assert.match(page,/Старих версій/);
});

test('support performance is attributed to individual administrators',()=>{
  const tickets=read('ticketStore.js'),service=read('controlCenterService.js'),page=read('admin-control-center.html');
  assert.match(tickets,/adminEmail/);assert.match(service,/byAdmin/);assert.match(service,/averageFirstResponseMinutes/);assert.match(service,/averageResolutionMinutes/);assert.match(service,/reopened/);
  assert.match(page,/Результати адміністраторів/);assert.match(page,/Повторно відкрито/);
});

test('Stripe webhooks use durable idempotency and production-safe tolerance',()=>{
  const server=read('server.js'),stripe=read('stripeService.js'),storage=read('persistentState.js');
  assert.match(server,/claimExternalEvent\('stripe',event\.id,event\.type\)/);
  assert.match(server,/session\.payment_status!==['"]paid['"]/);
  assert.match(storage,/CREATE TABLE IF NOT EXISTS public\.external_events/);
  assert.match(stripe,/STRIPE_WEBHOOK_TOLERANCE_SECONDS \|\| 300/);
  assert.doesNotMatch(stripe,/24 \* 60 \* 60/);
});

test('customer cancellation is scheduled and billing is self-service',()=>{
  const server=read('server.js'),stripe=read('stripeService.js'),payments=read('payments.html');
  assert.match(server,/app\.post\('\/api\/billing\/portal',requireUserSession/);
  assert.match(server,/cancelSubscriptionAtPeriodEnd\(user\.stripeSubscriptionId\)/);
  assert.match(stripe,/stripe\.billingPortal\.sessions\.create/);
  assert.match(payments,/Керувати карткою та підпискою/);
});

test('Stripe profiles recover automatically and checkout reuses one customer',()=>{
  const server=read('server.js'),stripe=read('stripeService.js'),payments=read('payments.html'),admin=read('admin-users.html');
  assert.match(stripe,/resolveStripeCustomerProfile/);
  assert.match(stripe,/customerId \? \{ customer:customerId \} : \{ customer_email:email \}/);
  assert.match(server,/recoverStripeProfile\(req\.userEmail\)/);
  assert.match(server,/\/api\/account\/billing-profile/);
  assert.match(server,/stripeProfileLastCheckedAt/);
  assert.match(payments,/Stripe-профіль прив’язано/);
  assert.match(admin,/Знайти й прив’язати Stripe/);
  assert.match(admin,/Додаткових Stripe-профілів/);
});

test('bottom navigation always identifies usage and charts stay visible without motion',()=>{
  const pwa=read('pwa.js'),usage=read('usage.html'),css=read('style.css'),headers=read('_headers');
  assert.match(pwa, /'usage\.html':\{label:'Витрати',labelEn:'Usage'/);
  assert.match(pwa, /classList\.toggle\('active',page===current\)/);
  assert.match(pwa, /setTimeout\(enhanceSignalNavigation,500\)/);
  assert.match(usage, /height:var\(--bar-height\)/);
  assert.match(usage, /width:var\(--usage-pct\)!important/);
  assert.match(usage, /@keyframes barRise\{from\{transform:scaleY\(0\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /navSelect/);
  assert.match(css, /nav-art/);
  assert.match(css, /clip:rect\(0,0,0,0\)/);
  assert.match(pwa, /setAttribute\('aria-label',label\)/);
  assert.match(pwa, /\/sw\.js\?v=60/);
  for(const marker of ['nav-home-v2.png','nav-plans-v2.png','nav-usage-v2.png','nav-profile-v2.png']) assert.match(pwa,new RegExp(marker.replace('.', '\\.')));
  assert.doesNotMatch(css, /navBreathe[\s\S]{0,80}infinite/);
  assert.match(headers, /\/pwa\.js[\s\S]*Cache-Control: no-store/);
  for(const page of ['dashboard.html','plans.html','usage.html','profile.html']){
    const html=read(page),nav=html.match(/<nav class="bottomnav"[\s\S]*?<\/nav>/)?.[0]||'';
    assert.match(nav, /<img class="nav-art"/);
    assert.doesNotMatch(nav, /<svg/);
    assert.doesNotMatch(nav, />Моя eSIM<\/a>/);
    assert.doesNotMatch(nav, />Головна<\/a>/);
  }
});

test('email changes require ownership verification at the new address',()=>{
  const server=read('server.js'),auth=read('authService.js'),settings=read('account-settings.html');
  assert.match(server,/\/api\/account\/email-change\/request/);
  assert.match(server,/\/api\/account\/email-change\/confirm/);
  assert.match(auth,/EMAIL_VERIFICATION_REQUIRED/);
  assert.match(settings,/Надіслати код на новий email/);
});

test('self-service eSIM recovery never provisions a new order',()=>{
  const server=read('server.js'),page=read('esim-management.html');
  const route=server.slice(server.indexOf("app.post('/api/account/esim/recover'"),server.indexOf("app.get('/api/account/order-status'"));
  assert.match(route,/recoverEsim/);
  assert.doesNotMatch(route,/provisionEsim/);
  assert.match(page,/Синхронізувати з оператором/);
});

test('marketing broadcasts only target explicit opt-ins',()=>{
  const server=read('server.js'),settings=read('account-settings.html');
  assert.match(server,/preferences\?\.marketingEmails===true/);
  assert.match(settings,/Новини та пропозиції email/);
});

test('physical SIM data top-ups are server-priced, authenticated, and fulfilled only after Stripe payment',()=>{
  const server=read('server.js'),stripe=read('stripeService.js'),provider=read('mobileTopupService.js'),page=read('mobile-topup.html');
  for(const route of ['/api/mobile-topups/status','/api/mobile-topups/countries','/api/mobile-topups/operators','/api/mobile-topups/products','/api/mobile-topups/orders','/api/mobile-topups/checkout'])assert.match(server,new RegExp(route.replaceAll('/','\\/')));
  assert.match(server,/app\.post\('\/api\/mobile-topups\/checkout',\s*requireUserSession/);
  assert.match(server,/mobileTopups\.getProduct\(req\.body\?\.productId,\{includeCost:true\}\)/);
  assert.match(server,/session\.metadata\?\.purchaseKind==='mobile_topup'/);
  assert.match(server,/session\.payment_status!=='paid'/);
  assert.match(stripe,/metadata:\s*\{\s*purchaseKind:'mobile_topup',\s*mobileTopupOrderId/);
  assert.doesNotMatch(stripe,/metadata:\s*\{[^}]*phone/s);
  assert.match(provider,/credit_party_identifier:\s*\{\s*mobile_number:/);
  assert.match(provider,/type:\s*'FIXED_VALUE_RECHARGE'/);
  assert.match(provider,/benefit_types:\s*'DATA'/);
  assert.doesNotMatch(page,/DTONE_API_SECRET|DTONE_API_KEY/);
});

test('mobile top-up administration masks numbers and protects money-moving retry with 2FA',()=>{
  const server=read('server.js'),admin=read('admin-mobile-topups.html');
  assert.match(server,/function maskPhone/);
  assert.match(server,/app\.get\('\/api\/admin\/mobile-topups'/);
  assert.match(server,/app\.post\('\/api\/admin\/mobile-topups\/:orderId\/retry',[^\n]*requirePermission\('operations\.manage',\{requireTwoFactor:true\}\)/);
  assert.match(admin,/phoneMasked/);
  assert.match(admin,/Super Admin із підтвердженою 2FA/);
});

test('offline eSIM cards are encrypted and API responses are never cached',()=>{
  const vault=read('offline-esim.js'),worker=read('sw.js'),page=read('offline-esim.html'),server=read('server.js'),manager=read('esim-management.html');
  assert.match(vault,/PBKDF2/);
  assert.match(vault,/AES-GCM/);
  assert.match(vault,/iterations:\s*210000/);
  assert.match(vault,/\^\\d\{6\}\$/);
  assert.match(page,/Майстер встановлення/);
  assert.match(server,/app\.get\('\/api\/account\/esim\/qr-image', requireUserSession/);
  assert.match(server,/redirect:'error'/);
  assert.match(server,/function isSafeQrImageUrl/);
  assert.match(vault,/card\.qrDownloadUrl\|\|card\.qrCodeUrl/);
  assert.match(vault,/'x-session-token':authToken/);
  assert.match(manager,/qr-image\?scope=primary/);
  assert.match(worker,/if \(event\.request\.url\.includes\('\/api\/'\)\) return/);
  for(const file of ['/offline-esim.html','/offline-esim.js','/esim-management.html'])assert.match(worker,new RegExp(file.replace('.','\\.')));
});

test('family purchases provision a separate eSIM without replacing the buyer eSIM',()=>{
  const server=read('server.js'),page=read('travel-plans.html'),family=read('family-esims.html');
  assert.match(server,/familyPurchase = plan === 'custom' && recipientMode === 'family'/);
  assert.match(server,/saveUser\(email,\{sharedEsims:shared\.slice\(0,30\)\}\)/);
  assert.match(server,/kind: familyPurchase \? 'family_esim'/);
  assert.match(server,/app\.get\('\/api\/account\/family-esims',requireUserSession/);
  assert.match(page,/purchaseFor:changeMode==='gift'\?'family':'self'/);
  assert.match(family,/Зберегти офлайн/);
  assert.match(family,/Як встановити/);
  assert.match(family,/Передати одержувачу/);
  assert.match(family,/qr-image\?scope=family/);
});

test('ticket diagnostics use a strict secret-free whitelist',()=>{
  const server=read('server.js'),ticketStore=read('ticketStore.js'),admin=read('admin-ticket.html'),customer=read('ticket.html'),form=read('new-ticket.html');
  const block=server.slice(server.indexOf('function buildSupportDiagnostics'),server.indexOf('function recordDiagnostic'));
  for(const field of ['deviceModel','appVersion','esimStatus','lastSyncAt','purchaseId','stripeStatus','providerStatus','apn'])assert.match(block,new RegExp(field));
  for(const secret of ['activationCode','qrCode','pinHash','passwordHash','stripePaymentMethod'])assert.doesNotMatch(block,new RegExp(secret));
  assert.match(ticketStore,/diagnostics = null/);
  assert.match(ticketStore,/const \{ diagnostics, \.\.\.customerTicket \} = ticket/);
  assert.match(server,/getTicketsByEmail\(req\.userEmail\)\.map\(ticketStore\.stripNotesForUser\)/);
  assert.match(server,/res\.json\(ticketStore\.stripNotesForUser\(ticket\)\)/);
  assert.match(admin,/Діагностика звернення/);
  assert.doesNotMatch(customer,/diagnosticCard|diag-shared|Діагностику додано/);
  assert.doesNotMatch(form,/автоматично додадуться|статус Stripe, статус провайдера/);
  assert.match(customer,/@media\(max-width:600px\)/);
  assert.match(customer,/position:relative;bottom:auto/);
});
