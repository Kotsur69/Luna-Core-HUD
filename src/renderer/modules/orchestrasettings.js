// ============================================================================
// LunaCore - God Mode v2 worker settings (DONE_ORCHESTRATOR_PLAN.md slice 4)
// ----------------------------------------------------------------------------
// Two selects in Settings (Ctrl+L): which model every worker runs on (Opus by
// default, or the planner's per-package pick) and its permission mode
// (bypassPermissions by default) - plus the run-end ones (integration, final
// check command, "Apply Supabase actions": off / ask / automatic). Main reads both from ui.local.json when a
// run STARTS and freezes them for that run, so there is no live state here -
// only the controls. Same static-overlay mount shape as autocompact.js's
// mountAutoCompactSettings.
// ============================================================================

'use strict';

import { sfx } from './sound.js';
import { t } from './util.js';
import { mountRunEmailToggle } from './mailsettings.js';
import { WORKER_MODEL_LIST, DEFAULT_WORKER_MODEL, AGY_MODEL, isWorkerModel, agyModelIdOf, agyModelLabel } from '../../workerModels.js';
import { agyChoiceName, agyVariantIds, refreshAgyModels } from './agyModelChoices.js';

/** i18n key of the 'plan' choice's label (the other choices are product names). */
const PLAN_LABEL_KEY = 'orchset.model.plan';
const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'default'];
// 'plan' + src/efforts.js EFFORTS (the renderer cannot require main-side modules).
const EFFORT_OPTIONS = ['plan', 'medium', 'high', 'xhigh', 'max'];
// src/orchestraRescue.js EMERGENCY_EFFORTS: the Emergency Opus effort (main validates it again).
export const EMERGENCY_OPTIONS = ['step', 'low', 'medium', 'high', 'xhigh', 'max'];
// src/uiprefs.js SUPABASE_APPLY_MODES (main validates the value again).
const SUPABASE_APPLY_MODES = ['off', 'ask', 'automatic'];
// Opt-in God Mode evolutions: [switch id, ui pref key]. Main fixes them into
// each NEW plan (src/orchestraSupervisor.js PLAN_OPT_IN_FLAGS), so a plan
// that already exists keeps the value it was made with.
const EVOLUTION_TOGGLES = [
  ['orchestra-ab-toggle', 'orchestraAbBuild'],
  ['orchestra-heal-toggle', 'orchestraSelfHeal'],
  ['orchestra-context-toggle', 'orchestraContextGuard'],
];

/** The three opt-in switches: shown from prefs, saved on change, re-shown from what main stored. */
function mountEvolutionToggles(root, prefs) {
  for (const [id, key] of EVOLUTION_TOGGLES) {
    const input = root.querySelector(`#${id}`);
    if (!input) continue;
    const status = root.querySelector(`#${id}-status`);
    let stored = prefs[key] === true;
    const show = (on) => {
      input.checked = on;
      if (!status) return;
      status.dataset.i18n = on ? 'mailset.on' : 'mailset.off';
      status.textContent = t(status.dataset.i18n);
    };
    show(stored);
    input.addEventListener('change', async () => {
      sfx.modeToggle();
      let next = null;
      try {
        next = await window.lunacore.setUiPrefs({ [key]: input.checked });
      } catch (err) {
        console.warn(`[orchestrasettings] saving ${key} failed:`, err);
      }
      // Whatever main stored wins; a failed save shows the old value again.
      if (next) stored = next[key] === true;
      show(stored);
    });
  }
}

/**
 * Fills the worker-model select from the shared list (src/workerModels.js).
 * The 'plan' option keeps a data-i18n key so a language switch relabels it.
 * The live agy variants (`agy models`, src/renderer/modules/agyModelChoices.js)
 * follow plain 'agy'; `current`, when it is a variant no longer listed, too.
 * @param {HTMLSelectElement} select
 * @param {string|null} [current]
 */
