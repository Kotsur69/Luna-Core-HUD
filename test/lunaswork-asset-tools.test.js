// ============================================================================
// Luna's Work asset tools (src/lunasworkAssetTools.js): the lunacore MCP
// tools of an asset worker and the real tool adapters, each against a fake -
// the Blender MCP add-on socket, the higgsfield CLI (execFile), the result
// download (fetch) - plus the intake server's gating: a tab without the asset
// pipeline never sees the tools.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const T = require('../src/lunasworkAssetTools.js');
const { handleRpc } = require('../src/intake.js');

// ---- Blender add-on socket ------------------------------------------------------------

/** A fake net module: one socket that answers the command with `answer` (split in two chunks). */
function fakeNet(answer, { fail = null } = {}) {
  const sent = [];
  const opened = [];
  const net = {
    createConnection(opts) {
      opened.push(opts);
      const s = new EventEmitter();
      s.setTimeout = () => {};
      s.destroy = () => {};
      s.write = (data) => {
        sent.push(JSON.parse(data));
        const text = JSON.stringify(answer);
        setImmediate(() => {
          s.emit('data', Buffer.from(text.slice(0, 5)));
          s.emit('data', Buffer.from(text.slice(5)));
        });
      };
      setImmediate(() => (fail ? s.emit('error', Object.assign(new Error('x'), { code: fail })) : s.emit('connect')));
      return s;
    },
  };
  return { net, sent, opened };
}

test('Blender: one execute_code command on 127.0.0.1:<port>, the JSON answer reassembled from chunks', async () => {
  const fake = fakeNet({ status: 'success', result: { executed: true } });
  const res = await T.createBlenderClient({ port: 9877, net: fake.net }).executeCode('print(1)');
  assert.deepEqual(res, { executed: true });
  assert.deepEqual(fake.opened, [{ host: '127.0.0.1', port: 9877 }]);
  assert.deepEqual(fake.sent, [{ type: 'execute_code', params: { code: 'print(1)' } }]);
});

test('Blender: an error answer and a refused socket are clear errors', async () => {
  await assert.rejects(T.createBlenderClient({ net: fakeNet({ status: 'error', message: 'Operator failed' }).net }).executeCode('x'), /blender failed: Operator failed/);
  await assert.rejects(T.createBlenderClient({ net: fakeNet(null, { fail: 'ECONNREFUSED' }).net }).executeCode('x'), /blender not connected on 127\.0\.0\.1:9876 \(ECONNREFUSED\)/);
  assert.throws(() => T.createBlenderClient({ port: 0 }), /port/);
});

// ---- Higgsfield CLI ---------------------------------------------------------------------

/** A fake execFile: records argv / options / stdin and answers per sub-command. */
function fakeExec(answers) {
  const calls = [];
  const execFile = (bin, args, opts, cb) => {
    const call = { bin, args, opts, stdin: '' };
    calls.push(call);
    const stdin = new EventEmitter();
    stdin.end = (data) => { call.stdin = String(data); };
    setImmediate(() => {
      const a = answers[args[1]];
      if (a instanceof Error) cb(a, '', a.message);
      else cb(null, typeof a === 'string' ? a : JSON.stringify(a), '');
    });
    return { stdin };
  };
  return { execFile, calls };
}

test('Higgsfield CLI: cost and create with plain tokens, the prompt only on stdin', async () => {
  const fake = fakeExec({
    cost: { model: 'gpt_image_2_6', credits: 3 },
    create: [{ id: 'job_7', status: 'completed', params: { seed: 12 }, results: [{ min_url: 'https://cdn.example.test/thumb.png', raw_url: 'https://cdn.example.test/full.png' }] }],
  });
  const cli = T.createHiggsfieldCli({ execFile: fake.execFile, platform: 'win32', env: { PATH: 'x' } });
  const req = { model: 'gpt_image_2_6', prompt: 'a "ronin" & $(rm -rf) at dusk', params: { aspect_ratio: '16:9' } };
  assert.deepEqual(await cli.estimate(req), { credits: 3 });
  const gen = await cli.generate(req);
  assert.deepEqual(gen, { status: 'completed', jobId: 'job_7', seed: 12, urls: ['https://cdn.example.test/full.png'] });
  assert.deepEqual(fake.calls[0].args, ['generate', 'cost', 'gpt_image_2_6', '--aspect_ratio', '16:9', '--json']);
  assert.deepEqual(fake.calls[1].args, ['generate', 'create', 'gpt_image_2_6', '--aspect_ratio', '16:9', '--wait', '--wait-timeout', '20m', '--json']);
  for (const c of fake.calls) {
    assert.equal(c.stdin, req.prompt);
    assert.ok(!c.args.some((a) => a.includes('ronin')), 'the prompt is never an argument');
    assert.equal(c.opts.shell, true, 'a .cmd shim on Windows needs the shell; every argument is a plain token');
  }
  await assert.rejects(cli.estimate({ ...req, model: 'x & calc' }), /plain token/);
  await assert.rejects(cli.estimate({ ...req, params: { a: 'b c' } }), /plain token/);
  // A leading dash would read as a flag of the CLI.
  await assert.rejects(cli.estimate({ ...req, params: { a: '--output' } }), /plain token/);
  await assert.rejects(cli.estimate({ ...req, model: '-h' }), /plain token/);
});

