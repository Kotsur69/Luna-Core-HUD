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
// answer and the ledger source, never as proven provenance. The Python comes from
// src/lunasworkBlenderScript.js; the guarded repo files, Unity import, ledger
// and asset log come from src/lunasworkAssetPipeline.js (createAssetPipeline),
// so every path stays inside the project repo.
// ============================================================================

'use strict';

const blenderScript = require('./lunasworkBlenderScript');
const { cleanFrom, resolveFrom } = require('./lunasworkBlenderFrom');

// The Critic's style check reads the turntable sheet from here (lunasworkAssets renderOf).
const RENDER_DIR = 'design/asset-renders';
const MAX_DETAIL_CHARS = 300;
const MAX_NOTE_CHARS = 160;

// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail: oneLine(detail, MAX_DETAIL_CHARS) } : {}) });

/**
 * @param {{blender?:{executeCode:(code:string)=>Promise<unknown>},
 *   cleanJob:(raw:object)=>object, paths:(job:object)=>{blend:string, fbx:string},
 *   isBlend:(buf:Buffer)=>boolean, isFbx:(buf:Buffer)=>boolean, abs:(rel:string)=>string,
 *   files:{guard:(rel:string)=>string, mkdirFor:(rel:string)=>void, stat:(rel:string)=>object|null,
 *     head:(rel:string)=>Buffer, remove:(rel:string)=>void, read:(rel:string, max:number)=>Buffer},
 *   ledgerGenerated:Function, importToUnity:Function, importNote:Function, log:Function, ledgerFile:string,
 *   repoPath:string, artRoot:string, higgsfieldDir:string, kinds:object,
 *   higgsfieldMade?:(claim:{path:string, record:string})=>boolean}} deps  files.read(rel, max) reads a
 *   guarded repo file (the Higgsfield record of a `from`); higgsfieldMade = whether this run's asset log
 *   has the luna_asset_higgsfield entry that saved the file from the record (missing or throwing: not proven)
 * @returns {(raw:object)=>Promise<object>} blenderModel
 */
