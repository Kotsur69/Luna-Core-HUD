// ============================================================================
// LunaCore - Luna's Work asset source catalog
// ----------------------------------------------------------------------------
// Loads config/lunaswork-asset-catalog.json: which asset source (a free
// library, a ComfyUI model family, the Blender MCP, a Higgsfield model) fits
// which asset kind. The Director (casting) and the Critic (judging) use it as
// a fixed menu.
//
// Same contract as the other config loaders (cheatsheets.js, prompts.js): a
// safe read, validation at the boundary, and a missing or broken file gives an
// empty catalog, never a throw. Bad entries are dropped with a logged reason.
// ============================================================================

'use strict';

const fs = require('fs');
const paths = require('./paths');
const { SOURCE_IDS } = require('./lunasworkFreeSources');
const { KINDS } = require('./lunasworkAssetPipeline');

const DEFAULT_CATALOG_FILE = paths.bundled('lunaswork-asset-catalog.json');
// The non-library sources: the local ComfyUI, the Blender MCP and paid Higgsfield.
const TOOL_SOURCE_IDS = Object.freeze(['comfyui', 'blender', 'higgsfield']);
const KNOWN_SOURCE_IDS = Object.freeze([...SOURCE_IDS, ...TOOL_SOURCE_IDS]);
const KIND_IDS = Object.freeze(Object.keys(KINDS));
const COST_CLASSES = Object.freeze(['free', 'local', 'paid']);
const MAX_TOON_FIT = 400;
const MAX_MODELS = 50;
const MAX_CREDITS = 10000;
// A model id: a ComfyUI family name ("SD 1.5", "Hunyuan3D-2") or a Higgsfield id ("gpt_image_2_6").
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;

const EMPTY_CATALOG = Object.freeze({ sources: Object.freeze([]) });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Safe read + JSON parse; the reason is reported instead of thrown. */
function readJson(file) {
  try {
    return { ok: true, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: err && err.code === 'ENOENT' ? 'file missing' : `unreadable: ${err && err.message}` };
  }
}

/**
 * Keeps the known kinds of a list, without duplicates; unknown ones are logged.
 * @returns {string[]|null} null when `raw` is not an array
 */
function cleanKinds(raw, where, warn) {
  if (!Array.isArray(raw)) return null;
  const kinds = [];
  for (const k of raw) {
    if (typeof k !== 'string' || !KIND_IDS.includes(k)) {
      warn(`asset catalog: ${where}: unknown kind ${JSON.stringify(k)} dropped`);
      continue;
    }
    if (!kinds.includes(k)) kinds.push(k);
  }
  return kinds;
}

/** One model of a tool source, or null (logged). Its kinds must be kinds the source serves. */
function cleanModel(raw, sourceId, sourceKinds, warn) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !MODEL_ID_RE.test(raw.id)) {
    warn(`asset catalog: ${sourceId}: a model without a valid id dropped`);
    return null;
  }
  const where = `${sourceId} model ${raw.id}`;
  const kinds = cleanKinds(raw.kinds, where, warn);
  if (!kinds) {
    warn(`asset catalog: ${where}: kinds is not a list, model dropped`);
    return null;
  }
  const served = kinds.filter((k) => sourceKinds.includes(k));
  for (const k of kinds) if (!served.includes(k)) warn(`asset catalog: ${where}: kind "${k}" is not served by ${sourceId}, dropped`);
  if (!served.length) {
    warn(`asset catalog: ${where}: no usable kind, model dropped`);
    return null;
  }
  const model = { id: raw.id, kinds: Object.freeze(served) };
  if (raw.credits !== undefined) {
    if (typeof raw.credits !== 'number' || !Number.isFinite(raw.credits) || raw.credits < 0 || raw.credits > MAX_CREDITS) {
      warn(`asset catalog: ${where}: credits must be a number from 0 to ${MAX_CREDITS}, model dropped`);
      return null;
    }
    model.credits = raw.credits;
  }
  return Object.freeze(model);
}

/** The model list of a source; a source without one gets an empty list. */
function cleanModels(raw, sourceId, sourceKinds, warn) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn(`asset catalog: ${sourceId}: models is not a list, ignored`);
    return [];
  }
  const models = [];
  for (const m of raw.slice(0, MAX_MODELS)) {
    const model = cleanModel(m, sourceId, sourceKinds, warn);
    if (!model) continue;
    if (models.some((x) => x.id === model.id)) {
      warn(`asset catalog: ${sourceId}: duplicate model ${model.id} dropped`);
      continue;
    }
    models.push(model);
  }
  return models;
}

