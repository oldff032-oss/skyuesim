const crypto = require('crypto');

const FORMAT = 'signal-encrypted-backup';
const VERSION = 1;

function getKey() {
  const secret=String(process.env.BACKUP_ENCRYPTION_KEY||'');
  if(secret.length<24) throw Object.assign(new Error('BACKUP_ENCRYPTION_KEY не налаштовано або він закороткий'),{code:'BACKUP_NOT_CONFIGURED'});
  return secret;
}

function encrypt(payload) {
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=crypto.scryptSync(getKey(),salt,32),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const plaintext=Buffer.from(JSON.stringify(payload),'utf8');
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return Buffer.from(JSON.stringify({format:FORMAT,version:VERSION,algorithm:'AES-256-GCM',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')}),'utf8');
}

function decrypt(buffer) {
  let envelope;
  try{envelope=JSON.parse(Buffer.from(buffer).toString('utf8'));}catch{throw Object.assign(new Error('Це не файл резервної копії Signal'),{code:'BACKUP_INVALID'});}
  if(envelope?.format!==FORMAT||envelope?.version!==VERSION)throw Object.assign(new Error('Непідтримуваний формат резервної копії'),{code:'BACKUP_INVALID'});
  try{
    const salt=Buffer.from(envelope.salt,'base64'),iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64'),encrypted=Buffer.from(envelope.data,'base64');
    const key=crypto.scryptSync(getKey(),salt,32),decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(encrypted),decipher.final()]).toString('utf8'));
  }catch(error){throw Object.assign(new Error('Не вдалося розшифрувати копію: неправильний ключ або файл пошкоджено'),{code:'BACKUP_DECRYPT_FAILED'});}
}

function validate(payload) {
  const required=['users.json','auth.json','admins.json','tickets.json','audit-log.json','operations.json','push-subscriptions.json','diagnostics.json','translations.json'];
  if(!payload||payload.schemaVersion!==1||!payload.data||required.some(key=>!(key in payload.data)))throw Object.assign(new Error('Копія неповна або має неправильну структуру'),{code:'BACKUP_SCHEMA_INVALID'});
  const admins=payload.data['admins.json']?.admins||{};
  if(!Object.values(admins).some(admin=>admin.role==='super_admin'&&!admin.blocked))throw Object.assign(new Error('У копії немає активного Super Admin'),{code:'BACKUP_NO_SUPER_ADMIN'});
  return payload;
}

function sanitizeTransient(data) {
  const clean=JSON.parse(JSON.stringify(data));
  if(clean['auth.json']){clean['auth.json'].codes={};clean['auth.json'].verifyTokens={};clean['auth.json'].sessions={};clean['auth.json'].resetCodes={};clean['auth.json'].resetTokens={};}
  if(clean['admins.json']){clean['admins.json'].sessions={};clean['admins.json'].twoFactorChallenges={};}
  return clean;
}

function summary(payload) {
  const data=payload.data;
  return {createdAt:payload.createdAt,backupId:payload.backupId,users:Object.keys(data['users.json']||{}).length,loginAccounts:Object.keys(data['auth.json']?.users||{}).length,admins:Object.keys(data['admins.json']?.admins||{}).length,tickets:(data['tickets.json']?.tickets||[]).length,auditEntries:(data['audit-log.json']?.entries||[]).length,announcements:(data['operations.json']?.announcements||[]).length,pushDevices:Object.keys(data['push-subscriptions.json']?.subscriptions||{}).length,diagnostics:(data['diagnostics.json']?.events||[]).length};
}

module.exports={encrypt,decrypt,validate,sanitizeTransient,summary};
