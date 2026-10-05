// ============================================================================
// LunaCore - "God Mode" (unattended to-do runner)
// ----------------------------------------------------------------------------
// See reference/GODMODE_PLAN.md for the full design. Short version: arm it on
// a tab's to-do list, and LunaCore injects each open item in turn, waits for
// onTurnEnd, ticks it done, injects the next - surviving usage-limit walls
// and dropped connections on its own - so Mati can walk away for hours.
//
// v2 (per-tab arming): every tab can carry its own run, in parallel. State
// lives in `runs`, keyed by session id; the To-do widget's toggle arms or
// disarms the ACTIVE tab's run and its status line shows that run, so
// switching tabs shows each tab's own state. To-do lists are stored per
// PROJECT, not per tab, so two tabs on the same project would race for the
// same items - arming is refused while another tab's run owns that project.
//
// LIVE queue, not a snapshot: every step re-reads the actual to-do list via
// window.lunacore.getTodos(sessionId)/saveTodos(...) instead of caching its
// own copy. Same source of truth the widget itself uses, so a task added or
// edited mid-run just joins the run, and there is no separate list to desync.
//
// DELIBERATE DEVIATION from autocompact.js's template: autocompact's
// injecting subscription lives INSIDE mount() on purpose, so an unmounted
// widget can never inject invisibly. God Mode's entire point is surviving
// exactly the "not looking at it" case (walk away for hours), so its
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

/**
 * The text actually injected for a to-do item. An item starting with "/" would
 * be run by Claude Code as a slash command (e.g. "/clear ...") instead of sent
 * as a message - no turn happens, onTurnEnd never fires, and the run hangs
 * forever. So it is framed as a task first, which Claude reads as plain text.
 * @param {string} text the to-do item's text
 * @returns {string}
 */
export function promptFor(text) {
  const body = String(text).trim();
  const framed = body.startsWith('/') ? `Task: ${body}` : body;
  return framed + AUTONOMY_NUDGE;
}

// Dropped-connection retries back off instead of giving up fast: an overnight
// run should ride out a ~30 min outage, not stall on the third 5s retry.
const CONN_BACKOFF_STEPS_MS = [5000, 30 * 1000, 2 * 60 * 1000, 5 * 60 * 1000, 10 * 60 * 1000, 10 * 60 * 1000];
const MAX_CONN_RETRIES = CONN_BACKOFF_STEPS_MS.length;
// Usage-limit wall: resume this long after the parsed reset time (the wall
// lifts on the server's clock, not ours), or retry every LIMIT_POLL_MS when
// the message named no reset time. A run NEVER stalls on a limit.
const LIMIT_RESUME_BUFFER_MS = 60 * 1000;
const LIMIT_POLL_MS = 5 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 4000; // a TUI redraw repeats the same stdout chunk
const NOTICE_MS = 4000; // how long a refused-arm notice stays on the status line

const ENGAGED_PHASES = new Set(['running', 'waiting-limit', 'waiting-connection', 'waiting-backend']);

// Elements of the current mount, or null when the To-do widget is not on screen.
let els = null;
// A short-lived message that overrides the status line (a refused arm).
let notice = null;
let noticeTimer = null;

// ---- State that must OUTLIVE a remount / the widget being off-screen -------
// sessionId -> run. Holds engaged runs and stalled ones (kept so the tab shows
// "stalled - needs you" until re-armed, disarmed or closed); idle = absent.
const runs = new Map();
// sessionId -> projectId, from the main process's session broadcast.
let projectBySession = new Map();

/**
 * @typedef {Object} Run
 * @property {string} sessionId
 * @property {string} phase running | waiting-limit | waiting-connection | waiting-backend | stalled
 * @property {number|null} currentAt the in-flight to-do's `at` key (survives index shifts)
 * @property {string|null} currentText the in-flight item's text
 * @property {number} remainingCount open-item count as of the last list read
 * @property {number} retryCount connection-error attempts for the CURRENT item
 * @property {boolean} sawDrop a request dropped while the local backend was being restored
 * @property {number} lastUsageLimitAt
 * @property {number|null} resetsAt when the current usage-limit wall lifts (epoch ms), if known
 * @property {number} lastConnErrAt
 * @property {*} limitTimer
 * @property {*} connTimer
 */

/**
 * @param {string} sessionId
 * @param {string} [phase]
 * @returns {Run}
 */
function newRun(sessionId, phase = 'running') {
  return {
    sessionId,
    phase,
    currentAt: null,
    currentText: null,
    remainingCount: 0,
    retryCount: 0,
    sawDrop: false,
    lastUsageLimitAt: 0,
    resetsAt: null,
    lastConnErrAt: 0,
    limitTimer: null,
    connTimer: null,
  };
}

function isEngaged(run) {
  return Boolean(run) && ENGAGED_PHASES.has(run.phase);
}

/** True while `run` is still the live run for its tab (not disarmed/replaced). */
function isCurrent(run) {
  return runs.get(run.sessionId) === run && isEngaged(run);
}

function clearTimers(run) {
  if (run.limitTimer) {
    clearTimeout(run.limitTimer);
    run.limitTimer = null;
  }
  if (run.connTimer) {
    clearTimeout(run.connTimer);
    run.connTimer = null;
  }
}

