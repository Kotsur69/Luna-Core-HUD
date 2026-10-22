// ============================================================================
// LunaCore - FreeLLMAPI gateway row (Settings overlay, AI providers)
// ----------------------------------------------------------------------------
// Port field + one status row: up / not running / not installed, with a
// "open dashboard" button while up. Main does the probe (~1.5 s timeout) and
// owns every URL (src/freellmipc.js); this module only sees a state string
// and the port number. DOM/IPC only - the state mapping it relies on is
// unit-tested in src/freellmgateway.js.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

/** state string (src/freellmgateway.js GATEWAY_STATES) -> label key + dot class. */
const VIEW = {
  up: { textKey: 'freellm.status.up', dot: 'diag-item__dot--ok' },
  'not-running': { textKey: 'freellm.status.notRunning', dot: 'diag-item__dot--fail' },
  'not-installed': { textKey: 'freellm.status.notInstalled', dot: 'diag-item__dot--unknown' },
};

let els = null;
let state = null; // last state string, null while checking
let seq = 0; // drops a stale probe answer that lands after a newer one started
let portNote = null; // {key, params, fail} under the port field

function render() {
  if (!els) return;
  const view = state ? VIEW[state] : null;
  els.dot.className = `diag-item__dot ${view ? view.dot : 'diag-item__dot--unknown'}`;
  els.status.textContent = t(view ? view.textKey : 'freellm.status.checking');
  els.dashboard.hidden = state !== 'up';
  els.portStatus.hidden = !portNote;
  if (portNote) {
    els.portStatus.textContent = t(portNote.key, portNote.params);
    els.portStatus.classList.toggle('is-fail', portNote.fail);
  }
}

async function refreshStatus() {
  if (!els) return;
  const mine = ++seq;
  state = null;
  render();
  let next;
  try {
    next = await window.lunacore.getFreeLlmStatus();
  } catch {
    next = 'not-running';
  }
  if (mine !== seq) return;
  state = VIEW[next] ? next : 'not-running';
  render();
}

async function savePort() {
  if (!els) return;
  els.save.disabled = true;
  let result;
  try {
    result = await window.lunacore.setFreeLlmPort(els.port.value);
  } catch {
    result = null;
  }
  if (!els) return;
  els.save.disabled = false;
  if (result && result.ok) {
    els.port.value = String(result.port);
    portNote = { key: 'freellm.saved', params: { port: result.port }, fail: false };
    refreshStatus();
  } else {
    portNote = { key: result && result.reason === 'invalid-port' ? 'freellm.invalidPort' : 'freellm.saveFailed', fail: true };
    render();
  }
}

/**
 * Called from mountProviderSettings() - the row sits in the same Settings section.
 * @param {ParentNode} root
 * @returns {() => void} disposer
 */
export function mountGatewaySettings(root) {
  els = {
    dot: root.querySelector('#freellm-status-dot'),
    status: root.querySelector('#freellm-status'),
    refresh: root.querySelector('#freellm-refresh-btn'),
    dashboard: root.querySelector('#freellm-dashboard-btn'),
    port: root.querySelector('#freellm-port'),
    save: root.querySelector('#freellm-save-btn'),
    portStatus: root.querySelector('#freellm-port-status'),
  };
  if (!els.status || !els.port || typeof window.lunacore.getFreeLlmStatus !== 'function') {
    els = null;
    return () => {};
  }

  els.refresh.addEventListener('click', refreshStatus);
  els.dashboard.addEventListener('click', () => window.lunacore.openFreeLlmDashboard());
  els.save.addEventListener('click', savePort);
  els.port.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') savePort();
  });

  window.lunacore.getFreeLlmPort()
    .then((port) => {
      if (els) els.port.value = String(port);
    })
    .catch(() => {});
  const offLang = onLangChange(render);
  refreshStatus();

  return () => {
    offLang();
    els = null;
  };
}
