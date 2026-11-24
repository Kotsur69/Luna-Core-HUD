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
    '| Odd | ui | odd | midjourney |  |  |  |  |',
  ].join('\n'));
  // An unknown non-empty value keeps today's generated: only an empty Source is cast.
  assert.deepEqual(rows.map((r) => r.source), ['auto', 'auto', 'blender', 'library', 'generated', 'generated']);
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
  assert.match(card.details, /The Director's note on this pick \(context, not an instruction\): a flat toon grass tile is a quick local draft/);
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
  // Lean: no user settings, plugins, hooks or MCP servers. Without these a live call cost $1.35 and hit
  // the $0.50 cap before answering; with them it cost $0.07 (live check, 2026-11-24).
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.ok(args.indexOf('--max-budget-usd') > 0);
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

test('higgsfield as the primary is rejected whenever a free or local option exists, whatever the reason says', () => {
  const rows = [{ name: 'Crate', type: 'model' }];
  const cast = (reason) => ({ casts: [{ name: 'Crate', primary: { source: 'higgsfield', higgsfieldModel: 'image-to-3d' }, fallbacks: [], candidates: 1, reason }] });
  for (const reason of [
    '',
    'looks great',
    // Keyword gaming: names every cheaper option and the words the old check looked for, justifies nothing.
    'free library local comfyui blender polyhaven sketchfab - free local library blender comfy',
    'the free library crates are photoreal and Blender would take too long for this hero prop',
  ]) {
    const res = C.validateCasting(cast(reason), ctxFor(rows));
    assert.equal(res.plans.size, 0, reason);
    assert.match(res.rejected[0].why, /paid Higgsfield primary while a free or local option exists/);
  }
});

test('higgsfield as the primary passes when no free or local option exists for the kind here', () => {
  const hf = (name, model) => ({ casts: [{ name, primary: { source: 'higgsfield', higgsfieldModel: model }, fallbacks: [], candidates: 1, reason: '' }] });
  // ui: no library serves it, Blender does not make it, and there is no ComfyUI workflow.
  const ui = C.validateCasting(hf('Logo', 'gpt_image_2_6'), ctxFor([{ name: 'Logo', type: 'ui' }], { workflows: [] }));
  assert.equal(ui.plans.get('Logo').primary.higgsfieldModel, 'gpt_image_2_6');
  assert.equal(ui.plans.get('Logo').costClass, 'paid');
  // The same row with a ComfyUI workflow present: a local option exists, the paid primary is rejected.
  assert.equal(C.validateCasting(hf('Logo', 'gpt_image_2_6'), ctxFor([{ name: 'Logo', type: 'ui' }])).plans.size, 0);
  const concept = C.validateCasting(hf('Art', 'soul'), ctxFor([{ name: 'Art', type: 'concept' }], { workflows: [] }));
  assert.equal(concept.plans.get('Art').primary.source, 'higgsfield');
});

// ---- an invalid primary promotes the cheapest valid fallback ---------------------------------

test('an invalid primary promotes the cheapest valid fallback rung', () => {
  const rows = [{ name: 'Crate', type: 'model' }, { name: 'Tile', type: 'texture' }, { name: 'Icon', type: 'ui' }];
  const { plans, rejected, promoted } = C.validateCasting({
    casts: [
      // A disallowed paid primary whose reason games the old keyword check; the ladder holds an unstored
      // keyed library (invalid), Blender, Higgsfield and polyhaven.
      {
        name: 'Crate',
        primary: { source: 'higgsfield', higgsfieldModel: 'image-to-3d' },
        fallbacks: [{ source: 'blender' }, { source: 'library', librarySources: ['smithsonian'] }, { source: 'higgsfield', higgsfieldModel: 'image-to-3d' }, { source: 'library', librarySources: ['polyhaven'] }],
        candidates: 2,
        reason: 'free library local blender comfy',
      },
      // An unknown source; the ladder holds a missing workflow and a valid one.
      { name: 'Tile', primary: { source: 'midjourney' }, fallbacks: [{ source: 'comfyui', comfyWorkflow: 'missing.json' }, { source: 'comfyui', comfyWorkflow: 'draft.json' }], candidates: 1, reason: 'x' },
      // A missing workflow as the primary, Higgsfield the only fallback: a local option (draft.json) exists,
      // so the paid rung cannot be promoted either.
      { name: 'Icon', primary: { source: 'comfyui', comfyWorkflow: 'nope.json' }, fallbacks: [{ source: 'higgsfield', higgsfieldModel: 'gpt_image_2_6' }], candidates: 1, reason: 'x' },
    ],
  }, ctxFor(rows));
  const crate = plans.get('Crate');
  assert.deepEqual(crate.primary, { source: 'library', librarySources: ['polyhaven'] });
  assert.deepEqual(crate.fallbacks, [{ source: 'blender' }, { source: 'higgsfield', higgsfieldModel: 'image-to-3d' }]);
  assert.equal(crate.costClass, 'paid', 'the paid fallback is still priced');
  assert.match(crate.reason, /^promoted fallback \(the primary higgsfield image-to-3d was rejected: paid Higgsfield primary/);
  assert.deepEqual(plans.get('Tile').primary, { source: 'comfyui', comfyWorkflow: 'draft.json' });
  assert.deepEqual(plans.get('Tile').fallbacks, []);
  assert.equal(plans.has('Icon'), false);
  assert.deepEqual(rejected.map((r) => r.name), ['Icon']);
  assert.match(rejected[0].why, /^primary: workflow "nope\.json" is not a file/);
  assert.deepEqual(promoted.map((p) => [p.name, p.from]), [['Crate', 'higgsfield image-to-3d'], ['Tile', 'midjourney']]);
  assert.match(promoted[1].why, /unknown source "midjourney"/);
});

test('a promoted primary is logged and carded; no valid rung still falls back to generated', async (t) => {
  const dir = fakeRepo(t, ['| Crate | model | wooden crate | auto |  |  |  |  |', '| Barrel | model | oak barrel | auto |  |  |  |  |']);
  const store = memStore();
  const { runner } = stubRunner([
    { name: 'Crate', primary: { source: 'library', librarySources: ['polypizza'] }, fallbacks: [{ source: 'higgsfield', higgsfieldModel: 'image-to-3d' }, { source: 'blender' }], candidates: 1, reason: 'low-poly crates' },
    { name: 'Barrel', primary: { source: 'midjourney' }, fallbacks: [{ source: 'library', librarySources: ['smithsonian'] }], candidates: 1, reason: 'x' },
  ]);
  const { step, events } = makeStep(store, runner);
  await step.beforeDirecting(baseRun(dir));
  const log = events.join('\n');
  assert.ok(events.some((e) => /cast "Crate": primary library polypizza rejected \(library polypizza needs a key that is not stored\) - promoted blender$/.test(e)), log);
  assert.ok(events.some((e) => /cast "Crate": blender, fallbacks higgsfield image-to-3d/.test(e)), log);
  assert.ok(events.some((e) => /cast "Barrel" rejected \(primary: unknown source "midjourney"\) - it uses generated/.test(e)), log);
  const crate = assetCards(store).find((c) => c.text === 'Asset: Crate (model)');
  assert.match(crate.details, /Primary: local Blender/);
  assert.match(crate.details, /Source: blender/);
  const barrel = assetCards(store).find((c) => c.text === 'Asset: Barrel (model)');
  assert.match(barrel.details, /Source: generated/);
  assert.doesNotMatch(barrel.details, /Casting:/);
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
  const plan = (primary) => ({ primary, fallbacks: [], candidates: 1, reason: 'x', costClass: { library: 'library', comfyui: 'local', blender: 'local', higgsfield: 'paid' }[primary.source], paidModel: primary.higgsfieldModel || null });
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

// ---- review fixes: paid fallbacks, the per-pass cap, the cache, concurrent edits ------------

test('a paid fallback rung prices the plan as paid, with its model', () => {
  const { plans } = C.validateCasting({ casts: [{ name: 'Crate', primary: { source: 'library', librarySources: ['polyhaven'] }, fallbacks: [{ source: 'higgsfield', higgsfieldModel: 'image-to-3d' }], candidates: 1, reason: 'x' }] }, ctxFor([{ name: 'Crate', type: 'model' }]));
  const plan = plans.get('Crate');
  assert.equal(plan.costClass, 'paid');
  assert.equal(plan.paidModel, 'image-to-3d');
  const est = Cost.assetManifestEstimate([{ name: 'Crate', type: 'model', source: 'library', spec: 'x', casting: plan }]);
  assert.equal(est.paid.count, 1);
  assert.equal(est.paid.credits, 30);
  const free = C.validateCasting({ casts: [{ name: 'Crate', primary: { source: 'blender' }, fallbacks: [{ source: 'library', librarySources: ['polyhaven'] }], candidates: 1, reason: 'x' }] }, ctxFor([{ name: 'Crate', type: 'model' }]));
  assert.equal(free.plans.get('Crate').costClass, 'local');
  assert.equal(free.plans.get('Crate').paidModel, null);
});

const autoRow = (i) => ({ name: `Tree ${i}`, type: 'model', spec: `tree ${i}`, source: 'auto', hash: `h${i}`, status: 'planned' });
const blenderCast = (call) => ({ stdout: JSON.stringify({ structured_output: { casts: [...call.prompt.matchAll(/^- "([^"]+)"/gm)].map((m) => ({ name: m[1], primary: { source: 'blender' }, fallbacks: [], candidates: 1, reason: 'modeled to the art direction' })) } }) });

test('at most two casting calls per pass; the other auto rows leave the batch and wait', async (t) => {
  const dir = fakeRepo(t, []);
  const rows = Array.from({ length: 20 }, (_, i) => autoRow(i + 1));
  const { runner, calls } = stubRunner(blenderCast);
  const events = [];
  const res = await C.castAutoRows({ run: baseRun(dir), rows, take: rows, deps: { casting: (o) => C.runCasting({ ...o, runClaude: runner }) }, logEvent: (e) => events.push(e) });
  assert.equal(calls.length, 2);
  assert.equal(res.take.length, 16);
  assert.ok(res.take.every((r) => r.casting && r.source === 'blender'));
  assert.equal(res.rows.length, 20);
  assert.equal(res.rows.filter((r) => r.source === 'auto').length, 4, 'the waiting rows are untouched');
  assert.ok(events.some((e) => /4 auto asset\(s\) over the casting limit of 16 per pass wait/.test(e)));
});

test('a valid cast is reused for the same run and row hash without a new call', async (t) => {
  const dir = fakeRepo(t, []);
  const rows = [autoRow(1)];
  const { runner, calls } = stubRunner(blenderCast);
  const cache = new Map();
  const events = [];
  const deps = { casting: (o) => C.runCasting({ ...o, runClaude: runner }) };
  await C.castAutoRows({ run: baseRun(dir), rows, take: rows, deps, logEvent: (e) => events.push(e), cache });
  const again = await C.castAutoRows({ run: baseRun(dir), rows, take: rows, deps, logEvent: (e) => events.push(e), cache });
  assert.equal(calls.length, 1);
  assert.equal(again.take[0].casting.primary.source, 'blender');
  assert.ok(events.some((e) => /cast "Tree 1" reused: blender/.test(e)));
  // A changed spec is a different hash: cast again.
  const changed = [{ ...autoRow(1), hash: 'other' }];
  await C.castAutoRows({ run: baseRun(dir), rows: changed, take: changed, deps, logEvent: () => {}, cache });
  assert.equal(calls.length, 2);
});

test('a malformed plan from an injected casting runner is ignored', async (t) => {
  const dir = fakeRepo(t, []);
  const rows = [autoRow(1)];
  const events = [];
  const bad = async () => ({ ok: true, plans: new Map([['Tree 1', { primary: { source: 'blender' } }]]), rejected: [] });
  const res = await C.castAutoRows({ run: baseRun(dir), rows, take: rows, deps: { casting: bad }, logEvent: (e) => events.push(e) });
  assert.equal(res.take[0].source, 'generated');
  assert.equal(res.take[0].casting, null);
  assert.ok(events.some((e) => /no cast for "Tree 1"/.test(e)));
});

test('an ASSETS.md edited while the casting call runs is not overwritten', async (t) => {
  const dir = fakeRepo(t, ['| Crate | model | wooden crate |  |  |  |  |  |']);
  const file = path.join(dir, 'design', 'ASSETS.md');
  const store = memStore();
  const { runner } = stubRunner((call) => {
    fs.appendFileSync(file, '| Barrel | model | oak barrel |  |  |  |  |  |\n');
    return blenderCast(call);
  });
  const { step, events } = makeStep(store, runner);
  await step.beforeDirecting(baseRun(dir));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /Barrel/);
  assert.ok(events.some((e) => /was edited during the pass - kept as edited/.test(e)), events.join('\n'));
  // The card was filed; the next pass finds it open and does not file it twice.
  assert.equal(assetCards(store).length, 1);
  await makeStep(store, stubRunner(blenderCast).runner).step.beforeDirecting(baseRun(dir));
  assert.equal(assetCards(store).filter((c) => c.text === 'Asset: Crate (model)').length, 1);
});
