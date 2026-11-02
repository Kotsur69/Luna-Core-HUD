'use strict';

// The keep-awake chip in the terminal bar (src/renderer/modules/keepawake.js):
// chipView maps main's status to what the chip shows - green "Awake" when the
// script runs, red "Sleep OK" when it does not, muted when no script is set.

const test = require('node:test');
const assert = require('node:assert/strict');

const { chipView } = require('../src/renderer/modules/keepawake.js');

test('no status yet reads as unconfigured', () => {
  const view = chipView(null);
  assert.equal(view.state, 'unconfigured');
  assert.equal(view.pressed, false);
  assert.equal(view.unavailable, true);
});

test('available and on reads as on and pressed', () => {
  const view = chipView({ available: true, on: true });
  assert.equal(view.state, 'on');
  assert.equal(view.pressed, true);
  assert.equal(view.unavailable, false);
  assert.equal(view.labelKey, 'keepawake.chip.on');
  assert.equal(view.titleKey, 'keepawake.chip.title.on');
});

test('available and off reads as off', () => {
  const view = chipView({ available: true, on: false });
  assert.equal(view.state, 'off');
  assert.equal(view.pressed, false);
  assert.equal(view.labelKey, 'keepawake.chip.off');
  assert.equal(view.titleKey, 'keepawake.chip.title.off');
});

test('off with an error reads as failed', () => {
  const view = chipView({ available: true, on: false, error: 'spawn-failed' });
  assert.equal(view.state, 'failed');
  assert.equal(view.pressed, false);
  assert.equal(view.labelKey, 'keepawake.chip.off');
  assert.equal(view.titleKey, 'keepawake.chip.title.failed');
});

test('not available wins over on', () => {
  const view = chipView({ available: false, on: true });
  assert.equal(view.state, 'unconfigured');
  assert.equal(view.pressed, false);
  assert.equal(view.titleKey, 'keepawake.chip.title.unconfigured');
});
