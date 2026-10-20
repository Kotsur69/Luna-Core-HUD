// ============================================================================
// LunaCore - Life dashboard daily view math (renderer/modules/lifedailyview.js)
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sleepOptions, needsCheckin, needsGoals, scoreBand, arrow, hoursMinutes, shouldNudge, habitLabelKey, weightsOf,
} = require('../src/renderer/modules/lifedailyview.js');

test('sleep choices run 0-16 in half hours', () => {
  const opts = sleepOptions();
  assert.equal(opts.length, 33);
  assert.equal(opts[0], 0);
  assert.equal(opts[15], 7.5);
  assert.equal(opts[32], 16);
});

test('the check-in prompt shows only while today is unanswered', () => {
  assert.equal(needsCheckin({ ok: true, entry: null }), true);
  assert.equal(needsCheckin({ ok: true, entry: { sleep: null, energy: null } }), false);
  assert.equal(needsCheckin(null), false);
  assert.equal(needsCheckin({ ok: false }), false);
});

test('the goals prompt shows until the ISO week is answered (skip = [])', () => {
  assert.equal(needsGoals({ ok: true, goals: null }), true);
  assert.equal(needsGoals({ ok: true, goals: [] }), false);
  assert.equal(needsGoals(null), false);
});

test('score bands and arrows always carry text, not colour alone', () => {
  assert.deepEqual([scoreBand(85), scoreBand(50), scoreBand(10), scoreBand(null)], ['is-good', 'is-warn', 'is-bad', '']);
  assert.deepEqual(arrow({ dir: 'up', delta: 12 }), { glyph: '▲', text: '+12', cls: 'is-good' });
  assert.deepEqual(arrow({ dir: 'down', delta: -4 }), { glyph: '▼', text: '-4', cls: 'is-bad' });
  assert.deepEqual(arrow({ dir: 'same', delta: 0 }), { glyph: '=', text: '0', cls: '' });
  assert.equal(arrow(null), null);
});

test('time in project and the switch nudge', () => {
  assert.deepEqual(hoursMinutes(65 * 60000), { h: 1, m: 5 });
  assert.deepEqual(hoursMinutes(-5), { h: 0, m: 0 });
  assert.equal(shouldNudge({ switches: 3 }), true);
  assert.equal(shouldNudge({ switches: 2 }), false);
  assert.equal(shouldNudge({ switches: null }), false);
});

test('habit labels and slider weights', () => {
  assert.equal(habitLabelKey({ id: 'gym', name: '' }), 'life.habit.gym');
  assert.equal(habitLabelKey({ id: 'x', name: 'Mine' }), null);
  assert.deepEqual(weightsOf({ focus: '40', shipping: 20, goals: -3, health: 'x' }), { focus: 40, shipping: 20, goals: 0, health: 0 });
});
