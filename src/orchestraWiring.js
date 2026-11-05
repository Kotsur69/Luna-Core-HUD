// ============================================================================
// LunaCore - God Mode v2 wiring (main process, docs/MULTI_GODMODE_PLAN.md A2)
// ----------------------------------------------------------------------------
// Builds the real deps of one God Mode controller (src/orchestra.js
// createOrchestra) for ONE project, from what main.js already has - the same
// split as src/lunasworkWiring.js: main only hands its handles over in `ctx`.
// The registry (src/orchestraRegistry.js) calls this once per project.
//
//   sessions     worker / fix-up tabs through the overnight guard, PTY writes
//   to-dos       ticking cards on the run's project list
//   integration  merge, PR, self-check (behind the Luna's Work secret gate)
//   reports      <runsDir>/<planId>.md + .html, the morning toast
//   state        config/orchestra/<hash>.local.json for THIS project
//                (orchestraStore.js) - bound here, so a discard
//                (saveState(null)) clears the right file
//   renderer     orchestra:changed / orchestra:planWait carry {projectId, ...}
//   power        sleep at the limit / shutdown when done; otherRunsActive is
//                the registry's othersActive(projectId)
//
// Luna's Work overlays (worker settings, planner models) apply only to the
// project its build runs on; every other project's run is plain God Mode.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { BRIEF_DIR } = require('./orchestra');
const { runPlanner } = require('./orchestraPlan');
const { finishPackage, headSha, runVerify } = require('./orchestraFinish');
const orchestraIntegrate = require('./orchestraIntegrate');
const { renderRunReportHtml, repoPathOf } = require('./orchestraReport');
const { gitDirExists } = require('./orchestraDiagnose');
const orchestraSelfCheck = require('./orchestraSelfCheck');
const defaultStore = require('./orchestraStore');
const { lastOpenToolUse, allowRuleFor, exampleFor } = require('./orchestraSupervisor');
const { guardedSessionFactory } = require('./overnight');
const { createPowerCtl } = require('./powerctl');
const { createProcessScope } = require('./procTree');
const { WATCHDOG_TICK_MS } = require('./orchestraSleep');

const RUN_ID_RE = /^[a-z0-9]{1,40}$/;
// How much of a worker's transcript is read to name the tool a permission
// prompt is about.
const APPROVAL_TAIL_BYTES = 256 * 1024;
const TOAST_TITLE = 'LunaCore God Mode';
const POWER_NOTICES = {
  sleepSoon: 'Usage limit - the PC sleeps in 60 s and wakes for the reset. Cancel on the God Mode board.',
  sleepFailed: 'Could not schedule the wake-up, so the PC stays awake.',
  shutdownSoon: 'Run finished - the PC shuts down in 2 minutes. Cancel on the God Mode board.',
  shutdownFailed: 'Could not schedule the shutdown.',
};

const errText = (err) => (err && err.message) || String(err);

/**
 * The registered project whose folder a stored run's repoPath is, or null.
 * Re-homed first: a run saved under another user's home still matches the
 * same registered project here (restore() re-homes the rest).
 * @param {{projects: () => object[], resolveStoredPath: Function}} ctx
 * @param {unknown} repoPath
 */
function projectForStoredRepo(ctx, repoPath) {
  if (typeof repoPath !== 'string' || !repoPath) return null;
  const repo = path.resolve(ctx.resolveStoredPath(repoPath) || repoPath);
  return ctx.projects().find((p) => p.path && path.resolve(p.path) === repo) || null;
}

/** orchestraStore.migrateLegacy's repoPath match: the legacy run's project id, or null. */
function legacyRunProject(ctx, raw) {
  const project = projectForStoredRepo(ctx, raw && raw.repoPath);
  return project ? project.id : null;
}

/**
 * The tail of a worker's transcript -> {rule, example} its permission prompt
 * is about (idea #5). Read once per prompt appearance, worker tabs only.
 * @param {{watcher?: {currentFile?: string|null}}} session
 */
