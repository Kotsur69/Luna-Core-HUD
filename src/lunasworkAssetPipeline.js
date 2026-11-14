// ============================================================================
// LunaCore - Luna's Work asset pipeline executor (game assets, Unity projects)
// ----------------------------------------------------------------------------
// src/lunasworkAssets.js decides WHAT to make (design/ASSETS.md -> asset
// cards for the scene worker). This module MAKES it, when the asset worker
// asks through the lunacore MCP tools (src/lunasworkAssetTools.js):
//
//   blenderModel     the model the worker built in Blender (Blender MCP): the
//                    open scene is saved to art/blender/<slug>.blend and
//                    exported as FBX for Unity (-Z forward, Y up, scale
//                    applied) to <artRoot>/<Kind>/<slug>.fbx, then imported
//                    and turned into <artRoot>/<Kind>/<slug>.prefab
//   comfyDraft       a local ComfyUI draft: an API-format workflow from the
//                    game repo's art/comfyui/, seeded and prompted, run through
//                    src/lunasworkComfy.js; the images go to <artRoot>/<Kind>/
//                    and the exact workflow + seed to art/comfyui/runs/ so the
//                    draft can be made again
//   higgsfieldFinal  a paid Higgsfield final (concept art, texture, VFX, key
//                    art): the cost is estimated and BOOKED against the run's
//                    spend cap (recordSpend, src/lunasworkToolGuard.js) before
//                    anything is generated. A refused booking stops Higgsfield
//                    for the rest of the run (the guard files the card); no
//                    further Higgsfield call is made, not even an estimate.
//                    The record art/higgsfield/<kind>/<stem>.json is written
//                    before the download, so a paid job is never lost; a
//                    result that does not end as files is still logged with
//                    its cost (unsaved). A used name gets -v2, -v3...
//
// Every made file is imported through the Unity Pipeline (the asset calls of
// helpers/playtest-bridge/unity.js); a texture also gets a material. An editor
// that is not open fails only the import: the files stay, the worker is told
// to import through its own Unity MCP. Every made asset is logged once
// (logAsset: tool, kind, name, prompt, seed, cost, path) for the run report.
//
// Boundaries: every path is built here from a validated kind and slug; a model
// or a tool never names a file. Writes stay inside the project repo
// (lunasworkToolkit.isWritablePath, which resolves junctions) and go through
// a fresh random tmp file ('wx') + rename. Tool output is validated before it
// is written: image / FBX / .blend magic bytes, size caps, URL shapes.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isWritablePath } = require('./lunasworkToolkit');
const comfyLib = require('./lunasworkComfy');
const { UNITY_PIPELINE_ASSETS, pipelineCall } = require('../helpers/playtest-bridge/unity');

const DEFAULT_ART_ROOT = 'Assets/BladeBullet/Art';
const ART_ROOT_RE = /^Assets(\/[A-Za-z0-9_-]{1,40}){1,4}$/;
const SOURCE_DIRS = Object.freeze({ blender: 'art/blender', comfyRuns: 'art/comfyui/runs', higgsfield: 'art/higgsfield' });
const COMFY_WORKFLOW_DIR = 'art/comfyui';
// The asset kinds and their folder under the art root; 3D kinds get a prefab, textures a material.
const KINDS = Object.freeze({
  character: Object.freeze({ dir: 'Characters', model: true }),
  prop: Object.freeze({ dir: 'Props', model: true }),
  environment: Object.freeze({ dir: 'Environments', model: true }),
  model: Object.freeze({ dir: 'Models', model: true }),
  concept: Object.freeze({ dir: 'Concepts' }),
  keyart: Object.freeze({ dir: 'KeyArt' }),
  sprite: Object.freeze({ dir: 'Sprites' }),
  texture: Object.freeze({ dir: 'Textures', material: true }),
  material: Object.freeze({ dir: 'Materials' }),
  ui: Object.freeze({ dir: 'UI' }),
  vfx: Object.freeze({ dir: 'VFX' }),
  animation: Object.freeze({ dir: 'Animations' }),
  audio: Object.freeze({ dir: 'Audio' }),
  other: Object.freeze({ dir: 'Misc' }),
});
const MODEL_KINDS = Object.freeze(Object.keys(KINDS).filter((k) => KINDS[k].model));
const IMAGE_KINDS = Object.freeze(Object.keys(KINDS).filter((k) => !KINDS[k].model && !['animation', 'audio', 'material'].includes(k)));

