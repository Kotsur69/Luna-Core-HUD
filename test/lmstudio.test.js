// ============================================================================
// LunaCore - local model endpoint tests (src/lmstudio.js)
// ----------------------------------------------------------------------------
// The parsers and the three decisions (is this endpoint local, is this base URL
// the /v1 trap, which model would a session actually get) are pure, so they are
// pinned here. probeEndpoint/LocalModelWatcher touch the network and are not -
// same split mcphealth.test.js uses for its handshake.
//
// The `/v1` case is the one that matters most: shipping it is what kept the LM
// Studio profile from ever connecting, and the whole point of a test is that it
// cannot be re-introduced quietly.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeBaseUrl,
  localEndpointFromProfile,
  baseUrlWarning,
  parseModels,
  normalizeModel,
  pickLoadedModel,
  resolveAutoModel,
  LocalModelWatcher,
} = require('../src/lmstudio');

test('normalizeBaseUrl strips a trailing /v1 - Claude Code appends its own', () => {
  assert.strictEqual(normalizeBaseUrl('http://localhost:1234/v1'), 'http://localhost:1234');
  assert.strictEqual(normalizeBaseUrl('http://localhost:1234/v1/'), 'http://localhost:1234');
  assert.strictEqual(normalizeBaseUrl('http://localhost:1234/'), 'http://localhost:1234');
  assert.strictEqual(normalizeBaseUrl('http://localhost:1234'), 'http://localhost:1234');
});

test('normalizeBaseUrl keeps a real path prefix that is not /v1', () => {
  assert.strictEqual(normalizeBaseUrl('http://localhost:8080/api'), 'http://localhost:8080/api');
});

test('normalizeBaseUrl rejects junk and non-http schemes', () => {
  assert.strictEqual(normalizeBaseUrl(''), '');
  assert.strictEqual(normalizeBaseUrl('not a url'), '');
  assert.strictEqual(normalizeBaseUrl('file:///etc/passwd'), '');
  assert.strictEqual(normalizeBaseUrl(null), '');
});

test('localEndpointFromProfile only claims genuinely local endpoints', () => {
  const local = { env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' } };
  const loopback = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' } };
  const remote = { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } };

  assert.strictEqual(localEndpointFromProfile(local), 'http://localhost:1234');
  assert.strictEqual(localEndpointFromProfile(loopback), 'http://127.0.0.1:11434');
  assert.strictEqual(localEndpointFromProfile(remote), null);
  assert.strictEqual(localEndpointFromProfile({ env: {} }), null);
  assert.strictEqual(localEndpointFromProfile(null), null);
});

test('localEndpointFromProfile normalizes the /v1 form it is handed', () => {
  const profile = { env: { ANTHROPIC_BASE_URL: 'http://localhost:1234/v1' } };
  assert.strictEqual(localEndpointFromProfile(profile), 'http://localhost:1234');
});

test('baseUrlWarning catches the /v1 trap that broke the shipped profile', () => {
  assert.strictEqual(baseUrlWarning({ env: { ANTHROPIC_BASE_URL: 'http://localhost:1234/v1' } }), 'double-v1');
  assert.strictEqual(baseUrlWarning({ env: { ANTHROPIC_BASE_URL: 'http://localhost:1234/v1/' } }), 'double-v1');
  assert.strictEqual(baseUrlWarning({ env: { ANTHROPIC_BASE_URL: 'http://localhost:1234' } }), null);
  assert.strictEqual(baseUrlWarning({ env: {} }), null);
});

test('the shipped LM Studio profile is free of the /v1 trap', () => {
  // Reads the real config, not a fixture: the regression this guards against is
  // someone "fixing" the config back to the OpenAI-compat URL.
  const { profiles } = require('../src/profiles').loadProfiles();
  const lm = profiles.find((p) => p.id === 'lm-studio');
  assert.ok(lm, 'lm-studio profile is missing from config/profiles.json');
  assert.strictEqual(baseUrlWarning(lm), null);
  assert.strictEqual(lm.env.ANTHROPIC_BASE_URL, 'http://localhost:1234');
  // LM Studio wants a non-empty key even when it validates nothing.
  assert.ok(lm.env.ANTHROPIC_AUTH_TOKEN, 'LM Studio needs a non-empty auth token');
  assert.strictEqual(lm.autoModel, true);
});

test('normalizeModel maps a v0 row, load state and all', () => {
  const row = normalizeModel({
    id: 'openai/gpt-oss-20b',
    type: 'llm',
    quantization: 'MXFP4',
    state: 'loaded',
    max_context_length: 131072,
    loaded_context_length: 32768,
  });
  assert.deepStrictEqual(row, {
    id: 'openai/gpt-oss-20b',
    type: 'llm',
    quantization: 'MXFP4',
    loaded: true,
    maxContext: 131072,
    loadedContext: 32768,
  });
});