function createBlenderModel(deps) {
  const { files } = deps;

  /** Throws unless Blender wrote `rel` now (new, or changed since `before`) with the right header. */
  function checkExport(rel, before, isKind, what) {
    const after = files.stat(rel);
    if (!after || !after.isFile()) throw new Error(`${rel} was not written`);
    if (before && after.mtimeMs === before.mtimeMs && after.size === before.size) throw new Error(`${rel} is the earlier file, not a new export`);
    if (!isKind(files.head(rel))) throw new Error(`${rel} is not ${what}`);
  }

  /**
   * The turntable sheet Blender rendered now, PNG-checked: {renders, notes}.
   * A missing or invalid render is a note, never a failed export. A panel
   * file the script left behind is removed here.
   */
  function checkRender(rel, before, panelRels) {
    const notes = [];
    for (const panel of panelRels) {
      try {
        files.remove(panel);
      } catch (err) {
        notes.push(`${panel} could not be removed (${oneLine(errText(err), MAX_NOTE_CHARS)}).`);
      }
    }
    try {
      checkExport(rel, before, blenderScript.isPng, 'a PNG image');
      return { renders: [rel], notes };
    } catch (err) {
      return { renders: [], notes: [`No turntable render for the style check (${oneLine(errText(err), MAX_NOTE_CHARS)}): save one to ${rel}.`, ...notes] };
    }
  }

  /** Guards and prepares every target, then runs the script. Returns the add-on's answer. */
  async function runScript(job, style, rels, from) {
    for (const rel of [rels.blend, rels.fbx, rels.render, ...rels.panels]) {
      files.guard(rel);
      files.mkdirFor(rel);
    }
    // stat guards again after mkdir (a junction made meanwhile).
    const before = [files.stat(rels.blend), files.stat(rels.fbx), files.stat(rels.render)];
    for (const rel of rels.panels) files.guard(rel);
    const script = blenderScript.blenderExportScript(deps.abs(rels.blend), deps.abs(rels.fbx), {
      kind: job.kind,
      stylePass: style.stylePass,
      polyBudget: style.polyBudget,
      render: { sheet: deps.abs(rels.render), panels: rels.panels.map(deps.abs) },
      from: from ? { type: from.type, path: from.abs, target: job.name } : null,
    });
    const output = await deps.blender.executeCode(script);
    return { before, output };
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

  /** The ledger source and the answer note of a `from`: the proven record, a claimed one, or the file itself. */
  function fromProvenance(from) {
    if (!from) return { source: null, note: null, proven: false };
    if (!from.record) return { source: from.rel, note: `No Higgsfield record lists ${from.rel}: the ledger names the file itself as the source.`, proven: false };
    if (provenRecord(from)) return { source: from.record, note: null, proven: true };
    return {
      source: `claimed Higgsfield record ${from.record}`,
      note: `${from.record} is a claimed Higgsfield record: this run's asset log has no luna_asset_higgsfield result that saved ${from.rel} from it, so the ledger source says "claimed Higgsfield record". Check its origin before shipping.`,
      proven: false,
    };
  }

  /** The checked `from` (null when the call names none) and the style options; a Higgsfield result defaults to the toon pass. */
  function cleanInputs(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const named = cleanFrom(r.from, { artRoot: deps.artRoot, higgsfieldDir: deps.higgsfieldDir });
    if (!named.ok) return named;
    const toonByDefault = named.from && (r.stylePass === undefined || r.stylePass === null);
    const style = blenderScript.cleanStyleOptions(toonByDefault ? { ...r, stylePass: blenderScript.TOON_PASS } : r);
    if (!style.ok) return fail(style.error, style.detail);
    if (!named.from) return { ok: true, style, from: null };
    const from = resolveFrom(named.from, { repoPath: deps.repoPath, artRoot: deps.artRoot, higgsfieldDir: deps.higgsfieldDir, kinds: deps.kinds, files });
    return from.ok ? { ok: true, style, from } : from;
  }

  /**
   * Saves the open Blender scene, runs the style pass (stylePass
   * "blade-bullet-toon": poly budget, outline, zeroed root, character height),
   * renders the turntable sheet for the Critic and exports it to Unity as FBX
   * + prefab. A model of the same name is exported again in place (the editor
   * keeps its GUID), unlike a paid Higgsfield final. With `from` (a saved
   * Higgsfield texture or GLB) the result enters the scene first, the toon
   * pass is the default, and the log and the ledger name its record.
   */
  async function blenderModel(raw) {
    const job = deps.cleanJob(raw);
    if (!job.ok) return job;
    const inputs = cleanInputs(raw);
    if (!inputs.ok) return inputs;
    const { style, from } = inputs;
    if (!deps.blender || typeof deps.blender.executeCode !== 'function') return fail('toolDown', 'blender not connected');
    const { blend: blendRel, fbx: fbxRel } = deps.paths(job);
    const rels = {
      blend: blendRel,
      fbx: fbxRel,
      render: `${RENDER_DIR}/${job.slug}.png`,
      panels: blenderScript.TURNTABLE_VIEWS.map((view) => `${RENDER_DIR}/${job.slug}.${view}.tmp.png`),
    };
    let ran;
    try {
      ran = await runScript(job, style, rels, from);
    } catch (err) {
      return fail('blenderFailed', errText(err));
    }
    try {
      checkExport(blendRel, ran.before[0], deps.isBlend, 'a .blend file');
      checkExport(fbxRel, ran.before[1], deps.isFbx, 'an FBX file');
    } catch (err) {
      return fail('blenderFailed', `Blender did not write the files: ${errText(err)}`);
    }
    const render = checkRender(rels.render, ran.before[2], rels.panels);
    const report = blenderScript.parseScriptReport(ran.output);
    // The Higgsfield record (else the file itself) is the source a `from` asset was made from.
    const higgsfield = from ? [...new Set([from.record, from.rel].filter(Boolean))] : [];
    const provenance = fromProvenance(from);
    const ledgerNote = from
      ? await deps.ledgerGenerated('Higgsfield + Blender', job, [fbxRel], provenance.source)
      : await deps.ledgerGenerated('Blender', job, [fbxRel], blendRel);
    const imp = await deps.importToUnity(fbxRel, job.kind);
    // cleanAssetEntry keeps 4 sources: .blend, the Higgsfield record and file, the render.
    deps.log({ tool: 'blender', kind: job.kind, name: job.name, prompt: job.prompt, seed: null, costUsd: 0, path: fbxRel, sources: [blendRel, ...higgsfield, ...render.renders], imported: imp.ok });
    const note = [deps.importNote(imp), ledgerNote, provenance.note, ...blenderScript.reportNotes(report), ...render.notes].filter(Boolean).join(' ') || null;
    const toon = style.stylePass === blenderScript.TOON_PASS;
    return {
      ok: true,
      files: [fbxRel],
      sources: [blendRel, ...higgsfield],
      ...(from ? { from: { path: from.rel, type: from.type, record: from.record, recordProven: provenance.proven } } : {}),
      renders: render.renders,
      style: { pass: style.stylePass, polyBudget: toon ? blenderScript.polyBudgetFor(job.kind, style.polyBudget) : null, report },
      prefab: imp.ok ? fbxRel.replace(/\.fbx$/, '.prefab') : null,
      unity: imp,
      ledger: ledgerNote ? null : deps.ledgerFile,
      note,
    };
  }

  return blenderModel;
}

module.exports = { RENDER_DIR, createBlenderModel };
