// ============================================================================
// Luna's Work asset casting (src/lunasworkAssetCasting.js): an ASSETS.md row
// whose Source is empty or "auto" is cast by the Director before its card is
// filed. The headless `claude` runner is a stub; the repo is a temp dir, the
// to-do store is in memory, the key store is a stub that holds a fake key.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../src/lunasworkAssets.js');
const C = require('../src/lunasworkAssetCasting.js');
const Pack = require('../src/lunasworkPack.js');
const Cost = require('../src/lunasworkAssetCost.js');
const { loadCatalog } = require('../src/lunasworkAssetCatalog.js');

const HEADER = '| Name | Type | Spec | Source | File | Status | Hash | Ref |\n|---|---|---|---|---|---|---|---|';
const CATALOG = loadCatalog();
// A fake library key, assembled at runtime so no key-shaped literal is in the source.
const FAKE_KEY = ['lunatest', 'k'.repeat(12), 'zq'].join('_');

async function rmDir(dir) {
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** A temp game repo with the given ASSETS.md rows, ComfyUI workflows and reference files. */
function fakeRepo(t, rows, { workflows = [], references = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-casting-'));
  t.after(() => rmDir(dir));
  assert.equal(Pack.scaffoldPack(dir, { game: true }).ok, true);
  fs.writeFileSync(path.join(dir, 'design', 'ASSETS.md'), ['# Assets', '', HEADER, ...rows, ''].join('\n'));
  if (workflows.length) fs.mkdirSync(path.join(dir, 'art', 'comfyui'), { recursive: true });
  for (const w of workflows) fs.writeFileSync(path.join(dir, 'art', 'comfyui', w), '{}');
  if (references.length) fs.mkdirSync(path.join(dir, 'design', 'references'), { recursive: true });
  for (const r of references) fs.writeFileSync(path.join(dir, 'design', 'references', r), 'x');
  return dir;
}

const readList = (dir) => A.parseAssetList(fs.readFileSync(path.join(dir, 'design', 'ASSETS.md'), 'utf8'));

function memStore() {
  let clock = 1_000_000;
  const store = { list: [], now: () => (clock += 100) };
  store.read = () => store.list;
  store.write = (list) => {
    store.list = list;
    return true;
  };
  return store;
}

const assetCards = (store) => store.list.filter((c) => c.tags.includes(A.ASSET_TAG));
const baseRun = (dir, extra = {}) => ({ id: 'game1', projectId: 'p1', repoPath: dir, iteration: 1, decisions: [], models: {}, profile: { adapter: 'unity' }, spendCaps: { higgsfield: 20 }, spend: {}, ...extra });

/** The stubbed key store: one key stored, and a status that (wrongly) leaks the key value for another. */
const keyStore = {
  get: () => FAKE_KEY,
  secrets: () => [FAKE_KEY],
  status: () => ({ ok: true, keys: { sketchfab: true, polypizza: FAKE_KEY, freesound: false }, persisted: true }),
};

/** A runner stub answering with `casts` (or a custom reply); every call is recorded. */
function stubRunner(reply) {
  const calls = [];
  const runner = async (call) => {
    calls.push(call);
    if (typeof reply === 'function') return reply(call);
    return { stdout: JSON.stringify({ structured_output: { casts: reply }, total_cost_usd: 0.01 }) };
  };
  return { runner, calls };
}

/** The asset step with casting through runCasting and a stubbed `claude`. */
function makeStep(store, runner) {
  const events = [];
  const models = [];
  const step = A.createAssetStep({
    todoStore: () => store,
    ask: () => ({ ok: false, reason: 'test' }),
    casting: (opts) => C.runCasting({ ...opts, keyStatus: keyStore.status, runClaude: runner }),
    logEvent: (text) => events.push(text),
    logModel: (role, model, reason) => models.push({ role, model, reason }),
  });
  return { step, events, models };
}

const ctxFor = (rows, extra = {}) => ({ rows, catalog: CATALOG, keys: C.keyFlags(keyStore.status), workflows: ['draft.json'], ...extra });

// ---- ASSETS.md ------------------------------------------------------------------------------

test('an empty Source reads as auto; explicit sources and auto keep their value', () => {
  const { rows } = A.parseAssetList([HEADER,
    '| Crate | model | wooden crate |  |  |  |  |  |',
    '| Boss | sprite | big boss | AUTO |  |  |  |  |',
    '| Ship | model | teal ship | blender |  |  |  |  |',
    '| Grass | texture | grass | library |  |  |  |  |',
    '| Logo | ui | logo | generated |  |  |  |  |',
  ].join('\n'));
  assert.deepEqual(rows.map((r) => r.source), ['auto', 'auto', 'blender', 'library', 'generated']);
  assert.ok(A.SOURCES.includes('auto'));
  assert.match(Pack.GAME_TEMPLATES['ASSETS.md'], /auto \(or empty\): the Director picks the source/);
});

// ---- the step: an auto row gets a plan ------------------------------------------------------

test('an auto row is cast: its card names the source, the workflow, the fallback ladder and the reason', async (t) => {
  const dir = fakeRepo(t, ['| Grass Tile | texture | toon grass |  |  |  |  |  |'], { workflows: ['draft.json'], references: ['look.png'] });
  const store = memStore();
  const { runner, calls } = stubRunner([{
    name: 'Grass Tile',
    primary: { source: 'comfyui', comfyWorkflow: 'draft.json' },
    // Given out of order: the ladder is put cheapest first.
    fallbacks: [{ source: 'higgsfield', higgsfieldModel: 'gpt_image_2_6' }, { source: 'library', librarySources: ['polyhaven'] }],
    candidates: 3,
    reason: 'a flat toon grass tile is a quick local draft',
  }]);
  const { step, events, models } = makeStep(store, runner);
  const res = await step.beforeDirecting(baseRun(dir));
  assert.equal(res.queued, 1);
  assert.equal(calls.length, 1);
  const [card] = assetCards(store);
  assert.match(card.details, /Casting: the Director picked the source/);
  assert.match(card.details, /Primary: local ComfyUI with the workflow art\/comfyui\/draft\.json/);
  assert.match(card.details, /Fallback ladder, cheapest first[^\n]*1\. free library polyhaven[^\n]*2\. paid Higgsfield with the model gpt_image_2_6/);
  assert.match(card.details, /Make 3 candidate\(s\)/);
  assert.match(card.details, /Why this source: a flat toon grass tile is a quick local draft/);
  assert.match(card.details, /Source: generated/, 'a ComfyUI cast is a generated asset for the card');
  // Every pick and its reason is in the run log; the Director's model is logged.
  assert.ok(events.some((e) => /cast "Grass Tile": comfyui draft\.json, fallbacks library polyhaven > higgsfield gpt_image_2_6, 3 candidate\(s\) - a flat toon grass/.test(e)), events.join('\n'));
  assert.equal(models[0].role, 'director');
  assert.match(models[0].reason, /asset casting/);
  // ASSETS.md keeps "auto": the cast is per pass.
  const row = readList(dir).rows[0];
  assert.equal(row.source, 'auto');
  assert.equal(row.status, 'queued');
});

test('the casting call is an argv array with no tools, and the prompt carries every input', async (t) => {
  const dir = fakeRepo(t, ['| Crate | model | wooden crate | auto |  |  |  |  |'], { workflows: ['draft.json', 'mesh.json'], references: ['katana.png'] });
  const { runner, calls } = stubRunner([]);
  await C.runCasting({ repoDir: dir, rows: [{ name: 'Crate', type: 'model', spec: 'wooden crate' }], model: 'sonnet', remainingUsd: 7.5, keyStatus: keyStore.status, runClaude: runner });
  const [{ args, prompt }] = calls;
  assert.ok(Array.isArray(args) && args.every((a) => typeof a === 'string'));
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), C.CASTING_SCHEMA);
  assert.match(prompt, /"Crate" \(model\): wooden crate/);
  assert.match(prompt, /3D toon \/ cel-shaded/);
  assert.match(prompt, /- katana\.png/);
  assert.match(prompt, /draft\.json, mesh\.json/);
  assert.match(prompt, /Remaining Higgsfield budget of this run: \$7\.50/);
  assert.match(prompt, /- polyhaven \[free library, no key needed\]/);
  assert.match(prompt, /- sketchfab \[free library, needs a key, key stored: yes\]/);
  assert.match(prompt, /- higgsfield \[paid\][^\n]*gpt_image_2_6/);
});

