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
function library(dir, fetch, { keys = KEYS, execFile } = {}) {
  const unity = { calls: [], exec: async (command, parameters) => { unity.calls.push({ command, parameters }); return { ok: true }; } };
  const logged = [];
  const pipe = P.createAssetPipeline({ repoPath: dir, artRoot: ART, unity, recordSpend: () => ({ ok: true }), logAsset: (e) => logged.push(e), now: () => 1, execFile });
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

test('BlenderKit and Lots of Sounds: search and import work with or without optional keys', async () => {
  const dir = tempRepo();
  const BK = 'https://www.blenderkit.com/api/v1';
  const LOS = 'https://api.lotsofsounds.com/api/v1';
  const bkRecord = { assetBaseId: 'bk-lantern-01', displayName: 'Iron Lantern', assetType: 'model', isFree: true, license: 'cc0', author: { fullName: 'Kit Artist' }, tags: ['lantern'], files: [{ downloadUrl: 'https://cdn.blenderkit.com/files/bk-lantern-01.glb' }] };
  const losRecord = { id: 'fs-900', name: 'Clock Tick', tags: ['clock', 'tick'], stream_url: '/api/v1/sounds/sample/fs-900/stream.wav' };
  const routes = {
    [`${BK}/search/?query=lantern&asset_type=model&is_free=True&page_size=10`]: { results: [bkRecord] },
    [`${BK}/search/?query=${encodeURIComponent('asset_base_id:bk-lantern-01')}&is_free=True&page_size=1`]: { results: [bkRecord] },
    'https://cdn.blenderkit.com/files/bk-lantern-01.glb': () => reply(GLB),
    [`${LOS}/sounds/sample?q=tick&limit=10`]: { data: [losRecord] },
    [`${LOS}/sounds/sample/fs-900`]: { data: losRecord },
    'https://api.lotsofsounds.com/api/v1/sounds/sample/fs-900/stream.wav': () => reply(WAV),
  };
  const fake = fakeFetch(routes);
  const { lib } = library(dir, fake.fn, { keys: {} });

  const bkFound = await lib.search({ source: 'blenderkit', query: 'lantern', type: 'model' });
  assert.deepEqual(bkFound.results.map((r) => [r.id, r.license]), [['bk-lantern-01', 'CC0']]);
  const bkImp = await lib.importAsset({ source: 'blenderkit', id: 'bk-lantern-01', name: 'Iron Lantern', kind: 'prop' });
  assert.equal(bkImp.ok, true, JSON.stringify(bkImp));
  assert.deepEqual(bkImp.files, [`${ART}/Props/iron-lantern.glb`]);

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

// ---- source "all": fan-out over fake library clients -------------------------------------

const A = require('../src/lunasworkAssetFanout.js');

/** A fake library client: `answer` is an item list, an Error to reject with, or 'hang'. */
function fakeClient(id, types, answer, { searchKey = false } = {}) {
  const calls = [];
  return {
    id,
    label: `Fake ${id}`,
    types,
    needsKey: { search: searchKey, import: searchKey },
    calls,
    search: async (query, opts) => {
      calls.push({ query, ...opts });
      if (answer === 'hang') return new Promise(() => {});
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const fakeItem = (source, id, name, license, extra = {}) => ({
  source, id, name, author: 'someone', sourceUrl: `https://${source}.example.com/a/${id}`, license, tags: [], description: '', type: 'model', ...extra,
});

/** Only the given libraries have a client, so "all" finds those and no other. */
function fanoutLibrary(given, { keys = [], sourceTimeoutMs } = {}) {
  return F.createFreeAssets({
    shared: { repoPath: 'x', files: {} },
    sources: { ...given },
    download: async () => { throw new Error('no download in a search'); },
    hasKey: (id) => keys.includes(id),
    sourceTimeoutMs,
  });
}

test('search all: asks every library that has the type in parallel, keeps each result\'s source', async () => {
  const ph = fakeClient('polyhaven', ['hdri', 'texture', 'model'], [fakeItem('polyhaven', 'crate', 'Wooden Crate', 'CC0')]);
  const sf = fakeClient('sketchfab', ['model'], [fakeItem('sketchfab', 'u1', 'Crate Pile', 'CC Attribution 4.0')]);
  const fsd = fakeClient('freesound', ['audio'], [fakeItem('freesound', '9', 'Crate Drop', 'CC0', { type: 'audio' })], { searchKey: true });
  const lib = fanoutLibrary({ polyhaven: ph, sketchfab: sf, freesound: fsd }, { keys: ['freesound'] });
  const res = await lib.search({ source: 'all', query: 'wooden crate', limit: 5 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.source, 'all');
  assert.deepEqual([...res.searched].sort(), ['freesound', 'polyhaven', 'sketchfab']);
  assert.deepEqual(res.results.map((r) => `${r.source}:${r.id}`).sort(), ['freesound:9', 'polyhaven:crate', 'sketchfab:u1']);
  assert.deepEqual(ph.calls, [{ query: 'wooden crate', type: undefined, limit: 5 }]);
  assert.deepEqual([res.errors, res.skipped, res.total, res.truncated], [[], [], 3, false]);
});

test('search all: the type picks the libraries; an unknown type, query or source is refused', async () => {
  const ph = fakeClient('polyhaven', ['hdri', 'texture', 'model'], [fakeItem('polyhaven', 'sky', 'Sky', 'CC0', { type: 'hdri' })]);
  const sf = fakeClient('sketchfab', ['model'], []);
  const ls = fakeClient('lotsofsounds', ['audio'], []);
  const lib = fanoutLibrary({ polyhaven: ph, sketchfab: sf, lotsofsounds: ls });
  const res = await lib.search({ source: 'all', query: 'sky', type: 'hdri' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.searched, ['polyhaven']);
  assert.equal(ph.calls[0].type, 'hdri');
  assert.deepEqual([sf.calls.length, ls.calls.length], [0, 0]);
  assert.equal((await lib.search({ source: 'all', query: 'sky', type: 'mesh' })).error, 'badType');
  assert.equal((await lib.search({ source: 'all', query: '...' })).error, 'badQuery');
  const bad = await lib.search({ source: 'everything', query: 'sky' });
  assert.equal(bad.error, 'badSource');
  assert.match(bad.detail, /"all" or one of polyhaven/);
});

test('search all: a keyed library without its key is skipped with a note, never asked', async () => {
  const pp = fakeClient('polypizza', ['model'], [fakeItem('polypizza', 'p', 'Tree', 'CC0')], { searchKey: true });
  const sf = fakeClient('sketchfab', ['model'], [fakeItem('sketchfab', 's', 'Tree', 'CC0')]);
  const res = await fanoutLibrary({ polypizza: pp, sketchfab: sf }).search({ source: 'all', query: 'tree', type: 'model' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped, [{ source: 'polypizza', note: A.SKIPPED_NO_KEY }]);
  assert.equal(pp.calls.length, 0);
  assert.deepEqual(res.results.map((r) => r.source), ['sketchfab']);
  // A library that answers noKey itself is listed as skipped as well.
  const sfNoKey = fakeClient('sketchfab', ['model'], Object.assign(new Error('no token'), { code: 'noKey' }));
  const other = await fanoutLibrary({ sketchfab: sfNoKey, polyhaven: fakeClient('polyhaven', ['model'], []) }).search({ source: 'all', query: 'tree', type: 'model' });
  assert.equal(other.ok, true);
  assert.deepEqual(other.skipped, [{ source: 'sketchfab', note: A.SKIPPED_NO_KEY }]);
});

test('search all: one library rejecting or hanging does not fail the others; every one failing does', async () => {
  const ph = fakeClient('polyhaven', ['model'], [fakeItem('polyhaven', 'a', 'Anvil', 'CC0')]);
  const sf = fakeClient('sketchfab', ['model'], Object.assign(new Error('Sketchfab answered HTTP 500'), { code: 'http' }));
  const bk = fakeClient('blenderkit', ['model'], 'hang');
  const res = await fanoutLibrary({ polyhaven: ph, sketchfab: sf, blenderkit: bk }, { sourceTimeoutMs: 30 }).search({ source: 'all', query: 'anvil' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results.map((r) => r.id), ['a']);
  assert.deepEqual(res.errors.map((e) => [e.source, e.error]), [['sketchfab', 'http'], ['blenderkit', 'timeout']]);
  assert.match(res.errors[0].detail, /HTTP 500/);

  const all = await fanoutLibrary({ sketchfab: sf, blenderkit: bk }, { sourceTimeoutMs: 30 }).search({ source: 'all', query: 'anvil' });
  assert.deepEqual([all.ok, all.error, all.errors.length], [false, 'allFailed', 2]);
  const none = await fanoutLibrary({ polypizza: fakeClient('polypizza', ['model'], [], { searchKey: true }) }).search({ source: 'all', query: 'anvil' });
  assert.deepEqual([none.ok, none.error, none.skipped.length], [false, 'noSource', 1]);
});

test('search all: duplicates dropped, CC0 before CC-BY, then by query words; refused results kept', async () => {
  const ph = fakeClient('polyhaven', ['model'], [
    fakeItem('polyhaven', 'barrel', 'Barrel', 'CC Attribution 4.0'),
    fakeItem('polyhaven', 'barrel', 'Barrel', 'CC Attribution 4.0'),
    fakeItem('polyhaven', 'rusty', 'Rusty Metal Barrel', 'CC0', { tags: ['metal'] }),
    fakeItem('polyhaven', 'chair', 'Chair', 'CC0'),
  ]);
  const bk = fakeClient('blenderkit', ['model'], [
    // Poly Haven's asset listed again by another library: same name and page.
    fakeItem('blenderkit', 'other-id', 'Rusty metal barrel', 'CC0', { sourceUrl: 'https://polyhaven.example.com/a/rusty/' }),
    fakeItem('blenderkit', 'nc', 'Barrel NC', 'CC BY-NC 4.0'),
    fakeItem('blenderkit', 'b2', 'Metal Barrel', 'CC0'),
  ]);
  const res = await fanoutLibrary({ polyhaven: ph, blenderkit: bk }).search({ source: 'all', query: 'rusty metal barrel' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((r) => `${r.source}:${r.id}:${r.license}`), [
    'polyhaven:rusty:CC0',
    'blenderkit:b2:CC0',
    'polyhaven:chair:CC0',
    'polyhaven:barrel:CC-BY 4.0',
  ]);
  assert.deepEqual(res.refused.map((r) => [r.source, r.id]), [['blenderkit', 'nc']]);
  assert.match(res.refused[0].reason, /refused/);
});

test('single-source search is unchanged: no source field on results, no fan-out keys', async () => {
  const ph = fakeClient('polyhaven', ['model'], [fakeItem('polyhaven', 'a', 'Anvil', 'CC0')]);
  const sf = fakeClient('sketchfab', ['model'], [fakeItem('sketchfab', 'b', 'Anvil', 'CC0')]);
  const res = await fanoutLibrary({ polyhaven: ph, sketchfab: sf }).search({ source: 'polyhaven', query: 'anvil' });
  assert.deepEqual(Object.keys(res).sort(), ['next', 'note', 'ok', 'refused', 'results', 'source']);
  assert.equal(res.results[0].source, undefined);
  assert.equal(sf.calls.length, 0);
});

test('fan-out helpers: withTimeout rejects with code timeout, mergeResults caps the list, relevance counts distinct words', async () => {
  assert.equal(await A.withTimeout(Promise.resolve(7), 10_000, 'x'), 7);
  await assert.rejects(A.withTimeout(new Promise(() => {}), 5, 'Slow'), (err) => err.code === 'timeout' && /Slow did not answer/.test(err.message));
  const many = Array.from({ length: 50 }, (_, i) => ({ source: 's', id: String(i), name: `n${i}`, license: 'CC0', url: `https://e.example.com/${i}`, tags: [] }));
  assert.equal(A.mergeResults(many, 'n').length, A.MAX_MERGED_RESULTS);
  assert.equal(A.relevance(['red', 'brick'], { name: 'Red red wall', tags: ['brick'] }), 2);
  assert.deepEqual(['CC0', 'CC-BY 4.0', 'checked on import'].map(A.licenseRank), [0, 1, 2]);
});

// ---- the optional ffmpeg audio post-process ---------------------------------------------

/**
 * A fake child_process.execFile for ffmpeg. `outcome`: 'ok' writes `bytes` to
 * the output (the last token), 'enoent' fails like a missing binary, 'fail'
 * exits non-zero after leaving a partial output, 'empty' writes 0 bytes.
 */
function fakeFfmpeg(outcome, bytes) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const out = args[args.length - 1];
    if (outcome === 'enoent') return setImmediate(() => cb(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }), '', ''));
    if (outcome === 'fail') {
      fs.writeFileSync(out, Buffer.from('partial'));
      return setImmediate(() => cb(Object.assign(new Error('Command failed'), { code: 1 }), '', 'header\nError while filtering: Invalid argument\n'));
    }
    fs.writeFileSync(out, outcome === 'empty' ? Buffer.alloc(0) : bytes);
    return setImmediate(() => cb(null, '', ''));
  };
  return { fn, calls };
}

const PROCESSED_OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(40, 7)]);
const SHELL_META_RE = /[;&|`$<>"'\n]/;

/** A Freesound import of sound 201 ("Parry Clang", CC0) with the given fake ffmpeg. */
function freesoundImport(dir, ffmpeg) {
  const routes = {
    [`${FS}/sounds/201/?fields=${FIELDS}`]: fsSound(201, 'Parry Clang', 'http://creativecommons.org/publicdomain/zero/1.0/'),
    'https://cdn.freesound.org/previews/201-hq.ogg': () => reply(OGG),
  };
  return library(dir, fakeFetch(routes).fn, { execFile: ffmpeg.fn });
}

const tmpLeft = (dir) => fs.readdirSync(path.join(dir, ...`${ART}/Audio`.split('/'))).filter((n) => n.includes('.tmp'));

test('audioPost on an audio import: ffmpeg gets plain argument tokens, no shell, and the result replaces the file', async () => {
  const dir = tempRepo();
  const ffmpeg = fakeFfmpeg('ok', PROCESSED_OGG);
  const { lib, unity } = freesoundImport(dir, ffmpeg);
  const res = await lib.importAsset({ source: 'freesound', id: '201', kind: 'audio', audioPost: { targetBpm: 120, bpm: 100 } });
  assert.equal(res.ok, true, JSON.stringify(res));
  const rel = `${ART}/Audio/parry-clang.ogg`;
  assert.deepEqual(res.files, [rel]);
  assert.equal(ffmpeg.calls.length, 1);
  const { cmd, args, opts } = ffmpeg.calls[0];
  assert.equal(cmd, 'ffmpeg');
  assert.equal(opts.shell, undefined, 'never a shell');
  const target = path.join(dir, ...rel.split('/'));
  const out = args[args.length - 1];
  assert.equal(path.dirname(out), path.dirname(target), 'the temp output sits next to the target');
  assert.match(path.basename(out), /^parry-clang\.ogg\.[0-9a-f]{12}\.tmp\.ogg$/);
  assert.deepEqual(args, [
    '-hide_banner', '-nostdin', '-n', '-i', target, '-vn',
    '-af', 'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB,atempo=1.2,loudnorm=I=-14:TP=-1.5:LRA=11',
    '-ar', '48000', out,
  ]);
  for (const a of args.filter((t) => t !== target && t !== out)) assert.equal(SHELL_META_RE.test(a), false, `plain token: ${a}`);
  assert.deepEqual(fs.readFileSync(target), PROCESSED_OGG);
  assert.deepEqual(tmpLeft(dir), []);
  assert.match(res.note, /Audio post-process \(leading silence trimmed, tempo 100 -> 120 BPM, -14 LUFS\) applied/);
  // The ledger row and the Unity import still point at the final file.
  assert.equal(ledgerRows(dir)[0].path, rel);
  assert.equal(unity.calls[0].parameters.path, rel);
});

test('audioPost: no ffmpeg on PATH (ENOENT) keeps the original bytes and adds a note', async () => {
  const dir = tempRepo();
  const ffmpeg = fakeFfmpeg('enoent');
  const { lib } = freesoundImport(dir, ffmpeg);
  const res = await lib.importAsset({ source: 'freesound', id: '201', kind: 'audio', audioPost: { trim: true } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(fs.readFileSync(path.join(dir, ...res.main.split('/'))), OGG);
  assert.match(res.note, /ffmpeg was not found on PATH; the original audio was kept/);
  assert.deepEqual(tmpLeft(dir), []);
});

test('audioPost: a failing or empty ffmpeg run keeps the original bytes, removes its temp file and says why', async () => {
  for (const [outcome, why] of [['fail', /ffmpeg failed \(Error while filtering: Invalid argument\)/], ['empty', /ffmpeg produced an empty file/]]) {
    const dir = tempRepo();
    const { lib } = freesoundImport(dir, fakeFfmpeg(outcome));
    const res = await lib.importAsset({ source: 'freesound', id: '201', kind: 'audio', audioPost: { loudnorm: true } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(fs.readFileSync(path.join(dir, ...res.main.split('/'))), OGG, outcome);
    assert.match(res.note, why);
    assert.deepEqual(tmpLeft(dir), [], outcome);
  }
  // An output in another format than the file it replaces is refused too.
  const dir = tempRepo();
  const { lib } = freesoundImport(dir, fakeFfmpeg('ok', WAV));
  const res = await lib.importAsset({ source: 'freesound', id: '201', kind: 'audio', audioPost: {} });
  assert.deepEqual(fs.readFileSync(path.join(dir, ...res.main.split('/'))), OGG);
  assert.match(res.note, /not a \.ogg file/);
});

test('audioPost validation: BPM must be a finite number within 40..300, paired, and only for audio; nothing is run', async () => {
  const dir = tempRepo();
  const ffmpeg = fakeFfmpeg('ok', PROCESSED_OGG);
  const { lib } = freesoundImport(dir, ffmpeg);
  const bad = [
    { targetBpm: 120 },
    { bpm: 120 },
    { targetBpm: 30, bpm: 120 },
    { targetBpm: 120, bpm: 301 },
    { targetBpm: Infinity, bpm: 120 },
    { targetBpm: NaN, bpm: 120 },
    { targetBpm: '120', bpm: 100 },
    { targetBpm: '120;touch pwned', bpm: 100 },
    { trim: 'yes' },
    { filter: 'volume=9' },
    'trim',
  ];
  for (const audioPost of bad) {
    const res = await lib.importAsset({ source: 'freesound', id: '201', kind: 'audio', audioPost });
    assert.equal(res.error, 'badAudioPost', JSON.stringify(audioPost));
  }
  const notAudio = await lib.importAsset({ source: 'polyhaven', id: 'x', kind: 'texture', audioPost: { trim: true } });
  assert.equal(notAudio.error, 'badAudioPost');
  assert.equal(ffmpeg.calls.length, 0);
  // Without audioPost an audio import never runs ffmpeg.
  const plain = await lib.importAsset({ source: 'freesound', id: '201', kind: 'audio' });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(ffmpeg.calls.length, 0);
});

test('atempo chains filters when the tempo ratio is outside 0.5..2.0', () => {
  const N = require('../src/lunasworkAudioNormalize.js');
  const product = (xs) => xs.reduce((a, b) => a * b, 1);
  for (const [target, source] of [[300, 40], [40, 300], [240, 60], [60, 240], [90, 120]]) {
    const chain = N.atempoChain(target / source);
    assert.ok(chain.every((f) => f >= 0.5 && f <= 2), `${target}/${source}: ${chain}`);
    assert.ok(Math.abs(product(chain) - target / source) < 1e-9);
  }
  assert.equal(N.audioFilter({ trim: false, loudnorm: false, targetBpm: 300, bpm: 40 }), 'atempo=2,atempo=2,atempo=1.875');
  assert.equal(N.audioFilter({ trim: false, loudnorm: true, targetBpm: 40, bpm: 300 }), 'atempo=0.5,atempo=0.5,atempo=0.533333,loudnorm=I=-14:TP=-1.5:LRA=11');
  assert.equal(N.TARGET_LUFS, -14);
  assert.deepEqual(N.cleanAudioPost({ trim: false, loudnorm: false, targetBpm: 120, bpm: 120 }), { ok: true, post: null });
});
