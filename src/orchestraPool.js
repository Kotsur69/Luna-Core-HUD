// ============================================================================
// LunaCore - God Mode worker-model pools, main side (pure rules)
// ----------------------------------------------------------------------------
// src/workerPool.js holds the shared shape; this module applies a pool to a
// run. src/orchestra.js wires it at plan time (makePlan) and at Approve:
//
//   livePool(raw, agyList, log)     the pool a request makes, minus the agy
//                                   families the live `agy models` list lacks
//   applyPool(packages, pool, ...)  every package that has not started gets a
//                                   ticked key (out-of-pool -> the strongest
//                                   usable one, reported) and the model its
//                                   worker runs on: a Claude alias, 'free'
//                                   (the hybrid machinery) or 'agy:<id>'
//   approveChoice(pool, agyList)    what Approve's pool turns the run into: none
//                                   (today's flow), one model (today's single
//                                   value) or a pool run
//   poolOptions(...)                the picker's menu: agy families with their
//                                   live variants, free profiles (coding or not)
//
// A pool of 0 or 1 models never changes a plan: 'none' / 'single' map onto
// the values a run had before pools existed. Pure, no I/O.
// ============================================================================

'use strict';

const {
  POOL_MODEL_LIST,
  POOL_FREE_KEY,
  normalizePool,
  poolKeys,
  poolKeyOf,
  isPoolKey,
  runsOnOf,
  agyFamilyOf,
  agyFamilyVariants,
  agyVariantFor,
  freePoolModel,
  freeProfileIdOf,
  poolFreeProfileId,
  strongestKey,
  poolModelName,
  poolLabel,
  poolEffortLevel,
} = require('./workerPool');
const { agyVariant, agyModelIdOf } = require('./workerModels');
const { poolEntryOfKey, packagePoolEffort } = require('./poolEffort');
const { entryModel, liveEfforts } = require('./orchestraPoolEffort');

const MAX_NAME_CHARS = 80;
const noop = () => {};

/** A display name: one line, no control characters, capped. */
const cleanName = (v) =>
  String(v == null ? '' : v)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);

/** True when the pool names an agy model (the live list is needed then). */
function poolNeedsAgy(pool) {
  return (Array.isArray(pool) ? pool : []).some((e) => e && runsOnOf(poolKeyOf(e.model)) === 'agy');
}

/**
 * The pool a request makes: normalized, and without the agy families the
 * live list does not hold (each one logged) - the planner is never offered a
 * model that cannot run.
 * @param {unknown} raw
 * @param {{id:string, name:string}[]} agyList
 * @param {(line:string) => void} [log]
 * @returns {{model:string, effort:string}[]|null} null for an off-shape request
 */
function livePool(raw, agyList, log = noop) {
  const pool = normalizePool(raw);
  if (!pool) return null;
  return pool.filter((e) => {
    const family = agyFamilyOf(e.model);
    if (!family || agyFamilyVariants(agyList, family).length) return true;
    log(`[orchestra] pool model ${e.model} is not in the live \`agy models\` list; left out of the pool`);
    return false;
  });
}

/**
 * True when every entry of a checked pool can run as sent: each agy family
 * has a live variant and each chosen agy variant is on the live list for its
 * family. A sent pool (the phone) is refused otherwise, never trimmed.
 * @param {{model:string, effort:string}[]} pool strictPool() / normalizePool() output
 * @param {{id:string, name:string}[]} agyList
 * @returns {boolean}
 */
function isLivePool(pool, agyList) {
  if (!Array.isArray(pool)) return false;
  const live = livePool(pool, agyList);
  return !!live && live.length === pool.length && liveEfforts(pool, agyList).notes.length === 0;
}

/**
 * The model a pool key runs on: the Claude alias, 'free', or the 'agy:<id>'
 * variant nearest the effort. Null when an agy family has no live variant.
 */
function concreteModel(key, effort, agyList) {
  const on = runsOnOf(key);
  if (on === 'claude') return key;
  if (on === 'free') return 'free';
  if (on !== 'agy') return null;
  return agyVariant(agyVariantFor(agyFamilyVariants(agyList, agyFamilyOf(key)), effort));
}

/** The models of the live list with this id (zero or one). */
const listedAs = (id, agyList) => (Array.isArray(agyList) ? agyList : []).filter((m) => m && m.id === id);

