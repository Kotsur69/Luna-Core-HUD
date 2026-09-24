// ============================================================================
// LunaCore - LM Studio CLI (`lms`) helpers
// ----------------------------------------------------------------------------
// Listing and loading models moved to the official SDK (src/lmstudiosdk.js),
// which reaches load settings `lms load` never exposed (expert offload, flash
// attention, K/V cache quantization). The CLI keeps the one job the SDK
// cannot do - WAKING LM Studio when it is not running (the SDK only connects
// to an instance that already answers; verified in its source, 2026-09-24) -
// plus a version check for the Settings status line.
//
// Same "always resolves, never rejects/throws" shape as src/ask.js's runAsk():
// no `lms` on PATH (a known Windows install-time PATH bug,
// lmstudio-ai/lmstudio-bug-tracker#1717, so ENOENT is an expected, surfaced
// state, not a crash) or a timeout becomes a typed { ok:false, reason }.
//
// normalizeDownloadedModel() is shared with the SDK path: the SDK's
// listDownloadedModels() returns the same row shape as `lms ls --json`
// (compared field by field against a live install, 2026-09-24), captured
// verbatim in test/lmstudiocli.test.js's SAMPLE_LS_JSON.
// ============================================================================

'use strict';

const { execFile } = require('child_process');

const DETECT_TIMEOUT_MS = 5000;
// Waking LM Studio starts its daemon and server; a cold start takes seconds.
const WAKE_TIMEOUT_MS = 60000;

/** Every model `type` the Settings picker has a row for. */
const MODEL_TYPES = new Set(['llm', 'embedding']);

/** Safe JSON.parse - returns null instead of throwing. */
function safeParse(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Normalizes one downloaded-model entry (`lms ls --json` or the SDK's
 * listDownloadedModels()). Returns null for anything unusable - no modelKey,
 * or a `type` this module does not recognize (defensive against LM Studio
 * adding a model kind, e.g. image models, this UI has no card for).
 */
function normalizeDownloadedModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.modelKey === 'string' ? raw.modelKey : '';
  if (!key) return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!MODEL_TYPES.has(type)) return null;
  const size = Number(raw.sizeBytes);
  const maxContext = Number(raw.maxContextLength);
  const quantization =
    raw.quantization && typeof raw.quantization === 'object' && typeof raw.quantization.name === 'string'
      ? raw.quantization.name
      : '';
  return {
    key,
    type,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : key,
    publisher: typeof raw.publisher === 'string' ? raw.publisher : '',
    sizeBytes: Number.isFinite(size) && size >= 0 ? Math.round(size) : 0,
    paramsString: typeof raw.paramsString === 'string' ? raw.paramsString : '',
    architecture: typeof raw.architecture === 'string' ? raw.architecture : '',
    quantization,
    maxContextLength: Number.isFinite(maxContext) && maxContext > 0 ? Math.round(maxContext) : null,
    vision: raw.vision === true,
  };
}

/**
 * Parses `lms ls --json` output. Never throws; malformed input yields [].
 * @param {string} stdout
 * @returns {Array<object>}
 */
function parseDownloadedModels(stdout) {
  const data = safeParse(stdout);
  const list = Array.isArray(data) ? data : [];
  return list.map(normalizeDownloadedModel).filter(Boolean);
}

/** Runs one `lms` command; resolves { ok, stdout } or a typed failure. */
function runLms(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('lms', args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, reason: error.code === 'ENOENT' ? 'not-found' : 'error' });
        return;
      }
      resolve({ ok: true, stdout: (stdout || '').trim() });
    });
  });
}

/**
 * Whether the `lms` CLI is reachable at all.
 * @returns {Promise<{ok:true, version:string}|{ok:false, reason:'not-found'|'error'}>}
 */
async function detectLmsCli({ timeoutMs = DETECT_TIMEOUT_MS } = {}) {
  const r = await runLms(['--version'], timeoutMs);
  return r.ok ? { ok: true, version: r.stdout } : r;
}

/**
 * Wakes LM Studio (its daemon plus the local server) via `lms server start`.
 * @returns {Promise<{ok:true}|{ok:false, reason:'not-found'|'error'}>}
 */
async function wakeLmStudio({ timeoutMs = WAKE_TIMEOUT_MS } = {}) {
  const r = await runLms(['server', 'start'], timeoutMs);
  return r.ok ? { ok: true } : r;
}

module.exports = {
  normalizeDownloadedModel,
  parseDownloadedModels,
  detectLmsCli,
  wakeLmStudio,
};
