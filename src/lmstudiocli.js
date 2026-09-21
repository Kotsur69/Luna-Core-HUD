// ============================================================================
// LunaCore - LM Studio CLI (`lms`) control
// ----------------------------------------------------------------------------
// This is the concrete replacement for the "go local claude" desktop script:
// it lets LunaCore's own Settings force-load a downloaded LM Studio model,
// instead of that control living outside the app. src/lmstudio.js already
// answers "is a model loaded right now" via a passive, read-only HTTP poll of
// a local server's REST endpoint (see that file's header) - it never writes
// anything. This module is the write-capable half: it shells out to the `lms`
// CLI (LM Studio's own official CLI, distributed with the app) to list every
// DOWNLOADED model (not just currently-loaded ones - /api/v0/models cannot see
// those) and to force-load one.
//
// Same "always resolves, never rejects/throws" shape as src/ask.js's runAsk():
// every failure - no `lms` on PATH (a known Windows install-time PATH bug,
// lmstudio-ai/lmstudio-bug-tracker#1717, so ENOENT is an expected, surfaced
// state, not a crash), a bad model key, a timeout - becomes a typed
// { ok:false, reason }, never a thrown exception.
//
// The JSON shapes parsed below (`lms ls --json` / `lms ps --json`) are not
// documented by LM Studio's own docs site - they were captured verbatim from
// a real `lms` install during this feature's development (see
// test/lmstudiocli.test.js's SAMPLE_LS_JSON/SAMPLE_PS_JSON), not guessed.
// ============================================================================

'use strict';

const { execFile } = require('child_process');

const DETECT_TIMEOUT_MS = 5000;
const LIST_TIMEOUT_MS = 10000;
// Force-loading a large local model can genuinely take minutes (tens of GB
// read off disk into VRAM/RAM) - a short timeout here would misreport a slow
// but successful load as a failure.
const LOAD_TIMEOUT_MS = 300000;

/** Every `type` value `lms ls --json`/`lms ps --json` is known to report. */
const MODEL_TYPES = new Set(['llm', 'embedding']);

/** Caps a CLI error message before it reaches the renderer. */
const MAX_MESSAGE_CHARS = 2000;

/** Safe JSON.parse - returns null instead of throwing. */
function safeParse(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampMessage(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  return s.length > MAX_MESSAGE_CHARS ? s.slice(0, MAX_MESSAGE_CHARS) : s;
}

/**
 * Normalizes one `lms ls --json` entry. Returns null for anything unusable -
 * no modelKey, or a `type` this module does not recognize (defensive against
 * `lms` ever adding a model kind, e.g. image models, this UI has no card for).
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
 * Parses `lms ls --json` output - every model downloaded to disk, loaded or
 * not (unlike src/lmstudio.js's /api/v0/models, which only sees a server that
 * is currently running). Never throws; malformed input yields [].
 * @param {string} stdout
 * @returns {Array<object>}
 */
function parseDownloadedModels(stdout) {
  const data = safeParse(stdout);
  const list = Array.isArray(data) ? data : [];
  return list.map(normalizeDownloadedModel).filter(Boolean);
}

/** Normalizes one `lms ps --json` entry. Returns null when there is no modelKey. */
function normalizeLoadedModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const key = typeof raw.modelKey === 'string' ? raw.modelKey : '';
  if (!key) return null;
  const ctx = Number(raw.contextLength);
  return {
    key,
    identifier: typeof raw.identifier === 'string' ? raw.identifier : key,
    status: typeof raw.status === 'string' ? raw.status : '',
    contextLength: Number.isFinite(ctx) && ctx > 0 ? Math.round(ctx) : null,
  };
}

/**
 * Parses `lms ps --json` output - the models currently loaded, so the
 * Settings picker can badge one of the downloaded rows as "already loaded"
 * instead of the user force-loading it again for nothing.
 * @param {string} stdout
 * @returns {Array<object>}
 */
function parseLoadedModels(stdout) {
  const data = safeParse(stdout);
  const list = Array.isArray(data) ? data : [];
  return list.map(normalizeLoadedModel).filter(Boolean);
}

