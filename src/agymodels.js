// ============================================================================
// LunaCore - the Antigravity (`agy`) models a worker can run on (main only)
// ----------------------------------------------------------------------------
// `agy models` prints one `<id>\t<name>` line per model the signed-in account
// may use (e.g. `gemini-4-argon-medium\tGemini 4 Argon (Medium)`). The ids
// differ per account, so they are read live, never shipped: this module runs
// that command (execFile, windowsHide, a kill timer - an agy call can hang,
// `agy --help` never exits), parses and caches the list, and is the one place
// main asks "is this agy model id real" before an id reaches any argv.
//
//   parseAgyModels(stdout)   the `agy models` text -> [{id, name}]
//   createAgyModels(opts)    a cache: refresh() / ensure() / list() /
//                            choices() / isKnownId(id) / resolveModelId(model)
//   sharedAgyModels()        the process-wide cache (main sets it up with the
//                            agy profile's env; src/agyexec.js reads it)
//
// A missing agy, a failed or timed-out call, or a list with no usable line
// leaves only plain 'agy' (agy's own default model) on offer, and is logged.
// The worker-model choices it adds are 'agy:<id>' (src/workerModels.js).
// ============================================================================

'use strict';

const os = require('os');
const { execFile } = require('child_process');
const { AGY_MODEL, isAgyModelId, agyModelIdOf, agyVariant, agyModelLabel } = require('./workerModels');

const AGY_BIN = 'agy';
const AGY_MODELS_ARGS = Object.freeze(['models']);
/** Kill timer of one `agy models` call. */
const AGY_MODELS_TIMEOUT_MS = 20 * 1000;
/** More lines than any account lists; the rest is ignored. */
const MAX_AGY_MODELS = 100;
const MAX_NAME_CHARS = 80;
const MAX_BUFFER = 1024 * 1024;
const MAX_DETAIL_CHARS = 200;
/** ensure() after a failed `agy models`: no new call within this long. */
const FAILED_RETRY_MS = 60 * 1000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Control, format (bidi overrides, zero-width) and line / paragraph separator characters. */
const CONTROL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const oneLine = (v, max = MAX_DETAIL_CHARS) =>
  String(v == null ? '' : v)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** A display name from agy's output: no escape codes, no control characters, capped. */
function cleanName(raw) {
  return String(raw || '')
    .replace(ANSI_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);
}

/** A table header's first column. */
const HEADER_RE = /^(id|model|models|name)$/i;
/** A model-shaped id (gemini-4-argon-medium, claude-opus-5-5-x): it holds a digit or a dash. */
const MODEL_SHAPED_RE = /[0-9-]/;

/**
 * One output line as [id, rest], or null for a line that is no model:
 * `<id>\t<name>` is split at the tab; without a tab, a lone token is an id,
 * and a longer line only when its first word is model-shaped (so prose such
 * as "Available models:" or "No models available" is skipped).
 */
function splitLine(line) {
  const tab = line.indexOf('\t');
  const [id, rest] = tab >= 0 ? [line.slice(0, tab).trim(), line.slice(tab + 1)] : [line.split(/\s+/)[0], line.slice(line.split(/\s+/)[0].length)];
  if (HEADER_RE.test(id)) return null;
  if (tab < 0 && rest.trim() && !MODEL_SHAPED_RE.test(id)) return null;
  return [id, rest];
}

/**
 * The models in `agy models` output. A line is `<id>\t<name>` (a line with
 * no tab: see splitLine). A line whose first field is no well-formed id (a
 * header, a warning, a blank) is skipped; a repeated id keeps its first
 * name. A missing name becomes the id.
 * @param {unknown} stdout
 * @returns {{id:string, name:string}[]}
 */
function parseAgyModels(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout == null ? '' : stdout).replace(ANSI_RE, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const split = splitLine(line);
    if (!split) continue;
    const [id, rest] = split;
    if (!isAgyModelId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanName(rest) || id });
    if (out.length >= MAX_AGY_MODELS) break;
  }
  return out;
}

/**
 * The worker-model choices of a model list: plain 'agy' first (always there),
 * then one 'agy:<id>' per model with its UI name.
 * @param {{id:string, name:string}[]} models
 * @returns {{id:string, name:string}[]}
 */
function choicesOf(models) {
  const list = Array.isArray(models) ? models : [];
  const names = Object.fromEntries(list.map((m) => [m.id, m.name]));
  return [
    { id: AGY_MODEL, name: agyModelLabel(AGY_MODEL) },
    ...list.map((m) => {
      const id = agyVariant(m.id);
      return { id, name: agyModelLabel(id, names) };
    }),
  ];
}

/**
 * A cache of the account's agy models.
 * @param {{execImpl?:Function, envOf?:() => (object|null), log?:(line:string) => void, timeoutMs?:number}} [opts]
 *   envOf: the env `agy models` runs in (the agy profile's, else the inherited one)
 */
