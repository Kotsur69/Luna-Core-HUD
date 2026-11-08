// ============================================================================
// LunaCore - God Mode v2 run controller (DONE_ORCHESTRATOR_PLAN.md slices 3 + 4)
// ----------------------------------------------------------------------------
// One plan at a time lives here, in the main process: the renderer only ever
// sees a view of it and refers to it by id, so it can approve, edit a prompt,
// retry or kill - never name a folder, a branch or a profile.
//
// Slice 3: plan -> review -> launch. Launching a package = a fresh worktree
// (src/worktrees.js) + a brief file + a normal tab whose `claude` starts with
// "read your brief" as its first message (launch.js withTaskBrief).
//
// Slice 4 (supervisor + finish): Approve STARTS the run - every package whose
// dependencies are pushed launches as a worker slot frees up. Per worker:
//   turn end    -> LUNA_DONE: finish (orchestraFinish.js: commit leftovers,
//                  verify ourselves, push the branch, tick its to-dos)
//                  no marker: nudge, max 3 -> stalled
//   usage limit -> RUN-wide pause (the limit is per account), one timer,
//                  every worker told to continue once it resets
//   approval    -> that worker stalled, the others keep going
//   2 h working -> stalled
// Second pass: scheduled start (now / HH:MM / when the 5 h window resets),
// Sonnet -> Opus escalation after two stalls, a live file-overlap guard fed by
// each worker's git status, and approval stalls logged as allow-rule
// suggestions. Slice 5: once the run settles, orchestraFinalize.js opens PRs /
// merges / does nothing (per run), removes pushed worktrees, notes stalled
// packages on their to-dos and writes the report.
// Rules live in orchestraSupervisor.js (pure); timers, tabs and git are here
// behind injected deps. The run is written to orchestra.local.json on every
// transition; after a restart running packages come back stalled with their
// worktrees, and Retry picks them up.
// ============================================================================

'use strict';

const path = require('path');
const { validatePlan, estimatePlan, pickTodos, plannerEffortOf, MAX_PARALLEL, MAX_PROMPT_CHARS, PLANNER_MODEL } = require('./orchestraPlan');
const { lastWordsFrom, outputTail } = require('./orchestraDiagnose');
const sup = require('./orchestraSupervisor');
const { DEFAULT_EFFORT, isEffort, normalizeEffort, nextEffort } = require('./efforts');
const { createFinalizer, ABORT_FINISH_AFTER_MS, postMergeContext, slugOf } = require('./orchestraFinalize');
const { createFixupRunner } = require('./orchestraFixup');
const pushSecrets = require('./pushSecrets');
const { createMergeRunDeps } = require('./orchestraMergeRun');
const { planWaitDecision, createPlanWaiter } = require('./orchestraPlanWait');
// A planner limit with another Claude account free: replan after this long.
const ACCOUNT_SWITCH_RETRY_MS = 3000;
const { FREE_BRANCH_PREFIX, isSafeFreeBranch, freeRunSettings, integrationFor } = require('./orchestraFree');
const {
  cleanupFailedLaunch,
  earlierWorktrees,
  clearEarlierLaunches,
  withLeftover,
  sweepOrphanBranches,
} = require('./orchestraCleanup');
const { launchRetryDecision, createResumeGate } = require('./orchestraLaunchRetry');
const { createPowerFlow } = require('./orchestraPower');
const { createPowerCtl } = require('./powerctl');
const { createSleepWatch, sleepCredit, recordSleep } = require('./orchestraSleep');
const { createRecoverer } = require('./orchestraRecover');

const BRIEF_DIR = 'tasks';
// A turn end and the usage-limit error that ended it arrive in one transcript
// fragment, the limit second; the nudge waits this long so the pause can
// cancel it instead of spending a nudge on a wall.
const NUDGE_DELAY_MS = 5000;
// No reset time parsed from the limit message -> look again after this.
const DEFAULT_PAUSE_MS = 30 * 60 * 1000;
// Resume a little after the reset, not on the second.
const RESUME_GRACE_MS = 60 * 1000;
// A turn that ended while a background process of the worker's own still
// ran (a test suite) is not nudged: LunaCore waits for the process to report
// back, at most this long, so a stuck process cannot hold the package forever.
const BACKGROUND_WAIT_MS = 30 * 60 * 1000;
// A launch that failed on machinery (worktree, brief, tab) is tried again
// by itself after this long, at most sup.MAX_AUTO_RETRIES times.
const AUTO_RETRY_DELAY_MS = 2 * 60 * 1000;
const ESC = '\x1b';

/**
 * The brief a worker reads first: LunaCore's own fixed contract around the
 * planner's prompt, so the rules do not depend on the planner remembering
 * them.
 * @param {{id:string, title:string, prompt:string, verify:string}} pkg
 * @param {string} branch
 * @param {{resume?:boolean, escalation?:{reason:string, detail:string|null},
 *   depMerge?:{branches:string[], files:string[]}|null}} [opts] depMerge
 *   defaults to the package's recorded one, so a resume brief keeps it
 * @returns {string}
 */
function briefText(pkg, branch, opts = {}) {
  const esc = opts.escalation;
  const depMerge = opts.depMerge !== undefined ? opts.depMerge : pkg.depMerge;
  return [
    `# LunaCore task: ${pkg.title}`,
    '',
    ...depMergeSection(pkg, depMerge, opts.resume),
    `Package \`${pkg.id}\` of a God Mode plan. You are in an isolated git worktree on branch \`${branch}\`.`,
    ...(opts.resume
      ? ['', 'RESUMING: an earlier session already worked on this. Check `git status` and `git log` first and continue from there.']
      : []),
    ...(esc
      ? [
          '',
          `ESCALATED: the previous worker stalled twice on this package (last reason: ${esc.reason}${
            esc.detail ? ` - ${esc.detail}` : ''
          }). Find out why before you continue.`,
        ]
      : []),
    '',
    pkg.prompt,
    '',
    '## Verify',
    pkg.verify ? `Run \`${pkg.verify}\` and fix until it passes.` : "Check your work with the project's tests before you finish.",
    'Run the verify command in the foreground and wait for it to finish. Do not end your turn while a test run (or any other command) of yours is still running in the background: an ended turn tells LunaCore you stopped.',
    '',
    '## Rules',
    '- Work only in this worktree. Do not push, merge or switch branches.',
    `- ${DEPS_RULE}`,
    '- When the work is done and verified, commit it on this branch with a conventional commit message.',
    pushSecrets.FAKE_SECRET_RULE,
    `- End your final message with the line \`LUNA_DONE ${pkg.id}\`, or \`LUNA_BLOCKED ${pkg.id}: <reason>\` if you cannot finish.`,
    '',
  ].join('\n');
}

// LunaCore installs every package worktree's dependencies before the worker
// starts (orchestraDeps.js). A worker that links node_modules to the main
// checkout empties it when the worktree is removed.
const DEPS_RULE =
  'Dependencies are already installed in this worktree (node_modules). Do not link node_modules to another checkout and do not reinstall, delete or replace them. If they look broken, stop and end with LUNA_BLOCKED.';

/** A package a 'noNodeModules' hold keeps waiting (verify, launch, restart or Retry). */
const isHeld = (p) => p.awaitingDeps === true || !!p.heldResume || p.heldLaunch === true || p.heldRetry === true;

// One line of model-facing text from git output: no control characters.
const oneLine = (v) => String(v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);

/**
 * The first section of a brief whose dependency branches could not all be
 * merged at launch: the worker merges them itself before its task.
 * @param {{id:string, verify:string}} pkg
 * @param {{branches:string[], files:string[]}|null|undefined} depMerge
 * @param {boolean} [resume]
 * @returns {string[]}
 */
function depMergeSection(pkg, depMerge, resume) {
  if (!depMerge || !Array.isArray(depMerge.branches) || !depMerge.branches.length) return [];
  const files = Array.isArray(depMerge.files) ? depMerge.files : [];
  const verify = pkg.verify ? `\`${pkg.verify}\`` : "the project's tests";
  return [
    '## Before your task: merge the dependency branches',
    `Your worktree starts from one dependency; these branches could not be merged automatically${
      resume ? ' (skip the ones `git log` shows as already merged)' : ''
    }:`,
    ...depMerge.branches.map((b) => `- \`git merge --no-edit ${oneLine(b)}\``),
    ...(files.length ? ['', `Conflicting files: ${files.map((f) => `\`${oneLine(f)}\``).join(', ')}.`] : []),
    '',
    `For each branch above run the merge, resolve every conflict keeping the intent of BOTH sides, run ${verify}, and commit the merge. Only then start the task.`,
    `If you truly cannot resolve it, end with \`LUNA_BLOCKED ${pkg.id}: dependency merge\`.`,
    '',
  ];
}

/**
 * What a worker has to merge itself, or null when the launch merged every
 * dependency branch (cleanly or with the headless resolver).
 * @param {object|null|undefined} merged mergeDeps result
 * @param {string[]} branches the branches that were asked for
 * @returns {{strategy:'worker', branches:string[], files:string[]}|null}
 */
function workerDepMerge(merged, branches) {
  if (merged && merged.ok) return null;
  const failed = merged && Array.isArray(merged.failed) && merged.failed.length ? merged.failed : [merged || {}];
  const named = failed.map((f) => f.branch).filter((b) => branches.includes(b));
  const files = [];
  for (const f of failed) {
    for (const file of Array.isArray(f.files) ? f.files : []) {
      if (typeof file === 'string' && !files.includes(file)) files.push(file);
    }
  }
  // A result without branch names (older shape): hand the worker all of them.
  return { strategy: 'worker', branches: (named.length ? named : branches).slice(0, 10), files: files.slice(0, 10) };
}

// Where in a launch each failure code happened (the board's failure block).
const FAILURE_STAGES = {
  briefFailed: 'brief',
  noTab: 'tab',
  launchThrew: 'launch',
  unsafeBranch: 'worktree',
  depMergeFailed: 'depMerge',
  conflict: 'depMerge',
  depVerifyFailed: 'depVerify',
};

/**
 * The structured record of a failed launch the board renders: code, stage,
 * the dependency branch involved, the conflicting files, when it happened.
 * @param {{error?:string, detail?:string|null, depMerge?:object|null}} result
 * @param {string|null} depBranch the dependency the worktree started from
 * @param {number} at
 */
function failureOf(result, depBranch, at) {
  const code = result.error || 'failed';
  const dm = result.depMerge && Array.isArray(result.depMerge.branches) ? result.depMerge : null;
  return {
    code,
    stage: FAILURE_STAGES[code] || 'worktree',
    branch: (dm && dm.branches[0]) || depBranch || null,
    files: dm && Array.isArray(dm.files) ? dm.files.slice(0, sup.MAX_FAILURE_FILES) : [],
    detail: result.detail || null,
    at,
  };
}

/**
 * A resume brief for an automatic restart after a stall: the normal brief
 * plus why the previous session stopped, so the new one starts there.
 * @param {string} text a briefText() result
 * @param {string} reason the stall reason (noMarker, blocked, ...)
 * @param {string|null} detail
 * @returns {string}
 */
function withStallNote(text, reason, detail) {
  return [
    text.trimEnd(),
    '',
    '## Why you were restarted',
    `The previous session on this package stalled (reason: ${reason}${detail ? ` - ${detail}` : ''}). Find out why before you continue.`,
    '',
  ].join('\n');
}

/**
 * Luna's Work hook: the to-dos a plan is built from when the caller names
 * the cards itself. Each entry is a card's `at` or a card object; only open,
 * non-manual store cards count (their `at` is what gets ticked later), in
 * the given order, each once. A given object's fields (e.g. a builder brief
 * in `details`) override the stored card's.
 * @param {Array<object>} allOpen open, non-manual store cards
 * @param {Array<number|object>} cards
 * @returns {Array<object>}
 */
function givenCards(allOpen, cards) {
  const open = new Map(allOpen.map((t) => [t.at, t]));
  const out = [];
  const seen = new Set();
  for (const c of cards) {
    const isObject = !!c && typeof c === 'object';
    const at = isObject ? c.at : c;
    if (!Number.isFinite(at) || seen.has(at) || !open.has(at)) continue;
    seen.add(at);
    const stored = open.get(at);
    out.push(isObject ? { ...stored, ...c, at, text: typeof c.text === 'string' && c.text ? c.text : stored.text } : stored);
  }
  return out;
}

