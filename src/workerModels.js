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

/** True for one of WORKER_MODELS. */
export function isWorkerModel(value) {
  return typeof value === 'string' && WORKER_MODELS.includes(value);
}

/** True for one of CARD_MODELS. */
export function isCardModel(value) {
  return typeof value === 'string' && CARD_MODELS.includes(value);
}

/**
 * True when the model runs on the Antigravity CLI rather than Claude.
 * Today only 'agy'; a later change adds 'agy:<id>' variants here.
 * @param {unknown} model
 * @returns {boolean}
 */
export function isAgyModel(model) {
  return model === AGY_MODEL;
}
