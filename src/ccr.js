// ============================================================================
// LunaCore - claude-code-router (CCR) gateway process control
// ----------------------------------------------------------------------------
// Phase 4a of the AI-providers feature (reference/AI_PROVIDERS_RESUME.md).
// Five shipped provider templates (`ollama`, `codex`, `gemini`, `grok`,
// `openai-compatible`) route through a locally-run claude-code-router gateway
// instead of talking upstream directly - this module detects/starts/stops
// that gateway and nothing else. Not wired into main.js/preload.js yet.
//
// HARD BOUNDARY: CCR's provider/model/routing config is edited ONLY through
// `ccr ui`'s browser UI (its own process, its own port). LunaCore never
// writes CCR config, never calls its RPC/manager API, and never reads/stores
// the management UI's authenticated URL - `ccr start`/`ccr ui` print it to
// stdout as `http://127.0.0.1:<port>/?ccr_web_token=<token>` (a password),
// so any raw `ccr` stdout/stderr this module can see goes through
// redactCcrOutput() first. The only endpoint ever called on the GATEWAY
// itself is `GET /v1/models` (OpenAI-compatible list route, confirmed against
// a live v3.1.1 install's actual route table - there is no `/api/v1/models`
// route in this version). See detectCcr()/openManagementUi() below for two
// more behaviors that were verified for real rather than guessed.
// ============================================================================

'use strict';

const { execFile } = require('child_process');
const http = require('http');
const { DEFAULT_CCR_PORT } = require('./providers');

const DETECT_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 1500;
const START_POLL_INTERVAL_MS = 500;
const START_TIMEOUT_BUDGET_MS = 10000;

/** Caps redactCcrOutput()'s result - this feature's own spec picks 500 as the
 *  fallback length (no existing shared convention covers this exact case). */
const MAX_OUTPUT_CHARS = 500;

/** Safe JSON.parse - returns null instead of throwing. */
function safeParseJson(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The `data`/`models` array out of a parsed `/v1/models` body, or null. */
function modelListFrom(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.models)) return parsed.models;
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One `GET /v1/models` against 127.0.0.1:port. Never throws - any transport
 *  failure (refused, timeout, DNS) resolves to `null`. */
function rawProbe(port, headers) {
  return new Promise((resolve) => {
    const p = Number(port);
    if (!Number.isFinite(p) || p <= 0) {
      resolve(null);
      return;
    }
    let req;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (req) req.destroy();
      resolve(result);
    };
    try {
      req = http.get(
        { hostname: '127.0.0.1', port: p, path: '/v1/models', timeout: PROBE_TIMEOUT_MS, headers },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            // A foreign server answering megabytes on this port is not one we
            // want to hold in memory just to classify it.
            if (body.length > 512 * 1024) finish({ status: res.statusCode, body: '' });
          });
          res.on('end', () => finish({ status: res.statusCode, body }));
          res.on('error', () => finish(null));
        }
      );
    } catch {
      resolve(null);
      return;
    }
    req.on('timeout', () => finish(null));
    req.on('error', () => finish(null));
  });
}

/**
 * The port a real `claude` session pointed at this profile would talk to.
 * @param {{ANTHROPIC_BASE_URL?: string}} env
 * @returns {number|null} parsed port; DEFAULT_CCR_PORT when missing/unparseable;
 *   null when the host is not localhost/127.0.0.1
 */
function gatewayPortFromEnv(env) {
  const base = env && typeof env === 'object' ? env.ANTHROPIC_BASE_URL : undefined;
  if (typeof base !== 'string' || !base.trim()) return DEFAULT_CCR_PORT;

  let parsed;
  try {
    parsed = new URL(base.trim());
  } catch {
    return DEFAULT_CCR_PORT;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') return null;

  if (!parsed.port) return DEFAULT_CCR_PORT;
  const port = Number(parsed.port);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_CCR_PORT;
}

/** Normalizes an arbitrary "expected port" input to a real port number. */
function normalizeExpectedPort(expectedPort) {
  return Number.isFinite(expectedPort) && expectedPort > 0 ? Math.round(expectedPort) : DEFAULT_CCR_PORT;
}

/** Ports worth probing for a running gateway - covers CCR's own silent
 *  "preferred port taken, try the next one" fallback (its own README)
 *  without a broad port scan. De-duplicated, expectedPort first. */
function candidatePorts(expectedPort) {
  const expected = normalizeExpectedPort(expectedPort);
  const ports = [
    expected,
    DEFAULT_CCR_PORT,
    DEFAULT_CCR_PORT + 1,
    DEFAULT_CCR_PORT + 2,
    DEFAULT_CCR_PORT + 3,
    DEFAULT_CCR_PORT + 4,
  ];
  return [...new Set(ports)];
}

/** Classifies one rawProbe() result. null = no response at all (refused/timeout). */
function classifyProbe(probe) {
  if (!probe || typeof probe !== 'object' || typeof probe.status !== 'number') return 'down';
  if (probe.status === 401 || probe.status === 403) return 'up-auth';
  if (probe.status === 200) return modelListFrom(safeParseJson(probe.body)) ? 'up' : 'foreign';
  return 'foreign';
}

/** Strips CCR's management token (and any query string on a URL-shaped
 *  substring) out of text that could reach a log line, IPC payload, or Error
 *  message from a `ccr` child process - see this file's header. Never throws. */
function redactCcrOutput(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';

  // Drop the query string off any URL-shaped substring (the exact shape
  // `ccr start`/`ccr ui` print), then strip a bare `ccr_web_token=...` pair
  // on its own in case it ever appears outside a full URL.
  let redacted = raw.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/gi, '$1');
  redacted = redacted.replace(/[?&]?ccr_web_token=[^\s&]*/gi, '');

  const trimmed = redacted.trim();
  return trimmed.length > MAX_OUTPUT_CHARS ? trimmed.slice(0, MAX_OUTPUT_CHARS) : trimmed;
}

