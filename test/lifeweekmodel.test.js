// ============================================================================
// LunaCore - Life dashboard Week tab view math (renderer/modules/lifeweekmodel.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classRows, mailLine, generateTargets, costText } = require('../src/renderer/modules/lifeweekmodel.js');

test('classRows: shares of the hours split, zero classes and unknown data left out', () => {
  assert.deepEqual(classRows({ totalH: 10, byClass: { work: 6, fun: 4, other: 0, unassigned: 0 } }), [
    { cls: 'work', hours: 6, share: 0.6 },
    { cls: 'fun', hours: 4, share: 0.4 },
  ]);
  assert.deepEqual(classRows({ error: 'failed' }), []);
  assert.deepEqual(classRows({ totalH: 0, byClass: {} }), []);
});

test('mailLine: sent > failed > no Gmail > pending / off', () => {
  const view = { gmail: { connected: true }, mailOn: true };
  assert.equal(mailLine({ mail: { sentAt: 5, error: null } }, view).key, 'life.week.mail.sent');
  assert.deepEqual(mailLine({ mail: { sentAt: null, error: 'gmail-auth' } }, view), { key: 'life.week.mail.failed', vars: { reason: 'gmail-auth' } });
  assert.equal(mailLine({ mail: null }, { gmail: { connected: false } }).key, 'life.week.mail.noGmail');
  assert.equal(mailLine({ mail: null }, view).key, 'life.week.mail.pending');
  assert.equal(mailLine({ mail: null }, { ...view, mailOn: false }).key, 'life.week.mail.off');
});

test('generateTargets marks weeks that already have a review', () => {
  assert.deepEqual(generateTargets({ weeks: [{ week: '2026-W42' }], generatable: ['2026-W43', '2026-W42'] }), [
    { week: '2026-W43', exists: false },
    { week: '2026-W42', exists: true },
  ]);
  assert.deepEqual(generateTargets(null), []);
});

test('costText', () => {
  assert.equal(costText(0.0123), '$0.0123');
  assert.equal(costText(1.5), '$1.50');
  assert.equal(costText(null), '');
});
