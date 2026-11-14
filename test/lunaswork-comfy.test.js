// ============================================================================
// ComfyUI HTTP client (src/lunasworkComfy.js): POST /prompt, poll
// /history/<id>, download from /view - against a fake fetch. Loopback only,
// redirects refused, every reply validated, clear errors with codes.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../src/lunasworkComfy.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 2)]);
const WF = {
  3: { class_type: 'KSampler', inputs: { seed: 0, noise_seed: 1, steps: 20 } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'toon, {{prompt}}, clean lines' } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } },
};

/** A fetch Response stand-in. */
function reply(status, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h === 'content-length' ? String(buf.length) : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
  };
}

/** A fake ComfyUI: queued -> running (historyEmpty polls) -> success with one image. */
function fakeComfy({ historyEmpty = 2, entry, promptReply, image = PNG } = {}) {
  const requests = [];
  let polls = 0;
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/prompt') return promptReply || reply(200, { prompt_id: 'p-1', number: 1, node_errors: {} });
    if (u.pathname === '/history/p-1') {
      polls += 1;
      if (polls <= historyEmpty) return reply(200, {});
      return reply(200, { 'p-1': entry || { status: { status_str: 'success', completed: true }, outputs: { 9: { images: [{ filename: 'x_00001_.png', subfolder: '', type: 'output' }] } } } });
    }
    if (u.pathname === '/view') return reply(200, image);
    return reply(404, 'not found');
  };
  return { fetch, requests };
}

const client = (fake, extra = {}) => C.createComfyClient({ fetch: fake.fetch, sleep: async () => {}, pollMs: 1, ...extra });

test('run: POST /prompt, poll /history until done, download from /view on 127.0.0.1:8188', async () => {
  const fake = fakeComfy();
  const res = await client(fake).run(WF);
  assert.equal(res.promptId, 'p-1');
  assert.equal(res.images.length, 1);
  assert.deepEqual([res.images[0].ext, res.images[0].data.equals(PNG)], ['png', true]);
  const urls = fake.requests.map((r) => new URL(r.url));
  assert.ok(urls.every((u) => u.host === '127.0.0.1:8188'));
  assert.deepEqual(urls.map((u) => u.pathname), ['/prompt', '/history/p-1', '/history/p-1', '/history/p-1', '/view']);
  assert.equal(urls[4].searchParams.get('filename'), 'x_00001_.png');
  assert.ok(fake.requests.every((r) => r.init.redirect === 'error' && r.init.signal));
  const sent = JSON.parse(fake.requests[0].init.body);
  assert.deepEqual(sent.prompt, WF);
  assert.match(sent.client_id, /^lunacore-/);
});

test('the port is configurable and validated; the host never is', async () => {
  const fake = fakeComfy({ historyEmpty: 0 });
  await client(fake, { port: 8190 }).run(WF);
  assert.ok(fake.requests.every((r) => r.url.startsWith('http://127.0.0.1:8190/')));
  for (const port of [0, 70000, '8188', 1.5]) assert.throws(() => C.createComfyClient({ port, fetch: fake.fetch }), { code: C.COMFY_ERROR.badConfig });
});

test('a refused workflow, a failed run and a run with no image are clear errors', async () => {
  const rejected = fakeComfy({ promptReply: reply(400, { error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' }, node_errors: { 4: { errors: [{ message: 'Value not in list: ckpt_name' }] } } }) });
  await assert.rejects(client(rejected).run(WF), (err) => err.code === C.COMFY_ERROR.rejected && /node 4: Value not in list/.test(err.message));
  const failed = fakeComfy({ historyEmpty: 0, entry: { status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'KSampler', exception_message: 'HIP out of memory' }]] }, outputs: {} } });
  await assert.rejects(client(failed).run(WF), (err) => err.code === C.COMFY_ERROR.failed && /KSampler: HIP out of memory/.test(err.message));
  const empty = fakeComfy({ historyEmpty: 0, entry: { status: { status_str: 'success', completed: true }, outputs: {} } });
  await assert.rejects(client(empty).run(WF), { code: C.COMFY_ERROR.noOutput });
});

test('a run that never finishes times out; a dead server is unreachable', async () => {
  let t = 0;
  const slow = fakeComfy({ historyEmpty: Infinity });
  await assert.rejects(client(slow, { now: () => (t += 1000), maxWaitMs: 5000 }).run(WF), { code: C.COMFY_ERROR.timeout });
  const dead = { fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } };
  await assert.rejects(client(dead).run(WF), (err) => err.code === C.COMFY_ERROR.unreachable && /ECONNREFUSED/.test(err.message));
  const hung = { fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } };
  await assert.rejects(client(hung).run(WF), { code: C.COMFY_ERROR.timeout });
});

