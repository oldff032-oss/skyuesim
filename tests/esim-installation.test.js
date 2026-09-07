const test=require('node:test');
const assert=require('node:assert/strict');
const {profileToEsim}=require('../esimService');
const fresh={iccid:'89852240810733629810',esimStatus:'GOT_RESOURCE',smdpStatus:'RELEASED',orderUsage:0,totalVolume:1073741824};
test('only a provider-confirmed unused profile is installable',()=>{
  assert.equal(profileToEsim(fresh,'order','custom').canInstall,true);
  for(const change of [{eid:'device'},{orderUsage:1},{smdpStatus:'DELETED'},{smdpStatus:'ENABLED'},{esimStatus:'REVOKED'},{orderUsage:undefined},{smdpStatus:undefined}])assert.equal(profileToEsim({...fresh,...change},'order','custom').canInstall,false);
});
test('provider revocation and prior installation survive synchronization',()=>{
  const e=profileToEsim({...fresh,esimStatus:'REVOKED',smdpStatus:'DELETED',eid:'device'},'order','custom');
  assert.equal(e.status,'revoked');assert.equal(e.installedBefore,true);assert.equal(e.installationStatus,'DELETED');assert.equal(e.dataLimitGb,1);
});
