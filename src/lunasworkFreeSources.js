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

const { readCappedBody } = require('./lunasworkComfy');
const { isSafeName } = require('./lunasworkZip');

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

/** A validated item; null when a required field is missing. */
function makeItem(source, raw) {
  const item = {
    source,
    id: oneLine(raw.id, 100),
    name: oneLine(raw.name, MAX_TEXT) || oneLine(raw.id, 100),
    author: oneLine(raw.author, MAX_TEXT),
    sourceUrl: isHttps(raw.sourceUrl) ? raw.sourceUrl : '',
    license: oneLine(raw.license, MAX_TEXT),
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

// ---- the set --------------------------------------------------------------------------

const SOURCE_IDS = Object.freeze(['polyhaven', 'sketchfab', 'polypizza', 'ambientcg', 'freesound']);
// The libraries whose API needs a key from LunaCore's secret store (src/lunasworkAssetKeys.js).
const KEYED_SOURCES = Object.freeze(['sketchfab', 'polypizza', 'freesound']);

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
