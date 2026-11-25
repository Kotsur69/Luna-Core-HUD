// ============================================================================
// LunaCore - Unity playtests without a PlaytestDriver: the editor's built-in
// Pipeline commands (com.unity.pipeline 1.0.0)
// ----------------------------------------------------------------------------
// The PlaytestDriver's `playtest state|input|screenshot` commands exist only
// when the game carries Assets/LunaPlaytest. Calling one that is missing fails
// with Command Not Found AND logs a console error the Playtester then reports,
// so whether the group exists is read ONCE per session from the command
// catalog (`pipeline list_commands --group playtest`, which answers an empty
// list for a missing group), never by trying a playtest command.
//
// Without the driver the same three actions run on built-in commands. Checked
// live 2026-11-25 (Blade & Bullet, Unity 6000.6.4f1, com.unity.pipeline 1.0.0):
//   screenshot  `capture game_view` with no output-path: the PNG comes back
//               inline as base64 (~30 ms), so no file is written into the
//               project at all (a path under Assets/ would also get a .meta).
//   input       `runtime simulate_key --key <Key> --action down|up|press`
//               (Input System): holding D for 1 s moved /Player from
//               x=-0.27 to x=9.88. Only key and wait steps have a built-in
//               equivalent; the rest need the driver and are refused up front.
//   state       `runtime status` (scene, frame, time scale, playing),
//               `scene list_open` (dirty state), `gameobject find` for the
//               object tagged Player (else named Player) and
//               `component get_properties --type Transform` (m_LocalPosition).
//
// Every command name and parameter key is fixed here; values come from the
// validated Playtester step (tools.js) or from the editor's own answers.
// ============================================================================

'use strict';

// The Playtester's own limits (tools.js checks them first; re-checked here for direct callers).
const { MAX_WAIT_MS, MAX_HOLD_MS } = require('./tools');

const DRIVER_GROUP = 'playtest';
const DRIVER_ACTIONS = Object.freeze(['state', 'input', 'screenshot']);
const DRIVER_COMMANDS = Object.freeze(DRIVER_ACTIONS.map((action) => `${DRIVER_GROUP} ${action}`));

/** Which commands a Unity playtest session uses: the game's PlaytestDriver or the editor's built-ins. */
const PLAYTEST_MODE = Object.freeze({ driver: 'driver', builtin: 'builtin' });

const PLAYER_TAG = 'Player';
const PLAYER_NAME = 'Player';
const MAX_PLAYER_OBJECTS = 3;
const MAX_HIERARCHY_PATH_CHARS = 300;
const MAX_TEXT_CHARS = 200;
const MAX_OPEN_SCENES = 16;
const MAX_VECTOR_LENGTH = 4;
const KEY_ACTIONS = Object.freeze(['down', 'up', 'press']);
// An Input System Key enum name: Space, D, Digit1, LeftArrow, F5, NumpadEnter...
const INPUT_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
// Names a Playtester may write for a key, mapped to the Input System Key name.
const KEY_ALIASES = Object.freeze({
  Up: 'UpArrow', Down: 'DownArrow', Left: 'LeftArrow', Right: 'RightArrow', Esc: 'Escape', Return: 'Enter',
});
const BUILTIN_STEP_TYPES = Object.freeze(['key', 'wait']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** The Input System Key name for a step key; throws for anything else. */
function inputKey(raw) {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (/^[A-Za-z]$/.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const named = Object.hasOwn(KEY_ALIASES, key) ? KEY_ALIASES[key] : key;
  if (!INPUT_KEY_RE.test(named)) throw new Error(`'${String(raw).slice(0, 40)}' is not an Input System key name (e.g. Space, D, LeftArrow, Digit1)`);
  return named;
}

/** A hierarchy path the editor reported, checked before it goes back as a target. */
function hierarchyPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > MAX_HIERARCHY_PATH_CHARS || CONTROL_CHARS.test(value)) {
    throw new Error('the editor reported an object without a usable hierarchy path');
  }
  return value;
}

/** Unity Pipeline built-in commands: call name -> [command, parameters]. */
const UNITY_PIPELINE_BUILTIN = Object.freeze({
  // Read-only and immediate; a missing group answers {commands: []}, no console error.
  listDriverCommands: () => ['pipeline list_commands', { group: DRIVER_GROUP, detail: 'compact' }],
  screenshot: () => ['capture game_view', {}],
  runtimeStatus: () => ['runtime status', {}],
  openScenes: () => ['scene list_open', {}],
  findTagged: () => ['gameobject find', { tag: PLAYER_TAG, 'include-inactive': false }],
  findNamed: () => ['gameobject find', { name: PLAYER_NAME, 'include-inactive': false }],
  transform: (path) => ['component get_properties', { target: hierarchyPath(path), type: 'Transform' }],
  key: (key, action) => {
    if (!KEY_ACTIONS.includes(action)) throw new Error(`unknown key action '${String(action)}'`);
    return ['runtime simulate_key', { key: inputKey(key), action }];
  },
});

/**
 * The mode a `pipeline list_commands --group playtest` answer calls for:
 * driver only when all three driver commands are listed.
 * @returns {{mode:string, missing:string[]}}
 */
function playtestModeOf(listing) {
  if (!isObj(listing) || !Array.isArray(listing.commands)) {
    throw new Error("Unity answered 'pipeline list_commands' without a commands list");
  }
  const listed = new Set(listing.commands.filter(isObj).map((c) => c.command));
  const missing = DRIVER_COMMANDS.filter((command) => !listed.has(command));
  return { mode: missing.length ? PLAYTEST_MODE.builtin : PLAYTEST_MODE.driver, missing };
}

