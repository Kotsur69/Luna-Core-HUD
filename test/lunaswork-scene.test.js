'use strict';

// Luna's Work on Unity: asset-prep cards run in parallel worktrees, only scene
// and prefab wiring goes to the one scene worker, which waits for the
// asset-prep packages and imports what they made (src/lunasworkScene.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const Scene = require('../src/lunasworkScene');
const A = require('../src/lunasworkAssets');

const { SCENE_WORKER_ID } = Scene;
const HEADER = '| Name | Type | Spec | Source | File | Status | Hash | Ref |\n|---|---|---|---|---|---|---|---|';

/** One ASSETS.md row as the asset step's card, with a card `at`. */
function assetCardAt(at, line, opts = { unity: true }) {
  const [row] = A.parseAssetList(`${HEADER}\n${line}`).rows;
  return { at, ...A.assetCard(row, opts) };
}

/** Throws when the plan's dependsOn graph has a cycle or an unknown id. */
function assertLaunchable(packages) {
  const ids = new Set(packages.map((p) => p.id));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 'done') return;
    assert.notEqual(state.get(id), 'open', `dependency cycle through ${id}`);
    state.set(id, 'open');
    const pkg = packages.find((p) => p.id === id);
    for (const dep of pkg.dependsOn) {
      assert.ok(ids.has(dep), `${id} depends on unknown ${dep}`);
      visit(dep);
    }
    state.set(id, 'done');
  };
  for (const id of ids) visit(id);
}

const CARDS = [
  assetCardAt(1, '| Hero Ship | model | low-poly teal fighter | blender |  |  |  |  |'),
  assetCardAt(2, '| Rain Loop | audio | soft rain on a roof | library |  |  |  |  |'),
  { at: 3, text: 'Place the hero ship and rain in the level', files: ['Assets/Scenes/Level1.unity'] },
  { at: 4, text: 'Score counter logic', files: ['Assets/Scripts/Score.cs'] },
];

function plan() {
  return [
    { id: 'ship', title: 'Hero ship', todoAts: [1], files: CARDS[0].files, dependsOn: [], prompt: 'ship', model: 'sonnet', effort: 'medium' },
    { id: 'rain', title: 'Rain', todoAts: [2], files: [...CARDS[1].files, 'design/ASSET_LICENSES.md'], dependsOn: [], prompt: 'rain', model: 'sonnet', effort: 'medium' },
    { id: 'level', title: 'Level', todoAts: [3], files: CARDS[2].files, dependsOn: [], prompt: 'level', model: 'opus', effort: 'high' },
    { id: 'score', title: 'Score', todoAts: [4], files: CARDS[3].files, dependsOn: [], prompt: 'score', model: 'sonnet', effort: 'medium' },
  ];
}

// ---- classification ------------------------------------------------------------------

test('raw asset files under Assets/**/Art/ or art/ and the asset bookkeeping are asset-prep files', () => {
  for (const f of [
    'Assets/BladeBullet/Art/Models/hero.fbx',
    'Assets/BladeBullet/Art/Models/hero.fbx.meta',
    'Assets/Art/slash/slash.png',
    'Assets/Game/Sub/Art/Audio/rain.ogg',
    'art/blender/hero.blend',
    'art/higgsfield/key.jpg',
    'Assets\\Game\\Art\\Textures\\rock.tga',
    './art/hdri/sky.exr',
    'design/ASSET_LICENSES.md',
    'design/ASSETS.md',
    'design/asset-renders/hero-ship.png',
  ]) {
    assert.equal(Scene.isAssetPrepFile(f), true, f);
  }
  for (const f of [
    'Assets/Art/Models/hero.prefab',
    'Assets/Scenes/Level1.unity',
    'Assets/Art/Materials/rock.mat',
    'Assets/Scripts/Art/Score.cs',
    'Assets/Textures/rock.png',
    'Assets/Game/Art/../../Scenes/x.png',
    'design/DESIGN.md',
    '',
    null,
  ]) {
    assert.equal(Scene.isAssetPrepFile(f), false, String(f));
  }
});

