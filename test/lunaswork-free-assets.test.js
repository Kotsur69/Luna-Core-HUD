// ============================================================================
// Luna's Work free library assets: search + import through the official APIs
// of Poly Haven, Sketchfab, Poly Pizza, ambientCG and Freesound, each against
// a fake fetch (no live call is possible here). The asset pipeline, the
// downloader, the ledger and the credits are the real ones over a temp repo;
// Unity is a fake recorder. Also: licenses and rips refused, keys never in an
// error, the zip reader's guards, the Critic's ledger card, the key store.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const P = require('../src/lunasworkAssetPipeline.js');
const L = require('../src/lunasworkLicenses.js');
const S = require('../src/lunasworkFreeSources.js');
const F = require('../src/lunasworkFreeAssets.js');
const Z = require('../src/lunasworkZip.js');
const K = require('../src/lunasworkAssetKeys.js');
const { createDownloader } = require('../src/lunasworkAssetTools.js');

const ART = 'Assets/Game/Art';
const pad = (head) => Buffer.concat([Buffer.isBuffer(head) ? head : Buffer.from(head, 'latin1'), Buffer.alloc(32, 7)]);
const JPG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const HDR = pad('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n');
const FBX = pad('Kaydara FBX Binary  \0');
const GLB = pad('glTF');
const OGG = pad('OggS');
const WAV = pad(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WAVE', 'latin1')]));
// Fake keys are assembled at runtime: no key-shaped literal in the source.
const fakeKey = (tag) => `${tag}${'k'.repeat(28)}`;
const KEYS = { sketchfab: fakeKey('sf'), polypizza: fakeKey('pp'), freesound: fakeKey('fs'), smithsonian: fakeKey('si'), blenderkit: fakeKey('bk'), lotsofsounds: fakeKey('ls') };

// ---- fakes ------------------------------------------------------------------------------

/** A Response-like object: JSON for objects, bytes for Buffers. */
function reply(body, status = 200) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, body: null, arrayBuffer: async () => buf };
}

