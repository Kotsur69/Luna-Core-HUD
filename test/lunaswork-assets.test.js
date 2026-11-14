// ============================================================================
// Luna's Work asset pipeline (LW 3.37): design/ASSETS.md is deduped by name
// and spec hash so the same asset is never generated twice, a batch over the
// limit goes to the decision queue with the capped default, and the Critic's
// style check turns an off-style asset into a `feel` card with its render and
// the art reference attached. The builder that generates, the decision queue
// and the Critic model are fakes; the repo is a temp dir, the to-do store is
// in memory.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../src/lunasworkAssets.js');
const Pack = require('../src/lunasworkPack.js');
const Decisions = require('../src/lunasworkDecisions.js');
const { scopeCheck } = require('../src/lunasworkRules.js');

const RUN_ID = 'game1';
const RUN_TAG = 'run:game1';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NOW = 1_800_000_000_000;

const HEADER = '| Name | Type | Spec | Source | File | Status | Hash | Ref |\n|---|---|---|---|---|---|---|---|';

/** A temp game repo with a scaffolded pack and the given ASSETS.md rows. */
function fakeRepo(rows, { limit = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-assets-'));
  assert.equal(Pack.scaffoldPack(dir, { game: true }).ok, true);
  const lines = ['# Assets', '', ...(limit ? [`Batch limit: ${limit}`, ''] : []), HEADER, ...rows, '', '## Notes', '', 'keep me', ''];
  fs.writeFileSync(path.join(dir, 'design', 'ASSETS.md'), lines.join('\n'));
  return dir;
}

const readList = (dir) => A.parseAssetList(fs.readFileSync(path.join(dir, 'design', 'ASSETS.md'), 'utf8'));
const rowOf = (dir, name) => readList(dir).rows.find((r) => r.name === name);

/** In-memory to-do store with the intake store shape; card ids count up. */
function memStore(initial = []) {
  let clock = 1_000_000;
  const store = { list: initial, writes: 0, now: () => (clock += 100) };
  store.read = () => store.list;
  store.write = (list) => {
    store.list = list;
    store.writes += 1;
    return true;
  };
  return store;
}

const assetCards = (store) => store.list.filter((c) => c.tags.includes(A.ASSET_TAG));

function baseRun(dir, extra = {}) {
  return { id: RUN_ID, projectId: 'p1', repoPath: dir, iteration: 1, decisions: [], models: {}, profile: { adapter: 'unity' }, ...extra };
}

/** The controller seam with a fake decision queue that records every ask. */
function makeStep(store, extra = {}) {
  const asked = [];
  const events = [];
  const step = A.createAssetStep({
    todoStore: () => store,
    ask: (spec) => {
      asked.push(spec);
      const res = Decisions.createDecision(spec, { now: NOW + asked.length, list: [] });
      return res.ok ? { ok: true, id: res.decision.id, decision: res.decision } : { ok: false, reason: res.error };
    },
    logEvent: (t) => events.push(t),
    ...extra,
  });
  return { step, asked, events };
}

/**
 * Fake builder with a fake generator behind it: for every open asset card it
 * reads the hash from the card, "generates" (counted per hash), saves a
 * render, marks the ASSETS.md row done and closes the card - what a God Mode
 * builder told by the card would do.
 */
function fakeBuilder(dir, store) {
  const generated = new Map();
  function work() {
    for (const card of assetCards(store).filter((c) => !c.done)) {
      const hash = card.details.match(/hash ([0-9a-f]{12})/)[1];
      generated.set(hash, (generated.get(hash) || 0) + 1);
      const parsed = readList(dir);
      const mine = parsed.rows.find((r) => r.hash === hash && r.status === 'queued');
      const rows = parsed.rows.map((r) => (r === mine ? { ...r, status: 'done', file: `Assets/Art/${r.name}.fbx` } : r));
      const slug = mine.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      fs.mkdirSync(path.join(dir, 'design', 'asset-renders'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'design', 'asset-renders', `${slug}.png`), PNG);
      fs.writeFileSync(path.join(dir, 'design', 'ASSETS.md'), A.formatAssetList(parsed, rows));
      store.list = store.list.map((c) => (c.at === card.at ? { ...c, done: true } : c));
    }
  }
  return { generated, work };
}

// ---- ASSETS.md + the pack -------------------------------------------------------------

test('ASSETS.md is a game-only pack file: scaffolded for a game, readable and writable', () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-assets-web-'));
  assert.ok(!Pack.scaffoldPack(web).created.includes('ASSETS.md'));
  assert.ok(!Pack.PACK_FILES.includes('ASSETS.md'));
  const game = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-assets-game-'));
  assert.ok(Pack.scaffoldPack(game, { game: true }).created.includes('ASSETS.md'));
  assert.equal(Pack.readPackFile(game, 'ASSETS.md'), Pack.GAME_TEMPLATES['ASSETS.md']);
  assert.equal(Pack.applyWrite(game, { file: 'ASSETS.md', update: (c) => `${c}x\n` }).ok, true);
  const parsed = A.parseAssetList(Pack.readPackFile(game, 'ASSETS.md'));
  assert.equal(parsed.limit, A.DEFAULT_BATCH_LIMIT);
  assert.ok(parsed.table);
});

