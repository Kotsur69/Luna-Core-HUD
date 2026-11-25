// ============================================================================
// LunaCore - Luna's Work asset pipeline: the paid Higgsfield final
// (luna_asset_higgsfield), on the guarded pieces of src/lunasworkAssetPipeline.js
// ----------------------------------------------------------------------------
// Validate -> (reference images: check + upload) -> estimate -> BOOK against
// the run's spend cap (recordSpend, src/lunasworkToolGuard.js) -> generate ->
// record -> download -> save -> ledger -> Unity import -> asset log.
//
//   cost       booked before any paid call. A refused booking stops
//              Higgsfield for the rest of this pipeline (the guard files the
//              card); no further Higgsfield call is made, not even an estimate
//   record     art/higgsfield/<kind>/<stem>.json is written before the
//              download, so a paid job is never lost; a result that does not
//              end as files is still logged with its cost (unsaved). A used
//              name gets -v2, -v3...: a paid final never overwrites another
//   images     1-4 repo reference images (src/lunasworkHiggsfieldRefs.js),
//              uploaded through the CLI before the estimate, passed as a
//              repeated --image (multi_image_to_3d: object views -> GLB)
//   forBlender a result meant for luna_asset_blender `from` is saved,
//              recorded, ledgered and logged but NOT imported into Unity (no
//              prefab, no material): the Blender step makes the FBX + prefab.
//              forBlender true skips the import for every result; left out,
//              a GLB of a 3D model kind skips it too; false always imports
// ============================================================================

'use strict';

const path = require('path');
const crypto = require('crypto');
const comfyLib = require('./lunasworkComfy');
const refs = require('./lunasworkHiggsfieldRefs');

const MAX_USD_PER_CREDIT = 10;
const MAX_CREDITS = 10000;
const MAX_HIGGSFIELD_RESULTS = 4;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_DETAIL_CHARS = 300;
const MAX_NOTE_CHARS = 200;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PARAM_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
// Flags the pipeline sets itself or that would point the CLI at files, accounts or other output.
// Reference images go through `images` (checked + uploaded), never a param.
const RESERVED_PARAM_KEYS = Object.freeze(new Set(['json', 'wait', 'wait_timeout', 'output', 'out', 'file', 'path', 'dir', 'download', 'save', 'config', 'profile', 'token', 'api_key', 'help', 'version',
  'image', 'images', 'image_references', 'start_image', 'end_image', 'video', 'video_references', 'audio', 'audio_references']));
// Never a leading '-': a value must not read as a CLI flag.
const PARAM_VALUE_RE = /^[A-Za-z0-9][\w:.-]{0,39}$/;
const MAX_PARAMS = 8;
const JOB_ID_RE = /^[\w-]{1,100}$/;
// What a Higgsfield result can turn out to be; a free name must be free for each.
const RESULT_EXTS = Object.freeze(['png', 'jpg', 'webp', 'glb']);
const GLB_MAGIC = Buffer.from('glTF', 'latin1');

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
const errText = (err) => (err instanceof Error ? err.message : String(err));
const fail = (error, detail) => ({ ok: false, error, ...(detail ? { detail: oneLine(detail, MAX_DETAIL_CHARS) } : {}) });

/** The file stem of result `i` of `n`: "<stem>" alone, "<stem>-1", "<stem>-2"... in a set. */
const resultStem = (stem, i, n) => (n > 1 ? `${stem}-${i + 1}` : stem);

const recordText = (record) => `${JSON.stringify(record, null, 2)}\n`;

