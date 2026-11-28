// ============================================================================
// Luna's Work on Unity: builders never drive the main checkout's Unity editor;
// editor-code packages verify in their own capped worktree editor.
// (src/lunasworkWorktreeEditors.js, src/lunasworkToolkit.js roleLaunch,
// src/lunasworkBuild.js kitOf / workerSettings, src/orchestraEditorSlots.js,
// src/orchestra.js launch gate + reaper, src/orchestraWiring.js policy.)
// Run lwmwzajado: the scene worker sent an open-scene request with its
// worktree path to Mati's live editor ("About to open another project!").
// Injected fakes only: no Unity, no git, no CLI.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('../src/lunasworkWorktreeEditors');
const K = require('../src/lunasworkToolkit');
const slots = require('../src/orchestraEditorSlots');
const { createToolsFor } = require('../src/lunasworkToolkitLaunch');
const { createGodModeBuilder } = require('../src/lunasworkBuild');
const { createOrchestra } = require('../src/orchestra');
const { worktreeEditorPolicy } = require('../src/orchestraWiring');
const { SCENE_WORKER_ID } = require('../src/lunasworkScene');
const { MAX_PARALLEL } = require('../src/orchestraPlan');

const MAIN = 'C:\\Users\\mati\\source\\repos\\blade&bullet';
const WT = 'C:\\Users\\mati\\source\\repos\\.luna-worktrees\\blade&bullet\\sandbox-x1y2z';
const tick = () => new Promise((r) => setImmediate(r));

// A blade&bullet-like PC: the Unity MCP has a launch definition too.
const SETTINGS = () => ({
  toolServers: { unity: { command: 'unity-editor-mcp', args: [] }, blender: { command: 'uvx', args: ['blender-mcp'] } },
  projects: { 'blade-bullet': { profile: { adapter: 'unity' } } },
});

// Requests that would reach the editor on the main checkout, in the shapes a worker types them.
const AT_MAIN = [
  `unity command scene open --path "${MAIN}\\Assets\\Scenes\\Main.unity"`,
  'unity command scene open --path "C:/Users/mati/source/repos/blade&bullet/Assets/Scenes/Main.unity"',
  `unity --project "${MAIN}" command editor.playmode start`,
  `Unity command editor.playmode start --project ${MAIN}`,
  `Unity.exe -projectPath "${MAIN}"`,
  `unity.exe command scene open --project "${MAIN}"`,
  `cd "${MAIN}"`,
  'cd /c/Users/mati/source/repos/blade&bullet',
  `pushd "${MAIN}\\Assets"`,
];
const isCd = (cmd) => /^(cd|pushd) /.test(cmd);

const CARDS = [
  { at: 1, text: 'Build sandbox hook', files: ['Assets/Game/Editor/BuildSandbox.cs'] },
  { at: 2, text: 'HUD', files: ['Assets/Scripts/Hud.cs'] },
  { at: 3, text: 'Place the HUD', files: ['Assets/Scenes/Main.unity'] },
  { at: 4, text: 'Hero sprite', files: ['Assets/Game/Art/hero.png', 'design/ASSETS.md'] },
];
const PACKAGES = () => [
  { id: 'sandbox', title: 'Build sandbox', todoAts: [1], prompt: 'Build the sandbox hook.', files: ['Assets/Game/Editor/BuildSandbox.cs'], dependsOn: [], verify: '' },
  { id: 'hud', title: 'HUD', todoAts: [2], prompt: 'Build the HUD.', files: ['Assets/Scripts/Hud.cs'], dependsOn: [], verify: 'unity command test run --filter Hud' },
  { id: 'scene', title: 'Place the HUD', todoAts: [3], prompt: 'Place it.', files: ['Assets/Scenes/Main.unity'], dependsOn: ['hud'], verify: '' },
  { id: 'art', title: 'Hero', todoAts: [4], prompt: 'Make the hero.', files: ['Assets/Game/Art/hero.png', 'design/ASSETS.md'], dependsOn: [], verify: '' },
];

function fakeOrchestra() {
  const o = {
    settle: null,
    makePlan: async (ctx) => {
      o.settle = ctx.onRunSettled;
      return { ok: true, plan: { id: 'p1', errors: [] } };
    },
    launch: async () => ({ ok: true }),
    cancelPlanWait: () => ({ ok: true }),
  };
  return o;
}

