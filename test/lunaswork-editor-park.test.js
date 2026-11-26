'use strict';

// The Unity editor parked on an empty scene around checkout updates
// (src/lunasworkEditorPark.js): order, discard-never-save, unreachable editor,
// failing git step, non-Unity pass-through, the adapter's park/unpark, the
// run tally and the report lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const P = require('../src/lunasworkEditorPark');
const { PIPELINE_ERROR } = require('../helpers/playtest-bridge/pipeline-http');
const { UNITY_PIPELINE } = require('../helpers/playtest-bridge/unity');
const { createUnityAdapter } = require('../src/lunasworkUnity');
const { restoreRun } = require('../src/lunasworkRun');
const { buildRunReport, renderRunReportHtml } = require('../src/lunasworkReport');

const SCENE = 'Assets/BladeBullet/Dev_Sandbox.unity';
const SAVE_COMMANDS = ['scene save', 'editor save_all', 'scene create'];

const pipelineErr = (code, message = code) => Object.assign(new Error(message), { code });

/** A clock whose sleep moves time on at once. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

/**
 * A fake Pipeline editor: every exec is recorded in `log` (shared with the
 * git step), answers come from `handlers` (a function per command; a missing
 * command answers {}).
 */
function fakeEditor(handlers = {}, log = []) {
  const editor = {
    log,
    calls: [],
    closed: 0,
    connect() {
      return {
        exec: async (command, parameters) => {
          editor.calls.push({ command, parameters });
          log.push(command);
          const h = handlers[command];
          return h ? h(parameters) : {};
        },
        close: async () => {
          editor.closed += 1;
        },
      };
    },
  };
  return editor;
}

const openScenes = (dirty = false) => () => [{ name: 'Dev_Sandbox', path: SCENE, isLoaded: true, isDirty: dirty, isActive: true, rootCount: 13 }];

function parkerFor(editor, opts = {}) {
  const clock = fakeClock();
  const lines = [];
  const parker = P.createEditorPark({ connect: () => editor.connect(), scene: SCENE, now: clock.now, sleep: clock.sleep, log: (l) => lines.push(l), ...opts });
  return { parker, lines };
}

async function parkedRun(editor, gitStep, opts = {}) {
  const { parker, lines } = parkerFor(editor, opts);
  const outcomes = [];
  const result = await P.withParkedEditor({ editor: parker, log: (l) => lines.push(l), onPark: (o) => outcomes.push(o) }, gitStep);
  return { result, outcomes, lines };
}

// ---- order ------------------------------------------------------------------------------

test('park -> git -> refresh -> reopen, in that order', async () => {
  const log = [];
  const editor = fakeEditor({ 'scene list_open': openScenes(false), 'script eval': () => '' }, log);
  const { result, outcomes } = await parkedRun(editor, async () => {
    log.push('git');
    return 'merged';
  });
  assert.equal(result, 'merged');
  assert.deepEqual(log, ['scene list_open', 'script eval', 'git', 'editor invoke_menu', 'scene open']);
  assert.deepEqual(editor.calls.at(-1).parameters, { path: SCENE });
  assert.deepEqual(outcomes, [{ parked: true, discarded: false, skipped: null, detail: '' }]);
  assert.ok(editor.closed >= 2, 'every session closes its connection');
});

