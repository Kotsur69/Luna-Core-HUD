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

/** Fake Unity Pipeline client: records every command. */
function fakeUnity() {
  const calls = [];
  return { calls, exec: async (command, parameters) => { calls.push({ command, parameters }); return { ok: true }; } };
}

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
  assert.deepEqual(unity.calls.map((c) => c.command), ['assets import', 'prefab create']);
  assert.deepEqual(unity.calls[1].parameters, { source: `${ART}/Characters/ronin-hero.fbx`, path: `${ART}/Characters/ronin-hero.prefab` });
  assert.equal(res.prefab, `${ART}/Characters/ronin-hero.prefab`);
  assert.equal(logged.length, 1);
  assert.deepEqual([logged[0].tool, logged[0].path, logged[0].costUsd, logged[0].seed, logged[0].imported], ['blender', `${ART}/Characters/ronin-hero.fbx`, 0, null, true]);
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
  assert.deepEqual(unity.calls.map((c) => [c.command, c.parameters.path]), [['assets import', out]]);
  assert.deepEqual([logged[0].tool, logged[0].seed, logged[0].costUsd, logged[0].path], ['comfyui', 777, 0, out]);
});

test('a ComfyUI draft without a seed gets a fresh one; a texture also gets a material', async () => {
  const dir = tempRepo();
  const comfy = { run: async () => ({ promptId: 'p1', images: [{ data: PNG }] }) };
  const { p, unity } = pipeline(dir, { comfy, randomSeed: () => 5 });
  const res = await p.comfyDraft({ name: 'Floor', kind: 'texture', prompt: 'stone', workflow: 'art/comfyui/concept.json' });
  assert.equal(res.seed, 5);
  assert.deepEqual(unity.calls.map((c) => c.command), ['assets import', 'material create']);
  assert.equal(unity.calls[1].parameters.path, `${ART}/Textures/floor-draft-5.mat`);
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
  assert.deepEqual(unity.calls.map((c) => c.command), ['assets import']);
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
  assert.deepEqual(glb.unity.calls.map((c) => c.command), ['assets import', 'prefab create']);
  // character is a model kind (it would get a prefab by kind alone), but a PNG is no model.
  assert.equal(P.KINDS.character.model, true);
  const png = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(1), download: async () => PNG });
  await png.p.higgsfieldFinal({ name: 'Ronin', kind: 'character', prompt: 'x', model: 'm' });
  assert.deepEqual(png.unity.calls.map((c) => c.command), ['assets import']);
  const tex = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(1), download: async () => PNG });
  await tex.p.higgsfieldFinal({ name: 'Stone', kind: 'texture', prompt: 'x', model: 'm' });
  assert.deepEqual(tex.unity.calls.map((c) => [c.command, c.parameters.path]), [['assets import', `${ART}/Textures/stone.png`], ['material create', `${ART}/Textures/stone.mat`]]);
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
