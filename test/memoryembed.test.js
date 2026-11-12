// ============================================================================
// LunaCore - memory embeddings (src/memoryembed.js)
// ----------------------------------------------------------------------------
// LM Studio is a fake `fetch`: a model list and an embeddings route that turns
// a text into a small vector, so nothing here needs a model.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEmbedder, createVectorStore, pickModel, parseEmbeddings, vectorsPath } = require('../src/memoryembed.js');

const SMALL = 'text-embedding-qwen3-embedding-0.6b';
const BIG = 'text-embedding-qwen3-embedding-4b';
const row = (id, type = 'embeddings') => ({ id, type });
const quiet = () => {};

/** A text -> a vector that depends on its length and first letter, so two texts differ. */
const fakeVector = (text) => [text.length, text.charCodeAt(0) || 1, 1];

/**
 * @param {{models?: object[], answerAs?: string|null, down?: boolean, failOn?: string|null}} world failOn = a text that makes a request fail
 * @returns {{fetchImpl: Function, calls: object[], world: object}}
 */
function lmStudio(world = {}) {
  const calls = [];
  const state = { models: [row(SMALL)], answerAs: null, down: false, failOn: null, ...world };
  const fetchImpl = async (url, init = {}) => {
    if (state.down) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const route = new URL(url).pathname;
    if (route === '/api/v0/models') return { ok: true, json: async () => ({ data: state.models }) };
    const body = JSON.parse(init.body);
    calls.push(body);
    if (state.failOn && body.input.some((text) => text.includes(state.failOn))) return { ok: false, status: 500 };
    const data = body.input.map((text, index) => ({ index, embedding: fakeVector(text) }));
    return { ok: true, json: async () => ({ model: state.answerAs || body.model, data }) };
  };
  return { fetchImpl, calls, world: state };
}

const tmpFile = () => vectorsPath(fs.mkdtempSync(path.join(os.tmpdir(), 'luna-vec-')));
const rec = (title, body = 'body') => ({ title, body });
const length = (v) => Math.hypot(...v);

test('picks the best preferred embedding model that is installed', () => {
  assert.equal(pickModel({ data: [row(SMALL), row(BIG)] }), BIG);
  assert.equal(pickModel({ data: [row('text-embedding-nomic-embed-text-v1.5'), row(SMALL)] }), SMALL);
});

test('never picks a model LM Studio lists as an LLM, or one outside the list', () => {
  assert.equal(pickModel({ data: [row('qwen3-embedding-4b', 'llm')] }), null);
  assert.equal(pickModel({ data: [row('text-embedding-nomic-embed-text-v1.5')] }), null);
  assert.equal(pickModel({ data: [row(SMALL)] }, 'harrier'), null);
  assert.equal(pickModel({ data: [row('my-embedder')] }, 'my-embedder'), 'my-embedder');
  assert.equal(pickModel(null), null);
});

test('rejects a reply another model answered', () => {
  const body = { model: SMALL, data: [{ index: 0, embedding: [1, 0] }] };

  assert.throws(() => parseEmbeddings(body, BIG, 1), /answered by/);
  assert.equal(parseEmbeddings(body, SMALL, 1).length, 1);
});

test('rejects a reply with a missing, empty or non-numeric vector', () => {
  const reply = (...embeddings) => ({ model: SMALL, data: embeddings.map((embedding, index) => ({ index, embedding })) });

  assert.throws(() => parseEmbeddings(reply([1, 0]), SMALL, 2), /got 1/);
  assert.throws(() => parseEmbeddings(reply([0, 0]), SMALL, 1), /unusable/);
  assert.throws(() => parseEmbeddings(reply([1, 'x']), SMALL, 1), /unusable/);
  assert.throws(() => parseEmbeddings(reply([1, 0], [1, 0, 0]), SMALL, 2), /unusable/);
});

test('returns unit vectors in input order', () => {
  const body = {
    model: SMALL,
    data: [
      { index: 1, embedding: [0, 2] },
      { index: 0, embedding: [3, 4] },
    ],
  };

  const [first, second] = parseEmbeddings(body, SMALL, 2);

  assert.ok(Math.abs(first[0] - 0.6) < 1e-6 && Math.abs(first[1] - 0.8) < 1e-6);
  assert.deepEqual([...second], [0, 1]);
});

test('an embedder never talks to another machine', async () => {
  const { fetchImpl, calls } = lmStudio();
  const embedder = createEmbedder({ baseUrl: 'http://example.com:1234', fetchImpl, log: quiet });

  assert.equal(await embedder.model(), null);
  assert.equal(calls.length, 0);
});

test('an embedder without LM Studio answers null and says why once', async () => {
  const lines = [];
  const { fetchImpl } = lmStudio({ down: true });
  let at = 0;
  const embedder = createEmbedder({ fetchImpl, now: () => at, log: (line) => lines.push(line) });

  assert.equal(await embedder.model(), null);
  at += 60000;
  assert.equal(await embedder.model(), null);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /ECONNREFUSED/);
});

