const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MOBILE_TOPUP_PROVIDER='dtone';
process.env.DTONE_ENV='preprod';
process.env.DTONE_API_KEY='test-key';
process.env.DTONE_API_SECRET='test-secret';
process.env.MOBILE_TOPUP_MARKUP_PERCENT='18';
process.env.MOBILE_TOPUP_FIXED_MARKUP='0.50';
process.env.MOBILE_TOPUP_MIN_MARKUP='0.50';

const service=require('../mobileTopupService');

const jsonResponse=(payload,status=200)=>({ok:status>=200&&status<300,status,async text(){return JSON.stringify(payload)}});

test('DT One catalogue exposes only fixed mobile-data products with server retail pricing',async()=>{
  const originalFetch=global.fetch,calls=[];
  global.fetch=async(url,options)=>{
    calls.push({url:String(url),options});
    return jsonResponse([
      {id:101,type:'FIXED_VALUE_RECHARGE',name:'10 GB Plan',description:'10 GB for 30 days',prices:{wholesale:{amount:5,unit:'USD'}},benefits:[{type:'DATA',amount:{base:10},unit:'GB'}],operator:{id:77,name:'Demo Mobile',country:{iso_code:'CZE',name:'Czechia'}}},
      {id:102,type:'FIXED_VALUE_RECHARGE',name:'Talk time',prices:{wholesale:{amount:3,unit:'USD'}},benefits:[{type:'TALKTIME',amount:{base:30},unit:'MINUTES'}],operator:{id:77,name:'Demo Mobile',country:{iso_code:'CZE',name:'Czechia'}}},
      {id:103,type:'RANGED_VALUE_RECHARGE',name:'Variable data',prices:{wholesale:{amount:2,unit:'USD'}},benefits:[{type:'DATA',amount:{base:1},unit:'GB'}],operator:{id:77,name:'Demo Mobile',country:{iso_code:'CZE',name:'Czechia'}}},
    ]);
  };
  try{
    const products=await service.listProducts({countryIsoCode:'CZE',operatorId:77});
    assert.equal(products.length,1);
    assert.equal(products[0].id,101);
    assert.equal(products[0].data,'10 GB');
    assert.equal(products[0].amountCents,640);
    assert.equal(products[0].providerCost,undefined);
    assert.match(calls[0].url,/benefit_types=DATA/);
    assert.match(calls[0].url,/type=FIXED_VALUE_RECHARGE/);
    assert.match(calls[0].options.headers.Authorization,/^Basic /);
  }finally{global.fetch=originalFetch;}
});

test('DT One purchase sends the recipient number only to the protected provider call',async()=>{
  const originalFetch=global.fetch;let requestBody=null;
  global.fetch=async(url,options)=>{
    requestBody=JSON.parse(options.body);
    return jsonResponse({id:9001,external_id:'topup_test_12345678',operator_reference:'OK-9001',status:{class:{id:7,message:'COMPLETED'},message:'COMPLETED'},confirmation_date:'2026-08-24T12:00:00Z'},201);
  };
  try{
    const result=await service.purchaseProduct({orderId:'topup_test_12345678',productId:101,phone:'+420123456789'});
    assert.equal(requestBody.product_id,101);
    assert.equal(requestBody.auto_confirm,true);
    assert.deepEqual(requestBody.credit_party_identifier,{mobile_number:'+420123456789'});
    assert.equal(result.state,'delivered');
    assert.equal(result.id,'9001');
  }finally{global.fetch=originalFetch;}
});

test('invalid recipient numbers are rejected before a provider request',async()=>{
  await assert.rejects(()=>service.purchaseProduct({orderId:'topup_test_abcdefgh',productId:101,phone:'12345'}),error=>error.code==='TOPUP_PHONE_INVALID');
});
