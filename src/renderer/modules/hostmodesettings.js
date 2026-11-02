// ============================================================================
// LunaCore - Settings -> Host mode (renderer)
// ----------------------------------------------------------------------------
// The toggle starts / stops host mode inside this HUD and the button makes
// this PC the default host, through the one bridge method hostMode(action)
// (src/preload.js -> src/hostmodeipc.js). Main owns the state: every answer
// re-renders from {on, isDefault, machine}. The host tray's own Stop changes
// it behind our back, so the state is re-read when the window gets focus.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

const ERRORS = new Set(['notReady', 'failed']);

let els = null;
let state = { on: false, isDefault: false, machine: '' };
let error = null; // reason of the last failed action, cleared by the next success
let busy = false;

const api = () => window.lunacore;

function statusText() {
  if (error) return t(`setup.host.err.${ERRORS.has(error) ? error : 'failed'}`);
  if (!state.on) return t('setup.host.off');
  return t(state.isDefault ? 'setup.host.onDefault' : 'setup.host.on', { machine: state.machine });
}

function render() {
  if (!els) return;
  els.toggle.checked = state.on;
  els.toggle.disabled = busy;
  els.status.textContent = statusText();
  // Off: the toggle comes first - the button never starts host mode by surprise.
  els.makeDefault.disabled = busy || !state.on || state.isDefault;
  els.makeDefault.textContent = t(state.isDefault ? 'setup.host.isDefault' : 'setup.host.makeDefault');
}

const stateOf = (r) => ({ on: r.on === true, isDefault: r.isDefault === true, machine: typeof r.machine === 'string' ? r.machine : '' });

/** A user action through main: controls locked meanwhile, a failure is shown. */
async function run(action) {
  busy = true;
  render();
  const r = await api().hostMode(action).catch(() => null);
  busy = false;
  if (r && r.ok) {
    state = stateOf(r);
    error = null;
  } else {
    error = (r && r.reason) || 'failed';
  }
  render();
}

/** A background re-read: never locks the controls, a failure keeps the last state. */
async function poll() {
  const r = await api().hostMode('status').catch(() => null);
  if (busy || !r || !r.ok) return;
  state = stateOf(r);
  render();
}

/**
 * Called once from mountSetupCenter() - the section is static markup.
 * @param {ParentNode} root
 */
export function mountHostModeSettings(root) {
  const toggle = root.querySelector('#setup-host-toggle');
  const status = root.querySelector('#setup-host-status');
  const makeDefault = root.querySelector('#setup-host-default');
  if (!toggle || !status || !makeDefault || typeof api().hostMode !== 'function') return;
  els = { toggle, status, makeDefault };
  toggle.addEventListener('change', () => run(toggle.checked ? 'start' : 'stop'));
  makeDefault.addEventListener('click', () => run('make-default'));
  window.addEventListener('focus', poll);
  onLangChange(render);
  render();
  poll();
}
