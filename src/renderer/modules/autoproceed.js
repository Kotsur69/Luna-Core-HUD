// ============================================================================
// LunaCore - auto-proceed (connection-error auto-recovery)
// ----------------------------------------------------------------------------
// A toggle in the Actions section, next to Auto-compact. When ARMED, ANY
// session whose request dies mid-flight ("API Error: Connection lost
// mid-response" and friends) gets "continue" injected for it automatically
// after a short backoff. This is the same recovery godmode.js's to-do-runner
// already does for itself - generalized so it works on ordinary, non-God-Mode
// work too (Mati's actual complaint: he tasks a normal message, steps away for
// a few minutes, and comes back to a dead turn).
//
// The drop is read from the CLI's OWN TRANSCRIPT (src/observer.js's
// isApiErrorEntry -> TranscriptWatcher.onApiError -> main.js), not from the
// text on screen. Provenance is the whole design: the phrase can appear in a
// terminal for a dozen innocent reasons - a config dump, a grep hit, a code
// comment, Claude writing about the error in a reply - and while this module
// was driven by the stdout scan, every one of those cost a stray "continue"
// typed into a perfectly healthy session.
//
// Per-SESSION, not per-active-tab: main.js already tags godmode:signal with
// the sessionId it came from regardless of which tab is on screen, and
// pastePrompt() already accepts a target sessionId, so a backgrounded tab
// recovers exactly like the one you're looking at.
//
// Module-scope listeners, same deliberate deviation godmode.js documents for
// itself: the whole point is surviving the "not looking at it" case, so
// onTurnEnd/onGodModeSignal/onTools/onSessions are wired ONCE at import time
// and stay live whether or not this widget's DOM is mounted. The
// armed/disarmed check inside handleGodModeSignal is the actual gate; the
// visible toggle is the up-front friction, not continuous visibility (same
// reasoning godmode.js gives for its own listeners).
//
// Skips any session isBoundSession() already claims for godmode.js's own
// run, so an armed to-do-run and this toggle never both inject "continue"
// for the same drop.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { sfx } from './sound.js';
import { isBoundSession } from './godmode.js';
import { defineWidget } from './registry.js';

// Stop after this many "continue"s on one turn that never recovers - past that
// the session is dead, not slow, and poking it again is just noise.
const MAX_RETRIES = 3;
// Wait this long before injecting "continue". The CLI retries a dropped
// request on its own, and that retry is often slower than it looks: at 5s we
// were regularly typing "continue" into a turn that had ALREADY resumed.
// Anything the CLI recovers inside this window costs us nothing -
// handleProgress() below drops the timer as soon as the transcript shows the
// turn moving again.
const BACKOFF_MS = 15000;
// After a "continue" goes out, ignore further drop signals for this long. One
// dead request can put more than one API-error entry in the transcript (the
// CLI retries internally before giving up), and each of those entries is
// genuine - just not a genuine second drop. This window, comfortably longer
// than BACKOFF_MS, is what keeps one drop costing exactly one "continue".
// See test/autoproceed.test.js.
const POST_INJECT_QUIET_MS = 45000;

let els = null;
let autoProceedArmed = false; // off by default, not persisted - armed each session, mirrors autocompact.js

// Per-session recovery state - a backgrounded tab gets its own retry count
// and timer, independent of every other open tab.
const sessions = new Map();

function sessionState(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    // retryCount - "continue"s sent on the current unrecovered turn; the
    //              circuit breaker trips at MAX_RETRIES.
    // injectedAt - Date.now() of the last "continue" sent, for the
    //              POST_INJECT_QUIET_MS silence window.
    // timer      - the pending backoff timer, or null. A non-null timer also
    //              means "an injection is already on the way".
    s = { retryCount: 0, injectedAt: 0, timer: null };
    sessions.set(sessionId, s);
  }
  return s;
}

function clearAllPending() {
  for (const s of sessions.values()) {
    if (s.timer) clearTimeout(s.timer);
  }
  sessions.clear();
}

