// ============================================================================
// LunaCore - Luna's Work: handing the Playtester bridge to `claude -p`
// ----------------------------------------------------------------------------
// The electron and unity adapters' tools(): an --mcp-config with ONE stdio
// server, helpers/playtest-bridge/bridge.js, run by LunaCore's own binary as
// plain Node, and an allow-list built from the bridge's own tool names
// (helpers/playtest-bridge/tools.js) - the two cannot drift apart.
//
// helpers/** is asarUnpack'ed (package.json): a process that is not LunaCore
// (the bridge under ELECTRON_RUN_AS_NODE, the app under test loading the
// wrapper) cannot read inside app.asar, so paths point at app.asar.unpacked.
// ============================================================================

'use strict';

const path = require('path');
const { toolNames } = require('../helpers/playtest-bridge/tools');

const HELPERS_DIR = path.join(__dirname, '..', 'helpers', 'playtest-bridge');
// Same rewrite as missionnews.js: inside a packaged build, read the unpacked copy.
const unpacked = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const BRIDGE_PATH = unpacked(path.join(HELPERS_DIR, 'bridge.js'));
const WRAPPER_PATH = unpacked(path.join(HELPERS_DIR, 'electron-wrapper.js'));
// The MCP server name per backend, as it appears in mcp__<server>__<tool>.
const SERVER_NAMES = Object.freeze({ electron: 'electron-app', unity: 'unity-game' });

/**
 * @param {'electron'|'unity'} backend
 * @param {{evidenceDir:string, nodeBinary:string, args:string[]}} opts args = the backend's own flags
 * @returns {{mcpConfig:{mcpServers:object}, allowedTools:string[]}} fresh objects every call
 */
function bridgeTools(backend, { evidenceDir, nodeBinary, args }) {
  const server = SERVER_NAMES[backend];
  if (!server) throw new Error(`no bridge for '${String(backend)}'`);
  return {
    mcpConfig: {
      mcpServers: {
        [server]: {
          type: 'stdio',
          command: nodeBinary,
          args: [BRIDGE_PATH, '--backend', backend, '--evidence-dir', evidenceDir, ...args],
          // LunaCore's binary is Electron; this makes it plain Node for the bridge.
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    },
    allowedTools: toolNames(backend).map((t) => `mcp__${server}__${t}`),
  };
}

/** What an adapter that is not started yet offers: nothing (runPlaytest refuses it). */
const noTools = () => ({ mcpConfig: { mcpServers: {} }, allowedTools: [] });

module.exports = {
  BRIDGE_PATH,
  WRAPPER_PATH,
  SERVER_NAMES,
  bridgeTools,
  noTools,
};
