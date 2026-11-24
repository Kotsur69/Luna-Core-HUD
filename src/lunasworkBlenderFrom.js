// ============================================================================
// LunaCore - Luna's Work asset pipeline: luna_asset_blender `from`
// ----------------------------------------------------------------------------
// A saved Higgsfield result goes through Blender instead of straight into
// Unity, so it gets the same toon pass, decimation and FBX / prefab export as
// a Blender-made model (src/lunasworkAssetBlender.js):
//
//   image  png / jpg / webp: the Base Color texture of the named object's
//          material (src/lunasworkBlenderScript.js PY_FROM)
//   model  glb: imported into the open Blender scene. Only a GLB whose JSON
//          chunk names no external file: its buffers and images are inside
//          it, so the importer never reads a file outside the repo. .gltf
//          and .fbx are refused (both can point at other files, and
//          luna_asset_higgsfield saves 3D results only as .glb).
//
// `from` is a repo-relative path the worker names, so it is untrusted: a plain
// relative path under art/higgsfield/ or the art root, no traversal, an
// allowed extension, inside the repo (the pipeline's guard, junctions
// resolved), not a link anywhere on the way (realpath compare), an existing
// file whose magic bytes match its extension. Its Higgsfield record
// (art/higgsfield/<kind>/<stem>.json, the one listing this file as an output)
// is looked up, so the asset log and the license ledger can name it.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { imageKind } = require('./lunasworkComfy');

const IMAGE_FROM_EXTS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
const MODEL_FROM_EXTS = Object.freeze(['glb']);
// 3D files that can reference other files on disk: refused with this reason.
const REFUSED_MODEL_EXTS = Object.freeze(['gltf', 'fbx']);
const MAX_FROM_CHARS = 300;
const MAX_FROM_BYTES = 100 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const IMAGE_HEAD_BYTES = 16;
// GLB layout: 12-byte header, then the JSON chunk (uint32 length, 'JSON', data).
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
const GLB_JSON_TYPE = 0x4e4f534a;
const MAX_GLB_JSON_BYTES = 16 * 1024 * 1024;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (detail) => ({ ok: false, error: 'badFrom', detail });

/**
 * The `from` argument as a plain path, checked without touching the disk.
 * @param {unknown} raw untrusted tool argument
 * @param {{artRoot:string, higgsfieldDir:string}} roots
 * @returns {{ok:true, from:null|{rel:string, ext:string, type:'texture'|'model'}}|{ok:false, error:string, detail:string}}
 */
