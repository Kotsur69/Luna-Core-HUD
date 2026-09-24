// ============================================================================
// LunaCore - LM Studio load form tests (src/renderer/modules/lmstudioloadform.js)
// ----------------------------------------------------------------------------
// The pure half of the Settings model picker: a row's raw input strings ->
// the payload src/lmstudiosdk.js's buildLoadRequest() validates. Blank means
// "LM Studio decides" and must be omitted, never sent as 0/''/false.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { blankOptions, buildLoadPayload } = require('../src/renderer/modules/lmstudioloadform.js');
const { buildLoadRequest } = require('../src/lmstudiosdk');

test('a blank form loads with every setting left to LM Studio', () => {
  assert.deepEqual(buildLoadPayload('m', blankOptions(), { replaceLoaded: true }), { modelKey: 'm', replaceLoaded: true });
});

test('a filled form maps onto the SDK option names and numbers', () => {
  const opts = {
    ...blankOptions(),
    contextLength: '131072',
    gpu: 'max',
    expertOffload: '0.85',
    flashAttention: 'on',
    kvCacheType: 'q8_0',
    evalBatchSize: '2048',
    parallel: '1',
    ttlSeconds: '600',
    identifier: ' coder ',
  };
  const payload = buildLoadPayload('qwen/qwen3-coder-next', opts, { replaceLoaded: false });
  assert.deepEqual(payload, {
    modelKey: 'qwen/qwen3-coder-next',
    replaceLoaded: false,
    contextLength: 131072,
    gpu: 'max',
    expertOffload: 0.85,
    flashAttention: true,
    kvCacheType: 'q8_0',
    evalBatchSize: 2048,
    parallel: 1,
    ttlSeconds: 600,
    identifier: 'coder',
  });
  assert.equal(buildLoadRequest(payload).ok, true, 'the main-side validator accepts it');
});

test('custom GPU ratio, flash attention off, and junk numbers', () => {
  const p = buildLoadPayload('m', { ...blankOptions(), gpu: 'custom', gpuRatio: '0.5', flashAttention: 'off', contextLength: 'abc', parallel: '-2' }, { replaceLoaded: true });
  assert.equal(p.gpu, 0.5);
  assert.equal(p.flashAttention, false);
  assert.equal('contextLength' in p, false);
  assert.equal('parallel' in p, false);
  const outOfRange = buildLoadPayload('m', { ...blankOptions(), gpu: 'custom', gpuRatio: '3', expertOffload: '2' }, { replaceLoaded: true });
  assert.equal('gpu' in outOfRange, false);
  assert.equal('expertOffload' in outOfRange, false);
});

test('unknown select values are dropped rather than forwarded', () => {
  const p = buildLoadPayload('m', { ...blankOptions(), kvCacheType: 'q2_k', flashAttention: 'maybe', gpu: 'huge' }, { replaceLoaded: true });
  assert.deepEqual(p, { modelKey: 'm', replaceLoaded: true });
});

test('every new load-option string has a pl and en translation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  const enAt = src.indexOf('\n  en: {');
  const pl = src.slice(0, enAt);
  const en = src.slice(enAt);
  for (const key of [
    'lmstudio.status.running',
    'lmstudio.status.canWake',
    'lmstudio.status.notRunning',
    'lmstudio.load.notRunning',
    'lmstudio.load.invalid',
    'lmstudio.load.unknownModel',
    'lmstudio.loaded',
    'lmstudio.replaceLoaded',
    'lmstudio.replaceLoaded.hint',
    'lmstudio.options.expertOffload',
    'lmstudio.options.flashAttention',
    'lmstudio.options.kvCache',
    'lmstudio.options.evalBatch',
    'lmstudio.options.on',
    'lmstudio.options.off',
    'lmstudio.options.threadsHint',
  ]) {
    assert.ok(pl.includes(`'${key}':`), `missing pl translation: ${key}`);
    assert.ok(en.includes(`'${key}':`), `missing en translation: ${key}`);
  }
});
