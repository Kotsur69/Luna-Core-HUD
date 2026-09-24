// ============================================================================
// LunaCore - LM Studio control through the official SDK (@lmstudio/sdk)
// ----------------------------------------------------------------------------
// Replaces `lms load` for the Settings model picker. The CLI only exposes
// five load flags; the SDK's load config reaches what actually matters for a
// big MoE model on a 16 GB card - expert offload to CPU, flash attention,
// K/V cache quantization, eval batch size - and it can also say which models
// are loaded and unload them, so a new load never stacks on top of an old
// one (two big models at once spill VRAM and collapse throughput).
//
// What the SDK cannot do is START LM Studio: it only connects to an instance
// that already answers /lmstudio-greeting on one of its API ports (verified
// in the SDK source, 2026-09-24). Waking stays with the `lms` CLI
// (src/lmstudiocli.js wakeLmStudio), injected here as `wake`.
//
// Same contract as src/lmstudiocli.js: every exported call resolves to a
// typed { ok, reason } result, never throws, and the renderer-supplied load
// options pass a whitelist with range checks before they reach the SDK.
// CPU thread count is deliberately absent - the SDK's load config has no
// field for it; it lives in LM Studio's own per-model defaults.
// ============================================================================

'use strict';

const { normalizeDownloadedModel } = require('./lmstudiocli');

/** The ports the SDK itself probes for LM Studio's API (SDK source). */
const API_PORTS = [41343, 52993, 16141, 39414, 22931];

const GREETING_TIMEOUT_MS = 1500;
const WAKE_WAIT_MS = 30000;
const WAKE_POLL_MS = 500;
// A large model can take minutes to read off disk into VRAM/RAM.
const LOAD_TIMEOUT_MS = 300000;
// How long an aborted load may keep the lock while it winds down.
const ABORT_GRACE_MS = 60000;
const MAX_MESSAGE_CHARS = 2000;
const MAX_KEY_CHARS = 512;

/** llama.cpp K/V cache types offered in the UI (the SDK accepts more). */
const KV_CACHE_TYPES = new Set(['f16', 'q8_0', 'q4_0']);

const LIMITS = {
  contextLength: [256, 1048576],
  parallel: [1, 16],
  evalBatchSize: [32, 16384],
  ttlSeconds: [1, 7 * 24 * 3600],
};

const isBlank = (v) => v === undefined || v === null || v === '';
const isIntIn = (v, [min, max]) => Number.isInteger(v) && v >= min && v <= max;
const isRatio = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function cleanKey(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim();
  if (!key || key.length > MAX_KEY_CHARS || /[\u0000-\u001f]/.test(key)) return '';
  return key;
}

function clampMessage(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  return s.length > MAX_MESSAGE_CHARS ? s.slice(0, MAX_MESSAGE_CHARS) : s;
}

/**
 * One validated option -> a partial SDK config, or null for a bad value.
 * Blank means "let LM Studio decide" and never reaches a rule.
 */
const OPTION_RULES = {
  contextLength: (v) => (isIntIn(v, LIMITS.contextLength) ? { config: { contextLength: v } } : null),
  parallel: (v) => (isIntIn(v, LIMITS.parallel) ? { config: { maxParallelPredictions: v } } : null),
  gpu: (v) => (v === 'off' || v === 'max' || isRatio(v) ? { gpu: { ratio: v } } : null),
  expertOffload: (v) => (isRatio(v) ? { gpu: { numCpuExpertLayersRatio: v } } : null),
  flashAttention: (v) => (typeof v === 'boolean' ? { config: { flashAttention: v } } : null),
  kvCacheType: (v) => (KV_CACHE_TYPES.has(v)
    ? { config: { llamaKCacheQuantizationType: v, llamaVCacheQuantizationType: v } }
    : null),
  evalBatchSize: (v) => (isIntIn(v, LIMITS.evalBatchSize) ? { config: { evalBatchSize: v } } : null),
  ttlSeconds: (v) => (isIntIn(v, LIMITS.ttlSeconds) ? { ttl: v } : null),
};

