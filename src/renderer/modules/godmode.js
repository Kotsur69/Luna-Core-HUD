// ============================================================================
// LunaCore - "God Mode" (unattended to-do runner)
// ----------------------------------------------------------------------------
// See reference/GODMODE_PLAN.md for the full design. Short version: arm it on
// a tab's to-do list, and LunaCore injects each open item in turn, waits for
// onTurnEnd, ticks it done, injects the next - surviving usage-limit walls
// and dropped connections on its own - so Mati can walk away for hours.
//
// LIVE queue, not a snapshot: every step re-reads the actual to-do list via
// window.lunacore.getTodos(sessionId)/saveTodos(...) instead of caching its
// own copy. Same source of truth the widget itself uses, so a task added or
// edited mid-run just joins the run, and there is no separate list to desync.
//
// DELIBERATE DEVIATION from autocompact.js's template: autocompact's
// injecting subscription lives INSIDE mount() on purpose, so an unmounted
// widget can never inject invisibly. God Mode's entire point is surviving
// exactly the "not looking at it" case (§ walk away for hours), so its
// onTurnEnd/onGodModeSignal listeners are registered ONCE at module scope and
// stay live regardless of whether this widget's DOM is on screen. The
// counterweight is the confirm-gate at arm time (decision #5), not
// continuous visibility - the friction is up front, not ongoing.
//
// No separate defineWidget/layout slot: this is visually and functionally
// part of the To-do widget ("run THIS list"), not a standalone panel. Its
// markup lives inside w-todo's template (index.html); todo.js calls
// mountGodModeControl(root) from its own mount() and owns the DOM lifecycle,
// while the state machine below stays independent of any mount.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { getActiveSessionId } from './terminals.js';
import { openCount, syncTodoProject } from './todo.js';
import { sfx, voice } from './sound.js';

// A fixed instruction appended to every injected task. onTurnEnd (see below)
// can only tell "Claude's turn structurally ended," not "the task is truly
// done" from "Claude is waiting on a clarifying question" - and a task
// silently stuck on a question for 5 hours is worse than a slightly bossier
// prompt (GODMODE_PLAN.md decision #1).
const AUTONOMY_NUDGE =
  ' (Running unattended via God Mode: if anything here is ambiguous, use your own best judgement and keep going instead of stopping to ask.)';

const MAX_CONN_RETRIES = 3;
const CONN_BACKOFF_MS = 5000;
const LIMIT_POLL_MS = 5 * 60 * 1000; // re-nudge every 5 min while walled
const SIGNAL_COOLDOWN_MS = 4000; // a TUI redraw repeats the same stdout chunk

// Elements of the current mount, or null when the To-do widget is not on screen.
let els = null;

// ---- State that must OUTLIVE a remount / the widget being off-screen -------
let phase = 'idle'; // idle | running | waiting-limit | waiting-connection | stalled
let boundSessionId = null; // which tab this run is bound to (v1: one at a time)
let currentAt = null; // the in-flight to-do's `at` key (survives index shifts)
let currentText = null; // its text, kept for limit-poll re-injection
let remainingCount = 0; // open-item count as of the last list read, for the status line
let retryCount = 0; // connection-error attempts for the CURRENT item
let lastUsageLimitAt = 0;
let lastConnErrAt = 0;
let limitTimer = null;
let connTimer = null;

function clearTimers() {
  if (limitTimer) {
    clearInterval(limitTimer);
    limitTimer = null;
  }
  if (connTimer) {
    clearTimeout(connTimer);
    connTimer = null;
  }
}

function statusText() {
  switch (phase) {
    case 'running':
      return `${t('godmode.running')} (${remainingCount})`;
    case 'waiting-limit':
      return t('godmode.waitingLimit');
    case 'waiting-connection':
      return t('godmode.waitingConnection');
    case 'stalled':
      return t('godmode.stalled');
    default:
      return t('godmode.off');
  }
}

function render() {
  if (!els) return;
  const engaged = phase === 'running' || phase === 'waiting-limit' || phase === 'waiting-connection';
  els.toggle.checked = engaged;
  els.field.classList.toggle('is-armed', engaged);
  els.field.classList.toggle('is-stalled', phase === 'stalled');
  els.status.textContent = statusText();
}

/** Reads the bound session's live list, injects the next open item, or finishes. */
async function injectNext() {
  if (phase !== 'running') return; // disarmed while an await above was in flight
  let list;
  try {
    list = await window.lunacore.getTodos(boundSessionId);
  } catch {
    list = [];
  }
  const items = Array.isArray(list) ? list : [];
  remainingCount = openCount(items);
  const next = items.find((item) => !item.done);
  if (!next) {
    finishRun('done');
    return;
  }
  currentAt = next.at;
  currentText = next.text;
  window.lunacore.pastePrompt(currentText + AUTONOMY_NUDGE, true, boundSessionId);
  render();
}

