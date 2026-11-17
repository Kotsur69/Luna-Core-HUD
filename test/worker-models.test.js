// src/workerModels.js is the one source of truth for the God Mode worker-model
// list (ids + product names). This file pins its shape and guards that no
// consumer keeps its own copy: an exported list must BE the shared array (same
// object, so a hand-written twin fails even when it matches today), and the
// files that only use the list must hold no literal list or name map.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const shared = require('../src/workerModels.js');
const claudeModels = require('../src/claudeModels.js');
const uiprefs = require('../src/uiprefs.js');
const todorows = require('../src/todorows.js');
const snapshot = require('../src/godmodesnapshot.js');
const mainWorkerModel = require('../src/orchestraWorkerModel.js');
const rules = require('../src/renderer/modules/orchestraWorkerModelRules.js');
const phone = require('../mobile/src/godmodeplanmodel.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Source without its comment lines and blocks, so a doc line naming the models
 * does not trip the scan. Only comments that START a line are dropped: a `//`
 * inside a string or after code can never hide the code before it.
 */
function code(rel) {
  return code0(read(rel));
}

/** code() over a source string. */
function code0(source) {
  return source
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*<!--[\s\S]*?-->/gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

// ---- the shared list -------------------------------------------------------------

test('the shared list: ids, names, order and defaults', () => {
  assert.deepEqual([...shared.WORKER_MODELS], ['opus', 'sonnet', 'fable', 'agy', 'plan']);
  assert.deepEqual([...shared.CARD_MODELS], ['opus', 'sonnet', 'fable', 'agy']);
  assert.deepEqual({ ...shared.WORKER_MODEL_NAMES }, { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', agy: 'Antigravity' });
  assert.deepEqual({ ...shared.MODEL_NAMES }, { ...shared.WORKER_MODEL_NAMES, haiku: 'Haiku' });
  assert.equal(new Set(shared.WORKER_MODELS).size, shared.WORKER_MODELS.length, 'ids are unique');
  assert.deepEqual(shared.WORKER_MODELS, shared.WORKER_MODEL_LIST.map((m) => m.id));
  assert.equal(shared.DEFAULT_WORKER_MODEL, 'opus');
  assert.ok(shared.WORKER_MODELS.includes(shared.DEFAULT_WORKER_MODEL));
  assert.equal(shared.PLAN_WORKER_MODEL, 'plan');
  assert.equal(shared.AGY_MODEL, 'agy');
});

test('the shared list is frozen', () => {
  for (const frozen of [shared.WORKER_MODEL_LIST, shared.WORKER_MODELS, shared.CARD_MODELS, shared.WORKER_MODEL_NAMES, shared.MODEL_NAMES]) {
    assert.ok(Object.isFrozen(frozen));
  }
  for (const entry of shared.WORKER_MODEL_LIST) assert.ok(Object.isFrozen(entry));
});

test('isWorkerModel / isCardModel / isAgyModel', () => {
  for (const id of shared.WORKER_MODELS) assert.equal(shared.isWorkerModel(id), true, id);
  for (const id of shared.CARD_MODELS) assert.equal(shared.isCardModel(id), true, id);
  assert.equal(shared.isCardModel('plan'), false);
  for (const bad of ['', 'Opus', 'haiku', 'agy ', 'constructor', null, undefined, 1, ['opus'], { id: 'opus' }]) {
    assert.equal(shared.isWorkerModel(bad), false, JSON.stringify(bad));
    assert.equal(shared.isCardModel(bad), false, JSON.stringify(bad));
  }
  assert.equal(shared.isAgyModel('agy'), true);
  for (const other of ['opus', 'sonnet', 'fable', 'plan', 'AGY', 'antigravity', '', null, undefined]) {
    assert.equal(shared.isAgyModel(other), false, String(other));
  }
});

// ---- every consumer derives from it -----------------------------------------------

test('every exported worker-model list IS the shared array', () => {
  assert.equal(uiprefs.ORCHESTRA_WORKER_MODELS, shared.WORKER_MODELS, 'src/uiprefs.js');
  assert.equal(mainWorkerModel.ORCHESTRA_WORKER_MODELS, shared.WORKER_MODELS, 'src/orchestraWorkerModel.js');
  assert.equal(snapshot.PLAN_WORKER_MODELS, shared.WORKER_MODELS, 'src/godmodesnapshot.js');
  assert.equal(rules.WORKER_MODELS, shared.WORKER_MODELS, 'src/renderer/modules/orchestraWorkerModelRules.js');
  assert.equal(phone.WORKER_MODELS, shared.WORKER_MODELS, 'mobile/src/godmodeplanmodel.js');
  assert.equal(phone.WORKER_MODEL_NAMES, shared.WORKER_MODEL_NAMES, 'mobile/src/godmodeplanmodel.js names');
  assert.equal(todorows.MODELS, shared.CARD_MODELS, 'src/todorows.js');
  assert.equal(claudeModels.AGY_MODEL, shared.AGY_MODEL, 'src/claudeModels.js');
});

test('a plan package may carry every card model (src/orchestraPlan.js)', () => {
  const plan = require('../src/orchestraPlan.js');
  for (const id of shared.CARD_MODELS) assert.ok(plan.PACKAGE_MODELS.includes(id), id);
  const pkg = (model) => ({ id: 'a', title: 'A', todoAts: [1], prompt: 'do', files: [], dependsOn: [], verify: '', model });
  const checked = (model, opts) => plan.validatePlan({ packages: [pkg(model)], notes: '' }, [{ at: 1, text: 'x' }], opts).packages[0].model;
  for (const id of shared.CARD_MODELS) {
    assert.equal(checked(id), id, id);
    assert.equal(checked(id, { hybrid: true }), id, `${id} (hybrid)`);
  }
  assert.equal(checked('plan'), null, "'plan' is a run choice, not a package model");
});

test('the defaults come from the shared module', () => {
  assert.equal(mainWorkerModel.DEFAULT_WORKER_MODEL, shared.DEFAULT_WORKER_MODEL);
  assert.equal(rules.DEFAULT_WORKER_MODEL, shared.DEFAULT_WORKER_MODEL);
  assert.equal(phone.DEFAULT_WORKER_MODEL, shared.DEFAULT_WORKER_MODEL);
});

test('product names come from the shared module', () => {
  for (const [id, name] of Object.entries(shared.MODEL_NAMES)) assert.equal(rules.modelName(id), name, id);
  for (const id of claudeModels.CLAUDE_MODELS) assert.equal(claudeModels.MODEL_LABELS[id], shared.MODEL_NAMES[id], id);
});

test('a stored or snapshotted worker model still loads (back-compat)', () => {
  for (const id of shared.WORKER_MODELS) {
    assert.equal(mainWorkerModel.normalizeWorkerModel(id), id);
    assert.equal(rules.normalizeWorkerModel(id), id);
  }
  for (const id of shared.CARD_MODELS) assert.equal(todorows.normalizeTodo({ text: 'x', model: id }).model, id);
  assert.equal('model' in todorows.normalizeTodo({ text: 'x', model: 'plan' }), false, "'plan' is no card model");
  // A plan row in the `godmode` snapshot keeps every known model, drops the rest.
  const planModel = (workerModel) => snapshot.cleanPlans([{ state: 'ready', projectId: 'p1', workerModel }])[0].workerModel;
  for (const id of shared.WORKER_MODELS) assert.equal(planModel(id), id);
  for (const bad of ['haiku', 'Opus', '', null, undefined]) assert.equal(planModel(bad), null, String(bad));
});

// ---- no literal copies left behind -----------------------------------------------

/**
 * A list literal (one line or several) or a name map holding a worker-model
 * id: a hand-written copy. A one-element array is no list, so it passes.
 */
const IDS = shared.CARD_MODELS.join('|');
const LIST_RE = new RegExp(`\\[[^\\]]*['"](${IDS})['"][^\\]]*,[^\\]]*\\]`);
const NAME_MAP_RE = new RegExp(`(^|[{,\\s])['"]?(${IDS})['"]?\\s*:\\s*['"]`, 'm');

const CONSUMERS = [
  'src/todorows.js',
  'src/godmodesnapshot.js',
  'src/orchestraWorkerModel.js',
  'src/renderer/modules/orchestraWorkerModelRules.js',
  'src/renderer/modules/orchestraWorkerModel.js',
  'src/renderer/modules/orchestrasettings.js',
  'mobile/src/godmodeplanmodel.js',
  'mobile/src/views/godmodeplan.js',
];

test('no consumer holds its own literal worker-model list or name map', () => {
  for (const rel of CONSUMERS) {
    const src = code(rel);
    assert.doesNotMatch(src, LIST_RE, `${rel} holds a literal model list: import it from src/workerModels.js`);
    assert.doesNotMatch(src, NAME_MAP_RE, `${rel} holds a literal model-name map: use src/workerModels.js`);
  }
});

test('src/orchestraPlan.js adds no manual-only model by hand', () => {
  // Its MODELS / HYBRID_MODELS are what the planner is OFFERED (sonnet, opus,
  // free, agy); fable reaches PACKAGE_MODELS only through CARD_MODELS.
  assert.doesNotMatch(code('src/orchestraPlan.js'), /['"]fable['"]/);
});

test('src/uiprefs.js and src/claudeModels.js do not redefine the worker list or the names', () => {
  const prefs = code('src/uiprefs.js');
  assert.match(prefs, /ORCHESTRA_WORKER_MODELS = WORKER_MODELS;/);
  const models = code('src/claudeModels.js');
  assert.doesNotMatch(models, /['"]agy['"]/, 'AGY_MODEL comes from src/workerModels.js');
  assert.doesNotMatch(models, NAME_MAP_RE, 'MODEL_LABELS derives from src/workerModels.js MODEL_NAMES');
});

test('the Settings select in index.html has no hard-coded options', () => {
  const html = read('src/renderer/index.html');
  const select = /<select id="orchestra-worker-model"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, 'the select exists');
  assert.equal(select[1].trim(), '', 'its options are built from src/workerModels.js');
  assert.match(code('src/renderer/modules/orchestrasettings.js'), /WORKER_MODEL_LIST\.map\(/);
});

test('the guard regexes catch a copy (self-check)', () => {
  assert.match("const MODELS = ['opus', 'sonnet', 'plan'];", LIST_RE);
  assert.match("export const WORKER_MODELS = ['sonnet', 'agy'];", LIST_RE);
  assert.match("const M = [\n  'opus',\n  'sonnet',\n];", LIST_RE, 'a multi-line copy');
  assert.match(code0("const u = 'a//b'; const M = ['opus', 'sonnet'];"), LIST_RE, 'a // in a string hides nothing');
  assert.equal(code0("// ['opus', 'sonnet']\n/**\n * opus: 'Opus'\n */\nx();").trim(), 'x();', 'comment lines go');
  assert.match("const N = { opus: 'Opus', agy: 'Antigravity' };", NAME_MAP_RE);
  assert.doesNotMatch("const PLAN_FALLBACK_MODEL = 'opus';", LIST_RE);
  assert.doesNotMatch("if (workers === 'agy') return AGY_MODEL;", NAME_MAP_RE);
  assert.doesNotMatch("const x = cond ? 'sonnet' : y;", NAME_MAP_RE);
});
