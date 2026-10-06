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
const { createFinalizer } = require('./orchestraFinalize');

const BRIEF_DIR = 'tasks';
// A turn end and the usage-limit error that ended it arrive in one transcript
// fragment, the limit second; the nudge waits this long so the pause can
// cancel it instead of spending a nudge on a wall.
const NUDGE_DELAY_MS = 5000;
// No reset time parsed from the limit message -> look again after this.
const DEFAULT_PAUSE_MS = 30 * 60 * 1000;
// Resume a little after the reset, not on the second.
const RESUME_GRACE_MS = 60 * 1000;
const ESC = '\x1b';

/**
 * The brief a worker reads first: LunaCore's own fixed contract around the
 * planner's prompt, so the rules do not depend on the planner remembering
 * them.
 * @param {{id:string, title:string, prompt:string, verify:string}} pkg
 * @param {string} branch
 * @param {{resume?:boolean, escalation?:{reason:string, detail:string|null}}} [opts]
 * @returns {string}
 */
function briefText(pkg, branch, opts = {}) {
  const esc = opts.escalation;
  return [
    `# LunaCore task: ${pkg.title}`,
    '',
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

/**
 * @param {{
 *   runPlanner: Function, addWorktree: Function, createSession: Function,
 *   readTodos: Function, dirtyCount: Function, writeBrief: Function,
 *   briefDir: () => string, now?: () => number,
 *   finishPackage?: Function, headSha?: Function, writePty?: Function,
 *   sessionAlive?: Function, tickTodos?: Function, workerSettings?: Function,
 *   saveState?: Function, loadState?: Function, onChange?: Function,
 *   onRunEvent?: Function, setTimer?: Function, clearTimer?: Function,
 *   closeSession?: Function, usageResetAt?: () => number|null,
 *   baseBranchOf?: Function, mergeDeps?: Function, createPr?: Function,
 *   integrateMerge?: Function, removeWorktree?: Function, updateTodos?: Function,
 *   writeReport?: Function, notify?: Function, sleep?: Function,
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
    (() => ({ model: 'opus', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] }));
  const closeSession = deps.closeSession || noop;
  // Merging into the base branch pushes it: main asks Mati natively. No
  // dialog available = no merge.
  const confirmMerge = () =>
    deps.confirmMerge
      ? Promise.resolve(deps.confirmMerge(plan.baseBranch)).then((yes) => yes === true, () => false)
      : Promise.resolve(false);
  const saveState = deps.saveState || noop;
  const onChange = deps.onChange || noop;
  const onRunEvent = deps.onRunEvent || noop;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;

  /** @type {null|object} */
  let plan = null;
  let busy = false;
  let pumping = false;
  /** pkgId -> pending nudge timer */
  const nudgeTimers = new Map();
  let resumeTimer = null;
  let scheduleTimer = null;

  const finalizer = createFinalizer({
    getPlan: () => plan,
    patch: (id, fields) => patch(id, fields),
    commit: () => commit(),
    view: () => view(),
    onRunEvent: (...args) => onRunEvent(...args),
    now,
    createPr: deps.createPr ? (args) => deps.createPr({ ...args, repoPath: plan.repoPath }) : null,
    integrateMerge: deps.integrateMerge ? (args) => deps.integrateMerge({ ...args, repoPath: plan.repoPath }) : null,
    currentBaseBranch: deps.baseBranchOf ? () => deps.baseBranchOf(plan.repoPath) : null,
    removeWorktree: deps.removeWorktree,
    closeSession,
    sessionAlive,
    updateTodos: deps.updateTodos,
    writeReport: deps.writeReport,
    notify: deps.notify,
    sleep: deps.sleep,
  });
  const isBusy = () => busy || pumping || finalizer.isRunning();

  /**
   * Brings back the run saved by the previous LunaCore. Not in the
   * constructor: main builds this before app.whenReady(), when the user
   * config folder is not dependable yet. The restored run is held (not
   * started) - nothing launches at boot until Mati presses Approve or Retry.
   */
  function restore() {
    const stored = deps.loadState ? sup.normalizeStoredPlan(deps.loadState()) : null;
    if (!stored || plan) return false;
    plan = { ...sup.restoreAfterRestart(stored), started: false, killed: false, pausedUntil: null, pauseStartedAt: null, settled: false };
    // A schedule Mati armed survives a restart; one already missed does not
    // start the run late - the run stays held.
    if (plan.scheduledAt && plan.scheduledAt > now()) armSchedule(plan.scheduledAt);
    else plan.scheduledAt = null;
    commit();
    return true;
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
      permissionMode: plan.permissionMode || workerSettings().permissionMode,
      integrationMode: plan.integrationMode || workerSettings().integration,
      baseBranch: plan.baseBranch,
      started: plan.started,
      killed: plan.killed,
      settled: plan.settled,
      pausedUntil: plan.pausedUntil,
      scheduledAt: plan.scheduledAt,
      integration: { ...plan.integration, running: finalizer.isRunning() },
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
        stalls: p.stalls,
        escalated: p.escalated,
        prUrl: p.prUrl,
        merged: p.merged,
        cleaned: p.cleaned,
      })),
    };
  }

  /** Writes the run to disk and tells the renderer. Every transition ends here. */
  function commit() {
    saveState(plan ? sup.serializePlan(plan) : null);
    onChange(view());
  }

  const findPkg = (id) => (plan ? plan.packages.find((p) => p.id === id) : null);
  const bySession = (sessionId) => (plan && sessionId ? plan.packages.find((p) => p.sessionId === sessionId) : null);

  function patch(id, fields) {
    plan.packages = plan.packages.map((p) => (p.id === id ? { ...p, ...fields } : p));
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

  function clearAllTimers() {
    for (const id of [...nudgeTimers.keys()]) cancelNudge(id);
    if (resumeTimer) clearTimer(resumeTimer);
    resumeTimer = null;
    clearSchedule();
  }

  /** Worker settings + integration mode, frozen when the run starts. */
  function freezeSettings() {
    const s = workerSettings();
    plan.workerModel = plan.workerModel || s.model;
    plan.permissionMode = plan.permissionMode || s.permissionMode;
    plan.integrationMode = plan.integrationMode || s.integration || 'pr';
    if (!plan.allowedTools) plan.allowedTools = (s.allowedTools || []).filter(sup.isAllowRule);
  }

  const modelFor = (pkg) => pkg.modelOverride || (plan.workerModel === 'plan' ? pkg.model : plan.workerModel);

  /**
   * Runs the planner for one project. Replaces any previous plan, except one
   * whose run still has a worker going.
   * @param {{projectId:string|null, repoPath:string, profileId:string, env:object}} ctx
   */
  async function makePlan(ctx) {
    if (isBusy()) return { ok: false, error: 'busy' };
    if (plan && plan.packages.some(sup.isActive)) return { ok: false, error: 'runActive' };
    const openTodos = deps.readTodos(ctx.projectId).filter((t) => !t.done);
    if (!openTodos.length) return { ok: false, error: 'noTodos' };

    busy = true;
    try {
      const [res, dirty, baseBranch] = await Promise.all([
        deps.runPlanner({ cwd: ctx.repoPath, env: ctx.env, openTodos }),
        deps.dirtyCount(ctx.repoPath),
        deps.baseBranchOf ? deps.baseBranchOf(ctx.repoPath) : null,
      ]);
      if (!res.ok) return res;
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
        permissionMode: null,
        allowedTools: null,
        integrationMode: null,
        baseBranch: sup.isBaseBranch(baseBranch) ? baseBranch : null,
        scheduledAt: null,
        approvalLog: [],
        integration: { state: 'idle', error: null, detail: null, at: null },
        started: false,
        killed: false,
        settled: false,
        pausedUntil: null,
        pauseStartedAt: null,
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
          touched: [],
          prUrl: null,
          merged: false,
          cleaned: false,
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
      task: { briefPath, model: modelFor(pkg), permissionMode: plan.permissionMode, allowedTools: plan.allowedTools || [] },
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

  /** Worktree + brief + tab for one package. Never throws. */
  async function launchOne(pkg, stamp) {
    try {
      return await launchOneUnsafe(pkg, stamp);
    } catch (err) {
      return { state: 'failed', error: 'launchThrew', detail: err instanceof Error ? err.message.slice(0, 300) : null };
    }
  }

  /**
   * A dependent builds on its dependencies' work: its worktree starts from
   * the first dependency's pushed head and merges the others in.
   */
  async function launchOneUnsafe(pkg, stamp) {
    const pushedDeps = pkg.dependsOn.map(findPkg).filter((d) => d && d.state === 'pushed' && d.branch);
    const baseDep = pushedDeps.find((d) => d.headSha) || null;
    const wt = await deps.addWorktree(plan.repoPath, `${pkg.id}-${stamp}`, { base: baseDep ? baseDep.headSha : undefined });
    if (!wt.ok) return { state: 'failed', error: wt.error };
    const others = pushedDeps.filter((d) => d !== baseDep).map((d) => d.branch);
    if (others.length && deps.mergeDeps) {
      const merged = await deps.mergeDeps(wt.root, others);
      if (!merged.ok) {
        // No location kept: a Retry relaunches it fresh instead of resuming a
        // worktree that lacks its dependencies' work.
        if (deps.removeWorktree) await deps.removeWorktree(plan.repoPath, wt.root);
        return { state: 'failed', error: 'depMergeFailed', detail: merged.detail || null };
      }
    }
    const baseSha = await headSha(wt.root);
    const briefPath = path.join(deps.briefDir(), `${path.basename(wt.root)}.md`);
    const where = { branch: wt.branch, root: wt.root, cwd: wt.cwd, briefPath, baseSha };
    if (!deps.writeBrief(briefPath, briefText(pkg, wt.branch))) return { ...where, state: 'failed', error: 'briefFailed' };
    const session = openTab(pkg, wt.cwd, wt.branch, briefPath);
    if (!session) return { ...where, state: 'failed', error: 'noTab' };
    return { ...where, ...freshRun(), state: 'launched', sessionId: session.id };
  }

  async function launchPackages(chosen) {
    const stamp = now().toString(36).slice(-5);
    for (const pkg of chosen) {
      // Kill / pause while an earlier launch was awaiting git: stop here.
      if (plan.killed || plan.pausedUntil) break;
      const result = await launchOne(pkg, stamp);
      if (plan.killed && result.state === 'launched') {
        // The kill landed during this very launch: the tab exists, stop it too.
        writePty(result.sessionId, ESC);
        patch(pkg.id, { ...result, state: 'killed' });
      } else {
        patch(pkg.id, result);
      }
      commit();
    }
  }

  /** Ends the run once nothing more can happen on its own, then finalizes it. */
  function checkSettled() {
    if (!plan.started || plan.killed || plan.settled || !sup.isSettled(plan.packages, MAX_PARALLEL)) return;
    plan.settled = true;
    const allPushed = plan.packages.every((p) => p.state === 'pushed');
    onRunEvent(allPushed ? 'done' : 'needYou', sup.tally(plan.packages));
    startFinalize();
  }

  function startFinalize() {
    finalizer
      .finalize()
      .catch((err) => onRunEvent('error', { where: 'finalize', message: err instanceof Error ? err.message : String(err) }));
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

    if (mode === 'merge' && !plan.started && !(await confirmMerge())) return { ok: false, error: 'mergeDeclined' };
    if (mode && !plan.started) plan.integrationMode = mode;
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
      if (chosen) await launchPackages(chosen);
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
    patch(id, { state: 'stalled', error: reason, detail, stalls });
    const pkg = findPkg(id);
    if (!plan.killed && !plan.pausedUntil && sup.shouldEscalate(pkg, modelFor(pkg), reason) && escalate(pkg, reason, detail)) {
      commit();
      return;
    }
    onRunEvent('stalled', { id, reason });
    commit();
    kick();
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
    const session = safeOpenTab({ ...pkg, modelOverride: 'opus' }, pkg.cwd || pkg.root, pkg.branch, briefPath);
    if (!session) return false;
    // Re-pointed before the close, so the old tab's close is not read as this package's.
    patch(pkg.id, { ...freshRun(), state: 'launched', sessionId: session.id, briefPath, modelOverride: 'opus', escalated: true });
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
      res = await finishPackage(findPkg(id));
    } catch (err) {
      res = { ok: false, stage: 'push', detail: err instanceof Error ? err.message : 'finish failed' };
    }
    const pkg = findPkg(id);
    if (!plan || !pkg) return;

    if (res.ok) {
      const touched = sup.mergeTouched(pkg.touched, sup.relTouched(pkg.root, res.files || []));
      patch(id, { state: 'pushed', headSha: res.headSha || null, error: null, detail: null, touched });
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
    if (sup.INTEGRATION_MODES.includes(o.integration) && o.integration !== plan.integrationMode) {
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
    plan.pausedUntil = null;
    plan.pauseStartedAt = null;
    for (const p of plan.packages.filter((x) => x.state === 'launched')) {
      writePty(p.sessionId, ESC);
      patch(p.id, { state: 'killed' });
    }
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
      // Recomputed, never taken from the saved run: only LunaCore's own
      // brief folder is ever written to.
      const briefPath = path.join(deps.briefDir(), `${path.basename(pkg.root)}.md`);
      if (!deps.writeBrief(briefPath, briefText(pkg, pkg.branch, { resume: true }))) {
        return { ok: false, error: 'briefFailed' };
      }
      const session = safeOpenTab(pkg, pkg.cwd || pkg.root, pkg.branch, briefPath);
      if (!session) return { ok: false, error: 'noTab' };
      patch(pkg.id, { ...freshRun(), state: 'launched', sessionId: session.id, briefPath });
    } else {
      patch(pkg.id, { state: 'pending', error: null, detail: null });
    }
    // Only once the package is back in play does the run resume.
    plan.started = true;
    plan.killed = false;
    plan.settled = false;
    commit();
    await pump();
    return { ok: true, plan: view() };
  }

  /** A closed tab leaves its worktree; the board says so and the slot frees. */
  function onSessionClosed(sessionId) {
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
    isBusy,
    isRunning: () => !!plan && plan.started && !plan.killed && plan.packages.some(sup.isActive),
  };
}

module.exports = { createOrchestra, briefText, BRIEF_DIR, NUDGE_DELAY_MS, RESUME_GRACE_MS };
