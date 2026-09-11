// autoproceed.js recovery decider - the guards that keep ONE dropped request
// from turning into a burst of "continue"s. The signal is transcript-sourced
// (TranscriptWatcher.onApiError -> main.js), so it fires once per API-error
// entry the CLI writes - and one dead request can write several of those
// before it gives up. If this logic is loose Mati comes back to two or three
// stacked "continue"s. Same reasoning as autocompact.test.js: the arithmetic
// is pinned here, the DOM + backoff timer wiring is not.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldScheduleRecovery, staleSessionIds } = require('../src/renderer/modules/autoproceed.js');

// Mirror the module constants (kept in sync by eye, like COOLDOWN_MS in
// autocompact.test.js).
const MAX_RETRIES = 3;
const QUIET_MS = 45000; // POST_INJECT_QUIET_MS
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
  // next signal. handleTurnEnd is never called - the turn never recovers.
  let state = { retryCount: 0, injectedAt: 0 };
  let now = T0;
  let sent = 0;
  for (let signal = 0; signal < 20; signal += 1) {
    if (shouldScheduleRecovery({ ...state, pending: false }, now)) {
      state = { ...state, retryCount: state.retryCount + 1, injectedAt: now }; // "continue" goes out
      sent += 1;
    }
    now += QUIET_MS; // the next signal lands after the silence window
  }
  assert.equal(sent, MAX_RETRIES);
});

// ---- a drop right after a turn end (the "waited 20 minutes" bug) ------------
// This decider used to carry a POST_RECOVERY_QUIET_MS guard: any signal within
// 45s of a turn end was dismissed as the stale error line being repainted into
// the viewport. That guard is what made auto-proceed look dead. A request that
// dies mid-response is flushed with an ordinary terminal stop_reason, so the
// dying turn REPORTS ITSELF as a completed turn moments before the drop is
// announced - 95% of the real drops in the transcripts on this machine land
// inside that window. src/observer.js (hasCompletedTurn) now withholds those
// bogus turn ends, and the signal can no longer be a repaint, so the guard is
// gone: the only thing it could still do was swallow a real drop.

test('a drop seconds after a turn end is not swallowed', () => {
  // handleTurnEnd's post-state: retryCount re-armed, injectedAt kept. A drop
  // arriving right behind it must still schedule.
  const justEnded = { retryCount: 0, injectedAt: 0, pending: false };
  assert.equal(shouldScheduleRecovery(justEnded, T0 + 1), true);
  assert.equal(shouldScheduleRecovery(justEnded, T0 + 2000), true);
});

test('one dead request writing several error entries costs exactly one continue', () => {
  // The CLI retries internally before it gives up, so a single drop can append
  // two or three API-error entries within a few seconds. Each is a real entry,
  // none is a new drop.
  let state = { retryCount: 0, injectedAt: 0 };
  let now = T0;
  let sent = 0;
  const send = () => {
    state = { ...state, retryCount: state.retryCount + 1, injectedAt: now };
    sent += 1;
  };
  if (shouldScheduleRecovery({ ...state, pending: false }, now)) send();
  for (let entry = 0; entry < 5; entry += 1) {
    now += 5000; // the CLI's own retries, a few seconds apart
    if (shouldScheduleRecovery({ ...state, pending: false }, now)) send();
  }
  assert.equal(sent, 1);
});

test('a second genuine drop after the quiet window schedules again', () => {
  const settled = { retryCount: 0, injectedAt: T0, pending: false };
  assert.equal(shouldScheduleRecovery(settled, T0 + QUIET_MS), true);
});

test('missing or malformed state fields are treated as zero', () => {
  assert.equal(shouldScheduleRecovery({}, T0), true);
  assert.equal(shouldScheduleRecovery({ retryCount: undefined, injectedAt: NaN }, T0), true);
  assert.equal(shouldScheduleRecovery({ unknownField: NaN }, T0), true);
  assert.equal(shouldScheduleRecovery(undefined, T0), true);
});

// ---- staleSessionIds (the "continue landed in the wrong terminal" bug) ------
// A tab closed mid-backoff used to leave its injection on the timer; main.js
// then could not resolve the id and fell back to the ACTIVE tab, so a
// background session's "continue" was typed into a terminal that never
// dropped its connection. main.js refuses to redirect now; this prunes the
// leftover state that pointed at the dead tab.

const openTabs = (...ids) => ids.map((id) => ({ id, alive: true }));

test('staleSessionIds finds the tab that is no longer open', () => {
  assert.deepEqual(staleSessionIds(['s1', 's2'], openTabs('s1')), ['s2']);
});

test('staleSessionIds keeps every id while all tabs are open', () => {
  assert.deepEqual(staleSessionIds(['s1', 's2'], openTabs('s1', 's2')), []);
});

test('staleSessionIds accepts a Map keys() iterator, not just an array', () => {
  const state = new Map([['s1', {}], ['s9', {}]]);
  assert.deepEqual(staleSessionIds(state.keys(), openTabs('s1')), ['s9']);
});

test('staleSessionIds drops nothing when the broadcast is malformed', () => {
  // "Tells us nothing" must not read as "every tab is gone" - that would
  // cancel a legitimate pending "continue".
  assert.deepEqual(staleSessionIds(['s1'], undefined), []);
  assert.deepEqual(staleSessionIds(['s1'], null), []);
  assert.deepEqual(staleSessionIds(['s1'], 'nonsense'), []);
});

test('staleSessionIds ignores junk entries in the tab list', () => {
  assert.deepEqual(staleSessionIds(['s1', 's2'], [null, { id: 's1' }, {}, 42]), ['s2']);
});

test('staleSessionIds treats an empty tab list as everything gone', () => {
  assert.deepEqual(staleSessionIds(['s1', 's2'], []), ['s1', 's2']);
});