const sha256Of = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** A result URL as a source record keeps it: origin + path, no query (a signed URL's token stays out of git). */
function recordUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
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

/** The file extension a Higgsfield result's bytes prove: png / jpg / webp / glb, else null. */
function resultExt(buf) {
  return comfyLib.imageKind(buf) || (startsWith(buf, GLB_MAGIC) ? 'glb' : null);
}

/**
 * @param {{d:object, usdPerCredit:number, cleanJob:(raw:object)=>object, modelKinds:string[], artRoot:string, repoPath:string,
 *   recordOf:(kind:string, stem:string)=>string, fileOf:(kind:string, stem:string, ext:string)=>string,
 *   files:{write:(rel:string, data:Buffer|string)=>string, guard:(rel:string)=>string, freeStem:(base:string, relsFor:Function)=>string},
 *   ledgerGenerated:Function, importToUnity:Function, importNote:Function, log:(entry:object)=>boolean, ledgerFile:string,
 *   fsImpl?:object}} deps
 *   d = the pipeline's deps (higgsfield {estimate, generate, upload?}, download, recordSpend, cappedTools, freeCandidatePassed);
 *   fsImpl = the pipeline's fs, for the reference image checks
 * @returns {(raw:object)=>Promise<object>} higgsfieldFinal
 */
function createHiggsfieldFinal(deps) {
  const { d, files } = deps;
  if (!(deps.usdPerCredit > 0 && deps.usdPerCredit <= MAX_USD_PER_CREDIT)) throw new Error('the Higgsfield final needs a credit rate');
  // Set once a booking is refused: no more Higgsfield calls from this pipeline.
  let stopped = null;
  const cappedNow = () => (typeof d.cappedTools === 'function' ? d.cappedTools() : []);

  /** The validated job and CLI request of a Higgsfield final, or a failure. Nothing is called yet. */
  function higgsfieldRequest(raw) {
    const job = deps.cleanJob(raw);
    if (!job.ok) return job;
    if (stopped || cappedNow().includes('higgsfield')) return fail('capReached', stopped || 'the Higgsfield spend cap of this run is reached');
    const h = d.higgsfield;
    if (!h || typeof h.estimate !== 'function' || typeof h.generate !== 'function') return fail('toolDown', 'higgsfield not connected');
    // Checked before paying: a result that cannot be fetched must not be bought.
    if (typeof d.download !== 'function') return fail('toolDown', 'no downloader for Higgsfield results');
    const r = isObj(raw) ? raw : {};
    if (typeof r.model !== 'string' || !MODEL_ID_RE.test(r.model)) return fail('badModel', 'model must be a Higgsfield model id such as gpt_image_2_6');
    const params = cleanParams(r.params);
    if (!params) return fail('badParams', `params: at most ${MAX_PARAMS} plain key/value flags, each value starting with a letter or digit (reference images go in images)`);
    if (!job.prompt) return fail('badPrompt', 'a Higgsfield final needs a prompt');
    if (r.forBlender !== undefined && r.forBlender !== null && typeof r.forBlender !== 'boolean') return fail('badForBlender', 'forBlender must be true or false');
    const images = refs.cleanReferences(r.images, { artRoot: deps.artRoot });
    if (!images.ok) return images;
    const forBlender = typeof r.forBlender === 'boolean' ? r.forBlender : null;
    return { ok: true, job, forBlender, references: images.rels, request: { model: r.model, prompt: job.prompt, params } };
  }

  /** The reference images checked on disk and uploaded; their upload ids go into the request. Nothing is booked yet. */
  async function withReferences(req) {
    if (!req.references.length) return req;
    const checked = refs.resolveReferences(req.references, { repoPath: deps.repoPath, fsImpl: deps.fsImpl, files });
    if (!checked.ok) return checked;
    const up = await refs.uploadReferences(d.higgsfield.upload, checked.files);
    return up.ok ? { ...req, request: { ...req.request, images: up.ids } } : up;
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
    const costUsd = Math.round(credits * deps.usdPerCredit * 10000) / 10000;
    const booked = d.recordSpend({ tool: 'higgsfield', costUsd });
    if (!isObj(booked) || !booked.ok) {
      const reason = (isObj(booked) && booked.reason) || 'refused';
      stopped = `Higgsfield stopped for this run: the booking of $${costUsd.toFixed(2)} was refused (${reason})`;
      return fail(reason === 'capReached' ? 'capReached' : 'spendRefused', stopped);
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
        files.write(info.record, recordText({ ...info.recordData, status: 'notSaved', outputs: info.files || [], error: oneLine(detail, MAX_DETAIL_CHARS) }));
      } catch (err) {
        text += ` (the record could not be updated: ${errText(err)})`;
      }
    }
    const logged = deps.log({ tool: 'higgsfield', kind: job.kind, name: job.name, prompt: job.prompt, seed: info.seed, costUsd: paid.costUsd, credits: paid.credits, path: info.record || info.path, sources: info.record ? [info.record] : [], imported: false, unsaved: true });
    return {
      ...fail('higgsfieldFailed', text),
      costUsd: paid.costUsd, credits: paid.credits, jobId: info.jobId || null, urls: info.urls || [], record: info.record || null, files: info.files || [],
      ...(logged ? {} : { note: 'The run report could not log this cost; mention it in your hand-back.' }),
    };
  }

  /** True when a saved result goes to luna_asset_blender instead of Unity (see the header). */
  const forBlenderFile = (req, rel) => req.forBlender === true
    || (req.forBlender === null && deps.modelKinds.includes(req.job.kind) && path.posix.extname(rel) === '.glb');

  /** The note that sends the Blender-bound files on to luna_asset_blender `from`. */
  function blenderNote(job, rels) {
    const kind = deps.modelKinds.includes(job.kind) ? job.kind : '<the 3D model kind>';
    const calls = rels.map((rel) => `luna_asset_blender {name: "${job.name}", kind: "${kind}", from: "${rel}"}`).join(', ');
    return `Not imported into Unity (no prefab, no material): this result is a Blender input. Pass it on with ${calls} for the toon pass, decimation and the FBX + prefab export.`;
  }

  /**
   * Ledger -> Unity import (unless the file goes to Blender) -> asset log.
   * Each entry carries the sha256 of the bytes saved, so luna_asset_blender's
   * provenance check binds the record to the file's content, not only its path.
   */
  async function finishSaved(req, paid, gen, record, saved, hashes, notes) {
    const { job } = req;
    const ledgerNote = await deps.ledgerGenerated('Higgsfield', job, saved, record);
    if (ledgerNote) notes.push(ledgerNote);
    const blenderBound = saved.filter((rel) => forBlenderFile(req, rel));
    const imports = [];
    const imported = new Map();
    for (const rel of saved.filter((x) => !blenderBound.includes(x))) {
      const imp = await deps.importToUnity(rel, job.kind);
      imports.push(imp);
      imported.set(rel, imp.ok);
    }
    // The cost is booked once; it is logged on the first file of the generation.
    for (const [i, rel] of saved.entries()) {
      deps.log({ tool: 'higgsfield', kind: job.kind, name: job.name, prompt: job.prompt, seed: gen.seed, costUsd: i === 0 ? paid.costUsd : 0, credits: i === 0 ? paid.credits : 0, path: rel, sources: [record], imported: imported.get(rel) === true, sha256: hashes[i] });
    }
    const failed = imports.find((imp) => !imp.ok);
    if (failed) notes.push(deps.importNote(failed));
    if (blenderBound.length) notes.push(blenderNote(job, blenderBound));
    return {
      ok: true, files: saved, sources: [record], costUsd: paid.costUsd, credits: paid.credits, jobId: gen.jobId, unity: imports,
      ...(blenderBound.length ? { forBlender: blenderBound } : {}),
      ledger: ledgerNote ? null : deps.ledgerFile, note: notes.length ? notes.join(' ') : null,
    };
  }

  /**
   * Record -> fetch every result -> write -> record again -> finishSaved.
   * The record goes first, so a paid job is never lost: its id and URLs are
   * on disk before anything is downloaded.
   */
  async function saveHiggsfield(req, paid, gen) {
    const { job, request } = req;
    const n = gen.urls.length;
    const fileOf = (stem, i, ext) => deps.fileOf(job.kind, resultStem(stem, i, n), ext);
    const recordData = {
      name: job.name, kind: job.kind, model: request.model, prompt: job.prompt, params: request.params,
      ...(req.references.length ? { references: req.references } : {}), seed: gen.seed, jobId: gen.jobId,
      credits: paid.credits, costUsd: paid.costUsd, urls: gen.urls.map(recordUrl).filter(Boolean), status: 'generated', outputs: [],
    };
    const saved = [];
    const hashes = [];
    let record = null;
    try {
      const stem = files.freeStem(job.slug, (s) => [deps.recordOf(job.kind, s), ...gen.urls.flatMap((_, i) => RESULT_EXTS.map((ext) => fileOf(s, i, ext)))]);
      record = files.write(deps.recordOf(job.kind, stem), recordText(recordData));
      // Every result is fetched and checked before the first asset file is written.
      const results = [];
      for (const url of gen.urls) results.push(await fetchResult(url));
      for (const [i, r] of results.entries()) {
        saved.push(files.write(fileOf(stem, i, r.ext), r.data));
        hashes.push(sha256Of(r.data));
      }
    } catch (err) {
      const where = record ? ` and in ${record}` : '';
      const what = saved.length ? `only partially saved (${saved.length} of ${n} files)` : 'not saved';
      return paidUnsaved(job, paid, { ...gen, path: `higgsfield:${gen.jobId || request.model}`, record, recordData, files: saved }, `generated and paid, but ${what}: ${errText(err)}. The job id and result URLs are in this answer${where}.`);
    }
    const notes = [];
    try {
      files.write(record, recordText({ ...recordData, status: 'saved', outputs: saved }));
    } catch (err) {
      notes.push(`the files are saved, but ${record} could not be updated: ${oneLine(errText(err), MAX_NOTE_CHARS)}`);
    }
    return finishSaved(req, paid, gen, record, saved, hashes, notes);
  }

  /** Validate -> references -> estimate + book against the cap -> generate -> save (saveHiggsfield). */
  async function higgsfieldFinal(raw) {
    const asked = higgsfieldRequest(raw);
    if (!asked.ok) return asked;
    // A passing free / local luna_asset_judge verdict for this asset makes a paid final unnecessary.
    if (typeof d.freeCandidatePassed === 'function' && d.freeCandidatePassed(asked.job)) return fail('freeCandidatePassed', `luna_asset_judge already passed a free or local candidate for "${asked.job.name}" in this run: import that winner instead of paying for a Higgsfield final`);
    const req = await withReferences(asked);
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
    return saveHiggsfield(req, paid, gen);
  }

  return higgsfieldFinal;
}

module.exports = { MAX_USD_PER_CREDIT, resultStem, recordText, cleanParams, createHiggsfieldFinal };
