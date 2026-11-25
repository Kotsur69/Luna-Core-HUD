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
  assert.deepEqual(listed.result.tools.filter((t) => t.name.startsWith('luna_asset_')).map((t) => t.name), [T.BLENDER_TOOL, T.COMFY_TOOL, T.HIGGSFIELD_TOOL, T.SEARCH_TOOL, T.IMPORT_TOOL, T.JUDGE_TOOL]);
  // A store whose pipeline lacks the library runners answers toolDown, never a crash.
  const noLibrary = await handleRpc(rpc('tools/call', { name: T.SEARCH_TOOL, arguments: { source: 'polyhaven', query: 'x' } }), store({ assets }));
  assert.equal(noLibrary.result.isError, true);
  assert.match(noLibrary.result.content[0].text, /toolDown/);

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

// ---- luna_asset_search source "all" ---------------------------------------------------

test('luna_asset_search schema: source takes "all" or one library; type is one of the library types', () => {
  const schema = T.ASSET_TOOLS.find((t) => t.name === T.SEARCH_TOOL).inputSchema;
  assert.equal(schema.properties.source.enum[0], 'all');
  assert.ok(schema.properties.source.enum.includes('polyhaven'));
  assert.deepEqual(schema.properties.type.enum, ['model', 'texture', 'hdri', 'audio']);
  assert.deepEqual(schema.required, ['source', 'query']);
  // luna_asset_import still names one library: "all" is a search-only value.
  const importSchema = T.ASSET_TOOLS.find((t) => t.name === T.IMPORT_TOOL).inputSchema;
  assert.equal(importSchema.properties.source.enum.includes('all'), false);
});

test('luna_asset_search source "all" through the handler: keyed libraries without a stored key are skipped', async () => {
  const os = require('os');
  // Fake key assembled at runtime: no key-shaped literal in the source.
  const freesoundKey = `fs${'k'.repeat(28)}`;
  const keys = { get: (s) => (s === 'freesound' ? freesoundKey : null), secrets: () => [freesoundKey] };
  const fetched = [];
  const fetch = async (url) => { fetched.push(url); throw new Error(`offline ${freesoundKey}`); };
  const assetsFor = T.createAssetToolsFor({ assetTools: () => ({ comfyuiPort: 8188, blenderPort: 9876, higgsfieldUsdPerCredit: 0.1, artRoot: 'Assets/X/Art' }), keys, fetch, lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  const tools = assetsFor({ repoPath: os.tmpdir(), recordSpend: () => ({ ok: true }), recordAsset: () => true, cappedTools: () => [] });

  const res = await T.callAssetTool(T.SEARCH_TOOL, { source: 'all', query: 'door creak', type: 'audio' }, tools);
  assert.equal(res.ok, false);
  assert.equal(res.error.error, 'allFailed');
  // Audio libraries: freesound (key stored) and lotsofsounds (no key needed) are asked; none is skipped.
  assert.deepEqual(res.error.errors.map((e) => e.source).sort(), ['freesound', 'lotsofsounds']);
  assert.deepEqual(res.error.skipped, []);
  assert.equal(JSON.stringify(res).includes(freesoundKey), false, 'a stored key leaked into the answer');

  const models = await T.callAssetTool(T.SEARCH_TOOL, { source: 'all', query: 'old chair', type: 'model' }, tools);
  assert.deepEqual(models.error.skipped.map((s) => s.source).sort(), ['polypizza', 'smithsonian']);
  assert.ok(models.error.skipped.every((s) => s.note === 'skipped: no key'));

  const badType = await T.callAssetTool(T.SEARCH_TOOL, { source: 'all', query: 'x', type: 'video' }, tools);
  assert.equal(badType.error.error, 'badType');
  assert.ok(fetched.length > 0);
});

// ---- luna_asset_blender style pass ----------------------------------------------------

test('luna_asset_blender schema: stylePass is "none" or "blade-bullet-toon", polyBudget a capped positive integer', () => {
  const schema = T.ASSET_TOOLS.find((t) => t.name === T.BLENDER_TOOL).inputSchema;
  assert.deepEqual(schema.required, ['name', 'kind']);
  assert.deepEqual(schema.properties.stylePass.enum, ['none', 'blade-bullet-toon']);
  assert.equal(schema.properties.stylePass.default, 'none');
  assert.equal(schema.properties.polyBudget.type, 'integer');
  assert.ok(schema.properties.polyBudget.minimum > 0);
  assert.ok(Number.isSafeInteger(schema.properties.polyBudget.maximum) && schema.properties.polyBudget.maximum <= 1000000);
  assert.equal(schema.additionalProperties, false);
});

test('luna_asset_blender schema exposes the optional `from` Higgsfield result path; it reaches the pipeline as given', async () => {
  const schema = T.ASSET_TOOLS.find((t) => t.name === T.BLENDER_TOOL).inputSchema;
  assert.equal(schema.properties.from.type, 'string');
  assert.ok(schema.properties.from.maxLength > 0);
  assert.match(schema.properties.from.description, /art\/higgsfield\/ or the art root/);
  assert.match(schema.properties.from.description, /\.gltf and \.fbx are refused/);
  assert.ok(!schema.required.includes('from'));
  assert.match(T.ASSET_TOOLS.find((t) => t.name === T.BLENDER_TOOL).description, /from = a saved Higgsfield result/);
  const seen = [];
  const res = await T.callAssetTool(T.BLENDER_TOOL, { name: 'a', kind: 'prop', from: 'art/higgsfield/prop/a.png' }, { blenderModel: async (a) => { seen.push(a); return { ok: true, files: ['x.fbx'] }; } });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [{ name: 'a', kind: 'prop', from: 'art/higgsfield/prop/a.png' }]);
});

test('luna_asset_blender refuses a bad stylePass or polyBudget before the pipeline runs', async () => {
  const seen = [];
  const tools = { blenderModel: async (a) => { seen.push(a); return { ok: true, files: ['x.fbx'] }; } };
  const bad = [
    [{ name: 'a', kind: 'prop', stylePass: 'photoreal' }, 'badStylePass'],
    [{ name: 'a', kind: 'prop', stylePass: 7 }, 'badStylePass'],
    [{ name: 'a', kind: 'prop', polyBudget: 0 }, 'badPolyBudget'],
    [{ name: 'a', kind: 'prop', polyBudget: -5 }, 'badPolyBudget'],
    [{ name: 'a', kind: 'prop', polyBudget: 1500.5 }, 'badPolyBudget'],
    [{ name: 'a', kind: 'prop', polyBudget: '15000' }, 'badPolyBudget'],
    [{ name: 'a', kind: 'prop', polyBudget: 10 ** 9 }, 'badPolyBudget'],
  ];
  for (const [args, error] of bad) {
    const res = await T.callAssetTool(T.BLENDER_TOOL, args, tools);
    assert.deepEqual([res.ok, res.error.error], [false, error], JSON.stringify(args));
  }
  assert.equal(seen.length, 0);

  const ok = await T.callAssetTool(T.BLENDER_TOOL, { name: 'a', kind: 'character', stylePass: 'blade-bullet-toon', polyBudget: 20000 }, tools);
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, [{ name: 'a', kind: 'character', stylePass: 'blade-bullet-toon', polyBudget: 20000 }]);
  // Both options are optional.
  assert.equal((await T.callAssetTool(T.BLENDER_TOOL, { name: 'a', kind: 'prop' }, tools)).ok, true);
});

