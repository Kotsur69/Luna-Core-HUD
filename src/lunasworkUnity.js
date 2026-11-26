// ============================================================================
// LunaCore - Luna's Work `unity` tester adapter + PlaytestDriver card (LW 3.36b)
// ----------------------------------------------------------------------------
// Same interface as the web adapter (src/lunasworkAdapters.js), through the
// open Unity editor (helpers/playtest-bridge/unity.js holds every call it
// makes). Two transports, picked by the profile:
//
//   pipeline  no unityMcpUrl in the profile: the official Unity MCP
//             (com.unity.pipeline) of the editor that has the project open -
//             the repo dir, or its optional unityProjectSubdir
//   mcp       legacy: unityMcpUrl names an MCP for Unity server
//
//   start(profile) -> {handle}   Pipeline: auto tick on, asset refresh, script
//                                recompile, wait for it, compile check and the
//                                console cursor (src/lunasworkUnityEditor.js);
//                                then open the profile's scene (optional), enter
//                                play mode, wait until the editor reports it,
//                                check the game's PlaytestDriver answers - one
//                                short connection, closed again (one editor =
//                                one connection). A compile failure or an
//                                editor that never settles throws an
//                                ENVIRONMENT failure (isEnvironmentFailure,
//                                environmentFailure()): not a game result.
//   tools()        -> the bridge with the Unity tool set: screenshot, game
//                     state, scripted input, console, wait. All through the
//                     PlaytestDriver / the console - no file or code access.
//   stop()         -> evidence (console of the playtest window, final state,
//                     final screenshot) into the iteration's evidence dir,
//                     then play mode off and the auto tick setting back
//                     (idempotent)
//
// Entering play mode reloads the editor's domain: the Pipeline port file
// disappears, the port refuses, the editor answers busy. The wait for play
// mode and for the driver retries those until readyTimeoutSec.
//
// Console window (helpers/playtest-bridge/unityConsole.js): the console
// cursor is taken before play mode; unity-console.json and the Playtester's
// console_errors hold only what was logged after it, and say which window.
//
// The PlaytestDriver: PLAYTEST_DRIVER_CARD is the God Mode card that builds
// it; it quotes PLAYTEST_CONTRACT (helpers/playtest-bridge/unityContract.js)
// verbatim. Pipeline: right after play mode starts, start() reads ONCE from
// the command catalog which `playtest` commands the game has (never a trial
// call of a missing one: that logs a console error). Each missing one runs on
// the editor's built-in equivalent (helpers/playtest-bridge/unityBuiltin.js:
// Game view capture, key input, the Player's Transform): all three without a
// driver (--unity-driver builtin), only the missing ones with a partial driver
// (--unity-fallback). Legacy MCP for Unity: without the driver start() fails
// and names the card.
//
// No editor launch: the Unity MCP server lives inside the open editor (on
// Mati's Unity PC it is already connected), so start() needs it running.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { validateUnityProfile, unitySubdirField } = require('./lunasworkAdapterProfiles');
const { bridgeTools, noTools } = require('./lunasworkBridge');
const { runTag } = require('./todorows');
const { saveScreenshot } = require('../helpers/playtest-bridge/bridge');
const {
  UNITY_TRANSPORTS, DRIVER_GROUP, PLAYTEST_MODE, UNITY_PIPELINE_BUILTIN, playtestModeOf, playtestActions,
  isPlaying, parseCombatFeelLog, withCombatFeelLog,
} = require('../helpers/playtest-bridge/unity');
const { windowedConsole } = require('../helpers/playtest-bridge/unityConsole');
const { PLAYTEST_CONTRACT } = require('../helpers/playtest-bridge/unityContract');
const { PIPELINE_ERROR, isTransientPipelineError } = require('../helpers/playtest-bridge/pipeline-http');
const {
  WAIT_TIMEOUT, UNITY_ENVIRONMENT_FAILURE, ENVIRONMENT_REASON, createWaits, previousAutoTick, restoreAutoTick, prepareEditor,
  isEnvironmentFailure, environmentFailureOf,
} = require('./lunasworkUnityEditor');

// HTTP statuses that mean the editor did not let LunaCore in: not the driver's fault.
const AUTH_STATUSES = new Set([401, 403]);
const CONSOLE_FILE = 'unity-console.json';
const STATE_FILE = 'unity-state.json';
const FINAL_SHOT = 'final.png';
const MAX_EVIDENCE_CHARS = 512 * 1024;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- PlaytestDriver card ---------------------------------------------------------------

