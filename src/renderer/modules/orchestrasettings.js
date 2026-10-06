// ============================================================================
// LunaCore - God Mode v2 worker settings (ORCHESTRATOR_PLAN.md slice 4)
// ----------------------------------------------------------------------------
// Two selects in Settings (Ctrl+L): which model every worker runs on (Opus by
// default, or the planner's per-package pick) and its permission mode
// (bypassPermissions by default). Main reads both from ui.local.json when a
// run STARTS and freezes them for that run, so there is no live state here -
// only the controls. Same static-overlay mount shape as autocompact.js's
// mountAutoCompactSettings.
// ============================================================================

'use strict';

import { sfx } from './sound.js';
import { t } from './util.js';

const MODELS = ['opus', 'sonnet', 'plan'];
const INTEGRATION_MODES = ['pr', 'merge', 'branches'];
const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'default'];

/**
 * @param {HTMLElement} root the Settings overlay
 * @param {{orchestraWorkerModel?:string, orchestraPermissionMode?:string}} prefs
 */
export function mountOrchestraSettings(root, prefs) {
  const model = root.querySelector('#orchestra-worker-model');
  const perm = root.querySelector('#orchestra-permission-mode');
  if (!model || !perm) return;

  model.value = MODELS.includes(prefs.orchestraWorkerModel) ? prefs.orchestraWorkerModel : 'opus';
  perm.value = PERMISSION_MODES.includes(prefs.orchestraPermissionMode) ? prefs.orchestraPermissionMode : 'bypassPermissions';

  model.addEventListener('change', () => {
    if (!MODELS.includes(model.value)) return;
    sfx.modeToggle();
    window.lunacore.setUiPrefs({ orchestraWorkerModel: model.value });
  });
  perm.addEventListener('change', () => {
    if (!PERMISSION_MODES.includes(perm.value)) return;
    sfx.modeToggle();
    window.lunacore.setUiPrefs({ orchestraPermissionMode: perm.value });
  });

  const integ = root.querySelector('#orchestra-integration');
  if (integ) {
    integ.value = INTEGRATION_MODES.includes(prefs.orchestraIntegration) ? prefs.orchestraIntegration : 'pr';
    integ.addEventListener('change', () => {
      if (!INTEGRATION_MODES.includes(integ.value)) return;
      sfx.modeToggle();
      window.lunacore.setUiPrefs({ orchestraIntegration: integ.value });
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