// ---- asset-prep workers: no Unity editor -> the import is deferred to the scene worker ----

const { createAssetPipeline } = require('../src/lunasworkAssetPipeline.js');

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const EDITOR_NOT_OPEN = () => Object.assign(new Error('Unity editor not open on X, or com.unity.pipeline not installed'), { code: 'UNITY_PIPELINE_NOT_OPEN' });

/** A temp repo with one ComfyUI workflow, and the real pipeline over fakes. */
function prepPipeline(extra = {}) {
  const fsx = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'lw-asset-prep-'));
  fsx.mkdirSync(path.join(dir, 'art', 'comfyui'), { recursive: true });
  fsx.writeFileSync(path.join(dir, 'art', 'comfyui', 'concept.json'), JSON.stringify({
    3: { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0] } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  }));
  const logged = [];
  const p = createAssetPipeline({
    repoPath: dir,
    comfy: { run: async () => ({ promptId: 'p', images: [{ data: PNG_BYTES }] }) },
    recordSpend: () => ({ ok: true, reason: null }),
    logAsset: (e) => logged.push(e),
    ...extra,
  });
  const tools = { comfyDraft: (a) => p.comfyDraft(a), higgsfieldFinal: (a) => p.higgsfieldFinal(a) };
  return { tools, logged };
}

test('no Unity editor in the worktree: the answer says the import is deferred to the scene-worker, not failed', async () => {
  for (const unity of [undefined, { exec: async () => { throw EDITOR_NOT_OPEN(); } }]) {
    const { tools } = prepPipeline({ unity });
    const res = await T.callAssetTool(T.COMFY_TOOL, { name: 'Sky', kind: 'concept', workflow: 'concept.json', seed: 2 }, tools);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.payload.unityDeferred, true);
    assert.match(res.payload.note, /deferred to the scene-worker package/);
    assert.doesNotMatch(res.payload.note, /Unity import failed/);
    assert.ok(res.payload.unity.every((imp) => imp.deferred === true && imp.ok === false));
    assert.ok(res.payload.files.length > 0, 'the file is saved all the same');
  }
});

test('an import that fails with the editor open stays a failure for the worker to fix', async () => {
  const { tools } = prepPipeline({ unity: { exec: async () => { throw new Error('prefab create crashed'); } } });
  const res = await T.callAssetTool(T.COMFY_TOOL, { name: 'Sky', kind: 'concept', workflow: 'concept.json', seed: 2 }, tools);
  assert.equal(res.ok, true);
  assert.equal(res.payload.unityDeferred, undefined);
  assert.match(res.payload.note, /Unity import failed \(prefab create crashed\)/);
});

test('a paid Higgsfield final without the editor is still booked first; only the import is deferred', async () => {
  const booked = [];
  const { tools, logged } = prepPipeline({
    higgsfield: {
      estimate: async () => ({ credits: 4 }),
      generate: async () => ({ jobId: 'job_1', urls: ['https://cdn.example.test/out.png'], seed: 99 }),
    },
    usdPerCredit: 0.25,
    download: async () => PNG_BYTES,
    recordSpend: (x) => { booked.push(x); return { ok: true, reason: null }; },
  });
  const res = await T.callAssetTool(T.HIGGSFIELD_TOOL, { name: 'Key Art', kind: 'keyart', prompt: 'hero duel', model: 'gpt_image_2_6' }, tools);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(booked.length, 1, 'booked against the run cap before generating');
  assert.equal(res.payload.costUsd, 1);
  assert.equal(res.payload.credits, 4);
  assert.equal(res.payload.unityDeferred, true);
  assert.equal(logged[0].costUsd, 1);
});

test('the asset tools that import into Unity tell the worker about the deferred import', () => {
  for (const name of [T.BLENDER_TOOL, T.COMFY_TOOL, T.HIGGSFIELD_TOOL, T.IMPORT_TOOL]) {
    assert.match(T.ASSET_TOOLS.find((t) => t.name === name).description, /deferred to the scene-worker/, name);
  }
});

// ---- luna_asset_judge ------------------------------------------------------------------

