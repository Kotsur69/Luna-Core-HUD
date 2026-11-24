// ============================================================================
// Luna's Work Blender step (src/lunasworkAssetBlender.js) and its script
// (src/lunasworkBlenderScript.js): a repeated toon pass on the same open
// scene never overwrites the untouched .blend, and a junction made while
// Blender renders never redirects a write outside the asset folders (Blender
// writes to staging paths; Node guards each final path and moves the file in).
// The Blender add-on is a fake; the guarded save itself is also run in a real
// Python (when one is on PATH) against a mocked bpy.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const P = require('../src/lunasworkAssetPipeline.js');
const B = require('../src/lunasworkBlenderScript.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const FBX = Buffer.from('Kaydara FBX Binary  \0', 'latin1');
const BLEND = Buffer.from('BLENDER-v400', 'latin1');
const ART = 'Assets/BladeBullet/Art';
const RM_OPTS = { recursive: true, force: true, maxRetries: 5 };

async function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, RM_OPTS));
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'latin1');
const exists = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));

/** The value of a `NAME = "..."` line of the generated Python. */
function pyString(code, name) {
  const line = code.split('\n').find((l) => l.startsWith(`${name} = "`));
  return line ? JSON.parse(line.slice(name.length + 3)) : null;
}

const pyBool = (code, name) => code.split('\n').includes(`${name} = True`);
const filepaths = (code) => [...code.matchAll(/filepath=("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]));
const panelPaths = (code) => JSON.parse(code.split('\n').find((l) => l.startsWith('PANEL_PATHS = [')).slice('PANEL_PATHS = '.length));

/** Every file under `dir` (relative), links not followed. */
function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p).map((f) => path.join(e.name, f)));
    else out.push(e.name);
  }
  return out;
}

/**
 * Fake Blender add-on with one open scene: it follows the guarded save of the
 * script (a toon-marked scene never replaces an existing .blend), writes what
 * the script names, and a toon pass marks and changes the scene. `midRender`
 * runs after the save, before the FBX and the render (the long part).
 */
function sceneBlender({ marked = false, midRender = null } = {}) {
  const scene = { marked, content: marked ? 'toon' : 'pristine' };
  const scripts = [];
  return {
    scene,
    scripts,
    executeCode: async (code) => {
      scripts.push(code);
      const [blend, fbx] = filepaths(code);
      const statePath = pyString(code, 'BLEND_STATE_PATH');
      const wasMarked = scene.marked;
      if (wasMarked && pyBool(code, 'BLEND_EXISTS')) {
        fs.writeFileSync(statePath, 'kept');
      } else {
        fs.writeFileSync(blend, Buffer.concat([BLEND, Buffer.from(` ${scene.content}`, 'latin1')]));
        fs.writeFileSync(statePath, wasMarked ? 'toon' : 'clean');
      }
      if (pyString(code, 'STYLE_PASS') === B.TOON_PASS) Object.assign(scene, { marked: true, content: 'toon' });
      if (midRender) midRender();
      for (const panel of panelPaths(code)) fs.writeFileSync(panel, PNG);
      fs.writeFileSync(pyString(code, 'SHEET_PATH'), PNG);
      fs.writeFileSync(fbx, Buffer.concat([FBX, Buffer.from(` ${scene.content}`, 'latin1')]));
      return { executed: true, result: '' };
    },
  };
}

function pipeline(dir, blender) {
  const logged = [];
  const calls = [];
  const unity = { exec: async (command, parameters) => { calls.push({ command, parameters }); return { ok: true }; } };
  const p = P.createAssetPipeline({ repoPath: dir, unity, blender, recordSpend: () => ({ ok: true, reason: null }), logAsset: (e) => logged.push(e), now: () => 42 });
  return { p, logged, calls };
}

// ---- 1. the guarded save, run in a real Python against a mocked bpy ---------------------

const PY_HARNESS = String.raw`
import json, os, sys
from unittest import mock

class Scene(dict):
    objects = []

scene = Scene()
bpy = mock.MagicMock()
bpy.data.scenes = [scene]
bpy.context.scene = scene
sys.modules['bpy'] = bpy
sys.modules['mathutils'] = mock.MagicMock()
results = []
for job in json.loads(sys.stdin.read()):
    bpy.ops.wm.save_as_mainfile.reset_mock()
    if os.path.exists(job['state']):
        os.remove(job['state'])
    exec(job['code'], {})
    with open(job['state'], encoding='utf-8') as f:
        state = f.read()
    results.append({'saved': bpy.ops.wm.save_as_mainfile.call_count, 'state': state, 'mark': scene.get('luna_toon_pass')})
print('HARNESS ' + json.dumps(results))
`;

