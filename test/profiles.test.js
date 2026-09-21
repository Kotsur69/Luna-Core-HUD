// Tests for launch profile validation. normalizeProfile is the trust
// boundary: the config can be hand-edited, so garbage must not get through.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProfile, getProfile, redactProfile } = require('../src/profiles');

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
      // Absent in the input -> not generated from a provider template.
      templateId: null,
      // Absent in the input -> not a CCR-routed provider.
      ccrConfig: null,
    }
  );
});

test('normalizeProfile carries templateId through only when it is a non-empty string', () => {
  assert.equal(normalizeProfile({ id: 'x', label: 'X', templateId: 'kimi' }).templateId, 'kimi');
  assert.equal(normalizeProfile({ id: 'x', label: 'X', templateId: '' }).templateId, null);
  assert.equal(normalizeProfile({ id: 'x', label: 'X', templateId: 42 }).templateId, null);
  assert.equal(normalizeProfile({ id: 'x', label: 'X' }).templateId, null);
});

test('normalizeProfile carries a well-formed ccrConfig through', () => {
  const p = normalizeProfile({
    id: 'x',
    label: 'X',
    ccrConfig: { providerType: 'openai-compatible', apiKey: 'k', baseUrl: 'https://x' },
  });
  assert.deepEqual(p.ccrConfig, { providerType: 'openai-compatible', apiKey: 'k', baseUrl: 'https://x' });
});

test('normalizeProfile drops ccrConfig to null when providerType is missing or the shape is junk', () => {
  assert.equal(normalizeProfile({ id: 'x', label: 'X', ccrConfig: { apiKey: 'k' } }).ccrConfig, null);
  assert.equal(normalizeProfile({ id: 'x', label: 'X', ccrConfig: 'nope' }).ccrConfig, null);
  assert.equal(normalizeProfile({ id: 'x', label: 'X', ccrConfig: null }).ccrConfig, null);
  assert.equal(normalizeProfile({ id: 'x', label: 'X' }).ccrConfig, null);
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
  assert.deepEqual(
    Object.keys(p).sort(),
    ['args', 'autoModel', 'ccrConfig', 'command', 'env', 'id', 'label', 'templateId']
  );
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

test('redactProfile strips env and ccrConfig but keeps every other field, plus derived non-secret flags', () => {
  const p = normalizeProfile({
    id: 'custom',
    label: 'Custom',
    command: 'claude',
    args: ['--continue'],
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-super-secret' },
    autoModel: false,
    templateId: 'openai-compatible',
    ccrConfig: { providerType: 'openai-compatible', apiKey: 'sk-ccr-secret', baseUrl: 'https://x' },
  });
  const redacted = redactProfile(p);
  assert.deepEqual(redacted, {
    id: 'custom',
    label: 'Custom',
    command: 'claude',
    args: ['--continue'],
    autoModel: false,
    templateId: 'openai-compatible',
    model: '',
    fastModel: '',
    hasApiKey: true,
    hasBaseUrl: true,
  });
  assert.equal('env' in redacted, false);
  assert.equal('ccrConfig' in redacted, false);
  const dump = JSON.stringify(redacted);
  assert.equal(dump.indexOf('sk-super-secret'), -1);
  assert.equal(dump.indexOf('sk-ccr-secret'), -1);
});

test('redactProfile reads model/fastModel out of env without exposing env itself', () => {
  const p = normalizeProfile({
    id: 'glm-1',
    label: 'My GLM',
    templateId: 'glm',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'sk-glm-secret',
      ANTHROPIC_MODEL: 'glm-5.3',
      ANTHROPIC_SMALL_FAST_MODEL: 'glm-5.3-flash',
    },
  });
  const redacted = redactProfile(p);
  assert.equal(redacted.model, 'glm-5.3');
  assert.equal(redacted.fastModel, 'glm-5.3-flash');
  assert.equal(redacted.hasApiKey, true);
  assert.equal('env' in redacted, false);
});

test('redactProfile does not count a template\'s own fixed placeholder token as a real API key', () => {
  const lmStudio = normalizeProfile({
    id: 'lm-studio',
    label: 'LM Studio',
    templateId: 'lm-studio',
    env: { ANTHROPIC_AUTH_TOKEN: 'lmstudio' },
  });
  const ccrRouted = normalizeProfile({
    id: 'ollama-1',
    label: 'Ollama',
    templateId: 'ollama',
    env: { ANTHROPIC_AUTH_TOKEN: 'ccr-local' },
  });
  assert.equal(redactProfile(lmStudio).hasApiKey, false);
  assert.equal(redactProfile(ccrRouted).hasApiKey, false);
});

test('redactProfile handles a hand-written profile with no env/ccrConfig at all', () => {
  const p = normalizeProfile({ id: 'claude-cloud', label: 'Claude Cloud' });
  assert.deepEqual(redactProfile(p), {
    id: 'claude-cloud',
    label: 'Claude Cloud',
    command: '',
    args: [],
    autoModel: false,
    templateId: null,
    model: '',
    fastModel: '',
    hasApiKey: false,
    hasBaseUrl: false,
  });
});