/**
 * Validates renderer-supplied load options into SDK `load()` arguments.
 * Unknown keys are dropped; a known key with a bad value rejects the load.
 * @param {Object} opts
 * @returns {{ok:true, modelKey:string, loadOpts:Object}|{ok:false, reason:'missing-model-key'}|{ok:false, reason:'invalid-option', field:string}}
 */
function buildLoadRequest(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const modelKey = cleanKey(o.modelKey);
  if (!modelKey) return { ok: false, reason: 'missing-model-key' };

  let config = {};
  let gpu = {};
  let ttl;
  for (const [field, rule] of Object.entries(OPTION_RULES)) {
    if (isBlank(o[field])) continue;
    const part = rule(o[field]);
    if (!part) return { ok: false, reason: 'invalid-option', field };
    config = { ...config, ...(part.config || {}) };
    gpu = { ...gpu, ...(part.gpu || {}) };
    if (part.ttl !== undefined) ttl = part.ttl;
  }
  if (Object.keys(gpu).length > 0) config = { ...config, gpu };

  const identifier = cleanKey(o.identifier);
  const loadOpts = {
    ...(identifier ? { identifier } : {}),
    ...(ttl !== undefined ? { ttl } : {}),
    config,
  };
  return { ok: true, modelKey, loadOpts };
}

