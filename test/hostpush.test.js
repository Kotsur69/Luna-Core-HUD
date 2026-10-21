// ============================================================================
// LunaCore - Web Push requests from a PC / host (src/hostpush.js)
// ----------------------------------------------------------------------------
// Usage alerts at 80 % / 95 %, once per window (only the top level on a jump),
// chat events with their dedupe key, and nothing but event, machine and key in
// the request body.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { usageAlerts, createHostPush } = require('../src/hostpush');

const RESET = 1_800_000_000_000;
const snap = (five, week = 10) => ({ v: 1, at: RESET - 1000, fiveHour: { pct: five, resetsAt: RESET }, sevenDay: { pct: week, resetsAt: RESET + 86400000 } });

test('no alert under 80 %', () => {
  assert.deepEqual(usageAlerts(snap(79), new Set()).alerts, []);
});

test('80 % fires once per window; 95 % fires next; a new window fires again', () => {
  let r = usageAlerts(snap(81), new Set());
  assert.deepEqual(r.alerts.map((a) => [a.window, a.level]), [['fiveHour', 80]]);
  r = usageAlerts(snap(85), r.sent);
  assert.deepEqual(r.alerts, []);
  r = usageAlerts(snap(96), r.sent);
  assert.deepEqual(r.alerts.map((a) => a.level), [95]);
  const next = { ...snap(82), fiveHour: { pct: 82, resetsAt: RESET + 5 * 3600000 } };
  assert.deepEqual(usageAlerts(next, r.sent).alerts.map((a) => a.level), [80]);
});

test('a jump straight to 96 % is one alert, and a reset time wobbling by seconds is the same window', () => {
  const r = usageAlerts(snap(96, 97), new Set());
  assert.deepEqual(r.alerts.map((a) => [a.window, a.level]), [['fiveHour', 95], ['sevenDay', 95]]);
  const wobble = { ...snap(96, 97), fiveHour: { pct: 96, resetsAt: RESET + 2000 } };
  assert.deepEqual(usageAlerts(wobble, r.sent).alerts.map((a) => a.window), []);
});

test('junk snapshots raise nothing', () => {
  assert.deepEqual(usageAlerts(null, new Set()).alerts, []);
  assert.deepEqual(usageAlerts({ fiveHour: { pct: 'x' } }, new Set()).alerts, []);
});

test('requests carry only event, machine, key (and window/level for usage)', async () => {
  const bodies = [];
  const push = createHostPush({ invoke: async (b) => bodies.push(b), machine: 'KT-PC', log: () => {} });
  await push.chat('approval', { sessionId: 's', key: 'approval:req-1', text: 'rm -rf /' });
  await push.chat('evil', { key: 'k' });
  await push.usage(snap(90));
  await push.usage(snap(90));
  assert.deepEqual(bodies[0], { event: 'approval', machine: 'KT-PC', key: 'approval:req-1' });
  assert.equal(bodies.length, 2);
  assert.deepEqual(Object.keys(bodies[1]).sort(), ['event', 'key', 'level', 'machine', 'window']);
});

test('a failed invoke is logged, never thrown', async () => {
  const lines = [];
  const push = createHostPush({ invoke: async () => { throw new Error('offline'); }, machine: 'KT', log: (l) => lines.push(l) });
  await push.chat('done', { key: 'done:s:0' });
  assert.match(lines[0], /done failed: offline/);
});