test('parse + format keep the text around the table and fill in the hash', () => {
  const dir = fakeRepo(['| Hero Ship | model | low-poly teal fighter | Blender |  |  |  |  |']);
  const parsed = readList(dir);
  const [row] = parsed.rows;
  assert.equal(row.source, 'blender');
  assert.equal(row.status, 'planned');
  assert.equal(row.hash, A.specHash('model', 'low-poly teal fighter'));
  const out = A.formatAssetList(parsed, parsed.rows);
  assert.match(out, /## Notes\n\nkeep me/);
  assert.match(out, new RegExp(`\\| Hero Ship \\| model \\| low-poly teal fighter \\| blender \\|  \\| planned \\| ${row.hash} \\|  \\|`));
  assert.deepEqual(A.parseAssetList(out).rows, parsed.rows);
});

test('a changed spec puts an asset that was already made back to planned', () => {
  const old = A.specHash('model', 'red crate');
  const [row] = A.parseAssetList(`${HEADER}\n| Crate | model | blue crate | generated | a.fbx | done | ${old} | card 5 |`).rows;
  assert.equal(row.status, 'planned');
  assert.equal(row.ref, null);
});

// ---- dedupe ---------------------------------------------------------------------------

test('dedupe: a second row with the same name or the same spec is a duplicate', () => {
  const rows = A.parseAssetList([
    HEADER,
    '| Hero Ship | model | low-poly teal fighter | generated |  |  |  |  |',
    '| hero ship | model | another spec | generated |  |  |  |  |',
    '| Enemy Ship | model | Low-poly  teal fighter | blender |  |  |  |  |',
    '| Crate | texture | wooden crate | library |  |  |  |  |',
  ].join('\n')).rows;
  assert.deepEqual(A.dedupeAssets(rows).map((r) => r.status), ['planned', 'duplicate', 'duplicate', 'planned']);
});

test('the same asset is never generated twice across iterations, restarts and duplicate rows', async () => {
  const dir = fakeRepo([
    '| Hero Ship | model | low-poly teal fighter | generated |  |  |  |  |',
    '| HERO SHIP | model | low-poly teal fighter | generated |  |  |  |  |',
    '| Enemy Ship | model | low-poly teal fighter | blender |  |  |  |  |',
    '| Crate | texture | wooden crate | library |  |  |  |  |',
  ]);
  const store = memStore();
  const builder = fakeBuilder(dir, store);
  const { step } = makeStep(store);

  await step.beforeDirecting(baseRun(dir));
  assert.equal(assetCards(store).length, 2);
  assert.equal(rowOf(dir, 'Hero Ship').status, 'queued');
  assert.equal(rowOf(dir, 'HERO SHIP').status, 'duplicate');
  assert.equal(rowOf(dir, 'Enemy Ship').status, 'duplicate');

  // A restart before the builder ran: the open cards are not filed again.
  await makeStep(store).step.beforeDirecting(baseRun(dir));
  assert.equal(assetCards(store).length, 2);

  for (let i = 0; i < 3; i += 1) {
    builder.work();
    await step.beforeDirecting(baseRun(dir, { iteration: 2 + i }));
  }
  assert.equal(assetCards(store).length, 2);
  assert.deepEqual([...builder.generated.values()], [1, 1]);
  assert.equal(rowOf(dir, 'Crate').status, 'done');
});

test('an open card from a lost ASSETS.md write is adopted, not filed twice', async () => {
  const dir = fakeRepo(['| Crate | texture | wooden crate | library |  |  |  |  |']);
  const store = memStore();
  const [row] = readList(dir).rows;
  const card = A.assetCard(row);
  store.list = [{ at: 77, text: card.text, done: false, tags: [RUN_TAG, 'kind:missing', 'sev:medium', 'asset'] }];
  await makeStep(store).step.beforeDirecting(baseRun(dir));
  assert.equal(store.list.length, 1);
  assert.deepEqual(rowOf(dir, 'Crate').ref, { kind: 'card', id: 77 });
});

// ---- asset cards ----------------------------------------------------------------------

test('an asset card goes to the scene worker, names its source and stays in scope', async () => {
  const dir = fakeRepo(['| Hero Ship | model | low-poly teal fighter | blender |  |  |  |  |']);
  const store = memStore();
  await makeStep(store).step.beforeDirecting(baseRun(dir));
  const [card] = assetCards(store);
  assert.equal(card.text, 'Asset: Hero Ship (model)');
  assert.ok(card.tags.includes(RUN_TAG) && card.tags.includes('kind:missing'));
  // A Unity run: the asset pipeline's folders, tools and rules.
  assert.ok(card.files.includes('Assets/BladeBullet/Art/Models/hero-ship.prefab'));
  assert.match(card.details, /Blender MCP/);
  assert.match(card.details, /blender-game-assets skill/);
  assert.match(card.details, /luna_asset_blender/);
  assert.match(card.details, /art\/blender\/hero-ship\.blend/);
  assert.match(card.details, /3D toon \/ cel-shaded characters and props on a 2D plane/);
  assert.match(card.details, /AMD GPU/);
  assert.match(card.details, /ONLY through luna_asset_higgsfield/);
  assert.match(card.details, /design\/asset-renders\/hero-ship\.png/);
  assert.equal(require('../src/lunasworkScene.js').isSceneCard(card), true);
  assert.equal(scopeCheck(card, 'a puzzle game about gardens').inScope, true);
});

test('a generated 2D asset card names ComfyUI for drafts and Higgsfield for finals; a non-Unity card keeps the old folder', () => {
  const [row] = A.parseAssetList(`${HEADER}\n| Slash FX | vfx | red arc | generated |  |  |  |  |`).rows;
  const card = A.assetCard(row, { unity: true, artRoot: 'Assets/Game/Art' });
  assert.ok(card.files.includes('Assets/Game/Art/VFX/slash-fx.prefab'));
  assert.match(card.details, /luna_asset_comfy/);
  assert.match(card.details, /art\/comfyui\/runs\//);
  assert.match(card.details, /luna_asset_higgsfield/);
  assert.match(card.details, /higgsfield-media skill/);
  const plain = A.assetCard(row);
  assert.ok(plain.files.includes('Assets/Art/slash-fx/slash-fx.prefab'));
  assert.doesNotMatch(plain.details, /luna_asset_/);
});

// ---- cost gate ------------------------------------------------------------------------

const manyRows = (n) => Array.from({ length: n }, (_, i) => `| Tree ${i + 1} | model | tree variant ${i + 1} | generated |  |  |  |  |`);

test('a batch over the limit goes to the decision queue; the capped default goes on', async () => {
  const dir = fakeRepo(manyRows(8), { limit: 3 });
  const store = memStore();
  const { step, asked } = makeStep(store);

  await step.beforeDirecting(baseRun(dir));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].defaultAnswer, A.CAPPED);
  assert.deepEqual(asked[0].options, [A.CAPPED, A.ALL]);
  assert.match(asked[0].question, /5 more game asset/);
  assert.equal(assetCards(store).length, 3);
  const created = Decisions.createDecision(asked[0], { now: NOW + 1, list: [] });
  assert.equal(created.ok, true);
  const held = readList(dir).rows.filter((r) => r.status === 'held');
  assert.equal(held.length, 5);
  assert.ok(held.every((r) => r.ref.kind === 'decision' && r.ref.id === created.decision.id));

  // Pending: nothing more is generated and the question is not asked again.
  const decisions = [created.decision];
  await step.beforeDirecting(baseRun(dir, { decisions }));
  assert.equal(asked.length, 1);
  assert.equal(assetCards(store).length, 3);

  // The deadline takes the default (capped): the rest comes in capped batches, never asked again.
  const { list: answered } = Decisions.expireDue(decisions, created.decision.deadline);
  assert.equal(answered[0].answer, A.CAPPED);
  assert.equal(answered[0].answeredBy, 'default');
  await step.beforeDirecting(baseRun(dir, { decisions: answered }));
  assert.equal(assetCards(store).length, 6);
  assert.equal(readList(dir).rows.filter((r) => r.status === 'deferred').length, 2);
  await step.beforeDirecting(baseRun(dir, { decisions: answered }));
  assert.equal(assetCards(store).length, 8);
  assert.equal(asked.length, 1);
});