test('an embedder gives up on a reply from a substituted model', async () => {
  const { fetchImpl } = lmStudio({ answerAs: 'something-else' });
  const embedder = createEmbedder({ fetchImpl, log: quiet });

  assert.equal(await embedder.embed(SMALL, ['hello']), null);
});

test('the store embeds every memory once and keeps the vectors in its file', async () => {
  const file = tmpFile();
  const { fetchImpl, calls } = lmStudio();
  const records = [
    ['p/a', rec('alpha')],
    ['p/b', rec('beta beta')],
  ];

  const store = createVectorStore({ file, embedder: createEmbedder({ fetchImpl, log: quiet }) });
  const live = store.prepare(records);
  assert.equal(live.size, 0, 'nothing is known before the model answered');
  await store.ready();

  assert.equal(live.size, 2);
  assert.ok(live.get('p/b'));
  assert.ok(Math.abs(length(live.get('p/a')) - 1) < 1e-6);
  assert.deepEqual(store.status(), { model: SMALL, count: 2 });

  const again = createVectorStore({ file, embedder: createEmbedder({ fetchImpl, log: quiet }) });
  const cached = again.prepare(records);
  await again.ready();

  assert.equal(cached.size, 2);
  assert.equal(calls.length, 1, 'a second start reads the file instead of the model');
});

test('the store embeds again only what changed and forgets what was deleted', async () => {
  const file = tmpFile();
  const { fetchImpl, calls } = lmStudio();
  const store = createVectorStore({ file, embedder: createEmbedder({ fetchImpl, log: quiet }) });
  store.prepare([
    ['p/a', rec('alpha')],
    ['p/b', rec('beta')],
  ]);
  await store.ready();

  const live = store.prepare([['p/a', rec('alpha, rewritten')]]);
  assert.equal(live.size, 0);
  await store.ready();

  assert.deepEqual(calls.at(-1).input, ['alpha, rewritten\n\nbody']);
  assert.deepEqual(store.status(), { model: SMALL, count: 1 });
});

test('a better model installed later replaces every vector', async () => {
  const file = tmpFile();
  const studio = lmStudio();
  let at = 0;
  const store = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: studio.fetchImpl, now: () => at, log: quiet }) });
  const records = [['p/a', rec('alpha')]];
  store.prepare(records);
  await store.ready();
  assert.ok(await store.queryVector('alpha?'));

  studio.world.models = [row(SMALL), row(BIG)];
  at += 120000;

  assert.equal(await store.queryVector('alpha?'), null, 'a question is not compared with vectors of the old model');
  const live = store.prepare(records);
  await store.ready();

  assert.equal(store.status().model, BIG);
  assert.equal(live.size, 1);
  assert.ok(await store.queryVector('alpha?'));
});

test('a new process notices that the cache was built with another model', async () => {
  const file = tmpFile();
  const records = [['p/a', rec('alpha')]];
  const first = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: lmStudio().fetchImpl, log: quiet }) });
  first.prepare(records);
  await first.ready();

  const studio = lmStudio({ models: [row(SMALL), row(BIG)] });
  const second = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: studio.fetchImpl, log: quiet }) });
  const live = second.prepare(records);
  await second.ready();

  assert.equal(second.status().model, BIG);
  assert.equal(studio.calls.at(-1).model, BIG);
  assert.equal(live.size, 1);
  assert.ok(await second.queryVector('alpha?'));
});

test('without a model the store stays empty and a question has no vector', async () => {
  const { fetchImpl } = lmStudio({ models: [] });
  const store = createVectorStore({ file: tmpFile(), embedder: createEmbedder({ fetchImpl, log: quiet }) });

  const live = store.prepare([['p/a', rec('alpha')]]);
  await store.ready();

  assert.equal(live.size, 0);
  assert.equal(await store.queryVector('alpha?'), null);
});

test('rejects a reply that answers one input twice or skips one', () => {
  const twice = { model: SMALL, data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] };
  const noIndex = { model: SMALL, data: [{ embedding: [1, 0] }] };

  assert.throws(() => parseEmbeddings(twice, SMALL, 2), /out of order/);
  assert.throws(() => parseEmbeddings(noIndex, SMALL, 1), /out of order/);
});

test('one memory the model cannot embed does not hold back the others', async () => {
  const { fetchImpl } = lmStudio({ failOn: 'poison' });
  const store = createVectorStore({ file: tmpFile(), embedder: createEmbedder({ fetchImpl, log: quiet }) });

  const live = store.prepare([
    ['p/a', rec('alpha')],
    ['p/bad', rec('poison')],
    ['p/c', rec('gamma')],
  ]);
  await store.ready();

  assert.ok(live.get('p/a') && live.get('p/c'));
  assert.equal(live.get('p/bad'), undefined);
});

test('memories that appear while others are embedded are embedded too', async () => {
  const { fetchImpl } = lmStudio();
  const store = createVectorStore({ file: tmpFile(), embedder: createEmbedder({ fetchImpl, log: quiet }) });

  store.prepare([['p/a', rec('alpha')]]);
  const live = store.prepare([
    ['p/a', rec('alpha')],
    ['p/b', rec('beta')],
  ]);
  await store.ready();

  assert.equal(live.size, 2);
});

