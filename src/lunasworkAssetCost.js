// ============================================================================
// LunaCore - Luna's Work Asset Manifest Estimate (dry run, before any spend)
// ----------------------------------------------------------------------------
// Before an iteration files asset cards from design/ASSETS.md, the asset step
// (src/lunasworkAssets.js) classifies the rows it is about to card:
//
//   library   free library imports (luna_asset_search / luna_asset_import)
//   local     free local generations: Blender (source `blender`, or any 3D
//             `model` row - unityAssetBrief sends those to Blender) and
//             ComfyUI (generated audio / animation / material: Higgsfield
//             makes images and GLBs only)
//   paid      Higgsfield finals: every other `generated` row, with credits
//             per model and USD at the per-PC credit rate
//
// A row's model comes from `model: <id>` in its spec (or entry.model). A row
// without one uses DEFAULT_FINAL_CREDITS; a NAMED model this table does not
// know uses the same default and is flagged (`unknownModel`), so the number
// is never silently low. The credit numbers are planning estimates on the
// high side, like DEFAULT_USD_PER_CREDIT: the real cost is booked by
// luna_asset_higgsfield (`generate cost`) against the run's spend cap.
//
// Pure: no IO. cleanAssetEstimate is the trust boundary for a stored run
// (src/lunasworkRun.js) and for the dashboard view.
// ============================================================================

'use strict';

const { DEFAULT_USD_PER_CREDIT } = require('./lunasworkAssetPipeline');
const { normalizeSpendCaps, normalizeSpend } = require('./lunasworkToolkit');

// Higgsfield credits per final, by model id: planning estimates on the high side.
const HIGGSFIELD_MODEL_CREDITS = Object.freeze({
  soul: 3,
  'nano-banana': 3,
  seedream: 4,
  'flux-kontext': 5,
  'image-to-3d': 30,
});
// A final whose model is not named or not known.
const DEFAULT_FINAL_CREDITS = 10;
// The spend gate's answers (distinct from the batch gate's capped / all).
const SPEND_APPROVE = 'approve';
const SPEND_SKIP = 'skip';
const MAX_USD_PER_CREDIT = 10;
const MAX_CREDITS_PER_FINAL = 10000;
const MAX_ROWS = 1000;
const MAX_NAME_CHARS = 80;
const MAX_UNKNOWN = 20;
const MAX_LIST_IN_TEXT = 6;
// Types Higgsfield cannot make: a `generated` row of these runs on local ComfyUI / Blender.
const LOCAL_GENERATED_TYPES = Object.freeze(['model', 'audio', 'animation', 'material']);
const MODEL_IN_SPEC_RE = /\bmodel\s*[:=]\s*([a-z0-9][a-z0-9_.-]{0,63})/i;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_ROWS) : 0);
const money = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v * 10000) / 10000 : 0);
// eslint-disable-next-line no-control-regex
const oneLine = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const usdRate = (v) => (typeof v === 'number' && v > 0 && v <= MAX_USD_PER_CREDIT ? v : DEFAULT_USD_PER_CREDIT);

/** 'library' | 'local' | 'paid' for one ASSETS.md row. */
function costClass(row) {
  if (row.source === 'library') return 'library';
  if (row.source === 'blender') return 'local';
  return LOCAL_GENERATED_TYPES.includes(row.type) ? 'local' : 'paid';
}

/** The model a row names (entry.model, else `model: <id>` in its spec), lower-case, or null. */
function modelOf(row) {
  const direct = typeof row.model === 'string' ? row.model.trim().toLowerCase() : '';
  if (MODEL_ID_RE.test(direct)) return direct;
  const m = typeof row.spec === 'string' ? row.spec.match(MODEL_IN_SPEC_RE) : null;
  return m ? m[1].toLowerCase() : null;
}