const PLAYTEST_DRIVER_GUARD = '#if UNITY_EDITOR || DEVELOPMENT_BUILD';
// How start() reports a game without the driver (the card quotes it).
const NO_DRIVER_ERROR = 'the game has no working PlaytestDriver';
const PLAYTEST_DRIVER_TEXT = 'PlaytestDriver as Unity Pipeline commands (dev-only scripted input, JSON state, screenshot)';
const PLAYTEST_DRIVER_FILES = Object.freeze([
  'Assets/LunaPlaytest/LunaPlaytest.asmdef',
  'Assets/LunaPlaytest/PlaytestDriver.cs',
  'Assets/LunaPlaytest/PlaytestInput.cs',
  'Assets/LunaPlaytest/Editor/LunaPlaytest.Editor.asmdef',
  'Assets/LunaPlaytest/Editor/PlaytestCommands.cs',
  'Assets/LunaPlaytest/Tests/PlayMode/PlaytestDriverTests.cs',
  'Assets/LunaPlaytest/Tests/PlayMode/LunaPlaytest.PlayModeTests.asmdef',
]);

/** The God Mode card that builds the game's PlaytestDriver (fields as todorows.normalizeTodo keeps them). */
const PLAYTEST_DRIVER_CARD = Object.freeze({
  text: PLAYTEST_DRIVER_TEXT,
  details: [
    "Build a dev-only PlaytestDriver so Luna's Work can playtest the game through the official Unity MCP (com.unity.pipeline, listed in Packages/manifest.json; docs: Library/PackageCache/com.unity.pipeline@*/Documentation~/creating-commands.md).",
    `Every runtime file starts with \`${PLAYTEST_DRIVER_GUARD}\` and ends with \`#endif\`: a release build must contain none of it.`,
    '',
    'Runtime (Assets/LunaPlaytest, namespace LunaPlaytest, LunaPlaytest.asmdef):',
    '- PlaytestDriver.cs: a MonoBehaviour singleton created by [RuntimeInitializeOnLoadMethod], DontDestroyOnLoad.',
    '  - RunSteps(steps): a coroutine running scripted inputs in order: key {key, holdMs}, button {name, holdMs}, axis {name, value -1..1, holdMs}, click {x, y} (0..1 of the screen), ui {name} (click the active UI Button with that GameObject name), wait {ms}. Unknown step types are rejected, never guessed.',
    '  - Snapshot(): a JSON object - active scene, time, frame, Time.timeScale, the visible UI Button names, plus whatever the game registers with PlaytestDriver.RegisterState(key, Func<object>) (player position, health, score, open menu...).',
    '  - Screenshot(): ScreenCapture.CaptureScreenshotAsTexture() at end of frame, EncodeToPNG, base64.',
    '- PlaytestInput.cs: first check how the game reads input, then drive that path. Input System: queue device state (InputSystem.QueueStateEvent) on a virtual Keyboard / Mouse / Gamepad. Legacy Input Manager: game code reads PlaytestInput.GetKey / GetButton / GetAxis, which fall through to UnityEngine.Input when no step is active. Keyboard + mouse and gamepad must both be drivable.',
    '',
    `Editor commands (Assets/LunaPlaytest/Editor/PlaytestCommands.cs, in an editor-only asmdef that references Unity.Pipeline.Attributes; runtime code never references it): const string Group = "${DRIVER_GROUP}"; one [CliGroupCommand(Group, ...)] method per command.`,
    `- \`${DRIVER_GROUP} state\` (Effect = ReadOnly): cmd.Result.Write(the Snapshot() object).`,
    `- \`${DRIVER_GROUP} input --steps <json>\`: [CliArg("steps", ..., Required = true)] string steps, a JSON array. async Task<ExitCode>: start RunSteps, wait for it (await Task.Yield() loop, honour cmd.CancellationToken), then Result.Write({done: n}).`,
    `- \`${DRIVER_GROUP} screenshot\`: async; Result.Write({png, width, height}).`,
    '- Results are plain objects (the Pipeline returns them as `result`), not JSON text.',
    '- Outside play mode every command fails with cmd.Log.Error("playtest commands need play mode") and ExitCode.Failed.',
    '- No file access, no reflection calls by name: the driver only does what a step type says.',
    '',
    PLAYTEST_CONTRACT,
    '',
    `LunaCore calls exactly \`${DRIVER_GROUP} state\`, \`${DRIVER_GROUP} input\` {steps: "<JSON array>"} and \`${DRIVER_GROUP} screenshot\` (helpers/playtest-bridge/unity.js), each one only when \`pipeline list_commands --group ${DRIVER_GROUP}\` lists it. With none listed Luna's Work playtests on the editor's built-in commands only (Game view capture, key presses, the Player's Transform: no button, axis, click or ui steps, no game state). If \`${DRIVER_GROUP} state\` is listed but fails, start() fails with: ${NO_DRIVER_ERROR} (Unity command '${DRIVER_GROUP} state' failed: ...) - build or fix the "${PLAYTEST_DRIVER_TEXT}" card first.`,
    '',
    'Unity Test Framework PlayMode tests (Assets/LunaPlaytest/Tests/PlayMode): steps parse and run (a ui step clicks a test Button, a button step is visible through PlaytestInput, unknown types fail), Snapshot() is valid JSON with the scene name and registered keys, Screenshot() returns PNG bytes.',
    '',
    'Verify against the editor that already has the project open: `unity test` in PlayMode (check `unity test --help` for the exact PlayMode flag name). Do NOT use `Unity -batchmode -projectPath .`: it cannot open a project the editor already has open. Then recompile and confirm `unity command playtest state` answers in play mode with a clean Console.',
  ].join('\n'),
  acceptance: [
    `PlaytestDriver.cs and PlaytestInput.cs are wrapped in ${PLAYTEST_DRIVER_GUARD} ... #endif; a release build compiles without them`,
    'PlaytestCommands.cs sits in an editor-only asmdef; no runtime code references Unity.Pipeline',
    `In play mode \`unity command ${DRIVER_GROUP} state\` returns JSON with the active scene name and Time.timeScale`,
    `\`unity command ${DRIVER_GROUP} input --steps '[{"type":"ui","name":"<a Button>"}]'\` clicks that button and answers {done: 1}`,
    `\`unity command ${DRIVER_GROUP} screenshot\` returns {png, width, height} with a base64 PNG of the Game view`,
    'Outside play mode the playtest commands fail with a clear message',
    'The Unity Test Framework PlayMode tests pass through `unity test` against the running editor; Console clean',
  ],
  files: PLAYTEST_DRIVER_FILES,
  verify: 'unity test --platform PlayMode against the running editor (check `unity test --help` for the exact PlayMode flag name)',
  size: 'L',
  model: 'opus',
  effort: 'high',
});

