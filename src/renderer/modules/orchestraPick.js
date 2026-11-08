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
import { pickable, manualCount, mergeSelection, missingDeps, withDeps } from './orchestraPickRules.js';

// src/efforts.js EFFORTS (the renderer cannot require main-side modules,
// see EFFORT_OPTIONS in orchestrasettings.js). Never 'low'.
const PLANNER_EFFORTS = ['medium', 'high', 'xhigh', 'max'];
const DEFAULT_PLANNER_EFFORT = 'high';

/** Open cards on screen, or null before the first load. */
let cards = null;
/** The planner --effort chosen in the footer (ui pref orchestraPlannerEffort). */
let plannerEffort = DEFAULT_PLANNER_EFFORT;
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
  await loadPlannerEffort();
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
  } catch {
    /* prefs unreadable: keep the level already on screen (default high) */
  }
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
  const meta = [card.size, card.model, card.effort].filter(Boolean).join(' · ');
  row.append(box, text);
  if (meta) row.append(el('span', 'orchestra__pick-meta', meta));
  if (missing) row.append(el('span', 'orchestra__pick-warn', t('orch.pick.needs', { list: missing.join('; ') })));
  return row;
}

/**
 * The picker block for #orchestra-body.
 * @param {{disabled:boolean, canCancel:boolean, onPlan:(ats:number[], effort:string) => void,
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
    effortSelect(planDisabled),
    button(t('orch.pick.plan', { n: count }), () => onPlan(selectedAts(), plannerEffort), planDisabled),
  );
  if (canCancel) foot.append(button(t('orch.pick.back'), onCancel, disabled));
  box.append(foot);
  return box;
}
