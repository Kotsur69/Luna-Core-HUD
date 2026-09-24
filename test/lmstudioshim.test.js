// ============================================================================
// LunaCore - LM Studio request shim tests (src/lmstudioshim.js)
// ----------------------------------------------------------------------------
// The rewrite is the whole reason the shim exists: Claude Code sends hook
// output as a mid-conversation role:"system" message, LM Studio's Anthropic
// endpoint rejects it with a 400, and every LM Studio tab dies on turn one.
// The pure rewrite is pinned first; the proxy itself is then exercised against
// a fake upstream on an ephemeral port, never against a real LM Studio.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const {
  toBlocks,
  normalizeMessages,
  rewriteBody,
  shouldRewrite,
  LmStudioShim,
  ensureShim,
  stopAllShims,
} = require('../src/lmstudioshim');

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const reminder = (text) => `<system-reminder>\n${text}\n</system-reminder>`;

// --- pure rewrite -----------------------------------------------------------

test('toBlocks turns string content into one text block and keeps arrays', () => {
  assert.deepStrictEqual(toBlocks('hi'), [{ type: 'text', text: 'hi' }]);
  const blocks = [{ type: 'image', source: {} }];
  assert.strictEqual(toBlocks(blocks), blocks);
});

test('normalizeMessages rewrites a system message into a wrapped user message', () => {
  const out = normalizeMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'system', content: 'hook output' },
  ]);
  assert.deepStrictEqual(out[2], {
    role: 'user',
    content: [{ type: 'text', text: reminder('hook output') }],
  });
});

test('normalizeMessages merges user + system + user into one user message', () => {
  const out = normalizeMessages([
    { role: 'user', content: 'a' },
    { role: 'system', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].content.map((b) => b.text), ['a', reminder('b'), 'c']);
});

test('normalizeMessages keeps non-text system blocks unwrapped', () => {
  const image = { type: 'image', source: { type: 'base64', data: 'x' } };
  const out = normalizeMessages([{ role: 'system', content: [image] }]);
  assert.deepStrictEqual(out[0], { role: 'user', content: [image] });
});

test('normalizeMessages keeps tool_result blocks first after a merge', () => {
  const out = normalizeMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    { role: 'system', content: 'reminder' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[1].content.map((b) => b.type), ['tool_result', 'text']);
});

test('normalizeMessages preserves cache_control on rewritten blocks', () => {
  const out = normalizeMessages([
    { role: 'system', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] },
  ]);
  assert.deepStrictEqual(out[0].content[0].cache_control, { type: 'ephemeral' });
});

test('normalizeMessages does not mutate its input', () => {
  const input = deepFreeze([
    { role: 'user', content: [{ type: 'text', text: 'a' }] },
    { role: 'system', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
  assert.doesNotThrow(() => normalizeMessages(input));
  assert.strictEqual(input[0].content.length, 1);
});

test('normalizeMessages returns non-arrays and empty arrays as-is', () => {
  assert.strictEqual(normalizeMessages(null), null);
  const empty = [];
  assert.strictEqual(normalizeMessages(empty), empty);
});

test('rewriteBody returns the original buffer when there is nothing to rewrite', () => {
  const cases = ['not json', '{"model":"m"}', '{"messages":[{"role":"user","content":"x"}]}'];
  for (const text of cases) {
    const buf = Buffer.from(text);
    const res = rewriteBody(buf);
    assert.strictEqual(res.changed, false);
    assert.strictEqual(res.body, buf);
  }
});

test('rewriteBody rewrites system messages and keeps the top-level system field', () => {
  const buf = Buffer.from(JSON.stringify({
    model: 'm',
    system: [{ type: 'text', text: 'top' }],
    messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }],
  }));
  const res = rewriteBody(buf);
  assert.strictEqual(res.changed, true);
  const parsed = JSON.parse(res.body.toString('utf8'));
  assert.deepStrictEqual(parsed.system, [{ type: 'text', text: 'top' }]);
  assert.deepStrictEqual(parsed.messages.map((m) => m.role), ['user']);
});

test('shouldRewrite only matches uncompressed POSTs to /v1/messages', () => {
  assert.strictEqual(shouldRewrite('POST', '/v1/messages', {}), true);
  assert.strictEqual(shouldRewrite('POST', '/v1/messages?beta=true', {}), true);
  assert.strictEqual(shouldRewrite('GET', '/v1/messages', {}), false);
  assert.strictEqual(shouldRewrite('GET', '/v1/models', {}), false);
  assert.strictEqual(shouldRewrite('POST', '/v1/messages/count_tokens', {}), false);
  assert.strictEqual(shouldRewrite('POST', '/v1/messages', { 'content-encoding': 'gzip' }), false);
});

// --- proxy against a fake upstream -----------------------------------------

function startUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, { method = 'GET', path = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('shim rewrites a messages POST and forwards a correct content-length', async () => {
  let seen = null;
  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen = { length: Number(req.headers['content-length']), actual: body.length, json: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const shim = new LmStudioShim({ upstream: `http://127.0.0.1:${upstream.address().port}` });
  const started = await shim.start();
  try {
    assert.strictEqual(started.ok, true);
    const res = await request(started.port, {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }] }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.length, seen.actual);
    assert.deepStrictEqual(seen.json.messages.map((m) => m.role), ['user']);
  } finally {
    await shim.stop();
    upstream.close();
  }
});

test('shim passes GET requests through untouched', async () => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  const shim = new LmStudioShim({ upstream: `http://127.0.0.1:${upstream.address().port}` });
  const { port } = await shim.start();
  try {
    const res = await request(port, { path: '/v1/models' });
    assert.deepStrictEqual(JSON.parse(res.body), { path: '/v1/models' });
  } finally {
    await shim.stop();
    upstream.close();
  }
});

