// Tests for the LM Studio CLI (`lms`) wrapper's pure functions - the parsers
// and the argv builder. The impure execFile-calling functions (detectLmsCli,
// listDownloadedModels, loadModel) are left untested per the repo's existing
// convention for process-exec code (see src/ask.js's runAsk).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDownloadedModels, parseLoadedModels, buildLoadArgs, loadModel } = require('../src/lmstudiocli');

// Real sample captured from `lms ls --json` on a live LM Studio install -
// see this session's Bash output. Kept verbatim (fields only) so a schema
// change upstream shows up as a real test failure, not a guess.
const SAMPLE_LS_JSON = JSON.stringify([
  {
    type: 'llm',
    modelKey: 'qwen3-32b',
    format: 'gguf',
    displayName: 'Qwen3 32B',
    publisher: 'lmstudio-community',
    path: 'lmstudio-community/Qwen3-32B-GGUF/Qwen3-32B-Q4_K_M.gguf',
    sizeBytes: 7207779112,
    indexedModelIdentifier: 'lmstudio-community/Qwen3-32B-GGUF/Qwen3-32B-Q4_K_M.gguf',
    deviceIdentifier: null,
    paramsString: '32B',
    architecture: 'qwen3',
    quantization: { name: 'Q4_K_M', bits: 4 },
    vision: false,
    trainedForToolUse: true,
    maxContextLength: 32768,
  },
  {
    type: 'embedding',
    modelKey: 'text-embedding-nomic-embed-text-v1.5',
    format: 'gguf',
    displayName: 'Nomic Embed Text v1.5',
    publisher: 'nomic-ai',
    path: 'nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q4_K_M.gguf',
    sizeBytes: 84106624,
    indexedModelIdentifier: 'nomic-ai/nomic-embed-text-v1.5-GGUF/nomic-embed-text-v1.5.Q4_K_M.gguf',
    deviceIdentifier: null,
    architecture: 'nomic-bert',
    quantization: { name: 'Q4_K_M', bits: 4 },
    maxContextLength: 2048,
  },
]);

// Real sample captured from `lms ps --json` on the same install.
const SAMPLE_PS_JSON = JSON.stringify([
  {
    type: 'llm',
    modelKey: 'qwen/qwen3-coder-30b',
    displayName: 'Qwen3 Coder 30B',
    identifier: 'qwen/qwen3-coder-30b',
    ttlMs: null,
    lastUsedTime: 1789980074677,
    maxContextLength: 262144,
    contextLength: 194231,
    status: 'idle',
    queued: 0,
  },
]);

test('parseDownloadedModels normalizes a real lms ls --json sample', () => {
  const models = parseDownloadedModels(SAMPLE_LS_JSON);
  assert.deepEqual(models, [
    {
      key: 'qwen3-32b',
      type: 'llm',
      displayName: 'Qwen3 32B',
      publisher: 'lmstudio-community',
      sizeBytes: 7207779112,
      paramsString: '32B',
      architecture: 'qwen3',
      quantization: 'Q4_K_M',
      maxContextLength: 32768,
      vision: false,
    },
    {
      key: 'text-embedding-nomic-embed-text-v1.5',
      type: 'embedding',
      displayName: 'Nomic Embed Text v1.5',
      publisher: 'nomic-ai',
      sizeBytes: 84106624,
      paramsString: '',
      architecture: 'nomic-bert',
      quantization: 'Q4_K_M',
      maxContextLength: 2048,
      vision: false,
    },
  ]);
});

test('parseDownloadedModels drops entries with no modelKey', () => {
  const models = parseDownloadedModels(JSON.stringify([{ type: 'llm', displayName: 'No key' }]));
  assert.deepEqual(models, []);
});

test('parseDownloadedModels drops entries with an unrecognized type', () => {
  const models = parseDownloadedModels(
    JSON.stringify([{ type: 'vae', modelKey: 'weird-model', displayName: 'Weird' }])
  );
  assert.deepEqual(models, []);
});

test('parseDownloadedModels tolerates a missing/malformed quantization', () => {
  const models = parseDownloadedModels(
    JSON.stringify([{ type: 'llm', modelKey: 'x', displayName: 'X', quantization: null }])
  );
  assert.equal(models[0].quantization, '');
});

test('parseDownloadedModels returns [] for malformed input', () => {
  assert.deepEqual(parseDownloadedModels('not json'), []);
  assert.deepEqual(parseDownloadedModels(JSON.stringify({ not: 'an array' })), []);
  assert.deepEqual(parseDownloadedModels(''), []);
  assert.deepEqual(parseDownloadedModels(null), []);
});

