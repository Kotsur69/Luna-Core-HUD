// ============================================================================
// LunaCore - per-model effort in the God Mode "Workers" pool (pure, shared)
// ----------------------------------------------------------------------------
// Every ticked model of the pool carries an effort (src/workerPool.js
// normalizePoolEffort): 'plan' ("Per plan" = each package keeps its own
// effort, today's run) or what every package on that model runs at:
//
//   Claude (Opus, Sonnet)   a --effort level, clamped to what the model takes
//   agy families            a live VARIANT 'agy:<id>' of the family (agy has
//                           no effort of its own); offered only from the live
//                           `agy models` list, never a shipped id
//   free profiles           none (the select shows '-')
//
// This module holds the select's choices and what a package's badge, the
// phone and the run report read. Main applies the efforts in
// src/orchestraPoolEffort.js. Import-free but for src/workerPool.js: the
// renderer and the phone import it as an ES module, main require()s it.
// ============================================================================

'use strict';

import {
  POOL_EFFORT_PLAN,
  claudePoolLevels,
  normalizePoolEffort,
  normalizePool,
  poolEffortLevel,
  poolKeyOf,
  runsOnOf,
} from './workerPool.js';

/** What an agy variant choice looks like ('agy:<id>'; src/workerModels.js shapes it the same). */
const AGY_CHOICE_RE = /^agy:[a-z0-9][a-z0-9.-]{0,79}$/i;
/** Fewer live variants than this: the family has nothing to choose, so no select. */
const MIN_AGY_CHOICES = 2;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The effort select of one ticked entry, its values in menu order: 'plan'
 * first, then Claude's levels or the agy family's live variants. [] = no
 * select (a free profile; an agy family with fewer than two live variants).
 * @param {string} model a pool model
 * @param {Array<{id:string}|string>} [variants] the family's live variants ('agy:<id>'), agy only
 * @returns {string[]}
 */
export function poolEffortChoices(model, variants = []) {
  const on = runsOnOf(poolKeyOf(model));
  if (on === 'claude') return [POOL_EFFORT_PLAN, ...claudePoolLevels(model)];
  if (on !== 'agy') return [];
  const ids = (Array.isArray(variants) ? variants : [])
    .map((v) => (isObj(v) ? v.id : v))
    .filter((id) => typeof id === 'string' && AGY_CHOICE_RE.test(id));
  const unique = [...new Set(ids)];
  return unique.length >= MIN_AGY_CHOICES ? [POOL_EFFORT_PLAN, ...unique] : [];
}

/**
 * What one ticked row of the Workers menu shows next to its name:
 *   select  the effort select: its values, the current one (an agy variant
 *           the live list no longer holds stays listed as `stale`, so it can
 *           be changed - main falls back to "Per plan" for it anyway)
 *   dash    a free profile: no effort, '-'
 *   none    nothing (an agy family with fewer than two live variants)
 * @param {{model:string, effort?:unknown}} entry
 * @param {Array<{id:string}|string>} [variants] the family's live variants, agy only
 * @returns {{kind:'select', choices:string[], value:string, stale:string|null}|{kind:'dash'}|{kind:'none'}}
 */
export function poolEffortControl(entry, variants = []) {
  const model = isObj(entry) ? entry.model : null;
  const on = runsOnOf(poolKeyOf(model));
  if (on === 'free') return { kind: 'dash' };
  const choices = poolEffortChoices(model, variants);
  if (!choices.length) return { kind: 'none' };
  const value = normalizePoolEffort(model, entry.effort);
  const stale = choices.includes(value) ? null : value;
  return { kind: 'select', choices: stale ? [...choices, stale] : choices, value, stale };
}

/**
 * The pool after one entry's effort changed (checked for its model); the
 * pool as is when the model is not ticked.
 * @param {{model:string, effort:string}[]} pool
 * @param {string} model
 * @param {unknown} effort
 * @returns {{model:string, effort:string}[]}
 */
export function setPoolEffort(pool, model, effort) {
  const list = normalizePool(pool) || [];
  return list.map((e) => (e.model === model ? { model: e.model, effort: normalizePoolEffort(e.model, effort) } : e));
}

/**
 * The entry of a planner key ('opus', 'agy-argon', 'free') in a pool, else null.
 * @param {unknown} pool
 * @param {unknown} key
 * @returns {{model:string, effort:string}|null}
 */
export function poolEntryOfKey(pool, key) {
  const list = normalizePool(pool) || [];
  return list.find((e) => poolKeyOf(e.model) === key) || null;
}

/**
 * The effort a pool package runs at because of its model's pool entry, for
 * its badge / the report / the phone: the Claude level, or the agy
 * variant's level while the package runs on that very variant. Null for
 * "Per plan", a free package, an override (escalation / hand-over) or a
 * package outside a pool.
 * @param {unknown} pool the run's modelPool
 * @param {{poolModel?:unknown, model?:unknown, modelOverride?:unknown}|null} pkg
 * @returns {string|null}
 */
export function packagePoolEffort(pool, pkg) {
  if (!isObj(pkg) || pkg.modelOverride) return null;
  // An Approve pick (src/orchestraPackageModel.js) carries its own effort: the
  // pool entry's fixed level never replaces it, and a "Per plan" pick has none.
  const pick = pkg.modelPick;
  if (isObj(pick) && pick.model === pkg.poolModel) {
    if (runsOnOf(pick.model) === 'agy' && pkg.model !== pick.effort) return null;
    return poolEffortLevel(pick);
  }
  const entry = poolEntryOfKey(pool, pkg.poolModel);
  if (!entry || entry.effort === POOL_EFFORT_PLAN) return null;
  const on = runsOnOf(pkg.poolModel);
  if (on === 'claude') return pkg.model === pkg.poolModel ? poolEffortLevel(entry) : null;
  if (on === 'agy') return pkg.model === entry.effort ? poolEffortLevel(entry) : null;
  return null;
}

/**
 * The fixed efforts a planner is told about: [{key, level}] for the
 * entries that are not "Per plan", in pool order; [] when none is set.
 * @param {unknown} pool
 * @returns {{key:string, level:string}[]}
 */
export function poolEffortList(pool) {
  return (normalizePool(pool) || [])
    .map((e) => ({ key: poolKeyOf(e.model), level: poolEffortLevel(e) }))
    .filter((x) => x.key && x.level);
}
