// ============================================================================
// LunaCore - God Mode v2 to-do picker (the step before the planner)
// ----------------------------------------------------------------------------
// "Plan packages" and "Plan again" no longer hand the planner every open
// to-do: the dialog first lists them with a checkbox each, and only the
// ticked ones reach main (orchestra:plan's todoAts). The selection is kept
// per card (`at`) while the app runs; a card never seen before starts ticked.
// Rules live in orchestraPickRules.js; card text goes in via textContent only.
// ============================================================================

'use strict';

import { t } from './util.js';
import { pickable, manualCount, mergeSelection, missingDeps, withDeps, tagCounts, withTag } from './orchestraPickRules.js';
// The "Workers" pool (the models the planner may give packages): shared with Approve.
import { loadPool, chosenPool, poolPickerView, agyFamilyOptions, refreshPoolOptions } from './orchestraPoolPicker.js';
import { isPoolRun, poolWorkers, runsOnOf, poolModelName } from '../../workerPool.js';

// src/efforts.js EFFORTS (the renderer cannot require main-side modules,
// see EFFORT_OPTIONS in orchestrasettings.js). Never 'low'.
const PLANNER_EFFORTS = ['medium', 'high', 'xhigh', 'max'];
const DEFAULT_PLANNER_EFFORT = 'high';
// src/claudeModels.js CLAUDE_MODELS + MODEL_LABELS (same reason; kept in line
// by test/claude-models.test.js). Main allow-lists the choice again.
export const PLANNER_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
const PLANNER_MODEL_LABELS = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
export const DEFAULT_PLANNER_MODEL = 'opus';

/** Open cards on screen, or null before the first load. */
let cards = null;
/** The planner --effort chosen in the footer (ui pref orchestraPlannerEffort). */
let plannerEffort = DEFAULT_PLANNER_EFFORT;
/** The Claude planner's --model chosen next to it (ui pref orchestraPlannerModel). */
let plannerModel = DEFAULT_PLANNER_MODEL;
/**
 * The agy planner's model (ui pref orchestraPlannerAgyModel): an agy family
 * of the live menu ('agy-opus' / 'agy-neon' / 'agy-argon' / 'agy-hydrogen'), or '' = agy's
 * own default model. Main resolves it against `agy models` again.
 */
let agyPlannerModel = '';
/** D1 "Planner: Claude / Free" for a Build run; Claude unless Mati picks Free. */
// Mirrors src/orchestraAgy.js PLANNERS; 'agy' plans on the Antigravity profile.
const BUILD_PLANNERS = ['claude', 'agy', 'free'];
let buildPlanner = 'claude';
/**
 * F6 "Workers" (ui pref orchestraWorkers): Claude only / Plan with free models
 * in mind / Free only. Mirrors src/orchestraWorkers.js WORKERS.
 */
const WORKERS = ['claude', 'agy', 'hybrid', 'free'];
let workers = 'claude';
/** "Sessions may file new to-dos" (ui pref orchestraFollowups): off unless ticked; the last choice is kept. */
let followups = false;
let manual = 0;
let selected = new Set();
const seen = new Set();

/**
 * Reloads the active tab's to-dos and merges them into the selection.
 * @param {string|null} sessionId
 * @returns {Promise<boolean>} false when the list could not be read
 */
export async function loadPicker(sessionId) {
  let todos;
  try {
    todos = await window.lunacore.getTodos(sessionId);
  } catch {
    // No stale list: the picker shows "could not read" instead.
    cards = null;
    return false;
  }
  cards = pickable(todos);
  manual = manualCount(todos);
  await Promise.all([loadPlannerEffort(), loadPool()]);
  selected = mergeSelection(cards, selected, seen);
  for (const c of cards) seen.add(c.at);
  return true;
}

/** Opens the select at the saved level; an unreadable pref keeps the last one. */
async function loadPlannerEffort() {
  try {
    const prefs = await window.lunacore.getUiPrefs();
    const saved = prefs && prefs.orchestraPlannerEffort;
    plannerEffort = PLANNER_EFFORTS.includes(saved) ? saved : DEFAULT_PLANNER_EFFORT;
    plannerModel = plannerModelPrefOf(prefs);
    agyPlannerModel = agyPlannerModelPrefOf(prefs);
    workers = workersPrefOf(prefs);
    followups = followupsPrefOf(prefs);
  } catch {
    /* prefs unreadable: keep the level and workers already on screen */
  }
}

/**
 * The saved "Workers" choice. Main migrates the old "Free providers" tick
 * (orchestraFree) already; an older main may still hand the raw tick over.
 * @param {{orchestraWorkers?:unknown, orchestraFree?:unknown}|null} prefs
 */
