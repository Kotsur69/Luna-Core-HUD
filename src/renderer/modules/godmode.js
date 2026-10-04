// ============================================================================
// LunaCore - "God Mode" (unattended to-do runner)
// ----------------------------------------------------------------------------
// See reference/GODMODE_PLAN.md for the full design. Short version: arm it on
// a tab's to-do list, and LunaCore injects each open item in turn, waits for
// onTurnEnd, ticks it done, injects the next - surviving usage-limit walls
// and dropped connections on its own - so Mati can walk away for hours.
//
// PER TAB (ORCHESTRATOR_PLAN.md slice 2): every tab can carry its own run.
// Runs whose tabs share a project (e.g. worktree tabs) share one list, so
// each run CLAIMS the item it is working on and the others skip it; an item
// whose `dependsOn` is still open is skipped too. A run with nothing it may
// take right now waits ('waiting-queue') and is re-poked whenever another run
// finishes an item or ends. The list is divided automatically, not by hand:
// tab ids do not survive a restart, so a persisted "this item -> that tab"
// assignment would point at nothing.
//
// LIVE queue, not a snapshot: every step re-reads the actual to-do list via
// window.lunacore.getTodos(sessionId)/saveTodos(...) instead of caching its
// own copy. Same source of truth the widget itself uses, so a task added or
// edited mid-run just joins the run. Read-modify-write ticks go through one
// queue (`serial`) so two runs never overwrite each other's ticks.
//
// DELIBERATE DEVIATION from autocompact.js's template: autocompact's
// injecting subscription lives INSIDE mount() on purpose, so an unmounted
// widget can never inject invisibly. God Mode's entire point is surviving
// exactly the "not looking at it" case (§ walk away for hours), so its
// listeners are registered ONCE at module scope and stay live regardless of
// whether this widget's DOM is on screen. The counterweight is the
// confirm-gate at arm time (decision #5), not continuous visibility.
//
// No separate defineWidget/layout slot: this is visually and functionally
// part of the To-do widget ("run THIS list"). Its markup lives inside
// w-todo's template (index.html); todo.js calls mountGodModeControl(root)
// from its own mount() and owns the DOM lifecycle, while the state machine
// below stays independent of any mount. The control shows the ACTIVE tab's run.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { getActiveSessionId } from './terminals.js';
import { openCount, syncTodoProject, cardPrompt } from './todo.js';
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

// Phases in which a run is live (holds the overnight guard, owns its tab).
const ENGAGED = new Set(['running', 'waiting-limit', 'waiting-connection', 'waiting-backend', 'waiting-queue']);

// Elements of the current mount, or null when the To-do widget is not on screen.
let els = null;

// ---- State that must OUTLIVE a remount / the widget being off-screen -------

/**
 * One run per tab. A finished run is removed; a stalled one stays so its tab
 * keeps showing "stalled" until it is re-armed or switched off.
 * @type {Map<string, {
 *   sessionId:string, phase:string, currentAt:number|null, currentText:string|null,
 *   remainingCount:number, retryCount:number, sawDrop:boolean,
 *   lastUsageLimitAt:number, lastConnErrAt:number, limitTimer:any, connTimer:any
 * }>}
 */
const runs = new Map();

function newRun(sessionId) {
  return {
    sessionId,
    phase: 'running',
    currentAt: null, // the in-flight to-do's `at` key (survives index shifts)
    currentText: null, // its prompt, kept for limit-poll re-injection
    remainingCount: 0, // open-item count as of the last list read
    retryCount: 0, // connection-error attempts for the CURRENT item
    sawDrop: false, // a request dropped while the local backend was being restored
    lastUsageLimitAt: 0,
    lastConnErrAt: 0,
    limitTimer: null,
    connTimer: null,
  };
}

const isEngaged = (run) => !!run && ENGAGED.has(run.phase);

// ---- Pure queue logic (exported for tests) ---------------------------------

/**
 * The next item a run may take: open, not claimed by another run, and every
 * `dependsOn` that still exists in the list is done. A dependency that was
 * deleted no longer blocks anything.
 * @param {Array<{at:number, done:boolean, dependsOn?:number[]}>} items
 * @param {Set<number>} claimed `at`s other runs are working on
 * @returns {object|null}
 */