test('normalizeModel reports unknown load state as null, not false', () => {
  // /v1/models (Ollama, vLLM, LM Studio's OpenAI route) has no `state` field.
  // Rendering "not loaded" there would put a red warning on a healthy server.
  const row = normalizeModel({ id: 'llama3', object: 'model' });
  assert.strictEqual(row.loaded, null);
  assert.strictEqual(row.maxContext, null);
});

test('normalizeModel rejects rows without an id', () => {
  assert.strictEqual(normalizeModel({ state: 'loaded' }), null);
  assert.strictEqual(normalizeModel(null), null);
  assert.strictEqual(normalizeModel('nope'), null);
});

test('parseModels survives every shape a dead endpoint can hand back', () => {
  assert.deepStrictEqual(parseModels('not json'), []);
  assert.deepStrictEqual(parseModels(''), []);
  assert.deepStrictEqual(parseModels('{}'), []);
  assert.deepStrictEqual(parseModels('{"data":null}'), []);
  assert.deepStrictEqual(parseModels('{"data":[{"no":"id"}]}'), []);
});

test('parseModels reads a real v0 payload', () => {
  const body = JSON.stringify({
    object: 'list',
    data: [
      { id: 'text-embedding-nomic', type: 'embeddings', state: 'loaded' },
      { id: 'qwen/qwen3-coder-30b', type: 'llm', state: 'loaded', max_context_length: 262144 },
      { id: 'google/gemma-3-27b', type: 'llm', state: 'not-loaded' },
    ],
  });
  const models = parseModels(body);
  assert.strictEqual(models.length, 3);
  assert.strictEqual(models[1].maxContext, 262144);
  assert.strictEqual(models[2].loaded, false);
});

test('pickLoadedModel skips a loaded EMBEDDING model', () => {
  // LM Studio keeps one loaded next to an LLM as a matter of course. Handing
  // its id to Claude Code fails in a way that looks like a broken endpoint.
  const models = parseModels(
    JSON.stringify({
      data: [
        { id: 'text-embedding-nomic', type: 'embeddings', state: 'loaded' },
        { id: 'qwen/qwen3-coder-30b', type: 'llm', state: 'loaded' },
      ],
    }),
  );
  assert.strictEqual(pickLoadedModel(models).id, 'qwen/qwen3-coder-30b');
});

test('pickLoadedModel returns null when the server is up but idle', () => {
  const models = parseModels(JSON.stringify({ data: [{ id: 'a', type: 'llm', state: 'not-loaded' }] }));
  assert.strictEqual(pickLoadedModel(models), null);
  assert.strictEqual(pickLoadedModel([]), null);
  assert.strictEqual(pickLoadedModel(null), null);
});

test('resolveAutoModel only fires for a profile that opted in', () => {
  const snapshot = { models: parseModels(JSON.stringify({ data: [{ id: 'qwen', type: 'llm', state: 'loaded' }] })) };
  assert.strictEqual(resolveAutoModel({ autoModel: true, env: {} }, snapshot), 'qwen');
  assert.strictEqual(resolveAutoModel({ autoModel: false, env: {} }, snapshot), null);
  assert.strictEqual(resolveAutoModel({ env: {} }, snapshot), null);
  assert.strictEqual(resolveAutoModel(null, snapshot), null);
});

test('resolveAutoModel never overrides a model the profile named itself', () => {
  const snapshot = { models: parseModels(JSON.stringify({ data: [{ id: 'qwen', type: 'llm', state: 'loaded' }] })) };
  const explicit = { autoModel: true, env: { ANTHROPIC_MODEL: 'mistral' } };
  assert.strictEqual(resolveAutoModel(explicit, snapshot), null);
});

test('resolveAutoModel returns null when nothing is loaded to name', () => {
  assert.strictEqual(resolveAutoModel({ autoModel: true, env: {} }, null), null);
  assert.strictEqual(resolveAutoModel({ autoModel: true, env: {} }, { models: [] }), null);
});

test('watcher idles - and clears - when pointed at no endpoint', () => {
  const pushed = [];
  const w = new LocalModelWatcher(50, (state) => pushed.push(state));
  // Switching AWAY from a live local endpoint - the Claude Cloud case.
  w.endpoint = 'http://localhost:1234';
  w.latest = { up: true };
  w.setEndpoint(null);
  assert.strictEqual(w.timer, null, 'no timer should be left running');
  assert.strictEqual(w.current(), null, 'a stale reading must not survive the switch');
  assert.deepStrictEqual(pushed, [null], 'the renderer must be told the tile is empty');
});

test('watcher ignores a set to the endpoint it already has', () => {
  const w = new LocalModelWatcher(50, () => {});
  w.endpoint = 'http://localhost:1234';
  w.latest = { up: true };
  w.setEndpoint('http://localhost:1234/v1'); // same origin once normalized
  assert.deepStrictEqual(w.latest, { up: true }, 'an identical endpoint must not reset state');
  w.stop();
});