/** The credit table: the built-in estimates, overridden by valid opts.modelCredits entries. */
function creditTable(extra) {
  const out = { ...HIGGSFIELD_MODEL_CREDITS };
  if (!isObj(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (MODEL_ID_RE.test(k) && Number.isFinite(v) && v >= 0 && v <= MAX_CREDITS_PER_FINAL) out[k] = v;
  }
  return out;
}

/**
 * The Asset Manifest Estimate of the rows about to be carded.
 * @param {{name:string, type:string, spec?:string, source:string, model?:string}[]} entries
 * @param {{usdPerCredit?:number, modelCredits?:Object<string, number>}} [opts]
 * @returns {{library:{count:number}, local:{count:number}, paid:{count:number, credits:number, usd:number,
 *   unknownModels:string[], rows:{name:string, model:string|null, credits:number, unknownModel:boolean}[]},
 *   usdPerCredit:number, total:number}}
 */
function assetManifestEstimate(entries, opts = {}) {
  const o = isObj(opts) ? opts : {};
  const usdPerCredit = usdRate(o.usdPerCredit);
  const table = creditTable(o.modelCredits);
  const rows = (Array.isArray(entries) ? entries : []).filter((r) => isObj(r) && typeof r.name === 'string').slice(0, MAX_ROWS);
  const counts = { library: 0, local: 0 };
  const paidRows = [];
  for (const row of rows) {
    const cls = costClass(row);
    if (cls !== 'paid') {
      counts[cls] += 1;
      continue;
    }
    const model = modelOf(row);
    const known = model !== null && Object.prototype.hasOwnProperty.call(table, model);
    paidRows.push({
      name: oneLine(row.name, MAX_NAME_CHARS),
      model,
      credits: known ? table[model] : DEFAULT_FINAL_CREDITS,
      unknownModel: model !== null && !known,
    });
  }
  const credits = paidRows.reduce((s, r) => s + r.credits, 0);
  return {
    library: { count: counts.library },
    local: { count: counts.local },
    paid: {
      count: paidRows.length,
      credits,
      usd: money(credits * usdPerCredit),
      unknownModels: [...new Set(paidRows.filter((r) => r.unknownModel).map((r) => r.model))].slice(0, MAX_UNKNOWN),
      rows: paidRows,
    },
    usdPerCredit,
    total: rows.length,
  };
}

/**
 * What a stored run / the dashboard keeps of an estimate (no per-row list),
 * or null. Untrusted input: every field re-checked.
 * @returns {{at:number|null, iteration:number, library:number, local:number, paid:number, credits:number,
 *   usd:number, usdPerCredit:number, unknownModels:string[], thresholdUsd:number|null, gated:boolean,
 *   decisionId:number|null}|null}
 */
function cleanAssetEstimate(raw) {
  if (!isObj(raw)) return null;
  const unknown = (Array.isArray(raw.unknownModels) ? raw.unknownModels : []).filter((m) => typeof m === 'string' && MODEL_ID_RE.test(m));
  const decisionId = Number.isSafeInteger(raw.decisionId) && raw.decisionId > 0 ? raw.decisionId : null;
  return {
    at: Number.isFinite(raw.at) && raw.at > 0 ? raw.at : null,
    iteration: count(raw.iteration),
    library: count(raw.library),
    local: count(raw.local),
    paid: count(raw.paid),
    credits: money(raw.credits),
    usd: money(raw.usd),
    usdPerCredit: usdRate(raw.usdPerCredit),
    unknownModels: unknown.slice(0, MAX_UNKNOWN),
    thresholdUsd: Number.isFinite(raw.thresholdUsd) && raw.thresholdUsd >= 0 ? money(raw.thresholdUsd) : null,
    gated: raw.gated === true && decisionId !== null,
    decisionId,
  };
}

/** The stored summary of an estimate plus its gate outcome. */
function estimateRecord(est, { at, iteration, thresholdUsd, decisionId = null }) {
  return cleanAssetEstimate({
    at,
    iteration,
    library: est.library.count,
    local: est.local.count,
    paid: est.paid.count,
    credits: est.paid.credits,
    usd: est.paid.usd,
    usdPerCredit: est.usdPerCredit,
    unknownModels: est.paid.unknownModels,
    thresholdUsd,
    gated: decisionId !== null,
    decisionId,
  });
}

/** The spend decision: the paid finals wait for it; `skip` is the default that spends nothing. */
function spendDecision(est, thresholdUsd) {
  const names = est.paid.rows.slice(0, MAX_LIST_IN_TEXT).map((r) => r.name).join(', ');
  const more = est.paid.rows.length > MAX_LIST_IN_TEXT ? ', ...' : '';
  const unknown = est.paid.unknownModels.length ? ` Unknown model(s) at the default ${DEFAULT_FINAL_CREDITS} credits: ${est.paid.unknownModels.join(', ')}.` : '';
  return {
    kind: 'other',
    question: `Spend about $${est.paid.usd.toFixed(2)} (${est.paid.credits} Higgsfield credits) on ${est.paid.count} paid asset final(s)? That is over the run's remaining Higgsfield budget of $${thresholdUsd.toFixed(2)}.`,
    detail: `${SPEND_APPROVE} = generate them; ${SPEND_SKIP} = not in this run (default). Free imports and local generations go on. ${names}${more}.${unknown}`,
    options: [SPEND_SKIP, SPEND_APPROVE],
    defaultAnswer: SPEND_SKIP,
  };
}

/**
 * The gate's threshold: what is left of the run's Higgsfield spend cap
 * (run.spendCaps pinned at start, the lunaswork-settings spend cap; minus
 * run.spend so far), never below 0.
 */
function remainingHiggsfieldUsd(run) {
  const r = isObj(run) ? run : {};
  return money(Math.max(0, normalizeSpendCaps(r.spendCaps).higgsfield - normalizeSpend(r.spend).higgsfield));
}

/** Report lines (## Asset cost estimate) of a stored estimate; [] without one. */
function estimateLines(raw) {
  const e = cleanAssetEstimate(raw);
  if (!e) return [];
  const lines = [
    `Iteration ${e.iteration}: ${e.library} free library import(s), ${e.local} free local generation(s) (ComfyUI / Blender), ${e.paid} paid Higgsfield final(s).`,
    `Projected paid spend: ${e.credits} credits = $${e.usd.toFixed(2)} at $${e.usdPerCredit} per credit.`,
  ];
  if (e.thresholdUsd !== null) {
    lines.push(e.gated
      ? `Over the remaining Higgsfield budget of $${e.thresholdUsd.toFixed(2)}: the paid finals waited for decision ${e.decisionId}.`
      : `Within the remaining Higgsfield budget of $${e.thresholdUsd.toFixed(2)}.`);
  }
  if (e.unknownModels.length) lines.push(`Unknown model(s), priced at the default ${DEFAULT_FINAL_CREDITS} credits: ${e.unknownModels.join(', ')}.`);
  return lines;
}

module.exports = {
  HIGGSFIELD_MODEL_CREDITS,
  DEFAULT_FINAL_CREDITS,
  SPEND_APPROVE,
  SPEND_SKIP,
  costClass,
  assetManifestEstimate,
  cleanAssetEstimate,
  estimateRecord,
  spendDecision,
  remainingHiggsfieldUsd,
  estimateLines,
};