function fillWorkerModelOptions(select, current = null) {
  const variants = agyVariantIds();
  if (agyModelIdOf(current) && !variants.includes(current)) variants.push(current);
  const variantOption = (id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = agyChoiceName(id) || agyModelLabel(id);
    return opt;
  };
  select.replaceChildren(
    ...WORKER_MODEL_LIST.map((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      if (m.name) {
        opt.textContent = m.name;
      } else {
        opt.dataset.i18n = PLAN_LABEL_KEY;
        opt.textContent = t(PLAN_LABEL_KEY);
      }
      return m.id === AGY_MODEL ? [opt, ...variants.map(variantOption)] : [opt];
    }).flat(),
  );
}

/**
 * @param {HTMLElement} root the Settings overlay
 * @param {{orchestraWorkerModel?:string, orchestraPermissionMode?:string}} prefs
 */
export function mountOrchestraSettings(root, prefs) {
  const model = root.querySelector('#orchestra-worker-model');
  const perm = root.querySelector('#orchestra-permission-mode');
  const savedModel = isWorkerModel(prefs.orchestraWorkerModel) ? prefs.orchestraWorkerModel : DEFAULT_WORKER_MODEL;
  // The options first: the select is empty in index.html.
  if (model) fillWorkerModelOptions(model, savedModel);
  if (!model || !perm) return;

  model.value = savedModel;
  // The picker opens: main reads `agy models` again; a changed list is offered.
  let reading = false;
  model.addEventListener('focus', () => {
    if (reading) return;
    reading = true;
    const before = agyVariantIds().join('\n');
    refreshAgyModels()
      .then((ids) => {
        if (ids.join('\n') === before) return;
        const keep = isWorkerModel(model.value) ? model.value : savedModel;
        fillWorkerModelOptions(model, keep);
        model.value = keep;
      })
      .finally(() => {
        reading = false;
      });
  });
  perm.value = PERMISSION_MODES.includes(prefs.orchestraPermissionMode) ? prefs.orchestraPermissionMode : 'bypassPermissions';

  // "Email me when a run finishes" (src/godmodemail.js): ON by default once
  // Gmail is connected, disabled with a hint until then.
  mountRunEmailToggle(root);
  // A/B builds, self-healing workers, context guard: off by default.
  mountEvolutionToggles(root, prefs);

  model.addEventListener('change', () => {
    if (!isWorkerModel(model.value)) return;
    sfx.modeToggle();
    // The newest choice wins: a saved "Workers" pool (src/workerPool.js) is
    // cleared, so the plan screen and Approve open on this model again.
    window.lunacore.setUiPrefs({ orchestraWorkerModel: model.value, orchestraModelPool: null });
  });
  perm.addEventListener('change', () => {
    if (!PERMISSION_MODES.includes(perm.value)) return;
    sfx.modeToggle();
    window.lunacore.setUiPrefs({ orchestraPermissionMode: perm.value });
  });

  // Worker --effort: the planner's pick by default, or one forced level.
  const effort = root.querySelector('#orchestra-worker-effort');
  if (effort) {
    effort.value = EFFORT_OPTIONS.includes(prefs.orchestraWorkerEffort) ? prefs.orchestraWorkerEffort : 'plan';
    effort.addEventListener('change', () => {
      if (!EFFORT_OPTIONS.includes(effort.value)) return;
      sfx.modeToggle();
      window.lunacore.setUiPrefs({ orchestraWorkerEffort: effort.value });
    });
  }

  // Emergency Opus effort of a pool run: one step up by default, or one fixed level.
  const emergency = root.querySelector('#orchestra-emergency-effort');
  if (emergency) {
    emergency.value = EMERGENCY_OPTIONS.includes(prefs.orchestraEmergencyEffort) ? prefs.orchestraEmergencyEffort : 'step';
    emergency.addEventListener('change', () => {
      if (!EMERGENCY_OPTIONS.includes(emergency.value)) return;
      sfx.modeToggle();
      const asked = emergency.value;
      Promise.resolve(window.lunacore.setUiPrefs({ orchestraEmergencyEffort: asked }))
        .then((next) => {
          // Whatever main stored wins.
          if (next && EMERGENCY_OPTIONS.includes(next.orchestraEmergencyEffort)) emergency.value = next.orchestraEmergencyEffort;
        })
        .catch((err) => {
          console.warn('[orchestrasettings] saving orchestraEmergencyEffort failed:', err);
          emergency.value = EMERGENCY_OPTIONS.includes(prefs.orchestraEmergencyEffort) ? prefs.orchestraEmergencyEffort : 'step';
        });
    });
  }

  const integ = root.querySelector('#orchestra-integration');
  if (integ) {
    integ.value = INTEGRATION_MODES.includes(prefs.orchestraIntegration) ? prefs.orchestraIntegration : 'pr';
    integ.addEventListener('change', () => {
      if (!INTEGRATION_MODES.includes(integ.value)) return;
      sfx.modeToggle();
      window.lunacore.setUiPrefs({ orchestraIntegration: integ.value });
    });
  }

  // Final check command (GM never blocks 4/5): saved on change; main
  // validates it and keeps the old value for an empty or multi-line one.
  const check = root.querySelector('#orchestra-check-command');
  if (check) {
    check.value = typeof prefs.orchestraCheckCommand === 'string' ? prefs.orchestraCheckCommand : 'npm test';
    check.addEventListener('change', async () => {
      const value = check.value.trim();
      if (!value) {
        check.value = typeof prefs.orchestraCheckCommand === 'string' ? prefs.orchestraCheckCommand : 'npm test';
        return;
      }
      sfx.modeToggle();
      const next = await window.lunacore.setUiPrefs({ orchestraCheckCommand: value });
      if (next && typeof next.orchestraCheckCommand === 'string') check.value = next.orchestraCheckCommand;
    });
  }

  // After a merge: apply the run's Supabase migrations / edge functions
  // (src/orchestraApplyActions.js). 'ask' by default.
  const supabase = root.querySelector('#orchestra-supabase-apply');
  if (supabase) {
    supabase.value = SUPABASE_APPLY_MODES.includes(prefs.orchestraSupabaseApply) ? prefs.orchestraSupabaseApply : 'ask';
    supabase.addEventListener('change', async () => {
      if (!SUPABASE_APPLY_MODES.includes(supabase.value)) return;
      sfx.modeToggle();
      const next = await window.lunacore.setUiPrefs({ orchestraSupabaseApply: supabase.value });
      // Main asks before 'automatic'; a Cancel there keeps the old value.
      if (next && SUPABASE_APPLY_MODES.includes(next.orchestraSupabaseApply)) supabase.value = next.orchestraSupabaseApply;
    });
  }

  // Allow rules are added on the run board (main checks each against the
  // run's evidence); here they can only be seen and cleared.
  const allowed = root.querySelector('#orchestra-allowed');
  const clear = root.querySelector('#orchestra-allowed-clear');
  if (!allowed || !clear) return;
  const show = (list) => {
    allowed.textContent = list.length ? list.join(', ') : t('orchset.allowed.none');
    clear.disabled = !list.length;
  };
  show(Array.isArray(prefs.orchestraAllowedTools) ? prefs.orchestraAllowedTools : []);
  clear.addEventListener('click', async () => {
    sfx.modeToggle();
    const next = await window.lunacore.setUiPrefs({ orchestraAllowedTools: [] });
    show(next && Array.isArray(next.orchestraAllowedTools) ? next.orchestraAllowedTools : []);
  });
  // The list grows from the board; re-read it whenever Settings is shown.
  root.addEventListener('focusin', async () => {
    const fresh = await window.lunacore.getUiPrefs();
    if (fresh && Array.isArray(fresh.orchestraAllowedTools)) show(fresh.orchestraAllowedTools);
  });
}
