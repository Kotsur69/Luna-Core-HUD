// ============================================================================
// Luna's Work unity adapter: a playtest start with the editor left in play
// mode (src/lunasworkUnityPlayMode.js). `scene open` refuses to run in (or
// entering) play mode; the adapter stops play mode, waits for edit mode and
// opens the scene - in the same start, never a 30-min tool-down pause.
// A fake Unity Pipeline client ({exec, close}) answers like com.unity.pipeline
// 1.0.0, its failures shaped as pipeline-http.js throws them.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../src/lunasworkAdapters.js');
const PM = require('../src/lunasworkUnityPlayMode.js');
const UN = require('../helpers/playtest-bridge/unity.js');
const { PIPELINE_ERROR } = require('../helpers/playtest-bridge/pipeline-http.js');

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image')]).toString('base64');
const CONSOLE_SESSION = '0f'.repeat(16);
const SCENE = 'Assets/Scenes/Level1.unity';
const PROFILE = { adapter: 'unity', scene: SCENE, readyTimeoutSec: 5 };
// What start() asks before the scene when there is nothing to compile (lunasworkUnityEditor.js).
const PREP_LOG = Object.freeze([
  'editor set_auto_tick',
  'editor status',
  'editor invoke_menu',
  'script recompile',
  'script recompile_status',
  'editor status',
  'console get',
]);
// What start() asks once the scene is open.
const PLAY_LOG = Object.freeze(['editor.playmode start', 'editor status', 'pipeline list_commands', 'playtest state', 'console get']);

/** The editor's refusal, word for word as the live run reported it. */
const playModeRefusal = (command) => Object.assign(
  new Error(`Unity command '${command}' failed: Command Execution Failed - '${command}' cannot run while the editor is in (or entering) play mode. Exit play mode (editor.playmode stop) and retry`),
  { code: PIPELINE_ERROR.failed, status: 400 },
);
const busy = () => Object.assign(new Error('Unity editor is busy (domain reload)'), { code: PIPELINE_ERROR.busy, retryable: true, status: 503 });

/**
 * A fake editor behind the Pipeline client. playMode: what it is in at the
 * start. exitPolls: status reads that still say 'playing' after a stop (the
 * domain reload of leaving play mode answers busy once first); null = never
 * leaves. enterBehindBack: `scene open` finds play mode being entered this
 * many times although the last status said edit mode, and refuses.
 */
function fakeEditor({ playMode = 'stopped', exitPolls = 1, enterBehindBack = 0 } = {}) {
  const ed = { log: [], playMode, exiting: null, reloadBusy: false, enterBehindBack };
  const answers = {
    'editor set_auto_tick': (p) => ({ enabled: p.enabled, intervalMs: p['interval-ms'], persisted: p.persist }),
    'editor invoke_menu': (p) => ({ path: p.path, executed: true }),
    'script recompile': () => ({ status: 'up_to_date' }),
    'script recompile_status': () => ({ status: 'up_to_date', failed: false, errors: [], compilationFailed: false }),
    'editor status': () => {
      if (ed.reloadBusy) {
        ed.reloadBusy = false;
        throw busy();
      }
      if (ed.exiting !== null) {
        if (ed.exiting === 0) {
          ed.playMode = 'stopped';
          ed.exiting = null;
        } else ed.exiting -= 1;
      }
      return { status: 'ready', compiling: false, domainReloadInProgress: false, codeLoadCount: 1, playMode: ed.playMode, playerLoopTicking: true, runInBackground: true };
    },
    'console get': () => ({
      entries: [], cursor: 0, session: CONSOLE_SESSION, returned: 0, dropped: false, reset: false,
      counts: { error: 0, warn: 0, log: 0 }, groundTruth: { compilationFailed: false, compiling: false, consoleErrors: 0, ageMs: 40 },
    }),
    'scene open': (p, command) => {
      if (ed.enterBehindBack > 0) {
        ed.enterBehindBack -= 1;
        ed.playMode = 'playing';
      }
      if (ed.playMode !== 'stopped') throw playModeRefusal(command);
      return { path: p.path };
    },
    'editor.playmode start': () => {
      ed.playMode = 'playing';
      return {};
    },
    'editor.playmode stop': () => {
      if (ed.playMode !== 'stopped' && exitPolls !== null) {
        ed.exiting = exitPolls;
        ed.reloadBusy = true;
      }
      return {};
    },
    'pipeline list_commands': () => ({ commands: UN.DRIVER_COMMANDS.map((command) => ({ command, group: 'playtest' })) }),
    'playtest state': () => ({ scene: 'Level1' }),
    'playtest screenshot': () => ({ png: PNG, width: 1920, height: 1080 }),
  };
  ed.connect = () => ({
    exec: async (command, parameters) => {
      ed.log.push(command);
      if (!answers[command]) throw Object.assign(new Error(`Unity command '${command}' failed: Command Not Found`), { code: PIPELINE_ERROR.failed, status: 400 });
      return answers[command](parameters, command);
    },
    close: async () => {},
  });
  return ed;
}

function world(editorOpts) {
  const w = { t: 0, logs: [], editor: fakeEditor(editorOpts) };
  w.opts = {
    projectDir: tmpDir('lw-pm-project-'),
    runsRoot: path.join(tmpDir('lw-pm-runs-'), 'runs'),
    runId: 'pm1',
    iteration: 1,
    now: () => w.t,
    sleep: async (ms) => {
      w.t += ms;
    },
    nodeBinary: 'C:\\LunaCore\\LunaCore.exe',
    connectPipeline: w.editor.connect,
    connectUnity: () => {
      throw new Error('a profile without unityMcpUrl must not use MCP for Unity');
    },
    log: (line) => w.logs.push(line),
  };
  return w;
}