test('parseLoadedModels normalizes a real lms ps --json sample', () => {
  const loaded = parseLoadedModels(SAMPLE_PS_JSON);
  assert.deepEqual(loaded, [
    {
      key: 'qwen/qwen3-coder-30b',
      identifier: 'qwen/qwen3-coder-30b',
      status: 'idle',
      contextLength: 194231,
    },
  ]);
});

test('parseLoadedModels drops entries with no modelKey and returns [] for malformed input', () => {
  assert.deepEqual(parseLoadedModels(JSON.stringify([{ status: 'idle' }])), []);
  assert.deepEqual(parseLoadedModels('not json'), []);
  assert.deepEqual(parseLoadedModels(JSON.stringify({ not: 'an array' })), []);
});

test('buildLoadArgs builds the minimal argv for just a model key', () => {
  assert.deepEqual(buildLoadArgs({ modelKey: 'qwen3-32b' }), ['load', 'qwen3-32b', '-y']);
});

test('buildLoadArgs trims the model key', () => {
  assert.deepEqual(buildLoadArgs({ modelKey: '  qwen3-32b  ' }), ['load', 'qwen3-32b', '-y']);
});

test('buildLoadArgs returns null when modelKey is missing, blank, or not a string', () => {
  assert.equal(buildLoadArgs({}), null);
  assert.equal(buildLoadArgs({ modelKey: '' }), null);
  assert.equal(buildLoadArgs({ modelKey: '   ' }), null);
  assert.equal(buildLoadArgs({ modelKey: 42 }), null);
  assert.equal(buildLoadArgs(undefined), null);
});

test('buildLoadArgs tolerates a null/non-object opts instead of throwing', () => {
  assert.equal(buildLoadArgs(null), null);
  assert.equal(buildLoadArgs('nope'), null);
  assert.equal(buildLoadArgs(42), null);
});

test('buildLoadArgs rejects a modelKey or identifier shaped like a flag', () => {
  assert.equal(buildLoadArgs({ modelKey: '--gpu' }), null);
  assert.equal(buildLoadArgs({ modelKey: '-y' }), null);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', identifier: '--identifier' }), ['load', 'x', '-y']);
});

test('buildLoadArgs adds --identifier only when given a non-blank string', () => {
  assert.deepEqual(
    buildLoadArgs({ modelKey: 'x', identifier: 'my-model' }),
    ['load', 'x', '-y', '--identifier', 'my-model']
  );
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', identifier: '   ' }), ['load', 'x', '-y']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', identifier: 42 }), ['load', 'x', '-y']);
});

test('buildLoadArgs accepts --gpu "off", "max", or a 0-1 number - nothing else', () => {
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: 'off' }), ['load', 'x', '-y', '--gpu', 'off']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: 'max' }), ['load', 'x', '-y', '--gpu', 'max']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: 0.5 }), ['load', 'x', '-y', '--gpu', '0.5']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: 0 }), ['load', 'x', '-y', '--gpu', '0']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: 1 }), ['load', 'x', '-y', '--gpu', '1']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: 1.5 }), ['load', 'x', '-y']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: -0.1 }), ['load', 'x', '-y']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', gpu: 'full' }), ['load', 'x', '-y']);
});

test('buildLoadArgs adds --ttl only for a positive finite number, rounded', () => {
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', ttlSeconds: 300 }), ['load', 'x', '-y', '--ttl', '300']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', ttlSeconds: 30.6 }), ['load', 'x', '-y', '--ttl', '31']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', ttlSeconds: 0 }), ['load', 'x', '-y']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', ttlSeconds: -5 }), ['load', 'x', '-y']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', ttlSeconds: Infinity }), ['load', 'x', '-y']);
  assert.deepEqual(buildLoadArgs({ modelKey: 'x', ttlSeconds: 'soon' }), ['load', 'x', '-y']);
});

test('buildLoadArgs combines every optional flag in a stable order', () => {
  assert.deepEqual(
    buildLoadArgs({ modelKey: 'x', identifier: 'id1', gpu: 'max', ttlSeconds: 60 }),
    ['load', 'x', '-y', '--identifier', 'id1', '--gpu', 'max', '--ttl', '60']
  );
});

test('loadModel(null) resolves with a typed reason instead of rejecting/throwing', async () => {
  // Regression guard: buildLoadArgs(null) used to throw while destructuring,
  // which turned into a REJECTED promise here - breaking this module's own
  // "always resolves" contract. See this file's header.
  const result = await loadModel(null);
  assert.deepEqual(result, { ok: false, reason: 'missing-model-key' });
});

// loadModel's in-flight ("busy") guard is not covered by a unit test here -
// exercising it for real means two concurrent `lms` execFile calls, which
// would make this test suite depend on `lms` actually being installed on
// whatever machine runs `node --test` (this app ships publicly). Left
// untested per this file's own convention for exec-touching behavior,
// verified instead by code review + the manual checklist.
