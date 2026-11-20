// Phone God Mode: the "Workers" pool picker before Launch (mobile/src/godmodeplanmodel.js):
// the PC's menu, ticking models and efforts, and what godmode.launch sends -
// a changed pool, else the single model exactly as before. The snapshot's
// pool menu is shape-checked on the way in (src/godmodesnapshot.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { planDraft, poolMenu, togglePoolEntry, setPoolEntryEffort, launchPayload, poolEffortText } from '../mobile/src/godmodeplanmodel.js';

const require = createRequire(import.meta.url);
const { strictPool } = require('../src/workerPool.js');

const menu = {
  models: [
    { model: 'agy-argon', available: true, variants: [{ id: 'agy:gemini-4-argon-medium', name: 'Argon (Medium)' }], defaultVariant: 'agy:gemini-4-argon-medium' },
    { model: 'agy-neon', available: false, variants: [], defaultVariant: null },
  ],
};
const plan = {
  planId: 'pabc123',
  projectId: 'p-luna',
  state: 'ready',
  errors: [],
  workerModel: 'opus',
  packages: [{ id: 'a', title: 'A', deps: [], model: 'opus' }],
  todos: [],
  poolOptions: menu,
};

test('poolMenu: Claude models always, agy families from the PC menu with their live variants', () => {
  const rows = poolMenu(plan);
  const by = (m) => rows.find((r) => r.model === m);
  assert.deepEqual(by('opus').efforts, ['plan', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([by('agy-argon').available, by('agy-argon').efforts], [true, ['plan', 'agy:gemini-4-argon-medium']]);
  assert.deepEqual([by('agy-neon').available, by('agy-hydrogen').available], [false, false]);
  // Without a menu (an older PC): only the Claude models can be ticked.
  assert.deepEqual(poolMenu({ ...plan, poolOptions: undefined }).filter((r) => r.available).map((r) => r.model), ['opus', 'sonnet']);
  assert.equal(poolEffortText('agy-argon', 'agy:gemini-4-argon-medium'), 'medium');
  assert.equal(poolEffortText('opus', 'plan'), null);
});

test('ticking models and efforts; an unavailable model or an effort off the menu changes nothing', () => {
  let d = planDraft(plan, null);
  assert.deepEqual(d.pool, []);
  d = togglePoolEntry(plan, d, 'opus');
  d = togglePoolEntry(plan, d, 'agy-argon');
  assert.equal(togglePoolEntry(plan, d, 'agy-neon'), d);
  d = setPoolEntryEffort(plan, d, 'opus', 'xhigh');
  d = setPoolEntryEffort(plan, d, 'agy-argon', 'agy:gemini-4-argon-medium');
  assert.equal(setPoolEntryEffort(plan, d, 'opus', 'low'), d);
  assert.equal(setPoolEntryEffort(plan, d, 'agy-argon', 'agy:gemini-4-argon-ultra'), d);
  assert.deepEqual(d.pool, [{ model: 'opus', effort: 'xhigh' }, { model: 'agy-argon', effort: 'agy:gemini-4-argon-medium' }]);
  // Unticking removes it; the draft survives a repaint of the same plan.
  assert.deepEqual(planDraft(plan, togglePoolEntry(plan, d, 'opus')).pool, [{ model: 'agy-argon', effort: 'agy:gemini-4-argon-medium' }]);
});

test('launchPayload: a ticked pool goes out (and passes the PC\'s strict check) instead of the single model', () => {
  let d = planDraft(plan, null);
  assert.deepEqual(launchPayload(plan, d), { projectId: 'p-luna', planId: 'pabc123', integration: 'pr', free: false, workerModel: 'opus' });
  d = setPoolEntryEffort(plan, togglePoolEntry(plan, togglePoolEntry(plan, d, 'sonnet'), 'agy-argon'), 'sonnet', 'high');
  const payload = launchPayload(plan, d);
  assert.deepEqual(payload.modelPool, [{ model: 'sonnet', effort: 'high' }, { model: 'agy-argon', effort: 'plan' }]);
  assert.equal('workerModel' in payload, false);
  assert.deepEqual(strictPool(payload.modelPool), payload.modelPool);
  // Free workers send no pool.
  assert.equal('modelPool' in launchPayload(plan, { ...d, free: true }), false);
});

test('launchPayload: a pool plan\'s own pool untouched goes out as before (workerModel), its free profile kept when changed', () => {
  const pooled = { ...plan, workerModel: 'plan', modelPool: [{ model: 'sonnet', effort: 'plan' }, { model: 'free:freellm-chain', effort: 'plan' }] };
  const d = planDraft(pooled, null);
  assert.equal(d.pool.length, 2);
  const same = launchPayload(pooled, d);
  assert.deepEqual([same.workerModel, 'modelPool' in same], ['plan', false]);
  const changed = launchPayload(pooled, togglePoolEntry(pooled, d, 'opus'));
  assert.deepEqual(changed.modelPool.map((e) => e.model), ['sonnet', 'free:freellm-chain', 'opus']);
  // The phone cannot tick or untick a free profile.
  assert.equal(togglePoolEntry(pooled, d, 'free:freellm-chain'), d);
});

test('the snapshot keeps a shape-checked pool menu: known models, agy-shaped variants, capped, no free profiles', () => {
  const { cleanPlans } = require('../src/godmodesnapshot.js');
  const variants = Array.from({ length: 15 }, (_, i) => ({ id: `agy:gemini-4-argon-v${i}`, name: `V${i}` }));
  const [p] = cleanPlans([
    {
      ...plan,
      poolOptions: {
        models: [
          { model: 'agy-argon', available: true, variants: [...variants, { id: '--flag', name: 'x' }] },
          { model: 'gpt-9', available: true, variants: [] },
        ],
        free: [{ model: 'free:secret-profile', name: 'Secret' }],
      },
    },
  ]);
  assert.deepEqual(p.poolOptions.models.map((m) => m.model), ['agy-argon']);
  assert.equal(p.poolOptions.models[0].variants.length, 10);
  assert.equal('free' in p.poolOptions, false);
  const [none] = cleanPlans([{ ...plan, poolOptions: undefined }]);
  assert.equal('poolOptions' in none, false);
});
