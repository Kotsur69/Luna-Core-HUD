// ============================================================================
// LunaCore - no live writes into another project's Unity editor
// (src/orchestraBriefUnity.js in the God Mode worker brief, and the
// allowedProjects guard of helpers/playtest-bridge/pipeline-http.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');

const { briefText } = require('../src/orchestra.js');
const U = require('../src/orchestraBriefUnity.js');
const P = require('../helpers/playtest-bridge/pipeline-http.js');

const pkg = (over = {}) => ({ id: 'u', title: 'Task', prompt: 'Do X.', verify: 'npm test', ...over });

test('a Unity package brief forbids live writes into another project\'s editor', () => {
  const text = briefText(pkg({ prompt: 'Add a Unity prefab command to the asset pipeline.' }), 'luna/u-1');
  assert.ok(text.includes(U.UNITY_LIVE_RULE));
  assert.match(text, /never write into a Unity project that another run or Mati owns/);
  assert.match(text, /scratch Unity project or Mati's explicit OK/);
  // The rule sits in Rules, before the LUNA_DONE line.
  assert.ok(text.indexOf(U.UNITY_LIVE_RULE) > text.indexOf('## Rules'));
  assert.ok(text.indexOf(U.UNITY_LIVE_RULE) < text.indexOf('LUNA_DONE u'));
});

test('Unity detection reads title, prompt and files; other packages get no Unity line', () => {
  assert.equal(U.isUnityPackage(pkg({ title: 'Unity guard' })), true);
  assert.equal(U.isUnityPackage(pkg({ files: ['helpers/playtest-bridge/pipeline-http.js'] })), true);
  assert.equal(U.isUnityPackage(pkg({ prompt: 'Wire the unityMCP tools.' })), true);
  assert.equal(U.isUnityPackage(pkg({ prompt: 'Fix the CSS of the todo panel.' })), false);
  assert.equal(U.isUnityPackage(pkg({ prompt: 'Community page' })), false, 'a word that only contains "unity" is not Unity');
  assert.equal(U.isUnityPackage(null), false);
  assert.equal(U.isUnityPackage(pkg({ files: [42, null] })), false);
  assert.ok(!briefText(pkg(), 'luna/u-1').includes(U.UNITY_LIVE_RULE));
});

// ---- the Pipeline write guard ----------------------------------------------

const NOW = Date.parse('2026-11-26T10:00:00Z');
const ROOT = path.join(os.tmpdir(), 'luna-unity-guard');
const WORKER = path.join(ROOT, 'worker');
const SCRATCH = path.join(ROOT, 'scratch');
const GAME = path.join(ROOT, 'game');
// Assembled at runtime: a plain base64-ish filler, never a real key shape.
const TOKEN = ['tok', 'A'.repeat(24)].join('');

function client({ projectDir, projectPath = projectDir, allowedProjects }) {
  const sent = [];
  const readFile = async () => JSON.stringify({
    pid: 1, port: 7801, evalToken: TOKEN, lastHeartbeat: new Date(NOW - 1000).toISOString(), projectPath, endpoints: {},
  });
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body).command);
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, result: { ran: true } }) };
  };
  const c = P.createPipelineClient({ projectDir, fetch, readFile, now: () => NOW, allowedProjects });
  return { c, sent };
}

test('guard: a write command into a project outside the allowed set is refused and never sent', async () => {
  const { c, sent } = client({ projectDir: GAME, allowedProjects: [WORKER, SCRATCH] });
  await assert.rejects(c.exec('prefab create', { path: 'Assets/_LunaVerify/x.prefab' }), (err) => {
    assert.equal(err.code, P.PIPELINE_ERROR.notAllowed);
    assert.match(err.message, /refused/);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
  await assert.rejects(c.exec('script eval', { code: '1' }), { code: P.PIPELINE_ERROR.notAllowed });
  assert.deepEqual(sent, []);
  assert.equal(P.isTransientPipelineError({ code: P.PIPELINE_ERROR.notAllowed }), false, 'a refusal is never retried');
});

test('guard: a write command inside the allowed set runs (worker repo or scratch project)', async () => {
  for (const dir of [WORKER, SCRATCH, `${SCRATCH}${path.sep}`]) {
    const { c, sent } = client({ projectDir: dir, allowedProjects: [WORKER, SCRATCH] });
    assert.deepEqual(await c.exec('asset create', {}), { ran: true });
    assert.deepEqual(sent, ['asset create']);
  }
});

test('guard: an editor whose descriptor names an outside projectPath is refused', async () => {
  const { c, sent } = client({ projectDir: SCRATCH, projectPath: GAME, allowedProjects: [SCRATCH] });
  await assert.rejects(c.exec('scene open', {}), { code: P.PIPELINE_ERROR.notAllowed });
  assert.deepEqual(sent, []);
});

test('guard: read-only commands run against any project', async () => {
  const { c, sent } = client({ projectDir: GAME, allowedProjects: [WORKER] });
  for (const cmd of ['editor status', 'console get', 'gameobject find', 'animation inspect', 'component get_properties', 'scene list_open', 'project skills']) {
    assert.deepEqual(await c.exec(cmd, {}), { ran: true });
  }
  assert.equal(sent.length, 7);
});

test('guard: no allowed set configured = no guard, so Luna\'s Work playtests still drive the game editor', async () => {
  const { c, sent } = client({ projectDir: GAME });
  assert.deepEqual(await c.exec('editor.playmode start', {}), { ran: true });
  assert.deepEqual(await c.exec('prefab instantiate', {}), { ran: true });
  assert.deepEqual(sent, ['editor.playmode start', 'prefab instantiate']);
});

test('guard: a malformed allowed set is rejected at creation', () => {
  assert.throws(() => P.createPipelineClient({ projectDir: GAME, fetch: async () => {}, allowedProjects: 'x' }), /allowedProjects/);
  assert.throws(() => P.createPipelineClient({ projectDir: GAME, fetch: async () => {}, allowedProjects: ['relative/dir'] }), /allowedProjects/);
});

test('isReadOnlyCommand: reads by verb, everything else (unknown included) is a write', () => {
  for (const cmd of ['editor status', 'console get', 'scene list_open', 'component get_properties']) assert.equal(P.isReadOnlyCommand(cmd), true, cmd);
  for (const cmd of ['prefab create', 'script eval', 'editor invoke_menu', 'material set_properties', 'animation bake_events', 'asset frobnicate', 'status', null]) {
    assert.equal(P.isReadOnlyCommand(cmd), false, String(cmd));
  }
});
