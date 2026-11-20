// ============================================================================
// LunaCore - the weak-model guard of a God Mode "Workers" pool run (pure)
// ----------------------------------------------------------------------------
// The hybrid guard (src/orchestraHybridGuard.js) keeps risky work off free
// models. The same rules guard the EASIEST agy tier (Hydrogen today; the tier
// comes from src/agyFamilies.js, never a hardcoded id): a package planned on
// it moves when it
//   - lists more than 2 files, or none;
//   - touches a protected path (entry point, preload, IPC, auth / secrets,
//     migrations, package.json / lockfiles, build, CI, test infrastructure);
//   - has no acceptance test or verify step.
//
// The move is a rescue of kind 'guard' (src/orchestraRescue.js): the next
// stronger ticked model, else Opus on Claude as an emergency. It is set as an
// override (like an escalation), so Approve's pool keeps it, and the package
// carries `weakGuard: {from, reasons}` for the board. Sonnet and the other
// tiers are never guarded; runs without a pool never get here.
// ============================================================================

'use strict';

const { agyPoolKeysOfTier } = require('./agyFamilies');
const { poolKeys } = require('./workerPool');
const { concreteModel } = require('./orchestraPool');
const { guardReasons, normalizeGuardReasons } = require('./orchestraHybridGuard');
const rescue = require('./orchestraRescue');

/** The pool keys the guard watches: the easiest agy tier. */
const WEAK_KEYS = Object.freeze(agyPoolKeysOfTier('easy'));
const GUARD_KIND = 'guard';
const MAX_REASON_TEXT = 120;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** True for a pool key on the guarded (easiest) agy tier. */
function isWeakKey(key) {
  return WEAK_KEYS.includes(key);
}

/** A short text of the reasons for the rescue log ('tooManyFiles, protected'). */
const reasonText = (reasons) => reasons.map((r) => r.code).join(', ').slice(0, MAX_REASON_TEXT);

/** True for a package the guard looks at: not started, no override, planned on a weak key. */
function guarded(p) {
  return isObj(p) && (!p.state || p.state === 'pending') && !p.sessionId && !p.modelOverride && isWeakKey(p.poolModel);
}

/**
 * Where a guarded package goes: the next stronger usable ticked model, else
 * Opus on Claude (an emergency unless Opus is ticked).
 * @param {string} from
 * @param {string[]} ticked
 * @param {string[]} available
 * @returns {{key:string, emergency:boolean}}
 */
function guardTarget(from, ticked, available) {
  const next = rescue.nextStrongerTicked(from, available);
  return next ? { key: next, emergency: false } : { key: rescue.OPUS, emergency: !ticked.includes(rescue.OPUS) };
}

/**
 * Runs the weak-model guard over a pool run's packages.
 * @param {object[]} packages applyPool() output (poolModel set)
 * @param {{pool:object[], agyList:object[], rules?:object[], effortOf:(p:object) => (string|null),
 *   emergencySetting:unknown, at:number}} ctx
 * @returns {{packages:object[], moves:{id:string, from:string, to:string, emergency:boolean, text:string}[]}}
 */
function applyWeakGuard(packages, { pool, agyList = [], rules, effortOf, emergencySetting, at }) {
  const ticked = poolKeys(pool);
  const available = rescue.availableKeys(ticked, [], (k) => concreteModel(k, null, agyList) !== null);
  const moves = [];
  const out = (Array.isArray(packages) ? packages : []).map((p) => {
    if (!guarded(p)) return p;
    const reasons = guardReasons(p, rules);
    if (!reasons.length) return p;
    const from = p.poolModel;
    const target = guardTarget(from, ticked, available);
    const resolved = rescue.resolveTarget({ pkg: p, key: target.key, pool, agyList, effort: effortOf(p), emergencySetting });
    if (!resolved || !resolved.model) return p;
    const fields = rescue.rescueFields(p, {
      kind: GUARD_KIND,
      from,
      to: target.key,
      emergency: target.emergency,
      model: resolved.model,
      effort: resolved.effort,
      at,
      reason: reasonText(reasons),
    });
    const text = rescue.rescueText(fields.rescues[fields.rescues.length - 1]);
    moves.push({ id: p.id, from, to: target.key, emergency: target.emergency, text });
    return { ...p, ...fields, weakGuard: { from, reasons } };
  });
  return { packages: out, moves };
}

/**
 * A guard move taken back (Approve re-applies the guard to its own pool):
 * only for a package not started whose every rescue is a guard move.
 * @param {object} p
 * @returns {object}
 */
function undoWeakGuard(p) {
  if (!isObj(p) || !p.weakGuard || (p.state && p.state !== 'pending') || p.sessionId) return p;
  const rescues = Array.isArray(p.rescues) ? p.rescues : [];
  if (!rescues.every((r) => isObj(r) && r.kind === GUARD_KIND)) return p;
  const { weakGuard, modelOverride, effortOverride, rescueKey, emergency, rescues: dropped, ...rest } = p;
  return { ...rest, poolModel: isWeakKey(weakGuard.from) ? weakGuard.from : rest.poolModel };
}

/**
 * A stored weakGuard (state file) back to its shape, or null.
 * @param {unknown} raw
 * @returns {{from:string, reasons:object[]}|null}
 */
function normalizeStoredWeakGuard(raw) {
  if (!isObj(raw) || !isWeakKey(raw.from)) return null;
  const reasons = normalizeGuardReasons(raw.reasons);
  return reasons.length ? { from: raw.from, reasons } : null;
}

module.exports = {
  WEAK_KEYS,
  GUARD_KIND,
  isWeakKey,
  guardTarget,
  applyWeakGuard,
  undoWeakGuard,
  normalizeStoredWeakGuard,
};