function approvalRuleFor(session) {
  const none = { rule: null, example: null };
  const file = session.watcher && session.watcher.currentFile;
  if (!file) return none;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, APPROVAL_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const open = lastOpenToolUse(buf.toString('utf8'));
    return { rule: allowRuleFor(open), example: exampleFor(open) };
  } catch {
    return none;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Luna's Work's view of God Mode (lunasworkBuild.js / lunasworkWiring.js):
 * one run per project, picked by the project or by the plan id a call carries.
 * @param {() => object} registry the orchestraRegistry, read lazily
 */
function godModeFacade(registry) {
  const runOf = (projectId) => registry().get(projectId);
  const onPlanRun = (payload, fn) => {
    const owner = registry().byPlanId(payload && payload.planId);
    return owner ? fn(owner.controller) : Promise.resolve({ ok: false, error: 'noPlan' });
  };
  return {
    makePlan: (planCtx) => registry().ensure(planCtx.projectId).makePlan(planCtx),
    launch: (payload) => onPlanRun(payload, (c) => c.launch(payload)),
    finishRun: (payload) => onPlanRun(payload, (c) => c.finishRun(payload)),
    cancelPlanWait: (projectId) => (runOf(projectId) ? runOf(projectId).cancelPlanWait() : null),
    view: (projectId) => (runOf(projectId) ? runOf(projectId).view() : null),
    planWait: (projectId) => (runOf(projectId) ? runOf(projectId).planWait() : null),
  };
}

/** Worker / fix-up tabs and what the supervisor does with them. */
function sessionDeps(ctx) {
  return {
    addWorktree: ctx.worktrees.addWorktree,
    dirtyCount: ctx.worktrees.dirtyCount,
    readTodos: ctx.readTodos,
    // Every worker / fix-up tab joins the overnight guard: keep-awake while a
    // run has tabs, plus the LM Studio watchdog for local-model workers. The
    // tab closing ends it (overnight.forgetSession in the close path).
    createSession: guardedSessionFactory(ctx.createSession, ctx.overnight),
    briefDir: () => path.join(ctx.userDir(), BRIEF_DIR),
    writeBrief: (file, text) => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },
    // Slice 4 supervisor.
    finishPackage,
    headSha,
    sessionAlive: (id) => {
      const s = ctx.sessions.get(id);
      return !!(s && s.proc);
    },
    // Multi-line text goes in as a bracketed paste + Enter (see pty:paste);
    // a bare control byte (the kill switch's Esc) is written raw. Pasted text
    // can carry tool output (a failed verify), so control characters are
    // stripped first: an embedded ESC[201~ would end the paste early and turn
    // the rest into live keystrokes.
    writePty: (id, text, opts = {}) => {
      const s = ctx.sessions.get(id);
      if (!s || !s.proc) return false;
      if (opts.paste) {
        // eslint-disable-next-line no-control-regex
        const clean = String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
        s.proc.write(`\x1b[200~${clean}\x1b[201~`);
        s.proc.write('\r');
      } else {
        s.proc.write(text);
      }
      return true;
    },
    // Second pass + slice 5.
    closeSession: (id) => ctx.closeSession(id),
  };
}

/** The run's project to-do list: ticking and editing cards. */
function todoDeps(ctx) {
  return {
    tickTodos: (projectId, ats) => {
      const wanted = new Set(ats);
      const list = ctx.readTodos(projectId);
      const next = list.map((t) => (wanted.has(t.at) && !t.done ? { ...t, done: true, doneAt: Date.now() } : t));
      if (next.some((t, i) => t !== list[i]) && ctx.writeTodos(projectId, next)) ctx.send('todo:changed', { projectId });
    },
    updateTodos: (projectId, fn) => {
      const list = ctx.readTodos(projectId);
      const next = fn(list);
      if (next !== list && ctx.writeTodos(projectId, next)) ctx.send('todo:changed', { projectId });
    },
  };
}

