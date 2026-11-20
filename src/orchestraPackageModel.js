// ============================================================================
// LunaCore - a package's model + effort picked on the Approve board (pure)
// ----------------------------------------------------------------------------
// In a pool run Mati can click a package's model badge on Approve and give
// that package another model and effort: one of the ticked pool models, or
// Opus (always offered). The renderer sends {packageModels: {[id]: {model,
// effort}}} with Approve; src/orchestra.js launch() checks it here - the
// renderer is untrusted - and saves each pick as the package's planned model
// before the run starts:
//
//   pickChoices(pool)                 the keys a pick may name: the ticked
//                                     models (free profiles excluded - a free
//                                     package needs the hybrid machinery) + Opus
//   checkPackagePicks(raw, ctx)       the payload, checked strictly: a plain
//                                     object, known pending package ids only,
//                                     {model, effort} strings only, a model
//                                     from pickChoices, an effort that model
//                                     takes (agy variants on the live list)
//   applyPackagePicks(pkgs, picks, c) the packages on their picked model
//
// Mati's pick wins over the planner's and over a guard move; it is not
// guarded again (his call). Pure, no I/O.
// ============================================================================

'use strict';

const { poolKeys, runsOnOf, claudePoolLevels, POOL_FREE_KEY, POOL_EFFORT_PLAN, STRENGTH_ORDER } = require('./workerPool');
const { concreteModel } = require('./orchestraPool');
const { entryModel } = require('./orchestraPoolEffort');

/** Picks one Approve may carry at most (a plan holds far fewer packages). */
const MAX_PICKS = 50;
const PICK_KEYS = Object.freeze(['model', 'effort']);
const OPUS = 'opus';
const BAD = Object.freeze({ ok: false, error: 'badPackageModel' });

const isPlainObject = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * The keys a package pick may name: the ticked pool models without the free
 * profile, plus Opus, strongest first.
 * @param {{model:string, effort:string}[]} pool
 * @returns {string[]}
 */
function pickChoices(pool) {
  const keys = new Set([...poolKeys(pool).filter((k) => k !== POOL_FREE_KEY), OPUS]);
  return STRENGTH_ORDER.filter((k) => keys.has(k));
}

/** True when `effort` is one the model takes: 'plan', a Claude level, or a live variant of the agy family. */
function effortFits(model, effort, agyList) {
  const on = runsOnOf(model);
  if (on === 'claude') return effort === POOL_EFFORT_PLAN || claudePoolLevels(model).includes(effort);
  if (on !== 'agy') return false;
  // "Per plan" still needs a live variant of the family to run on.
  if (effort === POOL_EFFORT_PLAN) return concreteModel(model, null, agyList) !== null;
  return entryModel({ model, effort }, agyList) !== null;
}

/**
 * The Approve payload's per-package picks, checked. Nothing sent = no picks.
 * @param {unknown} raw o.packageModels
 * @param {{packages:object[], pool:{model:string, effort:string}[], agyList:{id:string,name:string}[]}} ctx
 * @returns {{ok:true, picks:Object<string,{model:string, effort:string}>}|{ok:false, error:'badPackageModel'}}
 */
function checkPackagePicks(raw, { packages, pool, agyList = [] }) {
  if (raw === undefined || raw === null) return { ok: true, picks: {} };
  if (!isPlainObject(raw)) return BAD;
  const ids = Object.keys(raw);
  if (ids.length > MAX_PICKS) return BAD;
  const pending = new Set((Array.isArray(packages) ? packages : []).filter((p) => p && p.state === 'pending').map((p) => p.id));
  const choices = pickChoices(pool);
  const picks = {};
  for (const id of ids) {
    const v = raw[id];
    if (!pending.has(id) || !isPlainObject(v) || Object.keys(v).some((k) => !PICK_KEYS.includes(k))) return BAD;
    const effort = v.effort === undefined ? POOL_EFFORT_PLAN : v.effort;
    if (typeof v.model !== 'string' || typeof effort !== 'string' || !choices.includes(v.model)) return BAD;
    if (!effortFits(v.model, effort, agyList)) return BAD;
    picks[id] = { model: v.model, effort };
  }
  return { ok: true, picks };
}

/** True when some pick names an agy family (the live list must be read first). */
function picksNeedAgy(raw) {
  if (!isPlainObject(raw)) return false;
  return Object.values(raw).some((v) => isPlainObject(v) && typeof v.model === 'string' && runsOnOf(v.model) === 'agy');
}

/**
 * The packages with Mati's picks: the picked key, the model its worker runs
 * on and the Claude level as the package's effort. A pick clears any guard /
 * rescue move made before Approve.
 * @param {object[]} packages
 * @param {Object<string,{model:string, effort:string}>} picks checkPackagePicks() output
 * @param {{agyList:{id:string,name:string}[], effortOf:(p:object) => (string|null)}} ctx
 * @returns {object[]}
 */
function applyPackagePicks(packages, picks, { agyList = [], effortOf }) {
  return (Array.isArray(packages) ? packages : []).map((p) => {
    const pick = p && Object.prototype.hasOwnProperty.call(picks, p.id) ? picks[p.id] : null;
    if (!pick) return p;
    const { weakGuard, rescueKey, emergency, rescues, ...rest } = p;
    const claude = runsOnOf(pick.model) === 'claude';
    const model = claude ? pick.model : entryModel(pick, agyList) || concreteModel(pick.model, effortOf(p), agyList);
    const level = claude && pick.effort !== POOL_EFFORT_PLAN ? pick.effort : null;
    return { ...rest, poolModel: pick.model, model, modelOverride: null, effortOverride: level, modelPick: { ...pick } };
  });
}

/**
 * A stored modelPick (state file) back to its shape, or null.
 * @param {unknown} raw
 * @returns {{model:string, effort:string}|null}
 */
function normalizeStoredPick(raw) {
  if (!isPlainObject(raw) || typeof raw.model !== 'string' || typeof raw.effort !== 'string') return null;
  if (!STRENGTH_ORDER.includes(raw.model) || raw.model === POOL_FREE_KEY || raw.effort.length > 90) return null;
  return { model: raw.model, effort: raw.effort };
}

module.exports = { MAX_PICKS, pickChoices, checkPackagePicks, picksNeedAgy, applyPackagePicks, normalizeStoredPick };
