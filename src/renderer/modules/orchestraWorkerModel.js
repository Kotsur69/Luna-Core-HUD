// ============================================================================
// LunaCore - God Mode "Workers model" on the Approve screen
// ----------------------------------------------------------------------------
// The "Workers" pool picker (orchestraPoolPicker.js) next to Workers /
// Integration: the models the run may use. Nothing ticked or one Claude
// model is today's single worker model (Opus by default, or the Settings
// select's Fable / Planner's pick / agy variant); two or more make a pool
// run, where each package runs on the model the planner gave it.
// Approve sends {workerModel} or {modelPool} (launchModelFields); main
// validates both and freezes them for the run.
// Also the labels of the run line and each package card's model badge.
// Rules live in orchestraWorkerModelRules.js and src/workerPool.js; text goes
// in via textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { normalizeWorkerModel, badgeModelOf, modelName, runWorkerModel, agyBadgeText } from './orchestraWorkerModelRules.js';
import { agyChoiceName, refreshAgyModels } from './agyModelChoices.js';
import { loadPool, chosenPool, poolPickerView, poolText, agyDefaultVariant } from './orchestraPoolPicker.js';
import { isPoolRun, singleClaudeModel, poolWorkers, poolKeys, strongestKey, poolModelName, poolKeyOf, runsOnOf, POOL_FREE_KEY } from '../../workerPool.js';

/** The saved single worker model (the Settings select), or null before it was read. */
let picked = null;

/** Reads the saved prefs; an unreadable one keeps the choice already on screen. */
export async function loadWorkerModel() {
  // The live agy names for badges and the picker, before any picker opens (never throws).
  refreshAgyModels();
  await loadPool();
  try {
    const prefs = await window.lunacore.getUiPrefs();
    const saved = normalizeWorkerModel(prefs && prefs.orchestraWorkerModel);
    if (saved) picked = saved;
  } catch {
    /* prefs unreadable: the plan view's model (the pref main read) is used */
  }
}

/** A started (or scheduled) run: its models are frozen in main. */
const frozen = (plan) => Boolean(plan && (plan.started || plan.scheduledAt));

/**
 * Whether the run takes the Approve screen's model. A plan run keeps its own
 * worker pool (src/orchestraPlanRunStart.js); main ignores the choice there too.
 */
export const takesWorkerModel = (plan) => Boolean(plan) && !plan.planRun;

/**
 * The single worker-model value a pool on screen stands for: 'plan' for a
 * pool run, the model of a one-model pool (an agy family's live default
 * variant), null for none or a lone free profile ("Free only").
 */
function poolWorkerModel(list) {
  if (isPoolRun(list)) return 'plan';
  if (list.length !== 1) return null;
  const key = poolKeyOf(list[0].model);
  if (runsOnOf(key) === 'claude') return key;
  if (runsOnOf(key) === 'agy') return agyDefaultVariant(key) || 'agy';
  return null;
}

/** The run model the board shows: frozen in main once started, else the pool on screen, else the Settings model. */
export function chosenWorkerModel(plan) {
  if (!takesWorkerModel(plan) || frozen(plan)) return runWorkerModel(plan, picked);
  return poolWorkerModel(chosenPool()) || runWorkerModel(plan, picked);
}

/**
 * The Workers mode the board's badges use: a pool with a free profile runs
 * hybrid, a lone free profile "Free only" (src/workerPool.js poolWorkers).
 * @param {object} plan the plan view
 * @param {string} workers the Workers select
 */
export function chosenRunWorkers(plan, workers) {
  if (!takesWorkerModel(plan) || frozen(plan)) return workers;
  return poolWorkers(chosenPool(), workers);
}

/**
 * Approve's model fields: nothing ticked (or the Antigravity mode) = the
 * Settings model, one Claude model = that model - both exactly the payload
 * of before the pool - anything else the pool itself.
 * @param {object} plan the plan view
 * @param {string} workers the Workers select
 * @returns {{workerModel:string}|{modelPool:{model:string, effort:string}[]}}
 */
export function launchModelFields(plan, workers) {
  const list = chosenPool();
  if (workers === 'agy' || !list.length) return { workerModel: runWorkerModel(plan, picked) };
  const single = singleClaudeModel(list);
  return single ? { workerModel: single } : { modelPool: list };
}

/** 'Opus' / 'Sonnet' / 'Fable', an agy model's live name, or "Planner's pick" for 'plan'. */
export function workerModelLabel(model) {
  return model === 'plan' ? t('orchset.model.plan') : agyChoiceName(model) || modelName(model);
}

/** The run line's model: a plan run's pool as main holds it, a model pool, else the label. */
export function runModelLabel(plan) {
  if (!takesWorkerModel(plan)) return String((plan && plan.workerModel) || '');
  if (frozen(plan) && Array.isArray(plan.modelPool) && plan.modelPool.length) return poolText(plan.modelPool);
  if (!frozen(plan) && isPoolRun(chosenPool())) return poolText(chosenPool());
  return workerModelLabel(chosenWorkerModel(plan));
}

/**
 * Before Approve: a package planned on a model the pool on screen no longer
 * ticks will run on the strongest ticked one (main moves it at Approve).
 * The badge says so already; null when nothing moves.
 */
function movedBadge(pkg, plan) {
  if (frozen(plan) || !pkg || typeof pkg.poolModel !== 'string' || pkg.modelOverride) return null;
  const list = chosenPool();
  if (!isPoolRun(list)) return null;
  const keys = poolKeys(list);
  if (keys.includes(pkg.poolModel)) return null;
  const to = strongestKey(keys);
  return to === POOL_FREE_KEY ? t('orch.pkgModel.free') : poolModelName(to);
}

/**
 * The model badge of a package card: the model it will run on, "free model"
 * for a hybrid package a free worker takes, null for a Free-only run.
 * @param {object} pkg a plan view package
 * @param {object} plan the plan view
 * @param {string} workers the run's "Workers" choice (chosenRunWorkers before a start)
 */
export function packageModelBadge(pkg, plan, workers) {
  if (!takesWorkerModel(plan)) return pkg && pkg.model ? String(pkg.model) : null;
  const moved = workers === 'free' ? null : movedBadge(pkg, plan);
  if (moved) return moved;
  const model = badgeModelOf(pkg, chosenWorkerModel(plan), workers);
  if (!model) return null;
  if (model === 'free') return t('orch.pkgModel.free');
  // Plain 'agy': which model agy picked, as its transcript reports it.
  return agyBadgeText(model, workerModelLabel(model), pkg && pkg.agyModel);
}

/**
 * The label + pool picker. A change saves the pool pref (the picker does it)
 * and repaints the board.
 * @param {object} plan the plan view
 * @param {boolean} disabled
 * @param {() => void} onChange
 * @param {string} [workers] the Workers select: 'agy' picks its own workers (the picker is locked)
 * @returns {HTMLElement[]}
 */
export function workerModelControls(plan, disabled, onChange, workers = 'claude') {
  const label = document.createElement('span');
  label.className = 'orchestra__optlabel';
  label.textContent = t('orch.workerModel');
  label.title = t('orch.pool.hint');
  const picker = poolPickerView({
    disabled,
    locked: workers === 'agy',
    fallbackLabel: workerModelLabel(runWorkerModel(plan, picked)),
    onChange,
  });
  return [label, picker];
}
