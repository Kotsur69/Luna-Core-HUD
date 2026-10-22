// ============================================================================
// LunaCore - FreeLLMAPI gateway IPC (main process)
// ----------------------------------------------------------------------------
// freellm:get-port        -> number (the configured port)
// freellm:set-port {port} -> {ok:true, port} | {ok:false, reason}  (validated here)
// freellm:status          -> 'up' | 'not-running' | 'not-installed'
// freellm:open-dashboard  -> opens the gateway's own page, only when it is up
//
// The renderer never names a host or a URL: main builds it from the saved
// port (src/freellmgateway.js). Lives outside main.js (past the file-size
// guideline); main.js only calls registerFreeLlmIpc() once.
// ============================================================================

'use strict';

const gateway = require('./freellmgateway');

/**
 * @param {{ipcMain:object, shell:{openExternal:Function}, deps?:{load?:Function, save?:Function, status?:Function}}} args
 */
function registerFreeLlmIpc({ ipcMain, shell, deps = {} }) {
  const load = deps.load || gateway.loadGatewayPrefs;
  const save = deps.save || gateway.saveGatewayPrefs;
  const status = deps.status || gateway.gatewayStatus;

  ipcMain.handle('freellm:get-port', () => load().port);

  ipcMain.handle('freellm:set-port', (_event, port) => {
    const parsed = gateway.parseGatewayPort(port);
    // Main is the validator: a bad value is reported and nothing is saved.
    if (parsed === null) return { ok: false, reason: 'invalid-port', port: load().port };
    const result = save({ port: parsed });
    return result.ok ? { ok: true, port: result.prefs.port } : { ok: false, reason: result.reason, port: load().port };
  });

  ipcMain.handle('freellm:status', async () => {
    try {
      const state = await status(load().port);
      return gateway.GATEWAY_STATES.includes(state) ? state : 'not-running';
    } catch {
      return 'not-running';
    }
  });

  ipcMain.on('freellm:open-dashboard', async () => {
    const port = load().port;
    try {
      if ((await status(port)) === 'up') shell.openExternal(`${gateway.gatewayUrl(port)}/`);
    } catch {
      // A failed probe opens nothing - the row already shows the state.
    }
  });
}

module.exports = { registerFreeLlmIpc };
