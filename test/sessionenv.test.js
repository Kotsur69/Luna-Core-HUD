// ============================================================================
// LunaCore - session env assembly tests (src/sessionenv.js)
// ----------------------------------------------------------------------------
// Why this file matters: the marker strip used to run on the MERGED env, after
// the profile and the local-launch overrides were layered on. Every
// CLAUDE_CODE_* key those layers set - CLAUDE_CODE_MAX_CONTEXT_TOKENS from
// the LM Studio prep, CLAUDE_CODE_SUBAGENT_MODEL from the GLM template - was
// silently deleted before pty.spawn, and nothing failed loudly.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripClaudeSessionMarkers,
  withColorSupport,
  buildSessionEnv,
  withoutHeader,
  SHIM_TOKEN_HEADER,
} = require('../src/sessionenv');

test('stripClaudeSessionMarkers removes inherited session markers', () => {
  const env = stripClaudeSessionMarkers({
    PATH: '/bin',
    CLAUDECODE: '1',
    CLAUDE_PID: '42',
    AI_AGENT: 'claude',
    CLAUDE_EFFORT: 'high',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    ANTHROPIC_BASE_URL: 'http://localhost:1234',
  });
  assert.deepEqual(env, { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://localhost:1234' });
});

test('withColorSupport clears color suppression but keeps a deliberate COLORTERM', () => {
  const env = withColorSupport({ NO_COLOR: '1', FORCE_COLOR: '0', COLORTERM: '24bit' });
  assert.deepEqual(env, { TERM: 'xterm-256color', COLORTERM: '24bit' });
  assert.equal(withColorSupport({ FORCE_COLOR: '3' }).FORCE_COLOR, '3');
  assert.equal(withColorSupport({}).COLORTERM, 'truecolor');
});

test('buildSessionEnv strips markers from the inherited env only', () => {
  const env = buildSessionEnv(
    { PATH: '/bin', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '999' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.3' },
    { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '131072' },
  );
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'glm-5.3');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '131072');
  assert.equal(env.PATH, '/bin');
});

test('buildSessionEnv applies layers in order and skips empty ones', () => {
  const env = buildSessionEnv(
    { ANTHROPIC_MODEL: 'inherited' },
    { ANTHROPIC_MODEL: 'profile' },
    null,
    undefined,
    { ANTHROPIC_MODEL: 'override' },
  );
  assert.equal(env.ANTHROPIC_MODEL, 'override');
});

test('buildSessionEnv never mutates its inputs', () => {
  const inherited = Object.freeze({ CLAUDECODE: '1', PATH: '/bin' });
  const layer = Object.freeze({ X: '1' });
  const env = buildSessionEnv(inherited, layer);
  assert.deepEqual(env, { PATH: '/bin', X: '1' });
  assert.notEqual(env, inherited);
});

test('an inherited shim token line is stripped, other custom headers stay', () => {
  const env = buildSessionEnv({ ANTHROPIC_CUSTOM_HEADERS: `X-Team: luna\r\n${SHIM_TOKEN_HEADER.toUpperCase()}: parent-token` });
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, 'X-Team: luna');
  const only = buildSessionEnv({ ANTHROPIC_CUSTOM_HEADERS: ` ${SHIM_TOKEN_HEADER} : parent-token\n` });
  assert.equal('ANTHROPIC_CUSTOM_HEADERS' in only, false);
});

test('a layer can still set the shim header on purpose', () => {
  const env = buildSessionEnv(
    { ANTHROPIC_CUSTOM_HEADERS: `${SHIM_TOKEN_HEADER}: parent-token` },
    { ANTHROPIC_CUSTOM_HEADERS: `${SHIM_TOKEN_HEADER}: own-token` },
  );
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, `${SHIM_TOKEN_HEADER}: own-token`);
});

test('withoutHeader drops one header by name and blank lines, nothing else', () => {
  assert.equal(withoutHeader('A: 1\n\nB: 2\nb: 3', 'b'), 'A: 1');
  assert.equal(withoutHeader('A: 1', 'b'), 'A: 1');
  assert.equal(withoutHeader(undefined, 'b'), '');
  assert.equal(withoutHeader(42, 'b'), '');
});

test('buildSessionEnv tolerates a missing inherited env', () => {
  assert.deepEqual(buildSessionEnv(null, { A: '1' }), { A: '1' });
});
