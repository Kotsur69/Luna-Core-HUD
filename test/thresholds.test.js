// E3 tests - the context-window threshold-crossing detector.
//
// ctxLevel() is trivial on its own. It's tested because the "pulse only
// upward" rule depends on its ORDERING: if it returned band names instead of
// numbers, the `level > lastLevel` comparison would silently stop working -
// and a pulse that never fires doesn't throw an error. Nobody would notice.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ctxLevel, CTX_WARN_MID, CTX_WARN_HIGH } = require('../src/renderer/modules/thresholds.js');

test('ctxLevel maps three bands', () => {
  assert.equal(ctxLevel(0), 0);
  assert.equal(ctxLevel(0.59), 0);
  assert.equal(ctxLevel(CTX_WARN_MID), 1);
  assert.equal(ctxLevel(0.84), 1);
  assert.equal(ctxLevel(CTX_WARN_HIGH), 2);
  assert.equal(ctxLevel(1), 2);
});

// Thresholds are closed from below - exactly 85% IS already the red zone.
test('band boundaries belong to the higher band', () => {
  assert.equal(ctxLevel(CTX_WARN_MID - 0.0001), 0);
  assert.equal(ctxLevel(CTX_WARN_HIGH - 0.0001), 1);
});

test('ctxLevel is resilient to a missing reading', () => {
  assert.equal(ctxLevel(null), 0);
  assert.equal(ctxLevel(undefined), 0);
  assert.equal(ctxLevel(NaN), 0);
  assert.equal(ctxLevel('0.9'), 0);
});

// THIS IS THE REASON THIS FILE EXISTS. The pulse rule can't be checked
// without a DOM, but its ARITHMETIC can. We reproduce context.js's condition here.
test('the pulse only fires on an UPWARD crossing', () => {
  const crossings = [];
  let last = null;

  // Session path: calm -> 60% -> 90% -> compact -> upward again.
  for (const [pct, live] of [
    [0.1, true],
    [0.62, true], // 0 -> 1, pulse
    [0.7, true],
    [0.88, true], // 1 -> 2, pulse
    [0.95, true],
    [0.2, true], // down after compact - NO pulse
    [0.9, true], // upward again, pulse
  ]) {
    const level = ctxLevel(pct);
    if (live && last !== null && level > last) crossings.push(pct);
    last = level;
  }

  assert.deepEqual(crossings, [0.62, 0.88, 0.9]);
});

// Switching tabs replays remembered metrics with live=false. Without this
// guard, clicking between two tabs would fire alarms endlessly.
test('replaying a tab view does not count as a crossing', () => {
  let last = ctxLevel(0.1);
  let pulses = 0;

  const level = ctxLevel(0.95);
  const live = false; // tab switch
  if (live && last !== null && level > last) pulses += 1;
  last = level;

  assert.equal(pulses, 0);
  assert.equal(last, 2, 'but the band should still update, or it will pulse right after');
});

// A session that is ALREADY at 90% at the moment of the first reading hasn't
// crossed anything - it arrived that way.
test('a session\'s first reading never pulses', () => {
  const last = null;
  const level = ctxLevel(0.9);
  assert.equal(last !== null && level > last, false);
});
