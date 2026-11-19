// ============================================================================
// LunaCore - the God Mode worker-model POOL (pure, shared)
// ----------------------------------------------------------------------------
// The "Workers" multi-select: the models Mati ticks for a run. The planner is
// offered exactly these and gives every package one of them by difficulty.
//
//   pool entry     {model, effort}. model is a POOL_MODEL_LIST id or
//                  'free:<profileId>' (a free provider profile, listed live);
//                  effort is 'plan' (= today's per-package effort) or one of
//                  the levels, kept for the per-model effort card - nothing
//                  reads a level yet.
//   planner key    what the planner names: the pool id, 'free' for a free
//                  profile (a run has at most one free profile).
//   tiers          easy (Sonnet, Hydrogen, a free profile) / hard (Opus, Opus
//                  on agy, Argon); "strongest" = first in STRENGTH_ORDER.
//
// A pool of 0 or 1 models changes nothing: it maps onto today's single
// worker-model value (src/orchestraPool.js). Only 2+ models make a pool run.
//
// agy ids are never shipped: an agy entry names a FAMILY (opus / argon /
// hydrogen) that is matched by name against the live `agy models` list
// (src/agymodels.js); agyVariantFor() picks the variant for a package effort.
//
// Pure and import-free like src/workerModels.js: the renderer and the phone
// import it as an ES module, main and `node --test` require() it.
// ============================================================================

'use strict';

/** The pool models other than free profiles, in the order the menus show them. */
export const POOL_MODEL_LIST = Object.freeze([
  Object.freeze({ id: 'opus', name: 'Opus', runsOn: 'claude', tier: 'hard', family: null }),
  Object.freeze({ id: 'sonnet', name: 'Sonnet', runsOn: 'claude', tier: 'easy', family: null }),
  Object.freeze({ id: 'agy-opus', name: 'Opus (agy)', runsOn: 'agy', tier: 'hard', family: 'opus' }),
  Object.freeze({ id: 'agy-argon', name: 'Argon (agy)', runsOn: 'agy', tier: 'hard', family: 'argon' }),
  Object.freeze({ id: 'agy-hydrogen', name: 'Hydrogen (agy)', runsOn: 'agy', tier: 'easy', family: 'hydrogen' }),
]);

/** The ids of POOL_MODEL_LIST. */
export const POOL_MODELS = Object.freeze(POOL_MODEL_LIST.map((m) => m.id));
/** The planner key of a free provider profile. */
export const POOL_FREE_KEY = 'free';
/** Strongest first: "if unsure, the strongest ticked model", and the out-of-pool fallback. */
export const STRENGTH_ORDER = Object.freeze(['opus', 'agy-opus', 'agy-argon', 'sonnet', 'agy-hydrogen', POOL_FREE_KEY]);
/** 'plan' + src/efforts.js EFFORTS (kept in line by test/worker-pool.test.js). */
export const POOL_EFFORTS = Object.freeze(['plan', 'medium', 'high', 'xhigh', 'max']);
/** The pool nobody chose: Opus only, today's run. */
export const DEFAULT_POOL = Object.freeze([Object.freeze({ model: 'opus', effort: 'plan' })]);
/** More entries than the menu can ever offer; the rest is ignored. */
export const MAX_POOL_ENTRIES = 12;

/** The prefix of a free provider profile entry: 'free:<profileId>'. */
export const FREE_POOL_PREFIX = `${POOL_FREE_KEY}:`;
/** A profile id as a pool entry may carry it (no colon, no spaces, no path characters). */
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const byId = (id) => POOL_MODEL_LIST.find((m) => m.id === id) || null;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The profile id of a 'free:<profileId>' entry, else null. */
export function freeProfileIdOf(model) {
  if (typeof model !== 'string' || !model.startsWith(FREE_POOL_PREFIX)) return null;
  const id = model.slice(FREE_POOL_PREFIX.length);
  return PROFILE_ID_RE.test(id) ? id : null;
}

/** 'free:<profileId>' for a well-formed id, else null. */
export function freePoolModel(profileId) {
  return typeof profileId === 'string' && PROFILE_ID_RE.test(profileId) ? `${FREE_POOL_PREFIX}${profileId}` : null;
}

/** True for a POOL_MODELS id or a well-formed 'free:<profileId>'. */
export function isPoolModel(model) {
  return POOL_MODELS.includes(model) || freeProfileIdOf(model) !== null;
}

/** The planner key of a pool model: the id itself, 'free' for a free profile, else null. */
export function poolKeyOf(model) {
  if (POOL_MODELS.includes(model)) return model;
  return freeProfileIdOf(model) !== null ? POOL_FREE_KEY : null;
}

/** True for a key the planner may be offered. */
export function isPoolKey(key) {
  return POOL_MODELS.includes(key) || key === POOL_FREE_KEY;
}

/** 'easy' / 'hard' of a planner key (a free profile is easy), else null. */
export function tierOf(key) {
  if (key === POOL_FREE_KEY) return 'easy';
  const m = byId(key);
  return m ? m.tier : null;
}

