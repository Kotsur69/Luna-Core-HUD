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
//   state       -> {scene, ...game-specific snapshot, combatFeelLog?: [...]}
//               combatFeelLog (optional ring buffer of combat timing samples)
//               is untrusted: withCombatFeelLog() cleans and caps it
//               (combatFeelLog.js) wherever LunaCore reads the state.
//   input      {steps} (tools.js send_input) -> {done:n}
//               Pipeline passes steps as a JSON string (--steps <json>).
//   screenshot  -> {png:<base64>, width, height}   (Game view, play mode only)
//
// A game without the driver (Pipeline only): the adapter reads once per
// session whether the `playtest` group exists (unityBuiltin.js, no trial
// call of a missing command) and then runs the same three actions on the
// editor's built-in commands. playtestActions() picks the set by mode.
// ============================================================================

'use strict';

const unityAnimation = require('./unityAnimation');
const combatFeelLog = require('./combatFeelLog');
const unityBuiltin = require('./unityBuiltin');

const UNITY_MCP_TOOLS = Object.freeze({
  editor: 'manage_editor',
  scene: 'manage_scene',
  console: 'read_console',
  custom: 'execute_custom_tool',
});
const DRIVER_TOOL = 'playtest_driver';
const { DRIVER_GROUP, PLAYTEST_MODE } = unityBuiltin;
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

// A project asset path LunaCore built: "Assets/" then segments of word
// characters, spaces, dots, parentheses, plus and dashes (lunasworkZip's
// SAFE_NAME_RE), each starting with a word character, so ".." never passes.
// None of these characters needs escaping inside a C# string literal.
const ASSET_PATH_RE = /^Assets(?:\/\w[\w .()+-]{0,119}){1,12}$/;
const MATERIAL_TEXTURE_PROPERTY = '_BaseMap';
const MATERIAL_TYPE = 'UnityEngine.Material';
const REFRESH_MENU = 'Assets/Refresh';

/** The path itself; throws unless it is a project asset path LunaCore could have built. */
function assetPath(value) {
  if (typeof value !== 'string' || !ASSET_PATH_RE.test(value)) throw new Error(`not a project asset path: ${String(value).slice(0, 200)}`);
  return value;
}

/**
 * C# for `script eval` that saves a model asset (FBX...) as a prefab: the
 * model is instantiated into a throwaway preview scene, saved with
 * PrefabUtility.SaveAsPrefabAsset (a prefab variant of the model) and the
 * preview scene is closed again, so the open scene is never touched or dirtied.
 * Both paths are checked by assetPath(), so they cannot break out of their literal.
 */
function modelPrefabCode(modelPath, prefabPath) {
  const model = JSON.stringify(assetPath(modelPath));
  const prefab = JSON.stringify(assetPath(prefabPath));
  return [
    `var model = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>(${model});`,
    `if (model == null) throw new System.Exception("no model asset at " + ${model} + " (not imported, or no importer for this format)");`,
    'var stage = UnityEditor.SceneManagement.EditorSceneManager.NewPreviewScene();',
    'try {',
    '  var instance = (UnityEngine.GameObject)UnityEditor.PrefabUtility.InstantiatePrefab(model, stage);',
    `  var saved = UnityEditor.PrefabUtility.SaveAsPrefabAsset(instance, ${prefab}, out var ok);`,
    `  if (!ok || saved == null) throw new System.Exception("could not save the prefab " + ${prefab});`,
    '  return UnityEditor.AssetDatabase.GetAssetPath(saved);',
    '} finally {',
    '  UnityEditor.SceneManagement.EditorSceneManager.ClosePreviewScene(stage);',
    '}',
  ].join('\n');
}

/**
 * Unity Pipeline asset calls of the Luna's Work asset pipeline
 * (src/lunasworkAssetPipeline.js). Paths are project-relative ("Assets/..."),
 * built by LunaCore, never by a model; command names and parameter keys are fixed.
 *
 * Verified live 2026-11-25 against Unity 6000.6.4f1 + com.unity.pipeline 1.0.0
 * (authoring root "Assets", URP 17.6), through pipeline-http.js:
 *   refresh         LunaCore writes the file under Assets/ itself, and with the
 *                   editor unfocused autoRefresh does NOT import it (asset find
 *                   saw nothing). The Assets/Refresh menu item imports it without
 *                   taking focus. `asset import --source --path` is not used: it
 *                   copies an EXTERNAL file in, and the file is already at its path.
 *   modelPrefab     `prefab create --source <model>` fails ("Can't save persistent
 *                   Objects...") and `prefab instantiate` / `prefab create_variant`
 *                   refuse a model ("is not a prefab asset"), for FBX and OBJ
 *                   alike, each with a console ERROR. So the prefab is made by a
 *                   fixed `script eval` template (modelPrefabCode); it needs the
 *                   Pipeline's script eval capability to be enabled.
 *   material        `asset create --type UnityEngine.Material` (URP/Lit under URP,
 *                   else Standard), then `material set_properties` with
 *                   properties as a JSON object; the answer lists applied[] /
 *                   unknown[] property names (checkTextureApplied).
 */
