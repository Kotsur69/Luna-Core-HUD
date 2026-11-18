// ============================================================================
// LunaCore - God Mode worker model rules (pure half of orchestraWorkerModel.js)
// ----------------------------------------------------------------------------
// The run's worker model choices and the model each package card's badge
// shows. packageModelOf mirrors src/orchestraWorkerModel.js packageModelOf
// (the renderer cannot require main-side modules); test/orchestra-worker-model.test.js
// runs both over the same cases. No DOM; its only import is the pure shared
// list (src/workerModels.js), so node --test reads it directly.
// ============================================================================

'use strict';

import { WORKER_MODELS, MODEL_NAMES, DEFAULT_WORKER_MODEL, AGY_MODEL, isWorkerModel, isAgyModel } from '../../workerModels.js';

/** The shared list (src/workerModels.js). Main allow-lists the choice again. */
export { WORKER_MODELS, DEFAULT_WORKER_MODEL };
/** A 'plan' run package the planner gave no model runs here (main does the same). */
const PLAN_FALLBACK_MODEL = 'opus';
/** src/orchestraWorkers.js FREE_PACKAGE_CLAUDE_MODEL: a hybrid "free" package's Claude model. */
const FREE_PACKAGE_CLAUDE_MODEL = 'sonnet';

/** One of WORKER_MODELS, else null. */
export function normalizeWorkerModel(value) {
  return isWorkerModel(value) ? value : null;
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

/**
 * What a package card's badge names: null for a Free-only run (no Claude
 * worker), 'free' for a hybrid package a free worker takes (src/orchestraHybrid.js
 * runsFree: marked free, not handed to Claude yet), else packageModelOf.
 * @param {{modelOverride?:string|null, model?:string|null}|null} pkg
 * @param {string|null|undefined} workerModel the run's model
 * @param {string|null|undefined} workers the run's "Workers" choice
 * @returns {string|null}
 */
export function badgeModelOf(pkg, workerModel, workers) {
  if (workers === 'free') return null;
  const override = pkg && typeof pkg.modelOverride === 'string' && pkg.modelOverride;
  if (workers === 'hybrid' && pkg && pkg.model === 'free' && !override) return 'free';
  // Antigravity (src/orchestraAgy.js packageRunsAgy): an agy run, or a hybrid agy pick not handed over.
  if (workers === 'agy') return AGY_MODEL;
  if (workers === 'hybrid' && pkg && isAgyModel(pkg.model) && !override) return AGY_MODEL;
  return packageModelOf(pkg, workerModel);
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
