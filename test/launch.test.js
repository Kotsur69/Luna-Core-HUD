// Testy budowania komendy startowej (src/launch.js).
//
// Why this file matters: withSessionId is the switch that decides whether a tab
// can be pinned to its transcript. A wrong `null` here does not fail loudly - it
// quietly restores the old timestamp guessing, and every other test stays green.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withSessionId } = require('../src/launch');

const UUID = '00000000-0000-0000-0000-000000000000';

test('withSessionId pins a plain claude launch', () => {
  // The default profile (config/profiles.json -> "claude-cloud") is exactly this
  // string. If this case ever returns null, pinning is dead app-wide.
  assert.equal(withSessionId('claude', UUID), `claude --session-id ${UUID}`);
});

test('withSessionId keeps the existing arguments', () => {
  assert.equal(
    withSessionId('claude --model opus', UUID),
    `claude --model opus --session-id ${UUID}`,
  );
});

test('withSessionId accepts a path or .exe/.cmd form of the binary', () => {
  for (const cmd of ['claude.exe', 'claude.cmd', 'C:\\Users\\x\\.local\\bin\\claude.exe']) {
    assert.ok(
      String(withSessionId(cmd, UUID)).includes(`--session-id ${UUID}`),
      `expected ${cmd} to be pinnable`,
    );
  }
});

test('withSessionId refuses an empty command (bare shell profile)', () => {
  assert.equal(withSessionId('', UUID), null);
  assert.equal(withSessionId('   ', UUID), null);
  assert.equal(withSessionId(undefined, UUID), null);
});

test('withSessionId refuses a program that is not claude', () => {
  // A profile may start anything; labelling a foreign process would be a lie.
  assert.equal(withSessionId('pwsh', UUID), null);
  assert.equal(withSessionId('npm start', UUID), null);
  assert.equal(withSessionId('claude-code-proxy', UUID), null);
});

test('withSessionId refuses when the session id is already decided', () => {
  // Resuming picks its own id; forcing ours would conflict or hijack it.
  for (const cmd of [
    'claude -c',
    'claude --continue',
    'claude -r abc',
    'claude --resume abc',
    'claude --fork-session',
    `claude --session-id ${UUID}`,
  ]) {
    assert.equal(withSessionId(cmd, UUID), null, `expected ${cmd} to be left alone`);
  }
});

test('withSessionId does not confuse a flag that merely contains a resume word', () => {
  // Substring matching here would wrongly disable pinning.
  assert.ok(String(withSessionId('claude --continue-on-error', UUID)).includes('--session-id'));
  assert.ok(String(withSessionId('claude --resumable', UUID)).includes('--session-id'));
});

test('withSessionId refuses without a uuid', () => {
  assert.equal(withSessionId('claude', ''), null);
  assert.equal(withSessionId('claude', undefined), null);
});
