'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  DEFAULT_GATEWAY_PORT,
  parseGatewayPort,
  normalizeGatewayPort,
  gatewayUrl,
  loadGatewayPrefs,
  saveGatewayPrefs,
  withGatewayPort,
  gatewayState,
  isGatewayInstalled,
  probeGateway,
  gatewayStatus,
} = require('../src/freellmgateway');
const { registerFreeLlmIpc } = require('../src/freellmipc');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'freellm-')), 'freellm.local.json');
}

test('port validation accepts integers 1-65535 and digit strings, else falls back to the default', () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 31415);
  assert.equal(normalizeGatewayPort(3001), 3001);
  assert.equal(normalizeGatewayPort('3001'), 3001);
  assert.equal(normalizeGatewayPort(' 65535 '), 65535);
  assert.equal(normalizeGatewayPort(1), 1);
  for (const bad of [0, 65536, -1, 3001.5, '3001abc', '', null, undefined, NaN, '1e3', {}, [3001]]) {
    assert.equal(normalizeGatewayPort(bad), DEFAULT_GATEWAY_PORT, `bad: ${String(bad)}`);
    assert.equal(parseGatewayPort(bad), null, `bad: ${String(bad)}`);
  }
});

test('gatewayUrl builds the loopback origin, an invalid port yields the default', () => {
  assert.equal(gatewayUrl(3001), 'http://127.0.0.1:3001');
  assert.equal(gatewayUrl('nope'), 'http://127.0.0.1:31415');
});

test('gateway prefs round-trip and a missing/broken file means the default', () => {
  const file = tmpFile();
  assert.deepEqual(loadGatewayPrefs(file), { port: 31415 });
  assert.deepEqual(saveGatewayPrefs({ port: '3001' }, file), { ok: true, prefs: { port: 3001 } });
  assert.deepEqual(loadGatewayPrefs(file), { port: 3001 });
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(loadGatewayPrefs(file), { port: 31415 });
  fs.writeFileSync(file, JSON.stringify({ port: 99999 }));
  assert.deepEqual(loadGatewayPrefs(file), { port: 31415 });
});

test('withGatewayPort repoints FreeLLMAPI env values and args, leaves other profiles alone', () => {
  const codex = {
    templateId: 'freellm-codex',
    args: ['-c', 'model_providers.freellmapi.base_url=http://127.0.0.1:31415/v1', '-m', 'auto'],
    env: { FREELLM_API_KEY: 'k' },
  };
  const out = withGatewayPort(codex, 3001);
  assert.equal(out.args[1], 'model_providers.freellmapi.base_url=http://127.0.0.1:3001/v1');
  assert.notEqual(out, codex, 'a copy');
  assert.equal(codex.args[1], 'model_providers.freellmapi.base_url=http://127.0.0.1:31415/v1', 'input untouched');

  const claude = { templateId: 'freellm-chain', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:31415', ANTHROPIC_AUTH_TOKEN: 'k' } };
  assert.equal(withGatewayPort(claude, 3001).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3001');

  const lmstudio = { templateId: 'lmstudio', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234' } };
  assert.equal(withGatewayPort(lmstudio, 3001), lmstudio);
  const handWritten = { id: 'x', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:31415' } };
  assert.equal(withGatewayPort(handWritten, 3001), handWritten);
});

test('gatewayState maps probe outcomes to up / not-running / not-installed', () => {
  assert.equal(gatewayState({ answered: true }), 'up');
  assert.equal(gatewayState({ answered: false, timedOut: true }), 'not-running');
  assert.equal(gatewayState({ answered: false, installed: true }), 'not-running');
  assert.equal(gatewayState({ answered: false, installed: false }), 'not-installed');
  assert.equal(gatewayState(null), 'not-installed');
});

test('isGatewayInstalled checks the desktop install folders', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  const target = path.join(env.LOCALAPPDATA, 'Programs', 'FreeLLMAPI');
  assert.equal(isGatewayInstalled({ env, platform: 'win32', exists: (p) => p === target }), true);
  assert.equal(isGatewayInstalled({ env, platform: 'win32', exists: () => false }), false);
  assert.equal(isGatewayInstalled({ env, platform: 'win32', exists: () => { throw new Error('x'); } }), false);
});

test('probeGateway: any HTTP answer is up, a refused connection is not', async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 401;
    res.end('no key');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.deepEqual(await probeGateway(port), { answered: true, timedOut: false });
  } finally {
    await new Promise((r) => server.close(r));
  }
  // The port is free again: connection refused.
  assert.deepEqual(await probeGateway(port), { answered: false, timedOut: false });
});

test('probeGateway resolves as timed out when nothing answers in time', async () => {
  const fakeHttp = {
    get: () => {
      const req = new EventEmitter();
      req.destroy = () => {};
      return req; // never answers, never errors
    },
  };
  const started = Date.now();
  const outcome = await probeGateway(31415, { httpImpl: fakeHttp, timeoutMs: 30 });
  assert.deepEqual(outcome, { answered: false, timedOut: true });
  assert.ok(Date.now() - started < 1000);
  assert.equal(gatewayState(outcome), 'not-running');
});

test('gatewayStatus combines probe and install check', async () => {
  assert.equal(await gatewayStatus(1, { probe: async () => ({ answered: true }), installed: () => false }), 'up');
  assert.equal(await gatewayStatus(1, { probe: async () => ({ answered: false }), installed: () => true }), 'not-running');
  assert.equal(await gatewayStatus(1, { probe: async () => ({ answered: false }), installed: () => false }), 'not-installed');
});

test('freellm IPC validates the port in main and returns only the state string', async () => {
  const handlers = {};
  const listeners = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { listeners[ch] = fn; } };
  const opened = [];
  let saved = { port: 31415 };
  registerFreeLlmIpc({
    ipcMain,
    shell: { openExternal: (u) => opened.push(u) },
    deps: {
      load: () => saved,
      save: (p) => { saved = p; return { ok: true, prefs: p }; },
      status: async () => 'up',
    },
  });
  assert.equal(await handlers['freellm:get-port'](), 31415);
  assert.deepEqual(await handlers['freellm:set-port'](null, 'abc'), { ok: false, reason: 'invalid-port', port: 31415 });
  assert.deepEqual(await handlers['freellm:set-port'](null, 70000), { ok: false, reason: 'invalid-port', port: 31415 });
  assert.deepEqual(await handlers['freellm:set-port'](null, '3001'), { ok: true, port: 3001 });
  assert.equal(await handlers['freellm:status'](), 'up');
  await listeners['freellm:open-dashboard']();
  assert.deepEqual(opened, ['http://127.0.0.1:3001/']);
});
