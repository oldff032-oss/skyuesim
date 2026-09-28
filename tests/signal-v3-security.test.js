const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('Signal V3 protects both PIN and graphical pattern attempts',()=>{
  const server=read('server.js');
  assert.match(server,/APP_LOCK_MAX_FAILURES=3/);
  assert.match(server,/APP_LOCK_DURATION_MS=5\*60\*1000/);
  assert.match(server,/app\.post\('\/api\/account\/lock\/verify', requireUserSession, rateLimit/);
  assert.match(server,/patternHash:await bcrypt\.hash\(pattern,10\)/);
  assert.doesNotMatch(server,/patternValue|plainPattern|savedPattern:/);
  assert.match(server,/res\.status\(423\)/);
});

test('graphical pattern is validated and shared by setup and unlock screens',()=>{
  const pattern=read('signal-pattern.js'),security=read('security.html'),setup=read('security-pattern.html'),pwa=read('pwa.js');
  assert.match(pattern,/nodes\.length<4\|\|nodes\.length>9/);
  assert.match(pattern,/new Set\(nodes\)\.size!==nodes\.length/);
  assert.match(security,/security-pattern\.html/);
  assert.match(setup,/mountSignalPattern/);
  assert.match(setup,/method:'pattern'/);
  assert.match(pwa,/import\('\.\/signal-pattern\.js'\)/);
  assert.match(pwa,/retryAfterSeconds/);
});

test('V3 security screen, animated globe and bilingual registration are wired',()=>{
  const security=read('security.html'),recovery=read('security-recovery.html'),pwa=read('pwa.js'),style=read('style.css'),worker=read('sw.js');
  assert.match(security,/Центр безпеки/);
  assert.match(security,/Довірені пристрої/);
  assert.match(recovery,/Забагато спроб/);
  assert.match(recovery,/Відновити через email/);
  assert.match(pwa,/auth-globe/);
  assert.match(style,/@keyframes authGlobe/);
  assert.match(read('verify-code.html'),/Підтверди email/);
  assert.match(read('set-password.html'),/Захисти акаунт/);
  assert.match(worker,/\/signal-pattern\.js/);
});