/**
 * Pure decision table mapping detect/probe/start signals to one state a
 * Settings UI can render. No I/O, no hidden state.
 * @param {{installed:boolean, probe:'up'|'up-auth'|'foreign'|'down'|null, expectedPort?:number, foundPort?:number, startedByUs?:boolean}} args
 * @returns {{state:string, reason:string, port:number|null}}
 */
function describeState({ installed, probe, expectedPort, foundPort, startedByUs } = {}) {
  const expected = Number.isFinite(expectedPort) ? expectedPort : null;
  const found = Number.isFinite(foundPort) ? foundPort : null;

  if (!installed) return { state: 'not-installed', reason: 'ccr-not-on-path', port: null };

  const isDown = probe === 'down' || probe === null || probe === undefined;
  if (isDown && startedByUs) return { state: 'starting', reason: 'start-in-progress', port: expected };
  if (isDown) return { state: 'down', reason: 'gateway-not-listening', port: expected };
  if (probe === 'up-auth') {
    return { state: 'auth-required', reason: 'gateway-requires-client-key', port: found ?? expected };
  }
  if (probe === 'foreign') {
    return { state: 'foreign-port', reason: 'port-owned-by-another-process', port: found ?? expected };
  }
  if (probe === 'up') {
    if (found !== null && expected !== null && found !== expected) {
      return { state: 'port-mismatch', reason: 'gateway-on-different-port', port: found };
    }
    return { state: 'up', reason: 'gateway-healthy', port: found ?? expected };
  }
  return { state: 'down', reason: 'unrecognized-probe', port: expected };
}

/**
 * Whether the `ccr` CLI is reachable at all. VERIFIED FOR REAL against a live
 * v3.1.1 install: `-v`/`--version` are NOT version flags in this release -
 * both fall through to "open a profile named -v", which fails with an
 * unrelated "no models configured" error, and there is no CLI-reported
 * version string at all - so `--help` (which exits 0 and prints usage) is
 * the real "on PATH" signal, and `version` is always '' rather than guessed.
 * ENOENT (not on PATH) is an expected, surfaced state, never a crash.
 * @returns {Promise<{ok:true, version:string}|{ok:false, reason:'not-found'|'error'}>}
 */
function detectCcr({ timeoutMs = DETECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('ccr', ['--help'], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error) => {
      if (error) {
        resolve({ ok: false, reason: error.code === 'ENOENT' ? 'not-found' : 'error' });
        return;
      }
      resolve({ ok: true, version: '' });
    });
  });
}

/** One unauthenticated probe of a candidate port - a thin rawProbe() wrapper
 *  kept as its own export so findGateway()'s per-port loop reads clearly. */
function probeGateway(port) {
  return rawProbe(port);
}

/**
 * Probes candidatePorts(expectedPort) in order, first non-'down' wins - how a
 * CCR that silently fell back to a different port still gets found.
 * @param {number} [expectedPort]
 * @returns {Promise<{ok:true, port:number, classification:string, mismatch:boolean}|{ok:false, reason:'not-running'}>}
 */
async function findGateway(expectedPort) {
  const expected = normalizeExpectedPort(expectedPort);
  for (const port of candidatePorts(expectedPort)) {
    const classification = classifyProbe(await probeGateway(port));
    if (classification !== 'down') return { ok: true, port, classification, mismatch: port !== expected };
  }
  return { ok: false, reason: 'not-running' };
}

// Same "one caller wins, everyone else gets busy" discipline as
// src/lmstudiocli.js's loadInFlight - `ccr start` forks a real process.
let startInFlight = false;

