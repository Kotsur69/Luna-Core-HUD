// ============================================================================
// Luna's Work asset pipeline executor (src/lunasworkAssetPipeline.js): the
// four acceptance flows with a fake for every tool call - Blender, ComfyUI,
// Higgsfield, the downloader and the Unity Pipeline. The spend guard is the
// real one (src/lunasworkToolGuard.js) over an in-memory run. The repo is a
// temp dir.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/lunasworkAssetPipeline.js');
const { createToolGuard, cleanGuardFields } = require('../src/lunasworkToolGuard.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const FBX = Buffer.concat([Buffer.from('Kaydara FBX Binary  \0', 'latin1'), Buffer.alloc(16)]);
const BLEND = Buffer.concat([Buffer.from('BLENDER-v400', 'latin1'), Buffer.alloc(16)]);
const ART = 'Assets/BladeBullet/Art';

const WORKFLOW = {
  3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, model: ['4', 0] } },
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'toon style, {{prompt}}', clip: ['4', 1] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'draft', images: ['8', 0] } },
};

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-asset-pipe-'));
  fs.mkdirSync(path.join(dir, 'art', 'comfyui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'art', 'comfyui', 'concept.json'), JSON.stringify(WORKFLOW));
  return dir;
}

const exists = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));

/** Fake Unity Pipeline client: records every command; set_properties answers like the live editor. */
function fakeUnity() {
  const calls = [];
  const answer = (command) => (command === 'material set_properties' ? { shader: 'Universal Render Pipeline/Lit', applied: ['_BaseMap'], unknown: [] } : { ok: true });
  return { calls, exec: async (command, parameters) => { calls.push({ command, parameters }); return answer(command); } };
}

