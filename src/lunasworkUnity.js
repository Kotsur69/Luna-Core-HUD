// ============================================================================
// LunaCore - Luna's Work `unity` tester adapter + PlaytestDriver card (LW 3.36b)
// ----------------------------------------------------------------------------
// Same interface as the web adapter (src/lunasworkAdapters.js), through the
// Unity editor's MCP server (helpers/playtest-bridge/unity.js holds every
// call it makes):
//
//   start(profile) -> {handle}   one Unity MCP session: open the profile's
//                                scene (optional), enter play mode, wait until
//                                the editor reports it, check the game's
//                                PlaytestDriver answers - then the session is
//                                closed again (one editor = one connection)
//   tools()        -> the bridge with the Unity tool set: screenshot, game
//                     state, scripted input, console, wait. All through the
//                     PlaytestDriver / read_console - no file or code access.
//   stop()         -> evidence (console dump, final state, final screenshot)
//                     into the iteration's evidence dir, then play mode off
//                     (idempotent)
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
const { UNITY_MCP, DRIVER_TOOL, unityCall, isPlaying } = require('../helpers/playtest-bridge/unity');

const PLAY_POLL_MS = 500;
const CONSOLE_FILE = 'unity-console.json';
const STATE_FILE = 'unity-state.json';
const FINAL_SHOT = 'final.png';
const MAX_EVIDENCE_CHARS = 512 * 1024;

const errText = (err) => (err instanceof Error ? err.message : String(err));

// ---- PlaytestDriver card ---------------------------------------------------------------

const PLAYTEST_DRIVER_GUARD = '#if UNITY_EDITOR || DEVELOPMENT_BUILD';
const PLAYTEST_DRIVER_FILES = Object.freeze([
  'Assets/LunaPlaytest/PlaytestDriver.cs',
  'Assets/LunaPlaytest/PlaytestInput.cs',
  'Assets/LunaPlaytest/Editor/PlaytestDriverTool.cs',
  'Assets/LunaPlaytest/Tests/PlayMode/PlaytestDriverTests.cs',
  'Assets/LunaPlaytest/Tests/PlayMode/LunaPlaytest.PlayModeTests.asmdef',
]);

