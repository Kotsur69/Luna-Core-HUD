// nextContextNotifyState() - the hysteresis behind the Notifications widget's
// context-threshold toast, mirroring thresholds.test.js's reasoning for
// autocompact.js: the arithmetic is what's worth pinning, since a toast that
// silently stops firing (or spams) leaves nothing on screen to notice by eye.
// busyIdleCues() below pins the same-file split between the toast and the
// taskbar flash on the busy -> idle edge, for the same reason.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextContextNotifyState, busyIdleCues } = require('../src/renderer/modules/notify.js');
const { CTX_WARN_MID, CTX_WARN_HIGH } = require('../src/renderer/modules/thresholds.js');

test('below CTX_WARN_MID: never fires, and clears a stale fired flag', () => {
  assert.deepEqual(nextContextNotifyState(false, 0.1), { fired: false, shouldFire: false });
  // A session that compacted back down re-arms immediately, same as autocompact.
  assert.deepEqual(nextContextNotifyState(true, 0.1), { fired: false, shouldFire: false });
});

test('between MID and HIGH: fired flag holds, never fires', () => {
  assert.deepEqual(nextContextNotifyState(false, CTX_WARN_MID), { fired: false, shouldFire: false });
  assert.deepEqual(nextContextNotifyState(true, CTX_WARN_HIGH - 0.0001), {
    fired: true,
    shouldFire: false,
  });
});

test('crossing up through CTX_WARN_HIGH fires exactly once', () => {
  const first = nextContextNotifyState(false, CTX_WARN_HIGH);
  assert.deepEqual(first, { fired: true, shouldFire: true });

  // Next reading, still above the threshold: the edge already fired.
  const second = nextContextNotifyState(first.fired, 0.95);
  assert.deepEqual(second, { fired: true, shouldFire: false });
});

test('a session already at 90% on its very first reading still fires once', () => {
  // Unlike context.js's UI pulse (which needs a PREVIOUS reading to detect a
  // crossing), this has no such guard - arming/mounting while already hot
  // should notify on the next tick, not wait for a compact-and-reclimb.
  assert.deepEqual(nextContextNotifyState(false, 0.95), { fired: true, shouldFire: true });
});

test('re-arms only after dropping below CTX_WARN_MID, not merely below HIGH', () => {
  let state = nextContextNotifyState(false, 0.9); // fires
  state = nextContextNotifyState(state.fired, 0.7); // still mid band - no re-arm
  assert.deepEqual(state, { fired: true, shouldFire: false });
  state = nextContextNotifyState(state.fired, CTX_WARN_MID - 0.0001); // now re-armed
  assert.deepEqual(state, { fired: false, shouldFire: false });
  state = nextContextNotifyState(state.fired, 0.9); // fires again
  assert.deepEqual(state, { fired: true, shouldFire: true });
});

test('an undefined/null fired flag is treated as false', () => {
  assert.deepEqual(nextContextNotifyState(undefined, 0.9), { fired: true, shouldFire: true });
  assert.deepEqual(nextContextNotifyState(null, 0.5), { fired: false, shouldFire: false });
});

// busyIdleCues() - the split between the toast and the taskbar flash on a
// busy -> idle edge. Both regressions are silent (a cue that quietly stops, or
// one that fires where it should not), so the four corners are pinned.

test('active tab, window focused: neither cue - the LED already said it', () => {
  assert.deepEqual(busyIdleCues({ isActiveTab: true, hasFocus: true }), {
    toast: false,
    flash: false,
  });
});

test('active tab, window unfocused: both cues - you are off in another app', () => {
  assert.deepEqual(busyIdleCues({ isActiveTab: true, hasFocus: false }), {
    toast: true,
    flash: true,
  });
});

test('background tab, window focused: toast only, no flash', () => {
  // You can see the HUD, just not that tab - a toast points you at it, but
  // flashing a window that is already on top would be noise.
  assert.deepEqual(busyIdleCues({ isActiveTab: false, hasFocus: true }), {
    toast: true,
    flash: false,
  });
});

test('background tab, window unfocused: both cues', () => {
  assert.deepEqual(busyIdleCues({ isActiveTab: false, hasFocus: false }), {
    toast: true,
    flash: true,
  });
});
