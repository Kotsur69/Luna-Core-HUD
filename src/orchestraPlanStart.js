// ============================================================================
// LunaCore - starting a God Mode plan (main): the one path both callers share
// ----------------------------------------------------------------------------
// orchestra:plan (src/orchestraIpc.js, a HUD tab) and the phone's signed
// godmode.plan (src/hostgodmode.js) plan through these helpers, so the to-do
// selection rules, the refusals and the makePlan call can never drift apart:
//
//   todoSelection(todoAts, max)  the picker's to-do `at` values: null = every
//                                open to-do; capped BEFORE anything walks the
//                                array, deduped, finite numbers only
//   planTarget(ctx, session)     the tab's project, Luna's Work block and repo
//                                folder -> {ok, projectId, repoPath} or a refusal
//   runPlan(ctx, session, target, {picked, effort})
//                                registry.ensure(project).makePlan(...), then
//                                'orchestra:changed' for the HUD board
//
// Refusals keep orchestra:plan's shapes: {ok:false, error:'noRepo'} and
// godModeBlock()'s own {ok:false, error:'lunasWorkActive', message}.
// ============================================================================

'use strict';

const { plannerEffortOf, plannerModelOf, PLANNER_MODEL } = require('./orchestraPlan');
const { normalizeWorkers } = require('./orchestraWorkers');
const { normalizePlanner } = require('./orchestraAgy');
const { normalizePool, isPoolRun, runsOnOf } = require('./workerPool');

const keyOf = (projectId) => (typeof projectId === 'string' ? projectId : null);

/**
 * The picker's selection. `picked` follows orchestra:plan: null = every open
 * to-do, an off-shape selection fails closed as [] ('noneSelected' in
 * makePlan). `valid` says whether the input was well-formed, for a caller
 * that must refuse a bad payload outright (the phone).
 * @param {unknown} todoAts
 * @param {number} max the to-do list's own cap
 * @returns {{valid: boolean, picked: number[]|null}}
 */
function todoSelection(todoAts, max) {
  if (todoAts === undefined || todoAts === null) return { valid: true, picked: null };
  // The length is capped before anything walks the array: a sender of
  // millions of entries must not stall main building a Set.
  if (!Array.isArray(todoAts) || todoAts.length > max) return { valid: false, picked: [] };
  const unique = [...new Set(todoAts)];
  return unique.every(Number.isFinite) ? { valid: true, picked: unique } : { valid: false, picked: [] };
}

/**
 * Where a tab's plan would run, or why it may not.
 * @param {{godModeBlock: Function, repoFor: Function}} ctx
 * @param {{projectId?: string|null}} session
 * @returns {{ok: true, projectId: string|null, repoPath: string}|{ok: false, error: string}}
 */
function planTarget(ctx, session) {
  const projectId = keyOf(session.projectId);
  // Never God Mode and Luna's Work on the same project at once.
  const blocked = ctx.godModeBlock(projectId);
  if (blocked) return blocked;
  // A missing cwd makes execFile fail with ENOENT, which would read as
  // "claude not found" - check the folder first and say what is wrong.
  const repoPath = ctx.repoFor(session);
  if (!repoPath) return { ok: false, error: 'noRepo' };
  return { ok: true, projectId, repoPath };
}

/**
 * Plans in the tab's project. The planner runs on the cloud default like
 * /ask: a tab's local-model profile must not silently plan the whole run.
 * @param {{registry: object, toolEnv: () => object, send: Function}} ctx
 * @param {{projectId?: string|null, profileId?: string}} session
 * @param {{projectId: string|null, repoPath: string}} target planTarget()'s answer
 * @param {{picked: number[]|null, effort?: unknown, planner?: unknown, workers?: unknown, model?: unknown, followups?: unknown}} opts
 *   model: the Claude planner's model, allow-listed here (orchestraPlan.js PLANNER_MODELS);
 *   followups: "Sessions may file new to-dos" (orchestraFollowups.js), on for the boolean true only
 */
