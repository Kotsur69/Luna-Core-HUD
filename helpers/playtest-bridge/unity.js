// ============================================================================
// LunaCore - the Unity MCP calls Luna's Work makes (LW 3.36b)
// ----------------------------------------------------------------------------
// Every call into the Unity editor goes through this table: the adapter
// (enter / leave play mode, open the scene, dump the console as evidence) and
// the Playtester's bridge (screenshot, game state, scripted input, console).
// Each entry is a FIXED tool + action - the model never names a Unity MCP tool
// or action itself, so the coarse editor tools (manage_scene can also create
// and save, manage_editor can add tags...) are only ever used for the one
// action listed here.
//
// Tool names follow MCP for Unity (manage_editor / manage_scene /
// read_console / execute_custom_tool). The LW 3.36a live spike had not
// reported when this was written: if the editor's server names them
// differently, fix it HERE and nowhere else.
//
// PlaytestDriver protocol (the God Mode card in src/lunasworkUnity.js builds
// the C# side): custom tool `playtest_driver`, parameters {action, ...}
//   state       -> {scene, ...game-specific snapshot}
//   input       {steps:[...]} (tools.js send_input) -> {done:n}
//   screenshot  -> {png:<base64>, width, height}   (Game view, play mode only)
// ============================================================================

'use strict';

const UNITY_MCP_TOOLS = Object.freeze({
  editor: 'manage_editor',
  scene: 'manage_scene',
  console: 'read_console',
  custom: 'execute_custom_tool',
});
const DRIVER_TOOL = 'playtest_driver';
const CONSOLE_COUNT = 100;

/** call name -> [tool, args]; functions take the call's own parameters. */
const UNITY_MCP = Object.freeze({
  play: () => [UNITY_MCP_TOOLS.editor, { action: 'play' }],
  stop: () => [UNITY_MCP_TOOLS.editor, { action: 'stop' }],
  state: () => [UNITY_MCP_TOOLS.editor, { action: 'get_state' }],
  openScene: (scenePath) => [UNITY_MCP_TOOLS.scene, { action: 'load', path: scenePath }],
  console: () => [UNITY_MCP_TOOLS.console, { action: 'get', types: ['error', 'warning'], count: CONSOLE_COUNT }],
  driver: (action, params = {}) => [UNITY_MCP_TOOLS.custom, { tool_name: DRIVER_TOOL, parameters: { ...params, action } }],
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The text items of an MCP tool result, joined. */
function resultText(result) {
  const content = isObj(result) && Array.isArray(result.content) ? result.content : [];
  return content.filter((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
}

/** structuredContent, or the text parsed as JSON, or {message: text}. */
function resultJson(result) {
  if (isObj(result) && isObj(result.structuredContent)) return result.structuredContent;
  const text = resultText(result);
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * The payload of a Unity MCP tool result: MCP for Unity wraps answers as
 * {success, message, data}. Throws on an MCP error or success:false.
 */
function unwrap(result) {
  const json = resultJson(result);
  const failed = (isObj(result) && result.isError === true) || (isObj(json) && json.success === false);
  if (failed) throw new Error(String((isObj(json) && (json.message || json.error)) || resultText(result) || 'Unity MCP call failed').slice(0, 500));
  return isObj(json) && json.data !== undefined ? json.data : json;
}

/** True when the editor state says play mode is on. */
function isPlaying(state) {
  if (!isObj(state)) return false;
  for (const key of ['isPlaying', 'is_playing', 'playing']) {
    if (typeof state[key] === 'boolean') return state[key];
  }
  return isObj(state.editor) ? isPlaying(state.editor) : false;
}

/**
 * One call of the table above through an MCP client.
 * @param {{callTool:Function}} client mcp-http.js
 * @param {[string, object]} call e.g. UNITY_MCP.play()
 */
async function unityCall(client, [tool, args]) {
  return unwrap(await client.callTool(tool, args));
}

module.exports = {
  UNITY_MCP_TOOLS,
  UNITY_MCP,
  DRIVER_TOOL,
  resultText,
  unwrap,
  isPlaying,
  unityCall,
};
