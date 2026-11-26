// ============================================================================
// LunaCore - the PlaytestDriver contract, as text for the game's builder
// ----------------------------------------------------------------------------
// PLAYTEST_CONTRACT states exactly what LunaCore sends to and parses from the
// game's `playtest` Pipeline commands: the [CliGroupCommand] editor code, the
// command and parameter names, the step shapes, the answer shapes and what
// happens when a command is missing. The PlaytestDriver card
// (src/lunasworkUnity.js) quotes it verbatim.
//
// Every name and limit below comes from the code that uses it (unity.js
// pipelineDriver, unityBuiltin.js, tools.js, combatFeelLog.js, bridge.js), so
// the text cannot drift from the parser. Plain Node, no dependencies.
// ============================================================================

'use strict';

const { DRIVER_GROUP, DRIVER_ACTIONS, UNITY_PIPELINE_BUILTIN } = require('./unityBuiltin');
const { MAX_INPUT_STEPS, MAX_HOLD_MS, MAX_WAIT_MS, INPUT_TYPES } = require('./tools');
const { MAX_COMBAT_FEEL_ENTRIES, COMBAT_FEEL_LIMITS: F } = require('./combatFeelLog');

// What the bridge shows the Playtester of one answer (bridge.js MAX_RESULT_CHARS).
const SHOWN_RESULT_CHARS = 50000;

const command = (action) => `${DRIVER_GROUP} ${action}`;
const builtin = (call) => call[0];
const hold = `"holdMs"?: 0..${MAX_HOLD_MS}`;

/** The step shapes, one line per type of tools.js INPUT_TYPES (same order). */
const STEP_SHAPES = Object.freeze({
  key: `{"type":"key", "key":<Unity key name>, ${hold}}`,
  button: `{"type":"button", "name":<Input Manager button / Input System action>, ${hold}}`,
  axis: `{"type":"axis", "name":<axis>, "value": -1..1, ${hold}}`,
  click: '{"type":"click", "x": 0..1, "y": 0..1}   (fraction of the screen)',
  ui: '{"type":"ui", "name":<GameObject name of an active UI Button>}',
  wait: `{"type":"wait", "ms": 0..${MAX_WAIT_MS}}`,
});

// Where the [CliGroupCommand] / [CliArg] attributes come from. Not confirmed from a
// com.unity.pipeline package on the machine that wrote this, so no namespace or
// assembly is named: a guessed one ("Unity.Pipeline.Attributes") sent workers
// down the wrong path. The package's own doc is the source of truth.
const PIPELINE_ATTRIBUTES_GUIDANCE = 'Use the [CliGroupCommand] / [CliArg] attributes exactly as Documentation~/creating-commands.md of the com.unity.pipeline package shows (namespace and assembly from there, plus the autoReferenced flag of the package .asmdef; do not guess them). An Editor folder that belongs to no asmdef needs no asmdef of its own when that package assembly is autoReferenced; Assets/LunaPlaytest/Editor sits under LunaPlaytest.asmdef, so it keeps its own editor-only asmdef (includePlatforms Editor), which references LunaPlaytest and, by the name the package declares, the command assembly (autoReferenced never reaches a custom asmdef).';

const [listCommand, listParams] = UNITY_PIPELINE_BUILTIN.listDriverCommands();
const B = UNITY_PIPELINE_BUILTIN;

