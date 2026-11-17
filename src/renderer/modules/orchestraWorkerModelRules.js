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

import { WORKER_MODELS, MODEL_NAMES, DEFAULT_WORKER_MODEL, AGY_MODEL, isWorkerModel, isAgyModel, agyModelIdOf, agyModelLabel } from '../../workerModels.js';

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
  if (workers === 'agy') return agyChoiceOf(pkg, workerModel);
  if (workers === 'hybrid' && pkg && isAgyModel(pkg.model) && !override) return pkg.model;
  return packageModelOf(pkg, workerModel);
}

/**
 * Which agy choice a package of an agy run uses ('agy' or 'agy:<id>'):
 * mirrors src/orchestraAgy.js packageAgyModel - an agy override, the
 * package's own agy pick, the run's agy model, else plain 'agy'.
 */
function agyChoiceOf(pkg, workerModel) {
  const p = pkg && typeof pkg === 'object' ? pkg : {};
  const override = typeof p.modelOverride === 'string' && p.modelOverride ? p.modelOverride : null;
  if (override) return isAgyModel(override) ? override : AGY_MODEL;
  if (isAgyModel(p.model)) return p.model;
  return isAgyModel(workerModel) ? workerModel : AGY_MODEL;
}

/**
 * 'Opus' / 'Sonnet' / ... for a known model, 'Antigravity - <id>' for an agy
 * variant (the caller swaps in the live name when it has one), the raw id
 * otherwise.
 */
export function modelName(model) {
  if (Object.prototype.hasOwnProperty.call(MODEL_NAMES, model)) return MODEL_NAMES[model];
  return agyModelLabel(model) || String(model || '');
}

/**
 * The ids a worker-model select offers: the shared list with the live agy
 * variants right after plain 'agy', plus the current choice when it is a
 * variant the live list does not hold (a saved pick stays visible and
 * selected; main checks it again at Approve).
 * @param {string[]} variants 'agy:<id>' ids from main's `agy models` list
 * @param {string|null} [current]
 * @returns {string[]}
 */
export function workerModelChoices(variants, current = null) {
  const live = (Array.isArray(variants) ? variants : []).filter((v) => agyModelIdOf(v) !== null);
  if (agyModelIdOf(current) !== null && !live.includes(current)) live.push(current);
  const out = [];
  for (const id of WORKER_MODELS) {
    out.push(id);
    if (id === AGY_MODEL) out.push(...new Set(live));
  }
  return out;
}

/**
 * The card's model text for an agy worker: the badge's name, plus the model
 * the tab's transcript reported when the choice was plain 'agy'.
 * @param {string} badge what badgeModelOf returned
 * @param {string} name its display name
 * @param {unknown} ranOn the package view's agyModel (main: src/orchestra.js)
 * @returns {string}
 */
export function agyBadgeText(badge, name, ranOn) {
  // Only plain 'agy' leaves the model to agy; a variant already names it.
  if (badge !== AGY_MODEL || typeof ranOn !== 'string' || !ranOn.trim()) return name;
  return `${name} - ${ranOn.trim().slice(0, 80)}`;
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
