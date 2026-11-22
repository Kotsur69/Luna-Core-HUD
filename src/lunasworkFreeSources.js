// ============================================================================
// LunaCore - free asset library clients for the Luna's Work asset worker
// ----------------------------------------------------------------------------
// One small client per library, each on its official JSON API (never HTML
// scraping). Every client answers in one shape, so src/lunasworkFreeAssets.js
// can search, check the license and import the same way:
//
//   search(query, {type, limit}) -> item[]
//   info(id)                     -> item          (the license is read here)
//   files(item, {resolution})    -> {files:[{url, name, main}], archive}
//   item = {source, id, name, author, sourceUrl, license, tags, type}
//
//   polyhaven   api.polyhaven.com /assets, /info/<id>, /files/<id>. Every asset
//               is CC0 (Poly Haven's license page). HDRIs (.hdr), texture maps
//               (jpg per map), models (FBX + its texture files)
//   sketchfab   api.sketchfab.com/v3 /search (downloadable only), /models/<uid>
//               (per-model license), /models/<uid>/download (API token) -> GLB
//   polypizza   api.poly.pizza/v1.1 /search/<q>, /model/<id> (API key) -> GLB;
//               CC0 or CC-BY per model
//   ambientcg   ambientcg.com/api/v2/full_json (public, CC0): textures and
//               HDRIs, downloaded as a zip (src/lunasworkZip.js) or one file
//   freesound   freesound.org/apiv2 /search/text/, /sounds/<id>/ (API key).
//               The key only grants the HQ OGG preview; the original file
//               needs an OAuth2 login, so the preview is what is imported
//   smithsonian api.si.edu/openaccess/api/v1.0 /search, /content/<id>
//               (api.data.gov key in X-Api-Key header) -> CC0 3D GLB / glTF zip
//   blenderkit  www.blenderkit.com/api/v1 /search/ (filters inside query=:
//               asset_type:, is_free:true) -> the record's /downloads/<uuid>/
//               endpoint with a scene_uuid -> a signed link on BlenderKit's
//               file hosts -> glTF (.glb) models and EXR HDRIs. Free assets
//               need no key; a stored one is sent as a Bearer token. No
//               materials (they ship only as .blend)
//   lotsofsounds api.lotsofsounds.com/api/v1 /sounds (with x-api-key) or
//               /sounds/sample (no key) -> CC0 WAV / OGG / MP3 sounds
//
// Not here, on purpose: Kenney and OpenGameArt publish no official API, and
// this module never scrapes HTML (NO_API_SOURCES says so to the worker).
//
// Boundaries: the hosts are fixed; ids are checked against each library's id
// shape before they go into a URL; redirects of API calls are refused (an
// API key never follows one); every reply has a timeout and a size cap and is
// validated field by field. File URLs are only returned here: the caller
// downloads them through the public-https downloader, which never sends a key.
// An error text never carries a key (redact).
// ============================================================================

'use strict';

const crypto = require('crypto');
const { readCappedBody } = require('./lunasworkComfy');
const { isSafeName } = require('./lunasworkZip');
const { BLENDERKIT_ROYALTY_FREE } = require('./lunasworkLicenses');