test('the park is an empty unsaved scene in Single mode through script eval', () => {
  const [command, params] = UNITY_PIPELINE.newScene();
  assert.equal(command, 'script eval');
  assert.match(params.code, /EditorSceneManager\.NewScene\(/);
  assert.match(params.code, /NewSceneSetup\.EmptyScene/);
  assert.match(params.code, /NewSceneMode\.Single/);
  assert.doesNotMatch(params.code, /Save/);
  assert.deepEqual(UNITY_PIPELINE.openScenes(), ['scene list_open', {}]);
});

test('without a profile scene the scene that was active is reopened', async () => {
  const editor = fakeEditor({ 'scene list_open': () => [{ path: 'Assets/Other.unity', isActive: true, isDirty: false }], 'script eval': () => '' });
  await parkedRun(editor, async () => 'ok', { scene: null });
  assert.deepEqual(editor.calls.at(-1), { command: 'scene open', parameters: { path: 'Assets/Other.unity' } });
});

test('nothing saved open: no park, no reopen, the git step still runs', async () => {
  const log = [];
  const editor = fakeEditor({ 'scene list_open': () => [{ path: '', isActive: true, isDirty: true }] }, log);
  const { outcomes } = await parkedRun(editor, async () => log.push('git'));
  assert.deepEqual(log, ['scene list_open', 'git']);
  assert.equal(outcomes[0].parked, false);
  assert.equal(outcomes[0].skipped, null);
});

// ---- dirty scene ------------------------------------------------------------------------

test('a dirty scene is discarded, never saved, and the outcome says so', async () => {
  const editor = fakeEditor({ 'scene list_open': openScenes(true), 'script eval': () => '' });
  const { outcomes, lines } = await parkedRun(editor, async () => 'ok');
  for (const save of SAVE_COMMANDS) assert.equal(editor.calls.some((c) => c.command === save), false, `no ${save}`);
  assert.equal(outcomes[0].discarded, true);
  assert.ok(lines.some((l) => l.includes('unsaved editor changes were dropped')));
  const tally = P.addParkOutcome(undefined, outcomes[0]);
  assert.equal(tally.discarded, 1);
});

// ---- unreachable editor -----------------------------------------------------------------

test('an unreachable editor still runs the git step and records the skip', async () => {
  for (const code of [PIPELINE_ERROR.notOpen, PIPELINE_ERROR.unreachable, PIPELINE_ERROR.timeout]) {
    const log = [];
    const editor = fakeEditor({ 'scene list_open': () => { throw pipelineErr(code); } }, log);
    const { result, outcomes, lines } = await parkedRun(editor, async () => {
      log.push('git');
      return 'merged';
    });
    assert.equal(result, 'merged');
    assert.deepEqual(log, ['scene list_open', 'git'], `${code}: no reopen`);
    assert.equal(outcomes[0].skipped, P.PARK_SKIP.unreachable);
    assert.ok(lines.some((l) => l.includes('not parked')));
    assert.equal(P.addParkOutcome(null, outcomes[0]).unreachable, 1);
  }
});

test('a connect that throws (no port file) is a skip, not a failure', async () => {
  const log = [];
  const { parker } = parkerFor({ connect: () => { throw pipelineErr(PIPELINE_ERROR.notOpen, 'no port file'); } });
  const outcomes = [];
  await P.withParkedEditor({ editor: parker, onPark: (o) => outcomes.push(o) }, async () => log.push('git'));
  assert.deepEqual(log, ['git']);
  assert.equal(outcomes[0].skipped, P.PARK_SKIP.unreachable);
});

test('busy answers are retried, then the park goes on', async () => {
  let busy = 2;
  const editor = fakeEditor({
    'scene list_open': () => {
      if (busy-- > 0) throw Object.assign(pipelineErr(PIPELINE_ERROR.busy), { retryable: true });
      return openScenes(false)();
    },
    'script eval': () => '',
  });
  const { outcomes } = await parkedRun(editor, async () => 'ok');
  assert.equal(outcomes[0].parked, true);
  assert.equal(editor.calls.filter((c) => c.command === 'scene list_open').length, 3);
});

test('a refused empty scene (script eval off) skips the park; nothing to reopen', async () => {
  const log = [];
  const editor = fakeEditor({
    'scene list_open': openScenes(true),
    'script eval': () => { throw pipelineErr(PIPELINE_ERROR.failed, 'script eval is disabled'); },
  }, log);
  const { outcomes } = await parkedRun(editor, async () => log.push('git'));
  assert.deepEqual(log, ['scene list_open', 'script eval', 'git']);
  assert.equal(outcomes[0].skipped, P.PARK_SKIP.refused);
  assert.equal(outcomes[0].discarded, false, 'nothing was dropped when the empty scene never opened');
  const tally = P.addParkOutcome(undefined, outcomes[0]);
  assert.equal(tally.failed, 1);
  assert.match(tally.last, /refused: .*script eval is disabled/);
});

test('a lost answer to the empty scene still reopens after the git step and counts a dirty scene as dropped', async () => {
  const log = [];
  const editor = fakeEditor({
    'scene list_open': openScenes(true),
    'script eval': () => { throw pipelineErr(PIPELINE_ERROR.timeout); },
  }, log);
  const { outcomes } = await parkedRun(editor, async () => log.push('git'));
  assert.deepEqual(log, ['scene list_open', 'script eval', 'git', 'editor invoke_menu', 'scene open']);
  assert.equal(outcomes[0].discarded, true);
});

// ---- failing git step -------------------------------------------------------------------

test('a failing git step still reopens the scene, then rethrows', async () => {
  const log = [];
  const editor = fakeEditor({ 'scene list_open': openScenes(false), 'script eval': () => '' }, log);
  await assert.rejects(
    parkedRun(editor, async () => {
      log.push('git');
      throw new Error('merge failed');
    }),
    /merge failed/,
  );
  assert.deepEqual(log, ['scene list_open', 'script eval', 'git', 'editor invoke_menu', 'scene open']);
});

test('a failed reopen is a log line, never an error', async () => {
  const editor = fakeEditor({
    'scene list_open': openScenes(false),
    'script eval': () => '',
    'scene open': () => { throw pipelineErr(PIPELINE_ERROR.failed, 'no scene asset'); },
  });
  const { result, lines } = await parkedRun(editor, async () => 'merged');
  assert.equal(result, 'merged');
  assert.ok(lines.some((l) => l.includes('not unparked')));
});

test('a park or unpark that throws never blocks the git step', async () => {
  const editor = { park: async () => { throw new Error('boom'); }, unpark: async () => { throw new Error('never called'); } };
  const outcomes = [];
  const result = await P.withParkedEditor({ editor, onPark: (o) => outcomes.push(o) }, async () => 'merged');
  assert.equal(result, 'merged');
  assert.equal(outcomes[0].skipped, P.PARK_SKIP.error);
  const unparkThrows = { park: async () => ({ parked: true }), unpark: async () => { throw new Error('gone'); } };
  assert.equal(await P.withParkedEditor({ editor: unparkThrows }, async () => 'ok'), 'ok');
});

// ---- non-Unity -------------------------------------------------------------------------

test('a non-Unity adapter is a pass-through', async () => {
  let made = 0;
  const create = () => {
    made += 1;
    return { park: async () => assert.fail('no park'), unpark: async () => assert.fail('no unpark') };
  };
  for (const profile of [{ adapter: 'web' }, { adapter: 'electron' }, null]) {
    const editor = P.editorFor({ profile, createAdapter: create });
    assert.equal(editor, null);
    assert.equal(await P.withParkedEditor({ editor }, async () => 'merged'), 'merged');
  }
  assert.equal(made, 0, 'no adapter is made for a non-Unity profile');
  assert.equal(await P.withParkedEditor(undefined, async () => 'plain'), 'plain');
});

test('editorFor uses the live adapter, else makes one; a failing factory is no park', async () => {
  const profile = { adapter: 'unity', scene: SCENE };
  const seen = [];
  const live = { park: async (p) => seen.push(p) && { parked: false }, unpark: async () => ({}) };
  await P.editorFor({ profile, adapter: live, createAdapter: () => assert.fail('live adapter first') }).park();
  assert.deepEqual(seen, [profile]);
  assert.ok(P.editorFor({ profile, createAdapter: () => live }));
  const lines = [];
  assert.equal(P.editorFor({ profile, createAdapter: () => { throw new Error('bad dir'); }, log: (l) => lines.push(l) }), null);
  assert.ok(lines[0].includes('bad dir'));
  assert.equal(P.editorFor({ profile, createAdapter: () => ({ start() {} }) }), null, 'an adapter without park');
});

// ---- the Unity adapter -----------------------------------------------------------------

function unityAdapter(editor) {
  const clock = fakeClock();
  return createUnityAdapter({
    projectDir: path.join(os.tmpdir(), 'lw-park-project'),
    evidenceDir: path.join(os.tmpdir(), 'lw-park-evidence'),
    now: clock.now,
    sleep: clock.sleep,
    nodeBinary: process.execPath,
    connectUnity: () => assert.fail('no legacy MCP'),
    connectPipeline: () => editor.connect(),
  });
}

test('the Unity adapter parks and unparks through its own Pipeline client', async () => {
  const log = [];
  const editor = fakeEditor({ 'scene list_open': openScenes(true), 'script eval': () => '' }, log);
  const adapter = unityAdapter(editor);
  const profile = { adapter: 'unity', scene: SCENE, readyTimeoutSec: 5 };
  const outcomes = [];
  await P.withParkedEditor({ editor: P.editorFor({ profile, adapter }), onPark: (o) => outcomes.push(o) }, async () => log.push('git'));
  assert.deepEqual(log, ['scene list_open', 'script eval', 'git', 'editor invoke_menu', 'scene open']);
  assert.equal(outcomes[0].discarded, true);
  assert.deepEqual(await adapter.unpark({ parked: true, reopen: SCENE }), { reopened: false }, 'a second unpark does nothing');
});

test('the Unity adapter does not park over legacy MCP for Unity', async () => {
  const adapter = unityAdapter(fakeEditor());
  const state = await adapter.park({ adapter: 'unity', unityMcpUrl: 'http://127.0.0.1:8080/mcp', scene: SCENE, readyTimeoutSec: 5 });
  assert.equal(state.parked, false);
  assert.equal(state.skipped, P.PARK_SKIP.unsupported);
});

// ---- tally + report ---------------------------------------------------------------------

test('the park tally is cleaned and survives a run restore', () => {
  assert.deepEqual(P.cleanParkTally({ discarded: -1, unreachable: 2.5, failed: 'x', last: 7 }), { discarded: 0, unreachable: 0, failed: 0, last: null });
  let tally = P.addParkOutcome(undefined, { parked: true, discarded: true, skipped: null });
  tally = P.addParkOutcome(tally, { parked: false, discarded: false, skipped: 'unreachable' });
  tally = P.addParkOutcome(tally, { parked: false, discarded: false, skipped: 'busy', detail: 'compiling' });
  assert.deepEqual(tally, { discarded: 1, unreachable: 1, failed: 1, last: 'busy: compiling' });
  const run = restoreRun({ id: 'r1', projectId: 'p1', repoPath: path.join(os.tmpdir(), 'repo'), phase: 'directing', iteration: 1, editorPark: tally });
  if (run) assert.deepEqual(run.editorPark, tally);
});

test('the run report names discarded changes and skipped parks, in English and Polish', () => {
  assert.deepEqual(P.parkReportLines(undefined), []);
  const run = { id: 'r1', repoPath: '/x/game', verdict: 'stop', laps: [], editorPark: { discarded: 2, unreachable: 1, failed: 0, last: null } };
  const md = buildRunReport(run, { now: 0 });
  assert.match(md, /## Unity editor/);
  assert.match(md, /unsaved scene changes were discarded \(never saved\) before 2 checkout update/);
  assert.match(md, /niezapisane zmiany sceny zostaly odrzucone/);
  assert.match(md, /not reachable, so it was not parked before 1 checkout update/);
  assert.match(md, /nieosiagalny/);
  assert.doesNotMatch(md, /[ąćęłńóśźż]/i, 'Polish without diacritics');
  assert.match(renderRunReportHtml(run, { now: 0 }), /Unity editor/);
  assert.doesNotMatch(buildRunReport({ ...run, editorPark: undefined }, { now: 0 }), /## Unity editor/);
});
