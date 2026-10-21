// ============================================================================
// Free-model fallback chains: chain selection (src/freechains.js), the
// fallback proxy walking a chain (src/fallbackproxy.js), and God Mode's free
// mode branch rules (src/orchestraFree.js + orchestra.js / worktrees.js).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const chains = require('../src/freechains');
const { FallbackProxy, withModel, isModelRequest, MODEL_HEADER } = require('../src/fallbackproxy');
const { SHIM_TOKEN_HEADER } = require('../src/sessionenv');
const free = require('../src/orchestraFree');
const { prepareChainLaunch } = require('../src/locallaunch');
const { normalizeProviderTemplate, buildProfileFromTemplate } = require('../src/providers');
const { normalizeProfile } = require('../src/profiles');

const NOW = 1_800_000_000_000;
const chain = { id: 'c', models: ['strong-a', 'strong-b', 'strong-c'] };

// --- loading + validation ---------------------------------------------------------

test('the shipped chains load, and none of them contains a weak model', () => {
  const list = chains.loadChains({ local: path.join(os.tmpdir(), 'no-such-freechains.json') });
  assert.ok(list.length >= 1);
  assert.ok(chains.getChain(list, 'free-coding'));
  for (const c of list) for (const m of c.models) assert.equal(chains.isWeakModel(m), false, m);
});

test('isWeakModel refuses flash / lite / mini / small models and the open router', () => {
  for (const m of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gpt-4o-mini', 'llama-3.1-8b-instant', 'mistral-small', 'claude-haiku-4-5', 'auto']) {
    assert.equal(chains.isWeakModel(m), true, m);
  }
  for (const m of ['gemini-2.5-pro', 'gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'kimi-k2-instruct', 'deepseek-r1']) {
    assert.equal(chains.isWeakModel(m), false, m);
  }
});

test('normalizeChain drops weak, malformed and duplicate ids; an empty chain is null', () => {
  const c = chains.normalizeChain({ id: 'x', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'bad id', 'gemini-2.5-pro', 7, 'glm-4.6'] });
  assert.deepEqual(c.models, ['gemini-2.5-pro', 'glm-4.6']);
  assert.equal(chains.normalizeChain({ id: 'x', models: ['gemini-2.5-flash'] }), null);
  assert.equal(chains.normalizeChain({ id: 'Bad Id', models: ['glm-4.6'] }), null);
  assert.equal(chains.normalizeChain(null), null);
});

test('loadChains: a broken file is an empty list, a local chain overrides by id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chains-'));
  const base = path.join(dir, 'base.json');
  const local = path.join(dir, 'local.json');
  fs.writeFileSync(base, '{ not json');
  assert.deepEqual(chains.loadChains({ base, local }), []);
  fs.writeFileSync(base, JSON.stringify({ chains: [{ id: 'a', models: ['glm-4.6'] }] }));
  fs.writeFileSync(local, JSON.stringify({ chains: [{ id: 'a', models: ['deepseek-r1'] }, { id: 'b', models: ['kimi-k2-instruct'] }] }));
  const list = chains.loadChains({ base, local });
  assert.deepEqual(list.map((c) => [c.id, c.models[0]]), [['a', 'deepseek-r1'], ['b', 'kimi-k2-instruct']]);
});

test('resolveProfileChain: the profile choice beats the template default', () => {
  const list = [{ id: 'one', models: ['glm-4.6'] }, { id: 'two', models: ['deepseek-r1'] }];
  const providers = [{ id: 'freellm-chain', fallbackChain: 'one' }];
  assert.equal(chains.resolveProfileChain({ templateId: 'freellm-chain' }, providers, list).id, 'one');
  assert.equal(chains.resolveProfileChain({ templateId: 'freellm-chain', fallbackChain: 'two' }, providers, list).id, 'two');
  assert.equal(chains.resolveProfileChain({ templateId: 'glm' }, providers, list), null);
  assert.equal(chains.resolveProfileChain({ fallbackChain: 'missing' }, providers, list), null);
});

// --- selection ----------------------------------------------------------------------

test('attemptOrder keeps chain order and moves cooling models to the back', () => {
  assert.deepEqual(chains.attemptOrder(chain, new Map(), NOW), ['strong-a', 'strong-b', 'strong-c']);
  const cooling = new Map([['strong-a', NOW + 5000], ['strong-b', NOW + 1000]]);
  assert.deepEqual(chains.attemptOrder(chain, cooling, NOW), ['strong-c', 'strong-b', 'strong-a']);
  // A cooldown that has expired counts as ready again.
  assert.deepEqual(chains.attemptOrder(chain, new Map([['strong-a', NOW - 1]]), NOW)[0], 'strong-a');
});

