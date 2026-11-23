// The Approve board's per-package model pick (src/renderer/modules/orchestraPackagePick.js):
// the choices match main's check (src/orchestraPackageModel.js pickChoices) and
// a pick is offered only before Approve in a pool run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pickKeys, pickOptions, pickText, canPick, packageModelsField } from '../src/renderer/modules/orchestraPackagePick.js';

const require = createRequire(import.meta.url);
const { pickChoices } = require('../src/orchestraPackageModel.js');

const e = (model, effort = 'plan') => ({ model, effort });
const POOL = [e('sonnet'), e('agy-argon'), e('free:freellm-chain')];
const variants = (key) => (key === 'agy-argon' ? [{ id: 'agy:gemini-4-argon-medium' }] : []);

test('the renderer offers exactly what main accepts: the ticked pool (no free) plus Opus', () => {
  assert.deepEqual(pickKeys(POOL), pickChoices(POOL));
  assert.deepEqual(pickKeys([e('opus'), e('sonnet')]), pickChoices([e('opus'), e('sonnet')]));
  const opts = pickOptions(POOL, variants);
  assert.ok(opts.some((c) => c.model === 'opus' && c.effort === 'max'));
  assert.ok(opts.some((c) => c.model === 'agy-argon' && c.effort === 'agy:gemini-4-argon-medium'));
  assert.equal(opts.some((c) => c.model === 'free' || c.model.startsWith('free:') || c.effort === 'low'), false);
  assert.equal(pickText({ model: 'agy-argon', effort: 'agy:gemini-4-argon-medium' }, 'per plan'), 'Argon (agy) - medium');
});

test('a pick is offered only before Approve, in a pool run, for a pending package', () => {
  const plan = { id: 'p1', started: false, packages: [] };
  const pkg = { id: 'a', state: 'pending' };
  assert.equal(canPick(plan, pkg, POOL, 'hybrid'), true);
  assert.equal(canPick(plan, pkg, [e('opus')], 'claude'), false, 'Workers [Opus] is no pool run');
  assert.equal(canPick({ ...plan, started: true }, pkg, POOL, 'hybrid'), false);
  assert.equal(canPick(plan, { ...pkg, state: 'launched' }, POOL, 'hybrid'), false);
  assert.equal(canPick(plan, pkg, POOL, 'free'), false);
  assert.equal(packageModelsField(plan, POOL, variants), null, 'no picks = the payload as before');
});

test('pickText shows the translated agy family name when a translator is given', () => {
  const choice = { model: 'agy-argon', effort: 'agy:gemini-4-argon-medium' };
  const translate = (key) => (key === 'orch.agy.family.argon' ? 'Argon (tlum.)' : key);
  assert.equal(pickText(choice, 'per plan', translate), 'Argon (tlum.) - medium');
  assert.equal(pickText({ model: 'sonnet', effort: 'plan' }, 'per plan', translate), 'Sonnet - per plan');
});
