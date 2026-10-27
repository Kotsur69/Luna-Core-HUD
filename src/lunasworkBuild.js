// ============================================================================
// LunaCore - Luna's Work builder: one iteration's build as a God Mode run
// ----------------------------------------------------------------------------
// The controller's `build` dep (src/lunaswork.js). It drives God Mode only
// through its public API and the two additive hooks of makePlan:
//
//   makePlan({..., cards, onRunSettled})   Hook A: plan exactly the Director's
//                                          cards; Hook B: resolve when the run
//                                          settles, with the merge result
//   launch({planId, integration:'merge'})  merge to the base branch
//   finishRun({planId, integration})       after a restart mid-build: merge
//                                          what the restored plan pushed
//
// While a Luna's Work build is going, main.js routes three God Mode deps
// through here, and ONLY then (idle = God Mode's own values, untouched):
//
//   workerSettings(base)  model 'plan' (each package runs on the model the
//                         controller chose for its cards), integration
//                         'merge', and the project profile's checkCommand
//                         for the self-check gate - God Mode's own 'Final
//                         check command' when the profile has none
//   wrapPlanner(fn)       each planned package gets the strongest model of
//                         its cards (God Mode's stall escalation still applies),
//                         and ALL scene / prefab work goes to the one scene
//                         worker package (src/lunasworkScene.js, LW 3.36b)
//   ownsMerge()           the merge confirmation was given when Mati started
//                         the Luna's Work run (a native dialog in main)
//
// A Unity project (LW 3.36b) also gets UnityYAMLMerge as its merge driver
// before each build, and makePlan an ownership map giving every scene and
// prefab to the scene worker (LW 2.12's guard enforces it once merged).
//
// The self-check gate itself stays God Mode's (orchestraSelfCheck.js): red
// after the one fix-up try = luna/<slug>-integration is pushed, never the base.
// ============================================================================

'use strict';

const scene = require('./lunasworkScene');

