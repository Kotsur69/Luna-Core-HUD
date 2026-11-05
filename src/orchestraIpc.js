// ============================================================================
// LunaCore - God Mode v2 IPC (main process, docs/MULTI_GODMODE_PLAN.md A2)
// ----------------------------------------------------------------------------
// The orchestra:* handlers, one God Mode run per project (orchestraRegistry).
// The renderer is untrusted: every handler resolves the run here, in main.
//
//   projectId  optional on every call. Given, it must be a string of at most
//              200 chars naming a registered project that has a run, or an
//              explicit null for the run of a tab with no project; anything
//              else is refused. Missing, the call falls back to the active
//              tab's project, or else to the only run there is - so the
//              single-run board keeps working unchanged.
//   planId     calls about a plan (launch, retry, unschedule, finish, abort
//              finish, open report) are cross-checked against the resolved
//              run's plan.
//              Without a projectId the planId itself names the run.
//   planning   orchestra:plan never takes a project from the renderer: it is
//              the tab's own project, folder and profile.
//   list       orchestra:list returns a summary of every run.
//
// Refusals are {ok:false, error}: badPayload, badProject, unknownProject,
// noPlan (no such run or plan), plus what the controller itself returns.
// ============================================================================

'use strict';

const fs = require('fs');
const { reportFileFor } = require('./orchestraReport');
const { isAllowRule, isOptionsPatch, PR_URL_RE } = require('./orchestraSupervisor');

const MAX_PROJECT_ID_CHARS = 200;
// A payload that is present but not a plain object.
const BAD_PAYLOAD = Symbol('badPayload');
// An explicit `projectId: null`: the run of a tab with no project (registry
// key null), as orchestra:list reports it - not "no preference".
const NO_PROJECT = Symbol('noProject');

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keyOf = (projectId) => (typeof projectId === 'string' ? projectId : null);
const refuse = (error) => ({ ok: false, error });

/** The projectId field of a plain object; an own `projectId: null` is NO_PROJECT. */
function scopeOf(obj) {
  if (obj.projectId === null && Object.prototype.hasOwnProperty.call(obj, 'projectId')) return NO_PROJECT;
  return obj.projectId;
}

/** The projectId an optional `{projectId}` options argument carries. */
function projectIdOf(opts) {
  if (opts === undefined || opts === null) return undefined;
  return isPlainObject(opts) ? scopeOf(opts) : BAD_PAYLOAD;
}

/**
 * A run summary for orchestra:list - counts and states, no prompts or paths.
 * @param {{projectId:string|null, view:object, running:boolean}} entry
 * @param {object[]} projects
 */
function runSummary(entry, projects) {
  const { projectId, view } = entry;
  const project = projectId === null ? null : projects.find((p) => p && p.id === projectId);
  return {
    projectId,
    label: project ? project.label || project.id : null,
    planId: view.id,
    started: view.started === true,
    killed: view.killed === true,
    settled: view.settled === true,
    running: entry.running === true,
    pausedUntil: Number.isFinite(view.pausedUntil) ? view.pausedUntil : null,
    scheduledAt: Number.isFinite(view.scheduledAt) ? view.scheduledAt : null,
    tally: isPlainObject(view.tally) ? { ...view.tally } : null,
    packages: Array.isArray(view.packages) ? view.packages.length : 0,
    integration: isPlainObject(view.integration) && typeof view.integration.state === 'string' ? view.integration.state : null,
  };
}

/**
 * @param {{handle: Function, on: Function}} ipcMain
 * @param {{
 *   registry: object,
 *   projects: () => object[],
 *   activeProjectId: () => string|null|undefined,
 *   resolveSession: (sessionId:unknown) => object|null,
 *   repoFor: (session:object) => string|null,
 *   toolEnv: () => object,
 *   maxTodoItems: number,
 *   godModeBlock: (projectId:string|null) => object|null,
 *   send: (channel:string, payload:unknown) => void,
 *   playCue: (key:string) => void,
 *   openExternal: (url:string) => void,
 *   openPath: (file:string) => Promise<string>,
 *   runsDir: () => string,
 *   readUiPrefs: () => object,
 *   writeUiPrefs: (patch:object) => void,
 * }} ctx
 * @returns {{resolveRun: Function, runForPlan: Function}} for tests
 */
