// ============================================================================
// LunaCore - LM Studio SDK control tests (src/lmstudiosdk.js)
// ----------------------------------------------------------------------------
// The SDK client, the greeting probe and the `lms` waker are all injected, so
// nothing here needs LM Studio running. What is pinned down:
//   - buildLoadRequest() only ever lets whitelisted, range-checked options
//     through to the SDK's load config;
//   - ensureRunning() wakes LM Studio only when it is not already up;
//   - loadModel() unloads the other models first (default on), is single-
//     flight, times out, and never rejects.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLoadRequest,
  ensureRunning,
  listModels,
  loadModel,
  KV_CACHE_TYPES,
} = require('../src/lmstudiosdk');

// --- buildLoadRequest ------------------------------------------------------

test('buildLoadRequest maps every supported option onto the SDK load config', () => {
  const r = buildLoadRequest({
    modelKey: 'qwen/qwen3-coder-next',
    identifier: 'coder',
    contextLength: 131072,
    parallel: 1,
    gpu: 'max',
    expertOffload: 0.85,
    flashAttention: true,
    kvCacheType: 'q8_0',
    evalBatchSize: 2048,
    ttlSeconds: 3600,
  });
  assert.equal(r.ok, true);
  assert.equal(r.modelKey, 'qwen/qwen3-coder-next');
  assert.deepEqual(r.loadOpts, {
    identifier: 'coder',
    ttl: 3600,
    config: {
      contextLength: 131072,
      maxParallelPredictions: 1,
      gpu: { ratio: 'max', numCpuExpertLayersRatio: 0.85 },
      flashAttention: true,
      llamaKCacheQuantizationType: 'q8_0',
      llamaVCacheQuantizationType: 'q8_0',
      evalBatchSize: 2048,
    },
  });
});

test('buildLoadRequest leaves out everything left blank (LM Studio decides)', () => {
  const r = buildLoadRequest({ modelKey: 'm', contextLength: null, gpu: undefined, identifier: '  ' });
  assert.deepEqual(r, { ok: true, modelKey: 'm', loadOpts: { config: {} } });
});

test('buildLoadRequest accepts a numeric GPU ratio and a lone expert offload', () => {
  assert.deepEqual(buildLoadRequest({ modelKey: 'm', gpu: 0.5 }).loadOpts.config.gpu, { ratio: 0.5 });
  assert.deepEqual(buildLoadRequest({ modelKey: 'm', expertOffload: 1 }).loadOpts.config.gpu, { numCpuExpertLayersRatio: 1 });
});

test('buildLoadRequest rejects a missing or malformed model key', () => {
  for (const modelKey of [undefined, '', '   ', 42, 'x'.repeat(600), 'a\nb']) {
    assert.deepEqual(buildLoadRequest({ modelKey }), { ok: false, reason: 'missing-model-key' });
  }
  assert.deepEqual(buildLoadRequest(null), { ok: false, reason: 'missing-model-key' });
});

test('buildLoadRequest rejects out-of-range or unknown option values', () => {
  const bad = [
    { contextLength: 0 },
    { contextLength: 1.5 },
    { contextLength: 10_000_000 },
    { parallel: 0 },
    { parallel: 99 },
    { gpu: 'huge' },
    { gpu: 2 },
    { expertOffload: -0.1 },
    { expertOffload: 'max' },
    { flashAttention: 'yes' },
    { kvCacheType: 'q2' },
    { evalBatchSize: 1 },
    { ttlSeconds: -1 },
  ];
  for (const opts of bad) {
    const r = buildLoadRequest({ modelKey: 'm', ...opts });
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.equal(r.reason, 'invalid-option');
    assert.equal(r.field, Object.keys(opts)[0]);
  }
});

test('buildLoadRequest ignores unknown keys instead of forwarding them', () => {
  const r = buildLoadRequest({ modelKey: 'm', llamaCppArgumentsOverride: '--evil', __proto__x: 1 });
  assert.deepEqual(r.loadOpts, { config: {} });
});

test('the K/V cache whitelist is the conservative llama.cpp set', () => {
  assert.deepEqual([...KV_CACHE_TYPES], ['f16', 'q8_0', 'q4_0']);
});

// --- ensureRunning ---------------------------------------------------------

test('ensureRunning returns the port without waking when LM Studio is up', async () => {
  let woke = false;
  const r = await ensureRunning({ findPort: async () => 41343, wake: async () => { woke = true; } });
  assert.deepEqual(r, { ok: true, port: 41343 });
  assert.equal(woke, false);
});

