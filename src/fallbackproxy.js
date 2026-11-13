// ============================================================================
// LunaCore - model fallback proxy (loopback) for free-model chains
// ----------------------------------------------------------------------------
// Sits between a tab's `claude` and a LOCAL Anthropic-compatible gateway
// (FreeLLMAPI on 127.0.0.1:31415). Every POST /v1/messages* is buffered and
// sent with `model` set to the chain's first ready model (src/freechains.js);
// a limit / 5xx / 529 / "unknown model" answer - or a refused connection -
// cools that model down and the SAME request goes to the next one. Only a
// success or a non-retryable answer (bad gateway key, malformed request)
// reaches the client, so a free model running out mid-run never stops work
// and the tab's options never change.
//
// Free God Mode v2:
//   - F2a  every ready model failed on a limit -> HTTP 429 "Free coding
//          models: usage limit reached · resets <time>" (src/freeLimit.js),
//          which the CLI writes into the transcript and God Mode reads as
//          the usage-limit wall: the run pauses and resumes on its own. Until
//          then nothing is sent; afterwards ONE request re-probes the models
//          that are back (in chain order) while the others wait for it.
//   - F2b  every request waits for the gateway's 120-per-minute window
//          (src/freePacer.js, one per gateway). A key-level 429 (not "All
//          models ...") is a short wait + retry of the same model here, not a
//          run pause.
//   - F3   a chain with an `expect` list refuses an answer whose
//          X-Routed-Via names another model (`substituted`), decided on the
//          headers before any body byte reaches the client. Requests for an
//          `auto:*` model (plan runs) skip the guard.
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
const { RequestPacer } = require('./freePacer');
const { exhaustedResetAt, usageLimitAnswer } = require('./freeLimit');

const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Error bodies are read whole to classify them; real ones are tiny. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Response header naming the model that really answered (debug logs, run log). */
const MODEL_HEADER = 'x-lunacore-model';
/** The gateway's "<platform>/<model>" that served an answer. */
const ROUTED_HEADER = 'x-routed-via';
/** Key-level 429 with no Retry-After: wait this long before the same request again. */
const DEFAULT_THROTTLE_MS = 5 * 1000;
/** A key-level wait is one gateway window at most. */
const MAX_THROTTLE_WAIT_MS = 65 * 1000;
/** Same-model retries after a key-level 429 before the chain counts as limited. */
const MAX_THROTTLE_RETRIES = 3;
/** Failures that end in the usage-limit answer when no model is left. */
const LIMIT_KINDS = new Set(['limit', 'substituted', 'throttled']);

/** Paths whose JSON body names a model: rewritten and retried. */
function isModelRequest(method, url) {
  if (method !== 'POST') return false;
  const pathname = String(url || '').split('?')[0].replace(/\/+$/, '');
  return pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens';
}