test('Higgsfield CLI: a failed job, a CLI error and non-JSON output are errors', async () => {
  const failed = T.createHiggsfieldCli({ execFile: fakeExec({ create: [{ id: 'j', status: 'failed' }] }).execFile, platform: 'linux' });
  await assert.rejects(failed.generate({ model: 'm', prompt: 'p' }), /ended failed/);
  const broken = T.createHiggsfieldCli({ execFile: fakeExec({ cost: new Error('not logged in') }).execFile });
  await assert.rejects(broken.estimate({ model: 'm', prompt: 'p' }), /higgsfield cost failed: not logged in/);
  const text = T.createHiggsfieldCli({ execFile: fakeExec({ cost: 'Cost: 3 credits' }).execFile });
  await assert.rejects(text.estimate({ model: 'm', prompt: 'p' }), /without JSON/);
  assert.equal(T.creditsOf({ estimate: { total_credits: 8 } }), 8);
  assert.ok(Number.isNaN(T.creditsOf({ nothing: true })));
});

// ---- download ---------------------------------------------------------------------------

/** A fake DNS: host -> addresses; unknown hosts fail like getaddrinfo. */
function fakeLookup(table) {
  const asked = [];
  const lookup = async (host, opts) => {
    asked.push([host, opts]);
    if (!table[host]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { lookup, asked };
}

const PUBLIC_DNS = { 'cdn.example.test': ['93.184.216.34'], 'cdn2.example.test': ['2606:4700::6810:84e5'] };

/** A fetch Response stand-in; `headers` is a plain map, `extra` overrides (status, body...). */
function res(body, { status = 200, headers = {}, ...extra } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h in headers ? headers[h] : null) },
    arrayBuffer: async () => body,
    ...extra,
  };
}

test('download: only public https on 443 with no credentials, IP literal or local name', () => {
  const bad = [
    'http://cdn.example.test/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png',
    'https://localhost./a.png', 'https://nas.local./a.png', 'https://box.home.arpa/a', 'https://u:p@cdn.example.test/a',
    'https://cdn.example.test:8443/a.png', 'https://cdn.example.test:22/a', 'file:///etc/passwd', 'https://intranet/a',
  ];
  for (const url of bad) assert.equal(T.isPublicHttps(url), false, url);
  assert.equal(T.isPublicHttps('https://cdn.example.test/a.png'), true);
  assert.equal(T.isPublicHttps('https://cdn.example.test:443/a.png'), true);
  const nonPublic = [
    '10.0.0.5', '127.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a00:5', 'nonsense',
    // Private v4 inside NAT64 / 6to4, Teredo, IPv4-compatible.
    '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::192.168.0.1', '2002:a00:1::1', '2002:7f00:1::', '2001:0:4136:e378::1', '::7f00:1',
  ];
  for (const ip of nonPublic) assert.equal(T.isPublicAddress(ip), false, ip);
  // Public v4 behind NAT64 / 6to4 stays reachable.
  for (const ip of ['93.184.216.34', '2606:4700::6810:84e5', '64:ff9b::5db8:d822', '2002:5db8:d822::1']) assert.equal(T.isPublicAddress(ip), true, ip);
});

