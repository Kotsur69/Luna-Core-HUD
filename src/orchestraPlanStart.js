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

const { plannerEffortOf } = require('./orchestraPlan');
const { normalizeWorkers } = require('./orchestraWorkers');

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
 * @param {{picked: number[]|null, effort?: unknown, planner?: unknown, workers?: unknown}} opts
 */
async function runPlan(ctx, session, target, { picked, effort, planner, workers }) {
  // D1 "Planner: Claude / Free": exactly 'free' picks the free planner on the
  // coding profile's env; anything else is today's Claude planner.
  const free = planner === 'free';
  const env = free ? (ctx.freePlannerEnv ? ctx.freePlannerEnv() : null) : ctx.toolEnv();
  if (!env) return { ok: false, error: 'noFreeProfile' };
  const res = await ctx.registry.ensure(target.projectId).makePlan({
    projectId: session.projectId,
    repoPath: target.repoPath,
    profileId: session.profileId,
    env,
    todoAts: picked,
    // One of the four levels only; anything else plans at the default high.
    plannerEffort: plannerEffortOf(effort),
    ...(free ? { planner: 'free' } : {}),
    // F6 "Workers": only "Plan with free models in mind" changes planning; a
    // Claude-only request passes no key (the makePlan call as before).
    ...(!free && normalizeWorkers(workers) === 'hybrid' ? { workers: 'hybrid' } : {}),
  });
  if (res.ok) ctx.send('orchestra:changed', { projectId: target.projectId, view: res.plan });
  return res;
}

module.exports = { todoSelection, planTarget, runPlan };