const REFRESH = 'editor invoke_menu';
const MODEL_PREFAB = 'script eval';
const MAKE_MATERIAL = ['asset create', 'material set_properties'];
/** The [model, prefab] paths a modelPrefab `script eval` call names. */
const prefabPaths = (call) => [...call.parameters.code.matchAll(/(?:LoadAssetAtPath<UnityEngine\.GameObject>\(|SaveAsPrefabAsset\(instance, )"([^"]+)"/g)].map((m) => m[1]);

/** Fake Blender MCP add-on: runs the export script by writing the two files it names. */
function fakeBlender() {
  const scripts = [];
  return {
    scripts,
    executeCode: async (code) => {
      scripts.push(code);
      const [blend, fbx] = [...code.matchAll(/filepath=("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
      fs.writeFileSync(blend, BLEND);
      fs.writeFileSync(fbx, FBX);
      return { executed: true };
    },
  };
}

/** The run's spend guard over an in-memory run record, with the cards it files. */
function guardFor(capUsd) {
  let run = { id: 'r1', projectId: 'p1', phase: 'build', ...cleanGuardFields({ spendCaps: { higgsfield: capUsd } }) };
  const cards = [];
  const guard = createToolGuard({
    run: () => run,
    update: (f) => { run = { ...run, ...f }; },
    logEvent: () => {},
    armWait: () => {},
    fileCards: (c) => { cards.push(...c); return c.map((_, i) => i + 1); },
    now: () => 1000,
  });
  return { guard, cards, run: () => run };
}

function pipeline(dir, extra = {}) {
  const logged = [];
  const unity = fakeUnity();
  const p = P.createAssetPipeline({
    repoPath: dir,
    unity,
    recordSpend: () => ({ ok: true, reason: null }),
    logAsset: (e) => logged.push(e),
    now: () => 42,
    ...extra,
  });
  return { p, logged, unity };
}

// ---- 1. Blender -------------------------------------------------------------------------

test('a Blender asset card -> .blend + FBX in the repo, then Unity import and prefab calls', async () => {
  const dir = tempRepo();
  const blender = fakeBlender();
  const { p, logged, unity } = pipeline(dir, { blender });
  const res = await p.blenderModel({ name: 'Ronin Hero', kind: 'character', prompt: 'toon samurai' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Characters/ronin-hero.fbx`]);
  assert.deepEqual(res.sources, ['art/blender/ronin-hero.blend']);
  assert.ok(exists(dir, 'art/blender/ronin-hero.blend') && exists(dir, `${ART}/Characters/ronin-hero.fbx`));
  // The export is set up for Unity: -Z forward, Y up, scale applied.
  assert.match(blender.scripts[0], /axis_forward='-Z', axis_up='Y'/);
  assert.match(blender.scripts[0], /apply_scale_options='FBX_SCALE_ALL'/);
  assert.deepEqual(unity.calls.map((c) => c.command), [REFRESH, MODEL_PREFAB]);
  assert.deepEqual(unity.calls[0].parameters, { path: 'Assets/Refresh' });
  assert.deepEqual(prefabPaths(unity.calls[1]), [`${ART}/Characters/ronin-hero.fbx`, `${ART}/Characters/ronin-hero.prefab`]);
  assert.equal(res.prefab, `${ART}/Characters/ronin-hero.prefab`);
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].tool, logged[0].path, logged[0].costUsd, logged[0].seed, logged[0].imported], ['blender', `${ART}/Characters/ronin-hero.fbx`, 0, null, true]);
  // A generated asset gets its license row too, so the Critic's ledger check passes.
  assert.equal(res.ledger, 'design/ASSET_LICENSES.md');
  const ledger = fs.readFileSync(path.join(dir, 'design', 'ASSET_LICENSES.md'), 'utf8');
  assert.match(ledger, /\| Ronin Hero \| art\/blender\/ronin-hero\.blend \| LunaCore asset worker \(Blender\) \| Own work \(generated\) \| Assets\/BladeBullet\/Art\/Characters\/ronin-hero\.fbx \|/);
  assert.equal(exists(dir, 'Assets/StreamingAssets/CREDITS.txt'), false, 'no CC-BY row, no credits file');
});

test('a Blender export that wrote nothing (or not an FBX) fails before any Unity call', async () => {
  const dir = tempRepo();
  const { p, unity, logged } = pipeline(dir, { blender: { executeCode: async () => ({}) } });
  const res = await p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.deepEqual([res.ok, res.error], [false, 'blenderFailed']);
  assert.equal(unity.calls.length, 0);
  assert.equal(logged.length, 0);
});

test('a Blender export that left the earlier files in place is not taken for a new one', async () => {
  const dir = tempRepo();
  const blender = fakeBlender();
  const { p } = pipeline(dir, { blender });
  assert.equal((await p.blenderModel({ name: 'Crate', kind: 'prop' })).ok, true);
  // The add-on answers success but writes nothing this time.
  const again = pipeline(dir, { blender: { executeCode: async () => ({ executed: true }) } });
  const res = await again.p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.deepEqual([res.ok, res.error], [false, 'blenderFailed']);
  assert.match(res.detail, /earlier file, not a new export/);
  assert.equal(again.unity.calls.length, 0);
});

test('a 2D kind is refused for Blender and an unknown kind everywhere', async () => {
  const { p } = pipeline(tempRepo(), { blender: fakeBlender() });
  assert.equal((await p.blenderModel({ name: 'x', kind: 'concept' })).error, 'badKind');
  assert.equal((await p.blenderModel({ name: 'x', kind: '../../etc' })).error, 'badKind');
  assert.equal((await p.blenderModel({ name: '../..', kind: 'prop' })).error, 'badName');
});

// ---- 2. ComfyUI -------------------------------------------------------------------------

test('a ComfyUI workflow run -> the output is imported, the workflow and seed are saved', async () => {
  const dir = tempRepo();
  const ran = [];
  const comfy = { run: async (wf) => { ran.push(wf); return { promptId: 'abc-123', images: [{ filename: 'draft_00001_.png', data: PNG, ext: 'png' }] }; } };
  const { p, logged, unity } = pipeline(dir, { comfy });
  const res = await p.comfyDraft({ name: 'Blade Slash', kind: 'vfx', prompt: 'red arc', workflow: 'concept.json', seed: 777 });
  assert.equal(res.ok, true, JSON.stringify(res));
  const out = `${ART}/VFX/blade-slash-draft-777.png`;
  assert.deepEqual(res.files, [out]);
  assert.deepEqual(fs.readFileSync(path.join(dir, ...out.split('/'))), PNG);
  // The workflow ComfyUI got: seeded, prompted, the repo file itself untouched.
  assert.equal(ran[0]['3'].inputs.seed, 777);
  assert.equal(ran[0]['6'].inputs.text, 'toon style, red arc');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'art', 'comfyui', 'concept.json'), 'utf8'))['3'].inputs.seed, 1);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'comfyui', 'runs', 'blade-slash-draft-777.json'), 'utf8'));
  assert.deepEqual([record.seed, record.workflow, record.promptId, record.prompt], [777, 'art/comfyui/concept.json', 'abc-123', 'red arc']);
  assert.equal(record.api['3'].inputs.seed, 777);
  assert.deepEqual(unity.calls.map((c) => c.command), [REFRESH]);
  assert.deepEqual([logged[0].tool, logged[0].seed, logged[0].costUsd, logged[0].path], ['comfyui', 777, 0, out]);
});

test('a ComfyUI draft without a seed gets a fresh one; a texture also gets a material', async () => {
  const dir = tempRepo();
  const comfy = { run: async () => ({ promptId: 'p1', images: [{ data: PNG }] }) };
  const { p, unity } = pipeline(dir, { comfy, randomSeed: () => 5 });
  const res = await p.comfyDraft({ name: 'Floor', kind: 'texture', prompt: 'stone', workflow: 'art/comfyui/concept.json' });
  assert.equal(res.seed, 5);
  assert.deepEqual(unity.calls.map((c) => c.command), [REFRESH, ...MAKE_MATERIAL]);
  const mat = `${ART}/Textures/floor-draft-5.mat`;
  assert.deepEqual(unity.calls[1].parameters, { path: mat, type: 'UnityEngine.Material' });
  assert.deepEqual(unity.calls[2].parameters, { material: mat, properties: { _BaseMap: { path: `${ART}/Textures/floor-draft-5.png` } } });
});

test('ComfyUI local audio (WAV) and 3D (GLB) outputs: audio imports to Audio/, GLB gets a Unity prefab', async () => {
  const dir = tempRepo();
  const WAV = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(16, 1)]);
  const GLB = Buffer.concat([Buffer.from('glTF', 'latin1'), Buffer.alloc(16, 2)]);
  const outs = [WAV, GLB];
  const comfy = { run: async () => ({ promptId: 'p-multi', images: [{ data: outs.shift() }] }) };
  const { p, unity } = pipeline(dir, { comfy });
  const voice = await p.comfyDraft({ name: 'Tokine Bark', kind: 'audio', prompt: 'time stops now', workflow: 'concept.json', seed: 11 });
  assert.equal(voice.ok, true, JSON.stringify(voice));
  assert.deepEqual(voice.files, [`${ART}/Audio/tokine-bark-draft-11.wav`]);
  const mesh = await p.comfyDraft({ name: 'Gear Prop', kind: 'prop', prompt: 'brass clock gear', workflow: 'concept.json', seed: 12 });
  assert.equal(mesh.ok, true, JSON.stringify(mesh));
  assert.deepEqual(mesh.files, [`${ART}/Props/gear-prop-draft-12.glb`]);
  assert.deepEqual(unity.calls.map((c) => c.command), [REFRESH, REFRESH, MODEL_PREFAB]);
  assert.deepEqual(prefabPaths(unity.calls[2]), [`${ART}/Props/gear-prop-draft-12.glb`, `${ART}/Props/gear-prop-draft-12.prefab`]);
});

test('a ComfyUI workflow the seed or prompt cannot reach is run with warnings; the same seed again gets -v2', async () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, 'art', 'comfyui', 'fixed.json'), JSON.stringify({ 9: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' } } }));
  const comfy = { run: async () => ({ promptId: 'p', images: [{ data: PNG }] }) };
  const { p } = pipeline(dir, { comfy });
  const res = await p.comfyDraft({ name: 'Fog', kind: 'vfx', prompt: 'thin fog', workflow: 'fixed.json', seed: 8 });
  assert.equal(res.ok, true);
  assert.equal(res.warnings.length, 2);
  assert.match(res.warnings.join(' '), /no numeric seed.*no "\{\{prompt\}\}" placeholder/);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'comfyui', 'runs', 'fog-draft-8.json'), 'utf8'));
  assert.deepEqual([record.seedApplied, record.promptApplied], [false, false]);
  const again = await p.comfyDraft({ name: 'Fog', kind: 'vfx', prompt: 'thin fog', workflow: 'concept.json', seed: 8 });
  assert.deepEqual(again.files, [`${ART}/VFX/fog-draft-8-v2.png`]);
  assert.deepEqual(again.warnings, []);
  assert.ok(exists(dir, 'art/comfyui/runs/fog-draft-8-v2.json'));
});

test('a workflow outside art/comfyui/, a UI-format workflow and a non-image result are refused', async () => {
  const dir = tempRepo();
  fs.writeFileSync(path.join(dir, 'art', 'comfyui', 'ui.json'), JSON.stringify({ nodes: [], links: [] }));
  const comfy = { run: async () => ({ promptId: 'p', images: [{ data: Buffer.from('<html>not an image</html>') }] }) };
  const { p, unity } = pipeline(dir, { comfy });
  assert.equal((await p.comfyDraft({ name: 'a', kind: 'concept', workflow: '../secret.json' })).error, 'badWorkflow');
  assert.equal((await p.comfyDraft({ name: 'a', kind: 'concept', workflow: 'C:\\x.json' })).error, 'badWorkflow');
  const ui = await p.comfyDraft({ name: 'a', kind: 'concept', workflow: 'ui.json' });
  assert.match(ui.detail, /API Format/);
  assert.equal((await p.comfyDraft({ name: 'a', kind: 'concept', workflow: 'concept.json' })).error, 'comfyFailed');
  assert.equal(unity.calls.length, 0);
});

// ---- 3. Higgsfield ------------------------------------------------------------------------

function fakeHiggsfield(credits = 4) {
  const calls = [];
  return {
    calls,
    estimate: async (job) => { calls.push(['estimate', job]); return { credits }; },
    generate: async (job) => { calls.push(['generate', job]); return { jobId: 'job_1', urls: ['https://cdn.example.test/out.png'], seed: 99 }; },
  };
}

test('a Higgsfield generation is booked, saved, imported and logged with its cost', async () => {
  const dir = tempRepo();
  const g = guardFor(10);
  const higgsfield = fakeHiggsfield(4);
  const downloads = [];
  const { p, logged, unity } = pipeline(dir, {
    higgsfield,
    usdPerCredit: 0.25,
    download: async (url) => { downloads.push(url); return PNG; },
    recordSpend: (x) => g.guard.recordSpend(x),
    cappedTools: () => g.guard.cappedTools(),
  });
  const res = await p.higgsfieldFinal({ name: 'Key Art', kind: 'keyart', prompt: 'hero duel at dusk', model: 'gpt_image_2_6', params: { aspect_ratio: '16:9' } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(higgsfield.calls.map((c) => c[0]), ['estimate', 'generate']);
  assert.deepEqual(higgsfield.calls[1][1], { model: 'gpt_image_2_6', prompt: 'hero duel at dusk', params: { aspect_ratio: '16:9' } });
  assert.equal(g.run().spend.higgsfield, 1);
  assert.deepEqual(downloads, ['https://cdn.example.test/out.png']);
  assert.deepEqual(res.files, [`${ART}/KeyArt/key-art.png`]);
  assert.ok(exists(dir, `${ART}/KeyArt/key-art.png`));
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'higgsfield', 'keyart', 'key-art.json'), 'utf8'));
  assert.deepEqual([record.credits, record.costUsd, record.jobId, record.seed, record.status], [4, 1, 'job_1', 99, 'saved']);
  assert.deepEqual(record.outputs, [`${ART}/KeyArt/key-art.png`]);
  assert.deepEqual(res.sources, ['art/higgsfield/keyart/key-art.json']);
  assert.deepEqual(unity.calls.map((c) => c.command), [REFRESH]);
  assert.deepEqual([logged[0].tool, logged[0].costUsd, logged[0].credits, logged[0].seed, logged[0].prompt], ['higgsfield', 1, 4, 99, 'hero duel at dusk']);
  assert.match(P.assetReportLines(logged)[0], /^higgsfield keyart "Key Art": Assets\/BladeBullet\/Art\/KeyArt\/key-art\.png - prompt "hero duel at dusk", seed 99, cost \$1\.00 \(4 credits\)$/);
});

test('budget reached -> no more Higgsfield calls and one card filed', async () => {
  const dir = tempRepo();
  const g = guardFor(1.5);
  const higgsfield = fakeHiggsfield(4);
  const { p, logged } = pipeline(dir, {
    higgsfield,
    usdPerCredit: 0.25,
    download: async () => PNG,
    recordSpend: (x) => g.guard.recordSpend(x),
    cappedTools: () => g.guard.cappedTools(),
  });
  const job = (name) => ({ name, kind: 'concept', prompt: 'ninja', model: 'gpt_image_2_6' });
  assert.equal((await p.higgsfieldFinal(job('One'))).ok, true);
  const over = await p.higgsfieldFinal(job('Two'));
  assert.deepEqual([over.ok, over.error], [false, 'capReached']);
  const after = await p.higgsfieldFinal(job('Three'));
  assert.deepEqual([after.ok, after.error], [false, 'capReached']);
  // estimate + generate for One, only the estimate for Two, nothing for Three.
  assert.deepEqual(higgsfield.calls.map((c) => c[0]), ['estimate', 'generate', 'estimate']);
  assert.equal(g.cards.length, 1);
  assert.match(g.cards[0].text, /higgsfield spend cap reached/);
  assert.deepEqual(g.guard.cappedTools(), ['higgsfield']);
  assert.equal(logged.length, 1);
  // A new pipeline (the next tool call) of the same run is stopped by the guard before any call.
  const fresh = fakeHiggsfield(1);
  const next = pipeline(dir, { higgsfield: fresh, download: async () => PNG, recordSpend: (x) => g.guard.recordSpend(x), cappedTools: () => g.guard.cappedTools() });
  assert.equal((await next.p.higgsfieldFinal(job('Four'))).error, 'capReached');
  assert.equal(fresh.calls.length, 0);
});

test('Higgsfield results are validated before they are written; the paid job is kept and logged', async () => {
  const dir = tempRepo();
  const higgsfield = fakeHiggsfield(1);
  const { p, logged } = pipeline(dir, { higgsfield, download: async () => Buffer.from('MZ not an image at all') });
  const res = await p.higgsfieldFinal({ name: 'Bad', kind: 'concept', prompt: 'x', model: 'gpt_image_2_6' });
  assert.deepEqual([res.ok, res.error], [false, 'higgsfieldFailed']);
  assert.equal(exists(dir, `${ART}/Concepts`), false);
  // Paid, not saved: the worker gets the job and the URLs, the record says why, the report logs the cost.
  assert.deepEqual([res.jobId, res.urls, res.record, res.costUsd], ['job_1', ['https://cdn.example.test/out.png'], 'art/higgsfield/concept/bad.json', 0.1]);
  assert.match(res.detail, /generated and paid, but not saved: a result is not an image/);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'higgsfield', 'concept', 'bad.json'), 'utf8'));
  assert.deepEqual([record.status, record.jobId, record.urls, record.outputs], ['notSaved', 'job_1', ['https://cdn.example.test/out.png'], []]);
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].unsaved, logged[0].costUsd, logged[0].path, logged[0].imported], [true, 0.1, 'art/higgsfield/concept/bad.json', false]);
  assert.match(P.assetReportLines(logged)[0], /cost \$0\.10 \(1 credits\), PAID BUT NOT SAVED/);
  assert.equal((await p.higgsfieldFinal({ name: 'x', kind: 'concept', prompt: 'x', model: 'a b; rm -rf' })).error, 'badModel');
  const withParams = async (params) => (await p.higgsfieldFinal({ name: 'x', kind: 'concept', prompt: 'x', model: 'm', params })).error;
  assert.equal(await withParams({ style: '$(x)' }), 'badParams');
  // A value that would read as a CLI flag is refused too, and so are the flags the pipeline owns or that name files.
  assert.equal(await withParams({ style: '--help' }), 'badParams');
  for (const key of ['json', 'wait', 'output', 'config', 'o']) assert.equal(await withParams({ [key]: 'x' }), 'badParams', key);
  assert.equal(await withParams({ aspect_ratio: '16:9', resolution: '2k' }), 'higgsfieldFailed', 'plain flags pass validation (the download is what fails here)');
});

test('a paid set that is only partly written says so; a report that cannot log the cost is named in the answer', async () => {
  const dir = tempRepo();
  // The second file's rename fails (a full disk, a locked file).
  const fsImpl = { ...fs, renameSync: (from, to) => (to.endsWith('-2.png') ? (() => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); })() : fs.renameSync(from, to)) };
  const higgsfield = { ...fakeHiggsfield(2), generate: async () => ({ jobId: 'job_2', urls: ['https://cdn.example.test/1.png', 'https://cdn.example.test/2.png'], seed: 1 }) };
  const { p, logged } = pipeline(dir, { higgsfield, download: async () => PNG, fsImpl, logAsset: (e) => { logged.push(e); throw new Error('store locked'); } });
  const res = await p.higgsfieldFinal({ name: 'Pair', kind: 'concept', prompt: 'x', model: 'm' });
  assert.deepEqual([res.ok, res.files], [false, [`${ART}/Concepts/pair-1.png`]]);
  assert.match(res.detail, /only partially saved \(1 of 2 files\): EBUSY/);
  assert.match(res.note, /run report could not log this cost/);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'higgsfield', 'concept', 'pair.json'), 'utf8'));
  assert.deepEqual([record.status, record.outputs], ['notSaved', [`${ART}/Concepts/pair-1.png`]]);
  assert.deepEqual(fs.readdirSync(path.join(dir, ...`${ART}/Concepts`.split('/'))).filter((f) => f.endsWith('.tmp')), [], 'the failed write left no temp file');
  assert.deepEqual([logged.length, logged[0].unsaved, logged[0].costUsd], [1, true, 0.2]);
});

test('a Higgsfield record is on disk before the download, without the URL query; a failed generation still logs its booked cost', async () => {
  const dir = tempRepo();
  const signed = 'https://cdn.example.test/out.png?X-Sig=abc&expires=9';
  let seenRecord = null;
  const higgsfield = { ...fakeHiggsfield(2), generate: async () => ({ jobId: 'job_9', urls: [signed], seed: 4 }) };
  const download = async () => {
    seenRecord = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'higgsfield', 'concept', 'gate.json'), 'utf8'));
    throw new Error('download timed out after 120 s');
  };
  const { p, logged } = pipeline(dir, { higgsfield, download });
  const res = await p.higgsfieldFinal({ name: 'Gate', kind: 'concept', prompt: 'torii', model: 'gpt_image_2_6' });
  assert.deepEqual([seenRecord.status, seenRecord.jobId, seenRecord.urls], ['generated', 'job_9', ['https://cdn.example.test/out.png']]);
  assert.deepEqual(res.urls, [signed], 'the tool answer keeps the full URL to finish by hand');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'art', 'higgsfield', 'concept', 'gate.json'), 'utf8'), /X-Sig/);
  assert.equal(logged[0].unsaved, true);

  const broken = pipeline(tempRepo(), { higgsfield: { ...fakeHiggsfield(3), generate: async () => { throw new Error('job failed'); } }, download: async () => PNG });
  const gone = await broken.p.higgsfieldFinal({ name: 'Lost', kind: 'concept', prompt: 'x', model: 'gpt_image_2_6' });
  assert.match(gone.detail, /\$0\.30 was booked, but the generation failed: job failed/);
  assert.deepEqual([broken.logged[0].unsaved, broken.logged[0].costUsd, broken.logged[0].path], [true, 0.3, 'higgsfield:gpt_image_2_6']);

  // No downloader: refused before anything is estimated or paid.
  const noDl = fakeHiggsfield(1);
  const blind = pipeline(tempRepo(), { higgsfield: noDl });
  assert.equal((await blind.p.higgsfieldFinal({ name: 'x', kind: 'concept', prompt: 'x', model: 'm' })).error, 'toolDown');
  assert.equal(noDl.calls.length, 0);
});

test('a second paid final of the same name gets -v2 and never overwrites the first', async () => {
  const dir = tempRepo();
  const OTHER = Buffer.concat([PNG, Buffer.alloc(8, 7)]);
  const bodies = [PNG, OTHER];
  const { p } = pipeline(dir, { higgsfield: fakeHiggsfield(1), download: async () => bodies.shift() });
  const first = await p.higgsfieldFinal({ name: 'Logo', kind: 'keyart', prompt: 'x', model: 'm' });
  const second = await p.higgsfieldFinal({ name: 'Logo', kind: 'keyart', prompt: 'x', model: 'm' });
  assert.deepEqual([first.files, second.files], [[`${ART}/KeyArt/logo.png`], [`${ART}/KeyArt/logo-v2.png`]]);
  assert.deepEqual(second.sources, ['art/higgsfield/keyart/logo-v2.json']);
  assert.deepEqual(fs.readFileSync(path.join(dir, ...first.files[0].split('/'))), PNG);
  assert.deepEqual(fs.readFileSync(path.join(dir, ...second.files[0].split('/'))), OTHER);
  // No temp file is left behind by any write.
  const left = fs.readdirSync(path.join(dir, ...`${ART}/KeyArt`.split('/'))).concat(fs.readdirSync(path.join(dir, 'art', 'higgsfield', 'keyart')));
  assert.deepEqual(left.filter((f) => f.endsWith('.tmp')), []);
});

test('the Unity import follows the file: a GLB gets a prefab, an image of a model kind does not', async () => {
  const GLB = Buffer.concat([Buffer.from('glTF', 'latin1'), Buffer.alloc(16, 2)]);
  const glb = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(1), download: async () => GLB });
  const model = await glb.p.higgsfieldFinal({ name: 'Ronin', kind: 'concept', prompt: 'x', model: 'm' });
  assert.deepEqual(model.files, [`${ART}/Concepts/ronin.glb`]);
  assert.deepEqual(glb.unity.calls.map((c) => c.command), [REFRESH, MODEL_PREFAB]);
  // character is a model kind (it would get a prefab by kind alone), but a PNG is no model.
  assert.equal(P.KINDS.character.model, true);
  const png = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(1), download: async () => PNG });
  await png.p.higgsfieldFinal({ name: 'Ronin', kind: 'character', prompt: 'x', model: 'm' });
  assert.deepEqual(png.unity.calls.map((c) => c.command), [REFRESH]);
  const tex = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(1), download: async () => PNG });
  await tex.p.higgsfieldFinal({ name: 'Stone', kind: 'texture', prompt: 'x', model: 'm' });
  assert.deepEqual(tex.unity.calls.map((c) => [c.command, c.parameters.path || c.parameters.material]), [
    [REFRESH, 'Assets/Refresh'],
    ['asset create', `${ART}/Textures/stone.mat`],
    ['material set_properties', `${ART}/Textures/stone.mat`],
  ]);
});

test('a material that does not take the texture fails the import instead of leaving it untextured', async () => {
  // A built-in pipeline project: the Standard shader has no _BaseMap, so set_properties lists it as unknown.
  const calls = [];
  const unity = {
    exec: async (command, parameters) => {
      calls.push(command);
      return command === 'material set_properties' ? { shader: 'Standard', applied: [], unknown: ['_BaseMap'] } : { ok: true };
    },
  };
  const logged = [];
  const p = P.createAssetPipeline({ repoPath: tempRepo(), unity, higgsfield: fakeHiggsfield(1), download: async () => PNG, recordSpend: () => ({ ok: true }), logAsset: (e) => logged.push(e) });
  const res = await p.higgsfieldFinal({ name: 'Stone', kind: 'texture', prompt: 'x', model: 'm' });
  assert.equal(res.ok, true, 'the texture itself is made and kept');
  assert.deepEqual(calls, [REFRESH, ...MAKE_MATERIAL]);
  assert.match(res.note, /_BaseMap not applied/);
  assert.equal(logged[0].imported, false);
});

// ---- boundaries ---------------------------------------------------------------------------

test('a junction / symlink inside the repo pointing outside it is refused as a write target', async (t) => {
  const dir = tempRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-outside-'));
  try {
    fs.mkdirSync(path.join(dir, 'Assets', 'BladeBullet'), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'Assets', 'BladeBullet', 'Art'), 'junction');
  } catch {
    t.skip('cannot create a junction here');
    return;
  }
  const comfy = { run: async () => ({ promptId: 'p', images: [{ data: PNG }] }) };
  const { p } = pipeline(dir, { comfy });
  const res = await p.comfyDraft({ name: 'Leak', kind: 'concept', workflow: 'concept.json', seed: 1 });
  assert.deepEqual([res.ok, res.error], [false, 'writeFailed']);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an editor that is not open fails only the import; the file stays and the worker is told', async () => {
  const dir = tempRepo();
  const comfy = { run: async () => ({ promptId: 'p', images: [{ data: PNG }] }) };
  const unity = { exec: async () => { throw Object.assign(new Error('Unity editor not open on X'), { code: 'UNITY_PIPELINE_NOT_OPEN' }); } };
  const logged = [];
  const p = P.createAssetPipeline({ repoPath: dir, comfy, unity, recordSpend: () => ({ ok: true }), logAsset: (e) => logged.push(e) });
  const res = await p.comfyDraft({ name: 'Sky', kind: 'concept', workflow: 'concept.json', seed: 2 });
  assert.equal(res.ok, true);
  assert.match(res.note, /import it with your Unity MCP/);
  assert.equal(logged[0].imported, false);
  assert.match(P.assetReportLines(logged)[0], /not imported$/);
});

test('made assets land in run.assets through the guard and in the run report', async () => {
  const dir = tempRepo();
  const g = guardFor(10);
  const comfy = { run: async () => ({ promptId: 'p', images: [{ data: PNG }] }) };
  const { p } = pipeline(dir, {
    comfy,
    higgsfield: fakeHiggsfield(2),
    usdPerCredit: 0.5,
    download: async () => PNG,
    recordSpend: (x) => g.guard.recordSpend(x),
    logAsset: (e) => g.guard.recordAsset(e),
  });
  await p.comfyDraft({ name: 'Moon', kind: 'concept', prompt: 'pale moon', workflow: 'concept.json', seed: 3 });
  await p.higgsfieldFinal({ name: 'Moon Final', kind: 'concept', prompt: 'pale moon', model: 'gpt_image_2_6' });
  assert.equal(g.guard.recordAsset({ tool: 'evil', path: '/etc/passwd' }), false);
  const run = { id: 'r1', repoPath: dir, verdict: 'ship', laps: [], log: [], ...cleanGuardFields(g.run()) };
  assert.deepEqual(run.assets.map((a) => [a.tool, a.seed, a.costUsd]), [['comfyui', 3, 0], ['higgsfield', 99, 1]]);
  const Report = require('../src/lunasworkReport.js');
  const md = Report.buildRunReport(run, { now: 1 });
  assert.match(md, /## Generated assets\n\nPaid generation this run: \$1\.00\.\n\n- comfyui concept "Moon": Assets\/BladeBullet\/Art\/Concepts\/moon-draft-3\.png - prompt "pale moon", seed 3, cost \$0\n- higgsfield concept "Moon Final": .*seed 99, cost \$1\.00 \(2 credits\)/);
  assert.match(Report.renderRunReportHtml(run, { now: 1 }), /Generated assets/);
  assert.doesNotMatch(Report.buildRunReport({ ...run, assets: [] }, { now: 1 }), /Generated assets/);
});

test('the art root comes from settings only in the Assets/... shape', () => {
  assert.equal(P.artRootOf('Assets/Game/Art'), 'Assets/Game/Art');
  for (const bad of ['../x', 'C:/Assets', 'Assets/../x', 'Assets', 7]) assert.equal(P.artRootOf(bad), P.DEFAULT_ART_ROOT);
  assert.equal(P.slugOf('  Blade & Bullet: Hero!! '), 'blade-bullet-hero');
  assert.equal(P.cleanAssetEntry({ tool: 'rm', kind: 'prop', path: 'x' }), null);
  assert.equal(P.assetSpendUsd([{ tool: 'higgsfield', kind: 'concept', path: 'a', costUsd: 1.5 }, { tool: 'comfyui', kind: 'concept', path: 'b' }]), 1.5);
});

// ---- 5. Blender toon pass and the Critic's turntable sheet ------------------------------

const B = require('../src/lunasworkBlenderScript.js');

/** A PNG header (signature + IHDR) of the given size: enough for every check made on it. */
function pngOf(width, height) {
  const ihdr = Buffer.alloc(17);
  ihdr.write('IHDR', 0, 'latin1');
  ihdr.writeUInt32BE(width, 4);
  ihdr.writeUInt32BE(height, 8);
  return Buffer.concat([PNG.subarray(0, 8), Buffer.from([0, 0, 0, 13]), ihdr, Buffer.alloc(8)]);
}

/** The value of a `NAME = "..."` line of the generated Python. */
function pyString(code, name) {
  const line = code.split('\n').find((l) => l.startsWith(`${name} = "`));
  return line ? JSON.parse(line.slice(name.length + 3)) : null;
}

const panelPaths = (code) => JSON.parse(code.split('\n').find((l) => l.startsWith('PANEL_PATHS = [')).slice('PANEL_PATHS = '.length));

/**
 * Fake Blender add-on that also renders: writes the .blend, the FBX, a
 * left-over panel and the sheet the script names (`sheet` = the sheet's
 * bytes, null for none), and answers with `output` as its captured stdout.
 */
function renderingBlender({ sheet = pngOf(2048, 512), output = '' } = {}) {
  const base = fakeBlender();
  return {
    scripts: base.scripts,
    executeCode: async (code) => {
      await base.executeCode(code);
      // A panel left behind: the pipeline removes it.
      fs.writeFileSync(panelPaths(code)[0], PNG);
      if (sheet) fs.writeFileSync(pyString(code, 'SHEET_PATH'), sheet);
      return { executed: true, result: output };
    },
  };
}

function idx(code, needle) {
  const at = code.indexOf(needle);
  assert.ok(at >= 0, `missing: ${needle}`);
  return at;
}

const posixOf = (p) => p.split(path.sep).join('/');
const renderFor = (stem) => ({
  sheet: path.resolve(`/r/design/asset-renders/${stem}.png`),
  panels: B.TURNTABLE_VIEWS.map((v) => path.resolve(`/r/design/asset-renders/${stem}.${v}.tmp.png`)),
});

test('blenderExportScript: the two-argument call keeps the plain save + export script', () => {
  const code = B.blenderExportScript('/r/art/blender/a.blend', '/r/Assets/a.fbx');
  assert.equal(code, P.blenderExportScript('/r/art/blender/a.blend', '/r/Assets/a.fbx'));
  assert.doesNotMatch(code, /STYLE_PASS|DECIMATE|SOLIDIFY|render\.render|LUNACORE_REPORT/);
  assert.match(code, /^import bpy\nbpy\.ops\.wm\.save_as_mainfile\(filepath="\/r\/art\/blender\/a\.blend", copy=True\)/);
  assert.match(code, /axis_forward='-Z', axis_up='Y'/);
});

test('blenderExportScript: stylePass none vs. blade-bullet-toon', () => {
  const render = renderFor('a');
  const none = B.blenderExportScript('/r/a.blend', '/r/a.fbx', { kind: 'prop', stylePass: 'none', render });
  assert.match(none, /^STYLE_PASS = "none"$/m);
  // The helpers are defined, but no pass is called.
  assert.doesNotMatch(none, /^luna_step\(/m);
  assert.match(none, /^ {4}luna_turntable\(luna_meshes\(\)\)$/m);

  const toon = B.blenderExportScript('/r/a.blend', '/r/a.fbx', { kind: 'prop', stylePass: 'blade-bullet-toon', render });
  assert.match(toon, /^STYLE_PASS = "blade-bullet-toon"$/m);
  // (1) poly budget: triangles counted, Decimate added and applied when over budget.
  assert.match(toon, /^POLY_BUDGET = 15000$/m);
  assert.match(toon, /if total > POLY_BUDGET:\n\s+ratio = POLY_BUDGET \/ total/);
  assert.match(toon, /modifiers\.new\(name='LunaDecimate', type='DECIMATE'\)/);
  assert.match(toon, /mod\.ratio = ratio/);
  assert.match(toon, /bpy\.ops\.object\.modifier_apply\(modifier=mod\.name\)/);
  assert.match(toon, /len\(me\.loop_triangles\)/);
  // On a modifier stack the Decimate stays (the export applies it); a failed pass is a warning, never a lost FBX.
  assert.match(toon, /if any\(m != mod and m\.name != 'LunaOutline' for m in o\.modifiers\):/);
  assert.match(toon, /def luna_step\(label, fn, \*args\):\n {4}# [^\n]*\n {4}try:\n {8}fn\(\*args\)\n {4}except Exception as err:/);
  assert.match(toon, /LUNA_REPORT\['trisExported'\] = luna_tris\(objs\)/);
  // (2) inverted-hull outline: negative Solidify, flipped normals, offset to a black backface-culled material.
  assert.match(toon, /modifiers\.new\(name='LunaOutline', type='SOLIDIFY'\)/);
  assert.match(toon, /mod\.thickness = -OUTLINE_THICKNESS/);
  assert.match(toon, /^OUTLINE_THICKNESS = 0\.\d+$/m);
  assert.match(toon, /mod\.use_flip_normals = True/);
  assert.match(toon, /mod\.material_offset = names\.index\('LunaOutline'\)/);
  assert.match(toon, /mat\.diffuse_color = \(0\.0, 0\.0, 0\.0, 1\.0\)/);
  assert.match(toon, /mat\.use_backface_culling = True/);
  // (3) zeroed root, applied scale.
  assert.match(toon, /r\.location = \(0\.0, 0\.0, 0\.0\)/);
  assert.match(toon, /r\.rotation_euler = \(0\.0, 0\.0, 0\.0\)/);
  assert.match(toon, /transform_apply\(location=False, rotation=False, scale=True\)/);
  // Order: the .blend source is saved first, the passes and the render run before the FBX export.
  const saved = idx(toon, 'bpy.ops.wm.save_as_mainfile(');
  const decimate = idx(toon, "\nluna_step('poly budget', luna_decimate, luna_objs)");
  const outline = idx(toon, "\nluna_step('outline', luna_outline, luna_objs)");
  const rendered = idx(toon, '\n    luna_turntable(luna_meshes())');
  const exported = idx(toon, 'bpy.ops.export_scene.fbx(');
  assert.ok(saved < decimate && decimate < outline && outline < rendered && rendered < exported);
  assert.ok(idx(toon, 'print("LUNACORE_REPORT " + json.dumps(LUNA_REPORT))') > exported);
});

test('blenderExportScript: the poly budget follows the kind unless the call names one', () => {
  const budget = (opts) => Number(B.blenderExportScript('/r/a.blend', '/r/a.fbx', { stylePass: 'blade-bullet-toon', ...opts }).match(/^POLY_BUDGET = (\d+)$/m)[1]);
  assert.equal(B.PROP_POLY_BUDGET, 15000);
  assert.equal(B.CHARACTER_POLY_BUDGET, 25000);
  assert.equal(budget({ kind: 'prop' }), 15000);
  assert.equal(budget({ kind: 'character' }), 25000);
  assert.equal(budget({ kind: 'character', polyBudget: 8000 }), 8000);
  assert.equal(budget({ kind: 'prop', polyBudget: null }), 15000);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { stylePass: 'blade-bullet-toon', polyBudget: 1e12 }), /polyBudget/);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { stylePass: 'blade-bullet-toon', polyBudget: '1; import os' }), /polyBudget/);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { stylePass: 'os.system("x")' }), /stylePass/);
});

test('blenderExportScript: a character is measured against 1.6 m; the kind cannot carry Python', () => {
  const character = B.blenderExportScript('/r/a.blend', '/r/a.fbx', { kind: 'character', stylePass: 'blade-bullet-toon' });
  assert.match(character, /^KIND = "character"$/m);
  assert.match(character, /^CHARACTER_HEIGHT = 1\.6$/m);
  assert.match(character, /^if KIND == 'character':\n {4}luna_step\('height check', luna_height, luna_objs\)$/m);
  assert.match(character, /LUNA_REPORT\['heightOk'\] = abs\(height - CHARACTER_HEIGHT\) <= HEIGHT_TOLERANCE/);
  assert.match(character, /LUNA_REPORT\['height'\] = height/);
  assert.match(B.blenderExportScript('/r/a.blend', '/r/a.fbx', { kind: 'prop', stylePass: 'blade-bullet-toon' }), /^KIND = "prop"$/m);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { kind: 'prop"\nimport os', stylePass: 'blade-bullet-toon' }), /kind/);
});

test('blenderExportScript: the turntable render writes four Workbench panels into one PNG sheet', () => {
  const render = renderFor('a');
  const code = B.blenderExportScript('/r/a.blend', '/r/a.fbx', { kind: 'prop', render });
  assert.deepEqual(B.TURNTABLE_VIEWS, ['front', 'side', 'three-quarter', 'silhouette']);
  assert.equal(pyString(code, 'SHEET_PATH'), posixOf(render.sheet));
  assert.deepEqual(panelPaths(code), render.panels.map(posixOf));
  assert.match(code, /rs\.engine = 'BLENDER_WORKBENCH'/);
  assert.match(code, /\('ORTHO', Vector\(\(0\.0, -1\.0, 0\.0\)\), False\), \('ORTHO', Vector\(\(1\.0, 0\.0, 0\.0\)\), False\)/);
  assert.match(code, /\('PERSP', Vector\(\(1\.0, -1\.0, 0\.6\)\)\.normalized\(\), False\), \('ORTHO', Vector\(\(0\.0, -1\.0, 0\.0\)\), True\)/);
  // The silhouette panel: flat black on a gray world.
  assert.match(code, /sh\.light = 'FLAT' if silhouette else 'STUDIO'/);
  assert.match(code, /sh\.color_type = 'SINGLE' if silhouette else 'MATERIAL'/);
  assert.match(code, /world\.color = \(0\.5, 0\.5, 0\.5\)/);
  assert.match(code, /out\.filepath_raw = SHEET_PATH\n\s+out\.file_format = 'PNG'\n\s+out\.save\(\)/);
  // A failed render never stops the export.
  assert.match(code, /^except Exception as err:\n {4}LUNA_REPORT\['render'\] = 'failed'/m);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { render: { sheet: render.sheet, panels: render.panels.slice(1) } }), /panel paths/);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { render: { sheet: 'relative.png', panels: render.panels } }), /absolute/);
});

