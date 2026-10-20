// ============================================================================
// LunaCore - Luna sync skill picker, pure half (src/renderer/modules/lunasyncpickermodel.js)
// ----------------------------------------------------------------------------
// ~350 plugin skills: the picker draws only a capped, filtered slice, picked
// ones first so a selection never scrolls out of reach.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { filterSkills, togglePicked } = require('../src/renderer/modules/lunasyncpickermodel.js');

const SKILLS = [
  { id: 'ecc:tdd-workflow', plugin: 'ecc@ecc', name: 'tdd-workflow' },
  { id: 'ecc:python-testing', plugin: 'ecc@ecc', name: 'python-testing' },
  { id: 'ui-ux-pro-max:design', plugin: 'ui-ux-pro-max@x', name: 'design' },
  { id: 'brag:brag', plugin: 'brag@brag', name: 'brag' },
];

test('filterSkills puts picked skills first, then the rest alphabetically', () => {
  const view = filterSkills(SKILLS, '', ['ui-ux-pro-max:design'], 10);
  assert.deepEqual(view.rows.map((r) => r.id), ['ui-ux-pro-max:design', 'brag:brag', 'ecc:python-testing', 'ecc:tdd-workflow']);
  assert.equal(view.rows[0].picked, true);
  assert.equal(view.total, 4);
  assert.equal(view.hidden, 0);
});

test('filterSkills matches every space-separated term, case-insensitively', () => {
  assert.deepEqual(filterSkills(SKILLS, 'ECC', [], 10).rows.map((r) => r.id), ['ecc:python-testing', 'ecc:tdd-workflow']);
  assert.deepEqual(filterSkills(SKILLS, 'ecc TEST', [], 10).rows.map((r) => r.id), ['ecc:python-testing']);
  assert.deepEqual(filterSkills(SKILLS, 'nothing-matches', [], 10).rows, []);
});

test('filterSkills caps the drawn rows and reports how many were held back', () => {
  const view = filterSkills(SKILLS, '', [], 2);
  assert.equal(view.rows.length, 2);
  assert.equal(view.total, 4);
  assert.equal(view.hidden, 2);
});

test('filterSkills tolerates junk input', () => {
  assert.deepEqual(filterSkills(null, null, null, 5), { rows: [], total: 0, hidden: 0 });
});

test('togglePicked adds or removes one id without mutating the input', () => {
  const picked = ['a:b'];
  assert.deepEqual(togglePicked(picked, 'c:d', true), ['a:b', 'c:d']);
  assert.deepEqual(togglePicked(picked, 'a:b', false), []);
  assert.deepEqual(togglePicked(picked, 'a:b', true), ['a:b']);
  assert.deepEqual(picked, ['a:b']);
});
