// ============================================================================
// LunaCore - auto-proceed (connection-error auto-recovery)
// ----------------------------------------------------------------------------
// A toggle in the Actions section, next to Auto-compact. When ARMED, ANY
// session whose stdout matches the "connectionError" sound trigger ("API
// Error: Connection lost mid-response") gets "continue" injected for it
// automatically after a short backoff. This is the same recovery godmode.js's
// to-do-runner already does for itself - generalized so it works on ordinary,
// non-God-Mode work too (Mati's actual complaint: he tasks a normal message,
// steps away for a few minutes, and comes back to a dead turn).
//
// Per-SESSION, not per-active-tab: main.js already tags godmode:signal with
// the sessionId it came from regardless of which tab is on screen
// (main.js:560-565), and pastePrompt() already accepts a target sessionId, so
// a backgrounded tab recovers exactly like the one you're looking at.
//
// Module-scope listeners, same deliberate deviation godmode.js documents for
// itself: the whole point is surviving the "not looking at it" case, so
// onTurnEnd/onGodModeSignal are wired ONCE at import time and stay live
// whether or not this widget's DOM is mounted. The armed/disarmed check
// inside handleGodModeSignal is the actual gate; the visible toggle is the
// up-front friction, not continuous visibility (same reasoning godmode.js
// gives for its own listeners).
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
// Wait this long before injecting "continue" - a dropped turn often comes back
// on the CLI's own retry within a second or two, and then we inject nothing.
const BACKOFF_MS = 5000;
// After a "continue" goes out, ignore the connectionError trigger for this
// long. The error line the CLI already printed keeps getting repainted into
// the TUI viewport for as long as it is on screen - the whole reconnect
// included - so every repaint after our injection is the SAME drop, not a new
// one. This window (comfortably longer than BACKOFF_MS) is what stops one drop
// turning into three "continue"s. See test/autoproceed.test.js.
const POST_INJECT_QUIET_MS = 30000;

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
    //              means "an injection is already on the way, ignore repaints".
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
 * a "continue" be scheduled for this connectionError signal? The three guards
 * that keep one connection drop from becoming a burst of "continue"s all live
 * here so test/autoproceed.test.js can pin them without a DOM or fake timers.
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
  if (now - injectedAt < POST_INJECT_QUIET_MS) return false; // same drop, error text still on screen
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

function handleTurnEnd({ sessionId } = {}) {
  const s = sessions.get(sessionId);
  if (!s) return;
  // A real turn ended - the session recovered, on its own or off our
  // "continue". Cancel any injection still sitting on the backoff timer
  // (otherwise it fires "continue" into a healthy session moments later) and
  // wipe recovery state so the next, unrelated drop starts from clean.
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.retryCount = 0;
  s.injectedAt = 0;
}

function handleGodModeSignal({ sessionId, type } = {}) {
  if (!autoProceedArmed || type !== 'connectionError') return;
  if (isBoundSession(sessionId)) return; // godmode.js already owns this tab's recovery
  const s = sessionState(sessionId);
  // main.js re-fires this signal for EVERY stdout chunk that still shows the
  // error line - many times, over many seconds, for a single drop (no de-dupe
  // there, by design). shouldScheduleRecovery() collapses that to one "continue".
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
