// The agy model family registry (src/agyFamilies.js): one entry per family,
// read by the worker pool, the planner prompt and the usage tile.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fam = require('../src/agyFamilies.js');
const pool = require('../src/workerPool.js');

test('families come strongest first, with unique families, pool keys and ranks', () => {
  const list = fam.agyFamilyList();
  assert.deepEqual(list.map((f) => f.poolKey), ['agy-opus', 'agy-neon', 'agy-argon', 'agy-hydrogen']);
  for (const field of ['family', 'poolKey', 'strength']) {
    assert.equal(new Set(list.map((f) => f[field])).size, list.length, `${field} is unique`);
  }
  for (const f of list) {
    assert.equal(f.poolKey, `agy-${f.family}`);
    assert.ok(['hard', 'easy'].includes(f.tier));
    // Families only: no model id (gemini-4-argon-medium) is ever listed.
    assert.ok(!/gemini-\d/.test(JSON.stringify(f)), `${f.family} names no model id`);
  }
  assert.deepEqual(fam.agyPoolKeysOfTier('hard'), ['agy-opus', 'agy-neon', 'agy-argon']);
  assert.deepEqual(fam.agyPoolKeysOfTier('easy'), ['agy-hydrogen']);
});

test('lookup by pool key', () => {
  assert.equal(fam.agyFamilyByPoolKey('agy-neon').family, 'neon');
  assert.equal(fam.agyFamilyByPoolKey('opus'), null);
  assert.equal(fam.agyFamilyByPoolKey(undefined), null);
});

test('own-usage flags: Neon and Argon have their own quota row, only Argon is always listed', () => {
  assert.deepEqual(fam.agyOwnUsageFamilies().map((f) => f.usageRow), ['Neon', 'Argon']);
  assert.deepEqual(fam.agyAlwaysListedUsageRows(), ['Argon']);
  assert.deepEqual(fam.agyUsageRowOrder(), ['Opus', 'Gemini', 'Neon', 'Argon']);
  assert.deepEqual([...fam.agyPerModelUsageRows()].sort(), ['Argon', 'Gemini', 'Neon']);
  assert.equal(fam.isWeeklyOnlyUsageRow('Argon'), true);
  assert.equal(fam.isWeeklyOnlyUsageRow('Neon'), false);
});

test('the worker pool is built from the registry', () => {
  const agy = pool.POOL_MODEL_LIST.filter((m) => m.runsOn === 'agy');
  assert.deepEqual(agy.map((m) => [m.id, m.family, m.tier, m.name]),
    fam.agyFamilyList().map((f) => [f.poolKey, f.family, f.tier, f.name]));
  assert.deepEqual([...pool.STRENGTH_ORDER], ['opus', 'agy-opus', 'agy-neon', 'agy-argon', 'sonnet', 'agy-hydrogen', 'free']);
});