/** execImpl / verifyImpl whose children a process scope tracks. */
const scopedIo = (scope) => ({
  execImpl: scope.execFile,
  verifyImpl: (command, cwd) => runVerify(command, cwd, scope.exec),
});

/** Merge, PR, self-check and branch cleanup (orchestraIntegrate / orchestraSelfCheck). */
function integrationDeps(ctx) {
  const resolve = (r) => orchestraIntegrate.runResolver({ ...r, env: ctx.toolEnv() });
  const wt = ctx.worktrees;
  return {
    usageResetAt: ctx.usageResetAt,
    baseBranchOf: (repoPath) => orchestraIntegrate.baseBranchOf(repoPath),
    mergeDeps: (root, branches) => orchestraIntegrate.mergeDeps(root, branches, { resolve }),
    createPr: (args) => orchestraIntegrate.createPr({ ...args, env: ctx.toolEnv() }),
    // extra.beforePush: the end-of-run self-check gate (orchestraFinalize.js).
    // extra.scope: the pass's process scope (src/procTree.js) - git, npm
    // and the resolver run through it, so a timed-out pass can be killed.
    integrateMerge: (args, extra) => {
      const scope = extra && extra.scope ? extra.scope : null;
      return orchestraIntegrate.integrateMerge(args, {
        addWorktree: wt.addWorktree,
        removeWorktree: wt.removeWorktree,
        resolve: scope ? (r) => orchestraIntegrate.runResolver({ ...r, env: ctx.toolEnv() }, scope.execFile) : resolve,
        ...(scope ? scopedIo(scope) : {}),
        ...(extra && typeof extra.beforePush === 'function' ? { beforePush: extra.beforePush } : {}),
      });
    },
    runSelfCheck: ctx.secretGate.wrapSelfCheck((args) =>
      orchestraSelfCheck.runSelfCheck(args, args && args.scope ? scopedIo(args.scope) : undefined),
    ),
    createProcessScope: () => createProcessScope(),
    pushBranch: ctx.secretGate.wrapPushBranch((root, branch) => orchestraSelfCheck.pushBranch(root, branch)),
    removeWorktree: wt.removeWorktree,
    // Failed-launch cleanup + the orphan-branch sweep (orchestraCleanup.js).
    deleteBranch: wt.deleteBranch,
    listOwnBranches: wt.listOwnBranches,
    worktreeBranches: wt.worktreeBranches,
  };
}