test('pure asset fetch / generation cards are asset-prep, not scene work', () => {
  for (const card of [CARDS[0], CARDS[1], assetCardAt(9, '| Slash FX | vfx | red arc | generated |  |  |  |  |', {})]) {
    assert.equal(Scene.isAssetPrepCard(card), true, card.text);
    assert.equal(Scene.isSceneCard(card), false, card.text);
    assert.ok(!card.files.some(Scene.isSceneFile), `${card.text} lists no scene or prefab file`);
  }
  // A library card the planner gave the license ledger stays asset-prep; a prefab named in its text is the scene worker's later.
  const fetch = { at: 5, text: 'Fetch a CC0 rock texture; the scene worker makes Rock.prefab', files: ['Assets/Game/Art/Textures/rock.png', 'design/ASSET_LICENSES.md'] };
  assert.equal(Scene.isAssetPrepCard(fetch), true);
  assert.equal(Scene.isSceneCard(fetch), false);
});

test('a mixed card (asset files plus a scene or prefab) and a card naming a scene are scene work', () => {
  const mixed = { at: 6, text: 'Import the crate and drop it in the level', files: ['Assets/Game/Art/Props/crate.fbx', 'Assets/Scenes/Level1.unity'] };
  const prefab = { at: 7, text: 'Crate prefab', files: ['Assets/Game/Art/Props/crate.fbx', 'Assets/Game/Art/Props/crate.prefab'] };
  const named = { at: 8, text: 'Put the crate into Level1.unity', files: ['Assets/Game/Art/Props/crate.fbx'] };
  for (const card of [mixed, prefab, named]) {
    assert.equal(Scene.isAssetPrepCard(card), false, card.text);
    assert.equal(Scene.isSceneCard(card), true, card.text);
  }
  assert.equal(Scene.isAssetPrepCard({ at: 9, text: 'no files' }), false);
});

// ---- routing ---------------------------------------------------------------------------