function registerOrchestraIpc(ipcMain, ctx) {
  const { registry } = ctx;
  // A plan, or a planning wait that has no plan yet.
  const inUse = (c) => !!(c.view() || c.planWait());

  /** No projectId: the active tab's run, else the only run there is. */
  function fallbackRun() {
    const active = keyOf(ctx.activeProjectId());
    const own = registry.get(active);
    if (own && inUse(own)) return { projectId: active, controller: own };
    const used = registry.entries().filter((e) => inUse(e.controller));
    if (used.length === 1) return used[0];
    return own ? { projectId: active, controller: own } : null;
  }

  /**
   * The run a call is about.
   * @param {unknown} projectId undefined/null = fallback; NO_PROJECT = the
   *   no-project run; BAD_PAYLOAD = refused
   * @returns {{ok:true, projectId:string|null, controller:object}|{ok:false, error:string}}
   */
  function resolveRun(projectId) {
    if (projectId === BAD_PAYLOAD) return refuse('badPayload');
    if (projectId === NO_PROJECT) {
      const controller = registry.get(null);
      return controller ? { ok: true, projectId: null, controller } : refuse('noPlan');
    }
    if (projectId === undefined || projectId === null) {
      const found = fallbackRun();
      return found ? { ok: true, ...found } : refuse('noPlan');
    }
    if (typeof projectId !== 'string' || !projectId || projectId.length > MAX_PROJECT_ID_CHARS) return refuse('badProject');
    if (!ctx.projects().some((p) => p && p.id === projectId)) return refuse('unknownProject');
    const controller = registry.get(projectId);
    return controller ? { ok: true, projectId, controller } : refuse('noPlan');
  }

  /** A plan-bearing call: the run, and its plan must be the one named. */
  function runForPlan(projectId, planId) {
    if (projectId === BAD_PAYLOAD) return refuse('badPayload');
    const explicit = projectId !== undefined && projectId !== null;
    const owner = !explicit && typeof planId === 'string' ? registry.byPlanId(planId) : null;
    const run = owner ? { ok: true, ...owner } : resolveRun(projectId);
    if (!run.ok) return run;
    const view = run.controller.view();
    return typeof planId === 'string' && view && view.id === planId ? run : refuse('noPlan');
  }

  /** {projectId, planId, ...} payloads (launch, retry, unschedule, finish, abortFinalize). */
  const runForPayload = (payload) =>
    isPlainObject(payload) ? runForPlan(scopeOf(payload), payload.planId) : refuse('badPayload');

  const changed = (projectId, view) => ctx.send('orchestra:changed', { projectId, view });

  // God Mode v2 planner (slice 3). The renderer names a tab at most; the
  // project, repo folder, profile and to-do list are all resolved here. The
  // planner runs on the cloud default like /ask (ask:query's reasoning): a
  // tab's local-model profile must not silently plan the whole run.
  ipcMain.handle('orchestra:plan', async (_event, sessionId, todoAts) => {
    // The picker's selection: to-do `at` values only, capped like the list
    // itself. No selection (null) = every open to-do; an off-shape one fails
    // closed ([] -> 'noneSelected'). makePlan re-checks each value against
    // the list it reads.
    // The length is capped before anything walks the array: a renderer that
    // sends millions of entries must not stall main building a Set.
    let picked = null;
    if (todoAts != null) {
      const fits = Array.isArray(todoAts) && todoAts.length <= ctx.maxTodoItems;
      const unique = fits ? [...new Set(todoAts)] : [];
      picked = unique.every(Number.isFinite) ? unique : [];
    }
    // No tab id = the active tab; an id that no longer resolves (the tab
    // closed) is refused rather than planning in whatever tab is on screen.
    const session = ctx.resolveSession(sessionId);
    if (!session) return refuse('noTab');
    const projectId = keyOf(session.projectId);
    // Never God Mode and Luna's Work on the same project at once.
    const blocked = ctx.godModeBlock(projectId);
    if (blocked) return blocked;
    // A missing cwd makes execFile fail with ENOENT, which would read as
    // "claude not found" - check the folder first and say what is wrong.
    const repoPath = ctx.repoFor(session);
    if (!repoPath) return refuse('noRepo');
    const res = await registry.ensure(projectId).makePlan({
      projectId: session.projectId,
      repoPath,
      profileId: session.profileId,
      env: ctx.toolEnv(),
      todoAts: picked,
    });
    if (res.ok) changed(projectId, res.plan);
    return res;
  });

  ipcMain.handle('orchestra:list', () => {
    const projects = ctx.projects();
    return registry.views().map((entry) => runSummary(entry, projects));
  });

  ipcMain.handle('orchestra:get', (_event, opts) => {
    const run = resolveRun(projectIdOf(opts));
    return run.ok ? run.controller.view() : null;
  });
  // A planning wait for the usage-limit reset: replay its state, or cancel it.
  ipcMain.handle('orchestra:planWait', (_event, opts) => {
    const run = resolveRun(projectIdOf(opts));
    return run.ok ? run.controller.planWait() : null;
  });
  ipcMain.handle('orchestra:cancelPlanWait', (_event, opts) => {
    const run = resolveRun(projectIdOf(opts));
    return run.ok ? run.controller.cancelPlanWait() : run;
  });

  // Approve / Launch. orchestra.launch() validates the rest of the payload:
  // only ids of the plan's own packages and capped prompt strings get through.
  ipcMain.handle('orchestra:launch', async (_event, payload) => {
    const run = runForPayload(payload);
    if (!run.ok) return run;
    const blocked = ctx.godModeBlock(run.projectId);
    if (blocked) return blocked;
    const res = await run.controller.launch(payload);
    if (res.ok) {
      ctx.playCue('sfx.terminalNew');
      changed(run.projectId, res.plan);
    }
    return res;
  });

  // Discard is refused while a worker still runs (kill the run first).
  // Discard / Retry / Finish are also refused while Luna's Work runs on the
  // plan's project; Kill always works.
  ipcMain.handle('orchestra:discard', (_event, opts) => {
    const run = resolveRun(projectIdOf(opts));
    if (!run.ok) return run;
    return ctx.godModeBlock(run.projectId) || run.controller.discard();
  });

  // Slice 4. Retry: {planId, id} - validated in orchestra.retry(). Kill: the
  // shown run only; Ctrl+Shift+K kills every run (registry.killAll).
  ipcMain.handle('orchestra:retry', (_event, payload) => {
    const run = runForPayload(payload);
    if (!run.ok) return run;
    return ctx.godModeBlock(run.projectId) || run.controller.retry(payload);
  });
  // Resume after a 'noNodeModules' hold: {planId}. Main checks node_modules
  // again itself; the renderer can only ask.
  ipcMain.handle('orchestra:resume', (_event, payload) => {
    const run = runForPayload(payload);
    if (!run.ok) return run;
    return ctx.godModeBlock(run.projectId) || run.controller.resumeRun(payload);
  });
  ipcMain.handle('orchestra:kill', (_event, opts) => {
    const run = resolveRun(projectIdOf(opts));
    return run.ok ? run.controller.kill() : false;
  });

  // Second pass + slice 5: cancel a scheduled start; finish a run by hand
  // (integrate + clean up + report). Both validated in orchestra.js.
  ipcMain.handle('orchestra:unschedule', (_event, payload) => {
    const run = runForPayload(payload);
    return run.ok ? run.controller.unschedule(payload) : run;
  });
  ipcMain.handle('orchestra:finish', (_event, payload) => {
    const run = runForPayload(payload);
    if (!run.ok) return run;
    return ctx.godModeBlock(run.projectId) || run.controller.finishRun(payload);
  });

  // "Abort finish": {projectId?, planId} and nothing else is read. The run is
  // resolved and its plan id cross-checked here; the controller then aborts
  // only its own in-flight finalize, and only past ABORT_FINISH_AFTER_MS.
  ipcMain.handle('orchestra:abortFinalize', (_event, payload) => {
    if (!isPlainObject(payload) || typeof payload.planId !== 'string' || !payload.planId) return refuse('badPayload');
    const run = runForPayload(payload);
    if (!run.ok) return run;
    const res = run.controller.abortFinalize({ planId: payload.planId });
    if (res && res.ok) changed(run.projectId, run.controller.view());
    return res;
  });

  // Sleep / shutdown countdowns: only the two known names are accepted, and
  // the renderer can only ever cancel - never start one.
  ipcMain.handle('orchestra:cancel-power', (_event, what, opts) => {
    const run = resolveRun(projectIdOf(opts));
    if (!run.ok) return run;
    if (what === 'sleep') return run.controller.cancelSleep();
    if (what === 'shutdown') return run.controller.cancelShutdown();
    return refuse('badPower');
  });
  ipcMain.handle('orchestra:check-wake', (_event, opts) => {
    const run = resolveRun(projectIdOf(opts));
    return run.ok ? run.controller.checkWake() : { ok: false, reason: 'noRun' };
  });
  // Live run options: a plain object of known boolean flags, checked here -
  // the renderer is untrusted.
  ipcMain.handle('orchestra:set-options', (_event, patch, opts) => {
    const run = resolveRun(projectIdOf(opts));
    if (!run.ok) return run;
    return isOptionsPatch(patch) ? run.controller.setOptions(patch) : refuse('badOptions');
  });

  // The URL comes from the plan (gh's own output, shape-checked), never from
  // the page.
  ipcMain.on('orchestra:openPr', (_event, id, opts) => {
    const run = resolveRun(projectIdOf(opts));
    const view = run.ok ? run.controller.view() : null;
    const pkg = view && typeof id === 'string' ? view.packages.find((p) => p.id === id) : null;
    if (pkg && typeof pkg.prUrl === 'string' && PR_URL_RE.test(pkg.prUrl)) ctx.openExternal(pkg.prUrl);
  });

  // "Open report": only the run id crosses, and it must be the run's own
  // plan; the path is built here (<userDir>/runs/<id>.md) and must be a
  // plain file.
  ipcMain.handle('orchestra:openReport', async (_event, planId, opts) => {
    const file = reportFileFor(ctx.runsDir(), planId);
    if (!file) return refuse('badId');
    const run = runForPlan(projectIdOf(opts), planId);
    if (!run.ok) return run;
    try {
      if (!fs.lstatSync(file).isFile()) return refuse('noReport');
    } catch {
      return refuse('noReport');
    }
    const err = await ctx.openPath(file);
    return err ? refuse('openFailed') : { ok: true };
  });

  // Idea #5: allow a tool for FUTURE workers. Only a rule the run actually
  // logged from a stalled prompt is accepted - the renderer cannot add an
  // arbitrary one.
  ipcMain.handle('orchestra:allow', (_event, rule, opts) => {
    const run = resolveRun(projectIdOf(opts));
    if (!run.ok) return run;
    const view = run.controller.view();
    if (!isAllowRule(rule) || !view || !view.suggestions.some((s) => s.rule === rule)) return refuse('badRule');
    const prefs = ctx.readUiPrefs();
    const list = [...new Set([...(prefs.orchestraAllowedTools || []), rule])];
    ctx.writeUiPrefs({ orchestraAllowedTools: list });
    return { ok: true, allowed: ctx.readUiPrefs().orchestraAllowedTools };
  });

  return { resolveRun, runForPlan };
}

module.exports = { registerOrchestraIpc, runSummary, MAX_PROJECT_ID_CHARS };