test('blenderExportScript: a path with quotes or a newline stays one Python string literal', () => {
  const evil = path.resolve('/r/x"\nimport os\nos.system("calc")\n#.blend');
  const code = B.blenderExportScript(evil, '/r/a.fbx', { stylePass: 'blade-bullet-toon' });
  assert.doesNotMatch(code, /^os\.system/m);
  const lit = code.match(/save_as_mainfile\(filepath=("(?:[^"\\]|\\.)*"), copy=True\)/)[1];
  assert.equal(JSON.parse(lit), posixOf(evil));
});

test('the generated Python parses (when a Python is on this machine)', (t) => {
  const { spawnSync } = require('child_process');
  const probe = spawnSync('python', ['-c', 'import ast'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('no python on PATH');
    return;
  }
  const render = renderFor('s');
  for (const opts of [undefined, { kind: 'character', stylePass: 'blade-bullet-toon', render }, { kind: 'prop', stylePass: 'none', render }]) {
    const code = B.blenderExportScript(path.resolve('/r/a.blend'), path.resolve('/r/a.fbx'), opts);
    const res = spawnSync('python', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: code, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  }
});

test('blenderModel: toon pass options reach the script; the turntable PNG is checked and returned', async () => {
  const dir = tempRepo();
  const report = { stylePass: 'blade-bullet-toon', polyBudget: 25000, trisBefore: 40000, trisAfter: 24990, decimateRatio: 0.625, roots: 1, rootZeroed: 'Ronin', outlined: 2, height: 1.82, heightTarget: 1.6, heightOk: false, render: 'ok', warnings: [] };
  const blender = renderingBlender({ output: `noise\nLUNACORE_REPORT ${JSON.stringify(report)}\nLUNACORE_EXPORT_OK\n` });
  const { p, logged } = pipeline(dir, { blender });
  const res = await p.blenderModel({ name: 'Ronin Hero', kind: 'character', stylePass: 'blade-bullet-toon' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const code = blender.scripts[0];
  assert.match(code, /^STYLE_PASS = "blade-bullet-toon"$/m);
  assert.match(code, /^POLY_BUDGET = 25000$/m);
  assert.match(code, /^KIND = "character"$/m);
  assert.equal(pyString(code, 'SHEET_PATH'), posixOf(path.join(dir, 'design', 'asset-renders', 'ronin-hero.png')));

  assert.deepEqual(res.renders, ['design/asset-renders/ronin-hero.png']);
  assert.deepEqual(res.sources, ['art/blender/ronin-hero.blend']);
  assert.equal(res.style.pass, 'blade-bullet-toon');
  assert.equal(res.style.polyBudget, 25000);
  assert.deepEqual([res.style.report.trisBefore, res.style.report.trisAfter, res.style.report.height, res.style.report.heightOk], [40000, 24990, 1.82, false]);
  assert.match(res.note, /1\.82 m tall, outside 1\.6 m/);
  assert.deepEqual(logged[0].sources, ['art/blender/ronin-hero.blend', 'design/asset-renders/ronin-hero.png']);
  // The panels never stay in the repo.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'design', 'asset-renders')), ['ronin-hero.png']);
});

test('blenderModel: the plain call still renders the sheet, without a toon pass; a custom budget reaches the script', async () => {
  const dir = tempRepo();
  const blender = renderingBlender();
  const { p } = pipeline(dir, { blender });
  const res = await p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.equal(res.ok, true);
  assert.match(blender.scripts[0], /^STYLE_PASS = "none"$/m);
  assert.deepEqual(res.renders, ['design/asset-renders/crate.png']);
  assert.deepEqual([res.style.pass, res.style.polyBudget, res.style.report], ['none', null, null]);
  assert.equal(res.note, null);

  const custom = renderingBlender();
  const res2 = await pipeline(dir, { blender: custom }).p.blenderModel({ name: 'Crate', kind: 'prop', stylePass: 'blade-bullet-toon', polyBudget: 3000 });
  assert.equal(res2.style.polyBudget, 3000);
  assert.match(custom.scripts[0], /^POLY_BUDGET = 3000$/m);
});

test('blenderModel: a missing or invalid render is a note, never a failed export', async () => {
  const missing = tempRepo();
  const a = await pipeline(missing, { blender: renderingBlender({ sheet: null }) }).p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.equal(a.ok, true);
  assert.deepEqual(a.renders, []);
  assert.match(a.note, /No turntable render for the style check \(design\/asset-renders\/crate\.png was not written\)/);
  assert.deepEqual(fs.readdirSync(path.join(missing, 'design', 'asset-renders')), []);

  const invalid = tempRepo();
  const b = await pipeline(invalid, { blender: renderingBlender({ sheet: Buffer.from('GIF89a not a png at all') }) }).p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.equal(b.ok, true);
  assert.deepEqual(b.renders, []);
  assert.match(b.note, /crate\.png is not a PNG image/);
  // The FBX is still exported and imported.
  assert.equal(b.prefab, `${ART}/Props/crate.prefab`);

  // An earlier sheet left in place is not taken for a new render.
  const stale = tempRepo();
  await pipeline(stale, { blender: renderingBlender() }).p.blenderModel({ name: 'Crate', kind: 'prop' });
  const c = await pipeline(stale, { blender: renderingBlender({ sheet: null }) }).p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.deepEqual(c.renders, []);
  assert.match(c.note, /the earlier file, not a new export/);
});

test('blenderModel: a bad stylePass or polyBudget is refused before Blender runs', async () => {
  const blender = renderingBlender();
  const { p } = pipeline(tempRepo(), { blender });
  assert.equal((await p.blenderModel({ name: 'Crate', kind: 'prop', stylePass: 'photoreal' })).error, 'badStylePass');
  assert.equal((await p.blenderModel({ name: 'Crate', kind: 'prop', polyBudget: 2.5 })).error, 'badPolyBudget');
  assert.equal(blender.scripts.length, 0);
});

test('the script report is validated; junk is null; the PNG header tells a turntable sheet', () => {
  assert.equal(B.parseScriptReport(null), null);
  assert.equal(B.parseScriptReport({ result: 'LUNACORE_REPORT {not json' }), null);
  assert.equal(B.parseScriptReport('LUNACORE_REPORT [1,2]'), null);
  const r = B.parseScriptReport('LUNACORE_REPORT {"trisBefore": -3, "height": "tall", "heightOk": "yes", "render": "rm -rf", "warnings": ["a\\tb", 5]}');
  assert.deepEqual([r.trisBefore, r.height, r.heightOk, r.render, r.warnings], [null, null, null, null, ['a b', '5']]);
  assert.deepEqual(B.reportNotes(null), []);
  // A scene object named like the mark (inside the JSON warnings) cannot hide the real report.
  const named = B.parseScriptReport('LUNACORE_REPORT {"heightOk": false, "height": 2.1, "warnings": ["scale not applied on x LUNACORE_REPORT {"]}\r\nLUNACORE_EXPORT_OK');
  assert.deepEqual([named.heightOk, named.height], [false, 2.1]);

  assert.equal(B.isTurntableSheet(pngOf(2048, 512)), true);
  assert.equal(B.isTurntableSheet(pngOf(1024, 1024)), false);
  // Only the sheet luna_asset_blender renders, not any 4:1 banner.
  assert.equal(B.isTurntableSheet(pngOf(4096, 1024)), false);
  assert.equal(B.isTurntableSheet(pngOf(0, 0)), false);
  assert.equal(B.isTurntableSheet(PNG.subarray(0, 8)), false);
  assert.equal(B.isTurntableSheet(Buffer.from('not a png at all, really not')), false);
});

// ---- the optional ffmpeg audio post-process on ComfyUI audio drafts ---------------------

const DRAFT_WAV = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(16, 1)]);
const NORMALIZED_WAV = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1'), Buffer.alloc(2048, 9)]);

/** A fake execFile for ffmpeg: 'ok' writes `bytes` to the last token, 'enoent' / 'fail' fail. */
function fakeFfmpeg(outcome, bytes) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    if (outcome === 'enoent') return setImmediate(() => cb(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }), '', ''));
    if (outcome === 'fail') return setImmediate(() => cb(Object.assign(new Error('Command failed'), { code: 1 }), '', 'Unknown encoder\n'));
    fs.writeFileSync(args[args.length - 1], bytes);
    return setImmediate(() => cb(null, '', ''));
  };
  return { fn, calls };
}

