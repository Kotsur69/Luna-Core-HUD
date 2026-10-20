// ============================================================================
// LunaCore - model fallback proxy (loopback) for free-model chains
// ----------------------------------------------------------------------------
// Sits between a tab's `claude` and a LOCAL Anthropic-compatible gateway
// (FreeLLMAPI on 127.0.0.1:31415). Every POST /v1/messages* is buffered and
// sent with `model` set to the chain's first ready model (src/freechains.js);
// a 429 / 5xx / 529 / "unknown model" answer - or a refused connection -
// cools that model down and the SAME request goes to the next one. Only a
// success or a non-retryable answer (bad gateway key, malformed request)
// reaches the client, so a free model running out mid-run never stops work
// and the tab's options never change.
//
// A retry is only possible before any byte reached the client: a stream that
// breaks half-way is passed through as broken (Claude Code retries the turn,
// and the next attempt starts on the next ready model).
//
// Boundaries: same as the LM Studio shim (src/lmstudioshim.js, whose helpers
// are reused): loopback bind, Host check, per-proxy random token on every
// request, LOCAL upstream only, capped buffered bodies, contents never logged.
// ============================================================================

'use strict';

const http = require('http');
const crypto = require('crypto');
const { localEndpointFromProfile } = require('./lmstudio');
const { SHIM_TOKEN_HEADER } = require('./sessionenv');
const {
  upstreamErrorBody,
  forwardHeaders,
  tokenMatches,
  isConnectivityProbe,
} = require('./lmstudioshim');
const chains = require('./freechains');

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Error bodies are read whole to classify them; real ones are tiny. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Response header naming the model that answered (visible in debug logs). */
const MODEL_HEADER = 'x-lunacore-model';

/** Paths whose JSON body names a model: rewritten and retried. */
function isModelRequest(method, url) {
  if (method !== 'POST') return false;
  const pathname = String(url || '').split('?')[0].replace(/\/+$/, '');
  return pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens';
}

/** The body with `model` swapped; null when it is not a JSON object. */
function withModel(buf, model) {
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return Buffer.from(JSON.stringify({ ...parsed, model }), 'utf8');
}

class FallbackProxy {
  /**
   * @param {{upstream:string, chain:{id:string, models:string[]}, port?:number,
   *          httpImpl?:Object, now?:() => number, maxBodyBytes?:number}} opts
   */
  constructor({ upstream, chain, port = 0, httpImpl = http, now = Date.now, maxBodyBytes = MAX_BODY_BYTES }) {
    const target = new URL(upstream);
    this.upstreamHost = target.hostname === '0.0.0.0' ? '127.0.0.1' : target.hostname.replace(/^\[|\]$/g, '');
    this.upstreamPort = Number(target.port) || 80;
    this.upstreamPrefix = target.pathname.replace(/\/+$/, '');
    this.chain = chain;
    this.requestedPort = port;
    this.httpImpl = httpImpl;
    this.now = now;
    this.maxBodyBytes = maxBodyBytes;
    this.cooldowns = new Map();
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.starting = null;
    this.token = crypto.randomBytes(32).toString('hex');
  }

