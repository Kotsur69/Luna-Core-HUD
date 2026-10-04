// ============================================================================
// God Mode v2 planner (ORCHESTRATOR_PLAN.md slice 3): argv, envelope parsing,
// plan validation (the trust boundary) and the pre-launch estimate.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugId,
  buildPlannerArgs,
  buildPlannerPrompt,
  parsePlannerOutput,
  validatePlan,
  estimatePlan,
  runPlanner,
  PLAN_SCHEMA,
} = require('../src/orchestraPlan.js');

const todo = (at, text, extra = {}) => ({ at, text, done: false, ...extra });
const pkg = (id, todoAts, extra = {}) => ({
  id,
  title: `T ${id}`,
  todoAts,
  prompt: `do ${id}`,
  files: [],
  dependsOn: [],
  verify: 'npm test',
  model: 'sonnet',
  ...extra,
});

// ---- argv / prompt ------------------------------------------------------------

test('buildPlannerArgs: headless, schema-bound, read-only, capped - prompt not in argv', () => {
  const args = buildPlannerArgs();
  assert.equal(args[0], '-p');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), PLAN_SCHEMA);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.ok(Number(args[args.indexOf('--max-budget-usd') + 1]) > 0);
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args.length % 2, 0, 'every flag but -p/--no-session-persistence has a value');
});

test('buildPlannerPrompt carries the cards as JSON, card fields included', () => {
  const prompt = buildPlannerPrompt([todo(7, 'fix it', { files: ['a.js'], size: 'S', junk: 1 })]);
  const json = JSON.parse(prompt.slice(prompt.indexOf('[')));
  assert.deepEqual(json, [{ at: 7, text: 'fix it', files: ['a.js'], size: 'S' }]);
});

test('slugId keeps ids branch- and folder-safe', () => {
  assert.equal(slugId('Fix Drag/Scroll!'), 'fix-drag-scroll');
  assert.equal(slugId('../..'), '');
  assert.equal(slugId(42), '');
  assert.equal(slugId('x'.repeat(40)).length, 24);
});

// ---- envelope -------------------------------------------------------------------

test('parsePlannerOutput prefers structured_output, falls back to result', () => {
  const raw = { packages: [], notes: '' };
  assert.deepEqual(parsePlannerOutput(JSON.stringify({ structured_output: raw, total_cost_usd: 0.5 })), {
    ok: true,
    raw,
    costUsd: 0.5,
  });
  assert.deepEqual(parsePlannerOutput(JSON.stringify({ result: JSON.stringify(raw) })).raw, raw);
});