function runPython(jobs) {
  const res = spawnSync('python', ['-c', PY_HARNESS], { input: JSON.stringify(jobs), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('HARNESS '));
  return JSON.parse(line.slice('HARNESS '.length));
}

test('the guarded save in Python: a second toon call on the same scene keeps the .blend', async (t) => {
  const probe = spawnSync('python', ['-c', 'from unittest import mock'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('no python on PATH');
    return;
  }
  const dir = await tempDir(t, 'lw-blender-py-');
  const state = path.join(dir, 'blend-state.txt');
  const render = { sheet: path.join(dir, 's.png'), panels: B.TURNTABLE_VIEWS.map((v) => path.join(dir, `s.${v}.png`)) };
  const script = (stylePass, blendExists) => B.blenderExportScript(path.join(dir, 'a.tmp.blend'), path.join(dir, 'a.fbx'), {
    kind: 'prop', stylePass, render, blend: { exists: blendExists, statePath: state },
  });
  const statePy = state.split(path.sep).join('/');
  const results = runPython([
    // 1st toon call: no .blend yet, unmarked scene -> saved untouched, then marked.
    { code: script(B.TOON_PASS, false), state: statePy },
    // 2nd toon call on the same (now marked) scene, .blend there -> kept, not saved.
    { code: script(B.TOON_PASS, true), state: statePy },
    // A plain call on the marked scene must not overwrite it either.
    { code: script('none', true), state: statePy },
    // A marked scene with no .blend to keep is saved, flagged 'toon'.
    { code: script('none', false), state: statePy },
  ]);
  assert.deepEqual(results, [
    { saved: 1, state: 'clean', mark: B.TOON_PASS },
    { saved: 0, state: 'kept', mark: B.TOON_PASS },
    { saved: 0, state: 'kept', mark: B.TOON_PASS },
    { saved: 1, state: 'toon', mark: B.TOON_PASS },
  ]);
});

test('blenderExportScript: the toon pass marks the scene before it changes it; the blend options are validated', () => {
  const statePath = path.resolve('/r/state.txt');
  const code = B.blenderExportScript(path.resolve('/r/a.blend'), path.resolve('/r/a.fbx'), { stylePass: B.TOON_PASS, blend: { exists: true, statePath } });
  assert.match(code, /^TOON_MARK = "luna_toon_pass"$/m);
  assert.match(code, /^BLEND_EXISTS = True$/m);
  assert.match(code, /^if luna_toon_marked and BLEND_EXISTS:$/m);
  assert.match(code, /^ {4}bpy\.ops\.wm\.save_as_mainfile\(filepath=".*", copy=True\)$/m);
  const mark = code.indexOf('bpy.context.scene[TOON_MARK] = STYLE_PASS');
  assert.ok(mark > code.indexOf('save_as_mainfile(') && mark < code.indexOf("luna_step('poly budget'"));
  for (const blend of [{ exists: 'yes', statePath }, { exists: true, statePath: 'rel.txt' }, { exists: true }, 'x']) {
    assert.throws(() => B.blenderExportScript('/r/a.blend', '/r/a.fbx', { blend }), /blend needs/);
  }
  // Without the blend options the save stays the plain first step.
  assert.match(B.blenderExportScript('/r/a.blend', '/r/a.fbx', { stylePass: B.TOON_PASS }), /^bpy\.ops\.wm\.save_as_mainfile\(/m);
});

// ---- 2. a repeated toon call through blenderModel ---------------------------------------

test('blenderModel: a second toon call on the same open scene keeps the untouched .blend', async (t) => {
  const dir = await tempDir(t, 'lw-blender-rep-');
  const blender = sceneBlender();
  const { p } = pipeline(dir, blender);
  const first = await p.blenderModel({ name: 'Crate', kind: 'prop', stylePass: B.TOON_PASS });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.blend, 'saved');
  assert.match(read(dir, 'art/blender/crate.blend'), /pristine$/);
  assert.match(read(dir, `${ART}/Props/crate.fbx`), /toon$/);

  const second = await p.blenderModel({ name: 'Crate', kind: 'prop', stylePass: B.TOON_PASS });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.blend, 'kept');
  assert.deepEqual(second.sources, ['art/blender/crate.blend']);
  assert.match(second.note, /already carries the toon pass, so art\/blender\/crate\.blend was kept/);
  // Known state: still the untouched scene of the first call.
  assert.match(read(dir, 'art/blender/crate.blend'), /pristine$/);
  assert.match(read(dir, `${ART}/Props/crate.fbx`), /toon$/);

  // A plain call on the changed scene never overwrites it either.
  const plain = await p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.equal(plain.blend, 'kept');
  assert.match(read(dir, 'art/blender/crate.blend'), /pristine$/);

  // No staging file is left anywhere.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'art', 'blender')), ['crate.blend']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'design', 'asset-renders')), ['crate.png']);
  for (const code of blender.scripts) assert.equal(fs.existsSync(path.dirname(pyString(code, 'SHEET_PATH'))), false);
});

test('blenderModel: a toon-marked scene with no .blend yet is saved and the worker is told', async (t) => {
  const dir = await tempDir(t, 'lw-blender-marked-');
  const res = await pipeline(dir, sceneBlender({ marked: true })).p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.blend, 'saved');
  assert.match(res.note, /art\/blender\/crate\.blend was saved from a scene that already carries the toon pass/);
  assert.match(read(dir, 'art/blender/crate.blend'), /toon$/);
});

