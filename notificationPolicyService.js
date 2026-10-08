const DEFAULT_TRAFFIC_THRESHOLDS = Object.freeze([20, 50, 80, 100]);
const AVAILABLE_TRAFFIC_THRESHOLDS = Object.freeze([20, 50, 70, 80, 100]);

function normalizeThresholds(value) {
  if (!Array.isArray(value)) return [...DEFAULT_TRAFFIC_THRESHOLDS];
  const numeric = value.map(Number);
  // The previous release used 50/80/95. Seeing an unsupported value means the
  // account has not chosen the new set yet, so migrate it to the safe defaults.
  if (!numeric.length || numeric.some(item => !AVAILABLE_TRAFFIC_THRESHOLDS.includes(item))) return [...DEFAULT_TRAFFIC_THRESHOLDS];
  const selected = [...new Set(numeric)].sort((a, b) => a - b);
  return selected.length ? selected : [...DEFAULT_TRAFFIC_THRESHOLDS];
}

function cycleKey(esim = {}) {
  return [
    esim.orderNo,
    esim.iccid,
    esim.esimTranNo,
    esim.lastTopupAt,
    esim.activateTime,
    esim.expiredTime,
  ].map(value => String(value || '').trim()).join('|') || 'no-active-package';
}

function usagePercent(usedBytes, totalBytes) {
  const used = Number(usedBytes), total = Number(totalBytes);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((used / total) * 100)));
}

function formatGb(bytes) {
  const value = Math.max(0, Number(bytes) || 0) / (1024 ** 3);
  return `${value.toLocaleString('uk-UA', { minimumFractionDigits: value < 1 ? 2 : 1, maximumFractionDigits: 2 })} ГБ`;
}

function notificationFor(threshold, { usedBytes, totalBytes, percent }) {
  const remainingBytes = Math.max(0, Number(totalBytes) - Number(usedBytes));
  const remaining = formatGb(remainingBytes), total = formatGb(totalBytes);
  const content = {
    20: { title: 'Пакет під контролем', body: `Використано 20%. Залишилося ${remaining} із ${total}.` },
    50: { title: 'Половину пакета використано', body: `Залишилося ${remaining}. Перевір прогноз, щоб інтернету вистачило до кінця подорожі.` },
    70: { title: 'Використано 70% пакета', body: `Залишилося ${remaining}. За потреби підготуй наступний пакет заздалегідь.` },
    80: { title: 'Залишилося близько 20% інтернету', body: `Доступно ${remaining}. Smart Assist допоможе не залишитися без зв’язку.` },
    100: { title: 'Інтернет у пакеті закінчився', body: 'Трафік використано повністю. Додай сумісний пакет, щоб знову бути онлайн.' },
  }[threshold] || { title: `Використано ${percent}% пакета`, body: `Залишилося ${remaining}.` };
  const critical = threshold >= 80;
  return {
    ...content,
    url: critical ? '/esim-topup.html' : '/usage.html',
    tag: `traffic-${threshold}`,
    requireInteraction: threshold === 100,
    actions: critical
      ? [{ action: 'usage', title: 'Переглянути' }, { action: 'topup', title: 'Додати пакет' }]
      : [{ action: 'usage', title: 'Переглянути витрати' }],
  };
}

function currentUsage(user = {}, usage = {}) {
  const totalBytes = usage.totalBytes ?? user.esim?.totalBytes ?? (user.esim?.dataLimitGb == null ? null : Math.round(Number(user.esim.dataLimitGb) * (1024 ** 3)));
  const usedBytes = usage.usedBytes ?? user.esim?.usedBytes ?? Math.round(Number(user.esim?.usedGb || 0) * (1024 ** 3));
  return { usedBytes: Number(usedBytes), totalBytes: totalBytes == null ? null : Number(totalBytes), percent: usagePercent(usedBytes, totalBytes) };
}

