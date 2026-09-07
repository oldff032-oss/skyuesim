const crypto = require('crypto');

const clean = value => String(value || '').trim();
const upper = value => clean(value).toUpperCase();

function identityValue(esim = {}) {
  // ICCID is present on both the provider profile and the matching purchase,
  // so it keeps one physical profile from appearing twice in the inventory.
  return clean(esim.iccid || esim.esimTranNo || esim.orderNo);
}

function profileId(esim = {}) {
  const identity = identityValue(esim);
  if (!identity) return null;
  return `esim_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
}

function profileState(esim = {}, override = '') {
  const forced = upper(override || esim.lifecycleState);
  const smdp = upper(esim.smdpStatus);
  const provider = upper(esim.esimStatus || esim.status);
  if (['REVOKED', 'CANCELLED', 'CANCELED', 'DETACHED', 'QUARANTINED'].includes(forced)) return forced === 'CANCELED' ? 'cancelled' : forced.toLowerCase();
  if (provider.includes('REVOK')) return 'revoked';
  if (provider.includes('CANCEL')) return 'cancelled';
  if (provider.includes('EXPIRED')) return 'expired';
  if (provider.includes('SUSPEND')) return 'suspended';
  if (provider === 'USED_UP') return 'used_up';
  if (smdp === 'DELETED') return 'deleted_from_device';
  if (smdp === 'RELEASED' && (!provider || provider === 'GOT_RESOURCE' || provider === 'NEW') && !esim.activateTime && !esim.eidBound && esim.canInstall !== false && !(Number(esim.usedGb) > 0)) return 'available';
  if (['DOWNLOAD', 'DOWNLOADED', 'INSTALLATION', 'INSTALLED'].includes(smdp)) return 'installed';
  if (['ENABLED', 'DISABLED'].includes(smdp) || provider === 'IN_USE' || esim.activateTime || esim.eidBound) return 'active';
  return 'unknown';
}

const labels = {
  available: 'Готова до встановлення', active: 'Використовується', installed: 'Встановлена', suspended: 'Призупинена',
  used_up: 'Пакет вичерпано', expired: 'Строк завершено', deleted_from_device: 'Видалена з пристрою',
  cancelled: 'Скасована з поверненням', revoked: 'Відкликана назавжди', detached: 'Відв’язана',
  quarantined: 'Потребує перевірки', unknown: 'Статус не підтверджено',
};

function maskReference(value, visible = 5) {
  const text = clean(value);
  if (!text) return null;
  if (text.length <= visible) return `•••${text}`;
  return `•••• ${text.slice(-visible)}`;
}

function capabilities(state, source) {
  const current = source === 'current';
  return {
    canAssign: source === 'pool' && state === 'available',
    canDetach: current && state === 'available',
    canCancel: ['current', 'pool'].includes(source) && state === 'available',
    canSuspend: current && ['active', 'installed'].includes(state),
    canUnsuspend: current && state === 'suspended',
    canRevoke: ['current', 'pool'].includes(source) && ['active', 'installed', 'suspended', 'used_up', 'unknown', 'quarantined'].includes(state),
    canSync: ['current', 'pool', 'purchase'].includes(source) && !['revoked', 'cancelled'].includes(state),
  };
}

function publicRecord(record) {
  const state = profileState(record.profile, record.stateOverride);
  return {
    id: record.id,
    source: record.source,
    state,
    stateLabel: labels[state] || labels.unknown,
    ownerEmail: record.ownerEmail || null,
    previousOwnerEmail: record.previousOwnerEmail || null,
    recipientName: record.recipientName || null,
    plan: record.plan || null,
    packageName: record.packageName || null,
    purchaseId: record.purchaseId || null,
    provider: record.profile?.provider || null,
    iccidLast4: clean(record.profile?.iccid).slice(-4) || null,
    orderReference: maskReference(record.profile?.orderNo, 6),
    transactionReference: maskReference(record.profile?.esimTranNo, 6),
    smdpStatus: record.profile?.smdpStatus || null,
    esimStatus: record.profile?.esimStatus || record.profile?.status || null,
    activateTime: record.profile?.activateTime || null,
    expiredTime: record.profile?.expiredTime || null,
    lastUpdateTime: record.profile?.lastUpdateTime || record.profile?.recoveredAt || record.storedAt || null,
    ...capabilities(state, record.source),
  };
}

function collectInventory(users = {}, pool = []) {
  const records = new Map();
  const priorities = { current: 100, family: 90, pool: 80, history: 60, purchase: 20 };
  const add = record => {
    const id = record.id || profileId(record.profile);
    if (!id) return;
    const next = { ...record, id };
    const previous = records.get(id);
    if (!previous || priorities[next.source] > priorities[previous.source]) records.set(id, next);
  };

  for (const item of Array.isArray(pool) ? pool : []) add({ ...item, source: 'pool' });
  for (const user of Object.values(users || {})) {
    const purchases = Array.isArray(user.purchases) ? user.purchases : [];
    const purchaseFor = esim => purchases.find(item => [item.iccid, item.esimOrderNo, item.esimTranNo].filter(Boolean).some(value => [esim?.iccid, esim?.orderNo, esim?.esimTranNo].includes(value))) || null;
    if (user.esim) {
      const purchase = purchaseFor(user.esim);
      add({ source:'current', ownerEmail:user.email, plan:user.esim.plan || user.plan, packageName:user.esim.packageName || purchase?.packageName || null, purchaseId:purchase?.id || null, profile:user.esim });
    }
    for (const shared of user.sharedEsims || []) add({ source:'family', ownerEmail:user.email, recipientName:shared.recipientName || null, plan:shared.plan || user.plan, packageName:shared.packageName || null, purchaseId:shared.purchaseId || null, profile:shared.esim });
    for (const entry of user.esimHistory || []) add({ source:'history', ownerEmail:user.email, plan:entry.plan || null, packageName:entry.packageName || null, purchaseId:entry.purchaseId || null, profile:entry.esim || entry });
    for (const purchase of purchases) {
      if (!purchase.iccid && !purchase.esimOrderNo && !purchase.esimTranNo) continue;
      add({ source:'purchase', ownerEmail:user.email, plan:purchase.plan || user.plan, packageName:purchase.packageName || null, purchaseId:purchase.id || null, profile:{ iccid:purchase.iccid, orderNo:purchase.esimOrderNo, esimTranNo:purchase.esimTranNo, provider:'esim-access' } });
    }
  }
  return [...records.values()].sort((a, b) => new Date(b.profile?.lastUpdateTime || b.storedAt || 0) - new Date(a.profile?.lastUpdateTime || a.storedAt || 0));
}

module.exports = { profileId, profileState, publicRecord, collectInventory };
