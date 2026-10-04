// ============================================================================
// God Mode per-tab queue (ORCHESTRATOR_PLAN.md slice 2): which item a run may
// take when several runs share one list. pickNextItem/queueStep are pure; the
// module's DOM/IPC side is not exercised here.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickNextItem, queueStep } = require('../src/renderer/modules/godmode.js');

const item = (at, extra = {}) => ({ text: `t${at}`, done: false, at, ...extra });
const none = new Set();

test('pickNextItem takes the first open item, in list order', () => {
  const list = [item(1, { done: true }), item(2), item(3)];
  assert.equal(pickNextItem(list, none).at, 2);
});

test('pickNextItem skips items another run has claimed', () => {
  const list = [item(1), item(2), item(3)];
  assert.equal(pickNextItem(list, new Set([1])).at, 2);
  assert.equal(pickNextItem(list, new Set([1, 2, 3])), null);
});

test('pickNextItem waits for open dependencies, but not for deleted ones', () => {
  const list = [item(1, { dependsOn: [2] }), item(2), item(3, { dependsOn: [99] })];
  assert.equal(pickNextItem(list, none).at, 2, 'item 1 waits for item 2');
  assert.equal(pickNextItem(list, new Set([2])).at, 3, 'a dependency that no longer exists blocks nothing');
  const after = [item(1, { dependsOn: [2] }), item(2, { done: true })];
  assert.equal(pickNextItem(after, none).at, 1);
});

test('pickNextItem tolerates junk input', () => {
  assert.equal(pickNextItem(null, none), null);
  assert.equal(pickNextItem([item(1, { dependsOn: 'x' })], none).at, 1);
});

test('queueStep: take, wait while others hold the rest, done when nothing is open', () => {
  const list = [item(1), item(2)];
  assert.deepEqual(queueStep(list, none), { action: 'take', item: list[0] });
  assert.deepEqual(queueStep(list, new Set([1, 2])), { action: 'wait' });
  assert.deepEqual(queueStep([item(1, { done: true })], none), { action: 'done' });
  assert.deepEqual(queueStep([], none), { action: 'done' });
});

test('queueStep waits on a dependency cycle instead of running it', () => {
  const list = [item(1, { dependsOn: [2] }), item(2, { dependsOn: [1] })];
  assert.deepEqual(queueStep(list, none), { action: 'wait' });
});