test('shim streams SSE chunks before the upstream finishes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const upstream = await startUpstream(async (req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: a\ndata: 1\n\n');
    await gate;
    res.end('event: b\ndata: 2\n\n');
  });
  const shim = new LmStudioShim({ upstream: `http://127.0.0.1:${upstream.address().port}` });
  const { port } = await shim.start();
  try {
    const first = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages' }, (res) => {
        res.once('data', (c) => { resolve(c.toString('utf8')); release(); res.resume(); });
      });
      req.on('error', reject);
      req.end('{"messages":[]}');
    });
    assert.match(first, /data: 1/);
  } finally {
    await shim.stop();
    upstream.close();
  }
});

test('shim answers 502 in Anthropic error shape when the upstream is down', async () => {
  const dead = await startUpstream(() => {});
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const shim = new LmStudioShim({ upstream: `http://127.0.0.1:${deadPort}` });
  const { port } = await shim.start();
  try {
    const res = await request(port, { method: 'POST', path: '/v1/messages', body: '{"messages":[]}' });
    assert.strictEqual(res.status, 502);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.type, 'error');
    assert.strictEqual(json.error.type, 'api_error');
  } finally {
    await shim.stop();
  }
});

test('shim rejects an oversized body with 413', async () => {
  const upstream = await startUpstream((req, res) => { req.resume(); res.end('{}'); });
  const shim = new LmStudioShim({ upstream: `http://127.0.0.1:${upstream.address().port}`, maxBodyBytes: 64 });
  const { port } = await shim.start();
  try {
    const res = await request(port, { method: 'POST', path: '/v1/messages', body: 'x'.repeat(500) });
    assert.strictEqual(res.status, 413);
  } finally {
    await shim.stop();
    upstream.close();
  }
});

test('shim rejects a foreign Host header with 403', async () => {
  const upstream = await startUpstream((req, res) => { req.resume(); res.end('{}'); });
  const shim = new LmStudioShim({ upstream: `http://127.0.0.1:${upstream.address().port}` });
  const { port } = await shim.start();
  try {
    const res = await request(port, { path: '/v1/models', headers: { host: 'evil.example:80' } });
    assert.strictEqual(res.status, 403);
  } finally {
    await shim.stop();
    upstream.close();
  }
});

test('shim binds loopback only and start/stop are idempotent', async () => {
  const shim = new LmStudioShim({ upstream: 'http://127.0.0.1:1' });
  const a = await shim.start();
  const b = await shim.start();
  assert.strictEqual(a.port, b.port);
  assert.strictEqual(shim.url(), `http://127.0.0.1:${a.port}`);
  await shim.stop();
  await shim.stop();
  assert.strictEqual(shim.url(), null);
});

test('stop() during a pending start() leaves no listener behind', async () => {
  const shim = new LmStudioShim({ upstream: 'http://127.0.0.1:1' });
  const pending = shim.start();
  await shim.stop();
  const started = await pending;
  assert.strictEqual(shim.url(), null);
  const refused = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: started.port, path: '/' }, (res) => { res.resume(); resolve(false); });
    req.on('error', () => resolve(true));
  });
  assert.strictEqual(refused, true);
});

test('shim destroys the upstream request when the client aborts', async () => {
  let upstreamClosed;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const upstream = await startUpstream((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
    res.on('close', () => upstreamClosed(true));
  });
  const shim = new LmStudioShim({ upstream: `http://127.0.0.1:${upstream.address().port}` });
  const { port } = await shim.start();
  try {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages' }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
      req.end('{"messages":[]}');
    });
    assert.strictEqual(await closed, true);
  } finally {
    await shim.stop();
    upstream.close();
  }
});

test('ensureShim reuses one shim per upstream and refuses non-loopback upstreams', async () => {
  try {
    const a = await ensureShim('http://127.0.0.1:1');
    const b = await ensureShim('http://127.0.0.1:1/');
    assert.strictEqual(a.ok, true);
    assert.strictEqual(a.url, b.url);
    const remote = await ensureShim('http://api.example.com');
    assert.deepStrictEqual(remote, { ok: false, reason: 'not-local' });
  } finally {
    await stopAllShims();
  }
});
