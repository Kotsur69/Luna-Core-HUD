// ============================================================================
// LunaCore - overnight guard tests (src/overnight.js)
// ----------------------------------------------------------------------------
// The main-process half of a God Mode run: keep the machine awake, stop the
// renderer's background throttling, and watch a local LM Studio backend so a
// dead server or an unloaded model is brought back without Mati. Everything
// is injected (blocker, webContents, probe, recover, timers), so no Electron
// and no LM Studio are touched here.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createOvernightGuard,
  recoverLocalBackend,
  isBackendHealthy,
  MAX_RECOVERY_ATTEMPTS,
} = require('../src/overnight');

const LOADED = { up: true, models: [{ id: 'qwen/qwen3-coder-next', type: 'llm', loaded: true }] };
const IDLE = { up: true, models: [{ id: 'qwen/qwen3-coder-next', type: 'llm', loaded: false }] };
const DOWN = { up: false, models: [] };

function fakeBlocker() {
  const started = new Set();
  let next = 0;
  return {
    started,
    start: (type) => { assert.strictEqual(type, 'prevent-app-suspension'); next += 1; started.add(next); return next; },
    stop: (id) => started.delete(id),
    isStarted: (id) => started.has(id),
  };
}

function fakeWebContents() {
  return { throttling: true, setBackgroundThrottling(v) { this.throttling = v; }, isDestroyed: () => false };
}

