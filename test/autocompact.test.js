// autocompact.js pure trigger logic - the four deciders behind an armed
// auto-compact (Feature #4: context / turns / time). Same reasoning as
// notify.test.js and thresholds.test.js: a /compact that silently stops firing
// (or fires in a loop) leaves nothing on screen to catch by eye, so the
// ARITHMETIC is pinned here even though the injection itself needs a DOM.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextThresholdState,
  nextTurnState,
  nextTimeState,
  canAutoCompactFire,
  normalizeMode,
} = require('../src/renderer/modules/autocompact.js');
const { CTX_WARN_MID, CTX_WARN_HIGH } = require('../src/renderer/modules/thresholds.js');

const COOLDOWN_MS = 60000;
const MIN = 60000;

// ---- 'context' mode: nextThresholdState ------------------------------------

test('context: below the re-arm floor clears a stale fired flag, never fires', () => {
  assert.deepEqual(nextThresholdState(true, CTX_WARN_MID - 0.0001), {
    fired: false,
    shouldFire: false,
  });
  assert.deepEqual(nextThresholdState(false, 0.1), { fired: false, shouldFire: false });
});

test('context: between the re-arm floor and the trigger, the flag holds, never fires', () => {
  assert.deepEqual(nextThresholdState(false, CTX_WARN_MID), { fired: false, shouldFire: false });
  assert.deepEqual(nextThresholdState(true, CTX_WARN_HIGH - 0.0001), {
    fired: true,
    shouldFire: false,
  });
});

test('context: crossing up through the threshold fires exactly once', () => {
  const first = nextThresholdState(false, CTX_WARN_HIGH);
  assert.deepEqual(first, { fired: true, shouldFire: true });
  // Next reading, still above: the edge already fired.
  assert.deepEqual(nextThresholdState(first.fired, 0.95), { fired: true, shouldFire: false });
});

test('context: a session already hot on its very first reading still fires', () => {
  assert.deepEqual(nextThresholdState(false, 0.97), { fired: true, shouldFire: true });
});

test('context: re-arms only below the mid floor, not merely below the trigger', () => {
  let s = nextThresholdState(false, 0.9); // fires
  s = nextThresholdState(s.fired, 0.7); // mid band - still latched
  assert.deepEqual(s, { fired: true, shouldFire: false });
  s = nextThresholdState(s.fired, CTX_WARN_MID - 0.0001); // now re-armed
  assert.deepEqual(s, { fired: false, shouldFire: false });
  s = nextThresholdState(s.fired, 0.9); // fires again
  assert.deepEqual(s, { fired: true, shouldFire: true });
});

test('context: an undefined fired flag is treated as false', () => {
  assert.deepEqual(nextThresholdState(undefined, 0.9), { fired: true, shouldFire: true });
});

// ---- 'turns' mode: nextTurnState -----------------------------------------

test('turns: counts up without firing until N is reached, then fires on the Nth', () => {
  let count = 0;
  for (let i = 1; i <= 19; i += 1) {
    const s = nextTurnState(count, 20);
    count = s.turnCount;
    assert.equal(s.shouldFire, false, `turn ${i} must not fire`);
  }
  assert.deepEqual(nextTurnState(count, 20), { turnCount: 20, shouldFire: true });
});

test('turns: exact boundary - N=1 fires on every turn', () => {
  assert.deepEqual(nextTurnState(0, 1), { turnCount: 1, shouldFire: true });
  assert.deepEqual(nextTurnState(5, 1), { turnCount: 6, shouldFire: true });
});

test('turns: a blocked fire does not reset the counter - it keeps asking', () => {
  // fireCompact() is what zeroes turnCount; a blocked gate() leaves it >= N so
  // the very next turn asks again.
  let s = nextTurnState(19, 20);
  assert.deepEqual(s, { turnCount: 20, shouldFire: true });
  s = nextTurnState(s.turnCount, 20);
  assert.deepEqual(s, { turnCount: 21, shouldFire: true });
});

test('turns: a corrupt target (< 1) is inert', () => {
  assert.equal(nextTurnState(50, 0).shouldFire, false);
  assert.equal(nextTurnState(50, -3).shouldFire, false);
});

test('turns: a non-numeric running count restarts from 1', () => {
  assert.deepEqual(nextTurnState(undefined, 20), { turnCount: 1, shouldFire: false });
});

// ---- 'time' mode: nextTimeState ----------------------------------------

test('time: not due yet - never fires, whatever the context', () => {
  assert.deepEqual(nextTimeState(29 * MIN, 0.99, 30), { shouldFire: false });
});

test('time: due but below the 60% context floor - held', () => {
  assert.deepEqual(nextTimeState(45 * MIN, CTX_WARN_MID - 0.0001, 30), { shouldFire: false });
});

test('time: due and past the floor - fires', () => {
  assert.deepEqual(nextTimeState(30 * MIN, CTX_WARN_MID, 30), { shouldFire: true });
});

test('time: exact boundary - elapsed === afterMinutes counts as due', () => {
  assert.deepEqual(nextTimeState(30 * MIN, 0.75, 30), { shouldFire: true });
});

test('time: a corrupt target (< 1) is inert', () => {
  assert.deepEqual(nextTimeState(9999 * MIN, 0.99, 0), { shouldFire: false });
});

// ---- the shared gate: canAutoCompactFire ------------------------------

const OK = { armed: true, mounted: true, ledDead: false, sinceLastFireMs: COOLDOWN_MS };

test('gate: every precondition met - allowed', () => {
  assert.equal(canAutoCompactFire(OK), true);
});

test('gate: not armed - blocked', () => {
  assert.equal(canAutoCompactFire({ ...OK, armed: false }), false);
});

test('gate: the toggle is off screen (not mounted) - blocked', () => {
  // An injector the user cannot see or disarm is exactly what the "zero
  // surprise token spend" rule forbids (§A2).
  assert.equal(canAutoCompactFire({ ...OK, mounted: false }), false);
});

test('gate: dead session - blocked (nowhere to inject)', () => {
  assert.equal(canAutoCompactFire({ ...OK, ledDead: true }), false);
});

test('gate: inside the 60 s cooldown - blocked; exactly at 60 s - allowed', () => {
  assert.equal(canAutoCompactFire({ ...OK, sinceLastFireMs: 59999 }), false);
  assert.equal(canAutoCompactFire({ ...OK, sinceLastFireMs: 60000 }), true);
});

// ---- normalizeMode ---------------------------------------------------

test('normalizeMode: passes the three known modes, else falls back to context', () => {
  for (const m of ['context', 'turns', 'time']) assert.equal(normalizeMode(m), m);
  for (const bad of ['', 'threshold', undefined, null, 7]) {
    assert.equal(normalizeMode(bad), 'context');
  }
});