test('download: the host must resolve to public addresses only, checked on every hop', async () => {
  const dns = fakeLookup({ ...PUBLIC_DNS, 'rebind.example.test': ['93.184.216.34', '10.0.0.5'], 'mapped.example.test': ['::ffff:127.0.0.1'] });
  const fetched = [];
  const fetch = async (url, init) => {
    fetched.push([url, init.redirect]);
    return res(new Uint8Array([1, 2, 3]).buffer);
  };
  const dl = T.createDownloader({ fetch, lookup: dns.lookup });
  assert.deepEqual([...(await dl('https://cdn.example.test/a.png'))], [1, 2, 3]);
  assert.deepEqual(fetched, [['https://cdn.example.test/a.png', 'manual']]);
  assert.deepEqual(dns.asked[0], ['cdn.example.test', { all: true, verbatim: true }]);
  await assert.rejects(dl('https://rebind.example.test/a.png'), /non-public address/);
  await assert.rejects(dl('https://mapped.example.test/a.png'), /non-public address/);
  await assert.rejects(dl('https://gone.example.test/a.png'), /cannot resolve gone\.example\.test \(ENOTFOUND\)/);
  await assert.rejects(dl('http://cdn.example.test/a.png'), /public https/);
  assert.equal(fetched.length, 1, 'nothing refused was ever fetched');
});

test('download: redirects are followed by hand, each target checked, at most 3', async () => {
  const dns = fakeLookup({ ...PUBLIC_DNS, 'evil.example.test': ['192.168.1.10'] });
  const hops = (chain) => {
    const seen = [];
    const fetch = async (url) => {
      seen.push(url);
      const next = chain[url];
      return next ? res(new ArrayBuffer(0), { status: 302, headers: { location: next } }) : res(new Uint8Array([9]).buffer);
    };
    return { fetch, seen };
  };
  const good = hops({ 'https://cdn.example.test/a': '/b', 'https://cdn.example.test/b': 'https://cdn2.example.test/c' });
  assert.deepEqual([...(await T.createDownloader({ fetch: good.fetch, lookup: dns.lookup })('https://cdn.example.test/a'))], [9]);
  assert.deepEqual(good.seen, ['https://cdn.example.test/a', 'https://cdn.example.test/b', 'https://cdn2.example.test/c']);

  for (const target of ['http://cdn2.example.test/x', 'https://10.0.0.5/x', 'https://cdn2.example.test:8080/x']) {
    const off = hops({ 'https://cdn.example.test/a': target });
    await assert.rejects(T.createDownloader({ fetch: off.fetch, lookup: dns.lookup })('https://cdn.example.test/a'), /redirected off public https/, target);
    assert.equal(off.seen.length, 1);
  }
  const inside = hops({ 'https://cdn.example.test/a': 'https://evil.example.test/x' });
  await assert.rejects(T.createDownloader({ fetch: inside.fetch, lookup: dns.lookup })('https://cdn.example.test/a'), /non-public address/);
  assert.equal(inside.seen.length, 1);
  const loop = hops({ 'https://cdn.example.test/a': '/a' });
  await assert.rejects(T.createDownloader({ fetch: loop.fetch, lookup: dns.lookup })('https://cdn.example.test/a'), /more than 3 redirects/);
  assert.equal(loop.seen.length, 4);
});

