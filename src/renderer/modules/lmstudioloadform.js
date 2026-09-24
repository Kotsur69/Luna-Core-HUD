// ============================================================================
// LunaCore - LM Studio load form: pure logic
// ----------------------------------------------------------------------------
// One model row's option inputs (raw strings, straight from the DOM) -> the
// payload window.lunacore.loadLmStudioModel() sends to src/lmstudiosdk.js.
// Pure (no document.*, no window.*) so it is unit-tested directly
// (test/lmstudioloadform.test.js); lmstudiomodels.js owns the DOM half.
//
// A blank or junk field is OMITTED, which the main side treats as "let LM
// Studio decide". The main side re-validates everything (buildLoadRequest);
// this layer only keeps obviously-bad input from costing a round trip.
// ============================================================================

'use strict';

/** Select options the panel offers; anything else is dropped. */
const GPU_MODES = ['auto', 'off', 'max', 'custom'];
const TRISTATE = ['auto', 'on', 'off'];
const KV_CACHE_CHOICES = ['auto', 'f16', 'q8_0', 'q4_0'];

/** A fresh row: every field blank / 'auto'. */
function blankOptions() {
  return {
    contextLength: '',
    gpu: 'auto', // 'auto' | 'off' | 'max' | 'custom'
    gpuRatio: '',
    expertOffload: '', // 0-1 share of MoE expert layers kept on the CPU
    flashAttention: 'auto', // 'auto' | 'on' | 'off'
    kvCacheType: 'auto', // 'auto' | 'f16' | 'q8_0' | 'q4_0'
    evalBatchSize: '',
    parallel: '',
    ttlSeconds: '',
    identifier: '',
  };
}

/** A positive integer from a raw input string, or null. */
function positiveInt(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}

/** A 0-1 ratio from a raw input string, or null. */
function ratio(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function gpuValue(opts) {
  if (!GPU_MODES.includes(opts.gpu)) return null;
  if (opts.gpu === 'off' || opts.gpu === 'max') return opts.gpu;
  if (opts.gpu === 'custom') return ratio(opts.gpuRatio);
  return null;
}

/**
 * @param {string} modelKey
 * @param {ReturnType<typeof blankOptions>} opts
 * @param {{replaceLoaded:boolean}} flags
 * @returns {Object} the loadLmStudioModel() payload
 */
function buildLoadPayload(modelKey, opts, { replaceLoaded }) {
  const o = { ...blankOptions(), ...(opts || {}) };
  const fields = {
    contextLength: positiveInt(o.contextLength),
    gpu: gpuValue(o),
    expertOffload: ratio(o.expertOffload),
    flashAttention: TRISTATE.includes(o.flashAttention) && o.flashAttention !== 'auto' ? o.flashAttention === 'on' : null,
    kvCacheType: KV_CACHE_CHOICES.includes(o.kvCacheType) && o.kvCacheType !== 'auto' ? o.kvCacheType : null,
    evalBatchSize: positiveInt(o.evalBatchSize),
    parallel: positiveInt(o.parallel),
    ttlSeconds: positiveInt(o.ttlSeconds),
    identifier: typeof o.identifier === 'string' && o.identifier.trim() ? o.identifier.trim() : null,
  };
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
  return { modelKey, replaceLoaded: replaceLoaded !== false, ...set };
}

export { blankOptions, buildLoadPayload, GPU_MODES, TRISTATE, KV_CACHE_CHOICES };
