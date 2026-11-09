// ============================================================================
// Free God Mode v2 Slice F6a (docs/tbc_docs/FREE_GODMODE_V2_PLAN.md): the
// "Workers" selector. Hybrid ("Plan with free models in mind") adds "free"
// to the planner's per-package model; a Claude-only run stays byte-for-byte
// what it was; the old "Free providers" tick migrates.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plan = require('../src/orchestraPlan.js');
const workers = require('../src/orchestraWorkers.js');
const sup = require('../src/orchestraSupervisor.js');
const { runPlan } = require('../src/orchestraPlanStart.js');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const todo = (at, text, extra = {}) => ({ at, text, done: false, ...extra });
const TODOS = [todo(1, 'Fix the header colour'), todo(2, 'Add login', { effort: 'high' })];
const modelEnum = (schema) => schema.properties.packages.items.properties.model.enum;
const schemaArg = (args) => args[args.indexOf('--json-schema') + 1];

function fakeExec() {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    const call = { file, args, opts, stdin: '' };
    calls.push(call);
    setImmediate(() => cb(null, JSON.stringify({ structured_output: { packages: [] }, total_cost_usd: 0 })));
    return { stdin: { on() {}, end: (text) => { call.stdin = text; } } };
  };
  return { exec, calls };
}

const planOnce = async (opts) => {
  const { exec, calls } = fakeExec();
  await plan.runPlanner({ isDirImpl: () => true, cwd: 'C:/repo', openTodos: TODOS, execImpl: exec, ...opts });
  return calls[0];
};

// ---- schema -------------------------------------------------------------------

test('schema without hybrid: model is opus / sonnet only', () => {
  assert.deepEqual(modelEnum(plan.PLAN_SCHEMA), ['sonnet', 'opus']);
  assert.equal(plan.planSchemaFor(false), plan.PLAN_SCHEMA);
  assert.equal(plan.planSchemaFor(undefined), plan.PLAN_SCHEMA);
  assert.equal(plan.planSchemaFor('true'), plan.PLAN_SCHEMA, 'only exactly true turns hybrid on');
  assert.ok(!JSON.stringify(plan.PLAN_SCHEMA).includes('"free"'));
});

test('schema with hybrid: model gains "free", the rest is the same schema', () => {
  assert.deepEqual(modelEnum(plan.planSchemaFor(true)), ['sonnet', 'opus', 'free']);
  const strip = (schema) => JSON.parse(JSON.stringify(schema), (k, v) => (k === 'model' ? null : v));
  assert.deepEqual(strip(plan.HYBRID_PLAN_SCHEMA), strip(plan.PLAN_SCHEMA));
  // The shared Claude schema object is never mutated by building the hybrid one.
  assert.deepEqual(modelEnum(plan.PLAN_SCHEMA), ['sonnet', 'opus']);
});

test('buildPlannerArgs: --json-schema follows the hybrid flag', () => {
  assert.equal(schemaArg(plan.buildPlannerArgs()), JSON.stringify(plan.PLAN_SCHEMA));
  assert.equal(schemaArg(plan.buildPlannerArgs({ hybrid: true })), JSON.stringify(plan.HYBRID_PLAN_SCHEMA));
});

// ---- prompt -------------------------------------------------------------------

test('hybrid prompt: the "free" rule - small, mechanical, 1-2 files, when in doubt sonnet', () => {
  const text = plan.buildPlannerPrompt(TODOS, { hybrid: true });
  assert.match(text, /"model": "free" is also allowed/);
  assert.match(text, /styling, layout, copy, i18n strings, a config value/);
  assert.match(text, /in 1-2 files/);
  assert.match(text, /no logic, state, IPC, security, data or build changes/);
  assert.match(text, /When in doubt: "sonnet"/);
});

test('Claude-only prompt never mentions the free model', () => {
  const text = plan.buildPlannerPrompt(TODOS);
  assert.ok(!/"free"/.test(text));
  assert.equal(plan.buildPlannerPrompt(TODOS, { hybrid: false }), text);
});

// ---- Claude-only run: byte-for-byte unchanged ----------------------------------

// Hashes of the Claude-only argv, prompt and schema taken from the planner
// before Slice F6 (commit d0277a0). Any drift fails here.
const PRE_F6 = {
  args: '1a5a6a6ed0ef6212132060042d415b11a465e5bef5ec0e731ab3d39ef2e94e83',
  prompt: 'f60c4f58b4aec53a5bfa36b960cb64e49825512a389adee78cab05eba04be0c7',
  schema: '7bd3bd70025be36c866b7a79ea900a29b61a32768290f1b95e96a6227236ef89',
};