test('an `all` answer cards every held asset at once, past the limit', async () => {
  const dir = fakeRepo(manyRows(30), { limit: 2 });
  const store = memStore();
  const { step, asked } = makeStep(store);
  await step.beforeDirecting(baseRun(dir));
  const { decision } = Decisions.createDecision(asked[0], { now: NOW + 1, list: [] });
  const res = Decisions.answerDecision([decision], { id: decision.id, answer: A.ALL }, { by: 'mati', now: NOW + 5 });
  assert.equal(res.ok, true);
  await step.beforeDirecting(baseRun(dir, { decisions: res.list }));
  assert.equal(assetCards(store).length, 30);
  assert.ok(readList(dir).rows.every((r) => r.status === 'queued'));
});

test('a batch within the limit asks nothing', async () => {
  const dir = fakeRepo(manyRows(3), { limit: 3 });
  const store = memStore();
  const { step, asked } = makeStep(store);
  await step.beforeDirecting(baseRun(dir));
  assert.equal(asked.length, 0);
  assert.equal(assetCards(store).length, 3);
});

// ---- style check ----------------------------------------------------------------------

/** Fake Critic model: records the call, answers with these scores. */
function fakeCritic(scores) {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    return { stdout: JSON.stringify({ structured_output: { scores }, total_cost_usd: 0.1 }) };
  };
  return { calls, run };
}

