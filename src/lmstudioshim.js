// ============================================================================
// LunaCore - LM Studio request shim (loopback proxy)
// ----------------------------------------------------------------------------
// Claude Code sends SessionStart hook output as a MID-CONVERSATION message with
// role "system". Anthropic's API accepts that; LM Studio's Anthropic-compatible
// /v1/messages does not ("request.messages.1.role: Invalid discriminator
// value") and answers 400 - so every LM Studio tab died on its first turn. No
// CLI env var turns the behaviour off (verified live 2026-09-24).
//
// The fix, proven live before it was written here: a tiny proxy between the
// CLI and LM Studio that rewrites each role:"system" message into a user
// message whose text blocks are wrapped in <system-reminder> tags (the same
// wrapper Claude Code itself uses for reminders), then merges consecutive
// same-role messages because the endpoint requires strict alternation.
// Everything else - other paths, headers, streamed SSE responses - passes
// through untouched.
//
// Boundaries: binds 127.0.0.1 only, rejects foreign Host headers (DNS
// rebinding), only ever forwards to a LOCAL upstream, caps buffered bodies,
// and never logs request or response contents.
// ============================================================================

'use strict';

const http = require('http');
const { localEndpointFromProfile } = require('./lmstudio');

/** Upper bound for one buffered /v1/messages body (images make them big). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
// Only the buffered rewrite path needs the cap; streamed pass-through
// requests are unbounded by design since they are never held in memory.

/** Max time for a client to finish sending one request (not the response). */
const REQUEST_TIMEOUT_MS = 60 * 1000;

/** Headers that describe one hop, never the message - dropped both ways. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// --- pure rewrite -----------------------------------------------------------

/** Message content as an array of blocks (the API allows a bare string). */
function toBlocks(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function wrapSystemBlocks(blocks) {
  return blocks.map((b) => (b && b.type === 'text'
    ? { ...b, text: `<system-reminder>\n${b.text}\n</system-reminder>` }
    : b));
}

/**
 * tool_result blocks must lead the user message that answers a tool_use.
 * A merge can put a reminder in front of them, so move them back - stable,
 * so every other block keeps its order.
 */
function toolResultsFirst(blocks) {
  const results = blocks.filter((b) => b && b.type === 'tool_result');
  if (results.length === 0) return blocks;
  return [...results, ...blocks.filter((b) => !(b && b.type === 'tool_result'))];
}

/**
 * Rewrites role:"system" messages into wrapped user messages and merges
 * consecutive same-role messages. Never mutates its input.
 * @param {Array} messages
 * @returns {Array}
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  return messages.reduce((out, m) => {
    const isSystem = m && m.role === 'system';
    const role = isSystem ? 'user' : m && m.role;
    const blocks = Array.isArray(toBlocks(m && m.content)) ? toBlocks(m.content) : [];
    const content = isSystem ? wrapSystemBlocks(blocks) : [...blocks];
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      const merged = { ...prev, content: toolResultsFirst([...prev.content, ...content]) };
      return [...out.slice(0, -1), merged];
    }
    return [...out, { ...m, role, content }];
  }, []);
}

/**
 * Rewrites one request body. Anything that does not need rewriting comes back
 * as the ORIGINAL buffer, byte for byte - no needless re-serialization.
 * @param {Buffer} buf
 * @returns {{changed:boolean, body:Buffer}}
 */
function rewriteBody(buf) {
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return { changed: false, body: buf };
  }
  const messages = parsed && Array.isArray(parsed.messages) ? parsed.messages : null;
  if (!messages || !messages.some((m) => m && m.role === 'system')) {
    return { changed: false, body: buf };
  }
  const next = { ...parsed, messages: normalizeMessages(messages) };
  return { changed: true, body: Buffer.from(JSON.stringify(next), 'utf8') };
}

/** Only uncompressed POSTs to /v1/messages are buffered and rewritten. */
function shouldRewrite(method, url, headers) {
  if (method !== 'POST') return false;
  const pathname = String(url || '').split('?')[0].replace(/\/+$/, '');
  if (pathname !== '/v1/messages') return false;
  return !(headers && headers['content-encoding']);
}

/** An error body Claude Code can render (Anthropic error shape). */
function upstreamErrorBody(message) {
  return JSON.stringify({ type: 'error', error: { type: 'api_error', message } });
}