/** A build on MAIN with the real kit (createToolsFor): its planned packages and their tab kits. */
async function unityBuild(t, { unity = true, toolsFor: wrap } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-editor-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = createToolsFor({ readSettings: SETTINGS, dir: () => dir });
  const requests = [];
  let lastKit = null;
  const toolsFor = (req) => {
    requests.push(req);
    lastKit = (wrap || real)(req);
    return lastKit;
  };
  const orchestra = fakeOrchestra();
  const builder = createGodModeBuilder({
    orchestra,
    profileId: () => null,
    env: () => ({}),
    isUnityProject: () => unity,
    configureUnityMerge: async () => ({ ok: true }),
    toolsFor,
  });
  const planner = builder.wrapPlanner(async () => ({ ok: true, raw: { packages: PACKAGES() } }));
  const building = builder.build({ projectId: 'blade-bullet', repoPath: MAIN, cards: CARDS, checkCommand: '' });
  await tick();
  const planned = (await planner({})).raw.packages;
  const byId = Object.fromEntries(planned.map((p) => [p.id, p]));
  // The tab's launch flags (workerTools: what God Mode passes to the CLI) over the kit they came from (editor, tools, note).
  const kits = Object.fromEntries(planned.map((p) => {
    const tab = builder.workerTools(p);
    return [p.id, { ...lastKit, ...tab }];
  }));
  const settings = builder.workerSettings({});
  orchestra.settle({ planId: 'p1', integration: { state: 'done' } });
  await building;
  return { byId, kits, requests, settings };
}

const denied = (kit, command) => kit.disallowedTools.some((rule) => K.matchesBashRule(rule, command));

// ---- classification ----------------------------------------------------------------

test('editor code is an Editor folder under Assets, Scripts/Dev, the playtest driver or a playtest command file', () => {
  for (const f of [
    'Assets/Game/Editor/BuildSandbox.cs',
    'Assets/Editor/Tools.cs',
    'Assets\\Game\\Editor\\Menu.cs',
    'Assets/Game/Scripts/Dev/DevConsole.cs',
    'Assets/LunaPlaytest/PlaytestDriver.cs',
    'Assets/LunaPlaytest/Tests/PlayMode/PlaytestDriverTests.cs',
    'Assets/Tools/Commands/PlaytestCommands.cs',
    'Assets/Tools/Commands/Game.Playtest.asmdef',
  ]) {
    assert.equal(W.isEditorCodeFile(f), true, f);
  }
  for (const f of ['Assets/Scripts/Hud.cs', 'Assets/Scenes/Main.unity', 'Assets/EditorArt/x.png', 'docs/Editor/notes.md', 'Assets/Game/Editor', '', null, '../Assets/Editor/x.cs']) {
    assert.equal(W.isEditorCodeFile(f), false, String(f));
  }
  assert.equal(W.needsWorktreeEditor({ id: SCENE_WORKER_ID, files: [] }), true, 'the scene worker runs its own editor');
  assert.equal(W.needsWorktreeEditor({ id: 'hud', files: ['Assets/Scripts/Hud.cs'] }), false);
  assert.equal(W.needsWorktreeEditor(null), false);
  assert.equal(W.MAX_WORKTREE_EDITORS, 2);
});

// ---- FIX 1: the tool-level guard -----------------------------------------------------

test("a builder in a worktree gets no tool that can drive the main checkout's editor (launch kit)", async (t) => {
  const { kits, requests } = await unityBuild(t);
  // Every package of a Unity build is asked for with an explicit editor mode and the main checkout.
  const modes = new Set(requests.map((r) => `${r.role}:${r.editor}`));
  for (const m of ['builder:none', 'builder:worktree', 'asset:worktree', 'asset:none']) assert.ok(modes.has(m), `${m} in ${[...modes]}`);
  assert.ok(requests.every((r) => r.repoPath === MAIN));

  for (const id of ['hud', 'art']) {
    const kit = kits[id];
    assert.equal(kit.editor, 'none', id);
    for (const rule of ['Bash(unity:*)', 'Bash(Unity:*)', 'Bash(Unity.exe:*)', 'Bash(unity.exe:*)']) {
      assert.ok(kit.disallowedTools.includes(rule), `${id}: ${rule} denied`);
      assert.ok(!kit.allowedTools.includes(rule), `${id}: ${rule} not allowed`);
    }
    assert.ok(!kit.tools.includes('unity'), `${id}: the unity tool is out of its kit`);
    // Any unity command at all: there is no editor of its own it could reach.
    for (const cmd of ['unity command scene open --path Assets/Scenes/Main.unity', 'Unity -batchmode -projectPath .', ...AT_MAIN.filter((c) => !isCd(c))]) {
      assert.ok(denied(kit, cmd), `${id}: ${cmd}`);
    }
    assert.match(kit.note, /This package has no Unity editor/);
  }
});

