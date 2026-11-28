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
// An agy build (opts.agy: the Builder role is 'agy', or the agy fallback is
// on during a Claude usage limit) passes planner 'agy' and Workers 'agy' to
// makePlan / launch, in the agy profile's env (deps.agyEnv).
//
// Every other build runs its worker tabs on a real Claude profile
// (deps.claudeProfileId, see claudeProfileIdOf), never on the UI's active tab
// profile: that is only the default for new tabs, and with a tab switched to
// Antigravity a Claude build's workers ran on agy without bypassPermissions.
// No real Claude profile: the build is refused with 'noClaudeProfile'.
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
// Tool kit (src/lunasworkToolkit.js): workerTools(pkg) gives God Mode each
// package tab's kit - the scene worker and every asset-prep package
// (scene.isAssetPrepPackageOf: its files are only raw asset files) run as the
// `asset` role, every other package as `builder`, so a custom builder kit
// without Blender / ComfyUI / Higgsfield never strands asset generation - and
// wrapPlanner adds that same role's kit note (tools, skills, guardrails) to
// every package prompt. Tools past their spend cap
// (opts.cappedTools) are denied for the whole build.
//
// A Unity project (LW 3.36b) also gets UnityYAMLMerge as its merge driver
// before each build, and makePlan an ownership map giving every scene and
// prefab to the scene worker (LW 2.12's guard enforces it once merged).
//
// A Unity build (the profile's adapter is `unity`, or the repo is a Unity
// project) merges in a worktree no Unity editor has open: wrapPlanner tells
// the planner `verify` is always empty, and moves every verify a package
// still has into its prompt as a check (src/orchestraUnityVerify.js), worded
// for its role: with a scene worker in the plan only the scene worker runs
// editor checks; every other package leaves them for the live editor after
// the merge. The integration defers a verify that still fails only for want
// of an editor.
//
// The self-check gate itself stays God Mode's (orchestraSelfCheck.js): red
// after the one fix-up try = luna/<slug>-integration is pushed, never the base.
// workerSettings tells it a Unity build is running (`unityBuild`, and whether
// the check command is the profile's own), so God Mode's default `npm test`
// is not run there and a check red only for want of an editor is deferred.
// ============================================================================

'use strict';

const scene = require('./lunasworkScene');
const { MAX_PROMPT_CHARS } = require('./orchestraPlan');
const unityVerify = require('./orchestraUnityVerify');

// Between a package prompt and its tool kit note.
const KIT_NOTE_GAP = '\n\n';

const { MODEL_RANK, AGY_MODEL, isClaudeModel, strongerModel } = require('./claudeModels');
const { isAgyModel } = require('./workerModels');

