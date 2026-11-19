// ============================================================================
// LunaCore - God Mode "Workers" pool, wired into one run controller
// ----------------------------------------------------------------------------
// The side-effecting half of the pool (src/orchestraPool.js holds the pure
// rules): reading the live `agy models` list, logging each move, picking the
// free / coding profile a pool ticked. src/orchestra.js creates one per run
// controller and calls it at plan time and at Approve:
//
//   livePlanPool(raw)            a plan request's pool when it makes a pool
//                                run (2+ usable models), else null
//   applyPlanPool(pkgs, pool)    the planned packages on their worker models
//   approvePool(o, workers)      what Approve's pool turns the run into; a
//                                value, or a Promise only when the pool
//                                names agy (the live list is read then) - so
//                                today's Approve keeps its synchronous start
//   codingProfileFor / freeProfileFor
//                                the profile a hybrid / Free-only run uses,
//                                the pool's ticked one preferred (logged
//                                when main picks another)
// ============================================================================

'use strict';

const poolRules = require('./orchestraPool');
const { normalizePool, poolKeys, poolWorkers, isPoolRun } = require('./workerPool');
const { DEFAULT_EFFORT, normalizeEffort } = require('./efforts');

/**
 * @param {{planOf: () => (object|null), deps: object, log: (line:string) => void, workerSettings: () => object}} opts
 *   planOf: the controller's current plan (it is replaced on a re-plan)
 */
function createPoolWiring({ planOf, deps, log, workerSettings }) {
  /**
   * The effort a package's worker runs at (src/orchestra.js effortFor,
   * before any escalation): it picks the agy variant, at plan time and at
   * Approve alike.
   */
  const effortOf = (p) => normalizeEffort(workerSettings().effort) || normalizeEffort(p.effort) || DEFAULT_EFFORT;

  /** The live agy model list when a pool names agy (read once if no call worked yet), else []. */
  async function agyListFor(pool) {
    if (!deps.agyModels || !poolRules.poolNeedsAgy(pool)) return [];
    await deps.agyModels.ensure();
    return deps.agyModels.list();
  }

  /** The moves of one applyPool(), logged (they are warnings on the board too). */
  function logMoves(moved) {
    for (const m of moved) log(`[orchestra] package ${m.id}: ${m.from || 'no model'} is not in the Workers pool, runs on ${m.to}`);
  }

  /**
   * A plan request's "Workers" pool when it makes a pool run - 2+ models
   * after the agy families the live `agy models` list lacks are left out -
   * with its planner keys and the agy list it was checked against; else null.
   * @param {unknown} raw
   */
  async function livePlanPool(raw) {
    const asked = normalizePool(raw);
    if (!isPoolRun(asked)) return null;
    const agyList = await agyListFor(asked);
    const pool = poolRules.livePool(asked, agyList, log);
    if (!isPoolRun(pool)) {
      log('[orchestra] the Workers pool has fewer than two usable models; planning as before');
      return null;
    }
    return { pool, keys: poolKeys(pool), agyList };
  }

  /**
   * The planned packages on the models their workers run on (after the
   * hybrid guard). Returns the moves as 'outOfPool' warnings; a pool that
   * cannot run at all (livePlanPool makes that unreachable) is logged and
   * leaves the packages as planned.
   * @param {object[]} packages
   * @param {{pool:object[], agyList:object[]}} pool livePlanPool() output
   * @returns {{packages:object[], warnings:object[]}}
   */
  function applyPlanPool(packages, pool) {
    const applied = poolRules.applyPool(packages, pool.pool, { agyList: pool.agyList, effortOf });
    if (!applied.ok) {
      log(`[orchestra] the Workers pool could not be applied (${applied.error}); the packages keep the planner's picks`);
      return { packages, warnings: [] };
    }
    return { packages: applied.packages, warnings: applied.moved.map((m) => ({ code: 'outOfPool', ...m })) };
  }

  /**
   * Approve's "Workers" pool turned into the run (src/orchestraPool.js
   * approveChoice): only before the run starts or is scheduled, never for a
   * plan run or a Workers mode that picks its own workers (Free only,
   * Antigravity). The request's pool wins; a request with neither a pool nor
   * a single model (the phone, or the view's 'plan' sent back) keeps the
   * plan's own pool. A pool run comes back with its packages STAGED (the
   * caller commits them after its refusals).
   * @param {object} o the launch payload
   * @param {string} workers the Workers mode approveWorkers() gave
   */
  function approvePool(o, workers) {
    const plan = planOf();
    if (!plan || plan.started || plan.scheduledAt || plan.planRun || workers === 'free' || workers === 'agy') return { kind: 'none' };
    const namedModel = o.workerModel !== undefined && o.workerModel !== null && o.workerModel !== 'plan';
    const pool = Array.isArray(o.modelPool) ? normalizePool(o.modelPool) : namedModel ? null : normalizePool(plan.modelPool);
    // Only a pool that names agy waits on the live list (as agy variants
    // already do). Everything else stays synchronous, so a Kill right after
    // Approve still finds the run starting, exactly as before the pool.
    if (pool && poolRules.poolNeedsAgy(pool)) return agyListFor(pool).then((agyList) => choosePool(plan, pool, agyList, workers));
    return choosePool(plan, pool, [], workers);
  }

  /** approvePool() once the agy list (if any) is in: none / single / the pool run with its staged packages. */
  function choosePool(plan, pool, agyList, workers) {
    // An agy family the live list lacks is no model of the run: 2+ usable
    // models stay a pool run, one is today's single value.
    const live = pool ? poolRules.livePool(pool, agyList, log) : null;
    const choice = poolRules.approveChoice(live, agyList);
    if (choice.kind !== 'pool') return choice;
    const applied = poolRules.applyPool(plan.packages, choice.pool, { agyList, effortOf });
    if (!applied.ok) return { kind: 'error', error: applied.error };
    logMoves(applied.moved);
    return { ...choice, workers: poolWorkers(choice.pool, workers), workerModel: 'plan', packages: applied.packages };
  }

  /** The profile main picked for a pool's ticked one; a different one is logged. */
  function preferred(kind, wanted, got) {
    if (wanted && got && got !== wanted) log(`[orchestra] the Workers pool ticked free profile ${wanted}; ${kind} runs on ${got} (the ticked one ${kind === 'hybrid' ? 'is no coding profile' : 'has no chain'})`);
    return got;
  }

  /** The coding profile a hybrid run's free packages use: the pool's ticked one when it is a coding profile. */
  const codingProfileFor = (wanted) => preferred('hybrid', wanted, wanted ? deps.codingProfileId(wanted) : deps.codingProfileId());
  /** The profile a Free-only run uses: a one-model pool's ticked one when it has a chain. */
  const freeProfileFor = (wanted) => preferred('Free only', wanted, wanted ? deps.freeProfileId(wanted) : deps.freeProfileId());

  return { livePlanPool, applyPlanPool, approvePool, codingProfileFor, freeProfileFor };
}

module.exports = { createPoolWiring };
