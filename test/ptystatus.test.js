// Tests for the PTY status line (src/renderer/modules/ptystatus.js):
// version suffix formatting and safe operation when imported without a DOM.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatPtyStatus,
  setPtyStatus,
  setPtyVersion,
  renderPtyStatus,
} = require('../src/renderer/modules/ptystatus.js');

test('formatPtyStatus returns the status text alone before the version is known', () => {
  assert.equal(formatPtyStatus('PTY: active', ''), 'PTY: active');
  assert.equal(formatPtyStatus('PTY: active', null), 'PTY: active');
  assert.equal(formatPtyStatus('PTY: active', undefined), 'PTY: active');
  assert.equal(formatPtyStatus('PTY: active', '   '), 'PTY: active');
});

test('formatPtyStatus appends the version with a single leading v', () => {
  assert.equal(formatPtyStatus('PTY: active', '0.33.0'), 'PTY: active · v0.33.0');
  assert.equal(formatPtyStatus('PTY: aktywne', '0.33.0'), 'PTY: aktywne · v0.33.0');
  assert.equal(formatPtyStatus('PTY: ended (code 0)', 'v0.33.0'), 'PTY: ended (code 0) · v0.33.0');
  assert.equal(formatPtyStatus('PTY: active', '  V1.2.3  '), 'PTY: active · v1.2.3');
});

test('formatPtyStatus handles an empty status string gracefully', () => {
  assert.equal(formatPtyStatus('', '0.33.0'), 'v0.33.0');
  assert.equal(formatPtyStatus(null, '0.33.0'), 'v0.33.0');
  assert.equal(formatPtyStatus(null, null), '');
});

test('setPtyStatus, setPtyVersion, and renderPtyStatus are safe without a DOM', () => {
  assert.doesNotThrow(() => {
    setPtyVersion('0.33.0');
    setPtyStatus(true, 'ptystatus.active');
    renderPtyStatus();
  });
});