  start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve) => {
      const server = this.httpImpl.createServer((req, res) => this.handle(req, res));
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
        resolve({ ok: true, port: this.port, url: this.url(), token: this.token });
      });
    });
    return this.starting;
  }

  async stop() {
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

  handle(req, res) {
    req.on('error', () => res.destroy());
    const host = req.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(upstreamErrorBody('Forbidden host'));
      req.resume();
      return;
    }
    if (!isConnectivityProbe(req.method, req.url) && !tokenMatches(req.headers[SHIM_TOKEN_HEADER], this.token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(upstreamErrorBody('Missing or invalid LunaCore proxy token', 'authentication_error'));
      req.resume();
      return;
    }
    if (!isModelRequest(req.method, req.url)) {
      this.passThrough(req, res);
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
      if (!rejected) this.withFallback(req, res, Buffer.concat(chunks));
    });
  }

  /** Request options for one upstream call. */
  options(req, extraHeaders) {
    return {
      host: this.upstreamHost,
      port: this.upstreamPort,
      method: req.method,
      path: `${this.upstreamPrefix}${req.url}`,
      headers: forwardHeaders(req.headers, { host: `${this.upstreamHost}:${this.upstreamPort}`, ...extraHeaders }),
      agent: false,
    };
  }

  passThrough(req, res) {
    const upReq = this.httpImpl.request(this.options(req, {}), (upRes) => {
      res.writeHead(upRes.statusCode || 502, forwardHeaders(upRes.headers, {}));
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    upReq.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(upstreamErrorBody('The model gateway is not reachable'));
    });
    res.on('close', () => {
      if (!res.writableFinished) upReq.destroy();
    });
    req.pipe(upReq);
  }

  /** Walks the chain until a model answers (or none is left). */
  async withFallback(req, res, original) {
    let closed = false;
    let current = null;
    res.on('close', () => {
      closed = true;
      if (current && !res.writableFinished) current.destroy();
    });
    const order = chains.attemptOrder(this.chain, this.cooldowns, this.now());
    let last = null;
    for (let i = 0; i < order.length && !closed; i += 1) {
      const model = order[i];
      const body = withModel(original, model);
      if (!body) {
        // Not a JSON object: nothing to rewrite, send it once as it came.
        last = await this.attempt(req, res, original, null, true, (r) => { current = r; });
        return;
      }
      const isLast = i === order.length - 1;
      last = await this.attempt(req, res, body, model, isLast, (r) => { current = r; });
      if (last.done) return;
      this.cooldowns = chains.withCooldown(this.cooldowns, model, last.kind, this.now(), last.retryMs);
    }
    if (!closed && !res.headersSent) {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(upstreamErrorBody(`Every model in the "${this.chain.id}" chain is limited or down (${last ? last.kind : 'none'})`, 'overloaded_error'));
    }
  }

  /**
   * One upstream call. Resolves {done:true} once the client got an answer,
   * or {done:false, kind, retryMs} when the next model should be tried.
   */
  attempt(req, res, body, model, isLast, track) {
    return new Promise((resolve) => {
      const upReq = this.httpImpl.request(this.options(req, { 'content-length': String(body.length) }), (upRes) => {
        const status = upRes.statusCode || 502;
        const headers = forwardHeaders(upRes.headers, model ? { [MODEL_HEADER]: model } : {});
        if (status < 400) {
          res.writeHead(status, headers);
          upRes.pipe(res);
          upRes.on('error', () => res.destroy());
          // 'close' too: a client that hangs up mid-stream never sees 'end'.
          upRes.on('end', () => resolve({ done: true }));
          upRes.on('close', () => resolve({ done: true }));
          return;
        }
        const chunks = [];
        let size = 0;
        upRes.on('data', (c) => {
          size += c.length;
          if (size <= MAX_ERROR_BODY_BYTES) chunks.push(c);
        });
        upRes.on('error', () => resolve({ done: false, kind: 'outage', retryMs: null }));
        upRes.on('end', () => {
          const text = Buffer.concat(chunks);
          const kind = chains.classifyFailure(status, text.toString('utf8'));
          if (kind !== 'fatal' && !isLast && model) {
            resolve({ done: false, kind, retryMs: chains.retryAfterMs(upRes.headers, this.now()) });
            return;
          }
          res.writeHead(status, { ...headers, 'content-length': String(text.length) });
          res.end(text);
          resolve({ done: true });
        });
      });
      track(upReq);
      upReq.on('error', (err) => {
        if (res.headersSent) {
          res.destroy();
          resolve({ done: true });
          return;
        }
        if (!isLast && model) {
          resolve({ done: false, kind: 'outage', retryMs: null });
          return;
        }
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(upstreamErrorBody(`The model gateway is not reachable (${(err && err.code) || 'error'})`));
        resolve({ done: true });
      });
      upReq.end(body);
    });
  }
}

// --- registry: one proxy per (gateway, chain) ---------------------------------

const proxies = new Map();

/**
 * Starts (or reuses) the proxy for a local gateway + chain.
 * @param {string} upstream e.g. http://127.0.0.1:31415
 * @param {{id:string, models:string[]}} chain
 */
async function ensureFallbackProxy(upstream, chain) {
  const origin = localEndpointFromProfile({ env: { ANTHROPIC_BASE_URL: upstream } });
  if (!origin) return { ok: false, reason: 'not-local' };
  if (!chain || !Array.isArray(chain.models) || chain.models.length === 0) return { ok: false, reason: 'no-chain' };
  const key = `${origin}|${chain.id}|${chain.models.join(',')}`;
  const existing = proxies.get(key);
  if (existing) return existing.start();
  const proxy = new FallbackProxy({ upstream: origin, chain });
  proxies.set(key, proxy);
  const result = await proxy.start();
  if (!result.ok) proxies.delete(key);
  return result;
}

async function stopAllFallbackProxies() {
  const all = [...proxies.values()];
  proxies.clear();
  await Promise.all(all.map((p) => p.stop()));
}

module.exports = {
  isModelRequest,
  withModel,
  FallbackProxy,
  ensureFallbackProxy,
  stopAllFallbackProxies,
  MODEL_HEADER,
};
