// ============================================================================
// luna_asset_higgsfield on the 3D path (src/lunasworkAssetHiggsfield.js,
// src/lunasworkHiggsfieldRefs.js, wired in src/lunasworkAssetPipeline.js and
// src/lunasworkAssetTools.js):
//   forBlender  a result bound for luna_asset_blender `from` is saved,
//               recorded, ledgered and logged with no Unity call
//   images      1-4 repo reference images, checked, uploaded through the CLI
//               and passed as a repeated --image; the cost is still booked
//               before the paid generate
// Every tool is a fake; the CLI is a fake execFile. The repo is a temp dir.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/lunasworkAssetPipeline.js');
const R = require('../src/lunasworkHiggsfieldRefs.js');
const T = require('../src/lunasworkAssetTools.js');
const C = require('../src/lunasworkAssetCasting.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);
const GLB = Buffer.concat([Buffer.from('glTF', 'latin1'), Buffer.alloc(16, 2)]);
const ART = 'Assets/BladeBullet/Art';
const UPLOAD_A = '0b6c2f1e-1111-4a2b-9c3d-000000000001';
const UPLOAD_B = '0b6c2f1e-1111-4a2b-9c3d-000000000002';

const temps = [];
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-hf-'));
  temps.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of temps) await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function put(dir, rel, data) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/** Fake Higgsfield adapter: every call in order, the upload ids handed out in turn. */
function fakeHiggsfield({ credits = 2, result = 'https://cdn.example.test/out.png', ids = [UPLOAD_A, UPLOAD_B] } = {}) {
  const calls = [];
  const queue = [...ids];
  return {
    calls,
    upload: async (file) => { calls.push(['upload', file.name, file.data]); return { id: queue.shift() }; },
    estimate: async (req) => { calls.push(['estimate', req]); return { credits }; },
    generate: async (req) => { calls.push(['generate', req]); return { jobId: 'job_3d', urls: [result], seed: 7 }; },
  };
}

function pipeline(dir, extra = {}) {
  const logged = [];
  const spends = [];
  const unity = { calls: [], exec: async (command, parameters) => { unity.calls.push({ command, parameters }); return { ok: true }; } };
  const p = P.createAssetPipeline({
    repoPath: dir, unity, now: () => 42,
    recordSpend: (x) => { spends.push(x); return { ok: true, reason: null }; },
    logAsset: (e) => logged.push(e),
    download: async () => PNG,
    ...extra,
  });
  return { p, logged, unity, spends };
}

const ledgerOf = (dir) => fs.readFileSync(path.join(dir, 'design', 'ASSET_LICENSES.md'), 'utf8');

// ---- forBlender: no direct Unity import --------------------------------------------------