function forwardHeaders(headers, extra) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return { ...out, ...extra };
}

// --- proxy -------------------------------------------------------------------

class LmStudioShim {
  /**
   * @param {{upstream:string, port?:number, maxBodyBytes?:number, httpImpl?:Object}} opts
   */
  constructor({ upstream, port = 0, maxBodyBytes = MAX_BODY_BYTES, httpImpl = http }) {
    const target = new URL(upstream);
    // 0.0.0.0 is a listen address, not a connect address (fails on Windows).
    this.upstreamHost = target.hostname === '0.0.0.0' ? '127.0.0.1' : target.hostname.replace(/^\[|\]$/g, '');
    this.upstreamPort = Number(target.port) || 80;
    this.upstreamPrefix = target.pathname.replace(/\/+$/, '');
    this.requestedPort = port;
    this.maxBodyBytes = maxBodyBytes;
    this.httpImpl = httpImpl;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.starting = null;
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      const server = this.httpImpl.createServer((req, res) => this.handle(req, res));
      // Bounds how long a client may take to SEND its request; responses
      // (a local first token can take minutes) are deliberately not timed.
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });
      server.once('error', (err) => {
        this.starting = null;
        resolve({ ok: false, reason: err && err.code === 'EADDRINUSE' ? 'port-in-use' : 'error' });
      });
      server.listen(this.requestedPort, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve({ ok: true, port: this.port, url: this.url() });
      });
    });
    return this.starting;
  }

  async stop() {
    // A start() still binding would otherwise finish AFTER this stop and
    // leave an untracked listener behind - wait for it, then close it.
    const pending = this.starting;
    this.starting = null;
    if (pending) await pending;
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  url() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  isAllowedHost(host) {
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  handle(req, res) {
    req.on('error', () => res.destroy());
    if (!this.isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(upstreamErrorBody('Forbidden host'));
      req.resume();
      return;
    }
    if (!shouldRewrite(req.method, req.url, req.headers)) {
      this.forward(req, res, null);
      return;
    }
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        rejected = true;
        chunks.length = 0;
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(upstreamErrorBody('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      this.forward(req, res, rewriteBody(Buffer.concat(chunks)).body);
    });
  }

  /** Sends one request upstream; body null means stream `req` through as-is. */
  forward(req, res, body) {
    const extra = { host: `${this.upstreamHost}:${this.upstreamPort}` };
    if (body) extra['content-length'] = String(body.length);
    const upReq = this.httpImpl.request({
      host: this.upstreamHost,
      port: this.upstreamPort,
      method: req.method,
      path: `${this.upstreamPrefix}${req.url}`,
      headers: forwardHeaders(req.headers, extra),
      // One connection per request: nothing lingers after stop() or quit.
      agent: false,
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, forwardHeaders(upRes.headers, {}));
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    upReq.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(upstreamErrorBody(`LM Studio is not reachable (${(err && err.code) || 'error'})`));
    });
    // Esc in the CLI closes the client socket; stop LM Studio generating too.
    res.on('close', () => {
      if (!res.writableFinished) upReq.destroy();
    });
    if (body) upReq.end(body);
    else req.pipe(upReq);
  }
}

// --- registry: one shim per local upstream ----------------------------------

const shims = new Map();

/**
 * Starts (or reuses) the shim in front of a local upstream.
 * @param {string} upstream e.g. http://localhost:1234
 * @returns {Promise<{ok:true, port:number, url:string}|{ok:false, reason:string}>}
 */
async function ensureShim(upstream) {
  const origin = localEndpointFromProfile({ env: { ANTHROPIC_BASE_URL: upstream } });
  if (!origin) return { ok: false, reason: 'not-local' };
  const existing = shims.get(origin);
  if (existing) return existing.start();
  const shim = new LmStudioShim({ upstream: origin });
  shims.set(origin, shim);
  const result = await shim.start();
  if (!result.ok) shims.delete(origin);
  return result;
}

/** Stops every shim; safe to call more than once (app quit). */
async function stopAllShims() {
  const all = [...shims.values()];
  shims.clear();
  await Promise.all(all.map((s) => s.stop()));
}

module.exports = {
  toBlocks,
  normalizeMessages,
  rewriteBody,
  shouldRewrite,
  upstreamErrorBody,
  LmStudioShim,
  ensureShim,
  stopAllShims,
  MAX_BODY_BYTES,
};
