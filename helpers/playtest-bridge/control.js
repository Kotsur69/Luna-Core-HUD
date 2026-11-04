// ============================================================================
// LunaCore - Playtester bridge: the control channel into the app under test
// ----------------------------------------------------------------------------
// The in-process Electron wrapper (electron-wrapper.js) answers on a loopback
// HTTP port; the bridge (the Playtester's tools) and the electron adapter
// (stop: final screenshots, quit) call it. No CDP / remote-debugging port.
//
//   POST /call  {tool, args}  ->  {ok:true, result} | {ok:false, error}
//
// Guard: 127.0.0.1 only, and every request carries the per-run random token
// in a custom header. A web page cannot send that header cross-origin without
// a CORS preflight, which this server never answers - so neither a browser
// tab nor another user's process can drive the app. Bodies are capped.
// ============================================================================

'use strict';

const http = require('http');
const crypto = require('crypto');

const TOKEN_HEADER = 'x-luna-playtest-token';
// The adapter hands the token to the wrapper in this env var; the wrapper
// answers with one stdout line `${READY_PREFIX}{"port":N,"windows":N}`.
const TOKEN_ENV = 'LUNA_PLAYTEST_TOKEN';
const READY_PREFIX = '[luna-playtest] ready ';
const CALL_PATH = '/call';
const MAX_BODY_BYTES = 64 * 1024;
// Replies carry base64 screenshots: a 4K window is a few MB.
const MAX_REPLY_BYTES = 40 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const TOKEN_RE = /^[a-f0-9]{32,128}$/;

const errText = (err) => (err instanceof Error ? err.message : String(err));

/** A fresh per-run token: 32 random bytes as hex. */
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time compare; false for anything that is not a well-formed token. */
function tokenMatches(given, token) {
  if (typeof given !== 'string' || typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @param {{token:string, handle:(tool:string, args:object)=>Promise<unknown>|unknown}} opts
 * @returns {import('http').Server} not listening yet - call listen(0, '127.0.0.1')
 */
function createControlServer({ token, handle }) {
  if (!TOKEN_RE.test(String(token))) throw new Error('control server needs a hex token');
  return http.createServer((req, res) => {
    const reply = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== CALL_PATH) {
      reply(404, { ok: false, error: 'not found' });
      req.resume();
      return;
    }
    if (!tokenMatches(req.headers[TOKEN_HEADER], token)) {
      reply(401, { ok: false, error: 'unauthorized' });
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413, { ok: false, error: 'request too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reply(400, { ok: false, error: 'bad json' });
        return;
      }
      if (!msg || typeof msg.tool !== 'string') {
        reply(400, { ok: false, error: 'tool missing' });
        return;
      }
      const args = msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {};
      Promise.resolve()
        .then(() => handle(msg.tool, args))
        .then(
          (result) => reply(200, { ok: true, result: result === undefined ? null : result }),
          (err) => reply(200, { ok: false, error: errText(err).slice(0, 500) }),
        );
    });
  });
}

/**
 * One call into the app. Rejects with the app's error message, a transport
 * error, or a timeout.
 * @param {{port:number, token:string}} control
 * @param {string} tool
 * @param {object} [args]
 * @param {{timeoutMs?:number, request?:Function}} [opts]
 * @returns {Promise<unknown>} the handler's result
 */
function callControl(control, tool, args = {}, opts = {}) {
  const request = opts.request || http.request;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (!control || !Number.isInteger(control.port) || control.port < 1 || control.port > 65535) {
      reject(new Error('the app is not reachable (no control port)'));
      return;
    }
    const body = JSON.stringify({ tool, args });
    const req = request(
      {
        host: '127.0.0.1',
        port: control.port,
        method: 'POST',
        path: CALL_PATH,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [TOKEN_HEADER]: control.token },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_REPLY_BYTES) {
            req.destroy(new Error('reply too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let msg;
          try {
            msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new Error(`bad reply (HTTP ${res.statusCode})`));
            return;
          }
          if (msg && msg.ok === true) resolve(msg.result);
          else reject(new Error((msg && msg.error) || `HTTP ${res.statusCode}`));
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from the app within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = {
  TOKEN_HEADER,
  TOKEN_ENV,
  READY_PREFIX,
  MAX_BODY_BYTES,
  newToken,
  tokenMatches,
  createControlServer,
  callControl,
};
