// ============================================================================
// LunaCore - Unity Pipeline HTTP client (the official Unity MCP, com.unity.pipeline)
// ----------------------------------------------------------------------------
// The official Unity MCP package serves an HTTP API from inside the open
// editor and announces it in <unityProjectDir>/Library/Pipeline/.unity-pipeline-port:
//
//   {pid, port, evalToken, lastHeartbeat, projectPath, endpoints}
//
// The file is deleted before every domain reload and written again after it,
// so it is re-read on EVERY request. lastHeartbeat (ISO UTC) is refreshed
// every 15 s; older than 60 s means the editor is gone.
//
//   POST http://127.0.0.1:<port>/api/exec   Authorization: Bearer <evalToken>
//        {command: '<group> <name>', parameters: {...}}
//     200 {success: true, result}
//     400 {success: false, error: 'Command Not Found', errorDetails}
//     503 {success: false, status: 'busy', busyReason, retryable: true}
//
// The host is always 127.0.0.1 (the server answers Host `localhost` with
// HTTP 400) and no Origin header is ever sent. The token never appears in an
// error or a log line: every message built after the descriptor is read is
// scrubbed of it, and parser messages (which quote their input) are dropped.
//
// Plain Node, no dependencies; fetch / readFile / now are injected by the tests.
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DESCRIPTOR_PARTS = Object.freeze(['Library', 'Pipeline', '.unity-pipeline-port']);
const HOST = '127.0.0.1';
const EXEC_PATH = '/api/exec';
const MIN_PORT = 1;
const MAX_PORT = 65535;
const HEARTBEAT_MAX_AGE_MS = 60 * 1000;
// A heartbeat further ahead than this is not a clock skew but a forged file.
const HEARTBEAT_MAX_SKEW_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const HTTP_BUSY = 503;
const MAX_ERROR_CHARS = 500;
const MAX_SNIPPET_CHARS = 120;
const MAX_DESCRIPTOR_CHARS = 64 * 1024;
const MAX_TOKEN_CHARS = 4096;
const MAX_COMMAND_CHARS = 200;
const MAX_BUSY_REASON_CHARS = 60;
// base64 or base64url: also guarantees the token is a legal header value, so
// fetch never fails on it with an error that would quote it.
const TOKEN_RE = /^[A-Za-z0-9+/_=-]+$/;
// '<group> <name>': words separated by single spaces, e.g. 'editor.playmode start'.
const COMMAND_RE = /^[A-Za-z][\w.-]*(?: [A-Za-z][\w.-]*)+$/;
const TOKEN_MASK = '[token]';

/** err.code of every failure this client throws. */
const PIPELINE_ERROR = Object.freeze({
  notOpen: 'UNITY_PIPELINE_NOT_OPEN',
  badDescriptor: 'UNITY_PIPELINE_BAD_DESCRIPTOR',
  stale: 'UNITY_PIPELINE_STALE',
  unreachable: 'UNITY_PIPELINE_UNREACHABLE',
  timeout: 'UNITY_PIPELINE_TIMEOUT',
  busy: 'UNITY_PIPELINE_BUSY',
  notJson: 'UNITY_PIPELINE_NOT_JSON',
  failed: 'UNITY_PIPELINE_FAILED',
});

// What a domain reload looks like from outside: the descriptor is missing or
// half written, the old port refuses or hangs, the editor is settling.
const TRANSIENT_CODES = new Set([
  PIPELINE_ERROR.notOpen,
  PIPELINE_ERROR.badDescriptor,
  PIPELINE_ERROR.stale,
  PIPELINE_ERROR.unreachable,
  PIPELINE_ERROR.timeout,
]);