/** The JSON object of a request body, or null. */
function parseBody(buf) {
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The body with `model` swapped; null when it is not a JSON object. */
function withModel(buf, model) {
  const parsed = parseBody(buf);
  return parsed ? Buffer.from(JSON.stringify({ ...parsed, model }), 'utf8') : null;
}

/** Plan runs (Free God Mode v2) ask for the gateway's `auto:*` routing: any member is fine. */
function isAutoModel(model) {
  return /^auto:/i.test(String(model || ''));
}

/** One header value as trimmed text ('' when absent). */
function headerText(value) {
  return String(Array.isArray(value) ? value[0] : (value ?? '')).trim();
}

// --- route events (run log) ---------------------------------------------------

const routeListeners = new Set();

/**
 * Subscribes to "which model really answered" events:
 * {chainId, model, routedVia, substituted, at}. Returns the unsubscribe.
 * @param {(info:object) => void} listener
 */
function onRoute(listener) {
  routeListeners.add(listener);
  return () => routeListeners.delete(listener);
}

function emitRoute(info) {
  for (const listener of routeListeners) {
    try {
      listener(info);
    } catch {
      /* a listener's failure never breaks the request */
    }
  }
}

class FallbackProxy {
  /**
   * @param {{upstream:string, chain:{id:string, models:string[], expect?:string[]}, port?:number,
   *          httpImpl?:Object, now?:() => number, maxBodyBytes?:number, pacer?:RequestPacer,
   *          warn?:(msg:string) => void}} opts
   */
  constructor({
    upstream, chain, port = 0, httpImpl = http, now = Date.now, maxBodyBytes = MAX_BODY_BYTES,
    pacer = null, warn = (msg) => console.warn(msg),
  }) {
    const target = new URL(upstream);
    this.upstreamHost = target.hostname === '0.0.0.0' ? '127.0.0.1' : target.hostname.replace(/^\[|\]$/g, '');
    this.upstreamPort = Number(target.port) || 80;
    this.upstreamPrefix = target.pathname.replace(/\/+$/, '');
    this.chain = chain;
    this.requestedPort = port;
    this.httpImpl = httpImpl;
    this.now = now;
    this.maxBodyBytes = maxBodyBytes;
    this.pacer = pacer || new RequestPacer({ now });
    this.warn = warn;
    this.warnedMissing = new Set();
    this.cooldowns = new Map();
    // model -> failure kind of its current cooldown (limit vs outage, answerExhausted).
    this.cooldownKinds = new Map();
    // The single re-probe in flight after a usage-limit answer (others wait for it).
    this.probing = null;
    // Set by the usage-limit answer: the next walk re-probes one model only.
    this.exhausted = false;
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
    this.pacer.note();
    const upReq = this.httpImpl.request(this.options(req, {}), (upRes) => {
      this.pacer.observe(upRes.headers);
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

  /** The substitution guard's expect list for this request, or null (guard off). */
  guardFor(requestedModel) {
    const expect = this.chain && this.chain.expect;
    if (!Array.isArray(expect) || expect.length === 0 || isAutoModel(requestedModel)) return null;
    return expect;
  }

  /** Never rejects: an unexpected error ends the client's request instead of hanging it. */
  async withFallback(req, res, original) {
    try {
      await this.walk(req, res, original);
    } catch (err) {
      this.warn(`[fallbackproxy] chain "${this.chain.id}": request failed (${(err && err.message) || err})`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(upstreamErrorBody('LunaCore fallback proxy error'));
      } else {
        res.destroy();
      }
    }
  }

  /** Walks the ready models of the chain until one answers (or none is left). */
  async walk(req, res, original) {
    let closed = false;
    let current = null;
    const track = (r) => { current = r; };
    const isClosed = () => closed;
    res.on('close', () => {
      closed = true;
      if (current && !res.writableFinished) current.destroy();
    });
    const parsed = parseBody(original);
    if (!parsed) {
      // Not a JSON object: nothing to rewrite, send it once as it came.
      if (await this.pacer.acquire(isClosed)) await this.attempt(req, res, original, null, { guard: null, final: true }, track);
      return;
    }
    // A re-probe in flight: wait for its verdict instead of probing too.
    while (this.probing) await this.probing;
    if (closed) return;
    const guard = this.guardFor(parsed.model);
    const ready = chains.readyModels(this.chain, this.cooldowns, this.now());
    // After a usage-limit answer ONE request re-probes the models whose
    // cooldown ran out (every other request waits for its verdict): it opens
    // the chain again or the limit answer comes back. Stopping at the first
    // failed model would report the next model's reset as the chain's while a
    // model is already back, and the run would pause again for nothing.
    const probe = this.exhausted && ready.length > 0;
    let endProbe = () => {};
    if (probe) this.probing = new Promise((resolve) => { endProbe = resolve; });
    try {
      const failures = [];
      for (const model of ready) {
        const result = await this.tryModel(req, res, withModel(original, model), model, guard, track, isClosed);
        if (result.done) {
          if (result.ok) this.exhausted = false;
          return;
        }
        // A client that hung up says nothing about the model.
        if (closed) return;
        failures.push(result);
        // The gateway's own request window: every other model would get the same answer.
        if (result.kind === 'throttled') break;
        const retryMs = result.retryAfterMs ?? result.hintMs ?? null;
        this.cooldowns = chains.withCooldown(this.cooldowns, model, result.kind, this.now(), retryMs);
        this.cooldownKinds = new Map(this.cooldownKinds).set(model, result.kind);
      }
      if (!closed && !res.headersSent) this.answerExhausted(res, failures);
    } finally {
      if (probe) {
        this.probing = null;
        endProbe();
      }
    }
  }

  /**
   * One model, with the short same-model retries of a key-level 429.
   * Resolves like attempt(), plus `model`. A key-level wait longer than one
   * window is a model limit after all (e.g. a provider's daily quota).
   */
  async tryModel(req, res, body, model, guard, track, isClosed) {
    for (let i = 0; ; i += 1) {
      if (!(await this.pacer.acquire(isClosed))) return { done: true, ok: false, model };
      const result = await this.attempt(req, res, body, model, { guard, final: false }, track);
      if (result.done || result.kind !== 'throttled') return { ...result, model };
      if (result.retryAfterMs !== null && result.retryAfterMs > MAX_THROTTLE_WAIT_MS) return { ...result, kind: 'limit', model };
      const wait = result.retryAfterMs ?? DEFAULT_THROTTLE_MS;
      this.pacer.block(wait);
      if (i >= MAX_THROTTLE_RETRIES) return { ...result, model, retryAfterMs: wait };
    }
  }

  /** True when a model of the chain is cooling because of a limit (not an outage). */
  coolingOnLimit() {
    const now = this.now();
    return this.chain.models.some((m) => (this.cooldowns.get(m) || 0) > now && LIMIT_KINDS.has(this.cooldownKinds.get(m)));
  }

  /**
   * No model answered. Limits (incl. substitutions and the key window) ->
   * the usage-limit 429 that pauses a God Mode run; outages only -> the last
   * upstream answer as it came (or 502 when the gateway never answered). With
   * nothing tried at all (every model cooling), only a limit cooldown makes it
   * a usage limit - a chain resting after outages answers 529, which the CLI
   * retries by itself.
   */
  answerExhausted(res, failures) {
    const limited = failures.length === 0 ? this.coolingOnLimit() : failures.some((f) => LIMIT_KINDS.has(f.kind));
    if (limited) {
      const now = this.now();
      const resetAt = exhaustedResetAt({ failures, chain: this.chain, cooldowns: this.cooldowns, now });
      const answer = usageLimitAnswer(this.chain, resetAt, now);
      this.exhausted = true;
      res.writeHead(answer.status, answer.headers);
      res.end(answer.body);
      return;
    }
    if (failures.length === 0) {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(upstreamErrorBody(`Every model in the "${this.chain.id}" chain is down - retry shortly`, 'overloaded_error'));
      return;
    }
    const last = failures[failures.length - 1];
    if (last.status) {
      const text = last.text || Buffer.alloc(0);
      res.writeHead(last.status, { ...forwardHeaders(last.headers, { [MODEL_HEADER]: last.model }), 'content-length': String(text.length) });
      res.end(text);
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(upstreamErrorBody(`The model gateway is not reachable (${last.netError || 'error'})`));
  }

  /**
   * The guard's verdict on a successful answer: 'ok', or 'substituted' when
   * X-Routed-Via names a model outside the expect list. A missing header is
   * accepted (with one warning per model).
   */
  routeVerdict(model, routedVia, guard) {
    if (!guard) return 'ok';
    if (!routedVia) {
      if (!this.warnedMissing.has(model)) {
        this.warnedMissing.add(model);
        this.warn(`[fallbackproxy] chain "${this.chain.id}": no ${ROUTED_HEADER} header on the answer for ${model} - accepted unchecked`);
      }
      return 'ok';
    }
    return chains.routedMatches(routedVia, guard) ? 'ok' : 'substituted';
  }

  /**
   * One upstream call. Resolves {done:true, ok} once the client got an
   * answer, or {done:false, kind, ...} when the next model should be tried.
   * `final` writes a failure to the client instead (no model to fall back to).
   * Settles once: a late socket error of an abandoned call never touches the
   * client's response, which by then may belong to the next model.
   */
  attempt(req, res, body, model, { guard, final }, track) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return false;
        settled = true;
        resolve(value);
        return true;
      };
      const upReq = this.httpImpl.request(this.options(req, { 'content-length': String(body.length) }), (upRes) => {
        const status = upRes.statusCode || 502;
        this.pacer.observe(upRes.headers);
        const routedVia = headerText(upRes.headers[ROUTED_HEADER]);
        if (status < 400) {
          // Decided on the headers alone: a substituted answer is aborted,
          // never a byte of it reaches the client.
          const substituted = this.routeVerdict(model, routedVia, guard) === 'substituted';
          if (model) emitRoute({ chainId: this.chain.id, model, routedVia: routedVia || null, substituted, at: this.now() });
          if (substituted) {
            settle({ done: false, kind: 'substituted', routedVia });
            upReq.destroy();
            return;
          }
          const real = routedVia || model;
          res.writeHead(status, forwardHeaders(upRes.headers, real ? { [MODEL_HEADER]: real } : {}));
          upRes.pipe(res);
          upRes.on('error', () => res.destroy());
          upRes.on('end', () => settle({ done: true, ok: true }));
          // A stream cut before its end (or a client that hung up) is not a success.
          upRes.on('close', () => settle({ done: true, ok: false }));
          return;
        }
        const chunks = [];
        let size = 0;
        upRes.on('data', (c) => {
          size += c.length;
          if (size <= MAX_ERROR_BODY_BYTES) chunks.push(c);
        });
        const broken = () => settle({ done: false, kind: 'outage', retryAfterMs: null, hintMs: null });
        upRes.on('error', broken);
        upRes.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks);
          const utf8 = text.toString('utf8');
          const kind = chains.classifyFailure(status, utf8);
          if (kind === 'fatal' || final || !model) {
            const headers = forwardHeaders(upRes.headers, model ? { [MODEL_HEADER]: model } : {});
            res.writeHead(status, { ...headers, 'content-length': String(text.length) });
            res.end(text);
            settle({ done: true, ok: false });
            return;
          }
          settle({
            done: false,
            kind,
            status,
            headers: upRes.headers,
            text,
            retryAfterMs: chains.retryAfterMs(upRes.headers, this.now()),
            hintMs: chains.resetHintMs(utf8),
          });
        });
        // An error body cut off without 'end' / 'error'.
        upRes.on('close', broken);
      });
      track(upReq);
      upReq.on('error', (err) => {
        if (settled) return;
        if (res.headersSent) {
          res.destroy();
          settle({ done: true, ok: false });
          return;
        }
        if (!final && model) {
          settle({ done: false, kind: 'outage', netError: (err && err.code) || 'error', retryAfterMs: null, hintMs: null });
          return;
        }
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(upstreamErrorBody(`The model gateway is not reachable (${(err && err.code) || 'error'})`));
        settle({ done: true, ok: false });
      });
      upReq.end(body);
    });
  }
}