/**
 * Pure decision: given a session's recovery state and the current time, should
 * a "continue" be scheduled for this drop signal? The three guards that keep
 * one dropped request from becoming a burst of "continue"s all live here so
 * test/autoproceed.test.js can pin them without a DOM or fake timers.
 *
 * There is deliberately NO "the session just finished a turn, so ignore this"
 * guard any more. One used to exist, because the signal came from scanning
 * stdout and a stale error line repainted into the viewport looked exactly
 * like a fresh drop. The signal is transcript-sourced now, so it cannot be a
 * repaint - and the guard could then only do harm: a drop landing within 45s
 * of a turn end was silently swallowed, and that is 95% of the drops in the
 * transcripts on this machine, because the dying turn's own truncated flush
 * IS that turn end. See hasCompletedTurn() in src/observer.js.
 *
 * @param {{ retryCount?: number, injectedAt?: number, pending?: boolean }} state
 *   pending = an injection is already scheduled (caller passes `timer != null`).
 * @param {number} now Date.now()
 * @returns {boolean}
 */
export function shouldScheduleRecovery(state, now) {
  const retryCount = Number.isFinite(state?.retryCount) ? state.retryCount : 0;
  const injectedAt = Number.isFinite(state?.injectedAt) ? state.injectedAt : 0;
  if (state?.pending === true) return false; // one "continue" already on the way
  if (now - injectedAt < POST_INJECT_QUIET_MS) return false; // same drop, still settling
  if (retryCount >= MAX_RETRIES) return false; // session is dead, stop poking it
  return true;
}

let flashTimer = null;

/** Brief "'continue' sent" flash, then back to "armed". */
function flashSent() {
  if (!els) return;
  clearTimeout(flashTimer);
  els.field.classList.add('is-fired');
  els.status.textContent = t('autoproceed.sent');
  flashTimer = setTimeout(() => {
    flashTimer = null;
    if (!els) return;
    els.field.classList.remove('is-fired');
    render();
  }, 2500);
}

/** Refreshes the status label (i18n-aware, also called on a language switch). */
function render() {
  if (!els) return;
  if (els.field.classList.contains('is-fired')) return; // do not overwrite the flash
  els.status.textContent = autoProceedArmed ? t('autoproceed.armed') : t('autoproceed.off');
}

/** Drops a pending injection for one session. Returns its state, or null. */
function cancelPending(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  return s;
}

function handleTurnEnd({ sessionId } = {}) {
  const s = cancelPending(sessionId);
  if (!s) return;
  // A turn that actually finished - the session recovered, on its own or off
  // our "continue". The pending injection is gone (it would otherwise fire
  // "continue" into a healthy session moments later) and the circuit breaker
  // re-arms for the next, genuinely new drop.
  //
  // "Actually finished" is load-bearing. A turn killed mid-response is flushed
  // with an ordinary terminal stop_reason and used to arrive here as a
  // recovery, cancelling the very "continue" that same drop had just armed -
  // and then, the session being silent, nothing ever re-armed it.
  // src/observer.js (hasCompletedTurn) withholds those, which is what makes
  // this safe.
  //
  // injectedAt is deliberately NOT zeroed: one dead request can write several
  // error entries, and they must stay inside the silence window above.
  s.retryCount = 0;
}

/**
 * The session is demonstrably alive again: the transcript grew (a tool call
 * started or finished), which only happens on real progress. If a "continue"
 * is still sitting on the backoff timer, drop it - the CLI's own retry beat us
 * to it, and injecting now would land mid-turn as a stray second message.
 *
 * Only transcript-sourced payloads count. main.js sends `tiles` from a raw
 * stdout scan too (src/main.js, detectTools), and a TUI repaint replays old
 * tool lines - that would "prove" liveness for a session that is doing
 * nothing. `events` comes from TranscriptWatcher's structured entries, which
 * cannot be replayed by a redraw.
 *
 * Ordering note: a dying turn flushes its unfinished tool calls into the same
 * fragment as the error entry, so those events and the drop signal describe
 * the same instant. The watcher fires onApiError LAST for exactly this reason
 * (src/observer.js), so the stale liveness is consumed here BEFORE recovery is
 * armed, instead of cancelling it a moment after.
 */
