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

test('download: public https only, redirects checked, size capped', async () => {
  for (const bad of ['http://cdn.example.test/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://nas.local/a.png', 'https://u:p@cdn.example.test/a', 'file:///etc/passwd']) {
    assert.equal(T.isPublicHttps(bad), false, bad);
  }
  assert.equal(T.isPublicHttps('https://cdn.example.test/a.png'), true);
  const ok = (body, extra = {}) => ({ ok: true, status: 200, url: 'https://cdn.example.test/a.png', headers: { get: () => null }, arrayBuffer: async () => body, ...extra });
  const dl = T.createDownloader({ fetch: async () => ok(new Uint8Array([1, 2, 3]).buffer) });
  assert.deepEqual([...(await dl('https://cdn.example.test/a.png'))], [1, 2, 3]);
  await assert.rejects(dl('http://cdn.example.test/a.png'), /public https/);
  const redirected = T.createDownloader({ fetch: async () => ok(new ArrayBuffer(1), { url: 'http://10.0.0.5/x' }) });
  await assert.rejects(redirected('https://cdn.example.test/a.png'), /redirected/);
  const huge = T.createDownloader({ fetch: async () => ok(new ArrayBuffer(1), { headers: { get: () => String(200 * 1024 * 1024) } }) });
  await assert.rejects(huge('https://cdn.example.test/a.png'), /too large/);
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
