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
//   start(profile) -> {handle}   open the profile's scene (optional), enter
//                                play mode, wait until the editor reports it,
//                                check the game's PlaytestDriver answers - one
//                                short connection, closed again (one editor =
//                                one connection)
//   tools()        -> the bridge with the Unity tool set: screenshot, game
//                     state, scripted input, console, wait. All through the
//                     PlaytestDriver / the console - no file or code access.
//   stop()         -> evidence (console dump, final state, final screenshot)
//                     into the iteration's evidence dir, then play mode off
//                     (idempotent)
//
// Entering play mode reloads the editor's domain: the Pipeline port file
// disappears, the port refuses, the editor answers busy. The wait for play
// mode and for the driver retries those until readyTimeoutSec.
//
// The game needs the PlaytestDriver: PLAYTEST_DRIVER_CARD is the God Mode
// card that builds it. Without it start() fails and names the card.
//
// No editor launch: the Unity MCP server lives inside the open editor (on
// Mati's Unity PC it is already connected), so start() needs it running.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { validateUnityProfile } = require('./lunasworkAdapterProfiles');
const { bridgeTools, noTools } = require('./lunasworkBridge');
const { runTag } = require('./todorows');
const { saveScreenshot } = require('../helpers/playtest-bridge/bridge');
const { UNITY_TRANSPORTS, DRIVER_GROUP, isPlaying } = require('../helpers/playtest-bridge/unity');
const { PIPELINE_ERROR, isTransientPipelineError, pipelineCommandDidNotRun } = require('../helpers/playtest-bridge/pipeline-http');

const PLAY_POLL_MS = 500;
const MAX_SUBDIR_CHARS = 260;
// err.code of a wait that ran out of readyTimeoutSec.
const WAIT_TIMEOUT = 'LUNA_UNITY_WAIT_TIMEOUT';
// HTTP statuses that mean the editor did not let LunaCore in: not the driver's fault.
const AUTH_STATUSES = new Set([401, 403]);
const CONSOLE_FILE = 'unity-console.json';
const STATE_FILE = 'unity-state.json';
const FINAL_SHOT = 'final.png';
const MAX_EVIDENCE_CHARS = 512 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

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
    `LunaCore calls exactly \`${DRIVER_GROUP} state\`, \`${DRIVER_GROUP} input\` {steps: "<JSON array>"} and \`${DRIVER_GROUP} screenshot\` (helpers/playtest-bridge/unity.js). Until they exist, Luna's Work start() fails with: ${NO_DRIVER_ERROR} (Unity command '${DRIVER_GROUP} state' failed: Command Not Found ...) - build the "${PLAYTEST_DRIVER_TEXT}" card first.`,
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
 * 'pipeline' unless the profile names a legacy MCP for Unity server. Read from
 * the profile as given: validation fills in a default unityMcpUrl.
 * @param {unknown} raw
 * @returns {'pipeline'|'mcp'}
 */
function unityTransport(raw) {
  return isObj(raw) && raw.unityMcpUrl !== undefined ? 'mcp' : 'pipeline';
}

/**
 * The Unity project the editor has open: the repo dir, or the profile's
 * optional unityProjectSubdir inside it (a later profile field, so it is read
 * defensively here).
 * @param {string} repoDir absolute
 * @param {unknown} raw the profile
 * @returns {{dir:string|null, reason:string|null}}
 */
