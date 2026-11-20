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
const effortRules = require('./orchestraPoolEffort');
const { poolEffortList } = require('./poolEffort');
const { normalizePool, poolKeys, poolWorkers, isPoolRun, runsOnOf } = require('./workerPool');
const { agyModelIdOf } = require('./workerModels');
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
   * The pool with its agy variants checked against the live list
   * (src/orchestraPoolEffort.js liveEfforts); each one that fell back to
   * "Per plan" is logged and comes back as a board note.
   */
  function checkedEfforts(pool, agyList) {
    const checked = effortRules.liveEfforts(pool, agyList);
    for (const n of checked.notes) log(`[orchestra] Workers pool ${n.model}: variant ${n.from} is not in the live \`agy models\` list; it runs Per plan`);
    return checked;
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
    const live = poolRules.livePool(asked, agyList, log);
    if (!isPoolRun(live)) {
      log('[orchestra] the Workers pool has fewer than two usable models; planning as before');
      return null;
    }
    const { pool, notes } = checkedEfforts(live, agyList);
    // efforts: the fixed per-model efforts the planner weighs (none = "Per plan" everywhere).
    return { pool, keys: poolKeys(pool), agyList, notes, efforts: poolEffortList(pool) };
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
    const notes = Array.isArray(pool.notes) ? pool.notes : [];
    const applied = poolRules.applyPool(packages, pool.pool, { agyList: pool.agyList, effortOf });
    if (!applied.ok) {
      log(`[orchestra] the Workers pool could not be applied (${applied.error}); the packages keep the planner's picks`);
      return { packages, warnings: notes };
    }
    return { packages: applied.packages, warnings: [...notes, ...applied.moved.map((m) => ({ code: 'outOfPool', ...m }))] };
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

  /**
   * approvePool() once the agy list (if any) is in: none / single / the pool
   * run with its staged packages. `notes` = the board notes of agy variants
   * that fell back to "Per plan" (the caller adds them once it commits).
   */
  function choosePool(plan, pool, agyList, workers) {
    // An agy family the live list lacks is no model of the run: 2+ usable
    // models stay a pool run, one is today's single value.
    const live = pool ? poolRules.livePool(pool, agyList, log) : null;
    const checked = live ? checkedEfforts(live, agyList) : { pool: live, notes: [] };
    const choice = poolRules.approveChoice(checked.pool, agyList);
    const notes = checked.notes.length ? { notes: checked.notes } : {};
    if (choice.kind !== 'pool') return choice.kind === 'single' ? { ...choice, ...notes } : choice;
    const applied = poolRules.applyPool(plan.packages, choice.pool, { agyList, effortOf });
    if (!applied.ok) return { kind: 'error', error: applied.error };
    logMoves(applied.moved);
    return { ...choice, ...notes, workers: poolWorkers(choice.pool, workers), workerModel: 'plan', packages: applied.packages };
  }

  /**
   * The agy planner's `--model` id: the live variant of an agy family key
   * ('agy-opus' / 'agy-neon' / 'agy-argon' / 'agy-hydrogen') nearest the planner effort.
   * Null for anything else, or a family the live list lacks (logged): agy
   * then plans on its own default model, as before the choice existed.
   * @param {unknown} key
   * @param {string|null} effort the planner effort
   * @returns {Promise<string|null>}
   */
  async function agyPlannerModelId(key, effort) {
    if (runsOnOf(key) !== 'agy') return null;
    const agyList = await agyListFor([{ model: key }]);
    const id = agyModelIdOf(poolRules.concreteModel(key, effort, agyList));
    if (!id) log(`[orchestra] agy planner model ${key} is not in the live \`agy models\` list; agy plans on its default model`);
    return id;
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

  return { livePlanPool, applyPlanPool, approvePool, codingProfileFor, freeProfileFor, agyPlannerModelId };
}

module.exports = { createPoolWiring };