function initialState(user, thresholds, current, now) {
  const legacy = Number(user.esim?.lastPushAlertThreshold) || null;
  const baseline = legacy == null ? current.percent : Math.max(current.percent, legacy);
  return {
    cycleKey: cycleKey(user.esim),
    sentThresholds: thresholds.filter(value => value <= baseline),
    baselinePercent: current.percent,
    lastObservedPercent: current.percent,
    lastObservedAt: now,
    lastSentAt: null,
    history: [],
  };
}

function evaluateTrafficAlert(user = {}, usage = {}, now = new Date().toISOString()) {
  const thresholds = normalizeThresholds(user.preferences?.trafficAlertThresholds);
  const current = currentUsage(user, usage);
  if (current.percent == null) return { state: user.trafficAlertState || null, notification: null, threshold: null, current };
  const key = cycleKey(user.esim), previous = user.trafficAlertState;
  if (!previous || previous.cycleKey !== key) {
    return { state: initialState(user, thresholds, current, now), notification: null, threshold: null, current, initialized: true };
  }
  const sent = new Set(Array.isArray(previous.sentThresholds) ? previous.sentThresholds.map(Number) : []);
  const due = thresholds.filter(value => current.percent >= value && !sent.has(value));
  const threshold = due.length ? due[due.length - 1] : null;
  if (threshold) thresholds.filter(value => value <= threshold).forEach(value => sent.add(value));
  const notification = threshold ? notificationFor(threshold, current) : null;
  const history = Array.isArray(previous.history) ? previous.history.slice(-19) : [];
  if (notification) history.push({ threshold, percent: current.percent, title: notification.title, body: notification.body, createdAt: now });
  return {
    threshold,
    notification,
    current,
    state: {
      ...previous,
      cycleKey: key,
      sentThresholds: [...sent].sort((a, b) => a - b),
      lastObservedPercent: current.percent,
      lastObservedAt: now,
      lastSentAt: notification ? now : previous.lastSentAt || null,
      history,
    },
  };
}

function rebaseTrafficAlertState(user = {}, thresholds = DEFAULT_TRAFFIC_THRESHOLDS) {
  const current = currentUsage(user);
  const normalized = normalizeThresholds(thresholds), now = new Date().toISOString();
  const previous = user.trafficAlertState || {};
  return {
    ...previous,
    cycleKey: cycleKey(user.esim),
    sentThresholds: current.percent == null ? [] : normalized.filter(value => value <= current.percent),
    baselinePercent: current.percent,
    lastObservedPercent: current.percent,
    lastObservedAt: now,
    history: Array.isArray(previous.history) ? previous.history.slice(-20) : [],
  };
}

function smartAssistPreference(user = {}) {
  const value = user.smartAssist || {};
  return {
    enabled: value.enabled !== false,
    thresholdGb: Number.isFinite(Number(value.thresholdGb)) ? Number(value.thresholdGb) : 1,
    maxMonthlySpendCents: Number.isInteger(Number(value.maxMonthlySpendCents)) ? Number(value.maxMonthlySpendCents) : 2000,
    forecastDays: [1, 3, 5, 7].includes(Number(value.forecastDays)) ? Number(value.forecastDays) : 3,
    expiryReminderDays: Array.isArray(value.expiryReminderDays) ? value.expiryReminderDays.filter(day => [1, 3, 7].includes(Number(day))).map(Number) : [3, 1],
    channels: { push: value.channels?.push !== false, inApp: value.channels?.inApp !== false, email: value.channels?.email === true },
    quietHours: { enabled: value.quietHours?.enabled === true, start: value.quietHours?.start || '22:00', end: value.quietHours?.end || '08:00' },
    packageRecommendations: value.packageRecommendations !== false,
    requiresConfirmation: true,
    updatedAt: value.updatedAt || null,
  };
}

module.exports = {
  DEFAULT_TRAFFIC_THRESHOLDS,
  AVAILABLE_TRAFFIC_THRESHOLDS,
  normalizeThresholds,
  cycleKey,
  usagePercent,
  notificationFor,
  evaluateTrafficAlert,
  rebaseTrafficAlertState,
  smartAssistPreference,
};