/** Ticks the in-flight item done (by `at`, not index) and moves on to the next one. */
async function markCurrentDoneAndAdvance() {
  if (currentAt == null) {
    await injectNext();
    return;
  }
  let list;
  try {
    list = await window.lunacore.getTodos(boundSessionId);
  } catch {
    list = [];
  }
  const items = Array.isArray(list) ? list : [];
  const idx = items.findIndex((item) => item.at === currentAt);
  if (idx !== -1 && !items[idx].done) {
    const next = items.map((item, i) => (i === idx ? { ...item, done: true } : item));
    try {
      await window.lunacore.saveTodos(next, boundSessionId);
    } catch {
      /* best-effort - a failed save just means this item stays open, not lost */
    }
  }
  // Nudges the visible widget to repaint if it happens to be showing this
  // project right now; a no-op read for any other tab (same fn tab-switch uses).
  syncTodoProject();
  currentAt = null;
  currentText = null;
  await injectNext();
}

function finishRun(reason) {
  clearTimers();
  phase = reason === 'stalled' ? 'stalled' : 'idle';
  if (reason === 'stalled') voice.needYou();
  else voice.done();
  boundSessionId = null;
  currentAt = null;
  currentText = null;
  retryCount = 0;
  remainingCount = 0;
  render();
}

function disarm() {
  clearTimers();
  phase = 'idle';
  boundSessionId = null;
  currentAt = null;
  currentText = null;
  retryCount = 0;
  remainingCount = 0;
  render();
}

function startLimitPoll() {
  clearInterval(limitTimer);
  limitTimer = setInterval(() => {
    if (phase !== 'waiting-limit') {
      clearInterval(limitTimer);
      limitTimer = null;
      return;
    }
    if (currentText) window.lunacore.pastePrompt(currentText + AUTONOMY_NUDGE, true, boundSessionId);
  }, LIMIT_POLL_MS);
}

function handleConnectionError() {
  phase = 'waiting-connection';
  render();
  retryCount += 1;
  if (retryCount > MAX_CONN_RETRIES) {
    finishRun('stalled');
    return;
  }
  clearTimeout(connTimer);
  connTimer = setTimeout(() => {
    connTimer = null;
    if (phase !== 'waiting-connection') return; // disarmed or recovered already
    window.lunacore.pastePrompt('continue', true, boundSessionId);
    phase = 'running';
    render();
  }, CONN_BACKOFF_MS);
}

function handleTurnEnd({ sessionId } = {}) {
  if (!boundSessionId || sessionId !== boundSessionId) return;
  if (phase === 'idle' || phase === 'stalled') return;
  clearTimers();
  retryCount = 0;
  phase = 'running';
  render();
  markCurrentDoneAndAdvance();
}

function handleGodModeSignal({ sessionId, type } = {}) {
  if (!boundSessionId || sessionId !== boundSessionId) return;
  if (phase === 'idle' || phase === 'stalled') return;
  const now = Date.now();
  if (type === 'usageLimit') {
    if (phase === 'waiting-limit') return; // already handling this wall
    if (now - lastUsageLimitAt < SIGNAL_COOLDOWN_MS) return;
    lastUsageLimitAt = now;
    phase = 'waiting-limit';
    render();
    startLimitPoll();
  } else if (type === 'connectionError') {
    if (now - lastConnErrAt < SIGNAL_COOLDOWN_MS) return;
    lastConnErrAt = now;
    handleConnectionError();
  }
}

// Module-scope on purpose - see the header note. Runs once, the first time
// this module is imported (by todo.js), and stays live for the app's lifetime.
window.lunacore.onTurnEnd(handleTurnEnd);
window.lunacore.onGodModeSignal(handleGodModeSignal);

/**
 * The confirm-gated arm step (GODMODE_PLAN.md decision #5). Snapshots the
 * ACTIVE tab (v1 scope: active tab only), asks the native "are you sure"
 * popup - which is skipped entirely when there is nothing open to run - and
 * only starts on an explicit Yes.
 */
async function tryArm() {
  if (phase !== 'idle' && phase !== 'stalled') return;
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    render();
    return;
  }
  let list;
  try {
    list = await window.lunacore.getTodos(sessionId);
  } catch {
    list = [];
  }
  const open = openCount(Array.isArray(list) ? list : []);
  if (open === 0) {
    render(); // nothing to confirm - stays off, toggle reverts
    return;
  }
  const ok = await window.lunacore.confirmGodMode(open);
  if (!ok) {
    render();
    return;
  }
  boundSessionId = sessionId;
  retryCount = 0;
  phase = 'running';
  render();
  await injectNext();
}

/**
 * Wires the God Mode toggle + status line that live inside the To-do
 * widget's own template. Called from todo.js's mount(); returns a cleanup
 * that only tears down the DOM binding - the run itself (module state above)
 * is untouched, so a remount mid-run just re-attaches to what's still going.
 * @param {HTMLElement} root the To-do widget's mounted root
 * @returns {() => void} cleanup
 */
export function mountGodModeControl(root) {
  els = {
    field: root.querySelector('#godmode-field'),
    status: root.querySelector('#godmode-status'),
    toggle: root.querySelector('#godmode-toggle'),
  };
  render();

  els.toggle.addEventListener('change', () => {
    sfx.modeToggle();
    if (els.toggle.checked) {
      // Optimistic revert: only actually flips on once tryArm()'s confirm
      // dialog resolves Yes - see the module header on why arming is never a
      // direct toggle-click (GODMODE_PLAN.md decision #5).
      els.toggle.checked = false;
      tryArm();
    } else {
      disarm();
    }
  });

  const offLang = onLangChange(render);

  return () => {
    offLang();
    els = null;
  };
}