function cleanFrom(raw, roots) {
  if (raw === undefined || raw === null) return { ok: true, from: null };
  if (typeof raw !== 'string' || !raw || raw.length > MAX_FROM_CHARS) return fail(`from must be a repo-relative path of at most ${MAX_FROM_CHARS} characters`);
  // No backslash, drive letter, empty segment, leading dot or "..": one plain relative path.
  if (!raw.split('/').every((s) => SEGMENT_RE.test(s) && !s.includes('..'))) {
    return fail('from must be a plain repo-relative path with forward slashes (no "..", no absolute path)');
  }
  const under = [roots.higgsfieldDir, roots.artRoot].some((root) => raw.startsWith(`${root}/`));
  if (!under) return fail(`from must be a saved Higgsfield result under ${roots.higgsfieldDir}/ or ${roots.artRoot}/`);
  const ext = path.posix.extname(raw).slice(1).toLowerCase();
  if (REFUSED_MODEL_EXTS.includes(ext)) return fail(`.${ext} is not accepted: it can reference other files on disk; only a self-contained .glb model (or a png / jpg / webp texture) goes through Blender`);
  if (IMAGE_FROM_EXTS.includes(ext)) return { ok: true, from: { rel: raw, ext, type: 'texture' } };
  if (MODEL_FROM_EXTS.includes(ext)) return { ok: true, from: { rel: raw, ext, type: 'model' } };
  return fail(`from must be a ${[...IMAGE_FROM_EXTS, ...MODEL_FROM_EXTS].join(' / ')} file`);
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const realOf = (fsx, p) => (fsx.realpathSync.native ? fsx.realpathSync.native(p) : fsx.realpathSync(p));

/** Up to `length` bytes at `position` of an open file. */
function readAt(fsx, fd, length, position) {
  const buf = Buffer.alloc(length);
  return buf.subarray(0, fsx.readSync(fd, buf, 0, length, position));
}

/** The parsed JSON chunk of a GLB file; throws when it is not a usable binary glTF. */
function glbJson(fsx, target) {
  const fd = fsx.openSync(target, 'r');
  try {
    const head = readAt(fsx, fd, GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES, 0);
    if (head.length < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES || head.toString('latin1', 0, 4) !== 'glTF') throw new Error('it is not a binary glTF (.glb) file');
    const length = head.readUInt32LE(GLB_HEADER_BYTES);
    if (head.readUInt32LE(GLB_HEADER_BYTES + 4) !== GLB_JSON_TYPE || length < 2 || length > MAX_GLB_JSON_BYTES) throw new Error('its first chunk is not a usable JSON chunk');
    const text = readAt(fsx, fd, length, GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES);
    if (text.length !== length) throw new Error('its JSON chunk is cut short');
    try {
      return JSON.parse(text.toString('utf8'));
    } catch {
      throw new Error('its JSON chunk does not parse');
    }
  } finally {
    fsx.closeSync(fd);
  }
}

/** Throws unless no buffer or image of the GLB names an external file (only embedded data and data: URIs). */
function checkSelfContainedGlb(fsx, target) {
  const json = glbJson(fsx, target);
  if (!isObj(json)) throw new Error('its JSON chunk is not an object');
  for (const key of ['buffers', 'images']) {
    const list = Array.isArray(json[key]) ? json[key] : [];
    if (list.some((item) => isObj(item) && typeof item.uri === 'string' && !item.uri.startsWith('data:'))) {
      throw new Error(`it references an external file (a ${key} uri); only a self-contained GLB is imported`);
    }
  }
}

/** Throws unless the file's first bytes are what its extension says. */
function checkMagic(fsx, target, from) {
  if (from.type === 'model') {
    checkSelfContainedGlb(fsx, target);
    return;
  }
  const fd = fsx.openSync(target, 'r');
  let head;
  try {
    head = readAt(fsx, fd, IMAGE_HEAD_BYTES, 0);
  } finally {
    fsx.closeSync(fd);
  }
  const want = from.ext === 'jpeg' ? 'jpg' : from.ext;
  if (imageKind(head) !== want) throw new Error(`it is not a ${from.ext.toUpperCase()} image`);
}

/**
 * The Higgsfield record that lists `rel` as an output, or null. A result
 * saved under the art root (<artRoot>/<KindDir>/<stem>[-N].<ext>) has its
 * record at <higgsfieldDir>/<kind>/<stem>.json.
 */
function findRecord(rel, deps) {
  if (!rel.startsWith(`${deps.artRoot}/`)) return null;
  const rest = rel.slice(deps.artRoot.length + 1).split('/');
  if (rest.length !== 2) return null;
  const kind = Object.keys(deps.kinds).find((k) => deps.kinds[k].dir === rest[0]);
  if (!kind) return null;
  const stem = rest[1].slice(0, rest[1].length - path.posix.extname(rest[1]).length);
  for (const s of new Set([stem, stem.replace(/-\d+$/, '')])) {
    const recordRel = `${deps.higgsfieldDir}/${kind}/${s}.json`;
    if (!deps.files.stat(recordRel)) continue;
    let record;
    try {
      record = JSON.parse(deps.files.read(recordRel, MAX_RECORD_BYTES).toString('utf8'));
    } catch {
      // An unreadable record proves nothing: the next candidate, else the file itself is the named source.
      continue;
    }
    if (isObj(record) && Array.isArray(record.outputs) && record.outputs.includes(rel)) return recordRel;
  }
  return null;
}

/**
 * The checked `from` on disk: guarded inside the repo, no link on the way,
 * an existing file of the right type, and its Higgsfield record.
 * @param {{rel:string, ext:string, type:string}} from from cleanFrom
 * @param {{repoPath:string, artRoot:string, higgsfieldDir:string, kinds:object, fsImpl?:object,
 *   files:{guard:(rel:string)=>string, stat:(rel:string)=>object|null, read:(rel:string, max:number)=>Buffer}}} deps
 * @returns {{ok:true, rel:string, abs:string, type:string, record:string|null}|{ok:false, error:string, detail:string}}
 */
function resolveFrom(from, deps) {
  const fsx = deps.fsImpl || fs;
  try {
    const target = deps.files.guard(from.rel);
    const expected = path.join(realOf(fsx, deps.repoPath), ...from.rel.split('/'));
    // A junction or symlink anywhere on the way (even one pointing back into the repo) changes the real path.
    if (!samePath(realOf(fsx, target), expected)) throw new Error('it goes through a junction or link');
    const st = fsx.statSync(target);
    if (!st.isFile()) throw new Error('it is not a file');
    if (st.size > MAX_FROM_BYTES) throw new Error(`it is larger than ${MAX_FROM_BYTES} bytes`);
    checkMagic(fsx, target, from);
    return { ok: true, rel: from.rel, abs: target, type: from.type, record: findRecord(from.rel, deps) };
  } catch (err) {
    const why = err && err.code === 'ENOENT' ? 'no such file' : errText(err);
    return fail(`refused: from ${from.rel}: ${why}`);
  }
}

module.exports = { IMAGE_FROM_EXTS, MODEL_FROM_EXTS, REFUSED_MODEL_EXTS, cleanFrom, resolveFrom };