test('replies are validated: prompt id, output names, image bytes, size', async () => {
  const badId = fakeComfy({ promptReply: reply(200, { prompt_id: '../../x' }) });
  await assert.rejects(client(badId).run(WF), { code: C.COMFY_ERROR.badReply });
  const notJson = fakeComfy({ promptReply: reply(200, '<html>') });
  await assert.rejects(client(notJson).run(WF), { code: C.COMFY_ERROR.badReply });
  const html = fakeComfy({ historyEmpty: 0, image: Buffer.from('<html><body>not an image</body></html>') });
  await assert.rejects(client(html).run(WF), { code: C.COMFY_ERROR.badReply });
  assert.deepEqual(C.outputFiles({ outputs: { 1: { images: [
    { filename: '../evil.png', subfolder: '', type: 'output' },
    { filename: 'ok.png', subfolder: '../..', type: 'output' },
    { filename: 'a/b.png', type: 'output' },
    { filename: 'good.png', subfolder: 'sub', type: 'output' },
    { filename: 'preview.png', type: 'temp' },
  ] } } }), [{ filename: 'good.png', subfolder: 'sub', type: 'output' }]);
  const normal = fakeComfy({ historyEmpty: 0 });
  const huge = { ok: true, status: 200, headers: { get: () => String(60 * 1024 * 1024) }, arrayBuffer: async () => new ArrayBuffer(0) };
  const bigFetch = async (url, init) => (new URL(url).pathname === '/view' ? huge : normal.fetch(url, init));
  await assert.rejects(client({ fetch: bigFetch }).run(WF), (err) => err.code === C.COMFY_ERROR.badReply && /too large/.test(err.message));
});

test('readCappedBody: a stream is cut at the cap, not buffered first; a short stream is joined', async () => {
  const streamOf = (chunks) => {
    const state = { reads: 0, cancelled: false };
    const body = { getReader: () => ({
      read: async () => (state.reads < chunks.length ? { done: false, value: chunks[state.reads++] } : { done: true, value: undefined }),
      cancel: async () => { state.cancelled = true; },
    }) };
    return { res: { headers: { get: () => null }, body, arrayBuffer: async () => assert.fail('must stream') }, state };
  };
  const small = streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]);
  assert.deepEqual([...(await C.readCappedBody(small.res, 10))], [1, 2, 3]);
  const big = streamOf([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)]);
  await assert.rejects(C.readCappedBody(big.res, 10), (err) => err.code === 'BODY_TOO_LARGE');
  assert.deepEqual([big.state.reads, big.state.cancelled], [2, true]);
  // Through the client: an endless /view stream is a badReply, not an out-of-memory.
  const normal = fakeComfy({ historyEmpty: 0 });
  const endless = { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(16 * 1024 * 1024) }), cancel: async () => {} }) } };
  const fetch = async (url, init) => (new URL(url).pathname === '/view' ? endless : normal.fetch(url, init));
  await assert.rejects(client({ fetch }).run(WF), (err) => err.code === C.COMFY_ERROR.badReply && /too large/.test(err.message));
});

test('workflow helpers: API format only, seeds and the prompt placeholder, no mutation', () => {
  assert.equal(C.validateWorkflow(WF).ok, true);
  assert.match(C.validateWorkflow({ nodes: [], links: [] }).error, /API Format/);
  assert.equal(C.validateWorkflow({}).ok, false);
  assert.equal(C.validateWorkflow({ 1: { inputs: {} } }).ok, false);
  assert.equal(C.validateWorkflow([]).ok, false);
  const seeded = C.applySeed(WF, 42);
  assert.deepEqual([seeded.seeded, seeded.workflow['3'].inputs.seed, seeded.workflow['3'].inputs.noise_seed], [2, 42, 42]);
  assert.equal(WF['3'].inputs.seed, 0, 'the input workflow is not mutated');
  assert.throws(() => C.applySeed(WF, -1), { code: C.COMFY_ERROR.badWorkflow });
  const prompted = C.applyPrompt(WF, 'a ronin');
  assert.deepEqual([prompted.replaced, prompted.workflow['6'].inputs.text], [1, 'toon, a ronin, clean lines']);
  const seed = C.randomSeed();
  assert.ok(Number.isSafeInteger(seed) && seed >= 0);
  assert.equal(C.imageKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'webp');
  assert.equal(C.imageKind(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
});