// --- registry: one proxy per (gateway, chain), one pacer per gateway ------------

const proxies = new Map();
const pacers = new Map();

/** The shared request pacer of one gateway origin (all its chains, all workers). */
function pacerFor(origin) {
  if (!pacers.has(origin)) pacers.set(origin, new RequestPacer());
  return pacers.get(origin);
}

/**
 * Starts (or reuses) the proxy for a local gateway + chain.
 * @param {string} upstream e.g. http://127.0.0.1:31415
 * @param {{id:string, models:string[], expect?:string[]}} chain
 */
async function ensureFallbackProxy(upstream, chain) {
  const origin = localEndpointFromProfile({ env: { ANTHROPIC_BASE_URL: upstream } });
  if (!origin) return { ok: false, reason: 'not-local' };
  if (!chain || !Array.isArray(chain.models) || chain.models.length === 0) return { ok: false, reason: 'no-chain' };
  const key = `${origin}|${chain.id}|${chain.models.join(',')}|${(chain.expect || []).join(',')}`;
  const existing = proxies.get(key);
  if (existing) return existing.start();
  const proxy = new FallbackProxy({ upstream: origin, chain, pacer: pacerFor(origin) });
  proxies.set(key, proxy);
  const result = await proxy.start();
  if (!result.ok) proxies.delete(key);
  return result;
}

async function stopAllFallbackProxies() {
  const all = [...proxies.values()];
  proxies.clear();
  pacers.clear();
  await Promise.all(all.map((p) => p.stop()));
}

module.exports = {
  isModelRequest,
  withModel,
  isAutoModel,
  FallbackProxy,
  ensureFallbackProxy,
  stopAllFallbackProxies,
  onRoute,
  MODEL_HEADER,
  ROUTED_HEADER,
  MAX_THROTTLE_RETRIES,
};