const PLAYTEST_CONTRACT = [
  'PLAYTEST CONTRACT - exactly what LunaCore sends and parses (helpers/playtest-bridge/unity.js). Do not rename anything.',
  '',
  'Editor code (Assets/LunaPlaytest/Editor/PlaytestCommands.cs, editor-only; attribute namespace and assembly exactly as com.unity.pipeline Documentation~/creating-commands.md shows):',
  '    static class PlaytestCommands',
  '    {',
  `        const string Group = "${DRIVER_GROUP}";`,
  '        [CliGroupCommand(Group, "Game state snapshot", Effect = CommandEffect.ReadOnly)]',
  '        internal static ExitCode State(CommandContext cmd)',
  '        [CliGroupCommand(Group, "Run scripted input steps")]',
  '        internal static async Task<ExitCode> Input(CommandContext cmd, [CliArg("steps", "JSON array of steps", Required = true)] string steps)',
  '        [CliGroupCommand(Group, "Game view screenshot")]',
  '        internal static async Task<ExitCode> Screenshot(CommandContext cmd)',
  '    }',
  `The command names come from the method names: \`${listCommand} --group ${listParams.group}\` must list exactly ${DRIVER_ACTIONS.map((a) => `\`${command(a)}\``).join(', ')}.`,
  '',
  'Requests (Unity Pipeline POST /api/exec {command, parameters}):',
  `- \`${command('state')}\`        parameters {}`,
  `- \`${command('input')}\`        parameters {"steps": "<JSON array text>"} - ONE string parameter named steps; parse it as JSON.`,
  `  Steps run in order; LunaCore checks them before sending (1 to ${MAX_INPUT_STEPS} steps, only these types):`,
  ...INPUT_TYPES.map((type) => `    ${STEP_SHAPES[type]}`),
  '  A step of another type or with a bad field fails the whole command, never guessed.',
  `- \`${command('screenshot')}\`   parameters {}`,
  '',
  'Answers: ONE cmd.Result.Write(<object>), then ExitCode.Success. LunaCore reads the reply\'s `result`: a plain object (JSON text that parses to an object is accepted too).',
  `- state       {"scene": <active scene name>, ...the game's own keys, "combatFeelLog"?: [entry, ...]}`,
  `              The Playtester sees it as JSON (cut at ${SHOWN_RESULT_CHARS} characters); it is saved as unity-state.json.`,
  `              combatFeelLog entry, every field optional (an entry with a bad field is dropped whole, unknown keys are dropped, the newest ${MAX_COMBAT_FEEL_ENTRIES} are kept):`,
  `                hitStopFrames int 0..${F.maxFrames}, hitStopMs 0..${F.maxDurationMs}, hitStopIntendedFrames int 0..${F.maxFrames},`,
  `                inputLatencyMs 0..${F.maxLatencyMs}, hitboxToVfxFrames int -${F.maxFrames}..${F.maxFrames},`,
  `                timeScale {"from": 0..${F.maxTimeScale}, "to": 0..${F.maxTimeScale}, "atMs": 0..${F.maxAtMs}, "reason"?: /${F.reasonPattern}/}`,
  '- input       {"done": <number of steps run>}, written after the last step finished.',
  '- screenshot  {"png": <base64 of the PNG file bytes, no data: prefix>, "width": <px>, "height": <px>}',
  '              png must decode to a PNG (it starts with the PNG signature) or the screenshot is rejected.',
  `Failure: cmd.Log.Error("<why>") and return ExitCode.Failed. LunaCore reports "Unity command '${command('state')}' failed: <error> - <details>". Outside play mode every command fails this way.`,
  '',
  `Discovery: once play mode runs, LunaCore reads \`${listCommand} --group ${listParams.group} --detail ${listParams.detail}\` ONCE and calls only listed commands (calling a missing one logs a console error, so it never tries). Each missing command falls back to the editor's built-in equivalent:`,
  `  ${command('state')}       -> ${builtin(B.runtimeStatus())}, ${builtin(B.openScenes())}, the Player object's Transform (no game keys, no combatFeelLog)`,
  `  ${command('input')}       -> ${builtin(B.key('Space', 'press'))}: key and wait steps only`,
  `  ${command('screenshot')}  -> ${builtin(B.screenshot())}`,
].join('\n');

module.exports = {
  PLAYTEST_CONTRACT,
  PIPELINE_ATTRIBUTES_GUIDANCE,
};
