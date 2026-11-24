// ============================================================================
// luna_asset_blender `from` (src/lunasworkBlenderFrom.js, wired in
// src/lunasworkAssetBlender.js): a saved Higgsfield texture or GLB goes
// through the Blender toon pass instead of straight into Unity. The Blender
// add-on is a fake that writes the files the script names; the generated
// Python is inspected as text (real Blender runs belong to the card "Run the
// Blender toon pass in a real Blender install"). The repo is a temp dir.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = require('../src/lunasworkAssetPipeline.js');
const B = require('../src/lunasworkBlenderScript.js');
const F = require('../src/lunasworkBlenderFrom.js');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 2)]);
const FBX = Buffer.concat([Buffer.from('Kaydara FBX Binary  \0', 'latin1'), Buffer.alloc(16)]);
const BLEND = Buffer.concat([Buffer.from('BLENDER-v400', 'latin1'), Buffer.alloc(16)]);
const ART = 'Assets/BladeBullet/Art';

/** A minimal GLB: header + one JSON chunk (padded to 4 bytes). */
function glbOf(json) {
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const chunk = Buffer.alloc(8);
  chunk.writeUInt32LE(text.length, 0);
  chunk.write('JSON', 4, 'latin1');
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + text.length, 8);
  return Buffer.concat([head, chunk, text]);
}

const GLB = glbOf({ asset: { version: '2.0' }, buffers: [{ byteLength: 0 }], images: [{ uri: 'data:image/png;base64,AA==' }] });

const temps = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

/** A saved Higgsfield result as luna_asset_higgsfield leaves it: the file under the art root + its record. */
function savedHiggsfield(dir, { kind = 'prop', dirName = 'Props', stem = 'crate', ext = 'png', data = PNG } = {}) {
  const rel = `${ART}/${dirName}/${stem}.${ext}`;
  put(dir, rel, data);
  const record = `art/higgsfield/${kind}/${stem}.json`;
  put(dir, record, JSON.stringify({ name: 'Crate', kind, model: 'gpt_image_2_6', prompt: 'toon crate', status: 'saved', outputs: [rel] }));
  return { rel, record };
}

/** Fake Blender MCP add-on: writes the .blend and the FBX the script names (the first two quoted filepath= values). */
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

function pipeline(dir, blender = fakeBlender()) {
  const logged = [];
  const unity = { calls: [], exec: async (command, parameters) => { unity.calls.push({ command, parameters }); return { ok: true }; } };
  const p = P.createAssetPipeline({ repoPath: dir, unity, blender, recordSpend: () => ({ ok: true, reason: null }), logAsset: (e) => logged.push(e), now: () => 42 });
  return { p, logged, blender, unity };
}

function idx(code, needle) {
  const at = code.indexOf(needle);
  assert.ok(at >= 0, `missing: ${needle}`);
  return at;
}

/** The value of a `NAME = "..."` line of the generated Python. */
const pyLine = (code, name) => {
  const line = code.split('\n').find((l) => l.startsWith(`${name} = `));
  return line ? JSON.parse(line.slice(name.length + 3)) : null;
};
const posixOf = (p) => p.split(path.sep).join('/');

// ---- the generated Python ---------------------------------------------------------------

