require('dotenv').config();
const crypto=require('crypto');
const emailTemplates=require('./emailTemplates');

function isEmailConfigured(){return Boolean(process.env.RESEND_API_KEY&&process.env.RESEND_API_KEY!=='your_resend_api_key_here');}

async function resendRequest(path,options={}){
  const response=await fetch(`https://api.resend.com${path}`,{...options,headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,...options.headers}});
  if(!response.ok){const details=await response.text();throw new Error(`Resend error: ${response.status} ${details}`);}
  return response.json();
}

async function sendEmail({to,subject,html,replyTo}){
  if(!isEmailConfigured()){console.log(`[emailService] MOCK: "${subject}" to ${to}`);return {mocked:true};}
  const payload={from:process.env.RESEND_FROM_EMAIL||'Signal <onboarding@resend.dev>',to:Array.isArray(to)?to:[to],subject,html};
  if(replyTo)payload.reply_to=replyTo;
  return resendRequest('/emails',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
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

module.exports={sendVerificationCode,sendEmail,getReceivedEmail,verifyInboundSignature,isEmailConfigured};
