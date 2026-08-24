(function(){
  'use strict';
  const STORAGE_KEY='signal_offline_esim_v1';
  const encoder=new TextEncoder(),decoder=new TextDecoder();
  const toBase64=bytes=>{let binary='';for(const byte of new Uint8Array(bytes))binary+=String.fromCharCode(byte);return btoa(binary)};
  const fromBase64=value=>{const binary=atob(value),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i+=1)bytes[i]=binary.charCodeAt(i);return bytes};
  async function keyFromPin(pin,salt){
    if(!/^\d{6}$/.test(String(pin||'')))throw new Error('Офлайн-PIN має містити рівно 6 цифр.');
    const material=await crypto.subtle.importKey('raw',encoder.encode(pin),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:210000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function decrypt(pin){
    const stored=localStorage.getItem(STORAGE_KEY);if(!stored)return {version:1,cards:[]};
    try{const envelope=JSON.parse(stored),salt=fromBase64(envelope.salt),iv=fromBase64(envelope.iv),key=await keyFromPin(pin,salt),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,fromBase64(envelope.payload)),vault=JSON.parse(decoder.decode(plain));return {version:1,cards:Array.isArray(vault.cards)?vault.cards:[]};}
    catch{throw new Error('Невірний офлайн-PIN або пошкоджені локальні дані.');}
  }
  async function encrypt(vault,pin){
    const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await keyFromPin(pin,salt),payload=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(JSON.stringify(vault)));
    localStorage.setItem(STORAGE_KEY,JSON.stringify({version:1,salt:toBase64(salt),iv:toBase64(iv),payload:toBase64(payload),updatedAt:new Date().toISOString()}));
  }
  async function imageAsDataUrl(url){
    if(!url||String(url).startsWith('data:'))return url||null;
    try{const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error('image');const blob=await response.blob();if(blob.size>900000)throw new Error('large');return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)});}catch{return null;}
  }
  async function prepareCard(card){
    const qrDataUrl=await imageAsDataUrl(card.qrCodeUrl);
    return {id:String(card.id||'primary').slice(0,100),ownerLabel:String(card.ownerLabel||'Моя eSIM').slice(0,80),packageName:String(card.packageName||'eSIM').slice(0,120),location:String(card.location||'').slice(0,100)||null,activationCode:String(card.activationCode||'').slice(0,500)||null,qrDataUrl,apn:String(card.apn||'').slice(0,120)||null,iccidLast4:card.iccid?String(card.iccid).slice(-4):null,status:String(card.status||'active').slice(0,50),expiredTime:card.expiredTime||null,savedAt:new Date().toISOString()};
  }
  async function saveCard(card,pin){const vault=await decrypt(pin),safe=await prepareCard(card),index=vault.cards.findIndex(item=>item.id===safe.id);if(index>=0)vault.cards[index]=safe;else vault.cards.unshift(safe);vault.cards=vault.cards.slice(0,30);await encrypt(vault,pin);return safe;}
  async function removeCard(id,pin){const vault=await decrypt(pin);vault.cards=vault.cards.filter(item=>item.id!==id);if(vault.cards.length)await encrypt(vault,pin);else localStorage.removeItem(STORAGE_KEY);return vault.cards;}
  window.SignalOfflineEsimVault={exists:()=>Boolean(localStorage.getItem(STORAGE_KEY)),unlock:decrypt,saveCard,removeCard,clear:()=>localStorage.removeItem(STORAGE_KEY)};
})();
