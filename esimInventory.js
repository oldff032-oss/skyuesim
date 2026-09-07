// Inventory is read from the provider. Credentials never leave this module.
const provider = require('./esimService');
const db = require('./db');
const storage = require('./persistentState');
const audit = require('./auditStore');
const auth = require('./adminAuthService');
function owners(iccid) {
  const found=[];
  for(const [email,u] of Object.entries(db.getAllUsers())) {
    if(u.esim?.iccid===iccid) found.push({email,kind:'primary'});
    for(const card of u.sharedEsims||[]) if(card.esim?.iccid===iccid) found.push({email,kind:'family'});
    for(const card of u.esimHistory||[]) if(card.esim?.iccid===iccid) found.push({email,kind:'history'});
  }
  return found;
}
function view(esim) {
  return Object.fromEntries(['iccid','orderNo','providerStatus','installationStatus','installedBefore','canInstall','packageName','usedGb','dataLimitGb','expiredTime'].map(k=>[k,esim[k]??null]));
}
function register(app) {
  const read=[auth.requireAdmin,auth.requireRole('super_admin')];
  const write=[...read,auth.requirePermission('esim.retry',{requireTwoFactor:true})];
  app.get('/api/admin/esim-inventory',...read,async(req,res)=>{
    try {
      const page=Number(req.query.page||1);
      if(!Number.isInteger(page)||page<1||page>10000)return res.status(400).json({error:'Некоректна сторінка'});
      const data=await provider.listOwnedProfiles(page);
      res.json({items:data.profiles.map(p=>({...view(provider.profileToEsim(p,p.orderNo,'custom')),owners:owners(p.iccid)})),pager:data.pager,checkedAt:new Date().toISOString(),customers:Object.keys(db.getAllUsers())});
    } catch(e){res.status(502).json({error:e.message});}
  });
  app.post('/api/admin/esim-inventory/:iccid/:action',...write,async(req,res)=>{
    const {iccid,action}=req.params;
    if(!/^\d{15,22}$/.test(iccid)||!['assign','suspend','unsuspend','revoke','cancel'].includes(action))return res.status(400).json({error:'Некоректна дія'});
    if(req.body?.confirmation!==iccid)return res.status(400).json({error:'Для підтвердження введіть ICCID'});
    // A durable per-profile reservation prevents double assignment across instances.
    // Failed or uncertain operations are intentionally not retried automatically.
    let reserved=false;
    try {
      const esim=await provider.recoverEsim({iccid,plan:'custom'});
      if(action==='assign') {
        const email=String(req.body?.email||'').trim().toLowerCase(),u=db.getUser(email);
        if(!u)return res.status(404).json({error:'Користувача не знайдено'});
        if(!esim.canInstall||owners(iccid).length)return res.status(409).json({error:'Картка вже встановлена, використана або прив’язана. Виберіть вільну невикористану eSIM.'});
        if(u.status==='blocked'||u.esim||u.pendingPlanChange||u.stripeSubscriptionId)return res.status(409).json({error:'Спершу завершіть керування поточною eSIM/підпискою користувача. Автоматична заміна активної картки заборонена.'});
        reserved=await storage.claimExternalEvent('inventory-assignment',iccid,'assign');
        if(!reserved)return res.status(409).json({error:'Цю картку вже призначають або призначили. Перевірте журнал.'});
        // Recheck after the asynchronous reservation.
        if(db.getUser(email)?.esim||owners(iccid).length)throw new Error('Прив’язка змінилася під час операції');
        db.saveUser(email,{esim,plan:'custom',status:'active'});
        await storage.saveNow('users.json',db.getAllUsers());
        await storage.finishExternalEvent('inventory-assignment',iccid);
        audit.log({adminEmail:req.admin.email,action:'inventory_assigned',target:email,details:{iccid}});
        return res.json({ok:true,message:'Наявну eSIM прив’язано. Нової покупки не було.'});
      }
      await provider.manageProfile(iccid,action);
      audit.log({adminEmail:req.admin.email,action:'inventory_'+action,target:iccid});
      // Provider acceptance alone is not proof of completion. Re-read before removing credentials.
      const after=await provider.recoverEsim({iccid,plan:'custom'});
      const closed=['REVOKED','CANCELED','CANCELLED'].includes(after.providerStatus);
      for(const [email,u] of Object.entries(db.getAllUsers())) {
        if(u.esim?.iccid===iccid) {
          if(closed) {
            db.saveUser(email,{esim:null,esimHistory:[...(u.esimHistory||[]),{esim:{iccid,providerStatus:after.providerStatus},reason:action,replacedAt:new Date().toISOString()}],status:u.status==='blocked'?'blocked':'registered'});
          } else db.saveUser(email,{esim:{...u.esim,...after}});
        }
        if((u.sharedEsims||[]).some(c=>c.esim?.iccid===iccid))db.saveUser(email,{sharedEsims:u.sharedEsims.map(c=>c.esim?.iccid!==iccid?c:{...c,esim:closed?{iccid,status:after.status,providerStatus:after.providerStatus}:after})});
      }
      await storage.saveNow('users.json',db.getAllUsers());
      res.json({ok:true,message:closed?'Послугу відкликано; картку прибрано з активних даних застосунку. Запис на телефоні видаляє його власник.':'Запит прийнято. Поточний стан провайдера: '+after.providerStatus,profile:view(after)});
    } catch(e) {
      audit.log({adminEmail:req.admin.email,action:'inventory_action_needs_review',target:iccid,details:{action,reserved,error:e.message}});
      res.status(502).json({error:'Операція потребує перевірки: '+e.message+'. Оновіть облік перед повторенням.'});
    }
  });
}
module.exports={register,owners,view};
