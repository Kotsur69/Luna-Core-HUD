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
//                    further Higgsfield call is made, not even an estimate
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
// tmp + rename. Tool output is validated before it is written: image / FBX /
// .blend magic bytes, size caps, URL shapes.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
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
const PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM_VALUE_RE = /^[\w:.-]{1,40}$/;
const MAX_PARAMS = 8;
const WORKFLOW_FILE_RE = /^[\w-]{1,80}\.json$/;
const JOB_ID_RE = /^[\w-]{1,100}$/;
const MAX_SEED = Number.MAX_SAFE_INTEGER;

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
    if (!PARAM_KEY_RE.test(k) || typeof value !== 'string' || !PARAM_VALUE_RE.test(value)) return null;
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

  /** mkdir -p, then the guard again (a junction made meanwhile), then tmp + rename. */
  function writeRepoFile(rel, data) {
    guardPath(rel);
    fsx.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    const target = guardPath(rel);
    const tmp = `${target}.${process.pid}.tmp`;
    fsx.writeFileSync(tmp, data);
    fsx.renameSync(tmp, target);
    return rel;
  }

  function readRepoFile(rel, max) {
    const target = guardPath(rel);
    const st = fsx.statSync(target);
    if (!st.isFile() || st.size > max) throw new Error(`${rel} is not a file under ${max} bytes`);
    return fsx.readFileSync(target);
  }

  /** Imports one file (and its prefab / material) into the open editor. Never throws. */
  async function importToUnity(rel, kind) {
    if (!d.unity || typeof d.unity.exec !== 'function') return { ok: false, calls: [], error: 'unity not connected' };
    const calls = [];
    const call = async (entry) => {
      calls.push(entry[0]);
      return pipelineCall(d.unity, entry);
    };
    try {
      await call(UNITY_PIPELINE_ASSETS.importAsset(rel));
      const base = rel.replace(/\.[a-z0-9]+$/i, '');
      if (KINDS[kind].model) await call(UNITY_PIPELINE_ASSETS.createPrefab(rel, `${base}.prefab`));
      if (KINDS[kind].material) await call(UNITY_PIPELINE_ASSETS.createMaterial(rel, `${base}.mat`));
      return { ok: true, calls };
    } catch (err) {
      return { ok: false, calls, error: oneLine(errText(err), 300) };
    }
  }

  function log(entry) {
    const clean = cleanAssetEntry({ at: now(), ...entry });
    if (!clean || typeof d.logAsset !== 'function') return;
    try {
      d.logAsset(clean);
    } catch {
      // The report entry is best effort; the asset itself is made and on disk.
    }
  }

  const importNote = (imp) => (imp.ok ? null : `Unity import failed (${imp.error}): the file is in the project; import it with your Unity MCP.`);

  // ---- Blender -------------------------------------------------------------------------

  /** Saves the open Blender scene and exports it to Unity as FBX + prefab. */
  async function blenderModel(raw) {
    const job = cleanJob(raw, MODEL_KINDS);
    if (!job.ok) return job;
    if (!d.blender || typeof d.blender.executeCode !== 'function') return fail('toolDown', 'blender not connected');
    const blendRel = `${SOURCE_DIRS.blender}/${job.slug}.blend`;
    const fbxRel = assetPath(artRoot, job.kind, job.slug, 'fbx');
    try {
      for (const rel of [blendRel, fbxRel]) {
        guardPath(rel);
        fsx.mkdirSync(path.dirname(abs(rel)), { recursive: true });
        guardPath(rel);
      }
      await d.blender.executeCode(blenderExportScript(abs(blendRel), abs(fbxRel)));
    } catch (err) {
      return fail('blenderFailed', errText(err));
    }
    try {
      if (!isBlend(readRepoFile(blendRel, MAX_DOWNLOAD_BYTES * 5))) return fail('blenderFailed', `${blendRel} is not a .blend file`);
      if (!isFbx(readRepoFile(fbxRel, MAX_DOWNLOAD_BYTES * 5))) return fail('blenderFailed', `${fbxRel} is not an FBX file`);
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
    const stem = `${job.slug}-draft-${seed}`;
    const files = [];
    const imports = [];
    try {
      for (const [i, img] of images.entries()) {
        const rel = assetPath(artRoot, job.kind, images.length > 1 ? `${stem}-${i + 1}` : stem, comfyLib.imageKind(img.data));
        files.push(writeRepoFile(rel, img.data));
      }
      const record = { name: job.name, kind: job.kind, prompt: job.prompt, seed, workflow: loaded.rel, promptId: oneLine(res.promptId, 64), outputs: files, api: prompted.workflow };
      const runRel = `${SOURCE_DIRS.comfyRuns}/${stem}.json`;
      writeRepoFile(runRel, `${JSON.stringify(record, null, 2)}\n`);
      for (const rel of files) imports.push(await importToUnity(rel, job.kind));
      for (const [i, rel] of files.entries()) {
        log({ tool: 'comfyui', kind: job.kind, name: job.name, prompt: job.prompt, seed, costUsd: 0, path: rel, sources: [loaded.rel, runRel], imported: imports[i].ok });
      }
      const failed = imports.find((imp) => !imp.ok);
      return { ok: true, files, sources: [loaded.rel, runRel], seed, seeded: seeded.seeded, unity: imports, note: failed ? importNote(failed) : null };
    } catch (err) {
      return fail('writeFailed', errText(err));
    }
  }

  // ---- Higgsfield ----------------------------------------------------------------------

  const cappedNow = () => (typeof d.cappedTools === 'function' ? d.cappedTools() : []);

  /** Estimate -> book against the cap -> generate -> download -> save -> import -> log. */
  async function higgsfieldFinal(raw) {
    const job = cleanJob(raw, [...IMAGE_KINDS, ...MODEL_KINDS]);
    if (!job.ok) return job;
    if (higgsfieldStopped || cappedNow().includes('higgsfield')) return fail('capReached', higgsfieldStopped || 'the Higgsfield spend cap of this run is reached');
    if (!d.higgsfield || typeof d.higgsfield.generate !== 'function') return fail('toolDown', 'higgsfield not connected');
    const model = isObj(raw) ? raw.model : undefined;
    if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) return fail('badModel', 'model must be a Higgsfield model id such as gpt_image_2_6');
    const params = cleanParams(isObj(raw) ? raw.params : undefined);
    if (!params) return fail('badParams', `params: at most ${MAX_PARAMS} plain key/value flags`);
    if (!job.prompt) return fail('badPrompt', 'a Higgsfield final needs a prompt');
    const request = { model, prompt: job.prompt, params };

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

    let gen;
    try {
      gen = await d.higgsfield.generate(request);
    } catch (err) {
      return fail('higgsfieldFailed', errText(err));
    }
    const urls = (isObj(gen) && Array.isArray(gen.urls) ? gen.urls : []).filter((u) => typeof u === 'string').slice(0, MAX_HIGGSFIELD_RESULTS);
    if (!urls.length) return fail('higgsfieldFailed', 'Higgsfield returned no result URL');
    if (typeof d.download !== 'function') return fail('higgsfieldFailed', 'no downloader');
    const jobId = isObj(gen) && typeof gen.jobId === 'string' && JOB_ID_RE.test(gen.jobId) ? gen.jobId : null;
    const seed = isObj(gen) && Number.isSafeInteger(gen.seed) && gen.seed >= 0 ? gen.seed : null;
    const files = [];
    const imports = [];
    try {
      for (const [i, url] of urls.entries()) {
        const data = await d.download(url);
        if (!Buffer.isBuffer(data) || data.length > MAX_DOWNLOAD_BYTES) throw new Error('a result is missing or too large');
        const ext = resultExt(data);
        if (!ext) throw new Error('a result is not an image or a GLB model');
        files.push(writeRepoFile(assetPath(artRoot, job.kind, urls.length > 1 ? `${job.slug}-${i + 1}` : job.slug, ext), data));
      }
      const recordRel = `${SOURCE_DIRS.higgsfield}/${job.slug}.json`;
      writeRepoFile(recordRel, `${JSON.stringify({ name: job.name, kind: job.kind, model, prompt: job.prompt, params, seed, jobId, credits, costUsd, outputs: files }, null, 2)}\n`);
      for (const rel of files) imports.push(await importToUnity(rel, /\.glb$/.test(rel) ? 'model' : job.kind));
      // The cost is booked once; it is logged on the first file of the generation.
      for (const [i, rel] of files.entries()) {
        log({ tool: 'higgsfield', kind: job.kind, name: job.name, prompt: job.prompt, seed, costUsd: i === 0 ? costUsd : 0, credits: i === 0 ? credits : 0, path: rel, sources: [recordRel], imported: imports[i].ok });
      }
      const failed = imports.find((imp) => !imp.ok);
      return { ok: true, files, sources: [recordRel], costUsd, credits, unity: imports, note: failed ? importNote(failed) : null };
    } catch (err) {
      return fail('higgsfieldFailed', `generated and paid, but not saved: ${errText(err)}`);
    }
  }

  return { blenderModel, comfyDraft, higgsfieldFinal, artRoot, usdPerCredit };
}

// ---- report lines -----------------------------------------------------------------------

/** "## Generated assets" lines of the run report, one per logged asset. */
function assetReportLines(entries) {
  const list = (Array.isArray(entries) ? entries : []).map(cleanAssetEntry).filter(Boolean);
  return list.map((e) => {
    const seed = e.seed === null ? '-' : String(e.seed);
    const cost = e.costUsd > 0 ? `$${e.costUsd.toFixed(2)}${e.credits !== null ? ` (${e.credits} credits)` : ''}` : '$0';
    const prompt = e.prompt ? `"${oneLine(e.prompt, 160)}"` : '-';
    return `${e.tool} ${e.kind} "${e.name}": ${e.path} - prompt ${prompt}, seed ${seed}, cost ${cost}${e.imported ? '' : ', not imported'}`;
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
  cleanAssetEntry,
  createAssetPipeline,
  assetReportLines,
  assetSpendUsd,
};
