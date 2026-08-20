function time(value){const parsed=new Date(value||0).getTime();return Number.isFinite(parsed)?parsed:0;}
function id(prefix,...parts){return `${prefix}:${parts.map(value=>String(value||'unknown')).join(':')}`;}
function money(purchase){return purchase?.amountCents==null?null:{amount:Number(purchase.amountCents)/100,currency:String(purchase.currency||'usd').toUpperCase()};}
function severityRank(value){return {critical:4,error:3,warning:2,info:1}[value]||0;}

function buildAttention({users,tickets,diagnostics,operations}){
  const items=[];
  const add=item=>{if(!operations.resolvedAttention?.[item.id])items.push({...item,status:'open'});};
  for(const user of users){
    for(const purchase of user.purchases||[]){
      const common={email:user.email,purchaseId:purchase.id,at:purchase.failedAt||purchase.updatedAt||purchase.createdAt,plan:purchase.packageName||purchase.plan||null,...money(purchase)};
      if(purchase.paymentStatus==='paid'&&['failed','not_recorded'].includes(purchase.fulfillmentStatus))add({id:id('paid-no-esim',user.email,purchase.id),kind:'payment_ok_esim_failed',severity:'critical',title:'Оплату отримано, eSIM не видано',explanation:purchase.fulfillmentError||'Після підтвердженої оплати профіль eSIM не створено.',recommendedAction:'Перевірити баланс провайдера та повторити безпечну видачу.',action:'retry_provision',...common});
      if(purchase.fulfillmentStatus==='provisioned'&&!purchase.iccid&&!purchase.esimOrderNo)add({id:id('esim-no-qr',user.email,purchase.id),kind:'esim_without_qr',severity:'error',title:'eSIM без QR/ICCID',explanation:'Покупка позначена виданою, але немає ідентифікатора профілю.',recommendedAction:'Синхронізувати покупку та перевірити замовлення у провайдера.',action:'open_purchase',...common});
      if(purchase.refundStatus==='failed'||purchase.refundError)add({id:id('refund-failed',user.email,purchase.id),kind:'refund_failed',severity:'error',title:'Помилка повернення коштів',explanation:purchase.refundError||'Stripe не підтвердив повернення.',recommendedAction:'Відкрити покупку й повторити повернення після перевірки Stripe.',action:'open_purchase',...common});
      if(purchase.cancellationError)add({id:id('refund-active-sub',user.email,purchase.id),kind:'subscription_cancel_failed',severity:'critical',title:'Підписка не скасувалася',explanation:purchase.cancellationError,recommendedAction:'Скасувати підписку в Stripe та синхронізувати акаунт.',action:'open_purchase',...common});
    }
    if(user.lastRenewalError)add({id:id('renewal',user.email,user.lastRenewalFailedAt),kind:'renewal_failed',severity:'error',title:'Автопоновлення не виконано',explanation:user.lastRenewalError,recommendedAction:'Перевірити Stripe invoice і сумісний top-up пакет.',action:'open_user',email:user.email,at:user.lastRenewalFailedAt||user.updatedAt,plan:user.plan});
    if(user.status==='payment_ok_esim_failed'&&!(user.purchases||[]).some(p=>p.fulfillmentStatus==='failed'))add({id:id('legacy-paid-no-esim',user.email),kind:'payment_ok_esim_failed',severity:'critical',title:'Оплата є, eSIM відсутня',explanation:user.lastEsimProvisionError||'Акаунт має аварійний статус.',recommendedAction:'Синхронізувати покупки Stripe, потім повторити видачу.',action:'open_user',email:user.email,at:user.updatedAt,plan:user.plan});
  }
  for(const event of diagnostics.filter(item=>item.outcome==='failed'||item.severity==='error')){
    if(['email','push'].includes(event.source)||['translation','referral','plan_change'].includes(event.type))add({id:id('diagnostic',event.id),kind:`${event.source}_${event.type}_failed`,severity:event.severity==='error'?'error':'warning',title:event.message||'Операція завершилася помилкою',explanation:event.errorCode||event.message,recommendedAction:event.source==='email'||event.source==='push'?'Перевірити доставку та повторити.':'Відкрити діагностику й виконати рекомендовану дію.',action:'open_diagnostic',email:event.email,at:event.createdAt,purchaseId:event.purchaseId,code:event.errorCode});
  }
  for(const delivery of operations.deliveryEvents||[])if(delivery.status==='failed')add({id:id('delivery',delivery.id),kind:'delivery_failed',severity:'warning',title:`Не доставлено ${delivery.channel}`,explanation:delivery.error||'Провайдер відхилив повідомлення.',recommendedAction:'Перевірити адресу/підписку та повторити доставку.',action:'retry_delivery',email:delivery.recipient,at:delivery.updatedAt,deliveryId:delivery.id});
  for(const ticket of tickets)if(!ticket.assignedTo&&!['resolved','closed'].includes(ticket.status))add({id:id('ticket',ticket.id),kind:'unassigned_ticket',severity:ticket.priority==='urgent'?'critical':'warning',title:`Звернення #${ticket.id} без виконавця`,explanation:ticket.subject,recommendedAction:'Призначити відповідального адміністратора.',action:'open_ticket',email:ticket.email,at:ticket.createdAt,ticketId:ticket.id});
  return items.sort((a,b)=>severityRank(b.severity)-severityRank(a.severity)||time(b.at)-time(a.at));
}