test('luna_asset_judge schema: name, kind and 2 to 8 candidates, each a path or a library {source, id}', () => {
  const schema = T.ASSET_TOOLS.find((t) => t.name === T.JUDGE_TOOL).inputSchema;
  assert.equal(T.JUDGE_TOOL, 'luna_asset_judge');
  assert.deepEqual(schema.required, ['name', 'kind', 'candidates']);
  assert.deepEqual([schema.properties.candidates.minItems, schema.properties.candidates.maxItems], [2, 8]);
  const [file, library] = schema.properties.candidates.items.anyOf;
  assert.equal(file.type, 'string');
  assert.deepEqual(library.required, ['source', 'id']);
  assert.ok(library.properties.source.enum.includes('polypizza'));
  assert.ok(schema.properties.kind.enum.includes('audio'));
});

test('luna_asset_judge through createAssetToolsFor: previews fetched without the key, verdict logged, then Higgsfield refused', async () => {
  const fsx = require('fs');
  const os = require('os');
  const path = require('path');
  const repo = fsx.mkdtempSync(path.join(os.tmpdir(), 'lw-judge-tools-'));
  try {
    // Assembled at runtime: a library key must never show up in a preview download.
    const key = ['pp', 'k'.repeat(24)].join('-');
    const fetched = [];
    const reply = (buf) => ({ status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => buf });
    const fetch = async (url, init = {}) => {
      fetched.push({ url, init });
      if (url.startsWith('https://api.poly.pizza/')) {
        const id = url.split('/').pop();
        return reply(Buffer.from(JSON.stringify({ model: { ID: id, Title: `Crate ${id}`, Creator: { Username: 'u' }, Licence: 'CC0', Tags: ['box'], Download: `https://static.poly.pizza/${id}.glb`, Thumbnail: `https://static.poly.pizza/${id}.webp` } })));
      }
      return reply(PNG_BYTES);
    };
    const prompts = [];
    const execCalls = [];
    const recorded = [];
    const assetsFor = T.createAssetToolsFor({
      assetTools: () => ({ comfyuiPort: 8188, blenderPort: 9876, higgsfieldUsdPerCredit: 0.1, artRoot: 'Assets/X/Art' }),
      keys: { get: (source) => (source === 'polypizza' ? key : null), secrets: () => [key] },
      fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      execFile: (...args) => { execCalls.push(args); throw new Error('higgsfield must not run'); },
      runClaude: async (call) => {
        prompts.push(call.prompt);
        return { stdout: JSON.stringify({ structured_output: { scores: [{ name: 'candidate-1', score: 8, reference: '', notes: 'fits', silhouette: 8, palette: 8 }, { name: 'candidate-2', score: 4, reference: '', notes: 'off', silhouette: 4, palette: 4 }] } }) };
      },
    });
    const ctx = () => assetsFor({ repoPath: repo, recordSpend: () => ({ ok: true }), recordAsset: (e) => { recorded.push(e); return true; }, cappedTools: () => [] });
    const res = await T.callAssetTool(T.JUDGE_TOOL, { name: 'Wood Crate', kind: 'prop', candidates: [{ source: 'polypizza', id: 'abc' }, { source: 'polypizza', id: 'def' }] }, ctx());
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.payload.winner.candidate, { source: 'polypizza', id: 'abc' });
    assert.equal(res.payload.pass, true);

    const api = fetched.filter((f) => f.url.startsWith('https://api.poly.pizza/'));
    const previews = fetched.filter((f) => f.url.startsWith('https://static.poly.pizza/'));
    assert.equal(api.length, 2);
    assert.equal(api[0].init.headers['x-auth-token'], key, 'the API call itself is keyed');
    assert.deepEqual(previews.map((f) => f.url), ['https://static.poly.pizza/abc.webp', 'https://static.poly.pizza/def.webp']);
    for (const p of previews) {
      assert.equal(p.init.headers, undefined, 'no header at all on a preview download');
      assert.ok(!JSON.stringify(p).includes(key), 'the key never reaches a preview download');
    }
    assert.ok(fsx.existsSync(path.join(repo, 'art', 'candidates', 'wood-crate', 'polypizza-abc.png')));
    assert.ok(prompts[0].includes('art/candidates/wood-crate/polypizza-abc.png'));
    assert.deepEqual(recorded.map((e) => [e.tool, e.name]), [['judge', 'Wood Crate']]);

    // A new tool set (main.js builds one per request) still sees the verdict.
    const paid = await T.callAssetTool(T.HIGGSFIELD_TOOL, { name: 'Wood Crate', kind: 'prop', prompt: 'crate', model: 'gpt_image_2_6' }, ctx());
    assert.equal(paid.ok, false);
    assert.equal(paid.error.error, 'freeCandidatePassed');
    assert.deepEqual(execCalls, [], 'no Higgsfield CLI call, not even the estimate');
  } finally {
    await fsx.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ---- the cost guard reads the run record ------------------------------------------------

const { createToolGuard } = require('../src/lunasworkToolGuard.js');
const { runFreePassed } = require('../src/lunasworkAssetJudge.js');

/**
 * A run kept the way src/lunaswork.js keeps it: the real tool guard writes
 * run.assets, and restart() round-trips the run through JSON (the run file).
 */
function fakeRun(id) {
  let run = { id, phase: 'build', assets: [] };
  const guard = () => createToolGuard({ run: () => run, update: (f) => { run = { ...run, ...f }; }, logEvent: () => {}, armWait: () => {}, fileCards: () => [], now: () => 0 });
  let live = guard();
  return {
    recordAsset: (e) => live.recordAsset(e),
    recordJudgeVerdict: (v) => live.recordJudgeVerdict(v),
    judgeVerdicts: () => live.judgeVerdicts(),
    higgsfieldResults: () => live.higgsfieldResults(),
    restart: () => { run = JSON.parse(JSON.stringify(run)); live = guard(); },
    edit: (fn) => { run = fn(run); },
    raw: () => run,
  };
}

/** A temp repo with two local drafts, and a tool factory over a fresh (empty) verdict store. */
function guardSetup(score) {
  const fsx = require('fs');
  const os = require('os');
  const path = require('path');
  const repo = fsx.mkdtempSync(path.join(os.tmpdir(), 'lw-judge-run-'));
  fsx.mkdirSync(path.join(repo, 'art', 'drafts'), { recursive: true });
  for (const f of ['a.png', 'b.png']) fsx.writeFileSync(path.join(repo, 'art', 'drafts', f), PNG_BYTES);
  const execCalls = [];
  const scores = [{ name: 'candidate-1', score, reference: '', notes: 'fits', silhouette: score, palette: score }, { name: 'candidate-2', score: 3, reference: '', notes: 'off', silhouette: 3, palette: 3 }];
  const freshTools = () => T.createAssetToolsFor({
    assetTools: () => ({ comfyuiPort: 8188, blenderPort: 9876, higgsfieldUsdPerCredit: 0.1, artRoot: 'Assets/X/Art' }),
    execFile: (...args) => { execCalls.push(args); throw new Error('higgsfield stub: not installed'); },
    runClaude: async () => ({ stdout: JSON.stringify({ structured_output: { scores } }) }),
  });
  const ctxOf = (assetsFor, run, runId, repoPath = repo) => assetsFor({
    repoPath,
    runId,
    recordSpend: () => ({ ok: true }),
    recordAsset: (e) => run.recordAsset(e),
    cappedTools: () => [],
    judgeVerdicts: () => run.judgeVerdicts(),
  });
  const judge = (ctx) => T.callAssetTool(T.JUDGE_TOOL, { name: 'Wood Crate', kind: 'prop', candidates: ['art/drafts/a.png', 'art/drafts/b.png'] }, ctx);
  const paid = (ctx) => T.callAssetTool(T.HIGGSFIELD_TOOL, { name: 'Wood Crate', kind: 'prop', prompt: 'crate', model: 'gpt_image_2_6' }, ctx);
  const refusedCode = (res) => (res && res.error && res.error.error) || null;
  const cleanup = () => fsx.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { repo, execCalls, freshTools, ctxOf, judge, paid, refusedCode, cleanup };
}

test('the Higgsfield guard survives a restart: a passing free verdict in the run record still refuses a paid final', async () => {
  const s = guardSetup(8);
  try {
    const run = fakeRun('lw-a');
    const judged = await s.judge(s.ctxOf(s.freshTools(), run, 'lw-a'));
    assert.equal(judged.ok, true, JSON.stringify(judged));
    assert.equal(judged.payload.pass, true);
    // LunaCore restarts: the run comes back from its file, the tools (and their memory store) are new.
    run.restart();
    assert.equal(run.judgeVerdicts().entries.length, 1);
    const res = await s.paid(s.ctxOf(s.freshTools(), run, 'lw-a'));
    assert.equal(s.refusedCode(res), 'freeCandidatePassed', JSON.stringify(res));
    // Another package of the same run, in its own worktree, sees the same verdict.
    const other = await s.paid(s.ctxOf(s.freshTools(), run, 'lw-a', require('path').join(s.repo, 'elsewhere')));
    assert.equal(s.refusedCode(other), 'freeCandidatePassed');
    assert.deepEqual(s.execCalls, [], 'no Higgsfield CLI call, not even the estimate');
  } finally {
    await s.cleanup();
  }
});

test('a judge verdict of another run never blocks a paid final, from the record or from memory', async () => {
  const s = guardSetup(8);
  try {
    const runA = fakeRun('lw-a');
    const tools = s.freshTools();
    assert.equal((await s.judge(s.ctxOf(tools, runA, 'lw-a'))).ok, true);
    // A tab of run B reads run A's record (the active run changed under it): the record has no say.
    const crossed = await s.paid(s.ctxOf(tools, runA, 'lw-b'));
    assert.notEqual(s.refusedCode(crossed), 'freeCandidatePassed', JSON.stringify(crossed));
    // Run B in the same worktree and process: the verdict run A left in memory does not count either.
    const fresh = await s.paid(s.ctxOf(tools, fakeRun('lw-b'), 'lw-b'));
    assert.notEqual(s.refusedCode(fresh), 'freeCandidatePassed', JSON.stringify(fresh));
    assert.equal(s.execCalls.length > 0, true, 'the paid path ran (the CLI stub was reached)');
  } finally {
    await s.cleanup();
  }
});

test('the latest verdict in the run record counts; junk entries and other assets never block', async () => {
  const s = guardSetup(3);
  try {
    const run = fakeRun('lw-a');
    // A free pass first (written by hand), then a real failing verdict from the judge.
    assert.equal(run.recordAsset({ tool: 'judge', kind: 'prop', name: 'Wood Crate', prompt: 'free pass - candidate-1 scored 9/10', path: 'art/drafts/a.png' }), true);
    const failed = await s.judge(s.ctxOf(s.freshTools(), run, 'lw-a'));
    assert.equal(failed.payload.pass, false);
    run.restart();
    const res = await s.paid(s.ctxOf(s.freshTools(), run, 'lw-a'));
    assert.notEqual(s.refusedCode(res), 'freeCandidatePassed', 'a later failed verdict withdraws the pass');

    // A hand-edited run file: junk is dropped, a pass for another kind or name does not count.
    run.edit((r) => ({
      ...r,
      assets: [42, null, { tool: 'judge' }, { tool: 'judge', kind: 'prop', name: 7, prompt: 'free pass - x', path: 'p' },
        { tool: 'judge', kind: 'texture', name: 'Wood Crate', prompt: 'free pass - x', path: 'p' },
        { tool: 'judge', kind: 'prop', name: 'Iron Crate', prompt: 'free pass - x', path: 'p' }],
    }));
    run.restart();
    // name 7 survives as the string "7" (another asset); 42, null and the bare entry are dropped.
    assert.deepEqual(run.judgeVerdicts().entries.map((x) => x.name), ['7', 'Wood Crate', 'Iron Crate']);
    const junk = await s.paid(s.ctxOf(s.freshTools(), run, 'lw-a'));
    assert.notEqual(s.refusedCode(junk), 'freeCandidatePassed');
  } finally {
    await s.cleanup();
  }
});

test('a run record that is unreadable or has no entry leaves the guard to this process memory store', async () => {
  const s = guardSetup(9);
  try {
    const tools = s.freshTools();
    // The run log refuses the verdict (recordAsset false) and answers garbage when read.
    const garbage = { recordAsset: () => false, judgeVerdicts: () => ({ runId: 'lw-a', entries: 'nope' }) };
    const judged = await s.judge(s.ctxOf(tools, garbage, 'lw-a'));
    assert.equal(judged.payload.pass, true);
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(tools, garbage, 'lw-a'))), 'freeCandidatePassed');
    const throwing = { recordAsset: () => false, judgeVerdicts: () => { throw new Error('run file gone'); } };
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(tools, throwing, 'lw-a'))), 'freeCandidatePassed');
    const empty = { recordAsset: () => false, judgeVerdicts: () => ({ runId: 'lw-a', entries: [] }) };
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(tools, empty, 'lw-a'))), 'freeCandidatePassed');
    assert.deepEqual(s.execCalls, []);
  } finally {
    await s.cleanup();
  }
});