async function doStartGateway(expectedPort) {
  const existing = await findGateway(expectedPort);
  if (existing.ok && (existing.classification === 'up' || existing.classification === 'up-auth')) {
    // Someone else already has a gateway answering - never start a second one.
    return { ok: true, port: existing.port, startedByUs: false };
  }

  const launch = await new Promise((resolve) => {
    execFile('ccr', ['start'], { timeout: DETECT_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, detail: redactCcrOutput(stderr || stdout || error.message) });
        return;
      }
      resolve({ ok: true });
    });
  });
  if (!launch.ok) return { ok: false, reason: 'start-failed', detail: launch.detail };

  const deadline = Date.now() + START_TIMEOUT_BUDGET_MS;
  while (Date.now() < deadline) {
    const found = await findGateway(expectedPort);
    if (found.ok && (found.classification === 'up' || found.classification === 'up-auth')) {
      return { ok: true, port: found.port, startedByUs: true };
    }
    await sleep(START_POLL_INTERVAL_MS);
  }
  return { ok: false, reason: 'timeout', detail: 'gateway did not answer /v1/models within the startup budget' };
}

/**
 * Starts the CCR gateway if nothing is already answering for it. VERIFIED FOR
 * REAL: `ccr start` forks its own detached background process and returns
 * immediately after printing the service-started line, so `{detached:true}`
 * is not needed here. Never rejects/throws.
 * @param {{expectedPort?:number}} args
 * @returns {Promise<{ok:true, port:number, startedByUs:boolean}|{ok:false, reason:'busy'|'start-failed'|'timeout', detail?:string}>}
 */
function startGateway({ expectedPort } = {}) {
  if (startInFlight) return Promise.resolve({ ok: false, reason: 'busy' });
  startInFlight = true;
  return doStartGateway(expectedPort).finally(() => {
    startInFlight = false;
  });
}

/**
 * Stops the CCR service - only when the CALLER tracked that LunaCore itself
 * started it. Deliberately stateless here (no module-level "did we start it"
 * flag - that would not survive an app restart); main.js, a later task, owns
 * that state. Never rejects/throws.
 * @param {{startedByUs:boolean}} args
 * @returns {Promise<{ok:true, message:string}|{ok:false, reason:'not-ours'|'not-found'|'error', detail?:string}>}
 */
function stopGateway({ startedByUs } = {}) {
  return new Promise((resolve) => {
    if (!startedByUs) {
      resolve({ ok: false, reason: 'not-ours' });
      return;
    }
    execFile('ccr', ['stop'], { timeout: DETECT_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          reason: error.code === 'ENOENT' ? 'not-found' : 'error',
          detail: redactCcrOutput(stderr || stdout || error.message),
        });
        return;
      }
      resolve({ ok: true, message: redactCcrOutput(stdout) });
    });
  });
}

/**
 * Opens CCR's own browser-based management UI - the ONLY place CCR's
 * provider/model/routing config is ever edited (see this file's header).
 * VERIFIED FOR REAL: like `ccr start`, `ccr ui` forks its own detached
 * background service and returns immediately, so this never blocks. The
 * return value never carries a `url` field, by construction, so the
 * authenticated management URL (and its `ccr_web_token`) can never leak
 * downstream even by accident.
 * @returns {Promise<{ok:true}|{ok:false, reason:'not-found'|'launch-failed'}>}
 */
function openManagementUi() {
  return new Promise((resolve) => {
    execFile('ccr', ['ui'], { timeout: DETECT_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error) => {
      if (error) {
        resolve({ ok: false, reason: error.code === 'ENOENT' ? 'not-found' : 'launch-failed' });
        return;
      }
      resolve({ ok: true });
    });
  });
}

/**
 * Confirms a CCR client key actually authenticates against the gateway, via
 * `GET /v1/models` with `Authorization: Bearer <token>` (the OpenAI-compatible
 * convention CCR's own gateway route table accepts). `models:0` is a real,
 * distinct success case - gateway up, key valid, no provider configured in
 * CCR's own UI yet - never conflated with a failure. Never rejects/throws.
 * @param {number} port
 * @param {string} token
 * @returns {Promise<{ok:true, models:number}|{ok:false, reason:'unauthorized'|'no-models'|'down'}>}
 */
async function testClientKey(port, token) {
  const authToken = typeof token === 'string' ? token.trim() : '';
  if (!authToken) return { ok: false, reason: 'down' };

  const probe = await rawProbe(port, { Authorization: `Bearer ${authToken}` });
  if (!probe) return { ok: false, reason: 'down' };
  if (probe.status === 401 || probe.status === 403) return { ok: false, reason: 'unauthorized' };
  if (probe.status !== 200) return { ok: false, reason: 'down' };

  const list = modelListFrom(safeParseJson(probe.body));
  // A 200 with no recognizable model-list shape means something other than
  // CCR's gateway answered this port/path - distinct from the genuine
  // "authenticated, zero providers configured yet" success case, models:0.
  if (!list) return { ok: false, reason: 'no-models' };
  return { ok: true, models: list.length };
}

module.exports = {
  gatewayPortFromEnv,
  candidatePorts,
  classifyProbe,
  redactCcrOutput,
  describeState,
  detectCcr,
  probeGateway,
  findGateway,
  startGateway,
  stopGateway,
  openManagementUi,
  testClientKey,
};