test('blenderModel: a "kept" state with no .blend left is a failed export, never a silent success', async (t) => {
  const dir = await tempDir(t, 'lw-blender-gone-');
  const blender = sceneBlender({ marked: true });
  const { p } = pipeline(dir, blender);
  fs.mkdirSync(path.join(dir, 'art', 'blender'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'art', 'blender', 'crate.blend'), BLEND);
  const original = blender.executeCode;
  blender.executeCode = async (code) => {
    const out = await original(code);
    fs.unlinkSync(path.join(dir, 'art', 'blender', 'crate.blend'));
    return out;
  };
  const res = await p.blenderModel({ name: 'Crate', kind: 'prop' });
  assert.deepEqual([res.ok, res.error], [false, 'blenderFailed']);
  assert.match(res.detail, /was to be kept but is gone/);
  assert.equal(exists(dir, `${ART}/Props/crate.fbx`), false);
});

// ---- 3. a junction made while Blender renders --------------------------------------------

/**
 * Swaps each repo folder in `rels` for a junction to a fresh folder under
 * `outside` (the real folder is moved aside inside the repo). Returns the
 * junctions, or null when this machine cannot make one.
 */
function junctionSwapper(dir, outside, rels) {
  const made = [];
  const swap = () => {
    for (const rel of rels) {
      const at = path.join(dir, ...rel.split('/'));
      const target = path.join(outside, rel.replace(/\//g, '_'));
      fs.mkdirSync(target, { recursive: true });
      fs.renameSync(at, `${at}-real`);
      fs.symlinkSync(target, at, 'junction');
      made.push(at);
    }
  };
  return { swap, made };
}

function canJunction(t, base) {
  const target = path.join(base, 'probe-target');
  const link = path.join(base, 'probe-link');
  try {
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    fs.unlinkSync(link);
    return true;
  } catch {
    t.skip('cannot create a junction here');
    return false;
  }
}

async function swapRun(t, rels) {
  const dir = await tempDir(t, 'lw-blender-swap-');
  const outside = await tempDir(t, 'lw-blender-outside-');
  if (!canJunction(t, outside)) return null;
  fs.rmdirSync(path.join(outside, 'probe-target'));
  const swapper = junctionSwapper(dir, outside, rels);
  const blender = sceneBlender({ midRender: swapper.swap });
  const run = pipeline(dir, blender);
  let res;
  try {
    res = await run.p.blenderModel({ name: 'Crate', kind: 'prop', stylePass: B.TOON_PASS });
  } finally {
    // The junctions go before any removal: the test dirs are removed without following them.
    for (const at of swapper.made) fs.unlinkSync(at);
  }
  return { dir, outside, res, run, blender };
}

test('blenderModel: FBX, render and .blend folders swapped to junctions mid-render -> nothing written outside', async (t) => {
  const r = await swapRun(t, [`${ART}/Props`, 'design/asset-renders', 'art/blender']);
  if (!r) return;
  assert.equal(r.res.ok, false);
  assert.match(r.res.detail, /refused: .* resolves outside the project repo/);
  assert.deepEqual(filesUnder(r.outside), []);
  assert.equal(r.run.calls.length, 0);
  assert.equal(r.run.logged.length, 0);
});

test('blenderModel: the FBX folder swapped to a junction mid-render -> refused, nothing outside, no .blend replaced', async (t) => {
  const r = await swapRun(t, [`${ART}/Props`]);
  if (!r) return;
  assert.deepEqual([r.res.ok, r.res.error], [false, 'writeFailed']);
  assert.match(r.res.detail, /Props\/crate\.fbx/);
  assert.deepEqual(filesUnder(r.outside), []);
  // The FBX failed, so the staged .blend never replaced anything and was removed.
  assert.deepEqual(fs.readdirSync(path.join(r.dir, 'art', 'blender')), []);
});

test('blenderModel: the render folder swapped to a junction mid-render -> no sheet outside, the export still lands', async (t) => {
  const r = await swapRun(t, ['design/asset-renders']);
  if (!r) return;
  assert.equal(r.res.ok, true, JSON.stringify(r.res));
  assert.deepEqual(r.res.renders, []);
  assert.match(r.res.note, /No turntable render for the style check \(refused: design\/asset-renders\/crate\.png resolves outside/);
  assert.deepEqual(filesUnder(r.outside), []);
  assert.match(read(r.dir, 'art/blender/crate.blend'), /pristine$/);
  assert.equal(exists(r.dir, `${ART}/Props/crate.fbx`), true);
});

test('blenderModel: the .blend folder swapped to a junction after the save -> refused, nothing outside', async (t) => {
  const r = await swapRun(t, ['art/blender']);
  if (!r) return;
  assert.deepEqual([r.res.ok, r.res.error], [false, 'blenderFailed']);
  assert.match(r.res.detail, /refused: art\/blender\/crate\.[0-9a-f]+\.tmp\.blend resolves outside/);
  assert.deepEqual(filesUnder(r.outside), []);
  assert.equal(exists(r.dir, `${ART}/Props/crate.fbx`), false);
});