test('runFreePassed: only the record of the same run, only a well-formed latest entry', () => {
  const e = (prompt, extra = {}) => ({ tool: 'judge', kind: 'prop', name: 'Wood Crate', prompt, path: 'x', ...extra });
  const rec = (entries, runId = 'lw-a') => ({ runId, entries });
  assert.equal(runFreePassed(rec([e('free pass - ok')]), 'lw-a', 'prop', 'wood-crate'), true);
  assert.equal(runFreePassed(rec([e('free pass - ok')]), 'lw-b', 'prop', 'wood-crate'), null);
  assert.equal(runFreePassed(rec([e('free pass - ok'), e('no pass - bad')]), 'lw-a', 'prop', 'wood-crate'), false);
  assert.equal(runFreePassed(rec([e('pass - paid winner')]), 'lw-a', 'prop', 'wood-crate'), false);
  assert.equal(runFreePassed(rec([e('free pass - ok', { tool: 'higgsfield' })]), 'lw-a', 'prop', 'wood-crate'), null);
  for (const bad of [null, [], 'x', { runId: 'lw-a' }, { runId: 'lw-a', entries: {} }]) assert.equal(runFreePassed(bad, 'lw-a', 'prop', 'wood-crate'), null);
  assert.equal(runFreePassed(rec([e('free pass - ok')]), null, 'prop', 'wood-crate'), null);
  assert.equal(runFreePassed(rec([e('free pass - ok')]), '', 'prop', 'wood-crate'), null);
});

