const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../notificationPolicyService');

const GB = 1024 ** 3;
function user(overrides = {}) {
  return {
    preferences: { trafficAlertThresholds: [20, 50, 80, 100] },
    esim: { orderNo: 'B123', iccid: '8943', esimTranNo: 'T123', activateTime: '2026-01-01T00:00:00Z' },
    ...overrides,
  };
}

test('first observation becomes a baseline and does not create retroactive alerts', () => {
  const result = policy.evaluateTrafficAlert(user(), { usedBytes: 12 * GB, totalBytes: 20 * GB }, '2026-10-08T08:00:00Z');
  assert.equal(result.initialized, true);
  assert.equal(result.notification, null);
  assert.deepEqual(result.state.sentThresholds, [20, 50]);
});

test('a threshold is sent once and is not repeated after a counter correction', () => {
  const first = policy.evaluateTrafficAlert(user({ trafficAlertState: { cycleKey: policy.cycleKey(user().esim), sentThresholds: [20], history: [] } }), { usedBytes: 11 * GB, totalBytes: 20 * GB });
  assert.equal(first.threshold, 50);
  const again = policy.evaluateTrafficAlert(user({ trafficAlertState: first.state }), { usedBytes: 9 * GB, totalBytes: 20 * GB });
  assert.equal(again.notification, null);
  assert.deepEqual(again.state.sentThresholds, [20, 50]);
});

test('jumping across thresholds creates one current alert and marks lower thresholds complete', () => {
  const state = { cycleKey: policy.cycleKey(user().esim), sentThresholds: [20], history: [] };
  const result = policy.evaluateTrafficAlert(user({ trafficAlertState: state }), { usedBytes: 17 * GB, totalBytes: 20 * GB });
  assert.equal(result.threshold, 80);
  assert.deepEqual(result.state.sentThresholds, [20, 50, 80]);
  assert.equal(result.state.history.length, 1);
});

test('notification wording is human and contains no technical Signal prefix', () => {
  const half = policy.notificationFor(50, { usedBytes: 10 * GB, totalBytes: 20 * GB, percent: 50 });
  const empty = policy.notificationFor(100, { usedBytes: 20 * GB, totalBytes: 20 * GB, percent: 100 });
  assert.equal(half.title, 'Половину пакета використано');
  assert.doesNotMatch(half.title, /^Сигнал:/i);
  assert.equal(empty.requireInteraction, true);
  assert.equal(empty.actions[1].action, 'topup');
});

test('default smart assistant is useful without enabling traffic email spam', () => {
  const preference = policy.smartAssistPreference({});
  assert.equal(preference.enabled, true);
  assert.deepEqual(preference.channels, { push: true, inApp: true, email: false });
  assert.equal(preference.forecastDays, 3);
});

test('legacy 50/80/95 settings migrate to the new safe defaults', () => {
  assert.deepEqual(policy.normalizeThresholds([50, 80, 95]), [20, 50, 80, 100]);
});