/**
 * A fresh copy of the card, filed under the run's tag when a run id is given.
 * @param {{runId?:string}} [opts]
 * @returns {object}
 */
function playtestDriverCard({ runId } = {}) {
  const tag = runId ? runTag(runId) : null;
  return {
    ...PLAYTEST_DRIVER_CARD,
    acceptance: [...PLAYTEST_DRIVER_CARD.acceptance],
    files: [...PLAYTEST_DRIVER_CARD.files],
    ...(tag ? { tags: [tag] } : {}),
  };
}

// ---- transport ------------------------------------------------------------------------

/**
 * 'pipeline' unless the profile names a legacy MCP for Unity server; a blank
 * unityMcpUrl counts as none (validation drops it).
 * @param {unknown} raw
 * @returns {'pipeline'|'mcp'}
 */
function unityTransport(raw) {
  return isObj(raw) && typeof raw.unityMcpUrl === 'string' && raw.unityMcpUrl.trim() ? 'mcp' : 'pipeline';
}

/**
 * The Unity project the editor has open: the repo dir, or the profile's
 * optional unityProjectSubdir inside it. validateUnityProfile already checked
 * the field; it is re-checked here against the resolved path.
 * @param {string} repoDir absolute
 * @param {unknown} raw the profile
 * @returns {{dir:string|null, reason:string|null}}
 */
function unityProjectDir(repoDir, raw) {
  const root = path.resolve(repoDir);
  const { subdir, reason } = unitySubdirField(isObj(raw) ? raw.unityProjectSubdir : undefined);
  if (reason) return { dir: null, reason };
  if (!subdir) return { dir: root, reason: null };
  const dir = path.resolve(root, subdir);
  const back = path.relative(root, dir);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    return { dir: null, reason: 'unityProjectSubdir must be a relative folder inside the project' };
  }
  return { dir, reason: null };
}