test('every Unity MCP server is denied to every package and none is launched, whatever the PC defines', async (t) => {
  const { kits } = await unityBuild(t);
  for (const [id, kit] of Object.entries(kits)) {
    for (const server of W.UNITY_MCP_SERVERS) assert.ok(kit.disallowedTools.includes(`mcp__${server}`), `${id}: mcp__${server}`);
    assert.ok(!kit.allowedTools.some((r) => /^mcp__unity/i.test(r)), `${id}: no Unity MCP allowed`);
    const config = JSON.parse(fs.readFileSync(kit.mcpConfigPath, 'utf8'));
    assert.equal(config.mcpServers.unity, undefined, `${id}: the PC's unity server is not in --mcp-config`);
    assert.ok(config.mcpServers.blender, `${id}: the other servers still are`);
  }
});

test('the main-checkout editor is never driven by a builder: every package, every mode, every path spelling', async (t) => {
  const { kits } = await unityBuild(t);
  assert.deepEqual(Object.keys(kits).sort(), ['art', 'hud', 'sandbox', SCENE_WORKER_ID].sort());
  for (const [id, kit] of Object.entries(kits)) {
    // A 'none' package has no unity tool at all, so a bare cd elsewhere cannot reach an editor.
    for (const cmd of AT_MAIN.filter((c) => kit.editor === 'worktree' || !isCd(c))) {
      assert.ok(denied(kit, cmd), `${id} (${kit.editor}): ${cmd}`);
    }
  }
});

test('a package with its own worktree editor may drive only that one: the unity CLI in its worktree is allowed', async (t) => {
  const { kits } = await unityBuild(t);
  for (const id of ['sandbox', SCENE_WORKER_ID]) {
    const kit = kits[id];
    assert.equal(kit.editor, 'worktree', id);
    assert.ok(kit.allowedTools.includes('Bash(unity:*)'), `${id}: the unity CLI`);
    assert.ok(!kit.disallowedTools.includes('Bash(unity:*)'), id);
    for (const cmd of [
      'unity command test run --mode EditMode',
      'unity command editor.playmode start',
      `Unity.exe -batchmode -projectPath "${WT}" -runTests -testPlatform EditMode`,
      `cd "${WT}"`,
    ]) {
      assert.ok(!denied(kit, cmd), `${id}: ${cmd} stays allowed`);
    }
  }
});

test('the rules cover the path as given, with forward slashes, backslashes (single and doubled) and the Git Bash form; a root is never guarded', () => {
  assert.deepEqual(W.pathForms('C:/a/game/'), ['C:/a/game', 'C:\\a\\game', 'C:\\\\a\\\\game', '/c/a/game']);
  assert.deepEqual(W.pathForms('/home/mati/game'), ['/home/mati/game']);
  assert.deepEqual(W.pathForms('C:\\'), []);
  assert.deepEqual(W.pathForms('C:\\Program Files (x86)\\game'), [], 'a rule body cannot hold parentheses');
  assert.deepEqual(W.mainCheckoutDenyRules('relative/game'), []);
  assert.deepEqual(W.editorDenyRules('unknown', MAIN), []);
  assert.deepEqual(W.editorDenyRules('none', MAIN), [...W.UNITY_MCP_SERVERS.map((s) => `mcp__${s}`), ...W.NO_EDITOR_RULES], 'none: MCP servers + the binary anywhere');
});

