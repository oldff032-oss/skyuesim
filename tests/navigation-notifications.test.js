const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('updated inline application scripts are valid JavaScript',()=>{
  for(const file of ['dashboard.html','notifications.html']){
    const scripts=[...read(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match=>match[1]).filter(Boolean);
    scripts.forEach((source,index)=>assert.doesNotThrow(()=>new vm.Script(source,{filename:`${file}:inline-${index+1}`})));
  }
});

test('home has one compact branded header, a hidden zero badge and support access',()=>{
  const dashboard=read('dashboard.html');
  const header=dashboard.match(/<header class="home-top">[\s\S]*?<\/header>/)?.[0]||'';
  assert.doesNotMatch(dashboard,/aria-label="Меню"/);
  assert.match(header,/signal-premium-logo\.png/);
  assert.match(header,/href="profile\.html"/);
  assert.match(dashboard,/\.notice-badge\[hidden\]\{display:none\}/);
  assert.match(dashboard,/function setBadge\(count\)/);
  assert.match(dashboard,/setInterval\(loadNotifications,60000\)/);
  assert.match(dashboard,/Підтримка/);
  assert.match(dashboard,/href="support\.html"/);
});

test('customer pages receive one shared bottom navigation',()=>{
  const pwa=read('pwa.js'),experience=read('experience.js');
  assert.match(pwa,/function signalBottomNavMarkup\(english=false\)/);
  assert.match(pwa,/document\.querySelectorAll\('\.xp-nav'\)\.forEach\(nav=>nav\.remove\(\)\)/);
  assert.match(pwa,/document\.body\?\.classList\.toggle\('has-bottomnav'/);
  assert.match(pwa,/class="signal-nav-assist" href="smart-assist\.html"/);
  assert.match(pwa,/support\.html/);
  assert.match(pwa,/nav\.classList\.remove\('o-bottomnav'\)/);
  for(const page of ['dashboard.html','plans.html','usage.html','profile.html'])assert.match(pwa,new RegExp(page.replace('.','\\.')));
  assert.match(experience,/function xpNav\(\)\{return '<nav class="bottomnav"/);
  assert.doesNotMatch(experience,/nav-home-v2\.png/);
});

test('phone push enrolls automatically without a custom setup panel',()=>{
  const page=read('notifications.html'),pwa=read('pwa.js'),server=read('server.js'),worker=read('sw.js');
  assert.doesNotMatch(page,/class="push-panel"/);
  assert.doesNotMatch(page,/id="pushToggle"/);
  assert.match(pwa,/function signalSetupAutomaticPush\(\)/);
  assert.match(pwa,/Notification\.requestPermission\(\)/);
  assert.match(pwa,/registration\.pushManager\.subscribe/);
  assert.match(pwa,/\/api\/push\/subscribe/);
  assert.match(pwa,/document\.addEventListener\('pointerdown',requestOnce/);
  assert.match(server,/tag: `support-\$\{ticket\.id\}`/);
  assert.match(worker,/self\.addEventListener\('push'/);
  assert.match(worker,/self\.addEventListener\('notificationclick'/);
});
