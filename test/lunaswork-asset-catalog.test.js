'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('../src/lunasworkAssetCatalog');
const { SOURCE_IDS, TYPES, createFreeSources } = require('../src/lunasworkFreeSources');
const { KINDS, COMFY_KINDS, MODEL_KINDS } = require('../src/lunasworkAssetPipeline');

const REQUIRED_IDS = [...SOURCE_IDS, 'comfyui', 'blender', 'higgsfield'];
// The AMD-safe families named in AMD_GPU_RULE of src/lunasworkAssetPipeline.js.
const AMD_FAMILIES = ['SD 1.5', 'SDXL', 'Flux', 'Kokoro-82M', 'F5-TTS', 'Stable Audio Open', 'Hunyuan3D-2', 'TripoSR'];

function collector() {
  const msgs = [];
  return { msgs, warn: (m) => msgs.push(m) };
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'luna-asset-catalog-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function loadText(text, warn) {
  return withTempDir(async (dir) => {
    const file = path.join(dir, 'catalog.json');
    await fs.promises.writeFile(file, text, 'utf8');
    return C.loadCatalog(file, { warn });
  });
}

const entry = (over = {}) => ({ id: 'polypizza', kinds: ['prop'], costClass: 'free', needsKey: true, toonFit: 'Low-poly.', ...over });

test('the bundled config loads with every source and no warnings', () => {
  const log = collector();
  const cat = C.loadCatalog(C.DEFAULT_CATALOG_FILE, { warn: log.warn });
  assert.deepEqual(log.msgs, []);
  assert.ok(Object.isFrozen(cat) && Object.isFrozen(cat.sources));
  assert.deepEqual(cat.sources.map((s) => s.id).sort(), [...REQUIRED_IDS].sort());
  for (const s of cat.sources) {
    assert.ok(s.kinds.length > 0, s.id);
    assert.ok(s.kinds.every((k) => Object.keys(KINDS).includes(k)), s.id);
    assert.ok(C.COST_CLASSES.includes(s.costClass), s.id);
    assert.equal(typeof s.needsKey, 'boolean', s.id);
    assert.ok(s.toonFit.length > 0, s.id);
  }
  assert.equal(C.loadCatalog().sources.length, REQUIRED_IDS.length);
});

test('the bundled config agrees with the free source clients and the pipeline', () => {
  const cat = C.loadCatalog(C.DEFAULT_CATALOG_FILE, { warn: () => {} });
  const clients = createFreeSources({ fetch: async () => { throw new Error('no network in tests'); } });
  const byId = Object.fromEntries(cat.sources.map((s) => [s.id, s]));
  for (const id of SOURCE_IDS) {
    assert.equal(byId[id].costClass, 'free', id);
    assert.equal(byId[id].needsKey, clients[id].needsKey.import, `${id} needsKey = the client's import key need`);
    assert.ok(clients[id].types.every((t) => TYPES.includes(t)), id);
    if (clients[id].types.includes('audio')) assert.ok(byId[id].kinds.includes('audio'), id);
    if (clients[id].types.includes('model')) assert.ok(byId[id].kinds.includes('model'), id);
    if (clients[id].types.includes('texture')) assert.ok(byId[id].kinds.includes('texture'), id);
  }
  assert.equal(byId.comfyui.costClass, 'local');
  assert.equal(byId.blender.costClass, 'local');
  assert.equal(byId.higgsfield.costClass, 'paid');
  assert.deepEqual([...byId.comfyui.kinds].sort(), [...COMFY_KINDS].sort());
  assert.deepEqual([...byId.blender.kinds].sort(), [...MODEL_KINDS].sort());
  assert.ok(byId.comfyui.models.every((m) => AMD_FAMILIES.includes(m.id)), 'only AMD-safe ComfyUI families');
  assert.ok(byId.higgsfield.models.every((m) => typeof m.credits === 'number' && m.credits > 0));
  assert.ok(!byId.higgsfield.kinds.includes('audio'), 'Higgsfield finals do not cover audio');
});

test('a missing, malformed or wrong-shape file gives an empty catalog without throwing', async () => {
  const log = collector();
  const missing = C.loadCatalog(path.join(os.tmpdir(), 'luna-no-such-dir', 'nope.json'), { warn: log.warn });
  assert.deepEqual(missing.sources, []);
  assert.deepEqual((await loadText('{ not json', log.warn)).sources, []);
  for (const shape of ['null', '[]', '42', '{}', '{"sources": {}}', '{"sources": "x"}']) {
    assert.deepEqual((await loadText(shape, log.warn)).sources, [], shape);
  }
  assert.equal(log.msgs.length, 8);
  assert.ok(log.msgs[0].includes('file missing'));
});

