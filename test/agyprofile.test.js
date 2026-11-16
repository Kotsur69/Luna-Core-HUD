// Tests for the Antigravity (agy) profile helpers (src/agyprofile.js): which
// profile agy workers and headless jobs run on, and the env they get. The agy
// counterparts of main's freeProfileId() / lunasworkFreeEnv().

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AGY_TEMPLATE_ID, isAgyProfile, agyProfileId, agyEnv } = require('../src/agyprofile');

const claude = { id: 'claude-cloud', command: 'claude', args: [], env: {}, templateId: 'claude-cloud' };
const glm = { id: 'glm', command: 'claude', args: [], env: { ANTHROPIC_MODEL: 'glm-5.3' }, templateId: 'glm' };
const fromTemplate = { id: 'antigravity', command: 'agy', args: [], env: {}, templateId: 'antigravity' };
const handWritten = { id: 'my-agy', command: 'C:\\Users\\x\\AppData\\Local\\agy\\bin\\AGY.EXE', args: [], env: { AGY_CLI_HIDE_LOGO: '1' }, templateId: null };
// A template-made profile whose command was edited to a path: still agy.
const templateWithPath = { id: 'agy-2', command: 'D:\\tools\\agy.cmd', args: [], env: {}, templateId: 'antigravity' };

test('the template id matches config/providers.json', () => {
  const providers = require('../config/providers.json').providers;
  const template = providers.find((p) => p.id === AGY_TEMPLATE_ID);
  assert.ok(template, 'antigravity template exists');
  assert.equal(template.command, 'agy');
});

test('isAgyProfile: the antigravity template or an agy command', () => {
  assert.equal(isAgyProfile(fromTemplate), true);
  assert.equal(isAgyProfile(handWritten), true);
  assert.equal(isAgyProfile(templateWithPath), true);
  assert.equal(isAgyProfile({ id: 'x', command: 'agy.cmd --mode plan', templateId: null }), true);
  for (const p of [claude, glm, null, undefined, 'agy', [], { command: 'agy' }, { id: '', command: 'agy' }, { id: 'x', command: 42 }]) {
    assert.equal(isAgyProfile(p), false, JSON.stringify(p));
  }
});

test('agyProfileId: the first agy profile, or null', () => {
  assert.equal(agyProfileId([claude, glm, handWritten, fromTemplate]), 'my-agy');
  assert.equal(agyProfileId([claude, fromTemplate, handWritten]), 'antigravity');
  assert.equal(agyProfileId([claude, glm]), null);
  assert.equal(agyProfileId([]), null);
  assert.equal(agyProfileId(null), null);
  assert.equal(agyProfileId([null, 'x', fromTemplate]), 'antigravity', 'junk entries are skipped');
});

test('agyProfileId: a preferred profile wins only when it is an agy profile', () => {
  assert.equal(agyProfileId([claude, fromTemplate, handWritten], 'my-agy'), 'my-agy');
  assert.equal(agyProfileId([claude, fromTemplate], 'claude-cloud'), 'antigravity', 'a non-agy preference is ignored');
  assert.equal(agyProfileId([claude, fromTemplate], 'gone'), 'antigravity');
});

test('agyEnv: inherited env minus Claude session markers, the profile env on top', () => {
  const inherited = { PATH: 'C:\\bin', CLAUDE_CODE_ENTRYPOINT: 'cli', AGY_CLI_HIDE_LOGO: '0' };
  const env = agyEnv(handWritten, { inherited });
  assert.equal(env.PATH, 'C:\\bin');
  assert.equal(env.AGY_CLI_HIDE_LOGO, '1', 'the profile env wins');
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in env, false, 'an outer Claude session marker never reaches agy');
  assert.equal(inherited.AGY_CLI_HIDE_LOGO, '0', 'the inherited env is not mutated');
});

test('agyEnv: null for anything that is not an agy profile', () => {
  for (const p of [claude, glm, null, undefined, {}]) assert.equal(agyEnv(p, { inherited: {} }), null);
});

test('agyEnv: a profile without an env object still gets the inherited env', () => {
  const env = agyEnv({ id: 'a', command: 'agy', env: null }, { inherited: { HOME: '/h' } });
  assert.equal(env.HOME, '/h');
});

test('agyEnv: defaults to process.env', () => {
  const env = agyEnv(fromTemplate);
  assert.ok(env && typeof env === 'object');
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
  if (pathKey) assert.equal(env[pathKey], process.env[pathKey]);
});