function handleProgress({ sessionId, events } = {}) {
  if (!Array.isArray(events) || events.length === 0) return;
  cancelPending(sessionId);
}

/**
 * Drops recovery state for tabs that no longer exist.
 *
 * Without this, closing a tab mid-backoff leaves its "continue" on the timer;
 * it then fires against a session id main.js has already deleted. main.js
 * refuses to redirect that write now (resolveTargetSession), so the injection
 * is merely wasted rather than harmful - but the timer, the state entry and
 * the misleading "'continue' sent" flash are all still pointless. Prune them.
 */
function handleSessionList({ sessions: list } = {}) {
  for (const sessionId of staleSessionIds(sessions.keys(), list)) {
    cancelPending(sessionId);
    sessions.delete(sessionId);
  }
}

/**
 * Which of the ids we hold recovery state for are no longer open tabs. Pure,
 * so test/autoproceed.test.js can pin it without a renderer.
 *
 * A payload that is not a list is treated as "tells us nothing" - every id
 * survives. Dropping state on a malformed broadcast would cancel a legitimate
 * pending "continue".
 *
 * @param {Iterable<string>} known ids with recovery state
 * @param {unknown} list sessions[] from the sessions:update broadcast
 * @returns {string[]}
 */
export function staleSessionIds(known, list) {
  if (!Array.isArray(list)) return [];
  const live = new Set(list.map((s) => s && s.id).filter(Boolean));
  return [...known].filter((id) => !live.has(id));
}

function handleGodModeSignal({ sessionId, type } = {}) {
  if (!autoProceedArmed || type !== 'connectionError') return;
  if (isBoundSession(sessionId)) return; // godmode.js already owns this tab's recovery
  const s = sessionState(sessionId);
  // One signal per API-error entry in this session's transcript (main.js wires
  // this to the watcher, not to the stdout scan), so it is a real dropped
  // request every time. shouldScheduleRecovery() only has to collapse the
  // handful of entries a single dead request can produce.
  if (!shouldScheduleRecovery({ ...s, pending: s.timer != null }, Date.now())) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    s.retryCount += 1;
    s.injectedAt = Date.now();
    window.lunacore.pastePrompt('continue', true, sessionId);
    flashSent();
  }, BACKOFF_MS);
}

// Module-scope on purpose - see the header note. Guarded the same way
// godmode.js's own listeners are, in case this module is ever pulled into a
// plain-Node test context where window.lunacore doesn't exist.
if (typeof window !== 'undefined' && window.lunacore) {
  window.lunacore.onTurnEnd(handleTurnEnd);
  window.lunacore.onGodModeSignal(handleGodModeSignal);
  window.lunacore.onTools(handleProgress);
  window.lunacore.onSessions(handleSessionList);
}

defineWidget({
  id: 'autoproceed',
  // No titleKey: shares the "Akcje" section heading with autocompact and the
  // physical COMPACT button, same as autocompact.js.
  titleKey: '',
  template: 'w-autoproceed',
  mount(root) {
    els = {
      field: root,
      status: root.querySelector('#autoproceed-status'),
      toggle: root.querySelector('#autoproceed-toggle'),
    };

    // Repaint the armed look from module state - the clone always arrives
    // unchecked (see autocompact.js's identical note on why this matters).
    els.toggle.checked = autoProceedArmed;
    els.field.classList.toggle('is-armed', autoProceedArmed);
    render();

    els.toggle.addEventListener('change', () => {
      sfx.modeToggle();
      autoProceedArmed = els.toggle.checked;
      if (!autoProceedArmed) clearAllPending(); // disarming cancels any pending "continue"
      els.field.classList.toggle('is-armed', autoProceedArmed);
      render();
    });

    const offLang = onLangChange(render);

    return () => {
      offLang();
      clearTimeout(flashTimer);
      flashTimer = null;
      els = null;
    };
  },
});
