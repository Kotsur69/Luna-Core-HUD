// ============================================================================
// LunaCore - Luna's Work tool guardrails inside a run (src/lunaswork.js uses
// it; the pure rules are in src/lunasworkToolkit.js)
// ----------------------------------------------------------------------------
//   recordSpend({tool, costUsd})  books one paid generation (Higgsfield, Meshy)
//                                 against the run's cap, pinned at start
//                                 (run.spendCaps). Past the cap: refused, the
//                                 tool goes to run.spendCapped - every later
//                                 worker of the run has it denied - and ONE
//                                 card per tool is filed. The asset work calls
//                                 this BEFORE it generates
//   recordAsset(entry)            logs one made asset (tool, prompt, seed,
//                                 cost, path) in run.assets for the run report
//   cappedTools()                 run.spendCapped, for the next build
//   toolDown(result, role)        a step result that says a kit tool is down
//                                 pauses the run (the usage-limit wait path:
//                                 armWait, waitReason 'toolDown') for
//                                 TOOL_DOWN_WAIT_MS with a notification, instead
//                                 of retryLater's quick retries. true = handled.
//                                 At most MAX_TOOL_DOWN_PAUSES per run: past
//                                 that it returns false and the caller's usual
//                                 failure path (retryLater -> STOP) takes over
//
// Never throws: a failed hook or card write is a run-log line.
// ============================================================================

'use strict';

const { checkSpend, spendCapCard, toolDownOf, normalizeSpend, normalizeSpendCaps, PAID_TOOLS } = require('./lunasworkToolkit');
const { cleanAssetEntry } = require('./lunasworkAssetPipeline');

const TOOL_DOWN_WAIT_MS = 30 * 60 * 1000;
// The run report's asset log (lunasworkAssetPipeline): the newest entries win.
const MAX_ASSET_ENTRIES = 500;
const TOOL_DOWN_REASON = 'toolDown';
// 6 x 30 min: a tool still down after three hours is a setup problem, not a blip.
const MAX_TOOL_DOWN_PAUSES = 6;
const DONE_PHASE = 'done';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const errText = (err) => (err instanceof Error ? err.message : String(err));

/** What a stored run keeps of the guard: the caps pinned at start, the spend, the capped tools. */
function cleanGuardFields(raw) {
  const r = isObj(raw) ? raw : {};
  return {
    spendCaps: normalizeSpendCaps(r.spendCaps),
    spend: normalizeSpend(r.spend),
    spendCapped: [...new Set((Array.isArray(r.spendCapped) ? r.spendCapped : []).filter((t) => PAID_TOOLS.includes(t)))],
    toolDownPauses: Number.isInteger(r.toolDownPauses) && r.toolDownPauses > 0 ? Math.min(r.toolDownPauses, MAX_TOOL_DOWN_PAUSES) : 0,
    assets: (Array.isArray(r.assets) ? r.assets : []).map(cleanAssetEntry).filter(Boolean).slice(-MAX_ASSET_ENTRIES),
  };
}

/**
 * @param {{run:()=>object|null, update:(fields:object)=>void, logEvent:(text:string)=>void,
 *   armWait:(until:number, reason:string)=>void, fileCards:(cards:object[])=>number[],
 *   now:()=>number, onToolDown?:Array<(run:object, down:object)=>void>, log?:(line:string)=>void}} ctx
 */
function createToolGuard(ctx) {
  const log = ctx.log || (() => {});
  const hooks = Array.isArray(ctx.onToolDown) ? ctx.onToolDown : [];

  /**
   * @param {{tool?:unknown, costUsd?:unknown}} payload untrusted
   * @returns {{ok:boolean, reason:string|null, tool?:string, spent?:number, cap?:number|null, remaining?:number|null}}
   */
  function recordSpend(payload) {
    const run = ctx.run();
    // A finished run books nothing: its workers are gone.
    if (!run || run.phase === DONE_PHASE) return { ok: false, reason: 'noRun' };
    const p = isObj(payload) ? payload : {};
    const fields = cleanGuardFields(run);
    if (fields.spendCapped.includes(p.tool)) return { ok: false, reason: 'capReached', tool: p.tool };
    const res = checkSpend(fields, p.tool, p.costUsd);
    const out = { ok: res.ok, reason: res.reason, tool: res.tool, spent: res.spent, cap: res.cap, remaining: res.remaining };
    if (res.ok) {
      if (PAID_TOOLS.includes(res.tool)) ctx.update({ spend: res.spend });
      return out;
    }
    if (res.reason === 'capReached') capReached(res, fields);
    return out;
  }

  function capReached(res, fields) {
    ctx.update({ spendCapped: [...fields.spendCapped, res.tool] });
    ctx.logEvent(`${res.tool} spend cap reached ($${res.spent.toFixed(2)} of $${res.cap.toFixed(2)}): generation stopped for this run`);
    try {
      const ats = ctx.fileCards([spendCapCard(res.tool, res.spent, res.cap)]);
      if (!ats.length) ctx.logEvent(`${res.tool} spend cap: the card could not be filed`);
    } catch (err) {
      ctx.logEvent(`${res.tool} spend cap: the card could not be filed (${errText(err).slice(0, 150)})`);
    }
  }

  const cappedTools = () => cleanGuardFields(ctx.run()).spendCapped;

  /**
   * Logs one made asset for the run report (tool, prompt, seed, cost, path).
   * @param {unknown} entry untrusted: validated by cleanAssetEntry
   * @returns {boolean} whether it was kept
   */
  function recordAsset(entry) {
    const run = ctx.run();
    if (!run || run.phase === DONE_PHASE) return false;
    const clean = cleanAssetEntry(entry);
    if (!clean) return false;
    ctx.update({ assets: [...cleanGuardFields(run).assets, clean].slice(-MAX_ASSET_ENTRIES) });
    return true;
  }

  /** @returns {boolean} true when the result meant a tool is down and the run now waits */
  function toolDown(result, role) {
    const down = toolDownOf(result);
    const run = ctx.run();
    if (!down || !run) return false;
    const pauses = cleanGuardFields(run).toolDownPauses;
    if (pauses >= MAX_TOOL_DOWN_PAUSES) {
      ctx.logEvent(`${role}: ${down.tool} still down after ${pauses} pauses - no more waiting, the usual failure path takes over`);
      return false;
    }
    ctx.update({ toolDownPauses: pauses + 1 });
    const minutes = Math.round(TOOL_DOWN_WAIT_MS / 60000);
    ctx.logEvent(`${role}: ${down.tool} is down (${down.detail.slice(0, 150)}) - the run pauses ${minutes} min instead of retrying (${pauses + 1} of ${MAX_TOOL_DOWN_PAUSES})`);
    for (const fn of hooks) {
      try {
        Promise.resolve(fn({ ...run }, { ...down, role })).catch((err) => log(`[lunaswork] onToolDown failed: ${errText(err)}`));
      } catch (err) {
        log(`[lunaswork] onToolDown failed: ${errText(err)}`);
      }
    }
    ctx.armWait(ctx.now() + TOOL_DOWN_WAIT_MS, TOOL_DOWN_REASON);
    return true;
  }

  return { recordSpend, recordAsset, cappedTools, toolDown, toolDownOf };
}

module.exports = { TOOL_DOWN_WAIT_MS, TOOL_DOWN_REASON, MAX_TOOL_DOWN_PAUSES, MAX_ASSET_ENTRIES, cleanGuardFields, createToolGuard };
