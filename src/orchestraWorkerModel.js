// ============================================================================
// LunaCore - God Mode worker model (which Claude model the run's workers use)
// ----------------------------------------------------------------------------
// The run's choice is the ui pref orchestraWorkerModel (Settings, the Approve
// screen, the phone's godmode.launch): opus (default) / sonnet / fable /
// 'plan' = each package on the model the planner picked for it. It is frozen
// into plan.workerModel when the run starts; a started run never changes.
//
// packageModelOf() is the one rule for the model a package runs on. The
// board's badge mirrors it (src/renderer/modules/orchestraWorkerModelRules.js,
// kept in line by test/orchestra-worker-model.test.js). Pure, no I/O.
// ============================================================================

'use strict';

const { ORCHESTRA_WORKER_MODELS } = require('./uiprefs');
const { claudeModelOf } = require('./orchestraWorkers');

/** The run model nobody chose: today's default. */
const DEFAULT_WORKER_MODEL = 'opus';
/** A 'plan' run package the planner gave no model runs here. */
const PLAN_FALLBACK_MODEL = 'opus';

/** One of ORCHESTRA_WORKER_MODELS, else null. */
function normalizeWorkerModel(value) {
  return ORCHESTRA_WORKER_MODELS.includes(value) ? value : null;
}

/**
 * The Claude model a package runs on: an escalation / hand-over override,
 * else for a 'plan' run the planner's pick ('free' -> Sonnet, none -> Opus),
 * else the run's model.
 * @param {{modelOverride?:string|null, model?:string|null}|null} pkg
 * @param {string|null|undefined} workerModel the run's (frozen) choice
 * @returns {string}
 */
function packageModelOf(pkg, workerModel) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  if (typeof p.modelOverride === 'string' && p.modelOverride) return p.modelOverride;
  if (workerModel === 'plan') return claudeModelOf(typeof p.model === 'string' && p.model ? p.model : null) || PLAN_FALLBACK_MODEL;
  return typeof workerModel === 'string' && workerModel ? workerModel : DEFAULT_WORKER_MODEL;
}

module.exports = {
  ORCHESTRA_WORKER_MODELS,
  DEFAULT_WORKER_MODEL,
  PLAN_FALLBACK_MODEL,
  normalizeWorkerModel,
  packageModelOf,
};