test('the Unity binary by its full path is caught too: anywhere for a package without an editor, at the main checkout for one with its own', async (t) => {
  const { kits } = await unityBuild(t);
  const hub = '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.6.4f1\\Editor\\Unity.exe"';
  assert.ok(denied(kits.hud, `${hub} -batchmode -projectPath .`), 'none: no batchmode either');
  assert.ok(denied(kits.hud, `& ${hub} -projectPath "${WT}"`), 'none: not even on its own worktree');
  assert.ok(denied(kits.sandbox, `${hub} -projectPath "${MAIN}"`), 'worktree: never on the main checkout');
  assert.ok(denied(kits.sandbox, `${hub} -projectPath C:/Users/mati/source/repos/blade&bullet`));
  assert.ok(!denied(kits.sandbox, `${hub} -projectPath "${WT}"`), 'worktree: its own worktree editor opens');
  assert.ok(!denied(kits.sandbox, 'grep -rn UnityEngine Assets/Game'), 'a plain mention of Unity in the worktree is fine');
});

test('the launch line keeps every main-checkout rule for blade&bullet (`&`, backslashes): none is dropped', async (t) => {
  const { withTaskBrief, isPassableDenyRule } = require('../src/launch');
  const { kits } = await unityBuild(t);
  for (const [id, kit] of Object.entries(kits)) {
    const dropped = kit.disallowedTools.filter((r) => !isPassableDenyRule(r));
    assert.deepEqual(dropped, [], `${id}: every deny rule reaches the CLI`);
  }
  const line = withTaskBrief('claude', { briefPath: '.luna-brief/sandbox.md', permissionMode: 'bypassPermissions', allowedTools: [], ...kits.sandbox });
  assert.ok(line.includes(`'Bash(*unity*${MAIN}*)'`), 'the backslash form, single-quoted');
  assert.ok(line.includes("'Bash(cd *C:/Users/mati/source/repos/blade&bullet*)'"));
  assert.ok(line.includes("'mcp__unityMCP'"));
  // Still nothing a single-quoted argument would let through.
  for (const bad of ["Bash(unity 'x')", 'Bash(unity $(x))', 'Bash(unity `x`)', `Bash(${'u'.repeat(301)})`]) assert.equal(isPassableDenyRule(bad), false, bad);
});

test('a non-Unity build asks for no editor mode: its kit is exactly as before', async (t) => {
  const { requests, settings } = await unityBuild(t, {
    unity: false,
    toolsFor: () => ({ allowedTools: ['mcp__unity'], disallowedTools: [], mcpConfigPath: null, addDirs: [], note: 'kit' }),
  });
  // The build's adapter is not 'unity' and the repo is no Unity project.
  assert.ok(requests.length > 0);
  assert.ok(requests.every((r) => !('editor' in r)), 'no editor key');
  assert.equal('worktreeEditors' in settings, false);
  const before = K.roleLaunch(K.defaultToolkit('unity'), 'builder', {});
  assert.ok(before.allowedTools.includes('mcp__unity'), 'roleLaunch without a mode keeps the Unity MCP');
  assert.equal(before.editor, undefined);
});

// ---- the brief -----------------------------------------------------------------------

test('the Unity builder brief states the rule: the live editor belongs to the playtest; files, batchmode or an own worktree editor', async (t) => {
  const { byId } = await unityBuild(t);
  for (const [id, p] of Object.entries(byId)) {
    assert.ok(p.prompt.includes(`the live Unity editor on the main checkout (${MAIN}) belongs to the playtest after the merge`), id);
    assert.match(p.prompt, /Never drive it: no Unity MCP call, no scene open, no play mode, no `unity` command aimed at it/, id);
    assert.match(p.prompt, /Scene work is done by editing files, by Unity in batchmode on your own worktree, or in your own worktree editor/, id);
  }
  assert.match(byId.hud.prompt, /This package has no Unity editor/);
  assert.match(byId.hud.prompt, /list that check as "not run here" in your hand-back/);
  assert.doesNotMatch(byId.hud.prompt, /OWN Unity editor on this worktree/);
  // The scene worker's own brief says the same before its kit note does.
  assert.match(byId[SCENE_WORKER_ID].prompt, /^You are the SCENE WORKER[^\n]*OWN Unity editor opened on this worktree/);
  assert.match(byId[SCENE_WORKER_ID].prompt, /Never drive the Unity editor on the main checkout/);
});

