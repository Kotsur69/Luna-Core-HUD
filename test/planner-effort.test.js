// ============================================================================
// God Mode v2 planner effort, picked per plan in the to-do picker: the caps
// table, the planner argv / timeout per level, the fallback to high, the level
// carried through makePlan's ctx (limit-wait and account-failover replans),
// the board view, the stored plan and the ui pref.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { EFFORTS } = require('../src/efforts.js');
const {
  PLANNER_CAPS,
  PLANNER_EFFORT,
  plannerCaps,
  plannerEffortOf,
  buildPlannerArgs,
  runPlanner,
} = require('../src/orchestraPlan.js');
const { createOrchestra } = require('../src/orchestra.js');
const sup = require('../src/orchestraSupervisor.js');
const paths = require('../src/paths.js');
const uiprefs = require('../src/uiprefs.js');

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];
const MIN = 60 * 1000;

// ---- caps table / argv ----------------------------------------------------------

test('PLANNER_CAPS: one budget + timeout per level, above the headless startup cost', () => {
  assert.deepEqual(Object.keys(PLANNER_CAPS), [...EFFORTS]);
  assert.deepEqual(PLANNER_CAPS.medium, { budgetUsd: 4, timeoutMs: 10 * MIN });
  assert.deepEqual(PLANNER_CAPS.high, { budgetUsd: 6, timeoutMs: 15 * MIN });
  assert.deepEqual(PLANNER_CAPS.xhigh, { budgetUsd: 8, timeoutMs: 20 * MIN });
  assert.deepEqual(PLANNER_CAPS.max, { budgetUsd: 12, timeoutMs: 30 * MIN });
  assert.ok(Object.isFrozen(PLANNER_CAPS) && Object.isFrozen(PLANNER_CAPS.high));
});

test('plannerEffortOf / plannerCaps: anything but the four levels is high', () => {
  assert.equal(PLANNER_EFFORT, 'high');
  for (const level of EFFORTS) assert.equal(plannerEffortOf(level), level);
  for (const bad of ['low', 'HIGH', '', null, undefined, 3, { level: 'max' }]) {
    assert.equal(plannerEffortOf(bad), 'high');
    assert.deepEqual(plannerCaps(bad), PLANNER_CAPS.high);
  }
});

test('buildPlannerArgs: --effort and --max-budget-usd follow the level', () => {
  for (const level of EFFORTS) {
    const argv = buildPlannerArgs({ effort: level });
    assert.equal(flagValue(argv, '--effort'), level);
    assert.equal(flagValue(argv, '--max-budget-usd'), String(PLANNER_CAPS[level].budgetUsd));
  }
  const fallback = buildPlannerArgs({ effort: 'low' });
  assert.equal(flagValue(fallback, '--effort'), 'high');
  assert.equal(flagValue(fallback, '--max-budget-usd'), '6');
  assert.equal(flagValue(buildPlannerArgs(), '--effort'), 'high');
  assert.equal(flagValue(buildPlannerArgs({ effort: 'max', budgetUsd: 1 }), '--max-budget-usd'), '1', 'explicit budget wins');
});

// ---- runPlanner -----------------------------------------------------------------

function fakeExec() {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    setImmediate(() => cb(null, JSON.stringify({ structured_output: { packages: [] }, total_cost_usd: 0 })));
    return { stdin: { on() {}, end() {} } };
  };
  return { exec, calls };
}

test('runPlanner spawns claude with the level, its budget and its timeout', async () => {
  for (const level of EFFORTS) {
    const { exec, calls } = fakeExec();
    await runPlanner({ isDirImpl: () => true, cwd: 'C:/repo', env: {}, openTodos: [], effort: level, execImpl: exec });
    assert.equal(flagValue(calls[0].args, '--effort'), level);
    assert.equal(flagValue(calls[0].args, '--max-budget-usd'), String(PLANNER_CAPS[level].budgetUsd));
    assert.equal(calls[0].opts.timeout, PLANNER_CAPS[level].timeoutMs);
  }
});

test('runPlanner without or with a bad effort plans at high', async () => {
  for (const effort of [undefined, 'low', 42]) {
    const { exec, calls } = fakeExec();
    await runPlanner({ isDirImpl: () => true, cwd: 'C:/repo', env: {}, openTodos: [], effort, execImpl: exec });
    assert.equal(flagValue(calls[0].args, '--effort'), 'high');
    assert.equal(calls[0].opts.timeout, 15 * MIN);
  }
});

// ---- makePlan: ctx -> runPlanner, replans, view -----------------------------------

const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const spentLimits = [
  { window: '5h', percentUsed: 100, resetsAt: iso(NOW + 30 * MIN) },
  { window: 'weekly', percentUsed: 30, resetsAt: iso(NOW + 3 * 86400e3) },
];
const goodPlan = {
  ok: true,
  raw: { packages: [{ id: 'a', title: 'A', todoAts: [1], prompt: 'do', files: [], dependsOn: [], verify: 'npm test', model: 'sonnet' }], notes: '' },
  costUsd: 0.1,
};

