// ============================================================================
// LunaCore - God Mode: resume a run a PC shutdown (or "Pause for shutdown") cut
// ----------------------------------------------------------------------------
// A sleep keeps LunaCore alive (orchestraSleep.js / orchestraPower.js). A full
// shutdown does not: every worker process dies and the next start restores
// the run held, its active packages stalled 'restarted' (orchestraSupervisor
// restoreAfterRestart). This module brings such a run back on its own:
//
//   restore   a stored run that was started, not killed and not settled (or
//             settled with its integration cut mid-way) comes back with
//             plan.interrupted = {at, by:'shutdown'|'pause'} and a banner
//             that resumes it after RESUME_COUNTDOWN_MS - or at the stored
//             usage-limit reset, when that is still ahead.
//   resume    every package stalled 'restarted' goes on: its own Claude
//             conversation reopened with `claude --resume <uuid>` when the
//             transcript is on disk ('chat'), else a fresh worker in its
//             worktree with the resume brief ('fresh'). Packages stalled or
//             failed for any other reason are not touched. The pump then
//             launches what is pending, and a settled run re-runs the
//             integration the shutdown cut.
//   pause     "Pause for shutdown": no new launches, Esc to every worker,
//             each becomes stalled 'restarted' (not killed), the run is saved
//             with interrupted.by = 'pause'. Windows is never shut down here.
//
// Pure decisions are exported for tests; createShutdownResume() holds the one
// countdown timer (injected setTimer / clearTimer) and acts through deps.
// ============================================================================

'use strict';

const { withHistoryEntry, isActive } = require('./orchestraSupervisor');