test('Claude-only run is byte-for-byte the pre-F6 planner call', async () => {
  assert.equal(sha(JSON.stringify(plan.buildPlannerArgs())), PRE_F6.args);
  assert.equal(sha(plan.buildPlannerPrompt(TODOS)), PRE_F6.prompt);
  assert.equal(sha(JSON.stringify(plan.PLAN_SCHEMA)), PRE_F6.schema);
  // And through runPlanner: no hybrid flag = the same argv and stdin.
  const call = await planOnce({});
  assert.equal(sha(JSON.stringify(call.args)), PRE_F6.args);
  assert.equal(sha(call.stdin), PRE_F6.prompt);
  const off = await planOnce({ hybrid: false });
  assert.deepEqual(off.args, call.args);
  assert.equal(off.stdin, call.stdin);
});

test('runPlanner hybrid: free in the schema and the prompt rule on stdin', async () => {
  const call = await planOnce({ hybrid: true });
  assert.deepEqual(modelEnum(JSON.parse(schemaArg(call.args))), ['sonnet', 'opus', 'free']);
  assert.match(call.stdin, /"model": "free" is also allowed/);
});

test('runPlanner: the free planner never plans a hybrid run', async () => {
  const call = await planOnce({ hybrid: true, planner: 'free' });
  assert.ok(!schemaArg(call.args).includes('"free"'));
  assert.ok(!call.stdin.includes('"model": "free"'));
});

// ---- validation -----------------------------------------------------------------

test('validatePlan: "free" is a valid model only in a hybrid plan', () => {
  const raw = {
    packages: [{ id: 'css', title: 'CSS', todoAts: [1], prompt: 'p', files: ['a.css'], verify: 'npm test', model: 'free' }],
  };
  assert.equal(plan.validatePlan(raw, TODOS).packages[0].model, null);
  assert.equal(plan.validatePlan(raw, TODOS, { hybrid: true }).packages[0].model, 'free');
});

// ---- Workers rules ---------------------------------------------------------------

test('planWorkers: a free planner always plans free-only; junk is Claude only', () => {
  assert.equal(workers.planWorkers('hybrid', 'claude'), 'hybrid');
  assert.equal(workers.planWorkers('hybrid', 'free'), 'free');
  assert.equal(workers.planWorkers('claude', 'free'), 'free');
  assert.equal(workers.planWorkers('nope', 'claude'), 'claude');
  assert.equal(workers.planWorkers(undefined, 'claude'), 'claude');
});

test('approveWorkers: hybrid only for a hybrid-planned plan; the old free tick still works', () => {
  assert.equal(workers.approveWorkers({}, { workers: 'hybrid' }), 'claude');
  assert.equal(workers.approveWorkers({ workers: 'hybrid' }, { workers: 'hybrid' }), 'hybrid');
  assert.equal(workers.approveWorkers({ workers: 'hybrid' }, {}), 'hybrid', 'nothing asked keeps the plan choice');
  assert.equal(workers.approveWorkers({ workers: 'hybrid' }, { workers: 'claude' }), 'claude');
  assert.equal(workers.approveWorkers({}, { free: true }), 'free', 'an older renderer sends the tick');
  assert.equal(workers.approveWorkers({}, { free: false }), 'claude');
  assert.equal(workers.approveWorkers({ buildPlanner: 'free' }, { workers: 'claude' }), 'free');
});

test('claudeModelOf: a free package runs on Sonnet until free workers take it', () => {
  assert.equal(workers.claudeModelOf('free'), 'sonnet');
  assert.equal(workers.claudeModelOf('opus'), 'opus');
  assert.equal(workers.claudeModelOf(null), null);
});

// ---- migration of the old "Free providers" tick ------------------------------------

test('stored state: a plan with only the old tick (freeMode) migrates to "free"', () => {
  assert.equal(workers.storedWorkers({ freeMode: true }), 'free');
  assert.equal(workers.storedWorkers({ buildPlanner: 'free' }), 'free');
  assert.equal(workers.storedWorkers({ freeMode: false }), 'claude');
  assert.equal(workers.storedWorkers({ workers: 'hybrid' }), 'hybrid');
  assert.equal(workers.storedWorkers({ workers: 'bogus', freeMode: true }), 'free');
  assert.equal(workers.storedWorkers(null), 'claude');
  const raw = { id: 'p1', repoPath: path.resolve('/repo'), packages: [{ id: 'a', state: 'pending' }] };
  assert.equal(sup.normalizeStoredPlan({ ...raw, freeMode: true }).workers, 'free');
  assert.equal(sup.normalizeStoredPlan({ ...raw, workers: 'hybrid' }).workers, 'hybrid');
  assert.ok(!('workers' in sup.normalizeStoredPlan(raw)), 'a Claude-only plan carries no key, as before');
});