/** A repo with an art reference and two finished assets, each with a render. */
function styledRepo() {
  const dir = fakeRepo([
    '| Hero Ship | model | low-poly teal fighter | generated | Assets/Art/hero.fbx | done |  | card 5 |',
    '| Crate | texture | wooden crate | library | Assets/Art/crate.png | done |  | card 6 |',
  ]);
  fs.mkdirSync(path.join(dir, 'design', 'references', 'neon-drift'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'design', 'references', 'neon-drift', 'hud.png'), PNG);
  // Not an image: never offered as a reference.
  fs.writeFileSync(path.join(dir, 'design', 'references', 'neon-drift', 'fake.png'), 'text');
  fs.mkdirSync(path.join(dir, 'design', 'asset-renders'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'design', 'asset-renders', 'hero-ship.png'), PNG);
  fs.writeFileSync(path.join(dir, 'design', 'asset-renders', 'crate.png'), PNG);
  return dir;
}

test('style mismatch: a low score files a feel card with both images attached', async () => {
  const dir = styledRepo();
  const store = memStore();
  const ref = 'design/references/neon-drift/hud.png';
  const critic = fakeCritic([
    { name: 'Hero Ship', score: 3, reference: ref, notes: 'Too saturated; the references use flat neon on dark.' },
    { name: 'Crate', score: 9, reference: ref, notes: 'Fits.' },
  ]);
  const { step } = makeStep(store, { styleCheck: (opts) => A.runStyleCheck({ ...opts, runClaude: critic.run }) });

  const res = await step.beforeDirecting(baseRun(dir));
  assert.equal(critic.calls.length, 1);
  const { args, prompt } = critic.calls[0];
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
  assert.match(prompt, /design\/references\/neon-drift\/hud\.png/);
  assert.match(prompt, /design\/asset-renders\/hero-ship\.png/);
  assert.doesNotMatch(prompt, /fake\.png/);

  const feel = assetCards(store);
  assert.equal(feel.length, 1);
  assert.ok(feel[0].tags.includes('kind:feel'));
  assert.match(feel[0].text, /Hero Ship \(3\/10/);
  assert.deepEqual(feel[0].files, ['design/asset-renders/hero-ship.png', ref]);
  assert.match(feel[0].details, /Asset render: design\/asset-renders\/hero-ship\.png/);
  assert.match(feel[0].details, /Art reference: design\/references\/neon-drift\/hud\.png/);

  assert.equal(rowOf(dir, 'Hero Ship').status, 'restyle');
  assert.deepEqual(rowOf(dir, 'Hero Ship').ref, { kind: 'card', id: feel[0].at });
  assert.equal(rowOf(dir, 'Crate').status, 'approved');
  assert.deepEqual({ restyle: res.restyle, approved: res.approved }, { restyle: 1, approved: 1 });

  // The redo lands (feel card closed): the asset is checked again, and passes now.
  store.list = store.list.map((c) => ({ ...c, done: true }));
  const again = fakeCritic([{ name: 'Hero Ship', score: 8, reference: ref, notes: 'Matches.' }]);
  await makeStep(store, { styleCheck: (opts) => A.runStyleCheck({ ...opts, runClaude: again.run }) }).step.beforeDirecting(baseRun(dir));
  assert.match(again.calls[0].prompt, /Hero Ship/);
  assert.doesNotMatch(again.calls[0].prompt, /"Crate"/);
  assert.equal(rowOf(dir, 'Hero Ship').status, 'approved');
  assert.equal(assetCards(store).length, 1);
});

test('a failed style check files nothing and leaves the rows to be checked again', async () => {
  const dir = styledRepo();
  const store = memStore();
  const { step, events } = makeStep(store, { styleCheck: (opts) => A.runStyleCheck({ ...opts, runClaude: async () => ({ stdout: 'not json' }) }) });
  await step.beforeDirecting(baseRun(dir));
  assert.equal(store.list.length, 0);
  assert.equal(rowOf(dir, 'Hero Ship').status, 'done');
  assert.ok(events.some((e) => /style check failed \(badJson\)/.test(e)));
});

test('validateStyle keeps only asked assets, clamps scores and pins the reference to the list', () => {
  const assets = [{ name: 'Crate' }];
  const out = A.validateStyle({
    scores: [
      { name: 'Crate', score: 14.6, reference: '../../etc/passwd', notes: 'x' },
      { name: 'Crate', score: 1, reference: 'r.png', notes: 'dup' },
      { name: 'Nope', score: 1, reference: 'r.png', notes: 'unknown' },
    ],
  }, assets, ['r.png']);
  assert.deepEqual(out, [{ name: 'Crate', score: 10, reference: 'r.png', notes: 'x' }]);
});

// ---- the step around the run ----------------------------------------------------------

test('a Unity run without ASSETS.md gets the template; a web run is left alone', async () => {
  const unity = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-assets-u-'));
  Pack.scaffoldPack(unity);
  const store = memStore();
  assert.equal(await makeStep(store).step.beforeDirecting(baseRun(unity)), null);
  assert.equal(Pack.readPackFile(unity, 'ASSETS.md'), Pack.GAME_TEMPLATES['ASSETS.md']);

  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-assets-w-'));
  Pack.scaffoldPack(web);
  assert.equal(await makeStep(store).step.beforeDirecting(baseRun(web, { profile: { adapter: 'web' } })), null);
  assert.equal(Pack.readPackFile(web, 'ASSETS.md'), null);
  assert.equal(store.writes, 0);
});

test('a throwing store is one log line, never a crash', async () => {
  const dir = fakeRepo(['| Crate | texture | wooden crate | library |  |  |  |  |']);
  const store = { read: () => { throw new Error('disk gone'); }, write: () => true };
  const { step, events } = makeStep(store);
  assert.equal(await step.beforeDirecting(baseRun(dir)), null);
  assert.ok(events.some((e) => /assets: failed \(disk gone\)/.test(e)));
});