test('a newer free pass the run log refused still blocks, though the record holds an older no pass', async () => {
  const s = guardSetup(9);
  try {
    const run = fakeRun('lw-a');
    assert.equal(run.recordAsset({ tool: 'judge', kind: 'prop', name: 'Wood Crate', prompt: 'no pass - candidate-1 scored 2/10', path: 'art/drafts/a.png' }), true);
    // The run log refuses the new verdict (say the record is full or the run just ended).
    const refusing = { recordAsset: () => false, judgeVerdicts: () => run.judgeVerdicts() };
    const tools = s.freshTools();
    const judged = await s.judge(s.ctxOf(tools, refusing, 'lw-a'));
    assert.equal(judged.payload.pass, true);
    assert.match(judged.payload.note, /could not log this verdict/);
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(tools, refusing, 'lw-a'))), 'freeCandidatePassed');
    assert.deepEqual(s.execCalls, []);
  } finally {
    await s.cleanup();
  }
});

test('the Critic call is lean: no user settings, plugins or MCP servers ride along', () => {
  const { buildStyleArgs } = require('../src/lunasworkAssets.js');
  const args = buildStyleArgs();
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
});

// ---- luna_asset_blender `from`: provenance from the run record -------------------------

/** A Blender add-on stand-in on the socket: writes the .blend and the FBX the script names. */
function fakeBlenderNet() {
  const fsx = require('fs');
  const net = {
    createConnection() {
      const s = new EventEmitter();
      s.setTimeout = () => {};
      s.destroy = () => {};
      s.write = (data) => {
        const { code } = JSON.parse(data).params;
        const [blend, fbx] = [...code.matchAll(/filepath=("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
        fsx.writeFileSync(blend, Buffer.concat([Buffer.from('BLENDER-v400', 'latin1'), Buffer.alloc(16)]));
        fsx.writeFileSync(fbx, Buffer.concat([Buffer.from('Kaydara FBX Binary  \0', 'latin1'), Buffer.alloc(16)]));
        setImmediate(() => s.emit('data', Buffer.from(JSON.stringify({ status: 'success', result: { executed: true } }))));
      };
      setImmediate(() => s.emit('connect'));
      return s;
    },
  };
  return net;
}

test('luna_asset_blender from: the record is proven only by a higgsfield entry of this run in the run record', async () => {
  const fsx = require('fs');
  const os = require('os');
  const path = require('path');
  const ART_X = 'Assets/X/Art';
  const rel = `${ART_X}/Props/crate.png`;
  const record = 'art/higgsfield/prop/crate.json';
  const repoWith = () => {
    const repo = fsx.mkdtempSync(path.join(os.tmpdir(), 'lw-from-prov-'));
    for (const [r, data] of [[rel, PNG_BYTES], [record, JSON.stringify({ outputs: [rel] })]]) {
      fsx.mkdirSync(path.dirname(path.join(repo, r)), { recursive: true });
      fsx.writeFileSync(path.join(repo, r), data);
    }
    return repo;
  };
  const tools = T.createAssetToolsFor({
    assetTools: () => ({ comfyuiPort: 8188, blenderPort: 9876, higgsfieldUsdPerCredit: 0.1, artRoot: ART_X }),
    net: fakeBlenderNet(),
  });
  const runs = [];
  const blenderFrom = async (run, runId) => {
    const repo = repoWith();
    runs.push(repo);
    const ctx = tools({ repoPath: repo, runId, recordSpend: () => ({ ok: true }), recordAsset: (e) => run.recordAsset(e), cappedTools: () => [], judgeVerdicts: () => run.judgeVerdicts(), higgsfieldResults: () => run.higgsfieldResults() });
    const res = await T.callAssetTool(T.BLENDER_TOOL, { name: 'Crate', kind: 'prop', from: rel }, ctx);
    assert.equal(res.ok, true, JSON.stringify(res));
    return { payload: res.payload, ledger: fsx.readFileSync(path.join(repo, 'design', 'ASSET_LICENSES.md'), 'utf8') };
  };
  try {
    const run = fakeRun('lw-p');
    // Forged: the record and the file exist, but no luna_asset_higgsfield call of this run made them.
    const forged = await blenderFrom(run, 'lw-p');
    assert.equal(forged.payload.from.recordProven, false);
    assert.match(forged.payload.note, /claimed Higgsfield record/);
    assert.match(forged.ledger, /\| Crate \| claimed Higgsfield record art\/higgsfield\/prop\/crate\.json \|/);

    // Genuine: luna_asset_higgsfield logged it in this run; the run record survives a restart.
    const sha256 = require('crypto').createHash('sha256').update(PNG_BYTES).digest('hex');
    assert.equal(run.recordAsset({ tool: 'higgsfield', kind: 'prop', name: 'Crate', prompt: 'toon crate', path: rel, sources: [record], costUsd: 0.2, sha256 }), true);
    run.restart();
    const genuine = await blenderFrom(run, 'lw-p');
    assert.equal(genuine.payload.from.recordProven, true);
    assert.doesNotMatch(genuine.payload.note || '', /claimed/);
    assert.match(genuine.ledger, /\| Crate \| art\/higgsfield\/prop\/crate\.json \| LunaCore asset worker \(Higgsfield \+ Blender\) \|/);

    // The same entry under another run id, an unsaved entry, or an unreadable record proves nothing.
    assert.equal((await blenderFrom(run, 'lw-other')).payload.from.recordProven, false);
    const unsaved = fakeRun('lw-u');
    unsaved.recordAsset({ tool: 'higgsfield', kind: 'prop', name: 'Crate', prompt: 'x', path: rel, sources: [record], unsaved: true, sha256 });
    assert.deepEqual(unsaved.higgsfieldResults().entries, []);
    assert.equal((await blenderFrom(unsaved, 'lw-u')).payload.from.recordProven, false);
    const throwing = { ...run, higgsfieldResults: () => { throw new Error('run file gone'); } };
    assert.equal((await blenderFrom(throwing, 'lw-p')).payload.from.recordProven, false);
  } finally {
    for (const repo of runs) await fsx.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// ---- the cost guard: verdicts past the asset log cap, keyed on the cast asset -------------

const { cleanGuardFields } = require('../src/lunasworkToolGuard.js');

const ASSETS_HEADER = ['| Name | Type | Spec | Source | File | Status | Hash | Ref |', '|---|---|---|---|---|---|---|---|'];

/**
 * A worker repo with four local drafts (and optionally its own design/ASSETS.md),
 * the run's checkout holding the cast list, and tools whose Critic answers the
 * queued score pairs. Every ctxOf() builds fresh tools: an empty memory store,
 * as after a LunaCore restart, unless a tool set is passed in.
 */
function castSetup({ cast = ['Wooden Crate', 'Iron Barrel'], workerRows = null } = {}) {
  const fsx = require('fs');
  const os = require('os');
  const path = require('path');
  const writeList = (dir, names) => {
    fsx.mkdirSync(path.join(dir, 'design'), { recursive: true });
    const rows = names.map((n) => `| ${n} | prop | ${n.toLowerCase()} for the dock | auto |  | queued |  |  |`);
    fsx.writeFileSync(path.join(dir, 'design', 'ASSETS.md'), ['# Assets', '', ...ASSETS_HEADER, ...rows, ''].join('\n'));
  };
  const repo = fsx.mkdtempSync(path.join(os.tmpdir(), 'lw-guard-worker-'));
  const checkout = fsx.mkdtempSync(path.join(os.tmpdir(), 'lw-guard-run-'));
  fsx.mkdirSync(path.join(repo, 'art', 'drafts'), { recursive: true });
  for (const f of ['a', 'b', 'c', 'd']) fsx.writeFileSync(path.join(repo, 'art', 'drafts', `${f}.png`), PNG_BYTES);
  if (cast) writeList(checkout, cast);
  if (workerRows) writeList(repo, workerRows);
  const execCalls = [];
  const queued = [];
  const score = (name, n) => ({ name, score: n, reference: '', notes: 'n', silhouette: n, palette: n });
  const freshTools = () => T.createAssetToolsFor({
    assetTools: () => ({ comfyuiPort: 8188, blenderPort: 9876, higgsfieldUsdPerCredit: 0.1, artRoot: 'Assets/X/Art' }),
    execFile: (...args) => { execCalls.push(args); throw new Error('higgsfield stub: not installed'); },
    runClaude: async () => {
      const [first, second] = queued.shift();
      return { stdout: JSON.stringify({ structured_output: { scores: [score('candidate-1', first), score('candidate-2', second)] } }) };
    },
  });
  const ctxOf = (run, tools = freshTools()) => tools({
    repoPath: repo,
    castRepoPath: checkout,
    runId: 'lw-c',
    recordSpend: () => ({ ok: true }),
    cappedTools: () => [],
    recordAsset: (e) => run.recordAsset(e),
    judgeVerdicts: () => run.judgeVerdicts(),
    recordJudgeVerdict: (v) => run.recordJudgeVerdict(v),
  });
  /** One judge call over art/drafts/<file>.png; `pair` = the scores of the first and the second candidate. */
  const judge = async (ctx, name, files, pair) => {
    queued.push(pair);
    const res = await T.callAssetTool(T.JUDGE_TOOL, { name, kind: 'prop', candidates: files.map((f) => `art/drafts/${f}.png`) }, ctx);
    assert.equal(res.ok, true, JSON.stringify(res));
    return res.payload;
  };
  const paid = (ctx, name, kind = 'prop') => T.callAssetTool(T.HIGGSFIELD_TOOL, { name, kind, prompt: 'crate', model: 'gpt_image_2_6' }, ctx);
  const refusedCode = (res) => (res && res.error && res.error.error) || null;
  const cleanup = async () => {
    for (const dir of [repo, checkout]) await fsx.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { repo, checkout, execCalls, freshTools, ctxOf, judge, paid, refusedCode, cleanup };
}

test('a free pass survives 500+ later asset entries and a restart: the paid final is still refused', async () => {
  const s = castSetup({ cast: null });
  try {
    const run = fakeRun('lw-c');
    assert.equal((await s.judge(s.ctxOf(run), 'Wood Crate', ['a', 'b'], [8, 3])).pass, true);
    for (let i = 0; i < 600; i += 1) {
      assert.equal(run.recordAsset({ tool: 'comfyui', kind: 'sprite', name: `Filler ${i}`, prompt: 'x', path: `art/comfyui/filler-${i}.png` }), true);
    }
    // LunaCore restarts: the run comes back from its file, the tools and their memory store are new.
    run.restart();
    const record = run.judgeVerdicts();
    assert.deepEqual(record.entries, [], 'the judge entry fell out of the 500-entry asset log');
    assert.deepEqual(record.verdicts.map((v) => [v.name, v.freePass, v.winner, v.candidates]), [['Wood Crate', true, 'art/drafts/a.png', ['art/drafts/a.png', 'art/drafts/b.png']]]);
    const res = await s.paid(s.ctxOf(run), 'Wood Crate');
    assert.equal(s.refusedCode(res), 'freeCandidatePassed', JSON.stringify(res));
    assert.deepEqual(s.execCalls, [], 'no Higgsfield CLI call, not even the estimate');
  } finally {
    await s.cleanup();
  }
});

test('a run recorded before the verdict list still counts its asset-log verdicts and carries them over', async () => {
  const s = castSetup({ cast: null });
  try {
    const run = fakeRun('lw-c');
    assert.equal(run.recordAsset({ tool: 'judge', kind: 'prop', name: 'Wood Crate', prompt: 'free pass - candidate-1 scored 9/10', path: 'art/drafts/a.png' }), true);
    run.restart();
    assert.equal(run.judgeVerdicts().verdicts, null, 'no list yet: an old run record');
    assert.equal(cleanGuardFields({}).judgeVerdicts, null);
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(run), 'Wood Crate')), 'freeCandidatePassed');
    // The next verdict (junk on other drafts) starts the list: the old pass is carried over first and still stands.
    assert.equal((await s.judge(s.ctxOf(run), 'Wood Crate', ['c', 'd'], [3, 1])).pass, false);
    run.restart();
    assert.deepEqual(run.raw().judgeVerdicts.map((v) => [v.freePass, v.winner]), [[true, 'art/drafts/a.png'], [false, 'art/drafts/c.png']]);
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(run), 'Wood Crate')), 'freeCandidatePassed');
    assert.deepEqual(s.execCalls, []);
  } finally {
    await s.cleanup();
  }
});

test('the guard keys on the cast asset: a renamed request is still refused after a free pass, a name off the list too', async () => {
  // The worker's own copy of the list gained a row for the renamed request: only the run's checkout counts.
  const s = castSetup({ workerRows: ['Wooden Crate', 'Iron Barrel', 'Wood Crate 2'] });
  try {
    const run = fakeRun('lw-c');
    assert.equal((await s.judge(s.ctxOf(run), 'Wooden Crate', ['a', 'b'], [8, 3])).pass, true);
    run.restart();
    for (const [name, kind] of [['Wooden Crate', 'prop'], ['Wood Crate 2', 'prop'], ['wooden crates', 'prop'], ['Wooden Crate final', 'prop'], ['Wooden Crate', 'texture']]) {
      const res = await s.paid(s.ctxOf(run), name, kind);
      assert.equal(s.refusedCode(res), 'freeCandidatePassed', `${name} (${kind}): ${JSON.stringify(res)}`);
    }
    const off = await s.paid(s.ctxOf(run), 'Spaceship');
    assert.equal(s.refusedCode(off), 'notCastAsset', JSON.stringify(off));
    assert.match(JSON.stringify(off), /design\/ASSETS\.md/);
    assert.deepEqual(s.execCalls, [], 'no Higgsfield CLI call, not even the estimate');
    // Another cast asset has no pass: its paid final goes ahead (the CLI stub is reached).
    const other = await s.paid(s.ctxOf(run), 'Iron Barrel');
    assert.ok(!['freeCandidatePassed', 'notCastAsset'].includes(s.refusedCode(other)), JSON.stringify(other));
    assert.ok(s.execCalls.length > 0);
  } finally {
    await s.cleanup();
  }
});

test('a failing re-judge with unrelated candidates keeps the free pass; one of the same winner withdraws it', async () => {
  const s = castSetup();
  try {
    const run = fakeRun('lw-c');
    const tools = s.freshTools();
    assert.equal((await s.judge(s.ctxOf(run, tools), 'Wooden Crate', ['a', 'b'], [8, 3])).pass, true);
    // Junk re-judged under the same name, and under a variant of it: nothing is taken back.
    assert.equal((await s.judge(s.ctxOf(run, tools), 'Wooden Crate', ['c', 'd'], [3, 1])).pass, false);
    assert.equal((await s.judge(s.ctxOf(run, tools), 'Wood Crate 2', ['d', 'c'], [2, 1])).pass, false);
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(run, tools), 'Wooden Crate')), 'freeCandidatePassed', 'this process');
    run.restart();
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(run), 'Wooden Crate')), 'freeCandidatePassed', 'the run record after a restart');
    assert.deepEqual(s.execCalls, []);
    // The passing winner judged again and now below the pass mark: the pass is withdrawn.
    const again = await s.judge(s.ctxOf(run, tools), 'Wooden Crate', ['a', 'c'], [4, 2]);
    assert.equal(again.pass, false);
    assert.equal(again.winner.candidate, 'art/drafts/a.png');
    const here = await s.paid(s.ctxOf(run, tools), 'Wooden Crate');
    assert.notEqual(s.refusedCode(here), 'freeCandidatePassed', JSON.stringify(here));
    run.restart();
    const res = await s.paid(s.ctxOf(run), 'Wooden Crate');
    assert.notEqual(s.refusedCode(res), 'freeCandidatePassed', JSON.stringify(res));
    assert.ok(s.execCalls.length > 0, 'the paid path ran (the CLI stub was reached)');
  } finally {
    await s.cleanup();
  }
});