/** The God Mode card that builds the game's PlaytestDriver (fields as todorows.normalizeTodo keeps them). */
const PLAYTEST_DRIVER_CARD = Object.freeze({
  text: 'PlaytestDriver: dev-only scripted input and JSON game state for the Playtester',
  details: [
    `Build a dev-only PlaytestDriver so Luna's Work can playtest the game through Unity MCP. Every runtime file starts with \`${PLAYTEST_DRIVER_GUARD}\` and ends with \`#endif\`: a release build must contain none of it.`,
    '',
    '- Assets/LunaPlaytest/PlaytestDriver.cs: a MonoBehaviour singleton (namespace LunaPlaytest), created by [RuntimeInitializeOnLoadMethod], DontDestroyOnLoad.',
    '  - RunSteps(steps): a coroutine running scripted inputs in order: key {key, holdMs}, button {name, holdMs}, axis {name, value -1..1, holdMs}, click {x, y} (0..1 of the screen), ui {name} (click the active UI Button with that GameObject name), wait {ms}. Unknown step types are rejected, never guessed.',
    '  - Snapshot(): a JSON object - active scene, time, frame, the visible UI Button names, plus whatever the game registers with PlaytestDriver.RegisterState(key, Func<object>) (player position, health, score, open menu...).',
    '  - Screenshot(): ScreenCapture.CaptureScreenshotAsTexture() at end of frame, EncodeToPNG, base64.',
    '- Assets/LunaPlaytest/PlaytestInput.cs: the input overlay the steps drive. With the Input System, queue device state (InputSystem.QueueStateEvent); otherwise game code reads PlaytestInput.GetButton / GetAxis / GetKey, which fall through to UnityEngine.Input when no step is active.',
    `- Assets/LunaPlaytest/Editor/PlaytestDriverTool.cs (editor only): the MCP for Unity custom tool \`${DRIVER_TOOL}\` with parameter action: "state" -> Snapshot(), "input" {steps} -> runs them, answers {done: n}, "screenshot" -> {png, width, height}. Answers {success, message, data}; outside play mode it fails with a clear message.`,
    '- No file access, no reflection calls by name: the driver only does what a step type says.',
    '- Unity Test Framework PlayMode tests (Assets/LunaPlaytest/Tests/PlayMode): steps parse and run (a ui step clicks a test Button, a button step is visible through PlaytestInput, unknown types fail), Snapshot() is valid JSON with the scene name and registered keys, Screenshot() returns a PNG.',
  ].join('\n'),
  acceptance: [
    `PlaytestDriver.cs and PlaytestInput.cs are wrapped in ${PLAYTEST_DRIVER_GUARD} ... #endif; a release build compiles without them`,
    `In play mode, ${DRIVER_TOOL} {action: "state"} returns JSON with the active scene name`,
    `${DRIVER_TOOL} {action: "input", steps: [{type: "ui", name: "<a Button>"}]} clicks that button`,
    `${DRIVER_TOOL} {action: "screenshot"} returns a base64 PNG of the Game view`,
    'The Unity Test Framework PlayMode tests for input steps, state snapshot and screenshot pass',
  ],
  files: PLAYTEST_DRIVER_FILES,
  verify: 'Unity -batchmode -nographics -projectPath . -runTests -testPlatform PlayMode -testResults playtest-results.xml',
  size: 'L',
  model: 'opus',
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

// ---- adapter --------------------------------------------------------------------------

function writeEvidence(dir, file, value) {
  const text = JSON.stringify(value === undefined ? null : value, null, 2);
  fs.writeFileSync(path.join(dir, file), text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}\n(truncated)` : text);
}

/**
 * @param {{evidenceDir:string, now:()=>number, sleep:Function, nodeBinary:string,
 *   connectUnity:(url:string)=>{callTool:Function, close:Function}, log?:(line:string)=>void}} ctx
 */
function createUnityAdapter(ctx) {
  const log = ctx.log || (() => {});
  let profile = null;
  let playing = false; // play mode was entered by start()
  let started = false; // ... and the driver answered
  let stopping = null;

  /** One short Unity MCP session around `fn`. */
  async function session(fn) {
    const client = ctx.connectUnity(profile.unityMcpUrl);
    try {
      return await fn((call) => unityCall(client, call));
    } finally {
      await client.close();
    }
  }

  async function enterPlayMode(call) {
    if (profile.scene) await call(UNITY_MCP.openScene(profile.scene));
    await call(UNITY_MCP.play());
    playing = true;
    const deadline = ctx.now() + profile.readyTimeoutSec * 1000;
    for (;;) {
      if (isPlaying(await call(UNITY_MCP.state()))) return;
      if (ctx.now() >= deadline) throw new Error(`Unity did not enter play mode within ${profile.readyTimeoutSec}s`);
      await ctx.sleep(PLAY_POLL_MS);
    }
  }

  async function start(raw) {
    if (profile) throw new Error('unity adapter is already started');
    const { profile: valid, reason } = validateUnityProfile(raw);
    if (!valid) throw new Error(`invalid project profile: ${reason}`);
    profile = valid;
    try {
      await session(async (call) => {
        await enterPlayMode(call);
        try {
          await call(UNITY_MCP.driver('state'));
        } catch (err) {
          throw new Error(`the game has no working PlaytestDriver (${errText(err)}) - build the "${PLAYTEST_DRIVER_CARD.text}" card first`);
        }
      });
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
    const steps = [
      [CONSOLE_FILE, async () => writeEvidence(ctx.evidenceDir, CONSOLE_FILE, await call(UNITY_MCP.console()))],
      [STATE_FILE, async () => writeEvidence(ctx.evidenceDir, STATE_FILE, await call(UNITY_MCP.driver('state')))],
      [FINAL_SHOT, async () => {
        const shot = await call(UNITY_MCP.driver('screenshot'));
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
        await call(UNITY_MCP.stop());
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
    return bridgeTools('unity', { evidenceDir: ctx.evidenceDir, nodeBinary: ctx.nodeBinary, args: ['--unity-url', profile.unityMcpUrl] });
  }

  return { name: 'unity', evidenceDir: ctx.evidenceDir, start, stop, tools };
}

module.exports = {
  CONSOLE_FILE,
  STATE_FILE,
  FINAL_SHOT,
  PLAYTEST_DRIVER_GUARD,
  PLAYTEST_DRIVER_CARD,
  playtestDriverCard,
  createUnityAdapter,
};