export function workersPrefOf(prefs) {
  if (!prefs || typeof prefs !== 'object') return 'claude';
  if (WORKERS.includes(prefs.orchestraWorkers)) return prefs.orchestraWorkers;
  return prefs.orchestraFree === true ? 'free' : 'claude';
}

/**
 * The saved "Sessions may file new to-dos" tick; only an exact true is on.
 * @param {{orchestraFollowups?:unknown}|null} prefs
 */
export function followupsPrefOf(prefs) {
  return !!prefs && typeof prefs === 'object' && prefs.orchestraFollowups === true;
}

/** The workers the next plan uses: a free planner always plans a free-only run (D1). */
export function chosenWorkers() {
  return buildPlanner === 'free' ? 'free' : workers;
}

/** True when the Workers mode picks its own workers and the pool does not apply. */
const poolLocked = () => buildPlanner === 'free' || workers === 'free' || workers === 'agy';

/**
 * The plan request's Workers mode and pool: a pool with a free profile plans
 * hybrid, a lone free profile "Free only" (src/workerPool.js poolWorkers);
 * only a pool of 2+ models goes to main - one model plans as before.
 * @returns {{workers:string, modelPool:{model:string, effort:string}[]|null}}
 */
export function planRequestWorkers() {
  if (poolLocked()) return { workers: chosenWorkers(), modelPool: null };
  const pool = chosenPool();
  return { workers: poolWorkers(pool, workers), modelPool: isPoolRun(pool) ? pool : null };
}

/**
 * The saved planner model; anything but a known alias is the default (opus).
 * @param {{orchestraPlannerModel?:unknown}|null} prefs
 */
export function plannerModelPrefOf(prefs) {
  const saved = prefs && typeof prefs === 'object' ? prefs.orchestraPlannerModel : null;
  return PLANNER_MODELS.includes(saved) ? saved : DEFAULT_PLANNER_MODEL;
}

/**
 * The saved agy planner model: an agy family key, else '' (agy's default).
 * @param {{orchestraPlannerAgyModel?:unknown}|null} prefs
 */
export function agyPlannerModelPrefOf(prefs) {
  const saved = prefs && typeof prefs === 'object' ? prefs.orchestraPlannerAgyModel : null;
  return runsOnOf(saved) === 'agy' ? saved : '';
}

/** The planner model the next plan sends: an agy family for the agy planner, else the Claude alias. */
export function chosenPlannerModel() {
  return buildPlanner === 'agy' ? agyPlannerModel : plannerModel;
}

/** The planner effort the next plan uses. */
export function chosenPlannerEffort() {
  return plannerEffort;
}