/** The agy pool key whose family holds this agy model id, else null. */
function agyKeyOfId(id, agyList) {
  const listed = listedAs(id, agyList);
  const hit = POOL_MODEL_LIST.find((m) => m.family && agyFamilyVariants(listed, m.family).length);
  return hit ? hit.id : null;
}

/**
 * The key a package stands on now: its model when that is a key or a Claude
 * alias (a guard upgrade to 'sonnet' counts), an agy variant's family,
 * else the key it was planned on.
 */
function keyOfPackage(p, agyList) {
  if (isPoolKey(p.model)) return p.model;
  const id = agyModelIdOf(p.model);
  if (!id) return isPoolKey(p.poolModel) ? p.poolModel : null;
  const planned = runsOnOf(p.poolModel) === 'agy' && agyFamilyVariants(listedAs(id, agyList), agyFamilyOf(p.poolModel)).length;
  return planned ? p.poolModel : agyKeyOfId(id, agyList);
}

/**
 * Applies a pool (2+ models) to the packages that have not started. A key
 * outside the pool - or an agy family with no live variant - goes to the
 * strongest usable ticked key; `moved` lists each such change for the log.
 * An agy entry with a live variant runs every package on that variant;
 * "Per plan" picks the variant nearest each package's effort, as before.
 * A package with an escalation / hand-over override keeps it (rescue).
 * @param {object[]} packages
 * @param {{model:string}[]} pool
 * @param {{agyList?:{id:string,name:string}[], effortOf?:(p:object) => (string|null)}} [opts]
 * @returns {{ok:true, packages:object[], moved:{id:string, from:string|null, to:string}[]}|{ok:false, error:'badAgyModel'}}
 */
function applyPool(packages, pool, { agyList = [], effortOf = (p) => p.effort || null } = {}) {
  const usable = poolKeys(pool).filter((k) => concreteModel(k, null, agyList) !== null);
  const strongest = strongestKey(usable);
  if (!strongest) return { ok: false, error: 'badAgyModel' };
  // The hybrid guard upgrades an unsafe free package to Sonnet. In a pool
  // without Sonnet it goes to the strongest ticked model like any other
  // out-of-pool pick: Opus when ticked (it heads STRENGTH_ORDER), else a
  // paid agy model - always an upgrade over free, never outside the pool.
  const moved = [];
  const out = (Array.isArray(packages) ? packages : []).map((p) => {
    if (!p || typeof p !== 'object' || p.modelOverride || (p.state && p.state !== 'pending')) return p;
    const own = keyOfPackage(p, agyList);
    const guarded = !!(p.hybridGuard && p.hybridGuard.from === 'free');
    const key = usable.includes(own) ? own : strongest;
    const from = own || (typeof p.model === 'string' ? p.model : null);
    if (key !== own) moved.push({ id: p.id, from, to: key });
    // poolFrom keeps the planner's first out-of-pool pick; a guard move has
    // its own record (hybridGuard) and is no planner pick.
    const record = key !== own && !guarded && !p.poolFrom ? { poolFrom: from } : {};
    const model = entryModel(poolEntryOfKey(pool, key), agyList) || concreteModel(key, effortOf(p), agyList);
    return { ...p, poolModel: key, model, ...record };
  });
  return { ok: true, packages: out, moved };
}

/**
 * What Approve's pool turns the run into.
 *   none    no pool: today's flow (the Approve select / Settings model)
 *   single  one model = today's single value: a Claude alias or 'agy:<id>'
 *           as the run's worker model, or a free profile as "Free only".
 *           A Claude level becomes the run's worker effort (every package
 *           is on that model); an agy entry's live variant is the model.
 *   pool    2+ models: a pool run (worker model 'plan')
 * @param {{model:string, effort:string}[]|null} pool normalizePool() output
 * @param {{id:string, name:string}[]} agyList
 * @returns {{kind:'none'}|{kind:'single', workerModel?:string, workerEffort?:string, workers?:'free', freeProfileId?:string}
 *   |{kind:'pool', pool:object[], freeProfileId:string|null}|{kind:'error', error:'badAgyModel'}}
 */