test('a package touching editor / play-mode code is briefed to verify in its own worktree editor and report tests + smoke', async (t) => {
  const { byId } = await unityBuild(t);
  const prompt = byId.sandbox.prompt;
  assert.match(prompt, /This package gets its OWN Unity editor on this worktree/);
  assert.match(prompt, /at most 2 worktree editors at once/);
  assert.match(prompt, /-projectPath "<this worktree>"/);
  assert.match(prompt, /2\. EditMode tests: run them in this editor/);
  assert.match(prompt, /3\. Play-mode smoke: enter play mode in this editor[^\n]*back in edit mode/);
  assert.match(prompt, /4\. Close the editor before you finish/);
  assert.match(prompt, /5\. Report both in your final message[^\n]*"EditMode tests: [^"]+" and "Play-mode smoke: [^"]+"/);
  // Next to the scene worker, the code-worker note no longer forbids its own editor outright,
  // and the kit note says it wins over any "do not open / not run here" line above it.
  assert.match(prompt, /Do not open the Unity editor for scene or prefab work/);
  assert.match(prompt, /This overrides any line above that tells you not to open the Unity editor/);
  // The editor rule sits right after the tools line: a shortened note loses the generic lines first.
  const note = prompt.slice(prompt.indexOf("## Tool kit (Luna's Work)"));
  assert.ok(note.indexOf('Unity editors:') < note.indexOf('Write only inside'), 'editor rule before the generic guardrails');
  assert.doesNotMatch(byId.art.prompt, /OWN Unity editor on this worktree/, 'asset-prep has no editor');
});