/**
 * @param {{
 *   runPlanner: Function, addWorktree: Function, createSession: Function,
 *   readTodos: Function, dirtyCount: Function, writeBrief: Function,
 *   briefDir: () => string, now?: () => number,
 *   finishPackage?: Function, headSha?: Function, writePty?: Function,
 *   sessionAlive?: Function, tickTodos?: Function, workerSettings?: Function,
 *   saveState?: Function, loadState?: Function, onChange?: Function, onLive?: Function,
 *   onRunEvent?: Function, setTimer?: Function, clearTimer?: Function,
 *   closeSession?: Function, usageResetAt?: () => number|null,
 *   baseBranchOf?: Function, mergeDeps?: Function, createPr?: Function,
 *   integrateMerge?: Function, removeWorktree?: Function, updateTodos?: Function,
 *   writeReport?: Function, notify?: Function, putSnapshot?: Function, sleep?: Function,
 *   runSelfCheck?: Function, pushBranch?: Function, deleteBranch?: Function,
 *   listOwnBranches?: Function, worktreeBranches?: Function, log?: Function,
 *   power?: object, awake?: {release:Function, restore:Function}, flush?: Function,
 *   notifyPower?: Function, appendReport?: Function, otherRunsActive?: () => boolean,
 *   repoBusy?: (repoPath:string) => boolean, powerFlow?: ReturnType<typeof createPowerFlow>,
 * }} deps
 *   repoBusy: multi God Mode (orchestraRegistry.js) - another project's run
 *   holds this repo, so makePlan refuses with 'repoBusy'.
 *   powerFlow: multi God Mode A3 - the registry's ONE sleep / shutdown flow
 *   over every run. Without it the controller builds its own from `power`,
 *   `awake`, `flush`, `notifyPower` and `appendReport` (a single run).
 */