function reconciliation(users){
  const issues=[];let payments=0,provisioned=0,refunded=0;
  for(const user of users)for(const p of user.purchases||[]){
    payments+=p.paymentStatus==='paid'?1:0;provisioned+=p.fulfillmentStatus==='provisioned'?1:0;refunded+=p.refundStatus==='succeeded'||p.refunded?1:0;
    if(p.paymentStatus==='paid'&&!['provisioned','scheduled','provisioning'].includes(p.fulfillmentStatus))issues.push({id:id('recon-payment',user.email,p.id),type:'payment_without_esim',email:user.email,purchaseId:p.id,amount:money(p),detail:p.fulfillmentError||'Оплата не має завершеної видачі'});
    if(p.fulfillmentStatus==='provisioned'&&p.paymentStatus&&p.paymentStatus!=='paid')issues.push({id:id('recon-esim',user.email,p.id),type:'esim_without_payment',email:user.email,purchaseId:p.id,detail:'eSIM видана без підтвердженого paid'});
    if((p.refundStatus==='succeeded'||p.refunded)&&user.subscription?.status==='active')issues.push({id:id('recon-refund',user.email,p.id),type:'active_after_refund',email:user.email,purchaseId:p.id,detail:'Після повернення підписка все ще активна'});
  }
  return {summary:{payments,provisioned,refunded,issues:issues.length},issues};
}

function supportMetrics(tickets){
  const now=Date.now();let firstTotal=0,firstCount=0,resolutionTotal=0,resolutionCount=0;
  const enriched=tickets.map(ticket=>{const messages=ticket.messages||[],firstAdmin=messages.find(m=>m.from==='admin'),resolved=['resolved','closed'].includes(ticket.status);const firstResponseMinutes=firstAdmin?Math.round((time(firstAdmin.createdAt)-time(ticket.createdAt))/60000):null;const resolutionMinutes=resolved?Math.round((time(ticket.updatedAt)-time(ticket.createdAt))/60000):null;if(firstResponseMinutes!=null){firstTotal+=firstResponseMinutes;firstCount++;}if(resolutionMinutes!=null){resolutionTotal+=resolutionMinutes;resolutionCount++;}const slaMinutes=ticket.priority==='urgent'?60:ticket.priority==='high'?240:1440;return {...ticket,slaMinutes,firstResponseMinutes,resolutionMinutes,overdue:!resolved&&now-time(ticket.createdAt)>slaMinutes*60000};});
  const adminEmails=[...new Set(enriched.flatMap(ticket=>[
    ticket.assignedTo,
    ...(ticket.messages||[]).map(message=>message.adminEmail),
  ].filter(Boolean)))];
  const byAdmin=adminEmails.map(email=>{
    const handled=enriched.filter(ticket=>ticket.assignedTo===email||(ticket.messages||[]).some(message=>message.adminEmail===email));
    const responses=handled.map(ticket=>{
      const first=(ticket.messages||[]).find(message=>message.from==='admin'&&message.adminEmail===email);
      return first?Math.max(0,Math.round((time(first.createdAt)-time(ticket.createdAt))/60000)):null;
    }).filter(value=>value!=null);
    const resolved=handled.filter(ticket=>['resolved','closed'].includes(ticket.status));
    return {
      email,
      handled:handled.length,
      replies:handled.reduce((sum,ticket)=>sum+(ticket.messages||[]).filter(message=>message.from==='admin'&&message.adminEmail===email).length,0),
      averageFirstResponseMinutes:responses.length?Math.round(responses.reduce((sum,value)=>sum+value,0)/responses.length):null,
      averageResolutionMinutes:resolved.length?Math.round(resolved.reduce((sum,ticket)=>sum+Math.max(0,(time(ticket.resolvedAt||ticket.updatedAt)-time(ticket.createdAt))/60000),0)/resolved.length):null,
      overdue:handled.filter(ticket=>ticket.overdue).length,
      reopened:handled.filter(ticket=>ticket.reopenedAt).length,
    };
  }).sort((a,b)=>b.handled-a.handled);
  return {tickets:enriched,byAdmin,summary:{open:enriched.filter(t=>!['resolved','closed'].includes(t.status)).length,overdue:enriched.filter(t=>t.overdue).length,unassigned:enriched.filter(t=>!t.assignedTo&&!['resolved','closed'].includes(t.status)).length,averageFirstResponseMinutes:firstCount?Math.round(firstTotal/firstCount):null,averageResolutionMinutes:resolutionCount?Math.round(resolutionTotal/resolutionCount):null,reopened:enriched.filter(t=>t.reopenedAt).length}};
}

