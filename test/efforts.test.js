// ============================================================================
// God Mode worker effort levels (medium/high/xhigh/max): the shared constant,
// the --effort flag on worker / planner / resolver starts, card + planner
// normalization, the Settings pref and v1's /effort step. Never `low`.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EFFORTS, isEffort, normalizeEffort, nextEffort } = require('../src/efforts.js');
const { withTaskBrief } = require('../src/launch.js');
const { validatePlan, buildPlannerArgs, buildPlannerPrompt, PLAN_SCHEMA, PLANNER_EFFORT } = require('../src/orchestraPlan.js');
const { normalizeTodo } = require('../src/todorows.js');
const { workerEffortOf } = require('../src/uiprefs.js');
const { TOOLS } = require('../src/intake.js');
const integ = require('../src/orchestraIntegrate.js');
const sup = require('../src/orchestraSupervisor.js');
const { effortStep } = require('../src/renderer/modules/godmode.js');

const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('EFFORTS is the four levels, medium first, never low', () => {
  assert.deepEqual([...EFFORTS], ['medium', 'high', 'xhigh', 'max']);
  assert.equal(isEffort('low'), false);
  assert.equal(normalizeEffort('low'), null);
  assert.equal(normalizeEffort('HIGH'), null);
  assert.equal(normalizeEffort('xhigh'), 'xhigh');
});

test('nextEffort steps up one level and caps at max', () => {
  assert.equal(nextEffort('medium'), 'high');
  assert.equal(nextEffort('high'), 'xhigh');
  assert.equal(nextEffort('xhigh'), 'max');
  assert.equal(nextEffort('max'), 'max');
  assert.equal(nextEffort(null), 'high', 'unknown counts as medium');
  assert.equal(nextEffort('low'), 'high');
});

test('withTaskBrief appends --effort for the four levels only', () => {
  const brief = { briefPath: '/t/a.md' };
  assert.match(withTaskBrief('claude', { ...brief, effort: 'high' }), / --effort high($| )/);
  assert.match(withTaskBrief('claude', { ...brief, effort: 'max' }), / --effort max($| )/);
  assert.doesNotMatch(withTaskBrief('claude', { ...brief, effort: 'low' }), /--effort/);
  assert.doesNotMatch(withTaskBrief('claude', { ...brief, effort: 'high; rm -rf /' }), /--effort/);
  assert.doesNotMatch(withTaskBrief('claude', brief), /--effort/);
});

test('withTaskBrief keeps the profile own --effort (profile wins)', () => {
  const cmd = withTaskBrief('claude --effort xhigh', { briefPath: '/t/a.md', effort: 'medium' });
  assert.equal((cmd.match(/--effort/g) || []).length, 1);
  assert.doesNotMatch(cmd, /--effort medium/);
  const eq = withTaskBrief('claude --effort=max', { briefPath: '/t/a.md', effort: 'medium' });
  assert.doesNotMatch(eq, /--effort medium/);
});

test('planner: schema requires effort, args pass --effort high', () => {
  const item = PLAN_SCHEMA.properties.packages.items;
  assert.ok(item.required.includes('effort'));
  assert.deepEqual(item.properties.effort.enum, [...EFFORTS]);
  assert.equal(PLANNER_EFFORT, 'high');
  assert.equal(flagValue(buildPlannerArgs(), '--effort'), 'high');
});

test('planner prompt shows the card effort and the effort rule', () => {
  const prompt = buildPlannerPrompt([{ at: 1, text: 'x', effort: 'xhigh' }]);
  assert.match(prompt, /"effort": "xhigh"/);
  assert.match(prompt, /"effort": the to-do/);
});

test('validatePlan keeps a valid effort; invalid or missing becomes null', () => {
  const todos = [1, 2, 3].map((at) => ({ at, text: `t${at}` }));
  const pkg = (id, at, effort) => ({ id, title: id, todoAts: [at], prompt: 'p', files: [], dependsOn: [], verify: '', model: 'opus', effort });
  const { packages } = validatePlan({ packages: [pkg('a', 1, 'max'), pkg('b', 2, 'low'), pkg('c', 3, undefined)], notes: '' }, todos);
  assert.deepEqual(packages.map((p) => p.effort), ['max', null, null]);
});

test('todorows: a valid card effort is kept, anything else is dropped', () => {
  assert.equal(normalizeTodo({ text: 'x', at: 1, effort: 'high' }).effort, 'high');
  assert.equal('effort' in normalizeTodo({ text: 'x', at: 1, effort: 'low' }), false);
  assert.equal('effort' in normalizeTodo({ text: 'x', at: 1, effort: 7 }), false);
  assert.equal('effort' in normalizeTodo({ text: 'x', at: 1 }), false, 'a plain item gains no key');
});

test('intake: luna_todo_add and luna_todo_update offer effort as the 4-level enum', () => {
  const add = TOOLS.find((t) => t.name === 'luna_todo_add').inputSchema.properties.tasks.items.properties;
  const update = TOOLS.find((t) => t.name === 'luna_todo_update').inputSchema.properties.patch.properties;
  assert.deepEqual(add.effort.enum, [...EFFORTS]);
  assert.deepEqual(update.effort.enum, [...EFFORTS]);
});

test('ui pref orchestraWorkerEffort: plan or one of the four, else rejected', () => {
  for (const v of ['plan', 'medium', 'high', 'xhigh', 'max']) assert.equal(workerEffortOf(v), v);
  for (const v of ['low', '', null, undefined, 3, 'MAX']) assert.equal(workerEffortOf(v), null);
});

test('merge resolver runs with --effort medium', async () => {
  const seen = [];
  const execImpl = (bin, argv, opts, cb) => {
    seen.push(argv);
    setImmediate(() => cb(null, '', ''));
    return { stdin: { on() {}, end() {} } };
  };
  await integ.runResolver({ cwd: '/wt', branch: 'luna/a', files: ['a.js'], isDirImpl: () => true }, execImpl);
  assert.equal(integ.RESOLVER_EFFORT, 'medium');
  assert.equal(flagValue(seen[0], '--effort'), 'medium');
});

test('a stored run keeps effort, effortOverride and workerEffort; bad values become null', () => {
  const raw = {
    id: 'p1',
    repoPath: '/repo',
    workerEffort: 'xhigh',
    packages: [
      { id: 'a', state: 'pending', effort: 'high', effortOverride: 'max' },
      { id: 'b', state: 'pending', effort: 'low', effortOverride: 'nope' },
    ],
  };
  const plan = sup.normalizeStoredPlan(raw);
  assert.equal(plan.workerEffort, 'xhigh');
  assert.deepEqual(plan.packages.map((p) => [p.effort, p.effortOverride]), [['high', 'max'], [null, null]]);
  assert.equal(sup.normalizeStoredPlan({ ...raw, workerEffort: 'plan' }).workerEffort, 'plan');
  assert.equal(sup.normalizeStoredPlan({ ...raw, workerEffort: 'low' }).workerEffort, null);
});

test('v1 effortStep: sent once on a fresh run, then only when the level changes', () => {
  assert.deepEqual(effortStep({ text: 'x' }, null), { level: 'medium', command: '/effort medium' });
  assert.equal(effortStep({ text: 'x' }, 'medium'), null);
  assert.equal(effortStep({ text: 'x', effort: 'low' }, 'medium'), null, 'invalid card effort runs on medium');
  assert.deepEqual(effortStep({ text: 'x', effort: 'xhigh' }, 'medium'), { level: 'xhigh', command: '/effort xhigh' });
  assert.equal(effortStep({ text: 'x', effort: 'xhigh' }, 'xhigh'), null);
});