const UNITY_PIPELINE_ASSETS = Object.freeze({
  refresh: () => ['editor invoke_menu', { path: REFRESH_MENU }],
  modelPrefab: (modelPath, prefabPath) => ['script eval', { code: modelPrefabCode(modelPath, prefabPath) }],
  createMaterial: (materialPath) => ['asset create', { path: assetPath(materialPath), type: MATERIAL_TYPE }],
  setMaterialTexture: (materialPath, texturePath) => [
    'material set_properties',
    { material: assetPath(materialPath), properties: { [MATERIAL_TEXTURE_PROPERTY]: { path: assetPath(texturePath) } } },
  ],
});

/**
 * Throws unless a `material set_properties` answer applied the texture: an
 * unknown property is only listed in unknown[] (e.g. _BaseMap on a built-in
 * pipeline shader), not raised, and would leave an untextured material behind.
 */
function checkTextureApplied(result) {
  const applied = isObj(result) && Array.isArray(result.applied) ? result.applied : [];
  if (!applied.includes(MATERIAL_TEXTURE_PROPERTY)) {
    throw new Error(`the material did not take the texture (${MATERIAL_TEXTURE_PROPERTY} not applied; is the shader URP/Lit?)`);
  }
  return result;
}

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

/**
 * The PlaytestDriver's three actions (state, input(steps), screenshot) for one
 * session: the game's own `playtest` commands, or in builtin mode the editor's
 * built-in Pipeline commands (unityBuiltin.js; Pipeline transport only).
 * @param {{mode?:string, transport?:'pipeline'|'mcp', call:Function, sleep:Function}} opts
 */
function playtestActions({ mode = PLAYTEST_MODE.driver, transport = 'pipeline', call, sleep }) {
  if (mode === PLAYTEST_MODE.builtin) {
    if (transport !== 'pipeline') throw new Error('the built-in playtest commands need the Unity Pipeline transport');
    return unityBuiltin.builtinActions(call, sleep);
  }
  if (mode !== PLAYTEST_MODE.driver) throw new Error(`unknown playtest mode '${String(mode)}'`);
  const { calls } = UNITY_TRANSPORTS[transport];
  return {
    state: () => call(calls.driver('state')),
    input: (steps) => call(calls.driver('input', { steps })),
    screenshot: () => call(calls.driver('screenshot')),
  };
}

// ---- animation frame sync (unityAnimation.js) ---------------------------------------
// AttackStep frame data vs. AnimationClip: Pipeline only, for scene / asset
// workers, never the Playtester (baking writes assets).

/**
 * animation_frame_sync through one Pipeline client.
 * @param {{exec:Function}} client pipeline-http.js
 * @param {unknown} payload the worker's {clipPath, attackStepPath, fps?, bake?, characterPath?}
 */
function animationFrameSync(client, payload) {
  return unityAnimation.runAnimationFrameSync(payload, (call) => pipelineCall(client, call));
}

module.exports = {
  UNITY_MCP_TOOLS,
  UNITY_MCP,
  UNITY_PIPELINE,
  UNITY_PIPELINE_ASSETS,
  checkTextureApplied,
  UNITY_TRANSPORTS,
  DRIVER_TOOL,
  DRIVER_GROUP,
  DRIVER_COMMANDS: unityBuiltin.DRIVER_COMMANDS,
  PLAYTEST_MODE,
  UNITY_PIPELINE_BUILTIN: unityBuiltin.UNITY_PIPELINE_BUILTIN,
  playtestModeOf: unityBuiltin.playtestModeOf,
  playtestActions,
  resultText,
  unwrap,
  isPlaying,
  unityCall,
  pipelineCall,
  UNITY_PIPELINE_ANIMATION: unityAnimation.UNITY_PIPELINE_ANIMATION,
  ANIMATION_FRAME_SYNC_TOOL: unityAnimation.ANIMATION_FRAME_SYNC_TOOL,
  animationFrameSync,
  MAX_COMBAT_FEEL_ENTRIES: combatFeelLog.MAX_COMBAT_FEEL_ENTRIES,
  parseCombatFeelLog: combatFeelLog.parseCombatFeelLog,
  withCombatFeelLog: combatFeelLog.withCombatFeelLog,
};
