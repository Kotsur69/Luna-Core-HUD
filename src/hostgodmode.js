// ============================================================================
// LunaCore - the phone's signed God Mode commands (main, HUD host mode)
// ----------------------------------------------------------------------------
// Phone God Mode A. Handlers for src/hostcommands.js, which runs one only
// after src/hostauth.js verified the grant and the Face ID signature. Live
// only when host mode runs INSIDE the full HUD (src/hostswitch.js): a
// headless `--host` (src/hostmain.js) has no orchestra and answers every
// godmode.* kind with needsHudHandlers() -> {status:'refused', error:'needsHud'}.
//
//   godmode.plan     {projectId, todoAts?}  a NEW HUD tab in the project's
//                    folder, then the same plan path as orchestra:plan
//                    (src/orchestraPlanStart.js). Answers {status:'planning'}
//                    at once; planReady / planFailed go out as a push and the
//                    plan lands in the `godmode` snapshot (plans()).
//   godmode.launch   {projectId, planId, ids?, integration?, free?, releaseAfter?}
//                    controller.launch(). For a merge the signed command IS
//                    the confirmation: {mergeConfirmed: true} is passed on this
//                    path only, never from a payload.
//   godmode.kill     {projectId}  stop the run (always allowed, like the HUD)
//   godmode.retry    {projectId}  every failed + stalled package
//   godmode.finish   {projectId}  integrate, clean up, report
//   godmode.discard  {projectId}  drop a plan with no worker running
//
// The payload is untrusted even when signed: only the fields above are read,
// each one checked; a project must be on this host's own list with a repo
// folder. Results carry statuses, counts and ids, never paths. Refusals reuse
// the HUD's reasons (lunasWorkActive, noRepo, busy, noPlan, ...).
//
// launch / retry / finish can run for minutes (worktrees, installs, the
// merge). The command loop runs one row at a time, so these answer as soon
// as the controller has either refused or started: {status:'launching'} etc.
// ============================================================================

'use strict';

const { todoSelection, planTarget, runPlan } = require('./orchestraPlanStart');
const { INTEGRATION_MODES } = require('./orchestraSupervisor');

const KINDS = ['godmode.plan', 'godmode.launch', 'godmode.kill', 'godmode.retry', 'godmode.finish', 'godmode.discard'];
const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
/** orchestra.js plan ids: 'p' + a base-36 millisecond stamp. */
const PLAN_ID_RE = /^p[a-z0-9]{1,20}$/;
const PKG_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ERROR_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
/** Package ids one launch may name (a plan holds far fewer). */
const MAX_IDS = 50;
/** Picked to-do titles kept for the snapshot. */
const MAX_TITLES = 20;
const MAX_TITLE = 200;
const RETRY_STATES = new Set(['failed', 'stalled']);

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const refused = (error) => ({ status: 'refused', error });
/** A controller / helper refusal ({ok:false, error}) -> the host's result shape. */
const refusedFrom = (res) => refused(res && typeof res.error === 'string' && ERROR_RE.test(res.error) ? res.error : 'failed');
const errText = (err) => String(err instanceof Error ? err.message : err).slice(0, 300);
/** The last segment of a path, on either separator: the repo's folder name. */
const baseName = (p) => (typeof p === 'string' ? p.split(/[\\/]+/).filter(Boolean).pop() || '' : '');

/** What a headless `--host` answers every godmode.* kind with. */
function needsHudHandlers() {
  return Object.fromEntries(KINDS.map((kind) => [kind, async () => refused('needsHud')]));
}

const PENDING = Symbol('pending');

/**
 * The controller's answer if it is already there (a refusal comes back
 * before any real wait), else PENDING: the work has started and goes on.
 */
function settledOrPending(promise) {
  return Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve(PENDING)))]);
}

/**
 * @param {{
 *   registry: object,                    orchestraRegistry: ensure / get
 *   projects: () => object[],            the HUD's project list [{id, label, path}]
 *   repoFor: (session: object) => string|null,
 *   godModeBlock: (projectId: string|null) => object|null,
 *   toolEnv: () => object,
 *   send: (channel: string, payload: unknown) => void,
 *   maxTodoItems: number,
 *   openTab: (projectId: string) => object|null,   a new HUD tab (createSession)
 *   readTodos: (projectId: string) => object[],
 *   onChange?: () => void,               plans() changed: re-publish the snapshot
 *   log?: (line: string) => void,
 *   seq?: () => string,                  request ids (tests)
 * }} deps
 */