/**
 * A fake fetch over a route table: exact URL -> body, or a function (url, init) -> Response.
 * Records every call with its headers.
 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {}, redirect: init.redirect });
    const hit = routes[url];
    if (hit === undefined) return reply({ detail: 'not found' }, 404);
    return typeof hit === 'function' ? hit(url, init) : reply(hit);
  };
  return { fn, calls };
}

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lw-free-assets-'));
}

/** The real executor over a temp repo, a fake Unity and the given fake fetch. */
function library(dir, fetch, { keys = KEYS } = {}) {
  const unity = { calls: [], exec: async (command, parameters) => { unity.calls.push({ command, parameters }); return { ok: true }; } };
  const logged = [];
  const pipe = P.createAssetPipeline({ repoPath: dir, artRoot: ART, unity, recordSpend: () => ({ ok: true }), logAsset: (e) => logged.push(e), now: () => 1 });
  const keyStore = { get: (s) => keys[s] || null, secrets: () => Object.values(keys) };
  const lib = F.createFreeAssets({
    shared: pipe.shared,
    artRoot: pipe.artRoot,
    sources: S.createFreeSources({ fetch, keys: keyStore }),
    download: createDownloader({ fetch, lookup }),
    secrets: keyStore.secrets,
  });
  return { lib, unity, logged };
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
const ledgerRows = (dir) => L.parseLedger(read(dir, L.LEDGER_FILE)).rows;

/** A zip built here: stored or deflated entries. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate = true } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = Z.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cen = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cen.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, end]);
}

// ---- Poly Haven -------------------------------------------------------------------------

const PH = 'https://api.polyhaven.com';
const polyHavenRoutes = {
  [`${PH}/assets?type=hdris`]: {
    dusk_sky: { name: 'Dusk Sky', type: 0, tags: ['sky', 'sunset'], categories: ['outdoor'], authors: { 'Greg Zaal': 'All' }, download_count: 5 },
    studio: { name: 'Studio', type: 0, tags: ['indoor'], categories: [], authors: {}, download_count: 9 },
  },
  [`${PH}/info/dusk_sky`]: { name: 'Dusk Sky', type: 0, tags: ['sky'], categories: ['outdoor'], authors: { 'Greg Zaal': 'All' } },
  [`${PH}/files/dusk_sky`]: { hdri: { '1k': { hdr: { url: 'https://dl.polyhaven.org/file/dusk_sky_1k.hdr' } }, '2k': { hdr: { url: 'https://dl.polyhaven.org/file/dusk_sky_2k.hdr' } } } },
  'https://dl.polyhaven.org/file/dusk_sky_2k.hdr': () => reply(HDR),
  [`${PH}/info/old_crate`]: { name: 'Old Crate', type: 2, tags: ['wood'], categories: ['props'], authors: { 'Jane Doe': 'All' } },
  [`${PH}/files/old_crate`]: {
    fbx: { '2k': { fbx: { url: 'https://dl.polyhaven.org/file/old_crate.fbx', include: { 'textures/old_crate_diff_2k.jpg': { url: 'https://dl.polyhaven.org/file/old_crate_diff_2k.jpg' } } } } },
  },
  'https://dl.polyhaven.org/file/old_crate.fbx': () => reply(FBX),
  'https://dl.polyhaven.org/file/old_crate_diff_2k.jpg': () => reply(JPG),
};

test('Poly Haven: search filters by the query, import writes the HDRI, its ledger row and imports it', async () => {
  const dir = tempRepo();
  const fake = fakeFetch(polyHavenRoutes);
  const { lib, unity, logged } = library(dir, fake.fn);

  const found = await lib.search({ source: 'polyhaven', query: 'sunset', type: 'hdri' });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(found.results.map((r) => [r.id, r.license, r.author]), [['dusk_sky', 'CC0', 'Greg Zaal']]);
  // API calls never follow a redirect.
  assert.ok(fake.calls.every((c) => c.redirect === 'error' || c.url.startsWith('https://dl.')));

  const res = await lib.importAsset({ source: 'polyhaven', id: 'dusk_sky', name: 'Dusk Sky', kind: 'texture' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Textures/dusk-sky.hdr`]);
  assert.equal(read(dir, `${ART}/Textures/dusk-sky.hdr`).startsWith('#?RADIANCE'), true);
  assert.deepEqual(ledgerRows(dir), [{ name: 'Dusk Sky', source: 'https://polyhaven.com/a/dusk_sky', author: 'Greg Zaal', license: 'CC0', path: `${ART}/Textures/dusk-sky.hdr` }]);
  assert.match(read(dir, L.LEDGER_FILE), /^# Asset licenses/);
  assert.equal(res.credits, null, 'CC0 only: no credits file');
  assert.deepEqual(unity.calls.map((c) => c.command), ['assets import']);
  assert.equal(logged[0].tool, 'library');
});

test('Poly Haven: a model comes with its textures into one folder; the folder is the ledger path', async () => {
  const dir = tempRepo();
  const { lib, unity } = library(dir, fakeFetch(polyHavenRoutes).fn);
  const res = await lib.importAsset({ source: 'polyhaven', id: 'old_crate', name: 'Old Crate', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Props/old-crate/old_crate.fbx`, `${ART}/Props/old-crate/textures/old_crate_diff_2k.jpg`]);
  assert.equal(res.main, `${ART}/Props/old-crate/old_crate.fbx`);
  assert.equal(ledgerRows(dir)[0].path, `${ART}/Props/old-crate/`);
  // The texture is imported before the model, then the model gets its prefab.
  assert.deepEqual(unity.calls.map((c) => [c.command, c.parameters.path]), [
    ['assets import', `${ART}/Props/old-crate/textures/old_crate_diff_2k.jpg`],
    ['assets import', `${ART}/Props/old-crate/old_crate.fbx`],
    ['prefab create', `${ART}/Props/old-crate/old_crate.prefab`],
  ]);
  // Importing it again never overwrites: -v2.
  const again = await lib.importAsset({ source: 'polyhaven', id: 'old_crate', name: 'Old Crate', kind: 'prop' });
  assert.equal(again.main, `${ART}/Props/old-crate-v2/old_crate.fbx`);
  assert.equal(ledgerRows(dir).length, 2);
});

// ---- Sketchfab --------------------------------------------------------------------------

const SF = 'https://api.sketchfab.com/v3';
const UID = 'a'.repeat(32);
const NC_UID = 'b'.repeat(32);
const RIP_UID = 'c'.repeat(32);
const sfModel = (uid, name, slug, label, extra = {}) => ({ uid, name, isDownloadable: true, viewerUrl: `https://sketchfab.com/3d-models/x-${uid}`, user: { displayName: 'Modeler' }, license: { slug, label }, tags: [{ name: 'katana' }], ...extra });

function sketchfabRoutes() {
  const downloadCalls = [];
  return {
    downloadCalls,
    routes: {
      [`${SF}/search?type=models&downloadable=true&count=10&q=katana`]: { results: [sfModel(UID, 'Katana Sword', 'by', 'CC Attribution'), sfModel(NC_UID, 'Fancy Katana', 'by-nc', 'CC Attribution-NonCommercial'), sfModel(RIP_UID, 'Kurumi Tokisaki katana (game rip)', 'by', 'CC Attribution')] },
      [`${SF}/models/${UID}`]: sfModel(UID, 'Katana Sword', 'by', 'CC Attribution'),
      [`${SF}/models/${NC_UID}`]: sfModel(NC_UID, 'Fancy Katana', 'by-nc', 'CC Attribution-NonCommercial'),
      [`${SF}/models/${RIP_UID}`]: sfModel(RIP_UID, 'Kurumi Tokisaki katana', 'by', 'CC Attribution'),
      [`${SF}/models/${UID}/download`]: (url, init) => {
        downloadCalls.push(init.headers);
        return reply({ glb: { url: 'https://sketchfab-prod-media.s3.amazonaws.com/archives/katana.glb?sig=abc', size: 36 } });
      },
      'https://sketchfab-prod-media.s3.amazonaws.com/archives/katana.glb?sig=abc': () => reply(GLB),
    },
  };
}

test('Sketchfab: NC and game-rip results are refused in search; a CC-BY model is imported with its credit', async () => {
  const dir = tempRepo();
  const sf = sketchfabRoutes();
  const fake = fakeFetch(sf.routes);
  const { lib } = library(dir, fake.fn);

  const found = await lib.search({ source: 'sketchfab', query: 'katana' });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(found.results.map((r) => [r.id, r.license]), [[UID, 'CC-BY 4.0']]);
  assert.equal(found.refused.length, 2);
  assert.match(found.refused.find((r) => r.id === NC_UID).reason, /non-commercial/);
  assert.match(found.refused.find((r) => r.id === RIP_UID).reason, /kurumi.*reference/);

  const res = await lib.importAsset({ source: 'sketchfab', id: UID, name: 'Katana Sword', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Props/katana-sword.glb`]);
  assert.equal(res.license, 'CC-BY 4.0');
  // The token goes only to the API's download endpoint, never to the file host.
  assert.equal(sf.downloadCalls[0].Authorization, `Token ${KEYS.sketchfab}`);
  const fileCall = fake.calls.find((c) => c.url.includes('s3.amazonaws.com'));
  assert.equal(JSON.stringify(fileCall.headers).includes(KEYS.sketchfab), false);
  // CC-BY: the ledger row feeds the in-game credits.
  assert.equal(res.credits, L.CREDITS_FILE);
  const credits = read(dir, L.CREDITS_FILE);
  assert.match(credits, /"Katana Sword" by Modeler - CC-BY 4\.0 - https:\/\/sketchfab\.com\/3d-models\/x-a{32}/);
});

test('Sketchfab: import re-reads the license - an NC model and a rip are refused with nothing written', async () => {
  const dir = tempRepo();
  const { lib } = library(dir, fakeFetch(sketchfabRoutes().routes).fn);
  const nc = await lib.importAsset({ source: 'sketchfab', id: NC_UID, kind: 'prop' });
  assert.equal(nc.ok, false);
  assert.equal(nc.error, 'licenseRefused');
  assert.match(nc.detail, /non-commercial \(NC\)/);
  const rip = await lib.importAsset({ source: 'sketchfab', id: RIP_UID, kind: 'prop' });
  assert.equal(rip.error, 'ripRefused');
  assert.match(rip.detail, /reference of this game, never a source/);
  assert.equal(exists(dir, 'Assets'), false);
  assert.equal(exists(dir, L.LEDGER_FILE), false);
});

test('Sketchfab: no stored token -> noKey with where to add it; nothing downloaded', async () => {
  const dir = tempRepo();
  const sf = sketchfabRoutes();
  const { lib } = library(dir, fakeFetch(sf.routes).fn, { keys: {} });
  const res = await lib.importAsset({ source: 'sketchfab', id: UID, kind: 'prop' });
  assert.equal(res.error, 'noKey');
  assert.match(res.detail, /Asset library keys/);
  assert.equal(sf.downloadCalls.length, 0);
});

// ---- Poly Pizza -------------------------------------------------------------------------

const PP = 'https://api.poly.pizza/v1.1';
const ppModel = (id, title, licence) => ({ ID: id, Title: title, Creator: { Username: 'lowpoly_jo' }, Licence: licence, Download: `https://static.poly.pizza/${id}.glb`, Tags: ['tree'] });

test('Poly Pizza: search and import send the key header; CC-BY 3.0 is credited, an unknown license refused', async () => {
  const dir = tempRepo();
  const routes = {
    [`${PP}/search/pine%20tree?Limit=10`]: { total: 2, results: [ppModel('pine1', 'Pine Tree', 'CC-BY 3.0'), ppModel('odd1', 'Odd Tree', 'All rights reserved')] },
    [`${PP}/model/pine1`]: ppModel('pine1', 'Pine Tree', 'CC-BY 3.0'),
    [`${PP}/model/odd1`]: ppModel('odd1', 'Odd Tree', 'All rights reserved'),
    'https://static.poly.pizza/pine1.glb': () => reply(GLB),
  };
  const fake = fakeFetch(routes);
  const { lib } = library(dir, fake.fn);
  const found = await lib.search({ source: 'polypizza', query: 'pine tree' });
  assert.deepEqual(found.results.map((r) => r.id), ['pine1']);
  assert.match(found.refused[0].reason, /not on the allowed list/);
  assert.equal(fake.calls[0].headers['x-auth-token'], KEYS.polypizza);

  const res = await lib.importAsset({ source: 'polypizza', id: 'pine1', kind: 'environment' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Environments/pine-tree.glb`]);
  assert.match(read(dir, L.CREDITS_FILE), /"Pine Tree" by lowpoly_jo - CC-BY 3\.0 - https:\/\/poly\.pizza\/m\/pine1/);
  const odd = await lib.importAsset({ source: 'polypizza', id: 'odd1', kind: 'prop' });
  assert.equal(odd.error, 'licenseRefused');
  assert.deepEqual(ledgerRows(dir).map((r) => r.name), ['Pine Tree']);
});

// ---- ambientCG --------------------------------------------------------------------------

const ACG = 'https://ambientcg.com/api/v2/full_json';

test('ambientCG: a zipped texture set is unpacked (only maps, no DirectX normal), ledgered as one folder', async () => {
  const dir = tempRepo();
  const zip = makeZip([
    { name: 'Bricks001_2K-JPG_Color.jpg', data: JPG },
    { name: 'Bricks001_2K-JPG_NormalGL.jpg', data: JPG },
    { name: 'Bricks001_2K-JPG_NormalDX.jpg', data: JPG },
    { name: 'Bricks001_2K-JPG.usda', data: Buffer.from('#usda 1.0'), deflate: false },
  ]);
  const record = {
    assetId: 'Bricks001', displayName: 'Bricks 001', dataType: 'Material', tags: ['brick', 'wall'],
    downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [
      { attribute: '1K-JPG', fileName: 'Bricks001_1K-JPG.zip', downloadLink: 'https://ambientcg.com/get?file=Bricks001_1K-JPG.zip' },
      { attribute: '2K-JPG', fileName: 'Bricks001_2K-JPG.zip', downloadLink: 'https://ambientcg.com/get?file=Bricks001_2K-JPG.zip' },
    ] } } } },
  };
  const routes = {
    [`${ACG}?q=brick&type=Material,Decal,Atlas&limit=10&include=tagData`]: { foundAssets: [{ assetId: 'Bricks001', displayName: 'Bricks 001', dataType: 'Material', tags: ['brick'] }] },
    [`${ACG}?id=Bricks001&include=tagData,downloadData`]: { foundAssets: [record] },
    // The download link redirects to the CDN, as ambientCG's does.
    'https://ambientcg.com/get?file=Bricks001_2K-JPG.zip': () => ({ status: 302, ok: false, headers: { get: (h) => (h === 'location' ? 'https://cdn.ambientcg.com/Bricks001_2K-JPG.zip' : null) }, body: null }),
    'https://cdn.ambientcg.com/Bricks001_2K-JPG.zip': () => reply(zip),
  };
  const { lib, unity } = library(dir, fakeFetch(routes).fn, { keys: {} });
  const found = await lib.search({ source: 'ambientcg', query: 'brick', type: 'texture' });
  assert.deepEqual(found.results.map((r) => [r.id, r.license]), [['Bricks001', 'CC0']]);

  const res = await lib.importAsset({ source: 'ambientcg', id: 'Bricks001', name: 'Brick Wall', kind: 'texture' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Textures/brick-wall/Bricks001_2K-JPG_Color.jpg`, `${ART}/Textures/brick-wall/Bricks001_2K-JPG_NormalGL.jpg`]);
  assert.deepEqual(ledgerRows(dir), [{ name: 'Brick Wall', source: 'https://ambientcg.com/view?id=Bricks001', author: 'ambientCG', license: 'CC0', path: `${ART}/Textures/brick-wall/` }]);
  // The color map is the main file: it gets the material.
  assert.equal(unity.calls.at(-1).command, 'material create');
  assert.equal(unity.calls.at(-1).parameters.texture, `${ART}/Textures/brick-wall/Bricks001_2K-JPG_Color.jpg`);
});

// ---- Freesound --------------------------------------------------------------------------

const FS = 'https://freesound.org/apiv2';
const FIELDS = 'id,name,username,license,url,tags,previews';
const fsSound = (id, name, license) => ({ id, name, username: 'foley_kat', license, url: `https://freesound.org/people/foley_kat/sounds/${id}/`, tags: ['sword'], previews: { 'preview-hq-ogg': `https://cdn.freesound.org/previews/${id}-hq.ogg` } });

test('Freesound: the key goes in a header (never the URL), the HQ OGG preview is imported and credited', async () => {
  const dir = tempRepo();
  const routes = {
    [`${FS}/search/text/?query=sword%20slash&page_size=10&fields=${FIELDS}&filter=${encodeURIComponent('license:("Creative Commons 0" OR "Attribution")')}`]: { results: [fsSound(101, 'Sword Slash', 'https://creativecommons.org/licenses/by/4.0/'), fsSound(102, 'Swish', 'http://creativecommons.org/licenses/by-nc/3.0/')] },
    [`${FS}/sounds/101/?fields=${FIELDS}`]: fsSound(101, 'Sword Slash', 'https://creativecommons.org/licenses/by/4.0/'),
    'https://cdn.freesound.org/previews/101-hq.ogg': () => reply(OGG),
  };
  const fake = fakeFetch(routes);
  const { lib } = library(dir, fake.fn);
  const found = await lib.search({ source: 'freesound', query: 'sword slash' });
  assert.deepEqual(found.results.map((r) => [r.id, r.license]), [['101', 'CC-BY 4.0']]);
  assert.equal(found.refused[0].id, '102');
  assert.ok(fake.calls.every((c) => !c.url.includes(KEYS.freesound)), 'the key is never in a URL');
  assert.equal(fake.calls[0].headers.Authorization, `Token ${KEYS.freesound}`);

  const res = await lib.importAsset({ source: 'freesound', id: '101', kind: 'audio' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Audio/sword-slash.ogg`]);
  assert.match(res.note, /HQ OGG preview/);
  assert.match(read(dir, L.CREDITS_FILE), /"Sword Slash" by foley_kat - CC-BY 4\.0/);
  // The preview CDN never sees the key.
  assert.equal(JSON.stringify(fake.calls.find((c) => c.url.includes('cdn.freesound.org')).headers).includes(KEYS.freesound), false);
});

// ---- Smithsonian 3D, BlenderKit, Lots of Sounds ----------------------------------------

test('Smithsonian 3D: sends X-Api-Key header, searches CC0 3D models and imports GLB', async () => {
  const dir = tempRepo();
  const SI = 'https://api.si.edu/openaccess/api/v1.0';
  const record = {
    id: 'edanmdm:nmnh_101',
    title: 'Pocket Watch Mechanism',
    unitCode: 'NMAH',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://www.si.edu/object/nmnh_101',
        usage: { access: 'CC0' },
        online_media: { media: [{ type: '3D Models', resources: [{ url: 'https://3d-api.si.edu/content/document/watch.glb', format: 'glb' }] }] },
      },
      indexedStructured: { object_type: ['Clocks'] },
    },
  };
  const routes = {
    [`${SI}/search?q=${encodeURIComponent('clock AND online_media_type:"3D Models"')}&rows=10`]: { response: { rows: [record] } },
    [`${SI}/content/${encodeURIComponent('edanmdm:nmnh_101')}`]: { response: record },
    'https://3d-api.si.edu/content/document/watch.glb': () => reply(GLB),
  };
  const fake = fakeFetch(routes);
  const { lib } = library(dir, fake.fn);
  const found = await lib.search({ source: 'smithsonian', query: 'clock' });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(found.results.map((r) => [r.id, r.license]), [['edanmdm:nmnh_101', 'CC0']]);
  assert.equal(fake.calls[0].headers['X-Api-Key'], KEYS.smithsonian);
  assert.ok(fake.calls.every((c) => !c.url.includes(KEYS.smithsonian)), 'the key is never in a URL');

  const res = await lib.importAsset({ source: 'smithsonian', id: 'edanmdm:nmnh_101', name: 'Pocket Watch', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Props/pocket-watch.glb`]);
  assert.equal(ledgerRows(dir)[0].license, 'CC0');
});

const BK = 'https://www.blenderkit.com/api/v1';
const EXR = pad(Buffer.from([0x76, 0x2f, 0x31, 0x01]));
const bkEndpoint = (uuid) => `${BK}/downloads/${uuid}/`;
const bkSearchUrl = (words) => `${BK}/search/?query=${encodeURIComponent(words)}&page_size=10`;
const bkInfoUrl = (id) => `${BK}/search/?query=${encodeURIComponent(`asset_base_id:${id} is_free:true`)}&page_size=1`;
/** A BlenderKit search record; files: fileType -> endpoint uuid. */
const bkRecord = (id, assetType, license, files) => ({
  assetBaseId: id, displayName: id, assetType, isFree: true, license, author: { fullName: 'Kit Artist' }, tags: ['lantern'],
  files: Object.entries(files).map(([fileType, uuid]) => ({ fileType, downloadUrl: bkEndpoint(uuid), fileThumbnail: null })),
});
const MODEL_FILES = { thumbnail: 'aaaa0000-0000-0000-0000-000000000001', blend: 'aaaa0000-0000-0000-0000-000000000002', gltf_godot: 'aaaa0000-0000-0000-0000-000000000003', gltf: 'aaaa0000-0000-0000-0000-000000000004' };

/**
 * The fake fetch, plus the two-step download: a GET of an endpoint without
 * ?scene_uuid= answers 403 like the live API; with one it answers `signed[uuid]`.
 */
function bkFetch(routes, signed) {
  const base = fakeFetch(routes);
  const downloads = [];
  const fn = async (url, init = {}) => {
    const m = /^https:\/\/www\.blenderkit\.com\/api\/v1\/downloads\/([\w-]+)\/(\?scene_uuid=([0-9a-f-]{36}))?$/.exec(url);
    if (!m) return base.fn(url, init);
    downloads.push({ uuid: m[1], url, headers: init.headers || {} });
    if (!m[2]) return reply({ detail: 'Parameter scene_uuid not set' }, 403);
    const hit = signed[m[1]];
    if (hit === undefined) return reply({ detail: 'not found' }, 404);
    return typeof hit === 'function' ? hit(url, init) : reply(hit);
  };
  return { fn, calls: base.calls, downloads };
}

test('BlenderKit: without a key, search -> info -> signed two-step download imports the glTF (.glb) of a royalty-free model', async () => {
  const dir = tempRepo();
  const model = bkRecord('bk-lantern-01', 'model', 'royalty_free', MODEL_FILES);
  const material = bkRecord('bk-rust-mat', 'material', 'royalty_free', { blend: 'bbbb0000-0000-0000-0000-000000000001' });
  const glbUrl = 'https://assets.blendkit.com/signed/bk-lantern-01/lantern.glb?sig=abc';
  const fake = bkFetch({
    [bkSearchUrl('lantern asset_type:model is_free:true')]: { results: [model, material] },
    [bkInfoUrl('bk-lantern-01')]: { results: [model] },
    [glbUrl]: () => reply(GLB),
  }, { [MODEL_FILES.gltf]: { fileType: 'gltf', uuid: MODEL_FILES.gltf, filePath: glbUrl, filePaths: [{ url: glbUrl }] } });
  const { lib } = library(dir, fake.fn, { keys: {} });

  const found = await lib.search({ source: 'blenderkit', query: 'lantern', type: 'model' });
  assert.equal(found.ok, true, JSON.stringify(found));
  assert.deepEqual(found.results.map((r) => [r.id, r.license]), [['bk-lantern-01', L.BLENDERKIT_ROYALTY_FREE]], 'the material record is filtered out');
  assert.deepEqual(found.refused, []);

  const res = await lib.importAsset({ source: 'blenderkit', id: 'bk-lantern-01', name: 'Iron Lantern', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Props/iron-lantern.glb`]);
  assert.equal(fs.readFileSync(path.join(dir, ...res.files[0].split('/'))).subarray(0, 4).toString('latin1'), 'glTF');
  assert.equal(ledgerRows(dir)[0].license, L.BLENDERKIT_ROYALTY_FREE);
  assert.equal(fake.downloads.length, 1, 'one signed call, for the gltf file only');
  assert.equal(fake.downloads[0].uuid, MODEL_FILES.gltf);
  assert.match(fake.downloads[0].url, /\?scene_uuid=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(fake.downloads[0].headers.Authorization, undefined, 'no key, no Authorization header');
  assert.ok(fake.calls.every((c) => !/asset_type=|is_free=/.test(c.url)), 'filters only inside query=');
});

test('BlenderKit: a stored key goes as a Bearer token to the download endpoint; a refusal never carries it', async () => {
  const dir = tempRepo();
  const model = bkRecord('bk-lantern-01', 'model', 'cc0', MODEL_FILES);
  const glbUrl = 'https://assets.blenderkit.com/files/lantern.glb';
  const ok = bkFetch({ [bkInfoUrl('bk-lantern-01')]: { results: [model] }, [glbUrl]: () => reply(GLB) }, { [MODEL_FILES.gltf]: { filePath: glbUrl } });
  const { lib } = library(dir, ok.fn);
  const res = await lib.importAsset({ source: 'blenderkit', id: 'bk-lantern-01', name: 'Lantern', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(ok.downloads[0].headers.Authorization, `Bearer ${KEYS.blenderkit}`);

  const refused = bkFetch({ [bkInfoUrl('bk-lantern-01')]: { results: [model] } }, { [MODEL_FILES.gltf]: () => reply({ detail: `bad token ${KEYS.blenderkit}` }, 403) });
  const bad = await library(tempRepo(), refused.fn).lib.importAsset({ source: 'blenderkit', id: 'bk-lantern-01', name: 'Lantern', kind: 'prop' });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /refused the API key \(HTTP 403\)/);
  assert.equal(JSON.stringify(bad).includes(KEYS.blenderkit), false);
});

test('BlenderKit: file picks by fileType - glTF only for models, EXR at the resolution or the nearest lower one, never 8K', async () => {
  const hdriFiles = {
    thumbnail: 'cccc0000-0000-0000-0000-000000000001', resolution_8K: 'cccc0000-0000-0000-0000-000000000008',
    resolution_4K: 'cccc0000-0000-0000-0000-000000000004', resolution_1K: 'cccc0000-0000-0000-0000-000000000002', resolution_0_5K: 'cccc0000-0000-0000-0000-000000000005',
  };
  const signedOf = (uuid) => ({ filePath: `https://assets.blendkit.com/hdr/${uuid}.exr` });
  const signed = Object.fromEntries(Object.values(hdriFiles).map((u) => [u, signedOf(u)]));
  const records = {
    'bk-sky-01': bkRecord('bk-sky-01', 'hdr', 'cc0', hdriFiles),
    'bk-sky-02': bkRecord('bk-sky-02', 'hdr', 'cc0', { resolution_8K: hdriFiles.resolution_8K }),
    'bk-crate-01': bkRecord('bk-crate-01', 'model', 'cc0', { blend: MODEL_FILES.blend, gltf_godot: MODEL_FILES.gltf_godot, thumbnail: MODEL_FILES.thumbnail }),
  };
  const fake = bkFetch(Object.fromEntries(Object.entries(records).map(([id, r]) => [bkInfoUrl(id), { results: [r] }])), signed);
  const bk = S.createFreeSources({ fetch: fake.fn }).blenderkit;
  assert.deepEqual(bk.types, ['model', 'hdri']);

  const sky = await bk.info('bk-sky-01');
  assert.equal(sky.type, 'hdri');
  const at = async (resolution) => (await bk.files(sky, { resolution })).files[0];
  assert.deepEqual(await at('4k'), { url: signedOf(hdriFiles.resolution_4K).filePath, name: 'bk-sky-01.exr', main: true });
  assert.equal((await at('2k')).url, signedOf(hdriFiles.resolution_1K).filePath, '2K missing -> 1K');
  assert.equal((await at(undefined)).url, signedOf(hdriFiles.resolution_1K).filePath, 'default 2k');
  assert.equal((await at('1k')).url, signedOf(hdriFiles.resolution_1K).filePath);
  assert.ok(fake.downloads.every((d) => d.uuid !== hdriFiles.resolution_8K && d.uuid !== hdriFiles.thumbnail));

  const only8k = await bk.info('bk-sky-02');
  await assert.rejects(() => bk.files(only8k, { resolution: '4k' }), (err) => err.code === 'noFile' && /no EXR at 4K or lower/.test(err.message));
  const crate = await bk.info('bk-crate-01');
  await assert.rejects(() => bk.files(crate), (err) => err.code === 'noFile' && err.message === 'this BlenderKit model has no glTF file');
  assert.ok(fake.downloads.every((d) => d.uuid !== hdriFiles.resolution_8K), 'never 8K');
});

test('BlenderKit: an HDRI import writes a .exr; type texture is badType', async () => {
  const dir = tempRepo();
  const sky = bkRecord('bk-sky-01', 'hdr', 'royalty_free', { resolution_2K: 'dddd0000-0000-0000-0000-000000000002', resolution_1K: 'dddd0000-0000-0000-0000-000000000001' });
  const exrUrl = 'https://assets.blendkit.com/hdr/sky_2k.exr?sig=1';
  const fake = bkFetch({
    [bkSearchUrl('sky asset_type:hdr is_free:true')]: { results: [sky] },
    [bkInfoUrl('bk-sky-01')]: { results: [sky] },
    [exrUrl]: () => reply(EXR),
  }, { 'dddd0000-0000-0000-0000-000000000002': { filePath: exrUrl } });
  const { lib } = library(dir, fake.fn, { keys: {} });
  assert.deepEqual((await lib.search({ source: 'blenderkit', query: 'sky', type: 'hdri' })).results.map((r) => r.id), ['bk-sky-01']);
  const res = await lib.importAsset({ source: 'blenderkit', id: 'bk-sky-01', name: 'Dusk Sky', kind: 'texture', resolution: '2k' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.files.length, 1);
  assert.match(res.files[0], /\/dusk-sky\.exr$/);

  const tex = await lib.search({ source: 'blenderkit', query: 'rust', type: 'texture' });
  assert.equal(tex.error, 'badType');
});

test('BlenderKit: signed links are pinned to its file hosts; a broken download reply is a clear error', async () => {
  const model = bkRecord('bk-lantern-01', 'model', 'cc0', MODEL_FILES);
  const routes = { [bkInfoUrl('bk-lantern-01')]: { results: [model] } };
  const filesWith = async (signedReply) => {
    const bk = S.createFreeSources({ fetch: bkFetch(routes, { [MODEL_FILES.gltf]: signedReply }).fn, keys: { get: () => KEYS.blenderkit } }).blenderkit;
    return bk.files(await bk.info('bk-lantern-01'));
  };
  const offHost = (err) => err.code === 'badReply' && /no download link on its file hosts/.test(err.message);
  await assert.rejects(() => filesWith({ filePath: 'https://evil.example.com/lantern.glb' }), offHost);
  await assert.rejects(() => filesWith({ filePath: 'http://assets.blendkit.com/lantern.glb' }), offHost);
  await assert.rejects(() => filesWith({ filePath: 'https://assets.blendkit.com.evil.com/lantern.glb' }), offHost);
  await assert.rejects(() => filesWith({ filePath: 'https://user@assets.blendkit.com/lantern.glb' }), offHost);
  // filePath off-host, a later filePaths[] entry on an allowed host is taken.
  const second = await filesWith({ filePath: 'https://evil.example.com/x.glb', filePaths: [{ url: 'https://cdn.example.com/y.glb' }, { url: 'https://assets.blenderkit.com/z.glb' }] });
  assert.equal(second.files[0].url, 'https://assets.blenderkit.com/z.glb');
  // A signed path without a known extension falls back to .glb for a model.
  assert.equal((await filesWith({ filePath: 'https://assets.blendkit.com/blob/123' })).files[0].name, 'bk-lantern-01.glb');
  await assert.rejects(() => filesWith(() => reply(Buffer.from(`<html>${KEYS.blenderkit}</html>`))), (err) => err.code === 'badReply' && /BlenderKit download answered without JSON/.test(err.message) && !err.message.includes(KEYS.blenderkit));
  await assert.rejects(() => filesWith(['not', 'a', 'record']), (err) => err.code === 'badReply' && /unusable download record/.test(err.message));
  // A download endpoint that is not on BlenderKit's API is never called (the key could go there).
  const foreign = { ...model, files: [{ fileType: 'gltf', downloadUrl: 'https://evil.example.com/api/v1/downloads/aaaa0000-0000-0000-0000-000000000004/' }] };
  const fake = bkFetch({ [bkInfoUrl('bk-lantern-01')]: { results: [foreign] } }, {});
  const bk = S.createFreeSources({ fetch: fake.fn, keys: { get: () => KEYS.blenderkit } }).blenderkit;
  await assert.rejects(async () => bk.files(await bk.info('bk-lantern-01')), (err) => err.code === 'noFile');
  assert.ok(fake.calls.every((c) => !c.url.startsWith('https://evil.example.com')));
});

test('BlenderKit: license mapping - cc0 / cc_zero -> CC0, cc_by -> CC-BY 4.0, royalty_free / roy_free -> BlenderKit Royalty Free; search and info agree', async () => {
  const cases = [['cc0', 'CC0'], ['cc_zero', 'CC0'], ['cc_by', 'CC-BY 4.0'], ['royalty_free', L.BLENDERKIT_ROYALTY_FREE], ['roy_free', L.BLENDERKIT_ROYALTY_FREE], ['ROYALTY_FREE', L.BLENDERKIT_ROYALTY_FREE]];
  const records = cases.map(([lic], i) => bkRecord(`bk-asset-0${i}`, 'model', lic, MODEL_FILES));
  const routes = { [bkSearchUrl('lamp asset_type:model is_free:true')]: { results: records } };
  for (const r of records) routes[bkInfoUrl(r.assetBaseId)] = { results: [r] };
  const bk = S.createFreeSources({ fetch: bkFetch(routes, {}).fn }).blenderkit;
  const searched = await bk.search('lamp', { type: 'model' });
  assert.deepEqual(searched.map((i) => i.license), cases.map(([, want]) => want));
  for (const r of records) assert.equal((await bk.info(r.assetBaseId)).license, searched.find((i) => i.id === r.assetBaseId).license);
  // No license stated is never guessed from isFree.
  const bare = bkRecord('bk-bare-01', 'model', undefined, MODEL_FILES);
  const bareBk = S.createFreeSources({ fetch: bkFetch({ [bkInfoUrl('bk-bare-01')]: { results: [bare] } }, {}).fn }).blenderkit;
  assert.equal((await bareBk.info('bk-bare-01')).license, '');
});

test('BlenderKit review hardening: ":" in words is no operator, 0_5K is the last fallback, the first duplicate fileType wins, signed URLs are normalized', async () => {
  const hdri = bkRecord('bk-sky-03', 'hdr', 'cc0', { resolution_8K: 'eeee0000-0000-0000-0000-000000000008', resolution_0_5K: 'eeee0000-0000-0000-0000-000000000005' });
  const dup = { ...bkRecord('bk-dup-01', 'model', 'cc0', {}), files: [{ fileType: 'gltf', downloadUrl: bkEndpoint('ffff0000-0000-0000-0000-000000000001') }, { fileType: 'gltf', downloadUrl: bkEndpoint('ffff0000-0000-0000-0000-000000000002') }] };
  const odd = bkRecord('bk-odd-01', 'constructor', 'constructor', MODEL_FILES);
  const fake = bkFetch({
    [bkSearchUrl('lamp is_free false asset_type:model is_free:true')]: { results: [odd] },
    [bkInfoUrl('bk-sky-03')]: { results: [hdri] },
    [bkInfoUrl('bk-dup-01')]: { results: [dup] },
  }, {
    'eeee0000-0000-0000-0000-000000000005': { filePath: 'https://assets.blendkit.com/hdr/sky_half.exr' },
    'ffff0000-0000-0000-0000-000000000001': { filePath: 'https://assets.blendkit.com\\first.glb' },
  });
  const bk = S.createFreeSources({ fetch: fake.fn }).blenderkit;
  assert.deepEqual(await bk.search('lamp is_free:false', { type: 'model' }), [], 'the query word lost its ":", an unknown type is dropped');
  assert.equal((await bk.files(await bk.info('bk-sky-03'), { resolution: '4k' })).files[0].url, 'https://assets.blendkit.com/hdr/sky_half.exr');
  assert.equal((await bk.files(await bk.info('bk-dup-01'))).files[0].url, 'https://assets.blendkit.com/first.glb', 'first gltf entry, normalized URL');
});

test('only the BlenderKit client may carry the BlenderKit Royalty Free label; another library stating it is refused', async () => {
  const dir = tempRepo();
  const routes = { [`${SF}/models/${UID}`]: sfModel(UID, 'Lamp', 'x', L.BLENDERKIT_ROYALTY_FREE) };
  const { lib } = library(dir, fakeFetch(routes).fn);
  const res = await lib.importAsset({ source: 'sketchfab', id: UID, name: 'Lamp', kind: 'prop' });
  assert.equal(res.error, 'licenseRefused');
  assert.match(res.detail, /no license stated/);
});

test('Lots of Sounds: search and import work without a key', async () => {
  const dir = tempRepo();
  const LOS = 'https://api.lotsofsounds.com/api/v1';
  const losRecord = { id: 'fs-900', name: 'Clock Tick', tags: ['clock', 'tick'], stream_url: '/api/v1/sounds/sample/fs-900/stream.wav' };
  const routes = {
    [`${LOS}/sounds/sample?q=tick&limit=10`]: { data: [losRecord] },
    [`${LOS}/sounds/sample/fs-900`]: { data: losRecord },
    'https://api.lotsofsounds.com/api/v1/sounds/sample/fs-900/stream.wav': () => reply(WAV),
  };
  const fake = fakeFetch(routes);
  const { lib } = library(dir, fake.fn, { keys: {} });

  const losFound = await lib.search({ source: 'lotsofsounds', query: 'tick' });
  assert.deepEqual(losFound.results.map((r) => [r.id, r.license]), [['fs-900', 'CC0']]);
  const losImp = await lib.importAsset({ source: 'lotsofsounds', id: 'fs-900', name: 'Clock Tick', kind: 'audio' });
  assert.equal(losImp.ok, true, JSON.stringify(losImp));
  assert.deepEqual(losImp.files, [`${ART}/Audio/clock-tick.wav`]);
});

// ---- keys never in an error -------------------------------------------------------------

test('a key never appears in an error: thrown fetch errors, 401 answers and bad replies are redacted', async () => {
  const dir = tempRepo();
  const echo = (url, init) => { throw new Error(`socket hang up for ${init.headers.Authorization}`); };
  const routes = {
    [`${FS}/sounds/7/?fields=${FIELDS}`]: echo,
    [`${FS}/sounds/8/?fields=${FIELDS}`]: () => reply({ detail: 'Invalid token' }, 401),
    [`${PP}/model/x1`]: (url, init) => reply(Buffer.from(`not json ${init.headers['x-auth-token']}`)),
  };
  const { lib } = library(dir, fakeFetch(routes).fn);
  const results = [
    await lib.importAsset({ source: 'freesound', id: '7', kind: 'audio' }),
    await lib.importAsset({ source: 'freesound', id: '8', kind: 'audio' }),
    await lib.importAsset({ source: 'polypizza', id: 'x1', kind: 'prop' }),
    await lib.search({ source: 'freesound', query: 'anything' }),
  ];
  for (const r of results) {
    assert.equal(r.ok, false);
    const text = JSON.stringify(r);
    for (const key of Object.values(KEYS)) assert.equal(text.includes(key), false, `key leaked in ${text}`);
  }
  assert.match(results[0].detail, /Freesound is not reachable \(socket hang up for Token \[key\]\)/);
  assert.equal(results[1].error, 'keyRefused');
  assert.equal(S.redact(`a ${KEYS.sketchfab} b`, Object.values(KEYS)), 'a [key] b');
});

test('no official API: Kenney and OpenGameArt answer noApi; bad ids never reach a URL', async () => {
  const dir = tempRepo();
  const fake = fakeFetch({});
  const { lib } = library(dir, fake.fn);
  assert.equal((await lib.search({ source: 'kenney', query: 'tiles' })).error, 'noApi');
  assert.match((await lib.importAsset({ source: 'opengameart', id: '1', kind: 'sprite' })).detail, /no official API/);
  assert.equal((await lib.importAsset({ source: 'polyhaven', id: '../etc', kind: 'texture' })).error, 'badId');
  assert.equal((await lib.importAsset({ source: 'sketchfab', id: 'x/y', kind: 'prop' })).error, 'badId');
  assert.equal(fake.calls.length, 0);
});

test('a download whose bytes are not what the name says is refused and nothing is written', async () => {
  const dir = tempRepo();
  const routes = { ...polyHavenRoutes, 'https://dl.polyhaven.org/file/dusk_sky_2k.hdr': () => reply(Buffer.from('<html>login</html>')) };
  const { lib } = library(dir, fakeFetch(routes).fn);
  const res = await lib.importAsset({ source: 'polyhaven', id: 'dusk_sky', kind: 'texture' });
  assert.equal(res.error, 'downloadFailed');
  assert.match(res.detail, /not a real \.hdr file/);
  assert.equal(exists(dir, L.LEDGER_FILE), false);
});

// ---- licenses ---------------------------------------------------------------------------

test('classifyLicense: CC0 and CC-BY pass; NC, ND, SA, Sampling+ and unknown are refused with a reason', () => {
  const ok = (raw) => L.classifyLicense(raw);
  assert.deepEqual(ok('CC0 1.0'), { ok: true, license: 'CC0', attribution: false });
  assert.deepEqual(ok('https://creativecommons.org/publicdomain/zero/1.0/'), { ok: true, license: 'CC0', attribution: false });
  assert.deepEqual(ok('Creative Commons 0'), { ok: true, license: 'CC0', attribution: false });
  assert.deepEqual(ok('http://creativecommons.org/licenses/by/3.0/'), { ok: true, license: 'CC-BY 3.0', attribution: true });
  assert.deepEqual(ok('CC Attribution'), { ok: true, license: 'CC-BY', attribution: true });
  assert.deepEqual(ok('Attribution'), { ok: true, license: 'CC-BY', attribution: true });
  assert.deepEqual(ok(L.FREE_COMMERCIAL), { ok: true, license: L.FREE_COMMERCIAL, attribution: false });
  for (const [raw, why] of [
    ['CC Attribution-NonCommercial', /NC/],
    ['http://creativecommons.org/licenses/by-nd/4.0/', /ND/],
    ['CC BY-SA 4.0', /SA/],
    ['Sampling+', /Sampling/],
    ['Editorial', /editorial/],
    ['Standard', /not on the allowed list/],
    ['', /no license/],
    [null, /no license/],
  ]) {
    const res = L.classifyLicense(raw);
    assert.equal(res.ok, false, String(raw));
    assert.match(res.reason, why);
  }
});

test('ripReason: the art references and commercial games are refused by title or tag, everyday words are not', () => {
  assert.match(L.ripReason({ name: 'Katana Zero Dragon sprite' }), /katana zero/);
  assert.match(L.ripReason({ name: 'Anime girl', tags: ['ZZZ', 'fanart'] }), /zzz/);
  assert.match(L.ripReason({ name: 'Black Rock Shooter figure' }), /black rock shooter/);
  assert.match(L.ripReason({ name: 'Hero model', tags: ['Genshin Impact'] }), /genshin/);
  assert.match(L.ripReason({ name: 'Ripped from the game' }), /ripped/);
  assert.equal(L.ripReason({ name: 'Golden halo VFX', tags: ['portal', 'katana', 'zero gravity'] }), null);
});

test('the ledger: created with its header, a re-ledgered path replaces its row, text around the table kept', () => {
  const first = L.withLedgerRows(null, [{ name: 'A | B', source: 'https://x.test/a', author: 'Ann', license: 'CC0', path: 'Assets/G/Art/a.png' }]);
  assert.match(first, /^# Asset licenses\n/);
  assert.match(first, /\| Name \| Source URL \| Author \| License \| Path \|/);
  assert.equal(L.parseLedger(first).rows[0].name, 'A | B', 'a pipe in a cell is escaped and read back');
  const edited = `${first}\nNotes kept.\n`;
  const second = L.withLedgerRows(edited, [{ name: 'A2', source: 'https://x.test/a', author: 'Ann', license: 'CC-BY 4.0', path: 'Assets/G/Art/a.png' }, { name: 'C', source: '', author: 'Cy', license: 'CC0', path: 'Assets/G/Art/c/' }]);
  assert.deepEqual(L.parseLedger(second).rows.map((r) => r.name), ['A2', 'C']);
  assert.match(second, /Notes kept\./);
  assert.equal(L.creditsText(L.parseLedger(second).rows).includes('"A2" by Ann - CC-BY 4.0 - https://x.test/a'), true);
  assert.equal(L.creditsText([{ name: 'C', author: 'Cy', license: 'CC0', path: 'p' }]), null);
});

// ---- Critic -----------------------------------------------------------------------------

test('Critic: an art file without a ledger row gets one high card; prefabs, .meta and ledgered folders are covered', () => {
  const dir = tempRepo();
  const write = (rel, data = 'x') => {
    fs.mkdirSync(path.dirname(path.join(dir, ...rel.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(dir, ...rel.split('/')), data);
  };
  write(`${ART}/Props/crate.fbx`);
  write(`${ART}/Props/crate.prefab`);
  write(`${ART}/Props/crate.fbx.meta`);
  write(`${ART}/Textures/brick/brick_color.jpg`);
  write(`${ART}/Sprites/mystery.png`);
  write('Assets/Scripts/Player.cs');
  write(L.LEDGER_FILE, L.withLedgerRows(null, [
    { name: 'Crate', source: 'art/blender/crate.blend', author: 'LunaCore', license: L.GENERATED_LICENSE, path: `${ART}/Props/crate.fbx` },
    { name: 'Brick', source: 'https://ambientcg.com/view?id=B', author: 'ambientCG', license: 'CC0', path: `${ART}/Textures/brick/` },
  ]));
  assert.deepEqual(L.unledgeredArt(dir), [`${ART}/Sprites/mystery.png`]);
  const cards = L.ledgerCards(dir, []);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].severity, 'high');
  assert.match(cards[0].text, /^Asset license: 1 art file\(s\) have no row in design\/ASSET_LICENSES\.md/);
  assert.match(cards[0].details, /mystery\.png/);
  // An open card about it is updated, not doubled.
  assert.equal(L.ledgerCards(dir, [{ at: 77, text: 'Asset license: 3 art file(s) have no row in design/ASSET_LICENSES.md' }])[0].updatesCardId, 77);
  write(L.LEDGER_FILE, L.withLedgerRows(read(dir, L.LEDGER_FILE), [{ name: 'Mystery', source: 'https://x.test/m', author: 'Me', license: 'CC0', path: `${ART}/Sprites/mystery.png` }]));
  assert.deepEqual(L.ledgerCards(dir, []), []);
});

// ---- zip --------------------------------------------------------------------------------

test('zip: only allowed files come out, flat; a path outside its folder and a damaged entry are refused', async () => {
  const ok = await Z.readZip(makeZip([{ name: 'maps/a.jpg', data: JPG }, { name: 'b.usda', data: Buffer.from('x') }]), { allowExt: ['jpg'] });
  assert.deepEqual(ok.map((e) => e.name), ['a.jpg']);
  assert.deepEqual(ok[0].data, JPG);
  await assert.rejects(() => Z.readZip(makeZip([{ name: '../evil.jpg', data: JPG }]), { allowExt: ['jpg'] }), /outside its folder/);
  await assert.rejects(() => Z.readZip(makeZip([{ name: 'C:/evil.jpg', data: JPG }]), { allowExt: ['jpg'] }), /outside its folder/);
  const damaged = makeZip([{ name: 'a.jpg', data: JPG, deflate: false }]);
  damaged[30 + 'a.jpg'.length] ^= 0xff;
  await assert.rejects(() => Z.readZip(damaged, { allowExt: ['jpg'] }), /damaged/);
  await assert.rejects(() => Z.readZip(makeZip([{ name: 'big.jpg', data: Buffer.alloc(5000, 1) }]), { allowExt: ['jpg'], maxFileBytes: 100 }), /larger than/);
  await assert.rejects(() => Z.readZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
});

test('zip keepDirs: a glTF set keeps its safe folders; device names and deep paths are skipped', async () => {
  const gltf = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }));
  const entries = await Z.readZip(makeZip([
    { name: 'scene.gltf', data: gltf },
    { name: 'textures/Body_baseColor.png', data: JPG },
    { name: 'textures/con.png', data: JPG },
    { name: 'a/b/c/d/e.png', data: JPG },
    { name: 'license.txt', data: Buffer.from('CC-BY') },
  ]), { allowExt: ['gltf', 'png'], keepDirs: true });
  assert.deepEqual(entries.map((e) => e.name), ['scene.gltf', 'textures/Body_baseColor.png']);
  assert.equal(Z.isSafeName('NUL.txt'), false);
  assert.equal(Z.isSafeName('trailing.'), false);
  assert.equal(Z.isSafeName('Body_baseColor.png'), true);
});

// ---- review hardening -------------------------------------------------------------------

test('classifyLicense: free text that only mentions a free license is refused; library text cannot claim LunaCore labels', () => {
  for (const raw of ['Attribution, personal use only', 'CC0 NonCommercial', 'CC-BY for non commercial projects', 'Free for personal use', 'CC0 but no commercial use', 'see CC0 in readme']) {
    assert.equal(L.classifyLicense(raw).ok, false, raw);
  }
  assert.equal(L.classifyLicense(L.GENERATED_LICENSE).ok, true, 'the pipeline labels its own generated files');
  assert.equal(L.classifyLicense(L.GENERATED_LICENSE, { library: true }).ok, false);
  assert.equal(L.classifyLicense(L.FREE_COMMERCIAL, { library: true }).ok, false);
  assert.equal(L.classifyLicense('CC-BY 4.0', { library: true }).license, 'CC-BY 4.0');
});

test('classifyLicense: the named BlenderKit Royalty Free label passes from a library, exact match only', () => {
  const rf = { ok: true, license: L.BLENDERKIT_ROYALTY_FREE, attribution: false };
  assert.deepEqual(L.classifyLicense('BlenderKit Royalty Free', { library: true }), rf);
  assert.deepEqual(L.classifyLicense('BlenderKit Royalty Free'), rf);
  for (const raw of ['royalty_free', 'Royalty Free', 'blenderkit royalty free', 'BlenderKit Royalty Free (personal use)']) {
    assert.equal(L.classifyLicense(raw, { library: true }).ok, false, raw);
  }
  assert.equal(L.classifyLicense(L.FREE_COMMERCIAL, { library: true }).ok, false, 'generic library text is still refused');
  assert.equal(L.creditsText([{ name: 'Lamp', author: 'Kit', license: L.BLENDERKIT_ROYALTY_FREE, path: 'p' }]), null, 'no credit line needed');
});

test('ripReason reads the description too', () => {
  assert.match(L.ripReason({ name: 'Sword', tags: ['blade'], description: 'Extracted from Zenless Zone Zero game files' }), /zenless zone zero/);
  assert.equal(L.ripReason({ name: 'Sword', tags: ['blade'], description: 'A plain low-poly sword I made in Blender.' }), null);
});

test('the ledger rewrite keeps hand-added columns, rows without a path and CRLF; cells lose markdown and tags', () => {
  const hand = [
    '# Licenses',
    '',
    '| Name | Source URL | Author | License | Path | Notes |',
    '|---|---|---|---|---|---|',
    '| Old | https://x.test/o | Ann | CC0 | Assets/G/Art/old.png | bought 2025 |',
    '| Pack notes | | | | | see the pack readme |',
    '',
  ].join('\r\n');
  const next = L.withLedgerRows(hand, [
    { name: 'Old v2', source: 'https://x.test/o', author: 'Ann', license: 'CC0', path: 'Assets/G/Art/old.png' },
    { name: '[click](https://evil.test) <b>x</b>', source: 'https://x.test/n', author: '`Bob`', license: 'CC-BY 4.0', path: 'Assets/G/Art/new.png' },
  ]);
  assert.equal(next.includes('\r\n'), true);
  assert.equal(next.split('\r\n').every((line) => !line.includes('\n')), true, 'no bare LF mixed in');
  assert.match(next, /\| Old v2 \| https:\/\/x\.test\/o \| Ann \| CC0 \| Assets\/G\/Art\/old\.png \| bought 2025 \|/);
  assert.match(next, /\| Pack notes \| \| \| \| \| see the pack readme \|/);
  const added = next.split('\r\n').find((line) => line.includes('new.png'));
  assert.equal(/[[\]<>`]/.test(added), false, added);
  assert.equal(added.split('|').length, 8, 'six cells, as in the header');
  assert.equal(L.creditsText(L.parseLedger(next).rows).includes('<'), false);
});

test('a replaced path drops its stale duplicate rows, so an old CC-BY credit cannot survive', () => {
  const hand = L.withLedgerRows(null, [{ name: 'Tree', source: 'https://x.test/t', author: 'Ann', license: 'CC-BY 4.0', path: 'Assets/G/Art/tree.glb' }]);
  const doubled = hand.replace(/(\| Tree .*\n)/, '$1$1');
  assert.equal(L.parseLedger(doubled).rows.length, 2);
  const next = L.withLedgerRows(doubled, [{ name: 'Tree', source: 'https://x.test/t2', author: 'Bo', license: 'CC0', path: 'Assets/G/Art/tree.glb' }]);
  assert.deepEqual(L.parseLedger(next).rows.map((r) => r.license), ['CC0']);
  assert.equal(L.creditsText(L.parseLedger(next).rows), null);
});

test('a Critic scan cut off by its depth cap still holds SHIP with a card', () => {
  const dir = tempRepo();
  const deep = ['Assets', 'Art', ...Array.from({ length: 18 }, (_, i) => `d${i}`)];
  fs.mkdirSync(path.join(dir, ...deep), { recursive: true });
  fs.writeFileSync(path.join(dir, ...deep, 'hidden.png'), 'x');
  const cards = L.ledgerCards(dir, []);
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /art scan of Assets\/ was cut off/);
  assert.match(cards[0].details, /by hand/);
});

test('the Critic card says a folder row covers a whole pack', () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, ...`${ART}/Sprites`.split('/')), { recursive: true });
  fs.writeFileSync(path.join(dir, ...`${ART}/Sprites/a.png`.split('/')), 'x');
  assert.match(L.ledgerCards(dir, [])[0].details, /path ending in "\/".*covers every file under it/);
});

test('import never reuses a name whose prefab or material is there; a dots-only query is refused', async () => {
  const dir = tempRepo();
  fs.mkdirSync(path.join(dir, ...`${ART}/Props`.split('/')), { recursive: true });
  fs.writeFileSync(path.join(dir, ...`${ART}/Props/katana-sword.prefab`.split('/')), 'hand-made prefab');
  const { lib } = library(dir, fakeFetch(sketchfabRoutes().routes).fn);
  const res = await lib.importAsset({ source: 'sketchfab', id: UID, name: 'Katana Sword', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.files, [`${ART}/Props/katana-sword-v2.glb`]);
  assert.equal(read(dir, `${ART}/Props/katana-sword.prefab`), 'hand-made prefab');
  assert.equal((await lib.search({ source: 'sketchfab', query: '...' })).error, 'badQuery');
});

test('Sketchfab without a GLB: the glTF zip comes in with its folders, the .gltf is the main file', async () => {
  const dir = tempRepo();
  const gltf = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'textures/Body_baseColor.png' }] }));
  const zip = makeZip([
    { name: 'scene.gltf', data: gltf },
    { name: 'scene.bin', data: Buffer.alloc(16, 3) },
    { name: 'textures/Body_baseColor.png', data: pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
    { name: 'license.txt', data: Buffer.from('CC-BY') },
  ]);
  const sf = sketchfabRoutes();
  const routes = {
    ...sf.routes,
    [`${SF}/models/${UID}/download`]: () => reply({ gltf: { url: 'https://sketchfab-prod-media.s3.amazonaws.com/archives/katana.zip?sig=abc' } }),
    'https://sketchfab-prod-media.s3.amazonaws.com/archives/katana.zip?sig=abc': () => reply(zip),
  };
  const { lib, unity } = library(dir, fakeFetch(routes).fn);
  const res = await lib.importAsset({ source: 'sketchfab', id: UID, name: 'Katana Sword', kind: 'prop' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const root = `${ART}/Props/katana-sword`;
  assert.deepEqual(res.files, [`${root}/scene.gltf`, `${root}/scene.bin`, `${root}/textures/Body_baseColor.png`]);
  assert.equal(res.main, `${root}/scene.gltf`);
  assert.equal(ledgerRows(dir)[0].path, `${root}/`);
  // A .gltf gets its prefab like any model.
  assert.deepEqual(unity.calls.at(-1), { command: 'prefab create', parameters: unity.calls.at(-1).parameters });
  assert.equal(unity.calls.at(-1).parameters.path, `${root}/scene.prefab`);
});

test('a credits file that cannot be written restores the ledger and takes the files and their folders out', async () => {
  const dir = tempRepo();
  // A folder where the credits file should go: the write fails.
  fs.mkdirSync(path.join(dir, ...L.CREDITS_FILE.split('/')), { recursive: true });
  const sf = sketchfabRoutes();
  const gltf = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }));
  const zip = makeZip([{ name: 'scene.gltf', data: gltf }, { name: 'textures/t.jpg', data: JPG }]);
  const routes = {
    ...sf.routes,
    [`${SF}/models/${UID}/download`]: () => reply({ gltf: { url: 'https://sketchfab-prod-media.s3.amazonaws.com/archives/k.zip' } }),
    'https://sketchfab-prod-media.s3.amazonaws.com/archives/k.zip': () => reply(zip),
  };
  const { lib } = library(dir, fakeFetch(routes).fn);
  const res = await lib.importAsset({ source: 'sketchfab', id: UID, name: 'Katana Sword', kind: 'prop' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ledgerFailed', JSON.stringify(res));
  assert.equal(exists(dir, L.LEDGER_FILE), false, 'a CC-BY row never stays without its credit');
  assert.equal(exists(dir, `${ART}/Props/katana-sword`), false, 'the files and the folders they made are gone');
});

test('two imports at once never pick the same name', async () => {
  const dir = tempRepo();
  const { lib } = library(dir, fakeFetch(polyHavenRoutes).fn);
  const [a, b] = await Promise.all([
    lib.importAsset({ source: 'polyhaven', id: 'dusk_sky', name: 'Sky', kind: 'texture' }),
    lib.importAsset({ source: 'polyhaven', id: 'dusk_sky', name: 'Sky', kind: 'texture' }),
  ]);
  assert.deepEqual([a.main, b.main].sort(), [`${ART}/Textures/sky-v2.hdr`, `${ART}/Textures/sky.hdr`]);
  assert.equal(ledgerRows(dir).length, 2);
});

// ---- the key store ----------------------------------------------------------------------

/** A fake safeStorage: reversible, but never the plain text on disk. */
function fakeSafeStorage({ available = true, backend = 'dpapi' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
    decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
  };
}

test('key store: keys are encrypted on disk, status is booleans only, a bad key or source is refused', () => {
  const dir = tempRepo();
  const store = K.createAssetKeyStore({ dir: () => dir, safeStorage: () => fakeSafeStorage() });
  assert.deepEqual(store.set('freesound', KEYS.freesound), { ok: true });
  assert.equal(store.get('freesound'), KEYS.freesound);
  const onDisk = fs.readFileSync(path.join(dir, K.STORE_FILE), 'utf8');
  assert.equal(onDisk.includes(KEYS.freesound), false);
  assert.deepEqual(store.status(), { ok: true, keys: { sketchfab: false, polypizza: false, freesound: true, smithsonian: false, blenderkit: false, lotsofsounds: false }, persisted: true });
  assert.equal(store.set('freesound', 'short').ok, false);
  assert.equal(store.set('kenney', KEYS.freesound).reason, 'bad-source');
  assert.deepEqual(store.secrets(), [KEYS.freesound]);
  // A fresh store reads the encrypted file back.
  assert.equal(K.createAssetKeyStore({ dir: () => dir, safeStorage: () => fakeSafeStorage() }).get('freesound'), KEYS.freesound);
  assert.deepEqual(store.set('freesound', null), { ok: true });
  assert.equal(store.get('freesound'), null);
});

test('key store: without real encryption (basic_text) a key lives in memory only, never in a plain file', () => {
  const dir = tempRepo();
  const store = K.createAssetKeyStore({ dir: () => dir, safeStorage: () => fakeSafeStorage({ backend: 'basic_text' }) });
  store.set('sketchfab', KEYS.sketchfab);
  assert.equal(store.get('sketchfab'), KEYS.sketchfab);
  assert.equal(fs.existsSync(path.join(dir, K.STORE_FILE)), false);
  assert.equal(store.status().persisted, false);
});

test('key IPC: status never carries a key; a malformed request is refused', async () => {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const dir = tempRepo();
  K.registerAssetKeyIpc({ ipcMain, keys: K.createAssetKeyStore({ dir: () => dir, safeStorage: () => fakeSafeStorage() }) });
  const saved = await handlers['lunaswork:setAssetKey'](null, { source: 'polypizza', key: KEYS.polypizza });
  assert.equal(saved.keys.polypizza, true);
  assert.equal(JSON.stringify(saved).includes(KEYS.polypizza), false);
  assert.equal(JSON.stringify(await handlers['lunaswork:assetKeys']()).includes(KEYS.polypizza), false);
  assert.equal((await handlers['lunaswork:setAssetKey'](null, { source: 'polypizza', key: 42 })).reason, 'bad-request');
  assert.equal((await handlers['lunaswork:setAssetKey'](null, 'x')).reason, 'bad-request');
  // What preload sends for a key that is neither a string nor null.
  assert.equal((await handlers['lunaswork:setAssetKey'](null, { source: 'polypizza', key: undefined })).reason, 'bad-request');
  assert.equal(K.createAssetKeyStore({ dir: () => dir, safeStorage: () => fakeSafeStorage() }).get('polypizza'), KEYS.polypizza, 'the stored key was not cleared');
});
