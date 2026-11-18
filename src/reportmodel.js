// ============================================================================
// LunaCore - which model writes the weekly review and the brief (main only)
// ----------------------------------------------------------------------------
// The weekly review (src/weeklyreview.js) and the daily / Monday brief
// (src/missionbrief.js) each store their model as a report model:
//
//   {provider: 'claude', model: 'haiku' | 'sonnet' | 'opus'}
//   {provider: 'agy',    model: null}          agy's own default model
//   {provider: 'agy',    model: '<agy id>'}    one model of `agy models`,
//                                              e.g. gemini-4-hydrogen-low
//
// Older stores hold a plain string ('haiku', or 'agy' in the weekly one):
// normalizeReportModel reads those as the same object, so an old PC's file
// keeps working. The pickers (Settings -> AI and models, the Week tab, the
// brief card) exchange a choice id with main: a Claude alias, 'agy' or
// 'agy:<id>' (src/workerModels.js), never the object itself.
//
//   normalizeReportModel(raw)    stored value -> report model (shape only)
//   choiceOf(rm) / runModelOf()  report model -> picker id / runJob's model
//   reportModelLabel(rm, names)  the name a page or an email shows
//   reportModelChoices(cache)    [{id, name}]: Claude models + live agy list
//   parseChoice(value, cache)    a renderer's choice, checked against the
//                                real lists (agy ids: the live `agy models`)
//
// Shape checks alone never let an agy id reach an argv: execAgy checks the id
// against the live list again before it runs (src/agyexec.js).
// ============================================================================

'use strict';

const { MISSION_MODELS, DEFAULT_MISSION_MODEL } = require('./missionrunner');
const { AGY_MODEL, isAgyModelId, agyModelIdOf, agyVariant, agyModelLabel } = require('./workerModels');

const CLAUDE = 'claude';
const AGY = 'agy';
const REPORT_PROVIDERS = Object.freeze([CLAUDE, AGY]);
/** The product name of each provider, for labels and error lines. */
const PROVIDER_NAMES = Object.freeze({ [CLAUDE]: 'Claude', [AGY]: 'Antigravity (agy)' });
const DEFAULT_REPORT_MODEL = Object.freeze({ provider: CLAUDE, model: DEFAULT_MISSION_MODEL });

const claudeModel = (model) => ({ provider: CLAUDE, model });
const agyModel = (id) => ({ provider: AGY, model: id });

/**
 * A choice id ('haiku', 'agy', 'agy:<id>') as a report model, by shape only,
 * else null.
 * @param {unknown} value
 * @returns {{provider:string, model:string|null}|null}
 */
function fromChoice(value) {
  if (typeof value !== 'string') return null;
  if (MISSION_MODELS.includes(value)) return claudeModel(value);
  if (value === AGY_MODEL) return agyModel(null);
  const id = agyModelIdOf(value);
  return id ? agyModel(id) : null;
}

/** A stored {provider, model} object, by shape only, else null. */
function fromObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.provider === CLAUDE) return MISSION_MODELS.includes(raw.model) ? claudeModel(raw.model) : null;
  if (raw.provider === AGY) {
    if (raw.model === null || raw.model === undefined) return agyModel(null);
    return isAgyModelId(raw.model) ? agyModel(raw.model) : null;
  }
  return null;
}

/**
 * A stored model (a {provider, model} object, or an old plain string) as a
 * report model; anything unreadable -> `fallback` (null: null). Shape only:
 * whether an agy id is still on the account's list is checked when it runs.
 * @param {unknown} raw
 * @param {{provider:string, model:string|null}|null} [fallback]
 * @returns {{provider:string, model:string|null}|null}
 */
function normalizeReportModel(raw, fallback = DEFAULT_REPORT_MODEL) {
  const rm = fromChoice(raw) || fromObject(raw);
  return rm || (fallback ? { ...fallback } : null);
}

/** True for an agy report model. */
const isAgyReport = (rm) => Boolean(rm) && rm.provider === AGY;

/** The picker id of a report model: 'haiku', 'agy' or 'agy:<id>'. */
function choiceOf(rm) {
  const r = normalizeReportModel(rm);
  if (r.provider === CLAUDE) return r.model;
  return r.model ? agyVariant(r.model) : AGY_MODEL;
}

/** The `model` runJob takes (src/missionrunner.js): the same as the picker id. */
const runModelOf = choiceOf;

/**
 * The name a page or an email shows: 'Haiku', 'Antigravity' or
 * 'Antigravity - <name>' (`names`: agy id -> name from `agy models`).
 * @param {unknown} rm
 * @param {Record<string,string>|null} [names]
 */
function reportModelLabel(rm, names = null) {
  const r = normalizeReportModel(rm);
  if (r.provider === CLAUDE) return r.model.charAt(0).toUpperCase() + r.model.slice(1);
  return agyModelLabel(choiceOf(r), names);
}

/**
 * What a picker offers: the Claude models, then plain 'agy' and every model
 * of the last good `agy models` call (cached; this never spawns agy).
 * @param {{choices:()=>{id:string, name:string}[]}|null} agyModels
 * @returns {{id:string, name:string}[]}
 */
function reportModelChoices(agyModels) {
  const claude = MISSION_MODELS.map((m) => ({ id: m, name: reportModelLabel(claudeModel(m)) }));
  let agy = [{ id: AGY_MODEL, name: agyModelLabel(AGY_MODEL) }];
  try {
    if (agyModels && typeof agyModels.choices === 'function') agy = agyModels.choices();
  } catch (err) {
    console.error('[reportmodel] agy model list unavailable:', err && err.message);
  }
  return [...claude, ...agy];
}

/**
 * A renderer's choice, checked against the real lists: a Claude model of
 * MISSION_MODELS, plain 'agy', or 'agy:<id>' whose id the live `agy models`
 * list holds (read once if it never was). Never trusts the renderer.
 * @param {unknown} value
 * @param {{ensure:()=>Promise<unknown>, isKnownId:(id:string)=>boolean}} agyModels
 * @returns {Promise<{provider:string, model:string|null}|null>} null = refused
 */
async function parseChoice(value, agyModels) {
  const rm = fromChoice(value);
  if (!rm) return null;
  if (rm.provider === CLAUDE || rm.model === null) return rm;
  if (!agyModels || typeof agyModels.ensure !== 'function') return null;
  await agyModels.ensure();
  return agyModels.isKnownId(rm.model) ? rm : null;
}

module.exports = {
  REPORT_PROVIDERS,
  PROVIDER_NAMES,
  DEFAULT_REPORT_MODEL,
  normalizeReportModel,
  isAgyReport,
  choiceOf,
  runModelOf,
  reportModelLabel,
  reportModelChoices,
  parseChoice,
};