function createHostGodmode(deps) {
  const log = deps.log || ((line) => console.error(line));
  const onChange = deps.onChange || (() => {});
  let counter = 0;
  const seq = deps.seq || (() => `${Date.now().toString(36)}${(counter++).toString(36)}`);
  /** projectId -> a phone plan request still planning, or one that failed. */
  const tracked = new Map();
  /** Set while HUD host mode runs (attach()): planReady / planFailed pushes. */
  let notify = null;

  const ctx = {
    registry: deps.registry,
    repoFor: deps.repoFor,
    godModeBlock: deps.godModeBlock,
    toolEnv: deps.toolEnv,
    send: deps.send,
  };

  /** A payload's projectId -> the project on this host, or a refusal. */
  function projectOf(payload) {
    if (!isObject(payload)) return { error: 'badPayload' };
    const id = payload.projectId;
    if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) return { error: 'badProject' };
    const project = deps.projects().find((p) => p && p.id === id);
    return project ? { project } : { error: 'unknownProject' };
  }

  /** The project's run and its plan, or a refusal. */
  function runOf(payload) {
    const { project, error } = projectOf(payload);
    if (error) return { error };
    const controller = deps.registry.get(project.id);
    const view = controller ? controller.view() : null;
    return view ? { project, controller, view } : { error: 'noPlan' };
  }

  function push(kind, entry) {
    if (!notify) return;
    try {
      notify(kind, { key: `plan:${entry.requestId}`, repo: entry.repoName });
    } catch (err) {
      log(`[hostgodmode] ${kind} push failed: ${errText(err)}`);
    }
  }

  /** The picked open to-dos' titles, for the snapshot while planning. */
  function todoTitles(projectId, picked) {
    let list = [];
    try {
      list = deps.readTodos(projectId);
    } catch (err) {
      log(`[hostgodmode] to-dos unreadable: ${errText(err)}`);
    }
    return (Array.isArray(list) ? list : [])
      .filter((t) => isObject(t) && !t.done && t.manual !== true && (picked === null || picked.includes(t.at)))
      .slice(0, MAX_TITLES)
      .map((t) => String(t.text || '').slice(0, MAX_TITLE));
  }

  /** makePlan's answer for a phone request: ready, failed, or still waiting for a limit reset. */
  function settle(projectId, entry, res) {
    if (tracked.get(projectId) !== entry) return; // a newer request or a discard took over
    if (res && res.ok) {
      tracked.delete(projectId);
      const view = res.plan;
      push(view && Array.isArray(view.errors) && view.errors.length ? 'planFailed' : 'planReady', entry);
    } else if (res && res.error === 'waiting') {
      // The plan waits for the usage-limit reset and replans on its own:
      // plans() notices the new plan (or a failed replan) later.
      tracked.set(projectId, { ...entry, waiting: true });
    } else {
      tracked.set(projectId, { ...entry, state: 'failed', errors: [refusedFrom(res).error] });
      push('planFailed', entry);
    }
    onChange();
  }

  async function plan(payload) {
    const { project, error } = projectOf(payload);
    if (error) return refused(error);
    const sel = todoSelection(payload.todoAts, deps.maxTodoItems);
    if (!sel.valid) return refused('badTodos');
    // An empty pick can only end in 'noneSelected': refuse it before a tab opens.
    if (sel.picked && !sel.picked.length) return refused('noneSelected');
    // Every refusal is checked before a tab opens: a refused command leaves no tab.
    const pre = planTarget(ctx, { projectId: project.id });
    if (!pre.ok) return refusedFrom(pre);
    const controller = deps.registry.get(project.id);
    const own = tracked.get(project.id);
    if ((own && own.state === 'planning') || (controller && (controller.isBusy() || controller.isRunning()))) return refused('busy');
    const session = deps.openTab(project.id);
    if (!session) return refused('noTab');
    const target = planTarget(ctx, session);
    if (!target.ok) return refusedFrom(target);
    const before = controller ? controller.view() : null;
    const entry = {
      requestId: seq(),
      state: 'planning',
      waiting: false,
      repoName: baseName(target.repoPath),
      prevPlanId: before ? before.id : null,
      todos: todoTitles(project.id, sel.picked),
      errors: [],
    };
    tracked.set(project.id, entry);
    onChange();
    runPlan(ctx, session, target, { picked: sel.picked }).then(
      (res) => settle(project.id, entry, res),
      (err) => {
        log(`[hostgodmode] planning failed: ${errText(err)}`);
        settle(project.id, entry, { ok: false, error: 'planFailed' });
      },
    );
    return { status: 'planning', projectId: project.id };
  }

  /** godmode.launch's fields, each checked; anything else in the payload is ignored. */
  function launchPayload(payload, view) {
    if (typeof payload.planId !== 'string' || !PLAN_ID_RE.test(payload.planId)) return { error: 'badPlan' };
    if (payload.planId !== view.id) return { error: 'noPlan' };
    const out = { planId: view.id };
    if (payload.ids !== undefined && payload.ids !== null) {
      const ids = payload.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS) return { error: 'badIds' };
      const own = new Set(view.packages.map((p) => p.id));
      if (!ids.every((id) => typeof id === 'string' && PKG_ID_RE.test(id) && own.has(id))) return { error: 'badIds' };
      out.ids = [...new Set(ids)];
    }
    if (payload.integration !== undefined && payload.integration !== null) {
      if (!INTEGRATION_MODES.includes(payload.integration)) return { error: 'badIntegration' };
      out.integration = payload.integration;
    }
    for (const flag of ['free', 'releaseAfter']) {
      if (payload[flag] === undefined) continue;
      if (typeof payload[flag] !== 'boolean') return { error: 'badPayload' };
      out[flag] = payload[flag];
    }
    return { payload: out };
  }

  async function launch(payload) {
    const run = runOf(payload);
    if (run.error) return refused(run.error);
    const clean = launchPayload(payload, run.view);
    if (clean.error) return refused(clean.error);
    const blocked = deps.godModeBlock(run.project.id);
    if (blocked) return refusedFrom(blocked);
    const work = run.controller.launch(clean.payload, { mergeConfirmed: true });
    const res = await settledOrPending(work);
    if (res === PENDING) {
      work.then(
        (r) => {
          if (r && r.ok) deps.send('orchestra:changed', { projectId: run.project.id, view: r.plan });
          else log(`[hostgodmode] launch refused late: ${refusedFrom(r).error}`);
        },
        (err) => log(`[hostgodmode] launch failed: ${errText(err)}`),
      );
      return { status: 'launching', projectId: run.project.id, planId: run.view.id };
    }
    if (!res || !res.ok) return refusedFrom(res);
    deps.send('orchestra:changed', { projectId: run.project.id, view: res.plan });
    return { status: 'launched', projectId: run.project.id, planId: run.view.id };
  }

  // Kill always works, Luna's Work or not - same as the HUD's Kill.
  async function kill(payload) {
    const run = runOf(payload);
    if (run.error) return refused(run.error);
    return run.controller.kill() ? { status: 'killed', projectId: run.project.id } : refused('noRun');
  }

  async function retry(payload) {
    const run = runOf(payload);
    if (run.error) return refused(run.error);
    const blocked = deps.godModeBlock(run.project.id);
    if (blocked) return refusedFrom(blocked);
    const ids = run.view.packages.filter((p) => RETRY_STATES.has(p.state)).map((p) => p.id);
    if (!ids.length) return refused('nothingToRetry');
    let retried = 0;
    let failed = 0;
    let pending = 0;
    let firstError = null;
    // One at a time: each retry may reopen a tab or reinstall in its worktree.
    for (const id of ids) {
      const work = run.controller.retry({ planId: run.view.id, id });
      const res = await settledOrPending(work);
      if (res === PENDING) {
        pending += 1;
        work.then(
          (r) => r && !r.ok && log(`[hostgodmode] retry ${id} refused late: ${refusedFrom(r).error}`),
          (err) => log(`[hostgodmode] retry ${id} failed: ${errText(err)}`),
        );
        // A long retry holds the controller busy: the rest would be refused.
        break;
      }
      if (res && res.ok) {
        retried += 1;
      } else {
        failed += 1;
        firstError = firstError || refusedFrom(res).error;
      }
    }
    if (!retried && !pending) return { ...refused(firstError || 'failed'), failed };
    return { status: 'retried', projectId: run.project.id, retried, pending, failed, skipped: ids.length - retried - pending - failed };
  }

  async function finish(payload) {
    const run = runOf(payload);
    if (run.error) return refused(run.error);
    const blocked = deps.godModeBlock(run.project.id);
    if (blocked) return refusedFrom(blocked);
    // No integration override from the phone: the run's own mode, no dialog.
    const work = run.controller.finishRun({ planId: run.view.id });
    const res = await settledOrPending(work);
    if (res === PENDING) {
      work.then(
        (r) => r && !r.ok && log(`[hostgodmode] finish refused late: ${refusedFrom(r).error}`),
        (err) => log(`[hostgodmode] finish failed: ${errText(err)}`),
      );
      return { status: 'finishing', projectId: run.project.id };
    }
    return res && res.ok ? { status: 'finished', projectId: run.project.id } : refusedFrom(res);
  }

  async function discard(payload) {
    const { project, error } = projectOf(payload);
    if (error) return refused(error);
    const blocked = deps.godModeBlock(project.id);
    if (blocked) return refusedFrom(blocked);
    const own = tracked.get(project.id);
    const controller = deps.registry.get(project.id);
    if (!controller || !controller.view()) {
      // A failed phone plan has no controller plan: discarding clears it.
      if (own && own.state === 'failed') {
        tracked.delete(project.id);
        onChange();
        return { status: 'discarded', projectId: project.id };
      }
      return refused('noPlan');
    }
    const res = controller.discard();
    if (!res || !res.ok) return refusedFrom(res);
    if (own && own.state !== 'planning') tracked.delete(project.id);
    onChange();
    return { status: 'discarded', projectId: project.id };
  }

  /** A not-started plan view -> the snapshot's plan entry. */
  function readyEntry(projectId, view, repoName) {
    const errors = Array.isArray(view.errors) ? view.errors.map(String) : [];
    const todos = [...new Set(view.packages.flatMap((p) => (Array.isArray(p.todos) ? p.todos : [])))];
    return {
      planId: view.id,
      projectId,
      repoName,
      state: errors.length ? 'failed' : 'ready',
      errors,
      packages: view.packages.map((p) => ({ id: p.id, title: p.title, deps: p.dependsOn, model: p.model })),
      todos,
    };
  }

  /** A phone request still marked planning: has its plan (or its failure) landed meanwhile? */
  function follow(projectId, entry, controller) {
    const view = controller ? controller.view() : null;
    if (view && view.id !== entry.prevPlanId && !view.started) {
      tracked.delete(projectId);
      push(Array.isArray(view.errors) && view.errors.length ? 'planFailed' : 'planReady', entry);
      return null;
    }
    // A limit wait that ended without a plan (cancelled, or the replan failed).
    if (entry.waiting && controller && !controller.planWait() && !controller.isBusy()) {
      const failed = { ...entry, state: 'failed', errors: ['planFailed'] };
      tracked.set(projectId, failed);
      push('planFailed', entry);
      return failed;
    }
    return entry;
  }

  /**
   * Every project's current plan for the `godmode` snapshot: a phone request
   * planning or failed, else a plan made but not started yet.
   */
  function plans() {
    const out = [];
    for (const project of deps.projects()) {
      if (!project || typeof project.id !== 'string') continue;
      const controller = deps.registry.get(project.id);
      let entry = tracked.get(project.id) || null;
      if (entry && entry.state === 'planning') entry = follow(project.id, entry, controller);
      if (entry) {
        out.push({ planId: null, projectId: project.id, repoName: entry.repoName, state: entry.state, errors: entry.errors, packages: [], todos: entry.todos });
        continue;
      }
      const view = controller ? controller.view() : null;
      if (view && !view.started && !view.killed && Array.isArray(view.packages)) {
        out.push(readyEntry(project.id, view, baseName(project.path)));
      }
    }
    return out;
  }

  /**
   * A throw inside a handler (a tab that failed to open, a controller error)
   * is logged here and answered as a plain refusal: hostcommands.js would
   * otherwise put the raw message - possibly holding a local path - into the
   * row's result.
   */
  const safe = (kind, fn) => async (payload) => {
    try {
      return await fn(payload);
    } catch (err) {
      log(`[hostgodmode] ${kind} failed: ${errText(err)}`);
      return refused('failed');
    }
  };

  const handlers = {
    'godmode.plan': safe('godmode.plan', plan),
    'godmode.launch': safe('godmode.launch', launch),
    'godmode.kill': safe('godmode.kill', kill),
    'godmode.retry': safe('godmode.retry', retry),
    'godmode.finish': safe('godmode.finish', finish),
    'godmode.discard': safe('godmode.discard', discard),
  };

  return {
    handlers,
    plans,
    /** HUD host mode started: planReady / planFailed go out through `fn`. Returns the detach. */
    attach(fn) {
      notify = typeof fn === 'function' ? fn : null;
      return () => {
        notify = null;
      };
    },
  };
}

module.exports = { createHostGodmode, needsHudHandlers, KINDS };
