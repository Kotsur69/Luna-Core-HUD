// ============================================================================
// LunaCore - claude-code-router (CCR) gateway status (Settings overlay)
// ----------------------------------------------------------------------------
// Phase 4d of the AI-providers feature (reference/AI_PROVIDERS_RESUME.md):
// the Settings-panel half of src/ccr.js's gateway lifecycle control. Static
// markup in the Settings overlay (#termcustom), mounted once from
// termcustom.js's init - same shape as lmstudiomodels.js's
// mountLmStudioSettings(). describeCcrStatus() is the one pure decision this
// module makes (state -> status text/dot/button-availability) and is
// unit-tested directly (test/ccrsettings-renderer.test.js); everything else
// here is DOM/IPC glue and is left untested per this repo's existing
// convention for renderer modules/*.js files (see providersettings.js).
//
// HARD BOUNDARY carried over from src/ccr.js: CCR's own provider/model/
// routing config is edited ONLY through "Open CCR settings" (CCR's own
// browser UI) - this module never displays a URL, a token, or CCR config.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange } from './bus.js';

// States describeState() (src/ccr.js) can hand back over `ccr:status` where
// the gateway is genuinely answering requests (possibly gated behind auth).
const GATEWAY_ANSWERING_STATES = new Set(['up', 'port-mismatch', 'auth-required']);

/**
 * Pure decision table: a `ccr:status` IPC result -> what the status line/dot
 * should say and which action buttons make sense right now. No I/O.
 * @param {{installed?:boolean, state?:string, port?:number, startedByUs?:boolean}} status
 * @returns {{textKey:string, textParams?:Object, dotClass:string,
 *   canStart:boolean, canStop:boolean, canOpenUi:boolean}}
 */
function describeCcrStatus(status) {
  const s = status && typeof status === 'object' ? status : {};
  const installed = s.installed === true;
  const state = installed && typeof s.state === 'string' ? s.state : 'not-installed';
  const port = Number.isFinite(s.port) ? s.port : null;
  const startedByUs = s.startedByUs === true;

  if (state === 'not-installed') {
    return { textKey: 'ccr.status.notInstalled', dotClass: 'diag-item__dot--fail', canStart: false, canStop: false, canOpenUi: false };
  }

  // Only LunaCore-started gateways are ours to stop (stopGateway() refuses
  // with `not-ours` otherwise) - never offer a Stop that will just fail.
  const canStop = startedByUs;
  // Starting again is pointless once something is already answering or a
  // start is already in flight from a previous call.
  const canStart = !GATEWAY_ANSWERING_STATES.has(state) && state !== 'starting';
  const canOpenUi = true;

  switch (state) {
    case 'starting':
      return { textKey: 'ccr.status.starting', dotClass: 'diag-item__dot--unknown', canStart, canStop, canOpenUi };
    case 'up':
      return { textKey: 'ccr.status.up', textParams: { port }, dotClass: 'diag-item__dot--ok', canStart, canStop, canOpenUi };
    case 'auth-required':
      return { textKey: 'ccr.status.authRequired', textParams: { port }, dotClass: 'diag-item__dot--ok', canStart, canStop, canOpenUi };
    case 'port-mismatch':
      return { textKey: 'ccr.status.portMismatch', textParams: { port }, dotClass: 'diag-item__dot--warn', canStart, canStop, canOpenUi };
    case 'foreign-port':
      return { textKey: 'ccr.status.foreignPort', textParams: { port }, dotClass: 'diag-item__dot--warn', canStart, canStop, canOpenUi };
    case 'down':
      return { textKey: 'ccr.status.down', dotClass: 'diag-item__dot--fail', canStart, canStop, canOpenUi };
    default:
      return { textKey: 'ccr.status.unknown', dotClass: 'diag-item__dot--unknown', canStart, canStop, canOpenUi };
  }
}

/** i18n key for a failed `ccr:start` result's typed reason. */
function startFailureKey(reason) {
  if (reason === 'busy') return 'ccr.error.start.busy';
  if (reason === 'start-failed') return 'ccr.error.start.startFailed';
  if (reason === 'timeout') return 'ccr.error.start.timeout';
  return 'ccr.error.generic';
}

/** i18n key for a failed `ccr:stop` result's typed reason. */
function stopFailureKey(reason) {
  if (reason === 'not-ours') return 'ccr.error.stop.notOurs';
  if (reason === 'not-found') return 'ccr.error.stop.notFound';
  if (reason === 'error') return 'ccr.error.stop.error';
  return 'ccr.error.generic';
}