test('download: the size cap holds while the body streams in, not after', async () => {
  const dns = fakeLookup(PUBLIC_DNS);
  const declared = T.createDownloader({ lookup: dns.lookup, fetch: async () => res(new ArrayBuffer(1), { headers: { 'content-length': String(200 * 1024 * 1024) } }) });
  await assert.rejects(declared('https://cdn.example.test/a.png'), /too large/);
  // No content-length: 8 MB chunks until the 100 MB cap is passed, then the stream is cancelled.
  const chunk = new Uint8Array(8 * 1024 * 1024);
  let reads = 0;
  let cancelled = false;
  const body = { getReader: () => ({ read: async () => { reads += 1; return { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) };
  const endless = T.createDownloader({ lookup: dns.lookup, fetch: async () => res(null, { body, arrayBuffer: async () => assert.fail('the stream must be read, not buffered') }) });
  await assert.rejects(endless('https://cdn.example.test/a.png'), /too large/);
  assert.equal(reads, 13, 'stops at the first chunk past the cap');
  assert.equal(cancelled, true);
  const timeout = T.createDownloader({ lookup: dns.lookup, fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } });
  await assert.rejects(timeout('https://cdn.example.test/a.png'), /timed out/);
  // A body that stalls past the budget is a timeout too, not "broke off".
  const stalledBody = { getReader: () => ({ read: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, cancel: async () => {} }) };
  const stalled = T.createDownloader({ lookup: dns.lookup, fetch: async () => res(null, { body: stalledBody }) });
  await assert.rejects(stalled('https://cdn.example.test/a.png'), /timed out/);
  // An error page's body is dropped, not left holding the connection.
  let dropped = false;
  const notFound = T.createDownloader({ lookup: dns.lookup, fetch: async () => res(new ArrayBuffer(0), { status: 404, body: { cancel: async () => { dropped = true; } } }) });
  await assert.rejects(notFound('https://cdn.example.test/a.png'), /HTTP 404/);
  assert.equal(dropped, true);
});

test('download: a DNS lookup that hangs is bounded by the same timeout', async () => {
  let fetched = false;
  const dl = T.createDownloader({ timeoutMs: 50, lookup: () => new Promise(() => {}), fetch: async () => { fetched = true; return res(new ArrayBuffer(0)); } });
  await assert.rejects(dl('https://cdn.example.test/a.png'), /cannot resolve cdn\.example\.test \(resolving cdn\.example\.test timed out\)/);
  assert.equal(fetched, false);
});

// ---- MCP surface ------------------------------------------------------------------------

const store = (extra = {}) => ({ read: () => [], write: () => true, ...extra });
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

test('only a store with the asset pipeline lists and answers the luna_asset_* tools', async () => {
  const plain = handleRpc(rpc('tools/list'), store());
  assert.ok(!plain.result.tools.some((t) => t.name.startsWith('luna_asset_')));
  const unknown = handleRpc(rpc('tools/call', { name: T.COMFY_TOOL, arguments: {} }), store());
  assert.equal(unknown.error.code, -32602);

  const seen = [];
  const assets = {
    blenderModel: async (a) => { seen.push(['blender', a]); return { ok: true, files: ['Assets/X/Art/Props/crate.fbx'] }; },
    comfyDraft: async () => ({ ok: false, error: 'toolDown', detail: 'comfyui not connected' }),
    higgsfieldFinal: async () => { throw new Error('boom'); },
  };
  const listed = handleRpc(rpc('tools/list'), store({ assets }));
  assert.deepEqual(listed.result.tools.filter((t) => t.name.startsWith('luna_asset_')).map((t) => t.name), [T.BLENDER_TOOL, T.COMFY_TOOL, T.HIGGSFIELD_TOOL]);

  const made = await handleRpc(rpc('tools/call', { name: T.BLENDER_TOOL, arguments: { name: 'Crate', kind: 'prop' } }), store({ assets }));
  assert.equal(made.result.isError, undefined);
  assert.match(made.result.content[0].text, /crate\.fbx/);
  assert.deepEqual(seen, [['blender', { name: 'Crate', kind: 'prop' }]]);

  const down = await handleRpc(rpc('tools/call', { name: T.COMFY_TOOL, arguments: { name: 'a', kind: 'concept', workflow: 'x.json' } }), store({ assets }));
  assert.equal(down.result.isError, true);
  assert.match(down.result.content[0].text, /comfyui not connected/);
  const crashed = await handleRpc(rpc('tools/call', { name: T.HIGGSFIELD_TOOL, arguments: {} }), store({ assets }));
  assert.equal(crashed.result.isError, true);
  assert.match(crashed.result.content[0].text, /boom/);
});

test('createAssetToolsFor builds the pipeline per call from the settings; no repo path -> no tools', async () => {
  const assetsFor = T.createAssetToolsFor({ assetTools: () => ({ comfyuiPort: 8188, blenderPort: 9876, higgsfieldUsdPerCredit: 0.1, artRoot: 'Assets/X/Art' }) });
  assert.equal(assetsFor(null), null);
  assert.equal(assetsFor({}), null);
  const tools = assetsFor({ repoPath: 'relative/path', recordSpend: () => ({ ok: true }), recordAsset: () => true, cappedTools: () => [] });
  // A relative repo path is refused when the pipeline is built, as a tool error - never a write.
  const res = await T.callAssetTool(T.COMFY_TOOL, { name: 'a', kind: 'concept', workflow: 'x.json' }, tools);
  assert.deepEqual([res.ok, res.error.error], [false, 'failed']);
  assert.match(res.error.detail, /absolute/);
});
