// ============================================================================
// LunaCore - per-model effort of a God Mode "Workers" pool, main side (pure)
// ----------------------------------------------------------------------------
// src/poolEffort.js holds the shared rules (the select, the badge); this
// module is what main does with them. src/orchestraPool.js and
// src/orchestraPoolWiring.js call it at plan time and at Approve, and
// src/orchestra.js at launch:
//
//   liveEfforts(pool, agyList)     every agy variant checked against the live
//                                  `agy models` list; one the family lacks
//                                  falls back to "Per plan" with a board note
//   entryModel(entry, agyList)     the 'agy:<id>' an agy entry's variant runs
//   claudePoolEffort(pool, pkg)    the --effort a Claude pool package runs at
//                                  (src/orchestra.js effortFor), else null
//   familyFallback(pkg, list, e)   at launch: the family's live variant for a
//                                  pool package whose variant left the list
//
// "Per plan" on every entry, and every run without a pool, changes nothing.
// ============================================================================

'use strict';

const { agyFamilyOf, agyFamilyVariants, agyVariantFor, runsOnOf, poolKeyOf, POOL_EFFORT_PLAN } = require('./workerPool');
const { packagePoolEffort } = require('./poolEffort');
const { normalizeEffort } = require('./efforts');
const { agyVariant, agyModelIdOf } = require('./workerModels');

/** Board note: an agy entry's variant is not on the live list, so it runs "Per plan". */
const NOTE_VARIANT_MISSING = 'poolEffortMissing';
/** Board note: a package's agy variant left the live list before it started. */
const NOTE_VARIANT_GONE = 'agyVariantGone';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The live variants of an agy pool key's family. */
const familyVariants = (key, agyList) => agyFamilyVariants(agyList, agyFamilyOf(key));

/**
 * The 'agy:<id>' an agy entry's chosen variant runs on, when the live list
 * holds it for that family; null for "Per plan", any other model, or a
 * variant the list lacks.
 * @param {{model:string, effort:string}|null} entry
 * @param {{id:string, name:string}[]} agyList
 * @returns {string|null}
 */
function entryModel(entry, agyList) {
  if (!isObj(entry) || entry.effort === POOL_EFFORT_PLAN) return null;
  const key = poolKeyOf(entry.model);
  if (runsOnOf(key) !== 'agy') return null;
  const id = agyModelIdOf(entry.effort);
  return id && familyVariants(key, agyList).some((v) => v.id === id) ? agyVariant(id) : null;
}

/**
 * The pool with every agy variant checked against the live list: a variant
 * the family lacks there becomes "Per plan" (the family's own pick per
 * package, as before efforts existed) and leaves one board note.
 * @param {{model:string, effort:string}[]} pool normalizePool() output
 * @param {{id:string, name:string}[]} agyList
 * @returns {{pool:{model:string, effort:string}[], notes:{code:string, model:string, from:string}[]}}
 */
function liveEfforts(pool, agyList) {
  const notes = [];
  const out = (Array.isArray(pool) ? pool : []).map((e) => {
    const key = poolKeyOf(e.model);
    if (runsOnOf(key) !== 'agy' || e.effort === POOL_EFFORT_PLAN || entryModel(e, agyList)) return e;
    notes.push({ code: NOTE_VARIANT_MISSING, model: key, from: e.effort });
    return { ...e, effort: POOL_EFFORT_PLAN };
  });
  return { pool: out, notes };
}

/**
 * The --effort level a Claude pool package runs at because its model's
 * entry fixes one (src/orchestra.js effortFor, below an escalation
 * override); null for "Per plan", agy / free packages and runs without a pool.
 *
 * Null for agy on purpose (decided 2026-11-24): an agy entry's setting is a
 * VARIANT ('agy:<id>'), not an effort level. It only selects the model the
 * package runs on (entryModel); the level packagePoolEffort reads off the
 * id's tail is a label for the badge and the report, and the variant already
 * carries it. An agy tab therefore gets the package's own effort as --effort
 * through effortFor's later steps (Settings level, planner pick, default).
 * @param {unknown} pool the plan's modelPool
 * @param {object} pkg
 * @returns {string|null}
 */
function claudePoolEffort(pool, pkg) {
  if (!Array.isArray(pool) || !isObj(pkg) || runsOnOf(pkg.poolModel) !== 'claude') return null;
  return normalizeEffort(packagePoolEffort(pool, pkg));
}

/**
 * At launch: the live variant of a pool package's agy family nearest its
 * effort, for a package whose own variant is no longer on the list; null
 * for a package outside an agy pool family or a family the list lacks.
 * @param {{poolModel?:unknown}} pkg
 * @param {{id:string, name:string}[]} agyList
 * @param {string|null} effort the package's worker effort
 * @returns {string|null}
 */
function familyFallback(pkg, agyList, effort) {
  if (!isObj(pkg) || runsOnOf(pkg.poolModel) !== 'agy') return null;
  return agyVariant(agyVariantFor(familyVariants(pkg.poolModel, agyList), effort));
}

/**
 * Board notes added to a plan's warnings, each once (same code, model /
 * package and variant).
 * @param {object[]} warnings
 * @param {object[]} notes
 * @returns {object[]}
 */
function withNotes(warnings, notes) {
  const list = Array.isArray(warnings) ? warnings : [];
  const same = (a, b) => a.code === b.code && a.model === b.model && a.id === b.id && a.from === b.from;
  const fresh = (Array.isArray(notes) ? notes : []).filter((n) => isObj(n) && !list.some((w) => isObj(w) && same(w, n)));
  return fresh.length ? [...list, ...fresh] : list;
}

module.exports = {
  NOTE_VARIANT_MISSING,
  NOTE_VARIANT_GONE,
  entryModel,
  liveEfforts,
  claudePoolEffort,
  familyFallback,
  withNotes,
};