/** 'claude' / 'agy' / 'free' of a planner key, else null. */
export function runsOnOf(key) {
  if (key === POOL_FREE_KEY) return 'free';
  const m = byId(key);
  return m ? m.runsOn : null;
}

/** The agy family ('opus' / 'argon' / 'hydrogen') of an agy key, else null. */
export function agyFamilyOf(key) {
  const m = byId(key);
  return m ? m.family : null;
}

/** The product name of a pool id (null for a free profile: the UI names it). */
export function poolModelName(model) {
  const m = byId(model);
  return m ? m.name : null;
}

/**
 * The stored / sent pool, checked: an array of {model, effort} objects, a
 * valid model each, deduplicated, at most one free profile (a run's free
 * packages share one coding profile), capped. A missing effort is 'plan'; an
 * unknown one drops the entry. Anything but an array is null.
 * @param {unknown} raw
 * @returns {{model:string, effort:string}[]|null}
 */
export function normalizePool(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw.slice(0, MAX_POOL_ENTRIES)) {
    if (!isObj(entry) || !isPoolModel(entry.model)) continue;
    const effort = entry.effort === undefined ? 'plan' : entry.effort;
    if (!POOL_EFFORTS.includes(effort)) continue;
    if (out.some((e) => e.model === entry.model)) continue;
    if (freeProfileIdOf(entry.model) && out.some((e) => freeProfileIdOf(e.model))) continue;
    out.push({ model: entry.model, effort });
  }
  return out;
}

/** The planner keys of a pool, strongest first, each once. */
export function poolKeys(pool) {
  const keys = new Set((Array.isArray(pool) ? pool : []).map((e) => poolKeyOf(e && e.model)).filter(Boolean));
  return STRENGTH_ORDER.filter((k) => keys.has(k));
}

/** The strongest of some planner keys, else null. */
export function strongestKey(keys) {
  const list = Array.isArray(keys) ? keys : [];
  return STRENGTH_ORDER.find((k) => list.includes(k)) || null;
}

/** The free profile id a pool names, else null. */
export function poolFreeProfileId(pool) {
  const hit = (Array.isArray(pool) ? pool : []).find((e) => e && freeProfileIdOf(e.model));
  return hit ? freeProfileIdOf(hit.model) : null;
}

/** True when the pool makes a pool run: two or more models. */
export function isPoolRun(pool) {
  return Array.isArray(pool) && pool.length >= 2;
}

/**
 * The Workers mode a pool runs as. Two or more models with a free profile
 * run hybrid (the guard, the Sonnet review, the coding profile); a lone free
 * profile is today's "Free only"; anything else keeps the requested mode.
 * @param {{model:string}[]|null} pool
 * @param {string} requested the Workers select ('claude' / 'agy' / 'hybrid' / 'free')
 * @returns {string}
 */
export function poolWorkers(pool, requested) {
  const list = Array.isArray(pool) ? pool : [];
  if (requested === 'free' || requested === 'agy') return requested;
  if (list.length === 1 && freeProfileIdOf(list[0].model)) return 'free';
  if (list.length >= 2 && poolFreeProfileId(list)) return 'hybrid';
  if (list.length >= 2) return requested === 'hybrid' ? 'hybrid' : 'claude';
  return requested;
}

/**
 * The pool the HUD pickers open on. A saved pool wins; without one, the
 * single Settings model when it is a pool model (opus / sonnet), else none -
 * an empty pool means "the Settings worker model" (Fable, Planner's pick,
 * an agy variant ...), exactly as before the pool existed.
 * @param {{orchestraModelPool?:unknown, orchestraWorkerModel?:unknown}|null} prefs
 * @returns {{model:string, effort:string}[]}
 */
export function poolFromPrefs(prefs) {
  const p = isObj(prefs) ? prefs : {};
  const saved = normalizePool(p.orchestraModelPool);
  if (saved && saved.length) return saved;
  const single = p.orchestraWorkerModel === undefined || p.orchestraWorkerModel === null ? 'opus' : p.orchestraWorkerModel;
  return single === 'opus' || single === 'sonnet' ? [{ model: single, effort: 'plan' }] : [];
}

/**
 * The single worker-model value a one-model Claude pool stands for
 * ('opus' / 'sonnet'), else null.
 * @param {{model:string}[]|null} pool
 */
export function singleClaudeModel(pool) {
  if (!Array.isArray(pool) || pool.length !== 1) return null;
  return runsOnOf(pool[0].model) === 'claude' ? pool[0].model : null;
}

// ---- agy families -------------------------------------------------------------
// `agy models` lines look like `gemini-4-argon-medium  Gemini 4 Argon (Medium)`.
// A family matches the NAME with its "(...)" part removed, as a whole word, so
// "Orchestrator (Argon)" is no Argon model. The level comes from the id's last
// dash segment, else from the "(...)" part.

/** Effort-like levels a variant may carry, weakest first. */
const LEVEL_RANK = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4 });
/** The level a package without an effort (or 'plan') aims for. */
const DEFAULT_LEVEL = 'high';