test('classifyFailure: limit, outage, unknown model move on; a bad key does not', () => {
  assert.equal(chains.classifyFailure(200), 'ok');
  assert.equal(chains.classifyFailure(429), 'limit');
  assert.equal(chains.classifyFailure(529), 'outage');
  assert.equal(chains.classifyFailure(503), 'outage');
  assert.equal(chains.classifyFailure(404, '{"error":{"message":"model not found"}}'), 'unknown');
  assert.equal(chains.classifyFailure(400, '{"error":{"message":"messages: required"}}'), 'fatal');
  assert.equal(chains.classifyFailure(401, 'bad key'), 'fatal');
  assert.equal(chains.classifyFailure(402), 'limit');
});

test('withCooldown honours Retry-After for limits and never mutates its input', () => {
  const before = new Map();
  const after = chains.withCooldown(before, 'm', 'limit', NOW, 120000);
  assert.equal(before.size, 0);
  assert.equal(after.get('m'), NOW + 120000);
  assert.equal(chains.withCooldown(after, 'n', 'unknown', NOW).get('n'), NOW + chains.COOLDOWN_MS.unknown);
  assert.equal(chains.retryAfterMs({ 'retry-after': '30' }, NOW), 30000);
  assert.equal(chains.retryAfterMs({}, NOW), null);
});

test('withModel swaps the model only in a JSON object body', () => {
  assert.equal(JSON.parse(withModel(Buffer.from('{"model":"opus","max_tokens":5}'), 'x').toString()).model, 'x');
  assert.equal(withModel(Buffer.from('[1]'), 'x'), null);
  assert.equal(withModel(Buffer.from('nope'), 'x'), null);
  assert.equal(isModelRequest('POST', '/v1/messages?beta=true'), true);
  assert.equal(isModelRequest('GET', '/v1/models'), false);
});

// --- the proxy walking a chain against a fake gateway ---------------------------

function startGateway(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      seen.push({ url: req.url, model: body && body.model, auth: req.headers.authorization, token: req.headers[SHIM_TOKEN_HEADER] });
      answer(body && body.model, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen })));
}

function post(port, token, pathname = '/v1/messages') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: pathname,
      headers: { 'content-type': 'application/json', authorization: 'Bearer gw-key', [SHIM_TOKEN_HEADER]: token },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'claude-opus', messages: [{ role: 'user', content: 'hi' }] }));
  });
}

test('proxy: a limited model hands the SAME request to the next one', async () => {
  const { server, seen } = await startGateway((model, res) => {
    if (model === 'strong-a') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      return res.end('{"error":"rate limited"}');
    }
    if (model === 'strong-b') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"model not found"}}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model }));
  });
  const proxy = new FallbackProxy({ upstream: `http://127.0.0.1:${server.address().port}`, chain });
  const { port, token } = await proxy.start();
  try {
    const res = await post(port, token);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).model, 'strong-c');
    assert.equal(res.headers[MODEL_HEADER], 'strong-c');
    assert.deepEqual(seen.map((s) => s.model), ['strong-a', 'strong-b', 'strong-c']);
    // The client's auth goes through; the proxy's own token never does.
    assert.ok(seen.every((s) => s.auth === 'Bearer gw-key' && s.token === undefined));
    // The next request starts on the first model that is not cooling down.
    seen.length = 0;
    await post(port, token);
    assert.equal(seen[0].model, 'strong-c');
  } finally {
    await proxy.stop();
    server.close();
  }
});

test('proxy: a fatal answer (bad gateway key) is passed through without retries', async () => {
  const { server, seen } = await startGateway((model, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"invalid key"}');
  });
  const proxy = new FallbackProxy({ upstream: `http://127.0.0.1:${server.address().port}`, chain });
  const { port, token } = await proxy.start();
  try {
    const res = await post(port, token);
    assert.equal(res.status, 401);
    assert.equal(seen.length, 1);
  } finally {
    await proxy.stop();
    server.close();
  }
});

test('proxy: when every model fails the client gets the last answer', async () => {
  const { server, seen } = await startGateway((model, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(`{"error":"down ${model}"}`);
  });
  const proxy = new FallbackProxy({ upstream: `http://127.0.0.1:${server.address().port}`, chain });
  const { port, token } = await proxy.start();
  try {
    const res = await post(port, token);
    assert.equal(res.status, 503);
    assert.match(res.body, /strong-c/);
    assert.equal(seen.length, 3);
  } finally {
    await proxy.stop();
    server.close();
  }
});