test('a cast list that cannot be read refuses the paid final (fail closed)', async () => {
  const s = castSetup({ cast: null });
  try {
    require('fs').mkdirSync(require('path').join(s.checkout, 'design', 'ASSETS.md'), { recursive: true });
    const res = await s.paid(s.ctxOf(fakeRun('lw-c')), 'Wooden Crate');
    assert.equal(s.refusedCode(res), 'assetListUnreadable', JSON.stringify(res));
    assert.deepEqual(s.execCalls, []);
  } finally {
    await s.cleanup();
  }
});

test('recordJudgeVerdict: validated, kept apart from the asset log, refused on a finished run', () => {
  let run = { id: 'lw-g', phase: 'build', assets: [] };
  const g = createToolGuard({ run: () => run, update: (f) => { run = { ...run, ...f }; }, logEvent: () => {}, armWait: () => {}, fileCards: () => [], now: () => 7 });
  assert.equal(g.recordJudgeVerdict(null), false);
  assert.equal(g.recordJudgeVerdict({ kind: 'prop', name: 'Crate', winner: 'w', candidates: ['x', 'y'] }), false, 'a winner that is not a candidate');
  assert.equal(g.recordJudgeVerdict({ kind: 'nope', name: 'Crate', winner: 'x', candidates: ['x', 'y'] }), false);
  assert.equal(g.recordJudgeVerdict({ kind: 'prop', name: 'Crate', freePass: true, pass: true, winner: 'x', candidates: ['x', 'y'], extra: 'dropped' }), true);
  assert.deepEqual(run.judgeVerdicts, [{ at: 7, kind: 'prop', name: 'Crate', freePass: true, pass: true, winner: 'x', candidates: ['x', 'y'] }]);
  assert.deepEqual(run.assets, [], 'the asset log is not touched');
  assert.deepEqual(g.judgeVerdicts().verdicts, run.judgeVerdicts);
  run = { ...run, phase: 'done' };
  assert.equal(g.recordJudgeVerdict({ kind: 'prop', name: 'Crate', winner: 'x', candidates: ['x', 'y'] }), false);
});

