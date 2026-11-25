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
//                    and turned into <artRoot>/<Kind>/<slug>.prefab; an
//                    optional toon pass and the Critic's turntable sheet
//                    (src/lunasworkAssetBlender.js)
//   comfyDraft       a local ComfyUI draft: an API-format workflow from the
//                    game repo's art/comfyui/, seeded and prompted, run through
//                    src/lunasworkComfy.js; the images go to <artRoot>/<Kind>/
//                    and the exact workflow + seed to art/comfyui/runs/ so the
//                    draft can be made again
//   higgsfieldFinal  a paid Higgsfield final (concept art, texture, VFX, key
//                    art, a GLB): the cost is estimated and BOOKED against the
//                    run's spend cap before anything is generated; optional
//                    reference images; a forBlender result skips the Unity
//                    import (src/lunasworkAssetHiggsfield.js)
//
// Every made file is imported through the Unity Pipeline (the asset calls of
// helpers/playtest-bridge/unity.js), except a Higgsfield result bound for
// luna_asset_blender; a texture also gets a material. An editor
// that is not open fails only the import: the files stay, the worker is told
// to import through its own Unity MCP. Every made asset is logged once
// (logAsset: tool, kind, name, prompt, seed, cost, path) for the run report.
//
// Every made file also gets its row in design/ASSET_LICENSES.md (license
// "Own work (generated)", src/lunasworkLicenses.js), so the Critic's ledger
// check passes; a ledger that cannot be written is a note, never a lost asset.
// The library imports (src/lunasworkFreeAssets.js) reuse this executor's
// guarded repo files, Unity import, asset log and ledger (the `shared` pieces).
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
const licenses = require('./lunasworkLicenses');
const { blenderExportScript } = require('./lunasworkBlenderScript');
const { createBlenderModel } = require('./lunasworkAssetBlender');
const { MAX_USD_PER_CREDIT, resultStem, recordText, cleanParams, createHiggsfieldFinal } = require('./lunasworkAssetHiggsfield');
const { cleanAudioPost, createAudioNormalizer, normalizeAll } = require('./lunasworkAudioNormalize');
const { UNITY_PIPELINE_ASSETS, checkTextureApplied, pipelineCall } = require('../helpers/playtest-bridge/unity');

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
const COMFY_KINDS = Object.freeze([...IMAGE_KINDS, ...MODEL_KINDS, 'audio']);

// A Higgsfield credit in USD when the settings name none: on the high side,
// so the cap binds early rather than late. Set the plan's real rate in settings.
const DEFAULT_USD_PER_CREDIT = 0.1;
const MAX_NAME_CHARS = 80;
const MAX_PROMPT_CHARS = 2000;
const MAX_SLUG_CHARS = 60;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const WORKFLOW_FILE_RE = /^[\w-]{1,80}\.json$/;
const MAX_SEED = Number.MAX_SAFE_INTEGER;
const IMAGE_EXTS = Object.freeze(['png', 'jpg', 'webp']);
// Files Unity imports as a model, so they get a prefab.
const MODEL_EXTS = Object.freeze(['fbx', 'glb', 'gltf']);
// "<slug>", "<slug>-v2" ... "<slug>-v50": a made asset never overwrites an earlier one.
const MAX_VERSIONS = 50;
const HEAD_BYTES = 64;

const FBX_BINARY = Buffer.from('Kaydara FBX Binary', 'latin1');
const BLEND_MAGICS = Object.freeze([Buffer.from('BLENDER', 'latin1'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x1f, 0x8b])]);

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

const startsWith = (buf, magic) => Buffer.isBuffer(buf) && buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
const isFbx = (buf) => startsWith(buf, FBX_BINARY) || (Buffer.isBuffer(buf) && /^\s*; FBX/.test(buf.toString('latin1', 0, 64)));
const isBlend = (buf) => BLEND_MAGICS.some((m) => startsWith(buf, m));

// ---- the asset log ------------------------------------------------------------------------