function approveChoice(pool, agyList) {
  if (!Array.isArray(pool) || !pool.length) return { kind: 'none' };
  if (pool.length >= 2) return { kind: 'pool', pool, freeProfileId: poolFreeProfileId(pool) };
  const key = poolKeyOf(pool[0].model);
  if (key === POOL_FREE_KEY) return { kind: 'single', workers: 'free', freeProfileId: freeProfileIdOf(pool[0].model) };
  const model = entryModel(pool[0], agyList) || concreteModel(key, null, agyList);
  if (!model) return { kind: 'error', error: 'badAgyModel' };
  const level = runsOnOf(key) === 'claude' ? poolEffortLevel(pool[0]) : null;
  return { kind: 'single', workerModel: model, ...(level ? { workerEffort: level } : {}) };
}

/**
 * The pool picker's menu (agy families by their live variants, free profiles).
 * @param {{agyList:{id:string,name:string}[], profiles:object[], isFreeProfile:(p:object) => boolean,
 *   isCodingProfile:(p:object) => boolean}} input
 * @returns {{models:{model:string, available:boolean, variants:{id:string,name:string}[]}[],
 *   free:{model:string, name:string, coding:boolean}[]}}
 */
function poolOptions({ agyList, profiles, isFreeProfile, isCodingProfile }) {
  const models = POOL_MODEL_LIST.map((m) => {
    if (m.runsOn !== 'agy') return { model: m.id, available: true, variants: [], defaultVariant: null };
    const live = agyFamilyVariants(agyList, m.family);
    const variants = live.map((v) => ({ id: agyVariant(v.id), name: cleanName(v.name) })).filter((v) => v.id);
    // The variant a one-model pool (or a package without an effort) runs: concreteModel's pick.
    return { model: m.id, available: variants.length > 0, variants, defaultVariant: agyVariant(agyVariantFor(live, null)) };
  });
  const free = (Array.isArray(profiles) ? profiles : [])
    .filter((p) => p && isFreeProfile(p))
    .map((p) => ({ model: freePoolModel(p.id), name: cleanName(p.name || p.id), coding: isCodingProfile(p) === true }))
    .filter((p) => p.model);
  return { models, free };
}

// ---- the run report -------------------------------------------------------------

const MAX_REPORT_CELL = 200;
/** One table cell: one line, no control characters, no pipes breaking the row, capped. */
const reportCell = (v) =>
  String(v == null || v === '' ? '-' : v)
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\|/g, '\\|')
    .trim()
    .slice(0, MAX_REPORT_CELL);

/** Why a pool package runs on its model: the planner's reason, and a move out of the pool. */
function reportWhy(p) {
  const moved = p.poolFrom ? `planner picked ${p.poolFrom} (not in the pool)` : '';
  return [moved, typeof p.modelReason === 'string' ? p.modelReason : ''].filter(Boolean).join('; ');
}

/** A package's pool model for the report, with the effort its pool entry fixes ('Opus - xhigh'). */
function reportModel(view, p) {
  const name = poolModelName(p.poolModel) || (p.poolModel === POOL_FREE_KEY ? 'free' : '-');
  const level = packagePoolEffort(view.modelPool, p);
  return level ? `${name} - ${level}` : name;
}

/**
 * A pool run's per-package rows: [package, pool model, runs on, why]; null
 * for any other run (no pool on the view).
 * @param {{modelPool?:object[], packages?:object[]}} view orchestra view()
 * @returns {string[][]|null}
 */
function poolReportRows(view) {
  if (!view || !Array.isArray(view.modelPool) || !view.modelPool.length) return null;
  return (Array.isArray(view.packages) ? view.packages : [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => [String(p.id || ''), reportModel(view, p), String(p.model || '-'), reportWhy(p)]);
}

/**
 * The morning report's "Worker models" section of a pool run; [] otherwise.
 * @param {{modelPool?:object[], packages?:object[]}} view
 * @returns {string[]} markdown lines
 */
function poolReportLines(view) {
  const rows = poolReportRows(view);
  if (!rows) return [];
  return [
    '',
    '## Worker models (pool run)',
    '',
    `- Pool: ${reportCell(poolLabel(view.modelPool))}`,
    '',
    '| Package | Model | Runs on | Why |',
    '|---|---|---|---|',
    ...rows.map(([id, key, on, why]) => `| \`${reportCell(id).replace(/`/g, "'")}\` | ${reportCell(key)} | ${reportCell(on)} | ${reportCell(why)} |`),
  ];
}

module.exports = {
  poolReportRows,
  poolReportLines,
  poolNeedsAgy,
  livePool,
  isLivePool,
  concreteModel,
  applyPool,
  approveChoice,
  poolOptions,
};