// A Higgsfield credit in USD when the settings name none: on the high side,
// so the cap binds early rather than late. Set the plan's real rate in settings.
const DEFAULT_USD_PER_CREDIT = 0.1;
const MAX_USD_PER_CREDIT = 10;
const MAX_CREDITS = 10000;
const MAX_NAME_CHARS = 80;
const MAX_PROMPT_CHARS = 2000;
const MAX_SLUG_CHARS = 60;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const MAX_HIGGSFIELD_RESULTS = 4;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
// Flags the pipeline sets itself or that would point the CLI at files, accounts or other output.
const RESERVED_PARAM_KEYS = Object.freeze(new Set(['json', 'wait', 'wait_timeout', 'output', 'out', 'file', 'path', 'dir', 'download', 'save', 'config', 'profile', 'token', 'api_key', 'help', 'version']));
// Never a leading '-': a value must not read as a CLI flag.
const PARAM_VALUE_RE = /^[A-Za-z0-9][\w:.-]{0,39}$/;
const MAX_PARAMS = 8;
const WORKFLOW_FILE_RE = /^[\w-]{1,80}\.json$/;
const JOB_ID_RE = /^[\w-]{1,100}$/;
const MAX_SEED = Number.MAX_SAFE_INTEGER;
// What a Higgsfield result can turn out to be; a free name must be free for each.
const RESULT_EXTS = Object.freeze(['png', 'jpg', 'webp', 'glb']);
const IMAGE_EXTS = Object.freeze(['png', 'jpg', 'webp']);
// Files Unity imports as a model, so they get a prefab.
const MODEL_EXTS = Object.freeze(['fbx', 'glb']);
// "<slug>", "<slug>-v2" ... "<slug>-v50": a made asset never overwrites an earlier one.
const MAX_VERSIONS = 50;
const HEAD_BYTES = 64;

const FBX_BINARY = Buffer.from('Kaydara FBX Binary', 'latin1');
const BLEND_MAGICS = Object.freeze([Buffer.from('BLENDER', 'latin1'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x1f, 0x8b])]);
const GLB_MAGIC = Buffer.from('glTF', 'latin1');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail: oneLine(detail, 300) } : {}) });

// ---- names and paths (pure) -------------------------------------------------------------

/** "Hero Ship!" -> "hero-ship"; '' when nothing usable is left. */
function slugOf(name) {
  return oneLine(name, MAX_NAME_CHARS).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG_CHARS).replace(/-+$/, '');
}

/** The art root a setting names, else the default. */
function artRootOf(raw) {
  return typeof raw === 'string' && ART_ROOT_RE.test(raw) ? raw : DEFAULT_ART_ROOT;
}

/** Where an asset of `kind` named `slug` goes: <artRoot>/<KindDir>/<slug>.<ext> */
function assetPath(artRoot, kind, slug, ext) {
  return `${artRootOf(artRoot)}/${KINDS[kind].dir}/${slug}.${ext}`;
}

/** The file stem of result `i` of `n`: "<stem>" alone, "<stem>-1", "<stem>-2"... in a set. */
const resultStem = (stem, i, n) => (n > 1 ? `${stem}-${i + 1}` : stem);

/** A result URL as a source record keeps it: origin + path, no query (a signed URL's token stays out of git). */
function recordUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

const recordText = (record) => `${JSON.stringify(record, null, 2)}\n`;

/**
 * A job's common fields, validated: a known kind (one of `allowed`), a name
 * that makes a slug, a one-line prompt.
 * @returns {{ok:true, kind:string, name:string, slug:string, prompt:string}|{ok:false, error:string}}
 */
function cleanJob(raw, allowed) {
  const j = isObj(raw) ? raw : {};
  if (typeof j.kind !== 'string' || !allowed.includes(j.kind)) return fail('badKind', `kind must be one of ${allowed.join(', ')}`);
  const name = oneLine(j.name, MAX_NAME_CHARS);
  const slug = slugOf(name);
  if (!slug) return fail('badName', 'name must contain letters or digits');
  return { ok: true, kind: j.kind, name, slug, prompt: oneLine(j.prompt, MAX_PROMPT_CHARS) };
}

/** Higgsfield model params: a few plain key/value flags, nothing a shell could read. */
function cleanParams(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_PARAMS) return null;
  const out = {};
  for (const [k, v] of entries) {
    const value = typeof v === 'number' && Number.isFinite(v) ? String(v) : v;
    if (!PARAM_KEY_RE.test(k) || RESERVED_PARAM_KEYS.has(k) || typeof value !== 'string' || !PARAM_VALUE_RE.test(value)) return null;
    out[k] = value;
  }
  return out;
}

const startsWith = (buf, magic) => Buffer.isBuffer(buf) && buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
const isFbx = (buf) => startsWith(buf, FBX_BINARY) || (Buffer.isBuffer(buf) && /^\s*; FBX/.test(buf.toString('latin1', 0, 64)));
const isBlend = (buf) => BLEND_MAGICS.some((m) => startsWith(buf, m));

/** The file extension a Higgsfield result's bytes prove: png / jpg / webp / glb, else null. */
function resultExt(buf) {
  return comfyLib.imageKind(buf) || (startsWith(buf, GLB_MAGIC) ? 'glb' : null);
}

/**
 * The Python the Blender MCP add-on runs: save the open scene as a copy, then
 * export FBX for Unity. Paths go in as JSON string literals (valid Python).
 */