function unityProjectDir(repoDir, raw) {
  const root = path.resolve(repoDir);
  const sub = isObj(raw) ? raw.unityProjectSubdir : undefined;
  if (sub === undefined || sub === null || (typeof sub === 'string' && !sub.trim())) return { dir: root, reason: null };
  const bad = { dir: null, reason: 'unityProjectSubdir must be a relative folder inside the project' };
  if (typeof sub !== 'string' || sub.length > MAX_SUBDIR_CHARS || CONTROL_CHARS.test(sub)) return bad;
  const rel = sub.trim().replace(/\\/g, '/');
  if (rel.includes(':') || rel.startsWith('/') || rel.split('/').includes('..')) return bad;
  const dir = path.resolve(root, rel);
  const back = path.relative(root, dir);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) return bad;
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
  let profile = null;
  let target = null; // {calls, invoke, connect, bridgeArgs} of the profile's transport
  let playing = false; // play mode was entered by start()
  let started = false; // ... and the driver answered
  let stopping = null;

  /** The profile's transport, or a thrown "invalid project profile". */
  function targetFor(raw, valid) {
    const transport = unityTransport(raw);
    const { calls, invoke } = UNITY_TRANSPORTS[transport];
    if (transport === 'mcp') {
      return { calls, invoke, connect: () => ctx.connectUnity(valid.unityMcpUrl), bridgeArgs: ['--unity-url', valid.unityMcpUrl] };
    }
    const { dir, reason } = unityProjectDir(ctx.projectDir, raw);
    if (!dir) throw new Error(`invalid project profile: ${reason}`);
    return { calls, invoke, connect: () => ctx.connectPipeline(dir), bridgeArgs: ['--unity-project', dir] };
  }

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
   * Polls `probe` until it returns true. A failure `retryable` accepts (by
   * default a transient Unity Pipeline failure: the domain reload of entering
   * play mode) is retried until `deadline`; any other ends the wait at once.
   */
  async function pollUntil(deadline, probe, timeoutMessage, retryable = isTransientPipelineError) {
    let last = null;
    for (;;) {
      try {
        if (await probe()) return;
        last = null;
      } catch (err) {
        if (!retryable(err)) throw err;
        last = err;
      }
      if (ctx.now() >= deadline) {
        throw Object.assign(new Error(last ? `${timeoutMessage} (last error: ${errText(last)})` : timeoutMessage), { code: WAIT_TIMEOUT });
      }
      await ctx.sleep(PLAY_POLL_MS);
    }
  }

  /** One editor action, sent again until `deadline` only while the editor certainly did not run it. */
  function act(deadline, send, timeoutMessage) {
    const once = async () => {
      await send();
      return true;
    };
    return pollUntil(deadline, once, timeoutMessage, pipelineCommandDidNotRun);
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

  async function checkDriver(call, deadline) {
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
    target = targetFor(raw, valid);
    profile = valid;
    try {
      await session(async (call) => checkDriver(call, await enterPlayMode(call)));
    } catch (err) {
      await stop();
      throw err;
    }
    started = true;
    fs.mkdirSync(ctx.evidenceDir, { recursive: true });
    return { handle: { kind: 'unity', scene: profile.scene || null } };
  }

  /** Console, final state and final screenshot; each one on its own, best effort. */
  async function saveEvidence(call) {
    const { calls } = target;
    const steps = [
      [CONSOLE_FILE, async () => writeEvidence(ctx.evidenceDir, CONSOLE_FILE, await call(calls.console()))],
      [STATE_FILE, async () => writeEvidence(ctx.evidenceDir, STATE_FILE, await call(calls.driver('state')))],
      [FINAL_SHOT, async () => {
        const shot = await call(calls.driver('screenshot'));
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

  async function shutdown() {
    if (!profile || !playing) return true;
    try {
      await session(async (call) => {
        if (started) await saveEvidence(call);
        await call(target.calls.stop());
      });
      return true;
    } catch (err) {
      log(`[lunaswork] could not leave Unity play mode: ${errText(err)}`);
      return false;
    } finally {
      started = false;
    }
  }

  function stop() {
    if (!stopping) stopping = shutdown();
    return stopping;
  }

  /** Fresh objects every call; nothing until play mode runs with the driver. */
  function tools() {
    if (!started) return noTools();
    return bridgeTools('unity', { evidenceDir: ctx.evidenceDir, nodeBinary: ctx.nodeBinary, args: [...target.bridgeArgs] });
  }

  return { name: 'unity', evidenceDir: ctx.evidenceDir, start, stop, tools };
}

module.exports = {
  CONSOLE_FILE,
  STATE_FILE,
  FINAL_SHOT,
  PLAYTEST_DRIVER_GUARD,
  NO_DRIVER_ERROR,
  PLAYTEST_DRIVER_CARD,
  playtestDriverCard,
  unityTransport,
  unityProjectDir,
  createUnityAdapter,
};
