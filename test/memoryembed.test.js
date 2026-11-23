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

// ---- semantic dedup and the Rejected-Embedding Shield (src/memoryshield.js) ----

const { cosine, semanticDuplicate, vectorLookup, encodeVector, SEMANTIC_DUPLICATE } = require('../src/memoryembed.js');
const shield = require('../src/memoryshield.js');
const { memoryPaths } = require('../src/memorysync.js');

const SHIELD_PROJECT = 'github.com/acme/hud';
const memory = (id, title, body = `Body of ${id}.`) => ({ id, project: SHIELD_PROJECT, title, body });
const unit = (...xs) => Float32Array.from(xs.map((x) => x / Math.hypot(...xs)));

test('cosine compares two vectors and refuses what cannot be compared', () => {
  assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 0], [-1, 0]) + 1) < 1e-9);
  assert.equal(cosine([1, 0], [1, 0, 0]), null, 'vectors of two models (two lengths) never compare');
  assert.equal(cosine(undefined, [1]), null);
  assert.equal(cosine([], []), null);
  assert.equal(cosine([0, 0], [1, 0]), null, 'a zero vector has no direction');
});

test('two memories are near-duplicates by meaning from SEMANTIC_DUPLICATE on, and unknown without both vectors', () => {
  assert.equal(SEMANTIC_DUPLICATE, 0.82);
  const vectors = new Map([
    ['a', unit(1, 0, 0)],
    ['close', unit(1, 0.5, 0)], // cosine 0.894
    ['far', unit(1, 1, 0)], // cosine 0.707
  ]);
  const vectorOf = (r) => vectors.get(r.id);
  const a = memory('a', 'A');
  assert.equal(semanticDuplicate(a, memory('close', 'B'), vectorOf), true);
  assert.equal(semanticDuplicate(a, memory('far', 'C'), vectorOf), false);
  assert.equal(semanticDuplicate(a, memory('none', 'D'), vectorOf), null, 'one vector missing: the caller compares words');
  assert.equal(semanticDuplicate(a, memory('close', 'B'), null), null);
  assert.equal(vectorLookup(null), null);
});

test('the store answers a memory vector for its current text only, and embeds new texts with its own model', async () => {
  const file = tmpFile();
  const studio = lmStudio();
  const store = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: studio.fetchImpl, log: quiet }) });
  const a = memory('a', 'alpha');
  assert.equal(await store.embedTexts(['x']), null, 'no vectors yet: nothing to compare with, no model call');
  assert.equal(studio.calls.length, 0);

  store.prepare([['github.com/acme/hud/a', a]]);
  await store.ready();
  assert.equal(store.model(), SMALL);
  assert.equal(store.dir, path.dirname(file));
  assert.ok(store.vectorFor(a));
  assert.equal(store.vectorFor({ ...a, body: 'edited' }), undefined, 'a vector of an older text is not this memory any more');
  assert.equal(vectorLookup(store)(a), store.vectorFor(a));

  const res = await store.embedTexts(['one', 'two two']);
  assert.equal(res.model, SMALL);
  assert.equal(res.vectors.length, 2);

  studio.world.down = true;
  const offline = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: studio.fetchImpl, log: quiet }) });
  assert.ok(offline.vectorFor(a), 'cached vectors are read without LM Studio');
  assert.equal(await offline.embedTexts(['three']), null, 'LM Studio down: compare by words, no error');
});

const shieldFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-shield-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  return shield.rejectedVectorsPath(dir);
};