/**
 * True when the PlaytestDriver command itself failed (missing or broken), as
 * opposed to the connection to the editor, its auth, or a wait that ran out.
 */
function isDriverFailure(err) {
  // MCP for Unity reports a tool error as a plain Error without a code.
  if (!err || typeof err.code !== 'string') return true;
  return err.code === PIPELINE_ERROR.failed && !AUTH_STATUSES.has(err.status);
}

// ---- adapter --------------------------------------------------------------------------

function writeEvidence(dir, file, value) {
  const text = JSON.stringify(value === undefined ? null : value, null, 2);
  fs.writeFileSync(path.join(dir, file), text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}\n(truncated)` : text);
}

/**
 * @param {{projectDir:string, evidenceDir:string, now:()=>number, sleep:Function, nodeBinary:string,
 *   connectUnity:(url:string)=>{callTool:Function, close:Function},
 *   connectPipeline:(unityProjectDir:string)=>{exec:Function, close:Function},
 *   log?:(line:string)=>void}} ctx
 */
function createUnityAdapter(ctx) {
  const log = ctx.log || (() => {});
  const { pollUntil, act } = createWaits({ now: ctx.now, sleep: ctx.sleep });
  let profile = null;
  let target = null; // {transport, calls, invoke, connect, bridgeArgs, dir} of the profile's transport
  let mode = PLAYTEST_MODE.driver; // detected once by start(): the game's driver or the editor's built-ins
  let fallback = []; // driver actions the game does not list: they run on the built-ins
  let consoleWindow = null; // {session, cursor, startedAt}: the console from the playtest start on
  let envFailure = null; // the last start's environment failure, as a plain result
  const autoTick = { changed: false, previous: null }; // set by prepareEditor, put back by stop()
  let playing = false; // play mode was entered by start()
  let started = false; // ... and the driver answered
  let stopping = null;

  /** The profile's transport, or a thrown "invalid project profile". */
  function targetFor(valid) {
    const transport = unityTransport(valid);
    const { calls, invoke } = UNITY_TRANSPORTS[transport];
    if (transport === 'mcp') {
      return { transport, calls, invoke, connect: () => ctx.connectUnity(valid.unityMcpUrl), bridgeArgs: ['--unity-url', valid.unityMcpUrl], dir: null };
    }
    const { dir, reason } = unityProjectDir(ctx.projectDir, valid);
    if (!dir) throw new Error(`invalid project profile: ${reason}`);
    return { transport, calls, invoke, connect: () => ctx.connectPipeline(dir), bridgeArgs: ['--unity-project', dir], dir };
  }

  /** The session's playtest actions (state, input, screenshot) for the detected mode and fallbacks. */
  const actions = (call) => playtestActions({ mode, transport: target.transport, call, sleep: ctx.sleep, fallback });
  /** The game's own `playtest state` answers (no driver, or a driver without it: built-in editor data). */
  const hasDriverState = () => mode === PLAYTEST_MODE.driver && !fallback.includes('state');

  /** One short connection to the editor around `fn`. */
  async function session(fn) {
    const client = target.connect();
    try {
      return await fn((call) => target.invoke(client, call));
    } finally {
      await client.close();
    }
  }

  /**
   * Pipeline: brings the editor up to date (lunasworkUnityEditor.js) and
   * takes the console cursor; throws an environment failure when the code
   * does not compile or the editor never settles.
   */
  async function prepare(call) {
    if (target.transport !== 'pipeline') return;
    autoTick.previous = previousAutoTick(target.dir, log);
    const prepared = await prepareEditor({ call, now: ctx.now, waits: { pollUntil, act }, log, autoTick });
    consoleWindow = prepared.window;
    if (!consoleWindow) log(`[lunaswork] Unity console window not opened (${prepared.windowProblem}): the console evidence covers its whole buffer`);
  }

  /** @returns {Promise<number>} the start deadline, shared with the driver check */
  async function enterPlayMode(call) {
    const { calls } = target;
    const sec = profile.readyTimeoutSec;
    const deadline = ctx.now() + sec * 1000;
    if (profile.scene) await act(deadline, () => call(calls.openScene(profile.scene)), `Unity could not open ${profile.scene} within ${sec}s`);
    // From here on stop() leaves play mode, even when the answer to play is lost.
    playing = true;
    try {
      await act(deadline, () => call(calls.play()), `Unity could not start play mode within ${sec}s`);
    } catch (err) {
      if (!isTransientPipelineError(err)) throw err;
      // Sent, but the answer was lost - most likely in the domain reload that
      // play mode starts. The poll below shows whether play mode began.
      log(`[lunaswork] Unity play mode: no answer (${errText(err)}), waiting for the editor`);
    }
    await pollUntil(deadline, async () => isPlaying(await call(calls.state())), `Unity did not enter play mode within ${sec}s`);
    return deadline;
  }

  /**
   * Pipeline: which PlaytestDriver commands the game has, read from the
   * command catalog after play mode started (busy / domain reload answers
   * are retried until `deadline`). Never a trial call of a missing command.
   * Legacy MCP for Unity has no catalog: always the driver, no fallback.
   * @returns {Promise<{mode:string, fallback:string[]}>}
   */
  async function detectMode(call, deadline) {
    if (target.transport !== 'pipeline') return { mode: PLAYTEST_MODE.driver, fallback: [] };
    let found = null;
    const probe = async () => {
      found = playtestModeOf(await call(UNITY_PIPELINE_BUILTIN.listDriverCommands()));
      return true;
    };
    await pollUntil(deadline, probe, `Unity did not list its commands within ${profile.readyTimeoutSec}s`);
    if (found.mode === PLAYTEST_MODE.builtin) {
      log(`[lunaswork] Unity: no PlaytestDriver (${found.missing.join(', ')} not listed); playtesting on the editor's built-in commands`);
    } else if (found.fallback.length) {
      log(`[lunaswork] Unity: the PlaytestDriver lacks ${found.missing.join(', ')}; the editor's built-in equivalent stands in`);
    }
    return { mode: found.mode, fallback: found.mode === PLAYTEST_MODE.driver ? found.fallback : [] };
  }

  /** The driver's `playtest state` must answer; skipped when the game does not list it (nothing to probe). */
  async function checkDriver(call, deadline) {
    if (!hasDriverState()) return;
    const probe = async () => {
      await call(target.calls.driver('state'));
      return true;
    };
    try {
      await pollUntil(deadline, probe, `the PlaytestDriver did not answer within ${profile.readyTimeoutSec}s`);
    } catch (err) {
      if (!isDriverFailure(err)) throw err;
      throw new Error(`${NO_DRIVER_ERROR} (${errText(err)}) - build the "${PLAYTEST_DRIVER_CARD.text}" card first`);
    }
  }

  async function start(raw) {
    if (profile) throw new Error('unity adapter is already started');
    const { profile: valid, reason } = validateUnityProfile(raw);
    if (!valid) throw new Error(`invalid project profile: ${reason}`);
    target = targetFor(valid);
    profile = valid;
    envFailure = null;
    try {
      await session(async (call) => {
        await prepare(call);
        const deadline = await enterPlayMode(call);
        ({ mode, fallback } = await detectMode(call, deadline));
        await checkDriver(call, deadline);
      });
    } catch (err) {
      envFailure = environmentFailureOf(err);
      await stop();
      throw err;
    }
    started = true;
    fs.mkdirSync(ctx.evidenceDir, { recursive: true });
    return { handle: { kind: 'unity', scene: profile.scene || null } };
  }

  /**
   * The console as evidence. Pipeline: only the playtest window, saying which
   * window it covers (its counts are the window's, groundTruth the editor's).
   */
  async function consoleEvidence(call) {
    const answer = await call(target.calls.console(consoleWindow));
    return target.transport === 'pipeline' ? windowedConsole(answer, consoleWindow) : answer;
  }

  /** Console, final state and final screenshot; each one on its own, best effort. */
  async function saveEvidence(call) {
    const steps = [
      [CONSOLE_FILE, async () => writeEvidence(ctx.evidenceDir, CONSOLE_FILE, await consoleEvidence(call))],
      [STATE_FILE, async () => writeEvidence(ctx.evidenceDir, STATE_FILE, withCombatFeelLog(await actions(call).state()))],
      [FINAL_SHOT, async () => {
        const shot = await actions(call).screenshot();
        saveScreenshot(ctx.evidenceDir, FINAL_SHOT, shot && shot.png);
      }],
    ];
    for (const [what, step] of steps) {
      try {
        await step();
      } catch (err) {
        log(`[lunaswork] unity evidence ${what} failed: ${errText(err)}`);
      }
    }
  }

  /** Leaves play mode; sent again until the ready timeout only while the editor certainly did not run it. */
  function leavePlayMode(call) {
    const sec = profile.readyTimeoutSec;
    return act(ctx.now() + sec * 1000, () => call(target.calls.stop()), `Unity could not leave play mode within ${sec}s`);
  }

  /** Evidence and play mode off; true when play mode is off. */
  async function endPlay(call) {
    if (!playing) return true;
    try {
      if (started) await saveEvidence(call);
      await leavePlayMode(call);
      playing = false;
      return true;
    } catch (err) {
      log(`[lunaswork] could not leave Unity play mode: ${errText(err)}`);
      return false;
    } finally {
      started = false;
    }
  }

  /** The auto tick setting from before the playtest; true when it is back (or never changed). */
  async function putAutoTickBack(call) {
    try {
      await restoreAutoTick({ call, waits: { pollUntil, act }, autoTick }, ctx.now() + profile.readyTimeoutSec * 1000);
      return true;
    } catch (err) {
      log(`[lunaswork] could not restore the Unity auto tick setting: ${errText(err)}`);
      return false;
    }
  }

  /** Play mode off, then auto tick back - the second even when the first failed. */
  async function shutdown() {
    if (!profile || (!playing && !autoTick.changed)) return true;
    try {
      return await session(async (call) => {
        const left = await endPlay(call);
        const restored = await putAutoTickBack(call);
        return left && restored;
      });
    } catch (err) {
      log(`[lunaswork] could not reach the Unity editor to stop: ${errText(err)}`);
      return false;
    }
  }

  /** A successful stop is cached; a failed one is not, so a later stop() tries again. */
  function stop() {
    if (!stopping) {
      stopping = shutdown().then((ok) => {
        if (!ok) stopping = null;
        return ok;
      });
    }
    return stopping;
  }

  /** The bridge flags for the detected commands and the console window. */
  function sessionArgs() {
    const args = [];
    if (mode === PLAYTEST_MODE.builtin) args.push('--unity-driver', PLAYTEST_MODE.builtin);
    else if (fallback.length) args.push('--unity-fallback', fallback.join(','));
    if (consoleWindow) args.push('--unity-console-session', consoleWindow.session, '--unity-console-cursor', String(consoleWindow.cursor));
    return args;
  }

  /** Fresh objects every call; nothing until play mode runs with the driver. */
  function tools() {
    if (!started) return noTools();
    return bridgeTools('unity', { evidenceDir: ctx.evidenceDir, nodeBinary: ctx.nodeBinary, args: [...target.bridgeArgs, ...sessionArgs()] });
  }

  /**
   * The game's clean combatFeelLog, read once while play mode still runs (the
   * Playtester's pass is over, stop() has not run yet). Null when the game
   * keeps no log, its driver has no `playtest state` (built-in editor data)
   * or the adapter is not started; a failed read throws.
   * @returns {Promise<object[]|null>}
   */
  async function combatFeelLog() {
    if (!started || !hasDriverState()) return null;
    return session(async (call) => parseCombatFeelLog(await actions(call).state()));
  }

  /**
   * The last start's environment failure ({ok:false, environment:true, reason,
   * message, errors}: the editor, not the game, failed), else null.
   */
  const environmentFailure = () => (envFailure ? { ...envFailure, errors: [...envFailure.errors] } : null);

  return { name: 'unity', evidenceDir: ctx.evidenceDir, start, stop, tools, combatFeelLog, environmentFailure };
}

module.exports = {
  CONSOLE_FILE,
  STATE_FILE,
  FINAL_SHOT,
  PLAYTEST_DRIVER_GUARD,
  NO_DRIVER_ERROR,
  PLAYTEST_DRIVER_CARD,
  PLAYTEST_CONTRACT,
  UNITY_ENVIRONMENT_FAILURE,
  ENVIRONMENT_REASON,
  WAIT_TIMEOUT,
  playtestDriverCard,
  unityTransport,
  unityProjectDir,
  createUnityAdapter,
  isEnvironmentFailure,
  environmentFailureOf,
};