test('ensureRunning wakes LM Studio and polls until it answers', async () => {
  const answers = [null, null, null, 41343];
  let woke = 0;
  const r = await ensureRunning({
    findPort: async () => (answers.length ? answers.shift() : 41343),
    wake: async () => { woke += 1; return { ok: true }; },
    waitMs: 1000,
    pollMs: 1,
  });
  assert.deepEqual(r, { ok: true, port: 41343 });
  assert.equal(woke, 1);
});

test('ensureRunning reports not-running when waking fails or times out', async () => {
  const noWake = await ensureRunning({ findPort: async () => null, wake: async () => ({ ok: false, reason: 'not-found' }), waitMs: 20, pollMs: 1 });
  assert.deepEqual(noWake, { ok: false, reason: 'not-running' });
  const never = await ensureRunning({ findPort: async () => null, wake: async () => ({ ok: true }), waitMs: 20, pollMs: 5 });
  assert.deepEqual(never, { ok: false, reason: 'not-running' });
  const noWakeAllowed = await ensureRunning({ findPort: async () => null, wake: null });
  assert.deepEqual(noWakeAllowed, { ok: false, reason: 'not-running' });
});

// --- fake SDK client -------------------------------------------------------

const DEFAULT_DOWNLOADED = ['m', 'qwen/qwen3-coder-next', 'qwen3-32b'].map((modelKey) => ({ type: 'llm', modelKey }));

function fakeClient({ downloaded = DEFAULT_DOWNLOADED, loaded = [], loadImpl } = {}) {
  const calls = { unloaded: [], loads: [], disposed: 0 };
  const handles = loaded.map((m) => ({
    identifier: m.identifier || m.modelKey,
    modelKey: m.modelKey,
    unload: async () => { calls.unloaded.push(m.modelKey); },
  }));
  const client = {
    system: { listDownloadedModels: async () => downloaded },
    llm: {
      listLoaded: async () => handles,
      load: async (key, opts) => {
        calls.loads.push({ key, opts });
        if (loadImpl) return loadImpl(key, opts);
        return { identifier: key };
      },
    },
    embedding: { listLoaded: async () => [] },
    [Symbol.asyncDispose]: async () => { calls.disposed += 1; },
  };
  return { client, calls };
}

const qwenRow = {
  type: 'llm', modelKey: 'qwen/qwen3-coder-next', displayName: 'Qwen3 Coder Next', publisher: 'qwen',
  sizeBytes: 45e9, paramsString: '80B', architecture: 'qwen3next', quantization: { name: 'Q4_K_M', bits: 4 },
  vision: false, maxContextLength: 262144,
};
const smallRow = { ...qwenRow, modelKey: 'qwen3-32b', displayName: 'Qwen3 32B', paramsString: '32B' };
const up = { ensure: async () => ({ ok: true, port: 41343 }) };

// --- listModels ------------------------------------------------------------

test('listModels maps downloaded rows to the panel shape and marks loaded ones', async () => {
  const { client, calls } = fakeClient({ downloaded: [qwenRow, smallRow, { junk: true }], loaded: [{ modelKey: 'qwen/qwen3-coder-next' }] });
  const r = await listModels({ ...up, openClient: () => client });
  assert.equal(r.ok, true);
  assert.equal(r.models.length, 2);
  assert.equal(r.models[0].key, 'qwen/qwen3-coder-next');
  assert.equal(r.models[0].quantization, 'Q4_K_M');
  assert.equal(r.models[0].loaded, true);
  assert.equal(r.models[1].loaded, false);
  assert.equal(calls.disposed, 1);
});

test('listModels surfaces not-running and SDK errors as typed results', async () => {
  assert.deepEqual(await listModels({ ensure: async () => ({ ok: false, reason: 'not-running' }), openClient: () => null }), { ok: false, reason: 'not-running' });
  const broken = { system: { listDownloadedModels: async () => { throw new Error('socket'); } }, [Symbol.asyncDispose]: async () => {} };
  assert.deepEqual(await listModels({ ...up, openClient: () => broken }), { ok: false, reason: 'error' });
});

// --- loadModel -------------------------------------------------------------