const audioComfy = () => ({ run: async () => ({ promptId: 'p-sfx', images: [{ data: DRAFT_WAV }] }) });
const draftDir = (dir) => path.join(dir, 'Assets', 'BladeBullet', 'Art', 'Audio');

test('ComfyUI audio draft with audioPost: ffmpeg argument array, no shell, normalized file replaces the draft before import', async () => {
  const dir = tempRepo();
  const ffmpeg = fakeFfmpeg('ok', NORMALIZED_WAV);
  const { p, unity } = pipeline(dir, { comfy: audioComfy(), execFile: ffmpeg.fn });
  const res = await p.comfyDraft({ name: 'Hit Stop', kind: 'audio', prompt: 'sharp clang', workflow: 'concept.json', seed: 3, audioPost: { targetBpm: 60, bpm: 240 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  const rel = `${ART}/Audio/hit-stop-draft-3.wav`;
  assert.deepEqual(res.files, [rel]);
  const target = path.join(dir, ...rel.split('/'));
  assert.equal(ffmpeg.calls.length, 1);
  const { cmd, args, opts } = ffmpeg.calls[0];
  assert.equal(cmd, 'ffmpeg');
  assert.equal(opts.shell, undefined);
  const out = args[args.length - 1];
  assert.equal(path.dirname(out), path.dirname(target));
  assert.deepEqual(args, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-protocol_whitelist', 'file', '-i', target, '-vn',
    '-af', 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB,atempo=0.5,atempo=0.5,loudnorm=I=-14:TP=-1.5:LRA=11',
    '-ar', '48000', out,
  ]);
  assert.deepEqual(fs.readFileSync(target), NORMALIZED_WAV);
  assert.deepEqual(fs.readdirSync(draftDir(dir)).filter((n) => n.includes('.tmp')), []);
  assert.match(res.note, /Audio post-process .* applied to/);
  assert.deepEqual(unity.calls.map((c) => c.command), [REFRESH]);
});

test('ComfyUI audio draft with audioPost: ENOENT and a failed run keep the draft bytes and add a note', async () => {
  for (const [outcome, why] of [['enoent', /ffmpeg was not found on PATH/], ['fail', /ffmpeg failed \(Unknown encoder\)/]]) {
    const dir = tempRepo();
    const { p } = pipeline(dir, { comfy: audioComfy(), execFile: fakeFfmpeg(outcome).fn });
    const res = await p.comfyDraft({ name: 'Tick', kind: 'audio', prompt: 'clock tick', workflow: 'concept.json', seed: 4, audioPost: { trim: true, loudnorm: true } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(fs.readFileSync(path.join(dir, ...res.files[0].split('/'))), DRAFT_WAV, outcome);
    assert.match(res.note, why);
    assert.match(res.note, /the original audio was kept/);
    assert.deepEqual(fs.readdirSync(draftDir(dir)).filter((n) => n.includes('.tmp')), [], outcome);
  }
});

test('ComfyUI audioPost is validated before ComfyUI runs: bad BPM or a non-audio kind is refused', async () => {
  const dir = tempRepo();
  let runs = 0;
  const ffmpeg = fakeFfmpeg('ok', NORMALIZED_WAV);
  const comfy = { run: async () => { runs += 1; return { promptId: 'p', images: [{ data: DRAFT_WAV }] }; } };
  const { p } = pipeline(dir, { comfy, execFile: ffmpeg.fn });
  for (const audioPost of [{ targetBpm: 500, bpm: 120 }, { targetBpm: 120 }, { targetBpm: -Infinity, bpm: 90 }, { bpm: 'x', targetBpm: 90 }]) {
    const res = await p.comfyDraft({ name: 'Loop', kind: 'audio', workflow: 'concept.json', seed: 1, audioPost });
    assert.equal(res.error, 'badAudioPost', JSON.stringify(audioPost));
  }
  const image = await p.comfyDraft({ name: 'Card', kind: 'concept', workflow: 'concept.json', seed: 1, audioPost: { trim: true } });
  assert.equal(image.error, 'badAudioPost');
  assert.equal(runs, 0);
  assert.equal(ffmpeg.calls.length, 0);
});