export function pickNextItem(items, claimed) {
  const list = Array.isArray(items) ? items : [];
  const doneByAt = new Map(list.map((item) => [item.at, item.done === true]));
  return (
    list.find((item) => {
      if (item.done || claimed.has(item.at)) return false;
      const deps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
      return deps.every((at) => !doneByAt.has(at) || doneByAt.get(at));
    }) || null
  );
}

/**
 * What a run should do with this list: take `item`, wait for other runs /
 * dependencies ('wait'), or finish ('done').
 * @returns {{action:'take', item:object}|{action:'wait'}|{action:'done'}}
 */
export function queueStep(items, claimed) {
  const item = pickNextItem(items, claimed);
  if (item) return { action: 'take', item };
  return openCount(items) > 0 ? { action: 'wait' } : { action: 'done' };
}

// ---- Run bookkeeping --------------------------------------------------------

/** `at`s claimed by every run except `self`. */
function claimedBy(self) {
  const claimed = new Set();
  for (const run of runs.values()) {
    if (run !== self && isEngaged(run) && run.currentAt != null) claimed.add(run.currentAt);
  }
  return claimed;
}

// One queue for every read-modify-write of a list, across all runs.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function readList(sessionId) {
  try {
    const list = await window.lunacore.getTodos(sessionId);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function clearTimers(run) {
  if (run.limitTimer) {
    clearInterval(run.limitTimer);
    run.limitTimer = null;
  }
  if (run.connTimer) {
    clearTimeout(run.connTimer);
    run.connTimer = null;
  }
}

/** Tells main every tab with a live run - arms the overnight guard. */
function reportRuns() {
  if (typeof window === 'undefined' || !window.lunacore || !window.lunacore.setGodModeRuns) return;
  window.lunacore.setGodModeRuns([...runs.values()].filter(isEngaged).map((run) => run.sessionId));
}

function statusText(run) {
  switch (run ? run.phase : 'idle') {
    case 'running':
      return `${t('godmode.running')} (${run.remainingCount})`;
    case 'waiting-queue':
      return t('godmode.waitingQueue');
    case 'waiting-limit':
      return t('godmode.waitingLimit');
    case 'waiting-connection':
      return t('godmode.waitingConnection');
    case 'waiting-backend':
      return t('godmode.waitingBackend');
    case 'stalled':
      return t('godmode.stalled');
    default:
      return t('godmode.off');
  }
}

function render() {
  if (!els) return;
  const run = runs.get(getActiveSessionId());
  const engaged = isEngaged(run);
  els.toggle.checked = engaged;
  els.field.classList.toggle('is-armed', engaged);
  els.field.classList.toggle('is-stalled', !!run && run.phase === 'stalled');
  const others = [...runs.values()].filter((r) => r !== run && isEngaged(r)).length;
  const base = statusText(run);
  els.status.textContent = others > 0 ? `${base} · ${t('godmode.others', { n: others })}` : base;
}

/** Reads the run's live list and injects the next item it may take, waits, or finishes. */
async function injectNext(run) {
  if (runs.get(run.sessionId) !== run || !isEngaged(run)) return; // disarmed meanwhile
  const items = await readList(run.sessionId);
  if (runs.get(run.sessionId) !== run || !isEngaged(run)) return;
  run.remainingCount = openCount(items);
  const step = queueStep(items, claimedBy(run));
  if (step.action === 'done') {
    finishRun(run, 'done');
    return;
  }
  if (step.action === 'wait') {
    run.currentAt = null;
    run.currentText = null;
    run.phase = 'waiting-queue';
    render();
    detectDeadlock();
    return;
  }
  run.phase = 'running';
  run.currentAt = step.item.at;
  // A task card pastes its details/done-when too; a plain item is just its text.
  run.currentText = cardPrompt(step.item);
  window.lunacore.pastePrompt(run.currentText + AUTONOMY_NUDGE, true, run.sessionId);
  render();
}

/** Re-checks every run that is waiting for the queue to move. */
function pokeWaiting() {
  for (const run of runs.values()) {
    if (run.phase === 'waiting-queue') injectNext(run);
  }
}

/**
 * Waiting runs with no run left working on anything can never be unblocked
 * (e.g. a dependency cycle, or a dependency nobody may take) - stall them
 * instead of waiting forever.
 */
function detectDeadlock() {
  const all = [...runs.values()];
  const working = all.some((run) => isEngaged(run) && run.phase !== 'waiting-queue');
  if (working) return;
  for (const run of all) {
    if (run.phase === 'waiting-queue') finishRun(run, 'stalled');
  }
}

/** Ticks the in-flight item done (by `at`, not index) and moves on to the next one. */
async function markCurrentDoneAndAdvance(run) {
  const at = run.currentAt;
  if (at != null) {
    await serial(async () => {
      const items = await readList(run.sessionId);
      const idx = items.findIndex((item) => item.at === at);
      if (idx === -1 || items[idx].done) return;
      const next = items.map((item, i) => (i === idx ? { ...item, done: true } : item));
      try {
        await window.lunacore.saveTodos(next, run.sessionId);
      } catch {
        /* best-effort - a failed save just means this item stays open, not lost */
      }
    });
    // Nudges the visible widget to repaint if it happens to be showing this
    // project right now; a no-op read for any other tab.
    syncTodoProject();
  }
  run.currentAt = null;
  run.currentText = null;
  await injectNext(run);
  pokeWaiting(); // a tick may have unblocked a dependency for another run
}

function finishRun(run, reason) {
  clearTimers(run);
  if (reason === 'stalled') {
    run.phase = 'stalled';
    run.currentAt = null;
    run.currentText = null;
    voice.needYou();
  } else {
    runs.delete(run.sessionId);
    voice.done();
  }
  reportRuns();
  render();
  pokeWaiting(); // its claim is gone - a waiting run may take that item now
}

function disarm(sessionId) {
  const run = runs.get(sessionId);
  if (!run) return;
  clearTimers(run);
  runs.delete(sessionId);
  reportRuns();
  render();
  pokeWaiting();
}

function startLimitPoll(run) {
  clearInterval(run.limitTimer);
  run.limitTimer = setInterval(() => {
    if (run.phase !== 'waiting-limit') {
      clearInterval(run.limitTimer);
      run.limitTimer = null;
      return;
    }
    if (run.currentText) window.lunacore.pastePrompt(run.currentText + AUTONOMY_NUDGE, true, run.sessionId);
  }, LIMIT_POLL_MS);
}

function handleConnectionError(run) {
  run.phase = 'waiting-connection';
  render();
  run.retryCount += 1;
  if (run.retryCount > MAX_CONN_RETRIES) {
    finishRun(run, 'stalled');
    return;
  }
  clearTimeout(run.connTimer);
  run.connTimer = setTimeout(() => {
    run.connTimer = null;
    if (run.phase !== 'waiting-connection') return; // disarmed or recovered already
    window.lunacore.pastePrompt('continue', true, run.sessionId);
    run.phase = 'running';
    render();
  }, CONN_BACKOFF_MS);
}

/**
 * True when THIS session's connection-drop recovery already belongs to an
 * active God Mode run. Lets autoproceed.js (the always-available, non-God-Mode
 * version of this same recovery) skip a tab godmode.js is already driving, so
 * the two never both inject "continue" for the same drop.
 */
export function isBoundSession(sessionId) {
  return isEngaged(runs.get(sessionId));
}

function handleTurnEnd({ sessionId } = {}) {
  const run = runs.get(sessionId);
  if (!isEngaged(run) || run.phase === 'waiting-queue') return; // nothing in flight
  clearTimers(run);
  run.retryCount = 0;
  run.phase = 'running';
  render();
  markCurrentDoneAndAdvance(run);
}

/**
 * The overnight guard's signals (src/overnight.js) for a local backend, as a
 * pure step: given the current phase/sawDrop and a signal type, the next
 * state and what to do. Null = not a backend concern, handle it as before.
 *   - backendRecovering: wait for the backend instead of burning connection
 *     retries; a drop seen before it (waiting-connection) is remembered.
 *   - connectionError while waiting-backend: remember the drop, no retry.
 *   - backendRecovered: resume; paste 'continue' ONLY if a request dropped,
 *     since the CLI may have retried by itself and a stray 'continue'
 *     mid-turn becomes a queued prompt.
 *   - backendLost: the run stalls.
 * @param {string} currentPhase
 * @param {boolean} dropped
 * @param {string} type
 * @returns {{phase:string, sawDrop:boolean, effect:'wait'|'none'|'resume'|'continue'|'stall'}|null}
 */
export function backendSignalStep(currentPhase, dropped, type) {
  if (type === 'backendLost') return { phase: 'stalled', sawDrop: false, effect: 'stall' };
  if (type === 'backendRecovering') {
    return { phase: 'waiting-backend', sawDrop: dropped || currentPhase === 'waiting-connection', effect: 'wait' };
  }
  if (currentPhase !== 'waiting-backend') return null;
  if (type === 'connectionError') return { phase: currentPhase, sawDrop: true, effect: 'none' };
  if (type === 'backendRecovered') return { phase: 'running', sawDrop: false, effect: dropped ? 'continue' : 'resume' };
  return null;
}

/** Applies a backendSignalStep() result to one run. */
function applyBackendStep(run, step) {
  if (step.effect === 'stall') {
    finishRun(run, 'stalled');
    return;
  }
  if (step.effect === 'wait') clearTimers(run);
  if (step.effect === 'resume' || step.effect === 'continue') run.retryCount = 0;
  run.phase = step.phase;
  run.sawDrop = step.sawDrop;
  if (step.effect === 'continue') window.lunacore.pastePrompt('continue', true, run.sessionId);
  render();
}

function handleGodModeSignal({ sessionId, type } = {}) {
  const run = runs.get(sessionId);
  if (!isEngaged(run) || run.phase === 'waiting-queue') return; // nothing in flight
  const step = backendSignalStep(run.phase, run.sawDrop, type);
  if (step) {
    applyBackendStep(run, step);
    return;
  }
  const now = Date.now();
  if (type === 'usageLimit') {
    if (run.phase === 'waiting-limit') return; // already handling this wall
    if (now - run.lastUsageLimitAt < SIGNAL_COOLDOWN_MS) return;
    run.lastUsageLimitAt = now;
    run.phase = 'waiting-limit';
    render();
    startLimitPoll(run);
  } else if (type === 'connectionError') {
    if (now - run.lastConnErrAt < SIGNAL_COOLDOWN_MS) return;
    run.lastConnErrAt = now;
    handleConnectionError(run);
  }
}

/** A closed tab's run is over; the control repaints for the newly active tab. */
function handleSessions({ sessions } = {}) {
  const live = new Set((Array.isArray(sessions) ? sessions : []).map((s) => s.id));
  let dropped = false;
  for (const run of [...runs.values()]) {
    if (live.has(run.sessionId)) continue;
    clearTimers(run);
    runs.delete(run.sessionId);
    dropped = true;
  }
  if (dropped) {
    reportRuns();
    pokeWaiting();
  }
  render();
}

// Module-scope on purpose - see the header note. Runs once, the first time
// this module is imported (by todo.js), and stays live for the app's lifetime.
// Guarded because the test suites require this module in plain Node, where
// window.lunacore doesn't exist.
if (typeof window !== 'undefined' && window.lunacore) {
  window.lunacore.onTurnEnd(handleTurnEnd);
  window.lunacore.onGodModeSignal(handleGodModeSignal);
  window.lunacore.onSessions(handleSessions);
}

/**
 * The confirm-gated arm step (GODMODE_PLAN.md decision #5) for the ACTIVE
 * tab. Asks the native "are you sure" popup - skipped entirely when there is
 * nothing open to run - and only starts on an explicit Yes. Other tabs' runs
 * are untouched.
 */
async function tryArm() {
  const sessionId = getActiveSessionId();
  if (!sessionId || isEngaged(runs.get(sessionId))) {
    render();
    return;
  }
  const open = openCount(await readList(sessionId));
  if (open === 0) {
    render(); // nothing to confirm - stays off, toggle reverts
    return;
  }
  const ok = await window.lunacore.confirmGodMode(open);
  if (!ok || isEngaged(runs.get(sessionId))) {
    render();
    return;
  }
  const run = newRun(sessionId);
  runs.set(sessionId, run);
  reportRuns();
  render();
  await injectNext(run);
}

/**
 * Wires the God Mode toggle + status line that live inside the To-do
 * widget's own template. Called from todo.js's mount(); returns a cleanup
 * that only tears down the DOM binding - the runs themselves (module state
 * above) are untouched, so a remount mid-run just re-attaches.
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
      disarm(getActiveSessionId());
    }
  });

  const offLang = onLangChange(render);

  return () => {
    offLang();
    els = null;
  };
}
