// ============================================================================
// LunaCore - Luna's Work asset pipeline: luna_asset_higgsfield reference images
// ----------------------------------------------------------------------------
// Some Higgsfield models take reference images: Meshy's multi_image_to_3d
// turns 1-4 object views into a textured GLB mesh, the image models restyle
// or keep a look. The worker names 1-4 repo images (`images`); each is
// checked here, read ONCE, and its checked bytes are uploaded through
// `higgsfield upload create <file> --json` (free, no generation) from a
// private temp folder (src/lunasworkAssetTools.js createHiggsfieldCli upload);
// the upload ids go to `generate cost` / `generate create` as a repeated
// `--image <upload id>`.
//
// The paths are untrusted (a worker names them):
//   cleanReferences   no disk access: 1-4 distinct plain relative paths
//                     (forward slashes, no "..", no leading dot or dash),
//                     under art/ or the art root, a png / jpg / jpeg / webp
//   resolveReferences the disk check of luna_asset_blender's `from`
//                     (src/lunasworkBlenderFrom.js checkRepoFile): guarded in
//                     the repo, no junction or link on the way (realpath
//                     compare), no hard link, size cap, magic bytes; then the
//                     bytes are read through one descriptor, the file is
//                     checked to still be the one that was checked (same
//                     realpath, same inode) and the bytes' own magic is
//                     checked again
//   uploadReferences  one upload per image, in order, of those bytes; an
//                     upload id is a plain token or the call fails before
//                     anything is booked
//
// The CLI never opens a repo path: a link or junction swapped in after the
// check cannot redirect the upload to another file, and the CLI never runs
// in the worker's worktree (where a planted higgsfield.cmd would win the
// cmd.exe lookup).
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { SEGMENT_RE, checkRepoFile } = require('./lunasworkBlenderFrom');
const { imageKind } = require('./lunasworkComfy');

const MAX_REFERENCES = 4;
const MAX_REFERENCE_CHARS = 300;
const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
const REFERENCE_EXTS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
const ART_DIR = 'art';
// An upload id as the CLI prints it (a UUID); a plain token, never a flag.
const UPLOAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const UPLOAD_ID_KEYS = Object.freeze(['id', 'upload_id', 'uploadId', 'media_id', 'mediaId', 'uuid']);
const NESTED_KEYS = Object.freeze(['data', 'upload', 'media', 'result']);
const MAX_ID_DEPTH = 4;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (error, detail) => ({ ok: false, error, detail });

/** The reason one reference path is refused before the disk is touched, or null. */
function badReference(rel, roots, seen) {
  if (typeof rel !== 'string' || !rel || rel.length > MAX_REFERENCE_CHARS) return `each image must be a repo-relative path of at most ${MAX_REFERENCE_CHARS} characters`;
  if (!rel.split('/').every((s) => SEGMENT_RE.test(s) && !s.includes('..'))) return `${rel}: a plain repo-relative path with forward slashes (no "..", no absolute path)`;
  if (![ART_DIR, roots.artRoot].some((root) => rel.startsWith(`${root}/`))) return `${rel}: a reference image must be under ${ART_DIR}/ or ${roots.artRoot}/`;
  if (!REFERENCE_EXTS.includes(path.posix.extname(rel).slice(1).toLowerCase())) return `${rel}: a reference image must be a ${REFERENCE_EXTS.join(' / ')} file`;
  if (seen.includes(rel)) return `${rel} is listed twice`;
  return null;
}

/**
 * The `images` argument as plain repo paths, checked without the disk.
 * @param {unknown} raw untrusted tool argument
 * @param {{artRoot:string}} roots
 * @returns {{ok:true, rels:string[]}|{ok:false, error:string, detail:string}}
 */
function cleanReferences(raw, roots) {
  if (raw === undefined || raw === null) return { ok: true, rels: [] };
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REFERENCES) return fail('badImages', `images must be a list of 1-${MAX_REFERENCES} repo image paths`);
  const rels = [];
  for (const rel of raw) {
    const bad = badReference(rel, roots, rels);
    if (bad) return fail('badImages', bad);
    rels.push(rel);
  }
  return { ok: true, rels };
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const realOf = (fsx, p) => (fsx.realpathSync.native ? fsx.realpathSync.native(p) : fsx.realpathSync(p));

/**
 * The bytes of a checked file, read through one descriptor; throws unless
 * the file read is still the checked one (realpath and inode) and its bytes
 * are a `want` image under the size cap.
 */
