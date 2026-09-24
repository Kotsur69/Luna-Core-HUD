// ============================================================================
// LunaCore - CCR IPC controller tests (src/ccrcontrol.js)
// ----------------------------------------------------------------------------
// The ccr:* handlers used to live inline in main.js, where nothing could test
// them. The rules they enforce are the ones that matter for safety: LunaCore
// never stops a gateway it did not start, and ccr:test-key only ever sends a
// CCR profile's own client key to its own loopback gateway - never a GLM/Kimi
// key, never a sentinel, and never back across IPC. Every CCR process/network
// call is a fake here; src/ccr.js has its own tests.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCcrControl, CCR_DOCS_URL } = require('../src/ccrcontrol');

const PROVIDERS = [
  { id: 'ollama', wireVia: 'ccr' },
  { id: 'glm', wireVia: 'direct' },
];

const ccrProfile = (env = {}) => ({
  id: 'ollama',
  templateId: 'ollama',
  env: { ANTHROPIC_BASE_URL: 'http://localhost:3456', ANTHROPIC_AUTH_TOKEN: 'ccr-client-key', ...env },
});

/** A fake ipcMain that records handlers so tests can invoke them by channel. */
function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
    emit: (channel, ...args) => listeners.get(channel)({}, ...args),
    channels: () => [...handlers.keys(), ...listeners.keys()].sort(),
  };
}

/** A fake src/ccr.js: every call is recorded, every result is configurable. */
function fakeCcr(over = {}) {
  const calls = [];
  const record = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    return typeof result === 'function' ? result(...args) : result;
  };
  return {
    calls,
    api: {
      detectCcr: record('detectCcr', { ok: true, version: '' }),
      findGateway: record('findGateway', { ok: false, reason: 'not-running' }),
      startGateway: record('startGateway', { ok: true, port: 3456, startedByUs: true }),
      stopGateway: record('stopGateway', (args) => (args && args.startedByUs ? { ok: true, message: '' } : { ok: false, reason: 'not-ours' })),
      openManagementUi: record('openManagementUi', { ok: true }),
      testClientKey: record('testClientKey', { ok: true, models: 2 }),
      gatewayPortFromEnv: require('../src/ccr').gatewayPortFromEnv,
      describeState: require('../src/ccr').describeState,
      ...over,
    },
  };
}

function setup({ profiles = [ccrProfile()], ccr = fakeCcr(), opened = [] } = {}) {
  const sent = [];
  const control = createCcrControl({
    send: (channel, payload) => sent.push([channel, payload]),
    getProfiles: () => profiles,
    getProviders: () => PROVIDERS,
    openExternal: (url) => opened.push(url),
    safeUrl: (url) => url,
    ccrApi: ccr.api,
  });
  const ipc = fakeIpc();
  control.registerIpc(ipc);
  return { control, ipc, sent, ccr, opened };
}

test('registerIpc wires exactly the six ccr channels', () => {
  const { ipc } = setup();
  assert.deepEqual(ipc.channels(), ['ccr:docs', 'ccr:open-ui', 'ccr:start', 'ccr:status', 'ccr:stop', 'ccr:test-key']);
});

test('ccr:stop refuses a gateway LunaCore did not start', async () => {
  const { ipc, ccr } = setup();
  const result = await ipc.invoke('ccr:stop');
  assert.deepEqual(result, { ok: false, reason: 'not-ours' });
  assert.deepEqual(ccr.calls.at(-1), ['stopGateway', { startedByUs: false }]);
});

test('ccr:start then ccr:stop stops the gateway it started and broadcasts both', async () => {
  const { ipc, control, sent } = setup();
  await ipc.invoke('ccr:start');
  assert.equal(control.isStartedByUs(), true);
  const stopped = await ipc.invoke('ccr:stop');
  assert.equal(stopped.ok, true);
  assert.equal(control.isStartedByUs(), false);
  assert.deepEqual(sent.map(([channel, p]) => [channel, p.startedByUs]), [['ccr:state', true], ['ccr:state', false]]);
});

test('ccr:start adopting an already-running gateway does not claim ownership', async () => {
  const ccr = fakeCcr({});
  ccr.api.startGateway = async () => ({ ok: true, port: 3456, startedByUs: false });
  const { ipc, control } = setup({ ccr });
  await ipc.invoke('ccr:start');
  assert.equal(control.isStartedByUs(), false);
});

test('ccr:status reports not-installed without probing any port', async () => {
  const ccr = fakeCcr({});
  ccr.api.detectCcr = async () => ({ ok: false, reason: 'not-found' });
  let probed = false;
  ccr.api.findGateway = async () => { probed = true; return { ok: false }; };
  const { ipc } = setup({ ccr });
  const status = await ipc.invoke('ccr:status');
  assert.equal(status.installed, false);
  assert.equal(status.state, 'not-installed');
  assert.equal(probed, false);
});

