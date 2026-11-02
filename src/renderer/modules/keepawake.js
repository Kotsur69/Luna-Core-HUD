// ============================================================================
// LunaCore - "Don't sleep" chip (renderer half of src/keepawake.js)
// ----------------------------------------------------------------------------
// A small chip in the terminal bar, next to the update chip: green "Awake"
// while the keep-awake .bat runs, red "Sleep OK" while it does not. Clicking
// asks main to start or kill that process. The setting is global (the whole
// PC), so it lives in the always-mounted terminal bar, not in a per-tab
// widget. The state lives in main (it owns the process), so the chip
// re-reads it instead of trusting its own DOM.
//
// Not colour-only: an icon, a text label, aria-pressed and a title carry the
// same state. With no script configured the chip is muted and aria-disabled
// (not `disabled`, which would also kill the tooltip that explains how to
// set config/keepawake.local.json).
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { sfx } from './sound.js';

const ICONS = { on: '☀', off: '☾', failed: '!', unconfigured: '☾' };
const STATE_CLASSES = ['is-on', 'is-off', 'is-failed', 'is-unavailable'];

/**
 * What the chip shows for main's keep-awake status.
 * Precedence: not available > on > error > off.
 * @param {{available?:boolean, on?:boolean, error?:string}|null} status
 * @returns {{state:'on'|'off'|'failed'|'unconfigured', labelKey:string, titleKey:string,
 *   pressed:boolean, unavailable:boolean}}
 */
export function chipView(status) {
  if (!status || !status.available) {
    return {
      state: 'unconfigured',
      labelKey: 'keepawake.chip.off',
      titleKey: 'keepawake.chip.title.unconfigured',
      pressed: false,
      unavailable: true,
    };
  }
  if (status.on) {
    return { state: 'on', labelKey: 'keepawake.chip.on', titleKey: 'keepawake.chip.title.on', pressed: true, unavailable: false };
  }
  if (status.error) {
    return { state: 'failed', labelKey: 'keepawake.chip.off', titleKey: 'keepawake.chip.title.failed', pressed: false, unavailable: false };
  }
  return { state: 'off', labelKey: 'keepawake.chip.off', titleKey: 'keepawake.chip.title.off', pressed: false, unavailable: false };
}

const stateClass = (state) => (state === 'unconfigured' ? 'is-unavailable' : `is-${state}`);

/**
 * Wires #keepawake-chip inside `root` (the w-terminal template). The terminal
 * widget never unmounts, so there is no cleanup - same as mountUpdateChip.
 * @param {ParentNode} root
 */
export function mountKeepAwakeChip(root) {
  const chip = root.querySelector('#keepawake-chip');
  const iconEl = root.querySelector('#keepawake-chip-icon');
  const labelEl = root.querySelector('#keepawake-chip-label');
  if (!chip || !iconEl || !labelEl) return;

  let current = null;

  function render() {
    const view = chipView(current);
    chip.classList.remove(...STATE_CLASSES);
    chip.classList.add(stateClass(view.state));
    chip.setAttribute('aria-pressed', String(view.pressed));
    chip.setAttribute('aria-disabled', String(view.unavailable));
    iconEl.textContent = ICONS[view.state];
    labelEl.textContent = t(view.labelKey);
    chip.title = t(view.titleKey);
  }

  function apply(status) {
    current = status;
    render();
  }

  chip.addEventListener('click', () => {
    const view = chipView(current);
    if (view.unavailable) return;
    sfx.modeToggle();
    window.lunacore
      .setKeepAwake(!view.pressed)
      .then(apply)
      .catch((err) => {
        console.error('[keepawake] toggle failed:', err);
        apply({ ...(current || {}), on: false, error: 'spawn-failed' });
      });
  });

  window.lunacore.onKeepAwakeChanged(apply);
  onLangChange(render);

  window.lunacore
    .getKeepAwake()
    .then(apply)
    .catch((err) => console.error('[keepawake] status read failed:', err));

  render();
}
