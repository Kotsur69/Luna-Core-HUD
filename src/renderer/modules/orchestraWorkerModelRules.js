// ============================================================================
// LunaCore - God Mode worker model rules (pure half of orchestraWorkerModel.js)
// ----------------------------------------------------------------------------
// The run's worker model choices and the model each package card's badge
// shows. packageModelOf mirrors src/orchestraWorkerModel.js packageModelOf
// (the renderer cannot require main-side modules); test/orchestra-worker-model.test.js
// runs both over the same cases. No DOM, no imports: node --test reads it directly.
// ============================================================================

'use strict';

/** src/uiprefs.js ORCHESTRA_WORKER_MODELS. Main allow-lists the choice again. */
export const WORKER_MODELS = ['opus', 'sonnet', 'fable', 'plan'];
export const DEFAULT_WORKER_MODEL = 'opus';
/** A 'plan' run package the planner gave no model runs here (main does the same). */
const PLAN_FALLBACK_MODEL = 'opus';
/** src/orchestraWorkers.js FREE_PACKAGE_CLAUDE_MODEL: a hybrid "free" package's Claude model. */
const FREE_PACKAGE_CLAUDE_MODEL = 'sonnet';
/** Product names of the Claude models a worker can run on. */
const MODEL_NAMES = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', haiku: 'Haiku' };

/** One of WORKER_MODELS, else null. */
export function normalizeWorkerModel(value) {
  return WORKER_MODELS.includes(value) ? value : null;
}

/**
 * The model a package will run on: an escalation / hand-over override, else
 * for a 'plan' run the planner's pick ('free' -> Sonnet, none -> Opus), else
 * the run's model.
 * @param {{modelOverride?:string|null, model?:string|null}|null} pkg
 * @param {string|null|undefined} workerModel
 * @returns {string}
 */
export function packageModelOf(pkg, workerModel) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  if (typeof p.modelOverride === 'string' && p.modelOverride) return p.modelOverride;
  if (workerModel === 'plan') {
    const picked = typeof p.model === 'string' && p.model ? p.model : null;
    return (picked === 'free' ? FREE_PACKAGE_CLAUDE_MODEL : picked) || PLAN_FALLBACK_MODEL;
  }
  return typeof workerModel === 'string' && workerModel ? workerModel : DEFAULT_WORKER_MODEL;
}

/** 'Opus' / 'Sonnet' / ... for a known model, the raw id otherwise. */
export function modelName(model) {
  return Object.prototype.hasOwnProperty.call(MODEL_NAMES, model) ? MODEL_NAMES[model] : String(model || '');
}

/**
 * The run model the board uses: a started (or scheduled) run's frozen one as
 * main holds it, else the Approve screen's choice, else the plan view's (the
 * saved pref), else Opus.
 * @param {{started?:boolean, scheduledAt?:number|null, workerModel?:string}|null} plan
 * @param {string|null} picked the choice on screen (null before the pref loaded)
 * @returns {string}
 */
export function runWorkerModel(plan, picked) {
  const own = plan && typeof plan.workerModel === 'string' && plan.workerModel ? plan.workerModel : null;
  if (plan && (plan.started || plan.scheduledAt)) return own || DEFAULT_WORKER_MODEL;
  return normalizeWorkerModel(picked) || normalizeWorkerModel(own) || DEFAULT_WORKER_MODEL;
}