const USER_AGENT = 'LunaCore-asset-worker/1.0';
const API_TIMEOUT_MS = 30 * 1000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS = 10;
const MAX_TAGS = 30;
const MAX_TEXT = 200;
const MAX_DESCRIPTION = 2000;
const MAX_MAPS = 8;
const MAX_INCLUDES = 24;
const DEFAULT_RESOLUTION = '2k';
const RESOLUTIONS = Object.freeze(['1k', '2k', '4k']);
const TYPES = Object.freeze(['model', 'texture', 'hdri', 'audio']);
// A file name inside an asset's folder: up to 3 plain segments, no "..", no
// Windows device name (each segment is also checked with lunasworkZip.isSafeName).
const REL_NAME_RE = /^(?:[\w][\w.-]{0,99}\/){0,2}[\w][\w.-]{0,119}\.[a-z0-9]{2,5}$/i;
const NO_API_SOURCES = Object.freeze({
  kenney: 'Kenney publishes no official API; download its CC0 packs by hand from kenney.nl and add the ledger rows.',
  opengameart: 'OpenGameArt publishes no official API; LunaCore does not scrape its pages.',
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max = MAX_TEXT) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const sourceError = (code, message) => Object.assign(new Error(message), { code });
const isHttps = (u) => typeof u === 'string' && u.length <= 2000 && /^https:\/\/[^\s/?#@]+\.[^\s/?#@]+(\/\S*)?$/i.test(u);
const tagList = (raw) => (Array.isArray(raw) ? raw : []).slice(0, MAX_TAGS).map((t) => oneLine(isObj(t) ? t.name : t, 60)).filter(Boolean);
const clampLimit = (n) => (Number.isInteger(n) && n > 0 ? Math.min(n, MAX_RESULTS) : MAX_RESULTS);
const resolutionOf = (r) => (RESOLUTIONS.includes(r) ? r : DEFAULT_RESOLUTION);
const pick = (o, keys) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

/** `text` with every secret replaced: an error must never carry a key. */
function redact(text, secrets) {
  let out = String(text);
  for (const s of Array.isArray(secrets) ? secrets : []) if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[key]');
  return out;
}

/**
 * GET one JSON reply from a library API: no redirects, timeout, size cap.
 * @param {{fetch:Function, url:string, label:string, headers?:object, secrets?:string[], timeoutMs?:number}} req
 * @returns {Promise<unknown>}
 */
async function getJson({ fetch: fetchFn, url, label, headers = {}, secrets = [], timeoutMs = API_TIMEOUT_MS }) {
  let res;
  try {
    res = await fetchFn(url, { method: 'GET', redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timed out' : oneLine(err && err.cause && err.cause.code ? err.cause.code : errText(err), 120);
    throw sourceError('unreachable', redact(`${label} is not reachable (${why})`, secrets));
  }
  if (!res || typeof res.status !== 'number') throw sourceError('badReply', `${label} gave no HTTP answer`);
  if (res.status === 401 || res.status === 403) throw sourceError('keyRefused', `${label} refused the API key (HTTP ${res.status}): check it in LunaCore Settings -> Luna's Work -> Asset library keys`);
  if (res.status === 404) throw sourceError('notFound', `${label} has no such asset (HTTP 404)`);
  if (res.status === 429) throw sourceError('rateLimited', `${label} rate limit reached (HTTP 429): try again later`);
  if (res.status < 200 || res.status > 299) throw sourceError('http', `${label} answered HTTP ${res.status}`);
  let body;
  try {
    body = await readCappedBody(res, MAX_JSON_BYTES);
  } catch (err) {
    throw sourceError('badReply', redact(`${label}: ${oneLine(errText(err), 120)}`, secrets));
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw sourceError('badReply', `${label} answered without JSON`);
  }
}

/**
 * The license text of an item. classifyLicense passes the BlenderKit label even
 * from library text, so only the BlenderKit client may carry it: another
 * library stating it verbatim gets no license (refused as "none stated").
 */
function licenseFor(source, raw) {
  const text = oneLine(raw, MAX_TEXT);
  return text === BLENDERKIT_ROYALTY_FREE && source !== 'blenderkit' ? '' : text;
}

/** A validated item; null when a required field is missing. */
function makeItem(source, raw) {
  const item = {
    source,
    id: oneLine(raw.id, 100),
    name: oneLine(raw.name, MAX_TEXT) || oneLine(raw.id, 100),
    author: oneLine(raw.author, MAX_TEXT),
    sourceUrl: isHttps(raw.sourceUrl) ? raw.sourceUrl : '',
    license: licenseFor(source, raw.license),
    tags: tagList(raw.tags),
    // Only for the rip check (lunasworkLicenses.ripReason); never shown to the worker.
    description: oneLine(raw.description, MAX_DESCRIPTION),
    type: TYPES.includes(raw.type) ? raw.type : null,
  };
  return item.id && item.type && item.sourceUrl ? item : null;
}

/** One file of an asset, validated; throws when the URL or name is unusable. */
function fileEntry(url, name, main = false) {
  if (!isHttps(url)) throw sourceError('badReply', 'a download URL is not https');
  if (typeof name !== 'string' || !REL_NAME_RE.test(name) || !name.split('/').every(isSafeName)) throw sourceError('badReply', `a file name is not usable: ${oneLine(name, 80)}`);
  return { url, name, main };
}

// ---- Poly Haven -----------------------------------------------------------------------

const POLYHAVEN_API = 'https://api.polyhaven.com';
const POLYHAVEN_ID_RE = /^[a-z0-9_-]{1,80}$/;
const POLYHAVEN_TYPES = Object.freeze({ hdri: 'hdris', texture: 'textures', model: 'models' });
const POLYHAVEN_TYPE_OF = Object.freeze(['hdri', 'texture', 'model']);
// Texture maps worth importing; nor_dx and the scene formats are left out (Unity uses OpenGL normals).
const POLYHAVEN_SKIP_MAPS = new Set(['blend', 'gltf', 'fbx', 'usd', 'mtlx', 'nor_dx']);

/** The entry of a resolution map: the wanted size, else 2k, 1k, the first. */
const atRes = (map, res) => (isObj(map) ? map[res] || map['2k'] || map['1k'] || map[Object.keys(map)[0]] : null);

function polyHavenTextures(item, tree, res) {
  const out = [];
  for (const [map, sizes] of Object.entries(tree)) {
    if (POLYHAVEN_SKIP_MAPS.has(map.toLowerCase()) || out.length >= MAX_MAPS || !/^[\w-]{1,40}$/.test(map)) continue;
    const f = atRes(sizes, res);
    const found = isObj(f) ? (isObj(f.jpg) && ['jpg', f.jpg]) || (isObj(f.png) && ['png', f.png]) : null;
    if (found) out.push(fileEntry(found[1].url, `${item.id}_${map.toLowerCase()}.${found[0]}`, /^diff/i.test(map)));
  }
  if (!out.length) throw sourceError('noFile', `Poly Haven offers no texture maps for ${item.id}`);
  return out.some((f) => f.main) ? out : [{ ...out[0], main: true }, ...out.slice(1)];
}

function polyHavenModel(item, tree, res) {
  const fbx = atRes(tree.fbx, res);
  const fmt = isObj(fbx) && isObj(fbx.fbx) ? 'fbx' : 'gltf';
  const f = atRes(tree[fmt], res);
  const main = isObj(f) ? f[fmt] : null;
  if (!isObj(main)) throw sourceError('noFile', `Poly Haven offers no FBX or glTF for ${item.id}`);
  const includes = Object.entries(isObj(main.include) ? main.include : {}).slice(0, MAX_INCLUDES);
  return [fileEntry(main.url, `${item.id}.${fmt}`, true), ...includes.map(([rel, inc]) => fileEntry(isObj(inc) ? inc.url : '', rel, false))];
}

function createPolyHaven({ fetch: fetchFn }) {
  const label = 'Poly Haven';
  const get = (p) => getJson({ fetch: fetchFn, url: `${POLYHAVEN_API}${p}`, label });
  const itemOf = (id, raw) => makeItem('polyhaven', {
    id,
    name: raw.name,
    author: isObj(raw.authors) ? Object.keys(raw.authors).slice(0, 5).join(', ') : '',
    sourceUrl: `https://polyhaven.com/a/${id}`,
    // Every Poly Haven asset is CC0 (polyhaven.com/license).
    license: 'CC0',
    tags: [...(Array.isArray(raw.tags) ? raw.tags : []), ...(Array.isArray(raw.categories) ? raw.categories : [])],
    type: POLYHAVEN_TYPE_OF[raw.type],
  });

  async function search(query, { type, limit } = {}) {
    const json = await get(`/assets?type=${POLYHAVEN_TYPES[type] || 'all'}`);
    if (!isObj(json)) throw sourceError('badReply', `${label} answered something that is not an asset list`);
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const found = [];
    for (const [id, raw] of Object.entries(json)) {
      const item = POLYHAVEN_ID_RE.test(id) && isObj(raw) ? itemOf(id, raw) : null;
      const hay = item ? `${id} ${item.name} ${item.tags.join(' ')}`.toLowerCase() : '';
      if (item && words.every((w) => hay.includes(w))) found.push({ item, downloads: Number.isFinite(raw.download_count) ? raw.download_count : 0 });
    }
    return found.sort((a, b) => b.downloads - a.downloads).slice(0, clampLimit(limit)).map((f) => f.item);
  }

  async function info(id) {
    if (!POLYHAVEN_ID_RE.test(id)) throw sourceError('badId', 'a Poly Haven id is lower case letters, digits, _ and -');
    const raw = await get(`/info/${id}`);
    const item = isObj(raw) ? itemOf(id, raw) : null;
    if (!item) throw sourceError('badReply', `${label} answered an unusable asset record`);
    return item;
  }

  async function files(item, { resolution } = {}) {
    const res = resolutionOf(resolution);
    const tree = await get(`/files/${item.id}`);
    if (!isObj(tree)) throw sourceError('badReply', `${label} answered an unusable file list`);
    if (item.type === 'texture') return { files: polyHavenTextures(item, tree, res), archive: null };
    if (item.type === 'model') return { files: polyHavenModel(item, tree, res), archive: null };
    const f = atRes(tree.hdri, res);
    if (!isObj(f) || !isObj(f.hdr)) throw sourceError('noFile', `${label} offers no .hdr for ${item.id}`);
    return { files: [fileEntry(f.hdr.url, `${item.id}.hdr`, true)], archive: null };
  }

  return { id: 'polyhaven', label, types: ['hdri', 'texture', 'model'], needsKey: { search: false, import: false }, search, info, files };
}

// ---- Sketchfab ------------------------------------------------------------------------

const SKETCHFAB_API = 'https://api.sketchfab.com/v3';
const SKETCHFAB_UID_RE = /^[a-f0-9]{32}$/;
// Sketchfab license slugs; the label is used for the rest (and refused when not free).
const SKETCHFAB_SLUGS = Object.freeze({ cc0: 'CC0', by: 'CC-BY 4.0' });

function createSketchfab({ fetch: fetchFn, key }) {
  const label = 'Sketchfab';
  const licenseOf = (lic) => (isObj(lic) ? SKETCHFAB_SLUGS[lic.slug] || oneLine(lic.label, 100) || oneLine(lic.slug, 40) : '');
  const itemOf = (raw) => {
    if (!isObj(raw) || typeof raw.uid !== 'string' || !SKETCHFAB_UID_RE.test(raw.uid)) return null;
    const user = isObj(raw.user) ? raw.user : {};
    const viewer = typeof raw.viewerUrl === 'string' && raw.viewerUrl.startsWith('https://sketchfab.com/') ? raw.viewerUrl : `https://sketchfab.com/3d-models/${raw.uid}`;
    return makeItem('sketchfab', { id: raw.uid, name: raw.name, author: user.displayName || user.username, sourceUrl: viewer, license: licenseOf(raw.license), tags: raw.tags, description: raw.description, type: 'model' });
  };

  async function search(query, { limit } = {}) {
    const url = `${SKETCHFAB_API}/search?type=models&downloadable=true&count=${clampLimit(limit)}&q=${encodeURIComponent(query)}`;
    const json = await getJson({ fetch: fetchFn, url, label });
    if (!isObj(json) || !Array.isArray(json.results)) throw sourceError('badReply', `${label} answered without a result list`);
    return json.results.filter((r) => isObj(r) && r.isDownloadable !== false).map(itemOf).filter(Boolean).slice(0, clampLimit(limit));
  }

  async function info(uid) {
    if (!SKETCHFAB_UID_RE.test(uid)) throw sourceError('badId', 'a Sketchfab uid is 32 hex characters');
    const raw = await getJson({ fetch: fetchFn, url: `${SKETCHFAB_API}/models/${uid}`, label });
    const item = itemOf(raw);
    if (!item) throw sourceError('badReply', `${label} answered an unusable model record`);
    if (raw.isDownloadable !== true) throw sourceError('noFile', `${label} model ${uid} is not downloadable`);
    return item;
  }

  async function files(item) {
    if (!key) throw sourceError('noKey', 'no Sketchfab API token stored');
    const json = await getJson({ fetch: fetchFn, url: `${SKETCHFAB_API}/models/${item.id}/download`, label, headers: { Authorization: `Token ${key}` }, secrets: [key] });
    const glb = isObj(json) && isObj(json.glb) ? json.glb : null;
    if (glb) return { files: [fileEntry(glb.url, `${item.id}.glb`, true)], archive: null };
    // No GLB: the glTF zip (model + buffers + textures, folders kept for the glTF's relative paths).
    const gltf = isObj(json) && isObj(json.gltf) ? json.gltf : null;
    if (!gltf) throw sourceError('noFile', `${label} offers neither GLB nor glTF for ${item.id}; pick another model`);
    return { files: [], archive: fileEntry(gltf.url, `${item.id}.zip`, false) };
  }

  return { id: 'sketchfab', label, types: ['model'], needsKey: { search: false, import: true }, search, info, files };
}

// ---- Poly Pizza -----------------------------------------------------------------------

const POLYPIZZA_API = 'https://api.poly.pizza/v1.1';
const POLYPIZZA_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function createPolyPizza({ fetch: fetchFn, key }) {
  const label = 'Poly Pizza';
  const downloads = new Map();
  const call = (p) => {
    if (!key) throw sourceError('noKey', 'no Poly Pizza API key stored');
    return getJson({ fetch: fetchFn, url: `${POLYPIZZA_API}${p}`, label, headers: { 'x-auth-token': key }, secrets: [key] });
  };
  const itemOf = (raw) => {
    if (!isObj(raw)) return null;
    const id = pick(raw, ['ID', 'Id', 'id']);
    if (typeof id !== 'string' || !POLYPIZZA_ID_RE.test(id)) return null;
    const creator = pick(raw, ['Creator', 'creator']);
    const item = makeItem('polypizza', {
      id,
      name: pick(raw, ['Title', 'title', 'Name', 'name']),
      author: isObj(creator) ? pick(creator, ['Username', 'username', 'Name']) : creator,
      sourceUrl: `https://poly.pizza/m/${id}`,
      license: pick(raw, ['Licence', 'License', 'licence', 'license']),
      tags: pick(raw, ['Tags', 'tags']),
      type: 'model',
    });
    if (item) downloads.set(id, pick(raw, ['Download', 'download']));
    return item;
  };

  async function search(query, { limit } = {}) {
    const json = await call(`/search/${encodeURIComponent(query)}?Limit=${clampLimit(limit)}`);
    const list = isObj(json) ? pick(json, ['results', 'Results']) : null;
    if (!Array.isArray(list)) throw sourceError('badReply', `${label} answered without a result list`);
    return list.map(itemOf).filter(Boolean).slice(0, clampLimit(limit));
  }

  async function info(id) {
    if (!POLYPIZZA_ID_RE.test(id)) throw sourceError('badId', 'a Poly Pizza id is letters, digits, _ and -');
    const json = await call(`/model/${id}`);
    const item = itemOf(isObj(json) && isObj(json.model) ? json.model : json);
    if (!item || item.id !== id) throw sourceError('badReply', `${label} answered an unusable model record`);
    return item;
  }

  async function files(item) {
    const url = downloads.get(item.id);
    if (!url) throw sourceError('noFile', `${label} offers no download for ${item.id}`);
    return { files: [fileEntry(url, `${item.id}.glb`, true)], archive: null };
  }

  return { id: 'polypizza', label, types: ['model'], needsKey: { search: true, import: true }, search, info, files };
}

// ---- ambientCG ------------------------------------------------------------------------

const AMBIENTCG_API = 'https://ambientcg.com/api/v2/full_json';
const AMBIENTCG_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const AMBIENTCG_TYPES = Object.freeze({ Material: 'texture', Decal: 'texture', Atlas: 'texture', HDRI: 'hdri' });
const AMBIENTCG_QUERY_TYPES = Object.freeze({ texture: 'Material,Decal,Atlas', hdri: 'HDRI' });

/** Every download entry of an ambientCG record. */
function ambientDownloads(raw) {
  const all = [];
  for (const folder of Object.values(isObj(raw) && isObj(raw.downloadFolders) ? raw.downloadFolders : {})) {
    for (const cat of Object.values(isObj(folder) && isObj(folder.downloadFiletypeCategories) ? folder.downloadFiletypeCategories : {})) {
      for (const d of isObj(cat) && Array.isArray(cat.downloads) ? cat.downloads : []) if (isObj(d)) all.push(d);
    }
  }
  return all;
}

function createAmbientCg({ fetch: fetchFn }) {
  const label = 'ambientCG';
  const records = new Map();
  const itemOf = (raw) => {
    if (!isObj(raw) || typeof raw.assetId !== 'string' || !AMBIENTCG_ID_RE.test(raw.assetId)) return null;
    return makeItem('ambientcg', {
      id: raw.assetId,
      name: raw.displayName || raw.assetId,
      author: 'ambientCG',
      sourceUrl: `https://ambientcg.com/view?id=${raw.assetId}`,
      // Every ambientCG asset is CC0 (ambientcg.com/license).
      license: 'CC0',
      tags: raw.tags,
      type: AMBIENTCG_TYPES[raw.dataType] || null,
    });
  };
  const listOf = (json) => {
    if (!isObj(json) || !Array.isArray(json.foundAssets)) throw sourceError('badReply', `${label} answered without an asset list`);
    return json.foundAssets;
  };

  async function search(query, { type, limit } = {}) {
    const types = AMBIENTCG_QUERY_TYPES[type] || `${AMBIENTCG_QUERY_TYPES.texture},${AMBIENTCG_QUERY_TYPES.hdri}`;
    const json = await getJson({ fetch: fetchFn, url: `${AMBIENTCG_API}?q=${encodeURIComponent(query)}&type=${types}&limit=${clampLimit(limit)}&include=tagData`, label });
    return listOf(json).map(itemOf).filter(Boolean).slice(0, clampLimit(limit));
  }

  async function info(id) {
    if (!AMBIENTCG_ID_RE.test(id)) throw sourceError('badId', 'an ambientCG id is letters, digits, _ and -');
    const raw = listOf(await getJson({ fetch: fetchFn, url: `${AMBIENTCG_API}?id=${id}&include=tagData,downloadData`, label })).find((a) => isObj(a) && a.assetId === id);
    const item = itemOf(raw);
    if (!item) throw sourceError(raw ? 'badReply' : 'notFound', raw ? `${label} answered an unusable asset record` : `${label} has no asset ${id}`);
    records.set(id, raw);
    return item;
  }

  async function files(item, { resolution } = {}) {
    const all = ambientDownloads(records.get(item.id));
    const res = resolutionOf(resolution).toUpperCase();
    const want = item.type === 'hdri' ? [`${res}-HDR`, `${res}-EXR`] : [`${res}-JPG`, `${res}-PNG`];
    const d = all.find((x) => want.includes(x.attribute)) || all.find((x) => typeof x.attribute === 'string' && x.attribute.startsWith(`${res}-`)) || all[0];
    if (!d || !isHttps(d.downloadLink) || typeof d.fileName !== 'string') throw sourceError('noFile', `${label} offers no download for ${item.id}`);
    const name = oneLine(d.fileName, 120);
    if (name.toLowerCase().endsWith('.zip')) return { files: [], archive: fileEntry(d.downloadLink, name, false) };
    return { files: [fileEntry(d.downloadLink, name, true)], archive: null };
  }

  return { id: 'ambientcg', label, types: ['texture', 'hdri'], needsKey: { search: false, import: false }, search, info, files };
}

// ---- Freesound ------------------------------------------------------------------------

const FREESOUND_API = 'https://freesound.org/apiv2';
const FREESOUND_FIELDS = 'id,name,username,license,url,tags,previews';
// Freesound's own license filter, so NC / Sampling+ sounds do not even come back.
const FREESOUND_FILTER = 'license:("Creative Commons 0" OR "Attribution")';
const FREESOUND_PREVIEW = 'preview-hq-ogg';

function createFreesound({ fetch: fetchFn, key }) {
  const label = 'Freesound';
  const previews = new Map();
  const call = (p) => {
    if (!key) throw sourceError('noKey', 'no Freesound API key stored');
    return getJson({ fetch: fetchFn, url: `${FREESOUND_API}${p}`, label, headers: { Authorization: `Token ${key}` }, secrets: [key] });
  };
  const itemOf = (raw) => {
    if (!isObj(raw) || !Number.isSafeInteger(raw.id) || raw.id < 1) return null;
    const id = String(raw.id);
    const page = typeof raw.url === 'string' && raw.url.startsWith('https://freesound.org/') ? raw.url : `https://freesound.org/s/${id}/`;
    const item = makeItem('freesound', { id, name: raw.name, author: raw.username, sourceUrl: page, license: raw.license, tags: raw.tags, type: 'audio' });
    if (item && isObj(raw.previews)) previews.set(id, raw.previews[FREESOUND_PREVIEW]);
    return item;
  };

  async function search(query, { limit } = {}) {
    const json = await call(`/search/text/?query=${encodeURIComponent(query)}&page_size=${clampLimit(limit)}&fields=${FREESOUND_FIELDS}&filter=${encodeURIComponent(FREESOUND_FILTER)}`);
    if (!isObj(json) || !Array.isArray(json.results)) throw sourceError('badReply', `${label} answered without a result list`);
    return json.results.map(itemOf).filter(Boolean).slice(0, clampLimit(limit));
  }

  async function info(id) {
    if (!/^[1-9][0-9]{0,11}$/.test(id)) throw sourceError('badId', 'a Freesound id is a number');
    const item = itemOf(await call(`/sounds/${id}/?fields=${FREESOUND_FIELDS}`));
    if (!item || item.id !== id) throw sourceError('badReply', `${label} answered an unusable sound record`);
    return item;
  }

  async function files(item) {
    const url = previews.get(item.id);
    if (!url) throw sourceError('noFile', `${label} offers no HQ OGG preview for ${item.id}`);
    return { files: [fileEntry(url, `${item.id}.ogg`, true)], archive: null };
  }

  return { id: 'freesound', label, types: ['audio'], needsKey: { search: true, import: true }, search, info, files };
}

// ---- Smithsonian 3D -------------------------------------------------------------------

const SMITHSONIAN_API = 'https://api.si.edu/openaccess/api/v1.0';
const SMITHSONIAN_ID_RE = /^[A-Za-z0-9_:-]{1,100}$/;

function smithsonianDownloadOf(dnr) {
  const media = isObj(dnr.online_media) && Array.isArray(dnr.online_media.media) ? dnr.online_media.media : [];
  for (const m of media) {
    const list = isObj(m) && Array.isArray(m.resources) ? m.resources : [];
    for (const r of list) {
      if (!isObj(r) || !isHttps(r.url)) continue;
      const fmt = String(r.format || r.url).toLowerCase();
      if (fmt.includes('glb') || r.url.toLowerCase().endsWith('.glb')) return { url: r.url, ext: 'glb' };
      if (fmt.includes('zip') || r.url.toLowerCase().endsWith('.zip')) return { url: r.url, ext: 'zip' };
    }
  }
  return null;
}

function createSmithsonian({ fetch: fetchFn, key }) {
  const label = 'Smithsonian 3D';
  const downloads = new Map();
  const call = (p) => {
    if (!key) throw sourceError('noKey', 'no Smithsonian API key stored');
    return getJson({ fetch: fetchFn, url: `${SMITHSONIAN_API}${p}`, label, headers: { 'X-Api-Key': key }, secrets: [key] });
  };
  const itemOf = (raw) => {
    if (!isObj(raw) || typeof raw.id !== 'string' || !SMITHSONIAN_ID_RE.test(raw.id)) return null;
    const content = isObj(raw.content) ? raw.content : {};
    const dnr = isObj(content.descriptiveNonRepeating) ? content.descriptiveNonRepeating : {};
    const freetext = isObj(content.freetext) ? content.freetext : {};
    const indexed = isObj(content.indexedStructured) ? content.indexedStructured : {};
    const usage = isObj(dnr.usage) ? dnr.usage : {};
    const page = isHttps(dnr.record_link) ? dnr.record_link : `https://www.si.edu/object/${encodeURIComponent(raw.id)}`;
    const dl = smithsonianDownloadOf(dnr);
    const item = makeItem('smithsonian', {
      id: raw.id,
      name: raw.title || (isObj(dnr.title) ? dnr.title.content : ''),
      author: raw.unitCode || (isObj(dnr.data_source) ? dnr.data_source.content : 'Smithsonian Institution'),
      sourceUrl: page,
      license: usage.access || raw.license || 'CC0',
      tags: [...(Array.isArray(indexed.object_type) ? indexed.object_type : []), ...(Array.isArray(indexed.topic) ? indexed.topic : [])],
      description: Array.isArray(freetext.notes) && isObj(freetext.notes[0]) ? freetext.notes[0].content : '',
      type: 'model',
    });
    if (item && dl) downloads.set(raw.id, dl);
    return item;
  };

  async function search(query, { limit } = {}) {
    const q = `${query} AND online_media_type:"3D Models"`;
    const json = await call(`/search?q=${encodeURIComponent(q)}&rows=${clampLimit(limit)}`);
    const rows = isObj(json) && isObj(json.response) && Array.isArray(json.response.rows) ? json.response.rows : null;
    if (!rows) throw sourceError('badReply', `${label} answered without a result list`);
    return rows.map(itemOf).filter(Boolean).slice(0, clampLimit(limit));
  }

  async function info(id) {
    if (!SMITHSONIAN_ID_RE.test(id)) throw sourceError('badId', 'a Smithsonian id is letters, digits, _, : and -');
    const json = await call(`/content/${encodeURIComponent(id)}`);
    const raw = isObj(json) && isObj(json.response) ? json.response : json;
    const item = itemOf(raw);
    if (!item || item.id !== id) throw sourceError('badReply', `${label} answered an unusable model record`);
    return item;
  }

  async function files(item) {
    const dl = downloads.get(item.id);
    if (!dl) throw sourceError('noFile', `${label} offers no GLB or glTF zip download for ${item.id}`);
    const safeId = item.id.replace(/[^A-Za-z0-9_-]/g, '_');
    if (dl.ext === 'zip') return { files: [], archive: fileEntry(dl.url, `${safeId}.zip`, false) };
    return { files: [fileEntry(dl.url, `${safeId}.glb`, true)], archive: null };
  }

  return { id: 'smithsonian', label, types: ['model'], needsKey: { search: true, import: true }, search, info, files };
}

// ---- BlenderKit -----------------------------------------------------------------------

const BLENDERKIT_API = 'https://www.blenderkit.com/api/v1';
const BLENDERKIT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
// Search filters go inside query= (the add-on's syntax): the API ignores
// &asset_type= and &is_free= URL params. Materials are left out on purpose:
// BlenderKit ships them only as .blend, which Unity cannot import.
const BLENDERKIT_TYPES = Object.freeze({ model: 'model', hdri: 'hdr' });
const BLENDERKIT_TYPE_OF = Object.freeze({ model: 'model', hdr: 'hdri' });
// royalty_free: commercial use without credit, higher-level derivative works
// (a shipped game) may be sold; only resale of the asset itself is barred
// (blenderkit.com/docs/licenses, read 2026-11-22).
const BLENDERKIT_LICENSES = Object.freeze({ cc0: 'CC0', cc_zero: 'CC0', cc_by: 'CC-BY 4.0', royalty_free: BLENDERKIT_ROYALTY_FREE, roy_free: BLENDERKIT_ROYALTY_FREE });
const BLENDERKIT_EXT_BY_TYPE = Object.freeze({ model: 'glb', hdri: 'exr' });
const BLENDERKIT_EXTS = Object.freeze({ model: ['glb'], hdri: ['exr', 'hdr'] });
// The per-file download endpoint of a search record; the Bearer key may go to it, so it is pinned.
const BLENDERKIT_DOWNLOAD_RE = /^https:\/\/www\.blenderkit\.com\/api\/v1\/downloads\/[A-Za-z0-9-]{8,64}\/?$/;
// Where the signed file links of the download endpoint may point.
const BLENDERKIT_FILE_HOSTS = Object.freeze(['assets.blendkit.com', 'assets.blenderkit.com']);
// HDRI file types, lowest first; 8K is never taken.
const BLENDERKIT_HDRI_RES = Object.freeze(['0_5K', '1K', '2K', '4K']);
const BLENDERKIT_FILE_TYPE_RE = /^[a-z0-9_]{1,40}$/i;
const MAX_BLENDERKIT_FILES = 40;
const MAX_SIGNED_PATHS = 10;

/** fileType -> download endpoint of a search record (only pinned endpoints). */
function blenderKitFilesOf(raw) {
  const out = new Map();
  for (const f of Array.isArray(raw.files) ? raw.files.slice(0, MAX_BLENDERKIT_FILES) : []) {
    if (!isObj(f) || typeof f.fileType !== 'string' || !BLENDERKIT_FILE_TYPE_RE.test(f.fileType)) continue;
    const url = pick(f, ['downloadUrl', 'download_url']);
    if (typeof url === 'string' && BLENDERKIT_DOWNLOAD_RE.test(url) && !out.has(f.fileType)) out.set(f.fileType, url);
  }
  return out;
}

/** The download endpoint to call: a model's glTF, an HDRI's EXR at the resolution or the nearest lower one. */
function blenderKitPick(item, byType, resolution) {
  if (item.type === 'model') {
    const url = byType.get('gltf');
    if (!url) throw sourceError('noFile', 'this BlenderKit model has no glTF file');
    return url;
  }
  const want = resolutionOf(resolution).toUpperCase();
  for (let i = BLENDERKIT_HDRI_RES.indexOf(want); i >= 0; i -= 1) {
    const url = byType.get(`resolution_${BLENDERKIT_HDRI_RES[i]}`);
    if (url) return url;
  }
  throw sourceError('noFile', `this BlenderKit HDRI has no EXR at ${want} or lower`);
}

/** The normalized URL when `u` is https on one of BlenderKit's file hosts (no credentials, no port); else null. */
function blenderKitFileUrl(u) {
  if (!isHttps(u)) return null;
  let p;
  try {
    p = new URL(u);
  } catch {
    return null; // not a URL at all: the caller tries the next candidate
  }
  const ok = p.protocol === 'https:' && !p.username && !p.password && !p.port && BLENDERKIT_FILE_HOSTS.includes(p.hostname.toLowerCase());
  // The parsed form is returned, so the downloader and the name check see the same URL that was checked.
  return ok && isHttps(p.href) ? p.href : null;
}

/** The signed file URL of a download-endpoint reply: filePath, else the first allowed filePaths[].url. */
function blenderKitSignedUrl(json, label) {
  if (!isObj(json)) throw sourceError('badReply', `${label} answered an unusable download record`);
  const paths = Array.isArray(json.filePaths) ? json.filePaths.slice(0, MAX_SIGNED_PATHS) : [];
  for (const candidate of [json.filePath, ...paths.map((p) => (isObj(p) ? p.url : null))]) {
    const url = blenderKitFileUrl(candidate);
    if (url) return url;
  }
  throw sourceError('badReply', `${label} gave no download link on its file hosts (${BLENDERKIT_FILE_HOSTS.join(', ')})`);
}

/** The search words without ':' - a word like "is_free:false" must not become a BlenderKit search operator. */
const blenderKitWords = (query) => String(query).replace(/:/g, ' ').replace(/\s+/g, ' ').trim();

function createBlenderKit({ fetch: fetchFn, key }) {
  const label = 'BlenderKit';
  const downloads = new Map();
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const secrets = key ? [key] : [];
  const call = (p) => getJson({ fetch: fetchFn, url: `${BLENDERKIT_API}${p}`, label, headers, secrets });
  const itemOf = (raw) => {
    if (!isObj(raw)) return null;
    const id = pick(raw, ['assetBaseId', 'asset_base_id', 'id']);
    if (typeof id !== 'string' || !BLENDERKIT_ID_RE.test(id)) return null;
    // Unknown types (material, scene, brush...) have no importable file: makeItem drops them.
    const rawType = raw.assetType || raw.asset_type;
    const type = typeof rawType === 'string' && Object.hasOwn(BLENDERKIT_TYPE_OF, rawType) ? BLENDERKIT_TYPE_OF[rawType] : null;
    const author = isObj(raw.author) ? raw.author.fullName || raw.author.firstName || '' : raw.author;
    const licRaw = typeof raw.license === 'string' ? raw.license.trim().toLowerCase() : '';
    const item = makeItem('blenderkit', {
      id,
      name: raw.displayName || raw.name || id,
      author,
      sourceUrl: `https://www.blenderkit.com/asset-gallery-detail/${encodeURIComponent(id)}/`,
      // An unmapped license keeps its own text, so classifyLicense refuses it with a reason.
      license: Object.hasOwn(BLENDERKIT_LICENSES, licRaw) ? BLENDERKIT_LICENSES[licRaw] : raw.license || '',
      tags: raw.tags,
      description: raw.description,
      type,
    });
    if (item) downloads.set(id, blenderKitFilesOf(raw));
    return item;
  };

  // Without a type there is no asset_type: filter, so results of other types
  // (dropped by itemOf) can take page slots and the list may come back short.
  async function search(query, { type, limit } = {}) {
    const assetType = type && BLENDERKIT_TYPES[type] ? ` asset_type:${BLENDERKIT_TYPES[type]}` : '';
    const json = await call(`/search/?query=${encodeURIComponent(`${blenderKitWords(query)}${assetType} is_free:true`)}&page_size=${clampLimit(limit)}`);
    if (!isObj(json) || !Array.isArray(json.results)) throw sourceError('badReply', `${label} answered without a result list`);
    return json.results.map(itemOf).filter(Boolean).slice(0, clampLimit(limit));
  }

  async function info(id) {
    if (!BLENDERKIT_ID_RE.test(id)) throw sourceError('badId', 'a BlenderKit id is 4-64 letters, digits, _ and -');
    const json = await call(`/search/?query=${encodeURIComponent(`asset_base_id:${id} is_free:true`)}&page_size=1`);
    const raw = isObj(json) && Array.isArray(json.results) ? json.results.find((r) => isObj(r) && pick(r, ['assetBaseId', 'asset_base_id', 'id']) === id) : json;
    const item = itemOf(raw);
    if (!item || item.id !== id) throw sourceError('badReply', `${label} answered an unusable asset record`);
    return item;
  }

  // Two steps: the record's download endpoint answers 403 without scene_uuid;
  // with one it answers a signed file link (free assets, with or without a key).
  async function files(item, { resolution } = {}) {
    const byType = downloads.get(item.id);
    if (!byType) throw sourceError('noFile', `${label} offers no download for ${item.id}`);
    const endpoint = blenderKitPick(item, byType, resolution);
    const json = await getJson({ fetch: fetchFn, url: `${endpoint}?scene_uuid=${crypto.randomUUID()}`, label: `${label} download`, headers, secrets });
    const url = blenderKitSignedUrl(json, `${label} download`);
    const found = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    const ext = found && BLENDERKIT_EXTS[item.type].includes(found[1]) ? found[1] : BLENDERKIT_EXT_BY_TYPE[item.type];
    return { files: [fileEntry(url, `${item.id}.${ext}`, true)], archive: null };
  }

  return { id: 'blenderkit', label, types: ['model', 'hdri'], needsKey: { search: false, import: false }, search, info, files };
}

// ---- Lots of Sounds -------------------------------------------------------------------

const LOTSOFSOUNDS_ORIGIN = 'https://api.lotsofsounds.com';
const LOTSOFSOUNDS_API = `${LOTSOFSOUNDS_ORIGIN}/api/v1`;
const LOTSOFSOUNDS_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function createLotsOfSounds({ fetch: fetchFn, key }) {
  const label = 'Lots of Sounds';
  const downloads = new Map();
  const headers = key ? { 'x-api-key': key } : {};
  const secrets = key ? [key] : [];
  const basePath = key ? '/sounds' : '/sounds/sample';
  const call = (p) => getJson({ fetch: fetchFn, url: `${LOTSOFSOUNDS_API}${p}`, label, headers, secrets });
  const itemOf = (raw) => {
    if (!isObj(raw)) return null;
    const id = typeof raw.id === 'number' && Number.isSafeInteger(raw.id) ? String(raw.id) : raw.id;
    if (typeof id !== 'string' || !LOTSOFSOUNDS_ID_RE.test(id)) return null;
    const rawUrl = pick(raw, ['download_url', 'audio_url', 'stream_url', 'url']);
    const dl = typeof rawUrl === 'string' && rawUrl.startsWith('/') ? `${LOTSOFSOUNDS_ORIGIN}${rawUrl}` : rawUrl;
    const item = makeItem('lotsofsounds', {
      id,
      name: raw.name || raw.title || id,
      author: raw.author || 'Lots of Sounds',
      sourceUrl: `https://lotsofsounds.com/sounds/${encodeURIComponent(id)}`,
      // Lots of Sounds catalog is CC0 (lotsofsounds.com).
      license: raw.license || 'CC0',
      tags: raw.tags,
      description: raw.description,
      type: 'audio',
    });
    if (item && isHttps(dl)) downloads.set(id, dl);
    return item;
  };

  async function search(query, { limit } = {}) {
    const json = await call(`${basePath}?q=${encodeURIComponent(query)}&limit=${clampLimit(limit)}`);
    const list = isObj(json) ? pick(json, ['data', 'results', 'sounds']) : null;
    if (!Array.isArray(list)) throw sourceError('badReply', `${label} answered without a sound list`);
    return list.map(itemOf).filter(Boolean).slice(0, clampLimit(limit));
  }

  async function info(id) {
    if (!LOTSOFSOUNDS_ID_RE.test(id)) throw sourceError('badId', 'a Lots of Sounds id is letters, digits, _ and -');
    const json = await call(`${basePath}/${encodeURIComponent(id)}`);
    const raw = isObj(json) && isObj(json.data) ? json.data : json;
    const item = itemOf(raw);
    if (!item || item.id !== id) throw sourceError('badReply', `${label} answered an unusable sound record`);
    return item;
  }

  async function files(item) {
    const url = downloads.get(item.id);
    if (!url) throw sourceError('noFile', `${label} offers no audio download for ${item.id}`);
    const ext = (url.split('?')[0].match(/\.(wav|ogg|mp3)$/i) || [null, 'wav'])[1].toLowerCase();
    return { files: [fileEntry(url, `${item.id}.${ext}`, true)], archive: null };
  }

  return { id: 'lotsofsounds', label, types: ['audio'], needsKey: { search: false, import: false }, search, info, files };
}

// ---- the set --------------------------------------------------------------------------

const SOURCE_IDS = Object.freeze(['polyhaven', 'sketchfab', 'polypizza', 'ambientcg', 'freesound', 'smithsonian', 'blenderkit', 'lotsofsounds']);
// The libraries whose API accepts or requires a key from LunaCore's secret store (src/lunasworkAssetKeys.js).
const KEYED_SOURCES = Object.freeze(['sketchfab', 'polypizza', 'freesound', 'smithsonian', 'blenderkit', 'lotsofsounds']);

/**
 * Every library client, with the keys of this call.
 * @param {{fetch?:Function, keys?:{get:(source:string)=>string|null}}} [deps]
 * @returns {Record<string, object>}
 */
function createFreeSources(deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const keyOf = (id) => (deps.keys && typeof deps.keys.get === 'function' ? deps.keys.get(id) || null : null);
  return {
    polyhaven: createPolyHaven({ fetch: fetchFn }),
    sketchfab: createSketchfab({ fetch: fetchFn, key: keyOf('sketchfab') }),
    polypizza: createPolyPizza({ fetch: fetchFn, key: keyOf('polypizza') }),
    ambientcg: createAmbientCg({ fetch: fetchFn }),
    freesound: createFreesound({ fetch: fetchFn, key: keyOf('freesound') }),
    smithsonian: createSmithsonian({ fetch: fetchFn, key: keyOf('smithsonian') }),
    blenderkit: createBlenderKit({ fetch: fetchFn, key: keyOf('blenderkit') }),
    lotsofsounds: createLotsOfSounds({ fetch: fetchFn, key: keyOf('lotsofsounds') }),
  };
}

module.exports = {
  SOURCE_IDS,
  KEYED_SOURCES,
  NO_API_SOURCES,
  TYPES,
  RESOLUTIONS,
  redact,
  getJson,
  createFreeSources,
};