// 'library': a free asset imported from an asset library (src/lunasworkFreeAssets.js); 'judge': a candidate verdict (src/lunasworkAssetJudge.js).
const ASSET_TOOLS = Object.freeze(['blender', 'comfyui', 'higgsfield', 'library', 'judge']);
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;
const NO_CREDITS_TEXT = 'Third-party assets\n\nNone yet.\n';
const MAX_LOG_PATH_CHARS = 300;
// The content hash a Higgsfield result is logged with (luna_asset_blender from= provenance).
const SHA256_RE = /^[0-9a-f]{64}$/;

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
    ...(typeof raw.sha256 === 'string' && SHA256_RE.test(raw.sha256) ? { sha256: raw.sha256 } : {}),
  };
}

// ---- the executor -------------------------------------------------------------------------

/**
 * @param {{repoPath:string, artRoot?:string, usdPerCredit?:number,
 *   comfy?:{run:(workflow:object)=>Promise<{promptId:string, images:{data:Buffer, ext:string}[]}>},
 *   higgsfield?:{estimate:(job:object)=>Promise<{credits:number}>, generate:(job:object)=>Promise<{jobId?:string, urls:string[], seed?:number}>,
 *     upload?:(rel:string)=>Promise<{id:string}>},
 *   download?:(url:string)=>Promise<Buffer>,
 *   blender?:{executeCode:(code:string)=>Promise<unknown>},
 *   unity?:{exec:(command:string, parameters:object)=>Promise<unknown>},
 *   recordSpend:(p:{tool:string, costUsd:number})=>{ok:boolean, reason:string|null},
 *   cappedTools?:()=>string[], logAsset?:(entry:object)=>void, freeCandidatePassed?:(job:{name:string, kind:string, slug:string})=>boolean,
 *   higgsfieldMade?:(claim:{path:string, record:string})=>boolean,
 *   fsImpl?:object, now?:()=>number, randomSeed?:()=>number,
 *   execFile?:Function}} deps  execFile = child_process.execFile for the optional ffmpeg audio post-process (tests fake it)
 */