function createOrchestra(deps) {
  const now = deps.now || Date.now;
  const noop = () => {};
  const finishPackage = deps.finishPackage || (async () => ({ ok: false, stage: 'push', detail: 'unavailable' }));
  const headSha = deps.headSha || (async () => null);
  const writePty = deps.writePty || (() => false);
  const sessionAlive = deps.sessionAlive || (() => false);
  const tickTodos = deps.tickTodos || noop;
  const workerSettings =
    deps.workerSettings ||
    (() => ({ model: 'opus', effort: 'plan', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] }));
  const closeSession = deps.closeSession || noop;
  // Merging into the base branch pushes it: main asks Mati natively. No
  // dialog available = no merge. {release: true} - the same dialog also
  // names the release cut after the merge ("Create a new release after finish").
  const confirmMerge = (extra = {}) =>
    deps.confirmMerge
      ? Promise.resolve(deps.confirmMerge(plan.baseBranch, { release: extra.release === true })).then((yes) => yes === true, () => false)
      : Promise.resolve(false);
  const saveState = deps.saveState || noop;
  const onChange = deps.onChange || noop;
  const onLive = deps.onLive || noop;
  const onRunEvent = deps.onRunEvent || noop;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || noop;
  // Package worktree dependencies (orchestraDeps.js): install after
  // addWorktree, check before a worker starts and before the post-DONE verify.
  const installDeps = deps.installDeps || (async () => ({ ok: true, output: '' }));
  const checkDeps = deps.checkDeps || (() => ({ ok: true, needed: false }));

  /** @type {null|object} */
  let plan = null;
  let busy = false;
  // The repo a makePlan in flight plans for (no plan exists yet), so a second
  // project cannot plan the same repo meanwhile.
  let planningRepo = null;
  let pumping = false;
  /** pkgId -> pending nudge timer (also the bounded wait on a background process) */
  const nudgeTimers = new Map();
  /** sessionId -> background processes the worker started that have not reported back */
  const backgroundOpen = new Map();
  /** sessionId -> when the worker last showed activity (its git status changed) */
  const lastActivity = new Map();
  /** pkgId -> scheduled automatic relaunch after a machinery failure */
  const retryTimers = new Map();
  /** pkgId -> automatic retries spent on a git that did not answer (orchestraLaunchRetry.js) */
  const transientRetries = new Map();
  // Launches wait a little right after a system resume.
  const resumeGate = createResumeGate({ now });
  let resumeTimer = null;
  let scheduleTimer = null;
  // Planning that hit the 5 h / weekly limit waits for the reset and then
  // plans on its own (orchestraPlanWait.js).
  const planWaiter = createPlanWaiter({
    setTimer,
    clearTimer,
    now,
    onChange: deps.onPlanWait || noop,
    replan: (ctx) => makePlan(ctx),
  });

  // The end-of-run self-check's one fix-up worker (orchestraFixup.js): a
  // tab, never a package.
  const fixup = createFixupRunner({
    getPlan: () => plan,
    createSession: (opts) => deps.createSession(opts),
    writeBrief: (file, text) => deps.writeBrief(file, text),
    briefDir: () => deps.briefDir(),
    closeSession: (id) => closeSession(id),
    sessionAlive: (id) => sessionAlive(id),
    // The run's (frozen) worker model and permission mode; 'plan' has no single model -> CLI default.
    model: () => {
      const m = (plan && plan.workerModel) || workerSettings().model;
      return m && m !== 'plan' ? m : null;
    },
    // A forced Settings level, else the routine default.
    effort: () => normalizeEffort(plan && plan.workerEffort) || DEFAULT_EFFORT,
    permissionMode: () => (plan && plan.permissionMode) || workerSettings().permissionMode || null,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
  });

  // The merge's own deps (orchestraMergeRun.js): task text, the same fix-up
  // worker for a package red after its merge, the stop check, the count.
  const mergeRun = createMergeRunDeps({
    getPlan: () => plan,
    integrateMerge: deps.integrateMerge,
    runSelfCheck: deps.runSelfCheck,
    runFixup: (args) => fixup.run(args),
  });

  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => patch(id, fields),
    commit: () => commit(),
    view: () => view(),
    onRunEvent: (...args) => onRunEvent(...args),
    now,
    createPr: deps.createPr ? (args) => deps.createPr({ ...args, repoPath: plan.repoPath }) : null,
    integrateMerge: deps.integrateMerge ? mergeRun.integrateMerge : null,
    runSelfCheck: mergeRun.runSelfCheck,
    pushBranch: deps.pushBranch,
    runFixup: (args) => fixup.run(args),
    checkCommand: () => workerSettings().checkCommand,
    currentBaseBranch: deps.baseBranchOf ? () => deps.baseBranchOf(plan.repoPath) : null,
    removeWorktree: deps.removeWorktree,
    closeSession,
    sessionAlive,
    updateTodos: deps.updateTodos,
    writeReport: deps.writeReport,
    notify: deps.notify,
    putSnapshot: deps.putSnapshot,
    onReport: deps.onReport,
    sleep: deps.sleep,
    onIdle: () => afterFinalize(),
    // The integrate watchdog (default: orchestraFinalize integrateTimeoutFor)
    // and the per-pass process scope whose children it kills (src/procTree.js).
    integrateTimeoutMs: deps.integrateTimeoutMs,
    createScope: deps.createProcessScope || null,
    drainMs: deps.integrateDrainMs,
    // An aborted pass's fix-up tab goes too: it edits the integration worktree.
    onAbort: () => fixup.abort(),
    // After a merge landed: the post-merge step implementations
    // (orchestraFinalize.js POST_MERGE_STEPS, built by orchestraPostMerge.js).
    postMerge: deps.postMerge || null,
  });
  const isBusy = () => busy || pumping || finalizer.isRunning();
  // The process-wide battery guard (orchestraPower.js createBatteryGuard):
  // low on battery, no new worker or verify starts until the PC is plugged in.
  const battery = deps.battery || null;
  const batteryHeld = () => !!(battery && battery.isHeld());
  // PC sleeps are not worker time (orchestraSleep.js). deps.tickMs = the
  // watchdog interval; it turns on the missed-'suspend' gap check.
  const sleepWatch = createSleepWatch({ now, tickMs: deps.tickMs });
  // The recovery playbook (orchestraRecover.js): a known environment stall
  // gets its automatic fix; Mati is asked once when that did not help.
  const recover = createRecoverer({
    getPkg: (id) => findPkg(id),
    findByRoot: (dir) => (plan ? plan.packages.find((p) => p.root && path.resolve(p.root) === path.resolve(dir)) : null) || null,
    record: (id, entry) => {
      const p = findPkg(id);
      if (!p) return;
      patch(id, { stallHistory: sup.withHistoryEntry(p.stallHistory, entry) });
      commit();
    },
    recordRun: (entry) => {
      if (!plan) return;
      plan.recoveries = sup.withHistoryEntry(plan.recoveries, entry);
      commit();
    },
    repoPath: () => (plan ? plan.repoPath : null),
    installDeps: (root, opts) => installDeps(root, opts),
    checkDeps: (root) => checkDeps(root),
    refinish: (id, extra) => refinish(id, extra),
    fixupRound: (id, res) => (res.stage === 'secrets' ? onSecretsFound(id, res) : onPushBlocked(id, res)),
    renameBranch: deps.renameBranch,
    setBranch: (id, branch) => patch(id, { branch }),
    ghAuthOk: deps.ghAuthOk,
    stall: (id, reason, detail, extra) => {
      if (!plan || !findPkg(id)) return;
      if (extra) patch(id, extra);
      stall(id, reason, detail);
    },
    resumeHeld: () => resumeHeldRun(),
    // The automatic install did not fix the hold: the usual message (no second toast).
    holdUnfixed: (res, asked) => onRunEvent('noNodeModules', { dir: res.dir, detail: res.detail || null, asked }),
    refinishRun: () => {
      if (!plan) return;
      // The retried pass may still sleep / shut the PC down when done.
      if (plan.settled) settledFinalize = true;
      background(finishRun({ planId: plan.id }).then((r) => r.ok || log(`[recover] finish run refused: ${r.error}`)), 'finishRun');
    },
    // Account failover already ran in main (claudefailover.js failoverTab)
    // before a limit reaches the run, so the playbook goes straight to the pause.
    notify: (ask) => {
      onRunEvent('recoverAsk', { id: ask.pkgId, cause: ask.cause });
      if (deps.notifyRecover) deps.notifyRecover(ask);
    },
    now,
    setTimer: (fn, ms) => setTimer(fn, ms),
    clearTimer: (t) => clearTimer(t),
    log,
  });

  // Sleep at the usage limit / shut down when done (orchestraPower.js): the
  // registry's shared flow, or this run's own.
  const approvalsPending = () =>
    plan.packages.some((p) => p.state === 'stalled' && p.error === 'needsApproval' && p.sessionId && sessionAlive(p.sessionId));
  const powerFlow = deps.powerFlow || createPowerFlow({
    power: deps.power || createPowerCtl({ platform: 'unsupported' }),
    getRun: () =>
      plan
        ? {
            planId: plan.id,
            pausedUntil: plan.pausedUntil,
            killed: plan.killed,
            approvalsPending: approvalsPending(),
            options: sup.normalizeOptions(plan.options),
          }
        : null,
    awake: deps.awake,
    flush: deps.flush,
    notify: deps.notifyPower,
    appendReport: deps.appendReport,
    onChange: () => onChange(view()),
    graceMs: RESUME_GRACE_MS,
    now,
    setTimer,
    clearTimer,
    log,
  });
  // Set when a run settles on its own; only such a run may shut the PC down.
  let settledFinalize = false;
  // Luna's Work hook: makePlan's optional ctx.onRunSettled, bound to the plan
  // it made and fired once when that run's finalize goes idle. Not saved:
  // after a restart Luna's Work resumes on its own.
  /** @type {null|{planId:string, fn:Function}} */
  let runSettledHook = null;
  // LW 2.12: `${pkgId}|${file}` already sent an ownership stop, so a worker
  // is told once per file. Not saved: a restarted run is held anyway.
  const ownershipNudged = new Set();
  const background = (promise, where) =>
    promise.catch((err) => onRunEvent('error', { where, message: err instanceof Error ? err.message : String(err) }));
  // A battery change repaints the board; plugged in, what waited launches.
  if (battery) {
    battery.subscribe(() => {
      if (!plan) return;
      onChange(view());
      if (!batteryHeld()) kick();
    });
  }

  /**
   * Brings back the run saved by the previous LunaCore. Not in the
   * constructor: main builds this before app.whenReady(), when the user
   * config folder is not dependable yet. The restored run is held (not
   * started) - nothing launches at boot until Mati presses Approve or Retry.
   */
  function restore() {
    const normalized = deps.loadState ? sup.normalizeStoredPlan(deps.loadState()) : null;
    // Folders saved on another PC / under another user name re-homed here.
    const stored = normalized && deps.resolvePath ? sup.rehomePlanPaths(normalized, deps.resolvePath, deps.resolveFile) : normalized;
    if (!stored || plan) return false;
    plan = { ...sup.restoreAfterRestart(stored, now()), started: false, killed: false, pausedUntil: null, pauseStartedAt: null, settled: false };
    // A held run is held anyway after a restart; Approve / Retry check again.
    releaseHold();
    // A schedule Mati armed survives a restart; one already missed does not
    // start the run late - the run stays held.
    if (plan.scheduledAt && plan.scheduledAt > now()) armSchedule(plan.scheduledAt);
    else plan.scheduledAt = null;
    commit();
    // Branches older builds left behind for this plan's packages.
    sweepBranches().catch(noop);
    return true;
  }

  /**
   * Deletes this plan's orphaned `luna/<pkgId>-<stamp>` branches (no
   * worktree, not recorded on a package, no own commits) and logs them.
   * @returns {Promise<{ok:boolean, deleted:string[], kept:Array<{branch:string, error:string}>, error?:string}>}
   */
  async function sweepBranches() {
    if (!plan || !deps.deleteBranch || !deps.listOwnBranches || !deps.worktreeBranches) {
      return { ok: false, deleted: [], kept: [], error: 'unavailable' };
    }
    const res = await sweepOrphanBranches({
      repoPath: plan.repoPath,
      packages: plan.packages,
      git: { listOwnBranches: deps.listOwnBranches, worktreeBranches: deps.worktreeBranches, deleteBranch: deps.deleteBranch },
    });
    if (res.deleted.length) log(`deleted orphan branches: ${res.deleted.join(', ')}`);
    if (!res.ok) log(`branch sweep failed: ${res.error}`);
    return res;
  }

  function view() {
    if (!plan) return null;
    return {
      id: plan.id,
      projectId: plan.projectId,
      notes: plan.notes,
      warnings: plan.warnings,
      errors: plan.errors,
      estimate: plan.estimate,
      costUsd: plan.costUsd,
      // null on a plan stored before the picker had the select.
      plannerEffort: plan.plannerEffort || null,
      dirty: plan.dirty,
      model: PLANNER_MODEL,
      workerModel: plan.workerModel || workerSettings().model,
      workerEffort: plan.workerEffort || workerSettings().effort || 'plan',
      permissionMode: plan.permissionMode || workerSettings().permissionMode,
      integrationMode: plan.integrationMode || workerSettings().integration,
      baseBranch: plan.baseBranch,
      started: plan.started,
      killed: plan.killed,
      settled: plan.settled,
      pausedUntil: plan.pausedUntil,
      // A machine problem holding the whole run ('noNodeModules'); Resume clears it.
      hold: plan.hold ? { reason: plan.hold.reason, dir: plan.hold.dir, detail: plan.hold.detail || null, at: plan.hold.at } : null,
      scheduledAt: plan.scheduledAt,
      // The morning report's Timeline (orchestraReport.js).
      runStartedAt: plan.runStartedAt || null,
      pausedTotalMs: plan.pausedTotalMs || 0,
      // Each PC sleep during the run: [{start, durationMs}] (orchestraSleep.js).
      sleeps: Array.isArray(plan.sleeps) ? plan.sleeps.map((s) => ({ ...s })) : [],
      // Run-level automatic fixes (integration retries, orchestraRecover.js).
      recoveries: Array.isArray(plan.recoveries) ? plan.recoveries.map((e) => ({ ...e })) : [],
      freeMode: plan.freeMode === true,
      options: sup.normalizeOptions(plan.options),
      integration: {
        ...plan.integration,
        running: finalizer.isRunning(),
        // From then on the board offers "Abort finish".
        abortAfter:
          finalizer.isRunning() && Number.isFinite((plan.integration || {}).startedAt)
            ? plan.integration.startedAt + ABORT_FINISH_AFTER_MS
            : null,
      },
      power: powerFlow.view(),
      battery: battery ? battery.view() : null,
      overlaps: sup.liveOverlaps(plan.packages),
      suggestions: sup.allowSuggestions(plan.approvalLog).filter((s) => !(plan.allowedTools || []).includes(s.rule)),
      tally: sup.tally(plan.packages),
      packages: plan.packages.map((p) => ({
        id: p.id,
        title: p.title,
        prompt: p.prompt,
        files: p.files,
        dependsOn: p.dependsOn,
        verify: p.verify,
        model: p.modelOverride || p.model,
        effort: p.effortOverride || p.effort || null,
        todos: p.todoAts.map((at) => plan.todoText.get(at) || String(at)),
        state: p.state,
        sessionId: p.sessionId,
        branch: p.branch,
        headSha: p.headSha,
        error: p.error,
        detail: p.detail,
        nudges: p.nudges,
        verifyRounds: p.verifyRounds,
        startedAt: p.startedAt,
        finishedAt: p.finishedAt || null,
        stalls: p.stalls,
        stallHistory: p.stallHistory || [],
        escalated: p.escalated,
        prUrl: p.prUrl,
        merged: p.merged,
        // Repo-relative paths the package changed (Luna's Work's bug-test rule).
        touched: p.touched || [],
        cleaned: p.cleaned,
        depMerge: p.depMerge || null,
        autoRetries: p.autoRetries || 0,
        autoResumed: p.autoResumed === true,
        terminal: p.terminal === true,
        blockedBy: p.blockedBy || null,
        failure: p.failure || null,
        lastWords: p.lastWords || null,
        verifyTail: p.verifyTail || null,
        awaitingDeps: p.awaitingDeps === true,
        verifyPhase: p.state === 'finishing' ? p.verifyPhase || null : null,
        scanFixup: p.scanFixup === true,
        pushFixup: p.pushFixup === true,
      })),
    };
  }

  /** Writes the run to disk and tells the renderer. Every transition ends here. */
  function commit() {
    // blockedBy follows terminal / state on every transition, never stale.
    if (plan) plan.packages = sup.withBlockedBy(plan.packages);
    saveState(plan ? sup.serializePlan(plan) : null);
    const v = view();
    onChange(v);
    // The phone's live run view (godmodelivepub.js throttles): the repo and
    // worktree roots ride along only so godmodesnapshot can cut paths out.
    try {
      onLive(
        v && {
          ...v,
          repoPath: plan.repoPath,
          roots: plan.packages.map((p) => p.root).filter(Boolean),
          packages: v.packages.map((p, i) => ({ ...p, pausedMs: plan.packages[i].pausedMs || 0 })),
        },
      );
    } catch (err) {
      log(`[orchestra] live snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const findPkg = (id) => (plan ? plan.packages.find((p) => p.id === id) : null);
  const bySession = (sessionId) => (plan && sessionId ? plan.packages.find((p) => p.sessionId === sessionId) : null);

  /** When a state change lands: stamped on settling, cleared on a relaunch (report timeline). */
  const finishStamp = (p, fields) =>
    'state' in fields && fields.state !== p.state ? { finishedAt: sup.SETTLED_STATES.has(fields.state) ? now() : null } : {};

  function patch(id, fields) {
    plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields, ...finishStamp(p, fields) } : p));
  }

  function cancelNudge(id) {
    const timer = nudgeTimers.get(id);
    if (timer) clearTimer(timer);
    nudgeTimers.delete(id);
  }

  function clearSchedule() {
    if (scheduleTimer) clearTimer(scheduleTimer);
    scheduleTimer = null;
  }

  function cancelAutoRetry(id) {
    const timer = retryTimers.get(id);
    if (timer) clearTimer(timer);
    retryTimers.delete(id);
  }

  function clearAllTimers() {
    for (const id of [...nudgeTimers.keys()]) cancelNudge(id);
    for (const id of [...retryTimers.keys()]) cancelAutoRetry(id);
    recover.cancel('run');
    backgroundOpen.clear();
    lastActivity.clear();
    if (resumeTimer) clearTimer(resumeTimer);
    resumeTimer = null;
    clearSchedule();
  }

  /** Worker settings + integration mode, frozen when the run starts. */
  function freezeSettings() {
    const s = workerSettings();
    plan.workerModel = plan.workerModel || s.model;
    plan.workerEffort = plan.workerEffort || (isEffort(s.effort) ? s.effort : 'plan');
    plan.permissionMode = plan.permissionMode || s.permissionMode;
    plan.integrationMode = plan.integrationMode || s.integration || 'pr';
    if (!plan.allowedTools) plan.allowedTools = (s.allowedTools || []).filter(sup.isAllowRule);
  }

  const modelFor = (pkg) => pkg.modelOverride || (plan.workerModel === 'plan' ? pkg.model : plan.workerModel);
  /** Escalation override, then a forced Settings level, then the planner's pick, then medium. */
  const effortFor = (pkg) =>
    normalizeEffort(pkg.effortOverride) || normalizeEffort(plan.workerEffort) || normalizeEffort(pkg.effort) || DEFAULT_EFFORT;

  /**
   * Runs the planner for one project. Replaces any previous plan, except one
   * whose run still has a worker going.
   * Optional hooks exist for Luna's Work; God Mode never sets them and
   * is unchanged without them: `cards` (card `at`s or card objects, see
   * givenCards) replaces the open-card / todoAts selection,
   * `onRunSettled(result)` is called once when this plan's run settles, and
   * `ownership` (LW 2.12, `{path|glob: owner}` with owner = package id or
   * card `at`) stops a worker that edits a file another package owns.
   * @param {{projectId:string|null, repoPath:string, profileId:string, env:object,
   *   todoAts?:number[]|null, plannerEffort?:string, cards?:Array<number|object>, onRunSettled?:Function,
   *   ownership?:object|object[]}} ctx
   */
  async function makePlan(ctx) {
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    // One run per repo across projects - checked here, so a replan after a
    // limit wait is refused too when another project took the repo meanwhile.
    if (deps.repoBusy && deps.repoBusy(ctx.repoPath)) return { ok: false, error: 'repoBusy' };
    // A manual item is the user's own job: the planner never sees it.
    const allOpen = deps.readTodos(ctx.projectId).filter((t) => !t.done && t.manual !== true);
    if (!allOpen.length) return { ok: false, error: 'noTodos' };
    // The picker's selection rides in ctx, so a limit-wait replan keeps it.
    const openTodos = Array.isArray(ctx.cards) ? givenCards(allOpen, ctx.cards) : pickTodos(allOpen, ctx.todoAts);
    if (!openTodos.length) return { ok: false, error: 'noneSelected' };
    // A manual (re-)plan replaces a pending wait; the waiter's own replan
    // is in state 'planning' and keeps it.
    if (planWaiter.isWaiting()) planWaiter.clear();

    const plannerEffort = plannerEffortOf(ctx.plannerEffort);
    busy = true;
    planningRepo = ctx.repoPath;
    try {
      const [res, dirty, baseBranch] = await Promise.all([
        // The picker's planner effort rides in ctx too, so a limit-wait or
        // account-failover replan plans at the same level.
        deps.runPlanner({ cwd: ctx.repoPath, env: ctx.env, openTodos, effort: plannerEffort }),
        deps.dirtyCount(ctx.repoPath),
        deps.baseBranchOf ? deps.baseBranchOf(ctx.repoPath) : null,
      ]);
      if (!res.ok) {
        const limits = deps.usageLimits ? deps.usageLimits() : [];
        const decision = planWaitDecision({ res, limits, now: now() });
        if (decision.action !== 'wait') return res;
        // Another Claude account is free (src/claudeaccounts.js): plan again
        // in a moment on it - the env is rebuilt, the old one carries the
        // limited account's token.
        if (deps.accountFailover && deps.accountFailover(decision.resumeAt || null)) {
          const retryCtx = deps.freshEnv ? { ...ctx, env: deps.freshEnv() } : ctx;
          planWaiter.arm(retryCtx, { ...decision, resumeAt: now() + ACCOUNT_SWITCH_RETRY_MS, source: 'account' });
          return { ok: false, error: 'waiting', planWait: planWaiter.view() };
        }
        planWaiter.arm(ctx, decision);
        return { ok: false, error: 'waiting', planWait: planWaiter.view() };
      }
      const checked = validatePlan(res.raw, openTodos);
      const ownership = sup.normalizeOwnership(ctx.ownership);
      clearAllTimers();
      ownershipNudged.clear();
      plan = {
        id: `p${now().toString(36)}`,
        projectId: ctx.projectId,
        repoPath: ctx.repoPath,
        profileId: ctx.profileId,
        notes: checked.notes,
        warnings: checked.warnings,
        errors: checked.errors,
        estimate: estimatePlan(checked.packages, openTodos),
        costUsd: res.costUsd,
        plannerEffort,
        dirty,
        workerModel: null,
        workerEffort: null,
        permissionMode: null,
        allowedTools: null,
        integrationMode: null,
        freeMode: false,
        baseBranch: sup.isBaseBranch(baseBranch) ? baseBranch : null,
        scheduledAt: null,
        approvalLog: [],
        options: sup.normalizeOptions({
          unattendedApprovalMin: workerSettings().unattendedApprovalMin,
          sleepOnLimit: false,
          shutdownWhenDone: false,
        }),
        integration: { state: 'idle', error: null, detail: null, at: null },
        started: false,
        killed: false,
        settled: false,
        pausedUntil: null,
        pauseStartedAt: null,
        hold: null,
        runStartedAt: null,
        pausedTotalMs: 0,
        sleeps: [],
        todoText: new Map(openTodos.map((t) => [t.at, t.text])),
        // LW 2.12: only a plan made with an ownership map carries the key.
        ...(ownership ? { ownership } : {}),
        packages: checked.packages.map((p) => ({
          ...p,
          state: 'pending',
          sessionId: null,
          branch: null,
          root: null,
          cwd: null,
          briefPath: null,
          baseSha: null,
          headSha: null,
          error: null,
          detail: null,
          nudges: 0,
          verifyRounds: 0,
          startedAt: null,
          pausedMs: 0,
          stalls: 0,
          stallHistory: [],
          escalated: false,
          modelOverride: null,
          effortOverride: null,
          touched: [],
          prUrl: null,
          merged: false,
          cleaned: false,
          autoRetries: 0,
          autoResumed: false,
          terminal: false,
          blockedBy: null,
          stalledAt: null,
          failure: null,
          // Push protection (pushSecrets.js): one fix-up round each for the
          // pre-push secret scan and for a GH013 rejection.
          scanFixup: false,
          pushFixup: false,
          pushBlockedSha: null,
          pushBlockDetail: null,
          // 'queued' | 'running' while finishing (verifyQueue.js), else null.
          verifyPhase: null,
        })),
      };
      runSettledHook = typeof ctx.onRunSettled === 'function' ? { planId: plan.id, fn: ctx.onRunSettled } : null;
      commit();
      return { ok: true, plan: view() };
    } finally {
      busy = false;
      planningRepo = null;
    }
  }

  function openTab(pkg, cwd, branch, briefPath) {
    return deps.createSession({
      profileId: plan.profileId,
      projectId: plan.projectId,
      cwd,
      branch,
      task: { briefPath, model: modelFor(pkg), effort: effortFor(pkg), permissionMode: plan.permissionMode, allowedTools: plan.allowedTools || [] },
    });
  }

  /** openTab from a sync path (timer, watcher callback): never throws. */
  function safeOpenTab(pkg, cwd, branch, briefPath) {
    try {
      return openTab(pkg, cwd, branch, briefPath);
    } catch {
      return null;
    }
  }

  // Evidence from an earlier attempt would explain the wrong failure: cleared too.
  const freshRun = () => ({
    nudges: 0,
    verifyRounds: 0,
    startedAt: now(),
    pausedMs: 0,
    error: null,
    detail: null,
    lastWords: null,
    verifyTail: null,
  });

  /**
   * Worktree + brief + tab for one package. Never throws. A failure after
   * the worktree was made removes the worktree AND its branch, and records
   * a structured `failure` for the board.
   */
  async function launchOne(pkg, stamp) {
    const made = { wt: null, base: null, depBranch: null };
    // A fresh launch replaces any held one (its worktree is cleared below).
    if (pkg.heldLaunch) patch(pkg.id, { heldLaunch: false });
    let leftovers = Array.isArray(pkg.leftovers) ? pkg.leftovers : [];
    // Awaited only when there is something to clear: a plain launch reaches
    // git without yielding first.
    if (earlierWorktrees(pkg).length) {
      const earlier = await clearEarlierLaunches(cleanupGit(), plan.repoPath, pkg);
      for (const e of earlier.errors) log(`earlier launch of ${pkg.id} not fully cleaned up: ${e}`);
      leftovers = earlier.kept;
      const gone = earlier.rootCleared ? { root: null, cwd: null, branch: null, briefPath: null, baseSha: null } : {};
      patch(pkg.id, { ...gone, leftovers });
    }
    let result;
    try {
      result = await launchOneUnsafe(pkg, stamp, made);
    } catch (err) {
      result = { state: 'failed', error: 'launchThrew', detail: err instanceof Error ? err.message.slice(0, 300) : null };
    }
    if (result.state !== 'failed') return { ...result, failure: null };
    const failure = failureOf(result, made.depBranch, now());
    if (!made.wt) return { ...result, failure };
    const cleaned = await cleanupFailedLaunch(cleanupGit(), plan.repoPath, made.wt, made.base);
    if (cleaned.error) log(`failed launch of ${pkg.id} not fully cleaned up: ${cleaned.error}`);
    // Worktree gone: Retry starts a fresh launch instead of reopening it.
    // Still there: remembered, so the next launch clears it first.
    const gone = cleaned.removed
      ? { branch: null, root: null, cwd: null, briefPath: null, baseSha: null }
      : { leftovers: withLeftover(leftovers, { root: made.wt.root, branch: made.wt.branch || null, base: made.base }) };
    return { ...result, ...gone, failure };
  }

  function cleanupGit() {
    return { removeWorktree: deps.removeWorktree, deleteBranch: deps.deleteBranch };
  }

  /**
   * A dependent builds on its dependencies' work: its worktree starts from
   * the first dependency's pushed head and merges the others in. A merge
   * that neither git nor the headless resolver can finish never fails the
   * package: the worker gets it as the first step of its brief.
   */
  async function launchOneUnsafe(pkg, stamp, made) {
    const pushedDeps = pkg.dependsOn.map(findPkg).filter((d) => d && d.state === 'pushed' && d.branch);
    const baseDep = pushedDeps.find((d) => d.headSha) || null;
    made.depBranch = baseDep ? baseDep.branch : null;
    const wt = await deps.addWorktree(plan.repoPath, `${pkg.id}-${stamp}`, {
      base: baseDep ? baseDep.headSha : undefined,
      ...(plan.freeMode ? { branchPrefix: FREE_BRANCH_PREFIX } : {}),
    });
    if (!wt.ok) {
      // git got as far as creating the folder: launchOne() cleans it up.
      if (wt.root) made.wt = { root: wt.root, branch: wt.branch || null };
      return { state: 'failed', error: wt.error, detail: wt.detail || null, retryable: wt.retryable === true };
    }
    // From here on every failure is cleaned up by launchOne().
    made.wt = wt;
    made.base = baseDep ? baseDep.headSha : null;
    // A free run never works on (or pushes) the target branch.
    if (plan.freeMode && !isSafeFreeBranch(wt.branch, plan.baseBranch)) {
      return { state: 'failed', error: 'unsafeBranch', detail: wt.branch || null };
    }
    const others = pushedDeps.filter((d) => d !== baseDep).map((d) => d.branch);
    let depMerge = null;
    if (others.length && deps.mergeDeps) {
      // mergeDeps aborts what it cannot merge, so the worktree is clean on the
      // base dependency's head plus whatever did merge.
      depMerge = workerDepMerge(await deps.mergeDeps(wt.root, others), others);
    }
    const baseSha = await headSha(wt.root);
    // After any dependency merges: the branch has no own work beyond this yet.
    if (baseSha) made.base = baseSha;
    const briefPath = path.join(deps.briefDir(), `${path.basename(wt.root)}.md`);
    const where = { branch: wt.branch, root: wt.root, cwd: wt.cwd, briefPath, baseSha, depMerge };
    // The worktree's own dependencies, before the worker starts. A failed
    // install keeps the worktree (Retry installs again) and stalls the package.
    const installed = await installDeps(wt.root);
    if (!installed.ok) return { ...where, ...installFailedFields(installed.output) };
    const ready = checkDeps(wt.root);
    // No package is stalled for a machine problem: the run holds and Resume
    // starts this worker in the same worktree.
    if (!ready.ok) return { ...where, state: 'pending', heldLaunch: true, held: ready };
    return startWorker(pkg, where);
  }

  /**
   * Brief + tab for a package whose worktree is ready.
   * @param {object} pkg
   * @param {{branch:string, root:string, cwd:string, briefPath:string, baseSha:string|null, depMerge:object|null}} where
   */
  function startWorker(pkg, where) {
    if (!deps.writeBrief(where.briefPath, briefText(pkg, where.branch, { depMerge: where.depMerge }))) {
      return { ...where, state: 'failed', error: 'briefFailed' };
    }
    const session = openTab(pkg, where.cwd, where.branch, where.briefPath);
    if (!session) return { ...where, state: 'failed', error: 'noTab' };
    return { ...where, ...freshRun(), state: 'launched', sessionId: session.id, heldLaunch: false };
  }

  /** A failed dependency install: its own error, the last line and the output tail. */
  function installFailedFields(output) {
    const lines = String(output || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      state: 'stalled',
      error: 'installFailed',
      detail: (lines.pop() || 'npm ci failed').slice(0, 300),
      verifyTail: outputTail(output),
      stalledAt: now(),
    };
  }

  /**
   * The safety net before a worker starts or a verify runs: the package's
   * node_modules must hold its dependencies. A held run passes nothing.
   * @returns {boolean}
   */
  function depsReady(pkg) {
    if (plan.hold) return false;
    const res = checkDeps(pkg && pkg.root);
    if (res.ok) return true;
    holdRun(res);
    return false;
  }

  /**
   * Holds the WHOLE run: no launch, no reopen and no verify until Resume.
   * Workers already running carry on in their own worktrees.
   * @param {{dir:string, detail?:string}} res a failed checkNodeModules
   */
  function holdRun(res) {
    // A killed run holds nothing: Retry checks again.
    if (plan.hold || plan.killed) return;
    plan.hold = { reason: 'noNodeModules', dir: res.dir, detail: res.detail || null, at: now() };
    // The playbook installs the package worktree's dependencies and resumes;
    // Mati is told only when it cannot.
    if (!recover.onHold(res)) onRunEvent('noNodeModules', { dir: res.dir, detail: res.detail || null });
  }

  /** Drops the hold and every package's waiting flag (restart, kill). */
  function releaseHold() {
    plan.hold = null;
    plan.packages = plan.packages.map((p) =>
      isHeld(p) ? { ...p, awaitingDeps: false, heldResume: null, heldLaunch: false, heldRetry: false } : p,
    );
  }

  async function launchPackages(chosen) {
    // Awaited only right after a resume: a plain launch reaches git without yielding.
    if (resumeGate.waitMs() > 0) await settleAfterResume();
    const stamp = now().toString(36).slice(-5);
    for (const pkg of chosen) {
      // Kill / pause / hold / low battery while an earlier launch was awaiting git: stop here.
      if (plan.killed || plan.pausedUntil || plan.hold || batteryHeld()) break;
      cancelAutoRetry(pkg.id);
      const before = findPkg(pkg.id) || pkg;
      const { retryable, held, ...result } = await launchOne(before, stamp);
      if (plan.killed && result.state === 'launched') {
        // The kill landed during this very launch: the tab exists, stop it too.
        writePty(result.sessionId, ESC);
        patch(pkg.id, { ...result, state: 'killed' });
      } else {
        patch(pkg.id, result);
        if (result.state === 'failed') onLaunchFailed(before, { ...result, retryable });
        else transientRetries.delete(pkg.id);
        if (held) holdRun(held);
        // Killed during the install: no held launch to resume, the next
        // launch clears this worktree like any earlier one.
        if (held && plan.killed) patch(pkg.id, { heldLaunch: false });
        if (result.state === 'stalled') {
          // An install failure: nothing automatic installs again, Retry does.
          markTerminal(pkg.id, result.error);
          onRunEvent('stalled', { id: pkg.id, reason: result.error });
        }
      }
      commit();
    }
  }

  /** Right after a system resume git is slow to answer: wait it out first. */
  async function settleAfterResume() {
    // One wait, capped by the gate: a clock that stands still or steps back never loops.
    const wait = resumeGate.waitMs();
    if (wait <= 0) return;
    await new Promise((resolve) => {
      const timer = setTimer(resolve, wait);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
  }

  /**
   * Machinery auto-retry: a failed launch is tried again by itself after
   * AUTO_RETRY_DELAY_MS, at most MAX_AUTO_RETRIES times. The same error +
   * detail twice in a row means it will not fix itself: terminal. A git that
   * did not answer (result.retryable) backs off instead and is never terminal
   * on a repeat (orchestraLaunchRetry.js).
   * @param {object} before the package as it was before this launch
   * @param {{error?:string, detail?:string|null}} result
   */
  function onLaunchFailed(before, result) {
    if (plan.killed) return;
    // Just after a wake: the playbook's own wait-and-retry-once comes first.
    const wake = recover.onLaunchFailed(before, result);
    if (wake) {
      armAutoRetry(before.id, wake.delayMs);
      return;
    }
    const transientTries = transientRetries.get(before.id) || 0;
    const decision = launchRetryDecision({
      before,
      result,
      transientTries,
      maxRetries: sup.MAX_AUTO_RETRIES,
      delayMs: AUTO_RETRY_DELAY_MS,
    });
    if (decision.action === 'terminal') {
      markTerminal(before.id, result.error || 'failed');
      return;
    }
    // A git that did not answer has its own ladder (backoff, no repeat rule).
    if (decision.transient) transientRetries.set(before.id, transientTries + 1);
    else patch(before.id, { autoRetries: (before.autoRetries || 0) + 1 });
    armAutoRetry(before.id, decision.delayMs);
  }

  function armAutoRetry(id, delayMs) {
    const timer = setTimer(() => fireAutoRetry(id), delayMs);
    // A real timer must not keep a test process (or a quitting app) alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
    retryTimers.set(id, timer);
  }

  /** The scheduled relaunch: back to pending, the pump launches it in a free slot. */
  function fireAutoRetry(id) {
    retryTimers.delete(id);
    const pkg = plan ? findPkg(id) : null;
    if (!pkg || plan.killed || pkg.state !== 'failed') return;
    // error/detail stay until the launch result replaces them: the next
    // failure is compared against them.
    patch(id, { state: 'pending' });
    onRunEvent('autoRetry', { id, attempt: pkg.autoRetries });
    commit();
    kick();
  }

  /**
   * Nothing automatic will pick this package up again: flag it and mark
   * every pending dependent blockedBy it, so the board says why they wait.
   */
  function markTerminal(id, reason) {
    patch(id, { terminal: true });
    plan.packages = sup.withBlockedBy(plan.packages);
    onRunEvent('terminal', { id, reason });
    // A known cause whose automatic fix already ran: Mati is asked once.
    recover.onTerminal(findPkg(id), reason);
  }

  /** Ends the run once nothing more can happen on its own, then finalizes it. */
  function checkSettled() {
    if (!plan.started || plan.killed || plan.settled || !sup.isSettled(plan.packages, MAX_PARALLEL)) return;
    // A scheduled automatic relaunch keeps the run open.
    if (retryTimers.size) return;
    plan.settled = true;
    settledFinalize = true;
    const allPushed = plan.packages.every((p) => p.state === 'pushed');
    onRunEvent(allPushed ? 'done' : 'needYou', sup.tally(plan.packages));
    startFinalize();
  }

  function startFinalize() {
    finalizer
      .finalize()
      .catch((err) => onRunEvent('error', { where: 'finalize', message: err instanceof Error ? err.message : String(err) }));
  }

  /**
   * The finalizer went idle. A run that settled on its own ('done' /
   * 'needYou') may now shut the PC down - never a killed one, never with a
   * package, finalize or another God Mode run still going.
   */
  function afterFinalize() {
    // The finalizer's last commit went out while isRunning() was still true;
    // the board and the phone get the settled view (running: false) now.
    if (plan) commit();
    fireRunSettled();
    // A fetch / push the network or auth refused is run again after a backoff.
    const integ = plan && !plan.killed ? plan.integration : null;
    if (integ && integ.state === 'done') recover.onIntegrationOk();
    else if (integ) recover.onIntegration(integ, plan.id);
    if (!settledFinalize || !plan) return;
    settledFinalize = false;
    if (!plan.settled || plan.killed) return;
    // Read again after the flush: a replaced or discarded plan, or another
    // run that started meanwhile, stops the shutdown.
    const settledPlan = plan;
    const busyNow = () =>
      isBusy() ||
      recover.pending('run') ||
      plan !== settledPlan ||
      plan.packages.some(sup.isActive) ||
      !!(deps.otherRunsActive && deps.otherRunsActive());
    background(powerFlow.afterFinalize({ busy: busyNow(), stillBusy: busyNow, planId: plan.id }), 'shutdown');
  }

  /**
   * Luna's Work hook: the plan's onRunSettled, at most once per plan, with
   * the integration (merge / self-check) result. Cleared before the call so
   * a later idle never repeats it; a throw or rejection is only logged.
   */
  function fireRunSettled() {
    const hook = runSettledHook;
    if (!hook || !plan || hook.planId !== plan.id) return;
    runSettledHook = null;
    const result = { planId: plan.id, killed: plan.killed, integration: { ...plan.integration }, plan: view() };
    const failed = (err) => log(`[orchestra] onRunSettled failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      Promise.resolve(hook.fn(result)).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /** Launches whatever is ready, while slots are free. Re-entrancy safe. */
  async function pump() {
    // On battery while the run goes: one warning per battery period.
    if (battery && plan && plan.started && !plan.killed && !plan.settled) battery.onRunStart();
    if (!plan || !plan.started || plan.killed || plan.pausedUntil || plan.hold || pumping || batteryHeld()) return;
    pumping = true;
    try {
      let ready = sup.readyToLaunch(plan.packages, MAX_PARALLEL);
      while (ready.length && !plan.killed && !plan.pausedUntil && !plan.hold && !batteryHeld()) {
        await launchPackages(ready);
        ready = sup.readyToLaunch(plan.packages, MAX_PARALLEL);
      }
      checkSettled();
      commit();
    } finally {
      pumping = false;
    }
  }

  /** pump() from a sync path: never leaves a rejection unhandled. */
  function kick() {
    pump().catch((err) => onRunEvent('error', { where: 'pump', message: err instanceof Error ? err.message : String(err) }));
  }

  /**
   * Approve (ids null) starts the run: every ready package launches and the
   * supervisor launches the rest as dependencies get pushed. Launch with ids
   * starts named pending packages by hand, dependencies or not. Prompt edits
   * from the review overlay apply before launch.
   * @param {unknown} payload {planId, ids?: string[]|null, prompts?: {[id]: string}}
   */
  async function launch(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (plan.errors.length) return { ok: false, error: 'planErrors' };
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan.pausedUntil) return { ok: false, error: 'paused' };
    if (plan.hold) return { ok: false, error: plan.hold.reason };
    // Approve still starts a held run (it launches once plugged in); a
    // launch by hand would start a worker now.
    if (Array.isArray(o.ids) && batteryHeld()) return { ok: false, error: 'batteryLow' };
    const mode = sup.INTEGRATION_MODES.includes(o.integration) ? o.integration : null;
    let startAt = null;
    if (o.schedule != null && !Array.isArray(o.ids) && !plan.started) {
      const when = sup.scheduleTime(o.schedule, now(), deps.usageResetAt ? deps.usageResetAt() : null);
      if (!when.ok) return { ok: false, error: when.error };
      startAt = when.at;
    }

    const edits = o.prompts && typeof o.prompts === 'object' ? o.prompts : {};
    plan.packages = plan.packages.map((p) => {
      const edited = typeof edits[p.id] === 'string' ? edits[p.id].trim().slice(0, MAX_PROMPT_CHARS) : '';
      return p.state === 'pending' && edited ? { ...p, prompt: edited } : p;
    });

    const chosen = Array.isArray(o.ids)
      ? plan.packages.filter((p) => (p.state === 'pending' || p.state === 'failed') && o.ids.includes(p.id))
      : null;
    if (chosen ? !chosen.length : !sup.readyToLaunch(plan.packages, MAX_PARALLEL).length) {
      return { ok: false, error: 'nothingToLaunch' };
    }

    // "Free providers" (orchestraFree.js): chosen at Approve, fixed for the run.
    if (o.free === true && !plan.started && !plan.freeMode) {
      const free = freeRunSettings({ freeProfileId: deps.freeProfileId ? deps.freeProfileId() : null });
      if (!free.ok) return { ok: false, error: free.error };
      plan.freeMode = true;
      plan.profileId = free.profileId;
      plan.integrationMode = free.integrationMode;
    }
    const wanted = integrationFor(plan, mode);
    // "Create a new release after finish": merge runs only, set at Approve
    // (confirmed natively with the merge), stored as options.releaseAfter.
    const release = o.releaseAfter === true && wanted === 'merge' && !plan.started;
    if (wanted === 'merge' && !plan.started && !(await confirmMerge({ release }))) return { ok: false, error: 'mergeDeclined' };
    if (wanted && !plan.started) plan.integrationMode = wanted;
    if (!plan.started) {
      const { releaseAfter: _previous, ...rest } = plan.options || {};
      plan.options = sup.normalizeOptions(release ? { ...rest, releaseAfter: true } : rest);
    }
    if (startAt) {
      freezeSettings();
      plan.scheduledAt = startAt;
      armSchedule(startAt);
      commit();
      return { ok: true, plan: view() };
    }

    busy = true;
    try {
      freezeSettings();
      clearSchedule();
      plan.scheduledAt = null;
      plan.killed = false;
      plan.settled = false;
      plan.started = true;
      if (!plan.runStartedAt) plan.runStartedAt = now();
      if (chosen) {
        // A launch by hand starts the automatic ladder afresh.
        for (const p of chosen) {
          cancelAutoRetry(p.id);
          transientRetries.delete(p.id);
          patch(p.id, { autoRetries: 0, terminal: false });
        }
        plan.packages = sup.withBlockedBy(plan.packages);
        await launchPackages(chosen);
      }
    } finally {
      busy = false;
    }
    await pump();
    return { ok: true, plan: view() };
  }

  /** Idea #2: the held run starts by itself at `at`. */
  function armSchedule(at) {
    clearSchedule();
    scheduleTimer = setTimer(startScheduled, Math.max(0, at - now()));
  }

  function startScheduled() {
    scheduleTimer = null;
    if (!plan || !plan.scheduledAt) return;
    if (plan.started || plan.errors.length) {
      plan.scheduledAt = null;
      commit();
      return;
    }
    if (isBusy()) {
      // Mati is mid-action on the board; try again shortly.
      scheduleTimer = setTimer(startScheduled, NUDGE_DELAY_MS);
      return;
    }
    plan.scheduledAt = null;
    freezeSettings();
    plan.killed = false;
    plan.settled = false;
    plan.started = true;
    if (!plan.runStartedAt) plan.runStartedAt = now();
    onRunEvent('scheduledStart');
    commit();
    kick();
  }

  /** Cancels a scheduled start; the plan stays as it was. */
  function unschedule(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    clearSchedule();
    plan.scheduledAt = null;
    commit();
    return { ok: true, plan: view() };
  }

  function stall(id, reason, detail = null) {
    cancelNudge(id);
    const before = findPkg(id);
    forgetSession(before.sessionId);
    const stalls = (before.stalls || 0) + 1;
    // Each stall is kept (time, reason, short detail), not only the last error.
    const stallHistory = sup.withHistoryEntry(before.stallHistory, { at: now(), kind: 'stall', reason, detail });
    patch(id, { state: 'stalled', error: reason, detail, stalls, stallHistory, stalledAt: now() });
    const pkg = findPkg(id);
    const live = !plan.killed && !plan.pausedUntil;
    const wantsEscalate = live && sup.shouldEscalate(pkg, modelFor(pkg), reason);
    const wantsResume = live && sup.shouldAutoResume(pkg, reason);
    if (wantsEscalate && escalate(pkg, reason, detail)) {
      commit();
      return;
    }
    if (wantsResume && autoResume(pkg, reason, detail)) {
      commit();
      return;
    }
    if ((wantsEscalate || wantsResume) && plan.hold) {
      // The restart waits for Resume instead of being spent on a broken node_modules.
      patch(id, { heldResume: { reason, detail } });
      commit();
      return;
    }
    // A permission prompt still waits for Mati (or the unattended timeout);
    // any other stall here has used up its automatic chances.
    if (live && reason !== 'needsApproval') markTerminal(id, reason);
    onRunEvent('stalled', { id, reason });
    commit();
    kick();
  }

  /**
   * Reopens a package in its own worktree with a fresh brief, like Retry
   * does for a closed tab. The new tab opens first; a still-open old tab is
   * closed after the package points at the new one.
   * @returns {{ok:true} | {ok:false, error:'briefFailed'|'noTab'}}
   */
  function reopenInWorktree(pkg, text) {
    if (!depsReady(pkg)) return { ok: false, error: 'noNodeModules' };
    // Recomputed, never taken from the saved run: only LunaCore's own
    // brief folder is ever written to.
    const briefPath = path.join(deps.briefDir(), `${path.basename(pkg.root)}.md`);
    if (!deps.writeBrief(briefPath, text)) return { ok: false, error: 'briefFailed' };
    const session = safeOpenTab(pkg, pkg.cwd || pkg.root, pkg.branch, briefPath);
    if (!session) return { ok: false, error: 'noTab' };
    const old = pkg.sessionId;
    patch(pkg.id, { ...freshRun(), state: 'launched', sessionId: session.id, briefPath });
    if (old && old !== session.id && sessionAlive(old)) closeSession(old);
    return { ok: true };
  }

  /**
   * One automatic resume of a stalled worker, told why it stalled.
   * @returns {boolean} false when the tab could not be reopened (stays stalled)
   */
  function autoResume(pkg, reason, detail) {
    const text = withStallNote(briefText(pkg, pkg.branch, { resume: true }), reason, detail);
    if (!reopenInWorktree(pkg, text).ok) return false;
    patch(pkg.id, { autoResumed: true });
    onRunEvent('autoResumed', { id: pkg.id, reason });
    return true;
  }

  /**
   * Idea #6: the stalled Sonnet worker's tab is closed and the package
   * restarts once on Opus in the same worktree, told why.
   * @returns {boolean} false when the new tab could not be opened (stays stalled)
   */
  function escalate(pkg, reason, detail) {
    if (!depsReady(pkg)) return false;
    const briefPath = path.join(deps.briefDir(), `${path.basename(pkg.root)}.md`);
    const text = briefText(pkg, pkg.branch, { resume: true, escalation: { reason, detail } });
    if (!deps.writeBrief(briefPath, text)) return false;
    const old = pkg.sessionId;
    // New tab first: closing the old one first could leave main opening an
    // empty replacement tab when it was the last one.
    // One effort step up as well, capped at max.
    const effortOverride = nextEffort(effortFor(pkg));
    const session = safeOpenTab({ ...pkg, modelOverride: 'opus', effortOverride }, pkg.cwd || pkg.root, pkg.branch, briefPath);
    if (!session) return false;
    // Re-pointed before the close, so the old tab's close is not read as this package's.
    patch(pkg.id, { ...freshRun(), state: 'launched', sessionId: session.id, briefPath, modelOverride: 'opus', effortOverride, escalated: true });
    if (old && sessionAlive(old)) closeSession(old);
    onRunEvent('escalated', { id: pkg.id, reason });
    return true;
  }

  /**
   * Turn ended without a marker. Decided after NUDGE_DELAY_MS, not at once:
   * the usage-limit error that ended the turn arrives right after it, and the
   * pause it starts must win over both a nudge and a noMarker stall.
   */
  function sendNudge(id) {
    nudgeTimers.delete(id);
    const pkg = plan ? findPkg(id) : null;
    if (!pkg || pkg.state !== 'launched' || pkg.awaitingDeps || plan.pausedUntil || plan.killed) return;
    const action = sup.turnEndAction(pkg, null);
    if (action.type === 'stall') {
      stall(id, action.reason);
      return;
    }
    if (!writePty(pkg.sessionId, sup.nudgeText(pkg.id), { paste: true })) {
      stall(id, 'noTab');
      return;
    }
    patch(id, { nudges: pkg.nudges + 1 });
    commit();
  }

  /**
   * The verify queue's hooks (verifyQueue.js) for the board: 'queued' reads
   * "waiting to verify", 'running' the usual verifying. Ignored once the run
   * or the package moved on.
   */
  function verifyHooks(planId, id) {
    const set = (phase) => {
      const p = plan && plan.id === planId ? findPkg(id) : null;
      if (!p || p.state !== 'finishing' || p.verifyPhase === phase) return;
      patch(id, { verifyPhase: phase });
      commit();
    };
    return {
      // Only when something is ahead: an empty queue starts at once.
      onQueued: (info) => {
        recover.stepWaiting(id);
        if ((info && info.ahead > 0) || batteryHeld()) set('queued');
      },
      // Low on battery a new verify waits for the charger (verifyQueue.js).
      whenAllowed: () => {
        recover.stepWaiting(id);
        return battery ? battery.whenAllowed() : Promise.resolve();
      },
      onStart: () => {
        recover.stepProgress(id);
        set('running');
      },
      onRerun: () => recover.stepProgress(id),
      // The playbook's longer re-run of a timed-out verify (orchestraRecover.js).
      limitMs: (findPkg(id) || {}).verifyLimitMs || undefined,
      timeoutReruns: (findPkg(id) || {}).verifyReruns,
      // A killed or discarded run's verify is skipped once its turn comes.
      isCancelled: () => !plan || plan.id !== planId || plan.killed === true,
    };
  }

  /**
   * One push-protection fix-up round: `text` goes to the worker's open tab,
   * or into a fresh brief in a reopened tab in its worktree.
   * @returns {boolean} false when neither worked
   */
  function sendFixup(pkg, text, fields) {
    if (plan.killed) return false;
    if (sessionAlive(pkg.sessionId) && writePty(pkg.sessionId, text, { paste: true })) {
      patch(pkg.id, { ...fields, state: 'launched', nudges: 0 });
      return true;
    }
    if (!pkg.root || !pkg.branch) return false;
    const brief = `${briefText(pkg, pkg.branch, { resume: true })}\n## LunaCore fix-up round\n\n${text}\n`;
    if (!reopenInWorktree(pkg, brief).ok) return false;
    patch(pkg.id, fields);
    return true;
  }

  /** The pre-push scan found secret shapes: one fix-up round (file:line, never the value). */
  function onSecretsFound(id, res) {
    const pkg = findPkg(id);
    const detail = pushSecrets.hitsSummary(res.hits);
    const stallHistory = sup.withHistoryEntry(pkg.stallHistory, { at: now(), kind: 'fixup', reason: 'secretFound', detail });
    if (!sendFixup(pkg, pushSecrets.secretScanText(pkg.id, res.hits, res.range), { scanFixup: true, stallHistory })) {
      stall(id, 'secretFound', detail);
      return;
    }
    onRunEvent('secretFixup', { id });
    commit();
  }

  /**
   * GitHub rejected the push with GH013. Never pushed again unchanged: one
   * fix-up round (rewrite only the unpushed commits), then one more push; a
   * second rejection - or a HEAD the worker did not change - stops the package.
   */
  function onPushBlocked(id, res) {
    const pkg = findPkg(id);
    const detail = res.blocked === 'unchanged' && pkg.pushBlockDetail ? `${res.detail}\n${pkg.pushBlockDetail}` : res.detail;
    const capped = String(detail || '').slice(0, pushSecrets.MAX_DETAIL_CHARS) || null;
    if (res.blocked === 'unchanged' || pkg.pushFixup) {
      stall(id, 'pushBlocked', capped);
      return;
    }
    const firstRule = String(res.detail || '').split('\n').find((l) => /GH013|secret|rule/i.test(l)) || res.detail;
    const stallHistory = sup.withHistoryEntry(pkg.stallHistory, { at: now(), kind: 'fixup', reason: 'pushBlocked', detail: firstRule });
    const fields = { pushFixup: true, pushBlockedSha: res.headSha || null, pushBlockDetail: capped, stallHistory };
    if (!sendFixup(pkg, pushSecrets.pushBlockText(pkg.id, res.detail, res.range, res.blocked), fields)) {
      stall(id, 'pushBlocked', capped);
      return;
    }
    onRunEvent('pushFixup', { id });
    commit();
  }

  async function finish(id) {
    cancelNudge(id);
    // The post-DONE verify runs a plain `npm test` in the worktree: not
    // without its dependencies. The package waits for Resume, unstalled.
    if (!depsReady(findPkg(id))) {
      patch(id, { awaitingDeps: true });
      commit();
      return;
    }
    if (findPkg(id).awaitingDeps) patch(id, { awaitingDeps: false });
    // A package finishing after the run settled (Mati unblocked it by hand)
    // reopens the run, so its end gets its own cue.
    plan.settled = false;
    patch(id, { state: 'finishing', error: null, detail: null, verifyPhase: null });
    commit();
    let res;
    try {
      const before = findPkg(id);
      // Under the wake watchdog: a step that never settles is aborted (stepHung).
      res = await recover.guardStep(id, (step) => {
        const hooks = verifyHooks(plan.id, id);
        return finishPackage(
          {
            ...before,
            pushOnVerifyFail: plan.freeMode === true,
            // Once per package: after its fix-up round, GitHub's own check decides.
            scanSecrets: !before.scanFixup && !before.pushFixup,
          },
          { ...hooks, isCancelled: () => step.isAborted() || hooks.isCancelled() },
        );
      });
    } catch (err) {
      res = { ok: false, stage: 'push', detail: err instanceof Error ? err.message : 'finish failed' };
    }
    const pkg = findPkg(id);
    if (!plan || !pkg) return;
    // The playbook's verify overrides are spent by this run.
    patch(id, { verifyPhase: null, verifyLimitMs: null, verifyReruns: undefined, verifiedSha: null });
    // A known environment cause gets its automatic fix (orchestraRecover.js).
    if (!plan.killed && recover.onFinish(findPkg(id), res)) {
      commit();
      return;
    }

    if (res.stage === 'secrets') {
      onSecretsFound(id, res);
      return;
    }
    if (res.stage === 'push' && res.blocked) {
      onPushBlocked(id, res);
      return;
    }
    // A verify that ran past its limit twice is no test failure: it is never
    // pasted to the worker as one.
    if (res.stage === 'verifyTimeout') {
      stall(id, 'verifyTimeout', res.detail || null);
      return;
    }
    // Killed while waiting for its verify: stopped like a running worker is.
    if (res.stage === 'verifyCancelled') {
      patch(id, { state: 'killed' });
      commit();
      return;
    }
    if (res.ok) {
      const touched = sup.mergeTouched(pkg.touched, sup.relTouched(pkg.root, res.files || []));
      patch(id, { state: 'pushed', headSha: res.headSha || null, error: null, detail: null, touched, terminal: false });
      tickTodos(plan.projectId, pkg.todoAts);
      commit();
      kick();
      return;
    }
    if (res.stage !== 'verify') {
      stall(id, `${res.stage}Failed`, res.detail || null);
      return;
    }
    const lastLine = String(res.output || '').trim().split(/\r?\n/).pop() || '';
    if (plan.killed || sup.verifyFailAction(pkg) === 'stall' || !sessionAlive(pkg.sessionId)) {
      patch(id, { verifyTail: outputTail(res.output) });
      stall(id, 'verifyFailed', lastLine.slice(0, 300));
      return;
    }
    patch(id, { state: 'launched', verifyRounds: pkg.verifyRounds + 1, nudges: 0 });
    writePty(pkg.sessionId, sup.verifyFailText(pkg.id, pkg.verify, res.output), { paste: true });
    commit();
  }

  /** The playbook runs a package's finish again (verify / push), with its overrides. */
  function refinish(id, extra = {}) {
    if (!plan || !findPkg(id)) return;
    if (plan.killed) {
      patch(id, { state: 'killed' });
      commit();
      return;
    }
    patch(id, { verifiedSha: null, verifyLimitMs: null, verifyReruns: undefined, ...extra });
    background(finish(id), 'finish');
  }

  /** The playbook's install fixed the held node_modules: Resume on its own. */
  function resumeHeldRun(tries = 0) {
    if (!plan || !plan.hold) return;
    resumeRun({ planId: plan.id }).then((r) => {
      if (r.ok) return;
      if (r.error === 'busy' && tries < 3) setTimer(() => resumeHeldRun(tries + 1), NUDGE_DELAY_MS);
      else log(`[recover] automatic resume refused: ${r.error}`);
    }, noop);
  }

  /**
   * A worker tab finished a turn. Running -> act on the marker. A stalled
   * package whose tab is still open finishes too if it now says LUNA_DONE:
   * Mati answered its prompt by hand and it carried on.
   * @param {string} sessionId
   * @param {string} fragment transcript text of the turn
   */
  function onTurnEnd(sessionId, fragment) {
    if (fixup.onTurnEnd(sessionId, fragment)) return;
    const pkg = bySession(sessionId);
    if (!pkg || plan.killed) return;
    // Evidence for the report's "What went wrong": what the worker said last.
    const lastWords = lastWordsFrom(fragment);
    if (lastWords) patch(pkg.id, { lastWords });
    // LUNA_DONE already came; the verify waits for Resume.
    if (pkg.awaitingDeps) {
      commit();
      return;
    }
    const marker = sup.markerFrom(fragment, pkg.id);
    const background = trackBackground(sessionId, fragment);
    if (pkg.state === 'stalled') {
      if (marker && marker.kind === 'done') finish(pkg.id);
      return;
    }
    if (pkg.state !== 'launched') return;
    const action = sup.turnEndAction(pkg, marker);
    if (action.type === 'finish') finish(pkg.id);
    else if (action.type === 'stall' && action.reason === 'blocked') stall(pkg.id, action.reason, action.detail || null);
    else if (!plan.pausedUntil) {
      cancelNudge(pkg.id);
      if (background.length) {
        // The turn ended on a background process of the worker's own (a test
        // run): its report back starts the next turn. No nudge is spent;
        // after BACKGROUND_WAIT_MS the process is given up on and the usual
        // nudge follows.
        onRunEvent('waitingOnBackground', { id: pkg.id, tasks: background.length });
        const armedAt = now();
        nudgeTimers.set(pkg.id, setTimer(() => giveUpOnBackground(pkg.id, sessionId, armedAt), BACKGROUND_WAIT_MS));
        return;
      }
      // No marker: nudge or noMarker stall, decided after the delay.
      nudgeTimers.set(pkg.id, setTimer(() => sendNudge(pkg.id), NUDGE_DELAY_MS));
    }
  }

  /**
   * The PC slept (orchestraSleep.js): the active packages get the slept
   * time back on pausedMs, the run logs it. Never credits the part an open
   * usage-limit pause covers - resume() credits that pause whole.
   * @param {null|{start:number, durationMs:number, source:string}} sleep
   */
  function applySleep(sleep) {
    if (!sleep || !plan) return false;
    recover.onWake();
    const t = now();
    const pauseStartedAt = plan.pausedUntil ? plan.pauseStartedAt : null;
    for (const p of plan.packages.filter(sup.isActive)) {
      const credit = sleepCredit(sleep, p, { now: t, pauseStartedAt });
      if (credit > 0) patch(p.id, { pausedMs: (p.pausedMs || 0) + credit });
    }
    // Only a sleep during the run is the run's (a later report counts them).
    if (plan.runStartedAt && (plan.packages.some(sup.isActive) || finalizer.isRunning())) {
      plan.sleeps = recordSleep(plan.sleeps, sleep);
    }
    onRunEvent('slept', { start: sleep.start, durationMs: sleep.durationMs, source: sleep.source });
    commit();
    return true;
  }

  /** A sleep the watchdog gap reveals, credited before anything reads the clock. */
  const catchUpSleep = () => applySleep(sleepWatch.onTick());

  /** electron powerMonitor 'suspend'. */
  function onSystemSuspend() {
    sleepWatch.onSuspend();
  }

  /** The session's still-running background processes after this fragment. */
  function trackBackground(sessionId, fragment) {
    const open = sup.openBackgroundTasks(fragment, backgroundOpen.get(sessionId) || []);
    if (open.length) backgroundOpen.set(sessionId, open);
    else backgroundOpen.delete(sessionId);
    return open;
  }

  /**
   * The bounded wait ran out: forget the process (it never reported) and
   * nudge - unless the worker got busy again meanwhile (its git status
   * changed): then a new turn is under way and its end decides.
   */
  function giveUpOnBackground(id, sessionId, armedAt) {
    nudgeTimers.delete(id);
    backgroundOpen.delete(sessionId);
    if ((lastActivity.get(sessionId) || 0) > armedAt) return;
    sendNudge(id);
  }

  /** Drops what LunaCore tracked about one worker tab's turns. */
  function forgetSession(sessionId) {
    if (!sessionId) return;
    backgroundOpen.delete(sessionId);
    lastActivity.delete(sessionId);
  }

  function resume() {
    resumeTimer = null;
    if (!plan || !plan.pausedUntil) return;
    // A resume timer that fired on the wake, before 'resume' / the tick: the
    // sleep is credited first, while the pause is still open.
    catchUpSleep();
    const pausedFor = now() - (plan.pauseStartedAt || now());
    plan.pausedTotalMs = (plan.pausedTotalMs || 0) + Math.max(0, pausedFor);
    plan.pausedUntil = null;
    plan.pauseStartedAt = null;
    for (const p of plan.packages.filter(sup.isActive)) {
      // Never credit more pause than the package has been running.
      const credit = Math.max(0, Math.min(pausedFor, now() - (p.startedAt || now())));
      patch(p.id, { pausedMs: p.pausedMs + credit });
      if (p.state === 'launched') writePty(p.sessionId, sup.RESUME_TEXT, { paste: true });
    }
    onRunEvent('resumed');
    commit();
    kick();
    background(powerFlow.refresh(), 'sleep');
  }

  /**
   * electron powerMonitor 'resume': timers may not have counted the sleep.
   * The slept time is credited to the workers first. An integrate step in
   * flight is treated as interrupted (its children may be gone, its promise
   * may never settle): aborted, and finalize runs once more.
   * Past the reset -> resume now; before it -> re-arm the resume timer.
   */
  function onSystemResume() {
    applySleep(sleepWatch.onResume());
    recover.onWake();
    interruptFinalize();
    resumeGate.onResume();
    background(powerFlow.onSystemResume(), 'sleep');
    if (!plan || !plan.pausedUntil) return;
    if (resumeTimer) clearTimer(resumeTimer);
    resumeTimer = null;
    if (now() >= plan.pausedUntil) resume();
    else resumeTimer = setTimer(resume, plan.pausedUntil - now() + RESUME_GRACE_MS);
  }

  /** After a wake an integrate step in flight is aborted and run again (logged as a fix). */
  function interruptFinalize() {
    if (!finalizer.interrupt()) return;
    onRunEvent('finalizeInterrupted');
    if (plan) {
      const detail = 'finalize step in flight at a wake: aborted and run again';
      plan.recoveries = sup.withHistoryEntry(plan.recoveries, { at: now(), kind: 'recover', reason: 'stepHung', detail });
    }
  }

  /**
   * The usage limit hit a worker and its tab could not move to another
   * account: the whole run waits.
   * @param {string} sessionId
   * @param {number|null} resetsAt epoch ms, when the CLI said
   */
  function onUsageLimit(sessionId, resetsAt) {
    const pkg = bySession(sessionId);
    if (!pkg || !sup.isActive(pkg) || plan.killed) return;
    const until = Number.isFinite(resetsAt) && resetsAt > now() ? resetsAt : now() + DEFAULT_PAUSE_MS;
    if (plan.pausedUntil && plan.pausedUntil >= until) return;
    // Another stored account first; none -> pause until the reset, resume on its own.
    if (recover.onUsageLimit(pkg, until) === 'failover') return;
    pauseUntil(until);
  }

  /**
   * Multi God Mode A3: every Claude account is out, so the registry pauses
   * every run with live workers until the earliest reset - this run too,
   * whichever worker hit the wall.
   * @param {number|null} resetsAt epoch ms
   * @returns {boolean} the run is paused now
   */
  function pauseExternal(resetsAt) {
    if (!plan || !plan.started || plan.killed || !plan.packages.some(sup.isActive)) return false;
    pauseUntil(resetsAt);
    return true;
  }

  /** Pauses the run until `resetsAt` (+ grace); a longer pause already set wins. */
  function pauseUntil(resetsAt) {
    const until = Number.isFinite(resetsAt) && resetsAt > now() ? resetsAt : now() + DEFAULT_PAUSE_MS;
    if (plan.pausedUntil && plan.pausedUntil >= until) return;
    for (const id of [...nudgeTimers.keys()]) cancelNudge(id);
    if (!plan.pausedUntil) plan.pauseStartedAt = now();
    plan.pausedUntil = until;
    if (resumeTimer) clearTimer(resumeTimer);
    resumeTimer = setTimer(resume, until - now() + RESUME_GRACE_MS);
    onRunEvent('paused', { until });
    commit();
    background(powerFlow.onPaused(), 'sleep');
  }

  /**
   * A worker sits on a permission prompt - it needs Mati, the rest go on.
   * The tool it asked about is logged (idea #5) as an allow-rule suggestion.
   * @param {string} sessionId
   * @param {string|null} [rule] e.g. `Bash(npx tsc:*)`, from the transcript
   */
  function onApproval(sessionId, rule = null, example = null) {
    const pkg = bySession(sessionId);
    if (!pkg || pkg.state !== 'launched' || plan.killed) return;
    const entry = { pkgId: pkg.id, rule: sup.isAllowRule(rule) ? rule : null, example: sup.cleanExample(example) };
    plan.approvalLog = [...(plan.approvalLog || []), entry].slice(-sup.MAX_APPROVAL_LOG);
    stall(pkg.id, 'needsApproval', entry.rule);
  }

  /** True when the tab is one of this run's workers (cheap pre-check for main). */
  function ownsSession(sessionId) {
    return !!bySession(sessionId);
  }

  /**
   * Idea #7: a worker's git status changed. Its files are kept relative to
   * its worktree; a NEW pair of workers sharing a file is announced once.
   * @param {string} sessionId
   * @param {string[]} absFiles
   */
  function onFiles(sessionId, absFiles) {
    const pkg = bySession(sessionId);
    if (!pkg || !pkg.root || !sup.isActive(pkg)) return;
    // Activity: a background wait that runs out does not nudge a busy worker.
    lastActivity.set(sessionId, now());
    const touched = sup.mergeTouched(pkg.touched, sup.relTouched(pkg.root, absFiles));
    if (touched === pkg.touched) return;
    const key = (o) => `${o.a}|${o.b}`;
    const before = new Set(sup.liveOverlaps(plan.packages).map(key));
    patch(pkg.id, { touched });
    for (const o of sup.liveOverlaps(plan.packages)) {
      if (!before.has(key(o))) onRunEvent('overlap', o);
    }
    if (plan.ownership) guardOwnership(findPkg(pkg.id));
    commit();
  }

  /**
   * LW 2.12: a worker that changed a file another package owns is told to
   * revert it at once - before the owner's worker touches the same file -
   * and the board gets an 'ownership' event. Only with a plan.ownership map.
   */
  function guardOwnership(pkg) {
    const fresh = sup
      .ownershipViolations(pkg, pkg.touched, plan.ownership, plan.packages)
      .filter((v) => !ownershipNudged.has(`${pkg.id}|${v.file}`));
    if (!fresh.length || pkg.state !== 'launched' || plan.pausedUntil || plan.killed) return;
    for (const v of fresh) ownershipNudged.add(`${pkg.id}|${v.file}`);
    const sent = writePty(pkg.sessionId, sup.ownershipText(pkg.id, fresh), { paste: true });
    onRunEvent('ownership', { id: pkg.id, files: fresh, nudged: sent === true });
  }

  /**
   * "Finish run" by hand (a killed run, or one Mati wants to wrap up with a
   * stalled package left): integrate, clean up, report. Optional mode
   * override from the board's selector.
   * @param {unknown} payload {planId, integration?}
   */
  async function finishRun(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    if (!plan.packages.some((p) => p.state !== 'pending')) return { ok: false, error: 'nothingToLaunch' };
    if (sup.INTEGRATION_MODES.includes(o.integration) && integrationFor(plan, o.integration) !== plan.integrationMode) {
      if (o.integration === 'merge' && !(await confirmMerge())) return { ok: false, error: 'mergeDeclined' };
      plan.integrationMode = o.integration;
    }
    freezeSettings();
    clearSchedule();
    plan.scheduledAt = null;
    await finalizer.finalize();
    return { ok: true, plan: view() };
  }

  /**
   * "Abort finish": ends this run's integrate step when it has run past
   * ABORT_FINISH_AFTER_MS. Its process tree is killed, the pass settles as
   * failed ('abortedByUser') and reports; then the board is free and Retry
   * works again. Never trusts the payload beyond the plan id.
   * @param {unknown} payload {planId}
   */
  function abortFinalize(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (!finalizer.isRunning()) return { ok: false, error: 'notFinishing' };
    const startedAt = plan.integration && plan.integration.startedAt;
    if (!Number.isFinite(startedAt) || now() - startedAt < ABORT_FINISH_AFTER_MS) return { ok: false, error: 'tooEarly' };
    if (!finalizer.abort('abortedByUser')) return { ok: false, error: 'notAbortable' };
    onRunEvent('finalizeAborted');
    return { ok: true };
  }

  /**
   * Called every minute or so: workers over their working time stall. A
   * sleep the tick gap reveals is credited first, so a wake never reads as
   * hours of work.
   */
  function tick() {
    // A sleep only the tick gap revealed ('resume' never came): same as a resume.
    if (catchUpSleep()) interruptFinalize();
    recover.tick();
    if (!plan || plan.pausedUntil || plan.killed) return;
    for (const p of plan.packages) {
      if (p.state === 'launched' && !p.awaitingDeps && sup.timedOut(p, now())) stall(p.id, 'timeout');
    }
    expireApprovals();
  }

  /**
   * Unattended approvals: a worker that has sat on a permission prompt
   * longer than plan.options.unattendedApprovalMin loses its tab. Nothing is
   * ever approved or typed into the prompt; the rule it asked about stays in
   * approvalLog as an allow-rule suggestion for the morning.
   */
  function expireApprovals() {
    const limit = sup.normalizeOptions(plan.options).unattendedApprovalMin;
    if (!limit) return;
    let changed = false;
    for (const p of plan.packages) {
      if (!sup.approvalExpired(p, now(), limit) || !p.sessionId || !sessionAlive(p.sessionId)) continue;
      const sid = p.sessionId;
      // detail keeps the logged rule (onApproval put it there).
      patch(p.id, { error: 'approvalTimeout' });
      markTerminal(p.id, 'approvalTimeout');
      closeSession(sid);
      changed = true;
    }
    if (!changed) return;
    commit();
    kick();
  }

  /**
   * Kill switch: no new workers, Esc to every running one, worktrees kept.
   * @returns {boolean} false when there was no run to stop
   */
  function kill() {
    if (!plan || !plan.started) return false;
    clearAllTimers();
    plan.scheduledAt = null;
    plan.killed = true;
    // A kill during a usage-limit pause still counts the pause so far.
    if (plan.pausedUntil && plan.pauseStartedAt) plan.pausedTotalMs = (plan.pausedTotalMs || 0) + Math.max(0, now() - plan.pauseStartedAt);
    // A running fix-up worker stops with the run: its tab closes, the base stays unpushed.
    fixup.abort();
    plan.pausedUntil = null;
    plan.pauseStartedAt = null;
    for (const p of plan.packages.filter((x) => x.state === 'launched')) {
      writePty(p.sessionId, ESC);
      patch(p.id, { state: 'killed' });
    }
    // Waiting on a playbook backoff: stopped too, its timer dropped.
    for (const p of plan.packages.filter((x) => recover.pending(x.id))) {
      recover.cancel(p.id);
      patch(p.id, { state: 'killed' });
    }
    settledFinalize = false;
    // A kill ends the hold too: Retry checks node_modules again.
    releaseHold();
    // Shared flow: another run may still be paused and allow the sleep, or
    // have settled and asked for the shutdown already counting down.
    background(powerFlow.refresh(), 'sleep');
    background(powerFlow.refreshShutdown(), 'shutdown');
    onRunEvent('killed');
    commit();
    return true;
  }

  /**
   * Picks a stalled / closed / killed / failed package back up: nudges its
   * open tab, or opens a new tab in its existing worktree, or (never got a
   * worktree) queues it for a fresh launch.
   * @param {unknown} payload {planId, id}
   */
  async function retry(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    const pkg = typeof o.id === 'string' ? findPkg(o.id) : null;
    if (!pkg || !(sup.RETRYABLE_STATES.has(pkg.state) || pkg.state === 'failed')) return { ok: false, error: 'notRetryable' };
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan.pausedUntil) return { ok: false, error: 'paused' };
    if (plan.hold) return { ok: false, error: plan.hold.reason };
    // Nudging a live tab is no new worker; anything else would launch one.
    const liveTab = !!(pkg.sessionId && sessionAlive(pkg.sessionId));
    if (!liveTab && batteryHeld()) return { ok: false, error: 'batteryLow' };

    freezeSettings();
    if (liveTab) {
      patch(pkg.id, { ...freshRun(), state: 'launched' });
      // A tab stalled on a permission prompt: Mati answers it there. Pasting
      // a nudge + Enter now would land IN the prompt and answer it blindly.
      if (pkg.error !== 'needsApproval') writePty(pkg.sessionId, sup.nudgeText(pkg.id), { paste: true });
    } else if (pkg.root && pkg.branch) {
      // A new worker in the old worktree: install what is missing first
      // (an earlier install failed, or an older build never installed).
      const killedBefore = plan.killed;
      const installed = await installForRetry(pkg);
      if (!installed.ok) return installed;
      // The install can take minutes: a kill, pause or hold that landed meanwhile wins.
      if ((plan.killed && !killedBefore) || plan.pausedUntil || plan.hold) {
        commit();
        return { ok: false, error: plan.killed ? 'notRetryable' : plan.pausedUntil ? 'paused' : plan.hold.reason };
      }
      const reopened = reopenInWorktree(findPkg(pkg.id), briefText(pkg, pkg.branch, { resume: true }));
      if (!reopened.ok) {
        // Held for node_modules: Resume reopens it, no second Retry needed.
        if (reopened.error === 'noNodeModules') patch(pkg.id, { heldRetry: true });
        commit();
        return { ok: false, error: reopened.error };
      }
    } else {
      patch(pkg.id, { state: 'pending', error: null, detail: null });
    }
    // A Retry by hand: the package is back in play, its dependents unblocked.
    cancelAutoRetry(pkg.id);
    transientRetries.delete(pkg.id);
    // Fresh playbook attempts for every cause.
    recover.onManualRetry(pkg.id);
    // Mati may have fixed (or allowed) a GH013 by hand: the push gets a fresh
    // fix-up round and the rejected HEAD may be pushed again.
    patch(pkg.id, { terminal: false, autoRetries: 0, pushFixup: false, pushBlockedSha: null, pushBlockDetail: null });
    plan.packages = sup.withBlockedBy(plan.packages);
    // Only once the package is back in play does the run resume.
    plan.started = true;
    if (!plan.runStartedAt) plan.runStartedAt = now();
    plan.killed = false;
    plan.settled = false;
    settledFinalize = false;
    commit();
    await pump();
    return { ok: true, plan: view() };
  }

  /**
   * Retry's install in an existing worktree, holding `busy` so nothing else
   * acts on the run meanwhile. A failure stalls the package with the output.
   * @returns {Promise<{ok:true} | {ok:false, error:'installFailed'}>}
   */
  async function installForRetry(pkg) {
    busy = true;
    let installed;
    try {
      // After a failed install a partial node_modules would make the
      // install a no-op: start from scratch.
      installed = await installDeps(pkg.root, { fresh: pkg.error === 'installFailed' });
    } finally {
      busy = false;
    }
    if (installed.ok) return { ok: true };
    patch(pkg.id, { ...installFailedFields(installed.output), terminal: true });
    plan.packages = sup.withBlockedBy(plan.packages);
    onRunEvent('stalled', { id: pkg.id, reason: 'installFailed' });
    commit();
    return { ok: false, error: 'installFailed' };
  }

  /**
   * Resume after a 'noNodeModules' hold: every folder the hold is about is
   * checked again; still broken -> stays held. Then the held work goes on:
   * held launches start their worker, deferred verifies run, held automatic
   * restarts happen, and the pump launches the rest.
   * @param {unknown} payload {planId}
   */
  async function resumeRun(payload) {
    const o = payload && typeof payload === 'object' ? payload : {};
    if (!plan || o.planId !== plan.id) return { ok: false, error: 'noPlan' };
    if (!plan.hold || plan.killed) return { ok: false, error: 'notHeld' };
    if (plan.pausedUntil) return { ok: false, error: 'paused' };
    if (isBusy()) return { ok: false, error: 'busy' };
    const waiting = plan.packages.filter(isHeld);
    const dirs = [...new Set([plan.hold.dir, ...waiting.map((p) => p.root)].filter(Boolean))];
    for (const dir of dirs) {
      const res = checkDeps(dir);
      if (!res.ok) {
        plan.hold = { ...plan.hold, dir: res.dir, detail: res.detail || null };
        commit();
        return { ok: false, error: 'noNodeModules', plan: view() };
      }
    }
    plan.hold = null;
    onRunEvent('resumed', { reason: 'noNodeModules' });
    for (const p of waiting) resumeHeld(p.id);
    commit();
    for (const p of waiting) {
      const current = findPkg(p.id);
      if (current && current.awaitingDeps) background(finish(p.id), 'finish');
    }
    await pump();
    return { ok: true, plan: view() };
  }

  /** One package the hold kept waiting: a held launch or restart goes on now. */
  function resumeHeld(id) {
    const p = findPkg(id);
    if (p.heldLaunch) {
      const before = p;
      const result = startWorker(p, { branch: p.branch, root: p.root, cwd: p.cwd, briefPath: p.briefPath, baseSha: p.baseSha, depMerge: p.depMerge || null });
      if (result.state === 'failed') {
        // The worktree stays recorded: the automatic relaunch clears it first.
        patch(id, { ...result, heldLaunch: false, failure: failureOf(result, null, now()) });
        onLaunchFailed(before, result);
      } else {
        patch(id, result);
      }
      return;
    }
    if (p.heldRetry) {
      patch(id, { heldRetry: false });
      const reopened = reopenInWorktree(findPkg(id), briefText(p, p.branch, { resume: true }));
      if (reopened.ok) {
        patch(id, { terminal: false, autoRetries: 0 });
        plan.packages = sup.withBlockedBy(plan.packages);
      } else if (reopened.error === 'noNodeModules') {
        // Held again: the next Resume reopens it.
        patch(id, { heldRetry: true });
      } else {
        patch(id, { error: reopened.error, detail: null });
      }
      return;
    }
    if (p.heldResume) {
      const { reason, detail } = p.heldResume;
      patch(id, { heldResume: null });
      const pkg = findPkg(id);
      const restarted =
        (sup.shouldEscalate(pkg, modelFor(pkg), reason) && escalate(pkg, reason, detail)) ||
        (sup.shouldAutoResume(pkg, reason) && autoResume(pkg, reason, detail));
      // Held again: the next Resume restarts it; otherwise it has had its chance.
      if (!restarted && plan.hold) patch(id, { heldResume: { reason, detail } });
      else if (!restarted) markTerminal(id, reason);
    }
  }

  /** A closed tab leaves its worktree; the board says so and the slot frees. */
  function onSessionClosed(sessionId) {
    if (fixup.onSessionClosed(sessionId)) return true;
    const pkg = bySession(sessionId);
    if (!pkg) return false;
    cancelNudge(pkg.id);
    // A FINISHING package keeps finishing - verify and push need no tab, and
    // marking it closed would let Retry open a second writer in its worktree.
    patch(pkg.id, { sessionId: null, ...(pkg.state === 'launched' ? { state: 'closed' } : {}) });
    commit();
    kick();
    return true;
  }

  /**
   * Live run options (sleepOnLimit, shutdownWhenDone): only known boolean
   * keys are applied, anything else is dropped. Allowed before, during and
   * while paused.
   * @param {unknown} patchRaw
   */
  function setOptions(patchRaw) {
    if (!plan) return { ok: false, error: 'noPlan' };
    const changes = sup.optionsPatch(patchRaw);
    if (!Object.keys(changes).length) return { ok: false, error: 'badOptions' };
    plan.options = sup.normalizeOptions({ ...plan.options, ...changes });
    onRunEvent('options', { ...plan.options });
    commit();
    background(powerFlow.onOptions(plan.options), 'options');
    return { ok: true, options: { ...plan.options } };
  }

  /**
   * The current run as a settled-run ledger entry when its merge landed
   * (orchestraCleanup.js), else null - the start-up cleanup sweep.
   */
  function landedRun() {
    const integ = plan && plan.integration;
    if (!integ || plan.integrationMode !== 'merge' || integ.state !== 'done' || !plan.baseBranch) return null;
    if (!Number.isFinite(integ.at) || !plan.packages.some((p) => p.merged === true)) return null;
    return { ...postMergeContext(plan, { skipped: integ.skipped }, slugOf(plan)), settledAt: integ.at };
  }

  /**
   * What "Release now" needs about the run on the board, or null without
   * one: its project and checkout, the base and the head its merge landed.
   */
  function releaseTarget() {
    if (!plan) return null;
    const integ = plan.integration || {};
    const done = integ.postMerge && integ.postMerge.release;
    return {
      planId: plan.id,
      projectId: plan.projectId,
      repoPath: plan.repoPath,
      base: plan.baseBranch,
      headSha: integ.headSha || null,
      landed: plan.integrationMode === 'merge' && integ.state === 'done' && !!integ.headSha,
      releaseAfter: sup.normalizeOptions(plan.options).releaseAfter === true,
      released: !!(done && done.released === true),
      busy: isBusy(),
    };
  }

  /**
   * This run's slice of the shared power view (orchestraPower.js
   * aggregatePowerRun): planning or finalizing counts as live, like a
   * started run that is neither killed nor settled. Null with no plan and
   * nothing going.
   */
  function powerState() {
    const working = isBusy();
    if (!plan) {
      return working
        ? { planId: null, live: true, settled: false, pausedUntil: null, killed: false, approvalsPending: false, options: sup.normalizeOptions(null) }
        : null;
    }
    return {
      planId: plan.id,
      live: working || (plan.started === true && !plan.killed && !plan.settled),
      settled: plan.settled === true,
      pausedUntil: plan.pausedUntil || null,
      killed: plan.killed === true,
      approvalsPending: approvalsPending(),
      options: sup.normalizeOptions(plan.options),
    };
  }

  /** The tabs of this run's workers that are running right now (registry.pauseAll). */
  const workerSessions = () =>
    plan ? plan.packages.filter((p) => p.state === 'launched' && p.sessionId).map((p) => p.sessionId) : [];

  function discard() {
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    clearAllTimers();
    plan = null;
    commit();
    return { ok: true };
  }

  return {
    restore,
    makePlan,
    launch,
    view,
    discard,
    retry,
    resumeRun,
    kill,
    tick,
    onTurnEnd,
    onUsageLimit,
    pauseExternal,
    powerState,
    workerSessions,
    onApproval,
    onFiles,
    ownsSession,
    onSessionClosed,
    unschedule,
    finishRun,
    setOptions,
    onSystemSuspend,
    onSystemResume,
    abortFinalize,
    cancelSleep: () => powerFlow.cancelSleep(),
    cancelShutdown: () => powerFlow.cancelShutdown(),
    checkWake: () => powerFlow.checkWake(),
    sweepBranches,
    landedRun,
    // The run email after finalize: "Resend report email" and pending sends (godmodePending.js).
    emailSummary: (planId) => finalizer.emailSummary(planId),
    emailResult: (planId, res) => finalizer.emailResult(planId, res),
    // "Release now" on the finished run (src/orchestraFinishIpc.js).
    releaseTarget,
    recordRelease: (planId, result) => finalizer.recordPostMerge(planId, 'release', result),
    runFixup: (args) => fixup.run(args),
    planWait: () => planWaiter.view(),
    cancelPlanWait: () => planWaiter.cancel(),
    isBusy,
    isRunning: () => !!plan && plan.started && !plan.killed && plan.packages.some(sup.isActive),
    // Multi God Mode's same-repo guard (orchestraRegistry.repoBusy).
    repoPath: () => (plan ? plan.repoPath : null),
    planningRepo: () => planningRepo,
  };
}

module.exports = {
  createOrchestra,
  briefText,
  withStallNote,
  BRIEF_DIR,
  NUDGE_DELAY_MS,
  BACKGROUND_WAIT_MS,
  RESUME_GRACE_MS,
  AUTO_RETRY_DELAY_MS,
  MAX_AUTO_RETRIES: sup.MAX_AUTO_RETRIES,
};