function userTimeline(email,{users,tickets,diagnostics,audit}){
  const user=users.find(item=>item.email===email);if(!user)return null;const events=[];
  const add=(type,title,at,detail=null)=>{if(at)events.push({type,title,at,detail});};
  add('account','Реєстрація',user.createdAt);add('login','Останній вхід',user.lastLoginAt);add('security','Зміна пароля',user.passwordChangedAt);add('security','Зміна PIN',user.pinChangedAt);
  for(const p of user.purchases||[]){add('payment','Покупка оплачена',p.paidAt||p.createdAt,`${p.packageName||p.plan||'eSIM'} · ${p.amountCents==null?'—':(p.amountCents/100).toFixed(2)} ${(p.currency||'').toUpperCase()}`);add('esim','eSIM видана',p.fulfilledAt,p.iccid?`ICCID …${String(p.iccid).slice(-4)}`:null);add('refund','Повернення коштів',p.refundedAt,p.refundStatus||null);}
  for(const t of tickets.filter(item=>item.email===email)){add('support',`Звернення #${t.id} створено`,t.createdAt,t.subject);for(const m of t.messages||[])add('support',m.from==='admin'?'Відповідь підтримки':m.from==='user'?'Повідомлення користувача':'Внутрішня нотатка',m.createdAt,`#${t.id}`);}
  for(const d of diagnostics.filter(item=>item.email===email))add(d.type,d.message||d.action,d.createdAt,d.errorCode);
  for(const a of audit.filter(item=>String(item.target||'').toLowerCase()===email))add('admin',a.action,a.timestamp,a.adminEmail);
  return {user:{email:user.email,status:user.status,plan:user.plan},events:events.sort((a,b)=>time(b.at)-time(a.at)).slice(0,1000)};
}

function dailyReport({users,tickets,diagnostics,operations,support}){
  const since=Date.now()-86400000,within=value=>time(value)>=since,purchases=users.flatMap(u=>(u.purchases||[]).map(p=>({...p,email:u.email}))).filter(p=>within(p.paidAt||p.createdAt));
  const revenue=purchases.filter(p=>p.paymentStatus==='paid').reduce((sum,p)=>sum+Number(p.amountCents||0),0)/100;
  const failures=diagnostics.filter(d=>within(d.createdAt)&&d.severity==='error').length;
  return {createdAt:new Date().toISOString(),periodHours:24,status:failures||support.summary.overdue?'attention':'healthy',newUsers:users.filter(u=>within(u.createdAt)).length,purchases:purchases.length,revenueUsd:+revenue.toFixed(2),refunds:purchases.filter(p=>p.refundStatus==='succeeded'||p.refunded).length,issuedEsims:purchases.filter(p=>p.fulfillmentStatus==='provisioned').length,failures,openTickets:support.summary.open,overdueTickets:support.summary.overdue,averageFirstResponseMinutes:support.summary.averageFirstResponseMinutes,averageRating:(()=>{const f=(operations.feedback||[]).filter(x=>within(x.createdAt));return f.length?+(f.reduce((s,x)=>s+Number(x.rating||0),0)/f.length).toFixed(1):null;})(),suspiciousLogins:(operations.securityEvents||[]).filter(e=>within(e.createdAt)).length,providerBalance:operations.providerBalance};
}

module.exports={buildAttention,reconciliation,supportMetrics,userTimeline,dailyReport};
