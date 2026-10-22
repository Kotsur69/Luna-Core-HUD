// The usage panel shows one provider at a time: the profile of the active
// terminal tab (src/renderer/modules/usage.js selectVisibleUsage).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectVisibleUsage } = require('../src/renderer/modules/usage.js');

const codex = { profileId: 'codex', providerId: 'codex', status: 'ok', limits: [] };
const glm = { profileId: 'glm-main', providerId: 'zai', status: 'unsupported', limits: [] };
const others = [codex, glm];

test('a tab running a non-Claude profile shows only that provider', () => {
  assert.deepEqual(selectVisibleUsage(others, 'codex'), { provider: 'other', entry: codex });
  assert.deepEqual(selectVisibleUsage(others, 'glm-main'), { provider: 'other', entry: glm });
});

test('a Claude tab (not in others) shows Claude only', () => {
  assert.deepEqual(selectVisibleUsage(others, 'claude'), { provider: 'claude', entry: null });
});

test('no tab or an unknown profile falls back to Claude', () => {
  assert.deepEqual(selectVisibleUsage(others, null), { provider: 'claude', entry: null });
  assert.deepEqual(selectVisibleUsage(others, undefined), { provider: 'claude', entry: null });
  assert.deepEqual(selectVisibleUsage(others, 'gone'), { provider: 'claude', entry: null });
});

test('a missing or malformed others list is tolerated', () => {
  assert.deepEqual(selectVisibleUsage(undefined, 'codex'), { provider: 'claude', entry: null });
  assert.deepEqual(selectVisibleUsage([null, 'x', 42], 'codex'), { provider: 'claude', entry: null });
});

test('switching the profile switches the provider - never both', () => {
  const picks = ['codex', 'claude', 'glm-main'].map((id) => selectVisibleUsage(others, id));
  assert.deepEqual(picks.map((p) => p.provider), ['other', 'claude', 'other']);
  for (const p of picks) assert.ok(p.provider === 'claude' ? p.entry === null : p.entry !== null);
});