const RESUME_COUNTDOWN_MS = 60 * 1000;
// A blocked automatic resume (busy, low battery, Luna's Work, a deps hold)
// looks again this often.
const RESUME_RECHECK_MS = 15 * 1000;
// No quotes or backticks: it travels single-quoted on the worker's command line.
const RESUME_SHUTDOWN_MESSAGE = 'LunaCore was restarted after a PC shutdown, continue where you left off';
const RESUMED_REASON = 'resumedAfterShutdown';
const RESTARTED = 'restarted';
const INTERRUPT_BY = new Set(['shutdown', 'pause']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PROJECT_ID_CHARS = 200;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const futureOrNull = (v, nowMs) => (Number.isFinite(v) && v > nowMs ? v : null);

/** A Claude conversation id, lower-cased; anything off-shape -> null. */
function normalizeTranscriptId(v) {
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/**
 * A stored plan.interrupted, shape-checked: {at, by, resetAt}. The countdown
 * deadline is never trusted from the file - restore computes it again.
 * @returns {{at:number, by:'shutdown'|'pause', resetAt:number|null}|null}
 */
function normalizeInterrupted(raw) {
  if (!isObj(raw) || !INTERRUPT_BY.has(raw.by) || !Number.isFinite(raw.at)) return null;
  return { at: raw.at, by: raw.by, resetAt: Number.isFinite(raw.resetAt) ? raw.resetAt : null };
}

/**
 * Whether the stored run (raw, as saved) was cut by a shutdown: started, not
 * killed, not settled - or settled with its integration still 'running'. A
 * run saved by "Pause for shutdown" (or interrupted before and never resumed)
 * keeps its own record.
 * @param {unknown} raw the stored plan before normalizeStoredPlan
 * @param {number} nowMs
 * @returns {{at:number, by:'shutdown'|'pause', resetAt:number|null}|null}
 */
function interruptedOnRestore(raw, nowMs) {
  if (!isObj(raw) || raw.killed === true) return null;
  const stored = normalizeInterrupted(raw.interrupted);
  const integrationCut = isObj(raw.integration) && raw.integration.state === 'running';
  if (!stored && raw.started !== true) return null;
  if (!stored && raw.settled === true && !integrationCut) return null;
  // The usage-limit pause the run sat in: resumed at its reset, not before.
  const resets = [futureOrNull(raw.pausedUntil, nowMs), futureOrNull(stored && stored.resetAt, nowMs)].filter(Boolean);
  const resetAt = resets.length ? Math.max(...resets) : null;
  return { ...(stored || { at: nowMs, by: 'shutdown' }), resetAt };
}

/**
 * When the automatic resume fires: RESUME_COUNTDOWN_MS after the restore, or
 * at the usage-limit reset (plus grace) when that is later.
 */
function resumeDeadline(interrupted, nowMs, graceMs = 0) {
  const countdown = nowMs + RESUME_COUNTDOWN_MS;
  const reset = interrupted && Number.isFinite(interrupted.resetAt) ? interrupted.resetAt + graceMs : 0;
  return Math.max(countdown, reset);
}

/**
 * Why a resume cannot go now, or null. Order = what Mati can fix first.
 * @param {{busy:boolean, batteryLow:boolean, hold:object|null, lunasWork:boolean}} s
 */
function resumeBlocker(s) {
  if (s.busy) return 'busy';
  if (s.hold) return s.hold.reason || 'noNodeModules';
  if (s.batteryLow) return 'batteryLow';
  if (s.lunasWork) return 'lunasWorkActive';
  return null;
}

/**
 * The packages a resume picks up and how. Only 'stalled' + 'restarted' ones;
 * a package an auto-split replaced is left alone.
 *   nudge   its tab is still open (a pause without a shutdown): same chat
 *   resume  `claude --resume <transcriptId>` in its worktree
 *   reopen  a fresh worker in its worktree with the resume brief
 *   requeue no worktree yet: back to pending, the pump launches it
 * A plan-run worker never resumes its chat: it only starts under its lockdown.
 * @param {object[]} packages
 * @param {{planRun:boolean, sessionAlive:(id:string)=>boolean, transcriptExists:(cwd:string, id:string)=>boolean}} env
 * @returns {Array<{id:string, how:'chat'|'fresh', mode:'nudge'|'resume'|'reopen'|'requeue'}>}
 */
function packagesToResume(packages, env) {
  const out = [];
  for (const p of Array.isArray(packages) ? packages : []) {
    if (!p || p.state !== 'stalled' || p.error !== RESTARTED) continue;
    if (p.splitting === true || (Array.isArray(p.splitInto) && p.splitInto.length)) continue;
    out.push({ id: p.id, ...resumeMode(p, env) });
  }
  return out;
}

function resumeMode(p, env) {
  if (!p.root || !p.branch) return { how: 'fresh', mode: 'requeue' };
  if (env.planRun) return { how: 'fresh', mode: 'reopen' };
  if (p.sessionId && env.sessionAlive(p.sessionId)) return { how: 'chat', mode: 'nudge' };
  const id = normalizeTranscriptId(p.transcriptId);
  if (id && safeExists(env.transcriptExists, p.cwd || p.root, id)) return { how: 'chat', mode: 'resume' };
  return { how: 'fresh', mode: 'reopen' };
}

function safeExists(fn, cwd, id) {
  try {
    return fn(cwd, id) === true;
  } catch {
    return false;
  }
}

/**
 * Live sessions' conversation ids onto their packages (the watcher's id
 * follows /clear). Returns the same array when nothing changed.
 * @param {object[]} packages
 * @param {(sessionId:string) => string|null} transcriptIdOf
 */
function withTranscriptIds(packages, transcriptIdOf) {
  let changed = false;
  const next = packages.map((p) => {
    if (!p.sessionId || !isActive(p)) return p;
    let id = null;
    try {
      id = normalizeTranscriptId(transcriptIdOf(p.sessionId));
    } catch {
      id = null;
    }
    if (!id || id === p.transcriptId) return p;
    changed = true;
    return { ...p, transcriptId: id };
  });
  return changed ? next : packages;
}

/**
 * "Pause for shutdown" on the package list: the named packages become stalled
 * 'restarted' (their tab, worktree and transcript kept), the named retry
 * packages go back to pending so the resume's pump launches them.
 * @param {object[]} packages
 * @param {{stop:Set<string>, requeue:Set<string>, nowMs:number}} what
 */
function markPausedForShutdown(packages, { stop, requeue, nowMs }) {
  return packages.map((p) => {
    if (stop.has(p.id)) {
      return {
        ...p,
        state: 'stalled',
        error: RESTARTED,
        detail: 'pausedForShutdown',
        stalledAt: nowMs,
        verifyPhase: null,
        stallHistory: withHistoryEntry(p.stallHistory, { at: nowMs, reason: RESTARTED, detail: 'pausedForShutdown' }),
      };
    }
    if (requeue.has(p.id) && p.state === 'failed') return { ...p, state: 'pending' };
    return p;
  });
}

/** The ids "Pause for shutdown" stops: every launched worker. */
function idsToStop(packages) {
  return new Set(packages.filter((p) => p.state === 'launched').map((p) => p.id));
}

/**
 * {planId, projectId?} from the renderer: plain object, a plan-id-shaped
 * string and an optional project scope - nothing else is read.
 * @returns {{ok:true, payload:{planId:string, projectId?:string|null}}|{ok:false, error:'badPayload'}}
 */
function planIdPayload(raw) {
  if (!isObj(raw) || typeof raw.planId !== 'string' || !PLAN_ID_RE.test(raw.planId)) return { ok: false, error: 'badPayload' };
  const out = { planId: raw.planId };
  if (Object.prototype.hasOwnProperty.call(raw, 'projectId')) {
    const p = raw.projectId;
    if (p !== null && (typeof p !== 'string' || !p || p.length > MAX_PROJECT_ID_CHARS)) return { ok: false, error: 'badPayload' };
    out.projectId = p;
  }
  return { ok: true, payload: out };
}

/** Report lines: which packages resumed after a shutdown, in their chat or fresh. */
function resumeReportLines(view) {
  const lines = [];
  for (const p of Array.isArray(view && view.packages) ? view.packages : []) {
    const hist = Array.isArray(p && p.stallHistory) ? p.stallHistory : [];
    for (const e of hist) {
      if (!e || e.reason !== RESUMED_REASON) continue;
      const how = e.how === 'chat' ? 'own chat reopened (claude --resume)' : 'fresh worker with the resume brief';
      const at = Number.isFinite(e.at) ? `${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} UTC ` : '';
      lines.push(`- ${at}\`${String(p.id).replace(/`/g, '')}\`: ${how}`);
    }
  }
  return lines.length ? ['', '## Resumed after shutdown', '', ...lines] : [];
}

