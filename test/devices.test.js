// Tests for the pure half of the device panel. micState() spawns a real
// powershell.exe against real Core Audio state and is left to the plan's
// manual verification checklist - the same boundary media.test.js and
// gpu.test.js already draw around their samplers.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMicState, micState, MIC_ACTIONS } = require('../src/devices.js');

test('parseMicState parses a muted reading', () => {
  assert.deepEqual(parseMicState(JSON.stringify({ muted: true, available: true })), {
    muted: true,
    available: true,
  });
});

test('parseMicState parses an unmuted reading', () => {
  assert.deepEqual(parseMicState(JSON.stringify({ muted: false })), {
    muted: false,
    available: true,
  });
});

// The important one: empty stdout is mic.ps1's "no capture endpoint / COM
// error" signal. It must become null - "unavailable" - and never a cheerful
// default of false, which would show a live-looking mic that is not there.
test('parseMicState treats empty/whitespace stdout as unavailable, not as unmuted', () => {
  assert.equal(parseMicState(''), null);
  assert.equal(parseMicState('   \n'), null);
  assert.equal(parseMicState(undefined), null);
});

test('parseMicState treats malformed JSON as unavailable', () => {
  assert.equal(parseMicState('not json'), null);
});

test('parseMicState rejects a missing or wrong-typed muted field', () => {
  assert.equal(parseMicState(JSON.stringify({ available: true })), null);
  assert.equal(parseMicState(JSON.stringify({ muted: 'yes' })), null);
  assert.equal(parseMicState(JSON.stringify({ muted: 1 })), null);
});

test('micState rejects an action outside the whitelist before spawning anything', async () => {
  assert.equal(await micState('rm -rf'), null);
  assert.equal(await micState(''), null);
  assert.equal(await micState(null), null);
});

test('the action whitelist is exactly what mic.ps1 accepts', () => {
  assert.deepEqual(MIC_ACTIONS, ['get', 'toggle', 'mute', 'unmute']);
});