/** The ticked cards' `at` values, in list order. */
export function selectedAts() {
  return (cards || []).filter((c) => selected.has(c.at)).map((c) => c.at);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, disabled) {
  const b = el('button', 'pad-send', label);
  b.type = 'button';
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

/** "Planner: Claude / Free" (D1). Free plans on the coding profile; the run is free-only. */
function plannerSelect(disabled, repaint) {
  const label = el('label', 'orchestra__pick-effort');
  label.title = t('orch.pick.planner.hint');
  label.append(el('span', '', t('orch.pick.planner')));
  const sel = el('select', 'profile-select');
  for (const p of BUILD_PLANNERS) {
    const opt = el('option', '', t(`orch.pick.planner.${p}`));
    opt.value = p;
    sel.append(opt);
  }
  sel.value = buildPlanner;
  sel.disabled = disabled;
  sel.addEventListener('change', () => {
    buildPlanner = BUILD_PLANNERS.includes(sel.value) ? sel.value : 'claude';
    // The Workers select follows: a free planner locks it to "Free only".
    repaint();
  });
  label.append(sel);
  return label;
}

/**
 * F6 "Workers": replaces the old "Free providers" tick. Chosen before
 * planning because "Plan with free models in mind" changes the planner.
 */
function workersSelect(disabled, repaint) {
  const label = el('label', 'orchestra__pick-effort');
  label.title = t('orch.workerMode.hint');
  label.append(el('span', '', t('orch.workerMode')));
  const sel = el('select', 'profile-select');
  for (const w of WORKERS) {
    const opt = el('option', '', t(`orch.workerMode.${w}`));
    opt.value = w;
    sel.append(opt);
  }
  sel.value = chosenWorkers();
  sel.disabled = disabled || buildPlanner === 'free';
  sel.addEventListener('change', () => {
    workers = WORKERS.includes(sel.value) ? sel.value : 'claude';
    // Fire-and-forget like the effort pref: a failed write keeps the choice on screen.
    Promise.resolve(window.lunacore.setUiPrefs({ orchestraWorkers: workers })).catch(() => {});
    // The pool picker follows: Free only and Antigravity pick their own workers.
    repaint();
  });
  label.append(sel);
  return label;
}

/** "Workers model": the pool the planner plans for (orchestraPoolPicker.js). */
function poolSelect(disabled, repaint) {
  // A span, not a label: a label would forward every click in the dropdown to its first checkbox.
  const label = el('span', 'orchestra__pick-effort');
  label.title = t('orch.pool.hint');
  label.append(el('span', '', t('orch.workerModel')));
  label.append(poolPickerView({ disabled, locked: poolLocked(), fallbackLabel: t('orch.pool.settingsModel'), onChange: repaint }));
  return label;
}

/** "Planner effort" label + select; a change is saved as the ui pref. */
function effortSelect(disabled) {
  const label = el('label', 'orchestra__pick-effort');
  label.append(el('span', '', t('orch.pick.effort')));
  const sel = el('select', 'profile-select');
  for (const level of PLANNER_EFFORTS) {
    const opt = el('option', '', level);
    opt.value = level;
    sel.append(opt);
  }
  sel.value = plannerEffort;
  sel.disabled = disabled;
  sel.addEventListener('change', () => {
    if (!PLANNER_EFFORTS.includes(sel.value)) return;
    plannerEffort = sel.value;
    // Main validates again; a failed save only loses the remembered level.
    Promise.resolve(window.lunacore.setUiPrefs({ orchestraPlannerEffort: plannerEffort })).catch(() => {});
  });
  label.append(sel);
  return label;
}

/**
 * "Planner model" label + select, next to the effort; a change is saved as
 * the ui pref. The free planner has its own model, so the select is off then.
 */
function modelSelect(disabled, repaint) {
  if (buildPlanner === 'agy') return agyModelSelect(disabled, repaint);
  const label = el('label', 'orchestra__pick-effort');
  label.title = t('orch.pick.model.hint');
  label.append(el('span', '', t('orch.pick.model')));
  const sel = el('select', 'profile-select');
  for (const model of PLANNER_MODELS) {
    const opt = el('option', '', PLANNER_MODEL_LABELS[model]);
    opt.value = model;
    sel.append(opt);
  }
  sel.value = plannerModel;
  sel.disabled = disabled || buildPlanner === 'free';
  sel.addEventListener('change', () => {
    if (!PLANNER_MODELS.includes(sel.value)) return;
    plannerModel = sel.value;
    // Main validates again; a failed save only loses the remembered model.
    Promise.resolve(window.lunacore.setUiPrefs({ orchestraPlannerModel: plannerModel })).catch(() => {});
  });
  label.append(sel);
  return label;
}

/**
 * "Planner model" for the agy planner: agy's own default, then Opus / Argon /
 * Hydrogen from the live `agy models` list (one entry per family; a family the
 * list lacks is disabled). Main picks the family's variant nearest the planner
 * effort and checks it against the live list again.
 */
function agyModelSelect(disabled, repaint) {
  const label = el('label', 'orchestra__pick-effort');
  label.title = t('orch.pick.model.agyHint');
  label.append(el('span', '', t('orch.pick.model')));
  const sel = el('select', 'profile-select');
  const def = el('option', '', t('orch.pick.model.agyDefault'));
  def.value = '';
  sel.append(def);
  const families = agyFamilyOptions();
  for (const f of families) {
    const opt = el('option', '', poolModelName(f.model) || f.model);
    opt.value = f.model;
    // A saved family that left the list stays selectable, so it can be changed.
    opt.disabled = !f.available && f.model !== agyPlannerModel;
    if (!f.available) opt.textContent = `${opt.textContent} - ${t('orch.pool.agyMissing')}`;
    sel.append(opt);
  }
  if (!families.length) {
    // The live list is not in yet: read it, then show the families.
    refreshPoolOptions().then(() => {
      if (sel.isConnected && agyFamilyOptions().length) repaint();
    });
  }
  sel.value = families.some((f) => f.model === agyPlannerModel) ? agyPlannerModel : '';
  sel.disabled = disabled;
  sel.addEventListener('change', () => {
    agyPlannerModel = runsOnOf(sel.value) === 'agy' ? sel.value : '';
    // Main validates again; a failed save only loses the remembered model.
    Promise.resolve(window.lunacore.setUiPrefs({ orchestraPlannerAgyModel: agyPlannerModel || null })).catch(() => {});
  });
  label.append(sel);
  return label;
}

/**
 * "Sessions may file new to-dos (bugs, gaps, ideas)": a per-run option fixed
 * into the plan (plan.followups). The cards go to the To-do list, never into
 * the run. A change is saved as the ui pref, so the next plan starts from it.
 */
function followupsToggle(disabled) {
  const label = el('label', 'orchestra__pick-effort');
  label.title = t('orch.pick.followups.hint');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = followups;
  box.disabled = disabled;
  box.addEventListener('change', () => {
    followups = box.checked === true;
    // Main validates again; a failed save only loses the remembered choice.
    Promise.resolve(window.lunacore.setUiPrefs({ orchestraFollowups: followups })).catch(() => {});
  });
  label.append(box, el('span', '', t('orch.pick.followups')));
  return label;
}

function cardRow(card, missing, disabled, repaint) {
  const row = el('label', 'orchestra__pick-row');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = selected.has(card.at);
  box.disabled = disabled;
  box.addEventListener('change', () => {
    if (box.checked) selected.add(card.at);
    else selected.delete(card.at);
    repaint();
  });
  const text = el('span', 'orchestra__pick-text', card.text);
  const tags = Array.isArray(card.tags) ? card.tags.map((tag) => `#${tag}`) : [];
  const meta = [card.size, card.model, card.effort, ...tags].filter(Boolean).join(' · ');
  row.append(box, text);
  if (meta) row.append(el('span', 'orchestra__pick-meta', meta));
  if (missing) row.append(el('span', 'orchestra__pick-warn', t('orch.pick.needs', { list: missing.join('; ') })));
  return row;
}

/**
 * "Tick tag": ticks exactly the cards carrying the chosen tag (e.g. one
 * #godmode2 batch). Null when no card has a tag.
 */
function tagSelect(disabled, repaint) {
  const counts = tagCounts(cards);
  if (!counts.length) return null;
  const sel = el('select', 'profile-select');
  sel.title = t('orch.pick.byTag.hint');
  const head = el('option', '', t('orch.pick.byTag'));
  head.value = '';
  sel.append(head);
  for (const { tag, n } of counts) {
    const opt = el('option', '', `#${tag} (${n})`);
    opt.value = tag;
    sel.append(opt);
  }
  sel.value = '';
  sel.disabled = disabled;
  sel.addEventListener('change', () => {
    if (!counts.some((c) => c.tag === sel.value)) return;
    selected = withTag(cards, sel.value);
    repaint();
  });
  return sel;
}

/**
 * The picker block for #orchestra-body.
 * @param {{disabled:boolean, canCancel:boolean,
 *   onPlan:(ats:number[], effort:string, planner:string, workers:string, model:string, followups:boolean,
 *     modelPool:{model:string, effort:string}[]|null) => void,
 *   onCancel:() => void, repaint:() => void}} opts
 * @returns {HTMLElement}
 */
export function pickerView({ disabled, canCancel, onPlan, onCancel, repaint }) {
  const box = el('div', 'orchestra__pick');
  box.append(el('p', 'orchestra__msg', t('orch.pick.title')));
  if (!cards) {
    box.append(el('p', 'orchestra__msg is-bad', t('orch.pick.loadFailed')));
    return box;
  }
  if (!cards.length) {
    box.append(el('p', 'orchestra__msg', t('orch.fail.noTodos')));
    if (canCancel) box.append(button(t('orch.pick.back'), onCancel, disabled));
    return box;
  }

  const missing = missingDeps(cards, selected);
  const count = selected.size;
  const bar = el('div', 'orchestra__pick-bar');
  bar.append(
    el('span', 'orchestra__pick-count', t('orch.pick.count', { n: count, total: cards.length })),
    button(t('orch.pick.all'), () => {
      selected = new Set(cards.map((c) => c.at));
      repaint();
    }, disabled),
    button(t('orch.pick.none'), () => {
      selected = new Set();
      repaint();
    }, disabled),
  );
  const byTag = tagSelect(disabled, repaint);
  if (byTag) bar.append(byTag);
  if (missing.size) {
    bar.append(button(t('orch.pick.addDeps'), () => {
      selected = withDeps(cards, selected);
      repaint();
    }, disabled));
  }
  box.append(bar);

  const listEl = el('div', 'orchestra__pick-list');
  for (const c of cards) listEl.append(cardRow(c, missing.get(c.at), disabled, repaint));
  box.append(listEl);
  if (manual) box.append(el('p', 'orchestra__msg', t('orch.pick.manual', { n: manual })));

  const foot = el('div', 'orchestra__pick-bar');
  const planDisabled = disabled || !count;
  foot.append(
    plannerSelect(planDisabled, repaint),
    workersSelect(planDisabled, repaint),
    poolSelect(planDisabled, repaint),
    effortSelect(planDisabled),
    modelSelect(planDisabled, repaint),
    followupsToggle(planDisabled),
    button(
      t('orch.pick.plan', { n: count }),
      () => {
        const req = planRequestWorkers();
        onPlan(selectedAts(), plannerEffort, buildPlanner, req.workers, chosenPlannerModel(), followups, req.modelPool);
      },
      planDisabled,
    ),
  );
  if (canCancel) foot.append(button(t('orch.pick.back'), onCancel, disabled));
  box.append(foot);
  return box;
}