/**
 * The controller side: the countdown, Resume now / Cancel and the pause.
 * @param {{
 *   getPlan: () => object|null, patch: (id:string, fields:object) => void, commit: () => void,
 *   pump: () => Promise<void>, now: () => number, setTimer: Function, clearTimer: Function,
 *   isBusy: () => boolean, finalizing: () => boolean, batteryHeld: () => boolean,
 *   autoBlocked: () => boolean, sessionAlive: (id:string) => boolean,
 *   transcriptExists: (cwd:string, id:string) => boolean,
 *   nudgeLive: (pkg:object, text:string) => {ok:boolean, error?:string},
 *   reopenChat: (pkg:object, text:string) => {ok:boolean, error?:string},
 *   reopenFresh: (pkg:object) => {ok:boolean, error?:string},
 *   requeue: (pkg:object) => void, beforeResume: () => void,
 *   stopForPause: () => {requeue:Set<string>, stop:Set<string>},
 *   escWorker: (sessionId:string) => void, afterPause: () => void,
 *   onRunEvent: (name:string, info?:object) => void, graceMs?: number, log?: (line:string) => void,
 * }} deps
 */
function createShutdownResume(deps) {
  let timer = null;
  const log = deps.log || (() => {});

  function clear() {
    if (timer) deps.clearTimer(timer);
    timer = null;
  }

  function arm(atMs) {
    clear();
    timer = deps.setTimer(fire, Math.max(0, atMs - deps.now()));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Restore: the run comes back interrupted, its countdown armed. */
  function onRestore(interrupted) {
    const plan = deps.getPlan();
    if (!plan) return;
    if (!interrupted) {
      plan.interrupted = null;
      return;
    }
    const resumeAt = resumeDeadline(interrupted, deps.now(), deps.graceMs || 0);
    plan.interrupted = { ...interrupted, resumeAt, waiting: null };
    arm(resumeAt);
  }

  function fire() {
    timer = null;
    resume({ manual: false }).catch((err) => log(`[resume] automatic resume failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Something that blocked a due automatic resume changed (battery, hold): try now. */
  function poke() {
    const plan = deps.getPlan();
    const i = plan && plan.interrupted;
    if (!i || !Number.isFinite(i.resumeAt) || deps.now() < i.resumeAt || !i.waiting) return;
    fire();
  }

  function blocker(plan, manual) {
    return resumeBlocker({
      busy: deps.isBusy(),
      hold: plan.hold || null,
      batteryLow: deps.batteryHeld(),
      lunasWork: !manual && deps.autoBlocked(),
    });
  }

  /**
   * Resume now (manual) or the countdown firing. A blocked automatic resume
   * shows why on the banner and looks again after RESUME_RECHECK_MS.
   */
  async function resume({ manual }) {
    const plan = deps.getPlan();
    if (!plan || !plan.interrupted) return { ok: false, error: 'notInterrupted' };
    const why = blocker(plan, manual);
    if (why) {
      if (plan.interrupted.waiting !== why) {
        plan.interrupted = { ...plan.interrupted, waiting: why };
        deps.commit();
      }
      if (!manual || Number.isFinite(plan.interrupted.resumeAt)) arm(Math.max(deps.now() + RESUME_RECHECK_MS, plan.interrupted.resumeAt || 0));
      return { ok: false, error: why };
    }
    clear();
    const picks = packagesToResume(plan.packages, {
      planRun: !!plan.planRun,
      sessionAlive: deps.sessionAlive,
      transcriptExists: deps.transcriptExists,
    });
    plan.interrupted = null;
    plan.killed = false;
    plan.settled = false;
    plan.started = true;
    if (!plan.runStartedAt) plan.runStartedAt = deps.now();
    deps.beforeResume();
    const done = picks.map((pick) => resumeOne(plan, pick));
    deps.onRunEvent('resumedAfterShutdown', {
      chat: done.filter((d) => d.how === 'chat').length,
      fresh: done.filter((d) => d.how === 'fresh').length,
      manual,
    });
    deps.commit();
    await deps.pump();
    return { ok: true, resumed: done };
  }

  /** One package: its chat first, a fresh worker when that cannot open. */
  function resumeOne(plan, pick) {
    const pkg = plan.packages.find((p) => p.id === pick.id);
    let how = pick.how;
    let res;
    if (pick.mode === 'requeue') {
      deps.requeue(pkg);
      res = { ok: true };
    } else if (pick.mode === 'nudge') {
      res = deps.nudgeLive(pkg, RESUME_SHUTDOWN_MESSAGE);
    } else if (pick.mode === 'resume') {
      res = deps.reopenChat(pkg, RESUME_SHUTDOWN_MESSAGE);
    }
    if (!res || (!res.ok && res.error !== 'noNodeModules')) {
      if (res) log(`[resume] ${pick.id}: chat resume failed (${res.error}), starting a fresh worker`);
      how = 'fresh';
      res = deps.reopenFresh(plan.packages.find((p) => p.id === pick.id));
    }
    const current = plan.packages.find((p) => p.id === pick.id);
    if (!res.ok) {
      // Held for node_modules: the hold's Resume reopens it. Anything else waits for Retry.
      deps.patch(pick.id, { detail: `resume failed: ${res.error}` });
      return { id: pick.id, how, ok: false, error: res.error };
    }
    const entry = { at: deps.now(), kind: 'resume', reason: RESUMED_REASON, detail: how, how };
    deps.patch(pick.id, { terminal: false, autoRetries: 0, stallHistory: withHistoryEntry(current.stallHistory, entry) });
    return { id: pick.id, how, ok: true };
  }

  /** Cancel: the run stays held as after any restart; Retry still works by hand. */
  function cancel() {
    const plan = deps.getPlan();
    if (!plan || !plan.interrupted) return { ok: false, error: 'notInterrupted' };
    clear();
    plan.interrupted = null;
    plan.started = false;
    deps.onRunEvent('resumeCancelled');
    deps.commit();
    return { ok: true };
  }

  /** Retry / Approve / Kill / Discard by hand: the interruption is over, no banner. */
  function drop() {
    clear();
    const plan = deps.getPlan();
    if (plan) plan.interrupted = null;
  }

  /** "Pause for shutdown" on a running run. */
  function pause() {
    const plan = deps.getPlan();
    if (!plan || !plan.started || plan.killed || plan.settled) return { ok: false, error: 'notRunning' };
    if (plan.interrupted) return { ok: false, error: 'alreadyPaused' };
    if (deps.finalizing()) return { ok: false, error: 'busy' };
    const nowMs = deps.now();
    const stopped = deps.stopForPause();
    const stop = new Set([...idsToStop(plan.packages), ...stopped.stop]);
    for (const p of plan.packages) if (stop.has(p.id) && p.state === 'launched' && p.sessionId) deps.escWorker(p.sessionId);
    // A usage-limit pause in progress: the resume waits for its reset.
    const resetAt = futureOrNull(plan.pausedUntil, nowMs);
    if (plan.pausedUntil && plan.pauseStartedAt) plan.pausedTotalMs = (plan.pausedTotalMs || 0) + Math.max(0, nowMs - plan.pauseStartedAt);
    plan.pausedUntil = null;
    plan.pauseStartedAt = null;
    plan.packages = markPausedForShutdown(plan.packages, { stop, requeue: stopped.requeue, nowMs });
    plan.interrupted = { at: nowMs, by: 'pause', resetAt, resumeAt: null, waiting: null };
    deps.onRunEvent('pausedForShutdown', { stopped: stop.size });
    deps.commit();
    deps.afterPause();
    return { ok: true };
  }

  /** The board's banner data, or null. */
  function view() {
    const plan = deps.getPlan();
    const i = plan && plan.interrupted;
    if (!i) return null;
    const nowMs = deps.now();
    const resetAt = futureOrNull(i.resetAt, nowMs);
    return {
      at: i.at,
      by: i.by,
      // null = no countdown (a pause in this session): Resume by hand.
      resumeAt: Number.isFinite(i.resumeAt) ? i.resumeAt : null,
      resetAt,
      waiting: i.waiting || (resetAt && Number.isFinite(i.resumeAt) ? 'usageLimit' : null),
      // "Safe to turn off the PC": nothing runs (a verify may still finish).
      safe: !plan.packages.some(isActive) && !deps.finalizing(),
      toResume: packagesToResume(plan.packages, { planRun: !!plan.planRun, sessionAlive: () => false, transcriptExists: () => false }).length,
    };
  }

  return { onRestore, resume, cancel, drop, pause, poke, view, dispose: clear };
}

module.exports = {
  RESUME_COUNTDOWN_MS,
  RESUME_RECHECK_MS,
  RESUME_SHUTDOWN_MESSAGE,
  RESUMED_REASON,
  normalizeTranscriptId,
  normalizeInterrupted,
  interruptedOnRestore,
  resumeDeadline,
  resumeBlocker,
  packagesToResume,
  withTranscriptIds,
  markPausedForShutdown,
  idsToStop,
  planIdPayload,
  resumeReportLines,
  createShutdownResume,
};