// God Mode workers run on these (orchestraPlan.js PACKAGE_MODELS).
const WORKER_MODELS = ['sonnet', 'opus', 'fable'];
// repoBusy: another project's God Mode run holds this repo (orchestraRegistry.js).
const BUSY_ERRORS = new Set(['busy', 'runActive', 'repoBusy']);
const NOTHING_TO_BUILD = new Set(['noTodos', 'noneSelected']);
const CARD_FIELDS = ['text', 'details', 'files', 'size', 'acceptance', 'verify', 'model'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A planned package's model: the strongest model any of its cards got, as a
 * God Mode worker model (or the card's agy choice). No known card = the planner's own pick.
 * @param {number[]} todoAts
 * @param {Map<number,string>} cardModels
 * @param {string|null} fallback
 * @returns {string|null}
 */
function packageModel(todoAts, cardModels, fallback) {
  let best = null;
  let agy = null;
  for (const at of Array.isArray(todoAts) ? todoAts : []) {
    const m = cardModels.get(at);
    if (m in MODEL_RANK && (best === null || MODEL_RANK[m] > MODEL_RANK[best])) best = m;
    else if (agy === null && isAgyModel(m)) agy = m;
  }
  if (best !== null) return WORKER_MODELS.includes(best) ? best : 'sonnet';
  return agy || fallback;
}

/**
 * True for a profile that runs Anthropic's Claude Code against Anthropic:
 * its command is `claude` (any path, any .exe/.cmd suffix) and its env does
 * not redirect it to another provider (ANTHROPIC_BASE_URL: LM Studio, Z.ai).
 * @param {unknown} profile
 * @returns {boolean}
 */
function isRealClaudeProfile(profile) {
  if (!isObj(profile) || typeof profile.id !== 'string' || !profile.id) return false;
  const command = typeof profile.command === 'string' ? profile.command.trim() : '';
  const base = command.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  if (base !== 'claude') return false;
  const env = isObj(profile.env) ? profile.env : {};
  return !(typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL.trim());
}

/**
 * The profile a Claude build's worker tabs run on: the active tab profile
 * when it is a real Claude profile (e.g. a second-account profile Mati picked),
 * else the first real Claude profile. Null = none configured.
 * @param {object[]|null|undefined} profiles
 * @param {string|null|undefined} activeId
 * @returns {string|null}
 */
function claudeProfileIdOf(profiles, activeId) {
  const list = Array.isArray(profiles) ? profiles : [];
  const active = activeId ? list.find((p) => isObj(p) && p.id === activeId) : null;
  if (active && isRealClaudeProfile(active)) return active.id;
  const first = list.find(isRealClaudeProfile);
  return first ? first.id : null;
}

/**
 * The model God Mode's planner runs on for a build: the strongest model the
 * controller gave this build's cards (its builder setting, or `auto`'s pick
 * per card), so a run set to Haiku does not plan on Opus. Null (God Mode's
 * own default) when no card names a known model.
 * @param {object[]} cards
 * @returns {string|null}
 */
function plannerModelFor(cards) {
  return (Array.isArray(cards) ? cards : []).reduce((best, c) => strongerModel(best, isObj(c) ? c.model : null), null);
}

/** The card object handed to makePlan's Hook A: its `at` plus the fields the planner reads. */
function planCard(card) {
  const out = { at: card.at };
  for (const key of CARD_FIELDS) if (card[key] !== undefined) out[key] = card[key];
  return out;
}

/**
 * God Mode runs one plan per project (orchestraRegistry.js): view, planWait
 * and cancelPlanWait take the build's projectId; launch and finishRun find
 * the run by the planId in their payload.
 * @param {{orchestra:{makePlan:Function, launch:Function, cancelPlanWait:(projectId:string)=>unknown,
 *   view?:(projectId:string)=>object|null, planWait?:(projectId:string)=>object|null, finishRun?:Function},
 *   profileId:()=>string|null, env:()=>object, freeEnv?:()=>object|null, agyEnv?:()=>object|null,
 *   log?:(line:string)=>void, isUnityProject?:(repoPath:string)=>boolean,
 *   configureUnityMerge?:(repoPath:string)=>Promise<object>,
 *   toolsFor?:(req:{projectId:string, repoPath:string, role:string, capped:string[]})=>object|null}} deps
 *   isUnityProject / configureUnityMerge: lunasworkScene's, injectable for tests
 *   toolsFor: lunasworkToolkitLaunch.createToolsFor() - no kit without it
 */
function createGodModeBuilder(deps) {
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const isUnityProject = deps.isUnityProject || scene.isUnityProject;
  const configureUnityMerge = deps.configureUnityMerge || scene.configureUnityMerge;
  /** @type {null|{projectId:string, checkCommand:string, models:Map<number,string>, cards:object[], planId:string|null, settle:Function, unityVerify:boolean}} */
  let active = null;

  /** LW 3.36b: UnityYAMLMerge for every worktree; a failure is logged, the build goes on. */
  async function prepareUnity(repoPath) {
    try {
      const res = await configureUnityMerge(repoPath);
      if (res && res.legacyBlock === 'removed') log('[lunaswork-build] uncommitted UnityYAMLMerge block taken out of .gitattributes (now in .git/info/attributes)');
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
    const view = deps.orchestra.view(opts.projectId);
    if (!isObj(view) || view.id !== opts.resumePlanId || view.projectId !== opts.projectId) return null;
    if (view.settled || view.killed) return null;
    const packages = Array.isArray(view.packages) ? view.packages : [];
    return packages.some((p) => isObj(p) && p.state === 'pushed' && !p.merged) ? view : null;
  }

  /**
   * God Mode holds one plan per project. A plan on the build's project this
   * run did not make that is still open (held, running, or waiting for a
   * usage reset) belongs to Mati - makePlan would silently replace it, so the
   * build waits instead.
   */
  function foreignPlanOpen(opts) {
    const own = new Set(Array.isArray(opts.ownPlanIds) ? opts.ownPlanIds : []);
    const view = typeof deps.orchestra.view === 'function' ? deps.orchestra.view(opts.projectId) : null;
    const wait = typeof deps.orchestra.planWait === 'function' ? deps.orchestra.planWait(opts.projectId) : null;
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
      deps.orchestra.cancelPlanWait(active ? active.projectId : undefined);
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
   * agy: plan and work on the Antigravity CLI (planner and Workers 'agy', the
   * agy profile's env); refused with 'noAgyProfile' when there is no agy profile.
   * @param {{projectId:string, repoPath:string, cards:object[], checkCommand:string, free?:boolean, agy?:boolean,
   *   resumePlanId?:string|null, ownPlanIds?:string[], onPlan?:(planId:string)=>void, plannerModel?:string,
   *   cappedTools?:string[]|(()=>string[]), adapter?:string}} opts cappedTools: paid tools past the run's spend cap
   *   (a function is read again for every worker tab); adapter: the project profile's ('unity' = a Unity build)
   *   ownPlanIds: plans this run made (replaceable); onPlan: the plan id, once made;
   *   plannerModel: God Mode's planner model (default: the strongest model of the cards)
   * @returns {Promise<object>} the onRunSettled result {planId, killed, integration, plan} plus ok,
   *   or {ok:false, error} - 'limit' (with resumeAt), 'godModeBusy', 'noAgyProfile', 'noClaudeProfile', or God Mode's own error
   */
  async function build(opts) {
    if (active && active.parked) return resumeParked(opts);
    if (active) return { ok: false, error: 'godModeBusy' };
    const finished = takeParkedFinal(opts);
    if (finished) return finished;
    const cards = Array.isArray(opts.cards) ? opts.cards.filter((c) => isObj(c) && Number.isFinite(c.at)) : [];
    const ctx = {
      projectId: opts.projectId,
      repoPath: opts.repoPath,
      cappedTools: opts.cappedTools,
      checkCommand: typeof opts.checkCommand === 'string' ? opts.checkCommand : '',
      models: new Map(cards.map((c) => [c.at, c.model])),
      cards,
      planId: null,
      // Set once the build knows it is a Unity build (below).
      unityVerify: false,
      // The run's end (onRunSettled, a kill, a discard), once; see settleRun.
      final: undefined,
      wake: null,
      // Came back as a limit while its God Mode run waits for the reset.
      parked: false,
      // The last usage reset the whole run waited for (onChange), or null.
      sawLimit: null,
    };
    ctx.settle = (result) => settleRun(ctx, result);
    active = ctx;
    try {
      // No Unity editor is open where God Mode merges: the plan's verifies and
      // the self-check (also when finishing an interrupted plan) know it.
      const unity = isUnityProject(opts.repoPath);
      active.unityVerify = unity || opts.adapter === 'unity';
      const interrupted = interruptedPlan(opts);
      if (interrupted) return await finishInterrupted(interrupted);
      if (foreignPlanOpen(opts)) return { ok: false, error: 'godModeBusy' };
      // An agy build (Builder set to agy, or the agy fallback during a Claude
      // limit) plans and works on the Antigravity CLI, in the agy profile's env.
      // No agy profile: refused, never built on Claude instead.
      const agy = opts.agy === true;
      const agyEnv = agy && typeof deps.agyEnv === 'function' ? deps.agyEnv() : null;
      if (agy && !agyEnv) return { ok: false, error: 'noAgyProfile' };
      // A Claude build never inherits the UI's active tab profile (it may be agy).
      const profileId = agy || typeof deps.claudeProfileId !== 'function' ? deps.profileId() : deps.claudeProfileId();
      if (!agy && typeof deps.claudeProfileId === 'function' && !profileId) return { ok: false, error: 'noClaudeProfile' };
      if (unity) await prepareUnity(opts.repoPath);
      // A free or agy build does not plan on Claude: the Claude alias means nothing there.
      const plannerModel = opts.free || agy ? null : (isClaudeModel(opts.plannerModel) ? opts.plannerModel : plannerModelFor(cards));
      const made = await deps.orchestra.makePlan({
        projectId: opts.projectId,
        repoPath: opts.repoPath,
        profileId,
        // A free build (Claude is limited) plans on the free providers too.
        env: agyEnv || (opts.free && typeof deps.freeEnv === 'function' && deps.freeEnv()) || deps.env(),
        ...(agy ? { planner: AGY_MODEL, workers: AGY_MODEL } : {}),
        cards: cards.map(planCard),
        onRunSettled: (result) => ctx.settle(result),
        // God Mode allow-lists it again (orchestraPlan.plannerModelOf).
        ...(plannerModel ? { plannerModel } : {}),
        // Only a Unity build carries the key: every other plan is made exactly as before.
        ...(unity ? { ownership: scene.sceneOwnership() } : {}),
      });
      if (!isObj(made) || !made.ok) return planFailure(made);
      active.planId = made.plan.id;
      if (typeof opts.onPlan === 'function') opts.onPlan(made.plan.id);
      if (Array.isArray(made.plan.errors) && made.plan.errors.length) return { ok: false, error: 'planErrors' };
      const launched = await deps.orchestra.launch({
        planId: made.plan.id,
        integration: 'merge',
        ...(opts.free && !agy ? { free: true } : {}),
        // Approve fixes the agy profile for the run (orchestraAgy.approveAgyProfile).
        ...(agy ? { workers: AGY_MODEL } : {}),
      });
      if (!isObj(launched) || !launched.ok) return { ok: false, error: (isObj(launched) && launched.error) || 'failed' };
      return await awaitRun(ctx);
    } catch (err) {
      log(`[lunaswork-build] build failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: 'failed' };
    } finally {
      // A parked build keeps its overlays: its run still goes on after the reset.
      if (active === ctx && !ctx.parked) active = null;
    }
  }

  // ---- usage limit: the build comes back as a limit, its run waits ----------
  //
  // With every Claude account out, God Mode pauses the run until the reset and
  // resumes it on its own (orchestra.js pauseUntil). The build reports that as
  // {error:'limit', resumeAt}, so the controller knows it is limited
  // (lunaswork.js limited) instead of sitting silently in 'building'. The run
  // itself is left alone: the build stays `active` (parked, overlays and merge
  // confirmation kept) and the controller's next build takes it up again.

  /** A finished run of a parked build no build waited on: {projectId, planId, result}. */
  let parkedFinal = null;

  /** The build result of a settled run; limitedUntil = the run waited for a usage reset on the way. */
  function finalResult(result, sawLimit = null) {
    const r = isObj(result) ? result : {};
    return { ...r, ok: r.killed !== true && r.ok !== false, ...(Number.isFinite(sawLimit) ? { limitedUntil: sawLimit } : {}) };
  }

  /** When the whole run waits for a usage reset (orchestra view.waitingUntil), else null. */
  function limitUntilOf(view) {
    const at = isObj(view) ? view.waitingUntil : null;
    return Number.isFinite(at) && at > now() ? at : null;
  }

  function limitResult(ctx, until) {
    ctx.parked = true;
    log(`[lunaswork-build] plan ${ctx.planId}: every worker waits for the usage reset at ${new Date(until).toISOString()} - build reported as limited`);
    return { ok: false, error: 'limit', resumeAt: until, planId: ctx.planId };
  }

  /** The run of `ctx` ended: wakes the build waiting on it, or keeps the result for the next build. */
  function settleRun(ctx, result) {
    if (ctx.final !== undefined) return;
    ctx.final = result === undefined ? null : result;
    if (ctx.parked) {
      if (active === ctx) active = null;
      parkedFinal = { projectId: ctx.projectId, planId: ctx.planId, result: ctx.final, sawLimit: ctx.sawLimit };
      return;
    }
    wakeRun(ctx, { final: ctx.final });
  }

  function wakeRun(ctx, event) {
    const wake = ctx.wake;
    ctx.wake = null;
    if (wake) wake(event);
  }

  /** The run's end, or a usage-limit wait of the whole run (onChange), whichever comes first. */
  async function awaitRun(ctx) {
    const event = await new Promise((resolve) => {
      if (ctx.final !== undefined) resolve({ final: ctx.final });
      else ctx.wake = resolve;
    });
    if (event.final === undefined) return limitResult(ctx, event.limitUntil);
    return finalResult(event.final, ctx.sawLimit);
  }

  /**
   * The controller builds again after a limit: the parked run is taken up
   * where it is (still waiting = a limit again). Only the same project's
   * build resuming that plan may take it; any other build waits for it.
   */
  async function resumeParked(opts) {
    const ctx = active;
    const o = isObj(opts) ? opts : {};
    if (o.projectId !== ctx.projectId || o.resumePlanId !== ctx.planId) return { ok: false, error: 'godModeBusy' };
    const view = typeof deps.orchestra.view === 'function' ? deps.orchestra.view(ctx.projectId) : null;
    if (!isObj(view) || view.id !== ctx.planId) {
      settleRun(ctx, { ok: false, error: 'discarded' });
      return takeParkedFinal(o) || { ok: false, error: 'discarded' };
    }
    const until = limitUntilOf(view);
    if (until !== null) return limitResult(ctx, until);
    ctx.parked = false;
    if (o.cappedTools !== undefined) ctx.cappedTools = o.cappedTools;
    log(`[lunaswork-build] plan ${ctx.planId}: build taken up again after the usage limit`);
    try {
      return await awaitRun(ctx);
    } finally {
      if (active === ctx && !ctx.parked) active = null;
    }
  }

  /** The result a parked run settled with, for the build resuming exactly that plan; null otherwise. */
  function takeParkedFinal(opts) {
    if (!parkedFinal) return null;
    const kept = parkedFinal;
    parkedFinal = null;
    const o = isObj(opts) ? opts : {};
    if (o.projectId !== kept.projectId || o.resumePlanId !== kept.planId) return null;
    log(`[lunaswork-build] plan ${kept.planId}: finished while the build waited for the usage reset`);
    return finalResult(kept.result, kept.sawLimit);
  }

  /**
   * God Mode's onChange view, forwarded by main: a kill or a discard of the
   * build's plan settles the build (onRunSettled never fires for those).
   * `projectId` names the run that changed; another project's run is not
   * the build's, whatever its view says (a discard sends a null view).
   */
  function onChange(view, projectId) {
    if (!active || !active.planId) return;
    if (projectId !== undefined && projectId !== active.projectId) return;
    if (!isObj(view) || view.id !== active.planId) {
      active.settle({ ok: false, error: 'discarded' });
      return;
    }
    // A kill does not stop a finalize that is merging: the overlays (check
    // command, merge confirmation) stay until it is done.
    const merging = isObj(view.integration) && view.integration.running === true;
    if (view.killed && !merging) {
      active.settle({ planId: view.id, killed: true, integration: view.integration, plan: view });
      return;
    }
    // Every worker waits for a usage reset: the waiting build comes back as a limit.
    const until = merging ? null : limitUntilOf(view);
    if (until === null) return;
    active.sawLimit = until;
    if (active.wake) wakeRun(active, { limitUntil: until });
  }

  /** The paid tools past their cap right now: opts.cappedTools is a list, or a function read on every tab. */
  function cappedNow() {
    const src = active.cappedTools;
    const list = typeof src === 'function' ? src() : src;
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  }

  /** The scene worker and asset-prep packages make assets (`asset` kit); every other package builds. */
  function kitRole(pkg) {
    if (!isObj(pkg)) return 'builder';
    return pkg.id === scene.SCENE_WORKER_ID || scene.isAssetPrepPackageOf(pkg, active.cards) ? 'asset' : 'builder';
  }

  /** The kit of one package's role during a build; null when idle, without toolsFor or on a failure. */
  function kitOf(pkg) {
    if (!active || typeof deps.toolsFor !== 'function') return null;
    const role = kitRole(pkg);
    try {
      return deps.toolsFor({ projectId: active.projectId, repoPath: active.repoPath, role, capped: cappedNow() });
    } catch (err) {
      log(`[lunaswork-build] tool kit (${role}) not applied: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** God Mode's per-tab hook: the package's tool kit while a Luna's Work build runs. */
  function workerTools(pkg) {
    const kit = kitOf(pkg);
    return kit ? { allowedTools: kit.allowedTools, disallowedTools: kit.disallowedTools, mcpConfigPath: kit.mcpConfigPath, addDirs: kit.addDirs } : null;
  }

  /**
   * God Mode's worker settings while a Luna's Work build runs; `base` untouched
   * otherwise. A Unity build adds `unityBuild` for the self-check
   * (orchestraUnityVerify.selfCheckCommandOf); every other build has no such key.
   */
  function workerSettings(base) {
    if (!active) return base;
    const b = isObj(base) ? base : {};
    const unityBuild = active.unityVerify ? { unityBuild: { own: ownCheckCommand(b) } } : {};
    return { ...b, model: 'plan', integration: 'merge', checkCommand: active.checkCommand || b.checkCommand, ...unityBuild };
  }

  /**
   * Whether the build's check command is its profile's own: set, and not God
   * Mode's 'Final check command' (checkCommandFor in lunasworkRun.js falls
   * back to that one, so an equal command reads as God Mode's).
   */
  function ownCheckCommand(base) {
    const own = active.checkCommand.trim();
    return !!own && own !== (typeof base.checkCommand === 'string' ? base.checkCommand.trim() : '');
  }

  /**
   * runPlanner for God Mode during a build: package models from the
   * controller's card choices, then every scene / prefab package folded into
   * the one scene worker (a plan without scene work is left as it was). A
   * Unity build also plans with the Unity verify rules, and no package keeps
   * a verify: each one moves into its prompt as a check fit for its role.
   */
  function wrapPlanner(runPlanner) {
    return async (args) => {
      const unityRun = !!active && active.unityVerify === true;
      const res = await runPlanner(unityRun ? unityVerify.withUnityPlannerRules(args) : args);
      if (!active || !isObj(res) || !res.ok || !isObj(res.raw) || !Array.isArray(res.raw.packages)) return res;
      const modelled = res.raw.packages.map((p) => (isObj(p) ? { ...p, model: packageModel(p.todoAts, active.models, p.model) } : p));
      const routed = scene.routeScenePackages(modelled, active.cards);
      const sceneBuild = routed.some((p) => isObj(p) && p.id === scene.SCENE_WORKER_ID);
      const packages = (unityRun ? routed.map((p) => withEditorFreeVerify(p, checkRole(p, sceneBuild))) : routed).map(withKitNote);
      return { ...res, raw: { ...res.raw, packages } };
    };
  }

  /**
   * Who may run a package's moved check (orchestraUnityVerify CHECK_ROLES):
   * next to a scene worker only the scene worker opens Unity (every other
   * package got lunasworkScene's "do not open the Unity editor" note); a plan
   * without one lets every worker use its own editor, as before.
   */
  function checkRole(pkg, sceneBuild) {
    return !sceneBuild || (isObj(pkg) && pkg.id === scene.SCENE_WORKER_ID) ? 'editor' : 'noEditor';
  }

  /** The package with its verify moved into its prompt as a check worded for `role`. */
  function withEditorFreeVerify(pkg, role) {
    const out = unityVerify.editorFreeVerify(pkg, MAX_PROMPT_CHARS, role);
    if (out === pkg) return pkg;
    const whole = out.prompt.endsWith(unityVerify.editorCheckNote(pkg.verify, role));
    const where = whole ? 'moved into the prompt as a check' : 'emptied; the check was shortened or left out to fit the prompt cap';
    const why = unityVerify.editorBoundReason(pkg.verify) || 'shell';
    log(`[lunaswork-build] ${pkg.id}: verify in a Unity build (${why}, ${role}) - ${where}`);
    return out;
  }

  /**
   * The package prompt with its kit's note at the end. The prompt is never
   * cut (its end holds the acceptance and commit steps): a note that does not
   * fit the planner's cap is shortened instead - the deny rules it names are
   * enforced by the launch flags either way.
   */
  function withKitNote(pkg) {
    const kit = isObj(pkg) ? kitOf(pkg) : null;
    if (!kit || typeof kit.note !== 'string' || !kit.note) return pkg;
    const prompt = typeof pkg.prompt === 'string' ? pkg.prompt : '';
    const room = MAX_PROMPT_CHARS - prompt.length - KIT_NOTE_GAP.length;
    if (room <= 0) return pkg;
    if (room < kit.note.length) log(`[lunaswork-build] ${pkg.id}: tool kit note shortened to fit the prompt cap`);
    return { ...pkg, prompt: [prompt, kit.note.slice(0, room)].filter(Boolean).join(KIT_NOTE_GAP) };
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
    workerTools,
    wrapPlanner,
    ownsMerge,
    isBuilding: (projectId) => !!active && (projectId === undefined || active.projectId === projectId),
    /** The build running now ({projectId, repoPath}), or null: who may get the asset tools. */
    activeBuild: () => (active ? { projectId: active.projectId, repoPath: active.repoPath } : null),
  };
}

/**
 * A settled build that landed nothing because of the usage limit: no package
 * merged, the merge did not go red, and the run waited for a usage reset on
 * the way (the builder saw it: limitedUntil) or God Mode logged a limit
 * pause with no free account. Such an iteration is limited, never 'build
 * green, 0/N cards landed'. Null for every other result.
 * @param {object} result the build result
 * @returns {{error:'limit', resumeAt:number|null}|null}
 */
function buildLimitOf(result) {
  const r = isObj(result) ? result : {};
  if (r.ok === false || r.killed === true || r.nothing === true) return null;
  if (isObj(r.integration) && r.integration.state === 'failed') return null;
  const plan = isObj(r.plan) ? r.plan : {};
  if ((Array.isArray(plan.packages) ? plan.packages : []).some((p) => isObj(p) && p.merged === true)) return null;
  const recoveries = Array.isArray(plan.recoveries) ? plan.recoveries : [];
  const paused = recoveries.some((e) => isObj(e) && e.reason === 'usageLimit' && typeof e.detail === 'string' && e.detail.includes('no free account'));
  const seen = Number.isFinite(r.limitedUntil);
  if (!seen && !paused) return null;
  return { error: 'limit', resumeAt: seen ? r.limitedUntil : null };
}

module.exports = { createGodModeBuilder, buildLimitOf, packageModel, planCard, plannerModelFor, claudeProfileIdOf, isRealClaudeProfile };