test('loadModel unloads the other loaded models first by default', async () => {
  const { client, calls } = fakeClient({ loaded: [{ modelKey: 'qwen3-32b' }, { modelKey: 'qwen/qwen3-coder-next' }] });
  const r = await loadModel({ modelKey: 'qwen/qwen3-coder-next', contextLength: 131072 }, { ...up, openClient: () => client });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.unloaded.sort(), ['qwen/qwen3-coder-next', 'qwen3-32b']);
  assert.equal(calls.loads.length, 1);
  assert.equal(calls.loads[0].opts.config.contextLength, 131072);
  assert.ok(calls.loads[0].opts.signal, 'load gets an abort signal');
  assert.equal(calls.disposed, 1);
});

test('loadModel keeps other models when replaceLoaded is off', async () => {
  const { client, calls } = fakeClient({ loaded: [{ modelKey: 'qwen3-32b' }] });
  const r = await loadModel({ modelKey: 'm', replaceLoaded: false }, { ...up, openClient: () => client });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.unloaded, []);
});

test('loadModel rejects invalid input before touching LM Studio', async () => {
  let opened = false;
  const deps = { ...up, openClient: () => { opened = true; return fakeClient().client; } };
  assert.deepEqual(await loadModel({ modelKey: '' }, deps), { ok: false, reason: 'missing-model-key' });
  assert.deepEqual(await loadModel({ modelKey: 'm', kvCacheType: 'zzz' }, deps), { ok: false, reason: 'invalid-option', field: 'kvCacheType' });
  assert.equal(opened, false);
});

test('loadModel is single-flight', async () => {
  let release;
  const { client } = fakeClient({ loadImpl: () => new Promise((r) => { release = r; }) });
  const deps = { ...up, openClient: () => client };
  const first = loadModel({ modelKey: 'm' }, deps);
  while (!release) await new Promise((r) => setImmediate(r));
  assert.deepEqual(await loadModel({ modelKey: 'm' }, deps), { ok: false, reason: 'busy' });
  release({ identifier: 'm' });
  assert.equal((await first).ok, true);
  const { client: fresh } = fakeClient();
  assert.equal((await loadModel({ modelKey: 'm' }, { ...up, openClient: () => fresh })).ok, true, 'lock released after completion');
});

test('loadModel times out and aborts, but holds the lock until the aborted load settles', async () => {
  let signal;
  let settle;
  const { client } = fakeClient({
    loadImpl: (_k, opts) => { signal = opts.signal; return new Promise((_r, reject) => { settle = () => reject(new Error('aborted')); }); },
  });
  const r = await loadModel({ modelKey: 'm' }, { ...up, openClient: () => client, timeoutMs: 20 });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.equal(signal.aborted, true);
  const { client: ok } = fakeClient();
  const okDeps = { ...up, openClient: () => ok };
  assert.deepEqual(await loadModel({ modelKey: 'm' }, okDeps), { ok: false, reason: 'busy' }, 'still finishing');
  settle();
  await new Promise((r2) => setImmediate(r2));
  assert.equal((await loadModel({ modelKey: 'm' }, okDeps)).ok, true);
});

test('a load that ignores the abort frees the lock after the grace period', async () => {
  const { client } = fakeClient({ loadImpl: () => new Promise(() => {}) });
  await loadModel({ modelKey: 'm' }, { ...up, openClient: () => client, timeoutMs: 10, graceMs: 20 });
  await new Promise((r) => setTimeout(r, 40));
  const { client: ok } = fakeClient();
  assert.equal((await loadModel({ modelKey: 'm' }, { ...up, openClient: () => ok })).ok, true);
});

test('loadModel refuses an unknown model before unloading anything', async () => {
  const { client, calls } = fakeClient({ loaded: [{ modelKey: 'qwen/qwen3-coder-next' }] });
  const r = await loadModel({ modelKey: 'typo-model' }, { ...up, openClient: () => client });
  assert.deepEqual(r, { ok: false, reason: 'unknown-model' });
  assert.deepEqual(calls.unloaded, []);
  assert.equal(calls.loads.length, 0);
});

test('loadModel reports not-running and load failures without throwing', async () => {
  assert.deepEqual(
    await loadModel({ modelKey: 'm' }, { ensure: async () => ({ ok: false, reason: 'not-running' }), openClient: () => null }),
    { ok: false, reason: 'not-running' },
  );
  const { client } = fakeClient({ loadImpl: () => { throw new Error('Out of memory while loading\nstack...'); } });
  const r = await loadModel({ modelKey: 'm' }, { ...up, openClient: () => client });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'load-failed');
  assert.match(r.message, /Out of memory/);
});