test('from = a Higgsfield PNG: the script loads it as the Base Color texture before the save and the toon pass', async () => {
  const dir = tempDir('lw-from-png-');
  const saved = savedHiggsfield(dir);
  const { p, blender, logged } = pipeline(dir);
  const res = await p.blenderModel({ name: 'Crate', kind: 'prop', from: saved.rel });
  assert.equal(res.ok, true, JSON.stringify(res));
  const code = blender.scripts[0];
  assert.equal(pyLine(code, 'FROM_PATH'), posixOf(path.join(dir, ...saved.rel.split('/'))));
  assert.equal(pyLine(code, 'FROM_TARGET'), 'Crate');
  // The Higgsfield result defaults to the toon pass.
  assert.match(code, /^STYLE_PASS = "blade-bullet-toon"$/m);
  assert.match(code, /bpy\.data\.images\.load\(FROM_PATH, check_existing=True\)/);
  assert.match(code, /links\.new\(tex\.outputs\['Color'\], bsdf\.inputs\['Base Color'\]\)/);
  assert.match(code, /nodes\.new\('ShaderNodeBsdfPrincipled'\)/);
  assert.match(code, /bpy\.data\.materials\.new\('Luna_' \+ o\.name\)/);
  const call = idx(code, '\nluna_from_texture()\n');
  assert.ok(idx(code, 'def luna_meshes') < call);
  assert.ok(call < idx(code, 'bpy.ops.wm.save_as_mainfile('));
  assert.ok(call < idx(code, "LUNA_REPORT['stylePass'] = STYLE_PASS"));
  assert.ok(idx(code, "luna_step('poly budget', luna_decimate, luna_objs)") < idx(code, 'bpy.ops.export_scene.fbx('));
  assert.ok(!code.includes('\nluna_from_model()'));

  assert.deepEqual(res.from, { path: saved.rel, type: 'texture', record: saved.record });
  assert.deepEqual(res.sources, ['art/blender/crate.blend', saved.record, saved.rel]);
  assert.deepEqual(logged[0].sources, ['art/blender/crate.blend', saved.record, saved.rel]);
  assert.equal(logged[0].tool, 'blender');
  const ledger = fs.readFileSync(path.join(dir, 'design', 'ASSET_LICENSES.md'), 'utf8');
  assert.match(ledger, /\| Crate \| art\/higgsfield\/prop\/crate\.json \| LunaCore asset worker \(Higgsfield \+ Blender\) \| Own work \(generated\) \| Assets\/BladeBullet\/Art\/Props\/crate\.fbx \|/);
  assert.doesNotMatch(res.note || '', /No Higgsfield record/);
});

test('from = a Higgsfield GLB: import, toon pass with decimate, then the same FBX export', async () => {
  const dir = tempDir('lw-from-glb-');
  const saved = savedHiggsfield(dir, { ext: 'glb', data: GLB });
  const { p, blender, unity } = pipeline(dir);
  const res = await p.blenderModel({ name: 'Crate', kind: 'prop', from: saved.rel });
  assert.equal(res.ok, true, JSON.stringify(res));
  const code = blender.scripts[0];
  const call = idx(code, '\nluna_from_model()\n');
  assert.match(code, /bpy\.ops\.import_scene\.gltf\(filepath=FROM_PATH\)/);
  assert.ok(call < idx(code, 'bpy.ops.wm.save_as_mainfile('));
  assert.ok(call < idx(code, "luna_step('poly budget', luna_decimate, luna_objs)"));
  assert.ok(idx(code, "luna_step('root transform', luna_roots)") < idx(code, 'bpy.ops.export_scene.fbx('));
  assert.match(code, /axis_forward='-Z', axis_up='Y'/);
  assert.ok(!code.includes('\nluna_from_texture()'));
  assert.deepEqual([res.from.type, res.from.record, res.files, res.prefab], ['model', saved.record, [`${ART}/Props/crate.fbx`], `${ART}/Props/crate.prefab`]);
  assert.equal(unity.calls[0].parameters.path, `${ART}/Props/crate.fbx`);
});

test('from: an explicit stylePass "none" is kept; no from keeps the old script order', async () => {
  const dir = tempDir('lw-from-none-');
  const saved = savedHiggsfield(dir);
  const { p, blender } = pipeline(dir);
  assert.equal((await p.blenderModel({ name: 'Crate', kind: 'prop', from: saved.rel, stylePass: 'none' })).ok, true);
  assert.match(blender.scripts[0], /^STYLE_PASS = "none"$/m);
  assert.ok(idx(blender.scripts[0], '\nluna_from_texture()\n') < idx(blender.scripts[0], 'bpy.ops.wm.save_as_mainfile('));

  const plain = B.blenderExportScript('/r/a.blend', '/r/a.fbx', { stylePass: 'blade-bullet-toon' });
  assert.ok(idx(plain, 'bpy.ops.wm.save_as_mainfile(') < idx(plain, 'def luna_meshes'));
  assert.doesNotMatch(plain, /FROM_PATH|luna_from_/);
});