test('parsePlannerOutput: errors, budget, junk', () => {
  assert.equal(parsePlannerOutput('nope').error, 'badJson');
  assert.equal(parsePlannerOutput(JSON.stringify({ result: 'not json' })).error, 'badJson');
  assert.equal(parsePlannerOutput(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd' })).error, 'budget');
  assert.equal(parsePlannerOutput(JSON.stringify({ is_error: true, result: 'boom' })).error, 'failed');
});

// ---- validatePlan -----------------------------------------------------------------

test('validatePlan normalizes a good plan and orders it by dependencies', () => {
  const todos = [todo(1, 'one'), todo(2, 'two')];
  const out = validatePlan(
    { packages: [pkg('b', [2], { dependsOn: ['a'] }), pkg('a', [1], { model: 'gpt' })], notes: ' why ' },
    todos,
  );
  assert.deepEqual(out.packages.map((p) => p.id), ['a', 'b']);
  assert.equal(out.packages[0].model, null, 'unknown model dropped');
  assert.equal(out.notes, 'why');
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(out.errors, []);
});

test('validatePlan: duplicate ids, unknown and double-claimed to-dos, uncovered ones', () => {
  const todos = [todo(1, 'one'), todo(2, 'two'), todo(3, 'three')];
  const out = validatePlan(
    { packages: [pkg('a', [1, 99]), pkg('a', [2]), pkg('c', [1]), pkg('d', [], { prompt: '  ' })] },
    todos,
  );
  assert.deepEqual(out.packages.map((p) => p.id), ['a', 'c']);
  const codes = out.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['dupPackage', 'duplicateTodo', 'emptyPrompt', 'noTodos', 'uncovered', 'unknownTodo']);
  assert.deepEqual(out.warnings.find((w) => w.code === 'uncovered').texts, ['two', 'three']);
});

test('validatePlan drops unknown and self dependencies', () => {
  const out = validatePlan({ packages: [pkg('a', [1], { dependsOn: ['a', 'ghost'] })] }, [todo(1, 'x')]);
  assert.deepEqual(out.packages[0].dependsOn, []);
  assert.equal(out.warnings.filter((w) => w.code === 'unknownDep').length, 2);
});

test('validatePlan: a dependency cycle is an error, not a warning', () => {
  const out = validatePlan(
    { packages: [pkg('a', [1], { dependsOn: ['b'] }), pkg('b', [2], { dependsOn: ['a'] })] },
    [todo(1, 'x'), todo(2, 'y')],
  );
  assert.deepEqual(out.errors, [{ code: 'cycle', ids: ['a', 'b'] }]);
});

test('validatePlan warns on file overlap only between packages that can run at once', () => {
  const todos = [todo(1, 'x'), todo(2, 'y'), todo(3, 'z')];
  const out = validatePlan(
    {
      packages: [
        pkg('a', [1], { files: ['src/x.js'] }),
        pkg('b', [2], { files: ['src/x.js', 'src/y.js'] }),
        pkg('c', [3], { files: ['src/x.js'], dependsOn: ['a', 'b'] }),
      ],
    },
    todos,
  );
  const overlaps = out.warnings.filter((w) => w.code === 'overlap');
  assert.deepEqual(overlaps, [{ code: 'overlap', a: 'a', b: 'b', files: ['src/x.js'] }]);
});

test('validatePlan survives junk', () => {
  for (const raw of [null, 'x', { packages: 'no' }, { packages: [null, 5] }]) {
    const out = validatePlan(raw, [todo(1, 'x')]);
    assert.deepEqual(out.packages, []);
    assert.deepEqual(out.errors, [{ code: 'empty' }]);
  }
});

// ---- estimate ------------------------------------------------------------------

test('estimatePlan: parallel packages share the wall clock, capped by maxParallel', () => {
  const todos = [todo(1, 'a', { size: 'S' }), todo(2, 'b', { size: 'L' }), todo(3, 'c'), todo(4, 'd', { size: 'S' })];
  const packages = [pkg('a', [1]), pkg('b', [2]), pkg('c', [3]), pkg('d', [4])];
  // S=20, L=90, M=45, S=20 with 3 workers: a(0-20) b(0-90) c(0-45), d(20-40) -> 90.
  assert.deepEqual(estimatePlan(packages, todos, 3), { workers: 3, wallMinutes: 90, workMinutes: 175 });
  assert.equal(estimatePlan(packages, todos, 1).wallMinutes, 175, 'one worker = sum');
});

test('estimatePlan: a dependency chain runs end to end', () => {
  const todos = [todo(1, 'a', { size: 'S' }), todo(2, 'b', { size: 'S' })];
  const packages = [pkg('a', [1]), pkg('b', [2], { dependsOn: ['a'] })];
  assert.deepEqual(estimatePlan(packages, todos, 3), { workers: 1, wallMinutes: 40, workMinutes: 40 });
});

// ---- runPlanner (fake exec) ----------------------------------------------------------

function fakeExec(reply) {
  const calls = [];
  const exec = (file, args, opts, cb) => {
    const call = { file, args, opts, stdin: '' };
    calls.push(call);
    setImmediate(() => cb(reply.error || null, reply.stdout || ''));
    return { stdin: { on() {}, end: (text) => { call.stdin = text; } } };
  };
  return { exec, calls };
}

test('runPlanner feeds the prompt on stdin, in the repo folder', async () => {
  const { exec, calls } = fakeExec({ stdout: JSON.stringify({ structured_output: { packages: [] }, total_cost_usd: 1 }) });
  const res = await runPlanner({ cwd: 'C:/repo', env: { A: '1' }, openTodos: [todo(1, 'x')], execImpl: exec });
  assert.equal(res.ok, true);
  assert.equal(res.costUsd, 1);
  assert.equal(calls[0].file, 'claude');
  assert.equal(calls[0].opts.cwd, 'C:/repo');
  assert.match(calls[0].stdin, /"text": "x"/);
});

test('runPlanner maps process failures', async () => {
  const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
  const killed = Object.assign(new Error('x'), { killed: true });
  const exit1 = Object.assign(new Error('exit 1'), { code: 1 });
  assert.equal((await runPlanner({ openTodos: [], execImpl: fakeExec({ error: enoent }).exec })).error, 'noClaude');
  assert.equal((await runPlanner({ openTodos: [], execImpl: fakeExec({ error: killed }).exec })).error, 'timeout');
  assert.equal((await runPlanner({ openTodos: [], execImpl: fakeExec({ error: exit1 }).exec })).error, 'failed');
  const budget = fakeExec({ error: exit1, stdout: JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd' }) });
  assert.equal((await runPlanner({ openTodos: [], execImpl: budget.exec })).error, 'budget', 'envelope beats exit code');
});
