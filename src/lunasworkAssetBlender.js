// ============================================================================
// LunaCore - Luna's Work asset pipeline: the Blender step (luna_asset_blender)
// ----------------------------------------------------------------------------
// blenderModel saves the open Blender scene to art/blender/<slug>.blend, runs
// the optional toon style pass, renders the 4-panel turntable sheet the
// Critic's style check reads (design/asset-renders/<slug>.png) and exports the
// model to Unity as FBX + prefab. With `from`, a saved Higgsfield result
// (an image as the texture, or a GLB imported) goes through the same passes
// first (src/lunasworkBlenderFrom.js). A Higgsfield record that this run's
// asset log does not back (deps.higgsfieldMade) is named as "claimed" in the
// answer, never as proven provenance: the FBX's ledger row then carries the
// from file's own row (license, author, source), and without one the call is
// refused, never ledgered as "Own work (generated)". The Python comes from
// src/lunasworkBlenderScript.js; the guarded repo files, Unity import, ledger
// and asset log come from src/lunasworkAssetPipeline.js (createAssetPipeline),
// so every path stays inside the project repo.
//
// Write paths (a junction made while Blender renders must not redirect a
// write): Blender never writes a final path. The FBX, the turntable sheet and
// its panels go to a fresh private folder in the OS temp dir (outside the
// repo, so nothing in the repo can redirect it); the .blend goes to a random
// <slug>.<hex>.tmp.blend next to its final path, so Blender remaps the
// scene's relative texture paths for the real folder (the save is the
// script's first step, before the long passes and the render). Node then
// guards every final path again right before it moves the file in: the
// .blend by a same-folder rename, the rest by a copy to a fresh guarded tmp
// file ('excl') + rename - the same pattern as writeRepoFile.
// Left open, as in writeRepoFile: the gap between a guard and the fs call
// right after it (Node has no openat), and the gap between the guards made
// before the run and Blender's first step (the .blend save). A .blend saved
// outside in that gap has a random name, so it never replaces a file; it is
// removed by that name afterwards.
//
// Repeated toon pass (the pass changes the open scene in place): the pass
// marks the scene (custom property TOON_MARK), and the guarded save in the
// script never saves a marked scene over a .blend that is already there. A
// second call on the same open scene so keeps the untouched .blend of the
// first call ('kept'); a marked scene is saved only when no .blend exists yet
// ('toon'), and even then it never replaces one that appeared during the run.
// The worker is told in each case. There is no override on purpose: edits
// made to a marked scene reach the FBX, never the .blend (reopen the .blend).
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const blenderScript = require('./lunasworkBlenderScript');
const { cleanFrom, resolveFrom, fromLedgerOrigin } = require('./lunasworkBlenderFrom');

// The Critic's style check reads the turntable sheet from here (lunasworkAssets renderOf).
const RENDER_DIR = 'design/asset-renders';
const MAX_DETAIL_CHARS = 300;
const MAX_NOTE_CHARS = 160;
const STAGE_PREFIX = 'lunacore-blender-';
const STATE_FILE = 'blend-state.txt';
const MAX_STATE_BYTES = 16;
const HEAD_BYTES = 64;
const STAGE_RM_RETRIES = 5;

// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail: oneLine(detail, MAX_DETAIL_CHARS) } : {}) });
const randomHex = () => crypto.randomBytes(6).toString('hex');
const missingText = (rel, hadEarlier) => (hadEarlier ? `${rel} is the earlier file, not a new export` : `${rel} was not written`);

