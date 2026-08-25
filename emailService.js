require('dotenv').config();
const crypto=require('crypto');
const emailTemplates=require('./emailTemplates');
const operationsStore=require('./operationsStore');

const DEFAULT_APP_URL='https://esimsignalapp.com';

function cleanHeader(value,maximum=200){return String(value||'').replace(/[\r\n]+/g,' ').trim().slice(0,maximum);}
function senderAddress(value=process.env.RESEND_FROM_EMAIL){
  const sender=cleanHeader(value,320);
  return /^(?:[^<>]+\s*)?<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(sender)||/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender)?sender:'';
}
function isEmailConfigured(){return Boolean(process.env.RESEND_API_KEY&&process.env.RESEND_API_KEY!=='your_resend_api_key_here'&&senderAddress());}

function plainTextFromHtml(html=''){
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_,url,label)=>`${label}: ${url}`)
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/p>|<\/div>|<\/h[1-6]>|<\/tr>/gi,'\n')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&lt;/gi,'<')
    .replace(/&gt;/gi,'>')
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&#(\d+);/g,(_,code)=>String.fromCodePoint(Number(code)))
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n[ \t]+/g,'\n')
    .replace(/[ \t]{2,}/g,' ')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

async function resendRequest(path,options={}){
  const response=await fetch(`https://api.resend.com${path}`,{...options,headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,...options.headers}});
  if(!response.ok){const details=await response.text();throw new Error(`Resend error: ${response.status} ${details}`);}
  return response.json();
}

async function sendEmail({to,subject,html,text,replyTo}){
  const recipient=Array.isArray(to)?to.join(', '):to;
  const safeSubject=cleanHeader(subject||'Signal',200);
  const delivery=operationsStore.recordDelivery({channel:'email',recipient,subject:safeSubject,status:'pending'});
  if(!isEmailConfigured()){operationsStore.updateDelivery(delivery.id,{status:'disabled',error:'RESEND_API_KEY або RESEND_FROM_EMAIL не налаштовано'});console.log(`[emailService] MOCK: "${safeSubject}" to ${to}`);return {mocked:true};}
  const recipients=(Array.isArray(to)?to:[to]).map(value=>cleanHeader(value,320)).filter(Boolean);
  if(!recipients.length)throw new Error('Не вказано отримувача email');
  const htmlBody=String(html||'');
  const textBody=String(text||plainTextFromHtml(htmlBody)||`${safeSubject}\n\nВідкрийте застосунок Signal: ${process.env.FRONTEND_URL||DEFAULT_APP_URL}`).slice(0,100000);
  const payload={from:senderAddress(),to:recipients,subject:safeSubject,html:htmlBody,text:textBody};
  const safeReplyTo=senderAddress(replyTo||process.env.RESEND_REPLY_TO_EMAIL);
  if(safeReplyTo)payload.reply_to=safeReplyTo.replace(/^.*<([^>]+)>$/,'$1');
  try{const result=await resendRequest('/emails',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});operationsStore.updateDelivery(delivery.id,{status:'sent',providerId:result?.id||null});return result;}
  catch(error){operationsStore.updateDelivery(delivery.id,{status:'failed',error:error.message});throw error;}
}

async function sendVerificationCode(email,code){
  return sendEmail({to:email,subject:'Код підтвердження — Signal',html:emailTemplates.verificationCode({code})});
}

async function getReceivedEmail(emailId){return resendRequest(`/emails/receiving/${encodeURIComponent(emailId)}`);}

function verifyInboundSignature(rawBody,headers){
  const secret=process.env.RESEND_WEBHOOK_SECRET;
  if(!secret)throw new Error('RESEND_WEBHOOK_SECRET не встановлено');
  const id=headers['svix-id'],timestamp=headers['svix-timestamp'],signature=headers['svix-signature'];
  if(!id||!timestamp||!signature)throw new Error('Відсутні заголовки підпису');
  if(Math.abs(Date.now()/1000-Number(timestamp))>5*60)throw new Error('Timestamp outside tolerance');
  const secretBytes=Buffer.from(secret.replace(/^whsec_/,''),'base64');
  const expected=crypto.createHmac('sha256',secretBytes).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  const valid=signature.split(' ').map(item=>item.split(',')[1]).filter(Boolean);
  if(!valid.some(value=>{const a=Buffer.from(value),b=Buffer.from(expected);return a.length===b.length&&crypto.timingSafeEqual(a,b);}))throw new Error('Невірний підпис вебхука');
  return true;
}

module.exports={sendVerificationCode,sendEmail,getReceivedEmail,verifyInboundSignature,isEmailConfigured,plainTextFromHtml,senderAddress};