const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 };
// God Mode workers run on these (orchestraPlan.js MODELS).
const WORKER_MODELS = ['sonnet', 'opus'];
const BUSY_ERRORS = new Set(['busy', 'runActive']);
const NOTHING_TO_BUILD = new Set(['noTodos', 'noneSelected']);
const CARD_FIELDS = ['text', 'details', 'files', 'size', 'acceptance', 'verify', 'model'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A planned package's model: the strongest model any of its cards got, as a
 * God Mode worker model. No known card = the planner's own pick.
 * @param {number[]} todoAts
 * @param {Map<number,string>} cardModels
 * @param {string|null} fallback
 * @returns {string|null}
 */
function packageModel(todoAts, cardModels, fallback) {
  let best = null;
  for (const at of Array.isArray(todoAts) ? todoAts : []) {
    const m = cardModels.get(at);
    if (m in MODEL_RANK && (best === null || MODEL_RANK[m] > MODEL_RANK[best])) best = m;
  }
  if (best === null) return fallback;
  return WORKER_MODELS.includes(best) ? best : 'sonnet';
}

/** The card object handed to makePlan's Hook A: its `at` plus the fields the planner reads. */
function planCard(card) {
  const out = { at: card.at };
  for (const key of CARD_FIELDS) if (card[key] !== undefined) out[key] = card[key];
  return out;
}

/**
 * @param {{orchestra:{makePlan:Function, launch:Function, cancelPlanWait:Function,
 *   view?:Function, planWait?:Function, finishRun?:Function},
 *   profileId:()=>string|null, env:()=>object, freeEnv?:()=>object|null,
 *   log?:(line:string)=>void, isUnityProject?:(repoPath:string)=>boolean,
 *   configureUnityMerge?:(repoPath:string)=>Promise<object>}} deps
 *   isUnityProject / configureUnityMerge: lunasworkScene's, injectable for tests
 */
function createGodModeBuilder(deps) {
  const log = deps.log || (() => {});
  const isUnityProject = deps.isUnityProject || scene.isUnityProject;
  const configureUnityMerge = deps.configureUnityMerge || scene.configureUnityMerge;
  /** @type {null|{projectId:string, checkCommand:string, models:Map<number,string>, cards:object[], planId:string|null, settle:Function}} */
  let active = null;

  /** LW 3.36b: UnityYAMLMerge for every worktree; a failure is logged, the build goes on. */
  async function prepareUnity(repoPath) {
    try {
      const res = await configureUnityMerge(repoPath);
      if (!res || !res.ok) log(`[lunaswork-build] UnityYAMLMerge not configured: ${(res && (res.detail || res.error)) || 'failed'}`);
      else if (res.warning) log(`[lunaswork-build] ${res.warning}`);
    } catch (err) {
      log(`[lunaswork-build] UnityYAMLMerge not configured: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The build plan God Mode restored after LunaCore restarted mid-build, when
   * some of its packages were pushed but not merged yet. Their cards are
   * ticked already, so a fresh plan would leave that work off main for good.
   */
  function interruptedPlan(opts) {
    if (!opts.resumePlanId || typeof deps.orchestra.view !== 'function') return null;
    const view = deps.orchestra.view();
    if (!isObj(view) || view.id !== opts.resumePlanId || view.projectId !== opts.projectId) return null;
    if (view.settled || view.killed) return null;
    const packages = Array.isArray(view.packages) ? view.packages : [];
    return packages.some((p) => isObj(p) && p.state === 'pushed' && !p.merged) ? view : null;
  }

  /**
   * God Mode holds one plan for the whole app. A plan this run did not make
   * that is still open (held, running, or waiting for a usage reset) belongs
   * to Mati - makePlan would silently replace it, so the build waits instead.
   */
  function foreignPlanOpen(opts) {
    const own = new Set(Array.isArray(opts.ownPlanIds) ? opts.ownPlanIds : []);
    const view = typeof deps.orchestra.view === 'function' ? deps.orchestra.view() : null;
    const wait = typeof deps.orchestra.planWait === 'function' ? deps.orchestra.planWait() : null;
    const openPlan = isObj(view) && !view.settled && !view.killed && !own.has(view.id);
    const waiting = isObj(wait) && wait.state !== 'failed';
    return openPlan || waiting;
  }

  /** Merges what the interrupted run pushed (self-check gate included); open cards wait for the next iteration. */
  async function finishInterrupted(view) {
    active.planId = view.id;
    const fin = await deps.orchestra.finishRun({ planId: view.id, integration: 'merge' });
    if (!isObj(fin) || !fin.ok) return { ok: false, error: (isObj(fin) && fin.error) || 'failed' };
    const plan = isObj(fin.plan) ? fin.plan : {};
    return { ok: true, resumed: true, planId: view.id, killed: false, integration: isObj(plan.integration) ? plan.integration : {}, plan };
  }

  /** Why makePlan did not give a plan, in the controller's terms. */
  function planFailure(made) {
    const error = (isObj(made) && made.error) || 'failed';
    if (error === 'waiting') {
      // The controller owns the WAIT: God Mode must not re-plan on its own.
      deps.orchestra.cancelPlanWait();
      const wait = isObj(made.planWait) ? made.planWait : {};
      return { ok: false, error: 'limit', resumeAt: Number.isFinite(wait.resumeAt) ? wait.resumeAt : null };
    }
    if (BUSY_ERRORS.has(error)) return { ok: false, error: 'godModeBusy' };
    // Every card got closed meanwhile: nothing to build, main untouched.
    if (NOTHING_TO_BUILD.has(error)) return { ok: true, integration: { state: 'idle' }, nothing: true };
    return { ok: false, error, ...(isObj(made) && made.detail ? { detail: made.detail } : {}) };
  }

  /**
   * One build: plan the cards, launch in merge mode, wait for the run to settle.
   * After a restart (resumePlanId = the plan this build made before) a
   * restored plan with pushed work is finished and merged instead.
   * @param {{projectId:string, repoPath:string, cards:object[], checkCommand:string, free?:boolean,
   *   resumePlanId?:string|null, ownPlanIds?:string[], onPlan?:(planId:string)=>void}} opts
   *   ownPlanIds: plans this run made (replaceable); onPlan: the plan id, once made
   * @returns {Promise<object>} the onRunSettled result {planId, killed, integration, plan} plus ok,
   *   or {ok:false, error} - 'limit' (with resumeAt), 'godModeBusy', or God Mode's own error
   */
  async function build(opts) {
    if (active) return { ok: false, error: 'godModeBusy' };
    const cards = Array.isArray(opts.cards) ? opts.cards.filter((c) => isObj(c) && Number.isFinite(c.at)) : [];
    let resolveSettled;
    const settled = new Promise((resolve) => {
      resolveSettled = resolve;
    });
    let done = false;
    const settle = (result) => {
      if (done) return;
      done = true;
      resolveSettled(result);
    };
    active = {
      projectId: opts.projectId,
      checkCommand: typeof opts.checkCommand === 'string' ? opts.checkCommand : '',
      models: new Map(cards.map((c) => [c.at, c.model])),
      cards,
      planId: null,
      settle,
    };
    try {
      const interrupted = interruptedPlan(opts);
      if (interrupted) return await finishInterrupted(interrupted);
      if (foreignPlanOpen(opts)) return { ok: false, error: 'godModeBusy' };
      const unity = isUnityProject(opts.repoPath);
      if (unity) await prepareUnity(opts.repoPath);
      const made = await deps.orchestra.makePlan({
        projectId: opts.projectId,
        repoPath: opts.repoPath,
        profileId: deps.profileId(),
        // A free build (Claude is limited) plans on the free providers too.
        env: (opts.free && typeof deps.freeEnv === 'function' && deps.freeEnv()) || deps.env(),
        cards: cards.map(planCard),
        onRunSettled: (result) => settle(result),
        // Only a Unity build carries the key: every other plan is made exactly as before.
        ...(unity ? { ownership: scene.sceneOwnership() } : {}),
      });
      if (!isObj(made) || !made.ok) return planFailure(made);
      active.planId = made.plan.id;
      if (typeof opts.onPlan === 'function') opts.onPlan(made.plan.id);
      if (Array.isArray(made.plan.errors) && made.plan.errors.length) return { ok: false, error: 'planErrors' };
      const launched = await deps.orchestra.launch({ planId: made.plan.id, integration: 'merge', ...(opts.free ? { free: true } : {}) });
      if (!isObj(launched) || !launched.ok) return { ok: false, error: (isObj(launched) && launched.error) || 'failed' };
      const result = await settled;
      const r = isObj(result) ? result : {};
      return { ...r, ok: r.killed !== true && r.ok !== false };
    } catch (err) {
      log(`[lunaswork-build] build failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'failed' };
    } finally {
      active = null;
    }
  }

  /**
   * God Mode's onChange view, forwarded by main: a kill or a discard of the
   * build's plan settles the build (onRunSettled never fires for those).
   */
  function onChange(view) {
    if (!active || !active.planId) return;
    if (!isObj(view) || view.id !== active.planId) {
      active.settle({ ok: false, error: 'discarded' });
      return;
    }
    // A kill does not stop a finalize that is merging: the overlays (check
    // command, merge confirmation) stay until it is done.
    const merging = isObj(view.integration) && view.integration.running === true;
    if (view.killed && !merging) active.settle({ planId: view.id, killed: true, integration: view.integration, plan: view });
  }

  /** God Mode's worker settings while a Luna's Work build runs; `base` untouched otherwise. */
  function workerSettings(base) {
    if (!active) return base;
    const b = isObj(base) ? base : {};
    return { ...b, model: 'plan', integration: 'merge', checkCommand: active.checkCommand || b.checkCommand };
  }

  /**
   * runPlanner for God Mode during a build: package models from the
   * controller's card choices, then every scene / prefab package folded into
   * the one scene worker (a plan without scene work is left as it was).
   */
  function wrapPlanner(runPlanner) {
    return async (args) => {
      const res = await runPlanner(args);
      if (!active || !isObj(res) || !res.ok || !isObj(res.raw) || !Array.isArray(res.raw.packages)) return res;
      const modelled = res.raw.packages.map((p) => (isObj(p) ? { ...p, model: packageModel(p.todoAts, active.models, p.model) } : p));
      const packages = scene.routeScenePackages(modelled, active.cards);
      return { ...res, raw: { ...res.raw, packages } };
    };
  }

  /**
   * Whether God Mode's merge confirmation for `view` (its current plan) was
   * given when Mati started the Luna's Work run: only for this build's own
   * plan on this build's project - never for any other plan.
   */
  function ownsMerge(view) {
    return !!active && !!active.planId && isObj(view) && view.id === active.planId && view.projectId === active.projectId;
  }

  return {
    build,
    onChange,
    workerSettings,
    wrapPlanner,
    ownsMerge,
    isBuilding: (projectId) => !!active && (projectId === undefined || active.projectId === projectId),
  };
}

module.exports = { createGodModeBuilder, packageModel, planCard };
