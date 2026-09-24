// Tests for the LM Studio CLI (`lms`) wrapper's pure parser. The downloaded-
// model normalizer is shared with src/lmstudiosdk.js (the SDK returns the same
// row shape as `lms ls --json`). The execFile-calling functions (detectLmsCli,
// wakeLmStudio) are left untested per the repo's existing convention for
// process-exec code (see src/ask.js's runAsk).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseDownloadedModels } = require('../src/lmstudiocli');

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