/**
 * Which other tab's engaged run already owns `sessionId`'s project, or null.
 * Pure, so the collision rule is unit-testable without a DOM.
 * @param {string} sessionId the tab being armed
 * @param {Map<string, string|null>} projects sessionId -> projectId
 * @param {Iterable<string>} engagedIds tabs with an engaged run
 * @returns {string|null}
 */
export function findProjectConflict(sessionId, projects, engagedIds) {
  const project = projects.get(sessionId);
  if (!project) return null; // no project = no shared list to race over
  for (const id of engagedIds) {
    if (id !== sessionId && projects.get(id) === project) return id;
  }
  return null;
}

function engagedIds() {
  return [...runs.values()].filter(isEngaged).map((run) => run.sessionId);
}

function phaseText(run) {
  switch (run ? run.phase : 'idle') {
    case 'running':
      return `${t('godmode.running')} (${run.remainingCount})`;
    case 'waiting-limit':
      return run.resetsAt ? `${t('godmode.waitingLimit')} (${clockText(run.resetsAt)})` : t('godmode.waitingLimit');
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

/** "12:11" in the user's locale, for the waiting-for-limit status line. */
function clockText(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusText(run) {
  if (notice) return notice;
  const others = engagedIds().filter((id) => !run || id !== run.sessionId).length;
  if (others === 0) return phaseText(run);
  return `${phaseText(run)} · ${t('godmode.otherTabs').replace('{n}', String(others))}`;
}

/** Paints the ACTIVE tab's run; other tabs' runs show only as a count. */
function render() {
  if (!els) return;
  const run = runs.get(getActiveSessionId()) || null;
  const engaged = isEngaged(run);
  els.toggle.checked = engaged;
  els.field.classList.toggle('is-armed', engaged);
  els.field.classList.toggle('is-stalled', Boolean(run) && run.phase === 'stalled');
  els.status.textContent = statusText(run);
}

function showNotice(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    noticeTimer = null;
    render();
  }, NOTICE_MS);
  render();
}

/**
 * Repaints the control for whichever tab is active now. todo.js calls this
 * from syncTodoProject(), i.e. on every tab or project switch.
 */
export function refreshGodModeControl() {
  render();
}

async function readList(sessionId) {
  try {
    const list = await window.lunacore.getTodos(sessionId);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Reads the run's live list, injects the next open item, or finishes. */
async function injectNext(run) {
  if (!isCurrent(run) || run.phase !== 'running') return; // disarmed mid-await
  const items = await readList(run.sessionId);
  if (!isCurrent(run)) return;
  run.remainingCount = openCount(items);
  const next = items.find((item) => !item.done);
  if (!next) {
    finishRun(run, 'done');
    return;
  }
  run.currentAt = next.at;
  run.currentText = next.text;
  window.lunacore.pastePrompt(promptFor(run.currentText), true, run.sessionId);
  render();
}

/** Ticks the in-flight item done (by `at`, not index) and moves on to the next one. */
async function markCurrentDoneAndAdvance(run) {
  if (run.currentAt == null) {
    await injectNext(run);
    return;
  }
  const items = await readList(run.sessionId);
  const idx = items.findIndex((item) => item.at === run.currentAt);
  if (idx !== -1 && !items[idx].done) {
    const next = items.map((item, i) => (i === idx ? { ...item, done: true } : item));
    try {
      await window.lunacore.saveTodos(next, run.sessionId);
    } catch {
      /* best-effort - a failed save just means this item stays open, not lost */
    }
  }
  // Nudges the visible widget to repaint if it happens to be showing this
  // project right now; a no-op read for any other tab (same fn tab-switch uses).
  syncTodoProject();
  run.currentAt = null;
  run.currentText = null;
  await injectNext(run);
}

/** Tells main a tab's run started or ended - drives the overnight guard. */
function reportRun(sessionId, active) {
  if (typeof window !== 'undefined' && window.lunacore && window.lunacore.setGodModeRun) {
    window.lunacore.setGodModeRun(sessionId, active);
  }
}

/** Ends a run on its own; 'stalled' stays on record for the tab's status line. */
function finishRun(run, reason) {
  clearTimers(run);
  if (reason === 'stalled') {
    voice.needYou();
    runs.set(run.sessionId, newRun(run.sessionId, 'stalled'));
  } else {
    voice.done();
    runs.delete(run.sessionId);
  }
  reportRun(run.sessionId, false);
  render();
}

/** Silent stop (toggle off, or the tab closed). */
function disarm(sessionId) {
  const run = runs.get(sessionId);
  if (!run) {
    render();
    return;
  }
  clearTimers(run);
  runs.delete(sessionId);
  reportRun(sessionId, false);
  render();
}

/**
 * How long to wait out a usage-limit wall before trying again: until the
 * parsed reset time plus a buffer, or LIMIT_POLL_MS when there is no reset
 * time (or it is already past). Pure, for the tests.
 * @param {number|null} resetsAt epoch ms
 * @param {number} now epoch ms
 * @returns {number} ms
 */
export function limitResumeDelay(resetsAt, now) {
  if (!Number.isFinite(resetsAt)) return LIMIT_POLL_MS;
  return Math.max(resetsAt + LIMIT_RESUME_BUFFER_MS - now, LIMIT_RESUME_BUFFER_MS);
}

/**
 * Parks the run until the wall lifts, then types "continue" - the task is
 * still in the conversation, so it is a nudge, not a resend. The run goes back
 * to `running`: either the turn completes (onTurnEnd advances as usual) or
 * the wall is still up and the next usageLimit signal parks it again. As many
 * rounds as it takes - a limit never stalls a run.
 */
function waitForLimit(run, resetsAt) {
  clearTimers(run);
  run.phase = 'waiting-limit';
  run.resetsAt = Number.isFinite(resetsAt) ? resetsAt : null;
  render();
  run.limitTimer = setTimeout(() => {
    run.limitTimer = null;
    if (!isCurrent(run) || run.phase !== 'waiting-limit') return; // disarmed or already moving
    run.phase = 'running';
    run.resetsAt = null;
    window.lunacore.pastePrompt('continue', true, run.sessionId);
    render();
  }, limitResumeDelay(run.resetsAt, Date.now()));
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
  const backoff = CONN_BACKOFF_STEPS_MS[run.retryCount - 1];
  run.connTimer = setTimeout(() => {
    run.connTimer = null;
    if (!isCurrent(run) || run.phase !== 'waiting-connection') return; // disarmed or recovered
    window.lunacore.pastePrompt('continue', true, run.sessionId);
    run.phase = 'running';
    render();
  }, backoff);
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
  if (!isEngaged(run)) return;
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

function handleGodModeSignal({ sessionId, type, resetsAt } = {}) {
  const run = runs.get(sessionId);
  if (!isEngaged(run)) return;
  const step = backendSignalStep(run.phase, run.sawDrop, type);
  if (step) {
    applyBackendStep(run, step);
    return;
  }
  const now = Date.now();
  if (type === 'usageLimit') {
    // The same wall is reported twice (stdout scan + transcript); only a
    // repeat that brings a reset time we did not have is worth re-planning.
    const newInfo = Number.isFinite(resetsAt) && resetsAt !== run.resetsAt;
    if (run.phase === 'waiting-limit' && !newInfo) return;
    if (now - run.lastUsageLimitAt < SIGNAL_COOLDOWN_MS && !newInfo) return;
    run.lastUsageLimitAt = now;
    waitForLimit(run, Number.isFinite(resetsAt) ? resetsAt : run.resetsAt);
  } else if (type === 'connectionError') {
    if (run.phase === 'waiting-limit') return; // the wall, not a drop - wait it out
    if (now - run.lastConnErrAt < SIGNAL_COOLDOWN_MS) return;
    run.lastConnErrAt = now;
    handleConnectionError(run);
  }
}

/** Tracks each tab's project, and drops the run of any tab that closed. */
function handleSessionList({ sessions } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  projectBySession = new Map(list.map((s) => [s.id, s.projectId || null]));
  for (const id of [...runs.keys()]) {
    if (!projectBySession.has(id)) disarm(id);
  }
}

// Module-scope on purpose - see the header note. Runs once, the first time
// this module is imported (by todo.js), and stays live for the app's lifetime.
// Guarded because todo.js's test suite requires this module in plain Node,
// where window.lunacore doesn't exist.
if (typeof window !== 'undefined' && window.lunacore) {
  window.lunacore.onTurnEnd(handleTurnEnd);
  window.lunacore.onGodModeSignal(handleGodModeSignal);
  window.lunacore.onSessions(handleSessionList);
}

/**
 * The confirm-gated arm step (GODMODE_PLAN.md decision #5) for the ACTIVE
 * tab. Refused while another tab's run owns the same project; asks the native
 * "are you sure" popup - skipped entirely when there is nothing open to run -
 * and only starts on an explicit Yes. Other tabs' runs are never touched.
 */
async function tryArm() {
  const sessionId = getActiveSessionId();
  if (!sessionId || isEngaged(runs.get(sessionId))) {
    render();
    return;
  }
  if (findProjectConflict(sessionId, projectBySession, engagedIds())) {
    showNotice(t('godmode.projectBusy'));
    return;
  }
  const open = openCount(await readList(sessionId));
  if (open === 0) {
    render(); // nothing to confirm - stays off, toggle reverts
    return;
  }
  const ok = await window.lunacore.confirmGodMode(open);
  // Re-check after the modal: a run may have started on this tab or project meanwhile.
  if (!ok || isEngaged(runs.get(sessionId)) || findProjectConflict(sessionId, projectBySession, engagedIds())) {
    render();
    return;
  }
  const run = newRun(sessionId);
  runs.set(sessionId, run);
  reportRun(sessionId, true);
  render();
  await injectNext(run);
}

/**
 * Wires the God Mode toggle + status line that live inside the To-do
 * widget's own template. Called from todo.js's mount(); returns a cleanup
 * that only tears down the DOM binding - the runs themselves (module state
 * above) are untouched, so a remount mid-run just re-attaches to them.
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
