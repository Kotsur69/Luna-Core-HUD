// ============================================================================
// LunaCore - per-kind parallel caps of a God Mode "Workers" pool run (pure)
// ----------------------------------------------------------------------------
// One global cap (src/orchestraPlan.js MAX_PARALLEL, src/orchestraFree.js
// maxParallelFor) covers every worker of a run. A pool run that mixes
// backends gets a cap per KIND on top of it:
//
//   claude   no cap of its own (the global cap, unchanged)
//   agy      the "agy workers at once" setting (default 2), counted over
//            EVERY God Mode run: two runs share one agy quota
//   free     the "free workers at once" setting (default: today's free cap,
//            FREE_MAX_PARALLEL), for the run's hybrid free packages
//
// A ready package whose kind is full waits while packages of other kinds
// launch. Runs without a pool (Opus only, a single model, Free only, plan
// runs) are never capped here: their launch stays exactly as before.
//
// Pure: the caller tells each package's kind and the other runs' agy count.
// ============================================================================

'use strict';

const { MAX_PARALLEL } = require('./orchestraPlan');
const { FREE_MAX_PARALLEL } = require('./orchestraFree');
const { isPoolPlan } = require('./orchestraRescue');

const KIND_CLAUDE = 'claude';
const KIND_AGY = 'agy';
const KIND_FREE = 'free';
const KINDS = Object.freeze([KIND_CLAUDE, KIND_AGY, KIND_FREE]);
/** Default agy workers at once, across every run. */
const DEFAULT_AGY_CAP = 2;
/** Default free workers at once: today's free cap. */
const DEFAULT_FREE_CAP = FREE_MAX_PARALLEL;
const MIN_KIND_CAP = 1;
/** A kind cap never goes past the run-wide one. */
const MAX_KIND_CAP = MAX_PARALLEL;
/** A ready package that would go over its kind's cap is masked with this state. */
const HELD_STATE = 'kind_held';

/**
 * A stored / sent kind cap: an integer in 1..MAX_KIND_CAP, else null.
 * @param {unknown} raw
 * @returns {number|null}
 */
function kindCapOf(raw) {
  return Number.isInteger(raw) && raw >= MIN_KIND_CAP && raw <= MAX_KIND_CAP ? raw : null;
}

/**
 * The caps a run's launches obey, from the worker settings. Claude has none.
 * @param {{agyMaxParallel?:unknown, freeMaxParallel?:unknown}|null} settings
 * @returns {{agy:number, free:number}}
 */
function kindCaps(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return { agy: kindCapOf(s.agyMaxParallel) || DEFAULT_AGY_CAP, free: kindCapOf(s.freeMaxParallel) || DEFAULT_FREE_CAP };
}

/** True when the run's launches are capped per kind: a pool run (2+ ticked models). */
function usesKindCaps(plan) {
  return isPoolPlan(plan);
}

/**
 * Which ready packages may launch now under the per-kind caps. `ready` is
 * the run's ready list (global cap applied, in launch order) for the given
 * package list; a package whose kind is full is masked and the list is
 * read again, so the next package of another kind takes the free slot.
 * @param {object[]} packages the run's packages (paused ones already masked)
 * @param {{
 *   readyOf: (packages:object[]) => object[],   src/orchestraSupervisor.js readyToLaunch with the global cap
 *   isActive: (pkg:object) => boolean,           holds a worker slot now
 *   kindOf: (pkg:object) => string,              'claude' | 'agy' | 'free'
 *   caps: {agy:number, free:number},
 *   elsewhere?: {agy?:number},                   workers of each kind in OTHER runs
 * }} opts
 * @returns {{ready:object[], held:string[]}} held = ids waiting for their kind
 */
function capReady(packages, { readyOf, isActive, kindOf, caps, elsewhere = {} }) {
  const list = Array.isArray(packages) ? packages : [];
  const running = { [KIND_AGY]: Number(elsewhere.agy) || 0, [KIND_FREE]: 0 };
  for (const p of list) {
    if (!isActive(p)) continue;
    const kind = kindOf(p);
    if (kind in running) running[kind] += 1;
  }
  const held = new Set();
  let masked = list;
  // Each round masks at least one more package, so this ends.
  for (let round = 0; round <= list.length; round += 1) {
    const ready = readyOf(masked);
    const used = { ...running };
    const over = [];
    const ok = ready.filter((p) => {
      const kind = kindOf(p);
      if (!(kind in used)) return true;
      if (used[kind] < caps[kind]) {
        used[kind] += 1;
        return true;
      }
      over.push(p.id);
      return false;
    });
    if (!over.length) return { ready: ok, held: [...held] };
    for (const id of over) held.add(id);
    masked = masked.map((p) => (held.has(p.id) && p.state === 'pending' ? { ...p, state: HELD_STATE } : p));
  }
  return { ready: [], held: [...held] };
}

module.exports = {
  KIND_CLAUDE,
  KIND_AGY,
  KIND_FREE,
  KINDS,
  DEFAULT_AGY_CAP,
  DEFAULT_FREE_CAP,
  MIN_KIND_CAP,
  MAX_KIND_CAP,
  kindCapOf,
  kindCaps,
  usesKindCaps,
  capReady,
};