// Failures where the command certainly never reached the editor.
const NOT_SENT_CODES = new Set([PIPELINE_ERROR.notOpen, PIPELINE_ERROR.badDescriptor, PIPELINE_ERROR.stale]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const readUtf8 = (file) => fs.promises.readFile(file, 'utf8');

/** The descriptor file of a Unity project. */
const descriptorFile = (projectDir) => path.join(projectDir, ...DESCRIPTOR_PARTS);

/**
 * True for a failure worth retrying while the editor reloads its domain:
 * busy with retryable:true, or a transport failure (descriptor, port, timeout).
 * A failed command (success:false) or a non-JSON reply is never transient.
 * @param {unknown} err
 */
function isTransientPipelineError(err) {
  return !!err && (err.retryable === true || TRANSIENT_CODES.has(err.code));
}

/**
 * True when the editor certainly did NOT run the command, so sending it again
 * is safe: nothing was sent (port file missing, broken or stale, port
 * refused) or the editor answered busy with retryable:true. A timeout or a
 * dropped connection is NOT one of these: the command may have run.
 * @param {unknown} err
 */
function pipelineCommandDidNotRun(err) {
  return !!err && (err.retryable === true || err.refused === true || NOT_SENT_CODES.has(err.code));
}

function pipelineError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/** `text` with every occurrence of the token masked. */
function scrub(text, token) {
  const s = String(text);
  return token ? s.split(token).join(TOKEN_MASK) : s;
}

/** A short one-line preview of a reply body, for the "not JSON" error. */
function snippet(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(empty)';
  return s.length > MAX_SNIPPET_CHARS ? `${s.slice(0, MAX_SNIPPET_CHARS)}...` : s;
}

/**
 * fetch's "fetch failed" plus what lies underneath: the socket error code
 * (ECONNREFUSED), else the cause's message ("unexpected redirect").
 */
function causeText(err) {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err && err.cause;
  const detail = cause && typeof cause.code === 'string' ? cause.code : cause instanceof Error ? cause.message : '';
  return detail ? `${base}: ${detail}` : base;
}

/**
 * error + errorDetails of a success:false reply, capped. `clean` runs before
 * the cap, so a cut can never leave half a token behind.
 */
function failureText(json, status, clean) {
  const error = typeof json.error === 'string' && json.error ? json.error : `HTTP ${status}`;
  const raw = json.errorDetails;
  const details = raw === undefined || raw === null || raw === '' ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
  return clean(details ? `${error} - ${details}` : error).slice(0, MAX_ERROR_CHARS);
}

/**
 * Validates a parsed descriptor.
 * @returns {{port:number, token:string}}
 */
function checkDescriptor(raw, projectDir, nowMs) {
  const bad = (what) => pipelineError(PIPELINE_ERROR.badDescriptor, `the Unity Pipeline port file in ${projectDir} ${what}`);
  if (!isObj(raw)) throw bad('is not a JSON object');
  if (!Number.isInteger(raw.port) || raw.port < MIN_PORT || raw.port > MAX_PORT) throw bad('has no valid port');
  const token = raw.evalToken;
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_CHARS || !TOKEN_RE.test(token)) {
    throw bad('has no valid evalToken');
  }
  const beat = typeof raw.lastHeartbeat === 'string' ? Date.parse(raw.lastHeartbeat) : NaN;
  if (!Number.isFinite(beat)) throw bad('has no valid lastHeartbeat');
  const ageMs = nowMs - beat;
  if (ageMs < -HEARTBEAT_MAX_SKEW_MS) throw bad('has a lastHeartbeat in the future');
  if (ageMs > HEARTBEAT_MAX_AGE_MS) {
    throw pipelineError(
      PIPELINE_ERROR.stale,
      `Unity editor on ${projectDir} stopped answering: its last heartbeat is ${Math.round(ageMs / 1000)} s old (limit ${HEARTBEAT_MAX_AGE_MS / 1000} s)`,
    );
  }
  return { port: raw.port, token };
}

/**
 * @param {{projectDir:string, fetch?:Function, readFile?:(file:string)=>Promise<string>|string,
 *   now?:()=>number, timeoutMs?:number}} opts projectDir = the Unity project (holds Library/)
 * @returns {{exec:(command:string, parameters?:object)=>Promise<unknown>, close:()=>Promise<void>}}
 */
