// ============================================================================
// LunaCore - Luna's Work asset pipeline: the Blender step (luna_asset_blender)
// ----------------------------------------------------------------------------
// blenderModel saves the open Blender scene to art/blender/<slug>.blend, runs
// the optional toon style pass, renders the 4-panel turntable sheet the
// Critic's style check reads (design/asset-renders/<slug>.png) and exports the
// model to Unity as FBX + prefab. The Python comes from
// src/lunasworkBlenderScript.js; the guarded repo files, Unity import, ledger
// and asset log come from src/lunasworkAssetPipeline.js (createAssetPipeline),
// so every path stays inside the project repo.
// ============================================================================

'use strict';

const blenderScript = require('./lunasworkBlenderScript');

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
 *     head:(rel:string)=>Buffer, remove:(rel:string)=>void},
 *   ledgerGenerated:Function, importToUnity:Function, importNote:Function, log:Function, ledgerFile:string}} deps
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
  async function runScript(job, style, rels) {
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
    });
    const output = await deps.blender.executeCode(script);
    return { before, output };
  }

  /**
   * Saves the open Blender scene, runs the style pass (stylePass
   * "blade-bullet-toon": poly budget, outline, zeroed root, character height),
   * renders the turntable sheet for the Critic and exports it to Unity as FBX
   * + prefab. A model of the same name is exported again in place (the editor
   * keeps its GUID), unlike a paid Higgsfield final.
   */
  async function blenderModel(raw) {
    const job = deps.cleanJob(raw);
    if (!job.ok) return job;
    const style = blenderScript.cleanStyleOptions(raw);
    if (!style.ok) return fail(style.error, style.detail);
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
      ran = await runScript(job, style, rels);
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
    const ledgerNote = await deps.ledgerGenerated('Blender', job, [fbxRel], blendRel);
    const imp = await deps.importToUnity(fbxRel, job.kind);
    deps.log({ tool: 'blender', kind: job.kind, name: job.name, prompt: job.prompt, seed: null, costUsd: 0, path: fbxRel, sources: [blendRel, ...render.renders], imported: imp.ok });
    const note = [deps.importNote(imp), ledgerNote, ...blenderScript.reportNotes(report), ...render.notes].filter(Boolean).join(' ') || null;
    const toon = style.stylePass === blenderScript.TOON_PASS;
    return {
      ok: true,
      files: [fbxRel],
      sources: [blendRel],
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
