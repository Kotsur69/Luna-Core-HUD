// ============================================================================
// LunaCore - "Don't sleep" switch (renderer half of src/keepawake.js)
// ----------------------------------------------------------------------------
// Sits under God Mode in the To-do widget. ON asks main to run the keep-awake
// .bat, OFF asks it to kill that process. The state lives in main (it owns
// the process), so every mount re-reads it instead of trusting its own DOM.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { sfx } from './sound.js';

function statusKey(status) {
  if (!status || !status.available) return 'keepawake.unconfigured';
  if (status.on) return 'keepawake.on';
  if (status.error) return 'keepawake.failed';
  return 'keepawake.off';
}

/**
 * Wires the switch inside `root` (the w-todo template). Returns a cleanup.
 * @param {ParentNode} root
 */
export function mountKeepAwakeControl(root) {
  const field = root.querySelector('#keepawake-field');
  const statusEl = root.querySelector('#keepawake-status');
  const toggle = root.querySelector('#keepawake-toggle');
  if (!field || !statusEl || !toggle) return () => {};

  let current = null;
  let alive = true;

  function render() {
    if (!alive) return;
    const on = Boolean(current && current.on);
    toggle.checked = on;
    toggle.disabled = !current || !current.available;
    field.classList.toggle('is-armed', on);
    statusEl.textContent = t(statusKey(current));
  }

  function apply(status) {
    current = status;
    render();
  }

  toggle.addEventListener('change', () => {
    sfx.modeToggle();
    window.lunacore
      .setKeepAwake(toggle.checked)
      .then(apply)
      .catch((err) => {
        console.error('[keepawake] toggle failed:', err);
        apply({ ...(current || {}), on: false, error: 'spawn-failed' });
      });
  });

  const offChanged = window.lunacore.onKeepAwakeChanged(apply);
  const offLang = onLangChange(render);

  window.lunacore
    .getKeepAwake()
    .then(apply)
    .catch((err) => console.error('[keepawake] status read failed:', err));

  render();

  return () => {
    alive = false;
    offChanged();
    offLang();
  };
}