test('from without a Higgsfield record: the file itself is the named source, with a note', async () => {
  const dir = tempDir('lw-from-norecord-');
  const rel = 'art/higgsfield/prop/crate-texture.webp';
  put(dir, rel, Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.alloc(8)]));
  const { p, logged } = pipeline(dir);
  const res = await p.blenderModel({ name: 'Crate', kind: 'prop', from: rel });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.from.record, null);
  assert.deepEqual(logged[0].sources, ['art/blender/crate.blend', rel]);
  assert.match(res.note, /No Higgsfield record lists art\/higgsfield\/prop\/crate-texture\.webp/);
  const ledger = fs.readFileSync(path.join(dir, 'design', 'ASSET_LICENSES.md'), 'utf8');
  assert.match(ledger, /\| Crate \| art\/higgsfield\/prop\/crate-texture\.webp \| LunaCore asset worker \(Higgsfield \+ Blender\) \|/);
});

test('from: a numbered result of a set finds its record; a record that does not list the file is not taken', async () => {
  const dir = tempDir('lw-from-set-');
  const rel = `${ART}/Props/crate-2.png`;
  put(dir, rel, PNG);
  put(dir, 'art/higgsfield/prop/crate.json', JSON.stringify({ outputs: [`${ART}/Props/crate-1.png`, rel] }));
  const { p } = pipeline(dir);
  assert.equal((await p.blenderModel({ name: 'Crate', kind: 'prop', from: rel })).from.record, 'art/higgsfield/prop/crate.json');

  const other = tempDir('lw-from-set2-');
  put(other, rel, PNG);
  put(other, 'art/higgsfield/prop/crate.json', JSON.stringify({ outputs: [`${ART}/Props/crate-1.png`] }));
  assert.equal((await pipeline(other).p.blenderModel({ name: 'Crate', kind: 'prop', from: rel })).from.record, null);
});

test('the Python carries the target name and path as escaped literals only', () => {
  const evil = 'Crate"\nimport os\u2028\u{1F600}';
  const code = B.blenderExportScript(path.resolve('/r/a.blend'), path.resolve('/r/a.fbx'), { from: { type: 'texture', path: path.resolve('/r/x".png'), target: evil } });
  const line = code.split('\n').find((l) => l.startsWith('FROM_TARGET = '));
  assert.equal(line, 'FROM_TARGET = "Crate\\" import os \\U0001f600"');
  // Only the helpers' own import: the name never starts a line of its own.
  assert.equal(code.split('\n').filter((l) => l.startsWith('import os')).length, 1);
  assert.equal(pyLine(code, 'FROM_PATH'), posixOf(path.resolve('/r/x".png')));
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { from: { type: 'script', path: path.resolve('/r/x.png'), target: 'a' } }), /from needs/);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { from: { type: 'texture', path: 'x.png', target: 'a' } }), /absolute path/);
  assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { from: { type: 'texture', path: path.resolve('/r/x.png'), target: '' } }), /target object name/);
});

test('parseScriptReport keeps fromApplied as a count only', () => {
  assert.equal(B.parseScriptReport('LUNACORE_REPORT {"fromApplied": 2}').fromApplied, 2);
  assert.equal(B.parseScriptReport('LUNACORE_REPORT {"fromApplied": "x"}').fromApplied, null);
});

// ---- path validation ----------------------------------------------------------------------

async function refused(dir, from, why) {
  const { p, blender, logged } = pipeline(dir);
  const res = await p.blenderModel({ name: 'Crate', kind: 'prop', from });
  assert.equal(res.ok, false, `${from} was accepted`);
  assert.equal(res.error, 'badFrom', JSON.stringify(res));
  assert.match(res.detail, why, String(from));
  assert.equal(blender.scripts.length, 0, `${from} reached Blender`);
  assert.equal(logged.length, 0);
}