function createAssetPipeline(deps) {
  const d = isObj(deps) ? deps : {};
  const fsx = d.fsImpl || fs;
  const now = d.now || Date.now;
  const artRoot = artRootOf(d.artRoot);
  const usdPerCredit = typeof d.usdPerCredit === 'number' && d.usdPerCredit > 0 && d.usdPerCredit <= MAX_USD_PER_CREDIT ? d.usdPerCredit : DEFAULT_USD_PER_CREDIT;
  const newSeed = d.randomSeed || comfyLib.randomSeed;

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
   * Imports one file into the open editor. The file is already written under
   * Assets/, so the import is an AssetDatabase refresh (an unfocused editor
   * does not auto-refresh; see UNITY_PIPELINE_ASSETS). What follows depends on
   * the file, not only the asked kind: a model file (FBX / GLB) gets a prefab,
   * an image of a material kind (texture) a URP material that uses it as its
   * base map. Never throws.
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
      await call(UNITY_PIPELINE_ASSETS.refresh());
      if (MODEL_EXTS.includes(ext)) {
        await call(UNITY_PIPELINE_ASSETS.modelPrefab(rel, `${base}.prefab`));
      } else if (KINDS[kind].material && IMAGE_EXTS.includes(ext)) {
        const material = `${base}.mat`;
        await call(UNITY_PIPELINE_ASSETS.createMaterial(material));
        checkTextureApplied(await call(UNITY_PIPELINE_ASSETS.setMaterialTexture(material, rel)));
      }
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

  /** Deletes a repo file this pipeline wrote (guarded); a missing file is fine. */
  function removeRepoFile(rel) {
    try {
      fsx.unlinkSync(guardPath(rel));
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
  }

  /** Removes a repo folder (guarded) only when it is empty; false when it is not there or not empty. */
  function removeEmptyDir(rel) {
    try {
      fsx.rmdirSync(guardPath(rel));
      return true;
    } catch (err) {
      if (err && ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) return false;
      throw err;
    }
  }

  /**
   * Adds rows to design/ASSET_LICENSES.md (created with its header when
   * missing) and rewrites the CC-BY credits from it, one update per repo at a
   * time. Rejects when the ledger could not be written.
   * @param {{name:string, source:string, author:string, license:string, path:string}[]} rows
   * @returns {Promise<{ledger:string, credits:string|null}>}
   */
  function updateLedger(rows) {
    return licenses.withLedgerLock(repoPath, () => {
      const current = statOf(licenses.LEDGER_FILE) ? readRepoFile(licenses.LEDGER_FILE, MAX_LEDGER_BYTES).toString('utf8') : null;
      const next = licenses.withLedgerRows(current, rows);
      writeRepoFile(licenses.LEDGER_FILE, next);
      const credits = licenses.creditsText(licenses.parseLedger(next).rows);
      if (credits === null && !statOf(licenses.CREDITS_FILE)) return { ledger: licenses.LEDGER_FILE, credits: null };
      try {
        writeRepoFile(licenses.CREDITS_FILE, credits || NO_CREDITS_TEXT);
      } catch (err) {
        // A CC-BY row without its credit would break the license: put the ledger back as it was.
        restoreLedger(current, err);
        throw err;
      }
      return { ledger: licenses.LEDGER_FILE, credits: licenses.CREDITS_FILE };
    });
  }

  /** The ledger as it was before an update whose credits failed; a failed restore is added to `err`. */
  function restoreLedger(previous, err) {
    try {
      if (previous === null) removeRepoFile(licenses.LEDGER_FILE);
      else writeRepoFile(licenses.LEDGER_FILE, previous);
    } catch (restoreErr) {
      if (err instanceof Error) err.message += ` (and ${licenses.LEDGER_FILE} could not be restored: ${errText(restoreErr)})`;
    }
  }

  /**
   * The ledger rows of generated files. `origin` ({author, license}) replaces
   * the generated author and license for a file made from another asset
   * whose own row carries them (luna_asset_blender from=), so a CC-BY credit
   * carries over. Never throws: a failure is a note for the worker.
   */
  async function ledgerGenerated(tool, job, files, source, origin = null) {
    const author = origin ? origin.author : `LunaCore asset worker (${tool})`;
    const license = origin ? origin.license : licenses.GENERATED_LICENSE;
    try {
      await updateLedger(files.map((rel) => ({ name: job.name, source, author, license, path: rel })));
      return null;
    } catch (err) {
      return `${licenses.LEDGER_FILE} was not updated (${oneLine(errText(err), 200)}): add the row(s) by hand.`;
    }
  }

  // The optional ffmpeg audio post-process (src/lunasworkAudioNormalize.js), on the guarded paths.
  const audioNormalizer = createAudioNormalizer({ execFile: d.execFile, fs: fsx, guard: guardPath });

  // ---- Blender -------------------------------------------------------------------------

  // The Blender step lives in src/lunasworkAssetBlender.js, on these guarded pieces.
  const blenderModel = createBlenderModel({
    blender: d.blender,
    cleanJob: (raw) => cleanJob(raw, MODEL_KINDS),
    paths: (job) => ({ blend: `${SOURCE_DIRS.blender}/${job.slug}.blend`, fbx: assetPath(artRoot, job.kind, job.slug, 'fbx') }),
    isBlend,
    isFbx,
    abs,
    files: { guard: guardPath, mkdirFor: (rel) => fsx.mkdirSync(path.dirname(abs(rel)), { recursive: true }), stat: statOf, head: readHead, remove: removeRepoFile, read: readRepoFile },
    ledgerGenerated,
    importToUnity,
    importNote,
    log,
    ledgerFile: licenses.LEDGER_FILE,
    repoPath, artRoot, higgsfieldDir: SOURCE_DIRS.higgsfield, kinds: KINDS, // the checks of a `from` Higgsfield result
    higgsfieldMade: d.higgsfieldMade, // whether this run's asset log backs a `from` record
  });

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

  /** Runs a repo workflow in ComfyUI; saves the outputs (images, audio, or GLB), the workflow and the seed. */
  async function comfyDraft(raw) {
    const job = cleanJob(raw, COMFY_KINDS);
    if (!job.ok) return job;
    if (!d.comfy || typeof d.comfy.run !== 'function') return fail('toolDown', 'comfyui not connected');
    const given = isObj(raw) ? raw.seed : undefined;
    if (given !== undefined && (!Number.isSafeInteger(given) || given < 0 || given > MAX_SEED)) return fail('badSeed', 'seed must be a non-negative whole number');
    const seed = given === undefined ? newSeed() : given;
    const audio = cleanAudioPost(isObj(raw) ? raw.audioPost : undefined);
    if (!audio.ok) return audio;
    if (audio.post && job.kind !== 'audio') return fail('badAudioPost', 'audioPost is only for kind "audio"');
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
    const images = (isObj(res) && Array.isArray(res.images) ? res.images : []).filter((i) => isObj(i) && comfyLib.outputKind(i.data));
    if (!images.length) return fail('comfyFailed', 'ComfyUI returned no valid output (image, audio or GLB)');
    const warnings = [];
    if (!seeded.seeded) warnings.push('the workflow has no numeric seed / noise_seed input: the seed is recorded but did not steer the image');
    if (job.prompt && !prompted.replaced) warnings.push(`the workflow has no "${comfyLib.PROMPT_PLACEHOLDER}" placeholder: the prompt was not used`);
    const runRelOf = (stem) => `${SOURCE_DIRS.comfyRuns}/${stem}.json`;
    const imageRel = (stem, i) => assetPath(artRoot, job.kind, resultStem(stem, i, images.length), comfyLib.outputKind(images[i].data));
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
    // Before the ledger and the Unity import, so both see the final file; a failure keeps the draft as made.
    const audioNote = audio.post ? (await normalizeAll(audioNormalizer, files, audio.post)).note : null;
    const ledgerNote = await ledgerGenerated('ComfyUI', job, files, runRel);
    const imports = [];
    for (const rel of files) imports.push(await importToUnity(rel, job.kind));
    for (const [i, rel] of files.entries()) {
      log({ tool: 'comfyui', kind: job.kind, name: job.name, prompt: job.prompt, seed, costUsd: 0, path: rel, sources: [loaded.rel, runRel], imported: imports[i].ok });
    }
    const failed = imports.find((imp) => !imp.ok);
    const note = [failed ? importNote(failed) : null, ledgerNote, audioNote].filter(Boolean).join(' ') || null;
    return { ok: true, files, sources: [loaded.rel, runRel], seed, seeded: seeded.seeded, warnings, unity: imports, ledger: ledgerNote ? null : licenses.LEDGER_FILE, note };
  }

  // ---- Higgsfield (src/lunasworkAssetHiggsfield.js) ------------------------------------

  const higgsfieldFinal = createHiggsfieldFinal({
    d,
    usdPerCredit,
    cleanJob: (raw) => cleanJob(raw, [...IMAGE_KINDS, ...MODEL_KINDS]),
    modelKinds: MODEL_KINDS,
    artRoot,
    repoPath,
    recordOf: (kind, stem) => `${SOURCE_DIRS.higgsfield}/${kind}/${stem}.json`,
    fileOf: (kind, stem, ext) => assetPath(artRoot, kind, stem, ext),
    files: { write: writeRepoFile, guard: guardPath, freeStem },
    ledgerGenerated,
    importToUnity,
    importNote,
    log,
    ledgerFile: licenses.LEDGER_FILE,
    fsImpl: fsx,
  });

  // The pieces src/lunasworkFreeAssets.js builds the library imports on.
  const shared = {
    repoPath,
    files: { write: writeRepoFile, read: readRepoFile, stat: statOf, remove: removeRepoFile, removeDir: removeEmptyDir, head: readHead },
    importToUnity,
    importNote,
    log,
    updateLedger,
    normalizeAudio: (rels, post) => normalizeAll(audioNormalizer, rels, post),
  };
  return { blenderModel, comfyDraft, higgsfieldFinal, artRoot, usdPerCredit, shared };
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
const AMD_GPU_RULE = 'ComfyUI runs on an AMD GPU (ROCm / ZLUDA / DirectML): use only models and nodes that run on it (SD 1.5, SDXL, Flux, Kokoro-82M / F5-TTS voice, Stable Audio Open SFX, Hunyuan3D-2 / TripoSR 3D); no CUDA-only nodes (xformers, TensorRT, NVIDIA-only custom nodes).';
const LIBRARY_RULE = 'Free library assets: luna_asset_search {source, query} (source "all" searches every library at once) finds CC0 / CC-BY assets on Poly Haven, ambientCG, BlenderKit and Lots of Sounds (no key needed for search/samples), plus Sketchfab (downloadable models only), Poly Pizza, Freesound and Smithsonian 3D (keys come from LunaCore, never ask for one); luna_asset_import {source, id, name, kind} reads the license again from the source API, refuses non-commercial, no-derivatives, share-alike and unknown licenses and game rips, imports the files into Unity and writes the design/ASSET_LICENSES.md row and the CC-BY credits. The Blender MCP search_assets / import_asset (Poly Haven, Sketchfab, Poly Pizza) is fine for browsing or for placing an asset in a Blender scene, but an asset that ends up in the game is brought in with luna_asset_import, so it has its ledger row. Kenney and OpenGameArt have no official API: LunaCore does not fetch from them.';
const NO_RIPS_RULE = `Never assets ripped from existing games. Katana Zero, Zenless Zone Zero (ZZZ), Kurumi and Black Rock Shooter are art references, not sources: no fan rips, nothing extracted from a commercial game. Every file under Assets/**/Art/ needs a row in ${licenses.LEDGER_FILE} (name, source URL, author, license, path); the luna_asset_* tools write it, and the Critic files a card for any file without one.`;

/**
 * The Unity part of an asset card's details: where the files go, which tool
 * makes what (lunacore MCP tools of src/lunasworkAssetTools.js), the skills,
 * the art direction and the GPU rule.
 * @param {{kind:string, slug:string, source:string, artRoot?:string, casting?:string[]}} a kind = an ASSETS.md type;
 *   casting = the Director's cast (src/lunasworkAssetCasting.js renderCastingBrief), after the tool paragraph
 * @returns {string[]} paragraphs
 */
function unityAssetBrief({ kind, slug, source, artRoot, casting }) {
  const k = own(KINDS, kind) ? kind : 'other';
  const root = artRootOf(artRoot);
  const model = KINDS[k].model === true;
  const library = `Take it from a free asset library: luna_asset_search, then luna_asset_import {source, id, name, kind: "${k}"}; it lands under ${root}/${KINDS[k].dir}/.`;
  const make = source === 'library' ? library : source === 'blender' || model
    ? `Make it in Blender through the Blender MCP (Blender must be running with its MCP add-on; load the blender-game-assets skill), then call the lunacore tool luna_asset_blender {name, kind: "${k}"}: it saves art/blender/${slug}.blend, exports ${root}/${KINDS[k].dir}/${slug}.fbx for Unity and makes the prefab. A Higgsfield concept, texture or GLB for this asset never goes straight into Unity: generate it with luna_asset_higgsfield {..., forBlender: true} (saved, recorded and ledgered, no Unity import; a GLB of a 3D kind skips the import anyway; for a mesh use the model multi_image_to_3d with images: 1-4 repo reference views under art/ and params {"should_texture": "true"}), then pass the saved file to luna_asset_blender {name, kind: "${k}", from: "<the saved Higgsfield file>"} (an image becomes the base color texture of the Blender object named like the asset, a GLB is imported), so it gets the toon pass, decimation and the FBX + prefab export.`
    : `Drafts: the lunacore tool luna_asset_comfy {name, kind: "${k}", prompt, workflow} runs a workflow from ${COMFY_WORKFLOW_DIR}/ (API format, "{{prompt}}" placeholder) on the local ComfyUI and saves the workflow and seed under ${SOURCE_DIRS.comfyRuns}/. Finals: luna_asset_higgsfield {name, kind: "${k}", prompt, model} (load the higgsfield-media skill).`;
  return [
    `Files: the asset goes to ${root}/${KINDS[k].dir}/, its sources (Blender .blend, ComfyUI workflow + seed, Higgsfield record) to art/. Write only inside this repository.`,
    make,
    ...(Array.isArray(casting) ? casting.filter((p) => typeof p === 'string' && p) : []),
    'Paid generation goes ONLY through luna_asset_higgsfield: it books the cost against this run\'s Higgsfield budget first. Use the higgsfield CLI / higgsfield-bridge directly only to look up models. When a tool answers capReached, stop using Higgsfield for this run.',
    'The luna_asset_* tools import the result into Unity through the Unity Pipeline (asset import, prefab for a model, material for a texture), except a luna_asset_higgsfield result bound for luna_asset_blender (forBlender). When a result says the import failed, import it with your Unity MCP.',
    LIBRARY_RULE,
    NO_RIPS_RULE,
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
  COMFY_KINDS,
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
  LIBRARY_RULE,
  NO_RIPS_RULE,
  cleanAssetEntry,
  createAssetPipeline,
  assetReportLines,
  assetSpendUsd,
};
