// Phone swipe-to-reveal (mobile/src/swipe.js): where a released row settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleSwipe, clampOffset } from '../mobile/src/swipe.js';

const W = 88; // revealed action width

test('settleSwipe opens past half the action width, closes short of it', () => {
  assert.equal(settleSwipe({ offset: -50, velocity: 0, width: W }), true);
  assert.equal(settleSwipe({ offset: -30, velocity: 0, width: W }), false);
});

test('settleSwipe follows a quick flick regardless of distance', () => {
  assert.equal(settleSwipe({ offset: -10, velocity: -0.8, width: W }), true, 'flick left opens');
  assert.equal(settleSwipe({ offset: -80, velocity: 0.8, width: W }), false, 'flick right closes');
});

test('clampOffset keeps the row between closed and a little past the action', () => {
  assert.equal(clampOffset(20, W), 0, 'never drags right of closed');
  assert.equal(clampOffset(-40, W), -40);
  assert.ok(clampOffset(-300, W) > -300 && clampOffset(-300, W) < -W, 'rubber-bands past the action');
});