/** The first API port answering LM Studio's greeting, or null. */
async function findApiPort({ fetchImpl = fetch, ports = API_PORTS, timeoutMs = GREETING_TIMEOUT_MS } = {}) {
  const probe = async (port) => {
    const res = await fetchImpl(`http://127.0.0.1:${port}/lmstudio-greeting`, { signal: AbortSignal.timeout(timeoutMs) });
    const json = res.ok ? await res.json() : null;
    if (!json || json.lmstudio !== true) throw new Error('not LM Studio');
    return port;
  };
  try {
    return await Promise.any(ports.map(probe));
  } catch {
    return null;
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * LM Studio's API port, waking the app through `wake` when it is down.
 * @param {{findPort?:Function, wake?:Function|null, waitMs?:number, pollMs?:number}} deps
 * @returns {Promise<{ok:true, port:number}|{ok:false, reason:'not-running'}>}
 */
async function ensureRunning({ findPort = findApiPort, wake = null, waitMs = WAKE_WAIT_MS, pollMs = WAKE_POLL_MS } = {}) {
  const now = await findPort();
  if (now) return { ok: true, port: now };
  if (typeof wake !== 'function') return { ok: false, reason: 'not-running' };

  let woke;
  try {
    woke = await wake();
  } catch {
    woke = null;
  }
  if (!woke || !woke.ok) return { ok: false, reason: 'not-running' };

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const port = await findPort();
    if (port) return { ok: true, port };
    await delay(pollMs);
  }
  return { ok: false, reason: 'not-running' };
}

/** A silent logger: SDK warnings would otherwise go to the main process console. */
const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

/** Opens one SDK client against a known port (the SDK is loaded lazily). */
function openSdkClient(port) {
  const { LMStudioClient } = require('@lmstudio/sdk');
  return new LMStudioClient({ baseUrl: `ws://127.0.0.1:${port}`, logger: QUIET_LOGGER });
}

/** Runs `fn(client)` on a fresh client and always disposes it afterwards. */
async function withClient(deps, fn) {
  const running = await deps.ensure();
  if (!running.ok) return running;
  let client = null;
  try {
    client = deps.openClient(running.port);
    return await fn(client);
  } finally {
    if (client && typeof client[Symbol.asyncDispose] === 'function') {
      await client[Symbol.asyncDispose]().catch(() => {});
    }
  }
}

function resolveDeps(deps) {
  const d = deps || {};
  return {
    ensure: d.ensure || (() => ensureRunning({ wake: d.wake || null })),
    openClient: d.openClient || openSdkClient,
    timeoutMs: d.timeoutMs || LOAD_TIMEOUT_MS,
    graceMs: d.graceMs || ABORT_GRACE_MS,
  };
}

/**
 * Every downloaded model in the panel's row shape, with `loaded` set for the
 * ones LM Studio currently holds in memory.
 * @returns {Promise<{ok:true, models:Array<Object>}|{ok:false, reason:'not-running'|'error'}>}
 */
async function listModels(deps) {
  const d = resolveDeps(deps);
  try {
    return await withClient(d, async (client) => {
      // Sequential on purpose: with Promise.all a synchronous throw in the
      // second call would leave the first call's rejection unhandled.
      const downloaded = await client.system.listDownloadedModels();
      const loaded = await client.llm.listLoaded();
      const loadedKeys = new Set((loaded || []).map((m) => m && m.modelKey).filter(Boolean));
      const models = (downloaded || [])
        .map(normalizeDownloadedModel)
        .filter(Boolean)
        .map((m) => ({ ...m, loaded: loadedKeys.has(m.key) }));
      return { ok: true, models };
    });
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// One load at a time: a load moves tens of GB and this is reachable over IPC
// regardless of any disabled button in the renderer.
let loadInFlight = false;
let lockOwner = 0; // bumps per load so a stale release never frees a newer load's lock

async function unloadAll(client) {
  const loaded = await client.llm.listLoaded();
  await Promise.all((loaded || []).map((m) => m.unload()));
}

/**
 * Loads a model with validated options. By default every loaded model is
 * unloaded first (`replaceLoaded: false` keeps them).
 * @returns {Promise<{ok:true, identifier:string}|{ok:false, reason:string, field?:string, message?:string}>}
 */
async function loadModel(opts, deps) {
  const request = buildLoadRequest(opts);
  if (!request.ok) return request;
  if (loadInFlight) return { ok: false, reason: 'busy' };
  const d = resolveDeps(deps);
  const replaceLoaded = !(opts && opts.replaceLoaded === false);

  loadInFlight = true;
  const owner = ++lockOwner;
  let settled = false;
  const abort = new AbortController();
  let timer = null;
  let graceTimer = null;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve({ ok: false, reason: 'timeout' });
    }, d.timeoutMs);
  });

  const run = withClient(d, async (client) => {
    // Checked before anything is unloaded: a typo must never cost the
    // model that is loaded right now.
    const downloaded = await client.system.listDownloadedModels();
    if (!(downloaded || []).some((m) => m && m.modelKey === request.modelKey)) {
      return { ok: false, reason: 'unknown-model' };
    }
    if (replaceLoaded) await unloadAll(client);
    const model = await client.llm.load(request.modelKey, { ...request.loadOpts, signal: abort.signal });
    return { ok: true, identifier: (model && model.identifier) || request.modelKey };
  }).catch((err) => (abort.signal.aborted
    ? { ok: false, reason: 'timeout' }
    : { ok: false, reason: 'load-failed', message: clampMessage(err && err.message) }));

  // The lock follows the real work, not the race: after a timeout the aborted
  // load may still be unloading/loading, and a second load must not stack on
  // it. graceMs bounds a load that ignores the abort, so the lock cannot
  // stick forever.
  const release = () => {
    clearTimeout(graceTimer);
    if (lockOwner === owner) loadInFlight = false;
  };
  run.then(() => {
    settled = true;
    release();
  });

  try {
    return await Promise.race([run, timedOut]);
  } finally {
    clearTimeout(timer);
    if (abort.signal.aborted && !settled) graceTimer = setTimeout(release, d.graceMs);
  }
}

module.exports = {
  buildLoadRequest,
  findApiPort,
  ensureRunning,
  listModels,
  loadModel,
  KV_CACHE_TYPES,
  API_PORTS,
};