/**
 * One source entry, or null with a logged reason. Unknown kinds are dropped
 * from the entry; a bad id, costClass, needsKey or toonFit drops the entry.
 */
function cleanSource(raw, warn) {
  if (!isObj(raw)) {
    warn('asset catalog: a source that is not an object dropped');
    return null;
  }
  const { id } = raw;
  if (typeof id !== 'string' || !KNOWN_SOURCE_IDS.includes(id)) {
    warn(`asset catalog: unknown source id ${JSON.stringify(id)} dropped`);
    return null;
  }
  const kinds = cleanKinds(raw.kinds, id, warn);
  if (!kinds || !kinds.length) {
    warn(`asset catalog: ${id}: no usable kinds, source dropped`);
    return null;
  }
  if (!COST_CLASSES.includes(raw.costClass)) {
    warn(`asset catalog: ${id}: costClass must be one of ${COST_CLASSES.join(', ')}, source dropped`);
    return null;
  }
  if (typeof raw.needsKey !== 'boolean') {
    warn(`asset catalog: ${id}: needsKey must be true or false, source dropped`);
    return null;
  }
  const toonFit = typeof raw.toonFit === 'string' ? raw.toonFit.trim() : '';
  if (!toonFit || toonFit.length > MAX_TOON_FIT) {
    warn(`asset catalog: ${id}: toonFit must be a note of 1 to ${MAX_TOON_FIT} characters, source dropped`);
    return null;
  }
  return Object.freeze({
    id,
    kinds: Object.freeze(kinds),
    costClass: raw.costClass,
    needsKey: raw.needsKey,
    toonFit,
    models: Object.freeze(cleanModels(raw.models, id, kinds, warn)),
  });
}

/**
 * Loads and validates the catalog. Never throws: a missing file, malformed
 * JSON or the wrong shape gives an empty catalog (and a logged reason).
 * @param {string} [file] defaults to the bundled config file
 * @param {{warn?:(msg:string)=>void}} [opts] logger, console.warn by default
 * @returns {{sources: ReadonlyArray<{id:string, kinds:string[], costClass:string, needsKey:boolean, toonFit:string, models:Array<{id:string, kinds:string[], credits?:number}>}>}}
 */
function loadCatalog(file = DEFAULT_CATALOG_FILE, opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : (msg) => console.warn(msg);
  const read = readJson(file);
  if (!read.ok) {
    warn(`asset catalog: ${file}: ${read.reason}, using an empty catalog`);
    return EMPTY_CATALOG;
  }
  if (!isObj(read.json) || !Array.isArray(read.json.sources)) {
    warn(`asset catalog: ${file}: expected {"sources": [...]}, using an empty catalog`);
    return EMPTY_CATALOG;
  }
  const sources = [];
  for (const raw of read.json.sources) {
    const source = cleanSource(raw, warn);
    if (!source) continue;
    if (sources.some((s) => s.id === source.id)) {
      warn(`asset catalog: duplicate source ${source.id} dropped`);
      continue;
    }
    sources.push(source);
  }
  return Object.freeze({ sources: Object.freeze(sources) });
}

const sourcesOf = (catalog) => (isObj(catalog) && Array.isArray(catalog.sources) ? catalog.sources : []);
const sourceById = (catalog, id) => sourcesOf(catalog).find((s) => s && s.id === id) || null;

/** The ids of the sources that serve `kind`, in catalog order. */
function sourcesForKind(catalog, kind) {
  return sourcesOf(catalog).filter((s) => Array.isArray(s.kinds) && s.kinds.includes(kind)).map((s) => s.id);
}

/** True when `id` is a Higgsfield model listed in the catalog. */
function isKnownHiggsfieldModel(catalog, id) {
  const hf = sourceById(catalog, 'higgsfield');
  return typeof id === 'string' && !!hf && Array.isArray(hf.models) && hf.models.some((m) => m.id === id);
}

/** The AMD-safe ComfyUI model families listed for `kind`. */
function comfyModelsForKind(catalog, kind) {
  const comfy = sourceById(catalog, 'comfyui');
  if (!comfy || !Array.isArray(comfy.models)) return [];
  return comfy.models.filter((m) => Array.isArray(m.kinds) && m.kinds.includes(kind)).map((m) => m.id);
}

module.exports = {
  DEFAULT_CATALOG_FILE,
  TOOL_SOURCE_IDS,
  KNOWN_SOURCE_IDS,
  COST_CLASSES,
  EMPTY_CATALOG,
  loadCatalog,
  sourcesForKind,
  isKnownHiggsfieldModel,
  comfyModelsForKind,
};