/** The run report (<runsDir>/<planId>.md + .html), snapshots and the morning toast. */
function reportDeps(ctx, self) {
  return {
    putSnapshot: (run) => ctx.putSnapshot(run),
    onReport: (planId, text, summary) => ctx.onReport(planId, text, summary),
    writeReport: (planId, text) => {
      if (!RUN_ID_RE.test(planId) || !ctx.ensureUserDir()) return null;
      try {
        const dir = ctx.runsDir();
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${planId}.md`);
        fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
        // The same run as a standalone page with charts, next to the .md.
        try {
          const view = self().view() || {};
          const repoPath = repoPathOf(text);
          const html = renderRunReportHtml(view, { now: Date.now(), suggestions: view.suggestions, repoPath, gitDirExists: gitDirExists(repoPath) });
          fs.writeFileSync(path.join(dir, `${planId}.html`), html, { encoding: 'utf8', mode: 0o600 });
        } catch (err) {
          ctx.logError(`[orchestra] html report failed: ${errText(err)}`);
        }
        return file;
      } catch {
        return null;
      }
    },
    appendReport: (planId, line) => {
      if (!RUN_ID_RE.test(planId) || !ctx.ensureUserDir()) return;
      try {
        fs.appendFileSync(path.join(ctx.runsDir(), `${planId}.md`), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        ctx.logError(`[orchestra] could not append to the run report: ${errText(err)}`);
      }
    },
    // The morning report toast, when OS notifications are on (Settings).
    notify: ({ pushed, total, failed }) => {
      if (!ctx.readUiPrefs().notificationsEnabled) return;
      ctx.toast(TOAST_TITLE, `${pushed}/${total} pushed${failed ? ' - integration needs you' : ''}`);
    },
    onRunEvent: (kind) => {
      if (ctx.readUiPrefs().voiceEnabled === false) return;
      if (kind === 'done') ctx.playCue('voice.done');
      else if (kind === 'needYou' || kind === 'stalled' || kind === 'overlap') ctx.playCue('voice.needYou');
    },
  };
}

/** This project's stored run and the renderer events, bound to `projectId`. */
function stateDeps(projectId, ctx, store) {
  return {
    // A saved run is only brought back for a folder that is still one of the
    // registered projects - the file is on disk, so it is not trusted to name
    // where LunaCore opens tabs and runs git. Nor while another project's run
    // holds the same repo.
    loadState: () => {
      const raw = store.loadRun(projectId);
      if (!raw || !projectForStoredRepo(ctx, raw.repoPath)) return null;
      const repo = ctx.resolveStoredPath(raw.repoPath) || raw.repoPath;
      if (ctx.registry().repoBusy(projectId, repo)) {
        ctx.logError('[orchestra] stored run not restored: another project holds its repo');
        return null;
      }
      return raw;
    },
    saveState: (data) => {
      if (!store.saveRun(projectId, data)) ctx.logError('[orchestra] could not save the God Mode run (config/orchestra)');
    },
    onChange: (view) => {
      ctx.send('orchestra:changed', { projectId, view });
      ctx.builder.onChange(view, projectId);
    },
    onLive: (view) => ctx.onLive(view),
    onPlanWait: (state) => ctx.send('orchestra:planWait', { projectId, state }),
    // A restored run's folders and briefs re-homed onto this PC (src/projects.js).
    resolvePath: (p) => ctx.resolveStoredPath(p),
    resolveFile: (p) => ctx.resolveStoredPath(p, (f) => fs.existsSync(f)),
    flush: () => ctx.flushTodos(),
  };
}

/** Usage limits, free providers, sleep / shutdown and the cross-run guards. */
function powerDeps(projectId, ctx) {
  return {
    // Planning that hit the Claude limit waits for the reset (orchestraPlanWait.js).
    usageLimits: () => ctx.usageLimits(),
    // ...unless another Claude account is free (src/claudeaccounts.js).
    accountFailover: (resetsAt) => ctx.accountFailover(resetsAt),
    freshEnv: () => ctx.toolEnv(),
    // "Free providers" runs: the first profile with a fallback chain (orchestraFree.js).
    freeProfileId: () => ctx.freeProfileId(),
    // Sleep at the usage limit / shut down when done (src/orchestraPower.js).
    power: createPowerCtl(),
    awake: { release: () => ctx.overnight.suspendAwake(), restore: () => ctx.overnight.restoreAwake() },
    // Shutdown when done waits for every other project's run too.
    otherRunsActive: () => ctx.registry().othersActive(projectId),
    // The same repo twice is refused (makePlan -> 'repoBusy').
    repoBusy: (repoPath) => ctx.registry().repoBusy(projectId, repoPath),
    // Shown whether or not toasts are on in Settings: the PC is about to go.
    notifyPower: (kind) => {
      const body = POWER_NOTICES[kind];
      if (body) ctx.toast(TOAST_TITLE, body);
    },
  };
}

/**
 * Luna's Work's overlays for this project's run: package models in the plan,
 * the build's worker settings and its own merge confirmation. They apply only
 * while Luna's Work builds on THIS project.
 */
function builderDeps(projectId, ctx, self) {
  const building = () => ctx.builder.isBuilding(projectId);
  const wrapped = ctx.builder.wrapPlanner(runPlanner);
  return {
    runPlanner: (args) => (building() ? wrapped(args) : runPlanner(args)),
    workerSettings: () => {
      const prefs = ctx.readUiPrefs();
      const base = {
        model: prefs.orchestraWorkerModel,
        permissionMode: prefs.orchestraPermissionMode,
        effort: prefs.orchestraWorkerEffort,
        integration: prefs.orchestraIntegration,
        allowedTools: prefs.orchestraAllowedTools,
        checkCommand: prefs.orchestraCheckCommand,
      };
      return building() ? ctx.builder.workerSettings(base) : base;
    },
    // Merge mode pushes the base branch with no PR review: Mati confirms it
    // here, natively - a renderer can ask for it, never grant it. A Luna's
    // Work build's own plan was confirmed the same way when Mati started that run.
    confirmMerge: async (base) => {
      if (ctx.builder.ownsMerge(self().view())) return true;
      const answer = ctx.messageBox({
        type: 'warning',
        buttons: ['Merge and push', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'God Mode - merge into base branch',
        message: `Merge every pushed package into "${base || '?'}" and push it?`,
        detail:
          'Packages are merged in dependency order in a separate worktree and verified after each merge. Nothing is pushed if a verify fails or a conflict cannot be resolved. There is no PR review.',
      });
      if (!answer) return false;
      const { response } = await answer;
      return response === 0;
    },
  };
}

/**
 * The deps of one project's God Mode controller.
 * @param {string|null} projectId the registry key this controller is bound to
 * @param {{
 *   registry: () => {get:Function, othersActive:Function, repoBusy:Function},
 *   builder: {isBuilding:Function, wrapPlanner:Function, workerSettings:Function, ownsMerge:Function, onChange:Function},
 *   secretGate: {wrapSelfCheck:Function, wrapPushBranch:Function},
 *   overnight: {suspendAwake:Function, restoreAwake:Function},
 *   sessions: Map<string, object>, send: (channel:string, payload:unknown) => void,
 *   readUiPrefs: () => object, readTodos: Function, writeTodos: Function,
 *   createSession: Function, closeSession: Function, usageResetAt: () => number|null,
 *   toolEnv: () => object, userDir: () => string, ensureUserDir: () => boolean, runsDir: () => string,
 *   worktrees: {addWorktree:Function, dirtyCount:Function, removeWorktree:Function,
 *     deleteBranch:Function, listOwnBranches:Function, worktreeBranches:Function},
 *   putSnapshot: Function, onReport: Function, onLive: Function,
 *   messageBox: (opts:object) => Promise<{response:number}>|null, toast: (title:string, body:string) => void,
 *   projects: () => object[], resolveStoredPath: Function, flushTodos: () => void,
 *   usageLimits: () => object[], accountFailover: Function, freeProfileId: () => string|null,
 *   playCue: (key:string) => void, log: (line:string) => void, logError: (line:string) => void,
 *   store?: {loadRun:Function, saveRun:Function},
 * }} ctx
 * @returns {object} createOrchestra deps
 */
function makeOrchestraDeps(projectId, ctx) {
  const store = ctx.store || defaultStore;
  // This controller, once the registry has made it (deps are built first).
  const self = () => ctx.registry().get(projectId);
  return {
    ...sessionDeps(ctx),
    ...todoDeps(ctx),
    ...integrationDeps(ctx),
    ...reportDeps(ctx, self),
    ...stateDeps(projectId, ctx, store),
    ...powerDeps(projectId, ctx),
    ...builderDeps(projectId, ctx, self),
    // The watchdog interval (main.js ticks the registry at it): a tick much
    // later than this means the PC slept (orchestraSleep.js).
    tickMs: WATCHDOG_TICK_MS,
    log: (line) => ctx.log(line),
  };
}

module.exports = { makeOrchestraDeps, projectForStoredRepo, legacyRunProject, approvalRuleFor, godModeFacade };