test('unknown source ids, unknown kinds and bad fields are dropped with a reason', async () => {
  const log = collector();
  const cat = await loadText(JSON.stringify({
    sources: [
      entry({ kinds: ['prop', 'hologram', 'prop'] }),
      entry({ id: 'kenney' }),
      entry({ id: 'freesound', costClass: 'cheap' }),
      entry({ id: 'smithsonian', needsKey: 'yes' }),
      entry({ id: 'ambientcg', toonFit: '' }),
      entry({ id: 'sketchfab', kinds: ['hologram'] }),
      entry({ id: 'polypizza', kinds: ['model'] }),
      'junk',
    ],
  }), log.warn);
  assert.deepEqual(cat.sources.map((s) => s.id), ['polypizza']);
  assert.deepEqual(cat.sources[0].kinds, ['prop']);
  const all = log.msgs.join('\n');
  for (const part of ['"hologram"', '"kenney"', 'costClass', 'needsKey', 'toonFit', 'sketchfab: no usable kinds', 'duplicate source polypizza', 'not an object']) {
    assert.ok(all.includes(part), part);
  }
});

test('bad models are dropped, a model keeps only kinds its source serves', async () => {
  const log = collector();
  const cat = await loadText(JSON.stringify({
    sources: [entry({
      id: 'higgsfield', kinds: ['concept', 'keyart'], costClass: 'paid', needsKey: false,
      models: [
        { id: 'gpt_image_2_6', kinds: ['concept', 'audio', 'nope'], credits: 3 },
        { id: 'bad id!', kinds: ['concept'] },
        { id: 'pricey', kinds: ['concept'], credits: -1 },
        { id: 'deaf', kinds: ['audio'] },
        { id: 'gpt_image_2_6', kinds: ['keyart'] },
      ],
    })],
  }), log.warn);
  const hf = cat.sources[0];
  assert.deepEqual(hf.models, [{ id: 'gpt_image_2_6', kinds: ['concept'], credits: 3 }]);
  assert.equal(log.msgs.length, 7);
});

test('sourcesForKind: audio is served by freesound and comfyui, not polyhaven', () => {
  assert.ok(Object.keys(KINDS).includes('audio'), 'the audio kind is literally "audio"');
  const cat = C.loadCatalog(C.DEFAULT_CATALOG_FILE, { warn: () => {} });
  const audio = C.sourcesForKind(cat, 'audio');
  assert.ok(audio.includes('freesound'));
  assert.ok(audio.includes('lotsofsounds'));
  assert.ok(audio.includes('comfyui'));
  assert.ok(!audio.includes('polyhaven'));
  assert.ok(!audio.includes('higgsfield'));
  assert.ok(C.sourcesForKind(cat, 'model').includes('blender'));
  assert.deepEqual(C.sourcesForKind(cat, 'hologram'), []);
  assert.deepEqual(C.sourcesForKind(null, 'audio'), []);
  assert.deepEqual(C.sourcesForKind(C.EMPTY_CATALOG, 'audio'), []);
});

test('isKnownHiggsfieldModel', () => {
  const cat = C.loadCatalog(C.DEFAULT_CATALOG_FILE, { warn: () => {} });
  assert.equal(C.isKnownHiggsfieldModel(cat, 'gpt_image_2_6'), true);
  assert.equal(C.isKnownHiggsfieldModel(cat, 'image-to-3d'), true);
  assert.equal(C.isKnownHiggsfieldModel(cat, 'SDXL'), false, 'a ComfyUI family is not a Higgsfield model');
  assert.equal(C.isKnownHiggsfieldModel(cat, 'made-up-model'), false);
  assert.equal(C.isKnownHiggsfieldModel(cat, 42), false);
  assert.equal(C.isKnownHiggsfieldModel(C.EMPTY_CATALOG, 'gpt_image_2_6'), false);
  assert.equal(C.isKnownHiggsfieldModel(undefined, 'gpt_image_2_6'), false);
});

test('comfyModelsForKind', () => {
  const cat = C.loadCatalog(C.DEFAULT_CATALOG_FILE, { warn: () => {} });
  assert.deepEqual(C.comfyModelsForKind(cat, 'audio').sort(), ['F5-TTS', 'Kokoro-82M', 'Stable Audio Open']);
  assert.deepEqual(C.comfyModelsForKind(cat, 'prop').sort(), ['Hunyuan3D-2', 'TripoSR']);
  assert.deepEqual(C.comfyModelsForKind(cat, 'concept').sort(), ['Flux', 'SD 1.5', 'SDXL']);
  assert.deepEqual(C.comfyModelsForKind(cat, 'animation'), []);
  assert.deepEqual(C.comfyModelsForKind(C.EMPTY_CATALOG, 'audio'), []);
});
