'use strict';

// God Mode "Plan only" with the agy planner: the saved orchestraPlannerAgyModel
// pref is read in main (orchestra:planRun:start), resolved by makePlanRun via
// agyPlannerModelId against the live `agy models` list, and reaches the topic
// split as `--model`. A missing family or no pick falls back to agy's default
// model with a log line. Claude and Free plan runs are unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createOrchestra } = require('../src/orchestra');
const { runTopicSplit } = require('../src/orchestraPlanRunStart');
const { registerOrchestraIpc } = require('../src/orchestraIpc.js');
const { createOrchestraRegistry } = require('../src/orchestraRegistry.js');

const TOPICS = [
  { slug: 'auth-flow', question: 'How should sign-in work?' },
  { slug: 'data-model', question: 'What tables do we need?' },
];
const PLAN_PROFILE = { id: 'freellm-auto', command: 'claude', env: { ANTHROPIC_MODEL: 'auto:easy' } };
const LIVE = [
  { id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
];

function fakeAgyModels(list = LIVE) {
  const ids = list.map((m) => m.id);
  const calls = { ensure: 0 };
  return {
    calls,
    ensure: async () => {
      calls.ensure += 1;
      return list.map((m) => ({ ...m }));
    },
    list: () => list.map((m) => ({ ...m })),
    isKnownId: (id) => ids.includes(id),
  };
}

function setup({ agyModels = fakeAgyModels() } = {}) {
  const log = { splits: [], lines: [] };
  const orch = createOrchestra({
    now: () => 1700000000000,
    readTodos: () => [],
    dirtyCount: async () => 0,
    baseBranchOf: async () => 'main',
    runPlanner: async () => {
      throw new Error('a plan run never calls the build planner');
    },
    runTopicSplit: async (args) => {
      log.splits.push(args);
      return { ok: true, raw: { topics: TOPICS }, costUsd: null };
    },
    planProfile: () => PLAN_PROFILE,
    planMcpConfigPath: () => '/cfg/luna-plan-mcp.json',
    addWorktree: async (repo, name, opts) => ({ ok: true, root: `/wt/${name}`, cwd: `/wt/${name}`, branch: `${opts.branchPrefix || 'luna/'}${name}` }),
    removeWorktree: async () => ({ ok: true }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
    agyModels,
    log: (line) => log.lines.push(line),
  });
  return { orch, log, agyModels };
}

const ctx = (over = {}) => ({ projectId: 'p1', repoPath: '/repo', env: { E: '1' }, request: 'Plan the auth redesign', planner: 'agy', planRunRequest: true, ...over });
const defaultLogged = (lines) => lines.some((l) => /Plan only: the agy planner runs on agy's default model/.test(l));

test('plan only, agy planner: the saved family resolves to its live variant and reaches the split as model', async (t) => {
  const { orch, log } = setup();
  t.after(() => orch.kill && orch.kill());
  const res = await orch.makePlanRun(ctx({ plannerAgyModel: 'agy-argon' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  // No planner effort on a plan run: the default level (high) picks the variant.
  assert.equal(log.splits[0].model, 'gemini-4-argon-high');
  assert.equal(log.splits[0].planner, 'agy');
  assert.equal(defaultLogged(log.lines), false);
});

test('plan only, agy planner: a family the live list lacks falls back to the agy default, logged', async (t) => {
  const { orch, log } = setup();
  t.after(() => orch.kill && orch.kill());
  const res = await orch.makePlanRun(ctx({ plannerAgyModel: 'agy-hydrogen' }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal('model' in log.splits[0], false);
  assert.ok(log.lines.some((l) => /agy planner model agy-hydrogen is not in the live/.test(l)));
  assert.ok(defaultLogged(log.lines));
});

test('plan only, agy planner: no saved model (agy default) never reads the live list, logged', async (t) => {
  const { orch, log, agyModels } = setup();
  t.after(() => orch.kill && orch.kill());
  const res = await orch.makePlanRun(ctx());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal('model' in log.splits[0], false);
  assert.equal(agyModels.calls.ensure, 0);
  assert.ok(defaultLogged(log.lines));
});

test('plan only, Claude and Free planners: the split call is unchanged, even with a stray agy model', async (t) => {
  for (const planner of ['claude', 'free']) {
    const { orch, log, agyModels } = setup();
    t.after(() => orch.kill && orch.kill());
    const res = await orch.makePlanRun(ctx({ planner, plannerAgyModel: 'agy-argon' }));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(log.splits[0], { cwd: '/repo', env: { E: '1' }, request: 'Plan the auth redesign', planner });
    assert.equal(agyModels.calls.ensure, 0);
    assert.equal(defaultLogged(log.lines), false);
  }
});

// --- runTopicSplit: the model becomes agy's --model -------------------------

function fakeExec(record) {
  return (bin, args, opts, cb) => {
    record.push({ bin, args });
    setImmediate(() => cb(null, JSON.stringify({ topics: TOPICS }), ''));
    return { stdin: { on: () => {}, end: () => {} } };
  };
}

test('runTopicSplit, agy: a checked model id is passed as --model; none = no --model', async () => {
  const withModel = [];
  const res = await runTopicSplit({ cwd: os.tmpdir(), env: {}, request: 'plan it', planner: 'agy', model: 'gemini-4-argon-high', execImpl: fakeExec(withModel) });
  assert.equal(res.ok, true, JSON.stringify(res));
  const args = withModel[0].args;
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-4-argon-high');
  assert.equal(args.includes('--print'), false);

  const without = [];
  await runTopicSplit({ cwd: os.tmpdir(), env: {}, request: 'plan it', planner: 'agy', execImpl: fakeExec(without) });
  assert.equal(without[0].args.includes('--model'), false);
});

// --- orchestra:planRun:start reads the saved pref for agy only ---------------

function ipcSetup(prefs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-planonly-ipc-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const handlers = new Map();
  const calls = [];
  const controller = {
    view: () => null,
    planWait: () => null,
    isRunning: () => false,
    isBusy: () => false,
    repoPath: () => repo,
    planningRepo: () => null,
    ownsSession: () => false,
    async makePlanRun(c) {
      calls.push(c);
      return { ok: true, plan: { id: 'run1', projectId: c.projectId, packages: [], planRun: { docs: [] } } };
    },
  };
  registerOrchestraIpc(
    { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
    {
      registry: createOrchestraRegistry({ makeController: () => controller }),
      projects: () => [{ id: 'alpha', path: repo }],
      activeProjectId: () => 'alpha',
      resolveSession: (id) => (id === 'tab-a' ? { id: 'tab-a', projectId: 'alpha', repo } : null),
      repoFor: () => repo,
      toolEnv: () => ({ PATH: 'tool' }),
      planRunEnv: () => ({ ANTHROPIC_MODEL: 'auto:easy' }),
      agyPlannerEnv: () => ({ AGY: '1' }),
      maxTodoItems: 5,
      godModeBlock: () => null,
      send: () => {},
      playCue: () => {},
      openExternal: () => {},
      openPath: async () => '',
      runsDir: () => root,
      readUiPrefs: () => prefs,
      writeUiPrefs: () => {},
    },
  );
  const start = (planner) => handlers.get('orchestra:planRun:start')({}, { request: 'plan it', planner, sessionId: 'tab-a' });
  return { start, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('planRun:start: the agy planner carries the saved agy model; Claude / Free never do', async (t) => {
  const s = ipcSetup({ orchestraPlannerAgyModel: 'agy-neon' });
  t.after(s.cleanup);
  await s.start('agy');
  await s.start('claude');
  await s.start('free');
  assert.equal(s.calls[0].plannerAgyModel, 'agy-neon');
  assert.equal(s.calls[0].planner, 'agy');
  assert.equal('plannerAgyModel' in s.calls[1], false);
  assert.equal('plannerAgyModel' in s.calls[2], false);
});

test('planRun:start: no saved model or a non-agy value passes no agy model (agy default)', async (t) => {
  for (const saved of [null, 'opus', 'agy:../evil', 42]) {
    const s = ipcSetup({ orchestraPlannerAgyModel: saved });
    t.after(s.cleanup);
    await s.start('agy');
    assert.equal('plannerAgyModel' in s.calls[0], false, String(saved));
  }
});