/** i18n key for a failed `ccr:open-ui` result's typed reason. */
function openUiFailureKey(reason) {
  if (reason === 'not-found') return 'ccr.error.openUi.notFound';
  if (reason === 'launch-failed') return 'ccr.error.openUi.launchFailed';
  return 'ccr.error.generic';
}

// Module state survives a remount, same reasoning as lmstudiomodels.js's
// module-level `status`/`models` (the overlay is static markup, so this
// mostly matters for a language switch's repaint).
let status = null; // last getCcrStatus() result, or null before the first check
let busyAction = null; // 'start' | 'stop' | 'openUi' | null - guards double-submit
let actionError = null; // last action's translated failure text, or null

let els = null;

function render() {
  if (!els) return;

  if (!status) {
    els.dot.className = 'diag-item__dot diag-item__dot--unknown';
    els.status.textContent = t('ccr.status.checking');
    els.startBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.openUiBtn.disabled = true;
    els.installHelpBtn.hidden = true;
    els.actionStatus.hidden = true;
    return;
  }

  const info = describeCcrStatus(status);
  els.dot.className = `diag-item__dot ${info.dotClass}`;
  els.status.textContent = t(info.textKey, info.textParams);

  const inFlight = busyAction !== null;
  els.startBtn.disabled = inFlight || !info.canStart;
  els.stopBtn.disabled = inFlight || !info.canStop;
  els.openUiBtn.disabled = inFlight || !info.canOpenUi;
  els.installHelpBtn.hidden = status.installed === true;

  els.actionStatus.hidden = !actionError;
  if (actionError) els.actionStatus.textContent = actionError;
}

/** First load, the refresh button, and a `ccr:state` broadcast all funnel here. */
async function refreshStatus() {
  try {
    status = await window.lunacore.getCcrStatus();
  } catch {
    status = { installed: false, state: 'not-installed' };
  }
  render();
}

/** Runs one Start/Stop/Open-UI action, guarding against overlap and surfacing a typed failure. */
async function runAction(name, call, toFailureKey) {
  if (busyAction) return;
  busyAction = name;
  actionError = null;
  render();

  let result;
  try {
    result = await call();
  } catch {
    result = { ok: false, reason: 'error' };
  }
  if (!result || !result.ok) actionError = t(toFailureKey(result && result.reason));

  busyAction = null;
  await refreshStatus();
}

/**
 * Called once from termcustom.js's Settings-overlay init, same pattern as
 * lmstudiomodels.js's mountLmStudioSettings(root).
 * @param {ParentNode} root
 * @returns {() => void} disposer
 */
export function mountCcrSettings(root) {
  els = {
    dot: root.querySelector('#ccr-status-dot'),
    status: root.querySelector('#ccr-status'),
    refreshBtn: root.querySelector('#ccr-refresh-btn'),
    startBtn: root.querySelector('#ccr-start-btn'),
    stopBtn: root.querySelector('#ccr-stop-btn'),
    openUiBtn: root.querySelector('#ccr-open-ui-btn'),
    installHelpBtn: root.querySelector('#ccr-install-help-btn'),
    actionStatus: root.querySelector('#ccr-action-status'),
  };
  if (!els.status) {
    els = null;
    return () => {};
  }

  render();

  els.refreshBtn.addEventListener('click', () => refreshStatus());
  els.startBtn.addEventListener('click', () => runAction('start', () => window.lunacore.startCcr(), startFailureKey));
  els.stopBtn.addEventListener('click', () => runAction('stop', () => window.lunacore.stopCcr(), stopFailureKey));
  els.openUiBtn.addEventListener('click', () => runAction('openUi', () => window.lunacore.openCcrUi(), openUiFailureKey));
  els.installHelpBtn.addEventListener('click', () => window.lunacore.openCcrDocs());

  const offLang = onLangChange(render);

  // Live update when a background tab spawn starts the gateway on its own -
  // the broadcast payload only ever carries { startedByUs, sessionId? }, not
  // the fields this UI needs (installed/version/state/port), so re-fetching
  // the full status is the safe choice over trying to merge a partial patch.
  window.lunacore.onCcrState(() => refreshStatus());

  refreshStatus();

  return () => {
    offLang();
    els = null;
  };
}

export { describeCcrStatus };