/**
 * Pure argv builder for `lms load` - never a shell string, same reasoning
 * src/ask.js's buildAskArgs() documents for the same shape. `-y` is always
 * included: without it, an ambiguous model key drops `lms` into an
 * interactive picker, which would just hang execFile forever since nothing
 * is attached to answer it.
 * `modelKey`/`identifier` are rejected outright when they start with `-`: a
 * real LM Studio model key never does (see test/lmstudiocli.test.js's real
 * samples), and without this guard a renderer-supplied value shaped like a
 * flag (e.g. "--gpu") could be interpreted by `lms`'s own argument parser as
 * an option instead of the intended positional/value argument - not a shell
 * injection (execFile's array argv is immune to that), but still worth
 * closing off cheaply.
 * @param {{modelKey:string, identifier?:string, gpu?:'off'|'max'|number, ttlSeconds?:number}} opts
 * @returns {string[]|null} null when `modelKey` is missing/blank/flag-shaped
 */
function buildLoadArgs(opts) {
  const { modelKey, identifier, gpu, ttlSeconds } = opts && typeof opts === 'object' ? opts : {};
  const key = typeof modelKey === 'string' ? modelKey.trim() : '';
  if (!key || key.startsWith('-')) return null;

  const args = ['load', key, '-y'];

  if (typeof identifier === 'string' && identifier.trim() && !identifier.trim().startsWith('-')) {
    args.push('--identifier', identifier.trim());
  }

  if (gpu === 'off' || gpu === 'max') {
    args.push('--gpu', gpu);
  } else if (typeof gpu === 'number' && Number.isFinite(gpu) && gpu >= 0 && gpu <= 1) {
    args.push('--gpu', String(gpu));
  }

  if (typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    args.push('--ttl', String(Math.round(ttlSeconds)));
  }

  return args;
}

/**
 * Whether the `lms` CLI is reachable at all. ENOENT is an expected, surfaced
 * state (see this file's header re: the Windows PATH bug), not an error.
 * @returns {Promise<{ok:true, version:string}|{ok:false, reason:'not-found'|'error'}>}
 */
function detectLmsCli({ timeoutMs = DETECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('lms', ['--version'], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, reason: error.code === 'ENOENT' ? 'not-found' : 'error' });
        return;
      }
      resolve({ ok: true, version: (stdout || '').trim() });
    });
  });
}

/**
 * Every model downloaded to disk, via `lms ls --json`.
 * @returns {Promise<{ok:true, models:Array<object>}|{ok:false, reason:'not-found'|'error'}>}
 */
function listDownloadedModels({ timeoutMs = LIST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('lms', ['ls', '--json'], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ ok: false, reason: error.code === 'ENOENT' ? 'not-found' : 'error' });
        return;
      }
      resolve({ ok: true, models: parseDownloadedModels(stdout || '') });
    });
  });
}

// Force-loading is expensive (tens of GB into VRAM/RAM, up to LOAD_TIMEOUT_MS)
// and this is reachable directly over IPC, bypassing any UI-level button
// disable - a buggy or repeated renderer call must not be able to kick off
// several concurrent `lms load` runs. One module-level in-flight lock, same
// "typed, never-throwing" contract as everything else here.
let loadInFlight = false;

/**
 * Force-loads a model via `lms load <model-key> -y [...]` - the actual
 * "change settings from here" action this module exists for. Always
 * resolves, never rejects/throws.
 * @param {{modelKey:string, identifier?:string, gpu?:'off'|'max'|number, ttlSeconds?:number}} opts
 * @returns {Promise<{ok:true, message:string}|{ok:false, reason:'missing-model-key'|'busy'|'not-found'|'timeout'|'load-failed', message?:string}>}
 */
function loadModel(opts, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const args = buildLoadArgs(opts);
    if (!args) {
      resolve({ ok: false, reason: 'missing-model-key' });
      return;
    }
    if (loadInFlight) {
      resolve({ ok: false, reason: 'busy' });
      return;
    }
    loadInFlight = true;
    execFile('lms', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      loadInFlight = false;
      if (error) {
        if (error.code === 'ENOENT') {
          resolve({ ok: false, reason: 'not-found' });
          return;
        }
        // Same timeout-detection convention as src/ask.js's runAsk(): Node
        // kills the child with SIGTERM once `timeout` elapses, and the
        // `|| !error.signal` fallback covers signal reporting being
        // unreliable on Windows (this app's primary platform).
        if (error.killed && (error.signal === 'SIGTERM' || !error.signal)) {
          resolve({ ok: false, reason: 'timeout' });
          return;
        }
        resolve({ ok: false, reason: 'load-failed', message: clampMessage(stderr || stdout) });
        return;
      }
      resolve({ ok: true, message: clampMessage(stdout) });
    });
  });
}

module.exports = {
  parseDownloadedModels,
  parseLoadedModels,
  buildLoadArgs,
  detectLmsCli,
  listDownloadedModels,
  loadModel,
};