test('stored package: the guard reason survives a restart, junk is dropped', () => {
  const raw = { id: 'p1', repoPath: path.resolve('/repo'), workers: 'hybrid', packages: [
    { id: 'a', state: 'pending', model: 'sonnet', hybridGuard: { from: 'free', reasons: [{ code: 'tooManyFiles', n: 3 }, { code: 'bogus' }] } },
    { id: 'b', state: 'pending', model: 'free', hybridGuard: { from: 'x', reasons: [] } },
  ] };
  const stored = sup.normalizeStoredPlan(raw);
  assert.deepEqual(stored.packages[0].hybridGuard, { from: 'free', reasons: [{ code: 'tooManyFiles', n: 3 }] });
  assert.ok(!('hybridGuard' in stored.packages[1]));
});

test('ui pref: the old boolean orchestraFree tick migrates to orchestraWorkers', () => {
  assert.equal(workers.workersPrefOf({ orchestraFree: true }), 'free');
  assert.equal(workers.workersPrefOf({ orchestraFree: false }), 'claude');
  assert.equal(workers.workersPrefOf({ orchestraWorkers: 'hybrid', orchestraFree: true }), 'hybrid');
  assert.equal(workers.workersPrefOf({ orchestraWorkers: 'nope' }), 'claude');
  assert.equal(workers.workersPrefOf(null), 'claude');
});

test('uiprefs file: an old prefs file with the tick reads as "free"; writes are validated', (t) => {
  const paths = require('../src/paths.js');
  const uiprefs = require('../src/uiprefs.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-workers-'));
  const origLocal = paths.local;
  const origEnsure = paths.ensureUserDir;
  paths.local = (name) => path.join(dir, name);
  paths.ensureUserDir = () => {};
  t.after(() => {
    paths.local = origLocal;
    paths.ensureUserDir = origEnsure;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const file = path.join(dir, 'ui.local.json');
  fs.writeFileSync(file, JSON.stringify({ orchestraFree: true }));
  assert.equal(uiprefs.readUiPrefs().orchestraWorkers, 'free');
  fs.writeFileSync(file, JSON.stringify({}));
  assert.equal(uiprefs.readUiPrefs().orchestraWorkers, 'claude');
  uiprefs.writeUiPrefs({ orchestraWorkers: 'hybrid' });
  assert.equal(uiprefs.readUiPrefs().orchestraWorkers, 'hybrid');
  uiprefs.writeUiPrefs({ orchestraWorkers: 'everything' });
  assert.equal(uiprefs.readUiPrefs().orchestraWorkers, 'hybrid', 'an unknown value is ignored');
});

// ---- planning request (orchestra:plan -> makePlan) -----------------------------------

function planCtx() {
  const seen = [];
  return {
    seen,
    ctx: {
      toolEnv: () => ({ A: '1' }),
      freePlannerEnv: () => ({ F: '1' }),
      send: () => {},
      registry: { ensure: () => ({ makePlan: async (args) => { seen.push(args); return { ok: false, error: 'x' }; } }) },
    },
  };
}

test('runPlan: only "hybrid" reaches makePlan; Claude only passes no key', async () => {
  const session = { projectId: 'p', profileId: 'default' };
  const target = { projectId: 'p', repoPath: 'C:/repo' };
  const { seen, ctx } = planCtx();
  await runPlan(ctx, session, target, { picked: [1] });
  await runPlan(ctx, session, target, { picked: [1], workers: 'claude' });
  await runPlan(ctx, session, target, { picked: [1], workers: 'hybrid' });
  await runPlan(ctx, session, target, { picked: [1], workers: 'hybrid', planner: 'free' });
  await runPlan(ctx, session, target, { picked: [1], workers: { evil: true } });
  assert.ok(!('workers' in seen[0]));
  assert.ok(!('workers' in seen[1]));
  assert.equal(seen[2].workers, 'hybrid');
  assert.ok(!('workers' in seen[3]), 'a free planner plans free-only');
  assert.ok(!('workers' in seen[4]));
});