/** A finite-number vector of the editor's answer, else null. */
function vector(value) {
  const ok = Array.isArray(value) && value.length <= MAX_VECTOR_LENGTH && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  return ok ? [...value] : null;
}

const text = (value) => (typeof value === 'string' ? value.slice(0, MAX_TEXT_CHARS) : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** `capture game_view` -> the driver's {png, width, height}. */
function screenshotOf(result) {
  if (!isObj(result) || typeof result.base64 !== 'string' || !result.base64) {
    throw new Error("Unity 'capture game_view' returned no inline image");
  }
  return { png: result.base64, width: finite(result.width), height: finite(result.height) };
}

/** The Player objects: tagged Player, else named Player (find never fails on an undefined tag). */
async function findPlayers(call) {
  const tagged = await call(UNITY_PIPELINE_BUILTIN.findTagged());
  const found = Array.isArray(tagged) && tagged.length ? tagged : await call(UNITY_PIPELINE_BUILTIN.findNamed());
  return (Array.isArray(found) ? found : []).filter(isObj).slice(0, MAX_PLAYER_OBJECTS);
}

/**
 * One Player object's Transform. An unusable path or a failed read is
 * reported in its place, so the rest of the state still comes back.
 */
async function playerTransform(call, found) {
  const path = text(found.hierarchyPath);
  try {
    const answer = await call(UNITY_PIPELINE_BUILTIN.transform(found.hierarchyPath));
    const props = isObj(answer) && isObj(answer.properties) ? answer.properties : {};
    return { path, localPosition: vector(props.m_LocalPosition), localScale: vector(props.m_LocalScale) };
  } catch (err) {
    return { path, error: errText(err).slice(0, MAX_TEXT_CHARS) };
  }
}

/** The built-in stand-in for `playtest state`: what the editor itself can tell. */
async function builtinState(call) {
  const status = await call(UNITY_PIPELINE_BUILTIN.runtimeStatus());
  const scenes = await call(UNITY_PIPELINE_BUILTIN.openScenes());
  const players = [];
  for (const found of await findPlayers(call)) players.push(await playerTransform(call, found));
  const s = isObj(status) ? status : {};
  return {
    source: 'unity-builtin',
    note: `No PlaytestDriver in this game: editor data only (scene, the ${PLAYER_TAG} Transform). Game-specific state needs the PlaytestDriver.`,
    scene: text(s.LoadedLevelName),
    playing: typeof s.IsPlaying === 'boolean' ? s.IsPlaying : null,
    frame: finite(s.FrameCount),
    time: finite(s.RealTimeSinceStartup),
    timeScale: finite(s.TimeScale),
    openScenes: (Array.isArray(scenes) ? scenes : []).filter(isObj).slice(0, MAX_OPEN_SCENES).map((sc) => ({
      name: text(sc.name), path: text(sc.path), isActive: sc.isActive === true, isDirty: sc.isDirty === true,
    })),
    players,
  };
}

/** One step as a runner; every step is checked before the first one runs. */
function builtinStep(step, index) {
  const type = isObj(step) ? step.type : undefined;
  if (!BUILTIN_STEP_TYPES.includes(type)) {
    throw new Error(`step ${index + 1}: '${String(type)}' steps need the game's PlaytestDriver; without it only ${BUILTIN_STEP_TYPES.join(' and ')} steps run`);
  }
  if (type === 'wait') {
    const ms = wholeMs(step.ms, `step ${index + 1} ms`, MAX_WAIT_MS);
    return (call, sleep) => sleep(ms);
  }
  const key = inputKey(step.key);
  const hold = step.holdMs === undefined ? 0 : wholeMs(step.holdMs, `step ${index + 1} holdMs`, MAX_HOLD_MS);
  if (!hold) return (call) => call(UNITY_PIPELINE_BUILTIN.key(key, 'press'));
  return (call, sleep) => holdKey(call, sleep, key, hold);
}

/** A whole number of ms from 0 to `max`; throws otherwise. */
function wholeMs(value, field, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${field} must be a whole number from 0 to ${max}`);
  return value;
}

/**
 * Key down, hold, key up. The up is sent even when the down's answer was
 * lost (it may have run) or the hold failed, so the game never keeps acting
 * on a stuck key; the first failure is the one reported.
 */
async function holdKey(call, sleep, key, hold) {
  let failure = null;
  try {
    await call(UNITY_PIPELINE_BUILTIN.key(key, 'down'));
    await sleep(hold);
  } catch (err) {
    failure = err;
  }
  try {
    await call(UNITY_PIPELINE_BUILTIN.key(key, 'up'));
  } catch (err) {
    if (!failure) throw err;
    throw new Error(`${errText(failure)} (releasing ${key} failed too: ${errText(err)})`, { cause: failure });
  }
  if (failure) throw failure;
}

/** The built-in stand-in for `playtest input`: key presses / holds and waits, in order. */
async function builtinInput(call, steps, sleep) {
  if (!Array.isArray(steps)) throw new Error('playtest input needs a steps array');
  const runners = steps.map(builtinStep);
  for (const run of runners) await run(call, sleep);
  return { done: runners.length };
}

/**
 * The three playtest actions on built-in commands, through one session.
 * @param {(call:[string, object])=>Promise<unknown>} call
 * @param {(ms:number)=>Promise<unknown>} sleep
 */
function builtinActions(call, sleep) {
  return {
    state: () => builtinState(call),
    input: (steps) => builtinInput(call, steps, sleep),
    screenshot: async () => screenshotOf(await call(UNITY_PIPELINE_BUILTIN.screenshot())),
  };
}

module.exports = {
  DRIVER_GROUP,
  DRIVER_COMMANDS,
  PLAYTEST_MODE,
  UNITY_PIPELINE_BUILTIN,
  playtestModeOf,
  builtinActions,
  inputKey,
};