function blenderExportScript(blendAbs, fbxAbs) {
  const lit = (p) => JSON.stringify(p.split(path.sep).join('/'));
  return [
    'import bpy',
    `bpy.ops.wm.save_as_mainfile(filepath=${lit(blendAbs)}, copy=True)`,
    `bpy.ops.export_scene.fbx(filepath=${lit(fbxAbs)}, use_selection=False,`,
    "    object_types={'ARMATURE', 'MESH', 'EMPTY'}, apply_unit_scale=True, apply_scale_options='FBX_SCALE_ALL',",
    "    axis_forward='-Z', axis_up='Y', bake_space_transform=True, add_leaf_bones=False,",
    "    mesh_smooth_type='FACE', use_mesh_modifiers=True, bake_anim=True, path_mode='COPY', embed_textures=True)",
    "print('LUNACORE_EXPORT_OK')",
  ].join('\n');
}

// ---- the asset log ------------------------------------------------------------------------

const ASSET_TOOLS = Object.freeze(['blender', 'comfyui', 'higgsfield']);
const MAX_LOG_PATH_CHARS = 300;

/** One run-report entry, validated (it may come back from a stored run). Null when unusable. */
function cleanAssetEntry(raw) {
  if (!isObj(raw) || !ASSET_TOOLS.includes(raw.tool) || !own(KINDS, raw.kind)) return null;
  const filePath = oneLine(raw.path, MAX_LOG_PATH_CHARS);
  if (!filePath) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    at: num(raw.at),
    tool: raw.tool,
    kind: raw.kind,
    name: oneLine(raw.name, MAX_NAME_CHARS),
    prompt: oneLine(raw.prompt, MAX_PROMPT_CHARS),
    seed: Number.isSafeInteger(raw.seed) && raw.seed >= 0 ? raw.seed : null,
    costUsd: num(raw.costUsd) === null ? 0 : raw.costUsd,
    credits: num(raw.credits),
    path: filePath,
    sources: (Array.isArray(raw.sources) ? raw.sources : []).slice(0, 4).map((s) => oneLine(s, MAX_LOG_PATH_CHARS)).filter(Boolean),
    imported: raw.imported === true,
    // A paid generation whose result did not end up as files (path is then its record).
    unsaved: raw.unsaved === true,
  };
}

// ---- the executor -------------------------------------------------------------------------

/**
 * @param {{repoPath:string, artRoot?:string, usdPerCredit?:number,
 *   comfy?:{run:(workflow:object)=>Promise<{promptId:string, images:{data:Buffer, ext:string}[]}>},
 *   higgsfield?:{estimate:(job:object)=>Promise<{credits:number}>, generate:(job:object)=>Promise<{jobId?:string, urls:string[], seed?:number}>},
 *   download?:(url:string)=>Promise<Buffer>,
 *   blender?:{executeCode:(code:string)=>Promise<unknown>},
 *   unity?:{exec:(command:string, parameters:object)=>Promise<unknown>},
 *   recordSpend:(p:{tool:string, costUsd:number})=>{ok:boolean, reason:string|null},
 *   cappedTools?:()=>string[], logAsset?:(entry:object)=>void,
 *   fsImpl?:object, now?:()=>number, randomSeed?:()=>number}} deps
 */