test("the PlaytestDriver card tests in its own worktree editor, never the main checkout's", () => {
  const { playtestDriverCard } = require('../src/lunasworkUnity');
  const card = playtestDriverCard();
  assert.match(card.details, /opens its OWN Unity editor on its worktree/);
  assert.match(card.details, /Never use the editor on the main checkout/);
  assert.ok(card.files.every((f) => W.isEditorCodeFile(f)), 'every driver file makes its package a worktree-editor package');
  assert.ok(card.acceptance.some((a) => /worktree editor, never the main checkout's/.test(a)));
});

// ---- the cap -------------------------------------------------------------------------

test('workerSettings carries the cap only in a Unity build; the wiring turns it into the policy', async (t) => {
  const { settings } = await unityBuild(t);
  assert.equal(settings.worktreeEditors, W.MAX_WORKTREE_EDITORS);
  const policy = worktreeEditorPolicy(settings, async () => ({ closed: [], failed: [] }));
  assert.equal(policy.max, 2);
  assert.equal(policy.needs({ id: SCENE_WORKER_ID }), true);
  assert.equal(policy.needs({ id: 'hud', files: ['Assets/Scripts/Hud.cs'] }), false);
  for (const bad of [{}, { worktreeEditors: 0 }, { worktreeEditors: 1.5 }, { worktreeEditors: '2' }, null]) assert.equal(worktreeEditorPolicy(bad), null);
});

test('capEditorLaunches: at most N editor packages hold a slot; others take the free slot; a closing editor counts', () => {
  const pk = (id, editor, state = 'pending') => ({ id, editor, state });
  const isActive = (p) => p.state === 'launched';
  const needs = (p) => p.editor === true;
  const readyOf = (list) => list.filter((p) => p.state === 'pending').slice(0, 3 - list.filter(isActive).length);
  const packages = [pk('e1', true, 'launched'), pk('e2', true), pk('e3', true), pk('c1', false), pk('c2', false)];
  const res = slots.capEditorLaunches(packages, { readyOf, isActive, needs, max: 2 });
  assert.deepEqual(res.ready.map((p) => p.id), ['e2', 'c1']);
  assert.deepEqual(res.held, ['e3']);
  const closing = slots.capEditorLaunches(packages, { readyOf, isActive, needs, max: 2, closing: 1 });
  assert.deepEqual(closing.ready.map((p) => p.id), ['c1', 'c2'], 'an editor still closing holds its slot');
  assert.deepEqual(closing.held.sort(), ['e2', 'e3']);
  assert.equal(slots.editorPolicyOf({ max: 0, needs }), null);
  assert.equal(slots.editorPolicyOf({ max: 2 }), null);
});

test('reaper: only a launch seen running is closed - a package already settled at a restore keeps a hand-opened editor', async () => {
  const closes = [];
  const reaper = slots.createEditorReaper({ isSettled: (p) => p.state === 'pushed' });
  const policy = { max: 2, needs: () => true, close: async (root) => (closes.push(root), { closed: [], failed: [] }) };
  const restored = { id: 'old', state: 'pushed', root: '/wt/old-1', startedAt: 1 };
  const live = { id: 'new', state: 'launched', root: '/wt/new-1', startedAt: 2 };
  await Promise.all(reaper.sweep([restored, live], MAIN, policy, policy.needs));
  assert.deepEqual(closes, [], 'nothing settled after being seen live');
  await Promise.all(reaper.sweep([restored, { ...live, state: 'pushed' }], MAIN, policy, policy.needs));
  assert.deepEqual(closes, ['/wt/new-1']);
});

test('reaper: a close that never answers frees its slot after the timeout; a throwing callback is logged', async () => {
  const lines = [];
  let fire = null;
  const reaper = slots.createEditorReaper({
    isSettled: (p) => p.state === 'pushed',
    onClosed: () => {
      throw new Error('kick failed');
    },
    log: (l) => lines.push(l),
    setTimer: (fn) => ((fire = fn), 1),
    clearTimer: () => {},
  });
  const policy = { max: 2, needs: () => true, close: () => new Promise(() => {}) };
  const pkg = { id: 'e1', state: 'launched', root: '/wt/e1-1', startedAt: 1 };
  reaper.sweep([pkg], MAIN, policy, policy.needs);
  const [closing] = reaper.sweep([{ ...pkg, state: 'pushed' }], MAIN, policy, policy.needs);
  assert.equal(reaper.closing(), 1);
  fire();
  await closing;
  assert.equal(reaper.closing(), 0, 'the slot is free again');
  assert.ok(lines.some((l) => /did not close: no answer within 120 s/.test(l)));
  assert.ok(lines.some((l) => /kick failed/.test(l)));
});

// ---- through the God Mode controller ------------------------------------------------

const turn = (text) => JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const gmPkg = (id, at, files) => ({ id, title: `T ${id}`, todoAts: [at], prompt: `do ${id}`, files, dependsOn: [], verify: '', model: 'opus', effort: 'medium' });

function godMode({ packages, editors }) {
  let seq = 0;
  const log = { sessions: [], lines: [] };
  const alive = new Set();
  const orch = createOrchestra({
    now: () => 1_000_000,
    readTodos: () => packages.map((p) => ({ at: p.todoAts[0], text: `t${p.todoAts[0]}`, done: false })),
    dirtyCount: async () => 0,
    runPlanner: async () => ({ ok: true, raw: { packages, notes: '' }, costUsd: 0 }),
    addWorktree: async (repo, name) => ({ ok: true, root: path.join('/wt', name), cwd: path.join('/wt', name), branch: `luna/${name}` }),
    headSha: async () => 'base',
    briefDir: () => '/cfg/tasks',
    writeBrief: () => true,
    createSession: (opts) => {
      seq += 1;
      log.sessions.push(opts);
      alive.add(`s${seq}`);
      return { id: `s${seq}` };
    },
    closeSession: (id) => alive.delete(id),
    finishPackage: async (p) => ({ ok: true, headSha: `${p.id}aaaaaaa` }),
    writePty: (sessionId) => alive.has(sessionId),
    sessionAlive: (id) => alive.has(id),
    workerSettings: () => ({ model: 'opus', effort: 'plan', permissionMode: 'bypassPermissions', integration: 'pr', allowedTools: [] }),
    saveWorkerModel: () => {},
    log: (line) => log.lines.push(line),
    sleep: async () => {},
    setTimer: () => ({}),
    clearTimer: () => {},
    ...(editors ? { worktreeEditors: () => editors } : {}),
  });
  const flush = async (n = 8) => {
    for (let i = 0; i < n; i += 1) await tick();
  };
  const launched = () => orch.view().packages.filter((p) => p.state !== 'pending').map((p) => p.id);
  const sessionOf = (id) => `s${log.sessions.findIndex((s) => s.cwd.includes(`${id}-`)) + 1}`;
  return { orch, log, flush, launched, sessionOf };
}

async function startGodMode(opts) {
  const s = godMode(opts);
  const made = await s.orch.makePlan({ projectId: 'p1', repoPath: MAIN, profileId: 'cloud', env: {} });
  assert.equal(made.ok, true, JSON.stringify(made));
  const res = await s.orch.launch({ planId: made.plan.id, integration: 'branches', workers: 'claude' });
  assert.equal(res.ok, true, JSON.stringify(res));
  await s.flush();
  return s;
}

const EDITOR_RUN = () => [
  gmPkg('e1', 1, ['Assets/Game/Editor/A.cs']),
  gmPkg('e2', 2, ['Assets/Game/Scripts/Dev/B.cs']),
  gmPkg('e3', 3, ['Assets/LunaPlaytest/PlaytestDriver.cs']),
  gmPkg('c1', 4, ['Assets/Scripts/C.cs']),
];
const stateOf = (s, id) => s.orch.view().packages.find((p) => p.id === id).state;

test('God Mode: at most 2 worktree editors at once - the third editor package waits, a code package takes the slot', async () => {
  assert.ok(MAX_PARALLEL >= 3, 'the global cap leaves room for the code package');
  const closes = [];
  const editors = { max: W.MAX_WORKTREE_EDITORS, needs: W.needsWorktreeEditor, close: async (root, repoPath) => (closes.push([root, repoPath]), { closed: [], failed: [] }) };
  const s = await startGodMode({ packages: EDITOR_RUN(), editors });
  assert.deepEqual(s.launched(), ['e1', 'e2', 'c1']);
  assert.equal(stateOf(s, 'e3'), 'pending', 'e3 waits for an editor slot');
  // The tick looks again: still held while both editors run.
  s.orch.tick();
  await s.flush();
  assert.deepEqual(s.launched(), ['e1', 'e2', 'c1']);
  assert.deepEqual(closes, [], 'nothing settled, nothing closed');
});

test('God Mode: a finished editor package gets its worktree editors closed (never the main checkout); then the held one launches', async () => {
  const closes = [];
  let release = null;
  const editors = {
    max: W.MAX_WORKTREE_EDITORS,
    needs: W.needsWorktreeEditor,
    close: (root, repoPath) => {
      closes.push([root, repoPath]);
      return new Promise((resolve) => {
        release = () => resolve({ closed: [{ pid: 300, projectPath: root, how: 'quit' }], failed: [] });
      });
    },
  };
  const s = await startGodMode({ packages: EDITOR_RUN(), editors });
  const e1Session = s.log.sessions[Number(s.sessionOf('e1').slice(1)) - 1];

  s.orch.onTurnEnd(s.sessionOf('e1'), turn('LUNA_DONE e1'));
  await s.flush();
  assert.equal(stateOf(s, 'e1'), 'pushed');
  assert.equal(closes.length, 1, 'closed once');
  assert.equal(closes[0][0], e1Session.cwd, "the package's own worktree");
  assert.equal(closes[0][1], MAIN, 'the main checkout is passed as the protected path');
  // The editor is still closing: it holds its slot.
  assert.equal(stateOf(s, 'e3'), 'pending');

  release();
  await s.flush();
  assert.notEqual(stateOf(s, 'e3'), 'pending', 'the held editor package launches once the editor is closed');
  assert.ok(s.log.lines.some((l) => /e1 settled: closed 1 Unity editor/.test(l)));

  // A code package finishing closes nothing; a later commit never closes e1 again.
  s.orch.onTurnEnd(s.sessionOf('c1'), turn('LUNA_DONE c1'));
  await s.flush();
  assert.equal(stateOf(s, 'c1'), 'pushed');
  assert.equal(closes.length, 1);
});

test('God Mode regression: without the policy (any other run) every ready package launches as before', async () => {
  const s = await startGodMode({ packages: EDITOR_RUN(), editors: null });
  assert.deepEqual(s.launched(), ['e1', 'e2', 'e3']);
});

test('God Mode: a broken classifier never stops a launch', async () => {
  const s = await startGodMode({
    packages: EDITOR_RUN(),
    editors: {
      max: 2,
      needs: () => {
        throw new Error('boom');
      },
    },
  });
  assert.deepEqual(s.launched(), ['e1', 'e2', 'e3'], 'a throwing classifier counts no package as an editor package');
  assert.ok(s.log.lines.some((l) => /worktree editor check failed/.test(l)));
});
