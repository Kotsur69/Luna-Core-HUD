// ============================================================================
// LunaCore - the Unity calls Luna's Work makes (LW 3.36b, Unity Pipeline)
// ----------------------------------------------------------------------------
// Every call into the Unity editor goes through one of the two tables below:
// the adapter (enter / leave play mode, open the scene, dump the console as
// evidence) and the Playtester's bridge (screenshot, game state, scripted
// input, console). Each entry is a FIXED command - the model never names a
// Unity tool, command or action itself, so the coarse editor tools are only
// ever used for the one action listed here. If the editor names a call
// differently, fix it HERE and nowhere else.
//
// Two transports, same call names (UNITY_TRANSPORTS):
//
//   pipeline  the official Unity MCP (com.unity.pipeline) over its HTTP API,
//             pipeline-http.js: '<group> <name>' commands, e.g.
//             'editor.playmode start'. Used by a profile without unityMcpUrl.
//   mcp       legacy: the community "MCP for Unity" server over MCP-over-HTTP,
//             mcp-http.js: manage_editor / manage_scene / read_console /
//             execute_custom_tool. Used by a profile with unityMcpUrl.
//
// PlaytestDriver protocol (the God Mode card in src/lunasworkUnity.js builds
// the C# side). Pipeline: command group `playtest`; legacy: custom tool
// `playtest_driver` with parameters {action, ...}.
//   state       -> {scene, ...game-specific snapshot}
//   input       {steps} (tools.js send_input) -> {done:n}
//               Pipeline passes steps as a JSON string (--steps <json>).
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
const DRIVER_GROUP = 'playtest';
const CONSOLE_COUNT = 100;
const PIPELINE_CONSOLE_LEVEL = 'warning';

/** Legacy MCP for Unity: call name -> [tool, args]; functions take the call's own parameters. */
const UNITY_MCP = Object.freeze({
  play: () => [UNITY_MCP_TOOLS.editor, { action: 'play' }],
  stop: () => [UNITY_MCP_TOOLS.editor, { action: 'stop' }],
  state: () => [UNITY_MCP_TOOLS.editor, { action: 'get_state' }],
  openScene: (scenePath) => [UNITY_MCP_TOOLS.scene, { action: 'load', path: scenePath }],
  console: () => [UNITY_MCP_TOOLS.console, { action: 'get', types: ['error', 'warning'], count: CONSOLE_COUNT }],
  driver: (action, params = {}) => [UNITY_MCP_TOOLS.custom, { tool_name: DRIVER_TOOL, parameters: { ...params, action } }],
});

/** The PlaytestDriver's Pipeline commands; an unknown action is refused, never guessed. */
function pipelineDriver(action, params = {}) {
  switch (action) {
    case 'state':
      return [`${DRIVER_GROUP} state`, {}];
    case 'input':
      if (!Array.isArray(params.steps)) throw new Error('PlaytestDriver input needs a steps array');
      return [`${DRIVER_GROUP} input`, { steps: JSON.stringify(params.steps) }];
    case 'screenshot':
      return [`${DRIVER_GROUP} screenshot`, {}];
    default:
      throw new Error(`unknown PlaytestDriver action '${String(action)}'`);
  }
}

/** Unity Pipeline: call name -> [command, parameters]. */
const UNITY_PIPELINE = Object.freeze({
  play: () => ['editor.playmode start', {}],
  stop: () => ['editor.playmode stop', {}],
  // result: {status, compiling, domainReloadInProgress, playMode 'stopped'|'playing', playerLoopTicking, runInBackground}
  state: () => ['editor status', {}],
  openScene: (scenePath) => ['scene open', { path: scenePath }],
  // result: {entries:[{level, logType, message, stackTrace}], counts:{error, warn, log}, groundTruth:{compilationFailed, consoleErrors}}
  console: () => ['console get', { tail: CONSOLE_COUNT, level: PIPELINE_CONSOLE_LEVEL }],
  driver: pipelineDriver,
});

/**
 * Unity Pipeline asset calls of the Luna's Work asset pipeline
 * (src/lunasworkAssetPipeline.js): import a file written under Assets/, make a
 * prefab from an imported model, a material from an imported texture. Paths
 * are project-relative ("Assets/..."), built by LunaCore, never by a model.
 * NOT verified against a live editor yet: if com.unity.pipeline names these
 * commands differently, fix them here.
 */
const UNITY_PIPELINE_ASSETS = Object.freeze({
  importAsset: (assetPath) => ['assets import', { path: assetPath }],
  createPrefab: (sourcePath, prefabPath) => ['prefab create', { source: sourcePath, path: prefabPath }],
  createMaterial: (texturePath, materialPath) => ['material create', { path: materialPath, texture: texturePath }],
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
  // Unity Pipeline 'editor status'.
  if (typeof state.playMode === 'string') return state.playMode === 'playing';
  return isObj(state.editor) ? isPlaying(state.editor) : false;
}

/**
 * One call of the legacy table through an MCP client.
 * @param {{callTool:Function}} client mcp-http.js
 * @param {[string, object]} call e.g. UNITY_MCP.play()
 */
async function unityCall(client, [tool, args]) {
  return unwrap(await client.callTool(tool, args));
}

/**
 * One call of the Pipeline table. A custom command may hand its object back
 * as JSON text; that text is parsed, any other string is returned as it is.
 * @param {{exec:Function}} client pipeline-http.js
 * @param {[string, object]} call e.g. UNITY_PIPELINE.play()
 */
async function pipelineCall(client, [command, parameters]) {
  const result = await client.exec(command, parameters);
  if (typeof result !== 'string') return result;
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed === 'object' ? parsed : result;
  } catch {
    return result;
  }
}

/** transport -> {calls: its table, invoke(client, call)}. */
const UNITY_TRANSPORTS = Object.freeze({
  pipeline: Object.freeze({ calls: UNITY_PIPELINE, invoke: pipelineCall }),
  mcp: Object.freeze({ calls: UNITY_MCP, invoke: unityCall }),
});

module.exports = {
  UNITY_MCP_TOOLS,
  UNITY_MCP,
  UNITY_PIPELINE,
  UNITY_PIPELINE_ASSETS,
  UNITY_TRANSPORTS,
  DRIVER_TOOL,
  DRIVER_GROUP,
  resultText,
  unwrap,
  isPlaying,
  unityCall,
  pipelineCall,
};