test('a re-judge whose winner now reads as paid or of unknown origin never withdraws the free pass', async () => {
  const s = castSetup();
  try {
    const run = fakeRun('lw-c');
    const tools = s.freshTools();
    assert.equal((await s.judge(s.ctxOf(run, tools), 'Wooden Crate', ['a', 'b'], [8, 3])).pass, true);
    // The worker plants a broken Higgsfield record in its own worktree: the same winner now has an unknown origin.
    const fsx = require('fs');
    const path = require('path');
    fsx.mkdirSync(path.join(s.repo, 'art', 'higgsfield', 'prop'), { recursive: true });
    fsx.writeFileSync(path.join(s.repo, 'art', 'higgsfield', 'prop', 'planted.json'), '{ not json');
    const again = await s.judge(s.ctxOf(run, tools), 'Wooden Crate', ['a', 'c'], [8, 2]);
    assert.equal(again.pass, true);
    assert.equal(again.winner.origin, 'unknown');
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(run, tools), 'Wooden Crate')), 'freeCandidatePassed', 'this process');
    run.restart();
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(run), 'Wooden Crate')), 'freeCandidatePassed', 'the run record');
    assert.deepEqual(s.execCalls, []);
  } finally {
    await s.cleanup();
  }
});

test('a pass only this process holds is matched to its asset when the paid final asks, not when it was judged', async () => {
  const s = castSetup({ cast: null });
  try {
    const fsx = require('fs');
    const path = require('path');
    // The run record keeps nothing (say the run just ended under the worker): only the memory store has the verdict.
    const lost = { recordAsset: () => false, recordJudgeVerdict: () => false, judgeVerdicts: () => null };
    const tools = s.freshTools();
    assert.equal((await s.judge(s.ctxOf(lost, tools), 'Wooden Crate', ['a', 'b'], [8, 3])).pass, true);
    // The asset list appears after the verdict: the renamed request still resolves to the judged asset.
    fsx.mkdirSync(path.join(s.checkout, 'design'), { recursive: true });
    fsx.writeFileSync(path.join(s.checkout, 'design', 'ASSETS.md'), [...ASSETS_HEADER, '| Wooden Crate | prop | a crate | auto |  | queued |  |  |', ''].join('\n'));
    assert.equal(s.refusedCode(await s.paid(s.ctxOf(lost, tools), 'Wood Crate 2')), 'freeCandidatePassed');
    assert.deepEqual(s.execCalls, []);
  } finally {
    await s.cleanup();
  }
});