function createAssetPipeline(deps) {
  const d = isObj(deps) ? deps : {};
  const fsx = d.fsImpl || fs;
  const now = d.now || Date.now;
  const artRoot = artRootOf(d.artRoot);
  const usdPerCredit = typeof d.usdPerCredit === 'number' && d.usdPerCredit > 0 && d.usdPerCredit <= MAX_USD_PER_CREDIT ? d.usdPerCredit : DEFAULT_USD_PER_CREDIT;
  const newSeed = d.randomSeed || comfyLib.randomSeed;
  // Set once a booking is refused: no more Higgsfield calls from this pipeline.
  let higgsfieldStopped = null;

  if (typeof d.repoPath !== 'string' || !path.isAbsolute(d.repoPath)) throw new Error('the asset pipeline needs the absolute project repo path');
  const repoPath = path.resolve(d.repoPath);
  const abs = (rel) => path.join(repoPath, ...rel.split('/'));

  /** Throws unless `rel` resolves inside the repo (junctions included) and is not a link itself. */
  function guardPath(rel) {
    const target = abs(rel);
    if (!isWritablePath(target, { repoPath }, fsx)) throw new Error(`refused: ${rel} resolves outside the project repo`);
    try {
      if (fsx.lstatSync(target).isSymbolicLink()) throw new Error(`refused: ${rel} is a link`);
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    return target;
  }

  /** Removes our temp file after a failed write; a failed removal is added to the error. */
  function dropTmp(err, tmp, tmpRel) {
    try {
      fsx.unlinkSync(tmp);
    } catch (cleanupErr) {
      if (cleanupErr && cleanupErr.code !== 'ENOENT') {
        const why = ` (and ${tmpRel} could not be removed: ${errText(cleanupErr)})`;
        return err instanceof Error ? Object.assign(err, { message: err.message + why }) : new Error(errText(err) + why);
      }
    }
    return err;
  }

  /** mkdir -p, the guard again (a junction made meanwhile), then a fresh tmp file + rename. */
  function writeRepoFile(rel, data) {
    guardPath(rel);
    fsx.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    const target = guardPath(rel);
    // A random name created with 'wx': never an existing file or a planted link.
    const tmpRel = `${rel}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const tmp = guardPath(tmpRel);
    try {
      fsx.writeFileSync(tmp, data, { flag: 'wx' });
    } catch (err) {
      // EEXIST: the name belongs to a file that is not ours; never delete it.
      throw err && err.code === 'EEXIST' ? err : dropTmp(err, tmp, tmpRel);
    }
    try {
      fsx.renameSync(tmp, target);
    } catch (err) {
      throw dropTmp(err, tmp, tmpRel);
    }
    return rel;
  }

  function readRepoFile(rel, max) {
    const target = guardPath(rel);
    const st = fsx.statSync(target);
    if (!st.isFile() || st.size > max) throw new Error(`${rel} is not a file under ${max} bytes`);
    return fsx.readFileSync(target);
  }

  /** The stat of a repo path (guarded), or null when nothing is there. */
  function statOf(rel) {
    try {
      return fsx.statSync(guardPath(rel));
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** The first HEAD_BYTES of a repo file: enough for every magic-byte check. */
  function readHead(rel) {
    const fd = fsx.openSync(guardPath(rel), 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      return buf.subarray(0, fsx.readSync(fd, buf, 0, HEAD_BYTES, 0));
    } finally {
      fsx.closeSync(fd);
    }
  }

  /** `base`, else `base-v2`, `base-v3`...: the first stem none of whose files exist yet. */
  function freeStem(base, relsFor) {
    for (let v = 1; v <= MAX_VERSIONS; v += 1) {
      const stem = v === 1 ? base : `${base}-v${v}`;
      if (!relsFor(stem).some((rel) => statOf(rel) !== null)) return stem;
    }
    throw new Error(`${MAX_VERSIONS} versions of ${base} exist already`);
  }

  /**
   * Imports one file into the open editor. What follows depends on the file,
   * not only the asked kind: a model file (FBX / GLB) gets a prefab, an image
   * of a material kind (texture) a material. Never throws.
   */
  async function importToUnity(rel, kind) {
    if (!d.unity || typeof d.unity.exec !== 'function') return { ok: false, calls: [], error: 'unity not connected' };
    const calls = [];
    const call = async (entry) => {
      calls.push(entry[0]);
      return pipelineCall(d.unity, entry);
    };
    const ext = path.posix.extname(rel).slice(1).toLowerCase();
    const base = rel.slice(0, rel.length - ext.length - 1);
    try {
      await call(UNITY_PIPELINE_ASSETS.importAsset(rel));
      if (MODEL_EXTS.includes(ext)) await call(UNITY_PIPELINE_ASSETS.createPrefab(rel, `${base}.prefab`));
      else if (KINDS[kind].material && IMAGE_EXTS.includes(ext)) await call(UNITY_PIPELINE_ASSETS.createMaterial(rel, `${base}.mat`));
      return { ok: true, calls };
    } catch (err) {
      return { ok: false, calls, error: oneLine(errText(err), 300) };
    }
  }

  /**
   * One run-report entry. Never throws: the asset itself is made and on disk.
   * False when the entry could not be logged, so a caller whose entry is the
   * only trace of a cost (paidUnsaved) can say so in its answer.
   */
  function log(entry) {
    const clean = cleanAssetEntry({ at: now(), ...entry });
    if (!clean || typeof d.logAsset !== 'function') return false;
    try {
      d.logAsset(clean);
      return true;
    } catch {
      return false;
    }
  }

  const importNote = (imp) => (imp.ok ? null : `Unity import failed (${imp.error}): the file is in the project; import it with your Unity MCP.`);

  // ---- Blender -------------------------------------------------------------------------

  /** Throws unless Blender wrote `rel` now (new, or changed since `before`) with the right header. */
  function checkExport(rel, before, isKind, what) {
    const after = statOf(rel);
    if (!after || !after.isFile()) throw new Error(`${rel} was not written`);
    if (before && after.mtimeMs === before.mtimeMs && after.size === before.size) throw new Error(`${rel} is the earlier file, not a new export`);
    if (!isKind(readHead(rel))) throw new Error(`${rel} is not ${what}`);
  }

  /**
   * Saves the open Blender scene and exports it to Unity as FBX + prefab. A
   * model of the same name is exported again in place (the editor keeps its
   * GUID), unlike a paid Higgsfield final.
   */
  async function blenderModel(raw) {
    const job = cleanJob(raw, MODEL_KINDS);
    if (!job.ok) return job;
    if (!d.blender || typeof d.blender.executeCode !== 'function') return fail('toolDown', 'blender not connected');
    const blendRel = `${SOURCE_DIRS.blender}/${job.slug}.blend`;
    const fbxRel = assetPath(artRoot, job.kind, job.slug, 'fbx');
    let before;
    try {
      for (const rel of [blendRel, fbxRel]) {
        guardPath(rel);
        fsx.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      }
      // statOf guards again after mkdir (a junction made meanwhile).
      before = [statOf(blendRel), statOf(fbxRel)];
      await d.blender.executeCode(blenderExportScript(abs(blendRel), abs(fbxRel)));
    } catch (err) {
      return fail('blenderFailed', errText(err));
    }
    try {
      checkExport(blendRel, before[0], isBlend, 'a .blend file');
      checkExport(fbxRel, before[1], isFbx, 'an FBX file');
    } catch (err) {
      return fail('blenderFailed', `Blender did not write the files: ${errText(err)}`);
    }
    const imp = await importToUnity(fbxRel, job.kind);
    log({ tool: 'blender', kind: job.kind, name: job.name, prompt: job.prompt, seed: null, costUsd: 0, path: fbxRel, sources: [blendRel], imported: imp.ok });
    return { ok: true, files: [fbxRel], sources: [blendRel], prefab: imp.ok ? fbxRel.replace(/\.fbx$/, '.prefab') : null, unity: imp, note: importNote(imp) };
  }

  // ---- ComfyUI -------------------------------------------------------------------------

  function loadWorkflow(file) {
    const name = typeof file === 'string' ? file.replace(/^art\/comfyui\//, '') : '';
    if (!WORKFLOW_FILE_RE.test(name)) return fail('badWorkflow', `workflow must be a .json file name in ${COMFY_WORKFLOW_DIR}/`);
    const rel = `${COMFY_WORKFLOW_DIR}/${name}`;
    let raw;
    try {
      raw = JSON.parse(readRepoFile(rel, MAX_WORKFLOW_BYTES).toString('utf8'));
    } catch (err) {
      return fail('badWorkflow', `${rel}: ${err instanceof SyntaxError ? 'not valid JSON' : errText(err)}`);
    }
    const checked = comfyLib.validateWorkflow(raw);
    return checked.ok ? { ok: true, rel, workflow: checked.workflow } : fail('badWorkflow', `${rel}: ${checked.error}`);
  }

  /** Runs a repo workflow in ComfyUI; saves the images, the workflow and the seed. */
  async function comfyDraft(raw) {
    const job = cleanJob(raw, IMAGE_KINDS);
    if (!job.ok) return job;
    if (!d.comfy || typeof d.comfy.run !== 'function') return fail('toolDown', 'comfyui not connected');
    const given = isObj(raw) ? raw.seed : undefined;
    if (given !== undefined && (!Number.isSafeInteger(given) || given < 0 || given > MAX_SEED)) return fail('badSeed', 'seed must be a non-negative whole number');
    const seed = given === undefined ? newSeed() : given;
    const loaded = loadWorkflow(isObj(raw) ? raw.workflow : undefined);
    if (!loaded.ok) return loaded;
    const seeded = comfyLib.applySeed(loaded.workflow, seed);
    const prompted = comfyLib.applyPrompt(seeded.workflow, job.prompt);
    let res;
    try {
      res = await d.comfy.run(prompted.workflow);
    } catch (err) {
      return fail(err && err.code === comfyLib.COMFY_ERROR.unreachable ? 'toolDown' : 'comfyFailed', errText(err));
    }
    const images = (isObj(res) && Array.isArray(res.images) ? res.images : []).filter((i) => isObj(i) && comfyLib.imageKind(i.data));
    if (!images.length) return fail('comfyFailed', 'ComfyUI returned no image');
    const warnings = [];
    if (!seeded.seeded) warnings.push('the workflow has no numeric seed / noise_seed input: the seed is recorded but did not steer the image');
    if (job.prompt && !prompted.replaced) warnings.push(`the workflow has no "${comfyLib.PROMPT_PLACEHOLDER}" placeholder: the prompt was not used`);
    const runRelOf = (stem) => `${SOURCE_DIRS.comfyRuns}/${stem}.json`;
    const imageRel = (stem, i) => assetPath(artRoot, job.kind, resultStem(stem, i, images.length), comfyLib.imageKind(images[i].data));
    const files = [];
    let runRel;
    try {
      const stem = freeStem(`${job.slug}-draft-${seed}`, (s) => [runRelOf(s), ...images.map((_, i) => imageRel(s, i))]);
      for (const [i, img] of images.entries()) files.push(writeRepoFile(imageRel(stem, i), img.data));
      runRel = writeRepoFile(runRelOf(stem), recordText({
        name: job.name, kind: job.kind, prompt: job.prompt, seed, seedApplied: seeded.seeded > 0, promptApplied: prompted.replaced > 0,
        workflow: loaded.rel, promptId: oneLine(res.promptId, 64), outputs: files, api: prompted.workflow,
      }));
    } catch (err) {
      return { ...fail('writeFailed', errText(err)), files };
    }
    const imports = [];
    for (const rel of files) imports.push(await importToUnity(rel, job.kind));
    for (const [i, rel] of files.entries()) {
      log({ tool: 'comfyui', kind: job.kind, name: job.name, prompt: job.prompt, seed, costUsd: 0, path: rel, sources: [loaded.rel, runRel], imported: imports[i].ok });
    }
    const failed = imports.find((imp) => !imp.ok);
    return { ok: true, files, sources: [loaded.rel, runRel], seed, seeded: seeded.seeded, warnings, unity: imports, note: failed ? importNote(failed) : null };
  }

  // ---- Higgsfield ----------------------------------------------------------------------

  const cappedNow = () => (typeof d.cappedTools === 'function' ? d.cappedTools() : []);

  /** The validated job and CLI request of a Higgsfield final, or a failure. Nothing is called yet. */
  function higgsfieldRequest(raw) {
    const job = cleanJob(raw, [...IMAGE_KINDS, ...MODEL_KINDS]);
    if (!job.ok) return job;
    if (higgsfieldStopped || cappedNow().includes('higgsfield')) return fail('capReached', higgsfieldStopped || 'the Higgsfield spend cap of this run is reached');
    const h = d.higgsfield;
    if (!h || typeof h.estimate !== 'function' || typeof h.generate !== 'function') return fail('toolDown', 'higgsfield not connected');
    // Checked before paying: a result that cannot be fetched must not be bought.
    if (typeof d.download !== 'function') return fail('toolDown', 'no downloader for Higgsfield results');
    const model = isObj(raw) ? raw.model : undefined;
    if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) return fail('badModel', 'model must be a Higgsfield model id such as gpt_image_2_6');
    const params = cleanParams(isObj(raw) ? raw.params : undefined);
    if (!params) return fail('badParams', `params: at most ${MAX_PARAMS} plain key/value flags, each value starting with a letter or digit`);
    if (!job.prompt) return fail('badPrompt', 'a Higgsfield final needs a prompt');
    return { ok: true, job, request: { model, prompt: job.prompt, params } };
  }

  /** Estimate -> book against the run's cap. A refused booking stops Higgsfield for this pipeline. */
  async function bookHiggsfield(request) {
    let credits;
    try {
      const est = await d.higgsfield.estimate(request);
      credits = isObj(est) ? est.credits : NaN;
    } catch (err) {
      return fail('higgsfieldFailed', `cost estimate failed: ${errText(err)}`);
    }
    if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0 || credits > MAX_CREDITS) return fail('higgsfieldFailed', 'the cost estimate is not a usable number of credits');
    const costUsd = Math.round(credits * usdPerCredit * 10000) / 10000;
    const booked = d.recordSpend({ tool: 'higgsfield', costUsd });
    if (!isObj(booked) || !booked.ok) {
      const reason = (isObj(booked) && booked.reason) || 'refused';
      higgsfieldStopped = `Higgsfield stopped for this run: the booking of $${costUsd.toFixed(2)} was refused (${reason})`;
      return fail(reason === 'capReached' ? 'capReached' : 'spendRefused', higgsfieldStopped);
    }
    return { ok: true, credits, costUsd };
  }

  /** One downloaded result, checked: a Buffer under the cap that proves to be an image or a GLB. */
  async function fetchResult(url) {
    const data = await d.download(url);
    if (!Buffer.isBuffer(data) || data.length > MAX_DOWNLOAD_BYTES) throw new Error('a result is missing or too large');
    const ext = resultExt(data);
    if (!ext) throw new Error('a result is not an image or a GLB model');
    return { data, ext };
  }

  /**
   * A booked generation that did not end as saved files. The record (when one
   * was written) says why, the run report logs the cost, and the worker gets
   * the job id and the result URLs to finish by hand.
   */
  function paidUnsaved(job, paid, info, detail) {
    let text = detail;
    if (info.record && info.recordData) {
      try {
        writeRepoFile(info.record, recordText({ ...info.recordData, status: 'notSaved', outputs: info.files || [], error: oneLine(detail, 300) }));
      } catch (err) {
        text += ` (the record could not be updated: ${errText(err)})`;
      }
    }
    const logged = log({ tool: 'higgsfield', kind: job.kind, name: job.name, prompt: job.prompt, seed: info.seed, costUsd: paid.costUsd, credits: paid.credits, path: info.record || info.path, sources: info.record ? [info.record] : [], imported: false, unsaved: true });
    return {
      ...fail('higgsfieldFailed', text),
      costUsd: paid.costUsd, credits: paid.credits, jobId: info.jobId || null, urls: info.urls || [], record: info.record || null, files: info.files || [],
      ...(logged ? {} : { note: 'The run report could not log this cost; mention it in your hand-back.' }),
    };
  }

  /**
   * Record -> fetch every result -> write -> record again -> import -> log.
   * The record goes first, so a paid job is never lost: its id and URLs are
   * on disk before anything is downloaded. A name already used gets the next
   * free version (-v2, -v3...): a paid final never overwrites another.
   */
  async function saveHiggsfield(job, request, paid, gen) {
    const n = gen.urls.length;
    const recordOf = (stem) => `${SOURCE_DIRS.higgsfield}/${job.kind}/${stem}.json`;
    const fileOf = (stem, i, ext) => assetPath(artRoot, job.kind, resultStem(stem, i, n), ext);
    const recordData = {
      name: job.name, kind: job.kind, model: request.model, prompt: job.prompt, params: request.params, seed: gen.seed, jobId: gen.jobId,
      credits: paid.credits, costUsd: paid.costUsd, urls: gen.urls.map(recordUrl).filter(Boolean), status: 'generated', outputs: [],
    };
    const files = [];
    let record = null;
    let stem;
    try {
      stem = freeStem(job.slug, (s) => [recordOf(s), ...gen.urls.flatMap((_, i) => RESULT_EXTS.map((ext) => fileOf(s, i, ext)))]);
      record = writeRepoFile(recordOf(stem), recordText(recordData));
      // Every result is fetched and checked before the first asset file is written.
      const results = [];
      for (const url of gen.urls) results.push(await fetchResult(url));
      for (const [i, r] of results.entries()) files.push(writeRepoFile(fileOf(stem, i, r.ext), r.data));
    } catch (err) {
      const where = record ? ` and in ${record}` : '';
      const saved = files.length ? `only partially saved (${files.length} of ${n} files)` : 'not saved';
      return paidUnsaved(job, paid, { ...gen, path: `higgsfield:${gen.jobId || request.model}`, record, recordData, files }, `generated and paid, but ${saved}: ${errText(err)}. The job id and result URLs are in this answer${where}.`);
    }
    const notes = [];
    try {
      writeRepoFile(record, recordText({ ...recordData, status: 'saved', outputs: files }));
    } catch (err) {
      notes.push(`the files are saved, but ${record} could not be updated: ${oneLine(errText(err), 200)}`);
    }
    const imports = [];
    for (const rel of files) imports.push(await importToUnity(rel, job.kind));
    // The cost is booked once; it is logged on the first file of the generation.
    for (const [i, rel] of files.entries()) {
      log({ tool: 'higgsfield', kind: job.kind, name: job.name, prompt: job.prompt, seed: gen.seed, costUsd: i === 0 ? paid.costUsd : 0, credits: i === 0 ? paid.credits : 0, path: rel, sources: [record], imported: imports[i].ok });
    }
    const failed = imports.find((imp) => !imp.ok);
    if (failed) notes.push(importNote(failed));
    return { ok: true, files, sources: [record], costUsd: paid.costUsd, credits: paid.credits, jobId: gen.jobId, unity: imports, note: notes.length ? notes.join(' ') : null };
  }

  /** Validate -> estimate + book against the cap -> generate -> save (saveHiggsfield). */
  async function higgsfieldFinal(raw) {
    const req = higgsfieldRequest(raw);
    if (!req.ok) return req;
    const paid = await bookHiggsfield(req.request);
    if (!paid.ok) return paid;
    const { job, request } = req;
    let out;
    try {
      out = await d.higgsfield.generate(request);
    } catch (err) {
      return paidUnsaved(job, paid, { seed: null, path: `higgsfield:${request.model}` }, `$${paid.costUsd.toFixed(2)} was booked, but the generation failed: ${errText(err)}`);
    }
    const gen = {
      urls: (isObj(out) && Array.isArray(out.urls) ? out.urls : []).filter((u) => typeof u === 'string').slice(0, MAX_HIGGSFIELD_RESULTS),
      jobId: isObj(out) && typeof out.jobId === 'string' && JOB_ID_RE.test(out.jobId) ? out.jobId : null,
      seed: isObj(out) && Number.isSafeInteger(out.seed) && out.seed >= 0 ? out.seed : null,
    };
    if (!gen.urls.length) return paidUnsaved(job, paid, { ...gen, path: `higgsfield:${gen.jobId || request.model}` }, `$${paid.costUsd.toFixed(2)} was booked, but Higgsfield returned no result URL (job ${gen.jobId || 'unknown'})`);
    return saveHiggsfield(job, request, paid, gen);
  }

  return { blenderModel, comfyDraft, higgsfieldFinal, artRoot, usdPerCredit };
}

// ---- per-PC settings ----------------------------------------------------------------------

const DEFAULT_BLENDER_PORT = 9876;
const isPort = (v) => Number.isInteger(v) && v >= 1024 && v <= 65535;

/**
 * lunaswork-settings.local.json `assetTools`: the local tools' ports, the
 * Higgsfield credit price and the art root. Every bad value reads as its
 * default; nothing here can point a write outside the repo or a request off
 * loopback (the hosts are fixed in the clients).
 * @returns {{comfyuiPort:number, blenderPort:number, higgsfieldUsdPerCredit:number, artRoot:string}}
 */
function normalizeAssetTools(raw) {
  const r = isObj(raw) ? raw : {};
  const rate = r.higgsfieldUsdPerCredit;
  return {
    comfyuiPort: isPort(r.comfyuiPort) ? r.comfyuiPort : comfyLib.DEFAULT_PORT,
    blenderPort: isPort(r.blenderPort) ? r.blenderPort : DEFAULT_BLENDER_PORT,
    higgsfieldUsdPerCredit: typeof rate === 'number' && rate > 0 && rate <= MAX_USD_PER_CREDIT ? rate : DEFAULT_USD_PER_CREDIT,
    artRoot: artRootOf(r.artRoot),
  };
}

// ---- the asset worker's brief -------------------------------------------------------------

// Blade & Bullet docs/ART_DIRECTION.md (not in this repo): the rule every 3D asset follows.
const ART_DIRECTION_RULE = 'Art direction (docs/ART_DIRECTION.md of the game - read it when the repo has it): 3D toon / cel-shaded characters and props on a 2D plane. Model in 3D, keep gameplay on one plane (X/Y, side-on camera, no depth movement), toon shading with clean outlines, no photoreal materials.';
const AMD_GPU_RULE = 'ComfyUI runs on an AMD GPU: use only models and nodes that run on it (ROCm / DirectML builds such as SD 1.5 and SDXL checkpoints); no CUDA-only nodes (xformers, TensorRT, NVIDIA-only custom nodes).';

/**
 * The Unity part of an asset card's details: where the files go, which tool
 * makes what (lunacore MCP tools of src/lunasworkAssetTools.js), the skills,
 * the art direction and the GPU rule.
 * @param {{kind:string, slug:string, source:string, artRoot?:string}} a kind = an ASSETS.md type
 * @returns {string[]} paragraphs
 */
function unityAssetBrief({ kind, slug, source, artRoot }) {
  const k = own(KINDS, kind) ? kind : 'other';
  const root = artRootOf(artRoot);
  const model = KINDS[k].model === true;
  const make = source === 'blender' || model
    ? `Make it in Blender through the Blender MCP (Blender must be running with its MCP add-on; load the blender-game-assets skill), then call the lunacore tool luna_asset_blender {name, kind: "${k}"}: it saves art/blender/${slug}.blend, exports ${root}/${KINDS[k].dir}/${slug}.fbx for Unity and makes the prefab.`
    : `Drafts: the lunacore tool luna_asset_comfy {name, kind: "${k}", prompt, workflow} runs a workflow from ${COMFY_WORKFLOW_DIR}/ (API format, "{{prompt}}" placeholder) on the local ComfyUI and saves the workflow and seed under ${SOURCE_DIRS.comfyRuns}/. Finals: luna_asset_higgsfield {name, kind: "${k}", prompt, model} (load the higgsfield-media skill).`;
  return [
    `Files: the asset goes to ${root}/${KINDS[k].dir}/, its sources (Blender .blend, ComfyUI workflow + seed, Higgsfield record) to art/. Write only inside this repository.`,
    make,
    'Paid generation goes ONLY through luna_asset_higgsfield: it books the cost against this run\'s Higgsfield budget first. Use the higgsfield CLI / higgsfield-bridge directly only to look up models. When a tool answers capReached, stop using Higgsfield for this run.',
    'The luna_asset_* tools import the result into Unity through the Unity Pipeline (asset import, prefab for a model, material for a texture). When a result says the import failed, import it with your Unity MCP.',
    ART_DIRECTION_RULE,
    AMD_GPU_RULE,
  ];
}

// ---- report lines -----------------------------------------------------------------------

/** "## Generated assets" lines of the run report, one per logged asset. */
function assetReportLines(entries) {
  const list = (Array.isArray(entries) ? entries : []).map(cleanAssetEntry).filter(Boolean);
  return list.map((e) => {
    const seed = e.seed === null ? '-' : String(e.seed);
    const cost = e.costUsd > 0 ? `$${e.costUsd.toFixed(2)}${e.credits !== null ? ` (${e.credits} credits)` : ''}` : '$0';
    const prompt = e.prompt ? `"${oneLine(e.prompt, 160)}"` : '-';
    const state = e.unsaved ? ', PAID BUT NOT SAVED (job id and URLs in the record / the tool answer)' : e.imported ? '' : ', not imported';
    return `${e.tool} ${e.kind} "${e.name}": ${e.path} - prompt ${prompt}, seed ${seed}, cost ${cost}${state}`;
  });
}

/** Total paid spend of the logged assets, in USD. */
const assetSpendUsd = (entries) => (Array.isArray(entries) ? entries : []).map(cleanAssetEntry).filter(Boolean).reduce((sum, e) => sum + e.costUsd, 0);

module.exports = {
  DEFAULT_ART_ROOT,
  DEFAULT_USD_PER_CREDIT,
  COMFY_WORKFLOW_DIR,
  SOURCE_DIRS,
  KINDS,
  MODEL_KINDS,
  IMAGE_KINDS,
  ASSET_TOOLS,
  slugOf,
  artRootOf,
  assetPath,
  cleanParams,
  blenderExportScript,
  normalizeAssetTools,
  unityAssetBrief,
  ART_DIRECTION_RULE,
  AMD_GPU_RULE,
  cleanAssetEntry,
  createAssetPipeline,
  assetReportLines,
  assetSpendUsd,
};