test('proxy: requests without its token are refused and never forwarded', async () => {
  const { server, seen } = await startGateway((model, res) => res.end('{}'));
  const proxy = new FallbackProxy({ upstream: `http://127.0.0.1:${server.address().port}`, chain });
  const { port } = await proxy.start();
  try {
    const res = await post(port, 'wrong');
    assert.equal(res.status, 401);
    assert.equal(seen.length, 0);
  } finally {
    await proxy.stop();
    server.close();
  }
});

test('prepareChainLaunch routes the tab through the proxy with the chain head as model', async () => {
  const profile = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:31415', ANTHROPIC_AUTH_TOKEN: 'k' } };
  const ok = await prepareChainLaunch(profile, chain, { ensureProxy: async () => ({ ok: true, url: 'http://127.0.0.1:5000', token: 't' }) });
  assert.equal(ok.envOverrides.ANTHROPIC_BASE_URL, 'http://127.0.0.1:5000');
  assert.equal(ok.envOverrides.ANTHROPIC_MODEL, 'strong-a');
  assert.match(ok.envOverrides.ANTHROPIC_CUSTOM_HEADERS, /: t$/);
  const failed = await prepareChainLaunch(profile, chain, { ensureProxy: async () => ({ ok: false }) });
  assert.equal(failed.envOverrides.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(failed.notes, ['proxy-failed']);
  const remote = await prepareChainLaunch({ env: { ANTHROPIC_BASE_URL: 'https://api.example.com' } }, chain, { ensureProxy: async () => assert.fail() });
  assert.deepEqual(remote.notes, ['not-local']);
});

test('the freellm-chain template carries its chain into a built profile', () => {
  const template = normalizeProviderTemplate({
    id: 'freellm-chain', label: 'x', wireVia: 'direct', requiresApiKey: true, fallbackChain: 'free-coding',
    envTemplate: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:31415', ANTHROPIC_AUTH_TOKEN: '{{apiKey}}' },
  });
  assert.equal(template.fallbackChain, 'free-coding');
  const built = buildProfileFromTemplate(template, { id: 'p', label: 'P', apiKey: 'k', fallbackChain: 'free-reasoning' });
  assert.equal(built.profile.fallbackChain, 'free-reasoning');
  assert.equal(normalizeProfile({ id: 'p', label: 'P', fallbackChain: 'BAD ID' }).fallbackChain, null);
});

// --- God Mode free mode --------------------------------------------------------------

test('free branches are luna-free/<slug> and never the target or a protected branch', () => {
  assert.equal(free.freeBranchName('a-1'), 'luna-free/a-1');
  assert.equal(free.isSafeFreeBranch('luna-free/a-1', 'main'), true);
  assert.equal(free.isSafeFreeBranch('luna/a-1', 'main'), false);
  assert.equal(free.isSafeFreeBranch('main', 'main'), false);
  assert.equal(free.isSafeFreeBranch('luna-free/', 'main'), false);
  assert.equal(free.isSafeFreeBranch('luna-free/x', 'luna-free/x'), false);
});

test('pickFreeProfileId prefers the chosen chain profile, else the first one', () => {
  const list = [{ id: 'c1', models: ['glm-4.6'] }];
  const providers = [{ id: 'freellm-chain', fallbackChain: 'c1' }];
  const profiles = [
    { id: 'claude-cloud' },
    { id: 'free-a', templateId: 'freellm-chain' },
    { id: 'free-b', templateId: 'freellm-chain' },
  ];
  assert.equal(free.pickFreeProfileId(profiles, providers, list), 'free-a');
  assert.equal(free.pickFreeProfileId(profiles, providers, list, 'free-b'), 'free-b');
  assert.equal(free.pickFreeProfileId(profiles, providers, list, 'claude-cloud'), 'free-a');
  assert.equal(free.pickFreeProfileId([{ id: 'claude-cloud' }], providers, list), null);
});

test('a free run integrates as branches only, whatever is asked for', () => {
  assert.deepEqual(free.freeRunSettings({ freeProfileId: null }), { ok: false, error: 'noFreeProfile' });
  assert.equal(free.freeRunSettings({ freeProfileId: 'f' }).integrationMode, 'branches');
  assert.equal(free.integrationFor({ freeMode: true }, 'merge'), 'branches');
  assert.equal(free.integrationFor({ freeMode: false }, 'merge'), 'merge');
});
