// ============================================================================
// LunaCore - God Mode v2 run controller (ORCHESTRATOR_PLAN.md slices 3 + 4)
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
const { validatePlan, estimatePlan, MAX_PARALLEL, MAX_PROMPT_CHARS, PLANNER_MODEL } = require('./orchestraPlan');
const sup = require('./orchestraSupervisor');
const { DEFAULT_EFFORT, isEffort, normalizeEffort, nextEffort } = require('./efforts');
const { createFinalizer } = require('./orchestraFinalize');
const { createFixupRunner } = require('./orchestraFixup');
const { planWaitDecision, createPlanWaiter } = require('./orchestraPlanWait');
const { FREE_BRANCH_PREFIX, isSafeFreeBranch, freeRunSettings, integrationFor } = require('./orchestraFree');
const { cleanupFailedLaunch, sweepOrphanBranches } = require('./orchestraCleanup');
const { createPowerFlow } = require('./orchestraPower');
const { createPowerCtl } = require('./powerctl');

const BRIEF_DIR = 'tasks';
// A turn end and the usage-limit error that ended it arrive in one transcript
// fragment, the limit second; the nudge waits this long so the pause can
// cancel it instead of spending a nudge on a wall.
const NUDGE_DELAY_MS = 5000;
// No reset time parsed from the limit message -> look again after this.
const DEFAULT_PAUSE_MS = 30 * 60 * 1000;
// Resume a little after the reset, not on the second.
const RESUME_GRACE_MS = 60 * 1000;
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
    '',
    '## Rules',
    '- Work only in this worktree. Do not push, merge or switch branches.',
    '- When the work is done and verified, commit it on this branch with a conventional commit message.',
    `- End your final message with the line \`LUNA_DONE ${pkg.id}\`, or \`LUNA_BLOCKED ${pkg.id}: <reason>\` if you cannot finish.`,
    '',
  ].join('\n');
}

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
 * }} deps
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
  // dialog available = no merge.
  const confirmMerge = () =>
    deps.confirmMerge
      ? Promise.resolve(deps.confirmMerge(plan.baseBranch)).then((yes) => yes === true, () => false)
      : Promise.resolve(false);
  const saveState = deps.saveState || noop;
  const onChange = deps.onChange || noop;
  const onLive = deps.onLive || noop;
  const onRunEvent = deps.onRunEvent || noop;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const log = deps.log || noop;

  /** @type {null|object} */
  let plan = null;
  let busy = false;
  let pumping = false;
  /** pkgId -> pending nudge timer */
  const nudgeTimers = new Map();
  /** pkgId -> scheduled automatic relaunch after a machinery failure */
  const retryTimers = new Map();
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

  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => patch(id, fields),
    commit: () => commit(),
    view: () => view(),
    onRunEvent: (...args) => onRunEvent(...args),
    now,
    createPr: deps.createPr ? (args) => deps.createPr({ ...args, repoPath: plan.repoPath }) : null,
    integrateMerge: deps.integrateMerge
      ? (args, extra) => deps.integrateMerge({ ...args, repoPath: plan.repoPath }, extra)
      : null,
    runSelfCheck: deps.runSelfCheck,
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
  });
  const isBusy = () => busy || pumping || finalizer.isRunning();

  // Sleep at the usage limit / shut down when done (orchestraPower.js).
  const approvalsPending = () =>
    plan.packages.some((p) => p.state === 'stalled' && p.error === 'needsApproval' && p.sessionId && sessionAlive(p.sessionId));
  const powerFlow = createPowerFlow({
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
  const background = (promise, where) =>
    promise.catch((err) => onRunEvent('error', { where, message: err instanceof Error ? err.message : String(err) }));

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
    plan = { ...sup.restoreAfterRestart(stored), started: false, killed: false, pausedUntil: null, pauseStartedAt: null, settled: false };
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
      scheduledAt: plan.scheduledAt,
      // The morning report's Timeline (orchestraReport.js).
      runStartedAt: plan.runStartedAt || null,
      pausedTotalMs: plan.pausedTotalMs || 0,
      freeMode: plan.freeMode === true,
      options: sup.normalizeOptions(plan.options),
      integration: { ...plan.integration, running: finalizer.isRunning() },
      power: powerFlow.view(),
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
        escalated: p.escalated,
        prUrl: p.prUrl,
        merged: p.merged,
        cleaned: p.cleaned,
        depMerge: p.depMerge || null,
        autoRetries: p.autoRetries || 0,
        autoResumed: p.autoResumed === true,
        terminal: p.terminal === true,
        blockedBy: p.blockedBy || null,
        failure: p.failure || null,
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
   * @param {{projectId:string|null, repoPath:string, profileId:string, env:object}} ctx
   */
  async function makePlan(ctx) {
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    // A manual item is the user's own job: the planner never sees it.
    const openTodos = deps.readTodos(ctx.projectId).filter((t) => !t.done && t.manual !== true);
    if (!openTodos.length) return { ok: false, error: 'noTodos' };
    // A manual (re-)plan replaces a pending wait; the waiter's own replan
    // is in state 'planning' and keeps it.
    if (planWaiter.isWaiting()) planWaiter.clear();

    busy = true;
    try {
      const [res, dirty, baseBranch] = await Promise.all([
        deps.runPlanner({ cwd: ctx.repoPath, env: ctx.env, openTodos }),
        deps.dirtyCount(ctx.repoPath),
        deps.baseBranchOf ? deps.baseBranchOf(ctx.repoPath) : null,
      ]);
      if (!res.ok) {
        const limits = deps.usageLimits ? deps.usageLimits() : [];
        const decision = planWaitDecision({ res, limits, now: now() });
        if (decision.action !== 'wait') return res;
        planWaiter.arm(ctx, decision);
        return { ok: false, error: 'waiting', planWait: planWaiter.view() };
      }
      const checked = validatePlan(res.raw, openTodos);
      clearAllTimers();
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
        runStartedAt: null,
        pausedTotalMs: 0,
        todoText: new Map(openTodos.map((t) => [t.at, t.text])),
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
        })),
      };
      commit();
      return { ok: true, plan: view() };
    } finally {
      busy = false;
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

  const freshRun = () => ({ nudges: 0, verifyRounds: 0, startedAt: now(), pausedMs: 0, error: null, detail: null });

  /**
   * Worktree + brief + tab for one package. Never throws. A failure after
   * the worktree was made removes the worktree AND its branch, and records
   * a structured `failure` for the board.
   */
  async function launchOne(pkg, stamp) {
    const made = { wt: null, base: null, depBranch: null };
    let result;
    try {
      result = await launchOneUnsafe(pkg, stamp, made);
    } catch (err) {
      result = { state: 'failed', error: 'launchThrew', detail: err instanceof Error ? err.message.slice(0, 300) : null };
    }
    if (result.state !== 'failed') return { ...result, failure: null };
    const failure = failureOf(result, made.depBranch, now());
    if (!made.wt) return { ...result, failure };
    const cleaned = await cleanupFailedLaunch(
      { removeWorktree: deps.removeWorktree, deleteBranch: deps.deleteBranch },
      plan.repoPath,
      made.wt,
      made.base,
    );
    if (cleaned.error) log(`failed launch of ${pkg.id} not fully cleaned up: ${cleaned.error}`);
    // Worktree gone: Retry starts a fresh launch instead of reopening it.
    const gone = cleaned.removed ? { branch: null, root: null, cwd: null, briefPath: null, baseSha: null } : {};
    return { ...result, ...gone, failure };
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
    if (!wt.ok) return { state: 'failed', error: wt.error, detail: wt.detail || null };
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
    if (!deps.writeBrief(briefPath, briefText(pkg, wt.branch, { depMerge }))) {
      return { ...where, state: 'failed', error: 'briefFailed' };
    }
    const session = openTab(pkg, wt.cwd, wt.branch, briefPath);
    if (!session) return { ...where, state: 'failed', error: 'noTab' };
    return { ...where, ...freshRun(), state: 'launched', sessionId: session.id };
  }

  async function launchPackages(chosen) {
    const stamp = now().toString(36).slice(-5);
    for (const pkg of chosen) {
      // Kill / pause while an earlier launch was awaiting git: stop here.
      if (plan.killed || plan.pausedUntil) break;
      cancelAutoRetry(pkg.id);
      const before = findPkg(pkg.id) || pkg;
      const result = await launchOne(pkg, stamp);
      if (plan.killed && result.state === 'launched') {
        // The kill landed during this very launch: the tab exists, stop it too.
        writePty(result.sessionId, ESC);
        patch(pkg.id, { ...result, state: 'killed' });
      } else {
        patch(pkg.id, result);
        if (result.state === 'failed') onLaunchFailed(before, result);
      }
      commit();
    }
  }

  /**
   * Machinery auto-retry: a failed launch is tried again by itself after
   * AUTO_RETRY_DELAY_MS, at most MAX_AUTO_RETRIES times. The same error +
   * detail twice in a row means it will not fix itself: terminal.
   * @param {object} before the package as it was before this launch
   * @param {{error?:string, detail?:string|null}} result
   */
  function onLaunchFailed(before, result) {
    if (plan.killed) return;
    const tries = before.autoRetries || 0;
    const repeated =
      tries > 0 && before.error === (result.error || null) && (before.detail || null) === (result.detail || null);
    if (repeated || tries >= sup.MAX_AUTO_RETRIES) {
      markTerminal(before.id, result.error || 'failed');
      return;
    }
    patch(before.id, { autoRetries: tries + 1 });
    const timer = setTimer(() => fireAutoRetry(before.id), AUTO_RETRY_DELAY_MS);
    // A real timer must not keep a test process (or a quitting app) alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
    retryTimers.set(before.id, timer);
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
    if (!settledFinalize || !plan) return;
    settledFinalize = false;
    if (!plan.settled || plan.killed) return;
    const busyNow = isBusy() || plan.packages.some(sup.isActive) || !!(deps.otherRunsActive && deps.otherRunsActive());
    background(powerFlow.afterFinalize({ busy: busyNow }), 'shutdown');
  }

  /** Launches whatever is ready, while slots are free. Re-entrancy safe. */
  async function pump() {
    if (!plan || !plan.started || plan.killed || plan.pausedUntil || pumping) return;
    pumping = true;
    try {
      let ready = sup.readyToLaunch(plan.packages, MAX_PARALLEL);
      while (ready.length && !plan.killed && !plan.pausedUntil) {
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
    if (wanted === 'merge' && !plan.started && !(await confirmMerge())) return { ok: false, error: 'mergeDeclined' };
    if (wanted && !plan.started) plan.integrationMode = wanted;
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
    const stalls = (before.stalls || 0) + 1;
    patch(id, { state: 'stalled', error: reason, detail, stalls, stalledAt: now() });
    const pkg = findPkg(id);
    const live = !plan.killed && !plan.pausedUntil;
    if (live && sup.shouldEscalate(pkg, modelFor(pkg), reason) && escalate(pkg, reason, detail)) {
      commit();
      return;
    }
    if (live && sup.shouldAutoResume(pkg, reason) && autoResume(pkg, reason, detail)) {
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
    if (!pkg || pkg.state !== 'launched' || plan.pausedUntil || plan.killed) return;
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

  async function finish(id) {
    cancelNudge(id);
    // A package finishing after the run settled (Mati unblocked it by hand)
    // reopens the run, so its end gets its own cue.
    plan.settled = false;
    patch(id, { state: 'finishing', error: null, detail: null });
    commit();
    let res;
    try {
      res = await finishPackage({ ...findPkg(id), pushOnVerifyFail: plan.freeMode === true });
    } catch (err) {
      res = { ok: false, stage: 'push', detail: err instanceof Error ? err.message : 'finish failed' };
    }
    const pkg = findPkg(id);
    if (!plan || !pkg) return;

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
      stall(id, 'verifyFailed', lastLine.slice(0, 300));
      return;
    }
    patch(id, { state: 'launched', verifyRounds: pkg.verifyRounds + 1, nudges: 0 });
    writePty(pkg.sessionId, sup.verifyFailText(pkg.id, pkg.verify, res.output), { paste: true });
    commit();
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
    const marker = sup.markerFrom(fragment, pkg.id);
    if (pkg.state === 'stalled') {
      if (marker && marker.kind === 'done') finish(pkg.id);
      return;
    }
    if (pkg.state !== 'launched') return;
    const action = sup.turnEndAction(pkg, marker);
    if (action.type === 'finish') finish(pkg.id);
    else if (action.type === 'stall' && action.reason === 'blocked') stall(pkg.id, action.reason, action.detail || null);
    else if (!plan.pausedUntil) {
      // No marker: nudge or noMarker stall, decided after the delay.
      cancelNudge(pkg.id);
      nudgeTimers.set(pkg.id, setTimer(() => sendNudge(pkg.id), NUDGE_DELAY_MS));
    }
  }

  function resume() {
    resumeTimer = null;
    if (!plan || !plan.pausedUntil) return;
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
    background(powerFlow.cancelSleep(), 'sleep');
  }

  /**
   * electron powerMonitor 'resume': timers may not have counted the sleep.
   * Past the reset -> resume now; before it -> re-arm the resume timer.
   */
  function onSystemResume() {
    background(powerFlow.onSystemResume(), 'sleep');
    if (!plan || !plan.pausedUntil) return;
    if (resumeTimer) clearTimer(resumeTimer);
    resumeTimer = null;
    if (now() >= plan.pausedUntil) resume();
    else resumeTimer = setTimer(resume, plan.pausedUntil - now() + RESUME_GRACE_MS);
  }

  /**
   * The usage limit hit a worker: the whole run waits (it is one account).
   * @param {string} sessionId
   * @param {number|null} resetsAt epoch ms, when the CLI said
   */
  function onUsageLimit(sessionId, resetsAt) {
    const pkg = bySession(sessionId);
    if (!pkg || !sup.isActive(pkg) || plan.killed) return;
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
    const touched = sup.mergeTouched(pkg.touched, sup.relTouched(pkg.root, absFiles));
    if (touched === pkg.touched) return;
    const key = (o) => `${o.a}|${o.b}`;
    const before = new Set(sup.liveOverlaps(plan.packages).map(key));
    patch(pkg.id, { touched });
    for (const o of sup.liveOverlaps(plan.packages)) {
      if (!before.has(key(o))) onRunEvent('overlap', o);
    }
    commit();
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

  /** Called every minute or so: workers over their working time stall. */
  function tick() {
    if (!plan || plan.pausedUntil || plan.killed) return;
    for (const p of plan.packages) {
      if (p.state === 'launched' && sup.timedOut(p, now())) stall(p.id, 'timeout');
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
    settledFinalize = false;
    background(powerFlow.cancelSleep(), 'sleep');
    background(powerFlow.cancelShutdown(), 'shutdown');
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

    freezeSettings();
    if (pkg.sessionId && sessionAlive(pkg.sessionId)) {
      patch(pkg.id, { ...freshRun(), state: 'launched' });
      // A tab stalled on a permission prompt: Mati answers it there. Pasting
      // a nudge + Enter now would land IN the prompt and answer it blindly.
      if (pkg.error !== 'needsApproval') writePty(pkg.sessionId, sup.nudgeText(pkg.id), { paste: true });
    } else if (pkg.root && pkg.branch) {
      const reopened = reopenInWorktree(pkg, briefText(pkg, pkg.branch, { resume: true }));
      if (!reopened.ok) return { ok: false, error: reopened.error };
    } else {
      patch(pkg.id, { state: 'pending', error: null, detail: null });
    }
    // A Retry by hand: the package is back in play, its dependents unblocked.
    cancelAutoRetry(pkg.id);
    patch(pkg.id, { terminal: false, autoRetries: 0 });
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
    kill,
    tick,
    onTurnEnd,
    onUsageLimit,
    onApproval,
    onFiles,
    ownsSession,
    onSessionClosed,
    unschedule,
    finishRun,
    setOptions,
    onSystemResume,
    cancelSleep: () => powerFlow.cancelSleep(),
    cancelShutdown: () => powerFlow.cancelShutdown(),
    checkWake: () => powerFlow.checkWake(),
    sweepBranches,
    runFixup: (args) => fixup.run(args),
    planWait: () => planWaiter.view(),
    cancelPlanWait: () => planWaiter.cancel(),
    isBusy,
    isRunning: () => !!plan && plan.started && !plan.killed && plan.packages.some(sup.isActive),
  };
}

module.exports = {
  createOrchestra,
  briefText,
  withStallNote,
  BRIEF_DIR,
  NUDGE_DELAY_MS,
  RESUME_GRACE_MS,
  AUTO_RETRY_DELAY_MS,
  MAX_AUTO_RETRIES: sup.MAX_AUTO_RETRIES,
};
