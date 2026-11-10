// Editor auto-save (src/editorAutosave.js): what the generated scripts guard
// against, where they are installed, and that only LunaCore's own files are
// ever overwritten or removed.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createEditorAutosave,
  unityScript,
  blenderScript,
  cleanMinutes,
  scriptMinutes,
  MARKER,
  DEFAULT_MINUTES,
  UNITY_SCRIPT,
  BLENDER_SCRIPT,
} = require('../src/editorAutosave');
const { rowStateText, cleanRows, installedMinutes } = require('../src/renderer/modules/editorautosave.js');

/** A temp tree: one Unity repo, one repo with a Unity project in a subfolder, one plain repo, Blender 4.2 + 5.2. */
async function makeTree(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lc-autosave-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const mk = (...parts) => fs.mkdirSync(path.join(root, ...parts), { recursive: true });
  const unityAt = (...parts) => {
    mk(...parts, 'Assets');
    mk(...parts, 'ProjectSettings');
    fs.writeFileSync(path.join(root, ...parts, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.1f1\n');
  };
  unityAt('game');
  unityAt('mono', 'client');
  mk('mono', 'server');
  mk('web', 'src');
  mk('blender', '4.2');
  mk('blender', '5.2');
  mk('blender', 'not-a-version');
  const projects = [
    { name: 'Game', path: path.join(root, 'game') },
    { name: 'Mono', path: path.join(root, 'mono') },
    { name: 'Web', path: path.join(root, 'web') },
    { name: 'Gone', path: path.join(root, 'missing') },
    { name: 'Junk' },
  ];
  const autosave = createEditorAutosave({ projects: () => projects, blenderConfigDir: () => path.join(root, 'blender') });
  return { root, autosave };
}

test('minutes: only the offered intervals pass, anything else is the default', () => {
  assert.equal(cleanMinutes(10), 10);
  for (const bad of [0, 1, 7, -5, '5', null, undefined, NaN, 1e9]) assert.equal(cleanMinutes(bad), DEFAULT_MINUTES);
  assert.equal(scriptMinutes(unityScript(15)), 15);
  assert.equal(scriptMinutes(blenderScript(2)), 2);
  assert.equal(scriptMinutes('// something else'), null);
});

test('the Unity script is editor-only and never saves in an unsafe state', () => {
  const cs = unityScript(5);
  assert.ok(cs.startsWith(`// ${MARKER}`));
  assert.match(cs, /#if UNITY_EDITOR[\s\S]*#endif\s*$/);
  assert.match(cs, /IntervalSeconds = 300;/);
  for (const guard of ['isPlayingOrWillChangePlaymode', 'isCompiling', 'isUpdating', 'isBuildingPlayer']) assert.ok(cs.includes(guard), guard);
  // An untitled scene would pop a "Save as" dialog: it is skipped, never saved.
  assert.match(cs, /string\.IsNullOrEmpty\(scene\.path\)\) continue;/);
  assert.ok(!cs.includes('SaveOpenScenes'));
  assert.equal((cs.match(/{/g) || []).length, (cs.match(/}/g) || []).length);
});

test('the Blender script saves only a named, changed file and keeps its timer alive', () => {
  const py = blenderScript(10);
  assert.ok(py.startsWith(`# ${MARKER}`));
  assert.match(py, /INTERVAL_SECONDS = 600\.0/);
  assert.match(py, /bpy\.data\.filepath and bpy\.data\.is_dirty/);
  assert.match(py, /except Exception/);
  assert.match(py, /def register\(\):/);
  assert.match(py, /def unregister\(\):/);
  assert.match(py, /persistent=True/);
});

test('targets: Unity projects (root or direct child) and Blender versions; no paths in the answer', async (t) => {
  const { root, autosave } = await makeTree(t);
  const status = autosave.status();
  assert.deepEqual(
    status.targets.map((r) => [r.kind, r.name, r.state]),
    [
      ['unity', 'Game', 'absent'],
      ['unity', 'Mono/client', 'absent'],
      ['blender', 'Blender 4.2', 'absent'],
      ['blender', 'Blender 5.2', 'absent'],
    ],
  );
  assert.ok(!JSON.stringify(status).includes(root), 'no absolute path reaches the renderer');
});

test('install writes every target, reinstall changes the interval, remove deletes only its own files', async (t) => {
  const { root, autosave } = await makeTree(t);
  const first = autosave.install(10);
  assert.ok(first.targets.every((r) => r.ok && r.state === 'installed' && r.minutes === 10));
  const unityFile = path.join(root, 'game', UNITY_SCRIPT);
  const blenderFile = path.join(root, 'blender', '5.2', BLENDER_SCRIPT);
  assert.equal(fs.readFileSync(unityFile, 'utf8'), unityScript(10));
  assert.equal(fs.readFileSync(blenderFile, 'utf8'), blenderScript(10));
  assert.ok(!fs.existsSync(path.join(root, 'web', 'Assets')), 'a non-Unity project is untouched');
  assert.ok(!fs.existsSync(path.join(root, 'mono', 'server', 'Assets')));

  assert.ok(autosave.install(2).targets.every((r) => r.minutes === 2));
  assert.ok(autosave.install('99').targets.every((r) => r.minutes === DEFAULT_MINUTES), 'a junk interval falls back');

  fs.writeFileSync(`${unityFile}.meta`, 'guid: abc\n'); // Unity writes this itself
  const removed = autosave.remove();
  assert.ok(removed.targets.every((r) => r.ok && r.state === 'absent'));
  assert.ok(!fs.existsSync(unityFile));
  assert.ok(!fs.existsSync(`${unityFile}.meta`));
  assert.ok(!fs.existsSync(blenderFile));
});

test('a same-named file that LunaCore did not write is never overwritten or removed', async (t) => {
  const { root, autosave } = await makeTree(t);
  const own = path.join(root, 'game', UNITY_SCRIPT);
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, '// my own autosave\n');

  const res = autosave.install(5);
  const game = res.targets.find((r) => r.name === 'Game');
  assert.deepEqual([game.ok, game.error, game.state], [false, 'foreign', 'foreign']);
  assert.equal(fs.readFileSync(own, 'utf8'), '// my own autosave\n');
  assert.ok(res.targets.filter((r) => r.name !== 'Game').every((r) => r.ok));

  autosave.remove();
  assert.equal(fs.readFileSync(own, 'utf8'), '// my own autosave\n');
});

test('no Blender folder and no projects is an empty list, and a failed write is reported', async (t) => {
  const none = createEditorAutosave({ projects: () => null, blenderConfigDir: () => null });
  assert.deepEqual(none.status().targets, []);
  assert.deepEqual(none.install(5).targets, []);

  const { autosave: _unused, root } = await makeTree(t);
  const lines = [];
  const readOnlyFs = {
    ...fs,
    writeFileSync() {
      throw new Error('EPERM');
    },
  };
  const failing = createEditorAutosave({
    projects: () => [{ name: 'Game', path: path.join(root, 'game') }],
    blenderConfigDir: () => null,
    fsImpl: readOnlyFs,
    log: (l) => lines.push(l),
  });
  assert.deepEqual(failing.install(5).targets.map((r) => [r.ok, r.error]), [[false, 'writeFailed']]);
  assert.equal(lines.length, 1);
});

test('Settings rows: state text and junk-proof parsing', () => {
  const tr = (key, vars) => (vars ? `${key}:${vars.n}` : key);
  assert.equal(rowStateText({ state: 'installed', minutes: 5 }, tr), 'autosave.state.installed:5');
  assert.equal(rowStateText({ state: 'installed', minutes: null }, tr), 'autosave.state.installedPlain');
  assert.equal(rowStateText({ state: 'absent' }, tr), 'autosave.state.absent');
  assert.equal(rowStateText({ state: 'foreign', ok: false, error: 'foreign' }, tr), 'autosave.state.foreign');
  assert.equal(rowStateText({ state: 'absent', ok: false, error: 'writeFailed' }, tr), 'autosave.state.failed');
  assert.equal(rowStateText(null, tr), '');
  assert.deepEqual(cleanRows({ targets: [{ kind: 'unity', name: 'A' }, { kind: 'x', name: 'B' }, null, { kind: 'blender' }] }), [{ kind: 'unity', name: 'A' }]);
  assert.deepEqual(cleanRows(undefined), []);
  assert.equal(installedMinutes([{ state: 'absent' }, { state: 'installed', minutes: 10 }]), 10);
  assert.equal(installedMinutes([]), 5);
});
