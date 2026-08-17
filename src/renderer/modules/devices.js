// ============================================================================
// LunaCore - device panel widget (microphone mute)
// ----------------------------------------------------------------------------
// ACTION INJECTOR like media.js: the button causes a real OS-level effect, and
// like media.js it never touches the PTY - devices:mic is its own IPC path.
//
// Three visible states, never two. `null` from the main process means "no
// capture endpoint / COM failure" and renders as UNAVAILABLE with the toggle
// disabled - it must never be shown as "live", because a mic indicator that
// guesses is worse than one that admits it does not know. That is the same
// reasoning src/devices.js gives for shipping mute instead of pnputil.
//
// No optimistic flip, unlike media.js's play/pause. A round trip here is one
// PowerShell spawn (~200 ms) and the answer is authoritative; showing an
// unconfirmed "muted" for those 200 ms is exactly the lie this widget exists
// not to tell.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';
import { defineWidget } from './registry.js';

let els = null;
let state = null; // {muted, available} | null - null = unknown/unavailable
let busy = false;

function render() {
  if (!els) return;
  const available = state !== null;
  els.unavailable.style.display = available ? 'none' : '';
  els.unavailable.textContent = t('dev.unavailable');
  els.toggle.disabled = !available || busy;
  els.refresh.disabled = busy;
  if (!available) {
    els.micState.textContent = '';
    els.micState.classList.remove('is-muted', 'is-live');
    els.toggle.textContent = '🎙';
    return;
  }
  els.micState.textContent = state.muted ? t('dev.muted') : t('dev.live');
  els.micState.classList.toggle('is-muted', state.muted);
  els.micState.classList.toggle('is-live', !state.muted);
  els.toggle.textContent = state.muted ? '🔇' : '🎙';
}

async function query(action) {
  if (busy) return;
  busy = true;
  render();
  try {
    state = await window.lunacore.micState(action);
  } catch {
    state = null;
  }
  busy = false;
  render();
}

defineWidget({
  id: 'devices',
  titleKey: 'dev.title',
  template: 'w-devices',
  mount(root) {
    els = {
      micState: root.querySelector('#dev-mic-state'),
      toggle: root.querySelector('#dev-mic-toggle'),
      refresh: root.querySelector('#dev-mic-refresh'),
      unavailable: root.querySelector('#dev-unavailable'),
    };

    const offLang = onLangChange(render);

    els.toggle.addEventListener('click', () => query('toggle'));
    els.refresh.addEventListener('click', () => query('get'));

    render();
    // There is no poller (see src/devices.js): the state is read on mount,
    // after each toggle, and whenever the user presses refresh.
    query('get');

    return () => {
      offLang();
      els = null;
    };
  },
});
