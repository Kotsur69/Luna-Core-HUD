// autoproceed.js recovery decider - the guards that keep ONE connection drop
// from turning into a burst of "continue"s. main.js re-fires the
// connectionError signal for every stdout chunk that still shows the error
// line (no de-dupe there, by design - see src/main.js:610), so if this logic
// is loose Mati comes back to two or three stacked "continue"s. Same reasoning
// as autocompact.test.js: the arithmetic is pinned here, the DOM + backoff
// timer wiring is not.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldScheduleRecovery } = require('../src/renderer/modules/autoproceed.js');

// Mirror the module constants (kept in sync by eye, like COOLDOWN_MS in
// autocompact.test.js).
const MAX_RETRIES = 3;
const QUIET_MS = 30000;
const T0 = 1_000_000; // an arbitrary "now"

test('a fresh drop schedules exactly one continue', () => {
  assert.equal(shouldScheduleRecovery({ retryCount: 0, injectedAt: 0, pending: false }, T0), true);
});

test('repeated signals while a continue is already pending schedule nothing', () => {
  const pending = { retryCount: 0, injectedAt: 0, pending: true };
  for (let i = 0; i < 10; i += 1) {
    assert.equal(shouldScheduleRecovery(pending, T0 + i * 500), false, `repaint ${i}`);
  }
});

test('for the whole quiet window after a send, the lingering error text is ignored', () => {
  const justSent = { retryCount: 1, injectedAt: T0, pending: false };
  assert.equal(shouldScheduleRecovery(justSent, T0 + 1), false);
  assert.equal(shouldScheduleRecovery(justSent, T0 + QUIET_MS - 1), false);
});

test('a genuine new drop after the quiet window schedules another continue', () => {
  const recovered = { retryCount: 1, injectedAt: T0, pending: false };
  assert.equal(shouldScheduleRecovery(recovered, T0 + QUIET_MS), true);
});

test('circuit breaker: no more continues once MAX_RETRIES have gone unanswered', () => {
  const dead = { retryCount: MAX_RETRIES, injectedAt: T0, pending: false };
  assert.equal(shouldScheduleRecovery(dead, T0 + QUIET_MS * 10), false);
});

test('one drop cannot cost more than MAX_RETRIES continues', () => {
  // Walk the state the way handleGodModeSignal + the backoff timer would:
  // schedule -> send (retryCount++, injectedAt = now) -> quiet window ->
  // next repaint. handleTurnEnd is never called - the turn never recovers.
  let state = { retryCount: 0, injectedAt: 0 };
  let now = T0;
  let sent = 0;
  for (let repaint = 0; repaint < 20; repaint += 1) {
    if (shouldScheduleRecovery({ ...state, pending: false }, now)) {
      state = { retryCount: state.retryCount + 1, injectedAt: now }; // "continue" goes out
      sent += 1;
    }
    now += QUIET_MS; // next repaint lands after the silence window
  }
  assert.equal(sent, MAX_RETRIES);
});

test('a turn-end style reset re-arms recovery for a later drop', () => {
  // handleTurnEnd zeroes retryCount + injectedAt after a real turn ends.
  assert.equal(
    shouldScheduleRecovery({ retryCount: 0, injectedAt: 0, pending: false }, T0 + 9e9),
    true
  );
});

test('missing or malformed state fields are treated as zero', () => {
  assert.equal(shouldScheduleRecovery({}, T0), true);
  assert.equal(shouldScheduleRecovery({ retryCount: undefined, injectedAt: NaN }, T0), true);
  assert.equal(shouldScheduleRecovery(undefined, T0), true);
});