test('from outside the repo, outside art/higgsfield/ or the art root, or with traversal is refused before Blender', async () => {
  const dir = tempDir('lw-from-bad-');
  savedHiggsfield(dir);
  put(dir, 'design/secret.png', PNG);
  const outside = tempDir('lw-from-outside-');
  const outsidePng = put(outside, 'x.png', PNG);
  await refused(dir, outsidePng, /plain repo-relative path/);
  await refused(dir, posixOf(outsidePng), /plain repo-relative path/);
  await refused(dir, `${ART}/../../../${path.basename(outside)}/x.png`, /no "\.\."/);
  await refused(dir, 'art/higgsfield/../../design/secret.png', /no "\.\."/);
  await refused(dir, `${ART}\\Props\\crate.png`, /forward slashes/);
  await refused(dir, './art/higgsfield/prop/crate.png', /plain repo-relative path/);
  await refused(dir, 'design/secret.png', /under art\/higgsfield\/ or Assets\/BladeBullet\/Art\//);
  await refused(dir, 'art/blender/crate.png', /under art\/higgsfield\//);
  await refused(dir, 'art/higgsfieldx/crate.png', /under art\/higgsfield\//);
  await refused(dir, `${ART}/Props/missing.png`, /no such file/);
  await refused(dir, `${ART}/Props`, /png \/ jpg \/ jpeg \/ webp \/ glb file/);
  await refused(dir, 42, /repo-relative path/);
});

test('from with a wrong extension, wrong bytes or an external-file GLB is refused with a clear error', async () => {
  const dir = tempDir('lw-from-type-');
  put(dir, `${ART}/Props/crate.gltf`, '{}');
  put(dir, `${ART}/Props/crate.fbx`, FBX);
  put(dir, `${ART}/Props/fake.png`, JPG);
  put(dir, `${ART}/Props/fake.glb`, PNG);
  put(dir, `${ART}/Props/ext.glb`, glbOf({ asset: { version: '2.0' }, buffers: [{ uri: '../../../secret.bin', byteLength: 4 }] }));
  put(dir, `${ART}/Props/extimg.glb`, glbOf({ asset: { version: '2.0' }, images: [{ uri: 'C:/Users/x/secret.png' }] }));
  put(dir, `${ART}/Props/crate.txt`, 'x');
  await refused(dir, `${ART}/Props/crate.gltf`, /\.gltf is not accepted: it can reference other files/);
  await refused(dir, `${ART}/Props/crate.fbx`, /\.fbx is not accepted/);
  await refused(dir, `${ART}/Props/fake.png`, /not a PNG image/);
  await refused(dir, `${ART}/Props/fake.glb`, /not a binary glTF/);
  await refused(dir, `${ART}/Props/ext.glb`, /references an external file \(a buffers uri\)/);
  await refused(dir, `${ART}/Props/extimg.glb`, /references an external file \(a images uri\)/);
  await refused(dir, `${ART}/Props/crate.txt`, /must be a png/);
});

/** Makes a link; false when this machine does not permit it. */
function tryLink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    if (err && ['EPERM', 'EACCES', 'ENOSYS'].includes(err.code)) return false;
    throw err;
  }
}

test('from through a junction (outside the repo or back inside it) or a symlinked file is refused', async (t) => {
  const dir = tempDir('lw-from-link-');
  const outside = tempDir('lw-from-link-out-');
  put(outside, 'loot.png', PNG);
  put(dir, 'design/inside/x.png', PNG);
  fs.mkdirSync(path.join(dir, 'art', 'higgsfield'), { recursive: true });
  const out = tryLink(outside, path.join(dir, 'art', 'higgsfield', 'out'), 'junction');
  const back = tryLink(path.join(dir, 'design', 'inside'), path.join(dir, 'art', 'higgsfield', 'back'), 'junction');
  if (!out || !back) {
    t.skip('junctions are not permitted on this machine');
    return;
  }
  await refused(dir, 'art/higgsfield/out/loot.png', /refused/);
  await refused(dir, 'art/higgsfield/back/x.png', /junction or link/);
  if (tryLink(path.join(outside, 'loot.png'), path.join(dir, 'art', 'higgsfield', 'file.png'), 'file')) {
    await refused(dir, 'art/higgsfield/file.png', /refused/);
  }
});

test('cleanFrom: no from is fine; the image and model extensions', () => {
  const roots = { artRoot: ART, higgsfieldDir: 'art/higgsfield' };
  assert.deepEqual(F.cleanFrom(undefined, roots), { ok: true, from: null });
  assert.deepEqual(F.cleanFrom(null, roots), { ok: true, from: null });
  assert.equal(F.cleanFrom(`${ART}/Props/a.JPG`, roots).from.type, 'texture');
  assert.equal(F.cleanFrom('art/higgsfield/prop/a.glb', roots).from.type, 'model');
  assert.equal(F.cleanFrom(`${ART}/Props/${'a'.repeat(400)}.png`, roots).ok, false);
});