// ---- the trust boundary ---------------------------------------------------------------------

test('validateCasting rejects an unknown source', () => {
  const { plans, rejected } = C.validateCasting({ casts: [{ name: 'Crate', primary: { source: 'midjourney' }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctxFor([{ name: 'Crate', type: 'model' }]));
  assert.equal(plans.size, 0);
  assert.match(rejected[0].why, /unknown source/);
  // A real source that does not serve the kind is rejected too.
  const audio = C.validateCasting({ casts: [{ name: 'Theme', primary: { source: 'blender' }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctxFor([{ name: 'Theme', type: 'audio' }]));
  assert.match(audio.rejected[0].why, /blender is not in the catalog for audio/);
});

test('validateCasting rejects a keyed library whose key is not stored', () => {
  const rows = [{ name: 'Crate', type: 'model' }];
  // polypizza's status value is the key string, not `true`: it counts as not stored.
  for (const lib of ['polypizza', 'smithsonian']) {
    const { plans, rejected } = C.validateCasting({ casts: [{ name: 'Crate', primary: { source: 'library', librarySources: [lib] }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctxFor(rows));
    assert.equal(plans.size, 0, lib);
    assert.match(rejected[0].why, new RegExp(`library ${lib} needs a key that is not stored`));
  }
  const ok = C.validateCasting({ casts: [{ name: 'Crate', primary: { source: 'library', librarySources: ['sketchfab', 'polyhaven'] }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctxFor(rows));
  assert.deepEqual(ok.plans.get('Crate').primary, { source: 'library', librarySources: ['sketchfab', 'polyhaven'] });
});

test('validateCasting rejects a workflow that is not a file in art/comfyui/, traversal included', () => {
  const rows = [{ name: 'Logo', type: 'ui' }];
  for (const wf of ['missing.json', '../secrets.json', 'art/comfyui/../x.json', 'sub/draft.json', '']) {
    const { plans, rejected } = C.validateCasting({ casts: [{ name: 'Logo', primary: { source: 'comfyui', comfyWorkflow: wf }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctxFor(rows));
    assert.equal(plans.size, 0, wf);
    assert.match(rejected[0].why, /is not a file in art\/comfyui\//);
  }
  const ok = C.validateCasting({ casts: [{ name: 'Logo', primary: { source: 'comfyui', comfyWorkflow: 'art/comfyui/draft.json' }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctxFor(rows));
  assert.deepEqual(ok.plans.get('Logo').primary, { source: 'comfyui', comfyWorkflow: 'draft.json' });
});

test('listComfyWorkflows lists only plain .json files directly in art/comfyui/', async (t) => {
  const dir = fakeRepo(t, [], { workflows: ['draft.json', 'notes.txt', 'bad name.json'] });
  fs.mkdirSync(path.join(dir, 'art', 'comfyui', 'runs'));
  fs.writeFileSync(path.join(dir, 'art', 'comfyui', 'runs', 'old.json'), '{}');
  assert.deepEqual(C.listComfyWorkflows(dir), ['draft.json']);
});

test('validateCasting rejects an unknown Higgsfield model, and one that does not make the kind', () => {
  const ctx = ctxFor([{ name: 'Logo', type: 'ui' }], { workflows: [] });
  const unknown = C.validateCasting({ casts: [{ name: 'Logo', primary: { source: 'higgsfield', higgsfieldModel: 'dall-e-9' }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctx);
  assert.equal(unknown.plans.size, 0);
  assert.match(unknown.rejected[0].why, /unknown Higgsfield model "dall-e-9"/);
  const wrongKind = C.validateCasting({ casts: [{ name: 'Logo', primary: { source: 'higgsfield', higgsfieldModel: 'image-to-3d' }, fallbacks: [], candidates: 1, reason: 'x' }] }, ctx);
  assert.match(wrongKind.rejected[0].why, /does not make ui/);
});

test('higgsfield as the primary is rejected while a free or local rung exists, unless the reason says why', () => {
  const rows = [{ name: 'Crate', type: 'model' }];
  const cast = (reason) => ({ casts: [{ name: 'Crate', primary: { source: 'higgsfield', higgsfieldModel: 'image-to-3d' }, fallbacks: [], candidates: 1, reason }] });
  const bare = C.validateCasting(cast(''), ctxFor(rows));
  assert.equal(bare.plans.size, 0);
  assert.match(bare.rejected[0].why, /paid Higgsfield primary while a free or local option exists/);
  assert.equal(C.validateCasting(cast('looks great'), ctxFor(rows)).plans.size, 0, 'a reason that does not name the cheaper option');
  const why = C.validateCasting(cast('the free library crates are photoreal and Blender would take too long for this hero prop'), ctxFor(rows));
  assert.equal(why.plans.get('Crate').primary.higgsfieldModel, 'image-to-3d');
  // A kind with no free or local rung here (no workflow for ComfyUI, no library serves ui): higgsfield is fine.
  const ui = C.validateCasting({ casts: [{ name: 'Logo', primary: { source: 'higgsfield', higgsfieldModel: 'gpt_image_2_6' }, fallbacks: [], candidates: 1, reason: '' }] }, ctxFor([{ name: 'Logo', type: 'ui' }], { workflows: [] }));
  assert.equal(ui.plans.get('Logo').costClass, 'paid');
});

test('validateCasting drops invalid fallback rungs, orders the ladder cheapest first and clamps candidates', () => {
  const rows = [{ name: 'Crate', type: 'model' }, { name: 'Barrel', type: 'model' }, { name: 'Box', type: 'model' }];
  const { plans } = C.validateCasting({
    casts: [
      {
        name: 'Crate',
        primary: { source: 'blender' },
        fallbacks: [
          { source: 'higgsfield', higgsfieldModel: 'image-to-3d' },
          { source: 'higgsfield', higgsfieldModel: 'nope' },
          { source: 'library', librarySources: ['smithsonian'] },
          { source: 'blender' },
          { source: 'library', librarySources: ['polyhaven'] },
          'junk',
        ],
        candidates: 9,
        reason: 'built to the art direction',
      },
      { name: 'Barrel', primary: { source: 'blender' }, fallbacks: [], candidates: 0, reason: 'x' },
      { name: 'Box', primary: { source: 'blender' }, fallbacks: [], candidates: 2.6, reason: 'x' },
      { name: 'Stranger', primary: { source: 'blender' }, fallbacks: [], candidates: 1, reason: 'x' },
    ],
  }, ctxFor(rows));
  assert.deepEqual(plans.get('Crate').fallbacks, [{ source: 'library', librarySources: ['polyhaven'] }, { source: 'higgsfield', higgsfieldModel: 'image-to-3d' }]);
  assert.equal(plans.get('Crate').candidates, 4);
  assert.equal(plans.get('Barrel').candidates, 1);
  assert.equal(plans.get('Box').candidates, 3);
  assert.equal(plans.has('Stranger'), false);
});

// ---- failures never block the run -----------------------------------------------------------

for (const [label, reply] of [
  ['a timed-out call', () => ({ error: 'timeout' })],
  ['a throwing runner', () => { throw new Error('spawn exploded'); }],
  ['malformed JSON', () => ({ stdout: 'not json at all' })],
  ['an answer without casts', () => ({ stdout: JSON.stringify({ structured_output: { nope: true } }) })],
  ['an invalid primary', () => ({ stdout: JSON.stringify({ structured_output: { casts: [{ name: 'Crate', primary: { source: 'midjourney' }, fallbacks: [], candidates: 1, reason: 'x' }] } }) })],
]) {
  test(`${label} falls back to "generated" with one log line and the run goes on`, async (t) => {
    const dir = fakeRepo(t, ['| Crate | model | wooden crate | auto |  |  |  |  |']);
    const store = memStore();
    const { runner } = stubRunner(reply);
    const { step, events } = makeStep(store, runner);
    const res = await step.beforeDirecting(baseRun(dir));
    assert.equal(res.queued, 1);
    const [card] = assetCards(store);
    assert.match(card.details, /Source: generated/);
    assert.doesNotMatch(card.details, /Casting:/);
    const lines = events.filter((e) => /cast/i.test(e));
    assert.equal(lines.length, 1, events.join('\n'));
    assert.match(lines[0], /uses? generated/);
    assert.equal(readList(dir).rows[0].source, 'auto');
  });
}

test('without a casting runner an auto row behaves like generated', async (t) => {
  const dir = fakeRepo(t, ['| Crate | model | wooden crate |  |  |  |  |  |']);
  const store = memStore();
  const events = [];
  const step = A.createAssetStep({ todoStore: () => store, ask: () => ({ ok: false }), logEvent: (e) => events.push(e) });
  assert.equal((await step.beforeDirecting(baseRun(dir))).queued, 1);
  assert.match(assetCards(store)[0].details, /Source: generated/);
  assert.ok(events.some((e) => /casting is not available - 1 auto asset\(s\) use generated/.test(e)));
});

// ---- secrets --------------------------------------------------------------------------------

test('a library key value never appears in the prompt, the card or the log', async (t) => {
  const dir = fakeRepo(t, ['| Crate | model | wooden crate | auto |  |  |  |  |'], { workflows: ['draft.json'] });
  const store = memStore();
  const { runner, calls } = stubRunner([{ name: 'Crate', primary: { source: 'library', librarySources: ['sketchfab'] }, fallbacks: [{ source: 'blender' }], candidates: 2, reason: 'stylized crates exist on sketchfab' }]);
  const { step, events, models } = makeStep(store, runner);
  await step.beforeDirecting(baseRun(dir));
  const [card] = assetCards(store);
  assert.match(card.details, /free library sketchfab/);
  const everything = [calls[0].prompt, ...calls[0].args, JSON.stringify(card), ...events, JSON.stringify(models), fs.readFileSync(path.join(dir, 'design', 'ASSETS.md'), 'utf8')].join('\n');
  assert.ok(!everything.includes(FAKE_KEY));
  assert.match(calls[0].prompt, /polypizza \[free library, needs a key, key stored: no\]/);
  assert.deepEqual(C.keyFlags(() => { throw new Error(FAKE_KEY); }).sketchfab, false);
});

// ---- explicit sources and the cost gate -----------------------------------------------------

test('rows with an explicit source are never cast and their card is unchanged', async (t) => {
  const rows = ['| Hero Ship | model | low-poly teal fighter | blender |  |  |  |  |', '| Grass | texture | grass | library |  |  |  |  |', '| Logo | ui | logo | generated |  |  |  |  |'];
  const dirA = fakeRepo(t, rows);
  const dirB = fakeRepo(t, rows);
  const withCasting = memStore();
  const without = memStore();
  const { runner, calls } = stubRunner([]);
  await makeStep(withCasting, runner).step.beforeDirecting(baseRun(dirA));
  await A.createAssetStep({ todoStore: () => without, ask: () => ({ ok: false }), logEvent: () => {} }).beforeDirecting(baseRun(dirB));
  assert.equal(calls.length, 0);
  const strip = (cards) => cards.map(({ text, details, files }) => ({ text, details, files }));
  assert.deepEqual(strip(assetCards(withCasting)), strip(assetCards(without)));
  assert.deepEqual(readList(dirA).rows.map((r) => r.source), ['blender', 'library', 'generated']);
  // The pipeline brief is unchanged without a cast.
  const plain = require('../src/lunasworkAssetPipeline.js').unityAssetBrief({ kind: 'vfx', slug: 'x', source: 'generated' });
  assert.deepEqual(require('../src/lunasworkAssetPipeline.js').unityAssetBrief({ kind: 'vfx', slug: 'x', source: 'generated', casting: [] }), plain);
});

test('the spend estimate prices a cast row by its picked source and model', () => {
  const plan = (primary) => ({ primary, fallbacks: [], candidates: 1, reason: 'x', costClass: { library: 'library', comfyui: 'local', blender: 'local', higgsfield: 'paid' }[primary.source] });
  const est = Cost.assetManifestEstimate([
    { name: 'A', type: 'sprite', source: 'generated', spec: 'a', casting: plan({ source: 'comfyui', comfyWorkflow: 'draft.json' }) },
    { name: 'B', type: 'model', source: 'library', spec: 'b', casting: plan({ source: 'library', librarySources: ['polyhaven'] }) },
    { name: 'C', type: 'model', source: 'generated', spec: 'c', casting: plan({ source: 'higgsfield', higgsfieldModel: 'image-to-3d' }) },
  ]);
  assert.equal(est.library.count, 1);
  assert.equal(est.local.count, 1);
  assert.equal(est.paid.count, 1);
  assert.equal(est.paid.rows[0].model, 'image-to-3d');
  assert.equal(est.paid.credits, 30);
});

test('renderCastingBrief gives nothing for no plan', () => {
  assert.deepEqual(C.renderCastingBrief(null), []);
  assert.deepEqual(C.renderCastingBrief({ primary: { source: 'nope' } }), []);
  assert.match(C.renderCastingBrief({ primary: { source: 'blender' }, fallbacks: [], candidates: 1, reason: '' }).join('\n'), /No fallback rung/);
});