test('after a failed call, questions are answered from keywords without asking again', async () => {
  const studio = lmStudio();
  const store = createVectorStore({ file: tmpFile(), embedder: createEmbedder({ fetchImpl: studio.fetchImpl, now: () => 0, log: quiet }) });
  store.prepare([['p/a', rec('alpha')]]);
  await store.ready();
  studio.world.failOn = 'broken';

  assert.equal(await store.queryVector('broken question'), null);
  const callsAfterFailure = studio.calls.length;
  assert.equal(await store.queryVector('another question'), null);

  assert.equal(studio.calls.length, callsAfterFailure);
});

test('a repeated question costs one model call, and only a few are embedded at once', async () => {
  const { fetchImpl, calls } = lmStudio();
  const store = createVectorStore({ file: tmpFile(), embedder: createEmbedder({ fetchImpl, log: quiet }) });
  store.prepare([['p/a', rec('alpha')]]);
  await store.ready();
  const before = calls.length;

  await store.queryVector('same question');
  await store.queryVector('same question');
  assert.equal(calls.length, before + 1);

  const answers = await Promise.all(Array.from({ length: 10 }, (_v, i) => store.queryVector(`question ${i}`)));
  assert.equal(answers.filter(Boolean).length, 4);
});

test('a vector edited in the cache file is brought back to length 1 or dropped', () => {
  const file = tmpFile();
  const b64 = (values) => Buffer.from(Float32Array.from(values).buffer).toString('base64');
  fs.writeFileSync(file, JSON.stringify({ v: 1, model: SMALL, dim: 2, vectors: { 'p/huge': ['h1', b64([300, 400])], 'p/nan': ['h2', b64([NaN, 1])] } }));
  const store = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: lmStudio({ models: [] }).fetchImpl, log: quiet }) });

  assert.deepEqual(store.status(), { model: SMALL, count: 1 });
});

// ---- waking LM Studio, and the status the HUD shows -----------------------------

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a silent LM Studio is woken once, in the background, and found on the next look', async () => {
  const studio = lmStudio({ down: true });
  let at = 0;
  let wakes = 0;
  const wake = async () => {
    wakes++;
    studio.world.down = false;
    return { ok: true };
  };
  const embedder = createEmbedder({ fetchImpl: studio.fetchImpl, now: () => at, log: quiet, wake });

  assert.equal(await embedder.model(), null, 'the search that noticed does not wait for the wake');
  assert.deepEqual(embedder.state(), { model: null, reason: 'no-server' });
  await settle();

  assert.equal(await embedder.model(), SMALL);
  assert.equal(wakes, 1);
});

test('a wake that does not help is not repeated for ten minutes', async () => {
  const { fetchImpl } = lmStudio({ down: true });
  let at = 0;
  let wakes = 0;
  const wake = async () => {
    wakes++;
    return { ok: false, reason: 'not-found' };
  };
  const embedder = createEmbedder({ fetchImpl, now: () => at, log: quiet, wake });

  for (const minute of [0, 1, 5, 9]) {
    at = minute * 60000;
    await embedder.model();
    await settle();
  }
  assert.equal(wakes, 1);

  at = 11 * 60000;
  await embedder.model();
  assert.equal(wakes, 2);
});

test('LM Studio is not woken when it answers but has no embedding model', async () => {
  let wakes = 0;
  const embedder = createEmbedder({ fetchImpl: lmStudio({ models: [] }).fetchImpl, log: quiet, wake: async () => wakes++ });

  await embedder.model();

  assert.equal(wakes, 0);
  assert.deepEqual(embedder.state(), { model: null, reason: 'no-model' });
});

test('the store says which search is in use, and tells when that changes', async () => {
  const studio = lmStudio({ models: [] });
  let at = 0;
  let changes = 0;
  const store = createVectorStore({
    file: tmpFile(),
    embedder: createEmbedder({ fetchImpl: studio.fetchImpl, now: () => at, log: quiet }),
    onChange: () => changes++,
  });
  const records = [['p/a', rec('alpha')]];

  assert.deepEqual(store.mode(), { mode: 'keywords', reason: 'checking' });
  store.prepare(records);
  await store.ready();
  assert.deepEqual(store.mode(), { mode: 'keywords', reason: 'no-model' });

  studio.world.models = [row(SMALL)];
  at += 60000;
  store.prepare(records);
  await store.ready();
  assert.deepEqual(store.mode(), { mode: 'meaning', model: SMALL, embedded: 1, total: 1 });

  store.prepare(records);
  await store.ready();
  assert.equal(changes, 2, 'an unchanged state is not announced again');
});

test('a broken cache file is an empty cache', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ v: 1, model: SMALL, dim: 3, vectors: { 'p/a': ['hash', 'AAAA'], 'p/b': 'nope' } }));
  const { fetchImpl } = lmStudio();

  const store = createVectorStore({ file, embedder: createEmbedder({ fetchImpl, log: quiet }) });

  assert.deepEqual(store.status(), { model: SMALL, count: 0 });
});
