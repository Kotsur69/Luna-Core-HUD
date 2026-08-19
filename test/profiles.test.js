// Tests for launch profile validation. normalizeProfile is the trust
// boundary: the config can be hand-edited, so garbage must not get through.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProfile, getProfile } = require('../src/profiles');

test('normalizeProfile passes a valid profile through', () => {
  assert.deepEqual(
    normalizeProfile({
      id: 'lm-studio',
      label: 'LM Studio',
      command: 'claude',
      args: ['--continue'],
      env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' },
    }),
    {
      id: 'lm-studio',
      label: 'LM Studio',
      command: 'claude',
      args: ['--continue'],
      env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' },
      // Absent in the input, so it defaults off - a profile has to ASK for its
      // model to be filled in from a local endpoint (src/lmstudio.js).
      autoModel: false,
    }
  );
});

test('normalizeProfile carries autoModel through only when it is exactly true', () => {
  assert.equal(normalizeProfile({ id: 'x', label: 'X', autoModel: true }).autoModel, true);
  assert.equal(normalizeProfile({ id: 'x', label: 'X', autoModel: 'yes' }).autoModel, false);
  assert.equal(normalizeProfile({ id: 'x', label: 'X' }).autoModel, false);
});

test('normalizeProfile rejects entries without id or label', () => {
  assert.equal(normalizeProfile({ label: 'No id' }), null);
  assert.equal(normalizeProfile({ id: 'no-label' }), null);
  assert.equal(normalizeProfile({ id: '', label: 'Empty id' }), null);
  assert.equal(normalizeProfile({ id: 'x', label: '' }), null);
});

test('normalizeProfile rejects non-objects', () => {
  assert.equal(normalizeProfile(null), null);
  assert.equal(normalizeProfile(undefined), null);
  assert.equal(normalizeProfile('claude'), null);
  assert.equal(normalizeProfile(42), null);
});

test('normalizeProfile allows an empty command (bare shell)', () => {
  const p = normalizeProfile({ id: 'shell', label: 'Shell', command: '' });
  assert.equal(p.command, '');
});

test('normalizeProfile turns an invalid command into an empty string', () => {
  assert.equal(normalizeProfile({ id: 'x', label: 'X', command: 123 }).command, '');
  assert.equal(normalizeProfile({ id: 'x', label: 'X' }).command, '');
});

test('normalizeProfile filters out non-strings from args', () => {
  const p = normalizeProfile({ id: 'x', label: 'X', args: ['--a', 5, null, '--b'] });
  assert.deepEqual(p.args, ['--a', '--b']);
});

test('normalizeProfile turns a non-array args into an empty array', () => {
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X', args: 'nope' }).args, []);
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X' }).args, []);
});

test('normalizeProfile passes through only string env values', () => {
  // Important: env goes straight to pty.spawn - a number or object could crash the spawn.
  const p = normalizeProfile({
    id: 'x',
    label: 'X',
    env: { OK: 'yes', NUMBER: 8080, NESTED: { a: 1 }, NOTHING: null },
  });
  assert.deepEqual(p.env, { OK: 'yes' });
});

test('normalizeProfile turns a non-object env (including arrays) into an empty object', () => {
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X', env: ['A=1'] }).env, {});
  assert.deepEqual(normalizeProfile({ id: 'x', label: 'X', env: 'A=1' }).env, {});
});

test('normalizeProfile does not carry unknown fields forward', () => {
  const p = normalizeProfile({ id: 'x', label: 'X', whatever: 'junk' });
  assert.deepEqual(Object.keys(p).sort(), ['args', 'autoModel', 'command', 'env', 'id', 'label']);
});

test('getProfile finds by id, otherwise null', () => {
  const list = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  assert.equal(getProfile(list, 'b').label, 'B');
  assert.equal(getProfile(list, 'no-such-id'), null);
  assert.equal(getProfile([], 'a'), null);
});
