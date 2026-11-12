// ============================================================================
// LunaCore - God Mode "Workers model" on the Approve screen
// ----------------------------------------------------------------------------
// A select next to Workers / Integration: Opus (default), Sonnet, Fable or
// Planner's pick. It opens on the saved ui pref orchestraWorkerModel (the same
// one as the Settings select) and a change saves it right away; Approve sends
// it as launchOrchestra's workerModel, where main freezes it for the run.
// Also the labels of the run line and each package card's model badge.
// Rules live in orchestraWorkerModelRules.js; text goes in via textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { WORKER_MODELS, normalizeWorkerModel, badgeModelOf, modelName, runWorkerModel } from './orchestraWorkerModelRules.js';

/** The choice on screen (= the saved pref), or null before it was read. */
let picked = null;

/** Reads the saved pref; an unreadable one keeps the choice already on screen. */
export async function loadWorkerModel() {
  try {
    const prefs = await window.lunacore.getUiPrefs();
    const saved = normalizeWorkerModel(prefs && prefs.orchestraWorkerModel);
    if (saved) picked = saved;
  } catch {
    /* prefs unreadable: the plan view's model (the pref main read) is used */
  }
}

/** The run model the board shows and Approve sends (see runWorkerModel). */
export const chosenWorkerModel = (plan) => runWorkerModel(plan, picked);

/** 'Opus' / 'Sonnet' / 'Fable', or "Planner's pick" for 'plan'. */
export function workerModelLabel(model) {
  return model === 'plan' ? t('orchset.model.plan') : modelName(model);
}

/**
 * Whether the run takes the Approve screen's model. A plan run keeps its own
 * worker pool (src/orchestraPlanRunStart.js); main ignores the choice there too.
 */
export const takesWorkerModel = (plan) => Boolean(plan) && !plan.planRun;

/** The run line's model: a plan run's pool as main holds it, else the label. */
export function runModelLabel(plan) {
  if (!takesWorkerModel(plan)) return String((plan && plan.workerModel) || '');
  return workerModelLabel(chosenWorkerModel(plan));
}

/**
 * The model badge of a package card: the model it will run on, "free model"
 * for a hybrid package a free worker takes, null for a Free-only run.
 * @param {object} pkg a plan view package
 * @param {object} plan the plan view
 * @param {string} workers the run's "Workers" choice
 */
export function packageModelBadge(pkg, plan, workers) {
  if (!takesWorkerModel(plan)) return pkg && pkg.model ? String(pkg.model) : null;
  const model = badgeModelOf(pkg, chosenWorkerModel(plan), workers);
  if (!model) return null;
  return model === 'free' ? t('orch.pkgModel.free') : modelName(model);
}

/**
 * The label + select. A change saves the pref (fire-and-forget like the
 * planner selects: a failed write keeps the choice on screen) and repaints.
 * @param {object} plan the plan view
 * @param {boolean} disabled
 * @param {() => void} onChange
 * @returns {HTMLElement[]}
 */
export function workerModelControls(plan, disabled, onChange) {
  const label = document.createElement('span');
  label.className = 'orchestra__optlabel';
  label.textContent = t('orch.workerModel');
  label.title = t('orch.workerModel.hint');
  const sel = document.createElement('select');
  sel.className = 'profile-select';
  sel.setAttribute('aria-label', t('orch.workerModel'));
  for (const model of WORKER_MODELS) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = workerModelLabel(model);
    sel.append(opt);
  }
  sel.value = chosenWorkerModel(plan);
  sel.disabled = disabled;
  sel.addEventListener('change', () => {
    const next = normalizeWorkerModel(sel.value);
    if (!next) return;
    picked = next;
    onChange();
    // Main validates again; a failed save only loses the remembered model
    // (Approve still sends the choice on screen).
    try {
      Promise.resolve(window.lunacore.setUiPrefs({ orchestraWorkerModel: next })).catch(() => {});
    } catch {
      /* bridge unavailable: same as a failed save */
    }
  });
  return [label, sel];
}