/** The lstat of a staged file, or null when nothing is there. */
function lstatOrNull(abs) {
  try {
    return fs.lstatSync(abs);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** The first HEAD_BYTES of a staged file: enough for every magic-byte check. */
function headOf(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Throws unless Blender wrote the staged file `abs` (for `rel`) now, as a plain file of the right kind. */
function checkStaged(abs, rel, hadEarlier, isKind, what) {
  const st = lstatOrNull(abs);
  if (!st) throw new Error(missingText(rel, hadEarlier));
  if (!st.isFile()) throw new Error(`${rel} was not written as a plain file`);
  if (!isKind(headOf(abs))) throw new Error(`${rel} is not ${what}`);
}

/** What the guarded save did ('clean' | 'toon' | 'kept'), or null when the script left no valid state file. */
function readBlendState(abs) {
  const st = lstatOrNull(abs);
  if (!st || !st.isFile() || st.size > MAX_STATE_BYTES) return null;
  const state = fs.readFileSync(abs, 'utf8').trim();
  return blenderScript.BLEND_STATES.includes(state) ? state : null;
}

/** The note a guarded save gives the worker, or null for a plain save. */
function blendStateNote(state, blendRel) {
  if (state === 'kept') {
    return `The open scene already carries the toon pass, so ${blendRel} was kept as the untouched source (not overwritten); reopen it to edit the model.`;
  }
  if (state === 'toon') return `${blendRel} was saved from a scene that already carries the toon pass (no untouched source was there to keep).`;
  return null;
}

/**
 * @param {{blender?:{executeCode:(code:string)=>Promise<unknown>},
 *   cleanJob:(raw:object)=>object, paths:(job:object)=>{blend:string, fbx:string},
 *   isBlend:(buf:Buffer)=>boolean, isFbx:(buf:Buffer)=>boolean, abs:(rel:string)=>string,
 *   files:{guard:(rel:string)=>string, mkdirFor:(rel:string)=>void, stat:(rel:string)=>object|null,
 *     head:(rel:string)=>Buffer, remove:(rel:string)=>void, read:(rel:string, max:number)=>Buffer},
 *   ledgerGenerated:Function, importToUnity:Function, importNote:Function, log:Function, ledgerFile:string,
 *   repoPath:string, artRoot:string, higgsfieldDir:string, kinds:object,
 *   higgsfieldMade?:(claim:{path:string, record:string})=>boolean}} deps  files.read(rel, max) reads a
 *   guarded repo file (the Higgsfield record of a `from`, the ledger row of an unproven one); higgsfieldMade = whether this run's asset log
 *   has the luna_asset_higgsfield entry that saved the file from the record (missing or throwing: not proven)
 * @returns {(raw:object)=>Promise<object>} blenderModel
 */
function createBlenderModel(deps) {
  const { files } = deps;
  const isFileStat = (st) => !!st && st.isFile();

  /**
   * Copies a staged file into the repo at `rel`: the final path is guarded
   * right before the copy, the copy goes to a fresh random tmp file ('excl':
   * never an existing file or a planted link), and both are guarded again
   * right before the rename (a junction made during the copy).
   */
  function placeCopy(srcAbs, rel) {
    const st = lstatOrNull(srcAbs);
    if (!st || !st.isFile()) throw new Error(`${rel} is not a staged file`);
    files.guard(rel);
    const tmpRel = `${rel}.${randomHex()}.tmp`;
    const tmpAbs = files.guard(tmpRel);
    fs.copyFileSync(srcAbs, tmpAbs, fs.constants.COPYFILE_EXCL);
    try {
      files.guard(tmpRel);
      fs.renameSync(tmpAbs, files.guard(rel));
    } catch (err) {
      // Our own random-named copy: removed wherever it landed.
      try {
        fs.unlinkSync(tmpAbs);
      } catch (cleanupErr) {
        if (cleanupErr && cleanupErr.code !== 'ENOENT') err.message += ` (and ${tmpRel} could not be removed: ${errText(cleanupErr)})`;
      }
      throw err;
    }
  }

  /** Renames the staged .blend (same folder) onto `rel`, both guarded right before the rename. */
  function placeBlend(stagedRel, rel) {
    const from = files.guard(stagedRel);
    const st = lstatOrNull(from);
    if (!st || !st.isFile()) throw new Error(`${stagedRel} is not a staged file`);
    fs.renameSync(from, files.guard(rel));
  }

  /** Guards and prepares every final path, then makes the staging places. */
  function prepareStage(job, rels) {
    for (const rel of [rels.blend, rels.fbx, rels.render]) {
      files.guard(rel);
      files.mkdirFor(rel);
    }
    // stat guards again after mkdir (a junction made meanwhile).
    const earlier = { blend: isFileStat(files.stat(rels.blend)), fbx: isFileStat(files.stat(rels.fbx)), render: isFileStat(files.stat(rels.render)) };
    const blendRel = `${rels.blend.replace(/\.blend$/, '')}.${randomHex()}.tmp.blend`;
    if (files.stat(blendRel)) throw new Error(`${blendRel} is already there`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), STAGE_PREFIX));
    return {
      dir,
      blendRel,
      earlier,
      fbx: path.join(dir, `${job.slug}.fbx`),
      sheet: path.join(dir, `${job.slug}.png`),
      panels: blenderScript.TURNTABLE_VIEWS.map((view) => path.join(dir, `${job.slug}.${view}.png`)),
      state: path.join(dir, STATE_FILE),
    };
  }

  /** Removes the staging places; what could not be removed is a note. */
  async function cleanupStage(stage) {
    const notes = [];
    try {
      files.remove(stage.blendRel);
    } catch (err) {
      // Refused (its folder now leads outside the repo): our own random-named
      // file is removed by that name wherever it landed, never anything else.
      try {
        fs.unlinkSync(deps.abs(stage.blendRel));
      } catch (unlinkErr) {
        if (!unlinkErr || unlinkErr.code !== 'ENOENT') notes.push(`${stage.blendRel} could not be removed (${oneLine(errText(unlinkErr), MAX_NOTE_CHARS)}).`);
      }
    }
    try {
      await fs.promises.rm(stage.dir, { recursive: true, force: true, maxRetries: STAGE_RM_RETRIES });
    } catch (err) {
      notes.push(`The Blender staging folder ${stage.dir} could not be removed (${oneLine(errText(err), MAX_NOTE_CHARS)}).`);
    }
    return notes;
  }

  /** The turntable sheet Blender rendered now, PNG-checked and moved in: {renders, notes}. Never a failed export. */
  function placeRender(stage, rel) {
    try {
      checkStaged(stage.sheet, rel, stage.earlier.render, blenderScript.isPng, 'a PNG image');
      placeCopy(stage.sheet, rel);
      return { renders: [rel], notes: [] };
    } catch (err) {
      return { renders: [], notes: [`No turntable render for the style check (${oneLine(errText(err), MAX_NOTE_CHARS)}): save one to ${rel}.`] };
    }
  }

  /** Throws unless the staged .blend (or the kept one) and the staged FBX are new and of the right kind. */
  function checkOutputs(stage, rels, blendState) {
    if (blendState === 'kept') {
      if (!isFileStat(files.stat(rels.blend))) throw new Error(`${rels.blend} was to be kept but is gone`);
    } else {
      const st = files.stat(stage.blendRel);
      if (!st) throw new Error(missingText(rels.blend, stage.earlier.blend));
      if (!st.isFile() || !deps.isBlend(files.head(stage.blendRel))) throw new Error(`${rels.blend} is not a .blend file`);
    }
    checkStaged(stage.fbx, rels.fbx, stage.earlier.fbx, deps.isFbx, 'an FBX file');
  }

  /** Ledger, Unity import, asset log and the answer, once the files are in place. */
  async function finish(job, style, rels, ran) {
    const { from, provenance } = ran.src;
    const report = blenderScript.parseScriptReport(ran.output);
    // The Higgsfield record (else the file itself) is the source a `from` asset was made from.
    const higgsfield = from ? [...new Set([from.record, from.rel].filter(Boolean))] : [];
    const ledgerNote = from
      ? await deps.ledgerGenerated('Higgsfield + Blender', job, [rels.fbx], provenance.source, provenance.origin)
      : await deps.ledgerGenerated('Blender', job, [rels.fbx], rels.blend);
    const imp = await deps.importToUnity(rels.fbx, job.kind);
    // cleanAssetEntry keeps 4 sources: .blend, the Higgsfield record and file, the render.
    deps.log({ tool: 'blender', kind: job.kind, name: job.name, prompt: job.prompt, seed: null, costUsd: 0, path: rels.fbx, sources: [rels.blend, ...higgsfield, ...ran.render.renders], imported: imp.ok });
    const notes = [deps.importNote(imp), ledgerNote, provenance && provenance.note, blendStateNote(ran.blendState, rels.blend), ...blenderScript.reportNotes(report), ...ran.render.notes];
    const toon = style.stylePass === blenderScript.TOON_PASS;
    return {
      ok: true,
      files: [rels.fbx],
      sources: [rels.blend, ...higgsfield],
      ...(from ? { from: { path: from.rel, type: from.type, record: from.record, recordProven: provenance.proven } } : {}),
      blend: ran.blendState === 'kept' ? 'kept' : 'saved',
      renders: ran.render.renders,
      style: { pass: style.stylePass, polyBudget: toon ? blenderScript.polyBudgetFor(job.kind, style.polyBudget) : null, report },
      prefab: imp.ok ? rels.fbx.replace(/\.fbx$/, '.prefab') : null,
      unity: imp,
      ledger: ledgerNote ? null : deps.ledgerFile,
      note: notes.filter(Boolean).join(' ') || null,
    };
  }

  /** Runs the script on the staging paths and moves the checked outputs in. */
  async function exportStaged(job, style, rels, stage, src) {
    const { from } = src;
    const script = blenderScript.blenderExportScript(deps.abs(stage.blendRel), stage.fbx, {
      kind: job.kind,
      stylePass: style.stylePass,
      polyBudget: style.polyBudget,
      render: { sheet: stage.sheet, panels: stage.panels },
      from: from ? { type: from.type, path: from.abs, target: job.name } : null,
      blend: { exists: stage.earlier.blend, statePath: stage.state },
    });
    let output;
    try {
      output = await deps.blender.executeCode(script);
    } catch (err) {
      return fail('blenderFailed', errText(err));
    }
    let blendState;
    try {
      // A staged folder that now leads outside the repo is a refused write, not a Blender failure.
      files.guard(stage.blendRel);
      blendState = readBlendState(stage.state);
    } catch (err) {
      return fail('writeFailed', `The Blender export was not moved into place: ${errText(err)}`);
    }
    // A marked scene never replaces a .blend that appeared while Blender ran.
    if (blendState === 'toon' && isFileStat(files.stat(rels.blend))) blendState = 'kept';
    try {
      checkOutputs(stage, rels, blendState);
    } catch (err) {
      return fail('blenderFailed', `Blender did not write the files: ${errText(err)}`);
    }
    return placeOutputs(job, style, rels, stage, { output, blendState, src });
  }

  /** Moves the checked .blend, then the FBX, into place; the answer says which one landed when the other did not. */
  async function placeOutputs(job, style, rels, stage, ran) {
    let blendPlaced = false;
    try {
      // The .blend first: a same-folder rename that a locked file can refuse, before the FBX reaches Unity.
      if (ran.blendState !== 'kept') {
        placeBlend(stage.blendRel, rels.blend);
        blendPlaced = true;
      }
      placeCopy(stage.fbx, rels.fbx);
    } catch (err) {
      const landed = blendPlaced ? ` (${rels.blend} was already updated)` : '';
      return fail('writeFailed', `The Blender export was not moved into place: ${errText(err)}${landed}`);
    }
    return finish(job, style, rels, { ...ran, render: placeRender(stage, rels.render) });
  }

  /** Adds the staging cleanup notes to an answer: the note of a success, the detail of a failure. */
  function withNotes(result, notes) {
    if (!notes.length) return result;
    if (result.ok) return { ...result, note: [result.note, ...notes].filter(Boolean).join(' ') };
    return { ...result, detail: oneLine([result.detail, ...notes].filter(Boolean).join(' '), MAX_DETAIL_CHARS) };
  }

  /** True only when this run's asset log backs the record a `from` names (deps.higgsfieldMade). */
  function provenRecord(from) {
    if (!from || !from.record || typeof deps.higgsfieldMade !== 'function') return false;
    try {
      return deps.higgsfieldMade({ path: from.rel, record: from.record, sha256: from.sha256 }) === true;
    } catch {
      // An unreadable run log proves nothing: the record stays "claimed".
      return false;
    }
  }

  /**
   * The ledger row and the answer note of a `from`. A record this run's asset
   * log proves: a generated row naming it. Otherwise (a claimed record, or
   * none) the from file's own ledger row is carried over (fromLedgerOrigin),
   * and without one the call is refused before Blender runs.
   */
  function fromProvenance(from) {
    if (from.record && provenRecord(from)) return { ok: true, source: from.record, origin: null, note: null, proven: true };
    const own = fromLedgerOrigin(from.rel, files);
    if (!own.ok) return own;
    const carried = `the FBX's ledger row carries ${from.rel}'s own row (license ${own.origin.license}).`;
    const note = from.record
      ? `${from.record} is a claimed Higgsfield record: this run's asset log has no luna_asset_higgsfield result that saved ${from.rel} from it, so ${carried} Check its origin before shipping.`
      : `No Higgsfield record lists ${from.rel}: ${carried}`;
    return { ok: true, source: own.origin.source, origin: own.origin, note, proven: false };
  }

  /** The checked `from` (null when the call names none) and the style options; a Higgsfield result defaults to the toon pass. */
  function cleanInputs(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const named = cleanFrom(r.from, { artRoot: deps.artRoot, higgsfieldDir: deps.higgsfieldDir });
    if (!named.ok) return named;
    const toonByDefault = named.from && (r.stylePass === undefined || r.stylePass === null);
    const style = blenderScript.cleanStyleOptions(toonByDefault ? { ...r, stylePass: blenderScript.TOON_PASS } : r);
    if (!style.ok) return fail(style.error, style.detail);
    if (!named.from) return { ok: true, style, from: null, provenance: null };
    const from = resolveFrom(named.from, { repoPath: deps.repoPath, artRoot: deps.artRoot, higgsfieldDir: deps.higgsfieldDir, kinds: deps.kinds, files });
    if (!from.ok) return from;
    const provenance = fromProvenance(from);
    return provenance.ok ? { ok: true, style, from, provenance } : provenance;
  }

  /**
   * Saves the open Blender scene, runs the style pass (stylePass
   * "blade-bullet-toon": poly budget, outline, zeroed root, character height),
   * renders the turntable sheet for the Critic and exports it to Unity as FBX
   * + prefab. A model of the same name is exported again in place (the editor
   * keeps its GUID), unlike a paid Higgsfield final. With `from` (a saved
   * Higgsfield texture or GLB) the result enters the scene first, the toon
   * pass is the default, and the log and the ledger name its record. A scene
   * the toon pass already changed never overwrites an existing .blend (see
   * the header).
   */
  async function blenderModel(raw) {
    const job = deps.cleanJob(raw);
    if (!job.ok) return job;
    const inputs = cleanInputs(raw);
    if (!inputs.ok) return inputs;
    const { style, from, provenance } = inputs;
    if (!deps.blender || typeof deps.blender.executeCode !== 'function') return fail('toolDown', 'blender not connected');
    const { blend, fbx } = deps.paths(job);
    const rels = { blend, fbx, render: `${RENDER_DIR}/${job.slug}.png` };
    let stage;
    try {
      stage = prepareStage(job, rels);
    } catch (err) {
      return fail('writeFailed', errText(err));
    }
    let result;
    let thrown = null;
    try {
      result = await exportStaged(job, style, rels, stage, { from, provenance });
    } catch (err) {
      thrown = err;
    }
    // Also after a throw (a failed ledger or Unity call): no staging file is left behind.
    const notes = await cleanupStage(stage);
    if (thrown) {
      if (notes.length && thrown instanceof Error) thrown.message += ` (${notes.join(' ')})`;
      throw thrown;
    }
    return withNotes(result, notes);
  }

  return blenderModel;
}

module.exports = { RENDER_DIR, createBlenderModel };