function fakeClock() {
  let t = NOW;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { fn, at: t + ms });
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        await due[1].fn();
        for (let i = 0; i < 20; i += 1) await new Promise(setImmediate);
      }
      t = end;
    },
  };
}

function orchestraWith(results, extra = {}) {
  const clock = fakeClock();
  const efforts = [];
  const orch = createOrchestra({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    readTodos: () => [{ at: 1, text: 'one', done: false }],
    dirtyCount: async () => 0,
    runPlanner: async (args) => {
      efforts.push(args.effort);
      return results.shift();
    },
    addWorktree: async () => ({ ok: false }),
    briefDir: () => '/cfg',
    writeBrief: () => true,
    createSession: () => ({ id: 's1' }),
    ...extra,
  });
  return { orch, clock, efforts };
}

const ctx = { projectId: 'p1', repoPath: '/repo', profileId: 'claude-cloud', env: {} };

test('makePlan hands ctx.plannerEffort to the planner and records it on the plan', async () => {
  const { orch, efforts } = orchestraWith([goodPlan]);
  const res = await orch.makePlan({ ...ctx, plannerEffort: 'xhigh' });
  assert.equal(res.ok, true);
  assert.deepEqual(efforts, ['xhigh']);
  assert.equal(orch.view().plannerEffort, 'xhigh');
});

test("makePlan without plannerEffort (Luna's Work) or with a bad one plans at high", async () => {
  for (const plannerEffort of [undefined, 'low', 'max; rm -rf /']) {
    const { orch, efforts } = orchestraWith([goodPlan]);
    await orch.makePlan(plannerEffort === undefined ? ctx : { ...ctx, plannerEffort });
    assert.deepEqual(efforts, ['high']);
    assert.equal(orch.view().plannerEffort, 'high');
  }
});

test('a usage-limit replan keeps the chosen effort', async () => {
  const { orch, clock, efforts } = orchestraWith([{ ok: false, error: 'limit' }, goodPlan], { usageLimits: () => spentLimits });
  const res = await orch.makePlan({ ...ctx, plannerEffort: 'max' });
  assert.equal(res.error, 'waiting');
  await clock.advance(2 * 3600e3);
  assert.deepEqual(efforts, ['max', 'max']);
  assert.equal(orch.view().plannerEffort, 'max');
});

test('an account-failover replan keeps the chosen effort with a fresh env', async () => {
  const { orch, clock, efforts } = orchestraWith([{ ok: false, error: 'limit' }, goodPlan], {
    usageLimits: () => spentLimits,
    accountFailover: () => true,
    freshEnv: () => ({ ACCOUNT: 'b' }),
  });
  const res = await orch.makePlan({ ...ctx, plannerEffort: 'medium' });
  assert.equal(res.error, 'waiting');
  assert.equal(res.planWait.source, 'account');
  await clock.advance(MIN);
  assert.deepEqual(efforts, ['medium', 'medium']);
  assert.equal(orch.view().plannerEffort, 'medium');
});

test('a stored plan keeps a valid plannerEffort, anything else becomes null', () => {
  const raw = { id: 'p1', repoPath: path.resolve('/repo'), packages: [{ id: 'a', state: 'pending' }] };
  assert.equal(sup.normalizeStoredPlan({ ...raw, plannerEffort: 'xhigh' }).plannerEffort, 'xhigh');
  assert.equal(sup.normalizeStoredPlan({ ...raw, plannerEffort: 'low' }).plannerEffort, null);
  assert.equal(sup.normalizeStoredPlan(raw).plannerEffort, null);
});

// ---- ui pref orchestraPlannerEffort -------------------------------------------------

test('ui pref orchestraPlannerEffort: default high, only the four levels are stored', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-planner-effort-'));
  const origLocal = paths.local;
  const origEnsure = paths.ensureUserDir;
  paths.local = (name) => path.join(dir, name);
  paths.ensureUserDir = () => {};
  t.after(() => {
    paths.local = origLocal;
    paths.ensureUserDir = origEnsure;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  assert.equal(uiprefs.readUiPrefs().orchestraPlannerEffort, 'high', 'missing file -> default');
  assert.equal(uiprefs.writeUiPrefs({ orchestraPlannerEffort: 'max' }).orchestraPlannerEffort, 'max');
  assert.equal(uiprefs.readUiPrefs().orchestraPlannerEffort, 'max');
  for (const bad of ['low', 'plan', 'MAX', '', null, 7]) {
    assert.equal(uiprefs.writeUiPrefs({ orchestraPlannerEffort: bad }).orchestraPlannerEffort, 'max', `rejects ${String(bad)}`);
  }
  // A hand-edited file with a bad level reads back as the default.
  const file = path.join(dir, 'ui.local.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...stored, orchestraPlannerEffort: 'low' }), 'utf8');
  assert.equal(uiprefs.readUiPrefs().orchestraPlannerEffort, 'high');
});
