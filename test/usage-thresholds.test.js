// nextUsageAnnounced() - pure decision behind the 50%/80% voice announcements
// (SOUNDS_IMPLEMENTATION_PLAN.md §3). main.js does the actual
// soundManager.play(); this only tests the state machine.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextUsageAnnounced } = require('../src/usage.js');

const FRESH = { at50: false, at80: false };

test('below 50% fires nothing and state does not change', () => {
  const { next, fire } = nextUsageAnnounced(30, FRESH);
  assert.equal(fire, null);
  assert.deepEqual(next, FRESH);
});

test('crossing 50% fires usage50 once', () => {
  const first = nextUsageAnnounced(55, FRESH);
  assert.equal(first.fire, 'usage50');
  assert.deepEqual(first.next, { at50: true, at80: false });

  // A second read at the same level - does not fire again.
  const second = nextUsageAnnounced(60, first.next);
  assert.equal(second.fire, null);
  assert.deepEqual(second.next, { at50: true, at80: false });
});

test('crossing 80% fires usage80, even when usage50 never fired', () => {
  const { next, fire } = nextUsageAnnounced(85, FRESH);
  assert.equal(fire, 'usage80');
  // Crossing 80 covers 50 too - both flags come back true so a later poll
  // can't fire the now-redundant usage50 after usage80 already announced.
  assert.deepEqual(next, { at50: true, at80: true });
});

test('80% wins over 50% when both thresholds are crossed at once', () => {
  const { next, fire } = nextUsageAnnounced(90, FRESH);
  assert.equal(fire, 'usage80');
  // Crossing 80 covers 50 too - both flags come back true so a later poll
  // can't fire the now-redundant usage50 after usage80 already announced.
  assert.deepEqual(next, { at50: true, at80: true });
});

test('after usage80, another read >=50% fires nothing more', () => {
  const after80 = nextUsageAnnounced(90, FRESH).next;
  const { next, fire } = nextUsageAnnounced(95, after80);
  assert.equal(fire, null);
  assert.deepEqual(next, after80);
});

test('dropping below 40% re-arms both thresholds', () => {
  const announced = { at50: true, at80: true };
  const { next, fire } = nextUsageAnnounced(35, announced);
  assert.equal(fire, null);
  assert.deepEqual(next, FRESH);
});

test('wobbling exactly at 50% between reads does not re-arm (the 40-50 zone)', () => {
  const afterFirst = nextUsageAnnounced(50, FRESH).next; // { at50: true, at80: false }
  const wobble = nextUsageAnnounced(49, afterFirst);
  assert.equal(wobble.fire, null);
  assert.deepEqual(wobble.next, afterFirst); // still armed - didn't drop below 40
});

test('an unknown/missing percent does not change state or fire anything', () => {
  const announced = { at50: true, at80: false };
  assert.deepEqual(nextUsageAnnounced(null, announced), { next: announced, fire: null });
  assert.deepEqual(nextUsageAnnounced(undefined, announced), { next: announced, fire: null });
  assert.deepEqual(nextUsageAnnounced('80', announced), { next: announced, fire: null });
});
