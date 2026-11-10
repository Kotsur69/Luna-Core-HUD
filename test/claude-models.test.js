// ============================================================================
// The selectable Claude models (src/claudeModels.js) and every allow-list
// built on them: Luna's Work role models, God Mode's worker / planner /
// package / card models, and the renderer's hand-kept copies. `fable` is a
// valid manual choice everywhere; no default moved and nothing automatic
// (the `auto` rule, the God Mode planner's own pick) ever chooses it.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const models = require('../src/claudeModels.js');
const rules = require('../src/lunasworkRules.js');
const plan = require('../src/orchestraPlan.js');
const uiprefs = require('../src/uiprefs.js');
const { packageModel } = require('../src/lunasworkBuild.js');
const { cleanCard } = require('../src/lunasworkRun.js');
const { modelLabel, contextLimitFor } = require('../src/models.js');
const { withTaskBrief } = require('../src/launch.js');

const src = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
/** The string literals of `const NAME = [...]` in a source file. */
const listIn = (text, name) => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(text);
  assert.ok(m, `${name} not found`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
};

test('claudeModels: four aliases weakest to strongest, each with a label', () => {
  assert.deepEqual([...models.CLAUDE_MODELS], ['haiku', 'sonnet', 'opus', 'fable']);
  assert.deepEqual(models.MODEL_LABELS, { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' });
  assert.ok(models.MODEL_RANK.fable > models.MODEL_RANK.opus && models.MODEL_RANK.opus > models.MODEL_RANK.sonnet);
  assert.equal(models.isClaudeModel('fable'), true);
  for (const bad of ['Fable', 'claude-fable-5-2', 'auto', 'plan', '', null, 5]) assert.equal(models.isClaudeModel(bad), false);
  assert.equal(models.strongerModel('opus', 'fable'), 'fable');
  assert.equal(models.strongerModel('haiku', null), 'haiku');
  assert.equal(models.strongerModel('gpt-5', undefined), null);
});

test("Luna's Work role models: fable is a valid choice, the defaults did not move", () => {
  assert.deepEqual(rules.MODEL_CHOICES, ['opus', 'sonnet', 'haiku', 'fable', 'auto']);
  assert.deepEqual(rules.DEFAULT_MODELS, {
    director: 'opus',
    builder: 'opus',
    playtester: 'sonnet',
    critic: 'opus',
    reviewer: 'sonnet',
    researcher: 'sonnet',
  });
  const all = Object.fromEntries(rules.ROLES.map((r) => [r, 'fable']));
  assert.deepEqual(rules.normalizeModels(all), all);
  for (const role of rules.ROLES) assert.deepEqual(rules.pickModel(role, all), { model: 'fable', reason: 'setting' });
  assert.deepEqual(rules.normalizeModels({ director: 'Fable', builder: 'claude-fable-5-2' }), rules.DEFAULT_MODELS);
});

test("Luna's Work `auto` never picks fable", () => {
  const auto = Object.fromEntries(rules.ROLES.map((r) => [r, 'auto']));
  const ctxs = [{}, { size: 'L', risky: true }, { shipConfirm: true }, { gate: true }, { stepBack: true }];
  for (const role of rules.ROLES) {
    for (const ctx of ctxs) assert.notEqual(rules.pickModel(role, auto, ctx).model, 'fable');
  }
});

test("a Luna's Work card keeps builder model fable, and its package runs on it", () => {
  assert.equal(cleanCard({ at: 1, text: 'x', model: 'fable' }).model, 'fable');
  assert.equal(cleanCard({ at: 1, text: 'x', model: 'gpt-5' }).model, 'opus');
  const cardModels = new Map([[1, 'sonnet'], [2, 'fable'], [3, 'haiku']]);
  assert.equal(packageModel([1, 2], cardModels, 'sonnet'), 'fable', 'the strongest card model wins');
  assert.equal(packageModel([3], cardModels, 'opus'), 'sonnet', 'haiku is still not a worker model');
  assert.equal(packageModel([9], cardModels, 'opus'), 'opus');
});

test('God Mode: the planner is offered sonnet / opus only, but a fable package validates', () => {
  // Automatic assignment is unchanged: schema enum and prompt do not mention fable.
  assert.deepEqual(plan.PLAN_SCHEMA.properties.packages.items.properties.model.enum, ['sonnet', 'opus']);
  assert.deepEqual(plan.HYBRID_PLAN_SCHEMA.properties.packages.items.properties.model.enum, ['sonnet', 'opus', 'free']);
  assert.equal(/fable/i.test(plan.buildPlannerPrompt([{ at: 1, text: 'x' }])), false);
  assert.equal(/fable/i.test(plan.buildPlannerPrompt([{ at: 1, text: 'x' }], { hybrid: true })), false);

  assert.deepEqual(plan.PACKAGE_MODELS, ['sonnet', 'opus', 'fable']);
  const pkg = (model) => ({ id: 'a', title: 'A', todoAts: [1], prompt: 'do', files: [], dependsOn: [], verify: '', model });
  const checked = (model, opts) => plan.validatePlan({ packages: [pkg(model)], notes: '' }, [{ at: 1, text: 'x' }], opts).packages[0].model;
  assert.equal(checked('fable'), 'fable');
  assert.equal(checked('fable', { hybrid: true }), 'fable');
  assert.equal(checked('opus'), 'opus');
  assert.equal(checked('free'), null, 'free stays hybrid-only');
  assert.equal(checked('haiku'), null);
  assert.equal(checked('claude-fable-5-2'), null);
});

test('God Mode worker / planner model settings accept fable; defaults did not move', () => {
  assert.deepEqual(uiprefs.ORCHESTRA_WORKER_MODELS, ['opus', 'sonnet', 'fable', 'plan']);
  assert.ok(plan.PLANNER_MODELS.includes('fable'));
  assert.equal(plan.PLANNER_MODEL, 'opus');
  // A worker tab launched on fable gets `--model fable`.
  assert.match(withTaskBrief('claude', { briefPath: 'C:/tasks/b.md', model: 'fable' }), / --model fable( |$)/);
});

test('the renderer copies match the main-side lists', () => {
  assert.deepEqual(listIn(src('renderer/modules/orchestraPick.js'), 'PLANNER_MODELS'), [...plan.PLANNER_MODELS]);
  assert.deepEqual(listIn(src('renderer/modules/orchestrasettings.js'), 'MODELS'), uiprefs.ORCHESTRA_WORKER_MODELS);
  const html = src('renderer/index.html');
  const select = /<select id="orchestra-worker-model"[\s\S]*?<\/select>/.exec(html)[0];
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, uiprefs.ORCHESTRA_WORKER_MODELS);
  assert.match(select, /<option value="fable">Fable<\/option>/);
});

test('new picker strings exist in pl and en', () => {
  const i18n = src('renderer/i18n.js');
  for (const key of ['orch.pick.model', 'orch.pick.model.hint', 'orch.plannerModel']) {
    const hits = i18n.split(`'${key}':`).length - 1;
    assert.equal(hits, 2, `${key} needs pl and en`);
  }
});

test('model knowledge already covers Fable 5.2 (label, 1M window)', () => {
  assert.equal(modelLabel('claude-fable-5-2'), 'Fable 5.2');
  assert.equal(contextLimitFor('claude-fable-5-2'), 1000000);
});