const stoppedLines = (w) => w.logs.filter((l) => l === PM.PLAY_MODE_STOPPED_LINE);
const count = (log, command) => log.filter((c) => c === command).length;

test('edit mode at the start: no stop call, the scene opens right after the editor check', async () => {
  const w = world();
  const adapter = A.createAdapter('unity', w.opts);
  await adapter.start(PROFILE);

  assert.deepEqual(w.editor.log, [...PREP_LOG, 'scene open', ...PLAY_LOG]);
  assert.equal(count(w.editor.log, 'editor.playmode stop'), 0);
  assert.deepEqual(stoppedLines(w), []);
  await adapter.stop();
});

test('play mode at the start: stop, wait for edit mode, then open the scene - one log line', async () => {
  const w = world({ playMode: 'playing', exitPolls: 2 });
  const adapter = A.createAdapter('unity', w.opts);
  await adapter.start(PROFILE);

  assert.deepEqual(w.editor.log, [
    ...PREP_LOG,
    'editor.playmode stop',
    'editor status', // busy: the domain reload of leaving play mode
    'editor status', // still playing
    'editor status', // still playing
    'editor status', // edit mode
    'scene open',
    ...PLAY_LOG,
  ]);
  assert.deepEqual(stoppedLines(w), [PM.PLAY_MODE_STOPPED_LINE]);
  assert.equal(adapter.environmentFailure(), null);
  assert.ok(w.t < PM.PLAY_MODE_EXIT_WAIT_MS, 'well inside the bounded wait');
  await adapter.stop();
});

test('entering play mode reads as play mode too', async () => {
  const w = world({ playMode: 'entering', exitPolls: 0 });
  const adapter = A.createAdapter('unity', w.opts);
  await adapter.start(PROFILE);

  assert.ok(w.editor.log.indexOf('editor.playmode stop') < w.editor.log.indexOf('scene open'));
  assert.equal(count(w.editor.log, 'scene open'), 1);
  assert.equal(stoppedLines(w).length, 1);
  await adapter.stop();
});

test('the play-mode refusal of scene open: one stop and one retry in the same start, not a tool-down', async () => {
  // The last status said edit mode, yet play mode was being entered when scene open ran.
  const w = world({ enterBehindBack: 1 });
  const adapter = A.createAdapter('unity', w.opts);
  const res = await adapter.start(PROFILE);

  assert.deepEqual(res, { handle: { kind: 'unity', scene: SCENE } });
  assert.equal(count(w.editor.log, 'scene open'), 2, 'the refused one and one retry');
  assert.equal(count(w.editor.log, 'editor.playmode stop'), 1);
  const stopAt = w.editor.log.indexOf('editor.playmode stop');
  assert.ok(stopAt > w.editor.log.indexOf('scene open') && stopAt < w.editor.log.lastIndexOf('scene open'), 'stop between the two opens');
  assert.deepEqual(stoppedLines(w), [PM.PLAY_MODE_STOPPED_LINE]);
  assert.equal(adapter.environmentFailure(), null, 'no environment failure: nothing for the tool guard to pause on');
  assert.ok(w.t < 60 * 1000, 'seconds, not a 30-min pause');
  await adapter.stop();
});

test('a scene open still refused after the one retry fails the start - no loop', async () => {
  const w = world({ enterBehindBack: 5 });
  const adapter = A.createAdapter('unity', w.opts);

  await assert.rejects(adapter.start(PROFILE), /cannot run while the editor is in \(or entering\) play mode/);
  assert.equal(count(w.editor.log, 'scene open'), 2);
  assert.equal(count(w.editor.log, 'editor.playmode start'), 0);
});

test('play mode that never ends: the wait for edit mode is bounded', async () => {
  const w = world({ playMode: 'playing', exitPolls: null });
  const adapter = A.createAdapter('unity', w.opts);

  await assert.rejects(adapter.start(PROFILE), /did not return to edit mode within 30s/);
  assert.equal(count(w.editor.log, 'scene open'), 0, 'never sent in play mode');
  assert.ok(w.t >= PM.PLAY_MODE_EXIT_WAIT_MS && w.t < PM.PLAY_MODE_EXIT_WAIT_MS + 5000, `waited ${w.t} ms`);
});

test('playModeOn / isPlayModeBlock: Pipeline and legacy status shapes, the exact refusal only', () => {
  assert.equal(PM.playModeOn({ playMode: 'stopped' }), false);
  assert.equal(PM.playModeOn({ playMode: 'playing' }), true);
  assert.equal(PM.playModeOn({ playMode: 'paused' }), true);
  assert.equal(PM.playModeOn({ isPlaying: false, isPlayingOrWillChangePlaymode: true }), true);
  assert.equal(PM.playModeOn({ isPlaying: true }), true);
  assert.equal(PM.playModeOn({ isPlaying: false }), false);
  assert.equal(PM.playModeOn(null), false);
  assert.equal(PM.isPlayModeBlock(playModeRefusal('scene open')), true);
  assert.equal(PM.isPlayModeBlock(new Error("Unity command 'scene open' failed: Scene not found")), false);
  assert.equal(PM.isPlayModeBlock(null), false);
});