test('the rejected store keeps at most MAX_REJECTED_VECTORS entries and evicts the oldest', (t) => {
  const file = shieldFile(t);
  const extra = 3;
  // A full file written in one go (one atomic write per entry is slow on Windows), then a few more.
  const full = Array.from({ length: shield.MAX_REJECTED_VECTORS }, (_, i) => ({
    at: 1000 + i,
    project: SHIELD_PROJECT,
    title: `Rejected ${i}`,
    vec: encodeVector(unit(1, i + 1, 0)),
  }));
  fs.writeFileSync(file, JSON.stringify({ v: 1, model: SMALL, dim: 3, entries: full }));
  assert.equal(shield.readRejected(file).entries.length, shield.MAX_REJECTED_VECTORS);
  for (let i = shield.MAX_REJECTED_VECTORS; i < shield.MAX_REJECTED_VECTORS + extra; i++) {
    shield.addRejected(file, { model: SMALL, project: SHIELD_PROJECT, title: `Rejected ${i}`, vec: unit(1, i + 1, 0), at: 1000 + i });
  }
  const { model, entries } = shield.readRejected(file);
  assert.equal(model, SMALL);
  assert.equal(entries.length, shield.MAX_REJECTED_VECTORS);
  assert.equal(entries[0].title, `Rejected ${extra}`, 'the oldest went first');
  assert.equal(entries.at(-1).title, `Rejected ${shield.MAX_REJECTED_VECTORS + extra - 1}`);
});

test('the rejected store keeps one model, scrubs titles, and reads a broken file as empty', (t) => {
  const file = shieldFile(t);
  const secret = `${['DEPLOY', 'TOKEN'].join('_')}=${'q'.repeat(24)}`;
  shield.addRejected(file, { model: SMALL, project: SHIELD_PROJECT, title: `Set ${secret} first`, vec: unit(1, 0, 0), at: 1 });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('q'.repeat(24)), 'a secret in a title never reaches the file');
  assert.match(shield.readRejected(file).entries[0].title, /\[redacted\]/);

  shield.addRejected(file, { model: BIG, project: SHIELD_PROJECT, title: 'Other model', vec: unit(0, 1, 0, 0), at: 2 });
  assert.deepEqual(shield.readRejected(file).entries.map((e) => e.title), ['Other model'], 'vectors of two models never mix');

  assert.equal(shield.addRejected(file, { model: BIG, project: SHIELD_PROJECT, title: '', vec: unit(1, 0, 0, 0), at: 3 }), 0);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(shield.readRejected(file), { model: null, entries: [] });
});

test('the rejected store is local: its file is per PC and no sync path names it', () => {
  assert.match(shield.REJECTED_VECTORS_FILE, /\.local\.json$/);
  const configDir = path.join(os.tmpdir(), 'cfg');
  assert.ok(!Object.values(memoryPaths(configDir)).includes(shield.rejectedVectorsPath(configDir)));
  for (const rel of ['src/memorysync.js', 'src/configsync.js', 'src/docsync.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!/rejected-vectors|REJECTED_VECTORS_FILE|memoryshield/.test(source), `${rel} never syncs the shield`);
  }
});

test('a rejection is remembered with its cached vector, or embedded when it has none', async (t) => {
  const file = tmpFile();
  t.after(() => fs.promises.rm(path.dirname(file), { recursive: true, force: true, maxRetries: 5 }));
  const studio = lmStudio();
  const store = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: studio.fetchImpl, log: quiet }) });
  const cached = memory('cached', 'Cached memory');
  store.prepare([['github.com/acme/hud/cached', cached]]);
  await store.ready();
  const callsBefore = studio.calls.length;

  assert.equal(await shield.rememberRejected(store, cached, 10), true);
  assert.equal(studio.calls.length, callsBefore, 'a cached vector costs no model call');
  assert.equal(await shield.rememberRejected(store, memory('fresh', 'Fresh memory'), 20), true);
  assert.equal(studio.calls.length, callsBefore + 1);

  const { entries } = shield.readRejected(shield.rejectedVectorsPath(store.dir));
  assert.deepEqual(entries.map((e) => [e.title, e.project, e.at]), [
    ['Cached memory', SHIELD_PROJECT, 10],
    ['Fresh memory', SHIELD_PROJECT, 20],
  ]);
  assert.equal(await shield.rememberRejected(null, cached), false, 'no store: no shield, no error');
  studio.world.down = true;
  const offline = createVectorStore({ file, embedder: createEmbedder({ fetchImpl: studio.fetchImpl, log: quiet }) });
  assert.equal(await shield.rememberRejected(offline, memory('other', 'Other memory')), false);
});