test('asset-prep packages stay separate and parallel; scene wiring goes to the scene worker, which depends on them', () => {
  const before = plan();
  const out = Scene.routeScenePackages(before, CARDS);
  assertLaunchable(out);

  assert.deepEqual(out.map((p) => p.id), ['ship', 'rain', SCENE_WORKER_ID, 'score']);
  const [ship, rain, worker, score] = out;
  assert.deepEqual(ship.dependsOn, [], 'asset prep waits for nothing: parallel');
  assert.deepEqual(rain.dependsOn, []);
  assert.deepEqual(ship.todoAts, [1]);
  assert.ok(ship.prompt.endsWith(Scene.ASSET_PREP_NOTE), 'asset-prep workers are told the import is deferred');
  assert.ok(rain.prompt.endsWith(Scene.ASSET_PREP_NOTE));
  assert.ok(score.prompt.endsWith(Scene.CODE_WORKER_NOTE), 'code workers keep the old note');
  assert.deepEqual(score.dependsOn, [], 'a code package is not held back');

  assert.deepEqual(worker.todoAts, [3]);
  assert.deepEqual(worker.dependsOn, ['ship', 'rain'], 'the scene worker waits for the asset-prep packages');
  assert.deepEqual(worker.files, ['Assets/Scenes/Level1.unity']);
  assert.match(worker.prompt, /## Asset import pass[\s\S]*ship, rain/);
  assert.match(worker.prompt, /Assets\/BladeBullet\/Art\/Models\/hero-ship\.fbx/);
  assert.match(worker.prompt, /make a prefab next to each model/);
  assert.match(worker.prompt, /## Level\n\nlevel/);
  assert.equal(out.filter((p) => p.files.some(Scene.isSceneFile)).length, 1, 'exactly one package touches scenes');
  assert.deepEqual(before, plan(), 'the planner output is not mutated');
});

test('a plan of asset-prep and code packages only is left as it was', () => {
  const only = plan().filter((p) => p.id !== 'level');
  assert.equal(Scene.routeScenePackages(only, CARDS), only);
});

test('a package with a mixed card goes to the scene worker', () => {
  const mixed = { at: 6, text: 'Import the crate and drop it in the level', files: ['Assets/Game/Art/Props/crate.fbx', 'Assets/Scenes/Level1.unity'] };
  const packages = [
    { id: 'ship', todoAts: [1], files: CARDS[0].files, dependsOn: [], prompt: 'ship' },
    // The planner listed only the asset file; the card's scene file still routes it.
    { id: 'crate', todoAts: [6], files: ['Assets/Game/Art/Props/crate.fbx'], dependsOn: [], prompt: 'crate' },
  ];
  const out = Scene.routeScenePackages(packages, [CARDS[0], mixed]);
  assertLaunchable(out);
  assert.deepEqual(out.map((p) => p.id), ['ship', SCENE_WORKER_ID]);
  assert.deepEqual(out[1].todoAts, [6]);
  assert.deepEqual(out[1].dependsOn, ['ship']);
});

test('an asset-prep package that waits for scene work is not made a dependency of the scene worker', () => {
  const packages = [
    { id: 'level', todoAts: [3], files: CARDS[2].files, dependsOn: [], prompt: 'level' },
    { id: 'ship', todoAts: [1], files: CARDS[0].files, dependsOn: ['level'], prompt: 'ship' },
    { id: 'rain', todoAts: [2], files: CARDS[1].files, dependsOn: [], prompt: 'rain' },
  ];
  const out = Scene.routeScenePackages(packages, CARDS);
  assertLaunchable(out);
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.deepEqual(byId[SCENE_WORKER_ID].dependsOn, ['rain']);
  assert.deepEqual(byId.ship.dependsOn, [SCENE_WORKER_ID]);
  assert.ok(byId.ship.prompt.endsWith(Scene.CODE_WORKER_NOTE), 'it runs after the scene worker, so it gets no deferral note');
});

test('an asset-prep package without files is recognised by its cards', () => {
  const packages = [
    { id: 'ship', todoAts: [1], files: [], dependsOn: [], prompt: 'ship' },
    { id: 'level', todoAts: [3], files: CARDS[2].files, dependsOn: [], prompt: 'level' },
  ];
  const out = Scene.routeScenePackages(packages, CARDS);
  assert.deepEqual(out.find((p) => p.id === SCENE_WORKER_ID).dependsOn, ['ship']);
});

test('the scene ownership map still gives only scenes and prefabs to the scene worker', () => {
  const map = Scene.sceneOwnership({ 'Assets/BladeBullet/Art/Models/hero-ship.fbx': 'ship', 'Assets/Scenes/Level1.unity': 'level' });
  assert.equal(map['Assets/BladeBullet/Art/Models/hero-ship.fbx'], 'ship');
  assert.equal(map['Assets/Scenes/Level1.unity'], SCENE_WORKER_ID);
});

test('the Art folder is matched case-insensitively (Windows and macOS checkouts)', () => {
  assert.equal(Scene.isAssetPrepFile('Assets/Game/art/Props/crate.fbx'), true);
  assert.equal(Scene.isAssetPrepFile('Art/blender/crate.blend'), true);
});

test('a package that also covers a code card is not asset-prep, so the scene worker does not wait for it', () => {
  const packages = [
    { id: 'level', todoAts: [3], files: CARDS[2].files, dependsOn: [], prompt: 'level' },
    // The planner listed only the art file, but the package also owns the score code card.
    { id: 'mixed', todoAts: [1, 4], files: CARDS[0].files, dependsOn: [], prompt: 'mixed' },
  ];
  const out = Scene.routeScenePackages(packages, CARDS);
  const byId = Object.fromEntries(out.map((p) => [p.id, p]));
  assert.deepEqual(byId[SCENE_WORKER_ID].dependsOn, []);
  assert.ok(byId.mixed.prompt.endsWith(Scene.CODE_WORKER_NOTE));
});

test('the scene worker is told that a deferred import is a failure for it', () => {
  const out = Scene.routeScenePackages(plan(), CARDS);
  assert.match(out.find((p) => p.id === SCENE_WORKER_ID).prompt, /deferred means YOUR editor is not connected/);
});