test('ccr:status reports a healthy gateway on the expected port', async () => {
  const ccr = fakeCcr({ findGateway: async () => ({ ok: true, port: 3456, classification: 'up', mismatch: false }) });
  const { ipc } = setup({ ccr });
  const status = await ipc.invoke('ccr:status');
  assert.equal(status.installed, true);
  assert.equal(status.state, 'up');
  assert.equal(status.port, 3456);
});

test('ccr:test-key probes the profile gateway with its own key and never echoes it', async () => {
  const { ipc, ccr } = setup({ profiles: [ccrProfile({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3460' })] });
  const result = await ipc.invoke('ccr:test-key', 'ollama');
  assert.deepEqual(result, { ok: true, models: 2 });
  assert.deepEqual(ccr.calls.at(-1), ['testClientKey', 3460, 'ccr-client-key']);
  assert.ok(!JSON.stringify(result).includes('ccr-client-key'));
});

test('ccr:test-key refuses unknown ids and non-string payloads', async () => {
  const { ipc, ccr } = setup();
  for (const bad of ['nope', undefined, null, 42, { id: 'ollama' }]) {
    assert.deepEqual(await ipc.invoke('ccr:test-key', bad), { ok: false, reason: 'unknown-profile' });
  }
  assert.equal(ccr.calls.length, 0);
});

test('ccr:test-key never sends a non-CCR profile key anywhere', async () => {
  const glm = { id: 'glm', templateId: 'glm', env: { ANTHROPIC_BASE_URL: 'http://localhost:9999', ANTHROPIC_AUTH_TOKEN: 'real-glm-secret' } };
  const handWritten = { id: 'mine', templateId: null, env: { ANTHROPIC_BASE_URL: 'http://localhost:3456', ANTHROPIC_AUTH_TOKEN: 'x' } };
  const { ipc, ccr } = setup({ profiles: [glm, handWritten] });
  assert.deepEqual(await ipc.invoke('ccr:test-key', 'glm'), { ok: false, reason: 'not-ccr' });
  assert.deepEqual(await ipc.invoke('ccr:test-key', 'mine'), { ok: false, reason: 'not-ccr' });
  assert.equal(ccr.calls.length, 0);
});

test('ccr:test-key reports no-key for a blank key or a non-secret sentinel', async () => {
  const profiles = [
    { ...ccrProfile({ ANTHROPIC_AUTH_TOKEN: '' }), id: 'blank' },
    { ...ccrProfile({ ANTHROPIC_AUTH_TOKEN: 'ccr-local' }), id: 'legacy' },
  ];
  const { ipc, ccr } = setup({ profiles });
  assert.deepEqual(await ipc.invoke('ccr:test-key', 'blank'), { ok: false, reason: 'no-key' });
  assert.deepEqual(await ipc.invoke('ccr:test-key', 'legacy'), { ok: false, reason: 'no-key' });
  assert.equal(ccr.calls.length, 0);
});

test('ccr:test-key refuses a CCR profile whose base URL is not loopback', async () => {
  const { ipc, ccr } = setup({ profiles: [ccrProfile({ ANTHROPIC_BASE_URL: 'https://gateway.example.com' })] });
  assert.deepEqual(await ipc.invoke('ccr:test-key', 'ollama'), { ok: false, reason: 'not-local' });
  assert.equal(ccr.calls.length, 0);
});

test('ccr:docs opens only the fixed docs address', () => {
  const opened = [];
  const { ipc } = setup({ opened });
  ipc.emit('ccr:docs', 'https://evil.example');
  assert.deepEqual(opened, [CCR_DOCS_URL]);
});

test('ensureGatewayFor starts a missing gateway and remembers it started it', async () => {
  const { control, sent } = setup();
  await control.ensureGatewayFor({ id: 's1' }, ccrProfile());
  assert.equal(control.isStartedByUs(), true);
  assert.deepEqual(sent.at(-1), ['ccr:state', { startedByUs: true, sessionId: 's1' }]);
});

test('ensureGatewayFor leaves a running gateway alone', async () => {
  const ccr = fakeCcr({ findGateway: async () => ({ ok: true, port: 3456, classification: 'up', mismatch: false }) });
  const { control } = setup({ ccr });
  await control.ensureGatewayFor({ id: 's1' }, ccrProfile());
  assert.ok(!ccr.calls.some(([name]) => name === 'startGateway'));
  assert.equal(control.isStartedByUs(), false);
});

test('ensureGatewayFor does not try to start CCR when it is not installed', async () => {
  const ccr = fakeCcr({ detectCcr: async () => ({ ok: false, reason: 'not-found' }) });
  const { control } = setup({ ccr });
  await control.ensureGatewayFor({ id: 's1' }, ccrProfile());
  assert.ok(!ccr.calls.some(([name]) => name === 'startGateway'));
});

test('shutdown stops only a gateway LunaCore started, and only once', async () => {
  const { control, ipc, ccr } = setup();
  control.shutdown();
  assert.ok(!ccr.calls.some(([name]) => name === 'stopGateway'));
  await ipc.invoke('ccr:start');
  control.shutdown();
  control.shutdown();
  assert.equal(ccr.calls.filter(([name]) => name === 'stopGateway').length, 1);
  assert.equal(control.isStartedByUs(), false);
});
