// ============================================================================
// LunaCore - the God Mode worker-model list (the one source of truth)
// ----------------------------------------------------------------------------
// Which model a God Mode run's workers use: the Settings select, the Approve
// screen, the phone's plan view, the `godmode` snapshot and every allow-list
// that gates the stored ui pref (src/uiprefs.js), a task card's model
// (src/todorows.js) or a plan package's model (src/orchestraPlan.js
// PACKAGE_MODELS) derive from WORKER_MODEL_LIST below. Adding a worker model
// here needs no other edit for those: none of them keeps its own copy
// (test/worker-models.test.js fails if one does). Out of scope: the models
// the planner is OFFERED (orchestraPlan.js MODELS / HYBRID_MODELS) and Luna's
// Work's role models (src/lunasworkRules.js), which are separate choices.
//
//   WORKER_MODELS       the run choices, in menu order ('plan' last)
//   CARD_MODELS         the concrete models: WORKER_MODELS without 'plan'
//   WORKER_MODEL_NAMES  id -> product name ('plan' has none: each UI
//                       localizes it)
//   MODEL_NAMES         the same plus haiku: every product name a UI shows
//   isAgyModel()        'agy' or an 'agy:<id>' variant (a model of `agy
//                       models`, read live by src/agymodels.js): the one
//                       "runs on agy" test
//
// Pure and import-free (src/filediff.js's rule): written as an ES module so
// the renderer (src/renderer/modules/*) and the phone bundle (mobile/, Vite)
// import it directly, while main and `node --test` load it with require()
// (require(esm): Node >= 22.12, which Electron 43 ships). It touches no
// global and no Node built-in.
// ============================================================================

'use strict';

/** The Antigravity CLI as a worker (src/claudeModels.js re-exports it). */
export const AGY_MODEL = 'agy';
/** "Planner's pick": each package runs on the model the planner gave it. */
export const PLAN_WORKER_MODEL = 'plan';
/** The run model nobody chose. */
export const DEFAULT_WORKER_MODEL = 'opus';

/** Every God Mode worker-model choice, in the order the menus show them. */
export const WORKER_MODEL_LIST = Object.freeze([
  Object.freeze({ id: 'opus', name: 'Opus' }),
  Object.freeze({ id: 'sonnet', name: 'Sonnet' }),
  Object.freeze({ id: 'fable', name: 'Fable' }),
  Object.freeze({ id: AGY_MODEL, name: 'Antigravity' }),
  Object.freeze({ id: PLAN_WORKER_MODEL, name: null }),
]);

/** The ids of WORKER_MODEL_LIST: the stored orchestraWorkerModel allow-list. */
export const WORKER_MODELS = Object.freeze(WORKER_MODEL_LIST.map((m) => m.id));

/** A model a single package or task card can name: every choice but 'plan'. */
export const CARD_MODELS = Object.freeze(WORKER_MODELS.filter((id) => id !== PLAN_WORKER_MODEL));

/** id -> product name, for every choice that has one. */
export const WORKER_MODEL_NAMES = Object.freeze(
  Object.fromEntries(WORKER_MODEL_LIST.filter((m) => m.name).map((m) => [m.id, m.name])),
);

/**
 * Product names of every model id a LunaCore UI shows: the worker models plus
 * haiku, a Claude alias that is no worker choice but can still appear (an
 * escalation override, src/claudeModels.js MODEL_LABELS).
 */
export const MODEL_NAMES = Object.freeze({ ...WORKER_MODEL_NAMES, haiku: 'Haiku' });

// ---- Antigravity model variants ---------------------------------------------
// 'agy' runs on agy's own default model. 'agy:<id>' runs on one model of
// `agy models` (src/agymodels.js reads that list live in main): the id goes
// to agy as `--model <id>`. The ids differ per account, so no list of them
// lives here - only their shape. This shape check is all the renderer and the
// phone can do; main also checks the id against the live list before it
// reaches any argv.

/** The prefix of an agy model variant: 'agy:<id>'. */
export const AGY_VARIANT_PREFIX = `${AGY_MODEL}:`;
/** Longest agy model id accepted (real ones are under 40 characters). */
export const MAX_AGY_MODEL_ID_CHARS = 80;
/**
 * An agy model id: letters, digits, dots and dashes, starting with a letter
 * or digit - so an id can never read as a flag (`--print`) in an argv.
 */
export const AGY_MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]*$/i;

/** True for a well-formed agy model id (no prefix). */
export function isAgyModelId(id) {
  return typeof id === 'string' && id.length <= MAX_AGY_MODEL_ID_CHARS && AGY_MODEL_ID_RE.test(id);
}

/** The id of an 'agy:<id>' variant, else null (plain 'agy' has none). */
export function agyModelIdOf(model) {
  if (typeof model !== 'string' || !model.startsWith(AGY_VARIANT_PREFIX)) return null;
  const id = model.slice(AGY_VARIANT_PREFIX.length);
  return isAgyModelId(id) ? id : null;
}

/** 'agy:<id>' for a well-formed id, else null. */
export function agyVariant(id) {
  return isAgyModelId(id) ? `${AGY_VARIANT_PREFIX}${id}` : null;
}

/** True for one of WORKER_MODELS or an 'agy:<id>' variant. */
export function isWorkerModel(value) {
  return typeof value === 'string' && (WORKER_MODELS.includes(value) || agyModelIdOf(value) !== null);
}

/** True for one of CARD_MODELS or an 'agy:<id>' variant. */
export function isCardModel(value) {
  return typeof value === 'string' && (CARD_MODELS.includes(value) || agyModelIdOf(value) !== null);
}

/**
 * True when the model runs on the Antigravity CLI rather than Claude: plain
 * 'agy' (agy's default model) or a well-formed 'agy:<id>' variant. The one
 * test for "is this agy" - never compare with AGY_MODEL directly.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isAgyModel(model) {
  return model === AGY_MODEL || agyModelIdOf(model) !== null;
}

/**
 * The name a UI shows for an agy choice: 'Antigravity' for plain 'agy',
 * 'Antigravity - <name>' for a variant, where `names` maps an id to the name
 * `agy models` gave it (the id itself when it gave none). Null for anything
 * that is not an agy choice.
 * @param {unknown} model
 * @param {Record<string,string>|null} [names] id -> name
 * @returns {string|null}
 */
export function agyModelLabel(model, names = null) {
  if (model === AGY_MODEL) return WORKER_MODEL_NAMES[AGY_MODEL];
  const id = agyModelIdOf(model);
  if (!id) return null;
  const own = names && typeof names === 'object' && Object.prototype.hasOwnProperty.call(names, id) ? names[id] : null;
  return `${WORKER_MODEL_NAMES[AGY_MODEL]} - ${typeof own === 'string' && own ? own : id}`;
}