function createPipelineClient({ projectDir, fetch: fetchFn = globalThis.fetch, readFile = readUtf8, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) throw new Error('the Unity project dir must be an absolute path');
  if (typeof fetchFn !== 'function') throw new Error('fetch is not available');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive whole number');
  const file = descriptorFile(projectDir);

  /** Read fresh on every request: a domain reload rewrites it. */
  async function readDescriptor() {
    let text;
    try {
      text = await readFile(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        throw pipelineError(PIPELINE_ERROR.notOpen, `Unity editor not open on ${projectDir}, or com.unity.pipeline not installed`);
      }
      const why = err && typeof err.code === 'string' ? err.code : 'read failed';
      throw pipelineError(PIPELINE_ERROR.badDescriptor, `could not read the Unity Pipeline port file in ${projectDir} (${why})`);
    }
    const body = String(text);
    if (body.length > MAX_DESCRIPTOR_CHARS) throw pipelineError(PIPELINE_ERROR.badDescriptor, `the Unity Pipeline port file in ${projectDir} is too large`);
    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      // Never the parser's message: it quotes the file, token included.
      throw pipelineError(PIPELINE_ERROR.badDescriptor, `the Unity Pipeline port file in ${projectDir} is not valid JSON`);
    }
    return checkDescriptor(raw, projectDir, now());
  }

  async function send({ port, token }, command, parameters, fail) {
    try {
      return await fetchFn(`http://${HOST}:${port}${EXEC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ command, parameters }),
        // A redirect would carry the bearer token somewhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw fail(PIPELINE_ERROR.timeout, `Unity did not answer '${command}' within ${timeoutMs} ms`);
      }
      // A refused connection never reached the editor; a dropped one may have.
      const refused = !!(err && err.cause && err.cause.code === 'ECONNREFUSED');
      throw fail(PIPELINE_ERROR.unreachable, `Unity editor on ${projectDir} is not reachable on port ${port} (${causeText(err)})`, refused ? { refused } : {});
    }
  }

  async function readReply(res, command, { fail, clean }) {
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw fail(PIPELINE_ERROR.unreachable, `Unity editor dropped the reply to '${command}' (${causeText(err)})`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!isObj(json)) {
      throw fail(PIPELINE_ERROR.notJson, `Unity Pipeline answered '${command}' with HTTP ${res.status} and a reply that is not a JSON object: ${snippet(clean(text))}`, { status: res.status });
    }
    if (res.status === HTTP_BUSY) {
      const reason = typeof json.busyReason === 'string' && json.busyReason ? clean(json.busyReason).slice(0, MAX_BUSY_REASON_CHARS) : 'busy';
      throw fail(PIPELINE_ERROR.busy, `Unity editor is busy (${reason}); '${command}' did not run`, {
        status: res.status,
        busyReason: reason,
        retryable: json.retryable === true,
      });
    }
    if (!res.ok || json.success !== true) {
      throw fail(PIPELINE_ERROR.failed, `Unity command '${command}' failed: ${failureText(json, res.status, clean)}`, { status: res.status });
    }
    return json.result === undefined ? null : json.result;
  }

  /**
   * Runs one Pipeline command and returns its `result`.
   * @throws {Error} with err.code from PIPELINE_ERROR; err.retryable on a retryable busy reply
   */
  async function exec(command, parameters = {}) {
    if (typeof command !== 'string' || command.length > MAX_COMMAND_CHARS || !COMMAND_RE.test(command)) {
      throw new Error(`bad Unity Pipeline command '${String(command).slice(0, MAX_COMMAND_CHARS)}'`);
    }
    if (!isObj(parameters)) throw new Error('Unity Pipeline parameters must be an object');
    const descriptor = await readDescriptor();
    const clean = (text) => scrub(text, descriptor.token);
    const fail = (code, message, extra) => pipelineError(code, clean(message), extra);
    const res = await send(descriptor, command, parameters, fail);
    return readReply(res, command, { fail, clean });
  }

  /** Stateless HTTP: nothing to end. Here so both Unity transports look alike. */
  async function close() {}

  return { exec, close };
}

module.exports = {
  DESCRIPTOR_PARTS,
  HEARTBEAT_MAX_AGE_MS,
  PIPELINE_ERROR,
  descriptorFile,
  isTransientPipelineError,
  pipelineCommandDidNotRun,
  createPipelineClient,
};