/**
 * The planner and workers a request names, checked against the shared
 * allow-lists. Nothing named = the defaults (an older renderer or phone);
 * an unknown name is refused, never coerced to Claude.
 * @param {unknown} planner
 * @param {unknown} workers
 * @returns {{ok:true, planner:string, workers:string|null}|{ok:false, error:'badPlanner'|'badWorkers'}}
 */
function planChoice(planner, workers) {
  const named = (v) => v !== undefined && v !== null;
  const p = named(planner) ? normalizePlanner(planner) : 'claude';
  if (!p) return { ok: false, error: 'badPlanner' };
  const w = named(workers) ? normalizeWorkers(workers) : null;
  if (named(workers) && !w) return { ok: false, error: 'badWorkers' };
  return { ok: true, planner: p, workers: w };
}

/** The env a planner runs in: free = the coding profile, agy = the agy profile. */
function plannerEnv(ctx, planner) {
  if (planner === 'free') return ctx.freePlannerEnv ? ctx.freePlannerEnv() : null;
  if (planner === 'agy') return ctx.agyPlannerEnv ? ctx.agyPlannerEnv() : null;
  return ctx.toolEnv();
}

/**
 * The "Workers" pool a plan request names, when it makes a pool run: 2+
 * valid entries, a Claude or agy planner, and Workers neither "Free only" nor
 * "Antigravity" (those pick their own workers). Else null - the makePlan call
 * as before; a one-model pool is today's run (src/workerPool.js).
 * @param {unknown} modelPool
 * @param {{planner:string, workers:string|null}} choice planChoice()'s answer
 * @returns {{model:string, effort:string}[]|null}
 */
function planPoolOf(modelPool, choice) {
  const pool = normalizePool(modelPool);
  if (!isPoolRun(pool) || choice.planner === 'free' || choice.workers === 'free' || choice.workers === 'agy') return null;
  return pool;
}

async function runPlan(ctx, session, target, { picked, effort, planner, workers, model, followups, modelPool }) {
  // D1 "Planner": 'free' plans on the coding profile's env, 'agy' on the
  // Antigravity profile's; nothing named is today's Claude planner.
  const choice = planChoice(planner, workers);
  if (!choice.ok) return choice;
  const free = choice.planner === 'free';
  const agy = choice.planner === 'agy';
  const env = plannerEnv(ctx, choice.planner);
  if (!env) return { ok: false, error: agy ? 'noAgyProfile' : 'noFreeProfile' };
  // One of the allow-listed aliases only; anything else plans on the default.
  const plannerModel = plannerModelOf(model);
  const pool = planPoolOf(modelPool, choice);
  const res = await ctx.registry.ensure(target.projectId).makePlan({
    projectId: session.projectId,
    repoPath: target.repoPath,
    profileId: session.profileId,
    env,
    todoAts: picked,
    // One of the four levels only; anything else plans at the default high.
    plannerEffort: plannerEffortOf(effort),
    ...(free || agy ? { planner: choice.planner } : {}),
    // The default model passes no key (the makePlan call as before); the free
    // and agy planners have their own model.
    ...(!free && !agy && plannerModel !== PLANNER_MODEL ? { plannerModel } : {}),
    // The agy planner's model: an agy family of the pool menu ('agy-opus' / 'agy-neon' /
    // 'agy-argon' / 'agy-hydrogen'), resolved against the live list in makePlan; none = agy's default.
    ...(agy && runsOnOf(model) === 'agy' ? { plannerAgyModel: model } : {}),
    // F6 "Workers": "Plan with free models in mind" changes planning and
    // "Antigravity (agy)" is kept on the plan; a Claude-only request passes no
    // key (the makePlan call as before).
    ...(!free && (choice.workers === 'hybrid' || choice.workers === 'agy') ? { workers: choice.workers } : {}),
    // Off by default and then no key at all (the makePlan call as before); the plan keeps it.
    ...(followups === true ? { followups: true } : {}),
    // A pool run (2+ ticked worker models): the planner plans for exactly those.
    ...(pool ? { modelPool: pool } : {}),
  });
  if (res.ok) ctx.send('orchestra:changed', { projectId: target.projectId, view: res.plan });
  return res;
}

module.exports = { todoSelection, planTarget, planChoice, planPoolOf, runPlan };
