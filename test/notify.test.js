// nextContextNotifyState() - the hysteresis behind the Notifications widget's
// context-threshold toast, mirroring thresholds.test.js's reasoning for
// autocompact.js: the arithmetic is what's worth pinning, since a toast that
// silently stops firing (or spams) leaves nothing on screen to notice by eye.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nextContextNotifyState } = require('../src/renderer/modules/notify.js');
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
