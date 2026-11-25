// God Mode "Workers" pool efforts on the board (renderer, no DOM needed):
// Approve's payload stays today's for Opus "Per plan", a lone Claude model
// with a level sends the pool; the run line and the package badges name the
// effort a pool entry fixes ('Opus - xhigh', 'Argon (agy) - medium').

import test from 'node:test';
import assert from 'node:assert/strict';

let prefs = {};
const MENU = {
  models: [
    { model: 'agy-argon', available: true, variants: [{ id: 'agy:gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' }, { id: 'agy:gemini-4-argon-high', name: 'Gemini 4 Argon (High)' }], defaultVariant: 'agy:gemini-4-argon-high' },
  ],
  free: [],
};
// A stand-in dictionary: an agy family key reads as its English product name.
const { agyFamilyList } = await import('../src/agyFamilies.mjs');
globalThis.window = {
  i18n: { t: (key) => (agyFamilyList().find((f) => f.labelKey === key) || { name: key }).name },
  lunacore: {
    getUiPrefs: async () => prefs,
    setUiPrefs: async () => ({ ok: true }),
    orchestraPoolOptions: async () => MENU,
    agyModels: async () => [],
  },
};

const ui = await import('../src/renderer/modules/orchestraWorkerModel.js');
const { refreshPoolOptions } = await import('../src/renderer/modules/orchestraPoolPicker.js');

/** Puts a pool "on screen" (the saved pref the pickers read). */
async function onScreen(pool) {
  prefs = { orchestraModelPool: pool };
  await ui.loadWorkerModel();
  await refreshPoolOptions();
}

const plan = { id: 'p1', workerModel: 'plan', started: false, scheduledAt: null, packages: [] };

test('Approve payload: Opus "Per plan" is today\'s {workerModel}; a level sends the pool', async () => {
  await onScreen([{ model: 'opus', effort: 'plan' }]);
  assert.deepEqual(ui.launchModelFields(plan, 'claude'), { workerModel: 'opus' });
  await onScreen([{ model: 'opus', effort: 'xhigh' }]);
  assert.deepEqual(ui.launchModelFields(plan, 'claude'), { modelPool: [{ model: 'opus', effort: 'xhigh' }] });
  assert.equal(ui.runModelLabel(plan), 'Opus - xhigh');
});

test('a one-model agy pool runs its chosen live variant', async () => {
  await onScreen([{ model: 'agy-argon', effort: 'agy:gemini-4-argon-medium' }]);
  assert.equal(ui.chosenWorkerModel(plan), 'agy:gemini-4-argon-medium');
  await onScreen([{ model: 'agy-argon', effort: 'plan' }]);
  assert.equal(ui.chosenWorkerModel(plan), 'agy:gemini-4-argon-high');
});

test('package badges name the fixed effort before Approve and once started', async () => {
  const pool = [{ model: 'opus', effort: 'xhigh' }, { model: 'sonnet', effort: 'plan' }, { model: 'agy-argon', effort: 'agy:gemini-4-argon-medium' }];
  await onScreen(pool);
  const opus = { id: 'a', model: 'opus', poolModel: 'opus' };
  const sonnet = { id: 'b', model: 'sonnet', poolModel: 'sonnet' };
  const argon = { id: 'c', model: 'agy:gemini-4-argon-high', poolModel: 'agy-argon' };
  assert.equal(ui.packageModelBadge(opus, plan, 'claude'), 'Opus - xhigh');
  assert.equal(ui.packageModelBadge(sonnet, plan, 'claude'), 'Sonnet');
  // Before Approve the pool on screen decides (main re-applies it at Approve).
  assert.equal(ui.packageModelBadge(argon, plan, 'claude'), 'Argon (agy) - medium');
  // An escalated package shows its override, not the pool effort.
  assert.equal(ui.packageModelBadge({ ...opus, modelOverride: 'opus' }, plan, 'claude'), 'Opus');
  // Started: the frozen pool and the model each package actually runs on.
  const started = { ...plan, started: true, modelPool: pool };
  assert.equal(ui.packageModelBadge(opus, started, 'claude'), 'Opus - xhigh');
  assert.equal(ui.packageModelBadge({ ...argon, model: 'agy:gemini-4-argon-medium' }, started, 'claude'), 'Argon (agy) - medium');
  assert.equal(ui.runModelLabel(started), 'Opus - xhigh + Sonnet + Argon (agy) - medium');
});