test('forBlender: true saves, records, ledgers and logs the result but makes no Unity call', async () => {
  const dir = tempRepo();
  const { p, logged, unity, spends } = pipeline(dir, { higgsfield: fakeHiggsfield() });
  const res = await p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'toon crate texture', model: 'gpt_image_2_6', forBlender: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Props/crate.png`]);
  assert.deepEqual(res.forBlender, [`${ART}/Props/crate.png`]);
  assert.deepEqual(unity.calls, [], 'no import, no prefab, no material');
  assert.deepEqual(res.unity, []);
  assert.equal(spends.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'higgsfield', 'prop', 'crate.json'), 'utf8'));
  assert.deepEqual([record.status, record.outputs], ['saved', [`${ART}/Props/crate.png`]]);
  assert.match(ledgerOf(dir), /\| Crate \| art\/higgsfield\/prop\/crate\.json \| LunaCore asset worker \(Higgsfield\) \| Own work \(generated\) \| Assets\/BladeBullet\/Art\/Props\/crate\.png \|/);
  assert.deepEqual(logged.map((e) => [e.tool, e.path, e.sources, e.imported, e.costUsd]), [['higgsfield', `${ART}/Props/crate.png`, ['art/higgsfield/prop/crate.json'], false, 0.2]]);
  assert.match(res.note, /Not imported into Unity .*luna_asset_blender \{name: "Crate", kind: "prop", from: "Assets\/BladeBullet\/Art\/Props\/crate\.png"\}/);
});

test('a GLB of a 3D model kind skips the Unity import without forBlender; forBlender false imports it', async () => {
  const auto = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(), download: async () => GLB });
  const res = await auto.p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'toon crate', model: 'multi_image_to_3d' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.forBlender, [`${ART}/Props/crate.glb`]);
  assert.deepEqual(auto.unity.calls, []);

  const forced = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(), download: async () => GLB });
  const imp = await forced.p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'toon crate', model: 'multi_image_to_3d', forBlender: false });
  assert.equal(imp.forBlender, undefined);
  assert.deepEqual(forced.unity.calls.map((c) => c.command), ['assets import', 'prefab create']);
  assert.equal(forced.logged[0].imported, true);
});

test('other results keep the normal import: a texture gets its material, a model-kind image is imported, a non-model GLB gets its prefab', async () => {
  const tex = pipeline(tempRepo(), { higgsfield: fakeHiggsfield() });
  const t = await tex.p.higgsfieldFinal({ name: 'Stone', kind: 'texture', prompt: 'x', model: 'm' });
  assert.equal(t.forBlender, undefined);
  assert.deepEqual(tex.unity.calls.map((c) => c.command), ['assets import', 'material create']);
  const img = pipeline(tempRepo(), { higgsfield: fakeHiggsfield() });
  await img.p.higgsfieldFinal({ name: 'Ronin', kind: 'character', prompt: 'x', model: 'm' });
  assert.deepEqual(img.unity.calls.map((c) => c.command), ['assets import']);
  const concept = pipeline(tempRepo(), { higgsfield: fakeHiggsfield(), download: async () => GLB });
  await concept.p.higgsfieldFinal({ name: 'Ronin', kind: 'concept', prompt: 'x', model: 'm' });
  assert.deepEqual(concept.unity.calls.map((c) => c.command), ['assets import', 'prefab create']);
});

test('forBlender on a texture kind names a placeholder 3D kind; a non-boolean forBlender is refused before any call', async () => {
  const { p, unity } = pipeline(tempRepo(), { higgsfield: fakeHiggsfield() });
  const res = await p.higgsfieldFinal({ name: 'Stone', kind: 'texture', prompt: 'x', model: 'm', forBlender: true });
  assert.deepEqual(unity.calls, []);
  assert.match(res.note, /kind: "<the 3D model kind>"/);

  const higgsfield = fakeHiggsfield();
  const bad = pipeline(tempRepo(), { higgsfield });
  const refused = await bad.p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'x', model: 'm', forBlender: 'yes' });
  assert.equal(refused.error, 'badForBlender');
  assert.deepEqual([higgsfield.calls, bad.spends], [[], []]);
});

test('a forBlender result in an asset-prep worktree (no Unity editor) is not reported as a deferred import', async () => {
  const dir = tempRepo();
  const p = P.createAssetPipeline({ repoPath: dir, recordSpend: () => ({ ok: true, reason: null }), higgsfield: fakeHiggsfield(), download: async () => GLB });
  const tools = { higgsfieldFinal: (a) => p.higgsfieldFinal(a) };
  const out = await T.callAssetTool(T.HIGGSFIELD_TOOL, { name: 'Crate', kind: 'prop', prompt: 'x', model: 'multi_image_to_3d' }, tools);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.payload.unityDeferred, undefined);
  assert.match(out.payload.note, /luna_asset_blender/);
});

test('the briefs tell the worker to use forBlender and multi_image_to_3d for a 3D asset', () => {
  const brief = P.unityAssetBrief({ kind: 'prop', slug: 'crate', source: 'higgsfield' }).join('\n');
  assert.match(brief, /luna_asset_higgsfield \{\.\.\., forBlender: true\}/);
  assert.match(brief, /multi_image_to_3d with images: 1-4 repo reference views/);
  assert.match(brief, /luna_asset_blender \{name, kind: "prop", from: "<the saved Higgsfield file>"\}/);
  assert.match(brief, /except a luna_asset_higgsfield result bound for luna_asset_blender \(forBlender\)/);
  const cast = C.renderCastingBrief({ primary: { source: 'higgsfield', higgsfieldModel: 'multi_image_to_3d' }, fallbacks: [], candidates: 2, reason: 'r' }).join('\n');
  assert.match(cast, /call it with forBlender: true - a mesh from multi_image_to_3d takes images: 1-4 repo reference views/);
  const schema = T.ASSET_TOOLS.find((t) => t.name === T.HIGGSFIELD_TOOL);
  assert.match(schema.description, /set forBlender: true: the result is saved, recorded and ledgered but NOT imported into Unity/);
  assert.equal(schema.inputSchema.properties.forBlender.type, 'boolean');
  assert.deepEqual([schema.inputSchema.properties.images.minItems, schema.inputSchema.properties.images.maxItems], [1, 4]);
});

// ---- reference images --------------------------------------------------------------------

test('reference images: checked, uploaded in order, then estimate (booked) and generate with a repeated --image id', async () => {
  const dir = tempRepo();
  put(dir, 'art/refs/crate-front.png', PNG);
  put(dir, `${ART}/Concepts/crate-side.jpg`, JPG);
  const higgsfield = fakeHiggsfield({ result: 'https://cdn.example.test/crate.glb' });
  const order = [];
  const { p, spends, unity } = pipeline(dir, {
    higgsfield: { ...higgsfield, estimate: async (r) => { order.push('estimate'); return higgsfield.estimate(r); }, upload: async (f) => { order.push('upload'); return higgsfield.upload(f); }, generate: async (r) => { order.push('generate'); return higgsfield.generate(r); } },
    recordSpend: (x) => { order.push('book'); spends.push(x); return { ok: true, reason: null }; },
    download: async () => GLB,
  });
  const images = ['art/refs/crate-front.png', `${ART}/Concepts/crate-side.jpg`];
  const res = await p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'toon crate', model: 'multi_image_to_3d', images, params: { should_texture: 'true' } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(order, ['upload', 'upload', 'estimate', 'book', 'generate']);
  // The CLI gets the checked bytes under a fixed name, never a repo path.
  assert.deepEqual(higgsfield.calls.filter((c) => c[0] === 'upload').map((c) => [c[1], c[2]]), [['reference-1.png', PNG], ['reference-2.jpg', JPG]]);
  const want = { model: 'multi_image_to_3d', prompt: 'toon crate', params: { should_texture: 'true' }, images: [UPLOAD_A, UPLOAD_B] };
  assert.deepEqual(higgsfield.calls.find((c) => c[0] === 'estimate')[1], want);
  assert.deepEqual(higgsfield.calls.find((c) => c[0] === 'generate')[1], want);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'art', 'higgsfield', 'prop', 'crate.json'), 'utf8'));
  assert.deepEqual(record.references, images);
  assert.deepEqual(res.files, [`${ART}/Props/crate.glb`]);
  assert.deepEqual(unity.calls, []);
});

test('reference images that are unsafe or wrong are refused before any upload, estimate or booking', async () => {
  const dir = tempRepo();
  put(dir, 'art/refs/ok.png', PNG);
  put(dir, 'art/refs/fake.png', JPG);
  put(dir, 'design/secret.png', PNG);
  put(dir, 'art/refs/notes.txt', 'x');
  const outside = put(tempRepo(), 'x.png', PNG);
  const cases = [
    [['art/refs/../../design/secret.png'], /no "\.\."/],
    [['design/secret.png'], /must be under art\/ or Assets\/BladeBullet\/Art\//],
    [[outside], /plain repo-relative path/],
    [[outside.split(path.sep).join('/')], /plain repo-relative path/],
    [['art\\refs\\ok.png'], /forward slashes/],
    [['./art/refs/ok.png'], /plain repo-relative path/],
    [['-art/refs/ok.png'], /plain repo-relative path/],
    [['art/refs/notes.txt'], /png \/ jpg \/ jpeg \/ webp file/],
    [['art/refs/ok.png', 'art/refs/ok.png'], /listed twice/],
    [['art/refs/ok.png', 'art/refs/ok.png', 'art/refs/ok.png', 'art/refs/ok.png', 'art/refs/ok.png'], /1-4 repo image paths/],
    [[], /1-4 repo image paths/],
    ['art/refs/ok.png', /1-4 repo image paths/],
    [[42], /repo-relative path/],
    [['art/refs/fake.png'], /refused: art\/refs\/fake\.png: it is not a PNG image/],
    [['art/refs/missing.png'], /no such file/],
  ];
  for (const [images, why] of cases) {
    const higgsfield = fakeHiggsfield();
    const { p, spends } = pipeline(dir, { higgsfield });
    const res = await p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'x', model: 'multi_image_to_3d', images });
    assert.equal(res.ok, false, `${JSON.stringify(images)} was accepted`);
    assert.equal(res.error, 'badImages', JSON.stringify(res));
    assert.match(res.detail, why, JSON.stringify(images));
    assert.deepEqual([higgsfield.calls, spends], [[], []], `${JSON.stringify(images)} reached the CLI or the budget`);
  }
});

test('a reference image through a junction is refused before the upload', async (t) => {
  const dir = tempRepo();
  const outside = tempRepo();
  put(outside, 'x.png', PNG);
  fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(dir, 'art', 'out'), 'junction');
  } catch (err) {
    if (err && ['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) {
      t.skip('junctions are not permitted on this machine');
      return;
    }
    throw err;
  }
  const higgsfield = fakeHiggsfield();
  const { p } = pipeline(dir, { higgsfield });
  const res = await p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'x', model: 'multi_image_to_3d', images: ['art/out/x.png'] });
  assert.equal(res.error, 'badImages', JSON.stringify(res));
  assert.match(res.detail, /outside the project repo|junction or link/);
  assert.deepEqual(higgsfield.calls, []);
});

test('a failed or id-less upload fails the call with nothing booked; an adapter without upload is toolDown', async () => {
  const dir = tempRepo();
  put(dir, 'art/refs/ok.png', PNG);
  const args = { name: 'Crate', kind: 'prop', prompt: 'x', model: 'multi_image_to_3d', images: ['art/refs/ok.png'] };
  const broken = fakeHiggsfield();
  broken.upload = async () => { throw new Error('higgsfield upload failed: No workspace selected.'); };
  const a = pipeline(dir, { higgsfield: broken });
  const res = await a.p.higgsfieldFinal(args);
  assert.equal(res.error, 'higgsfieldFailed');
  assert.match(res.detail, /reference upload of art\/refs\/ok\.png failed \(nothing was booked\): higgsfield upload failed: No workspace selected/);
  assert.deepEqual([broken.calls, a.spends], [[], []]);

  const noId = fakeHiggsfield({ ids: ['--output'] });
  const b = pipeline(dir, { higgsfield: noId });
  assert.match((await b.p.higgsfieldFinal(args)).detail, /no usable upload id/);
  assert.equal(noId.calls.some((c) => c[0] === 'estimate'), false);

  const old = fakeHiggsfield();
  delete old.upload;
  const c = pipeline(dir, { higgsfield: old });
  assert.equal((await c.p.higgsfieldFinal(args)).error, 'toolDown');
  // Without images the same adapter works as before.
  assert.equal((await c.p.higgsfieldFinal({ ...args, images: undefined, forBlender: true })).ok, true);
});

test('a second upload that fails after a first success books nothing; a cap or a judge pass stops before any upload', async () => {
  const dir = tempRepo();
  put(dir, 'art/refs/a.png', PNG);
  put(dir, 'art/refs/b.png', PNG);
  const args = { name: 'Crate', kind: 'prop', prompt: 'x', model: 'multi_image_to_3d', images: ['art/refs/a.png', 'art/refs/b.png'] };
  const second = fakeHiggsfield();
  let n = 0;
  const first = second.upload;
  second.upload = async (f) => { n += 1; if (n === 2) throw new Error('network down'); return first(f); };
  const a = pipeline(dir, { higgsfield: second });
  const res = await a.p.higgsfieldFinal(args);
  assert.match(res.detail, /reference upload of art\/refs\/b\.png failed \(nothing was booked\)/);
  assert.deepEqual([second.calls.map((c) => c[0]), a.spends], [['upload'], []]);

  for (const extra of [{ cappedTools: () => ['higgsfield'] }, { freeCandidatePassed: () => true }]) {
    const h = fakeHiggsfield();
    const b = pipeline(dir, { higgsfield: h, ...extra });
    const out = await b.p.higgsfieldFinal(args);
    assert.ok(['capReached', 'freeCandidatePassed'].includes(out.error), JSON.stringify(out));
    assert.deepEqual([h.calls, b.spends], [[], []]);
  }
});

test('a refused booking stops later calls of the same pipeline before any upload or estimate', async () => {
  const dir = tempRepo();
  put(dir, 'art/refs/a.png', PNG);
  const h = fakeHiggsfield();
  const { p } = pipeline(dir, { higgsfield: h, recordSpend: () => ({ ok: false, reason: 'capReached' }) });
  const args = { name: 'Crate', kind: 'prop', prompt: 'x', model: 'multi_image_to_3d', images: ['art/refs/a.png'] };
  assert.equal((await p.higgsfieldFinal(args)).error, 'capReached');
  const before = h.calls.length;
  assert.equal((await p.higgsfieldFinal(args)).error, 'capReached');
  assert.equal(h.calls.length, before, 'no upload, no estimate after the refusal');
});

test('a set of results: only the GLBs of a 3D kind go to Blender, the images are imported, the note names only the GLBs', async () => {
  const urls = ['https://cdn.example.test/a.glb', 'https://cdn.example.test/b.png'];
  const h = { estimate: async () => ({ credits: 1 }), generate: async () => ({ jobId: 'j', urls }) };
  const { p, unity, logged } = pipeline(tempRepo(), { higgsfield: h, download: async (u) => (u.endsWith('.glb') ? GLB : PNG) });
  const res = await p.higgsfieldFinal({ name: 'Crate', kind: 'prop', prompt: 'x', model: 'm' });
  assert.deepEqual(res.files, [`${ART}/Props/crate-1.glb`, `${ART}/Props/crate-2.png`]);
  assert.deepEqual(res.forBlender, [`${ART}/Props/crate-1.glb`]);
  assert.deepEqual(unity.calls.map((c) => [c.command, c.parameters.path]), [['assets import', `${ART}/Props/crate-2.png`]]);
  assert.match(res.note, /from: "Assets\/BladeBullet\/Art\/Props\/crate-1\.glb"/);
  assert.doesNotMatch(res.note, /crate-2\.png"/);
  assert.deepEqual(logged.map((e) => e.imported), [false, true]);
  // Each logged result carries the sha256 of the bytes saved (luna_asset_blender's provenance check).
  assert.ok(logged.every((e) => /^[0-9a-f]{64}$/.test(e.sha256)));
});

test('reference images never travel as params', () => {
  for (const key of ['image', 'images', 'image_references', 'start_image', 'end_image', 'video', 'audio']) {
    assert.equal(P.cleanParams({ [key]: 'abc' }), null, key);
  }
  assert.deepEqual(P.cleanParams({ should_texture: 'true' }), { should_texture: 'true' });
});

test('uploadIdOf: the id of the usual answer shapes, nothing that is not a plain token', () => {
  assert.equal(R.uploadIdOf({ id: UPLOAD_A }), UPLOAD_A);
  assert.equal(R.uploadIdOf({ upload_id: UPLOAD_A, url: 'https://x' }), UPLOAD_A);
  assert.equal(R.uploadIdOf({ data: { id: UPLOAD_A } }), UPLOAD_A);
  assert.equal(R.uploadIdOf([{ media_id: UPLOAD_A }]), UPLOAD_A);
  assert.equal(R.uploadIdOf(UPLOAD_A), UPLOAD_A);
  for (const bad of [{ id: '--output' }, { id: 'a b c d e f g h' }, { id: 'short' }, [{ id: UPLOAD_A }, { id: UPLOAD_B }], null, 7, { nothing: true }]) {
    assert.equal(R.uploadIdOf(bad), null, JSON.stringify(bad));
  }
});

// ---- the CLI adapter ---------------------------------------------------------------------

/** A fake execFile: argv / options / stdin per call, an answer per sub-command. */
function fakeExec(answers) {
  const calls = [];
  const execFile = (bin, args, opts, cb) => {
    const call = { bin, args, opts, stdin: '' };
    calls.push(call);
    const stdin = new EventEmitter();
    stdin.end = (data) => { call.stdin = String(data); };
    setImmediate(() => {
      const a = answers[args[0] === 'upload' ? 'upload' : args[1]];
      if (a instanceof Error) cb(a, '', a.message);
      else cb(null, JSON.stringify(a), '');
    });
    return { stdin };
  };
  return { execFile, calls };
}

test('Higgsfield CLI: the checked bytes are uploaded from a fresh private folder that is removed after; cost and create get a repeated --image', async () => {
  const tmpDir = tempRepo();
  const seen = [];
  const fake = fakeExec({ upload: { id: UPLOAD_A }, cost: { credits: 5 }, create: [{ id: 'job_3d', status: 'completed', results: [{ raw_url: 'https://cdn.example.test/m.glb' }] }] });
  const execFile = (bin, args, opts, cb) => {
    // What the CLI would find in its working folder at the moment it runs.
    if (args[0] === 'upload') seen.push({ cwd: opts.cwd, files: fs.readdirSync(opts.cwd), data: fs.readFileSync(path.join(opts.cwd, args[2])) });
    return fake.execFile(bin, args, opts, cb);
  };
  const cli = T.createHiggsfieldCli({ execFile, platform: 'win32', tmpDir, env: { PATH: 'x', nodefaultcurrentdirectoryinexepath: '' } });
  assert.deepEqual(await cli.upload({ name: 'reference-1.png', data: PNG }), { id: UPLOAD_A });
  assert.deepEqual(fake.calls[0].args, ['upload', 'create', 'reference-1.png', '--json']);
  assert.equal(path.dirname(seen[0].cwd), tmpDir);
  assert.match(path.basename(seen[0].cwd), /^luna-hf-ref-/);
  assert.deepEqual(seen[0].files, ['reference-1.png'], 'nothing in the folder but the checked image');
  assert.deepEqual(seen[0].data, PNG);
  assert.equal(fs.existsSync(seen[0].cwd), false, 'the private folder is removed after the upload');
  // cmd.exe never runs a higgsfield found in the working folder; another spelling of the key cannot override it.
  assert.equal(fake.calls[0].opts.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.equal(fake.calls[0].opts.env.nodefaultcurrentdirectoryinexepath, undefined);
  assert.equal(fake.calls[0].opts.env.PATH, 'x');
  const req = { model: 'multi_image_to_3d', prompt: 'toon crate', params: { should_texture: 'true' }, images: [UPLOAD_A, UPLOAD_B] };
  assert.deepEqual(await cli.estimate(req), { credits: 5 });
  await cli.generate(req);
  assert.deepEqual(fake.calls[1].args, ['generate', 'cost', 'multi_image_to_3d', '--should_texture', 'true', '--image', UPLOAD_A, '--image', UPLOAD_B, '--json']);
  assert.deepEqual(fake.calls[2].args, ['generate', 'create', 'multi_image_to_3d', '--should_texture', 'true', '--image', UPLOAD_A, '--image', UPLOAD_B, '--wait', '--wait-timeout', '20m', '--json']);
  assert.equal(fake.calls[1].opts.cwd, undefined);
  assert.equal(fake.calls[1].opts.env.NoDefaultCurrentDirectoryInExePath, '1');
});

test('Higgsfield CLI: an unsafe upload name, missing bytes or an unsafe image id never reaches the CLI', async () => {
  const tmpDir = tempRepo();
  const fake = fakeExec({ upload: { id: UPLOAD_A }, cost: { credits: 1 } });
  const cli = T.createHiggsfieldCli({ execFile: fake.execFile, platform: 'win32', tmpDir });
  for (const name of ['../x.png', 'art/x.png', '-h', 'reference-1.png & calc', 'reference-1.gif', 'x.png', 'reference-0.png', '', 42]) {
    await assert.rejects(cli.upload({ name, data: PNG }), /not a plain reference name/, String(name));
  }
  for (const data of [undefined, 'text', Buffer.alloc(0), Buffer.alloc(30 * 1024 * 1024 + 1)]) {
    await assert.rejects(cli.upload({ name: 'reference-1.png', data }), /no image bytes/);
  }
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'no folder was made for a refused upload');
  const req = { model: 'm', prompt: 'p', params: {} };
  await assert.rejects(cli.estimate({ ...req, images: ['--output'] }), /reference image id is not a plain token/);
  await assert.rejects(cli.estimate({ ...req, images: ['a & calc'] }), /reference image id is not a plain token/);
  await assert.rejects(cli.estimate({ ...req, images: [UPLOAD_A, UPLOAD_A, UPLOAD_A, UPLOAD_A, UPLOAD_A] }), /reference image id/);
  assert.equal(fake.calls.length, 0);
  // A failed or id-less upload still removes its private folder.
  const failing = T.createHiggsfieldCli({ execFile: fakeExec({ upload: new Error('No workspace selected.') }).execFile, tmpDir });
  await assert.rejects(failing.upload({ name: 'reference-1.png', data: PNG }), /higgsfield upload failed: No workspace selected\./);
  const noId = T.createHiggsfieldCli({ execFile: fakeExec({ upload: { url: 'https://x' } }).execFile, tmpDir });
  await assert.rejects(noId.upload({ name: 'reference-1.png', data: PNG }), /answered no upload id/);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});