const hasLevel = (word) => Object.prototype.hasOwnProperty.call(LEVEL_RANK, word);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const levelOf = (id, name) => {
  const tail = String(id).split('-').pop().toLowerCase();
  if (hasLevel(tail)) return tail;
  // [^()] keeps the scan linear on a name full of '(' (the input is capped anyway).
  const paren = /\(([^()]*)\)\s*$/.exec(String(name || ''));
  const word = paren ? paren[1].trim().toLowerCase() : '';
  return hasLevel(word) ? word : null;
};

/**
 * The variants of one agy family in a live model list, in the list's order.
 * @param {{id:string, name:string}[]} list the `agy models` list (src/agymodels.js)
 * @param {string} family 'opus' | 'argon' | 'hydrogen'
 * @returns {{id:string, name:string, level:string|null}[]}
 */
export function agyFamilyVariants(list, family) {
  if (typeof family !== 'string' || !family) return [];
  const re = new RegExp(`\\b${escapeRe(family)}\\b`, 'i');
  return (Array.isArray(list) ? list : [])
    .filter((m) => isObj(m) && typeof m.id === 'string' && re.test(String(m.name || m.id).replace(/\([^()]*\)\s*$/, '')))
    .map((m) => ({ id: m.id, name: String(m.name || m.id), level: levelOf(m.id, m.name) }));
}

/**
 * The variant a package runs: the level nearest its effort (ties go up, a
 * variant without a level counts as high); no effort or 'plan' aims at high.
 * @param {{id:string, level:string|null}[]} variants agyFamilyVariants()
 * @param {string|null} [effort]
 * @returns {string|null} the agy model id
 */
export function agyVariantFor(variants, effort = null) {
  const list = Array.isArray(variants) ? variants : [];
  if (!list.length) return null;
  const want = LEVEL_RANK[hasLevel(effort) ? effort : DEFAULT_LEVEL];
  const rank = (v) => LEVEL_RANK[v.level || DEFAULT_LEVEL];
  let best = list[0];
  for (const v of list) {
    const d = Math.abs(rank(v) - want);
    const bestD = Math.abs(rank(best) - want);
    if (d < bestD || (d === bestD && rank(v) > rank(best))) best = v;
  }
  return best.id;
}

/**
 * The pool after one checkbox changed: ticking adds the model (a second free
 * profile replaces the first - one per run), unticking removes it. Order is
 * kept; a new entry goes last with effort 'plan'.
 * @param {{model:string, effort:string}[]} pool
 * @param {string} model
 * @param {boolean} on
 * @returns {{model:string, effort:string}[]}
 */
export function togglePoolModel(pool, model, on) {
  const list = normalizePool(pool) || [];
  if (!isPoolModel(model)) return list;
  const rest = list.filter((e) => e.model !== model && !(on && freeProfileIdOf(model) && freeProfileIdOf(e.model)));
  return on ? [...rest, { model, effort: 'plan' }] : rest;
}

/** An 'agy:<id>' choice as src/workerModels.js shapes it (the id never reads as a flag). */
const AGY_VARIANT_RE = /^agy:[a-z0-9][a-z0-9.-]{0,79}$/i;
/** Longest live name the picker shows. */
const MAX_OPTION_NAME_CHARS = 120;
const optionName = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_OPTION_NAME_CHARS) : fallback);

/**
 * Main's pool menu (src/orchestraPool.js poolOptions), shape-checked for a
 * UI: known pool ids and 'agy:<id>'-shaped variants only, free entries with a
 * well-formed 'free:<profileId>', names as capped strings.
 * @param {unknown} raw
 * @returns {{models:{model:string, available:boolean, variants:{id:string,name:string}[], defaultVariant:string|null}[],
 *   free:{model:string, name:string, coding:boolean}[]}}
 */
export function cleanPoolOptions(raw) {
  const r = isObj(raw) ? raw : {};
  const models = (Array.isArray(r.models) ? r.models : [])
    .filter((m) => isObj(m) && POOL_MODELS.includes(m.model))
    .map((m) => {
      const variants = (Array.isArray(m.variants) ? m.variants : [])
        .filter((v) => isObj(v) && typeof v.id === 'string' && AGY_VARIANT_RE.test(v.id))
        .map((v) => ({ id: v.id, name: optionName(v.name, v.id) }));
      const fallback = variants.some((v) => v.id === m.defaultVariant) ? m.defaultVariant : null;
      return { model: m.model, available: m.available === true, variants, defaultVariant: fallback };
    });
  const free = (Array.isArray(r.free) ? r.free : [])
    .filter((f) => isObj(f) && freeProfileIdOf(f.model))
    .map((f) => ({ model: f.model, name: optionName(f.name, freeProfileIdOf(f.model)), coding: f.coding === true }));
  return { models, free };
}

/**
 * The pool's text for a run line: product names joined with ' + '.
 * @param {{model:string}[]} pool
 * @param {(model:string) => string|null} [nameOf] a free profile's name
 * @returns {string}
 */
export function poolLabel(pool, nameOf = () => null) {
  return (Array.isArray(pool) ? pool : [])
    .map((e) => poolModelName(e.model) || nameOf(e.model) || freeProfileIdOf(e.model) || String(e.model))
    .join(' + ');
}