/** Manual timers: nothing fires until the test says so. */
function fakeTimers() {
  const intervals = new Map();
  const timeouts = new Map();
  let next = 0;
  return {
    intervals,
    timeouts,
    setInterval: (fn) => { next += 1; intervals.set(next, fn); return next; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { next += 1; timeouts.set(next, fn); return next; },
    clearTimeout: (id) => timeouts.delete(id),
    async fireTimeouts() {
      const fns = [...timeouts.values()];
      timeouts.clear();
      for (const fn of fns) await fn();
    },
  };
}

function setup({ probes = [], recover = async () => ({ ok: true, action: 'reload' }), local = 'http://localhost:1234' } = {}) {
  const blocker = fakeBlocker();
  const wc = fakeWebContents();
  const timers = fakeTimers();
  const signals = [];
  const recoverCalls = [];
  const queue = [...probes];
  const guard = createOvernightGuard({
    blocker,
    getWebContents: () => wc,
    resolveLocal: () => local,
    probe: async () => (queue.length > 1 ? queue.shift() : queue[0] || LOADED),
    recover: async (ctx) => { recoverCalls.push(ctx); return recover(ctx); },
    signal: (sessionId, type) => signals.push([sessionId, type]),
    timers,
  });
  return { guard, blocker, wc, timers, signals, recoverCalls };
}

test('isBackendHealthy needs a loaded model when the server reports load state', () => {
  assert.strictEqual(isBackendHealthy(LOADED), true);
  assert.strictEqual(isBackendHealthy(IDLE), false);
  assert.strictEqual(isBackendHealthy(DOWN), false);
  assert.strictEqual(isBackendHealthy(null), false);
  // /v1/models carries no load state: an answering server is the best we know.
  assert.strictEqual(isBackendHealthy({ up: true, models: [{ id: 'x', type: '', loaded: null }] }), true);
});

test('a run keeps the machine awake and stops background throttling until it ends', async () => {
  const { guard, blocker, wc } = setup();
  guard.setRun('s1');
  assert.strictEqual(blocker.started.size, 1);
  assert.strictEqual(wc.throttling, false);
  guard.setRun(null);
  assert.strictEqual(blocker.started.size, 0);
  assert.strictEqual(wc.throttling, true);
});

test('re-reporting the same run does not stack blockers', () => {
  const { guard, blocker } = setup();
  guard.setRun('s1');
  guard.setRun('s1');
  assert.strictEqual(blocker.started.size, 1);
  guard.setRun('s2');
  assert.strictEqual(blocker.started.size, 1);
  guard.stop();
  assert.strictEqual(blocker.started.size, 0);
});

test('a cloud tab gets keep-awake but no backend watchdog', () => {
  const { guard, timers, blocker } = setup({ local: null });
  guard.setRun('s1');
  assert.strictEqual(blocker.started.size, 1);
  assert.strictEqual(timers.intervals.size, 0);
});

test('a healthy backend is left alone', async () => {
  const { guard, signals, recoverCalls } = setup({ probes: [LOADED] });
  guard.setRun('s1');
  await guard.check();
  await guard.check();
  assert.deepStrictEqual(signals, []);
  assert.strictEqual(recoverCalls.length, 0);
});

test('one bad probe is only confirmed, never acted on', async () => {
  const { guard, timers, signals, recoverCalls } = setup({ probes: [LOADED, DOWN, LOADED] });
  guard.setRun('s1');
  await guard.check(); // healthy
  await guard.check(); // down once -> schedules a confirmation
  assert.strictEqual(timers.timeouts.size, 1);
  await timers.fireTimeouts(); // healthy again
  assert.deepStrictEqual(signals, []);
  assert.strictEqual(recoverCalls.length, 0);
});

test('a confirmed outage recovers the last model and tells God Mode', async () => {
  const { guard, timers, signals, recoverCalls } = setup({ probes: [LOADED, DOWN, DOWN, LOADED] });
  guard.setRun('s1');
  await guard.check();
  await guard.check();
  await timers.fireTimeouts();
  assert.deepStrictEqual(signals, [['s1', 'backendRecovering'], ['s1', 'backendRecovered']]);
  assert.strictEqual(recoverCalls.length, 1);
  assert.strictEqual(recoverCalls[0].modelKey, 'qwen/qwen3-coder-next');
});

test('recovery gives up after the attempt budget and reports the backend lost', async () => {
  const { guard, timers, signals, recoverCalls } = setup({
    probes: [DOWN],
    recover: async () => ({ ok: false, reason: 'not-running' }),
  });
  guard.setRun('s1');
  for (let i = 0; i < MAX_RECOVERY_ATTEMPTS + 2; i += 1) {
    await guard.check();
    await timers.fireTimeouts();
  }
  assert.strictEqual(recoverCalls.length, MAX_RECOVERY_ATTEMPTS);
  assert.deepStrictEqual(signals, [['s1', 'backendRecovering'], ['s1', 'backendLost']]);
  assert.strictEqual(timers.intervals.size, 0, 'watchdog stops once the backend is lost');
});

test('a connection error triggers an immediate check', async () => {
  const { guard, timers } = setup({ probes: [DOWN] });
  guard.setRun('s1');
  await guard.onConnectionError('s1');
  assert.strictEqual(timers.timeouts.size, 1, 'the bad probe is already being confirmed');
  await guard.onConnectionError('other-tab');
});

test('a run ended mid-recovery sends no stale signal', async () => {
  let release;
  const { guard, timers, signals } = setup({
    probes: [DOWN],
    recover: () => new Promise((r) => { release = () => r({ ok: true, action: 'reload' }); }),
  });
  guard.setRun('s1');
  await guard.check();
  const confirming = timers.fireTimeouts();
  await new Promise((r) => setImmediate(r));
  guard.setRun(null);
  release();
  await confirming;
  assert.deepStrictEqual(signals, [['s1', 'backendRecovering']]);
});

test('forgetSession ends the run bound to a closed tab', () => {
  const { guard, blocker } = setup();
  guard.setRun('s1');
  guard.forgetSession('s2');
  assert.strictEqual(blocker.started.size, 1);
  guard.forgetSession('s1');
  assert.strictEqual(blocker.started.size, 0);
});

// ---- recoverLocalBackend ----------------------------------------------------

function recoverDeps({ wake = { ok: true }, listed = { ok: true, models: [] }, load = { ok: true, identifier: 'm' } } = {}) {
  const calls = [];
  return {
    calls,
    wake: async () => { calls.push('wake'); return wake; },
    listModels: async () => { calls.push('list'); return listed; },
    load: async (req) => { calls.push(['load', req]); return load; },
  };
}

test('recover only restarts the server when a model is still loaded', async () => {
  const deps = recoverDeps({ listed: { ok: true, models: [{ key: 'm', type: 'llm', loaded: true }] } });
  const r = await recoverLocalBackend({ modelKey: 'm', lastLoad: null, ...deps });
  assert.deepStrictEqual(r, { ok: true, action: 'server' });
  assert.deepStrictEqual(deps.calls, ['wake', 'list']);
});

test('recover reloads with the last Settings load request, options included', async () => {
  const lastLoad = { modelKey: 'm', contextLength: 131072, flashAttention: true };
  const deps = recoverDeps();
  const r = await recoverLocalBackend({ modelKey: 'm', lastLoad, ...deps });
  assert.deepStrictEqual(r, { ok: true, action: 'reload' });
  assert.deepStrictEqual(deps.calls[2], ['load', lastLoad]);
});

test('recover never swaps in a different model from a later Settings load', async () => {
  const lastLoad = { modelKey: 'loaded-for-another-tab', contextLength: 4096 };
  const deps = recoverDeps();
  await recoverLocalBackend({ modelKey: 'run-model', lastLoad, ...deps });
  assert.deepStrictEqual(deps.calls[2], ['load', { modelKey: 'run-model' }]);
});

test('recover uses the Settings load when the run never saw a model loaded', async () => {
  const lastLoad = { modelKey: 'm', contextLength: 131072 };
  const deps = recoverDeps();
  await recoverLocalBackend({ modelKey: null, lastLoad, ...deps });
  assert.deepStrictEqual(deps.calls[2], ['load', lastLoad]);
});

test('recover falls back to the model key it last saw loaded', async () => {
  const deps = recoverDeps();
  await recoverLocalBackend({ modelKey: 'seen', lastLoad: null, ...deps });
  assert.deepStrictEqual(deps.calls[2], ['load', { modelKey: 'seen' }]);
});

test('recover ignores a loaded embedding model', async () => {
  const deps = recoverDeps({ listed: { ok: true, models: [{ key: 'e', type: 'embedding', loaded: true }] } });
  const r = await recoverLocalBackend({ modelKey: 'm', lastLoad: null, ...deps });
  assert.strictEqual(r.action, 'reload');
});

test('recover reports each failure with a typed reason', async () => {
  assert.deepStrictEqual(
    await recoverLocalBackend({ modelKey: 'm', lastLoad: null, ...recoverDeps({ wake: { ok: false, reason: 'not-found' } }) }),
    { ok: false, reason: 'not-found' },
  );
  assert.deepStrictEqual(
    await recoverLocalBackend({ modelKey: 'm', lastLoad: null, ...recoverDeps({ listed: { ok: false, reason: 'not-running' } }) }),
    { ok: false, reason: 'not-running' },
  );
  assert.deepStrictEqual(
    await recoverLocalBackend({ modelKey: null, lastLoad: null, ...recoverDeps() }),
    { ok: false, reason: 'no-model' },
  );
  assert.deepStrictEqual(
    await recoverLocalBackend({ modelKey: 'm', lastLoad: null, ...recoverDeps({ load: { ok: false, reason: 'timeout' } }) }),
    { ok: false, reason: 'timeout' },
  );
});

test('recover never rejects when a dep throws', async () => {
  const r = await recoverLocalBackend({
    modelKey: 'm',
    lastLoad: null,
    wake: async () => { throw new Error('boom'); },
    listModels: async () => ({ ok: true, models: [] }),
    load: async () => ({ ok: true }),
  });
  assert.deepStrictEqual(r, { ok: false, reason: 'error' });
});
