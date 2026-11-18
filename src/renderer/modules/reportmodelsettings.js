// ============================================================================
// LunaCore - Settings (Ctrl+L) -> AI and models -> Report models (renderer)
// ----------------------------------------------------------------------------
// Two selects in the static #report-models-section markup (index.html): the
// model that writes the weekly review and the one that writes the daily (and
// Monday) brief - a Claude model, or Antigravity (agy) with its default model
// or one of `agy models` (e.g. gemini-4-hydrogen-low).
//
// No IPC of its own: it reads and writes the same stores as the Week tab
// picker and the brief card (life:week / life:week-model, mission:brief /
// mission:brief-model), so all three stay in step. The choices and the
// current pick come from main, which also re-checks every pick against the
// Claude list and the live `agy models` list (src/reportmodel.js). Opening a
// picker asks main to read `agy models` again first (agy:models).
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { choiceOptions } from './reportmodelview.js';

/** Select id -> how to read its view and write its model. */
const PICKERS = Object.freeze({
  'report-model-weekly': { read: () => window.lunacore.lifeWeek(), write: (model) => window.lunacore.lifeWeekModel(model) },
  'report-model-daily': { read: () => window.lunacore.missionBrief(), write: (model) => window.lunacore.missionBriefModel(model) },
});

let els = null;
let reading = false;
/** Select id -> the value main last confirmed (a refused change goes back to it). */
const confirmed = {};

const isAgyChoice = (value) => typeof value === 'string' && (value === 'agy' || value.startsWith('agy:'));

function setStatus(text, isError = false) {
  if (!els || !els.status) return;
  els.status.textContent = text;
  els.status.hidden = !text;
  els.status.classList.toggle('is-fail', isError);
}

/** The brief on agy has no mail section (Gmail is Claude's connector): say so under the picker. */
function paintHint() {
  if (!els || !els.dailyHint) return;
  els.dailyHint.textContent = t('reportmodels.dailyAgy');
  els.dailyHint.hidden = !isAgyChoice(els['report-model-daily'].value);
}

function fill(id, view) {
  const select = els[id];
  const options = choiceOptions(view.models);
  // Rebuilt only when the list changed: a picker that is open keeps its options.
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.dataset.options = signature;
    select.replaceChildren(
      ...options.map(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        return opt;
      }),
    );
  }
  select.value = view.model;
  confirmed[id] = view.model;
}

/** Reads `agy models` again, then both views; a failed read leaves the pickers as they are. */
async function load() {
  if (!els || reading) return;
  reading = true;
  try {
    try {
      await window.lunacore.agyModels();
    } catch (err) {
      console.warn('[report-models] agy model list not refreshed:', (err && err.message) || err);
    }
    for (const [id, picker] of Object.entries(PICKERS)) {
      const view = await picker.read();
      if (view && view.ok) fill(id, view);
      else setStatus(t('reportmodels.loadFailed'), true);
    }
    paintHint();
  } catch (err) {
    console.warn('[report-models] read failed:', (err && err.message) || err);
    setStatus(t('reportmodels.loadFailed'), true);
  } finally {
    reading = false;
  }
}

async function save(id) {
  const select = els[id];
  const value = select.value;
  try {
    const res = await PICKERS[id].write(value);
    if (!res || !res.ok) throw new Error((res && res.reason) || 'refused');
    confirmed[id] = res.model;
    select.value = res.model;
    setStatus(t('reportmodels.saved'));
  } catch (err) {
    console.warn('[report-models] save refused:', (err && err.message) || err);
    select.value = confirmed[id];
    setStatus(t('reportmodels.saveFailed'), true);
  }
  paintHint();
}

/**
 * Called once from termcustom.js initTermcustomSettings() with #termcustom
 * as root. Static overlay, never unmounted (same as usagevisibilitysettings.js).
 */
export function mountReportModelSettings(root) {
  const found = Object.fromEntries(Object.keys(PICKERS).map((id) => [id, root.querySelector(`#${id}`)]));
  if (Object.values(found).some((el) => !el)) return () => {};
  els = { ...found, status: root.querySelector('#report-models-status'), dailyHint: root.querySelector('#report-model-daily-hint') };
  for (const id of Object.keys(PICKERS)) {
    els[id].addEventListener('change', () => save(id));
    // Opening a picker reads the live agy list again (main throttles the calls).
    els[id].addEventListener('focus', () => load());
  }
  load();
  const offLang = onLangChange(paintHint);
  return () => {
    offLang();
    els = null;
  };
}