function readChecked(fsx, real, want) {
  const fd = fsx.openSync(real, 'r');
  let data;
  let opened;
  try {
    opened = fsx.fstatSync(fd);
    if (!opened.isFile() || opened.nlink > 1) throw new Error('it is not a plain file');
    if (opened.size > MAX_REFERENCE_BYTES) throw new Error(`it is larger than ${MAX_REFERENCE_BYTES} bytes`);
    data = Buffer.alloc(opened.size);
    let at = 0;
    while (at < data.length) {
      const n = fsx.readSync(fd, data, at, data.length - at, at);
      if (n === 0) break;
      at += n;
    }
    data = data.subarray(0, at);
  } finally {
    fsx.closeSync(fd);
  }
  // A link or junction swapped in after the check shows up as another path or another file.
  if (realOf(fsx, real) !== real || !sameFile(fsx.statSync(real), opened)) throw new Error('it changed while it was read');
  if (imageKind(data) !== want) throw new Error(`its bytes are not a ${want.toUpperCase()} image`);
  return data;
}

/**
 * Every reference image checked on disk (checkRepoFile), then read once.
 * @param {string[]} rels from cleanReferences
 * @param {{repoPath:string, fsImpl?:object, files:{guard:(rel:string)=>string}}} deps
 * @returns {{ok:true, files:{rel:string, ext:string, data:Buffer}[]}|{ok:false, error:string, detail:string}}
 */
function resolveReferences(rels, deps) {
  const fsx = deps.fsImpl || fs;
  const files = [];
  for (const rel of rels) {
    const named = path.posix.extname(rel).slice(1).toLowerCase();
    const ext = named === 'jpeg' ? 'jpg' : named;
    try {
      const real = checkRepoFile({ rel, ext: named, type: 'texture' }, deps);
      files.push({ rel, ext, data: readChecked(fsx, real, ext) });
    } catch (err) {
      return fail('badImages', `refused: ${rel}: ${err && err.code === 'ENOENT' ? 'no such file' : errText(err)}`);
    }
  }
  return { ok: true, files };
}

/** The upload id in a `higgsfield upload create --json` answer, or null. */
function uploadIdOf(json, depth = 0) {
  if (typeof json === 'string') return UPLOAD_ID_RE.test(json) ? json : null;
  if (depth > MAX_ID_DEPTH) return null;
  if (Array.isArray(json)) return json.length === 1 ? uploadIdOf(json[0], depth + 1) : null;
  if (!isObj(json)) return null;
  const direct = UPLOAD_ID_KEYS.find((key) => typeof json[key] === 'string' && UPLOAD_ID_RE.test(json[key]));
  if (direct) return json[direct];
  for (const key of NESTED_KEYS) {
    const found = isObj(json[key]) || Array.isArray(json[key]) ? uploadIdOf(json[key], depth + 1) : null;
    if (found) return found;
  }
  return null;
}

/**
 * Uploads every reference image's checked bytes, in order. Nothing is booked
 * or generated yet: a failed upload fails the call before any paid step.
 * @param {(file:{name:string, data:Buffer})=>Promise<{id:unknown}>} upload the CLI adapter (src/lunasworkAssetTools.js)
 * @param {{rel:string, ext:string, data:Buffer}[]} files from resolveReferences
 * @returns {Promise<{ok:true, ids:string[]}|{ok:false, error:string, detail:string}>}
 */
async function uploadReferences(upload, files) {
  if (!files.length) return { ok: true, ids: [] };
  if (typeof upload !== 'function') return fail('toolDown', 'the Higgsfield CLI adapter cannot upload reference images');
  const ids = [];
  for (const [i, { rel, ext, data }] of files.entries()) {
    let res;
    try {
      res = await upload({ name: `reference-${i + 1}.${ext}`, data });
    } catch (err) {
      return fail('higgsfieldFailed', `reference upload of ${rel} failed (nothing was booked): ${errText(err)}`);
    }
    const id = isObj(res) && typeof res.id === 'string' && UPLOAD_ID_RE.test(res.id) ? res.id : null;
    if (!id) return fail('higgsfieldFailed', `reference upload of ${rel} answered no usable upload id (nothing was booked)`);
    ids.push(id);
  }
  return { ok: true, ids };
}

module.exports = { MAX_REFERENCES, MAX_REFERENCE_BYTES, REFERENCE_EXTS, UPLOAD_ID_RE, cleanReferences, resolveReferences, uploadIdOf, uploadReferences };