function createAgyModels({ execImpl = execFile, envOf = () => process.env, log = () => {}, timeoutMs = AGY_MODELS_TIMEOUT_MS, now = Date.now } = {}) {
  // The last list `agy models` gave. A failed call keeps it for checking ids
  // (a run approved on a variant does not silently drop to agy's default on
  // one hiccup) but offers no variant in the pickers until a call works again.
  let models = [];
  let lastOk = false;
  let loaded = false;
  let inflight = null;
  let lastAttemptAt = 0;

  /** The env for `agy models` (the agy login lives in the OS keyring); a throwing envOf is logged and falls back to the inherited env. */
  function envForCall() {
    try {
      return envOf() || process.env;
    } catch (err) {
      log(`[agymodels] agy env unavailable, using the inherited env: ${oneLine(err instanceof Error ? err.message : err)}`);
      return process.env;
    }
  }

  /** One `agy models` call; resolves {ok, stdout} | {ok:false, detail}. Never rejects. */
  function runModels() {
    return new Promise((resolve) => {
      // cwd: the home folder, never a project - Windows looks for a bare `agy` in the cwd first.
      const opts = { cwd: os.homedir(), env: envForCall(), timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true };
      try {
        execImpl(AGY_BIN, [...AGY_MODELS_ARGS], opts, (error, stdout, stderr) => {
          if (!error) return resolve({ ok: true, stdout: String(stdout || '') });
          if (error.code === 'ENOENT') return resolve({ ok: false, detail: 'agy not found' });
          if (error.killed) return resolve({ ok: false, detail: `timed out after ${timeoutMs} ms` });
          resolve({ ok: false, detail: oneLine(stderr || error.message) });
        });
      } catch (err) {
        resolve({ ok: false, detail: oneLine(err instanceof Error ? err.message : err) });
      }
    });
  }

  /** A copy of the cached list. */
  function list() {
    return models.map((m) => ({ ...m }));
  }

  /**
   * Reads the list again (one call at a time: a second refresh joins the
   * first). A failure leaves only plain 'agy' on offer and is logged; the
   * ids of the last good list still pass isKnownId.
   * @param {{minIntervalMs?:number}} [opts] minIntervalMs: within this long of
   *   the last call, answer from the cache instead (a picker focused again and again)
   * @returns {Promise<{id:string, name:string}[]>} the offered models
   */
  function refresh({ minIntervalMs = 0 } = {}) {
    if (inflight) return inflight;
    if (minIntervalMs > 0 && lastAttemptAt && now() - lastAttemptAt < minIntervalMs) return Promise.resolve(offered());
    lastAttemptAt = now();
    inflight = runModels().then((res) => {
      inflight = null;
      lastOk = res.ok;
      if (!res.ok) {
        log(`[agymodels] \`agy models\` failed, offering only the default agy model: ${res.detail}`);
        return offered();
      }
      loaded = true;
      models = parseAgyModels(res.stdout);
      if (!models.length) log('[agymodels] `agy models` listed no usable model id, offering only the default agy model');
      return offered();
    });
    return inflight;
  }

  /**
   * The list, read until one call worked. After a failed call it waits
   * FAILED_RETRY_MS before spawning agy again, so a hanging agy does not
   * cost every caller another kill-timer wait.
   */
  function ensure() {
    return loaded ? Promise.resolve(offered()) : refresh({ minIntervalMs: FAILED_RETRY_MS });
  }

  /** What the pickers offer: the list while the last call worked, else nothing. */
  function offered() {
    return lastOk ? list() : [];
  }

  /** True for an id the last `agy models` listed. */
  function isKnownId(id) {
    return isAgyModelId(id) && models.some((m) => m.id === id);
  }

  /**
   * The id to hand agy as `--model` for a worker-model choice: the id of a
   * known 'agy:<id>' variant, else null (plain 'agy', anything else, or an id
   * the live list does not hold - that one is also logged).
   * @param {unknown} model
   * @returns {string|null}
   */
  function resolveModelId(model) {
    const id = agyModelIdOf(model);
    if (!id) return null;
    if (isKnownId(id)) return id;
    log(`[agymodels] agy model "${id}" is not in the live \`agy models\` list${loaded ? '' : ' (not read yet)'}; agy runs on its default model`);
    return null;
  }

  return {
    refresh,
    ensure,
    list,
    choices: () => choicesOf(offered()),
    isKnownId,
    resolveModelId,
    isLoaded: () => loaded,
  };
}

let shared = null;

/** The process-wide cache: the one main set up, else a default one. */
function sharedAgyModels() {
  if (!shared) shared = createAgyModels();
  return shared;
}

/** Main: make `cache` the process-wide one (built with the agy profile's env and main's log). */
function setSharedAgyModels(cache) {
  shared = cache || null;
}

module.exports = {
  cleanName,
  AGY_MODELS_ARGS,
  AGY_MODELS_TIMEOUT_MS,
  FAILED_RETRY_MS,
  MAX_AGY_MODELS,
  parseAgyModels,
  choicesOf,
  createAgyModels,
  sharedAgyModels,
  setSharedAgyModels,
};
