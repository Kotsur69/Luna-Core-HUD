// ============================================================================
// LunaCore - host mode IPC (Settings -> Host mode)
// ----------------------------------------------------------------------------
// One channel, `hostMode:run`, carrying one action name. The renderer is not
// trusted: anything but an exact action from the whitelist is refused before
// src/hostswitch.js is touched. Answers carry only {ok, on, isDefault,
// machine} or {ok:false, reason} - no paths, keys or cloud state.
// ============================================================================

'use strict';

const ACTIONS = Object.freeze(['status', 'start', 'stop', 'make-default']);

/** Renderer payload -> an action name, or null. Only the exact strings count. */
function validAction(payload) {
  return typeof payload === 'string' && ACTIONS.includes(payload) ? payload : null;
}

/**
 * Runs one validated action against the host switch.
 * @param {ReturnType<import('./hostswitch').createHostSwitch>|null} control
 * @param {unknown} payload
 */
function runHostMode(control, payload) {
  const action = validAction(payload);
  if (!action) return { ok: false, reason: 'badAction' };
  // Headless host (`--host` with no HUD) never registers this; guard anyway.
  if (!control) return { ok: false, reason: 'unavailable' };
  try {
    if (action === 'start') return control.start();
    if (action === 'stop') return control.stop();
    if (action === 'make-default') return control.makeDefault();
    return control.status();
  } catch (err) {
    console.error('[hostmodeipc] action failed:', action, err && err.message);
    return { ok: false, reason: 'failed' };
  }
}

/** @param {{ipcMain: object, control: object|null}} deps */
function registerHostModeIpc({ ipcMain, control }) {
  ipcMain.handle('hostMode:run', (_event, payload) => runHostMode(control, payload));
}

module.exports = { registerHostModeIpc, runHostMode, validAction, ACTIONS };
